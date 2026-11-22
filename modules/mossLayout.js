/**
 * MOSS-Image 多格排版库 + 出图形态指令（v0.9.117）。
 *
 * 依据（全部来自用户自己的工作区，不是我编的）：
 *   `G:/AI/酒馆AI/生图工作流/MOSS酒馆生图模型/交接/方法论_多格漫画做法说明.md`
 *   ① 「不写格子类型，模型不会随机发挥，它会均分」→ 想不单调必须**显式给出比例**。
 *   ② 比例词按控制力分四档（equal panels/grid 最弱，borderless/inset 特殊）。
 *   ③ 景别组合推荐顺序：空镜/远景 → 中景 → 局部特写 → 大格近景，**第 4 格给最大面积**。
 *   ④ 「一页里至少有一个格子的面积是另一个的两倍以上」。
 *   ⑤ 服装：**全局写基准，Panel 只写变化量**；品类名全篇只出现一次，
 *      Panel 里只用部位词（collar / hem / sleeve / cuff / waistband / lapel）。
 *   → 第 ⑤ 条与「每格把服装写全」正好相反。之前 spec 里写成后者的版本会直接
 *     触发文档 §二·六 描述的串味（同一 prompt 内服装描述被**平均**成模糊中间态）。
 *
 * 这个模块只做三件事：
 *   1. `MOSS_LAYOUTS` —— 排版预设表（方位词全部照抄文档里的清单，不自创）；
 *   2. `pickMossLayout()` —— 按设置挑一个排版（随机模式每次换，避免整本一个版式）；
 *   3. `buildMossDirective()` —— 生成本次出图的形态指令，拼在模版 protocol 之后。
 *
 * ★ 为什么指令放在「拼提示词时注入」而不是写进模版文本：
 *   模版文本是用户可编辑的（人设主权区），而这个形态/排版是**每次出图都可能变**的配置。
 *   写死进模版 = 用户改一次排版就得动模版；而且旧模版迁移时会与新配置打架。
 *   注入式还能保证「设置里选了什么」与「模型收到什么」永远是同一份数据。
 */

/**
 * 排版预设。
 * - `decl`：分格声明里的后半句（`divided into …` + 这句），格数词由它自带。
 * - `slots[].pos`：**照抄**进 `Panel N, <pos>: …` 的方位词（文档清单里有的才写）。
 * - `slots[].rect`：归一化矩形 `[x0, y0, x1, y1]`（0~1，左上原点）。
 *   ★ v0.9.126 新增：JSON Layout 版靠它算真实像素框。**每个预设必须有自己的一套**，
 *   以前三个三格预设共用一个默认分支，等于把「随机换版式」做成了「永远等分三条」。
 *   规则：相邻格留 0.03~0.04 的 gutter；同一页里**最大格的面积至少是最小格的两倍**。
 * - `slots[].shot`：这一格该承担什么镜头 —— 给模型的选择依据，不是给它抄的词。
 */
import { ENH_TEXT } from './mossEnhanceText.js';
import { estimateResolution } from './resSelector.js';

export const MOSS_LAYOUTS = [
  {
    key: 'p3-top2-bottom1',
    name: '三格 · 上两小 + 下大',
    panels: 3,
    decl: 'divided into three panels of unequal size',
    slots: [
      { pos: 'narrow strip at the top left', rect: [0, 0, 0.48, 0.26], shot: '空镜或远景（建立空间，人不入画或很小）' },
      { pos: 'top right', rect: [0.52, 0, 1, 0.26], shot: '中景（人物动作）' },
      { pos: 'wide panel filling the bottom half', rect: [0, 0.30, 1, 1], shot: '大格近景（情绪落点，放台词）' },
    ],
  },
  {
    /**
     * ★ v0.9.136：参考漫画排版（用户 2026-10-23 给的 14 张参考图里 00036 / 00242 的结构）。
     *
     * 与 `p3-top2-bottom1` 的区别只在**每格承担什么**：
     *   旧的那套是「上排先立场面（远景/中景）+ 下大格情绪落点」；
     *   这套是「上排两个**特写**对撞 + 下大格**全身**」——
     *   特写与全身的面积差 + 景别差，才是参考图那种冲击力的来源（实测 `f2`）。
     * 两者都留着让用户选，不互相替代。
     */
    key: 'p3-cuts-top2-bottom1',
    name: '三格 · 上两特写 + 下大格（参考漫画）',
    panels: 3,
    decl: 'divided into three panels of unequal size',
    slots: [
      /**
       * ★ 方位词必须用**文档里出现过的说法**（`moss-0117-test` 的 I2 守这条）：
       *   自创方位词模型不认，等于没写。所以这里全用现成词，
       *   「这一格画全身」放进 `shot`（那是给模型看的用途说明，不是方位词）。
       */
      { pos: 'small square panel at the top left', rect: [0, 0, 0.46, 0.28], shot: '表情特写（脸 / 眼 / 嘴，情绪落点）' },
      { pos: 'top right', rect: [0.48, 0, 1, 0.28], shot: '局部特写（手 / 腰 / 衣角，与左格不同部位）' },
      { pos: 'wide panel filling the bottom half', rect: [0, 0.30, 1, 1], shot: '大格全身（人物动作，撑满整格，头与膝可以顶到格边）' },
    ],
  },
  {
    key: 'p3-top1-bottom2',
    name: '三格 · 上大 + 下两小',
    panels: 3,
    decl: 'divided into three panels of unequal size',
    slots: [
      { pos: 'wide panel spanning the top half', rect: [0, 0, 1, 0.56], shot: '中景（人物动作，先立住场面）' },
      { pos: 'bottom left', rect: [0, 0.60, 0.48, 1], shot: '局部特写（手 / 眼睛 / 衣角）' },
      { pos: 'bottom right', rect: [0.52, 0.60, 1, 1], shot: '近景（情绪落点，放台词）' },
    ],
  },
  {
    key: 'p3-strip',
    name: '三格 · 上中下三条',
    panels: 3,
    decl: 'divided into three horizontal panels',
    slots: [
      { pos: 'narrow horizontal strip across the top', rect: [0, 0, 1, 0.18], shot: '远景 / 空镜（交代时间地点）' },
      { pos: 'middle band across the page', rect: [0, 0.22, 1, 0.58], shot: '中景（人物动作）' },
      { pos: 'wide panel filling the bottom half', rect: [0, 0.62, 1, 1], shot: '近景（情绪落点，放台词）' },
    ],
  },
  {
    key: 'p4-unequal',
    name: '四格 · 上扁条 + 中二 + 下大',
    panels: 4,
    decl: 'divided into four panels of unequal size',
    slots: [
      { pos: 'a narrow horizontal strip across the top', rect: [0, 0, 1, 0.16], shot: '远景 / 空镜（建立空间）' },
      { pos: 'middle left', rect: [0, 0.20, 0.48, 0.52], shot: '中景（人物动作）' },
      { pos: 'middle right', rect: [0.52, 0.20, 1, 0.52], shot: '局部特写（手 / 眼睛 / 衣角）' },
      { pos: 'a large panel spanning the full width across the bottom half', rect: [0, 0.56, 1, 1], shot: '近景（情绪落点，放台词）' },
    ],
  },
  {
    key: 'p4-left2-right1',
    name: '四格 · 左列三小 + 右侧一大',
    panels: 4,
    decl: 'divided into four panels of unequal size',
    /**
     * ★ v0.9.136：左列 42% → 36%、主格起点 46% → 38%。
     *
     * 依据（用户 2026-10-23 给的参考图 00494 / 00543 实测）：参考图的**格差悬殊**，
     * 辅格列只占 33~36%，主格 60~66%。旧比例 42/54 接近等分，主格不够压场
     * —— 这正是用户说的「丰富但冲击力差点意思」。结构没动，只拉大了差。
     */
    slots: [
      { pos: 'small square panel at the top left', rect: [0, 0, 0.36, 0.29], shot: '远景 / 空镜' },
      { pos: 'middle left', rect: [0, 0.31, 0.36, 0.60], shot: '中景（人物动作）' },
      { pos: 'small panel at the bottom left', rect: [0, 0.62, 0.36, 1], shot: '局部特写（手 / 眼睛 / 衣角）' },
      { pos: 'tall vertical panel on the right side', rect: [0.38, 0, 1, 1], shot: '近景双人（情绪落点，放台词）' },
    ],
  },
  {
    key: 'p2-top-bottom',
    name: '两格 · 上小 + 下大',
    panels: 2,
    decl: 'divided into two panels of unequal size',
    slots: [
      { pos: 'narrow strip across the top', rect: [0, 0, 1, 0.28], shot: '远景 / 空镜（交代时间地点）' },
      { pos: 'large panel filling the bottom two thirds', rect: [0, 0.32, 1, 1], shot: '近景（主体动作与台词）' },
    ],
  },
];

/** 设置项取值：形态三档。 */
export const MOSS_MODES = ['auto', 'multi', 'single'];

/**
 * 剧情模式（v0.9.127）。
 *
 * 为什么要单独一档，而不是复用「成人画面优先」开关：
 *   官方《MOSS二次元提示词模板_sfw版》只有 **SFW 语境**（§… 明文
 *   「Keep all content within a normal SFW illustration context」/「不擅自加入性化姿势」）。
 *   插件要同时服务日常剧情与成人剧情，就必须有**两个方向**的明确指令：
 *   · `sfw`  —— 正文再激烈也只画到临界之前（服装完整、不写性行为）；
 *   · `nsfw` —— 成人情节按成人画（写实器官与动作，不退回擦边）。
 *   只有一个「成人优先」开关时，SFW 剧情会被它误伤（这正是用户报的
 *   「现有的缺少这方面」）。两档都关不掉 = 模型自己猜 = 时好时坏。
 *
 * ★ `auto` 保留旧行为（看 `adultPosePriority`），老用户升级后一个字都不变。
 */
export const MOSS_NSFW_MODES = ['auto', 'sfw', 'nsfw'];

/** 归一化剧情模式（非法值 → auto）。 */
export function normalizeMossNsfw(v) {
  return MOSS_NSFW_MODES.includes(v) ? v : 'auto';
}

/**
 * 本次要不要注入「成人画面写法」。
 *
 * ★★★ 三档的**决策只能有一个入口**：0.9.123 的教训是「同一功能在多口径下各写一遍 if」，
 *   结果 sfw 模式下成人段照旧注入、两套规则互相抵消，模型只挑一条听。
 *
 * @param {string} nsfw  剧情模式（auto/sfw/nsfw）
 * @param {boolean} adultPosePriority  旧的「成人画面优先」开关
 */
/**
 * 本次是不是「用户**显式**选了成人档」。
 *
 * ★ v0.9.131：与 `mossAdultOn` 分开，因为两者语义不同 ——
 *   `mossAdultOn` 决定「注不注入成人段」（auto 档靠旧开关也可能注入）；
 *   本函数决定「注入的成人段里，① 走强制分支还是自判分支」。
 *   混在一个返回值里就会重演「一档两套 if」的老问题。
 */
export function mossAdultForced(nsfw) {
  return normalizeMossNsfw(nsfw) === 'nsfw';
}

export function mossAdultOn(nsfw, adultPosePriority) {
  const m = normalizeMossNsfw(nsfw);
  if (m === 'sfw') return false;
  if (m === 'nsfw') return true;
  return adultPosePriority === true;
}

/** 本次要不要注入「SFW 写法」段（只有显式选了 sfw 才注入）。 */
export function mossSfwOn(nsfw) {
  return normalizeMossNsfw(nsfw) === 'sfw';
}

/** 取排版预设（key 不对就返回 null —— 调用方据此回落「自动」）。 */
export function layoutOf(key) {
  return MOSS_LAYOUTS.find((l) => l.key === key) || null;
}

/**
 * ★★★ v0.9.130：记住**本次实际发给模型的版式**。
 *
 * 病例（用户 2026-10-22「各个格子里不管角度还是内容很多都重复度非常高，完全不像漫画分镜」）：
 *   指令里明明给了不等分的三格坐标（`[0,0,415,300]` / `[449,0,864,300]` / `[0,346,864,1152]`），
 *   模型却回了一个全宽大格 `[0,0,864,645]`；编译层**完全信任**模型给的 bbox，
 *   于是版面不是我选的那套；接着 `padPanelObjects` 用「空白处平分」补了两条全宽横条，
 *   文案还是「同房间、同光、同瞬间、同视角」——三格只能画成三张一样的图。
 *
 * 为什么必须在这里记：`layout=random` 是**每次抽**的。生成提示词时抽一次、
 * 编译时再抽就是另一个版式 —— 「算」与「比」用了两份数据（这条坑本项目踩过多次）。
 * 所以抽中的那一个必须被**同一次请求的后续步骤**读到，而不是再抽一次。
 */
let pickedLayout = null;

/** 本次请求抽中的版式（没抽过 / 单图形态 → null）。 */
export function getPickedLayout() {
  return pickedLayout;
}

/** 测试用：清掉记忆，避免用例之间互相污染。 */
export function resetPickedLayout() {
  pickedLayout = null;
}

/**
 * 按格数取一个**不等分**的兜底版式（拿不到抽中结果时用）。
 * ★ 绝不用「等高三条」：那正是用户报的「等分三块」观感来源。
 */
export function fallbackLayoutFor(n) {
  const want = Math.max(2, Math.min(4, Number(n) || 3));
  return MOSS_LAYOUTS.find((l) => l.panels === want) || MOSS_LAYOUTS[0];
}


/**
 * 归一化设置（容错：旧配置没有 moss 段 / 值不合法）。
 * @returns {{mode:'auto'|'multi'|'single', layout:string}}
 */
export function normalizeMossOptions(opt) {
  const o = opt && typeof opt === 'object' ? opt : {};
  return {
    mode: MOSS_MODES.includes(o.mode) ? o.mode : 'auto',
    layout: typeof o.layout === 'string' && o.layout ? o.layout : 'random',
  };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 画面强化（v0.9.136）—— 只对 JSON Layout 版生效
 *
 * 全部来自 2026-10-23 的真实出图对照（`dev_tmp/ab_ref/`，13 张）。
 * 每一项都**单独验证过有效**才加进来：
 *
 * | 项 | 效果 | 证据 |
 * |---|---|---|
 * | border 每格粗黑框 | 白细缝 → 真黑分隔线 | 写 summary **无效**，写进每格 object 才有效 |
 * | fill 主格撑满 | 人物变近、顶满格 | 写「出框」失败；改「被画幅裁切」立刻见效 |
 * | slant 斜切 | 上排格线变斜线 | summary + 每格边界句，两处一起写 |
 * | sfx 拟声词 | `ドキッ` 黑色粗笔画效果音 | label='text'，实测能画 |
 * | pad 补格 | 缺格补同剧情另一机位，不补空镜 | 空镜格会被邻格人物溢出；四机位实测最丰富 |
 * | pose 体位骨架 | 8 个几何反直觉体位补「头/脸朝向+承重面+进入方向」 | 腿架肩式：不补＝头身倒置 |
 *
 * ★ 六项全部可关。关掉 = 那一段字**一个都不出现**（不是弱化），
 *   所以出问题时可以立刻退回 0.9.135 的行为，不用回滚代码。
 * ══════════════════════════════════════════════════════════════════════════ */

/** 拟声词语言：关 / 日文假名（漫画惯例，实测有效）/ 中文。 */
export const MOSS_SFX_MODES = ['off', 'ja', 'zh'];

export const MOSS_ENHANCE_DEFAULTS = {
  slant: false,
  sfx: 'ja',
  pose: true,
};

/**
 * 归一化「画面强化」设置。
 *
 * ★ 双入参兼容：调用方可能传整个 `cfg.mossJson`（里面有 `enh` 子对象），
 *   也可能直接传 `cfg.mossJson.enh`。两种都要认，否则 UI 写进去的值会被静默忽略。
 * ★ 布尔项**只认真正的 false**：旧配置里没有这个字段（`undefined`）要落到默认值，
 *   不能因为「不是 true」就当成关 —— 那会让老用户升级后全部功能消失。
 *
 * ★★★ v0.9.154：**删掉 border / fill / pad 三项**（用户 2026-10-29 明确要求删面板死项）。
 *   这三项只在旧 `compileLayout` 路径有消费点，漫画页路径一条都不读 —— 留着等于
 *   「面板上有个开了却毫无反应的开关」。这里直接从归一化结果里拿掉，老配置里的
 *   `enh.border/fill/pad` 变成**读不到的死字段**，不会再偷偷生效。
 */
export function normalizeMossEnhance(opt) {
  const o = opt && typeof opt === 'object' ? opt : {};
  const src = o.enh && typeof o.enh === 'object' ? o.enh : o;
  const bool = (k) => (typeof src[k] === 'boolean' ? src[k] : MOSS_ENHANCE_DEFAULTS[k]);
  return {
    slant: bool('slant'),
    sfx: MOSS_SFX_MODES.includes(src.sfx) ? src.sfx : MOSS_ENHANCE_DEFAULTS.sfx,
    pose: bool('pose'),
  };
}

/**
 * 「剧情演完」模式（v0.9.137）。
 *
 * ★ 这是**任务目标**的切换，不是画面强化：
 *   关着 = 从这一楼里**挑**几个最有画面价值的瞬间（旧行为，一页 3 格常只画 1 步剧情）；
 *   开着 = 把这一楼**按时间顺序拆成连续情节点**，一格一步全部画出来。
 *
 * 为什么会需要它（2026-10-27 实测，1689 字 / 29 段的一段正文）：
 *   · 现状 3 张 × 2 格 = 6 格，其中 3 格是空镜 → 只画到 3 个情节点；
 *   · 台词只出 2 句，其中 1 句重复、1 句被截成「……别碰」（原话 7 字，模型自己砍了）；
 *   · 51 字的台词塞进一个气泡，画出来是一团黑。
 *   改成全覆盖后：9 张 × 3 格 = 27 格，全部有人，12 句台词全部画出且竖排可读。
 *
 * `max` 是**单楼最多几张**（实测这段剧情要 9 张）。做成可调是因为张数直接等于 API 成本。
 */
export const MOSS_COVER_DEFAULTS = { on: false, max: 9, panelMin: 0, panelMax: 0 };

export function normalizeMossCover(opt) {
  const o = opt && typeof opt === 'object' ? opt : {};
  const on = o.coverMode === true;
  const raw = Number(o.coverMax);
  const max = Number.isFinite(raw) ? Math.max(2, Math.min(12, Math.round(raw))) : MOSS_COVER_DEFAULTS.max;
  /**
   * ★★★ v0.9.155：每页格数的**随机范围**（用户 2026-10-29 要求）。
   *   · 两个都留空（0）= 不限制，沿用旧口径 `min(段数, 4)`；
   *   · 两个都填 = 每楼在 `[min, max]` 里抽一个格数，整楼统一；
   *   · 只填一个 = 视为不限制（面板上会提示，不做「半开区间」这种猜法）。
   *   版式库只有 2~6 格档，所以夹到 2~6；填反了自动交换。
   */
  const clampPanel = (v) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= 2 ? Math.max(2, Math.min(6, Math.round(n))) : 0;
  };
  let panelMin = clampPanel(o.panelMin);
  let panelMax = clampPanel(o.panelMax);
  if (panelMin && panelMax && panelMin > panelMax) {
    const t = panelMin; panelMin = panelMax; panelMax = t;
  }
  if (!panelMin || !panelMax) { panelMin = 0; panelMax = 0; }
  return { on, max, panelMin, panelMax };
}

/**
 * 「剧情演完」模式的分格纪律。
 *
 * ★ 这里每一条都对应实测出来的一个坏结果，不是凭空写的规范：
 *   · 不加「一格只能放一步」→ 模型会把两步压成一格，剧情照旧缺；
 *   · 不加「每格都必须有人」→ 模型按旧习惯给第一格留空镜，一格一个情节点直接丢；
 *   · 不加「台词超 12 字拆气泡」→ 51 字挤进一个气泡，画出来读不了（a3 那张就是）。
 */
/**
 * 剧情演完模式的**容量**：本楼最多能画多少个情节点。
 *
 * 每张 3~4 格 → 按 4 算（v0.9.138：旧的 3 格/张 少算了「台词必须占格」，
 * 用户实测 34 段要 36 格）。
 * ★ 提示词和测试**共用这一个函数** —— 两边各自写死数字必然漂移。
 */
export function coverCapacity(max) {
  return normalizeMossCover({ coverMax: max }).max * 4;
}

/**
 * ★★★ v0.9.141：本楼要出**几页**、每页**几格** —— 由代码一次算死，只给模型一组数字。
 *
 * ## 为什么必须由代码算（2026-10-28 第一楼真实端到端的病例）
 *
 * 旧文案给模型的是**三条互相抵消的规则**：
 *   ① 本楼约需 47 格（段数 ÷ 3）；
 *   ② 每页 3~6 格 → 约 9 页（上限 9 页）；
 *   ③ **格数不许少于 28 格**。
 *
 * 实测结果（第一楼 139 段 / cap=9）：模型给了 **28 张 × 平均 2.07 格**
 * （2 格×22、1 格×5、3 格×1）。它其实是**完美解题**——
 * 用「多出页数」同时满足了③和（它以为的）①，代价是②被彻底无视；
 * 而代码按 cap 把 28 张截成 9 张 → 正文只演到 P51，后 88 段全丢。
 *
 * ⇒ 根因不是模型笨，是**我们让它做了它不擅长的"总量分配"**。
 *   记忆里那条判据在这里第二次应验：*能让模型「填一个字段」的，就别让它「数一遍」。*
 *   所以把「页数 / 每页格数 / 总格数」三个数**全部由代码算好**，
 *   指令里只出现一组确定的数字，模型没有可权衡的余地。
 *
 * ## 每页格数为什么默认 4
 *
 * 版式库里 4 格版式最多（11 个），2 格 3 个、3 格 4 个、5 格 2 个、6 格 3 个 ——
 * 取 4 才能让「自动配版式」真的有多样性。正文很短（需求 ≤4 格）时退回实际格数，
 * 免得 3 段正文硬撑出 4 格。
 *
 * @param {object} opt  `cfg.mossJson`（只读 coverMode / coverMax）
 * @param {number} paraCount 本楼正文段数
 */
export function mossCoverPlan(opt, paraCount, rand = Math.random, fixedPanels = 0) {
  const cover = normalizeMossCover(opt);
  const cap = cover.max;
  const paraN = Math.max(1, Math.round(Number(paraCount) || 1));
  /**
   * ★★★ v0.9.144：**一格一段**，不再是「三格一段」。
   *
   * 旧的 `paraN / 3` 是"非空行 = 段落"时代的口径 —— 那时 49 行里混着 38 行
   * 卡牌施工数据（写作计划 / charThink / 选项），除以 3 恰好把真实剧情量捞回来。
   * v0.9.144 净化层把施工行剥掉后，`paraN` 直接就是**真剧情段数**，
   * 再除 3 就变成"11 段真剧情只画 4 格"——比原来更糟。
   *
   * 依据（实测，不是估的）：真剧情一段就是"读者要看到的一步"，
   *   · 34 段真剧情 → 需要 36 格（v0.9.138 全覆盖首测）⇒ 1 段 ≈ 1 格；
   *   · 11 段真剧情 → 11 格 → 3 页 × 4 格 = 12 格。
   * 台词"超 12 字要拆"的额外需求靠**一格 2~3 个气泡**消化（实测成立），不另加格。
   */
  const needCells = Math.max(2, paraN);
  /**
   * ★★★ v0.9.155：每页格数三档决策（用户 2026-10-29 要求的「随机范围 + 最大/最小格」）。
   *
   * ① **手选了固定版式** ⇒ 必须用那个版式的格数。否则「版式 3 格 / 指令要 4 格」会让
   *    `pickMangaLayout` 的 `fixed.panels >= want` 落空、回落随机池，等于手选失效。
   * ② **填了范围** ⇒ 整楼在 `[min, max]` 里抽**一个**值。
   *    ⚠ 是整楼一个，不是每页各抽：指令里只能出现**一组**确定数字，
   *    每页格数不同等于让模型逐页数格子 —— 数数正是它最不稳的一项（长期判据）。
   * ③ 都没填 ⇒ 旧口径 `min(段数, 4)`，老配置行为一个字不变。
   *
   * 格数变少不会丢剧情：`pages = ceil(needCells / perPage)` 自动变大，
   * `cells = pages * perPage` 仍然 ≥ needCells —— 也就是用户说的「提高出图数量来解决」。
   */
  const fixedN = Math.round(Number(fixedPanels) || 0);
  let perPage;
  if (fixedN >= 2) {
    perPage = Math.min(fixedN, needCells);
  } else if (cover.panelMin >= 2 && cover.panelMax >= 2) {
    const hi = Math.min(cover.panelMax, needCells);
    const lo = Math.min(cover.panelMin, hi);
    const r = typeof rand === 'function' ? rand() : Math.random();
    const k = Math.max(0, Math.min(0.999999, Number(r) || 0));
    perPage = lo + Math.min(hi - lo, Math.floor(k * (hi - lo + 1)));
  } else {
    perPage = needCells <= 4 ? needCells : 4;
  }
  const pages = Math.max(1, Math.min(cap, Math.ceil(needCells / perPage)));
  const cells = pages * perPage;
  return {
    on: cover.on,
    cap,
    paraN,
    needCells,
    pages,
    perPage,
    cells,
    /** 每格要装几段 —— 正文太长时模型靠"压缩"而不是"加页"来装下。 */
    paraPerCell: Math.max(1, Math.round((paraN / cells) * 10) / 10),
    /** 页数被 coverMax 卡住时为 true：这时**允许**合并，但不许跳步。 */
    truncated: needCells > cells,
  };
}

function storyCoverRules(max) {
  const cap = coverCapacity(max);
  return [
    '',
    '### ★★★ 本楼目标：把这楼剧情**完整演完**（纯漫画 · 全覆盖模式已开）',
    '',
    '下面是这一版和"精选插图"的根本区别，**与上面的任何规则冲突时，以本节为准**：',
    '',
    '- **先把正文按时间顺序切成情节点**，再决定格子。一个情节点 = 一个"读者要看到的一步"：',
    '  动作开始 / 接触发生 / 姿势变化 / 表情转折 / 一句话说出 / 位置移动。',
    '- **一个情节点占一格，一格只放一个情节点。**不许两步压进一格，也不许一步拆成两格。',
    /**
     * ★★★ v0.9.139：**每一格都要重写"这是哪"**。
     *
     * 病例（用户 2026-10-27 看完出图就问：「后面的有组场景都变室内了？」）：
     *   楼 11 九张的场景句逐张退化 ——
     *     01 `the rooftop water tank alcove at midnight, cold pale moonlight`
     *     02 `cold moonlight`（丢了 rooftop）
     *     05 `moonlight`
     *     07 `shadow`
     *     09 （什么都没有）
     *   → 出图从"屋顶水箱旁的夜晚"漂成"室内"。
     * 根因不是模型忘了场景，是**每一步都是独立出图、不写就不继承**（本项目反复踩的坑）。
     * ⇒ 场景三件套（地点 / 光源 / 时间）必须写在**每一格的 object caption 里**，
     *   而且不许用「同上」「same as before」代替 —— 那是给读者看的，不是给画图模型看的。
     */
    '- ★★★ **每一格都要重写"这是哪"：地点 + 光源 + 时间，三项都要有。**',
    '  · 反例（实测漂成室内）：只写 `moonlight`、`shadow`、`dim light` —— 这类词不构成地点，模型会自由发挥。',
    '  · 正例：`Panel 2: the rooftop water tank alcove at midnight, cold moonlight from the left, ...`',
    '  · **每一步都是独立出图，不写就不继承**：不许用「same place as before」「同上」代替。',
    '  · 一整楼在同一场景里时，**每一张的每一格都要把那个场景再写一遍**（重复是必须的，不是啰嗦）。',
    /**
     * ★★★ v0.9.139：**「坐 / 跪 / 躺 / 靠」必须写清坐在什么上**。
     *
     * 病例（用户 2026-10-27 看端到端出图就问：「后面的有组场景都变室内了？」）：
     *   楼 11 九张**全部**画成「坐在白色软床上」——
     *   但审计 59 格：地点命中 62.7% / 时间 69.5% / 光源 66.1%，
     *   场景词一个都没少（`rooftop water-tank alcove at midnight` 每格都在）。
     *   ⇒ 场景**没丢**。丢的是「接触面」：caption 只写 `sits between his legs`、
     *     `sits with knees drawn up` —— 没有承重面，MOSS 就自己补了一张床。
     *     蓝色夜景 + 白色床垫 = 用户眼里的「变室内了」。
     *   对照：楼 5 同一批没这个问题，因为它写了 `the rough concrete floor`。
     * ★ 这条原来**只写在 single（单图）分支**（「承重面与两只手的位置必须写」），
     *   多格这条路径从来没要求过 —— 属于漏写，不是模型能力问题。
     */
    '- ★★★ **写「坐 / 跪 / 躺 / 靠 / 倚」时，必须写明接触面是什么。**',
    '  · 反例（实测画出白床垫）：只写 `sits between his legs`、`kneels low beside her`。',
    '  · 正例：`sits on the bare concrete floor at the base of the water tank`、`knees on the concrete`。',
    '  · 接触面**只能是正文或当前场景里真实存在的东西**（地面 / 水箱底座 / 台阶 / 墙 / 长椅），',
    '    **不许自己添家具** —— 正文是屋顶水泥地，就别出现床、沙发、软垫。',
    '- **格序＝时间序**：Panel 1 是最早发生的那一步，最后一格是这一楼的最后一秒。',
    '  读者顺着 Panel 1 → Panel N 读下来就是完整剧情，中间**不能断档**。',
    '- **每一格都必须有人。**不许空镜、不许纯环境 —— 空掉一格就等于丢掉一个情节点',
    '  （旧版一半的格子是空镜，这是"剧情漏"的头号原因）。',
    '- **剧情优先于景别**：宁可两张用同一个景别，也**不许为了拉开景别而删掉一个情节点**。',
    '  （但"不许删剧情"不等于"可以一直用同一个镜头"—— 镜头怎么换由下一条管。）',
    /**
     * ★★ v0.9.139：**镜头要换，姿势不换**。
     *
     * 病例（用户 2026-10-27 端到端，楼 11 九张）：姿态签名两两比对，
     * `floor11_02` 与 `04` **100% 相同**，`sits` 出现 5 次 —— 9 张里 4 张是同一个坐姿 + 同一个机位。
     * 但正文本来就是「一直从背后抱着坐在水箱边」这一场戏，
     * ⇒ **让模型换姿势是错的**（那是改剧情）。真正该换的是机位与取景范围。
     * ★ 旧规则那句「景别重复是可以的」与这条直接打架，已改写成「剧情优先于景别」的分叉 ——
     *   两条互斥的规则同时在场时，模型只会听一条（本项目反复踩过）。
     */
    '- ★★ **镜头要换，姿势不换。**正文没换姿势时**不许自己换姿势**（那是改剧情）；要换的是机位与取景：',
    '  · 「全身远景」/「半身中景」/「局部特写（脸 / 手 / 腰 / 膝）」三者轮换；',
    '  · 或者换朝向（正面 / 侧面 / 背面 / 过肩）、换视线高度（平视 / 俯拍 / 仰拍）；',
    '  · **相邻两张至少换一处**，不许连着几张都是同一个机位、同一个景别；',
    '  · 一整楼里「全身远景」和「局部特写」都要出现至少一次 —— 别从头到尾都是半身。',
    '- **张力顺序**：动作与战斗 / 接触的格子放**最大的那格**，纯表情格可以放窄格。',
    /**
     * ★★★ v0.9.138：**「格」和「张」必须分开说**。
     *
     * 病例（用户 2026-10-27 端到端，楼 11）：旧文案只写了「格数不够就加图」，
     * 模型抓住"加图"这一个动作 → 一口气给 9 张，**每张只有 1 个 object（1 格）**，
     * 34 段剧情只演了 9 个情节点，其余全丢；而且代码按版式补格 → 每张补出 2 个空镜格。
     * 同一个模型在楼 5 给的是 4 张 × 4 格（完整），差别全在它怎么理解"一格"。
     * ⇒ 必须显式声明：**一张图 = 一页，一页里有 3~4 格**；按情节点先算张数，不是先算格子。
     */
    '- ★★★ **一张图 = 一页漫画 = 3~4 格，不许一张图只放 1 格。**',
    '  · 一张图只写 1 个 object，等于这一页的另外 2~3 个情节点被扔掉，也是白白消耗掉一张图的额度。',
    '  · 正确顺序是**先切格、再分页**：把情节点排成一长串 → 每 3~4 个分成一页 → 页数就是要出的张数。',
    '  · ★ **格数是主指标，张数是它的除法结果**：情节点有几个就需要几格；格数 ÷ 3.5 ≈ 张数。',
    '    例：27 格 → 约 8 张；12 格 → 约 4 张。',
    '    **别把 27 个情节点摊成 27 张单格图，也别压成 9 张 1 格**（两种都是偷懒，剧情都缺）；',
    '    正确做法永远是：**先把格排够，再按每张 3~4 格切页**。',
    '- **格数不够就加图**：本楼最多出 ' + max + ' 张（每张 3~4 格）。',
    '  情节点 ≤ ' + cap + ' 个时**必须一格一步全部画完**；',
    '  真超过 ' + cap + ' 个，才允许把**同一秒的连续动作**合并成一格 —— 但台词一句都不许省。',
    '',
    '### 台词（这一版的重点：说话内容不许漏、不许糊成一团）',
    '',
    '- 正文里引号内的对白，**一句都不许省**。按它在正文里出现的位置，放进**那一刻那一格**的气泡。',
    '- **气泡里一行最多 10 个字**；原话更长就**在同一对引号里换行**（行间写 `\\n` 或直接换行，',
    '  官方 USERGUIDE 推荐用法）—— **不许压缩、不许改写、不许省略、不许拆成两个气泡**。',
    '  实测：51 字塞进一行，出图是一团黑字，读者等于没看到这句（这才是"话好像漏了"的真相）。',
    '- ★★ **长台词的拆法：优先拆到「多格」，别全挤在一格**（用户 2026-10-27 指定）：',
    '  · 前半句放在**说话的人**那一格（脸 + 气泡）；后半句放到**下一格**；',
    '  · **下一格换成「听话的人」的视角 / 反应**（他/她的脸、手、身体反应、眼神），气泡跟着台词走；',
    '  · 好处是一次做两件事：台词完整落下 + 连续几格不会都是同一张脸（换视角是拆台词白送的）。',
    '  · 只有在"拆到下一格会让台词脱离那一刻的动作"时，才退回**同格 2~3 个 `text` 项**。',
    '- 一格可以有 **2~3 个 text 项**，每个气泡 `bbox` 放在说话人头部旁边，**互不重叠、不跨格**。',
    '- 拟声词（如果有）另起一个 text 项，不要和对白挤在同一个框里。',
  ];
}

/**
 * 本次出图用哪个排版。
 *
 * - `auto`   → null（交给模型自己排；文档实测：不指定 = 均分，所以会偏单调）
 * - `random` → 每次随机挑一个（`Math.random`，可在测试里替换）
 * - 具体 key → 固定用它
 *
 * ★ 随机只在**多格**时有意义；单格不调这个函数。
 */
export function pickMossLayout(layout, rand = Math.random, minPanels = 0) {
  const v = String(layout || 'random');
  if (v === 'auto') return null;
  const floorN = Math.max(0, Number(minPanels) || 0);
  if (v === 'random') {
    /**
     * ★★★ v0.9.138：剧情演完模式下**只在 ≥3 格的版式里抽**。
     *
     * 病例（用户 2026-10-27 端到端）：抽到 `p2-top-bottom`（两格），
     * 指令里给模型的就是 2 格坐标表，模型老老实实只写 2 格 →
     * 8 张 × 2 格 = 16 格去演 11708 字的一楼，剧情必然被压扁。
     * 「每张 3~4 格」是这模式的硬要求，2 格版式会把它按死在 2 格。
     */
    const pool = floorN > 0 ? MOSS_LAYOUTS.filter((l) => l.panels >= floorN) : MOSS_LAYOUTS;
    const list = pool.length ? pool : MOSS_LAYOUTS;
    const r = typeof rand === 'function' ? rand() : Math.random();
    const i = Math.min(list.length - 1, Math.max(0, Math.floor(r * list.length)));
    return list[i];
  }
  const fix = layoutOf(v);
  /** 手选了一个不够格数的版式 → 换成同档兜底（只发生在 coverMode，其他口径原样返回）。 */
  if (fix && floorN > 0 && fix.panels < floorN) return fallbackLayoutFor(floorN);
  return fix;
}

/** 中文数字（写进「三格」「四格」这类句子用）。 */
const CN_NUM = ['零', '一', '两', '三', '四', '五', '六'];

/**
 * 生成本次出图的形态指令（拼在模版 protocol 之后送进 system）。
 *
 * @param {object} opt  { mode, layout }
 * @param {Function} [rand] 随机源（测试注入）
 * @returns {string} 空串 = 不加任何指令（非 MOSS 口径不该调它）
 */
export function buildMossDirective(opt, rand = Math.random) {
  const { mode, layout } = normalizeMossOptions(opt);
  const lines = ['', '---', '', '## 本次出图的形态（插件设置，优先于上文；冲突时以本节为准）', ''];

  if (mode === 'single') {
    lines.push(
      '**形态：单图剧情（不分格）**',
      '',
      '- **不要写 `Panel`**，也不要写分格声明 —— 这一张就是一整幅画面。',
      '- 按「主体 → 核心动作 → 机位 → 光线 → 材质 → 色调」写一段完整描述；',
      '  景别 `close-up` / `medium shot` / `wide shot` **只写一个**，承重面与两只手的位置必须写。',
      /**
       * ★★★ v0.9.186：纯 prompt 版同样没有坐标 —— 两个人有接触时也要「画面占位」。
       * 依据见 `buildMossSingleJsonDirective` 里那段（8 体位实拍：没这句会把一个人
       * 复制成两个去占空位、背对画成正面）。
       */
      '  画面里两个人有身体接触 → 再补一句**画面占位**：谁占左半、谁占右半，',
      '  两人的髋在画面中心附近相遇（`her body takes the left half and his the right half,',
      '  their hips meeting near the centre of the picture`）。代替坐标，只写这两件事。',
      '- **正文里有对白 → 必须把原话写进气泡**：`A speech bubble beside her reads "原话"`。',
      '  台词**原样照抄正文**，不要改写、不要翻译成英文；**一行不超过 10 个字**，',
    '  原话更长就在同一对引号里换行（`\\n`），**不许删字**。',
      '  正文这一楼没有对白 → 不要写气泡（别为了凑气泡编台词）。',
    );
    return lines.join('\n');
  }

  if (mode === 'auto') {
    lines.push(
      '**形态：自动（你按正文自己判断）**',
      '',
      '- 正文出现「几个连续瞬间」（对视 → 靠近 → 接触）→ 拆成 **2~3 格**，用 `Panel N, <方位词>:`；',
      '- 只有一个瞬间值得画 → **单图剧情**，不分格。',
      '- **正文里有对白 → 必须把原话写进气泡**（`A speech bubble reads "原话"`），',
      '  原样照抄、中文、一行不超过 10 个字（原话更长就在同一对引号里换行，不许删字）；',
      '  没有对白的格子显式写 `No text in this panel.`。',
      '- 画面里两个人有身体接触 → 补一句**画面占位**（谁占左半、谁占右半，髋在画面中心相遇），',
      '  代替坐标，见本节末尾「画面占位」那条。',
    );
    const fixed = pickMossLayout(layout, rand);
    if (fixed) {
      lines.push('', '**若你决定拆格，必须用这张版式**（方位词照抄，不要自己换）：', '');
      lines.push(...layoutTable(fixed));
      lines.push(...layoutRules());
    }
    return lines.join('\n');
  }

  /* mode === 'multi' */
  const lay = pickMossLayout(layout, rand);
  if (!lay) {
    // 排版选了「自动」：只给出格数与不等分的硬要求，方位交给模型
    lines.push(
      '**形态：多格漫画**',
      '',
      '- 每张都拆格（2~4 格）。第一句写分格声明：',
      '  `A vertical Japanese manga page divided into N panels of unequal size by white gutters with thin black borders, clean anime line art.`',
      '- **各格面积必须不等**：不写比例模型会均分成整齐网格（实测）。',
      '  至少有一格的面积是另一格的两倍以上，最大的那格放情绪落点与台词。',
    );
    lines.push(...layoutRules());
    return lines.join('\n');
  }

  lines.push(
    `**形态：多格漫画 · ${CN_NUM[lay.panels] || lay.panels}格 · ${lay.name.replace(/^\S+ · /, '')}**`,
    '',
    '第一句照抄（只改格数词）：',
    `\`A vertical Japanese manga page ${lay.decl} by white gutters with thin black borders, clean anime line art.\``,
    '',
  );
  lines.push(...layoutTable(lay));
  lines.push(...layoutRules());
  return lines.join('\n');
}

/** 排版表：每格的方位（照抄）+ 该格该承担什么镜头。 */
function layoutTable(lay) {
  const rows = lay.slots.map((s, i) => `| Panel ${i + 1} | \`${s.pos}\` | ${s.shot} |`);
  return [
    '| 格 | 方位词（照抄进 `Panel N, …:`） | 这一格承担什么 |',
    '|---|---|---|',
    ...rows,
  ];
}

/** 所有形态共用的排版/台词纪律。 */
function layoutRules() {
  return [
    '',
    '- **方位词一律照抄上表**，不要自创（`left area` / `upper region` 这类模型不认）。',
    '- **格与格的景别必须拉开**：空镜/远景 → 中景 → 局部特写 → 大格近景。',
    '  连续几格都用中景，画出来就是几张一样的图。',
    '- **每格都要有台词，或显式写 `No text in this panel.`**；至少一格是台词格。',
    '  台词**原样照抄正文里的原话**：中文、写在引号里、**一行不超过 10 个字**，',
    '  原话更长就在同一对引号里换行（不许删字、不许拆成两个气泡），不要改写、不要译成英文。',
    '- 正文的瞬间不够填满格子时，用**同一场景的空镜 / 已有动作的局部特写**补位，**不许编新剧情**。',
    '- ★★ **每格提到人物都要带「身份锚点」**（发色 + 一件最能区分身份的衣服，5~8 词），',
    '  跨格**逐字复用同一短语**。光写 `the girl` 在两人以上会指向「最近提到的那个」——',
    '  实测把女主的动作画到了男主身上（v0.9.120 前这里写的是「只在第一格写全一次」，与实测相反，已改）。',
    '  **完整外貌（瞳色 / 脸型 / 体型）不要写进格内** —— 会挤掉景别（手部特写被画成半身像）。',
    '  **服装品类名（cardigan / dress / hoodie / skirt…）全篇只在人物段出现一次**，',
    '  格内的变化用部位词挂在动作上，重复写会被平均成模糊中间态（实测串味）。',
    '  某一格的衣着变化用部位词写：`collar` / `hem` / `sleeve` / `cuff` / `waistband` / `lapel`，',
    '  并且**挂在动作上**（`her raised arm pulls the collar slightly open`），不要写成款式描述。',
    '- 多格之间是**同一场景的连续瞬间**：同一地点、同一光线、同一套衣服。',
  ];
}

/* ══════════════════════════════════════════════════════════════════════════
 * JSON Layout 版的形态指令（v0.9.121）
 *
 * ★ 这里全用**单引号字符串 + 拼接**，不用模板字符串。
 *   教训：模板字符串里要显示反引号就得写 `\``，而用脚本批量改这个文件时，
 *   `\`` 与「模板定界符」几乎无法靠正则区分 —— 实测把文件改坏两次
 *   （先是 `\`` 被替换成裸反引号导致语法错，再是反向替换把定界符也吃掉）。
 *   这几段文本里反引号很多（教模型写 `bbox` / `layout.width`），
 *   改用单引号字符串后，反引号就是普通字符，零转义。
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * 归一化矩形 → 当次画布像素框（左上原点 + 整数）。
 * `rect` 是 `[x0, y0, x1, y1]`，取值 0~1，与画布尺寸无关 ——
 * 这样版式的**形状**和**像素**彻底分开：换分辨率不会改版式。
 */
function rectToBox(r, W, H) {
  return [
    Math.round(Number(r[0]) * W),
    Math.round(Number(r[1]) * H),
    Math.round(Number(r[2]) * W),
    Math.round(Number(r[3]) * H),
  ];
}

/**
 * 没有预设时的兜底分区（`mode=multi` + `layout=auto`）。
 * ★ 必须**不等分**：等高三条正是用户 2026-10-22 报的「排版被固定、等分三块」的观感来源。
 */
const FALLBACK_SLOTS = [
  { rect: [0, 0, 1, 0.18], shot: '远景 / 空镜（交代时间地点）' },
  { rect: [0, 0.22, 1, 0.60], shot: '中景（人物动作）' },
  { rect: [0, 0.64, 1, 1], shot: '近景（情绪落点，放台词）' },
];

/**
 * 按排版预设给出各格的坐标分区（用当次画布算成具体像素）。
 *
 * ★★★ v0.9.126：这里以前是**三条 `if` + 一个默认分支**，结果是：
 *   `p3-top2-bottom1` / `p3-top1-bottom2` / `p3-strip` 三个预设**全部落到同一个默认分支**，
 *   发出去的都是 `0~0.32H / 0.34~0.65H / 0.67~1H` —— 三条**几乎等高**的横条。
 *   用户选「随机 · 每张换一种」，抽到三格时拿到的永远是同一套等分坐标，观感就是
 *   「排版被固定了、画面全被等分三块」。四格的两个预设也是同样情形（共用一套）。
 *   ⇒ 现在每个 slot 自带 `rect`，几何**跟着预设走**，随机才是真的换版式。
 */
function jsonZone(lay, W, H) {
  const slots = lay && Array.isArray(lay.slots) && lay.slots.length ? lay.slots : FALLBACK_SLOTS;
  return slots.map((s, i) => {
    const b = rectToBox(s.rect, W, H);
    return 'Panel ' + (i + 1) + ': [' + b.join(', ') + ']' + (s.shot ? '　← ' + s.shot : '');
  });
}

/* ══════════════════════════════════════════════════════════════════════════
 * 画面强化的**指令段**（v0.9.136）
 *
 * 只有两项需要写进指令，因为它们要**语义判断**：
 *   · 拟声词 —— 什么画面该有声音，只有模型知道
 *   · 补格换机位 —— 该换成哪个角度，要跟着动作走
 *
 * 另外三项（粗黑边框 / 斜切 / 主格撑满）**不写指令**，由 `mossJsonLayout.js`
 * 的 `applyVisualEnhance()` 在编译层强制落地 —— 那是确定性的字符串操作，
 * 交给模型反而多一层不确定性（实测「边框写 summary」就完全无效）。
 *
 * ★ 全部用单引号字符串 + 拼接（同下面的约定：这几段里有反引号，见 341 行的说明）。
 * ══════════════════════════════════════════════════════════════════════════ */

/* ══════════════════════════════════════════════════════════════════════════
 * v0.9.140：**漫画页模式**（内容与坐标彻底分离）
 *
 * 用户 2026-10-27 看完参考实现后问：
 *   「如果插件里自带事先备好大量分镜排版是不是就能完美解决之前的痛点了。
 *     让 MOSS 漫画变成真正的漫画。」
 *
 * 关键判断：参考实现之所以稳定，**不是提示词写得好**，是它把「格框坐标」
 * 交给了人（拖框）/ 程序（回填），图片模型只回答「这个框里画什么」。
 * 而本插件原来让 chat 模型同时判断剧情 + 分镜 + 格数 + 坐标，实测连跑三次
 * 格数是 28 / 10 / 25 —— 那是**任务本身**在为难它，不是它不聪明。
 *
 * ⇒ 这一版把坐标从模型手里彻底拿走：
 *     · 模型只输出**内容**（每格背景 / 画什么 / 谁说哪句）
 *     · 格框来自 `mossMangaLayouts.js` 的版式库，按它给的条数查表
 *     · 格内槽位（背景层 / 主体层 / 气泡位）由 `mossMangaPage.js` 按比例算
 *
 * ★ 这里必须**点名作废旧任务词**（本项目反复踩：两条互斥的规则同时在场时
 *   模型只会挑一条听）。旧的 `items` / `bbox` / 「一格一个 object」话术
 *   一个字都不能留在这段里。
 * ══════════════════════════════════════════════════════════════════════════ */
/**
 * ★★★ v0.9.145 · 漫画页「对话格必须两人同框」这条规则的单点定义。
 *
 * 抽成常量是为了让测试**引用同一个字符串**，而不是抄一份副本 ——
 * 抄副本的话，哪天改了文案，`!includes(旧文案)` 这类反向断言会恒真（永远绿），
 * 这是踩过的坑（见项目记忆「反向断言不许引用已改名的旧文案」）。
 *
 * 规则的实测依据写在上面的注释里，不在这里重复。
 */
export const MANGA_CAST_DIALOGUE_RULE = '**对话格：`cast` 里必须既有说话人，也有「他在对谁说」的那个人。**';

function mangaPageRules(cover, plan, narrator) {
  const cap = Math.max(2, cover.max);
  const who = String(narrator || '').trim();
  /**
   * ★★★ v0.9.141：页数与每页格数**只在这一处给**，而且是一组定死的数字。
   *   旧版在这里写「一页 3~6 个 panels」「本楼最多 N 页」，任务节又写「约 47 格 / 不少于 28 格」
   *   —— 两节互相抵消，模型挑最省力的组合（28 张 × 2 格）。详见 `mossCoverPlan` 注释。
   *   `plan` 缺省（单测直接调本函数）时给一个安全兜底，不影响生产路径。
   */
  const p = plan && plan.pages ? plan
    : { pages: cap, perPage: 4, cells: cap * 4, paraN: 0, paraPerCell: 3, truncated: false };
  return [
    '',
    '### ★★★ 本楼目标：把这一楼剧情排成**真正的漫画页**（内容与坐标分离）',
    '',
    '**本节优先级最高。上文凡是教你怎么写坐标、怎么写 items 的段落，全部作废，不要再照做：**',
    '  · 「每格一个 object 项」「`items` 数组」「`bbox`」「坐标逐字照抄」',
    '  · 「`layout.width` / `layout.height`」「按上表分区建 object」',
    '  ⇒ 这一版**你一个字都不写坐标，也不写 items**。',
    '',
    '坐标由插件的**版式库**算：你这一页给几个 `panels`，插件就配一张对应格数的漫画版式',
    '（格子不等高、格间有白缝、可能带一个跨格通高人物）。你只管内容。',
    '',
    '## 输出结构：一个 image = 一页漫画',
    '',
    '```json',
    '{"position":"3","layout":{',
    '  "page":"one sentence: who is where doing what",',
    '  "narrator":"正文第一人称「我」是档案库里的谁（整楼没有第一人称就留空字符串）",',
    '  "mood":"dialogue|action|intimate|scenery（这一页是什么戏，决定格子形状，见下）",',
    '  "mainBeat":2,',
    '  "figure":{"name":"角色名","pose":"english pose / facing","expression":"english expression"},',
    '  "panels":[',
    '    {"beat":"8字以内，这一步发生了什么",',
    '     "shot":"face|upper|detail|response|action|full|environment",',
    '     "bg":"english: place + light source + time",',
    '     "subject":"english: what is visible inside this panel only",',
    '     "cast":["这一格里看得见的人（角色名）"],',
    '     "lines":["这一格说的原话"],',
    '     "speaker":"说话人角色名，或 out-of-frame"}',
    '  ]}}',
    '```',
    '',
    '### ★★★ 先回答一次 `narrator`，后面就不用再管「我」是谁',
    '',
    who
      ? '本卡已经在设置里指定：**正文第一人称的「我」= `' + who + '`**。'
        + '`cast` / `speaker` / `figure.name` 里**直接写 `' + who + '`**，不要写「我」。'
      : [
        '- 正文用第一人称叙述时，「我」在档案库里必有一个对应的人。**在这里写他的准确名字**',
        '  （看档案清单里哪个人的设定跟「我」吻合：性别、年龄、身份、正文提到的外貌）。',
        '- ⚠️ **不许把 `narrator` 写成「我」** —— 那不是名字，插件查不到人，等于没答。',
        '  实测病例（2026-10-28 第一楼）：10 页全部回 `"我"`，于是整整 9 页主角没有外貌。',
        '- 实在判断不出 → 写 `""`，**不要瞎填一个人的名字**（填错等于给他人的脸和衣服）。',
      ].join('\n'),
    '- 整楼不是第一人称 → 写 `""`。',
    '',
    '### ★★★ 每格必须写 `cast`：这一格里看得见谁',
    '',
    '- `cast` = 这一格**画面里出现的人**，写角色名数组；这一格没有人（纯环境格）就写 `[]`。',
    '- 服饰与外貌是**按 `cast` 注入**的 —— `cast` 漏了谁，那一格就没有这个人正确的脸和衣服。',
    '  · ⚠️ **`cast` 不许留空来省事**：只要这一格画面里有人，就必须点名。',
    '    实测病例（2026-10-28 第一楼）：16 格写了 `cast: []`，其中好几格 `subject` 明明写着',
    '    `a cluster of female students surge toward the door` —— 那些人一个都没注入外貌，',
    '    出图就是随便画的陌生人。',
    '  · ⚠️ **`speaker` 不能代替 `cast`**：内心独白 / 画外音 / 旁白的格子，',
    '    `speaker` 写 `out-of-frame`，但**画面上明明有人**，那个人的名字必须写进 `cast`。',
    '    实测病例：9 页里 20 多格的 `speaker` 都是 `out-of-frame`，',
    '    于是这些格一个外貌都没注入 —— 主角在第一页是黑发、第二页变成另一个人。',
    '  · ★★★ ' + MANGA_CAST_DIALOGUE_RULE,
    '    只把说话人写进 `cast`，那一格就只剩说话人一个 —— 台词变成对着空气自说自话。',
    '    实测病例（2026-10-28 屋顶 3 页）：12 格 `cast` 全只填了说话的女主，',
    '    于是 12 格全是女主单人特写、男主 **0 次出现**；',
    '    同一批提示词只把听话人补进第 3 格的 `cast`，那一格立刻变成两人对话镜头。',
    '    · 判据：这一格有 `lines` 且 `speaker` 不是 `out-of-frame` → **`cast` 长度至少 2**。',
    '    · 例外（这些情况听话人确实不在画面里，`cast` 可以只有 1 人）：',
    '      打电话 / 对讲机、回忆、隔门隔墙、以及正文明确写的「她一个人自言自语」。',
    '    · 听话人不必画全：`subject` 里写清「只看得见他的局部」就行，例如',
    '      `only his shoulder and the back of his head intrude at the right edge, out of focus`。',
    '      **但名字必须进 `cast`** —— 否则插件不会给他那张脸和那套衣服。',
    '',
    '### ★★★ 页数与格数：照抄，不许自己算',
    '',
    '> **本楼出 ' + p.pages + ' 页。每页正好 ' + p.perPage + ' 个 panels。全楼合计 ' + p.cells + ' 格。**',
    '> 这三个数字是插件按你的正文密度算好的，**你不许改、不许省页、不许加页**。',
    '',
    '- `images` 数组就写 **' + p.pages + ' 个元素**，一个元素 = 一页 = ' + p.perPage + ' 个 panels。',
    '- ⚠️ **一页写 ' + (p.perPage - 1) + ' 格或 1 格都算错**：格数不足时版式库会把你的页面降级成 2 格版式，',
    '  那一页的另外 ' + (p.perPage - 2) + ' 个情节点就直接消失了。',
    p.truncated
      ? '- 正文比 ' + p.cells + ' 格长，**每格约装 ' + p.paraPerCell + ' 段**：从这几段里挑最能代表的那一步来画。'
        + '装不下时**压缩**（一格覆盖更多段），绝不许靠加页或加格解决。'
      : '- 每格约装 ' + p.paraPerCell + ' 段正文。',
    '- panels 的**顺序就是阅读顺序**：第 1 个是最早发生的那一步，最后一个是这一页的最后一秒。',
    '',
    '### 这一页是什么戏：在每页顶层写一个 `mood`',
    '',
    '- 四选一，**必须写**（这一页的主要性质，不是每个格子的性质）：',
    '  · `dialogue` —— 对话戏：两人说话、表情来回、信息交换；',
    '  · `action` —— 动作戏：走位、推门、搬东西、追逐、起身、转身；',
    '  · `intimate` —— 亲密戏：拥抱、依偎、贴近、身体接触、暧昧气氛，**两个人要同框**；',
    '  · `scenery` —— 氛围戏：环境交代、空镜、时间流逝，没有人或只有局部。',
    '- 插件按它挑**格子形状**：`intimate`/`action` 优先给大格（两个人能同时进一个框），',
    '  `dialogue` 优先给均匀的方格，`scenery` 优先给横带。',
    '- 判据看**这一页读者最想看清什么**：想看清两个人的位置关系 → `intimate`/`action`；',
    '  想看清谁在说话 → `dialogue`；想让人喘口气 → `scenery`。',
    '  ⚠️ 填错不会报错，但格子会切成不适合的形状（例如把拥抱页填成 `dialogue`，',
    '  可能拿到四条横带，两个人的身体被切成上下一截）。',
    '',
    '### 这一页最重的是第几条：在每页顶层写一个 `mainBeat`',
    '',
    '- 一页 ' + p.perPage + ' 格，其中**只有一条**是读者最该看清的：身体接触、冲突转折、表情变了的那一步。',
    '- 填它的**序号**：`1` = 第 1 个 panel，`' + p.perPage + '` = 最后一个。**只填一个数字**。',
    '- 插件会把这一条放进**本页最大的那个格子**。填错不会报错，但重头戏会被塞进一个小格 ——',
    '  实际症状就是「关键动作看不清、气氛没了」。',
    '- 这一页确实分不出主次（均匀的你一言我一语、纯环境交代）→ 填 `0`。',
    '',
    '## 每格怎么写（这一节是成败关键）',
    '',
    '- `shot` 六选一，**同一页里必须至少换两次**：',
    '  · `face` 脸部近景（眼睛 / 表情为主）—— `subject` 只写头颈，别写"她的上衣/裙子"，',
    '    这一格要把镜头钉在脸上（写衣服会把画面拉成半身）；',
    '  · `detail` 局部特写（手 / 衣料 / 接触点 / 道具，**不出现脸**）；',
    '    ★★★ **必须写清这是谁的哪个部位**：`only her bare legs below the hem of the navy pleated skirt`，',
    '    **不许**只写 `only her legs` —— 实测那样会被画成**路人的腿**（这一格没有任何"属于她"的线索）。',
    '    同时这个人**必须进 `cast`**（她不在 `cast` 里，这一格就没有她的裙色/肤色）。',
    '  · `environment` 环境空镜（**可以没有人**，漫画里用来喘口气）；',
    '  · `response` 反应镜头（听话的人的表情）；',
    '  · `upper` 半身中景；`action` 全身带动作；',
    '  · `full` 全身远景 —— ★ **人撑满格**：`subject` 写 "her whole body from head to feet fills the panel"，',
    '    **不要**写"远景 / 远处 / 站在远处的她"（实测会画成一个小人站在空场子里）。',
    '- ★★★ `bg` **只写背景，三项都要有：地点 + 光源 + 时间**，不许写人物、不许添正文没有的家具。',
    '  · 反例（实测漂成室内）：只写 `moonlight` / `shadow` / `dim light` —— 这类词不构成地点。',
    '  · 正例：`the rooftop water-tank alcove at midnight, cold moonlight from the left, weathered grey concrete`。',
    '  · **每一格都要重写一遍**：每一步都是独立出图，不写就不继承，不许写「同上 / same as before」。',
    '- ★★★ `subject` **只写这一格里看得见的那部分，并且写明"画到哪里为止"**：',
    '  · 正例：`only her head and the upper part of her hood are visible, hands and body stay outside the frame`；',
    '  · 环境格写 `no person in this panel`；',
    '  · ★ 写「坐 / 跪 / 躺 / 靠 / 倚」时必须写明**接触面**（`sits on the bar concrete floor`）——',
    '    实测只写 `sits between his legs` 会让画面自己补一张床，屋顶夜景变成室内。',
    '  · ★★ **叙述者「我」要写成他在档案库里的名字**：正文第一人称写的「我」就是主角，',
    '    `subject` 里照抄「我 / my / me」插件查不到这个人，那一格**不会注入任何外貌与服装**',
    '    （实测：第一楼 4 格因此变成「谁都不是」的陌生人）。',
    '- `lines`：这一格说的原话，**一字不改**（不压缩、不改写、不翻译、不省略）。没有就写 `[]`。',
    '  · 一句台词 = **一个** `lines` 条目，**不要自己拆成两条**；插件会自动在停顿处插换行，',
    '    让长句在**同一个气泡里**排成两行 —— 所以**你不许为了"放得下"删字**。',
    '  · 一句台词尽量占一格（一问一答的节奏），说不完的交给下一格。',
    '- `speaker` 写说话人的角色名；说话人不在画面里就写 `out-of-frame`（画外音）。',
    '',
    '## 通高人物 `figure`（整页只有一个）',
    '',
    '- ★★★ **每一页都要写 `figure`**，别管这一页最终抽到带不带人物栏的版式 ——',
    '  版式库里哪些带栏由插件决定，**没带栏时它会自动忽略你写的 figure**。',
    '  （旧文案写「只有当前版式带人物栏时才画」，模型于是干脆不写：实测 28 页 **0 次**填 figure，',
    '   所有带通高人物栏的版式全废。）',
    '- 写的是**这一页那个贯穿上下的大人物**：姿态、朝向、表情。',
    '- `pose` 必须承接正文，**不许自己编新动作**；`expression` 写这一页的情绪落点。',
    '- ⚠️ **不写发型 / 发色 / 服装 / 体型 / 妆容** —— 那些由程序按角色档案机械注入，你写了会打架。',
    '- ★★★ **格子的 `subject` 里不要写这个通高人物本人** —— 他已经整页都在了。',
    '  · 写了会怎样（实测）：那一格会被插件判定成「他本人」而**只留环境**（不给他人物层），',
    '    于是这一格的剧情等于没画，只剩一句画外音气泡。',
    '  · 他的动作写进 `figure.pose`；同一个人在格子里只允许以「局部」形式被提到时，请改写 `beat` 用另一个人。',
    '  · 正例：他在她身后 → `figure.pose` 写 `standing right behind her, one hand on the door frame`，',
    '    格子的 `subject` 写 `her shoulders drawn together, only her upper body is visible`。',
    '',
    '## 人物外观：你一个字都不写',
    '',
    '- 每格 `subject` 里只写**动作与取景范围**，不写外貌、不写衣服。',
    '- 服装状态、谁的衣服被褪到哪，都由程序按档案与状态机注入。',
  ];
}

function enhanceSfxRules(enh) {
  if (enh.sfx === 'off') {
    return ['', '- **不要写任何拟声词 / 效果音项**（这一页只允许对白气泡）。'];
  }
  const ja = enh.sfx === 'ja';
  return [
    '',
    '**画面上的拟声词（声音 + 语气与表情的落点）**',
    '- 允许在**一格**里建一个 text 项当拟声词。它有两个用途（用户 2026-10-27 扩宽）：',
    '  ① **环境音与动作力度**：脚步、门、床架作响、水声、衣料摩擦、身体撞到东西；',
    '  ② **语气与生理反应**：心跳、急促喘息、咬唇、吞咽、被碰到时的一颤、惊讶与羞耻的那一下。',
    '  ⇒ 一小格里画不出表情的细微变化时，一个拟声词就把情绪交代掉了 ——',
    '  这是它比堆形容词更管用的地方，也是漫画表现"语气"的常规手段。',
    '- 写法：',
    ja
      ? '  `text` 只写 2~5 个日文假名（**实测能画出的是 `ドキッ`**），不加标点、不翻译、不加引号。'
      : '  `text` 只写 2~4 个汉字（**实测能画出的是 `咚`**），不加标点、不加引号。',
    ja
      ? '  caption 写 "' + ENH_TEXT.sfxJa + '"。'
      : '  caption 写 "' + ENH_TEXT.sfxZh + '"。',
    '- ⚠️ 除上面点名的那个词以外，**别的词没有逐个出图验证过** —— 换词请沿用同一句式与词长上限',
    '  （假名 ≤5 / 汉字 ≤4；太长会糊成一团），不要自创特殊字形、不要加感叹号或省略号。',
    '- 安静的对视、纯过渡格**不加**：拟声词要么推进画面，要么就别加。',
    '- 一张图最多一个；已经有对白气泡的画面**不加**（两种字挤在一处会糊成一团）。',
  ];
}

/**
 * 生成本次出图的**坐标指令**（JSON Layout 版）。
 *
 * 纯 prompt 版靠 `Panel N, 方位词:` 表达排版，模型不认方位词就均分；
 * Layout 版靠**真实像素框**，所以这里必须把当前画布尺寸与分区公式直接给它 ——
 * 「不给尺寸让它自己估」等于让它猜，而官方明确禁止归一化坐标（§12 坑表）。
 *
 * @param {object} opt  { mode, layout }
 * @param {{width:number,height:number}} canvas 实际画布（canvasOf 算出来）
 * @param {Function} [rand]
 */
/**
 * ★★★ v0.9.157：单图 JSON 口径的形态指令（`output: 'json'`）。
 *
 * 为什么不能复用 `buildMossJsonDirective`：
 *   那份指令在 `mode === 'single'` 分支里仍然要求「一个 object 铺满全图 `[0,0,W,H]`」——
 *   也就是**仍然写坐标**。真出图 36 张对照（`dev_tmp/single_multi/_eval.md`）证明：
 *   只要草稿里带着 per-object 的框，6 人以上就会稳定多画一个人；连「每人同一个满幅框」
 *   都会让它按槽位删人。所以单图口径**一条坐标都不给**，位置全部交给文字方位词。
 *
 * 与 spec 的分工：spec 讲「怎么写得对」，本节只讲「**这一次**是什么形态」——
 * 用户随时可能切模版，形态不能写死在 spec 里（那是用户可编辑的文本）。
 */
export function buildMossSingleJsonDirective(opt) {
  const enh = normalizeMossEnhance(opt);
  /**
   * ★★★ v0.9.158：单图「文字台词」开关（默认开）。
   *   关 = 这一张图里**一个文字的框都不出现**（对白气泡 + 拟声词 + 标题全不要）。
   *   ★ 指令层只是省事，**真正生效的是 `singleJsonPrompt` 里那层过滤**（模型不听照样画）。
   */
  const noText = !!opt && opt.textBubble === false;
  const lines = ['', '---', '', '## 本次出图的形态（插件设置，优先于上文；冲突时以本节为准）', ''];
  lines.push(
    '**形态：单图（`canvas = "single"`）**',
    '',
    '- 这一楼只画**一张**图：**不分格、不拼贴、不做同页多画面**。',
    '  正文里哪怕写了几个连续瞬间，也只挑最能说明问题的**那一个**画。',
    '- ★★★ **`items` 里不写任何 `bbox` / 坐标** —— 不写 `[x0, y0, x1, y1]`，不写 `width` / `height`，',
    '  也不写 `bbox_coord_space` / `bbox_format`。**位置一律用文字方位词交代**。',
    '  这一条**优先于规范里任何关于坐标的说法**（本模版不跑坐标编译）。',
    '- 每个画面上看得见的人一个 `character` 项，**同一个人只建一项**（多一项 = 多一个人）。',
    '- 人数只在 `summary.caption` 写一次：`Exactly N people are visible in the frame and nobody else.`',
    /**
     * ★★★ 这条必须写在指令里，不能只靠 spec：v0.9.157 首次真跑正文时 5 张图的 text 项**全是 0**
     *   —— spec §五 讲得再细，模型在「单图」形态下会默认当成肖像画、不建气泡。
     *   多格版的 `buildMossJsonDirective` 里本来就有一句「有对白 → 必须建 text 项」，这里漏了。
     *
     * ★★★ v0.9.158：从「你自己拆」改成「**写全一句，插件来拆**」。
     *
     * 两个理由：
     *   ① 拆句是纯机械操作，模型数数字不可靠 —— 实测「超 N 字就拆」遵守率只有 67%，
     *      且会自己写出 17 字、20 字（`new_P127` 三条 13/17/9 字全超）。
     *   ② 字数上限已从 12 收到 10（依据见 `mossMangaPage.js: BUBBLE_MAX_CHARS`），
     *      让模型逐个数字符更不可能准。代码在 `singleJsonPrompt` 里按标点切，100% 准、一个字不改。
     * ⇒ 指令只负责「把原话原样写进**一个** text 项」，拆分与字数由代码算死。
     */
    ...(noText
      ? [
        '- 🚫 **这一张不画任何文字**：不建 `text` 项，也不要拟声词 / 效果音 / 标题 / 招牌字，',
        '  连空字符串的 text 项都不要 —— 规范里「有对白必须建 text 项」这一张**不适用**。',
      ]
      : [
    '- ★ **正文这一楼有对白 → 必须建 `text` 项**：原话照抄、中文、一字不改；',
    '- **一句台词只建一个 `text` 项**：原话写全，**不许删字、不许自己拆成两项、也不许自己加换行** ——',
    '  插件会在停顿处插换行，让长句在**同一个气泡里**排成两行。**没有对白才不建**。',
        '  漏了台词 = 这一张少了一句剧情，比人物穿错衣服更明显。',
      ]),
    /**
     * ★★★ v0.9.157：指令里也必须压这一条 —— 规范改了但形态指令不压，
     *   模型在「本节优先于上文」的形态节里没看到禁令，会照旧写 `medium shot from a low angle`。
     *   依据：12 张单变量对照（`dev_tmp/shot_frame/`），景别 + 落脚点 + 承重面同时在场时
     *   人物被纵向拉长（腿 ≈ 躯干两倍、躯干压扁）。删景别那一批比例正常。
     */
    '- ★ **`summary.caption` 里不写景别、不写机位**：不要 `close-up` / `medium shot` / `full body` /',
    '  `wide shot`，也不要 `from a low angle` / `from above`。画多大范围由动作自己决定。',
    '- ★ **每个 character 项只写「这个人自己」**：外貌 + 服装 + 一个方位词（`left of centre`）。',
    '  🚫 **不写任何姿态几何**（`kneeling` / `her forearms braced on the mat` / `her back arched down`）——',
    '  姿态全部由下面那句体位句承担。两边都写 = 同一副骨架被画两次（重复＝实体复制）。',
    '  🚫 不写重心（`weight on his back foot`）、不写空着那只手 —— 每多一项就多一个必须可见的点。',
    '  ⚠️ 画面里**只有一个人**、没有第二个人可对照时 → 这一个 character 项自己写「一个主动作 + 一个承重面」。',
    /**
     * ★★★ v0.9.184：**关系句迁到 `summary.caption`**（用户 2026-11-01 报
     *   「GAL 模式下生图效果不好，剧情里体位和骨架都没了，剧情和画面完全不搭」）。
     *
     *   旧版把「下肢落点 / 朝向」**整个禁掉**（v0.9.157 治拉长的 12 张对照），
     *   于是「谁压着谁、身体在哪接触」在整个提示词里没有任何字段承载 ⇒ 模型只能
     *   把两个人并排摆好，各自完整、互不相干 —— 正文写「腰胯贴紧研磨」，
     *   出图是「他跪在旁边」。同时 `mossAdultBlock` 的体位表（③⑦）还在要求
     *   「direction 写在 acting person 的 character 项里」⇒ 两条规则对着干，
     *   模型只挑后置的那条听（本节自称「优先于上文」）。
     *
     *   解法不是删禁令，而是**分域**：
     *     · character 项 = 单人的点数计费区，保持「一个主动作 + 一个承重面」；
     *     · `summary.caption` = 公共区，**关系句只在这里写一次**。
     *   换个位置，「拉长」那批对照的前提（每人多一个可见点）就不成立了。
     */
    '- ★★★ **有身体接触 → 体位句只写一次，写在 `summary.caption` 里，一句写全四要素**：',
    '  ① **双方承重面与高低**（谁躺 / 谁跪 / 谁站，谁的骨盆更高）；',
    '  ② **主动方骨盆贴在哪**（`his pelvis level with her hips and pressed against her buttocks`）；',
    '  ③ **被动方四肢落点**（`her palms flat on the mat beneath her shoulders, her knees beneath her hips`）；',
    '  ④ **进入 / 接触方向**（`entering her from behind`）。',
    '  ✅ 四要素一个不少，照这个格式写：`She is on all fours with her palms flat on the mat beneath',
    '  her shoulders and her knees on the mat beneath her hips, her back level at hip height. He kneels',
    '  upright behind her with his thighs vertical and his shins flat on the mat, his pelvis level with',
    '  her hips and pressed against her buttocks, both hands closed on her hips, entering her from behind.`',
    '  🚫 `bodies pressed together` / `close to each other` / `intimate` —— 抽象关系词什么都画不出来。',
    /**
     * ★★★ v0.9.186：**画面占位**（用户 2026-11-01 提，8 体位实拍验证过）。
     *
     * 用户原话：「少了 BBOX 的情况在有些情况下会导致坐标混乱」—— 说的是实情。
     * `dev_tmp/pose-bbox-ab.mjs` 三组对照（A 无占位 / B 真 bbox / D 只加这一句），
     * 同一工作流、同一画布、同一 seed（20261101，ComfyUI history 核对过）：
     *   · A：反骑式画成面对面；换 seed 后 cowgirl / reverse-cowgirl **直接画出两个女主**
     *     （一个角色被复制一份去填另一边）—— 两个 seed 都复现；
     *   · B（漫画台式真 bbox）：从不输，背向/侧躺/站立后入明显更「看得清」；
     *   · D（只加这一句，不给任何坐标）：≈ B，且传教士/女牛仔/折刀/肩倒立四组比 B 更自然。
     * ⇒ 缺的不是那两个数字，是「每个人占画面哪一块」这个语义。给了它，模型就不会
     *   把一个人复制成两个去占空位，也不会把背对画成正面。所以**不加坐标，只加一句话**。
     *   （单图形态本来就禁止 bbox，见本节开头；这一条不破那条禁令。）
     */
    '- ★★★ **紧接体位句，补半句「画面占位」** —— 说清两个人**各占画面哪一半**：',
    '  ✅ `In the frame her body takes the left half and his the right half, their hips meeting near the centre of the picture, both bodies staying inside the frame edges.`',
    '  · 左右按实际方位换（她右他左就写 `his the left half and hers the right`）；',
    '    一个躺着、另一个在她上方 → 写 `her body in the lower half and his in the upper half`。',
    '  🚫 不写坐标、不写百分比、不写「各占 50%」—— 只讲**哪一半** + **髋在画面中心附近相遇** + **都在框内**。',
    '  ⚠️ 只在体位句成立时才补；没有第二个人 / 没有接触 → 不要这一句。',
    '  ⚠️ **这一句只写身体关系**：不写服装、不写外貌、不写第三人、不写景别机位；两句以内。',
    '  ⚠️ 正文里**没有**肢体接触（只是并排站、各自做事）→ **不要写这一句**，别为凑关系编接触。',
  );
  if (noText) {
    lines.push('', '- **不要写任何拟声词 / 效果音项**（这一张已关闭全部文字）。');
  } else {
    lines.push(...enhanceSfxRules(enh));
  }
  return lines.join('\n');
}

export function buildMossJsonDirective(opt, canvas, rand = Math.random, plan = null) {
  const { mode, layout } = normalizeMossOptions(opt);
  const enh = normalizeMossEnhance(opt);
  /** v0.9.137：剧情演完模式（只对多格生效 —— 单图没有"格"可分）。 */
  const cover = normalizeMossCover(opt);
  /**
   * ★ v0.9.159：回落值改成**按默认参数现算**。
   * 旧常数 864×1152 是 v0.9.121 用「1e6 当兆像素」手算出来的（ComfyUI 实际用 1024²），
   * 写死它等于把错误的画布尺寸教给模型 —— 模型照这个数写 bbox，编译器再按真实尺寸换算，
   * 整张图就系统性缩放（记忆：「算」与「比」必须是同一份数据）。
   */
  const fallback = estimateResolution();
  const W = Math.round((canvas && canvas.width) || fallback.width);
  const H = Math.round((canvas && canvas.height) || fallback.height);
  const lines = ['', '---', '', '## 本次出图的形态与画布（插件设置，优先于上文；冲突时以本节为准）', ''];

  /**
   * ★★★ v0.9.140：剧情演完 + 多格 → **漫画页模式**，坐标不再交给模型。
   *
   * 必须放在「画布尺寸 + bbox 规则」之前 —— 那一段教的是怎么算坐标，
   * 和漫画页模式（一个坐标都不写）直接冲突，同时在场模型只会挑一条听。
   * `pickedLayout` 是模块级变量（`jsonZone` 用），这里清空避免带上一次的版式。
   */
  if (cover.on && mode === 'multi') {
    pickedLayout = null;
    lines.push(...mangaPageRules(cover, plan, opt && opt.narrator));
    lines.push(...enhanceSfxRules(enh));
    return lines.join('\n');
  }

  lines.push(
    '**画布尺寸：' + W + ' x ' + H + ' 像素**（每次出图可能不同，坐标一律按这一次的数字算）',
    '',
    '- `layout.width` = ' + W + '，`layout.height` = ' + H,
    '- bbox 用 `[x0, y0, x1, y1]`（左上角原点）+ 真实像素整数。',
    '- 合法范围：`0 <= x0 < x1 <= ' + W + '`、`0 <= y0 < y1 <= ' + H + '`。',
    '',
  );

  if (mode === 'single') {
    pickedLayout = null;                 // 单图没有分格版式
    lines.push(
      '**形态：单图剧情（canvas = "single"）**',
      '',
      '- 一个 object 铺满全图：`[0, 0, ' + W + ', ' + H + ']`，caption 写「场景 + 景别 + 光线」。',
      '- **不要**拆格，不要建第二个 object。',
      '- 正文里有对白 → 必须建 text 项，`text` 写**原话**（中文，一个字都不删）。',
      '- 没有对白 → 不建 text 项。',
      '- ★ 画面里两个人有身体接触 → `summary.caption` 里补一句**画面占位**：',
      '  谁占左半、谁占右半，两人的髋在**画面中心附近相遇**，两人都留在框内',
      '  （`her body takes the left half and his the right half, their hips meeting near the centre`）。',
      '  这一句代替「人物坐标」，不要给 character 项写 bbox。',
    );
    lines.push(...enhanceSfxRules(enh));
    return lines.join('\n');
  }

  if (mode === 'auto') {
    const fixed = pickMossLayout(layout, rand, cover.on ? 3 : 0);
    pickedLayout = fixed;                // 模型若决定拆格，用的就是这一套
    lines.push(
      '**形态：自动（你按正文自己判断）**',
      '',
      '- 正文有「几个连续瞬间」（对视 → 靠近 → 接触）→ 拆成 2~3 格，**每格一个 object**；',
      '- 只有一个瞬间值得画 → 单图（一个 object 铺满全图）。',
      '- 正文里有对白 → 必须建 text 项（原话中文，一个字都不删）；没有对白的格不建 text 项。',
    );
    if (fixed) {
      lines.push('', '**若你决定拆格，用这个分区（坐标照抄，只改内容）**：', '');
      lines.push(...jsonZone(fixed, W, H));
    }
    return lines.join('\n');
  }

  /* mode === 'multi' */
  const lay = pickMossLayout(layout, rand, cover.on ? 3 : 0);
  pickedLayout = lay;
  lines.push('**形态：多格漫画（canvas = "multi_panel"）**', '');
  lines.push(
    '**每格一个 object 项，坐标照下面抄**（这些数字已按本次画布算好，直接用）：',
    '',
  );
  lines.push(...jsonZone(lay, W, H));
  lines.push(
    '',
    /**
     * ★★★ v0.9.130：实测模型会**无视**上表自己编坐标（楼 174 P10：指令给三格不等分，
     *   它回了一个全宽大格 `[0, 0, 864, 645]`）→ 版面不是漫画，补格再一搅，三格全一样。
     *   所以这里必须把「抄」写成硬约束，并且直接说明后果。
     */
    '- ★★★ **上面每个 `bbox` 的数字逐字照抄，一个都不许改、不许自己估。**',
    '  你改过的坐标会让整页失去主次，三格挤成一样大 —— 那就不是漫画分镜了。',
    '  **格数也必须完全一致**：上表有几格就建几个 object，少一个整张图的版面就塌了。',
    /**
     * ★★★ v0.9.131：人数**按格算**，不许一刀切。
     *   病历（楼 176 P2）：三格里只有主格有两个 character 项，另外两格是背景格，
     *   却全被写上 `exactly two people in this panel` → 模型被要求在空背景格里也画两个人
     *   → 同一张脸上画两遍 / 凭空多出人体。旧版这句是**硬编码两人**。
     */
    '- 每格 object 的 caption 里写清人数，**按这一格实际会出现的人算**：',
    '  · 该格有 N 个 character 项 → 写 `exactly N people in this panel`（N = 1 / 2 / 3）；',
    cover.on
      ? '  · ★ 本楼是「剧情演完」模式：**每一格都要有人**，不许出现没有 character 项的格 ——'
        + ' 空格等于丢掉一个情节点。这一版没有空镜格，所以任何一格都不许写成「这一格没有人」。'
      : '  · 该格是背景 / 空镜 / 局部特写（没有 character 项）→ 写 `no people in this panel`；',
    '  · 同一个人跨两格出现，**两格各算一次**，不要因为「是同一个人」而减数。',
    '- ★ **各格面积是不相等的，照抄即可**：不要为了「整齐」把它们改成等高或等宽的均分网格',
    '  —— 均分会让整页失去节奏，也和你选定的版式不符。',
    '- **角色框放进它所在那格**，四周留 20~40px 余量（人物不要顶到格边，会被裁）。',
    /**
     * ★ v0.9.125：版式表里每格本来就标了用途（`slots[].shot`：远景/空镜、中景、近景），
     *   但 jsonZone 只把**坐标**发给模型，用途从没传下去 —— 于是模型把两个全身人物
     *   塞进上方 0.3H 的窄格，膝盖以下落到格线外，出图就是断腿（楼 144 P15 实拍）。
     *   这里把「哪格放什么」补成一条硬约束：窄格只放空镜/局部，人物放大格。
     */
    '- ★ **每格只放它装得下的东西**：',
    cover.on
      ? '  · 高度不足画布 1/3 的格（上方窄条）→ 只放**脸 / 手 / 局部特写**，照样要有 character 项；'
        + '写景别时明确「只有这个部位充满画面」（`only her eyes fill the frame`），别写全身动作，会被格线切断。'
      : '  · 高度不足画布 1/3 的格（上方窄条）→ 只放远景 / 空镜 / 局部特写，**不要在该格建 character 项**；',
    '  · 人物动作与台词放**最高**的那一格（通常是下方大格）。',
    '  · 实测：把两个全身人物塞进 0.3H 的窄格，腿会被格线切断 —— 出来就是断肢。',
    '- 气泡框放在说话人头部附近，**不要跨格**。',
    '- 三人以上同框时，object 的 caption 加一句',
    '  `the frame holds exactly N people and closes tightly around them`（N 换成这个数）。',
    '  实测：三个人的格子 8 张里 3 张多画了「上一格刚出现过的角色」，加这句后 3 张全对。',
    cover.on
      ? '- 正文里有对白 → 每句建一个 text 项（原话中文，一个字都不删）；**一句超过 10 字必须拆**：'
        + '优先前半留在说话人那格、后半放进**相邻格**并换成听话人的视角/反应；'
        + '拆到相邻格会让台词脱离那一刻动作时，才改用同格 2~3 个 text 项。'
        + '不准为了"一格一个气泡"去删字。'
      : '- 正文里有对白 → 每句建一个 text 项（原话中文，不删字；一格装不下就拆格）。',
  );
  if (cover.on) lines.push(...storyCoverRules(cover.max));
  lines.push(...enhanceSfxRules(enh));
  return lines.join('\n');
}
