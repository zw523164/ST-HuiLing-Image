/**
 * 绘灵 · 出词用的独立 LLM API（OpenAI 兼容 chat/completions）
 *
 * 为什么要有这一层：
 *   `api.js` 原本只会走酒馆自己的文本生成接口（generateRaw / generateQuietPrompt）。
 *   那条路依赖酒馆里配的主 API —— 主 API 一挂（换模型、欠费、上游容量耗尽），
 *   绘灵就跟着瘫，用户看到的是「分析失败」，但根因完全在别处。
 *   把「独立 API 配置」摆在基本设置最显眼的位置，道理就在这：
 *   出词是一条**独立、可单独验证**的通路，不该被主对话的配置牵着走。
 *
 * 端点：POST {base}/chat/completions   GET {base}/models
 * 认证：Authorization: Bearer <key>（本地服务常常不需要，Key 留空即不发这个头）
 *
 * 与生图后端（backends/）分开是有意的：
 *   backends/ 解决「拿什么画」，这里解决「谁来想」。两者认证、端点、参数、失败模式
 *   都不一样，硬塞进同一个注册表只会让契约变成一锅粥。
 */

import { info, warn, debug, diagnose, STAGE } from './log.js';
/**
 * 用量记账（v0.9.143）：真实发 HTTP 的只有这里，`usage` 也只有这里拿得到。
 * 用户的诉求是「我不看后台都不知道被烧了这么多」—— 所以每一次真实请求
 * （**包括上面那些自动重试**）都要记一笔，重试烧的钱同样要算进去。
 */
import { record as recordUsage } from './usage.js';

export class LlmApiError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'LlmApiError';
    this.detail = detail;
  }
}

/* ============================================================
   常见服务商的 Base URL（下拉建议，不是硬编码白名单）
   ============================================================ */

/**
 * 只用来把输入框的 datalist 填上 —— 用户从里面挑一个，省得去翻文档。
 * 挑不到自己的服务？直接手打，这里不拦。
 */
export const BASE_URL_PRESETS = [
  { label: 'DeepSeek', url: 'https://api.deepseek.com', model: 'deepseek-chat' },
  { label: 'OpenAI', url: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { label: 'Moonshot 月之暗面', url: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  { label: '智谱 GLM', url: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  { label: '阿里百炼 · 通义', url: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { label: '硅基流动', url: 'https://api.siliconflow.cn/v1', model: 'Qwen/Qwen2.5-7B-Instruct' },
  { label: 'OpenRouter', url: 'https://openrouter.ai/api/v1', model: 'google/gemini-2.0-flash-001' },
  { label: 'Ollama（本机）', url: 'http://localhost:11434/v1', model: 'qwen2.5:7b' },
  { label: 'LM Studio（本机）', url: 'http://localhost:1234/v1', model: '' },
  // WorkBuddy 官方配套的对外 API（腾讯云）：Key 在对应控制台创建，模型名按套餐/Key 范围手填。
  { label: '腾讯云 TokenHub · WorkBuddy 套餐', url: 'https://tokenhub.tencentcloudmaas.com/plan/v3', model: '' },
  { label: '腾讯云 TokenHub · 国际版', url: 'https://tokenhub-intl.tencentcloudmaas.com/plan/v3', model: '' },
];

/** 温度 / Top P / 两个惩罚项的合法区间，钳制用。 */
export const PARAM_RANGE = {
  maxTokens: { min: 16, max: 200000, step: 1, def: 8192 },
  temperature: { min: 0, max: 2, step: 0.05, def: 1 },
  topP: { min: 0, max: 1, step: 0.05, def: 1 },
  freqPenalty: { min: -2, max: 2, step: 0.1, def: 0 },
  presPenalty: { min: -2, max: 2, step: 0.1, def: 0 },
};

/* ============================================================
   地址
   ============================================================ */

/**
 * 拼 chat 端点。
 *
 * 兼容三种填法（这是用户最容易填错的地方，必须都吃下）：
 *   https://api.deepseek.com            → …/v1/chat/completions（裸域名，补版本段）
 *   https://api.openai.com/v1           → …/v1/chat/completions（已带版本段）
 *   https://x.com/v1/chat/completions   → 原样（贴了完整端点）
 *
 * 第三种的现实意义：Gemini 的兼容层是 `/v1beta/openai/chat/completions`，
 * 版本段后面还挂着一截路径 —— 强行"补全"只会把地址拼坏。
 */
export function chatEndpoint(baseUrl) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) throw new LlmApiError('还没有填接口地址');
  if (/\/chat\/completions$/i.test(base)) return base;
  // 已经带版本段（/v1、/v1beta、/v4、/api/paas/v4…）→ 只接尾巴
  if (/\/v\d+[a-z]*(\/.*)?$/i.test(base)) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

/** 拼模型列表端点。规则与 chatEndpoint 一致。 */
export function modelsEndpoint(baseUrl) {
  const base = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) throw new LlmApiError('还没有填接口地址');
  const m = base.match(/^(.*?)\/chat\/completions$/i);
  if (m) return `${m[1]}/models`;
  if (/\/v\d+[a-z]*(\/.*)?$/i.test(base)) return `${base}/models`;
  return `${base}/v1/models`;
}

/**
 * 去掉可能存在的尾部斜杠之外，还顺手挡一下最常见的填错：
 * 把「带完整路径的网页地址」当 base（如 https://platform.deepseek.com/usage）。
 * 不做强校验 —— 中转站形态太多，宁可放行后由错误翻译来兜。
 */
export function looksLikeWebPage(baseUrl) {
  const s = String(baseUrl || '').trim();
  if (!/^https?:\/\//i.test(s)) return false;
  return /\/(usage|login|dashboard|console|docs?|pricing|settings)(\/|$)/i.test(s);
}

/* ============================================================
   参数与请求体
   ============================================================ */

function clampNum(v, range, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(range.max, Math.max(range.min, n));
}

/** 把配置里的参数规整到合法区间（顺带把字符串数字转成数字）。 */
export function normalizeParams(p = {}) {
  return {
    maxTokens: Math.round(clampNum(p.maxTokens, PARAM_RANGE.maxTokens, PARAM_RANGE.maxTokens.def)),
    temperature: clampNum(p.temperature, PARAM_RANGE.temperature, PARAM_RANGE.temperature.def),
    topP: clampNum(p.topP, PARAM_RANGE.topP, PARAM_RANGE.topP.def),
    freqPenalty: clampNum(p.freqPenalty, PARAM_RANGE.freqPenalty, PARAM_RANGE.freqPenalty.def),
    presPenalty: clampNum(p.presPenalty, PARAM_RANGE.presPenalty, PARAM_RANGE.presPenalty.def),
  };
}

/**
 * 构造请求体。
 *
 * 「能少发一个字段就少发一个」在这里同样是纪律，但方向和生图那边不同：
 *   · maxTokens 填 0/留空 → 不发 max_tokens
 *     （o1/o3/gpt-5 系只认 max_completion_tokens，收到 max_tokens 直接 400；
 *      有些中转站则要求必须给。留空即不传，让用户自己决定踩哪边。）
 *   · top_p 与 temperature 同时发在很多端点上会被警告「建议只调一个」——
 *     但实测主流几家都收，且 OpenAI 官方文档也允许，故都发，不额外加开关。
 */
export function buildChatBody(params, messages, model) {
  const m = String(model || '').trim();
  if (!m) throw new LlmApiError('还没有填模型名（不确定就点旁边的「获取」拉列表）');

  const list = (Array.isArray(messages) ? messages : [])
    .filter(x => x && x.content != null && String(x.content).trim() !== '')
    .map(x => ({ role: String(x.role || 'user'), content: String(x.content) }));
  if (!list.length) throw new LlmApiError('消息是空的，没有东西可发');

  const p = normalizeParams(params);
  const body = { model: m, messages: list, stream: false };

  if (Number(params?.maxTokens) > 0) body.max_tokens = p.maxTokens;
  body.temperature = p.temperature;
  body.top_p = p.topP;
  if (p.freqPenalty !== 0) body.frequency_penalty = p.freqPenalty;
  if (p.presPenalty !== 0) body.presence_penalty = p.presPenalty;

  return body;
}

/* ============================================================
   响应解析
   ============================================================ */

/**
 * 从响应里取出正文。
 *
 * 兼容的形状（都是实打实遇到过的）：
 *   choices[0].message.content   —— 标准
 *   choices[0].message.content[] —— 分块数组（多模态/新版）
 *   choices[0].text              —— 老的 completions 风格，有些中转仍这么回
 *   output_text                  —— Responses API
 *   content                      —— 少数代理直接铺平
 */
export function extractReply(json) {
  if (!json || typeof json !== 'object') return '';
  const choice = Array.isArray(json.choices) ? json.choices[0] : null;
  const msg = choice?.message;

  const fromContent = (c) => {
    if (typeof c === 'string') return c;
    if (Array.isArray(c)) {
      return c.map(part => (typeof part === 'string' ? part : (part?.text ?? ''))).join('');
    }
    return '';
  };

  const candidates = [
    fromContent(msg?.content),
    typeof msg === 'string' ? msg : '',
    typeof choice?.text === 'string' ? choice.text : '',
    typeof json.output_text === 'string' ? json.output_text : '',
    typeof json.content === 'string' ? json.content : '',
    fromContent(json.content),
  ];
  for (const c of candidates) {
    if (String(c || '').trim()) return String(c);
  }

  // 只回了思维链（R1 系在 max_tokens 被吃掉时就这样）—— 单独说清楚，别让用户以为是空响应
  const reasoning = msg?.reasoning_content || msg?.reasoning;
  if (String(reasoning || '').trim()) {
    throw new LlmApiError(
      '模型只返回了思考过程（思维链），正文是空的',
      { hint: '多半是「最大 Tokens」被思维链吃光了 —— 把它调大（如 8192 以上），或换一个非推理模型' },
    );
  }
  return '';
}

/* ============================================================
   请求发送
   ============================================================ */

async function fetchWithTimeout(url, opts, timeoutSec) {
  const ms = Math.max(5, Number(timeoutSec) || 120) * 1000;
  if (typeof AbortController !== 'function') return fetch(url, opts);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    return await fetch(url, { ...opts, signal: ctl.signal });
  } finally {
    clearTimeout(timer);
  }
}

function authHeaders(p) {
  const h = { 'Content-Type': 'application/json' };
  const key = String(p?.apiKey || '').trim();
  // Key 留空不发这个头 —— 本地 Ollama / LM Studio 不需要，硬塞个空 Bearer 反而会被拒
  if (key) h.Authorization = `Bearer ${key}`;
  return h;
}

/** 把 HTTP 错误翻译成人话。 */
export function explainLlmError(status, bodyText) {
  const body = String(bodyText || '');
  const pick = (re) => (body.match(re) || [])[1];

  if (status === 400) {
    if (/max_completion_tokens/i.test(body)) {
      return { cause: '这个模型只接受 max_completion_tokens，不接受 max_tokens', fix: '把「最大 Tokens」留空（留空即不发送该参数）' };
    }
    if (/max_tokens/i.test(body)) {
      return { cause: '端点不接受 max_tokens 参数', fix: '把「最大 Tokens」留空再试' };
    }
    if (/context length|too long|maximum context/i.test(body)) {
      return { cause: '输入超出模型的上下文窗口', fix: '减少「携带最近楼层数」，或精简角色档案库 / 模版' };
    }
    if (/model/i.test(body)) {
      return { cause: `模型名不被接受${pick(/"message"\s*:\s*"([^"]{0,120})/) ? `：${pick(/"message"\s*:\s*"([^"]{0,120})/)}` : ''}`, fix: '点「获取」拉一次真实模型列表，从里面选' };
    }
    return { cause: `参数被拒绝（HTTP 400）`, fix: '看下方原始响应；多半是模型名或参数与端点不匹配' };
  }
  if (status === 401) return { cause: 'API Key 无效或没带上', fix: '重新填 Key；确认是这家服务自己的 Key，且没有多余空格' };
  if (status === 402) return { cause: '账户余额不足', fix: '到服务商后台充值，或换一个 Key / 端点' };
  if (status === 403) return { cause: '被拒绝访问（Key 权限不足或地区限制）', fix: '检查 Key 权限；中转站确认是否需要额外请求头' };
  if (status === 404) {
    return { cause: '端点不存在（HTTP 404）', fix: '确认地址：多半是漏了 /v1，或把网页地址填成了 API 地址' };
  }
  if (status === 422) return { cause: '参数格式不对（HTTP 422）', fix: '检查模型名与参数；有的端点要求 model 必须是它列表里的原样字符串' };
  if (status === 429) return { cause: '触发限流或额度用尽', fix: '等几秒再试；看该账户配额与并发限制' };
  if (status >= 500) return { cause: `上游服务出错（HTTP ${status}）`, fix: '稍后重试；持续失败就换端点或模型' };
  return { cause: `请求失败（HTTP ${status}）`, fix: '检查地址、Key 与模型名' };
}

/** 发一次 chat 请求。返回正文；失败抛 LlmApiError（带 httpStatus / detail）。 */
export async function chatOnce(p, messages, opts = {}) {
  const url = chatEndpoint(p?.baseUrl);
  const body = buildChatBody(p, messages, p?.model);
  const timeoutSec = Number(opts.timeoutSec ?? p?.timeoutSec) || 120;

  let res;
  try {
    res = await fetchWithTimeout(url, {
      method: 'POST',
      headers: authHeaders(p),
      body: JSON.stringify(body),
    }, timeoutSec);
  } catch (err) {
    const abort = /abort/i.test(err?.name || '') || /abort/i.test(err?.message || '');
    const e = new LlmApiError(
      abort ? `请求超时（${timeoutSec}s）` : `连不上：${err?.message || err}`,
      { cause: abort ? `模型 ${timeoutSec} 秒没回` : '网络不通、地址拼错，或本地服务没启动' },
    );
    e.timeout = abort;
    throw e;
  }

  const text = await res.text();
  let json = null;
  const trimmed = String(text || '').trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try { json = JSON.parse(trimmed); } catch { /* 留给下面报错 */ }
  }

  if (!res.ok) {
    const msg = json?.error?.message || json?.message
      || pickMessageFromText(trimmed) || `HTTP ${res.status}`;
    const friendly = explainLlmError(res.status, trimmed);
    const e = new LlmApiError(String(msg).slice(0, 300), {
      status: res.status,
      body: trimmed.slice(0, 800),
      ...friendly,
    });
    e.httpStatus = res.status;
    throw e;
  }

  if (!json) {
    const e = new LlmApiError(
      '响应不是 JSON —— 地址多半填成了网页，或该端点返回了别的东西',
      { body: trimmed.slice(0, 300) },
    );
    throw e;
  }
  // 有的端点 200 里也塞 error
  if (json.error && !json.choices) {
    const e = new LlmApiError(json.error.message || '端点返回了错误对象', { body: trimmed.slice(0, 500) });
    throw e;
  }

  /* 记账：拿到 usage 就记一次（含缓存命中 token）。记不上也绝不影响出词。 */
  try { recordUsage(json.usage, { source: opts.source || '', model: p?.model }); } catch { /* 静默 */ }

  return extractReply(json);
}

function pickMessageFromText(t) {
  const m = String(t || '').match(/"message"\s*:\s*"([^"]{0,200})"/);
  return m ? m[1] : '';
}

/* ============================================================
   模型列表
   ============================================================ */

/** 拉模型列表。失败抛 LlmApiError（带人话的 cause/fix）。 */
export async function fetchModels(p, opts = {}) {
  const url = modelsEndpoint(p?.baseUrl);
  let res;
  try {
    res = await fetchWithTimeout(url, { headers: authHeaders(p) }, opts.timeoutSec || 20);
  } catch (err) {
    const e = new LlmApiError(`连不上模型列表接口：${err?.message || err}`, {
      cause: '网络不通或地址拼错',
      fix: `完整地址是 ${url} —— 确认服务在运行、地址没写错`,
    });
    throw e;
  }

  const text = await res.text();
  if (!res.ok) {
    const friendly = explainLlmError(res.status, text);
    const e = new LlmApiError(`获取模型列表失败（HTTP ${res.status}）`, {
      status: res.status, body: text.slice(0, 400), ...friendly,
    });
    e.httpStatus = res.status;
    throw e;
  }

  let json = null;
  try { json = JSON.parse(text); } catch { /* 下面统一报 */ }
  const list = Array.isArray(json?.data) ? json.data
    : Array.isArray(json?.models) ? json.models
      : Array.isArray(json) ? json : [];

  const ids = list
    .map(x => String(x?.id || x?.name || x || '').trim())
    .filter(Boolean);
  // 去重并排序，方便在 datalist 里扫
  return Array.from(new Set(ids)).sort((a, b) => a.localeCompare(b));
}

/* ============================================================
   测试连接
   ============================================================ */

/**
 * 「测试 API 连接」。
 *
 * 刻意**真发一次最小 chat 请求**，而不是只 GET /models ——
 * 因为「Key 有效」和「能出词」是两件事：模型名写错、上下文窗口对不上、
 * 余额耗尽，全都能在 /models 那里蒙混过关，却在实际调用时炸掉。
 * 这跟生图那边「测试连接 ≠ 测试生图」是同一条经验。
 */
export async function testConnection(p, opts = {}) {
  const t0 = Date.now();
  const probe = String(opts.prompt || '请只回复两个字：收到').trim();
  try {
    const reply = await chatOnce(p, [{ role: 'user', content: probe }], { timeoutSec: opts.timeoutSec || 30 });
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    const trimmed = String(reply || '').trim();
    if (!trimmed) {
      return {
        ok: false,
        elapsed,
        error: '服务器返回了 200，但正文是空的',
        cause: '模型名可能不对（有些端点对未知模型返回空响应而非报错），或输出长度被限制为 0',
        fix: '点「获取」确认模型名；把「最大 Tokens」调大',
      };
    }
    return { ok: true, reply: trimmed.slice(0, 200), elapsed };
  } catch (err) {
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    return {
      ok: false,
      elapsed,
      error: err?.message || String(err),
      cause: err?.detail?.cause || '请求没能完成',
      fix: err?.detail?.fix || '检查接口地址、API Key 与模型名',
      status: err?.httpStatus,
    };
  }
}

/** 把测试结果写进诊断日志（UI 层调用）。 */
export function logTestResult(p, res) {
  const model = String(p?.model || '未填模型');
  if (res.ok) debug(STAGE.API, `独立 API 测试通过（${model} · ${res.elapsed}s）：${res.reply}`);
  else warn(STAGE.API, `独立 API 测试失败（${model}）：${res.error}`);
}

/* ============================================================
   供 api.js 直接使用的一步到位入口
   ============================================================ */

/**
 * 用独立 API 发一次分析请求。
 * @returns {Promise<string>} 正文；失败返回 ''（诊断由调用方记录）
 */
export async function callCustomLlm(p, messages, opts = {}) {
  const source = opts.source || '图像分析';
  debug(STAGE.API, `请求 ${source}（独立 API）：${chatEndpointSafe(p)} · 模型 ${p?.model}`);

  try {
    const out = await chatOnce(p, messages, { timeoutSec: opts.timeoutSec, source });
    if (!String(out || '').trim()) {
      diagnose(STAGE.API, `${source} 失败：独立 API 返回了空正文`, {
        cause: '模型名可能不被该端点接受，或参数把输出压没了',
        fix: '到「出词 API」页点「测试 API 连接」单独验一次；顺带确认最大 Tokens 不是 0',
      });
      return '';
    }

    /**
     * ★ v0.9.64 截断兜底：推理模型 JSON 写到一半 token 用尽。
     * 与上面「空正文」不同 —— 它**正常返回半截文本、不抛错**，所以走不到任何
     * 基于异常的兜底，而上层拿到半截 JSON 只能解析失败（表现为整楼不出图）。
     * 判据纯文本（不依赖各家不一至的 finish_reason）：以 { 开头却没以 } 结尾。
     * 只重试一次，且只在还没到 16384 上限时翻倍。
     */
    const stripFence = (x) => String(x || '')
      .replace(/^```(?:json)?/i, '')
      .replace(/```$/i, '')
      .trim();
    const closedJson = (x) => {
      const t = stripFence(x);
      return t.startsWith('{') && t.endsWith('}');
    };
    const curMax = Number(p?.maxTokens) || 4096;
    if (!closedJson(out) && stripFence(out).startsWith('{') && curMax < 16384) {
      const retryP = { ...p, maxTokens: Math.min(curMax * 2, 16384) };
      try {
        const out2 = await chatOnce(retryP, messages, { timeoutSec: opts.timeoutSec, source });
        if (closedJson(out2)) {
          diagnose(STAGE.API, `${source}：输出被 max_tokens 截断（推理模型思维链吃掉了预算）—— 已自动翻倍到 ${retryP.maxTokens} 重试成功`, {
            cause: '推理模型把输出预算花在思维链上，JSON 只写了一半就没额度了',
            fix: '已自动处理；若反复出现，到「出词 API」页把「最大 Tokens」调大，或换非推理模型',
          });
          return out2;
        }
      } catch { /* 重试也失败 → 照常返回第一次的结果（上层会报解析失败） */ }
    }

    return out;
  } catch (err) {
    // ★ 思维链吃光 token 的自动降级（实测第 1、2 轮全灭的根因）：
    //   推理模型（R1 系）收到 <thinking> 预填充会把 max_tokens 全烧在推理上，JSON 一字不剩。
    //   处理：去掉预填充 + 翻倍 max_tokens，立即重试一次 —— 用户什么都不用改。
    //   v0.9.38：原来只在「删得掉 <thinking> 预填充」时才重试 —— 但分析请求是
    //   system+user 两段、没有预填充，推理模型烧光 token 时这条兜底永远触发不了
    //   （实测 deepseek-flash 对 3 万字符分析请求就是这么全灭的：#17/#13 两楼
    //   反复失败，手动重跑也一样）。现在没有预填充也重试：只翻倍 max_tokens。
    if (/思考过程|思维链/.test(String(err?.message || ''))) {
      const retryMsgs = messages.filter(m => !(m?.role === 'assistant' && String(m.content).trim() === '<thinking>'));
      const droppedPrefill = retryMsgs.length !== messages.length;
      const retryP = { ...p, maxTokens: Math.min((Number(p?.maxTokens) || 4096) * 2, 16384) };
      try {
        const out2 = await chatOnce(retryP, retryMsgs, { timeoutSec: opts.timeoutSec, source });
        if (String(out2 || '').trim()) {
          diagnose(STAGE.API, `${source}：思维链吃光了 token —— 已自动翻倍 max_tokens 到 ${retryP.maxTokens}${droppedPrefill ? '并去掉预填充' : ''}，重试成功`, {
            cause: '推理模型把输出预算全花在思维链上，正文为空',
            fix: '已自动处理；若反复出现，到「出词 API」页换非推理模型（如 deepseek-chat）一劳永逸',
          });
          return out2;
        }
      } catch { /* 重试也失败 → 走下面的原错误处理 */ }
    }
    if (err?.timeout) {
      diagnose(STAGE.API, `${source} 失败：独立 API 超时`, {
        cause: err?.detail?.cause || '模型响应太慢',
        fix: '把超时时间调大；或换更快的模型',
      }, err?.detail);
      return '';
    }
    diagnose(STAGE.API, `${source} 失败：独立 API 出错 —— ${err?.message || err}`, {
      cause: err?.detail?.cause || '请求被端点拒绝',
      fix: err?.detail?.fix || '到「出词 API」页点「测试 API 连接」定位问题',
    }, err?.detail);
    return '';
  }
}

function chatEndpointSafe(p) {
  try { return chatEndpoint(p?.baseUrl); } catch { return '(地址未填)'; }
}

/** 生成一份脱敏的接口摘要（诊断面板 / 日志用，绝不带 Key）。 */
export function describeEndpoint(p) {
  const url = chatEndpointSafe(p);
  const key = String(p?.apiKey || '').trim();
  return {
    url,
    model: String(p?.model || ''),
    keyHint: key ? `${key.slice(0, 4)}…${key.slice(-4)}（${key.length} 位）` : '未填',
  };
}

export { info, warn };
