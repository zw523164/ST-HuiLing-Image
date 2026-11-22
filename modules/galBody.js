/**
 * GAL(IGS) 正文结构解析—— **移植自 `igs.bundle.js`（IGS 0.37.52）的
 * `src/scene/image-marker-layout.js`**，逐行对照，不是重写。
 *
 * 为什么要把这段搬过来（v0.9.174）：
 *
 *   GAL 拿到 `anchorSentence` 后做两件事：
 *     ① `findAnchorInsertIndex(text, anchor)` 里先用 exact/normalized/lcs 找到位置 → `anchorIndex`
 *     ② 再用 `imageMarkerBoundary(text, anchorIndex)` 算「能不能安全插」→ `index`
 *
 *   ① 成功、② 失败时，GAL 报的是 **「生成点已命中正文，但没有安全的独占行插入位置」**，
 *   然后把这张图**直接丢掉**（不入 CG 库、不报错到界面）。
 *
 *   而 ② 失败只有两条路：
 *     · 位置落在某个 `end == null` 的结构内 —— 未闭合的 `[` / `【` / `［`、
 *       未闭合的 HTML 标签、未闭合的 thinking 块 / ``` 代码块 / `<!-- -->` 注释；
 *     · 推进后越过 `<content>` 容器的 closeStart。
 *
 *   ★ 实测（用户「催眠APP」卡，3990 字楼层）：正文 `<draft>` 里模型写了一句
 *     `鲜活度设计(对标<writing_covenant>)` —— 这个**孤立的尖括号词**被 GAL 当成开标签，
 *     因为后面没有 `</writing_covenant>`，它 `end:null` **一路罩到段末**，
 *     于是它之后的每一个位置都插不进图 ⇒ 整楼永远失败。
 *     同一批 3 个 AI 楼层，3 个全是 -1。
 *
 * 所以绘灵在**选锚点之前**必须先自己算一遍：算不过就不选，换了位置也过不了就如实报诊断。
 * 这一段属于「不让用户对着 GLA 那句含糊报错猜」的基础设施。
 */

/** 自闭合（void）标签 —— 被当标签时不入栈、不产生 end:null */
const VOID_TAGS = new Set([
  'area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

/** 方括号配对表（与 GAL 一致：只认这三种） */
const BRACKET_PAIR = { '[': ']', '【': '】', '［': '］' };

/**
 * 屏蔽区间：thinking 系标签、``` 代码块、`<!-- -->` 注释。
 * 这些区间里的字符**不参与**方括号/标签解析（所以里面的伪标签不会罩住正文）。
 * 未闭合时 `end: null`。
 */
function shieldRanges(text) {
  const out = [];
  const re = /<(thinking|think|subtext_think)\b[^>]*>[\s\S]*?<\/\1\s*>|```[\s\S]*?(?:```|$)|<!--[\s\S]*?(?:-->|$)/gi;
  for (const m of text.matchAll(re)) {
    const closed = m[1]
      || (m[0].startsWith('```')
        ? m[0].length >= 6 && m[0].endsWith('```')
        : m[0].endsWith('-->'));
    out.push({ start: m.index, end: closed ? m.index + m[0].length : null });
  }
  return out;
}

/**
 * `<content>` 容器区间（GAL 的 `imageMarkerContentRanges`）。
 * ★ 注意：GAL 这里**硬编码 content**，与设置里的「正文保留标签」无关。
 */
export function galContentRanges(bodyText) {
  const body = String(bodyText || '');
  const shielded = shieldRanges(body);
  const out = [];
  let open = null;
  let depth = 0;
  for (const m of body.matchAll(/<content(?=[\s/>])(?:"[^"]*"|'[^']*'|[^'">])*>|<\/content\s*>/gi)) {
    if (shielded.some((s) => s.start <= m.index && (s.end == null || m.index < s.end))) continue;
    if (m[0].startsWith('</')) {
      if (open && --depth === 0) {
        out.push({ ...open, closeStart: m.index, end: m.index + m[0].length });
        open = null;
      }
    } else if (!/\/\s*>$/.test(m[0])) {
      if (!open) open = { start: m.index, openEnd: m.index + m[0].length };
      depth += 1;
    }
  }
  /* 未闭合的 <content> ⇒ closeStart 取文末（GAL 原样） */
  if (open) out.push({ ...open, closeStart: body.length, end: body.length });
  return out;
}

/** 单段解析（GAL 的 `G`）：方括号配对 + HTML 标签配对，未闭合的一律 `end: null` */
function parseSegment(seg) {
  const out = [];
  const shielded = shieldRanges(seg);
  out.push(...shielded);
  const shieldedAt = (i) => shielded.some((s) => s.start <= i && (s.end == null || i < s.end));

  /* ① 方括号 */
  const stack = [];
  for (let i = 0; i < seg.length; i += 1) {
    if (shieldedAt(i)) continue;
    const ch = seg[i];
    if (BRACKET_PAIR[ch]) stack.push({ start: i, close: BRACKET_PAIR[ch], kind: 'bracket' });
    else if (stack.length && stack.at(-1).close === ch) out.push({ ...stack.pop(), end: i + 1 });
  }
  for (const s of stack) out.push({ ...s, end: null });

  /* ② HTML 标签 */
  const open = [];
  for (const m of seg.matchAll(/<\/?([\p{L}_][\p{L}\p{N}_.:-]*)(?=[\s/>])(?:"[^"]*"|'[^']*'|[^'">])*>/gu)) {
    if (shieldedAt(m.index)) continue;
    const name = m[1].toLowerCase();
    out.push({ start: m.index, end: m.index + m[0].length });
    if (m[0].startsWith('</')) {
      const i = open.findLastIndex((s) => s.name === name);
      if (i < 0) continue;
      /* 被跳过的开标签（比它晚开、比它早闭）⇒ 永久未闭合 */
      for (const s of open.slice(i + 1)) out.push({ ...s, end: null });
      out.push({ ...open[i], closeStart: m.index, end: m.index + m[0].length });
      open.length = i;
    } else if (!VOID_TAGS.has(name) && !/\/\s*>$/.test(m[0])) {
      open.push({ name, start: m.index, openEnd: m.index + m[0].length, container: name === 'content' });
    }
  }
  for (const s of open) out.push({ ...s, end: null });
  return out;
}

/**
 * 全文结构（GAL 的 `$`）。
 * ★ 有 `<content>` 时**分段**解析，每段带 `scopeEnd` —— 段外的结构不会再罩住段内的位置。
 *   这正是「把 `<now_plot>` 包进 `<content>`」能解决问题的原因。
 */
export function galStructure(bodyText) {
  const body = String(bodyText || '');
  const ranges = galContentRanges(body);
  if (!ranges.length) return parseSegment(body);

  const out = [];
  const push = (from, to) => {
    for (const s of parseSegment(body.slice(from, to))) {
      out.push({
        ...s,
        start: from + s.start,
        end: s.end == null ? null : from + s.end,
        ...(s.openEnd != null && { openEnd: from + s.openEnd }),
        ...(s.closeStart != null && { closeStart: from + s.closeStart }),
        scopeEnd: to,
      });
    }
  };
  let cursor = 0;
  for (const r of ranges) {
    if (r.start > cursor) push(cursor, r.start);
    push(r.start, r.end);
    cursor = r.end;
  }
  if (cursor < body.length) push(cursor, body.length);
  return out;
}

/**
 * 可插入位置（GAL 的 `imageMarkerBoundary`）。
 * @returns {number} 行首偏移；**-1 = GAL 会判「无法安全插入」并把这张图丢掉**
 */
export function galCanInsertAt(bodyText, pos) {
  return galInsertChecker(bodyText)(pos);
}

/**
 * 同上，但**结构只解析一次**。
 *
 * 选锚点时要从正文末尾一路往前试十几个候选，每个都重解析全文的话
 * 4000 字楼层会退化成 O(n²)（一次「绘制 CG」多花上百毫秒，还卡主线程）。
 */
export function galInsertChecker(bodyText) {
  const body = String(bodyText || '');
  const structs = galStructure(body);
  return function canInsertAt(pos) {
  const at = Math.max(0, Math.min(body.length, Number(pos) || 0));

  /* ① 落在 <content> 内部 ⇒ 先把上限收到 closeStart */
  let limit = body.length;
  for (const s of structs) {
    if (s.container && at >= s.openEnd && (s.end == null || at <= s.end)) {
      limit = Math.min(limit, s.closeStart ?? body.length);
    }
  }

  /* ② 落在某个结构内部 ⇒ 推到结构末尾；结构本身没闭合 ⇒ 直接判死 */
  let p = Math.min(at, limit);
  for (;;) {
    let l = p;
    for (const s of structs) {
      const inside = !(s.container
        || l <= s.start
        || (s.end != null && l >= s.end)
        || (s.scopeEnd != null && l >= s.scopeEnd));
      if (!inside) continue;
      if (s.end == null) return -1;
      l = Math.max(l, s.end);
    }
    if (l > limit) return -1;

    /* ③ 锚点后面还挂着文字 ⇒ 挪到下一行行首（「独占一行」的来源） */
    const lineStart = body.lastIndexOf('\n', l - 1) + 1;
    if (body.slice(lineStart, l).trim()) {
      const nl = body.indexOf('\n', l);
      let lineEnd = nl < 0 ? body.length : nl;
      if (lineEnd > l && body[lineEnd - 1] === '\r') lineEnd -= 1;
      l = Math.min(lineEnd, limit);
    }
    if (l === p) return l;
    p = l;
  }
  };
}

/**
 * 给剧情块套一层 `<content>`（**会改正文，只在用户点按钮时调**）。
 *
 * 为什么这能解决问题：`galStructure` 在有 `<content>` 时会**分段**解析，
 * 每段带 `scopeEnd`；段外的未闭合伪标签（模型写在 `<draft>` 里的
 * `(对标<writing_covenant>)` 这类）因此不再罩住段内的位置。
 *
 * ★ 只包 `<now_plot>` 的内层 —— 施工块（draft / summary / update）必须留在外面，
 *   否则它们里面的伪标签会跟着进 content，白包一场（实测：整楼包 = 仍然 -1）。
 *
 * @returns {{ok:boolean, reason?:string, text:string}}
 */
export function wrapStoryInContent(bodyText) {
  const body = String(bodyText || '');
  if (galContentRanges(body).length) return { ok: false, reason: 'already', text: body };

  const m = /<now_plot(?:\s[^>]*)?>([\s\S]*?)<\/now_plot>/i.exec(body);
  if (!m) return { ok: false, reason: 'no-block', text: body };

  const openTagEnd = m.index + m[0].indexOf('>') + 1;
  const closeStart = m.index + m[0].length - '</now_plot>'.length;
  const inner = body.slice(openTagEnd, closeStart);
  if (!inner.trim()) return { ok: false, reason: 'empty', text: body };

  const next = `${body.slice(0, openTagEnd)}\n<content>\n${inner.trim()}\n</content>\n${body.slice(closeStart)}`;

  /* ★ 包完必须复查：直接问「剧情区末尾能不能插」——
     那正是锚点会去的地方。段外的伪标签已经被 scopeEnd 挡掉，所以不能再拿
     `audit.blockers.length` 当判据（它会把段外那些列出来，但它们已经无害了）。 */
  const ranges = galContentRanges(next);
  const probe = ranges.length ? ranges[0].closeStart - 1 : -1;
  if (probe < 0 || galCanInsertAt(next, probe) < 0) {
    return { ok: false, reason: 'still-blocked', text: body, audit: galBodyAudit(next) };
  }
  return { ok: true, text: next };
}

/**
 * 正文结构体检 —— 给面板/日志用。
 * `blockers` 是「罩住整段、且永远不闭合」的结构，也就是让 GAL 判死的那批。
 * 报名字出来，用户才知道该改哪里（真因往往是一个模型随手写的 `<xxx>`）。
 */
export function galBodyAudit(bodyText) {
  const body = String(bodyText || '');
  const structs = galStructure(body);
  const ranges = galContentRanges(body);
  const first = ranges.length ? ranges[0] : null;
  const blockers = [];
  for (const s of structs) {
    if (s.end != null || s.container) continue;
    const isBracket = s.kind === 'bracket';
    /**
     * `neutralized`：结构在 `<content>` **外面**（前或后）⇒ 被 `scopeEnd` 挡住，
     * 对 content 内的锚点已经无害。面板据此只报「真正还会挡路的」那几条
     * （包过 `<content>` 之后，段外那些未闭合标签会继续留在结构表里，但已经不构成障碍）。
     */
    const neutralized = !!first && (s.start < first.start || s.start >= first.end);
    blockers.push({
      kind: isBracket ? '方括号' : '标签',
      name: isBracket ? String(body[s.start] || '[') : String(s.name || '?'),
      start: s.start,
      neutralized,
      /* 截图用：把起点前后 40 字带出来，一眼能认出是哪句 */
      snippet: body.slice(Math.max(0, s.start - 40), s.start + 40).replace(/\s+/g, ' ').trim(),
    });
  }
  const hasContent = ranges.length > 0;
  return {
    length: body.length,
    hasContent,
    blockers,
    /* 第一处障碍的位置；锚点必须落在它之前或者干脆没有障碍 */
    firstBlockAt: blockers.length ? Math.min(...blockers.map((b) => b.start)) : -1,
  };
}
