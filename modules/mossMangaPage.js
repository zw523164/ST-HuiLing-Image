/**
 * mossMangaPage.js —— 漫画页组装（内容 JSON → 成品 Layout）
 *
 * ## 职责边界（这条是整个改动的隔离保证）
 *
 * 输入：**只有内容**。每格写「背景是什么 / 这一格画什么 / 谁说哪句话」。
 * 输出：**全部坐标**。格框来自版式库（`mossMangaLayouts.js`），
 *       格内槽位（背景层 / 主体层 / 气泡位）由本文件按比例算。
 *
 * 也就是说：图片模型/chat 模型**再也拿不到改坐标的机会**，
 * 于是「格数漂移」「框和人错位」「气泡糊成一团」这三类问题从机制上被消掉了。
 *
 * ## 为什么不复用 `compileLayout`
 *
 * `compileLayout` 的语义是「一个 object = 一个格子」，它会把 character/text
 * 归到最近的格、并强制把坐标拉回版式（`enforceLayoutGeometry`）。
 * 而漫画页需要**一格多框**（C 背景 + S 主体 + 字区各自独立 bbox），
 * 实测把 8 个 object 传进去会触发「模型多写了 4 个格」→ 16/16 项 bbox 被重写。
 * ⇒ 这里直接产出成品格式（`abs_centralized` + `yxyx` + 整数），
 *   `layoutToLine` 只做 `JSON.stringify`，不需要再编译一次。
 *
 * ## 判据：`isMangaDraft`
 *
 * 旧草稿是 `{summary, items[]}`；漫画页草稿是 `{page, panels[]}`。
 * 用「有 panels 且没有 items」判，两条路互不干扰 —— 旧口径一个字段都不变。
 */
import { pickMangaLayout, mangaLayoutBrief, describeMangaLayout, mangaLayoutOf, panelWhere, emptySlotsOf,
  mainPanelIndex, mainBeatScore, faceFitOf, FACE_MAX_ASPECT } from './mossMangaLayouts.js';
/**
 * ★★★ v0.9.154：画面强化的英文句子只有一份（`mossEnhanceText.js`），
 * 这里**不许自己另写一句**（记忆：自创的句子必须有出图证据）。
 */
import { ENH_TEXT, RE_HAS_SLANT, dropTailDot } from './mossEnhanceText.js';
import { normalizeMossEnhance } from './mossLayout.js';
import { planViewpoints } from './viewpoint.js';

/**
 * 每个气泡最多几个字。
 *
 * ★★★ v0.9.158：12 → **10**。依据 `dev_tmp/_text_render_test.mjs`（10 张单变量真出图，
 *   同一人物/场景/气泡描述/尺寸，只改 `text` 字段）：
 *   3 字 ✓✓ ｜ 6 字 ✓✓ ｜ 10 字 ✓✓ ｜ **17 字 ✗✗** ｜ 英文 31 字符 3 行 ✓。
 *   17 字那两次都错在同一处：`是不是` → `是是`（「不」被稳定吃掉），
 *   笔画多的字随机错（`坏` → `块` / `坎` / 画对）。真实图 P73 同形态（3/3 复现）。
 *   ⇒ 这不是随机错字，是**超容量后的文本压缩：先丢单字虚词，再丢笔画**。
 *   同一个「坏」在 6 字版、10 字版都画对 ⇒ 不是模型不认识字，是每字像素不够。
 *   原来的 12 字是估的（P69 那句 10 个汉字已经开始单字错），10 才是实测稳的那个数。
 *   `splitBubble` 的窗口容差是 `max + 2`，所以实际最长落在 12 字。
 */
export const BUBBLE_MAX_CHARS = 10;
/** 兼容旧名（多格路径一直在用）。 */
export const MANGA_BUBBLE_MAX = BUBBLE_MAX_CHARS;
/** 一格最多几个气泡（参考实现一般 2~3 个；再多格子里塞不下）。 */
export const MANGA_BUBBLES_PER_PANEL = 3;

/**
 * 是否「漫画页草稿」。
 *
 * ★ 必须是**结构判据**，不能看 `kind` 这种模型可能忘写的标记字段
 *   （实测模型对「请输出 kind」这类要求的遵守率并不可靠）。
 */
export function isMangaDraft(d) {
  if (!d || typeof d !== 'object' || Array.isArray(d)) return false;
  if (Array.isArray(d.items) && d.items.length) return false;
  if (!Array.isArray(d.panels) || !d.panels.length) return false;
  return d.panels.some((p) => p && typeof p === 'object' && !p.bbox);
}

/* ═══════════ 「这一格画了谁」—— 单点定义 ═══════════ */

/**
 * 第一人称代词表。模型回答「叙述者是谁」时经常原样回填「我」，
 * 拿它去档案库里查恒查不到 ⇒ 这段一律当「没给真名」，不许当人名用。
 */
export const MANGA_NARRATOR_WORDS = /^(?:我|本人|自己|我本人|主角|男主|主人公|旁白|叙述者|i|me|my|myself|narrator|the narrator|the boy|the young man|protagonist)$/i;

/** 「不入画」的标记词：模型用它表示画外音（内心独白 / 旁白框），这类不是画面里的人。 */
const MANGA_OUT_OF_FRAME = /out-of-frame|画外|旁白/i;

/**
 * 一格里的名字（**原始名字，还没换 narrator**）。
 *
 * ★★★ 判据：`cast` = 画面里看得见谁，`speaker` = 谁说 —— **两者不是一回事**。
 *   病例（2026-10-28 第一楼真机）：9 页里 20 多格的 `speaker` 是 `out-of-frame`
 *   （那一楼正文大半是内心独白），只认 `speaker` ⇒ 这些格一个外貌都注不进去，
 *   而 `subject` 里明明写着 `his upper body`。
 * ⇒ `cast` 优先，`cast` 全空时才退回 `speaker`（兼容旧草稿）。
 */
function panelNameList(p) {
  const arr = (v) => (Array.isArray(v) ? v : (v == null ? [] : [v]));
  const pick = (v, dropNarration) => arr(v)
    .map((n) => String(n || '').trim())
    .filter((n) => n && !MANGA_OUT_OF_FRAME.test(n) && !(dropNarration && /^旁白$/.test(n)));
  const fromCast = pick(p?.cast, false);
  if (fromCast.length) return fromCast;
  return pick(p?.speaker, false);
}

/**
 * ★★★ v0.9.142：把「每格的 cast」汇总成**页面级名单**。
 *
 * 为什么必须有这个函数（这是「人物外貌全崩」的根因）：
 *   `consistency.js` 构造外貌锚点表时读的是**页面级** `image.cast`
 *   （`modules/consistency.js:3258`），而漫画草稿把 cast 写在 `panels[].cast` 里，
 *   页面级**根本没有这个键**。于是：
 *
 *     image.cast 不存在 → castItems=[] → castAnchors=[] → k2Anchors=[]
 *       → castLines=[] → looksResolver 对任何名字恒返回空
 *       → **每一格的外貌/服装一个都不注入**
 *
 *   实测证据（2026-10-28 催眠APP 新聊天第 5 楼）：
 *     - 草稿顶层键只有 `page, narrator, figure, panels`，`cast` 是 `undefined`
 *     - 而 `panel.cast` 填得很准（19/20 格写了「西园寺爱丽莎」）
 *     - 生产 prompt 的 character 项里 `blonde / hair / eyes / uniform` 一个都没有
 *       ⇒ 模型只能凭先验自由发挥，表现就是「同一个人每页长得不一样、服装乱换」。
 *
 * 这里只汇总**本次草稿真正用到的人**（不是全卡），因为 `castLines` 要随楼层落库，
 * 塞全卡会把存档撑大；而每格查询是精确点名，多给没用的人也没有收益。
 *
 * @param {object} d        漫画草稿（`isMangaDraft` 为真）
 * @param {string} narrator 设置里的叙述者真名（可为空）
 */
export function mangaDraftCast(d, narrator) {
  if (!isMangaDraft(d)) return [];
  const cfg = String(narrator || '').trim();
  const nar = cfg && !MANGA_NARRATOR_WORDS.test(cfg) ? cfg : '';
  const swap = (v) => (nar && MANGA_NARRATOR_WORDS.test(v) ? nar : v);
  const out = [];
  const push = (raw) => {
    const v = swap(String(raw || '').trim());
    if (v && !out.includes(v)) out.push(v);
  };
  /* 通高人物也算画面里的人（他可能整页只有一格戏份，但脸必须一致）。 */
  push(d.figure && typeof d.figure === 'object' ? d.figure.name : '');
  for (const p of d.panels) for (const n of panelNameList(p)) push(n);
  return out;
}

/* ═══════════ 气泡切分 ═══════════ */

/**
 * 把一句台词切成 ≤`BUBBLE_MAX_CHARS` 的若干段，**一个字都不改**（只切，不压缩、不改写）。
 *
 * ⚠️ v0.9.159 起：**单图与漫画页都不再用它拆项**，改用 `wrapBubble`（同一项内换 `\n`）。
 *   保留它只为「确实需要独立放置的多个气泡」这一种场景，以及旧测试的兼容。
 *   仍然修掉了它「把 `\n` 当普通字符切」的老 bug（见 `cutLines`）。
 */
/** 纯标点（含空白）—— 用于判断"切完还剩什么"。 */
const PUNCT_ONLY = /^[\s，。！？、；：…—～·\.\,\!\?\;\:\-"'“”‘’（）()【】「」『』]*$/;

/**
 * 切一行（不含 `\n`）→ 若干「视觉行」。
 *
 * ★★★ v0.9.159 按官方重写切点规则。依据（USERGUIDE:32 / layout_REFERENCE:20-21）：
 *   「To improve text accuracy or control line breaks precisely, insert `\n` or actual
 *    line breaks directly into the prompt.」
 *   「the exact visible characters, with literal intended line breaks represented as JSON `\n`」
 *   ⇒ 官方给的手段是**换行**，不是「把一句话拆成多个 text 项」；SKILL:36 还明确反对
 *     `arbitrary word budgets`（我们原来那句「每段不超过 10 字」就是）。
 *
 * 规则（三条，都在旧实现上验证过）：
 *   ① 整句 ≤ `max + 3` 字 → **不折**。常见台词（13 字以内）整行进气泡，
 *      避免「我五点四十分必须到 / 校门口」这种断词。
 *   ② 要折时**优先在标点后断**，且在窗口内取最靠后的那个；标点太靠前（<4）就没有意义，
 *      直接按 `max` 硬切。
 *   ③ **防碎尾**：切完剩下 1~3 个字又没标点时，把切点前移，让尾巴并进本行。
 *      （旧版 `WIN = max + 2` 就是为了躲这个，但副作用是「10 字上限」实际一直按 12 字切。
 *       现在改成显式的尾巴判断，上限才真的是 `max`。）
 */
function cutLines(text, max) {
  const src = String(text || '').trim();
  if (!src) return [];
  if (src.length <= max + 3) return [src];
  const out = [];
  let rest = src;
  while (rest.length > max) {
    /**
     * ★★ 收尾判定必须在循环**内部**做一次。
     * 旧实现只在进循环前判断 `src.length <= max+3`，于是切成第一行之后剩下的 13 字
     * 会再进一轮 —— 而在 10 字窗口里找不到标点，就落到「防碎尾」把 13 切成 9+4，
     * 断成 `这教室的空调是不` / `是坏了？`。宁可整行 13 字。
     */
    if (rest.length <= max + 3) { out.push(rest); rest = ''; break; }
    let cut = -1;
    const window = rest.slice(0, max);
    const re = /[，。！？、；：…,.!?;:]/g;
    let m = re.exec(window);
    while (m) { cut = m.index + 1; m = re.exec(window); }
    if (cut < 4) cut = max; /* 标点太靠前会切出 2~3 字的碎句，宁可硬切 */
    /** ③ 防碎尾：尾巴只剩 1~3 个非标点字 → 切点前移，让这 4 个字跟着走。 */
    const tail = rest.slice(cut);
    if (tail && tail.length <= 3 && !PUNCT_ONLY.test(tail)) cut = Math.max(1, rest.length - 4);
    /**
     * ★ v0.9.144：**不许切出一个只有标点的气泡**。
     * 病例：`我五点四十分必须到校门口，` 硬切后剩下 `，` 单独成片 →
     *   出图是一个只写着逗号的空框。
     */
    while (cut > 1 && rest.slice(cut) && PUNCT_ONLY.test(rest.slice(cut))) cut -= 1;
    out.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) {
    if (PUNCT_ONLY.test(rest) && out.length) out[out.length - 1] += rest;
    else if (!PUNCT_ONLY.test(rest)) out.push(rest);
  }
  return out.filter(Boolean);
}

/**
 * 一句台词 → **一个气泡里的多行文本**（行间用 `\n`）。
 *
 * ★ 这是 v0.9.159 之后的统一口径：**一句话 = 一个 text 项**，长句靠 `\n` 折行。
 *   证据（`dev_tmp/_official_wrap_test.mjs`，16 张真出图）：
 *     黑板同一句 12 字 —— 不换行两轮都丢「是」；**插 `\n` 两轮 12 字全对**。
 *   而「拆成多个 text 项」的代价：同一个 caption 会让第二项被画成
 *     「手里举的白色小卡片」（`V1_r1` 实拍）。
 *
 * 一个字都不改：只插入换行符，不删、不改写、不翻译、不加标点。
 */
export function wrapBubble(text, max = BUBBLE_MAX_CHARS) {
  const src = String(text == null ? '' : text);
  if (!src.trim()) return '';
  /**
   * 模型自己写的 `\n` 是**作者手动指定的硬换行**（官方推荐用法），必须原样保住 ——
   * 老 `splitBubble` 会把它当普通字符参与计数，把 `这教室的空调\n是不是坏了？`
   * 切成 `这教室的空调\n是不是` + `坏了？`，等于破坏官方唯一推荐的手段。
   */
  return src.split('\n')
    .map((line) => cutLines(line.trim(), max).join('\n'))
    .filter(Boolean)
    .join('\n');
}

/** 一个气泡里有几行（`wrapBubble` 之后用，供 caption 描述排版 —— 官方要求描述行数）。 */
export function lineCountOf(text) {
  const s = String(text == null ? '' : text);
  if (!s) return 0;
  return s.split('\n').length;
}

export function splitBubble(text, max = MANGA_BUBBLE_MAX) {
  const src = String(text || '').trim();
  if (!src) return [];
  /* 先按作者硬换行分段，再各自切 —— 两段之间的 `\n` 不会被当成字符吃掉。 */
  return src.split('\n').flatMap((line) => cutLines(line.trim(), max)).filter(Boolean);
}

/* ═══════════ 几何 ═══════════ */

/** 左上原点百分比 → 中心化 yxyx 整数像素（成品格式，与 compileLayout 同口径）。 */
function toBox(rect, W, H) {
  const [x0, y0, x1, y1] = rect;
  let px0 = Math.floor(x0 * W); let px1 = Math.ceil(x1 * W);
  let py0 = Math.floor(y0 * H); let py1 = Math.ceil(y1 * H);
  px0 = Math.max(0, Math.min(W - 1, px0)); px1 = Math.max(px0 + 1, Math.min(W, px1));
  py0 = Math.max(0, Math.min(H - 1, py0)); py1 = Math.max(py0 + 1, Math.min(H, py1));
  return [py0 - H / 2, px0 - W / 2, py1 - H / 2, px1 - W / 2].map((v) => Math.round(v));
}

/** 在 rect 里按 0~1 相对比例取子矩形。 */
function subRect(rect, fx0, fy0, fx1, fy1) {
  const [x0, y0, x1, y1] = rect;
  const w = x1 - x0; const h = y1 - y0;
  return [x0 + w * fx0, y0 + h * fy0, x0 + w * fx1, y0 + h * fy1];
}

/** 格框内缩 gap 像素 → 格与格之间留出白缝（漫画的「格线」就是这道缝）。 */
function inset(rect, gapPx, W, H) {
  const gx = gapPx / W; const gy = gapPx / H;
  return [rect[0] + gx, rect[1] + gy, rect[2] - gx, rect[3] - gy];
}

/**
 * 主体槽位：不同景别取格内的不同区域。
 *
 * ★ 这不是「美观」问题，是**取景效果**问题：
 *   局部特写（手 / 衣料 / 接触点）如果给满格，MOSS 会画成全身远景
 *   （实测：格2 想画「裙底的手」，满格 → 画出两人远站）。
 *   给它一个偏中偏下的框，画面才收得住。
 */
const SUBJECT_SLOT = {
  face: [0.10, 0.02, 0.90, 0.66],
  response: [0.08, 0.04, 0.92, 0.74],
  upper: [0.08, 0.02, 0.92, 0.78],
  detail: [0.12, 0.14, 0.88, 0.96],
  action: [0.04, 0.03, 0.96, 0.97],
  full: [0.06, 0.02, 0.94, 0.99],
};

/** 景别归一化（模型给的词五花八门，认不出就当 action）。 */
export function normalizeShot(raw) {
  const s = String(raw || '').toLowerCase();
  if (/face|close|眼睛|脸/.test(s)) return 'face';
  if (/detail|insert|局部|手|特写/.test(s)) return 'detail';
  if (/environment|scenery|empty|空镜|环境/.test(s)) return 'environment';
  if (/response|react|反应|表情/.test(s)) return 'response';
  if (/upper|bust|half|半身/.test(s)) return 'upper';
  if (/full|wide|全身|远/.test(s)) return 'full';
  return 'action';
}

/**
 * 景别钉：**这一格该收在哪儿**。
 *
 * ★★★ v0.9.146 —— 两条是真机出图拍出来的：
 *   ① `detail`：`only her legs` 被画成**路人的腿**。局部格拿不到身份线索，
 *      模型只能凭空长一截腿。⇒ 必须明说"这具身体属于上面那个人"。
 *   ② `full`：写"全身远景"时人物被画成**远处的小人**。⇒ 明说"从头到脚撑满这个框"。
 *
 * ★★★ v0.9.151 修正 —— **`face` 这一条原来写错了因果，此处重写**。
 *
 * 旧注释把两件事捆成一条：「特写格服装漂移」⇒「所以把镜头钉在头颈上」。
 * 实际是三步叠加，第二步是**补丁的补丁**：
 *   ① 原始病症：特写格服装漂移（同页上格灰制服、下格黑衬衫）
 *      ⇒ 修法是**补服装描述**（`mossWearLine` / `looks` 的 `wear` 锚）—— 这一步是对的，留着；
 *   ② 补了服装描述后，模型想把衣服展示出来 ⇒ 特写退化成半身中景
 *      ⇒ 当时又加了「the face fills most of this box」+「Do not pull the camera back」来压住它；
 *   ③ 于是遇到**横框**（实测 P24 中间大格 833×494，宽高比 1.69）时，「一张竖着的脸填满一个
 *      1.69 倍宽的框」物理上做不到 —— 模型只能加手臂和肩背去铺满宽度，
 *      画出「趴地托腮」这种整格演绎报废的图。
 *
 * 用户原话（2026-10-29）：
 *   「一定要填满？不填满不也能正常出吗」/「有时候裁掉总比全体崩要好吧？
 *    比如那个大横框，只留个头其他裁掉都比现在这样好吧。」
 *
 * ⇒ **「填满」和「允许被裁」是相反方向的指令**：前者让内容迁就框（于是造身体），
 *   后者让框去裁内容（于是脸放大、边缘被切，框里仍然只有脸）。裁掉一点发顶或下巴
 *   在特写里本来就是正常构图，代价远小于整格报废。
 *   出图验证（`dev_tmp/framing150/`，同页同内容只改措辞）：
 *     v1 现状=巨大的脸+托腮手+整个肩背 / v5 允许裁切=手肩背还在 /
 *     v6 允许裁切+去掉"最宽视野"= 只剩脸和肩，干净。
 */
/**
 * 降级成半身时用这一句，**只给被降级的格**用（原生 `upper` 不加）。
 *
 * 为什么不复用同一个 pin：`FRAMING_PIN.upper` 一旦有值，所有普通半身格都会被加上它 ——
 * 那是给"本来就要半身"的格加约束，属于擅自扩大改动面。
 */
const FACE_FALLBACK_PIN = 'Read as the upper body of this person from the waist up: the face is the focal point'
  + ' and the shoulders and arms are inside this panel as well.';

const FRAMING_PIN = {
  /**
   * ★ v0.9.151：从「填满这个框」改成「大到可以被框裁掉」。
   * 同时把「不许拉远成半身」删掉 —— 负面措辞反而把「半身」这个词喂给了模型
   * （项目里已有同类病例：「不要画 X」比「画 Y」更容易画出 X）。
   * 「no body below the shoulders and no hands」是正向划界，不是禁令式的拉远否定。
   */
  face: 'Only the head and neck of this person are inside this panel and the head is large enough'
    + ' that the panel crops it at the edges — losing the top of the hair or the chin at the border is fine,'
    + ' but no body below the shoulders and no hands.',
  detail: 'Only that one body part fills this panel edge to edge, and it must read as belonging to the same person'
    + ' described above — keep her skin tone and the garment colours just written. No face, and no limb from anybody else.',
  full: 'The whole body of this person fills this box from the top of the head to the feet, cropped only at the very'
    + ' edges — not a small distant figure standing inside a wide scene.',
};

/* ═══════════ 「这一页最重的是第几条」 ═══════════ */
/**
 * ★★★ v0.9.149：`mainBeat` 的归一化。
 *
 * 为什么只让模型答**一个数字**（而不是让它挑版式 id、更不是让它写坐标）：
 *   · 挑版式 id = 盲选（它看不到那 20 多个版式长什么样）；
 *   · 写坐标 = 它没有画布尺寸，`compileLayout` 老路上 16/16 个框被重写；
 *   · 答「第几条最重」是**填空类**（实测≈100%），而且答案只有 1~n 这几种。
 * 代码拿这个数字去版式库里查「主格正好落在这一条」的那几个，坐标仍然不出代码的手。
 *
 * 容错：模型常回 `"2"` / `2` / `"第2条"` / `"panel 2"` —— 取**第一段数字**即可；
 * 超出格数时夹到最后一格（那通常是它想说「结尾那一步」），不是丢弃。
 *
 * @returns {number} 1 基序号；0 = 没答（不筛）
 */
export function normalizeMainBeat(raw, panelCount) {
  const m = String(raw == null ? '' : raw).match(/\d+/);
  if (!m) return 0;
  const k = Number(m[0]);
  if (!Number.isFinite(k) || k < 1) return 0;
  const n = Math.max(0, Math.round(Number(panelCount) || 0));
  return n ? Math.min(n, k) : k;
}

/* ═══════════ 自定义版式（draft.frames）的守门 ═══════════ */
/**
 * 校验草稿自带的 frames 能不能用。
 *
 * ★ 为什么要有这一层：用户提出「让模型按剧情自己选版式」。直接放开坐标是危险的
 *   —— 模型看不到画布，它给的 bbox 只会是「看起来合理」的数字，历史上
 *   `compileLayout` 那条路上 16/16 的框都被重写过。但如果**只把形状交给内容、把正确性
 *   交给代码**，这条路就是安全的：凡是不合格的几何一律拒绝，回落库选。
 *
 * 四道关（全部相对判据，换分辨率不失效）：
 *   ① 越界 / 空框 / 非数字；
 *   ② 单格小于页宽（或页高）5% —— 那种格子只能画一块颜色；
 *   ③ 两两重叠 —— 重叠会让同一块画面被两个 caption 抢，出图必崩；
 *   ④ 格数少于情节条数 —— 会**直接丢剧情**（`frames` 循环只走 frames.length 次）。
 *
 * @param {Array} raw 归一化矩形数组 `[[x0,y0,x1,y1], ...]`（0~1，左上到右下）
 * @param {number} [panelCount] 这一页的情节条数（用来查④）
 * @returns {{ok:boolean, errors:string[], warnings:string[], frames:Array|null}}
 */
export function validateFrames(raw, panelCount) {
  const errors = [];
  const warnings = [];
  const bad = (m) => errors.push(m);
  if (raw === undefined || raw === null) return { ok: false, errors: ['没有 frames'], warnings, frames: null };
  if (!Array.isArray(raw)) return { ok: false, errors: ['frames 不是数组'], warnings, frames: null };
  if (raw.length < 2) bad(`frames 只有 ${raw.length} 格（至少 2 格）`);
  if (raw.length > 8) bad(`frames 有 ${raw.length} 格（最多 8 格，再多每格画不下人）`);
  const frames = [];
  raw.forEach((f, i) => {
    const tag = `第 ${i + 1} 格`;
    if (!Array.isArray(f) || f.length !== 4) { bad(`${tag} 不是 [x0,y0,x1,y1]`); return; }
    const v = f.map(Number);
    if (!v.every((x) => Number.isFinite(x))) { bad(`${tag} 含非数字`); return; }
    const [x0, y0, x1, y1] = v;
    if (x0 < -1e-6 || y0 < -1e-6 || x1 > 1 + 1e-6 || y1 > 1 + 1e-6) bad(`${tag} 越界（坐标须在 0~1）`);
    if (x1 - x0 <= 1e-6 || y1 - y0 <= 1e-6) bad(`${tag} 是空框`);
    else if (x1 - x0 < 0.05 || y1 - y0 < 0.05) bad(`${tag} 太小（宽或高不足页面的 5%）`);
    frames.push(v);
  });
  for (let i = 0; i < frames.length; i += 1) {
    for (let j = i + 1; j < frames.length; j += 1) {
      const a = frames[i];
      const b = frames[j];
      const ox = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
      const oy = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
      if (ox > 1e-6 && oy > 1e-6) bad(`第 ${i + 1} 格与第 ${j + 1} 格重叠`);
    }
  }
  const n = Number(panelCount) || 0;
  if (n && frames.length < n) bad(`frames 只有 ${frames.length} 格，但这一页有 ${n} 条情节 —— 会丢剧情`);
  if (errors.length) return { ok: false, errors, warnings, frames: null };
  const area = frames.reduce((a, f) => a + (f[2] - f[0]) * (f[3] - f[1]), 0);
  if (area < 0.7) warnings.push(`自定义版式只覆盖 ${Math.round(area * 100)}% 的页面`);
  if (n && frames.length > n) {
    warnings.push(`frames 有 ${frames.length} 格，但只有 ${n} 条情节 —— 最后一条会被重复成多格`);
  }
  return { ok: true, errors: [], warnings, frames };
}

/* ═══════════ 组装 ═══════════ */

/**
 * 内容 JSON → 成品 Layout。
 *
 * @param {object} draft { page, figure:{name,pose,expression}, panels:[{beat,shot,bg,subject,lines,speaker}] }
 * @param {number} W 实际画布宽（取 `estimateResolution` 之后的值，不用死参数）
 * @param {number} H 实际画布高
 * @param {object} opts
 *   - `style`   画风句（用户的画风主权，原样放 summary 第一句）
 *   - `looks`   `(name, framing) => string` 按景别给外貌/服装句（由 consistency 注入，
 *               复用角色档案那条唯一真相，本文件不自己读档案）
 *   - `gap`     格间缝像素（默认 8）
 *   - `layoutId` 指定版式（默认按条数自动选）
 * @returns {{ok:boolean, out?:object, errors:string[], warnings:string[], stats:object}}
 */
export function buildMangaPage(draft, W, H, opts = {}) {
  const errors = [];
  const warnings = [];
  const width = Math.max(1, Math.round(Number(W) || 0)) || 864;
  const height = Math.max(1, Math.round(Number(H) || 0)) || 1152;
  const gap = Number.isFinite(Number(opts.gap)) ? Number(opts.gap) : 8;

  if (!isMangaDraft(draft)) return { ok: false, errors: ['不是漫画页草稿（没有 panels）'], warnings, stats: {} };

  const panelsIn = draft.panels.filter((p) => p && typeof p === 'object');
  if (!panelsIn.length) return { ok: false, errors: ['panels 是空的'], warnings, stats: {} };

  /**
   * ★★★ v0.9.144：**没有通高人物时就别选带人物栏的版式**。
   *
   * 病例（本轮预览，`mangaLayout='random'`）：第 3 页随机到 `hero-right-3`，
   *   而这一页的 `figure.name` 是空的 —— 结果整页右侧 1/4 是**空白栏**，
   *   4 格被挤在左边，画面白白浪费一块（warnings 里只有一句"这一栏会空着"）。
   * 版式库本来就有 `noFigure` 选项，这里只是把判据接上：名字空 = 没有那个"页边站着的他"。
   */
  const figNameRaw = String((draft.figure && draft.figure.name) || '').trim();
  /**
   * ★★★ v0.9.147：**版式一旦选过就记住，重生成不许重掷。**
   *
   * 病例（用户 2026-10-29 实拍，同一张图点「重新生成这张」）：版式从
   * 「上 1 大格 + 下 3 小格」变成「左 1 竖条 + 中 2 格 + 右 1 竖条」，
   * 于是同一份人物描述在新版式里被画成白 T 恤、水手领巾和黑丝全没了 ——
   * 用户的原话是「重新生图女主衣服完全飘了、格子也是」。
   *
   * 根因不在服装链路（存档 prompt 里三样服装词一个没少），而是
   * `layoutId: c.mossJson?.mangaLayout` 传下来是 `'random'` ⇒ 每次构建都重新抽版式。
   * 格子形状一变，模型对「这格里该保留什么」的判断全变 —— 窄条格只能画局部。
   *
   * ⇒ 选完就写回 `draft.layoutId`，存在 `layoutJson` 里跟着楼层落库。
   *   优先级：**用户手选的具体版式 > 草稿记着的上次那个 > 随机**。
   */
  const wantLayout = String(opts.layoutId || '').trim();
  const reuseLayout = /^(random|auto|)$/i.test(wantLayout) ? String(draft.layoutId || '').trim() : '';
  const preferLayout = reuseLayout || wantLayout;
  /** 戏型由模型在草稿顶层答一个词（可缺省）—— 见 `rankLayouts` 里为什么不让模型直接挑 id。 */
  const mood = String(draft.mood || '').trim();

  /**
   * 跨格通高人物：**必须在逐格循环之前算出来**。
   *
   * ★★★ v0.9.140：病例（单变量实测，`dev_tmp/figure_dup.mjs`）。
   *   通高人物是「整页右侧的那个人」，如果某一格的内容又写了他（`他站在她身后`），
   *   同一个人的外貌会被注入两次（格内一次 + 通高一次）——
   *   实测出图：第 3 格一个半身男主 + 右侧一个通高男主，**同一页像有两个人**。
   *   对照组（第 3 格只写女主）整页干净，与参考图同构。
   *   ⇒ 格内命中「就是通高那个人」时不再注入完整外貌，改为**只画局部**的口径。
   */
  /**
   * ★★★ v0.9.141：`narrator` —— 第一人称「我」对应档案库里的谁。
   *
   * 病例（2026-10-28 第一楼真机）：正文是男主第一人称，模型把 `figure.name` 和
   *   `cast` 全写成「我」（10+ 格），而档案库里没有「我」这个人
   *   ⇒ 那些格一个外貌都没注入，`subject` 里明明写着 `I sit at the corner desk`。
   *
   * 不猜的理由：这一楼有 3 个男性（主角 / 阿宅君 / 巡查员），任选一个都可能给别人上脸。
   * ⇒ 让模型**在 layout 顶层回答一次**「我=谁」，代码拿着这个名字做全局替换。
   *   这是"填一个字段"的典型场景：一次回答，全页复用，可靠性和 20 格逐格写一样，成本是 1/20。
   */
  const NARRATOR_WORDS = MANGA_NARRATOR_WORDS;
  /**
   * ★★★ narrator 的来源优先级（高 → 低）：
   *   ① `opts.narrator` —— 用户在设置里指定的「叙述者是谁」（唯一可靠来源）
   *   ② `draft.narrator` —— 模型答一次（仅在它能从正文里看出名字时有效）
   * 模型答不准是**已知的**：2026-10-28 第一楼实测，10/10 页把 `narrator` 填成 `"我"`
   *   —— 因为那一楼正文里男主**从头到尾没被点名**，模型根本无从得知他叫「夜斗」。
   *   所以这一层只能当补充，不能让设置空着。
   */
  const narratorCfg = String(opts.narrator || '').trim();
  const narratorRaw = String(draft.narrator || '').trim();
  /** narrator 本身不许是代词（模型循环自指时就当没给）。 */
  const narrator = narratorCfg && !NARRATOR_WORDS.test(narratorCfg)
    ? narratorCfg
    : (narratorRaw && !NARRATOR_WORDS.test(narratorRaw) ? narratorRaw : '');
  const asNarrator = (v) => {
    const s = String(v || '').trim();
    if (!s || !narrator) return s;
    return NARRATOR_WORDS.test(s) ? narrator : s;
  };

  const fig = draft.figure && typeof draft.figure === 'object' ? draft.figure : null;
  const figName = asNarrator(fig?.name);
  /** 同一个人的判定：全名 / 简称互含（同 `looksResolver`，精确相等会漏）。 */
  const sameAsFigure = (n) => {
    const s = String(n || '').trim();
    if (!s || !figName) return false;
    return s === figName || s.includes(figName) || figName.includes(s);
  };

  /**
   * ★★★ v0.9.141：**通高人物与格子内容大面积冲突时，换掉版式**（不是删格子内容）。
   *
   * 病例（2026-10-28 第一楼真机，page05 / page07 各一页）：
   *   `figure.name = 西园寺爱丽莎`，而这一页 4 格里有 **2 格**的 `speaker` 也是她。
   *   按「格内命中本人 → 整格不给他人物层」的规则，那 2 格只剩空环境 + 气泡
   *   ⇒ **一页 4 格实际只画了 2 格**，剧情当场缺一半。
   *
   * 这不是内容写错，是**版式选错**：带通高人物栏的版式，前提是「这个人不参与格子里的戏」。
   *   他要是主角，就不该同时充当背景板。⇒ 冲突 ≥2 格时自动降级成**无人物栏**的同格数版式，
   *   把内容原样保留。判据是纯几何/字面的，不靠模型自觉。
   */
  const namesOfPanel = (p) => {
    const fromCast = (Array.isArray(p.cast) ? p.cast : (p.cast == null ? [] : [p.cast]))
      .map((x) => String(x || '').trim())
      .filter((x) => x && !/out-of-frame|画外|旁白/i.test(x));
    if (fromCast.length) return fromCast;
    return (Array.isArray(p.speaker) ? p.speaker : [p.speaker])
      .map((x) => String(x || '').trim())
      .filter((x) => x && !/out-of-frame|画外|旁白/i.test(x));
  };
  const figClash = figName
    ? panelsIn.filter((p) => namesOfPanel(p).some(sameAsFigure)).length
    : 0;
  /**
   * ★★★ v0.9.147：**先算冲突，再选版式** —— 这两步原来的顺序是反的。
   *
   * 旧顺序「先随机（可能抽到带栏版）→ 发现 clash≥2 → 再换成无栏版」有两个毛病：
   *   ① 白抽一次，且换完之后 `mood` 没跟着传（v0.9.147 之前连 mood 都没有）；
   *   ② 换版式靠 `undefined` 当 prefer，等于再掷一次骰子 —— 同一页两次构建可能落到不同版式。
   *
   * 现在把判据提前：**这一页的格子里本来就有他 ⇒ 一开始就不要人物栏**。
   * 只有「他真的不参与格内戏」（clash ≤ 1）时，才允许选带人物栏的版式。
   */
  const pickOpts = mood ? { mood } : {};
  /**
   * v0.9.152：把画布宽高比交下去 —— 版式库的 frames 是归一化坐标，
   * 「这个框有多扁」必须乘上画布比才是模型看到的真实框形。
   * 不传的话 `faceFitOf` 会用默认 848/1136，与这里的降级判据（真实像素）差 1.34 倍，
   * 就会出现「选版式说放得下、降级说放不下」的两套口径。
   */
  pickOpts.pageAspect = width / height;
  if (!figNameRaw || figClash >= 2) pickOpts.noFigure = true;
  /** 只有「他确实不参与格内戏」时，才去要那个人物栏版式（否则会优先拿到最差的横条款）。 */
  if (figNameRaw && figClash < 2) pickOpts.preferFigure = true;
  /**
   * ★★★ v0.9.148：把每格的景别交下去，让选版式避开「空镜占大格」。
   *
   * 病例（2026-10-29 催眠APP 重跑）：`hero-top-3` 的上格占 50% 页面，
   * 而第 1 条情节是 `environment` ⇒ **半页画了一张空器材室**。
   * 模型无法预知自己那条空镜会被分到多大的格子（版式由代码选），
   * 所以要靠这一层错开 —— 措辞层面无解。
   */
  pickOpts.panelShots = panelsIn.map((p) => normalizeShot(p.shot));
  /**
   * ★★★ v0.9.149：**这一页最重的是第几条** —— 让模型只答一个数字，代码把大格给它。
   *
   * 病例（2026-10-29 A/B，9 页同一份草稿只换版式）：库选那版 P12 把 46% 的画面
   * 给了第 4 条「她的手按在他胸口」，而第 1 条「把她揽进怀里」被塞进 25% 的小格 ——
   * 用户看到的「暧昧没了、关键动作看不清」正是这个。手工指定版式那版全对，
   * 差别只有一处：**大格落在了最重的那一步**。
   *
   * ⇒ 与其让模型猜版式（它看不到图），不如让它答一个它能答准的填空题（1~n）。
   */
  const mainBeat = normalizeMainBeat(draft.mainBeat, panelsIn.length);
  /**
   * ★★★ v0.9.153：**`mainBeat` 那一条如果是特写，就不许为它找大格。**
   *
   * 这两条判据天然对撞，必须显式分个高下：
   *   · `mainBeat` 说「这一页最重的是第 3 条，大格给它」；
   *   · `FACE_MAX_AREA` 说「一张脸不该占 0.3 页以上，特写挑小格」。
   * 撞上时**后者优先** —— 用户 2026-10-29 04:15 的原话：
   *   「给特写的时候挑个小格不就行了，需要整体或者半身或者全身就给大格。」
   * 强度也不对等：特写给大格会**逼模型造手臂肩背填满**（P24/P28 实测），
   * 而特写不给大格只是「这一页没有大格」，读者完全不会觉得少了什么。
   *
   * 所以这里把 `mainBeat` 摘掉，让 `preferMainBeat` 不生效，退回按逐格形状排（`shapeFitOf`）。
   */
  const beatShot = mainBeat ? normalizeShot((panelsIn[mainBeat - 1] || {}).shot) : '';
  const beatIsCloseUp = beatShot === 'face';
  if (mainBeat && !beatIsCloseUp) pickOpts.mainBeat = mainBeat;
  else if (beatIsCloseUp) {
    warnings.push(`这一页最重的是第 ${mainBeat} 条，但那是一条脸部特写 ——`
      + ' 特写不占大格（大格会逼模型补身体填满），所以这一页不按「最重那条放大」排版');
  }
  /** v0.9.150 实验开关（默认关）：命中款只有 1 个时也只用它。见 `preferMainBeat` 的注释。 */
  if (draft.strictBeat === true) pickOpts.strictBeat = true;
  /** v0.9.150：让选版式把「有没有主格命中款」如实写回来，别让日志靠假设。 */
  pickOpts.diag = {};
  /**
   * ★★★ v0.9.148：**允许草稿自带 frames（版式由内容方定）**。
   *
   * 起因（用户 2026-10-29）：「能不能让模型根据剧情自己合理选择板式，
   *   而不是剧情和板式有冲突的时候硬填。」
   *
   * 为什么不是「放开了让模型写 bbox」：`compileLayout` 那条老路一 object 一格，
   * 16/16 的 bbox 会被重写成同样大小（`abs_centralized` 之前的历史坑），坐标根本握不住。
   * 所以这里留的是一个**受校验的入口**：frames 可以是任意几何，但必须过
   * `validateFrames` 的越界 / 重叠 / 最小尺寸 / 覆盖率四道关，不合格就回落库选。
   *
   * 也就是说：形状听内容的，正确性归代码。
   */
  const custom = validateFrames(draft.frames, panelsIn.length);
  if (draft.frames !== undefined && draft.frames !== null && !custom.ok) {
    warnings.push(`草稿自带的 frames 不合格，已回落到库选版式：${custom.errors.join('；')}`);
  }
  let lay;
  if (custom.ok) {
    lay = {
      id: 'custom',
      panels: custom.frames.length,
      family: 'custom',
      frames: custom.frames,
      figure: null,
      note: '由草稿 frames 指定',
    };
    for (const w of custom.warnings) warnings.push(w);
    if (figNameRaw) {
      warnings.push(`自定义版式没有通高人物栏 —— figure「${figName}」不会单独成栏`
        + `（他只在各格 subject 里出现）`);
    }
  } else {
    lay = pickMangaLayout(panelsIn.length, opts.rand || Math.random, preferLayout, pickOpts);
  }
  if (!lay) return { ok: false, errors: [`没有 ${panelsIn.length} 格的版式`], warnings, stats: {} };
  /** 回写：这一页实际用了哪个版式，跟着草稿一起落库（重生成不再重掷）。 */
  if (lay.id !== 'custom') draft.layoutId = lay.id;
  if (figClash >= 2) {
    warnings.push(`通高人物「${figName}」在这一页的 ${figClash} 个格子里就是主体 —— `
      + `这一页按无人物栏版式配（带栏版式会把那 ${figClash} 格改成空镜，等于丢剧情）`);
  }
  /**
   * 最后再核一次「空镜占大格」：手选版式 / 复用上次版式时会绕过排序，
   * 那种情况下不换（重生成必须稳定、用户手选是主权），但必须让日志能看见。
   */
  if (mood !== 'scenery') {
    const e = emptySlotsOf(lay, pickOpts.panelShots);
    if (e.waste) {
      warnings.push(`这一页的版式 ${lay.id} 把 ${e.count} 个空镜格分到了`
        + ` ${Math.round(e.share * 100)}% 的页面（平均每格 ${Math.round(e.mean * 100)}%）`
        + `${e.hitsBig ? '，其中一格就是本页最大格' : ''} —— 检查这一页的 shot 是否给错了`);
    }
  }
  /**
   * ★★★ v0.9.150：主格没落在「这一页最重的那一条」时**必须说出来**，而且不许猜。
   *
   * 旧文案写「候选池里没有主格正好在这一条的版式」—— 那是假设。
   * 实测（真实草稿 P24）池里有 `hero-mid-4`，只是三级回落并了四格等大进来、抽到了 `grid-2x2`，
   * 被这句假设文案误导成「库里缺款」。现在分两种事实：
   *   · `bestSize === 0` → 库里真没有（该加版式）；
   *   · `bestSize > 0`   → 有，是这次抽到别的（想稳定就调回落策略，别去加款）。
   */
  if (mainBeat && lay.id !== 'custom') {
    const sc = mainBeatScore(lay, mainBeat);
    if (sc !== 0) {
      const bi = mainPanelIndex(lay);
      const dg = pickOpts.diag || {};
      const why = dg.poolSize === undefined
        ? '这一页用的是指定 / 复用的版式，没走版式挑选'
        : (dg.bestSize > 0
          ? `候选池里 ${dg.bestSize} 款的主格就在这一条，本页抽到了另一款`
          : '候选池里确实没有主格在这一条的版式');
      warnings.push(`这一页最重的是第 ${mainBeat} 条，但版式 ${lay.id} 的`
        + `${bi < 0 ? '四格等大、没有主格' : `主格在第 ${bi + 1} 条`}`
        + ` —— ${sc === 2 ? '重头戏被压进了最小的格子' : '这一段重头戏不会被放大'}（${why}）`);
    }
  }

  const frames = lay.frames;
  /* 版式格数 > 情节条数：多出来的格并进最后一条（把最后一步重复成两格最难看，
     宁可让最后一格剧情"多演一会儿" —— 用同一份内容的两段不同取景）。 */
  const items = [];
  const looksFn = typeof opts.looks === 'function' ? opts.looks : () => '';

  /* 气泡溢出队列：某格气泡满了就顺延到下一格 */
  const overflow = [];
  /** v0.9.152：有几格「特写落进扁框」被降级成半身（进 stats 供日志看）。 */
  const faceDowns = [];
  /**
   * ★ v0.9.188：逐格记下「景别」与「这格的人物质落在 items 的第几项」。
   *
   * 为什么要记而不是在循环里直接算机位：机位分配要**看全页**（相邻格不许同档、
   * 整页至少几种），必须等所有格子的景别都定了才能算。而景别是在循环里
   * 被 `faceDown` 改过的（`shot` face → upper），所以只能**在循环里记下来**，
   * 事后再补 —— 事后重算一遍景别就等于「算」和「比」用两份数据（记忆里的老坑）。
   */
  const panelFraming = [];
  const panelItem = [];

  frames.forEach((frame, i) => {
    const p = panelsIn[Math.min(i, panelsIn.length - 1)] || {};
    const idx = i + 1;
    const inner = inset(frame, gap, width, height);
    /** 这一格的形状与位置（人话），见 panelWhere 的病例注释。 */
    const where = panelWhere(frames, i);
    const boxW = Math.max(0, (frame[2] - frame[0]) * width);
    const boxH = Math.max(0, (frame[3] - frame[1]) * height);
    const boxAspect = boxH > 1e-6 ? boxW / boxH : 99;
    /**
     * ★★★ v0.9.152：**竖内容不进扁框** —— 特写遇到横向框就地降级成半身。
     *
     * 用户定案原话：「别硬塞，横版天生有些构图不适合就不要硬塞进去。」
     *
     * 两个真机病例（都不是偶发）：
     *   ① P24 大格 833×494（1.69）+ `shot:face` ⇒ 出图「趴地托腮、手臂撑地」，整格演绎废掉；
     *   ② P28 大格 848×636（1.33）+ `shot:face` ⇒ 同一份提示词连跑 4 次，**4 次全带托腮的手**。
     *   （v0.9.151 已把「脸填满这个框」改成「大到可以被框裁掉」，只压住了大半 —— 因为框没变。）
     *
     * 为什么是降级、不是筛版式：
     *   `hero-mid-4` 四格宽高比全 ≥1.40，**一格特写都放不了**，而它是 4 格档里唯一
     *   「主格在第 3 格」的版式（P24 的戏恰在第 3 条）。筛掉它 = `mainBeat` 这页直接失效；
     *   降级只动这一格的景别与一句文案，版式与主格都不牺牲。
     *
     * 降级后 `looks` 也跟着变（`frames` 里 `framing` 由 `shot` 推）——
     * 半身需要完整外貌 + 服装锚，这一步是顺带修好的。
     */
    let shot = normalizeShot(p.shot);
    const faceDown = shot === 'face' && boxAspect > FACE_MAX_ASPECT;
    if (faceDown) {
      shot = 'upper';
      faceDowns.push(i + 1);
      warnings.push(`panel ${i + 1} 要的是脸部特写（face），但这一格是`
        + ` ${Math.round(boxW)}×${Math.round(boxH)} 的横向框（宽高比 ${boxAspect.toFixed(2)} >`
        + ` ${FACE_MAX_ASPECT}）—— 已自动降级成半身（upper）。`
        + '一张脸塞进横向框，模型只能加手臂和肩背去铺满宽度（P24/P28 实拍）。'
        + '要真特写就得让这一格拿竖框：把这条情节挪到别的位置，或换成竖格多的版式');
    }
    const subj = String(p.subject || '').trim().replace(/\.+$/, '');
    const isEmpty = shot === 'environment' || /no person|no one|empty/i.test(subj);

    /**
     * ★★★ 气泡**先算**，因为主体框必须给它让位。
     *
     * 病例（v0.9.140 首轮八版式实测）：气泡位固定在格内上方 0.05，
     * 而 `face` 格的主体槽位是 0.02~0.66 —— 两者完全重叠，
     * 出图就是「气泡糊在脸上」，脸和台词互相挡。
     * 参考实现不会有这问题，因为气泡位是**人手工摆**的。
     * ⇒ 这里让程序做同一件事：算出气泡占掉多高，主体从它下面开始。
     */
    const lines = (Array.isArray(p.lines) ? p.lines : [p.lines])
      .map((x) => String(x == null ? '' : x).trim()).filter(Boolean);
    const outOfFrame = /out-of-frame|画外|旁白/i.test(String(p.speaker || ''));
    const queue = [...overflow.splice(0), ...lines];
    const bubbles = [];
    for (const ln of queue) {
      /**
       * ★★★ v0.9.159：**一句话 = 一个气泡**（长句在气泡内用 `\n` 折行）。
       *
       * 旧口径是 `splitBubble` 把长句拆成 2~3 个独立气泡，理由是「10 字以内才不出错」。
       * 但官方 layout_REFERENCE:21 写得很明确：
       *   「Use separate text items **when placement must be independent**.」
       *   —— 拆项的条件是「位置必须各自独立」，不是「这句太长」。
       *   而 USERGUIDE:32 给的手段是插 `\n` 或直接换行。
       * 实拍代价：拆出来的第二个气泡 caption 与第一个一字不差，模型把它画成
       *   「手里举着的白色小卡片」（_text_render_test 的 V1_r1）。
       *
       * 溢出队列现在存**整句**（不是碎片），下一页能完整接上。
       */
      const wrapped = wrapBubble(ln);
      if (!wrapped) continue;
      if (bubbles.length >= MANGA_BUBBLES_PER_PANEL) { overflow.push(ln); continue; }
      bubbles.push(wrapped);
    }
    const B_TOP = 0.045; const B_H = 0.155; const B_GAP = 0.03;
    /**
     * 气泡占位高度按**行数**算，但封顶 2 行 ——
     * 再多行模型会自己压字，继续加高只会把主体挤出格（和「特写塞进扁框」同一个病）。
     */
    const rowsOf = (t) => Math.min(2, lineCountOf(t));
    const occupied = bubbles.length
      ? B_TOP + bubbles.reduce((sum, t) => sum + B_H * rowsOf(t) + B_GAP, 0)
      : 0;

    /**
     * ★★★ 这一格画的是不是**通高人物本人**？—— 必须在背景层之前算出来，
     *   因为背景层要跟着改口径（说明这格没有人、由右侧通高人物承担）。
     *
     * 是 → **这一格不建 character 项**。这样才能真正避免「同一页两个他」。
     *
     * ★ 实测否掉过两版（`dev_tmp/figure_dup.mjs` 单变量，同 seed 同版式）：
     *   ① 不降级（原样注入两遍外貌）→ 格内一个半身男主 + 右侧一个通高男主，
     *      同一页像有两个人（`dup1-grid3-boy.png` 第一版）。
     *   ② 降级成「只画局部」（`at most his forearm … do not draw a second copy`）→
     *      格内仍然画了半身，**而且页脚多出两处没上色的线稿**（模型把「轮廓」照字面画成素描）。
     *   ⇒ 只要这一格还挂着他的 character 项，模型就会在格内再安排一个人。
     *      唯一稳的解法是**整格不给他人物质**。
     */
    /**
     * ★★★ v0.9.141：**这一格画了谁 = `cast`，不是 `speaker`**。
     *
     * 病例（2026-10-28 第一楼真机）：9 页里有 20 多格的 `speaker` 是 `out-of-frame`
     *   —— 那一楼的正文大半是男主的内心独白，没有对白就没有 speaker。
     *   旧代码只从 speaker 取名字 ⇒ 这些格**一个外貌都没注入**，
     *   而 `subject` 里明明写着 `his upper body`。
     *   症状是「同一个人在不同页里长得不一样」，根因是外貌锚点挂在了错误的字段上。
     *
     * ⇒ 优先读 `cast`（模型填的「这格看得见谁」）；`cast` 缺失时退回 `speaker`，兼容旧草稿。
     */
    const names = panelNameList(p).map(asNarrator).filter(Boolean);
    const framing = shot === 'face' ? 'face' : (shot === 'detail' ? 'detail' : (shot === 'full' || shot === 'action' ? 'full' : 'upper'));
    /** v0.9.188：把「这一格最终是什么景别」记下来 —— 机位分配要等全页景别都定了才算（含 faceDown 降级）。 */
    panelFraming[i] = framing;
    /** 逐人去重：`cast` 里同名重复会让同一个人的外貌写两遍（多手）。 */
    const looks = [...new Set(names.map((n) => String(looksFn(n, framing) || '').trim()).filter(Boolean))].join('; ');
    const onlyFigure = !!(lay.figure && figName && names.length && names.every(sameAsFigure));

    /* ① 背景层 C：整格，只写场景（地点 + 光源 + 时间） */
    const bg = String(p.bg || '').trim().replace(/\.+$/, '');
    let bgItem = null;
    if (bg) {
      bgItem = {
        label: 'object',
        caption: `panel ${idx}, background layer filling this panel only: ${bg}.`
          + (isEmpty ? ' This panel is empty of figures: no people stand in it, only the environment.' : '')
          + (onlyFigure
            ? ' No figures inside this panel: this beat is carried by the page-tall foreground'
              + ' figure on the right, so this panel shows only the empty environment.'
            : '')
          /**
           * ★★★ v0.9.140：**大格会被模型自己再切一刀**。
           *
           * 病例（首轮八版式，`hero-top-3` 上部 0~50% 的大格）：
           * 那一格只有「两人脸贴近 + 一句台词」，填不满 50% 的高度，
           * 于是模型在格内又画了一条白线，把下半填成另一幅画（女生趴着）
           * ⇒ 版式 4 格出图像 5 格，而且第二条横带里的气泡压在人身上。
           * 参考实现不会这样，因为它的格子是人手工划定的、模型被明确告知「一格一景」。
           * ⇒ 必须显式禁止：这一格是**一个连续画面**。
           */
          /**
           * ★★★ v0.9.141：**几何正确但语义缺失时，模型会用自己的先验覆盖几何。**
           *
           * 病例（第一楼 page08，`strip4-plain`）：bbox 是四条全宽横带上下堆叠，
           * 坐标完全正确；但 caption 只写「panel 3, background layer...」，
           * 模型不知道这是长横条 → 按「4 格漫画」的先验画成 2×2 + 右侧一条竖窄条。
           * ⇒ 每格必须用**人话**说明「第几条 / 什么形状 / 邻居在哪边」。
           */
          + (where ? ' ' + where : '')
          + ' This panel is one single continuous image: do not divide it into smaller frames'
          + ' and do not draw any inner dividing line.',
        bbox: toBox(inner, width, height),
      };
      items.push(bgItem);
    } else {
      errors.push(`panel ${idx} 的 bg（背景）是空的 —— 每格都必须写地点+光源+时间`);
    }

    /* ② 主体层 S：只写这一格里看得见的那部分（上面给气泡让出的空间要刨掉） */
    if (!isEmpty && subj) {
      const slot = SUBJECT_SLOT[shot] || SUBJECT_SLOT.action;
      const y0 = Math.min(0.82, Math.max(slot[1], occupied));
      if (onlyFigure) {
        warnings.push(`panel ${idx} 的主体就是通高人物「${figName}」本人 —— 这一格不画他（由右侧通高人物承担），`
          + '只留环境与台词；内容层更好的写法是：通高版式下格子只写另一个人');
      } else {
        items.push({
          label: 'character',
          caption: `panel ${idx}, ${subj}.${looks ? ' ' + looks : ''}`
            + (faceDown ? ' ' + FACE_FALLBACK_PIN : (FRAMING_PIN[framing] ? ' ' + FRAMING_PIN[framing] : ''))
            + ' Only what is written here appears inside this panel; nothing of this person appears outside it.',
          bbox: toBox(subRect(inner, slot[0], y0, slot[2], slot[3]), width, height),
        });
        /** v0.9.188：记下「这一格的人物质在 items 的第几项」——机位句等全页算完再补进去。 */
        panelItem[i] = items.length - 1;
      }
    } else if (!subj) {
      warnings.push(`panel ${idx} 的 subject 是空的，这一格只画背景`);
    }

    /**
     * ③ 字区：气泡在最上方那一条（主体已经让开了），画外音靠左暗示声源方向。
     *
     * ★★★ v0.9.140 第二版：**气泡改成贴边窄条 + 允许竖排**。
     *
     * 病例（hero-top-3 上部大格）：宽 50% 的横排气泡框，模型画出来是
     * 一根竖长条（中文漫画习惯），正好压在她的脸上 —— 因为框宽了它就在框里
     * 找个"看起来能放字"的位置。改成 34% 窄条并允许竖排后，气泡会贴着格的
     * 边缘走，脸就空出来了。
     */
    if (bubbles.length) {
      const bw = 0.34;
      const NUM_WORD = ['zero', 'one', 'two', 'three', 'four', 'five', 'six'];
      let tyCur = B_TOP;
      bubbles.forEach((text) => {
        const rows = lineCountOf(text);
        const hExt = B_H * Math.min(2, rows);
        const tx = outOfFrame ? 0.03 : 0.62;
        /**
         * ★★★ v0.9.159：text 项的 caption **必须描述排版**，这是官方明确要求的一条。
         *
         * 依据（USERGUIDE:133 recaption 规范，官方自己的打标口径）：
         *   「Describe text layout as much as possible: line breaks, ordering, relative position,
         *     alignment, size hierarchy, font/style, color, spacing, and how text blocks are arranged.」
         * 以及 layout_REFERENCE:19：「for text, **typography and surface treatment**」。
         *
         * 旧 caption 一个排版词都没有（22 条真实 text 项里：换行描述 0、间距 0、对齐 1、字体 2），
         * 模型只能自己猜要排几行 —— 而我们在 `text` 里已经用 `\n` 指定了行数，
         * 文字行数这种「代码算得出的定值」就该直接写进 caption（记忆：别让模型数数）。
         */
        const shape = rows > 1
          ? `set in exactly ${NUM_WORD[rows] || rows} lines, the line breaks already fixed`
          : 'set on a single line';
        items.push({
          label: 'text',
          caption: `panel ${idx}, ${outOfFrame
            ? 'narrow speech bubble hugging the upper-left edge of this panel, the voice coming from off-panel'
            : 'narrow speech bubble hugging the upper-right edge of this panel with its tail toward the mouth'}, `
            + `white fill, thin black outline, hand-lettered Chinese characters running down a narrow column, `
            + `${shape}, evenly spaced and comfortably legible, kept clear of the face.`,
          text,
          bbox: toBox(subRect(inner, tx, tyCur, Math.min(0.99, tx + bw), Math.min(0.97, tyCur + hExt)), width, height),
        });
        tyCur += hExt + B_GAP;
      });
    }
  });

  /**
   * ★★★ v0.9.188：**逐格机位轮换** —— 「视角单调」的机制根因就是这一步一直缺失。
   *
   * 改之前：`FRAMING_PIN` 只管 `face`/`detail`/`full`（**景别**，画面里放多少），
   * 版式库的 `slot.shot` 只用来挑版式、一个词都不进 caption
   * ⇒ 三根轴里「机位」与「人称」完全没有约束，每一格都由模型凭先验自己定，
   *   同一个体位连出几格就是同一个机位（用户 2026-11-01：「视角很单调」）。
   *
   * 为什么放在循环**之后**：机位要看全页（相邻格不许同档、整页至少几种），
   * 而景别是在循环里被 `faceDown` 改过的 —— 只能把循环里算好的 `panelFraming` 拿出来用，
   * 事后重算一遍就是「算」与「比」用两份数据（记忆里的老坑）。
   *
   * ★ `povOk: false` 是**故意的**：POV 要求「把视角主人的完整人物质摘掉」，
   *   而这个函数是逐格按 `cast` 建档的，摘谁并不确定（性别判不出）。
   *   `dev_tmp/pose-pov-matrix.mjs` m2 的结论也说了：传教士/后入/站立用 POV 会把他的人脸画回来。
   *   ⇒ 漫画页这条先不开 POV，只做景别不受限的那几档轮换。
   */
  const pageNo = Math.max(1, Math.round(Number(draft.page) || 1));
  const vpPlan = planViewpoints({
    count: frames.length,
    framingAt: (i) => panelFraming[i] || 'upper',
    occupiedAt: (i) => Number.isInteger(panelItem[i]) && panelItem[i] >= 0,
    partner: panelsIn.some((p) => panelNameList(p).length >= 2),
    povOk: false,
    /** 跨页接续：第 2 页从第 1 页停下的下一档开始，不然每页都从同一个角度开场。 */
    offset: pageNo - 1,
  });
  const vpUsed = [];
  vpPlan.forEach((vp, i) => {
    if (!vp) return;
    const k = panelItem[i];
    if (!Number.isInteger(k) || k < 0 || !items[k]) return;
    /* ★ 一格只追加一次：每个人物项各加一份＝同一条指令出现两次，模型会取平均（已有病例）。 */
    items[k].caption = `${items[k].caption} ${vp.sentence}`;
    vpUsed.push(`P${i + 1}=${vp.id}`);
  });
  if (vpUsed.length >= 3) {
    const n = new Set(vpUsed.map((s) => s.split('=')[1])).size;
    if (n < 3) warnings.push(`这一页 ${vpUsed.length} 个格子只用了 ${n} 种机位（${vpUsed.join(' ')}）—— 视角会显得单调`);
  }

  if (overflow.length) {
    warnings.push(`有 ${overflow.length} 段台词没放下（${overflow.slice(0, 3).join(' / ')}…）`
      + ' —— 一页气泡位有限，下一页会接着出，但这一页的这几句会缺');
  }


  /* ④ 跨格通高人物：整页唯一的大人物，放**最后**画（前景压住格线） */
  if (lay.figure && figName) {
    const pose = String(fig.pose || '').trim().replace(/\.+$/, '');
    const expr = String(fig.expression || '').trim().replace(/\.+$/, '');
    const looks = String(looksFn(figName, 'full') || '').trim();
    const rect = [lay.figure.x0, 0, lay.figure.x1, 1];
    items.push({
      label: 'character',
      caption: `the single page-tall foreground figure${looks ? ' of ' + looks + '.' : ''}`
        + (pose ? ' ' + pose + '.' : '') + (expr ? ' ' + expr + '.' : '')
        + ' This figure runs in one unbroken silhouette from the top edge of the page to the bottom edge,'
        + ' standing in front of the page and crossing over the seams between the narrow panels,'
        + ' hiding only the panel edges behind it. It has no rectangular frame of its own,'
        + ' it is not an extra panel, and the same person must not be drawn a second time inside the panels.',
      bbox: toBox(rect, width, height),
    });
  } else if (lay.figure && !figName) {
    warnings.push(`版式 ${lay.id} 有通高人物栏，但内容里没给 figure.name —— 这一栏会空着`);
  } else if (!lay.figure && figName && figClash < 2) {
    /**
     * ★ v0.9.147：只有「本来可以给人物栏、却没选到」才提示。
     *
     * 原来写成 `else if (!lay.figure && figName)` —— 于是 clash≥2 的页（这类页本来就
     * 被排除了人物栏）每页都会多一条噪音，真正需要看的那条反而被埋掉。
     *
     * 实测（2026-10-29 催眠APP 第 4 楼，9 页）：9 页 `figure.name` 全填了主角本人，
     * 但每页 cast 里都有他/她 ⇒ `figClash` 恒 ≥2 ⇒ `figure.pose/expression`
     * 一页也没进过提示词，而且不报错。
     *
     * 没有改成「强行注进格子」的原因：那种页里格子 `subject` 本来就写着同一个动作
     * （如 `chin pressed down into his shoulder`），再注入一次等于同一个动作写两遍，
     * 会把人物画成两个（本项目反复踩的「重复＝实体复制」）。
     */
    warnings.push(`这一页的版式 ${lay.id} 没有通高人物栏 —— figure.pose/expression 不会单独成栏`
      + `（这一页的人物动作只在各格 subject 里生效）`);
  }

  if (!items.length) return { ok: false, errors: [...errors, '组装后没有可用 item'], warnings, stats: {} };

  /* ⑤ 版面总谱（summary.caption 第一句必须是画风句 —— 官方 §12.3） */
  const style = String(opts.style || '').trim().replace(/\.+$/, '');
  const brief = mangaLayoutBrief(lay, figName ? 'the main character' : '');
  const summary = [
    style ? style + '.' : '',
    brief,
    /**
     * ★★★ v0.9.144：这句原来写的是 `night sky, concrete, skin, hair and clothing are all painted`。
     *
     * 它是"每格都要上色、不许留线稿"的说明句，却**顺手点名了景物**。
     * 真实第一楼是下午 15:38 的屋顶，summary 里却出现 `night sky` —— 整页最高权重的一句
     * 里凭空塞进一个夜间场景词，模型完全可能把白天画成夜戏。
     * ⇒ 改成不指定具体景物的写法，只保留"全部上色"这个意思。
     */
    'Every panel is fully rendered in colour: skies, surfaces, skin, hair and clothing are all painted,',
    'no panel is left as an uncoloured sketch.',
  ].filter(Boolean).join(' ');

  const nChar = items.filter((x) => x.label === 'character').length;
  const nText = items.filter((x) => x.label === 'text').length;

  /**
   * ★★★ v0.9.154：**斜切分格（`enh.slant`）在漫画页路径上找回来了。**
   *
   * 病例（用户 2026-10-29 20:33「斜格子怎么没了？」）：
   *   斜切一直是 `mossJsonLayout.js:applyVisualEnhance()` 落的，而那个函数**只有旧
   *   JSON Layout 路径（`compileLayout`）在调**。v0.9.140 起漫画页自造成品 items、
   *   绕开 `compileLayout` ⇒ `border / slant / fill` 三项**全部静默失效**，
   *   用户的 `slant: true` 一直开着却一页也没斜过。
   *   （这是一条规则两条出口的又一次翻车 —— 加新出口时必须回头问「另一条还拿得到吗」。）
   *
   * 这里只补 `slant`，另外两项**有意不补**：
   *   · `fill`（主格撑满）—— 用户已明确否掉「脸/身体撑满框」（v0.9.150~153 反复验证），
   *     漫画页每格取景由 `FRAMING_PIN` 按景别分档给，再叠一句「撑满」会互相抵消。
   *   · `border`（粗黑框）—— 漫画页的格线是几何缝隙自己出的，实测已有黑分隔线，
   *     再加一句没有收益（也从来没在这条路径上验证过）。
   *
   * 措辞**直接用 `ENH_TEXT.slant*`**（有证据图：`docs/evidence/slant_r2.jpg` / `slant_c.jpg`），
   * 幂等判据也用同一份 `RE_HAS_SLANT`，不另抄一个正则。
   */
  const enh = normalizeMossEnhance(opts.enhance);
  let summaryAfterEnh = summary;
  let slantAt = 0;
  if (enh.slant) {
    if (!RE_HAS_SLANT.test(summaryAfterEnh)) {
      summaryAfterEnh = dropTailDot(summaryAfterEnh) + ', ' + ENH_TEXT.slantPage;
      slantAt += 1;
    }
    for (const it of items) {
      if (it.label !== 'object') continue;
      if (RE_HAS_SLANT.test(it.caption)) continue;
      it.caption = dropTailDot(it.caption) + ', ' + ENH_TEXT.slantPanel;
      slantAt += 1;
    }
    /**
     * 与旧路径同一句告警口径（`applyVisualEnhance` 里那句）：**坐标仍是矩形**，
     * 斜线是靠 caption 让模型自己画的。不说清的话，下次看到「格线歪了但框没歪」
     * 会有人去查几何代码 —— 那里本来就没有斜边。
     */
    if (slantAt) {
      warnings.push(`已改成斜切分格（${slantAt} 处描述，坐标仍是矩形 —— 模型照 caption 画斜线）`);
    }
  }

  const out = {
    /**
     * ★ v0.9.159：`meta` 改成**体裁 / 媒介**标签。
     * 官方 `layout_REFERENCE.md:15`：「`meta` (array of **medium/genre** tags)」，
     * 示例是 `["product campaign","studio photography"]` / `["poster"]` —— 里面**没有画风词**。
     * 旧值 `'anime illustration'` 把 genre（anime）和 medium（illustration）焊成一个词，
     * 送进去等于在 summary 之外又加了一句画风指令；而画风只应在 `summary.caption` 第一句出现一次。
     */
    summary: { caption: summaryAfterEnh, canvas: 'multi_panel', meta: ['manga', 'comic page'] },
    items,
    bbox_coord_space: 'abs_centralized',
    bbox_format: 'yxyx',
  };

  /* 几何自检：除通高人物外，每项都必须落在某个格框内（防槽位算错） */
  const objs = items.filter((x) => x.label === 'object').map((x) => x.bbox);
  const inside = (a, b) => a[0] >= b[0] - 2 && a[2] <= b[2] + 2 && a[1] >= b[1] - 2 && a[3] <= b[3] + 2;
  items.forEach((x, i) => {
    if (x.label === 'object') return;
    if (lay.figure && x.label === 'character' && inside(x.bbox, toBox([lay.figure.x0, 0, lay.figure.x1, 1], width, height))) return;
    if (!objs.some((o) => inside(x.bbox, o))) {
      warnings.push(`items[${i}]（${x.label}）不在任何格框内 —— 槽位计算出错，请报 bug`);
    }
  });

  return {
    ok: true,
    out,
    errors,
    warnings,
    stats: {
      layout: lay.id,
      panels: frames.length,
      characters: nChar,
      texts: nText,
      items: items.length,
      /** v0.9.149：模型答的「最重的是第几条」与版式实际的主格位置（0 基，-1 = 无主格）。 */
      mainBeat,
      mainPanel: mainPanelIndex(lay),
      /**
       * v0.9.153：`mainBeat` **这次有没有真的生效**（false = 那一条是特写，被主动摘掉了）。
       * 区分「模型没填」和「填了但按判据不该放大的」—— 只有后者是 `mainBeat>0 && !beatHonored`。
       */
      beatHonored: !!pickOpts.mainBeat,
      /** v0.9.152：被降级成半身的特写格（1 基序号），空数组 = 这一页没有硬塞。 */
      faceDowns,
    },
  };
}

/** 给日志/诊断看的版式说明。 */
export { describeMangaLayout, mangaLayoutOf };
