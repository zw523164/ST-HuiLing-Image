/**
 * 绘灵 · OpenAI 兼容图像 API 后端
 *
 * 覆盖面最广的一个后端：官方 OpenAI 的 `/v1/images/generations`，
 * 以及所有照这个形状实现的端点 —— Gemini 的 OpenAI 兼容层、各家中转/聚合站、
 * 本地跑的自建服务。用户要「填自己的 API」，填的就是这里。
 *
 * 「兼容」两个字在实践中意味着：字段名一样，但**收不收、认不认各有脾气**。
 * 所以这个后端的原则是「能少发一个字段就少发一个」：
 *   · size / quality / response_format / output_format 一律**留空即不传**
 *     （gpt-image-1 不接受 response_format，dall-e-3 不接受 quality=auto，
 *      多传一个就被 400 顶回来 —— 这是最常见的「照着文档填了却报错」）
 *   · 实在有端点需要额外字段，用「额外参数」直接塞 JSON，不用改代码
 *
 * 端点：POST {baseUrl}/images/generations
 * 认证：Authorization: Bearer <key>
 */

import { getConfig } from '../settings.js';
import { collectImagesFromJson, extractErrorMessage, sniffImageBytes, bytesToBase64 } from './imagedata.js';
import { info, warn, debug, diagnose, STAGE } from '../log.js';

export const meta = {
  key: 'openai',
  name: 'OpenAI 兼容',
  short: 'OpenAI',
  hint: 'images/generations 口径：官方 / 中转 / Gemini 兼容层都能接',
};

export class OpenAiError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'OpenAiError';
    this.detail = detail;
  }
}

export const OPENAI_MODEL_SUGGESTIONS = [
  'gpt-image-1',
  'gpt-image-1-mini',
  'dall-e-3',
  'dall-e-2',
  'gemini-2.5-flash-image',
  'flux-schnell',
  'flux-dev',
  'sd3.5-large',
];

export const OPENAI_SIZE_SUGGESTIONS = [
  '', 'auto', '1024x1024', '1024x1536', '1536x1024', '1792x1024', '1024x1792', '832x1216', '1216x832', '512x512',
];

export const OPENAI_QUALITY_SUGGESTIONS = ['', 'auto', 'low', 'medium', 'high', 'standard', 'hd'];

/** 负面提示词的三种处理方式 —— 图像 API 没有负面参数，只能塞进 prompt。 */
export const NEGATIVE_MODES = [
  { value: 'avoid', label: '拼成 Avoid 附在提示词后（推荐）' },
  { value: 'off', label: '忽略（不把负面发给这个后端）' },
];

/* ============================================================
   地址
   ============================================================ */

/**
 * 拼端点。base 通常已经带 /v1（`https://api.openai.com/v1`）；
 * 若用户直接贴了完整端点（含 /images/generations），原样使用。
 */
export function openaiEndpoint(baseUrl) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) throw new OpenAiError('还没有填接口地址');
  if (/\/images\/generations$/.test(base)) return base;
  return `${base}/images/generations`;
}

/** 同源基址，用来补全服务端返回的相对图片路径。 */
function originOf(baseUrl) {
  try {
    return new URL(String(baseUrl)).origin;
  } catch {
    return '';
  }
}

/* ============================================================
   请求体构造（纯函数，好测）
   ============================================================ */

/**
 * 把负面提示词并进正向。
 * 'avoid' 模式：图像模型没有独立的负面通道，实测用一句「Avoid: ...」最不干扰画面语义。
 */
export function composeOpenAiPrompt(be, prompt, negative) {
  const p = String(prompt || '').trim();
  const neg = String(negative || '').trim();
  if (!neg || be.negativeMode === 'off') return p;
  return `${p}\n\nAvoid: ${neg}`;
}

/** 解析「额外参数」那块 JSON 文本框；空串返回空对象；写坏了抛人话错误。 */
export function parseExtraBody(text) {
  const s = String(text || '').trim();
  if (!s) return {};
  let json;
  try {
    json = JSON.parse(s);
  } catch (err) {
    throw new OpenAiError(`「额外参数」不是合法 JSON：${err?.message || err}`, s.slice(0, 200));
  }
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw new OpenAiError('「额外参数」必须是一个 JSON 对象，例如 {"style":"vivid"}', s.slice(0, 200));
  }
  return json;
}

/**
 * 构造请求体。
 * 关键纪律：**留空即不传** —— 多传一个字段就够让某些端点 400。
 */
export function buildRequest(be, { prompt, negative }) {
  const model = String(be.model || '').trim();
  if (!model) throw new OpenAiError('还没有填模型名（如 gpt-image-1）');

  const finalPrompt = composeOpenAiPrompt(be, prompt, negative);
  if (!finalPrompt) throw new OpenAiError('提示词是空的，没有东西可画');

  let n = Math.round(Number(be.count) || 1);
  if (n < 1) n = 1;
  if (n > 10) n = 10;
  // dall-e-3 只允许单张；多要会被服务端拒掉，这里提前收拢并提醒
  const singleOnly = /^dall-e-3$/i.test(model);
  if (singleOnly && n > 1) n = 1;

  const payload = { model, prompt: finalPrompt, n };

  const size = String(be.size || '').trim();
  if (size) payload.size = size;

  const quality = String(be.quality || '').trim();
  if (quality) payload.quality = quality;

  const responseFormat = String(be.responseFormat || '').trim();
  if (responseFormat && responseFormat !== 'auto') payload.response_format = responseFormat;

  const outputFormat = String(be.outputFormat || '').trim();
  if (outputFormat) payload.output_format = outputFormat;

  // 额外参数放最后，允许用户覆盖上面任何一项（想试新字段不必改代码）
  Object.assign(payload, parseExtraBody(be.extraBody));

  return { payload, n, singleOnly, finalPrompt };
}

/* ============================================================
   响应解析
   ============================================================ */

/**
 * 解析响应。先看是不是裸图片字节（有些端点不按 JSON 来），再按 JSON 挖图。
 * 相对路径（`/files/x.png`）会按 baseUrl 的同源补全。
 */
export async function parseResponse(res, baseUrl) {
  const contentType = String(res.headers?.get?.('content-type') || '');
  const buf = new Uint8Array(await res.arrayBuffer());

  // ① 裸图片字节
  const sniff = sniffImageBytes(buf);
  if (sniff || contentType.startsWith('image/')) {
    const mime = sniff?.mime || contentType.split(';')[0] || 'image/png';
    return [{ url: `data:${mime};base64,${bytesToBase64(buf)}`, format: sniff?.ext || 'png' }];
  }

  // ② JSON
  const text = new TextDecoder().decode(buf).trim();
  let json = null;
  if (text.startsWith('{') || text.startsWith('[')) {
    try { json = JSON.parse(text); } catch { /* 留给下面报错 */ }
  }

  if (!res.ok) {
    const msg = extractErrorMessage(json) || text.slice(0, 200);
    const err = new OpenAiError(msg || `HTTP ${res.status}`, { status: res.status, body: text.slice(0, 800) });
    err.httpStatus = res.status;
    throw err;
  }

  if (!json) {
    throw new OpenAiError(
      '响应不是 JSON 也不是图片 —— 多半是地址填成了网页，或该端点返回了别的东西',
      text.slice(0, 300),
    );
  }

  // 有些端点 200 里也带 error
  const imgs = collectImagesFromJson(json, { allowRelative: true });
  if (!imgs.length) {
    const msg = extractErrorMessage(json);
    throw new OpenAiError(msg ? `接口说：${msg}` : '响应里没有图片数据', text.slice(0, 300));
  }

  // 补全相对路径（`/files/a.png` → 端点同源）。不补的话会被酒馆自己的域名吃掉。
  const origin = originOf(baseUrl);
  return imgs.map((im) => {
    if (!im.relative) return im;
    if (!origin) {
      throw new OpenAiError(
        `端点返回了相对图片路径「${im.url}」，但接口地址不合法，拼不出完整 URL`,
        { baseUrl },
      );
    }
    return { ...im, url: `${origin}${im.url}` };
  });
}

/* ============================================================
   请求发送
   ============================================================ */

async function fetchWithTimeout(url, opts, timeoutSec) {
  const ms = Math.max(10, Number(timeoutSec) || 180) * 1000;
  if (typeof AbortController !== 'function') return fetch(url, opts);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** 把 HTTP 错误翻译成人话。 */
export async function explainOpenAiError(err) {
  const status = err?.httpStatus;
  const raw = String(err?.message || '');
  const body = err?.detail?.body || '';

  if (status === 400) {
    if (/response_format/i.test(body)) {
      return { cause: '端点不接受 response_format 参数（gpt-image-1 就是这类）', fix: '把「返回格式」改回「不指定」，或用「额外参数」覆盖' };
    }
    if (/size/i.test(body)) {
      return { cause: '端点不接受这个尺寸', fix: '换成该模型支持的尺寸（gpt-image-1 是 1024x1024 / 1024x1536 / 1536x1024）' };
    }
    if (/model/i.test(body)) {
      return { cause: '模型名不被这个端点接受', fix: '确认模型名与端点匹配（如中转站用的是它自己的模型名）' };
    }
    if (/safety|content|policy|moderation/i.test(body)) {
      return { cause: '内容被该服务的内容策略拦下', fix: '换个后端（本地 ComfyUI / NAI Full），或调整提示词' };
    }
    return { cause: `参数被拒绝${raw ? `：${raw}` : ''}`, fix: '看下方原始响应；用「额外参数」按对方文档补字段' };
  }
  if (status === 401) return { cause: 'API Key 无效或没带上', fix: '重新填 Key；确认是这家服务自己的 Key（不是别家的）' };
  if (status === 403) return { cause: '被拒绝访问（Key 权限不足或地区限制）', fix: '检查该 Key 的权限；中转站看是否需要额外请求头' };
  if (status === 404) return { cause: '端点不存在（404）', fix: '确认地址是不是漏了 /v1；有的站是 /v1/images/generations，有的不带 /v1' };
  if (status === 429) return { cause: '触发限流或额度用尽', fix: '稍等再试；看该账户余额/配额' };
  if (status >= 500) return { cause: `上游服务出错（HTTP ${status}）`, fix: '稍后重试；持续失败就换端点' };
  return { cause: raw || `请求失败（HTTP ${status}）`, fix: '检查地址与 Key' };
}

async function requestOnce(be, values, timeoutSec) {
  const url = openaiEndpoint(be.serverUrl);
  const { payload, n } = buildRequest(be, values);

  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${String(be.apiKey || '').trim()}`,
    },
    body: JSON.stringify(payload),
  }, timeoutSec);

  const images = await parseResponse(res, be.serverUrl);
  if (n > 1 && images.length < n) {
    const wrapped = new OpenAiError(`请求 ${n} 张，只回来 ${images.length} 张`);
    wrapped.partial = images;
    throw wrapped;
  }
  return images;
}

/** 提交生图（带一次退避重试，只重「等一等就好」的错）。 */
export async function submit({ prompt, negative, nl, cfg, taskId, label }) {
  const conf = cfg || getConfig();
  const be = conf.backends?.openai || {};

  if (!be.enabled) return { ok: false, error: 'OpenAI 兼容后端未启用' };
  if (!String(be.serverUrl || '').trim()) {
    diagnose(STAGE.BACKEND, 'OpenAI 兼容后端没填接口地址', {
      cause: '地址是必填项',
      fix: '官方填 https://api.openai.com/v1；中转站填它给你的 base url',
    });
    return { ok: false, error: '地址为空' };
  }
  if (!String(be.apiKey || '').trim()) {
    diagnose(STAGE.BACKEND, 'OpenAI 兼容后端没填 API Key', {
      cause: '该端点需要 Bearer Token',
      fix: '到「生图后端 → OpenAI 兼容」填 Key',
    });
    return { ok: false, error: 'API Key 为空' };
  }

  const t0 = Date.now();
  const timeoutSec = Number(be.timeoutSec) || 180;

  // 自动重试次数（cfg.genRetries，v0.9.12 起可配；0 = 失败直接报错）
  const retries = Math.max(0, Math.min(5, Number(conf.genRetries ?? 1) || 0));

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      const images = await requestOnce(be, { prompt, negative }, timeoutSec);
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      info(STAGE.BACKEND, `${label || '图片'} 生成完成：${images.length} 张，耗时 ${elapsed}s（OpenAI 兼容 · ${be.model}）`);
      return { ok: true, images, elapsed };
    } catch (err) {
      // 张数不足不算失败 —— 已经拿到的那几张照常用
      if (err?.partial?.length) {
        warn(STAGE.BACKEND, `${err.message}，已保留手里的 ${err.partial.length} 张`);
        return { ok: true, images: err.partial, elapsed: ((Date.now() - t0) / 1000).toFixed(1) };
      }

      const status = err?.httpStatus;
      const retriable = status === 429 || (status >= 500 && status < 600);
      if (retriable && attempt < retries) {
        // retryDelayMs 只为可测性留的口子（测试里设 10ms，不必真等 2 秒）
        const delay = Number(be.retryDelayMs) || 2000;
        warn(STAGE.BACKEND, `OpenAI 兼容端点临时失败（HTTP ${status}），${Math.round(delay / 1000)} 秒后重试（第 ${attempt + 1}/${retries} 次）`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }

      const abort = /abort/i.test(err?.name || '') || /abort/i.test(err?.message || '');
      const friendly = abort ? {} : await explainOpenAiError(err);
      diagnose(STAGE.BACKEND, abort
        ? 'OpenAI 兼容端点生图超时'
        : (status ? `OpenAI 兼容端点拒绝了这次请求（HTTP ${status}）` : `OpenAI 兼容端点出错：${String(err?.message || err).slice(0, 60)}`), {
        cause: abort ? `等待超过 ${timeoutSec} 秒` : (friendly.cause || err?.message || '未知错误'),
        fix: abort ? '图像接口排队慢是常态，把超时时间调大；或换更快的模型' : (friendly.fix || '检查地址、Key 与模型名'),
      }, err?.detail);

      return { ok: false, error: abort ? `超时（${timeoutSec}s）` : (err?.message || String(err)) };
    }
  }
  return { ok: false, error: '重试后仍然失败' };
}

/* ============================================================
   连通性测试
   ============================================================ */

/**
 * 「测试连接」：优先用 GET /models 验 Key（OpenAI 与多数兼容层都有这个接口），
 * 没有就退一步只报告可达性 —— 不要把「这个站没有 /models」误报成「Key 错」。
 */
export async function probe(be) {
  if (!be?.serverUrl?.trim()) return { ok: false, error: '还没填接口地址', hint: '官方是 https://api.openai.com/v1' };
  if (!be?.apiKey?.trim()) return { ok: false, error: '还没填 API Key', hint: '填这家服务发给你的 Key' };

  const base = String(be.serverUrl).trim().replace(/\/+$/, '');
  const headers = { Authorization: `Bearer ${be.apiKey.trim()}` };

  try {
    const res = await fetchWithTimeout(`${base}/models`, { headers }, 20);
    if (res.ok) {
      const j = await res.json().catch(() => null);
      const list = Array.isArray(j?.data) ? j.data : [];
      const hit = be.model ? list.find(m => String(m?.id || '').includes(be.model)) : null;
      const bits = [];
      if (list.length) bits.push(`可见 ${list.length} 个模型`);
      if (be.model) bits.push(hit ? `包含 ${be.model}` : `未见 ${be.model}（可能仍可用）`);
      return { ok: true, message: `连接正常${bits.length ? `（${bits.join(' · ')}）` : ''}`, detail: j };
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: `Key 被拒绝（HTTP ${res.status}）`, hint: '确认 Key 属于这个端点，没有多余空格' };
    }
  } catch { /* 继续往下试 */ }

  try {
    await fetchWithTimeout(base, { method: 'GET', headers }, 10);
    return { ok: true, message: '地址可达（该站点没有 /models 接口，无法校验 Key，但不影响生图）' };
  } catch (err) {
    return { ok: false, error: `连不上：${err?.message || err}`, hint: '检查地址拼写与网络；官方地址是 https://api.openai.com/v1' };
  }
}

/** 「测试生图」：真跑一张最小图，验完整链路。 */
export async function testGenerate(be, prompt) {
  const t0 = Date.now();
  try {
    const images = await requestOnce(be, {
      prompt: String(prompt || '').trim() || 'a red apple on a white table',
      negative: '',
    }, Number(be.timeoutSec) || 120);
    return { ok: true, images, elapsed: ((Date.now() - t0) / 1000).toFixed(1) };
  } catch (err) {
    if (err?.partial?.length) return { ok: true, images: err.partial, elapsed: ((Date.now() - t0) / 1000).toFixed(1) };
    const friendly = await explainOpenAiError(err);
    return { ok: false, error: friendly.cause || err?.message || String(err) };
  }
}

/** 让「测试生图」的结果也能被诊断面板看到（UI 层调用）。 */
export function logTestResult(res) {
  if (res.ok) debug(STAGE.BACKEND, `OpenAI 兼容端点测试生图成功（${res.elapsed}s）`);
  else warn(STAGE.BACKEND, `OpenAI 兼容端点测试生图失败：${res.error}`);
}
