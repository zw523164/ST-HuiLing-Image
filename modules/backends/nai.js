/**
 * 绘灵 · NovelAI 生图后端
 *
 * 协议口径沿用实测可用的写法，但**响应解析做了三层容错**：
 * NAI 官方返回 zip（里面包 png），而用户真正会填的往往是第三方兼容站 ——
 * 那些站有的照抄 zip，有的图省事直接回 JSON（base64 数组 / data URL），
 * 有的干脆把 png 字节原样吐回来。三种都认，才不至于「地址填对了但一直报解析失败」。
 *
 * 端点：POST {base}/ai/generate-image
 * 认证：Authorization: Bearer <key>
 *
 * 与 ComfyUI 后端的区别：这里没有工作流概念，参数是结构化的
 * （模型 / 采样器 / 步数 / CFG / 尺寸 / 种子），所以不需要占位符替换那一层。
 */

import { unzipFirstImage, mimeFromName } from './zip.js';
import { bytesToBase64, pickImageFromJson, sniffImageBytes } from './imagedata.js';
import { getConfig } from '../settings.js';
import { info, warn, debug, diagnose, STAGE } from '../log.js';

/* ============================================================
   枚举表
   ============================================================ */

export const NAI_MODELS = [
  { value: 'nai-diffusion-5-full', label: 'NAI 5 Full（最新，无过滤）' },
  { value: 'nai-diffusion-5-curated', label: 'NAI 5 Curated（有内容过滤）' },
  { value: 'nai-diffusion-4-5-full', label: 'NAI 4.5 Full（无过滤）' },
  { value: 'nai-diffusion-4-5-curated', label: 'NAI 4.5 Curated（有内容过滤）' },
  { value: 'nai-diffusion-4-full', label: 'NAI 4 Full（旧，仅 tag）' },
  { value: 'nai-diffusion-4-curated-preview', label: 'NAI 4 Curated（旧，仅 tag）' },
  { value: 'nai-diffusion-3', label: 'NAI 3（旧）' },
];

export const NAI_SAMPLERS = [
  { value: 'k_euler', label: 'Euler' },
  { value: 'k_euler_ancestral', label: 'Euler Ancestral' },
  { value: 'k_dpmpp_2s_ancestral', label: 'DPM++ 2S Ancestral' },
  { value: 'k_dpmpp_2m', label: 'DPM++ 2M' },
  { value: 'k_dpmpp_2m_sde', label: 'DPM++ 2M SDE' },
  { value: 'k_dpmpp_sde', label: 'DPM++ SDE' },
  { value: 'ddim_v3', label: 'DDIM V3' },
];

export const NAI_NOISE_SCHEDULES = [
  { value: 'karras', label: 'Karras（推荐）' },
  { value: 'native', label: 'Native' },
  { value: 'exponential', label: 'Exponential' },
  { value: 'polyexponential', label: 'Polyexponential' },
];

/** 各模型的官方质量词 —— 留空时按模型回落。 */
const QUALITY_TAGS = {
  'nai-diffusion-5-full': 'very aesthetic, masterpiece, no text',
  'nai-diffusion-5-curated': 'very aesthetic, masterpiece, no text',
  'nai-diffusion-4-5-full': 'location, very aesthetic, masterpiece, no text',
  'nai-diffusion-4-5-curated': 'location, masterpiece, no text, -0.8::feet::, rating:general',
  'nai-diffusion-4-full': 'no text, best quality, very aesthetic, absurdres',
  'nai-diffusion-4-curated-preview': 'rating:general, best quality, very aesthetic, absurdres',
  'nai-diffusion-3': 'best quality, amazing quality, very aesthetic, absurdres',
};

/** 各模型的官方 Heavy 负面词 —— 留空时按模型回落。 */
const DEFAULT_UNDESIRED = {
  'nai-diffusion-5-full': 'lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page, text, watermark, signature, username, artist name, bad anatomy, bad hands, bad feet, extra digits, fewer digits, extra fingers, fused fingers, extra limbs, missing limbs, long neck, blurry, poorly drawn, unfinished',
  'nai-diffusion-5-curated': 'lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page',
  'nai-diffusion-4-5-full': 'lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page',
  'nai-diffusion-4-5-curated': 'blurry, lowres, upscaled, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, halftone, multiple views, logo, too many watermarks, negative space, blank page',
  'nai-diffusion-4-full': 'blurry, lowres, error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, multiple views, logo, too many watermarks, white blank page, blank page',
  'nai-diffusion-4-curated-preview': 'blurry, lowres, error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, logo, dated, signature, multiple views, gigantic breasts, white blank page, blank page',
  'nai-diffusion-3': 'lowres, {bad}, error, fewer, extra, missing, worst quality, jpeg artifacts, bad quality, watermark, unfinished, displeasing, chromatic aberration, signature, extra digits, artistic error, username, scan, [abstract]',
};

export function naiDefaultQualityTags(model) {
  return QUALITY_TAGS[model] ?? '';
}

export function naiDefaultUndesired(model) {
  return DEFAULT_UNDESIRED[model] ?? '';
}

export const meta = {
  key: 'nai',
  name: 'NovelAI',
  short: 'NAI',
  hint: '走官方 /ai/generate-image 协议，也兼容第三方镜像站（地址填你自己的）',
};

/* ============================================================
   模型家族判定
   ============================================================ */

export function isNai5(model) {
  return String(model || '').includes('nai-diffusion-5');
}

export function isNai45(model) {
  return String(model || '').includes('nai-diffusion-4-5');
}

export function isNai4Family(model) {
  return String(model || '').includes('nai-diffusion-4');
}

export function isNai3(model) {
  return String(model || '') === 'nai-diffusion-3';
}

/**
 * 是否吃「Base Prompt + 自然语言」这套结构。
 * 边界是 4.5 —— 自然语言是 4.5 才引入的，原版 NAI4 只吃 tag。
 * （这条坑踩过：曾按 isNai5 卡，导致 4.5 明明支持却发不出自然语言。）
 */
export function naiSupportsNaturalLanguage(model) {
  return isNai45(model) || isNai5(model);
}

const NAI_V5_SAMPLERS = new Set([
  'k_euler_ancestral', 'k_euler', 'k_dpmpp_2s_ancestral',
  'k_dpmpp_2m_sde', 'k_dpmpp_2m', 'k_dpmpp_sde',
]);

/** 该模型可用的采样器（NAI5 砍掉了 DDIM V3）。 */
export function naiSamplers(model) {
  return isNai5(model) ? NAI_SAMPLERS.filter(s => NAI_V5_SAMPLERS.has(s.value)) : NAI_SAMPLERS;
}

/** NAI 的种子是 32 位无符号（与 ComfyUI 的 2^53 不同口径）。 */
export function naiRandomSeed() {
  return Math.floor(Math.random() * 2 ** 32);
}

const REFERENCE_PIXEL_COUNT = 1011712;
const SIGMA_MAGIC = 19;
const SIGMA_MAGIC_45 = 58;

/**
 * skip_cfg_above_sigma —— variety boost 打开时按像素量相对参考分辨率缩放。
 * 只有 NAI5 不用（它把这个参数废掉了）。
 */
export function skipCfgAboveSigma(width, height, model, varietyBoost) {
  if (!varietyBoost || isNai5(model)) return null;
  const magic = isNai45(model) ? SIGMA_MAGIC_45 : SIGMA_MAGIC;
  return Math.pow((width * height) / REFERENCE_PIXEL_COUNT, 0.5) * magic;
}

/* ============================================================
   地址与校验
   ============================================================ */

export class NaiError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'NaiError';
    this.detail = detail;
  }
}

/**
 * 拼端点：base 去掉尾斜杠后补 `/ai/<path>`；
 * base 本身已经是完整端点（以 /ai/<path> 或 /<path> 结尾）时原样使用 ——
 * 第三方站经常直接给一整段 URL。
 */
export function naiEndpoint(url, path) {
  const base = String(url || '').trim().replace(/\/+$/, '');
  if (!base) throw new NaiError('还没有填 NAI 接口地址');
  const seg = String(path || '').replace(/^\/+/, '');
  if (base.endsWith(`/ai/${seg}`) || base.endsWith(`/${seg}`)) return base;
  return `${base}/ai/${seg}`;
}

/**
 * NAI 对尺寸有硬性要求：宽高都是 64 的倍数，且落在 256–2048。
 * 提前拦下来，比等接口回一个看不懂的 400 强。
 */
export function validateNaiSize(width, height) {
  const w = Math.round(Number(width));
  const h = Math.round(Number(height));
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) {
    throw new NaiError(`尺寸无效：${width} × ${height}`);
  }
  if (w % 64 !== 0 || h % 64 !== 0) {
    throw new NaiError(`尺寸 ${w}×${h} 不是 64 的倍数 —— NAI 要求宽高都必须是 64 的倍数（如 832×1216）`);
  }
  if (w < 256 || h < 256 || w > 2048 || h > 2048) {
    throw new NaiError(`尺寸 ${w}×${h} 超出 NAI 允许范围（256–2048）`);
  }
  return { width: w, height: h };
}

/* ============================================================
   参数构造（纯函数，好测）
   ============================================================ */

/**
 * 正向提示词 = 画风/前缀（引擎已拼好）+ 质量词。
 * 质量词走「面板值 → 模型官方词」两级回落；关掉开关则一级都不走。
 */
/**
 * 正向提示词。
 * @param {boolean} [nlEnabled=true] 全局「中文描述」开关：关掉就只发 tag 串
 *   （和 ComfyUI 侧同一个开关，A/B 对比中文到底有没有用时最快的方式）。
 */
export function composeNaiPrompt(be, prompt, nl, nlEnabled = true) {
  const quality = be.useQualityTags === false
    ? ''
    : (String(be.qualityTags || '').trim() || naiDefaultQualityTags(be.model));
  const body = String(prompt || '').trim();
  const tags = [body, quality].filter(Boolean).join(', ');
  // 4.5/5 吃自然语言：接在 tag 串后面（NAI 官方前端也是这个形态）
  const want = nlEnabled !== false && naiSupportsNaturalLanguage(be.model);
  const nlText = want ? String(nl || '').trim() : '';
  return nlText ? `${tags}. ${nlText}` : tags;
}

/** 负面 = 引擎传的（含全局负面）→ 面板值 → 模型官方词，逐级回落。 */
export function composeNaiNegative(be, engineNegative) {
  return String(engineNegative || '').trim()
    || String(be.negative || '').trim()
    || naiDefaultUndesired(be.model);
}

/**
 * 构造 NAI 的 parameters。v4 系带 v4_prompt / v4_negative_prompt 结构，NAI3 不带。
 * 纯函数：不碰 DOM、不发请求，测试能直接断言字段。
 */
export function buildParameters(be, { prompt, negative, nl, nlEnabled = true }) {
  const { width, height } = validateNaiSize(be.width, be.height);
  const model = be.model;

  const positive = composeNaiPrompt(be, prompt, nl, nlEnabled);
  const negText = composeNaiNegative(be, negative);

  const seed = Number(be.seed) > 0 ? Number(be.seed) : naiRandomSeed();
  const skipCfg = skipCfgAboveSigma(width, height, model, be.varietyBoost !== false);

  let sampler = String(be.sampler || 'k_euler_ancestral');
  // NAI5 不认的采样器会被服务端拒掉，这里静默换成安全的那个
  if (isNai5(model) && !NAI_V5_SAMPLERS.has(sampler)) sampler = 'k_euler_ancestral';

  const params = {
    params_version: isNai5(model) ? 4 : 3,
    width,
    height,
    scale: Number(be.scale ?? 5),
    sampler,
    steps: Number(be.steps) || 28,
    n_samples: 1,
    ucPreset: 3,
    qualityToggle: be.useQualityTags !== false,
    dynamic_thresholding: false,
    controlnet_strength: 1,
    legacy: false,
    legacy_uc: false,
    add_original_image: true,
    cfg_rescale: Number(be.cfgRescale ?? 0),
    noise_schedule: String(be.noiseSchedule || 'karras'),
    skip_cfg_above_sigma: skipCfg,
    legacy_v3_extend: false,
    stream: 'msgpack',
    seed,
    negative_prompt: negText,
    reference_strength_multiple: [],
    normalize_reference_strength_multiple: false,
    use_coords: false,
  };

  if (isNai3(model)) {
    // NAI3 走老的 vibe 协议（发参考原图），SME/SMEA 绘灵不开放
    params.sm = false;
    params.sm_dyn = false;
    params.reference_image_multiple = [];
    params.reference_information_extracted_multiple = [];
  } else {
    // NAI4 / 4.5 / 5 走 v4 caption 结构
    params.reference_image_multiple_cached = [];
    params.characterPrompts = [];
    params.v4_prompt = {
      caption: { base_caption: positive, char_captions: [] },
      use_coords: false,
      use_order: true,
    };
    params.v4_negative_prompt = {
      caption: { base_caption: negText, char_captions: [] },
      legacy_uc: false,
    };
  }

  if (sampler === 'k_euler_ancestral') {
    params.deliberate_euler_ancestral_bug = false;
    params.prefer_brownian = true;
  }

  return { params, positive, negative: negText, seed, width, height, sampler };
}

/** 完整请求体。 */
export function buildRequestBody(be, values) {
  const built = buildParameters(be, values);
  return {
    built,
    body: {
      input: built.positive,
      model: be.model,
      action: 'generate',
      parameters: built.params,
      use_new_shared_trial: true,
    },
  };
}

/* ============================================================
   响应解析 —— 三种形态都认
   ============================================================ */

/**
 * 把响应字节翻译成图片 URL 列表。
 * 顺序：zip → 裸图片字节 → JSON。三条路都不通，就把开头一小段当文本抛出来。
 */
export async function parseImageResponse(bytes) {
  if (!bytes || !bytes.length) throw new NaiError('响应是空的（0 字节）');

  // ① zip（NAI 官方形态）
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
    const first = await unzipFirstImage(bytes);
    const mime = mimeFromName(first.name);
    return [{ url: `data:${mime};base64,${bytesToBase64(first.bytes)}`, format: mime.split('/')[1] }];
  }

  // ② 裸图片字节（部分第三方站直接回图）
  const sniff = sniffImageBytes(bytes);
  if (sniff) {
    return [{ url: `data:${sniff.mime};base64,${bytesToBase64(bytes)}`, format: sniff.ext }];
  }

  // ③ JSON
  const text = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 2 * 1024 * 1024))).trim();
  if (text.startsWith('{') || text.startsWith('[')) {
    let json;
    try {
      json = JSON.parse(text);
    } catch (err) {
      throw new NaiError('响应是 JSON 但解析失败（可能被截断）', text.slice(0, 300));
    }
    const hit = pickImageFromJson(json);
    if (!hit) {
      // 成功响应里没有图 —— 多半是错误对象被 200 包着回来的
      const msg = json && typeof json === 'object'
        ? (json.message || json.error?.message || (typeof json.error === 'string' ? json.error : ''))
        : '';
      throw new NaiError(
        msg ? `接口返回错误：${msg}` : 'JSON 里没找到图片数据（既没有 base64 也没有 url）',
        text.slice(0, 300),
      );
    }
    return [{ url: hit.url, format: hit.format }];
  }

  throw new NaiError(
    '认不出响应格式（既不是 zip、也不是图片、也不是 JSON）—— 多半是地址填成了网页而不是 API 端点',
    text.slice(0, 200),
  );
}

/* ============================================================
   请求发送
   ============================================================ */

/** 带超时的 fetch（AbortController 老浏览器没有时降级为不超时）。 */
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

/** 把 NAI 的 HTTP 错误翻译成人话（429 / 401 / 402 各有各的修法）。 */
export async function explainNaiError(res) {
  let raw = '';
  try { raw = await res.text(); } catch { /* 读不到就算了 */ }

  let apiMsg = '';
  try {
    const j = JSON.parse(raw);
    apiMsg = j?.message || j?.error?.message || (typeof j?.error === 'string' ? j.error : '') || '';
  } catch { apiMsg = raw.slice(0, 200); }

  const tail = apiMsg ? `（接口原话：${apiMsg}）` : '';

  switch (res.status) {
    case 400:
      return { cause: `参数被拒绝，多半是尺寸不是 64 的倍数、或步数/CFG 超出范围${tail}`, fix: '检查尺寸（要 64 的倍数，256–2048）、步数与 CFG' };
    case 401:
      return { cause: `API Key 无效或没带上${tail}`, fix: '到「生图后端 → NovelAI」重新填 Key（Persistent Token，以 pst- 开头）' };
    case 402:
      return { cause: `账户额度不够（NAI 的订阅额度用完或未订阅）${tail}`, fix: '到 NovelAI 官网看订阅状态与 Opus 额度；或换别的后端' };
    case 403:
      return { cause: `被拒绝访问 —— 常见于 Curated 模型收到它不允许的内容，或该站封了你的 IP${tail}`, fix: '换 Full 模型再试；第三方站检查是否要额外鉴权头' };
    case 429:
      return { cause: `触发限流（请求太密）${tail}`, fix: '等几十秒再试；绘灵已自动退避重试过一次' };
    case 500:
    case 502:
    case 503:
    case 504:
      return { cause: `上游服务出错（${res.status}）—— 官方偶发，第三方站更常见${tail}`, fix: '稍后重试；持续失败就换个镜像站' };
    default:
      return { cause: `请求失败（HTTP ${res.status}）${tail}`, fix: '确认地址是 NAI 兼容端点（通常以 /ai 结尾的那一层）' };
  }
}

/** 一次生图请求（不含重试），返回图片列表。 */
async function requestOnce(be, values, timeoutSec) {
  const url = naiEndpoint(be.serverUrl, 'generate-image');
  const { body } = buildRequestBody(be, values);

  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${String(be.apiKey || '').trim()}`,
      Accept: '*/*',
    },
    body: JSON.stringify(body),
  }, timeoutSec);

  if (!res.ok) {
    const friendly = await explainNaiError(res);
    const err = new NaiError(friendly.cause, friendly);
    err.httpStatus = res.status;
    throw err;
  }

  const bytes = new Uint8Array(await res.arrayBuffer());
  return parseImageResponse(bytes);
}

/**
 * 提交生图。带一次退避重试（只重 429/5xx 这类「等一等就好」的错，
 * 401/402 那种重试一百次也一样，直接放弃并说清原因）。
 */
export async function submit({ prompt, negative, nl, cfg, taskId, label }) {
  const conf = cfg || getConfig();
  const be = conf.backends?.nai || {};

  if (!be.enabled) {
    return { ok: false, error: 'NovelAI 后端未启用' };
  }
  if (!String(be.apiKey || '').trim()) {
    diagnose(STAGE.BACKEND, 'NovelAI 还没有填 API Key', {
      cause: 'novelai 后端需要 Bearer Token 才能调用',
      fix: '到「生图后端 → NovelAI」把 Persistent Token 填进去（NAI 官网 Account → Persistent Token）',
    });
    return { ok: false, error: 'API Key 为空' };
  }
  if (!String(be.serverUrl || '').trim()) {
    diagnose(STAGE.BACKEND, 'NovelAI 接口地址为空', {
      cause: '没填地址',
      fix: '官方填 https://api.novelai.net；第三方兼容站填它给你的地址',
    });
    return { ok: false, error: '地址为空' };
  }
  if (!String(be.model || '').trim()) {
    return { ok: false, error: '没选模型' };
  }

  const t0 = Date.now();
  const timeoutSec = Number(be.timeoutSec) || 180;

  // 自动重试次数（cfg.genRetries，v0.9.12 起可配；0 = 失败直接报错）
  const retries = Math.max(0, Math.min(5, Number(conf.genRetries ?? 1) || 0));

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      // 全局「中文描述」开关：关掉时连 NAI 的自然语言拼接也一起停（只发 tag 串）
      const images = await requestOnce(be, { prompt, negative, nl, nlEnabled: conf.nlEnabled !== false }, timeoutSec);
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      info(STAGE.BACKEND, `${label || '图片'} 生成完成：${images.length} 张，耗时 ${elapsed}s（NovelAI）`);
      return { ok: true, images, elapsed };
    } catch (err) {
      const status = err?.httpStatus;
      const retriable = status === 429 || (status >= 500 && status < 600);

      if (retriable && attempt < retries) {
        // retryDelayMs 只为可测性留的口子（测试里设 10ms，不必真等 2 秒）
        const delay = Number(be.retryDelayMs) || 2000;
        warn(STAGE.BACKEND, `NovelAI 临时失败（HTTP ${status}），${Math.round(delay / 1000)} 秒后重试（第 ${attempt + 1}/${retries} 次）`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }

      const friendly = err?.detail || {};
      const abort = /abort/i.test(err?.name || '') || /abort/i.test(err?.message || '');
      diagnose(STAGE.BACKEND, failureTitle(err, abort), {
        cause: abort ? `等待超过 ${timeoutSec} 秒` : (friendly.cause || err?.message || '未知错误'),
        fix: abort ? '到 NovelAI 站上确认队列；或把超时时间调大' : (friendly.fix || '检查地址与 Key 后重试'),
      }, err?.detail);
      return { ok: false, error: abort ? `超时（${timeoutSec}s）` : (err?.message || String(err)) };
    }
  }
  return { ok: false, error: '重试后仍然失败' };
}

function failureTitle(err, abort) {
  if (abort) return 'NovelAI 生图超时';
  if (err?.httpStatus) return `NovelAI 拒绝了这次请求（HTTP ${err.httpStatus}）`;
  if (err?.name === 'NaiError') return `NovelAI 响应解析失败：${String(err.message).slice(0, 60)}`;
  return `NovelAI 提交失败：${String(err?.message || err).slice(0, 80)}`;
}

/* ============================================================
   连通性测试
   ============================================================ */

/**
 * 「测试连接」—— 先探订阅接口（能顺带告诉你账号额度），
 * 探不到就退一步只报告地址可达性，别把「站点没有这个接口」误报成「Key 无效」。
 */
export async function probe(be) {
  if (!be?.serverUrl?.trim()) return { ok: false, error: '还没填接口地址', hint: '官方填 https://api.novelai.net' };
  if (!be?.apiKey?.trim()) return { ok: false, error: '还没填 API Key', hint: 'NAI 官网 → Account → Persistent Token' };

  const base = String(be.serverUrl).trim().replace(/\/+$/, '');
  const headers = { Authorization: `Bearer ${be.apiKey.trim()}`, Accept: 'application/json' };

  // ① 官方订阅接口：能拿到额度，最有用
  try {
    const res = await fetchWithTimeout(`${base}/user/subscription`, { headers }, 20);
    if (res.ok) {
      const j = await res.json().catch(() => null);
      const tier = j?.tier ?? j?.data?.tier;
      const left = j?.trainingStepsLeft?.fixedTrainingStepsLeft;
      const bits = [];
      if (tier !== undefined && tier !== null) bits.push(`等级 ${tier}`);
      if (typeof left === 'number') bits.push(`剩余约 ${left} 步`);
      return {
        ok: true,
        message: `连接正常${bits.length ? `（${bits.join(' · ')}）` : ''}`,
        detail: j,
      };
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: `Key 被拒绝（HTTP ${res.status}）`, hint: '确认复制的是 Persistent Token，且没有多余空格' };
    }
    // 404 之类：很可能不是官方站 —— 继续走第 ② 步
  } catch { /* 网络层失败也继续往下试 */ }

  // ② 退一步：只看地址通不通
  try {
    await fetchWithTimeout(base, { method: 'GET', headers }, 10);
    return {
      ok: true,
      message: '地址可达（该站点没有 /user/subscription 接口，无法校验 Key，但并不影响生图）',
    };
  } catch (err) {
    return {
      ok: false,
      error: `连不上：${err?.message || err}`,
      hint: '检查地址拼写与网络；官方地址是 https://api.novelai.net',
    };
  }
}

/**
 * 「测试生图」—— 用一条最短的提示词真跑一张。
 * 光测连接不够：Key 有效 ≠ 生图能通（额度、模型名、尺寸都可能挂在这条路上）。
 */
export async function testGenerate(be, prompt) {
  const t0 = Date.now();
  try {
    const images = await requestOnce(be, {
      prompt: String(prompt || '').trim() || '1girl, solo, simple background',
      negative: '',
      nl: '',
    }, Number(be.timeoutSec) || 120);
    return { ok: true, images, elapsed: ((Date.now() - t0) / 1000).toFixed(1) };
  } catch (err) {
    const friendly = err?.detail || {};
    return { ok: false, error: friendly.cause || err?.message || String(err) };
  }
}

/** 让「测试生图」的结果也能被诊断面板看到（UI 层调用）。 */
export function logTestResult(res) {
  if (res.ok) debug(STAGE.BACKEND, `NovelAI 测试生图成功（${res.elapsed}s）`);
  else warn(STAGE.BACKEND, `NovelAI 测试生图失败：${res.error}`);
}
