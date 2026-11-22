/**
 * SD 服装 tag 的确定性修复层（v0.9.109）
 *
 * ============ 用户病例（2026-10-20） ============
 * K2 自然语 `black over-knee socks` 转成 SD tag 后变成两条：
 *     over knee socks, black socks
 *   ① `over knee socks` 不是 danbooru tag（标准写法是 `thighhighs`），
 *      CLIP 会把它切成 over / knee / socks 三个 token，权重被打散；
 *   ② 两条同属腿袜，出图时 `dedupeOutfitSlots` 保留**最后一条** = `black socks`（短袜）。
 *   实测出图「一下过膝长袜、一下短袜」—— 因为有的分支走 dedupe（剩短袜）、
 *   有的分支不走（两条都进提示词，过膝偶尔抢到权重）。
 *
 * `navy pleated school skirt` → `short skirt, pleated skirt, navy skirt` 三条：
 *   同一件裙子被拆成 3 条 tag，权重三倍稀释 → 颜色被冲淡、混色。
 *   而 `OUTFIT_SLOT_BUCKETS` 只有袜/内裤/鞋三个桶，下装**没有桶**，拦不住。
 *
 * ============ 本模块只做确定性归一（不调 LLM） ============
 *   ① 腿袜：长度档位互斥 —— 腿上只有一双，多个档位必须只留一个；
 *           保留信息量最大的那条，**颜色从被删的那条继承** →
 *           `over knee socks` + `black socks` ⇒ `black thighhighs`
 *   ② 同品类：多条合并成「修饰… + 品类」一条短语 →
 *           `short skirt` + `pleated skirt` + `navy skirt` ⇒ `short navy pleated skirt`
 *   ③ 标准 tag 归一：`over-knee socks` / `thigh-high socks` ⇒ `thighhighs`
 *
 * 不做的事（有意为之）：
 *   - 不新增原文没有的款式与颜色（用户主权区，改设定要用户点头）
 *   - 不合并不同品类（`white blouse` + `collared shirt` 可能是两件，交给诊断提示）
 *   - 不碰已脱离身体的衣物（`pushed down around her knees` 是剧情要的半脱，原样保留）
 */

/* ============ 词表 ============ */

/**
 * 腿袜档位：数字越大 = 覆盖越高（信息量越大，冲突时胜出）。
 * canon 是 danbooru 标准写法 —— `over-knee socks` 那类自造写法统一收敛到这里。
 */
const LEGWEAR_TIERS = [
  { tier: 5, canon: 'pantyhose', re: /\b(?:pantyhose|tights)\b/i },
  {
    tier: 4,
    canon: 'thighhighs',
    re: /\bthighhighs?\b|\bthigh[- ]highs?\b|\bover[- ]?the[- ]knee\b[^,]{0,14}\b(?:socks?|stockings?)\b|\bover[- ]?knee\b[^,]{0,14}\b(?:socks?|stockings?)\b/i,
  },
  { tier: 3, canon: 'stockings', re: /\bstockings?\b/i },
  { tier: 2, canon: 'kneehighs', re: /\bkneehighs?\b|\bknee[- ]highs?\b|\bknee\s*socks?\b/i },
  { tier: 1, canon: 'socks', re: /\bsocks?\b/i },
];

/** 颜色词（用于合并 / 继承）。长的写法放前面，避免 `dark blue` 被 `blue` 先吃掉。 */
const COLORS = [
  'dark blue', 'light blue', 'deep red', 'dark red', 'wine red', 'hot pink',
  'black', 'white', 'navy', 'blue', 'red', 'pink', 'grey', 'gray', 'brown',
  'beige', 'cream', 'ivory', 'purple', 'violet', 'green', 'yellow', 'orange',
  'gold', 'golden', 'silver', 'maroon', 'burgundy', 'teal', 'cyan', 'khaki',
  'camel', 'crimson', 'scarlet', 'rose', 'mint', 'lavender',
];
const COLOR_RE = new RegExp(`\\b(?:${COLORS.map((c) => c.replace(/ /g, '\\s+')).join('|')})\\b`, 'i');

/**
 * 可合并的品类词（同一条里出现多次 = 同一件衣服被拆成多条）。
 * 只收**明确单件**的名词；`blouse` 与 `shirt` 不并（可能是衬衫+罩衫两件）。
 */
const MERGE_NOUNS = [
  'skirt', 'dress', 'shorts', 'pants', 'trousers', 'jeans',
  'ribbon', 'necktie', 'bow', 'choker',
  'blouse', 'shirt', 'sweater', 'hoodie', 'cardigan', 'jacket', 'coat', 'vest',
  'loafers', 'sneakers', 'sandals', 'boots', 'heels', 'pumps', 'shoes',
  'hat', 'beret', 'cap', 'headband', 'gloves', 'belt',
];
/*
 * ★ 只放**纯品类名词**，不要把 `pleated skirt` / `neck ribbon` 这类「款式+品类」
 *   塞进来 —— 那会让 `short skirt` 与 `pleated skirt` 落进两个不同的桶、永远合并不上。
 *   款式词（pleated / collared / school）必须留在 modifiers 里，合并时才带得过去。
 */

/** 修饰词（既不是颜色也不是品类）：长度 / 款式 / 材质。合并时保留，顺序靠前。 */
const LENGTH_WORDS = ['mini', 'micro', 'short', 'long', 'maxi', 'midi', 'knee', 'ankle', 'full', 'length'];
const LENGTH_SET = new Set(LENGTH_WORDS);

/** 已脱离身体 / 半脱挂着 —— 这类不参与合并与去重（剧情要的状态）。 */
const OFF_BODY_RE = /\b(?:torn|removed|hanging|pushed\s+(?:down|up|off)|pulled\s+(?:down|up|off)|bunched|around\s+(?:her|his|one)\s+(?:calves|calf|ankles?|thighs?|knees?|wrists?)|discarded|dropped|loosened|off\s+one\s+shoulder)\b/i;

/**
 * ★★★ v0.9.116 · **真的脱离身体**（不含裸 `torn`）。
 *
 * 用户 2026-10-21 真实串病例：段3 同时有 `black pantyhose` 与 `pantyhose crotch torn open`，
 * 两条并存 → 权重叠加 → 袜长/破洞每次随机（正是 v0.9.109 定的「一件衣物只许一条 tag」要治的病）。
 *
 * 根因是**同一件事被两条规则互相抵消**：
 *   - 上面 `OFF_BODY_RE` 只写裸 `torn` ⇒ `pantyhose crotch torn open` 被当成「已脱离」，
 *     在 fixLegwear 第一步就 `return` 掉；
 *   - 而 v0.9.113 的 `TEAR_RE` 本意是「合并时把 torn 带上」⇒ 永远轮不到执行。
 *   当时测试用例写的是 `ripped`（不在 `OFF_BODY_RE` 里）所以 43 项全绿 —— **只覆盖了同义词的一半**。
 *
 * 判据（三类要分开，别混成一个）：
 *   ① `pantyhose crotch torn open` —— **穿在身上破了**，仍覆盖腿部 → 该合并；
 *   ② `torn black stockings` + `white socks` —— 不同档位，可能是两件 → 不合并（v0.9.109 D2 约定）；
 *   ③ `pantyhose torn off` —— **撕下来脱了** → 永远不合并。
 *
 * ⇒ 所以不能靠「有没有 torn」一刀切，而要看**同品类是否出现 ≥2 次**（＝同一件被写了两遍）。
 */
const DETACHED_RE = /\b(?:torn\s+off|removed|hanging|pushed\s+(?:down|up|off)|pulled\s+(?:down|up|off)|bunched|around\s+(?:her|his|one)\s+(?:calves|calf|ankles?|thighs?|knees?|wrists?)|discarded|dropped|loosened|off\s+one\s+shoulder)\b/i;

/* ============ 工具 ============ */

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/** 按逗号切段（中英文逗号都认），返回去空后的数组。 */
function splitSegs(text) {
  return String(text || '')
    .split(/\s*[,，]\s*/)
    .map((s) => norm(s))
    .filter(Boolean);
}

/** 段里有没有颜色；有就返回标准写法（小写）。 */
function colorOf(seg) {
  const m = String(seg || '').match(COLOR_RE);
  return m ? norm(m[0]).toLowerCase() : '';
}

/** 去掉颜色词与品类词，剩下的就是修饰词（length/style/material）。 */
function modifiersOf(seg, noun) {
  let t = ` ${norm(seg)} `;
  t = t.replace(COLOR_RE, ' ');
  if (noun) t = t.replace(new RegExp(`\\b${noun.replace(/ /g, '\\s+')}\\b`, 'gi'), ' ');
  return norm(t)
    .split(/\s+/)
    .filter((w) => w && !/^(?:with|and|a|an|the|of)$/i.test(w));
}

/**
 * 找出段里的腿袜档位。返回最高档那一条（一段里同时写 `black thigh-high socks`
 * 时 `thigh-high` 与 `socks` 都会命中，取 tier 最大的那个）。
 */
function legwearOf(seg) {
  let hit = null;
  for (const d of LEGWEAR_TIERS) {
    if (d.re.test(seg) && (!hit || d.tier > hit.tier)) hit = d;
  }
  return hit;
}

/** 找出段里的品类词（最长匹配优先）。 */
function nounOf(seg) {
  const low = ` ${norm(seg).toLowerCase()} `;
  for (const n of MERGE_NOUNS) {
    if (low.includes(` ${n} `)) return n;
  }
  return '';
}

/* ============ ① 腿袜互斥 ============ */

/**
 * 腿袜归一：多条并存时只留信息量最大的一条，颜色从被删的那条继承。
 *
 * @param {string[]} segs 已切好的段
 * @returns {{ segs:string[], changes:string[] }}
 */
/**
 * 腿袜**必须保留**的修饰词白名单（v0.9.113）。
 *
 * ★ 为什么需要（用户 2026-10-20 报的病例：`black pantyhose` + `pantyhose ripped open at the crotch`）：
 *   旧实现合并时只拼 `颜色 + 品类` ⇒ `black pantyhose` + `pantyhose ripped open at the crotch`
 *   被合成 `black pantyhose`，**「撕开」这个状态直接消失** —— 画面从破洞变回完整，
 *   等于把用户的剧情改掉了。这比「两条 tag 并存」严重得多。
 *
 * ★ 为什么用白名单而不是全保留：`ripped open at the crotch` 这类是整句，
 *   拼进 tag 会变成非标准长句（danbooru 没有这个 tag），反而制造噪声。
 *   所以只留**danbooru 有对应 tag 的单词语义**，并把各种撕裂说法归一到 `torn`。
 */
const LEGWEAR_KEEP_MODS = new Set([
  'fishnet', 'lace', 'ribbed', 'patterned', 'glossy', 'sheer', 'opaque',
  'frilled', 'lace-trimmed', 'backseam', 'seamed',
]);

/** 撕裂类说法 → danbooru 标准 `torn`。宁缺不错：没命中就不加。 */
const TEAR_RE = /\b(?:torn|ripped|tear(?:ed)?|ladder(?:ed)?)\b/i;

function legwearModsOf(seg, canon) {
  const out = [];
  if (TEAR_RE.test(seg)) out.push('torn');
  for (const w of modifiersOf(seg, canon)) {
    const lw = w.toLowerCase();
    if (LEGWEAR_KEEP_MODS.has(lw) && !out.includes(lw)) out.push(lw);
  }
  return out;
}

function fixLegwear(segs) {
  /* ---------- ① 先收候选（不急着排除，因为要数「同品类出现几次」） ---------- */
  const cands = [];
  segs.forEach((seg, i) => {
    const lw = legwearOf(seg);
    if (lw) {
      cands.push({
        i, seg, tier: lw.tier, canon: lw.canon,
        offBody: OFF_BODY_RE.test(seg),
        detached: DETACHED_RE.test(seg),
      });
    }
  });

  /**
   * ★★★ v0.9.116 · 同品类出现 ≥2 次 = **同一件衣物被写了两遍**。
   *   `black pantyhose` + `pantyhose crotch torn open` 必须合并：
   *   破损状态不能成为「跳过合并」的理由，否则两条并存 → 权重叠加 → 视觉漂移。
   *   而 `torn black stockings` + `white socks` 是**不同品类/档位**，可能是两件真衣物
   *   → 保持 v0.9.109 的约定（含破损状态的不参与互斥），避免把白色短袜删掉。
   */
  const canonCount = new Map();
  for (const c of cands) canonCount.set(c.canon, (canonCount.get(c.canon) || 0) + 1);

  const hits = [];
  for (const c of cands) {
    if (c.detached) continue;                    // 真脱离了（torn off / around ankle …）→ 永远不合并
    if (c.offBody && (canonCount.get(c.canon) || 0) < 2) continue;  // 破损但只出现一次 → 按「两件」处理
    hits.push({ i: c.i, seg: c.seg, tier: c.tier, canon: c.canon });
  }
  if (hits.length <= 1) {
    // 只有一条，但写法可能是自造的（over-knee socks）→ 收敛成标准 tag
    if (hits.length === 1) {
      const h = hits[0];
      const color = colorOf(h.seg);
      const mods = legwearModsOf(h.seg, h.canon);
      const want = norm([color, ...mods, h.canon].join(' '));
      if (want && want !== norm(h.seg).toLowerCase()) {
        const kept = [...segs];
        kept[h.i] = want;
        return { segs: kept, changes: [`「${h.seg}」→「${want}」（danbooru 标准写法）`] };
      }
    }
    return { segs, changes: [] };
  }

  // 多条：先按档位（长 > 短），再按修饰词数量（信息量），最后按出现顺序（先写的赢）
  const ranked = [...hits].sort((a, b) => (
    b.tier - a.tier
    || modifiersOf(b.seg, b.canon).length - modifiersOf(a.seg, a.canon).length
    || a.i - b.i
  ));
  const win = ranked[0];
  const losers = ranked.slice(1);

  // 赢家没写颜色就从输家里借一个（`over knee socks` + `black socks` ⇒ black thighhighs）
  let color = colorOf(win.seg);
  if (!color) {
    for (const l of losers) { const c = colorOf(l.seg); if (c) { color = c; break; } }
  }
  /**
   * 状态 / 款式词也从**全体**里收集（不只是赢家）：
   * `black pantyhose` + `pantyhose ripped open at the crotch` ⇒ `black torn pantyhose`
   * —— 颜色来自第一条、`torn` 来自第二条，一条 tag 把两边的信息都保住。
   */
  const mods = [];
  for (const h of [win, ...losers]) {
    for (const m of legwearModsOf(h.seg, h.canon)) if (!mods.includes(m)) mods.push(m);
  }
  const want = norm([color, ...mods, win.canon].join(' '));

  const dropIdx = new Set(losers.map((l) => l.i));
  const out = [];
  segs.forEach((seg, i) => {
    if (i === win.i) { out.push(want); return; }
    if (dropIdx.has(i)) return;
    out.push(seg);
  });

  return {
    segs: out,
    changes: [`腿袜多条并存（${hits.map((h) => h.seg).join(' / ')}）→ 合并为「${want}」`],
  };
}

/* ============ ② 同品类合并 ============ */

/**
 * 同一品类被拆成多条 tag 时合并成一条短语。
 *
 *   `short skirt` + `pleated skirt` + `navy skirt` ⇒ `short navy pleated skirt`
 *
 * 顺序：长度 / 款式（原顺序）→ 颜色 → 品类。颜色放品类前是 danbooru 习惯写法
 * （`black thighhighs`、`navy skirt`），CLIP 对「颜色紧跟品类」的绑定最稳。
 *
 * ★ 只并**相同品类词**：`white blouse` + `collared shirt` 品类不同，可能是两件，
 *   合并会把两件写成一件（等于替用户改设定），留给诊断提示。
 */
export function mergeSameNoun(segs) {
  const byNoun = new Map();
  segs.forEach((seg, i) => {
    if (OFF_BODY_RE.test(seg)) return;
    if (legwearOf(seg)) return;                  // 腿袜走 ①，不在这里并
    const n = nounOf(seg);
    if (!n) return;
    if (!byNoun.has(n)) byNoun.set(n, []);
    byNoun.get(n).push({ i, seg });
  });

  const changes = [];
  const dropIdx = new Set();
  const replace = new Map();
  const spillAfter = new Map();   // 位置 → 需要额外补回的独立 tag（修饰词溢出）

  for (const [noun, list] of byNoun) {
    if (list.length < 2) continue;
    /**
     * ★★ 颜色冲突 → **不合并**（v0.9.111）。
     *
     * 一件衣服只有一个颜色。同品类写出两个不同颜色（`white skirt` + `navy skirt`）
     * 说明转换把两件东西搞混了，或者颜色本身就在漂 —— 这时合并会**武断地丢掉一个颜色**：
     * 实测 `white skirt, navy skirt` ⇒ `white skirt`（藏青那件凭空消失）。
     * 插件无权替用户判定哪个对，原样保留 + 体检提示，让人自己删。
     */
    const colors = new Set();
    for (const { seg } of list) {
      const c = colorOf(seg);
      if (c) colors.add(c);
    }
    if (colors.size > 1) continue;

    const mods = [];
    let color = '';
    for (const { seg } of list) {
      if (!color) color = colorOf(seg);
      for (const w of modifiersOf(seg, noun)) {
        if (!mods.some((m) => m.toLowerCase() === w.toLowerCase())) mods.push(w);
      }
    }
    /*
     * 按英文形容词顺序拼：长度 → 颜色 → 其他修饰 → 品类。
     * 实测踩坑：按「修饰 → 颜色 → 品类」拼，`red ribbon` + `neck ribbon` 会拼成
     * `neck red ribbon`（读起来是"脖子红丝带"，修饰被拆到颜色两边）；
     * 颜色紧跟品类前才是 danbooru 习惯（`black thighhighs` / `red neck ribbon`）。
     *
     * ★ 修饰词最多各留 1 个：`pleated skirt with suspenders` 的 suspenders 是配饰不是款式，
     *   硬塞进短语会变成 `navy pleated suspenders skirt`。溢出的拆回独立 tag。
     */
    const lens = mods.filter((w) => LENGTH_SET.has(w.toLowerCase()));
    const rest = mods.filter((w) => !LENGTH_SET.has(w.toLowerCase()));
    const want = norm([lens[0], color, rest[0], noun].filter(Boolean).join(' '));
    if (!want) continue;
    replace.set(list[0].i, want);
    const spill = [...lens.slice(1), ...rest.slice(1)];
    if (spill.length) spillAfter.set(list[0].i, spill.join(', '));
    list.slice(1).forEach(({ i }) => dropIdx.add(i));
    changes.push(`同一件「${noun}」写了 ${list.length} 条（${list.map((x) => x.seg).join(' / ')}）→ 合并为「${want}」`);
  }

  if (!changes.length) return { segs, changes };
  const out = [];
  segs.forEach((seg, i) => {
    if (dropIdx.has(i)) return;
    out.push(replace.has(i) ? replace.get(i) : seg);
    if (spillAfter.has(i)) out.push(spillAfter.get(i));
  });
  return { segs: out, changes };
}

/* ============ 对外入口 ============ */

/**
 * 修一串 SD 服装 tag（确定性，不联网）。
 *
 * ★ BREAK 必须逐段处理：`\nBREAK\n` 是 SD 的分段标记，不是 tag。
 *   如果在整串上按逗号切、再 `\s+ → 空格` 归一，BREAK 会被压成普通单词、
 *   换行也没了 → 分段失效 → 两个人的锚点挤进同一段权重（串台）。
 *   所以先按 BREAK 切成段，每段独立归一，再原样拼回去。
 *
 * @param {string} text 逗号分隔的 tag 串（可含 `\nBREAK\n` 分段）
 * @returns {{ text:string, changes:string[] }} changes 供 UI 告诉用户改了什么
 */
export function fixSdOutfit(text) {
  const raw = String(text || '');
  if (!raw.trim()) return { text: raw, changes: [] };

  const parts = raw.split(/\n\s*BREAK\s*\n/i);
  const changes = [];
  const out = parts.map((part) => {
    const segs = splitSegs(part);
    if (!segs.length) return part.trim();
    const a = fixLegwear(segs);
    changes.push(...a.changes);
    const b = mergeSameNoun(a.segs);
    changes.push(...b.changes);
    return b.segs.join(', ');
  });

  return { text: out.filter(Boolean).join('\nBREAK\n'), changes };
}

/**
 * 体检：找出这串 tag 里"会让画面漂移"的写法（只报告，不改）。
 *
 * @param {string} text SD tag 串
 * @param {string} [source] 对应的 K2 自然语原文（可选，给了才能查"凭空多出来的词"）
 * @returns {Array<{level:'warn'|'info', text:string}>}
 */
export function auditSdOutfit(text, source) {
  const segs = splitSegs(text);
  const items = [];
  if (!segs.length) return items;

  // ① 腿袜多条 = 视觉互斥（最致命，直接导致长短漂移）
  const leg = segs.filter((s) => !OFF_BODY_RE.test(s) && legwearOf(s));
  if (leg.length > 1) {
    items.push({
      level: 'warn',
      text: `腿袜写了 ${leg.length} 条（${leg.join(' / ')}）—— 腿上只有一双，出图会随机偏向其中一条。建议合成一条：${fixSdOutfit(leg.join(', ')).text}`,
    });
  }

  // ② 自造 tag：含 over-knee / thigh-high 等非标准写法的单独提醒
  for (const s of segs) {
    if (/\bover[- ]?knee\b|\bthigh[- ]high\b(?!s)/i.test(s) && !/\bthighhighs?\b/i.test(s)) {
      items.push({ level: 'info', text: `「${s}」不是 danbooru 标准 tag —— 标准写法是 thighhighs（过膝）/ kneehighs（及膝）` });
    }
  }

  // ③ 同品类多条
  const byNoun = new Map();
  for (const s of segs) {
    if (OFF_BODY_RE.test(s) || legwearOf(s)) continue;
    const n = nounOf(s);
    if (!n) continue;
    if (!byNoun.has(n)) byNoun.set(n, []);
    byNoun.get(n).push(s);
  }
  for (const [n, list] of byNoun) {
    if (list.length > 1) {
      /** 颜色冲突：一件衣服不可能两个颜色 —— 出图就是用户说的「忽深忽浅 / 混着其他颜色」。 */
      const cs = new Set();
      list.forEach((s) => { const c = colorOf(s); if (c) cs.add(c); });
      if (cs.size > 1) {
        items.push({
          level: 'warn',
          text: `同一件「${n}」写了 ${cs.size} 个不同颜色（${[...cs].join(' / ')}）—— 一件衣服只有一个颜色，出图会混色。建议只留正确的那个（插件不会替你选）`,
        });
      } else {
        items.push({ level: 'warn', text: `同一件「${n}」写了 ${list.length} 条（${list.join(' / ')}）—— 权重叠加会稀释颜色，建议合成一条` });
      }
    }
  }

  // ④ 与原文对照：SD 里出现了原文没有的颜色（颜色漂移的头号嫌疑）
  if (source) {
    const srcColors = new Set();
    (String(source).match(new RegExp(COLOR_RE.source, 'gi')) || []).forEach((c) => srcColors.add(norm(c).toLowerCase()));
    const sdColors = new Set();
    (segs.join(' ').match(new RegExp(COLOR_RE.source, 'gi')) || []).forEach((c) => sdColors.add(norm(c).toLowerCase()));
    /*
     * ★ 颜色比对要按「包含」而不是字面相等：原文 `deep red`、SD 写 `red` 是同一个颜色的简写，
     *   按字面比会同时报「多了 red」+「丢了 deep red」两条假警报（实测用例 1 踩到）。
     */
    const same = (a, b) => a === b || a.includes(b) || b.includes(a);
    const extra = [...sdColors].filter((c) => ![...srcColors].some((s) => same(s, c)));
    const missing = [...srcColors].filter((s) => ![...sdColors].some((c) => same(s, c)));
    if (extra.length) {
      items.push({ level: 'warn', text: `SD tag 里出现原文没有的颜色：${extra.join('、')} —— 会画成混色/串色` });
    }
    if (missing.length) {
      items.push({ level: 'info', text: `原文的颜色没落到 SD tag 上：${missing.join('、')} —— 出图会随机取色` });
    }
  }

  // ⑤ 近义上衣重复（blouse + shirt）：两条都进提示词 = 一件衣服两份权重
  if (segs.some((s) => !OFF_BODY_RE.test(s) && /\bblouse\b/i.test(s))
    && segs.some((s) => !OFF_BODY_RE.test(s) && /\bshirt\b/i.test(s))) {
    items.push({ level: 'info', text: 'blouse 与 shirt 同时出现 —— 若不是两件不同的衣服，建议只留一条（两条权重叠加容易画成双层衣领）' });
  }

  /**
   * ⑥ 款式对照：原文是**过膝袜**，SD 里只剩短袜写法。
   *
   * 这是用户 2026-10-20 报的正主：「应该是黑色过膝袜，结果变成了黑色袜子」。
   * 注意这里只**提示**、不自动改 —— 档案里真的写 `black socks`（短袜）是合法设定，
   * 插件无权替用户把服装改成过膝袜（设定是用户主权区）。
   * 只有「同一串里同时出现过膝和短袜」才走 ① 的确定性合并。
   *
   * ★ `thigh-high slit`（高开衩）不是袜子 —— 必须要求后面跟 socks/stockings，
   *   否则会把「高开衩裙」误判成过膝袜（本项目 2026-09 踩过同款坑）。
   */
  if (source) {
    const srcLong = /\b(?:over[\s-]?the[\s-]?knee|over[\s-]?knee|thigh[\s-]?highs?)\b[^,]{0,18}\b(?:socks?|stockings?)\b|\bthighhighs?\b/i.test(String(source));
    const sdLong = /\b(?:thighhighs?|thigh[\s-]highs?|kneehighs?|knee[\s-]highs?)\b/i.test(text);
    if (srcLong && !sdLong) {
      const c = (segs.join(' ').match(COLOR_RE) || [''])[0];
      items.push({
        level: 'warn',
        text: `原文是过膝袜（over-knee / thigh-high），SD tag 里只有短袜写法 —— 出图会是短袜。想保持过膝请写成「${c ? `${c.toLowerCase()} ` : ''}thighhighs」`,
      });
    }
  }

  return items;
}

/** 供测试与外部判断用。 */
export const __internals = { splitSegs, legwearOf, nounOf, colorOf, modifiersOf, COLOR_RE, OFF_BODY_RE, DETACHED_RE };
