/**
 * 绘灵 · 输出解析与校验
 *
 * 宽容解析（宽容解析的策略）：
 *   ① 剥掉  thinking 块
 *   ② 优先取 ```json 代码块
 *   ③ 退而求其次找第一个 { 到最后一个 }
 *   ④ 都不行 → 报诊断，说清"模型没按协议输出"
 *
 * 然后做本地校验：位置 ID 必须真实存在、tag 不能为空、数量不能超。
 * 校验失败不静默降级 —— 记诊断，让用户知道坏在哪。
 */

import { diagnose, warn, STAGE } from './log.js';
import { activeEngine, activeOutput } from './settings.js';
import { oneLine, storyRows } from './util.js';

/**
 * 从模型回复里挖出 JSON 文本。
 * v0.9.39 起对外导出：服装扫描这类辅助请求也要用它剥思维链 / Markdown 代码块。
 */
export function extractJsonText(raw) {
  const cleaned = String(raw || '')
    .replace(/<(think|thinking|reasoning)\b[\s\S]*?<\/\1>/gi, '')
    .trim();

  const candidates = [];
  for (const m of cleaned.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    candidates.push(m[1].trim());
  }
  candidates.push(cleaned);

  for (const c of candidates) {
    const start = c.indexOf('{');
    const end = c.lastIndexOf('}');
    if (start < 0 || end <= start) continue;
    try {
      const v = JSON.parse(c.slice(start, end + 1));
      if (v && typeof v === 'object' && !Array.isArray(v)) return { ok: true, value: v };
    } catch { /* 试下一个 */ }
  }
  return { ok: false, raw: cleaned };
}

/** 规范化 changes 数组。 */
function normalizeChanges(input) {
  if (!Array.isArray(input)) return [];
  return input
    .map(c => {
      if (!c || typeof c !== 'object') return null;
      const name = oneLine(c.name || c.char || c.character);
      if (!name) return null;
      const kindRaw = String(c.kind || c.type || 'set').toLowerCase();
      const kind = ['new', 'set', 'state'].includes(kindRaw) ? kindRaw : 'set';
      const fields = (c.fields && typeof c.fields === 'object' && !Array.isArray(c.fields))
        ? c.fields
        : {};
      return { name, kind, position: c.position ?? c.pos ?? null, fields, label: oneLine(c.label) };
    })
    .filter(Boolean);
}

/**
 * tag 串里出现中文时要用到的字符集：汉字、日文假名、CJK 标点、全角符号。
 * 分成两个正则：检测用不能带 g（否则 lastIndex 会让连续 test 结果失真）。
 */
const CJK_CLASS = '\\u3000-\\u303f\\u3040-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uf900-\\ufaff\\uff00-\\uffef';
const CJK_TEST = new RegExp(`[${CJK_CLASS}]`);
const CJK_STRIP = new RegExp(`[${CJK_CLASS}]+`, 'g');

/**
 * ★★★ 引号内中文保护（MOSS 台词通道 · v0.9.119）。
 *
 * 用户实测病例（2026-10-21，mesId 110 五张图）：模型**写了**气泡，
 * 但最终 prompt 里全是 `A white oval speech bubble beside her reads " "` ——
 * 引号里只剩一个空格。原因就在下面 `cleanTag` 的 CJK 剥离：
 *   · 规范（system / spec §3.3 / prompts 规则1）三处都放行了「台词用中文写进引号」
 *   · 而 `normalizeImages` 里 `allowCjk = activeEngine() === 'k2'` —— **MOSS 不在白名单**
 *   ⇒ `cleanTag` 把台词中文当乱码整段剥掉，剥完只剩 `reads " "`。
 * 这是本项目第 6 次「两条规则互相抵消」：我改了三处"允许"，唯独漏了真正执法的清洗层。
 *
 * 为什么不直接 `allowCjk = true`：MOSS 下让**所有**中文进 tag 会把模型的
 * 「处于初级催眠中，意识主导权丧失」这类状态词一起放进来 —— 那些确实该剥。
 * 所以只保**引号内**的：台词是唯一合法中文落点，其余照剥。
 *
 * 实现用占位符而不是「跳过剥除」：因为 `cleanTag` 先按 `,` 切项，
 * 台词里只要有一个半角逗号就会被切成两项，保护必须在切分**之前**完成。
 */
const QUOTED_CJK_RE = /(["“「『])([^"”」』]{1,400})(["”」』])/g;
const QUOTE_SLOT = '\u0003';

function guardQuotedCjk(src) {
  const slots = [];
  const text = String(src ?? '').replace(QUOTED_CJK_RE, (m, a, inner, b) => {
    if (!CJK_TEST.test(inner)) return m;      // 纯英文引号不必保护，还能正常去重
    slots.push(inner);
    return `${a}${QUOTE_SLOT}${slots.length - 1}${QUOTE_SLOT}${b}`;
  });
  return { text, slots };
}

function restoreQuotedCjk(s, slots) {
  if (!slots || !slots.length) return String(s ?? '');
  return String(s ?? '').replace(/\u0003(\d+)\u0003/g, (m, i) => slots[Number(i)] ?? '');
}

/**
 * tag 串硬清洗 —— 模板里「不许写中文」只是建议，模型未必照做，这里才是真正的兜底。
 *
 * 实测踩过：模型把状态位写成了「处于初级催眠中，意识主导权丧失，原地站立失神」并混进 tag，
 * 生图模型把中文当乱码处理，画面直接崩坏。所以要在这里拦住，而不是指望模型守规矩。
 *
 * 清洗规则：
 *   ① 按逗号切项，逐项剥离 CJK / 全角字符；
 *   ② 剥完只剩空白的（整句中文）→ 丢弃该项，并记录到 dropped 供诊断；
 *   ③ 剥完还有英文残片的（如 "1girl 的连衣裙" → "1girl"）→ 保留残片；
 *   ④ 顺手清掉因剥离产生的空括号 / 空方括号与多余符号、空格；
 *   ⑤ 完全相同的项去重（实测出现过 "empty eyes" 连写两次）。
 *
 * @param {string} raw 模型给出的 tag 串
 * @param {{allowCjk?:boolean, keepQuoted?:boolean}} [opts]
 *   `allowCjk=true` 时中文项**原样放行**（不剥不丢）。K2 中英混合模版专用。
 *   `keepQuoted=true` 时**只保住引号内的中文**（`reads "……别动。"`），引号外的照剥 ——
 *   MOSS 口径专用：台词是唯一合法中文落点，状态词仍然不许进画面词。
 * @returns {{tag:string, dropped:string[]}} 清洗后的 tag，以及被整项丢弃的中文片段
 */
export function cleanTag(raw, opts = {}) {
  // 夹层：引号内含中文时先换占位符 → 主体照旧剥 CJK → 末尾还原。
  // 不加这一层时，`reads "坂本先生，是我。"` 会被剥成 `reads " "`（实测五张图全中）。
  if (opts?.keepQuoted === true) {
    const g = guardQuotedCjk(raw);
    const r = cleanTagCore(g.text, opts);
    return { tag: restoreQuotedCjk(r.tag, g.slots), dropped: r.dropped };
  }
  return cleanTagCore(raw, opts);
}

function cleanTagCore(raw, opts = {}) {
  const allowCjk = opts?.allowCjk === true;
  const dropped = [];
  const parts = [];
  const seen = new Set();

  const src = stripMacros(String(raw ?? ''));

  /**
   * ★★★ v0.9.113 · BREAK 必须**先切段再清洗**（用户 2026-10-20 第 2 次报「BREAK 又被吞了」）。
   *
   * 病因（实测复现，不是推测）：
   *   下面这句 `split(',')` + `piece.trim()` 会把 BREAK **前面的换行**当空白吃掉 ——
   *   `'..., dark,\nBREAK\n1girl, ...'` 切成 `['..., dark', '\nBREAK\n1girl', ...]` 之后
   *   第二项 `trim()` ⇒ `'BREAK\n1girl'`（前导 `\n` 没了）⇒ `join(', ')`
   *   ⇒ 最终 `'..., dark, BREAK\n1girl, ...'`。
   *   于是下游 `split(/\n\s*BREAK\s*\n/)` 只能切出 **1 段** ⇒ 「每人一段」的防串台结构整体塌掉：
   *   ① 两个角色的锚点挤进同一段权重 → 女主段里长出别人的 `black hair`（串台）；
   *   ② `withSegmentTrailingCommas` 走 `parts.length <= 1` 分支 → 整串只补一个尾逗号，
   *      用户看到的就是「BREAK 被吞了 / 格式全乱」。
   *
   * 为什么上一版没修住：v0.9.110 在 `tidySeparators` 里加过 SOH 占位保护，
   *   但 `cleanTag` 跑在它**之前**（consistency.js:3670）—— BREAK 早就在这一步塌了，
   *   后面的保护根本轮不到。
   *
   * 修法：BREAK 是**段分隔符**，和 `fixSdOutfit` / `fixSdCompose` 一致 ——
   *   按 BREAK 切段、逐段独立清洗、再用规范形态 `\nBREAK\n` 拼回。
   *   宽切 `\s*\bBREAK\b\s*`：兼容已经塌成 `, BREAK` 的脏串，能自愈。
   */
  if (/\bBREAK\b/.test(src)) {
    const segs = src.split(/\s*\bBREAK\b\s*/);
    if (segs.length > 1) {
      const out = [];
      for (const seg of segs) {
        // 走 core 而不是 cleanTag：keepQuoted 的占位符已在最外层 guard 过，
        // 递归再 guard 一次会把占位符当普通文本、并把还原提前到分段内部。
        const r = cleanTagCore(seg, opts);
        if (r.dropped.length) dropped.push(...r.dropped);
        if (r.tag) out.push(r.tag);
      }
      return { tag: out.join('\nBREAK\n'), dropped };
    }
  }

  for (const piece of src.split(',')) {
    let item = piece.trim();
    if (!item) continue;

    // 光杆引用符号（模型写了 @ 却没写名字）—— 送进生图只是噪声，直接丢。
    if (/^[@＠.,;:_.\-—－\s]+$/.test(item)) { dropped.push(item); continue; }

    // @角色名 引用：整项原样放行，交给下游 consistency.expandRefs 展开成锚点。
    // 这里绝不能顺手剥中文 —— 一旦把名字剥掉，引用就废了，锚点也就没了。
    if (/[@＠]/.test(item)) { parts.push(item); continue; }

    if (CJK_TEST.test(item) && !allowCjk) {
      item = item
        .replace(CJK_STRIP, ' ')
        .replace(/\(\s*\)/g, '')   // 剥离后可能剩下空括号，一并清掉
        .replace(/\[\s*\]/g, '')
        .replace(/\s+/g, ' ')
        .replace(/^[\s\-_.,;:]+|[\s\-_.,;:]+$/g, '')  // 首尾残留的分隔符
        .trim();
      if (!item) { dropped.push(piece.trim()); continue; }
    }

    const key = item.toLowerCase();
    if (seen.has(key)) continue;   // 完全相同才去重，大小写不同视为两个意思
    seen.add(key);
    parts.push(item);
  }

  return { tag: parts.join(', '), dropped };
}

/**
 * 剥除酒馆宏标记（<user> / <bot> / <char> / <persona> 等）。
 *
 * 实测踩过（2026-09-27）：模型用 <user> 指代男角而不是写 @角色名 引用 ——
 * 宏不会被展开，原样送进 K2 就是噪声，还会把英文句撕得残缺（主语直接消失）；
 * 同时插件按 @引用 收集出场角色，宏指代会让人物段漏人。
 * 这里是硬兜底：tag / scene / mood / 最终提示词全部过一遍。
 */
const MACRO_RE = /<(?:user|bot|char|persona|assistant|system)>/gi;

export function stripMacros(text) {
  return String(text ?? '')
    .replace(MACRO_RE, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([，。；,.])/g, '$1')
    .trim();
}

/**
 * `stripMacros` 的**保行版**：只压空格 / 制表符，不动换行。
 *
 * ★ v0.9.117 为什么必须有：MOSS-Image 的多格漫画提示词靠**空行分段**
 *   （第一行版面声明 → 空行 → `Panel 1, …` → 空行 → `Panel 2, …`）。
 *   上面那句 `replace(/\s{2,}/g, ' ')` 连 `\n\n` 一起吞掉，实测把三格压成一行：
 *     `… clean line art. Panel 1, narrow strip at the top left: … Panel 2, …`
 *   —— 分格结构是这份提示词唯一的物理载体，压平就等于不分格。
 *
 * 只给「整段单串」这类靠换行表达结构的出口用；tag / scene 这些单行文本仍走 `stripMacros`。
 */
export function stripMacrosKeepLines(text) {
  return String(text ?? '')
    .replace(MACRO_RE, ' ')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')    // 行首尾空白清掉，换行本身保留
    .replace(/\n{3,}/g, '\n\n')          // 最多一个空行，避免模型写出一堆空行
    .replace(/[ \t]+([，。；,.])/g, '$1')
    .trim();
}

/** 规范化 images 数组。 */
/**
 * 规范化 cast：模型点名的出场名单。
 *
 * v0.9.25 起是「谁在画面里」的**权威来源**（实测模型在英文句里只写 her/his，
 * 插件没法从句子里猜出「her 指档案库里哪一位」→ 直接漏人）。
 *
 * 三种合法写法都收：
 *   ["小精灵-菲", "夜斗"]                                  —— 只点名
 *   [{"name":"小精灵-菲","en":"She hovers ..."}, {...}]     —— 点名 + 每人一句英文（按角色分块）
 *   [{"name":"巡查员","look":"A middle-aged man ..."}]      —— 点名 + 没档案时的外貌兜底（MOSS 口径）
 *   "小精灵-菲、夜斗"                                       —— 逗号/顿号串（容错）
 *
 * 每项输出 { name, en, look, offscreen }，en / look 允许为空。
 *
 * ★ v0.9.119 新增 `look`：正文里常有**档案库没有的人**（巡查员、店员、路人）。
 *   旧逻辑下这些人 `resolveCastName` 解析不出 → 丢进 castUnknown → **不给人物段** →
 *   MOSS 只能自由发挥，实测把他画成了「第二个穿同款校服的女生」（用户 2026-10-21 病例）。
 *   现在允许模型给一行英文外貌速写，插件直接拿它当人物段。
 */
function normalizeCast(input) {
  const items = Array.isArray(input)
    ? input
    : (typeof input === 'string' ? input.split(/[，,、/|]/) : []);
  const out = [];
  for (const it of items) {
    if (it == null) continue;
    if (typeof it === 'object') {
      const name = stripMacros(String(it.name ?? it.role ?? '').trim());
      if (!name) continue;
      const en = stripMacros(String(it.en ?? it.action ?? it.line ?? '').trim());
      // 没建档角色的英文外貌兜底（MOSS 口径）。只在这一项确实不存在档案时才会被用到。
      const look = stripMacros(String(it.look ?? it.appearance ?? '').trim());
      // offscreen = 在场但不入画（POV / 特写里只被提到的人）：
      //   true / "true" / 1 都认；插件据此跳过他的外貌与动作注入。
      const offRaw = it.offscreen ?? it.off_screen ?? it.hidden ?? it.behind_camera;
      const offscreen = offRaw === true || offRaw === 1
        || String(offRaw).toLowerCase() === 'true' || String(offRaw).toLowerCase() === 'yes';
      out.push({ name, en, look, offscreen });
      continue;
    }
    const name = stripMacros(String(it).trim());
    if (name) out.push({ name, en: '', look: '', offscreen: false });
  }
  return out;
}

function normalizeImages(input) {
  /**
   * 清洗口径跟随当前激活模版：
   *   · k2 —— 中英混合，中文自然语随锚点进画面词（nl 通道本就不清洗）
   *   · moss —— 整段自然语 + 中文台词。**不能整体放行中文**（状态词会污染画面），
   *     但**必须保住引号内的台词**，否则 `reads "坂本先生，是我。"` 被剥成 `reads " "`
   *     —— v0.9.118 五张图全是空气泡的根因就在这一行。
   *   · sd —— 一律剥除（原有防线不变）。
   */
  const engine = activeEngine();
  const allowCjk = engine === 'k2';
  const keepQuoted = engine === 'moss';
  /**
   * ★★★ v0.9.121：Layout 输出格式**整条跳过 cleanTag**。
   *
   * cleanTag 的职责是「把画面词洗干净」：剥中文、去括号、规整逗号。
   * 但 Layout 是一份 **JSON 文档** ——
   *   · 中文台词在 `"text": "这份名单……是你交上去的？"` 里，不是 `reads "…"` 那种引号包裹，
   *     keepQuoted 认不出来 → 台词被剥成空串（v0.9.118 五张空气泡就是同一类伤害）；
   *   · 逗号/引号/花括号都是**语法字符**，任何「去掉多余标点」都会把 JSON 拆坏。
   * ⇒ 走 layout 时原样保留对象，只做位置与 cast 的归一化。
   */
  const isJson = activeOutput() !== 'text';
  if (!Array.isArray(input)) return [];
  return input
    .map(i => {
      if (!i || typeof i !== 'object') return null;
      const position = String(i.position ?? i.pos ?? '').trim().toUpperCase();
      const castEarly = normalizeCast(i.cast ?? i.characters ?? i.who);
      if (isJson) {
        const lay = (i.layout && typeof i.layout === 'object' && !Array.isArray(i.layout))
          ? i.layout
          // 容错：模型把 layout 塞进 tag 字符串了
          : (() => {
            const raw = String(i.tag ?? i.prompt ?? '');
            const a = raw.indexOf('{'); const b = raw.lastIndexOf('}');
            if (a < 0 || b <= a) return null;
            try { return JSON.parse(raw.slice(a, b + 1)); } catch { return null; }
          })();
        if (!lay) return null;
        return { position, tag: '', nl: '', scene: '', mood: '', cast: castEarly, dropped: 0, layoutJson: lay };
      }
      // tag 必须先过中文清洗再入库 —— pipeline 会原样把它送去 ComfyUI
      const { tag, dropped } = cleanTag(i.tag ?? i.prompt ?? '', { allowCjk, keepQuoted });
      const nl = stripMacros(String(i.nl ?? '').trim());
      // K2 v4 三明治字段（2026-09-26）：scene=中文场景镜头段，mood=中文情绪收尾段。
      // 与 nl 一样是「中文专用通道」，不做 tag 清洗 —— 它们本来就该是中文。
      const scene = stripMacros(String(i.scene ?? '').trim());
      const mood = stripMacros(String(i.mood ?? '').trim());
      // v0.9.25：cast = 模型点名的出场名单（权威来源，见 normalizeCast 注释）
      const cast = castEarly;
      if (!tag) return null;
      return { position, tag, nl, scene, mood, cast, dropped };
    })
    .filter(Boolean);
}

/**
 * 解析主分析输出。
 * @returns {{ok:boolean, changes:Array, images:Array, warnings:string[], raw?:string}}
 */
export function parseAnalyzeOutput(raw) {
  const warnings = [];
  const got = extractJsonText(raw);
  if (!got.ok) {
    diagnose(STAGE.PROTOCOL, '模型输出不是合法 JSON，本次不生成图片', {
      cause: '模型没有按输出协议作答（可能被系统提示影响、或输出被截断）',
      fix: '检查「模版 → 输出协议」是否完整；若用的是小模型，换成指令遵循更好的模型；或把「单楼最大图片数」降到 1 再试',
    }, String(raw || '').slice(0, 800));
    return { ok: false, changes: [], images: [], warnings, raw };
  }

  const v = got.value;
  const changes = normalizeChanges(v.changes);
  const images = normalizeImages(v.images ?? v.images_in ?? v.result);

  if (!Array.isArray(v.changes) && !Array.isArray(v.images)) {
    warnings.push('输出里既没有 changes 也没有 images 数组，可能协议版本不匹配');
  }
  return { ok: true, changes, images, warnings, raw };
}

/**
 * 图位校验：位置必须真实存在于目标正文。
 *
 * @param {Array} images      解析后的图片数组
 * @param {string} body       目标正文（原始，未加位置 ID）
 * @param {string[]} validIds 合法位置 ID 列表（如 ['P1','P2',...]）
 * @param {number} maxCount   单楼最大图片数
 */
export function validateImages(images, validIds, maxCount) {
  const valid = [];
  const dropped = [];
  const seen = new Set();

  for (const img of images) {
    if (!img.position) {
      dropped.push({ img, reason: '缺少 position' });
      continue;
    }
    if (!validIds.includes(img.position)) {
      dropped.push({ img, reason: `位置 ${img.position} 不在本楼正文里（可能是模型编造的）` });
      continue;
    }
    if (seen.has(img.position)) {
      dropped.push({ img, reason: `位置 ${img.position} 重复` });
      continue;
    }
    seen.add(img.position);
    valid.push(img);
    if (valid.length >= maxCount) break;
  }

  if (images.length > valid.length + dropped.length) {
    // 理论上不会走到这
  }
  const overflow = images.length - valid.length - dropped.length;
  if (overflow > 0) {
    dropped.push({ img: null, reason: `${overflow} 张超出单楼上限 ${maxCount}，已截断` });
  }

  if (dropped.length) {
    for (const d of dropped) {
      warn(STAGE.PROTOCOL, `丢弃一张图：${d.reason}`);
    }
  }
  return { valid, dropped };
}

/** 从正文算出合法位置 ID 列表。 */
/**
 * 合法的位置 ID 列表（与 `renderIndexed` 的编号同源）。
 *
 * ★ v0.9.144：从"每个非空行一个 P"改成"每个**叙事行**一个 P"。
 *   真实第一楼 49 个非空行里 38 个是卡牌施工数据（写作计划 / charThink / 选项），
 *   模型看到的是 11 个编号；这里若还放行 49 个，模型写 P37 也能过校验，
 *   然后插图时定位到 `<action>` 那一段后面。
 */
export function validPositionsFrom(body) {
  const rows = storyRows(body);
  if (rows.length) return rows.map((_, k) => `P${k + 1}`);
  // 回退：叙事行为 0 —— 与 `indexParagraphs` / `positionToLineIndex` 的回退口径一致
  const lines = String(body || '').split('\n');
  const ids = [];
  let n = 0;
  for (const l of lines) {
    if (!l.trim()) continue;
    n += 1;
    ids.push(`P${n}`);
  }
  return ids;
}

/** 允许的位置 ID 最大值（用于位置门控换算）。 */
export function positionOrder(position, validIds) {
  const idx = validIds.indexOf(String(position || '').toUpperCase());
  return idx < 0 ? null : idx + 1;
}
