/**
 * 绘灵 · 口径适配层（Persona Router）
 *
 * ★★★ 为什么需要这个文件（用户 2026-10-21）：
 *   「我发现现在口径多了管理也比较混乱了，特别是角色档案这块。」
 *
 * 排查结论：混乱不在「配置混了」，而在**同一个功能在四个口径下各写一遍 if**。
 * 2026-10-21 一天里连爆三个故障，全是同一个病：
 *   · 预览框只写了 tag/nl        → Layout 下列两栏全空
 *   · 重生成只写了 SD/K2 两档     → MOSS 丢人物段 / Layout 交空提示词
 *   · 档案注入四档各写一遍        → 改一处漏三处
 *
 * 所以这里把「**人物外貌与服装在每种口径下由谁写、写在哪、重生成怎么刷**」
 * 收成一张表。任何入口（预览、重生成、诊断、UI 说明）都查这张表，不再各写 if。
 *
 * ── 四档事实（每条都能在代码里指到出处） ─────────────────────
 *   sd       processImage 里 @展开成锚点串，原地进 tag（`expandRefs`，非自然语分支）
 *   k2       cast 中文人物段 + en 锚点（`k2CastParagraph`）
 *   mossText castEn 英文人物段（`mossCastParagraph` → `injectMossCast`，
 *            插在版面声明之后、第一个 `Panel N` 之前）
 *   mossJson **模型自己写**进每个 character 项的 caption（`mossJsonSpecSection*`）；
 *            插件只做坐标编译，不注入任何人物文本
 *
 * ★ 加新口径时先改这张表，再改实现 —— 顺序反了就会出现「某一档忘了适配」。
 */

import { activeEngine, activeOutput, getActiveTemplate } from './settings.js';

/**
 * @typedef {Object} PersonaPlan
 * @property {string} key           唯一键
 * @property {'sd'|'k2'|'moss'} engine
 * @property {'text'|'layout'} output
 * @property {string} label         给人看的口径名
 * @property {'plugin'|'model'} writer  外貌由谁写
 * @property {string} where         落在哪个字段
 * @property {string} whereText     一句话说明落点
 * @property {'anchors'|'cast'|'castEn'|'reanalyze'} refresh 改档案后怎么刷新
 * @property {string} refreshText
 * @property {boolean} canRefresh   能否「按档案重新生成」（只刷人物，不重分析）
 * @property {string} note          该口径最容易踩的坑
 */

/** @type {PersonaPlan[]} */
export const PERSONA_PLANS = [
  {
    key: 'sd',
    engine: 'sd',
    output: 'text',
    label: 'SD（纯 TAG）',
    writer: 'plugin',
    where: 'tag',
    whereText: '插件把 `@角色名` 展开成锚点串，**原地写进 tag**',
    refresh: 'anchors',
    refreshText: '按存档里的旧锚点串精确定位 → 替换成当前档案值',
    canRefresh: true,
    note: '人物只写名字、**不要写外貌** —— 写了就是重复权重（多手多脚的直接来源）。',
  },
  {
    key: 'k2',
    engine: 'k2',
    output: 'text',
    label: 'K2（中英混合）',
    writer: 'plugin',
    where: 'cast',
    whereText: '插件生成**中文人物段**（含英文锚点），按三明治顺序拼进提示词',
    refresh: 'cast',
    refreshText: '读回人物段里的角色名 → 回档案重取外貌与服装',
    canRefresh: true,
    note: '模型**不要**再写外貌与服装 —— 插件注入了，写第二遍就是重复。',
  },
  {
    key: 'mossText',
    engine: 'moss',
    output: 'text',
    label: 'MOSS · 纯 prompt',
    writer: 'plugin',
    where: 'castEn',
    whereText: '插件生成**英文人物段**，插在版面声明之后、第一个 `Panel N` 之前',
    refresh: 'castEn',
    refreshText: '按存档角色名单重建英文人物段（不依赖旧文本，改档案立刻生效）',
    canRefresh: true,
    note: '人物段必须插在 Panel 序列**之前** —— 插中间会把三格揉成一张。',
  },
  {
    key: 'mossJson',
    engine: 'moss',
    output: 'layout',
    label: 'MOSS · JSON Layout',
    writer: 'model',
    where: 'characterItem',
    whereText: '**模型**按角色档案写进每个 `character` 项的 caption（插件不注入任何人物文本）',
    refresh: 'reanalyze',
    refreshText: '插件无法单点改某一格的外貌 —— 改了档案要**重新分析本楼**才生效',
    canRefresh: false,
    note: '「重新生成」只会按草稿重编译（坐标/排版/台词），**不会**重取档案。',
  },
];

/** 归一化：非 MOSS 一律 text；未知 engine 按 sd（与 `activeOutput` 同一条口径）。 */
export function personaOf(engine, output) {
  const e = engine === 'k2' || engine === 'moss' ? engine : 'sd';
  // ★ v0.9.157：JSON 口径（layout 与单图 json）在「外貌谁写」上是同一套，都归到 layout 方案。
  const o = e === 'moss' && output !== 'text' ? 'layout' : 'text';
  return PERSONA_PLANS.find((p) => p.engine === e && p.output === o) || PERSONA_PLANS[0];
}

/** 当前激活模版对应的口径方案。 */
export function activePersona() {
  return personaOf(activeEngine(), activeOutput());
}

/**
 * 给 UI 用的一行摘要（档案页卡片、诊断提示都用它，避免两处措辞不一致）。
 */
export function personaSummary() {
  const p = activePersona();
  const tpl = getActiveTemplate();
  return {
    plan: p,
    templateName: tpl?.name || '（未命名）',
    headline: `${p.label} · 外貌由${p.writer === 'plugin' ? '插件注入' : '模型自写'}`,
    where: p.whereText,
    refresh: p.refreshText,
    canRefresh: p.canRefresh,
  };
}
