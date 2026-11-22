/**
 * 外貌维度库（v0.9.70 · 批次 4）
 *
 * 素材来源：K2_V3_融合版.html（发型 240–281 行 / 妆容 283–319 行），共 155 条原始档。
 * 本库在此基础上补了一套男性发型档（用户的角色卡里有男性角色）。
 *
 * ★★ 三条铁律（改这个文件时先看这里）★★
 *
 * ① **英文是唯一真值，中文只作 UI 标签**（用户 2026-10-03 定案，与服装库同口径）。
 *    中文不能进画面词：`cleanTag` 在 SD 口径下会把整段中文洗掉，
 *    入库一句中文 = 那一条在那里静默消失。
 *
 * ② **每项是短语，不是句子**（沿用服装库的 tag 串口径）。
 *    人物的锚点段是元素清单 —— 写成完整句（`Her hair is…`）会跟动作/氛围段抢主谓，
 *    而抢主谓正是「多肢体 / 多手表pm」的物理成因。
 *
 * ③ **建档时细、出图时简**（否定每楼展开）。
 *    UI 上是 7 个下拉，但**保存时就合成成一条**写进 `hair`/`makeup`，
 *    出图时仍然只有一条。真把 6 维摊开进画面 = 多 6 条约束 = 直接喂给崩坏。
 *
 * ── 分层：人设层 vs 状态层（用户 2026-10-04 拍板）──
 *   人设层（长度/颜色/卷度/扎法/刘海/发饰/妆面/细节/美甲）
 *     → 存静态锚点，受 D4 硬校验保护，模型改写无效。
 *   状态层（发状态 11 档 / 花妆 3 档）
 *     → 存 dyn.appear，**允许剧情更新**，但只认库里的档名（模型乱造的词丢弃）。
 *   不分层的话，「头发湿了 / 妆花了」会被硬校验当成漂移打回去 —— D1/D2 就白做了。
 */

/* ============ 发型：长度 ============ */

/**
 * form: 'adj'  → 参与 `${len} ${color} hair` 组合（waist-length black hair）
 * form: 'noun' → 独立成段（black hair, buzz cut）
 */
export const HAIR_LEN = [
  /* 女性向（K2 原文 8 档） */
  { k: '及腰长发', en: 'waist-length', form: 'adj', sex: 'f' },
  { k: '过胸长发', en: 'chest-length', form: 'adj', sex: 'f' },
  { k: '及肩中长发', en: 'shoulder-length', form: 'adj', sex: 'f' },
  { k: '齐肩发', en: 'collar-length', form: 'adj', sex: 'f' },
  { k: '齐耳短发', en: 'ear-length', form: 'adj', sex: 'f' },
  { k: '锁骨发', en: 'collarbone-length', form: 'adj', sex: 'f' },
  { k: '短发', en: 'short', form: 'adj', sex: 'f' },
  { k: '极长及臀长发', en: 'hip-length', form: 'adj', sex: 'f' },

  /* 男性档（14 档 · 用户 2026-10-04 批准自造，因为 K2 那套全是女性向） */
  { k: '男·短发', en: 'short', form: 'adj', sex: 'm' },
  { k: '男·微乱短发', en: 'tousled short', form: 'adj', sex: 'm' },
  { k: '男·寸头', en: 'buzz cut', form: 'noun', sex: 'm' },
  { k: '男·板寸', en: 'crew cut', form: 'noun', sex: 'm' },
  { k: '男·背头', en: 'slicked-back', form: 'adj', sex: 'm' },
  { k: '男·三七分', en: 'side-parted', form: 'adj', sex: 'm' },
  { k: '男·飞机头', en: 'pompadour', form: 'noun', sex: 'm' },
  { k: '男·莫西干', en: 'mohawk', form: 'noun', sex: 'm' },
  { k: '男·狼尾', en: 'mullet', form: 'noun', sex: 'm' },
  { k: '男·扎发揪', en: 'small topknot', form: 'noun', sex: 'm' },
  { k: '男·丸子头', en: 'man bun', form: 'noun', sex: 'm' },
  { k: '男·长发束起', en: 'long tied-back', form: 'adj', sex: 'm' },
  { k: '男·及肩微卷', en: 'shoulder-length wavy', form: 'adj', sex: 'm' },
  { k: '男·光头', en: 'shaved head', form: 'noun', sex: 'm' },
  { k: '男·两侧渐变短发', en: 'tapered short', form: 'adj', sex: 'm' },
];

/* ============ 发型：颜色 ============ */

/** 男女共用（挑染类放这里，不分性别）。 */
export const HAIR_COLOR = [
  { k: '黑发', en: 'black', sex: 'any' },
  { k: '黑茶色', en: 'black-tea brown', sex: 'any' },
  { k: '深棕', en: 'dark brown', sex: 'any' },
  { k: '浅棕', en: 'light brown', sex: 'any' },
  { k: '栗色', en: 'chestnut', sex: 'any' },
  { k: '奶茶色', en: 'milk-tea brown', sex: 'any' },
  { k: '奶茶灰棕', en: 'ashy milk-tea brown', sex: 'any' },
  { k: '亚麻色', en: 'flaxen', sex: 'any' },
  { k: '金色', en: 'blonde', sex: 'any' },
  { k: '白金色', en: 'platinum blonde', sex: 'any' },
  { k: '灰蓝色', en: 'grey-blue', sex: 'any' },
  { k: '渐变染', en: 'gradient-dyed', sex: 'any' },
  { k: '渐变粉', en: 'pink gradient-tipped', sex: 'any' },
  { k: '挑染', en: 'streaked highlights', sex: 'any' },
  { k: '挂耳染', en: 'peekaboo highlights', sex: 'any' },
  { k: '银灰色', en: 'silver-grey', sex: 'any' },
  { k: '雾霾蓝', en: 'dusty blue', sex: 'any' },
  { k: '樱花粉', en: 'cherry-blossom pink', sex: 'any' },
  { k: '红棕色', en: 'auburn', sex: 'any' },
  { k: '墨绿色', en: 'dark green', sex: 'any' },
  { k: '紫灰色', en: 'violet-grey', sex: 'any' },
];

/* ============ 发型：卷度 ============ */

export const HAIR_CURL = [
  /* 女性向（K2 原文 13 档） */
  { k: '直发柔顺', en: 'sleek straight', sex: 'f' },
  { k: '自然微卷', en: 'soft natural waves', sex: 'f' },
  { k: '波浪卷', en: 'wavy', sex: 'f' },
  { k: '大卷', en: 'large curls', sex: 'f' },
  { k: '羊毛卷', en: 'tight woolly curls', sex: 'f' },
  { k: '慵懒卷', en: 'relaxed tousled curls', sex: 'f' },
  { k: '法式烫', en: 'french-perm curls', sex: 'f' },
  { k: '木马卷', en: 'romantic spiral curls', sex: 'f' },
  { k: '公主切', en: 'hime-cut', sex: 'f' },
  { k: '大波浪', en: 'large waves', sex: 'f' },
  { k: '云朵卷', en: 'fluffy cloud-like curls', sex: 'f' },
  { k: '微卷蓬松', en: 'voluminous light curls', sex: 'f' },
  { k: '拉美风格卷', en: 'voluminous latin curls', sex: 'f' },

  /* 男性档 */
  { k: '男·发质刚直', en: 'coarse straight', sex: 'm' },
  { k: '男·自然微乱', en: 'naturally tousled', sex: 'm' },
  { k: '男·微卷', en: 'slightly curly', sex: 'm' },
  { k: '男·波浪中长', en: 'medium waves', sex: 'm' },
];

/* ============ 发型：扎法 ============ */

export const HAIR_TIE = [
  /* 女性向（K2 原文 18 档） */
  { k: '披散', en: 'worn loose and flowing', sex: 'f' },
  { k: '高马尾', en: 'in a high ponytail', sex: 'f' },
  { k: '低马尾', en: 'in a low ponytail', sex: 'f' },
  { k: '侧马尾', en: 'in a side ponytail', sex: 'f' },
  { k: '双马尾', en: 'in twin tails', sex: 'f' },
  { k: '丸子头', en: 'in a loose bun', sex: 'f' },
  { k: '低髻', en: 'in a low chignon', sex: 'f' },
  { k: '半扎', en: 'in a half-up style', sex: 'f' },
  { k: '麻花辫', en: 'in a braided plait', sex: 'f' },
  { k: '盘发', en: 'in a neat updo', sex: 'f' },
  { k: '松散发髻', en: 'in a messy bun', sex: 'f' },
  { k: '高丸子头', en: 'in a high bun', sex: 'f' },
  { k: '低丸子头', en: 'in a low bun', sex: 'f' },
  { k: '双丸子头', en: 'in double buns', sex: 'f' },
  { k: '法式辫', en: 'in a french braid', sex: 'f' },
  { k: '鱼骨辫', en: 'in a fishtail braid', sex: 'f' },
  { k: '公主头', en: 'in a princess half-up', sex: 'f' },
  { k: '灯笼辫', en: 'in bubble braids', sex: 'f' },

  /* 男性档 */
  { k: '男·后梳', en: 'slicked straight back', sex: 'm' },
  { k: '男·发揪束起', en: 'with a small topknot', sex: 'm' },
  { k: '男·长发低束', en: 'tied back low', sex: 'm' },
  { k: '男·自然散落', en: 'worn loose', sex: 'm' },
];

/* ============ 发型：刘海 ============ */

export const HAIR_BANGS = [
  /* K2 原文 11 档（男女共用） */
  { k: '齐刘海', en: 'blunt bangs', sex: 'any' },
  { k: '空气刘海', en: 'wispy airy bangs', sex: 'any' },
  { k: '八字刘海', en: 'curtain bangs', sex: 'any' },
  { k: '侧分', en: 'side-parted', sex: 'any' },
  { k: '中分', en: 'center-parted', sex: 'any' },
  { k: '无刘海', en: '', sex: 'any' },
  { k: '法式刘海', en: 'french bangs', sex: 'any' },
  { k: '龙须刘海', en: 'face-framing strands', sex: 'any' },
  { k: '斜刘海', en: 'side-swept bangs', sex: 'any' },
  { k: '眉上短刘海', en: 'micro bangs above the brows', sex: 'any' },
  { k: '碎刘海', en: 'choppy bangs', sex: 'any' },

  /* 男性档 */
  { k: '男·额头全露', en: 'swept back with a fully visible forehead', sex: 'm' },
  { k: '男·短碎前发', en: 'short choppy fringe', sex: 'm' },
  { k: '男·中分长前发', en: 'long center-parted fringe', sex: 'm' },
];

/* ============ 发型：状态（★ 状态层 · 剧情可更新） ============ */

/**
 * ★ 这 11 档会随剧情变（淋雨了 / 刚睡醒 / 打斗过），所以不进静态锚点。
 * ★ 全部「去主语」——不写 her/his，避免出现当一个性别输错的情况。
 */
export const HAIR_STATE = [
  { k: '柔顺垂落', en: 'hair falling smoothly' },
  { k: '随风轻扬', en: 'hair lifted by the wind' },
  { k: '几缕碎发拂过脸颊', en: 'a few stray strands brushing the cheek' },
  { k: '凌乱蓬松', en: 'tousled messy hair' },
  { k: '发梢微翘', en: 'slightly flipped hair ends' },
  { k: '贴脸碎发', en: 'stray strands clinging to the face' },
  { k: '湿发撩开', en: 'wet hair pushed back off the face' },
  { k: '发丝遮眼', en: 'hair falling over one eye' },
  { k: '微湿贴肤', en: 'damp hair clinging to the skin' },
  { k: '光泽垂顺', en: 'glossy sleek hair' },
  { k: '发尾外翻', en: 'outward-flipped hair ends' },
];

/* ============ 发饰 ============ */

/** 男女共用为主。选了发饰时，服装串里自带的帽子/头饰会被剥掉（防「两顶帽子」）。 */
export const HAIR_ACC = [
  { k: '蝴蝶结发夹', en: 'a bow hair clip at the side', sex: 'any' },
  { k: '珍珠发夹', en: 'a pearl hair clip', sex: 'any' },
  { k: '发箍', en: 'a thin headband', sex: 'any' },
  { k: '发带', en: 'a ribbon headband', sex: 'any' },
  { k: '鲨鱼夹', en: 'a claw clip at the back', sex: 'any' },
  { k: '簪子', en: 'an ornamental hairpin', sex: 'any' },
  { k: '花朵发饰', en: 'flower hair ornaments', sex: 'any' },
  { k: '猫耳发饰', en: 'cat-ear hair accessories', sex: 'any' },
  { k: '贝雷帽', en: 'a beret', sex: 'any' },
  { k: '护士帽', en: 'a nurse cap', sex: 'any' },
  { k: '女仆发饰', en: 'a lace maid headpiece', sex: 'any' },
  { k: '蕾丝眼罩', en: 'a lace eye patch resting on the forehead', sex: 'any' },
  { k: '皇冠', en: 'a small tiara', sex: 'any' },
  { k: '花冠', en: 'a flower crown', sex: 'any' },
  { k: '面纱', en: 'a thin sheer veil beside the face', sex: 'any' },
  { k: '草帽', en: 'a straw hat', sex: 'any' },
  { k: '棒球帽', en: 'a baseball cap', sex: 'any' },
  { k: '丝带编发', en: 'a ribbon woven into the braid', sex: 'any' },
  { k: '发绳', en: 'a colorful hair tie at the ends', sex: 'any' },
  { k: '绢花发饰', en: 'a layered fabric flower pinned at the side', sex: 'any' },
  { k: '珍珠流苏发饰', en: 'pearl tassel hair ornaments', sex: 'any' },
  { k: '金属发夹', en: 'a metallic geometric barrette', sex: 'any' },
  { k: '兔耳发饰', en: 'bunny-ear hair accessories', sex: 'any' },
  { k: '蝴蝶翅膀发饰', en: 'butterfly-wing hair ornaments', sex: 'any' },
  { k: '毛绒发箍', en: 'a fluffy headband', sex: 'any' },
  { k: '渔夫帽', en: 'a bucket hat', sex: 'any' },
  { k: '鸭舌帽', en: 'a reversed baseball cap', sex: 'any' },
  { k: '宽檐礼帽', en: 'a wide-brimmed dress hat', sex: 'any' },
  { k: '大檐草帽', en: 'a large-brimmed straw hat', sex: 'any' },
  { k: '发带包头巾', en: 'a printed kerchief band', sex: 'any' },
  { k: '珍珠头纱', en: 'a pearl bridal veil', sex: 'any' },
  { k: '发夹星星', en: 'star-shaped hair clips', sex: 'any' },

  /* 男性档 */
  { k: '男·皮质额带', en: 'a leather headband', sex: 'm' },
  { k: '男·针织帽', en: 'a knit beanie', sex: 'm' },
  { k: '男·礼帽', en: 'a felt fedora', sex: 'm' },
];

/* ============ 妆容：妆面 ============ */

/** 女性向为主；男性角色留空即跳过（不入画、不进 nlProfile）。 */
export const MAKEUP = [
  { k: '素颜', en: 'natural no-makeup look, clean sheer base' },
  { k: '清纯淡妆', en: 'soft pink lip tint, softly winged brown eyeliner, sheer japanese-style finish' },
  { k: '甜妹妆', en: 'pink blush, shimmering eyeshadow, glossy lips' },
  { k: '网感妆', en: 'highlighted aegyo-sal, dense lashes, refined filter-like finish' },
  { k: '纯欲妆', en: 'wide blush under the eyes, glossy plump lips, effortless polished look' },
  { k: '御姐妆', en: 'bold red lips, upswept eyeliner, matte base' },
  { k: '欧美妆', en: 'cut-crease eyeshadow, nude lips, bronze contour, full false lashes' },
  { k: '厌世妆', en: 'low-saturation tones, downturned eyes, muted lips, hangover blush' },
  { k: '港风妆', en: 'deep red lips with micro-curled eyeliner, retro glamorous' },
  { k: '韩系水光妆', en: 'dewy glass skin, pink blush, glassy lips' },
  { k: '病娇妆', en: 'red-rimmed under eyes, slightly uplifted eye tails, dark red lips' },
  { k: '樱花粉嫩妆', en: 'cherry-blossom eyeshadow, pink blush on the cheekbones, dewy cherry lips' },
  { k: '复古红唇妆', en: 'classic matte red lipstick, retro winged liner' },
  { k: '清新裸妆', en: 'sheer lightweight base, light apricot blush, nude tea lips' },
  { k: '哥特暗黑妆', en: 'pale matte base, heavy black smoky eyes, deep purple lips' },
  { k: '猫眼妆', en: 'cat-eye flicked eyeliner, brown gradient shadow, peach lips' },
  { k: '云朵妆', en: 'pastel gradient eyeshadow in pink blue and purple' },
  { k: '晒伤妆', en: 'sunburn blush across the nose and cheekbones' },
  { k: '斩男伪素颜妆', en: 'translucent lightweight base, tightlined eyes, coral glossy lips' },
  { k: '杂志浓妆', en: 'strong contour, sculpted features, thin arched brows, vivid lips' },
  { k: '中式古典妆', en: 'slender willow-leaf brows, small cherry-red lips, rouge blush' },
];

/* ============ 妆容：妆面细节 ============ */

export const MAKEUP_DETAIL = [
  { k: '无瑕底妆', en: 'flawless matte base' },
  { k: '自然腮红', en: 'natural blush' },
  { k: '卧蚕提亮', en: 'highlighted aegyo-sal' },
  { k: '眼下腮红', en: 'blush under the eyes' },
  { k: '哑光红唇', en: 'matte red lips' },
  { k: '重眼影', en: 'heavy eyeshadow' },
  { k: '浓密睫毛', en: 'dense thick lashes' },
  { k: '泪痣', en: 'a beauty mark under the eye' },
  { k: '上扬眼线', en: 'uplifted eyeliner' },
  { k: '眼下亮片', en: 'glitter under the eyes' },
  { k: '大红唇', en: 'bright red lips' },
  { k: '粉调腮红', en: 'pink-toned blush' },
  { k: '水光唇', en: 'glossy lips' },
  { k: '渐变唇', en: 'gradient lips' },
  { k: '下眼睑晕染', en: 'smudged lower lashline' },
  { k: '长睫毛', en: 'long lashes' },
  { k: '细挑眉', en: 'thin arched eyebrows' },
  { k: '彩色眼线', en: 'colored eyeliner' },
  { k: '蜜桃腮红', en: 'peach blush' },
];

/* ============ 妆容：花妆（★ 状态层 · NSFW 门禁） ============ */

/**
 * ★ 走 NSFW 门禁（用户 2026-10-04 拍板「只有花妆三档走门禁」）：
 *   「口红满脸」明显是性行为后的状态，SFW 下注入等于绕过尺度开关。
 * ★ 同样是剧情可更新的状态层，不进静态锚点。
 */
export const MAKEUP_SMUDGE = [
  { k: '轻微', en: 'makeup slightly smudged, lipstick blurred at the edges' },
  { k: '中度', en: 'runny eyeliner, lipstick smeared onto the cheek' },
  { k: '重度', en: 'eye makeup smeared across the face, lipstick all over' },
];

/* ============ 妆容：美甲 ============ */

export const NAILS = [
  { k: '精致美甲', en: 'delicate manicured nails' },
  { k: '自然素甲', en: 'bare natural nails' },
  { k: '甲油剥落', en: 'chipped nail polish' },
];

/* ============ 维度注册表（UI 遍历顺序写死在这里） ============ */

export const HAIR_DIMS = [
  { id: 'len', label: '长度', list: HAIR_LEN },
  { id: 'color', label: '发色', list: HAIR_COLOR },
  { id: 'curl', label: '卷度', list: HAIR_CURL },
  { id: 'tie', label: '扎法', list: HAIR_TIE },
  { id: 'bangs', label: '刘海', list: HAIR_BANGS },
  { id: 'acc', label: '发饰', list: HAIR_ACC },
  { id: 'state', label: '发状态（剧情可更新）', list: HAIR_STATE, state: true },
];

export const MAKEUP_DIMS = [
  { id: 'type', label: '妆面', list: MAKEUP },
  { id: 'detail', label: '妆面细节', list: MAKEUP_DETAIL },
  { id: 'nails', label: '美甲', list: NAILS },
  { id: 'smudge', label: '花妆（剧情可更新 · NSFW）', list: MAKEUP_SMUDGE, state: true },
];

/* ============ 冲突表（搬 K2 自带的规则） ============ */

/** 短发/齐耳短发 扎不了这些（K2 第 1652 行 tieBan 同旨）。 */
const NO_TIE_SHORT = [
  '高马尾', '低马尾', '侧马尾', '双马尾', '丸子头', '低髻', '盘发', '松散发髻',
  '高丸子头', '低丸子头', '双丸子头', '麻花辫', '法式辫', '鱼骨辫', '灯笼辫',
];

/** 短发也做不出这些长卷（K2 第 1645 行）。 */
const NO_CURL_SHORT = [
  '波浪卷', '大卷', '慵懒卷', '法式烫', '木马卷', '大波浪', '云朵卷', '拉美风格卷',
];

/** 短发标准：命中这些长度就算短。 */
const SHORT_LENS = ['短发', '齐耳短发', '男·短发', '男·寸头', '男·板寸', '男·微乱短发', '男·光头', '男·两侧渐变短发', '男·背头', '男·莫西干'];

/** 「披散」时，这些需要编/扎才好固定的发饰会被剥掉（K2 第 1655 行）。 */
const NO_ACC_LOOSE = ['丝带编发', '鲨鱼夹', '发绳'];

/**
 * 素颜 → 妆面细节与花妆都不合法（K2 第 1628 行原文：
 * 「素颜状态下无法叠加妆面细节」「素颜状态下没有妆容可被弄花」）。
 */
const NO_MAKEUP_ON_BARE = '素颜';

/** 发饰若要生效，这些旧 5 档……（保留占位，未来用于服装状态联动） */
const KNOWN_SHADOW = {
  // 服装库里自带头饰的条目会被 stripHeadwear 剥掉对应片段
};

export {
  NO_TIE_SHORT, NO_CURL_SHORT, SHORT_LENS, NO_ACC_LOOSE, NO_MAKEUP_ON_BARE, KNOWN_SHADOW,
};

/* ============ 查表 ============ */

/** 按中文档名在某一维度里找（找不到返回 null —— 模型乱填的档名就此丢弃）。 */
export function pickFrom(list, key) {
  const k = String(key || '').trim();
  if (!k) return null;
  return list.find((x) => x.k === k) || null;
}

export const hairLenOf = (k) => pickFrom(HAIR_LEN, k);
export const hairColorOf = (k) => pickFrom(HAIR_COLOR, k);
export const hairCurlOf = (k) => pickFrom(HAIR_CURL, k);
export const hairTieOf = (k) => pickFrom(HAIR_TIE, k);
export const hairBangsOf = (k) => pickFrom(HAIR_BANGS, k);
export const hairAccOf = (k) => pickFrom(HAIR_ACC, k);
export const hairStateOf = (k) => pickFrom(HAIR_STATE, k);
export const makeupOf = (k) => pickFrom(MAKEUP, k);
export const makeupDetailOf = (k) => pickFrom(MAKEUP_DETAIL, k);
export const smudgeOf = (k) => pickFrom(MAKEUP_SMUDGE, k);
export const nailsOf = (k) => pickFrom(NAILS, k);

/** 从 `boy/girl/1boy/male/female` 之类的写法判性别，判不出给 null。 */
export function sexKind(sex) {
  const s = String(sex || '').toLowerCase();
  if (/\b(m|boy|male|man|1boy)\b/.test(s) && !/\bgirl\b/.test(s)) return 'm';
  if (/\b(f|girl|female|woman|1girl)\b/.test(s)) return 'f';
  if (s.includes('男')) return 'm';
  if (s.includes('女')) return 'f';
  return null;
}

/** 某个维度的可选项（按性别过滤；判不出性别就全给）。 */
export function optionsFor(dimId, sex) {
  const dim = [...HAIR_DIMS, ...MAKEUP_DIMS].find((d) => d.id === dimId);
  if (!dim) return [];
  const want = sexKind(sex);
  // ★ 判不出性别时给**全部**（不是空）—— 空列表会让「没填 sex 的旧档案」一个选项都选不了
  if (!want) return dim.list.slice();
  return dim.list.filter((x) => (x.sex && x.sex !== 'any') ? x.sex === want : true);
}

/* ============ 冲突消解 ============ */

/**
 * 按 K2 的冲突表清掉不合法的组合（返回新 spec + 清掉的原因列表）。
 * UI 用它做「选了短发就把高马尾灰掉」，保存时也用它兜底。
 */
export function resolveHairConflicts(spec = {}) {
  const next = { ...spec };
  const cleared = [];
  const isShort = SHORT_LENS.includes(next.len);

  if (isShort) {
    if (NO_TIE_SHORT.includes(next.tie)) {
      cleared.push(`短发（${next.len}）扎不了「${next.tie}」→ 已清空`);
      delete next.tie;
    }
    if (NO_CURL_SHORT.includes(next.curl)) {
      cleared.push(`短发（${next.len}）做不出「${next.curl}」→ 已清空`);
      delete next.curl;
    }
  }
  if (next.tie === '披散' || next.tie === '男·自然散落') {
    if (NO_ACC_LOOSE.includes(next.acc)) {
      cleared.push(`披散时「${next.acc}」无处固定 → 已清空`);
      delete next.acc;
    }
  }
  return { spec: next, cleared };
}

/** 妆容侧的冲突消解（目前只有素颜一条）。 */
export function resolveMakeupConflicts(spec = {}) {
  const next = { ...spec };
  const cleared = [];
  if (next.type === NO_MAKEUP_ON_BARE) {
    if (next.detail) {
      cleared.push('素颜不能叠加妆面细节 → 已清空');
      delete next.detail;
    }
    if (next.smudge) {
      cleared.push('素颜没有妆可以被弄花 → 已清空');
      delete next.smudge;
    }
  }
  return { spec: next, cleared };
}

/* ============ 合成（★ 建档时只做这一次） ============ */

function dedup(list) {
  return [...new Set(list.filter(Boolean))];
}

/**
 * 发型 spec → 英文串 + 中文串。
 * ★ 顺序固定为「核心段 → 卷度 → 扎法 → 刘海」：核心段必须是 `${len} ${color} hair`，
 *   这样出来的才是 `waist-length black hair` 而不是三个孤立形容词。
 * ★ 状态层（state）不参与人设层合成 —— 它属于 dyn，能被剧情改。
 */
export function composeHair(spec = {}) {
  const { spec: s } = resolveHairConflicts(spec);
  const len = hairLenOf(s.len);
  const color = hairColorOf(s.color);
  const curl = hairCurlOf(s.curl);
  const tie = hairTieOf(s.tie);
  const bangs = hairBangsOf(s.bangs);
  const acc = hairAccOf(s.acc);

  const parts = [];
  const colorWord = color?.en || '';
  const lenWord = len?.en || '';
  if (lenWord || colorWord) {
    if (len?.form === 'noun') {
      // noun 型（buzz cut / mohawk…）自带名词，只能挂在 hair 之后当独立段
      parts.push(`${colorWord || 'black'} hair, ${lenWord}`);
    } else {
      // 英语习惯：长度在前、颜色在后（waist-length black hair）
      parts.push([lenWord, colorWord].filter(Boolean).join(' ') + ' hair');
    }
  }
  if (curl?.en) parts.push(curl.en);
  if (tie?.en) parts.push(tie.en);
  if (bangs?.en) parts.push(bangs.en);
  if (acc?.en) parts.push(acc.en);

  const zh = dedup([s.color, s.len, s.curl, s.tie, s.bangs, s.acc])
    .join('，');
  return { en: dedup(parts).join(', '), zh };
}

/** 妆容 spec → 英文串 + 中文串（同样不含状态层 smudge）。 */
export function composeMakeup(spec = {}) {
  const { spec: s } = resolveMakeupConflicts(spec);
  const type = makeupOf(s.type);
  const detail = makeupDetailOf(s.detail);
  const nails = nailsOf(s.nails);

  const en = dedup([type?.en, detail?.en, nails?.en]).join(', ');
  const zh = dedup([s.type, s.detail, s.nails]).join('，');
  return { en, zh };
}

/* ============ 发饰 × 服装帽饰（防「两顶帽子」） ============ */

/**
 * 服装库的条目有的自带帽子（护士服 nurse cap / 空乘 beret / 女仆 lace headpiece）。
 * 再叠一个发饰 = 头上两件东西 = 画面直接画两套。
 *
 * ★ 与批次 3 的 `stripShoesFromStyle` 同款做法：**按逗号切段 + 段内匹配**，
 *   不做全局替换 —— 全局删会把 `cap sleeve`（泡泡袖，跟帽子无关）也吃掉。
 */
/**
 * ★ `caps?` 必须带**否定 lookahead**：`cap sleeve`（泡泡袖）跟帽子一点关系没有，
 *   直接写 `\bcaps?\b` 会把整个泡泡袖吃掉。
 *   这是批次 3 那个 `thigh-highs?` 误删 `thigh-high slit`（高开衩）的同款坑 —— 一次也没躲过去，
 *   所以这里的写法是：`cap/caps` 后面**不紧跟 sleeve** 才算帽子。
 */
const HEADWEAR_SEG_RE = /\b(?:hats?|beret|beanie|fedora|headband|headpiece|headwear|veil|tiara|crown)\b|\bcaps?\b(?!\s+sleeves?\b)/i;

export function stripHeadwearFromStyle(style) {
  const s = String(style || '').trim();
  if (!s) return '';
  const kept = s.split(',').map((x) => x.trim()).filter(Boolean)
    .filter((seg) => !HEADWEAR_SEG_RE.test(seg));
  return kept.join(', ');
}

/* ============ nlProfile 中文自然语（K2 模板专用） ============ */

/**
 * K2 模板下人物段优先读 `nlProfile`（自然语外貌档案），
 * 逐字段 tag 那条路**根本不参与** —— 所以选了 6 维必须同步这里，否则白选。
 *
 * 返回可直接塞进 nlProfile 的中文短句。
 */
export function hairToZh(spec = {}) {
  const { spec: s } = resolveHairConflicts(spec);
  // 全用逗号分隔 —— 连写会粘成「黑发及腰长发」这种读不通的串
  const seq = dedup([s.color, s.len, s.curl, s.tie, s.bangs, s.acc]).join('，');
  return seq ? `${seq}；` : '';
}

export function makeupToZh(spec = {}) {
  const { spec: s } = resolveMakeupConflicts(spec);
  const seq = dedup([s.type, s.detail, s.nails]).join('，');
  return seq ? `妆容${seq}；` : '';
}
