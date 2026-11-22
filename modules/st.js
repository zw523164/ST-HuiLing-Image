/**
 * 绘灵 · 酒馆适配层
 *
 * 只做一件事：把 SillyTavern 的上下文 API 包成一组稳定的函数。
 * 所有对酒馆内部结构的访问都收口在这里，将来 ST 改 API 只需要改这个文件。
 *
 * 参考实现时踩到的坑（已写进注释）：
 *  - ST 1.18 的 getContext() 没有 ctx.persona / ctx.user，persona 名在 ctx.name1
 *  - persona 描述在 ctx.powerUserSettings.persona_description
 *  - 正文写入要同时更新 message.mes 和 message.swipes[swipe_id]
 */

import { warn, STAGE } from './log.js';

export function getCtx() {
  try {
    return globalThis.SillyTavern?.getContext?.() ?? {};
  } catch {
    return {};
  }
}

/**
 * 调酒馆自己的服务端接口（/api/*）时用的请求头。
 * 关键在 CSRF token —— 少了它，POST /api/images/upload 会被 ST 挡回来。
 */
export function getRequestHeaders() {
  const ctx = getCtx();
  try {
    if (typeof ctx.getRequestHeaders === 'function') return ctx.getRequestHeaders();
  } catch { /* 落到下面的兜底 */ }
  const token = ctx.token || globalThis.token || '';
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['X-CSRF-Token'] = token;
  return headers;
}

export function getEventTypes() {
  const ctx = getCtx();
  return ctx.event_types || ctx.eventTypes || {};
}

export function getEventSource() {
  return getCtx().eventSource || null;
}

export function onEvent(type, handler) {
  const src = getEventSource();
  if (src?.on && type) src.on(type, handler);
}

export function offEvent(type, handler) {
  const src = getEventSource();
  if (src?.off && type) src.off(type, handler);
}

/* ============ 身份 ============ */

export function getCharName() {
  try {
    const ctx = getCtx();
    return ctx.characters?.[ctx.characterId]?.data?.name
      || ctx.characters?.[ctx.characterId]?.name
      || ctx.name2
      || '';
  } catch {
    return '';
  }
}

export function getUserName() {
  try {
    const ctx = getCtx();
    return ctx.name1 || '';
  } catch {
    return '';
  }
}

/** 稳定聊天 ID：优先 chatId，其次 chat_name，最后兜底。 */
export function getChatId() {
  try {
    const ctx = getCtx();
    const charPart = String(getCharName()).replace(/[^\w\u4e00-\u9fff-]/g, '');
    let chatPart = ctx.chatId || ctx.chatMetadata?.chat_name || ctx.chat_metadata?.chat_name || '';
    if (!chatPart && Array.isArray(ctx.chat)) {
      chatPart = `_${ctx.chat.length}_${String(ctx.chat[0]?.mes || '').slice(0, 20).replace(/[^\w\u4e00-\u9fff]/g, '')}`;
    }
    const key = `${charPart}_${String(chatPart).replace(/[^\w\u4e00-\u9fff-]/g, '')}`;
    return key || 'unknown';
  } catch {
    return 'unknown';
  }
}

/* ============ 聊天与楼层 ============ */

export function getChat() {
  const ctx = getCtx();
  return Array.isArray(ctx.chat) ? ctx.chat : [];
}

export function getMessage(mesId) {
  const chat = getChat();
  const msg = chat?.[Number(mesId)];
  return msg || null;
}

/** 当前 swipe 的正文。 */
export function getMessageText(mesId) {
  const msg = getMessage(mesId);
  if (!msg) return '';
  const swipeId = Number.isFinite(msg.swipe_id) ? msg.swipe_id : 0;
  if (Array.isArray(msg.swipes) && msg.swipes.length > 1 && msg.swipes[swipeId] != null) {
    return String(msg.swipes[swipeId]);
  }
  return String(msg.mes ?? '');
}

/** 最后一条 AI 楼层的索引（跳过 user 楼）。 */
export function getLastAiMesId() {
  const chat = getChat();
  for (let i = chat.length - 1; i >= 0; i -= 1) {
    if (!chat[i]?.is_user) return i;
  }
  return -1;
}

/**
 * 事务式写回正文。
 * 同时更新 message.mes 与 swipes[swipe_id]，两处都成功才算成功。
 *
 * @param {number} mesId
 * @param {string} newText
 * @param {string} [expectPrefix] 若给出，当前文本不以它开头则不写入（防并发覆盖）
 * @returns {boolean}
 */
export function setMessageText(mesId, newText, expectPrefix) {
  const msg = getMessage(mesId);
  if (!msg) return false;

  const current = getMessageText(mesId);
  if (expectPrefix && !current.startsWith(expectPrefix)) {
    warn(STAGE.RENDER, `楼层 #${mesId} 内容已变化，放弃写入（避免覆盖用户编辑）`);
    return false;
  }

  const prevMes = msg.mes;
  const swipeId = Number.isFinite(msg.swipe_id) ? msg.swipe_id : 0;
  const hadSwipes = Array.isArray(msg.swipes);
  const prevSwipe = hadSwipes ? msg.swipes[swipeId] : undefined;

  try {
    msg.mes = newText;
    if (hadSwipes && swipeId >= 0 && swipeId < msg.swipes.length) msg.swipes[swipeId] = newText;

    const ctx = getCtx();
    if (typeof ctx.saveChat === 'function') ctx.saveChat();
    else if (typeof ctx.saveChatDebounced === 'function') ctx.saveChatDebounced();

    refreshMessageBlock(mesId);
    return true;
  } catch (err) {
    // 回滚
    msg.mes = prevMes;
    if (hadSwipes && prevSwipe !== undefined) msg.swipes[swipeId] = prevSwipe;
    warn(STAGE.RENDER, `写入楼层 #${mesId} 失败，已回滚`, err?.message);
    return false;
  }
}

/**
 * 通知酒馆**真正重绘**该楼层块。
 *
 * 这里有个必须踩过的坑：改完 chat[mesId].mes 只改了数据，
 * 聊天界面上的 DOM 还是旧的 —— 显示侧正则（把 tag 变成出图位占位符）
 * 根本没机会跑，渲染层就找不到槽可填，图会凭空不出现。
 *
 * 酒馆把 updateMessageBlock 暴露在上下文里，调它会重跑 messageFormatting：
 *   mes → 显示侧正则 → 占位符 → markdown 转换 → 写回 .mes_text
 * 必须走这一步，不能只发事件（MESSAGE_UPDATED 的语义是「已经更新完了」，
 * 是通知，不是命令 —— 单靠它没人会去重绘）。
 */
export function refreshMessageBlock(mesId) {
  const id = Number(mesId);
  if (!Number.isFinite(id) || id < 0) return false;

  const ctx = getCtx();
  let redrawn = false;

  try {
    const msg = ctx.chat?.[id];
    if (typeof ctx.updateMessageBlock === 'function' && msg) {
      ctx.updateMessageBlock(id, msg);
      redrawn = true;
    }
  } catch (err) {
    warn(STAGE.RENDER, `重绘楼层 #${id} 失败（回退为仅发事件）：${err?.message || err}`);
  }

  try {
    const types = getEventTypes();
    if (types.MESSAGE_UPDATED) ctx.eventSource?.emit?.(types.MESSAGE_UPDATED, id);
  } catch { /* 事件失败不影响已完成的 DOM 重绘 */ }

  return redrawn;
}

/* ============ 素材读取 ============ */

/** persona 描述（用户设定），用于补充 User 档案。 */
export function getPersonaDescription() {
  try {
    const ctx = getCtx();
    return ctx.powerUserSettings?.persona_description || '';
  } catch {
    return '';
  }
}

/** 当前角色卡描述。 */
export function getCharDescription() {
  try {
    const ctx = getCtx();
    const c = ctx.characters?.[ctx.characterId];
    return c?.data?.description || c?.description || '';
  } catch {
    return '';
  }
}

/**
 * 角色卡内嵌世界书条目（拼成一段文本）。
 * @param {object} opts 同 getGlobalWorldBookText：keywords 排序 / perEntryChars 单条上限。
 */
export function getCharWorldBookText(opts = {}) {
  try {
    const ctx = getCtx();
    const entries = ctx.characters?.[ctx.characterId]?.data?.character_book?.entries;
    if (!Array.isArray(entries)) return '';
    const keywords = (Array.isArray(opts.keywords) ? opts.keywords : []).filter(k => k && String(k).length >= 2);
    const perEntry = Number(opts.perEntryChars) || 1200;

    const items = entries
      .filter(e => e && e?.enabled !== false && e?.content)
      .map(e => {
        const content = String(e.content || '');
        const comment = String(e.comment || (e.keys || []).join(',') || '');
        if (isSysEntry(comment, content)) return null;
        let score = 0;
        for (const kw of keywords) {
          const k = String(kw);
          if (comment.includes(k)) score += 20;
          else if (content.slice(0, 400).includes(k)) score += 5;
        }
        if (/人设|人物|角色|设定|简介|地点/.test(comment)) score += 3;
        const cut = content.length > perEntry ? `${content.slice(0, perEntry)}\n…（该条已截断）` : content;
        return { score, text: `${comment}: ${cut}` };
      })
      .filter(Boolean);

    if (!items.length) return '';
    items.sort((a, b) => b.score - a.score);
    return items.map(i => i.text).join('\n');
  } catch {
    return '';
  }
}

/** 变量/状态机类条目：给主 AI 更新数值用的，不是世界观，喂给生图模型只会污染画面。 */
const WB_SYS_RES = [
  /\[mvu_update\]/i, /\[initvar\]/i,
  /变量(列表|说明|更新|初始化)/,
  /json_patch/i, /<status_/i,
];

const isSysEntry = (comment, content) =>
  WB_SYS_RES.some(re => re.test(comment) || re.test(content.slice(0, 200)));

/** 判定条目是否禁用（ST 里这个值既有布尔也有字符串，两种都得认）。 */
function isDisabled(entry) {
  const d = entry?.disable ?? entry?.enabled;
  if (d === true || d === 'true' || d === 'True') return true;   // disable=true → 禁用
  if (d === false || d === 'false' || d === 'False') return false; // disable=false → 启用
  return false;
}

/**
 * 全局世界书（ST 的 world_info）。尽力而为：拿不到就返回空，
 * 不阻断生图（记忆源不是硬依赖的原则）。
 *
 * @param {object} opts
 * @param {string[]} opts.keywords  当前正文里的人名/地名 —— 命中的条目往前排。
 *                                  世界书动辄几万字，截断时顺序决定喂进去的是什么：
 *                                  实测踩过坑，按原顺序取前 4000 字拿到了变量模板，
 *                                  真正的「月咏深雪人设」(6803字)排在后面被整段切掉。
 * @param {number} opts.perEntryChars 单条目上限，避免一条几万字的条目吃掉全部预算。
 */
export function getGlobalWorldBookText(opts = {}) {
  try {
    const ctx = getCtx();
    const wi = ctx.worldInfo || globalThis.world_info;
    if (!wi || typeof wi !== 'object') return '';
    const keywords = (Array.isArray(opts.keywords) ? opts.keywords : []).filter(k => k && String(k).length >= 2);
    const perEntry = Number(opts.perEntryChars) || 1200;

    const items = [];
    for (const [key, entry] of Object.entries(wi)) {
      if (!entry || isDisabled(entry)) continue;
      const content = String(entry.content || '');
      if (!content.trim()) continue;
      const comment = String(entry.comment || entry.key || key || '');
      if (isSysEntry(comment, content)) continue;

      // 相关性：命中当前出场人物/地点的排前面。
      // 标题命中(20) 要明显高于内容命中(5) —— 否则"某角色条目里顺带提到了主角名字"
      // 会把没出场的人设顶到第一位（实测：爱丽莎没出场却排到了深雪前面）。
      let score = 0;
      for (const kw of keywords) {
        const k = String(kw);
        if (comment.includes(k)) score += 20;
        else if (content.slice(0, 400).includes(k)) score += 5;
      }
      if (/人设|人物|角色|设定|简介|地点/.test(comment)) score += 3;

      const cut = content.length > perEntry ? `${content.slice(0, perEntry)}\n…（该条已截断）` : content;
      items.push({ score, text: `${comment}: ${cut}` });
    }

    if (!items.length) return '';
    items.sort((a, b) => b.score - a.score);
    return items.map(i => i.text).join('\n');
  } catch {
    return '';
  }
}

/* ============ 用户文件上传 / 删除（v0.9.56，服装预设展示图用） ============ */

/**
 * 酒馆服务端 /api/files/upload 只接受 ASCII 文件名（[a-zA-Z0-9_\-.]+），
 * 预设名常是中文 —— 用稳定 hash 命名。
 *
 * ★ v0.9.73 文件名里必须带**图片内容**的 hash（不止预设名）：
 *   旧版 `huiling-preset-<预设名hash>.jpg` —— 同一预设永远同一个 URL。
 *   换图时服务端文件确实被覆盖了（磁盘 mtime 会更新），但 <img> 的 src 一字不差，
 *   浏览器走启发式缓存**根本不发请求**，用户看到的永远是第一次传的那张 ——
 *   「重新选图无法保存，老是沿用第一次的图」。内容 hash 让新图天然拿到新 URL，
 *   缓存立刻失效；同一张图重复上传仍是同一个文件名，不产生垃圾（保留原设计初衷）。
 *   旧文件的清理不靠这里 —— cast.js 的 applyData 发现 path 变了会删旧文件。
 */
function djb2Hex(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i += 1) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h.toString(16).padStart(8, '0');
}

/**
 * 上传一张图片（dataURL）到酒馆的 user/files 目录，返回相对路径（失败返回 ''）。
 * 原始文件落在 st_data/<用户>/user/files/huiling-preset-*.jpg —— 不在存档 json 里，
 * 存档损坏 / 清理也不会丢；删除预设时要配 deleteUserFile() 把文件一并删掉。
 * @param {string} baseName 命名来源（预设名，只用来做 hash）
 * @param {string} dataUrl  data:image/...;base64,xxx
 */
export async function uploadUserFile(baseName, dataUrl) {
  const m = /^data:image\/[a-z+]+;base64,(.+)$/i.exec(String(dataUrl || ''));
  if (!m) return '';
  const name = `huiling-preset-${djb2Hex(String(baseName || ''))}-${djb2Hex(m[1])}.jpg`;
  try {
    const res = await fetch('/api/files/upload', {
      method: 'POST',
      headers: getRequestHeaders(),
      body: JSON.stringify({ name, data: m[1] }),
    });
    if (!res.ok) return '';
    const j = await res.json();
    return String(j?.path || '');
  } catch { return ''; }
}

/** 删除 uploadUserFile 上传的文件（失败静默 —— 文件残留无害，只多占一点磁盘）。 */
export async function deleteUserFile(relPath) {
  const p = String(relPath || '');
  if (!p || p.startsWith('data:')) return;
  try {
    await fetch('/api/files/delete', {
      method: 'POST',
      headers: getRequestHeaders(),
      body: JSON.stringify({ path: p }),
    });
  } catch { /* 静默 */ }
}

/** 生成一个随机 client_id（ComfyUI 提交用）。 */
export function randomClientId() {
  try {
    if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  } catch { /* fallthrough */ }
  return `huilin-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/* ============ 生成中判定（v0.9.33 重写，别再改回 globalThis 那套） ============ */

/**
 * ST 1.18 的 public/script.js 里是 `export let is_send_press = false;`。
 * ESM 的 export 绑定**不会**成为 globalThis 的属性 —— 所以老写法
 * `globalThis.is_send_press === true` 恒为 false。
 *
 * 2026-09-28 事故根因：就因为这一行，「生成中挂起渲染」这条防线（2026-09-25 加的）
 * 从来没生效过。流式输出期间正文每变一次就整楼重建一次，<img> 反复重新下载+解码，
 * 渲染进程烧满 —— 用户看到的就是「界面完全点不动，F12 也打不开」。
 * （判定依据：CSS 特效还在闪 = 合成线程活着，主线程被同步 JS 占死。）
 *
 * 正确取法：动态 import 拿到模块对象再读属性。ESM 是 live binding，
 * 缓存下来的模块对象上的 is_send_press 会随 ST 内部赋值实时更新。
 */
let stScriptMod = null;

/** 预热：插件初始化时异步调一次，之后 isGeneratingNow() 就能同步用了。 */
export async function primeScriptModule() {
  if (stScriptMod) return stScriptMod;
  try {
    // modules/st.js → public/script.js（5 级：modules/→插件/→third-party/→extensions/→scripts/→public/）
    stScriptMod = await import('../../../../../script.js');
  } catch {
    try { stScriptMod = await import('/script.js'); }
    catch { stScriptMod = null; }
  }
  return stScriptMod;
}

/**
 * 纯函数：从酒馆 script 模块对象上读「生成中」标志。
 * 单独抽出来是为了能单测 —— 这条判定出过错（恒 false 导致页面卡死），必须有护栏。
 */
export function readGeneratingFlag(mod) {
  if (!mod) return false;
  try {
    if (typeof mod.isGenerating === 'function' && mod.isGenerating()) return true;
  } catch { /* isGenerating 可能不存在或抛错，落到下一档 */ }
  try {
    if (mod.is_send_press === true) return true;
  } catch { /* noop */ }
  return false;
}

/** 测试注入口（dev 用）：让单测能塞一个假模块进来，验证判定链路。 */
export function __injectScriptModule(mod) { stScriptMod = mod; }

/**
 * 酒馆正在生成中？（流式输出 / 请求进行中）
 * 同步返回，可在渲染热路径上高频调用。
 */
export function isGeneratingNow() {
  if (readGeneratingFlag(stScriptMod)) return true;
  // 兜底一：万一某版本真把它挂到了全局
  try { if (globalThis.is_send_press === true) return true; } catch { /* noop */ }
  // 兜底二：只在拿不到模块时用 DOM 判定 —— 「停止」按钮可见即生成中。
  //   不放开到通用路径：误判会让渲染永远挂起（图不显示），比卡顿更糟。
  if (!stScriptMod) {
    try {
      const stop = document.querySelector('#mes_stop');
      if (stop && getComputedStyle(stop).display !== 'none') return true;
    } catch { /* noop */ }
  }
  return false;
}
