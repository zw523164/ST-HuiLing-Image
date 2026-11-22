/**
 * 绘灵 · 一致性引擎
 *
 * 这是"人物不会随便偏移"的实现处。它干五件事：
 *
 *   ① renderLibraryText —— 把档案库渲染成给 AI 看的字段式清单（带 [locked] 标记）
 *   ② applyChanges      —— 应用 AI 报的变化：逐字段 merge、锁定保护、状态位校验
 *   ③ effectiveOf       —— 查询"某个段落时刻"的角色状态（位置门控）
 *   ④ expandRefs        —— @角色名 展开成完整锚点串
 *   ⑤ healAnchors       —— 锚点体检：hair/eyes 缺失就补上（最后一道防线）
 *
 * 位置门控为什么必须做：
 *   一张图插在 P2，它就代表 P2 那一刻。P5 才换的衣服不能出现在 P2 的图里。
 *   这是定位引用的思路，绘灵把它扩展到了服装层。
 */

import {
  getConfig,
  getActiveTemplate,
  activeEngine,
  activeNsfw,
  K2_PHOTOREAL_ANCHOR,
  ANCHOR_FIELDS,
  ANCHOR_FIELD_LABEL,
  DYN_FIELDS,
  DYN_FIELD_LABEL,
  OUTFIT_STATES,
  OUTFIT_STATE_LABEL,
  REQUIRED_ANCHORS,
  APPEAR_STATE_FIELDS,
  APPEAR_STATE_LABEL,
  DYNAMIC_FIELD_KEYS,
  STATE_OWNED_FIELD_KEYS,
  EMPTY_SENTINELS,
  SD_ONLY_FIELDS,
  scopeOfField,
  countTagOf,
  activeOutput,
} from './settings.js';
import { normalizeLayout, layoutConfigured, segmentOn } from './promptLayoutCore.js';
import { compileLayout, layoutToLine } from './mossJsonLayout.js';
import {
  buildMangaPage, isMangaDraft, describeMangaLayout, mangaLayoutOf, mangaDraftCast,
  wrapBubble, lineCountOf, BUBBLE_MAX_CHARS,
} from './mossMangaPage.js';
/** v0.9.186：漫画台原生口径（照搬 AINIMA 漫画台，措辞逐字一致） */
import { compileMangaPage } from './mossMangaNative.js';
import { estimateResolution } from './resSelector.js';
import { stateDetailOf, modOf, shoesOf } from './outfitStateLibrary.js';
import { outfitStateFact, OUTFIT_REMOVED_BARE } from './outfitStateFacts.js';
import { hairStateOf, smudgeOf, stripHeadwearFromStyle } from './appearanceLibrary.js';
import {
  buildLibrarySnapshot,
  upsertEntry,
  mergeDyn,
  updateOutfit,
  resolveOutfitStyle,
  mergeCastEntries,
  autoOutfitDimsOn,
} from './store.js';
import { oneLine, tidySeparators, tidySeparatorsKeepLines, dedupeTag, clone, styleDetailScore, normalizeAnchorFields } from './util.js';
import { warn, info, STAGE } from './log.js';
import { fixSdOutfit } from './outfitTagFix.js';
import { fixSdCompose, auditSdComposeOnce } from './sdComposeFix.js';
import { fixTagClusters } from './tagClusterFix.js';
import { cleanTag, stripMacros, stripMacrosKeepLines } from './protocol.js';

/* ============ 阶段 ①：库文本 ============ */

export function renderOutfitLine(o, dyn, opts = {}) {
  const text = resolveOutfitStyle(dyn) || o?.style || '';
  const state = o?.state || 'intact';
  /**
   * v0.9.39：服装机开着却没记录 → 显式占位，不再静默跳过。
   *
   * 旧版这里是 `if (!text && state==='intact') return ''`，后果是：没记过服装的角色，
   * 档案行里连"服装"两个字都没有 —— 模型读到的是"此人无服装"，于是每轮凭正文现编一个。
   * 实测 22 楼里 13 楼有明确服装描写、dyn 却是 0 条，这一行静默是漂移链条的关键一环。
   * 补上占位后，扫描器与主分析都知道这条缺、需要去正文里取。
   */
  const bare = String(o?.bare || '').trim();
  const removed = state === 'removed';
  // removed 且没记服装时不能静默跳过（同 v0.9.39 的理由）：那等于告诉模型"此人无服装"
  if (!text && state === 'intact' && !bare && !getConfig().consistency?.outfitMachine) return '';
  const label = OUTFIT_STATE_LABEL[state] || state || '完好';
  const lockTag = o?.lockLevel === 'strict' ? '［款式冻结］' : '';
  const presetTag = o?.preset ? `［预设:${o.preset}］` : '';
  /**
   * v0.9.45：裸露锚点进档案文本，让主分析模型也看得见。
   * removed 时 style 是**已经脱掉的那件衣服**（留着做历史依据），画面上不能照写 ——
   * 所以显式标出「已褪下，画面不写这件」，避免模型把档案里的 style 当成当前穿着。
   */
  const bareTag = bare ? `；裸露=${bare}` : '';
  /**
   * ★★★ v0.9.132：`removed` 必须**两种情形都给硬指令**。
   *
   * 旧代码是 `removed && text ? '…已褪下（画面不要再写这件）' : ''` —— 只有「记着那件衣服」时
   * 才提醒。而男主夜斗的 `style` 已被清空（`removed` + `completely nude`），于是这句话**不出现**，
   * 档案行只剩 `服装=(已褪下)／裸露=completely nude`。
   *
   * 后果（2026-10-22 楼 190）：模型同时收到 spec 的「可见衣着是必需项」＋
   * §4.3 的「`naked` 不许单独出现」，无可折中 → 给他挂了一件敞着的衬衫，
   * 出图就是 `his dark shirt hanging open at the front`。用户原话：「明明男主身上没用服装了但是还是莫名出现」。
   * 有款式时说的是「别写这件」；没款式时要说的是「**任何衣物都别写**」—— 两者语义不同，不能共用一句。
   */
  const removedTag = removed
    ? (text
      ? '；已褪下（画面不要再写这件）'
      : '；已全部褪下，画面不许出现**任何**衣物名词，改写成裸露状态与体液/痕迹')
    : '';
  /**
   * v0.9.69：三维度要让主分析模型**看得见**，否则它每轮只能凭正文现编，
   * 又会回到"每楼重新描述一遍"的漂移链条。SFW 下这些值不进画面词，但档案行照常显示。
   */
  const detailTag = o?.stateDetail ? `；细档=${o.stateDetail}` : '';
  const modTag = o?.mod ? `；改造=${o.mod}` : '';
  const shoesTag = o?.shoes ? `；鞋袜=${o.shoes}` : '';
  /**
   * ★★★ v0.9.133：**一个字段说完整**（NAI 口径：穿搭 DNA + 已生效变化）。
   *
   * 旧格式是三个同级标签并列：
   *   `服装=…／服装状态=半褪(parted)／裸露=pink and white skirt bunched up around her waist, …`
   * 病历（2026-10-22 楼 202，用户报「女主服装完全漂移没了」）：
   *   档案里 `服装=` 只出现**一次**，而 `裸露=` 那段自由文本有 20 多词、并且只描述
   *   「裙子卷在腰上、大腿露出」——**不含**「粉色和白色女仆装」。MOSS 编码器是词频即权重，
   *   于是模型把「裸露」当成服装状态来写：`white apron pushed up over her chest` +
   *   `a white lace-trimmed blouse bunched at her collarbone`，整体款式（maid outfit / 粉色）被挤掉。
   *   ⇒ 主品类必须**紧跟在 `服装=` 后面**，状态与裸露退进括号当附注，不能并列抢权重。
   *
   * 对 removed 角色同样成立：`服装=(已全部褪下)` 是主值，`裸露=completely nude` 是附注，
   * 后面再跟一句硬指令（`removedTag`）。
   */
  const attrs = [`服装状态=${label}(${state})`];
  /**
   * ★★★ v0.9.135：状态位 → **名词性可见事实**（判据见 modules/outfitStateFacts.js 头部）。
   *
   * 病历（2026-10-22，八张真实出图）：把「半褪」写成
   *   `skirt pushed up around her waist`（关系句）→ A/B/C 三版全没画出来，
   *   和完好态对照图几乎分不出来；写成 `bunched into a band around her waist, her belly and hips bare`
   *   才真的画出「裙子堆在腰上」。
   * 全裸同理：`服装=(已全部褪下)` 会被模型补出一套深蓝围裙 + 黑丝；
   *   `no clothing at all, completely bare, bare breasts and bare belly…` 才真画出裸体。
   *
   * ⇒ 这件事**不该交给模型表达**（它只会写关系句），而该由渲染层直接给名词事实 ——
   *   插件手里本来就有确定的状态位。位置必须**紧跟款式**（`服装=<款式>, <事实>`）：
   *   只写部件、丢掉整体品类名，会让颜色与品类当场漂移（实测 G 版粉色丢失）。
   */
  const stateFact = outfitStateFact(text, state, { skip: !!o?.stateDetail, sex: opts.sex });
  const mainOutfit = text || (removed ? (stateFact || OUTFIT_REMOVED_BARE) : '(未记录)');
  const factTail = (text && stateFact) ? ', ' + stateFact : '';
  return `服装=${mainOutfit}${factTail}`
    + `（${attrs.join('；')}${presetTag}${bareTag}${detailTag}${modTag}${shoesTag}）`
    + `${removedTag}${lockTag}`;
}

/** 单个条目渲染成一行：字段式明细 + 锁定标记。 */
export function formatEntryLine(item) {
  const { name, entry, dyn, locked } = item;
  const parts = [];
  const f = entry?.fields || {};
  for (const k of ANCHOR_FIELDS) {
    if (f[k]) parts.push(`${ANCHOR_FIELD_LABEL[k]}=${f[k]}`);
  }
  for (const [k, v] of Object.entries(f)) {
    if (ANCHOR_FIELDS.includes(k)) continue;
    /**
     * ★★★ v0.9.132：状态机管的键**不从这里出**（见 settings.STATE_OWNED_FIELD_KEYS）。
     *
     * 病历（2026-10-22 楼 190）：静态库里残留的 `服装状态=intact` / `状态=bent forward…`
     * 会和下面 `renderOutfitLine` 与 `dyn.fields` 的**真值**同时出现在一行里，
     * 变成「同一事实两套说法，模型只挑一条听」——用户报的「服装串/跟不上」即此。
     * 静态库只存跨轮不变的东西；会变的由动态层独家渲染。
     */
    if (STATE_OWNED_FIELD_KEYS.includes(k)) continue;
    /**
     * ★★ v0.9.132：口径归属也要在这条路径上生效。
     *
     * `FIELD_SCOPE` 早就声明了 `nlProfile: { k2: 'render', sd: 'drop' }`，
     * 但**只有 `anchorOf`（898 行，画面词路径）执行了它**，档案行这里是无差别全打印。
     * 后果（MOSS/Layout 下尤其明显）：模型自己写 character caption，
     * 插件又把整段 `nlProfile` 复述一遍 —— 正是「重复＝实体复制」，
     * 还夹着互相矛盾的旧描述（实测西园寺爱丽莎那条同时有 `crow's feet` 与 `petite body`，
     * 而 anchors 是 `tall, curvy, huge breasts`），并且白吃 system 额度。
     *
     * 只跳过 `drop`：`count`（sex → 人数词）在档案行里仍要显示成「性别=」，
     * 用 `!== 'render'` 会把它一起吞掉。
     */
    if (scopeOfField(k, activeEngine()) === 'drop') continue;
    parts.push(`${k}=${v}`);
  }

  const o = dyn?.outfit;
  const outfitLine = renderOutfitLine(o, dyn, { sex: f.sex });
  if (outfitLine) parts.push(outfitLine);

  // v0.9.70 外貌状态层：让 AI 在库文本里看得到「现在是什么状态」，才谈得上判断要不要更新
  const ap = dyn?.appear || {};
  const apParts = [];
  if (ap.hairState) apParts.push(`发状态=${ap.hairState}`);
  if (ap.makeupSmudge) apParts.push(`花妆=${ap.makeupSmudge}`);
  if (apParts.length) parts.push(apParts.join('／'));

  const d = dyn?.fields || {};
  /**
   * ★★★ v0.9.132：全裸角色的 `condition` 里，**描述他自己衣物的子句一律剥掉**。
   *
   * 病历（2026-10-22 楼 190 · 男主夜斗）：`outfit.state=removed` + `bare=completely nude`，
   * 但 `condition` 写着 `erect penis exposed through open trousers` ——
   * 同一行里「已全部褪下」和「从敞开的裤子里露出」互相打脸，模型挑了后者，
   * 出图就是 `his dark shirt hanging open at the front`。用户原话：
   * 「明明男主身上没用服装了但是还是莫名出现，关键正文里没有写男主服装描述」。
   *
   * 判据（可机械判定，不靠模型自觉）：
   *   ① 只在 `state=removed` 时生效 —— 半褪(parted) 的衣服本来就该挂在身上，不动；
   *   ② 按子句切，含衣物名词的子句才考虑；
   *   ③ **明确指向对方**的子句保留 —— `one hand on her waist pulling the apron ribbon loose`
   *      里的 apron 是女主身上的，那是动作对象，剥了会丢关键互动信息；
   *   ④ 指向自己 / 判不出归属 → 删（宁可少写一句姿态，也不能让画面长出一条裤子）。
   */
  const sexOf = String(f.sex || f.gender || '');
  for (const k of DYN_FIELDS) {
    if (!d[k]) continue;
    const val = k === 'condition'
      ? stripGarmentFromCondition(d[k], o?.state, sexOf)
      : d[k];
    if (val) parts.push(`${DYN_FIELD_LABEL[k]}=${val}`);
  }
  for (const [k, v] of Object.entries(d)) {
    if (DYN_FIELDS.includes(k)) continue;
    parts.push(`${k}=${v}`);
  }

  const label = entry?.label ? `(${entry.label})` : '';
  const lockTag = locked ? ' [locked]' : '';
  return `- ${name}${label}${lockTag}: ${parts.join(', ') || '(无记录)'}`;
}

/**
 * 库文本：整份拼进请求，AI 看得到当前真值，画面 tag 照抄可见字段。
 * @param {Array} snapshot 不传则现抓
 */
export function renderLibraryText(snapshot) {
  const list = snapshot || buildLibrarySnapshot();
  if (!list.length) return '';
  const hasLocked = list.some(x => x.locked);
  const head = [
    '【角色档案库】',
    '[插件维护的当前真值。画面 tag 必须照抄以下字段值；不要重新概括、不要用近义词替换。',
    hasLocked ? '标记 [locked] 的条目属于用户设定，禁止为它产生任何 change，画面里原样照抄。' : '',
    '服装状态位只能前进：intact(完好) → parted(半褪) → undone(解开) → removed(褪下)；swapped(已换) 表示换成新衣服。',
    // v0.9.39：档案行里出现「服装=(未记录)」是**缺**的意思，不是一种衣服。
    // 不明说，模型会把这三个字当真值照抄进 tag（实测这类占位最容易被当成描述词）。
    '服装=(未记录) 表示这个角色还没有服装记录 —— 不要照抄，请从本楼正文里读出他此刻的穿着，用 changes 的 outfit 字段报上来。]',
  ].filter(Boolean).join('');
  return `${head}\n${list.map(formatEntryLine).join('\n')}`;
}

/* ============ 阶段 ②：应用变化 ============ */

function parseOrder(position) {
  const m = /^P?(\d+)$/.exec(String(position || '').trim());
  return m ? Number(m[1]) : null;
}

/**
 * 应用 AI 返回的 changes。
 *
 * @param {Array} changes [{ name, kind:'new'|'set'|'state', position, fields }]
 * @param {object} opts { round, snapshot, cfg }
 * @returns {{applied:Array, rejected:Array, positional:Array, snapshot:Array}}
 */
/**
 * 款式充分性检查 —— 治「一件校服换了好几个版本」的头号手段。
 *
 * 原理：`white school uniform` 这类笼统描述，在模型眼里每次都会被重新诠释一遍，
 * 自然每张图都不一样。这不是"记忆"能解决的，必须把描述细化到可复现。
 * 所以这里对过于笼统的款式给出**明确警告 + 怎么补**，而不是默默接受。
 *
 * 只对"像制式服装"或"短到离谱"的提示，避免对 `bare feet` 这种正常状态唠叨。
 */
function hintOutfitDetail(name, dyn) {
  if (!getConfig().consistency?.outfitDetailHint) return;
  const text = resolveOutfitStyle(dyn);
  if (!text) return;
  const score = styleDetailScore(text);
  if (score >= 5) return;
  const looksUniform = /uniform|school|suit|blazer|nurse|sailor|kimono|armor|robe|dress|costume/i.test(text);
  if (!looksUniform && score >= 3) return;
  warn(STAGE.CONSISTENCY,
    `${name} 的服装描述过于笼统（${score} 个元素）：「${text}」—— 这是服装款式漂移的头号主因。`
    + '建议补全六要素：主色/质地 + 领型 + 结或领带 + 上衣 + 下装 + 袜鞋；'
    + '或到「服装预设」里建一套可复用的命名款式（如「夏季校服」），以后直接引用。');
}

/**
 * 外貌状态层落库（v0.9.70）。
 *
 * ★★ 过关条件只有一个：值必须命中外观库里的档名。
 *   命中 → 存**规范档名**；不命中 → 丢弃并记一条警告。
 *   这叫「允许更新，不允许漂移」—— 剧情可以让头发湿掉、让妆花掉，
 *   但不能每楼发明一种新写法（那种写法进去两次，模型就开始学习了）。
 *
 * ★ 注意这里**故意不过 D4 硬校验**：状态层就是要能被剧情改的。
 */
function commitAppearState(name, raw, round = 0) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const clean = {};
  for (const k of APPEAR_STATE_FIELDS) {
    if (!(k in src)) continue;
    const v = String(src[k] ?? '').trim();
    if (!v) { clean[k] = null; continue; }   // 显式清空
    const hit = k === 'hairState' ? hairStateOf(v) : (k === 'makeupSmudge' ? smudgeOf(v) : null);
    if (hit) {
      clean[k] = hit.k;
    } else {
      warn(STAGE.CONSISTENCY,
        `角色「${name}」的${APPEAR_STATE_LABEL[k] || k}报了一个不在库里的值「${v.slice(0, 24)}」—— 已忽略。`
        + '状态层只认外观库里的档名，防的就是「每楼换一种写法」的措辞漂移。');
    }
  }
  if (Object.keys(clean).length) mergeDyn(name, { appear: clean }, round);
  return clean;
}

export function applyChanges(changes, opts = {}) {
  const cfg = opts.cfg || getConfig();
  const cons = cfg.consistency || {};
  const round = Number(opts.round) || 0;
  let snapshot = opts.snapshot || buildLibrarySnapshot();

  const applied = [];
  const rejected = [];
  const positional = [];

  /**
   * lockedMap 是"本楼开始前的锁定状态"。
   * 刻意不用 live 查询：本楼新建的角色会往这里登记，但整批 changes 处理完之前
   * 不去重抓 snapshot —— 因为 snapshot 代表「本楼之前的状态」，是位置门控的基线。
   * 中途重抓会让基线变成"本楼之后"，先出现的图片就会用上后面才发生的变化。
   */
  const lockedMap = new Map((snapshot || []).map(x => [x.name, !!x.locked]));

  if (!cons.enabled || !Array.isArray(changes)) {
    return { applied, rejected, positional, snapshot };
  }

  for (const raw of changes) {
    const name = oneLine(raw?.name);
    if (!name) continue;

    const kind = ['new', 'set', 'state', 'merge'].includes(raw?.kind) ? raw.kind : 'set';

    /* ---- 情况 M：AI 判定同人 → 归并（v0.9.50） ----
     * 模型读正文发现「两个叫法指同一人」（括号互注 / 同句换称 / 真名揭露）时，
     * 报 {name:<保留名>, kind:'merge', from:<被并名>}，插件执行归并。
     * 判断在模型（有正文上下文，比机械发色比对可靠），执行在插件（to 优先只补空缺）。 */
    if (kind === 'merge') {
      const from = oneLine(raw?.from);
      const r = mergeCastEntries(from, name);
      if (r.ok) {
        info(STAGE.CONSISTENCY, `同人归并完成：「${from}」→「${name}」`
          + `（补字段 ${(r.movedFields || []).join('、') || '无'}`
          + `${r.outfitFrom ? '，款式取自被并方' : ''}，搬服装历史 ${r.historyMoved || 0} 条）`);
        applied.push({ name, kind: 'merge', from, movedFields: r.movedFields });
        lockedMap.delete(from);
      } else {
        rejected.push({ name, kind: 'merge', reason: `合并失败：${r.reason}` });
      }
      continue;
    }
    const order = parseOrder(raw?.position);
    // 先归一化（实测模型会把眼镜塞进 face、瞳色塞进 hair）—— 搬运记录进日志
    const norm = normalizeAnchorFields(raw?.fields);
    if (norm.moved.length) {
      warn(STAGE.CONSISTENCY, `${name} 的锚点字段已自动归位：${norm.moved.join('；')}`);
    }
    const fields = norm.fields && typeof norm.fields === 'object' ? norm.fields : {};

    // 拆字段：锚点字段 / 服装 / 动态字段 / 外貌状态层
    const anchorPatch = {};
    const dynPatch = {};
    const appearPatch = {};
    let outfitPatch = null;

    for (const [k, v] of Object.entries(fields)) {
      const key = String(k).trim();
      const val = oneLine(v);
      // v0.9.45：outfitBare 允许空值 —— 空串表示"不再裸露了"，是一条**有意义的清空指令**，
      // 不能跟着其他字段一起被 `!val` 跳过（跳过了 bare 就永远清不掉，角色会一直裸下去）。
      if (!val && key !== 'outfitBare') continue;
      if (ANCHOR_FIELDS.includes(key)) anchorPatch[key] = val;
      else if (key === 'outfit') {
        // `outfit: "@夏季校服"` 也能引用预设 —— 比要求模型输出额外字段更自然
        const v2 = String(val).trim();
        if (v2.startsWith('@')) outfitPatch = { ...(outfitPatch || {}), preset: v2.slice(1).trim() };
        else outfitPatch = { ...(outfitPatch || {}), style: v2 };
      } else if (key === 'outfitState') {
        const st = String(val).toLowerCase().trim();
        outfitPatch = { ...(outfitPatch || {}), state: st };
      } else if (key === 'outfitPreset') {
        // 指向「服装预设库」里的命名款式：@夏季校服 → 夏季校服
        outfitPatch = { ...(outfitPatch || {}), preset: val.replace(/^@/, '').trim() };
      } else if (key === 'outfitBare') {
        // v0.9.45：裸露部位（脱掉之后 outfit 里不该再留那件衣服，改由这个字段表达）
        outfitPatch = { ...(outfitPatch || {}), bare: val };
      } else if (key === 'outfitDetail' || key === 'outfitMod' || key === 'outfitShoes') {
        /**
         * v0.9.72 · 服装三维度（状态细档 / 改造 / 鞋袜）。
         *
         * 主分析通道（changes）也认这三个字段 —— 服装扫描是写入主力，
         * 但出词模型在 changes 里顺手报了的话同样该生效，两处口径必须一致。
         *
         * ★ 关着时**整个丢弃**（连 outfitPatch 都不进）：不给模型写权限就是不给，
         *   留着只是让它在诊断里制造"我明明写了"的噪音。
         */
        if (autoOutfitDimsOn()) {
          const k = key === 'outfitDetail' ? 'stateDetail' : key === 'outfitMod' ? 'mod' : 'shoes';
          outfitPatch = { ...(outfitPatch || {}), [k]: String(val ?? '').trim() };
        }
      } else if (key === 'redress') {
        // 「重新穿好」—— 放行状态位回退（默认只进不退）。模型可能给布尔也可能给字符串
        outfitPatch = { ...(outfitPatch || {}), redress: /^(true|1|yes)$/i.test(String(val).trim()) };
      } else if (APPEAR_STATE_FIELDS.includes(key)) {
        /**
         * v0.9.70 · 外貌状态层。
         * ★ 不能落 anchorPatch —— 那会把它当成人设，被 D4 硬校验锁死，
         *   「头发湿了 / 妆花了」就永远生效不了（这正是分层的目的）。
         */
        appearPatch[key] = String(val ?? '').trim();
      } else if (DYN_FIELDS.includes(key)) dynPatch[key] = val;
      else anchorPatch[key] = val; // 自定义锚点扩展字段
    }

    const found = lockedMap.has(name) ? { name, locked: lockedMap.get(name) } : null;

    /* ---- 情况 A：库里没有这个角色 ---- */
    if (!found) {
      if (kind !== 'new' && kind !== 'set') {
        rejected.push({ name, kind, reason: '档案库里没有该角色，且变化类型不是 new' });
        continue;
      }
      if (!Object.keys(anchorPatch).length) {
        rejected.push({ name, kind, reason: '新角色但没有提供任何静态锚点字段（hair/eyes 等）' });
        continue;
      }
      upsertEntry(name, { fields: anchorPatch, label: raw.label, source: 'scan' }, { round });
      // v0.9.50：建档查重警告（只警告不自动合并）—— 群像卡里发色瞳色雷同的真不同人
      // 一抓一把（韩家四姐妹），自动合并是数据污染；重复建档至少各是各的，人工删掉即可。
      // 真实病例（2026-09-30）：同一人被建成「隔壁太太」「结城美惠」「结城太太」三条，
      // 服装各演化各的，用户改哪条另外两条都不跟。
      const dupTwin = (snapshot || []).find((x) => {
        if (!x || x.name === name || x.locked) return false;
        const f = x.entry?.fields || {};
        const same = (k) => f[k] && anchorPatch[k]
          && String(f[k]).toLowerCase() === String(anchorPatch[k]).toLowerCase();
        return same('hair') && same('eyes');
      });
      if (dupTwin) {
        warn(STAGE.CONSISTENCY, `疑似重复建档：「${name}」与已有档案「${dupTwin.name}」的 hair/eyes 完全一致。`
          + `若是同一人（换叫法 / 真名揭露），请到「角色档案」删掉多余那条 —— 同一人存两条档案，`
          + `服装和外貌各存一份、互相打架，改哪条另一条都不跟`);
      }
      if (outfitPatch) {
        const r0 = updateOutfit(name, outfitPatch.style, outfitPatch.state, round, {
          preset: outfitPatch.preset,
          bare: outfitPatch.bare,
          redress: outfitPatch.redress === true,
          floor: Number(opts.floor) || 0, // v0.9.48 删楼回滚
          stateDetail: outfitPatch.stateDetail, mod: outfitPatch.mod, shoes: outfitPatch.shoes, // v0.9.72 三维度
        });
        if (r0.ok) hintOutfitDetail(name, r0.dyn);
      }
      if (Object.keys(dynPatch).length) mergeDyn(name, { fields: dynPatch }, round);
      commitAppearState(name, appearPatch, round);

      positional.push({
        name, order: 0, kind: 'new',
        fields: anchorPatch,
        dynFields: dynPatch,
        outfit: outfitPatch,
      });
      applied.push({ name, kind: 'new', fields: anchorPatch });
      lockedMap.set(name, false);
      continue;
    }

    /* ---- 情况 B：库里有，检查锁定保护 ---- */
    const cons2 = cfg.consistency || {};
    const lockLevel = cons2.lockLevel || 'normal';
    if (found.locked && cons2.lockedProtected && lockLevel !== 'off') {
      const touchAnchor = Object.keys(anchorPatch).length > 0;
      const touchOutfit = !!outfitPatch;

      if (lockLevel === 'strict' && (touchAnchor || touchOutfit || kind !== 'state')) {
        rejected.push({ name, kind, reason: `[locked] 条目在 strict 模式下只接受 state 类临时状态` });
        continue;
      }
      if (lockLevel === 'normal' && touchAnchor) {
        rejected.push({
          name, kind,
          reason: `[locked] 条目禁止改动外貌锚点（${Object.keys(anchorPatch).join('/')}）—— 这是用户主权区，需要改请在档案编辑器里手动解锁`,
        });
        continue;
      }
    }

    /**
     * D4 · 静态锚点硬校验（v0.9.67 · 用户勾选）
     *
     * 豆包方案里那条「输出后比对档案原文，不一致就重请求」的**轻量等价实现**：
     * 静态锚点是只读档案，模型报的值与档案已有值冲突时，直接用档案原文覆盖，
     * 而不是再花一次 LLM 调用去重请求 —— 效果相同（模型改写无效），成本为零。
     *
     * ★ 为什么必须加（spec 里早就写了"跨楼层永不改变、字段照抄"，
     *   但那只是**提示词里的软要求**，模型照改不误时没有任何一道闸拦它）：
     *   固定外貌是角色的身份证，被改写一次就等于换人；用户手填的发色瞳色
     *   被模型悄悄润色掉，往往要过好几楼才看得出来。
     *
     * 例外：档案里该字段为空 → 采纳模型值（那是首次补全，不是改写）。
     *       用户自己改档案走 upsertEntry 的另一条路径，不受这里影响。
     */
    /**
     * ⚠️ 别用 `found` —— 它只是 `{name, locked}` 的锁状态壳子，没有字段。
     * 真正的档案条目在 snapshot 里（每项带 entry.fields）。
     */
    const snapItem = (snapshot || []).find((x) => x && x.name === name);
    const curFields = snapItem?.entry?.fields || {};
    const anchorOverridden = [];
    for (const k of Object.keys(anchorPatch)) {
      const cur = oneLine(curFields[k]);
      if (!cur) continue;                       // 档案没记过 → 首次补全，采纳
      const same = String(cur).toLowerCase() === String(anchorPatch[k]).toLowerCase();
      if (same) {
        // 内容等价但写法不同 → 仍用档案原文，保住用户手填的书写（大小写/空格不该被模型改写）
        anchorPatch[k] = cur;
        continue;
      }
      anchorOverridden.push(
        `${ANCHOR_FIELD_LABEL[k] || k}：模型报「${anchorPatch[k]}」→ 沿用档案「${cur}」`);
      anchorPatch[k] = cur;
    }
    if (anchorOverridden.length) {
      warn(STAGE.CONSISTENCY, `${name} 静态锚点被模型改写，已用档案原文覆盖：${anchorOverridden.join('；')}`);
    }

    /* ---- 情况 C：正常应用 ---- */
    const entryRecord = { name, kind, fields: anchorPatch, dynFields: dynPatch, outfit: outfitPatch, order };

    if (Object.keys(anchorPatch).length) {
      // kind=state 不允许写锚点（避免临时状态污染静态库）
      if (kind === 'state') {
        rejected.push({ name, kind, reason: 'state 类变化不能写静态锚点字段' });
      } else {
        upsertEntry(name, { fields: anchorPatch, source: 'scan' }, { round });
      }
    }
    if (Object.keys(dynPatch).length) mergeDyn(name, { fields: dynPatch }, round);
    commitAppearState(name, appearPatch, round);

    if (outfitPatch) {
      const res = updateOutfit(name, outfitPatch.style, outfitPatch.state, round, {
        preset: outfitPatch.preset,
        bare: outfitPatch.bare,
        redress: outfitPatch.redress === true,
        floor: Number(opts.floor) || 0, // v0.9.48 删楼回滚
        stateDetail: outfitPatch.stateDetail, mod: outfitPatch.mod, shoes: outfitPatch.shoes, // v0.9.72 三维度
      });
      if (!res.ok) {
        rejected.push({ name, kind, reason: res.reason, drift: res.drift });
        entryRecord.outfit = null;
      } else {
        hintOutfitDetail(name, res.dyn);
      }
    }

    const effectiveOrder = kind === 'new' ? 0 : (order == null ? 0 : order);
    entryRecord.order = effectiveOrder;
    positional.push(entryRecord);
    applied.push({ name, kind, fields: { ...anchorPatch, ...(outfitPatch || {}) }, order: effectiveOrder });
  }

  if (rejected.length) {
    for (const r of rejected) {
      warn(STAGE.CONSISTENCY, `拒绝变化：${r.name} — ${r.reason}`);
    }
  }
  return { applied, rejected, positional, snapshot };
}

/* ============ 阶段 ③：位置门控查询 ============ */

/**
 * 查询某角色在第 lineIndex 段时刻的完整状态。
 *
 * 基线**只**来自 snapshot（= 本楼之前的状态），刻意不查 live 库：
 * 本楼新建的角色在 snapshot 里不存在，它的锚点完全由 positional 中 order=0 的
 * new 补丁提供；如果把 live 库当基线，先出现的图片就会用上后面才发生的变化。
 * positional 里 order===0 的（new / 未声明位置的）视为全楼生效。
 */
export function effectiveOf(name, snapshot, positional, lineIndex = Infinity) {
  const base = (snapshot || []).find(x => x.name === name);

  const entry = base
    ? { ...clone(base.entry), fields: { ...(base.entry?.fields || {}) } }
    : { name, fields: {}, identity: {}, label: '', locked: false, source: 'transient' };

  const dyn = base?.dyn
    ? clone(base.dyn)
    : { fields: {}, outfit: { style: '', state: 'intact', history: [] } };
  if (!dyn.fields) dyn.fields = {};
  if (!dyn.outfit) dyn.outfit = { style: '', state: 'intact', history: [] };

  for (const p of positional || []) {
    if (p.name !== name) continue;
    if (p.order !== 0 && p.order > lineIndex) continue;
    if (p.fields) Object.assign(entry.fields, p.fields);
    if (p.dynFields) Object.assign(dyn.fields, p.dynFields);
    if (p.outfit) dyn.outfit = { ...dyn.outfit, ...p.outfit };
  }
  return { entry, dyn };
}

/** 本楼涉及的全部角色名（库里的 + 本楼新建的）。 */
function namesOf(snapshot, positional) {
  const set = new Set((snapshot || []).map(x => x.name));
  for (const p of positional || []) set.add(p.name);
  return set;
}

/** 状态位 → 可绘英文提示。 */
/**
 * 状态位 → 画面词。
 *
 * ⚠️ 这里的措辞直接决定画面尺度，实测踩过坑：
 *   原来 `undone` 用的是 `clothing unfastened, unbuttoned` —— 单独的 `unbuttoned`
 *   在 Krea2 里被理解成「完全敞开」，直接画出裸露。而 `undone` 的语义只是
 *   「解开了扣子、衣服还穿在身上」，差了两档。
 *
 * 所以措辞原则：**加不定量词 + 保留衣物在场的描述**。
 *   partly / partially / collar open / still on —— 让模型知道"衣服还在"。
 *   避免裸用 unbuttoned / undressed 这类会被放大的词。
 */
export function outfitStateHint(state) {
  switch (state) {
    case 'parted': return 'clothes partially slid down, sleeves slipping';
    case 'undone': return 'shirt partially unbuttoned, collar open, buttons undone';
    case 'removed': return 'clothes removed, undressed';
    case 'swapped': return '';
    default: return '';
  }
}

/**
 * 从 style 里剥掉鞋袜片段（v0.9.69 · B3）。
 *
 * ★ 为什么必须剥：A1 服装库（v0.9.68）里大量条目自带鞋袜 ——
 *   例如「夏季校服」= `…white knee-high socks, brown loafers`。
 *   独立鞋袜档再追加一句 → 脚上出现两套 → 重复＝实体复制（本项目头号崩图机理）。
 *
 * ★ 为什么用「按逗号切段 + 段内匹配」而不是全局正则替换：
 *   全局删会把 `thigh-high slit`（高开衩，跟袜子无关）这类含相同词根的片段一起吃掉。
 *   段级判定只在**整段确实是鞋袜**时才删，误伤面小得多。
 *
 * ⚠️ `thigh-high` / `knee-high` 后面**必须带 s**（写成 thigh-highs 这种名词用法）
 *    才当鞋袜 —— 写成 `thigh-high slit`（高开衩）时 high 后面没有 s，不吃。
 *    实测第一版写成 `thigh-highs?`（s 可选）当场把「高开衩」整段删掉了。
 *    `thigh-high stockings / socks / boots` 由后面的鞋袜词命中，不需要靠 high 单数匹配。
 */
const SHOES_SEG_RE = /\b(?:socks|stockings|thigh-highs|knee-highs|pantyhose|tights|boots|booties|heels|stilettos?|pumps|loafers|flats|sandals|sneakers|shoes|footwear|anklets|garter|bare\s+feet)\b/i;

export function stripShoesFromStyle(style) {
  const s = String(style || '').trim();
  if (!s) return '';
  const kept = s.split(',').map(x => x.trim()).filter(Boolean)
    .filter(seg => !SHOES_SEG_RE.test(seg));
  return kept.join(', ');
}

/**
 * 锚点段的同形归一键。
 *
 * 目标：让 `twintails` / `twin tails` / `twin_tails` 这类**同形异写**判为同一个，
 * 从而只保留首次出现的那个。做法是把分隔符（下划线、连字符、空格）全部抹掉再比。
 *
 * ⚠️ 不做同义词归并 —— 那是猜，猜错就是删掉用户有意保留的人设（人设主权区铁律）。
 */
function anchorSegKey(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[_—–\-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.,;:!?'"、，。；：！？]+$/g, '')
    .replace(/\s+/g, '');
}

/**
 * BREAK 行形态的**统一兜底**（v0.9.113）。
 *
 * 为什么需要它（哪怕上游已经修过）：链路上按逗号切分再 `join(', ')` 的地方有十几处
 * （`cleanTag` / `dedupeAnchorSegments` / `dedupeTag` / 各 stage 的 trim 收尾…），
 * 任何一处漏了都会把 BREAK 前面的 `\n` 当空白 `trim` 掉 ⇒ BREAK 贴着逗号 ⇒
 * 下游 `split(/\n\s*BREAK\s*\n/)` 匹配不到 ⇒ **三段塌成一段** ⇒ 双人串台。
 * 逐个去修容易漏，所以在最终出口再做一次幂等整形：把任何形态的 BREAK
 * 统一成「独立成行、前后无逗号」的规范形态。
 *
 * 幂等：`normalizeBreakLines(normalizeBreakLines(x)) === normalizeBreakLines(x)`。
 *
 * @param {string} text
 * @returns {string}
 */
export function normalizeBreakLines(text) {
  const s = String(text ?? '');
  if (!/\bBREAK\b/.test(s)) return s;
  const segs = s.split(/\s*\bBREAK\b\s*/).map((p) => p.replace(/^[\s,]+/, '').replace(/[\s,]+$/, '').trim());
  const kept = segs.filter(Boolean);
  if (!kept.length) return '';
  return kept.join('\nBREAK\n');
}

/**
 * 去掉**用户手工拼的全局前缀 / 后缀**（v0.9.115）。
 *
 * 用户 2026-10-20 明确拍板：
 *   「multi view 不要管，我局外加的前缀不需要你管，我不想用可以自己删，你主要管主体的。
 *     像这种我自己手动拼的前后缀和全局你不需要管他。」
 *
 * ⇒ 全局前缀 / 后缀是他自己的**风格开关**（宫格 / 画风 / 画质词），不是插件该评价的对象。
 *   `multi view` 会不会导致每个视图各画一套身体，那是他选宫格时自担的事，插件不插嘴。
 *
 * 做法：按 tag 级剔除（不是按子串），只影响**体检用的副本**，不动送去出图的 `prompt`。
 *
 * @param {string} text
 * @param {string} prefix 全局前缀（逗号分隔）
 * @param {string} suffix 全局后缀（逗号分隔）
 * @returns {string} 剔除后的主体串（BREAK 形态统一为 `\nBREAK\n`）
 */
export function stripGlobalParts(text, prefix, suffix) {
  const drop = new Set();
  for (const src of [prefix, suffix]) {
    for (const t of String(src || '').split(',')) {
      const k = t.trim().toLowerCase();
      if (k) drop.add(k);
    }
  }
  const raw = String(text ?? '');
  if (!drop.size) return raw;
  return raw.split(/\s*\bBREAK\b\s*/)
    .map((seg) => seg.split(',').map((x) => x.trim()).filter((x) => x && !drop.has(x.toLowerCase())).join(', '))
    .filter(Boolean)
    .join('\nBREAK\n');
}

/**
 * 锚点段级去重（v0.9.94）。
 *
 * 输入 `"blonde hair, twintails, twin tails, curvy"` → 输出 `"blonde hair, twintails, curvy"`。
 *
 * ★ 为什么只去重不去"精简"：服装 / 外貌 tag 天然会长（用户 2026-10-18 明确：
 *   「有的人物外貌服装 TAG 需要很长」）。插件能安全删的只有**同形重复**，
 *   必要的服装与外貌项一个都不能动 —— 削错了就是人设丢失。
 *
 * ★ v0.9.113：**必须先按 BREAK 切段再各自去重**。
 *   旧实现 `split(',') + trim + join(', ')` 会把 BREAK 前换行当空白吃掉
 *   （`'dark,\nBREAK\n1girl'` → `'dark, BREAK 1girl'`），整串塌成一段。
 *   这个函数只在「超长（> maxTagLength×2）」时才跑 ⇒ 表现为**时好时坏的吞 BREAK**，
 *   极难复现 —— 用户报的「最近楼层还是不行 / BREAK 又被吞了」就包括这条。
 *
 * @param {string} text 逗号分隔的 tag 串
 * @returns {string} 去重后的串（保持首次出现顺序）
 */
export function dedupeAnchorSegments(text) {
  const raw = String(text || '');
  if (/\bBREAK\b/.test(raw)) {
    const parts = raw.split(/\s*\bBREAK\b\s*/);
    if (parts.length > 1) {
      return parts.map((p) => dedupeAnchorSegments(p)).filter(Boolean).join('\nBREAK\n');
    }
  }
  const segs = raw.split(',').map((s) => s.trim()).filter(Boolean);
  const seen = new Set();
  const out = [];
  for (const s of segs) {
    const k = anchorSegKey(s);
    if (!k) continue;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
  }
  return out.join(', ');
}

/* ==================== v0.9.94 · tag 下划线 → 空格 ==================== */

/** 保护区占位符（私有区字符，不会与任何真实文本冲突；源码里是转义写法，不落 NUL）。 */
const SAFE_MARK = '\uE000';

/**
 * 把提示词里「tag 内部的下划线」换成空格（用户 2026-10-17 实测规范）。
 *
 * ★ 依据（本机 CLIP 分词器实测，非经验推断）：
 *   `long_hair` → `long` `_` `hair`（3 token）｜`long hair` → `long` `hair`（2 token）
 *   Qwen/K2 系更差：`_hair` 不在词表，会被拆成 `_h` + `air`。
 *   下划线**不是粘合剂**，它插进了一个无语义 token，白占 77 token 预算。
 *
 * ★ 保护区（内部下划线是语法的一部分，动了就调用失败）—— 见规范 §五：
 *   `<lora:名:权重>` / `<lyco:...>` / `embedding:名` / 文件路径 / 工作流参数键名 `%xxx%`
 *   做法：先把这些片段整段抠出来占位，替换完再原样塞回去。
 *
 * @param {string} text
 * @returns {string}
 */
export function normalizeTagSpaces(text) {
  const s = String(text || '');
  if (!s || !s.includes('_')) return s;
  const safe = [];
  const keep = (m) => `${SAFE_MARK}${safe.push(m) - 1}${SAFE_MARK}`;
  const masked = s
    .replace(/<[^<>]*>/g, keep)                                        // <lora:...> / <lyco:...>
    .replace(/embedding:\s*[^\s,]+/gi, keep)                           // embedding:xxx_v2
    .replace(/%[^%\n]*%/g, keep)                                       // %工作流占位符%
    .replace(/\b[A-Za-z]:[\\/][^\s,]*|[\\/][^\s,]*\.(?:safetensors|ckpt|pt|pth|bin|gguf|onnx)\b/gi, keep); // 路径/文件名

  const out = masked
    .replace(/_+/g, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+,/g, ',')
    .replace(/,[ \t]{2,}/g, ', ');

  return out.replace(new RegExp(`${SAFE_MARK}(\\d+)${SAFE_MARK}`, 'g'), (m, i) => safe[Number(i)] ?? m);
}

/**
 * 给 SD 提示词的**每一段**补上结尾逗号（v0.9.107，用户 2026-10-19 要求）。
 *
 * 用户原话：「SD 模式下，就是每段提示词结尾，没有标点符号。」
 * 以前的输出是：
 *   `... dark, dim lighting`
 *   `BREAK`
 *   `1girl, black hair, ...`
 * 段与段之间靠 BREAK 断开，每段收尾连个逗号都没有 —— 贴到 ComfyUI 里看是一串
 * 断头的 tag 流，读起来也不像一条完整的正向提示词。
 *
 * ★ 必须在**所有清洗之后**调用：
 *   `tidySeparators` 里有 `,\s+ → ', '` 规则，段尾逗号一旦提前加进去，
 *   `,\nBREAK\n` 会被压成 `, BREAK\n` —— BREAK 就不再独立成行，分段直接失效。
 *   所以这里只做「最后一道」：按分隔符切开、逐段补逗号、按原样拼回去。
 *
 * @param {string} text    已清洗完的整串提示词
 * @param {object} [sdOpt] { breakSeparator }
 * @returns {string}
 */
export function withSegmentTrailingCommas(text, sdOpt = {}) {
  const s = String(text || '').trim();
  if (!s) return s;
  /** 已经有句读（逗号/句号）就不重复加 —— 模型自己写了就不要叠成 `,,` */
  const ensure = (p) => (/[,.]$/.test(p) ? p : `${p},`);

  // BREAK 没开时整串本来就是逗号连接的，补个句尾逗号即可（不存在"段"）
  if (sdOpt?.breakSeparator !== true) return ensure(s);

  const parts = s.split(/\n\s*BREAK\s*\n/).map(p => p.trim()).filter(Boolean);
  if (parts.length <= 1) return ensure(s);
  return parts.map(ensure).join('\nBREAK\n');
}

/** 空值哨兵：`none` / `无` / `-` 这类占位不是画面词（实测档案里 mark 被写成 "none"）。 */function isSentinelValue(v) {
  return EMPTY_SENTINELS.includes(String(v ?? '').trim().toLowerCase());
}

/**
 * ★★★ v0.9.145 · 体型字段的「可见事实化」：`body` 里的小胸/平胸要改写成形状。
 *
 * 只处理**往小压**这一档。理由与边界全部来自出图实测，不是推理：
 *
 * 病例（2026-10-28 · 催眠APP · 犬冢夏美）：档案 `body = petite, short, flat chest,
 * small breasts, toned`，正文写「校服上衣松垮、领口敞开、田径部」。出图四格全是
 * **大胸深沟** —— 用户主权区（人设）被模型自己的先验覆盖。
 *
 * 单变量 A/B（同 seed、同版式、同 cast、同 bg、同台词，只改 body 这一段）：
 *   before  `flat chest, small breasts`                              → 四格大胸
 *   after   `an almost flat boyish chest, no visible bust volume at all` → 四格压平
 * ⇒ 形容词压不住先验，必须写成**画面上看得见的形状**。
 *
 * ⚠️ 只做这一档，不推广：
 *   · 大胸 / 长腿 / 身高这几档，模型先验方向本来就与档案一致（没有对抗），
 *     加句只会多一段噪音；而且**这几档没有出图证据**，按纪律不许凭推理写进代码。
 *   · 不在 `formatEntryLine` 里做 —— 那是给模型看的「档案真值」，
 *     改在那里会让模型看到的值与存档不一致，反被它当成漂移。
 */
const SMALL_BUST_RE = /\b(?:flat[\s-]?chest(?:ed)?|small breasts?|no bust|a[\s-]?cup)\b/gi;
const SMALL_BUST_HAS = /\b(?:flat[\s-]?chest(?:ed)?|small breasts?|no bust|a[\s-]?cup)\b/i;
const SMALL_BUST_FACT = 'an almost flat boyish chest, no visible bust volume at all';

export function bodyFactOf(v) {
  const src = String(v ?? '').trim();
  if (!src || !SMALL_BUST_HAS.test(src)) return src;
  // 把原词剔除再补可见事实 —— 留着原词就是「同一事实两套说法」，模型只挑一条听。
  // ★ 必须按逗号切分重组：直接删词会留下 `petite, short, , , toned` 这种空段，
  //   空段本身会被模型当成一个词读（实测第一版就是这么出错的）。
  const rest = src.replace(SMALL_BUST_RE, '')
    .split(/[,，]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .join(', ');
  SMALL_BUST_RE.lastIndex = 0;
  return rest ? `${rest}, ${SMALL_BUST_FACT}` : SMALL_BUST_FACT;
}

/** 把状态合成为一段锚点串（英文 tag，可直接进画面）。 */
export function anchorOf(name, eff) {
  const parts = [];
  const f = eff?.entry?.fields || {};
  const engine = activeEngine();
  const isSdAnchor = engine !== 'k2';
  /** SD 输出开关（K2 不读 —— K2 禁写人数词，两代实现不共开关）。 */
  const sdOpt = isSdAnchor ? (getConfig().sdOptions || {}) : {};

  /**
   * v0.9.70 · 外貌状态层。先在这里取值，**发状态跟着 hair 走**（见下面循环里的注释）。
   * ★ 花妆走 NSFW 门禁（用户拍板「只有花妆三档走门禁」）；发状态（湿发/凌乱）SFW 也合理，
   *   下雨这种剧情在非 NSFW 卡里同样会出现。
   * ★ 旧存档没有 `dyn.appear` → 两者都是 null → 零影响。
   */
  const ap = eff?.dyn?.appear || {};
  const hState = hairStateOf(ap.hairState);
  const mSmudge = activeNsfw() ? smudgeOf(ap.makeupSmudge) : null;

  for (const k of ANCHOR_FIELDS) {
    /**
     * ★★ v0.9.96：`sex` 是**口径分叉点**，不是「漏输出」（用户 2026-10-18 定性）。
     *
     * 旧注释「性别由 tag 里的 1girl/1boy 表达」是 **K2 禁写人数词**（v0.9.65）的延伸：
     * K2 下模型会写人数声明 → 拼进去会变成 "1girl, 1girl"，所以跳过是对的。
     * 但 SD/danbooru 口径下**没有任何环节写人数词** ⇒ sex 有数据却永不输出，
     * 画面里没有人数声明（实测：催眠APP 双人帧 `1boy` 出现 0 次）。
     */
    if (k === 'sex') {
      if (isSdAnchor && sdOpt.countTags !== false) {
        const ct = countTagOf(f);
        if (ct) parts.push(ct);
      }
      /**
       * ★ v0.9.96：角色级 LoRA 触发词 —— SD 专属，**紧跟人数词**。
       * 顺序理由：`1girl, ilshinjouakane, black hair …` 让 LoRA 先认到本体再落外貌 tag；
       * 放在末尾实测会被外貌 tag 稀释（权重按位置衰减）。
       * 必须写在这里（sex 分支内），写到循环外就跑到外貌后面去了。
       */
      if (isSdAnchor && f.loraTrigger) {
        const lt = String(f.loraTrigger).trim();
        if (lt && !isSentinelValue(lt)) parts.push(lt);
      }
      continue;
    }
    // 空值哨兵（`none` / `无` / `-`）不是画面词 —— 实测档案里 mark 被写成 "none"
    // ★ v0.9.145：`body` 的小胸档走「可见事实化」（见 bodyFactOf 的实测依据）
    if (f[k] && !isSentinelValue(f[k])) parts.push(k === 'body' ? bodyFactOf(f[k]) : f[k]);

    /**
     * ★★ v0.9.110 · 发状态必须紧跟「发型发色」，不能甩到服装后面（用户报 2026-10-20）。
     *
     * 病例：提示词开头是 `blonde hair, twintails`，服装 `…, loafers` 之后又冒出
     * `glossy sleek hair`（发状态档「光泽垂顺」）。同一颗头被描述两遍，中间隔着整套衣服：
     *   - SD/danbooru 是**权重叠加**口径 → 模型当成"第二撮头发"，容易多出一缕 / 发质打架；
     *   - 语义上也读不通（衣服后面冒出一句头发）。
     * 发状态本质是发型描述的一部分（`hair falling smoothly` / `wet hair`），归位到 hair 之后。
     */
    if (k === 'hair' && hState?.en) parts.push(hState.en);
  }

  /**
   * v0.9.94 · 锚点瘦身（2026-10-18）。
   *
   * 实测病例（催眠APP 楼层14）：锚点 919 字符 = **212 token**，占满 CLIP 前 3 块。
   * 而 `comfy/sd1_clip.py:49` 的 `first_pooled = pooled[0:1]` 决定**全局语义只取第 1 块**，
   * 结果前 77 token 全是外貌碎片 —— 出图整体调性被锁成「金发双马尾少女肖像」，
   * `sex / vaginal / thrusting` 全被挤到第 279-309 token（第 4 块）→ 用户看到「和剧情完全不搭」。
   *
   * 四条削减，全部是做减法、不猜同义词：
   *   ① SD 口径下剔除 `nlProfile` —— 那是 **K2 自然语档案**（整句英文），
   *      ShadedHex 规范 §六明确「把它当成 K2 自然语言长句写」是坑，IL 是 danbooru tag 口径。
   *      实测这一条就占 62 token，且它把 hair/eyes/face/body 又复述了一整遍。
   *      K2 口径保留（那边有 k2AnchorParts 单独渲染，此处行为不变）。
   *   ② 类型守卫 —— 旧代码对自定义字段无差别 push，`spec` 这类**对象**会被拼成 `[object Object]`。
   *   ③ 段级同形去重 —— `twintails` / `twin tails` 这类同形异写只留首次出现（重复＝实体复制）。
   *   ④ ★ v0.9.96 **动态字段排除** —— 实测病例（《雾津市播种计划！》）：档案里模型自造了
   *      中文键 `状态` / `情绪` / `state`，内容是**上一楼的性行为动作与表情**。
   *      旧代码只跳过 nlProfile ⇒ 上一楼的动作被永久钉进「跨轮次永不改变」的静态锚点，
   *      之后每张图都带着并与新动作叠加。这是「档案互串」最严重的一处。
   */
  for (const [k, v] of Object.entries(f)) {
    if (ANCHOR_FIELDS.includes(k)) continue;
    if (SD_ONLY_FIELDS.includes(k)) continue;                      // 已在上面按口径单独处理
    if (scopeOfField(k, engine) !== 'render') continue;            // ① nlProfile(SD) / loraTrigger(K2)
    if (typeof v !== 'string' && typeof v !== 'number') continue;  // ② 挡住 spec / identity 等对象
    if (sdOpt.excludeDynamic !== false
      && DYNAMIC_FIELD_KEYS.some((d) => d.toLowerCase() === k.toLowerCase())) continue; // ④
    if (isSentinelValue(v)) continue;                              // 空值占位不是画面词
    parts.push(v);
  }

  const o = eff?.dyn?.outfit || {};
  // 预设优先：outfit 若引用了「服装预设」（如 @夏季校服），这里展开成完整描述
  const rawStyle = resolveOutfitStyle(eff?.dyn) || o.style || '';

  /**
   * v0.9.69 · 服装三维度（状态细档 / 改造 / 鞋袜）。
   *
   * v0.9.74 · 应用户要求放开 NSFW 门禁：三个维度在 SFW 普通模式也进画面
   *   （档案页选什么就用什么 —— 库档名都是明确的画面词，选保守档就是保守画面，
   *   尺度掌握在选档的人手里）。花妆（makeupSmudge）维持 NSFW 门禁不变。
   *
   * ★ 旧存档没有这三个字段 → 三者全为 null → 走回老路（旧 5 档 hint），零影响。
   *
   * ★ 非法档名（模型乱填）→ 库查找返回 null → 静默丢弃，不进画面（R7）。
   */
  const detail = stateDetailOf(o.stateDetail);
  const mod = modOf(o.mod);
  const shoes = shoesOf(o.shoes);
  /** replace 档自带完整穿着描述 → 整段替换 style；改造/鞋袜同时禁用（都全裸了不该还有靴子）。 */
  const replaced = detail?.mode === 'replace';

  /**
   * ★★ v0.9.98 · SD 口径的服装 / 裸露 —— 与 K2 **完全分开**的一条路
   *   （用户 2026-10-18：「SD 口径的服装和服装状态触发跟 K2 完全不同，需要另外一套只在 SD 下起作用的方案」）
   *
   * 为什么必须分开（实测取证，真实档案 月咏深雪 / state=removed）：
   *   旧代码 SD 锚点输出 = `…white customized school blouse…, short navy pleated skirt…,
   *   black thigh-high stockings, black leather pumps, clothes removed, undressed`
   *   —— **同时**说「穿着全套」和「已脱光」。SD 是 tag 叠加口径，模型只能随机选一个，
   *   实测表现就是「有时穿全套、有时全裸、有时衣服撕裂半挂」。
   *   更糟的是用户填在「裸露部位」的 `naked pussy, exposed breasts…` **一个字都没进提示词**
   *   —— 旧 SD 分支从头到尾没读过 `o.bare`（那段双向锚定只有 K2 的 outfitClauseFor 有）。
   *
   * 两口径的差别（这是"另起一套"的根本原因）：
   *   K2 用**句子**表达状态 —— 「衣服还在，只是被拉开」靠自然语，服装原样留着不会矛盾；
   *   SD 用**tag 叠加**表达 —— 叠上去就是"同时成立"，所以脱掉的必须从 style 里删掉、
   *   改写成裸露 tag，否则就是上面那种自相矛盾。
   *
   * 字段：`dyn.outfit.styleSd` / `bareSd`（SD 专用，K2 不读）。
   *   为空时回落 K2 的 style / bare —— 老档案不用重填也能改善（removed 已不再叠服装），
   *   同时给一次提示建议改成 tag 写法。
   */
  if (isSdAnchor) {
    const outfitState = String(o.state || 'intact').toLowerCase();
    const sdBare = String(o.bareSd ?? '').trim() || String(o.bare ?? '').trim();
    const sdStyleRaw = String(o.styleSd ?? '').trim() || rawStyle;

    /**
     * 回落提示：用 K2 的自然语长句当 SD 服装 tag 时，Illustrious 只能认出其中一部分
     * （`white customized school blouse with front buttons` 不是一个 danbooru tag）。
     * 每角色只提示一次，避免每楼刷屏。
     */
    if (!String(o.styleSd ?? '').trim() && sdStyleRaw && !SD_OUTFIT_WARNED.has(name)
      && /\b(?:with|and|wearing)\b/i.test(sdStyleRaw) && sdStyleRaw.length > 60) {
      SD_OUTFIT_WARNED.add(name);
      warn(STAGE.CONSISTENCY,
        `「${name}」的服装用的是 K2 自然语长句（${sdStyleRaw.slice(0, 42)}…）—— SD/Illustrious 只认短 tag，长句会被拆散、权重打折。建议在档案页「SD 服装 tag」里改写为逗号分隔的短 tag（如 white blouse, open shirt, pleated skirt）`);
    }

    if (replaced) {
      if (detail.en) parts.push(detail.en);
    } else if (outfitState !== 'removed') {
      // 还穿在身上的：先剥鞋袜/头饰（避免两套），再按裸露声明撤掉同部位的正常穿着
      let styleText = shoes ? stripShoesFromStyle(sdStyleRaw) : sdStyleRaw;
      if (eff?.entry?.spec?.hair?.acc) styleText = stripHeadwearFromStyle(styleText);
      /**
       * ★ v0.9.109 · 确定性归一必须跑在 `dedupeOutfitSlots` **之前**。
       *
       * 用户病例（2026-10-20）：SD tag 落库成 `over knee socks, black socks`。
       * 旧 dedupe 遇到同部位多条时保留**最后一条** → `black socks`（短袜）胜出、
       * 过膝袜被删 → 出图永远是短袜；而有的分支不走 dedupe，两条都进提示词，
       * 过膝偶尔抢到权重 → 用户看到「一下长袜一下短袜」。
       *
       * fixSdOutfit 先把腿袜按档位合并成一条 `black thighhighs`（颜色从被删那条继承），
       * 到 dedupe 手里已经没有同部位冲突可解，行为就稳定了。
       */
      styleText = fixSdOutfit(styleText).text;
      styleText = stripCoveredByBare(dedupeOutfitSlots(styleText), sdBare).style;
      if (styleText) parts.push(styleText);
      if (detail?.en) parts.push(detail.en);
      /** detail 是旧 5 档的细化，两者讲同一件事 → 有 detail 不再输出旧 hint。 */
      else {
        const hint = outfitStateHint(outfitState);
        /**
         * ★ SD 专有去重：style 自己已经写了「敞开 / 解开 / 露出」时不再叠状态 hint。
         *   实测病例：style 写 `fully unbuttoned and open`，hint 又补一句
         *   `shirt partially unbuttoned, collar open, buttons undone`
         *   —— 同一件事两遍（一处说全敞开、一处说部分解开）＝ 权重翻倍 + 语义打架。
         */
        const already = /\b(?:unbuttoned|open|undress|naked|topless|exposed|pulled\s+(?:down|up|off))\b/i.test(styleText);
        if (hint && !already) parts.push(hint);
      }
      if (mod?.en) parts.push(mod.en);
      if (shoes?.en) parts.push(shoes.en);
    } else {
      /**
       * removed：人身上已经没有这套衣服了。
       * ★ 这里**不再 push style**，也不再 push `clothes removed, undressed`
       *   —— 状态由下面真正的裸露 tag 表达；写两遍就是重复权重（本项目头号崩图机理）。
       * 三维度里的 mod / shoes 同理不写（都全裸了不该还穿着鞋）。
       */
      if (detail?.en) parts.push(detail.en);
    }

    /** 裸露 —— removed 且没有任何裸露记录时兜底，绝不留白（不写 = 默认模型给穿回去）。 */
    let skin = stripGarmentFromBare(sdBare, outfitState);
    if (!skin && outfitState === 'removed') skin = BARE_FALLBACK;
    if (skin) parts.push(skin);
  } else if (replaced) {
    if (detail.en) parts.push(detail.en);
  } else {
    // 有独立鞋袜档时先把 style 里的鞋袜剥掉 —— 否则脚上两套
    let styleText = shoes ? stripShoesFromStyle(rawStyle) : rawStyle;
    /**
     * v0.9.70 · 选了发饰时剥掉服装自带的帽子/头饰 —— 否则头上两件（C3）。
     * 「有没有选发饰」看 `entry.spec.hair.acc`（原始选择值），
     * 合成后的 hair 串已经混成一条，从那里认不出来。
     */
    const hasHeadAcc = Boolean(eff?.entry?.spec?.hair?.acc);
    if (hasHeadAcc) styleText = stripHeadwearFromStyle(styleText);
    if (styleText) parts.push(styleText);
    if (detail?.en) parts.push(detail.en);
    /**
     * detail 是旧 5 档的**细化**，两者讲的是同一件事（都是"褪下/敞开"）。
     * 同时注入 = 语义重复 → 有 detail 就不再输出旧 hint。
     */
    if (!detail?.en) {
      const hint = outfitStateHint(o.state);
      if (hint) parts.push(hint);
    }
    if (mod?.en) parts.push(mod.en);
    if (shoes?.en) parts.push(shoes.en);
  }

  /**
   * ★ v0.9.110：发状态（hState）已在上面跟着 `hair` 字段输出，这里**不再重复** ——
   *   否则就是「同一颗头描述两遍」（用户 2026-10-20 报的 `glossy sleek hair` 来源）。
   *   只有 hair 字段本身是空的（没人填发型）时才在尾部补一次，免得状态层整个丢失。
   */
  if (hState?.en && !parts.includes(hState.en)) parts.push(hState.en);
  if (mSmudge?.en) parts.push(mSmudge.en);

  const d = eff?.dyn?.fields || {};
  for (const k of ['condition', 'wound', 'mood', 'held']) {
    /**
     * ★★ v0.9.97：这一处**漏了开关判断**（2026-10-18 真机实证）。
     *   上面 ④「动态字段排除」只拦住了 `f`（静态档案字段）里的自定义键，
     *   而 condition / mood 这些是 `dyn.fields`（每楼更新的动态层）——
     *   旧代码无条件 push ⇒ 用户勾了「排除动态字段」，锚点里照样带着
     *   上一楼的 `sweating, heavily flushed, lost in pleasure, vacant expression`，
     *   然后被钉成「跨轮次不变」的静态锚点。
     *   只在 SD 口径下拦（K2 的动作走 cast 段，口径不同，动它风险大）。
     */
    if (isSdAnchor && sdOpt.excludeDynamic !== false
      && DYNAMIC_FIELD_KEYS.some((x) => x.toLowerCase() === k.toLowerCase())) continue;
    if (d[k]) parts.push(d[k]);
  }
  // ③ 段级同形去重：`twintails` / `twin tails`、`half-closed_eyes` / `half closed eyes`、
  //    `overwhelmed` 写两次这类同形异写只留首次出现（重复＝实体复制，本项目头号崩图机理）。
  //    ★ 只认**同形**，不猜同义词 —— `refined features` 与 `delicate facial features`
  //      是近义不是同形，插件无权替用户判定该删哪个。
  const joined = dedupeAnchorSegments(parts.join(', '));

  // 锚点应当全是画面词。默认（sd 口径）= 纯英文描述：
  // 实测踩坑：模型会把「状态位 / 服装 / 心情」写成中文塞进字段（如 "处于初级一般催眠中，意识主导权丧失"），
  // 上面几个 push 会把它整个搬进 tag，于是「tag 里不许有中文」被绕过 → K2 把中文当乱码。
  // K2 中英混合模版（engine=k2）下放行中文：用户实测「英文 tag + 中文自然语」遵循度最高，
  // 此时字段/自定义字段里写的中文自然语要能随锚点拼进画面词。
  const { tag, dropped } = cleanTag(joined, { allowCjk: activeEngine() !== 'sd' });
  if (dropped.length) {
    warn(STAGE.CONSISTENCY,
      `角色「${name}」有 ${dropped.length} 项档案字段是中文，当前清洗口径下已跳过：${dropped.slice(0, 2).join('、')}${dropped.length > 2 ? '…' : ''}（建议在档案里改写为英文，或切换到「K2 中英混合」模版放行中文）`);
  }
  return tidySeparators(tag);
}

/* ============ 阶段 ④：@引用展开 ============ */

/**
 * `@角色名` 的名字部分（紧跟在 @ 之后取，非全局、带 ^ 锚点）。
 *
 * 两段式：先吃普通名字字符，再吃「分隔符 + 至少 1 个名字字符」的片段。
 * 为什么分隔符要单独成组并要求后面跟字符 —— 直接把 `-` 塞进字符集的话，
 * `@夜斗-` 这种（模型写了连接号就被空格打断的）会把孤立连字符一起吃掉，
 * 名字变成「夜斗-」，照样匹配不上档案。
 *
 * v0.9.24 必须支持连字符的实测原因：用户档案里的角色叫「小精灵-菲」，
 * 旧正则字符集不含 `-` → 匹配到「小精灵」 → 库里没有 → 判为陌生人整段剥除。
 * 结果就是用户看到的现象：「画面里明明有 2 个人，男主有外貌锚定，小精灵完全没有」。
 */
const REF_NAME_RE = /^([\p{L}\p{N}_.·]*(?:[-‐-―][\p{L}\p{N}_.·]+)*)/u;

/** 名字内部允许的分隔符（与 REF_NAME_RE 同口径），用于「简称 → 全名」回退。 */
const REF_SEPS = ['-', '\u2010', '\u2011', '\u2012', '\u2013', '\u2014', '\u2015', '.', '_', '·'];

/** 酒馆宏标记（<user> 等）—— 用宏当角色名的档案条目是废条目，不许进人物段。 */
const NAME_MACRO_RE = /<(?:user|bot|char|persona|assistant|system)>/gi;

/**
 * 名字清洗：剥宏标记。返回空串说明这个名字本身就是宏/占位符。
 * 实测（2026-09-27）：模型会用 `<user>` 指代男角，档案里也可能出现名为 `<user>` 的条目；
 * 这种名字在最终提示词里会被宏清洗剥掉，只剩一个孤儿冒号（「：一位男性，…」）。
 */
export function cleanRefName(name) {
  return String(name ?? '').replace(NAME_MACRO_RE, '').trim();
}

/**
 * 把模型给的任意称呼解析成档案库里的正式角色名。
 *
 * 匹配顺序（宽进严出 —— 只在**唯一命中**时才采用，命中多个说明有歧义，
 * 宁可判陌生人也不猜，猜错就是给错的人套上错的外貌）：
 *   ① 正式名精确匹配（夜斗 → 夜斗）
 *   ② 昵称 / 显示名匹配（档案条目的 label）
 *   ③ 前后缀回退（小精灵-菲 ↔ 菲；模型爱写简称，库里存的是全名）
 *
 * @returns {string|null} 档案正式名；解析不出来返回 null
 */
export function resolveCastName(raw, snapshot, positional) {
  const wanted = String(raw ?? '').trim();
  if (!wanted) return null;
  const pool = [...namesOf(snapshot, positional)];
  if (pool.includes(wanted)) return wanted;

  // ② 昵称 / 显示名
  const byLabel = pool.filter((n) => {
    const eff = effectiveOf(n, snapshot, positional, Infinity);
    const label = String(eff?.entry?.label || '').trim();
    return !!label && (label === wanted || label.includes(wanted) || wanted.includes(label));
  });
  if (byLabel.length === 1) return byLabel[0];

  // ③ 前后缀回退（复合名 ↔ 简称）。边界必须是分隔符（- · _ .）——
  //    不加这条，「夜」会把「夜斗」也当成命中（单字名误配，套错外貌）。
  const isSep = (ch) => REF_SEPS.includes(ch);
  const byPart = pool.filter((n) => {
    if (n === wanted) return false;
    if (n.length > wanted.length) {
      if (n.startsWith(wanted) && isSep(n[wanted.length])) return true;
      if (n.endsWith(wanted) && isSep(n[n.length - wanted.length - 1])) return true;
      return false;
    }
    if (wanted.startsWith(n) && isSep(wanted[n.length])) return true;
    if (wanted.endsWith(n) && isSep(wanted[wanted.length - n.length - 1])) return true;
    return false;
  });
  if (byPart.length === 1) return byPart[0];

  return null;
}

/**
 * 全名不在库里时，从右往左按分隔符退，取**最长的已知名**。
 *
 * 为什么不直接判陌生人：模型写引用时会加后缀（`@小精灵-菲` 而库里只存了「小精灵」），
 * 一刀切剥除等于让这个角色彻底失去外貌锚定 —— 正是「小精灵被忽视」的直接后果。
 * 退到最短还认不出来，才交回全名让调用方按陌生人处理。
 * @returns {string} 要消费掉的名字（返回值一定在原文里完整存在，便于整段移除）
 */
function resolveRefName(greedy, known) {
  if (known.has(greedy)) return greedy;

  // ① 前缀退：模型写了全名 `@小精灵-菲` 而库里只存了「小精灵」
  const parts = String(greedy).split(/([-‐-―._·])/);
  for (let i = parts.length - 1; i >= 0; i -= 2) {
    const cand = parts.slice(0, i + 1).join('').replace(/[-‐-―._·]+$/, '');
    if (cand && cand !== greedy && known.has(cand)) return cand;
  }

  // ② 后缀退：模型写简称 `@菲` 而库里存的是全名「小精灵-菲」。
  //    只在**唯一命中**时才采用 —— 命中多个说明有歧义（比如两个角色都叫 X-菲），
  //    宁可按陌生人剥除也不猜，猜错就是给错的人套上错的外貌。
  const hits = [...known].filter(n => REF_SEPS.some(s => n.endsWith(s + greedy)));
  if (hits.length === 1) return hits[0];

  return greedy;
}

/**
 * 展开 tag 里的 @角色名。
 * 库里有的 → 换成该角色在该段落时刻的锚点串；
 * 库里没有的 → 剥掉（不把人名送进生图）；
 * 光秃秃的 @ → 剥掉（模型写漏了名字），并记录到 stray，让它触发后续的锚点自愈。
 *
 * v0.9.24 改为手工扫描而不是一次 replace：
 *   要在「匹配到更短已知名」时把**整段原文**（含尾巴）一起吃掉。
 *   例如库里只有「小精灵」而模型写 `@小精灵-菲`，若只替换掉前 3 个字，
 *   残留的「-菲」会掉进英文 tag 里变成噪声 token。
 *
 * K2 模式（opts.k2Cast，2026-09-26 v4 三明治）：
 *   @引用**不再原地展开成锚点串** —— 实测锚点串（逗号 tag 形式）拼进连贯英文句
 *   会把句子撕开、塞进一堆 tag，服装词还与句子里的描述重复，权重直接翻倍
 *   （用户截图实证：质量差 + 肢体扭曲）。
 *   K2 下 @引用只当「谁出场」的标记：记号剥掉、角色收集进 anchors，
 *   外貌由 k2CastParagraph 渲染成中文人物段，插到固定的结构位置。
 */
export function expandRefs(tag, snapshot, positional, lineIndex = Infinity, opts = {}) {
  const used = [];
  const unknown = [];
  const stray = [];
  const anchors = [];
  const known = namesOf(snapshot, positional);
  const src = String(tag || '');
  let text = '';
  let i = 0;

  while (i < src.length) {
    const ch = src[i];
    if (ch !== '@' && ch !== '＠') { text += ch; i += 1; continue; }

    const rest = src.slice(i + 1);
    const greedy = REF_NAME_RE.exec(rest)?.[1] || '';
    if (!greedy) {                     // 光秃秃的 @：模型写漏了名字
      stray.push('@');
      i += 1;                          // 剥掉，别把光杆符号送进生图
      continue;
    }
    i += 1 + greedy.length;            // 不管认不认得，整段引用都吃掉
    const name = resolveRefName(greedy, known);

    if (!known.has(name)) {
      if (!unknown.includes(name)) unknown.push(name);
      continue;
    }
    if (!used.includes(name)) used.push(name);
    const eff = effectiveOf(name, snapshot, positional, lineIndex);
    if (opts.k2Cast) {
      if (!anchors.some(a => a.name === name)) anchors.push({ name, eff });
      continue;                        // 剥掉记号；外貌走中文人物段
    }
    /**
     * ★ v0.9.96：必须补分隔符。
     * 旧代码 `text += anchorOf(...)` 直接粘 —— 模型写 `@A, @B` 时，
     * `@` 前面那个逗号被吃掉了，展开后变成 `<A锚点末词><B锚点首词>` 粘成一个烂 tag。
     */
    const at = anchorOf(name, eff);
    if (at) text += (text.trim() ? ', ' : '') + at;
  }

  return { tag: tidySeparators(text), used, unknown, stray, anchors };
}

/* ============ 阶段 ⑤：锚点体检与自愈 ============ */

const GENDER_RE = /\b(\d+(girl|girls|boy|boys))\b/i;

/**
 * 锚点体检。
 *
 * 情况一：用了 @引用 → 锚点已展开，天然带 hair/eyes，通过。
 * 情况二：没写 @引用 → 如果本楼该性别角色唯一，自动补上锚点；
 *         有多人/无法判断则记 warn，交给用户。
 *
 * K2 模式（opts.k2Cast）：自愈到的角色**不拼进 tag**，改收集进 anchors ——
 * 外貌统一走中文人物段（v4 三明治），tag 里只留服装与动作英文句。
 * 性别推断扩展：K2 协议的英文句写 `adult woman` / `adult man`（不是 1girl/1boy），
 * 所以补充 woman/man/female/male 词形。
 */
const K2_GENDER_RE = /\b(women|woman|girls?|female|lady)\b|\b(men|man|boys?|male)\b/i;

/** `1girl 1boy` / `2girls` / `two people` 这类数字人数声明。 */
const PEOPLE_NUM_RE = /\b(\d+)\s*(?:girls?|boys?|women|woman|men|man|people|persons?|figures?|females?|males?)\b/gi;
/** 没有数字、但明显是多人互动的说法（both / two … together / facing each other）。 */
const MULTI_HINT_RE = /\b(?:two|three|four|both|either)\b[^.,]{0,40}?\b(?:people|persons|figures|characters|girls?|boys?|women|men|of\s+them|each\s+other|together)\b/i;

/**
 * 这段 tag 看起来是「多人同框」吗？
 *
 * 存在的意义：画面里明明 2 个人、却只锚定了 1 个人的外貌时，另一个角色会变成
 * 「没有脸的随机路人」。这个状态在最终提示词里看不出来（外貌段只是少了一行），
 * 用户只会觉得「图崩了」，查不到原因 —— 所以要在 notes 里明确点出来。
 * 只做**检测与提示**，绝不自动补人：把没出场的人硬塞进人物段会直接造成
 * 多实体（1 男 + 2 精灵那种崩图），是比「缺锚定」更糟的失败。
 */
export function looksMultiPerson(tag) {
  const t = String(tag || '');
  let n = 0;
  for (const m of t.matchAll(PEOPLE_NUM_RE)) n += Math.max(1, parseInt(m[1], 10) || 1);
  if (n >= 2) return true;
  return MULTI_HINT_RE.test(t);
}

export function healAnchors(tag, snapshot, positional, lineIndex, usedNames = [], opts = {}) {
  const cfg = getConfig();
  const cons = cfg.consistency || {};
  if (!cons.anchorHeal) return { tag, healed: [], warned: [], anchors: [] };

  const healed = [];
  const warned = [];
  const anchors = [];
  let out = String(tag || '');

  const genderMatch = GENDER_RE.exec(out);
  let wantGirl = genderMatch ? /girl/i.test(genderMatch[0]) : true;
  if (!genderMatch && opts.k2Cast) {
    const m = K2_GENDER_RE.exec(out);
    if (m) wantGirl = Boolean(m[1]);           // 第一组命中 = 女性词形
  }

  // v0.9.25：候选池收窄。
  // 旧口径拿**整张卡的档案库**当候选池（buildLibrarySnapshot 返回 listCast 全量），
  // 只要卡片建了 2 个以上的档，自愈就永远触发「多个候选 → 放弃」—— 实测卡片建了 14 个档，
  // 场景里明明只有 2 人，日志却报「本楼有 14 个在场角色」（措辞还是错的，那不是在场，是全库）。
  // 现在调用方（pipeline）会把候选池收窄到「本楼正文提到过 / 分析器登记过变化」的角色；
  // 没传（旧调用 / 测试）才回退到全库。
  const present = Array.isArray(opts.presentNames) ? opts.presentNames.filter(Boolean) : null;

  const candidates = [];
  for (const name of namesOf(snapshot, positional)) {
    if (usedNames.includes(name)) continue;
    if (!cleanRefName(name)) continue;             // <user> 这类宏名条目是废条目
    if (present && present.length && !present.includes(name)) continue;
    const eff = effectiveOf(name, snapshot, positional, lineIndex);
    const f = eff.entry?.fields || {};
    // v0.9.24：只有自然语人设（nlProfile）也算有效候选。
    // 旧口径强制要求 hair+eyes 两个字段，结果「小精灵-菲」这类只填了一键提取人设的
    // 角色连自愈候选都进不去 —— 一旦模型漏写 @，它就彻底没有外貌锚定。
    // k2CastParagraph 本来就能从 nlProfile 单独渲染出人物段，没理由把它挡在门外。
    const hasPair = Boolean(f[REQUIRED_ANCHORS[0]] && f[REQUIRED_ANCHORS[1]]);
    const hasProfile = Boolean(String(f.nlProfile || '').trim());
    if (!hasPair && !hasProfile) continue;
    const sex = String(f.sex || '').toLowerCase();
    const matchGirl = sex.includes('girl') || !sex;
    if (wantGirl ? matchGirl : sex.includes('boy')) candidates.push({ name, eff });
  }

  if (usedNames.length === 0) {
    if (candidates.length === 1) {
      const target = candidates[0];
      const anchor = anchorOf(target.name, target.eff);
      if (anchor) {
        if (opts.k2Cast) {
          // K2：外貌进中文人物段，tag 保持纯英文句
          anchors.push({ name: target.name, eff: target.eff });
        } else {
          // 插在性别标记之后；没有性别标记就插到最前
          if (genderMatch) {
            out = out.replace(GENDER_RE, (m) => `${m}, ${anchor}`);
          } else {
            out = `${anchor}, ${out}`;
          }
        }
        healed.push(target.name);
      }
    } else if (candidates.length > 1) {
      const listed = candidates.slice(0, 3).map(c => c.name).join('、');
      warned.push(`画面没写 @引用，可候选的外貌又有 ${candidates.length} 个（${listed}${candidates.length > 3 ? '…' : ''}），插件不敢猜是谁 —— 已跳过自愈。请在提示词里写 @角色名，或在 images 里加 cast 字段点名（用档案里的准确名字）。`);
    } else {
      warned.push('档案库里没有可用于锚定的角色（既无 hair+eyes，也无自然语人设），无法自愈锚点——请先在档案编辑器里补全');
    }
  }

  // 长 tag 提醒（SD 的 tag 预算有限；K2 是句子结构且外貌已移出 tag，不适用）
  if (!opts.k2Cast) {
    const maxLen = cons.maxTagLength || 320;
    if (out.length > maxLen) {
      warned.push(`tag 长度 ${out.length} 超过建议上限 ${maxLen}，可能挤压 token 预算`);
    }
  }

  return { tag: out, healed, warned, anchors };
}

/* ============ K2 中文人物段（v4 三明治 · 2026-09-26） ============ */

/**
 * 单个角色的中文人物段素材 —— 只收**外貌与状态**，不收服装。
 *
 * 为什么不带服装：v4 定稿结构里服装由英文 tag 句逐件承担（LLM 照档案 outfit 值写），
 * 人物段再拼一遍服装就是重复权重（实测直接导致肢体扭曲）。
 * 外貌（hair/eyes/face/skin/body/mark）是档案主权区，必须机械注入、不经 LLM 的手。
 * ⚠️ 动态状态（condition/wound/mood/held）**不再拼进人物段**（2026-09-27 实测）：
 *   这些状态语是英文碎片（`hair slightly ruffled` / `startled and pouting`），
 *   拼在中文自然语后面就是「。；hair slightly ruffled；startled and pouting。」
 *   这种中英生硬拼接 —— 模型读不出归属，还会和英文 tag 里模型自己写的状态重复
 *   （实体复制机理 → 多手/多人）。状态由模型按剧情写进英文 tag 即可。
 */
function k2AnchorParts(eff) {
  const parts = [];
  const seen = new Set();
  const push = (v) => {
    const t = String(v ?? '').trim().replace(/[,，、;；]+$/, '');
    if (!t) return;
    const key = t.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    parts.push(t);
  };
  const f = eff?.entry?.fields || {};
  // 自然语外貌档案（nlProfile，中文自然语整段）优先 —— 用户在档案页一键生成或手写。
  // 有它就不再逐字段拼 tag（那正是「英文 tag 堆叠」崩坏感的源头）。
  const nlProfile = String(f.nlProfile || '').trim();
  if (nlProfile) {
    push(nlProfile);
    return parts;
  }
  for (const k of ['hair', 'eyes', 'face', 'skin', 'body', 'mark']) {
    if (f[k]) push(f[k]);
  }
  // 自定义锚点字段（不在标准清单里的）：照 anchorOf 的口径放行，但跳过 sex；
  // outfit 是服装文本 —— v4 结构里服装归英文 tag 句，人物段再拼一遍就是重复权重
  for (const [k, v] of Object.entries(f)) {
    if (['sex', 'hair', 'eyes', 'face', 'skin', 'body', 'mark', 'outfit', 'nlProfile'].includes(k)) continue;
    if (typeof v !== 'string' && typeof v !== 'number') continue;
    push(v);
  }
  // 动态状态（condition/wound/mood/held）不再拼进人物段 —— 英文碎片拼中文段
  // 生硬且与英文 tag 里的状态重复（实体复制 → 多手/多人）。见函数头注释。
  return parts;
}

/* ============ 自然语外貌档案（nlProfile）生成 ============ */

/**
 * 英文外貌 tag → 中文自然语的内置映射表。
 * 只做「翻译」不做「创作」—— 没收录的词原样保留（K2 的 Qwen 编码器英文也吃），
 * 绝不凭空添内容（人设主权区铁律）。
 * 匹配规则：tag 按逗号切项后，先试整项精确匹配，再试「包含最长词条」的子串替换。
 */
const NL_PROFILE_DICT = [
  // 性别 / 年龄身份（⚠️ 禁「成年」——「一位成年女性」实测让模型画老脸画壮体型，2026-09-27 定稿）
  ['girl', '女性'], ['woman', '女性'], ['female', '女性'],
  ['boy', '男性'], ['man', '男性'], ['male', '男性'],
  ['18 years old', '十八岁'], ['20 years old', '二十岁'], ['young adult', '年轻'],
  ['teen', '年轻'], ['mature', '成熟'], ['milf', '成熟的女性'], ['old woman', '年长的女性'], ['old man', '年长的男性'],
  // 发型发色
  ['black long hair', '黑色长直发'], ['long black hair', '黑色长发'],
  ['silver hair', '银白色长发'], ['silver white hair', '银白长发'],
  ['white hair', '白色头发'], ['blonde hair', '金色头发'], ['brown hair', '棕色头发'],
  ['black hair', '黑色头发'], ['long hair', '长发'], ['short hair', '短发'],
  ['loose low ponytail', '低马尾松松搭在脑后'], ['low ponytail', '低马尾'],
  ['twin tails', '双马尾'], ['twintails', '双马尾'], ['ponytail', '马尾'],
  ['wolf cut', '狼尾鲻鱼头'], ['mullet', '狼尾头'], ['wavy hair', '微卷的头发'],
  ['straight hair', '直发'], ['messy hair', '微乱的头发'], ['bob cut', '波波头'],
  // 眼睛
  ['large round almond-shaped eyes', '大而圆的杏眼'], ['almond-shaped eyes', '杏眼'],
  ['almond eyes', '杏眼'], ['golden eyes', '金棕瞳孔'], ['amber eyes', '琥珀色瞳孔'],
  ['brown eyes', '棕色眼睛'], ['black eyes', '深色眼睛'], ['blue eyes', '蓝色眼睛'],
  ['green eyes', '绿色眼睛'], ['slender eyes', '细长的凤眼'], ['upturned eyes', '眼尾微挑'],
  ['long eyelashes', '长睫毛'], ['half-lidded eyes', '半垂的眼帘'], ['drooping eyes', '下垂眼'],
  // 面容
  ['childlike face with baby fat', '稚气未脱的娃娃脸'], ['baby face', '娃娃脸'],
  ['childlike face', '稚气的脸'], ['young face', '年轻面容'], ['mature face', '成熟面容'],
  ['oval face', '鹅蛋脸'], ['round face', '圆脸'], ['delicate face', '精致五官'],
  ['bishounen', '俊美带阴柔感'], ['handsome', '俊秀'], ['pretty face', '清秀的面容'],
  ['freckles', '小雀斑'], ['blush', '易红晕的脸颊'],
  // 肤色
  ['fair skin', '白皙肌肤'], ['pale skin', '冷白皮'], ['porcelain skin', '瓷白肌肤'],
  ['tan skin', '小麦色肌肤'], ['dark skin', '深色肌肤'], ['olive skin', '橄榄色肌肤'],
  // 体型
  ['huge breasts', '丰满的巨乳'], ['large breasts', '丰满的胸部'], ['big breasts', '大胸'],
  ['medium breasts', '适中胸型'], ['small breasts', '娇小平胸'], ['flat chest', '平胸'],
  ['wide hips', '宽臀'], ['curvy figure', '曲线玲珑'], ['curvy', '曲线丰润'],
  ['slim', '纤细'], ['slender', '修长纤细'], ['plump', '体态丰腴'], ['chubby', '丰润微肉'],
  ['tall', '高挑'], ['petite', '娇小'], ['muscular', '肌肉结实'], ['athletic', '体格健美'],
  ['lean', '精瘦结实'], ['toned', '紧实体态'],
  // 标志特征
  ['black-framed glasses', '黑框眼镜'], ['black frame glasses', '黑框眼镜'],
  ['glasses', '眼镜'], ['scar', '疤痕'], ['tattoo', '纹身'], ['mole', '小痣'],
  ['beauty mark', '美人痣'], ['earrings', '耳饰'],
];

/**
 * 把单个英文 tag 项转成中文（词典 longest-match；未收录 → 原样保留）。
 */
function nlTranslateTag(item) {
  const t = String(item || '').trim();
  if (!t) return '';
  const lower = t.toLowerCase();
  // 整项命中（含修饰语顺序差异，做子串级 longest-match 兜底）
  let best = null;
  for (const [k, v] of NL_PROFILE_DICT) {
    if (lower === k) return v;
    if (lower.includes(k) && (!best || k.length > best[0].length)) best = [k, v];
  }
  if (best) {
    // 子串命中：只替换命中片段，保留其余修饰（如 "long black hair with blue streaks"）
    const re = new RegExp(best[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    return t.replace(re, best[1]);
  }
  return t;
}

/**
 * 从档案字段生成「自然语外貌档案」（nlProfile）文本 —— 档案页「一键生成」的引擎。
 *
 * 只做机械翻译：词典没收录的词原样保留（Qwen 双语都吃），绝不添加新设定。
 * 输出贴 v4 定稿风格：性别身份开头，各字段短语用中文逗号连接，字段间「；」。
 *
 * @param {Record<string,string>} fields 档案静态字段（sex/hair/eyes/face/skin/body/mark/自定义）
 * @returns {string} 自然语档案文本；没有任何可转换内容时返回 ''
 */
export function buildNaturalProfile(fields) {
  const f = fields && typeof fields === 'object' ? fields : {};
  const groups = [];
  // 性别身份放最前 + 外表年龄措辞（2026-09-27 定稿）：
  // ⚠️ 禁「成年」二字（「一位成年女性」实测让模型画老脸、画壮体型 —— 核心崩因）。
  // 按外表分三档：年轻 → 一位少女/少年；年长/成熟 → 一位成熟的女性/男性；其余 → 一位女性/男性。
  // sex 常被模型写成 tag 计数式（1girl / 2girls / 1boy）—— 单人档案里计数无意义，
  // 先剥掉数字与复数 s 再进词典，否则会产出「1女性」这种四不像。
  const sexRaw = String(f.sex ?? '').trim().replace(/^\d+\s*/i, '').replace(/(girls|boys)$/i, (m) => m.slice(0, -1));
  const sex = nlTranslateTag(sexRaw);
  if (sex) {
    const isMale = /男性|boy|male|man/i.test(sexRaw + sex);
    const look = [f.face, f.age, f.look].filter(v => v != null).map(v => String(v).toLowerCase()).join(' ');
    let lead = null;
    if (/young|teen|loli|少女|年轻|稚气|年幼/.test(look)) lead = isMale ? '一位少年' : '一位少女';
    else if (/mature|milf|御姐|熟女|年长/.test(look)) lead = isMale ? '一位成熟的男性' : '一位成熟的女性';
    groups.push(lead || `一位${sex}`);
  }
  for (const k of ['hair', 'eyes', 'face', 'skin', 'body', 'mark']) {
    const raw = String(f[k] ?? '').trim();
    if (!raw) continue;
    const parts = raw.split(/[,，、]+/).map(nlTranslateTag).filter(Boolean);
    if (parts.length) groups.push(parts.join('，'));
  }
  // 自定义字段（跳过结构性字段）：同样逐项翻译
  const known = new Set(['sex', 'hair', 'eyes', 'face', 'skin', 'body', 'mark', 'outfit', 'nlProfile']);
  for (const [k, v] of Object.entries(f)) {
    if (known.has(k)) continue;
    if (typeof v !== 'string' && typeof v !== 'number') continue;
    const raw = String(v).trim();
    if (!raw) continue;
    const parts = raw.split(/[,，、]+/).map(nlTranslateTag).filter(Boolean);
    if (parts.length) groups.push(`${k}：${parts.join('，')}`);
  }
  return groups.join('；');
}

/* ============ AI 翻译自然语档案（机械词典的上位方案，词典只作兜底） ============ */

/** 档案里能进自然语翻译的外貌字段（outfit 归英文段、nlProfile 是产物本身，都不送翻）。 */
const NL_PROFILE_SRC_FIELDS = ['sex', 'hair', 'eyes', 'face', 'skin', 'body', 'mark'];

/** 从 fields 里取出可翻译的「字段名: 值」清单（自定义字段也算，nlProfile/outfit 除外）。 */
export function nlProfilePayload(fields) {
  const f = fields && typeof fields === 'object' ? fields : {};
  const lines = [];
  for (const k of NL_PROFILE_SRC_FIELDS) {
    const v = String(f[k] ?? '').trim();
    if (v) lines.push(`${k}: ${v}`);
  }
  for (const [k, v] of Object.entries(f)) {
    if (NL_PROFILE_SRC_FIELDS.includes(k) || k === 'outfit' || k === 'nlProfile') continue;
    const s = typeof v === 'string' || typeof v === 'number' ? String(v).trim() : '';
    if (s) lines.push(`${k}: ${s}`);
  }
  return lines;
}

/**
 * 组 AI 撰写请求的 messages（喂给 callAnalyzeLLM 的格式）。
 * @param {Array<{name:string, fields:object, refs?:string}>} items 多角色一次请求（省请求数，风格统一）。
 *   refs = 该角色相关的角色卡/世界书原文片段（UI 层按角色名关键词检索），AI 从中提取外貌 ——
 *   这是「写完整自然语」的关键：字段常常只有寥寥几个 tag，设定细节在世界书里。
 * @param {{lang?:'zh'|'en'}} opts lang=输出语言（默认中文）。
 */
export function aiProfileMessages(items, opts = {}) {
  const lang = opts.lang === 'en' ? 'en' : 'zh';
  const list = (Array.isArray(items) ? items : [])
    .map(it => {
      const lines = nlProfilePayload(it?.fields);
      const refs = String(it?.refs || '').trim();
      if (!lines.length && !refs) return '';
      const head = `【${it.name}】`;
      const fieldPart = lines.length ? `已知字段：\n${lines.join('\n')}` : '已知字段：（无，以外貌参考资料为准）';
      const refPart = refs ? `\n外貌参考资料（来自角色卡/世界书，只从中提取外貌设定）：\n${refs}` : '';
      return `${head}\n${fieldPart}${refPart}`;
    })
    .filter(Boolean);
  if (!list.length) return null;
  const langRule = lang === 'en'
    ? '6. 描述全部用**英文**连贯句子（输出形如 "a young woman with long silver hair..."）。'
    : '6. 描述全部用**简体中文**自然语。';
  const example = lang === 'en'
    ? '   Example: Snow: a woman with long silver hair loosely tied in a low ponytail, amber eyes, fair skin, a mature curvy figure.'
    : '   例如：小雪：一位女性，银白色长发松松地挽成低马尾，金棕色瞳孔，白皙的皮肤，身材成熟丰腴。';
  const ageRule = lang === 'en'
    ? '5. 开头措辞按**外表年龄**写（直接决定出图的脸型与体型，很重要）：外表年轻 → "a young woman"（男 "a young man"）；外表年长/成熟风 → "a mature woman"（男 "a mature man"）；其余 → "a woman"（男 "a man"）。**禁止写 "adult woman / adult man"** —— 实测会让模型把脸画老、体型画壮。不要保留 1girl / 1boy 计数标记，不要写未成年。'
    : '5. 开头措辞按**外表年龄**写（直接决定出图的脸型与体型，很重要）：外表年轻 → 「一位少女」（男：一位少年）；外表年长/成熟风 → 「一位成熟的女性」（男：一位成熟的男性）；其余一律 → 「一位女性」（男：一位男性）。**禁止写「成年」二字** —— 实测「一位成年女性」会让模型把脸画老、体型画壮，是核心崩因。不要保留 1girl / 1boy 计数标记，不要写未成年。';
  return [
    {
      role: 'system',
      content: [
        '你是角色外貌档案撰写器。为用户给出的每个角色写一段**连贯的自然语外貌描述**（用于 AI 绘画的画面锚定）。',
        '输入 = 已知字段（可能只有寥寥几个词）+ 外貌参考资料（角色卡/世界书原文）。',
        '铁律（违反任何一条即任务失败）：',
        '1. 外貌内容**只能**来自已知字段与参考资料里明确写到的设定 —— 禁止编造、推测、补全任何未给出的信息（发色、瞳色、服饰、年龄都不许自己加）。',
        '2. 参考资料里的剧情、性格、经历、关系一律不要 —— 只提取**外貌**（发型发色、瞳色、脸型五官、肤色、体型胸型、眼镜痣疤等标志特征、气质印象）。',
        '3. **不写服装**（服装由别的通道负责，参考资料里的穿着描述也跳过）。',
        '4. 参考资料与已知字段冲突时，以已知字段为准。',
        ageRule,
        langRule,
        '7. 每个角色输出严格一行，格式：角色名：描述',
        '   描述是 2~5 句连贯的自然语（不是词的堆叠，不要用逗号罗列碎片词），按「身份 → 发型发色 → 瞳色眼神 → 脸型五官 → 肤色 → 体型 → 标志特征」的顺序组织，没有的维度直接跳过。',
        example,
        '8. 档案里没有的角色一行都不要多写；不要输出任何解释、思考过程或代码块标记。',
      ].join('\n'),
    },
    { role: 'user', content: list.join('\n\n') },
  ];
}

/**
 * 解析 AI 翻译回复 → { 角色名: 自然语文本 }。
 * 容错：剥代码块围栏、行首列表符；只收「名字：描述」行且名字必须在此批清单里
 * （防模型夹带解释行）；描述里的角色名本身不算添设定，保留。
 */
export function parseAiProfiles(reply, names) {
  const map = {};
  const text = String(reply || '').replace(/```[a-z]*\n?/gi, '').trim();
  if (!text) return map;
  const wanted = (Array.isArray(names) ? names : []).filter(Boolean);
  for (const rawLine of text.split('\n')) {
    const line = rawLine.replace(/^\s*[-*•\d.、)\]]*\s*/, '').trim();
    const m = /^([^：【】]{1,32})[：:]\s*(.+)$/.exec(line);
    if (!m) continue;
    const name = m[1].trim();
    const nl = m[2].trim();
    if (!nl) continue;
    const hit = wanted.find(n => n === name || name.includes(n) || n.includes(name));
    if (hit && !map[hit]) map[hit] = nl;
  }
  return map;
}

/**
 * AI 撰写自然语外貌档案（批量：一次请求处理多个角色）。
 * callLLM 由 UI 层注入（callAnalyzeLLM）—— 本模块不直接依赖 api.js，测试可传桩。
 * @param {{lang?:'zh'|'en'}} opts 输出语言（默认中文）
 * @returns {{ ok:boolean, map:Record<string,string>, error?:string }}
 */
export async function aiNaturalProfiles(items, callLLM, opts = {}) {
  const list = (Array.isArray(items) ? items : [])
    .filter(it => it?.name && (nlProfilePayload(it.fields).length || String(it.refs || '').trim()));
  if (!list.length) return { ok: false, map: {}, error: '没有可撰写的字段' };
  if (typeof callLLM !== 'function') return { ok: false, map: {}, error: 'LLM 通道不可用' };
  try {
    const messages = aiProfileMessages(list, { lang: opts.lang });
    const reply = await callLLM(messages, { source: '自然语档案撰写', temperature: 0.3, ...opts });
    const map = parseAiProfiles(reply, list.map(i => i.name));
    if (!Object.keys(map).length) return { ok: false, map: {}, error: 'AI 回复里没有可解析的角色行' };
    return { ok: true, map };
  } catch (e) {
    return { ok: false, map: {}, error: String(e?.message || e || 'AI 调用失败') };
  }
}

/**
 * 服装预设 AI 扩写：把六要素 tag 串扩写成连贯的自然语（中/英）。
 * 铁律同档案：只重组与衔接给出的要素，不许新增款式/颜色/件数。
 */
export function aiOutfitMessages(name, text, opts = {}) {
  const lang = opts.lang === 'en' ? 'en' : 'zh';
  const t = String(text || '').trim();
  if (!t) return null;
  return [
    {
      role: 'system',
      content: [
        '你是服装描述扩写器。把用户给出的服装要素 tag 串，扩写成一段连贯的自然语服装描述（用于 AI 绘画）。',
        '铁律：',
        '1. 只能使用给出的要素 —— 禁止新增任何款式、颜色、材质、件数（给几件就是几件）。',
        '2. 给出的每个要素都必须保留，一个不许丢。',
        `3. 输出${lang === 'en' ? '为**英文**连贯描述（一句到三句）' : '为**简体中文**连贯描述（一句到三句）'}，不要逗号罗列碎片词。`,
        '4. 只输出扩写后的描述本身，不要解释、不要引号、不要代码块标记。',
      ].join('\n'),
    },
    { role: 'user', content: `预设名：${name || '(未命名)'}\n服装要素：${t}` },
  ];
}

/**
 * AI 扩写服装预设文本。callLLM 注入式（同 aiNaturalProfiles）。
 * @returns {{ ok:boolean, text?:string, error?:string }}
 */
export async function aiExpandOutfit(name, text, callLLM, opts = {}) {
  if (!String(text || '').trim()) return { ok: false, error: '没有可扩写的内容' };
  if (typeof callLLM !== 'function') return { ok: false, error: 'LLM 通道不可用' };
  try {
    const messages = aiOutfitMessages(name, text, { lang: opts.lang });
    const reply = String(await callLLM(messages, { source: '服装预设扩写', temperature: 0.3, ...opts }) || '')
      .replace(/```[a-z]*\n?/gi, '').trim()
      .replace(/^["'「『]+|["'」』]+$/g, '').trim();
    if (!reply) return { ok: false, error: 'AI 返回空' };
    return { ok: true, text: reply };
  } catch (e) {
    return { ok: false, error: String(e?.message || e || 'AI 调用失败') };
  }
}

/* ---- 服装预设 AI 工具（v0.9.55）----
 * 四种操作统一走这里（扩写另有 aiExpandOutfit，UI 层两函数并存）：
 *   translate-en  中文/混合 → 英文六要素 tag 串（入画面词的格式）
 *   translate-zh  英文 → 简体中文连贯自然语（给人读）
 *   tagify        任意输入整理成规范英文六要素 tag 串（乱序/中英混合都能收）
 *   refine        按用户指令改写（保持原格式：tag 进 tag 出、自然语进自然语出）
 *   create        按用户指令从零生成一套六要素 tag 串（唯一允许补全细节的 op）
 * 共同铁律：件数/颜色/款式不增不减（refine 允许按指令改，但指令没提的属性不动）。
 */

/** 是否含中文（判翻译方向用）。 */
export function hasChinese(text) {
  return /[\u4e00-\u9fff]/.test(String(text || ''));
}

/** 构造 aiPresetTool 的 messages（独立导出供测试）。
 * @param {string} format 'auto' | 'tag' | 'en-nl' | 'zh-nl'（refine/create 生效，auto = 跟随指令）
 */
export function aiPresetToolMessages(name, text, op, instruction = '', format = 'auto') {
  const t = String(text || '').trim();
  if (!t && op !== 'create') return null;   // create 允许无原文（从指令生成）
  const base = [
    '你是服装描述转换器，服务于 AI 绘画提示词工程。',
    '共同铁律：',
    '1. 服装件数、颜色、材质、款式不增不减 —— 给什么就是什么，禁止自由发挥。',
    '2. 只输出转换后的描述本身，不要解释、不要引号、不要代码块标记。',
  ];
  // 输出格式条款（refine / create 可指定；auto = 跟随用户指令，指令没说则保持原文格式）
  const fmt = ['tag', 'en-nl', 'zh-nl'].includes(format) ? format : 'auto';
  const formatClause = {
    tag: '输出格式：**英文六要素 tag 串** —— 英文短语用逗号分隔，按六要素排序（主色/质地 → 领型 → 结/领带/领巾 → 上衣 → 下装 → 袜鞋），只要可绘事实词，禁质量词与句式。',
    'en-nl': '输出格式：**英文自然语** —— 一到三句连贯英文句子（不是逗号罗列）。',
    'zh-nl': '输出格式：**简体中文自然语** —— 一到三句连贯中文句子（不是逗号罗列）。',
    auto: '输出格式：跟随用户指令 —— 指令里说了写 TAG / 写英文 / 写中文，就按指令来；指令没提格式则保持原文格式（原文是 tag 串就输出 tag 串，原文是自然语就输出自然语）。',
  }[fmt];
  let task = '';
  if (op === 'translate-en') {
    task = [
      '任务：把给出的中文（或中英混合）服装描述，翻译成**英文六要素 tag 串**。',
      '格式：英文短语用逗号分隔；按六要素排序（主色/质地 → 领型 → 结/领带/领巾 → 上衣 → 下装 → 袜鞋）。',
      '禁止质量词（beautiful、gorgeous、sexy 等）与句式，只要可绘事实词。',
    ].join('\n');
  } else if (op === 'translate-zh') {
    task = [
      '任务：把给出的英文服装 tag 串，翻译成**简体中文连贯自然语**（一句到三句，给人看的描述）。',
      '每个要素都必须保留，不要逗号罗列碎片词。',
    ].join('\n');
  } else if (op === 'tagify') {
    task = [
      '任务：把给出的服装描述（可能乱序、中英混合、自然语）整理成**规范英文六要素 tag 串**。',
      '格式同上：英文短语 + 逗号分隔 + 六要素排序；去掉口语词与重复词，可绘事实全保留。',
    ].join('\n');
  } else if (op === 'refine') {
    task = [
      `任务：按用户的具体指令改写这段服装描述。用户指令：${String(instruction || '').trim() || '（无）'}`,
      formatClause,
      '指令没提到的属性一律保持原样，不许顺手改。',
    ].join('\n');
  } else if (op === 'create') {
    task = [
      `任务：根据用户的款式需求，从零写一套服装描述（用于 AI 绘画预设）。`,
      `用户需求：${String(instruction || '').trim() || '（无）'}`,
      // create 的 auto 语义：指令说了算，指令没说格式则默认英文六要素 tag 串
      fmt === 'auto'
        ? '输出格式：跟随用户指令 —— 指令里说了写中文 / 写自然语就照办；没提格式则输出**英文六要素 tag 串**（英文短语逗号分隔，六要素排序，禁质量词）。'
        : formatClause,
      '指令没写到的细节（颜色/款式搭配）按常识补全成一套协调的完整穿搭 —— 这是唯一允许补全的操作。',
    ].join('\n');
  } else {
    return null;
  }
  return [
    { role: 'system', content: [...base, task].join('\n') },
    { role: 'user', content: `预设名：${name || '(未命名)'}${t ? `\n现有描述：${t}` : ''}` },
  ];
}

/**
 * 服装预设 AI 工具。callLLM 注入式（同 aiExpandOutfit）。
 * @param {string} op 'translate-en' | 'translate-zh' | 'tagify' | 'refine'
 * @param {string} instruction refine 时的用户指令（其余 op 可空）
 * @returns {{ ok:boolean, text?:string, error?:string }}
 */
export async function aiPresetTool(name, text, op, callLLM, opts = {}) {
  const instruction = String(opts.instruction || '');
  const format = String(opts.format || 'auto');
  if (op === 'create' && !instruction.trim()) {
    return { ok: false, error: '先写一句你想要的款式（如：性感的哥特萝莉）再生成' };
  }
  const messages = aiPresetToolMessages(name, text, op, instruction, format);
  const knownOp = ['translate-en', 'translate-zh', 'tagify', 'refine', 'create'].includes(op);
  if (!knownOp || !messages) {
    return { ok: false, error: !knownOp ? `未知操作：${op}` : '没有可转换的内容' };
  }
  if (typeof callLLM !== 'function') return { ok: false, error: 'LLM 通道不可用' };
  try {
    const reply = String(await callLLM(messages, { source: '服装预设转换', temperature: 0.3, ...opts }) || '')
      .replace(/```[a-z]*\n?/gi, '').trim()
      .replace(/^["'「『]+|["'」』]+$/g, '').trim();
    if (!reply) return { ok: false, error: 'AI 返回空' };
    return { ok: true, text: reply };
  } catch (e) {
    return { ok: false, error: String(e?.message || e || 'AI 调用失败') };
  }
}

/**
 * v0.9.60：角色档案页「AI 优化服装态」的 messages 构造（纯函数，供测试）。
 *
 * ★ 与 aiPresetTool 的铁律**方向相反**：预设转换是"服装件数不增不减"，
 *   这里是**用户主权区的直接编辑** —— 指令说删首饰就删首饰、说换白丝就换白丝。
 *   唯一保留的边界：指令没提到的内容保持原样，不许 AI 顺手发挥。
 *
 * @param {string} style 当前着装（还穿在身上的）
 * @param {string} bare 裸露部位（已经脱掉/露出的）
 * @param {string} ask 用户指令（空 = 只做梳理，不改内容）
 * @returns {Array<{role:string,content:string}>}
 */
export function outfitAskMessages(style, bare, ask) {
  const instruction = String(ask || '').trim();
  const sys = [
    '你是 AI 绘画工作流的服装状态编辑器。角色此刻的穿着拆成两半记录：style=还穿在身上的，bare=已经脱掉/裸露的部位。你按用户指令改写这两半。',
    '硬规则：',
    '1. 严格按指令改：指令要求删什么（服装、首饰、配饰）就删干净，要求换什么就换掉，要求把某件挪到 bare（表示已脱下）就挪过去。',
    '2. 指令没提到的内容保持原样，禁止顺手新增任何服装、首饰、配饰，禁止自由发挥。',
    '3. 已经脱掉的衣服（被指令要求脱下、或原文写着褪下/搭在一旁的）只写进 bare，style 里只留还穿在身上的 —— 两半不许重复出现同一件。',
    '4. 输出语言跟随原文（原文是英文 tag 串就输出英文 tag 串）。',
    '5. 只输出一个 JSON 对象，格式：{"style":"...","bare":"..."}，不要解释、不要代码块标记。某半为空就输出空字符串。',
    instruction
      ? `用户指令：${instruction}（指令与上面规则冲突时，以指令为准 —— 那是用户刚定的主意）`
      : '用户没有给具体指令：只做梳理（去重复、把褪下的衣物从 style 挪到 bare），不改任何款式与颜色。',
  ].join('\n');
  const user = `【当前着装 style】\n${String(style || '').trim() || '（空）'}\n\n【裸露部位 bare】\n${String(bare || '').trim() || '（空）'}`;
  return [
    { role: 'system', content: sys },
    { role: 'user', content: user },
  ];
}

/**
 * 解析「AI 优化服装态」的返回（纯函数，供测试）。
 * 容忍：```json 代码块包裹 / 前后多余文字 / 单引号键。style 或 bare 缺失时该半保持 null（调用方不覆盖）。
 * @returns {{ ok:boolean, style?:string, bare?:string, error?:string }}
 */
export function parseOutfitAskOut(reply) {
  let s = String(reply || '').replace(/```[a-z]*\n?/gi, '').trim();
  if (!s) return { ok: false, error: 'AI 返回为空' };
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return { ok: false, error: 'AI 返回里没有找到 JSON 对象' };
  try {
    const obj = JSON.parse(m[0]);
    const style = typeof obj.style === 'string' ? obj.style.trim() : null;
    const bare = typeof obj.bare === 'string' ? obj.bare.trim() : null;
    if (style === null && bare === null) return { ok: false, error: 'AI 返回的 JSON 里没有 style/bare 字段' };
    return { ok: true, style, bare };
  } catch (e) {
    return { ok: false, error: `JSON 解析失败：${e?.message || e}` };
  }
}

/**
 * 词典兜底：按输出语言给自然语档案的降级产物。
 * zh = 机械翻译（内置词典）；en = 字段值原文用逗号串成英文短语（本来就是英文 tag）。
 */
export function dictFallbackProfile(fields, lang = 'zh') {
  if (lang === 'en') {
    return nlProfilePayload(fields)
      .map(l => l.replace(/^[a-z_]+:\s*/i, ''))
      .join(', ');
  }
  return buildNaturalProfile(fields);
}

/**
 * 推断角色的性别称谓 + 外表年龄措辞（仅用于 nlProfile 缺失时的词典兜底开头）。
 * sex 字段缺失时从全部字段文本推断（身体特征词最可靠），再不行兜底「女性」。
 * ⚠️ 年龄措辞（2026-09-27 实测定稿）：**禁止「成年」二字** —— 「一位成年女性」
 *   会让模型把脸画老、体型画壮（核心崩因）。按外表分三档：
 *   年轻 → 少女/少年；年长/成熟 → 成熟的女性/成熟的男性；其余 → 女性/男性。
 */
function k2WhoLabel(eff) {
  const f = eff?.entry?.fields || {};
  const sexField = String(f.sex || '').toLowerCase();
  const allText = Object.values(f).map(v => String(v || '').toLowerCase()).join(' ');
  // 三态性别：判不出就走中性兜底 —— 猜错性别比不写更糟（v0.9.17「归属错乱」教训）
  let gender = '';
  if (/girl|female|woman/.test(sexField) || /breast|vagina|pussy|clit/.test(allText)) gender = 'f';
  else if (/boy|male|man/.test(sexField) || /cock|penis|beard|testicle/.test(allText)) gender = 'm';
  if (!gender) return '成年人';
  // 年龄判定只看外表线索（face/age/look/build），不拿「身材成熟」当「年长」
  const look = [f.face, f.age, f.look, f.build].filter(v => v != null).map(v => String(v).toLowerCase()).join(' ');
  if (/young|teen|child|loli|少女|年幼|年轻|稚气/.test(look)) return gender === 'f' ? '少女' : '少年';
  if (/mature|milf|elder|old$|aging|御姐|熟女|人妻|年长|大叔/.test(look)) return gender === 'f' ? '成熟的女性' : '成熟的男性';
  return gender === 'f' ? '女性' : '男性';
}

/**
 * 把出场角色渲染成中文人物段（v4 第 3 段）。
 *
 * 格式（2026-09-27 实测定稿）：每人一行「角色名：+ 自然语外貌」，**无「画面中的人物——」标题行、
 * 无「画面中的女人：」性别前缀、无英文状态碎片**：
 *   菲：一位体型娇小的精灵，只有巴掌大小，金色长卷发垂至腰际，……。   ← nlProfile 整段直用
 *   夜斗：一位男性，黑色短发狼尾鲻鱼头；细长凤眼；……。              ← 词典兜底（字段拼接）
 * 定稿依据（实测四连崩）：
 *   ① 「画面中的人物——」标题行是废话，白占权重；
 *   ② 「画面中的女人：」性别前缀与外貌本身冲突 —— 精灵写成「女人」→ 大妈脸/大体型（核心崩因）；
 *   ③ nlProfile 以「成年女性」开头同样把脸画老、体型画壮（「成年」二字禁写）；
 *   ④ 中文段「女人」vs 英文段「palm-sized fairy」各立一个实体 → 实测多画一只精灵。
 * 保留「角色名：」前缀（2026-09-27 追加）：多人同框时给模型一个稳定的外貌归属锚点，
 * 与英文段里的人名呼应（「Lilian with 银白长发」），实测能压住多人外貌串台。
 * ⚠️ 角色名只做行首标签，不得混进外貌正文；性别/年龄/种族措辞一律由外貌正文自己担。
 */
/**
 * @param {Array} anchors
 * @param {object} [opts] { withOutfit:false } —— v0.9.53：服装被拆成独立段时，
 *   人物段里不再带服装子句（由 k2CostumeParagraph 单独产出），避免同一件衣服出现两次。
 */
export function k2CastParagraph(anchors, opts = {}) {
  const withOutfit = opts.withOutfit !== false;
  const list = Array.isArray(anchors) ? anchors : [];
  if (!list.length) return '';
  const lines = [];
  for (const { name, eff, en } of list) {
    // 名字先剥宏：<user> 这类名字会在最终闸口被宏清洗剥掉，只剩孤儿冒号
    // （实测「：一位男性，…」就是这么来的）。剥完是空的 = 废条目，整行不输出。
    const clean = cleanRefName(name);
    if (!clean) continue;
    const label = `${clean}：`;
    const nlProfile = String(eff?.entry?.fields?.nlProfile || '').trim();
    let body;
    if (nlProfile) {
      // 整段直用（带存量兼容清洗）；统一以「。」收尾（撰写器输出可能带句号，这里只做规范化不二次加工）
      const t = cleanProfileLead(nlProfile).replace(/[。.；;]*$/, '');
      body = `${t}。`;
    } else {
      const parts = k2AnchorParts(eff);
      if (!parts.length) continue;
      const who = k2WhoLabel(eff);
      body = `一位${who}，${parts.join('；')}。`;
    }
    // ↓ v0.9.42：服装机械注入（见 outfitClauseFor 的注释——服装是唯一靠模型自觉的字段，实测必漂）
    if (withOutfit) body += outfitClauseFor(eff, en);
    lines.push(`${label}${body}`);
  }
  return lines.join('\n');
}

/**
 * MOSS 英文人物段（v0.9.118）。
 *
 * ★★★ 为什么必须有这个函数（用户 2026-10-21 真实出图，四张里三张人物漂移）：
 *
 *   v0.9.117 我的判断是「MOSS 不注入人物段，外貌靠模型照抄档案字段值」。
 *   实测**完全失败**，四张图的 Panel 描述里：
 *     P22 → 写了 `black hair, long hair, straight hair, blue eyes`（抄到了）
 *     P8  → 只剩 `a girl with long black straight hair`（服饰全丢）
 *     P17 → 只有一个 `the girl`（外貌一个字段都没有 → 女主画成棕发丸子头）
 *   出词模型抄不抄、抄多少，**每次随机**。靠自觉 = 没有锚定。
 *
 *   而且 v0.9.117 的 spec 里我照着方法论文档写了「外貌与服装只在第一次完整出场那格写全一次，
 *   后面用 the girl 指代」—— 那条讲的是**同一张图内跨格**，但模型理解成**跨图**：
 *   从 P17 起它认定「前面已经写过」，于是整张图一个字段都不写。
 *   ⇒ 与铁律「逐张独立生成：不写 ≠ 延续」正面冲突，是我写错了规则。
 *
 * ★ 为什么原样拼 tag 而不改写成自然语：
 *   档案是权威，改一个词就是换一个人（绘灵一贯铁律）。实测 P22 那张抄了原值的人物是对的，
 *   说明 MOSS 吃得住 `with black hair, long hair, straight hair` 这种混写。
 *   转换语序反而引入「档案里没有的措辞」。
 *
 * @param {Array<{name:string, eff:object}>} anchors
 * @returns {string} 每个角色一行，行间 `\n`
 */

/**
 * ★★★ v0.9.120：自定义字段黑名单。
 *
 * 两类必须挡掉（用户真实档案就是这两类）：
 *   ① 性别 / 年龄：`gender` / `sex` / `age` —— 已由 `mossWhoLabel` 表达成主语
 *      （`The middle-aged man`），再拼进 with 列表就是重复 + 引入 `1boy`；
 *   ② 剧情状态：`状态` / `情绪` / `state` / `pose` / `action` —— 《雾津市播种计划！》
 *      的角色带这三个字段（值形如 `just finished, hips locked forward…`），
 *      拼进外貌段等于把**上一楼的姿势永久钉进人设**，之后每张图都会带着它。
 */
const MOSS_CAST_SKIP_FIELDS = new Set([
  // 标准外貌字段：上面那条 `for (const k of ['hair', …])` 已经推过，这里必须再跳过，
  // 否则同一个值被拼两遍（实测：`tall, large breasts, black hair, …, tall, large breasts`）
  'hair', 'eyes', 'face', 'skin', 'body', 'mark',
  'sex', 'gender', 'age',
  'outfit', 'nlProfile', 'outfitState', 'hairState', 'makeupSmudge',
  'state', 'status', 'pose', 'action',
  '状态', '情绪', '表情', '动作', '衣着状态', '服装状态',
]);

/** SD 人数 / 性别标记：在自然语里会被读成实体声明，不是属性。 */
const MOSS_SD_COUNT_RE = /^(?:\d+\s*(?:girl|boy|other)s?|girls?|boys?|males?|females?|men|women|solo|multiple\s+\w+|no\s+humans?)$/i;

/**
 * ★★★ v0.9.124：裸露片段不能一律套 `with ... exposed`。
 *
 * 现场（2026-10-21 诊断报告 · 纯 prompt 版 P16 的真实人物段）：
 *   `… white school blouse unbuttoned and hanging off both shoulders, with naked from
 *    the waist down, pleated skirt and panties and tights discarded on the wet floor exposed.`
 *   —— 语法是崩的。原因：`bare` 字段里存的是**一句状态描述**（`naked from the waist down…`），
 *   而代码无条件套模板 `with ${skin} exposed`，等于把整句塞进介词短语里。
 *
 * 三种写法分开处理（都不改语义，只保证语序读得通）：
 *   ① 本身已是状态句（含 naked / nude / topless / bottomless / bare / exposed …）
 *      → 原样接在后面，**不再加 with…exposed**；
 *   ② 自带介词开头（with …）→ 去掉重复的 with；
 *   ③ 纯名词短语（her thighs and belly）→ 才套 `with … exposed`。
 */
function skinClause(raw) {
  const s = String(raw || '').trim().replace(/^with\s+/i, '');
  if (!s) return '';
  const selfContained = /\b(?:exposed|naked|nude|topless|bottomless|bare|undressed|clothed|wearing|dressed|clad)\b/i.test(s);
  return selfContained ? s : `with ${s} exposed`;
}

export function mossCastParagraph(anchors) {
  const list = Array.isArray(anchors) ? anchors : [];
  const out = [];
  for (const { eff, look } of list) {
    /**
     * ★★★ v0.9.119：**没建档的角色走 `look` 兜底**（巡查员 / 店员 / 路人）。
     *
     * 用户原话（2026-10-21）：「假如这个巡查员没有档案，那应该也会自行根据正文
     * 编写一个巡查员外貌，然后写进最终提示词里对吧。」
     *
     * 旧逻辑下 `castAnchors` 只认档案库里的名字，路人解析不出就直接丢弃
     * → 没有人物段 → MOSS 自由发挥 → 实测把他画成「第二个穿同款校服的女生」。
     *
     * 模型给的是**一行英文外貌速写**（约定以 A / An / The 开头，
     * 如 `A middle-aged man with short grey hair, wearing a dark blue security uniform`）。
     * 万一它写成形容词短语（`middle-aged, grey short hair`），补一个 `A person with` 兜住语法。
     */
    const lk = String(look || '').trim().replace(/\s+/g, ' ');
    if (!eff && lk) {
      const sentence = /^(a|an|the|his|her|their|two|three|several|one)\b/i.test(lk)
        ? lk
        : `A person with ${lk}`;
      out.push(`${sentence.replace(/[.,;:]+$/, '')}.`);
      continue;
    }
    if (!eff) continue;
    const f = eff?.entry?.fields || {};
    const looks = [];
    const pushLook = (v) => {
      const t = String(v ?? '').trim().replace(/[,，、;；]+$/, '');
      if (!t) return;
      /**
       * ★★★ v0.9.120 值层兜底：SD 的「人数/性别标记」在 MOSS 自然语里是有害的。
       *   `1boy` / `1girl` / `solo` / `multiple girls` 这类词在自然语里会被读成
       *   **「画面里有一个男孩」这种实体声明**，而不是「这个角色是男的」——
       *   实测病例：助理档案 `gender:"1boy"` 拼进人物段后，出图多出一个人。
       *   性别已经由 `mossWhoLabel` 表达（The young man / The middle-aged woman），
       *   这里再出现一次纯属反向信号。
       */
      if (MOSS_SD_COUNT_RE.test(t)) return;
      looks.push(t);
    };
    for (const k of ['hair', 'eyes', 'face', 'skin', 'body', 'mark']) pushLook(f[k]);
    /**
     * ★★★ v0.9.120：自定义字段**改用黑名单**，并且把状态类字段一起挡掉。
     *
     * 旧代码是「已知外貌字段跳过，其余全放行」，于是两类字段混进了外貌段：
     *   ① `gender` / `age` —— 名字不同但语义已被 `mossWhoLabel` 处理（见上）；
     *   ② `状态` / `情绪` / `state` —— 《雾津市播种计划！》的角色带这三个**剧情状态**字段
     *      （`just finished, hips locked forward…`），拼进外貌段等于把上一楼的姿势
     *      **永久钉进人设**，之后每一张图都会带着它。
     */
    for (const [k, v] of Object.entries(f)) {
      if (MOSS_CAST_SKIP_FIELDS.has(k)) continue;
      if (typeof v !== 'string' && typeof v !== 'number') continue;
      pushLook(v);
    }
    const o = eff?.dyn?.outfit || {};
    const state = String(o.state || '').toLowerCase();
    const bare = String(o.bare || '').trim();
    // 与 outfitClauseFor 同口径：同部位互斥 → 裸着的部位撤下同部位衣物
    const deduped = dedupeOutfitSlots(String(o.style || '').trim());
    const style = stripCoveredByBare(deduped, bare).style;
    const wear = state === 'removed' ? '' : String(style || '').trim();
    const skin = state === 'removed' ? String(stripGarmentFromBare(bare, state) || '').trim() : bare;

    const head = mossWhoLabel(eff);
    const parts = [looks.length ? `${head} with ${looks.join(', ')}` : head];
    if (wear) parts.push(`wearing ${wear}`);
    if (skin) parts.push(skinClause(skin));
    out.push(`${parts.join(', ')}.`);
  }
  return out.join('\n');
}

/**
 * 脸部近景专用的一行：**只给「是谁 + 头部看得见的那点东西」**。
 *
 * ★★★ 病例（漫画页模式实测）：脸部特写格里照抄整套外貌 + 服装，
 *   `wearing a black dress` 会把镜头从脸上拉走 —— 那一格本该是「眼睛里的一下」，
 *   出图变成半身中景，整页的景别节奏就塌了。
 * ⇒ 只保留头发 / 脸 / 眼 / 妆 / 颈部这一类**近景可见**的字段。
 */
const MOSS_FACE_FIELD_RE = /hair|发|脸|face|眼|eye|mark|颈|neck|耳|ear|妆|makeup|lip|唇/i;

/**
 * face 行专用的「跳过」集合。
 *
 * ★★★ 病例（2026-10-27 用真实档案跑出来的）：原来这里复用了 `MOSS_CAST_SKIP_FIELDS`，
 *   而那个集合把 `hair / eyes / face / skin / body / mark` 也标成「上面已推过」——
 *   对 `mossCastParagraph` 成立（它上面确实先推了那六个），但 face 行**只挑近景字段**，
 *   复用之后所有标准外貌字段全被跳过 ⇒ 输出恒为 `The young woman.`
 *   （头发、眼睛、妆一样都没有）。
 *   症状是「特写格的人长得不像」，但根因是这一行**一个字都没给**。
 * ⇒ face 行只该跳两类：① 性别/年龄（主语已表达）② 剧情状态与服装（表现层，会拉走镜头）。
 */
const MOSS_FACE_SKIP_FIELDS = new Set([
  'sex', 'gender', 'age',
  'outfit', 'nlProfile', 'outfitState', 'hairState', 'makeupSmudge',
  'state', 'status', 'pose', 'action',
  '状态', '情绪', '表情', '动作', '衣着状态', '服装状态',
]);

/**
 * 脸部近景格的**服装锚**（只有一句话，不含五官）。
 *
 * ★★★ 病例（2026-10-28 屋顶 3 页真机）：`shot:"face"` 的格子只注入 `mossFaceLine`
 *   （头发 / 眼 / 妆），**完全没有服装** —— 而 MOSS 没有任何跨格记忆，每一格独立生成，
 *   于是那一格她就"随便穿了一件"：同一页里王梓琳上一格灰色制服、这一格黑衬衫。
 *   症状看着像"人脸漂移"，其实是**衣服漂移**。
 *
 * 为什么不能直接把整套 `full` 塞进 face 格：v0.9.139 实测过，`wearing a black dress`
 *   这种整句会把镜头从脸上拉走 → 特写格变成半身中景，整页景别节奏塌掉。
 * ⇒ 折中：只给**一句话的款式**（颜色 + 品类），由 `mossMangaPage` 的 caption
 *   同时钉死"只有头颈入镜，衣服只露领口"。
 */
function mossWearLine(anchor) {
  const eff = (anchor || {}).eff;
  if (!eff) return '';
  const o = eff?.dyn?.outfit || {};
  const state = String(o.state || '').toLowerCase();
  const bare = String(o.bare || '').trim();
  const deduped = dedupeOutfitSlots(String(o.style || '').trim());
  const style = stripCoveredByBare(deduped, bare).style;
  const wear = state === 'removed' ? '' : String(style || '').trim();
  const skin = state === 'removed' ? String(stripGarmentFromBare(bare, state) || '').trim() : bare;
  const parts = [];
  if (wear) parts.push(`wearing ${wear}`);
  else if (state === 'removed') parts.push('wearing nothing at all');
  if (skin) parts.push(skinClause(skin));
  return parts.join(', ');
}

export function mossFaceLine(anchor) {
  const a = anchor || {};
  const eff = a.eff;
  const lk = String(a.look || '').trim();
  if (!eff) return lk;
  const f = eff.entry?.fields || {};
  const bits = [];
  for (const [k, v] of Object.entries(f)) {
    if (MOSS_FACE_SKIP_FIELDS.has(k)) continue;
    if (typeof v !== 'string' && typeof v !== 'number') continue;
    if (!MOSS_FACE_FIELD_RE.test(k)) continue;
    const t = String(v ?? '').trim().replace(/[,，、;；]+$/, '');
    if (t) bits.push(t);
  }
  const head = mossWhoLabel(eff);
  return bits.length ? `${head} with ${bits.join(', ')}.` : `${head}.`;
}

/**
 * 英文身份主语。性别判不出时用中性 the person —— 猜错性别比不写更糟（同 k2WhoLabel 的教训）。
 *
 * ★★★ v0.9.120：性别字段认 `gender`，并把 `age` 提到主语上。
 *
 * 病例（用户真实档案 · 巡查员，2026-10-21）：
 *   `{ hair:"short grey hair", …, gender:"1boy", age:"middle-aged" }`
 *   —— 他的性别字段叫 **`gender`** 而不是 `sex`，旧代码只读 `sex` ⇒ 判不出性别 ⇒ 主语退化成
 *   `The person`；同时 `age` 被当成外貌词拼进 with 列表 ⇒ 最终：
 *   `The person with short grey hair, dark eyes, middle-aged face, weathered skin, stocky build, 1boy, middle-aged.`
 *   两个问题叠加：`1boy` 在自然语里等于「声明有一个男孩」（多画人的直接来源），
 *   `middle-aged` 又和 `middle-aged face` 重复一次。
 *
 *   ⇒ 现在 `gender` 与 `sex` 同权；`age` 若命中白名单词，提到主语上：
 *      `The middle-aged man with short grey hair, …`（更像人话，也不再与外貌词重复）。
 */
const MOSS_AGE_WORDS = /^(young|middle[- ]aged|elderly|old|teenage|teen|adult|child|kid)$/i;
function mossWhoLabel(eff) {
  const f = eff?.entry?.fields || {};
  const sexField = String(f.sex || f.gender || '').toLowerCase();
  const allText = Object.values(f).map(v => String(v || '').toLowerCase()).join(' ');
  const ageRaw = String(f.age || '').trim();
  const age = MOSS_AGE_WORDS.test(ageRaw) ? ageRaw.toLowerCase().replace(/^middle aged$/, 'middle-aged') : '';
  const withAge = (noun) => (age ? `The ${age} ${noun}` : `The ${noun}`);
  if (/girl|female|woman/.test(sexField) || /breast|vagina|pussy|clit/.test(allText)) {
    return withAge(age === 'young' || !age ? 'young woman' : 'woman');
  }
  if (/boy|male|man/.test(sexField) || /cock|penis|beard|testicle/.test(allText)) {
    return withAge(age === 'young' || !age ? 'young man' : 'man');
  }
  return age ? `The ${age} person` : 'The person';
}

/**
 * v0.9.53：服装段单独成块（仅在「服装独立成段」开启时使用）。
 * 服装原本是人物段末尾的一句；拆出来后用户就能把它排到自己想要的位置
 * （例如放到动作段之后，让衣服的权重压过动作描述）。
 */
export function k2CostumeParagraph(anchors) {
  const list = Array.isArray(anchors) ? anchors : [];
  const lines = [];
  for (const { name, eff, en } of list) {
    const clean = cleanRefName(name);
    if (!clean) continue;
    const clause = outfitClauseFor(eff, en);
    if (!clause) continue;
    lines.push(`${clean}：${clause}`);
  }
  return lines.join('\n');
}

/**
 * v0.9.53：按角色档案**现读**重建中文人物段（外貌 + 服装都回档案取当前值）。
 *
 * ★ 为什么要有这个函数（用户实测病例，2026-09-30）：
 *   服装是首次出图时由 processImage 机械注入、然后**连同 cast 文本一起存进存档**的。
 *   之后 regenerate 直接复读存档里的 cast 文本 —— 于是用户在档案页把「紫色吊带」改成
 *   「白色居家吊带」、点「重新生成」，出的还是紫色：档案根本没被读到。
 *   外貌（nlProfile）同理，也是烘焙进存档的。
 *
 *   这里给 regenerate 一条「回档案重取」的路：逐行认出「角色名：…」的行，
 *   用档案当前值重建该行；**不带名字的行（英文动作句）原样保留**，不碰模型创作的内容。
 *
 * @param {string} castText 存档里的人物段原文
 * @param {object} [opts] { snapshot, positional }
 * @returns {{text:string, changed:Array<{name:string, from:string, to:string}>, unknown:string[]}}
 *          changed = 本次被档案刷新的行（用于给用户提示"刷新了什么"）；
 *          unknown = 人物段里写了、档案库里查不到的名字（原样保留，不乱动）
 */
export function refreshCastFromLibrary(castText, opts = {}) {
  const raw = String(castText || '').trim();
  if (!raw) return { text: '', costumeText: null, changed: [], unknown: [] };

  const snapshot = opts.snapshot || buildLibrarySnapshot();
  const positional = opts.positional || [];
  const lines = raw.split('\n');
  const out = [];
  const changed = [];
  const unknown = [];
  // 「角色名：…」行 —— 名字里不该有冒号，长度上限防误吞整段
  const NAME_LINE_RE = /^([^:：]{1,24})[:：]([\s\S]*)$/;

  /**
   * 服装段独立时（costumeSeparate），人物段里**不能**再注入服装子句 ——
   * 否则存档的服装段 + 重建出来的人物段里各有一份，同一件衣服出现两次
   * （重复 = 实体复制，本项目头号崩图机理）。此时服装子句改由服装段自己刷新。
   */
  const withOutfit = !opts.separateOutfit;
  /** 名字 → 英文动作句（服装段刷新时也要用同一份，保证「动作句已写衣服就不注入」口径一致） */
  const enByName = new Map();

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const m = String(line).match(NAME_LINE_RE);
    // 不是「名字：」行 = 英文动作句 / 空行 → 原样保留（那是模型的创作，不重写）
    if (!m) { out.push(line); continue; }

    const clean = cleanRefName(m[1].trim());
    if (!clean) { out.push(line); continue; }
    // 档案库里查不到这个人 → 保持原样（多半是模型临时点名，插件本就忽略）
    if (!snapshot.some(x => x.name === clean)) { unknown.push(clean); out.push(line); continue; }

    /**
     * 紧随其后的非中文行 = 该角色的英文动作句（castGrouped 分块写法的产物）。
     * 带进来只为让「服装是否已被动作句写过」的判定跟首次出图时同口径 ——
     * 动作句里已经写了衣服就不再机械注入，避免重复权重。
     */
    const next = String(lines[i + 1] || '').trim();
    const en = next && !NAME_LINE_RE.test(next) && !/[\u4e00-\u9fa5]/.test(next) ? next : '';
    if (!enByName.has(clean)) enByName.set(clean, en);

    const eff = effectiveOf(clean, snapshot, positional);
    const rebuilt = k2CastParagraph([{ name: clean, eff, en }], { withOutfit });
    if (!rebuilt) { out.push(line); continue; }

    if (rebuilt !== line) changed.push({ name: clean, from: line, to: rebuilt });
    out.push(rebuilt);
  }

  // 服装段同步刷新（仅在独立成段时）：同一套档案值，逐行按名字重建
  let costumeOut = null;
  if (opts.separateOutfit && opts.costumeText != null && String(opts.costumeText).trim()) {
    const cout = [];
    for (const line of String(opts.costumeText).split('\n')) {
      const m = String(line).match(NAME_LINE_RE);
      if (!m) { cout.push(line); continue; }
      const clean = cleanRefName(m[1].trim());
      if (!clean || !snapshot.some(x => x.name === clean)) { cout.push(line); continue; }
      const eff = effectiveOf(clean, snapshot, positional);
      const clause = outfitClauseFor(eff, enByName.get(clean) || '');
      if (clause) cout.push(`${clean}：${clause}`);
      // 档案里现在没服装（style 空）→ 该行直接消失，与"服装没了"的事实一致
    }
    costumeOut = cout.join('\n');
  }

  return { text: out.join('\n'), costumeText: costumeOut, changed, unknown };
}

/**
 * v0.9.90：SD 口径「按档案重新生成」的引擎 —— 按当前档案刷新 prompt 里的旧锚点串。
 *
 * 背景：SD 没有 K2 的中文人物段，外貌锚点在出图时被 @展开/自愈**原地烘焙进 prompt**
 * （英文 tag 串）。之后改档案再点普通「重新生成」，复读的还是存档里的旧串 ——
 * 用户实测「改了档案重生成不生效」。K2 有菜单强刷人物段，SD 此前没有等价物。
 *
 * 做法：出图时 processImage 存了 anchorList（角色名 → 当时的锚点串）；
 * 这里对每个角色用**当前档案**重建锚点串，在 prompt 里做**精确整串替换** ——
 * 不猜句子结构、不做词根级增删（那类规则已三次误伤，见手册）。
 *
 * @param {string} prompt  存档 prompt（英文段，含旧锚点串）
 * @param {Array<{name:string,text:string}>} saved  出图时存的锚点清单（prev.anchors）
 * @param {Array} snapshot buildLibrarySnapshot() 的当前快照
 * @returns {{prompt:string, changed:string[], missed:string[], nextList:Array}}
 *          changed = 替换成功的角色；missed = 旧串在 prompt 里找不到的角色（多半被手改过，保持原样）；
 *          nextList = 刷新后的锚点清单（落库，供下一次继续替换）
 */
export function refreshAnchorsInPrompt(prompt, saved, snapshot) {
  const src = String(prompt || '');
  const list = Array.isArray(saved) ? saved.filter(a => a?.name && a?.text) : [];
  if (!src.trim() || !list.length) return { prompt: src, changed: [], missed: [], nextList: list };
  let t = src;
  const changed = [];
  const missed = [];
  const nextList = list.map(a => ({ name: a.name, text: a.text }));
  for (let i = 0; i < list.length; i += 1) {
    const a = list[i];
    const nt = anchorOf(a.name, effectiveOf(a.name, snapshot, [], Infinity));
    if (!nt || nt === a.text) continue;          // 档案没变（或角色已删档）→ 不动
    if (t.includes(a.text)) {
      t = t.replace(a.text, nt);                 // 只换第一次：锚点串本就该只出现一次
      changed.push(a.name);
      nextList[i] = { name: a.name, text: nt };
    } else {
      missed.push(a.name);
    }
  }
  // 替换后可能留下「, ,」空洞（旧串位于逗号链中间时），顺手归一并去尾逗号
  t = t.replace(/,\s*,+/g, ', ').replace(/,\s*$/, '').trim();
  return { prompt: t, changed, missed, nextList };
}

/**
 * 服装是否被该角色自己的英文动作句提到过？（用于决定要不要机械注入）
 *
 * 判定：取服装描述里的英文实词（≥4 字母），看英文句里命中几个。
 * 服装只有 1–2 个实词时命中 1 个就算写过；3 个以上要命中 2 个 ——
 * 免得模型只写了「his shorts」这种半句，插件就放弃注入、把整件衣服丢了。
 */
function outfitMentionedIn(style, en) {
  const low = String(en || '').toLowerCase();
  if (!low) return false;
  // 只数**服装实词**：颜色 / 质地 / 程度这类通用修饰词不算 ——
  // 否则「his light blue shorts」会因为撞上 light/blue/black 这些颜色词被误判成
  // 「衣服已经写全了」，连帽衣就再也注入不进来（这正是用户图1 的病例）。
  const words = (String(style || '').toLowerCase().match(/[a-z]{4,}/g) || [])
    .filter(w => !OUTFIT_STOPWORDS.has(w));
  if (!words.length) return false;
  const hit = words.filter(w => low.includes(w)).length;
  // 按比例判：把整件衣服写全了（含大部分部件）才算「已写」，只提到一件就跳过注入会丢衣服
  return (hit / words.length) >= 0.6;
}

/**
 * 服装描述里的通用修饰词 —— 命中它们不算「衣服写过了」。
 * 颜色、质地、版型、程度副词在动作句里遍地都是，拿它们做去重依据必然误判。
 */
const OUTFIT_STOPWORDS = new Set([
  'black', 'white', 'navy', 'blue', 'grey', 'gray', 'green', 'red', 'pink', 'brown',
  'gold', 'golden', 'silver', 'dark', 'light', 'deep', 'pale', 'pure', 'bright',
  'cotton', 'linen', 'silk', 'wool', 'leather', 'lace', 'sheer', 'plain', 'thick',
  'thin', 'loose', 'tight', 'short', 'long', 'wide', 'narrow', 'soft', 'stiff',
  'slightly', 'barely', 'almost', 'nearly', 'fully', 'half', 'with', 'from',
  'wrinkled', 'crumpled', 'stretched', 'covering', 'hanging', 'slipped',
]);

/**
 * 人物段里的服装子句 —— **由代码机械注入**，不经 LLM 的手。
 *
 * ★ v0.9.42 为什么必须有这一段：
 *   服装原本被设计成「归英文 tag 句，由模型照档案 outfit 值写」（见 k2AnchorParts 第 717 行
 *   注释：人物段再拼一遍就是重复权重）。但模型**没有义务写** —— 实测同一会话连跑 3 楼，
 *   档案 dyn 里服装一直是对的（夜斗 at=48「black hoodie, light blue shorts」，菲 at=52
 *   「sheer gauze slip dress」），出图提示词里却时有时无：图 1 男主只剩动作句里顺手带的
 *   「his light blue shorts」，图 2 变成「his black hoodie」，图 3 两人都光着。
 *   模型等于每轮现编 → 上衣一下连帽衣一下短袖。根因不是扫描没扫到，是**服装是唯一一个
 *   没有代码兜底、全靠模型自觉的字段** —— 外貌（nlProfile）是机械注入的，所以它从不丢。
 *
 *   现在改成和外貌同一个待遇：机械注入，100% 出现。
 *
 * ⚠️ 重复权重怎么办：注入前先拿该角色自己的英文动作句做一次去重
 *   （`outfitMentionedIn`）——动作句里已经把衣服写全了就不重复注入。
 *   这是历史实测结论：同一件衣服被描述两次，模型按「两个都要成立」去补，会崩肢体。
 *
 * ⚠️ 服装原文**不翻译**：英文原样嵌进中文段（K2 的 Qwen 编码器双语都吃）。
 *   翻译就是二次加工，改一个颜色等于换一件衣服 —— 服装属人设主权区。
 */
/**
 * removed 状态却没有 bare 记录时的兜底裸露锚点（英文，与 style 同语种）。
 * 宁可写得笼统也不能不写 —— 不写等于默许模型把他画回穿衣服的样子。
 */
export const BARE_FALLBACK = 'completely nude, wearing nothing';

/**
 * v0.9.98：SD 服装「回落成 K2 自然语」的提示去重（每角色只提示一次，别每楼刷屏）。
 * 放在这里而不是 anchorOf 内，是因为 anchorOf 是无状态纯函数、每张图都会调。
 */
const SD_OUTFIT_WARNED = new Set();

/** 英文动作句里已经出现过的裸体提示词（用于避免重复权重）。 */
const BARE_HINT_RE = /\b(naked|nude|bare|barely|topless|exposed|stripped|bottomless)\b/i;

/**
 * 人物段的服装子句（v0.9.42 引入机械注入，v0.9.45 补上裸露那一半）。
 *
 * ★★ 为什么 removed 必须写点什么（用户实测踩的坑）：
 * 旧版 removed 直接 return '' —— 人物段只剩外貌，**画面里没有任何"他没穿衣服"的信息**。
 * 于是英文动作句由模型自由发挥，它凭印象写回 "he stands in his hoodie"，
 * 视觉上就变成「上一段已经脱光了，这一段又穿上了」。NSFW 情节尤其明显。
 * 服装这种"有没有"的信息，不写 ≠ 中性，不写 = 交给模型默认他穿着。
 *
 * 所以服装必须是**双向锚定**：
 *   还穿在身上的 → 写「身穿 X」（style）
 *   已经露出来的 → 写裸露部位（bare）
 * 两半互补，任何一帧画面里人物的穿着状态都是被钉死的，没有给模型自由发挥的缝。
 */
/* ============ v0.9.58 出词体检硬闸（代码层，不依赖 LLM 自觉） ============ */
// 实测（2026-10-01 雾津五张）：同一份 spec，凌晨两张缺插入句 + 悬空托举（骨架库外自造
// 组合），下午三张五锚定齐 —— LLM 遵循随时间浮动，spec 文本压不住，必须在拼装前
// 用确定性正则体检 + 机械补丁。四道闸：悬空承重 / 双抓握 / 发色冲突 / 插入句强制。

/** NSFW 语境：cast 任意英文句带性器官词即视为性行为画面。 */
const NSFW_GENITAL_RE = /\b(cock|pussy|penis|erect(?:ion)?|cunt|crotch)\b/i;
/** 插入已声明的标志词。 */
const INSERTION_MARK_RE = /(?:inside\s+(?:her|him)|thrust|penetrat|from\s+behind|from\s+the\s+front|from\s+below)/i;
/** 悬空短语（骨架库外自造组合的头号形态，实测肢体扭曲/漂浮腿来源）。 */
const AIRBORNE_RE = /(?:lifted?\s+(?:clear\s+|up\s+)?o(?:ff|f)\s+(?:the\s+)?(?:floor|ground)|lifted\s+clear|held\s+upright|carried\s+(?:her|him)\s+up|suspended)/i;
/** 可读承重面：句里有这些词 = 有人体可靠的东西。 */
const SUPPORT_RE = /\b(?:wall|floor|ground|table|desk|counter|bed|mattress|sofa|couch|chair|lap|panel|partition|sink|windowsill|door(?:frame)?|weight\s+on|braced?|bracing|kneels?|kneeling|stands?|standing|sits?|sitting|lying|lies|lean(?:s|ing)?|planted|perch(?:es|ed)?)\b/i;
/** 衣物已脱离身体（挂在腿上 / 扒在一边）—— 不算穿着冲突。 */
const OFF_BODY_RE = /\b(?:torn|removed|hanging|pushed\s+(?:down|up|off)|pulled\s+(?:down|up|off)|bunched|around\s+(?:her|his|one)\s+(?:calves|calf|ankles?|thighs?|knees?|wrists?)|discarded|dropped|loosened)\b/i;
const HAIR_COLOR_RE = /\b(?:black|dark\s+brown|brown|golden|blonde|blond|red|auburn|silver|white|grey|gray|pink|blue|purple|green)\s+hair\b/gi;

/** 同部位服装互斥分桶：桶内多件并存就是「白丝+黑丝」型叠加（2026-10-01 用户定案要堵）。 */
const OUTFIT_SLOT_BUCKETS = [
  { slot: 'legwear', re: /\b(?:thigh[- ]?highs?|stockings?|pantyhose|tights?|knee(?:[- ]high)?[- ]socks?|over[- ]knee[- ]socks?|socks?)\b/i },
  { slot: 'underwear', re: /\b(?:panties|underwear|thong|briefs)\b/i },
  { slot: 'footwear', re: /\b(?:high[- ]?heels?|heels?|shoes|boots|loafers|sneakers|pumps|sandals)\b/i },
];

/**
 * 同部位服装互斥清洗：同一部位（袜 / 内裤 / 鞋）多件并存时只留**最后出现**的一件。
 * —— 叠加式描写（白丝基础上再写黑丝）会让两个颜色词一起进提示词，模型两头一起画。
 * 已脱离身体的衣物（torn / hanging around her calf）不算穿着冲突，原样保留。
 * 只清洗 outfit 文本，不碰外貌 / 状态字段。
 */
export function dedupeOutfitSlots(text) {
  const t = String(text || '').trim();
  if (!t) return t;
  const items = t.split(/\s*[,，]\s*/);
  const bucketLast = new Map();
  const itemSlots = items.map((it) => {
    if (OFF_BODY_RE.test(it)) return [];            // 已脱的不占桶
    const slots = [];
    for (const b of OUTFIT_SLOT_BUCKETS) if (b.re.test(it)) slots.push(b.slot);
    return slots;
  });
  itemSlots.forEach((slots, i) => { for (const s of slots) bucketLast.set(s, i); });
  const kept = items.filter((_, i) => {
    const slots = itemSlots[i];
    return !slots.length || slots.every(s => bucketLast.get(s) === i);
  });
  return kept.join(', ');
}

/* ============ v0.9.61 穿着 / 裸露互斥（实测「脱了却还半挂在身上」的根因） ============
 * 用户病例（2026-10-02 雾津）：周雅的服装段同时写着
 *   style: "grey thin cotton work vest, work pants with a drawstring waist, no bra, no underwear"
 *   bare : "bare breasts fully exposed, bottomless, naked lower body straddling him, ..."
 * —— 同一个下半身，style 说穿着工装裤、bare 说全裸。模型只能折中成「裤子半挂在胯上」，
 *   就是用户看到的「明明已经脱了，但是还半挂在身上」。
 *
 * 根因不是 AI 提取错了：AI 只会往 style 后面**追加** no underwear / bottomless，
 * 不会去删同部位已经脱掉的那件。旧版互斥清洗（dedupeOutfitSlots）只管 style 字符串
 * **内部**的同部位多件，且只有袜/内裤/鞋三个桶 —— 上装、下装根本没有桶，
 * 所以「穿着裤子 + 下身全裸」这种跨字段矛盾没有任何闸能拦。
 *
 * 修法：bare 里声明了某部位裸 → 从 style 里删掉该部位**正常穿着**的衣物。
 * ★ 例外必须保留：带脱离身体修饰的（pushed down around his knees / hanging / discarded）
 *   是剧情真的「半脱挂在腿上」，视觉上确实还在画面里 —— 那是合法状态，不能删。
 */
/** 下半身裸体声明（必须带部位指向，不能见了 naked 就判全裸）。 */
const BARE_LOWER_RE = /\b(?:naked|nude|bare|bottomless|stripped|exposed)\b[^.;]{0,40}?\b(?:lower\s+(?:body|half)|from\s+the\s+waist\s+down|waist\s+down|bottom\s+half|hips?|thighs?|pussy|crotch|legs?)\b|\bbottomless\b|\bnaked\s+lower\b|\bnaked\s+from\s+the\s+waist\b/i;
/** 上半身裸体声明。 */
const BARE_UPPER_RE = /\btopless\b|\bnaked\s+(?:chest|torso|to\s+the\s+waist)\b|\b(?:chest|torso)\s+(?:fully\s+)?(?:bare|naked|exposed)\b/i;
/** 下装（正常穿着时与下半身裸体互斥）。 */
const GARMENT_BOTTOM_RE = /\b(?:pants|trousers|skirt|shorts|jeans|leggings|sweatpants|sweat\s+pants|slacks|bottoms|chinos|bikini\s+bottoms)\b/i;
/** 上装（正常穿着时与上半身裸体互斥）。 */
const GARMENT_TOP_RE = /\b(?:blouse|shirt|sweater|hoodie|jacket|coat|vest|tank\s+top|crop\s+top|camisole|cardigan|t-shirt|tee|bra)\b/i;

/**
 * 按裸露声明删掉 style 里与之冲突的衣物（只删「正常穿着」的，半脱挂着的不动）。
 * 返回 { style, dropped } —— dropped 供调用方提示用户「这些件已按裸露声明撤下」。
 */
/* ============ v0.9.65 已脱衣物的残留清洗（用户病例：删了还长回来） ============
 * 用户病例（2026-10-03 雾津）：夜斗 outfit.style 里已经没有裤子了（用户手动删干净），
 * 但 outfit.bare 里还写着 "penis exposed, sweatpants and underwear pushed down around his thighs"，
 * state=removed。outfitClauseFor 把 bare 原样注入提示词 —— 于是裤子和内裤照样出现在画面上。
 *
 * 用户原话：「我把服装全删了保存，重新打开又添加进去；去掉的部位没去掉，又加上去」。
 * 删的是 style，长回来的是 bare —— 两个字段各管一半，只清一半等于没清。
 *
 * 修法按状态区分，不是一刀切：
 *   state='parted'（半褪）—— 衣服确实还挂在腿上/褪到膝盖，这是剧情要的半脱美学，**保留**；
 *   state='removed'（已脱下）—— 衣服不该再出现在画面里，bare 里的衣物名词**剥掉**，
 *                              只留真正的裸露部位；剥空了就走 BARE_FALLBACK（全裸）。
 *
 * ★ 为什么不是「加规则让模型别写」：这不是模型写错，是字段语义本来就允许 bare 记录
 *   脱掉的衣服（spec 3.9 明确要求）。矛盾出在「记录用」和「出图用」混用了同一份文本。
 *   在出图这一侧剥掉，档案里仍保留原文作为历史依据 —— 两边都不丢。
 */

/** 衣物名词（含内衣/袜/鞋/外套）—— 出现在 bare 里就说明「脱掉的衣服还在画面上」。 */
const BARE_GARMENT_RE = /\b(?:pants|trousers|sweatpants|sweat\s+pants|jeans|shorts|skirt|leggings|slacks|chinos|bottoms|underwear|panties|boxers|briefs|thong|bra|brassiere|hoodie|sweater|shirt|t-shirt|tee|blouse|jacket|coat|vest|cardigan|dress|uniform|apron|robe|habit|stockings?|socks?|tights|pantyhose|shoes|boots|loafers|heels|sneakers|sandals|flip-flops|gloves|hat|cap|scarf|tie|belt|zipper|fly|pocket|sleeve|collar|cuff|hem|waistband|drawstring)\b/i;

/** 已完全脱离身体（脱下 / 撕掉 / 扔掉 / 不再穿）—— 画面上不该再有这件。 */
const BARE_DETACHED_RE = /\b(?:removed|taken\s+off|pulled\s+off|torn\s+off|ripped\s+off|stripped\s+off|discarded|no\s+longer\s+worn|completely\s+off)\b/i;
/** 还挂在身上（褪到膝盖 / 堆在脚踝 / 推到腰上）—— 剧情真半脱，视觉上确实还在画面里。 */
const BARE_HANGING_RE = /\b(?:pushed\s+(?:down|up)|pulled\s+(?:down|up)|bunched|hanging|hooked|around\s+(?:her|his)\s+(?:calf|ankle|thighs?|knees?|wrist|waist|hips?)|loosened|slipped\s+down|slid\s+down)\b/i;

/**
 * 剥掉 bare 里「不该出现在画面上的衣物」描述，只留裸露部位。
 *
 * ★★ 用户定案（2026-10-03，雾津周雅病例）：
 *   bare = "naked from the waist down, bare C-cup breasts and nipples exposed,
 *           black work pants and underwear removed"  →  出图腿上套着工装裤。
 *   原因：裤子明明已经脱了，可提示词里还留着「工装裤」三个字，模型就照着画回去。
 *   用户原话：**直接写她裸露的部分，比写「具体某件服装脱下」要好**。
 *
 * 所以按「这件衣服现在到底在不在身上」分三档，而不是一刀切：
 *   ① 已完全脱离（removed / torn off / discarded …）—— **任何状态都剥掉**，
 *      画面上不该有它，写出来就是把它画回来（这就是周雅那条裤子的来源）。
 *   ② 还挂在身上（pushed down around his knees / bunched at her ankles / skirt pushed up）
 *      —— 视觉上确实还在画面里，且是用户要的半脱美学，**保留**。
 *      但 state='removed'（全脱）时连这档也剥掉 —— 都全脱了就不该有衣服挂着。
 *   ③ 否定式声明（no underwear / without bra）—— 那是「没穿」的声明，删了模型会补一件，保留。
 *
 * 剥空返回 ''（调用方会兜底成全裸）。
 */
export function stripGarmentFromBare(bare, state) {
  const t = String(bare || '').trim();
  if (!t) return '';
  const removed = String(state || '').toLowerCase() === 'removed';
  const kept = t.split(/\s*[,，;；]\s*/).filter(Boolean)
    .map((x) => x.trim()).filter(Boolean)
    .filter((seg) => {
      if (/^\s*(?:no|without|not)\s+/i.test(seg)) return true;   // ③ 否定式声明
      if (!BARE_GARMENT_RE.test(seg)) return true;               // 与衣物无关 → 原样
      if (BARE_DETACHED_RE.test(seg)) return false;              // ① 已脱下 → 删
      if (removed && BARE_HANGING_RE.test(seg)) return false;    // ② 全脱状态：挂着也删
      return true;
    });
  return kept.join(', ');
}

/**
 * ★★★ 全裸角色的「姿态」里，剥掉描述他自己衣物的子句（v0.9.132）。
 *
 * 与 `stripGarmentFromBare` 同一思路（都是「记录用」与「出图用」混用同一份文本），
 * 但对象不同：那个管 `bare` 字段，这个管 `condition`（姿态/动作）字段。
 *
 * ★ 为什么必须有这道闸：光在 spec 里写「姿态里不许出现衣物名词」不够 ——
 *   `condition` 是 AI 每轮自由写的自由文本，写错了没有任何东西会拦。
 *   而一处矛盾就足以毁掉整张图（模型挑错的那条听）。
 *
 * ★ 为什么保留「对方的衣物」：`one hand on her waist pulling the apron ribbon loose`
 *   里 apron 属于女主，那是**动作对象**，剥掉等于把互动删了。
 *
 * @param {string} text   condition 原文
 * @param {string} state  该角色 outfit.state
 * @param {string} sex    该角色性别字段（1boy / 1girl）
 */
function stripGarmentFromCondition(text, state, sex) {
  const t = String(text || '').trim();
  if (!t) return '';
  if (String(state || '').toLowerCase() !== 'removed') return t;
  const isMale = /1boy|male|boy/i.test(String(sex || ''));
  const maleRe = /\b(?:his|him|he|himself)\b/i;
  const femaleRe = /\b(?:her|hers|she|herself)\b/i;
  const kept = t.split(/\s*[,，;；]\s*/).filter(Boolean).filter((seg) => {
    if (!BARE_GARMENT_RE.test(seg)) return true;            // 与衣物无关 → 留
    const own = isMale ? maleRe.test(seg) : femaleRe.test(seg);
    const other = isMale ? femaleRe.test(seg) : maleRe.test(seg);
    if (other && !own) return true;                          // 明确是对方的衣物 → 留
    return false;                                            // 自己的 / 判不出 → 删
  });
  return kept.join(', ');
}

export function stripCoveredByBare(style, bare) {
  const items = String(style || '').split(/\s*[,，]\s*/).filter(Boolean);
  const b = String(bare || '');
  const lowerNaked = BARE_LOWER_RE.test(b);
  const upperNaked = BARE_UPPER_RE.test(b);
  if (!lowerNaked && !upperNaked) return { style: String(style || ''), dropped: [] };
  const kept = [];
  const dropped = [];
  for (const it of items) {
    if (OFF_BODY_RE.test(it)) { kept.push(it); continue; }
    // 否定式（no bra / no underwear）撤掉就变成「没声明」→ 模型默认给补一件回来
    if (/^\s*(?:no|without|not)\s+/i.test(it)) { kept.push(it); continue; }
    if (lowerNaked && GARMENT_BOTTOM_RE.test(it)) { dropped.push(it.trim()); continue; }
    if (upperNaked && GARMENT_TOP_RE.test(it)) { dropped.push(it.trim()); continue; }
    kept.push(it);
  }
  return { style: kept.join(', '), dropped };
}

/**
 * v0.9.61 tag 末句（情绪句）与人物段的**跨段**肢体重复清洗。
 *
 * ★ 用户实测病例（2026-10-02 雾津 · 结城太太开门那张）：
 *   人物段（单人图，只有她）：
 *     "one hand holding an empty trash bin and the other turning a brass spare key in the lock"
 *   tag 末句情绪：
 *     "She looks stunned and betrayed, ..., her breath caught and her fingers white-knuckled around the key."
 *   —— 两只手在人物段已经各就各位，情绪句又把 fingers 说了一遍，模型按**第三只手**去补。
 *   这就是「单人图也画出 3 只手」的成因，和双人不双人无关。
 *
 * 之前的清洗全在**单段内部**做（细数手指降级 both hands、双抓握删 waist），
 * 跨段（人物段 vs tag）这一层完全没人管 —— 而重复 = 实体复制是本项目的头号崩图机理。
 *
 * 做法：人物段里出现过的肢体名词，tag 里再出现的那个分句直接删。
 * 保护：删到一句不剩时放弃（宁可留着重复，也不能把情绪句删空）。
 */
/**
 * 肢体词归一到类别 —— hand / fingers / palm / wrist 是同一只手的不同说法，
 * 按精确词比对等于没查（实测「人物段写 hand、情绪句写 fingers」整批漏过）。
 */
function limbClassOf(w) {
  const x = String(w || '').toLowerCase();
  if (/^(hand|hands|finger|fingers|palm|palms|thumb|thumbs|wrist|wrists)$/.test(x)) return 'hand';
  if (/^(arm|arms|elbow|elbows)$/.test(x)) return 'arm';
  if (/^(leg|legs|knee|knees|thigh|thighs|foot|feet|ankle|ankles|shin|shins)$/.test(x)) return 'leg';
  return '';
}

export function stripLimbsDeclaredInCast(tag, castText) {
  const LIMB_SRC = '\\b(hand|hands|finger|fingers|palm|palms|thumb|thumbs|wrist|wrists|arm|arms|elbow|elbows|leg|legs|knee|knees|thigh|thighs|foot|feet|ankle|ankles|shin|shins)\\b';
  const declared = new Set();
  const reCast = new RegExp(LIMB_SRC, 'gi');
  let m1;
  while ((m1 = reCast.exec(String(castText || '')))) {
    const c = limbClassOf(m1[1]);
    if (c) declared.add(c);
  }
  if (!declared.size) return { tag: String(tag || ''), removed: [] };
  const parts = String(tag || '').split(/,\s*/);
  const kept = [];
  const removed = [];
  for (const p of parts) {
    const rePart = new RegExp(LIMB_SRC, 'gi');
    let dup = false;
    let m2;
    while ((m2 = rePart.exec(p))) {
      const c = limbClassOf(m2[1]);
      if (c && declared.has(c)) { dup = true; break; }
    }
    if (dup) removed.push(p.trim()); else kept.push(p);
  }
  if (!kept.length || !removed.length) return { tag: String(tag || ''), removed: [] };
  return { tag: kept.join(', '), removed };
}

/**
 * NSFW 出词体检：对 cast 锚点数组做确定性修正，返回 { anchors, notes }。
 * ① 悬空（托举/抱起无承重词）→ 追加靠墙承重锚；
 * ② 同区域双抓握（one hand…hip while the other…waist）→ 删抓腰分句；
 * ③ 发色冲突（英文句颜色 ∉ 档案 hair 颜色）→ 删色词；
 * ④ 男方句缺插入声明 → 按女方体位补标准骨架句（后入/仰躺前入/骑乘 from below）。
 * 评测基准：2026-10-01 真实出图 5 张中 3 张违规，全是这几类。
 */
export function auditNsfwAnchors(anchors, opts = {}) {
  // ★ 原地修改入参对象（processImage / regenerate 的调用方都直接持有这些 anchor 引用，
  //   拷贝式修改会让补丁静默丢失 —— v0.9.58 首版就栽在这上面，专项测试当场抓住）
  const list = Array.isArray(anchors) ? anchors : [];
  const notes = [];
  // NSFW 语境来源：cast 英文句 + 调用方补充文本（tag / 服装段）——
  // 真实病例（2026-10-01 P3）：器官词全在服装段（exposed erection），en 句一个没有，
  // 只看 en 会漏判整张图 → 插入句补丁永远不触发。
  const nsfwText = `${opts.nsfwText || ''} ${list.map(a => String(a.en || '')).join(' ')}`;
  if (!list.length || !NSFW_GENITAL_RE.test(nsfwText)) {
    return { anchors: list, notes };
  }

  const sexOf = (a) => String(a?.eff?.entry?.fields?.sex || '').toLowerCase();
  const isMale = (a) => /\b1boy\b|\bmale\b|\bman\b/.test(sexOf(a));
  const isFemale = (a) => /\b1girl\b|\bfemale\b|\bwoman\b/.test(sexOf(a));

  for (const a of list) {
    let en = a.en;
    if (!en.trim()) continue;

    /* ① 悬空 → 补靠墙承重。
       ★ 两个坑（都被真实病例踩过）：
       a) 先把**所有**悬空短语从句里剥掉再测承重词 —— 悬空句本身就写着「off the floor」，
          不剥的话 floor 会被误判成承重面（P6 病例漏检原因之一）；
       b) 剥离必须全局 —— 只剥第一处时第二处短语里的 floor 还会污染判定（P6 两处并存）。 */
    if (AIRBORNE_RE.test(en) && !SUPPORT_RE.test(en.replace(new RegExp(AIRBORNE_RE.source, 'gi'), ' '))) {
      en += ', her body braced against the wall beside them for support';
      notes.push(`「${a.name}」的动作句把人写悬空（托举/抱起无承重面）—— 已补靠墙承重锚（悬空 = 肢体扭曲/漂浮腿的头号来源）`);
    }

    /* ①-b 手指细节闸：细数手指（ten fingertips / each finger）是手指畸变的温床 ——
       扩散模型数不清十根手指，细写只会诱导它画出手部特写然后画崩（P6 病例）。
       机械降级成 both hands，动作语义不变。 */
    const fingerDetail = en.match(/\b(?:her\s+)?(?:ten|each|every|all\s+ten)\s+fingertips?\b|\b(?:her\s+)?ten\s+fingers\b/i);
    if (fingerDetail) {
      en = en.replace(fingerDetail[0], 'both hands');
      notes.push(`「${a.name}」的动作句细写了手指（${fingerDetail[0].trim()}）—— 已降级为 both hands（模型数不清十根手指，细写=诱导手部特写然后画崩）`);
    }

    /* ② 双抓握（hip + waist 同抓 → 两只手挤在一处）。
       逗号可有可无 —— 真实病例（P9）就是「into her hip while the other grips her waist」无逗号 */
    const dualGrip = en.match(/\b(one\s+hand\b[^,.;]*?\bhips?\b[^,.;]*?)\s*,?\s*(?:while|and)\s+the\s+other\s+(?:hand\s+)?(?:grips?|gripping|dug|digging|clamped?|clamping|holding|holds)\b[^,.;]*?\bwaist\b\.?/i);
    if (dualGrip) {
      en = en.replace(dualGrip[0], dualGrip[1]);
      notes.push(`「${a.name}」双手同时抓髋+抓腰（同一区域两个抓握点）—— 已删抓腰，保留单手`);
    }

    /* ②-b 单手抓腰（v0.9.61）。
       旧闸只拦「双手同时抓髋+抓腰」这一种写法，**单手抓腰整批漏过** ——
       实测 12 张里 4 张都写着 one hand gripping her waist。而总库硬规则是
       「他跪 / 坐时绝不抓腰」：腰部没有可读承重面，抓腰等于把手臂凭空架在中段，
       模型为了给这条手臂补出支撑，最常见的补偿方式就是多画一条。机械改判为抓髋。 */
    const waistGrip = en.match(/\b((?:one|his|a|the other)\s+hand\s+(?:gripping|grips|holding|holds|clamped?|clamping|clutching|resting|loose|pressed)\s+(?:at\s+|on\s+|around\s+|against\s+)?)her\s+((?:[a-z-]+\s+){0,2}?)waist\b/i);
    if (waistGrip) {
      en = en.replace(waistGrip[0], `${waistGrip[1]}her ${waistGrip[2]}hip`);
      notes.push(`「${a.name}」的手抓在她腰上（腰部没有可读承重面 → 手臂凭空架在中段 → 多肢体）—— 已改判为抓髋`);
    }

    /* ③ 发色冲突 */
    const baseHair = String(a?.eff?.entry?.fields?.hair || '').toLowerCase();
    if (baseHair) {
      const baseColors = new Set();
      for (const m of baseHair.match(new RegExp(HAIR_COLOR_RE.source, 'gi')) || []) {
        baseColors.add(m.replace(/\s+hair$/i, '').toLowerCase());
      }
      if (baseColors.size) {
        const seen = new Set();
        for (const m of en.match(new RegExp(HAIR_COLOR_RE.source, 'gi')) || []) {
          if (seen.has(m)) continue;
          seen.add(m);
          const c = m.replace(/\s+hair$/i, '').toLowerCase();
          const clash = ![...baseColors].some(bc => bc === c || bc.includes(c) || c.includes(bc));
          if (clash) {
            en = en.replace(new RegExp(`\\b${m.replace(/\s+/g, '\\s+')}\\b`, 'gi'), c === '' ? 'hair' : 'hair');
            notes.push(`「${a.name}」英文句写了与档案不符的发色（${m}，档案：${[...baseColors].join('/')}）—— 已删色词（自造外貌 = 人物漂移）`);
          }
        }
      }
    }
    a.en = en;
  }

  /* ④ 插入句强制：NSFW 画面男方句必须带插入声明。
     ★★ v0.9.61 整段重写（2026-10-02 雾津实测 12 张，7 张被补错了体位）
     旧结构是「命中骑乘词 → from below；命中仰躺 → from the front；否则 → from behind」。
     「否则后入」是个默认兜底，而真实动作句**经常不含** straddle / ride / lap 这几个词
     （实测写的是 lowers herself down onto his lap / sinking down onto him / impaled on him
     / her hips sunk down onto him），于是整批落进兜底被补成后入 ——
     与「她跨坐在他大腿上、面对面」的画面几何正好相反。
     K2 收到两个相反方向只能折中：把身体扭成不可能的角度，或多长一条腿一只手来同时满足。
     这就是「优化这么多次还是多肢体 / 扭曲」的主因 —— 后来加的那道闸自己在制造矛盾。
     新原则：**判不出方向就不补方向**（只声明插入事实，绝不猜一个可能相反的方向）。 */
  const males = list.filter(isMale);
  const females = list.filter(isFemale);
  if (males.length === 1 && females.length >= 1) {
    const male = males[0];
    if (String(male.en || '').trim() && !INSERTION_MARK_RE.test(String(male.en || ''))) {
      const fEn = `${females.map((f) => f.en).join(' ')} ${male.en}`;
      // ④-0 非插入行为（乳交 / 口交 / 手交）一律不补 —— 补了等于把两种行为写进同一张图
      const NON_PENETRATIVE_RE = /\b(?:around\s+(?:his|her)\s+(?:shaft|length|cock|penis)|between\s+(?:her|his)\s+(?:breasts|thighs)|(?:her|his)\s+(?:mouth|lips|tongue)\s+(?:on|around|at)\s+(?:his|her|him)\b|sucking|licking|blowjob|fellatio|stroking\s+him|pumping\s+him|handjob|masturbat)/i;
      if (NON_PENETRATIVE_RE.test(fEn)) {
        notes.unshift(`「${male.name}」这一格是非插入行为（乳交 / 口交 / 手交）—— 不补插入句（补了等于把两种行为同时写进一张图）`);
      } else {
        // ④-1 后入：必须**显式**写了后入信号才认（狗趴 / 背对他 / bent over）
        const DOGGY_RE = /\b(?:from\s+behind|doggy|doggie|on\s+all\s+fours|hands\s+and\s+knees|bent\s+over|bent\s+forward|rear\s+entry|her\s+back\s+(?:turned\s+)?to\s+him|facing\s+away|turned\s+away\s+from\s+him|behind\s+her|face[- ]first)\b/i;
        // ④-2 骑乘 / 面对面跨坐：正则放宽到实测出现过的全部写法
        const RIDE_RE = /\b(?:straddl\w*|rides?|riding|cowgirl|on\s+(?:his|her)\s+lap|sits?\s+(?:down\s+)?on\s+(?:his|her)|sinking\s+(?:down\s+)?onto|sinks?\s+(?:down\s+)?onto|lowers?\s+herself|impaled\s+on|astride|kneels?\s+(?:over|above|astride)|(?:hips?|weight)\s+(?:dropped|sunk|sinking)\s+(?:down\s+)?(?:onto|on))\b/i;
        // ④-3 仰躺前入（要求 lying/supine/beneath 前缀 —— 光是「on her back」会撞上
        //      「his hands flat on her back」这种完全无关的写法）
        const SUPINE_RE = /\b(?:lying\s+(?:flat\s+)?on\s+(?:her\s+)?back|lies\s+on\s+(?:her\s+)?back|supine|beneath\s+him|underneath\s+him|pinned\s+(?:beneath|under)|missionary)\b/i;
        let insert;
        let how;
        if (DOGGY_RE.test(fEn)) {
          insert = 'his hips aligned with hers, his pelvis pressed against her pelvis, his cock thrusting deep into her pussy from behind';
          how = '后入';
        } else if (RIDE_RE.test(fEn)) {
          insert = 'his hips aligned with hers, his pelvis pressed against her pelvis, his cock inside her pussy, penetrating her from below';
          how = '骑乘·女上';
        } else if (SUPINE_RE.test(fEn)) {
          insert = 'his hips aligned with hers, his pelvis pressed against her pelvis, his cock thrusting deep into her pussy from the front';
          how = '仰躺前入';
        } else {
          insert = 'his hips aligned with hers, his pelvis pressed against her pelvis, his cock buried deep inside her pussy';
          how = '方向未判出，只声明插入不猜方向';
        }
        male.en = `${male.en.replace(/[.;\s]*$/, '')}; ${insert}`;
        notes.unshift(`「${male.name}」的动作句没写插入（NSFW 画面缺插入声明 → 模型自由发挥 = 器官错位/多肢体）—— 已补骨架句（判为${how}）`);
      }
    }
  }

  return { anchors: list, notes };
}

/**
 * v0.9.63 英文句标点规范化（纯函数，导出供测试）：
 *   ① 句末中文句号「。」→ 英文句点「.」（「。」是 CJK token，英文串后挂它是异类 token）；
 *   ② 英文句末尾没有任何标点 → 补「.」（句边界不清，编码器易把相邻行粘连）；
 *   ③ 只动句尾，不碰句中标点（句中的「；」等由 outfitClauseFor 自行处理）。
 * 只对「以 ASCII 收尾」的文本生效 —— 中文人物段行（以汉字收尾）不受影响。
 */
export function normalizeEnPunct(s) {
  let t = String(s || '').replace(/[。\s]+$/, '');
  if (!t) return '';
  if (/[A-Za-z0-9)]$/.test(t)) t += '.';
  return t;
}

function outfitClauseFor(eff, en) {
  const o = eff?.dyn?.outfit || {};
  // v0.9.58 同部位互斥清洗：存量档案句里「白丝+黑丝」并存的，出图前删到只剩最后一件
  const deduped = dedupeOutfitSlots(String(o.style || '').trim());
  const state = String(o.state || '').toLowerCase();
  const bare = String(o.bare || '').trim();
  // v0.9.61 穿着 / 裸露互斥：bare 声明这个部位裸着 → 撤下 style 里还穿着的同部位衣物。
  // 留着就是「明明已经脱了，却还半挂在身上」（模型折中成半挂 / 半透明的裤子）；
  // 带脱离身体修饰的那件（pushed down around his knees）是剧情真半脱，会被保留。
  const style = stripCoveredByBare(deduped, bare).style;

  /* ① 还在身上的衣服 */
  const removed = state === 'removed';
  // removed：人身上已经没有这件了，写「身穿 X」是自相矛盾
  const wear = (removed || !style || outfitMentionedIn(style, en)) ? '' : `身穿 ${style}`;

  /* ② 裸露部位 —— removed 却没有 bare 时兜底，绝不留白 */
  // v0.9.65：removed 时 bare 里「脱掉的衣服」不该再出现在画面上（用户删了它还会长回来），
  // 出图前剥掉；parted 是剧情要的半脱挂着，原样保留。
  let skin = stripGarmentFromBare(bare, state);
  if (!skin && removed) skin = BARE_FALLBACK;
  if (skin && BARE_HINT_RE.test(en || '')) skin = ''; // 动作句已经写明裸体 → 不重复
  const skinClause = skin ? skin : '';

  // v0.9.63：英文服装/裸露串收尾改英文标点（原来挂中文「。」/「；」—— CJK token 混进英文串）
  if (wear && skinClause) return `${wear}; ${skinClause}.`;
  if (wear) return `${wear}.`;
  if (skinClause) return `${skinClause}.`;
  return '';
}

/**
 * 存量 nlProfile 兼容清洗（2026-09-27，拼装时进行、不改用户存的数据）。
 * 旧版 AI 撰写器规则是「性别写成成年女性/成年男性」，存量档案普遍以「一位成年女性」开头
 * ——「成年」二字会把脸画老、体型画壮（实测核心崩因）。要求用户逐个重新生成不现实，
 * 这里做一次机械改写：只动措辞，不碰任何设定内容。
 *   「一位成年女性，金色长卷发…」→「一位女性，金色长卷发…」
 * 用户手写的「一位少女」「一位成熟的女性」等正确措辞原样保留。
 */
function cleanProfileLead(s) {
  return String(s || '').replace(/成年(?=女性|男性|女人|男人)/g, '');
}

/* ============ 年龄锚定一致化（v0.9.30） ============ */

/**
 * 英文句里的「年龄 + 身份/种族」概括词（`adult man` / `adult fairy` …）。
 * 只匹配「adult + 一个英文词」的形态，不碰 `adult content` 这类无关用法。
 */
const ADULT_IDENTITY_RE = /\badult\s+([a-z][a-z-]*)/gi;

/**
 * 这个角色该用哪一档年龄措辞？（三档，2026-09-28 定稿）
 *
 * 口径与 09-27 实测定稿一致（见 `aiProfileMessages` 的 ageRule）：
 *   外表年轻 → young；外表达观 → mature；**其余一律不写年龄词**（光杆 a man / a woman）。
 * `adult` 这个措辞本身被禁用 —— 实测「成年」把脸画老、体型画壮。
 *
 * 判定来源是**原始档案字段**（nlProfile / 锚点字段），不是清洗后的文本 ——
 * `cleanProfileLead` 会把「一位成年女性」洗成「一位女性」，用清洗后的文本判断会丢信息。
 *
 * @returns {{want:'young'|'mature'|'plain', why:string}} why = 命中的中文措辞，用于告警里说清依据
 */
function ageAnchorOf(eff) {
  const f = eff?.entry?.fields || {};
  const txt = `${String(f.nlProfile || '')} ${k2WhoLabel(eff)}`;
  // ① 外表年轻 —— 这一档绝不能写 adult，否则脸和体型都会被画老
  const young = /少年|少女|男孩|女孩|幼|萝莉|正太|teen|未成年|学生|年轻/.exec(txt);
  if (young) return { want: 'young', why: young[0] };
  // ② 外表达观（成熟 / 年长 / 中年）——「成熟」是有效年龄信息，要如实写 mature
  const mature = /成熟|年长|中年|熟女|熟男|御姐/.exec(txt);
  if (mature) return { want: 'mature', why: mature[0] };
  // ③ 其余（含档案写「成年 / 成人」这种纯合规声明、以及压根没写年龄）
  //    → 光杆名词，不写年龄词。「成年」二字只是合规声明，不是外表年龄信息，
  //      且它进提示词就会把脸画老（09-27 实测核心崩因）。
  return { want: 'plain', why: '' };
}

/**
 * 把英文句里的年龄锚定改写成与人物段一致的措辞。
 *
 * 存在的原因（2026-09-28 用户实测翻车）：档案写「夜斗：一位少年…」，
 * 英文句却写 `The adult man stands...` —— 两处年龄打架，模型按更具体的那句走，
 * 出图是成年男子，与人设的少年判若两人。
 * 根子在旧 spec 里「`adult` 一词不可丢」是硬条款，模型被逼着写冲突的年龄词。
 *
 * 2026-09-28 二修：原来只处理「少年 → young」，无年龄措辞的角色仍保留 adult；
 *   用户当场指出「为啥不是写一位男子或者一位男性」——「成年」这个说辞本身就要去掉。
 *   现按三档处理：young / mature / plain（plain = 删掉 adult，只留 `a man`）。
 *
 * 只改**年龄限定词**，不动身份名词（man / woman / fairy 照旧）——
 * 名词跟种族走，那是另一条规则，不能顺手改坏。
 *
 * @param {string} en 该角色的英文句
 * @param {object} eff 该角色的生效档案
 * @returns {{en:string, changed:string[], to:string, why:string}}
 */
export function alignAgeAnchor(en, eff) {
  const src = String(en || '');
  if (!src) return { en: src, changed: [], to: '', why: '' };
  const { want, why } = ageAnchorOf(eff);
  // 三档都只在句里真出现 `adult` 时才动手 —— 模型没写就不打扰（避免无谓告警）
  const changed = [];
  const out = src.replace(ADULT_IDENTITY_RE, (m, noun) => {
    changed.push(`「${m}」`);
    // plain 档：删掉 adult，只留身份名词（`The adult man` → `The man`）
    return want === 'plain' ? noun : `${want} ${noun}`;
  });
  if (!changed.length) return { en: src, changed: [], to: '', why };
  return { en: out, changed, to: want, why };
}

/* ============ 附加：画面体检 ============ */

const NEGATION_RE = /\b(no|not|without|except|missing)\s+[a-z]/i;
const STYLE_WORDS = [
  'masterpiece', 'best quality', 'high quality', 'ultra detailed', 'absurdres',
  'anime style', 'illustration style', '8k', '4k', 'highres', 'detailed',
];
/**
 * ★★★ v0.9.119：**MOSS 口径完全不查画风 / 质量词**。
 *
 * 用户两次明确交代（2026-10-21）：
 *   「MOSS 口径画风和负面那些不需要你加，我自己加到前后缀或者全局就行」
 *   「质量词也不需要，我可以前后缀自己加」
 * ⇒ 画风、质量词、负面提示词全部归用户的全局前缀 / 后缀，插件与出词模型都不碰。
 *
 * 于是 STYLE_WORDS 在 MOSS 下整块跳过，两个理由缺一不可：
 * ① 该不该有质量词由用户决定 —— 他自己往前缀里加是他的自由，插件没资格判他错；
 * ② 那张表还会误伤 MOSS 多格必需的结构句：第一句本来就写成
 *    `A vertical Japanese manga page divided into three panels …, clean anime line art.`，
 *    一旦命中 `anime style` / `detailed` 就报「写画风词会打架」，
 *    把用户引去删掉版面声明 —— 格子就散了。
 */

/**
 * ★★ v0.9.119：MOSS 下这些否定句是**规范要求的写法**，不许报警。
 * 依据（同一份模板 §5.2 原话）：
 *   「精确人数时区分主角与背景人群：「**只有两人、没有路人**」与「两个主角，背景人群不突出」
 *     是两种不同需求。」
 * 即 `no other people` / `no one else` 正是它推荐的「堵住多画人」手段，
 * 与 K2 那条「否定句会被画成肯定」的经验不是一回事（K2 的编码器不擅长否定，
 * MOSS 的自然语理解强得多，而模板本身就把它当标准写法用）。
 */
const MOSS_NEGATION_OK_RE = /\bno\s+(?:text\s+in\s+this\s+panel|other\s+(?:people|person|persons|characters?|figures?|passers?-?by)|one\s+else|others?|crowd|bystanders?|extras?|onlookers?)\b|\bwithout\s+(?:other|any)\s+(?:people|person|characters?)\b/gi;
const PALE_WORDS = ['pale skin', 'fair skin', 'porcelain skin', 'milky skin'];

/**
 * 画面体检：把已知会坏事的写法挑出来，报给诊断面板。
 * 不阻断生成（用户可能有意为之），只提示。
 *
 * @param {string[]} librarySkins 档案库里已登记的肤色值。
 *   与档案库一致的肤色不算问题（模型是照档案库写的，档案库属人设主权区）；
 *   只有档案库里没有、模型自己加的肤色词才报。
 * @param {object} [opts]
 * @param {boolean} [opts.skipAnchors] K2 三明治下外貌在中文人物段（不在 tag 里），
 *   hair/eyes 缺失检查会误报 —— 跳过。
 */
export function lintTag(tag, knownNames = [], librarySkins = [], opts = {}) {
  const notes = [];
  const t = String(tag || '');
  const lower = t.toLowerCase();
  /**
   * ★★★ v0.9.119：MOSS 口径下这三项体检全部要换判据 —— 它们原本是 SD/K2 的经验，
   *   对着 MOSS 会报出**与规范相反**的建议（详见 MOSS_QUALITY_WORDS / MOSS_NEGATION_OK_RE 的注释）。
   *   调用方传 `moss: true`（processImage 里 activeEngine() === 'moss'）。
   */
  const isMoss = opts.moss === true;

  /**
   * ★ v0.9.117：`No text in this panel.` 是本项目 MOSS 口径规定的「干净格」写法，
   *   先剔掉再跑否定句检测 —— 否则每张多格图都会误报一次「检测到否定句 No t…」，
   *   把用户引去改一句本来就该这么写的话。
   * ★★ v0.9.119：MOSS 下 `no one else in the frame` / `no bystanders` 同样先剔
   *   —— 那是我们 §1.1 自己要求模型写的「堵住多画人」句式（依据模板 §5.2）。
   */
  const negSrc = isMoss
    ? t.replace(MOSS_NEGATION_OK_RE, ' ')
    : t.replace(/\bno\s+text\s+in\s+this\s+panel\b/gi, ' ');
  const neg = NEGATION_RE.exec(negSrc);
  if (neg) {
    notes.push(isMoss
      ? `检测到否定句「${neg[0]}…」—— 建议改成正面描写你要的东西（MOSS 对否定句的遵循不如自然语肯定句稳）`
      : `检测到否定句「${neg[0]}…」—— 生图模型常把它画成肯定，建议改为不写该内容`);
  }

  if (!isMoss) {
    const styles = STYLE_WORDS.filter(w => lower.includes(w));
    if (styles.length) {
      notes.push(`检测到画风/质量词 ${styles.join(' / ')} —— 工作流里已有 LoRA，写画风词会打架`);
    }
  }

  // 与档案库登记的肤色一致 → 模型照档案库写的，没问题；只有自作主张的才报
  const skins = (Array.isArray(librarySkins) ? librarySkins : [])
    .map(s => String(s || '').toLowerCase()).filter(Boolean);
  const pale = PALE_WORDS.filter(w => lower.includes(w) && !skins.some(s => s.includes(w)));
  if (pale.length) {
    notes.push(`检测到肤色词 ${pale.join(' / ')} —— 档案库 skin 字段里没有这个值，`
      + `肤色应以档案库为准，不要自行添加`);
  }

  /**
   * ★★★ v0.9.119：MOSS 下**不报**「改用 @引用」。
   *   MOSS 口径禁用 `@角色名`（`@` 在这条链路上没有展开出口），
   *   而官方模板 §5.1 明确允许「IP 创作写角色名与作品名」、§1.1 允许保留有辨识度的原名。
   *   旧提示「应改用 @XX 引用」在 MOSS 下是**反向指导**：照着改等于把一段有效描述换成噪声。
   */
  for (const n of knownNames) {
    if (n && n.length >= 2 && t.includes(n)) {
      notes.push(isMoss
        ? `tag 里出现了角色名「${n}」—— MOSS 口径允许角色名（官方模板 §5.1），但它只对 IP 角色有意义；`
          + `本项目走「外貌由人物段注入」，原创角色建议改用 the girl / the tall young man 这类可见指代`
        : `tag 里出现了角色名「${n}」—— 人名会污染画面，应改用 @${n} 引用`);
    }
  }

  if (!opts.skipAnchors) {
    const anchorsMissing = REQUIRED_ANCHORS.filter(a => {
      if (a === 'hair') return !/\bhair\b/i.test(t);
      if (a === 'eyes') return !/\beyes\b/i.test(t);
      return false;
    });
    if (anchorsMissing.length && t.trim()) {
      notes.push(`缺少必填锚点：${anchorsMissing.map(a => ANCHOR_FIELD_LABEL[a]).join('/')}`);
    }
  }

  return notes;
}

/* ============ 附加：单张图完整处理管线 ============ */

/**
 * 出场集合的「总览人数词」（`1boy, 1girl` / `2girls`）。判不出返回空串。
 *
 * 用户手写的不串样例第一行就是 `1boy, 1girl, hetero, …` ——
 * 总览段负责把「这张图里有几个人」定在第 1 块，角色段再各自重复自己的单数。
 */
function overviewCountTag(anchors) {
  let g = 0;
  let b = 0;
  let o = 0;
  for (const a of anchors || []) {
    const m = /^1(girl|boy|other)\b/i.exec(String(a?.text || '').trim());
    if (!m) continue;
    const k = m[1].toLowerCase();
    if (k === 'girl') g += 1;
    else if (k === 'boy') b += 1;
    else o += 1;
  }
  const out = [];
  if (b) out.push(b === 1 ? '1boy' : `${b}boys`);
  if (g) out.push(g === 1 ? '1girl' : `${g}girls`);
  if (o) out.push(o === 1 ? '1other' : `${o}others`);
  return out.join(', ');
}

/**
 * 去重时保护指定串整体不被拆散。
 *
 * ★ v0.9.96：`dedupeTag` 是全局按逗号去重 —— 两个角色都写 `black hair` 时，
 *   第二个角色的锚点串被削短，于是 `tag.includes(anchorText)` 恒不成立，
 *   SD 分块静默退化。这正是「SD 编排改了没反应」的第二层原因
 *   （第一层是读错了字段名 anchors/anchorList）。
 *
 * 做法：先把每个锚点串换成占位符，去重完再还原 —— 锚点区不参与跨角色去重。
 * ⚠ 占位符不能用 NUL（会把文件变成二进制，grep 直接判废），用 `#HLA0#` 这种可读形式。
 */
function dedupeTagKeepingAnchors(text, protectedTexts = []) {
  let s = String(text ?? '');
  const stash = [];
  for (const t of protectedTexts) {
    const v = String(t ?? '').trim();
    if (!v) continue;
    const key = `#HLA${stash.length}#`;
    if (!s.includes(v)) continue;
    s = s.split(v).join(key);
    stash.push(v);
  }
  /**
   * ★ 锚点串内部出现过的 token，在外面再出现就是重复 —— 直接丢掉。
   *
   * 实测病例（v0.9.96 回归）：模型 tag 里写了 `1girl`，锚点段首也有 `1girl`
   * → 拼出 `1girl, 1girl`，正向权重翻倍（项目一直在防的就是这个）。
   * 同理 `black hair` 这类：锚点里已有一份，模型再写一遍＝实体复制。
   */
  const inner = new Set();
  for (const v of stash) {
    for (const tok of v.split(',')) {
      const k = String(tok).trim().toLowerCase();
      if (k) inner.add(k);
    }
  }
  const kept = [];
  for (const raw of s.split(',')) {
    const t = raw.trim();
    if (!t) continue;
    if (t.startsWith('#HLA')) { kept.push(t); continue; }
    if (inner.has(t.toLowerCase())) continue;
    kept.push(t);
  }
  let out = dedupeTag(kept.join(', '));
  for (let i = 0; i < stash.length; i += 1) out = out.split(`#HLA${i}#`).join(stash[i]);
  return out;
}

/**
 * Layout 草稿里「画面里出现的人」——名字清单（还没归一化）。
 *
 * 两条来源必须分开：
 *   ① 漫画草稿：人物写在 `panels[].cast`，用 `mangaDraftCast` 汇总（含 narrator 代词替换）；
 *   ② 旧单图 layout：`layout.cast` 是扁平数组（字符串或 `{name}`）。
 */
function layoutCastNames(lay) {
  if (isMangaDraft(lay)) return mangaDraftCast(lay, getConfig()?.mossJson?.narrator);
  const arr = Array.isArray(lay?.cast) ? lay.cast : (lay?.cast == null ? [] : [lay.cast]);
  return arr
    .map(v => String((v && typeof v === 'object' ? v.name : v) || '').trim())
    .filter(Boolean);
}

/**
 * 给 Layout 输出出口构造 `castLines`（`[{name, full, face}]`，供 `looksResolver` 查询）。
 *
 * ★★★ v0.9.142 新增，修的是「人物外貌/服装全崩」：`processImage` 在
 *   `activeOutput() === 'layout'` 时**在最开头短路返回**，而 `castLines` 是下面
 *   文本链路才构造的 ⇒ Layout 出口恒拿不到它 ⇒ `looksResolver(undefined)` 对任何名字
 *   都返回空 ⇒ 每一格一个外貌都不注入。受影响的是**所有 Layout 输出**，不只漫画页。
 *
 * 只收**档案里能对上的人**：查不到的人如果也塞进来，`mossCastParagraph` 会产出一句
 * 空壳（`The young woman.`）并被 `looksResolver` 当成真外貌注入 —— 那比不注入更糟。
 * 归一化先走 `resolveCastName`（正式名 / label / 分隔符前后缀），失败再补一次
 * 包含匹配 —— 卡片登记「夜斗」而模型写「神谷夜斗」时，精确匹配会把整条静默丢掉。
 */
/**
 * 一个角色在漫画页里的四条字幕（唯一构造点）。
 *
 * ★★★ v0.9.146：**必须只有一个构造点**。
 *   `castLines` 有两条出口 —— 文本链路（`composePrompt` 前面那段）和
 *   Layout 出口（`layoutCastLinesOf`）。v0.9.142 就是因为只补了一条，
 *   整批 Layout 图「每格外貌全灭」。这次加 `wear` / `detail` 又差点重犯：
 *   Layout 出口那条仍返回旧的 `{name, full, face}` ⇒ 脸部格照样不注入服装。
 *   ⇒ 抽到这里，谁要 `castLines` 都从这里拿。
 */
function mangaCastLineOf(a) {
  const full = mossCastParagraph([a]).trim();
  const face = mossFaceLine(a).trim();
  /** 脸部近景格的一句话服装锚（见 `mossWearLine` 病例）。 */
  const wear = mossWearLine(a).trim();
  /**
   * 局部特写格：只给「是谁 + 穿的什么」，**不给五官**。
   * 病例：detail 写 `only her legs` 时被画成**路人的腿** —— 这一格拿不到
   * 任何"属于她"的线索。给裙色 / 肤色即可绑定，又不能给整张脸
   * （给了就会退化成中景，见 `mossFaceLine` 注释）。
   */
  const detail = wear
    ? `${a?.eff ? mossWhoLabel(a.eff) : 'The person'} ${wear}.`
    : face;
  return { full, face, wear, detail };
}

function layoutCastLinesOf(lay, snapshot, positional, lineIndex) {
  const out = [];
  const seen = new Set();
  /* ★ `namesOf` 返回的是 Set（不是数组）—— 这里必须展开，`Set.find` 不存在。 */
  const pool = [...namesOf(snapshot, positional)];
  for (const raw of layoutCastNames(lay)) {
    const name = resolveCastName(raw, snapshot, positional)
      || pool.find(n => n.includes(raw) || raw.includes(n))
      || null;
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const a = { name, eff: effectiveOf(name, snapshot, positional, lineIndex), en: '' };
    const lines = mangaCastLineOf(a);
    if (!lines.full && !lines.face) continue;
    out.push({ name, ...lines });
  }
  return out;
}

/**
 * 把一张图的原始输出，走完整套一致性处理。
 *
 * @param {object} image  { position, tag, nl, scene, cast }
 * @param {object} ctx    { snapshot, positional, lineIndex, knownNames, presentNames }
 * @returns {{position, tag, nl, used, unknown, healed, notes, ok}}
 */
export function processImage(image, ctx) {
  const { snapshot, positional } = ctx;
  const lineIndex = ctx.lineIndex ?? Infinity;
  /**
   * ★ v0.9.117：改名 isK2 → isNatural。MOSS 口径同样走「外貌移出 tag + 中文段按位拼装」，
   *   所以判据是「**非 SD**」而不是「等于 k2」。留着旧名会让下一个人以为 MOSS 没走这条分支。
   */
  const isNatural = activeEngine() !== 'sd';
  /**
   * ★★★ v0.9.119：单独拎一个 `isMoss`。
   *   起因（用户 2026-10-21）：「K2 里不少逻辑在 MOSS 里不适用，你还不如多参考官方文档
   *   + 我发你的那个 MOSS二次元提示词模板_sfw版」。
   *
   *   判据口径：只有能贴出**官方 USERGUIDE 或那份模板原文**的规则才允许改；
   *   判不了的一律保持原样。下面每一处 `isMoss` 都带引用。
   *
   *   注意：`isNatural` 是「非 SD」，MOSS 也在里面 —— 所以 ③c 人数剥除 / ⑥b 篇幅自检 /
   *   跨段肢体闸这三条 K2 规则原来**默认也会吃 MOSS**，见下面各自的注释。
   */
  const isMoss = activeEngine() === 'moss';

  /**
   * ★★★ v0.9.121：Layout 输出格式**在函数最开头短路**。
   *
   * 为什么不在下面到处加 `if (isLayout) continue`：
   *   这个函数有 10 多道清洗闸（expandRefs / 锚点自愈 / tidySeparators / 去重 /
   *   formatMossPrompt / injectMossCast …），它们全部建立在「tag 是一段画面词文本」之上。
   *   Layout 是一份 **JSON 文档** —— 每过一道闸就被拆坏一处，而只要漏判一道，
   *   症状就是「JSON 少个括号 / 台词变空 / 坐标消失」，排查成本极高。
   *   ⇒ 一条独立出口，与文本链路彻底隔离，以后文本链路再加规则也不会污染它。
   *
   * 仍然保留的前置工作：cast 已在 protocol.normalizeImages 归一化过；这里只做坐标编译
   * （编译要读**实际画布尺寸**，那是 backend 的设置，只有到 composePrompt 才拿得到）。
   */
  if (activeOutput() !== 'text') {
    const lay = (image?.layoutJson && typeof image.layoutJson === 'object') ? image.layoutJson : null;
    const notes0 = [];
    if (!lay) notes0.push('模版是 JSON 输出格式，但模型没有给 layout 对象 —— 这张图无法出图');
    return {
      position: image?.position,
      tag: '', nl: '', scene: '', mood: '', cast: '', castEn: '', costume: '',
      anchorList: [], used: [], unknown: [], healed: [], notes: notes0,
      ok: !!lay,
      layoutJson: lay,
      /**
       * ★★★ v0.9.142：**这个出口必须自己产出 `castLines`**。
       *
       * 病例（2026-10-28 催眠APP 新聊天第 5 楼）：这个分支在函数最开头
       * short-circuit 返回，而 `castLines` 是下面文本链路（v0.9.140 加漫画页时）
       * 才构造的 ⇒ Layout 出口恒拿不到它 ⇒ `composePrompt` 里
       * `looksResolver(undefined)` 对任何名字都返回空 ⇒ **每一格外貌/服装全灭**。
       * 症状是「同一个人每页长得不一样、服装乱换」，而草稿本身写得没错。
       *
       * 受影响的是**所有 Layout 输出**，不只漫画页 —— 这也是为什么光看
       * `buildMangaPage` 内部永远查不出问题：那段代码一直是对的。
       */
      castLines: layoutCastLinesOf(lay, snapshot, positional, lineIndex),
    };
  }

  let tag = String(image?.tag || '').trim();
  const nl = String(image?.nl || '').trim();
  // K2 三明治字段：scene=中文场景镜头段，mood=中文情绪收尾段（protocol.js 透传）
  let scene = String(image?.scene || '').trim();
  const mood = String(image?.mood || '').trim();
  const notes = [];

  // ⓪ scene 里混进来的「人物段模仿行」整行剥掉。
  // 实测（2026-09-27）：模型会无视「人物段由插件生成」的分工，自己往 scene 里写
  // `<user>：一位男性，黑色短发…`（宏在 parse 阶段已被剥掉，到这就是孤儿冒号开头）。
  // 它跟插件注入的人物段是重复权重，而且宏名一剥就剩「：一位男性」这种残行。
  // 只剥两类**确定无疑**的行：孤儿冒号开头 / 宏名开头 —— 不碰正常对话行。
  {
    const lines = scene.split('\n');
    const kept = [];
    let removed = 0;
    for (const line of lines) {
      const t = line.trim();
      if (!t) { kept.push(line); continue; }
      if (/^：/.test(t) || /^(?:<user>|<bot>|<char>|<persona>|<assistant>|<system>)\s*[:：]/i.test(t)) {
        removed += 1;
        continue;
      }
      kept.push(line);
    }
    if (removed) {
      scene = kept.join('\n').trim();
      notes.push(`scene 里混进了 ${removed} 行人物段（模型把「角色名：外貌」写进了场景段）—— 已剥除，人物段由插件从档案注入，重复写=权重翻倍`);
    }
  }

  // ⓪b cast 字段：模型点名的出场名单（档案正式名）+ 可选的每人英文动作句。
  // 这是「谁在画面里」的权威来源 —— 比让插件从英文句里猜「her 指谁」可靠得多。
  // 每人一句（name + en）是 v0.9.25 新增的「按角色分块」写法：
  //   菲：一位体型娇小的精灵，……。
  //   The tiny fairy hovers at his shoulder, both tiny hands held close at her sides.
  //   夜斗：一位男性，……。
  //   He sits on the bed edge, one hand braced at his side.
  // 外貌与该角色的动作/手位**同块出现**，B 角色不再被丢在段落末尾只用「一位男性」概括。
  const castItems = (Array.isArray(image?.cast) ? image.cast : [])
    .map(v => (v && typeof v === 'object'
      // offscreen 必须一起带过来（v0.9.28）——
      // 这里重建对象时漏掉它，等于 POV 图里画面外的人照样被注入外貌，
      // 实测就是「多出一个人 / 半截人」。protocol 层已做过键名归一，这里直读。
      // ★ v0.9.119 `look` 同一个坑：这是「没档案角色的外貌兜底」，
      //   重建时漏掉它 = 巡查员这类路人又被静默丢弃（D1/D2 断言当场抓到）。
      ? {
        name: cleanRefName(v.name),
        en: String(v.en || '').trim(),
        look: String(v.look || '').trim(),
        offscreen: Boolean(v.offscreen),
      }
      : { name: cleanRefName(v), en: '', look: '', offscreen: false }))
    .filter(v => v.name);
  // 非 K2（SD 口径）没有「中文人物段」这一层，cast 点名的角色走不了分块注入 ——
  // 转写成 @引用，让下面的 expandRefs 按老路把外貌锚点拼进 tag，避免点了名却没注入。
  if (!isNatural && castItems.length) {
    // offscreen 的人不转写 @引用 —— 引用是为了注入外貌，他不该入画（v0.9.28）。
    const named = castItems.filter(v => !v.offscreen).map(v => `@${v.name}`);
    if (named.length) tag = `${named.join(' ')} ${tag}`.trim();
  }

  const castUsed = [];
  const castUnknown = [];
  const castAnchors = [];
  const castLookUsed = [];     // 没档案、靠 cast.look 兜底的人物（v0.9.119）
  const offscreenNames = [];   // 在场但不入画（POV / 特写里只被提到的人）
  const ageNotes = [];         // 英文句与人物段的年龄措辞冲突（v0.9.30）
  for (const it of castItems) {
    const name = resolveCastName(it.name, snapshot, positional);
    if (!name) {
      /**
       * ★★★ v0.9.119：档案库里查不到，但模型给了 `look` → **走外貌兜底，不丢弃**。
       *
       * 用户原话：「假如这个巡查员没有档案，那应该也会自行根据正文编写一个巡查员外貌，
       * 然后写进最终提示词里对吧。」—— 这是他说得对的地方：
       * 正文里出场的人，没有档案也必须有人物段，否则 MOSS 只能自由发挥
       * （实测把他画成「第二个穿同款校服的女生」）。
       *
       * 只在 MOSS 口径下生效：K2 的中文人物段没有承接英文 look 的位置，硬塞会串口径。
       */
      const lk = String(it.look || '').trim();
      if (lk && activeEngine() === 'moss') {
        const nm = String(it.name || '').trim();
        if (nm && !castLookUsed.includes(nm)) {
          castLookUsed.push(nm);
          castUsed.push(nm);          // 也算「已点名」，避免下面的漏人告警把它算成漏
          castAnchors.push({ name: nm, eff: null, en: '', look: lk });
        }
        continue;
      }
      castUnknown.push(it.name);
      continue;
    }
    if (castUsed.includes(name)) continue;
    castUsed.push(name);
    // offscreen（v0.9.28）：只登记名单，不建锚点 ——
    //   外貌段 = 「请把他画完整」的指令；POV 图里注入画面外人物的外貌，
    //   就是命令模型把他也画出来（实测多出一个人 / 半截人）。
    //   名单仍要登记：④b 的「疑似漏人」告警要靠它排除，不算漏。
    if (it.offscreen) { offscreenNames.push(name); continue; }
    const eff = effectiveOf(name, snapshot, positional, lineIndex);
    const enRaw = it.en.replace(FINAL_REF_RE, '').trim();   // 引用记号不许进画面词
    // v0.9.30（0.9.32 二修为三档）：英文句的年龄锚定必须与人物段一致（见下方 alignAgeAnchor）。
    const aligned = alignAgeAnchor(enRaw, eff);
    if (aligned.changed.length) {
      const hits = aligned.changed.join('、');
      if (aligned.to === 'plain') {
        ageNotes.push(`「${name}」的英文句里 ${hits} —— 人物段没有年龄措辞，按定稿口径写光杆身份词就够；`
          + '`adult` 二字实测会把脸画老、体型画壮（09-27 实测核心崩因）。已删掉年龄词，只留身份名词。');
      } else {
        ageNotes.push(`「${name}」的英文句里 ${hits} —— 人物段写的是「${aligned.why}」，`
          + `两处年龄打架会把角色画成另一个人（实测：少年被写成 adult man → 出图是成年男子）。已按人物段改成 ${aligned.to}。`);
      }
    }
    castAnchors.push({ name, eff, en: aligned.en });
  }
  if (castUnknown.length) {
    notes.push(`cast 里点了档案库里没有的名字：${castUnknown.join('、')}（已忽略 —— 要么用档案里的准确角色名，`
      + `要么给他一项 \`{"name":"…","look":"A middle-aged man with …"}\` 让插件按 look 生成外貌段）`);
  }
  if (castLookUsed.length) {
    notes.push(`按 cast.look 生成外貌段（档案库里没有，按正文现编；建议同时在 changes 里 kind:"new" 建档）：${castLookUsed.join('、')}`);
  }
  if (offscreenNames.length) {
    notes.push(`按 POV / 不入画处理（不给外貌锚定，防止把他画进画面）：${offscreenNames.join('、')}`);
  }
  for (const n of ageNotes) notes.push(n);
  // v0.9.58 NSFW 出词体检（代码层硬闸）：悬空承重 / 双抓握 / 发色冲突 / 插入句强制。
  // LLM 遵循随时间浮动（同一天凌晨漏插入句+悬空、下午全齐），spec 文本压不住的部分在这里兜死。
  // nsfwText 把 tag + 各角色服装段一起给语境判定 —— 器官词常在服装段而不在动作句（P3 病例）。
  {
    // ★ audit 是**原地修改**设计（返回的 anchors 就是传入的同一数组引用）——
    //   这里绝不能 length=0 再 push 回去：那是把同一个数组清空后再展开它自己，
    //   人物段会永远为空（v0.9.58 首版刚犯过，parity 8 项假失败当场抓住）。
    const audit = auditNsfwAnchors(castAnchors, {
      nsfwText: [
        tag,
        ...castAnchors.map(a => a?.eff?.dyn?.outfit?.style),
        ...castAnchors.map(a => a?.eff?.dyn?.outfit?.bare),
      ].filter(Boolean).join(' '),
    });
    for (const n of audit.notes) notes.push(n);
  }
  // v0.9.63 英文句标点规范化（零成本，代码层机械改，不给 spec 加规则）：
  //   「。」是 CJK token，跟在英文串后面对文本编码器是异类噪声（2026-10-02 同种子对照：
  //   `plain underwear。` vs `plain underwear.`，后者肢体归属更干净）；
  //   英文句无结尾标点则句子边界不清，编码器容易把相邻行粘连。
  for (const a of castAnchors) {
    if (typeof a.en === 'string' && a.en.trim()) {
      a.en = normalizeEnPunct(a.en);
    }
  }
  // 「按角色分块」判定：只要有一人带了英文动作句，整段就按人分块
  const castGrouped = castAnchors.some(c => c.en);

  // ① @引用展开（K2 下只收集出场角色，不把锚点串拼进句子）
  const expanded = expandRefs(tag, snapshot, positional, lineIndex, { k2Cast: isNatural });
  tag = expanded.tag;
  // 锚点顺序：cast 点名的在前（模型声明的主次顺序），@引用补在后面。
  // offscreen 的人即使被 @引用也不给锚点 —— 他不入画（v0.9.28）。
  let k2Anchors = [...castAnchors, ...(Array.isArray(expanded.anchors) ? expanded.anchors : [])
    .filter(a => !offscreenNames.includes(a.name))]
    .filter((a, i, arr) => arr.findIndex(x => x.name === a.name) === i);
  if (expanded.unknown.length) {
    notes.push(`引用了档案库里不存在的角色：${expanded.unknown.join('、')}（已剥除，避免人名进画面）`);
  }
  if (expanded.stray.length) {
    notes.push(`tag 里有 ${expanded.stray.length} 处空 @引用（写了 @ 却没写名字），已剥除，锚点交给 ⑤ 自愈补`);
  }

  // ② 锚点自愈（K2 下自愈到的角色同样只进中文人物段）。
  //    usedNames 传入 cast 已点名的角色 —— cast 就是模型亲口说的「画面里有谁」，
  //    自愈不该再往里加人。presentNames 把候选池收窄到「本楼真正在场」的角色。
  const usedAll = [...new Set([...castUsed, ...expanded.used])];
  /**
   * ★ v0.9.117：MOSS 口径不做锚点自愈。
   *   自愈的产物只有两个出口：① 插回 tag（SD）② 进中文人物段（K2）——
   *   MOSS 走单串整段，两个出口都不存在，跑了也只会产出一句误导人的
   *   「无法自愈锚点——请先在档案编辑器里补全」。
   */
  const healedRes = activeEngine() === 'moss'
    ? { tag, healed: [], warned: [], anchors: [] }
    : healAnchors(tag, snapshot, positional, lineIndex, usedAll, {
      k2Cast: isNatural,
      presentNames: Array.isArray(ctx.presentNames) ? ctx.presentNames : null,
    });
  tag = healedRes.tag;
  if (Array.isArray(healedRes.anchors) && healedRes.anchors.length) {
    for (const a of healedRes.anchors) {
      // 自愈也不许把 offscreen 的人捞回来（v0.9.28）：他不算「漏锚定」。
      if (offscreenNames.includes(a.name)) continue;
      if (!k2Anchors.some(x => x.name === a.name)) k2Anchors.push(a);
    }
  }
  if (healedRes.healed.length) notes.push(`自动补上锚点：${healedRes.healed.join('、')}`);
  for (const w of healedRes.warned) notes.push(w);

  // ③ 剥掉混进 tag 的中文片段。
  //    实测踩坑：模型把状态位写成中文（"催眠状态中，瞳孔扩散…"）存进档案库，
  //    下一轮快照又把它原样注入 tag —— 生图模型不认中文，会当乱码 token 处理。
  //    中文描述该待在 nl 字段里，tag 必须是英文。
  /**
   * ★★★ v0.9.117：**MOSS 口径必须放行中文**，这一节整段跳过。两个理由：
   *
   * ① 能力上：MOSS 的文本编码器是 Qwen3.5-9B，中文是它的母语 ——
   *    中文台词（画面里的对话气泡）本来就要原样写进提示词，剥掉等于把台词删了。
   * ② 结构上更要命：这里的实现是 `tag.split(',')` → 过滤 → `join(', ')`。
   *    MOSS 多格提示词每格以 `Panel 2, top right: …` 开头，逗号一剖两半；
   *    含中文那半块被删掉后，`Panel 2` 的段首就并进了上一格的结尾（实测原文）：
   *      「…cream knit cardigan over a navy dress, top right: extreme close-up…」
   *    —— 三格的编号全乱，`Panel 2` 消失，出来的是一张乱七八糟的单图。
   *    ⇒ 只要是 moss 口径，既不剥中文也不做这一刀切分。
   */
  if (activeEngine() !== 'moss') {
    const cnParts = [];
    const kept = tag.split(',').map(s => s.trim()).filter((s) => {
      if (!s) return false;
      if (/[\u4e00-\u9fa5]/.test(s)) { cnParts.push(s); return false; }
      return true;
    });
    if (cnParts.length) {
      tag = kept.join(', ');
      notes.push(`剥除了混进 tag 的中文片段：${cnParts.join(' / ')}（中文只该出现在 nl 里）`);
    }
  }

  // ③b 配件移除的语义修正：tag 写了 shoes off，锚点里却还挂着 black loafers ——
  //    两个自相矛盾的词，模型各画一半（实测：图里鞋还好好穿着，剧情里早已脱掉）。
  //    处理：把锚点里的鞋词改成 "… removed"，让"脱下"这件事有落点。
  /**
   * ★★ v0.9.119：**MOSS 口径跳过这一条**。
   *   `black loafers removed` 是 **SD tag 语法**（靠后缀表达状态），塞进自然语句里是病句。
   *   依据（《MOSS二次元提示词模板_sfw版》§1.3 原话）：
   *     「普通 Caption 允许合理分段；没有必须全小写、必须一行、自然语言只能放末尾的 MOSS 规定。」
   *   即它承认这是「连贯的自然语」，而 `xxx removed` 不是自然语。
   *   MOSS 侧的正确表达已经写在模版 §二里：状态挂在动作上（`she steps out of her loafers`）。
   */
  if (!isMoss && /\b(shoes off|barefoot|shoes removed|shoe slipping)\b/i.test(tag)) {
    // 注意：鞋类词若紧跟 off / removed，说明它本身就是「脱鞋」状态短语（shoes off），
    // 不能当成鞋类物品去加 removed —— 否则会变成 shoes removed off 这种自相矛盾。
    const fixed = tag.replace(
      /(\b(?:black|brown|white|red|navy|blue)?\s*(?:leather\s+)?(?:loafers|sneakers|shoes|heels|boots|pumps)\b)(?!\s*(?:off|removed))/gi,
      (m) => `${m} removed`,
    );
    if (fixed !== tag) {
      tag = fixed;
      notes.push('画面里已脱鞋 —— 把服饰锚点里的鞋词改成了 "removed"，避免"既穿又脱"的矛盾');
    }
  }

  // ③c 人数声明剥除（分块模式下）—— v0.9.28 反转「人数写进第一句」条款。
  //     人物段已经按「每人一块」把实体立住了，tag 再说「Two figures fill the frame」
  //     = 同一批人被第三处描述 = 模型把它当第 3 个实体去成立，
  //     实测翻车图：精灵坐裤子上 + Two figures → 左下角多出半截人。
  //     只剥**句首的明确声明**（Two figures / Three people / 1boy, 1girl），
  //     不碰句中的「the two of them」这类自然指代。
  //     剥除事实要传给 ④b：剥完之后 looksMultiPerson 就看不见人数词了，
  //     「cast 只锚定一人却声明过多人」的告警不能跟着失效。
  let countDeclStripped = false;
  /**
   * ★★★ v0.9.119：**MOSS 口径绝对不许剥人数声明**。
   *
   * 这是第 8 次「两条规则互相抵消」，而且是**直接对撞**：
   *   · 模版 §1.1（v0.9.119 新写）：「每格开头写清人数与性质」+「画面里确实只有两个人时，
   *     明确写出来（`no one else in the frame`），比什么都不写更安全」
   *   · 本条旧逻辑：把**句首**的人数声明整段删掉（`^\s*(?:one|two|three)\s+(?:figures|people|…)`）
   *   ⇒ 模型照着规范写在句首的人数约束，被代码删了。
   *
   * 而且依据上正好相反：《MOSS二次元提示词模板_sfw版》§5.2 给的标准句式就是
   *   「**Exactly two women stand on the platform.** The short red-haired woman on the left…」
   *   —— 人数声明**就在句首**，还要求「精确人数时区分主角与背景人群
   *   （「只有两人、没有路人」）」。
   *
   * 旧规则「人数由人物段分块表达，再声明一次 = 第三处描述」是 **K2 三明治**的账：
   * K2 把外貌写进中文人物段，tag 里再数一次人数会让模型当第 3 个实体成立。
   * MOSS 的人物段是「The young woman with …」这种**不定主语**，根本不含人数，
   * 所以 tag 里的人数声明不是重复，而是**唯一的计数来源**。
   */
  if (isNatural && !isMoss && castGrouped) {
    const before = tag;
    tag = tag.replace(
      // 边界必须卡死在第一个句读 / 破折号上：
      // 早期版本用 [^.!?]* 一路吃到底，把整句 tag 全剥没了（只剩情绪残渣）。
      // 人数声明永远是个短前缀（"Two figures share the frame —"），
      // 后面的交互句才是画面主体，必须留下。
      /^\s*(?:(?:one|two|three|four|five|six)\s+(?:figures?|people|persons?|characters?|silhouettes?)\b[^.!?;—–\-]*[.!?;—–\-]*\s*|(?:\d+\s*(?:boys?|girls?|persons?|others?)\s*,\s*)+)/i,
      (m) => { countDeclStripped = m.trim().length > 0; return ''; },
    );
    if (countDeclStripped) {
      notes.push(`剥除了 tag 开头的人数声明「${before.slice(0, 60).trim()}…」—— 人数由人物段分块表达，再声明一次 = 同一批人被第三处描述（实测多出半截人）`);
    }
  }

  // ④ 画面体检
  const knownNames = (ctx.knownNames || snapshot.map(x => x.name));
  // 快照结构是 { name, entry:{fields}, dyn:{fields} } —— 静态锚点在 entry.fields
  const librarySkins = (Array.isArray(snapshot) ? snapshot : [])
    .flatMap(c => [c?.entry?.fields?.skin, c?.dyn?.fields?.skin])
    .filter(Boolean);
  notes.push(...lintTag(tag, knownNames, librarySkins, { skipAnchors: isNatural, moss: isMoss }));

  // ④b 多人同框却只锚定了一个人 —— 另一个会画成没脸的路人。
  //     检测 + 提示，不自动补人（补错人 = 多实体崩图，比缺锚定更糟）。
  //     「其余角色」名单优先用 presentNames（本楼在场的）—— 报全库名单只会吓人。
  //     offscreen 的人不算「漏锚定」—— 模型已声明他不入画（v0.9.28）；
  //     人数声明若在 ③c 被剥掉，用 countDeclStripped 补上检测信号（剥完后 looksMultiPerson 看不见人数词了）。
  if (isNatural && k2Anchors.length === 1 && (looksMultiPerson(tag) || countDeclStripped)) {
    const anchored = k2Anchors[0].name;
    const pool = (Array.isArray(ctx.presentNames) && ctx.presentNames.length
      ? ctx.presentNames
      : knownNames).filter(n => cleanRefName(n));
    const rest = pool.filter(n => n !== anchored && !offscreenNames.includes(n));
    // rest 为空且有人被标 offscreen → 这是模型有意的 POV 构图，不是漏人，不告警。
    if (rest.length || !offscreenNames.length) {
      // rest 为空时不要写「（无）」—— 那种措辞把真实问题掩盖成"一切正常"。
      // 实测病例：男主＝<user> 本人，档案库里压根没他，presentNames 自然算不出来，
      // 告警就成了「其余角色（无）没被点名」，读起来像插件在说废话。
      const restText = rest.length
        ? `本楼在场的其余角色（${rest.join('、')}）没被点名`
        : '本楼在场名单里查不到第二个人（多半是这个人**没有外貌档案** —— 常见于主角就是 `<user>` 本人，正文用宏指代，插件无从得知他是谁）';
      notes.push(`画面里像是有 2 人以上，但只锚定了「${anchored}」的外貌 —— ${restText}。在提示词里补 @角色名，或在 images 里加 cast 字段（用档案里的准确名字）；若这个人是主角且正文写作 <user>，请先在「角色档案」里用他的真名建档；若这确实是 POV / 特写构图、那个人不该入画，请在 cast 里给他标 "offscreen": true。`);
    }
  }

  // ⑥ K2 中文人物段：外貌从档案机械注入（v4 第 3 段），不经 LLM 的手。
  //    按角色分块（cast 带了英文动作句）时：每人 =「名字：外貌。」+「该角色的英文动作句」，
  //    A 的外貌与动作同块，B 不再被丢到末尾只用「一位男性」概括。
  //    未带动作句的锚点（来自 @引用 / 自愈）按「只有外貌行」追加在后面。
  let cast = '';
  /**
   * v0.9.53：服装段（仅当编排里开了「服装独立成段」才有内容）。
   * 默认关闭 —— 服装照旧附在人物段末尾，行为与之前完全一致。
   */
  const costumeSep = !!(ctx.layout && ctx.layout.costumeSeparate);
  let costume = '';
  if (isNatural) {
    if (castGrouped) {
      const ordered = [...castAnchors];
      for (const a of k2Anchors) {
        if (!ordered.some(x => x.name === a.name)) ordered.push({ ...a, en: '' });
      }
      const lines = [];
      const costumeLines = [];
      for (const c of ordered) {
        const para = costumeSep ? k2CastParagraph([c], { withOutfit: false }) : k2CastParagraph([c]);
        if (para) lines.push(para);
        if (c.en) lines.push(c.en);
        if (costumeSep) {
          const cp = k2CostumeParagraph([c]);
          if (cp) costumeLines.push(cp);
        }
      }
      cast = lines.join('\n');
      costume = costumeLines.join('\n');
      // tag 不并进 cast —— composePrompt 会把 tag 作为独立块排在人物块后面
      //（放这里是两人份的重复权重，实测多手）
    } else {
      cast = costumeSep ? k2CastParagraph(k2Anchors, { withOutfit: false }) : k2CastParagraph(k2Anchors);
      costume = costumeSep ? k2CostumeParagraph(k2Anchors) : '';
    }
  }

  /**
   * ★★★ v0.9.118：MOSS 英文人物段 —— 机械注入，不经出词模型的手。
   *   病根与「档案是唯一依据」无关，是「模型抄不抄全看运气」：实测同一段剧情，
   *   P22 抄到了外貌、P8 只剩发色、P17 一个字都没有 → 人物漂移。
   *   生成时机放在这里（跟中文人物段同一处），因为只有这里拿得到 `{eff}`。
   */
  const castEn = isNatural && activeEngine() === 'moss' ? mossCastParagraph(k2Anchors) : '';

  // ⑥b 分块模式下 tag 的篇幅自检。
  //     分块后 tag 只该剩「末句情绪 + 未被 cast 覆盖的补充」，短句就够；
  //     还是长篇 = 模型把 cast[].en 里写过的动作/接触点/服装又说了一遍 ——
  //     同一个接触物被描述两次，模型按「两个都要成立」去补（实测把裤子里的人腿复制成半截多余人）。
  /**
   * ★★ v0.9.119：MOSS 口径跳过。
   *   MOSS 的 tag 是**整段成稿**（画风句 + 版面声明 + 每格一句），实测三格就是 700~900 字符。
   *   依据（模板 §1.3）：「普通 Caption 允许合理分段；没有必须全小写、必须一行、
   *   自然语言只能放末尾的 MOSS 规定。」—— 它根本不以「短」为优。
   *   留着这条只会每张多格图都喊一次「tag 还有 800 字符」，把用户引去删内容。
   */
  if (isNatural && !isMoss && castGrouped && tag.length > 220) {
    notes.push(`已按角色分块（每人外貌与动作同块），但 tag 还有 ${tag.length} 字符 —— 分块模式下 tag 只该写末句情绪；超长几乎必然是把 cast[].en 写过的动作、接触点（尤其裤子/床单这类接触物）复述了一遍（复述 = 模型把同一物体复制成多份，实测多出半截人）`);
  }

  // v0.9.61 跨段肢体重复闸：见下方 stripLimbsDeclaredInCast 的病例说明。
  /**
   * ★★ v0.9.119：MOSS 口径跳过。
   *   这道闸的实现是「按逗号 split 成片，逐片删掉人物段已声明过的肢体」——
   *   它建立在「人物段与 tag 是两段可以互相比对的平行文本」这个前提上（K2 三明治）。
   *   MOSS 的 tag 是一整段自然语（每格一句话），按逗号切片会切进句子中间，
   *   删掉半句 ⇒ 与 trimPromptFat 削掉 Panel 2 方位词是同一类伤害。
   *   而且 MOSS 的模板 §7 要求「一个主要动作 + 手/道具关系」明确写出来，
   *   肢体词正是它要的内容，不是冗余。
   */
  if (isNatural && !isMoss && castGrouped && tag.trim()) {
    const cleaned = stripLimbsDeclaredInCast(tag, cast);
    if (cleaned.removed.length) {
      tag = cleaned.tag;
      notes.push(`tag 末句复述了人物段已经写过的肢体（${cleaned.removed.join(' / ')}）—— 已删除（同一只手被声明两次，模型按第三只手去补 = 多肢体的直接来源）`);
    }
  }

  /**
   * v0.9.90：把「角色名 → 本次拼进画面的锚点串」随结果存档。
   *
   * 为什么：SD 口径下 @展开 / 自愈都会把锚点串**原地烘焙进 prompt**，
   * 存档里只剩最终文本 —— 之后用户改了档案，重生成时无从定位旧串做替换。
   * 出图时把当时的锚点串记下来，「按档案重新生成」（SD）靠它做精确替换。
   * K2 的人物段刷新走 cast 文本，不依赖这份清单（顺带存，无害）。
   */
  const anchorSrc = new Map();
  for (const a of castAnchors) if (a?.name && a?.eff) anchorSrc.set(a.name, a.eff);
  for (const a of k2Anchors) if (a?.name && a?.eff && !anchorSrc.has(a.name)) anchorSrc.set(a.name, a.eff);
  if (!isNatural) {
    // SD：@引用被 expandRefs 原地展开（不走 anchors 数组）—— 按 used 名单重查 eff 复现原串
    for (const n of expanded.used) if (!anchorSrc.has(n)) anchorSrc.set(n, effectiveOf(n, snapshot, positional, lineIndex));
  }
  for (const n of healedRes.healed) if (!anchorSrc.has(n)) anchorSrc.set(n, effectiveOf(n, snapshot, positional, lineIndex));
  const anchorList = [];
  for (const [n, eff] of anchorSrc) {
    if (offscreenNames.includes(n)) continue;   // 不入画的人没有锚点（v0.9.28 同一口径）
    const text = anchorOf(n, eff);
    if (text) anchorList.push({ name: n, text });
  }

  /**
   * ★ v0.9.96：去重保护锚点区。
   * 不保护的话，两个角色共有的 tag（都 `black hair`）会把后一个角色的锚点削短，
   * 而 `composePrompt` 的 SD 分块靠「锚点串在 tag 里原样出现」来切段 → 恒切不出来。
   *
   * ★★★ v0.9.118：MOSS 口径**整条跳过**这道去重 —— 它会把分段结构彻底压平。
   *   `dedupeTagKeepingAnchors` 内部是 `split(',')` → `join(', ')`（`dedupeTag` 同理），
   *   换行被 `trim()` 吃掉，于是
   *     `...line art.\n\nPanel 1, …\n\nPanel 2, …`
   *   变成 `...line art., Panel 1, …, Panel 2, …` —— 用户看到的「全挤在一起」就是这个。
   *   更糟的是 `inner` 命中去重会把某个 `Panel N, …` 整段误删（它按逗号切片，段首就是 `Panel 2`）。
   *   MOSS 不是权重叠加模型，去重收益本就很小，保住结构远比去重重要。
   */
  const tagFinal = activeEngine() === 'moss'
    ? tidySeparatorsKeepLines(tag)
    : dedupeTagKeepingAnchors(tidySeparators(tag), anchorList.map((a) => a.text));

  return {
    position: image?.position,
    tag: tagFinal,
    nl,
    scene,
    mood,
    cast,
    castEn,
    /**
     * ★ v0.9.140：漫画页模式按「角色名 + 景别」取外貌用。
     * 只放纯字符串（不放 `eff` —— 那个对象含整份档案，会被落库存档撑爆）。
     * 非 MOSS 口径恒为空数组，其他口径读不到这些字段也不受影响。
     */
    castLines: (isNatural && activeEngine() === 'moss')
      ? k2Anchors.map((a) => ({ name: String(a?.name || ''), ...mangaCastLineOf(a) }))
        .filter((x) => x.name && (x.full || x.face))
      : [],
    costume,
    anchorList,
    used: usedAll,
    unknown: [...castUnknown, ...expanded.unknown],
    healed: healedRes.healed,
    notes,
    ok: !!tag,
  };
}

/* ============ 附加：合成最终提示词 ============ */

/**
 * 合成交给后端的最终提示词。
 * prefix / suffix / negative 来自全局设置。
 */
/**
 * 引用记号（@角色名 / 光杆 @）。
 * 这是给引擎看的「代号」，不是画面词 —— K2 完全不知道 @深雪 长什么样，
 * 送进去只会当噪声。所以最终提示词里一个 @ 都不许剩。
 */
// v0.9.24：连字符名（小精灵-菲）也要整段吃掉，否则会残留「-菲」变成噪声 token。
// 与 REF_NAME_RE 用同一套分隔符口径。
const FINAL_REF_RE = /[@＠][\p{L}\p{N}_.·]*(?:[-‐-―][\p{L}\p{N}_.·]+)*/gu;

/**
 * 组装最终提示词 —— 这是进 ComfyUI 之前的最后一道闸。
 *
 * 契约（用户对 K2 管线的硬要求）：
 *   最终给 ComfyUI 的字符串 = 纯描述＝角色的外貌 / 服装 / 状态 / 款式 + 场景动作。
 *   @角色名 这类引用记号必须在前一步（expandRefs）就锚定成具体描述；
 *   走到这里还残留 @，说明有引用没展开成功，必须剥掉 —— 宁可少个锚点，
 *   也不能把 K2 看不懂的代号混进画面词里。
 *
 * @returns {{prompt:string, negative:string, nl:string, strippedRefs:number}}
 *          strippedRefs = 最终闸口剥掉的引用记号数（>0 说明上游没展开干净，值得看诊断）
 */
/* ============ v0.9.65 不定指代 → 人数上限锚（用户病例：多出来一个人） ============
 * 用户病例（2026-10-03 雾津 多人场次）：
 *   动作句里出现 "she fondles the other woman" / "her upper body resting against the
 *   other woman's shoulder" / "looking at another" —— 「the other woman」「another」是
 *   **不定指代**：模型无从判断它指的是场上已有的那位，还是一个**新出现的第三人**。
 *   多人场次里它常常就真的画出一个多余的人，或者把两个人叠在同一处（人物重叠）。
 *
 * ★ 为什么用「消除」而不是「加规则」：防崩坏靠做减法。这里减的是**模型的猜测空间** ——
 *   不教它怎么摆姿势，只告诉它「画面里就这几个人，没有别人」。一句话堵死第三人。
 *
 * ★ 为什么不做 1boy/2girls 那种计数 tag：那需要先判性别，判错就把构图带歪
 *   （把 2girls 1boy 写成 3girls 比原来更糟）。这里只数**人物块数**，不需要性别，零误判风险。
 *   且只在**确实出现不定指代**时才补这一句 —— 没有歧义的场次一个字都不加。
 */
/** 不定指代：会让模型以为还有一个人。 */
const VAGUE_PERSON_RE = /\b(?:the\s+other\s+(?:wo)?man|another\s+(?:wo)?man|a\s+second\s+(?:wo)?man|the\s+(?:older|younger|taller|shorter)\s+(?:wo)?man|the\s+other\s+person|someone\s+else|no\s+one\s+else|looking\s+at\s+another|the\s+third\s+(?:wo)?man)\b/i;
const NUM_WORD = { 2: 'two', 3: 'three', 4: 'four', 5: 'five', 6: 'six' };

/**
 * 人物块计数 + 不定指代检测。返回空串 = 无需干预（别乱加字）。
 * @param {string} castText 中文人物段（形如「夜斗：一位少年，…
周雅：一位女性，…」）
 * @param {string} tagText  英文动作/服装段
 */
export function headcountGuard(castText, tagText) {
  const t = String(castText || '');
  // 人物块：行首的「名字：」—— 与档案渲染口径一致
  const re = /(?:^|\n)([^\s:：\n]{1,12})[:：]/g;
  let n = 0;
  while (re.exec(t)) n += 1;
  if (n < 2) return '';
  const all = t + '\n' + String(tagText || '');
  if (!VAGUE_PERSON_RE.test(all)) return '';
  const word = NUM_WORD[n] || String(n);
  return `only these ${word} people in frame, no one else`;
}

/* ============ v0.9.65 动作段 / 情绪段精简（用户要求：提示词尽可能精简） ============
 *
 * ★ 机理（本项目头号崩图原因，2026-10-02 实玩验证，别推翻）：
 *   规范每多一条「必须同时成立」的约束，扩散模型就越难找到自洽解，只能折中 ——
 *   折中在画面上就是扭曲与多肢体。所以防崩坏靠**做减法**，不是加规则。
 *
 * 实测（2026-10-03 雾津最近 8 张真实出图）：提示词 894–1767 字，**部位词 10–16 个**。
 * 每个部位词背后都是一次几何声明，16 条几何要同时成立 → 模型必然折中 → 扭曲。
 *
 * 减法做在这两处（用户点名的「动作段」与「情绪段」）：
 *   ① 动作段：从句按出现顺序保留，累计**不同部位**超过上限就丢弃后续含新部位的从句。
 *      核心动作通常先写，所以靠前的优先；含承重词的从句**永远保留**（没承重面必崩）。
 *   ② 情绪段：同义情绪词合并（blushing/flushed 是同一件事，写两遍＝实体复制），
 *      且总数封顶 —— 情绪堆 4 个以上时模型会把脸画成一团矛盾表情。
 *
 * ★ 只清洗英文句，中文外貌段（nlProfile）一个字不动 —— 那是用户的人设主权区。
 */

/** 承重短语（防崩坏必写项，精简时绝对不能删）。 */
const TRIM_KEEP_RE = /\b(?:kneel(?:s|ing)?|sit(?:s|ting)?|stand(?:s|ing)?|lie[sd]?|lying|lean(?:s|ing)?|braced?|bracing|weight\s+on|planted|perch(?:es|ed)?|supported|resting\s+(?:on|against)|pressed\s+against|crouch(?:es|ed|ing)?|squat(?:s|ting)?)\b/i;
/** 部位词（动作几何的计数单位）。 */
const TRIM_PART_RE = /\b(?:hips?|pelvis|waist|thighs?|knees?|ankles?|calves|shins?|feet|foot|toes?|hands?|palms?|fingers?|arms?|elbows?|shoulders?|legs?|chest|breasts?|nipples?|back|neck|head|face|lips?|mouth|tongue|jaw|chin|forehead|hair|eyes?|genitals?|cock|penis|pussy|crotch|buttocks?|ass|asshole|stomach|belly|torso)\b/gi;
/** 部位上限：超过就停止接收含新部位的从句。 */
const TRIM_PART_CAP = 6;
/** 微表情从句（脸 / 眼 / 唇 / 视线 / 表情）—— 堆到 3 个以上脸就画成一团矛盾表情。 */
const TRIM_MICRO_RE = /\b(?:face|eyes?|lips?|gaze|gazing|chin|mouth|cheeks?|forehead|expression|looking)\b/i;
const TRIM_MICRO_CAP = 2;
/** 光影 / 液体细节从句（反光、汗、水光）—— 与主体几何无关，却是扭曲的高发源。 */
const TRIM_DETAIL_RE = /\b(?:light|shadow|gleam|glisten(?:ing)?|shimmer|glow|wet(?:ness)?|droplets?|sweat|moisture|sheen)\b/i;
const TRIM_DETAIL_CAP = 1;

/** 同义情绪词分组：组内出现第二次及以后＝重复声明，删。 */
const TRIM_EMO_GROUPS = [
  /\b(?:blushing|flushed|red-faced|reddened|face\s+red|cheeks\s+burning)\b/i,
  /\b(?:dazed|confused|bewildered|disoriented|distracted|blank-minded)\b/i,
  /\b(?:breathless|panting|gasping|out\s+of\s+breath|breathing\s+hard)\b/i,
  /\b(?:teary|teary\s+eyes|tears|watery\s+eyes|crying|weep(?:ing|y))\b/i,
  /\b(?:trembling|shaking|quivering|shivery|shuddering)\b/i,
  /\b(?:flustered|embarrassed|shy|bashful|abashed)\b/i,
  /\b(?:moaning|groaning|whimpering|whining)\b/i,
  /\b(?:aroused|horny|lustful|turned\s+on)\b/i,
];
/** 情绪词总数上限。 */
const TRIM_EMO_CAP = 3;

/** 含中文字符的行 = 中文外貌 / 场景段，不碰。 */
function hasCjk(t) { return /[\u4e00-\u9fff]/.test(String(t || '')); }

/**
 * 精简一段英文（动作句或情绪串）。返回 { text, cut }。
 * @param {string} text 英文文本
 * @param {'action'|'emotion'} kind
 */
export function trimEnglishClause(text, kind) {
  const t = String(text || '').trim();
  if (!t) return { text: '', cut: [] };
  const cut = [];

  if (kind === 'emotion') {
    const segs = t.split(/\s*,\s*/).filter(Boolean);
    const usedGroups = new Set();
    let emoCount = 0;
    const kept = [];
    for (const seg of segs) {
      const gi = TRIM_EMO_GROUPS.findIndex((re) => re.test(seg));
      if (gi >= 0) {
        if (usedGroups.has(gi)) { cut.push(seg); continue; }   // 同义重复 → 删
        if (emoCount >= TRIM_EMO_CAP) { cut.push(seg); continue; } // 情绪堆太多 → 删
        usedGroups.add(gi);
        emoCount += 1;
      }
      kept.push(seg);
    }
    return { text: kept.join(', '), cut };
  }

  // action：按从句切分（逗号 / 分号 / 连接词）
  const clauses = t.split(/\s*(?:[,;]|\band\b)\s*/i).filter(Boolean);
  const seen = new Set();
  const kept = [];
  let microCount = 0;   // 微表情从句计数
  let detailCount = 0;  // 光影 / 液体细节从句计数
  for (const cl of clauses) {
    const parts = (cl.match(TRIM_PART_RE) || []).map((x) => x.toLowerCase());
    const isNewPart = parts.some((p) => !seen.has(p));
    // 承重面 + 插入声明永远保留：没承重必崩，删了插入就不是性行为画面了。
    // （实测误伤：部位数达上限时 "his cock buried deep inside her pussy" 被整句删掉）
    if (TRIM_KEEP_RE.test(cl) || INSERTION_MARK_RE.test(cl)) {
      kept.push(cl);
      for (const p of parts) seen.add(p);
      continue;
    }
    if (isNewPart && seen.size >= TRIM_PART_CAP) { cut.push(cl); continue; }
    if (TRIM_MICRO_RE.test(cl)) {             // 微表情限数
      if (microCount >= TRIM_MICRO_CAP) { cut.push(cl); continue; }
      microCount += 1;
    } else if (TRIM_DETAIL_RE.test(cl)) {     // 光影液体限数
      if (detailCount >= TRIM_DETAIL_CAP) { cut.push(cl); continue; }
      detailCount += 1;
    }
    kept.push(cl);
    for (const p of parts) seen.add(p);
  }
  // 用回原文的标点口径拼接（原句用 ; 就还是 ;）
  const joined = kept.join(', ');
  return { text: joined.replace(/\s+,/g, ','), cut };
}

/**
 * 提示词精简总入口：只动英文，中文外貌段与场景段原样返回。
 * @returns {{cast: string, tag: string, cut: string[]}}
 */
export function trimPromptFat(castText, tagText) {
  const cut = [];
  // 中文人物段：逐行处理，只有纯英文行（动作句 / 服装句）才进精简
  const cast = String(castText || '')
    .split('\n')
    .map((line) => {
      if (hasCjk(line)) return line;
      const r = trimEnglishClause(line, 'action');
      if (r.cut.length) cut.push(...r.cut);
      return r.text;
    })
    .join('\n');
  // 英文 tag 段：动作句 + 末句情绪，两道都过
  let tag = String(tagText || '');
  const a = trimEnglishClause(tag, 'action');
  tag = a.text;
  cut.push(...a.cut);
  const e = trimEnglishClause(tag, 'emotion');
  tag = e.text;
  cut.push(...e.cut);
  return { cast, tag, cut };
}

/**
 * v0.9.98 · 拼装结构快照（诊断用）。
 *
 * ★ 为什么需要它（用户 2026-10-18）：「哪些起作用、哪些没用、代价是什么都不知道」。
 *   最终提示词只是一长串 —— 用户没法判断「动作段到底排在第几」「人数词还在不在首段」
 *   「哪几段被开关关掉了」。这里把拼装过程的结果留下来：
 *   每段多少项、从第几项开始、总长约多少 token（估算）。
 *
 * ⚠️ token 数是**估算**（英文 tag 平均 4 字符 ≈ 1 token），只用于判断
 *    「动作段是否落在前 77 token（第 1 个 CLIP 块）」，不是精确计数。
 *    要精确值请用 ComfyUI 那边的分词器（本项目记忆里记着怎么跑）。
 */
function buildStructure(engine, mode, trace, prompt) {
  const list = (trace || []).filter((s) => String(s?.text || '').trim());
  let acc = 0;
  const segments = list.map((s) => {
    const t = String(s.text);
    const items = t.split(',').map((x) => x.trim()).filter(Boolean).length;
    const approxToken = Math.round(t.length / 4);
    const at = acc;
    acc += approxToken;
    return { id: s.id, items, chars: t.length, at, approxToken };
  });
  return {
    engine,
    mode,
    segments,
    approxTotal: acc,
    hasBreak: /\bBREAK\b/.test(String(prompt || '')),
  };
}

/**
 * 把英文人物段插进 MOSS 整段提示词的固定位置（v0.9.118）。
 *
 * 位置 = 第一个 `Panel N,` 之前；单图（没有 Panel）则插在第一段之后。
 *
 * ★ 为什么不能插在末尾（v0.9.117 的三明治就是这么干的，实测把分格序列切断了）：
 *   参考写法（用户验证过能准确还原人物与对话的那份）的段落顺序是
 *     风格/版面句 → 人物段 → 动作段 → 台词行
 *   人物段必须**早于**分格内容。写在末尾时，每格只能靠 `the girl` 指代，
 *   脸、发色、衣服全散；插在中间则把 `Panel 1→2→3` 的序列切断。
 */
/**
 * 清掉空气泡（v0.9.118）。
 *
 * ★ 真实数据：用户 2026-10-21 的四张图，Prompt 全是 `A speech bubble beside her reads " "`
 *   —— 引号里只剩一个空格。出词模型有强烈的「把句式骨架写全、内容留空」的失败模式，
 *   尤其在它不确定台词该不该写的时候（这次是「禁止写中文」与「不要输出 nl」互斥造成的）。
 *
 * 为什么必须删而不是补：空引号送到 MOSS 就是一句「画一个没字的气泡」的指令，
 *   出来的图里会有一个空泡；删掉至少画面干净。补 `No text in this panel.` 也不对 ——
 *   那等于替模型宣布「这格没台词」，而定位不了它到底漏了哪句原话。
 *
 * 只在 moss（enSingle）出口跑：SD / K2 口径没有这套气泡语法。
 *
 * @returns {{text:string, dropped:number}}
 */
export function stripEmptyBubbles(text) {
  const src = String(text || '');
  if (!src) return { text: '', dropped: 0 };
  let dropped = 0;
  /**
   * 限定在「同一句内」找气泡：`[^.!?]*` 保证不会跨句吞掉相邻格。
   * ★ 尾部**不能**再跟 `[^.!?]*[.!?]?` —— 那会把 `reads " " Panel 3: close-up.` 里的
   *   下一个格一起吞掉（实测：删一个空气泡，`Panel 3` 整格消失）。
   *   引号之后只允许紧跟一个可选的句末标点。
   */
  const RE = /[^.!?]*\b(?:speech\s+bubble|bubble|narration\s+box)\b[^.!?]*\breads\s*["“]([^"”]*)["”][.!?]?/gi;
  const out = src.replace(RE, (m, inner) => {
    // 去掉空白与纯标点（`……` / `—` 这类不是台词）后还有字 → 是真台词，保留
    if (String(inner).replace(/[\s.．…·、,，\-—~～]+/g, '').length) return m;
    dropped++;
    return '';
  });
  return {
    text: out.replace(/[ \t]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').replace(/[ \t]+$/gm, '').trim(),
    dropped,
  };
}

/**
 * MOSS 整段提示词的**结构性重排**（v0.9.118）。
 *
 * ★ 用户需求（2026-10-21 原话）：「最终出的提示词能不能别都挤在一起，分段排列下。
 *   这样我查看提示词的时候也能知道哪段是哪段。因为我英文不好，不方便看是哪个结构出问题。」
 *
 * 为什么不能靠模型自己换行：它在 JSON 字符串里写 `\n\n` 时经常直接写成空格，
 * 真实楼层的 prompt 就是 `...line art. Panel 1, ... No text in this panel. Panel 2, ...`
 * 一整串。所以出口强制重排，规则只有三条：
 *   ① 每个 `Panel N,` 之前必须是空行（这是「一格一段」的唯一可见边界）；
 *   ② 人物段每人一行（已经在 mossCastParagraph 里保证）；
 *   ③ 段落之间不留三个以上换行。
 *
 * 幂等：已经排好的文本过一遍不变。
 */
export function formatMossPrompt(text) {
  let s = String(text || '').replace(/\r\n/g, '\n');
  if (!s.trim()) return '';
  // 先把所有换行抹成单个空格（但保住已有的 `\n` 语义由下面重建，避免重复堆叠）
  s = s.replace(/[ \t]*\n+[ \t]*/g, ' ');
  // 每个 Panel 前插空行（`Panel` 前面可能紧跟 `。` / `.` / `,` / `No text in this panel.`）
  s = s.replace(/\s*\bPanel\s+(\d+)\s*([,:])/g, (m, n, c) => `\n\nPanel ${n}${c}`);
  // 人物段之间：`The young woman … . The young man … .` 拆成两行（一人一段更好读）
  s = s.replace(/\.\s+(The (?:young )?(?:woman|man|person)\b)/g, '.\n$1');
  s = s.replace(/^\s+/, '').replace(/\n{3,}/g, '\n\n').trim();
  return s;
}

export function injectMossCast(tagText, castEn) {
  const cast = String(castEn || '').trim();
  if (!cast) return String(tagText || '');
  const src = String(tagText || '');
  if (!src) return cast;
  /**
   * 幂等闸：人物段已经在文本里就不再插一次。
   * 没有这道闸时，重跑 composePrompt（regenerate / 重新处理变量）会叠出两份人物段 ——
   * 而重复描述在 MOSS 里会被**语义平均**，等于把人物改了一遍。
   */
  const firstCastLine = cast.split('\n')[0];
  if (firstCastLine && src.includes(firstCastLine)) return src;
  const m = /\bPanel\s*\d+\s*[,:]/.exec(src);
  if (m) {
    const head = src.slice(0, m.index).replace(/\s+$/, '');
    return head ? `${head}\n\n${cast}\n\n${src.slice(m.index)}` : `${cast}\n\n${src}`;
  }
  /**
   * 单图：插在**第一句之后**。第一句按约定是风格 / 场景声明
   * （参考写法：`A Japanese manga style single panel in clean black-and-white line art …`）。
   * 不能按 `\n\n` 切段 —— formatMossPrompt 已经把换行抹平重建过，这里可能只剩一段。
   */
  const first = /^[^.!?]*[.!?]/.exec(src);
  if (first) {
    const head = first[0].trim();
    const rest = src.slice(first[0].length).trim();
    return rest ? `${head}\n\n${cast}\n\n${rest}` : `${head}\n\n${cast}`;
  }
  return `${cast}\n\n${src}`;
}

/**
 * 全局词库（前缀 / 后缀）在 Layout 下怎么落 —— **只并进 `summary.caption`**，
 * 绝不塞进 `items`（那是坐标框，塞进去等于给某一格加词）。
 *
 * ★ v0.9.122 两道清洗，都是实测会踩的：
 *   ① 用户的前缀多半是逗号 tag 串（`masterpiece, best quality,`），
 *      直接 `join('. ')` 会拼出 `, . 画风句` 这种脏串；
 *   ② 前缀自己常带句末标点，和 `. ` 叠成 `..`。
 * 落点可切「不注入」（`mossJson.gword === 'off'`）：
 *   前缀若是 SD 式 tag（`score_9, score_8_up`），塞进自然语 caption 只会稀释画风句。
 *
 * ★ v0.9.140 抽成函数 —— 漫画页与旧 Layout 两条路都必须用**同一份**逻辑，
 *   各写一遍必然漂移（本项目踩过太多「两条写入路径」）。
 */
function mergeLayoutGlobalWords(out, c) {
  const gwordMode = c.mossJson?.gword === 'off' ? 'off' : 'caption';
  const pre = gwordMode === 'off' ? '' : String(c.globalPrefix || '').trim();
  const suf = gwordMode === 'off' ? '' : String(c.globalSuffix || '').trim();
  if (!pre && !suf) return out;
  const trimEdge = (s) => String(s || '').trim()
    .replace(/^[\s,，、;；:：]+/, '')
    .replace(/[\s,，、;；:：]+$/, '');
  const cap = String(out.summary.caption || '').trim();
  const parts = [trimEdge(pre), cap, trimEdge(suf)].filter(Boolean);
  out.summary.caption = parts.join('. ')
    .replace(/\.{2,}/g, '.')
    .replace(/([。！？!?])\s*\.\s*/g, '$1 ');
  return out;
}

/**
 * 漫画页的「按角色名取外貌」匹配器。
 *
 * ★ 必须全名 / 简称互含匹配：卡片里叫 `夜斗`、模型写 `神谷夜斗` 时，
 *   精确相等会**静默取不到** → 那一格不注入服装 → 出图近乎全裸，
 *   而日志里一句报错都没有（实测就因为这一条，两组实验出图 md5 完全相同）。
 *
 * ★ 导出只为可测：这条匹配是全裸/服装丢失的唯一入口，必须有用例守着。
 */
/**
 * 正文用第一人称时，模型常把主角写成「我 / 主角 / the boy」。
 * 这些**不是档案里的名字**，按名字查必然落空。
 *
 * ★ 只在「本次人物段里恰好只有一个男性」时才兜底 —— 唯一才敢猜。
 *   多男在场时不猜（猜错等于给另一个人的脸和衣服，比不注入更糟）。
 */
const MOSS_NARRATOR_RE = /^(?:我|本人|自己|我本人|主角|男主|主人公|旁白|叙述者|i|me|my|myself|narrator|the narrator|the boy|the young man|protagonist)$/i;

export function looksResolver(list) {
  const arr = Array.isArray(list) ? list : [];
  /** 「唯一的男性」判据用人物段开头那句（`The young man with …`）。 */
  const males = arr.filter((x) => /^the (?:young |middle-aged )?man\b/i.test(String(x.full || '')));
  return (name, framing) => {
    const n = String(name || '').trim();
    if (!n) return '';
    let hit = arr.find((x) => x.name === n)
      || arr.find((x) => x.name.includes(n) || n.includes(x.name))
      || null;
    if (!hit && males.length === 1 && MOSS_NARRATOR_RE.test(n)) hit = males[0];
    if (!hit) {
      warn(STAGE.CONSISTENCY, `漫画页：角色「${n}」在本次人物段里查不到，这一格不注入外貌/服装`);
      return '';
    }
    if (framing === 'face') {
      /**
       * ★★★ v0.9.146：脸部格 = 近景五官 + **一句服装锚**。
       *   只给 `hit.face` 时那一格没有衣服信息 ⇒ 同一页里她换了一身（见 `mossWearLine` 病例）。
       *   服装句必须短（颜色+品类），并且由 caption 钉死"只有头颈入镜"。
       */
      const head0 = hit.face || hit.full || '';
      const wear = String(hit.wear || '').trim().replace(/\.+$/, '');
      /** 没有服装锚时**原样返回**（旧口径不变，避免给既有无用例改输出格式）。 */
      if (!wear) return head0;
      const head = String(head0).trim().replace(/\.+$/, '');
      return `${head}, ${wear}.`;
    }
    /**
     * ★★★ v0.9.146：`detail` 局部特写只给「是谁 + 穿的什么」，不给五官。
     *   病例：detail 格写 `only her legs`，注入的是整套 full ⇒ 模型要么画成整个人，
     *   要么干脆画成**路人的腿**（没有任何"属于她"的线索）。
     *   需要的是"这具身体就是她的"：裙色 / 肤色 / 裸露状态 —— 都在 `detail` 那句里。
     */
    if (framing === 'detail') return String(hit.detail || hit.full || '').trim() || hit.full;
    return hit.full;
  };
}

/** 漫画页的画风句（用户没单独设「画风」字段时用这句；已随原型出图验证过）。 */
const MANGA_STYLE_FALLBACK = 'Clean anime line art with soft cel shading, mature dramatic manga style';

/**
 * ★★★ v0.9.157：单图 JSON（`output: 'json'`）的成品构造 —— **一个坐标都不留**。
 *
 * 依据（`dev_tmp/single_multi/_eval.md`，36 张真出图）：
 *   · 每人一个各自不同的 bbox → 6 人档 1/3、8 人档 **0/3** 正确，稳定多画一个人
 *     （多出来的总是「同一个角色被复制成两个并排的人」）；
 *   · 每人同一个满幅 bbox → 不复制了，但开始按槽位删人（一次 7 人、一次 5 人）；
 *   · **完全不写 bbox** → 6/6 全对，且细节保持率（双马尾）6/6，高于纯 prompt 的 3/9。
 * ⇒ 这里把草稿里所有 `bbox` / `width` / `height` / `bbox_*` 字段**全部丢弃**，
 *   只留 `label` + `caption` + `text`。位置信息本来就已经写在 caption 的文字方位词里。
 */
/**
 * ★★★ v0.9.163：剥掉模型自己写的「行数 / 排版」措辞 —— 让**代码算出的行数**成为唯一说法。
 *
 * 病例（2026-10-30 真实楼层 P17 的成品，`floors[...|4|0].results[0]`）：
 *   模版示例句写的是 `medium-weight hand-lettered Chinese, two lines, evenly spaced,
 *   comfortably legible.` → 模型**照抄**，caption 里带了 `two lines`；
 *   代码又追加 `set in exactly 6 lines with the line breaks already fixed, evenly spaced`
 *   ＋ 尾巴 `comfortably legible.`，于是同一句里出现：
 *     `…, two lines, evenly spaced, comfortably legible,
 *      set in exactly 6 lines with the line breaks already fixed, evenly spaced, comfortably legible.`
 *   —— **同时说 2 行和 6 行**，且 `evenly spaced, comfortably legible` 各出现两次。
 *
 * 老纪律「两条规则互相抵消时模型只挑一条听」在这里的代价是：气泡框按 2 行排、
 * 文字是 6 行 ⇒ 挤成一团或溢出框外。所以必须二选一，且只能是代码算的那个。
 * 治本在模版（`settings.js` 示例句已去掉 `two lines`），这里做兜底：
 * 模型爱写什么行数都行，进来先剥干净，再统一由 `shape` 写一次。
 */
export function stripBubbleLayoutClaims(s) {
  return String(s == null ? '' : s)
    .replace(/[.\s]+$/, '')
    /* 行数声明：two lines / on a single line / in 6 lines / 2 rows / two lines of */
    .replace(/,?\s*(?:set\s+in\s+|in\s+|on\s+)?(?:a\s+|an\s+)?(?:single|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\d+)\s+(?:lines?|rows?)(?:\s+of\b)?/gi, '')
    /* 与行数捆绑的排版形容词：末尾由代码统一补一次，这里先清 */
    .replace(/,?\s*\bevenly\s+spaced\b/gi, '')
    .replace(/,?\s*\bcomfortably\s+legible\b/gi, '')
    .replace(/,?\s*\bwith\s+the\s+line\s+breaks\s+already\s+fixed\b/gi, '')
    /* 清掉剥离后残留的空逗号 / 双空格 / 尾逗号 */
    .replace(/\s*,\s*(?=,)/g, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/[\s,]+$/, '')
    .trim();
}

/**
 * ★ v0.9.164：**导出**给 `galBridge.js` 用（GAL 联动）。改的是可见性，不是行为 ——
 *   原来只有 `composePrompt` 内部调用，现在外部也要能把「一份单图 JSON 草稿」
 *   编译成同一份成品（保证 GAL 出的图与楼层出的图走**完全同一条**规范化路径）。
 */
export function singleJsonPrompt(draft, c) {
  const src = (draft && typeof draft === 'object' && !Array.isArray(draft)) ? draft : null;
  if (!src) return null;
  /**
   * ★★★ v0.9.158：单图「文字台词」开关。关 = 这一张里**任何文字的框都不出**。
   *
   * 这一层是**真正的生效点**，不能只靠指令（记忆：「能让代码算死的就别靠模型听话」）——
   * 指令说「不要建 text 项」模型照样会建，只有在这里丢才保证画面上没有字。
   * 拟声词也是 `label:'text'` 项，所以一并丢掉（面板上的 sfx 档位只管「开着时用哪种语言」）。
   */
  const noText = !!(c && c.mossJson && c.mossJson.textBubble === false);
  const summaryIn = (src.summary && typeof src.summary === 'object') ? src.summary : {};
  const itemsIn = Array.isArray(src.items) ? src.items : [];
  const items = [];
  /** 官方 `compile_prompt.py:89` 要求 text 项的 `caption` 必填，缺了就整份 JSON 非法。 */
  const TEXT_CAPTION_FALLBACK = 'A clean speech bubble with a thin black outline and a small tail, white fill';
  let dropped = 0;
  for (const it of itemsIn) {
    if (!it || typeof it !== 'object') continue;
    /**
     * ★★★ v0.9.159：`label` 走**官方白名单**。
     *
     * 依据（官方 `compile_prompt.py:91`）：
     *   `require(item["label"] in ("object", "character", "text"), ...)`
     *   —— 其它值官方编译器**直接报错**，不是容忍。
     * 旧代码是 `String(it.label || 'character')` 原样透传，模型写 `person` / `figure` /
     * `background` 都会被送进模型（训练分布里没有这些 label，等于噪声）。
     */
    const raw = String(it.label || '').trim().toLowerCase();
    let label;
    if (raw === 'text') label = 'text';
    else if (raw === 'object' || raw === 'background' || raw === 'scene' || raw === 'prop') label = 'object';
    else label = 'character';
    if (noText && label === 'text') continue;
    /**
     * ★ `object` 是**格子**的背景层（caption 里带 `Panel N:` 与「这一格几个人」），
     *   单图没有格：留着它会让模型按「格框」理解整幅画面，还会和 summary 里的人数
     *   形成两套口径（实测单图多出人的另一种成因）。
     */
    if (label === 'object') continue;
    const caption = String(it.caption || '').trim();
    const text = String(it.text || '').trim();
    /**
     * ★★★ v0.9.159：**一句台词 = 一个 `text` 项 + `\n` 折行**，不再拆成多个项。
     *
     * 官方两处原文（这次是按文档改，不是按我的推断）：
     *   · USERGUIDE:32 「To improve text accuracy or control line breaks precisely,
     *     insert `\n` or actual line breaks directly into the prompt.」
     *   · layout_REFERENCE:21 「the exact visible characters, with literal intended line breaks
     *     represented as JSON `\n`. **Use separate text items when placement must be independent.**」
     *   · SKILL.md:36 明确反对 `arbitrary word budgets`（旧的「每段不超过 10 字」正是）。
     *
     * v0.9.158 的「超 10 字拆成多个 text 项」已被证伪：
     *   拆出来的第二个气泡 caption 与第一个一字不差 → 被画成「手里举的白色小卡片」（V1_r1 实拍）；
     *   而黑板同一句 12 字，不换行两轮都丢「是」，**插 `\n` 两轮 12 字全对**。
     *
     * `wrapBubble` 只插换行符：一个字都不删、不改写、不翻译（台词保真是硬要求）。
     */
    if (text) {
      const wrapped = wrapBubble(text, BUBBLE_MAX_CHARS);
      if (!wrapped) { dropped += 1; continue; }
      /**
       * ★★ 行数由代码算死并写进 caption —— 官方 recaption 规范（USERGUIDE:133）要求
       *   「Describe text layout as much as possible: line breaks, alignment, size hierarchy,
       *    font/style, color, spacing」，官方示例措辞就是 `comfortably legible on two lines`。
       *   而「几行」是代码能算的定值，不该让模型自己数（数数不稳是本项目的老教训）。
       */
      const rows = lineCountOf(wrapped);
      const shape = rows > 1
        ? `set in exactly ${rows} lines with the line breaks already fixed`
        : 'set on a single line';
      /**
       * ★★★ v0.9.163：先剥模型抄来的行数（示例句里有 `two lines`），再写代码算出的定值。
       *   不剥 = caption 里「2 行」和「6 行」并存（真实病例见 `stripBubbleLayoutClaims` 头注释）。
       *   剥干净之后 `evenly spaced, comfortably legible` 只会出现一次。
       */
      const base = stripBubbleLayoutClaims(caption || TEXT_CAPTION_FALLBACK) || TEXT_CAPTION_FALLBACK;
      items.push({ label, caption: `${base}, ${shape}, evenly spaced, comfortably legible.`, text: wrapped });
      continue;
    }
    /**
     * 官方 `compile_prompt.py:89`：`caption` 是 item 的**必填**字段。
     * 没有 caption 的人物项在旧代码里会被保留（`if (!caption && !text) continue` 才丢），
     * 于是产出 `{"label":"character"}` —— 官方 schema 下是非法项。
     */
    if (!caption) { dropped += 1; continue; }
    items.push({ label, caption });
  }
  if (!items.length) return null;
  if (dropped) {
    warn(STAGE.CONSISTENCY, `单图 JSON：有 ${dropped} 个 item 因缺字段/空台词被丢弃（官方 schema 要求 caption 非空）`);
  }
  const nChar = items.filter((x) => x.label === 'character').length;
  const nText = items.filter((x) => x.label === 'text').length;
  /**
   * ★★★ v0.9.159：单图**不写 bbox** 这一条保留，但补一道**位置自检**。
   *
   * 用户 2026-10-30 问得对：「bbox 不就是确认人物位置的？少了会不会有些场景人物错位？」
   *   —— bbox 确实是官方的 placement annotation，少了精度必然降。
   *   但 36 张实测（`dev_tmp/single_multi/_eval.md`）的取舍是硬的：
   *     每人各自 bbox → 8 人档 **0/3**（稳定多画一个）；全不写 bbox → **6/6**。
   *   ⇒ 不写 bbox 是对的，代价是位置只剩 caption 里的方位词。
   *   ⇒ 那么「方位词写了吗」就必须有人盯 —— 这里盯：多人物时逐项查。
   */
  if (nChar >= 2) {
    const POS_WORD = /\b(left|right|cent(?:re|er)|middle|foreground|background|behind|beside|next to|in front of|far side|against the|across from|upper|lower|edge|corner|side of)\b/i;
    const lost = items.filter((x) => x.label === 'character' && !POS_WORD.test(x.caption)).length;
    if (lost) {
      warn(STAGE.CONSISTENCY,
        `单图 JSON：${nChar} 个人物里有 ${lost} 个的 caption 没写方位词 —— 这一张没有 bbox，`
        + '位置全靠方位词，漏了就可能挤在一起或站错位置');
    }
  }
  /**
   * `summary.caption` 官方要求**非空**（compile_prompt.py:76）。
   * 模型偶发漏写，这里给一句最小兜底，而不是把 `""` 送出去。
   */
  let cap = String(summaryIn.caption || '').trim();
  if (!cap) {
    cap = `A single illustration with ${nChar} ${nChar === 1 ? 'person' : 'people'} in one scene`
      + (nText ? ', with speech balloons.' : '.');
    warn(STAGE.CONSISTENCY, '单图 JSON：模型没写 summary.caption，已用最小兜底句（这一张的构图描述会偏弱）');
  }
  /**
   * ★ v0.9.159：`meta` 是官方的 **medium / genre** 标签（layout_REFERENCE:15），
   *   不是画风。官方示例 `["product campaign","studio photography"]` / `["poster"]`。
   *   旧值 `['anime illustration']` 把风格（anime）与媒介（illustration）焊成一个词，
   *   送进去等于额外给了一句画风指令 —— 而画风只该在 `summary.caption` 第一句出现一次。
   */
  /**
   * ★★ v0.9.160：只丢**纯风格 / 质量词**，别把合法的 medium 一起丢。
   *
   * 上一版规则是 `/illustration|photoreal|style|quality/i`，结果把官方认可的 medium
   * `digital illustration`（官方示例同类：`studio photography`）也滤掉了 ——
   * 默认值里写着 `['anime','digital illustration']`，送出去只剩 `['anime']`，
   * 默认值和过滤规则自己打架（这种自相矛盾最容易一直没人发现）。
   *
   * 现在只拦「风格形容词 + 质量词」，`anime` / `manga` / `digital illustration` / `poster`
   * 这类 genre/medium 一律保留。
   */
  /**
   * ★★★ v0.9.184：`style` 从拦截词里**拿掉**，并且滤空后**不再回填 anime**。
   *
   *   用户 2026-11-01 在「画风档位 → 自定义」里填了 `tense dramatic manga style`，
   *   实测 6 批留档的 `meta` **一字不差全是** `["anime","digital illustration"]`
   *   —— 而同一批的首句写成 4 种样子。首句会漂、meta 却 6/6 恒定，
   *   说明不是模型在写，是这里在填。
   *
   *   两处都要负责：
   *     ① 旧正则有 `style` 这个 token ⇒ **任何** `xxx style` 的艺术风格词整条被当质量词删掉
   *        （实测：`manga` 留、`digital illustration` 留、`tense dramatic manga style` 被吞）；
   *     ② 滤空后兜底回填 `['anime','digital illustration']` ⇒ 用户想改写实，meta 永远回到动漫。
   *        **这是插件替用户做画风决定**，越界（画风属用户主权）。
   *
   *   ★ 官方依据（`官方文档/skills/layout_REFERENCE.md:15`）：
   *     `summary`: `caption` (nonempty global image description), **optionally `meta`**
   *     —— 只有 caption 要求非空，`meta` 本来就是可选的。所以留空 `[]` 合法，
   *     不需要也不应该塞一个模型没写过的值。
   */
  const STYLE_ONLY = /\b(?:quality|masterpiece|best quality|high quality|highly detailed|ultra detailed|photorealistic|hyperrealistic|8k|4k)\b/i;
  const metaIn = (Array.isArray(summaryIn.meta) ? summaryIn.meta : [])
    .filter((x) => typeof x === 'string' && x.trim() && !STYLE_ONLY.test(x));
  const out = {
    summary: {
      meta: metaIn,
      canvas: 'single',
      caption: cap,
    },
    items,
  };
  /** 画风前缀 / 后缀仍按老规矩**只并进 `summary.caption`**，不塞进任何 item。 */
  mergeLayoutGlobalWords(out, c);
  return out;
}

export function composePrompt(processed, cfg) {
  const c = cfg || getConfig();

  /* ---- K2 v4 三明治（2026-09-26）：按用户工作区定稿的段落顺序拼装 ---- */
  /* ---- v0.9.117：MOSS 口径复用同一条三明治分支（它同样是自然语分段） ---- */
  if (activeEngine() !== 'sd') {
    const tpl = getActiveTemplate();
    const isMoss = activeEngine() === 'moss';

    /**
     * ★★★ v0.9.121：Layout 输出格式的独立出口。
     *
     * 到这个函数时，`processed.tag` 是空的、`processed.layout` 是模型给的草稿对象。
     * 这里做三件事，**一件也不能少**：
     *
     * ① **编译坐标**：草稿（左上原点 + xyxy）→ 成稿（中心化 + yxyx 整数）。
     *    依据官方模板 §12.3：「优先使用官方编译器或计算工具完成机械转换；
     *    逐项检查结果，不凭目测估算」。尺寸必须取**当前实际画布**
     *    （`resSelector` 开着时 `width/height` 是死参数，实测坑过）。
     *
     * ② **前缀/后缀并进 `summary.caption`，不是拼在 JSON 外面**。
     *    依据 §12.3：「画风是 summary.caption 的第一句，不在每个 item 内重复」。
     *    把 `masterpiece, 1girl` 这类前缀拼在 JSON 字符串外面，MOSS 拿到的是
     *    「一段不像 JSON 也不像 caption 的东西」—— 轻则忽略，重则整份 Layout 不生效。
     *    用户的画风/质量词主权区因此照旧生效，只是位置换成官方要的位置。
     *
     * ③ **单行紧凑 JSON**（§12.3「以一物理行紧凑JSON交付」），根字段只留官方四个。
     */
    /**
     * ★★★ v0.9.186：**画布尺寸现算一次**，三条出口（json / manga / layout）共用。
     *
     * 以前只有 layout 分支里算，manga 分支要是自己再抄一份，就是"两套行号坐标系"
     * 那个老病（算与比必须是同一份数据）。抽成闭包，谁用谁调，值一定一致。
     */
    const canvasWH = () => {
      const be = c.backends?.comfyui || {};
      let W = 0; let H = 0;
      if (be.resSelector?.enabled !== false) {
        const r = estimateResolution(be.resSelector?.aspect, be.resSelector?.megapixels, be.resSelector?.multiple);
        W = r.width; H = r.height;
      } else {
        W = Number(be.width) || 0; H = Number(be.height) || 0;
      }
      if (!W || !H) { const r = estimateResolution(); W = r.width; H = r.height; }
      return { W, H };
    };

    /**
     * ★★★ v0.9.186：**漫画台原生出口**（用户 2026-11-01：「照搬迁移到绘灵，我需要原汁原味」）。
     *
     * 与 `layout` 出口的分工（这是本节唯一需要看懂的一句话）：
     *   · `layout`：模型只答内容，坐标由插件的版式库算（`buildMangaPage` / `compileLayout`）；
     *   · `manga` ：模型**自己写 bbox**（漫画台 page.json 结构），插件只做
     *     `compileMangaPage` —— 那是漫画台 `compilePage` 的逐字移植版，
     *     与漫画台对同一份 page.json 的产物**逐字节一致**（`dev_tmp/manga-native-parity.mjs`）。
     * 所以这里**绝不能**再调 `compileLayout`：它会一个 object 一格地重写 bbox，就不是漫画台了。
     */
    if (activeOutput() === 'manga') {
      const { W, H } = canvasWH();
      /**
       * 角色表：漫画台的 `project.characters` 由人维护，绘灵没有这个存档 ——
       * 所以让模型在 page JSON 里带 `characters: [{id, name}]`（外貌仍从档案注入，
       * 避免模型自己重写外貌导致跨楼漂移）。档案里查不到的，才用模型给的 `look`。
       */
      const meta = Array.isArray(processed.layoutJson?.characters) ? processed.layoutJson.characters : [];
      const byId = new Map(meta.map((ch) => [String(ch?.id ?? ''), ch]));
      const looksOf = looksResolver(processed.castLines);
      const resolveCharacter = (ref) => {
        const row = byId.get(String(ref ?? '')) || {};
        const look = String(row.look || '').trim() || String(looksOf(ref) || '').trim();
        const name = String(row.name || '').trim() || String(ref || '');
        return { name, look };
      };
      const r = compileMangaPage(processed.layoutJson, { width: W, height: H, resolveCharacter });
      if (!r.ok) {
        warn(STAGE.CONSISTENCY, `漫画台口径编译失败（${W}x${H}），这张图不出 —— ${r.errors.slice(0, 4).join('；')}`);
        return { prompt: '', negative: '', nl: '', strippedRefs: 0, strippedCjk: 0, layoutErrors: r.errors };
      }
      for (const w of r.warnings) warn(STAGE.CONSISTENCY, `漫画台：${w}`);
      info(STAGE.CONSISTENCY,
        `漫画台口径（${W}x${H}）：${r.stats.items} 项 · ${r.stats.chars} 人 · ${r.stats.texts} 句台词`);
      /** 全局词（前缀/后缀）照旧只并进 `summary.caption`，与 layout 出口同一份逻辑。 */
      mergeLayoutGlobalWords(r.doc, c);
      return {
        prompt: layoutToLine(r.doc),
        negative: normalizeTagSpaces(String(c.globalNegative || '').trim()),
        nl: '',
        strippedRefs: 0,
        strippedCjk: 0,
        layoutStats: r.stats,
      };
    }

    if (activeOutput() === 'json') {
      const out = singleJsonPrompt(processed.layoutJson, c);
      if (!out) {
        warn(STAGE.CONSISTENCY, '单图 JSON 草稿里一个 item 都没有 —— 这张图不出（重跑一次通常就好）');
        return { prompt: '', negative: '', nl: '', strippedRefs: 0, strippedCjk: 0, layoutErrors: ['empty items'] };
      }
      return {
        prompt: layoutToLine(out),
        negative: normalizeTagSpaces(String(c.globalNegative || '').trim()),
        nl: '',
        strippedRefs: 0,
        strippedCjk: 0,
        layoutStats: { single: true, people: out.items.filter(x => x.label === 'character').length },
      };
    }

    if (activeOutput() === 'layout') {
      const be = c.backends?.comfyui || {};
      let W = 0; let H = 0;
      if (be.resSelector?.enabled !== false) {
        const r = estimateResolution(be.resSelector?.aspect, be.resSelector?.megapixels, be.resSelector?.multiple);
        W = r.width; H = r.height;
      } else {
        W = Number(be.width) || 0; H = Number(be.height) || 0;
      }
      /**
       * ★ v0.9.159：回落值改成**现算**（同 `canvasOf` 的理由）——
       * 写死 864×1152 会把「用 1e6 当兆像素」这个旧错误固化进坐标里。
       */
      if (!W || !H) { const r = estimateResolution(); W = r.width; H = r.height; }

      /**
       * ★ v0.9.136：第 4 个参数把「画面强化」设置传进去。
       *
       * 以前这里**不传 opts**，靠 `compileLayout` 内部回落到 `getPickedLayout()`
       * 拿版式（生成指令时 `buildMossJsonDirective` 记下的那一个）—— 那条路照旧有效。
       * 现在多传 `enhance`，让编译层知道「粗黑边框 / 斜切 / 主格撑满 / 补格策略」开没开。
       * 不传 = 全部走默认值（border/fill 开、slant 关、pad=angle），
       * 所以老配置升级后行为是「多了黑框和撑满」，用户可在 UI 里关掉。
       */
      /**
       * ★★★ v0.9.140：**漫画页模式** —— 内容与坐标彻底分离。
       *
       * 判据是**结构**（`panels` 数组且没有 `items`），不是模型有没有照抄某个标记字段：
       * 实测模型对「请输出 kind: manga_page」这类要求遵守率并不可靠，
       * 而旧草稿必然带 `items[]`、新草稿必然带 `panels[]`，这个区分是硬的。
       *
       * 坐标全部由 `mossMangaPage` 按版式库计算 → 不经过 `compileLayout`，
       * 因为后者把「一个 object = 一个格子」，会把一格多框（背景层/主体层/气泡位）
       * 当成「模型多写了格」并强制重写 16/16 个 bbox（已实测）。
       */
      if (isMangaDraft(processed.layoutJson)) {
        const r = buildMangaPage(processed.layoutJson, W, H, {
          style: MANGA_STYLE_FALLBACK,
          looks: looksResolver(processed.castLines),
          layoutId: c.mossJson?.mangaLayout,
          /** ★ v0.9.141：第一人称「我」对应谁 —— 只有设置能给（模型猜不准，见 mossMangaPage 注释）。 */
          narrator: c.mossJson?.narrator,
          /**
           * ★★★ v0.9.154：**画面强化设置必须传进来**，否则漫画页上那几项等于没开。
           * 病例：斜切 `slant: true` 用户一直开着，但漫画页从 v0.9.140 起就没接
           * (`applyVisualEnhance` 只在旧 `compileLayout` 路径调用) ⇒ 一页也没斜过。
           */
          enhance: c.mossJson,
        });
        if (!r.ok) {
          warn(STAGE.CONSISTENCY, `漫画页组装失败（${W}x${H}），这张图不出 —— ${r.errors.slice(0, 4).join('；')}`);
          return { prompt: '', negative: '', nl: '', strippedRefs: 0, strippedCjk: 0, layoutErrors: r.errors };
        }
        for (const w of r.warnings) warn(STAGE.CONSISTENCY, `漫画页：${w}`);
        info(STAGE.CONSISTENCY,
          `漫画页版式 ${r.stats.layout}（${r.stats.panels} 格 · ${r.stats.characters} 人 · ${r.stats.texts} 句台词`
          + ` · ${r.stats.items} 项`
          /** v0.9.149：`mainBeat`→主格的位置（-1 = 四格等大，没有主格）。 */
          + ` · 主格 ${r.stats.mainBeat ? `${r.stats.mainBeat}→${r.stats.mainPanel >= 0 ? r.stats.mainPanel + 1 : '无'}` : '未填'}）`);
        const outM = mergeLayoutGlobalWords(r.out, c);
        return {
          prompt: layoutToLine(outM),
          negative: normalizeTagSpaces(String(c.globalNegative || '').trim()),
          nl: '',
          strippedRefs: 0,
          strippedCjk: 0,
          layoutStats: r.stats,
          mangaLayout: describeMangaLayout(mangaLayoutOf(r.stats.layout)),
        };
      }

      const compiled = compileLayout(processed.layoutJson, W, H, { enhance: c.mossJson });
      if (!compiled.ok) {
        warn(STAGE.CONSISTENCY,
          `Layout 编译失败（${W}x${H}），这张图不出 —— ${compiled.errors.slice(0, 4).join('；')}`);
        return { prompt: '', negative: '', nl: '', strippedRefs: 0, strippedCjk: 0, layoutErrors: compiled.errors };
      }
      for (const w of compiled.warnings) warn(STAGE.CONSISTENCY, `Layout：${w}`);

      const out = compiled.out;
      /**
       * 全局词库（前缀 / 后缀）在 Layout 下怎么落 —— **只并进 `summary.caption`**，
       * 绝不塞进 `items`（那是坐标框，塞进去等于给某一格加词）。
       *
       * ★ v0.9.122 两道清洗，都是实测会踩的：
       *   ① 用户的前缀多半是逗号 tag 串（`masterpiece, best quality,`），
       *      直接 `join('. ')` 会拼出 `, . 画风句` 这种脏串；
       *   ② 前缀自己常带句末标点，和 `. ` 叠成 `..`。
       * 落点可切「不注入」（`mossJson.gword === 'off'`）：
       *   前缀若是 SD 式 tag（`score_9, score_8_up`），塞进自然语 caption 只会稀释画风句。
       */
      /**
       * 全局词并进 `summary.caption`（v0.9.140 抽成函数，漫画页走同一份逻辑）。
       */
      mergeLayoutGlobalWords(out, c);
      return {
        prompt: layoutToLine(out),
        negative: normalizeTagSpaces(String(c.globalNegative || '').trim()),
        nl: '',
        strippedRefs: 0,
        strippedCjk: 0,
        layoutStats: compiled.stats,
      };
    }

    /**
     * ★★★ v0.9.119：**MOSS 口径跳过 trimPromptFat**。
     *
     * `trimPromptFat` 是给 K2 的 tag 串做「部位声明超 6 个就削 / 同义情绪去重」的 ——
     * 它的判据建立在「逗号分隔的短 tag」上。MOSS 的 tag 是**整段自然语**，
     * 一个格子就是一句话，里面本来就有 collar / sleeve / hem 多个部位词。
     *
     * 实测病例（2026-10-21 本机真实出图）：
     *   原文 `Panel 2, middle left: exactly two people in this panel. Medium shot from the side
     *   of the girl stepping forward out of the shadow, back straight, …`
     *   被它当成「部位声明超 6 个」，**从 Panel 2 开头整段削掉**，剩
     *   `Panel 2, back straight, one hand holding a black briefcase…`
     *   ⇒ 方位词（排版比例）和景别（中等景）一起没了 —— 这正是用户反复看到
     *   「Panel 2 只有半句 / 格子排版不对」的成因之一。
     *
     * 所以：MOSS 下不削。要防「描述过长导致扭曲」，靠规范里「每格 40~90 词」+ 景别拉开，
     * 而不是靠一个只认逗号 tag 的机械规则。
     */
    if (!isMoss) {
      const r = trimPromptFat(processed.cast, processed.tag);
      if (r.cut.length) {
        processed = { ...processed, cast: r.cast, tag: r.tag };
        warn(STAGE.CONSISTENCY, `提示词精简：删掉 ${r.cut.length} 处冗余（部位声明超 ${TRIM_PART_CAP} 个 / 同义情绪重复 / 情绪堆超 ${TRIM_EMO_CAP} 个）—— ${r.cut.slice(0, 3).join(' | ')}`);
      }
    }
    /**
     * ★ v0.9.117：MOSS 口径**永远不插写实锚定块**。
     *   `K2_PHOTOREAL_ANCHOR` 是一串「photorealistic, 35mm, film grain…」，
     *   与 MOSS 要的漫画/插画线条直接对立 —— 插进去它会往写实照片跑。
     *   用户即使 copy 了 styled 版模版（variant 沿用），也不该吃这块锚定。
     */
    const styled = !isMoss && tpl?.variant === 'styled';
    // 纯英文单段模版（variant='en'）：tag 自写外貌服装 —— 不注入人物段/场景段/收尾段，
    // 否则和句里的外貌描述权重翻倍。最终 = 全局前缀 + tag 整段 + 全局后缀。
    const enSingle = tpl?.variant === 'en';
    const finalTag0 = String(processed.tag || '').trim();
    // @ 残留闸：正常已在 expandRefs 剥净；regenerate 等旁路进来的一律再剥一次
    const finalTag = finalTag0.replace(FINAL_REF_RE, '');

    if (enSingle) {
      const blocks = [];
      if (c.globalPrefix?.trim()) blocks.push(c.globalPrefix.trim());
      /**
       * ★★★ v0.9.117：MOSS 走「保行」剥宏。
       *   `stripMacros` 里的 `\s{2,} → ' '` 会把 `Panel 1\n\nPanel 2` 之间的空行吞掉，
       *   三格压成一行就再也不切格了（实测）。
       */
      const tagText = finalTag.trim()
        ? (isMoss ? stripMacrosKeepLines(finalTag.trim()) : stripMacros(finalTag.trim()))
        : '';
      /**
       * ★★★ v0.9.118：MOSS 必须机械注入英文人物段（详见 mossCastParagraph 头注释）。
       *   用户实测：不注入 → 出词模型抄不抄档案全看运气，同一段剧情三张图三个结果。
       */
      if (isMoss) {
        const vac = stripEmptyBubbles(tagText);
        if (vac.dropped) {
          warn(STAGE.CONSISTENCY, `删掉 ${vac.dropped} 处空引号气泡（reads "" / reads " "）—— 出词模型没把台词写出来；检查本楼正文的对白是否被漏掉`);
        }
        // 先按结构重排（模型基本不写换行），再插人物段 —— 顺序反了会把人物段的换行一起抹平
        const merged = injectMossCast(formatMossPrompt(vac.text), String(processed.castEn || '').trim());
        if (merged) blocks.push(merged);
      } else if (tagText) {
        blocks.push(tagText);
      }
      if (c.globalSuffix?.trim()) blocks.push(c.globalSuffix.trim());
      /**
       * ★★ 拼接符按口径分开：MOSS 的段落靠 `\n\n` 表达语义（版面声明 / 人物段 / 每格 / 台词行），
       *    用逗号连接等于把结构压成一句 —— 与「BREAK 不许被逗号切分扫过」是同一条教训。
       */
      const joined = isMoss
        ? blocks.filter(Boolean).join('\n\n')
        : blocks.filter(Boolean).join(', ');
      // ★ v0.9.118：MOSS 必须走保行版 —— `tidySeparators` 的 `,\s+ → ', '` 会把空行吃掉
      const prompt = isMoss
        ? normalizeTagSpaces(tidySeparatorsKeepLines(joined))
        : normalizeTagSpaces(tidySeparators(joined));
      // 模型若仍回了中文段（scene/mood/nl），全部丢弃 —— 本模版是纯英文口径
      const stray = [processed.scene, processed.cast, processed.mood, processed.nl]
        .map(v => String(v || '').trim()).filter(Boolean).length;
      if (stray) {
        warn(STAGE.CONSISTENCY, `「${tpl?.name || (isMoss ? 'MOSS' : 'K2 纯英文单段')}」模版不使用 scene/mood/cast —— 已丢弃 ${stray} 段中文/冗余字段`
          + (isMoss ? '（MOSS 口径下人物外貌由插件注入英文段，台词要中文写进 tag 引号内）' : '（人物外貌应由英文段自写）'));
      }
      /**
       * ★ v0.9.118：MOSS 口径**永不带 nl**。
       *   `nl` 是给「tag 说不圆构图/光线/情绪」的模型补氛围用的（K2 的 Qwen 编码器）。
       *   MOSS 的 tag 本身就是一整段完整提示词（分格 + 台词都在里面），再叠一段中文描述 =
       *   同一个画面被描述两遍 → 语义平均成中间态。而 `composeComfyNlPrompt` 在工作流没有
       *   `%nl%` 槽位时会把它**直接追加到 prompt 末尾**，等于往画面词后面贴散文。
       */
      return {
        prompt,
        negative: normalizeTagSpaces(c.globalNegative?.trim() || ''),
        nl: '',
        strippedRefs: 0,
        strippedCjk: 0,
      };
    }

    /**
     * v0.9.53：段落编排 —— 用户可调各段的顺序与开关（设置页全局一份 / 单张可覆盖）。
     * 段的内容**全部来自本楼剧情与角色档案**，编排只决定"排不排、排第几"。
     * 没配 layout 时走下面的出厂顺序，与旧版逐字一致（零行为变化）。
     */
    const layout = processed.layout || c.promptLayout || null;
    /**
     * ★★ v0.9.98：走哪条分支改成看 `layoutConfigured`（order 或 off 非空都算"配过"）。
     * 旧条件是 `layout.order.length` —— 用户把七段全关时 order 变空，与"从来没配过"同形，
     * 于是七个 off 一个都不执行，静默回退出厂顺序（实测就是用户当前的真实配置）。
     */
    const k2Cfg = layoutConfigured(layout);
    const k2On = (id) => segmentOn(layout, id);
    const k2Trace = [];
    let blocks = [];
    const pushK2 = (id, text) => { if (text) { blocks.push(text); k2Trace.push({ id, text }); } };
    if (k2Cfg && normalizeLayout(layout).order.length) {
      const seg = {
        prefix: String(c.globalPrefix || '').trim(),
        anchor: styled ? K2_PHOTOREAL_ANCHOR : '',
        scene: stripMacros(String(processed.scene || '').trim()),
        cast: stripMacros(String(processed.cast || '').trim()),
        costume: stripMacros(String(processed.costume || '').trim()),
        tag: stripMacros(finalTag.trim()),
        suffix: String(c.globalSuffix || '').trim(),
      };
      // v0.9.65：出现「the other woman」这类不定指代时，紧跟人物段补一句人数上限，
      // 堵住模型把指代当成第三个人（多人场次人物重叠/多出人的直接来源）。
      const guard = headcountGuard(String(processed.cast || ''), finalTag);
      blocks = [];
      for (const id of normalizeLayout(layout).order) {
        // 未知 id / 该段本楼没有内容 → 跳过（拼进去只会多一个空行）
        const v = seg[id];
        pushK2(id, v);
        if (id === 'cast' && guard) pushK2('guard', guard);
      }
    } else {
      blocks = [];
      /**
       * ★★ v0.9.98：出厂顺序**也要尊重 off**。
       * 旧代码这条分支完全不看 off ⇒ 用户把「写实锚定」关掉、再把别的段关到 order 为空时，
       * 锚定块会原样回来，同一个开关两种行为。现在统一按 segmentOn 判。
       *
       * ★ 同时补上 costume：`processImage` 在 costumeSeparate 打开时会把服装从句里**剥出去**，
       * 旧代码这条分支却不拼 costume ⇒ K2 下勾「服装独立成段」+ 编排全关 = **服装整段消失**
       * （实测两位角色的「身穿…」全没了）。
       */
      if (k2On('prefix') && c.globalPrefix?.trim()) pushK2('prefix', c.globalPrefix.trim());
      if (k2On('anchor') && styled) pushK2('anchor', K2_PHOTOREAL_ANCHOR);
      if (k2On('scene') && String(processed.scene || '').trim()) pushK2('scene', stripMacros(String(processed.scene).trim()));
      if (k2On('cast') && String(processed.cast || '').trim()) {
        pushK2('cast', stripMacros(String(processed.cast).trim()));
        const g = headcountGuard(String(processed.cast || ''), finalTag);
        if (g) pushK2('guard', g);
        if (k2On('costume') && String(processed.costume || '').trim()) {
          pushK2('costume', stripMacros(String(processed.costume).trim()));
        }
      }
      if (k2On('tag') && finalTag.trim()) pushK2('tag', stripMacros(finalTag.trim()));
      if (k2On('suffix') && c.globalSuffix?.trim()) pushK2('suffix', c.globalSuffix.trim());
      /**
       * 兜底：**角色段与动作段是内容主体**，两个都被关掉（或关到全空）时不能真的输出
       * 空串/一句画质词 —— 那是废图。回落成"不过滤的出厂顺序"并明说。
       */
      const k2Bodyless = !k2On('cast') && !k2On('tag');
      if (k2Bodyless || !blocks.length) {
        warn(STAGE.CONSISTENCY, k2Bodyless
          ? '段落编排把「角色段」和「动作段」都关掉了 —— 提示词里没有人物也没有动作，会出一张废图。已回退到出厂顺序（面板里至少要留一段）'
          : '段落编排把所有段都关掉了，提示词会变成空串 —— 已回退到出厂顺序（面板里至少留一段）');
        blocks.length = 0;
        k2Trace.length = 0;
        if (c.globalPrefix?.trim()) pushK2('prefix', c.globalPrefix.trim());
        if (styled) pushK2('anchor', K2_PHOTOREAL_ANCHOR);
        if (String(processed.scene || '').trim()) pushK2('scene', stripMacros(String(processed.scene).trim()));
        if (String(processed.cast || '').trim()) {
          pushK2('cast', stripMacros(String(processed.cast).trim()));
          const g2 = headcountGuard(String(processed.cast || ''), finalTag);
          if (g2) pushK2('guard', g2);
          if (String(processed.costume || '').trim()) pushK2('costume', stripMacros(String(processed.costume).trim()));
        }
        if (finalTag.trim()) pushK2('tag', stripMacros(finalTag.trim()));
        if (c.globalSuffix?.trim()) pushK2('suffix', c.globalSuffix.trim());
      }
    }

    const prompt = normalizeTagSpaces(blocks.join('\n'));
    // 废弃字段：mood / nl（旧版中文情绪段）—— 一律丢弃，不拼进提示词。
    // 依据（2026-09-27 用户实测）：中文段复述英文 tag 里已写的动作与身体状态，
    // 模型把复述当成又一次动作请求 → 把动作与物体复制成多份（实测多长出一只手）。
    const deadMood = String(processed.mood || '').trim();
    const deadNl = String(processed.nl || '').trim();
    if (deadMood || deadNl) {
      warn(STAGE.CONSISTENCY,
        `已丢弃废弃的中文情绪段（${[deadMood ? 'mood' : '', deadNl ? 'nl' : ''].filter(Boolean).join(' / ')}）—— 情绪请写进 tag 英文段末句，中文复述会让模型把动作复制成多份（多手 / 多道具）`);
    }
    // 中文已并入 prompt（nl 置空）—— 防止 comfyui 的 nlFallback 把中文再追加一遍
    return {
      prompt, negative: normalizeTagSpaces(c.globalNegative?.trim() || ''), nl: '', strippedRefs: 0, strippedCjk: 0,
      structure: buildStructure('k2', k2Cfg ? 'layout' : 'default', k2Trace, prompt),
    };
  }

  /* ---- SD：tag 串逻辑 ---- */
  /**
   * v0.9.94 · SD 分支也吃段落编排（用户 2026-10-17 要求「SD 模式下也能自由排顺序」）。
   *
   * ★ 为什么值得做：`comfy/sd1_clip.py:49` 的 `first_pooled = pooled[0:1]` 决定
   *   **全局语义只取第 1 块（前 77 token）**。锚点（外貌+服装+状态）全排在前面的话，
   *   第 1 块就被外貌碎片占满，本楼的**动作 / 场景 / 光线**全落进第 2 块之后 →
   *   实测表现就是「提示词写了后入式，出图却是张站着的肖像」。
   *   把「动作段」排到「角色段」之前，剧情就能进第 1 块。
   *
   * ★ 拆分口径：锚点是机械注入的，一定在 processed.tag 里出现过一次。
   *   取不到（子串匹配失败）就**整体当动作段、不拆** —— 宁可不编排，也不凭空复制一份锚点。
   */
  const sdOpt = c.sdOptions || {};
  /**
   * ★★ v0.9.96 修正：旧代码读的是 `processed.anchors`，而 `processImage` 返回的键叫
   *   `anchorList`（`:2809`）—— **这个键从来不存在**，所以 `sdAnchorText` 恒空、
   *   `if (...)` 恒 false、`sdCast` 恒空，SD 段落编排从上线起就是死的。
   *   两个名字都读，兼容旧调用方（有测试/存档按 `anchors` 传）。
   *
   * 并且改成**逐个摘**：旧代码要求「所有锚点按顺序拼成的整串」原样出现在 tag 里，
   * 一个角色被去重削短就整体失败；逐个头摘，谁能摘出来就先切谁。
   */
  const sdAnchorArr = (processed.anchorList || processed.anchors || [])
    .map((a) => ({ name: a?.name, text: String(a?.text || '').trim() }))
    .filter((a) => a.text);
  const pickedAnchors = [];
  let sdCast = '';
  let sdTag = String(processed.tag || '').trim();
  /**
   * ★★ v0.9.97：从「整串 includes」改成 **token 级摘除**（2026-10-18 真机 P5 实证）。
   *
   * 病例：女主锚点串的 `fair skin` / `tall` 与男主同名，在 `dedupeTagKeepingAnchors`
   *   之前就被去重删掉 ⇒ `sdTag.includes(a.text)` 恒 false ⇒ 这段锚点认不出来、
   *   留在动作段里 ⇒ **女主外貌跟男主挤在同一段**，且她的角色段消失（串台的直接形态）。
   * 现在：按 token 顺序贪心匹配，命中 ≥ 60% 且 ≥3 项就认定，命中的 token 从 tag 里删掉；
   *   角色段仍用**完整**锚点（外貌一项不缺）。命中太少则宁可不认，也不乱摘。
   */
  const splitToks = (s) => String(s || '').split(',').map((t) => t.trim()).filter(Boolean);
  for (const a of sdAnchorArr) {
    const want = splitToks(a.text);
    if (!want.length) continue;
    const wantLower = want.map((t) => t.toLowerCase());
    let j = 0;          // want 的游标（已匹配到哪一项）
    let matched = 0;
    const keep = [];
    for (const t of splitToks(sdTag)) {
      const tl = t.toLowerCase();
      /**
       * ★ 关键：**允许 want 里缺项**（不是 tag 缺项）。
       *   锚点被上游去重削掉 `fair skin, tall` 后，若仍要求逐项对齐，
       *   游标会卡在 `fair skin` 这一项上原地不动 ⇒ 后面的 `large breasts`、
       *   服装全部匹配不上 ⇒ 命中率跌破阈值 ⇒ 这段锚点又认不出来（串台原样复现）。
       *   所以这里在 want 的**剩余部分里向前找**，跳过的项视为「上游已删」。
       */
      let found = -1;
      for (let k = j; k < wantLower.length; k += 1) {
        if (wantLower[k] === tl) { found = k; break; }
      }
      if (found === -1) { keep.push(t); continue; }
      j = found + 1;
      matched += 1;
    }
    /**
     * 门槛：至少命中 2 项且 ≥60%。
     * ★ 不能要求 3 项 —— 真实锚点至少 3 项，但**短锚点/测试用锚点**可能只有 2 项，
     *   卡 3 会把它们整体判成「不是锚点」→ 锚点留在动作段里（anchor-slim D2 实测）。
     *   单项不认（`1girl` 这种公共词单独出现不算锚点）。
     */
    if (matched < 2 || matched / want.length < 0.6) continue;   // 命中太少 → 不是这段锚点
    sdTag = keep.join(', ');
    pickedAnchors.push(a);
    sdCast += (sdCast ? ', ' : '') + a.text;
  }
  sdTag = tidySeparators(sdTag);

  /**
   * ★★★ v0.9.112 · 画面结构确定性归一（用户 2026-10-20 报「肢体扭曲」）。
   *
   * 病历（真机原串）：`..., vaginal, penis, pussy, penetration, from behind, close up, profile, face`
   *   ① 景别 1 个 + 机位 2 个（`profile` / `from behind`）→ 违反 §2.4「各选一个」，模型只能取平均，人物朝向扭；
   *   ② `close up` × 躯干以下接触（pussy / vaginal）→ 违反 §2.4「接触点在躯干以下时禁用 close up」，
   *      画幅拍不到的地方模型硬塞 → 肢体折叠；
   *   ③ `penetration` → §5.10 禁词，且与 `vaginal` 堆叠 → §5.3「选一个主行为」。
   *   三条都是**可确定性判定**的，不需要模型再想一遍，所以在这里直接改。
   *
   * ★ 为什么必须在**摘完锚点之后**：此时 `sdTag` 只剩「画面公共区」（动作/机位/场景），
   *   锚点（外貌服装）里不会有机位景别，动它才不会被误伤。
   * ★ 为什么必须在**拼 BREAK 之前**：`fixSdCompose` 按 tag 边界工作，拼段之后 `from behind`
   *   可能和邻段粘在一起，整条匹配就失效了。
   */
  try {
    const compose = fixSdCompose(sdTag);
    if (compose.changes.length) {
      sdTag = compose.text;
      warn(STAGE.CONSISTENCY,
        `画面结构已归一并 ${compose.changes.length} 处：${compose.changes.map((x) => `${x.from}${x.to ? `→${x.to}` : '（删）'}`).join('、')}`
        + ` —— 依据 SD 规范 §2.4（景别机位各选一个、躯干以下禁用近景）/ §5.3（主行为选一个）`);
    }
  } catch (err) {
    // 归一失败不能拦出图：宁可原样送去，也不能因为清洗报错把这张图吞掉。
    warn(STAGE.CONSISTENCY, `画面结构归一失败（已跳过，提示词原样使用）：${err?.message || err}`);
  }

  /** 段间分隔：BREAK 开关关掉时回到逗号（原生 CLIPTextEncode 只把 BREAK 当普通单词）。 */
  const sdSep = sdOpt.breakSeparator ? '\nBREAK\n' : ', ';

  const sdLayout = processed.layout || c.promptLayout || null;
  const sdCfg = layoutConfigured(sdLayout);
  const sdOn = (id) => segmentOn(sdLayout, id);
  const sdOrder = sdCfg ? normalizeLayout(sdLayout).order : [];
  const pieces = [];
  /** v0.9.98：段级轨迹（诊断页据此显示"实际结构 + 每段从第几项开始"）。 */
  const sdTrace = [];
  const pushSd = (id, text) => {
    const t = String(text || '').trim();
    if (!t) return;
    pieces.push(t);
    sdTrace.push({ id, text: t });
  };
  /**
   * ★ 每个角色段先做**单段**清洗（剥中文），再进拼装。
   *   不能留到最后整串清洗 —— `cleanTag:118` 是全局 seen 去重，两个角色都有的
   *   `black hair` / `fair skin` / `1girl` 会把后一个删掉，**等于把角色段拆散**
   *   （实测：男主段 8 个 tag 被删成 5 个，段首 `1boy` 也消失）。
   */
  const cleanSeg = (t) => cleanTag(t, { allowCjk: false }).tag;
  const castSegs = pickedAnchors.map((a) => cleanSeg(a.text)).filter(Boolean);
  /**
   * 总览人数词（≥2 人才有意义）。
   * ★ v0.9.98：`count` 段是新增的可选段 —— 勾了它就能把人数词**单独**排到任意位置
   *   （以前它固定粘在首段，用户没法只动它）。没勾时行为与 v0.9.97 完全一致（并进首段）。
   */
  const wantCount = sdOpt.countTags !== false && pickedAnchors.length >= 2 && sdOn('count');
  const overviewTag = wantCount ? overviewCountTag(pickedAnchors) : '';
  const countPlaced = !!overviewTag && sdOrder.includes('count');
  let countUsed = false;

  if (sdCfg && sdOrder.length) {
    // SD 下只有 prefix / count / cast / tag / suffix 会有值；anchor / scene / costume 恒空 → 自动跳过
    const seg = {
      prefix: String(c.globalPrefix || '').trim(),
      cast: sdCast,
      tag: sdTag,
      suffix: String(c.globalSuffix || '').trim(),
    };
    for (const id of sdOrder) {
      if (!sdOn(id)) continue;                  // 在 order 里但被 off 掉 → 不输出
      if (id === 'count') {
        if (overviewTag) { pushSd('count', overviewTag); countUsed = true; }
        continue;
      }
      if (id === 'cast') {
        // ★ 每个角色单独成段（用户 2026-09-28 拍板：每人外貌+动作+表情自成一段）。
        //   段首已由 anchorOf 写成人数词（1girl / 1boy），这里只负责切段。
        for (const s of castSegs) pushSd('cast', s);
        continue;
      }
      const v = seg[id];
      if (v) pushSd(id, v);
    }
    // 一个锚点都没摘出来（模型没写 @、锚点是自愈补的）→ 别把 cast 段整个吞掉
    if (!castSegs.length && sdCast && sdOn('cast')) pushSd('cast', cleanSeg(sdCast));
    if (overviewTag && !countUsed) {
      /**
       * 人数词没被单独排 → **并进第一段**（v0.9.97 定稿的形态）。
       * 旧代码 `pieces.unshift(overviewTag)` ⇒ 第一段只有 `1boy, 1girl`，
       * 一个 CLIP 块被纯人数词浪费掉（`sd1_clip.py:49` 全局语义只取第 1 块）。
       * 用户手写样例：`<prefix + 人数 + 场景动作> BREAK <角色1> BREAK <角色2>`。
       */
      if (pieces.length) {
        pieces[0] = `${overviewTag}, ${pieces[0]}`;
        if (sdTrace[0]) sdTrace[0].text = pieces[0];
      } else {
        pushSd('count', overviewTag);
        countUsed = true;
      }
    }
    /**
     * ★ v0.9.98：**编排分支也要兜底**。
     *   只勾了「风格前缀」、把角色段与动作段都关掉时，拼出来是
     *   `1boy, 1girl, multi view, speech bubble, comic` —— 一张没有任何人物与动作的废图。
     *   实测（B4）：order=['prefix'] + off=['tag','cast'] 就走到这里。
     */
    if (!sdOn('cast') && !sdOn('tag')) {
      warn(STAGE.CONSISTENCY, '段落编排把「角色段」和「动作段」都关掉了 —— 提示词里没有人物也没有动作，会出一张废图。已回退到出厂顺序（面板里至少要留一段）');
      pieces.length = 0;
      sdTrace.length = 0;
      const h3 = [];
      if (c.globalPrefix?.trim()) h3.push(c.globalPrefix.trim());
      if (overviewTag) h3.push(overviewTag);
      if (sdTag) h3.push(sdTag);
      else if (!castSegs.length) h3.push(processed.tag);
      if (h3.length) pushSd('head', h3.join(', '));
      for (const s of castSegs) pushSd('cast', s);
      if (c.globalSuffix?.trim()) pushSd('suffix', c.globalSuffix.trim());
    }
  } else {
    /**
     * ★★ v0.9.97：SD 分支**不再依赖「段落编排」配置**（2026-10-18 真机实证 P0）。
     *
     * 病例：用户真实配置 `cfg.promptLayout = { order: [], off: [全部段] }`
     *   —— 他在编排页把段全关掉了。旧代码走这里直接 `pieces.push(processed.tag)`：
     *   ① 全程只有 1 个 BREAK（prefix 与整串之间），用户开了「段间插入 BREAK」却看不出效果；
     *   ② 两个角色的锚点在**整串** `cleanTag` 里被全局去重互相削短
     *      （女主锚点少了 `fair skin, tall`），于是连角色段都认不出来 ⇒ **串台**。
     *
     * 结论：「每人一段」不是可选项，它是 SD 防串台的结构，必须有出厂默认。
     *   默认结构（对齐用户手写样例 测试提示词2.txt）：
     *     `<prefix>, <人数词>, <剩余 tag：场景 / 动作 / 构图>  BREAK  <角色1>  BREAK  <角色2>`
     *
     * ★ v0.9.98：即使走出厂顺序也**尊重 off**（否则"关掉某段"在全关状态下会被静默忽略）。
     */
    const head = [];
    if (sdOn('prefix') && c.globalPrefix?.trim()) head.push(c.globalPrefix.trim());
    if (overviewTag) head.push(overviewTag);
    if (sdOn('tag') && sdTag) head.push(sdTag);
    else if (sdOn('tag') && !castSegs.length) head.push(processed.tag);
    if (head.length) pushSd('head', head.join(', '));
    if (sdOn('cast')) for (const s of castSegs) pushSd('cast', s);
    if (sdOn('suffix') && c.globalSuffix?.trim()) pushSd('suffix', c.globalSuffix.trim());

    /**
     * ★ v0.9.98 兜底口径：**角色段与动作段是内容主体**，两个都被关掉就是废图
     *   （只剩一个 `1boy, 1girl` 或一句画质词）。这时回退到不过滤的出厂顺序并明说，
     *   别让用户以为插件坏了 —— 也别真的把空提示词送去出图。
     * ★ 只关其中一个不算：用户可能就想"只要人物不要动作"或反之，那是他的选择。
     */
    const bodyless = !sdOn('cast') && !sdOn('tag');
    if (bodyless || !pieces.length) {
      warn(STAGE.CONSISTENCY, bodyless
        ? '段落编排把「角色段」和「动作段」都关掉了 —— 提示词里没有人物也没有动作，会出一张废图。已回退到出厂顺序（面板里至少要留一段）'
        : '段落编排把所有段都关掉了，提示词会变成空串 —— 已回退到出厂顺序（面板里至少留一段）');
      pieces.length = 0;
      sdTrace.length = 0;
      const h2 = [];
      if (c.globalPrefix?.trim()) h2.push(c.globalPrefix.trim());
      if (overviewTag) h2.push(overviewTag);
      if (sdTag) h2.push(sdTag);
      else if (!castSegs.length) h2.push(processed.tag);
      if (h2.length) pushSd('head', h2.join(', '));
      for (const s of castSegs) pushSd('cast', s);
      if (c.globalSuffix?.trim()) pushSd('suffix', c.globalSuffix.trim());
    }
  }

  const joined = pieces.filter(Boolean).join(sdSep);
  /**
   * ★ 保护角色段，避免最后整串 cleanTag 把它们去重拆散。
   *   总览人数词**不保护** —— 它要参与去重，把模型 tag 里重复的 `1girl` 吃掉。
   *   占位符用可读形式（不用 NUL，否则文件变二进制）。
   */
  let staged = joined;
  const gstash = [];
  for (const g of castSegs) {
    if (!g || g.includes('@')) continue;      // 含 @ 的段留给 FINAL_REF_RE 处理
    if (!staged.includes(g)) continue;
    staged = staged.split(g).join(`#HLG${gstash.length}#`);
    gstash.push(g);
  }
  let strippedRefs = 0;
  const noRef = String(staged).replace(FINAL_REF_RE, (m) => {
    strippedRefs += 1;
    warn(STAGE.CONSISTENCY, `最终提示词里仍有引用记号「${m}」未被展开，已剥除（K2 不认代号，只会当噪声）`);
    return '';
  });

  // 中文清洗兜底（正常应在 anchorOf / cleanTag 层就清掉）—— 口径跟随当前模版。
  const cleanedSd = cleanTag(noRef, { allowCjk: false });
  let finalTagSd = cleanedSd.tag;
  const cjk = cleanedSd.dropped;
  // 还原被保护的段（它们已在 cleanSeg 阶段单独清洗过，含中文的可能为 0）
  for (let i = 0; i < gstash.length; i += 1) {
    finalTagSd = finalTagSd.split(`#HLG${i}#`).join(gstash[i]);
  }
  let strippedCjk = 0;
  if (cjk.length) {
    strippedCjk = cjk.length;
    warn(STAGE.CONSISTENCY,
      `最终提示词里仍有 ${cjk.length} 项中文未在前序清理掉，已剥除（K2 只认英文 tag）：${cjk.slice(0, 2).join('、')}${cjk.length > 2 ? '…' : ''}`);
  }

  /**
   * v0.9.94 · 超长保险（用户 2026-10-18 拍板：**放宽**）——
   *   「有的人物外貌服装 TAG 需要很长」。所以这里不是硬削到 maxTagLength：
   *   ① 只在超出**提醒线的 2 倍**时才动手（420 → 840），正常长度一律不动；
   *   ② 只删**同形重复**（多人场景里两个角色都写了 blonde hair、锚点与模型段各写一次 overwhelmed
   *      这类），必要的服装 / 外貌项一个都不砍；
   *   ③ 削完仍超 → 停手并说明，绝不为了达标牺牲画面内容。
   */
  const maxLen = Number(c.consistency?.maxTagLength || 0);
  let sdFinal = finalTagSd;
  if (maxLen > 0 && sdFinal.length > maxLen * 2) {
    const before = sdFinal.length;
    const slim = dedupeAnchorSegments(sdFinal);
    if (slim.length < before) {
      sdFinal = slim;
      warn(STAGE.CONSISTENCY,
        `提示词 ${before} 字符超过提醒线 ${maxLen} 的 2 倍 —— 已删掉同形重复项，现 ${sdFinal.length} 字符（必要的服装 / 外貌项一律保留）`);
    }
    if (sdFinal.length > maxLen * 2) {
      warn(STAGE.CONSISTENCY,
        `提示词仍有 ${sdFinal.length} 字符：剩下的都是非重复项（人物外貌 / 服装本身就需要这么长），已保留不动 —— 想压缩请到档案页精简字段`);
    }
  }

  /**
   * v0.9.94 · tag 内下划线 → 空格（用户实测：long_hair 比 long hair 多耗 1~2 token）
   *
   * ★★ v0.9.107（用户 2026-10-19 报「每段提示词结尾没有标点符号」）：
   *   ① **清洗要跑两遍**。`normalizeTagSpaces` 把 `long_hair` 换成 `long hair` 时，
   *      下划线变成的空格会落回逗号前 —— `tousled_,  messy` 先被 tidySeparators 清成
   *      `tousled, messy`，normalize 之后再变回 `tousled , messy`（用户截图里就是这形态）。
   *      顺序是 tidy → normalize，所以 normalize 之后的脏东西没人接。
   *      现在改成 tidy → normalize → tidy。
   *   ② 段尾补逗号（`withSegmentTrailingCommas`）。必须放在**全部清洗之后**：
   *      tidySeparators 的 `,\s+ → ', '` 会把 `,\nBREAK\n` 压成 `, BREAK\n`，
   *      BREAK 一旦不独立成行，分段就失效了。
   */
  const sdTidied = tidySeparators(normalizeTagSpaces(tidySeparators(sdFinal)));

  /**
   * ★ v0.9.114 · 同类词超量削减（用户 2026-10-20：「同类型的词不需要叠加太多」
   *   「特别是同时出现容易混乱权重」）。
   *
   * 为什么放在这里（全部清洗之后、补段尾逗号之前）：
   *   ① 必须在 `tidySeparators` 之后 —— 它自己按逗号切 tag，脏逗号会让分组算错；
   *   ② 必须在 `withSegmentTrailingCommas` 之前 —— 那个是最后一道，加了逗号就不能再切 tag；
   *   ③ 放在最终整串上（不是分段拼装时）—— 这样动作段、每个角色段都被覆盖到。
   *
   * 只削**同语义组**（花妆 / 嘴型 / 眼睛 / 衣服滑落 / 长相气质），
   * 保留最像标准 tag 的那条（词数少、不含介词），见 `modules/tagClusterFix.js` 的分组依据。
   */
  const clustered = fixTagClusters(sdTidied, {
    /* ★ 用户手工拼的全局前后缀不参与同类词削减（v0.9.115） */
    protectTags: [c.globalPrefix, c.globalSuffix]
      .flatMap((x) => String(x || '').split(','))
      .map((x) => x.trim())
      .filter(Boolean),
  });
  if (clustered.changes.length) {
    warn(STAGE.CONSISTENCY,
      `同类词超量已削减 ${clustered.changes.length} 组（同一件事写多条＝权重打架）：`
      + clustered.changes.map((c) => `${c.label}留「${c.kept}」删「${c.dropped.join(' / ')}」`).join('；'));
  }

  const promptBase = normalizeBreakLines(clustered.text);
  const prompt = withSegmentTrailingCommas(promptBase, sdOpt);
  const negative = normalizeTagSpaces(c.globalNegative?.trim() || '');

  /**
   * ★ v0.9.112 · 画面结构体检（只报不改）。
   *
   * ★★ v0.9.115 修正：**只扫主体**，不再扫全局前缀。
   *   用户原话「multi view 不要管，我局外加的前缀不需要你管…你主要管主体的」。
   *   旧版特意把前缀算进来（为了报「多视图 × 单机位」），那条规则已删；
   *   现在用 `stripGlobalParts()` 剔掉前后缀，体检只评价动作段 / 角色段。
   *
   * 只报不改的理由：服装 / 人设 / 姿态都在用户主权区，改哪边由他决定。
   * 去重：按 code + 提示词指纹，同一份提示词只报一次（一次出 3~5 张，否则一楼刷 20 条）。
   */
  try {
    const bodyForAudit = stripGlobalParts(prompt, c.globalPrefix, c.globalSuffix);
    for (const it of auditSdComposeOnce(bodyForAudit)) {
      warn(STAGE.CONSISTENCY, `画面结构体检：${it.text}`);
    }
  } catch (err) {
    warn(STAGE.CONSISTENCY, `画面结构体检失败（不影响出图）：${err?.message || err}`);
  }

  return {
    prompt, negative, nl: processed.nl || '', strippedRefs, strippedCjk,
    structure: buildStructure('sd', sdCfg ? 'layout' : 'default', sdTrace, prompt),
  };
}

/** 给诊断面板用：总结一次一致性处理的结果。 */
export function summarize(processedList) {
  let healed = 0;
  let warned = 0;
  let unknown = 0;
  for (const p of processedList) {
    healed += p.healed.length;
    unknown += p.unknown.length;
    warned += p.notes.length;
  }
  info(STAGE.CONSISTENCY, `一致性处理完成：${processedList.length} 张图，自愈 ${healed} 处，提示 ${warned} 条，未知引用 ${unknown} 个`);
  return { count: processedList.length, healed, warned, unknown };
}
