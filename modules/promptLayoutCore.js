/**
 * 段落编排 · 核心层（v0.9.98 从 modules/ui/promptlayout.js 拆出）
 *
 * ★ 为什么拆：编排的判定同时被 **UI（画勾选框）** 和 **consistency.js（拼提示词）** 使用。
 *   以前这些常量长在 UI 模块里，consistency.js 只能自己再写一份 id 字符串
 *   （`id === 'cast'` 这种硬编码散落在拼装逻辑里），**段表一改就两边对不上**。
 *   纯数据与规范化逻辑放这里，UI 只负责画，拼装只负责读。
 *
 * 段的内容全部来自本楼剧情与角色档案 —— 这里只决定「排不排、排第几」。
 */

/**
 * engines：该段在哪些口径下**会有内容**。
 *   ★ 这不是"允许不允许"，而是事实描述 —— SD 口径下没有「中文场景段」这个概念
 *     （场景由模型写进 tag），锚点里已含服装，所以 anchor / scene / costume 恒空。
 *     以前没写这个信息，用户勾了半天没反应，以为开关坏了。
 * cost：关掉这一段的代价（直接显示在面板上，别让人猜）。
 * hard：关掉会丢关键内容 → 面板高亮警告。
 */
export const PROMPT_BLOCKS = [
  {
    id: 'prefix',
    name: '风格前缀',
    src: '全局设置「提示词前缀」—— 画质词 / 风格词',
    engines: ['k2', 'sd'],
    cost: '画质与风格词消失（如 multi view、comic）',
  },
  {
    id: 'count',
    name: '人数词',
    src: '按在场角色的性别自动生成（1boy / 1girl），SD 口径专用',
    engines: ['sd'],
    cost: '不写人数词 —— SD 下模型可能画错人数或多出一人',
    hard: true,
  },
  {
    id: 'anchor',
    name: '写实锚定',
    src: '模版自带的写实锚定句（styled 模版才有）',
    engines: ['k2'],
    cost: '写实质感锚定句消失（styled 模版靠它压画风）',
  },
  {
    id: 'scene',
    name: '场景段',
    src: '本楼剧情的场景：景别 / 光线 / 时间 / 氛围',
    engines: ['k2'],
    cost: '本楼场景消失（只剩人物，背景变成默认）',
  },
  {
    id: 'cast',
    name: '角色段',
    src: '本楼在场角色的外貌（从角色档案机械注入）',
    engines: ['k2', 'sd'],
    cost: '人物外貌与服装全部消失 —— 脸和衣服每张都不一样',
    hard: true,
  },
  {
    id: 'costume',
    name: '服装段',
    src: '本楼剧情时各角色的服装状态（需开启「服装独立成段」，否则附在角色段末尾）',
    engines: ['k2'],
    cost: '服装不再单独成句（回到附在人物段末尾的旧行为）',
  },
  {
    id: 'tag',
    name: '动作段',
    src: '本楼剧情的动作 / 接触点 / 末句情绪（英文）',
    engines: ['k2', 'sd'],
    cost: '本楼动作与接触点消失 —— 只剩一张站着的肖像',
    hard: true,
  },
  {
    id: 'suffix',
    name: '风格后缀',
    src: '全局设置「提示词后缀」',
    engines: ['k2', 'sd'],
    cost: '后缀词消失',
  },
];

/**
 * 出厂顺序 = v0.9.52 及之前拼装时的实际顺序。
 * ★ `count` **故意不在这个表里**：它是 v0.9.98 新增的可选段，
 *   一旦进了补全表，所有老存档的编排会被自动塞进一个 count 段（用户没要过的变化）。
 *   想用它就在面板里勾，勾了才进 order。
 */
export const DEFAULT_PROMPT_ORDER = ['prefix', 'anchor', 'scene', 'cast', 'costume', 'tag', 'suffix'];

const BLOCK_BY_ID = new Map(PROMPT_BLOCKS.map((b) => [b.id, b]));
const IDS = new Set(PROMPT_BLOCKS.map((b) => b.id));

export function blockById(id) {
  return BLOCK_BY_ID.get(id) || null;
}

/** 该段在当前口径下是否可能有内容。 */
export function segmentApplicable(id, engine) {
  const def = BLOCK_BY_ID.get(id);
  if (!def) return false;
  return def.engines.includes(engine === 'k2' ? 'k2' : 'sd');
}

/** 当前口径下恒空的段（面板据此灰掉并说明原因）。 */
export function inapplicableBlocks(engine) {
  return PROMPT_BLOCKS.filter((b) => !segmentApplicable(b.id, engine)).map((b) => b.id);
}

/**
 * 规范化编排对象：脏数据 / 缺段 / 多段都能安全兜住。
 *
 * ★ 为什么要 order + off 两个数组（而不是只靠 order 在不在里面判断开关）：
 *   只用一个数组时，「用户主动关掉某段」和「老存档里压根没有这个新段」长得一模一样
 *   —— 于是补全逻辑会把用户刚关掉的段又塞回来，勾选框点了没反应。
 *   分开之后：off 里 = 用户主动关（永不补回）；两边都没有 = 老数据缺段（补进末尾）。
 *
 * @returns {{order:string[], off:string[], costumeSeparate:boolean}}
 */
export function normalizeLayout(layout) {
  const off = Array.isArray(layout?.off) ? layout.off.filter((id) => IDS.has(id)) : [];
  const raw = Array.isArray(layout?.order) ? layout.order.filter((id) => IDS.has(id)) : [];
  const order = [];
  for (const id of raw) if (!off.includes(id) && !order.includes(id)) order.push(id);
  // 后续版本新增的段：没被显式关闭就补进末尾 —— 老存档不会永远显示不全
  // ★ count 不在 DEFAULT_PROMPT_ORDER 里，所以不会被自动补（见上方注释）
  for (const id of DEFAULT_PROMPT_ORDER) {
    if (!order.includes(id) && !off.includes(id)) order.push(id);
  }
  return { order, off, costumeSeparate: !!layout?.costumeSeparate };
}

/** 判断一段是否参与拼装（在 off 里 / 不在 order 里 = 不输出这一段）。 */
export function layoutHas(layout, id) {
  const n = normalizeLayout(layout);
  return n.order.includes(id) && !n.off.includes(id);
}

/**
 * 用户到底动过编排没有？
 *
 * ★★ v0.9.98 修正的正是这里。旧代码用 `layout.order.length` 判断「配没配编排」，
 *   于是「用户把七段全关掉」（order=[] / off=七段）与「从来没碰过编排」（order=[] / off=[]）
 *   完全同形 —— 前者会被当成后者，**七个 off 一个都不执行**，静默回退到出厂顺序。
 *   实测用户真实配置就是全关状态，他关掉的每一段都"关给空气看了"。
 *
 *   现在用 off 非空也算「配过」，全关会被如实执行（拼装层另有兜底：全空则回退出厂顺序并告警）。
 */
export function layoutConfigured(layout) {
  if (!layout || typeof layout !== 'object') return false;
  const hasOrder = Array.isArray(layout.order) && layout.order.length > 0;
  const hasOff = Array.isArray(layout.off) && layout.off.filter((id) => IDS.has(id)).length > 0;
  return hasOrder || hasOff;
}

/**
 * 拼装时判断「这一段要不要输出」。
 *   配过编排 → 严格按 order/off；没配过 → 一律输出（出厂行为）。
 * ★ 与 layoutHas 的区别：layoutHas 只看 order，会在"没配过"时返回 false（把出厂段全判死）。
 *
 * ★ count 是 v0.9.98 新增的可选段，老存档的 order/off 里都没有它。
 *   若按「必须在 order 里」判定，老存档全关状态下会突然丢人数词（v0.9.97 是输出的）。
 *   所以它用「没被显式关掉就输出」—— 与其它段相反。这是为了**零行为变化**：
 *   用户想定位它才勾进 order，不想用才显式关掉。
 */
export function segmentOn(layout, id) {
  if (!layoutConfigured(layout)) return true;
  const n = normalizeLayout(layout);
  if (id === 'count') return !n.off.includes('count');
  return n.order.includes(id) && !n.off.includes(id);
}
