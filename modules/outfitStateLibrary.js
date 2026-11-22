/**
 * 服装三维度库：状态位细档 / 改造 / 鞋袜
 *
 * v0.9.69 · 素材来自 K2_V3_融合版.html §8.1（OPT.nsfwState / nsfwMod / nsfwShoes）
 *
 * ────────────────────────────────────────────────────────────────
 * ★★ 为什么不是原文照搬（这是本库存在的全部理由）
 * ────────────────────────────────────────────────────────────────
 * K2 那三类档位全是**自带主语的完整英文句**，例如：
 *     ['半脱','Her dress is pulled down to her waist, pooling around her hips…']
 *     ['破损','Her school uniform is in ruins—the white blouse torn open…']
 *
 * 直接搬进绘灵会撞两条硬规律：
 *   ① 重复＝实体复制（本项目头号崩图机理）：绘灵的 outfit.style 里本来就有衣服，
 *      再叠一句 "Her dress is…" → 画面上多出一件衣服 / 多半个身子。
 *   ② 档位里混着手位、姿势、动作（"bunched in one hand"、"as she leans forward"、
 *      "toes curling"）→ 跟动作段抢主谓 → 多手、姿势打架。
 *
 * 所以落地口径是三条：
 *   A. 去主语：剥掉 `Her dress / shirt / skirt / uniform is`，只留几何与状态描述。
 *   B. 去动作：手位、躯体倾向、进行中的动态一律删除，只留静态结果。
 *   C. 三模式注入：
 *        append  —— 追加到 style 之后（衣服还在，只是状态变了）
 *        replace —— 整段替换 style（档位自带完整穿着，再叠 style 必重复）
 *        none    —— 不输出（"不使用" / 等同 intact）
 *      replace 档位同时**禁用鞋袜维度**（都全裸了不该还有靴子）。
 *
 * ────────────────────────────────────────────────────────────────
 * ★★ 18 档里剔掉的 4 档（用户 2026-10-04 拍板）
 * ────────────────────────────────────────────────────────────────
 *   正常穿着 —— 就是 intact；K2 那句是示例套装（白衬衫+黑铅笔裙+黑丝袜），与 style 直接冲突
 *   破损     —— 自带 school uniform（非校服角色直接穿错）；且与改造维度「破损化/撕裂」重复 → 归 B2
 *   只余上衣 —— 本质是"只穿一件 oversized white shirt"，该由 style / 服装库表达，不该由状态位管
 *   湿透衬衫 —— 与「湿透透视」几乎重复，且自带 white shirt
 *
 * ────────────────────────────────────────────────────────────────
 * ★ 兼容层：stateDetail 不替代旧 5 档
 * ────────────────────────────────────────────────────────────────
 * outfit.state（intact/parted/undone/removed/swapped）仍是**机器语义**——
 * 三档清洗 stripGarmentFromBare、bare 裸露锚点、状态位单调前进都挂在它上面。
 * stateDetail 只是它的"细化注入"，每档用 `state` 字段标出自己对应哪一档。
 * 两者不一致时：清洗以 state 为准，注入以 stateDetail 为准。
 */

/**
 * 状态位细档（14 档）。
 * @type {Array<{key:string, state:string, mode:'append'|'replace'|'none', en:string, note?:string}>}
 */
export const OUTFIT_STATE_DETAILS = [
  {
    key: '滑落微露', state: 'parted', mode: 'append',
    en: 'slipped off one shoulder, the strap hanging loose against her upper arm',
  },
  {
    key: '掀起敞开', state: 'undone', mode: 'append',
    en: 'completely unbuttoned and hanging open, framing the bare torso; pushed up to the waist, bunched around the hips',
  },
  {
    key: '半脱', state: 'parted', mode: 'append',
    en: 'pulled down to the waist, pooling around the hips, chest left bare; one bra strap hanging loose off the shoulder',
  },
  {
    key: '仅剩配饰', state: 'removed', mode: 'replace',
    // 原文自带 "white lace-top stockings + black velvet choker" → 去掉颜色材质，
    // 交给鞋袜维度接管，否则与 OUTFIT_SHOES 撞车（两双袜子）。
    en: 'completely nude except for thigh-high stockings gripping mid-thigh and a choker wrapped around the throat',
    note: '自带长袜，故禁用独立鞋袜维度',
  },
  {
    key: '湿透透视', state: 'intact', mode: 'append',
    en: 'soaked through with water, the wet fabric clinging to every contour of the body',
  },
  {
    key: '全裸', state: 'removed', mode: 'replace',
    en: 'completely bare, skin smooth and unbroken, a faint sheen of perspiration catching the light',
  },
  {
    key: '只余内衣', state: 'removed', mode: 'replace',
    // 去颜色（原文 lacy black bra），避免与 style 里可能存在的内衣描述重复。
    en: 'stripped down to nothing but bra and thong, the straps pressing into her shoulders and hips',
  },
  {
    key: '裙摆撩起', state: 'parted', mode: 'append',
    // 原文 "bunched in one hand"（手位）+ "hips tilted forward"（姿势）已删。
    en: 'hiked up to the waist, the hem bunched at her hip',
  },
  {
    key: '拉链半开', state: 'intact', mode: 'append',
    en: 'the zipper pulled halfway down the spine, the fabric gaping open at the back to reveal a strip of bare skin',
    note: '只有带拉链的服装才成立 —— A3 可选状态表的典型用例',
  },
  {
    key: '吊带滑落', state: 'parted', mode: 'append',
    en: 'one thin shoulder strap fallen off the shoulder, the bodice slipping down to bare one breast',
  },
  {
    key: '衣襟大敞', state: 'undone', mode: 'append',
    // 原文 "as she leans forward over the messy sheets"（姿势+场景）已删。
    en: 'unbuttoned and falling open wide, framing the bare chest',
  },
  {
    key: '内裤褪到膝', state: 'parted', mode: 'append',
    // 唯一保留主语的一档：内裤不在 outfit.style 里（style 记的是外穿服装），
    // 不写主语就画不出"褪到膝盖"这个几何。
    en: 'her panties pulled down to her knees, gathered around her thighs just above the knee-caps',
  },
  {
    key: '裙内真空', state: 'intact', mode: 'append',
    en: 'nothing worn beneath, the hem whispering around the bare thighs',
  },
  {
    key: '浴巾遮身', state: 'removed', mode: 'replace',
    en: 'a thin towel held to the chest, its hem barely covering the hips, water beading on the bare shoulders',
  },
];

/**
 * 改造维度（14 档实档；「不使用」用空串表示，不入数组）。
 * @type {Array<{key:string, en:string, note?:string}>}
 */
export const OUTFIT_MODS = [
  {
    key: '透明化',
    en: 'the fabric turns sheer and translucent, every contour beneath visible through the cloth',
  },
  {
    key: '裁剪缩短',
    en: 'cropped drastically short, hems riding high over the hips',
  },
  {
    key: '镂空开口',
    en: 'a diamond-shaped cutout sits over the bare midriff, framed by the taut fabric',
  },
  {
    key: '破损化',
    // ⭐ 「破丝袜」活体病例的解药：绘灵此前没有"破损"这个状态，
    //    只能塞进 style 自由文本，清洗时凭正则猜 torn 要不要留，很脆。
    en: 'the fabric torn into ragged strips, barely holding together across the body',
  },
  {
    key: '乳胶亮面',
    en: 'the glossy black latex surface clings to the skin, reflecting sharp white highlights',
    note: '自带材质 latex：style 里若已写 cotton/silk 等材质词会打架，UI 需提示',
  },
  {
    key: '非对称化',
    en: 'one side stays intact while the other is peeled away entirely, exposing bare skin',
  },
  {
    key: '裂口高开衩',
    en: 'a deep slit runs from the hip down to the ankle, the leg opening gaping',
  },
  {
    key: '挖空后背',
    en: 'the entire back panel cut away, leaving only a few thin straps crossing the bare spine',
  },
  {
    key: '透视蕾丝',
    en: 'sheer lace panels sewn into the bodice, every contour beneath dimly visible through the openwork',
  },
  {
    key: '束紧',
    en: 'thin cords tighten around the waist, cinching the fabric snug against the body and emphasizing every curve',
  },
  {
    key: '开胸',
    en: 'the front of the bodice cut open into a plunging wedge, framing the breasts with a bare V of skin',
  },
  {
    key: '极短化',
    en: 'trimmed to little more than a band of cloth around the hips, the thighs fully exposed',
  },
  {
    key: '撕裂',
    en: 'torn strips of fabric hang from the frame, the garment shredded across the body',
  },
  {
    key: '仅余配饰',
    // 原文自带 hat / badge / leather gloves → 剥掉具体配饰，交给自定义字段，
    // 否则与档案里已有的配饰字段重复。
    en: 'only accessories remaining on the bare skin',
  },
];

/**
 * 鞋袜维度（13 档实档）。
 *
 * ⚠️ 冲突规则（抄 K2 §2.4）：
 *   - 选「赤脚」→ 禁用所有袜子/鞋子档（脚上不能既赤脚又有靴子）
 *   - 状态位为 replace 档（全裸/仅剩配饰/只余内衣/浴巾遮身）→ 鞋袜维度整体不注入
 *
 * @type {Array<{key:string, en:string, kind:'heels'|'boots'|'socks'|'bare'}>}
 */
export const OUTFIT_SHOES = [
  { key: '黑色细高跟', kind: 'heels', en: 'a pair of black stiletto heels on her feet' },
  { key: '黑色过膝长靴', kind: 'boots', en: 'black thigh-high boots encase her legs' },
  { key: '白色蕾丝过膝袜', kind: 'socks', en: 'sheer white lace-top thigh-high stockings grip her thighs' },
  { key: '黑色渔网袜', kind: 'socks', en: 'black fishnet stockings hug her legs' },
  { key: '赤脚', kind: 'bare', en: 'her bare feet press against the floor' },
  { key: '红色细高跟', kind: 'heels', en: 'a pair of crimson stiletto heels on her feet, the gleaming leather drawing the eye' },
  { key: '白色细高跟', kind: 'heels', en: 'white stiletto heels on her feet, pristine against the floor' },
  { key: '漆皮过膝靴', kind: 'boots', en: 'glossy patent-leather boots rise past the knees, encasing her legs' },
  { key: '吊带袜', kind: 'socks', en: 'a sheer garter belt and thigh-high stockings strap her thighs, the clips pressing into her skin' },
  { key: '白色棉袜', kind: 'socks', en: 'plain white cotton anklets cover her feet' },
  { key: '蕾丝短袜', kind: 'socks', en: 'delicate lace-trimmed ankle socks cover her feet, soft and innocent' },
  { key: '黑色吊带袜', kind: 'socks', en: 'black sheer thigh-highs held up by a garter belt, the tops digging gently into her thighs' },
  { key: '银色金属色长靴', kind: 'boots', en: 'metallic silver boots climb her calves, cool and gleaming' },
];

/** 白名单（模型报的非法值一律静默丢弃，不进画面）。 */
export const OUTFIT_STATE_DETAIL_KEYS = OUTFIT_STATE_DETAILS.map(x => x.key);
export const OUTFIT_MOD_KEYS = OUTFIT_MODS.map(x => x.key);
export const OUTFIT_SHOES_KEYS = OUTFIT_SHOES.map(x => x.key);

/** 按档名取状态细档（非法返回 null）。 */
export function stateDetailOf(key) {
  const k = String(key || '').trim();
  if (!k) return null;
  return OUTFIT_STATE_DETAILS.find(x => x.key === k) || null;
}

/** 按档名取改造档（非法返回 null）。 */
export function modOf(key) {
  const k = String(key || '').trim();
  if (!k) return null;
  return OUTFIT_MODS.find(x => x.key === k) || null;
}

/** 按档名取鞋袜档（非法返回 null）。 */
export function shoesOf(key) {
  const k = String(key || '').trim();
  if (!k) return null;
  return OUTFIT_SHOES.find(x => x.key === k) || null;
}

/** 该状态档是否"整段替换 style"（真就禁用独立鞋袜维度）。 */
export function isReplaceState(key) {
  return stateDetailOf(key)?.mode === 'replace';
}

/** 该鞋袜档是否赤脚（赤脚 → UI 与保存时禁用其它鞋袜档）。 */
export function isBareFeet(key) {
  return shoesOf(key)?.kind === 'bare';
}

/**
 * 状态细档 → 画面词。
 * @returns {{en:string, mode:'append'|'replace'|'none'}} 无值时 mode='none'
 */
export function stateDetailHint(key) {
  const d = stateDetailOf(key);
  if (!d || !d.en) return { en: '', mode: 'none' };
  return { en: d.en, mode: d.mode };
}
