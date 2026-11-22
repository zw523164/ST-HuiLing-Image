/**
 * outfitStateFacts.js —— 服装状态位 → **名词性可见事实**（v0.9.135）
 *
 * ## 这个文件解决什么
 *
 * 用户 2026-10-22 报「重跑后款式对了、但某一格的『半褪』状态画丢了」，
 * 并把选择权交回来：是让裸露进主字段，还是让 §4.2 的变化记录更强制？
 *
 * 两条都试过了，**都不行**。真实出图对照（`dev_tmp/ab_outfit_real.mjs`，
 * 同一角色 / 同 seed / 同工作流，只改服装那一行）：
 *
 *   A 现状 `服装=<款式>（服装状态=半褪；裸露=skirt pushed up around her waist…）`
 *       → 裙子照旧穿得整整齐齐，和「完好态」对照图几乎无差别
 *   B 裸露进主字段（还是关系句 `skirt pushed up around her waist`）→ 同样没画出来
 *   C 全英文自然语整句（同内容）→ 同样没画出来
 *   F `服装=<款式> bunched into a band around her waist, her belly and hips bare`
 *       → **画对了**：裙子变成腰上一圈、下腹与髋部裸露
 *   G 只写部件、去掉 dress 整体词 → 状态对，但**粉色丢了**（款式 DNA 被拆散）
 *   D `服装=(已全部褪下)` → 模型自己补了一件深蓝围裙 + 黑丝
 *   H `服装=no clothing at all, completely bare, bare breasts and bare belly…`
 *       → **画对了**：一件衣物都没有
 *
 * ## 从这八张图得到的唯一规律
 *
 * **生效的是名词，不生效的是关系。**
 *   ✔ `bare feet` / `loafers on the floor` / `a band of fabric at her waist` / `no clothing at all`
 *     —— 都是「看得见的实体 + 它现在是什么状态」
 *   ✘ `skirt pushed up around her waist` / `pulled down off one shoulder`
 *     —— 描述的是「衣物与身体之间的动作关系」，编码器画不出，会自动退化成
 *        「一件穿好的短裙」这种最省事的先验
 *
 * 所以修的地方**不是** spec（让模型自己想怎么写变化），也不是把裸露塞进主字段，
 * 而是**渲染层**：插件手里已经有明确的状态位，把它翻译成一句名词性事实即可 ——
 * 不依赖模型的表达水平。
 *
 * ★ 追加位置必须**紧跟款式之后**（`服装=<款式>, <事实>`）：
 *   G 版证明把整体词（maid dress）拆掉只留部件 → 颜色/品类当场漂移。
 *   款式是主品类，事实是它的形态，两者要在同一个字段里、顺序固定。
 *
 * ★ 有「细档」（用户手选的状态细节，如 `半褪到胸下`）时**不追加**：
 *   那是用户给定的精确画面，自动事实只会跟它打架。
 */

/** 全裸（`removed` 且款式已清空）时唯一正确的写法 —— H 版实测。 */
export const OUTFIT_REMOVED_BARE =
  'no clothing at all, completely bare, bare breasts and bare belly and bare hips and bare legs, barefoot';

/**
 * 品类判定：决定「半褪」发生在哪一层。
 * 名词写复数（`skirts?` / `blouses?`）—— 单数正则漏掉复数是最常见的假绿来源。
 *
 * ★ `uniform` / `outfit` 这类**泛词不算品类**：`white school uniform blouse` 是上衣，
 *   若把 uniform 算进裙类，它会被写成「裙子堆在腰上」——直接和款式打架。
 *   只有出现具体单品（skirt / dress / blouse / trousers …）才判得准，泛词一律走兜底。
 */
const RE_SKIRT = /\b(skirts?|dress(?:es)?|gowns?|cheongsams?|qipaos?|one[- ]?piece|maid|kimono|yukata|robes?|aprons?)\b/i;
const RE_TOP = /\b(shirts?|blouses?|tops?|jackets?|coats?|cardigans?|sweaters?|hoodies?|vests?|bras?)\b/i;
const RE_PANTS = /\b(trousers?|pants?|jeans|shorts?|slacks?|leggings)\b/i;

/**
 * ★★★ v0.9.183：`dress shirt` 里的 `dress` 会命中 `RE_SKIRT` 的 `dress(?:es)?`。
 *
 * 实测病例（2026-10-31 22:36，男主夜斗）：
 *   款式 = `white dress shirt, loosened necktie, navy blue trousers, black leather belt …`
 *   品类被判成 **skirt** ⇒ 状态位渲染成
 *   `unfastened and sliding down her hips, her belly bare`
 *   —— 一个穿西裤的男角色被写成「裙子正从她的臀部滑落、她的小腹裸露」。
 *
 * 后果不止是难看：这条**凭空造出来的半裸描述**被写词模型当成真内容，
 * 它拒答的原话就是 "characters in school uniforms with **partially removed clothing and
 * exposed undergarments**"。同一批 A/B 对照里，去掉它之后拒答消失。
 *
 * 所以判品类**之前**先把「dress shirt / dress shoes / dress pants」这类正装词剔掉，
 * 而不是去改 `dress(?:es)?` —— 那会漏掉 `evening dress` 这种真裙子。
 */
const RE_DRESS_NOT_SKIRT = /\bdress\s+(?:shirts?|shoes?|boots?|pants?|trousers?|slacks?|socks?|blouses?|code)\b/gi;

/**
 * 半褪：衣物还在身上，但已经离开原位。
 * `skirt` 口径来自 F 版实测（`bunched into a band around her waist` 是唯一画出效果的写法）。
 */
const PARTED = {
  skirt: (p) => `bunched into a band around ${p} waist, ${p} belly and hips bare`,
  top: (p) => `hanging open at the front, ${p} chest and belly bare`,
  pants: (p) => `pulled down to ${p} thighs, ${p} hips bare`,
  any: () => 'pulled open and out of place, bare skin showing where it has slipped',
};

/** 解开：比半褪轻一档，扣子/系带开了，但衣物还在原位。 */
const UNDONE = {
  skirt: (p) => `unfastened and sliding down ${p} hips, ${p} belly bare`,
  top: (p) => `unbuttoned and hanging open, ${p} chest bare`,
  pants: (p) => `unbuttoned and pulled open, ${p} belly bare`,
  any: () => 'unfastened and hanging open',
};

/**
 * ★★★ v0.9.183：所有格代词不能再写死 `her`。
 *
 * 上面那几句是 2026-10-22 拿**女主**做的八张对照图定下来的，句式本身有实测依据；
 * 但男角色（夜斗）套上去就成了「裤子正从她的臀部滑落」。
 * 只换代词、不动句式 —— 改句式等于推翻那八张图的结论，没有新证据不能动。
 *
 * 性别来源是静态锚点的 `fields.sex`（`1boy` / `1girl` / `male` …）。
 * 拿不到时**回落 `her`**：这是现有文案的基准，宁可不变也不凭空改观感。
 */
function poss(sex) {
  const s = String(sex == null ? '' : sex);
  return /\b(1boy|male|man|boy)\b/i.test(s) ? 'his' : 'her';
}

/** 按款式串判品类。顺序不能换：`uniform blouse + skirt` 同时命中时以裙子为准。 */
function kindOf(style) {
  const s = String(style || '').replace(RE_DRESS_NOT_SKIRT, ' ');
  if (RE_SKIRT.test(s)) return 'skirt';
  if (RE_TOP.test(s)) return 'top';
  if (RE_PANTS.test(s)) return 'pants';
  return 'any';
}

/**
 * 状态位 → 一句名词性可见事实。
 *
 * @param {string} style 当前款式串（`服装=` 的那个值）
 * @param {string} state `intact|parted|undone|removed|swapped`
 * @param {{skip?:boolean, sex?:string}} [opts] `skip` = 已有用户给定的细档描述，不要再追加；
 *   `sex` = 静态锚点的 `fields.sex`，只用来选 `his` / `her`
 * @returns {string} 英文名词短语；不需要追加时返回 `''`
 */
export function outfitStateFact(style, state, opts = {}) {
  const st = String(state || '').trim();
  const s = String(style || '').trim();
  if (!st || st === 'intact' || st === 'swapped') return '';
  if (opts.skip) return '';

  // 款式已清空 + removed：画面里就是什么都没有，直接给全裸事实（由调用方当作主值）
  if (st === 'removed') return s ? '' : OUTFIT_REMOVED_BARE;

  const kind = kindOf(s);
  const p = poss(opts.sex);
  if (st === 'parted') return PARTED[kind](p);
  if (st === 'undone') return UNDONE[kind](p);
  return '';
}

/** 全裸事实串是否「够用」——测试与诊断用（必须同时点名衣物缺席与身体裸露）。 */
export function isBareFactComplete(text) {
  const t = String(text || '');
  return /no clothing at all/i.test(t) && /completely bare/i.test(t);
}
