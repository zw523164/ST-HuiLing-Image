/**
 * 绘灵 · 日志与诊断中心
 *
 * 这是从「失败要留痕」演化来的那一层。核心主张：
 * 失败时不要只说「生图失败」，要说清三件事 ——
 *   ① 卡在哪个阶段（stage）
 *   ② 现象是什么（symptom）
 *   ③ 最可能的原因和该怎么修（cause / fix）
 *
 * 分阶段标签（stage）固定，不允许自由发挥，这样诊断面板能按阶段聚合：
 *   boot  init  scanner  prompts  api  protocol  consistency  backend  render  ui
 */

export const STAGE = {
  BOOT: 'boot',
  INIT: 'init',
  SCANNER: 'scanner',
  PROMPTS: 'prompts',
  API: 'api',
  PROTOCOL: 'protocol',
  CONSISTENCY: 'consistency',
  BACKEND: 'backend',
  RENDER: 'render',
  UI: 'ui',
  /** 外部前端（GAL / IGS）借用写词与出图 —— 见 modules/galBridge.js */
  GAL: 'gal',
};

/** 阶段中文名，供诊断面板显示 */
export const STAGE_LABEL = {
  boot: '启动',
  init: '初始化',
  scanner: '扫描楼层',
  prompts: '拼装提示词',
  api: '调用模型',
  protocol: '解析输出',
  consistency: '一致性校验',
  backend: '提交生图',
  render: '写回正文',
  ui: '界面',
  gal: 'GAL 联动',
};

const MAX_ENTRIES = 500;
const entries = [];
const subscribers = new Set();

let mirrorToConsole = true;

/** 订阅日志变化（诊断面板用）。返回取消订阅函数。 */
export function subscribe(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export function setConsoleMirror(on) {
  mirrorToConsole = !!on;
}

export function getEntries(filter) {
  if (!filter) return entries.slice();
  return entries.filter(e => {
    if (filter.level && e.level !== filter.level) return false;
    if (filter.stage && e.stage !== filter.stage) return false;
    if (filter.taskId && e.taskId !== filter.taskId) return false;
    return true;
  });
}

export function clearEntries() {
  entries.length = 0;
  notify();
}

function notify(entry) {
  for (const fn of subscribers) {
    try { fn(entry, entries); } catch { /* 订阅方异常不影响主流程 */ }
  }
}

function push(level, stage, msg, extra) {
  const e = {
    t: Date.now(),
    level,
    stage: STAGE_LABEL[stage] || stage,
    stageKey: stage,
    msg: String(msg ?? ''),
    ...extra,
  };
  entries.push(e);
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);

  if (mirrorToConsole && typeof console !== 'undefined') {
    const tag = `[绘灵·${e.stage}]`;
    if (level === 'error') console.error(tag, e.msg, extra?.data ?? '');
    else if (level === 'warn') console.warn(tag, e.msg, extra?.data ?? '');
    else if (level !== 'debug') console.log(tag, e.msg, extra?.data ?? '');
  }
  notify(e);
  return e;
}

/* ============ 基础四级 ============ */

export function debug(stage, msg, data) { return push('debug', stage, msg, { data }); }
export function info(stage, msg, data) { return push('info', stage, msg, { data }); }
export function warn(stage, msg, data) { return push('warn', stage, msg, { data }); }
export function error(stage, msg, data) { return push('error', stage, msg, { data }); }

/**
 * 结构化诊断 —— 这是诊断层的核心出口。
 *
 * @param {string} stage   阶段
 * @param {string} symptom 现象（用户视角看得见的那句话）
 * @param {object} advice  { cause: 最可能原因, fix: 该怎么做 }
 * @param {any}    data    原始数据（堆栈/响应体/节点名…）
 */
export function diagnose(stage, symptom, advice = {}, data) {
  return push('error', stage, symptom, {
    diag: true,
    cause: advice.cause || '',
    fix: advice.fix || '',
    data,
  });
}

/* ============ 任务追踪 ============ */

let taskSeq = 0;
const activeTasks = new Map();

/**
 * 开一次管线任务。诊断面板据此把同一个楼层的日志串成一条时间线。
 * @returns {string} taskId
 */
export function beginTask(label, meta = {}) {
  taskSeq += 1;
  const taskId = `T${taskSeq}`;
  activeTasks.set(taskId, {
    id: taskId,
    label,
    meta,
    startedAt: Date.now(),
    endedAt: null,
    ok: null,
    steps: [],
  });
  push('info', STAGE.INIT, `任务开始：${label}`, { taskId, data: meta });
  return taskId;
}

/** 给进行中的任务记一步。 */
export function step(taskId, stage, msg, data) {
  const t = activeTasks.get(taskId);
  if (t) t.steps.push({ t: Date.now(), stage: STAGE_LABEL[stage] || stage, msg });
  return push('info', stage, msg, { taskId, data });
}

/**
 * 任务失败（带诊断）。
 *
 * ★ v0.9.105：`t.reason` 必须落下来。
 *   过去失败只写日志、任务对象上只留 `ok=false`，而调用方（runManual）
 *   拿不到任何信息 → 一律当成功 → UI 显示「✓ 完成」。
 *   用户报「点了开始立即完成、图没变」，根因就是这条链断了。
 */
export function failTask(taskId, stage, symptom, advice = {}, data) {
  const t = activeTasks.get(taskId);
  if (t) {
    t.ok = false;
    t.endedAt = Date.now();
    t.failedStage = STAGE_LABEL[stage] || stage;
    t.reason = String(symptom || '');
    t.cause = String(advice.cause || '');
    t.fix = String(advice.fix || '');
  }
  return push('error', stage, symptom, { taskId, diag: true, cause: advice.cause || '', fix: advice.fix || '', data });
}

/**
 * 任务成功结束。
 *
 * @param {object} [opts] { skipped: true } —— 「成功但什么都没做」。
 *   ★ v0.9.105：无配图 / 预览取消 / 写回失败这些分支以前一律 `ok = true`，
 *     调用方和 UI 都当成了「跑完了，图出好了」。它们其实是**跳过**，
 *     必须与真正的完成区分开，否则用户只看到「✓ 完成」却什么都没变。
 */
export function endTask(taskId, summary, data, opts = {}) {
  const t = activeTasks.get(taskId);
  if (t) {
    t.ok = true;
    t.endedAt = Date.now();
    t.reason = String(summary || '');
    t.skipped = opts?.skipped === true;
  }
  return push('info', STAGE.RENDER, summary, { taskId, data });
}

/**
 * 取一次任务的结果 —— 管线内部失败/跳过时，调用方靠它才知道真相。
 * @returns {{ok:boolean|null, reason:string, cause:string, fix:string, skipped:boolean, failedStage:string}|null}
 */
export function getTaskResult(taskId) {
  const t = activeTasks.get(taskId);
  if (!t) return null;
  return {
    ok: t.ok,
    reason: t.reason || '',
    cause: t.cause || '',
    fix: t.fix || '',
    skipped: t.skipped === true,
    failedStage: t.failedStage || '',
  };
}

/** 供诊断面板取任务列表（按开始时间倒序，最多给 50 条）。 */
export function getTasks() {
  return Array.from(activeTasks.values())
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, 50);
}

/** 最近一次失败，UI 顶部横幅用。 */
export function lastFailure() {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    if (entries[i].diag) return entries[i];
  }
  return null;
}

/** 导出成可粘贴的文本，方便用户求助时直接甩出来。 */
export function exportText() {
  const lines = [
    '=== 绘灵诊断报告 ===',
    `导出时间：${new Date().toLocaleString()}`,
    `日志条目数：${entries.length}`,
    '',
    '── 请求历史（最近 20 条）──',
  ];
  for (const r of getRequests().slice(0, 20)) {
    lines.push([
      `[${new Date(r.at).toLocaleTimeString()}] ${r.ok ? '✓' : '✗'} ${r.position || ''} · ${r.backend || ''}${r.model ? ` / ${r.model}` : ''} · 耗时 ${r.durationMs != null ? `${(r.durationMs / 1000).toFixed(1)}s` : '?'}`,
      `  prompt: ${r.prompt || '(空)'}`,
      r.nl ? `  nl: ${r.nl}` : '',
      r.error ? `  错误: ${r.error}` : '',
    ].filter(Boolean).join('\n'));
  }
  lines.push('', '── 日志 ──');
  for (const e of entries) {
    const ts = new Date(e.t).toLocaleTimeString();
    let line = `[${ts}][${e.level}][${e.stage}] ${e.msg}`;
    if (e.cause) line += `\n    ↳ 可能原因：${e.cause}`;
    if (e.fix) line += `\n    ↳ 建议：${e.fix}`;
    lines.push(line);
  }
  return lines.join('\n');
}

/* ============ 请求历史 ============ *
 *
 * 对标「请求历史」页的做法：每次生图请求落一条结构化记录
 * （谁、用什么模型、发了什么提示词、多久、成没成、错在哪），
 * 而不是让用户在一串流水日志里自己拼时间线。
 *
 * 存 localStorage 而不是 settings.json：这是本机诊断数据，
 * 混进配置会跟着酒馆的设置同步/导出到处跑，纯属污染。
 */

const REQ_KEY = 'huilin.requestHistory.v1';
const MAX_REQUESTS = 60;

function loadRequests() {
  try {
    const raw = globalThis.localStorage?.getItem(REQ_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

let requests = loadRequests();

function saveRequests() {
  try { globalThis.localStorage?.setItem(REQ_KEY, JSON.stringify(requests)); } catch { /* 存储满/隐私模式就算了 */ }
}

/**
 * 落一条生图请求记录（完成时调用，成功失败都记）。
 * @param {object} req { position, backend, model, prompt, nl, negative,
 *                       ok, error, errStack, durationMs, images, mesId, at? }
 */
export function logRequest(req) {
  if (!req || typeof req !== 'object') return;
  const clip = (s, n) => String(s ?? '').slice(0, n);
  /**
   * v0.9.98 · 拼装结构（诊断用）。
   * ★ 必须裁剪：localStorage 只有几 MB，每段只留"项数 / 字符数 / 起始位置"这几个数字，
   *   不存段文本（正文里已经有最终 prompt 了）。
   */
  const st = req.structure;
  const structure = (st && typeof st === 'object') ? {
    engine: clip(st.engine, 8),
    mode: clip(st.mode, 12),
    approxTotal: Number(st.approxTotal) || 0,
    hasBreak: !!st.hasBreak,
    segments: Array.isArray(st.segments) ? st.segments.slice(0, 16).map((s) => ({
      id: clip(s?.id, 12),
      items: Number(s?.items) || 0,
      chars: Number(s?.chars) || 0,
      at: Number(s?.at) || 0,
      approxToken: Number(s?.approxToken) || 0,
    })) : [],
  } : null;
  requests.unshift({
    at: req.at || Date.now(),
    mesId: req.mesId,
    position: clip(req.position, 12),
    backend: clip(req.backend, 24),
    model: clip(req.model, 80),
    prompt: clip(req.prompt, 2000),
    nl: clip(req.nl, 1000),
    negative: clip(req.negative, 500),
    ok: !!req.ok,
    error: clip(req.error, 500),
    errStack: clip(req.errStack, 1500),
    durationMs: Number(req.durationMs) || null,
    images: Number(req.images) || 0,
    structure,
  });
  if (requests.length > MAX_REQUESTS) requests.length = MAX_REQUESTS;
  saveRequests();
  notify();
}

/** 供诊断面板取请求历史（新→旧）。 */
export function getRequests() {
  return requests.slice();
}

export function clearRequests() {
  requests = [];
  saveRequests();
  notify();
}
