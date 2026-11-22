/**
 * 用量记账（v0.9.143 新增）
 *
 * 为什么要有：用户原话 ——「我不看后台都不知道被烧了这么多」。
 * 插件的出词通道是直连付费端点的，但 `api.js` 里 grep `usage` 一处都没有，
 * 用户在酒馆里**完全看不到自己花了多少**，只能去 DeepSeek 后台翻，
 * 而后台粒度是小时，且和别的工具混在一起，根本对不上账。
 *
 * 本模块只做三件事：
 *   ① 每次真实请求把 `usage` 记下来（含缓存命中 token —— DeepSeek 会返回
 *      `prompt_cache_hit_tokens`，命中价约是未命中的 1/30，这是唯一能看出
 *      「提示词到底有没有被缓存」的地方）
 *   ② 按天汇总，保留 14 天
 *   ③ 按可配置单价估算金额（默认填 DeepSeek 公开价，用户可改）
 *
 * ★ 价格是**估算**，不是账单。真实扣费以 DeepSeek 后台为准。
 * ★ 只记 token，不记任何提示词内容 —— 不做隐私采集。
 */
import { settingsRoot, saveSettings } from './settings.js';

/**
 * 默认单价（元 / 百万 token）。
 * 依据：DeepSeek-V4-Flash 2026-08-17 调价后的人民币价（空闲时段）。
 *   - 输入·缓存命中 0.05 / 输入·缓存未命中 1.5 / 输出 4.5
 *   - 高峰时段（北京 09:00-12:00、14:00-18:00，周一至周五）**全部翻倍**
 * 价格会变，所以放在配置里让用户自己改；这里只是出厂默认。
 */
export const DEFAULT_PRICE = { hit: 0.05, miss: 1.5, out: 4.5, peakMul: 2 };

const KEEP_DAYS = 14;
const USAGE_KEY = 'usage';

/** 本地日期键 YYYY-MM-DD（按用户本地时区，不用 UTC —— 用户看的是自己的日期）。 */
export function dayKey(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 是否高峰时段（北京 09:00-12:00、14:00-18:00，周一至周五）。周末与节假日全天空闲。 */
export function isPeak(d = new Date()) {
  const wd = d.getDay();
  if (wd === 0 || wd === 6) return false;
  const h = d.getHours();
  return (h >= 9 && h < 12) || (h >= 14 && h < 18);
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 从各家格式的 `usage` 里抠出 (prompt, completion, total, hit, miss)。 */
export function parseUsage(u) {
  const o = u && typeof u === 'object' ? u : {};
  const prompt = num(o.prompt_tokens ?? o.input_tokens ?? o.promptTokens);
  const completion = num(o.completion_tokens ?? o.output_tokens ?? o.completionTokens);
  const total = num(o.total_tokens) || (prompt + completion);
  /* DeepSeek 专有：命中/未命中分开计。有的端点只给 hit，miss 用差值补。 */
  let hit = num(o.prompt_cache_hit_tokens ?? o.cache_hit_tokens);
  let miss = num(o.prompt_cache_miss_tokens ?? o.cache_miss_tokens);
  if (!miss && prompt) miss = Math.max(0, prompt - hit);
  if (!hit && !miss && prompt) miss = prompt;
  return { prompt, completion, total, hit, miss };
}

function rootUsage(create = true) {
  const root = settingsRoot();
  if (!root[USAGE_KEY] || typeof root[USAGE_KEY] !== 'object') {
    if (!create) return null;
    root[USAGE_KEY] = { days: {}, last: null, price: { ...DEFAULT_PRICE } };
  }
  const u = root[USAGE_KEY];
  if (!u.days || typeof u.days !== 'object') u.days = {};
  if (!u.price || typeof u.price !== 'object') u.price = { ...DEFAULT_PRICE };
  else for (const k of Object.keys(DEFAULT_PRICE)) {
    if (!Number.isFinite(Number(u.price[k]))) u.price[k] = DEFAULT_PRICE[k];
  }
  return u;
}

function pruneDays(days, today = new Date()) {
  const keep = new Set();
  for (let i = 0; i < KEEP_DAYS; i += 1) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    keep.add(dayKey(d));
  }
  for (const k of Object.keys(days)) if (!keep.has(k)) delete days[k];
}

/**
 * 记一次真实调用。**只认真的拿到了 usage 的请求** ——
 * 拿不到就什么都不记，免得把「0 token」也画进统计里骗人。
 * @returns {object|null} 本次记录（拿不到 usage 时返回 null）
 */
export function record(usage, opts = {}) {
  const p = parseUsage(usage);
  if (!p.total) return null;
  const u = rootUsage(true);
  const now = new Date();
  const peak = isPeak(now);
  const source = String(opts.source || '未标注').slice(0, 40);
  const model = String(opts.model || '').slice(0, 40);

  const key = dayKey(now);
  const day = u.days[key] || (u.days[key] = {
    calls: 0, prompt: 0, completion: 0, total: 0, hit: 0, miss: 0, peakCalls: 0, bySource: {},
  });
  day.calls += 1;
  day.prompt += p.prompt;
  day.completion += p.completion;
  day.total += p.total;
  day.hit += p.hit;
  day.miss += p.miss;
  if (peak) day.peakCalls += 1;

  const bs = day.bySource[source] || (day.bySource[source] = { calls: 0, total: 0 });
  bs.calls += 1;
  bs.total += p.total;

  u.last = { ...p, source, model, peak, at: now.getTime() };
  pruneDays(u.days, now);
  /* 一次分析最多几次请求，防抖保存足够；失败不阻断出图。 */
  try { saveSettings(); } catch { /* 静默 */ }
  return u.last;
}

/** 按单价估算金额（元）。peak 调用按 peakMul 加价 —— 混合时段也尽量算准。 */
export function costOf(stat, price = DEFAULT_PRICE) {
  const pr = { ...DEFAULT_PRICE, ...(price || {}) };
  const peakCalls = num(stat?.peakCalls);
  const calls = num(stat?.calls);
  const mul = num(pr.peakMul) || 2;
  /* 没有 peakCalls 记录时按全空闲算（保守，宁可少报不虚报）。 */
  const peakShare = calls ? Math.min(1, peakCalls / calls) : 0;
  const factor = 1 + peakShare * (mul - 1);
  const hit = num(stat?.hit) * num(pr.hit);
  const miss = num(stat?.miss) * num(pr.miss);
  const out = num(stat?.completion) * num(pr.out);
  return ((hit + miss + out) / 1e6) * factor;
}

/** 今天的汇总 + 累计。 */
export function snapshot() {
  const u = rootUsage(false);
  const empty = { calls: 0, prompt: 0, completion: 0, total: 0, hit: 0, miss: 0, peakCalls: 0, bySource: {} };
  if (!u) return { today: { ...empty }, last: null, price: { ...DEFAULT_PRICE }, days: [] };
  const today = u.days[dayKey()] || { ...empty, bySource: {} };
  const days = Object.entries(u.days).sort((a, b) => (a[0] < b[0] ? 1 : -1));
  const sum = { ...empty, bySource: {} };
  for (const [, d] of days) {
    for (const k of ['calls', 'prompt', 'completion', 'total', 'hit', 'miss', 'peakCalls']) sum[k] += num(d[k]);
  }
  return {
    today: { ...today, bySource: { ...(today.bySource || {}) } },
    all: sum,
    last: u.last || null,
    price: u.price,
    days: days.map(([k, d]) => ({ date: k, ...d })),
  };
}

/** 缓存命中率（0~1）。没有 prompt token 时返回 0。 */
export function cacheRate(stat) {
  const prompt = num(stat?.prompt);
  if (!prompt) return 0;
  return Math.min(1, num(stat?.hit) / prompt);
}

/** 给 UI 用的一行人话。 */
export function usageLine() {
  const s = snapshot();
  const t = s.today;
  if (!t.calls) {
    return '今日还没有调用记录（只有真的拿到 usage 的请求才会记）';
  }
  const rate = Math.round(cacheRate(t) * 100);
  const cny = costOf(t, s.price);
  const perCall = Math.round(t.total / t.calls);
  return `今日 ${t.calls} 次 · ${t.total.toLocaleString()} tok（缓存命中 ${rate}%）`
    + ` · 平均 ${perCall.toLocaleString()} tok/次 · 约 ¥${cny.toFixed(3)}`;
}

/** 供「清零」按钮用：只清统计，不动配置。 */
export function clearUsage() {
  const root = settingsRoot();
  delete root[USAGE_KEY];
  try { saveSettings(); } catch { /* 静默 */ }
}
