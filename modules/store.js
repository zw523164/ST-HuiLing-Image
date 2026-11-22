/**
 * 绘灵 · 角色档案库
 *
 * 这是整个插件的"记忆"。它要回答一个问题：
 *   第 12 楼时，小雪长什么样、穿着什么、衣服在哪个状态位？
 *
 * 三种数据，各自的生命周期不同：
 *
 *   ① 静态锚点（cast）—— 跨楼层永不变
 *      字段式（hair/eyes/face/skin/body/mark），不是一整段文本。
 *      为什么字段式：整段文本每轮都会被 LLM「重新概括」一遍，概括三次就漂移了；
 *      字段式的每个格子是离散的，要么没变要么被显式改写，可审计。
 *
 *   ② 动态状态（dyn）—— 随时变，但必须"逐字段 merge"
 *      这是 mergeDynamicLine 的关键一招：
 *      LLM 只会报「本轮变了什么」，插件负责把没变的部分留住。
 *      少了这一步，角色的发色会在第三轮凭空消失 —— 这才是漂移的真正根因。
 *
 *   ③ 服装层（outfit）—— 独立维度，带状态位状态机
 *      两家参考插件都把服装塞在自由文本字段里，必然漂移。
 *      绘灵把它拆出来：style（穿什么）+ state（五档状态位）+ history（时间线）。
 *
 * 存储：extension_settings.huilin_image.chars[角色卡名].chats[聊天ID]
 */

import {
  getConfig, settingsRoot, saveSettings, OUTFIT_STATES, OUTFIT_LOCK_LEVELS,
  OUTFIT_FOLLOW_MODES, OUTFIT_STATE_MODES, ANCHOR_FIELDS, DYN_FIELDS, APPEAR_STATE_FIELDS,
  activeEngine,
} from './settings.js';
import { getCharName, getChatId, getUserName } from './st.js';
import {
  clone, oneLine, styleCoverage, hasRealGarment, splitOutfitStyle,
  missingGarmentPieces, newGarmentWords,
  isMacroName, macroCore, macroChannel,
} from './util.js';
import { warn, info, STAGE } from './log.js';
import {
  stateDetailOf, OUTFIT_STATE_DETAIL_KEYS, OUTFIT_MOD_KEYS, OUTFIT_SHOES_KEYS,
} from './outfitStateLibrary.js';
import {
  composeHair, composeMakeup, hairToZh, makeupToZh,
  hairStateOf, smudgeOf, resolveHairConflicts, resolveMakeupConflicts,
} from './appearanceLibrary.js';

export const STORE_VERSION = 1;

/** 状态位在状态机里的序号；swapped 不参与线性推进。 */
const STATE_ORDER = { intact: 0, parted: 1, undone: 2, removed: 3, swapped: 3 };

/**
 * 「真的在脱」判定专用的线性序号（v0.9.52）—— 把 swapped 摘出序列。
 *
 * 为什么不能直接用 STATE_ORDER：那里 swapped 与 removed **同为 3**。
 * 于是「换过一次衣服、这一楼又要脱」时 prevOrder=3、nextOrder=3，
 * `nextOrder > prevOrder` 恒为 false → undressing 判定失败 →
 * 部件守恒闸门与覆盖率闸门**同时**拒绝（一处报"提取漏项"、一处报"疑似偷换款式"）。
 * 后果：正文里明明白白写了脱衣，档案却拒收，角色一旦换装就再也脱不掉，
 * 只能靠 pending 连刷 N 楼自动放行兜底。
 *
 * swapped 本就不在线性推进里（它是"换了一身新的"，新衣服当然是完好的），
 * 这里把它当作序列起点 0：intact(0)→parted(1)→undone(2)→removed(3)，
 * swapped 之后再脱衣服重新从 0 起算，走得通。
 */
const linearOrder = (s) => (String(s) === 'swapped' ? 0 : (STATE_ORDER[String(s)] ?? 0));

/* ============ 结构初始化 ============ */

function root() {
  const r = settingsRoot();
  if (!r.version) r.version = STORE_VERSION;
  if (!r.global || typeof r.global !== 'object') r.global = {};
  if (!r.global.identity || typeof r.global.identity !== 'object') r.global.identity = {};
  if (!r.chars || typeof r.chars !== 'object') r.chars = {};
  if (!r.floors || typeof r.floors !== 'object') r.floors = {};
  return r;
}

function emptyEntry(name) {
  return {
    name,
    fields: {},
    identity: {},
    label: '',
    nl: '',
    /**
     * 外观维度的**原始选择值**（v0.9.70）。
     * 例：`{ hair: { len:'及腰长发', color:'黑发', … }, makeup: { type:'素颜' } }`
     * ★ 绝不能放 fields —— 非 ANCHOR 的 fields 会被 `anchorOf` 整个拼进画面词，
     *   一个 JSON 对象进去就是一坨乱码 tag。这里不参与任何画面输出，
     *   只用于：① 档案页回填下拉；② 判断有没有选发饰（决定要不要剥服装自带的帽子）。
     */
    spec: {},
    locked: false,
    source: 'manual',
    createdAt: 0,
    updatedAt: 0,
  };
}

function emptyDyn() {
  return {
    fields: {},
    /**
     * 服装层。
     *   style      具体描述（六要素齐全那种）
     *   preset     引用的服装预设名；非空时优先用预设内容（改了预设全体生效）
     *   lockLevel  '' 跟随全局；'strict' 冻结款式 / 'normal' 防漂移 / 'off' 不检查
     */
    outfit: { style: '', preset: '', state: 'intact', lockLevel: '', changedAt: 0, history: [] },
    /**
     * 外貌状态层（v0.9.70）。
     *   hairState    发型状态档名（wet / tousled…），剧情可更新，只认库里的档名
     *   makeupSmudge 花妆档名（NSFW 下才生效）
     * ★ 放 dyn 而不是静态锚点，正是为了让它**能被剧情改** —— 进了 anchors 会被硬校验锁死。
     */
    appear: {},
    lastSeenRound: 0,
    firstSeenRound: 0,
    ephemeral: false,
    sleep: false,
  };
}

/** 当前角色卡节点；角色卡没读到就返回 null（调用方自行降级）。 */
function charNode(create = true) {
  const r = root();
  const name = getCharName();
  if (!name) return null;
  if (!r.chars[name] && create) r.chars[name] = { cast: {}, chats: {} };
  const node = r.chars[name];
  if (!node) return null;
  if (!node.cast || typeof node.cast !== 'object') node.cast = {};
  if (!node.chats || typeof node.chats !== 'object') node.chats = {};
  return node;
}

function chatNode(create = true) {
  const node = charNode(create);
  if (!node) return null;
  const chatId = getChatId();
  if (!node.chats[chatId] && create) {
    node.chats[chatId] = { _round: 0, present: [], pending: [], dyn: {}, npcs: {}, touchedAt: 0 };
  }
  const chat = node.chats[chatId];
  if (!chat) return null;
  if (!chat.dyn) chat.dyn = {};
  if (!chat.npcs) chat.npcs = {};
  if (!Array.isArray(chat.present)) chat.present = [];
  if (typeof chat._round !== 'number') chat._round = 0;
  return chat;
}

/* ============ 静态锚点库 ============ */

/**
 * 合并后的静态库：全局锁定条目 + 本角色卡条目。
 * 同名时，全局锁定条目优先（人设主权）。
 * @returns {Array<{name, entry, locked}>}
 */
export function listCast() {
  const out = [];
  const seen = new Set();

  const g = root().global.identity || {};
  for (const [name, e] of Object.entries(g)) {
    out.push({ name, entry: e, locked: true, scope: 'global' });
    seen.add(name);
  }

  const node = charNode(false);
  if (node) {
    for (const [name, e] of Object.entries(node.cast || {})) {
      if (seen.has(name)) continue;
      out.push({ name, entry: e, locked: !!e.locked, scope: 'char' });
    }
  }

  /**
   * v0.9.45：主角（persona 真名）置顶。
   * 默认顺序是「全局人设 → 本卡档案」，主角属于本卡档案 → 沉在 38 条里的中间，
   * 每次改他的外貌/服装都要翻找（用户明确要求排到前面）。
   * 只做「把那一条挪到最前」的稳定移位，其余相对顺序一字不动 —— 不引入新排序规则，
   * 免得整列表跟着跳。
   */
  const selfName = String(getUserName() || '').trim();
  if (selfName) {
    const i = out.findIndex(x => x.name === selfName);
    if (i > 0) out.unshift(...out.splice(i, 1));
  }
  return out;
}

export function getEntry(name) {
  const found = listCast().find(x => x.name === name);
  return found || null;
}

export function getCharCast() {
  const node = charNode(false);
  return node ? clone(node.cast || {}) : {};
}

/**
 * 写入/更新静态条目。字段逐字段 merge（未提及的保留）。
 * @param {string} name
 * @param {object} patch { fields?, identity?, label?, nl?, locked?, source? }
 * @param {object} opts  { global?: boolean, round?: number }
 */
export function upsertEntry(name, patch = {}, opts = {}) {
  const target = opts.global
    ? (root().global.identity)
    : (charNode(true)?.cast);
  if (!target) return null;

  /* ★ v0.9.66 静态层入口闸（与 getDyn 同一道）：
   * 宏名归到真名，归不出来就拒绝建档 —— 否则静态层照样会长出 <user> 档，
   * 而它不会出现在档案页（用户改不到），却会被出图读到。 */
  const realName = opts.global ? String(name ?? '').trim() : resolveRealName(name);
  if (!opts.global && !realName) {
    warn(STAGE.CONSISTENCY, `静态层拒绝为非法角色名建档：${JSON.stringify(name)}`);
    return null;
  }
  name = realName;

  const prev = target[name] || emptyEntry(name);
  const next = {
    ...prev,
    name,
    fields: { ...(prev.fields || {}) },
    identity: { ...(prev.identity || {}) },
    /** 外观 spec 是**整体替换**而不是合并：取消勾选的维度要真消失。 */
    spec: patch.spec ? { ...(patch.spec || {}) } : { ...(prev.spec || {}) },
  };

  // 两条写入语义（2026-09-26 修「编辑器清空字段保存不生效」）：
  //   空字符串 —— 「没提到这个字段」，保留旧值（AI 增量维护靠它防漂移，不许动）
  //   null     —— 「显式清空」（只有档案编辑器会发），删掉这个字段
  for (const f of ANCHOR_FIELDS) {
    const v = patch.fields?.[f];
    if (v === null) { delete next.fields[f]; continue; }
    const s = oneLine(v);
    if (s) next.fields[f] = s;
  }
  for (const [k, v] of Object.entries(patch.fields || {})) {
    if (ANCHOR_FIELDS.includes(k)) continue;
    if (v === null) { delete next.fields[k]; continue; } // 允许自由扩展字段（如 outfit 直写）
    const s = oneLine(v);
    if (s) next.fields[k] = s;
  }
  for (const [k, v] of Object.entries(patch.identity || {})) {
    const s = oneLine(v);
    if (s) next.identity[k] = s;
  }
  // 头像：一张裁剪好的小图（dataURL）。
  // 不走 oneLine —— 那是给英文短 tag 用的，会把 base64 里的空白也卷进去。
  if (patch.avatar !== undefined) {
    const a = String(patch.avatar || '').trim();
    if (a) next.avatar = a;
    else delete next.avatar;   // 空串/null = 移除头像
  }
  if (patch.label !== undefined) next.label = oneLine(patch.label);
  if (patch.nl !== undefined) next.nl = String(patch.nl || '').trim();
  if (patch.locked !== undefined) next.locked = !!patch.locked;
  if (patch.source) next.source = patch.source;
  if (opts.global) next.locked = true;

  const round = Number(opts.round) || 0;
  if (!next.createdAt) next.createdAt = round;
  next.updatedAt = round;

  target[name] = next;
  saveSettings();
  return next;
}

/* ============ 角色头像 ============ */

/**
 * 角色形象图。存的是**裁剪后缩到 288px 的小图 dataURL**（约 20~40KB），
 * 不存原图地址 —— 原图可能来自 ComfyUI 临时目录，重启就没了；
 * 头像要跟着档案走（导出/导入都带着），只能是内联数据。
 *
 * @returns {string} dataURL；没设置返回 ''
 */
export function getAvatar(name) {
  const found = getEntry(name);
  return String(found?.entry?.avatar || '');
}

/**
 * 设置头像。立刻落盘，不参与字段 merge 语义。
 * @param {string} name
 * @param {string} dataUrl 空串 = 不改动（避免误清）
 * @returns {boolean}
 */
export function setAvatar(name, dataUrl, opts = {}) {
  const url = String(dataUrl || '').trim();
  if (!url) return false;
  if (!url.startsWith('data:image/')) {
    warn(STAGE.UI, `头像不是图片 dataURL（已忽略）：${url.slice(0, 24)}…`);
    return false;
  }
  const e = upsertEntry(name, { avatar: url }, opts);
  return !!e;
}

/** 清除头像（档案卡片回到首字母占位）。 */
export function clearAvatar(name, opts = {}) {
  const e = upsertEntry(name, { avatar: '' }, opts);
  return !!e;
}

export function removeEntry(name, opts = {}) {
  const target = opts.global ? root().global.identity : charNode(false)?.cast;
  if (!target || !target[name]) return false;
  delete target[name];
  saveSettings();
  return true;
}

/**
 * v0.9.50：AI 判定同人后的档案归并。
 *
 * 背景（用户实测病例）：同一人被建成「隔壁太太」「结城美惠」「结城太太」三条档案，
 * 服装和外貌各存一份、互相打架 —— 用户改哪条，出图按另外两条注入，怎么改都"没效果"。
 *
 * 判断由**模型**做（它读得懂「结城太太（结城美惠）」这类正文证据），插件只负责执行：
 * 把 from 的静态字段 / 会话动态状态并入 to（**to 已有值一律不动**，from 只补空缺 ——
 * 人设主权在 to），然后删掉 from。合并前的 from 数据整体进诊断日志，合错了可找回。
 *
 * @returns {{ok:boolean, reason?:string, movedFields?:string[], outfitFrom?:boolean, historyMoved?:number}}
 */
export function mergeCastEntries(from, to) {
  const fromName = oneLine(from);
  const toName = oneLine(to);
  if (!fromName || !toName) return { ok: false, reason: 'merge 参数为空' };
  if (fromName === toName) return { ok: false, reason: '合并双方同名' };

  const node = charNode(false);
  if (!node) return { ok: false, reason: '当前没有角色卡' };
  const fromEntry = node.cast[fromName];
  const toEntry = node.cast[toName];
  if (!fromEntry) return { ok: false, reason: `「${fromName}」不在档案库里` };
  if (!toEntry) return { ok: false, reason: `「${toName}」不在档案库里（合并目标必须是已有档案）` };

  /* ---- 静态层：to 优先，from 补空缺 ---- */
  const movedFields = [];
  const fieldPatch = {};
  for (const [k, v] of Object.entries(fromEntry.fields || {})) {
    if (!v) continue;
    if (toEntry.fields?.[k]) continue;      // to 已有 → 人设主权，不动
    fieldPatch[k] = v;
    movedFields.push(k);
  }
  if (Object.keys(fieldPatch).length) {
    upsertEntry(toName, { fields: fieldPatch, source: 'scan' }, {});
  }
  if (!toEntry.avatar && fromEntry.avatar) {
    upsertEntry(toName, { avatar: fromEntry.avatar }, {});
  }
  if (!toEntry.label && fromEntry.label) {
    upsertEntry(toName, { label: fromEntry.label }, {});
  }

  /* ---- 动态层：本卡全部会话的 dyn[from] 并入 dyn[to] ---- */
  let historyMoved = 0;
  let outfitFrom = false;
  for (const chat of Object.values(node.chats || {})) {
    if (!chat || !chat.dyn) continue;
    const dFrom = chat.dyn[fromName];
    if (!dFrom) continue;
    if (!chat.dyn[toName]) chat.dyn[toName] = emptyDyn();
    const dTo = chat.dyn[toName];

    // condition / mood：to 有值不动
    for (const [k, v] of Object.entries(dFrom.fields || {})) {
      if (v && !dTo.fields?.[k]) dTo.fields[k] = v;
    }

    // outfit：款式/预设/裸露 to 空才取 from；状态位取更靠后的一档；历史拼接
    const oF = dFrom.outfit || {};
    const oT = dTo.outfit || (dTo.outfit = { style: '', preset: '', state: 'intact', lockLevel: '', changedAt: 0, history: [] });
    if (!oT.style && oF.style) { oT.style = oF.style; outfitFrom = true; }
    if (!oT.preset && oF.preset) oT.preset = oF.preset;
    if (!oT.bare && oF.bare) oT.bare = oF.bare;
    const order = { intact: 0, parted: 1, undone: 2, removed: 3, swapped: 3 };
    if ((order[oF.state] ?? 0) > (order[oT.state] ?? 0)) oT.state = oF.state;
    if ((Number(oF.changedAt) || 0) > (Number(oT.changedAt) || 0)) oT.changedAt = oF.changedAt;
    if (Array.isArray(oF.history) && oF.history.length) {
      oT.history = [...oF.history, ...(Array.isArray(oT.history) ? oT.history : [])];
      historyMoved += oF.history.length;
    }

    delete chat.dyn[fromName];
  }

  /* ---- 删除 from（静态层）—— 删之前整体留档到诊断日志，合错了找得回来 ---- */
  try {
    info(STAGE.STORE, `同人归并：删除「${fromName}」（已并入「${toName}」）—— 原档案留档如下，`
      + `若合错了请照此内容手动重建：${JSON.stringify({ fields: fromEntry.fields, label: fromEntry.label })}`);
  } catch { /* 留档失败不阻断合并 */ }
  removeEntry(fromName);
  saveSettings();
  return { ok: true, movedFields, outfitFrom, historyMoved };
}

/**
 * 清空本角色卡的静态库（不动全局锁定条目）。
 *
 * ⚠️ v0.9.49：必须连**会话动态状态**（chats[chatId].dyn）一起清。
 *   用户实测病例（2026-09-30）：服装漂移后清空档案库重建，结果服装还是错的 ——
 *   因为 dyn（每会话每角色的 outfit/state/bare/condition/mood）不在清空范围内，
 *   新档案建出来，套的还是旧会话的服装状态（甚至是被旧 bug 吃剩的残渣）。
 *   「重新建档从头来」的语义应当包含：扫描出来的动态状态一并作废。
 */
export function clearCharCast() {
  const node = charNode(false);
  if (!node) return false;
  node.cast = {};
  for (const chat of Object.values(node.chats || {})) {
    if (chat && typeof chat === 'object') chat.dyn = {};
  }
  saveSettings();
  return true;
}

/**
 * 一键清空全部档案（本卡 + 全局锁定条目都删）—— 用户重新导入前的大扫除用。
 * @param {{includeGlobal?:boolean}} opts includeGlobal=false 时保留全局条目
 * @returns {{ok:boolean, removed:number, globalRemoved:number}}
 */
export function clearAllCast(opts = {}) {
  const includeGlobal = opts.includeGlobal !== false;
  const node = charNode(false);
  const removed = node?.cast ? Object.keys(node.cast).length : 0;
  let globalRemoved = 0;
  if (node) {
    node.cast = {};
    // v0.9.49：同 clearCharCast —— 会话动态状态一并作废（见上函数注释）。
    for (const chat of Object.values(node.chats || {})) {
      if (chat && typeof chat === 'object') chat.dyn = {};
    }
  }
  if (includeGlobal) {
    const g = root()?.global?.identity;
    if (g) {
      globalRemoved = Object.keys(g).length;
      root().global.identity = {};
    }
  }
  saveSettings();
  return { ok: !!node || globalRemoved > 0, removed, globalRemoved };
}

/* ============ 动态状态 ============ */

/**
 * ★ v0.9.66 建档入口闸 —— <user> 分裂条目根治的第一层（以前这里从不校验名字）。
 *
 * 把模型/正文给的任意称呼解析成**可落盘的真名**：
 *   - <user> / <persona> / {{user}}  → 主角真名（ctx.name1，来自「用户设定管理」）
 *   - <bot> / <char> / <assistant>   → 当前角色卡名（ctx.name2）
 *   - 普通名字                        → 原样
 *   - 解析不出真名的非法名            → 拒绝建档（返回空串，调用方拿不到节点 = 不会落盘）
 *
 * 两条通道分开是关键：主角是 persona（用户设定），角色卡是世界书/卡里的角色，
 * 混在一起就会互相覆盖 —— 这是「保存了个寂寞」的根因之一。
 *
 * @param {string} raw 任意称呼
 * @returns {string} 真名；空串 = 不许建档
 */
export function resolveRealName(raw) {
  const t = String(raw ?? '').trim();
  if (!t) return '';

  // 含宏但归类不出通道（如 <unknown>）→ 宁可不建，也不建一条废条目
  if (isMacroName(t)) {
    const ch = macroChannel(t);
    if (ch === 'self') {
      let n = '';
      try { n = String(getUserName() || '').trim(); } catch { n = ''; }
      return n;
    }
    if (ch === 'char') {
      let n = '';
      try { n = String(getCharName() || '').trim(); } catch { n = ''; }
      return n;
    }
    /* 认不出的宏一律拒绝，不剥壳兜底。
     * 曾经写过「剥壳后像名字就采用」，结果 <unknown> 被建成一条叫 unknown 的废档 ——
     * 尖括号形式本身就是宏的写法，不是角色名的写法。宁可不建，也不建废条目。 */
    return '';
  }

  // 非宏名：只要还残留尖括号/花括号就拒绝（防 {{名字}} 这类半截宏）
  if (/[<>{}]/.test(t)) return '';
  return t;
}

export function getDyn(name) {
  const chat = chatNode(true);
  if (!chat) return null;
  const real = resolveRealName(name);
  if (!real) {
    warn(STAGE.CONSISTENCY, `拒绝为非法角色名建档：${JSON.stringify(name)}`);
    return null;                       // ★ 入口闸：不落盘
  }
  if (!chat.dyn[real]) chat.dyn[real] = emptyDyn();
  const d = chat.dyn[real];
  if (!d.outfit) d.outfit = { style: '', preset: '', state: 'intact', lockLevel: '', changedAt: 0, history: [] };
  if (typeof d.outfit.preset !== 'string') d.outfit.preset = '';
  if (typeof d.outfit.lockLevel !== 'string') d.outfit.lockLevel = '';
  if (!d.fields) d.fields = {};
  if (!Array.isArray(d.outfit.history)) d.outfit.history = [];
  return d;
}

/**
 * 角色当前**实际生效**的服装描述。
 * 预设优先：outfit.preset 有值且预设库里存在同名项时，用预设内容 —— 这是
 * 「一套制服改一次、全体角色同步」的基础。
 */
export function resolveOutfitStyle(dyn) {
  const o = dyn?.outfit || {};
  const presets = getConfig().outfitPresets || {};
  // 两种引用方式都支持：outfit.preset 字段，或直接把 style 写成 @预设名
  let key = String(o.preset || '').trim();
  if (!key && String(o.style || '').trim().startsWith('@')) key = String(o.style).trim();
  key = key.replace(/^@/, '').trim();
  if (key && presets[key]) return String(presets[key]);
  return String(o.style || '');
}

/** 该角色当前生效的款式保护级别（条目级 → 全局默认）。 */
export function outfitLockLevelOf(dyn) {
  const o = dyn?.outfit || {};
  const own = String(o.lockLevel || '');
  if (own) return own;
  return String(getConfig().consistency?.outfitLock || 'normal');
}

/**
 * 逐字段 merge 动态状态 —— 这是防漂移的核心。
 * patch 里没提到的字段一律保留原值；空字符串视为"不修改"（不是"清空"）。
 */
export function mergeDyn(name, patch = {}, round = 0) {
  const d = getDyn(name);
  if (!d) return null;

  for (const f of DYN_FIELDS) {
    const v = oneLine(patch.fields?.[f]);
    if (v) d.fields[f] = v;
  }
  for (const [k, v] of Object.entries(patch.fields || {})) {
    if (DYN_FIELDS.includes(k)) continue;
    const s = oneLine(v);
    if (s) d.fields[k] = s;
  }
  /**
   * 外貌状态层（v0.9.70）。
   * ★ 这里不做档名校验 —— mergeDyn 只管落库，校验在调用方 `resolveAppearState()`：
   *   命不中库档名的值（模型自造词）根本到不了这儿。
   */
  if (patch.appear && typeof patch.appear === 'object') {
    if (!d.appear || typeof d.appear !== 'object') d.appear = {};
    for (const [k, v] of Object.entries(patch.appear)) {
      if (v === null || v === '') delete d.appear[k];
      else d.appear[k] = v;
    }
  }
  if (round) {
    if (!d.firstSeenRound) d.firstSeenRound = round;
    d.lastSeenRound = Math.max(d.lastSeenRound || 0, round);
  }
  saveSettings();
  return d;
}

/* ============ 外貌层（v0.9.70 · 批次 4） ============ */

/**
 * 外观状态层的值校验 —— **允许更新，不允许漂移**。
 *
 * ★ 这里就是 R7（模型乱填档名）的闸：报上来的值必须命中外观库里的档名，
 *   命中则存**规范档名**（库里的中文 key），命不中一律丢弃。
 *   否则模型很快会发明出「微湿的长发凌乱地贴在她的脸颊上」这种既不在库、
 *   又每次写法都不一样的东西 —— 那正是 D1/D2 要治的漂移。
 *
 * 语义：
 *   键不存在  → 这楼没提这个维度，**什么都不做**（不许用默认值覆盖）
 *   空值      → 显式清空
 */
export function resolveAppearState(raw = {}) {
  const appear = {};
  const dropped = [];
  const src = raw || {};
  for (const k of APPEAR_STATE_FIELDS) {
    if (!(k in src)) continue;
    const v = String(src[k] ?? '').trim();
    if (!v) { appear[k] = null; continue; }
    const hit = k === 'hairState' ? hairStateOf(v) : (k === 'makeupSmudge' ? smudgeOf(v) : null);
    if (hit) appear[k] = hit.k;
    else dropped.push(`${k}=${v.slice(0, 24)}`);
  }
  return { appear, dropped };
}

/**
 * 保存发型 / 妆容（建档时合成一次 + 状态层 + K2 自然语档案同步）。
 *
 * ★★ 合成必须在这里做，不能放到出图时做：
 *    UI 上是 7 个下拉，但**保存时就合成成一条**写回 `fields.hair`。
 *    真把 6 维摊开进画面 = 多 6 条约束 = 直接喂给崩坏（2026-10-02 验证过的机理）。
 *    合成完之后出图时仍然只有一条，画面约束数一个都没多。
 *
 * ★ 某个维度一个都没选 → **不写该字段**（保留用户手填的原文）。
 *   理由：旧档案建于这套 UI 之前，用户「打开看一眼再保存」不该把手写的
 *   `long black hair, straight` 冲掉。要清空请直接清空上面的「发型发色」输入框。
 *
 * @param {string} name 角色名（可以带宏，会过 resolveRealName 闸）
 * @param {{hair?:object, makeup?:object, appear?:object}} input
 */
export function saveAppearance(name, input = {}, round = 0, opts = {}) {
  /**
   * opts.fields（默认 true）—— 是否把合成写回 fields.hair / fields.makeup。
   *   UI 传 false：它在下拉 change 时已把合成值同步进了「发型发色」输入框，
   *   用户可能又手改过那一栏 —— 这里再覆写一次就会把人手改的内容吃掉。
   * opts.nl（默认 true）—— 是否同步 K2 自然语档案。同上理由，UI 传 false。
   * 两种情况都照常落 `spec`（下拉回填用）与 `dyn.appear`（状态层）。
   */
  const writeFields = opts.fields !== false;
  const writeNl = opts.nl !== false;
  const real = resolveRealName(name);
  if (!real) return { ok: false, reason: '拿不到真名（主角要用户设定名、角色要卡名），无法保存外貌' };

  /**
   * ⚠️ `getEntry` 返回的是 `{name, entry, locked, scope}` 外壳，**不是** entry 本身。
   *    少了这一层 `.entry` 的话，`prev.fields` / `prev.spec` 全是 undefined ——
   *    表现就是 nlProfile 幂等摘除永远失效、每次保存都往上叠一段。
   */
  const prev = getEntry(real)?.entry || null;
  const hRes = resolveHairConflicts(input.hair || {});
  const mRes = resolveMakeupConflicts(input.makeup || {});
  const hSpec = hRes.spec;
  const mSpec = mRes.spec;
  const hair = composeHair(hSpec);
  const makeup = composeMakeup(mSpec);

  const patch = { fields: {}, spec: { hair: hSpec, makeup: mSpec } };
  if (writeFields) {
    if (hair.en) patch.fields.hair = hair.en;
    if (makeup.en) patch.fields.makeup = makeup.en;
  }

  /**
   * K2 模板下人物段优先读 `nlProfile`（自然语外貌档案），逐字段 tag 那条路不参与 ——
   * 不同步这里的话，选了 6 维在 K2 下**根本看不到**。
   *
   * ★ 幂等做法：上次写进去的那段记在 `spec.nlAppear`，先整段摘掉再写新的。
   *   不去猜用户的句子边界（「xx；xx；」里哪句是发型）—— 猜必错，还会删掉别的内容。
   */
  const addH = hairToZh(hSpec);
  const addM = makeupToZh(mSpec);
  const add = addH + addM;
  const oldFrag = String(prev?.spec?.nlAppear || '');
  const prevNl = String(prev?.fields?.nlProfile || '');
  patch.spec.nlAppear = add;
  if (add && writeNl) {
    let nl = prevNl;
    if (nl && oldFrag && nl.includes(oldFrag)) nl = nl.replace(oldFrag, '');
    // SD 口径下 nlProfile 会被中文清洗掉，原本没有就别凭空造一个出来给人添乱
    if (!nl && activeEngine() !== 'k2') nl = prevNl;
    const merged = String(add + nl || '').replace(/；{2,}/g, '；').replace(/，{2,}/g, '，').trim();
    if (merged) patch.fields.nlProfile = merged;
  }

  upsertEntry(real, patch, { round });

  const { appear, dropped } = resolveAppearState(input.appear || {});
  if (Object.keys(appear).length) mergeDyn(real, { appear }, round);

  return {
    ok: true,
    hair: hair.en,
    makeup: makeup.en,
    appear,
    dropped,
    cleared: [...hRes.cleared, ...mRes.cleared],
  };
}

/* ============ 服装层 ============ */

/**
 * 更新服装。
 *
 * 三层保护（治「一件校服换了好几个版本」这个病）：
 *   ① 状态位只能前进（intact → parted → undone → removed）
 *   ② 状态位推进时，**原款式一个字都不能改** —— 半褪的仍是那件
 *   ③ 款式文本的改写要过「元素覆盖率」检查：
 *        strict  一律拒绝（连 swapped 也拒），款式完全冻结
 *        normal  覆盖率 ≥ 阈值才算「补充描述」；否则视为「偷换款式」拒绝
 *        off     放行
 *
 * 用户手动操作（opts.force）跳过 ③ —— 面板上的「换装」按钮走这条路。
 *
 * @param {string} name
 * @param {string} style
 * @param {string} state
 * @param {number} round
 * @param {{preset?:string, lockLevel?:string, force?:boolean, threshold?:number}} [opts]
 * @returns {{ok:boolean, reason?:string, drift?:object, dyn:object}}
 */
/**
 * v0.9.72 · 「让扫描 / 出词模型自动填服装三维度」总开关（默认关）。
 *
 * ★ 默认 false 是有意的：这是给模型的**写权限** —— 开了之后它每楼都能改写
 *   状态细档 / 改造 / 鞋袜，而这三项的英文是**直接进画面**的。
 *   关着时模型即使回了这三个字段也会被静默忽略，三维度只能档案页手动设
 *   （= v0.9.69/0.9.70 就已存在的既有行为）。
 *
 * ★ 严格 `=== true`：任何 undefined / null / 字符串 'false' 一律算关，
 *   避免老存档里残留脏值把它意外打开。
 */
export function autoOutfitDimsOn() {
  return getConfig()?.consistency?.autoOutfitDims === true;
}

/**
 * 三维度的**取值 + 合法性校验 + 细档对应的旧档**（v0.9.72 从 updateOutfit 抽出）。
 *
 * 抽出来的原因：扫描被防漂移闸门拒绝时（款式没改成）也要能落三维度 ——
 * 「她把裙子撩起来」跟"她到底穿哪条裙子"是两回事，不能连坐丢掉
 * （与 v0.9.46 的 setOutfitBare 同一条道理）。那时走的是 setOutfitDims，
 * 需要跟这里**完全同一套**校验，否则两处口径迟早分家 —— 单一事实源。
 *
 * @param {object} o   outfit 节点
 * @param {object} opts 含 stateDetail / mod / shoes（undefined = 本次没提，沿用）
 * @param {boolean} force 手动路径（面板保存），可越过 locked
 * @returns {{detail:string, mod:string, shoes:string, liftState:string}}
 */
function pickOutfitDims(o, opts = {}, force = false) {
  const dimLocked = o.stateMode === 'locked' && !force;
  let detail = dimLocked ? String(o.stateDetail || '') : oneLine(opts.stateDetail ?? o.stateDetail);
  let mod = dimLocked ? String(o.mod || '') : oneLine(opts.mod ?? o.mod);
  let shoes = dimLocked ? String(o.shoes || '') : oneLine(opts.shoes ?? o.shoes);
  if (detail && !OUTFIT_STATE_DETAIL_KEYS.includes(detail)) detail = '';
  if (mod && !OUTFIT_MOD_KEYS.includes(mod)) mod = '';
  if (shoes && !OUTFIT_SHOES_KEYS.includes(shoes)) shoes = '';
  /** 细档 → 它对应的旧 5 档（是否真的前进，由调用方按单调闸门决定） */
  const liftState = detail ? String(stateDetailOf(detail)?.state || '') : '';
  return { detail, mod, shoes, liftState };
}

/**
 * 只写三维度，不动款式 / 状态位 / 裸露（v0.9.72）。
 *
 * 用途：applyOutfitScan 里款式改写被防漂移闸门拒绝时，模型报的
 * 「裙子被撩起 / 换了一双高跟鞋」仍然要生效 —— 它跟"她穿哪条裙子"是两码事。
 *
 * ★ 状态位是否跟着细档前进：这里**不推进**（只记档名）。
 *   细档提升旧档那条路在 updateOutfit 里，那边有完整的单调闸门；
 *   这里绕过去就等于给"状态位倒退"开了后门。
 *
 * @param {string} name
 * @param {{stateDetail?:string, mod?:string, shoes?:string}} dims 只写非空的；undefined = 不动
 * @param {number} round
 * @returns {{ok:boolean, reason?:string, written:string[], dyn?:object}}
 */
export function setOutfitDims(name, dims = {}, round = 0) {
  const d = getDyn(name);
  if (!d) return { ok: false, reason: '无档案节点', written: [] };
  const o = d.outfit;
  const picked = pickOutfitDims(o, dims, false);
  const written = [];
  if (dims.stateDetail !== undefined && dims.stateDetail !== null && picked.detail !== String(o.stateDetail || '')) {
    if (picked.detail) o.stateDetail = picked.detail; else delete o.stateDetail;
    written.push('stateDetail');
  }
  if (dims.mod !== undefined && dims.mod !== null && picked.mod !== String(o.mod || '')) {
    if (picked.mod) o.mod = picked.mod; else delete o.mod;
    written.push('mod');
  }
  if (dims.shoes !== undefined && dims.shoes !== null && picked.shoes !== String(o.shoes || '')) {
    if (picked.shoes) o.shoes = picked.shoes; else delete o.shoes;
    written.push('shoes');
  }
  if (!written.length) return { ok: true, written, dyn: d, unchanged: true };
  o.changedAt = round || o.changedAt;
  saveSettings();
  return { ok: true, written, dyn: d };
}

export function updateOutfit(name, style, state, round = 0, opts = {}) {
  const d = getDyn(name);
  if (!d) return { ok: false, reason: '无档案节点' };

  const o = d.outfit;

  /**
   * 区分「本次显式指定的状态位」与「沿用旧值」—— 语义完全不同：
   *   显式指定 swapped = 这次真的换了一套衣服 → 允许改写款式
   *   沿用旧值（上一轮遗留的 swapped）→ 不构成改写款式的理由，闸门照常生效
   * 混在一起会让一次换装永久豁免后续所有检查。
   */
  const explicitState = OUTFIT_STATES.includes(String(state || '').toLowerCase())
    ? String(state).toLowerCase()
    : '';
  let nextState = explicitState || o.state || 'intact';
  let nextStyle = oneLine(style);

  /**
   * v0.9.69 · 服装三维度（状态细档 / 改造 / 鞋袜）—— 取值与合法性。
   *
   * ★ 与旧 5 档的关系：outfit.state 仍是**机器语义**（三档清洗、bare 锚点、单调前进、
   *   丢件豁免、覆盖率豁免全部挂在它上面），stateDetail 只是它的**细化注入**。
   *   所以设了细档必须把 state 提升到该档对应的那一档（且只前进）——
   *   否则会出现「细档=全裸、state=intact」的自相矛盾：
   *   清洗按 intact 走（衣服全部保留），注入按全裸走（替换 style），两边打架。
   *
   * ★ E2（stateMode='locked'）锁定时三维度同样不跟随剧情；手动保存（force）永远优先。
   *
   * ★ 非法档名一律静默丢弃：模型乱填时不进画面，不报错、不影响主流程。
   */
  const dims = pickOutfitDims(o, opts, opts.force === true);
  const { detail: nextDetail, mod: nextMod, shoes: nextShoes, liftState } = dims;
  /** 细档 → 旧档提升（只前进；回退仍由 ② 的单调闸门管，细档不能偷偷绕过它） */
  if (liftState && OUTFIT_STATES.indexOf(liftState) > OUTFIT_STATES.indexOf(nextState)) {
    nextState = liftState;
  }
  /**
   * 换装放行有两条路，语义都是「这次真的换了衣服」：
   *   ① 调用方显式报了 state=swapped（模型 / 面板）
   *   ② opts.swapped —— 剧情正文里命中了换装动词（v0.9.39 服装扫描）
   * 第 ② 条是用户拍板的口径：「认换装动词才放行」。
   */
  const isSwap = explicitState === 'swapped' || opts.swapped === true;

  /**
   * v0.9.47「解锁款式」：面板按钮设的一次性标记，用后即清。
   * 用途：剧情确实换了衣服、但扫描没跟上（没写换装动词 / 不在场景切换里）时，
   * 用户点一下放行下一次改写 —— 不用去改保护级别、也不用手动敲款式。
   */
  const unlocked = o.styleUnlocked === true;

  /**
   * v0.9.67 · E1/E2「跟随剧情 ⇄ 固定」总开关（用户勾选）。
   *
   * ★ 与既有「款式保护四档」的区别（别混为一谈）：
   *   四档（lockLevel: '' / strict / normal / off）是**防漂移强度**，
   *   管的是"模型每楼重新描述一遍"这种噪声，且**只管款式不管状态位**；
   *   本开关是**明确二选一**，fixed = 剧情再怎么写都不许改，且状态位也独立可控。
   *   用户原话：「我想要的就是角色服装有个选择，一个是跟随剧情正文换，一个是固定死的我填的」。
   *
   * 语义：
   *   followMode='fixed'  款式固定 —— 本楼起沿用用户最后一次保存的这套，剧情不再改写
   *   stateMode ='locked' 状态位锁定 —— 脱/穿回/破损都不再跟随剧情
   *
   * ★ 手动保存永远优先（opts.force）：用户在档案页改服装本身就是"我要换成这套"，
   *   被 fixed 挡住会变成"保存了个寂寞"（2026-10-03 实测病例）。
   */
  const styleFixed = o.followMode === 'fixed';
  const stateLocked = o.stateMode === 'locked';
  if (styleFixed && !opts.force) {
    const cur = resolveOutfitStyle(d);
    if (cur) nextStyle = cur;
  }
  if (stateLocked && !opts.force) {
    nextState = o.state || 'intact';
    // 裸露部位由状态位驱动，锁着的时候一起按住，否则"锁了状态却越脱越光"
    opts = { ...opts, bare: undefined };
  }

  /* ① 面板手动指定的预设 / 保护级别 */
  if (typeof opts.preset === 'string') o.preset = oneLine(opts.preset).replace(/^@/, '');
  /**
   * ⚠️ v0.9.48：空串必须当成"显式选了跟随全局"，不能当"没传"。
   * 旧写法 `&& opts.lockLevel` 会让下拉框选回「跟随全局」时**写不进去**，
   * 保护级别悄悄停在旧的 strict/normal —— 用户以为关掉了，其实还锁着。
   */
  if (typeof opts.lockLevel === 'string') {
    o.lockLevel = OUTFIT_LOCK_LEVELS.includes(opts.lockLevel) ? opts.lockLevel : '';
  }
  /** E1/E2（v0.9.67）：空串同样要当成"显式选了跟随"（同 lockLevel 那条踩过的坑）。 */
  if (typeof opts.followMode === 'string') {
    o.followMode = OUTFIT_FOLLOW_MODES.includes(opts.followMode) ? opts.followMode : 'auto';
  }
  if (typeof opts.stateMode === 'string') {
    o.stateMode = OUTFIT_STATE_MODES.includes(opts.stateMode) ? opts.stateMode : 'auto';
  }

  /**
   * ①b v0.9.48 预设落地 —— 剧情一推进，预设就"兑现"成当前款式。
   *
   * ★ 为什么必须有（用户 2026-09-29 提问：「用预设服装的还能在服装段里自动拆分？还是锁死了？」）：
   *   答案是**锁死**，而且是三重锁：
   *     ① resolveOutfitStyle 用预设内容**整体覆盖** style，注入时永远整串出场
   *        （"身穿 全套校服"），剧情里褪下一件也体现不出来；
   *     ② 防漂移闸门拿这串完整预设当基线 —— 任何"少写一件"的新款覆盖率都不足
   *        → 一律被拒 → 预设**永久**锁死，连剧情改写的机会都没有；
   *     ③ 状态词拆分（splitOutfitStyle）只作用在 style 上，预设内容不参与。
   *   预设的本意是"他的常服基准"，不该变成"焊在身上的一层壳"。
   *
   * 所以：只要本楼出现了**真实的穿着推进**（状态位前进 / 裸露变化 / 报了不同款式），
   * 就把预设内容固化进 o.style 并解除引用 —— 之后它与普通款式同权，能继续演化。
   * 没有推进时保持引用（一套制服改一次、全体同步的便利性不丢）。
   */
  let presetBare = null; // 预设内容里混着的状态词（拆出来归 bare）
  if (o.preset) {
    // 同 linearOrder：换装（swapped）之后的状态推进也要能被识别出来
    const ordPrev = linearOrder(o.state);
    const ordNext = linearOrder(nextState);
    const base = resolveOutfitStyle(d);
    /**
     * ★ v0.9.71 手动路径（opts.force）的判定口径必须收窄。
     *
     * 旧逻辑里 `typeof opts.bare === 'string'` 这一支是给剧情路径用的（模型报了 bare = 穿着确实有推进）。
     * 但档案页保存时 **bare 恒为字符串**（哪怕是空串也要传，否则用户清不掉裸露框），
     * 于是每一次手动保存都命中这一支 → 引用被静默清掉。
     * 用户在档案页改个标签、调个名字，回来发现"刚才选的校服引用没了"。
     *
     * → 手动路径只认一种信号：**款式框内容被改动了**（nextStyle !== base）。
     *   面板会把款式框回填成预设原文（看过能用再改），所以没动过就是恒等，引用保住；
     *   动过就是用户明确要改脱离，兑现成自由文本 —— 语义干净。
     */
    const evolving = opts.force === true
      ? (!!nextStyle && nextStyle !== base)
      : (ordNext > ordPrev
        || typeof opts.bare === 'string'
        || (!!nextStyle && nextStyle !== base));
    if (evolving && base) {
      const sp = splitOutfitStyle(base);
      o.style = sp.style;
      if (sp.moved && sp.bare) presetBare = sp.bare;
      o.preset = '';
    }
  }

  /* ② 状态位只能前进 —— 但 swapped 双向豁免，「重新穿好」也放行 */
  /**
   * swapped 表示「换了一套新衣服」，它不是线性推进里的一环：
   * 可以从任何档切进来，也应该能切回任何档（新衣服当然是完好的）。
   * 少了这个双向豁免，角色一旦换过衣服就永远回不到 intact —— 实测踩过这个坑。
   *
   * v0.9.45 加第三条：opts.redress（正文命中「把裤子提起来 / 重新穿好 / 拉上拉链」这类
   * 重新着衣动词）。旧版一律拒绝回退，后果是 —— NSFW 情节里角色脱了又被剧情穿回去，
   * 状态位却永久停在 removed，与剧情脱节；而画面侧因为没有任何「没穿衣服」的锚定，
   * 模型凭印象又把衣服画上（用户原话：「上一段已经脱下了，后面又突然穿上了」）。
   * 回退时若没显式给 bare，自动清空裸露锚点 —— 穿上衣服了还写「下身赤裸」是自相矛盾。
   */
  const prevOrder = STATE_ORDER[o.state] ?? 0;
  const nextOrder = STATE_ORDER[nextState] ?? 0;
  /**
   * 两个概念必须分开（v0.9.47）：
   *   isRedress    = 正文明确写了「把裤子提起来 / 重新穿好」→ 放行回退 **且清空 bare**
   *   canRollback  = 场景切换（第二天 / 醒来 / 回到家）→ **只放行回退，不清 bare**
   *
   * 为什么场景切换不能顺便清空 bare：用户明确否决过 ——
   * 「新场景默认穿好不是绝对的，还是要看前后剧情」。第二天醒来可能还光着身子
   * （上一场戏的延续）。所以新场景的状态只能由模型读剧情定：
   * 模型报了 intact 就 intact，模型没提就沿用，**插件不替它做决定**。
   */
  const isRedress = opts.redress === true;
  const canRollback = isRedress || opts.sceneBreak === true;
  /**
   * v0.9.60：opts.force（面板手动保存）也放行回退。
   * cast.js 的保存注释从 v0.9.45 起就写着「force 已经跳过闸门了」—— 但这里一直没看
   * force，导致用户在档案页把状态位从 removed 调回 intact 时被当场拒绝（「改了不生效」）。
   * 手动操作是直接设定，主权在你；AI/扫描路径不传 force，防漂移闸门对它们照常生效。
   */
  if (o.state !== 'swapped' && nextState !== 'swapped' && nextOrder < prevOrder && !canRollback && !opts.force) {
    return {
      ok: false,
      reason: `服装状态位回退（${o.state} → ${nextState}）未被接受，需要在剧情中说明「重新穿好」`,
      dyn: d,
    };
  }

  /* ③ 款式保护检查 ★ 这是防漂移的核心闸门 */
  let refined = false; // 判定为「同一套衣服的补充描述」，允许落库
  const styleChanged = !!nextStyle && nextStyle !== o.style;

  /**
   * ③a v0.9.48 部件守恒检查 —— 覆盖率闸门挡不住的那一类漂移。
   *
   * 实测病例（2026-09-29，结城太太）：
   *   r7 `light blue knit sweater with a wide neckline, no bra, grey cotton long skirt`
   *   r9 `black lace bra strap, grey cotton long skirt, pink cotton slippers, barefoot`
   * 针织衫没了，剧情里一个"脱"字都没有。覆盖率算法只数"旧款元素保留了几个"，
   * 旧款 13 个词元保留了 5 个（bra/grey/cotton/long/skirt）→ 0.385 > 阈值 0.34
   * → 被当成「同一套衣服写得更细」合法采纳 → 针织衫从此消失。
   *
   * 覆盖率能挡"重新描述一遍"，挡不住"少写一件"——少写一件恰恰是覆盖率最擅长放过的
   * 形态（留下来的都是交集）。所以这里按"衣服件"的类别单独再判一次。
   */
  const prevBase = resolveOutfitStyle(d);
  const missPieces = (styleChanged && o.style && !opts.force && !isSwap && !unlocked)
    ? missingGarmentPieces(prevBase, nextStyle)
    : { keys: [], items: [], labels: [] };

  /**
   * v0.9.47 连续新款放行：同一套**具体的**衣服被剧情反复提到 N 楼 → 认定为剧情改了设定。
   *
   * 防漂移挡的是"模型每楼重新描述一遍"（一件校服出八个版本），
   * 但剧情**直接改写**服装、又没写换装动词时（实测夜斗的灰色运动裤就是这么来的），
   * 这道闸门会把旧款永久锁死 —— 用户原话：「这是角色扮演小说，不是分镜图，不要锁死」。
   * 折中：同一串新款连续出现 N 楼才放行。N=1 等于不设防，所以下限钳到 1 以上。
   *
   * ⚠️ 计数存在档案里（o.pending），被拒一次记一笔；命中后清零。
   */
  let repeatRelease = false;
  if (styleChanged && o.style && !opts.force && !isSwap && !unlocked) {
    const need = Math.max(1, Number(getConfig().consistency?.outfitStyleRepeatFloors ?? 2));
    const prev = (o.pending && o.pending.style === nextStyle) ? o.pending : null;
    const count = Number(prev?.count || 0) + 1;
    if (count >= need) {
      repeatRelease = true;
      o.pending = null;
    } else {
      o.pending = { style: nextStyle, count, round };
    }
  }

  /**
   * ③c 丢件拦截（v0.9.48）：旧款身上有的衣服，新款没了 —— 而这次并没有在脱衣服。
   *
   * 放行的例外（这些情形下"少一件"是剧情事实，不是提取漏项）：
   *   - 状态位前进（intact → parted / undone / removed）= 剧情真的在脱；
   *   - 连续 N 楼都报这个少件新款（repeatRelease）= 剧情确实改了设定。
   * （显式换装 / 手动保存 / 一次性解锁时 missPieces 根本不会算 —— 见 ③a 的条件。）
   *
   * 其余一律拒绝，并把"少了哪一件"原样说给用户听 —— 这类问题用户一眼就能判对错，
   * 而让它悄悄通过的结果就是"女人的浅蓝色针织衫直接没了"。
   */
  /**
   * 「真的在脱」= 状态位前进 **且** 没有凭空多出别的衣服。
   *
   * 只认状态位是不够的：实测 `sheer gauze slip dress` + removed → 模型报
   * `totally different leather catsuit`，状态位确实前进了，但那是**换了一身**不是脱。
   * 脱衣服只会让身上的东西变少，绝不会变多 —— 多出来的件就是漂移。
   * （内衣除外：脱衣后露出 `black lace bra` 属于"露出来了"，不是新穿一件。）
   */
  const introduced = newGarmentWords(prevBase, nextStyle);
  // 用 linearOrder 而非 STATE_ORDER：swapped 与 removed 同阶会让"换装后再脱"恒判失败（详见 linearOrder 注释）
  const undressing = linearOrder(nextState) > linearOrder(o.state) && !introduced.length;
  if (missPieces.keys.length && !undressing && !repeatRelease && outfitLockLevelOf(d) !== 'off') {
    const needM = Math.max(1, Number(getConfig().consistency?.outfitStyleRepeatFloors ?? 2));
    const cntM = Number(o.pending?.count || 0);
    saveSettings(); // pending 计数是跨楼的，不落盘永远数不到 N
    return {
      ok: false,
      drift: { from: prevBase, to: nextStyle, missing: missPieces.items, level: outfitLockLevelOf(d) },
      reason: `本楼提取的服装比存档少了「${missPieces.labels.join('、')}：${missPieces.items.join('；')}」`
        + ' —— 剧情里没写他脱掉/换掉，按「提取漏项」处理，旧款保持不变。'
        + `\n      现款：${prevBase.slice(0, 90)}`
        + `\n      提取到：${nextStyle.slice(0, 90)}`
        + '\n      确实脱了 → 在正文写明脱衣动作（状态位会自动前进，那时才允许少件）；'
        + '确实换了 → 在正文写明换装，或到「角色档案」点「解锁款式」。'
        + (cntM ? `\n      （这个少件描述已连续出现 ${cntM}/${needM} 楼，再出现 ${needM - cntM} 次会自动放行）` : ''),
      dyn: d,
    };
  }

  if (styleChanged && o.style && !opts.force && !repeatRelease) {
    const level = outfitLockLevelOf(d);
    if (level !== 'off') {
      const prevText = resolveOutfitStyle(d);
      const threshold = Number(
        opts.threshold ?? getConfig().consistency?.outfitDriftThreshold ?? 0.5,
      );
      const coverage = styleCoverage(prevText, nextStyle);

      if (level === 'strict') {
        return {
          ok: false,
          drift: { from: prevText, to: nextStyle, coverage, level },
          reason: '服装款式已冻结（strict），拒绝任何改写。'
            + `\n      现款：${prevText.slice(0, 90)}`
            + `\n      要求改成：${nextStyle.slice(0, 90)}`
            + '\n      要换款式请到「角色档案」页把该角色的保护级别调成「防漂移」，或点「解锁款式」后让扫描改写',
          dyn: d,
        };
      }
      /**
       * v0.9.48：状态位前进（**真的在脱**）也必须豁免覆盖率闸门。
       *
       * 旧口径在这里自相矛盾：提取器规则第 5 条要求"脱掉的衣服不许再写进 outfit"，
       * 模型照做了（少写一件），覆盖率立刻掉到阈值以下 → 被判成「偷换款式」拒绝
       * → 旧款整串保留（脱掉的上衣还挂在身上）→ 画面上"脱了又穿上"。
       * 规则要模型少写、闸门又不许少写，等于把脱衣这条路堵死了。
       */
      if (coverage < threshold && !isSwap && !unlocked && !undressing) {
        const pendCount = Number(o.pending?.count || 0);
        const need = Math.max(1, Number(getConfig().consistency?.outfitStyleRepeatFloors ?? 2));
        // 连续新款计数要落盘 —— 它是跨楼的，这一楼不存就永远数不到 N
        saveSettings();
        return {
          ok: false,
          drift: { from: prevText, to: nextStyle, coverage, level },
          reason: '疑似偷换服装款式 —— 旧款式的元素只保留了 '
            + `${(coverage * 100).toFixed(0)}%（阈值 ${(threshold * 100).toFixed(0)}%）。`
            + `\n      现款：${prevText.slice(0, 90)}`
            + `\n      要求改成：${nextStyle.slice(0, 90)}`
            + '\n      推进状态位时原款式必须逐字照抄；确实要换装请用 state=swapped 并在剧情里写明新款'
            + (pendCount ? `\n      （这套新款已被剧情提到 ${pendCount}/${need} 楼，再出现 ${need - pendCount} 次会自动放行）` : ''),
          dyn: d,
        };
      }
      // 覆盖率达标 → 这是"同一套衣服写得更细"，应当采纳（见 ⑤）
      refined = coverage >= threshold;
    }
  }

  /* ④ swapped 必须给新款式（或指向一个预设） */
  if (nextState === 'swapped' && !nextStyle && !o.preset) {
    return { ok: false, reason: '状态位换成 swapped 但未提供新款式', dyn: d };
  }

  /**
   * ⑤ 落库。
   * 采纳新描述的三种情形：明确换装 / 首次建立 / 同款的补充细化。
   * 其余情况一律保留原值 —— 半褪的仍是那件白衬衫。
   */
  /**
   * opts.force = 用户在面板上手动保存（他的话就是最终答案，闸门不该拦）。
   * ⚠️ 旧版漏了 force：手动改款式时若档案已有款式、又没判定成换装，
   *    改完保存**根本不生效** —— 用户以为改了，出图还是旧的。
   */
  // undressing（状态位前进）：脱掉的衣服本来就该从款式里消失，必须采纳少件后的描述
  let finalStyle = (nextStyle
    && (isSwap || !o.style || refined || opts.force || repeatRelease || unlocked || undressing))
    ? nextStyle : o.style;

  /**
   * ★★★ v0.9.128：面板手动保存（opts.force）时，**空串也必须落地**。
   *
   * 病例（用户 2026-10-22）：「人物档案没法保存修改。比如男主衣服我删了结果又给我写回去了」。
   * 根因就是上面那句的第一项 `nextStyle &&` —— 它是 truthy 检查，空串在这里**短路**，
   * 后面的 `opts.force` 根本没机会生效。于是用户在款式框里清空、点保存，
   * `finalStyle` 老老实实回落到 `o.style`（旧值），重开编辑器又看到它，像是保存无效。
   * （同一模式在 bare / lockLevel / followMode 上已经踩过三次，都是「空串当没传」。）
   *
   * 为什么空款式是**合法**状态，不是误操作：
   *   · `state === 'removed'` 时衣服已经全脱了，旧款式留着只会让模型把它穿回去 ——
   *     这正是「明明写完全裸，男主身上却凭空多出衬衫」的来源；
   *   · 用户也可能只想用 bare 描述裸露、把款式彻底留空。
   *
   * 只对**手动路径**放开：AI 路径（非 force）传空串仍然是噪声，必须继续沿用旧值，
   * 否则模型漏写一次 outfit 就把档案里的服装清空了。
   */
  if (opts.force && !nextStyle) finalStyle = '';

  /**
   * ⑤b 裸露锚点（v0.9.45）：`bare` = 此刻**裸露的部位**，由模型从正文读出、插件机械注入。
   * 它和 style 是互补的两半：style 写还穿在身上的衣服，bare 写已经露出来的身体。
   * 只有显式传入才动它（传空串 = 明确清空）；回退（重新穿好）又没显式给 → 自动清空。
   */
  let nextBare = null;
  if (typeof opts.bare === 'string') nextBare = oneLine(opts.bare);
  else if (isRedress) nextBare = '';
  /**
   * 自洽性（不是"默认穿好"）：模型**明确报了** intact（完好穿着）却没提裸露，
   * 而档案里还留着「下身赤裸」—— 两句注入出来会打架（身穿 XXX ／裸露=下身赤裸）。
   * intact 与裸露语义互斥，模型既然判了"穿好了"，就把裸露锚点清掉。
   * ⚠️ 前提是**模型报了**；模型压根没提这个角色时不会走到这里（那才是真正该沿用的情况）。
   */
  else if (explicitState === 'intact') nextBare = '';
  /**
   * v0.9.52：swapped 同理 —— 换上一身新衣服后，旧的裸露锚点必须清掉，
   * 否则会注入出「身穿新睡衣；下身赤裸」这种自相矛盾的句子。
   * （旧版只判 intact，换装路径漏了：换了衣服却还留着上一场的裸露锚点。）
   */
  else if (explicitState === 'swapped') nextBare = '';
  // ①b 预设落地时拆出来的状态词（预设里若混了 "skirt unbuttoned" 之类）
  if (nextBare === null && presetBare) nextBare = presetBare;

  /**
   * ⑤b-2 存量自愈（v0.9.46）：把**混进款式的状态词**搬到 bare。
   *
   * 病例：style = "black hoodie, light blue shorts and underwear pulled down around his knees"
   * 注入出来是「身穿…褪到膝盖的短裤」—— 自相矛盾。而且这种一次性状态被固化进款式后，
   * 之后每楼都带着它出场（哪怕剧情里早就穿回去了）。
   *
   * ★ 款式**永远拆**（状态词本来就不属于款式，拆掉是减少漂移）；
   *   bare 则**显式优先** —— 模型/面板已经给了 bare 就以它为准，
   *   拆出来的那些片段是同一件事的重复表达，直接丢弃。
   *
   * 为什么不能"有 bare 就不拆款式"（第一版就是这么写的）：实测夜斗那条
   * bare 已经填好了，style 里的 `pulled down around his knees` 就永远清不掉，
   * 注入出来是「身穿褪到膝盖的短裤／裸露=下身赤裸」—— 两句打架。
   */
  if (finalStyle) {
    const sp = splitOutfitStyle(finalStyle);
    if (sp.moved) {
      finalStyle = sp.style;
      if (nextBare === null) nextBare = sp.bare;
    }
  }

  // 真换了款式就解除预设引用，否则预设会把新款式盖回去
  /**
   * ★ v0.9.71：「款式框被回填成引用原文」不算换了款式。
   *
   * 这里比的是 `finalStyle !== o.style`，而 o.style 是**上一次**存的自由文本 ——
   * 面板把款式框回填成预设原文之后，它跟旧的 o.style 当然不一样（哪怕用户一个字没动），
   * 于是引用又被清一次。所以必须补一条豁免：新款等于当前引用内容时，保留引用。
   *
   * 没这条的话，上面 ①b 收窄了判定也白搭 —— 两个清引用点任意一个触发就够了。
   */
  /**
   * ★ v0.9.129：**显式建立引用时不清引用**。
   *
   * 病例（dev/engine-test.mjs ⑤-⑦ 抓到，v0.9.127 也红 —— 是存量 bug，
   * 只是 v0.9.128 修了空串落地之后症状更明显）：
   * `applyOutfitPreset()` 走的是 `updateOutfit(name, '', state, round, { preset, force })`
   * —— 款式文本本来就是空串（内容由预设展开，不该再复写一份进 style）。
   * 而下面这条闸门比的是 `finalStyle !== o.style`：空串（以及被 `splitOutfitStyle`
   * 拆掉状态词后的款式）都算「换了款式」→ 刚挂上的引用当场被解掉。
   * 结果：面板里点「应用预设」看着成功了，preset 字段其实是空的，
   * 注入出来还是旧的手写款式，或者干脆什么都没穿。
   *
   * 语义上「调用方显式传了 preset」= 他就是在**建立/重申**这条引用，
   * 没有理由再按"款式变了"来解引用。真正的换装路径（applyChanges 不带 preset 参数）
   * 不受影响，仍然照旧解引用。
   */
  const presetRequested = typeof opts.preset === 'string' && !!oneLine(opts.preset);
  if (!presetRequested
    && finalStyle !== o.style
    && finalStyle !== String(getConfig().outfitPresets?.[o.preset] || '')) {
    o.preset = '';
  }
  // 款式已定：连续新款计数作废，「解锁款式」一次性标记用后即清
  if (repeatRelease || unlocked || opts.force || finalStyle === nextStyle) o.pending = null;
  if (unlocked) o.styleUnlocked = false;

  const finalBare = nextBare === null ? String(o.bare || '') : nextBare;

  if (finalStyle !== o.style || nextState !== o.state || finalBare !== String(o.bare || '')) {
    o.history.push({
      round, style: o.style, preset: o.preset, state: o.state, bare: o.bare, at: Date.now(),
      floor: Number(opts.floor) || 0, // v0.9.48：记下是哪一楼改的，删楼才能回滚
    });
    if (o.history.length > 40) o.history.splice(0, o.history.length - 40);
  }

  o.style = finalStyle;
  o.state = nextState;
  o.bare = finalBare;
  /**
   * 三维度落库：空串即"无"，直接 delete —— 保持旧存档结构干净，
   * 也让「清空」与「从未设置」在数据上无法区分（这两者本来就该同义）。
   */
  if (nextDetail) o.stateDetail = nextDetail; else delete o.stateDetail;
  if (nextMod) o.mod = nextMod; else delete o.mod;
  if (nextShoes) o.shoes = nextShoes; else delete o.shoes;
  o.changedAt = round || o.changedAt;
  saveSettings();
  return { ok: true, dyn: d };
}

/**
 * 只更新裸露锚点，不动款式 / 状态位（v0.9.46）。
 *
 * 用途：款式因防漂移闸门被拒时，**「他脱了」这件事仍然必须生效**。
 * 否则 NSFW 里最关键的一帧会因为款式判断分歧（模型报的新款覆盖率不够、
 * 或款式被冻结）而整条丢失 —— 画面重新变回穿着衣服，正是用户最在意的那个现象。
 * 裸露状态与"他穿哪件衣服"是两个独立维度，不该被款式闸门连坐。
 *
 * @param {string} name
 * @param {string} bare 裸露部位（英文）；传空串 = 清空（穿回去了）
 * @param {number} round
 * @param {{floor?:number}} [opts] v0.9.48：触发这次变化的楼层，用于删楼回滚
 * @returns {{ok:boolean, reason?:string, dyn:object, unchanged?:boolean}}
 */
export function setOutfitBare(name, bare, round = 0, opts = {}) {
  const d = getDyn(name);
  if (!d) return { ok: false, reason: '无档案节点' };
  const o = d.outfit;
  const nextBare = oneLine(bare);
  if (nextBare === String(o.bare || '')) return { ok: true, dyn: d, unchanged: true };

  o.history.push({
    round, style: o.style, preset: o.preset, state: o.state, bare: o.bare, at: Date.now(),
    floor: Number(opts.floor) || 0,
  });
  if (o.history.length > 40) o.history.splice(0, o.history.length - 40);
  o.bare = nextBare;
  o.changedAt = round || o.changedAt;
  saveSettings();
  return { ok: true, dyn: d };
}

/**
 * v0.9.98 · SD 专用服装字段（`styleSd` / `bareSd`）落库。
 *
 * ★ 为什么是独立函数、不塞进 updateOutfit：
 *   updateOutfit 是**状态机**（单调前进 / 款式漂移闸门 / 覆盖率 / 部件守恒 / 连续放行），
 *   那套闸门是为「模型每楼重写一遍服装」设计的。而 SD 的 tag 框是**用户手填的对照表**，
 *   不参与剧情推导，塞进状态机只会被漂移闸门反复挡下（用户改一次被拒一次）。
 *   所以这两半走独立通道：只写字段、只记时间，不碰 state / history / pending。
 *
 * ★ 传空串 = 显式清空（delete），与"从未设置"同义 —— 同三维度那条踩过的坑：
 *   留着空串会让回落逻辑误判"有 SD 版"，结果输出空服装。
 */
export function setOutfitSd(name, { styleSd = '', bareSd = '' } = {}) {
  const d = getDyn(name);
  if (!d) return { ok: false, reason: '无档案节点' };
  const o = d.outfit;
  const s = oneLine(styleSd);
  const b = oneLine(bareSd);
  if (s === String(o.styleSd || '') && b === String(o.bareSd || '')) {
    return { ok: true, dyn: d, unchanged: true };
  }
  if (s) o.styleSd = s; else delete o.styleSd;
  if (b) o.bareSd = b; else delete o.bareSd;
  o.sdUpdatedAt = Date.now();
  saveSettings();
  return { ok: true, dyn: d };
}

/* ============ 删楼 / 重跑回滚（v0.9.48） ============ */

/**
 * ★ 为什么必须回滚（用户 2026-09-29 的原话：「我删楼重新生成，也没用」）。
 *
 * 服装状态存在**会话档案**里（`chats[chatId].dyn`），跟聊天消息是两套数据。
 * 删楼只删消息，**档案不会跟着退回去** —— 于是：
 *   ① 那一楼分析出来的服装变化（哪怕是被漂移污染的）留在档案里，
 *      重跑一次等于在**错误的结果上**再算一遍，怎么重跑都救不回来；
 *   ② 更要命的是「连续新款计数」`pending` 也留着 —— 每重跑一次计数 +1，
 *      达到 N 就自动放行新款。于是**删楼重跑反而加速把漂移固化**。
 *
 * 所以服装必须跟着楼层一起回滚：本楼（含）之后产生的一切服装变化全部作废，
 * 退回"本楼之前"那一条记录，重新开始推导。
 */

/**
 * 回滚单个角色：丢弃楼层号 ≥ floor 的服装变化记录，恢复到之前的那一版。
 *
 * @param {string} name
 * @param {number} floor 触发本次分析的楼层号（mesId）。本楼及之后的记录都视为"作废"。
 * @returns {boolean} 是否真的改了东西
 */
export function rollbackOutfitToFloor(name, floor) {
  const d = getDyn(name);
  if (!d) return false;
  const f = Number(floor) || 0;
  if (f <= 0) return false; // 没有楼层号 = 手动/未知来源，不参与回滚

  const o = d.outfit;
  const hist = Array.isArray(o.history) ? o.history : [];
  /**
   * 没有楼层号的记录（v0.9.48 之前的历史、面板手动设置）一律视为"本楼之前"，
   * 永不回滚 —— 用户亲手设的常服不该因为删一次楼就被抹掉。
   */
  const keep = hist.filter(h => (Number(h?.floor) || 0) < f);
  const doomed = hist.filter(h => (Number(h?.floor) || 0) >= f);

  /**
   * 本楼没造成任何服装变化（常见：扫描报的款式被闸门拒了，一条 history 都没留下）
   * → 款式/状态位本来就没动，只需把**连续新款计数**清掉。
   * 计数不清的后果正是"删楼重跑越跑越容易放行"：每重跑一次 +1，N 次后自动放行新款。
   */
  if (!doomed.length) {
    if (!o.pending) return false;
    o.pending = null;
    return true;
  }

  /**
   * 恢复到哪一条？
   *
   * ⚠️ history 里每条存的是**变更前**的快照（"改之前他是什么样"），不是"改之后"。
   * 所以被作废的那批记录里**最早**一条，它的快照恰好就是"这批改动发生之前"的状态
   * —— 拿它当回滚目标最准，而且对 v0.9.48 之前的旧数据同样成立。
   *
   * 有款式的那条优先（有的历史条目只改了状态位、没动款式，style 是空的）。
   */
  const hasStyle = (h) => String(h?.style || '').trim() || String(h?.preset || '').trim();
  const target = doomed.find(hasStyle) || doomed[0];

  const nextStyle = String(target?.style || '');
  const nextPreset = String(target?.preset || '');
  const nextState = String(target?.state || 'intact') || 'intact';
  const nextBare = String(target?.bare || '');

  const changed = nextStyle !== String(o.style || '')
    || nextPreset !== String(o.preset || '')
    || nextState !== String(o.state || '')
    || nextBare !== String(o.bare || '')
    || !!o.pending;

  o.history = keep;
  o.style = nextStyle;
  o.preset = nextPreset;
  o.state = nextState;
  o.bare = nextBare;
  o.pending = null;         // 连续新款计数必须作废，否则重跑会越跑越容易放行
  o.changedAt = Number(target?.round || 0) || o.changedAt;
  return changed;
}

/**
 * 当前会话**全体角色**的服装回滚到 floor 之前。
 *
 * 走全量而不是"只回滚本楼在场的人"：被删掉的那一楼里改过谁的衣服无法预知，
 * 而一个会话的 dyn 通常只有几十条，全量扫一遍是纯内存操作，代价可以忽略。
 *
 * @param {number} floor
 * @returns {{rolled:number, names:string[]}}
 */
export function rollbackOutfitsBefore(floor) {
  const f = Number(floor) || 0;
  if (f <= 0) return { rolled: 0, names: [] };
  const chat = chatNode(false);
  const dyn = chat?.dyn;
  if (!dyn) return { rolled: 0, names: [] };

  const names = [];
  for (const n of Object.keys(dyn)) {
    if (rollbackOutfitToFloor(n, f)) names.push(n);
  }
  if (names.length) saveSettings();
  return { rolled: names.length, names };
}

/**
 * 「解锁款式」—— 一次性放行下一次款式改写（v0.9.47，面板按钮）。
 *
 * 场景：剧情确实换了衣服，但扫描没跟上（正文没写「换上」、也没踩中场景切换），
 * 防漂移闸门就会一直挡着。以前只能去改保护级别（改完全局都松了）或手动敲款式。
 * 这里给一次性的口子：点一下，下一次扫描报新款时放行，用完自动清除。
 *
 * @param {string} name
 * @returns {boolean} 是否设置成功
 */
export function unlockOutfitStyle(name) {
  const d = getDyn(name);
  if (!d) return false;
  d.outfit.styleUnlocked = true;
  d.outfit.pending = null;
  saveSettings();
  return true;
}

/** 该角色当前是否处于「已解锁款式」状态（面板用来显示按钮状态）。 */
export function isOutfitStyleUnlocked(name) {
  const d = peekDyn(name);
  return d?.outfit?.styleUnlocked === true;
}

/* ============ 服装预设 ============ */

/** 列出预设（名字 → 描述）。 */
export function listOutfitPresets() {
  return { ...(getConfig().outfitPresets || {}) };
}

/**
 * v0.9.72 · P5 引用计数：每个预设被几个角色引用着。
 *
 * 为什么按**角色名**去重而不是按条目数：
 *   同一个角色在多个会话里都引用了「夏季校服」→ 视觉上仍然是"1 个角色在用"；
 *   跨角色卡同名（夜斗这张卡跑完换另一张卡还是他）通常也是同一个人。
 *   按条目数会算出 7、8 这种数，看着像"很多人在穿"其实是同一个人 —— 数字失去意义。
 *
 * 只读遍历，不写任何东西；数据量小（几十角色 × 几十会话），直接算不缓存
 * （缓存了反而会和用户刚改的引用不一致）。
 *
 * @returns {{[预设名:string]: number}} 只含有引用的预设（没被引用的键不出现）
 */
export function presetUsageCounts() {
  const r = settingsRoot();
  const chars = r?.chars;
  /** @type {Map<string, Set<string>>} 预设名 → 引用它的角色名集合 */
  const map = new Map();
  if (!chars || typeof chars !== 'object') return {};
  for (const cardName of Object.keys(chars)) {
    const chats = chars[cardName]?.chats;
    if (!chats || typeof chats !== 'object') continue;
    for (const chatId of Object.keys(chats)) {
      const dynRoot = chats[chatId]?.dyn;
      if (!dynRoot || typeof dynRoot !== 'object') continue;
      for (const who of Object.keys(dynRoot)) {
        const p = oneLine(dynRoot[who]?.outfit?.preset);
        if (!p) continue;
        if (!map.has(p)) map.set(p, new Set());
        map.get(p).add(who);
      }
    }
  }
  const out = {};
  for (const [p, set] of map) out[p] = set.size;
  return out;
}

/** 新增/更新一个预设。 */
export function saveOutfitPreset(name, text) {
  const key = oneLine(name);
  if (!key) return false;
  const cfg = getConfig();
  if (!cfg.outfitPresets) cfg.outfitPresets = {};
  cfg.outfitPresets[key] = oneLine(text);
  saveSettings();
  return true;
}

export function removeOutfitPreset(name) {
  const cfg = getConfig();
  if (!cfg.outfitPresets?.[name]) return false;
  delete cfg.outfitPresets[name];
  // 分类与预设同名同命 —— 预设删了，分类记录留着就是幽灵数据（v0.9.55）
  if (cfg.presetCats) delete cfg.presetCats[name];
  // 展示图记录同理（v0.9.56）；服务器上的原始文件由 UI 层顺手删（store 不碰网络）
  if (cfg.presetImages) delete cfg.presetImages[name];
  saveSettings();
  return true;
}

/* ---- 预设展示图（v0.9.56）----
 * cfg.presetImages = { 预设名: 图片引用 }，引用两种形态：
 *  - '/user/files/huiling-preset-xxxx.jpg' ← 上传到酒馆服务端的**原始文件**（主路径，
 *    不占存档体积，存档损坏也不丢；替换 / 删除时由 UI 层调 st.js 的 deleteUserFile 清文件）
 *  - 'data:image/...' ← 上传失败时的回退（直接嵌存档，保证功能可用）
 * 只影响卡片显示，不进出图提示词 —— 与角色形象图同语义。 */

/** 读某预设的展示图引用（没有 = ''）。 */
export function getPresetImage(name) {
  return String(getConfig().presetImages?.[name] || '');
}

/** 写某预设的展示图引用（ref 留空 = 清除记录；文件删除归 UI 层管）。 */
export function setPresetImage(name, ref) {
  const r = String(ref || '').trim();
  const cfg = getConfig();
  if (!r) {
    if (cfg.presetImages) delete cfg.presetImages[name];
  } else {
    if (!cfg.presetImages) cfg.presetImages = {};
    cfg.presetImages[name] = r;
  }
  saveSettings();
  return true;
}

/* ---- 预设分类（v0.9.55）----
 * 分类**独立于** outfitPresets 主结构存储（cfg.presetCats = {预设名: 分类}），
 * 主结构保持 {名: 描述} 纯 map 不动 —— resolveOutfitStyle / buildOutfitScanMessages
 * 等所有消费方零改动。分类丢失只是回到「未分类」，不影响出图。 */

/** 列出预设分类（预设名 → 分类名）。 */
export function listPresetCats() {
  return { ...(getConfig().presetCats || {}) };
}

/** 设置一个预设的分类（cat 留空 = 移回「未分类」）。 */
export function setPresetCat(name, cat) {
  const c = oneLine(cat || '');
  const cfg = getConfig();
  if (!c) {
    if (cfg.presetCats) delete cfg.presetCats[name];
  } else {
    if (!cfg.presetCats) cfg.presetCats = {};
    cfg.presetCats[name] = c;
  }
  saveSettings();
  return true;
}

/**
 * v0.9.74 · 分类重命名：把「from」分类下的所有预设改归「to」。
 *
 * ★ 分类只是 presetCats 上的一个字符串值，没有独立的分类实体 ——
 *   重命名 = 遍历把值批量替换。目标为空 = 整类移回「未分类」（delete）。
 * ★ 返回改动的预设数（UI 拿它提示「已改名 N 个预设」）。
 */
export function renamePresetCat(from, to) {
  const f = oneLine(from || '');
  if (!f) return 0;
  const t = oneLine(to || '');
  const cfg = getConfig();
  if (!cfg.presetCats) return 0;
  let n = 0;
  for (const name of Object.keys(cfg.presetCats)) {
    if (oneLine(cfg.presetCats[name]) !== f) continue;
    if (!t) delete cfg.presetCats[name];
    else cfg.presetCats[name] = t;
    n += 1;
  }
  if (n) saveSettings();
  return n;
}

/** 给某角色套用预设（等价于「换装成预设」）。 */
export function applyOutfitPreset(name, presetName, state = 'intact', round = 0) {
  return updateOutfit(name, '', state, round, { preset: presetName, force: true });
}

/**
 * 批量落库「服装扫描」的结果（v0.9.39）。
 *
 * 与 applyChanges 里那条路径的区别：这里带 swapped 信号 —— 正文里命中换装动词的，
 * 才允许改写已有的款式；没命中的一律走正常闸门（覆盖率不足 → 拒绝，保持旧款）。
 *
 * @param {Array} list [{name, outfit, outfitState, outfitPreset, swapped}]
 * @param {number} round
 * @param {{floor?:number}} [opts] v0.9.48：楼层号，写进变更记录供删楼回滚使用
 * @returns {{applied:Array, rejected:Array, skipped:Array}}
 */
export function applyOutfitScan(list, round = 0, opts = {}) {
  const out = { applied: [], rejected: [], skipped: [] };
  if (!Array.isArray(list)) return out;
  const floor = Number(opts.floor) || 0;

  /**
   * 主角的两条档案必须同步：库里常常同时存在「夜斗」与「<user>」两条
   * （名字逐字不同、外貌描述雷同 —— 就是同一个人）。只更新一条的话，
   * 出图时按哪条展开取决于模型写哪个名字，服装就会时有时无。
   */
  const userName = String(getUserName() || '').trim();
  const aliasOf = (n) => {
    if (!userName) return '';
    if (n === '<user>') return userName;
    if (n === userName) return '<user>';
    return '';
  };

  const writeOne = (raw) => {
    const name = oneLine(raw?.name);
    if (!name) return;
    const style = oneLine(raw?.outfit ?? raw?.style);
    const state = String(raw?.outfitState ?? raw?.state ?? '').trim().toLowerCase();
    const preset = oneLine(raw?.outfitPreset ?? raw?.preset);
    const swapped = raw?.swapped === true;
    /**
     * v0.9.47：裸露锚点 + 重新着衣信号。
     *
     * ⚠️ bare 必须是**三态**，不能用 oneLine 一律压成字符串：
     *   undefined = 模型这次没提裸露 → **不动**（沿用上一楼）
     *   ''        = 模型明确说"没露" → 清空
     * 旧版 `oneLine(undefined)` 得到 ''，被当成"明确清空"——
     * 结果只要款式被闸门拒一次，角色的裸露锚点就被静默清空，
     * 画面立刻从"下身赤裸"变回穿着衣服 —— 正是用户说的「脱了又穿上」。
     */
    const bareRaw = raw?.outfitBare !== undefined ? raw.outfitBare : raw?.bare;
    const bare = bareRaw === undefined || bareRaw === null ? null : oneLine(bareRaw);
    const redress = raw?.redress === true;
    const sceneBreak = raw?.sceneBreak === true;

    /**
     * v0.9.72 · 服装三维度（状态细档 / 改造 / 鞋袜）—— 由扫描模型顺手填。
     *
     * ★ 三态语义，跟 bare 一模一样，别用 oneLine 一律压成字符串：
     *   undefined = 模型这次没提 → **不动**（沿用上一楼）
     *   ''        = 模型明确说"没有" → 清掉
     *   档名      = 落库（非法档名由 pickOutfitDims 静默丢弃）
     *
     * ★ 开关关着时一律不读（autoOutfitDimsOn()）—— 关 = 模型没有写权限，
     *   它就算自己脑补回了这三个字段也不许进档案。这是双保险的另一半
     *   （提示词里那段说明在关着时根本不会发出去）。
     */
    const dimsOn = autoOutfitDimsOn();
    const pickDim = (a, b) => {
      if (!dimsOn) return undefined;
      const v = a !== undefined && a !== null ? a : b;
      return v === undefined || v === null ? undefined : oneLine(v);
    };
    const dims = {
      stateDetail: pickDim(raw?.outfitDetail ?? raw?.stateDetail, raw?.detail),
      mod: pickDim(raw?.outfitMod ?? raw?.mod, raw?.modification),
      shoes: pickDim(raw?.outfitShoes ?? raw?.shoes, raw?.footwear),
    };
    const hasDim = Object.values(dims).some(v => v !== undefined);

    /**
     * 什么都没给 = 提取器判断"沿用"或"正文没写" → 不动档案（动一下就是漂移）。
     * ⚠️ v0.9.45：`bare` 也算有效输出 —— 角色脱光了之后身上没有衣服可写，
     * 模型只会回 bare（"下身赤裸"）。漏掉这个判断，NSFW 里最关键的那一帧反而会
     * 被当成"没提取到"跳过，画面重新变回穿着衣服。
     * ⚠️ v0.9.72：三维度同理 —— 只报了「裙子被撩起」也是有效变化，不该被当成没提取到。
     */
    if (!style && !preset && !bare && !redress && !hasDim) {
      out.skipped.push({ name, reason: '未返回服装描述（沿用或正文无描写）' });
      return;
    }

    /**
     * 拒绝"废话服装"：只有鞋袜、或只有 clothes / 衣服 这种泛称 → 不落库。
     * 实测：正文只写了「塑料边缘在衣服上勒出声响」「洗得发白的球鞋」，
     * 模型就交出 `faded white sneakers, worn clothes`。一旦落库，款式闸门会
     * 把它**永久锁死**（之后没有换装动词就不许改）—— 角色从此每帧穿着一句空话出场。
     * 宁可保持"未记录"（下轮再试、或提示用户手动设），也不能记垃圾。
     */
    if (style && !preset && !hasRealGarment(style)) {
      out.rejected.push({
        name,
        reason: `提取到的不是具体衣服（「${style.slice(0, 60)}」）—— 正文只提到鞋袜或泛称，`
          + '为避免把废话永久固化，本次不写入。请在「角色档案」页手动设定他的常服，或在正文里写明他穿什么。',
      });
      return;
    }

    const res = updateOutfit(name, style, state, round, {
      preset, swapped, bare, redress, sceneBreak, floor,
      stateDetail: dims.stateDetail, mod: dims.mod, shoes: dims.shoes,
    });
    if (res.ok) {
      out.applied.push({
        name,
        style: resolveOutfitStyle(res.dyn),
        bare: String(res.dyn?.outfit?.bare || ''),
        state: res.dyn?.outfit?.state,
        swapped,
        /** v0.9.72：三维度回带，诊断里能看见这楼到底落了哪几档 */
        dims: {
          stateDetail: String(res.dyn?.outfit?.stateDetail || ''),
          mod: String(res.dyn?.outfit?.mod || ''),
          shoes: String(res.dyn?.outfit?.shoes || ''),
        },
      });
      // 别名同步：同一套衣服写进另一个名字（同一个人）
      const alias = aliasOf(name);
      if (alias) {
        const r2 = updateOutfit(alias, style, state, round, {
          preset: '', swapped: true, bare, redress, floor,
          stateDetail: dims.stateDetail, mod: dims.mod, shoes: dims.shoes,
        });
        if (r2.ok) {
          out.applied.push({ name: alias, style: resolveOutfitStyle(r2.dyn), state: r2.dyn?.outfit?.state, swapped, aliasOf: name });
        }
      }
    } else {
      /**
       * v0.9.46：款式被拒 ≠ 裸露状态没变。
       * 「他把裤子褪到膝盖」这件事跟"他到底穿哪条裤子"是两回事 ——
       * 不能因为款式判断有分歧就把"他脱了"也一起丢掉（丢掉的后果就是画面又穿上）。
       * 这里把 bare 单独落库，款式那条告警照常报给用户自己去定夺。
       */
      const wantBare = typeof bare === 'string' ? bare : (redress ? '' : null);
      // bare === null（模型没提）时 wantBare 为 null → 不会进这个分支，裸露沿用
      if (wantBare !== null && wantBare !== String(res.dyn?.outfit?.bare || '')) {
        setOutfitBare(name, wantBare, round, { floor });
        const alias = aliasOf(name);
        if (alias) setOutfitBare(alias, wantBare, round, { floor });
        out.applied.push({
          name, bare: wantBare, bareOnly: true,
          note: '只更新了裸露状态（款式改动被防漂移闸门拒绝）',
        });
      }
      /**
       * v0.9.72：款式被拒 ≠ 三维度也作废（同 bare 那条道理）。
       * 「她把裙子撩起来」「换了一双高跟鞋」跟"她穿哪条裙子"是两码事，
       * 不能因为款式判断有分歧，连已经发生的穿着推进一起丢掉。
       */
      if (hasDim) {
        const rd = setOutfitDims(name, dims, round);
        if (rd.written?.length) {
          const alias = aliasOf(name);
          if (alias) setOutfitDims(alias, dims, round);
          out.applied.push({
            name, dimsOnly: true, dims: rd.written,
            note: '只更新了服装三维度（款式改动被防漂移闸门拒绝）',
          });
        }
      }
      out.rejected.push({ name, reason: res.reason, drift: res.drift });
    }
  };

  for (const raw of list || []) writeOne(raw);
  return out;
}

/** 设置某角色的款式保护级别（''= 跟随全局）。 */
export function setOutfitLock(name, level) {
  const d = getDyn(name);
  if (!d) return false;
  d.outfit.lockLevel = OUTFIT_LOCK_LEVELS.includes(level) ? level : '';
  saveSettings();
  return true;
}

/** 取某个楼层时刻的服装状态（位置门控用：P5 换的衣服不能出现在 P2 的图里）。 */
export function outfitAt(name, round) {
  const d = getDyn(name);
  if (!d) return null;
  const o = d.outfit;
  if (!round || !o.history?.length) return { style: o.style, state: o.state };
  // history 记录的是"变化前的值"，从前往后找最后一个 round <= 目标 的 before 值
  let snapshot = null;
  for (const h of o.history) {
    if (h.round && h.round <= round) snapshot = { style: h.style, state: h.state };
  }
  return snapshot || { style: o.style, state: o.state };
}

/* ============ 在场角色 / NPC 生命周期 ============ */

export function markPresent(names, round = 0) {
  const chat = chatNode(true);
  if (!chat) return;
  const set = new Set(chat.present || []);
  for (const n of names) {
    if (!n) continue;
    set.add(n);
    const d = getDyn(n);
    if (d) {
      if (!d.firstSeenRound) d.firstSeenRound = round;
      d.lastSeenRound = Math.max(d.lastSeenRound || 0, round);
    }
  }
  chat.present = Array.from(set);
  chat.touchedAt = Date.now();
  saveSettings();
}

export function setRound(round) {
  const chat = chatNode(true);
  if (!chat) return;
  chat._round = Math.max(chat._round || 0, round || 0);
  saveSettings();
}

/* ============ 待建档名单（v0.9.26） ============ */

/**
 * 「画面里有这个人、档案库里却没他」的角色名单。
 *
 * ★ 这是「第二个角色没有外貌」的根因级修复。
 * 实测病例：模型在 cast 里点了「夜斗」（＝ <user> 本人），但 changes 里提交的是
 * `kind:"new"` 却没带任何静态锚点字段 → 被 applyChanges 拒绝 → 夜斗永远进不了档案库
 * → 下一轮 cast 还是点不到他 → 每一轮都在同一个地方失败。
 * 死循环的成因是**模型不知道自己上一轮建档失败了**（它只看得到正文，看不到插件拒绝日志）。
 *
 * 破法：插件把失败名单攒下来，下一轮显式回灌给模型，点名要求它补齐 fields。
 */
export function addPendingProfiles(names) {
  const chat = chatNode(true);
  if (!chat) return;
  const list = Array.isArray(chat.pending) ? chat.pending : [];
  const set = new Set(list);
  let touched = false;
  for (const n of names) {
    const name = String(n || '').trim();
    // 宏占位、空串、显然无意义的指代不进名单（进了也建不了档）
    if (!name || /^<(user|bot|char|persona|assistant|system)>$/i.test(name)) continue;
    if (!set.has(name)) { set.add(name); touched = true; }
  }
  if (!touched) return;
  chat.pending = Array.from(set).slice(0, 20);   // 上限 20，防止脏名字无限堆积
  chat.touchedAt = Date.now();
  saveSettings();
}

/** 取待建档名单，自动剔除已经建档成功的。 */
export function listPendingProfiles(existingNames) {
  const chat = chatNode(false);
  if (!chat) return [];
  const raw = Array.isArray(chat.pending) ? chat.pending : [];
  if (!raw.length) return [];                 // 本来就是空的，别为它写一次盘
  const have = new Set((existingNames || []).filter(Boolean));
  const kept = raw.filter(n => n && !have.has(n));
  if (kept.length !== raw.length) {
    chat.pending = kept;
    saveSettings();
  }
  return kept;
}

export function clearPendingProfile(name) {
  const chat = chatNode(false);
  if (!chat || !Array.isArray(chat.pending)) return;
  const next = chat.pending.filter(n => n !== name);
  if (next.length === chat.pending.length) return;
  chat.pending = next;
  saveSettings();
}

export function getRound() {
  const chat = chatNode(true);
  return chat?._round || 0;
}

/**
 * NPC 休眠（不物理删除）。正文再次提到时由 wakeByText 唤醒。
 * 休眠档案永久保留，避免"重新建档又漂移一次"。
 */
export function gcNpcs(currentRound) {
  const chat = chatNode(true);
  if (!chat) return 0;
  let changed = 0;
  for (const [name, d] of Object.entries(chat.npcs || {})) {
    const gap = currentRound - (d.lastSeenRound || 0);
    if (d.ephemeral && gap >= 3 && !d.sleep) { d.sleep = true; changed += 1; }
    else if (!d.ephemeral && gap >= 15 && !d.sleep) { d.sleep = true; changed += 1; }
  }
  if (changed) saveSettings();
  return changed;
}

/** 名字命中判定：精确 → 小写 → 前 2 字相同且长度差 ≤1。 */
export function nameMentioned(text, name) {
  if (!text || !name) return false;
  if (text.includes(name)) return true;
  const lower = text.toLowerCase();
  if (lower.includes(name.toLowerCase())) return true;
  if (name.length >= 2) {
    const p2 = name.slice(0, 2);
    let idx = text.indexOf(p2);
    while (idx >= 0) {
      let end = idx + 2;
      while (end < text.length && !/[，。！？；：、,.!?;:\s\n"“”'’]/.test(text[end]) && end - idx < 10) end += 1;
      const cand = text.slice(idx, end);
      if (cand.length >= 2 && cand.slice(0, 2) === p2 && Math.abs(cand.length - name.length) <= 1) return true;
      idx = text.indexOf(p2, idx + 1);
    }
  }
  return false;
}

/** 正文命中唤醒休眠 NPC。 */
export function wakeByText(body) {
  const chat = chatNode(true);
  if (!chat) return 0;
  let changed = 0;
  for (const [name, d] of Object.entries(chat.npcs || {})) {
    if (d.sleep && nameMentioned(body, name)) {
      d.sleep = false;
      d.lastSeenRound = chat._round || 0;
      changed += 1;
    }
  }
  if (changed) { saveSettings(); info(STAGE.CONSISTENCY, `唤醒 ${changed} 个休眠角色`); }
  return changed;
}

export function listDyn({ includeSleep = false } = {}) {
  const chat = chatNode(true);
  if (!chat) return [];
  const out = [];
  for (const [name, d] of Object.entries(chat.dyn || {})) {
    if (!includeSleep && d.sleep) continue;
    out.push({ name, dyn: d, scope: 'cast' });
  }
  for (const [name, d] of Object.entries(chat.npcs || {})) {
    if (!includeSleep && d.sleep) continue;
    out.push({ name, dyn: d, scope: 'npc' });
  }
  return out;
}

/**
 * 把静态库与动态状态合起来，供提示词构造使用。
 *
 * ⚠️ 必须**深拷贝**，不能返回 live 引用。
 *
 * 快照的语义是「本楼开始之前的状态」，它是位置门控的基线：
 * 第 2 段要配图时，用的是快照 + 「第 2 段之前发生的变化」。
 * 如果这里返回引用，`applyChanges` 随后对库的写入（updateOutfit / upsertEntry）
 * 会**就地改写**同一个对象 —— 基线被污染成「本楼结束时」的状态，
 * 于是所有图片都会用上最后才发生的服装/锚点变化，位置门控形同虚设。
 * 表现是：第 2 段那张图里，衣服已经是第 5 段才褪下的样子。
 */
/**
 * 宏占位名 → 真实角色名的别名。
 *
 * ★ 一键建档（「从角色卡建档」）扫 persona 时，模型常把主角的名字输出成 `<user>`
 *   —— 素材里原文就是这么写的，它照抄。存下来就是一条名叫 `<user>` 的档案，
 *   字段填得再全也是废的：出图时 cast 点的是真名（如「夜斗」），
 *   而 cleanRefName 会把宏名剥成空串判为废条目 → **主角永远没有外貌**。
 *
 * 用户不可能知道要去手动改名（他以为档案已经建好了 —— 列表里确实有这个人，字段也都在）。
 * 所以在**读取层**做别名：`<user>` → persona 真名（ctx.name1），`<bot>`/`<char>` → 角色卡名。
 * 只影响出图时的查询，不动存储，也不碰任何写路径，避免改名带来的 key 漂移。
 *
 * @returns {string|null} 别名；无需映射时返回 null
 */
export function macroAliasName(rawName, allCast) {
  const name = String(rawName || '').trim();
  const m = /^<(user|bot|char|persona|assistant)>$/i.exec(name);
  if (!m) return null;
  const kind = m[1].toLowerCase();
  const real = (kind === 'user' || kind === 'persona') ? getUserName() : getCharName();
  const target = String(real || '').trim();
  if (!target) return null;                       // 拿不到真名，保持原样（宁可不映射）
  // 真名已经有独立条目时不动 —— 否则会出现两条同名档案
  if (Array.isArray(allCast) && allCast.some(c => c?.name === target)) return null;
  return target;
}

/**
 * 只读地取一条 dyn —— 与 getDyn 的区别是**绝不建空壳**。
 * 用于「查一下另一条档案有没有服装」这类探测，避免探测动作本身污染存档
 * （getDyn 会在缺失时 new 一个空 dyn 写进去）。
 */
export function peekDyn(name) {
  const chat = chatNode(false);
  return chat?.dyn?.[String(name || '').trim()] || null;
}

/**
 * 主角两条档案的服装归一读取（v0.9.41）。
 *
 * 档案库里主角常常有两条：「夜斗」和他自己的宏名条目「<user>」（都指向同一个人）。
 * 服装扫描只写中了其中一条，另一条空着 —— 于是
 *   · 角色档案页点开空的那条显示「(未设置)」
 *   · 出图时两条都是 1boy、外貌雷同，模型看见一条写着「服装=(未记录)」，
 *     就照着那条自由发挥（实测把 dyn 里的 light blue shorts 写成 sweatpants）。
 * 这里做**双向回退**：自己没有就去孪生条目拿。
 */
export function outfitStyleFor(name) {
  const key = String(name || '').trim();
  if (!key) return '';
  const own = peekDyn(key);
  const ownStyle = own ? resolveOutfitStyle(own) : '';
  if (ownStyle) return ownStyle;

  const userName = String(getUserName() || '').trim();
  if (!userName) return '';
  const twin = key === userName ? '<user>' : (key === '<user>' ? userName : '');
  if (!twin) return '';
  const t = peekDyn(twin);
  return t ? resolveOutfitStyle(t) : '';
}

/** 宏名条目（<user> / <persona>）—— 指向主角本人。 */
// v0.9.66：改用 util 的统一识别（原来只认 <user>/<persona>，漏了 {{user}} 与 <bot>）
const MACRO_SELF_RE = /^<(user|persona)>$/i;
/** 全量宏名（含 {{user}} / <bot> 等）—— 清存量与体检用。 */
export function isBadEntryName(n) {
  const t = String(n ?? '').trim();
  if (!t) return true;
  return isMacroName(t);
}

/**
 * 主角的孪生条目：`<user>` ↔ 真名，互为孪生；不是主角的返回 ''。
 * 档案库里主角有两条就是这么来的 —— 一键建档扫 persona 时模型把名字写成 `<user>`，
 * 用户后来又用真名建了一条，两条同一个人并存。
 */
export function twinOfSelf(name) {
  const key = String(name || '').trim();
  const userName = String(getUserName() || '').trim();
  if (!key || !userName) return '';
  if (MACRO_SELF_RE.test(key)) return userName;
  if (key === userName) return '<user>';
  return '';
}

/**
 * 把主角的占位档案（`<user>` / `<persona>`）**合并进真名那条**，然后删掉占位条目。
 *
 * 合并口径（人设主权）：以真名条目为底，**只补空缺字段** —— 已填的外貌一概不动，
 * 避免把用户确认过的人设覆盖掉。服装取有值的（都有则取更晚变更的）。
 *
 * @returns {{ok:boolean, reason?:string, moved?:number, name?:string}}
 */
export function mergeSelfTwins() {
  const userName = String(getUserName() || '').trim();
  if (!userName) return { ok: false, reason: '拿不到主角真名（用户设定名为空），先到酒馆「用户设定管理」里选一个 persona' };
  const node = charNode(false);
  if (!node) return { ok: false, reason: '当前没有角色卡节点' };
  const cast = node.cast || {};
  const macros = Object.keys(cast).filter(k => MACRO_SELF_RE.test(k));
  if (!macros.length) return { ok: false, reason: '没有 <user> 这类占位档案，无需合并' };
  if (!cast[userName]) {
    return { ok: false, reason: `真名「${userName}」的档案不存在 —— 请先用这个准确名字建一条档案，再合并` };
  }

  const chat = chatNode(false);
  let moved = 0;
  for (const m of macros) {
    cast[userName] = mergeEntryFields(cast[userName], cast[m]);
    if (chat?.dyn) {
      if (chat.dyn[m]) chat.dyn[userName] = mergeDynRow(chat.dyn[userName] || emptyDyn(), chat.dyn[m]);
      delete chat.dyn[m];
    }
    delete cast[m];
    moved += 1;
  }
  saveSettings();
  return { ok: true, moved, name: userName };
}

/**
 * 两条同人档案的静态字段合并。
 *
 * ⚠️ **base 永远当底**，filler 只补 base 里**空缺**的字段 —— 不比谁字段多。
 * 曾经按「字段多的那条胜出」实现过，结果把主角的外貌换成了占位条目那一版
 * （眼睛 / 体型 / nlProfile 全变）—— 外貌是人设主权区，插件无权挑一版替换。
 * 真名那条才是用户在用的，它说什么就是什么。
 */
function mergeEntryFields(base, filler) {
  if (!base) return filler || null;
  if (!filler) return base;
  const fields = { ...(base.fields || {}) };
  for (const [k, v] of Object.entries(filler.fields || {})) {
    if (!String(fields[k] || '').trim() && String(v || '').trim()) fields[k] = v;
  }
  return { ...base, fields, label: base.label || filler.label || '' };
}

/** 两条同人档案的动态状态合并：服装取「有值的」；都有则取更晚变更的那条。 */
function mergeDynRow(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  const sa = String(a.outfit?.style || '').trim();
  const sb = String(b.outfit?.style || '').trim();
  let src = a;
  if (sb && (!sa || (Number(b.outfit?.changedAt) || 0) > (Number(a.outfit?.changedAt) || 0))) src = b;
  const merged = clone(a);
  merged.outfit = {
    ...(a.outfit || {}),
    ...(src.outfit || {}),
    style: String(src.outfit?.style || sa || '').trim(),
  };
  for (const [k, v] of Object.entries(b)) {
    if (k === 'outfit') continue;
    if (merged[k] === undefined || merged[k] === null || merged[k] === '') merged[k] = v;
  }
  return merged;
}

export function buildLibrarySnapshot() {
  const cast = listCast();
  const dynMap = new Map(listDyn({ includeSleep: false }).map(x => [x.name, x.dyn]));
  const rawRows = cast.map(({ name, entry, locked, scope }) => ({
    // 别名只作用在快照上：出图时按真名查得到这条档案，dyn 仍按原始 key 取。
    name: macroAliasName(name, cast) || name,
    rawName: name,
    scope,
    locked,
    entry: clone(entry),
    dyn: dynMap.get(name) ? clone(dynMap.get(name)) : null,
  }));

  /**
   * 同一人合并（v0.9.41）：把 `<user>` / `<persona>` 这条归到主角真名那条下面。
   * v0.9.27 靠 macroAliasName 避免了「重命名导致撞名」，但两条**仍然并存** ——
   * 于是提示词里同时出现「<user>(主角) 服装=(未记录)」和「夜斗(男主) 服装=hoodie」，
   * 模型看着两个同性别、外貌雷同的男生，会挑那条「未记录」的去自由发挥。
   * 合并后只剩一条，服装取有值的那个 —— 出图与 UI 两边口径统一。
   */
  const userName = String(getUserName() || '').trim();
  const merged = [];
  const idx = new Map();
  for (const r of rawRows) {
    const key = (userName && MACRO_SELF_RE.test(r.rawName || '')) ? userName : r.name;
    const prev = idx.get(key);
    if (!prev) {
      const row = { ...r, name: key };
      idx.set(key, row);
      merged.push(row);
      continue;
    }
    // 占位条目先到、真名条目后到时**交换** —— 真名那条才是用户在用的，必须当底
    const prevIsMacro = MACRO_SELF_RE.test(prev.rawName || '');
    const curIsMacro = MACRO_SELF_RE.test(r.rawName || '');
    if (prevIsMacro && !curIsMacro) {
      prev.entry = mergeEntryFields(r.entry, prev.entry);
      prev.dyn = mergeDynRow(r.dyn, prev.dyn);
      prev.rawName = r.rawName;
      prev.scope = r.scope;
    } else {
      prev.entry = mergeEntryFields(prev.entry, r.entry);
      prev.dyn = mergeDynRow(prev.dyn, r.dyn);
    }
    prev.locked = prev.locked || r.locked;
  }
  return merged;
}

/* ============ 楼层结果（图片） ============ */

/**
 * 从某个出图位里摘掉一张图（记录层面）。
 * 全部摘完则该出图位也一并移除。图库页删单张时用。
 */
export function removeResultImage(mesId, swipeId, position, url) {
  const rec = getFloorRecord(mesId, swipeId);
  const pos = String(position || '').toUpperCase();
  const target = rec.results.find(r => String(r.position || '').toUpperCase() === pos);
  if (!target) return false;

  let changed = false;

  if (Array.isArray(target.images)) {
    const before = target.images.length;
    target.images = target.images.filter(im => (im.localUrl || im.url) !== url && im.url !== url);
    if (target.images.length !== before) changed = true;
  }

  /**
   * v0.9.52：**旧版本（history[]）也要清**。
   * 图库现在会显示旧版本（listVersionHistory），但删除只清现任 ——
   * 结果是"图删了、文件删了、记录还在"，下一次 paint 它又冒出来，且已破图。
   * 只要 URL 命中就一并清掉；整条 history 的图被清空就移除该条目（不留空壳）。
   */
  if (Array.isArray(target.history) && target.history.length) {
    const before = target.history.length;
    target.history = target.history
      .map(hv => ({
        ...hv,
        images: (Array.isArray(hv?.images) ? hv.images : [])
          .filter(im => (im?.localUrl || im?.url) !== url && im?.url !== url),
      }))
      .filter(hv => (hv.images || []).length > 0);
    if (target.history.length !== before) changed = true;
  }

  if (!changed) return false;

  if (!Array.isArray(target.images) || !target.images.length) {
    return removeFloorResult(mesId, swipeId, position);
  }

  saveSettings();
  return true;
}

/**
 * 一次性清理：把存档里 `type:'temp'` 的 ComfyUI 临时预览图摘掉（v0.9.100）。
 *
 * ★ 为什么需要清洗历史数据（用户 2026-10-19 报「图库里有好几张原旧图被裁掉了」）：
 *   v0.9.100 之前 `pollHistory` 把 `/history` outputs 里**所有**节点的图都收下，
 *   包括 `PreviewImage` 写的 temp —— 高清放大 / 分块重绘链会往 temp 里丢局部裁切图
 *   （实测同一位置并存 888×1184 成品 + 876×836/439×432/104×104 三张裁切预览）。
 *   那些条目早已写进 floors，光修收图逻辑不会消失，必须扫一遍老数据。
 *
 * 三条安全线（宁可不删，也不能把图删没）：
 *   ① 只在 `type === 'temp'` 上下手，`output` 一张不动；
 *   ② 某个出图位/历史版本**全是 temp**（说明这个工作流只挂了 PreviewImage）
 *      → 原样保留，否则整位变空、正文图位直接消失；
 *   ③ 跑过就落 marker，绝不在用户后续手动调整后再扫第二遍。
 *
 * @returns {{removed:number, scanned:number, skipped:boolean}}
 */
export function cleanupTempImages() {
  const MARK = 'v0.9.100';
  const r = root();
  if (r.global?.tempImgCleanup === MARK) return { removed: 0, scanned: 0, skipped: true };

  let removed = 0;
  let scanned = 0;
  const trim = (arr) => {
    if (!Array.isArray(arr) || !arr.length) return arr;
    scanned += arr.length;
    const keep = arr.filter(im => String(im?.type || 'output') !== 'temp');
    if (!keep.length) return arr;                 // ② 全是 temp → 别清空
    removed += arr.length - keep.length;
    return keep;
  };

  for (const rec of Object.values(r.floors || {})) {
    for (const res of (rec?.results || [])) {
      if (!res) continue;
      if (Array.isArray(res.images)) res.images = trim(res.images);
      for (const h of (res.history || [])) {
        if (h && Array.isArray(h.images)) h.images = trim(h.images);
      }
    }
  }

  r.global.tempImgCleanup = MARK;
  saveSettings();
  if (removed) {
    info(STAGE.INIT, `已清理 ${removed} 张 ComfyUI 临时预览图（type=temp），图库不再显示这些被裁切的副图`);
  }
  return { removed, scanned, skipped: false };
}

/**
 * 列出当前聊天里所有已出的图（图库页数据源）。
 * @returns {Array<{mesId:number, swipeId:number, position:string, prompt:string, nl:string,
 *                  url:string, localUrl:string, path:string, at:number, archived:boolean}>}
 */
export function listChatImages() {
  const r = root();
  const chatId = getChatId();
  const out = [];

  for (const [key, rec] of Object.entries(r.floors || {})) {
    const parts = String(key).split('|');
    if (parts[0] !== chatId) continue;
    const mesId = Number(parts[1]);
    const swipeId = Number(parts[2]);

    for (const res of rec.results || []) {
      const list = Array.isArray(res?.images) ? res.images : [];
      for (const im of list) {
        const url = im.localUrl || im.url;
        if (!url) continue;
        out.push({
          mesId,
          swipeId,
          position: res.position || '',
          prompt: res.prompt || '',
          nl: res.nl || '',
          url,
          localUrl: im.localUrl || '',
          path: im.path || '',
          at: res.at || 0,
          archived: !!im.localUrl,
        });
      }
    }
  }

  return out.sort((a, b) => (b.at - a.at) || (b.mesId - a.mesId));
}

/**
 * ★ v0.9.52 近期已出过的图 —— 「让模型看见上一张」的数据源。
 *
 * 这条通道存在的理由（自检报告 P1-A，全项目单点收益最高的改动）：
 *   出词模型**从来没见过自己上一张写了什么** —— `cleanBody` 用 HL_TAG_RE 把
 *   `<hl_image>` 整块删掉，`promptFull` 又只写进存档给 UI 看、从不读回。
 *   于是同一段剧情连出两楼时，模型没有任何依据判断"这张和刚才那张是不是一回事"，
 *   结果就是两张图**几乎一模一样**（用户抱怨过的「重复出图」），
 *   或者反过来 —— 上一张已经脱掉的衣服在这一张莫名长回来。
 *
 *   而 settings.js 里甚至写了 4 处「模型手里没有上一张，禁止跨图引用」把它当成
 *   **正式规范** —— 目标和规范互相打架。数据其实一直躺在 floors 里，缺的只是读回来。
 *
 * ⚠️ 只给**摘要**（截断的英文 tag + 中文 nl + 楼层/位置），不给全量 promptFull：
 *    全量会把"上一张的完整写法"整段摆出来，模型最容易照抄（那正是重复出图的成因）。
 *    摘要的作用是让模型知道**画面事实**（谁在哪、穿什么、什么状态），
 *    而不是给它一份可抄的模板。
 *
 * @param {object}   o
 * @param {number}   o.mesId   当前楼（只取 ≤ 它的，避免把"未来"的图泄进去）
 * @param {number}   o.limit   最多几张
 * @param {number}   o.maxTag  单条英文摘要字数上限
 * @param {number}   o.maxNl   单条中文摘要字数上限
 * @returns {Array<{mesId:number, position:string, tag:string, nl:string}>}
 */
/**
 * ★★★ v0.9.122：Layout 记录里的 `prompt` 是**一整行 JSON**。
 *
 * 为什么必须解一手：这段摘要是喂回给**出词模型**看的（「近期已出过的图」），
 * 原来直接 `slice(0, maxTag=300)` 截断 —— 对 layout 来说就是**半截坏 JSON**。
 * 后果两层：① 模型看到残缺结构，容易照着抄一个同样残缺的 layout；
 * ② 真正有用的信息（这页画了谁、在哪格做什么）反而被截掉了，连续性判断失效。
 *
 * 这里把 JSON 还原成一句自然语摘要：`summary.caption + 各格 object 的 caption`。
 * 判据只认「以 { 开头且含 "summary"」—— 普通 tag 串/自然语段一律原样返回，
 * 对 SD / K2 / 纯 prompt MOSS 零影响。
 */
function layoutBrief(raw) {
  const s = String(raw || '').trim();
  if (!s.startsWith('{') || !s.includes('"summary"')) return '';
  try {
    const j = JSON.parse(s);
    const cap = String(j?.summary?.caption || '').trim();
    const panels = (Array.isArray(j?.items) ? j.items : [])
      .filter((it) => it && String(it.label) === 'object')
      .map((it) => String(it.caption || '').trim())
      .filter(Boolean);
    const merged = [cap, ...panels].filter(Boolean).join(' | ');
    return merged ? `（Layout）${merged}`.slice(0, 420) : '';
  } catch {
    return '';
  }
}

export function recentImageBriefs({ mesId = Number.MAX_SAFE_INTEGER, limit = 3, maxTag = 300, maxNl = 120 } = {}) {  const n = Number(limit);
  if (!Number.isFinite(n) || n <= 0) return [];   // 0 / 负数 / NaN = 关掉这条通道
  const chatId = getChatId();
  const r = root();
  const rows = [];
  for (const [key, rec] of Object.entries(r.floors || {})) {
    const parts = String(key).split('|');
    if (parts[0] !== chatId) continue;
    const mId = Number(parts[1]);
    if (!Number.isFinite(mId) || mId > mesId) continue;
    for (const res of rec.results || []) {
      const imgs = Array.isArray(res?.images) ? res.images : [];
      // 失败位没有图，不算"出过的图"（也避免把 error 楼混进连续性判断）
      if (!imgs.length) continue;
      const rawTag = String(res.prompt || '').trim();
      // ★ v0.9.122：Layout 记录先还原成自然语摘要，避免「半截 JSON」喂回给模型
      const tag = layoutBrief(rawTag) || rawTag;
      const nl = String(res.nl || '').trim();
      /**
       * v0.9.101 · K2 的**姿态句**在 `cast` 里，`prompt` 只有末句情绪。
       *
       * 不给这一段，模型根本看不到上一张是什么体位、有没有插入 ——
       * 这是「K2 侧跨楼延续差」的直接原因（用户 2026-10-19 报：前一张有状态、后一张没了）。
       *
       * ★ 只取**最后 6 段**（按中英文逗号切），不整段给：
       *   `cast` 的结构是「角色：<外貌锚点>，<动作/接触/表情句>」—— 动作在尾部，
       *   外貌锚点动辄十几段（long black hair / twin tails / almond eyes / fair skin…）。
       *   整段喂回去 = 把外貌当模板给模型看 → 第二份外貌 → 多手 / 串台
       *   （实测这就是「重复＝实体复制」最典型的触发方式）。
       *   截尾后剩下的正是「在做什么、接触到哪」，外貌段天然留在窗口之外。
       */
      const castRaw = String(res.cast || '');
      const segs = castRaw.split(/[,，]\s*/).map((x) => x.trim()).filter(Boolean);
      const pose = (segs.length > 6 ? `…${segs.slice(-6).join('，')}` : segs.join('，')).slice(-420);
      if (!tag && !nl && !pose) continue;
      rows.push({ mesId: mId, position: String(res.position || ''), tag, nl, pose, at: res.at || 0 });
    }
  }
  rows.sort((a, b) => (b.mesId - a.mesId) || (b.at - a.at));

  // 同一楼同一位置重生成会留下多条（history 之外的现任记录只有一条，但保险起见去重）
  const seen = new Set();
  const out = [];
  for (const it of rows) {
    const k = `${it.mesId}||${it.position}||${it.tag}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({
      mesId: it.mesId,
      position: it.position,
      tag: it.tag.length > maxTag ? `${it.tag.slice(0, maxTag)}…` : it.tag,
      nl: it.nl.length > maxNl ? `${it.nl.slice(0, maxNl)}…` : it.nl,
      pose: it.pose || '',
    });
    if (out.length >= limit) break;
  }
  return out;
}

/* ---------- GAL 画面记忆（跨楼延续） ---------- */

/**
 * ★★★ v0.9.187：GAL 通道的「上一张画了什么」记忆。
 *
 * 为什么不能复用 `floors`：GAL 出图走 `galBridge.generate()` 直接 `submit()`，
 * 拿不到 `messageId`，也不该往楼层里塞图（那张 CG 是 GAL 自己贴进正文的，
 * 记进 floors 会让绘灵的灯箱多出一张重复图）。
 *
 * 但「延续」必须有地方存 —— 用户 2026-11-01 报：「生图提示词不能延续之前楼层状态，
 * 到后面直接变其他不相关画面了，从最初的体位到后面完全变了」。
 * 实测同时刻 `H.floors` 里当前聊天 25 个键**全部 results=0**（settings.json 03:06 刚写过），
 * 所以 `recentImageBriefs()` 恒空 ⇒ `composePrompt` 那条【近期已出过的图】从来没进过 prompt。
 * GAL 侧更是连这条通道都没接。
 *
 * 这里存**最小可判读**的三样：这一张的体位/动作摘要、场景摘要、是第几楼。
 * 不存整份 prompt（模型会照抄 = 重复出图）。
 */
const GAL_SHOT_CAP = 4;

export function pushGalShot({ caption = '', scene = '', mesId = null, at = Date.now() } = {}) {
  const r = root();
  if (!r.galShots || typeof r.galShots !== 'object') r.galShots = {};
  const cid = getChatId();
  const list = Array.isArray(r.galShots[cid]) ? r.galShots[cid] : [];
  list.push({
    caption: String(caption || '').slice(0, 600),
    scene: String(scene || '').slice(0, 200),
    mesId: Number.isFinite(Number(mesId)) ? Number(mesId) : null,
    at,
  });
  r.galShots[cid] = list.slice(-GAL_SHOT_CAP);
  saveSettings();
  return r.galShots[cid];
}

export function recentGalShots(limit = 2) {
  const n = Math.max(0, Number(limit) || 0);
  if (!n) return [];
  const r = root();
  const list = (r.galShots && r.galShots[getChatId()]) || [];
  return list.slice(-n);
}

export function clearGalShots() {
  const r = root();
  if (r.galShots && typeof r.galShots === 'object') {
    delete r.galShots[getChatId()];
    saveSettings();
  }
}

/* ---------- 出图位记录 ---------- */

export function floorKey(mesId, swipeId = 0) {
  return `${getChatId()}|${mesId}|${swipeId}`;
}

export function getFloorRecord(mesId, swipeId = 0) {
  const r = root();
  const k = floorKey(mesId, swipeId);
  if (!r.floors[k]) r.floors[k] = { results: [] };
  if (!Array.isArray(r.floors[k].results)) r.floors[k].results = [];
  return r.floors[k];
}

/** 单个出图位保留的历史版本上限（旧图在灯箱里可左右翻看）。 */
const HISTORY_CAP = 10;

export function saveFloorResult(mesId, swipeId, result) {
  const rec = getFloorRecord(mesId, swipeId);
  const idx = rec.results.findIndex(x => x.hash === result.hash);
  if (idx >= 0) {
    const prev = rec.results[idx];
    // 历史画廊：出过图的位被重新生成时，旧图进 history（新图原地替换显示）。
    // 只在真的有旧图且新图不同时才记，失败重试/空结果不产生垃圾历史。
    const hadImgs = Array.isArray(prev.images) && prev.images.length
      && (prev.images[0].localUrl || prev.images[0].url);
    const newImgs = Array.isArray(result.images) ? result.images : [];
    const changed = hadImgs && newImgs.length
      && (newImgs[0].localUrl || newImgs[0].url) !== (prev.images[0].localUrl || prev.images[0].url);
    if (changed) {
      const history = [
        ...(Array.isArray(prev.history) ? prev.history : []),
        { images: prev.images, prompt: prev.prompt, nl: prev.nl, at: prev.at },
      ].slice(-HISTORY_CAP);
      rec.results[idx] = { ...prev, ...result, history };
    } else {
      rec.results[idx] = { ...prev, ...result };
    }
  } else {
    rec.results.push(result);
  }
  saveSettings();
  return rec;
}

/**
 * 删掉某个出图位的结果记录（只动记录，不动正文里的出图位）。
 * 用于「删除这张图」——正文段落结构要保留，否则重出图时位置对不上。
 */
export function removeFloorResult(mesId, swipeId, position) {
  const rec = getFloorRecord(mesId, swipeId);
  const pos = String(position || '').toUpperCase();
  const before = rec.results.length;
  rec.results = rec.results.filter(r => String(r.position || '').toUpperCase() !== pos);
  if (rec.results.length !== before) {
    saveSettings();
    return true;
  }
  return false;
}

/**
 * 记录某张图的显示宽度（%）。
 * 存在 result 上而不是 config 里 —— 这样每张图各自记住自己的大小，
 * 且随聊天存档一起走（换设备/重开酒馆都还在）。
 * scale = 0 表示恢复成全局默认。
 */
export function setResultScale(mesId, swipeId, position, scale) {
  const rec = getFloorRecord(mesId, swipeId);
  const pos = String(position || '').toUpperCase();
  const hit = rec.results.find(r => String(r.position || '').toUpperCase() === pos);
  if (!hit) return false;
  const n = Number(scale);
  if (!Number.isFinite(n) || n <= 0) delete hit.scale;
  else hit.scale = Math.max(20, Math.min(200, Math.round(n)));
  saveSettings();
  return true;
}

/**
 * 记录某个出图位当前**显示**的是画廊里第几张（0 = 最新图，1+ = 历史）。
 * 对齐 SD 助手：消息内左右切换后选中的那张随聊天存档走，
 * 重新打开聊天/重进酒馆后还停在用户选的那张上。
 * sel = 0 表示"看最新的"，直接删掉字段不留垃圾。
 */
export function setResultIndex(mesId, swipeId, position, sel) {
  const rec = getFloorRecord(mesId, swipeId);
  const pos = String(position || '').toUpperCase();
  const hit = rec.results.find(r => String(r.position || '').toUpperCase() === pos);
  if (!hit) return false;
  const n = Number(sel);
  if (!Number.isFinite(n) || n <= 0) delete hit.sel;
  else hit.sel = Math.round(n);
  saveSettings();
  return true;
}

/**
 * 只改某条结果的提示词/中文描述，**不动图、不进历史**。
 * 「编辑提示词 → ✅确认修改」用：改完下次重生图直接用新词，
 * 不强迫用户为了改几个字重新烧一次图。
 * 传空串/null 表示清掉该字段。@returns {boolean} 是否找到并修改
 */
export function setResultPrompt(mesId, swipeId, position, patch = {}) {
  const rec = getFloorRecord(mesId, swipeId);
  const pos = String(position || '').toUpperCase();
  const hit = rec.results.find(r => String(r.position || '').toUpperCase() === pos);
  if (!hit) return false;
  if (patch.prompt != null) {
    const p = String(patch.prompt).trim();
    if (p) hit.prompt = p; else delete hit.prompt;
  }
  if (patch.nl != null) {
    const n = String(patch.nl).trim();
    if (n) hit.nl = n; else delete hit.nl;
  }
  // v0.9.24：K2 三明治的字段也允许编辑 —— 场景段 / 人物段（空串 = 删除该段，
  // composePrompt 对空段自动跳过）。人物段只影响这张图的重生成，档案库不受影响。
  if (patch.scene != null) {
    const v = String(patch.scene).trim();
    if (v) hit.scene = v; else delete hit.scene;
  }
  if (patch.cast != null) {
    const v = String(patch.cast).trim();
    const before = String(hit.cast || '').trim();
    if (v) hit.cast = v; else delete hit.cast;
    /**
     * v0.9.53：用户在提示词编辑器里手改过人物段 → 打标记。
     * 之后点「重新生成」不会再用档案覆盖它（那是用户自己定的稿），
     * 想强制回档案取值的走图上菜单的「按档案重新生成」。
     */
    if (v !== before) hit.castEdited = true;
  }
  /**
   * v0.9.53：最终提示词缓存。改了文本就必须跟着改（或删掉）——
   * 留着旧的会让「查看提示词」显示上一版，与「复制提示词」对不上。
   */
  if (patch.promptFull !== undefined) {
    const v = String(patch.promptFull || '').trim();
    if (v) hit.promptFull = v; else delete hit.promptFull;
  }
  /**
   * v0.9.53：单张段落编排（编辑器里调的顺序，只覆盖这一张；不填 = 跟随全局）。
   * 传 null / 空对象 = 清除覆盖，回到全局编排。
   */
  if (patch.promptLayout !== undefined) {
    const pl = patch.promptLayout;
    if (pl && Array.isArray(pl.order) && pl.order.length) hit.promptLayout = pl;
    else delete hit.promptLayout;
  }
  saveSettings();
  return true;
}

export function clearFloorResults(mesId, swipeId = 0) {
  const r = root();
  delete r.floors[floorKey(mesId, swipeId)];
  saveSettings();
}

/**
 * 清掉楼层里的孤儿出图记录 —— 正文里已经没有对应 tag 块的旧结果。
 *
 * 为什么必须有这步：楼层重新生成/编辑后，旧正文连同旧块一起消失，
 * 但记录还留着。旧记录一旦参与渲染配对，旧图就会抢占新槽位
 * （实测：天台楼层显示上一轮的体育馆图）。渲染层已改为身份配对、
 * 孤儿不参与显示；这里再把存储也清干净，双保险。
 *
 * @param {number} mesId
 * @param {number} swipeId
 * @param {Set<string>} keepHashes 正文现存块的 hash 集合（hash 为空的记录保留不误删）
 * @returns {number} 清掉的数量
 */
export function pruneFloorResultsByHash(mesId, swipeId, keepHashes) {
  const rec = getFloorRecord(mesId, swipeId);
  const before = rec.results.length;
  const keep = keepHashes instanceof Set ? keepHashes : new Set(keepHashes || []);
  rec.results = rec.results.filter(r => !r?.hash || keep.has(r.hash));
  const removed = before - rec.results.length;
  if (removed) saveSettings();
  return removed;
}

/** 清掉旧聊天的楼层记录，避免无限膨胀。 */
export function pruneFloors(maxChats = 30) {
  const r = root();
  const keys = Object.keys(r.floors || {});
  if (keys.length <= maxChats * 200) return 0;
  const byTs = keys.map(k => ({ k, ts: r.floors[k]?.results?.slice(-1)[0]?.at || 0 }))
    .sort((a, b) => b.ts - a.ts);
  const keep = new Set(byTs.slice(0, maxChats * 200).map(x => x.k));
  let removed = 0;
  for (const k of keys) {
    if (!keep.has(k)) { delete r.floors[k]; removed += 1; }
  }
  if (removed) saveSettings();
  return removed;
}

/**
 * 跨聊天版 removeResultImage —— 历史生图页删别的聊天的图用。
 * floorKey() 固定用当前聊天 ID，直接复用会清错聊天里的同名记录。
 */
export function removeResultImageChat(chatId, mesId, swipeId, position, url) {
  const r = root();
  const k = `${String(chatId)}|${Number(mesId)}|${Number(swipeId) || 0}`;
  const rec = r.floors[k];
  if (!rec) return false;
  const pos = String(position || '').toUpperCase();
  const target = (rec.results || []).find(rr => String(rr.position || '').toUpperCase() === pos);
  if (!target) return false;

  let changed = false;
  if (Array.isArray(target.images)) {
    const before = target.images.length;
    target.images = target.images.filter(im => (im.localUrl || im.url) !== url && im.url !== url);
    if (target.images.length !== before) changed = true;
  }
  // v0.9.52：同 removeResultImage —— 旧版本（history[]）一并清，否则删了又冒出来
  if (Array.isArray(target.history) && target.history.length) {
    const before = target.history.length;
    target.history = target.history
      .map(hv => ({
        ...hv,
        images: (Array.isArray(hv?.images) ? hv.images : [])
          .filter(im => (im?.localUrl || im?.url) !== url && im?.url !== url),
      }))
      .filter(hv => (hv.images || []).length > 0);
    if (target.history.length !== before) changed = true;
  }
  if (!changed) return false;

  if (!Array.isArray(target.images) || !target.images.length) {
    rec.results = rec.results.filter(rr => String(rr.position || '').toUpperCase() !== pos);
  }
  saveSettings();
  return true;
}

/* ============ 跨聊天图库 / 全局历史（v0.9.13） ============ */

/**
 * 全局出图历史：append-only，跨聊天共享。
 * 与 floors 的区别：floors 挂在正文出图位下（随正文重建被清理），
 * history 是独立流水 —— 历史生图页和灯箱参数面板的数据源。
 * 每条记一次成功出图的真实参数（prompt/negative/backend/model/loras/seed）。
 */
export const GLOBAL_HISTORY_CAP = 800;

export function pushHistory(entry) {
  const r = root();
  if (!Array.isArray(r.history)) r.history = [];
  const e = {
    url: String(entry.url || ''),
    path: String(entry.path || ''),
    prompt: String(entry.prompt || ''),
    nl: String(entry.nl || ''),
    negative: String(entry.negative || ''),
    backend: String(entry.backend || ''),
    model: String(entry.model || ''),
    loras: Array.isArray(entry.loras) ? entry.loras.slice(0, 12) : [],
    seed: entry.seed ?? '',
    charName: String(entry.charName || ''),
    chatId: String(entry.chatId || ''),
    mesId: Number(entry.mesId) || 0,
    position: String(entry.position || ''),
    at: Number(entry.at) || Date.now(),
  };
  if (!e.url) return false;
  // 同一张图（同 URL）不重复记
  if (r.history.some(h => h.url === e.url)) return false;
  r.history.unshift(e);
  if (r.history.length > GLOBAL_HISTORY_CAP) r.history.length = GLOBAL_HISTORY_CAP;
  saveSettings();
  return true;
}

export function listHistory() {
  const r = root();
  return Array.isArray(r.history) ? r.history.slice() : [];
}

/** 批量删历史记录（按 URL 集合）。@returns {number} 删掉的条数 */
export function removeHistoryByUrls(urls) {
  const r = root();
  if (!Array.isArray(r.history)) return 0;
  const kill = new Set(urls);
  const before = r.history.length;
  r.history = r.history.filter(h => !kill.has(h.url));
  if (r.history.length !== before) saveSettings();
  return before - r.history.length;
}

/** URL → 历史参数（灯箱面板用）。 */
export function historyParamsOf(url) {
  const r = root();
  if (!Array.isArray(r.history)) return null;
  return r.history.find(h => h.url === url) || null;
}

/**
 * 聊天ID → 角色卡名 反查表（从 chars[charName].chats 结构反推）。
 * 一个 chatId 理论上只属于一张卡；同 ID 多卡时取先写的。
 */
function chatCharMap() {
  const r = root();
  const map = {};
  for (const [charName, node] of Object.entries(r.chars || {})) {
    for (const chatId of Object.keys(node?.chats || {})) {
      if (!map[chatId]) map[chatId] = charName;
    }
  }
  // 兜底：当前聊天一定属于当前角色卡（floors 记录不需要 char 节点存在）
  const cur = getChatId();
  if (cur && !map[cur]) map[cur] = getCharName() || '';
  return map;
}

/**
 * 列出**所有聊天**里已出的图（历史生图页数据源）。
 * 与 listChatImages 的差别：不过滤 chatId，每条带 chatId / charName。
 * @returns {Array<{chatId, charName, mesId, swipeId, position, prompt, nl, url, localUrl, path, at, archived}>}
 */
export function listAllImages() {
  const r = root();
  const cmap = chatCharMap();
  const out = [];

  for (const [key, rec] of Object.entries(r.floors || {})) {
    const parts = String(key).split('|');
    const chatId = parts[0];
    const mesId = Number(parts[1]);
    const swipeId = Number(parts[2]);

    for (const res of rec.results || []) {
      const list = Array.isArray(res?.images) ? res.images : [];
      for (const im of list) {
        const url = im.localUrl || im.url;
        if (!url) continue;
        out.push({
          chatId,
          charName: cmap[chatId] || '',
          mesId,
          swipeId,
          position: res.position || '',
          prompt: res.prompt || '',
          nl: res.nl || '',
          url,
          localUrl: im.localUrl || '',
          path: im.path || '',
          at: res.at || 0,
          archived: !!im.localUrl,
        });
      }
    }
  }

  return out.sort((a, b) => (b.at - a.at) || (b.mesId - a.mesId));
}

/**
 * ★ v0.9.52 列出**被替换掉的旧版本图**（出图位 `results[].history[]` 里那些）。
 *
 * 为什么单开一个函数、而不是塞进 listChatImages / listAllImages：
 *   listChatImages 还被**头像选择**（ui/avatar.js）用着 —— 把旧版本混进去，
 *   用户挑头像时会看到同一张图的 N 个旧版本，且分不清哪个是当前在用的。
 *   图库要"能翻到历史"，头像要"只给现任"，两者诉求相反，所以数据源必须分开。
 *
 * ★ 用户病例（2026-09-30）：「图库里只显示最后生成的那张，灯箱里能翻到的历史版本
 *   在图库里一张都看不到，以前还有怎么都没了」。
 *   根因：灯箱（render.js）读 `res.history`，而图库的两个数据源
 *   （listChatImages / listAllImages）**只遍历 `res.images`（现任）**，
 *   重生成时被换下来的旧图就此从图库里消失 —— 文件还在磁盘上（已归档），只是没人读。
 *   用户真实存档实测：126 张旧版本图，其中 69 张连全局流水里都没有，彻底查无此图。
 *
 * @returns {Array<{...,oldVersion:true}>}
 */
export function listVersionHistory() {
  const r = root();
  const cmap = chatCharMap();
  const out = [];
  for (const [key, rec] of Object.entries(r.floors || {})) {
    const parts = String(key).split('|');
    const chatId = parts[0];
    const mesId = Number(parts[1]);
    const swipeId = Number(parts[2]);
    for (const res of rec.results || []) {
      // history 条目只存了 {images, prompt, nl, at} —— position 要回现任记录上取
      for (const hv of (Array.isArray(res?.history) ? res.history : [])) {
        for (const im of (Array.isArray(hv?.images) ? hv.images : [])) {
          const url = im?.localUrl || im?.url;
          if (!url) continue;
          out.push({
            chatId,
            charName: cmap[chatId] || '',
            mesId,
            swipeId,
            position: res.position || '',
            prompt: hv.prompt || res.prompt || '',
            nl: hv.nl || res.nl || '',
            url,
            localUrl: im.localUrl || '',
            path: im.path || '',
            at: hv.at || res.at || 0,
            archived: !!im.localUrl,
            oldVersion: true,   // 图库据此打「旧版本」角标
          });
        }
      }
    }
  }
  return out.sort((a, b) => (b.at - a.at) || (b.mesId - a.mesId));
}

/** 当前有哪些角色卡出过图（范围下拉用）。 */
export function listCharsWithImages() {
  const r = root();
  const cmap = chatCharMap();
  const set = new Set();
  for (const key of Object.keys(r.floors || {})) {
    const n = cmap[key.split('|')[0]];
    if (n) set.add(n);
  }
  for (const h of (r.history || [])) {
    if (h.charName) set.add(h.charName);
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
}

/* ============ 导入 / 导出 ============ */

/** 导出当前角色卡的全部档案（换设备或备份用）。 */
export function exportAll() {
  const r = root();
  const name = getCharName();
  return JSON.stringify({
    kind: 'huilin-profile',
    version: STORE_VERSION,
    charName: name,
    global: clone(r.global),
    char: name ? clone(r.chars[name] || {}) : null,
    exportedAt: new Date().toISOString(),
  }, null, 2);
}

/**
 * 导入档案。默认只补空缺，不覆盖已有条目（保护用户已有设定）。
 */
export function importAll(json, { overwrite = false } = {}) {
  let data;
  try {
    data = typeof json === 'string' ? JSON.parse(json) : json;
  } catch (err) {
    return { ok: false, reason: `JSON 解析失败：${err.message}` };
  }
  if (data?.kind !== 'huilin-profile') return { ok: false, reason: '不是绘灵的档案文件' };

  const r = root();
  let added = 0;
  let skipped = 0;

  for (const [name, e] of Object.entries(data.global?.identity || {})) {
    if (!overwrite && r.global.identity[name]) { skipped += 1; continue; }
    r.global.identity[name] = { ...e, locked: true };
    added += 1;
  }

  const charName = data.charName || getCharName();
  if (charName && data.char) {
    if (!r.chars[charName]) r.chars[charName] = { cast: {}, chats: {} };
    const node = r.chars[charName];
    if (!node.cast) node.cast = {};
    for (const [name, e] of Object.entries(data.char.cast || {})) {
      if (!overwrite && node.cast[name]) { skipped += 1; continue; }
      node.cast[name] = e;
      added += 1;
    }
    if (!node.chats) node.chats = {};
    for (const [chatId, chat] of Object.entries(data.char.chats || {})) {
      if (!overwrite && node.chats[chatId]) { skipped += 1; continue; }
      node.chats[chatId] = chat;
      added += 1;
    }
  }

  saveSettings();
  info(STAGE.INIT, `档案导入完成：新增 ${added} 项，跳过 ${skipped} 项`);
  return { ok: true, added, skipped };
}

/** 依赖库存量：档案里有多少角色、多少带外貌锚点。 */
export function stats() {
  const cast = listCast();
  const withAnchor = cast.filter(x => x.entry?.fields?.hair || x.entry?.fields?.eyes).length;
  const chat = chatNode(false);
  const dynCount = chat ? Object.keys(chat.dyn || {}).length + Object.keys(chat.npcs || {}).length : 0;
  return {
    charName: getCharName() || '(未检测到角色卡)',
    chatId: getChatId(),
    castCount: cast.length,
    lockedCount: cast.filter(x => x.locked).length,
    withAnchorCount: withAnchor,
    dynCount,
    round: chat?._round || 0,
    present: chat?.present || [],
  };
}
