/**
 * 绘灵 · 主管线
 *
 * 一次完整任务的阶段（每阶段都往诊断面板写日志，坏在哪一步一眼看得出来）：
 *
 *   ① 轮次推进 + 唤醒休眠角色
 *   ② 抓档案库快照
 *   ③ 收集历史楼层
 *   ④ 拼装提示词 → 调用模型
 *   ⑤ 解析输出 → 应用变化（含锁定保护、状态位校验）
 *   ⑥ 位置校验 → 逐图一致性处理（@展开 / 锚点自愈 / 画面体检）
 *   ⑦ 写回正文
 *   ⑧ 提交生图后端
 *
 * 设计取舍：不静默截断上下文（既定原则）。超了就让模型自己报错，
 * 用户能看见原因，而不是被偷偷裁掉角色档案后拿到一张漂移的图。
 */

import { getConfig, activeOutput } from './settings.js';
import {
  getMessageText, getChat, getCharName, getUserName,
  getPersonaDescription, getCharDescription, getCharWorldBookText,
} from './st.js';
import {
  cleanBody, cleanBodyLines, hash32, errorBrief, bodyFingerprint, tidySeparators,
  normalizeAnchorFields, hasOutfitSwapSignal, hasOutfitNovelSignal, hasOutfitRedressSignal, hasOutfitStateSignal,
  hasSceneBreakSignal, outfitCluesFrom,
} from './util.js';
import { logRequest } from './log.js';
import { beginTask, step, failTask, endTask, info, warn, diagnose, STAGE } from './log.js';
import { buildAnalyzeMessages, buildProfileScanMessages, buildUserProfileScanMessages, buildOutfitScanMessages } from './prompts.js';
import { callAnalyzeLLM } from './api.js';
import { getChatId } from './st.js';
/** st.js 已在上方整体导入，这里只是给历史记录一个明确别名，防改名踩空。 */
const getChatIdSafe = getChatId;
import { parseAnalyzeOutput, validateImages, validPositionsFrom, extractJsonText } from './protocol.js';
import { applyChanges, processImage, composePrompt, summarize } from './consistency.js';
import {
  buildLibrarySnapshot, getRound, setRound, markPresent, wakeByText,
  upsertEntry, saveFloorResult, pushHistory, addPendingProfiles,
  applyOutfitScan, resolveOutfitStyle, rollbackOutfitsBefore,
} from './store.js';
import { writeImagesToFloor, render as renderFloor } from './render.js';
import { archiveImages } from './archive.js';
/** v0.9.137：剧情演完模式要放行更高的单楼张数上限（见 validateImages 调用处）。 */
import { normalizeMossCover } from './mossLayout.js';
import { notifyInfo, notifySuccess, notifyError, failureText } from './notify.js';
import {
  activeBackendKey, backendMeta, backendReadiness, submit as submitToBackend,
} from './backends/index.js';

/* ============ 上下文收集 ============ */

function collectHistory(mesId, count) {
  const cfg = getConfig();
  if (!count || count <= 0) return [];
  const chat = getChat();
  const out = [];
  let aiCount = 0;

  for (let i = mesId - 1; i >= 0 && aiCount < count; i -= 1) {
    const m = chat[i];
    if (!m) continue;
    const t = cleanBody(getMessageText(i));
    if (!t) continue;
    if (m.is_user) {
      if (cfg.includeUserFloors) out.unshift(`[用户] ${t}`);
    } else {
      aiCount += 1;
      out.unshift(`[角色] ${t}`);
    }
  }
  return out;
}

/* ============ 主流程 ============ */

/**
 * ★ v0.9.38 在场角色预筛：发给模型分析的档案只保留正文点名的角色。
 *
 * 背景：出词走推理模型（如 deepseek-flash）时，思维链长度随输入复杂度增长，
 * 全量档案（实测 21 人 3.1k 字）叠加 2 万字规范后，8192 max_tokens 会被
 * 思维链整个吃光，正文为空 →「模型只返回了思考过程」→ 楼层出图失败。
 * 实测预筛后 21 人 → 本楼点名 3 人，档案文本 3116 → 773 字。
 *
 * 规则（宁可多带、不可漏带）：
 *   - 名字直接出现在正文 → 保留；
 *   - 3 字以上长名的前两字出现在正文也算（「结城太太」→ 正文写「结城姐」）——
 *     误命中只是多带一条档案，无害；漏带才有害（模型看不到档案会漂移或乱建档）；
 *   - <user> 宏条目、锁定条目（人设主权）、全局条目永远保留；
 *   - 一个都没命中（正文全是代词）→ 退回全量保底。
 *
 * 只裁剪「发给模型的档案文本」；changes 应用与一致性校验仍用全量快照。
 */
export function filterPresentSnapshot(snapshot, body) {
  if (!Array.isArray(snapshot) || !body) return snapshot;
  const hit = (name) => {
    const n = String(name || '').trim();
    if (!n) return false;
    if (body.includes(n)) return true;
    return n.length >= 3 && body.includes(n.slice(0, 2));
  };
  const keep = snapshot.filter((item) => {
    if (!item?.name) return false;
    if (item.name === '<user>' || item.locked || item.scope === 'global') return true;
    return hit(item.name);
  });
  // 「一个都没点名」的判定要看锁定条目**之外**有没有人命中 —— <user>/锁定条目
  // 是无条件保留的，keep 里永远有它们；正文全是代词时仍应退回全量保底
  // （模型分不清在场是谁，得靠全量档案比对）。
  const hitAny = keep.some(item => item.name !== '<user>' && !item.locked && item.scope !== 'global');
  return hitAny ? keep : snapshot;
}

/**
 * ★ v0.9.40 从**原始**楼层文本里捞服装线索（含 `[metacognition]` 元认知块）。
 *
 * 必须走原文而不是 cleanBody 的结果：`cleanBody` 用 META_RE 把整个元认知块删掉，
 * 而主模型恰恰爱把「谁穿什么」写在那里 ——
 *   `- 角色穿着物理验算：结城太太穿着粉色居家服，周雅穿着灰色亚麻围裙，夜斗穿着牛仔裤。`
 * 实测后果：围裙在正文本体里也反复出现（清洗后还在）→ 女角色抓得到；
 * 男主的牛仔裤只在元认知块里 → 清洗后消失 → 永远抓不到。
 *
 * 只捞含服装词的行（≤300 字），不进主分析 —— 主分析的 P 编号依赖行结构，动不得。
 */
export function collectOutfitClues(mesId, cfg, floors = 3) {
  const chat = getChat();
  if (!Array.isArray(chat)) return '';
  const out = [];
  let seen = 0;
  for (let i = Number(mesId); i >= 0 && seen < floors; i -= 1) {
    const m = chat[i];
    if (!m) continue;
    const raw = String(getMessageText(i) || '');
    const c = outfitCluesFrom(raw);
    if (c) out.unshift(`— ${m.is_user ? '用户' : 'AI'}楼 #${i + 1} —\n${c}`);
    if (!m.is_user) seen += 1;
  }
  return out.join('\n\n');
}

/**
 * ★ v0.9.39 阶段 ②c：服装态扫描。
 *
 * 补的是整条链路上最缺的一环 —— **写入端**。
 * 在此之前服装只有一条写入路径：出词模型在 changes 里主动报 outfit。而它报不报全看心情，
 * 实测 22 楼里 13 楼正文明确写了服装，dyn 里落库 0 条 → 档案行没有服装段 →
 * 出图时模型每轮翻正文现编 → 同款编出不同版本（漂移）。
 *
 * 收窄策略（用户拍板「自动扫，按需收窄」）：
 *   - 只扫本楼在场的角色（复用 filterPresentSnapshot 的命中口径）；
 *   - 已记录服装 **且** 本楼正文没有换装动词 → 跳过（沿用就是最正确的答案，
 *     再问一次只会换回一套措辞不同的同款，那正是漂移的来源）；
 *   - 候选为空就一次都不调 LLM。
 *
 * @returns {Promise<{changed:boolean, applied:Array, rejected:Array, scanned:string[]}>}
 */
/**
 * 只跑服装态扫描 —— GAL 接管时用（v0.9.179）。
 *
 * ★ 为什么能把这一步单独拎出来：
 *   `runOutfitScan` 只做「读正文 → 问模型 → 写 dyn 档案」，**一个字都不碰正文**，
 *   连图位是什么都不知道。而 GAL 接管时被整条拦掉的真正原因是管线后面的
 *   `writeImagesToFloor` 会往正文写 `<hl_image>` —— GAL 不认识那个标签，
 *   会把整段 JSON 当普通文字显示出来（真实事故，见 scanner.js 的注释）。
 *   ⇒ 拦的是「写正文」那一步，不是「扫服装」这一步。以前一刀切，服装态被连坐。
 *
 * ★ 传进来的 `body` 优先用（scanner 那边已经清洗过一次，再洗一遍等于白跑）。
 */
export async function runOutfitScanOnly({ mesId, taskId, body: presetBody } = {}) {
  const cfg = getConfig();
  const body = String(presetBody == null ? cleanBody(getMessageText(mesId)) : presetBody);
  if (!body.trim()) return { changed: false, applied: [], rejected: [], scanned: [] };
  const floors = Number(cfg.consistency?.outfitScanFloors ?? 5);
  return runOutfitScan({
    body,
    history: collectHistory(mesId, floors),
    snapshot: buildLibrarySnapshot(),
    round: Number(mesId) || 0,
    cfg,
    taskId,
    mesId,
    clues: collectOutfitClues(mesId, cfg, floors),
  });
}

export async function runOutfitScan({ body, history, snapshot, round, cfg, taskId, mesId, clues }) {
  const empty = { changed: false, applied: [], rejected: [], scanned: [] };
  const cons = cfg?.consistency || {};
  if (!cons.enabled || !cons.outfitMachine) return empty;
  if (cons.outfitScan === false) {
    step(taskId, STAGE.CONSISTENCY, '服装扫描：设置里已关闭，本楼沿用档案现款');
    return empty;
  }

  const present = filterPresentSnapshot(snapshot, body);
  /**
   * 线索原文**提前算一次**：下面判定候选要用（正文被清洗掉、但线索里还在的描写），
   * 构造请求时还要用。算两次等于白跑一遍 IO。
   */
  /**
   * 兜底窗口也跟随 outfitScanFloors（v0.9.52）—— 否则"调用方传了 clues"与
   * "内部自己算"两条路径的回看楼数不一致，排查时会对不上。
   */
  const clueText = String(
    clues || collectOutfitClues(mesId, cfg, Number(cfg?.consistency?.outfitScanFloors ?? 5)) || '',
  );

  /**
   * v0.9.46：候选判定从「没款式 or 有换装动词」扩到五条。
   *
   * 旧口径漏掉了 NSFW 里最高频的情形 —— **他不换衣服，只是脱**：
   *   「顺着松紧带直接将运动裤和内裤一起往下扯」「褪到膝盖处的灰色运动裤」
   * 这类句子一个换装动词都没有，角色被整楼跳过 → 状态位不动、bare 永远空着，
   * 用户只能手动填（用户原话：「每次自己手动感觉很麻烦」）。
   * 现在只要正文/线索里出现任何**穿着状态**相关的描写，就把他拉进来重新评估。
   */
  const candidates = [];
  for (const item of present) {
    const name = item?.name;
    if (!name) continue;
    const hasNow = !!resolveOutfitStyle(item?.dyn);
    if (!hasNow) {
      // rank 3：没有服装就没得沿用，必须建档；但本楼没提到他的穿着时优先级低于真实的穿着变化
      candidates.push({ name, hasNow, why: '尚未建档', rank: 3 });
      continue;
    }
    /**
     * v0.9.67（C3）：换装动词与「具体新款描述」分开算。
     * - swapVerb：明确换装动作 —— 最强信号，rank 5
     * - novel   ：正文具体写了件衣服（"穿着白色丝质睡裙"）但没写换装动作
     *             放宽**准入**让它进候选，放行仍由 store 的连续 N 楼闸门把关；
     *             rank 4.5 —— 比换装弱、比状态变化强。
     */
    const swapVerb = hasOutfitSwapSignal(body, name, present.length);
    const novel = !swapVerb && hasOutfitNovelSignal(body, name, present.length);
    const swap = swapVerb || novel;
    const stateChg = hasOutfitStateSignal(body, name, present.length);
    const redress = hasOutfitRedressSignal(body, name, present.length);
    // 已经记着"他此刻裸露着" → 每楼都要跟踪（剧情可能已经把他穿回去了）
    const hasBare = !!String(item?.dyn?.outfit?.bare || '').trim();
    // 线索原文里点到了这个名字（清洗掉的元认知块里写了他的衣服，正文本体没有）
    const inClues = !!clueText && clueText.includes(name);

    if (!swap && !stateChg && !redress && !hasBare && !inClues) continue;
    /**
     * v0.9.52：按**信号强度**排序后再截断（此前直接截 `listCast` 的前 8 个）。
     *
     * 为什么必须排：候选来源是 `filterPresentSnapshot`，正文全是代词时它会退回
     * **全量档案**，顺序是档案里的存储顺序 —— 与"谁真的脱了衣服"毫无关系。
     * 硬截前 8 个 = 真正有穿着描写的角色被截在门外，而那正是服装态存在的意义；
     * 被截掉的这一楼，档案里的状态位不动，下一楼才有可能再扫到（也可能永远扫不到）。
     */
    const rank = swapVerb ? 5 : novel ? 4.5 : (stateChg || redress) ? 4 : hasBare ? 2 : 1;
    candidates.push({
      name,
      hasNow,
      why: swapVerb ? '换装描写'
        : novel ? '新款描述（待连续确认）'
          : stateChg ? '穿着状态变化'
            : redress ? '重新穿好'
              : hasBare ? '已有裸露记录待跟踪'
                : '原文线索提到',
      rank,
      redress,
    });
  }
  if (!candidates.length) {
    step(taskId, STAGE.CONSISTENCY, '服装扫描：在场角色服装均已记录且本楼无穿着描写，全部沿用');
    return empty;
  }

  /**
   * 候选上限：正文一个名字都没提到时，filterPresentSnapshot 会**退回全量**
   * （全是代词时模型分不清在场是谁，只能靠全量比对）→ 实测会一次扫 43 人。
   * 服装扫描是"本楼谁在场"的辅助判断，宁可少扫几个（下一楼还有机会），
   * 也不要在异常输入下把整份档案塞进一次请求。
   */
  const MAX_SCAN = Math.max(1, Number(cons.outfitScanMax ?? 8));
  /**
   * 排序（v0.9.52）：先按 rank 降序，再保持档案原顺序（sort 稳定，同档不抖）。
   * 只在这里排一次，`candidates` 之后的 `candMap` / payload 都跟着受益。
   */
  candidates.sort((a, b) => (Number(b.rank) || 0) - (Number(a.rank) || 0));
  if (candidates.length > MAX_SCAN) {
    const dropped = candidates.slice(MAX_SCAN).map(x => `${x.name}[${x.why}]`).join('、');
    warn(STAGE.CONSISTENCY,
      `服装扫描候选 ${candidates.length} 人，超过上限 ${MAX_SCAN} —— 按信号强度取前 ${MAX_SCAN} 个，`
      + `本楼跳过：${dropped}。`
      + '（正文里没点名任何角色时会退回全量档案；想让它认得准，正文里写出角色名）');
    candidates.length = MAX_SCAN;
  }

  const names = candidates.map(x => x.name);
  step(taskId, STAGE.CONSISTENCY,
    `服装扫描：${names.length} 人待确认（${candidates.map(x => `${x.name}[${x.why}]`).join('、')}）`);

  const messages = buildOutfitScanMessages({
    names,
    body,
    history,
    clues: clueText,
    // 只带候选人的现款，避免把整份档案塞进这次轻量请求
    snapshot: present.filter(x => names.includes(x.name)),
  });

  let raw = '';
  try {
    /**
     * 刻意**不压 max_tokens**：出词通道若是推理模型（deepseek-flash / R1 系），
     * 思维链会先吃掉一大截，压到 2048 很容易整段输出只剩 reasoning_content、
     * 正文为空 → 扫描白跑一次。跟随配置默认值即可，llmapi 侧还有思维链兜底重试。
     * 温度压低：服装提取要的是"照抄正文"，不是创作。
     */
    raw = await callAnalyzeLLM(messages, {
      taskId,
      source: `楼层服装扫描`,
      temperature: 0.2,
    });
  } catch (e) {
    warn(STAGE.CONSISTENCY, `服装扫描调用失败（不影响出图，沿用档案现款）：${String(e?.message || e)}`);
    return empty;
  }
  if (!raw || !raw.trim()) {
    warn(STAGE.CONSISTENCY, '服装扫描返回空（不影响出图，沿用档案现款）');
    return empty;
  }

  const got = extractJsonText(raw);
  if (!got.ok) {
    warn(STAGE.CONSISTENCY, '服装扫描返回的不是 JSON（不影响出图，沿用档案现款）');
    return empty;
  }
  const list = Array.isArray(got.value?.outfits) ? got.value.outfits : [];
  if (!list.length) {
    step(taskId, STAGE.CONSISTENCY, '服装扫描：正文未写明在场角色的衣着，沿用档案现款');
    // 人是真的扫过了，只是模型没返回服装 —— scanned 要照实带回，
    // 否则诊断里看不出这次到底问了谁（排查"为什么这个角色一直没服装"时会卡住）。
    return { ...empty, scanned: names };
  }

  /**
   * 换装信号在这里落地：扫描只对「正文命中换装动词」的人放行款式改写。
   * 没命中却仍返回了不同款式 → updateOutfit 的覆盖率闸门会拒，并进 rejected 告警，
   * 用户能在诊断里看见「疑似换装但正文没写」这件事，自己决定要不要手动换。
   */
  /**
   * 场景切换信号（v0.9.47）。认全楼文本 —— 时间跳跃通常是整段的前置说明，
   * 不会出现在某个角色那一句里，按角色名匹配反而抓不到。
   */
  const sceneBreak = hasSceneBreakSignal(body);
  if (sceneBreak) {
    step(taskId, STAGE.CONSISTENCY, '服装扫描：本楼检测到场景切换（时间跳跃 / 新场景），款式改写放行');
  }
  const candMap = new Map(candidates.map(x => [x.name, x]));
  const payload = list.map(it => ({
    name: it?.name,
    outfit: it?.outfit,
    outfitState: it?.outfitState,
    outfitPreset: it?.outfitPreset,
    /**
     * v0.9.45：裸露锚点 + 重新着衣信号。
     * redress 取「模型自己报了」或「候选判定时正文命中了重新穿上动词」—— 双保险，
     * 模型漏报时代码仍能认出来（换装信号一直是这么做的）。
     */
    outfitBare: it?.outfitBare,
    redress: it?.redress === true || candMap.get(String(it?.name || '').trim())?.redress === true,
    sceneBreak,
    /**
     * swapped 在这里的语义是**放行款式改写**（不是"他一定换了衣服"）。
     * v0.9.47 加第二条放行：场景切换（第二天 / 醒来 / 回到家 / 洗完澡）。
     * 剧情换衣服最常见的场合恰恰没有换装动词 —— 「第二天早上他醒来，穿了件灰色运动裤」
     * 只是陈述新场景的穿着，旧口径会把它永久锁在上一场景那套。
     * ⚠️ 只放行款式，**不重置状态位 / 不清空裸露** —— 新场景该不该穿好只能读剧情定，
     *    用户明确否决过"场景切换就默认穿好"（第二天醒来可能还光着）。
     */
    swapped: hasOutfitSwapSignal(body, it?.name, candidates.length) || sceneBreak,
  }));

  const res = applyOutfitScan(payload, round, { floor: mesId });

  for (const a of res.applied) {
    const what = a.swapped ? '换装' : a.bareOnly ? '裸露状态' : '建档';
    const val = a.bareOnly
      ? `裸露=${a.bare || '(已清空)'}${a.note ? `（${a.note}）` : ''}`
      : `${String(a.style || '').slice(0, 60)}${a.bare ? `／裸露=${String(a.bare).slice(0, 40)}` : ''}`;
    step(taskId, STAGE.CONSISTENCY, `服装${what}：${a.name} → ${val}`);
  }
  for (const r of res.rejected) {
    warn(STAGE.CONSISTENCY,
      `服装扫描被拒：${r.name} — ${r.reason}`
      + '\n      若剧情里确实换了衣服，请到「角色档案」页手动点「换装」，'
      + '或在正文里写明「她换上了…」（插件只认明确的换装描写）。');
  }
  for (const s of res.skipped) {
    info(STAGE.CONSISTENCY, `服装沿用：${s.name}（${s.reason}）`);
  }

  return {
    changed: res.applied.length > 0,
    applied: res.applied,
    rejected: res.rejected,
    scanned: names,
  };
}

/**
 * @param {object} p
 * @param {number} p.mesId
 * @param {string} p.body   已清洗的目标正文
 * @param {(ok:boolean)=>void} [p.onDone]
 * @returns {Promise<string|null>} taskId
 */
export async function runPipeline({ mesId, body, onDone, onPreview }) {
  const cfg = getConfig();

  if (!cfg.enabled) {
    info(STAGE.INIT, `楼层 #${mesId} 跳过：插件总开关未打开`);
    onDone?.(false);
    return null;
  }

  const taskId = beginTask(`楼层 #${mesId}`, { mesId, bodyLen: body.length });
  let ok = false;

  // SD 助手式气泡：让用户知道"正文已经被拿去分析了"
  notifyInfo(`正在分析楼层 #${mesId} 的正文…`, '分析完成后会自动生图并插入正文');

  try {
    /* ① 轮次与在场角色 */
    const round = (getRound() || 0) + 1;
    setRound(round);
    wakeByText(body);

    /**
     * ①b v0.9.48 删楼 / 重跑回滚 —— 服装跟着楼层一起退回去。
     *
     * ★ 用户实测：「我删楼重新生成，也没用」。原因就是服装状态存在会话档案里，
     *   跟消息是两套数据：删楼只删消息，档案里那一楼推导出的服装（哪怕是被漂移污染的）
     *   原封不动留着，重跑等于在错误结果上再算一遍。更糟的是「连续新款计数」也留着，
     *   每重跑一次 +1，达到 N 就自动放行新款 —— **删楼重跑反而把漂移固化得更快**。
     *
     * 所以每次分析先把"本楼及之后"的服装变化全部作废，再由本楼重新推导。
     * 这与"本楼没写他穿什么就沿用上一楼"是同一套语义，不会丢东西。
     */
    const rolled = rollbackOutfitsBefore(mesId);
    if (rolled.rolled) {
      step(taskId, STAGE.CONSISTENCY,
        `服装回滚：本楼（#${mesId}）及之后的 ${rolled.rolled} 条服装记录已作废，`
        + `由本楼重新推导（${rolled.names.slice(0, 5).join('、')}${rolled.names.length > 5 ? '…' : ''}）`);
    }

    /* ② 档案库快照 */
    let snapshot = buildLibrarySnapshot();
    // ★ v0.9.38 在场角色预筛：只把正文点名的角色档案发给模型（锁定/主角条目永远保留）。
    //   变化应用与一致性校验仍用全量 snapshot —— 这里只裁「发给模型的档案文本」。
    // let：③b 服装扫描落库后要重建，这里得跟随刷新
    let snapshotLlm = filterPresentSnapshot(snapshot, body);
    step(taskId, STAGE.PROMPTS,
      snapshotLlm.length === snapshot.length
        ? `档案库 ${snapshot.length} 个角色（轮次 ${round}）`
        : `档案库 ${snapshot.length} 个角色，本楼点名 ${snapshotLlm.length} 个进提示词（轮次 ${round}）`);

    if (!snapshot.length) {
      warn(STAGE.CONSISTENCY,
        '档案库是空的 —— 本楼会由模型新建档，建议先跑一次「从角色卡建档」以保证外貌稳定');
    }

    /* ②b 主角（＝正文里的 <user>）缺档检测 —— v0.9.26
     * 这是「第二个角色没有外貌」最隐蔽的来源：男主往往就是跟你对话的用户本人，
     * 正文里写作 <user>，插件无从得知他是谁。只要用户没用真名在档案库里给他建过档，
     * 画面里就永远缺他的外貌 —— 表现为「女主/精灵有锚定，男主是个没脸的路人」。
     * 插件不能替他编外貌（人设主权区），只能把这件事明确说出来。 */
    const userName = String(getUserName() || '').trim();
    if (userName && !snapshot.some(x => x.name === userName)) {
      warn(STAGE.CONSISTENCY,
        `「${userName}」（＝正文里的 <user>）在档案库里没有外貌 —— 他进入画面时不会有脸。请到「角色档案」用这个**准确的**名字为他建档（可用「一键提取」从用户设定读取）；名字对不上等于没建。`);
      step(taskId, STAGE.CONSISTENCY, `本楼主角「${userName}」缺外貌档案（<user> 指代的人）`);
    }

    /**
     * v0.9.41：主角双档案提示。
     * 库里同时存在「夜斗」和「<user>」时，快照层已按同一人合并（服装取有值的），
     * 但**存档里仍是两条** —— 服装扫描可能只写中一条，UI 上也会显示成"未设置"。
     * 把这件事说出来，用户就能去点「合并重复」一次性根治。
     */
    if (userName && snapshot.some(x => /^<(user|persona)>$/i.test(String(x?.name || '')))) {
      step(taskId, STAGE.CONSISTENCY,
        `主角「${userName}」有两条档案（另一条写作 <user>）—— 已按同一人合并进提示词；`
        + '建议到「角色档案」页点「合并重复」合成一条');
    }

    /* ③ 历史楼层 */
    const history = collectHistory(mesId, cfg.carryFloors);
    if (history.length) step(taskId, STAGE.PROMPTS, `携带最近 ${history.length} 段历史`);

    /* ③b 服装态扫描（v0.9.39）
     * 放在主分析**之前**：先让档案库带上「此刻穿着」，主分析模型就能逐字沿用，
     * 而不是自己再编一遍。扫完要重建快照 —— 否则档案文本还是旧的那一版。 */
    /**
     * v0.9.47：服装扫描用**自己的**历史窗口（默认 5 楼），不跟出图的 carryFloors 共用。
     * 出图只要接得上上一张（2 楼够），但服装态是跨楼延续的 ——
     * 只看 2 楼，模型判断不出"三楼前他脱了、这一楼穿回去没有"，只能沿用档案旧值。
     */
    const scanFloors = Number(cfg.consistency?.outfitScanFloors ?? 5);
    const scanHistory = scanFloors > cfg.carryFloors
      ? collectHistory(mesId, scanFloors)
      : history;
    /**
     * v0.9.52：线索回看楼数**必须跟随 outfitScanFloors**（此前一直是默认值 3，
     * 设置里改成 5/8 也没有任何效果 —— 配置项形同虚设）。
     * 线索是"本楼正文被清洗掉、但原文里还在的服装描写"（元认知块里的穿着验算），
     * 与 scanHistory 同口径才不会一回事两套窗口。
     */
    const scanRes = await runOutfitScan({
      body, history: scanHistory, snapshot, round, cfg, taskId, mesId,
      clues: collectOutfitClues(mesId, cfg, scanFloors),
    });
    if (scanRes.changed) {
      snapshot = buildLibrarySnapshot();
      snapshotLlm = filterPresentSnapshot(snapshot, body);
    }

    /* ④ 请求模型 */
    // fullNames：全量名单 —— 世界书关键词与「待建档」判断必须看全量（快照可能被预筛裁掉，
    // 裁掉≠不存在；拿预筛名单判断会让已建档角色被误判为待建档 → 模型重复建档）。
    const messages = buildAnalyzeMessages({
      body, history,
      snapshot: snapshotLlm,
      fullNames: snapshot.map(x => x?.name).filter(Boolean),
      cfg, round,
      // v0.9.52：让模型看见近期已出过的图（只取 ≤ 本楼的，避免把"未来"泄进去）
      mesId,
    });
    const raw = await callAnalyzeLLM(messages, { taskId, source: `楼层#${mesId} 分析` });

    if (!raw || !raw.trim()) {
      /**
       * ★★ v0.9.105：这条分支是「点开始 → 几秒后显示完成 → 图没变」的头号来源。
       *
       * `callAnalyzeLLM` / `callCustomLlm` 失败时**不抛异常**，只 diagnose + return ''，
       * 所以这里必须把「出词那一步没成功」说清楚 —— 否则用户只会看到「完成」。
       * 文案里明确排除「本楼不需要配图」，避免和另一条跳过分支混淆。
       */
      failTask(taskId, STAGE.API, '出词 API 没有返回内容（不是「本楼不需要配图」，是那一步请求没成功）', {
        cause: '请求发出去了但没有回包。常见：接口地址 / 模型名不被接受、API Key 失效或余额不足、请求超时、上下文过长被截断',
        fix: '到「出词 API」页点「测试 API 连接」单独验一次；再到「诊断」页看「调用模型」阶段的原始响应',
      });
      return taskId;
    }

    /* ⑤ 解析 + 应用变化 */
    const parsed = parseAnalyzeOutput(raw);
    if (!parsed.ok) return taskId; // 内部已记诊断

    const changeRes = applyChanges(parsed.changes, { round, snapshot, cfg, floor: mesId });
    snapshot = changeRes.snapshot;

    if (changeRes.applied.length) {
      step(taskId, STAGE.CONSISTENCY,
        `应用了 ${changeRes.applied.length} 项档案变化：${changeRes.applied.map(x => `${x.name}(${x.kind})`).join('、')}`);
    }
    if (changeRes.rejected.length) {
      step(taskId, STAGE.CONSISTENCY, `拒绝了 ${changeRes.rejected.length} 项变化（详见警告日志）`);
    }

    const presentNames = new Set(changeRes.applied.map(x => x.name));
    if (presentNames.size) markPresent(Array.from(presentNames), round);

    /* ⑥ 位置校验 + 逐图处理 */
    // 位置池必须与"给模型看的正文"和"插入时定位的正文"是同一份清洗结果，
    // 否则编号错位 —— 图会插到别的段落后面。
    const ids = validPositionsFrom(cleanBodyLines(body));
    /**
     * ★★★ v0.9.137：剧情演完模式必须放行更高的张数上限。
     *
     * 模型按情节点给出 9 张，而 `maxImagesPerFloor`（用户设的"精选"上限，如 5）
     * 会在这里**一刀切掉后面 4 张** —— 而丢掉的正好是剧情后半段，
     * 用户看到的就是"演到一半断了"，还以为模型不肯画。
     * ⇒ 覆写模式下取 max(精选上限, 覆盖上限)，两个都读得到才不会被旧设置压住。
     */
    const coverCfg = normalizeMossCover(cfg.mossJson);
    const imgCap = coverCfg.on
      ? Math.max(Math.max(1, Number(cfg.maxImagesPerFloor) || 1), coverCfg.max)
      : Math.max(1, Number(cfg.maxImagesPerFloor) || 1);
    const val = validateImages(parsed.images, ids, imgCap);

    // 单楼最少图片数：低于下限时提示（不阻断 —— 硬重出会翻倍烧 API，交给用户决定）
    const minImg = Math.min(
      Math.max(1, Number(cfg.maxImagesPerFloor) || 1),
      Math.max(1, Number(cfg.minImagesPerFloor) || 1),
    );

    if (!val.valid.length) {
      /**
       * ★ v0.9.105：这是「点了开始、瞬间完成、图没变」的头号出口。
       *
       * 以前这里 `ok = true` + 一句「完成（无配图）」，把**跳过**说成了**完成**：
       *   - 调用方 runManual 只看 ok → UI 打「✓ 完成」；
       *   - 真正原因（模型没给图 / 位置编号对不上）只落在诊断页的 info 里，
       *     用户根本不会去翻 → 以为「插件坏了 / 重跑没生效」。
       * 现在：原因写进 endTask 的 summary 与 data，并标 skipped，UI 直接显示。
       */
      const why = parsed.images.length
        ? `模型给了 ${parsed.images.length} 张图，但位置编号全部对不上本楼正文（正文共 ${ids.length} 个段落：${ids.slice(0, 8).join('/')}${ids.length > 8 ? '…' : ''}；模型给的是 ${parsed.images.map(i => i.position).join('/') || '空'}）`
        : '模型判断本楼不需要配图（输出里 images 为空）';
      info(STAGE.RENDER, `楼层 #${mesId} 跳过：${why}`);
      endTask(taskId, `楼层 #${mesId} 跳过：${why}`, {
        validIds: ids,
        modelPositions: parsed.images.map(i => i.position),
        dropped: val.dropped,
      }, { skipped: true });
      ok = true;
      return taskId;
    }
    if (val.valid.length < minImg) {
      warn(STAGE.RENDER, `楼层 #${mesId}：本楼只配了 ${val.valid.length} 张，低于「单楼最少图片数」${minImg} —— 模型判断其余段落画面不足；想要更多可把下限降回 1 或手动生图`);
    }

    // 已知角色名 = 库里的 + 本楼新建的（本楼新建的不在 snapshot 里）
    const knownNames = Array.from(new Set([
      ...snapshot.map(x => x.name),
      ...changeRes.applied.map(x => x.name),
    ]));

    // 本楼在场角色（v0.9.25）：锚点候选池 + 告警名单都按它收窄。
    //   来源 = 模型本楼提到过的（含被拒绝的变化）+ 正文里直接出现的档案名。
    //   过去拿全库当候选池，才会冒出「14 个在场角色」这种没人看得懂的告警。
    const floorPresent = Array.from(new Set([
      ...changeRes.applied.map(x => x.name),
      ...(Array.isArray(changeRes.rejected) ? changeRes.rejected : []).map(x => x?.name).filter(Boolean),
      ...knownNames.filter(n => n && body.includes(n)),
    ]));
    if (floorPresent.length) {
      step(taskId, STAGE.PROMPTS, `本楼在场 ${floorPresent.length} 人：${floorPresent.join('、')}`);
    }

    let processed = [];
    const missed = new Set();   // 画面里有、档案库却没有的人（v0.9.26）
    for (const img of val.valid) {
      const lineIndex = ids.indexOf(img.position) + 1;
      const p = processImage(img, {
        snapshot,
        positional: changeRes.positional,
        lineIndex,
        knownNames,
        presentNames: floorPresent,
        // v0.9.53：段落编排（全局 cfg.promptLayout）—— processImage 据此决定服装是否独立成段
        layout: cfg.promptLayout || null,
      });
      if (p.ok) processed.push(p);
      // 「cast 点了名但库里查不到」——下一轮回灌给模型，逼它把这个人的外貌补上。
      // 不回灌就会陷入死循环：点名 → 查无此人 → 忽略 → 下轮再点名 → 再查无此人。
      for (const n of p.unknown) if (n) missed.add(n);
      for (const n of p.notes) warn(STAGE.CONSISTENCY, `${img.position}：${n}`);
    }

    // new 建档被拒的角色同样欠外貌（典型：`kind:"new"` 却没带 fields）。
    // 这是「第二个人永远没有外貌」最直接的来源 —— 必须一起回灌。
    for (const r of Array.isArray(changeRes.rejected) ? changeRes.rejected : []) {
      if (r?.kind === 'new' && r?.name) missed.add(r.name);
    }
    if (missed.size) addPendingProfiles(Array.from(missed));

    if (!processed.length) {
      failTask(taskId, STAGE.CONSISTENCY, '所有图片都因一致性校验被丢弃', {
        cause: '提示词为空，或锚点自愈后仍无可绘内容',
        fix: '检查「生图规范」是否被清空；确认档案库里的角色有 hair/eyes 字段',
      });
      return taskId;
    }

    summarize(processed);

    /**
     * v0.9.53：预览模式（手动生图用）—— 分析完**先停**，弹出预览编辑器，
     * 用户看完/改完/给 AI 下完指令，点「开始生图」才继续走写回正文 + 提交后端。
     *
     * onPreview(processedList, resolve)：
     *   resolve(editedList) = 按编辑后的内容继续（数组，元素同 processed 结构）；
     *   resolve(null)       = 取消，整个任务到此为止（不写正文、不出图）。
     * 回调抛异常按"没弹出来"处理：按原文继续，不能把管线挂死。
     */
    if (typeof onPreview === 'function' && processed.length) {
      const edited = await new Promise((resolve) => {
        try {
          onPreview(processed, (list) => resolve(list));
        } catch (err) {
          warn(STAGE.PROMPTS, `预览界面异常，按原文继续生图：${err?.message || err}`);
          resolve(processed);
        }
      });
      if (!Array.isArray(edited) || !edited.length) {
        // v0.9.105：这是「用户主动取消」，不是完成 —— 标 skipped 让 UI 说清楚
        endTask(taskId, `楼层 #${mesId} 在预览中取消 —— 未写正文、未生图`, undefined, { skipped: true });
        ok = true;
        return taskId;
      }
      processed = edited;
    }

    /**
     * ★★★ v0.9.124：Layout 口径的 `p.tag` 必须在**写回正文之前**填好，
     *   编译失败的项必须**当场剔除**。两条后果都是这次诊断报告直接抓到的：
     *
     *   ① 写回发生在 submitAll 之前，而 `p.tag = tidySeparators(prompt)` 原来只写在
     *      submitAll 里面 —— 于是正文块永远是 `<hl_image pos="P4"></hl_image>`。
     *      实测楼层 #160：正文里 6 个块，**内容长度全是 0**。
     *      渲染侧按块内容算 hash 去 store 配图，空块 hash 全等且匹配不到任何记录
     *      ⇒ 出图位在正文里立着，**一个图都不显示** —— 用户看到的就是「生图失败」。
     *   ② 编译失败的项（canvas 与 object 数对不上 / 坐标不合法）也会被写成空块，
     *      还顶掉上一轮同位置的旧块 → 旧记录随后被 `pruneFloorResultsByHash` 当孤儿清掉。
     *      实测「本来 4 张，重跑一次只剩 2 张」就是这么来的。
     *      所以这里直接剔掉：旧块、旧图、旧记录原样保留。
     *
     * 顺手把 composePrompt 的结果缓存到 `p.__composed` 供 submitAll 复用 ——
     * 保证「写进正文的」与「送进模型的」是**同一份字符串**（块 hash 才对得上）。
     */
    if (activeOutput() !== 'text') {
      const keep = [];
      for (const p of processed) {
        if (String(p.tag || '').trim()) { keep.push(p); continue; }
        const composed = composePrompt(p, cfg);
        const prompt = String(composed.prompt || '').trim();
        if (!prompt) {
          warn(STAGE.PROMPTS, `${p.position}：Layout 编译失败 → 本张不出图（该位置原有的旧图保留不动，详见上一条编译警告）`);
          continue;
        }
        p.tag = tidySeparators(prompt);
        p.__composed = composed;
        keep.push(p);
      }
      if (keep.length !== processed.length) {
        warn(STAGE.PROMPTS, `本轮 ${processed.length} 个出图位里 ${processed.length - keep.length} 个编译失败已跳过，其余 ${keep.length} 个照常出图`);
      }
      if (!keep.length) {
        failTask(taskId, STAGE.PROMPTS, '本楼所有出图位都编译失败，一张都没出', {
          cause: 'Layout 草稿的坐标或结构不合法（具体原因见上面的编译警告）',
          fix: '重跑一次通常就好（模型偶尔给出不合法坐标）；连续出现请到「诊断」页看具体报错',
        });
        return taskId;
      }
      processed = keep;
    }

    /* ⑦ 写回正文 */
    // expectedFp：触发分析时的正文指纹。分析要跑几十秒，期间正文若被
    // 重生成/预设脚本改过，旧行号写回必然错位 —— 不一致时先尝试按段落内容
    // 重定位（expectedBody，v0.9.34：词表/状态栏脚本只加行不改段落，重定位
    // 后安全写入），段落结构真变了才放弃。
    const wrote = writeImagesToFloor(mesId, processed, {
      expectedFp: bodyFingerprint(body),
      expectedBody: body,
    });
    if (!wrote.ok) {
      /**
       * ★★ v0.9.106：失败原因必须分档说清，不能再一句「正文写入被跳过」把人堵住。
       *   三种完全不同的病，处理办法也完全不同：
       *   - stale  正文在分析那几十秒里被改过，且段落对不上（重生成没结束 / 预设脚本重排）
       *   - insert 位置一个都没落进去（模型给的 P 号在正文里找不到）
       *   - prefix 并发保护拦住（真的有人在写回前改了这楼）
       */
      const why = wrote.why || (wrote.stale ? 'stale' : 'insert');
      const causeText = why === 'stale'
        ? '分析那几十秒里正文还在变（重生成没结束，或预设的变量/渲染脚本在改写），段落已经对不上原位置 —— 基于旧行号写回会插错地方，已主动放弃'
        : why === 'insert'
          ? `模型给的出图位置在正文里一个都没找到${wrote.missed?.length ? `（${wrote.missed.join('/')}）` : ''} —— 通常是位置编号超出了本楼段落数`
          : '写回前这一刻正文被改动了（你刚编辑过消息，或切了 swipe），为避免覆盖你的改动已放弃';
      failTask(taskId, STAGE.RENDER, '正文写入被跳过', {
        cause: causeText,
        fix: why === 'insert'
          ? '重跑一次通常就好（模型偶尔给错编号）；连续出现请到「诊断」页看本楼的段落数与模型返回值'
          : '等正文稳定后重跑（别在分析中途再编辑这楼）；「用我填的正文」模式会先落盘再分析，不会撞这条',
        data: { why, missed: wrote.missed || [], written: wrote.written || [], inserted: wrote.inserted ?? null },
      });
      return taskId;
    }

    // 只提交真正写进正文的位置 —— 位置没写进去的（正文段落数对不上）提交了也显示不出来，
    // 还会变成孤儿记录污染后续渲染
    const writtenSet = new Set(wrote.written);
    const toSubmit = processed.filter(p => writtenSet.has(String(p.position).toUpperCase()));
    if (toSubmit.length < processed.length) {
      const skipped = processed.filter(p => !writtenSet.has(String(p.position).toUpperCase()));
      warn(STAGE.RENDER, `跳过 ${skipped.length} 个没写进正文的位置：${skipped.map(p => p.position).join('/')}`);
    }
    if (!toSubmit.length) {
      endTask(taskId, `楼层 #${mesId} 跳过：出图位没写进正文（段落结构对不上），未提交生图`,
        { processed: processed.map(p => p.position), written: wrote.written }, { skipped: true });
      ok = true;
      return taskId;
    }

    // 孤儿清理：正文重写后，记录里对应旧剧情的图必须清掉 —— 否则渲染配对/图库都会被旧图污染
    try {
      const chat2 = getChat();
      const msg2 = chat2?.[mesId];
      const swipeId = Number.isFinite(msg2?.swipe_id) ? msg2.swipe_id : 0;
      const { parseTags } = await import('./render.js');
      const { pruneFloorResultsByHash } = await import('./store.js');
      const keepHashes = new Set(parseTags(getMessageText(mesId)).map(b => b.hash));
      const removed = pruneFloorResultsByHash(mesId, swipeId, keepHashes);
      if (removed) info(STAGE.RENDER, `楼层 #${mesId} 清理了 ${removed} 条旧剧情的孤儿出图记录`);
    } catch { /* 清理失败不阻断主流程 */ }

    // 立刻渲染一次：出图位先以占位框出现，用户能看见"这里在生图"
    renderFloor(mesId);

    notifyInfo(`开始生图 · 共 ${toSubmit.length} 张`, `楼层 #${mesId} · ${backendMeta(activeBackendKey(cfg)).name}`);

    /* ⑧ 提交后端 */
    await submitAll(mesId, toSubmit, cfg, taskId);

    endTask(taskId, `楼层 #${mesId} 完成：写入 ${toSubmit.length} 个出图位`);
    ok = true;
    return taskId;
  } catch (err) {
    failTask(taskId, STAGE.INIT, `管线异常：${err?.message || err}`, {
      cause: '未预期的错误，多半是扩展间冲突或数据结构异常',
      fix: '把诊断报告导出后反馈；临时可在「诊断」页关闭自动分析',
    }, err?.stack);
    return taskId;
  } finally {
    onDone?.(ok);
  }
}

/* ============ 提交生图 ============ */

async function submitAll(mesId, processed, cfg, taskId) {
  const backendKey = activeBackendKey(cfg);

  // 「不出图」是个显式选项（调提示词 / 跑 DRY 测试用），不是配置缺失
  if (backendKey === 'none') {
    info(STAGE.BACKEND, `后端设为「不出图」—— 本楼只写了 ${processed.length} 个出图位，没有提交生图`);
    return;
  }

  const meta = backendMeta(backendKey);
  const readiness = backendReadiness(backendKey, cfg);

  // 没配好就别往下走：早报比"提交了但每张都失败"清楚得多
  if (!readiness.ready) {
    diagnose(STAGE.BACKEND, `生图后端「${meta.name}」还没配好（${readiness.reason}）`, {
      cause: `当前生效的后端是 ${meta.name}`,
      fix: `到「生图后端」页切到 ${meta.name} 补齐缺的那项；或者把生效后端切回一个已经配好的`,
    });
    warn(STAGE.BACKEND, `本楼只写了出图位，没有提交生图（后端「${meta.name}」${readiness.reason}）`);
    return;
  }

  const chat = getChat();
  const msg = chat?.[mesId];
  const swipeId = Number.isFinite(msg?.swipe_id) ? msg.swipe_id : 0;

  let done = 0;
  for (const p of processed) {
    // ★ v0.9.124：写回前在 Layout 分支已经算过一次（块内容要用同一份），有缓存就复用
    const composed = p.__composed || composePrompt(p, cfg);
    const { prompt, negative, nl } = composed;
    /**
     * ★ v0.9.121：空 prompt 必须在这里拦住。
     *   唯一会产出空 prompt 的是 Layout 输出（坐标编译失败 —— 归一化坐标 / 零面积框 /
     *   越界到无法夹回）。空 prompt 提交给 ComfyUI 会出一张完全随机的图，
     *   比不出图更难判断问题在哪。原因已由 composePrompt 写进警告日志。
     */
    if (!String(prompt || '').trim()) {
      warn(STAGE.BACKEND, `${p.position}：提示词为空（Layout 编译失败，详见上一条警告），跳过这张不出图`);
      continue;
    }
    /**
     * ★★★ v0.9.122：Layout 口径下 `p.tag` 是空的（`processImage` 短路时直接给 ''），
     *   在这里回填成**最终 prompt**。三个后果都是实测/代码可证的：
     *   ① `saveFloorResult` 用 `hash32(tag)` 认「同一个出图位」——
     *      空 tag ⇒ 同楼每张图的 hash 全等 ⇒ 第二张把第一张原地顶掉
     *      （store.js `findIndex(x => x.hash === result.hash)`），用户看到「出了 4 张只留 1 张」。
     *   ② 正文块 `<hl_image pos="P3">…</hl_image>` 内容为空 ⇒ 块的 hash 也全等，
     *      无 pos 的老块只能靠 hash 找回身份（render.js `known.find`）→ 必然认错。
     *   ③ 灯箱「查看提示词」应该看到真正送进模型的 JSON，而不是空白。
     * ★ 用 `tidySeparators` 过一遍是**必须的**：块解析侧（`parseTags`）会对块内容
     *   跑同一个函数再算 hash，两边不过同一道工序就对不上（实测已验：对成熟 JSON 幂等）。
     */
    if (!String(p.tag || '').trim() && activeOutput() !== 'text') {
      p.tag = tidySeparators(prompt);
    }
    step(taskId, STAGE.BACKEND, `提交 ${p.position}（${meta.short}）：${prompt.slice(0, 60)}${prompt.length > 60 ? '…' : ''}`);
    // SD 助手式气泡：这张图正在出
    notifyInfo(`正在调用 API 生图 · ${p.position}`, `${meta.name} · 生成中，请稍候`);
    const reqT0 = Date.now();

    // 登记"生图中"并立刻重绘：正文里的占位框变成带计时的生中卡片
    const { markGenerating, clearGenerating, render: renderNow } = await import('./render.js');
    markGenerating(mesId, swipeId, p.position);
    renderNow(mesId);

    let res;
    try {
      res = await submitToBackend({
        cfg, taskId, label: p.position, prompt, negative, nl,
      });
    } catch (err) {
      // 后端抛异常按失败处理，不能把"生图中"卡片挂死在正文里
      // errorBrief 把堆栈前几帧带上 —— 错误框 hover 就能看到是哪个文件抛的
      res = { ok: false, error: errorBrief(err), images: [], elapsed: 0 };
    } finally {
      clearGenerating(mesId, swipeId, p.position);
    }

    // 归档：把图搬到酒馆自己的 user/images/ 下。
    // ComfyUI 的 /view 是临时地址（重启/清 history 就 404），不落地的话
    // 存档过几天就满屏破图。归档失败不影响出图 —— 退回临时地址继续。
    let imgs = res.images || [];
    const wantArchive = cfg.storage ? cfg.storage.archive !== false : true;
    if (res.ok && imgs.length && wantArchive) {
      imgs = await archiveImages(imgs, {
        charName: getCharName(),
        position: p.position,
        promptHash: hash32(p.tag),
      });
    }

    saveFloorResult(mesId, swipeId, {
      hash: hash32(p.tag),
      position: p.position,
      prompt: p.tag,
      // promptFull = composePrompt 拼装后的最终文本（K2 下是五段三明治全文）。
      // 「查看提示词」/灯箱优先显示它 —— 你看到的就是真正送进模型的；
      // prompt 保留英文段原文，供重生成时重组结构（不能存最终文本，否则重生成会套娃）。
      promptFull: prompt,
      /**
       * ★★★ v0.9.123：Layout 的**草稿**必须一起落库。
       *
       * 病例（用户 2026-10-21）：「MOSS 模式下点重新生成，结果完全变成另外的图了，
       * 和原来没关系了，丢掉了很多东西。」
       * 根因：`regenerate` 里读 `prev.layoutJson`，但落库从来没写这个字段 →
       *   `compileLayout(null)` 必然失败 → 返回空 prompt → 空提示词照样提交给 ComfyUI
       *   → 模型按空提示词自由发挥 = 完全另一张图。
       * 草稿（左上原点 + xyxy + 真实尺寸）能无损重编译；编译后的成稿
       * （中心化 + yxyx、不带尺寸）丢了画布信息，重编译要靠猜 —— 所以存草稿，不存成稿。
       */
      layoutJson: (p.layoutJson && typeof p.layoutJson === 'object') ? p.layoutJson : null,
      negative,
      nl: p.nl,
      // K2 v4 三明治字段：重生成时据此重组完整结构（scene/mood/cast 缺省时按旧协议兜底）
      scene: p.scene || '',
      mood: p.mood || '',
      cast: p.cast || '',
      // v0.9.53：服装段（仅开了「服装独立成段」才有内容）—— 重生成时据此重组
      costume: p.costume || '',
      // v0.9.90：角色名 → 本次拼进画面的锚点串（SD「按档案重新生成」靠它精确定位旧串）
      anchors: Array.isArray(p.anchorList) ? p.anchorList : [],
      notes: p.notes,
      images: imgs,
      error: res.ok ? undefined : res.error,
      elapsed: res.elapsed,
      at: Date.now(),
    });

    if (res.ok) {
      done += 1;
      // 全局出图历史（v0.9.13）：历史生图页 + 灯箱参数面板的数据源。
      // 每张图记一条 —— 同参数不同 URL，灯箱按 URL 查参数。
      const beCfg = cfg?.backends?.[backendKey] || {};
      for (const im of (Array.isArray(imgs) ? imgs : [])) {
        try {
          pushHistory({
            url: im.localUrl || im.url || '',
            path: im.path || im.localUrl || '',
            prompt,
            nl,
            negative,
            backend: backendKey,
            model: beCfg.model || '',
            loras: Array.isArray(res.loras) ? res.loras : [],
            seed: res.seed ?? '',
            charName: getCharName() || '',
            chatId: getChatIdSafe(),
            mesId,
            position: p.position,
            at: Date.now(),
          });
        } catch { /* 历史记录失败不影响出图 */ }
      }
      // SD 助手式气泡：成功 → 插了几张、耗时多少
      const n = Array.isArray(imgs) ? imgs.length : 0;
      notifySuccess(
        `已插图 ${n} 张 · ${p.position}`,
        `楼层 #${mesId} · 耗时 ${(res.elapsed ?? 0).toFixed ? res.elapsed.toFixed(1) : res.elapsed}s`,
      );
    } else {
      // 失败 → 原因首句直接进气泡（完整堆栈在诊断页请求历史里）
      notifyError(`${p.position} 生图失败`, failureText(res.error));
    }

    // 落一条请求历史（诊断页的「请求历史」卡片，成功失败都记）
    logRequest({
      mesId,
      position: p.position,
      backend: backendKey,
      model: cfg?.backends?.[backendKey]?.model || '',
      prompt,
      nl,
      negative,
      ok: !!res.ok,
      error: res.error || '',
      errStack: res.errStack || '',
      durationMs: Date.now() - reqT0,
      images: Array.isArray(imgs) ? imgs.length : 0,
      structure: composed.structure,
    });

    // 出图结束（成功或失败）都撤销"生图中"，再就地刷新
    clearGenerating(mesId, swipeId, p.position);
    // 每出一张就地刷新 —— 用户能一张张看到图顶进段落，而不是等全部跑完
    renderFloor(mesId);
  }

  if (done === processed.length) {
    info(STAGE.BACKEND, `全部 ${done} 张图生成完成`);
    notifySuccess(`本楼插图完成 · ${done}/${processed.length} 张`, `楼层成功出图，正文里已就位`);
  } else {
    warn(STAGE.BACKEND, `${processed.length - done}/${processed.length} 张图失败，详见诊断`);
    notifyError(
      `本楼 ${processed.length - done}/${processed.length} 张图失败`,
      '打开绘灵 → 诊断页查看失败原因',
    );
  }
}

/* ============ 建档 ============ */

function parseProfileOutput(raw) {
  const cleaned = String(raw || '').replace(/<(think|thinking)\b[\s\S]*?<\/\1>/gi, '').trim();
  const candidates = [];
  for (const m of cleaned.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) candidates.push(m[1].trim());
  candidates.push(cleaned);

  for (const c of candidates) {
    const s = c.indexOf('{');
    const e = c.lastIndexOf('}');
    if (s < 0 || e <= s) continue;
    try {
      const v = JSON.parse(c.slice(s, e + 1));
      if (Array.isArray(v.characters)) {
        return v.characters
          .map(x => ({
            name: String(x?.name || '').trim(),
            label: String(x?.label || '').trim(),
            // 建档也过一遍归一化：模型爱把眼镜塞进 face、瞳色塞进 hair（实测）
            fields: normalizeAnchorFields((x?.fields && typeof x.fields === 'object') ? x.fields : {}).fields,
          }))
          .filter(x => x.name);
      }
    } catch { /* 下一个候选 */ }
  }
  return [];
}

/**
 * ★ 有效外貌判定（建档过滤口径，v0.9.43 定稿）：
 * hair/eyes/face/skin/body/mark/nlProfile 任一非空才算「有外貌」。
 * sex 单独存在**不算** —— k2AnchorParts 只拼上面这些，自愈候选也要求 hair+eyes 或
 * nlProfile，只有 sex 的条目哪条路都走不通，建了纯粹占档案数。
 */
const LOOK_FIELDS = ['hair', 'eyes', 'face', 'skin', 'body', 'mark', 'nlProfile'];
const hasLookFields = (fields) => LOOK_FIELDS.some(k => String(fields?.[k] || '').trim().length > 0);

/** 把建档结果落库（含垃圾过滤），返回 {saved, skipped}。 */
function persistProfiles(chars, { requireName }) {
  const saved = [];
  const skipped = [];
  for (const c of chars || []) {
    const nm = String(c.name || '').trim();
    const fields = c.fields || {};
    if (!nm || !hasLookFields(fields) || (requireName && nm !== requireName)) {
      skipped.push(nm || '(空名)');
      continue;
    }
    upsertEntry(nm, { fields, label: c.label, source: 'scan' }, {});
    saved.push(nm);
  }
  return { saved, skipped };
}

/**
 * 从角色卡 + 世界书 + persona 建档。首次使用或换卡后跑一次。
 *
 * ★ v0.9.44 起**分两步走**（用户点破的根因链：主角 = 酒馆 persona 的绝对主角，
 * 跟世界书群像是两回事，混在一次请求里 persona 段必被淹没）：
 *   ① 主角独立建档 —— 只喂 persona，name 钉死为 userName，谁也冲不掉他；
 *   ② 群像建档 —— 只喂角色卡 + 世界书（prompt 里明确「persona 主角单独建档，这里不要输出他」）。
 * 两次请求各自过滤垃圾条目（空名 / 无外貌字段）。
 *
 * @returns {{ok:boolean, count:number, reason?:string}}
 */
export async function scanProfile() {
  const taskId = beginTask('角色建档');
  const charName = getCharName();
  if (!charName) {
    failTask(taskId, STAGE.INIT, '没有检测到当前角色卡', {
      cause: '酒馆里还没有打开任何角色',
      fix: '先打开一个角色卡再建档',
    });
    return { ok: false, count: 0, reason: '未检测到角色卡' };
  }

  try {
    const userName = String(getUserName() || '').trim();
    const persona = String(getPersonaDescription() || '').trim();
    const allSaved = [];
    const allSkipped = [];

    /* ── ① 主角独立建档（persona 里有内容才跑；没有就跳过，不脑补） ── */
    if (userName && persona) {
      const raw = await callAnalyzeLLM(buildUserProfileScanMessages({
        userName, persona, charName,
      }), { taskId, source: '主角建档', maxTokens: 2048, temperature: 0.3 });

      const chars = parseProfileOutput(raw);
      // requireName：钉死名字 —— 模型输出别的名字一律不收（防止 <user> 之类的占位符条目混进来）
      const { saved, skipped } = persistProfiles(chars, { requireName: userName });
      allSaved.push(...saved);
      allSkipped.push(...skipped);
      step(taskId, STAGE.CONSISTENCY, `主角建档：${saved.length ? `「${saved[0]}」已入库` : 'persona 里没有外貌描写，跳过（不脑补）'}`);
    } else if (userName && !persona) {
      step(taskId, STAGE.CONSISTENCY, `主角建档跳过：用户设定（persona）为空 —— 到酒馆「用户设定管理」里选一个 persona 再扫`);
    }

    /* ── ② 群像建档（角色卡 + 世界书；persona 不进这份请求） ── */
    const raw = await callAnalyzeLLM(buildProfileScanMessages({
      charName,
      description: getCharDescription(),
      worldBook: getCharWorldBookText(),
      persona: '',
      userDesc: '',
    }), { taskId, source: '角色建档', maxTokens: 8192, temperature: 0.3 });

    if (!raw?.trim()) {
      failTask(taskId, STAGE.API, '建档请求返回空', {
        cause: '模型没回包',
        fix: '先在酒馆里正常聊一句确认主 API 可用',
      });
      return { ok: false, count: allSaved.length, reason: '模型返回空' };
    }

    const chars = parseProfileOutput(raw);
    if (!chars.length && !allSaved.length) {
      failTask(taskId, STAGE.PROTOCOL, '建档输出里没有解析到任何角色', {
        cause: '模型没有按 JSON 协议输出，或角色卡里确实没有外貌描写',
        fix: '换一个指令遵循更好的模型；或到「角色档案」页手动新建条目',
      }, String(raw).slice(0, 600));
      return { ok: false, count: 0, reason: '解析失败' };
    }

    const { saved, skipped } = persistProfiles(chars, {});
    allSaved.push(...saved);
    allSkipped.push(...skipped);

    endTask(taskId, `建档完成：${allSaved.length} 个角色（${allSaved.join('、')}）`
      + (allSkipped.length ? `；已跳过 ${allSkipped.length} 条空档案（${allSkipped.join('、')}）` : ''));
    return { ok: true, count: allSaved.length };
  } catch (err) {
    failTask(taskId, STAGE.INIT, `建档异常：${err?.message || err}`, {
      cause: '未预期错误',
      fix: '导出诊断报告排查',
    }, err?.stack);
    return { ok: false, count: 0, reason: err?.message };
  }
}
