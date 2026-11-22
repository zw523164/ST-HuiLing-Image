/**
 * 绘灵 · 独立 LLM 调用
 *
 * 为什么独立管线而不是改成主请求内联：
 *   内联省一次 API 调用，但要求改写用户的主提示词模版，侵入性强、会和已有模版打架。
 *   绘灵选独立管线：主对话完全不受影响，代价是每楼多一次请求。
 *
 * 三种出词通道（cfg.llm.mode）：
 *   follow   跟随酒馆主 API —— generateRaw → generateQuietPrompt 依次回退
 *   channel  酒馆的连接预设 —— ConnectionManagerRequestService（失败回退到 follow）
 *   custom   独立 API —— 绘灵直连 OpenAI 兼容端点，**失败不回退**
 *
 * custom 为什么不回退：你显式选了这条通路，它坏了就该当场告诉你坏在哪。
 * 偷偷换一条路把词出出来，只会让你以为"配置生效了"，直到某天发现结果风格不对
 * 才开始怀疑 —— 那才是真正难查的故障。
 */

import { getCtx } from './st.js';
import { getConfig } from './settings.js';
import { diagnose, debug, STAGE } from './log.js';
import { callCustomLlm } from './llmapi.js';
/* 用量记账（v0.9.143）：让用户在酒馆里就能看到自己花了多少，不必去后台翻。 */
import { record as recordUsage } from './usage.js';

/** 找连接预设服务（不同 ST 版本挂载点不同）。 */
function findConnectionService() {
  const ctx = getCtx();
  const candidates = [
    ctx.ConnectionManagerRequestService,
    globalThis.ConnectionManagerRequestService,
    globalThis.SillyTavern?.ConnectionManagerRequestService,
  ];
  for (const c of candidates) {
    if (c && typeof c.sendRequest === 'function') return c;
  }
  return null;
}

async function callViaChannel(channel, messages, maxTokens, temperature, source = '') {
  const svc = findConnectionService();
  if (!svc) return null;
  // 预设可能是名字或 id，优先按 id
  let profileId = channel;
  try {
    const list = svc.getSupportedProfiles?.() || [];
    const hit = list.find(p => p.id === channel || p.name === channel);
    if (hit) profileId = hit.id;
  } catch { /* 用原值试 */ }

  const res = await svc.sendRequest(profileId, messages, maxTokens, {
    temperature,
    extractData: false,
    includePreset: true,
    stream: false,
  });
  if (typeof res === 'string') return res;
  if (res && typeof res === 'object') {
    /**
     * 有的连接服务会把上游 `usage` 一起带回来；有就记，**没有就不记**。
     * 刻意不按字符数估算 —— 估出来的数字会让用户以为自己在看账单，反而误导。
     */
    try { recordUsage(res.usage ?? res.data?.usage, { source: source || '跟随酒馆', model: res.model || '' }); } catch { /* 静默 */ }
    return res.content ?? res.text ?? String(res);
  }
  return null;
}

async function callViaRaw(systemPrompt, userPrompt, maxTokens, temperature) {
  const ctx = getCtx();
  if (typeof ctx.generateRaw !== 'function') return null;
  const out = await ctx.generateRaw({
    systemPrompt,
    prompt: userPrompt,
    responseLength: maxTokens,
    temperature,
    trimNames: false,
  });
  return typeof out === 'string' ? out : String(out ?? '');
}

async function callViaQuiet(systemPrompt, userPrompt, maxTokens) {
  const ctx = getCtx();
  if (typeof ctx.generateQuietPrompt !== 'function') return null;
  const out = await ctx.generateQuietPrompt({
    quietPrompt: `${systemPrompt}\n\n${userPrompt}`,
    responseLength: maxTokens,
    skipWIAN: true,
    quietToLoud: false,
  });
  return typeof out === 'string' ? out : String(out ?? '');
}

/**
 * 发一次分析请求。
 *
 * @param {Array<{role,content}>} messages
 * @param {object} opts { taskId, source, maxTokens, temperature }
 * @returns {Promise<string>} 模型原始文本（可能为空串）
 */
/**
 * 给「酒馆代发」的调用包一层超时。
 *
 * 为什么必须有：generateRaw / generateQuietPrompt 在主 API 无响应、或与主生成
 * 撞车时会**永远 pending**（实测 2026-09-25：任务卡死在分析阶段，请求历史一条
 * 都没有，轮询反复起新任务堆到轮次 11）。custom 通道的 fetch 有 AbortController
 * 超时，这里给 follow / channel 补上同一层保护。
 * 超时 = reject → 外层 catch 走 diagnose（"请求超时"）→ 返回 '' → 管线正常收尾。
 */
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} 超时（${Math.round(ms / 1000)} 秒无响应）`)),
      ms,
    );
    promise.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

export async function callAnalyzeLLM(messages, opts = {}) {
  const cfg = getConfig();
  const llm = cfg.llm || {};
  const mode = String(opts.mode ?? llm.mode ?? 'follow').trim() || 'follow';
  const maxTokens = opts.maxTokens || llm.maxTokens || 4096;
  const temperature = opts.temperature ?? llm.temperature ?? 0.4;
  const channel = (opts.channel ?? llm.channel ?? '').trim();
  const source = opts.source || '图像分析';
  // 测试可传小数；真实使用下限 1s 防手滑填 0
  const timeoutSec = Math.max(1, Number(opts.timeoutSec ?? llm.timeoutSec) || 120);
  const timeoutMs = timeoutSec * 1000;

  // ★ 所有 system 段都要拼 —— 角色卡 / 世界书 / persona 是独立段，
  //   只取第一条会把「这段剧情里的人是谁」整个丢掉（出图跟剧情对不上的元凶之一）。
  const sys = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n');
  // 非 custom 通道没有预填充位，把 assistant 的思维链开头并进 user 末尾：
  // 提示模型先想再答；解析端照样会剥掉 think 块。
  const user = messages.filter(m => m.role !== 'system').map(m => m.content).join('\n\n');

  /* ---------- 独立 API：不走酒馆任何一层，直连 ---------- */

  if (mode === 'custom') {
    const custom = llm.custom || {};
    if (!String(custom.baseUrl || '').trim()) {
      diagnose(STAGE.API, `${source} 失败：出词通道选了「独立 API」，但接口地址是空的`, {
        cause: 'custom 模式下绘灵直连你填的端点，地址是必填项',
        fix: '到「出词 API」页填上接口地址与模型名；或把调用方式切回「跟随酒馆主 API」',
      });
      return '';
    }
    if (!String(custom.model || '').trim()) {
      diagnose(STAGE.API, `${source} 失败：独立 API 没有填模型名`, {
        cause: '端点不知道要调哪个模型',
        fix: '到「出词 API」页点「获取」拉一次模型列表，从里面选一个',
      });
      return '';
    }
    debug(STAGE.API, `请求 ${source}：system ${sys.length} 字 / user ${user.length} 字 / 通道 独立 API（${custom.model}）`);
    return callCustomLlm(custom, messages, { source, timeoutSec: opts.timeoutSec ?? llm.timeoutSec });
  }

  debug(STAGE.API, `请求 ${source}：system ${sys.length} 字 / user ${user.length} 字 / 通道 ${mode === 'channel' && channel ? `连接预设「${channel}」` : '跟随主 API'}`);

  const t0 = Date.now();

  try {
    if (mode === 'channel' && !channel) {
      diagnose(STAGE.API, `${source} 提示：出词通道选了「连接预设」，但没选具体是哪个预设`, {
        cause: '没有指定预设名，无法定位到具体连接',
        fix: '到「出词 API」页从下拉里选一个预设；或把调用方式切回「跟随酒馆主 API」',
      });
    }

    if (mode === 'channel' && channel) {
      const viaChannel = await withTimeout(
        callViaChannel(channel, messages, maxTokens, temperature, source),
        timeoutMs, `${source}（连接预设）`,
      );
      if (viaChannel != null) {
        debug(STAGE.API, `${source} 完成（连接预设），耗时 ${Date.now() - t0}ms`);
        return viaChannel;
      }
      diagnose(STAGE.API, `指定的连接预设「${channel}」不可用，已回退到主 API`, {
        cause: '连接管理器服务没挂到可访问的位置，或预设名写错了',
        fix: '到「模型渠道」里点「刷新预设列表」重新选一次；或者清空该字段直接用主 API',
      });
    }

    const viaRaw = await withTimeout(
      callViaRaw(sys, user, maxTokens, temperature),
      timeoutMs, `${source}（generateRaw）`,
    );
    if (viaRaw != null) {
      debug(STAGE.API, `${source} 完成（generateRaw），耗时 ${Date.now() - t0}ms`);
      return viaRaw;
    }

    const viaQuiet = await withTimeout(
      callViaQuiet(sys, user, maxTokens),
      timeoutMs, `${source}（generateQuietPrompt）`,
    );
    if (viaQuiet != null) {
      debug(STAGE.API, `${source} 完成（generateQuietPrompt），耗时 ${Date.now() - t0}ms`);
      return viaQuiet;
    }

    diagnose(STAGE.API, `${source} 失败：酒馆没有可用的文本生成接口`, {
      cause: 'ST 版本过低，generateRaw 与 generateQuietPrompt 都不存在',
      fix: '升级 SillyTavern 到 1.12.13 以上；或检查是否有其他扩展劫持了生成接口',
    });
    return '';
  } catch (err) {
    const msg = err?.message || String(err);
    diagnose(STAGE.API, `${source} 请求异常：${msg}`, {
      cause: guessApiCause(msg),
      fix: '检查主 API 是否可用（先在酒馆里正常聊一句）；若用的是本地模型，确认服务在运行',
    }, err?.stack);
    return '';
  }
}

function guessApiCause(msg) {
  const m = String(msg).toLowerCase();
  if (m.includes('timeout') || m.includes('timed out') || m.includes('超时')) return '请求超时——模型响应太慢或上下文太长（可在「出词 API」页调大超时秒数）';
  if (m.includes('context') || m.includes('token')) return '上下文超出模型窗口——减少「携带最近楼层数」，或精简角色档案库';
  if (m.includes('401') || m.includes('403') || m.includes('api key')) return '鉴权失败——API Key 无效或已过期';
  if (m.includes('429')) return '触发限流——请求太频繁，等一会儿再试';
  if (m.includes('econnrefused') || m.includes('fetch failed')) return '连不上模型服务——本地模型未启动，或地址写错';
  return '模型服务返回了错误，具体原因见原始数据';
}

/** 探测当前可用的调用方式（设置页的"测试连接"用）。 */
export function probeLLM() {
  const ctx = getCtx();
  const mode = String(getConfig()?.llm?.mode || 'follow');
  return {
    mode,
    hasGenerateRaw: typeof ctx.generateRaw === 'function',
    hasQuietPrompt: typeof ctx.generateQuietPrompt === 'function',
    hasConnectionService: !!findConnectionService(),
  };
}

/**
 * 列出酒馆里可用的「连接预设」（给「出词 API」页的下拉用）。
 *
 * 不同 ST 版本这个方法叫法不一（getSupportedProfiles / getProfiles），
 * 拿不到就返回空数组 —— 让 UI 显示「没找到预设」而不是崩掉。
 * @returns {Array<{id:string,name:string,model?:string}>}
 */
export function listConnectionProfiles() {
  const svc = findConnectionService();
  if (!svc) return [];
  let raw = [];
  try {
    raw = (typeof svc.getSupportedProfiles === 'function' && svc.getSupportedProfiles())
      || (typeof svc.getProfiles === 'function' && svc.getProfiles())
      || [];
  } catch {
    return [];
  }
  if (!Array.isArray(raw)) return [];
  return raw.map((p) => {
    if (typeof p === 'string') return { id: p, name: p };
    return {
      id: String(p?.id ?? p?.name ?? ''),
      name: String(p?.name ?? p?.id ?? ''),
      model: String(p?.model ?? p?.api_model ?? ''),
    };
  }).filter(p => p.id || p.name);
}
