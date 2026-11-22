/**
 * 绘灵 · 楼层扫描与触发
 *
 * 事件驱动为主（MESSAGE_RECEIVED / GENERATION_ENDED / SWIPED / EDITED / CHAT_CHANGED），
 * 10 秒低频轮询仅作事件丢失兜底 —— 这是从轮询踩过的教训里学的：
 * 双高频轮询会空转，延迟注册事件会漏事件。
 *
 * 去重靠「正文指纹」存在消息的 extra 里，而不是内存变量：
 * 刷新页面后仍能判断"这楼处理过了"，避免重复烧 API。
 */

import {
  getEventTypes, onEvent, offEvent, getLastAiMesId, getMessage, getMessageText, getChatId,
  setMessageText, isGeneratingNow,
} from './st.js';
import { cleanBody, bodyFingerprint, debounce } from './util.js';
import { getConfig, galTakeover as isGalTakeover } from './settings.js';
import { info, warn, debug, STAGE, getTaskResult } from './log.js';

const FALLBACK_INTERVAL_MS = 10000;
// 事件后的稳定等待：生成结束后，酒馆预设的变量处理/渲染脚本往往还要
// 再改正文好几秒（剧情选项、状态栏都是正文完成后才补写的），等久一点
const MIN_STABLE_DELAY_MS = 4000;
// 稳定性复核间隔：触发后先采一次指纹，隔这么久再采一次，还在变就推迟
const STABLE_RECHECK_MS = 1200;
// 推迟上限：一直不稳定就按当前文本跑（防某些扩展无限改文本导致永远不分析）
const MAX_POSTPONE = 6;

let started = false;
let fallbackTimer = null;
let retryTimer = null;
const inflight = new Map(); // mesId -> taskId
let handlers = null;

/** 取消息上的绘灵标记。 */
function getMark(mesId) {
  const msg = getMessage(mesId);
  if (!msg) return null;
  if (!msg.extra || typeof msg.extra !== 'object') msg.extra = {};
  if (!msg.extra.huilin || typeof msg.extra.huilin !== 'object') msg.extra.huilin = {};
  return msg.extra.huilin;
}

function setMark(mesId, patch) {
  const mark = getMark(mesId);
  if (!mark) return;
  Object.assign(mark, patch, { at: Date.now() });
}

function clearMark(mesId) {
  const msg = getMessage(mesId);
  if (msg?.extra?.huilin) delete msg.extra.huilin;
}

/* ============ 判定是否该跑 ============ */

function shouldRun(mesId) {
  const cfg = getConfig();
  if (!cfg.enabled) return { run: false, reason: '插件总开关未打开' };
  if (!cfg.autoRun) return { run: false, reason: '自动分析未打开' };

  const msg = getMessage(mesId);
  if (!msg || msg.is_user) return { run: false, reason: '不是 AI 楼层' };

  const body = cleanBody(getMessageText(mesId));
  const minLen = cfg.minBodyLength || 80;
  if (body.length < minLen) return { run: false, reason: `正文过短（${body.length}/${minLen}）` };

  const fp = bodyFingerprint(body);
  const mark = getMark(mesId);

  if (mark && mark.fp === fp) {
    if (mark.done) return { run: false, reason: '本楼已处理过（内容未变）' };
    if (inflight.has(mesId)) return { run: false, reason: '本楼正在处理中' };
    if (mark.attempts >= 3) return { run: false, reason: '本楼已失败 3 次，不再自动重试' };
  }
  if (inflight.has(mesId)) return { run: false, reason: '本楼正在处理中' };

  return { run: true, fp, body };
}

/** 内容变了（编辑 / swipe / 重生成）→ 清标记，允许重扫。@returns {boolean} 是否真的变了 */
function invalidate(mesId) {
  const msg = getMessage(mesId);
  if (!msg) return false;
  const mark = msg.extra?.huilin;
  const body = cleanBody(getMessageText(mesId));
  const fp = bodyFingerprint(body);
  if (mark && mark.fp !== fp) {
    clearMark(mesId);
    debug(STAGE.SCANNER, `楼层 #${mesId} 内容已变化，清除处理标记`);
    return true;
  }
  return false;
}

/* ============ 触发 ============ */

const scheduleRun = debounce((mesId) => {
  runFor(mesId);
}, MIN_STABLE_DELAY_MS);

/**
 * 跑一次管线。
 * pipeline 通过动态 import 引入，避免模块级循环依赖。
 */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function runFor(mesId) {
  /**
   * ★★★ GAL 模式下绘灵不碰正文（v0.9.168）。
   *
   * 两套插图机制在同一个楼层里是**互斥**的：
   *   · 绘灵：往正文写 `<hl_image pos="Pn">提示词</hl_image>`，自己解析、自己出图；
   *   · GAL：往正文写 `[igs-img:N]` 标记，由它的阅读器按 media 库渲染。
   *
   * 实测事故（用户 2026-10-30 截图）：GAL 模式下绘灵仍把占位符写进正文，
   * 于是阅读器中间那块空白（本该放 CG），正文里却横着一整段
   * `<hl_image pos="P38">{"summary":…}</hl_image>` 的 JSON 原文 ——
   * GAL 不认识这个标签，只能当普通文字显示。
   *
   * 所以开关一开，绘灵的**自动分析**（会写占位符的那条路）直接让位给 GAL。
   * 手动 `runManual` 不拦：用户明确点了才跑，那是他的选择。
   */
  if (isGalTakeover()) {
    debug(STAGE.SCANNER, `楼层 #${mesId} 跳过：已开启「连接 GAL」模式，插图由 GAL 自己写 [igs-img] 标记`);
    /**
     * ★★★ v0.9.179：GAL 接管时**只补跑服装态扫描**，其余全部让位。
     *
     * 拦掉整条管线的原因是后面的 `writeImagesToFloor` 会往正文写 `<hl_image>`
     * （GAL 不认识 → 正文里露出 JSON）。但「读正文判断此刻穿着 → 写进档案」
     * 这一步**完全不碰正文**，没有任何理由跟着一起停 ——
     * 停了就意味着 dyn 里的款式/状态/裸露永远停在"最后一次单独用绘灵时"，
     * 用户把服装来源切到绘灵，拿到的也是旧数据。
     *
     * 去重按**正文指纹**存进 `msg.extra.huilin.galOutfitFp`（与其它绘灵标记同一处），
     * 刷新页面后仍然有效，不会每 10 秒轮询烧一次 API。
     */
    const cfg = getConfig();
    if (cfg.galBridge?.outfitScan === false) return false;
    let body = '';
    try { body = cleanBody(getMessageText(mesId)); } catch { body = ''; }
    if (!String(body || '').trim()) return false;
    const fp = bodyFingerprint(body);
    const msg = getMessage(mesId);
    if (!msg) return false;
    if (!msg.extra || typeof msg.extra !== 'object') msg.extra = {};
    if (!msg.extra.huilin || typeof msg.extra.huilin !== 'object') msg.extra.huilin = {};
    if (msg.extra.huilin.galOutfitFp === fp) {
      debug(STAGE.SCANNER, `楼层 #${mesId} GAL 模式：正文没变，跳过服装态扫描`);
      return false;
    }
    msg.extra.huilin.galOutfitFp = fp;
    if (inflight.has(`gal-outfit:${mesId}`)) return false;
    inflight.set(`gal-outfit:${mesId}`, 'gal-outfit');
    try {
      const { runOutfitScanOnly } = await import('./pipeline.js');
      const r = await runOutfitScanOnly({ mesId, body });
      if (r?.changed) {
        info(STAGE.SCANNER,
          `楼层 #${mesId} GAL 模式：服装态已按正文更新（${(r.applied || []).length} 人）`);
      } else {
        debug(STAGE.SCANNER, `楼层 #${mesId} GAL 模式：本楼服装无需更新`);
      }
    } catch (e) {
      /* 扫描失败不能影响 GAL 出图 —— 它只是"让档案更准"的加分项 */
      debug(STAGE.SCANNER, `楼层 #${mesId} GAL 模式服装态扫描失败：${e?.message || e}`);
    } finally {
      inflight.delete(`gal-outfit:${mesId}`);
    }
    return false;
  }

  const check = shouldRun(mesId);
  if (!check.run) {
    debug(STAGE.SCANNER, `楼层 #${mesId} 跳过：${check.reason}`);
    return false;
  }
  // 主生成进行中不抢跑：流式期间正文还在变，这时分析既浪费 API 又容易和
  // 酒馆抢生成接口。等生成结束（MESSAGE_RECEIVED / 轮询兜底）再跑。
  if (isGenerationBusy()) {
    debug(STAGE.SCANNER, `楼层 #${mesId} 跳过：酒馆正在生成中，等结束后再分析`);
    return false;
  }
  if (inflight.has(mesId)) return false;

  /**
   * ★ 正文稳定性复核（v0.9.3）：
   * 生成结束后酒馆预设往往还要再改几秒正文（变量处理/渲染脚本补写
   * 剧情选项、状态栏）。只靠防抖不够 —— 拿中间态正文去分析，写回时
   * 行号错位、还会覆盖后半段。触发后前后各采一次指纹，仍在变就推迟。
   */
  const markPre = getMark(mesId);
  const postponed = markPre?.postponed || 0;
  const fpBefore = bodyFingerprint(check.body);
  await sleep(STABLE_RECHECK_MS);
  if (inflight.has(mesId)) return false;
  const fpAfter = bodyFingerprint(cleanBody(getMessageText(mesId)));
  if (fpBefore !== fpAfter && postponed < MAX_POSTPONE) {
    setMark(mesId, { postponed: postponed + 1 });
    debug(STAGE.SCANNER, `楼层 #${mesId} 正文仍在变化（第 ${postponed + 1} 次推迟），等稳定后再分析`);
    scheduleRun(mesId);
    return false;
  }

  // 等待期间文本可能已变，重新判定一遍再开跑
  const recheck = shouldRun(mesId);
  if (!recheck.run) {
    debug(STAGE.SCANNER, `楼层 #${mesId} 跳过：${recheck.reason}`);
    return false;
  }
  if (isGenerationBusy()) return false;

  const mark = getMark(mesId);
  setMark(mesId, { fp: recheck.fp, attempts: (mark?.attempts || 0) + 1, startedAt: Date.now(), postponed: 0 });

  /**
   * ★ 进入即占锁，finally 释放。
   *
   * 旧实现的两处死锁（实测"重新生成正文后没反应"的根因，2026-09-25）：
   *   ① await runPipeline() 返回**之后**才 inflight.set(taskId) —— 而管线的
   *      onDone 回调（在返回前一刻执行）已经 inflight.delete 过了，这里又把锁
   *      塞回去，且再也没人删 → 楼层被永久占锁；
   *   ② 管线挂起（generateRaw 无超时永挂）期间锁根本没登记 → 轮询每 10 秒
   *      重新起一个挂起任务（实测轮次堆到 11）。
   * 现在：运行全程占锁拦并发，结束（成败、异常、超时）一律 finally 释放。
   */
  inflight.set(mesId, 'run');
  try {
    const { runPipeline } = await import('./pipeline.js');
    await runPipeline({
      mesId,
      body: recheck.body,
      onDone: (ok) => {
        setMark(mesId, { done: ok });
      },
    });
    return true;
  } catch (err) {
    warn(STAGE.SCANNER, `楼层 #${mesId} 处理异常：${err?.message || err}`);
    return false;
  } finally {
    inflight.delete(mesId);
  }
}

/**
 * 酒馆正在生成中？（流式/请求进行中）
 * v0.9.33：原来是 `globalThis.is_send_press === true`，恒为 false —— ST 1.18 的
 * is_send_press 是 `export let`，ESM 导出不挂 globalThis（详见 st.js 的注释）。
 * 这条判定失效意味着扫描器会在流式输出期间反复对半成品正文做分析。
 * 现在统一走 st.js 的 isGeneratingNow()。
 */
function isGenerationBusy() {
  try {
    return isGeneratingNow();
  } catch {
    return false;
  }
}

/* ============ 事件 ============ */

/**
 * 新消息/生成结束 → 触发扫描。
 *
 * 事件参数的坑（都对齐过 ST 1.18 源码）：
 *   - MESSAGE_RECEIVED(流式完成) 第一个参数是 messageId —— 重生成历史楼时
 *     它**不是**最后一楼，必须用它，否则永远只扫最后一楼（用户重生成旧楼
 *     绘灵毫无反应的根因）；
 *   - GENERATION_ENDED 的参数是 chat.length（楼层数，不是 mesId！），
 *     getMessage(chat.length) 拿不到消息 → 落回最后一楼，正好正确。
 */
function onNewMessage(evtMesId) {
  const n = Number(evtMesId);
  const argIsFloor = Number.isInteger(n) && n >= 0 && !!getMessage(n) && !getMessage(n).is_user;
  const mesId = argIsFloor ? n : getLastAiMesId();
  if (mesId < 0) return;
  scheduleRun(mesId);
}

function onMessageChanged(mesId) {
  if (mesId == null) return;
  const id = Number(mesId);
  // invalidate 返回"是否真的变了"，让用户能在诊断页看到触发被受理
  const changed = invalidate(id);
  if (changed) info(STAGE.SCANNER, `楼层 #${id} 正文已变化（编辑/重生成/续写），将重新分析生图`);
  scheduleRun(id);
}

function onChatChanged() {
  inflight.clear();
  info(STAGE.SCANNER, '聊天已切换，扫描状态已重置');
}

export function startScanner() {
  if (started) return;
  started = true;

  const types = getEventTypes();
  handlers = {
    onNewMessage,
    onMessageChanged,
    onChatChanged,
  };

  let bound = 0;
  if (types.MESSAGE_RECEIVED) { onEvent(types.MESSAGE_RECEIVED, handlers.onNewMessage); bound += 1; }
  if (types.GENERATION_ENDED) { onEvent(types.GENERATION_ENDED, handlers.onNewMessage); bound += 1; }
  // ★ CHARACTER_MESSAGE_RENDERED = 楼层真正渲染完成的信号：
  // ST 的 GENERATION_ENDED 会早于最终渲染发出（预设的变量处理/渲染脚本还没
  // 跑完），拿那时的正文分析会漏掉后半段。渲染完成事件才是"正文+预设+渲染
  // 都齐了"的可靠锚点；RECEIVED/ENDED 保留作兜底（稳定性复核会拦住还在变的文本）。
  if (types.CHARACTER_MESSAGE_RENDERED) { onEvent(types.CHARACTER_MESSAGE_RENDERED, handlers.onNewMessage); bound += 1; }
  if (types.MESSAGE_SWIPED) { onEvent(types.MESSAGE_SWIPED, handlers.onMessageChanged); bound += 1; }
  if (types.MESSAGE_EDITED) { onEvent(types.MESSAGE_EDITED, handlers.onMessageChanged); bound += 1; }
  // MESSAGE_UPDATED 是"正文被改"的兜底网：其他扩展（酒馆助手等）改写消息后
  // 往往只发它而不发 MESSAGE_EDITED —— 不绑的话重生成/编辑旧楼就毫无反应
  if (types.MESSAGE_UPDATED) { onEvent(types.MESSAGE_UPDATED, handlers.onMessageChanged); bound += 1; }
  if (types.CHAT_CHANGED) { onEvent(types.CHAT_CHANGED, handlers.onChatChanged); bound += 1; }

  if (bound) info(STAGE.SCANNER, `已绑定 ${bound} 个酒馆事件`);
  else warn(STAGE.SCANNER, '未绑定到任何酒馆事件，仅靠低频轮询（可能漏触发）');

  fallbackTimer = setInterval(() => {
    try {
      const cfg = getConfig();
      if (!cfg.enabled || !cfg.autoRun) return;
      const mesId = getLastAiMesId();
      if (mesId >= 0) scheduleRun(mesId);
    } catch { /* 轮询异常不影响主流程 */ }
  }, FALLBACK_INTERVAL_MS);
}

export function stopScanner() {
  started = false;
  if (fallbackTimer) { clearInterval(fallbackTimer); fallbackTimer = null; }
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }

  const types = getEventTypes();
  if (handlers) {
    if (types.MESSAGE_RECEIVED) offEvent(types.MESSAGE_RECEIVED, handlers.onNewMessage);
    if (types.GENERATION_ENDED) offEvent(types.GENERATION_ENDED, handlers.onNewMessage);
    if (types.CHARACTER_MESSAGE_RENDERED) offEvent(types.CHARACTER_MESSAGE_RENDERED, handlers.onNewMessage);
    if (types.MESSAGE_SWIPED) offEvent(types.MESSAGE_SWIPED, handlers.onMessageChanged);
    if (types.MESSAGE_EDITED) offEvent(types.MESSAGE_EDITED, handlers.onMessageChanged);
    if (types.MESSAGE_UPDATED) offEvent(types.MESSAGE_UPDATED, handlers.onMessageChanged);
    if (types.CHAT_CHANGED) offEvent(types.CHAT_CHANGED, handlers.onChatChanged);
  }
  handlers = null;
}

export function isRunning() { return started; }
export function inflightCount() { return inflight.size; }

/** 手动重跑某楼（UI 按钮用）。 */
export async function forceRerun(mesId) {
  clearMark(mesId);
  inflight.delete(mesId);
  return runFor(mesId);
}

/* ============ 手动触发（兜底通道） ============ */

/**
 * 把管线任务结果翻译成「手动生图」的结果 —— 纯函数，可单测。
 *
 * ★★ v0.9.105 核心：`runPipeline` 内部失败**不抛异常**（它只 failTask + return taskId），
 *   所以调用方必须回读 `getTaskResult()`，否则「出词 API 报错 / 模型返回空 /
 *   位置全对不上 / 预览取消」全都会被当成成功 —— 用户看到「✓ 完成」但图没变。
 *
 * 三档语义，别合并：
 *   ok:false            → 真失败（带原因）
 *   ok:true, skipped    → 跑完了但什么都没做（无配图 / 位置对不上 / 用户取消）
 *   ok:true             → 真出图了
 *
 * @param {{ok:boolean|null, reason?:string, cause?:string, fix?:string, skipped?:boolean}|null} res
 * @returns {{ok:boolean, skipped?:boolean, reason?:string, cause?:string, fix?:string}}
 */
export function manualResultFrom(res) {
  if (!res) return { ok: true };
  if (res.ok === false) {
    return {
      ok: false,
      reason: res.reason || '处理失败（详见诊断页）',
      cause: res.cause || '',
      fix: res.fix || '',
    };
  }
  if (res.skipped) {
    return { ok: true, skipped: true, reason: res.reason || '跳过（未出图）' };
  }
  return { ok: true, reason: res.reason || '' };
}

/**
 * 手动跑某一楼 —— 「手动生图」页专用。
 *
 * 与自动通道（runFor）的区别，也是它存在的意义：
 *   - **不看 autoRun**：自动分析关着也能跑（用户手动点就是想要跑）；
 *   - **不看 attempts / done 标记**：出过图、失败过的楼也能再跑；
 *   - **不做稳定性复核**：手动点是人判断"正文已经定了"，不再等它稳定；
 *   - 仍然占锁（防同一楼并发），仍然 finally 释放。
 *
 * @param {number} mesId
 * @param {{body?: string, writeBody?: boolean}} [opts]
 *   body       —— 用这份正文去分析（默认取楼层现正文）
 *   writeBody  —— 把 body 先写回该楼层。改过正文时**必须**为 true，
 *                 否则写回阶段会因指纹不符主动放弃（图插不进正文，白跑一次 API）。
 * @returns {Promise<{ok: boolean, reason?: string}>}
 */
export async function runManual(mesId, opts = {}) {
  const cfg = getConfig();
  if (!cfg.enabled) return { ok: false, reason: '插件总开关未打开（「基本」页里打开）' };

  const msg = getMessage(mesId);
  if (!msg) return { ok: false, reason: '楼层不存在' };
  if (inflight.has(mesId)) {
    // 自动通道正在跑这楼时，默认互斥（同时跑两次会重复烧 API、写回还会互相踩）。
    // 但手动通道是兜底入口 —— 用户点它往往正是因为自动那次"好像没动静"，
    // 所以给一个强制出口：force=true 直接接管（旧任务自己跑完会释放锁）。
    if (!opts.force) return { ok: false, reason: '本楼正在处理中（勾「强制重跑」可打断重来）' };
    inflight.delete(mesId);
    warn(STAGE.SCANNER, `楼层 #${mesId}：手动强制接管（原任务仍在跑，其写回可能后到）`);
  }

  const custom = typeof opts.body === 'string' ? opts.body : null;

  // 自定义正文 + 要求写回 → 先落盘，保证后面写回正文时指纹对得上
  if (custom != null && opts.writeBody) {
    const okWrite = setMessageText(mesId, custom);
    if (!okWrite) return { ok: false, reason: '正文写回楼层失败（该楼可能刚被改动，已放弃以免覆盖）' };
  }

  const raw = custom != null ? custom : getMessageText(mesId);
  const body = cleanBody(raw);
  if (!body.trim()) return { ok: false, reason: '正文为空' };

  clearMark(mesId);
  inflight.set(mesId, 'manual');
  try {
    const { runPipeline } = await import('./pipeline.js');
    const taskId = await runPipeline({
      mesId,
      body,
      onDone: (ok) => setMark(mesId, { done: ok, manual: true }),
      /**
       * v0.9.53：手动生图可选「预览后出图」—— 分析完先弹预览编辑器，
       * 用户看完/改完/给 AI 下完指令，点「开始生图」才继续。
       */
      ...(opts.preview ? {
        onPreview: (processed, resolve) => {
          import('./render.js').then(({ showPreviewEditor }) => showPreviewEditor(processed, resolve));
        },
      } : {}),
    });

    /**
     * ★★ v0.9.105：管线内部失败**不抛异常**，它只是 failTask + return taskId。
     *   过去这里无条件 `return { ok: true }` —— 于是「出词 API 报错 / 模型返回空 /
     *   位置全对不上 / 预览取消」全都被 UI 显示成「✓ 完成」，
     *   用户看到的是「点开始 → 立即完成 → 图没变」，以为重跑没生效。
     *
     *   现在必须回读任务结果，把 ok / skipped / 原因原样透传给 UI。
     */
    // 管线只有「总开关被关」会返回 null —— 那也算没跑，不能报成功
    if (!taskId) return { ok: false, reason: '管线没有启动（插件总开关在这一瞬间被关掉了？）' };
    return manualResultFrom(getTaskResult(taskId));
  } catch (err) {
    warn(STAGE.SCANNER, `楼层 #${mesId} 手动处理异常：${err?.message || err}`);
    return { ok: false, reason: err?.message || String(err) };
  } finally {
    inflight.delete(mesId);
  }
}

/**
 * 手动批量跑多个楼层 —— 串行执行。
 *
 * 为什么不并发：一次分析要几十秒、一次生图要一分钟级别，并发会把
 * 出词 API 和 ComfyUI 一起打满，且正文写回互相踩。串行 + 小间隔最稳。
 *
 * @param {number[]} ids
 * @param {{body?: string, writeBody?: boolean, onProgress?: Function, shouldStop?: Function, gapMs?: number}} [opts]
 * @returns {Promise<Array<{mesId:number, ok:boolean, reason?:string, stopped?:boolean}>>}
 */
export async function runManualMany(ids, opts = {}) {
  const { onProgress, shouldStop, gapMs = 600 } = opts;
  const list = (Array.isArray(ids) ? ids : []).map(Number).filter(Number.isInteger);
  const out = [];
  let stopped = false;

  for (const id of list) {
    if (typeof shouldStop === 'function' && shouldStop()) { stopped = true; break; }
    onProgress?.(id, 'running');
    const r = await runManual(id, opts);
    onProgress?.(id, r.ok ? 'done' : 'fail', r);
    out.push({ mesId: id, ...r });
    if (gapMs && !stopped) await sleep(gapMs);
  }
  if (stopped) out.push({ mesId: -1, ok: false, reason: '已手动停止', stopped: true });
  return out;
}

/** 扫描当前聊天里所有未处理的 AI 楼层（UI 按钮用）。 */
export async function scanAll() {
  if (isGalTakeover()) {
    warn(STAGE.SCANNER,
      '已开启「连接 GAL」模式：插图由 GAL 写 [igs-img] 标记并渲染，绘灵不再扫描正文。'
      + '要出图请用 GAL 阅读器上的「绘制 CG」。');
    return 0;
  }
  const { getChat } = await import('./st.js');
  const chat = getChat();
  let n = 0;
  for (let i = 0; i < chat.length; i += 1) {
    if (chat[i]?.is_user) continue;
    const check = shouldRun(i);
    if (check.run) { n += 1; scheduleRun(i); }
  }
  info(STAGE.SCANNER, `已排队 ${n} 个楼层待处理`);
  return n;
}
