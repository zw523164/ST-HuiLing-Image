/**
 * 绘灵 · 正文渲染
 *
 * ── 协议 ───────────────────────────────────────────────
 * 正文里存的出图位：<hl_image>tag 部分<nl>自然语言部分</nl></hl_image>
 *
 * ── 两条正则，分工明确 ──────────────────────────────────
 *   ① huilin-show-image-slots（显示侧 markdownOnly）
 *      把 <hl_image>…</hl_image> 换成占位符 ⟦HLI⟧
 *      —— 留一个「槽」在段落里，渲染层再把这个槽换成真图
 *   ② huilin-hide-image-tags（提示词侧 promptOnly）
 *      把整块删成空串，保证发给主模型的上下文里没有这堆 tag
 *
 * 为什么必须分两条：酒馆的正则对象只有一对 find/replace，
 * 显示要用占位符、提示词要用空串，同一个 replaceString 做不到两件事。
 *
 * ── 为什么不用 HTML 标签做占位 ──────────────────────────
 * messageFormatting 在跑完正则之后还有两步：
 *   encode_tags 会把所有 '<' 转义，然后 showdown 做 markdown 转换。
 *   所以正则吐出的任何 HTML 都会被吃掉。占位符必须是无 '<' 的纯文本。
 *
 * ── 为什么渲染要幂等 ────────────────────────────────────
 * 渲染 = 把占位符文本节点换成图片元素。若不做还原就直接重跑，
 * 第二遍找不到占位符（已被换掉了），图会凭空消失。
 * 所以每次渲染先把图片元素**还原成占位符文本**，再重新解析 —— 幂等。
 *
 * ── 踩过的坑 ────────────────────────────────────────────
 * 隐形字符锚点（U+2063/U+2064 那套）会被别的插件「显示边界清理」正则吃掉，
 * 且静默失效不报错 —— 已付过代价。可见标签正则托管，互不干扰，用户还能直接编辑。
 */

import {
  getCtx, getMessage, getMessageText, setMessageText, getCharName,
  refreshMessageBlock, onEvent, getEventTypes, isGeneratingNow,
} from './st.js';
import { getConfig, saveSettings, activeEngine, getActiveTemplate, activeOutput } from './settings.js';
import { getFloorRecord, saveFloorResult, setResultScale, setResultIndex, setResultPrompt, removeFloorResult, removeResultImage, buildLibrarySnapshot } from './store.js';
import { logRequest } from './log.js';
import { downloadImage, deleteImage, archiveImages } from './archive.js';
import { composePrompt, refreshAnchorsInPrompt, refreshCastFromLibrary, mossCastParagraph, effectiveOf } from './consistency.js';
import { activePersona } from './persona.js';
import { buildLayoutEditor } from './ui/promptlayout.js';
import { hash32, tidySeparators, positionToLineIndex, indexParagraphs, cleanBodyLines, cleanBody, bodyFingerprint, HL_TAG_RE, HL_TAG_REGEX_SRC, errorBrief } from './util.js';
import { info, warn, debug, STAGE } from './log.js';

/* ============ 常量 ============ */

/** 显示侧的槽占位符。刻意用无 '<' 的字符，避开 encode_tags。 */
export const PLACEHOLDER = '⟦HLI⟧';

/** 提示词侧：整块删空。保留旧 ID，兼容早期注册过的残留规则。 */
export const RULE_PROMPT_ID = 'huilin-hide-image-tags';
/** 显示侧：换成占位符。 */
export const RULE_SHOW_ID = 'huilin-show-image-slots';

/**
 * 「正文美化吞槽」搬运规则（v0.9.76 引入，v0.9.77 起默认关）。
 *
 * 病例背景：创世回廊等把正文包在 <now_plot> 块里的卡，卡自带美化正则替换整块。
 * v0.9.77 实测修正：该卡美化 findRegex 实际是 `/<now_plot>([\s\S]*)<\/now_plot>/gi`
 * 且替换串用 $1 回注内容 —— 槽随内容进美化卡片内部，**不吞**，且图正好内联在
 * 剧情对应位置（用户期望的形态）。搬运反而把图全堆到楼层顶部。
 *
 * 因此搬运改为 opt-in：config.moveSlotsOutOfNowPlot === true 才注册；
 * 默认关，且启动时清掉 0.9.76 遗留的已持久化搬运规则（回到内联）。
 * 只有遇到真·整块替换（无 $1 回注）的美化卡才需要打开。
 *
 * 细节（开着时生效）：
 * - 正则不带 /g，每条脚本只搬一个槽 → 条数必须 ≥ maxImagesPerFloor，调高要同步加。
 * - 顺序无关：槽已成 ⟦HLI⟧ 时第二分支照样命中。
 * - 对不含 <now_plot> 的消息零匹配；不进提示词（markdownOnly）。
 * - 替换串槽后必须带空行：美化模板替换串多以 ``` fence 开头，粘行会破坏
 *   fence 配对 → 美化页变源码（2026-10-09 创世回廊实测）。
 */
export const RULE_MOVE_IDS = ['huilin-nowplot-slot-move-1', 'huilin-nowplot-slot-move-2'];
const MOVE_FIND_REGEX = '/(<now_plot>)([\\s\\S]*?)(<hl_image[^>]*>[\\s\\S]*?<\\/hl_image>|⟦HLI⟧)/';
// ★ 替换串里槽后必须带空行：很多美化模板的替换串以 markdown code fence（```）开头，
//   若槽直接粘在 fence 前（同一行/无空行），fence 配对被破坏 → 整个美化模板退化成
//   <code> 源码文本、iframe 消失、图也不渲染（2026-10-09 创世回廊实测）。
const MOVE_REPLACE = '$3\n\n$1$2';

/* ============ 解析 ============ */

/**
 * 从文本里解析出所有 tag 块（按正文出现顺序）。
 *
 * v0.7 起块带 pos 属性（<hl_image pos="P3">）—— 块自带身份，
 * 渲染层靠它和楼层记录做**身份配对**，而不是按数组顺序配对。
 * 旧块没有 pos 时 pos 为空串，由 bindBlocksToResults 按 hash 兜底找回身份。
 * v0.9.24：标签名放宽到 hl[_-]image —— 主模型常把下划线写成连字符，
 * 不放宽的话这类"伪块"解析不出来，历史楼层的图就配不上对（刷出来是空的）。
 */
export function parseTags(text) {
  const out = [];
  const re = /<hl[_-]image([^>]*)>([\s\S]*?)<\/hl[_-]image\s*>/gi;
  let m;
  while ((m = re.exec(String(text || ''))) !== null) {
    const attrs = m[1] || '';
    const inner = m[2];
    const posAttr = (/\bpos\s*=\s*["']?([^"'\s>]+)/i.exec(attrs) || [])[1] || '';
    const nlMatch = /<nl>([\s\S]*?)<\/nl>/i.exec(inner);
    const nl = nlMatch ? nlMatch[1].trim() : '';
    const tag = tidySeparators(inner.replace(/<nl>[\s\S]*?<\/nl>/gi, '').replace(/<\/?tag>/gi, ''));
    out.push({
      raw: m[0],
      pos: String(posAttr).toUpperCase(),
      tag,
      nl,
      start: m.index,
      end: m.index + m[0].length,
      hash: hash32(tag),
    });
  }
  return out;
}

/** 组装一个 tag 块。position 写进 pos 属性 —— 块的身份标记，渲染配对靠它。 */
export function buildTagBlock(position, tag, nl) {
  const t = tidySeparators(tag);
  const n = String(nl || '').trim();
  const pos = String(position || '').trim().toUpperCase();
  const open = pos ? `<hl_image pos="${pos}">` : '<hl_image>';
  if (!n) return `${open}${t}</hl_image>`;
  return `${open}${t}<nl>${n}</nl></hl_image>`;
}

/** 去掉正文里所有 tag 块（得到纯剧情文本）。 */
export function stripTags(text) {
  return String(text || '').replace(HL_TAG_RE, '').replace(/\n{3,}/g, '\n\n').trim();
}

/* ============ 插入 ============ */

/** 位置 ID（P3）→ 原始物理行号；找不到返回 -1。
 *
 * ★ v0.9.144：**直接复用 util 的实现**，不再本地重写一遍。
 *   编号坐标系从"第 n 个非空行"改成了"第 n 个叙事行"（剥掉卡牌施工数据），
 *   两处各自维护必然漂移 —— 一旦漂移，图就插到 `<draft>` / `[Opt1]` 后面。
 */
function positionLineIndex(body, position) {
  return positionToLineIndex(body, position);
}

/**
 * 把处理好的图片插进正文；已有旧块**原位保留**（不再整体搬到末尾）。
 *
 * 为什么必须原位保留：旧做法把已有 tag 追加到正文末尾"避免吃掉"，
 * 但这些沉底的块照样占渲染槽位，新块插在段落位置 —— 槽位顺序和结果顺序从此对不上，
 * 图会整体错位一格（实测：天台楼层显示上一轮的体育馆图）。
 * 现在旧块由调用方解析出身份（position）后经 opts.keep 传回来，按身份插回原段落；
 * 找回不了位置的旧块才追加到末尾。
 *
 * @param {string} original 原始正文（含可能已有的旧 tag 块）
 * @param {Array} images    [{ position, tag, nl }] 本次要写的新图
 * @param {object} [opts]   { keep: [{ position, raw }], lineOverride }
 *   keep         要原位保留的旧块
 *   lineOverride { P3: 12, ... } 段落锚定重定位给出的物理行号（v0.9.34）——
 *                正文在分析期间被脚本改过时，P 编号按内容重新落位；给了就优先用它
 * @returns {{text:string, inserted:number, missed:string[]}}
 */
export function insertImages(original, images, opts = {}) {
  // ★ v0.9.3 重写：输出 = 原文 + 插入的出图块，其余内容一字不动（最小侵入）。
  //
  // 旧实现拿 cleanBodyLines 清洗后的文本当底稿重建整段 —— 所有被清洗的
  // 结构块（<choice> 剧情选项、<details>/<summary>、状态栏、思考块…）重建后
  // 全变空行，等于把酒馆预设的渲染产物从正文里物理删除（实测吞了用户的
  // 剧情选项和变量块）；正文指纹随之变化 → 扫描器误判「内容又变了」
  // → 清标记重扫 → 无限循环分析生图（页面卡死的根因之一）。
  //
  // 行号坐标系仍然用 cleanBodyLines（和模型看到的 P 编号同一套，且它只置空
  // 不删行，行数与原文严格一致），但拼接底稿换成「旧块置空后的原文行」——
  // 插入是纯 splice，别的行原样保留。
  const src = String(original || '');
  // 旧 hl 块等量换成换行（行数不变，编号不漂移），内容稍后按身份插回
  const blanked = src.replace(HL_TAG_RE, (m) => '\n'.repeat((m.match(/\n/g) || []).length));
  const clean = cleanBodyLines(blanked);
  const baseLines = blanked.split('\n');

  // 行号定位：锚定重定位的映射优先（正文被脚本改过时，P 编号按内容重新落位）
  const override = (opts.lineOverride && typeof opts.lineOverride === 'object') ? opts.lineOverride : null;
  const locate = (position) => {
    const p = String(position || '').trim().toUpperCase();
    if (override && Object.prototype.hasOwnProperty.call(override, p)) return override[p];
    return positionLineIndex(clean, p);
  };

  const plan = [];
  const missed = [];
  for (const img of images) {
    const idx = locate(img.position);
    if (idx < 0) { missed.push(img.position); continue; }
    plan.push({ idx, block: buildTagBlock(img.position, img.tag, img.nl) });
  }

  // 旧块按身份插回原段落；段落已不存在（正文被改）的沉底，不占段落槽
  const tail = [];
  for (const k of (Array.isArray(opts.keep) ? opts.keep : [])) {
    const pos = String(k?.position || '').toUpperCase();
    const idx = pos ? locate(pos) : -1;
    if (idx < 0) { tail.push(String(k.raw || '')); continue; }
    plan.push({ idx, block: String(k.raw || '') });
  }

  if (!plan.length) {
    let text = original;
    if (tail.length) text = `${original}\n\n${tail.join('\n')}`;
    return { text, inserted: 0, missed };
  }

  // 同位置多块保持稳定顺序；再按行号倒序插入
  plan.sort((a, b) => a.idx - b.idx);
  const merged = [];
  for (const p of plan) {
    const last = merged[merged.length - 1];
    if (last && last.idx === p.idx) last.blocks.push(p.block);
    else merged.push({ idx: p.idx, blocks: [p.block] });
  }

  const lines = baseLines.slice();
  for (let i = merged.length - 1; i >= 0; i -= 1) {
    const item = merged[i];
    // 注意：不插空行分隔 —— 块洗掉后正文必须与原文逐行一致（指纹不变），
    // 否则扫描器会误判"内容又变了"再跑一轮全量分析
    lines.splice(item.idx + 1, 0, ...item.blocks);
  }

  let out = lines.join('\n');
  if (tail.length) out += `\n\n${tail.join('\n')}`;
  return { text: out, inserted: plan.length, missed };
}

/**
 * 段落内容锚定：把「触发分析时正文」的每个非空段落，按**内容**在当前正文里重新定位。
 *
 * 背景（2026-09-28 v0.9.34）：17/19 楼生图全部「失败于写回正文」、手动重跑也必失败。
 * 根因：这个聊天里有词表/变量脚本会在分析期间改正文（诊断日志里的「应用词表变化」
 * 就是它打的）—— 出词要跑几十秒，脚本一改，指纹（前200字+总长）必变，旧逻辑
 * 一刀切放弃。指纹防的是「行号坐标系失效导致错位覆盖」，但「往尾部加状态行 /
 * 刷新面板」这类变化**根本不动剧情段落**，行号语义（P3=第3个非空行）甚至没漂 ——
 * 放弃纯属误杀。
 *
 * 所以 stale 时改走这里：旧正文的非空行序列若能按**原顺序**在新正文里逐行找到
 * （= 旧内容只增不改），就拿到每个 P_n 的新物理行号，安全写入；
 * 有任何一行找不到（段落被删/被改写）→ 才是真正的危险变化，放弃。
 *
 * @returns {{ok:boolean, lineOverride:Object<string,number>, oldCount:number}}
 *   lineOverride: 'P3' -> 当前正文（cleanBodyLines 坐标系）里的物理行号
 */
function remapByAnchor(oldBody, current) {
  /**
   * ★ v0.9.144：用 `indexParagraphs` 取行 —— 它就是 `renderIndexed` 打 P 编号用的那份，
   *   保证「模型写的 Pn」和「这里重定位的 Pn」是同一个东西。
   */
  const rows = (text) => {
    const src = cleanBodyLines(text);
    const out = [];
    indexParagraphs(src).forEach((p, i) => { if (p && p.id) out.push({ i, text: p.text }); });
    return out;
  };
  const oldR = rows(cleanBodyLines(oldBody));
  const newR = rows(cleanBodyLines(current));
  const lineOverride = {};
  let j = 0;
  for (let k = 0; k < oldR.length; k += 1) {
    // 贪心按序匹配：跳过新正文里多出来的行（脚本加的状态行/后缀），找旧段落的落点
    while (j < newR.length && newR[j].text !== oldR[k].text) j += 1;
    if (j >= newR.length) return { ok: false, lineOverride: {}, oldCount: oldR.length };
    lineOverride[`P${k + 1}`] = newR[j].i;
    j += 1;
  }
  return { ok: true, lineOverride, oldCount: oldR.length };
}

/**
 * 端到端：把图片写进楼层正文。
 *
 * 写之前先给正文里的旧块"验明正身"：
 *   有身份（pos 属性 / 能按 hash 在楼层记录里找回 position）且本次不重写该位置 → 原位保留；
 *   该位置本次有新图 → 旧块让位（被新块替换）；
 *   身份都找不回来的旧块 → 丢弃（孤儿；文件还在图库里，不丢数据）。
 *
 * @param {object} [opts] { expectedFp, expectedBody, keep }
 *   expectedFp   触发分析时的正文指纹 —— 不匹配时先尝试按段落内容重定位（见
 *                remapByAnchor），段落结构真变了才放弃。**要生效必须同时传 expectedBody**。
 *   expectedBody 触发分析时的正文原文（pipeline 的 body 入参），锚定重定位的基准。
 * @returns {{ok:boolean, written:string[], missed:string[]}}
 */
export function writeImagesToFloor(mesId, images, opts = {}) {
  const id = Number(mesId);
  const current = getMessageText(id);
  let lineOverride = null;

  const fpNow = opts.expectedFp ? bodyFingerprint(cleanBody(current)) : '';
  const fpChanged = Boolean(opts.expectedFp) && fpNow !== opts.expectedFp;

  // ★ 分析期间正文变了 → 行号坐标系可能失效，写回可能错位/覆盖新内容。
  //   指纹不一致时先做「段落内容锚定」重定位（v0.9.34）：旧段落都能按内容
  //   按序找回 → 行号映射重建，安全写入（词表/状态栏类脚本只加行不改段落，
  //   以前被一刀切放弃，17/19 楼连手动重跑都必失败就是这个原因）；
  //   找不回 → 真正的危险变化（段落被删/重排），维持放弃。
  //
  // ★★ v0.9.106：**指纹没变时也要算一次重定位**。原因是两套行号坐标系不一致：
  //   模型看到的 P 号基于 `cleanBody(正文)` —— 带 <content> 的楼层只取容器内部；
  //   而 insertImages 定位用的是 `cleanBodyLines(整篇)` 的物理行号。正文里有
  //   <time> 之类前置块时两者差好几行（实测 #40：模型的 P1 是整篇第 7 行），
  //   图会被插到 <time> 上。重定位映射正好就是「P 号 → 真实物理行」，用它对齐。
  //   指纹没变时重定位失败不致命（退回 P 号直接定位，与旧版一致）；
  //   指纹变了且重定位失败才是真危险（段落被删/重排），维持放弃。
  if (opts.expectedBody) {
    const remap = remapByAnchor(opts.expectedBody, current);
    if (remap.ok) {
      lineOverride = remap.lineOverride;
      if (fpChanged) {
        warn(STAGE.RENDER,
          `楼层 #${id} 正文在分析期间被其它脚本改过（词表/状态栏类），剧情段落未变，已按段落内容重新定位写入`);
      }
    } else if (fpChanged) {
      warn(STAGE.RENDER,
        `楼层 #${id} 正文在分析期间已被改写且段落对不上（可能被重生成/编辑），放弃写入（避免基于旧正文错位覆盖）`);
      return { ok: false, written: [], missed: [], stale: true, why: 'stale' };
    }
  } else if (fpChanged) {
    warn(STAGE.RENDER, `楼层 #${id} 正文在分析期间已变化，放弃写入（避免基于旧正文错位覆盖）`);
    return { ok: false, written: [], missed: [], stale: true, why: 'stale' };
  }

  const replacing = new Set(images.map(i => String(i.position).toUpperCase()));

  // 旧块验明正身：pos 属性优先，没有就按 hash 在楼层记录里找回 position
  const rec = getFloorRecord(id, swipeIdOf(id));
  const known = (Array.isArray(rec?.results) ? rec.results : [])
    .map(r => ({ hash: r?.hash || '', position: String(r?.position || '').toUpperCase() }));
  const keep = [];
  let dropped = 0;
  let emptyShells = 0;
  for (const b of parseTags(current)) {
    /**
     * ★★★ v0.9.124：**内容为空的块是坏壳，必须丢掉**。
     *
     * 实测（楼层 #160，2026-10-21）：正文里 6 个块，`内容长度全是 0`
     * （`<hl_image pos="P4"></hl_image>`）。成因见 pipeline 里那段注释 ——
     * Layout 的 `p.tag` 在写回之后才回填。渲染侧按块内容算 hash 去配图，
     * 空壳 hash 全等且匹配不到任何记录 ⇒ 出图位立着但**一个图都不显示**。
     * 现在写回前就填好了；已经落盘的坏壳在这里顺手清掉（它不含任何信息）。
     */
    if (!String(b.tag || '').trim()) { emptyShells += 1; continue; }
    let pos = b.pos;
    if (!pos) {
      const hit = known.find(k => k.hash && k.hash === b.hash);
      pos = hit?.position || '';
    }
    if (!pos) { dropped += 1; continue; }          // 找不回身份 → 孤儿，丢弃
    if (replacing.has(pos)) continue;               // 该位置本次重写 → 旧块让位
    keep.push({ position: pos, raw: b.raw });
  }
  if (emptyShells) warn(STAGE.RENDER, `楼层 #${id} 清掉 ${emptyShells} 个空出图块（内容是空的，配不到图）`);
  if (dropped) warn(STAGE.RENDER, `楼层 #${id} 有 ${dropped} 个旧出图位找不到身份，已丢弃（图仍在图库）`);

  const res = insertImages(current, images, { keep, lineOverride });
  if (!res.inserted) {
    warn(STAGE.RENDER, `楼层 #${id} 没有插入任何出图位（${res.missed.join('/') || '位置缺失'}）`);
    return { ok: false, written: [], missed: res.missed, why: 'insert' };
  }
  /**
   * ★★ v0.9.106：并发保护的前缀必须取**原始正文** `current`。
   *
   *   旧代码用的是 `stripTags(current).slice(0,30)`（已经把 <hl_image> 块删掉、
   *   还把连续空行折叠过），却拿它去和原始 `current` 做 startsWith —— 只要 hl 块
   *   落在正文前 30 字内，这个比较必然为假 → setMessageText 判定「内容已变化」
   *   拒绝写入 → 整条重跑死在写回这一步（UI 报「正文写入被跳过」）。
   *
   *   实测 #40（2026-10-19）：模型把 <hl_image> 写进了 <time> 块第 2 行，
   *     expectPrefix = `<time>\n\n```体育馆旧器材室…`
   *     current      = `<time>\n<hl_image pos="P1">anal…`
   *     startsWith → false（哪怕在这一刻根本没人动过正文）
   *   这也是「删了图重跑还是没用」的原因：删图只改 hl 块内容，前缀照样对不上。
   *
   *   并发保护的语义是「确认这楼在这段时间没被别人改」，用原始正文前缀完全等价，
   *   而且比清洗后前缀更严格。
   */
  const expectPrefix = current.slice(0, 30);
  const ok = setMessageText(id, res.text, expectPrefix);
  if (ok) {
    const missedNote = res.missed.length ? `，${res.missed.length} 个位置没写进（${res.missed.join('/')}）` : '';
    info(STAGE.RENDER, `楼层 #${id} 已插入 ${res.inserted} 个出图位${missedNote}`);
  }
  return {
    ok,
    written: ok ? images.map(i => String(i.position).toUpperCase()).filter(p => !res.missed.includes(p)) : [],
    missed: res.missed,
    why: ok ? '' : 'prefix',
    inserted: res.inserted,
  };
}

/* ============ 正则（两条） ============ */

function baseRule() {
  return {
    scriptName: '绘灵',
    // 兼容三种块：<hl_image>…（旧）、<hl_image pos="P3">…（v0.7+，块带身份）、
    // <hl-image>…（v0.9.24，主模型把下划线写成连字符的伪块）
    findRegex: HL_TAG_REGEX_SRC,
    replaceString: '',
    trimStrings: [],
    placement: [1, 2],
    disabled: false,
    markdownOnly: false,
    promptOnly: false,
    runOnEdit: true,
    substituteRegex: 0,
    minDepth: null,
    maxDepth: null,
  };
}

/** 幂等注册两条正则；绝不动用户的其它正则。 */
export function registerRegex() {
  try {
    const ctx = getCtx();
    const es = ctx.extensionSettings;
    if (!es) return false;
    if (!Array.isArray(es.regex)) es.regex = [];

    // v0.9.77：搬运规则 opt-in（默认关 → 图内联在正文原位）。关时顺手清掉
    // 0.9.76 遗留的持久化规则，否则它们留在 settings.json 里继续把图搬到顶部。
    const moveOn = getConfig().moveSlotsOutOfNowPlot === true;
    const rules = [
      // 显示侧：留一个槽
      { ...baseRule(), id: RULE_SHOW_ID, replaceString: PLACEHOLDER, markdownOnly: true, promptOnly: false },
      // 提示词侧：删干净
      { ...baseRule(), id: RULE_PROMPT_ID, replaceString: '', markdownOnly: false, promptOnly: true },
    ];
    if (moveOn) {
      // 「正文美化吞槽」搬运：槽在 <now_plot> 块内时搬到块外（见 RULE_MOVE_IDS 注释）
      rules.push(...RULE_MOVE_IDS.map((id, i) => ({
        ...baseRule(),
        id,
        scriptName: `绘灵·图位外移${i + 1}`,
        findRegex: MOVE_FIND_REGEX,
        replaceString: MOVE_REPLACE,
        markdownOnly: true,
        promptOnly: false,
      })));
    }

    let added = 0;
    let removedMoves = 0;
    for (const rule of rules) {
      const idx = es.regex.findIndex(r => r.id === rule.id);
      if (idx >= 0) es.regex[idx] = { ...es.regex[idx], ...rule };
      else { es.regex.push(rule); added += 1; }
    }
    if (!moveOn) {
      const before = es.regex.length;
      es.regex = es.regex.filter(r => !RULE_MOVE_IDS.includes(r.id));
      removedMoves = before - es.regex.length;
    }

    if (typeof ctx.saveSettingsDebounced === 'function') ctx.saveSettingsDebounced();
    info(STAGE.RENDER, `已${added ? `注册 ${added} 条` : '更新'}绘灵正文正则（显示槽 + 提示词清理）`
      + (moveOn ? '（图位外移：开）' : removedMoves ? `（图位外移：关，已清理 ${removedMoves} 条遗留）` : '（图位外移：关）'));
    return true;
  } catch (err) {
    warn(STAGE.RENDER, `注册正文正则失败：${err?.message || err}`);
    return false;
  }
}

/** 兼容旧调用名。 */
export const registerHideRegex = registerRegex;

export function unregisterRegex() {
  try {
    const ctx = getCtx();
    const es = ctx.extensionSettings;
    if (!Array.isArray(es?.regex)) return false;
    const before = es.regex.length;
    const ids = new Set([RULE_PROMPT_ID, RULE_SHOW_ID, ...RULE_MOVE_IDS]);
    es.regex = es.regex.filter(r => !ids.has(r.id));
    if (es.regex.length !== before) {
      ctx.saveSettingsDebounced?.();
      info(STAGE.RENDER, '已移除绘灵正文正则（两条）');
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export const unregisterHideRegex = unregisterRegex;

/**
 * 「图内联 / 图堆楼顶」二选一开关 —— 全库唯一实现，面板与控制台都走这里（v0.9.78）。
 *
 * 内联 on  = 不把出图槽搬出 <now_plot>，让它随正文被搬进美化 iframe，
 *            再由 iframe 域渲染把图放回正文对应位置（需要 renderInsideIframe 配合）。
 * 内联 off = 槽搬到块外 → 图统一显示在楼层顶部（兼容所有卡的默认行为）。
 *
 * 两个开关必须一起改，且改完要重注册正则（否则 ST 里已持久化的搬运规则还在生效）。
 */
export function setInlineMode(on = true) {
  const cfg = getConfig();
  cfg.moveSlotsOutOfNowPlot = !on;
  cfg.renderInsideIframe = true;
  registerRegex();                      // 内部会顺带 saveSettingsDebounced
  return {
    moveSlotsOutOfNowPlot: cfg.moveSlotsOutOfNowPlot,
    renderInsideIframe: cfg.renderInsideIframe,
  };
}

/* ============ 渲染 ============ */

function mesTextEl(mesId) {
  return document.querySelector(`#chat .mes[mesid="${mesId}"] .mes_text`)
    || document.querySelector(`.mes[mesid="${mesId}"] .mes_text`);
}

function swipeIdOf(mesId) {
  const msg = getMessage(mesId);
  return Number.isFinite(msg?.swipe_id) ? msg.swipe_id : 0;
}

/**
 * 身份配对：把正文里的 tag 块和楼层记录一一绑定。
 *
 * 为什么不能按数组顺序配对（旧 resultsInOrder 的做法）：
 * 楼层重新生成/编辑后，记录里会残留**旧剧情的结果**（旧块随旧正文消失了，
 * 记录却还在），顺序配对会让旧图抢占新槽位 —— 天台楼层显示体育馆图就是这么来的。
 * 挂载方式：图天生属于它的楼层/槽位，靠身份绑定，不靠顺序。
 *
 * 配对规则（每个块独立解析，块之间互不影响）：
 *   ① 块有 pos 属性 → 在记录里找同 position 的结果；其中 hash 一致的优先，
 *      否则取最新的（at 最大）—— 同位置被重写过时，新结果自然胜出。
 *   ② 块没有 pos（旧版块）→ 按 hash 在记录里找回身份。
 *   ③ 都找不到 → null（渲染成"未生图"占位框，绝不挪用别块的结果）。
 *
 * 记录里**没有任何块认领**的孤儿条目直接忽略 —— 它们是错位的根源。
 *
 * @param {Array} blocks  parseTags 的输出（正文顺序）
 * @param {Array} results 楼层记录的 results
 * @returns {Array} 与 blocks 等长，每项是对应结果或 null
 */
export function bindBlocksToResults(blocks, results) {
  const list = (Array.isArray(results) ? results : []).filter(r => r);
  const used = new Set();

  const byPos = new Map();
  for (const r of list) {
    const pos = String(r.position || '').toUpperCase();
    if (!pos) continue;
    if (!byPos.has(pos)) byPos.set(pos, []);
    byPos.get(pos).push(r);
  }
  for (const arr of byPos.values()) {
    arr.sort((a, b) => (Number(b.at) || 0) - (Number(a.at) || 0));
  }

  return (Array.isArray(blocks) ? blocks : []).map((b) => {
    let hit = null;
    if (b.pos) {
      const cands = (byPos.get(b.pos) || []).filter(r => !used.has(r));
      hit = cands.find(r => r.hash && r.hash === b.hash) || cands[0] || null;
    }
    if (!hit && b.hash) {
      hit = list.find(r => !used.has(r) && r.hash && r.hash === b.hash) || null;
    }
    if (hit) used.add(hit);
    return hit;
  });
}

/** 当前楼层：正文块 ↔ 楼层记录 的绑定结果（正文顺序）。 */
function boundResults(mesId) {
  const raw = getMessageText(mesId);
  const rec = getFloorRecord(mesId, swipeIdOf(mesId));
  const blocks = parseTags(raw);
  const bound = bindBlocksToResults(blocks, rec?.results);
  // 孤儿记录（没有任何块认领）只记日志，不参与渲染
  const orphan = (rec?.results || []).filter(r => r && !bound.includes(r)).length;
  if (orphan) debug(STAGE.RENDER, `楼层 #${mesId} 有 ${orphan} 条孤儿出图记录（旧剧情残留），已忽略`);
  return bound;
}

/**
 * 这个文本节点用户看得到吗？
 *
 * 为什么需要：JS-Slash-Runner 那类"前端代码块渲染器"把正文搬进 iframe 之后，
 * **原文本节点还留在宿主 DOM 里**，只是被加了隐藏类（hidden! / [hidden]）。
 * 绘灵要是连隐藏副本一起渲染，出图记录会在宿主那份上被消耗光，
 * 真正可见的 iframe 里就只剩空槽 —— 用户看到"图没了"（2026-10-10 实测）。
 */
function isVisibleText(node) {
  let el = node.parentElement;
  while (el && el.nodeType === 1) {
    if (el.hasAttribute?.('hidden')) return false;
    const cls = typeof el.className === 'string' ? el.className : '';
    if (/(^|\s)hidden!?(\s|$)/.test(cls)) return false;
    if (el.style?.display === 'none' || el.style?.visibility === 'hidden') return false;
    el = el.parentElement;
  }
  return true;
}

/**
 * 取出 root 里所有含占位符的文本节点（文档顺序）。
 * @param skipHidden 只收用户看得见的（宿主域用；iframe 内部文档不用）
 */
function textNodesWith(root, token, skipHidden = false) {
  const out = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let n;
  while ((n = walker.nextNode()) !== null) {
    if (!n.nodeValue || !n.nodeValue.includes(token)) continue;
    if (skipHidden && !isVisibleText(n)) continue;
    out.push(n);
  }
  return out;
}

/** 把上一次注入的图片元素**还原成占位符文本** —— 这是幂等的关键。 */
function restoreSlots(el) {
  el.querySelectorAll('.hl-img-wrap').forEach(node => {
    node.replaceWith(document.createTextNode(PLACEHOLDER));
  });
  el.querySelectorAll('.hl-img-media').forEach(n => n.remove());
}

/**
 * 每层的渲染指纹。状态没变就跳过 DOM 操作。
 *
 * 为什么需要：出图流程里 writeImagesToFloor / 每出一张图 / MESSAGE_UPDATED
 * 都会触发渲染，实测会连着跑好几轮。不做去重的话，图片元素被反复拆掉重建，
 * 每张图都要重新请求 + 重新解码，肉眼可见地闪。
 *
 * 指纹里必须含渲染相关配置（mode / showPending / retry / allImages / maxHeight），
 * 否则在面板上改这些开关不会生效 —— 会被误判成"状态没变"。
 */
const renderSig = new Map();

/** 出图位状态指纹：身份（pos+hash）、有图没图、失败信息、耗时都算进去。 */
function signatureOf(mode, body, results, rcfg) {
  const flags = `${rcfg.showPending ? 1 : 0}${rcfg.retry ? 1 : 0}${rcfg.allImages ? 1 : 0}${Number(rcfg.maxHeight) || 0}`;
  const parts = results
    .map(r => (r
      ? `${r.position || '?'}:${r.hash || ''}:${Array.isArray(r.images) ? r.images.length : 0}:${r.error || ''}:${r.elapsed || 0}:${Number(r.scale) || 0}`
      : '∅'))
    .join(',');
  return `${mode}|${hash32(body)}|${flags}|${parts}`;
}

/* ---- 图片缩放 ---- */

const SCALE_MIN = 20;
const SCALE_MAX = 200;
const SCALE_STEP = 10;

/** 单张图的显示宽度（%）：优先用这张图自己记住的值，否则用全局默认。 */
function scaleOf(res, rcfg) {
  const own = Number(res?.scale);
  if (Number.isFinite(own) && own > 0) return Math.max(SCALE_MIN, Math.min(SCALE_MAX, Math.round(own)));
  return defaultScaleOf(rcfg);
}

function defaultScaleOf(rcfg) {
  const d = Number(rcfg?.defaultScale);
  return Number.isFinite(d) && d > 0 ? Math.max(SCALE_MIN, Math.min(SCALE_MAX, Math.round(d))) : 100;
}

/**
 * 缩放只改 CSS 变量，**不重建 DOM**。
 * 这是关键：重建会让 <img> 重新下载 + 重新解码（酒馆静态资源 max-age=0），
 * 拖一次滑块闪三下没人受得了。
 */
function applyScale(wrap, pct) {
  wrap.style.setProperty('--hl-scale', `${pct}%`);
  const tag = wrap.querySelector('.hl-img-pct');
  if (tag) tag.textContent = `${pct}%`;
}

/**
 * 缩放后同步「渲染指纹」。
 * 指纹里含 scale，不同步的话下次 render() 会判定"状态变了"→ 整层重建 → 闪。
 */
function syncRenderSig(mesId, rcfg) {
  const id = Number(mesId);
  const body = stripTags(getMessageText(id));
  const bound = boundResults(id);
  renderSig.set(id, signatureOf(rcfg?.mode || 'inline', body, bound, rcfg) + `|${generatingSig(id)}`);
}

/** 本楼正在出图的槽位 key → 开始时间，拼进指纹：生图中状态变化必须触发重绘。 */
function generatingSig(mesId) {
  const prefix = `${Number(mesId)}|`;
  return Array.from(generating.entries())
    .filter(([k]) => k.startsWith(prefix))
    .map(([k, v]) => `${k}>${v}`)
    .join(',');
}

/** 落库并更新界面。 */
function commitScale(wrap, mesId, res, rcfg, pct) {
  const v = Math.max(SCALE_MIN, Math.min(SCALE_MAX, Math.round(pct)));
  applyScale(wrap, v);
  if (res?.position) setResultScale(mesId, swipeIdOf(mesId), res.position, v);
  syncRenderSig(mesId, rcfg);
}

/** 悬浮工具条：− / 当前% / ＋ / 恢复默认 / 全屏。 */
function makeScaleBar(wrap, mesId, res, rcfg, doc = document) {
  const bar = doc.createElement('span');
  bar.className = 'hl-img-bar';

  const mk = (cls, text, title, fn) => {
    const b = doc.createElement('button');
    b.type = 'button';
    b.className = `hl-img-btn ${cls}`;
    b.textContent = text;
    b.title = title;
    b.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      fn();
    });
    return b;
  };

  let cur = scaleOf(res, rcfg);

  bar.appendChild(mk('hl-img-zoom-out', '−', '缩小一档', () => {
    cur = Math.max(SCALE_MIN, cur - SCALE_STEP);
    commitScale(wrap, mesId, res, rcfg, cur);
  }));

  const pct = doc.createElement('span');
  pct.className = 'hl-img-pct';
  pct.textContent = `${cur}%`;
  pct.title = '当前显示宽度（拖动它也能调）';
  bar.appendChild(pct);

  bar.appendChild(mk('hl-img-zoom-in', '＋', '放大一档', () => {
    cur = Math.min(SCALE_MAX, cur + SCALE_STEP);
    commitScale(wrap, mesId, res, rcfg, cur);
  }));

  bar.appendChild(mk('hl-img-zoom-reset', '↺', `恢复默认（${defaultScaleOf(rcfg)}%）`, () => {
    if (res?.position) setResultScale(mesId, swipeIdOf(mesId), res.position, 0);
    cur = defaultScaleOf(rcfg);
    applyScale(wrap, cur);
    syncRenderSig(mesId, rcfg);
  }));

  const first = wrap.querySelector('.hl-img');
  const url = first?.getAttribute('src');
  if (url) {
    bar.appendChild(mk('hl-img-zoom-full', '⤢', '全屏查看', () => openPreview(url, {
      prompt: res?.prompt,
      nl: res?.nl,
      position: res?.position,
      downloadUrl: first.dataset.hlLocal || first.dataset.hlRemote || url,
    })));
  }

  bar.appendChild(makeMoreButton(wrap, mesId, res, rcfg, doc));

  return bar;
}

/* ---- 单图操作菜单（⋯）---- */

/** 关掉任何已打开的菜单（全局同时只留一个）。 */
let openMenu = null;
/** 菜单的"点外面关闭/Esc 关闭"监听绑在菜单**所在文档**上（v0.9.79）：
 *  图内联模式下菜单可能挂在美化 iframe 里，事件不会冒泡到宿主 document，
 *  绑宿主就永远关不掉 —— 必须记下当时绑的是哪个文档，关闭时从同一处摘除。 */
let openMenuDoc = null;
function closeActionMenu() {
  if (!openMenu) return;
  openMenu.remove();
  openMenu = null;
  openMenuDoc?.removeEventListener('click', closeActionMenu, true);
  openMenuDoc?.removeEventListener('keydown', onMenuEsc, true);
  openMenuDoc = null;
}
function onMenuEsc(e) {
  if (e.key === 'Escape') closeActionMenu();
}

function makeMoreButton(wrap, mesId, res, rcfg, doc = document) {
  const btn = doc.createElement('button');
  btn.type = 'button';
  btn.className = 'hl-img-btn hl-img-more-btn';
  btn.textContent = '⋯';
  btn.title = '更多操作';

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (openMenu) { closeActionMenu(); return; }

    const menu = doc.createElement('div');
    menu.className = 'hl-img-menu';
    menu.addEventListener('click', (ev) => ev.stopPropagation());

    const item = (text, fn, danger = false) => {
      const b = doc.createElement('button');
      b.type = 'button';
      b.className = `hl-img-mi${danger ? ' hl-img-mi-danger' : ''}`;
      b.textContent = text;
      b.addEventListener('click', async (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        closeActionMenu();
        await fn(b);
      });
      return b;
    };

    const img = res?.images?.[0] || {};
    const label = res?.position || '';

    /**
     * v0.9.98：菜单里的「下载 / 删除」必须作用于**当前显示的那一张**。
     * 原来写死 images[0] —— 消息内翻到旧版本（‹ ›）后点「删除这张图」，
     * 删掉的是现任图，用户看到的那张反而消失（history 还被整位清空）。
     */
    const selIdx = Math.max(0, Number(wrap.dataset.hlSel) || 0);
    const allImgs = Array.isArray(res?.images) ? res.images : [];
    const histImgs = (Array.isArray(res?.history) ? res.history : [])
      .slice().reverse()
      .flatMap(h => (Array.isArray(h?.images) ? h.images : []).slice(0, 1));
    const curImg = (selIdx < allImgs.length ? allImgs[selIdx] : histImgs[selIdx - allImgs.length]) || img;
    const curUrl = curImg.localUrl || curImg.url || '';
    const curLocal = curImg.localUrl || '';

    menu.appendChild(item('↓  下载到本地', () => {
      const ok = downloadImage(curLocal || curImg.url || curUrl || img.url, `绘灵_${label}_${Date.now()}.png`);
      if (!ok) warn(STAGE.RENDER, '下载失败：浏览器拦截或图片地址不可用');
    }));

    menu.appendChild(item('⟳  重新生成这张', async (el) => {
      el.disabled = true;
      el.textContent = '⟳  生成中…';
      try {
        const r = await regenerate(mesId, res.position);
        if (!r?.ok) { el.disabled = false; el.textContent = '⟳  重试'; }
      } catch {
        el.disabled = false;
        el.textContent = '⟳  重试';
      }
    }));

    /**
     * v0.9.53（C 方案）：「按档案重新生成」—— 与上一条并列，要哪个点哪个。
     * 差别只在人物段：这条**强制**回角色档案重取外貌与服装（即使这张图的人物段
     * 被手改过也覆盖）。改了档案服装想让它立刻生效、又不想整楼重分析时走这条。
     * 只在 K2 非纯英文单段模版下有意义（SD / en 单段没有插件注入的人物段）。
     *
     * v0.9.90：SD 口径也显示 —— 外貌锚点烘焙在 prompt 里，出图时存了 anchors
     * （角色名 → 锚点串），重生成时按当前档案精确替换旧串（refreshAnchorsInPrompt）。
     */
    {
      /**
       * ★★★ v0.9.123：可用性改由**口径适配表**回答（`persona.js` 单一真源）。
       *
       * 旧判据是「非 K2 且有 anchors」—— 那正好漏掉 MOSS Layout：
       * Layout 下 `anchorList` 恒空（人物写在 character 项里），于是这个菜单项
       * **根本不出现**，用户以为「按档案生成没了」。
       * 现在分三种情况：能刷 → 给按钮；这档刷不了 → 给一条禁用项说明原因；
       * 能刷但这条记录没有角色名单 → 也给按钮，点了会明确告诉他去重分析。
       */
      const plan = activePersona();
      const isK2 = activeEngine() === 'k2';
      const enSingle = isK2 && getActiveTemplate()?.variant === 'en';
      const hasNames = (Array.isArray(res?.anchors) && res.anchors.length > 0)
        || /^[^：:\n]{1,24}[：:]/m.test(String(res?.cast || ''));
      const eligible = plan.canRefresh && !enSingle;
      if (eligible) {
        menu.appendChild(item('📚  按档案重新生成', async (el) => {
          el.disabled = true;
          el.textContent = '📚  生成中…';
          try {
            const r = await regenerate(mesId, res.position, {}, { refreshCast: 'force' });
            if (!r?.ok) { el.disabled = false; el.textContent = '📚  重试'; }
          } catch {
            el.disabled = false;
            el.textContent = '📚  重试';
          }
        }));
        if (!hasNames) {
          const tip = document.createElement('div');
          tip.className = 'hl-menu-tip';
          // 内联兜底：manifest 里的 style.css 没有版本号，浏览器可能还在用旧缓存
          tip.style.cssText = 'padding:2px 9px 4px;font-size:11px;line-height:1.35;opacity:.62;';
          tip.textContent = '这条记录没有角色名单存档 —— 点它会提示你重新分析本楼';
          menu.appendChild(tip);
        }
      } else if (!plan.canRefresh) {
        const dis = item(`📚  按档案重新生成（${plan.label} 不支持）`, () => {});
        dis.disabled = true;
        dis.title = plan.refreshText;
        menu.appendChild(dis);
      }
    }

    if (res?.prompt) {
      menu.appendChild(item('❐  复制提示词', () => {
        const text = submittedPromptOf(res);
        const done = navigator.clipboard?.writeText?.(text);
        if (done?.catch) done.catch(() => warn(STAGE.RENDER, '复制失败：浏览器拒绝了剪贴板权限'));
      }));
      menu.appendChild(item('👁  查看提示词', () => showPrompt(res)));
      // 对齐既有做法：改提示词 → （可选 AI 润色）→ 直接重生图，一气呵成
      menu.appendChild(item('✏️  编辑提示词重生成', () => showPromptEditor(mesId, res)));
    }

    /**
     * 中文描述快捷开关 —— 边看图边 A/B：
     * 关掉后再「重新生成这张」，出的就是纯 tag 版本，和现在的图一对比就知道中文有没有用。
     * 只影响之后生成的图（已有图不动）。
     */
    const nlOn = getConfig().nlEnabled !== false;
    menu.appendChild(item(`🌐  中文描述：${nlOn ? '开' : '关'}（点击切换）`, (el) => {
      const cfg = getConfig();
      cfg.nlEnabled = !nlOn;
      saveSettings();
      el.textContent = `🌐  中文描述：${cfg.nlEnabled ? '开' : '关'} · 对下次生图生效`;
      info(STAGE.RENDER, `中文描述已${cfg.nlEnabled ? '开启' : '关闭'} —— 对之后生成的图生效，已有图不受影响`);
    }));

    menu.appendChild(item('⌫  删除这张图', async () => {
      const paths = [curImg.localUrl, curImg.path].filter(Boolean);
      const nth = allImgs.length + histImgs.length > 1 ? `（第 ${selIdx + 1} 张）` : '';
      const yes = typeof globalThis.confirm === 'function'
        ? globalThis.confirm(`确定删除 ${label} 这张图${nth}？\n（正文里的出图位会保留，可随时重新生成）`)
        : true;
      if (!yes) return;
      for (const p of paths) {
        try { await deleteImage(p); } catch (err) { warn(STAGE.RENDER, `删除文件失败：${err?.message || err}`); }
      }
      // 只摘这一张（记录 + history 里同 URL 的那条）；摘空了 store 会自己清掉整个出图位
      const removed = removeResultImage(mesId, swipeIdOf(mesId), res.position, curUrl);
      if (!removed) removeFloorResult(mesId, swipeIdOf(mesId), res.position);
      renderSig.delete(Number(mesId));
      render(Number(mesId));
    }, true));

    wrap.appendChild(menu);
    openMenu = menu;
    openMenuDoc = menu.ownerDocument || doc;

    setTimeout(() => {
      // 菜单可能在同一个 tick 里已经被关掉（点了某一项 / 又点了一次 ⋯）：
      // 那时 openMenuDoc 已是 null，直接绑会 TypeError（v0.9.98 实测踩到）
      if (!openMenuDoc) return;
      openMenuDoc.addEventListener('click', closeActionMenu, true);
      openMenuDoc.addEventListener('keydown', onMenuEsc, true);
    }, 0);
  });

  return btn;
}

/**
 * 这张图**实际送进生图**的文本 —— 关掉「中文描述」时只回 tag 串。
 * 复制 / 查看都用它，保证你看到的就是真正提交给 K2 的东西（而不是"存档里有但没发"的中文）。
 */
/**
 * v0.9.53：手动生图的「预览编辑器」—— 分析完先停在这，看完/改完再出图。
 *
 * ★ 用户原话（2026-09-30）：「他经常乱写，就是因为他不知道我想要什么」——
 *   所以除了每段可手改，还带 AI 指令框：把诉求写成字，让模型照着改，
 *   而不是让它自由发挥。每段前的勾选框决定 AI 优化作用于哪几段。
 *
 * @param {Array} processed runPipeline 的 processed 列表（就地编辑其 tag/scene/cast/costume）
 * @param {(list:Array|null)=>void} resolve 点「开始生图」回传列表；点「取消」回传 null
 */
export function showPreviewEditor(processed, resolve) {
  ensureLightbox();
  const box = document.createElement('div');
  box.className = 'hl-prompt-box hl-prompt-edit hl-preview-box';
  box.addEventListener('click', (e) => e.stopPropagation());

  const isK2 = activeEngine() === 'k2';
  const enSingle = isK2 && getActiveTemplate()?.variant === 'en';
  /** v0.9.157：JSON 口径（layout 与单图 json）都编辑草稿 JSON —— 它们的 `tag` 恒为空。 */
  const isLayoutOut = activeOutput() !== 'text';

  const title = document.createElement('div');
  title.className = 'hl-edit-label';
  title.textContent = `生图预览 · 共 ${processed.length} 张 —— 分析完成，先看先改，点「开始生图」才真正出图`;
  box.appendChild(title);

  /** 全部可编辑字段（跨所有图）：[{img, key, ta, cb, name}] —— AI优化按勾选逐个处理 */
  const fields = [];

  for (const img of processed) {
    const sec = document.createElement('div');
    sec.className = 'hl-preview-sec';
    const h = document.createElement('div');
    h.className = 'hl-edit-label hl-preview-pos';
    h.textContent = `── 出图位 ${img.position} ──`;
    sec.appendChild(h);

    const mk = (labelText, key, value, rows, name, opt = {}) => {
      const label = document.createElement('div');
      label.className = 'hl-edit-label';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'hl-edit-ai-cb';
      cb.title = `勾选后「AI优化」会优化${name}`;
      if (opt.noAi) {
        // Layout 草稿是 JSON：AI 优化器只会把它改坏（它是英文润色器，不理解坐标）
        cb.disabled = true;
        cb.title = 'Layout 草稿不参与 AI 优化（请手改；坐标必须是数字）';
      }
      label.appendChild(cb);
      const span = document.createElement('span');
      span.textContent = labelText;
      label.appendChild(span);
      const ta = document.createElement('textarea');
      ta.className = 'hl-edit-ta';
      ta.rows = rows;
      ta.value = String(value || '');
      /**
       * ★ v0.9.123：字段回写统一走 `apply`。
       *   Layout 草稿不是一个字符串字段 —— 写回时必须 JSON.parse，
       *   否则 `img.__layoutJson = "{...}"` 会让 composePrompt 拿到字符串去当对象用。
       */
      const apply = opt.apply || ((v) => { img[key] = v; return true; });
      ta.addEventListener('change', () => { apply(ta.value.trim()); });
      sec.appendChild(label);
      sec.appendChild(ta);
      fields.push({ img, key, ta, cb, name, apply, noAi: !!opt.noAi });
    };

    /**
     * ★★★ v0.9.123：Layout 输出格式的预览框**不能沿用 tag/nl 两栏**。
     *
     * 病例（用户 2026-10-21）：「点分析楼跑完查看提示词那个框是空的」——
     * Layout 下 `processImage` 返的是 `tag: ''` / `nl: ''`（画面全在 JSON 的 items 里），
     * 于是两个框都是空白，用户完全看不到这次要出什么。
     * 这里直接把**草稿 JSON** 摆出来（可改坐标与文案），出图前你看到的就是真正要发的结构。
     */
    if (isLayoutOut) {
      const draft = img.layoutJson && typeof img.layoutJson === 'object' ? img.layoutJson : null;
      mk('Layout 草稿（JSON · 坐标/文案都可手改；改坏会编译失败）', '__layoutJson',
        draft ? JSON.stringify(draft, null, 1) : '（模型没有给 layout —— 这张出不了图，关掉后重开本楼分析）',
        18, 'Layout JSON', {
          noAi: true,
          apply: (v) => {
            if (!v) return false;
            try {
              const j = JSON.parse(v);
              if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('不是对象');
              img.layoutJson = j;
              return true;
            } catch (err) {
              warn(STAGE.RENDER, `${img.position} 的 Layout JSON 解析失败（${err?.message || err}），已保留原草稿`);
              return false;
            }
          },
        });
    } else if (isK2 && !enSingle) {
      mk('① 场景段（scene · 本楼剧情的场景）', 'scene', img.scene, 3, '中文场景段');
      mk('② 人物段（cast · 本楼在场角色，档案注入）', 'cast', img.cast, 5, '中文人物段');
      if (String(img.costume || '').trim()) mk('③ 服装段（已独立成段）', 'costume', img.costume, 2, '服装段');
      mk('④ 英文动作段（tag · 本楼动作/情绪）', 'tag', img.tag, 7, '英文提示词');
    } else {
      mk('英文提示词（tag · 本楼动作/情绪）', 'tag', img.tag, 8, '英文提示词');
      if (!isK2) mk('中文描述（nl）', 'nl', img.nl, 4, '中文描述');
    }
    box.appendChild(sec);
  }

  // ✨ 给 AI 的指令 + 优化按钮（同提示词编辑器：不填 = 自由润色）
  const askWrap = document.createElement('div');
  askWrap.className = 'hl-edit-ask';
  const askLabel = document.createElement('div');
  askLabel.className = 'hl-edit-label';
  const askSpan = document.createElement('span');
  askSpan.textContent = '✨ 给 AI 的指令（想让它重点改什么？留空 = 自由润色）';
  askLabel.appendChild(askSpan);
  const askInput = document.createElement('textarea');
  // 同上：不用 .hl-edit-ta，避免混进"提示词字段"计数
  askInput.className = 'hl-edit-ask-ta';
  askInput.rows = 2;
  askInput.placeholder = '例：她这楼应该是不情愿的，动作要僵一点；镜头用仰拍；不要改服装';
  askWrap.appendChild(askLabel);
  askWrap.appendChild(askInput);
  box.appendChild(askWrap);

  const row = document.createElement('div');
  row.className = 'hl-edit-row';

  const mkBtn = (text, cls, fn) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `hl-edit-btn ${cls}`;
    b.textContent = text;
    b.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      await fn(b);
    });
    return b;
  };

  const AI_SYS = {
    tag: '你是图像提示词优化器。把用户给的英文图像提示词润色得更具体、更有画面感：补足光影/构图/镜头词汇，保持原有的角色外貌锚点、质量词与标签结构不变。不要新增角色、不要改变服装与场景设定。只输出优化后的英文提示词本身，不要任何解释、引号或代码块。',
    scene: '你是图像提示词优化器。优化这段中文场景描述：补足镜头距离、光线方向、时间感与氛围，让画面更具体。必须保持地点、在场人物数量与已有事实不变，不要新增人物、不要改变剧情与服装。只输出优化后的中文文本本身，不要任何解释、引号或代码块。',
    cast: '你是图像提示词优化器。优化这段中文人物描述：只做语句通顺与画面感润色。**必须逐字保留每个角色的外貌锚点（发型发色、瞳色、体型、年龄感）与服装描述，不得增删或改写任何一件衣服** —— 这段是插件从角色档案机械注入的，改了会导致人物漂移。只输出优化后的中文文本本身，不要任何解释、引号或代码块。',
    costume: '你是图像提示词优化器。优化这段中文服装描述：只许调整语序与通顺度，**服装的款式/颜色/件数/穿着状态一字不许改**。只输出优化后的中文文本本身，不要任何解释、引号或代码块。',
    nl: '你是图像提示词优化器。优化这段中文画面描述：补足光影与构图，保持人物外貌、服装与动作事实不变。只输出优化后的中文文本本身，不要任何解释、引号或代码块。',
  };

  row.appendChild(mkBtn('✨ AI优化（按勾选）', 'hl-edit-btn-ai', async (b) => {
    const picked = fields.filter(f => f.cb?.checked && !f.noAi && f.ta.value.trim());
    if (!picked.length) {
      warn(STAGE.RENDER, '先勾选要优化的段（段标题左边的方框），再点 AI优化');
      return;
    }
    b.disabled = true;
    const doneNames = [];
    try {
      const { callAnalyzeLLM } = await import('./api.js');
      const ask = String(askInput.value || '').trim();
      const sysTail = '若用户给出了具体要求，严格优先按具体要求修改；要求与原文已有设定冲突时以具体要求为准（那是用户刚定的主意）；没给要求时再做自由润色。';
      for (const f of picked) {
        b.textContent = `优化中…（${f.img.position} ${f.name}）`;
        const body = f.ta.value.trim();
        const out = await callAnalyzeLLM([
          { role: 'system', content: (AI_SYS[f.key] || AI_SYS.tag) + sysTail },
          { role: 'user', content: ask ? `【用户的具体要求】\n${ask}\n\n【待优化的原文】\n${body}` : body },
        ], { source: `预览AI优化·${f.name}`, maxTokens: 1024, temperature: ask ? 0.5 : 0.6 });
        const cleaned = String(out || '').replace(/```[a-z]*\n?|```/g, '').trim();
        if (cleaned) { f.ta.value = cleaned; f.apply(cleaned); doneNames.push(`${f.img.position} ${f.name}`); }
      }
      if (doneNames.length) info(STAGE.RENDER, `已优化：${doneNames.join('、')}`);
      else warn(STAGE.RENDER, 'AI优化返回为空，保留原文');
    } catch (err) {
      warn(STAGE.RENDER, `AI优化失败：${err?.message || err}`);
    } finally {
      b.disabled = false;
      b.textContent = '✨ AI优化（按勾选）';
    }
  }));

  row.appendChild(mkBtn('🎬 开始生图', 'hl-edit-btn-go', (b) => {
    // 把 textarea 里改过的值都收回去（change 事件只在失焦时触发，直接改完就点按钮会漏）
    for (const f of fields) f.apply(f.ta.value.trim());
    closeLightbox();
    resolve(processed);
  }));
  row.appendChild(mkBtn('取消（不出图）', 'hl-edit-btn-no', () => {
    closeLightbox();
    resolve(null);
  }));

  box.appendChild(row);
  lightbox.replaceChildren(box);
  lightbox.classList.add('on');
}

function submittedPromptOf(res) {
  // v0.9.57：与「查看提示词」同口径 —— 优先 promptFull（composePrompt 拼装后的完整文本，
  // K2 三明治下就是完整五段）。之前只拼 prompt+nl —— 那是 slot 里的英文 tag 句，
  // K2 模式下复制到的只有末句情绪段，跟旁边的「查看提示词」显示的不是同一份内容
  //（v0.9.53 修了显示端、漏了复制端 —— 相关功能没同步更新的典型）。
  const full = String(res?.promptFull || '').trim();
  if (full) return full;
  const prompt = String(res?.prompt || '').trim();
  const nl = getConfig().nlEnabled !== false ? String(res?.nl || '').trim() : '';
  return nl ? `${prompt}\n${nl}` : prompt;
}

/** 用灯箱展示完整提示词（可选中复制）。 */
function showPrompt(res) {
  ensureLightbox();
  const box = document.createElement('div');
  box.className = 'hl-prompt-box';
  box.addEventListener('click', (e) => e.stopPropagation());

  // v0.9.16 起优先显示 promptFull（composePrompt 拼装后的最终文本）——
  // K2 三明治下这就是完整五段；旧存档 / SD 模式回退到 tag 串 + nl 的老展示。
  const full = String(res.promptFull || '').trim();
  const p = document.createElement('div');
  p.className = 'hl-prompt-line';
  p.textContent = full || String(res.prompt || '').trim();
  box.appendChild(p);

  // SD 模式：promptFull 只是 tag 串（prefix+tag+suffix），中文 nl 仍单独一行。
  // K2 模式：nl 已并入 promptFull（composePrompt 返回空），这里自然为空不显示。
  const nlShown = !full && getConfig().nlEnabled !== false ? String(res.nl || '').trim() : '';
  if (nlShown) {
    const n = document.createElement('div');
    n.className = 'hl-prompt-line hl-prompt-nl';
    n.textContent = nlShown;
    box.appendChild(n);
  }

  const tip = document.createElement('div');
  tip.className = 'hl-prompt-tip';
  tip.textContent = `${res.position || ''} · 点空白处关闭`;
  box.appendChild(tip);

  lightbox.replaceChildren(box);
  lightbox.classList.add('on');
}

/**
 * 提示词编辑器（v0.9.24 重写：字段跟随出词结构）：
 * - K2 三明治（styled/plain）：中文场景段 + 中文人物段 + 英文提示词 三个字段，
 *   与最终提示词的三段一一对应；nl 已废弃不再显示。
 * - K2 纯英文单段：只有英文提示词一个字段。
 * - SD：保持老的 英文 tag + 中文描述 双字段。
 * 改完可 ✅只存词（下次重生图生效）或 🎨直接重生图（原图进历史）。
 * 人物段只影响这一张图 —— 角色档案库本身不受影响（人设主权区）。
 */
function showPromptEditor(mesId, res) {
  ensureLightbox();
  const box = document.createElement('div');
  box.className = 'hl-prompt-box hl-prompt-edit';
  box.addEventListener('click', (e) => e.stopPropagation());

  const isK2 = activeEngine() === 'k2';
  const enSingle = isK2 && getActiveTemplate()?.variant === 'en';

  /**
   * 造字段（不直接上树，由调用方按三明治顺序排）。
   * v0.9.53：aiOpt 有值时给这一框配一个勾选框 —— 「✨ AI优化」只处理勾上的框
   * （此前它写死只优化英文段这一个框，用户想润色场景段 / 人物段时无处下手）。
   */
  const aiFields = [];
  const mkField = (labelText, value, rows, aiOpt = null) => {
    const label = document.createElement('div');
    label.className = 'hl-edit-label';
    let cb = null;
    if (aiOpt) {
      cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = 'hl-edit-ai-cb';
      cb.checked = !!aiOpt.defaultOn;
      cb.title = `勾选后「✨ AI优化」会一并优化${aiOpt.name}`;
      label.appendChild(cb);
    }
    const span = document.createElement('span');
    span.textContent = labelText;
    label.appendChild(span);
    const ta = document.createElement('textarea');
    ta.className = 'hl-edit-ta';
    ta.rows = rows;
    ta.value = String(value || '');
    if (cb) aiFields.push({ key: aiOpt.key, name: aiOpt.name, cb, ta });
    return { label, ta };
  };

  const fScene = isK2 && !enSingle
    ? mkField('① 中文场景段（scene · 镜头距离 / 光线 / 时间 / 氛围）', res.scene || '', 3,
      { key: 'scene', name: '中文场景段', defaultOn: false })
    : null;
  const fCast = isK2 && !enSingle
    ? mkField('② 中文人物段（cast · 每行「角色名：外貌」—— 只改这张图，档案库不受影响）', res.cast || '', 5,
      { key: 'cast', name: '中文人物段', defaultOn: false })
    : null;
  const fTag = mkField(
    enSingle ? '英文提示词（单段 · 外貌服装自写）'
      : isK2 ? '③ 英文提示词（tag · 服装 / 动作 / 手位 → 末句情绪）'
        : '英文提示词（tag 串）',
    res.prompt, 7,
    { key: 'tag', name: '英文提示词', defaultOn: true });
  const fNl = !isK2 ? mkField('中文描述（nl）', res.nl, 4,
    { key: 'nl', name: '中文描述', defaultOn: false }) : null;

  // 按最终提示词的段落顺序上树
  for (const f of [fScene, fCast, fTag, fNl]) {
    if (f) { box.appendChild(f.label); box.appendChild(f.ta); }
  }

  /**
   * v0.9.53：单张段落编排（折叠区，默认收起）—— 只覆盖这张图；
   * 不动它 = 跟随全局设置。两处编排都改时，这张图以这里为准。
   */
  const layoutWrap = document.createElement('div');
  layoutWrap.className = 'hl-edit-layout';
  const layoutTitle = document.createElement('div');
  layoutTitle.className = 'hl-edit-label hl-layout-toggle';
  const layoutHost = document.createElement('div');
  layoutHost.style.display = 'none';
  let layoutOpen = false;
  const paintLayoutTitle = () => {
    const on = res.promptLayout ? '（这张图已单独编排）' : '（跟随全局）';
    layoutTitle.textContent = `${layoutOpen ? '▾' : '▸'} 段落编排 ${on} —— 点开可只调这张图的顺序`;
  };
  paintLayoutTitle();
  layoutTitle.addEventListener('click', () => {
    layoutOpen = !layoutOpen;
    layoutHost.style.display = layoutOpen ? '' : 'none';
    paintLayoutTitle();
  });
  layoutWrap.appendChild(layoutTitle);
  layoutWrap.appendChild(layoutHost);
  box.appendChild(layoutWrap);

  /**
   * v0.9.53：AI优化的「指令框」—— 不填就是自由润色（模型自己挑着改，很容易改偏），
   * 填了就按用户说的改。实测用户抱怨「它每次都是随机改」，根因就是这里没有诉求入口。
   */
  const askWrap = document.createElement('div');
  askWrap.className = 'hl-edit-ask';
  const askLabel = document.createElement('div');
  askLabel.className = 'hl-edit-label';
  const askLabelSpan = document.createElement('span');
  askLabelSpan.textContent = '✨ 给 AI 的指令（想让它重点改什么？留空 = 自由润色）';
  askLabel.appendChild(askLabelSpan);
  const askInput = document.createElement('textarea');
  // ⚠️ 故意不用 .hl-edit-ta：那个类是"三段提示词字段"的标志，prompt-editor-k2-test
  //    靠数它断言编辑器结构 —— 指令框混进去会破坏断言语义（指令框不是提示词字段）。
  askInput.className = 'hl-edit-ask-ta';
  askInput.rows = 2;
  askInput.placeholder = '例：把镜头改成近景特写；光线换成傍晚暖光；让她坐姿更放松；不要改服装';
  askWrap.appendChild(askLabel);
  askWrap.appendChild(askInput);
  box.appendChild(askWrap);

  const row = document.createElement('div');
  row.className = 'hl-edit-row';

  const mkBtn = (text, cls, fn) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `hl-edit-btn ${cls}`;
    b.textContent = text;
    b.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      await fn(b);
    });
    return b;
  };

  /**
   * v0.9.53：AI优化 —— 按勾选逐段润色（此前写死只优化英文段一个框）。
   * 每段用各自的口径：英文段补光影构图；中文场景段补镜头光线氛围；
   * 中文人物段**只许润色语句，不许动外貌锚点与服装**（那是从档案机械注入的，改了人必漂）。
   */
  const AI_SYS = {
    tag: '你是图像提示词优化器。把用户给的英文图像提示词润色得更具体、更有画面感：补足光影/构图/镜头词汇，保持原有的角色外貌锚点、质量词与标签结构不变。不要新增角色、不要改变服装与场景设定。只输出优化后的英文提示词本身，不要任何解释、引号或代码块。',
    scene: '你是图像提示词优化器。优化这段中文场景描述：补足镜头距离、光线方向、时间感与氛围，让画面更具体。必须保持地点、在场人物数量与已有事实不变，不要新增人物、不要改变剧情与服装。只输出优化后的中文文本本身，不要任何解释、引号或代码块。',
    cast: '你是图像提示词优化器。优化这段中文人物描述：只做语句通顺与画面感润色。**必须逐字保留每个角色的外貌锚点（发型发色、瞳色、体型、年龄感）与服装描述，不得增删或改写任何一件衣服** —— 这段是插件从角色档案机械注入的，改了会导致人物漂移。只输出优化后的中文文本本身，不要任何解释、引号或代码块。',
    nl: '你是图像提示词优化器。优化这段中文画面描述：补足光影与构图，保持人物外貌、服装与动作事实不变。只输出优化后的中文文本本身，不要任何解释、引号或代码块。',
  };

  const aiBtn = mkBtn('✨ AI优化', 'hl-edit-btn-ai', async (b) => {
    const picked = aiFields.filter(f => f.cb.checked && f.ta.value.trim());
    if (!picked.length) {
      warn(STAGE.RENDER, aiFields.some(f => f.cb.checked)
        ? '勾上的框是空的，没法优化'
        : '先勾选要优化的段（框标题左边的方框），再点 AI优化');
      return;
    }
    b.disabled = true;
    const doneNames = [];
    try {
      const { callAnalyzeLLM } = await import('./api.js');
      const ask = String(askInput.value || '').trim();
      // 用户给了具体要求就按具体要求改 —— 没给才让模型自由润色
      const sysTail = '若用户给出了具体要求，严格优先按具体要求修改；要求与原文已有设定冲突时以具体要求为准（那是用户刚定的主意）；没给要求时再做自由润色。';
      for (const f of picked) {
        b.textContent = `优化中…（${f.name}）`;
        const body = f.ta.value.trim();
        const out = await callAnalyzeLLM([
          { role: 'system', content: (AI_SYS[f.key] || AI_SYS.tag) + sysTail },
          { role: 'user', content: ask ? `【用户的具体要求】\n${ask}\n\n【待优化的原文】\n${body}` : body },
        ], { source: `AI优化·${f.name}`, maxTokens: 1024, temperature: ask ? 0.5 : 0.6 });
        const cleaned = String(out || '').replace(/```[a-z]*\n?|```/g, '').trim();
        if (cleaned) { f.ta.value = cleaned; doneNames.push(f.name); }
      }
      if (doneNames.length) {
        info(STAGE.RENDER, `已优化：${doneNames.join('、')}（还未生图，点「用这条重生图」生效）`);
      } else {
        warn(STAGE.RENDER, 'AI优化返回为空，保留原提示词');
      }
    } catch (err) {
      warn(STAGE.RENDER, `AI优化失败：${err?.message || err}`);
    } finally {
      b.disabled = false;
      b.textContent = '✨ AI优化';
    }
  });
  row.appendChild(aiBtn);

  // 当前编辑值的快照（确认 / 重生图共用）
  const collect = () => {
    const patch = { prompt: fTag.ta.value.trim() };
    if (fScene) patch.scene = fScene.ta.value.trim();
    if (fCast) patch.cast = fCast.ta.value.trim();
    if (fNl) patch.nl = fNl.ta.value.trim();
    // v0.9.53：单张段落编排跟着一起存（没动过 = undefined = 不写，跟随全局）
    if (res.promptLayout) patch.promptLayout = res.promptLayout;
    return patch;
  };

  // 挂单张编排编辑器（懒构建：点开才建，省得每次弹编辑器都渲染一排按钮）
  layoutTitle.addEventListener('click', () => {
    if (!layoutHost.dataset.built) {
      layoutHost.dataset.built = '1';
      buildLayoutEditor(
        layoutHost,
        () => res.promptLayout || {},
        (next) => {
          res.promptLayout = next;
          paintLayoutTitle();
        },
        { hint: '只对这张图生效。想恢复跟随全局：把所有勾勾回去、顺序调回默认即可（或重生一次会按全局来）。' },
      );
    }
  }, { once: false });

  // ✅ 确认修改：只把改后的文本存回当前结果，不动图、不进历史。
  row.appendChild(mkBtn('✅ 确认修改', 'hl-edit-btn-ok', (b) => {
    const patch = collect();
    if (!patch.prompt) { warn(STAGE.RENDER, '提示词是空的，至少留一句描述'); return; }
    /**
     * v0.9.53：文本改了，"最终提示词"缓存必须一起重算 ——
     * 否则「查看提示词」读到的还是改之前那份 promptFull，用户以为没保存上。
     */
    try {
      const merged = { ...res, ...patch };
      const cp = composePrompt({
        position: res.position,
        tag: merged.prompt,
        nl: merged.nl,
        scene: merged.scene,
        mood: '',
        cast: merged.cast,
        // v0.9.121：layout 模版下「查看提示词」也要能重算出最终 JSON
        layoutJson: res.layoutJson || null,
        notes: [],
      }, getConfig());
      if (cp?.prompt) patch.promptFull = cp.prompt;
    } catch { /* 拼装失败就让它回退到 prompt+nl 展示 */ }
    const ok = setResultPrompt(Number(mesId), swipeIdOf(Number(mesId)), res.position, patch);
    if (ok) {
      res.prompt = patch.prompt;
      if (patch.scene != null) res.scene = patch.scene;
      if (patch.cast != null) res.cast = patch.cast;
      if (patch.nl != null) res.nl = patch.nl;
      info(STAGE.RENDER, `${res.position || ''} 提示词已保存（原图未动，下次重生图直接用新词）`);
      closeLightbox();
      scheduleRender(Number(mesId));
    } else {
      warn(STAGE.RENDER, '没找到对应的出图记录（楼层可能已刷新），请关掉重开');
    }
  }));

  // 🎨 用这条重生图：以编辑后的文本覆盖重生成本位
  row.appendChild(mkBtn('🎨 用这条重生图', 'hl-edit-btn-go', async (b) => {
    const patch = collect();
    if (!patch.prompt) { warn(STAGE.RENDER, '提示词是空的'); return; }
    b.disabled = true;
    b.textContent = '生成中…';
    try {
      const r = await regenerate(Number(mesId), res.position, patch);
      if (r?.ok) { closeLightbox(); return; }
      b.disabled = false;
      b.textContent = '失败，点击重试';
    } catch {
      b.disabled = false;
      b.textContent = '失败，点击重试';
    }
  }));
  row.appendChild(mkBtn('取消', 'hl-edit-btn-no', () => closeLightbox()));

  box.appendChild(row);

  const tip = document.createElement('div');
  tip.className = 'hl-prompt-tip';
  tip.textContent = isK2
    ? `${res.position || ''} · ✅只存词不生图　🎨存词并马上重生图（原图进历史）· 人物段只改本张，改人设请去档案库`
    : `${res.position || ''} · ✅只存词不生图　🎨存词并马上重生图（原图进历史）`;
  box.appendChild(tip);

  lightbox.replaceChildren(box);
  lightbox.classList.add('on');
}

/** 右下角拖拽把手：按住左右拖即可连续缩放。 */
function makeGrip(wrap, mesId, res, rcfg, doc = document) {
  const grip = doc.createElement('span');
  grip.className = 'hl-img-grip';
  grip.title = '拖动调整大小';

  grip.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();

    const parentW = wrap.parentElement?.clientWidth || wrap.clientWidth || 1;
    const startX = ev.clientX;
    const startPct = scaleOf(res, rcfg);
    let cur = startPct;
    let moved = false;
    try { grip.setPointerCapture(ev.pointerId); } catch { /* 忽略 */ }

    const onMove = (e) => {
      const dx = e.clientX - startX;
      if (!moved && Math.abs(dx) < 2) return;
      moved = true;
      cur = Math.max(SCALE_MIN, Math.min(SCALE_MAX, Math.round(startPct + (dx / parentW) * 100)));
      applyScale(wrap, cur);
      wrap.classList.add('hl-img-resizing');
    };
    const onUp = () => {
      grip.removeEventListener('pointermove', onMove);
      grip.removeEventListener('pointerup', onUp);
      grip.removeEventListener('pointercancel', onUp);
      wrap.classList.remove('hl-img-resizing');
      if (moved && res?.position) {
        setResultScale(mesId, swipeIdOf(mesId), res.position, cur);
        syncRenderSig(mesId, rcfg);
      }
    };

    grip.addEventListener('pointermove', onMove);
    grip.addEventListener('pointerup', onUp);
    grip.addEventListener('pointercancel', onUp);
  });

  return grip;
}

/* ---- 灯箱 ---- */

let lightbox = null;

/** 灯箱只在第一次用时创建，之后复用（避免每次查看都往 body 里塞节点）。 */
function ensureLightbox() {
  if (lightbox) return lightbox;
  lightbox = document.createElement('div');
  lightbox.className = 'hl-lightbox';
  lightbox.addEventListener('click', () => closeLightbox());
  document.body.appendChild(lightbox);
  return lightbox;
}

function closeLightbox() {
  if (!lightbox) return;
  lightbox.classList.remove('on');
  lightbox.replaceChildren();
  lightboxNav = null;
  document.removeEventListener('keydown', onLightboxKey, true);
}

/** 当前灯箱的翻页回调（←/→ 键盘导航用，单图时为 null）。 */
let lightboxNav = null;

function onLightboxKey(e) {
  if (e.key === 'Escape') { e.stopPropagation(); closeLightbox(); }
  if (e.key === '0') {
    lightbox.querySelector('.hl-lightbox-img')?.classList.toggle('hl-zoom-actual');
  }
  // ←/→ 翻看历史版本（画廊）
  if (e.key === 'ArrowLeft') { e.stopPropagation(); lightboxNav?.(-1); }
  if (e.key === 'ArrowRight') { e.stopPropagation(); lightboxNav?.(1); }
}

/**
 * 全屏查看。支持多图翻页（对齐既有做法：重新生成后新图原地替换、
 * 旧图进历史，灯箱里 ←/→ 或点箭头就能翻回去看）。
 *
 * @param {string} url   显示地址
 * @param {object} [meta] { prompt, nl, position, downloadUrl }
 *   - meta.list  可选，[{url, downloadUrl, prompt, nl, position, ts}]，给出时启用翻页
 *   - meta.index 当前图在 list 里的下标
 */
export function openPreview(url, meta = {}) {
  ensureLightbox();

  const list = Array.isArray(meta.list) && meta.list.length
    ? meta.list
    : [{ url, downloadUrl: meta.downloadUrl, prompt: meta.prompt, nl: meta.nl, position: meta.position }];
  let idx = Math.max(0, Math.min(list.length - 1, Number.isInteger(meta.index) ? meta.index : 0));

  const stage = document.createElement('div');
  stage.className = 'hl-lightbox-stage';
  stage.addEventListener('click', (e) => e.stopPropagation());

  /* ---- 右侧参数面板（v0.9.13）：图库打开时带 params 才出现，消息内灯箱不受影响 ---- */
  const BACKEND_NAMES = { comfyui: 'ComfyUI', nai: 'NovelAI', openai: 'OpenAI 兼容' };
  let sideBody = null;
  if (list.some(it => it.params) || meta.showSide) {
    const side = document.createElement('div');
    side.className = 'hl-lb-side';
    side.addEventListener('click', (e) => e.stopPropagation());

    const head = document.createElement('div');
    head.className = 'hl-lb-side-head';
    const headTitle = document.createElement('b');
    headTitle.textContent = '出图参数';
    const sideClose = document.createElement('button');
    sideClose.type = 'button';
    sideClose.className = 'hl-lightbox-btn';
    sideClose.textContent = '收起';
    sideClose.addEventListener('click', (e) => { e.stopPropagation(); side.remove(); });
    head.append(headTitle, sideClose);

    sideBody = document.createElement('div');
    sideBody.className = 'hl-lb-side-body';
    side.append(head, sideBody);

    const copyText = (text, label) => {
      const done = navigator.clipboard?.writeText?.(String(text || ''));
      if (done?.catch) done.catch(() => warn(STAGE.RENDER, '复制失败：浏览器拒绝了剪贴板权限'));
      else info(STAGE.RENDER, `${label}已复制`);
    };

    const card = (label, value, { copy = false, mono = false } = {}) => {
      if (value === undefined || value === null || value === '' ) return null;
      const box = document.createElement('div');
      box.className = 'hl-lb-card';
      const lab = document.createElement('div');
      lab.className = 'hl-lb-card-label';
      lab.textContent = label;
      box.appendChild(lab);
      const val = document.createElement('div');
      val.className = `hl-lb-card-val${mono ? ' mono' : ''}`;
      val.textContent = String(value);
      box.appendChild(val);
      if (copy) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'hl-btn hl-mini hl-ghost';
        btn.textContent = '复制';
        btn.addEventListener('click', (e) => { e.stopPropagation(); copyText(value, label); });
        box.appendChild(btn);
      }
      return box;
    };

    side.renderFor = (it) => {
      sideBody.replaceChildren();
      const p = it?.params;
      if (!p) {
        const empty = document.createElement('div');
        empty.className = 'hl-lb-empty';
        empty.textContent = '这张图没有参数记录（旧图或历史图，v0.9.13 之前生成的都不带）。新出的图会在灯箱里展示完整参数。';
        sideBody.appendChild(empty);
        return;
      }
      const add = (el) => { if (el) sideBody.appendChild(el); };
      const srcParts = [p.charName, p.mesId !== undefined ? `楼层 #${p.mesId}` : '', p.position]
        .filter(Boolean).join(' · ');
      if (srcParts) add(card('来源', `${srcParts}${p.at ? `（${new Date(p.at).toLocaleString()}）` : ''}`));
      const beName = BACKEND_NAMES[p.backend] || p.backend || '';
      add(card('后端 / 模型', [beName, p.model].filter(Boolean).join(' — ')));
      if (p.seed !== undefined && p.seed !== '') add(card('种子', String(p.seed)));
      if (Array.isArray(p.loras) && p.loras.length) {
        add(card('LoRA', p.loras.map(l => `${l.name}${l.weight ? ` ×${l.weight}` : ''}`).join('\n'), { mono: true }));
      }
      add(card('正向提示词', p.prompt, { copy: true, mono: true }));
      add(card('负向提示词', p.negative, { copy: true, mono: true }));
      if (p.nl) add(card('中文描述（nl）', p.nl));
    };
  }

  const img = document.createElement('img');
  img.className = 'hl-lightbox-img';
  img.alt = '绘灵';
  img.decoding = 'async';   // 大图同步解码会顶住主线程，灯箱必须异步
  // 点击图片：在「适应屏幕 ↔ 原始尺寸」之间切换
  img.addEventListener('click', (e) => {
    e.stopPropagation();
    img.classList.toggle('hl-zoom-actual');
  });
  stage.appendChild(img);

  // 左右翻页箭头 + 计数（多图时才出现）
  let counter = null;
  let prevBtn = null;
  let nextBtn = null;
  if (list.length > 1) {
    const mkNav = (text, dir, title) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `hl-lightbox-nav hl-lightbox-nav-${dir < 0 ? 'prev' : 'next'}`;
      b.textContent = text;
      b.title = title;
      b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); nav(dir); });
      return b;
    };
    prevBtn = mkNav('‹', -1, '上一张（←）');
    nextBtn = mkNav('›', 1, '下一张（→）');
    counter = document.createElement('span');
    counter.className = 'hl-lightbox-count';
    stage.appendChild(prevBtn);
    stage.appendChild(nextBtn);
  }

  const capEl = document.createElement('div');
  capEl.className = 'hl-lightbox-cap';

  const apply = () => {
    const it = list[idx] || {};
    img.src = it.url || it.downloadUrl || '';
    img.classList.remove('hl-zoom-actual');
    img.title = it.prompt ? String(it.prompt).slice(0, 240) : '';
    if (counter) counter.textContent = `${idx + 1} / ${list.length}`;
    if (prevBtn) prevBtn.disabled = idx <= 0;
    if (nextBtn) nextBtn.disabled = idx >= list.length - 1;
    const stamp = it.ts ? new Date(it.ts).toLocaleString() : '';
    capEl.textContent = [it.position, stamp].filter(Boolean).join(' · ');
    if (sideBody && typeof sideBody.parentElement?.renderFor === 'function') {
      sideBody.parentElement.renderFor(it);
    }
  };

  // 翻页：键盘 ←/→（onLightboxKey）和箭头按钮都走这里。
  // meta.onIndex 存在时同步回调（消息内的显示图跟着换），关掉灯箱不再"跳回最新那张"
  const nav = (dir) => {
    const next = idx + dir;
    if (next < 0 || next >= list.length) return;
    idx = next;
    apply();
    if (typeof meta.onIndex === 'function') meta.onIndex(idx);
  };
  lightboxNav = nav;

  const bar = document.createElement('div');
  bar.className = 'hl-lightbox-bar';

  const mk = (text, title, fn) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'hl-lightbox-btn';
    b.textContent = text;
    b.title = title;
    b.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); fn(); });
    return b;
  };

  bar.appendChild(mk('适应 / 原尺寸', '点击图片也能切换（快捷键 0）', () => img.classList.toggle('hl-zoom-actual')));
  bar.appendChild(mk('保存', '另存当前这张到下载目录', () => {
    const it = list[idx] || {};
    downloadImage(it.downloadUrl || it.url || url, `绘灵_${it.position || ''}_${Date.now()}.png`);
  }));
  bar.appendChild(mk('复制提示词', '复制当前这张的提示词', () => {
    const it = list[idx] || {};
    if (!it.prompt) return;
    const text = submittedPromptOf(it);
    const done = navigator.clipboard?.writeText?.(text);
    if (done?.catch) done.catch(() => warn(STAGE.RENDER, '复制失败：浏览器拒绝了剪贴板权限'));
  }));
  stage.appendChild(bar);
  stage.appendChild(capEl);

  // 有参数面板时：图 + 面板横向并排（CSS 控制），没有时保持原布局
  const sideNode = sideBody?.parentElement || null;
  if (sideNode) lightbox.replaceChildren(stage, sideNode);
  else lightbox.replaceChildren(stage);
  lightbox.classList.add('on');
  apply();
  document.addEventListener('keydown', onLightboxKey, true);
}

/* ---- 生图中状态（对齐 SD 助手：正文里能看到"这格正在出图"和已耗时） ---- */

/** 正在出图的槽位：key = `${mesId}|${swipeId}|${position}` → 开始时间戳。 */
const generating = new Map();

/** 提交生图前登记；出图落库/失败后由 clearGenerating 撤销。 */
export function markGenerating(mesId, swipeId, position) {
  const key = `${Number(mesId)}|${Number(swipeId) || 0}|${String(position).toUpperCase()}`;
  if (!generating.has(key)) generating.set(key, Date.now());
}

export function clearGenerating(mesId, swipeId, position) {
  generating.delete(`${Number(mesId)}|${Number(swipeId) || 0}|${String(position).toUpperCase()}`);
}

/** 楼层切 swipe / 删记录时按楼层清。 */
export function clearGeneratingFloor(mesId) {
  const prefix = `${Number(mesId)}|`;
  for (const key of generating.keys()) {
    if (key.startsWith(prefix)) generating.delete(key);
  }
}

/** 全局唯一的心跳：每秒刷新所有 .hl-timer 的文本，不建 per-slot interval（不泄漏）。 */
let timerTicker = null;
function ensureTicker() {
  if (timerTicker) return;
  timerTicker = setInterval(() => {
    if (!generating.size) return;
    document.querySelectorAll('.hl-timer[data-hl-start]').forEach((el) => {
      const start = Number(el.dataset.hlStart);
      if (!Number.isFinite(start)) return;
      el.textContent = fmtElapsed(Date.now() - start);
    });
  }, 1000);
}

function fmtElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`;
}

/* ---- 单个槽 ---- */

/** 重新生成中：半透明遮罩盖在图上（转圈 + 文案 + 实时计时）。 */
function appendBusyOverlay(wrap, busySince, doc = document) {
  const busy = doc.createElement('span');
  busy.className = 'hl-img-busy';
  const spin = doc.createElement('span');
  spin.className = 'hl-img-busy-spin';
  const txt = doc.createElement('span');
  txt.className = 'hl-img-busy-txt';
  txt.textContent = '重新生成中';
  const timer = doc.createElement('span');
  timer.className = 'hl-timer hl-img-busy-timer';
  timer.dataset.hlStart = String(busySince);
  timer.textContent = fmtElapsed(Date.now() - busySince);
  busy.appendChild(spin);
  busy.appendChild(txt);
  busy.appendChild(timer);
  ensureTicker();
  wrap.appendChild(busy);
}

/**
 * 造一个图框（有图）/ 状态槽（还没图）。
 *
 * @param opt.doc    在哪个文档里造元素。默认宿主 document；
 *                   美化把正文搬进 srcdoc iframe 时传 iframe 的 document
 *                   （v0.9.78：图回剧情原位的关键）。
 * @param opt.chrome 是否带悬浮工具条/缩放把手。宿主域为 true；
 *                   iframe 域为 false —— 这些基建的执行者绑定在宿主 document 上
 *                   （菜单关闭监听、指针事件），进到 iframe 里会失效/关不掉，
 *                   所以 iframe 内只保留图片本体 + 计数 + 状态槽。
 */
function makeSlot(res, mesId, order, rcfg = {}, opt = {}) {
  const doc = opt.doc || document;
  const chrome = opt.chrome !== false;
  const maxH = Number(rcfg.maxHeight) || 0;

  const wrap = doc.createElement('span');
  wrap.className = 'hl-img-wrap';
  wrap.dataset.hlOrder = String(order);
  if (res?.position) wrap.dataset.hlPos = String(res.position);

  const imgs = Array.isArray(res?.images) ? res.images : [];
  const hist = Array.isArray(res?.history) ? res.history : [];

  // 这格是否正在重新生成（重生成走 regenerate：槽位已有图，遮罩盖在图上）
  const genKey0 = `${Number(mesId)}|${swipeIdOf(Number(mesId))}|${String(res?.position || '').toUpperCase()}`;
  const busySince = generating.get(genKey0);

  if (imgs.length) {
    const want = rcfg.allImages ? imgs : imgs.slice(0, 1);
    applyScale(wrap, scaleOf(res, rcfg));   // 宽度先定下来，避免图片按原尺寸闪一下再缩

    // 画廊列表：当前图在前，历史版本（最新在前）在后 —— 消息内左右箭头 / 灯箱都可翻看
    const gallery = [
      ...imgs.map(im => ({
        url: im.localUrl || im.url,
        remote: im.localUrl ? im.url : '',
        downloadUrl: im.localUrl || im.url,
        prompt: res?.prompt,
        nl: res?.nl,
        position: res?.position,
        ts: res?.at,
      })),
      ...hist.slice().reverse().flatMap(h => (Array.isArray(h.images) ? h.images : []).slice(0, 1).map(im => ({
        url: im.localUrl || im.url,
        remote: im.localUrl ? im.url : '',
        downloadUrl: im.localUrl || im.url,
        prompt: h.prompt,
        nl: h.nl,
        position: res?.position,
        ts: h.at,
      }))),
    ].filter(x => x.url);

    /** 造一个带断链回退和灯箱入口的 <img>（gidx = 在画廊里的下标）。 */
    const makeImgEl = (gitem, gidx) => {
      const img = doc.createElement('img');
      img.className = 'hl-img';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.src = gitem.url;
      img.alt = `绘灵 ${res.position || ''}`;
      if (gitem.remote) img.dataset.hlRemote = gitem.remote;
      if (gitem.prompt) img.title = String(gitem.prompt).slice(0, 240);
      if (maxH > 0) img.style.maxHeight = `${maxH}px`;
      // 归档副本挂了（被手动删了/换机器）→ 退回临时地址，别让用户直接看破图
      img.addEventListener('error', () => {
        const remote = img.dataset.hlRemote;
        if (remote && img.dataset.hlFellback !== '1') {
          img.dataset.hlFellback = '1';
          img.src = remote;
          return;
        }
        img.classList.add('hl-img-broken');
        img.title = '图片已失效（文件被删除或服务不可用）';
      });
      img.addEventListener('click', (e) => {
        e.stopPropagation();
        openPreview(gitem.url, {
          prompt: gitem.prompt,
          nl: gitem.nl,
          position: res?.position,
          downloadUrl: gitem.downloadUrl,
          list: gallery,
          index: gidx,
          // 灯箱里 ←/→ 翻页后，消息内显示的图也跟着换（选中的那张落库）
          onIndex: navUI ? (i) => navUI.setSel(i) : undefined,
        });
      });
      return img;
    };

    // —— SD 助手式消息内切换：有多张（历史版本）时，图两侧出左右热区、底部亮计数 ——
    const navOn = !rcfg.allImages && gallery.length > 1;
    let navUI = null;

    if (navOn) {
      const total = gallery.length;
      let sel = Math.max(0, Math.min(total - 1, Number(res.sel) || 0));

      const img = makeImgEl(gallery[sel], sel);
      wrap.appendChild(img);

      const mkNav = (dir, text, title) => {
        const b = doc.createElement('button');
        b.type = 'button';
        b.className = `hl-img-nav ${dir < 0 ? 'hl-img-nav-prev' : 'hl-img-nav-next'}`;
        b.textContent = text;
        b.title = title;
        b.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          navUI.setSel(sel + dir);
        });
        return b;
      };
      const prevBtn = mkNav(-1, '‹', '上一张');
      const nextBtn = mkNav(1, '›', '下一张');
      wrap.appendChild(prevBtn);
      wrap.appendChild(nextBtn);

      // 底部计数：这段（该出图位）一共生成过多少张、现在看的是第几张
      const capText = (i) => `${res.position || ''} · 第 ${i + 1} / ${total} 张`
        + `${res.elapsed ? ` · ${res.elapsed}s` : ''}${hist.length ? ` · ⟲${hist.length}` : ''}`;
      const cap = doc.createElement('span');
      cap.className = 'hl-img-cap';
      wrap.appendChild(cap);

      const setSel = (i) => {
        const n = Math.max(0, Math.min(total - 1, Number(i) || 0));
        sel = n;
        // 给 ⋯ 菜单用：当前看的是第几张（下载 / 删除必须命中这一张，v0.9.98）
        wrap.dataset.hlSel = String(sel);
        const it = gallery[sel];
        delete img.dataset.hlFellback;
        img.src = it.url;
        if (it.remote) img.dataset.hlRemote = it.remote; else delete img.dataset.hlRemote;
        if (it.prompt) img.title = String(it.prompt).slice(0, 240);
        prevBtn.disabled = sel <= 0;
        nextBtn.disabled = sel >= total - 1;
        cap.textContent = capText(sel);
        if (res?.position) setResultIndex(Number(mesId), swipeIdOf(Number(mesId)), res.position, sel);
      };
      navUI = { setSel };
      wrap.dataset.hlSel = String(sel);

      prevBtn.disabled = sel <= 0;
      nextBtn.disabled = sel >= total - 1;
      cap.textContent = capText(sel);

      if (busySince) appendBusyOverlay(wrap, busySince, doc);
      // iframe 域同样挂全套悬浮件（v0.9.79）：缩放条/拖拽/⋯ 菜单的事件都绑在元素自身
      // 或菜单所在文档上，跨文档不再失效；灯箱/编辑器等弹层由宿主模块函数挂宿主 body，
      // 不受 iframe 裁剪。⋯ 按钮在 makeScaleBar 内部，不用单独挂。
      if (chrome) wrap.appendChild(makeScaleBar(wrap, mesId, res, rcfg, doc));
      if (chrome) wrap.appendChild(makeGrip(wrap, mesId, res, rcfg, doc));
      return wrap;
    }

    for (let gi = 0; gi < want.length; gi += 1) {
      const im = want[gi];
      const img = makeImgEl({
        url: im.localUrl || im.url,
        remote: im.localUrl ? im.url : '',
        downloadUrl: im.localUrl || im.url,
        prompt: res?.prompt,
        nl: res?.nl,
        position: res?.position,
      }, Math.min(gi, gallery.length - 1));
      wrap.appendChild(img);
    }

    if (busySince) appendBusyOverlay(wrap, busySince, doc);

    // 缩放：悬浮工具条 + 右下角拖拽把手
    if (chrome) wrap.appendChild(makeScaleBar(wrap, mesId, res, rcfg, doc));
    if (chrome) wrap.appendChild(makeGrip(wrap, mesId, res, rcfg, doc));

    if (imgs.length > want.length) {
      const more = doc.createElement('span');
      more.className = 'hl-img-more';
      more.textContent = `+${imgs.length - want.length}`;
      wrap.appendChild(more);
    }
    const cap = doc.createElement('span');
    cap.className = 'hl-img-cap';
    // 有历史版本时亮出 ⟲n —— 提醒灯箱里能翻到旧图
    cap.textContent = `${res.position || ''}${res.elapsed ? ` · ${res.elapsed}s` : ''}${hist.length ? ` · ⟲${hist.length}` : ''}`;
    wrap.appendChild(cap);
    return wrap;
  }

  // 还没图：占位框。正在出图的槽位显眼展示（转圈 + 位置 + 实时计时），
  // 对齐 SD 助手的"生图中"卡片 —— 用户一眼知道图会插在哪、跑了多久。
  if (!rcfg.showPending) return doc.createTextNode('');

  const swipeId = swipeIdOf(Number(mesId));
  const genKey = `${Number(mesId)}|${swipeId}|${String(res?.position || '').toUpperCase()}`;
  const startedAt = generating.get(genKey);
  const isGenerating = !!startedAt && !res?.error;

  // v0.9.24：区分「真在等出图」和「正文里有个块，但压根没对应记录」。
  // 后者是主模型自己模仿协议写的伪块（常把 hl_image 写成 hl-image）：
  // 旧版正则不认连字符，伪块原样糊成 XML 文本；放宽正则后它们会变成槽位 ——
  // 若不区分，就会留下一排永远停在「等待出图…」的框，用户只会以为"图加载不出来"。
  // 判定：本楼没有任何进行中的出图任务 + 该位置没有记录 = 孤儿块。
  const floorBusy = Array.from(generating.keys()).some(k => k.startsWith(`${Number(mesId)}|`));
  const orphanBlock = Boolean(res?._pendingOnly) && !isGenerating && !floorBusy && !res?.error;

  const slot = doc.createElement('span');
  slot.className = `hl-slot ${res?.error ? 'hl-slot-error' : (isGenerating ? 'hl-slot-generating' : (orphanBlock ? 'hl-slot-orphan' : 'hl-slot-pending'))}`;
  if (orphanBlock) {
    slot.title = '正文里有一个出图位，但没有对应的出图记录 —— 多半是主模型模仿协议自己写的块（标签名常写成 hl-image）。它不会自动出图，删掉这段或点楼层重生成即可。';
  }

  const spin = doc.createElement('span');
  spin.className = isGenerating ? 'hl-slot-spin' : 'hl-slot-dot';
  spin.textContent = isGenerating ? '' : '·';
  slot.appendChild(spin);

  const label = doc.createElement('span');
  label.className = 'hl-slot-label';
  if (res?.error) {
    // error 里可能带着 errorBrief 追加的堆栈帧（多行）—— 槽内只显示第一句，
    // 完整消息 + 堆栈放 slot.title，hover 就能看到肇事文件:行号
    const errFull = String(res.error);
    const errHead = errFull.split('\n')[0];
    label.textContent = `出图失败 · ${errHead.slice(0, 48)}`;
    const stack = [errFull, res.errStack].filter(Boolean).join('\n\n── 堆栈 ──\n');
    if (stack.trim()) slot.title = stack;
  } else if (isGenerating) {
    const pos = res?.position ? ` ${res.position}` : '';
    label.textContent = `生图中${pos}，正在提交画面…`;
  } else if (orphanBlock) {
    label.textContent = `未生成${res.position ? ` · ${res.position}` : ''}（无出图记录）`;
  } else {
    label.textContent = res ? `等待出图${res.position ? ` · ${res.position}` : ''}…` : '未生图';
  }
  slot.appendChild(label);

  // 出图中的槽位带 nl 摘要 + 实时计时（全局心跳统一刷新）
  if (isGenerating) {
    if (res?.nl) {
      const hint = doc.createElement('span');
      hint.className = 'hl-slot-hint';
      hint.textContent = String(res.nl).slice(0, 40) + (String(res.nl).length > 40 ? '…' : '');
      slot.appendChild(hint);
    }
    const timer = doc.createElement('span');
    timer.className = 'hl-timer';
    timer.dataset.hlStart = String(startedAt);
    timer.textContent = fmtElapsed(Date.now() - startedAt);
    slot.appendChild(timer);
    ensureTicker();
  }

  if (rcfg.retry && res && !res._pendingOnly) {
    const btn = doc.createElement('button');
    btn.type = 'button';
    btn.className = 'hl-slot-btn';
    btn.textContent = '重新生成';
    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      btn.disabled = true;
      btn.textContent = '生成中…';
      try {
        const r = await regenerate(mesId, res.position);
        if (!r?.ok) { btn.disabled = false; btn.textContent = '失败，重试'; }
      } catch {
        btn.disabled = false;
        btn.textContent = '失败，重试';
      }
    });
    slot.appendChild(btn);
  }

  wrap.appendChild(slot);
  return wrap;
}

/**
 * 渲染某楼层。幂等 —— 可反复调用（出图后、切 swipe、编辑后）。
 * @returns {number} 实际渲染的槽数
 */
/** 酒馆正在流式生成中？—— 走 st.js 的正确判定（v0.9.33 重写，见 st.js 顶部注释）。 */
function isGenerationBusy() {
  try { return isGeneratingNow(); } catch { return false; }
}

/* ---- 渲染风暴熔断（v0.9.33 三维度重写） ----
 *
 * 老版本只数「次数」，有个致命缺口：**render 越慢，3 秒内累计的次数越少，
 * 熔断越不可能触发**。于是「单次很慢 + 持续被触发」这种情况永远兜不住 ——
 * 主线程被同步占满，用户看到的就是界面彻底点不动、连 F12 都打不开
 * （2026-09-28 实测：CSS 特效还在闪 = 合成线程活着，主线程死了）。
 *
 * 所以必须三个维度一起看：
 *   ① 次数（per-mesId）  ② 耗时（per-mesId，★ 新增）  ③ 全局闸门（★ 新增）
 * 全局那道是补另一个洞：per-mesId 只挡单楼，多楼同时风暴时每层各记各的，
 * 30 层楼 × 12 次 = 360 次同步渲染，全局没有任何东西拦。
 */
const RATE_WINDOW_MS = 3000;
const RATE_MAX_COUNT = 12;        // 单楼：窗口内真实渲染次数上限
const RATE_MAX_COST_MS = 1200;    // 单楼：窗口内累计渲染耗时上限（★ 新增）
const GLOBAL_MAX_COUNT = 24;      // 全局：窗口内所有楼累计次数
const GLOBAL_MAX_COST_MS = 2000;  // 全局：窗口内累计耗时（★ 新增）
const FREEZE_MS = 10000;
const FREEZE_MS_MAX = 60000;      // 连续冻结的指数退避上限
/** 单次渲染硬超时：超了立即放弃本轮（DOM 未动），并靠累计耗时触发冻结冷却。
 *  动机（2026-09-28 第二次卡死）：带变量框架（MVU/酒馆助手）的卡，正文里嵌着
 *  几万字的变量/状态 JSON，每次渲染的全文本清洗都对它跑一遍 —— 单次几百 ms
 *  配上每秒多次的事件触发，主线程直接烧满。硬超时保证「再重的单次」也最多
 *  烧一个 deadline 就让路，随后由冻结窗口冷却整个风暴。 */
const RENDER_DEADLINE_MS = 800;

/** 渲染频率窗口表：mesId -> { count, cost, win, frozenUntil, warned } */
const renderRate = new Map();
/** 全局窗口（所有楼合计）。 */
const globalRate = { count: 0, cost: 0, win: 0, frozenUntil: 0, warned: false };

/** 用户主动的全量重绘（面板「全部刷新」）期间临时放行 —— 否则一次全量刷新就把自己冻住。 */
let rateLimitPaused = false;
export function pauseRateLimit(fn) {
  const prev = rateLimitPaused;
  rateLimitPaused = true;
  try { return fn(); } finally { rateLimitPaused = prev; }
}

function rollWindow(w, now) {
  if (now - w.win > RATE_WINDOW_MS) { w.win = now; w.count = 0; w.cost = 0; }
}

function freezeFloor(rate, id, now, reason) {
  // 指数退避：连续被熔的楼冻结时间翻倍（10s→20s→…→60s 封顶）。
  // 老的固定 10s 有个循环：风暴不歇的话，解冻 1 秒又烧满 → 又冻 10 秒，
  // 用户看到的就是「永远卡死，偶尔喘一口」。
  rate.freezeCount = (rate.freezeCount || 0) + 1;
  const ms = Math.min(FREEZE_MS * 2 ** (rate.freezeCount - 1), FREEZE_MS_MAX);
  rate.frozenUntil = now + ms;
  rate.count = 0;
  rate.cost = 0;
  if (!rate.warned) {
    rate.warned = true;
    warn(STAGE.RENDER, `楼层 #${id} ${reason}（疑似其它扩展在循环改正文触发事件风暴），已暂停该楼渲染 ${Math.round(ms / 1000)} 秒`);
  }
}

export function render(mesId) {
  const id = Number(mesId);
  if (!Number.isFinite(id) || id < 0) return 0;

  const now = Date.now();
  if (!rateLimitPaused) {
    rollWindow(globalRate, now);
    if (globalRate.frozenUntil > now) return 0;
  }

  const el = mesTextEl(id);
  if (!el) { renderSig.delete(id); return 0; }

  // ★ 防线一：流式生成中正文以每秒多次的频率在变，这时反复整楼重建纯烧 CPU。
  //   延后 250ms 再看一眼 —— 生成结束后 MESSAGE_RECEIVED / RENDERED 事件会补一次渲染。
  //   （v0.9.33：这条以前是死代码 —— globalThis.is_send_press 恒 false，见 st.js）
  if (isGenerationBusy()) { scheduleRender(id); return 0; }

  // ★ 防线二：熔断（次数 + 耗时 + 全局）
  let rate = renderRate.get(id);
  if (!rate) { rate = { count: 0, cost: 0, win: now, frozenUntil: 0, warned: false }; renderRate.set(id, rate); }
  if (!rateLimitPaused) {
    rollWindow(rate, now);
    if (rate.frozenUntil > now) return 0;
    rate.count += 1;
    globalRate.count += 1;
    if (rate.count > RATE_MAX_COUNT) {
      freezeFloor(rate, id, now, `3 秒内渲染 ${rate.count} 次`);
      return 0;
    }
  }

  const t0 = performance.now();
  try {
    const n = renderInner(id, el, t0);
    // 正常又轻的一轮 → 退避计数衰减，别让偶发一次风暴把楼永久冻在长冷却里
    if (n >= 0 && performance.now() - t0 < 200) { rate.freezeCount = 0; globalRate.freezeCount = 0; }
    return n === -1 ? 0 : n;
  } finally {
    if (!rateLimitPaused) {
      const cost = performance.now() - t0;
      const now2 = Date.now();
      rate.cost += cost;
      globalRate.cost += cost;
      if (rate.cost > RATE_MAX_COST_MS && rate.frozenUntil <= now2) {
        freezeFloor(rate, id, now2, `3 秒内渲染累计耗时 ${Math.round(rate.cost)}ms`);
      }
      if (globalRate.frozenUntil <= now2
        && (globalRate.cost > GLOBAL_MAX_COST_MS || globalRate.count > GLOBAL_MAX_COUNT)) {
        // 指数退避（同 freezeFloor）：风暴不歇就冻得越来越久，别放它一秒一卡地磨
        globalRate.freezeCount = (globalRate.freezeCount || 0) + 1;
        const ms = Math.min(FREEZE_MS * 2 ** (globalRate.freezeCount - 1), FREEZE_MS_MAX);
        globalRate.frozenUntil = now2 + ms;
        globalRate.count = 0;
        globalRate.cost = 0;
        if (!globalRate.warned) {
          globalRate.warned = true;
          warn(STAGE.RENDER, `渲染过于频繁（疑似其它扩展在循环改正文触发事件风暴），已全局暂停渲染 ${Math.round(ms / 1000)} 秒`);
        }
      }
    }
  }
}

/** 单楼慢渲染告警节流（15 秒一条，别让告警自己刷屏）。 */
const slowWarnAt = new Map();
function warnSlowRender(id, ms) {
  const now = Date.now();
  if (now - (slowWarnAt.get(id) || 0) < 15000) return;
  slowWarnAt.set(id, now);
  warn(STAGE.RENDER, `楼层 #${id} 单次渲染超过 ${Math.round(ms)}ms，本轮已放弃（正文里可能嵌着巨大的变量/状态块，渲染将自动冷却降频）`);
}

/* ============ 多域渲染（v0.9.78）：正文被搬进 iframe 时也要能出图 ============ */

/**
 * 有些美化脚本（创世回廊 5.3 实测）会把整段正文从 <now_plot> 里抽出来，
 * 塞进一个 srcdoc iframe 显示。占位符 ⟦HLI⟧ 因此脱离了宿主文档的文本树，
 * 而 textNodesWith 只扫宿主 root —— 表现为"图全没了"。
 *
 * 所以渲染不能只有一个域：宿主 mes_text 是域 0，正文 iframe 的内部文档按顺序排在后面。
 * 图框元素必须用对应文档的 createElement 造（见 makeSlot 的 doc 参数），
 * 否则元素会在宿主文档里凭空多出一份。
 */
const IFRAME_STYLE_ID = 'huilin-iframe-style';
/** iframe 的 load 监听去重（同一个 iframe 元素只挂一次）。 */
const iframeHooked = new WeakSet();
/** 域级别的渲染指纹：iframe 每次重建 document 都会变新对象，WeakMap 随 DOM 一起回收。 */
const domainSig = new WeakMap();

let slotCss = null;
let slotCssLoading = false;

/** 预拉取绘灵样式表文本 —— 要灌进 iframe 文档，否则图框在 iframe 里是裸元素。 */
export async function preloadSlotCss() {
  if (slotCss || slotCssLoading) return;
  slotCssLoading = true;
  try {
    const url = new URL('../style.css', import.meta.url);
    slotCss = (await (await fetch(url)).text()) || '';
  } catch (err) {
    slotCss = '';
    debug(STAGE.RENDER, `拉取样式表失败，iframe 内图框不带样式：${err?.message || err}`);
  } finally {
    slotCssLoading = false;
  }
}

/** 往 iframe 文档里塞一份绘灵样式（幂等，靠 style id）。 */
function ensureSlotStyle(doc, id) {
  if (!doc?.head || doc.getElementById(IFRAME_STYLE_ID)) return true;
  if (!slotCss) {
    preloadSlotCss().then(() => scheduleRender(id));   // 拿到了再补一轮，让图框带上样式
    return false;
  }
  const st = doc.createElement('style');
  st.id = IFRAME_STYLE_ID;
  st.textContent = slotCss;
  doc.head.appendChild(st);
  return true;
}

/**
 * 收集渲染域。
 * @returns {{ targets: Array<{root:object, doc:object, chrome:boolean}>, pending: boolean }}
 *          pending = 正文里有 iframe 但文档还没就绪（srcdoc 还没解析完）→ 本轮先别兜底追加图。
 */
function collectTargets(el, id) {
  const targets = [{ root: el, doc: el.ownerDocument || document, chrome: true }];
  if (getConfig().renderInsideIframe === false) return { targets, pending: false };

  const frs = el.querySelectorAll('iframe');
  let pending = false;
  for (const f of frs) {
    let d = null;
    try { d = f.contentDocument; } catch { d = null; }   // 跨域/sandbox 的 iframe 直接放弃
    if (!d || !d.body) { pending = true; }
    else if (!d.body.firstChild && !/⟦HLI⟧/.test(d.body.textContent || '')) {
      // 文档对象在但内容还没解析出来（srcdoc 刚写入）：也算没就绪
      pending = true;
    }
    // iframe 是异步就绪的 —— 内容一 load 就补一轮渲染，否则图要等下一次事件才出现
    if (!iframeHooked.has(f)) {
      iframeHooked.add(f);
      f.addEventListener('load', () => scheduleRender(id));
    }
    if (!d?.body) continue;
    ensureSlotStyle(d, id);
    // chrome: true（v0.9.79 起）—— iframe 内的图也挂缩放条/拖拽/⋯ 菜单。
    // 菜单的"点外面关闭"已改为绑菜单所在文档；拖拽靠 setPointerCapture（元素级）；
    // 灯箱/提示词弹层走宿主模块函数、挂在宿主 body，显示不被 iframe 裁剪。
    targets.push({ root: d.body, doc: d, chrome: true });
  }
  // ★ 前奏态判定（v0.9.84）：JS-Slash-Runner 把正文搬进 srcdoc iframe 是分步的 ——
  //   先在宿主给原文本加隐藏类，之后才把 iframe 插进 DOM。出图完成的那轮渲染若撞进
  //   这个空档，DOM 里还没有 iframe 可扫 → 上面的 pending 判不出来 → 图被兜底追加到
  //   楼底；之后外壳幂等看到宿主有图框就不再进来，图就一直挤在楼底
  //   （2026-10-11 病例：编辑楼层触发重格式化才恢复）。
  //   判据：宿主无「可见」占位符、但存在「隐藏」占位符 → 正文已被搬走，等 iframe 补渲染。
  if (!pending && frs.length === 0
      && textNodesWith(el, PLACEHOLDER, false).length > 0
      && textNodesWith(el, PLACEHOLDER, true).length === 0) {
    pending = true;
  }
  return { targets, pending };
}

/** render() 的实际主体 —— 被外壳包着做熔断计时，这样每个 return 分支都被统计到。 */
function renderInner(id, el, t0) {
  const cfg = getConfig();
  const mode = cfg.render?.mode || 'inline';
  const rcfg = cfg.render || {};

  const body = stripTags(getMessageText(id));
  const blocks = parseTags(getMessageText(id));   // 正文块（正文顺序，带 pos 身份）
  const bound = boundResults(id);                 // 块 ↔ 记录 身份配对
  const sig = signatureOf(mode, body, bound, rcfg) + `|${generatingSig(id)}`;

  // 状态没变就不动 DOM（见 signatureOf 的注释）
  // ★ 兜底残留不算「已经有图」（v0.9.85）：楼底那组是"槽没找到时临时贴上去的"，
  //   它挂在宿主会让幂等误判成"这楼渲染过了" → 直接 return → 之后 iframe 就绪也永远
  //   补不进去，图就一直挤在楼底（2026-10-11 病例：只能靠编辑楼层触发重格式化才恢复）。
  const rendered = countRenderedSlots(el);            // 含 iframe 内部文档，排除兜底残留
  const hasRealSlots = rendered > 0;
  // ★ 还缺槽就不许早退（v0.9.87）：签名相同只说明"正文与图记录没变"，
  //   但上一轮可能只落上了一半（iframe 当时没就绪）。以前这里直接 return，
  //   于是"第一张图渲染成功 + 签名没变"就把后面所有补渲染全挡在门外 ——
  //   剩下的槽永远补不上，只能靠编辑楼层重建 DOM 才恢复。
  const missingSlots = archiveSlotCount(id) - rendered;
  if (renderSig.get(id) === sig && hasRealSlots && missingSlots <= 0) {
    clearSlotRetry(id);   // 已经有真图了，本楼的重试计划没意义，撤掉（别留常驻定时器）
    clearSlotWatch(id);
    return 0;
  }

  // ★ 硬超时（v0.9.35）：重活干完还没到重建阶段就超时 → 立即放弃本轮。
  //   此刻 DOM 未动，放弃是干净的；本轮耗时已在外壳计入熔断窗口，
  //   持续过重会自然触发冻结冷却，而不是无限堆下去烧满主线程。
  if (performance.now() - t0 > RENDER_DEADLINE_MS) {
    warnSlowRender(id, performance.now() - t0);
    return -1;
  }

  renderSig.set(id, sig);
  if (mode === 'off') return 0;

  // 第二道检查的重活现在是「扫描所有域的占位符」（见下面 collectTargets）
  const scan = collectTargets(el, id);
  if (performance.now() - t0 > RENDER_DEADLINE_MS) {
    restoreSlots(el);   // 把刚才的恢复原样（尚未插块，但保持干净状态）
    renderSig.delete(id);
    warnSlowRender(id, performance.now() - t0);
    return -1;
  }

  let idx = 0;

  // ★ 多域渲染（v0.9.78）：宿主 .mes_text 是一个域，正文被搬进的 srcdoc iframe 是另外的域。
  //   域的顺序 = 宿主在前、iframe 按 DOM 顺序在后 —— 与槽在正文里的出现顺序一致，
  //   这样 blocks/bound 的下标对应关系不会被打乱。
  const domains = scan.targets;
  let skipped = 0;      // 本轮被幂等跳过的域数（这些域里是有图的，不许再兜底追加）
  for (let di = 0; di < domains.length; di += 1) {
    const t = domains[di];
    // ★ 顺序不能颠倒：先判幂等再动 DOM。反过来会出事 —— 已渲染的域被
    //   restoreSlots 还原成占位符，然后被本轮"状态没变"跳过，用户眼睁睁看图消失。
    // ★ 幂等必须**同时**核对现状：变量脚本/外部重绘会把 innerHTML 整块换掉，
    //   这时 sig 没变、但图框已经不在了 —— 只认记录就会让图再也不重建
    //   （v0.9.78 回归：K2/SD 提示词编辑器第二轮打不开就是这么塌的）。
    // ★ 域里还有没渲染的占位符 → 不许跳过（v0.9.87）。
    //   病例：美化 iframe 分次把正文搬进去，第一轮只搬了一半槽；等剩下的搬完时
    //   sig 没变、域里也有图框 → 旧判据直接跳过该域 → 后到的槽永远补不上。
    const leftover = textNodesWith(t.root, PLACEHOLDER, di === 0).length;
    if (domainSig.get(t.root) === sig && t.root.querySelector('.hl-img-wrap') && leftover === 0) {
      skipped += 1; continue;
    }
    restoreSlots(t.root);                            // 该域这一轮还没渲染过 → 先还原再重建
    // 宿主域只收可见的（di=0）：正文被搬进 iframe 时宿主里那份是隐藏副本，不能消耗记录
    const dn = textNodesWith(t.root, PLACEHOLDER, di === 0);
    if (!dn.length) { if (di > 0) domainSig.set(t.root, sig); continue; }

    for (const node of dn) {
      const parts = node.nodeValue.split(PLACEHOLDER);
      const count = parts.length - 1;
      if (count <= 0) continue;

      const frag = t.doc.createDocumentFragment();
      parts.forEach((txt, i) => {
        if (i > 0) {
          idx += 1;
          // 槽位与块按正文顺序一一对应；块有身份但记录还没有 → 传"伪结果"，
          // 让"生图中/等待出图"的占位框也能显示位置与计时（身份绑定保证不挪用别块的结果）
          const block = blocks[idx - 1] || null;
          const res = bound[idx - 1]
            || (block ? { position: block.pos || '', nl: block.nl || '', _pendingOnly: true } : null);
          frag.appendChild(makeSlot(res, id, idx, rcfg, { doc: t.doc, chrome: t.chrome }));
        }
        if (txt) frag.appendChild(t.doc.createTextNode(txt));
      });
      node.parentNode?.replaceChild(frag, node);
    }
    domainSig.set(t.root, sig);
  }

  // ★ 落位完整性（v0.9.85）：存档里有 N 个槽，本轮只落了 idx 个 → 还有槽没到位。
  //   比"猜 iframe 处于哪种未就绪状态"可靠得多：不管正文是被搬进 iframe、iframe 刚插入
  //   还没解析、还是宿主那份被整段替换掉，只要数对不上就说明**还没到时候**。
  const expected = archiveSlotCount(id);
  const incomplete = expected > 0 && idx < expected;

  // 自愈：这一轮能在正文里落位了，就把之前临时挂在楼底的兜底图撤掉
  // （旧版本一旦走了兜底就再也回不来，只能靠编辑楼层触发重格式化）。
  if (idx > 0) {
    const removed = clearFallbackSlots(el);
    if (removed) debug(STAGE.RENDER, `楼层 #${id} 正文槽已可用，已撤掉 ${removed} 组临时兜底图`);
  }

  if (incomplete) {
    // 快速重试只在守望启动之前排一轮；守望期间不再叠重试（否则每 2s 里又塞 4 次渲染）
    if (!slotWatch.has(id)) scheduleSlotRetry(id);
    if (!slotRetry.has(id)) scheduleSlotWatch(id);   // 重试已耗尽 → 转低频守望
  } else {
    clearSlotRetry(id);           // 槽已落齐（或本就没有槽）：撤掉重试计划，别让定时器常驻
    clearSlotWatch(id);
  }

  // 一张都没落上、且重试与守望都走完了 → 追加到楼底（带标记，正文槽恢复后会自动撤回）
  if (idx === 0 && !scan.pending && skipped === 0 && !slotRetry.has(id) && !slotWatch.has(id)) {
    // 兜底：没有占位符说明显示侧正则没生效（被禁用/被清理）。
    // 这时别让图彻底消失 —— 有结果就追加到消息末尾。
    // 四种情况下不走这条：
    //  - pending（iframe 还没 load 完）：等 load 事件来一轮真渲染；
    //  - 重试计划还在（slotRetry）/ 守望还在（slotWatch）：等它们走完，别抢在 iframe 就绪前贴楼底；
    //    （v0.9.87：守望是最后一道，24 秒都落不上才认输 —— 那时至少让用户看到图）
    //  - skipped>0（这些域本轮刚渲染过、图还在里面）：否则每渲染一轮就往楼尾多贴一张图。
    const withImgs = bound.filter(r => r && Array.isArray(r.images) && r.images.length);
    if (withImgs.length) {
      const holder = document.createElement('span');
      holder.className = 'hl-img-media';
      holder.setAttribute(FALLBACK_MARK, '1');
      withImgs.forEach(r => holder.appendChild(makeSlot(r, id, ++idx, rcfg)));
      el.appendChild(holder);
      debug(STAGE.RENDER, `楼层 #${id} 未找到显示槽，已把 ${withImgs.length} 张图追加到消息末尾`);
    }
  }

  // media 模式：把图集中到消息末尾（其余不变，只是位置）
  if (mode === 'media') {
    const wraps = Array.from(el.querySelectorAll('.hl-img-wrap'));
    if (wraps.length) {
      const holder = document.createElement('span');
      holder.className = 'hl-img-media';
      wraps.forEach(w => holder.appendChild(w));
      el.appendChild(holder);
    }
  }

  return idx;
}

/** 刷新一个楼层（渲染 + 通知酒馆）。 */
export function refreshFloor(mesId) {
  const n = render(mesId);
  return n;
}

/* ============ 渲染钩子 ============ */

let hooksInstalled = false;
const pendingRender = new Map();

/** 渲染防抖窗口。流式输出/变量脚本会高频触发 MESSAGE_UPDATED，80ms 太短 ——
 *  风暴中的每个 80ms 空隙都会真的做一次整楼重建（每秒 10+ 次全量 render，
 *  渲染进程直接烧满一核 = 用户看到的"页面卡死什么都点不动"，2026-09-25）。 */
const RENDER_DEBOUNCE_MS = 250;

/** 合并同一楼层的多次触发（流式输出时会被高频调用）。 */
function scheduleRender(mesId) {
  const id = Number(mesId);
  if (!Number.isFinite(id) || id < 0) return;
  const old = pendingRender.get(id);
  if (old) clearTimeout(old);
  pendingRender.set(id, setTimeout(() => {
    pendingRender.delete(id);
    try { render(id); } catch (err) { debug(STAGE.RENDER, `渲染楼层 #${id} 出错：${err?.message || err}`); }
  }, RENDER_DEBOUNCE_MS));
}

/* ---------- 槽位落位保障（v0.9.85） ---------- */

/**
 * 存档正文里的出图槽数 —— **不经过任何正则 / iframe 搬运**的原始值。
 * 用它当「本楼应该有几张图」的基准：DOM 里找到的槽比它少，就说明还有槽在路上
 * （iframe 刚插进 DOM 但 srcdoc 还没解析、或正文正在被搬进 iframe），
 * 这时候绝不能把图兜底追加到楼底 —— 那会让图错位卡死（2026-10-11 病例）。
 */
function archiveSlotCount(id) {
  try {
    const raw = getMessageText(id) || '';
    return (raw.match(/<hl[_-]image\b/gi) || []).length;
  } catch { return 0; }
}

/** 兜底追加的图挂在这个标记下，便于后续自愈清理。 */
const FALLBACK_MARK = 'data-hl-fallback';

/**
 * 这楼**此刻真正渲染出来**的图框数（跨宿主 + iframe 内部文档，排除兜底残留）。
 * 注意：iframe 的内容是独立文档，宿主 `el.querySelectorAll` 扫不到里面 ——
 * 想判断"槽落齐了没"必须连 iframe 一起数（2026-10-12）。
 */
function countRenderedSlots(el) {
  let n = 0;
  const countIn = (root) => {
    if (!root?.querySelectorAll) return;
    root.querySelectorAll('.hl-img-wrap').forEach((w) => {
      if (!w.closest(`[${FALLBACK_MARK}]`)) n += 1;
    });
  };
  countIn(el);
  el.querySelectorAll?.('iframe')?.forEach((f) => {
    try { countIn(f.contentDocument); } catch { /* 跨域/未就绪，忽略 */ }
  });
  return n;
}

/** 本轮能在正文里正常落位了 → 撤掉之前临时挂在楼底的兜底图。 */
function clearFallbackSlots(el) {
  if (!el) return 0;
  const olds = Array.from(el.querySelectorAll(`[${FALLBACK_MARK}]`));
  olds.forEach(n => n.remove());
  return olds.length;
}

/** 槽没落齐时的补渲染节奏（ms）。耗尽后才允许兜底，避免"正则真被禁用"时永远无图。 */
// 4 次、共约 5.7 秒。次数刻意压低：出图流程本身每出一张图就会触发一轮渲染，
// 加上单楼「3 秒 12 次」的熔断上限，重试太多会把自己冻住。
const SLOT_RETRY_DELAYS = [300, 800, 1600, 3000];
const slotRetry = new Map(); // id -> { n, timer }
/** 取消重试计划（槽已补齐 / 切聊天 / 渲染已正常结束）。 */
function clearSlotRetry(id) {
  const rec = slotRetry.get(id);
  if (!rec) return;
  if (rec.timer) clearTimeout(rec.timer);
  slotRetry.delete(id);
}
/**
 * ★ 计数必须**跨轮累计**（v0.9.85a）。
 * 第一版在定时器回调里先 delete 再 scheduleRender，下一轮 n 又从 1 开始 ——
 * 只要槽一直没落齐就 300→800→1600→3000 无限续命，node 进程的定时器永不归零
 * （live-run-test 跑完三轮却挂住不退出，被 60s timeout 判成失败）。
 * 现在：同一楼层最多 4 次，耗尽即撤计划并放行兜底。
 */
function scheduleSlotRetry(id) {
  const rec = slotRetry.get(id) || { n: 0, timer: null };
  if (rec.n >= SLOT_RETRY_DELAYS.length) { clearSlotRetry(id); return; }
  rec.n += 1;
  slotRetry.set(id, rec);
  if (rec.timer) clearTimeout(rec.timer);   // 同一楼层同时只保留一个待执行的重试
  rec.timer = setTimeout(() => { scheduleRender(id); }, SLOT_RETRY_DELAYS[rec.n - 1]);
}

/* ---------- 落位守望（v0.9.87） ---------- */

/**
 * 重试那 5.7 秒用完还没落齐 → 交给守望。
 * 为什么还需要它（2026-10-12 病例）：出图完成那一瞬间正好是事件风暴最密的时候
 * （写回正文 / 美化器重建 iframe / 各扩展重渲染），补渲染极易被**熔断冻住**；
 * 冻完之后 iframe 才就绪，但那时已经没有任何事件会再来叫醒绘灵 ——
 * 表现就是"图不出现，非得手动编辑楼层触发重格式化才回来"。
 * 守望是低频（2s 一轮）、**有上限**（12 轮≈24s）、且每轮**豁免熔断**的修复性渲染：
 * 它不是正文风暴，不该被风暴保护挡在门外。
 */
const SLOT_WATCH_MS = 2000;
const SLOT_WATCH_MAX = 12;
const slotWatch = new Map(); // id -> { n, timer }
function clearSlotWatch(id) {
  const rec = slotWatch.get(id);
  if (!rec) return;
  if (rec.timer) clearTimeout(rec.timer);
  slotWatch.delete(id);
}
function scheduleSlotWatch(id) {
  const rec = slotWatch.get(id) || { n: 0, timer: null };
  if (rec.n >= SLOT_WATCH_MAX) { clearSlotWatch(id); return; }
  rec.n += 1;
  slotWatch.set(id, rec);
  if (rec.timer) clearTimeout(rec.timer);
  rec.timer = setTimeout(() => {
    // 豁免熔断：这一轮是"补落位"，不是正文被反复改写
    try { pauseRateLimit(() => render(id)); } catch (err) {
      debug(STAGE.RENDER, `楼层 #${id} 守望补渲染出错：${err?.message || err}`);
    }
  }, SLOT_WATCH_MS);
}

/* 测试钩子：给回归夹具观察重试/守望计划是否真的会耗尽（不进产物也无害，只是几个引用）。 */
export const __slotRetry = slotRetry;
export const __slotWatch = slotWatch;
export { scheduleSlotRetry, clearSlotRetry, scheduleSlotWatch, clearSlotWatch };

/** 切聊天：同 mesId 在另一个聊天里是另一层正文，缓存与生中状态必须全部作废。 */
function onChatChanged() {
  renderSig.clear();
  renderRate.clear();
  slowWarnAt.clear();
  globalRate.count = 0;
  globalRate.cost = 0;
  globalRate.freezeCount = 0;
  globalRate.frozenUntil = 0;
  for (const t of pendingRender.values()) clearTimeout(t);
  pendingRender.clear();
  for (const id of Array.from(slotRetry.keys())) clearSlotRetry(id);
  for (const id of Array.from(slotWatch.keys())) clearSlotWatch(id);
  generating.clear();
  closeActionMenu();
  debug(STAGE.RENDER, '聊天已切换，渲染缓存与生中状态已清空');
}

/**
 * ★ iframe 往往是**后来才出现**的：美化脚本在运行时才知道要把正文塞进 iframe。
 *   绘灵的第一轮渲染通常早于它 —— 那时 DOM 里根本没有 iframe，
 *   collectTargets 扫不到、样式也注不进去。
 *   所以得盯着 chat 树：任何 iframe 冒出来就给所属楼层补一轮渲染。
 */
let chatIframeWatcher = null;
export function installIframeWatcher() {
  if (chatIframeWatcher || typeof MutationObserver !== 'function') return;
  const root = document.getElementById('chat') || document.body;
  if (!root) return;
  chatIframeWatcher = new MutationObserver((muts) => {
    for (const m of muts) {
      // v0.9.87：美化器也可能**复用**同一个 iframe、只改 srcdoc/src —— 那样没有新节点，
      // 以前就漏掉了（正文里的槽换了一轮，绘灵却以为没变化）。
      if (m.type === 'attributes') {
        const ifr = m.target;
        if (ifr?.tagName === 'IFRAME') {
          const aid = ifr.closest?.('.mes')?.getAttribute('mesid');
          if (aid != null && aid !== '') scheduleRender(Number(aid));
        }
        continue;
      }
      for (const n of m.addedNodes || []) {
        if (n.nodeType !== 1) continue;
        const ifr = n.tagName === 'IFRAME' ? n : n.querySelector?.('iframe');
        if (!ifr) continue;
        const id = ifr.closest?.('.mes')?.getAttribute('mesid');
        if (id != null && id !== '') scheduleRender(Number(id));
      }
    }
  });
  chatIframeWatcher.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['srcdoc', 'src'],
  });
  debug(STAGE.RENDER, '正文 iframe 观察器已装上（异步出现的美化 iframe 会自动补渲染）');

  // 更精准的一条：正文 iframe 主要是 JS-Slash-Runner（前端代码块渲染器）造的，
  // 它渲染完会广播 message_iframe_render_ended，带上 iframe 的 id（TH-message--<楼号>）。
  // 听它就不用盲等 load —— 实测 MutationObserver 那条用于兜住其它来源的 iframe。
  try {
    const src = getCtx().eventSource;
    if (src?.on) {
      const onEnded = (payload) => {
        const raw = typeof payload === 'string' ? payload : (payload?.id ?? payload?.detail ?? '');
        const m = /(\d+)\s*$/.exec(String(raw));
        if (m) { scheduleRender(Number(m[1])); return; }
        // 解析不出楼号：给所有带 iframe 的楼层各补一轮（事件参数语义各扩展不一）
        document.querySelectorAll('#chat .mes').forEach((el) => {
          if (el.querySelector('iframe')) scheduleRender(Number(el.getAttribute('mesid')));
        });
      };
      src.on('message_iframe_render_ended', onEnded);
    }
  } catch (err) {
    debug(STAGE.RENDER, `监听 iframe 渲染完成事件失败（走 MutationObserver 兜底）：${err?.message || err}`);
  }
}

export function installRenderHooks() {
  if (hooksInstalled) return;
  const types = getEventTypes();
  const src = getCtx().eventSource;
  if (!src?.on) {
    warn(STAGE.RENDER, '拿不到 eventSource，渲染钩子未安装（图不会自动出现）');
    return;
  }
  onEvent(types.CHARACTER_MESSAGE_RENDERED, scheduleRender);
  onEvent(types.USER_MESSAGE_RENDERED, scheduleRender);
  onEvent(types.MESSAGE_UPDATED, scheduleRender);
  onEvent(types.MESSAGE_SWIPED, scheduleRender);
  if (types.CHAT_CHANGED) onEvent(types.CHAT_CHANGED, onChatChanged);
  hooksInstalled = true;
  debug(STAGE.RENDER, '渲染钩子已安装');
}

export function uninstallRenderHooks() {
  const types = getEventTypes();
  ['CHARACTER_MESSAGE_RENDERED', 'USER_MESSAGE_RENDERED', 'MESSAGE_UPDATED', 'MESSAGE_SWIPED', 'CHAT_CHANGED']
    .forEach(k => { if (types[k]) unregisterEvent(types[k]); });
  hooksInstalled = false;
}

function unregisterEvent(type) {
  const src = getCtx().eventSource;
  if (src?.off) src.off(type, scheduleRender);
}

/* ============ 单图重生成 ============ */

/**
 * 重新生成某个出图位。
 * 用存下来的 tag/nl 重新组装提示词 → 提交 → 覆盖该位的结果 → 重渲染。
 * override 可指定 prompt/nl（「编辑提示词重生成」用），旧图自动进历史。
 *
 * @returns {Promise<{ok:boolean, error?:string, images?:Array}>}
 */
/**
 * 从存档记录里取回「这一张画了谁」。
 *
 * 优先 `anchors`（v0.9.90 起落库，且已排除 POV / 不入画的人）；
 * 老记录没有时退回解析中文人物段的首列（`夜斗：一位男性，…`）。
 * 两处都没有就只能空手而归 —— 调用方会警告，不会静默。
 */
function castNamesOf(prev) {
  const out = [];
  const push = (n) => {
    const s = String(n || '').trim();
    if (s && !out.includes(s)) out.push(s);
  };
  for (const a of (Array.isArray(prev?.anchors) ? prev.anchors : [])) push(a?.name);
  if (!out.length) {
    for (const line of String(prev?.cast || '').split('\n')) {
      const m = /^([^：:]{1,24})[：:]/.exec(String(line).trim());
      if (m) push(m[1]);
    }
  }
  return out;
}

/** 从一段文本里取 Layout **草稿**（未编译形态）。编译后的成稿不接受（见调用方注释）。 */
function draftFromPrompt(raw) {
  const s = String(raw || '');
  const a = s.indexOf('{');
  const b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try {
    const j = JSON.parse(s.slice(a, b + 1));
    if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
    // 成稿（中心化 + yxyx、无 width/height）不能再编译 —— 缺画布信息，只能原样重出
    if (String(j.bbox_coord_space || '') === 'abs_centralized') return null;
    return j;
  } catch {
    return null;
  }
}

/**
 * 「重新生成」的**拼装计划** —— 纯计算，不碰网络也不碰 DOM。
 *
 * ★★★ v0.9.123 抽出来的理由（用户 2026-10-21 三连报）：
 *   重生成要按**当前口径**把存档片段重新拼一遍，而「当前口径需要哪些片段」
 *   这件事以前是**内联在 regenerate 里、按 SD/K2 两档 if 出来的** ——
 *   MOSS 是第三档（纯 prompt 要 castEn、Layout 要 layoutJson），两档 if 装不下它：
 *     · 少传 `castEn` → MOSS 重生成整段没有人物（外貌服装全丢）
 *     · 少传 `layoutJson` → Layout 重生成编译失败 → 空提示词 → 出成毫无关系的图
 *   抽成函数后有两个好处：① 口径相关的东西集中在一处，加口径不再各写一遍；
 *   ② 可以在测试里**直接验证拼装结果**，不必真的去请求 ComfyUI。
 */
export function planRegenerate(prev, override = {}, opts = {}) {
  const cfg = getConfig();
  const position = prev?.position;
  let pText = String(override.prompt ?? prev.prompt ?? '');
  const nlText = String(override.nl ?? prev.nl ?? '');
  // v0.9.24：场景段 / 人物段同样允许编辑覆盖（编辑器与存档都带这两段）
  const sceneText = String(override.scene ?? prev.scene ?? '');

  /**
   * v0.9.53：人物段「按档案刷新」（B 方案，默认开）。
   *   服装 / 外貌是首次出图时机械注入并**烘焙进存档**的 —— 之后改档案、点重新生成，
   *   复读的还是旧文本（用户实测：白色改成紫色不生效）。这里在重生成前回档案重取。
   *   mode: 'auto'（默认，手改过就沿用）/ 'off' / 'force'（菜单「按档案重新生成」）。
   */
  let castText = String(override.cast ?? prev.cast ?? '');
  let costumeText = String(override.costume ?? prev.costume ?? '');
  let refreshed = [];        // 本次被档案刷新的角色（用于提示用户）
  let skippedByHand = false; // 因手改而跳过刷新（用于提示用户）

  /**
   * ★★★ v0.9.123：MOSS 纯 prompt 口径 —— 重生成必须重建英文人物段。
   *
   * 病例（用户 2026-10-21）：「MOSS 模式下点重新生成，结果完全变成另外的图了，
   * 和原来没关系了，丢掉了很多东西。」
   *
   * 机制：MOSS 的外貌/服装**不在 `prev.prompt` 里** —— `p.tag` 存的是动作段原文，
   * 人物段是 `composePrompt` 时由 `processed.castEn` 注入进去的（最终文本才在 `promptFull`）。
   * 而 `regenerate` 手工拼的 processed 对象**从来没有 castEn 这个键** →
   * `injectMossCast(formatMossPrompt(tag), undefined)` → 一张没有人物的提示词
   * → 模型自由发挥 → 外貌服装全丢、构图也跑。
   *
   * 这里按**当前档案**重建（即「档案是唯一依据」），顺便让「按档案重新生成」在 MOSS 下也生效
   * —— 它以前走的是 SD 的锚点替换分支（`activeEngine() !== 'k2'`），
   * 而 MOSS 的 prompt 里根本没有锚点串，永远替换不到。
   */
  let castEnText = String(override.castEn ?? '');
  if (activeEngine() === 'moss' && activeOutput() === 'text' && !castEnText.trim()) {
    const names = castNamesOf(prev);
    if (names.length) {
      const snap = buildLibrarySnapshot();
      // positional 传 []（本楼临时覆盖已经随 changes 落进档案）；Infinity = 取最新状态
      const anchors = names.map((n) => ({ name: n, eff: effectiveOf(n, snap, [], Infinity) }));
      castEnText = mossCastParagraph(anchors);
      if (!castEnText.trim()) {
        warn(STAGE.BACKEND, `${position}：按档案重建人物段得到空文本 —— ${names.join('、')} 在档案库里取不到外貌字段；这张会缺外貌锚定`);
      }
    } else {
      warn(STAGE.BACKEND, `${position}：存档里没有角色名单（既无 anchors 也无 cast），无法重建人物段 —— 这只影响「重新生成」，重新分析本楼即可`);
    }
  }

  /**
   * v0.9.90：SD 口径的「按档案重新生成」。
   * SD 没有中文人物段可刷 —— 外貌锚点在出图时被 @展开/自愈烘焙进 prompt（英文 tag 串），
   * 改档案后普通重生成复读旧串（用户实测「改档案重生成不生效」）。
   * 出图时存了 anchors（角色名 → 当时的锚点串），这里按当前档案精确替换旧串。
   *
   * ★ v0.9.123：**只给 SD 用**。MOSS 的人物段是 `castEn`（不在 `prev.prompt` 里），
   *   上面已经无条件按档案重建了 —— 再走这条只会在日志里刷一堆
   *   「这些角色的旧锚点串找不到（多半被手改过）」，把人引向错误的方向。
   */
  let sdAnchorChanged = [];
  let nextAnchors = null;    // 刷新后的锚点清单（落库用；没刷新过保持 null = 沿用 prev）
  if (opts.refreshCast === 'force' && activeEngine() === 'sd') {
    const saved = Array.isArray(prev.anchors) ? prev.anchors : [];
    if (!saved.length) {
      warn(STAGE.BACKEND, '这张图没有锚点存档（旧版本出图）—— 按原提示词重出；要吃到新档案，请对该楼层重新分析生图');
    } else {
      const r = refreshAnchorsInPrompt(pText, saved, buildLibrarySnapshot());
      sdAnchorChanged = r.changed;
      if (r.changed.length) {
        pText = r.prompt;
        nextAnchors = r.nextList;
        info(STAGE.BACKEND, `${position} 外貌锚点已按档案刷新：${r.changed.join('、')}`);
      }
      if (r.missed.length) {
        warn(STAGE.BACKEND, `这些角色的旧锚点串在提示词里找不到（多半被手改过）：${r.missed.join('、')} —— 该角色保持原样`);
      }
    }
  }

  {
    const mode = opts.refreshCast || 'auto';
    const isK2 = activeEngine() === 'k2';
    const enSingle = isK2 && getActiveTemplate()?.variant === 'en';
    const handEdited = override.cast != null || !!prev.castEdited;
    if (isK2 && !enSingle && castText && mode !== 'off') {
      if (handEdited && mode !== 'force') {
        skippedByHand = true;
      } else {
        // 编排口径与 composePrompt 同源（单张覆盖 > 全局）：决定服装此刻是否独立成段
        const layoutUsed = override.promptLayout ?? prev.promptLayout ?? cfg.promptLayout ?? null;
        const separate = !!(layoutUsed && layoutUsed.costumeSeparate);
        const r = refreshCastFromLibrary(castText, { separateOutfit: separate, costumeText });
        if (r.text && r.changed.length) { castText = r.text; refreshed = r.changed; }
        if (r.costumeText != null) costumeText = r.costumeText;
      }
    }
  }

  /**
   * ★★★ v0.9.123：Layout 重生成的三层兜底 —— 绝不允许「空提示词照样出图」。
   *
   * 病例：`prev.layoutJson` 从来没被落库过 → `compileLayout(null)` 失败 → `prompt: ''`
   * → 旧代码不看返回值，把空串交给 ComfyUI → 模型按空提示词自由发挥
   * = 用户看到的「完全变成另外的图，和原来没关系了」。
   *
   * 兜底顺序：
   *   ① `prev.layoutJson` —— v0.9.123 起落库的草稿，可无损重编译（人物/坐标/台词都在）
   *   ② `prev.prompt` 本身就是草稿 JSON（早期记录）→ 当草稿编译
   *   ③ 都拿不到 → **原样重出** `prev.promptFull`（上次真正送给后端的完整文本）。
   *      语义上退化成「同一张图再抽一次」，但绝不会变成另一张毫无关系的图。
   */
  let layoutDraft = (prev.layoutJson && typeof prev.layoutJson === 'object') ? prev.layoutJson : null;
  let rawReuse = '';
  if (activeOutput() !== 'text') {
    if (!layoutDraft) layoutDraft = draftFromPrompt(prev.prompt);
    if (!layoutDraft) {
      rawReuse = String(prev.promptFull || '').trim() || String(prev.prompt || '').trim();
      if (rawReuse) {
        warn(STAGE.BACKEND, `${position}：这条记录没有 Layout 草稿（v0.9.123 之前出的图）—— 按上次的完整提示词原样重出；`
          + `要让它吃到新档案 / 新排版，对该楼重新分析一次`);
      }
    }
  }

  const composed = rawReuse
    ? { prompt: rawReuse, negative: String(prev.negative || cfg.globalNegative || '').trim(), nl: '' }
    : composePrompt(
      {
        position,
        tag: pText,
        nl: nlText,
        // K2 v4 三明治：把存档里的中文段与人物段带回来，重组才是完整结构
        scene: sceneText,
        mood: String(prev.mood || ''),
        cast: castText,
        // v0.9.53：服装段与单张段落编排一起带回来（没有就按全局编排 / 出厂顺序）
        costume: costumeText,
        /**
         * ★ v0.9.123：MOSS 口径的英文人物段（上一次漏传这张永远没有人物）。
         *   `composePrompt` 的 enSingle（MOSS）分支靠它做 `injectMossCast`。
         */
        castEn: castEnText,
        layout: override.promptLayout ?? prev.promptLayout ?? null,
        /**
         * ★ v0.9.121：Layout 输出格式的原始草稿。
         *   `layout` 是**段落编排**（另一件事），Layout JSON 必须走独立字段 ——
         *   两者同名过一次，结果是「重生成时把段落编排对象当坐标 JSON 去编译」。
         *   没有这条，layout 模版下「重新生成」永远编译失败、一张也不出。
         */
        layoutJson: layoutDraft,
        notes: prev.notes || [],
      },
      cfg,
    );

  return {
    pText,
    nlText,
    sceneText,
    castText,
    costumeText,
    castEnText,
    layoutDraft,
    rawReuse,
    refreshed,
    skippedByHand,
    sdAnchorChanged,
    nextAnchors,
    composed,
  };
}

export async function regenerate(mesId, position, override = {}, opts = {}) {
  const cfg = getConfig();
  const swipeId = swipeIdOf(Number(mesId));
  const rec = getFloorRecord(Number(mesId), swipeId);
  const prev = (rec?.results || []).find(r => String(r.position) === String(position));

  if (!prev) {
    warn(STAGE.BACKEND, `楼层 #${mesId} 找不到 ${position} 的出图记录，无法重生成`);
    return { ok: false, error: '没有该出图位的历史记录' };
  }

  const { submit } = await import('./backends/comfyui.js');

  const plan = planRegenerate(prev, override, opts);
  const {
    pText, nlText, sceneText, castText, costumeText, layoutDraft,
    refreshed, skippedByHand, sdAnchorChanged, nextAnchors, composed,
  } = plan;
  const { prompt, negative, nl } = composed;

  /**
   * ★★★ 空提示词闸：**不出**，也不许把空串交给后端。
   *   以前这条缺失，于是「编译失败 → 空 prompt → 后端照收」= 随机图。
   */
  if (!String(prompt || '').trim()) {
    const why = activeOutput() !== 'text'
      ? 'JSON 编译失败（这条记录既没有草稿、也没有可复用的完整提示词）'
      : '拼装结果为空';
    warn(STAGE.BACKEND, `${position}：${why} —— 已拦下，没有提交给生图后端（避免出一张完全无关的图）`);
    try {
      const { notifyError } = await import('./notify.js');
      notifyError(`重新生成失败 · ${position}`, `${why}；对该楼层重新分析一次即可`);
    } catch { /* 通知失败不影响判定 */ }
    return { ok: false, error: why };
  }

  info(STAGE.BACKEND, `重新生成 ${position}（楼层 #${mesId}）`);
  const { notifyInfo, notifySuccess, notifyError, failureText } = await import('./notify.js');

  /**
   * v0.9.53（A 方案）：把「人物段这次用的是档案值还是旧稿」明说给用户。
   * 服装漂移的排查成本极高 —— 用户改了档案却看到旧服装，只会以为"改了没保存"。
   */
  let castNote = '同一格出图，原图会进历史（灯箱可翻看）';
  if (sdAnchorChanged.length) {
    // v0.9.90：SD 口径 —— 锚点串已按档案替换
    castNote = `外貌锚点已按档案刷新：${sdAnchorChanged.join('、')}　·　原图进历史（灯箱可翻看）`;
  } else if (refreshed.length) {
    castNote = `人物段已按档案刷新：${refreshed.map(x => x.name).join('、')}　·　原图进历史（灯箱可翻看）`;
    info(STAGE.BACKEND, `${position} 人物段按档案刷新 ${refreshed.length} 人：${refreshed.map(x => x.name).join('、')}`);
  } else if (skippedByHand) {
    castNote = '沿用你手改过的人物段（要让档案改动生效 → 用「按档案重新生成」）　·　原图进历史';
  }
  notifyInfo(`正在重新生成 · ${position}`, castNote);
  markGenerating(Number(mesId), swipeId, position);
  render(Number(mesId));
  const reqT0 = Date.now();
  try {
    const res = await submit({ prompt, negative, nl, cfg, label: String(position) });
    // 新图同样要归档 —— 否则重生成一次反而把永久地址换成了临时地址
    let imgs = res.images || [];
    const wantArchive = cfg.storage ? cfg.storage.archive !== false : true;
    if (res.ok && imgs.length && wantArchive) {
      imgs = await archiveImages(imgs, {
        charName: getCharName(),
        position,
        promptHash: prev.hash || hash32(prev.prompt || ''),
      });
    }

    // 落一条请求历史（诊断页的「请求历史」卡片）—— 重生成和自动流程都要记
    logRequest({
      mesId,
      position,
      backend: 'comfyui',
      model: cfg?.backends?.comfyui?.model || '',
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

    saveFloorResult(Number(mesId), swipeId, {
      ...prev,
      // 编辑重生图时把改过的文本也落库（hash 保持不变 —— 记录身份跟正文槽位走）
      prompt: pText,
      nl: nlText,
      scene: sceneText,
      cast: castText,
      // v0.9.53：服装段一并落库（按档案刷新过的值），否则下次重生成的还是旧服装
      costume: costumeText,
      /**
       * v0.9.53：同步"本次真正提交出去的最终提示词"。
       * 之前 regenerate 从没写过这个字段，于是「查看提示词」永远显示第一版的
       * promptFull（K2 三明治完整五段），而「复制提示词」读的是 prompt+nl（最新版）
       * —— 同一个菜单里两个入口显示的不是同一份东西，用户以为改了没生效。
       */
      promptFull: prompt,
      /**
       * ★★★ v0.9.123：重生成也要把 Layout 草稿写回去。
       *   以前这里不写 → 第一次出图（旧版本）没存，重生成再出图也不存，
       *   于是这一格永远停在「按上次提示词原样重出」，再也吃不到新排版 / 新档案。
       */
      ...(layoutDraft && activeOutput() !== 'text' ? { layoutJson: layoutDraft } : {}),
      negative,
      // 人物段被档案刷新过 = 内容已回到档案，手改标记解除；编辑器手写的则保留标记
      castEdited: override.cast != null ? true : (refreshed.length ? false : prev.castEdited),
      // v0.9.90：锚点清单同步落库（SD 下次「按档案重新生成」还要靠它定位旧串）；
      // 没刷新过 = null → 不覆盖 prev.anchors（防止 undefined 抹掉旧值）
      ...(nextAnchors ? { anchors: nextAnchors } : {}),
      images: imgs,
      error: res.ok ? undefined : res.error,
      elapsed: res.elapsed,
      at: Date.now(),
    });
    if (res.ok) {
      const n = Array.isArray(imgs) ? imgs.length : 0;
      // 该位累计：现在的 1 张 + 历史版本数 —— 告诉用户"这段一共重新生成过多少张"
      const recNow = getFloorRecord(Number(mesId), swipeId);
      const nowRes = (recNow.results || []).find(r => String(r.position) === String(position));
      const totalNow = (Array.isArray(nowRes?.images) && nowRes.images.length ? 1 : 0)
        + (Array.isArray(nowRes?.history) ? nowRes.history.length : 0);
      notifySuccess(
        `重新生成完成 · ${position}`,
        `已插图 ${n} 张 · 这段累计 ${totalNow} 张（图两侧箭头可翻看）`,
      );
    } else {
      notifyError(`${position} 重新生成失败`, failureText(res.error));
    }
    return res;
  } finally {
    // 抛异常也不能把"生图中"挂死在正文里
    clearGenerating(Number(mesId), swipeId, position);
    render(Number(mesId));
  }
}

/** 清掉某楼层的图（调试/重来用）。 */
export function clearFloorRender(mesId) {
  const id = Number(mesId);
  const el = mesTextEl(id);
  if (el) restoreSlots(el);
  renderSig.delete(id);
  return true;
}

/** 给外部用的：刷新酒馆该楼层块。 */
export { refreshMessageBlock };
