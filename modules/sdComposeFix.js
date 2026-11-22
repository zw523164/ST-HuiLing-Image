/**
 * SD 画面结构确定性归一 + 体检（v0.9.112）
 *
 * ★★★ 为什么需要（2026-10-20 真机事故 · 用户报「肢体扭曲」）：
 *   用户那份提示词的动作段长这样：
 *     `..., penetration, from behind, close up, profile, face, office, evening, dim lighting`
 *   三处结构性冲突，全部命中 `sdSpec.js` 里**早就写明的禁令**：
 *     ① §2.4「景别与机位各选一个」—— 这里景别 1 个（`close up`）、机位 **2 个**（`profile` + `from behind`）；
 *     ② §2.4「接触点在躯干以下时禁用 close up」—— `pussy` / `vaginal` / `penetration` 全在躯干以下；
 *     ③ §5.10「不写 penetration」—— 不在 danbooru 词典里，且与 `vaginal` 重复（行为堆叠，§5.3 要「选一个」）。
 *   后果不是「画得不美」，而是**模型硬把画面外的东西塞进头肩特写** → 肢体折叠 / 数量错乱。
 *   若再叠上 `multi view`（一张图多个视图），每个视图都要画一套完整身体而机位只给了一套
 *   → 模型只能自己瞎分 → 也可能肢体重复。
 *   ★ 但 `multi view` 若是**用户在全局前缀里手工加的风格开关**，插件不管（v0.9.115）：
 *     用户原话「局外加的前缀不需要你管，我不想用可以自己删，你主要管主体的」。
 *
 * ★★ 本模块只做**确定性**的事：合并互斥项、换禁词、报冲突。绝不判断「该不该拍这个画面」——
 *   那是模型和用户的事。凡「改了会篡改用户设定」的一律只报不改（服装 / 人设是用户主权区）。
 *
 * ★ 归一顺序约束：必须在 `dedupeOutfitSlots` / `fixSdOutfit` **之后**、拼 BREAK **之前**跑，
 *   因为它按 tag 边界工作（`from behind` 必须是完整一条 tag，不能被别的清洗拆开）。
 */

/** tag 归一化：小写、下划线/连字符 → 空格、压空白。只用于**比较**，不改原文。 */
const normKey = (t) => String(t || '')
  .toLowerCase()
  .replace(/[_\-]+/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

/** §2.4 景别（七选一）。`medium shot` / `full shot` 规范已注明「词典里没有」，但用户写了也要认出来。 */
export const SHOT_TAGS = new Set([
  'close up', 'upper body', 'cowboy shot', 'full body', 'wide shot', 'portrait', 'lower body',
  'medium shot', 'full shot',
]);

/** §2.4 机位（七选一）。`from front` 不在词表但语义上与 `from behind` 互斥，一并识别。 */
export const ANGLE_TAGS = new Set([
  'from side', 'from above', 'from below', 'from behind', 'profile', 'dutch angle', 'fisheye',
  'from front',
]);

/**
 * 「近景」——画幅只到胸以上。躯干以下的接触点写进去，模型只能硬塞。
 * `portrait` 视觉上等于头肩，与 `close up` 同档。
 */
const NEAR_SHOT = new Set(['close up', 'upper body', 'portrait', 'medium shot']);

/**
 * 躯干以下的接触 / 行为锚点（命中任一 → 近景禁用）。
 * ★ 用「整条 tag 相等」或「子串包含」两段判断：`cum in pussy` 这类复合 tag 用子串，
 *   `sex` 这种单字必须整条相等（否则 `sex from behind` / `after sex` 会被误判成「躯干以下」——
 *   其实它们也算，但误判方向是安全的那一侧，见下）。
 */
const LOWER_EXACT = new Set([
  'sex', 'vaginal', 'anal', 'oral', 'penetration', 'penis', 'pussy', 'crotch', 'thighs',
  'spread legs', 'legs up', 'legs apart', 'doggystyle', 'sex from behind', 'on stomach',
  'all fours', 'bent over', 'lower body', 'ass', 'anus', 'pubic hair', 'groin',
  'intercrural', 'fingering', 'masturbation', 'spread pussy', 'clitoris', 'erection',
  'ass up head down', 'mating press', 'fingering', 'clothed sex', 'sex from behind',
]);

const LOWER_SUB = [
  'pussy juice', 'cum in pussy', 'penetrat', 'vaginal', 'anal', 'thigh', 'spread leg',
  'doggystyle', 'on stomach', 'all fours', 'crotch', 'groin', 'penis', 'ass up',
];

/**
 * §5.3 主行为（选一个，不要堆叠）。
 * ★ 不含 `penetration` —— 它是禁词（§5.10），由 `banned-word` 单独报，算进这里会重复报两条。
 */
const ACT_TAGS = new Set([
  'sex', 'vaginal', 'anal', 'oral', 'fellatio', 'cunnilingus', 'deepthroat', 'paizuri',
  'handjob', 'footjob', 'intercrural', 'frottage', 'tribadism', '69', 'masturbation',
  'fingering', 'clothed sex', 'after sex',
]);

/** §2.2 承重面（缺一项必崩：悬空、断肢、多人叠成一团）。 */
const SUPPORT_TAGS = new Set([
  'standing', 'sitting', 'kneeling', 'lying', 'on back', 'on side', 'on stomach',
  'all fours', 'straddling', 'squatting', 'bent over', 'wariza', 'yokozuwari',
  'on bed', 'on floor', 'on chair', 'on couch', 'on desk', 'against wall', 'on lap',
  'standing on one leg', 'sitting on lap', 'crossed legs',
]);

/**
 * §2.2「必写一个」的两组**真互斥**子集（v0.9.112）。
 *
 * ★ 为什么要拆成两组：「姿态基底」和「朝向」是叠在一起表达的，
 *   `lying` + `on stomach` = 躺着 + 趴着（合法且常见）；`standing` + `lying` = 物理不可能。
 *   一把抓会误删 `on stomach` → 画面从"趴着"变成"躺着"，那是改画面不是修冲突。
 *   同理 `on desk` 是**支撑物**，与姿态不互斥（`lying` + `on desk` 完全合法），所以不在这两组里。
 */
const POSE_TAGS = new Set([
  'standing', 'sitting', 'kneeling', 'lying', 'squatting', 'all fours',
  'straddling', 'bent over', 'wariza', 'yokozuwari',
]);

const FACING_TAGS = new Set(['on back', 'on side', 'on stomach']);

/**
 * 体位词 → 它**已经包含**的姿态词（写了体位，这些就是重复 → 删）。
 *
 * ★★★ 依据（用户 2026-10-20 直接质疑，判断是对的）：
 *   「承重面在 SD 下的 TAG 效果有用吗？我感觉效果不大，远不如直接一个简单动作姿态 TAG 描述就行。」
 *
 *   danbooru 的体位 tag **自带姿态语义**：`doggystyle` 画出来就是趴跪；
 *   `missionary` 就是仰躺；`cowgirl position` 就是骑乘。再写 `all fours` / `on back`
 *   不是在"补充"，是在**给同一件事加第二份权重** —— 一致时浪费预算，不一致时（`doggystyle` + `standing`）
 *   模型只能各画一半：悬空 / 断肢 / 两具身体叠一起。
 *
 *   ⇒ 正确的分工是：**体位词管姿态，支撑物管位置**。姿态词只在没有体位词时才需要。
 *
 * ★ 只列**明确矛盾 / 明确重复**的。刻意不列的：
 *   · `sex from behind` —— 站着、跪着都成立，由正文决定，不能替模型选。
 *   · `cowgirl position` + `lying` —— 女方骑乘、男方躺着，`lying` 可能指男方，删了会出错。
 *   · `missionary` + `kneeling` —— 男方跪姿，有歧义。
 */
const POSITION_IMPLIES = new Map([
  ['doggystyle', ['standing', 'on back', 'on side', 'sitting', 'all fours']],
  ['missionary', ['standing', 'on stomach', 'all fours']],
  ['cowgirl position', ['standing', 'all fours', 'on stomach']],
  ['reverse cowgirl position', ['standing', 'all fours', 'on stomach']],
  ['standing sex', ['lying', 'sitting', 'on back', 'on stomach', 'all fours', 'on bed']],
  ['mating press', ['standing', 'sitting']],
  ['sitting on lap', ['standing', 'lying', 'all fours']],
  ['spitroast', ['standing', 'sitting']],
]);

/**
 * §4.2 生理状态（0~2 个）。超过 2 个＝同维度超量 → 表情 / 身体会互相打架。
 * ★ 只报不改：这组词没有明确互斥关系，削哪个都会改变画面表达（`sweat` 和 `blush` 都可能要）。
 */
const STATE_TAGS = new Set([
  'sweat', 'heavy breathing', 'sleepy', 'exhausted', 'awake', 'yawn',
  'pain', 'injured', 'wound', 'blood', 'bruise', 'cut', 'bandage', 'hospital',
  'fever', 'sick', 'sneeze', 'hungry', 'disheveled', 'wet clothes', 'trembling', 'blush',
]);

/** §2.3 手位（缺一项必崩：第三只手、多指）。 */
const HAND_TAGS = new Set([
  'hand on hip', 'arms at sides', 'crossed arms', 'arms behind back', 'hand in pocket',
  'hand on own face', 'covering face', 'holding', 'holding cup', 'holding phone',
  'holding book', 'holding bag', 'holding bottle', 'holding umbrella', 'holding flower',
  'holding food', 'holding tray', 'holding knife', 'arm up', 'finger in mouth',
  'breast grab', 'groping', 'hand on own chest', 'hand up', 'reaching', 'outstretched arm',
]);

/** §一「禁止自创词组 / 句子」—— 这些是真实病历里反复出现的，命中就报。 */
const SENTENCE_LIKE = [
  'partially slid down', 'sleeves slipping', 'flipped up over', 'brushing the cheek',
  'and refined', 'exposed through', 'own shirt', 'on her lower back', 'his ', 'her ',
];

const splitSegs = (text) => String(text || '').split(/\n\s*BREAK\s*\n/);
const joinSegs = (segs) => segs.join('\nBREAK\n');
const splitTags = (seg) => String(seg || '').split(',').map((t) => t.trim()).filter(Boolean);

const isLowerBody = (tag) => {
  const k = normKey(tag);
  if (LOWER_EXACT.has(k)) return true;
  return LOWER_SUB.some((s) => k === s || k.includes(s));
};

/**
 * 动作段确定性归一。
 *
 * 做四件事（全部有 `sdSpec.js` 条文依据，不掺主观判断）：
 *   1. 机位互斥 → 只留**最靠前**那一条（首因效应：越靠前权重越高，留它最符合用户本意）
 *   2. 景别互斥 → 只留最靠前那一条
 *   3. 躯干以下接触点 × 近景 → 景别换成 `cowboy shot`（§2.4「禁用」→ 换成能拍到腰胯的中景）
 *   4. `penetration` → 删（§5.10 禁词）；若删完一个行为词都不剩，改用 `vaginal`
 *
 * @param {string} text 动作段（已摘掉角色锚点）
 * @returns {{ text: string, changes: Array<{kind:string, from:string, to:string, note:string}> }}
 */
export function fixSdCompose(text) {
  const src = String(text || '');
  const changes = [];
  if (!src.trim()) return { text: src, changes };

  const segs = splitSegs(src);

  /* ---- 3 / 4 先做：它们影响「这条 tag 该不该留」，与互斥判断无关 ---- */
  // 4. 禁词 penetration
  const hasAct = () => {
    for (const s of segs) for (const t of splitTags(s)) if (ACT_TAGS.has(normKey(t))) return true;
    return false;
  };
  let droppedPen = 0;
  for (let i = 0; i < segs.length; i += 1) {
    const tags = splitTags(segs[i]);
    const kept = [];
    for (const t of tags) {
      if (normKey(t) === 'penetration') { droppedPen += 1; continue; }
      kept.push(t);
    }
    if (kept.length !== tags.length) segs[i] = kept.join(', ');
  }
  if (droppedPen) {
    // 手头一个行为词都没有 → 不能把「这件事」删没了（§5.11「不写＝这张图没有这件事」）
    if (!hasAct()) {
      segs[0] = `${segs[0] ? `${segs[0]}, ` : ''}vaginal`;
      changes.push({ kind: 'banned', from: 'penetration', to: 'vaginal', note: 'penetration 不在 danbooru 词典（§5.10），且原本没有别的行为词 → 换成 vaginal' });
    } else {
      changes.push({ kind: 'banned', from: 'penetration', to: '', note: 'penetration 不在 danbooru 词典（§5.10），且已有行为词 → 删除，避免行为堆叠' });
    }
  }

  /* ---- 0. 姿态减法：体位词已含姿态 / standing 是默认姿态 ---- */
  /**
   * ★ 这一刀是用户在 2026-10-20 直接提出的（「承重面效果不大，一个简单动作姿态 TAG 就行」）。
   *   两件事，都是**做减法**：
   *   ① 有体位词 → 删掉它已经包含的姿态词（`doggystyle` + `all fours` = 同义重复）
   *   ② `standing` 一律删 —— 模型默认就画站姿，写了不增加信息，还容易和体位/姿态词打架
   */
  const positionHit = (() => {
    for (const s of segs) {
      for (const t of splitTags(s)) {
        const k = normKey(t);
        if (POSITION_IMPLIES.has(k)) return { tag: t, key: k };
      }
    }
    return null;
  })();

  if (positionHit) {
    const banned = new Set(POSITION_IMPLIES.get(positionHit.key));
    for (let i = 0; i < segs.length; i += 1) {
      const tags = splitTags(segs[i]);
      const kept = [];
      for (const t of tags) {
        const k = normKey(t);
        if (k !== positionHit.key && banned.has(k)) {
          changes.push({
            kind: 'pose',
            from: t,
            to: '',
            note: `${positionHit.tag} 本身已经画的就是这个姿态（§2.2），再写 ${k} 是同一件事写两遍 → 删掉`,
          });
          continue;
        }
        kept.push(t);
      }
      if (kept.length !== tags.length) segs[i] = kept.join(', ');
    }
  }

  /**
   * standing：默认姿态 → 删。**但有例外**。
   *
   * ★ 为什么不能无条件删（J7 实测打回）：`sex from behind, standing` 里
   *   `standing` 是有信息的 —— 它区分「站立后入」与「跪姿后入」。删了就是改画面。
   *   而在 `standing, arms at sides, classroom` 里它是纯默认值（模型本来就会画站姿）。
   *
   * 规则：只有当 standing **不是**唯一姿态信息、**或者**根本没有需要它修饰的体位词时才删。
   */
  const allKeys = [];
  for (const s of segs) for (const t of splitTags(s)) allKeys.push(normKey(t));
  /** 不表达姿态的体位 / 行为词 —— 站着做、跪着做都成立，`standing` 写出来是有信息的。 */
  const SOFT_POSITION = new Set([
    'sex from behind', 'after sex', 'clothed sex', 'sex', 'vaginal', 'anal', 'oral',
    'paizuri', 'handjob', 'footjob', 'cunnilingus', 'fellatio', 'fingering', 'masturbation', '69',
    'frottage', 'intercrural', 'tribadism',
  ]);
  const softPos = allKeys.some((k) => SOFT_POSITION.has(k));
  const hasOtherPosture = allKeys.some((k) => k !== 'standing' && (POSE_TAGS.has(k) || FACING_TAGS.has(k)));
  const keepStanding = softPos && !hasOtherPosture;

  if (!keepStanding) {
    for (let i = 0; i < segs.length; i += 1) {
      const tags = splitTags(segs[i]);
      const kept = [];
      for (const t of tags) {
        if (normKey(t) === 'standing') {
          changes.push({ kind: 'pose', from: t, to: '', note: 'standing 是模型默认姿态，写了不说任何信息（§2.2）→ 删掉' });
          continue;
        }
        kept.push(t);
      }
      if (kept.length !== tags.length) segs[i] = kept.join(', ');
    }
  }

  /* ---- 1 / 2 景别与机位互斥 + 3 躯干以下 × 近景 ---- */
  const seenShot = [];
  const seenAngle = [];
  const seenFacing = [];
  const lower = (() => {
    for (const s of segs) for (const t of splitTags(s)) if (isLowerBody(t)) return true;
    return false;
  })();

  /**
   * ★★★ v0.9.113 · `lying` 是**上位泛化词**，有精确朝向词就必须删掉它。
   *
   * 依据（用户 2026-10-20 直接质疑：「提示词里有了一个躺卧 TAG 后，为啥还要加个俯卧 TAG？」）：
   *   danbooru 的 `lying` 定语就是「躺下」，**默认画出来是仰卧**；
   *   `on stomach` = 俯卧、`on back` = 仰卧、`on side` = 侧卧 —— 这三个是 `lying` 的**细分**。
   *   同时写 `lying` + `on stomach` 等于同时给「仰躺」和「俯卧」各一份权重：
   *   一致时浪费预算，不一致时模型只能在两者之间取一个扭曲的中间态
   *   ⇒ 身体朝向混乱、四肢朝向打架（用户报的肢体扭曲的典型成因）。
   *
   *   这和 v0.9.109 服装那次是**同一个病**：`socks` + `thighhighs`、`skirt` + `pleated skirt`
   *   都是「泛化词 + 精确词」并存 ⇒ 权重叠加 ⇒ 视觉漂移。
   *   ⇒ 统一口径：**精确词优先，泛化词让位**。
   *
   * 边界（不越界）：
   *   · 只有 `lying`、没有朝向词 → 它是唯一姿态信息，**保留**（`lying, on bed, looking up`）。
   *   · `on desk` / `on bed` 是**支撑物**不是朝向 → 不参与这个判断（`lying, on desk` 合法）。
   */
  const dropLying = allKeys.includes('lying') && allKeys.some((k) => FACING_TAGS.has(k));

  for (let i = 0; i < segs.length; i += 1) {
    const tags = splitTags(segs[i]);
    const kept = [];
    for (const t of tags) {
      const k = normKey(t);

      if (dropLying && k === 'lying') {
        changes.push({ kind: 'pose', from: t, to: '', note: 'lying 默认画成仰卧，与画面里的俯卧/侧卧/仰卧朝向词互相打架（一个意思写了两条）→ 保留精确的朝向词，删掉 lying' });
        continue;
      }

      /**
       * 朝向互斥（on back / on side / on stomach）—— 这三个是真互斥：
       * 人和不可能同时仰着、侧着、趴着。归一安全。
       * ★ 姿态基底（standing / sitting / lying…）**刻意不做自动归一**：
       *   `lying` + `on stomach` 是「躺着且趴着」，`straddling` + `sitting` 是「跨坐在腿上」——
       *   它们在 danbooru 语境里是叠加表达的合法搭配，删一个会改变画面（用户设定主权区）。
       *   所以姿态只在体检里提示，让用户自己决定。
       */
      if (FACING_TAGS.has(k)) {
        if (seenFacing.length) {
          changes.push({ kind: 'facing', from: t, to: '', note: `朝向只能是一个，已保留靠前的 ${seenFacing[0]}，删掉 ${k}（§2.2）—— 仰着和趴着同时写，模型只能左右各画一半` });
          continue;
        }
        seenFacing.push(k);
        kept.push(t);
        continue;
      }

      if (SHOT_TAGS.has(k)) {
        // 3. 近景 × 躯干以下 → 换成中景（改，不删：§6.2 景别是必写项）
        if (lower && NEAR_SHOT.has(k)) {
          if (!seenShot.length) seenShot.push('cowboy shot');
          kept.push('cowboy shot');
          changes.push({ kind: 'shot', from: t, to: 'cowboy shot', note: `接触点在躯干以下，${k} 画幅拍不到（§2.4 禁用）→ 换成能拍到腰胯的 cowboy shot` });
          continue;
        }
        // 2. 景别互斥
        if (seenShot.length) {
          changes.push({ kind: 'shot', from: t, to: '', note: `景别只能选一个（§2.4），已保留靠前的 ${seenShot[0]}，删掉 ${k}` });
          continue;
        }
        seenShot.push(k);
        kept.push(t);
        continue;
      }

      if (ANGLE_TAGS.has(k)) {
        // 1. 机位互斥
        if (seenAngle.length) {
          changes.push({ kind: 'angle', from: t, to: '', note: `机位只能选一个（§2.4），已保留靠前的 ${seenAngle[0]}，删掉 ${k}` });
          continue;
        }
        seenAngle.push(k);
        kept.push(t);
        continue;
      }

      kept.push(t);
    }
    segs[i] = kept.join(', ');
  }

  let out = joinSegs(segs);
  // 逐段清理空段留下的脏分隔（`a, , b` / 段首尾逗号），但不碰 BREAK
  out = out.split('\nBREAK\n').map((s) => s
    .replace(/,\s*,/g, ',')
    .replace(/^[\s,]+/, '')
    .replace(/[\s,]+$/, '')).join('\nBREAK\n');

  return { text: out, changes };
}

/**
 * 画面结构体检（只报不改）。
 *
 * 六类，全部对应 `sdSpec.js` 的条文，命中即用户能看懂的「为什么会崩」：
 *   A 景别/机位多条   B 躯干以下 × 近景
 *   D 行为堆叠 / 禁词  E 缺承重面 / 缺手位 / 缺视线
 *   F 句子式自创词组（§一 明令禁止，且会稀释真 tag 权重）
 *
 * ★ v0.9.115：**只评价主体**。全局前缀 / 后缀是用户手工拼的，不参与体检
 *   （调用方先用 `stripGlobalParts()` 剔掉，见 consistency.js）。
 *
 * @param {string} text 主体提示词（已剔除全局前缀 / 后缀）
 * @param {{hasCast?:boolean}} [opts] 有角色锚点时才有「每人一段」，可不传
 * @returns {Array<{level:'warn'|'hint', text:string, code:string}>}
 */
export function auditSdCompose(text, opts = {}) {
  const src = String(text || '');
  const items = [];
  if (!src.trim()) return items;

  const all = [];
  for (const s of splitSegs(src)) all.push(...splitTags(s));
  const keys = all.map(normKey);

  /* A 景别 / 机位多条 */
  const shots = keys.filter((k) => SHOT_TAGS.has(k));
  const angles = keys.filter((k) => ANGLE_TAGS.has(k));
  if (shots.length > 1) {
    items.push({ level: 'warn', code: 'shot-multi', text: `景别写了 ${shots.length} 个（${shots.join(' / ')}）—— 规范要求只选一个（§2.4）。多个景别模型会各自满足一部分，构图直接散架` });
  }
  if (angles.length > 1) {
    items.push({ level: 'warn', code: 'angle-multi', text: `机位写了 ${angles.length} 个（${angles.join(' / ')}）—— 规范要求只选一个（§2.4）。机位互斥时模型只能取平均，人物朝向会扭（肢体扭曲的常见成因）` });
  }

  /* B 躯干以下 × 近景 */
  const lower = all.find((t) => isLowerBody(t));
  const nearShot = shots.find((k) => NEAR_SHOT.has(k));
  if (lower && nearShot) {
    items.push({ level: 'warn', code: 'near-lower', text: `景别是 ${nearShot}，但画面里出现 ${lower}（躯干以下的动作 / 接触）—— §2.4 明确「接触点在躯干以下时禁用 close up / upper body」：画幅拍不到的地方，模型会硬塞进来，这就是肢体折叠 / 多肢的原因` });
  }

  /**
   * ★★★ v0.9.115 · 这里**刻意没有**「多视图 × 单机位」的体检 —— 已删除。
   *
   * 用户 2026-10-20 明确拍板：
   *   「multi view 不要管，我局外加的前缀不需要你管，我不想用可以自己删，
   *     你主要管主体的。像这种我自己手动拼的前后缀和全局你不需要管他。」
   *
   * ⇒ 全局前缀 / 后缀是**用户手工拼的风格开关**，不是插件该评价的对象。
   *   插件对他的前后缀说"这样会崩"＝越界（而且他也知道怎么删）。
   * ⇒ 体检只评价**主体**（动作段 / 角色段），见 consistency.js 里传入的
   *   `stripGlobalParts()` 结果。
   * ⇒ 原来那条规则的另一半理由（"每个视图要画一套完整身体"）仍然成立，
   *   但那是**用户选择宫格时自担**的事，不是插件该拦的。
   */

  /* D 行为堆叠 / 禁词 */
  const acts = keys.filter((k) => ACT_TAGS.has(k));
  const uniqActs = [...new Set(acts)];
  if (uniqActs.length > 1) {
    const pair = uniqActs.filter((k) => k !== 'sex');
    if (pair.length > 1) {
      items.push({ level: 'warn', code: 'act-stack', text: `主行为写了 ${pair.length} 个（${pair.join(' / ')}）—— §5.3 要求「选一个主行为，不要堆叠」。堆叠时模型把两件事画在同一具身体上，结构必崩` });
    }
  }
  if (keys.includes('penetration')) {
    items.push({ level: 'warn', code: 'banned-word', text: 'penetration 不在 danbooru 词典（§5.10）—— 写了是噪声，还会稀释真 tag 权重；行为请用 vaginal / anal / sex' });
  }

  /* D2 姿态 / 朝向多条 */
  const poses = [...new Set(keys.filter((k) => POSE_TAGS.has(k)))];
  const facings = [...new Set(keys.filter((k) => FACING_TAGS.has(k)))];
  if (poses.length > 1) {
    /* ★ hint 而不是 warn：`sitting` + `straddling` 这类是合法叠加（跨坐在腿上），
       只有出现明显互斥的组合（站 + 躺）才真会崩。这里不替用户判断，只提醒。
       ★ v0.9.113：`lying` + 朝向词**不再算合法**（那是上位词 + 细分词，已由 fixSdCompose 自动删 lying）。 */
    items.push({ level: 'hint', code: 'pose-multi', text: `姿态相关的词有 ${poses.length} 个（${poses.join(' / ')}）—— §2.2 说「一个就够」。\`sitting\` + \`straddling\` 这类是合法叠加，但「站着 + 躺着」并存时模型会画成两具身体。看一眼有没有真冲突` });
  }

  /**
   * ★★★ v0.9.115 · 这里**刻意没有**「俯卧 × spread legs」的体检 —— 已删除（原 code: prone-spread）。
   *
   * v0.9.113 我曾写 warn 说「`spread legs` 在 danbooru 里是**仰卧**张开，趴着时腿是支撑或并拢的」。
   * **这句话是我编的**。查 danbooru wiki 原文（id 4837）：
   *   "When a person has their legs spread wide apart. **Usually this is while lying down,
   *    sitting, or during sex.** When a person is standing `legs apart` should be used instead…"
   *   ⇒ 原文只说 lying down / sitting / during sex，**从没限定仰卧**，lying down 本身包含俯卧。
   * 而 `on stomach`（id 8341）原文是 "Lying flat on one's stomach… The upper torso is often
   *   lifted up with arm support" —— 躯干可以撑起，腿当然可以张开。
   *
   * ⇒ 两个 tag 是**不同维度**（躯干朝向 / 腿部开合），`on stomach, spread legs, on desk`
   *   是**合法构图**。用户 2026-10-20 追问「他们是一个意思吗」时才发现是误报。
   * ⇒ 保留这条 warn = 每次出图都误导用户去删自己要的画面；改成「自动削」更糟 = 直接改用户画面。
   *   所以整条删除，而不是降级成 hint。
   *
   * 真正该管的只有一件事：`lying` 与朝向词重复（on_stomach 已含 lying 语义）→ 见 dropLying。
   */
  if (facings.length > 1) {
    items.push({ level: 'warn', code: 'facing-multi', text: `朝向写了 ${facings.length} 个（${facings.join(' / ')}）—— 趴着和仰着不能同时成立，模型只能左右各画一半（肢体错位的直接成因）` });
  }

  /* D4 同维度超量（§4.2 生理状态 0~2）—— 只报不改：削哪个都会改画面表达 */
  const states = [...new Set(keys.filter((k) => STATE_TAGS.has(k)))];
  if (states.length > 2) {
    items.push({ level: 'hint', code: 'state-over', text: `生理 / 表情状态写了 ${states.length} 个（${states.join(' / ')}）—— §4.2 每维度只允许 0~2 个。同维度超量不是"更到位"，是让模型在每个词之间反复横跳，表情和身体会互相打架` });
  }

  /* E 缺承重面 / 手位 / 视线 */
  const hasSupport = keys.some((k) => SUPPORT_TAGS.has(k));
  const hasHand = keys.some((k) => HAND_TAGS.has(k));
  const hasGaze = keys.some((k) => /^looking |^closed eyes$|^half closed eyes$|^eye contact$|^jitome$/.test(k));
  if (!hasSupport) {
    items.push({ level: 'warn', code: 'no-support', text: '没有承重面（standing / sitting / lying / on back / on stomach / on desk …）—— §2.2：没有承重面的身体一定画崩（悬空、断肢、多人叠成一团）' });
  }
  if (!hasHand) {
    items.push({ level: 'hint', code: 'no-hand', text: '没有手位（hand on hip / arms at sides / crossed arms / holding …）—— §2.3：只写姿态不写手位，一定长出第三只手或多指' });
  }
  if (!hasGaze) {
    items.push({ level: 'hint', code: 'no-gaze', text: '没有视线（looking at viewer / looking down / closed eyes …）—— §2.5 要求每张都写，不写模型自己乱给眼神方向' });
  }

  /* F 句子式自创词组 */
  const bad = [];
  for (const t of all) {
    const k = String(t).toLowerCase();
    const hit = SENTENCE_LIKE.find((w) => k.includes(w));
    if (hit) bad.push(t);
  }
  if (bad.length) {
    items.push({ level: 'hint', code: 'sentence-like', text: `有 ${bad.length} 条不是 danbooru tag（像句子或自创词组，§一 禁止）：${bad.slice(0, 3).map((x) => `「${x}」`).join('、')}${bad.length > 3 ? '…' : ''} —— 词典搜不到的词等于噪声，会稀释真 tag 的权重` });
  }

  return items;
}

export const __internals = { normKey, isLowerBody, splitTags, splitSegs, NEAR_SHOT };

/* ------------------------------------------------------------------ *
 * 去重包装
 *
 * ★ 为什么必须去重：一次出图是 3~5 张，`consistency.js` 对每张都调一次体检。
 *   不去重 = 用户在一楼里看到 20 条一模一样的告警 → 直接失去可信度（「又刷屏了」）。
 *   但也不能"整个会话只报一次"：用户按提示改了前缀之后，同类问题必须能再报出来。
 *   ⇒ 按 **code + 提示词内容指纹** 去重：同一份提示词只报一次，内容一变就重新报。
 * ------------------------------------------------------------------ */
const memoSig = new Set();

/** djb2 —— 只需要稳定，不需要抗碰撞。 */
function fingerprint(s) {
  let h = 5381;
  const str = String(s || '');
  for (let i = 0; i < str.length; i += 1) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
  return h.toString(36);
}

/** 测试用：清空去重记忆。 */
export function resetComposeAuditMemo() { memoSig.clear(); }

/**
 * 体检 + 去重。生产路径用这个（`auditSdCompose` 保持纯净，测试直接用它）。
 * @param {string} text
 * @returns {Array<{level:'warn'|'hint', text:string, code:string}>}
 */
export function auditSdComposeOnce(text) {
  const fp = fingerprint(text);
  const fresh = [];
  for (const it of auditSdCompose(text)) {
    const sig = `${it.code}@${fp}`;
    if (memoSig.has(sig)) continue;
    memoSig.add(sig);
    fresh.push(it);
  }
  return fresh;
}
