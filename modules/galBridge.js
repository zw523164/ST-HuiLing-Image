/**
 * GAL 桥（v0.9.164）—— 让 GAL 前端（Immersive Galgame System，简称 IGS）
 * 借用绘灵的「写词 + 出图」。
 *
 * ══════════════════════════════════════════════════════════════════
 * 一、为什么是「借 dbgen 通道」而不是「自己加第五条通道」
 * ══════════════════════════════════════════════════════════════════
 * GAL 的 bundle（`app/dist/igs.bundle.js`）里，图像来源是**写死的枚举 + 硬编码分支**：
 *
 *     H = Object.freeze(["nai","dbgen","extension","baibai"])
 *     Zt==="dbgen" ? Re(Yt) : Zt==="extension" ? mi(...) : ...
 *
 * `Object.freeze` 的常量数组，加上 if/else 硬分派 —— 没有「注册第五条」的插槽。
 * 要真加一条，只能 fork 它 6.6MB 的压缩 bundle 并自建 CDN 地址
 * （loader 支持 `IGS_LOADER_CONFIG.base`），GAL 每次更新都要重新打补丁。
 *
 * 而 `dbgen` 这条通道的语义**恰好**就是我们要的：
 *     `ownPrompts: true` → 提示词由外部插件写、图也由外部插件出。
 * 所以这里实现它的接口契约，零侵入接入。
 *
 * ══════════════════════════════════════════════════════════════════
 * 二、接口契约（从 bundle 里逐字读出来的，不是我编的）
 * ══════════════════════════════════════════════════════════════════
 * GAL 在 `window` / `window.top` / `window.parent` / `globalThis` 四处找
 * `NaiDbGen`，并要求 `typeof .generate === 'function'`。
 *
 * ① 写词：`generateSinglePrompt({ description, skipRecall, messageId, signal })`
 *    → `{ ok, value: { caption, captions: [{ slotId, caption, anchorSentence, width, height }] } }`
 *    · `caption` 不是字符串，是 **NAI V4 结构**，GAL 会校验 `v4_prompt.caption.base_caption` 非空
 *    · 只有 `generate` 没有 `generateSinglePrompt` 时，自动出图/补全素材会报「版本过旧」
 *
 * ② 出图：`generate({ caption, replaceCharacterKeywords, signal, shouldStart, artist, params })`
 *    → `{ ok: true, value: [ { blob, mimeType } ] }`
 *    · `value[0].blob` 必须是**真 Blob**，否则 GAL 判「没有返回图片」
 *
 * ③ 取消：`signal` abort 时必须回 `{ ok:false, reason:'request-stale', stopGeneration:true }`
 *    超时（写词 300s / 出图 180s）只播报「仍在出图」，不会中止调用。
 *
 * ══════════════════════════════════════════════════════════════════
 * 三、角色设定以谁为准 —— 这条决定了整个实现有多简单
 * ══════════════════════════════════════════════════════════════════
 * GAL 传来的 `description` 长这样（`externalPromptDescription` 拼的，源码逐字）：
 *
 *     {画面描述}
 *
 *     【角色设定】
 *     1. 按角色名逐一对应使用本人的外貌、排除项、性格和当前衣装…
 *     …
 *     角色「夜斗」
 *     外貌：
 *     …
 *     性格：
 *     …
 *     当前衣装「校服」：
 *     …
 *
 *   也就是说**角色设定（外貌 / 排除项 / 性格 / 当前衣装）GAL 已经全套给齐了**，
 *   而且它明确要求「按角色名逐一落实」。所以我们不需要再注入绘灵档案的锚点 ——
 *   两套设定同时写进同一张图，就是「重复＝实体复制」那条老病（同一件事写两遍）。
 *
 *   ⇒ v1 口径：**设定听 GAL 的，绘灵负责「按当前模版编译成它要的格式 + 出图」**。
 *     绘灵档案不参与（想看档案优先，以后再加开关，别一上来就双写）。
 *
 * ══════════════════════════════════════════════════════════════════
 * 四、用户主权区（不可越界）
 * ══════════════════════════════════════════════════════════════════
 * GAL 会传 `params.width/height`（来自它自己那套按取景算的尺寸）、`v4_negative_prompt`、
 * `seed`、`straight_alpha`。按长期规矩「采样参数 / 尺寸 / 负面 = 用户主权」：
 *   · 尺寸：**一律用绘灵自己 `resSelector` 算出来的**，GAL 传的值只写进日志；
 *   · 负面：**只用 `cfg.globalNegative` 原文**，不接 GAL 的（插件从不生成负面）；
 *   · seed：不接。
 * 这样 GAL 那边看起来「尺寸不对」时，用户能在绘灵这边找到唯一真源，而不是两头找。
 */
import { getConfig, getActiveTemplate, activeOutput, activeEngine, saveSettings } from './settings.js';
import { callAnalyzeLLM } from './api.js';
import { submit } from './backends/comfyui.js';
import { singleJsonPrompt, renderOutfitLine } from './consistency.js';
import { buildGalWritingSpec } from './prompts.js';
import { layoutToLine } from './mossJsonLayout.js';
import { estimateResolution } from './resSelector.js';
import { info, warn, debug, STAGE } from './log.js';
import { galCanInsertAt, galInsertChecker, galBodyAudit, wrapStoryInContent } from './galBody.js';
import { listCast, getDyn, resolveOutfitStyle, recentGalShots, pushGalShot } from './store.js';
import { sceneDbPromptLines } from './sceneDb.js';

/** 我们自己挂上去的标记（排查用，GAL 不认这个名字，只认 `NaiDbGen`） */
export const GAL_BRIDGE_KEY = '__HuiLingGalBridge__';

/** GAL 用来找插件的名字 —— 必须叫这个，写死在对面的 bundle 里 */
export const GAL_ENTRY_NAME = 'NaiDbGen';

/**
 * 「又有新东西可看了」的广播事件名（v0.9.181）。
 *
 * ★ 为什么需要：外部联动面板的整页 HTML 是在**挂载那一刻**由 `galBridgeStatus()`
 *   快照生成的，之后写词 / 出图都不会重绘 ⇒ 面板会一直停在「你打开它时那一楼」。
 *   实测症状：用户已经画到 22 楼，面板里最新一批还是 12 楼，看起来像「记录丢了」。
 *   （数据一直是好的：`promptLog` 里 22 楼就排在第一。）
 *
 * ★ 为什么用 `window` 事件而不是回调注册：UI 层和这里不允许互相 import
 *   （`ui/gal.js` 已经 import 本模块，反向会成环）。事件是单向的、无状态的，
 *   面板没挂的时候它就是空转，不会留下任何需要清理的引用。
 */
export const GAL_UPDATE_EVENT = 'huilin:gal-update';

/**
 * 广播一次「留档变了」。
 * @param {'prompt'|'paint'|'call'} [kind] 哪一类变了（UI 目前只用于日志，不做分支）
 */
function notifyGalUpdate(kind) {
  try {
    const g = globalThis;
    if (typeof g.dispatchEvent !== 'function') return;
    const detail = { kind: kind || '', at: Date.now() };
    g.dispatchEvent(typeof g.CustomEvent === 'function'
      ? new g.CustomEvent(GAL_UPDATE_EVENT, { detail })
      : Object.assign(new g.Event(GAL_UPDATE_EVENT), { detail }));
  } catch { /* 广播失败绝不能影响写词 / 出图 */ }
}

/** GAL 的 description 里，角色设定段的固定分隔串 */
export const GAL_CAST_MARK = '【角色设定】';

/** 出厂默认值（新装的用户、以及老配置迁移后的补充） */
export const GAL_BRIDGE_DEFAULTS = Object.freeze({
  /** 总开关。默认关：避免和以后真装的 NaiDbGen 抢同名 */
  enabled: false,
  /** 让 GAL 下拉里那行字显示成「绘灵」（纯 DOM 改字样，不碰逻辑） */
  renameEntry: false,
  /**
   * 要不要把 GAL 传进来的**画师串**（`generate({artist})`，按图片类型分 9 组）拼进提示词。
   *
   * ★ 为什么是布尔而不是「GAL / 绘灵 二选一」：
   *   绘灵自己的画风词（`globalPrefix` / `globalSuffix`）是在**写词阶段**
   *   由 `mergeLayoutGlobalWords` 并进 `summary.caption` 的 —— 那个函数在出图时
   *   早就跑完了。也就是说「选绘灵」这一档根本没有东西可切，写成四选一就是骗人。
   *   所以这里只控制**额外要不要加 GAL 那一层**；想只用 GAL 的画风，
   *   把绘灵的全局前缀/后缀清空即可（面板上会提示）。
   */
  useGalArtist: true,
  /**
   * 画布尺寸：
   *   gal    —— 跟随 GAL（默认）。这是用户明确授权的：GAL 那边有立绘/小道具/背景
   *             会各自改尺寸，交给它定比绘灵猜准；出图前仍会**对齐到倍数**（默认 16），
   *             避免 MOSS 被悄悄挪进相邻桶导致尺寸漂移。
   *   huilin —— 用绘灵 `resSelector` 算出来的（想完全自己控尺寸时选它）。
   */
  canvasSource: 'gal',
  /**
   * 角色的「外貌」听谁的 —— 这一档决定写词时 `【角色设定】` 里的外貌段长什么样。
   *
   *   huilin —— **用绘灵角色档案**（默认）。把 GAL 那段 `外貌：`（若有）换成
   *             档案里的 `nlProfile`（没有就拼 hair / eyes / face / skin / body）。
   *             「替换」不是「追加」：同一件事写两遍模型只会挑一条听。
   *   gal    —— 原样透传，GAL 给什么用什么（它的 `characterDna` 为空时，
   *             写词模型只能从剧情正文里猜外貌）。
   *
   * ★ 为什么默认 huilin：用户在绘灵里管档案是既有习惯，改完就该立刻生效；
   *   GAL 那边填 DNA 是另一套入口，两边同时维护必然对不上。
   * ★ 服装**不在此列**：服装始终听 GAL（它按段落给 `当前衣装「名」` + wardrobe DNA），
   *   绘灵档案的静态字段一律不许碰服装，否则又是「同一事实两处描述」。
   */
  appearanceSource: 'huilin',
  /**
   * 角色的**服装**听谁的 —— 款式 / 状态（完好·半褪·褪下）/ 裸露描述，三样一起算，
   * 不存在「款式听 GAL、状态听绘灵」这种混搭（混搭必然出现两套说法）。
   *
   *   gal    —— 原样透传 GAL 的 `当前衣装「名」：<wardrobe DNA>`（默认）。
   *   huilin —— 换成绘灵档案那一行 `服装=<款式>, <状态事实>（服装状态=…；裸露=…）`。
   *
   * ★ 硬限制（面板上必须写明，不要让用户以为切了就一定对）：
   *   GAL 接管期间绘灵**不扫楼层**（`scanner.js` 直接 return），所以 dyn 里的服装
   *   停在「最后一次单独用绘灵时」的状态。要它跟着剧情走，得先让扫描跑起来。
   */
  outfitSource: 'gal',
  /**
   * GAL 接管期间要不要**只跑服装态扫描**（不写图位、不分析出图）。
   *
   * 默认开：不开的话 dyn 里的款式/状态/裸露永远停在「最后一次单独用绘灵时」，
   * 切到「服装来源＝绘灵档案」拿到的就是旧衣服。扫描一次只有一个小 LLM 调用，
   * 而且按正文指纹去重（同一楼只扫一次）。
   */
  outfitScan: true,
});

/** 读 GAL 配置并补齐默认值 —— 老配置里没有这些键时不能是 undefined */
export function galConfig(cfg) {
  const g = (cfg || getConfig()).galBridge || {};
  return {
    ...GAL_BRIDGE_DEFAULTS,
    ...g,
    useGalArtist: g.useGalArtist !== false,
    /* 只有**显式**选了 huilin 才回到绘灵；没设过（老配置）一律跟随 GAL */
    canvasSource: g.canvasSource === 'huilin' ? 'huilin' : 'gal',
    /* 外貌反过来：只有**显式**选了 gal 才交回 GAL，其余一律以绘灵档案为准 */
    appearanceSource: g.appearanceSource === 'gal' ? 'gal' : 'huilin',
    /* 服装反方向：只有**显式**选了 huilin 才换成绘灵，没设过一律跟随 GAL */
    outfitSource: g.outfitSource === 'huilin' ? 'huilin' : 'gal',
    /* 只有显式关掉才不扫；没设过一律扫（否则切到绘灵服装拿到的是旧数据） */
    outfitScan: g.outfitScan !== false,
  };
}

/**
 * GAL 在 description 里写死的构图尺寸。
 *
 * 实测原句（0.9.172 线上 `lastInput` 第二段）：
 *   「画面是横的，宽1216，高832。构图按横屏写，不要写成竖屏。」
 *
 * ★ 为什么需要它：`params.width/height` 只有 GAL 的图位**设过尺寸**才有，
 *   没设时整个字段不传，「跟随 GAL」就没有可跟的数字，会静默退回绘灵自己的
 *   竖图（用户看到的就是「它明明要横的，出来的却是竖的」）。
 */
export function parseGalCanvasFromDesc(text) {
  const s = String(text || '');
  const w = /宽\s*(\d{2,5})/.exec(s);
  const h = /高\s*(\d{2,5})/.exec(s);
  if (!w || !h) return null;
  const width = Number(w[1]);
  const height = Number(h[1]);
  if (!(width > 0 && height > 0)) return null;
  return { width, height };
}

/**
 * 「GAL 接管中吗」—— 定义在 `settings.js`（避免反向 import 成环），这里转出，
 * 让调用方只需认 `galBridge.js` 一个入口。全插件只有这一份判据。
 */
export { galTakeover } from './settings.js';

/* ═══════════ 纯函数（可单测，不碰 window / 网络）═══════════ */

/**
 * 把 GAL 的 description 拆成「画面描述」与「角色设定」两段。
 *
 * 拆开来干什么：画面描述是**这一次画什么**，角色设定是**这些人长什么样**。
 * v1 两段都照样交给模型（不做取舍），但拆出来后：
 *   · 日志里能分别看到两段长度 —— 「GAL 没给设定」这种问题一眼可见；
 *   · 以后要改成「档案优先」时，只需要换掉 `cast` 那一段，不用重写解析。
 *
 * 没有 `【角色设定】` 标记时（GAL 改了拼法、或用户手写调用）整段当画面描述，
 * `cast` 为空 —— 不抛错，出图照常。
 */
export function splitGalDescription(text) {
  const s = String(text == null ? '' : text);
  const i = s.indexOf(GAL_CAST_MARK);
  if (i < 0) return { scene: s.trim(), cast: '' };
  return { scene: s.slice(0, i).trim(), cast: s.slice(i).trim() };
}

/* ═══════════ 外貌来源：GAL 的「角色设定」 vs 绘灵角色档案 ═══════════ */

/**
 * GAL 拼出来的「外貌」标签行，形态不止一种（`src/scene/character-identity.js`）：
 *   `外貌：`
 *   `半身外貌：` / `全身外貌：` / `头像外貌：`
 *   `全身外貌（本次半身只取可见特征）：`
 * 所以不能写死 `=== '外貌：'`，否则带视图前缀的那一版会漏过去、变成两份外貌并存。
 */
const GAL_LOOKS_LABEL_RE = /^[^\n：]{0,12}外貌(?:（[^）]{0,24}）)?[：:]$/;

/** 角色设定段里的其它标签行（`性格：` / `当前衣装「校服」：` / `身份排除项：` …） */
function isCastLabelLine(line) {
  const t = String(line || '').trim();
  if (!t || t.length > 24) return false;
  if (!/[：:]$/.test(t)) return false;
  /* 标签行不会带句读；带的是正文，不能当分隔 */
  return !/[。，、；！？]/.test(t);
}

/**
 * 从绘灵档案取「一句外貌」。
 *
 * ★ 白名单写死，不用 `Object.values(fields)`：
 *   档案的静态字段里还可能有 `服装状态` / `状态` / `情绪`，那些是**服装与动态**，
 *   一律归 GAL 管。整包倒进来就是「同一事实两处描述」，模型只挑一条听。
 */
export function looksLineOf(item) {
  /* `listCast()` 给的是 `{name, entry, locked, scope}` 包装；也允许直接传裸 entry */
  const entry = (item && item.entry) || item || {};
  const f = entry.fields || {};
  const nl = String(f.nlProfile || entry.nl || '').trim();
  if (nl) return nl;
  return ['sex', 'hair', 'eyes', 'face', 'skin', 'body', 'mark']
    .map((k) => String(f[k] || '').trim())
    .filter(Boolean)
    .join(', ');
}

/**
 * 角色名匹配：精确 → 全名/简称容错。
 * 卡片登记「夜斗」、GAL 正文写「神谷夜斗」时必须能认出来（取最长匹配，避免「太太」这类短名乱撞）。
 */
export function matchCastEntry(list, name) {
  const n = String(name || '').trim();
  if (!n) return null;
  const arr = Array.isArray(list) ? list : [];
  const exact = arr.find((e) => e && e.name === n);
  if (exact) return exact;
  const loose = arr
    .filter((e) => e && e.name && e.name.length >= 2 && (n.includes(e.name) || e.name.includes(n)))
    .sort((a, b) => b.name.length - a.name.length);
  return loose[0] || null;
}

/**
 * 把单个角色块里的外貌换掉。
 * @returns {string|null} 改写后的块；`null` = 不需要改（内容一致）
 */
function rewriteLooksSegment(seg, looks) {
  const lines = String(seg == null ? '' : seg).split('\n');
  let idx = -1;
  for (let k = 0; k < lines.length; k += 1) {
    if (GAL_LOOKS_LABEL_RE.test(lines[k].trim())) { idx = k; break; }
  }
  if (idx < 0) {
    /* GAL 没给外貌（它的 characterDna 为空时就是这样）→ 直接补在角色名下面 */
    return [lines[0], '外貌：', looks, ...lines.slice(1)].join('\n');
  }
  let end = lines.length;
  for (let k = idx + 1; k < lines.length; k += 1) {
    if (isCastLabelLine(lines[k])) { end = k; break; }
  }
  const oldText = lines.slice(idx + 1, end).join('\n').trim();
  if (oldText === String(looks).trim()) return null;
  return [...lines.slice(0, idx + 1), looks, ...lines.slice(end)].join('\n');
}

/**
 * 按「外貌来源」改写 GAL 的 description。
 *
 * ★ 只动 `【角色设定】` 段里每个 `角色「X」` 块的**外貌**，其余（性格 / 排除项 /
 *   当前衣装 / 画面描述 / 尺寸那句）一个字都不碰 —— 服装与画布仍是 GAL 说了算。
 * ★ `appearanceSource==='gal'`、没有角色设定段、档案里没有这个人 —— 三种情况都
 *   **原串原样返回**，不做任何近似修正（宁可交回 GAL，也不许拿别人的脸顶上）。
 *
 * @param {string} description GAL 传来的原文
 * @param {object} [cfg] 配置（缺省读当前配置）
 * @param {{replaced?:number, source?:string}} [stats] 可选：带出来给日志用
 */
export function applyAppearanceSource(description, cfg, stats) {
  const g = galConfig(cfg);
  const text = String(description == null ? '' : description);
  if (stats && typeof stats === 'object') {
    stats.source = g.appearanceSource;
    stats.replaced = 0;
  }
  if (g.appearanceSource !== 'huilin') return text;
  const at = text.indexOf(GAL_CAST_MARK);
  if (at < 0) return text;

  let cast = [];
  try { cast = listCast(); } catch { return text; }
  if (!Array.isArray(cast) || !cast.length) return text;

  const head = text.slice(0, at);
  const body = text.slice(at);
  const re = /角色「([^」]{1,40})」/g;
  const marks = [];
  let m;
  while ((m = re.exec(body))) marks.push({ name: m[1].trim(), at: m.index, end: re.lastIndex });
  if (!marks.length) return text;

  let out = body.slice(0, marks[0].at);
  let touched = 0;
  for (let k = 0; k < marks.length; k += 1) {
    const segEnd = k + 1 < marks.length ? marks[k + 1].at : body.length;
    const seg = body.slice(marks[k].end, segEnd);
    out += body.slice(marks[k].at, marks[k].end);
    const entry = matchCastEntry(cast, marks[k].name);
    const looks = entry ? looksLineOf(entry) : '';
    const rewritten = looks ? rewriteLooksSegment(seg, looks) : null;
    if (rewritten) { out += rewritten; touched += 1; } else out += seg;
  }
  if (stats && typeof stats === 'object') stats.replaced = touched;
  if (!touched) return text;
  return head + out;
}

/* ─────────── 服装来源：GAL 的 wardrobe  vs 绘灵档案的服装行 ─────────── */

/** GAL 的衣装标签行：`当前衣装「校服」：` / `当前衣装：` */
const GAL_OUTFIT_LABEL_RE = /^当前衣装(?:「[^」]{0,60}」)?[：:]$/;

/** 块尾的连续空行（它们负责隔开下一个角色块，替换时必须原样保留） */
function trailingBlankLines(lines) {
  const out = [];
  for (let k = lines.length - 1; k >= 0 && !lines[k].trim(); k -= 1) out.unshift(lines[k]);
  return out;
}

/** 换掉单块里的「当前衣装」内容 */
function rewriteOutfitSegment(seg, outfitLine) {
  /* 换行符原样保留：`\r\n` 环境里 split('\n') 会把 `\r` 留在行尾，join 回去时逐字一致 */
  const lines = String(seg == null ? '' : seg).split('\n');
  let idx = -1;
  for (let k = 0; k < lines.length; k += 1) {
    if (GAL_OUTFIT_LABEL_RE.test(lines[k].trim())) { idx = k; break; }
  }
  if (idx < 0) {
    /* GAL 没给衣装段 → 补在角色块末尾 */
    const tail = trailingBlankLines(lines);
    const bodyEnd = lines.length - tail.length;
    return [...lines.slice(0, bodyEnd), '当前衣装：', outfitLine, ...tail].join('\n');
  }
  let end = lines.length;
  for (let k = idx + 1; k < lines.length; k += 1) {
    if (isCastLabelLine(lines[k])) { end = k; break; }
  }
  const oldBlock = lines.slice(idx + 1, end);
  const oldText = oldBlock.join('\n').trim();
  if (oldText === outfitLine) return null;
  /**
   * ★★★ v0.9.183：块尾的空行必须**原样还回去**。
   *
   * 旧实现是 `[...slice(0,idx+1), outfitLine, ...slice(end)]`，把 `[idx+1, end)` 里的
   * 空行一并吞掉 ⇒ 下一个角色块的头被粘到上一行末尾：
   *
   *     …her belly bare（服装状态=解开(undone)）角色「月咏深雪」
   *     外貌：
   *
   * `角色「名」` 从此不在行首，模型会把两个角色读成一个人 ——
   * 表现就是「人物串味 / 外貌与服装对不上」。
   */
  const tail = trailingBlankLines(oldBlock);
  return [...lines.slice(0, idx + 1), outfitLine, ...tail, ...lines.slice(end)].join('\n');
}

/**
 * 按「服装来源」改写 GAL 的 description。
 *
 * ★★★ 款式 / 状态 / 裸露是**一件事**，必须整包换（用户口径：「走绘灵就相当于 GAL 里的服装
 *   全走绘灵档案」）。只换状态不换款式，等于让模型「用 GAL 的校服 + 绘灵说的半褪」——
 *   两套说法共存，模型只会挑一条听，这正是服装漂移的老病。
 *   绘灵那一行本来就「一个字段说完整」：`服装=<主品类>（服装状态=…；裸露=…）`。
 *
 * ★ 拿不到就**原样交回 GAL**（角色没建档 / dyn 里款式与状态都空 / renderOutfitLine 返回空串）。
 *   绝不拿「未记录」去顶掉 GAL 手里那套真实衣装。
 *
 * @param {string} description GAL 传来的原文
 * @param {object} [cfg]
 * @param {{replaced?:number, source?:string}} [stats]
 */
export function applyOutfitSource(description, cfg, stats) {
  const g = galConfig(cfg);
  const text = String(description == null ? '' : description);
  if (stats && typeof stats === 'object') {
    stats.source = g.outfitSource;
    stats.replaced = 0;
  }
  if (g.outfitSource !== 'huilin') return text;
  const at = text.indexOf(GAL_CAST_MARK);
  if (at < 0) return text;

  let cast = [];
  try { cast = listCast(); } catch { return text; }
  if (!Array.isArray(cast) || !cast.length) return text;

  const head = text.slice(0, at);
  const body = text.slice(at);
  const re = /角色「([^」]{1,40})」/g;
  const marks = [];
  let m;
  while ((m = re.exec(body))) marks.push({ name: m[1].trim(), at: m.index, end: re.lastIndex });
  if (!marks.length) return text;

  let out = body.slice(0, marks[0].at);
  let touched = 0;
  for (let k = 0; k < marks.length; k += 1) {
    const segEnd = k + 1 < marks.length ? marks[k + 1].at : body.length;
    const seg = body.slice(marks[k].end, segEnd);
    out += body.slice(marks[k].at, marks[k].end);
    const entry = matchCastEntry(cast, marks[k].name);
    let line = '';
    if (entry) {
      try {
        const dyn = getDyn(entry.name);
        if (dyn) {
          /**
           * ★★★ 先判「绘灵这边到底有没有服装信息」，再决定要不要调 `renderOutfitLine`。
           *
           * 那个函数在「服装机开着 + 一条记录都没有」时会返回 `服装=(未记录)（服装状态=完好）`
           * —— 那是给人看的占位，直接塞给 GAL 等于用「未记录」顶掉它手里那套真衣装，
           * 出图就没有衣服了。所以这里自己判：款式 / 状态 / 裸露三样全空 ⇒ 交回 GAL。
           */
          const o = dyn.outfit || {};
          const hasStyle = String(resolveOutfitStyle(dyn) || o.style || '').trim();
          const hasBare = String(o.bare || '').trim();
          const hasState = o.state && o.state !== 'intact';
          if (hasStyle || hasBare || hasState) {
            /**
             * ★ v0.9.183：把性别传下去 —— 状态展开句里的所有格（`his` / `her`）靠它选。
             *   不传时回落 `her`（既有文案基准），男角色就会被写成「裙子正从她的臀部滑落」。
             *   `listCast()` 返回的是 `{name, entry, …}` 包装，sex 在 `entry.fields` 里。
             */
            const sex = entry?.entry?.fields?.sex || entry?.fields?.sex || '';
            line = String(renderOutfitLine(dyn.outfit, dyn, { sex }) || '').trim();
          }
        }
      } catch { line = ''; }
    }
    const rewritten = line ? rewriteOutfitSegment(seg, line) : null;
    if (rewritten) { out += rewritten; touched += 1; } else out += seg;
  }
  if (stats && typeof stats === 'object') stats.replaced = touched;
  if (!touched) return text;
  return head + out;
}

/* ═══════════ 插入锚点：没有它，图生成了也贴不上去 ═══════════ */

/**
 * ★★★ 这一条是「图只能在后端看到」的真正原因（v0.9.168）。
 *
 * GAL 拿到图之后并不是直接贴进消息，而是先在**正文里找一个落点**：
 *
 *     const _a = String(tr.anchorSentence || tr.anchor || "").trim();
 *     const wa = M(tt.text, _a);        // 在楼层正文里找这句
 *     if (wa.index < 0) continue;       // ← 静默丢弃，只在控制台留一条 warn
 *
 * 匹配实现（`illustration/marker-placer.js` 的 `findAnchorInsertIndex`）分三级：
 * 原文精确 → 去空白标点的归一化 → 最长公共子串（阈值 `max(4, 40% 长度)`）；
 * 而**空串直接判 `{index:-1, mode:'fail'}`**。
 *
 * 我们此前一直传空串 ⇒ 每一张图都被判「没有能对上正文的生成点」⇒
 * ComfyUI 里图是真的产出了，界面上一张都看不见。
 *
 * 所以这里要做的是一件很具体的事：**从该楼正文里取一句真实存在的原文**。
 * 依据：GAL 传给写词的 `description` 第一段，本身就是正文片段的拼接
 * （`description: Ki.paragraphs.slice(at-2, at).map(p=>p.text).join(' ')`），
 * 所以「正文里一定找得到它」这件事是结构上成立的，不是猜。
 */
export const ANCHOR_MIN_CHARS = 8;

/** 归一化：去掉全部空白与标点、转小写（与 GAL 的 `o()` 同口径） */
function normAnchorText(s) {
  return String(s == null ? '' : s)
    .replace(/\s+/g, '')
    .replace(/[，。！？、；：""''「」『』（）【】《》,.!?;:'"()[\]{}—…·~～]/g, '')
    .toLowerCase();
}

/** 归一化 + 位置映射（能把归一化下标换算回原文下标） */
function normWithMap(s) {
  const src = String(s == null ? '' : s);
  const low = src.toLowerCase();
  const out = [];
  const map = [];
  for (let i = 0; i < src.length; i += 1) {
    const ch = low[i];
    if (/\s/.test(ch)) continue;
    if (/[，。！？、；：""''「」『』（）【】《》,.!?;:'"()[\]{}—…·~～]/.test(ch)) continue;
    out.push(ch);
    map.push(i);
  }
  return { norm: out.join(''), map };
}

/** 按句切分（换行也算断句），只留够长的句子 */
function splitAnchorSentences(s) {
  return String(s == null ? '' : s)
    .split(/[\n。！？!?；;]+/)
    .map((x) => x.replace(/^[\s"'“”「」『』()（）\-—·]+/, '').replace(/[\s"'“”「」『』()（）\-—·]+$/, ''))
    .filter((x) => x.length >= ANCHOR_MIN_CHARS);
}

/** 取 `idx` 所在的整句原文（向前后找最近的句读/换行），并清掉行内标签 */
function sentenceAt(body, idx) {
  const s = String(body || '');
  if (!(idx >= 0)) return '';
  let a = idx;
  while (a > 0 && !/[。！？!?\n]/.test(s[a - 1])) a -= 1;
  let b = idx;
  while (b < s.length && !/[。！？!?\n]/.test(s[b])) b += 1;
  return s.slice(a, b)
    .replace(/<[^>]{1,80}>/g, '')
    .replace(/[[\]]{2,}/g, '')
    .trim();
}

/**
 * 从「楼层正文」里挑一句能当作插入锚点的原文。
 *
 * 三级，从强到弱：
 *   ① `scene` 里某句**原文**在正文里出现 → 直接用它（GAL 侧 exact 必中）
 *   ② 归一化后再找一次（正文里有全角/半角、空格差异时）
 *   ③ 用 `scene` 的 20 字窗口滑一遍，命中就把窗口扩成**正文里的整句**
 *
 * 三级都不中就返回空串 —— 空串等于这张图不会贴上去，所以要如实返回、
 * 不许拿「正文第一句」之类的假锚点糊弄（贴错位置比不贴更糟）。
 */
export function pickAnchorSentence(bodyText, sceneText, opts) {
  const body = String(bodyText || '');
  const scene = String(sceneText || '');
  if (!body.trim() || !scene.trim()) return '';

  const cands = splitAnchorSentences(scene);
  if (!cands.length) return '';

  /**
   * `preferTail`：从**最后一句**往前挑（v0.9.172）。
   * 只在「拿画面描述段自身当正文」的兜底里用 —— 那时整段都是合法的，
   * 挑最后一句最贴近图位（GAL 拿锚点在正文里的下标定位段落，越靠后图越靠下）。
   */
  const order = opts?.preferTail ? [...cands].reverse() : cands;

  // ① 原文精确
  for (const s of order) {
    if (body.includes(s)) return s;
  }

  const { norm, map } = normWithMap(body);

  // ② 归一化
  for (let i = cands.length - 1; i >= 0; i -= 1) {
    const ns = normAnchorText(cands[i]);
    if (ns.length < ANCHOR_MIN_CHARS - 2) continue;
    const k = norm.indexOf(ns);
    if (k >= 0) {
      const hit = sentenceAt(body, map[k]);
      if (hit) return hit;
    }
  }

  // ③ 20 字窗口兜底
  const nScene = normAnchorText(scene);
  const WIN = 20;
  if (nScene.length >= WIN) {
    for (let i = 0; i + WIN <= nScene.length; i += 4) {
      const k = norm.indexOf(nScene.slice(i, i + WIN));
      if (k >= 0) {
        const hit = sentenceAt(body, map[k]);
        if (hit && hit.length >= ANCHOR_MIN_CHARS) return hit;
      }
    }
  }
  return '';
}

/* ─────────── 从楼层正文里摘锚点（v0.9.173，修「图永远贴不上」）─────────── */

/**
 * ★★★ v0.9.168~172 一直在 GAL 的 `description` 里找锚点句，**方向从头就是错的**。
 *
 * 错在哪：
 *   · 我以为 description 第一段是正文片段（那是另一处 `Ki.paragraphs.slice(at-2,at)`
 *     的形态，串到了这个接口上）；
 *   · 实测（0.9.172 线上 `lastInput`，全长 780 字）这个接口的 description 是
 *     **四段给插件的指令**：
 *       ① 「为本楼生成 3 张 CG……slotid 沿用本次召回分配的编号……」
 *       ② 「画面是横的，宽 1216，高 832。构图按横屏写……」
 *       ③ 「衣装变化按正文生成点取值……[{"characterKey":"…","offset":1862,…}]」
 *       ④ 「场景描述人数、环境和共同互动……」
 *     后面才是 `【角色设定】`（这一段 GAL 确实会写）。
 *     ⇒ `splitGalDescription` 切出的 `scene` 就是这四段指令，
 *       **一句正文原句都没有**（实测 `阴暗狭窄的过道` / `跳箱` 均不在其中）
 *     ⇒ 拿它当锚点，`p()` 的三级匹配一条都中不了 ⇒ 整楼图被 GAL 丢弃。
 *
 * GAL 在 description 里把话说得很直白（原句）：
 *   「**挂载点只从剧情正文里逐字摘原句**，提示词、出图指导、标签和正文以外的
 *     内容不要拿来当挂载点，也不要画进 CG。」
 * —— 这是对**插件**的要求。所以唯一正确做法是：**从楼层正文里原样截一句**。
 * 原样截取意味着它是 `tt.text` 的连续子串 ⇒ `p()` 的 exact 第一轮必然命中。
 */

/** 施工数据块（整块跳过）。★ 不加 `content`/`now_plot` —— 那里是剧情。 */
const SCAFFOLD_TAGS = [
  'draft', 'update', 'update_analysis', 'json_patch', 'analysis', 'thinking', 'think',
  'action', 'options', 'option', 'option_list', 'choice', 'summary', 'details', 'recap',
  'contents', 'StatusPlaceHolderImpl',
  /**
   * ★ `scene_time` 也要算施工块（v0.9.175 加的）。
   *
   * 它里面是 `2026-09-17T20:17|星期三|夜|雾` 这种时间戳 —— 不是剧情，但也**不是空行**：
   * `isScaffoldLine` 会因为它含「星期三/夜/雾」而放行，于是时间戳混进喂给写词模型的
   * 正文里（实测 `galStoryText` 的 B5 用例就是这么红的）。
   * 锚点也不该落在时间行上（贴上去等于把图挂在时间戳后面）。
   */
  'scene_time',
];

/**
 * 算出「施工数据块」在正文里的区间。
 *
 * ★ 为什么必须按**块**算而不是按行判：真实楼层里 `<update_analysis>` 内部是
 *   Markdown 列表（`- analyze if 任务 completed: Task "..."`），逐行看「有中文就算剧情」
 *   根本挡不住 —— 线上探测就抓到锚点落在这一行里（`催眠APP的初次试用" not yet
 *   completed as hypnosis was not cast`），贴上去等于贴在施工数据里。
 *
 * ★ 未闭合的开标签（卡牌常写 `<thinking>` 不带闭标签）取到**文末**：
 *   这类块吞掉的都是紧随其后的元数据，剧情在它前面；宁可少找几行，也不许贴进块里。
 */
function scaffoldRanges(body) {
  const s = String(body || '');
  const out = [];
  for (const tag of SCAFFOLD_TAGS) {
    const opens = [];
    const openRe = new RegExp(`<${tag}\\b[^>]*>`, 'gi');
    let m;
    while ((m = openRe.exec(s)) !== null) {
      if (/\/\s*>$/.test(m[0])) { out.push([m.index, m.index + m[0].length]); continue; }
      opens.push({ i: m.index, end: m.index + m[0].length });
    }
    if (!opens.length) continue;
    const closes = [];
    const closeRe = new RegExp(`</${tag}\\s*>`, 'gi');
    while ((m = closeRe.exec(s)) !== null) closes.push({ i: m.index, end: m.index + m[0].length });
    let ci = 0;
    for (const o of opens) {
      while (ci < closes.length && closes[ci].i < o.end) ci += 1;
      if (ci < closes.length) {
        out.push([o.i, closes[ci].end]);
        ci += 1;
      } else {
        out.push([o.i, s.length]);
      }
    }
  }
  return out;
}

/** 一行里连续出现的中文片段（≥7 字才可能是剧情，标签/字段值太短） */
const CJK_RUN_RE = /[\u4e00-\u9fa5][\u4e00-\u9fa5A-Za-z0-9，。！？、；：""''「」『』（）《》…—·\s]{6,}/g;

/** 这一行是不是施工数据 / 结构标签（剥掉标签后没有中文就一定是） */
function isScaffoldLine(line) {
  const t = String(line || '').trim();
  if (!t) return true;
  const stripped = t.replace(/<[^>]{1,200}>/g, '').replace(/\[igs-[^\]]*\]/g, '').trim();
  if (!stripped) return true;
  if (!/[\u4e00-\u9fa5]/.test(stripped)) return true;
  /* 选项行（`A. 走上前去` / `1、推开她`）—— 插进选项里看不出效果 */
  if (/^[A-Za-z][.、)）]\s*\S/.test(stripped)) return true;
  if (/^\d+[.、)）]\s*\S/.test(stripped)) return true;
  return false;
}

/** 按句读切（保留句读，切出来的每段都是原文连续子串） */
function splitBySentenceEnd(t) {
  const s = String(t || '');
  const out = [];
  let start = 0;
  for (let i = 0; i < s.length; i += 1) {
    if ('。！？!?…'.includes(s[i])) {
      let j = i;
      while (j + 1 < s.length && '。！？!?…”』」'.includes(s[j + 1])) j += 1;
      out.push(s.slice(start, j + 1));
      start = j + 1;
      i = j;
    }
  }
  if (start < s.length) out.push(s.slice(start));
  return out.filter((x) => x.trim());
}

/** 从一行里取「最后那句够长的」，取不到就整行（都不改写原文） */
function tailSentenceOf(line, min) {
  const t = String(line || '').trim();
  if (!t) return '';
  if (t.length <= 160) return t;
  const parts = splitBySentenceEnd(t);
  let cand = '';
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    cand = parts[i] + cand;
    if (cand.trim().length >= min) break;
  }
  return cand.trim();
}

/**
 * 从楼层正文里摘一句真原文（**保证是 `body` 的连续子串**）。
 *
 * 为什么倒序扫：GAL 拿锚点在正文里的下标定位段落，越靠后图越靠下，
 * 而 CG 通常描述本楼结尾那个画面。倒序也顺带避开了正文前面的 `<draft>` 施工块。
 *
 * @returns {string} 正文里真实存在的一句；正文里找不到合格句子时返回空串（不编）
 */
export function pickAnchorFromBody(bodyText, canInsert) {
  const body = String(bodyText || '');
  if (!body.trim()) return '';
  const ranges = scaffoldRanges(body);
  const inScaffold = (idx) => ranges.some((r) => idx >= r[0] && idx < r[1]);
  /**
   * ★★★ GAL 侧可插入性（v0.9.174）—— 见 `galBody.js` 顶部。
   *
   * 锚点「是正文子串」只保证 `findAnchorInsertIndex` 能找到位置（`anchorIndex`），
   * 能不能真正插进去还要过 `imageMarkerBoundary`。那一关会因**正文里任何一处
   * 未闭合的伪标签/方括号**而整楼判死（实测：模型在 `<draft>` 里写了
   * `(对标<writing_covenant>)`，它后面的所有位置都插不进）。
   *
   * 所以每挑一个候选就先自己算一遍：算不过就换下一个，**不把注定失败的锚点交出去**。
   */
  const canInsertAt = canInsert === null
    ? () => 0                       // 测试用：显式关掉校验
    : (canInsert || galInsertChecker(body));

  const lines = body.split('\n');
  const starts = [];
  let pos = 0;
  for (const l of lines) { starts.push(pos); pos += l.length + 1; }

  for (let i = lines.length - 1; i >= 0; i -= 1) {
    /* 整行落在施工块里 ⇒ 走 && 不许取（这是真实故障的那条路） */
    if (inScaffold(starts[i])) continue;
    const line = lines[i];
    if (isScaffoldLine(line)) continue;
    const runs = line.match(CJK_RUN_RE) || [];
    for (let k = runs.length - 1; k >= 0; k -= 1) {
      const run = runs[k];
      /**
       * ★ 中文占比门槛：施工行的特征是「中文关键词 + 一大段英文」，
       *   例如 `- analyze if 任务 completed: Task "催眠APP…" not yet completed…`。
       *   只判「有中文」会漏，必须看比例。
       */
      const cjkN = (run.match(/[\u4e00-\u9fa5]/g) || []).length;
      const dense = run.replace(/\s+/g, '').length;
      if (!dense || cjkN / dense < 0.6) continue;
      const cand = tailSentenceOf(run, ANCHOR_MIN_CHARS);
      /* ★ 自检一：不是正文子串就换下一个 —— 宁可没有锚点，也不许编一句贴不上/贴错位置的 */
      if (!cand || cand.length < ANCHOR_MIN_CHARS || !body.includes(cand)) continue;
      /**
       * ★ 自检二：GAL 交给 `imageMarkerBoundary` 的是锚点**末尾**位置
       *   （`anchorIndex = indexOf(anchor) + anchor.length`），不是起始位。
       */
      if (canInsertAt(body.indexOf(cand) + cand.length) < 0) continue;
      return cand;
    }
  }
  return '';
}

/**
 * 三层选锚点（v0.9.173）。
 *
 *   ① `floor` —— description 里恰好含正文原句（GAL 有时会摘），最贴画面，优先；
 *   ② `body`  —— 上面没中就从正文末尾摘一句（**必然命中**，这是兜底主力）；
 *   ③ `scene` —— 连正文都取不到（没有 chat / 楼号对不上）才退到画面段自身。
 *
 * @returns {{anchor:string, from:'floor'|'body'|'scene'|''}}
 */
export function resolveAnchor(floorBody, scene) {
  const floor = String(floorBody || '').trim() ? String(floorBody) : '';
  if (floor) {
    const check = galInsertChecker(floor);
    let rejected = 0;
    const counting = (at) => { const r = check(at); if (r < 0) rejected += 1; return r; };
    /**
     * ① 主力：从正文里原样截一句（**必定能贴**，位置在本楼剧情尾部）。
     *    为什么不再优先用 `scene` 去正文里匹配：线上这个接口的 `description`
     *    是给插件的指令串（不是正文片段），匹配基本靠运气；而 CG 描述的是本楼
     *    结尾那个画面，取正文末尾的剧情句位置也对。
     */
    const byBody = pickAnchorFromBody(floor, counting);
    if (byBody) return { anchor: byBody, from: 'body', rejected };
    /** ② 正文里没有合格中文剧情句（整楼都是施工数据）才退回按 scene 匹配 */
    const byScene = pickAnchorSentence(floor, scene);
    if (byScene && counting(floor.indexOf(byScene) + byScene.length) >= 0) {
      return { anchor: byScene, from: 'floor', rejected };
    }
    /**
     * ③ 全楼都插不进 —— 把结构体检一并带回，让调用方报出**具体的病灶**
     *   （GAL 自己只会说「没有安全的独占行插入位置」，看不出是哪个标签害的）。
     */
    return { anchor: '', from: '', rejected, audit: galBodyAudit(floor) };
  }
  const b = pickAnchorSentence(scene, scene, { preferTail: true });
  return b ? { anchor: b, from: 'scene', rejected: 0 } : { anchor: '', from: '', rejected: 0 };
}

/**
 * 「这一条像不像要被插图的 AI 剧情楼」的粗评分。
 *
 * ★ 存在意义：GAL 传的楼号是 0 基还是 1 基，静态代码里看不出来（`dt` 是上层参数）。
 *   与其赌一个基准，不如按**结构**挑：用户楼扣 100 分，AI 剧情楼靠
 *   `[igs-scene:]` / `<now_plot>` / 长度加分。两种基准下都会落到同一条上。
 */
function floorScore(m) {
  if (!m || typeof m !== 'object') return -1;
  const t = String(m.mes || '');
  if (!t.trim()) return -1;
  let s = 0;
  if (m.is_user === true) s -= 100;
  if (t.includes('[igs-scene:')) s += 50;
  if (t.includes('<now_plot>')) s += 50;
  if (t.length > 200) s += 20;
  if (t.length > 1000) s += 10;
  return s;
}

/** 取楼层正文。GAL 传的 `messageId` 按酒馆 chat 下标用；取不到再试前一位 / 按 id 查。 */
export function readFloorText(messageId) {
  try {
    const ctx = globalThis.SillyTavern?.getContext?.();
    const chat = ctx?.chat;
    if (!Array.isArray(chat)) return '';
    /**
     * ★★★ 四种形态都要认（v0.9.172）：
     *   ⓿ **对象** —— GAL 的插图规划里 `Re({messageId: dt, …})` 的 `dt` 是**整楼对象**
     *      （它自己用 `dt.messageId` 取楼层），而写词接口那层 `messageId: Number($t.messageId)`
     *      转一次 ⇒ **NaN**。这是线上真实故障：锚点恒为空 ⇒ GAL 判「没有能对上正文的生成点」
     *      ⇒ 整楼一张图都贴不上去（界面上只报这一句，看不出是 messageId 的锅）。
     *   ① 数组下标（0 基）—— 正常路径；
     *   ② 下标差一位（有调用方按 1 基传）—— 取不到再试前一位；
     *   ③ 消息 id 字符串 —— 兜底按 `id === raw` 找。
     *   拿不到正文就等于拿不到锚点，图会被 GAL 丢掉，所以这里宁可多试两条。
     */
    let raw = messageId;
    if (raw && typeof raw === 'object') {
      raw = raw.messageId ?? raw.mesId ?? raw.floorId ?? raw.id ?? raw.index;
    }
    const i = Number(raw);
    if (Number.isFinite(i)) {
      /**
       * ★★★ 不再「先信 `chat[i]`」—— 楼号基准不确定时那样会取到**下一楼**
       *   （通常是用户刚发的那句短消息），锚点算出来贴到别处。
       *   改成三邻居（i / i-1 / i+1）一起按 `floorScore` 排序，同分取最近的。
       */
      const cands = [];
      for (const k of [i, i - 1, i + 1]) {
        const m = chat[k];
        if (!m || typeof m !== 'object') continue;
        const mes = String(m.mes || '');
        if (!mes.trim()) continue;
        cands.push({ k, mes, score: floorScore(m) });
      }
      if (cands.length) {
        cands.sort((a, b) => (b.score - a.score) || (Math.abs(a.k - i) - Math.abs(b.k - i)));
        return cands[0].mes;
      }
    }
    const key = String(raw == null ? '' : raw);
    if (key && key !== 'NaN' && key !== 'undefined') {
      const hit = chat.find((m) => m && String(m.id) === key);
      if (hit) return String(hit.mes || '');
    }
    return '';
  } catch { return ''; }
}

/**
 * 从 GAL 传回来的 `caption` 里取出真正用于绘图的提示词。
 *
 * 兼容三种形状，按优先级：
 *   ① 纯字符串（GAL 某些路径会把 caption 摊平）
 *   ② NAI V4 结构 `{ v4_prompt: { caption: { base_caption } } }` ← 正常路径
 *   ③ 平坦的 `{ base_caption }`
 *
 * ★ 这里**不做任何清洗**：提示词是上一轮我们自己写出来、原样回传的，
 *   再清洗一遍等于第二次改动（「A 清洗→B 变换→输出」那条纪律的反面用法）。
 */
export function readV4Caption(caption) {
  if (typeof caption === 'string') return caption.trim();
  const base = caption?.v4_prompt?.caption?.base_caption;
  if (typeof base === 'string' && base.trim()) return base.trim();
  const flat = caption?.base_caption;
  if (typeof flat === 'string') return flat.trim();
  return '';
}

/**
 * 包成 GAL 认的 NAI V4 结构。
 *
 * `char_captions: []` 是**故意的**：V4 的 char_captions 是给「按角色分框」用的，
 * 而我们的提示词是一整串（MOSS 的自然语 / K2 的三明治），拆进 char_captions
 * 反而会被 NAI 侧的字段语义改写。GAL 只校验 `base_caption` 非空，这一项够用。
 */
export function makeV4Caption(base, negative = '') {
  return {
    v4_prompt: {
      caption: { base_caption: String(base == null ? '' : base), char_captions: [] },
      use_coords: false,
      use_order: true,
    },
    v4_negative_prompt: {
      caption: { base_caption: String(negative == null ? '' : negative), char_captions: [] },
    },
  };
}

/**
 * 剥掉模型爱加的包装：```json 围栏、`<think>` 块、前后寒暄。
 *
 * 与 `parseAnalyzeOutput` 里那套不同 —— 这里只面对「一整段提示词」，
 * 不解析 images/changes，所以不能复用（复用会把一段正常提示词当 JSON 解析而丢掉）。
 */
export function stripPromptWrapper(raw) {
  let s = String(raw == null ? '' : raw).trim();
  s = s.replace(/<think(?:ing)?[\s\S]*?<\/think(?:ing)?>/gi, '').trim();
  /**
   * ```json ... ``` / ``` ... ```
   *
   * ★ 不要求围栏占满整串：模型经常「前一句附言 + 围栏 + 后一句解释」，
   *   旧写法 `^```…```$` 只认整串就是一个围栏，这种就漏了，
   *   接着又被下面的 JSON 截取兜住 —— 兜得住是运气，兜不住就报「不是合法 JSON」。
   */
  const fence = /```[a-zA-Z]*[ \t]*\r?\n([\s\S]*?)```/.exec(s);
  if (fence && fence[1].trim()) s = fence[1].trim();
  // 模型偶尔先来一句「好的，这是提示词：」
  s = s.replace(/^(好的|当然|以下是|这是|明白了)[^\n]{0,40}[:：]\s*\n+/, '').trim();
  return s;
}

/**
 * 拼 GAL 写词的 system。
 *
 * ★★★ v0.9.180：**写法规范必须与单独绘灵同源**。
 *
 *   原来这里只有 `tpl.system + tpl.spec`，`buildAnalyzeMessages` 那边还多出
 *   「成人姿态块 / 输出协议后半 / 单图形态指令 / 破限」四段 —— 实测两条路径的 system
 *   分别是 11936 字与 32274 字。用户 2026-10-31 报「GAL 的图肢体扭曲、画面和剧情对不上，
 *   比单独绘灵差很多」，单变量对比就是这 2 万字。
 *
 *   缺的每一块都直接对应一个症状：
 *     · 姿态块（承重面 / 两手 / 下肢落点）→ 手多一只、腿被拉长、悬空穿模；
 *     · 协议后半（`summary` 三句 / `items` 两类）→ 画风句退化成 `Anime style illustration`；
 *     · 形态指令（不分格 / 一人一项 / 不写景别机位 / 动作只两项）→ 模型按多格漫画的
 *       写法堆点，点越多人物被拉得越长。
 *
 *   `buildGalWritingSpec()` 只补**写法**，不补**资料**（档案库 / 剧场上下文）：
 *   资料会和 GAL 的【角色设定】重复描述，两处描述＝模型挑一条听。
 */
/**
 * ══ 写词硬约束（插件侧固定，不进用户模版）══
 *
 * ★★★ v0.9.182：两条都是**实测出图翻车**换来的，不是猜的。
 *
 * **① 眼睛的比喻词会把动物实体化。**
 *   第 23 楼正文写「宝蓝色的猫眼」（中文里就是「猫一样的眼睛」＝上挑锐利），
 *   写词模型直译成 `sharply upturned blue cat-shaped eyes`，同一条 caption 里
 *   还写了第二次 `blue cat-eyes` —— 实测出图**女主长了猫耳朵**（猫耳、尖耳从头发里伸出）。
 *   同批另外两张只有一次 `cat-eyes` 或干脆没有，就都是人耳。
 *   ⇒ 同义重复一次 = 权重翻倍 = 实体被画出来，这与「重复＝实体复制」是同一条规律。
 *   **不能只删 `cat` 这个词**：模型下次还会从正文抄「狐狸眼 / 狼眼 / 杏眼」。
 *   唯一的根治是**禁掉整个动物名类别**，眼睛只准写颜色与形状。
 *
 * **② 服装款式必须逐字照抄。**
 *   同一楼三张图，档案里那一套是同一串英文，但写词模型每张都重写一遍：
 *   第 1 张 `a navy blazer uniform jacket`、第 2 张省略了 `uniform` 并把
 *   `pulled up to mid-thigh` 改成 `pulled to`、第 3 张又换回来。
 *   出图结果：**第 1、2 张画成无袖马甲，第 3 张画成西装外套** —— 同一套校服变成三件不同的衣服。
 *   ⇒ 服装串是全篇唯一「必须逐字」的部分；允许改写的只有「状态」（穿着/敞开/褪到哪），
 *     因为那是要变成看得见的画面，而款式不是。
 *
 * @returns {string} 拼在任务说明**之前**的硬约束段；空串表示不加
 */
/**
 * 硬约束的两条标题。
 * ★ 导出成常量：测试必须**引用这里**去断言，不许在测试里抄一遍句子 ——
 *   抄句子的话，哪天改了文案，`!includes(旧句)` 会恒真，测试永远绿（踩过一次）。
 */
export const GAL_HARD_KEYS = {
  animal: '**1. 眼睛只写颜色和形状，不写动物名。**',
  outfit: '**2. 服装款式照抄原句，不改写。**',
};

/**
 * 这一段的小标题。
 * ★ 导出成常量而不是让测试抄字符串 —— 改文案时断言能跟着走，不会变成「改了文案还永远绿」。
 */
export const GAL_HARD_TITLE = '## 两条写法要求';

/**
 * 两条写法要求（v0.9.182 起注入，v0.9.183 改语气）。
 *
 * ★★★ v0.9.183：**去掉「优先级高于一切 / 违反即整张作废」这类措辞**。
 *
 * 证据（2026-10-31 22:36，真实拒答原文）：
 *   `I cannot fulfill this request. The prompt includes **override directives intended to
 *    bypass safety controls** and requests the generation of sexually explicit …`
 *
 * 出词模型把这一段的语气本身识别成了「试图覆盖安全策略的指令」，于是**还没看内容就先拒**。
 * 三组单变量对照（同一份 description、同一个模版，只改这一段）：
 *   A 原措辞          → 拒答，原话点名 `override directives intended to bypass safety controls`
 *   B 整段删掉        → 不拒答（但这次只回了 10 字，属于模型抽风）
 *   C 只换语气、条款不动 → 出 JSON
 * 修复服装那处之后重跑：A 也出 JSON ⇒ 语气不是唯一诱因，但确实是**风险源**。
 *
 * 所以做法是：**规则内容一条不删**（禁动物名、服装照抄），只把「越狱式」语气换成普通要求。
 * 判据没变，变的只是说法 —— 模型只需要知道「写什么」，不需要被告知「这条比别的都大」。
 */
function galHardRules() {
  return [
    GAL_HARD_TITLE,
    '',
    GAL_HARD_KEYS.animal,
    '   可以写：`blue eyes` / `upturned eyes` / `almond-shaped eyes` / `sharp narrowed eyes`。',
    '   眼睛相关的词里不出现动物名：cat / kitten / fox / wolf / rabbit / doe / deer / snake / eagle …',
    '   剧情正文里的「猫眼」「狐狸眼」「狼眼」是**中文比喻**（意思是上挑、锐利），',
    '   译成 `cat-eyes` / `fox eyes` 会被画成兽耳和尾巴。正文原句不要带进提示词，',
    '   眼睛按角色设定里给的颜色与形状写。',
    '',
    GAL_HARD_KEYS.outfit,
    '   角色设定里 `服装=` / `当前衣装` 后面那串款式描述，照原样写进 caption：',
    '   冠词、连词、逗号、词序保留；不换同义词、不省略、不合并、不自己补细节。',
    '   需要改写的只有**状态**：`服装状态=` 与 `裸露=` 转成看得见的画面',
    '   （敞开前襟 / 褪到腰 / 露出胸口 / 滑落到手臂），款式那串本身不动。',
    '   同一批多张图之间，服装段保持一致；只有动作、取景和光线可以不同。',
    '',
  ].join('\n');
}

/**
 * 出词模型的**安全拒答**特征。
 *
 * ★ 必须与「空回复」分开判：
 *   空回复是 `HL_GAL_LLM_EMPTY`（连接/额度/超时），重试没有意义；
 *   拒答是**有内容但拒绝执行**，换一个采样点就可能过 —— 值得重试一次。
 *
 * ★ 判据写三条而不是一条，因为误判的代价是「白白多调一次 API」：
 *   ① 命中拒答句式；② 长度 < 2000（正常写词 1000~3000 字，拒答 100~700 字）；
 *   ③ **里面没有 `{`**（模版要 JSON，出得来 JSON 就一定不是拒答）。
 */
export const GAL_REFUSAL_RE = /I (?:cannot|can't|can not|am unable|'m unable)|I must decline|unable to (?:help|assist|comply|fulfill|generate)|抱歉[，,]?\s*我无法|无法协助|不能提供/i;

export function looksLikeRefusal(text) {
  const t = String(text == null ? '' : text).trim();
  if (!t) return false;
  if (t.length > 2000) return false;
  if (/[{[]/.test(t)) return false;
  return GAL_REFUSAL_RE.test(t);
}

function galSystemOf(tpl, task, cfg) {
  const extras = buildGalWritingSpec(cfg);
  /**
   * ★ 只在 MOSS 口径注入（与 `buildGalWritingSpec` 同一条判据）。
   *   这两条是给 MOSS 的 JSON 写法打的补丁：`items[].caption` 由模型一次性写全，
   *   所以外貌与服装的措辞由模型决定。K2 / SD 那条链路里外貌和服装是**插件拼的**
   *   （锚点段 + 服装行），模型根本没机会写 `cat-eyes` —— 注进去只是白占 token，
   *   还会和它们自己的口径打架。
   */
  const hard = activeEngine() === 'moss' ? galHardRules() : '';
  /**
   * ★★★ v0.9.183 更正：**「④ 破限 / 附加」（`tpl.jailbreak`）本来就在拼。**
   *
   * 我一开始在这里没看到它，就断言「GAL 模式丢了破限段」，并照着这个判断加了一段注入 ——
   * 结果单变量验证（把这里的注入删掉、模版带上标记串）**system 里照样有那个标记**：
   * 来源是 `extras`，也就是 `buildGalWritingSpec()`（`prompts.js:559-560`）：
   *
   *     const jb = String(tpl.jailbreak || '').trim();
   *     if (jb) parts.push('', '---', '', jb);
   *
   * 已经撤掉了。教训还是那条：**「这个函数里没有」不等于「这条链路没有」**，
   * 上游包装函数可能已经做过。改这块之前先去 `buildGalWritingSpec` 看一眼。
   *
   * 现在的顺序：extras（含破限） → 硬约束 → 任务说明。
   */
  return [
    String(tpl.system || '').trim(),
    '',
    '---',
    '',
    String(tpl.spec || '').trim(),
    extras,
    /* 空串时连分隔符一起省掉 —— 否则非 MOSS 口径会出现连续两个 `---` */
    ...(hard ? ['', '---', '', hard] : []),
    '',
    '---',
    '',
    task,
  ].join('\n').trim();
}

/**
 * 组「写词」用的 messages。
 *
 * 结构 = 当前模版的 `system` + `spec`（用户自己配的那套规范，含官方硬约束）
 *       + `buildGalWritingSpec()`（与单独绘灵同源的写法规范）
 *       + 本次任务说明（GAL 单张 CG）。
 *
 * ★ 为什么不复用 `buildAnalyzeMessages`：
 *   那个函数的入参是「楼层正文」，内部会按**段数**算页数/格数（`mossCoverPlan`），
 *   还会拼进历史楼层、档案库、待建档名单。GAL 的 description 只有一两段，
 *   喂进去会算出「1 页 1 格」这种没有意义的分页，反而把模型带偏。
 *   这里要的是「一段描述 → 一张图的提示词」，是另一件事。
 */
export function buildGalMessages({ description, story, cfg }) {
  const c = cfg || getConfig();
  const tpl = getActiveTemplate() || {};
  const mode = activeOutput();

  const task = mode === 'json'
    ? [
      '【本次任务：单张 CG】',
      '下面是外部 Galgame 前端传来的一次出图请求，画面内容与出场角色的设定都在里面。',
      '- **只画一张图**：输出上面规范要求的单图 JSON（`summary` + `items`），`items` 里不要写任何坐标字段。',
      '- **本通道没有 `changes` / `images` / `position`**：外层只输出 `{"summary":…,"items":[…]}` 这一个对象。',
      '- 所有外貌与服装**一律写进 `character` 项的 caption**（不要另建变更记录、不要只写进 summary）。',
      '- **不要分格**：不要出现 Panel 1 / Panel 2 之类的一页多格写法。',
      '- **只输出 JSON 本身**：不要 markdown 代码块、不要解释、不要前后附言。',
      '- 设定以这份请求为准；若与档案库里的同名角色有出入，以请求为准。',
    ].join('\n')
    : [
      '【本次任务：单张 CG】',
      '下面是外部 Galgame 前端传来的一次出图请求，画面内容与出场角色的设定都在里面。',
      '- **只画一张图**：不要分格，不要出现 Panel 1 / Panel 2 之类的一页多格写法。',
      '- **只输出提示词正文**：不要 JSON、不要 markdown 代码块、不要解释、不要前后附言。',
      '- 设定以这份请求为准；若与档案库里的同名角色有出入，以请求为准。',
    ].join('\n');

  const system = galSystemOf(tpl, task, c);

  /**
   * ★★★ v0.9.187：GAL 单张也要拿到**剧情**与**上一张画了什么**。
   *
   * 在此之前 `buildGalMessages` 的 user 只有 GAL 传来的 `description`（画面描述 + 角色设定）
   * —— 一句剧情都没有。用户报「单独成一块不相关，没有剧情延续」正是这个：
   * 模型只能按「女高中生 + 校服 + 器材室」这类设定自己编一个瞬间。
   *
   * 而 `story`（本楼正文净化版）早就算出来了（`generateSinglePrompt` 里 `galStoryText`），
   * 却**只喂给了多张路径**（`buildGalShotsMessages`），单张这里一直是丢的。
   *
   * 同时补上「近期已出的画面」：同一段戏连出几张时，体位/接触/脱到哪必须延续，
   * 只换机位角度。没有这条，每张都从零推 ⇒ 从最初的体位到后面完全变了。
   */
  const userParts = [String(description == null ? '' : description)];

  /**
   * ★★★ v0.9.187：先摆「数据库真值」，再摆正文与上一张。
   *
   * 顺序是有意的：地点/时间/在场角色是**硬事实**，正文是「此刻发生什么」，
   * 上一张是「刚画到哪」。事实在前，模型后面写场景时才会先照抄再发挥。
   */
  try {
    const dbLines = sceneDbPromptLines(c);
    if (dbLines.length) userParts.push('', ...dbLines);
  } catch { /* 数据库不在/结构变了 → 一个字都不加，绝不能因为读失败拖垮写词 */ }

  const storyText = String(story || '').trim();
  if (storyText) {
    userParts.push(
      '',
      '【本楼正文】（画面必须是这一段里真实发生的一刻；**不要**自己编与剧情无关的场景）',
      storyText,
    );
  }

  let prev = [];
  try { prev = recentGalShots(2); } catch { prev = []; }
  if (prev.length) {
    userParts.push(
      '',
      '【这张之前刚画过的画面】（同一段戏的连续性依据）',
      ...prev.map((s, i) => [
        `— 上一${prev.length - i > 1 ? ` ${prev.length - i} ` : ''}张 —`,
        s.caption ? `画面：${s.caption}` : '',
        s.scene ? `场景：${s.scene}` : '',
      ].filter(Boolean).join('\n')),
      '',
      '⚠️ 怎么用这段（这是「延续」而不是「照抄」）：',
      '  ① **体位 / 接触 / 插入状态没换 → 照写一遍**，只换机位与角度。',
      '     不写 ≠ 延续，等于这张图里没有这件事 —— 这是「前一张有、后一张突然没了」的头号原因。',
      '  ② **已经脱掉的衣物、已经留下的痕迹、已经出现的道具与环境陈设**，本楼若仍在同一场戏，保持一致。',
      '  ③ **场景照抄**：地点换了才换。没换就写同一个地点，不许换成教室/卧室这类别的房间。',
      '  ④ 只有「机位 / 景别 / 同一个瞬间的措辞」要换，重复这些才会被扩散模型多画一个实例。',
    );
  }

  return [
    { role: 'system', content: system },
    { role: 'user', content: userParts.join('\n') },
  ];
}

/**
 * 当前画布尺寸 —— 与 `composePrompt` 里 Layout 那段**同一套算法**。
 *
 * ★ 必须读 `resSelector`（不是 `be.width/height`）：`resSelector` 开着时
 *   那两个字段是死参数，实测坑过（见 `consistency.js` 里 `canvasOf` 的注释）。
 *   这里与生产同口径，GAL 拿到的 `captions[].width/height` 才是真画布。
 */
export function currentCanvas(cfg) {
  const c = cfg || getConfig();
  const be = c.backends?.comfyui || {};
  if (be.resSelector?.enabled !== false) {
    const r = estimateResolution(be.resSelector?.aspect, be.resSelector?.megapixels, be.resSelector?.multiple);
    return { width: r.width, height: r.height };
  }
  return { width: Number(be.width) || 0, height: Number(be.height) || 0 };
}

/**
 * 把模型回的正文编译成「最终要送进后端的那串提示词」。
 *
 * 两条出口对应两种模版口径：
 *   · `json`：单图 JSON → `singleJsonPrompt` 规范化（官方字段白名单 / 台词拆泡）
 *            → `layoutToLine` 压成一行；
 *   · `text`：原样（只剥包装）。
 *
 * ★ 返回 `{ ok:false, error }` 时**必须让调用方看到原因**，不许返回空串当成功 ——
 *   「空串 = 出图后端会报『提示词为空』」这种二次报错最费排查时间。
 */
/**
 * 从混杂文本里取**第一个完整**的 JSON 对象/数组。
 *
 * ★ 为什么不能用「第一个 `{` 到最后一个 `}`」：
 *   模型完全可能吐两段 —— 例如先给单图 JSON，再按 GAL 指令补一段「负向词」，
 *   于是 `{...}\n\n{...}` 中间被一刀切进来，两边都成非法串。
 *   这里按**括号配对 + 字符串转义**扫，取第一个自洽的对象；扫到结尾还没闭合
 *   ⇒ 判为**截断**（输出被 max_tokens 砍掉），这是另一类故障，不能混为一谈。
 */
export function pickFirstJsonBlock(text) {
  const s = String(text == null ? '' : text);
  let start = -1;
  let opener = '';
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] === '{' || s[i] === '[') { start = i; opener = s[i]; break; }
  }
  if (start < 0) return { found: false, truncated: false, json: '' };

  const closer = opener === '{' ? '}' : ']';
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < s.length; i += 1) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === opener) depth += 1;
    else if (ch === closer) {
      depth -= 1;
      if (depth === 0) return { found: true, truncated: false, json: s.slice(start, i + 1) };
    }
  }
  return { found: true, truncated: true, json: s.slice(start) };
}

/**
 * 「只有 summary、没有 items」时的降级文本 —— 空镜专用。
 *
 * ★ 为什么需要这条：单图 JSON 的 `items` 是**叠加层**（人 / 字），
 *   `summary.caption` 才是「整幅画面 + 画风」那一句。当这一张本来就没有人也没有字
 *   （纯背景 CG、空镜、GAL 测试按钮发的 `simple visual novel background, no text`），
 *   模型只写 summary 是**正确输出**，不是故障。
 *   而 `singleJsonPrompt` 的收口是「items 空 ⇒ 返回 null」（那条判据是给
 *   「写了人物却全被判非法」这种真故障用的），两者语义不同，不能混为一谈。
 *
 * ★ 降级成**纯自然语**有官方依据，不是自创形态：
 *   USERGUIDE 开头两段示例就是纯 `prompt:` 自然语（无 JSON），
 *   MOSS 本来就同时吃「自然语」与「自然语 + 结构化」两种输入。
 *   空镜没有 items，本来也不需要 layout。
 *
 * ★ 画风前缀 / 后缀照旧并进这一句 —— 与 `mergeLayoutGlobalWords` 同一口径
 *   （`mossJson.gword === 'off'` 时不并），否则空镜会变成唯一不吃画风词的一类图。
 */
export function galSummaryOnlyPrompt(draft, cfg) {
  const c = cfg || getConfig();
  const s = (draft && typeof draft === 'object') ? draft : {};
  const sum = (s.summary && typeof s.summary === 'object') ? s.summary : {};
  let cap = String(sum.caption || '').trim();
  if (!cap && typeof s.caption === 'string') cap = s.caption.trim();
  if (!cap) return '';
  const gwordMode = c.mossJson?.gword === 'off' ? 'off' : 'caption';
  const pre = gwordMode === 'off' ? '' : String(c.globalPrefix || '').trim();
  const suf = gwordMode === 'off' ? '' : String(c.globalSuffix || '').trim();
  const trimEdge = (x) => String(x || '').trim()
    .replace(/^[\s,，、;；:：]+/, '')
    .replace(/[\s,，、;；:：]+$/, '');
  const parts = [trimEdge(pre), cap, trimEdge(suf)].filter(Boolean);
  return parts.join('. ')
    .replace(/\.{2,}/g, '.')
    .replace(/([。！？!?])\s*\.\s*/g, '$1 ')
    .trim();
}

export function compileGalPrompt(raw, cfg) {
  const c = cfg || getConfig();
  const text = stripPromptWrapper(raw);
  if (!text) return { ok: false, code: 'HL_GAL_LLM_EMPTY', error: '出词模型没有返回内容' };

  if (activeOutput() !== 'json') return { ok: true, prompt: text };

  let draft = null;
  let truncated = false;
  try {
    draft = JSON.parse(text);
  } catch {
    const pick = pickFirstJsonBlock(text);
    if (!pick.found) {
      return {
        ok: false,
        code: 'HL_GAL_JSON_NO_OBJECT',
        error: '模版要 JSON，但模型回复里连一个 { 都没有（原文前 300 字：' + text.slice(0, 300) + '）',
      };
    }
    truncated = pick.truncated;
    try { draft = JSON.parse(pick.json); } catch {
      draft = null;
      if (truncated) {
        /**
         * 截断 = 输出没走完。最常见原因是 `max_tokens` 不够，
         * 或者 GAL 的 description 太长把模型带进了长篇大论。
         * 与「模型胡写」要分开报 —— 处理方式完全不同（调 token / 收紧指令）。
         */
        return {
          ok: false,
          code: 'HL_GAL_JSON_TRUNCATED',
          error: `模型输出被截断（JSON 未闭合，已收 ${text.length} 字）。`
            + '到绘灵「出词 API」页把 max_tokens 调大，或确认模型没有跑偏。'
            + '尾 200 字：' + text.slice(-200),
        };
      }
    }
  }
  if (!draft || typeof draft !== 'object') {
    return {
      ok: false,
      code: 'HL_GAL_JSON_INVALID',
      error: '模版要 JSON，但模型回的不是合法 JSON（原文前 300 字：' + text.slice(0, 300) + '）',
    };
  }
  const out = singleJsonPrompt(draft, c);
  if (!out) {
    /**
     * ★★★ 两种「没有 item」必须分开处理（v0.9.167）。
     *
     *   ① 模型**压根没写 items**（或写了空数组）⇒ 这一张本来就是空镜/纯背景，
     *      `summary.caption` 就是完整的整幅描述 ⇒ **降级成纯自然语出图**。
     *      真实病例：GAL「测试生成」发 `simple visual novel background, soft light, no text`，
     *      模型正确回了 `{"summary":{"caption":"Soft anime visual-novel background art, ..."}}`，
     *      我们却报 `HL_GAL_ITEMS_EMPTY` —— 模型没错，是收口太硬。
     *
     *   ② 模型**写了 items 但全被判非法**（缺 caption / 台词被丢弃 / 只有 object）
     *      ⇒ 这是真故障，必须报错。这里**绝不能**拿 summary 兜底：
     *      summary 可能写着「两人对视」而人物项全丢了，兜底会把「少人」画成「没人」，
     *      而且一句报错都不留。
     */
    const declared = Array.isArray(draft.items) ? draft.items.length : 0;
    if (declared === 0) {
      const fallback = galSummaryOnlyPrompt(draft, c);
      if (fallback) {
        warn(STAGE.GAL,
          `GAL 写词：模型只给了 summary（空镜/纯背景），已降级为纯自然语提示词 ${fallback.length} 字 —— 不算失败`);
        return { ok: true, prompt: fallback, stats: { items: 0, summaryOnly: true } };
      }
    }
    return {
      ok: false,
      code: 'HL_GAL_ITEMS_EMPTY',
      error: (declared === 0
        ? '模型只回了空壳（没有 items，summary.caption 也是空的）'
        : `模型写了 ${declared} 个 item，但全部被判非法（缺 caption / 只有背景层 / 台词被丢弃）`)
        + '。原文前 300 字：' + text.slice(0, 300),
    };
  }
  const line = layoutToLine(out);
  if (!String(line || '').trim()) {
    return { ok: false, code: 'HL_GAL_LINE_EMPTY', error: '单图 JSON 编译后为空串' };
  }
  return { ok: true, prompt: line, stats: { items: out.items.length } };
}

/* ═══════════ 运行时（注册 / 两次握手）═══════════ */

/** abort 的标准回执 —— 契约见文件头 ③ */
const STALE = Object.freeze({ ok: false, reason: 'request-stale', stopGeneration: true });

/**
 * 最近一次调用的结果 —— 面板上直接显示，用户不用开控制台。
 *
 * ★ 为什么必须做：v0.9.164 第一次联调，GAL 只弹出一句
 *   「未返回可用提示词（DBGen 写词）」，**我们的原因一个字都没显示** ——
 *   因为 GAL 收到 `{ok:false}` 时不用我们的 `error`，它自己拼文案（`me()`），
 *   只把 diagnostic 里几种**白名单字段**拼进去。没有 code 就等于没有信息。
 */
let lastCall = null;

/**
 * GAL 最近一次传进来的 `description` 原文（截前 1500 字，只用于排查）。
 *
 * ★ 为什么要留：写词失败时，「模型为什么写歪」和「它被喂了什么」是两件事。
 *   只留模型输出，等于只有一半证据 —— 而 GAL 的 description 是它自己拼的，
 *   里面的【角色设定】指令（尤其「排除项写入负向词」）可能直接把模型带偏。
 */
let lastInput = '';

/**
 * 最近一次 description 里的**【角色设定】段**（从 `【角色设定】` 到结尾）。
 *
 * ★ 为什么单独存一份（v0.9.181）：外壳（画面描述 + 衣装时间线 JSON + 尺寸句）
 *   长度不固定 —— 时间线每楼十几个生成点，光 JSON 就能写到 3000+ 字，而它
 *   **排在角色设定前面**。整串截断时被切掉的永远是后段，也就是外貌/衣装那一段。
 *   单存这一段，「GAL 到底给没给外貌」「衣装名写的是什么」一眼可见。
 *
 * ★ 空字符串有明确含义：**GAL 这次没给角色设定**（它侧角色 DNA 为空时就是这形态，
 *   见对面 `externalPromptDescription`：`characterContext` 渲染不出任何角色块时
 *   整段 `【角色设定】` 都不拼）。⇒ 不是「绘灵没读到」，是「源头就没有」。
 */
let lastCastText = '';

/**
 * 本次 GAL 请求的楼层号 —— `generate()` 的签名里**没有** `messageId`（GAL 不传），
 * 所以由 `generateSinglePrompt()` 记下来，出图成功后写「画面记忆」时用它标楼。
 */
let lastGalMesId = null;
export function rememberGalFloor(mesId) {
  lastGalMesId = Number.isFinite(Number(mesId)) ? Number(mesId) : null;
}
export function resetGalFloorMemory() {
  lastGalMesId = null;
}

/**
 * 从最终送进后端的提示词里抽出「这张画了什么」。
 *
 * 只取 `summary.caption` 与场景半句 —— 整份 prompt 里全是外貌与服装，
 * 喂回给模型等于给了一份可照抄的模板（重复＝实体复制）。抽取失败就取头部。
 */
export function galShotBrief(prompt) {
  const raw = String(prompt || '').trim();
  if (!raw) return { caption: '', scene: '' };
  if (raw.startsWith('{')) {
    try {
      const j = JSON.parse(raw);
      const cap = String(j?.summary?.caption || '').trim();
      if (cap) return { caption: cap, scene: '' };
    } catch { /* 不是合法 JSON，退回纯文本处理 */ }
  }
  /**
   * 纯文本口径：**取头部一段，不按句号切**。
   * 头一句往往是画风（`Clean anime line art.`），只留它等于「这张画了什么」一个字都没有
   * —— 延续判据就失效了（实测：断言拿到 `Clean anime line art.`）。
   */
  return { caption: raw.slice(0, 320), scene: '' };
}

/** `lastInput` 的落盘上限：整串（画面描述 + 衣装时间线 JSON + 角色设定），实测 4~6k */
export const GAL_INPUT_MAX = 30000;

/** 【角色设定】段的落盘上限：只含外貌/排除项/性格/当前衣装，实测 0.5~2k */
export const GAL_CAST_TEXT_MAX = 12000;

/**
 * 记下「这次喂给模型的原文」并落盘（v0.9.181）。
 *
 * ★★★ 为什么抽成导出函数而不是留在 `record()` 里：`record()` 只在调用收尾时跑，
 *   测试没法走到它；于是「空串要不要顶掉旧内容」这条只能用**手动赋值**去测 ——
 *   而手动赋值绕开了真正的写入代码，改成条件式写入时测试照样全绿（实测过，假绿）。
 *   现在写入只有这一个入口，测试直接调它，改坏了必红。
 *
 * ★ 空串是结论，不是「没数据」：GAL 侧角色 DNA 为空时它压根不拼 `【角色设定】`，
 *   这时必须把旧值清掉 —— 否则面板显示着一段完整外貌，而这次请求里一个字都没有。
 *
 * @param {string} description GAL 传来的原文
 * @param {{scene?:string, cast?:string}} [parts] 已解析过的分段（省一次正则）
 * @returns {string} 落盘的设定段（`''` = 这次没给）
 */
export function rememberGalInput(description, parts) {
  const text = String(description == null ? '' : description);
  const p = parts && typeof parts === 'object' ? parts : splitGalDescription(text);
  lastInput = text;
  lastCastText = String(p.cast == null ? '' : p.cast);
  try {
    const cfg = getConfig();
    if (!cfg.galBridge || typeof cfg.galBridge !== 'object') cfg.galBridge = {};
    cfg.galBridge.lastInput = text.slice(0, GAL_INPUT_MAX);
    cfg.galBridge.lastCastText = lastCastText.slice(0, GAL_CAST_TEXT_MAX);
    saveSettings();
  } catch { /* 诊断装不下绝不能影响写词 */ }
  return lastCastText;
}

/**
 * GAL 最近一次在 description 里写的**构图尺寸**（「画面是横的，宽1216，高832」）。
 *
 * ★ 为什么要跨函数传：`generateSinglePrompt` 拿得到 description，`generate`
 *   拿不到；而 `generate` 的 `params.width/height` 只有图位设过尺寸才有。
 *   没设时整包 params 里就没有宽高，只能靠这条接上。
 * ★ 带时间戳：GAL 正常是「写词 → 立刻出图」，超过 5 分钟就不该再认这条
 *   （否则用户手动点「绘制 CG」时会套上一层楼的尺寸）。
 */
let lastDescCanvas = null;

/**
 * 最近一次「外貌来源」的实际结果（`{source, replaced, at}`）。
 *
 * ★ 必须摊到面板上：开关显示「绘灵档案」但实际一个都没换上，是最容易误判的形态
 *   —— 用户会以为「档案改了没生效」，其实是这次 GAL 没给【角色设定】段、
 *   或者档案里没有这个人。数字为 0 时面板要能说清是哪一种。
 */
let lastLookStats = { source: '', replaced: 0, at: 0 };

/** 最近一次「服装来源」的实际结果 —— 同 `lastLookStats`，数字 0 要能说清是哪一种 0 */
let lastOutfitStats = { source: '', replaced: 0, at: 0 };

/**
 * GAL 最近一次要的**张数**（`为本楼生成3张CG` 里的 3）。
 *
 * ★ 为什么要跨函数传：`generateSinglePrompt` 拿得到 description，`generate` 拿不到。
 *   而 ComfyUI 是**串行队列** —— 一楼 3 张时第 3 张要等前两张跑完，
 *   用单张的 180 秒去等必然超时。这里把张数记下来，`generate` 拿它放大等待预算。
 * ★ 带时间戳：超过 10 分钟就不该再认（GAL 中途重开对话/用户手动重绘时会串味）。
 */
let lastWant = null;

/** 张数记忆的有效期（毫秒） */
const WANT_TTL_MS = 10 * 60 * 1000;

/**
 * 记一次调用结果，并**持久化**到配置（`galBridge.lastCall`）。
 *
 * ★ 为什么要落盘：GAL 的报错只回显一个 code，原文全被它的枚举白名单卡掉。
 *   只存内存的话，用户必须「点测试 → 切到绘灵面板 → 点刷新状态 → 截图」四步；
 *   落进 settings.json 之后，点一次就够了 —— 刷新页面也不丢，外部直接读文件即可定位。
 *   只保留最新一条、message 截到 900 字，不会把配置撑大。
 */
function record(kind, ok, code, message) {
  const at = Date.now();
  const text = String(message == null ? '' : message);
  lastCall = { at, kind, ok, code, message: text };
  try {
    const cfg = getConfig();
    if (!cfg.galBridge || typeof cfg.galBridge !== 'object') cfg.galBridge = {};
    cfg.galBridge.lastCall = { at, kind, ok, code, message: text.slice(0, 900) };
    /**
     * ★ 输入原文（`lastInput` / `lastCastText`）**不在这里写** ——
     *   它是写词入口 `rememberGalInput()` 的职责（v0.9.181）。
     *   两处都写同一个字段时，测试只能覆盖其中一条路径，
     *   另一条改坏了照样全绿 —— 这正是上一版「空串顶不掉旧内容」没被发现的原因。
     */
    saveSettings();
  } catch { /* 静默：诊断信息存不下也不能影响出图 */ }
  notifyGalUpdate('call');
  return lastCall;
}

/**
 * 本楼写词结果的留档（v0.9.177）。
 *
 * ★ 为什么要存：用户能看到的只有图上那一层色、图里那几个人。
 *   「这句话为什么被画成这样」「我填的服装到底有没有进去」——
 *   必须能看到**真正送进模型的那些字**，否则只能靠猜。
 *   GAL 自己把 caption 存在 `user/files/igs-cg-records.json`，但那个界面里没有入口；
 *   绘灵这边本来就是这个字符串的产地，存一份最直接。
 * ★ 为什么留 6 批：一楼最多 5 张（`parseGalWant` 上限），一天里翻回去看上一楼也很常见。
 *   再多就是拿配置空间换没人看的历史。
 */
const PROMPT_LOG_MAX = 6;

/** 单条 caption 的上限。正常 1~3KB，给 6KB 是防模型发疯，不是期望值 */
const PROMPT_TEXT_MAX = 6000;

/**
 * 记一批写词结果（一次 `generateSinglePrompt` 产出的一张或几张）。
 *
 * 纯留档：任何异常都吞掉 —— 存不下诊断信息也不能让写词失败。
 * @returns {{at:number,messageId:number|null,note:string,width:number,height:number,
 *            items:Array<{slotId:number,anchor:string,caption:string}>}|null}
 */
/**
 * 这一批「GAL 要的画布」——只用于**留档与显示**，不影响出图。
 *
 * ★ 抽成导出函数的理由不是好看：`generate` 那条路拿不到 `description`，
 *   而 `generateSinglePrompt` 手上就有 —— 两边必须读同一个来源，否则面板显示的
 *   和实际送图的会是两个数（2026-10-31 就是这么错了一次）。
 */
export function galCanvasForLog(description) {
  if (lastDescCanvas && (Date.now() - lastDescCanvas.at < 5 * 60 * 1000)) {
    return { width: lastDescCanvas.width, height: lastDescCanvas.height };
  }
  return parseGalCanvasFromDesc(description) || null;
}

export function rememberPromptBatch({ messageId, note, width, height, galCanvas, shots, at = Date.now() } = {}) {
  const items = (Array.isArray(shots) ? shots : [])
    .map((s, i) => ({
      slotId: Number(s?.slotId) > 0 ? Number(s.slotId) : i + 1,
      anchor: String(s?.anchor || '').trim().slice(0, 240),
      caption: String(s?.prompt || s?.caption || '').slice(0, PROMPT_TEXT_MAX),
    }))
    /* ★ 判空必须 trim：模型偶尔回一串空格，不 trim 就会写进一条「什么都没画」的批次 */
    .filter((it) => it.caption.trim() || it.anchor);
  if (!items.length) return null;

  const mid = Number(messageId);
  const batch = {
    at,
    messageId: Number.isFinite(mid) ? mid : null,
    note: String(note || '').slice(0, 120),
    width: Number(width) || 0,
    height: Number(height) || 0,
    /**
     * ★ GAL 自己算的画布（它按取景给的宽高）。
     *   与 `width/height`（绘灵口径）**经常不是一个数**：实测同一次里
     *   绘灵 864×1152（3:4 竖版）、GAL 1216×832（横版），而面板只显示前者 ⇒
     *   「我要横的它出竖的」「竖版怎么会把人画扁」这类排查全部走错方向。
     *   两个都留着，UI 按 `canvasSource` 标出哪个是真在用的。
     */
    galCanvas: galCanvas && Number(galCanvas.width) > 0 && Number(galCanvas.height) > 0
      ? { width: Number(galCanvas.width), height: Number(galCanvas.height) }
      : null,
    items,
  };
  try {
    const cfg = getConfig();
    if (!cfg.galBridge || typeof cfg.galBridge !== 'object') cfg.galBridge = {};
    const log = Array.isArray(cfg.galBridge.promptLog) ? cfg.galBridge.promptLog : [];
    cfg.galBridge.promptLog = [batch, ...log].slice(0, PROMPT_LOG_MAX);
    saveSettings();
  } catch { /* 留档失败不影响写词 */ }
  notifyGalUpdate('prompt');
  return batch;
}

/** 最近一次**实际送进后端**的正向/负向词（已含画师串、透明底等前置词条） */
export function rememberPaint({ prompt, negative, width, height, at = Date.now() } = {}) {
  /* trim 后判空：一串空格不是提示词，写进去只会让面板显示「0 字的图」 */
  const text = String(prompt || '').trim();
  if (!text) return null;
  const rec = {
    at,
    prompt: text.slice(0, PROMPT_TEXT_MAX),
    negative: String(negative || '').slice(0, 2000),
    width: Number(width) || 0,
    height: Number(height) || 0,
  };
  try {
    const cfg = getConfig();
    if (!cfg.galBridge || typeof cfg.galBridge !== 'object') cfg.galBridge = {};
    cfg.galBridge.lastPaint = rec;
    saveSettings();
  } catch { /* 同上 */ }
  notifyGalUpdate('paint');
  return rec;
}

/**
 * 写词失败的回执。
 *
 * ★ 三件必须同时做的事（少一件用户就看不到原因）：
 *   ① `diagnostic.code` 用**大写枚举** —— GAL 用 `/^[A-Z][A-Z0-9_]{0,63}$/` 校验，
 *      小写 / 带连字符一律丢弃（`request-stale` 就是这么被吞掉的）；
 *   ② `reason` 也给成同一个 code（`oe()` 优先读 `ce.reason`）；
 *   ③ 落一条 `warn` 日志 + 记进 `lastCall`，面板上能回看。
 *
 * `error` 仍保留中文人话：出图那条链路（`fe()`）是会显示它的，
 * 写词这条被 GAL 丢掉，但留着不亏。
 */
function fail(code, message) {
  record('prompt', false, code, message);
  warn(STAGE.GAL, `GAL 写词失败 [${code}]：${message}`);
  return {
    ok: false,
    reason: code,
    error: message,
    diagnostic: { code, stage: 'prompt-write' },
  };
}

/** 出图失败：GAL 这条链路的 `fe()` 会显示 `error` 原文，所以中文字符串够用 */
function failImage(code, message) {
  record('image', false, code, message);
  warn(STAGE.GAL, `GAL 出图失败 [${code}]：${message}`);
  return { ok: false, reason: code, error: message };
}

/**
 * 清掉 GAL 内置占位符 `<<dna:角色>>` / `<<dna_uc:角色>>` / `<<outfit:角色>>`。
 *
 * ★ 为什么必须清：GAL 出图前会检查 caption 里有没有残留占位符
 *   （`externalCaptionFailure`，正则 `/<<\s*(?:dna(?:_uc)?|outfit):/i`），
 *   命中就直接 `stopGeneration`，文案是「这份记录仍含内置占位符」。
 *   而它的 description 里**可能**带着未替换的占位符（取决于它的档案配置），
 *   模型会老实照抄进 caption —— 于是我们写词成功、出图却被对面拦下，
 *   报错还落在 GAL 那边，极难归因。
 *
 * 只用「删掉占位符本身」这一种最小处理，不动前后正文。
 */
export function stripGalPlaceholders(text) {
  return String(text == null ? '' : text)
    .replace(/<<\s*dna(?:_uc)?\s*:[^>]*>>/gi, ' ')
    .replace(/<<\s*outfit\s*:[^>]*>>/gi, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
}

/** GAL 会去这四处找入口；跨域访问 top/parent 会抛，逐个 try */
function hostsOf() {
  const list = [globalThis];
  try {
    if (typeof window !== 'undefined' && window) list.push(window);
  } catch { /* 无 window（node 测试） */ }
  try { if (typeof window !== 'undefined' && window?.top) list.push(window.top); } catch { /* 跨域 */ }
  try { if (typeof window !== 'undefined' && window?.parent) list.push(window.parent); } catch { /* 跨域 */ }
  return Array.from(new Set(list.filter(Boolean)));
}

/** 把 `img.url` 拿成 Blob。GAL 判「有没有图」只看这个 Blob，URL 它不认。 */
async function fetchBlob(url, signal) {
  if (!url) throw new Error('后端没有返回图片地址');
  const res = await fetch(url, { signal, cache: 'no-store' });
  if (!res.ok) throw new Error(`取图失败：HTTP ${res.status}`);
  return await res.blob();
}

/**
 * 组「写词成功」的返回体。
 *
 * ★ 抽成纯函数是为了**能被测试直接验**：GAL 对这两个字段的形状要求很刁
 *   （`value.caption` 与每个 `captions[].caption` 都必须是 V4 对象），
 *   而 `generateSinglePrompt` 要联网才能跑。抽出来后，测试验的就是
 *   **生产同一份代码**，不是测试自己另写一份假设 —— 这条纪律踩过坑。
 */
export function makePromptPayload({ prompt, width, height, negative = '', anchorSentence = '' }) {
  const v4 = makeV4Caption(prompt, negative);
  return {
    caption: v4,
    captions: [{
      /**
       * ★ `slotId` 给**数字**：GAL 用 `Number.isInteger(ke)` 才把它拼进诊断，
       *   字符串会被静默丢掉（不影响主流程，但排查时少一条线索）。
       */
      slotId: 1,
      /**
       * ★ `caption` 必须是 **V4 对象**，不能是裸字符串。
       *   GAL 过滤条目时调 `We(caption)`：
       *     `const Nt = $t?.v4_prompt?.caption;`
       *     `return !Nt || typeof Nt != 'object' ? false : String(Nt.base_caption||'').trim() ? true : ...`
       *   传字符串 ⇒ 取不到 `v4_prompt` ⇒ false ⇒ 条目被全部过滤掉
       *   ⇒ 报「DBGen 输出校验 → 未返回可用提示词」。
       *   v0.9.164 首次联调就栽在这里（当时只验到「node 里 ok:true」，没验这一关）。
       */
      caption: v4,
      /**
       * ★★★ `anchorSentence` 是 GAL 用来「在正文里定位这一张插在哪」的锚句（v0.9.168）。
       *
       *   关键实现细节：GAL 组装条目时写的是
       *     `...Pt.anchorSentence||Pt.anchor ? {anchorSentence:...} : {}`
       *   —— **空串是 falsy，字段会整个消失**，于是下游直接拿 `''` 去匹配、
       *   必然 `index < 0`、必然被 `continue` 丢掉。所以这里要么给真句，要么
       *   明确让调用方知道没算出来（由上层记 warn），不能塞空串当「有给」。
       */
      ...(anchorSentence ? { anchorSentence } : {}),
      width,
      height,
    }],
  };
}

/* ═══════════ 多张 CG（v0.9.175）═══════════ */

/**
 * 从 GAL 的 description 里读出「本楼要几张」。
 *
 * 原文（`igs.bundle.js` @5317787 逐字）：
 *   `为本楼生成${Mi.want}张CG，CG点自行选择。slotid沿用本次召回分配的编号…`
 * 这个 `Mi.want` 就是设置页「生图与 AI › CG › 每层最多张数」那一栏。
 *
 * ★ 上限 5：绘灵自己的 `maxImagesPerFloor` 默认 5，且一次输出 3 张单图 JSON
 *   已经接近出词模型的 max_tokens。要更多就分批，不是把上限拉大。
 */
export function parseGalWant(description) {
  const s = String(description || '');
  const m = /为本楼生成\s*(\d+)\s*张/i.exec(s);
  const n = m ? Number(m[1]) : 1;
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.min(5, Math.floor(n));
}

/**
 * 「本楼剧情正文」——喂给写词模型的那一份。
 *
 * ★★★ 这是 v0.9.174 之前画面「八竿子打不着」的根因修复。
 *
 *   GAL 的 dbgen description 里**一句剧情都没有**：它自己写的要求就是
 *   「挂载点只从剧情正文里逐字摘原句」——也就是说它明确指望**插件自己去取正文**。
 *   旧实现把 description 当成了正文喂给模型 ⇒ 模型手里只有「角色名 + 校服」，
 *   没有场景可依，只能编一个最典型的校园画面（实测编出「天台 + 铁丝网 + 夕阳」，
 *   而那一楼写的是教室）。
 *
 * 做三件事：① 整块剥掉施工数据（draft/summary/update…）；
 *          ② 剥掉 `<now_plot>` `<content>` `<scene_time>` 这些结构标签，只留文字；
 *          ③ 超长取**楼末**（CG 多描述楼末画面，且与默认锚点位置一致）。
 */
export function galStoryText(bodyText, maxLen = 2600) {
  const body = String(bodyText || '');
  if (!body.trim()) return '';
  const ranges = scaffoldRanges(body).slice().sort((a, b) => a[0] - b[0]);
  const keep = [];
  let cursor = 0;
  for (const [a, b] of ranges) {
    if (a > cursor) keep.push(body.slice(cursor, a));
    cursor = Math.max(cursor, b);
  }
  if (cursor < body.length) keep.push(body.slice(cursor));

  const flat = keep.join('\n')
    .replace(/<\/?(?:now_plot|content|scene_time)\b[^>]*>/gi, '\n')
    .replace(/\[igs-[^\]]*\]/gi, '');

  const lines = flat.split('\n').map((l) => l.trim()).filter((l) => l && !isScaffoldLine(l));
  let out = lines.join('\n').trim();
  /* 截断只丢开头，不丢结尾：楼末那段是默认锚点所在，必须留下 */
  if (out.length > maxLen) out = out.slice(out.length - maxLen).trim();
  return out;
}

/**
 * 多张 CG 的「写词」messages。
 *
 * 与 `buildGalMessages` 的差别只有两处：
 *   · user 里多了**本楼剧情正文**（画面与锚点的唯一来源）；
 *   · 要模型输出 `{shots:[{anchor, image}]}`，而不是一张图。
 *
 * ★ 为什么一次要 N 张而不是调 N 次：GAL 只调一次 `generateSinglePrompt`，
 *   返回几条 captions 就画几张（`igs.bundle.js` @5318600 逐条算锚点、逐条出图）。
 *   分 N 次调就要改 GAL，改不了。
 */
export function buildGalShotsMessages({ description, story, want, cfg }) {
  const c = cfg || getConfig();
  const tpl = getActiveTemplate() || {};
  const n = Math.max(2, Number(want) || 2);
  const task = [
    `【本次任务：本楼 ${n} 张 CG】`,
    '下面第一段是本楼**剧情正文**，第二段是外部 Galgame 前端发来的出图请求与角色设定。',
    `- 输出一个 JSON 对象：{"shots":[{"anchor":"...","image":{...}}, ...]}，shots **恰好 ${n} 项**。`,
    '- `anchor`：从**剧情正文**里逐字复制一句（15~60 字，连标点一起），用来把这张图插到正文对应位置。不许改写、不许拼接、不许用正文之外的字。',
    '- `image`：按上面规范写的**单图** JSON（`summary` + `items`），不要任何坐标字段，不要分格。',
    '- **`image` 里面只能是 `summary` + `items`**：不要 `layout` 包裹，不要 `changes` / `images` / `position` —— 本通道不接收档案变更，也没有段落编号。',
    '- 所有外貌与服装**一律写进每个 `character` 项的 caption**（不要另建变更记录、不要只写进 summary）。',
    '- **画面只能来自 `anchor` 那句所在的上下文**：环境、在场人物、人物动作与衣着都照那句写，**不得另编场景**。',
    `- ${n} 个 anchor 不许重复，也不要挤在相邻两句上，尽量分散在正文的不同位置。`,
    `- ${n} 张要**各画一个不同的瞬间**：构图（取景距离与角度）换，状态（动作、体位、脱到的程度）留 —— 见上文「跨图」那条。不许 ${n} 张都写成同一个机位、同一束光、同一个姿势。`,
    '- 只输出 JSON 本身：不要 markdown 代码块、不要解释、不要前后附言。',
  ].join('\n');

  const system = galSystemOf(tpl, task, c);

  const user = [
    '【本楼剧情正文（anchor 必须逐字来自这里）】',
    String(story || '').trim(),
    '',
    '【前端出图请求与角色设定】',
    String(description == null ? '' : description),
  ].join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/**
 * 解析多张写词的输出 → 可交付的 `[{ anchor, prompt }]`。
 *
 * 每一条都要过三关，**一关不过就丢这一条**（不是整批失败）：
 *   ① `anchor` 必须是**完整正文**的连续子串 —— GAL 拿它去 `tt.text` 里 `indexOf`，
 *      对不上就是「没有能对上正文的生成点」，图直接消失；
 *   ② 该位置必须过 `galInsertChecker`（GAL 的第二关 `imageMarkerBoundary`）；
 *   ③ `image` 必须能编译成非空提示词（复用单图那套 `compileGalPrompt`）。
 *
 * ★ 宁可少一张，也不把注定失败的锚点交出去 —— GAL 那边一条 +2 张全废时，
 *   用户看到的是「一张都没有」，比「只出了两张」难查得多。
 */
export function parseGalShots(raw, { body, story, cfg } = {}) {
  const text = stripPromptWrapper(raw);
  if (!text) return { shots: [], reason: 'empty' };

  let obj = null;
  let truncated = false;
  try {
    obj = JSON.parse(text);
  } catch {
    const pick = pickFirstJsonBlock(text);
    truncated = !!pick.truncated;
    if (pick.found) {
      try { obj = JSON.parse(pick.json); } catch { obj = null; }
    }
    if (!obj) return { shots: [], reason: truncated ? 'truncated' : 'no-json' };
  }

  const list = Array.isArray(obj?.shots)
    ? obj.shots
    : (Array.isArray(obj?.captions) ? obj.captions : []);
  if (!list.length) return { shots: [], reason: 'no-shots' };

  const src = String(body || '');
  const storyText = String(story || '');
  const checker = src ? galInsertChecker(src) : null;
  const seen = new Set();
  const shots = [];

  for (const s of list) {
    const anchor = String(s?.anchor || s?.anchorSentence || '').trim();
    if (!anchor || seen.has(anchor)) continue;
    /* 模型给的 anchor 必须原样出现在正文里；只出现在净化后的 story 里不算（story 有行裁剪） */
    const candidates = [];
    let from = 0;
    for (;;) {
      const at = src.indexOf(anchor, from);
      if (at < 0) break;
      candidates.push(at);
      from = at + 1;
      if (candidates.length >= 40) break;
    }
    if (!candidates.length) continue;
    /* 从前到后取第一个「GAL 判为可插入」的位置 */
    const hit = checker
      ? candidates.find((at) => checker(at + anchor.length) >= 0)
      : candidates[0];
    if (hit == null) continue;

    const image = (s?.image && typeof s.image === 'object')
      ? s.image
      : ((s?.summary || s?.items) ? s : null);
    if (!image) continue;

    const compiled = compileGalPrompt(JSON.stringify(image), cfg);
    if (!compiled.ok || !String(compiled.prompt || '').trim()) continue;

    /* 画面词里不许混进 anchor 之外的正文（模型常把整段抄进 caption） */
    seen.add(anchor);
    shots.push({ anchor, prompt: compiled.prompt });
  }

  return { shots, reason: shots.length ? 'ok' : 'no-valid-shot', truncated };
}

/**
 * 多张的返回体 —— 形状与 `makePromptPayload` 一致，只是 `captions` 有多条。
 *
 * ★★★ GAL 的硬要求（`igs.bundle.js` @5318560）：
 *   `captions.map(c => Number(c.slotId))` 必须**全是正整数且互不重复**，
 *   否则整批判失败并报「数据库生图插件返回缺失、非法或重复的 CG 编号」。
 *   所以 slotId 这里**由代码按顺序发**，绝不用模型给的编号。
 */
export function makeMultiPromptPayload({ shots, width, height, negative = '' }) {
  const list = Array.isArray(shots) ? shots.filter((s) => s && String(s.prompt || '').trim()) : [];
  if (!list.length) return null;
  const captions = list.map((s, i) => {
    const v4 = makeV4Caption(s.prompt, negative);
    return {
      slotId: i + 1,
      caption: v4,
      ...(s.anchor ? { anchorSentence: String(s.anchor) } : {}),
      width,
      height,
    };
  });
  return { caption: captions[0].caption, captions };
}

/**
 * ① 写词。
 *
 * 注意返回值里的 `captions[].width/height` 用的是**绘灵自己的画布**，
 * 不是 GAL 传的 —— 见文件头「用户主权区」。
 */
export async function generateSinglePrompt({ description, messageId, signal } = {}) {
  const cfg = getConfig();
  const g = galConfig(cfg);
  if (!g.enabled) {
    return fail('HL_GAL_DISABLED',
      '绘灵 GAL 桥未开启 —— 到绘灵「外部联动」页勾上「允许 GAL 前端调用绘灵写词与出图」');
  }
  if (signal?.aborted) return STALE;

  const mode = activeOutput();
  if (mode === 'layout') {
    /**
     * 多格 Layout 口径一张 CG 用不上：它的成品是「一页 N 格」，
     * 交给 GAL 当一张 CG 贴出来就是四格漫画。
     * 明确拒绝并指路，比静默降级好 —— 降级会让用户以为「设置的模版没生效」。
     */
    return fail('HL_GAL_LAYOUT',
      '当前模版是多格 Layout 口径（一页多格），GAL 要的是单张 CG。请到绘灵「生图规范」切到「单图」类模版后再试');
  }

  const { scene, cast } = splitGalDescription(description);
  if (!scene && !cast) {
    return fail('HL_GAL_EMPTY_DESC', 'GAL 传来的请求是空的（既没有画面描述也没有角色设定）');
  }
  /* 失败时连同「喂进去的东西」一起落盘，别只留模型输出这一半证据 */
  rememberGalInput(description, { scene, cast });
  /* v0.9.187：出图那一步拿不到楼层号，靠这里转交 */
  rememberGalFloor(messageId);
  /* 记下 GAL 要的构图尺寸，供紧接着的 `generate` 用（它拿不到 description） */
  {
    const c = parseGalCanvasFromDesc(description);
    lastDescCanvas = c ? { ...c, at: Date.now() } : null;
  }
  /**
   * ★★★ 正文必须**先读**（v0.9.175）—— 它是「画面从哪来」和「锚点从哪摘」的唯一来源。
   *
   * v0.9.174 及之前：正文只在下面找锚点时读了一次，**从没进过 LLM 的 messages**
   * ⇒ 出词模型手里只有 GAL 的指令串（无一句剧情），只能按「女高中生 + 校服」
   *   编一个天台夕阳。用户看到的就是「八竿子打不着的画面」。
   */
  const floorBody = readFloorText(messageId);
  const want = parseGalWant(description);
  rememberGalWant(want);
  const story = galStoryText(floorBody);
  /**
   * ★ 送给写词模型的 description 与「解析用的原文」是**两份**：
   *   锚点 / 画布 / 张数全部按 GAL 原文算（那是它那边的坐标系），
   *   而设定段里的「外貌」按开关换成绘灵档案 —— 只换这一段，别的一个字不动。
   */
  const lookStats = {};
  const outfitStats = {};
  const descForLlm = applyOutfitSource(
    applyAppearanceSource(description, cfg, lookStats),
    cfg,
    outfitStats,
  );
  lastLookStats = {
    source: lookStats.source || '',
    replaced: Number(lookStats.replaced) || 0,
    at: Date.now(),
  };
  lastOutfitStats = {
    source: outfitStats.source || '',
    replaced: Number(outfitStats.replaced) || 0,
    at: Date.now(),
  };
  info(STAGE.GAL,
    `收到 GAL 写词请求：画面 ${scene.length} 字 + 角色设定 ${cast.length} 字`
    + `（第 ${messageId ?? '-'} 楼，口径 ${mode}，要 ${want} 张，正文 ${floorBody.length} 字 / 净化后 ${story.length} 字）`);
  if (lookStats.source === 'huilin') {
    info(STAGE.GAL,
      lookStats.replaced
        ? `外貌来源＝绘灵档案，已替换 ${lookStats.replaced} 个角色的外貌段`
        : '外貌来源＝绘灵档案，但这次没有可替换的外貌段（档案里没这些人，或 GAL 没给【角色设定】）');
  }
  if (outfitStats.source === 'huilin') {
    info(STAGE.GAL,
      outfitStats.replaced
        ? `服装来源＝绘灵档案，已整包替换 ${outfitStats.replaced} 个角色的款式+状态+裸露`
        : '服装来源＝绘灵档案，但这次没有可替换的衣装段（角色没建档，或 dyn 里款式/状态都还是空的）');
  }

  const { width, height } = currentCanvas(cfg);
  let shots = [];
  let note = '单张';

  /**
   * 多张路径：只在 json 口径下走（text 口径一次输出多段自然语没有可靠分隔）。
   * 正文太短（<60 字）时也没有分点价值，直接单张。
   */
  if (mode === 'json' && want > 1 && story.length >= 60) {
    const rawMulti = await callAnalyzeLLM(
      buildGalShotsMessages({ description: descForLlm, story, want, cfg }),
      { source: `GAL ${want} 张 CG` },
    );
    if (signal?.aborted) return STALE;
    if (!rawMulti || !String(rawMulti).trim()) {
      return fail('HL_GAL_LLM_EMPTY',
        '出词 API 没有返回内容 —— 到绘灵「出词 API」页点一次「测试连接」确认通；'
        + '若用的是 HTTP 直连而酒馆是 HTTPS 页面，浏览器会以混合内容拦掉');
    }
    const parsed = parseGalShots(rawMulti, { body: floorBody, story, cfg });
    shots = parsed.shots.slice(0, want);
    note = `多张 请求${want}张/实得${shots.length}张`
      + (parsed.reason !== 'ok' ? `（${parsed.reason}）` : '')
      + (parsed.truncated ? '（被截断）' : '');
    if (!shots.length) {
      warn(STAGE.GAL, `多张写词一张也没解析出来（${parsed.reason}）—— 退回单张重写，避免整楼不出图`);
    }
  }

  /* 单张 / 多张彻底失败 ⇒ 走原来的单图路径保底 */
  if (!shots.length) {
    const oneMsgs = buildGalMessages({ description: descForLlm, story, cfg });
    let raw = await callAnalyzeLLM(oneMsgs, { source: 'GAL 单张 CG' });
    if (signal?.aborted) return STALE;
    /**
     * ★★★ v0.9.183：**被安全策略拒答时重试一次**。
     *
     * 实测（2026-10-31 22:36，错误码 `HL_GAL_JSON_NO_OBJECT`）：
     *   出词模型不是「没返回」，而是回了一段
     *   `I cannot fulfill this request. The prompt includes … sexually explicit descriptions
     *    involving characters in school uniforms.` —— 有内容、但不是 JSON。
     *
     * 这一类失败有两个特点，决定了它值得重试而不是直接判死：
     *   ① **不是每次都拒**：同一天 22:02 / 22:06 / 22:07 / 22:16 四批都成功，
     *      22:36 才拒。判据落在内容边缘上，重跑一次就是换一个采样点。
     *   ② **拒答的诱因可能在我们自己这边**：那次真正的原因是服装状态被 `dress shirt`
     *      误判成裙子，给男主凭空写了「裙子正从她臀部滑落、小腹裸露」
     *      （见 `outfitStateFacts.kindOf`）。修掉之后同一份输入直接出 JSON。
     *      ⇒ 重试只能补救「偶发」，不能补救「真写过火」；所以只重试 1 次，不做无限循环。
     */
    if (looksLikeRefusal(raw)) {
      warn(STAGE.GAL, '出词模型拒答（安全策略），用同一份请求重试一次');
      raw = await callAnalyzeLLM(oneMsgs, { source: 'GAL 单张 CG（拒答重试）' });
      if (signal?.aborted) return STALE;
    }
    if (!raw || !String(raw).trim()) {
      return fail('HL_GAL_LLM_EMPTY',
        '出词 API 没有返回内容 —— 到绘灵「出词 API」页点一次「测试连接」确认通；'
        + '若用的是 HTTP 直连而酒馆是 HTTPS 页面，浏览器会以混合内容拦掉');
    }

    const compiled = compileGalPrompt(raw, cfg);
    if (!compiled.ok) {
      /**
       * ★ code 一定要**细分**，不能统一 `HL_GAL_COMPILE_FAIL`。
       *   因为 GAL 的 `me()` 只回显 code（`detail` 被枚举白名单卡死，
       *   只认 `code-fence` / `empty-subject` 这几种），原文一个字都到不了界面。
       *   细分之后，用户截图那一行 code 本身就等价于「故障分类」。
       */
      return fail(compiled.code || 'HL_GAL_COMPILE_FAIL', compiled.error);
    }
    if (compiled.stats?.summaryOnly) {
      debug(STAGE.GAL, '空镜降级：只有 summary，无人物/文字层');
    }

    const prompt = stripGalPlaceholders(compiled.prompt);
    if (!prompt) {
      return fail('HL_GAL_PLACEHOLDER_EMPTY', '提示词清理内置占位符后变成空串');
    }

    /**
     * ★★★ 插入锚点（v0.9.168 起；v0.9.173 彻底改正找法）—— 这一段决定「图能不能贴进正文」。
     *
     * GAL 侧（`src/visual` 插图规划）拿到 captions 后逐条：
     *   `const _a = String(tr.anchorSentence || tr.anchor || "").trim();`
     *   `const wa = M(tt.text, _a);  if (wa.index < 0) { …跳过… }`
     * 也就是说**空锚点 = 这张图直接消失**，界面上只报一句
     * 「数据库生图插件没有返回能对上正文的生成点」，看不出是锚点的锅。
     *
     * v0.9.173 之前的错：一直在 description 里找句子，而 description 是**给插件的指令**
     * （`【角色设定】` 这个分隔标记还是我们自己造的，GAL 从不写它）⇒ 锚点恒 miss。
     * 现在改成 `resolveAnchor` 的三层，主力是 `pickAnchorFromBody`：
     * **从楼层正文里原样截一句**，保证是 `tt.text` 的连续子串 ⇒ exact 必中。
     */
    const resolved = resolveAnchor(floorBody, scene);
    const { anchor, from: anchorFrom } = resolved;
    const blockers = resolved.audit?.blockers || [];
    if (anchor) {
      if (anchorFrom === 'scene') {
        warn(STAGE.GAL,
          `楼层正文没取到（messageId=${String(messageId)}）—— 改用 GAL 传来的画面描述段自身做锚点：`
          + `${anchor.slice(0, 40)}${anchor.length > 40 ? '…' : ''}`);
      } else {
        info(STAGE.GAL,
          `插入锚点${anchorFrom === 'body' ? '从正文末尾摘取（可插入位置已用 GAL 同一套算法验过）' : '命中画面描述原句'}：`
          + `${anchor.slice(0, 40)}${anchor.length > 40 ? '…' : ''}`);
      }
      if (resolved.rejected) {
        debug(STAGE.GAL, `挑锚点时跳过了 ${resolved.rejected} 个「GAL 判为无法插入」的位置`);
      }
    } else if (blockers.length) {
      /**
       * ★★★ 这就是界面上那句「生成点已命中正文，但没有安全的独占行插入位置」的真因。
       *
       * GAL 的正文结构解析会把「没闭合的尖括号词」当成一个开标签，并且一路罩到段末
       * （`end: null`），于是它之后的**任何**位置都插不进图。用户只能看到一句含糊的
       * 报错，完全不知道该改哪里 —— 所以这里必须把病灶名和原文一起喊出来。
       */
      const b = blockers[0];
      const label = b.kind === '标签' ? `<${b.name}>` : `「${b.name}」（方括号）`;
      warn(STAGE.GAL,
        `第 ${messageId ?? '-'} 楼插不进图：正文第 ${b.start} 字处有一个**没闭合的${b.kind}** ${label}。`
        + `GAL 会把它当成一个罩到段末的结构，因此它之后的任何位置都插不进图 —— `
        + `这是 GAL 的正文解析行为，不是绘灵没连上。原文：…${b.snippet}…`
        + (blockers.length > 1 ? `（本楼同类还有 ${blockers.length - 1} 处）` : ''));
    } else {
      warn(STAGE.GAL,
        `插入锚点没有算出来（第 ${messageId ?? '-'} 楼，正文 ${floorBody.length} 字）`
        + '—— GAL 会把这张图判为「没有能对上正文的生成点」而丢掉。'
        + '多半是画面描述是纯设定、正文里没有对应句子。');
    }

    shots = [{ anchor, prompt }];
    if (note !== '单张') note = `${note} → 退回单张`;
  }
  const payload = makeMultiPromptPayload({
    shots,
    width,
    height,
    negative: String(cfg.globalNegative || '').trim(),
  });
  if (!payload) {
    return fail('HL_GAL_PLACEHOLDER_EMPTY', '提示词清理内置占位符后变成空串');
  }

  const withAnchor = shots.filter((s) => s && s.anchor).length;
  info(STAGE.GAL,
    `GAL 写词完成：${payload.captions.length} 张（${note}），画布 ${width}×${height}，`
    + `带锚点 ${withAnchor}/${shots.length}`);

  lastCall = record('prompt', true, 'OK',
    `${payload.captions.length} 张 / 画布 ${width}×${height}`
    /* ★ 正文长度必须记：一眼区分「压根没取到楼层」（0 字）和「取到了但没摘出句」 */
    + ` / 正文 ${floorBody.length} 字`
    + ` / 锚点 ${withAnchor}/${shots.length}`
    + ` / ${note}`);

  /**
   * 留一份「本楼画了什么词」——面板「本楼 CG 提示词」就读这里。
   * 用 `payload.captions[i].slotId` 对齐（代码分配的 1..N），caption 文本取写词原文
   * （`shots[i].prompt`），不是 v4 包装后的内部格式 —— 用户要看的是画面词，不是容器。
   */
  rememberPromptBatch({
    messageId,
    note,
    width,
    height,
    /* GAL 要求/实际会用的画布 —— 面板要能分清「我设的」和「它要的」 */
    galCanvas: galCanvasForLog(description),
    shots: payload.captions.map((c, i) => ({
      slotId: c.slotId,
      anchor: c.anchorSentence || '',
      caption: shots[i]?.prompt || c.caption,
    })),
  });

  return { ok: true, value: payload };
}

/**
 * 透明底词条。GAL 要的是立绘 / 小道具 / 表情差分的**去背图**，
 * 它自己只能靠「按兜底底色抠」，边缘会毛 ⇒ 提示词里先说清楚。
 */
export const GAL_TRANSPARENT_TAGS = 'transparent background, simple background';

/**
 * 把「必须放最前面」的正向词条拼好，并把 GAL 的负向串并进去（v0.9.171）。
 *
 * 为什么单独抽成纯函数：`generate` 会真的连 ComfyUI，测不动；
 * 而「顺序」错了**不报错**，只让画面调性慢慢跑偏，必须能自动验。
 *
 * 顺序固定：**GAL 画师串 → 透明底 → 正文**。
 * 依据是模型对**前 77 token** 最敏感 —— 画风定调优先，背景属性次之，正文最后。
 *
 * @returns {{prompt:string, negative:string, wantsTransparent:boolean,
 *            usedArtist:boolean, usedNegative:boolean}}
 */
export function composeGalPrompt({ prompt, negative, artist, useGalArtist, params } = {}) {
  const body = String(prompt || '');
  const baseNeg = String(negative || '').trim();
  const galPos = String(artist?.positivePrompt || '').trim();
  const galNeg = String(artist?.negativePrompt || '').trim();
  const wantsTransparent = !!(params?.straight_alpha || params?.tag_hint_transparent_background);
  /* 只有**明确关掉**才不并；`undefined`（老配置没过 galConfig）按默认开处理 */
  const takeArtist = useGalArtist !== false;

  const head = [];
  let outNeg = baseNeg;
  let usedArtist = false;
  let usedNegative = false;

  if (galPos && takeArtist) { head.push(galPos); usedArtist = true; }
  if (galNeg && takeArtist) {
    outNeg = [outNeg, galNeg].filter(Boolean).join(', ');
    usedNegative = true;
  }
  if (wantsTransparent) head.push(GAL_TRANSPARENT_TAGS);
  /**
   * ★ 正文为空时**不许**留下尾逗号 —— `"xxx, "` 会被编码器当成一个空标签，
   *   有些工作流会因此报错，有些会塞进一个乱七八糟的东西。
   */
  if (body.trim()) head.push(body);

  return {
    prompt: head.join(', '),
    negative: outNeg,
    wantsTransparent,
    usedArtist,
    usedNegative,
  };
}

/**
 * ② 出图。
 *
 * `params` 里的尺寸/种子/模型，**按面板开关决定采不采纳**（v0.9.170 起）：
 * 画布来源选「GAL」时用它的宽高（对齐到你设的倍数），否则用绘灵自己的；
 * 种子与模型一律不采纳 —— 那是后端工作流的事（用户主权区）。
 */
export async function generate({ caption, signal, params, artist, shouldStart, replaceCharacterKeywords } = {}) {
  const cfg = getConfig();
  const g = galConfig(cfg);
  if (!g.enabled) return failImage('HL_GAL_DISABLED', '绘灵 GAL 桥未开启');
  if (signal?.aborted) return STALE;
  /**
   * `shouldStart()` 是 GAL 的「这张还要不要画」回调（用户中途取消、楼层被改等）。
   * 它的返回值是 `!== true` 即放弃，且**不算失败** —— 必须回 stale，
   * 否则 GAL 会把「用户主动取消」当做出图故障弹错误。
   */
  if (typeof shouldStart === 'function') {
    let go = true;
    try { go = shouldStart() === true; } catch { go = false; }
    if (!go) return STALE;
  }

  let prompt = readV4Caption(caption);
  if (!prompt) return failImage('HL_GAL_NO_CAPTION', '没有拿到要画的内容（caption 是空的）');

  /**
   * GAL 传过来的这一包参数，**逐项按面板开关处理**（v0.9.169）：
   *
   *   · `artist`（画师串，9 类各一组）→ `useGalArtist` 开时并进提示词；
   *   · `params.width/height`         → `canvasSource==='gal'` 时用它；
   *   · `params.seed` / `params.model`→ 绘灵后端工作流自己管，只记日志；
   *   · `straight_alpha` 等透明要求   → **只加提示词词条**（v0.9.171）；
   *     后端工作流有没有透明通道是用户的，绘灵不碰，但「要透明底」这件事
   *     必须由提示词说出来，否则立绘/道具会拖着白底进阅读器。
   *
   * 所有「要放最前面」的词条都进 `head`，最后一次性拼接 ——
   * 分开拼会互相插队（画师串塞一次、透明底塞一次 ⇒ 顺序取决于代码先后，
   * 而模型对**前 77 token** 最敏感，顺序错了调性就变）。
   * ⇒ 拼接逻辑在 `composeGalPrompt()` 里，本函数只负责记日志。
   */
  const composed = composeGalPrompt({
    prompt,
    negative: cfg.globalNegative,
    artist,
    useGalArtist: g.useGalArtist,
    params,
  });
  prompt = composed.prompt;
  let negative = composed.negative;

  if (composed.usedArtist || composed.usedNegative) {
    info(STAGE.GAL,
      `已并入 GAL 画师串${composed.usedArtist ? '（正向）' : ''}${composed.usedNegative ? '（负向）' : ''}`);
  } else if (!g.useGalArtist && (artist?.positivePrompt || artist?.negativePrompt)) {
    debug(STAGE.GAL, 'GAL 这次带了画师串，但面板里关了「并入 GAL 画师串」—— 只用绘灵自己的画风词');
  }

  if (params && typeof params === 'object') {
    const bits = [];
    if (params.width || params.height) bits.push(`${params.width}×${params.height}`);
    if (Number.isInteger(params.seed)) bits.push(`seed=${params.seed}`);
    if (params.model) bits.push(`model=${params.model}`);
    if (params.straight_alpha || params.tag_hint_transparent_background) bits.push('要透明底');
    if (bits.length) debug(STAGE.GAL, `GAL 传参：${bits.join(' / ')}`);
    if (params.straight_alpha || params.tag_hint_transparent_background) {
      warn(STAGE.GAL,
        `GAL 这次要的是透明底（立绘/道具）：已在正向词最前面加了「${GAL_TRANSPARENT_TAGS}」。`
        + '但提示词管不到工作流 —— 你的 ComfyUI 工作流若没有 alpha 通道，出图仍带底色，'
        + 'GAL 会按「立绘兜底底色」抠掉（数据库生图＝白底）。');
    }
  }
  if (replaceCharacterKeywords === false) {
    debug(STAGE.GAL, 'GAL 要求保留角色关键词占位符（replaceCharacterKeywords=false），本次不替换');
  }

  const huilinCanvas = currentCanvas(cfg);
  const be = cfg.backends?.comfyui || {};
  const multiple = Number(be.resSelector?.multiple) > 0 ? Number(be.resSelector.multiple) : 16;
  /**
   * 尺寸来源三级：`params`（GAL 图位设过尺寸）→ description 里的构图尺寸 → 绘灵自己。
   *
   * ★ 为什么还要第二级：实测那一次的 `params` 里没有宽高（图位没设尺寸），
   *   而 description 明写「画面是横的，宽1216，高832」—— 只认 params 就等于
   *   无视 GAL 的构图要求，出成竖图（用户看到「它要横的，出来是竖的」）。
   * ★ 只有 `canvasSource==='gal'` 才看前两级；选 huilin 就完全不读 GAL。
   */
  let galW = Number(params?.width);
  let galH = Number(params?.height);
  let canvasFrom = 'params';
  if (!(galW > 0 && galH > 0)) {
    const cached = lastDescCanvas && (Date.now() - lastDescCanvas.at < 5 * 60 * 1000)
      ? lastDescCanvas
      : null;
    if (cached) {
      galW = cached.width;
      galH = cached.height;
      canvasFrom = 'desc';
    }
  }
  const useGalCanvas = g.canvasSource === 'gal' && galW > 0 && galH > 0;

  let width;
  let height;
  if (useGalCanvas) {
    /**
     * 对齐到 `multiple`（面板上的「倍数」，默认 16）。
     * MOSS 的分桶在 16 的倍数上，给 833 这种数会被它悄悄挪进最近桶 ——
     * 表现就是「尺寸错了 + 人物漂移」，而且日志里一切正常。
     */
    width = alignToMultiple(galW, multiple);
    height = alignToMultiple(galH, multiple);
  } else {
    width = huilinCanvas.width;
    height = huilinCanvas.height;
  }

  info(STAGE.GAL,
    `收到 GAL 出图请求：提示词 ${prompt.length} 字 → 提交 ComfyUI（${width}×${height}，画布来源 `
    + (useGalCanvas
      ? `GAL ${galW}×${galH}（${canvasFrom === 'desc' ? 'description 构图尺寸' : '图位 params'}）`
        + `对齐到 ${multiple} 的倍数`
      : '绘灵')
    + '）');

  /**
   * 留一份「实际送进后端的词」（已并入画师串 / 透明底等前置词条，v0.9.177）。
   * ★ 与写词留档分工：写词那份是「模型写了什么」，这份是「后端到底收到什么」。
   *   两者不一致的地方（画师串顺序、负面被合并）正是最容易让人怀疑「设置没生效」的位置。
   */
  rememberPaint({ prompt, negative, width, height });

  /**
   * ★ v0.9.176：等待预算按「本楼张数」放大。
   *   ComfyUI 串行排队，第 N 张要等前面跑完 —— 用单张的 180 秒去等，
   *   会把**已经画好的图**判成超时（实测 282.7s 成功的那张就在 181s 被丢掉）。
   */
  const paintTimeout = galPaintTimeout(cfg);
  const res = await submit({
    prompt,
    negative,
    cfg: useGalCanvas ? cfgWithCanvas(cfg, width, height) : cfg,
    label: 'GAL 单张 CG',
    timeoutSec: paintTimeout,
  });
  if (signal?.aborted) return STALE;
  if (!res.ok) return failImage('HL_GAL_SUBMIT_FAIL', res.error || '出图失败');

  const img = res.images?.[0];
  if (!img) return failImage('HL_GAL_NO_IMAGE', '后端没有返回图片');

  let blob = null;
  try {
    blob = await fetchBlob(img.url, signal);
  } catch (err) {
    /**
     * 取图失败最常见的原因是跨域（酒馆页面 fetch ComfyUI 的 /view）。
     * 绘灵自己的归档功能走的是同一条路，若那边能存图，这里也该能 —— 所以
     * 真出问题时要指名道姓，别让用户以为是「出图失败」。
     */
    return failImage('HL_GAL_FETCH_IMAGE',
      `图已生成但取回失败：${err?.message || err}`
      + '（若反复出现，检查 ComfyUI 是否允许跨域访问 /view）');
  }
  info(STAGE.GAL, `GAL 出图完成：${Math.round(blob.size / 1024)} KB`);

  /**
   * v0.9.187：把这一张「画了什么」记下来，下一次写词要拿它做延续依据。
   * 必须在出图成功之后 —— 失败/取消的图不该进记忆（否则下一张会去延续一张不存在的画面）。
   */
  try {
    const brief = galShotBrief(prompt);
    if (brief.caption) pushGalShot({ caption: brief.caption, scene: brief.scene, mesId: lastGalMesId });
  } catch { /* 记忆失败不影响出图 */ }

  lastCall = record('image', true, 'OK', `${Math.round(blob.size / 1024)} KB / ${width}×${height}`);
  return { ok: true, value: [{ blob, mimeType: blob.type || 'image/png' }] };
}

/** 挂上去的那个单例 —— 卸载时靠它比对，绝不删别人挂的 `NaiDbGen` */
let installedApi = null;

/** 给 GAL 用的完整入口对象（少一个函数 GAL 就判「版本过旧」） */
/**
 * 把出口包一层「任何异常都不许静默」。
 *
 * ★ 为什么必须包：`generateSinglePrompt` 内部会走 `singleJsonPrompt` / `JSON.parse` /
 *   `layoutToLine`，任何一处抛出来，异常会直接冒到 GAL 的调用栈里 ——
 *   它只会给一句「数据库生图插件写词接口异常」，**没有 code、没有位置**，
 *   用户看到的仍是一句废话，我们这边连 `lastCall` 都没有记录。
 *   包住之后最差也是一个 `HL_GAL_INTERNAL` + 落盘的 message，问题一定留痕。
 */
function guard(kind, name, fn) {
  return async function guarded(...args) {
    try {
      return await fn(...args);
    } catch (err) {
      const msg = `${name} 内部异常：${err && err.stack ? String(err.stack).split('\n').slice(0, 3).join(' | ') : err}`;
      if (kind === 'prompt') return fail('HL_GAL_INTERNAL', msg);
      return failImage('HL_GAL_INTERNAL', msg);
    }
  };
}

/* ═══════════ 把 GAL 带来的角色设定摊开给用户看（v0.9.169）═══════════ */

/**
 * 从 GAL 传来的 description 里抽出「每个角色 + 当前衣装」。
 *
 * ★ 为什么必须能看见：GAL 自己维护一份衣装状态（正文里的衣装指令
 *   → `story-outfit-service` 更新 → 写进下一次请求的 `当前衣装「X」：`），
 *   而绘灵这边**看不到**它的状态。用户想知道「衣服到底有没有跟着剧情换」，
 *   唯一可靠的证据就是**GAL 实际传过来的那段文字**。
 *   所以这里不猜、不推断，只做一件事：把原文摊开。
 */
export function parseGalCast(text) {
  const s = String(text || '');
  if (!s.includes(GAL_CAST_MARK)) return [];
  const i = s.indexOf(GAL_CAST_MARK);
  const cast = s.slice(i);
  const marks = [];
  const re = /角色「([^」]{1,40})」/g;
  let m;
  while ((m = re.exec(cast))) marks.push({ name: m[1].trim(), at: m.index, end: re.lastIndex });
  const out = [];
  for (let k = 0; k < marks.length; k += 1) {
    const seg = cast.slice(marks[k].end, k + 1 < marks.length ? marks[k + 1].at : cast.length);
    const of = /当前衣装(?:「([^」]{0,60})」)?：\s*([\s\S]*?)(?=\n[^\s]|$)/.exec(seg);
    out.push({
      name: marks[k].name,
      outfitName: of?.[1] ? String(of[1]).trim() : '',
      outfit: of ? String(of[2] || '').replace(/\s+/g, ' ').trim().slice(0, 160) : '',
    });
  }
  return out;
}

/* ═══════════ 与 GAL 共处：清掉绘灵自己的图位（v0.9.168）═══════════ */

/**
 * 绘灵写进正文的图位块：`<hl_image pos="P3">提示词</hl_image>`。
 * 与 `render.js` 的 `buildHlImage` 同构（JSON 模版下没有自然语部分，就只有前半段）。
 */
const HL_IMAGE_SRC = '<hl_image\\b[^>]*>[\\s\\S]*?<\\/hl_image>';

/** 数一数本对话里还有多少楼残留绘灵图位（面板显示用，不改任何东西）。 */
export function countHlImageFloors() {
  try {
    const chat = globalThis.SillyTavern?.getContext?.()?.chat;
    if (!Array.isArray(chat)) return { floors: 0, blocks: 0 };
    const re = new RegExp(HL_IMAGE_SRC, 'gi');
    let floors = 0;
    let blocks = 0;
    for (const m of chat) {
      const hits = String(m?.mes || '').match(re);
      if (hits?.length) { floors += 1; blocks += hits.length; }
    }
    return { floors, blocks };
  } catch { return { floors: 0, blocks: 0 }; }
}

/**
 * 把正文里的绘灵图位整块删掉 —— **只删 `<hl_image>…</hl_image>`**，别的一字不动。
 *
 * ★ 为什么必须给这个入口：GAL 阅读器只认 `[igs-img:N]`，遇到 `<hl_image>` 会把它
 *   当作**普通正文**渲染出来 —— 实测截图里读者看到的是一整段
 *   `<hl_image pos="P38">{"summary":…,"items":…}</hl_image>` 的原始 JSON。
 *   而这些块是绘灵在「GAL 模式」之前写进去的，开关打开后不会再写，
 *   但已经写下的不会自己消失。
 *
 * ★ 为什么不做成自动：这是**改用户正文**。按长期规矩，动正文的事必须由用户自己按。
 */
export async function cleanHlImageFloors() {
  const { getChat, setMessageText } = await import('./st.js');
  const chat = getChat() || [];
  let floors = 0;
  let blocks = 0;
  let failed = 0;
  for (let i = 0; i < chat.length; i += 1) {
    const mes = String(chat[i]?.mes || '');
    const hits = mes.match(new RegExp(HL_IMAGE_SRC, 'gi'));
    if (!hits || !hits.length) continue;
    const next = mes
      .replace(new RegExp(HL_IMAGE_SRC, 'gi'), '')
      .replace(/[ \t]+$/gm, '')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
    if (setMessageText(i, next)) { floors += 1; blocks += hits.length; }
    else failed += 1;
  }
  if (floors) {
    info(STAGE.GAL, `已清掉 ${floors} 个楼层里的 ${blocks} 个绘灵图位（<hl_image> 块）`);
  }
  return { floors, blocks, failed };
}

/**
 * 体检「当前最新一条 AI 楼」的正文结构。
 *
 * 为什么要有这个：GAL 插不进图时只报一句
 * 「生成点已命中正文，但没有安全的独占行插入位置」，
 * 看不出是**哪个标签**害的 —— 而真因几乎总是在正文里某个没闭合的尖括号词。
 */
export function auditLatestFloor() {
  try {
    const ctx = globalThis.SillyTavern?.getContext?.();
    const chat = ctx?.chat;
    if (!Array.isArray(chat)) return null;
    for (let i = chat.length - 1; i >= 0; i -= 1) {
      const m = chat[i];
      if (!m || m.is_user) continue;
      const body = String(m.mes || '');
      if (!body.trim()) continue;
      return { index: i, name: String(m.name || ''), ...galBodyAudit(body) };
    }
    return null;
  } catch { return null; }
}

/**
 * 「本楼急救」：给 `<now_plot>` 内层套一层 `<content>`。
 *
 * ★ 会**改正文**，所以只由用户点按钮触发（和「清理图位」同一性质），绝不自作主张。
 * ★ 施工块（draft / summary / update）留在外面 —— 它们里面的伪标签不能跟着进 content。
 */
export async function fixLatestFloorStructure() {
  try {
    const ctx = globalThis.SillyTavern?.getContext?.();
    const chat = ctx?.chat;
    if (!Array.isArray(chat)) return { ok: false, reason: 'no-chat' };
    for (let i = chat.length - 1; i >= 0; i -= 1) {
      const m = chat[i];
      if (!m || m.is_user) continue;
      const body = String(m.mes || '');
      if (!body.trim()) continue;
      const r = wrapStoryInContent(body);
      if (!r.ok) return { ok: false, reason: r.reason, index: i };
      const { setMessageText } = await import('./st.js');
      const done = setMessageText(i, r.text);
      if (done) {
        info(STAGE.GAL, `第 ${i} 楼正文已给剧情套上 <content>（+${r.text.length - body.length} 字），GAL 现在可以插图了`);
      }
      return { ok: !!done, reason: done ? '' : 'write-failed', index: i, added: r.text.length - body.length };
    }
    return { ok: false, reason: 'no-floor', index: -1 };
  } catch (e) {
    return { ok: false, reason: String(e?.message || e) };
  }
}

/**
 * 把尺寸对齐到 `multiple` 的整数倍。
 *
 * ★ 为什么必须对齐：MOSS 的分桶在 16 的倍数上，给个 833×1217 这种数
 *   就会落进「最近桶」并被悄悄改尺寸 —— 表现是「人物位置漂移 / 构图跑掉」。
 *   GAL 那边四类图（CG / 立绘 / 背景 / 物品）尺寸各不相同，
 *   其中分辨率选择器出来的值不保证是 16 的倍数，所以这里统一收一次。
 */
export function alignToMultiple(value, multiple) {
  const v = Math.round(Number(value) || 0);
  const m = Math.round(Number(multiple)) > 0 ? Math.round(Number(multiple)) : 16;
  if (v <= 0) return 0;
  return Math.max(m, Math.round(v / m) * m);
}

/**
 * 纯计算：给定「单张基准」和「本楼张数」，算出等一张图的上限（秒）。
 *
 * ★ 单独拆出来是为了能被单测直接喂值 —— `galPaintTimeout` 依赖模块内的
 *   张数记忆，纯函数才能验证「乘几倍 / 夹在哪」这条判据本身。
 *
 * @param {number} baseSec 面板上的单张基准（空/0 → 300）
 * @param {number} want 本楼张数（空/0 → 1，夹在 1..5）
 * @returns {number} 秒，上限 1800
 */
export function paintTimeoutOf(baseSec, want) {
  const base = Math.max(30, Number(baseSec) || 300);
  const n = Math.max(1, Math.min(5, Number(want) || 1));
  return Math.min(1800, base * n);
}

/**
 * GAL 模式等一张图的预算（秒）。
 *
 * ★★★ 为什么必须比单张宽松：ComfyUI 后端是**串行队列**（一次只跑一张）。
 *   一楼要 N 张时，第 N 张从提交到出图要等「前面 N-1 张跑完 + 自己跑完」；
 *   GAL 还可能同时排着立绘 / 场景，实际更长。
 *
 *   实测病例（0.9.175，want=3，面板超时 180）：
 *     第 1 张 14.5s ✅ ／ 第 2 张 **282.7s 实际成功**、却在 181s 被判超时
 *     ／ 第 3 张排队 102s + 跑 84.7s = 187s，差 7 秒被丢。
 *   ⇒ 两张**已经画好的图**被扔掉，用户看到「只成了一张」。
 *
 * 取值：`面板基准 × 张数`，夹在 [30, 1800] 之间。
 *    图一出来就返回，所以放大只是抬高天花板，不会真的干等。
 *
 * @param {object} cfg 绘灵配置
 * @param {number} [now] 注入时间（测试用）
 */
export function galPaintTimeout(cfg, now = Date.now()) {
  const cached = lastWant && now - lastWant.at < WANT_TTL_MS ? Number(lastWant.n) : 0;
  return paintTimeoutOf(cfg?.backends?.comfyui?.timeoutSec, cached);
}

/**
 * 记下本楼要几张（`generateSinglePrompt` 调用，`generate` 读取）。
 * @param {number} n
 * @param {number} [at]
 */
export function rememberGalWant(n, at = Date.now()) {
  lastWant = { n: Math.max(1, Math.min(5, Number(n) || 1)), at };
}

/**
 * 清掉「张数记忆」—— 测试与卸载时用，避免用例之间互相串味。
 */
export function resetGalWantMemory() {
  lastWant = null;
}

/**
 * 克隆一份 cfg，把画布换成 GAL 给的那套（不动用户原配置）
 *
 * 宽高已由调用方对齐到倍数。
 *
 * @param {object} cfg
 * @param {number} width
 * @param {number} height
 */
export function cfgWithCanvas(cfg, width, height) {
  const be = cfg.backends?.comfyui || {};
  return {
    ...cfg,
    backends: {
      ...cfg.backends,
      comfyui: {
        ...be,
        width,
        height,
        /**
         * ★ 必须把 resSelector 关掉：它开着时 `applyResolution` 会按
         *   「宽高比 + 百万像素 + 倍数」重算，把我们刚设的 width/height 覆盖掉。
         *   关掉之后它走 manual 分支，把 latent 节点的宽高接成 `%width%` / `%height%`，
         *   再由 `buildVars` 填我们这两个数 —— 这正是「尺寸跟 GAL 走」的实现路径。
         *   （工作流里写死数字的宽高也会被这一步改成变量，否则改不动。）
         */
        resSelector: { ...(be.resSelector || {}), enabled: false },
      },
    },
  };
}

/**
 * ③ 打开绘灵设置面板 —— GAL「插件设置」按钮要求的第三个方法（v0.9.168）。
 *
 * ★ 为什么它是必需的：GAL 的 `open-dbgen-settings` 分支写的是
 *     `!Xe || typeof Xe.openManagement != "function"
 *        ? (状态行 = "未检测到数据库生图插件，请确认已安装并启用。")
 *        : await Xe.openManagement()`
 *   也就是说**只缺这一个方法**，它就会认定整个插件没装 ——
 *   用户 2026-10-30 截图里那句「未检测到数据库生图插件」就是这条。
 *   判定发生在按钮点击时，与 `generate` / `generateSinglePrompt` 无关，
 *   所以之前一直「能出图但报未检测到」，很容易误判成插件没挂上。
 */
export async function openManagement() {
  try {
    const m = await import('./ui/window.js');
    m.openWindow('gal');
    info(STAGE.GAL, 'GAL 请求打开插件设置 —— 已在绘灵面板「外部联动」页打开');
    return { ok: true };
  } catch (err) {
    warn(STAGE.GAL, `GAL 请求打开插件设置失败：${err?.message || err}`);
    return { ok: false, error: `绘灵面板打不开：${err?.message || err}` };
  }
}

const API = Object.freeze({
  generateSinglePrompt: guard('prompt', '写词', generateSinglePrompt),
  generate: guard('image', '出图', generate),
  openManagement: guard('image', '打开设置', openManagement),
  /** 版本号 —— GAL 只在日志里用，缺了不影响，但给上便于它识别 */
  version: 2,
});

/**
 * 挂 / 摘 `window.NaiDbGen`。
 *
 * ★ 幂等：重复调用不会挂两份（GAL 的 loader 会反复注入，实测它会重新执行脚本）。
 * ★ **不抢占同名**：如果那个位置已经有别人的 `NaiDbGen`（用户真装了数据库生图插件），
 *   这里**不覆盖**，只记一条警告并把冲突报回调用方。
 *   理由：这个全局名是别人的，抢过来等于让对面插件静默失效，而且没有任何提示 ——
 *   用户只会看到「装了插件但 GAL 不认它」。
 * ★ 卸载只删「自己挂的那个引用」，任何时候都不会误删别人的入口。
 */
export function installGalBridge(cfg) {
  const c = cfg || getConfig();
  const g = c.galBridge || {};
  if (!g.enabled) return uninstallGalBridge();

  installedApi = API;
  const hosts = hostsOf();
  const conflicts = [];
  let n = 0;
  for (const host of hosts) {
    try {
      const cur = host[GAL_ENTRY_NAME];
      if (cur && cur !== API) {
        conflicts.push(host === globalThis ? 'globalThis' : 'window');
        continue;
      }
      host[GAL_BRIDGE_KEY] = { version: API.version, at: Date.now() };
      host[GAL_ENTRY_NAME] = API;
      n += 1;
    } catch { /* 跨域 / 只读对象：跳过 */ }
  }

  if (conflicts.length) {
    warn(STAGE.GAL,
      `检测到 ${conflicts.join(' / ')} 上已经有别的 ${GAL_ENTRY_NAME}（多半是数据库生图插件）—— 绘灵没有覆盖它。`
      + '若要让 GAL 用绘灵出图，请先禁用那个插件再回来开启本开关。');
  }
  if (n) {
    info(STAGE.GAL, `GAL 桥已挂载（${n} 个宿主对象都以 ${GAL_ENTRY_NAME} 暴露，写词+出图两个接口齐备）`);
  }
  return { ok: n > 0, hosts: n, conflicts };
}

export function uninstallGalBridge() {
  let n = 0;
  for (const host of hostsOf()) {
    try {
      if (installedApi && host[GAL_ENTRY_NAME] === installedApi) {
        delete host[GAL_ENTRY_NAME];
        n += 1;
      }
      if (host[GAL_BRIDGE_KEY]) delete host[GAL_BRIDGE_KEY];
    } catch { /* 忽略 */ }
  }
  installedApi = null;
  if (n) info(STAGE.GAL, `GAL 桥已卸载（清理 ${n} 个宿主对象）`);
  return { ok: true, cleared: n };
}

/** 面板 / 控制台用：现在是不是挂着的 */
export function galBridgeStatus() {
  const cfg = getConfig();
  const g = galConfig(cfg);
  let live = 0;
  for (const host of hostsOf()) {
    try { if (host[GAL_ENTRY_NAME] === installedApi && installedApi) live += 1; } catch { /* 忽略 */ }
  }
  return {
    enabled: !!g.enabled,
    mounted: live > 0,
    hosts: live,
    output: activeOutput(),
    canvas: currentCanvas(),
    /** 面板开关的当前值（老配置里没有时由 galConfig 补默认） */
    useGalArtist: !!g.useGalArtist,
    canvasSource: g.canvasSource,
    /** 外貌听谁的：huilin = 绘灵角色档案（默认），gal = GAL 的【角色设定】原样透传 */
    appearanceSource: g.appearanceSource,
    /** 上一次实际替换了几个角色的外貌（0 要能在面板上说清原因，不能只显示开关值） */
    lastLookStats: lastLookStats && lastLookStats.at ? { ...lastLookStats } : null,
    /** 服装听谁的：gal = GAL 的 wardrobe DNA（默认），huilin = 绘灵档案那一整行 */
    outfitSource: g.outfitSource,
    lastOutfitStats: lastOutfitStats && lastOutfitStats.at ? { ...lastOutfitStats } : null,
    /** GAL 接管期间是否仍按正文更新服装态（只写档案，不写图位） */
    outfitScan: g.outfitScan !== false,
    /** 尺寸对齐的倍数（MOSS 分桶在 16 的倍数上，不对齐会漂） */
    multiple: (() => {
      const m = Number(cfg.backends?.comfyui?.resSelector?.multiple);
      return m > 0 ? m : 16;
    })(),
    /**
     * 最近一次调用（成功/失败都给），面板上直接显示 —— 用户不用开控制台。
     * 优先内存，其次**配置里持久化的那条**（刷新页面后仍然看得到上次失败）。
     */
    lastCall: lastCall || g.lastCall || null,
    /**
     * GAL 上一次带来的角色与当前衣装（从持久化的 lastInput 解析）。
     * 这是绘灵唯一能看到「GAL 那边衣服换成什么了」的窗口 —— 不猜，只摊原文。
     *
     * ★ v0.9.181：优先解析 `lastCastText`（单独存的设定段）。老配置 / 这次没给设定段时
     *   回落到 `lastInput` —— `parseGalCast` 自身要求含 `【角色设定】` 标记，
     *   所以拿时间线字符串喂进去也只会得到空数组，不会瞎猜出人来。
     */
    cast: parseGalCast(g.lastCastText || g.lastInput || ''),
    /**
     * GAL 这次的**【角色设定】段原文**（`''` = 它压根没给，不是绘灵没读到）。
     * ★ 面板要靠它回答「为什么改了外貌没生效」—— 源头空的时候，
     *   再怎么调绘灵这边的开关都不会有变化。
     */
    castText: String(g.lastCastText || ''),
    /**
     * GAL 上次在 description 里要的构图尺寸（「画面是横的，宽1216，高832」）。
     * ★ 摊出来是为了让用户一眼看出「它要横的、我出的是竖的」——
     *   否则这种不匹配在日志里只表现为两串数字，没人会去比。
     */
    descCanvas: lastDescCanvas && (Date.now() - lastDescCanvas.at < 5 * 60 * 1000)
      ? { width: lastDescCanvas.width, height: lastDescCanvas.height }
      : (parseGalCanvasFromDesc(g.lastInput || '') || null),
    /**
     * 本楼（最近几批）写词结果 + 最近一次实际送图的词。
     * ★ 这是用户唯一能「看见字」的地方 —— GAL 的文件里存了，但没有界面入口。
     */
    promptLog: Array.isArray(g.promptLog) ? g.promptLog : [],
    lastPaint: g.lastPaint || null,
  };
}
