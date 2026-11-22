/**
 * 绘灵 · 出图通知（对齐 toastr 体验）
 *
 * 正在调用独立 API 生图 → 成功提示插了几张图 → 失败提示原因。
 * 走酒馆全局 toastr（window.toastr），不可用时静默降级到控制台，绝不影响主流程。
 *
 * 开关：config.notify（默认开）。设置面板「基本」里有开关。
 */

import { getConfig } from './settings.js';
import { debug, STAGE } from './log.js';

function toastr() {
  try {
    const t = globalThis.toastr || globalThis()?.toastr;
    return (t && typeof t.info === 'function') ? t : null;
  } catch {
    return null;
  }
}

/** 错误串只弹第一句，堆栈帧不进气泡。 */
function head(msg, cap = 90) {
  const s = String(msg || '').split('\n')[0].trim();
  return s.length > cap ? `${s.slice(0, cap)}…` : s;
}

function enabled() {
  try { return getConfig().notify !== false; } catch { return true; }
}

function show(kind, title, message, opts = {}) {
  if (!enabled()) return;
  const t = toastr();
  if (!t) {
    debug(STAGE.UI, `[通知降级] ${title} ${message || ''}`);
    return;
  }
  try {
    const text = [title, message].filter(Boolean).join('<br>');
    t[kind](text, '绘灵', { timeOut: opts.timeOut ?? (kind === 'error' ? 8000 : 4000), ...opts.toastr });
  } catch (err) {
    debug(STAGE.UI, `toastr 调用失败：${err?.message || err}`);
  }
}

/** 常规提示（开始分析/开始生图）。 */
export function notifyInfo(title, message = '') {
  show('info', title, message);
}

/** 成功（图插好了）。 */
export function notifySuccess(title, message = '') {
  show('success', title, message);
}

/** 失败（带原因首句）。 */
export function notifyError(title, message = '') {
  show('error', title, message, { timeOut: 8000 });
}

/** 生图失败原因的展示口径：槽位错误 / 异常消息统一走这里。 */
export function failureText(err) {
  return head(err);
}
