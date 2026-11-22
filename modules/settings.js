/**
 * 绘灵 · 配置层
 *
 * 存储位置：extension_settings.huilin_image（与其它插件同区，互不干扰）
 *
 * 设计原则：所有默认值都写在这里，UI 只负责映射到 DOM；
 * 缺字段一律回落到默认值，避免"用户升级后配置缺项导致崩"。
 */

import { info, warn, STAGE } from './log.js';
import { macroChannel, hash32 } from './util.js';
import { getUserName, getCharName } from './st.js';
import { libraryToPresets, libraryToCats, PRESET_SEED_VERSION } from './outfitLibrary.js';
import { SD_SPEC_V4, SD_SYSTEM_V4, SD_PROTOCOL_V4 } from './sdSpec.js';
import { detectResolutionSelector, RES_DEFAULTS } from './resSelector.js';
/**
 * ★ v0.9.182：画风覆盖层。只改模版**读出来**的那一份，用户存着的模版文本一个字不动
 *   （理由见 stylePreset.js 顶部注释：「改动默认值只影响新装用户」）。
 */
import { applyStylePreset, styleOf } from './stylePreset.js';

export const HUILIN_KEY = 'huilin_image';
export const CONFIG_VERSION = 49;

/** 服装状态位五档 —— 固定枚举，AI 只能从中选，不能自由发挥。 */
export const OUTFIT_STATES = ['intact', 'parted', 'undone', 'removed', 'swapped'];

export const OUTFIT_STATE_LABEL = {
  intact: '完好',
  parted: '半褪',
  undone: '解开',
  removed: '褪下',
  swapped: '已换',
};

/**
 * 服装款式保护级别 —— 治「校服每张图都长不一样」的那个病。
 *
 * 漂移的根因不是"记不住"，而是**款式被当成自由文本、每轮都可能被重写**。
 * 三档的保护强度：
 *
 *   strict  款式完全冻结。只允许状态位推进（完好→半褪→褪下）；
 *           任何对款式文本的改写一律拒绝，包括想换新款。
 *           适合：校服、制服、标志性套装 —— 这个角色的符号，不该变。
 *
 *   normal  默认档。允许"补充式"改写（相似度高，如补上颜色/材质），
 *           拒绝"换款式"改写（相似度过低，如 navy sailor uniform → white shirt）。
 *           要真换衣服必须明确报状态位 swapped，并给出剧情依据。
 *
 *   off     不检查。只靠 AI 自觉 —— 等于不做检查的水平。
 */
export const OUTFIT_LOCK_LEVELS = ['strict', 'normal', 'off'];

export const OUTFIT_LOCK_LABEL = {
  strict: '冻结（款式完全不可改）',
  normal: '防漂移（只允许补充，不允许换款）',
  off: '不检查',
};

/**
 * E1 · 服装款式「跟随剧情 ⇄ 固定」总开关（v0.9.67）。
 *
 * ★ 与上面 OUTFIT_LOCK_LEVELS 的区别（两码事，别合并）：
 *   lockLevel 是**防漂移强度**，管"模型每楼重描述一遍"的噪声，只管款式；
 *   followMode 是**明确的二选一**，fixed = 剧情再怎么写都不改，且状态位另有一档开关。
 *   用户原话：「一个是跟随剧情正文换，一个是固定死的我填的，我需要一个控制按钮切换」。
 */
export const OUTFIT_FOLLOW_MODES = ['auto', 'fixed'];

export const OUTFIT_FOLLOW_LABEL = {
  auto: '跟随剧情',
  fixed: '固定（本楼起沿用我填的，不随剧情改）',
};

/**
 * E2 · 状态位「跟随剧情 ⇄ 锁定当前状态」（v0.9.67）。
 * locked = 半脱/全裸/穿回去都不再跟随剧情，停在用户设定的那一档。
 */
export const OUTFIT_STATE_MODES = ['auto', 'locked'];

export const OUTFIT_STATE_MODE_LABEL = {
  auto: '跟随剧情',
  locked: '锁定当前状态位',
};

/**
 * 服装预设库 —— 把"校服""OL 职场服"这类制式服装做成可复用的命名资产。
 *
 * 为什么需要：`white school uniform` 这两个词在模型眼里对应几百种具体款式，
 * 每次出图都是重新随机诠释一次 —— 这就是"一件校服换了好几个版本"的直接原因。
 * 预设把它落成**一串具体到可复现的描述**，全角色共享、可随时改、改了全体生效。
 *
 * 用法：档案里把某角色的 outfit 设为该预设名，出图时自动展开成完整描述。
 * 预设名以 `@` 开头引用，例如 outfit = `@夏季校服`。
 *
 * v0.9.68：内容改为从 `outfitLibrary.js` 展平（出厂五件套 + K2_V3 款式表 141 条）。
 * ★ F1 口径：这里的值是**英文 tag 串**，中文名只做 UI 标签与 key —— 英文是唯一真值，
 *   因为这条串会原样进画面词；若存中文再逐楼翻译，同一件衣服会翻出不同英文＝制造漂移。
 */
export function defaultOutfitPresets() {
  return libraryToPresets();
}

/**
 * 静态锚点的可绘字段（顺序即渲染顺序）。
 *
 * v0.9.70 新增 `makeup`（妆容）。放在末尾 —— 不动前 7 项的既有顺序，
 * 免得「前面几个 tag 的先后顺序」这种隐性依赖被打乱。
 * ★ 加了它就等于**纳入 D4 硬校验**：模型的改写会被打回，妆容不会自己漂。
 */
export const ANCHOR_FIELDS = ['sex', 'hair', 'eyes', 'face', 'skin', 'body', 'mark', 'makeup'];

export const ANCHOR_FIELD_LABEL = {
  sex: '性别',
  hair: '发型发色',
  makeup: '妆容',
  eyes: '眼睛',
  face: '脸型',
  skin: '肤色',
  body: '体型',
  mark: '标志特征',
};

/** 必填锚点：缺了必须自愈（"不会随便偏移"的最后一道防线）。 */
export const REQUIRED_ANCHORS = ['hair', 'eyes'];

/** 动态状态的自由字段（AI 可报变化，但 locked 条目除外）。 */
export const DYN_FIELDS = ['condition', 'wound', 'mood', 'held', 'location'];

/**
 * ★★ 外貌「状态层」字段（v0.9.70 · 用户 2026-10-04 拍板「人设层 / 状态层拆开」）。
 *
 * 这两个**不进静态锚点** —— 它们会随剧情变（淋雨了、刚 roll 完床单），
 * 一旦进了 ANCHOR_FIELDS 就会被 D4 硬校验当成漂移打回，
 * 于是「头发湿了 / 妆花了」永远生效不了。
 *
 * ★ 但也不是完全自由：报上来的值**必须命中外观库里的档名**，
 *   命不中就是模型在自造词 → 直接丢弃。这叫「允许更新，不允许漂移」。
 */
export const APPEAR_STATE_FIELDS = ['hairState', 'makeupSmudge'];

export const APPEAR_STATE_LABEL = {
  hairState: '发状态',
  makeupSmudge: '花妆',
};

export const DYN_FIELD_LABEL = {
  condition: '状态',
  wound: '伤痕',
  mood: '情绪',
  held: '手持',
  location: '所在',
};

/**
 * SD 口径专属的档案字段（K2 忽略、不进画面）。
 *
 * `loraTrigger` = 角色级 LoRA 触发词（如 `ilshinjouakane`）。
 *   SD/danbooru 口径下必须**紧跟人数词**，让 LoRA 先认到本体；
 *   K2 口径不吃这个（它的 LoRA 走工作流槽位），拼进去只会被当噪声。
 */
export const SD_ONLY_FIELDS = ['loraTrigger'];

export const SD_ONLY_FIELD_LABEL = {
  loraTrigger: 'LoRA 触发词',
};

/**
 * ★★ 档案字段的口径归属（v0.9.96）—— 防止同一份档案在 K2 / SD 之间互串。
 *
 * 为什么需要：字段本身没有「属于哪个口径」的属性，只能由代码声明。
 *   实测病例（2026-10-18）：`anchorOf` 里那句 `if (k === 'sex') continue` 的注释是
 *   「性别由 tag 里的 1girl/1boy 表达」—— 那是 **K2 禁写人数词**（v0.9.65）的延伸。
 *   SD 口径下没人写人数词 ⇒ sex 有数据却永远不输出，画面里没有人数声明。
 *
 * 取值：
 *   'render'   → 拼进画面词
 *   'drop'     → 该口径下丢弃
 *   'count'    → 作为人数词输出（SD）
 *   'internal' → 不进画面，但内部逻辑要读（K2 的性别判断）
 */
export const FIELD_SCOPE = {
  sex: { k2: 'internal', sd: 'count' },
  nlProfile: { k2: 'render', sd: 'drop' },
  loraTrigger: { k2: 'drop', sd: 'render' },
};

/**
 * ★★ 动态字段名（两口径都不许进静态锚点）—— v0.9.96。
 *
 * 实测病例（2026-10-18，角色卡《雾津市播种计划！》）：档案里模型自造了中文键
 * `状态` / `情绪` / `state`，内容是**上一楼的性行为动作与表情**。而 `anchorOf`
 * 只跳过 `nlProfile`，其余自定义字段无差别拼入 ⇒ **上一楼的动作被永久钉进
 * 「跨轮次永不改变」的静态锚点**，之后每张图都带着，还会与新动作叠加。
 *
 * 为什么中文键要单列：`DYN_FIELDS` 只有英文键，而模型建档时写的是中文。
 */
export const DYNAMIC_FIELD_KEYS = [
  ...DYN_FIELDS,
  'state', 'status', 'pose', 'action', 'expression', 'emotion', 'movement', 'gesture',
  '状态', '情绪', '表情', '动作', '姿势', '位置', '神情', '体态', '心情', '神态',
];

/**
 * ★★★ 「由状态机管的键」——静态 fields 里出现这些键时**一律不渲染**（v0.9.132）。
 *
 * 实测病历（2026-10-22 · 楼 190 · 角色卡「催眠APP」）：
 *   月咏深雪的 `fields` 里残留着 `status` / `发状态` / `状态` / `情绪` / `服装状态`，
 *   全都是**前几楼的旧值**。于是档案行同时出现：
 *     `服装状态=intact`（静态残留） … `服装状态=半褪(parted)`（状态机真值）
 *     `状态=bent forward over the steel sink…`（旧楼）… `状态=back against the bed edge…`（本轮）
 *   同一行里三套状态、两个互相矛盾的服装档位 —— 模型只能随手挑一条听，
 *   表现就是用户报的「服装经常串、跟不上」。
 *
 * 判据（不是猜）：这些键**只有动态层有写权限**——
 *   · 服装：`outfit` / `outfitState` / `outfitBare` 由 `updateOutfit` 维护，
 *     渲染统一走 `renderOutfitLine`，静态字段再来一份必然打架；
 *   · 姿态/情绪：`DYNAMIC_FIELD_KEYS` 全部由 AI 每轮覆盖写 `dyn.fields`；
 *   · 外貌状态：`发状态` / `花妆` 由 `appear` 层维护（`APPEAR_STATE_FIELDS`）。
 * 静态库只该存**跨轮不变**的锚点（发色/瞳色/脸型/体型/标志特征），
 * 存了会变的东西＝把上一楼钉成永久真值。
 */
export const STATE_OWNED_FIELD_KEYS = [
  ...DYNAMIC_FIELD_KEYS,
  'outfit', 'outfitState', 'outfitBare', 'outfitPreset', 'outfitDetail', 'outfitMod', 'outfitShoes',
  'bare', 'nude', 'redress',
  '服装', '服装状态', '裸露', '裸露程度', '款式',
  ...APPEAR_STATE_FIELDS,
  ...Object.values(APPEAR_STATE_LABEL),
  '发型状态', '妆容状态',
];

/** 空值哨兵：这些字符串不是画面词，一律丢弃（实测档案里有人把 mark 写成 "none"）。 */
export const EMPTY_SENTINELS = ['none', 'null', 'nil', 'n/a', 'na', '无', '没有', '空', '-', '—', '/'];

/** 该字段在当前口径下的归属。未声明的字段一律 both（进画面）。 */
export function scopeOfField(field, engine) {
  const s = FIELD_SCOPE[field];
  if (!s) return 'render';
  return s[engine === 'k2' ? 'k2' : 'sd'] || 'render';
}

/**
 * 档案里的 `sex` 归一成 danbooru 人数词。宁缺不错：判不出返回空串。
 *
 * 实测存量（59 个角色，2026-10-18）：绝大多数已是 `1girl`/`1boy`；
 * 2 个写成 `girl`/`boy`（补数字）；8 个没填（不输出，由调用方报诊断）。
 */
export function countTagOf(fields) {
  const raw = String(fields?.sex ?? '').trim().toLowerCase();
  if (!raw) return '';
  if (/\b1girl\b|\bgirl\b|\bfemale\b|\bwoman\b|女/.test(raw) && !/1boy|\bboy\b|\bmale\b/.test(raw)) return '1girl';
  if (/\b1boy\b|\bboy\b|\bmale\b|\bman\b|男/.test(raw) && !/1girl|\bgirl\b|\bfemale\b/.test(raw)) return '1boy';
  if (/other|其他/.test(raw)) return '1other';
  return '';
}

export const DEFAULT_SPEC = `# 一致性规范（Krea2 口径）

## 一、静态锚点（跨楼层永不改变，字段照抄，不得改写）

每个角色必须在画面 tag 里带上这些字段的原值：
- hair（发型发色）：必填。写法如 \`long black hair\` / \`short silver hair, bob cut\`
- eyes（眼睛）：必填。写法如 \`red eyes\` / \`blue eyes\`
- face / skin / body / mark：档案里有的就带上

**禁止**：换发色、改发型长度、改瞳色、改体型、改年龄感。
**禁止**：添加档案里没有的永久标志（纹身、伤疤、耳饰）。

## 二、服装层（最容易漂移的地方，请严格照做）

### 2.1 服装是「资产」，不是描述

档案库里给出的 outfit 文本，就是这套衣服的**唯一权威定义**。画面 tag 里必须**逐字照抄**：

- 不得改写、不得同义替换、不得增删元素。
- 「米色针织衫」只能写 \`beige knit sweater\`，不能换成 \`cream knit top\` / \`beige cardigan\`。
- 少写一个元素（比如漏掉 \`dark long skirt\`），画面就只剩上半身或换了一条裙子。
- 多写一个元素（比如自己加 \`black choker\`），下一张图就会多出来、再下一张又消失。

### 2.2 制式服装必须细到六要素 ★

校服、西装、制服、护士服这类**制式服装**，如果只写 \`white school uniform\`，
每次出图都会画出不一样的款式 —— 这是实测出来的漂移头号主因。
遇到制式服装，必须展开成可复现的具体元素：

| 要素 | 写法示例 |
|---|---|
| ① 主色 + 质地 | \`white\`、\`navy blue\`、\`light grey cotton\` |
| ② 领型 | \`sailor collar with double white stripes\` / \`stand collar\` |
| ③ 结 / 领带 / 领巾 | \`red neckerchief\` / \`red striped necktie\` |
| ④ 上衣 | \`short-sleeve blouse with navy cuffs\` |
| ⑤ 下装 + 细节 | \`navy pleated skirt, hem with two white stripes\` |
| ⑥ 袜 + 鞋 | \`white knee-high socks, brown loafers\` |

**六要素齐全，款式才锁得死；缺哪一项，那一项就会每次被随机画。**

补全**只发生在一种情况**：档案里的描述确实是泛称（只有一两个词，如 \`school uniform\` / \`校服\`）。
这时才在 changes 里把它补全成六要素版本。

**已经齐全时必须原样沿用**：档案里的服装已经写明了具体元素（主色、领型、结、上下装、袜鞋），
就逐字照抄，**一个字都不要改** —— 不要"写得更生动"、不要换同义词、不要改配色。

> 实测代价（连着三轮同一件校服）：领结从 \`navy blue ribbon bow tie\` 变成
> \`dark red ribbon bow\` 又变成 \`red ribbon necktie\`，tag 长度也从 473 涨到 901 字符。
> **改一个颜色，等于换了一件衣服。**

### 2.3 状态位（随剧情推进，只能前进）

服装是独立维度，每次出现都要写清楚「穿什么 + 处于哪一档」：

| 状态位 | 含义 | 可绘写法 | 绝对不要用 |
|---|---|---|---|
| intact | 完好 | 正常穿着，**不加任何状态词** | — |
| parted | 半褪 | \`clothes partially slid down\` \`sleeves slipping\` | \`naked\` |
| undone | 解开 | \`shirt partially unbuttoned\` \`collar open\` \`buttons undone\` | 裸用 \`unbuttoned\`（会被画成完全敞开） |
| removed | 褪下 | \`clothes removed\` \`undressed\` | — |
| swapped | 已换 | 换成另一套（必须同时给新的 style） | — |

> ⚠️ 措辞直接决定画面尺度。裸用 \`unbuttoned\` / \`unfastened\` 实测会被 Krea2
> 理解成「衣服完全敞开」而画出裸露 —— 但 \`undone\` 的语义只是「解开了扣子、
> 衣服还在身上」。必须带 \`partially\` / \`partly\` + 保留衣物在场的描述。

**规则**：
1. 状态位只能**前进**（intact → parted → undone → removed）。要回退必须在理由里说明（重新穿好）。
2. 状态位前进时，**原款式一个字都不能改** —— 半褪的仍是那件白衬衫，还是那两个袖子、那个领子。
3. 换成新衣服（swapped）时，**新款式必须来自剧情原文**，不得自行编造；且要按 2.2 的六要素写全。
4. 同一段落里只描述一次服装状态，不要上半句说穿着、下半句说褪了。
5. **配件不算状态位**：脱鞋、脱袜、摘手套、取下发饰这类配件变化，
   用 \`shoes off\` / \`barefoot\` / \`gloves off\` 单独描述，**不要把状态位推进到 parted**。
   > 实测踩过：正文只写了脱鞋，模型却给整件衣服挂上 \`clothes partially slid down\`，
   > 之后每一楼都带着这句，与剧情无关。

## 三、画面写法（Krea2 口径）

### 3.1 分工
- \`tag\`（英文短 tag）=**画面上有什么**：人数、构图、外貌、服装、动作姿态、表情视线、场景。
- \`nl\`（中文）=**怎么拍、什么气氛**：光影方向与色温、环境质感、色调、情绪收口。
- 两者描述同一画面、**互补而不复述**。

### 3.2 tag 顺序与上限
按「人数/主体 → 构图景别 → 外貌 → 服饰 → 动作姿态 → 表情视线 → 场景 → 光线氛围」排。
**单画面 40 个 tag 以内、总长 420 字符以内**；超了先删重复，再删最次要的环境词 ——
**锚点（发色/瞳色/服装）一个都不能删**。
- 动作区第一条必须是本画面的核心动作（谁做了什么、身体哪个部位接触了什么），
  辅助姿态（站着、坐着、跪着）排后面；同一动作词不得写两遍。
- 同一意思不换写法重复写（写了 \`shoes off\` 就别再写 \`standing barefoot\`、\`standing_in_tights\`）。
- **多人画面不按这条排** —— 多人时以 3.6 的分段骨架为准。

### 3.3 承重面与手位（缺一项必崩）
- **承重面必写**：靠什么撑住身体 —— \`kneeling on the wooden floor\` / \`sitting on the bed edge\`
  / \`back against the wall\` / \`weight on her left leg\`。没有承重面的身体一定画崩。
- **手位必写**：两只手分别在哪、在做什么 —— \`holding a phone in her left hand\`
  / \`both hands at her sides\` / \`fingers gripping the sheet\`。只写姿态不写手位，手必崩。

### 3.4 景别（只写一个）
\`close-up\` / \`upper body\` / \`medium shot\` / \`full body\` / \`wide shot\` **只能写一个** ——
同时写两个，模型会不知道画到哪里，把人截断或拼错。
- 景别必须容得下核心动作：接触点在躯干以下时，禁用 \`close-up\` / \`upper body\`。
- 景别与身体 tag 一致：选了 \`upper body\` 就别再写鞋袜、裙长、腿部这类画面外的部位 ——
  写了画面里没有的部位，模型会硬塞一块进去。

### 3.5 表情与视线（每张图都要写）
- 表情用模型认得的**标准 danbooru 词**（\`smile\` \`blush\` \`frown\` \`surprised\`
  \`half-closed eyes\` \`open mouth\` \`expressionless\` …），可叠加 1~2 个。
  **不要自创描述性词组**（"gentle smile" 写 \`smile\`；那种词组模型不认识，只会稀释其余 tag）。
  面无表情也要显式写 \`expressionless\`。
- 视线选一个：\`looking at viewer\` / \`looking at another\` / \`looking away\`
  / \`looking down\` / \`looking up\` / \`closed eyes\`。

### 3.6 多人画面（两人及以上）★ 双人错乱重灾区，必须分段
- 人数 tag 必须明确（\`2girls\`、\`1boy 1girl\`），缺了会漏画或多画。

**★ 分段骨架（照抄这个结构，禁止交错）**：每个角色独立成段，下一段**必须重新以人数词开头**
—— 模型靠「人数词开启新段」来切分特征归属：

\`1boy, <男主发色瞳色>, <男主服装（带 male 限定）>, <男主动作（带 his）>, <男主表情视线>, 1girl, <女主发色瞳色>, <女主服装（带 female 限定）>, <女主动作（带 her）>, <女主表情视线>, <构图景别>, <场景>, <光线氛围>\`

- **两人特征严禁交错**：男主发色后面紧跟女主发色、再回头写男主服装 = 必错乱
  （实测：男主的 short black hair 和女主的 long black hair 混排后，发型互相污染）。
- **服装必须带性别限定**：\`male school uniform\` / \`female school uniform\`、
  \`his black blazer\` / \`her navy pleated skirt\` —— 裸写 \`school uniform\` 等于让两个人平分一件衣服。
- 动作、表情、视线、体型都要带主人：\`holding out a phone in his right hand\` /
  \`her arms hanging at her sides\`。表情与视线**每人各一份**。
- 共有特征只写一次（都是长发写一个 \`long hair\`）。
- **公共区只放全员共享项**（构图景别、场景、光线、氛围），放在所有角色段之后。
- 不认识 \`+\` \`（）\`分组这类自创符号 —— 分段靠人数词，归属靠 his/her。

正例（照抄结构）：
\`1boy, short black hair, dark eyes, male uniform (black blazer, white shirt, navy trousers), holding out a phone in his right hand, expressionless, 1girl, long black hair, blue eyes, female uniform (white blouse buttoned to the top, navy ribbon tie, navy pleated skirt, black tights), hypnotized, dilated pupils, her arms hanging at her sides, medium shot, school rooftop, chain-link fence, gusty wind, overcast daylight\`

反例（禁止）：
\`1boy 1girl, short black hair, dark eyes, holding out a phone, long black hair, blue eyes, white school uniform blouse, navy pleated skirt, hypnotized, ...\`
—— 外貌交错、服装无主、代词混乱，归属全靠模型猜，猜错就换人穿衣服。

### 3.7 禁止项
- **禁止否定句**（\`no shoes\` 会被画成有鞋）。要否定就把对应内容不写 —— 提什么画什么。
- **禁止画风词与质量词**（\`masterpiece\` \`best quality\` \`8k\` \`anime style\` 等）——
  画风由工作流底模与 LoRA 锁定，写进提示词只会和它打架。
- **肤色以档案库的 skin 字段为准**：库里有就照抄那个值；库里没给就不写肤色词。
  不要自行添加档案库没有的肤色描述。（档案库属于人设主权区，规范不覆盖它。）
- **禁止中文进 tag**（含状态、情绪、心理描述）—— 中文只写在 \`nl\` 里。
  > 实测：状态位被写成中文"催眠状态中，瞳孔扩散…"后混进 tag，K2 会当乱码处理。
- **禁止跨图引用**：「承接上一张」「与上张一致」「同上」「略」都不许写 ——
  每张图都是独立生成的一张完整画面，提示词里不能出现指向别的图的代词。
  > v0.9.52 口径更正：你现在**能看见**「近期已出过的图」摘要（用户消息里若有该段）。
  > 它给你的是**已经确立的画面事实**（谁在场、穿什么、留下过什么痕迹），
  > 用途是"别重复、别自相矛盾"，**不是让你照抄** —— 照抄 = 重复出图，比不知道更糟。
- **禁止画外内容**：谁在按快门、机位架在哪、看不见的心理因果，一律不写。

### 3.8 画面补全
正文是小说不是分镜脚本，不会写镜头、光线、景深 —— **这些由你主动补全**：
每个画面都要给出镜头距离、光线与时间、氛围色调，正文没写不是不写的理由。
但「画面里有什么」必须以正文与设定为准，不得借补全之名编造人物、动作或情节。
> 一句话：**怎么拍**可以主动具体化；**画面里有什么**必须以正文为准。`;

export const DEFAULT_PROTOCOL = `# 输出协议（不要删除本节）

只输出一个 JSON 对象，不要 Markdown 代码块，不要解释。

\`\`\`json
{
  "changes": [
    { "name": "角色名", "kind": "new",   "fields": { "hair": "...", "eyes": "...", "outfit": "..." } },
    { "name": "角色名", "kind": "set",   "fields": { "outfit": "...", "outfitState": "parted" } },
    { "name": "角色名", "kind": "state", "fields": { "condition": "...", "mood": "..." } }
  ],
  "images": [
    { "position": "P3", "tag": "1girl, @角色名, sitting_on_bed, morning_light", "nl": "女孩坐在床边，晨光从窗帘缝隙照进来。" }
  ]
}
\`\`\`

字段说明：
- \`changes[].kind\`：
  - \`new\` —— 本楼首次出现的角色，给出静态锚点字段（hair/eyes/face/skin/body/mark）。全楼生效。
  - \`set\` —— 永久性变化（染发、留疤、换装）。**只对 position 之后的画面生效**，必须带 \`position\` 指明从哪一段开始。
  - \`state\` —— 临时状态（情绪、伤势、手持物）。只对当前楼生效。
  - \`merge\` —— 同人归并（v0.9.50）：正文有明确证据说明两条档案是同一人时，输出 \`{"name":"<保留名>","kind":"merge","from":"<被并名>"}\`。没有证据不要输出。
- 字段归属（2026-09-26 起严格执行）：
  - \`face\` 只写**面容类型 / 年龄段**：loli face / young face / mature face / oval face。
  - **眼镜、眼罩、帽子、耳机、口罩等穿戴物件一律写 \`mark\`**，不要写 face 或 eyes；
  - \`hair\` 只放发型/发色/长度，瞳色写 \`eyes\`。
- \`changes[].position\`：\`set\` 类必填，写生效起点的段落 ID（如 \`P4\`）。
- \`changes[].locked\` 字段：若档案里标记了 \`[locked]\`，**不要对它产生任何 change**。
- \`images[].position\`：必须是本次正文里出现过的段落 ID，不得引用历史楼层、不得编造。
- \`images[].tag\`：英文短 tag，逗号分隔。角色用 \`@角色名\` 引用（插件会展开成完整锚点）。
- \`images[].nl\`：中文自然语言，与 tag 描述同一画面、互补不重复。
- ★ **跨图：构图换，状态留**（v0.9.101，所有 K2 模版通用）：
  - **构图**（机位 / 景别 / 同一个瞬间的措辞）—— 上一张画过就换，不复述；
  - **状态**（正在进行的动作与体位、已脱到的程度、已确立的接触点、已留下的痕迹）——
    这一楼还在这场戏里，就必须**再写一遍**（K2 写进 \`cast[].en\` 的姿态句）。
  - \`tag\` / \`cast[].en\` 是**逐张独立生成**的，模型不会记得上一张：**不写 ≠ 延续，等于这张图里没有这件事**。
  - 判据：把这条删掉，这张图还成立吗？不成立 = 必须写；只是换个机位也成立 = 才是可选细节。
- 不需要配图时返回 \`{"changes":[...],"images":[]}\`。
- 图片数量不得超过设置的「单楼最大图片数」。`;

/* ══════════════════════════════════════════════════════════════════════════
 * MOSS 基础协议 = DEFAULT_PROTOCOL 去掉 K2 专属写法（v0.9.162）
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * ★★★ v0.9.162：MOSS 模版**不能**直接用 `DEFAULT_PROTOCOL`。
 *
 * 4 份 MOSS 模版都是 `DEFAULT_PROTOCOL + MOSS 自己的 addon` 拼出来的，而 `prompts.js` 会把
 * `tpl.protocol` **原样**拼进提示词 ⇒ 三条与 MOSS 规范**直接相反**的句子会同时到达模型。
 * 记忆里的头号方法论：**两条规则互相抵消时，模型只挑一条听** —— 比两条都错更难查。
 *
 * 三条冲突（每条都有本仓原文兜底）：
 *   ① 示例 `"tag": "1girl, @角色名, sitting_on_bed, morning_light"` 与
 *      「英文短 tag，逗号分隔。角色用 `@角色名` 引用」
 *      —— MOSS 三份 addon 全写着「禁止 `@角色名`」，且 MOSS 的 tag 是**整段自然语**不是逗号 tag。
 *   ② 「`images[].nl`：中文自然语言，与 tag 描述同一画面」
 *      —— MOSS 三份 addon 全写着「**不要**输出 `tag` / `nl`」。
 *   ③ 「构图（**机位 / 景别** / 同一个瞬间的措辞）—— 上一张画过就换」
 *      —— 单图 system + spec §2.2 明令「🚫 不写景别、不写机位」。
 *
 * 处理方式：**只做三处精确替换**。下面这些**一字不动**（MOSS 同样依赖）：
 *   `changes[]` 全部字段说明（角色档案 + 服装状态就靠它）、`locked` 规则、
 *   「不需要配图时返回…」、「图片数量不得超过…」。
 *
 * ★ 为什么用锚点表而不是手抄一整份：手抄 = 以后改 `DEFAULT_PROTOCOL` 时 MOSS 那份会
 *   **静默落后**（记忆里「改动零生效」已出现三种形态）。锚点命中不上时
 *   `MOSS_BASE_PROTOCOL_MISSING` 非空 + `console.error` + dev 测试直接红 —— **不许静默**。
 */
const MOSS_PROTOCOL_PATCHES = [
  {
    name: 'images 示例里的 tag / nl',
    from: '    { "position": "P3", "tag": "1girl, @角色名, sitting_on_bed, morning_light", "nl": "女孩坐在床边，晨光从窗帘缝隙照进来。" }',
    to: '    { "position": "P3" }',
  },
  {
    name: 'tag / nl 两条字段说明',
    from: '- `images[].tag`：英文短 tag，逗号分隔。角色用 `@角色名` 引用（插件会展开成完整锚点）。\n'
      + '- `images[].nl`：中文自然语言，与 tag 描述同一画面、互补不重复。',
    to: '- `images[]` **除 `position` 外的字段**（`tag` / `cast` / `layout`）由下面「本模版专属」'
      + '那一节规定，**以那一节为准**；本节只管 `position` 与 `changes`。',
  },
  {
    name: '跨图段里的「机位 / 景别」与 cast[].en',
    from: '- ★ **跨图：构图换，状态留**（v0.9.101，所有 K2 模版通用）：\n'
      + '  - **构图**（机位 / 景别 / 同一个瞬间的措辞）—— 上一张画过就换，不复述；\n'
      + '  - **状态**（正在进行的动作与体位、已脱到的程度、已确立的接触点、已留下的痕迹）——\n'
      + '    这一楼还在这场戏里，就必须**再写一遍**（K2 写进 `cast[].en` 的姿态句）。\n'
      + '  - `tag` / `cast[].en` 是**逐张独立生成**的，模型不会记得上一张：**不写 ≠ 延续，等于这张图里没有这件事**。\n'
      + '  - 判据：把这条删掉，这张图还成立吗？不成立 = 必须写；只是换个机位也成立 = 才是可选细节。',
    to: '- ★ **跨图：构图换，状态留**（v0.9.101）：\n'
      + '  - **构图**（取景距离与角度 / 同一个瞬间的措辞）—— 上一张画过就换，不复述；\n'
      + '  - **状态**（正在进行的动作与体位、已脱到的程度、已确立的接触点、已留下的痕迹）——\n'
      + '    这一楼还在这场戏里，就必须**再写一遍**（写进你这张图的画面描述里）。\n'
      + '  - 每张图的画面描述都是**逐张独立生成**的，模型不会记得上一张：**不写 ≠ 延续，等于这张图里没有这件事**。\n'
      + '  - 判据：把这条删掉，这张图还成立吗？不成立 = 必须写；只是换个视角也成立 = 才是可选细节。',
  },
];

/** 锚点命中失败的名字列表（空 = 全部命中）。给 dev 测试断言用，也用于运行时告警。 */
export const MOSS_BASE_PROTOCOL_MISSING = [];

/**
 * 把任意一段 protocol 文本里的 K2 专属写法换成 MOSS 口径。
 *
 * 为什么要做成函数而不是只算一次：老迁移分支（`v < 40` 那几档）是
 * `用户旧 protocol + MOSS addon` 拼的，那些出口同样会把 K2 冲突段带进去。
 * 只修出厂构造、不修迁移出口 = 记忆里「改动零生效」的第四种形态。
 *
 * @param {string} text 待修正的 protocol 文本
 * @param {string} [where] 出错时标注来源，便于定位是哪条出口
 */
export function applyMossProtocolPatches(text, where = 'MOSS_BASE_PROTOCOL') {
  let s = String(text || '');
  for (const p of MOSS_PROTOCOL_PATCHES) {
    if (!s.includes(p.from)) continue;
    s = s.replace(p.from, p.to);
  }
  return s;
}

export const MOSS_BASE_PROTOCOL = (() => {
  let s = DEFAULT_PROTOCOL;
  for (const p of MOSS_PROTOCOL_PATCHES) {
    if (!s.includes(p.from)) {
      MOSS_BASE_PROTOCOL_MISSING.push(p.name);
      continue;
    }
    s = s.replace(p.from, p.to);
  }
  if (MOSS_BASE_PROTOCOL_MISSING.length) {
    /* 不抛异常（抛了整个插件加载就挂），但绝不静默：报错 + 测试红。 */
    console.error('[绘灵] MOSS 基础协议锚点失配，以下替换没生效：'
      + MOSS_BASE_PROTOCOL_MISSING.join('、') + '（DEFAULT_PROTOCOL 被改过？）');
  }
  return s;
})();

/* ============ K2 中英混合模版（v0.9.14 · 第二/三套出厂模版） ============ */

/**
 * 两套 K2 出厂模版（2026-09-26 三版对照 + 35 张效果对比实测，产物见
 * F:/AI相关下载/K2/人像提示词/Krea2提示词改写-修女教堂图书馆-三版对照.md
 * 与 F:/AI相关下载/K2/人像提示词/提示词效果对比/效果对比分析报告.md）：
 *
 *   - 「K2 中英混合」（去风格化）：英文段 + 中文段拼接；不写画风/质量/胶片词，
 *     风格由「全局词库」后缀统一控制 —— 换风格只改后缀。
 *   - 「K2 中英混合（带风格化）」：同上，但每图强制前置写实锚定块（v4 定稿：
 *     纯正面表述，实测含 no cartoon 三连的旧锚定块是反向污染）、中文段以
 *     「电影感写实摄影，真实的胶片质感与皮肤纹理」收口。
 *
 * 核心实测结论（与默认模版的本质差异）：
 *   1. Krea2 的文本编码器是 Qwen 系 —— 吃连贯句子，不吃逗号堆叠 tag。
 *   2. 中英混合在 35 张对比里总分胜出（写实度唯一拉开档位的维度）。
 *   3. Krea2 在 CFG=1 的工作流里 negative prompt 不生效 —— 排除项一律正面表述；
 *      且否定词写进正向句会被读成概念本身（no cartoon → 画出 cartoon 倾向）。
 *   4. 复杂场景（双人+双服装+复杂姿态）固定 250~350 词，精简版服装必崩。
 *   5. 成年锚定必写（合规底线 + 防成年角色被画幼）。
 *
 * §3.6 标题刻意不用「多人画面」字样：避免默认模版未来 §3.6 定点升级
 * （specSection36 按「### 3.6 多人画面」匹配）把 K2 句式版覆盖成 tag 堆叠版。
 */

/** K2 模版 §三（画面写法）。styled=true 输出带风格化版（写实锚定块 + 风格词许可）。 */
function k2SpecSection3(styled) {
  return [
    styled
      ? '## 三、画面写法（K2 中英混合口径 · 带风格化 ★ 本模版专属）'
      : '## 三、画面写法（K2 中英混合口径 ★ 本模版专属）',
    '',
    '> 本模版与「默认」模版的根本区别（2026-09-26 共 35 张对照实测 + v4 定稿复刻）：',
    '> 最终提示词 = **中英交错的多段结构**，每一段都是**连贯句子** ——',
    '> Krea2 的文本编码器（Qwen 系）吃句子，不吃 `1boy, oval face, F cup` 这种逗号堆叠 tag；',
    '> 且**中文段的位置有讲究**：场景段在前、人物段居中、情绪段收尾 —— 顺序错了权重就乱',
    '> （实测：英文串全在前 + 中文整段追加在末尾，肢体扭曲率明显升高）。',
    '',
    '### 3.1 分工与拼装顺序（v4 定稿结构，插件的拼装顺序不可更改）',
    '- 每张图你输出**两个**内容字段（`scene` / `tag`），插件按下面的固定顺序拼成最终提示词：',
    '  ```',
    '  ' + (styled ? '〔写实锚定块〕（插件自动加，你不要写）' : '〔全局词库后缀（风格）〕（插件自动加）'),
    '  〔scene〕  中文 —— 场景 / 光线 / 氛围（不写景别，见 3.5）',
    '  〔人物段〕  按角色分块 —— 每人两行，插件拼装（你只负责 cast 里的英文句）：',
    '     A角色中文外貌行（插件从档案注入）',
    '     A角色的英文句（cast[0].en）',
    '     B角色中文外貌行（插件从档案注入）',
    '     B角色的英文句（cast[1].en）',
    '  〔tag〕    英文 —— 人数 + 两人交互 + 情绪张力（末句，见 3.6）',
    '  ```',
    '- **按角色分块**（v0.9.25 定稿）：每个出场角色的**外貌与他的动作/服装/手位是同一块**，',
    '  A 的动作紧跟 A 的外貌写完后，才接 B 的外貌 + B 的动作。',
    '  旧写法（外貌段整体在前、动作段整体在后）实测会让第二个角色只剩一句「一位男性」的概括 ——',
    '  因为英文句里的 `her` / `his` 插件猜不出指的是谁，只能把外貌挂在第一人身上。',
    '  要做到这点你必须写 `images[].cast`（见输出协议）—— 那是「画面里有谁」的权威来源。',
    '- **两个字段各司其职，重复即扣分**：中文段不复述英文段，英文段不写外貌',
    '  （外貌由人物锚点段承担，你在英文句里写外貌会跟锚点段打架，权重翻倍）。',
    '- **官方文档印证这套分工**：Krea 2 官方建议「subject + visible action → frame → light →',
    '  material → palette」的连贯描述；机位/光线/材质/氛围属画面语言，中英任何一段写都行，',
    '  但本项目实测**中文扛机位/场景/光线/氛围、英文扛服装/姿态**是最稳的分配 —— 不要越界。',
    '- **没有独立的中文情绪段了** —— 情绪与张力写在 `tag` 英文段的**最后一句**（3.6）。',
    '  为什么砍掉（2026-09-27 用户实测）：末尾的中文段和英文段**复述同一件事**（动作 / 手位 / 身体状态），',
    '  模型会把这句复述当成**又一次动作请求**，把动作与物体**复制成多份** —— 实测「英文写双手端碗 +',
    '  中文写强撑着端稳那只碗」直接多长出一只手；中文还在末尾＝权重最高位，污染被进一步放大。',
    '  情绪这类抽象信息用英文一句说完就够，不需要中文再说第二遍。',
    '- `mood` / `nl` 字段已废弃：**不要输出**；万一输出了插件会整段丢弃（日志有提示）。',
    '',
    '### 3.2 scene（中文 · 场景与氛围）',
    '- **连贯中文句**，写：地点与陈设、光线与时间、氛围色调。',
    '- **不写景别、不写裁切边界**（2026-09-27 用户实测推翻「写死裁切」补丁：景别词是畸变源，',
    '  交给模型按动作自己决定取景最稳 —— 见 3.5）。',
    '- **不写人物外貌、不写服装** —— 那是人物锚点段和英文段的地盘。',
    '- **不写人物动作与姿态**（2026-10-01 新增）—— 动作与身体姿态只写在英文段（`cast[].en` 与 `tag`）。',
    '  中文 scene 写「他从背后压住她」这类姿态句，会和英文段**各立一套几何**，模型在两套之间找补，',
    '  实测补出俯卧撑式叠压（总库结论：缺姿态句模型会拿中文段去补；有姿态句中文再去补就是第二套）。',
    '',
    '### 3.3 tag（英文 · 服装与动作）',
    '- **连贯英文句子（2~6 句），禁止逗号堆叠 tag**。',
    '  反例：`1girl, brown eyes, glasses, sitting on his lap, surprised`；',
    '  正例：`She wears a black-and-white cotton nun habit with a white coif and veil, and sits on his lap on the floor, both hands braced on his shoulders.`',
    '- **第一句 = 主体 + 核心动作**（官方口径：主体动作放最前，权重最高；多人时第一句同时写明人数）。',
    '- **只写四件事**：①服装（逐件写全，含鞋袜，逐字沿用档案库的 outfit 值，只改句式不改内容）；',
    '  ②动作与姿态（承重面、两只手的位置、身体接触点）；③表情与视线（融进句子）；',
    '  ④情绪与张力（**末句**，英文一句，逐人带主人 —— 见 3.6）。',
    '- **禁止写外貌**（发型/发色/瞳色/胸型/体型）—— 外貌由插件从档案生成中文人物段，',
    '  你再写一遍就是重复权重（实测直接导致肢体扭曲）。',
    '- `@角色名` 仍可写（用于标记谁出场，插件会剥掉记号、把外貌拼进人物段），但句子本身要完整。',
    '- **年龄锚定按「外表年龄」三档写**（2026-09-28 定稿，**一律不写 `adult`**）：',
    '  - 人物段是「一位少年 / 少女 / 男孩 / 女孩」（外表年轻）→ `young man` / `young woman` / `young fairy`；',
    '  - 人物段写「成熟 / 年长 / 中年」（外表达观）→ `mature man` / `mature woman`；',
    '  - 人物段**没有年龄措辞**（只有「一位男性 / 一位女性」）→ **光杆 `a man` / `a woman`**，不写年龄词。',
    '  🚫 **`adult` 二字一律不写** —— 2026-09-27 实测定稿：「成年」这个措辞会让模型把**脸画老、',
    '    体型画壮**，是核心崩因。想表达「不是小孩」靠上面三档，不靠这个词。',
    '    合规由硬边界兜底（NSFW 版见 §3.9 ①），不在措辞上叠年龄词。',
    '  - 名词跟种族走：人类 `man` / `woman`；非人种族 `fairy` / `elf` / `beast-girl` 等。',
    '  ⚠️ 身份词必须与人物段一致：档案是「体型娇小的精灵」就写 `the tiny fairy`，',
    '  写宽泛的人类身份词（如 `a woman`）会跟人物段的精灵描述各立一个实体（实测多画一只精灵）。',
    '  （`clearly masculine adult male build` 是**体型锚定**、防男角被读成女性化，不受本条约束。）',
    '- **英文句不得复述人物段已经写过的外貌要素**（2026-09-28 新增）—— 人物段（插件注入）',
    '  是外貌的唯一来源，已含发色发型 / 瞳色 / 体型 / 胸型 / 服装 / 种族特征（翅膀、尾巴、兽耳）。',
    '  英文句只写**动作、姿态、手位、承重面、视线、情绪**，不要再说一遍这些外貌特征：',
    '  ⚠️ **尤其翅膀**（精灵 / 天使 / 恶魔类）：人物段写了「背后生有半透明翅膀」后，',
    '  英文句再写 `Her wings stay half-folded behind her back` = 翅膀被描述两次，',
    '  实测与手臂混淆、多长出多余的手（2026-09-28 用户翻车图：小精灵多手）。',
    '  要表达翅膀状态就并入动作句一笔带过，或干脆不写。',
    '- **防崩正面表述清单（实测出来的高危词替换表）**：',
    '  - 口部：`open mouth` → `her lips slightly parted in surprise`；干净口部写 `her mouth clean without any drool`；',
    '  - 勒痕/压痕：禁用 `red marks`（被读成红色抓痕/血痕）→ `the tight stocking band pressing faint pink indentation lines into her thighs`；',
    '  - 长袜：要「不透肉」必须显式写 `black opaque thigh-high stockings, opaque fabric`（裸写 thigh-high socks 会被画成半透明丝袜）；',
    '  - 干燥锚（防水珠残留）：`her skin matte and dry, clean and free of any moisture`；',
    '  - 男角平衡：外貌偏阴柔时补 `clearly masculine adult male build`（实测男角普遍被读成女性化）。',
    '- **排除项一律用正面表述写进正向句** —— **Krea2 在 CFG=1 的工作流里 negative prompt 不生效**，',
    '  且否定词写进正向句会被读成概念本身（见 3.1 锚定块教训）。',
    '',
    '### 3.4 承重面与手位（缺一项必崩）',
    '- **承重面必写**：靠什么撑住身体 —— `kneeling on the wooden floor` / `sitting on the bed edge`',
    '  / `back against the wall` / `weight on her left leg`。没有承重面的身体一定画崩。',
    '- **手位必写**：手在哪、在做什么 —— `holding a phone in her left hand`',
    '  / `both hands at her sides` / `fingers gripping the sheet`。只写姿态不写手位，手必崩。',
    '  ★ **但「两只手都点名」不是必须的**（2026-09-28 定稿）：只写**一只手**的落点也算交代了手位，',
    '  而且**更稳** —— 另一只手交给模型（默认自然下垂 / 插兜 / 撑物），比写错稳得多。详见 3.4b 三档。',
    '',
    '### 3.4b 手位的**写法**（★ 2026-09-28 重写 —— 老规则本身会造出第三只手）',
    '⚠️ **本节于 2026-09-28 被推翻重写**。老规则教的是「用 `both hands ...` 定整体，再用',
    '`his left ..., his right ...` 从属分配」—— 用户**照这条写**照样长出第三只手：',
    '❌ `both hands raised — his right drawing the curtain open just a little, his left resting flat on the sill`',
    '根因：`both hands raised` 是**状态声明**（双手都在高处），`his left resting flat on the sill` 是',
    '**位置声明**（左手在窗台）。**两份声明几何一冲突，K2 不会取其一，而是多长一只手去满足第二份。**',
    '- **★ 肢体单一声明律（第一原则）**：成对身体部位（手 / 臂 / 腿 / 脚 / 膝）在同一句里',
    '  **只允许一套几何**。叠写（总括 + 分项）时两份**必须自洽**，否则必崩。',
    '- **三档写法（按稳定性排序）**：',
    '  - **A 档 · 最稳｜只写一只**：`one hand drawing the curtain open just a little`（另一只**完全不提**）。',
    '    只有一只手承担关键动作时**默认选它**。',
    '  - **B 档 · 稳｜分工不指定左右**：`one hand ..., the other hand ...`。两只手分工、',
    '    且画面不需要交代左右时用 —— 模型自由分配左右，最不容易打架。',
    '  - **C 档 · 必须自洽｜定侧或同动作**：`both hands + 同一个动作`（`both hands gripping the sheets`）',
    '    ／ `his right hand ..., his left hand ...`（只在**必须交代左右**时用：POV 自视角 / 过肩 / 双人接触点）。',
    '    ⚠️ 用 C 档时**总括句的高度与状态必须和分项一致** —— 写 `both hands raised` 就别让左手落在窗台。',
    '- **沿用至今的正确洞察（仍然成立）**：❌ 两个各自带主语的独立小句并列',
    '  （`His left hand rests on the edge of the curtain, his right hand hangs over his knee`）',
    '  会被读成**两个独立的手部实体** → 多长一只。**这与单一声明律不冲突**：',
    '  两句并列是「句内复制」，总括 + 分项是「双重声明」，**两种都要避免**。',
    '- **判据（写完数一遍）**：这一句里「手」被声明了几次？',
    '  **1 次** → 合格；**2 次且几何自洽** → 合格；**2 次且几何冲突** → **删掉总括句**。',
    '- **★ POV 下左右手怎么选（2026-09-28 定稿 · POV 有两种，写法相反）**：',
    '  - **① POV 自视角**（相机＝我的双眼，**我的**手从画面边缘入画）→ ✅ 可写左右',
    '    （`his hands entering the frame from the left and right edges`），但仍**禁叠总括句**；',
    '  - **② POV 看他**（相机＝我的双眼，我看着**对面那个人**）→ 🚫 **别写他的左右**：',
    '    **镜像歧义** —— 他面对我时他的右手出现在画面**左侧**，模型不知道按「他的右手」还是',
    '    「画面右侧」落笔，两种读法打架 → 手臂扭曲 / 多肢。**改 A 档或 B 档。**',
    '  - **判据一句话：这只手是「我的」还是「我看着那个人的」？我的 → 可写左右；对方的 → 不写左右。**',
    '- **★ 腿 / 脚 / 膝同理**：`both legs` 与分项句不得同现；`her legs spread wide open` 之后再叠',
    '  单膝 / 落点 / 遮挡说明，属同一类违规（腿的修饰词写完超过**一个词组**就删）。',
    '- **慎写「手 + 精细边界」的接触点**（沿用）：`the edge of the curtain` / `the hem of her skirt`。',
    '  那等于给模型一个「这里需要一只手来交代」的强指令 —— 手上已有去处时再挂接触点，就会被补出多余的手。',
    '  非关键道具宁可写虚：`his left hand rests at his side`。',
    '- **底层机理（与 3.1 的中英复述是同一个）**：凡是让模型把一个「部分」读成「独立实体」的写法，',
    '  都会导致该部位被复制 —— 中英复述是跨段复制，手位并列是**句内复制**，总括 + 分项是**双重声明**。',
    '',
    '### 3.5 景别（默认不写 ★ 2026-09-27 实测定稿）',
    '- **不要写景别、不要写裁切边界** —— 这是最新的实测结论，推翻早期「写死裁切」的补丁：',
    '  写了景别（如「中景，从膝盖上方切到头顶上方」）经常和动作描述打架，产生肢体畸变；',
    '  而不带景别词的版本（模型自由取景）反而稳。取景交给模型按动作自己决定。',
    '- **唯一例外**：当你明确只要某个部位（如只要脸和胸的特写）且画面里**没有任何**下半身动作时，',
    '  可以写一个与动作完全兼容的粗景别（`upper body close-up`）—— 写之前先自查：',
    '  把景别词删掉，句子里的每个动作是否还成立？有不成立的就说明在打架，删动作或删景别，二选一。',
    '- 「景别必须容得下核心动作」这条仍然成立（实测 35 张里「上半身景别 + 掀裙露长袜」全军覆没），',
    '  但最优解是**不设景别**让动作自己决定取景，而不是精心计算一个兼容的裁切边界。',
    '',
    '### 3.6 表情、视线与情绪张力（每张图都要写，融进英文句子）',
    '- `she looks down at him, flushed and flustered` /',
    '  `he stays expressionless, looking up at her`。面无表情也要显式写 `expressionless`。',
    '- 视线每图选一个方向：看镜头 / 看对方 / 看别处 / 看下 / 看上 / 闭眼。凝视关系实测执行率高，照常写。',
    '- **情绪与张力写在 `tag` 的最后一句（英文）**：`she looks flustered and desperate` /',
    '  `he stays stiff, jaw tight, barely holding himself together`。',
    '- **情绪只写画面上看得出来的**：表情、眼神、肌肉紧绷、呼吸起伏、脸颊泛红。',
    '  **禁止写声音 / 气味 / 触觉 / 心理因果**（「汤碗轻晃的声音」「薄荷牙膏的气息」「掌心湿热」',
    '  「熟练而隐秘」）—— 图像模型画不出来，是纯噪声，还会反向污染画面',
    '  （「湿热」「粘稠」「湿润的触感」会和皮肤干燥锚直接打架，实测出过汗湿与湿气）。',
    '- **禁止复述**：`tag` 里已经写过的动作、手位、承重、服装、皮肤状态，不再用任何语言写第二遍 ——',
    '  重复 = 让模型把动作与物体复制成多份（多手 / 多头 / 多一个道具），不是加权。',
    '- **★ 同一个词不许在一句里出现两次**（2026-09-28 新增）：',
    '  `with an unreadable face` + `eyes half-lidded and unreadable` —— 同一形容词重复 = **双重加权**，',
    '  模型会把该特征画过头并带出畸变；`looks out` 与 `watches` 属同义动作重复，删一留一。',
    '  **一条提示词里，同一形容词 / 同一动作词只出现一次。**',
    '- **★ 脸看不见就一个字的脸都别写**（2026-09-28 新增）：先判他的**朝向**再决定写不写脸 ——',
    '  **面向镜头** → 正常写表情；**侧身** → 只写侧脸读得到的（下颌线 / 侧脸轮廓 / 半垂的眼）；',
    '  **背对镜头**（如他看着窗外、你看到的是他的背影）→ 🚫 **不写脸、不写眼、不写表情**，',
    '  只写背面可读的信号（肩线 / 背阔 / 后颈 / 发尾 / 手：`his shoulders set in a still line`',
    '  / `the back of his neck` / `his hair falling against his collar`）。',
    '  ⚠️ 背对却写 `eyes half-lidded` → 模型为画出半闭的眼会把**头扭回镜头方向**，',
    '  「看向窗外」与「露出眼神」打架 → **连带把肩和手臂一起带歪**。',
    '  **判据：他朝哪？那个朝向看得到眼吗？看不到就一个字的脸都别写。**',
    '',
    '### 3.7 多人句式（K2 口径，两人及以上）★ 归属错乱重灾区，硬规则',
    '- **★ tag 里禁止人数声明**（2026-09-27 实测反转，推翻旧「人数写进第一句」条款）：',
    '  `Two figures fill the frame` / `1boy, 1girl` / `Three people ...` 一律不写 ——',
    '  **人数已经由人物段的分块数量表达了**（每位在场角色各有一块「外貌+动作」），',
    '  tag 再声明一次 = 同一批人被第三处描述 = 模型把它当第 3 个实体去成立，',
    '  实测直接多出一个半截人（分块定稿当天的翻车图：精灵坐裤子上 + tag 写 Two figures → 左下角多出半身人）。',
    '  需要说明谁和谁互动时用代词（`she looks up at him`），不要用人数词起句。',
    '- **每人独立成句，先主后次，一句一人**；特征归属靠 `his` / `her`，严禁交错',
    '  （他的发色句里混进她的服装 = 必错乱，实测两人发型互相污染）。',
    '- **服装必须带主人**：`her black-and-white nun habit` / `his plain dark top` ——',
    '  裸写 `school uniform` 等于让两个人平分一件衣服。男角服装也逐件写全（实测男角服装最容易漂移）。',
    '- **动作、表情、视线都带主人**：`his arm around her waist` / `her hands braced on his shoulders`；',
    '  一句话里只安排一个人的核心动作，第二人的动作另起一句（官方口径：复杂动作逐个写，一次一个）。',
    '- **人称代词锁定**：女性一律 `she/her`、男性一律 `he/his`，全篇不得混用；',
    '  三人以上时先在第一句给每人一个身份标签（`the mother` / `the daughter` / `the man`），',
    '  后文统一用该标签的代词，不再换称呼。',
    '- **禁止用 `<user>` / `<bot>` 等宏指代画面角色**（宏不展开=纯噪声，还会让插件的人物段漏人）；',
    '  每个出场角色都用 `@角色名` 标记，插件据此把外貌注进人物段 —— 少标一个人，那个人就失去锚定。',
    '- 多人时 `scene` 同理：先逐人状态，最后氛围；情绪张力**逐人写进 `tag` 末句**并带主人',
    '  （`she looks flustered, while he stays stiff`）；插件注入的人物段**每位角色一块**',
    '  （「角色名：中文外貌」+ 该角色的英文动作句，紧邻成块；无标题行、无性别前缀），',
    '  人数由分块数量表达，**任何段落都不写人数声明**。',
    '- 共有特征只写一次（都是长发写一个 `long hair`）。',
    '',
    '### 3.8 禁止项（K2 中英混合版）',
    '- **禁止逗号堆叠 tag** —— 英文段必须是连贯句子（3.3）。',
    '- **禁止一切否定表述**：既不许写否定句，也不许把否定词混进正向句 ——',
    '  排除项全部改写成正面表述（3.1 锚定块教训 + CFG=1 规则）。',
    styled
      ? '- **画风词与胶片质感词：本模版允许**（前置写实锚定块 + `tag` 末句后补一句英文画风短语'
      : '- **禁止画风词与质量词**（`masterpiece` `best quality` `8k` `anime style` `film grain` 等）——',
    styled
      ? '  `cinematic film still, natural film grain and real skin texture`）。**不要写中文风格句**。\n' +
        '  ⚠️ 若「全局词库」后缀里也写了同类风格词会互相稀释 —— 用这套模版时建议后缀留空。'
      : '  画风与质感由「全局词库」的**后缀**统一控制，写进提示词只会和后缀打架。',
    '- **肤色以档案库的 skin 字段为准**：库里有就照抄那个值；库里没给就不写肤色词。',
    '- **禁止中文进英文段** —— 中文只出现在 `scene` 与插件注入的人物锚点段；情绪也用英文写（3.6）。',
    '- **禁止跨图引用**：「承接上一张」「与上张一致」「同上」「略」都不许写 —— 每张图独立生成。',
    '  （v0.9.52：你能看见「近期已出过的图」摘要，但那只用于避免重复/延续事实，不许照抄。）',
    '- **禁止画外内容**：谁在按快门、机位架在哪、看不见的心理因果，一律不写。',
    '',
    '### 3.9 画面补全与字数',
    '正文是小说不是分镜脚本，不会写镜头、光线、景深 —— **这些由你主动补全**：',
    '每个画面都要给出镜头距离、光线与时间、氛围色调，正文没写不是不写的理由。',
    '但「画面里有什么」必须以正文与设定为准，不得借补全之名编造人物、动作或情节。',
    '- **字数锚**：单人简单画面可短至 150 词；双人 + 双服装 + 复杂姿态固定 **250~350 词**，',
    '  不许为省字数砍服装细节（实测服装崩坏的头号原因）。',
    '> 一句话：**怎么拍**可以主动具体化（这是 scene 的职责）；**画面里有什么**必须以正文为准。',
  ].join('\n');
}

export const K2_SPEC_SECTION3 = k2SpecSection3(false);
export const K2_SPEC_SECTION3_STYLED = k2SpecSection3(true);

/**
 * 写实锚定块（v4 定稿：纯正面表述，实测含 no cartoon 三连的旧锚定块是反向污染）。
 * styled 版由插件在组装时自动拼在每张图最前 —— 不靠 LLM 自觉，保证逐字一致。
 */
export const K2_PHOTOREAL_ANCHOR = 'photorealistic, a real-person photograph, real human skin with visible pores and natural skin texture, realistic human anatomy and body proportions, naturally realistic appearance.';

/** K2 模版系统提示词收尾。 */
function k2SystemAddon(styled) {
  return [
    '',
    '**本模版是「K2 中英混合' + (styled ? ' · 带风格化' : '') + '」模式**：你输出的 `scene`（中文）与 `tag`（英文）',
    '会被插件按固定顺序拼成一条完整提示词送进 Krea2 —— 两段都写**连贯句子**（英文段禁止逗号堆叠 tag）。',
    '**拼装顺序（不可更改）**：' + (styled ? '写实锚定块（插件自动加） → ' : '') + 'scene（场景氛围） → 人物锚点段（插件从档案自动生成） → tag（服装 / 动作 / 承重 / 手位 / 表情 → 末句情绪）。',
    '**没有中文情绪段**：情绪与张力写进 `tag` 的最后一句英文 —— 中英双语复述同一件事会让模型把',
    '动作与物体**复制成多份**（实测：英文写双手端碗 + 中文复述端碗 → 多长出一只手）。不要输出 `mood` / `nl`。',
    styled
      ? '写实锚定块由插件自动加在每张图最前，**你不要自己写**；另可在 `tag` 末句后补一句**英文**画风短语，不要写中文风格句。'
      : '本版本是**去风格化**设计：画风、质量、胶片质感、写实锚定块一律不写 —— 风格由全局词库的后缀统一控制。',
    '**tag 里禁止写外貌**（发型/发色/瞳色/胸型/体型/年龄）—— 外貌由插件从档案库生成中文人物段，写重复了权重会翻倍（实测肢体扭曲）。',
    '排除项一律用正面表述写进正向句（Krea2 在 CFG=1 工作流里 negative prompt 不生效）。',
  ].join('\n');
}

export const K2_SYSTEM_ADDON = k2SystemAddon(false);
export const K2_SYSTEM_ADDON_STYLED = k2SystemAddon(true);

/** K2 模版输出协议补充。 */
function k2ProtocolAddon(styled) {
  return [
    '',
    '## K2 中英混合补充（本模版专属，不要删除）',
    '',
    '`images[]` 每项输出**两个**内容字段（v5 定稿结构，插件按固定顺序拼装）：',
    '',
    '```json',
    '{ "position": "P3",',
    '  "cast": [',
    '    { "name": "小精灵-菲", "en": "The tiny fairy perches on his shoulder, her sheer wings trembling, both tiny hands pressed flat against his collar." },',
    '    { "name": "夜斗", "en": "The young man sits on the bed edge, his weight on his braced left arm behind him, his right hand resting open on his knee." }',
    '  ],',
    '  "scene": "教堂图书馆的地板上散落的书籍摊开在两人周围，温暖的晨间逆光从身后照进来，尘埃在光柱里缓缓浮动。",',
    '  "tag": "Two figures share the frame — the tiny fairy balanced on the man\'s shoulder while he sits still beneath her. She looks flustered and short of breath, while he stays stiff, jaw tight, barely holding himself together.' + (styled ? ' Cinematic film still, natural film grain and real skin texture.' : '') + '" }',
    '```',
    '',
    '### cast —— 出场名单（★ v0.9.25 定稿：多人画面**必须**写，漏一个人那个人就没有外貌）',
    '- `cast` 是「**这张图里有谁**」的权威来源。画面里出现几个人就写几项，**一个都不能漏** ——',
    '  漏掉的人插件不会注入他的外貌，出图就是个没脸的路人（实测：只锚定男主，小精灵被画成随机生物）。',
    '- `cast[].name` = **角色档案库里的准确名字**（写昵称/简称也认，插件会回退匹配）。',
    '  不写 `@`，不写 `<user>` / `<bot>` 宏，也不写「一位男性」这种代词 —— 必须是能查到档案的名字。',
    '- `cast[].en` = **这个角色自己的英文句**（1~3 句），写他的：①服装逐件（逐字沿用档案 outfit 值，',
    '  带主人 `her` / `his`）、②承重面、③两只手的位置（同一个句号内，见 3.4b）、④表情与视线。',
    '- **顺序 = 主次**：排第一的是画面主体（插件按这个顺序拼）。',
    '- 单人图也写（一项即可）。',
    '- **★ `offscreen`（在场但不入画，v0.9.28 新增）**：画面是某人的 POV / 特写，',
    '  另一个人只被「提到」而不该完整出现在画面里时，给那个人加 `"offscreen": true` ——',
    '  插件就**不会**注入他的外貌与动作（外貌段 = 「请把他画完整」的指令，',
    '  POV 图里注入男主外貌就是命令模型把他也画出来，实测多出一个人/半截人）。',
    '  例：镜头是精灵的 POV，男主只在她的视线里 → `{ "name": "夜斗", "offscreen": true }`，',
    '  他在场（`cast` 里必须有他）但不入画。他与画面的接触（他的手/腿出现在画面边缘）',
    '  由**画面主体**的 `en` 句带过（`perched on his hand`），不要给他单独的英文句。',
    '- **插件怎么拼**（看懂才知道为什么必须逐人写）：',
    '  ```',
    '  〔scene〕',
    '  A角色：一位体型娇小的精灵，……（中文外貌，插件从档案注入）',
    '  The tiny fairy perches on his shoulder, …（A 的英文句，紧跟着 A 的外貌）',
    '  B角色：一位男性，……（中文外貌）',
    '  The young man sits on the bed edge, …（B 的英文句，紧跟着 B 的外貌 —— 档案写少年就用 young）',
    '  〔tag〕',
    '  ```',
    '  **外貌与该角色的动作是同一块** —— A 的动作紧跟 A 的外貌，不会串到 B 身上；',
    '  这是旧写法（外貌段整体在前、动作段整体在后）最容易出的错：B 只被「一位男性」概括掉。',
    '',
    '- `scene`（**连贯中文句**）：地点陈设、光线时间、氛围色调。**不写景别与裁切边界**（畸变源，取景交给模型）。不写人物与服装。',
    '- `tag`（**连贯英文句**，2~6 句，禁止逗号堆叠）：',
    '  **写了 `cast` 时，`tag` 只写两件事**：',
    '  ①**末句情绪张力**（逐人带主人：`she looks flustered and short of breath, while he stays stiff`）；',
    '  ②仅当某个交互 / 道具**不属于任何单个角色**且 `cast[].en` 里没写过时，才在这里补一句。',
    '  ⚠️ **严禁复述 `cast[].en` 里已经写过的任何内容** —— 动作、接触点、承重面、服装、',
    '  **尤其是接触物**（裤子 / 床单 / 椅面这类「身体压着的东西」）：同一个接触物被描述两次，',
    '  模型按「两个都要成立」处理，实测把「裤子里的人腿」复制成半截多余人（2026-09-27 翻车图）。',
    '  ⚠️ **严禁人数声明**（`Two figures ...` / `1boy, 1girl`）—— 人数由人物段分块表达（见 3.7）。',
    '  ⚠️ **严禁复述 `scene`** —— 台灯 / 桌子 / 陈设已由中文场景段承担。',
    '  **没写 `cast` 时** `tag` 按旧口径承载全部：①服装逐件（逐字沿用档案库 outfit 值，带主人 `her`/`his`）、',
    '  ②动作与姿态（承重面 + 两只手的位置）、③表情与视线、④情绪与张力（**末句**，逐人带主人）。' + (styled
      ? '写实锚定块由插件自动加，**不要写进 tag**。'
      : '不写画风词、质量词、胶片质感、写实锚定块 —— 风格由「全局词库」后缀控制。'),
    '- **tag 里禁止写外貌**（发型/发色/瞳色/胸型/体型/年龄）—— 外貌由插件从角色档案库自动生成中文人物段。',
    '  `@角色名` 仍可写（标记谁出场，插件会剥掉记号），但句子要完整。',
    '- **体型 / 种族 / 年龄段描述必须与人物段一致** —— 人物段（插件注入）描述的是同一个角色：',
    '  档案里是「体型娇小的精灵」就写 `the tiny fairy` / `palm-sized fairy`，不要写成宽泛的人类身份词；',
    '  两个段落各立一个不同的实体（「女人+翅膀」vs「palm-sized fairy」），模型会把两个都画出来',
    '  —— 实测多画了一只精灵。英文段的身份词跟随档案设定走。',
    '- **情绪与张力写进 `tag` 的最后一句**（英文，逐人带主人）：',
    '  `she looks flustered and short of breath, while he stays stiff, jaw tight`。',
    '  只写画面上看得出来的（表情 / 眼神 / 肌肉紧绷 / 呼吸起伏）；**禁止写声音、气味、触觉、心理因果**',
    '  —— 图像模型画不出来，是纯噪声，且「湿热 / 粘稠 / 湿润」会和皮肤干燥锚直接打架。',
    '- `mood` / `nl` 字段**已废弃，不要输出**（插件会整段丢弃）——',
    '  中文情绪段复述英文 tag 里的动作，会让模型把动作与物体**复制成多份**（实测多长出一只手）。' + (styled ? ' 风格句改写成英文补在 `tag` 末尾。' : ''),
    '- 人物必须带**年龄锚定**（2026-09-28 定稿：按外表年龄三档，**一律不写 `adult`**）：',
    '  - 外表年轻（少年 / 少女 / 男孩 / 女孩）→ `young man` / `young woman` / `young fairy`；',
    '  - 外表达观（成熟 / 年长 / 中年）→ `mature man` / `mature woman`；',
    '  - 人物段没写年龄（只有「一位男性 / 一位女性」）→ **光杆 `a man` / `a woman`**，别加年龄词；',
    '  - 非人种族跟随种族写（`fairy` / `elf`），同样不加 `adult`。',
    '  🚫 **禁写 `adult` 这个年龄词**（它跟任何身份名词的组合都不许）—— 实测「成年」把脸画老、体型画壮。',
    '  ⚠️ 实测病例：档案「夜斗：一位少年…」，英文句写 `The adult man stands...` → 出图是成年男子，',
    '  与人设的少年判若两人。**人物段已经写了年龄，英文句就照它写，不要另起一套。**',
    '- **英文句不得复述人物段已写的外貌要素**（发色发型 / 瞳色 / 体型 / 胸型 / 服装 / 翅膀等种族特征）',
    '  —— 外貌由插件注入人物段，英文再说一遍就是第二次描述同一个实体：',
    '  ⚠️ 翅膀是重灾区（精灵 / 天使类）：人物段已写翅膀，英文再写一次 → 与手臂混淆、多长出多余的手。',
    '- **禁止用 `<user>` / `<bot>` / `<char>` 等宏指代画面里的角色** —— 宏不会被展开，',
    '  原样送进生图模型就是噪声，还会撕碎英文句（实测：主语直接消失）。画面里是谁，',
    '  就用 `@角色名` 标记出场、用 `she/her` / `he/his` 指代，句子里写全服装主人。',
    '- **changes 里的动态状态（`condition` / `mood` 等）只写短状态语**（如「脸颊泛红」「呼吸短促」',
    '  「体力不支」），**不要写成动作句** —— 动作归 `tag` 英文段，状态句混进人物段就是重复权重。',
    '- **排除项用正面表述写进正向句**；禁止否定句与否定词（`no xxx` 会被读成 xxx 本身）。',
    '- 复杂场景（双人+双服装+复杂姿态）整条提示词 **250~350 词**，不许砍服装细节。',
  ].join('\n');
}

export const K2_PROTOCOL_ADDON = k2ProtocolAddon(false);
export const K2_PROTOCOL_ADDON_STYLED = k2ProtocolAddon(true);

/* ============ K2 纯英文单段口径（2026-09-27 用户新增：贴工作区实测成功形态） ============ */

/** 纯英文单段 §三（画面写法）。 */
function k2EnglishSpecSection3() {
  return [
    '## 三、画面写法（K2 纯英文单段 ★ 本模版专属）',
    '',
    '> 本模版是**一整段连贯英文**的写法（用户工作区实测成功的形态）：没有中文段、没有景别词、',
    '> 没有写实锚定块 —— 外貌和服装都直接写进英文段（与「中英混合」模版的分工完全相反）。',
    '> 取景交给模型按动作自己决定。',
    '',
    '### 3.1 形态',
    '- 每张图只输出一个 `tag` 字段 = **一整段连贯英文（约 4 句，150~300 词）**；',
    '  `scene` / `mood` 留空字符串即可（本模版不使用它们，人物外貌也**不用**插件注入 —— 你自己写）。',
    '- **禁止写 `@角色名` 引用** —— 本模版外貌由你亲手写进句子（写引用会被剥掉且没有人物段兜底）。',
    '',
    '### 3.2 四句骨架（双人场景；单人场景删去男主句）',
    '- **第一句 = 主体 + 核心动作 + 对方反应**：谁、在哪、正在做什么，对方怎么回应',
    '  （交互点要具体：碰在哪里、扶着什么）。开头按**外表年龄三档**写（与中英混合版同口径）：',
    '  - 外表年轻（少年 / 少女 / 男孩 / 女孩）→ `A young man ...` / `A young woman ...` / `A young fairy ...`；',
    '  - 外表达观（成熟 / 年长 / 中年）→ `A mature man ...` / `A mature woman ...`；',
    '  - 档案没写年龄 → **光杆 `A man ...` / `A woman ...` / `A fairy ...`**，别加年龄词。',
    '  🚫 **`adult` 二字一律不写** —— 2026-09-27 实测定稿：「成年」措辞让模型把**脸画老、体型画壮**。',
    '  开头锚定与后面的外貌两处年龄打架时，模型按更靠前的锚定走，出图会变成另一个人',
    '  （实测：人物是少年却写了成年男子 → 出图与人设判若两人）。',
    '- **第二句 = 女主外貌 + 服装逐件**：`The woman is <发色发型>, <瞳色>, <肤色>, <体型>, wearing <上衣>, <下装>, <鞋袜>, <配饰>.`',
    '  外貌与服装**逐字沿用档案库字段值**（只改句式不改内容）；一件不许漏。',
    '- **第三句 = 男主服装 + 重心 + 手位**：`The man wearing <服装> ...` + 他的重心落在哪、',
    '  两只手各在做什么、身体状态（`his weight shifted onto his back foot as his shoulders tighten` 这类写法）。',
    '  ⚠️ **手位写法（★ 2026-09-28 重写）**：',
    '  **★ 肢体单一声明律** —— 成对的 手 / 臂 / 腿 / 脚 在同一句里**只允许一套几何**。',
    '  🚫 禁「总括 + 分项」叠写：`both hands raised — his right ..., his left ...`',
    '  （总括是**状态**、分项是**位置**，两份几何一冲突，K2 不会取其一而是**多长一只手**去满足第二份。',
    '  ⚠️ 这条正是 2026-09-28 实测翻车的写法 —— 老规则教的就是它，现已作废）。',
    '  ❌ 也禁两个各自带主语的独立小句并列（`His left hand rests on ..., his right hand hangs over ...`）',
    '  —— 会被读成两个独立手部实体，同样多长一只。',
    '  ✅ **三档（按稳定性排序）**：',
    '  **A · 最稳｜只写一只**：`one hand drawing the curtain open just a little`（另一只**完全不提**）；',
    '  **B · 稳｜分工不指定左右**：`one hand ..., the other hand ...`；',
    '  **C · 必须自洽**：`both hands + 同一个动作`（`both hands gripping the sheets`）／',
    '  `his right hand ..., his left hand ...`（**仅**在必须交代左右时用，且总括与分项几何必须一致）。',
    '  **判据：这一句里「手」声明了几次？2 次且几何冲突 → 删掉总括句。**',
    '  ★ **POV 两种情形（写法相反）**：**我的**手入画（POV 自视角）→ 可写左右；',
    '  **我看着对面那个人**（POV 看他）→ 🚫 别写他的左右 —— 镜像歧义（他面对我时右手出现在画面左侧，',
    '  模型不知道按「他的右手」还是「画面右侧」落笔 → 手臂扭曲）→ **改 A 档或 B 档**。',
    '  另外慎写「手 + 精细边界」接触点（`the edge of the curtain` / `the hem of ...`）——',
    '  那等于指令模型「这里需要一只手」，手上已有去处时就会被补出多余的手。',
    '- **第四句 = 双人视线与表情对仗**：`She keeps ... and looks up at his face with a warm smile, while he looks down at ... with a flustered, uncertain expression.`',
    '  —— `She ..., while he ...` 一句收拢两人的视线方向与情绪，视线每人一个方向，不许两人都看镜头。',
    '',
    '### 3.3 防崩正面表述（与中英混合模版同表）',
    '  - 口部：`open mouth` → `her lips slightly parted`；干净口部写 `her mouth clean without any drool`；',
    '  - 勒痕/压痕：禁用 `red marks` → `faint pink indentation lines`；',
    '  - 长袜要「不透肉」必须写 `opaque fabric`；',
    '  - 干燥锚：`her skin matte and dry, clean and free of any moisture`；',
    '  - 男角外貌偏阴柔时补 `clearly masculine adult male build`。',
    '- 承重面必写（靠什么撑住身体）、手位必写（两只手各在哪）。',
    '',
    '### 3.4 禁止项',
    '- **禁止景别与裁切边界**（`medium shot` / `framed from ...` / 中文「中景」都不许写 ——',
    '  实测景别词与动作打架产生畸变，取景交给模型）。',
    '- **禁止中文** —— 本模版最终提示词不含任何中文（写了也会被清掉）。',
    '- **禁止否定表述**（negative prompt 在 CFG=1 工作流不生效，否定词会被读成概念本身）。',
    '- **禁止画风词与质量词**（`masterpiece` `8k` `film grain` 等）—— 风格由「全局词库」后缀控制。',
    '- **禁止跨图引用**与画外内容（机位架在哪、谁在按快门）。'
    + '（v0.9.52：能看见近期已出图的摘要，但只用于避免重复与延续已确立的事实，不许照抄。）',
    '- 共有特征只写一次（都是长发只写一个 `long hair`）。',
    '- **外貌要素全段只写一次，不许复述**（与「中英混合」模版同口径）：发色 / 瞳色 / 体型 / 服装 / 翅膀',
    '  只在第二句（女主）与第三句（男主）各写一遍，后面**不许再提** —— 同一实体第二次描述 = 复制。',
    '  ⚠️ **翅膀是重灾区**（精灵 / 天使类）：写完翅膀又写一次 → 与手臂混淆、多长出多余的手。',
  ].join('\n');
}

/** 纯英文单段系统词收尾。 */
function k2EnglishSystemAddon() {
  return [
    '',
    '**本模版是「K2 纯英文单段」模式**：每张图只输出一个 `tag` 字段 = 一整段连贯英文（约 4 句），',
    '`scene` / `mood` 留空。外貌与服装由你亲手写进英文段（**不要写 @引用**），',
    '不写中文、不写景别、不写锚定块、不写否定表述 —— 取景交给模型。',
  ].join('\n');
}

/** 纯英文单段输出协议补充。 */
function k2EnglishProtocolAddon() {
  return [
    '',
    '## K2 纯英文单段补充（本模版专属，不要删除）',
    '- `images[].tag` = 一整段连贯英文（约 4 句，150~300 词），按「①主体+核心动作+对方反应 →',
    '  ②女主外貌+服装逐件 → ③男主服装+重心手位 → ④双人视线表情对仗」的骨架组织；单人场景删男主句。',
    '- `images[].scene` / `images[].mood` 一律输出空字符串（本模版不使用）。',
    '- **不要写 @引用**：外貌自己写（`The woman is ..., wearing ...`），写引用会被剥掉且没有兜底。',
    '- 开头按**外表年龄三档**写：外表年轻 → `A young man ...` / `A young woman ...`（非人种族 `A young fairy ...`）；',
    '  外表达观 → `A mature man ...` / `A mature woman ...`；档案没写年龄 → 光杆 `A man ...` / `A woman ...`。',
    '  🚫 **`adult` 二字一律不写** —— 实测把脸画老、体型画壮（想表达「不是小孩」靠上面三档）。',
    '  名词跟种族走。不写景别、不写中文、不写否定。',
  ].join('\n');
}

export const K2_ENGLISH_SYSTEM_ADDON = k2EnglishSystemAddon();
export const K2_ENGLISH_PROTOCOL_ADDON = k2EnglishProtocolAddon();

/** K2 纯英文单段出厂模版（variant='en'：tag 自写外貌服装，无人物段注入，无锚定块）。 */
export function defaultK2EnglishTemplate(name = 'K2 纯英文单段') {
  const cut = DEFAULT_SPEC.indexOf('## 三、');
  const head = cut > 0 ? DEFAULT_SPEC.slice(0, cut) : DEFAULT_SPEC;
  return {
    name,
    engine: 'k2',
    variant: 'en',
    system: DEFAULT_SYSTEM + K2_ENGLISH_SYSTEM_ADDON,
    spec: head + k2EnglishSpecSection3(),
    protocol: DEFAULT_PROTOCOL + K2_ENGLISH_PROTOCOL_ADDON,
    jailbreak: DEFAULT_JAILBREAK,
  };
}

/* ============ MOSS-Image 口径（v0.9.117 · 第三档 engine） ============ */

/**
 * MOSS-Image 口径的三段补充（system / spec §三 / protocol）。
 *
 * 口径事实（来源：`G:/AI/酒馆AI/生图工作流/MOSS酒馆生图模型/`，用户自测产物 + 官方 USERGUIDE）：
 *   ① 编码器是 **Qwen3.5-9B** —— 自然语与 TAG **混吃**，两者都认（所以本模版叫「自然语+Tag」，
 *     不像 K2 那样必须连贯句子、也不像 SD 那样必须逗号 tag）。
 *   ② 支持三种形态：**纯 prompt / Layout JSON / bbox**。本模版只走**纯 prompt**
 *      —— 用户明确「多格漫画我有测试写法，现在主要用纯prompt写」，坐标那套留在插件外。
 *   ③ 生成的是**一张画布**：多格是一次出图里切格，不是拼图。所以
 *      `tag` 一整段 = 一次请求 = 一张图。
 *
 * ★★ 为什么必须走 `variant:'en'`（单串整段）而不是 K2 的三明治：
 *   MOSS 多格提示词的骨架是「版面声明 → Panel 1 → Panel 2 → Panel 3」的**连续序列**。
 *   绘灵的 K2 三明治会把「场景段 → 人物锚点段（每人外貌+动作）→ 动作段」插在中间，
 *   正好把 Panel 序列切断 —— 切出来的格子会缺人、或者把三格揉回一张。
 *   单串模式下插件只做「全局前缀 + tag 全文 + 全局后缀」，段落结构由模型自己写。
 *
 * ⚠️ v0.9.118 曾在这里写「这条路径不注入人物锚点段，外貌靠模型逐字照抄档案，
 *   所以 §一§二 保留不动」—— **v0.9.118 之后已经改为插件注入英文人物段**，
 *   照抄那套（SD / K2 的分工）与注入**互相抵消**，v0.9.119 已换成 MOSS 专属 §一§二。
 */
/**
 * ★★★ v0.9.119：MOSS 口径**专属的 §一 §二**（人物外貌 / 服装）。
 *
 * 为什么不能复用默认模版那两节（用户 2026-10-21 原话：
 * 「spec 里某处仍写着『禁止在 tag 里写中文』，这个是对于其他口径而言的，但是很多规则对 MOSS 不合适」
 * 「对于其他口径的一些东西不能照搬」「以官方为准比较好些」）：
 *
 *   默认 §一 写的是「每个角色必须在画面 tag 里**逐字照抄** hair/eyes/outfit」
 *   —— 那是 SD / K2 的分工：模型自己把档案字段搬进画面词。
 *   而 MOSS 口径下这件事由插件机械注入（见 mossSystemAddon 与 mossCastParagraph），
 *   让模型再抄一遍 = **同一件事被描述两次**，MOSS 会做「语义平均」折中成模糊态
 *   （方法论 §二·六：「全局写基准，Panel 只写变化量」）。
 *   ⇒ 两条规则互相抵消，这是本项目第 7 次同类 bug。
 *
 * 本节依据（可逐条核对原文，不是自创）：
 *   · `MOSS酒馆生图模型/官方文档/USERGUIDE_ZH.md` → Prompt 规范（语言 / 文字排版）
 *   · `MOSS酒馆生图模型/交接/方法论_多格漫画做法说明.md` §二·五 / §二·六（用户实测有效）
 *   · `MOSS酒馆生图模型/交接/交接文档_MOSS漫画提示词_v1.md` §4 服装防串味 / §5 人名问题
 */
function mossSpecSection12() {
  return [
    '# 一致性规范（MOSS-Image 口径）',
    '',
    '> 本口径由插件维护，**与 SD / K2 口径的规则不同，不要混用**。',
    '> 依据：MOSS-Image 官方 USERGUIDE（语言 / 文字排版）+ 本项目实测方法论。',
    '> 最大的区别：**人物外貌与服装由插件机械注入**，你负责的是剧情、分镜与台词。',
    '',
    '## 一、人物外貌：插件注入，你不要写 ★★★',
    '',
    '插件会在**版面声明之后、第一格之前**自动插入每个角色的英文人物段',
    '（外貌 + 当楼服装，按角色档案逐字生成），格式固定为：',
    '```',
    'The young woman with black hair, long hair, straight hair, blue eyes, fair skin, wearing white school blouse, navy sailor collar with white stripes, black leather loafers.',
    '```',
    '所以：',
    '- ★★★ **每格提到人物，必须带「身份锚点」**：**发色 + 一件最能区分身份的衣服**，5~8 个词，够用就好。',
    '  写 `the black-haired girl in the navy sailor uniform` / `the silver-haired boy in the black uniform`。',
    '  依据（官方模板）：§8.4「多格角色重复出现要**在每格重述身份**」、§13.2「每个 character caption',
    '  **自带发色发型、衣服主色**」、§14 坑表「多人串色串衣 → **独立主语绑定属性**」。',
    '- ❌ **光写 `the girl` / `the young man` / `she` 不行**：两人以上时它会指向「最近提到的那个」。',
    '  实测（2026-10-21 本机）：Panel 3 写 the girl 的手部特写，画出来是**男主的手**（白衬衫袖口）——',
    '  因为上一格刚写过 `the tall young man standing in front of her`。',
    '- ❌ 也**不要**在格内重写完整外貌（发色+发型+瞳色+脸型+肤色+体型+三围）。',
    '  实测：把完整外貌写进格内，「手部特写」会被挤成「半身像」—— 外貌的权重盖过了景别。',
    '  完整外貌只在人物段写一次（插件负责），格内只给**最小可区分锚点**。',
    '- ★ 同一个角色跨格用**同一个锚点短语**、逐字复用；换个说法（`the black-haired girl` ↔ `a dark-haired girl`）',
    '  会被当成另一个人。',
    '- ⚠️ **唯一例外**：档案库没有的人（巡查员 / 店员 / 路人 / 只有身份没名字的人）。',
    '  在 `cast` 里给他一项，带 `look`（一行英文外貌速写）：',
    '  `{"name":"巡查员","look":"a middle-aged man with short grey hair, dark blue security uniform"}`',
    '  —— 插件会用 `look` 给他生成人物段。**不要**在格内重写他的外貌。',
    '',
    '### 1.1 人数：先说清楚「画面里有几个人」★★★',
    '',
    '**这是「多画出一个人」和「第三个人被画成女主的复制品」的头号原因** ——',
    '没写人数限制时，模型会把「两人」理解成「至少两人」，然后自己补一个。',
    '',
    '- 每格开头写清人数与性质：`exactly two people in this panel` / `the two of them alone in the stairwell`；',
    '  有额外的人要分开写：`the two of them, with a security guard standing below on the stairs`。',
    '- ★ **多人不能共用一串属性**（官方模板 §5.2「多人不是一串共用属性」）：',
    '  ❌ `two girls, black hair, white blouse, navy skirt` —— 颜色和衣服会在两人之间漂移，',
    '  最后长出**第二个穿同款校服的女生**（实测就是这个结果）。',
    '  ✅ 每人一个独立主语 + 身份锚点：`the black-haired girl in the navy uniform pulls his sleeve; the silver-haired boy in the white shirt stands half a step behind her`。',
    '- **同一格内每个在场的人都要有独立主语**，哪怕只写半句；不要用 `they` / `both` 一笔带过。',
    '- 画面里确实只有两个人时，用**正面收束句**写出来：`the frame holds exactly the two of them`。',
    '  ⚠️ **不要**写 `no one else in the frame` 这类否定句 —— MOSS 会把否定词当肯定画（与 §3.5「禁止否定表述」是同一条）。',
    '- ★★ **三人以上同框：格首要加一句「构图收束」**（实测 2026-10-21 本机真实出图）：',
    '  `the frame holds exactly three people and closes tightly around them, ` —— 三个人的格子 8 张里 3 张',
    '  多画了「上一格刚出现过的角色」，加这句后 3 张全对。',
    '  ⚠️ **只对 3~6 人有效**：8 人档加不加都漏人（6 张里 5 张错），别指望它救超大群像。',
    '- ★★ **同框两人的上衣主色或款式必须不同**（实测反直觉）：',
    '  4 人档里两个都穿白上衣的女学生，服装在 6 张图里**全部串了**（一个穿成另一个的水手服）；',
    '  同一份 prompt 加到 6 人、插进「薰衣草开衫」「橙色运动外套」两个强特征后反而 3 张全对。',
    '  ⇒ 多人同框时锚点要挑「对方身上没有的那一件」，**不要拿「都是白衬衫」这种共性做区分**。',
    '- ★★ **上一格出现过的角色，这一格还要出现 → 必须再写一次独立主语**：',
    '  8 人档 6 张里 5 张错，漏掉的固定是「唯一在上一格出现过、又要在大格里再出现」的那一个',
    '  （模型认为「这张脸刚画过」就在大格里省掉了）。**跨格延续不会自动发生，不写就等于这一格没有他**。',
    '',
    '**`changes` 里的档案字段仍然必须认真维护**（一律英文）：人物段就是照它生成的，写错了人就换了。',
    '发型 / 发色 / 卷度 / 扎法 / 刘海 / 妆面是**人设**，不得改动；',
    '只有 `hairState` / `makeupSmudge` 两个通道能随剧情变。',
    '',
    '## 二、服装：全局只写一次，格内只写「变化量」 ★★★',
    '',
    '人物段已经把这套衣服写全了。所以格内：',
    '',
    '| 手法 | ❌ 别写 | ✅ 这样写 |',
    '|---|---|---|',
    '| 部位替代品类 | `white school blouse with collar pulled open` | `her raised arm pulls the collar slightly open` |',
    '| 状态挂在动作上 | `the sleeve is rolled up` | `she reaches up, her sleeve sliding back` |',
    '| 加限定词标「临时」 | `the collar is loosened` | `the collar pulled slightly open by her raised arm` |',
    '| 写因果不写结果 | `the hem is raised` | `the wind lifts the hem` |',
    '',
    '- ★ **服装品类名（blouse / skirt / jacket / loafers）只许出现一次**，且只能出现在人物段里',
    '  —— 格内再写一次，模型会读成「两套衣服」，最后平均出一件模糊的衣服。',
    '- 可用部位词：`collar` / `hem` / `sleeve` / `cuff` / `waistband` / `lapel` / `the fabric`。',
    '- **同一格内同一件衣服只写一次**，写两遍会被语义平均成折中态。',
    '- **真的换了一身衣服**那一格才完整重写，并明确写 `now wearing …` / `without the jacket`',
    '  —— 让模型知道是替换不是叠加。',
    '- **多格之间状态不一致是合法的**（每格是独立区域）：格 1 裙子整齐、格 3 裙摆被掀起，不冲突。',
    '  **冲突只发生在同一格内**（同一格里不能既写整齐又写掀起）。',
    '- **状态位的推进走 `changes`**，不要在 tag 里随手改：',
    '  `{"name":"角色名","kind":"set","fields":{"outfit":"...","outfitState":"parted"}}`。',
    '  状态位只能前进：intact → parted → undone → removed；重新穿好要写 `redress:true`。',
    '',
  ].join('\n');
}

/**
 * MOSS 口径的 system 追加段（v0.9.118 首版，v0.9.119 按用户口径改写）。
 *
 * ★★★ 为什么必须让模型输出 `cast`（v0.9.117 写的是「只输出 tag」）：
 *   插件注入英文人物段靠的是 `image.cast` → castAnchors → eff。
 *   一旦禁止输出 cast，MOSS 下 castAnchors 恒为空，而 MOSS 又不许写 `@角色名`
 *   ⇒ 锚点来源**零个** ⇒ 人物段永远生成不出来。v0.9.118 第一版就栽在这里：
 *   代码写好了，但端到端一看 castEn 是空串，等于没修。
 */
function mossSystemAddon() {
  return [
    '',
    '**本模版是「MOSS-Image 口径（自然语 + TAG 混写）」**：你输出的 `tag` 就是**最终送进模型的整段提示词**。',
    '插件只追加两样东西：全局前缀/后缀，以及**每个角色的英文人物段**（外貌 + 当楼服装，按角色档案逐字生成，',
    '插在版面声明之后、第一格之前）。除此之外不追加任何东西 ——',
    '所以**动作、机位、光线、氛围、分格、台词**必须你写出来，**没写就等于没有**。',
        '- **人物外貌与服装不用你写**：插件会机械注入。但**格内每提一个人都要带「身份锚点」**：',
    '  发色 + 一件最能区分身份的衣服，例如 `the black-haired girl in the navy sailor uniform`。',
    '  光写 `the girl` 在两人以上会指向最近提到的那个人 —— 实测会把女主的动作画到男主身上。',
    '  完整外貌（瞳色 / 脸型 / 体型）不要写进格内：它会挤掉景别（手部特写被画成半身像）。',
    '- **必须输出 `cast` 点名**：插件靠它知道这张图里画了谁，才能查出人物段。',
    '  · 档案里**已有**的角色 → 只写 `name`（名字逐字照抄档案库），不要写外貌。',
    '  · 档案里**没有**的人（巡查员 / 店员 / 路人 / 只有身份没名字的人）→ 写 `name` + `look`，',
    '    `look` 是一行英文外貌速写（年龄感 + 发型发色 + 体型 + 穿什么），插件会直接拿它生成人物段。',
    '  漏了谁，谁就没有外貌锚定 —— 这是人物漂移、以及「第三个人被画成女主复制品」的头号原因。',
    '- ★ **MOSS 原生支持中文，不要套用 SD/K2 的「禁中文」规则**：',
    '  画面描写用英文（控得准、可复现），**说出口的话必须用中文原话**写在引号里。',
    '  不要输出 `scene` / `nl` / `mood` —— 这几个字段会被整段丢弃。',
    '- **不写 `@角色名`**：MOSS 不认记号，写引用会被剥掉且没有兜底。',
    '- **禁止质量词与写实词**（`masterpiece` / `best quality` / `highres` / `8k` / `photorealistic` / `film grain`）——',
    '  这类词在动漫语料里强指向「单张高质量插画」，会把分好的格子又压回一张图。画风词只在**第一句**写一次。',
    '- **台词必须原样进画面**：正文里有人说话时，把**原话**写进气泡（中文、引号内）。',
    '  **原话多长就写多长 —— 一个字都不许删、不许截断、不许改写、不许译成英文**。',
    '  一格放不下就多拆一格（一句台词占一格）；这一楼装不下就分到更多图或后面的楼层继续画。',
    '- `tag` 里**用换行分段**：第一行是版面声明，之后每格一段，段与段之间空一行。',
  ].join('\n');
}

function mossSpecSection3() {
  return [
    '## 三、画面写法（MOSS-Image 口径 ★ 本模版专属）',
    '',
    '> 本模版输出的是**一整段可以直接出图的提示词**。MOSS 是「自然语 + TAG 混吃」的模型 ——',
    '> 一句话写清一件事比堆逗号 tag 稳，但标准 tag（`1girl` / `close-up` / `smile`）它照样认得，',
    '> 混写没问题。两种形态：**多格漫画**（默认）与**单图剧情**。',
    '',
    '### 3.1 先判形态',
    '| 正文情况 | 用哪种 |',
    '|---|---|',
    '| 一段连续的对手戏，有时间推进（对视 → 靠近 → 接触），值得拆成几个瞬间看 | **多格漫画**（2~4 格） |',
    '| 只有一个瞬间值得画（一个动作 / 一个表情 / 一个场景） | **单图剧情** |',
    '',
    '- 每楼默认 **1 张**。只有正文里真的出现「几个连续瞬间」时才拆格，不要为了多画而拆。',
    '- 拆格时**所有格属于同一场景**：同一地点、同一光线、同一套衣服 —— 跨格换场景等于画了两页中的两格。',
    '',
    '### 3.2 多格漫画（纯 prompt 分格）',
    '第一句**固定**写版面声明（照抄句式，只改格数）：',
    '```',
    'A vertical Japanese manga page divided into three panels by white gutters with thin black borders, clean anime line art.',
    '```',
    '之后**每格一段**，段首固定 `Panel N, <方位词>:`',
    '',
    '| 可用的方位词（照抄，不要自创） |',
    '|---|',
    '| `narrow strip at the top left` / `top right` / `thin strip across the top` |',
    '| `middle left` / `middle right` / `center` |',
    '| `wide panel filling the bottom half` / `bottom left` / `bottom right` |',
    '',
    '- **每格只讲一件事**；格与格的**景别必须拉开**（中景 → 极特写 → 双人全景）。',
    '  三格全是中景 = 模型画出三个几乎一样的格子。',
    '',
    '#### 人物外貌与服装：插件注入，你不要在格内重写 ★★★',
    '详见上面的 **§一 / §二**（那两节是 MOSS 口径专属，与 SD / K2 的「逐字照抄」规则相反）。一句话总结：',
    '- **格内每提一个人，都要带「身份锚点」**：发色 + 一件最能区分身份的衣服，5~8 个词。',
    '  写 `the black-haired girl in the navy sailor blouse`。跨格**逐字复用同一个短语**。',
    '- **光写 `the girl` 不行**：两人以上它会指向「最近提到的那个」（实测把女主的手画成男主的手）。',
    '- **也不要把完整外貌清单塞进格内** —— 那是插件的活，写两遍会被平均成模糊态，实测还会把同一角色复制成两个人。',
    '- 衣着变化用**部位词**（`collar` / `hem` / `sleeve` / `cuff` / `waistband` / `lapel`）**挂在动作上**：',
    '  `her raised arm pulls the collar slightly open` ✅；`the sleeve is rolled up` ❌（读起来像款式设计）。',
    '- 只有**真的换了一身衣服**的那一格才重写服装，并写 `now wearing …`（替换，不是叠加）。',
    '- 档案库没有的角色（巡查员 / 店员 / 路人）→ 在 `cast` 里给他 `name` + `look`，别在格内写他的外貌。',
    '',
    '- 每格高度不低于整页的 **1/4**，太窄人物会被压成剪影。**四格以上建议压回 3 格**。',
    '- **不要**在前面堆 `masterpiece, best quality, highres` —— 那串词强指向单张插画，会把格子压平。',
    '',
    '### 3.3 台词与气泡（MOSS 的核心能力，必须用满 ★★★）',
    '',
    'MOSS 最强的能力就是**文字渲染**（官方 USERGUIDE：「图里要出现的字保留原文」；',
    '官方示例里一整段中文原文照样渲染）。所以**正文里说出口的话，必须原样出现在画面上**。',
    '',
    '**动手前先做一件事：把正文里带引号的对白逐条摘出来，数一数有几条。一条都不能少。**',
    '',
    '- 写在**说到这句话的那一格**里：`A white oval speech bubble beside her reads "坂本先生，是我。"`',
    '- **原话多长就写多长 —— 一个字都不许删、不许截断、不许改写、不许译成英文、不许用拼音。**',
    '  删掉半句 = 改了她的台词，这是读者一眼就能发现的错误。',
    '- ★★ **太长就拆格，不要删字**：',
    '  · 一句话超过一个气泡的容量时，**按句读拆成两句**，分到相邻两格，各给一个气泡；',
    '  · 这张图的格子数不够 → 把剩余台词放进**这一楼的另一张图**（`images[]` 多一项）；',
    '  · 这一楼装不下 → 留到**后面的楼层**继续画。',
    '  · **凡是画到的句子，必须完整**。',
    '  > 官方二次元模板 §13.3 原话：「字数多时增加画布/字区、减少装饰或**拆图**，**不擅自删掉用户要求的字**。」',
    '  > 这条与「不删台词」是同一个意思 —— 装不下就加格子 / 加图，不是砍字。',
    '- **一格一个气泡**（两句对白就拆两格）。这一刻确实没人说话的格子写 `No text in this panel.`',
    '- 🚫 **禁止空引号**：`reads ""` / `reads " "` 一律不许出现。',
    '  · 引号里没有字，说明这句气泡不该存在 —— 要么补上原话，要么整句删掉改写成 `No text in this panel.`。',
    '- 需要指定位置时用 `on the left` / `on the right` / `at the top`；',
    '  旁白（时间 / 地点 / 心理）用 `A narration box reads "23:47　雨"`。',
    '- ★ 官方要求：要追求文字正确率或精确换行时**在 prompt 里手写换行** ——',
    '  同一个气泡里确实要分两行时，直接把引号内的句子断成两行写，不要让它自己折行。',
    '',
    '#### 段落顺序（照这个顺序写，不要改）',
    '```',
    '① 版面声明（或单图的风格/场景句）   ← 固定句式',
    '② 人物段                            ← 插件自动插入，你不要写',
    '③ Panel 1, 方位词: …                ← 每格一段，格内可带气泡',
    '④ Panel 2, 方位词: …',
    '⑤ Panel 3, 方位词: …',
    '```',
    '人物段必须早于分格内容 —— 写在末尾或夹在中间，脸和衣服都会散。',
    '',
    '### 3.4 单图剧情（不分格）',
    '按「主体 → 核心动作 → 机位 → 光线 → 材质 → 色调」一层一句地写。',
    '- 景别 `close-up` / `medium shot` / `wide shot` **只写一个**。',
    '- **承重面必写**（靠什么撑住身体）、**两只手的位置必写** —— 缺一项必崩（同 §3.3）。',
    '- 人物外貌同样由插件注入（插在风格/场景句之后、动作句之前），你用 `she` / `he` / `the girl` 指代。',
    '  **双人要保证两个人的动作句分开写**，不要交错成一句 —— 交错会让模型分不清谁的手在谁身上。',
    '',
    '### 3.5 禁止项（MOSS 口径）',
    '- ★ **中文只能出现在引号内（台词 / 旁白）**：引号外的裸中文词有概率被直接画成画面上的字',
    '  （实测踩坑）。画面描述、档案字段一律英文 —— 这不是「禁中文」，而是「中文只用来写字」。',
    '- **禁止质量词 / 写实词**：`masterpiece` `best quality` `highres` `8k` `ultra detailed`',
    '  `photorealistic` `film grain` `raw photo`。',
    '- **禁止否定表述**：不写 `no hat`，直接不提帽子（提什么画什么）。',
    '- **禁止 `multi view` / `comic` / `manga panel` 这类空泛词**：它们不切格。',
    '  切格只认 3.2 那句完整分格声明 + 每格的 `Panel N, 方位词:`。',
    '- **禁止写坐标 / bbox**：本模版走纯 prompt。Layout JSON 那套要单独填，不写进 `tag`。',
    '- **禁止跨图引用**：「承接上一张」「与上张一致」「同上」都不许写 —— 每张图独立生成。',
    '- **禁止画外内容**：谁在按快门、机位架在哪、看不见的心理因果，一律不写。',
    '- **禁止 `@角色名`**（同系统提示）：外貌由插件注入，你不要写引用，也不要自己再抄一遍档案。',
    '',
    '### 3.6 篇幅',
    '- 多格：每格 **40~90 词**，三格约 **200~300 词**。',
    '- 单图：**120~200 词**。',
    '- 宁可少写一格，也不要把同一件事写两遍 —— 复述 = 模型画两遍。',
    '',
    '### 3.7 尺寸与采样参数（不写进提示词）',
    '格子能不能切开、出字清不清楚，与尺寸和采样参数有关 —— 那些在绘灵的「生图后端」里设，',
    '**本规范不管、也不要写进 `tag`**（社区模型各有一套参数要求，用户自己清楚）。',
  ].join('\n');
}

/**
 * MOSS 口径的 protocol 补充（v0.9.118 改契约：必须输出 cast 点名）。
 *
 * ★★★ 为什么必须让模型输出 `cast`（v0.9.117 写的是「只输出 tag」）：
 *   插件注入英文人物段靠的是 `image.cast` → castAnchors → eff。
 *   一旦禁止输出 cast，MOSS 下 castAnchors 恒为空，而 MOSS 又不许写 `@角色名`
 *   ⇒ 锚点来源**零个** ⇒ 人物段永远生成不出来。v0.9.118 第一版就栽在这里：
 *   代码写好了，但端到端一看 castEn 是空串，等于没修。
 *
 *   所以现在 cast 的职责收窄成「点名」：只写 name，不写 en / 外貌 / 服装。
 *   它不再参与画面词，只用来给插件查档案。
 */
function mossProtocolAddon() {
  return [
    '',
    '## MOSS 口径补充（本模版专属，不要删除）',
    '',
    '`images[]` 每项输出三个字段：`position`、`cast`、`tag`。',
    '',
    '```json',
    '{ "position": "P8",',
    '  "cast": [{ "name": "月咏深雪" }, { "name": "夜斗" },',
    '           { "name": "巡查员", "look": "a middle-aged man with short grey hair, dark blue security uniform" }],',
    '  "tag": "A vertical Japanese manga page divided into three panels by white gutters with thin black borders, clean anime line art.\\n\\nPanel 1, narrow strip at the top left: medium shot of ...\\n\\nPanel 2, top right: extreme close-up of ...\\n\\nPanel 3, wide panel filling the bottom half: ..." }',
    '```',
    '',
    '- ★ **`cast` 就是「这张图里画了谁」的点名册**，一个人一项，**画面里出现的人一个都不许漏**。',
    '  · **反过来也成立：这一页里不出现的人，不要写进 `cast`。**',
    '    写了就会给他注入一整段外貌描述 —— 那等于告诉模型「他要出场」。',
    '    实测（2026-10-21）：四格都没有巡查员，`cast` 里写了他，人物段就多出一段中年男性，',
    '    模型开始在格子里找人塞。真的只在画外说话（楼下的声音 / 电话那头），写 `"offscreen": true`。',
    '  · 档案里**已有**的角色 → 只写 `name`（名字逐字照抄档案库，一个字都不许改）。',
    '    不要写 `en` / 不要写外貌 / 不要写服装 —— 插件按档案生成英文人物段。',
    '  · 档案里**没有**的人（巡查员 / 店员 / 路人 / 只有身份没名字的人）→ 写 `name` + `look`。',
    '    `look` 用**一行英文**写他的外貌（年龄感 + 发型发色 + 体型 + 穿什么），插件直接拿它生成人物段。',
    '    **同一个路人，这一楼所有图里用同一个 `name`**（别一张写「巡查员」、一张写「坂本先生」）。',
    '  · 同时要在 `changes` 里给他一条 `{"name":"巡查员","kind":"new","fields":{...}}` 建档，',
    '    这样下一楼他再出现时外貌才能延续。',
    '- **漏了谁，谁就没有外貌锚定** —— 这就是「第三个人被画成女主复制品」的直接原因。',
    '- **不要输出 `scene` / `nl` / `mood`**：MOSS 口径下这几个字段会被丢弃。',
    '- `tag` 内**必须用换行把每一格分开**（第一行版面声明，之后每格一段）——',
    '  一段到底会让模型把三格内容揉成一张图。这是本口径最容易踩的坑。',
    '- **`tag` 里不写人名、不写 `@`**：用「发色 + 服装主色」的身份锚点指代 ——',
    '  `the black-haired girl in the navy sailor uniform`。',
    '  光写 `the girl` 在多人时会指向最近提到的那个人（官方模板 §8.4 要求「每格重述身份」）。',
    '  **完整外貌不要写进格内**，那是人物段的事；格内只给最小可区分锚点。',
    '- ★ **中文只写在引号内**（台词 / 旁白）：`reads "坂本先生，是我。"`。',
    '  引号外的中文一律不许（会被画成画面上的字）。**台词原话多长写多长，不许截断**，',
    '  太长就拆格、拆图或留到后面的楼层。`reads ""` 这种空引号一律不许出现。',
    '- 单图剧情时 `tag` 就是一段连续描述：不分行、不写 `Panel`。',
    '- `changes` 照常输出 —— 角色档案与服装状态靠它维护（人物段就是照它生成的，写错了人就换了）。',
  ].join('\n');
}

export const MOSS_SYSTEM_ADDON = mossSystemAddon();
export const MOSS_PROTOCOL_ADDON = mossProtocolAddon();

/* ══════════════════════════════════════════════════════════════════════════
 * MOSS JSON Layout 口径（v0.9.121）
 *
 * 与「MOSS（多格漫画）」纯 prompt 版**共用同一套内容规范**（分镜 / 服装 / 台词 / NSFW），
 * 只有**输出形态**不同：纯 prompt 版把画面写成一段英文提示词；本口径写进 JSON Layout。
 *
 * 依据（全部能贴原文）：
 *   `MOSS酒馆生图模型/官方文档/USERGUIDE_ZH.md` §Layout Prompt
 *   `MOSS酒馆生图模型/提示词模版/MOSS二次元提示词模板_sfw版.md` §12 / §13 / §14
 *   · §12.2 label 只能是 character / object / text；禁止 panels / panel_id / children / style / id
 *   · §12.3 成稿根字段仅 summary / items / bbox_coord_space / bbox_format，一行紧凑 JSON
 *   · §13.4 multi_panel 的**格框用 object 表示每格可见背景**；角色/文字按全局坐标
 *   · §13.4 同一角色在两格各出现一次 → **重述同一身份特征**并说明重复出场
 *   · §13.1 不要给同一人物的「脸」和「身体」各建一个 character（会被理解成两个人）
 *   · §14 坑表「草稿写 0.1–0.9」→ 归一化坐标会被当成不到一像素
 * ══════════════════════════════════════════════════════════════════════════ */

/** JSON 版的 system 追加段（替换纯 prompt 版的 MOSS_SYSTEM_ADDON）。 */
function mossJsonSystemAddon() {
  return [
    '',
    '**本模版是「MOSS-Image 口径 · JSON Layout」的多格漫画分镜**。',
    '你的工作顺序是**先分镜、再落坐标**：定页面形态 → 定主格与各格大小 → 逐格写「这一刻看得到的东西」。',
    '输出不是一段提示词，而是一份**版面布局 JSON**（「谁、在哪一格、什么位置、在做什么」用坐标钉死）——',
    '这是官方支持的输入格式之一，也是多人同框时唯一能稳住「谁是谁」的写法。',
    '',
    '- **必须输出 `cast` 点名**：插件靠它核对这张图里本该有谁。',
    '  · 档案里**已有**的角色 → 只写 `name`（名字逐字照抄档案库）。',
    '  · 档案里**没有**的人（巡查员 / 店员 / 路人）→ 写 `name` + `look`（一行英文外貌速写）。',
    '  反过来也成立：**这一页里不出现的人，不要写进 `cast`**（写了等于告诉模型他要出场）。',
    '- **人物外貌与服装这次要你写**（纯 prompt 版是插件注入，别混用），',
    '  但**只写这一格看得见的部分**：身份锚点 + 可见衣着 + 动作。',
    '  完整**外貌**整页只写一次（见规范 §3.3）—— 抄全份会挤掉动作与关键细节；',
    '  但**衣着每格都要写**（这一格看得见的那部分），不许写「同上」或省掉（见规范 §4.3）。',
    '- ★ **MOSS 原生支持中文，不要套用单图口径的「禁中文」规则**：',
    '  画面描写用英文（控得准、可复现），**说出口的话必须用中文原话**写进 `text` 项。',
    '  不要输出 `scene` / `nl` / `mood` —— 这几个字段会被整段丢弃。',
    '- **不写 `@角色名`**：MOSS 不认记号，写引用会被剥掉且没有兜底。',
    '- **禁止质量词与写实词**（理由与清单见规范 §六）—— 这类词会把分好的格子又压回一张图。',
    '- `layout` 是一个**嵌套对象**（不要塞成字符串），格式见输出协议。',
  ].join('\n');
}

/** JSON 版 protocol 追加段。 */
function mossJsonProtocolAddon() {
  return [
    '',
    '## MOSS Layout 口径补充（本模版专属，不要删除）',
    '',
    '`images[]` 每项输出三个字段：`position`、`cast`、`layout`；**不要**输出 `tag` / `nl`。',
    '',
    '### `layout` 的结构',
    '```json',
    '{',
    '  "width": 880, "height": 1184,',
    '  "bbox_coord_space": "abs", "bbox_format": "xyxy",',
    '  "summary": { "caption": "画风句 + 版面声明 + 整体场景", "canvas": "multi_panel", "meta": ["manga", "comic page"] },',
    '  "items": [',
    '    { "label": "object",    "caption": "Panel 1: 位置 + 场景 + 景别 + 光线 + 人数", "bbox": [0, 0, 880, 382] },',
    '    { "label": "character", "caption": "锚点 + 可见衣着 + 动作 + 视线", "bbox": [245, 31, 653, 370] },',
    '    { "label": "text",      "caption": "气泡外观 + 排版（行数/字体/字色/留白）", "text": "正文原话", "bbox": [571, 41, 856, 195] }',
    '  ]',
    '}',
    '```',
    '',
    '### `summary.caption` 写什么',
    '- **第一句 = 画风**（整页只写一次）：`Clean anime line art, mature dramatic manga style…`。',
    '- **第二句 = 版面声明**：格数 + 朝向 + 白边，`A vertical three-panel page with white gutters.`',
    '- **第三句 = 整体场景**：同一地点 + 光线。',
    '- 这里只写**页面级**信息 —— 塞人物细节会把格子声明挤掉。',
    '',
    '### 坐标怎么写（最关键）',
    '- 用**左上角为原点**的像素框 `[x0, y0, x1, y1]`，必须 `0 ≤ x0 < x1 ≤ width`、`0 ≤ y0 < y1 ≤ height`。',
    '- **真实像素整数**。不要百分比、不要 0~1 小数、不要格内局部坐标 ——',
    '  官方坑表明确：「草稿写 0.1–0.9」会被当成**不到一像素**的实际数值。',
    '- `width` / `height` 必须填**提示词末尾给你的那个画布尺寸**（每次出图都可能变，逐字用当次的值）。',
    '  ⚠️ **上面示例里的 880×1184 只是示意，不是这次要用的数** —— 一律照末尾那行「画布尺寸」写，',
    '  差一个数都算错（代码按你声明的尺寸换算坐标，声明的画布和实际出图不一致 = 整张图缩放偏移）。',
    '- 框的面积必须为正（`x0 ≠ x1`、`y0 ≠ y1`）。',
    '',
    '### items 三类，缺一类就画错',
    '',
    '**① 每格一个 `object`** —— 这一格的**可见背景区域**，作用是把格框钉死。',
    'caption 写：位置称呼 + 场景 + 景别 + 光线 + 人数。',
    '`"Panel 1: the full-width main panel at the bottom, a school council room at sunset in warm orange light, exactly two people in this panel."`',
    '> 少一个 object 项 = 模型自己均分版面（官方 §13.4：格框用 object 表示）。',
    '',
    '**② 每个角色一个 `character`** —— 外貌写在这里，但**只写这一格看得见的部分**。',
    '`"The black-haired woman in the white sailor blouse stands by the window, her knuckles pale, looking down at a document."`',
    '- ★ 格内出现的**每个人**都要有独立的一项，不许用 `the girl` / `she` 指代了事。',
    '- ★ 同一人在两格都出现 → **两格各写一项**，重述**可见的身份锚点**（官方 §13.4）；',
    '  不要再抄一遍完整外貌（会挤掉动作与关键细节）。',
    '- ★ 一项里**只写这一个人**：不许把别人的衣服 / 发色写进来。',
    '- ★ **不要**给同一人的「脸」和「身体」各建一项（官方 §13.1：会被理解成两个人）。',
    '',
    '**③ 有台词的格配一个 `text`** —— 把原话**锁死**。',
    '`{ "label": "text", "caption": "Vertical oval speech bubble beside her head, white fill with a thin black outline.", "text": "这份名单……是你交上去的？", "bbox": [...] }`',
    '- `text` 里写**正文原话**，中文原样，一个字都不许删改译。',
    '- 气泡的 bbox 放在**说话人头部附近**，不要跨格。',
    '- 这一格没人说话就**不要**放 text 项（不要写空字符串）。',
    '',
    '### 版面与坐标的对应（避免越界）',
    '- 🚫 **不要自己分版**：这一版用哪种版式、每格的像素框，提示词末尾「本次出图的形态与画布」',
    '  那节已经按本次画布算好了 —— **直接照抄那几行** `Panel N: [y0, x0, y1, x1]`。',
    '- **各格面积本来就不相等**（上小下大 / 左窄右宽 / 细条 + 大格都正常），照抄即可，',
    '  不要在脑子里改成「三等分」或「均分 2×2」。',
    '- 格间留 8~16px 白边（gutters）。',
    '- **角色框必须落在它所在那格之内**（可内缩留边距）；气泡框同理，不要跨格。',
    '',
    '### 其它',
    '- `changes` 照常输出 —— 角色档案与服装状态靠它维护。',
    '- `cast` 只写**这张图里真的会出现的人**；只在画外说话的人写 `"offscreen": true`，不要进 `cast`。',
    '- **不要输出 `tag` / `nl` / `scene` / `mood`**：本口径只认 `layout`。',
    '- 不需要配图时返回 `{"changes":[...],"images":[]}`。',
  ].join('\n');
}

/**
 * 单图版（`output: 'json'`）的输出协议。
 *
 * ★★★ 为什么不能复用 `mossJsonProtocolAddon`：
 *   那份协议通篇在要求 `width/height`、`bbox`、每格一个 `object`、坐标照抄 ——
 *   单图版**一个坐标都不写**（依据见 `mossSingleJsonSpecSection12` 的注释与
 *   `dev_tmp/single_multi/_eval.md` 的 36 张对照）。两份协议同时在场时模型只会挑一份听，
 *   结果就是「有时带坐标有时不带」，比两份都错更难查。
 */
function mossSingleJsonProtocolAddon() {
  return [
    '',
    '## MOSS 单图口径补充（本模版专属，不要删除）',
    '',
    '`images[]` 每项输出三个字段：`position`、`cast`、`layout`；**不要**输出 `tag` / `nl`。',
    '',
    '### `layout` 的结构（单图 · 没有坐标）',
    '```json',
    '{',
    '  "summary": {',
    '    "meta": ["anime", "digital illustration"],',
    '    "canvas": "single",',
    '    "caption": "画风句 + 场景 + Exactly N people are visible…"',
    '  },',
    '  "items": [',
    '    { "label": "character", "caption": "身份锚点 + 完整衣着 + 一个主动作 + 一个承重面 + 位置" },',
    '    { "label": "text", "caption": "气泡外观描述", "text": "正文原话" }',
    '  ]',
    '}',
    '```',
    '',
    '- 🚫 **不要写 `width` / `height` / `bbox` / `bbox_coord_space` / `bbox_format`** ——',
    '  本口径**不出现任何坐标**。位置一律用文字方位词（`at the far left edge` / `left of centre` …）。',
    '- `canvas` 恒为 `"single"`。',
    '- 🚫 **不要建 `object` 项**：没有格子，也就没有格框。场景写在 `summary.caption`。',
    '',
    '### `summary.caption` 写什么（三句，按顺序）',
    '1. **画风**（整图只写一次）：`Clean anime line art, cinematic lighting…`',
    '2. **场景**：同一地点 + 时间 + 光线，`A classroom corner in warm spring morning light, dust in the beams.`',
    '3. **人数**：`Exactly N people are visible in the frame and nobody else.`',
    '   （N = `character` 项个数；三人以上再补 `The frame closes tightly around these N people.`）',
    '   ★ **没有第四句**：🚫 不写景别、不写机位（见规范 §2.2）。',
    '',
    '### items 两类',
    '',
    '**① 每个可见的人一个 `character`** —— 外貌与服装**都必须写在这里**（本口径插件不注入人物段）。',
    'caption 写：**身份锚点（发色 + 一件最能区分他的东西，5~8 词）+ 完整衣着 + 一个主动作 + 一个承重面 + 一个位置方位词**。',
    '> `The blonde girl with long golden twin tails in a white dress shirt and a navy pleated skirt,',
    '> standing with one hand on her hip, left of centre, the tallest figure in the front group.`',
    '',
    '- ★ **同一个人只建一项**。挪了位置、换了姿势、换个角度看到 —— 都还是这一项。',
    '- ★ 一项里**只写这一个人**：别人的衣服 / 发色 / 身体部位不许混进来。',
    '- ★ 🚫 **不要在人物项里重复场景词、也不要写人数**（各自只写一次，写 N 遍会被当成 N 个东西）。',
    '',
    '**② 有台词才建 `text`** —— 把原话锁死。',
    '`{ "label": "text", "caption": "Vertical oval speech bubble beside her head, white fill with a thin black outline, medium-weight Chinese characters, evenly spaced.", "text": "这份名单……是你交上去的？" }`',
    '- `text` 里写**正文原话**，中文原样，一个字都不许删改译。',
    '- ★★★ **`caption` 必须描述排版，不只是「气泡放哪」**：写清**行数**、对齐方式、字号层级、',
    '  字体风格（手写体 / 印刷体 / 粗黑体）、字色、留白。官方给打标模型的要求原文是',
    '  「line breaks, ordering, relative position, alignment, size hierarchy, font/style, color, spacing」；',
    '  官方示例措辞就是 `comfortably legible on two lines`。',
    '  · 🚫 但不是让你自己数行数 —— **行数由插件算完写进 caption**，你只要写「排版长什么样」。',
    '  · 🚫 **也不许在 caption 里写行数本身**（`two lines` / `6 lines` 都不行）：你数的和插件折出来的',
    '    经常不是一个数，两个数同时出现在一句里，模型会按错的那个排框。上面例子里**故意没有行数**。',
    '- **一句一项，原话写全**：**不要自己拆、也不许删字** —— 插件会在停顿处插入换行（`\\n`），',
    '  让长句在**同一个气泡里**排成两行。',
    '  （官方 USERGUIDE 原文：要控制换行或提高文字正确率，就往 prompt 里插 `\\n`。',
    '   实测：黑板同一句 12 字，不换行两轮都丢字，插换行后两轮一字不差。',
    '   断行是纯机械活，交给代码做 100% 准；**你自己一个换行符都不许写**。）',
    '- 这张图没有人说话就**不要**放 `text` 项（不要写空字符串）。',
    '',
    '### 其它',
    '- `changes` 照常输出 —— 角色档案与服装状态靠它维护。',
    '- `cast` 只写**这张图里真的会出现的人**；只在画外说话的人写 `"offscreen": true`，不要进 `cast`。',
    '- **不要输出 `tag` / `nl` / `scene` / `mood`**：本口径只认 `layout`。',
    '- 不需要配图时返回 `{"changes":[...],"images":[]}`。',
  ].join('\n');
}

/**
 * 单图 JSON 版的 §三~§八（**独立一份，不复用多格那份**）。
 *
 * ★★★ 为什么不复用：多格那份里这些句子对单图是**直接反向**的要求 ——
 *   · §五「太长就拆格…一格一个气泡」+ text 项必须带 `bbox`；
 *   · §八 自检「格数对得上吗 / 每格大小不同吗 / 每格有人数声明吗 / 跨格出现的同一个人建项了吗」。
 *   两份同时在场时模型只会挑一条听（老纪律：两条规则互相抵消 = 最难查的 bug），
 *   而这里挑错的代价是**重新分格 + 多画人**，正是用户报的那个症状。
 *   ⇒ 宁可多写一份 3000 字，也不让两套判据打架。
 */
function mossSingleJsonSpecSection3() {
  return [
    '## 三、角色：谁出场、写什么',
    '',
    '### 3.1 角色 DNA（走 `changes` 维护）',
    '每个实际出场的人物（含路人）都要有稳定记录：**姓名 / 外貌 DNA / 穿搭 DNA / 差异化特征**。',
    '',
    '- 外貌 DNA：发长、发型结构、发色、眼、体态、固定配饰（一律英文视觉词）。',
    '- 穿搭 DNA：开场服装款式、材质、配饰。',
    '- ★ **差异化特征**：从稳定可见的特征里挑出**足以和这张图里其他人区分**的那几项',
    '  （发型结构 / 眼睛 / 体态 / 独有衣物 / 配饰）—— 这是防串色的唯一依据。',
    '- 发型 / 发色 / 卷度 / 扎法 / 刘海 / 妆面是**人设，不得改动**；',
    '  只有 `hairState` / `makeupSmudge` 能随剧情变。',
    '- 档案库里 `[locked]` 的条目属于用户主权区，**永远不要为它产生 change**，画面里照抄原值。',
    '',
    '### 3.2 外观变化',
    '发型 / 发饰 / 服装 / 破损 / 配饰发生剧情变化时，记下**从哪一楼起生效**，之后沿用；',
    '其余时候沿用外貌 DNA 与已生效的变化。**换镜头、换角度不构成外观变化**。',
    '',
    '### 3.3 每个人写什么（一项只写一个人）★★★',
    '',
    '每个可见人物一个 `character` 项，caption 写：',
    '**身份锚点（发色 + 一件最能区分他的东西，5~8 词）+ 这一张看得见的完整衣着 + 一个主动作 + 一个承重面 + 一个位置方位词**。',
    '',
    '- ❌ **全身档案照写法**（会把动作挤掉，画面只剩一张证件照）：',
    '  `The tall woman with long straight black hair, blue eyes, fair skin and large breasts,',
    '  wearing a white blouse with a navy sailor collar and a dark pleated skirt. She stands by the window.`',
    '- ✅ **锚点 + 可见衣着 + 动作**：',
    '  `The black-haired woman in the white sailor blouse stands by the window, her knuckles',
    '  pale, looking down at a document.`',
    '- ★★ **外貌**（发色 / 瞳色 / 脸型 / 体型）在**同一项里只写一次** ——',
    '  换同义词再写一遍同样会被平均成模糊中间态。',
    '- ★★ **衣着相反**：**每一项都要写这一项看得见的完整衣着词**（见 §4.3），',
    '  不许写「同上」，也不许因为「刚才写过」就省掉。',
    '- ★ **一项里只写这一个人**：别人的衣服 / 发色 / 身体部位写进来就是串色。',
    '- ★ 这一张里出现的**每个人**都要有独立的一项，不许用 `the girl` / `she` 指代了事。',
    '',
    '## 四、服装与脱卸边界',
    '',
    '### 4.1 穿搭 DNA 是给定值',
    '档案行里的 `服装=` 就是这位角色的**穿搭 DNA**（款式 / 材质 / 颜色 / 配饰）。',
    '它是**给定值**，不是参考建议 —— 这一张画的就是这一套。',
    '- **第一次出场时把 DNA 写完整**，完整到别人能照着复现同一套衣服：',
    '  `her pink and white maid outfit, the pink ribbon apron with loose untied back ties,',
    '  white lace-trimmed thigh-high stockings`。',
    '- 🚫 **不许换品类、不许改颜色、不许把整体名拆成你想当然的单品**：',
    '  实测档案是 `pink and white maid outfit`，模型写成 `white apron … a white blouse` ——',
    '  粉色没了、`maid outfit` 变成 `blouse`，女主等于换了个人。',
    '  ⇒ 主品类词和颜色必须在。带一件具体单品来解释是允许的，但**不能用单品替换整体**。',
    '- 档案 `服装=(未记录)` 时才从正文取；正文也没写，就写一套中性衣服，并在 `changes` 里建档。',
    '',
    '### 4.2 变化只认「从哪一楼起变成了什么」',
    '- ◆ **换镜头、换角度不构成外观变化**。没写变化，就必须沿用 DNA ——',
    '  不许因为「这一张看不到」就当它换了、脱了、没了。',
    '- 换了衣服要写 `now wearing …`（**替换**，不是叠加）。',
    '- 换衣服只能来自正文或 `changes`，**你自己不许换**。',
    '',
    '### 4.3 每一项都要写完整衣着词 ★★★',
    '**每个可见人物，都写这一项看得见的完整衣着词** —— 把穿搭 DNA（或已生效变化）里',
    '这部分**重新写一遍**，不要指望读者记得别的图。',
    '- 🚫 **禁止「同上」「as before」「same outfit」**，也禁止只写姓名就算交代了穿着。',
    '- **局部镜头只写实际可见、且与身份连续有关的部位**（特写脸就不写鞋袜）。',
    '- ◆ **画外不等于消失**：这一张没写裙子和鞋，不代表她没穿；',
    '  **下一张重新入镜时必须原样写回来**，不许到时候忘掉或换掉。',
    '',
    '### 4.4 已全部褪下的角色：反向规则（一个衣物名词都不许写）★★★',
    '**只对档案行写着 `服装状态=褪下(removed)` 的角色生效。**',
    '`完好(intact)` / `半褪(parted)` / `已解开(undone)` 的角色**不适用本节**，按 §4.1~§4.3 写。',
    '（这两节方向完全相反 —— 别把 §4.3 的「必须写衣着」套到全裸角色上，',
    '也别把本节的「不许写衣物」套到还穿着衣服的角色上。）',
    '- 这一张**不许出现任何衣物名词**：连 `hanging open` / `pulled aside` / `around the waist`',
    '  都不行（那仍然是一件衣服在画面上）。',
    '- 改写成裸露状态：`completely nude` / `bare-chested` / `bared pelvis`，再加体液、痕迹、体温、呼吸。',
    '- **「必须写衣着」不适用于这一类角色** —— 已褪下就是没有衣着，强行补一件＝凭空造衣服。',
    '',
    '### 4.5 衣着变化用部位词挂在动作上',
    '| ❌ 别写 | ✅ 这样写 |',
    '|---|---|',
    '| `the sleeve is rolled up` | `she reaches up, her sleeve sliding back` |',
    '| `the collar is loosened` | `her raised arm pulls the collar slightly open` |',
    '| `the hem is raised` | `the wind lifts the hem` |',
    '',
    '可用部位词：`collar` / `hem` / `sleeve` / `cuff` / `waistband` / `lapel` / `the fabric`。',
    '',
    '### 4.6 脱卸边界与状态位 ★★★',
    '每件**离开原位**的衣服都要写清三件事：**还穿在谁身上 / 褪到哪一截 / 还挡住什么**。',
    '- ✅ `her white blouse pushed up above her chest and bunched at her collarbone`',
    '- ✅ `navy skirt and panties pulled down to mid-thigh, one leg still in them`',
    '- 🚫 `naked` / `topless` / `no bra` / `naked from the waist down` **单独出现**（身上还有衣服时）——',
    '  这些是**区域词**，不是边界，必须配上「还剩什么在身上」。',
    '  ★ 但**已全部褪下**的角色例外（见 §4.4）：`completely nude` 就是他的完整状态，',
    '  此时必须这么写，**不许**为了凑一个「边界」给他补一件敞着的衣服。',
    '- 🚫 **下衣还在腰上就写插入**：台本没写隔着衣服，就必须先写清褪到哪一截。',
    '- ★★ **穿着状态只由 `outfit` / `outfitState` 表达**：姿态字段（`condition` / 状态）里',
    '  **不许出现衣物名词**（`through open trousers` / `shirt open` / `skirt lifted` 都算）。',
    '  ⚠ 这条**只管姿态字段**，**不是**让你在 character caption 里少写衣服 —— caption 里的服装照 §4.1~§4.3 写。',
    '- 状态位推进走 `changes`：',
    '  `{"name":"角色名","kind":"set","fields":{"outfit":"...","outfitState":"parted"}}`；',
    '  只能前进 intact → parted → undone → removed，重新穿好写 `redress:true`。',
    '- **档案里没有的临时角色**（巡查员 / 店员 / 路人）：caption 也要写锚点 + 可见外貌 + 服装，',
    '  并在 `changes` 里给他建档，这样下一楼再出现时能延续。',
    '',
    '## 五、台词 = text 项（MOSS 的核心能力，必须用满）★★★',
    '',
    'MOSS 最强的能力就是**文字渲染**（官方 USERGUIDE：「图里要出现的字保留原文」）。',
    '**正文里说出口的话，必须原样出现在画面上。**',
    '',
    '**动手前先做一件事：把正文里带引号的对白逐条摘出来，数一数有几条。一条都不能少。**',
    '',
    '- 写成 `{"label":"text","caption":"气泡外观 + 排版","text":"原话"}`（**不带 bbox**）。',
    '- ★★★ `caption` 要写**两件事**：① 气泡长什么样、在谁旁边；② **排版**——',
    '  行数、对齐、字号层级、字体风格、字色、留白。官方给打标模型的原文要求是',
    '  「line breaks, ordering, relative position, alignment, size hierarchy, font/style,',
    '  color, spacing」，官方示例措辞 `comfortably legible on two lines`。',
    '  例：`Vertical oval speech bubble beside her head, white fill with a thin black outline,',
    '  medium-weight hand-lettered Chinese, evenly spaced, comfortably legible.`',
    '  ⚠️ 例子里**故意不写行数**（没有 `two lines`）：行数由插件按实际折行写死，',
    '  你写的行数和它算出来的对不上时，模型会照你写的排框 → 字挤爆框。**别写行数。**',
    '- ★ **原话写在 `text` 字段里**，不要写进 caption（不能只说「这里有个标题」让模型自己编文案）。',
    '- **原话多长就写多长 —— 一个字都不许删、不许截断、不许改写、不许译成英文、不许用拼音。**',
    '- ★★★ **原话写全，不要自己拆、也不要自己加换行**：一句台词只建**一个** `text` 项，',
    '  把原话一字不差写全 —— 插件会在停顿处插 `\\n` 让长句在同一个气泡里排成两行。',
    '  ⇒ 你**不许**为了「放得下」删字、截断、改写，也**不许**自己拆成两项（数数字不可靠，实测遵守率 67%）。',
    '  > 依据是官方原话（USERGUIDE）：要控制换行或提高文字正确率，就往 prompt 里插 `\\n`；',
    '  > layout 文档同一句：`Use separate text items when placement must be independent` ——',
    '  > 拆项的条件是「位置要各自独立」，**不是**「这句太长」。',
    '- 🚫 **禁止空 text**：`"text": ""` / `"text": " "` 一律不许（没台词就别建 text 项）。',
    '- 没人说话就不建 `text` 项（别为了凑气泡编台词）。',
    '- 旁白（时间 / 地点 / 心理）也可以用 text 项：`"text": "23:47　雨"`，',
    '  caption 写 `A rectangular narration box at the top left, white fill with a thin black border.`',
    '',
    '## 六、禁止项（单图 JSON 口径）',
    '- ★ **中文只能出现在 `text` 字段里**（台词 / 旁白）：caption 里的裸中文会被画成画面上的字。',
    '  画面描述、档案字段一律英文。',
    '- 🚫 **质量词 / 写实词**：`masterpiece` `best quality` `highres` `8k` `ultra detailed`',
    '  `photorealistic` `film grain` `raw photo` —— 画风词只在 `summary.caption` **第一句**写一次。',
    '- **禁止否定表述**：不写 `no hat`，直接不提帽子（提什么画什么）。',
    '  想表达「只有这些人」→ 用正面句 `the frame holds exactly N people`。',
    '- **禁止非官方字段**：`panels` / `panel_id` / `children` / `parent` / `style` / `id` /',
    '  `elements` / `negative_prompt` / 采样参数（官方 §12.2 / §12.3）。items 永远是**扁平数组**。',
    '- 🚫 **禁止出现 `bbox` / 坐标 / `width` / `height`** —— 本口径没有坐标。',
    '- **禁止跨图引用**：「承接上一张」「与上张一致」都不许写 —— 每张图独立生成。',
    '- **禁止画外内容**：谁在按快门、机位架在哪、看不见的心理因果，一律不写。',
    '- **禁止 `@角色名`**，也不许用编号 / 代号代替人物。',
    '',
    '## 七、篇幅与优先级',
    '- character caption = **身份锚点 + 完整衣着 + 这一刻的动作**。常规 **50~110 词**；',
    '  成人场景按「成人画面」那节给的额度（**85~130 词**），那一节优先。',
    '- `summary.caption`：画风句 + 场景 + 人数，**40~80 词**。'
      + '（★ v0.9.157：**不带景别**，见 §2.2）',
    '- 全图 items 总数：2 人约 **3~4 项**，4 人约 **5~6 项**，8 人约 **9~12 项**。',
    '- ★ **宁可少写一个人，也不要把同一件事写两遍**（同一动作 / 同一件衣服写两遍 = 画两份）。',
    '- ★★ 反过来：**不要为了压词数删掉承重面 / 主动作 / 衣物边界** ——',
    '  这几项删掉画面就崩（断肢、穿模、悬空、凭空多出衣服）。要压就砍重心、下肢落点、朝向、氛围词。',
    '',
    '## 八、输出前自检（逐条过，不合格就改）',
    '',
    '1. **`summary.caption` 里的人数 = `character` 项数吗**？（写成 Exactly N people…）',
    '2. **每一项目里都没有 `bbox` / 坐标 / `width` / `height` 吧**？',
    '3. **有没有给同一个人建了两项**？（挪位置、换姿势都还是同一项）',
    '4. **每个 character 都是独立项吗**：有没有用 `the girl` / `she` 指代了一个本该建项的人？',
    '5. **动作只有「一个主动作 + 一个承重面」吗**：有没有多写重心 / 下肢落点 / 空着那只手 / 朝向？',
    '6. **`summary.caption` 里有没有偷偷写景别或机位**？（`medium shot` / `from a low angle` 一律删）',
    '7. **台词全吗**：正文里带引号的句子，是不是每句都进了 `text`、一字未改、也**没有自己拆项**？（拆由插件做）',
    '8. **中文有没有跑到 caption 里**？',
    '9. **状态连贯吗**：上一楼持有的东西、持续的接触、衣物的位置在这一张还成立吗？',
    '',
    '> 1~6 是最容易漏的六条，漏了直接就是「多画一个人」、断肢、穿模与被拉长压瘪。',
  ].join('\n');
}

/**
 * 单图纯 prompt 版（`output: 'text'`）的 spec。
 *
 * 与 JSON 版的区别只在「怎么把画面交出去」：这里输出**一段连续的英文画面描写**，
 * 没有 `summary` / `items` / 坐标。人物外貌与服装由插件按档案注入，模型只写动作与镜头。
 * §二 的判据与 JSON 版同源（同一批真实出图教训），所以措辞刻意保持一致。
 */
export function mossSinglePlainSpec() {
  return [
    '# 单图规范（MOSS-Image · 单图纯 prompt 口径）',
    '',
    '> 一楼的正文只画**一张**图：一个场景、一个时刻、一整幅画面。不分格、不拼贴、不做同页多画面。',
    '',
    '## 一、形态',
    '- 这一张就是整幅画面。🚫 **不要写 `Panel`**、不要写任何分格声明。',
    '- ★ **同一个人只写一次**：不许因为他挪了位置、换了姿势、从另一个角度看就再描述一遍 ——',
    '  同一件事写两遍，画面里就是两个人（实测最常见的「凭空多一个人」成因）。',
    '- 位置只用文字方位词交代：`at the far left edge` / `left of centre` / `right of centre` /',
    '  `behind them at the back left` / `in the middle distance`。',
    '  🚫 不写像素坐标、不写百分比。',
    '- 所有人物的位置合起来要能拼出一张合理构图：**有前有后、有左有右**，不要全挤在一行。',
    '',
    '## 二、这一张画什么',
    '',
    '### 2.1 一个时刻',
    '选正文里**一个明确时刻**，围绕一个主要视觉事件构图。',
    '- 有先后结果的连续动作 → 只画其中最能说明问题的那**一个**瞬间。',
    '- 🚫 同一张图不混入两个先后发生的时刻。',
    '',
    '### 2.2 不写景别、不写机位（取景交给动作）★★★',
    '- 🚫 **不写** `close-up` / `medium shot` / `full body` / `wide shot`，也不写',
    '  `from a low angle` / `from above` / `dutch angle`。',
    '- 「画多大范围」由**动作本身**表达：只有脸和手的动作 → 自然是近景；',
    '  承重面在地上、有全身接触 → 自然是全身。',
    '- 实测（v0.9.157，12 张对照）：景别 + 承重面 + 落脚点同时在场，模型会把人物纵向拉长去填框 ——',
    '  腿比躯干长两倍、躯干压扁，整幅影像「被强行压瘪」。删掉景别那一批没有这个现象。',
    '',
    '### 2.3 一个主动作 + 一个承重面（就这两项）★★★',
    '动作部分**只写两样**：一个主动作、一个承重面。',
    '',
    '- **主动作**：施动者 + 动词 + 接触位置（+ 对象）。**一句只写一个。**',
    '  ✅ `He presses her back against the sink rim, his left palm flat on the countertop.`',
    '- **承重面**：靠什么撑住身体 —— `kneeling on the duvet` / `sitting on the desk edge` / `back against the wall`。',
    '- **手：只写正在用的那只。**另一只手不写；🚫 也不要补「另一只手扶在墙上」给它找活干。',
    '',
    '🚫 **以下四项一律不写**（同一批对照定位，写了只会让画面更挤、人体被拉长）：',
    '  · **重心** `his weight shifted onto his back foot`',
    '  · **下肢落点** `one knee between her thighs` / `her front left foot`（承重面已表达）',
    '  · **空着那只手的位置** `her free hand braced on the tiles`',
    '  · **朝向** `his hips turned away` / `her shoulders angled toward him`',
    '',
    '- ★ 坐 / 跪 / 躺 / 靠 **必须写清压在哪件家具上**，否则模型会自己补一张桌子或一张床。',
    '- ★ 唯一例外：体位几何反直觉（腿架肩、头身倒置、倒吊、悬空托举）才补「头/脸朝哪 + 承重面」。',
    '',
    '### 2.4 环境',
    '- 同一空间的地标、开口方向、光源关系自洽；背景只写必要的环境锚点。',
    '',
    '### 2.5 连续状态不清零',
    '新动作**不会**自动清除之前已成立的状态：道具在谁手里、左手还是右手、衣物的位置、仍在持续的接触。',
    '🚫 不要把「被裁切」当成「东西消失了」或「动作重置了」。',
    '',
    '## 三、台词（有对白就必须写）',
    '- 形式固定：`A speech bubble beside her reads "原话"`。',
    '- **原话照抄正文**，一个字都不许删改译；中文写在引号里。',
    '- ★★★ **一句一个气泡，原话多长写多长**：太长就在停顿处**在同一对引号里直接换行**——',
    '  这是官方 USERGUIDE 给的手段原文：「To improve text accuracy or control line breaks precisely,',
    '  insert `\\n` or actual line breaks directly into the prompt.」，官方冰箱便签示例就是',
    '  引号内三行真换行。',
    '  🚫 **不要拆成两个气泡**（那会把一句话画成两个气泡，第二个常变成一块空白小卡片），',
    '  🚫 也不许为了「放得下」删字。',
    '- 正文这一楼没有对白 → 不要写气泡（别为了凑气泡编台词）。',
    '',
    '## 四、禁止项',
    '- 🚫 **质量词与写实词**：`masterpiece` / `best quality` / `8k` / `photorealistic` / 相机参数 ——',
    '  这些属用户画风主权，由全局前缀/后缀统一注入，模版里一个都不要写。',
    '- 🚫 **`@角色名`**：MOSS 不认记号，写引用会被剥掉且没有兜底。',
    '- 🚫 **中文画面描述**（台词除外）：中文只属于气泡里的原话。',
    '- 🚫 **不要在画面描写里重复人物的完整外貌与服装** —— 插件已经按档案注入，写两遍会让服装平均成模糊态。',
    '  涉及衣物的**动作**照写不误（抓住帽衫下摆 / 扯开领口 / 掀起裙摆）—— 那是动作，不是服装描述。',
    '',
  ].join('\n');
}

/**
 * 单图版（`output: 'json'`）的 §一 / §二。
 *
 * ★★★ 为什么单图要单独一份，而不是复用多格那份：
 *   多格 §一 通篇在讲「主格 / 分格 / 版面坐标」，§二 讲「每格一个时刻」。
 *   单图版里**一个格都不存在**，把这些原样发给模型，它会自己去分格 ——
 *   用户实测「单图模版直接复制多格的用，人物严重积压变形」就是这么来的。
 *
 * ★★★ 为什么**不写 bbox**：
 *   2026-10-29 真出图 36 张对照（`dev_tmp/single_multi/_eval.md`）：
 *   · 每人一个不同的 bbox → 6 人档 1/3 正确、8 人档 **0/3**，稳定多画一个人
 *     （多出来的都是「同一个角色被复制成两个并排的人」，因为每个框被当成一个独立实体槽）；
 *   · 每人一个**同一个满幅** bbox → 不再复制，但开始按槽位删人（一次 7 人、一次 5 人）；
 *   · **完全不写 bbox**（本模版）→ 6/6 全对，且「双马尾」这类细节保持率 6/6，
 *     比纯 prompt 的 3/9 高得多。
 *   ⇒ 框这个字段本身就是代价，给什么值都不划算。位置改用文字交代。
 */
function mossSingleJsonSpecSection12() {
  return [
    '# 单图规范（MOSS-Image · 单图 JSON 口径）',
    '',
    '> 一楼的正文只画**一张**图：一个场景、一个时刻、一整幅画面。',
    '> 输出承载是 MOSS 官方 JSON 结构（`summary` + `items`），但 **`items` 里不写任何坐标** ——',
    '> 位置只用文字交代，画面怎么排由出图端自己决定。',
    '',
    '## 一、单图怎么写',
    '',
    '### 1.1 形态',
    '- `canvas` 恒为 `"single"`。**全图只有一格**，不分格、不拼贴、不做同页多画面。',
    '- 整张图是**一个连续场景**：同一地点、同一光线、同一套衣服、同一时刻。',
    '',
    '### 1.2 items 怎么分项 ★★★',
    '- **画面上看得见的人，每人占一项**，`label` 一律 `"character"`。',
    '- ★★★ **同一个人只建一项**。不许因为他挪了位置、换了姿势、或从另一个角度看再建一项 ——',
    '  **多一项就等于画面里多一个人**。这是本机实测最常见的「凭空多一个人」成因。',
    '- ★ **一项只写这一个人**：别人的发色 / 衣服 / 身体部位不许混进来（那是串色的直接原因）。',
    '- **场景**（地点 / 时间 / 光线 / 天气 / 空间大小）写在 `summary.caption` 里，',
    '  🚫 **不要**在每个人物项的 caption 里重复场景词 —— 同一句话写 N 遍，模型会把它当成 N 个不同的东西。',
    '- 正文这一楼有对白 → 额外加 `text` 项，一句一项（见 §五）。',
    '',
    '### 1.3 人数只写一次 ★★★',
    '`summary.caption` 里必须有、且**只有**一句：',
    '`Exactly N people are visible in the frame and nobody else.`（N = `character` 项的个数，用英文数词）。',
    '',
    '- 🚫 **人物项的 caption 里不要再写人数**。全局一句就够；逐项复述会被理解成「这一项要再画 N 个人」',
    '  ——实测多格版「每格 object 写人数」搬到单图后，8 人档 3 张全部画成 9~11 人。',
    '- 三人以上同框时，`summary.caption` 再加一句构图收束：',
    '  `The frame closes tightly around these N people.`',
    '- 同框两人的**上衣主色或款式必须不同**，并在各自 caption 里点明差异',
    '  （实测：两个都穿白上衣的女学生，服装 6 张全部串了）。',
    '',
    '### 1.4 位置只用文字 ★',
    '- 用「画面哪一块」的说法：`at the far left edge` / `left of centre` / `right of centre` /',
    '  `on the right, half sitting on a chair` / `behind them at the back left` / `in the middle distance`。',
    '- 所有人的位置合起来要能拼出一张合理构图：**有前有后、有左有右**，',
    '  🚫 不要全挤在同一行、也不要人人都「站在中间」。',
    '- ★★ **每人只留一个方位词**（v0.9.157）：`on the left` 或 `on the right` 就够，',
    '  不要「左后方靠窗的角落里、半靠在桌沿上」这样叠三个方位。',
    '  方位词多一个 = 多一个必须摆准的点；只有**需要分左右**时才写，单人画面干脆不写。',
    '- 🚫 **不写像素坐标、不写百分比、不写 `[x0, y0, x1, y1]`**，也不写 `bbox_coord_space` / `bbox_format`。',
    '',
    '## 二、这一张画什么',
    '',
    '### 2.1 一个时刻',
    '选正文里**一个明确时刻**，围绕**一个主要视觉事件**构图。',
    '- 有先后结果的连续动作 → 只画其中最能说明问题的那一瞬间，其余用状态带过。',
    '- 🚫 同一张图里不混入两个先后发生的时刻（画出来就是两个人各做各的）。',
    '',
    /**
     * ★★★ v0.9.157：景别条款**反转**（原来是「必须写一个景别」）。
     *
     * 依据（2026-10-29，12 张真出图单变量对照，`dev_tmp/shot_frame/`）：
     *   同一段缠斗文本，每次只改一个变量各出 2 张 ——
     *     V1 删「重心在前脚 / 后脚踩实」 → 照样腿超长；
     *     V2 `Medium shot` 改 `Full shot`  → 照样；
     *     V3 `low angle` 改 `eye level`    → 照样；
     *     V4 只留单人（排除双人同框）      → 照样；
     *     V5 caption 砍到「身份+服装+一只手扶桌」→ **比例恢复正常**。
     *   ⇒ 主因是「必须可见的点」太多；景别词是帮凶：写了 `medium shot` 又不许删动作，
     *     模型只能把人体纵向拉长去填框。与本插件 v5→v6 迁移的旧定案一致
     *     （下方 K2 段：「写景别经常和动作描述打架，最优解是不设景别」）。
     */
    '### 2.2 不写景别、不写机位（取景交给动作）★★★',
    '- 🚫 `summary.caption` 里**不写景别**：`close-up` / `medium shot` / `full body` / `wide shot` 一个都不要。',
    '- 🚫 也**不写机位与仰俯**：`from a low angle` / `from above` / `dutch angle` / `wide lens` 都不要。',
    '- 「这一张画多大范围」由**动作本身**表达：只有脸和手的动作 → 自然是近景；',
    '  承重面在地上、有全身接触 → 自然是全身。你**不需要、也不许**再补一句景别或机位。',
    '- 实测代价：景别 + 承重面 + 落脚点三样同时在场，模型会把人物纵向拉长去填框 ——',
    '  腿比躯干长两倍、躯干被压扁，整幅影像「被强行压瘪」。删掉景别那一批没有这个现象。',
    '',
    /**
     * ★★★ v0.9.157：互动条款从「六项全写」压缩到「一个主动作 + 一个承重面」。
     *
     * 依据同上（V4 vs V5）：`V4` 删掉女主那一项后，男主那句「右手扣住她挥来的手腕」
     * 仍被逐条执行 → 对着空气握手。说明 caption 是**逐条点位指令**：每条都完成，
     * 合起来不成一个动作，看着就是「动作很抽象」。
     * ⇒ 只留两项，其余四项一律删 —— 它们每一条都是一个新增的「必须可见点」。
     */
    '### 2.3 一个主动作 + 一个承重面（就这两项）★★★',
    '每个 character 项的动作部分**只写两样**：一个主动作、一个承重面。',
    '',
    '- **主动作**：施动者 + 动词 + 接触位置（+ 对象）。**一项只写一个。**',
    '  ✅ `He presses her back against the sink rim, his left palm flat on the countertop.`',
    '- **承重面**：靠什么撑住身体，一个短语就够 —— `kneeling on the duvet` / `sitting on the desk edge` /',
    '  `back against the wall`。',
    '- **手：只写正在用的那只。**另一只手不写 —— 不写 = 交给模型自然垂放；',
    '  🚫 也不许再补「另一只手扶在墙上」去给它找活干。',
    '',
    '🚫 **以下四项一律不写**（同一批 12 张对照定位，写了只会让画面更挤、人体被拉长）：',
    '  · **重心** —— `his weight shifted onto his back foot`',
    '  · **下肢落点** —— `one knee between her thighs` / `her front left foot`（承重面已经表达了这件事）',
    '  · **空着那只手的位置** —— `her free hand braced on the tiles`',
    '  · **朝向** —— `his hips turned away from the punch` / `her shoulders angled toward him`',
    '',
    '- ★ **坐 / 跪 / 躺 / 靠必须写清压在哪件家具上**（`on the edge of the desk` / `on the floor between the chairs`）——',
    '  🚫 只写动作不写承重面，模型会自己补一张桌子或一张床，画面就变成另一个场景了。',
    '- ★ **唯一例外**：体位几何反直觉（腿架肩、头身倒置、倒吊、悬空托举）时，',
    '  才补一句「头/脸朝哪 + 承重面」；其余任何情况都不写朝向。',
    '',
    '### 2.4 环境建立',
    '- 同一空间的地标、开口方向、光源关系必须自洽；背景只写**必要的环境锚点**，',
    '  🚫 不要在一个人的 caption 里复制整段背景（那是给这一项额外加权）。',
    '',
    '### 2.5 连续状态不清零 ★★',
    '新动作**不会**自动清除之前已成立的状态：重要道具在谁手里、左手还是右手、是否打开 / 损坏、',
    '衣物或遮盖物现在的位置、人物之间仍在持续的接触。',
    '- 🚫 不要把「被裁切」当成「东西消失了」或「动作重置了」。',
    '',
  ].join('\n');
}

/**
 * JSON 版的 §一 / §1.1 / §二。
 *
 * 与纯 prompt 版**逐条对照写**，因为两版在这三节上结论正好相反：
 *   纯 prompt：人物段由插件注入 → 格内不写外貌 → 写两遍会被平均成模糊态
 *   Layout   ：每个角色一个 character 项 → caption 必须写全外貌 → 重述身份是官方要求
 * 写错一边，用户就会看到「Layout 版里的人像纯 prompt 版一样没脸」。
 */
function mossJsonSpecSection12() {
  return [
    '# 多格漫画规范（MOSS-Image · JSON Layout 口径）',
    '',
    '> 判据来自多格漫画的专业分镜规范：页面主格 / 景别拉开 / 单格时刻 / 互动四要素 /',
    '> 脱卸边界 / 成人六项。**单图那套写法（tag 串、一整段自然语、把人物描写堆满）在这里不适用**。',
    '> 输出承载仍是 MOSS 官方 JSON Layout（见输出协议）：分镜规范决定**画什么**，协议决定**怎么写下来**。',
    '',
    '## 一、页面规划：先定主格，再分格',
    '',
    '### 1.1 页面形态',
    '| 正文情况 | canvas |',
    '|---|---|',
    '| 一段连续对手戏，有时间推进（对视 → 靠近 → 接触） | `multi_panel` |',
    '| 只有一个决定性瞬间值得展开 | `single` |',
    '',
    '- 每楼默认 **1 张**。只有正文里真的出现「几个连续瞬间」时才拆格，不要为了多画而拆。',
    '- 拆格时**所有格属于同一场景**：同一地点、同一光线、同一套衣服。',
    '',
    '### 1.2 主格与画格主次 ★★★',
    '',
    '**每页必须有一个主格**（面积最大、承载戏剧重心），其余格按信息量分配大小。',
    '**每个格子的大小必须不同** —— 等分网格是错的，等分出来的三格会像三张一样的证件照。',
    '',
    '- 主格放：主战况 / 体位全貌 / 肢体纠缠（成人场景）；放不下就退半步写中景。',
    '- 辅助格放：局部切入（手 / 眼 / 接触点）、反应、环境建立。',
    '- **主格不必是阅读顺序的第一格**。',
    '',
    '### 1.3 位置称呼要能区分',
    '给每格一个本页内可区分的称呼：`right upper small panel` / `tall vertical panel on the left` /',
    '`full-width main panel at the bottom`。称呼写进该格 object 的 caption，',
    '**同一格在全页用同一个说法**（换说法 = 模型当成两个格）。',
    '',
    '### 1.4 版面坐标：照抄，不要自己分 ★★★',
    '这一版用哪种版式、每格的像素框，**提示词末尾「本次出图的形态与画布」那节已经按本次画布算好了** ——',
    '直接照抄那几行 `Panel N: [y0, x0, y1, x1]`。',
    '',
    '- 🚫 不要套用任何固定模板（三条等高横条 / 均分 2×2 都不行）。',
    '- **各格面积本来就不相等**（上小下大 / 左窄右宽 / 细条 + 大格都正常），照抄即可。',
    '- 末尾那节与本节任何比例描述冲突时，**以末尾那节为准**。',
    '- 格与格之间留 8~16px 白边（gutters），不要让两个 object 的框完全相接。',
    '- 角色框放进它所在那格，四周留 20~40px 余量；**人物不要顶到格边**（会被裁）。',
    '- 每格高度不低于整页的 **1/4**，太窄人物会被压成剪影。**四格以上建议压回 3 格**。',
    '',
    '## 二、每格写什么：一个格子一个时刻',
    '',
    '### 2.1 单格时刻',
    '每格选**一个明确时刻**、围绕**一个主要视觉事件**构图。',
    '- 有先后结果的连续动作 → 分到不同格；可以同时成立的姿态 / 持物 / 视线 → 同一格的状态。',
    '- 🚫 **同一格不混入两个先后发生的时刻**。',
    '',
    '### 2.2 景别与机位',
    '- 远景交代空间、中景呈现互动、近景突出细节。**一页内景别必须拉开**',
    '  （中景 → 极特写 → 双人全景）；三格全是中景 = 三张几乎一样的图。',
    '- 每格只写辨认本镜头所需的景别 / 角度 / 位置，**不为凑术语堆放同义机位**。',
    '- 仰俯、短缩、广角可以写，但**人物比例与接触关系必须保持可辨**。',
    '',
    '### 2.3 互动四要素（每格每个动作都要齐）★★★',
    '',
    '人物互动必须明确：**施动者 / 交互对象 / 接触位置 / 相对方位**。',
    '承重动作还要交代**支撑**。缺任何一项，模型就自由补 —— 补出来就是断肢、穿模、悬空、多一条手臂。',
    '',
    '示范（一句里齐四要素）：',
    '`He presses her back against the sink rim, his weight on his left palm flat on the counter,',
    'his right hand at her hip, one knee between her thighs, entering her from behind.`',
    '',
    '- **手**：只写正在用的那只，但两只手都要有位置（空着的那只写 `braced on the tiles`）。',
    '- **承重面**：臀部 / 膝 / 背 / 肩靠在哪里。',
    '- **下肢落点**：站在地上 / 跪在腿间 / 一腿缠在腰上 / 脚尖点地。',
    '',
    '### 2.4 环境建立',
    '- 转场或时间变化 → 安排一格交代空间（可独立成格，也可放在能看清站位的画面里）。',
    '- 同一空间的**地标、开口方向、光源关系保持一致**；各格只写本镜头必要的环境锚点，',
    '  **不在每个人物项里复制整段背景**。',
    '',
    '### 2.5 连续状态不清零 ★★',
    '新动作**不会**自动清除之前已成立的状态。逐格追踪：重要道具在谁手里、左手还是右手、',
    '是否打开 / 损坏、衣物或遮盖物的位置、人物之间仍在持续的接触。',
    '',
    '- 镜头切到局部时，**只在提示词里写当前实际可见的部分**（画外的事实留着，重新入镜时恢复）。',
    '- 🚫 **不要把「被裁切」当成「东西消失了」或「动作重置了」**。',
    '- 手中无物时只写当前可见的空手状态，不罗列一串不在画面的物件。',
    '',
  ].join('\n');
}

/**
 * JSON 版的 §三（画面写法）。
 *
 * 保留纯 prompt 版的判据（形态判断 / 台词不删字 / 禁止项 / 篇幅），
 * 但 3.2「Panel N, 方位词」与 3.3「气泡 reads "…"」必须换成坐标与 text 项 ——
 * 否则模型会一边写 JSON 一边把 Panel 文本也塞进去，两头都不对。
 */
/**
 * @param {boolean} single 单图口径（`output: 'json'`）。
 *   §三~§八 绝大多数条目对单图、多格是同一套判据（DNA / 服装 / 台词 / 禁止项 / 自检），
 *   只有 **3.4 跨格建项** 与 **3.5 人数写在哪** 这两条方向相反 —— 单图里「再建一项」等于复制一个人，
 *   「每格写人数」等于把人数写 N 遍。所以只把这两节参数化，其余原样共用一份源，
 *   避免复制 200 行文本后两边各自漂移。
 */
function mossJsonSpecSection3(single = false) {
  return [
    '## 三、角色：DNA、出场与外观',
    '',
    '### 3.1 角色 DNA（走 `changes` 维护）',
    '每个实际出场的人物（含路人）都要有稳定记录：**姓名 / 外貌 DNA / 穿搭 DNA / 差异化特征**。',
    '',
    '- 外貌 DNA：发长、发型结构、发色、眼、体态、固定配饰（一律英文视觉词）。',
    '- 穿搭 DNA：开场服装款式、材质、配饰。',
    '- ★ **差异化特征**：从稳定可见的特征里挑出**足以和本页其他人区分**的那几项',
    '  （发型结构 / 眼睛 / 体态 / 独有衣物 / 配饰）—— 这是防串色的唯一依据。',
    '- 发型 / 发色 / 卷度 / 扎法 / 刘海 / 妆面是**人设，不得改动**；',
    '  只有 `hairState` / `makeupSmudge` 能随剧情变。',
    '- 档案库里 `[locked]` 的条目属于用户主权区，**永远不要为它产生 change**，画面里照抄原值。',
    '',
    '### 3.2 外观变化',
    '发型 / 发饰 / 服装 / 破损 / 配饰发生剧情变化时，记下**从哪一格起生效**，之后沿用；',
    '其余时候沿用外貌 DNA 与已生效的变化。**跨页、换镜头不构成外观变化**。',
    '',
    '### 3.3 每次可见出场：写本镜头看得到的，画外不等于消失 ★★★',
    '',
    '每格每位可见人物一个 `character` 项，caption 写：',
    '**身份锚点（发色 + 一件最能区分他的东西，5~8 词）+ 本镜头可见的衣着 + 动作 + 景别 + 表情**。',
    '',
    '| 这一格拍到 | 写什么 |',
    '|---|---|',
    '| 头部 / 特写 | 发长、发型、发色、瞳色、识别配饰（眼镜 / 发饰 / 疤） |',
    '| 上半身 / 中景 | 以上 + 实际可见的衣着 |',
    '| 全身 | 以上 + 体型、鞋袜 |',
    '| 局部（手 / 胯 / 颈 / 衣角） | 只有那处可见的东西 —— **不要在这一项里写脸和身体**（官方 §13.1：会被理解成两个人） |',
    '',
    '- ❌ **全身档案照写法**（塞进中景格会挤出动作，画面只剩一张证件照）：',
    '  `The tall woman with long straight black hair, blue eyes, fair skin and large breasts,',
    '  wearing a white blouse with a navy sailor collar and a dark pleated skirt. She stands by the window.`',
    '- ✅ **锚点 + 可见衣着 + 动作**：',
    '  `The black-haired woman in the white sailor blouse stands by the window, her knuckles',
    '  pale, looking down at a document.`',
    '- ★★ **区分两件事**：**外貌**（发色 / 瞳色 / 脸型 / 体型）整页只写一次，重复写会吃掉额度、',
    '  还会被画成两个身体；**衣着**相反 —— **每一格都要独立写这一格看得见的完整衣着词**（见 §4.3），',
    '  不许写「同上」、也不许因为上一格写过就省掉。',
    '- ★ **画外不等于消失**：这一格是特写，没写裙子不等于她没穿裙子；',
    '  下一格重新入镜（全身 / 中景）时，**必须照穿搭 DNA 把那些衣服原样写回来**（见 §4.2）。',
    '- ★ 格内出现的**每个人**都要有独立的一项，不许用 `the girl` / `she` 指代了事。',
    '- ★ 一项里**只写这一个人**：不许把别人的衣服 / 发色写进来（那是串色的直接原因）。',
    '',
    ...(single
      ? [
        '### 3.4 同一个人只建一项 ★★★',
        '单图没有第二格 —— **同一个人在这张图里永远只对应一个 `character` 项**。',
        '',
        '- 他挪了位置、换了姿势、从另一个角度被看到：都还是同一个项，**不新建**。',
        '  多建一项 = 画面里凭空多一个人（本机实测最常见的超员成因）。',
        '- 一项里**只写这一个人**：别人的发色 / 衣服 / 身体部位不许混进来（串色的直接原因）。',
        '',
        '### 3.5 人数与串色防护（本机实测）★★★',
        '- **人数只写在 `summary.caption` 一次**：`Exactly N people are visible in the frame and nobody else.`',
        '  （N = `character` 项的个数）。',
        '  🚫 **人物项的 caption 里不要再写人数** —— 逐项复述会变成「这一项要再画 N 个人」，',
        '  实测 8 人档 3 张全部画成 9~11 人。',
        '- ★ **三人以上同框**：`summary.caption` 再加一句 `The frame closes tightly around these N people.`',
        '  （实测：三人的画面 8 张里 3 张多画了路人，加这句后 3 张全对；只对 3~6 人有效。）',
        '- ★ **同框两人的上衣主色或款式必须不同**，并在各自 caption 里点明差异。',
        '  （实测：两个都穿白上衣的女学生，服装 6 张全部串了。）',
        '- ★ **位置要拉开**：不要人人都「站在中间」，用 §1.4 的方位词把前后左右分配开 ——',
        '  全挤在一处时模型会开始互相挤，画出来就是肢体粘连。',
      ]
      : [
        '### 3.4 同一角色跨格 → 必须建项 + 重述锚点 ★★★',
        '官方 §13.4：「某一角色在两格各出现一次时，**重述同一身份特征**并说明重复出场」。',
        '',
        '- **必须再建一项** —— 不建项就等于这一格没有他（**跨格延续不会自动发生**）。',
        '- 重述的是**可见的身份锚点**，不是完整外貌；点明是同一个人：',
        '  `The black-haired woman, now at the door, …`。',
        '',
        '### 3.5 人数与串色防护（本机实测）★★★',
        '- **每格 object 的 caption 必须写人数**：按这一格**真实出场**的人数写 ——',
        '  `exactly one person in this panel` / `exactly two people in this panel` / `exactly three people…`；',
        '  这一格没有人物（纯背景/空镜）就写 `no people in this panel`。',
        '  不写 = 模型按「至少两人」理解 = 多画出一个人；**写死「两人」= 空背景格也会被塞进两个人**',
        '  （实测 2026-10-22 楼 176：两个背景格都写着 exactly two people）。',
        '- ★ **三人以上同框**：object 里再加一句构图收束 ——',
        '  `the frame holds exactly three people and closes tightly around them`。',
        '  （实测：三人的格子 8 张里 3 张多画了上一格的角色，加这句后 3 张全对；只对 3~6 人有效。）',
        '- ★ **同框两人的上衣主色或款式必须不同**，并在 caption 里点明差异。',
        '  （实测：两个都穿白上衣的女学生，服装 6 张全部串了。）',
        '- ★ 上一格出现过的角色这一格还要出现 → **必须再写一个 character 项**。',
        '  （实测 8 人档 6 张里 5 张漏的正是这一个：模型认为「这张脸刚画过」就省掉了。）',
      ]),
    '',
    '## 四、服装与脱卸边界',
    '',
    '### 4.1 穿搭 DNA：开场建档，之后只记变化 ★★★',
    '档案行里的 `服装=` 就是这位角色的**穿搭 DNA**（款式 / 材质 / 颜色 / 配饰）。',
    '它是**给定值**，不是参考建议 —— 这一页画的就是这一套。',
    '- **整页第一次出场时把 DNA 写完整**，完整到别人能照着复现同一套衣服：',
    '  `her pink and white maid outfit, the pink ribbon apron with loose untied back ties,',
    '  white lace-trimmed thigh-high stockings`。',
    '- 此后**不再重复完整 DNA**，只写这一格的变化（见 §4.2）。',
    '- 🚫 **不许换品类、不许改颜色、不许把整体名拆成你想当然的单品**：',
    '  实测（2026-10-22 楼 202）：档案是上面那套 maid outfit，模型写成',
    '  `white apron … a white lace-trimmed blouse bunched at her collarbone` ——',
    '  粉色没了、`maid outfit` 变成 `blouse`、长袜只剩一格，女主等于换了个人。',
    '  ⇒ 主品类词和颜色必须在。带一件具体单品来解释是允许的',
    '  （`her pink and white maid outfit, the ribbon apron pushed up over her chest`），',
    '  但**不能用单品替换整体**。',
    '- 档案 `服装=(未记录)` 时才从正文取；正文也没写，就写一套中性衣服，',
    '  并在 `changes` 里建档，让下一楼能延续。',
    '',
    '### 4.2 外观变化：只认「从哪一格起变成了什么」',
    '变化按 **`角色｜生效页格｜变化结果`** 记录（写进 `changes`）。',
    '- ◆ **跨格、换镜头不构成外观变化**（NAI 原文：跨页、换镜头不构成外观变化）。',
    '  没写变化，就必须沿用 DNA —— 不许因为这一格「看不到」就当它换了、脱了、没了。',
    '- 换了衣服要写 `now wearing …`（**替换**，不是叠加）。',
    '- 换衣服只能来自正文或 `changes`，**你自己不许换**。',
    '',
    '### 4.3 每一格都要独立写完整衣着词 ★★★',
    '**每格每个可见人物，都写这一格看得见的完整衣着词** —— 把穿搭 DNA（或已生效变化）里',
    '本格能看见的部分**重新写一遍**，不要指望读者记得上一格。',
    '- 🚫 **禁止「同上」「同前格」「as before」「same outfit」**，也禁止只写姓名/编号就算交代了穿着。',
    '  （NAI 原文：同一角色跨格分别写当前镜头可见的完整词，禁止以编号、姓名、「同上」或上一格代替。）',
    '- **局部镜头只写实际可见、且与身份连续有关的部位**（特写脸就不写鞋袜）。',
    '- ◆ **画外不等于消失**（NAI 原文：不把裁切当作物品消失）：中景没写裙子和鞋，',
    '  不代表她没穿；**重新入镜的全身格必须原样写回来**，不许到时候忘掉或换掉。',
    '- **不同格的服装状态可以不一致**（每格是独立区域）：格 1 裙子整齐、格 3 裙摆被掀起，不冲突。',
    '',
    '### 4.4 已全部褪下的角色：反向规则（一个衣物名词都不许写）★★★',
    '**只对档案行写着 `服装状态=褪下(removed)` 的角色生效。**',
    '`完好(intact)` / `半褪(parted)` / `已解开(undone)` 的角色**不适用本节**，按 §4.1~§4.3 写。',
    '（这两节方向完全相反 —— 别把 §4.3 的「必须写衣着」套到全裸角色上，',
    '也别把本节的「不许写衣物」套到还穿着衣服的角色上。）',
    '- 这一页**不许出现任何衣物名词**：连 `hanging open` / `pulled aside` / `around the waist`',
    '  都不行（那仍然是一件衣服在画面上）。',
    '- 改写成裸露状态：`completely nude` / `bare-chested` / `bared pelvis`，再加体液、痕迹、体温、呼吸。',
    '- **「每格必须有衣着」不适用于这一类角色** —— 已褪下就是没有衣着，强行补一件＝凭空造衣服。',
    '',
    '### 4.5 衣着变化用部位词挂在动作上',
    '| ❌ 别写 | ✅ 这样写 |',
    '|---|---|',
    '| `the sleeve is rolled up` | `she reaches up, her sleeve sliding back` |',
    '| `the collar is loosened` | `her raised arm pulls the collar slightly open` |',
    '| `the hem is raised` | `the wind lifts the hem` |',
    '',
    '可用部位词：`collar` / `hem` / `sleeve` / `cuff` / `waistband` / `lapel` / `the fabric`。',
    '',
    '### 4.6 脱卸边界与状态位 ★★★',
    '每件**离开原位**的衣服都要写清三件事：**还穿在谁身上 / 褪到哪一截 / 还挡住什么**。',
    '- ✅ `her white blouse pushed up above her chest and bunched at her collarbone`',
    '- ✅ `navy skirt and panties pulled down to mid-thigh, one leg still in them`',
    '- 🚫 `naked` / `topless` / `no bra` / `naked from the waist down` **单独出现**（身上还有衣服时）——',
    '  这些是**区域词**，不是边界，必须配上「还剩什么在身上」。',
    '  ★ 但**已全部褪下**的角色例外（见 §4.4）：`completely nude` 就是他的完整状态，',
    '  此时必须这么写，**不许**为了凑一个「边界」给他补一件敞着的衣服。',
    '- 🚫 **下衣还在腰上就写插入**：台本没写隔着衣服，就必须先写清褪到哪一截。',
    '- ★★ **穿着状态只由 `outfit` / `outfitState` 表达**：姿态字段（`condition` / 状态）里',
    '  **不许出现衣物名词**（`through open trousers` / `shirt open` / `skirt lifted` 都算）。',
    '  实测（2026-10-22 楼 190）：档案已经是 `removed` + `completely nude`，但 `condition`',
    '  里残留「erect penis exposed through open trousers」→ 图里凭空长出一条裤子。',
    '  ⚠ 这条**只管姿态字段**（写进档案 `状态=` / `condition` 的那一句），**不是**让你在',
    '  character caption 里少写衣服 —— caption 里的服装照 §4.1~§4.3 写。',
    '- 状态位推进走 `changes`：',
    '  `{"name":"角色名","kind":"set","fields":{"outfit":"...","outfitState":"parted"}}`；',
    '  只能前进 intact → parted → undone → removed，重新穿好写 `redress:true`。',
    '- **档案里没有的临时角色**（巡查员 / 店员 / 路人）：caption 也要写锚点 + 可见外貌 + 服装，',
    '  并在 `changes` 里给他建档，这样下一楼再出现时能延续。',
    '',
    '## 五、台词 = text 项（MOSS 的核心能力，必须用满）★★★',
    '',
    'MOSS 最强的能力就是**文字渲染**（官方 USERGUIDE：「图里要出现的字保留原文」）。',
    '**正文里说出口的话，必须原样出现在画面上。**',
    '',
    '**动手前先做一件事：把正文里带引号的对白逐条摘出来，数一数有几条。一条都不能少。**',
    '',
    '- 写成 `{"label":"text","caption":"气泡外观","text":"原话","bbox":[...]}`。',
    '- ★ `caption` 只描述**气泡长什么样、在哪**（`Vertical oval speech bubble beside her head,',
    '  white fill with a thin black outline.`）；**原话写在 `text` 字段里**，不要写进 caption',
    '  （官方 §13.3：不能只说「这里有个标题」让模型自己编文案）。',
    '- **原话多长就写多长 —— 一个字都不许删、不许截断、不许改写、不许译成英文、不许用拼音。**',
    '  删掉半句 = 改了她的台词，读者一眼就能发现。',
    '- ★★ **太长就拆格，不要删字**：一句超过一个气泡容量时按句读拆成两句、分到相邻两格；',
    '  格子不够 → 放进这一楼的另一张图；这一楼装不下 → 留到后面的楼层。**凡是画到的句子，必须完整**。',
    '  > 官方二次元模板 §13.3：「字数多时增加画布 / 字区、减少装饰或**拆图**，**不擅自删掉用户要求的字**。」',
    '- **一格一个气泡**（两句对白就拆两格）。没人说话的格**不放 text 项**。',
    '- 🚫 **禁止空 text**：`"text": ""` / `"text": " "` 一律不许（没台词就别建 text 项）。',
    '- 旁白（时间 / 地点 / 心理）也可以用 text 项：`"text": "23:47　雨"`，',
    '  caption 写 `A rectangular narration box at the top left, white fill with a thin black border.`',
    '- 气泡框放在**说话人头部附近**，**不要跨格**。',
    '',
    '## 六、禁止项（Layout 口径）',
    '- ★ **中文只能出现在 `text` 字段里**（台词 / 旁白）：caption 里的裸中文会被画成画面上的字。',
    '  画面描述、档案字段一律英文。',
    '- **禁止质量词 / 写实词**：`masterpiece` `best quality` `highres` `8k` `ultra detailed`',
    '  `photorealistic` `film grain` `raw photo` —— 这类词强指向「单张高质量插画」，',
    '  会把分好的格子又压回一张图。画风词只在 `summary.caption` **第一句**写一次。',
    '- **禁止否定表述**：不写 `no hat`，直接不提帽子（提什么画什么）。',
    '  想表达「只有这些人」→ 用正面句 `the frame holds exactly three people`。',
    '- **禁止非官方字段**：`panels` / `panel_id` / `children` / `parent` / `style` / `id` /',
    '  `elements` / `negative_prompt` / 采样参数（官方 §12.2 / §12.3）。items 永远是**扁平数组**。',
    '- **禁止把坐标写进 caption**：`bbox` 是字段，不是画面内容（官方坑表：「把 bbox 字样写成屏幕上的字」）。',
    '- **禁止跨图引用**：「承接上一张」「与上张一致」都不许写 —— 每张图独立生成。',
    '- **禁止画外内容**：谁在按快门、机位架在哪、看不见的心理因果，一律不写。',
    '- **禁止 `@角色名`**，也不许用编号 / 代号代替人物。',
    '',
    '## 七、篇幅与优先级',
    '- character caption = **身份锚点 + 可见衣着 + 这一刻的动作**。常规 **50~110 词**；',
    '  成人场景按「成人画面」那节给的额度（**85~130 词**），那一节优先。',
    '- object caption：**15~30 词**（场景 + 景别 + 光线 + 人数）。',
    '- 全页 items 总数：三格约 **8~12 项**，四格约 **10~16 项**。',
    '- ★ **宁可少写一格，也不要把同一件事写两遍**（同一动作 / 同一件衣服写两遍 = 画两份）。',
    '- ★★ 反过来：**不要为了压词数删掉承重面 / 两手位置 / 衣物边界 / 贴合方向** ——',
    '  这几项删掉画面就崩（断肢、穿模、悬空、凭空多出衣服）。先砍景别形容词与氛围词。',
    '',
    '## 八、输出前自检（逐条过，不合格就改）',
    '',
    '1. **格数对得上吗**：`summary.caption` 里说的格数 = 实际 `object` 项数？',
    '   （说 three panels 却只有两个 object = 模型会自己均分版面。）',
    '2. **每格大小不同吗**：有没有变成等分网格？主格是不是最大的那个？',
    '3. **每格有人数声明吗**：`exactly N people in this panel`。',
    '4. **每个 character 是独立项吗**：有没有用 `the girl` / `she` 指代了一个本该建项的人？',
    '5. **跨格出现的同一个人**：这一格建项了吗？只重述锚点、没重抄完整外貌吧？',
    '6. **动作齐四要素吗**：施动者 / 对象 / 接触位置 / 相对方位 / 支撑。',
    '7. **台词全吗**：正文里带引号的句子，是不是每句都进了 `text` 且一字未改？',
    '8. **中文有没有跑到 caption 里**？',
    '9. **状态连贯吗**：上一格持有的东西、持续的接触、衣物的位置在这一格还成立吗？',
    '',
    '> 3~6 是最容易漏的四条，漏了直接就是断肢、穿模与「多画一个人」。',
  ].join('\n');
}

/**
 * 单图版的 system 补充。
 *
 * ★ 多格那份第一句就是「先分镜、再落坐标」，单图照抄会直接把模型推去分格 ——
 *   用户实测「单图模版复制多格来用，人物严重积压变形」，这里是源头之一。
 */
function mossSingleJsonSystemAddon() {
  return [
    '',
    '**本模版是「MOSS-Image 口径 · 单图 JSON」**：一楼的正文只画**一张**图，没有分格、没有坐标。',
    '你的工作顺序是：定这一张的**时刻** → 逐人写「他是谁、穿什么、此刻在做什么、在画面哪一块」。',
    '🚫 **不写景别、不写机位**（`medium shot` / `from a low angle` 都不要）—— 取景由动作自己决定。',
    '输出不是一段提示词，而是一份 **JSON**（`summary` + `items`）—— 这是官方支持的输入格式之一。',
    '',
    '- **必须输出 `cast` 点名**：插件靠它核对这张图里本该有谁。',
    '  · 档案里**已有**的角色 → 只写 `name`（名字逐字照抄档案库）。',
    '  · 档案里**没有**的人（路人 / 店员 / 巡查员）→ 写 `name` + `look`（一行英文外貌速写）。',
    '  反过来也成立：**这张图里不出现的人，不要写进 `cast`**（写了等于告诉模型他要出场）。',
    '- **人物外貌与服装这次要你写**（纯 prompt 版是插件注入，别混用）：',
    '  每个 `character` 项写全这个人看得见的外貌、每一件衣服、以及**一个主动作 + 一个承重面**。',
    '- ★ **MOSS 原生支持中文，不要套用单图口径的「禁中文」规则**：',
    '  画面描写用英文（控得准、可复现），**说出口的话必须用中文原话**写进 `text` 项。',
    '  不要输出 `scene` / `nl` / `mood` —— 这几个字段会被整段丢弃。',
    '- **不写 `@角色名`**：MOSS 不认记号，写引用会被剥掉且没有兜底。',
    '- **禁止质量词与写实词**（理由与清单见规范 §六）。',
    '- `layout` 是一个**嵌套对象**（不要塞成字符串），格式见输出协议。',
    '- 🚫 **不写任何坐标**：`bbox` / `width` / `height` / 数字框一律不出现。位置只用文字方位词。',
  ].join('\n');
}

export const MOSS_JSON_SYSTEM_ADDON = mossJsonSystemAddon();
export const MOSS_JSON_PROTOCOL_ADDON = mossJsonProtocolAddon();
export const MOSS_SINGLE_JSON_SYSTEM_ADDON = mossSingleJsonSystemAddon();
export const MOSS_SINGLE_JSON_PROTOCOL_ADDON = mossSingleJsonProtocolAddon();

/**
 * MOSS JSON Layout 出厂模版。
 *
 * ★ 与 `defaultMossTemplate()` 的关系：engine 同为 'moss'（同一套清洗口径、同一套组装分支），
 *   唯一的区别是 `output: 'layout'` —— 组装层靠它走「不碰任何文本清洗 + 坐标编译」的独立出口。
 *   variant 仍是 'en'（单串整段），因为最终送进模型的确实是一整串（就是那行 JSON）。
 */
export function defaultMossJsonTemplate(name = 'MOSS(多格漫画)_JSON版') {
  return {
    name,
    engine: 'moss',
    variant: 'en',
    output: 'layout',
    system: DEFAULT_SYSTEM + MOSS_JSON_SYSTEM_ADDON,
    spec: mossJsonSpecSection12() + mossJsonSpecSection3(),
    protocol: MOSS_BASE_PROTOCOL + MOSS_JSON_PROTOCOL_ADDON,
    jailbreak: DEFAULT_JAILBREAK,
  };
}

/**
 * MOSS 单图 JSON 出厂模版（`output: 'json'`）。
 *
 * ★ 与 Layout 版的区别只有两点：
 *   ① spec / 协议里**一个坐标都不写**（依据 `dev_tmp/single_multi/_eval.md` 的 36 张真出图对照）；
 *   ② `output` 是 `'json'` 而不是 `'layout'` —— 组装层因此**不跑坐标编译**，
 *      直接把这份 JSON 原样交给 MOSS（实验里最好的形态就是这个）。
 */
export function defaultMossSingleJsonTemplate(name = 'MOSS(单图)_JSON版') {
  return {
    name,
    engine: 'moss',
    variant: 'en',
    output: 'json',
    system: DEFAULT_SYSTEM + MOSS_SINGLE_JSON_SYSTEM_ADDON,
    spec: mossSingleJsonSpecSection12() + mossSingleJsonSpecSection3(),
    protocol: MOSS_BASE_PROTOCOL + MOSS_SINGLE_JSON_PROTOCOL_ADDON,
    jailbreak: DEFAULT_JAILBREAK,
  };
}


/* ============================================================================
 * v0.9.186：漫画台原生口径（照搬 AINIMA 漫画台）
 *
 * 用户 2026-11-01：「这 2 个模版采用原生 AINIMA 漫画台的模版方式出图，先不改他的
 * 提示词手法，我需要原汁原味，就和我单独使用漫画台时出图质量一样，相当于照搬迁移
 * 到绘灵，因为我发现他真的很稳。」
 *
 * ⇒ 下面这份 spec 的每一句都是 **AINIMA 漫画台 references/ 里的话**（FORMAT.md /
 *   TECHNIQUES.md §3 / R18-MANGA.md §8-§10），措辞尽量原样保留。**不要在这里
 *   加绘灵自己的发明** —— 加了就不是"原汁原味"，也失去了「和漫画台一样稳」的前提。
 *   编译侧同样逐字移植（`modules/mossMangaNative.js`，与漫画台产物逐字节一致）。
 * ========================================================================== */

function mossMangaSpecSection(mode) {
  const single = mode === 'single';
  const L = [
    '# 漫画台口径规范（MOSS-Image · 照搬 AINIMA 漫画台）',
    '',
    '> 这份口径与 AINIMA 漫画台**同一套写法**：你写的是**一份 page JSON**，',
    '> 坐标由你自己给（左上原点像素），插件照漫画台的编译器原样拼成提示词。',
    '> 与其它 MOSS 口径不通用 —— 那两版要么不给坐标，要么坐标由插件算，别混用。',
    '',
    '## 一、输出什么',
    '',
    '**一份 page JSON**，顶层只有这些字段：',
    '',
    '```json',
    '{',
    '  "style": "color",',
    '  "vertical": false,',
    '  "scene": "<|background_setting|>…<|/background_setting|>\\n<|layout|>LAYOUT AND STORY: …<|/layout|>",',
    '  "note": "",',
    '  "summaryMeta": [],',
    '  "summaryCaption": "",',
    '  "characters": [{"id": "zero", "name": "CHARACTER ONE - 影", "look": ""}],',
    '  "items": [ … ]',
    '}',
    '```',
    '',
    '- `style`：`mono` 黑白网点 / `color` 彩色 / `sketch` 线稿。整页总基调，只写一次。',
    '- `vertical`：文字是否竖排，日漫页一般 `true`，横版页 `false`。',
    '- `summaryCaption` **必须留空**：填了它会整段覆盖 summary，`scene`、格数、文字锁、角色表全部失效。',
    '',
    '## 二、`scene`：两段标签，缺一段等于没写',
    '',
    '```text',
    '<|background_setting|>{地点、时间、光，一句话}<|/background_setting|>',
    '<|layout|>',
    'LAYOUT AND STORY: PANEL ONE is … PANEL TWO is …',
    '<|/layout|>',
    '```',
    '',
    '- 没有背景就直说：`the whole page is plain white paper, no scenery, no walls, no floor.`',
    '- `layout` 段**一句话一格，只写「第几格、在页面什么位置、这一格是什么」**：',
    '  `PANEL ONE is the large panel across the TOP of the page which showing multiple views of CHARACTER ONE.`',
    '- ★ **人物的姿势、衣服、表情不在这里写** —— 那是 character 项的事。',
    '- 🚫 不写 `SETTING:` / `LAYOUT:` / `STORY:` 三段式前缀（旧写法，已弃用），',
    '  也不写阅读顺序、不写「谁是谁」的备注。',
    '- 角色表由编译器自动追加成 `<|character_list|>` 块，**你不要手写**。',
    '',
    '## 三、`items`：四类，每类都带 `bbox`',
    '',
    '| type | 必填 | 写什么 |',
    '| --- | --- | --- |',
    '| `panel` | `bbox` `desc` | 一格。`desc` = `PANEL ONE,` + 方位横竖 + 画面。`shape`/`frame`/`camera` 可选 |',
    '| `character` | `bbox` `ref` `desc` | 一个人。`desc` = `CHARACTER ONE - 名字, inside PANEL ONE only,` + 位置/姿势/这一格的特殊状态 |',
    '| `bubble` | `bbox` `text` | 一句文字。`text` 是要渲染的**原话**；`desc` 只写「在哪 + 谁说」 |',
    '| `native` | `bbox` | 逃生口，直接写 `label` + `caption` |',
    '',
    '### 3.1 `panel.desc`',
    '',
    '- 写法：`PANEL ONE, top band across the full width, wide shot, <画面>`。',
    '- 编号写**英文单词**，一页之内连续、不重复。',
    '- **不写人** —— 人在 character 的框里。场景格只写位置 + 景别 + 环境。',
    '',
    '### 3.2 `character.desc`',
    '',
    '`CHARACTER ONE - RIN, inside PANEL TWO only, <位置>，<姿势/朝向>，<这一格的特殊状态>`',
    '',
    '- 编号和名字必须写全。**外貌不写在这里**（在外貌表里，编译器会追加）。',
    '- 开头写 `!` 表示「这一格和角色表不一样」（裸体、受伤、换装），这个角色就不进本页角色表。',
    '- 同一个角色一页出现两次 → 放两个 character 项，各自写 `inside PANEL ONE only`。',
    '',
    '### 3.3 `bubble`',
    '',
    '- `text`：要渲染的原话，中文原样，一个字都不删。换行用 `\\n`。',
    '- `desc`：`in the TOP LEFT of PANEL ONE, SPOKEN BY CHARACTER ONE - RIN` —— 位置 + 谁说的。',
    '  **不写尾巴方向**（气泡形态由 `kind` 决定）。',
    '- 说话人不在画面里：`kind` 用 `speech-notail`，`desc` 仍要写清是谁在说。',
    '- 旁白：`in the LEFT EDGE of PANEL TWO. It is the narrator, not a character speaking.`',
    '- 拟声词：`kind` 用 `sfx`，`desc` 只写位置（`laid over the CENTRE of PANEL TWO`）。',
    '',
    '## 四、坐标与画布',
    '',
    '**只有一套坐标：左上原点、绝对像素 `[x1, y1, x2, y2]`。**',
    '',
    '- 整数，`x1 < x2`、`y1 < y2`；四边留 8–16px 安全边。',
    '- 🚫 不要写中心化坐标、不要写 `yxyx`、不要归一化到 0~1 —— 换算由编译器做。',
    '- 每个 `character` / `bubble` 的框**必须落在它所属那一格的框内**，四周留 20~40px 余量。',
    '',
  ];

  if (single) {
    L.push(
      '## 五、页型：单图（整页只有一张画）',
      '',
      '- 整页**只有一个 panel**，铺满画布（四边各留 8~16px）；**不要拆格**。',
      '- 人物顶满：主格人物占 **70–90%**，背景让位。',
      '- 只为「交代地点」才画完整环境，其余画面可以让背景空掉。',
      '',
    );
  } else {
    L.push(
      '## 五、页型与版式',
      '',
      '| 页型 | 结构 | 用途 |',
      '| --- | --- | --- |',
      '| **叙事页** | 3–5 格横带式，一大配两三小 | 推进剧情、铺垫 |',
      '| **高潮页** | 1 满版 + 2–4 嵌格 | 正戏，最常用 |',
      '| **满版单人页** | 1 张铺满 + 3–4 个剧情嵌格 | 人物海报式，信息靠嵌格给 |',
      '',
      '- **比例**：主格 50–65% 页高；注脚格 200–300px；一页最多一个大格。',
      '- **阅读顺序：右 → 左、上 → 下。** 同一行先右格、后左格。',
      '- **连续的两格优先上下排** —— 左右并排时模型有很高概率把先后画反。',
      '- 格与格之间留 10~20px 的缝。',
      '',
    );
  }

  L.push(
    '## 六、人物：外貌只写一次',
    '',
    '- 外貌写进 `characters[].look`（角色表），一页只写一次；格子里的 character 项**只说这一格画什么**。',
    '- `name` 必须是 `角色 N - 名字` 这个格式（编译器靠它拼角色表）。',
    '- `look` 留空 = 插件从角色档案自动填 —— **推荐留空**，档案里的锚点跨楼一致。',
    '- 没写死的属性每次都会被重掷；同一个属性用 **tag 比长句可靠**。',
    '',
    '## 七、成人向格的写法',
    '',
    '性爱格的 `panel.desc` **按 tag 骨架写，不要写成句子**：',
    '',
    '```text',
    'PANEL TWO, the large panel across the BOTTOM,',
    '{人数 + 关系：1boy, 1girl, hetero, solo focus},',
    '{动作父子对：sex, vaginal},',
    '{裸露状态：completely nude},',
    '{身体：large breasts, navel, stomach, collarbone},',
    '{表情：blush, half-closed eyes, tongue out},',
    '{体液：sweat, shiny skin, saliva, cum in pussy},',
    '{机位：pov, from below},',
    'PLAIN WHITE BACKGROUND with no background detail at all',
    '```',
    '',
    '- 常用体位 tag：`missionary` / `cowgirl position` + `girl on top` + `straddling` /',
    '  `reverse cowgirl position` / `sex from behind` + `doggystyle` / `standing sex` + `leg up` /',
    '  `prone bone` / `mating press`。再配 `uncensored` `nude` `completely nude` 一起写。',
    '- ★ **父子 tag 一起打**：`sex, vaginal` / `oral, fellatio` / `masturbation, female masturbation, fingering`。',
    '  只打子 tag 会画出「像但不是」的构图。',
    '- ★ `solo` = 画面里只有一个人；`solo focus` = 有两个人但镜头只认女生。异性场景几乎都带 `solo focus`。',
    '- 🚫 **不写 `nsfw`，不写 `masterpiece` / `best quality` / `absurdres`** —— 色情 tag 本身就是开关。',
    '- 🚫 同一页只用一种写法（空格 `large breasts` 或下划线 `large_breasts`，不准混）。',
    '- 一页最多一个 `solo focus` 和一次 `pov`，两个都堆上去镜头会打架。',
    '- 动作编排：一页三个动作（前戏 → 正戏 → 变化/反应），别一页一个；每场戏要不一样。',
    '- 体液与情绪：`sweat` `shiny skin` `saliva` `drooling` `tears` `blush`，表情 `ahegao` `tongue out`',
    '  `half-closed eyes` `rolling eyes`；但**一页只让一种情绪当主角**。',
    '',
    '## 八、自检（写完逐条对一遍）',
    '',
    '- 每个 item 都有 `bbox`，四个整数，`x1<x2`、`y1<y2`，都在画布内？',
    '- `character` / `bubble` 的框都在它那一格里？',
    '- `summaryCaption` 是空的？角色表没手写？',
    '- 每个 character 的 `desc` 都以 `CHARACTER N - 名字, inside PANEL X` 开头？',
    '- 性爱格是 tag 串，不是句子？没有 `nsfw` / `masterpiece`？',
    '- 人物的外貌只出现在 `characters[].look` 里一次？',
  );

  return L.join('\n');
}

function mossMangaSystemAddon() {
  return [
    '',
    '## 本次口径：漫画台（page JSON）',
    '',
    '你输出的不是 MOSS Layout，也不是纯提示词，而是一份**漫画台 page JSON**：',
    '`{"style","vertical","scene","characters":[…],"items":[…]}`。',
    '**坐标由你自己写**（左上原点像素 `[x1,y1,x2,y2]`），插件负责换算与拼装。',
  ].join('\n');
}

function mossMangaProtocolAddon(mode) {
  const single = mode === 'single';
  return [
    '',
    '## 输出格式（漫画台口径，优先于上文任何示例）',
    '',
    '只输出**一个 JSON 对象**，不要解释、不要代码块以外的文字：',
    '',
    '```json',
    '{',
    '  "style": "color",',
    '  "vertical": false,',
    '  "scene": "<|background_setting|>…<|/background_setting|>\\n<|layout|>LAYOUT AND STORY: …<|/layout|>",',
    '  "note": "中文备注，不进提示词",',
    '  "summaryMeta": [],',
    '  "summaryCaption": "",',
    '  "characters": [{"id": "zero", "name": "CHARACTER ONE - …", "look": ""}],',
    '  "items": [',
    '    {"type": "panel", "id": "pn_a", "bbox": [8, 8, 952, 1272], "shape": "rect", "frame": "border",',
    '     "camera": "medium", "desc": "PANEL ONE, the whole page, …", "note": "中文备注"}',
    '  ]',
    '}',
    '```',
    '',
  ].concat(single
    ? [
      '- `items` 里**只有一个 panel**（铺满画布），**不拆格**。',
      '- 没有对白就不建 `bubble` 项。',
    ]
    : [
      '- `items` 里每个格子一个 `panel`；2 格以上。',
      '- 每格的 `character` / `bubble` 框必须落在那一格之内。',
    ]).concat([
      '- ★ `bbox` 一律是**左上原点绝对像素整数**；不要写中心化/yxyx/归一化。',
      '- ★ `summaryCaption` 保持空字符串；角色表不要手写。',
      '- ★ 每个 item 的 `id` 唯一（`pn_a` / `ch_a` / `tx_a` 这种）。',
    ]).join('\n');
}

/**
 * 漫画台出厂模版（`output: 'manga'`）。
 *
 * @param {string} name 模版名
 * @param {'multi'|'single'} mode 一页几格
 */
export function defaultMossMangaTemplate(name = 'MOSS漫画台(多格JSON)', mode = 'multi') {
  const m = mode === 'single' ? 'single' : 'multi';
  return {
    name,
    engine: 'moss',
    variant: 'en',
    output: 'manga',
    mangaMode: m,
    system: DEFAULT_SYSTEM + mossMangaSystemAddon(),
    spec: mossMangaSpecSection(m),
    protocol: MOSS_BASE_PROTOCOL + mossMangaProtocolAddon(m),
    jailbreak: DEFAULT_JAILBREAK,
  };
}

/** MOSS-Image 出厂模版（engine='moss' + variant='en' 单串整段，见上方注释）。 */
export function defaultMossTemplate(name = 'MOSS（多格漫画）') {
  /**
   * ★★★ v0.9.119：**不再复用默认模版的 §一§二**。
   *   那两节要求模型「在 tag 里逐字照抄 hair/eyes/outfit」—— 那是 SD / K2 的分工。
   *   MOSS 口径下人物段由插件注入，模型再抄一遍就是重复描述（语义平均成模糊态）。
   *   现在换成 `mossSpecSection12()`，§三 仍是 MOSS 专属的画面写法。
   */
  return {
    name,
    engine: 'moss',
    /** 纯 prompt 版：tag 就是最终整段提示词（v0.9.121 起显式标记，见 activeOutput）。 */
    output: 'text',
    /**
     * ★ variant 必须是 'en' —— 组装层靠它走「单串整段」分支（不注入 scene / 人物段）。
     *   名字沿用 'en' 是历史包袱（它本来是「K2 纯英文单段」的标记），
     *   但对 MOSS 而言语义是「tag 即全文」；`refreshK2FactoryTemplates` 只刷 engine==='k2'，
     *   不会把 MOSS 模版覆盖成 K2 文本（已确认）。
     */
    variant: 'en',
    system: DEFAULT_SYSTEM + MOSS_SYSTEM_ADDON,
    spec: mossSpecSection12() + mossSpecSection3(),
    protocol: MOSS_BASE_PROTOCOL + MOSS_PROTOCOL_ADDON,
    jailbreak: DEFAULT_JAILBREAK,
  };
}

/**
 * 识别「这是不是本项目出厂的最新 MOSS 模版文本」（判旧版用文本特征，不认名字）。
 *
 * v0.9.119：标记换成 **§一 的标题** —— 这一版的结构性变更是「§一§二 不再复用 SD/K2 那两节」，
 * 旧的 `#### 人物外貌与服装：插件注入` 标题在两版里都有（v0.9.119 只是把内容缩成了引用），
 * 拿它当标记会让旧正文被误判成最新。
 * v0.9.118 用它的原因同理：当时的变更是「人物段由插件注入」。
 */
const MOSS_SPEC_MARK = '## 一、人物外貌：插件注入，你不要写 ★★★';
export const MOSS_SPEC_MARKER = MOSS_SPEC_MARK;

/**
 * ★★★ v0.9.120 判旧标记：**「每格重述身份」这条规则**。
 *
 * 不能拿 `MOSS_SPEC_MARK`（§一 标题）当判据 —— v0.9.119 与 v0.9.120 的标题一模一样，
 * 拿它判旧会让 v0.9.120 的旧正文被误判成最新（v0.9.119 就是这么踩的同一个坑）。
 * 只认这一版新增的那句原话。
 */
const MOSS_SPEC_MARK_V0120 = '每格提到人物，必须带「身份锚点」';

/**
 * ★★★ v0.9.121 判旧标记（纯 prompt 版）：**「构图收束」那条**。
 * 只认这一版新增的那句原话，理由同上（同一节标题在多版里都一样）。
 */
const MOSS_SPEC_MARK_V0121 = '三人以上同框：格首要加一句「构图收束」';

/**
 * ★★★ v0.9.121 判旧标记（JSON Layout 版）：§一 的标题。
 * 两个版本的 §一 标题完全不同（纯 prompt「人物外貌：插件注入，你不要写」
 * / Layout「人物：每个角色一个 character 项，外貌写在 caption 里」），
 * 所以这一句既能判「这是不是 Layout 版正文」，也能判「是不是最新」。
 */
const MOSS_JSON_SPEC_MARK = '## 一、人物：每个角色一个 character 项';

/**
 * ★★★ v0.9.129：Layout 版 spec 改成「多格口径」后的标志串。
 *
 * 为什么必须另起一个（不能沿用上面那句）：
 *   新标题是 `## 一、人物：每个角色一个 character 项，只写本镜头可见的` ——
 *   **旧标志串是它的前缀**（子串判定恒真）。继续用旧串判「是不是最新」，
 *   会把真正的最新版判成老版、把老版判成最新版，两边全错。
 *
 * 改了什么（用户 2026-10-22 定调：「K2 都只是为了单图出，现在多图当然以 NAI 为优先级」）：
 *   · §一 由「必须写全外貌 + 每件衣服带颜色」改成「只写本镜头可见的」（景别表）——
 *     原写法是单图 tag 思路，多格下会把 caption 词额吃光，成人画面那六项一个都写不进去；
 *   · §1.1 重述的由「同一身份特征」收窄成「可见的身份锚点」，不再重抄完整外貌；
 *   · §3.2 删掉硬编码的三格 / 四格 / 两格比例表 —— 版式自 v0.9.126 起是每次随机抽的
 *     六种不等分几何，旧表会把模型拉回「三条等高横条」；
 *   · §3.6 由「character caption 35~70 词」改成「50~110 词，成人场景 85~130」。
 */
const MOSS_JSON_SPEC_MARK_V0129 = '## 一、页面规划：先定主格，再分格';

/**
 * ★★★ v0.9.133：服装章换成 NAI 三段式（穿搭 DNA → 生效页格变化 → 逐格完整衣着词）。
 *
 * 为什么必须迁移：Layout 版的 spec 是**存在用户配置里**的（`t.spec`），
 * 只改代码里的出厂文本不会生效 —— 实测 2026-10-22 楼 202 用的仍是 v47 那份
 * 「§4.1 整页写一次基准 / 每件带颜色」，那是 K2 单图口径。
 *
 * NAI 依据（`插件/NAI漫画台/_dump`）：
 *   31 §1 穿搭DNA（开场款式/材质/配饰，其余状态须有剧情依据）
 *   31 §2 外观变化（人物｜生效页格｜变化结果，跨页换镜头不构成变化）
 *   31 §3 每次出场独立写当前可见完整词，禁「同上」
 *   40 第 43 行 画外不当作消失，重新入镜恢复
 */
const MOSS_JSON_SPEC_MARK_V0133 = '### 4.1 穿搭 DNA：开场建档，之后只记变化 ★★★';

/**
 * v47 出厂 §四 服装章的**内容指纹**（`hash32` of `\n` 规范化 + trim 后的全文，1312 字符）。
 *
 * 为什么用 hash 而不是「命中几句特征」：
 *   用户改 §四 时通常只改中间一两句，特征句（标题 / `每件带颜色`）往往留着 ——
 *   按特征判断会把他的自改整章冲掉。实测（本版 mig48 用例⑤）第一版就是这么错的。
 *   **逐字比对才是最诚实的判据**：一个字没动才换，动过就完全不碰。
 */
const MOSS_JSON_SEC4_V47_HASH = '5xhzbw';

/** K2 出厂模版公共骨架（spec 复用默认模版的 §一§二，§三 换成 K2 口径）。 */
function k2TemplateBase(name, styled) {
  const cut = DEFAULT_SPEC.indexOf('## 三、');
  const head = cut > 0 ? DEFAULT_SPEC.slice(0, cut) : DEFAULT_SPEC;
  return {
    name,
    engine: 'k2',
    variant: styled ? 'styled' : 'plain',
    system: DEFAULT_SYSTEM + (styled ? K2_SYSTEM_ADDON_STYLED : K2_SYSTEM_ADDON),
    spec: head + (styled ? K2_SPEC_SECTION3_STYLED : K2_SPEC_SECTION3),
    protocol: DEFAULT_PROTOCOL + (styled ? K2_PROTOCOL_ADDON_STYLED : K2_PROTOCOL_ADDON),
    jailbreak: DEFAULT_JAILBREAK,
  };
}

/** K2 中英混合出厂模版（去风格化版）。 */
export function defaultK2Template(name = 'K2 中英混合') {
  return k2TemplateBase(name, false);
}

/** K2 中英混合出厂模版（带风格化版：每图前置写实锚定块 + 胶片质感收口）。 */
export function defaultK2StyledTemplate(name = 'K2 中英混合（带风格化）') {
  return k2TemplateBase(name, true);
}

/* ============ K2 NSFW 出厂模版（v0.9.29 · 第四/五套） ============ */

/**
 * NSFW 出厂文本的标志串。
 *
 * 存在的意义：`refreshK2FactoryTemplates` 靠 variant + 标志串判断「这是不是没被用户改过的
 * 出厂文本」。NSFW 模版的 variant 仍是 plain / styled（这样 UI 与组装层完全不用改），
 * 若只靠 variant 判定，它会**被普通版整篇覆盖** —— NSFW 板块静默消失，用户只会觉得
 * 「出词又变回老样子」。所以必须有一个专属标志串把它认出来。
 */
export const NSFW_SPEC_MARKER = '### 3.9 NSFW 板块';

/**
 * v0.9.94 · NSFW 板块标题的判定正则。
 *
 * ★ 为什么不能再只用 `NSFW_SPEC_MARKER`：那串是 **K2 出厂模版（§3.9）** 的标志，
 *   而 SD 模版规范（v2，2026-10-17）把 NSFW 放在 **§五**（`## 五、NSFW 情节`）。
 *   实测病例：SD漫画宫格 模版正文 11282 字符、NSFW 板块确实在，
 *   但 `t.spec.includes('### 3.9 NSFW 板块')` 恒为 false → `activeNsfw()` 永远返回 false。
 *
 * ⚠️ 影响面要说清：目前 `activeNsfw()` 只 gate 一处 —— 花妆三档（`smudgeOf`）。
 *   NSFW 的**行为 / 体位 / 部位** tag 由出词模型照规范自己写，不经这道门禁。
 *   所以这不是「NSFW 提示词没执行」的原因，属顺手修的判定失效。
 */
const NSFW_SPEC_HEAD_RE = /^[ \t]{0,3}#{2,4}[ \t]*(?:3\.9|五[、.])[ \t]*NSFW/im;

/** 模版正文里有没有 NSFW 板块（兼容 v1 的 §3.9 与 v2 的 §五）。 */
export function specLooksNsfw(spec) {
  const s = String(spec || '');
  return s.includes(NSFW_SPEC_MARKER) || NSFW_SPEC_HEAD_RE.test(s);
}

/**
 * NSFW 板块（spec §3.9）。
 *
 * 口径来源：用户工作区《K2 人像提示词引擎（NSFW 版）》（B站-是古手梨花sama）
 * + k2-prompt-core 的 ref/00 速查卡 / ref/03 防畸变 / ref/08 禁令与自检。
 *
 * ⚠️ 与源口径**唯一的、有意的偏离**是「服装段仍走中文」—— 见 ② 的说明。
 * 这不是漏写：绘灵的人物段由角色档案机械注入，服装属**人设主权区**；
 * 让模型在英文段再写一遍服装 = 中英复述 = 跨段复制出多余实体
 * （2026-09-27 翻车图：同一条牛仔裤被描述 4 次 → 画面多出半截人）。
 * **铁律压倒口径：任何东西只在提示词里出现一次。**
 */
export const K2_NSFW_SPEC_SECTION = `

### 3.9 NSFW 板块（★ 仅当判定为 NSFW 时启用；判定为 SFW 则整节跳过）

**① 判定（拿不准一律按 SFW）**
- **NSFW** = 正文明确写了**隐私部位裸露**（露点 / 下体暴露）或**性行为**。
- 擦边、性感着装、诱惑姿势、情趣服装**一律算 SFW** —— 按 §3.1–§3.8 原样执行，不要提前启用本节。
- 🚫 **硬边界（不可协商）**：未成年人相关内容（含「学生 / 校服」但未注明成年）；
  非自愿 / 强迫 / 无意识对象。**命中就不配这张图**（images 里不要出现这条），
  **不要试图换个说法绕过去** —— 换说法等于你自己把边界擦掉了。
- **成年锚定（合规判定）**：年龄缺失时**默认按成年处理**；校服 / 制服类必须在人物段写明「已成年」。
  ⚠️ 这是**合规判定**，不是提示词措辞 —— 英文句里仍不许写「adult」二字（见 §3.6 年龄锚定三档：
  年轻 young / 达观 mature / 无年龄措辞光杆 a man）。「成年」二字进提示词会把脸画老、体型画壮。

**② 英文使用边界（★ 与通用版最大的不同）**
通用版是「中文叙事 + 英文动作句」。NSFW 下**只有姿态段走英文整句**，其余一律中文：

| 段 | 语言 | 落在哪个字段 |
|---|---|---|
| 场景 / 光影 / 构图 | 中文 | scene |
| 外貌（发型、瞳色、体型） | 中文 | 人物段（档案机械注入，你不得改写） |
| **服装** | **中文** | 人物段（同上，属**人设主权区**） |
| **姿态 / 动作 / 接触关系** | **英文整句** | cast[].en |

> ⚠️ **服装为什么仍走中文**（这是刻意偏离源口径，不要「修正」它）：
> 绘灵的人物段由角色档案机械注入，服装属于人设主权区 —— 你既不得改写，
> 也**不得在英文段再写一遍**。中英各说一遍同一件衣服 = 跨段复述 = 模型复制出多余实体。
> **判据：任何东西只在提示词里出现一次；写完数一遍，同一件事物出现两次就删掉一处。**

**③ 姿态段（cast[].en）· 只写画面看得见的，且只写一次**

★ 头号原则：**画面上看不见的、或别处已经写过的，一个字都不写。**
每多写一处细节 = 多一条「必须同时成立」的约束；约束越多，模型越难找到自洽解，
只能折中 —— 而折中在画面上就是肢体扭曲与多出来的手。**写得越少越稳。**

- **篇幅**：每人 1–2 句；整张图的姿态段合计控制在 **200–300 字**（中英合计）。
  超了就是写碎了 —— 砍细节直到达标，别把一句能说完的事拆成三句。
- **必写五件**（少一件画面就散，多一件就崩）：
  1. **承重面** —— 他/她靠什么撑住身体（禁悬空、禁托举）。
  2. **核心动作** —— 一句话说清谁在做什么：**姿势 + 方向**。不写过程、不写感受。
  3. **手位** —— **最多写一只手在干什么**；第二只手**不写**。
     （不写 ≠ 没有，不写 = 交给模型自然垂放。两只手都写死，模型为凑第二份几何就会多画一只 ——
     实测「单人图画出三只手」就是动作句写了两只、情绪句又提了一次手指。）
  4. **胯部对齐** —— 双人下身相接时必写 \`his hips aligned with hers\`（或同义一句），
     否则两副骨盆各画各的，下身错位/悬空连接（骨架句库每组都带它，别删）。
  5. **接触关系** —— 性行为画面必须写实：器官 + 部位 + 方向一次写死（见下面第 6 条）。
- **禁写的身体细节（写了必崩）**：手指 / 脚趾 / 掌心 / 手腕 / 腰侧 / 肩胛 / 肋骨 / 锁骨 /
  膝盖内侧 / 脚踝 / 大腿内侧。这些部位模型数不清，写出来它就给你多接一截、多长一只。
  ✅ 要写手就只写到「手」这一个层级：\`one hand gripping her hip\` —— 到此为止，
  不要接着写 fingers / palm / fingertips。
- **禁复述**：人物段已经写过的服装 / 外貌 / 发色，姿态段一个字都不许再提。
  **判据：写完数一遍，同一件事物在全篇出现两次，就删掉后写的那一处。**
- **★ 句法三约束（2026-10-02 并入 V3 验证写法，实测显著降低多肢体 / 器官错位）**
  1. **一图一个主动几何**：姿态由**一人**作主语，对方只以**从属成分**出现
     （\`his hands gripping her waist as he drives into her from behind\`）。
     🚫 **禁止两个人各写一句完整主谓宾动作** —— 两份几何各自成立，模型就会各画一份
     （实测「三只手」「器官错位」的直接来源；绘灵旧口径正是两人各写各的）。
  2. **方向一次写死**：插入方向（from behind / from the front / from below）**只声明一次**，
     且必须写。含糊写法（having sex / together）等于让模型自己选 → 一半概率选错。
  3. **反应只作从属从句**：身体反应 / 表情 / 呼吸**只能**挂在姿态句末尾当从句
     （\`, her body slack and trembling\`），**不许写成独立新句**（独立句 = 新主谓 = 多一份肢体）。
     **全篇只选一条**（见下面 ③d 反应链库）—— 叠两条会把同一事实说两遍（如弓背写两次）。
- **情绪不写在这里**：姿态段只管几何。情绪归 tag，且只给 1 个词。

**③b 镜头与构图（★ 每张必写，写在 scene 段首句）**

镜头与构图是**唯一多多益善**的部分 —— 它不参与人体几何，写再多也不会多长出一只手，
反而能把人锁在画面里的正确位置（这是「画面跟剧情对得上」的关键，正文永远不会写它）。

- **机位**：平视 / 低角度仰拍 / 45° 斜俯视 / 90° 顶拍 —— 四选一，明示。
- **景别**：全身 / 半身 / 特写 —— **只写一个**（写两个模型不知道画到哪，会把人截断）。
- **构图与体积关系**：谁在前景、谁在后景、两人大小比例、谁被谁挡住。
  （例：「他背对镜头占画面左侧三分之二，成为前景体积块；她在后方只露出肩与侧脸」）
- **★ 景别决定写不写服装**：
  - **全身 / 远景** → 服装看得见，**要写**（人设辨识度靠它）。
  - **半身 / 特写 / 局部** → 服装与鞋袜**看不见就不写**。
    写了画外部位，模型会硬塞一块进画面（实测：特写图里冒出半截裤子）。
**③c 骨架句库（★ 先选先抄，禁从零造句 · 2026-10-01 新增）**
「自造机位 × 体位组合」是 NSFW 崩坏的头号根因。下面 11 组是**实测出图稳定**的双人姿态，
每组分「她 / 他」两句 —— **两句几何同源，必须成对使用**，禁止混搭不同组合的「她」句与「他」句
（混搭 = 自造新组合，必崩）。写姿态段时**先在这里选**最贴合本楼机位与体位的一组，然后：
- **只替换场景词**（bed / floor / sheet → 本楼实际承重面），其余**一字不改** —— 改写句式 = 自造组合。
- **裸露状态按 ④b 阶段取舍**：阶段①②（衣物未脱）删去 fully exposed / nude 一类词、改回穿着状态；阶段③之后照原句。
- 胸型词已刻意删去（外貌由人物段承担，**不要自行加回** —— 加了 = 外貌写两遍 = 复制实体）。
- 原句库里的 an adult male partner 已按 §3.6 改成 the man（禁 adult）—— **不要改回去**。
- 句子都没指定多余的手位 —— 保持原样，不要替模型补手。
- **★ 库里没有对应体位时怎么办**（2026-10-11 新增 —— 这条是「库形同虚设」的解药）：
  选**机位最接近**的一组（机位优先于体位），只替换承重面词与插入方向词，**几何一字不改**。
  🚫 **严禁自造组合** —— 自造机位 × 体位 = 多肢体 / 器官错位的头号来源，改一百次措辞也不会对。
  🚫 **机位与体位在库内确实无解时**（如顶拍配站立 —— 顶拍下直立只剩一个头顶）→ **换机位，不要改措辞**。
  判据：**你选的是「库里的一组」，还是「自己拼出来的一句话」？** 后者必崩。

【顶拍 90° · 仰躺前入 · 零叠压】
她：She lies on her back on the bed, her head tilted back, her face turned up toward the camera, her eyes fixed on the camera, both arms lying loose beside her body, her legs bent and spread wide open with her knees raised and pressed apart on the sheet.
他：The man kneels between her legs with his upper body leaning forward only, both hands gripping the outside of her thighs and pressing her legs wide open, his head lowered toward her, he is completely nude from the waist down with his hips and thighs bare, his hips aligned with hers, his pelvis pressed against her pelvis, his cock thrusting deep into her pussy from the front, penetrating her vagina with hard steady strokes.

【侧方平视 · 狗爬后入】
她：She kneels on all fours on the floor, her hands and knees supporting her body, her back arched, her hips raised, her head turned slightly to the side with her face visible in profile, her eyes fixed on the camera, shy and timid, her lower lip caught lightly between her teeth, a faint blush on her cheeks, tears in her eyes.
他：The man kneels behind her, his hips aligned with hers, his pelvis pressed against her pelvis, one hand gripping her waist, his other hand gripping her hip, his cock thrusting deep into her pussy from behind, penetrating her vagina with a steady deep rhythm.

【斜俯视 45° · 叠压位】
她：She lies on her back on the floor, both wrists pinned to the ground above her head, her legs spread open, her head tilted back, her gaze fixed on the camera, seductive and teasing, her eyes half-lidded, her lips parted in suppressed moans, her breasts fully exposed with her nipples clearly visible.
他：The man presses his body over her from above, his torso covering her, one hand pinning her left wrist to the ground, his other hand pinning her right wrist, his hips aligned with hers, his pelvis pressed against her pelvis, his cock thrusting deep into her pussy from the front, penetrating her vagina with a steady deep rhythm.

【平视 · 面对面坐姿（方向词 from below 的标准句）】
她：She sits on his lap facing him on the bed with her legs wrapped around his waist, her arms resting on his shoulders, her body leaning slightly forward.
他：The man sits on the bed, he is completely nude from the waist down with his hips and thighs bare, his hips aligned with hers, his pelvis pressed against her pelvis, his cock inside her from below, penetrating her pussy with a steady deep rhythm.

【平视 · 侧躺 spooning（后侧入）】
她：She lies on her side on the bed, her head turned back over her shoulder toward the camera, her eyes half-lidded, her lips softly parted, her legs bent with her upper leg draped over his waist, her lower leg bent along the sheet, one hand propping her up with her elbow, her other hand clutching the sheet.
他：The man lies behind her, he is completely nude from the waist down with his hips and thighs bare, his hips aligned with hers, his pelvis pressed against her pelvis, one hand gripping her waist, his other hand gripping her raised upper thigh, his cock inside her from behind, penetrating her vagina with a steady deep rhythm.

【骑乘 · 她主导】
她：She straddles him as he lies flat on his back, her torso upright and leaning slightly forward, both hands braced on his chest, her hips rocking steadily, her chin lifted, her eyes half-lidded and staring down into his face, a knowing, self-possessed smile curling at her lips.
他：The man lies flat on his back beneath her, his head tipped back, his jawline taut, he is completely nude from the waist down with his hips and thighs bare, both hands gripping her hips, his hips aligned with hers, his cock inside her.

【跪姿口交】
她：She kneels on the floor before him with her hands resting on her thighs, leaning forward to press a slow kiss to the tip, her eyes closed in devotion, her lips parting to take him in inch by inch as her cheeks hollow with gentle suction.
他：The man stands before her with both feet planted on the floor, he is completely nude from the waist down with his hips and thighs bare, his cock in her mouth.

【平视 · 站立压墙后入】
她：She stands facing the wall with both palms pressed flat against it, her back arched and her hips pushed back toward him, both feet planted on the floor.
他：The man stands directly behind her with both feet planted on the floor and his knees bent to lower his center of gravity, one hand gripping her hip, he is completely nude from the waist down with his hips and thighs bare, his hips aligned with hers, his pelvis pressed against her buttocks, his cock thrusting deep into her pussy from behind, penetrating her vagina with hard steady strokes.

【斜俯视 45° · 俯卧趴地（prone bone）】
她：She lies flat on her stomach on the bed with her legs pressed together and her arms stretched out along her sides, her face turned to the side with her cheek pressed into the sheet.
他：The man covers her from behind with his full weight resting on her, his chest pressed against her back, one hand pressing down on her shoulder, he is completely nude from the waist down with his hips and thighs bare, his hips aligned with hers, his pelvis pressed against her buttocks, his cock thrusting deep into her pussy from behind, penetrating her vagina with hard steady strokes.

【平视 · 反骑乘（她背对他跨坐）】
她：She straddles him facing away from him, her knees planted on the mattress on either side of his hips, her body leaning slightly forward, both hands braced on his thighs, her head tipped back.
他：The man lies flat on his back beneath her, both hands gripping her thighs, he is completely nude from the waist down with his hips and thighs bare, his hips aligned with hers, his cock inside her from below, penetrating her pussy with a steady deep rhythm.

【平视 · 面对面站立 · 单腿挂腰】
她：She stands with her back against the wall, one leg lifted and hooked over his waist, her arms looped around his neck, her standing foot planted on the floor.
他：The man stands facing her with both feet planted on the floor, one hand supporting her lifted thigh, he is completely nude from the waist down with his hips and thighs bare, his hips aligned with hers, his pelvis pressed against her pelvis, his cock thrusting deep into her pussy from the front, penetrating her vagina with a steady deep rhythm.

**③d 反应链库（★ 2026-10-02 新增 · 从 V3 融合版验证库并入）**

姿态写完后**最多挑一条**反应链，原样接在句尾（自带前导逗号）。**不改写法、不叠第二条**：
这些句子是调过的从属结构，改写成独立句就失去「不引入新主谓」的保护作用。

- 失神：\`, her gaze growing unfocused, lips parting in a dazed sigh\`
- 羞耻：\`, her cheeks flushed, eyes avoiding his with shy embarrassment\`
- 运动：\`, the motion steady and rhythmic, skin catching the light\`
- 事后：\`, her body slack and trembling, breath coming in short gasps\`
- 喘息：\`, her head tilted back, lips parted in ragged breaths\`
- 求饶：\`, a pleading whisper escaping her parted lips\`
- 僵直：\`, her body going rigid, toes curling as she holds still\`
- 潮湿：\`, her skin damp with a fine sheen of moisture\`
- 无（默认）：不接反应链，只写姿态本身 —— **拿不准就选这条**

🚫 V3 原库的「强制链」（手腕被制 / restraint）与「睡奸」「过激」两类姿态**已剔除**：
前者易被读作非自愿，后两者触硬边界（§3.6）。**不要自行加回**。

**③e 通用防畸变律（★ 2026-10-11 新增 · 跨体位长期生效，优先级高于任何单条姿态写法）**

这五条是「多肢体 / 少手少脚 / 肢体扭曲」的**实测根因**。它们的共同机制只有一句：
**同一部位被声明第二次，模型就多画一份几何去满足它。** 每条都是让你**少写**，不是多写。

1. **肢体单一声明律**（★ 三只手 / 多肢体的头号根因 —— 完整写法见 **§3.4b**，**NSFW 下同样强制**）
   成对身体部位（手 / 臂 / 腿 / 脚 / 膝）在同一句里**只允许一套几何**：
   - ✅ \`both hands + 同一个动作\`｜\`one hand …, the other hand …\`（**不指定左右，最稳**）
   - 🚫 **禁「总括 + 分项」叠写**：\`both hands raised — his right …, his left …\`
     —— 总括是状态、分项是位置，两条几何冲突 → **多长出一只手**去满足第二份声明。
     \`双手托举 + 左右手分项\` 属同一类违规。
   - **能只写一只就只写一只**（另一只不提，比写错稳得多）。
   - **判据（写完数一遍）**：这一句里「手」被声明了几次？
     1 次 ✅｜2 次且几何自洽 ✅｜**2 次且冲突 → 删掉总括句**。

2. **腿位极简律（★ 腿的修饰词越多越崩）**
   腿部只写「**一个方向 + 一个状态**」，超过一个词组就删。
   - ✅ \`her legs spread wide open\`｜\`her legs raised and draped over his shoulders\`｜\`her upper leg draped over his waist\`
   - 🚫 禁叠加：单膝 / 脚掌落点 /「另一条腿被挡住」/ M 形 /「双腿向两侧对称张开」
     （侧上方与过肩机位先天给不出对称，写对称必崩）
   - 🚫 **禁说明句**：说明句本身也会被画成实体。
   - **★ 腿偏一侧必须配躯干锚定**：只写腿偏一侧、不写躯干，整个下半身会跟着侧转 →
     必须同时写 \`her pelvis flat and turned up on the bed\`（或同义一句）。
   - **机位越偏，腿越简**：侧上方 / 过肩 / 45° → 删到只剩一句。

3. **掰腿前置律**
   写「掰开 / 压开 / 双腿大张」前，先看她的腿还有没有行程：
   \`her knees raised\`（屈膝抬起）→ ✅ 能掰｜\`knees fallen outward\`（摊平贴床）→ ❌ 不能
   （会被读成向内压 → 畸变，先改成屈膝抬起）｜\`legs spread wide open\`（已大张）→ ⚠️ 有限，
   改写成「把腿按住摊到最大」而非「掰开」。

4. **承重面必写**（写法见 **§3.3**）—— 每个人「靠什么撑住」必须写得出来，
   写不出「上身抬起靠什么撑」就别写这句。🚫 禁托举 / 悬空类（抱起离地、双脚离地）。

5. **同段禁重复词**
   同一形容词 / 同一动作词在一条提示词里**只用一次**（\`looks out\` 与 \`watches\` 属同义重复）。
   重复 = 双重加权 → 模型把该特征画过头并带出畸变。
   （与 §3.9 ②「跨段不重复」是同一原则的两面：**跨段不重复 + 英文内部不重复**）

**④ 机位 × 叠压：三条硬边界（NSFW 头号崩坏源）**
- **垂直俯视 90°（顶拍）**：只承载「上下串联」结构（跪趴 / 仰躺零叠压）。**禁**「他压在她身上」。
- **斜俯视 45°**：承载叠压位（他整个身体压在她上方）。
- **平视 / 低角度**：侧躺、坐姿、站立 —— **必须有可读的承重面**。
- 口诀：**俯视越正，越不能叠压**（反向同样成立：45° 承载不了零叠压，命中就换机位，别改措辞）。
- **机位越偏，腿位越简**：侧上方 / 过肩 / 45° 先天看不到「两侧对称」，
  写 M 形或「双腿向两侧张开」必崩 —— 统一简化到 \`her legs spread wide open\`。

**④b 动作阶段（★ v0.9.52：同楼多图与跨楼推进的分工依据）**
一场戏按下面的阶段推进。**同一楼出多张图时优先按阶段分工** —— 两张都画同一个阶段 = 白出一张：

| 阶段 | 该出现的画面事实 | 该阶段**不该**出现的 |
|---|---|---|
| ① 前戏（无插入） | 衣物状态（解开 / 半褪 / 褪下）、亲吻、抚摸、视线、呼吸与表情 | 器官连接、插入状态 |
| ② 接触升级 | 手位与接触点、身体贴合、承重面已确立 | 完整插入 |
| ③ 初次相接 | 器官贴近 / 刚进入，表情与肌肉反应的**那一瞬间** | 余韵（松弛 / 事后姿态） |
| ④ 进行中 | 插入状态 + 节奏（慢 / 深 / 顶住）、髋部对齐 | 前戏的羞涩与迟疑 |
| ⑤ 高潮余韵 | 痕迹、松弛、瘫软、伏着不动、事后姿态 | 还在持续的动作张力 |

- ⚠️ **阶段由正文决定，不由你决定**：正文只写到亲吻，就绝不画到插入；
  正文已经写到「他停下来、伏在她身上不动」，那就是余韵，不是进行中。
- ⚠️ 跨楼推进时阶段**只能前进或保持**，不许凭空倒退（余韵之后又画回前戏）。
- ★★ **每格重述（v0.9.101）**：\`cast[].en\` 是**逐张独立生成**的，模型不会记得上一张。
  上一格写明 \`his cock inside her, his hips aligned with hers\`，这一格这场戏还没结束就必须**再写一遍**
  （可换措辞、可换节奏、可换机位）—— **这不算「重复」**。
  §3.9 ③ 的「只写一次」管的是**同一张图内部**（同一件事物出现两次＝多画一份几何），
  不管跨图：跨图删掉行为句 = 这一张没有这件事。
  判据：**删掉这句，这张图还成立吗？** 不成立 = 必须写；只是换个机位也成立 = 才是可选细节。

**⑤ NSFW 专属禁令**
- **禁否定句** —— 「没有压在她身上」会被画成压着。只做正面描述（提什么画什么）。
- **禁液体 / 湿润比喻**（中英都禁）：湿润、油光、汗湿、水珠、glistening、dripping、moist、wet。
  场景天然含水（雨天 / 浴室 / 温泉 / 泳池）时豁免。
- **禁自造身体设定** —— 胸型 / 身材 / 五官**只能沿用角色档案里已有的值**；
  档案里没有就**不写**。**这是人设主权区，你不许为剧情补设定**（NSFW 场景最容易犯这条）。
- **禁 50mm 与平视正面标准镜头** —— 焦段只用 24 / 35 / 85 / 135 / 微距。
- **禁权重语法与质量标签** —— \`(xxx:1.2)\`、cinematic、8k、masterpiece 一律不写。
- **禁远景** —— 人物占画面过小会画不完整。要「退远」用**机位升高 + 俯视**，不用景别拉远。
- **禁托举 / 悬空类**（抱起悬空等）—— 未实测，一律不写。
- **禁跨镜引用** —— 不写「承接上一张」「同上」。每张图独立抽卡。
  > v0.9.52：你能看见「近期已出过的图」摘要。**延续的是已经确立的身体事实**
  > （已脱掉的衣物、已留下的痕迹与体液、已进行的阶段），**不是上一张的构图与措辞** ——
  > 同一场戏连出两楼时换机位 / 换景别 / 换构图，别复述同一个瞬间。

**⑤b 禁令的替代表达（★ v0.9.52：禁了就得有得写）**
只给禁令不给替代词，后果就是模型**干脆不写那一事实**（不写 = 丢画面事实，比写错更糟）。
遇到下面这些被禁的表达，按右列改写：

| 不许写 | 改写成 |
|---|---|
| 湿润 / wet / moist / glistening / 水珠 | \`her skin matte and dry, clean and free of any moisture\` |
| 汗湿 / sweaty / 汗珠 | 不写汗，改写体感：\`her cheeks flushed, her breathing quick and shallow\` |
| 否定句（「没有压在她身上」） | 正面写对立状态：\`her upper body lifted, her weight on her elbows\` |
| 远景 / wide shot / 全景拉远 | 机位升高 + 俯视：\`shot from above at 45 degrees\` |
| 托举 / 抱起悬空 | 换成有承重面的结构：\`she straddles him, her knees on the mattress\` |
| 「承接上一张」「同上」 | 直接把这一张的画面事实写全（阶段表 ④b 决定它是什么阶段） |
| 需要表达兴奋液体 / 爱液 | \`translucent arousal fluid trailing down her inner thigh\`（NSFW 库内唯一合法句） |

**⑥ 与 §3.7（多人句式）的衔接（NSFW 双人尤其容易踩）**
- **人数仍由 cast 分块表达**，任何段落**都不写人数声明**（不写 \`1boy 1girl\` / \`two people\`）
  —— 人物段已每人一块立住实体，再声明一次 = 第三处描述 = 多出一个（半）人。
- **POV 镜**：视点人物必须在 cast 里标 \`"offscreen": true\`（他是相机本身，不该入画）。
  只写「POV 视角」不够 —— 那是给读者看的，不是给模型的结构化指令。
- **两人几何必须一致**：两人同框时，两条姿态句描述的是同一个几何关系 ——
  不能一条写「他在她左侧」、另一条写 \`between\`（中英几何相反必崩）。

**⑦ 出图前自检（NSFW 附加项，任一条不过就改完再交付）**
- 姿态段是完整英文句子（不是标签串）？六条锚定齐了吗？
- **姿态句是从 ③c 骨架句库选的吗？**（不是句库里的组合、也不是 ③c 说明允许的替换 → 就是在自造组合，改回句库）
- **画面看得到性行为时，器官与插入状态写实了吗？**（含糊带过 = 没写 = 这张图白跑）
- 有没有把人物段已写过的服装 / 外貌在英文段再说一遍？
- 有没有人数声明？有没有自己加了档案里没有的胸型 / 身材 / 肤色？
- 有没有液体 / 湿润词、否定句、远景、平视正面？
- 命中硬边界吗？（未成年 / 非自愿 → 直接不配图）`;

/** NSFW 模版的 system 附加段（只在 system 尾部追加，不动通用身份）。 */
export const K2_NSFW_SYSTEM_ADDON = `

【NSFW 板块（见 spec §3.9）】
本模版比通用版多一套 NSFW 写法。**正文没有明确露点或性行为时整节跳过**，按通用口径执行。
判定为 NSFW 时：姿态段写英文整句；服装与外貌一律沿用角色档案（人设主权区 ——
你不得改写，也不得自行补设定）。硬边界（未成年 / 非自愿）命中就**不配这张图**，不要换说法绕过。`;

/** NSFW 模版的 protocol 附加段（字段口径）。 */
export const K2_NSFW_PROTOCOL_ADDON = `

【NSFW 时的字段口径（见 spec §3.9）】
- \`cast[].en\` = **姿态段**：必须是含主谓宾的完整英文句子，
  六条锚定（承重面 / 胯部对齐 / 手位 / 接触关系 / 视线 / 性行为写实）齐全。
- **画面存在性行为时，\`en\` 里必须直白写明器官与插入状态**（如 \`his cock inside her\`），
  不得用 having sex 一类含糊说法回避 —— 画面看得到就必须写。
- **服装与外貌不要写进 \`en\`，也不要写进 \`tag\`** —— 它们在人物段由档案注入，
  重复写会复制出多余实体。
- POV 镜的视点人物标 \`"offscreen": true\`。
- \`tag\` 仍只写末句情绪张力：不写人数、不复述姿态、不复述 scene。`;

/**
 * K2 中英混合出厂模版 · **NSFW 版**。
 *
 * 与通用版的关系：完全相同的骨架（spec §一§二 + §3.1–§3.8、system、protocol、jailbreak），
 * 只在**尾部追加** §3.9 NSFW 板块与两段 addon。**不改任何一节既有文本** ——
 * 这样通用版的所有防崩坏条款（含 v0.9.28 的禁人数声明 / offscreen）在 NSFW 版里原样生效。
 *
 * @param {string} name 模版名
 * @param {boolean} styled 是否带风格化（写实锚定块 + 胶片质感收口）
 */
export function defaultK2NsfwTemplate(name = 'K2 中英混合（NSFW）', styled = false) {
  const base = k2TemplateBase(name, styled);
  return {
    ...base,
    nsfw: true,
    system: base.system + K2_NSFW_SYSTEM_ADDON,
    spec: base.spec + K2_NSFW_SPEC_SECTION,
    protocol: base.protocol + K2_NSFW_PROTOCOL_ADDON,
  };
}

/** NSFW 出厂模版（去风格化版）。 */
export function defaultK2NsfwPlainTemplate(name = 'K2 中英混合（NSFW）') {
  return defaultK2NsfwTemplate(name, false);
}

/** NSFW 出厂模版（带风格化版）。 */
export function defaultK2NsfwStyledTemplate(name = 'K2 中英混合（NSFW·带风格化）') {
  return defaultK2NsfwTemplate(name, true);
}


export const DEFAULT_SYSTEM = `你是「绘灵」的图像提示词分析器。每次收到一段小说正文，你要完成两件事：

1. **维护角色档案的一致性**：判断本楼出现了哪些角色、他们的外貌与服装有没有发生变化，
   把变化写进 changes。你看到的【角色档案库】是插件维护的当前真值，**画面 tag 必须照抄库里的字段值**。
2. **挑选值得配图的画面**：在本楼正文里选出最有画面价值的片段，为每一段写出图像提示词。

工作纪律：
- 你只负责"这楼要不要图、要哪几张、角色状态怎么变"。你不负责改写正文、不负责决定工作流节点。
- 档案库里标记 \`[locked]\` 的条目属于用户主权区，**永远不要为它产生 change**，画面里照抄原值。
- 你不确定的角色外貌不要脑补。没有明确线索时，只写能从正文推出来的部分。
- 宁可少配图，不要为了凑数画出与剧情无关的画面。`;

export const DEFAULT_JAILBREAK = '';

/* ============ 默认配置 ============ */

function defaultTemplate(name = '默认') {
  return {
    name,
    /**
     * ★ v0.9.95 纠偏：这里原本硬编码 `'sd'`，而 spec 用的是 `DEFAULT_SPEC`
     *   —— 那个常量的第一行就是「# 一致性规范（Krea2 口径）」。出厂默认自相矛盾。
     *
     * 后果链（实测）：
     *   用户点「新建」模版 → addTemplate 复制当前模版 → 继承 `engine:'sd'`
     *   → activeEngine() 返回 'sd' → composePrompt 走**单串 tag 拼接**，
     *     且 anchorOf 把字段里的中文整段剥掉。
     *   用户自建的「Anime模型-TAG+自然语」就是这么标错的：名字写着自然语，
     *   实际走 SD 串接、中文全被清洗。
     *
     * engine 不只是「清洗口径」——它决定走哪条组装路径（K2 三明治 vs SD 串接），
     * 所以必须与 spec 的口径一致。DEFAULT_SPEC 是 Krea2 口径 → 这里就该是 'k2'。
     */
    engine: 'k2',
    system: DEFAULT_SYSTEM,
    spec: DEFAULT_SPEC,
    protocol: DEFAULT_PROTOCOL,
    jailbreak: DEFAULT_JAILBREAK,
  };
}

export function makeDefaultConfig() {
  return {
    version: CONFIG_VERSION,

    enabled: false,
    autoRun: true,
    carryFloors: 2,
    maxImagesPerFloor: 2,
    minImagesPerFloor: 1,
    genRetries: 1,
    minBodyLength: 80,
    includeUserFloors: true,

    /**
     * 剧场上下文 —— 决定「模型知不知道这段剧情里的人是谁」。
     *
     * 为什么必须有（对照实测出来的差距）：
     *   只把正文丢给模型，它连主角叫什么、长什么样、这个世界是什么规矩都不知道，
     *   只能凭正文那几百字脑补 —— 出图自然"跟剧情对不上"。
     *   把角色卡 / persona / 世界书拆成三条独立 system 消息压在规范之前的，
     *   绘灵原来只有「档案库 + 历史 + 正文」，缺的就是这一层。
     *
     * 三项都能单独关：长角色卡 + 大世界书会把请求撑大，小模型吃不消时按需关。
     */
    context: {
      /** 角色卡描述进请求（主角是谁、什么设定） */
      charCard: true,
      /** 用户 persona 进请求（"你"是谁） */
      persona: true,
      /** 世界书进请求（世界观 / 场景 / 专有名词） */
      worldBook: true,
      /** 每段上下文的截断上限（字符）。超出从头截断，保住开头的设定 */
      maxChars: 4000,
      /**
       * 思维链预填充：在请求末尾塞一条 assistant 角色的 `<thinking>`，
       * 强迫模型先过一遍检查清单再吐 JSON。
       * ⚠️ 默认关闭：deepseek-v4 / R1 系等推理模型收到这个预填充会把 max_tokens
       * 全烧在思维链上，只剩 reasoning_content、正文为空 —— 表现为"分析只回思考过程、
       * 正文空"，导致 0 出图，且每次分析白白多烧一次调用（重试）。
       * 非推理模型若想用，可在设置里把 thinking 显式开成 true。
       */
      thinking: false,
    },

    // ⚠️ 默认配置里不放具体模版（v0.9.11）：mergeDefaults 会把被删掉/改名的「默认」
    // 每次都原样加回来，模版重命名就永远改不掉第一套。改为在 getConfig 里
    // "一套都没有时才补一套默认"。
    templates: {},
    activeTemplate: '默认',

    /**
     * 画风（v0.9.182）。
     *
     * 出厂模版的 `## MOSS 单图口径补充` 里写死了两条画风示例
     * （`"meta": ["anime", …]` 与 `Clean anime line art, cinematic lighting…`），
     * 写词模型照抄示例 ⇒ 不管用户怎么调都是动漫线稿。
     * 这里换成可选档位，由 `stylePreset.js` 在**读取模版时**替换示例，不回写配置。
     *
     * ★ 默认 `preset` 留空 = **不改**，与升级前逐字一致（老用户出图零变化）。
     *   要改写实可以选 `real-cinema` / `real-photo`，或 `custom` 自己写。
     * ★ 这里只放「画风句 + meta 标签」。采样参数、负面词**一律不放** —— 那是用户主权。
     */
    style: {
      preset: '',
      customLine: '',
      customMeta: '',
    },

    /**
     * GAL 前端联动（v0.9.164）—— 让 GAL（IGS）借用绘灵的写词 + 出图。
     *
     * 为什么默认关：它要占用 `window.NaiDbGen` 这个**属于别人**的全局名。
     * 用户以后真装了 NaiDbGen 插件时，两边会抢同名（后加载的赢、且没有任何提示）。
     * 默认关 + 手动开，至少让"是我开的"这件事是明确的。
     *
     * 为什么不自己加第五条通道：GAL 的图像来源是
     * `Object.freeze(["nai","dbgen","extension","baibai"])` + 硬编码 if/else，
     * 没有注册位；要加只能 fork 它 6.6MB 的压缩 bundle。详见 `modules/galBridge.js` 文件头。
     */
    galBridge: {
      /** 总开关：打开后绘灵以 `window.NaiDbGen` 的身份对 GAL 提供写词与出图 */
      enabled: false,
      /**
       * 把 GAL 设置里那个选项的显示文字改成「绘灵」。
       * 只改 DOM 文案，**不碰它的逻辑**（它内部仍按 `dbgen` 走），GAL 更新也不会坏。
       */
      renameEntry: false,
    },

    /**
     * 「龙血玄黄·数据库」（shujuku）联动（v0.9.187）。
     *
     * 为什么接它：2026-11-01 实测，同一场戏（体育器材室 / 深夜）连出 3 张，
     * summary 全写成 `a dim classroom at night` 还自编课桌 —— 正文里「教室」0 次。
     * 而数据库的「全局数据表」里就存着「当前详细地点 / 当前时间」，
     * 「纪要表」里存着每段剧情的压缩摘要，「重要角色表」里存着在场状态。
     *
     * 只读、不写库；读不到就一个字都不加（编造地点比不注入更糟）。
     * 默认**开**：它只在能读到真值时才生效，读不到等于不存在。
     */
    sceneDb: {
      enabled: true,
      /** 注入「当前场景（地点 / 时间 / 地区）」 */
      scene: true,
      /** 注入「在场角色名单」 */
      cast: true,
      /** 注入「最近一段纪要」—— 跨楼延续的主要依据 */
      summary: true,
    },

    /**
     * 服装预设库：命名款式 → 具体描述。制式服装（校服/制服/OL）的共用资产。
     * 档案里 outfit 写 `@预设名` 即可引用；改预设 = 所有引用它的角色一起更新。
     */
    outfitPresets: defaultOutfitPresets(),

    consistency: {
      enabled: true,
      lockedProtected: true,
      /**
       * 锁定条目的保护级别：
       *   strict —— 只允许 state（临时状态）；换装、改锚点全部拒绝
       *   normal —— 允许 outfit（状态位推进 + 剧情内换装）；锚点字段仍禁止
       *   off    —— 不保护
       * 默认 normal：剧情生图里服装必然变化，全禁会让画面卡在初始着装。
       */
      lockLevel: 'normal',
      anchorHeal: true,
      outfitMachine: true,
      /**
       * 服装款式保护级别（治「校服每张图都不一样」）。
       * 默认 normal：允许补充式改写，拒绝偷换款式。
       * 校服 / 制服 / 标志性套装建议在档案里单独设为 strict。
       */
      outfitLock: 'normal',
      /** 款式漂移判定的相似度阈值：低于它视为「换款」而不是「补充」 */
      outfitDriftThreshold: 0.34,
      /** 制式服装细化：档案里的款式描述太笼统时，提示 AI 补全六要素 */
      outfitDetailHint: true,
      /**
       * v0.9.39 服装态扫描：生图前用一次轻量请求，从「本楼 + 最近 N 楼」正文里
       * 读出各在场角色**此刻穿着**并写进档案 —— 服装延续的写入端。
       * 关掉它就退回旧行为（服装只能靠出词模型主动报，实测基本不报）。
       *
       * 收窄规则：已记录服装且本楼正文没有换装动词的角色直接跳过，多数楼实际只扫 1–2 人。
       */
      outfitScan: true,
      /**
       * v0.9.47：服装扫描**专用**的历史窗口（楼）。
       *
       * 出图的 carryFloors 只要 2 楼（画面只需要接得上上一张），但服装态是
       * **跨楼延续**的 —— 只看 2 楼，模型判断不出"三楼前他脱了、这一楼穿回去没有"，
       * 于是只能沿用档案旧值（用户原话：「需要模型根据多楼正文分析」）。
       * 这里单独给一个更宽的窗口，不动全局 carryFloors。
       */
      outfitScanFloors: 5,
      /**
       * v0.9.52：一次服装扫描最多问几个人。
       *
       * 正文全是代词时 filterPresentSnapshot 会退回**全量档案**，实测一次 43 人；
       * 人多了既拖慢请求，也让模型在几十份档案里挑花眼。
       * ⚠️ 截断顺序是**按信号强度排过序的**（换装 > 状态变化 > 未建档 > 裸待跟踪 > 线索提到），
       *    所以被截掉的总是"最没戏"的那几个，不会出现"真在脱衣服的人被截在门外"。
       */
      outfitScanMax: 8,
      /**
       * v0.9.52：把**近期已出过的图**摘要回灌给分析请求。
       *
       * 在此之前模型从没见过自己上一张写了什么（`cleanBody` 把 `<hl_image>` 整块删、
       * `promptFull` 只写不读），规范里还明写「模型手里没有上一张」——
       * 于是同一段剧情连出两楼时，模型既判断不出重不重复，也不知道上一张已确立的事实
       * （衣服已经脱了、脸上已经有巴掌印）。这是「重复出图」和「服装长回来」的共同根因。
       *
       * 关掉它 = 退回 v0.9.51 及以前的行为。
       */
      recentImages: true,
      /** 回灌几张（只取 ≤ 当前楼的）。0 = 不回灌（等价于 recentImages:false）。 */
      recentImageCount: 3,
      /**
       * v0.9.47：同一套「新款」连续被剧情提到几楼才放行改写款式。
       *
       * 防漂移的初衷是挡住"模型每楼重新描述一遍"（一件校服出八个版本）。
       * 但剧情**直接改写服装**、又没写换装动词时（实测夜斗的灰色运动裤就是这么来的），
       * 闸门会永久锁死旧款 —— 这是"锁"与"随剧情变"的真正冲突点。
       * 折中：同一套具体衣服被反复提到 N 楼 → 认定是剧情改了设定，放行。
       * N=1 等于不设防（回到漂移老路），建议 2~3。
       */
      outfitStyleRepeatFloors: 2,
      /**
       * v0.9.72 · 让扫描模型顺手填「服装三维度」（状态细档 / 改造 / 鞋袜）。
       *
       * ★ 默认关 —— 这是**写权限**，不是显示开关：
       *   开了之后模型每楼都能改写这三个字段，而它们的英文文本是直接进画面的。
       *   裸露推进类剧情（细档）靠它省事，但风险也是真的：模型对"半脱/全裸"的判断
       *   一旦与正文有出入，画面会立刻穿帮。用户明确要求「要有开关，能关」，
       *   所以默认关，只有想偷懒的人才打开。
       *
       * 关着的时候：模型就算回了这三个字段也会被**静默忽略**（不入库、不进画面），
       * 三维度只能由档案页手动设定 —— 与 v0.9.69/70 的既有行为完全一致。
       */
      autoOutfitDims: false,
      refMode: 'expand',
      /**
       * 画面 tag 的建议长度上限。
       * 制式服装写全六要素后，一条校服描述就要 30+ 词，加上角色锚点很容易破 320。
       * Krea2 的文本编码器是 Qwen3-VL-4B，长描述完全吃得下 —— 上限给宽一点。
       */
      maxTagLength: 420,
    },

    /**
     * 出词通道 —— 「谁来想这张图画什么」。
     *
     * 三种模式，从省事到独立：
     *   follow   跟随酒馆主 API（generateRaw / generateQuietPrompt）。零配置，但主 API 挂了绘灵就哑。
     *   channel  用酒馆的「连接预设」（ConnectionManagerRequestService）。
     *            比 follow 多一层选择权，仍然共用酒馆的配置体系。
     *   custom   独立 API —— 绘灵自己直连一个 OpenAI 兼容端点，**完全不看酒馆的设置**。
     *            主对话用 A 家、出词用 B 家（或本地模型）是常见诉求；
     *            主 API 欠费/限流时也不至于让配图一起停摆。
     */
    llm: {
      mode: 'follow',
      channel: '',
      /** follow / channel 模式下的参数（custom 模式用自己的那一套，见 custom） */
      maxTokens: 4096,
      temperature: 0.4,
      timeoutSec: 120,

      /** 独立 API 当前正在编辑的那份参数 */
      custom: {
        baseUrl: '',
        apiKey: '',
        model: '',
        /** 0 = 不发送 max_tokens（o1 / gpt-5 系只认 max_completion_tokens，发了就 400） */
        maxTokens: 8192,
        temperature: 0.9,
        topP: 1,
        freqPenalty: 0,
        presPenalty: 0,
      },
      /** 命名预设表：{ 预设名: custom 同形状 } */
      presets: {},
      /** 下拉里当前选中的预设名（'' = 未命名/默认配置） */
      presetName: '',
      /** 模型列表缓存（点「获取」拉到的），只用于输入框建议 */
      modelCache: [],
    },

    activeBackend: 'comfyui',
    backends: {
      comfyui: {
        enabled: true,
        serverUrl: 'http://127.0.0.1:8186',
        workflowJson: '',
        model: '',
        vae: '',
        /**
         * CLIP / 文本编码器（CLIPLoader 的 clip_name）。
         * Krea2 用的是 Qwen2.5-VL 系；对应工作流里的 %clip%。
         * 与 model / vae 同一条纪律：留空则 %clip% 不注册 →
         * 残留占位符会被明确报出来（而不是把空串提交给 ComfyUI）。
         */
        clip: '',
        /**
         * CLIP **类型**（CLIPLoader 的 type），对应工作流里的 %clip_type%。
         *
         * 和 clip（文件名）是两个独立的下拉框：同一个 CLIP 文件在不同架构下
         * 要用不同的 type（qwen_image / wan / krea2 …），文件名对了 type 不对照样跑挂。
         * 留空 = 不注册（同 model / vae / clip 的纪律）：工作流里写了 %clip_type%
         * 却没填，会当场报「%clip_type% 没有值」，而不是提交一个空 type 让 ComfyUI 去炸。
         */
        clipType: '',
        clipSkip: -2,
        /**
         * 「跟随工作流」勾选状态（v0.9.88）。四项各自独立：
         * 勾上的种类**不改成占位符** —— 导入/AI 适配时保留工作流里的原值
         * （Checkpoint 自带 VAE/CLIP 的场景），并把原值记录进 wfDefaults。
         * 出图时若工作流里仍是占位符，回落到 wfDefaults 的记录值。
         */
        followWorkflow: { model: false, vae: false, clip: false, clipType: false },
        /** 工作流原值记录（导入/AI 适配时从加载节点里抠出来的硬编码值）。 */
        wfDefaults: { model: '', vae: '', clip: '', clipType: '' },
        /**
         * 工作流模版预设（v0.9.88）：{ 预设名: 快照 }。
         * 快照 = 一整套本地生成配置（工作流 JSON + 模型/VAE/CLIP + 采样参数 + LoRA + 跟随标志），
         * 切预设 = 整套换 —— Krea2 工作流和 Checkpoint 工作流需要的资源组完全不同，
         * 只换 JSON 不换资源组，切换后必然跑挂。
         */
        presets: {},
        /** 当前选中的预设名（'' = 未存为预设的当前配置）。 */
        presetName: '',
        loras: [],
        steps: 8,
        cfg: 1,
        sampler: 'euler',
        scheduler: 'simple',
        width: 832,
        height: 1216,
        negative: 'worst quality, lowres, blurry, watermark, text, extra fingers, deformed hands',
        timeoutSec: 180,
        /**
         * nl 兜底：工作流里没有 %nl% 占位符时，把中文自然语言描述追加到提示词末尾。
         * 默认开 —— 关掉的话，工作流没预留 %nl% 就会把整段中文描述静默丢弃
         * （Krea2 的 Qwen 编码器最吃这块，丢了画面会明显变呆）。
         */
        nlFallback: true,
        /**
         * 画质增强面板值（v0.9.108）：只存**用户改过的字段**，按节点 id 分桶。
         * `{ dlss: { enabled, nodes: { "7": { nr_intensity: 2 } } }, mask: {…} }`
         *
         * 为什么不把工作流现值抄进来：换了工作流后节点 id 全变、参数含义也变，
         * 抄一份旧值进去＝新工作流静默带上旧参数。这里留空，面板显示时
         * 现读工作流现值（`detectEnhance`），用户不动就永远不写配置。
         */
        enhance: { dlss: { enabled: true, nodes: {} }, mask: { enabled: true, nodes: {} } },
      },

      /**
       * NovelAI —— 云后端之一。
       *
       * 默认 enabled: false，逼用户「先填 Key 再打开」：
       * 一个没配好的后端被误当成生效后端，只会让每张图都失败一次。
       * 尺寸默认 832×1216（NAI 最常用的竖构图），采样器与步数用官方推荐值。
       */
      nai: {
        enabled: false,
        /** 官方 https://api.novelai.net；第三方兼容站填它给的地址 */
        serverUrl: 'https://api.novelai.net',
        apiKey: '',
        model: 'nai-diffusion-4-5-full',
        sampler: 'k_euler_ancestral',
        steps: 28,
        /** CFG（NAI 叫 scale） */
        scale: 5,
        cfgRescale: 0,
        noiseSchedule: 'karras',
        /** variety boost —— 打开会顺带启用 skip_cfg_above_sigma 计算 */
        varietyBoost: true,
        /**
         * 质量词开关。关掉 = 完全不加（Krea2 口径的"禁质量词"玩家会用得上）；
         * 打开但留空 = 按模型取官方词（见 nai.js 的 QUALITY_TAGS）。
         */
        useQualityTags: true,
        qualityTags: '',
        width: 832,
        height: 1216,
        /** 0 = 每张随机（NAI 的种子是 32 位无符号） */
        seed: 0,
        /** 留空 = 按模型取官方 Heavy 负面词 */
        negative: '',
        timeoutSec: 180,
      },

      /**
       * OpenAI 兼容图像 API —— 覆盖面最广的一个。
       *
       * 「兼容」实践中意味着字段收不收各有脾气，所以这套默认值刻意都是
       * 「能不传就不传」：quality / responseFormat / outputFormat 默认空，
       * size 给一个 gpt-image-1 认的值。要额外字段走 extraBody。
       */
      openai: {
        enabled: false,
        serverUrl: 'https://api.openai.com/v1',
        apiKey: '',
        model: 'gpt-image-1',
        /** 留空 = 不传 size（用端点默认）；gpt-image-1 竖版是 1024x1536 */
        size: '1024x1536',
        /** 留空 = 不传（gpt-image-1 认 low/medium/high，dall-e-3 认 standard/hd） */
        quality: '',
        count: 1,
        /** 'auto' = 不传 response_format（gpt-image-1 不接受这个字段） */
        responseFormat: 'auto',
        /** 留空 = 不传（gpt-image-1 可指定 png/jpeg/webp） */
        outputFormat: '',
        /** 图像 API 没有负面通道，只能塞进正向；'off' 则完全不发 */
        negativeMode: 'avoid',
        /** 额外请求参数（JSON）。给中转站补私有字段用，能覆盖上面任何一项 */
        extraBody: '',
        timeoutSec: 180,
      },
    },

    /** 从 ComfyUI 拉到的资源清单缓存（避免每次开面板都请求） */
    resourceCache: { at: 0, models: [], unet: [], loras: [], vae: [], clips: [], clipTypes: [], samplers: [], schedulers: [] },

    /**
     * 渲染层。图片怎么出现在聊天里。
     *
     *   inline —— 段落级：图直接顶掉出图位（在它所属那一段的下面）
     *   media  —— 消息级：走酒馆原生 extra.media，图排在消息尾部，可用原生切换/放大 UI
     *   off    —— 不出图，只保留出图位文本（调试用）
     *
     * 默认 inline：剧情生图的语义是"这一段发生了这件事"，图必须贴着段落。
     */
    render: {
      mode: 'inline',
      /** 出图位还没出图时，显示占位框（而不是一片空白） */
      showPending: true,
      /** 占位框上带「重生成」按钮 */
      retry: true,
      /** 图片最大高度（px）；0 = 不限，用 CSS 里的默认值 */
      maxHeight: 0,
      /**
       * 正文里图片的默认显示宽度（%，相对消息宽度）。
       * 单张图还能用图片上的悬浮工具条 / 右下角把手单独调，互不影响。
       */
      defaultScale: 70,
      /** 一张图出多张时全部显示，还是只留第一张 */
      allImages: false,
    },

    /**
     * 图片归档：出完图立刻把图片存到酒馆自己的 user/images/绘灵_<角色>/ 下。
     *
     * 为什么默认开：ComfyUI 的 /view 是临时地址，重启或清 history 后原图就 404 了，
     * 存档过几天回来就满屏破图。归档后 <img> 指向 /user/images/...，永久有效。
     * 关掉它 = 图只活在 ComfyUI 的输出目录里。
     */
    storage: {
      archive: true,
    },

    /**
     * 界面外壳。绘灵的主体界面是一个独立的窗口（不再挤在扩展设置那个窄栏里），
     * 这里控制「怎么把它调出来」以及悬浮球的形态。
     *
     * 三条入口互相独立，都开也行、只留一个也行：
     *   topbar —— 酒馆顶栏插一个绘灵图标（挨着「用户设定管理」，跟原生按钮同款）
     *   menu   —— 魔杖菜单（🪄）里加一项「绘灵」
     *   orb    —— 屏幕边缘悬浮球，可拖动、贴边半隐、hover 滑出
     *
     * 窗口自身的宽高、上次停留的页签属于纯本机视觉态，存 localStorage 不入配置
     * （各设备屏幕尺寸不同，同步过去反而会跑到屏幕外）。
     */
    ui: {
      topbar: true,
      menu: true,
      orb: false,
      /** 悬浮球基准尺寸（px） */
      orbSize: 46,
      /** 悬浮球静止不透明度（%） */
      orbOpacity: 60,
    },

    globalPrefix: '',
    globalSuffix: '',
    globalNegative: '',

    /**
     * 中文描述（nl）是否送进生图。
     *
     * 开（默认）：出图提示词 = 英文 tag 串 + 中文自然语言描述。
     *   Krea2 的文本编码器是 Qwen 系，中文理解远好于英文 tag 堆叠 ——
     *   带上它画面氛围才出得来（构图/光线/情绪这些 tag 说不圆的部分）。
     * 关：只发英文 tag 串，画面偏"标签堆砌"、氛围变呆。
     *   想对比「中文到底有没有用」时，这是最快的 A/B 开关。
     *
     * 注意：它管的是**要不要把中文送进生图**，不影响悬浮框里继续显示中文
     * （那段中文是存档的一部分，关掉只是不参与出图）。
     */
    nlEnabled: true,

    /**
     * 档案页「SD 服装 tag」自动转换（v0.9.99）。
     *
     * 开启后：保存角色档案时，若「SD 口径专用 · 服装 tag」还是空的、
     * 而上面的 K2 服装描述有内容，就用分析模型自动转成 danbooru 短 tag 并落库
     * —— 省掉每张卡都要手动点一次「✨ 把 K2 描述转成 SD tag」。
     *
     * ★ 只在 SD tag **为空**时动手：用户手填过的内容绝不被覆盖
     *   （人设与服装是主权区，AI 只能补空缺，不能改已写的）。
     */
    autoSdOutfit: false,

    /**
     * SD 口径专属输出开关（v0.9.96）。
     *
     * ★ K2 口径**完全不读**这里 —— K2 禁写人数词（v0.9.65：错误声明比没有更有害），
     *   两个口径的结构是两代实现，不能共用一套开关。
     */
    sdOptions: {
      /** 按出场角色输出人数词（1girl / 1boy），写在该角色锚点串最前 */
      countTags: true,
      /**
       * 段间插入 BREAK（用换行分隔每个角色段）。
       * ⚠ 原生 CLIPTextEncode 把 BREAK 当普通单词（实测切出 `break</w>`），
       *   只有 ComfyUI-Easy-Use / Impact-Pack 的编码节点才认 → 默认关。
       */
      breakSeparator: false,
      /** 排除动态字段（状态 / 情绪 / 动作 / 表情）—— 防上一楼动作钉进静态锚点 */
      excludeDynamic: true,
    },

    /**
     * MOSS-Image 口径专属设置（v0.9.117）—— 只在该口径下被读取。
     *
     * 用户 2026-10-21 原话：
     *   「就是跑正文剧情，然后根据正文剧情出多格漫画或者单格漫画，最好单格和多格可以做个
     *     UI接口切换最好，其中多格漫画希望支持多种漫画格排版方式+随机模式，
     *     这样出来的剧情漫画格才不会显得单调单一」
     *
     * 为什么需要显式排版：官方方法论文档（MOSS酒馆生图模型/交接/方法论_多格漫画做法说明.md）
     * 实测结论 —— **不写格子类型，模型不会随机发挥，它会均分**（四格 = 2×2）。
     * 所以「不指定」等于「永远同一个版式」，「随机」才是解决单调的手段。
     *
     * mode:   'auto' 按正文自己判断要不要拆格 / 'multi' 每张都拆 / 'single' 只画单幅
     * layout: 'random' 每张换一种 / 'auto' 交给模型（会均分）/ 具体 key（MOSS_LAYOUTS）
     */
    moss: {
      mode: 'auto',
      /** 默认随机 —— 用户要的就是「不要单调单一」；选 'auto' 才是旧行为 */
      layout: 'random',
      /** 剧情模式（v0.9.127）：'auto' 沿用「成人画面优先」开关，行为与旧版一字不差 */
      nsfw: 'auto',
    },

    /**
     * MOSS **JSON Layout 版**专属口径（v0.9.122）。
     *
     * ★ 为什么必须与上面 `moss` 分开存：
     *   两个版本是**并存的两种输出格式**（用户原话：「一个纯 prompt，一个 JSON。
     *   简单的用纯 prompt，复杂就能切 JSON 生图」）。形态/排版存在同一份里，
     *   切版本时就会互相带走 —— 用户最怕的「切回来发现全变了」。
     *   ⇒ 各存一份，切版本互不影响（`cfg.moss` 只服务纯 prompt 版）。
     *
     * mode  : 'auto' | 'multi' | 'single'  —— 与纯 prompt 版同义
     * layout: 'random' | 'auto' | MOSS_LAYOUTS[].key
     * gword : 全局词库「前缀 / 后缀」在 Layout 下往哪放
     *         'caption'（默认，并进 summary.caption）
     *         'off'    （不并 —— 前缀若是 SD 式 tag 串，塞进自然语 caption 只会污染）
     */
    mossJson: {
      mode: 'multi',
      layout: 'random',
      gword: 'caption',
      /** 剧情模式（v0.9.127）：与纯 prompt 版各存一份，切版本互不影响 */
      nsfw: 'auto',
      /**
       * 漫画页版式（v0.9.140）：`'random'` 或 `MANGA_LAYOUTS[].id`。
       * 只对「剧情演完（coverMode）」生效 —— 那条路径的坐标出自
       * `mossMangaLayouts.js` 的版式库，不再由模型算。
       */
      mangaLayout: 'random',
      /**
       * 叙述者（v0.9.141）：正文用第一人称「我」叙述时，**「我」在角色档案里是谁**。
       *
       * ★★★ 只能由设置提供，不能让模型猜：
       *   2026-10-28 第一楼实测，10/10 页把 `narrator` 填成 `"我"` ——
       *   那一楼正文里男主从头到尾没被点名，模型根本无从得知他叫「夜斗」。
       *   而这一楼同时有 3 个男性（主角 / 阿宅君 / 巡查员），任选一个都可能给别人上脸。
       *   ⇒ 空着时不注入（安全），填了就按这个名字注入外貌与服装。
       */
      narrator: '',
      /**
       * 单图是否画文字台词（v0.9.158，默认 **true**）。
       *
       * 关 = 这一张图里**一个文字的框都不出现**（对白气泡与拟声词都不出）。
       * 只对单图 JSON / 纯 prompt 口径生效 —— 多格漫画页靠气泡交代剧情，不给这个开关。
       *
       * ★ 双层生效，缺一层就会「模型写了照样画」：
       *   ① 指令层（`buildMossSingleJsonDirective`）省掉这整段活，少写就少画；
       *   ② **代码层**（`singleJsonPrompt`）把所有 `label:'text'` 项直接丢弃 ——
       *      模型不听指令写了 text 项，出图也不会带上。
       *      记忆：「能让代码算死的就别靠模型听话」，此前面板开关默认可改不生效已栽过。
       */
      textBubble: true,
    },

    /** 出图气泡通知（SD 助手式 toastr）：开始/成功/失败都弹。false 关掉。 */
    notify: true,

    showTags: 'fold',
    autoRegen: false,
    keepHistory: true,
    registerRegex: true,

    /**
     * 图位外移（v0.9.76 引入，v0.9.77 开关化，默认开）。
     *
     * 开（默认）：注册 2 条搬运正则，把 <now_plot> 块内的出图槽搬到块外 →
     *     图显示在楼层顶部（美化正文上方）。
     * 关：槽留在正文原位。⚠ 实测（2026-10-10 创世回廊5.3）：该卡美化模板会把
     *     整段正文连同槽一起塞进 iframe 的 srcdoc 属性 —— 占位符脱离页面文本树，
     *     绘灵渲染器（TreeWalker 宿主文本节点）找不到它 → 图**完全不显示**。
     *     也就是说「图内联在剧情里」与「正文美化」在这类卡上互斥。
     * 什么时侯能关：换用了不把正文塞 srcdoc 的美化模板（或关美化）且想让图回到
     *     正文对应位置时。关掉后启动会自动清掉这 2 条持久化规则。
     */
    moveSlotsOutOfNowPlot: true,

    /**
     * 成人画面优先（v0.9.82，默认关）。
     * 开：给分析模型的指令末尾追加一段「成人画面优先」—— 判定放宽（明确性行为/隐私部位裸露
     *     即按成人画面处理）、配图名额优先给正在发生的动作、姿态必须写实
     *     （器官+部位+方向一次写死、必写插入方向与 hips aligned、禁止模糊动词）。
     *     背景：模型在成人情节上会自我降级，把动作写成 working between her thighs 这类
     *     委婉动词，画面因此与正文对不上（2026-10-10 实测病例 P91/P68）。
     * 关：完全不追加任何内容，行为与 v0.9.81 及之前一致。
     */
    adultPosePriority: false,

    /**
     * iframe 域渲染（v0.9.78，默认开）。
     *
     * 美化脚本会把正文搬进 srcdoc iframe 显示，出图槽跟着脱离宿主文本树。
     * 开：渲染时也扫 iframe 内部文档，把图渲染到 iframe 里的剧情位置
     *     —— 配合「图位外移」关掉，图就回到正文原位而不是堆在楼顶。
     *     图框元素用 iframe 自己的 document 造；悬浮工具条/缩放把手不进 iframe
     *     （它们的监听绑在宿主 document 上，跨文档会失效），点击图片开灯箱照常。
     * 关：完全按老办法只认宿主文档（出问题时的回退开关）。
     */
    renderInsideIframe: true,
  };
}

/* ============ 读写 ============ */

export function getSTContext() {
  try {
    return globalThis.SillyTavern?.getContext?.() ?? {};
  } catch {
    return {};
  }
}

/** @returns {object} 配置根对象（不存在则创建） */
export function settingsRoot() {
  const ctx = getSTContext();
  const es = ctx.extensionSettings;
  if (!es) {
    warn(STAGE.INIT, 'extensionSettings 尚不可用，使用内存兜底配置');
    if (!globalThis.__huilinFallbackRoot) globalThis.__huilinFallbackRoot = {};
    return globalThis.__huilinFallbackRoot;
  }
  if (!es[HUILIN_KEY] || typeof es[HUILIN_KEY] !== 'object') es[HUILIN_KEY] = {};
  return es[HUILIN_KEY];
}

export function saveSettings() {
  try {
    const ctx = getSTContext();
    if (typeof ctx.saveSettingsDebounced === 'function') ctx.saveSettingsDebounced();
    else if (typeof ctx.saveSettings === 'function') ctx.saveSettings();
  } catch { /* 静默：保存失败不阻断流程 */ }
}

/** 深合并：对象递归，数组整体替换。 */
function mergeDefaults(target, defaults) {
  for (const k of Object.keys(defaults)) {
    const dv = defaults[k];
    const tv = target[k];
    if (dv !== null && typeof dv === 'object' && !Array.isArray(dv)) {
      if (tv === null || typeof tv !== 'object' || Array.isArray(tv)) target[k] = {};
      mergeDefaults(target[k], dv);
    } else if (tv === undefined) {
      target[k] = Array.isArray(dv) ? dv.slice() : dv;
    }
  }
  return target;
}

/**
 * 取配置（自动补默认值 + 迁移）。
 * @param {boolean} strict 为 true 时返回引用（可改），false 时返回引用（只读用）
 */
/**
 * 「GAL 接管中吗」—— **全插件唯一判据**（v0.9.169）。
 *
 * ★ 放在 settings.js 而不是 galBridge.js：`galBridge.js` 依赖本模块，
 *   反向 import 会成环；而这条判据只需要读配置，放在这里零风险，
 *   任何模块（scanner / pipeline / UI）都能直接引用同一份。
 *
 * ★ 为什么必须唯一：关掉开关时绘灵要**一模一样回到原行为**（自动分析重新扫、
 *   重新写 <hl_image>、画布与画师串全用自己那套）。判据一旦散落成
 *   `cfg.galBridge?.enabled` / `!!g.enabled` 好几份，漏一处就会留下
 *   「关了但某个功能还按 GAL 跑」的混合状态 —— 这是最难查的故障。
 */
export function galTakeover(cfg) {
  const c = cfg || getConfig();
  return c.galBridge?.enabled === true;
}

export function getConfig() {
  const root = settingsRoot();
  if (!root.config || typeof root.config !== 'object') root.config = {};
  migrate(root);
  inferLlmMode(root.config);
  // 出厂预设「播种一次」语义（v0.9.55）：mergeDefaults 是深合并，outfitPresets
  // 里的出厂键被用户删掉后会在下一次 getConfig 复活 —— 批量删除出厂预设等于失效。
  // 打标 presetsSeeded 后不再回填：删了就是删了。老存档首次走到这里时补打标。
  const defaults = makeDefaultConfig();
  if (root.config.presetsSeeded === true) defaults.outfitPresets = {};
  mergeDefaults(root.config, defaults);
  if (root.config.presetsSeeded !== true
    && root.config.outfitPresets && Object.keys(root.config.outfitPresets).length) {
    root.config.presetsSeeded = true;
  }
  // 模版一套都没有（新装 / 被清空）才补出厂四套 —— 不能放进 makeDefaultConfig，
  // 否则 mergeDefaults 会把用户删掉/改名的模版每次都复活。
  if (!root.config.templates || typeof root.config.templates !== 'object'
    || Object.keys(root.config.templates).length === 0) {
    root.config.templates = {
      默认: defaultTemplate('默认'),
      'K2 中英混合': defaultK2Template('K2 中英混合'),
      'K2 中英混合（带风格化）': defaultK2StyledTemplate('K2 中英混合（带风格化）'),
      'K2 纯英文单段': defaultK2EnglishTemplate('K2 纯英文单段'),
    };
    if (root.config.activeTemplate !== 'K2 中英混合' && root.config.activeTemplate !== 'K2 中英混合（带风格化）') {
      root.config.activeTemplate = '默认';
    }
  }
  healMissingModel(root.config);
  seedResolutionSelector(root.config);
  return root.config;
}

/**
 * 「分辨率选择器」开关的**一次性播种**（v0.9.104）。
 *
 * 为什么不能写成固定默认值：默认该开还是关，取决于**用户工作流里有没有那个节点**。
 *   有 → 默认 **开**（参数抄工作流现值）→ 升级后出图分辨率**完全不变**，不会突然从 888×1184 跳到 960×1280
 *   无 → 默认 **关** → 继续用手填宽高（也是原来的行为）
 *
 * 播种一次之后它就是普通配置字段，用户怎么改就是什么（再也不会被这里覆盖）。
 */
export function seedResolutionSelector(cfg) {
  const be = cfg?.backends?.comfyui;
  if (!be || typeof be !== 'object') return;
  if (be.resSelector && typeof be.resSelector === 'object') return;

  const det = detectResolutionSelector(be.workflowJson);
  be.resSelector = {
    enabled: det.found,
    aspect: det.aspect || RES_DEFAULTS.aspect,
    megapixels: Number.isFinite(det.megapixels) ? det.megapixels : RES_DEFAULTS.megapixels,
    multiple: Number.isFinite(det.multiple) ? det.multiple : RES_DEFAULTS.multiple,
  };

  if (det.found) {
    info(STAGE.INIT, `工作流里有分辨率选择器（节点 ${det.selectorIds.join('/')}）：`
      + `已按现状播种「用选择器」= 开（${det.aspect} / ${det.megapixels}MP / ${det.multiple} 倍）`);
  }
}

/**
 * 启动时自愈「模型名空着」这个断点。
 *
 * 真实事故：出词通道=独立 API，用户点过「获取」（modelCache 里躺着 172 个模型名），
 * 但 custom.model 一直是空串 —— api.js 在 custom 模式下发现没模型名就直接放弃请求，
 * 管线只留一句「模型返回了空内容」。结果是 15 个楼层 results 全空，
 * 用户视角 = "跑剧情不出图、之前做的功能全是摆设"。
 *
 * 既然已经拉到过模型列表，就替用户选上第一个并明说。这不是擅自改设定：
 * 出词模型是通道参数，不是角色人设；而且改完会往诊断面板留一条记录。
 */
function healMissingModel(cfg) {
  const llm = cfg?.llm;
  if (!llm || llm.mode !== 'custom') return;
  const custom = llm.custom;
  if (!custom || String(custom.model || '').trim()) return;
  const cache = (llm.modelCache || []).filter(Boolean);
  if (!cache.length) return;

  custom.model = cache[0];
  info(STAGE.INIT,
    `出词模型原本是空的（独立 API 会因此直接放弃请求），已从已拉取的模型列表里自动选上「${cache[0]}」`);
}

/**
 * 补「出词通道」的 mode。
 *
 * v0.6.2 之前没有 mode 这个概念，只有 llm.channel 一个字段：
 * 填了就用连接预设，没填就跟随主 API。补默认值时必须把旧语义继承过来 ——
 * 否则老用户升级后，配好的预设会**静默失效**（mode 默认为 follow 就不再走它），
 * 而界面上显示的偏偏就是「跟随酒馆主 API」，看起来完全正常，根本无从归因。
 *
 * 刻意在 mergeDefaults **之前**调用：只有此刻 mode 还是 undefined，
 * 才分得清「用户没选过」和「用户选了 follow」。
 */
function inferLlmMode(cfg) {
  const llm = cfg?.llm;
  if (!llm || typeof llm !== 'object') return;
  if (llm.mode !== undefined) return;
  llm.mode = String(llm.channel || '').trim() ? 'channel' : 'follow';
}

/* ============ 模板内容升级 ============ */

/** 旧版 SPEC 独有的句子（新版已改掉）—— 用它识别"内容还是出厂默认"的模板。 */
const SPEC_OLD_MARK = '而不是照抄那个笼统值';
/** 新版 SPEC 独有的小节标题 —— 用它识别"已经升级过"。 */
const SPEC_NEW_MARK = '### 3.1 分工';
/** 本轮（双人分段骨架）升级后 §3.6 独有的短语 —— 识别"已是最新"。 */
const MULTI_MARK = '双人错乱重灾区';

/** 从一段 spec 文本里截出 §3.6 小节全文（到 ### 3.7 之前）。 */
function specSection36(text) {
  const m = /### 3\.6 多人画面[^\n]*\n[\s\S]*?(?=### 3\.7 )/.exec(String(text || ''));
  return m ? m[0] : '';
}

/**
 * 把出厂默认模板升级到当前版本。
 *
 * 为什么需要：模板文本会**存进用户的 settings.json**（cfg.templates 里有一份副本），
 * getActiveTemplate 优先用那份副本 —— 只改代码里的 DEFAULT_SPEC 常量对老用户不生效。
 *
 * 升级分两档，尽量不动用户自己的内容：
 *   ① 已是上一版结构（含 3.1 分工）但 §3.6 还是旧多人规范 → **只定点替换 §3.6 小节**，
 *      其余部分（用户可能改过）原样保留；
 *   ② 更老的版本（含旧标记）→ 整篇替换为最新默认。
 * 用户自己改过对应文本、标记匹配不上的一律不动。
 *
 * @returns {string[]} 被升级的模板名
 */
export function upgradeTemplates(root) {
  const templates = root?.config?.templates;
  if (!templates || typeof templates !== 'object') return [];
  const upgraded = [];
  const fresh36 = specSection36(DEFAULT_SPEC);
  const FIELD_MARK = '穿戴物件一律写 `mark`';   // 字段归属说明的版本标记
  const FIELD_OLD = '- `changes[].position`：`set` 类必填，写生效起点的段落 ID（如 `P4`）。';
  const FIELD_NEW = [
    '- 字段归属（2026-09-26 起严格执行）：',
    '  - `face` 只写**面容类型 / 年龄段**：loli face / young face / mature face / oval face。',
    '  - **眼镜、眼罩、帽子、耳机、口罩等穿戴物件一律写 `mark`**，不要写 face 或 eyes；',
    '  - `hair` 只放发型/发色/长度，瞳色写 `eyes`。',
    '- `changes[].position`：`set` 类必填，写生效起点的段落 ID（如 `P4`）。',
  ].join('\n');
  /**
   * ★★★ v0.9.186：**注册两个「漫画台」模版**（照搬 AINIMA 漫画台）。
   *
   * 只补缺、不覆盖：用户已经建过同名模版（可能自己改过）就一律不动 ——
   * 提示词是用户主权区，迁移不能拿出厂文本把他的手改冲掉。
   *
   * ★ **不能并进 `upgraded`**：那个数组的语义是「本次**刷新过文本**的模版」，
   *   新增模版不是刷新。混进去会污染调用方的日志，也会让按这个名字做断言的测试失败
   *   （`spec36-test` ②-a1 当场抓到）。
   */
  ensureMangaTemplates(root);
  for (const [name, t] of Object.entries(templates)) {
    if (!t || typeof t !== 'object') continue;
    /**
     * ★★★ v0.9.117：MOSS 口径模版不归这里管。
     *
     * 下面那句 `if (!s) { t.spec = DEFAULT_SPEC; }` 会把「用户主动清空的 spec」
     * 填成 **Krea2 口径**原文 —— 这正是用户 2026-10-21 报的
     * 「一致性规范删掉改动后点保存还是会还原」的第二个根因（第一个是
     * getActiveTemplate 的空串回落）。MOSS 的口径文本与 DEFAULT_SPEC 完全不同，
     * 填错口径比留空更糟：模型会按 Krea2 分段写法出词，MOSS 根本不认。
     */
    if (t.engine === 'moss') continue;
    let s = String(t.spec || '');
    if (!s) { t.spec = DEFAULT_SPEC; upgraded.push(name); continue; }
    let touched = false;
    // 定点升级②：字段归属说明（face/mark 分工）—— 只插行，不动其它内容
    if (s.includes(FIELD_OLD) && !s.includes(FIELD_MARK)) {
      s = s.replace(FIELD_OLD, FIELD_NEW);
      touched = true;
    }
    if (s.includes(SPEC_NEW_MARK)) {
      if (s.includes(MULTI_MARK)) {
        if (touched) { t.spec = s; upgraded.push(name); }
        continue;                                      // 已是最新
      }
      const old36 = specSection36(s);
      if (!fresh36 || !old36) {
        if (touched) { t.spec = s; upgraded.push(name); }
        continue;                                      // §3.6 被用户改得认不出了，不动
      }
      t.spec = s.replace(old36, fresh36);
      upgraded.push(name);
      continue;
    }
    if (touched) { t.spec = s; upgraded.push(name); continue; }
    // 更老的出厂版本：只有"未被改动过"才整篇替换
    if (!s.includes(SPEC_OLD_MARK)) continue;
    t.spec = DEFAULT_SPEC;
    upgraded.push(name);
  }
  return upgraded;
}

/**
 * ★★★ v0.9.160：MOSS 出厂模版的**文本级刷新**。
 *
 * ── 为什么必须有这个函数 ──────────────────────────────────────────────
 * `upgradeTemplates` 开头是 `if (t.engine === 'moss') continue;` —— 它**故意**跳过 MOSS，
 * 理由是那里会给空 spec 填 Krea2 口径的 `DEFAULT_SPEC`（填错口径比留空更糟）。
 * 但那个 `continue` 把「文本演进」也一起挡掉了：
 *
 *   病例（真实发生）：v0.9.159 把「超 10 字拆成多个 text 项」改成官方口径
 *   「一句 = 一个 text 项 + `\n` 折行」，`defaultMossSingleJsonTemplate()` 全部改对，
 *   而用户 `settings.json` 里存的是**旧 spec** ⇒ 面板上看到的、真正发给模型的
 *   全是旧规则，**改动等于没生效，而且不报错**。
 *   （这就是「修了但用户说没变化」的老形态：同一事实有渲染层与迁移层两条写入路径。）
 *
 * ── 判定口径 ─────────────────────────────────────────────────────────
 * 只认**旧版出厂标志串**：认得出「这还是出厂原文的旧版」才替换，
 * 认不出（用户重写过）一律不动 —— 提示词属于用户主权区。
 *
 * @returns {string[]} 被刷新的模版名
 */
/**
 * v0.9.186：补齐两个「漫画台」模版（只补缺，不覆盖用户改过的）。
 * 两条迁移路径都会调用：`upgradeTemplates`（版本已最新）与
 * `refreshMossFactoryTemplates`（版本要升级）。任何一个先跑都能得到同样的结果。
 */
export function ensureMangaTemplates(root) {
  const templates = root?.config?.templates;
  if (!templates || typeof templates !== 'object') return [];
  const added = [];
  for (const [nm, mode] of [['MOSS漫画台(多格JSON)', 'multi'], ['MOSS漫画台(单图JSON)', 'single']]) {
    if (templates[nm] && typeof templates[nm] === 'object') continue;
    templates[nm] = defaultMossMangaTemplate(nm, mode);
    added.push(nm);
  }
  return added;
}

export function refreshMossFactoryTemplates(root) {
  const templates = root?.config?.templates;
  if (!templates || typeof templates !== 'object') return [];
  ensureMangaTemplates(root);
  const out = [];
  for (const t of Object.values(templates)) {
    if (!t || typeof t !== 'object' || t.engine !== 'moss') continue;
    /**
     * ★★★ v0.9.186：**漫画台口径不参与这套旧标志刷新**。
     *
     * 它刚出厂、没有历史包袱；而这里的判据是按「口径标题」二选一
     * （`单图规范` / `JSON 口径`），漫画台的标题是「漫画台口径规范」—— 两个都不命中，
     * 会掉进最后的 `else` 被 `defaultMossTemplate()`（纯 prompt 版）整份覆盖。
     * 一旦命中旧标志串（例如 `MOSS_BASE_PROTOCOL` 里恰好有），模版就当场变回纯 prompt，
     * 而且一声不响。显式挡住。
     */
    if (t.output === 'manga') continue;
    const s = String(t.spec || '');
    if (!s) continue;
    const name = t.name || '';
    /**
     * 口径按 **spec 首行标题**判，不按 `output` 字段 ——
     * `output` 是用户能改的（面板下拉），标题是出厂文本自带的，用来认「这是哪一套」更硬。
     */
    const head = (s.split('\n')[0] || '').trim();
    const isSingle = head.includes('单图规范');
    const isJson = /JSON\s*(?:Layout\s*)?口径/i.test(head);
    /**
     * ★★★ v0.9.161：旧标志必须**同时查 `spec` 和 `protocol`**。
     *
     * 病例（真实发生，v0.9.160 上线后自查发现）：
     *   多格 JSON 版的 `"width": 864` 与 `"meta": ["anime illustration"]` 写在
     *   **protocol** 的 JSON 示例里（第 47~49 行），`spec` 里一个字都没有
     *   （它的 spec 只有 10160 字的分镜规范，不含任何示例）。
     *   只看 spec ⇒ 判据永不命中 ⇒ **这份模版永远刷不到**，而且一声不响。
     *
     * 旧标志清单（任一命中即认为是出厂旧文本）：
     *   - `10 字` / `10 个字`：v0.9.158 及更早的台词字数预算
     *   - `"width": 864`：旧画布示例（1e6 估算的错误值）
     *   - `"meta": ["anime illustration"]`：把画风当体裁的旧 meta
     *   - `机位 / 景别` / `1girl, @角色名`：v0.9.162 前 protocol 里那段 K2 专属写法
     *     （**这一条必须单独列**：v0.9.161 已经把 spec 全刷成新口径、旧三条标志全清了，
     *      但 protocol 的 K2 基础段还在 —— 只看前三条的话这次修复永远命中不了，
     *      又是一次「改动零生效」）
     *   - `two lines, evenly spaced, comfortably legible` /
     *     `two lines of medium-weight Chinese characters`：v0.9.163 前**示例句里写死行数**的
     *     text caption 样例（模型照抄 `two lines`、代码再补「exactly 6 lines」⇒ 一句里两个行数）。
     *     **同样必须单独列**：v0.9.162 已把前六条全清干净，不加这两条这次又命中不了。
     * 反过来说：用户重写过、把这些都删了的，认不出 → 不动（提示词是用户主权区）。
     */
    const blob = s + '\n' + String(t.protocol || '');
    if (!/10 个字|10 字|"width"\s*:\s*864|"meta"\s*:\s*\[\s*"anime illustration"|机位 \/ 景别|1girl, @角色名|two lines, evenly spaced, comfortably legible|two lines of medium-weight Chinese characters/.test(blob)) continue;
    if (isSingle && isJson) {
      const fresh = defaultMossSingleJsonTemplate(name);
      t.system = fresh.system; t.spec = fresh.spec; t.protocol = fresh.protocol;
    } else if (isSingle) {
      t.spec = mossSinglePlainSpec();
      /**
       * ★ v0.9.162：**protocol 也要刷**。
       *
       * 这一套不是出厂注册模版（用户自建 / 复制来的），它的 protocol 仍是
       * `DEFAULT_PROTOCOL + MOSS_PROTOCOL_ADDON`，只改 spec 会留下与单图规范
       * 直接冲突的 K2 段（`@角色名`、`nl`、「机位 / 景别」）。
       * 只做那三处精确替换，`changes` 与其它内容原样保留（用户可能改过）。
       */
      if (String(t.protocol || '').trim()) t.protocol = applyMossProtocolPatches(t.protocol);
    } else if (isJson) {
      const fresh = defaultMossJsonTemplate(name);
      t.system = fresh.system; t.spec = fresh.spec; t.protocol = fresh.protocol;
    } else {
      const fresh = defaultMossTemplate(name);
      t.system = fresh.system; t.spec = fresh.spec; t.protocol = fresh.protocol;
    }
    out.push(name);
  }
  return out;
}

/**
 * 把**未被用户改写过**的出厂 K2 模版整篇刷新成当前版本（三套：plain / styled / en 单段）。
 * 判定口径：只看 spec 里那节标志性标题还在不在 —— 用户重写过的模版认不出就不动（人设主权区）。
 * ⚠️ 纯英文单段的标题是「### 3.2 四句骨架」，与中英混合的「### 3.1 分工与拼装顺序」不同，
 *    必须分两轮判定，否则单段模版会被整批漏刷（历史踩过）。
 * @returns {string[]} 被刷新的模版名
 */
function refreshK2FactoryTemplates(cfg) {
  const templates = cfg.templates && typeof cfg.templates === 'object' ? cfg.templates : {};
  const refreshed = [];
  for (const t of Object.values(templates)) {
    if (!t || t.engine !== 'k2') continue;
    const s = String(t.spec || '');
    let fresh = null;
    if (t.variant === 'en') {
      if (s.includes('### 3.2 四句骨架')) fresh = defaultK2EnglishTemplate(t.name || '');
    } else if (t.variant === 'plain' || t.variant === 'styled') {
      // ⚠️ NSFW 版必须**先于**普通版判定（v0.9.29）。
      //   NSFW 模版的 variant 同样是 plain / styled —— 若先走普通版分支，
      //   它会被 defaultK2Template 整篇覆盖，§3.9 NSFW 板块静默消失，
      //   用户只会觉得「出词怎么变回老样子了」，查不到原因。
      //   双重判定：新字段 nsfw（权威）+ spec 标志串（旧配置导入 / 字段丢失时兜底）。
      const isNsfw = t.nsfw === true || specLooksNsfw(s);
      if (isNsfw) {
        if (s.includes('### 3.1 分工与拼装顺序')) {
          fresh = defaultK2NsfwTemplate(t.name || '', t.variant === 'styled');
        }
      } else if (s.includes('### 3.1 分工与拼装顺序')) {
        fresh = t.variant === 'styled' ? defaultK2StyledTemplate(t.name || '') : defaultK2Template(t.name || '');
      }
    }
    if (!fresh) continue;   // 非出厂文本（用户重写过）不动
    t.system = fresh.system;
    t.spec = fresh.spec;
    t.protocol = fresh.protocol;
    // nsfw 标记一并回写 —— 兜底：从旧配置导入 / 字段丢失时，
    // 上面靠 spec 标志串认出它是 NSFW 版，这里把标记补回去，
    // 否则下一轮迁移就只剩标志串这一个凭据（字段始终缺着，容易在别处踩空）。
    if (fresh.nsfw) t.nsfw = true;
    refreshed.push(t.name || '(未命名)');
  }
  return refreshed;
}

function migrate(root) {
  const cfg = root.config || {};
  let v = Number(cfg.version) || 0;
  if (v === CONFIG_VERSION) {
    upgradeTemplates(root);   // 版本没变也要跑：模板文本会单独演进
    /**
     * ★★★ v0.9.160：这条早退分支**必须**也跑 MOSS 刷新。
     * 用户配置本来就是 v49（版本号没变），只改模版文本时根本走不到下面的分支 ——
     * 漏了这一句 = 改完对老用户依然零生效（这正是 v0.9.159 没生效的第二个原因）。
     */
    const mossFreshSame = refreshMossFactoryTemplates(root);
    if (mossFreshSame.length) {
      info(STAGE.INIT, `MOSS 模版文本已同步到当前版本：${mossFreshSame.join('、')}`);
    }
    return;
  }
  const changes = [];

  if (v < 1) {
    // v0 → v1：补齐一致性块与模版
    // 注意：activeTemplate 的校验不在这里做 —— 此时出厂 K2 模版还没注入，
    // 激活态指向它会被误重置（实测踩坑：activeTemplate='K2 中英混合' 的配置
    // 迁移后被悄悄改回「默认」，engine 口径全错）。校验统一挪到 migrate 尾部。
    if (!cfg.consistency) cfg.consistency = {};
    if (!cfg.templates || !Object.keys(cfg.templates).length) {
      cfg.templates = { 默认: defaultTemplate('默认') };
    }
    v = 1;
  }

  if (v < 2) {
    // v1 → v2：思维链预填充默认关闭（推理模型会因它只回思维链、正文空 → 0 出图）
    cfg.context = cfg.context || {};
    if (cfg.context.thinking === true) {
      cfg.context.thinking = false;
      changes.push('思维链预填充已默认关闭（推理模型会因它只回思维链、正文空 → 0 出图；非推理模型可在设置里开回）');
    }
    v = 2;
  }

  if (v < 3) {
    // v2 → v3：注入「K2 中英混合」两套出厂模版（2026-09-26 实测：中英混合遵循度最高；
    // 去风格化版风格走全局后缀，带风格化版保留画质/画风词）。
    // 只在迁移时注入一次 —— 此后用户删掉它不会被复活（v0.9.11 的 mergeDefaults 教训）。
    cfg.templates = cfg.templates && typeof cfg.templates === 'object' ? cfg.templates : {};
    // 出厂判定必须认 variant 字段 —— 用户自建的 K2 模版没有 variant，
    // 宽松判定（engine==='k2' 即算）会让自建模版挡住出厂 plain 注入（实测踩坑）。
    const hasPlain = Object.values(cfg.templates).some(t => t?.engine === 'k2' && t?.variant === 'plain');
    const hasStyled = Object.values(cfg.templates).some(t => t?.variant === 'styled');
    if (!hasPlain) {
      let name = 'K2 中英混合';
      let n = 2;
      while (cfg.templates[name]) name = `K2 中英混合 ${n++}`;
      cfg.templates[name] = defaultK2Template(name);
      changes.push('已注入出厂模版「K2 中英混合」（去风格化：风格走全局后缀）');
    }
    if (!hasStyled) {
      let name = 'K2 中英混合（带风格化）';
      let n = 2;
      while (cfg.templates[name]) name = `K2 中英混合（带风格化） ${n++}`;
      cfg.templates[name] = defaultK2StyledTemplate(name);
      changes.push('已注入出厂模版「K2 中英混合（带风格化）」（保留画质/画风提示词）');
    }
    v = 3;
  }

  if (v < 4) {
    // v3 → v4：K2 出词结构改成 v4 三明治（scene / 人物锚点段 / tag / mood 中英交错）。
    // 实测（2026-09-26 用户报告）：旧结构「英文串全在前 + 中文整段 nl 追加在末尾」
    // 权重顺序不对，肢体扭曲率明显升高 —— 必须按用户工作区 v4 定稿的段落顺序出词。
    // 出厂 K2 模版（variant plain/styled）的 spec/system/protocol 整体刷新为新版文本；
    // 用户自建的 K2 模版（无 variant 或已被重写）一律不动。
    const templates = cfg.templates && typeof cfg.templates === 'object' ? cfg.templates : {};
    const refreshed = [];
    for (const t of Object.values(templates)) {
      if (!t || t.engine !== 'k2') continue;
      if (t.variant !== 'plain' && t.variant !== 'styled') continue;
      // 出厂文本识别：旧版 §3.1 是「tag+nl 二分工」，新版是「分工与拼装顺序」。
      // 用户若已把 spec 改得认不出厂标记（旧标记也不在），尊重用户内容不覆盖。
      const s = String(t.spec || '');
      const OLD_MARK = '### 3.1 分工\n- `tag`（**英文连贯句**';
      const NEW_MARK = '### 3.1 分工与拼装顺序';
      if (!s.includes(OLD_MARK) && !s.includes(NEW_MARK)) continue;
      const fresh = t.variant === 'styled' ? defaultK2StyledTemplate(t.name || '') : defaultK2Template(t.name || '');
      t.system = fresh.system;
      t.spec = fresh.spec;
      t.protocol = fresh.protocol;
      refreshed.push(t.name || '(未命名)');
    }
    if (refreshed.length) changes.push(`K2 模版出词结构已升级为 v4 三明治（scene→人物锚点段→tag→mood）：${refreshed.join('、')}`);
    v = 4;
  }

  if (v < 5) {
    // v4 → v5：人物段写法贴近用户 v4 定稿 + 修多人画面的三处崩坏源。
    // 实测（2026-09-27 用户报告）：①「共 N 人」人数声明按 @引用计数，模型用 <user> 宏
    // 指代角色时收集数偏少，三人画面被标成「共 2 人」—— 错误声明比没有更有害，删；
    // ②人物段引导词改贴 v4（「画面中的女人：」），不再用「其中一名成年女性：」；
    // ③<user>/<bot> 宏禁止写进任何字段（宏不展开=噪声+撕句+漏人）；④动态状态字段
    // 只收短状态语（动作句混进人物段=重复权重）。出厂 K2 模版文本整体刷新。
    const templates = cfg.templates && typeof cfg.templates === 'object' ? cfg.templates : {};
    const refreshed = [];
    for (const t of Object.values(templates)) {
      if (!t || t.engine !== 'k2') continue;
      if (t.variant !== 'plain' && t.variant !== 'styled') continue;
      const s = String(t.spec || '');
      if (!s.includes('### 3.1 分工与拼装顺序')) continue;   // 非出厂文本（用户重写过）不动
      const fresh = t.variant === 'styled' ? defaultK2StyledTemplate(t.name || '') : defaultK2Template(t.name || '');
      t.system = fresh.system;
      t.spec = fresh.spec;
      t.protocol = fresh.protocol;
      refreshed.push(t.name || '(未命名)');
    }
    if (refreshed.length) changes.push(`人物段格式与多人硬规则升级（去人数声明 / <user> 宏禁令 / 状态字段只收短语）：${refreshed.join('、')}`);
    v = 5;
  }

  if (v < 6) {
    // v5 → v6：景别条款反转（2026-09-27 用户实测：写了景别/裁切边界反而与动作打架产生畸变，
    // 工作区成功的纯英文版本来就不带景别词）—— scene 改为「不写景别，取景交给模型」。
    const templates = cfg.templates && typeof cfg.templates === 'object' ? cfg.templates : {};
    const refreshed = [];
    for (const t of Object.values(templates)) {
      if (!t || t.engine !== 'k2') continue;
      if (t.variant !== 'plain' && t.variant !== 'styled') continue;
      const s = String(t.spec || '');
      if (!s.includes('### 3.1 分工与拼装顺序')) continue;   // 非出厂文本（用户重写过）不动
      const fresh = t.variant === 'styled' ? defaultK2StyledTemplate(t.name || '') : defaultK2Template(t.name || '');
      t.system = fresh.system;
      t.spec = fresh.spec;
      t.protocol = fresh.protocol;
      refreshed.push(t.name || '(未命名)');
    }
    if (refreshed.length) changes.push(`景别条款反转（scene 不写景别与裁切边界，畸变源移除，取景交给模型）：${refreshed.join('、')}`);
    v = 6;
  }

  if (v < 7) {
    // v6 → v7：新增出厂模版「K2 纯英文单段」（variant='en'）—— 用户工作区实测成功形态：
    // 一整段连贯英文（外貌服装自写、无中文无景别无锚定块）。一次性注入，删除不复活。
    const templates = cfg.templates && typeof cfg.templates === 'object' ? cfg.templates : {};
    const hasEn = Object.values(templates).some(t => t?.engine === 'k2' && t?.variant === 'en');
    if (!hasEn) {
      const tpl = defaultK2EnglishTemplate('K2 纯英文单段');
      templates[tpl.name] = tpl;
      changes.push('已注入出厂模版「K2 纯英文单段」（一整段连贯英文：外貌服装自写，无景别无中文）');
    }
    v = 7;
  }

  if (v < 9) {
    // v7 → v9：① 砍掉结尾中文情绪段（mood / nl），情绪并入英文 tag 末句；② 新增手位写法条款。
    // ① 实测（2026-09-27 用户报告）：中文 mood 复述 tag 里已写的动作与身体状态
    //    （「强撑着端稳那只碗」/「双腿越夹越紧」），模型把复述当成又一次动作请求，
    //    把动作与物体复制成多份 —— 实测多长出一只手；且中文在末尾＝权重最高位，污染被放大。
    //    情绪改用英文写进 tag 最后一句；mood / nl 字段废弃，模型若输出插件整段丢弃。
    // ② 实测（2026-09-27 用户报告）：手位写成两个各自带主语的独立小句
    //    （`His left hand rests on the edge of the curtain, his right hand hangs over his knee`），
    //    模型读成两个独立手部实体 → 多出第三只手在拉窗帘。改为「同一句号 + 从属结构」。
    // ⚠️ 版本号跳过 8：CONFIG 8 曾用于一版被回退的改动，用户配置里可能残留 version=8；
    //    若沿用 8，那部分用户的 `v < 8` 不触发、模版永远不刷新。故直接跳到 9 保证迁移生效。
    const templates = cfg.templates && typeof cfg.templates === 'object' ? cfg.templates : {};
    const refreshed = [];
    for (const t of Object.values(templates)) {
      if (!t || t.engine !== 'k2') continue;
      if (t.variant !== 'plain' && t.variant !== 'styled') continue;   // en 单段本就不拼中文段
      const s = String(t.spec || '');
      if (!s.includes('### 3.1 分工与拼装顺序')) continue;   // 非出厂文本（用户重写过）不动
      const fresh = t.variant === 'styled' ? defaultK2StyledTemplate(t.name || '') : defaultK2Template(t.name || '');
      t.system = fresh.system;
      t.spec = fresh.spec;
      t.protocol = fresh.protocol;
      refreshed.push(t.name || '(未命名)');
    }
    // en 单段模版的手位条款（§3.2 第三句里）—— 走另一套判定（它不含「### 3.1 分工与拼装顺序」）
    for (const t of Object.values(templates)) {
      if (!t || t.engine !== 'k2' || t.variant !== 'en') continue;
      const s = String(t.spec || '');
      if (!s.includes('### 3.2 四句骨架')) continue;   // 非出厂文本不动
      const fresh = defaultK2EnglishTemplate(t.name || '');
      t.system = fresh.system;
      t.spec = fresh.spec;
      t.protocol = fresh.protocol;
      refreshed.push(t.name || '(未命名)');
    }
    if (refreshed.length) {
      changes.push('移除结尾中文情绪段（情绪并入 tag 末句）+ 新增手位写法条款（防多手）：' + refreshed.join('、'));
    }
    v = 9;
  }

  if (v < 10) {
    // v9 → v10：人物锚点段大改（2026-09-27 实测三连崩后的定稿）：
    // ① 去掉「画面中的人物——」标题行与「画面中的女人：」前缀 —— 与 nlProfile 自带开头双重称谓打架；
    // ② 「一位成年女性」措辞禁用（画老脸画壮体型）→ 按外表年龄（少女/女性/成熟的女性）；
    // ③ 英文状态碎片不再拼进中文人物段（中英生硬拼接 + 与 tag 状态重复 = 实体复制）；
    // ④ 新增「体型/种族/年龄段必须与人物段一致」规则（实测「成年女性 vs palm-sized fairy」多画一只精灵）；
    // ⑤ 成年锚定改为「adult 词不可丢、名词跟种族走」（adult fairy / adult elf）。
    const r10 = refreshK2FactoryTemplates(cfg);
    if (r10.length) {
      changes.push('人物段格式定稿（无标题行无前缀 + 年龄措辞禁「成年」+ 状态碎片移出 + 种族锚定跟档案走）：' + r10.join('、'));
    }
    v = 10;
  }

  if (v < 11) {
    // v10 → v11：人物段行首恢复「角色名：」标签（2026-09-27 追加）。
    // 去掉「画面中的女人：」这类性别前缀是为了不跟外貌打架，但多人同框需要一个稳定的
    // 归属锚点 —— 用角色名当前缀既能定位又不描述外貌，实测能压住「A 的外貌贴到 B 身上」。
    const r11 = refreshK2FactoryTemplates(cfg);
    if (r11.length) {
      changes.push('人物段行首加「角色名：」归属标签（多人同框防外貌串台，仍无标题行、无性别前缀）：' + r11.join('、'));
    }
    v = 11;
  }

  if (v < 12) {
    // v11 → v12：多人画面「按角色分块」+ cast 出场名单（2026-09-28）。
    // 病因（用户实测三连报）：① 画面有 2 人，插件只锚定了一个 —— 英文句里只有 her/his，
    //   插件猜不出「her 指档案库里哪一位」，第二个角色只能退化成「一位男性」的概括；
    // ② 告警说「本楼有 14 个在场角色」—— 候选池取的是整张卡的档案库，越看越不会选。
    // 改法：模型侧新增 images[].cast（「画面里有谁」的权威来源，每人可带自己的英文句），
    //   插件侧按角色分块拼装：A外貌+A动作 → B外貌+B动作；告警名单收窄到本楼在场角色。
    const r12 = refreshK2FactoryTemplates(cfg);
    if (r12.length) {
      changes.push('多人画面按角色分块（cast 出场名单 + 每人外貌与动作同块）:' + r12.join('、'));
    }
    v = 12;
  }

  if (v < 13) {
    // v12 → v13：人数声明反转 + offscreen 入画标记（2026-09-27 翻车图定稿）。
    // 病图：精灵坐裤子上，tag 写「Two figures fill the frame」→ 左下角多出半截人。
    // 根因①：人物段已按角色分块（每人一块外貌+动作），tag 再声明人数 = 同一批人
    //   被第三处描述 = 模型把它当第 3 个实体去成立；
    // 根因②：tag 把 cast[].en 写过的动作/接触物复述了一遍（同一条裤子被描述 4 次）；
    // 根因③：POV / 特写构图里男主不入画，却给了他完整外貌锚定（外貌段 = 画完整他的指令）。
    // 改法：tag 禁人数声明（插件剥句首声明）+ tag 只剩末句情绪 + cast 支持 "offscreen": true。
    const r13 = refreshK2FactoryTemplates(cfg);
    if (r13.length) {
      changes.push('tag 禁人数声明与复述 cast（人数由分块表达）+ cast 支持 offscreen（POV 不入画）:' + r13.join('、'));
    }
    v = 13;
  }

  if (v < 14) {
    // v13 → v14：新增两套 NSFW 出厂模版（2026-09-28）。
    // 需求：在 v0.9.28 的结构上另建 2 个模版，与「K2 中英混合」同骨架，只多一个 NSFW 板块。
    // 口径来源：用户工作区《K2 人像提示词引擎（NSFW 版）》+ k2-prompt-core ref/00 / ref/03 / ref/08。
    // ★ 关键约束：**不动任何一节既有文本**（spec §一§二 §3.1–3.8、system、protocol 原样保留），
    //   NSFW 内容只以「尾部追加」的方式存在 —— v0.9.28 的防崩坏条款
    //   （禁人数声明 / offscreen / 按角色分块）在 NSFW 版里原样生效，不会出现两套规则打架。
    // ★ 有意偏离源口径一处：**服装段仍走中文**（沿用角色档案注入，属人设主权区）。
    //   不改成英文整句 —— 中英各说一遍同一件衣服 = 跨段复述 = 复制出多余实体
    //   （2026-09-27 翻车图：同一条牛仔裤被描述 4 次 → 多出半截人）。
    const names = ['K2 中英混合（NSFW）', 'K2 中英混合（NSFW·带风格化）'];
    const added = [];
    if (!cfg.templates) cfg.templates = {};
    for (const n of names) {
      // 已存在就只做「补板块」，不覆盖用户改过的其它内容 ——
      // 用户可能已经把激活态切到它、或改过里头的文字。
      const exist = cfg.templates[n];
      if (exist && String(exist.spec || '').includes(NSFW_SPEC_MARKER)) continue;
      cfg.templates[n] = n.includes('带风格化')
        ? defaultK2NsfwStyledTemplate(n)
        : defaultK2NsfwPlainTemplate(n);
      added.push(n);
    }
    if (added.length) {
      changes.push(`新增 NSFW 出厂模版「${added.join('」「')}」（通用骨架 + §3.9 NSFW 板块；服装段仍走中文以防跨段复述）`);
    }
    const r14 = refreshK2FactoryTemplates(cfg);
    if (r14.length) changes.push('NSFW 模版文本已同步到当前版本:' + r14.join('、'));
    v = 14;
  }

  if (v < 15) {
    // v14 → v15：年龄锚定一致化 + 英文句禁复述外貌要素（2026-09-28 用户翻车图）。
    // 病图：人物段「夜斗：一位少年…」，英文句却写 `The adult man stands...`
    //   → 两处年龄打架，模型按更具体的英文句走，出图是成年男子，与人设判若两人。
    // 根因：旧 spec 把「成年锚定必写、`adult` 一词不可丢」写成硬条款，
    //   模型被逼着写冲突的年龄词；而中文侧 cleanProfileLead 又在删「成年」（防画老），
    //   两条规则对着干。现改为「年龄锚定必写，但措辞跟随人物段」：
    //   少年/少女 → young；无年龄措辞或写「成年」→ adult（保留合规底线）。
    // 同批修：精灵类翻车（菲多手）—— 人物段已写「背后生有半透明翅膀」，
    //   英文句再写 `Her wings stay half-folded behind her back` = 同一实体第二次描述，
    //   与手臂混淆多长出多余的手。故新增「英文句不得复述人物段已写的外貌要素」。
    const r15 = refreshK2FactoryTemplates(cfg);
    if (r15.length) {
      changes.push('英文句年龄锚定改为跟随人物段（少年→young，不再一律 adult）+ 禁复述人物段外貌要素（翅膀等，防多手）:' + r15.join('、'));
    }
    v = 15;
  }

  if (v < 16) {
    // v15 → v16：同一条修正补到**第 5 套**「K2 纯英文单段」（2026-09-28 用户追问「别只改了一个」）。
    //   漏改的根因不是粗心，是**结构**：中英混合系四套共用 `k2SpecSection3(styled)` 一个函数，
    //   改一处四份都生效；而纯英文单段走的是**另一份独立 spec**（`k2EnglishSpecSection3`，
    //   标题是「### 3.2 四句骨架」），与中英混合的 §3.1 完全不同源 —— 所以 v15 那一轮
    //   **根本没碰到它**，它的 §3.2 与 protocol 里「成年锚定必须写在最前面 / adult 锚定词不能丢」
    //   原封不动地留着，逼着模型在少年角色上也写 adult，与外貌打架出图成另一个人。
    //   修法与中英混合同口径：年龄锚定必写，但措辞跟随角色档案（少年→young）。
    //   同批补上「外貌要素全段只写一次、禁复述（翅膀重灾区）」。
    // ⚠️ 教训（写在这里防下次再犯）：**新增通用条款时，必须确认每一套模版的 spec 来源**，
    //   有几份独立 spec 就要改几处；dev/template-parity-test.mjs 已把五套一起纳入断言。
    const r16 = refreshK2FactoryTemplates(cfg);
    if (r16.length) {
      changes.push('年龄锚定一致化补到「K2 纯英文单段」（第 5 套，独立 spec 上一轮漏改）+ 禁复述外貌要素:' + r16.join('、'));
    }
    v = 16;
  }

  if (v < 17) {
    // v16 → v17：**`adult` 措辞整体禁用**，年龄锚定改为三档（2026-09-28 用户再追问）。
    //   上一轮（v15/v16）只做到「措辞跟随人物段」，兜底档仍是 `adult man` / `adult woman`。
    //   用户当场指出：「为啥不是写一位男子或者一位男性」—— 他要的不是「把 adult 换成别的」，
    //   而是**这套「成年」说辞本身就不要用**。
    //   溯源发现 09-27 早就定稿过正确口径（aiProfileMessages 的 ageRule）：
    //     外表年轻 → young；外表达观 → mature；其余 → **光杆，不写年龄词**；**禁写 adult**。
    //   理由：adult 实测把脸画老、体型画壮（核心崩因）。v0.9.30 那轮等于把定稿口径退了回去，这次归位。
    //   同批：spec 里 `adult fairy` / `adult man` 的**示例文本**一并改掉（模型会照抄示例）；
    //   插件侧 alignAgeAnchor 从二档改三档（plain 档 = 删掉 adult 只留身份名词）。
    //   NSFW §3.9 ① 的「成年锚定」是**合规判定**（年龄缺失默认成年），保留，但注明它不等于措辞。
    const r17 = refreshK2FactoryTemplates(cfg);
    if (r17.length) {
      changes.push('年龄锚定改三档（年轻 young / 达观 mature / 其余光杆），`adult` 措辞整体禁用（实测把脸画老、体型画壮）:' + r17.join('、'));
    }
    v = 17;
  }

  if (v < 18) {
    // v17 → v18：**肢体单一声明律**（2026-09-28 用户报「提示词里又有重复定义，导致第三只手」）。
    //   ⚠️ 本次修的是**规则本身写错了** —— 旧 §3.4b / 纯英文 §3.2 教的是
    //   「用 `both hands ...` 定整体，再用 `his left ..., his right ...` 从属分配」，
    //   用户**照这条写**照样长出第三只手：
    //     `both hands raised — his right drawing the curtain open, his left resting flat on the sill`
    //   根因：总括是**状态声明**（双手在高处）、分项是**位置声明**（左手在窗台），
    //   两份几何一冲突，K2 不取其一，而是**多长一只手**去满足第二份 → 三只手。
    //   修法：三档（A 只写一只 / B one...the other 不指定左右 / C 定侧但必须自洽）+ 判据；
    //   ★ POV 两种情形写法相反（我的手 → 可写左右；我看着的那个人 → 别写左右，镜像歧义）；
    //   腿 / 脚 / 膝同理。另补 §3.6 两条：同一形容词不许出现两次；**背对镜头不写脸**
    //   （背对却写 half-lidded eyes → 模型把头扭回镜头，连带肩与手臂带歪 —— 同一镜的第二个崩因）。
    //   ★ 元规则（v0.9.31 立的第 17 条）再次生效：改通用条款前先数清有几份独立 spec。
    //     本次落在两处 —— `k2SpecSection3`（覆盖中英混合 plain/styled + NSFW plain/styled 四套，
    //     NSFW 是尾部追加所以自动带上）＋ `k2EnglishSpecSection3`（纯英文单段，完全独立，必须单独改）。
    const r18 = refreshK2FactoryTemplates(cfg);
    if (r18.length) {
      changes.push('肢体单一声明律（禁「总括+分项」叠写，防第三只手；POV 看他时不写左右）+ 背对不写脸 + 同段禁重复词:' + r18.join('、'));
    }
    v = 18;
  }

  if (v < 19) {
    // v18 → v19：**服装态扫描**（2026-09-28 用户报「服装老是漂移 / 同款换款式 / 直接换类型」）。
    //   取证结论：漂移的根因不在模版，而在**写入端没接线** ——
    //   `buildOutfitProbeMessages`（服装提取器）从写好起从未被任何代码调用，
    //   服装只剩「出词模型主动报 outfit」这一条路。实测 22 楼里 13 楼正文明确写了服装，
    //   插件 dyn 里落库 **0 条** → 档案行没有服装段 → 出图时每轮翻正文现编 → 必漂。
    //   本次：① 提取器改造成批量+带历史，真正接进管线；② 换装只认正文换装动词；
    //   ③ 服装行未记录时显式占位（旧版静默跳过 = 告诉模型"此人无服装"）。
    //   这里是开关补默认 + 一条说明，方便老配置用户知道多了这个能力。
    cfg.consistency = cfg.consistency || {};
    if (cfg.consistency.outfitScan === undefined) {
      cfg.consistency.outfitScan = true;
      changes.push('已开启「服装态扫描」：生图前从正文读出各角色此刻穿着写进档案，服装不再每轮重编（可在一致性设置里关掉）');
    }
    v = 19;
  }

  if (v < 20) {
    // v19 → v20：**服装态随剧情演进**（2026-09-29 用户要求「别锁死，这是角色扮演小说不是分镜图」）。
    //   ① 服装扫描独立历史窗口 5 楼（原来跟出图共用 2 楼，跨楼判断不了"脱了又穿回去"）；
    //   ② 款式放行加两条 —— 场景切换（第二天/醒来/回到家）+ 同一新款连续出现 2 楼；
    //   ③ 修 force 语义（面板手动改款式原来会不生效）+ 加「解锁款式」按钮。
    //   ⚠️ 用户明确否决了「场景切换 → 自动重置为穿好」：新场景该不该穿好
    //      只能读剧情定（第二天醒来可能还光着），**不设硬编码默认值**。
    cfg.consistency = cfg.consistency || {};
    if (cfg.consistency.outfitScanFloors === undefined) {
      cfg.consistency.outfitScanFloors = 5;
      changes.push('服装扫描历史窗口已扩到 5 楼（原来跟出图共用 2 楼，跨楼判断不了服装态）');
    }
    if (cfg.consistency.outfitStyleRepeatFloors === undefined) {
      cfg.consistency.outfitStyleRepeatFloors = 2;
      changes.push('新增：同一套新款被剧情连续提到 2 楼 → 放行改写款式（解决剧情换装但没写「换上」的情况）');
    }
    v = 20;
  }

  if (v < 21) {
    // v20 → v21（2026-09-30，两个用户实测问题）：
    //   ① **状态词拆分吃衣服**：款式「light blue knit sweater … slipped to one side, …」
    //      在面板保存后只剩「and a grey cotton long skirt.」—— slipped to one side 是
    //      滑到一侧肩（还穿着），旧表把它当"脱下"整段搬走，整件针织衫蒸发。
    //      拆分表已收紧为「真脱下」模式（slipped / hanging open / pushed up / undone
    //      等仍穿着的状态一律留在款式里）。此修复在代码层，这里只负责同步模版文本。
    //   ② **NSFW 性行为描写不执行**：姿态段只写 having sex 不写器官与插入状态，
    //      模型拿不到关键画面事实就自己脑补。§3.9 ③ 加第 6 条锚定「性行为写实」，
    //      画面看得到就必须直白写明（参考用户 K2 工作区实测句式）。
    //      出厂文本已改，这里把未改过的出厂模版刷成新版。
    const r21 = refreshK2FactoryTemplates(cfg);
    if (r21.length) changes.push('NSFW 模版已同步到当前版本（§3.9 ③ 新增第 6 条锚定「性行为写实」：画面看得到就必须写器官与插入状态）:' + r21.join('、'));
    v = 21;
  }

  if (v < 22) {
    // v21 → v22（2026-09-30，重复建档第二波）：
    //   同一人被建成「隔壁太太」「结城美惠」「结城太太」三条（匿名指代建档 + 真名揭露
    //   + 模型换叫法），服装各演化各的，改哪条另外两条都不跟。三处修复：
    //   ① 【档案库权威名单】回灌扫描请求（原来名单从没给过模型，规则 2d 无从执行）；
    //   ② kind:"merge" 同人归并通路（AI 判同人 → 插件执行，to 优先只补空缺）；
    //   ③ protocol 加 merge 说明。出厂文本已改，这里把未改过的出厂模版刷成新版。
    const r22 = refreshK2FactoryTemplates(cfg);
    if (r22.length) changes.push('模版文本已同步到当前版本（protocol 新增 kind:"merge" 同人归并；扫描规则 2d/2e 重建重复档案防线）:' + r22.join('、'));
    v = 22;
  }

  if (v < 23) {
    // v22 → v23（2026-09-30，版本自检后的第一批修复）：
    //   ① 【严重】换过一次衣服后再也脱不掉 —— swapped 与 removed 在 STATE_ORDER 里同为 3，
    //      `nextOrder > prevOrder` 恒 false → 部件守恒 + 覆盖率两道闸门同时拒绝。
    //      新增 linearOrder()：把 swapped 摘出线性序列（当作起点 0）。纯代码修复。
    //   ② 【严重】脱衣那一楼整楼作废 —— newGarmentWords 把鞋袜当成"凭空多出来的新衣服"，
    //      正文顺手提一句 slippers/socks 就判成"偷换款式"。新增 MINOR_WORDS（鞋袜/配饰豁免）。
    //   ③ 换装（swapped）后不清裸露锚点 → 注入出「身穿新睡衣；下身赤裸」。已与 intact 同处理。
    //   ④ 服装扫描候选**按信号强度排序后再截断**（原来直接截档案前 8 个，
    //      真在脱衣服的人常被截在门外）；上限改为可配置 outfitScanMax。
    //   ⑤ outfitScanFloors 此前对"线索回看楼数"完全无效（一直用默认值 3），已接线。
    //   ⑥ ★ 让模型看见上一张图（本次最大的一项）：新增 recentImageBriefs 通道，
    //      把近 3 张已出图的摘要注入分析请求。同时把 settings 里 4 处
    //      「模型手里没有上一张」的旧口径改成「有摘要，但只许用事实、不许照抄」。
    //      出厂文本已改，这里把未改过的出厂模版刷成新版。
    cfg.consistency = cfg.consistency || {};
    if (cfg.consistency.outfitScanMax === undefined) {
      cfg.consistency.outfitScanMax = 8;
    }
    if (cfg.consistency.recentImages === undefined) {
      cfg.consistency.recentImages = true;
      changes.push('新增「近期已出过的图」回灌：分析时能看见近 3 张已出图的摘要，用于避免重复出图、延续已确立的画面事实（可在一致性设置里关掉）');
    }
    if (cfg.consistency.recentImageCount === undefined) {
      cfg.consistency.recentImageCount = 3;
    }
    changes.push('服装态修复：换装后可以继续脱衣；鞋袜不再被当成凭空多出的新衣服（此前会导致脱衣那一楼整楼作废）；换装后自动清掉旧的裸露锚点');
    const r23 = refreshK2FactoryTemplates(cfg);
    if (r23.length) changes.push('模版文本已同步到当前版本（4 处「禁止跨图引用」口径更正为「有摘要可用，但只许延续事实、不许照抄」）:' + r23.join('、'));
    v = 23;
  }

  if (v < 24) {
    // v23 → v24（2026-10-01，NSFW 防崩六条补强，全部来自 k2-prompt-core 总库实测结论）：
    //   ① §3.9 新增 ③c 骨架句库：7 组实测稳定的双人姿态（她/他两句几何同源，拆分自总库 ref/02·ref/07）——
    //      「自造机位×体位组合」是 NSFW 崩坏头号根因，而酒馆内的模型读不到外部句库，内容必须内嵌。
    //      内嵌时做了两处合规适配（说明里写明，防改写回退）：an adult male partner → the man（§3.6 禁 adult）、
    //      删 D-cup 胸型词（外貌归人物段）、tears glistening → tears in her eyes（glistening 在禁词表）。
    //   ② 插入方向词三选一（from the front / behind / below）—— 坐姿与骑乘必须 from below，
    //      写错方向词是坐姿崩坏常见原因（总库组合 1t 教训）。
    //   ③ 节奏三档词表（温和/用力/冲刺）+ pound 禁写（库内 0 次从未稳定）。
    //   ④ ⑤b 替代表补 NSFW 体液合法句 —— 此前只给干燥锚，想表达兴奋液体时无词可用，
    //      违反 ⑤b 自己的「禁了就得有得写」原则。
    //   ⑤ 手位可达性判据 —— 骑乘/坐姿位抓髋可达、绝不抓腰（腰在她身后，物理不可达）；
    //      只有俯身位（他跪她双腿间上身前倾）才可双手掐腰。缺这条 → 抓腰写法直接畸变。
    //   ⑥ §3.2 scene 禁姿态动词 —— 中文 scene 写「他从背后压住她」会跟英文段各立一套几何，
    //      实测模型补出俯卧撑式叠压。姿态只归英文段（cast[].en / tag）。
    const r24 = refreshK2FactoryTemplates(cfg);
    if (r24.length) changes.push('出厂 K2 模版已同步：NSFW 防崩六条补强（骨架句库内嵌 / 插入方向词 / 节奏三档 / 体液合法句 / 手位可达性 / scene 禁姿态）:' + r24.join('、'));
    v = 24;
  }

  if (v < 25) {
    // v24 → v25（2026-10-02，针对「多肢体 / 扭曲 / 畸形」的对症补强，
    //   全部来自当天《雾津市播种计划！》12 张真实出图的逐张复盘，不是照抄外部口径）：
    //   ① §3.9 姿态段重写为「只写画面看得见的，且只写一次」。
    //      复盘结论：崩坏不是因为写得太少，是因为**太多来源各写一遍** ——
    //      人物段写了裤子、动作句再写一遍；动作句写了两只手、情绪句又提一次手指。
    //      每多一份重复描述 = 多一个实体，模型按「两个都要成立」去补 → 多肢体 / 扭曲。
    //      所以：篇幅压到 200–300 字、手位最多写一只、禁写手指脚趾这类数不清的部位。
    //   ② 新增 ③b 镜头与构图必写（机位 / 景别 / 体积关系）—— 它不参与人体几何，
    //      是唯一多多益善的部分，且能把人锁在画面里的正确位置。
    //   ③ 景别决定写不写服装：全身写、特写不写（写画外部位 = 模型硬塞一块进画面）。
    const r25 = refreshK2FactoryTemplates(cfg);
    if (r25.length) changes.push('出厂 K2 模版已同步：姿态段精简（禁部位细节 / 手位只写一只 / 篇幅 200–300 字）+ 镜头构图必写 + 景别决定服装:' + r25.join('、'));
    v = 25;
  }

  if (v < 26) {
    // v25 → v26（2026-10-02，真实 e2e 验证后的两处回补）：
    //   ① §3.9「必写四件」补回第 4 条「胯部对齐」（his hips aligned with hers）——
    //      姿态段精简时被误删；骨架句库每组都带它，规范层面却没了，规范与句库口径不一致。
    //      胯部不对齐 = 两副骨盆各画各的 = 下身错位/悬空连接。
    const r26 = refreshK2FactoryTemplates(cfg);
    if (r26.length) changes.push('出厂 K2 模版已同步：姿态段「必写四件」补回「胯部对齐」锚定（防下身错位）:' + r26.join('、'));
    v = 26;
  }

  if (v < 27) {
    // v26 → v27（2026-10-02，并入 K2_V3_融合版 NSFW 姿态句法 · 用户实玩验证稳定）：
    //   ① 姿态段「句法三约束」：一图一个主动几何（禁两人各写完整主谓 —— 实测三只手/
    //      器官错位的直接来源）／方向一次写死／反应只作从属从句。
    //   ② ③d 反应链库（9 条验证过的从属从句，全篇只选一条；V3 原库的「强制链」与
    //      「睡奸」「过激」两类姿态已剔除 —— 前者易读作非自愿，后两者触硬边界）。
    const r27 = refreshK2FactoryTemplates(cfg);
    if (r27.length) changes.push('出厂 K2 模版已同步：NSFW 姿态段并入 V3 验证句法（单主语／方向写死／反应链从句）:' + r27.join('、'));
    v = 27;
  }

  if (v < 28) {
    /* v0.9.66 —— 清理「<user> 分裂条目」存量。
     * 病根建档入口从不校验名字，导致每个会话都被写进一条 <user> 档（实测 15 个会话全中）。
     * 用户改的是真名档（如「夜斗」），出图却可能读到 <user> 档 —— 改了不生效。
     * 这里把宏条目的数据并进对应真名档（真名为底，宏条目只补空缺），然后删除宏条目。
     * 主角通道(<user>/<persona>) 与 角色卡通道(<bot>/<char>) 分开处理，互不覆盖。 */
    try {
      const chs = root?.chars || {};
      let merged = 0, dropped = 0, skipped = 0;
      /* ★ 两条通道的真名来源，必须分开取，不能互相兜底：
       *   - 主角（persona）→ getUserName() = ctx.name1，正文写作 <user>
       *   - 角色卡角色     → getCharName() = ctx.name2，来自世界书/角色卡
       * 拿不到真名就**只删不并**（绝不猜目标）—— 合并到错人身上比留着废条目更糟。 */
      let selfName = '';
      let charName = '';
      try { selfName = String(getUserName() || '').trim(); } catch { selfName = ''; }
      try { charName = String(getCharName() || '').trim(); } catch { charName = ''; }
      for (const cn of Object.keys(chs)) {
        const node = chs[cn];
        if (!node || typeof node !== 'object') continue;
        for (const [chatId, chat] of Object.entries(node.chats || {})) {
          const dyn = chat?.dyn;
          if (!dyn || typeof dyn !== 'object') continue;
          for (const n of Object.keys(dyn)) {
            const ch = macroChannel(n);
            if (!ch) continue;                       // 不是宏条目，跳过
            const target = ch === 'self' ? selfName : charName;
            /* 拿不到真名（如用户没选 persona）→ **保留条目不动**，等下次能拿到再合。
             * 曾经写成「删掉」，会静默丢掉这一条的服装数据 —— 数据没了比条目多余严重得多。
             * 入口闸已经阻止新条目产生，留着旧的无害（读取时会清洗）。 */
            if (!target || target === n) { skipped += 1; continue; }
            // 合并：target 为底，宏条目只补空缺
            if (!dyn[target]) dyn[target] = dyn[n];
            else {
              const base = dyn[target], fill = dyn[n];
              for (const [k, v] of Object.entries(fill.fields || {})) {
                if (!base.fields) base.fields = {};
                if (v && !base.fields[k]) base.fields[k] = v;
              }
              if (fill.outfit) {
                base.outfit = base.outfit || {};
                for (const [k, v] of Object.entries(fill.outfit)) {
                  if (k === 'history') continue;
                  if (v && !base.outfit[k]) base.outfit[k] = v;
                }
              }
            }
            delete dyn[n];
            merged += 1;
          }
        }
        /* 静态层同样清理 —— 但要**先补缺再删**，不能只删。
         * 只删会把占位条目独有的字段（如 mark）一起丢掉；dyn 层是合并的，
         * cast 层却只删，两层行为不一致就是数据悄悄变少的来源。 */
        for (const n of Object.keys(node.cast || {})) {
          const ch = macroChannel(n);
          if (!ch) continue;
          const target = ch === 'self' ? selfName : charName;
          if (!target || target === n) { skipped += 1; continue; }
          if (node.cast[target]) {
            const base = node.cast[target], fill = node.cast[n];
            for (const [k, v] of Object.entries(fill.fields || {})) {
              if (!base.fields) base.fields = {};
              if (v && !base.fields[k]) base.fields[k] = v;   // 真名为底，只补空缺
            }
            merged += 1;
          } else {
            // 真名档都没有 → 这条占位数据无处可去，整条改名过去（不丢数据）
            node.cast[target] = node.cast[n];
            node.cast[target].name = target;
            merged += 1;
          }
          delete node.cast[n];
          dropped += 1;
        }
      }
      if (merged || dropped || skipped) {
        info(STAGE.CONSISTENCY, `v28 迁移：合并 ${merged} 条、丢弃 ${dropped} 条、暂留 ${skipped} 条（拿不到真名，下次再合）宏名条目`);
      }
    } catch (e) {
      warn(STAGE.CONSISTENCY, 'v28 宏条目清理失败（不影响主流程）: ' + String(e && e.message || e));
    }
  }

  if (v < 29) {
    /* v0.9.68 —— 出厂服装库扩充（A1）：并入 K2_V3 款式表 141 条，中文名做 UI 标签、英文做真值（F1）。
     *
     * ★ 为什么不靠 mergeDefaults 补：`presetsSeeded` 的语义是「删了就是删了」，
     *   一旦播种过，defaults.outfitPresets 就被置空 —— 放进默认值老用户永远看不到新内容。
     *   所以这里用独立的 presetSeedVer 做**一次性增量播种**：
     *     · 已存在的同名条目（用户自己建的 / 改过的 / 之前播种过的）一律不覆盖；
     *     · 只补 key 缺失的条目 + 没设过分类的条目；
     *     · 补完把 presetSeedVer 顶到当前值，下次版本再升时才会有第二轮。
     *   副作用边界：若用户在 v0.9.67 及以前**删过**某条出厂预设，这次会被补回来一次
     *   （无法区分「删过」与「从未播种」），之后再删不会再复活。
     */
    try {
      if (!(cfg.outfitPresets && typeof cfg.outfitPresets === 'object')) cfg.outfitPresets = {};
      if (!(cfg.presetCats && typeof cfg.presetCats === 'object')) cfg.presetCats = {};
      const lib = libraryToPresets();
      const cats = libraryToCats();
      let added = 0; let catted = 0;
      for (const [name, en] of Object.entries(lib)) {
        if (cfg.outfitPresets[name] == null) { cfg.outfitPresets[name] = en; added += 1; }
      }
      for (const [name, cat] of Object.entries(cats)) {
        if (!cfg.presetCats[name]) { cfg.presetCats[name] = cat; catted += 1; }
      }
      cfg.presetSeedVer = PRESET_SEED_VERSION;
      if (added || catted) {
        changes.push(`服装库已扩充：新增 ${added} 条出厂款式（K2 款式表，中文名作标签 / 英文作真值）`);
      }
    } catch (e) {
      warn(STAGE.INIT, 'v29 服装库扩充失败（不影响主流程）: ' + String(e && e.message || e));
    }
    v = 29;
  }

  if (v < 32) {
    /* v0.9.72 —— 「模型自动填服装三维度」开关。
     *
     * ★ 默认 false：这是给模型的**写权限**，不是功能增强。给了它，模型每楼都能改写
     *   状态细档 / 改造 / 鞋袜 —— 而这三项的英文是直接进画面的。默认关着，
     *   老用户升级后行为完全不变（三维度仍需档案页手动设）。
     *
     * ⚠️ 这里只补**缺省**，绝不覆盖用户已有的选择（含显式关掉的情况）。
     */
    cfg.consistency = cfg.consistency || {};
    if (cfg.consistency.autoOutfitDims === undefined) {
      cfg.consistency.autoOutfitDims = false;
    }
    v = 32;
  }

  if (v < 33) {
    /* v0.9.83 —— NSFW 姿态防畸变律 + 骨架句库扩容。
     *
     * ★ 为什么必须走迁移：出厂 spec 改了不会自动同步用户存档里的模版副本，
     *   不刷这一下，用户手上的「K2 中英混合（NSFW）」永远停在旧版 —— 改了等于没改。
     *
     * 内容（都出自 K2 实测库的长期生效规则，绘灵此前完全缺失）：
     *   ① §3.9 ③e 通用防畸变律五条 —— 肢体单一声明律（三只手头号根因）／腿位极简律／
     *      掰腿前置律／承重面必写／同段禁重复词。共同机制：同一部位声明第二次 = 多画一份几何。
     *   ② 骨架句库 7 组 → 11 组：补站立压墙后入、俯卧趴地 prone bone、反骑乘、单腿挂腰
     *      （K2 矩阵 1ad / 1n / 1j·1w / 1u·1l 实测稳定组合）。
     *   ③ 库外处置规则：库里没有对应体位 → 选机位最接近的一组只换承重面词，严禁自造组合。
     */
    const r33 = refreshK2FactoryTemplates(cfg);
    if (r33.length) {
      changes.push('NSFW 姿态规范已升级（③e 通用防畸变律五条 + 骨架句库 7→11 组 + 库外严禁自造）:' + r33.join('、'));
    }
    v = 33;
  }

  if (v < 34) {
    /* v0.9.95 —— 出厂「默认」模版的口径纠偏。
     *
     * 病根：defaultTemplate() 硬编码 `engine:'sd'`，但它挂的 spec 是 DEFAULT_SPEC，
     *   第一行写着「# 一致性规范（Krea2 口径）」。自相矛盾。
     *   用户点「新建」时 addTemplate 复制当前模版 → 一路继承错口径
     *   → 中文锚点被整段剥掉、组装退回 SD 单串。
     *   实测病例：用户自建的「Anime模型-TAG+自然语」标成了 sd。
     *
     * ⚠️ 判定必须保守：只纠**名字是「默认」且 spec 仍是 Krea2 口径开头**的那一份
     *   （= 没被用户改过口径的出厂副本）。用户自己把 spec 换成 SD 口径的，
     *   首行就不是这个标题了，一律不碰。用户自建的其他模版也不碰
     *   —— 那些由用户在面板上自己选（见 panel.js 的「引擎口径」下拉）。
     */
    const d = cfg.templates?.['默认'];
    const dSpec = String(d?.spec || '');
    if (d && d.engine !== 'k2' && dSpec.startsWith('# 一致性规范（Krea2 口径）')) {
      d.engine = 'k2';
      changes.push('「默认」模版口径已纠偏为 K2（其 spec 本就是 Krea2 口径，历史标错）');
    }
    v = 34;
  }

  if (v < 35) {
    /* v0.9.96 —— SD 口径专属输出开关落库。
     *
     * 纯新增默认值，不迁移任何存量数据：
     *   · 档案字段一个都不改（sex / 自定义字段原样保留）
     *   · 动态字段排除是**读时生效**（anchorOf 判定），不是写时删除
     *     → 用户随时可在档案页把某一栏拉回「两口径」
     */
    if (!cfg.sdOptions || typeof cfg.sdOptions !== 'object') {
      cfg.sdOptions = { countTags: true, breakSeparator: false, excludeDynamic: true };
      changes.push('SD 输出结构开关已就绪（人数词 / BREAK / 排除动态字段）');
    }
    // 旧版试做的 perCharBlock 没有可观察效果（角色段本来就靠人数词开启新段）→ 清掉
    if ('perCharBlock' in cfg.sdOptions) delete cfg.sdOptions.perCharBlock;
    v = 35;
  }

  if (v < 36) {
    /* v0.9.97 —— SD 模版正文整体升级到 v3（纯 tag 口径）。
     *
     * 用户原话（2026-10-18）：「你现在看我 SD漫画宫格里的模版规格，里面需要大改，
     *   因为之前偷懒用的时候复制了些 K2 里的规则，所以里面规则很混乱。」
     *   以及：「什么盆骨对齐那些，在 SD 反而是负面，SD 下越简洁明了的单词反而更容易理解。」
     *
     * 旧文混进的 K2 规则（真实危害）：
     *   · 要求写「his hips aligned with hers」这类句子 → 输出全是词典里没有的词（噪声）
     *   · 要求模型自己写人数词 / 分角色段 → 插件也写一份 ⇒ `1girl, 1girl`、两人挤一段（串台）
     *   · 420 字符硬预算 → 与「人物外貌本来就长，放宽」冲突
     *   · §2.3 让写 `no_shoes`，§3.7 又说否定句会被画成有鞋 → 自相矛盾
     *
     * 判定保守：只替换**首行是本项目 Illustrious 口径标题**的 sd 模版（= 真正在跑 SD 的那份）；
     * 用户完全重写过的（首行不是它）一律不碰。旧文全文备份到 legacySpecV096，可随时回滚。
     */
    const patched = [];
    for (const [name, t] of Object.entries(cfg.templates || {})) {
      if (!t || t.engine !== 'sd') continue;
      const spec = String(t.spec || '');
      if (!spec.startsWith('# 一致性规范（Illustrious')) continue;   // 不是本项目的 SD 正文 → 不碰
      if (spec === SD_SPEC_V4) continue;                             // 已是新版
      t.legacySpecV096 = spec;
      t.spec = SD_SPEC_V4;
      /**
       * system / protocol 一起换：旧 system 写着「画面 tag 必须照抄库里的字段值」，
       * 与新分工（外貌由插件注入）直接冲突 —— 模型照抄 = 每张图外貌写两遍。
       * 只在这两段是**旧版原文**时才替换，用户自己改过的不碰。
       */
      if (String(t.system || '').includes('画面 tag 必须照抄库里的字段值')) {
        t.legacySystemV096 = t.system;
        t.system = SD_SYSTEM_V4;
      }
      if (String(t.protocol || '').includes('1girl, @角色名')) {
        t.legacyProtocolV096 = t.protocol;
        t.protocol = SD_PROTOCOL_V4;
      }
      patched.push(name);
    }
    if (patched.length) {
      changes.push(`SD 模版正文已重写为纯 tag 口径 v3（去掉 K2 自然语规则 / 统一空格 / 与插件分工）：${patched.join('、')}（旧文备份在 legacySpecV096）`);
    }
    v = 36;
  }

  if (v < 37) {
    /* v0.9.101 —— 成人剧情的跨格 / 跨楼延续（用户 2026-10-19 报）。
     *
     * 症状：正文已经写到抽插 / 撞击，同一场戏后几张图的 tag 只剩 sweat / trembling / on bed，
     *   没有任何行为 tag。前一张有、后一张突然没了。
     *
     * 根因（两条，都在「强制层」，不是模型不听话）：
     *   ① SD 的输出协议只写「每张图按 §四 六维度各选 1~2 个」——
     *      §四.3「动作与持物」词表是 walking / eating / hug / holding cup，**没有性行为**。
     *      模型照协议填表 → 行为 tag 根本不进输出。SD v4 把它改成 SFW/NSFW 二选一分支，
     *      并补 §5.11 五阶段 + 跨格延续。
     *   ② K2 有 §3.9 ④b 阶段表，但没有「跨图必须重述」这一条 ——
     *      「只写一次」被泛化成跨图规则，模型就把已经在进行的行为删掉了。
     *
     * 迁移口径（保守，只动「认出是出厂文本」的）：
     *   · SD：首行是本项目 Illustrious 标题且写着 v3 → 整篇换 v4（旧文备份 legacySpecV0100）
     *   · K2：spec 里有 §3.9 阶段表、但没有「每格重述」→ 在阶段表后定点插入一段，不动其他内容
     */
    const sdPatched = [];
    const k2Patched = [];
    const k2ProtoPatched = [];
    /**
     * K2 公共协议补丁（★ 覆盖全部 6 份 K2 模版，不只 NSFW）。
     *
     * 用户 2026-10-19 当场指出：「你改了 K2 的同时记得把其他 K2 都同步更新好，
     * 就更新了一个 K2，其他 K2 口径没同步。」—— 之前只改了 NSFW 的 §3.9 spec，
     * 而「跨图状态必须重述」是**所有 K2 模版**都要的（日常动作、姿态同样会丢）。
     * 所有 K2 模版都走 DEFAULT_PROTOCOL（+ 各自 addon），所以补在这一层一次覆盖 6 份。
     */
    const K2_PROTO_MARK = '跨图：构图换，状态留';
    const K2_PROTO_ANCHOR = '- 不需要配图时返回 `{"changes":[...],"images":[]}`。';
    const K2_PROTO_INSERT = [
      '- ★ **跨图：构图换，状态留**（v0.9.101，所有 K2 模版通用）：',
      '  - **构图**（机位 / 景别 / 同一个瞬间的措辞）—— 上一张画过就换，不复述；',
      '  - **状态**（正在进行的动作与体位、已脱到的程度、已确立的接触点、已留下的痕迹）——',
      '    这一楼还在这场戏里，就必须**再写一遍**（K2 写进 `cast[].en` 的姿态句）。',
      '  - `tag` / `cast[].en` 是**逐张独立生成**的，模型不会记得上一张：**不写 ≠ 延续，等于这张图里没有这件事**。',
      '  - 判据：把这条删掉，这张图还成立吗？不成立 = 必须写；只是换个机位也成立 = 才是可选细节。',
      K2_PROTO_ANCHOR,
    ].join('\n');
    const K2_ANCHOR = '- ⚠️ 跨楼推进时阶段**只能前进或保持**，不许凭空倒退（余韵之后又画回前戏）。';
    const K2_INSERT = [
      K2_ANCHOR,
      '- ★★ **每格重述（v0.9.101）**：`cast[].en` 是**逐张独立生成**的，模型不会记得上一张。',
      '  上一格写明 `his cock inside her, his hips aligned with hers`，这一格这场戏还没结束就必须**再写一遍**',
      '  （可换措辞、可换节奏、可换机位）—— **这不算「重复」**。',
      '  §3.9 ③ 的「只写一次」管的是**同一张图内部**（同一件事物出现两次＝多画一份几何），',
      '  不管跨图：跨图删掉行为句 = 这一张没有这件事。',
      '  判据：**删掉这句，这张图还成立吗？** 不成立 = 必须写；只是换个机位也成立 = 才是可选细节。',
    ].join('\n');

    for (const [name, t] of Object.entries(cfg.templates || {})) {
      if (!t || typeof t !== 'object') continue;
      const spec = String(t.spec || '');

      // —— SD：v3 正文 → v4 ——
      if (t.engine === 'sd' && spec.startsWith('# 一致性规范（Illustrious')
        && spec.includes('纯 tag 口径 v3') && spec !== SD_SPEC_V4) {
        if (!t.legacySpecV0100) t.legacySpecV0100 = spec;
        t.spec = SD_SPEC_V4;
        // system / protocol 同步：只在这两段还是 v3 原文时换（用户改过的不碰）
        if (String(t.system || '').includes('你在 images[].tag 里**只写画面公共区**')
          && !String(t.system || '').includes('成人剧情')) {
          t.legacySystemV0100 = t.system;
          t.system = SD_SYSTEM_V4;
        }
        if (String(t.protocol || '').includes('每张图按规范 §四 的 6 个维度')) {
          t.legacyProtocolV0100 = t.protocol;
          t.protocol = SD_PROTOCOL_V4;
        }
        sdPatched.push(name);
        continue;
      }

      // —— K2 全部 6 份模版：公共协议补「跨图：构图换，状态留」——
      // 默认 / K2 中英混合 / 带风格化 / 纯英文单段 / NSFW / NSFW·带风格化
      // 都走 DEFAULT_PROTOCOL（+ 各自 addon），所以一处补丁覆盖全部。
      if (t.engine === 'k2'
        && !String(t.protocol || '').includes(K2_PROTO_MARK)
        && String(t.protocol || '').includes(K2_PROTO_ANCHOR)) {
        t.protocol = String(t.protocol).replace(K2_PROTO_ANCHOR, K2_PROTO_INSERT);
        k2ProtoPatched.push(name);
      }

      // —— K2（含 NSFW 版）：阶段表在、但缺「每格重述」→ 定点插入 ——
      if (t.engine === 'k2' && spec.includes('### 3.9 NSFW 板块')
        && !spec.includes('每格重述') && spec.includes(K2_ANCHOR)) {
        t.spec = spec.replace(K2_ANCHOR, K2_INSERT);
        k2Patched.push(name);
      }
    }
    if (sdPatched.length) {
      changes.push(`SD 模版升级 v4（NSFW 判定放宽 + 五阶段 + 进行中每格重述）：${sdPatched.join('、')}（旧文备份在 legacySpecV0100）`);
    }
    if (k2ProtoPatched.length) {
      changes.push(`K2 模版补「跨图：构图换、状态留」：${k2ProtoPatched.join('、')}`);
    }
    if (k2Patched.length) {
      changes.push(`K2 NSFW 模版补「跨图必须重述进行中行为」：${k2Patched.join('、')}`);
    }
    v = 37;
  }

  if (v < 38) {
    /* v0.9.112 —— 「动作段堆同义重复词」导致肢体扭曲（用户 2026-10-20 报）。
     *
     * 用户原话：「multi view 不是主要原因，主要原因是我发现后续动作段就有很多冲突词。
     *   这才是关键。因为之前我最早期没出现这个问题，是最近出的。」
     * 以及：「早期动作词只会出少数描述当前动作，而不会反复重复类意思去强调。」
     *
     * 真机病例（动作段）：
     *   ..., vaginal, penis, pussy, penetration, from behind, close up, profile, face
     *   三个机位景别词并存 + 行为写两遍 + 禁词 penetration。
     *
     * 根因在 v4 正文的**写法**，不是模型突然变笨：
     *   ① §2.1 把顺序表从 8 类拆成 9 类（动作/承重面/接触/表情/视线/景别/机位/场景/光线），
     *      每类都配了「必写 / 缺一项必崩」的语气 → 模型当成 9 项必填清单，逐项打勾、超量填写。
     *   ② §5.11 原文「需要换掉的只有构图（机位 / 景别 / **同一个瞬间的措辞**）」——
     *      「措辞」二字等于教模型「换个说法再写一遍」，于是 vaginal → penetration → sex 轮着写。
     *   ③ §七自检 8「四项齐了吗」只问「齐不齐」，没说「多写算不算」→ 模型按"多写更保险"办。
     *
     * v4 修订（不加词表、不加约束，全是**做减法**）：
     *   · 新增 §零.3「一个意思只写一条」铁律（含对照表：写两条 → 模型画两遍）
     *   · §2.1 补「九类每类只写 1 条，写满 ≈12 个 tag 已经够了」
     *   · §2.4 补「机位不许并列（并列 → 朝向取平均 → 扭身）」
     *   · §5.3 补「sex + vaginal 是允许的一对，不许再叠第三个」
     *   · §5.11 删掉「措辞」，改成「原样再写一次，不要换同义词」
     *   · §七自检 8/9 补「多写第 2 条不是加分」
     *
     * 判定口径：只替换**首行是本项目 Illustrious 标题**的 sd 模版（用户完全重写过的永远不碰）。
     * 旧文备份到 `legacySpecV0112`，可随时回滚。
     */
    const sdPatched = [];
    for (const [name, t] of Object.entries(cfg.templates || {})) {
      if (!t || t.engine !== 'sd') continue;
      const spec = String(t.spec || '');
      if (!spec.startsWith('# 一致性规范（Illustrious')) continue;   // 不是本项目正文 → 不碰
      if (spec === SD_SPEC_V4) continue;                             // 已是修订版
      if (spec.includes('一个意思只写一条')) continue;                // 已手工改过（幂等）
      t.legacySpecV0112 = spec;
      t.spec = SD_SPEC_V4;
      // system / protocol 同步：只在认出是旧版出厂文本时替换（用户改过的不碰）
      if (String(t.system || '').includes('分工（务必遵守）') && String(t.system || '').includes('你只负责')) {
        t.system = SD_SYSTEM_V4;
      }
      if (String(t.protocol || '').includes('输出协议（不要删除本节）')
        && String(t.protocol || '').includes('只写画面公共区')) {
        t.protocol = SD_PROTOCOL_V4;
      }
      sdPatched.push(name);
    }
    if (sdPatched.length) {
      changes.push(`SD 模版修订「一个意思只写一条」（治动作段堆同义重复词 → 肢体扭曲）：${sdPatched.join('、')}（旧文备份在 legacySpecV0112）`);
    }
    v = 38;
  }

  if (v < 39) {
    /* v0.9.113 —— `lying` 与朝向词二选一（用户 2026-10-20 直接质疑）。
     *
     * 用户原话：「提示词里有了一个躺卧 TAG 后，为啥还要加个俯卧 TAG？」
     * 真机病例：`lying, on desk, on stomach, ...` —— 三条姿态词同时存在。
     *
     * 语义依据：danbooru 的 `lying` 是上位词（画出来默认仰卧），
     *   `on stomach`（俯卧）/ `on back`（仰卧）/ `on side`（侧卧）才是它的细分。
     *   同时写 = 给「仰躺」和「俯卧」各一份权重 → 模型只能画一个扭曲的中间态。
     *   和 `socks` + `thighhighs` 是同一条规矩：**精确词优先，泛化词让位**。
     *
     * v4 修订：§2.2 增加「lying 与朝向词二选一」对照表。
     * 判定口径：只替换首行是本项目 Illustrious 标题的 sd 模版（用户重写过的永远不碰）。
     * 旧文备份到 `legacySpecV0113`。
     */
    const sdPatched2 = [];
    for (const [name, t] of Object.entries(cfg.templates || {})) {
      if (!t || t.engine !== 'sd') continue;
      const spec = String(t.spec || '');
      if (!spec.startsWith('# 一致性规范（Illustrious')) continue;   // 不是本项目正文 → 不碰
      if (spec.includes('lying') && spec.includes('上位词')) continue;  // 已含本节 → 幂等
      t.legacySpecV0113 = spec;
      t.spec = SD_SPEC_V4;
      sdPatched2.push(name);
    }
    if (sdPatched2.length) {
      changes.push(`SD 模版修订「lying 让位给 on stomach / on back / on side」（治姿态上下位词并存 → 身体朝向打架）：${sdPatched2.join('、')}（旧文备份在 legacySpecV0113）`);
    }
    v = 39;
  }

  if (v < 40) {
    /* v0.9.117 —— 新增第三档口径「MOSS-Image（自然语 + TAG 混写）」。
     *
     * 用户 2026-10-21 新建了模版「MOSS（多格漫画）」但内容没填，原话：
     *   「里面内容没有填。然后就是 一致性规范这里我也改动不了
     *     （删除改动后我点保存还是会还原，所以得你来填）」
     * 实测 settings.json：engine=k2 / spec 被 upgradeTemplates 填成 Krea2 原文 /
     *   system 空 / protocol 空 —— 「还原」就是这个自动填充干的（不是用户操作问题）。
     *
     * 本迁移做三件事：
     *   ① 认出「engine 已是 moss」或「名字带 MOSS」且 spec 仍是自动填充空壳的模版
     *      → 整体换成 MOSS 出厂文本，engine 一并纠正成 'moss'；
     *   ② 一份都没有 → 新建一份（**不抢 activeTemplate**，用户自己在模版页选）；
     *   ③ 旧文备份到 legacySpecV0117，可随时回滚。
     * 判定口径：只动「空壳」，用户自己写过的 MOSS 正文一律不碰。
     */
    const tpls = cfg.templates && typeof cfg.templates === 'object' ? cfg.templates : null;
    if (tpls) {
      const mossPatched = [];
      for (const [tname, t] of Object.entries(tpls)) {
        if (!t || typeof t !== 'object') continue;
        const spec = String(t.spec || '');
        if (spec.includes(MOSS_SPEC_MARK)) continue;          // 已是本版正文 → 幂等
        const looksMoss = t.engine === 'moss' || /moss/i.test(tname);
        if (!looksMoss) continue;
        const autoFilled = !spec.trim()
          || spec.startsWith('# 一致性规范（Krea2 口径）')
          || spec.startsWith('# 一致性规范（Anime 口径）');
        if (!autoFilled) continue;                            // 用户自己写的 MOSS 正文，不碰
        const fresh = defaultMossTemplate(tname);
        if (spec.trim()) t.legacySpecV0117 = spec;
        t.engine = 'moss';
        t.variant = 'en';
        t.spec = fresh.spec;
        // system / protocol 只在「空着」或「仍是出厂默认」时替换 —— 用户改过的一律保留
        const sys = String(t.system || '');
        if (!sys.trim() || sys.startsWith(DEFAULT_SYSTEM.slice(0, 40))) t.system = fresh.system;
        const proto = String(t.protocol || '');
        if (!proto.trim()) t.protocol = fresh.protocol;
        else if (proto.includes('# 输出协议') && !proto.includes('MOSS 口径补充')) {
          t.protocol = applyMossProtocolPatches(proto) + MOSS_PROTOCOL_ADDON;
        }
        if (!String(t.jailbreak || '').trim() && fresh.jailbreak) t.jailbreak = fresh.jailbreak;
        mossPatched.push(tname);
      }
      if (!Object.values(tpls).some((t) => t && t.engine === 'moss')) {
        let nm = 'MOSS（多格漫画）';
        let i = 2;
        while (Object.prototype.hasOwnProperty.call(tpls, nm)) nm = `MOSS（多格漫画）${i++}`;
        tpls[nm] = defaultMossTemplate(nm);
        mossPatched.push(`新建「${nm}」`);
      }
      if (mossPatched.length) {
        changes.push(`MOSS 口径模版就位（自然语+Tag · 多格漫画/单图剧情 · 单串整段）：${mossPatched.join('、')}（旧文备份在 legacySpecV0117）`);
      }
    }
    v = 40;
  }

  if (v < 41) {
    /* v0.9.118 —— 修 MOSS 口径三个真实出图问题（用户 2026-10-21 凌晨看楼层后的反馈）：
     *   ① 人物漂移：P22 抄了外貌 / P8 只剩发色 / P17 一个字都没有 → 女主画成棕发丸子头。
     *      病因是 v0.9.117 的 spec 写了「外貌只在第一次出场那格写全一次」（跨图被理解成一次），
     *      **且不注入人物段**。修法 = 插件机械注入英文人物段 + spec 改成「你不要写外貌」。
     *   ② 台词全空：四张图都是 `reads " "`。病因是「禁止写中文，中文放 nl」与
     *      「不要输出 nl」两条规则互相抵消 → 模型把中文彻底删掉。修法 = prompts.js 分叉。
     *   ③ 结构：人物段要早于分格，段落顺序写进 spec。
     *
     * 判定口径：只刷新「仍是 v0.9.117 出厂正文」的 moss 模版（用旧 §3.3 标题 + 缺新标记双重认定），
     * 用户自己改写的正文一律不碰。
     */
    const tpls = cfg.templates && typeof cfg.templates === 'object' ? cfg.templates : null;
    if (tpls) {
      const refreshed = [];
      for (const [tname, t] of Object.entries(tpls)) {
        if (!t || typeof t !== 'object' || t.engine !== 'moss') continue;
        const spec = String(t.spec || '');
        if (spec.includes(MOSS_SPEC_MARK)) continue;                    // 已是最新 → 幂等
        if (!spec.includes('### 3.3 台词与气泡（MOSS 漫画的硬要求')) continue; // 不是 v0.9.117 正文 → 不碰
        const fresh = defaultMossTemplate(tname);
        t.legacySpecV0118 = spec;
        t.spec = fresh.spec;
        t.variant = 'en';
        const sys = String(t.system || '');
        if (/MOSS-Image 口径（自然语 \+ TAG 混写）/.test(sys)) t.system = fresh.system;
        const proto = String(t.protocol || '');
        const cut = proto.indexOf('## MOSS 口径补充');
        if (cut > 0) t.protocol = applyMossProtocolPatches(proto.slice(0, cut).trimEnd()) + '\n' + MOSS_PROTOCOL_ADDON;
        else if (!proto.trim()) t.protocol = fresh.protocol;
        refreshed.push(tname);
      }
      if (refreshed.length) {
        changes.push(`MOSS 模版修订「人物段插件注入 + 台词必填中文 + 段落顺序」：${refreshed.join('、')}（旧文备份在 legacySpecV0118）`);
      }
    }
    v = 41;
  }

  if (v < 42) {
    /* v0.9.119 —— MOSS 口径不再照搬 SD / K2 的规则。
     *
     * 用户原话（2026-10-21）：
     *   「spec 里某处仍写着『禁止在 tag 里写中文』，这个是对于其他口径而言的，
     *     但是很多规则对 MOSS 不合适。为啥因为 MOSS 都能支持」
     *   「所以对于其他口径的一些东西不能照搬。」「以官方为准比较好些。」
     *
     * 三处结构性变更：
     *   ① §一§二 换成 MOSS 专属：原来是 SD/K2 的「在 tag 里**逐字照抄** hair / eyes / outfit」，
     *      与 v0.9.118 的「插件注入人物段」直接冲突 —— 同一件事被描述两次，
     *      MOSS 会做语义平均、折中成模糊态（本项目第 7 次「两条规则互相抵消」）。
     *   ② 台词取消 12 字上限：用户选定「完全取消上限，原话多长写多长」，
     *      太长就拆格 / 拆图 / 留到后面楼层，**不删字**。
     *   ③ `cast` 支持 `look`：没档案的临时角色（巡查员 / 店员 / 路人）也要有人物段。
     *
     * 判定口径：只刷新「仍是 v0.9.118 出厂正文」的 moss 模版。用户自己改写的正文一律不碰。
     */
    const tpls42 = cfg.templates && typeof cfg.templates === 'object' ? cfg.templates : null;
    if (tpls42) {
      const refreshed = [];
      for (const [tname, t] of Object.entries(tpls42)) {
        if (!t || typeof t !== 'object' || t.engine !== 'moss') continue;
        const spec = String(t.spec || '');
        if (spec.includes(MOSS_SPEC_MARK)) continue;                 // 已是最新 → 幂等
        const isOldFactory = spec.includes('### 3.3 台词与气泡（MOSS 漫画的硬要求')
          || spec.includes('一条台词不超过 **12 个字**')
          || (spec.includes('# 一致性规范（MOSS-Image 口径）') && spec.includes('逐字照抄'));
        if (!isOldFactory) continue;                                 // 用户自改正文 → 不碰
        const fresh = defaultMossTemplate(tname);
        t.legacySpecV0119 = spec;
        t.spec = fresh.spec;
        const sys = String(t.system || '');
        if (/MOSS-Image 口径（自然语 \+ TAG 混写）/.test(sys)) t.system = fresh.system;
        const proto = String(t.protocol || '');
        const cutP = proto.indexOf('## MOSS 口径补充');
        if (cutP > 0) t.protocol = applyMossProtocolPatches(proto.slice(0, cutP).trimEnd()) + '\n' + MOSS_PROTOCOL_ADDON;
        else if (!proto.trim()) t.protocol = fresh.protocol;
        refreshed.push(tname);
      }
      if (refreshed.length) {
        changes.push(`MOSS 模版改为「专属 §一§二 + 台词不限字数 + 路人 look 兜底」：${refreshed.join('、')}（旧文备份在 legacySpecV0119）`);
      }
    }
    v = 42;
  }

  if (v < 43) {
    /* v0.9.120 —— 多人串人：从「纯指代」改成「每格带身份锚点」。
     *
     * 用户原话（2026-10-21）：
     *   「我发现角色还是容易串，是不是写法需要改变？每个格子是不是都是独立的？」
     *   「我用同样的提示词重复生成抽了一下发现问题不小，还会出现人物串出多一个人，
     *     外貌锚定也不行。」
     *
     * 实测（本机 4 / 6 / 8 人 × 两种写法，同一 seed）：
     *   纯指代 → **6 人起局部格整人换掉**：Panel 4 要「凯递纸条 + 雪见在后面看」，
     *            画出来是浅金发的艾玛 + 深色皮肤的迅，凯和雪见根本没出现；
     *   短锚点 → 4 / 6 / 8 人的局部格**全部正确**；8 人时只有群像格多画 1 人。
     *
     * 官方依据（MOSS二次元提示词模板_sfw版）：
     *   §8.4 「多格角色重复出现要**在每格重述身份**，不把 multi_panel 当作跨格一致性功能」
     *   §13.2「每个 character caption **自带发色发型、衣服主色**、动作、视线」
     *   §14  坑表「多人串色串衣 → **独立主语绑定属性**」
     *   §2.1「二格/四格漫画 … **不保证跨格脸一致**」
     * ⇒ 我 v0.9.119 写的「格内用 the girl 指代就够了」是错的，与官方直接冲突。
     *
     * 判定口径：只刷新「仍是旧出厂正文」的 moss 模版，用户自己改写的正文一律不碰。
     */
    const tpls43 = cfg.templates && typeof cfg.templates === 'object' ? cfg.templates : null;
    if (tpls43) {
      const refreshed = [];
      for (const [tname, t] of Object.entries(tpls43)) {
        if (!t || typeof t !== 'object' || t.engine !== 'moss') continue;
        const spec = String(t.spec || '');
        if (spec.includes(MOSS_SPEC_MARK_V0120)) continue;             // 已是最新 → 幂等
        const isOldFactory = spec.includes('指代就够了')
          || spec.includes('跨格指代要逐字复用同一个短语');
        if (!isOldFactory) continue;                                   // 用户自改正文 → 不碰
        const fresh = defaultMossTemplate(tname);
        t.legacySpecV0120 = spec;
        t.spec = fresh.spec;
        const sys = String(t.system || '');
        if (sys.includes('指代即可') || sys.includes('MOSS-Image 口径（自然语 + TAG 混写）')) {
          t.system = fresh.system;
        }
        const proto = String(t.protocol || '');
        const cutP = proto.indexOf('## MOSS 口径补充');
        if (cutP >= 0) t.protocol = applyMossProtocolPatches(proto.slice(0, cutP).trimEnd()) + '\n' + MOSS_PROTOCOL_ADDON;
        else if (!proto.trim()) t.protocol = fresh.protocol;
        refreshed.push(tname);
      }
      if (refreshed.length) {
        changes.push(`MOSS 模版改为「每格带身份锚点」（治多人串人）：${refreshed.join('、')}（旧文备份在 legacySpecV0120）`);
      }
    }
    /**
     * ★★★ v0.9.121：MOSS 分成两个版本（纯 prompt / JSON Layout），两版都要刷新。
     *
     * 起因（用户 2026-10-21）：「我刚才在这里新建了一个模版，复制的 MOSS 之前的模版然后
     * 改了个名…你可以分别按新的测试和完善这 2 个版本，一个纯 prompt，一个 JSON。
     * 这样我自己也有选择。简单的用纯 prompt，复杂就能切 JSON 生图。」
     *
     * ① **纯 prompt 版**：§1.1 补三条本轮实测判据（收束句只对 3~6 人有效 /
     *    同框两人上衣必须不同 / 上一格出现过的人这一格必须再写一次），
     *    并修掉一处自相矛盾（原 §1.1 教 `no one else in the frame` 否定句，
     *    与 §3.5「禁止否定表述」直接冲突 —— MOSS 会把否定词当肯定画）。
     *
     * ② **JSON Layout 版**：整份换成 Layout 口径。
     *    ★ 怎么认出哪个是 JSON 版：**首次迁移按模版名里有没有 `JSON`**
     *      （用户自己命名的「MOSS(多格漫画)_JSON版」），之后一律看 `output` 字段。
     *      名字判据只用这一次 —— 认错了用户可以在 UI 的「输出格式」下拉里改回来。
     *      这也解释了为什么不用内容判据：两个版本在迁移前**正文完全相同**（它就是复制的），
     *      内容上根本分不出来。
     *
     * 判定口径同 v43：只刷新「仍是出厂正文」的，用户自己改写的正文一律不碰；
     * 旧文备份到 `legacySpecV0121`。
     */
    const tpls44 = cfg.templates && typeof cfg.templates === 'object' ? cfg.templates : null;
    if (tpls44) {
      const refPlain = [];
      const refJson = [];
      for (const [tname, t] of Object.entries(tpls44)) {
        if (!t || typeof t !== 'object' || t.engine !== 'moss') continue;
        const spec = String(t.spec || '');

        /* ── JSON Layout 版 ── */
        const wasJson = t.output === 'layout';
        const maybeJson = wasJson || (!t.output && /json/i.test(String(tname)));
        if (maybeJson) {
          if (spec.includes(MOSS_JSON_SPEC_MARK)) {
            // 正文已是最新，但 output 标记可能还没写上（老存档）
            if (t.output !== 'layout') t.output = 'layout';
            continue;
          }
          t.legacySpecV0121 = spec;
          const fresh = defaultMossJsonTemplate(tname);
          t.output = 'layout';
          t.variant = 'en';
          t.spec = fresh.spec;
          t.system = fresh.system;
          t.protocol = fresh.protocol;
          if (!t.jailbreak || !String(t.jailbreak).trim()) t.jailbreak = fresh.jailbreak;
          refJson.push(tname);
          continue;
        }

        /* ── 纯 prompt 版 ── */
        if (spec.includes(MOSS_SPEC_MARK_V0121)) {
          /**
           * ★ 正文已是最新也要补 `output` 标记。
           *   真实场景：老存档会**链式**跑完 v1→v43→v44，而 v43 那一步用的是
           *   「当前源码里的 defaultMossTemplate()」—— 它已经带着 v0.9.121 的新正文，
           *   于是 v44 这步判「已最新」直接跳过，`output` 就永远补不上（实测踩到）。
           *   没有 output 时 `activeOutput()` 兜底成 'text' 也能跑，
           *   但 UI 下拉会显示空白、用户以为没生效。
           */
          if (t.output !== 'text') t.output = 'text';
          continue;
        }
        const isFactory = spec.includes(MOSS_SPEC_MARK_V0120)
          || spec.includes('指代就够了')
          || spec.includes('跨格指代要逐字复用同一个短语');
        if (!isFactory) continue;                            // 用户自改正文 → 不碰
        t.legacySpecV0121 = spec;
        t.spec = defaultMossTemplate(tname).spec;
        refPlain.push(tname);
      }
      if (refPlain.length) {
        changes.push(`MOSS 纯 prompt 版补多人实测判据（构图收束 / 同框上衣不能同款 / 跨格重述）：${refPlain.join('、')}（旧文备份在 legacySpecV0121）`);
      }
      if (refJson.length) {
        changes.push(`新增 MOSS JSON Layout 版口径（坐标分格 · 每角色一项 · 台词 text 项）：${refJson.join('、')}`);
      }
    }
    v = 44;
  }

  if (v < 45) {
    /**
     * v44 → v45：MOSS JSON Layout 版拆出专属口径（`cfg.mossJson`）。
     *
     * 旧版（v44）JSON 版与纯 prompt 版共用 `cfg.moss`，切版本时形态/排版跟着跑，
     * 正是用户要求避免的「切其他的就完全没法用」。
     * ★ 只补字段、**不动**已有 `cfg.moss`：纯 prompt 版的行为必须一字不变。
     */
    if (!cfg.mossJson || typeof cfg.mossJson !== 'object') {
      cfg.mossJson = { mode: 'multi', layout: 'random', gword: 'caption' };
      changes.push('MOSS JSON Layout 版拆出独立口径（形态 / 排版 / 全局词库落点），与纯 prompt 版互不影响');
    } else {
      // 半残配置（手工改过 / 早期测试写过）→ 缺什么补什么，已有值一律保留
      const d = { mode: 'multi', layout: 'random', gword: 'caption' };
      for (const k of Object.keys(d)) if (cfg.mossJson[k] == null) cfg.mossJson[k] = d[k];
      if (!['auto', 'multi', 'single'].includes(cfg.mossJson.mode)) cfg.mossJson.mode = d.mode;
      if (!['caption', 'off'].includes(cfg.mossJson.gword)) cfg.mossJson.gword = d.gword;
    }
    v = 45;
  }

  if (v < 46) {
    /**
     * v45 → v46：MOSS 加「剧情模式」（`nsfw: auto | sfw | nsfw`）。
     *
     * ★ 只补缺失字段，**不动**已有的 `mode` / `layout` / `gword`：
     *   老用户升级后行为必须一字不变 —— `auto` 就等价于旧行为（看 `adultPosePriority`）。
     *   两版各存一份：`cfg.moss`（纯 prompt）与 `cfg.mossJson`（Layout），
     *   否则在 A 版切 sfw 会跟到 B 版，正是用户最怕的「切过去就完全没法用」。
     */
    const ensureNsfw = (box, label) => {
      if (!box || typeof box !== 'object') return;
      if (!['auto', 'sfw', 'nsfw'].includes(box.nsfw)) {
        box.nsfw = 'auto';
        if (label) changes.push(`${label}新增「剧情模式」= 自动（沿用「成人画面优先」开关）`);
      }
    };
    ensureNsfw(cfg.moss, 'MOSS 纯 prompt 版');
    ensureNsfw(cfg.mossJson, 'MOSS JSON Layout 版');
    v = 46;
  }

  if (v < 47) {
    /**
     * v46 → v47：MOSS JSON 版 spec 换成「多格口径」（用户 2026-10-22）。
     *
     * 用户原话：「现在的 spec 大多都是从 K2 那里搬过来的吧？……其实 K2 那里很多都不可用，
     * 完全可以大改或者抛弃他的一些没用的东西，特别是和现有规则冲突的」。
     * 「毕竟之前写的 K2 都只是为了单图出，现在的是多图当然以 NAI 为优先级」。
     *
     * 三处**真实冲突**（不是风格问题，是会让画面出错的规则打对台）：
     *   ① §一 要求「写全外貌 + 每件衣服带颜色」≈ 35 词，§3.6 又卡 35~70 词 ——
     *      成人画面要求的六项（体位 / 体液 / 衣物边界 / 器官 / 骨盆 / 表情）没有额度可写，
     *      实测输出只剩一句 `thrusts into her from behind`，这正是用户报的「完全没有写」；
     *   ② §3.2 硬编码三格 `H*0.32 / 0.34 / 0.65` 等比例表 —— v0.9.126 起版式是每次抽的
     *      六种不等分几何，旧表跟末尾的坐标指令**互相矛盾**，模型会照旧表画等分；
     *   ③ §1.1 要求跨格「重述同一身份特征」= 又抄一遍完整外貌 —— 同 ① 的额度问题。
     *
     * ★ 只刷「认得出是出厂正文」的模版：标志串对不上就说明用户自己改写过，一律不碰
     *   （和 `upgradeTemplates` 里 MOSS 那几个块同一口径）。
     */
    const tpls47 = cfg.templates && typeof cfg.templates === 'object' ? cfg.templates : null;
    if (tpls47) {
      const refJson = [];
      for (const [tname, t] of Object.entries(tpls47)) {
        if (!t || typeof t !== 'object' || t.engine !== 'moss') continue;
        const spec = String(t.spec || '');
        const isJson = t.output === 'layout' || (!t.output && /json/i.test(String(tname)));
        if (!isJson) continue;
        if (spec.includes(MOSS_JSON_SPEC_MARK_V0129)) {   // 已是最新 → 幂等
          if (t.output !== 'layout') t.output = 'layout';
          continue;
        }
        /**
         * ★★★ 判定「这是不是**没被用户改写过的**出厂正文」—— 必须用旧版**独有段落**，不能只看标题。
         *
         * 踩点（本版本的测试当场抓到）：旧标题 `## 一、人物：每个角色一个 character 项` 是
         * 用户那份 spec 的**前缀**（用户从出厂文本改出来的，标题通常原样留着），
         * 只判标题的话，用户自己写的规则会被整篇覆盖 —— 那是人设主权区，绝对不能动。
         *
         * 所以要求旧版的**三句特征正文全部在**（各自都很长、且只出现在旧版里）：
         *   ① §一 开头那句「所以这次**必须写全**」；
         *   ② 外貌清单「发色发型 + 瞳色 + 脸型 / 肤色 / 体型 + 穿的每一件衣服」；
         *   ③ 篇幅「35~70 词」。
         * 少任何一句就说明用户动过 → 不碰。
         */
        const OLD_TRAITS = [
          '所以这次**必须写全**',
          '发色发型 + 瞳色 + 脸型 / 肤色 / 体型',
          '35~70 词',
        ];
        const hits = OLD_TRAITS.filter((t) => spec.includes(t)).length;
        const isFactory = hits === OLD_TRAITS.length;
        if (!isFactory) continue;                          // 用户自改（或认不出）→ 不碰
        t.legacySpecV0129 = spec;
        const fresh = defaultMossJsonTemplate(tname);
        t.output = 'layout';
        t.variant = 'en';
        t.spec = fresh.spec;
        t.system = fresh.system;
        t.protocol = fresh.protocol;
        if (!t.jailbreak || !String(t.jailbreak).trim()) t.jailbreak = fresh.jailbreak;
        refJson.push(tname);
      }
      if (refJson.length) {
        changes.push('MOSS JSON 版 spec 换成多格口径（只写可见部分 / 放宽篇幅 / 版面照抄末尾坐标）：'
          + `${refJson.join('、')}（旧文备份在 legacySpecV0129）`);
      }
    }
    v = 47;
  }

  /* ── v0.9.133：服装章 → NAI 三段式 ── */
  if (v < 48) {
    /**
     * 病历（2026-10-22 楼 202，用户报「女主服装完全漂移没了」）：
     *   配置里跑的仍是 v47 的 §4.1「整页写一次基准…每件带颜色」—— 那是 K2 单图口径。
     *   NAI 没有「整页基准」这个概念，它是「穿搭 DNA + 生效页格变化 + 每格独立完整词」。
     *   模型在旧规则下把 `pink and white maid outfit` 写成 `white apron + white blouse`
     *   （颜色丢、品类换），女主等于换了个人。
     *
     * ★★ 迁移策略：**只替换 §四 服装章这一节**，其他章节一个字不动。
     *    v47 的做法是整篇覆盖 —— 用户只要改过别的章节就会被一起冲掉（虽然有 legacy 备份，
     *    但那仍是拿用户主权区去换）。这里改成段落级：只要 §四 还是出厂正文就换，
     *    用户改过 §四 就完全不动（他自己那套优先级更高）。
     */
    const SEC4_HEAD = '## 四、服装与脱卸边界';
    const SEC4_NEXT = '## 五、';
    const cutSection = (text) => {
      const i = text.indexOf(SEC4_HEAD);
      const j = text.indexOf(SEC4_NEXT, i + 1);
      if (i < 0 || j < 0) return null;
      return { head: text.slice(0, i), body: text.slice(i, j), tail: text.slice(j) };
    };
    /** §四 是否**逐字未改**（hash 比对，见 MOSS_JSON_SEC4_V47_HASH 的说明）。 */
    const isFactorySec4 = (body) => hash32(String(body).replace(/\r\n/g, '\n').trim()) === MOSS_JSON_SEC4_V47_HASH;
    const tpls48 = cfg.templates && typeof cfg.templates === 'object' ? cfg.templates : null;
    if (tpls48) {
      const refJson = [];
      for (const [tname, t] of Object.entries(tpls48)) {
        if (!t || typeof t !== 'object' || t.engine !== 'moss') continue;
        const spec = String(t.spec || '');
        const isJson = t.output === 'layout' || (!t.output && /json/i.test(String(tname)));
        if (!isJson) continue;
        if (spec.includes(MOSS_JSON_SPEC_MARK_V0133)) continue;      // 已是最新 → 幂等
        const cur = cutSection(spec);
        if (!cur) continue;
        if (!isFactorySec4(cur.body)) continue; // §四 被改过 → 不碰
        const fresh = defaultMossJsonTemplate(tname);
        const want = cutSection(String(fresh.spec || ''));
        if (!want || !want.body.includes(MOSS_JSON_SPEC_MARK_V0133)) continue;
        t.legacySpecV0133 = cur.body;                                 // 只备份被换掉的那一节
        t.spec = cur.head + want.body + cur.tail;
        // system / protocol 里与服装相关的那两句同步（找不到就跳过，不动整段）
        if (typeof t.system === 'string') {
          t.system = t.system
            .replace('完整外貌**整页只写一次**（见规范 §3.3）—— 抄全份会挤掉动作与关键细节。',
              '完整**外貌**整页只写一次（见规范 §3.3）—— 抄全份会挤掉动作与关键细节；'
              + '\n  但**衣着每格都要写**（这一格看得见的那部分），不许写「同上」或省掉（见规范 §4.3）。');
        }
        t.output = 'layout';
        refJson.push(tname);
      }
      if (refJson.length) {
        changes.push('MOSS JSON 版服装章换成 NAI 三段式（穿搭 DNA / 生效页格变化 / 逐格完整衣着词）：'
          + `${refJson.join('、')}（被换掉的那一节备份在 legacySpecV0133）`);
      }
      // 认得出是 v47 出厂、但 §四 被用户改过 → 明确告知，让他自己决定
      for (const [tname, t] of Object.entries(tpls48)) {
        if (!t || typeof t !== 'object' || t.engine !== 'moss') continue;
        const spec = String(t.spec || '');
        if (spec.includes(MOSS_JSON_SPEC_MARK_V0133)) continue;
        if (!spec.includes('### 4.1 整页写一次基准')) continue;
        if (!refJson.includes(tname)) {
          changes.push(`「${tname}」的服装章被自定义过，未自动替换（新版规则见默认模版，可自行对照）`);
        }
      }
    }
    v = 48;
  }

  /* ── v0.9.140：漫画页版式库（预置分镜）── */
  if (v < 49) {
    /**
     * v48 → v49：`cfg.mossJson.mangaLayout`（`'random'` 或某个版式 id）。
     *
     * ★ 这是**纯新增**字段，缺失时行为与旧版完全一致（`undefined` → 随机抽版式），
     *   所以不需要任何「认得出才动」的判据；也不许碰 `layout` / `gword` / `nsfw`。
     *   ★ 只补 `mossJson`（JSON Layout 版）—— 纯 prompt 版 `cfg.moss` 没有版式库。
     */
    if (cfg.mossJson && typeof cfg.mossJson === 'object' && cfg.mossJson.mangaLayout == null) {
      cfg.mossJson.mangaLayout = 'random';
    }
    v = 49;
  }

  // 激活态兜底（所有迁移走完后统一校验）：指向的模版必须存在，
  // 否则 engine 口径（activeEngine）会静默回落到 sd，出词结构全错。
  if (!cfg.templates?.[cfg.activeTemplate]) {
    cfg.activeTemplate = Object.keys(cfg.templates || {})[0] || '默认';
    changes.push(`激活模版不存在，已回落到「${cfg.activeTemplate}」`);
  }

  /**
   * ★★★ v0.9.160：MOSS 模版文本刷新 —— **必须放在所有版本分支之后**，且两条出口都要走。
   * 病例见函数头：v0.9.159 的换行口径对用户已存模版完全没生效。
   */
  const mossFresh = refreshMossFactoryTemplates(root);
  if (mossFresh.length) {
    changes.push(`MOSS 模版文本已同步到当前版本（台词改「一项 + 换行」、meta 改体裁、画布示例改 880×1184）：${mossFresh.join('、')}`);
  }

  cfg.version = CONFIG_VERSION;
  if (changes.length) info(STAGE.INIT, `配置迁移 v${CONFIG_VERSION}：${changes.join('；')}`);
}

/**
 * 当前生效的模版内容（**字段缺失**才回落到内置默认）。
 *
 * ★★★ v0.9.117 · 空字符串是用户的**显式意图**，不是「没填」。
 *   旧写法 `t.spec?.trim() ? t.spec : base.spec` 会把「用户主动删空」判成缺项，
 *   于是：UI 里全选删掉 → 保存（存的确实是 ''）→ 下次读配置又被出厂原文填回来
 *   ⇒ 用户看到的就是「删了改动、点了保存、还是还原」。实测 2026-10-21 用户报障。
 *
 *   正确判据只有 `typeof === 'string'`（`undefined` = 从没写过这个字段）。
 *   下面是同一个对象里 jailbreak 那行本来就这么写的 —— 三行 system/spec/protocol
 *   是历史遗留的错误写法，现在对齐。
 *
 *   ⚠️ 副作用（可接受）：用户真把 spec 清空后，出词就真的没有规范文本了。
 *   这是他自己点的，比「偷偷填回出厂文本、让他以为改不动」诚实。
 */
export function getActiveTemplate() {
  const cfg = getConfig();
  const t = cfg.templates?.[cfg.activeTemplate];
  const base = defaultTemplate(cfg.activeTemplate || '默认');
  if (!t) return base;
  return {
    name: t.name || cfg.activeTemplate,
    engine: t.engine === 'k2' || t.engine === 'moss' ? t.engine : 'sd',
    // variant 必须透传 —— K2 三明治组装（composePrompt）靠它判断是否前置写实锚定块。
    // 漏掉它 styled 版会静默退化成 plain（实测踩坑：锚定块不见了）。
    variant: t.variant,
    // NSFW 标记透传（v0.9.29）—— 目前组装层不读它（NSFW 规则全在 spec 文本里给模型看），
    // 传出去是为了 UI 能标出「这个模版带 NSFW 板块」，也便于日后按它做提示。
    nsfw: t.nsfw === true,
    /**
     * ★★★ v0.9.121：模版的**输出格式**（不是引擎口径）。
     *   'text'   —— 纯 prompt（tag 就是最终整段提示词，走文本清洗 + 注入人物段）；
     *   'layout' —— MOSS 原生 JSON Layout（tag 里装的是一份 Layout JSON，
     *               **绝不能过任何文本清洗**：逗号切分/去重/抹换行都会把它拆坏）。
     *   为什么需要显式标记：两种格式走**完全不同的出口**，靠猜（比如"看开头是不是 {"）不可靠 ——
     *   模型偶尔会先吐一句废话再给 JSON，猜错就会把 JSON 当文本清洗。
     */
    // ★ 非 MOSS 口径一律按 text 处理（与 activeOutput 同一条口径，两处都兜住）
    // ★★★ v0.9.157：**`'json'` 必须透传** —— 这里曾经只认 'layout'，
    //   单图 JSON 的口径会在这一层被静默抹成 'text'，然后整条链路按纯 prompt 跑
    //   （插件注入人物段 + 文本清洗），单图模版等于没改。
    output: t.engine === 'moss'
      ? (t.output === 'json' ? 'json' : (t.output === 'layout' ? 'layout' : (t.output === 'manga' ? 'manga' : 'text')))
      : 'text',
    /**
     * ★ v0.9.186：漫画台口径的「一页画几格」。
     *   `multi`（默认）= 多格漫画；`single` = 整页就一张画。
     *   只给 `output:'manga'` 用 —— 其它口径读不到它，行为零变化。
     */
    mangaMode: t.mangaMode === 'single' ? 'single' : 'multi',
    system: typeof t.system === 'string' ? t.system : base.system,
    spec: typeof t.spec === 'string' ? t.spec : base.spec,
    /**
     * ★★★ v0.9.182：画风覆盖。
     *
     *   模版 `## MOSS 单图口径补充` 里有两处**写死的画风示例**：
     *     `"meta": ["anime", "digital illustration"]`
     *     `1. **画风**…：\`Clean anime line art, cinematic lighting…\``
     *   写词模型是照抄示例的（实测输出首句逐字就是 `Clean anime line art with …`），
     *   所以用户「想改写实」在界面上根本找不到入口 —— 它藏在这段示例里。
     *
     *   这里只改**读出来的**这一份，不回写配置：用户模版里那两处原文保持原样，
     *   随时把画风切回「动漫」就能完全恢复，不存在「改了就回不去」。
     */
    protocol: applyStylePreset(
      typeof t.protocol === 'string' ? t.protocol : base.protocol,
      cfg,
    ),
    jailbreak: typeof t.jailbreak === 'string' ? t.jailbreak : base.jailbreak,
  };
}

/**
 * 当前激活模版的清洗口径 + 组装路径。
 * 'sd'   —— 锚点字段里的中文整段剥掉（默认防线，防建档模型污染画面词）；单串 tag 拼接。
 * 'k2'   —— 中文原样放行；三明治分段拼装（scene → 人物锚点段 → tag）。
 * 'moss' —— **v0.9.117 新增**：MOSS-Image 口径（自然语 + TAG 混写）。
 *           ★ 组装**不是**三明治：出厂模版带 `variant:'en'`，走「单串整段」出口，
 *           `tag` 就是最终提示词（插件只做 前缀 + tag + 后缀）。
 *           原因：多格提示词是「版面声明 → Panel 1 → Panel 2 → Panel 3」的**连续序列**，
 *           三明治的人物锚点段会正好插在中间把它切断（实测三格揉成一张）。
 *           另外它不插写实锚定块、不读 SD 的人数词 / BREAK 开关、不剥 tag 里的中文、
 *           不跑锚点自愈（见 consistency.js 里各处的 `activeEngine() === 'moss'` 判断）。
 *
 * ★ 为什么 MOSS 要单独一档而不是复用 'k2'：
 *   ① K2 的 `styled` variant 会注入 `K2_PHOTOREAL_ANCHOR`（写实摄影锚定），
 *      MOSS 要的是漫画/插画线条，这块锚定直接与画面风格对立；
 *   ② 用户 2026-10-21 明确要求三个口径彼此隔离（「这样也不容易互串」），
 *      模版列表里一眼能分辨，比靠记忆记住「这个模版其实是 MOSS」可靠；
 *   ③ 后续接 Layout JSON（bbox 分格）时，出口只在这一档里改，不污染 SD / K2。
 */
/**
 * 当前激活模版的输出格式：'text'（纯 prompt） | 'layout'（MOSS JSON Layout）。
 * 与 `activeEngine()` 正交 —— engine 决定「用哪套口径」，output 决定「吐什么格式」。
 */
export function activeOutput() {
  const t = getActiveTemplate();
  /**
   * ★★★ v0.9.121：**只有 MOSS 口径才可能走 Layout 通道**。
   *
   * 这一句是「不污染其他模版」的**唯一集中防线**（用户 2026-10-21 明确要求）：
   *   「记得用JSON时别影响其他的，不然到时候切其他的就完全没法用，又得修了。」
   *
   * 为什么不能只靠「模版上有没有 output:'layout'」：
   *   ① 用户在 UI 里把 K2 模版的下拉错切成 Layout（或者以后某次迁移写错字段），
   *      `composePrompt` 里那句 `if (activeOutput() === 'layout')` 是在
   *      `activeEngine() !== 'sd'` 分支**内部**的 —— K2 也进得去，
   *      于是 K2 会去编译一份根本不存在的 Layout，直接出不了图；
   *   ② SD 分支在更外层就返回了，但「靠外层挡住」是隐式的，以后有人调整分支顺序就破了。
   * ⇒ 在这里显式判 engine，任何调用点拿到的都是「此刻真实该走的格式」。
   */
  if (t.engine !== 'moss') return 'text';
  /**
   * ★★★ v0.9.157：新增 `'json'` —— **单图 JSON**（有 JSON 结构、没有任何坐标）。
   *
   * 与 `'layout'` 的分工：
   *   · `layout`：多格 / 单格都走坐标编译（`compileLayout`），每格一个 object + bbox；
   *   · `json`  ：单图专用，**不跑坐标编译**，模型给的 `{summary, items}` 原样交给 MOSS。
   *
   * 为什么必须是一个独立的取值、而不是复用 `layout` 再判 mode：
   *   真出图 36 张对照（`dev_tmp/single_multi/_eval.md`）证明「每人一个各自不同的 bbox」
   *   在 6 人以上会稳定多画一个人（8 人档 3/3 全是 9 人，多出来的都是同一个角色被复制成两个）。
   *   只要那份草稿还会进 `compileLayout`，就一定会被补上框 —— 所以要在**取值层面**就分开。
   */
  if (t.output === 'layout') return 'layout';
  if (t.output === 'json') return 'json';
  /**
   * ★★★ v0.9.186：`'manga'` —— **漫画台原生口径**（照搬 AINIMA 漫画台）。
   *
   * 与 `layout` 的区别不是"要不要坐标"，而是**谁给坐标**：
   *   · `layout`：坐标由插件的版式库算（`mossMangaPage` / `compileLayout`），模型只答内容；
   *   · `manga` ：坐标由**模型直接写**在 page JSON 里（`items[].bbox`，左上原点像素），
   *     插件照搬漫画台的 `compilePage` 拼 summary —— 一字不改。
   *
   * 为什么值得单独一档：用户实测漫画台「真的很稳」，要求原汁原味迁移
   * （2026-11-01）。把它塞进 `layout` 分支就等于被 `compileLayout` 重写 bbox，
   * 那就不是漫画台了。
   */
  if (t.output === 'manga') return 'manga';
  return 'text';
}

export function activeEngine() {
  const cfg = getConfig();
  const t = cfg.templates?.[cfg.activeTemplate];
  const e = t?.engine;
  if (e === 'k2') return 'k2';
  if (e === 'moss') return 'moss';
  return 'sd';
}

/** 自然语口径（k2 / moss）—— 锚点字段里的中文放行、外貌从 tag 里移出去。 */
export function isNaturalEngine() {
  return activeEngine() !== 'sd';
}

/**
 * 当前模版是不是 NSFW（v0.9.69）。
 *
 * ★ 用途：服装三维度（状态细档 / 改造 / 鞋袜）几乎全是裸露语义，
 *   用户 2026-10-04 拍板「只在 NSFW 生效」—— SFW 下整组跳过，避免走光。
 *
 * 判定沿用 settings.js:1732 已有的口径（模版管理里判 NSFW 的两条路），
 * 保证"模版列表里显示 NSFW" 与 "运行时按 NSFW 处理" 用的是同一把尺：
 *   ① 模版显式标了 nsfw === true
 *   ② 模版正文含 NSFW 板块标志串（§3.9）
 */
export function activeNsfw() {
  const cfg = getConfig();
  const t = cfg.templates?.[cfg.activeTemplate];
  if (!t) return false;
  if (t.nsfw === true) return true;
  // 与 refreshK2FactoryTemplates 同一把尺：只看 spec（t.system / t.protocol 不含该标志串）
  // v0.9.94：改用 specLooksNsfw —— 老串只认 K2 出厂的「### 3.9 NSFW 板块」，
  // SD v2 规范把 NSFW 放在「## 五、NSFW 情节」，老串认不出来。
  return specLooksNsfw(t.spec);
}

/** 新建一套模版（默认复制当前）。 */
export function addTemplate(name, from) {
  const cfg = getConfig();
  const base = from || getActiveTemplate();
  cfg.templates[name] = {
    name, engine: base.engine || 'sd',
    ...(base.variant ? { variant: base.variant } : {}),
    system: base.system, spec: base.spec, protocol: base.protocol, jailbreak: base.jailbreak,
  };
  cfg.activeTemplate = name;
  saveSettings();
  return cfg.templates[name];
}

export function removeTemplate(name) {
  const cfg = getConfig();
  const keys = Object.keys(cfg.templates || {});
  if (keys.length <= 1) return false;
  delete cfg.templates[name];
  if (cfg.activeTemplate === name) cfg.activeTemplate = Object.keys(cfg.templates)[0];
  saveSettings();
  return true;
}

/* ============ 全局词库预设（前缀 + 后缀 + 全局负面，2026-09-26） ============ */

/** 三件套快照（从当前配置读）。 */
function gwordTrio(cfg) {
  return {
    prefix: cfg.globalPrefix || '',
    suffix: cfg.globalSuffix || '',
    negative: cfg.globalNegative || '',
  };
}

export function listGwordPresets() {
  return getConfig().gwordPresets || {};
}

export function getActiveGwordPreset() {
  return getConfig().activeGwordPreset || '';
}

/** 把当前生效的三件套存成（或覆盖）一个命名预设，并设为当前预设。 */
export function saveGwordPreset(name, trio) {
  const cfg = getConfig();
  const key = String(name || '').trim();
  if (!key) return { ok: false, reason: '预设名不能为空' };
  if (!cfg.gwordPresets) cfg.gwordPresets = {};
  cfg.gwordPresets[key] = {
    prefix: trio?.prefix ?? '',
    suffix: trio?.suffix ?? '',
    negative: trio?.negative ?? '',
  };
  cfg.activeGwordPreset = key;
  saveSettings();
  return { ok: true, name: key };
}

/** 删除预设；删的是当前预设则回到「自定义」。 */
export function removeGwordPreset(name) {
  const cfg = getConfig();
  if (!cfg.gwordPresets?.[name]) return false;
  delete cfg.gwordPresets[name];
  if (cfg.activeGwordPreset === name) cfg.activeGwordPreset = '';
  saveSettings();
  return true;
}

/** 重命名预设（内容不变；若它是当前预设，当前指针跟着改）。 */
export function renameGwordPreset(oldName, newName) {
  const cfg = getConfig();
  const key = String(newName || '').trim();
  if (!cfg.gwordPresets?.[oldName]) return { ok: false, reason: `预设「${oldName}」不存在` };
  if (!key) return { ok: false, reason: '预设名不能为空' };
  if (key !== oldName && cfg.gwordPresets[key]) return { ok: false, reason: `已有同名预设「${key}」` };
  cfg.gwordPresets[key] = cfg.gwordPresets[oldName];
  delete cfg.gwordPresets[oldName];
  if (cfg.activeGwordPreset === oldName) cfg.activeGwordPreset = key;
  saveSettings();
  return { ok: true, name: key };
}

/** 应用预设：把三件套写进当前配置并记住当前预设名。 */
export function applyGwordPreset(name) {
  const cfg = getConfig();
  const p = cfg.gwordPresets?.[name];
  if (!p) return false;
  cfg.globalPrefix = p.prefix || '';
  cfg.globalSuffix = p.suffix || '';
  cfg.globalNegative = p.negative || '';
  cfg.activeGwordPreset = name;
  saveSettings();
  return true;
}
