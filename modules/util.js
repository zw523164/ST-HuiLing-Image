/**
 * 绘灵 · 通用工具
 *
 * 隐形锚点这件事在这里踩过坑（见 sd-helper-comfyui-workflow 技能）：
 * 镜译那类插件的「显示边界清理」正则会吃掉生图锚点，因为它们共用同一批
 * 不可见字符。绘灵因此**不用纯隐形字符做锚点**，改用可见的成对标签
 * <hl_image>…</hl_image>，整块删除由 ST 托管正则负责，不与隐形字符生态冲突。
 */

/* ============ 文本清洗 ============ */

/**
 * 绘灵自己的 tag 块；跨行、非贪婪。
 * v0.7 起块上带 pos 属性（<hl_image pos="P3">），正则必须兼容两种形态 ——
 * 老聊天的无属性块还要能被清洗和解析，否则升级后旧图全消失。
 *
 * v0.9.24：标签名额外接受**连字符**写法 <hl-image>。
 * 为什么必须放宽 —— 主模型是照着协议"模仿"写块的，实测它会把下划线记成连字符
 * （HTML 自定义元素里连字符才是合法名，模型的语料偏好压过了协议示例）。
 * 结果正文里躺着 <hl-image>…</hl-image>，而旧正则只认 hl_image，于是：
 *   ① 显示侧替换不掉 → 伪块原样糊在聊天里；
 *   ② 提示词侧删不掉 → 整块被喂回主模型；
 *   ③ parseTags 解析不到 → 楼层记录配不上对 → 历史楼层的图刷出来是空的 / 要等很久。
 * 这里统一放宽为 hl[_-]image，开闭标签各自独立放宽（混写概率极低，不值得为此上反向引用）。
 */
export const HL_TAG_RE = /<hl[_-]image[^>]*>[\s\S]*?<\/hl[_-]image\s*>/gi;

/** 给 ST 托管正则用的字符串形式（与 HL_TAG_RE 同源，改一处即可）。 */
export const HL_TAG_REGEX_SRC = '/<hl[_-]image[^>]*>[\\s\\S]*?<\\/hl[_-]image\\s*>/gi';

/** 别人家的 tag 块，清洗正文时一并剔除（避免互相喂进模型）。 */
const FOREIGN_TAG_RES = [
  /\[IMG_GEN\][\s\S]*?\[\/IMG_GEN\]/gi,
  /<bbi_image>[\s\S]*?<\/bbi_image>/gi,
  /\[image:[\s\S]*?\]/gi,
  // 主 AI 自己写的插图描述（[img:…]）。它是"画面指令"不是剧情，
  // 留在正文里会被当成一段剧情去配图 —— 实测踩过：占了 P40 一个位置。
  /\[img:[^\]]*\]/gi,
];

/**
 * 结构化输出块：现在很多卡的主 AI 会按模板吐
 *   [metacognition] / <thinking> 推理草稿
 *   <content> 真正文
 *   <recap><details> 小总结
 *   <choice> 选项（常带"色色剧情推进"这类字眼，喂进去会直接污染配图）
 *   <update><update_analysis><json_patch> 状态变量
 * 这些都不是剧情，必须在喂给分析模型前剔掉。
 */
const STRUCT_BLOCK_RES = [
  /<recap>[\s\S]*?<\/recap>/gi,
  /<recap>[\s\S]*$/gi,                       // 没闭合的兜底
  /<choice>[\s\S]*?<\/choice>/gi,
  /<choice>[\s\S]*$/gi,
  /<update_analysis>[\s\S]*?<\/update_analysis>/gi,
  /<update[\s_][\s\S]*?<\/update>/gi,        // 含 <update_analysis>…</update> 整体
  /<update>[\s\S]*?<\/update>/gi,
  /<update>[\s\S]*$/gi,
  /<json_patch>[\s\S]*?<\/json_patch>/gi,
  /<json_patch>[\s\S]*$/gi,
  // v0.9.35：MVU（酒馆助手变量框架）的变量块 —— <UpdateVariable>…JSON/命令…</UpdateVariable>。
  // 实测「雾津市播种计划」这类带变量框架的卡，#0 楼的变量初始化块能有几万字：
  // ① 每次渲染/指纹复核都对它跑全文本正则（二次方级扫描），是页面卡死的主力；
  // ② 它会原样喂进分析模型 —— 白烧几千 token 还可能污染配图判断。
  /<updatevariable>[\s\S]*?<\/updatevariable>/gi,
  /<updatevariable>[\s\S]*$/gi,              // 没闭合的兜底
  /<details>[\s\S]*?<\/details>/gi,
  /<summary>[\s\S]*?<\/summary>/gi,
];

/** 常见状态栏/系统块，喂给分析模型前剔掉，省 token 也避免误判。 */
const NOISE_RES = [
  /<StatusPlaceHolderImpl\s*\/>/gi,
  /<status[\s\S]*?<\/status>/gi,
  /【系统[\s\S]*?】/g,
  /\[系统[\s\S]*?\]/g,
  // v0.9.35：MVU 裸变量宏行（_.set('xx', 1); / _.insert(...) 等独占一行时）。
  // 用 [^\n]* 整行吃掉而不是 [^)]* —— 防嵌套括号截断后残一半。
  /^[ \t]*_\.\w+\([^\n]*$/gm,
];

/** 去掉模型思考块。 */
const THINK_RE = /<(think|thinking|reasoning)\b[\s\S]*?<\/\1>/gi;

/**
 * 元认知块：以 [metacognition] 起头，到 </thinking>/</think> 或下一个块标签为止。
 * 为什么单独一条：很多卡只给闭合标签不给了开标签（`<thinking>` 缺失），
 * 上面的 THINK_RE 就整块漏掉 —— 实测漏掉了整整 1000 字的 AI 推理草稿。
 */
const META_RE = /\[metacognition\][\s\S]*?(?:<\/(?:think|thinking|reasoning)>|(?=\n\s*<content>)|(?=\n\s*```))/gi;

/** 孤立标签（开/闭不成对残留）。 */
const LONE_TAG_RES = [
  /<\/?(content|recap|choice|update|update_analysis|json_patch|details|summary|metacognition)\s*>/gi,
  /<\/(think|thinking|reasoning)\s*>/gi,
  /\[\s*metacognition\s*\]/gi,
];

/**
 * 真正文容器：<content>…</content>。
 * 命中就只取内部 —— 这是最干净的路径，比"删掉一堆噪声"可靠得多。
 */
const CONTENT_RE = /<content>([\s\S]*?)<\/content>/i;

/** 正文清洗：给分析模型看的干净剧情文本。 */
export function cleanBody(text, opts = {}) {
  if (!text) return '';
  let out = String(text);

  // ① 优先走"真正文容器"：有 <content> 就只认里面的东西
  if (opts.extractContent !== false) {
    const m = out.match(CONTENT_RE);
    if (m && m[1] && m[1].trim()) out = m[1];
  }

  out = out.replace(THINK_RE, '');
  out = out.replace(META_RE, '');
  out = out.replace(HL_TAG_RE, '');
  for (const re of FOREIGN_TAG_RES) out = out.replace(re, '');
  if (opts.keepNoise !== true) {
    for (const re of STRUCT_BLOCK_RES) out = out.replace(re, '');
    for (const re of NOISE_RES) out = out.replace(re, '');
  }
  for (const re of LONE_TAG_RES) out = out.replace(re, '');
  // 折叠三个以上换行为两个
  out = out.replace(/\n{3,}/g, '\n\n');
  return out.trim();
}

/** 把一段匹配文本替换成**等量空行** —— 行数不变，位置 ID 才映射得回原文。 */
function blankOut(text, re) {
  return text.replace(re, (m) => '\n'.repeat((m.match(/\n/g) || []).length));
}

/**
 * 「保留行结构」的清洗：垃圾块被**置空**而不是删除。
 *
 * 为什么需要它：位置 ID（P3）是"第 3 个非空行"，模型用它指定配图位置，
 * 渲染器再用它换算回原文物理行号去插入图片。若清洗时把垃圾行整行删掉，
 * 编号就会错位——图会插到错误的段落后面。所以：
 *   给模型看 / 算位置池 / 插入定位，三处必须用同一份"行结构清洗"结果。
 *
 * @returns {string} 行数与原文一致、垃圾行为空串的文本
 */
export function cleanBodyLines(text, opts = {}) {
  if (!text) return '';
  let out = String(text);

  out = blankOut(out, THINK_RE);
  out = blankOut(out, META_RE);
  out = blankOut(out, HL_TAG_RE);
  for (const re of FOREIGN_TAG_RES) out = blankOut(out, re);
  if (opts.keepNoise !== true) {
    for (const re of STRUCT_BLOCK_RES) out = blankOut(out, re);
    for (const re of NOISE_RES) out = blankOut(out, re);
  }

  // 行级：先摘掉行内的孤立标签（<content> </thinking> 之类），摘完为空就整行清空。
  // 有些卡把 </thinking> 和场景标记写在同一行，只判"整行是否只剩标签"会漏掉这种情况。
  return out.split('\n').map((line) => {
    if (!line.trim()) return '';
    let t = line;
    for (const re of LONE_TAG_RES) { re.lastIndex = 0; t = t.replace(re, ''); }
    return t.trim() ? t : '';
  }).join('\n');
}

/* ============ 叙事行筛选（v0.9.144） ============ */

/**
 * ★★★ 为什么需要这一层（2026-10-28 真实第一楼审计）
 *
 * 一张卡的主 AI 输出**不是纯剧情**，它按模板吐了一整套"施工脚手架"：
 *
 *   ```
 *   <draft>
 *   呀~欢迎欢迎！…（OOC 开场白）
 *   - 距离上次正文的时空间变化:
 *   - 时间推进: 2026-04-17T15:30 -> 15:38
 *   - 地点位置: 本馆屋顶平台
 *   **写作方向思考步骤**：
 *   - 1. 鲜活度设计：…  - 2. 素材排重：…（6 条）
 *   <scene_time> 2026-04-17T15:38|星期五|暮|多云 </scene_time>
 *   <now_plot>
 *   <!-- charThink:
 *   - [焦点角色]: …  - [对用户态度]: …  - [行为分支]: * A·常规: …
 *   -->
 *   风把她的头发又吹乱了。（← 真剧情从这里才开始）
 *   …
 *   </now_plot>
 *   <action> [Opt1:😇] … [Opt6:😈] </action>
 *   ```
 *
 * 旧口径「非空物理行 = 一个段落」把上面**全部 49 行**都算成段落，
 * 而真剧情只有 11 行 —— 元信息占 78% 行数 / 74% 字数。
 *
 * 连锁后果（这是"越改越差"的真正机制，不是措辞问题）：
 *   ① `mossCoverPlan` 按 49 段算 ⇒ 出 5 页 × 4 格 = 20 格；
 *   ② 指令写「每盒约覆盖 2.5 段正文」，模型手里只有 11 段真剧情；
 *   ③ ⇒ **11 段剧情必须硬凑 20 格** ⇒ 拆步、重复、空镜、编画面。
 *     用户在草稿上调多少措辞都没用 —— 输入本身就是垃圾进。
 *
 * ⇒ 修法不是改指令，是**把编号坐标系换成"叙事行"**。
 *
 * ⚠️ 三个坐标系必须同源（算/比/插 三处）：
 *   · `renderIndexed`      给模型看 P 编号
 *   · `mossCoverPlan`      段数 → 页数/格数
 *   · `insertImages`       P 编号 → 物理行号（插图落点）
 *   改一处不改另一处 = 图插到元信息行后面。
 */

/** 整行只有一个标签（`<draft>` / `</now_plot>` / `<scene_time>` / `<!--x-->`）。 */
const TAG_ONLY_RE = /^(?:<\/?[a-z][\w:-]*(?:\s[^>]*)?\/?>|<!--[\s\S]*?-->)$/i;

/**
 * **元信息容器**：这些块里装的是给"下一个 AI"看的施工数据，不是剧情。
 *
 * ⚠️ 刻意不含 `now_plot` / `content` / `scene` 这类**剧情容器** ——
 *    本例 `<now_plot>` 里装的就是真剧情（P30~P40），整块剥掉等于把正文删了。
 */
const META_BLOCK_NAMES = new Set([
  'draft', 'action', 'actions', 'options', 'choices', 'choice',
  'scene_time', 'scenetime', 'status', 'statusbar', 'variable', 'variables',
  'think', 'thinking', 'reasoning', 'pattern', 'plan', 'plot_plan',
  'prefill', 'commentary', 'metacognition', 'analysis', 'json_patch', 'update',
  // ★ v0.9.145：真实楼层里还有这些（《雾津市播种计划！》2026-09-30 实测）
  'recap', 'details', 'summary', 'time', 'update_analysis',
  'world_logic', 'wardrobe_physics',
]);

/**
 * ★★★ 剧情容器白名单：**只有这些块里的内容是真剧情**。
 *
 * 为什么要单独一张表：`META_BLOCK_NAMES` 里的块「遇到别的标签就当自己结束了」，
 * 这条兜底本来是为了兼容「没有闭标签的元块」。实测（2026-09-30 雾津市）
 * `<update>` 里嵌套了 `<update_analysis>`，于是状态机认为 `<update>` 结束，
 * 后面 `_.set('世界.当前时间', '07:32');` 这些**代码行**全被当成剧情编号。
 *
 * ⇒ 改成：块内遇到别的标签**一律不退出**，只有遇到下面这些「剧情容器」才退出。
 *   未知标签按"嵌套结构"处理（`<details>` / `<summary>` 就是这类）。
 */
const STORY_BLOCK_NAMES = new Set([
  'now_plot', 'content', 'scene', 'story', 'narrative', 'main', 'plot',
  'dialog', 'dialogue', 'body', 'text',
]);

/** 元信息**键值行**（没有块包裹时的兜底）。只认行首就是这些键的。 */
const META_KV_RE = /^[-*·•]\s*(距离上次[^\n:：]{0,12}|时间推进|时间变化|地点位置|当前位置|具体地点|出场人物|在场人物|登场人物|天气|季节|时段|氛围基调|备注)\s*[:：]/;

/** 选项行：`[Opt1:😇] …` / `[选项1] …`。 */
const OPT_LINE_RE = /^[\[［]\s*(?:opt|option|选项)\s*\d*[^\]］]*[\]］]/i;

/** 「**写作方向思考步骤**：」这类小节标题 —— 其后到下一个非列表行为止都算施工。 */
const PLAN_HEAD_RE = /^\*\*[^*\n]{0,24}(?:思考|方向|步骤|计划|排布|设计思路)[^*\n]{0,24}\*\*\s*[:：]?\s*$/;

/** 列表项（施工小节的成员行）。 */
const LIST_ITEM_RE = /^(?:[-*·•]|\d+[.、)])\s+/;

/** 开标签名（`<foo bar>`），返回小写名 / ''。 */
function openTagName(line) {
  const m = String(line || '').match(/^<([a-z][\w:-]*)(?:\s[^>]*)?>$/i);
  return m ? m[1].toLowerCase() : '';
}

/**
 * ★ v0.9.145：绘灵自己插进正文的图位标记。
 *
 * `<hl_image pos="P3">english caption</hl_image>` —— 它**不是剧情**，
 * 是上一轮生成的插图占位；把它当剧情编号会让 P 编号整体后移、图插错位置。
 * 实测（雾津市 2026-09-30 那一楼）：3 个标记 = 3 段假剧情。
 */
const HL_IMAGE_RE = /^<\/?hl_image\b/i;

/** ``` 代码围栏行（时间块内容常被 ``` 包着）。 */
const FENCE_RE = /^```/;

/** `<details>` / `<summary>` 这类折叠容器行。 */
const DETAILS_RE = /^<\/?(?:details|summary)\b/i;

/**
 * 场景事实容器：这些块里的内容要**捞回来当"本楼场景事实"**（不进 P 编号）。
 * `time` 是 v0.9.145 加的 —— 真实楼层用 `<time>```地点·日期·时段```</time>` 报场景。
 */
const SCENE_BLOCK_NAMES = /^(scene_time|scenetime|time|status|statusbar|scene)$/i;

/** 闭标签名。 */
function closeTagName(line) {
  const m = String(line || '').match(/^<\/([a-z][\w:-]*)\s*>$/i);
  return m ? m[1].toLowerCase() : '';
}

/**
 * 一行里出现的所有标签（开 / 闭分开），用于处理**同行开闭**的写法。
 *
 * ★★★ v0.9.146 病例（《雾津市播种计划！》2026-09-30 那一楼）：
 *   正文里写着 `</thinking><time>` —— 闭标签和场景容器**在同一行**。
 *   而 `closeTagName` / `openTagName` 都是**整行锚定**的正则，
 *   对这一行双双返回空串 ⇒ 状态机既不退出 thinking、也不知道 `<time>` 开了。
 *   后果：`<time>```雾津大学主校区大门前·2025年9月17日·星期三·07:26```</time>`
 *   整块被吞 ⇒ `sceneFactLines` 返回空数组 ⇒ **本楼场景事实全丢**，
 *   模型只能靠正文自己猜地点（"后面几组变室内"的同类成因）。
 *   注意 `storyRows` 看不出问题：它靠后面 `<content>` 纯标签行才退出，剧情照样 16 段，
 *   所以**必须单独用 sceneFactLines 验**。
 */
function inlineTagNames(line) {
  const opens = []; const closes = [];
  const re = /<(\/?)([a-z][\w:-]*)(?:\s[^>]*)?>/gi;
  const s = String(line || '');
  let m;
  while ((m = re.exec(s))) {
    (m[1] ? closes : opens).push(m[2].toLowerCase());
  }
  return { opens, closes };
}

/**
 * 逐行判定：这是不是一行**叙事**（要编号、要配图的那类）。
 *
 * 纯函数，不看上下文 —— 上下文（块内 / 注释内）由 `storyRows` 的状态机处理。
 */
export function isStoryLine(line) {
  const t = String(line || '').trim();
  if (!t) return false;
  if (TAG_ONLY_RE.test(t)) return false;
  if (HL_IMAGE_RE.test(t)) return false;   // 插图占位标记
  if (FENCE_RE.test(t)) return false;      // ``` 围栏
  if (DETAILS_RE.test(t)) return false;    // <details> / <summary>
  if (META_KV_RE.test(t)) return false;
  if (OPT_LINE_RE.test(t)) return false;
  if (PLAN_HEAD_RE.test(t)) return false;
  return true;
}

/**
 * 挑出叙事行，返回 `[{ i, text }]`（i = **清洗后文本**里的物理行号，0 基）。
 *
 * @param {string} body 已经过 `cleanBodyLines` 的正文
 * @returns {Array<{i:number,text:string}>}
 */
export function storyRows(body) {
  const lines = String(body || '').split('\n');
  const out = [];
  /** 当前所处的元块：{ name, sawClose } —— sawClose=false 时遇到下一个纯标签行就退出。 */
  let block = null;
  /** 当前是否在 `<!-- … -->` 里。 */
  let inComment = false;
  /** 是否在「**写作方向**：」这类施工小节里。 */
  let inPlan = false;

  for (let i = 0; i < lines.length; i += 1) {
    const t = lines[i].trim();
    if (!t) continue;

    // HTML 注释块：charThink 就在这里
    if (inComment) {
      if (t.includes('-->')) inComment = false;
      continue;
    }
    if (t.startsWith('<!--')) {
      if (!t.includes('-->')) inComment = true;
      continue;
    }

    const tagOnly = TAG_ONLY_RE.test(t);
    const close = closeTagName(t);

    /**
     * ★★★ v0.9.145 · 元块内部：**只有遇到剧情容器才退出**。
     *
     * 旧逻辑「遇到任意纯标签行就当块结束」在真实楼层里会漏剥一大片 ——
     * `<update>` → `<update_analysis>`（嵌套标签）→ 误判结束 →
     * 后面 `_.set(...)` / `_.add(...)` 这些**代码行**全被当成剧情编号。
     *
     * 现在：闭标签同名 → 退出；开标签是剧情容器 → 退出；其余（嵌套 meta 标签 /
     * `<details>` / `<summary>`）→ 留在块内继续剥。
     */
    if (block) {
      /**
       * ★★★ v0.9.146：**同行开闭**（`</thinking><time>`）。
       *   整行锚定的 closeTagName 认不出它 ⇒ 旧代码既不退出 thinking，也看不见 `<time>`。
       *   这里先按行内标签判定：闭了当前块就退出，并接上同一行里紧跟的场景容器。
       */
      const inline = inlineTagNames(t);
      if (inline.closes.includes(block.name)) {
        block = null;
        const nextOpen = inline.opens.find((n) => SCENE_BLOCK_NAMES.test(n));
        if (nextOpen) block = { name: nextOpen };
        continue;
      }
      if (close && close === block.name) { block = null; continue; }
      const op = tagOnly ? openTagName(t) : '';
      /**
       * ★ 场景容器（`<time>` / `<scene_time>`）也必须能"踢开"未闭合的元块。
       * 实测（雾津市 2026-09-30）：主 AI 的 `<thinking>` **没有闭标签**，
       * 于是 `<time>` 被吞在 thinking 块里 → 场景事实整块丢失 → 每格背景自由发挥。
       */
      const escapes = op && (STORY_BLOCK_NAMES.has(op) || SCENE_BLOCK_NAMES.test(op));
      if (escapes) { block = null; /* 落到下面按"新块开始"处理 */ } else { continue; }
    }

    // 插图占位标记（单行 `<hl_image …>…</hl_image>`，或跨行时进块）
    if (HL_IMAGE_RE.test(t)) {
      if (openTagName(t) === 'hl_image' || /^<hl_image\b/i.test(t)) {
        if (!/<\/hl_image>/i.test(t)) block = { name: 'hl_image' };
      }
      continue;
    }
    if (block && block.name === 'hl_image') continue;

    if (tagOnly) {
      const open = openTagName(t);
      if (open && META_BLOCK_NAMES.has(open)) { block = { name: open }; continue; }
      continue; // 其它纯标签行：剧情容器（now_plot/content）的开闭标签，本身不是剧情
    }

    // 施工小节：标题行本身丢掉，其后的列表项全丢，遇到非列表行才结束
    if (PLAN_HEAD_RE.test(t)) { inPlan = true; continue; }
    if (inPlan) {
      if (LIST_ITEM_RE.test(t)) continue;
      inPlan = false;
    }

    if (!isStoryLine(t)) continue;
    out.push({ i, text: t });
  }
  return out;
}

/**
 * 从被剥掉的行里**捞回场景事实**。
 *
 * 为什么不能直接丢：本例正文 P30~P40 里**一次都没写地点**，
 * 地点只有 `<scene_time>` 与「- 地点位置: 本馆屋顶平台」这两处。
 * 剥干净 → 模型不知道人在哪 → 每格背景自由发挥（这正是"后面几组变室内"的成因之一）。
 * ⇒ 单独抽出来，**不进 P 编号**，作为「本楼场景事实」旁路喂给模型。
 */
export function sceneFactLines(body) {
  const lines = String(body || '').split('\n');
  const out = [];
  let block = null;
  let inComment = false;
  for (const raw of lines) {
    const t = raw.trim();
    if (!t) continue;
    if (inComment) { if (t.includes('-->')) inComment = false; continue; }
    if (t.startsWith('<!--')) { if (!t.includes('-->')) inComment = true; continue; }
    const tagOnly = TAG_ONLY_RE.test(t);
    const close = closeTagName(t);
    if (block) {
      /**
       * ★★★ v0.9.146：同行开闭（`</thinking><time>`）—— 与 `storyRows` 同一套判定。
       *   这条是 `sceneFactLines` 返回空数组的直接原因（本楼地点/时间全丢）。
       */
      const inline = inlineTagNames(t);
      if (inline.closes.includes(block)) {
        block = null;
        const nextOpen = inline.opens.find((n) => SCENE_BLOCK_NAMES.test(n));
        if (nextOpen) block = nextOpen;
        continue;
      }
      if (close && close === block) { block = null; continue; }
      /**
       * ★ v0.9.145：与 `storyRows` 同一套退出规则（只有剧情容器才退出）。
       * 同一楼层两处状态机不一致 ⇒ 一边剥掉、一边当事实收，等于白剥。
       */
      const op = tagOnly ? openTagName(t) : '';
      const escapes = op && (STORY_BLOCK_NAMES.has(op) || SCENE_BLOCK_NAMES.test(op));
      if (escapes) block = null;
      else {
        // 时间/地点/天气类容器：内容原样收下
        // ★ 也要收"元块里的键值行"—— 本例「- 地点位置: 本馆屋顶平台」就躺在 <draft> 里，
        //   而正文剧情一次都没写地点，漏掉它就是场景全丢。
        if (SCENE_BLOCK_NAMES.test(block) || META_KV_RE.test(t)) {
          // ``` 围栏包着的时间行（`<time>` 块的常见写法）
          const v = t.replace(/^[-*·•]\s*/, '').replace(/^```\s*/, '').replace(/\s*```$/, '').trim();
          if (v && !/[:：]\s*$/.test(v)) out.push(v);
        }
        continue;
      }
    }
    if (HL_IMAGE_RE.test(t)) continue; // 上一轮的插图标记不是场景事实
    if (tagOnly) {
      const open = openTagName(t);
      if (open) { block = open; }
      continue;
    }
    if (META_KV_RE.test(t)) {
      // 空值行（「- 距离上次正文的时空间变化:」后面什么都没有）不算事实
      if (!/[:：]\s*$/.test(t)) out.push(t.replace(/^[-*·•]\s*/, ''));
    }
  }
  return out;
}

/**
 * 把正文按**叙事行**切开，并给每行打上位置 ID。
 *
 * ★ 叙事行为 0 时**回退成"全部非空行"** —— 宁可编号多，也不能让一整个楼层没有配图位置
 *   （某些卡把正文放在我们不认识的容器里；回退比空白安全）。
 */
export function indexParagraphs(body) {
  const lines = String(body || '').split('\n');
  const out = new Array(lines.length);
  const rows = storyRows(body);
  if (!rows.length) {
    let n = 0;
    for (let i = 0; i < lines.length; i += 1) {
      const text = lines[i].trim();
      if (!text) { out[i] = { id: null, text: '' }; continue; }
      n += 1;
      out[i] = { id: `P${n}`, text };
    }
    return out;
  }
  for (let i = 0; i < lines.length; i += 1) out[i] = { id: null, text: lines[i].trim() };
  rows.forEach((r, k) => { out[r.i] = { id: `P${k + 1}`, text: r.text }; });
  return out;
}

/** 叙事行数（给 coverPlan 用 —— 与 renderIndexed 的编号同源）。 */
export function storyLineCount(body) {
  return storyRows(body).length || String(body || '').split('\n').filter(l => l.trim()).length;
}

/** 拼出带位置 ID 的正文（只给模型看，不写回原文）。 */
export function renderIndexed(body) {
  return indexParagraphs(body)
    .filter(p => p && p.id)
    .map(p => `${p.text} ⟦${p.id}⟧`)
    .join('\n');
}

/**
 * 位置 ID → 原始物理行号（0 基）。找不到返回 -1。
 *
 * ★ v0.9.144：坐标系换成**叙事行**（与 `renderIndexed` 完全同源）。
 *   旧实现按"第 n 个非空行"算 —— 净化之后 P1 指的是"第 1 个叙事行"，
 *   还按非空行数就会把图插到 `<draft>` / `[Opt1]` 这种施工行后面。
 */
export function positionToLineIndex(body, position) {
  const want = String(position || '').trim().toUpperCase();
  const rows = storyRows(body);
  if (rows.length) {
    // ★ 有叙事行就**只认叙事行编号**：找不到 = 这个编号非法，返回 -1。
    //   不许在这里回落到"非空行"口径 —— 那会让模型写 P30 也定位成功，
    //   图直接插到 `<action>` 选项后面（编号超界必须被识别为超界）。
    const hit = rows.find((r, k) => `P${k + 1}` === want);
    return hit ? hit.i : -1;
  }
  // 回退：叙事行为 0（整楼都是施工数据）时回到"非空行"口径，与 indexParagraphs 一致
  const lines = String(body || '').split('\n');
  let n = 0;
  for (let i = 0; i < lines.length; i += 1) {
    if (!lines[i].trim()) continue;
    n += 1;
    if (`P${n}` === want) return i;
  }
  return -1;
}

/* ============ 指纹 ============ */

/**
 * 把异常压成「消息 + 关键堆栈帧」——存进错误记录，让错误槽 hover 就能定位肇事文件。
 *
 * 起因：实测出过 `Cannot read properties of undefined (reading 'title')` 这类错误，
 * 消息本身完全看不出是哪个文件抛的（绘灵自己的代码根本没有读 .title 的地方，
 * 高度怀疑是别的扩展 patch 了 fetch / 事件后被我们的 catch 捕获）。
 * 没有堆栈就只能瞎猜；有了堆栈，错误框 hover 一下就能看到肇事文件:行号。
 *
 * 堆栈帧过滤掉 node_modules 噪音，取前 3 帧（通常是 throw 点 → 上游调用点）。
 */
export function errorBrief(err) {
  const msg = err?.message || String(err || '未知错误');
  const frames = String(err?.stack || '')
    .split('\n')
    .map(s => s.trim())
    .filter(s => s.startsWith('at '))
    .filter(s => !/node:internal|node_modules/.test(s))
    .slice(0, 3);
  return frames.length ? `${msg}\n${frames.join('\n')}` : msg;
}

/** 稳定短哈希（FNV-1a 32 位），用于提示词哈希与去重。 */
export function hash32(str) {
  let h = 0x811c9dc5;
  const s = String(str ?? '');
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/** 正文指纹：清洗后取前 200 字 + 长度，用于「这楼是否已处理过」。 */
export function bodyFingerprint(body) {
  const c = cleanBody(body).replace(/\s+/g, '');
  return `${hash32(c.slice(0, 200))}-${c.length}`;
}

/* ============ 杂项 ============ */

export function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 连续逗号 / 首尾逗号清理，替换占位符后必用。 */
export function tidySeparators(text) {
  let out = String(text ?? '');
  /**
   * ★★ v0.9.110 · BREAK 必须整段保护（用户 2026-10-20 报「BREAK 也被吞了」）。
   *
   * 下面的 `,\s+ → ', '` 会把段尾逗号后面的换行一起吃掉：
   *     `loafers,\nBREAK\n1boy`  ⇒  `loafers, BREAK\n1boy`
   * BREAK 一旦不独立成行，下游 `withSegmentTrailingCommas` 的
   * `split(/\n\s*BREAK\s*\n/)` 就匹配不上 → 整串被当成**一段** → 分段彻底失效。
   *
   * 后果不只是"少了个 BREAK"：分段是 SD 的**防串台结构**，段一塌，
   * 两个人的外貌锚点就挤在同一段权重里互相污染（实测表现就是女主段里混进别人的黑发）。
   *
   * 做法：清洗前把 `\nBREAK\n` 换成不带逗号的占位符，清洗完再还原。
   * 占位符用 SOH 控制字符 —— 它不匹配 `\s`，不会被 `,\s+` 连坐；
   * 原文若已含该字符则跳过保护（宁可不保护也不制造乱码）。
   */
  const PH = '\u0001';
  const guard = !out.includes(PH);
  if (guard) out = out.replace(/\n\s*BREAK\s*\n/gi, `${PH}BREAK${PH}`);

  for (let i = 0; i < 4; i += 1) {
    const next = out
      .replace(/,\s*,/g, ',')
      .replace(/\s+,/g, ',')
      .replace(/,\s+/g, ', ');
    if (next === out) break;
    out = next;
  }
  if (guard) out = out.split(PH).join('\n');
  /*
   * 还原后清掉 BREAK **后面**紧跟的逗号（`\nBREAK\n,1boy`）。
   * 不能顺手清 BREAK **前面**的逗号 —— 那正是「每段结尾补的那个逗号」，是用户要的格式。
   */
  out = out.replace(/(\nBREAK\n)[ \t]*,/g, '$1');
  return out.replace(/^[\s,]+/, '').replace(/[\s,]+$/, '').trim();
}

/**
 * 保行版 tidySeparators（v0.9.118）。
 *
 * ★★★ 为什么必须有它（用户 2026-10-21：「最终提示词别都挤在一起，分段排列」）：
 *   `tidySeparators` 里那句 `.replace(/,\s+/g, ', ')` 会把 `,\n\n` 一起吃掉 ——
 *   `\s` 包含换行。MOSS 的整段提示词靠 `\n\n` 表达结构（版面声明 / 人物段 / 每格一格），
 *   过一遍就全挤成一行，用户（英文不好）根本分不清哪句是哪格。
 *   同一条教训在 BREAK 上已经踩过两次（见上面的占位符保护）。
 *
 * 做法与 BREAK 一致：清洗前把换行换成不匹配 `\s` 的占位符，洗完还原。
 * 原文已含该占位符时**不保护**（宁可不保也不制造乱码）。
 */
export function tidySeparatorsKeepLines(text) {
  const NL = '\u0002';
  const src = String(text ?? '');
  if (!src.includes('\n') || src.includes(NL)) return tidySeparators(src);
  const guarded = src.split('\n').join(NL);
  return tidySeparators(guarded).split(NL).join('\n');
}

/** 去掉逗号分隔里重复的 token。
 *  @展开、锚点自愈、模型自己写重，都会产生 "1girl, 1girl" 这类重复；
 *  重复 token 会加倍正向权重，把画面往一个方向拽。 */
export function dedupeTag(text) {
  const seen = new Set();
  const out = [];
  for (const raw of String(text ?? '').split(',')) {
    const t = raw.trim();
    if (!t) continue;
    const key = t.toLowerCase().replace(/\s+/g, ' ');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out.join(', ');
}

/** 一行化：换行压成空格。 */
export function oneLine(v) {
  return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '';
}

/** 深拷贝（结构化数据，不跑函数）。 */
export function clone(v) {
  if (v === null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(clone);
  const out = {};
  for (const k of Object.keys(v)) out[k] = clone(v[k]);
  return out;
}

/** 限定枚举取值，不在表内返回 fallback。 */
export function pickEnum(value, allowed, fallback) {
  const v = String(value ?? '').trim().toLowerCase();
  return allowed.includes(v) ? v : fallback;
}

/** 简易防抖。 */
export function debounce(fn, ms) {
  let timer = null;
  return (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; fn(...args); }, ms);
  };
}

/** 简易节流（尾部执行）。 */
export function throttle(fn, ms) {
  let last = 0;
  let timer = null;
  return (...args) => {
    const now = Date.now();
    const wait = ms - (now - last);
    if (wait <= 0) {
      last = now;
      fn(...args);
    } else if (!timer) {
      timer = setTimeout(() => { timer = null; last = Date.now(); fn(...args); }, wait);
    }
  };
}

/* ============ 服装款式比对 ============ */

/** 服装描述切词：按逗号/分号/空白切开，丢掉单字符噪声。 */
function outfitTokens(s) {
  return new Set(
    String(s || '')
      .toLowerCase()
      .replace(/[（(][^）)]*[）)]/g, ' ')   // 去掉括号里的中文注释
      .split(/[,，、;；\s]+/)
      .map(x => x.replace(/^[^a-z0-9\u4e00-\u9fff]+|[^a-z0-9\u4e00-\u9fff]+$/g, ''))
      .filter(x => x.length > 1)
  );
}

/**
 * 新款式对旧款式的「元素覆盖率」= 旧描述里有多少元素被新描述保留了。
 *
 * 为什么不用 Jaccard（交集/并集）：
 *   补充描述和缩略描述都会拉低 Jaccard，无法区分。比如
 *     旧 `white sailor blouse`（3 词） → 新（20 词的完整六要素版）
 *     Jaccard = 3/20 = 0.15 —— 会被误判成「换款」，
 *   但这恰恰是我们**希望鼓励**的行为（AI 主动把笼统描述补细）。
 *
 * 用覆盖率就分得很干净：
 *   补充：旧 3 词全在新描述里 → 覆盖率 1.0 → 接受
 *   缩略：旧 20 词只有 3 词保留 → 覆盖率 0.15 → 拒绝（缩略就是漂移的开始）
 *   换款：旧 `navy sailor uniform` → 新 `white shirt plaid skirt` → 覆盖率 0 → 拒绝
 *
 * @returns {number} 0~1
 */
export function styleCoverage(oldStyle, newStyle) {
  const A = outfitTokens(oldStyle);
  const B = outfitTokens(newStyle);
  if (!A.size) return 1;      // 旧值为空 → 一切新值都算「建立」而非「改写」
  if (!B.size) return 0;
  let hit = 0;
  for (const t of A) if (B.has(t)) hit += 1;
  return hit / A.size;
}

/** 款式描述的精细度：词元数。制式服装低于 5 就太笼统，必然漂移。 */
export function styleDetailScore(style) {
  return outfitTokens(style).size;
}

/* ============ 剧情换装信号（v0.9.39） ============ */

/**
 * 换装动词后面必须真的接一件衣服才作数。
 *
 * 只写 `换(上|了)` 会误伤「换了个姿势」「换了方向」「换了个话题」这类句子 ——
 * 一旦误判成换装，款式闸门就放行改写，防漂移整套机制当场失效。
 * 所以这里强制要求动词后 0~10 字内出现衣物名词。
 */
const CLOTH_NOUN = '(衣服|衣裳|一身|装|衣|裙|裤|袜|鞋|靴|制服|校服|居家服|家居服|围裙|外套|大衣|风衣|衬衫|T恤|卫衣|西装|内衣|泳衣|睡衣|丝袜|连衣裙|套装|和服|浴衣)';

const SWAP_VERB_RE = [
  new RegExp(`换(上|了|成|掉|过|好)[^。；！？\\n]{0,10}${CLOTH_NOUN}`),
  new RegExp(`改穿[^。；！？\\n]{0,10}${CLOTH_NOUN}`),
  new RegExp(`另外穿[^。；！？\\n]{0,10}${CLOTH_NOUN}`),
  new RegExp(`重新穿(好|上)?[^。；！？\\n]{0,10}${CLOTH_NOUN}`),
  new RegExp(`(脱|褪|扒)(下|掉|去|光)?[^。；！？\\n]{0,10}(换|套上|穿上)[^。；！？\\n]{0,10}${CLOTH_NOUN}`),
];

const PRONOUN_RE = /(她|他|它|少女|女人|男人|女子|男子|少妇|人妻)/;

/** 按句切分正文（标点即断句，够用且比 NLP 分词稳）。 */
export function splitSentences(text) {
  return String(text || '')
    .split(/[。！？；\n]+/)
    .map(s => s.trim())
    .filter(Boolean);
}

/**
 * 本楼正文里，该角色是否有**明确的换装描写**。
 *
 * 这是「剧情真换了衣服」与「模型又编了一遍」的分界线 —— 用户拍板的口径是
 * 「认换装动词才放行」。实测依据：结城太太 #4/#6 是灰色针织衫+棉质长裙，
 * #14 起变成粉色棉质居家服（正文确实换了衣服）；而周雅的围裙在 #12/#14/#16/#18
 * 只是措辞变化（宽松的 / 粗亚麻材质的 / 一侧系带滑落），本质同一件，不该判成换装。
 *
 * 判定顺序（从严到宽）：
 *   ① 句子里直接出现角色名 + 换装动词 → 命中
 *   ② 本楼只有一个候选角色时，代词句（她/他…）+ 换装动词 → 命中
 *      多人场景里代词句会把所有人一起误判，所以只在单角色时放宽。
 *
 * @param {string} body 本楼正文（清洗后）
 * @param {string} name 角色名
 * @param {number} [candidateCount] 本楼候选角色数
 * @returns {boolean}
 */
export function hasOutfitSwapSignal(body, name, candidateCount = 1) {
  const text = String(body || '');
  const nm = String(name || '').trim();
  if (!text || !nm) return false;
  const esc = nm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const nameRe = new RegExp(esc);
  const allowPronoun = Number(candidateCount) <= 1;

  for (const s of splitSentences(text)) {
    if (!SWAP_VERB_RE.some(re => re.test(s))) continue;
    if (nameRe.test(s)) return true;
    if (allowPronoun && PRONOUN_RE.test(s)) return true;
  }
  return false;
}

/**
 * 具体衣物名词 —— 说出它本身就已经是"一套衣服"了，不需要再配修饰词。
 * 「她穿着睡裙」里的"睡裙"就是具体款式；而"衣服/衣裳/一身"是泛称，
 * 必须再配颜色或材质才算具体（否则"她穿着衣服"也会触发，纯噪声）。
 */
const CLOTH_SPECIFIC_NOUN =
  '(裙|裤|袜|鞋|靴|制服|校服|居家服|家居服|围裙|外套|大衣|风衣|衬衫|T恤|卫衣|西装|内衣|泳衣|睡衣|丝袜|连衣裙|套装|和服|浴衣|胸罩|内裤|文胸|马甲|背心|披肩|斗篷|紧身衣)';

/**
 * 泛称 —— 单独出现不作数，必须与 CLOTH_MODIFIER_RE 同时命中。
 * 「一件/一套/一条」是量词短语，本身不说明款式（"一件黑色棉质连帽衫"里
 * 真正提供信息的是后面的修饰词），所以归泛称、要求配修饰。
 */
const CLOTH_GENERIC_NOUN = '(衣服|衣裳|衣物|一身|一件|一套|一条|一身行头)';

/** 修饰词：颜色 / 材质 / 剪裁款式。命中说明正文在**具体描述**一件衣服。 */
const CLOTH_MODIFIER_RE =
  /(白|黑|红|蓝|绿|黄|粉|紫|灰|米|棕|金|银|驼|藏青|酒红|墨绿|象牙|香槟|雾蓝|奶白|天蓝|浅|深|亮|暗|真丝|丝质|丝绸|缎|绸|纱|棉|麻|蕾丝|牛仔|皮|针织|羊毛|绒|雪纺|薄纱|涤|尼龙|乳胶|吊带|一字肩|露肩|V领|深V|高腰|低腰|宽松|紧身|修身|短款|长款|及膝|过膝|包臀|A字|百褶|开衩|无袖|长袖|短袖|抹胸|系带|拉链|纽扣)/;

/**
 * 本楼正文里，该角色是否被**具体描述了一件衣服**（v0.9.67 · 用户勾选 C3）。
 *
 * ★ 为什么要有这条（真实病例，2026-10-03）：
 *   168/170 楼正文写沈墨染「穿着白色丝质睡裙」，但换装没发生 ——
 *   `hasOutfitSwapSignal` 只认**换装动词**（换上/改穿/另外穿），
 *   而"穿着睡裙"是**状态描述**，不是换装动作 → 她压根没进扫描候选
 *   → 档案里 `pending: null`（连提交都没发生）→ 永远沿用档案那套雾蓝衬衫。
 *
 *   这条规则是用户 2026-09 拍板的口径（治"一件校服出八个版本"），
 *   副作用就是"正文写了新衣服却换不上"。C3 折中方案：
 *     **放宽准入**（具体新款描述也能进候选），
 *     **收紧放行**（仍要连续 N 楼一致，闸门在 store.updateOutfit 里）。
 *
 * ★ 与 hasOutfitSwapSignal 的分工（别合并）：
 *   - 本函数只管**进不进候选**，回答"本楼有没有人具体写了件衣服"；
 *   - 「算不算换装」由 store 的 repeatRelease / 丢件拦截闸门决定，
 *     本函数**不**参与 pipeline 里 swapped 标记的计算。
 *   合并的后果＝C2（立即换），校服八版本的老毛病会回来。
 *
 * @param {string} body 本楼正文（清洗后）
 * @param {string} name 角色名
 * @param {number} [candidateCount] 本楼候选角色数
 * @returns {boolean}
 */
export function hasOutfitNovelSignal(body, name, candidateCount = 1) {
  const text = String(body || '');
  const nm = String(name || '').trim();
  if (!text || !nm) return false;
  const esc = nm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const nameRe = new RegExp(esc);
  const allowPronoun = Number(candidateCount) <= 1;
  const specificRe = new RegExp(CLOTH_SPECIFIC_NOUN);
  const genericRe = new RegExp(CLOTH_GENERIC_NOUN);

  for (const s of splitSentences(text)) {
    const specific = specificRe.test(s);
    const generic = genericRe.test(s) && CLOTH_MODIFIER_RE.test(s);
    if (!specific && !generic) continue;
    if (nameRe.test(s)) return true;
    if (allowPronoun && PRONOUN_RE.test(s)) return true;
  }
  return false;
}

/**
 * 「重新穿上」动词 —— 状态位回退的放行信号（v0.9.45）。
 *
 * 注意 SWAP_VERB_RE 里已经有 `重新穿(好|上)` 这一条，它跟这里是**竞争关系**：
 * 同一个「重新穿好衣服」，既像换装也像回退。区分点在于有没有给出**新款式**：
 * 给了新款式 → 换装（swapped）；只是把原来那件穿回去 → 回退（redress）。
 * 这里只认「把原来那件弄回身上」的措辞，不认"换新的一身"。
 *
 * ★ 为什么必须有这条：NSFW 情节里角色脱了又被剧情穿回去是常态，而状态机
 *   默认只进不退（防漂移）。少了这个信号，状态位永久停在 removed，
 *   后续每一楼都还是"褪下"，与剧情脱节 —— 用户原话：「中间或后面又突然穿上了」。
 */
const REDRESS_VERB_RE = [
  // 「把裤子提起来 / 拉上运动裤 / 拽回内裤」—— 把褪下的衣物弄回原位
  new RegExp(`(提|拉|拽|捞|扯)(起|上|回|过)(来|去|到)?[^。；！？\\n]{0,10}(裤|裙|内裤|短裤|松紧带|腰头|衣服|裤子)`),
  // 「重新穿好 / 穿回衣服 / 套回去」—— 不指定新款，只是穿回去
  new RegExp(`(重新|又|再次)?(穿(好|回|上|起)|套(回|上))[^。；！？\\n]{0,10}${CLOTH_NOUN}`),
  // 「拉上拉链 / 扣好扣子 / 系好腰带 / 拢好衣襟」
  new RegExp(`(拉上|拉好|扣好|扣上|系好|系上|拢好|整理好|掖好)[^。；！？\\n]{0,10}(拉链|扣子|纽扣|腰带|衣襟|领口|裤|裙|衣服)`),
  /**
   * ★ 把字句：**动词在衣服名词后面**（中文最自然的说法，实测剧情里就是这么写的）
   *   「他手忙脚乱地试图用左手把褪到膝盖的裤子提起来」—— 上面三条都匹配不到，
   *   因为「提起来」在「裤子」之后。少了这条，最典型的那一句反而认不出。
   */
  new RegExp(`(把|将)[^。；！？\\n]{0,14}${CLOTH_NOUN}[^。；！？\\n]{0,8}(提(起|上|回)|拽(起|上|回)|拉(上|起|回)|扯(起|上|回)|穿(好|上|回)|套(回|上)|扣好|系好|拢好)`),
];

/** 正文里有没有「把衣服穿回去」的描写（用于放行服装状态位回退）。 */
export function hasOutfitRedressSignal(body, name, candidateCount = 1) {
  const text = String(body || '');
  const nm = String(name || '').trim();
  if (!text || !nm) return false;
  const esc = nm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const nameRe = new RegExp(esc);
  const allowPronoun = Number(candidateCount) <= 1;

  for (const s of splitSentences(text)) {
    if (!REDRESS_VERB_RE.some(re => re.test(s))) continue;
    if (nameRe.test(s)) return true;
    if (allowPronoun && PRONOUN_RE.test(s)) return true;
  }
  return false;
}

/**
 * 「穿着状态变化」动词 —— 脱 / 褪 / 掀 / 撩 / 解开 / 露出 / 赤裸 …
 *
 * ★ 为什么必须有这条（v0.9.46）：扫描器原本的触发条件是「没款式 or 有换装动词」。
 *   可 NSFW 情节里最常见的情况是**他不换衣服，只是脱**：
 *     「顺着松紧带直接将运动裤和内裤一起往下扯」「褪到膝盖处的灰色运动裤」
 *   这些句子里一个换装动词都没有（"换上/改穿/重新穿"），于是角色被整楼跳过 ——
 *   状态位永远停在 intact、bare 永远填不上，用户只能手动改。
 *   这就是用户原话「每次自己手动感觉很麻烦」的根因。
 *
 * 注意与 SWAP_VERB_RE 的分工：
 *   SWAP     = 换了**另一件衣服**（款式会变，需要放行款式改写）
 *   STATE    = 同一件衣服的**位置/覆盖状态**变了（款式不变，只动状态位与裸露锚点）
 *
 * @param {string} body 本楼正文（清洗后）
 * @param {string} name 角色名
 * @param {number} [candidateCount] 本楼候选角色数
 * @returns {boolean}
 */
const STATE_VERB_RE = [
  // 脱 / 褪 / 扒 / 扯下 / 拉下 —— 衣物离开身体
  new RegExp(`(脱|褪|扒|扯|拉|撸|抹|卷|掀|撩|翻|解开|扯开|拨开|扯掉|撕开)(下|掉|去|光|起|上|到|开|过|落)?[^。；！？\\n]{0,12}(裤|裙|衣|衫|袜|鞋|靴|罩|扣|拉链|带|布|料|裤头|松紧|腰|内衣|内裤|胸罩|领|襟|袖|肩|裙摆|下摆|衣服|衣物)`),
  // 露出 / 赤裸 / 光着 / 一丝不挂 / 真空 —— 结果态
  new RegExp(`(露(出|着|了)?|赤裸|裸(露|着)?|光(着|溜溜)|一丝不挂|不着寸缕|真空|empty|bare)[^。；！？\\n]{0,12}(胸|乳|腰|腹|臀|腿|下身|私处|阴|臀|股|皮肤|身子|身体|上身|下体|后背)?`),
  // 「敞开的 / 半褪的 / 褪至 / 滑落 / 挂在…」—— 衣物位置异常
  new RegExp(`(敞开|半褪|半脱|褪至|褪到|滑落|滑下|挂在|堆在|缠在|勒在|卡在|束缚|汗湿|浸透)[^。；！？\\n]{0,10}(裤|裙|衣|衫|袜|腰|腿|膝|踝|脚|身)?`),
  /**
   * ★ 方向状语 + 动词（**名词在动词前面**的真实写法）：
   *   「将运动裤和内裤一起往下扯」—— "往下" 插在中间，"扯" 在最后，
   *   上面那条（动词在前）匹配不到。实测剧情里就是这么写的。
   */
  new RegExp(`(往|向|朝)(下|上|外|后|里|两边)[^。；！？\\n]{0,6}(扯|拉|拽|褪|脱|撸|掀|撩|抹|卷|扒|扯下|拉下)`),
  // 部位直接当主语出现（"她的大腿完全暴露在外"）
  new RegExp(`(暴露|袒露|外露)[^。；！？\\n]{0,8}(在?外|出来|无遗)?`),
];

/** 本楼正文里，该角色是否有**穿着状态变化**（脱 / 穿回 / 露出）的描写。 */
export function hasOutfitStateSignal(body, name, candidateCount = 1) {
  const text = String(body || '');
  const nm = String(name || '').trim();
  if (!text || !nm) return false;
  const esc = nm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const nameRe = new RegExp(esc);
  const allowPronoun = Number(candidateCount) <= 1;

  let anyState = false;
  for (const s of splitSentences(text)) {
    if (!STATE_VERB_RE.some(re => re.test(s))) continue;
    anyState = true;
    if (nameRe.test(s)) return true;
    if (allowPronoun && PRONOUN_RE.test(s)) return true;
  }
  /**
   * ★ 多人场景兜底：中文动作句**主语承前省略**是常态 ——
   *   「夜斗背贴着冰冷的门板。菲悬在他面前，翅膀快速扇动。
   *     顺着松紧带直接将运动裤和内裤一起往下扯，褪到膝盖处。」
   * 最后两句既没有名字也没有代词，但显然属于在场者之一。
   * 一律跳过的话，NSFW 里最高频的"脱"反而永远扫不到 —— 这正是
   * 「每次都要手动填裸露」的根源，用户明确要求改成自动。
   *
   * 谁脱了交给模型判断（它有完整上下文），这里只回答一个更粗的问题：
   * **本楼有没有发生穿着状态变化**。不会误伤日常对话（没有状态动词就是 false）。
   */
  return anyState;
}

/**
 * 场景切换（时间跳跃）—— 款式改写的放行信号（v0.9.47）。
 *
 * ★ 为什么需要：剧情里换衣服最常见的场合恰恰**没有换装动词** ——
 *   「第二天早上他醒来，穿了一件灰色运动裤」这类，正文只是陈述新场景的穿着，
 *   而防漂移闸门认的是"换装动词"，于是款式永久停在上一场景那套。
 *   用户原话：「这是角色扮演小说，不是分镜图，不要锁死」。
 *
 * ★ 为什么**不顺便重置状态**：用户明确否决过 ——
 *   「新场景（第二天起床）默认穿好不是绝对的，还是要看前后剧情」。
 *   第二天醒来可能还光着身子（上一场戏的延续），也可能已经换好出门。
 *   所以这里**只放行款式改写**，状态位与裸露锚点照旧由模型读剧情定 —— 不设默认值。
 */
const SCENE_BREAK_RE = [
  // 时间跳跃
  /(第(二|2|三|3|四|4|五|5|六|6|七|7)天|次日|翌日|隔天|第二天|后天|明早|一周后|半个月后|一个月后|几小时后|那天晚上|当天下午|转天)/,
  // 起居节点
  /(醒来|睡醒|起床|晨起|清晨|清早|一觉醒来|天亮|日上三竿|出门前|临出门|回到家|回到公寓|进屋后|回到家里)/,
  // 盥洗 / 更衣节点
  /(洗完澡|洗完澡后|冲完凉|沐浴后|出浴|更衣|换了身|收拾妥当|穿戴整齐|穿戴完毕|整装)/,
  // 明确的新场景标记
  /(场景(切换|转换)|新的场景|换了个地方|次日清晨|翌日清晨)/,
];

/** 本楼正文里有没有**场景切换**（时间跳跃 / 新场景开场）。 */
export function hasSceneBreakSignal(body) {
  const text = String(body || '');
  if (!text) return false;
  return SCENE_BREAK_RE.some(re => re.test(text));
}

/**
 * 把**混在款式里的状态词**拆到裸露锚点里去（v0.9.46 存量自愈）。
 *
 * 典型病例（实测夜斗的档案就是这样）：
 *   style = "slightly wrinkled black hoodie, light blue shorts and underwear pulled down around his knees"
 * 注入出来是「身穿…褪到膝盖的短裤」—— 自相矛盾，而且 `pulled down` 这种
 * 一次性状态被固化进款式后，之后每楼都会带着它出场（哪怕剧情里已经穿回去了）。
 *
 * 做法：按逗号切片段，含状态词的片段搬到 bare，剩下的留在 style。
 * 规则 2（"沿用就不输出"）挡不住这种历史脏数据 —— 款式闸门认的是覆盖率，
 * 而"同一件衣服+状态词"的覆盖率天然很高，永远不会被判成漂移。只能代码拆。
 *
 * @param {string} style 款式原文
 * @returns {{style:string, bare:string, moved:boolean}} moved=true 表示确实拆出了东西
 */
/**
 * 「真的脱下了」状态模式（v0.9.49 收紧）。
 *
 * ★★ 为什么不能把一切状态词都搬进 bare（用户实测病例，2026-09-30）：
 *   结城太太款式 `light blue knit sweater with a wide neckline slipped to one side, and a grey cotton long skirt.`
 *   在面板保存后变成 `and a grey cotton long skirt.` —— **整件针织衫凭空消失**。
 *   原因：`slipped to one side`（滑到一侧肩）命中旧状态词表，按逗号**整段搬运** ——
 *   「衣服 + 穿着状态」混写的片段整件蒸发，身上只剩"和一条灰棉长裙"。
 *   而 `slipped to one side` 是**还挂在身上**的穿着状态（滑肩 ≠ 脱下），
 *   它恰恰是款式描述的一部分，画面就该这么画。
 *
 * ★ 状态词分两类，归属完全不同：
 *   【仍穿着 · 留在 style】slipped to one side / off one shoulder / hanging open / undone /
 *     unbuttoned / unzipped / pushed up / hiked up / rucked up / bunched / askew / disheveled /
 *     loosened / untied / around her waist·hips·shoulders / half-off / open
 *     → 注入成「身穿 滑到一侧肩的针织衫」，画面正确，衣服不会消失。
 *       （这些是 NSFW 最重要的画面信息 —— 领口敞开、上衣堆到锁骨，全靠它立住。）
 *   【真脱下 · 搬进 bare】pulled/pushed/tugged/rolled down + around knees·ankles·thighs·feet /
 *     taken off / removed / discarded / on the floor / pooled / wadded / tangled
 *     → 衣服已经离开了该在的位置，款式里留着才会注入「身穿 褪到膝盖的裤子」这种自相矛盾。
 *   【裸露词 · 搬进 bare】bare / naked / nude / exposed / topless / bottomless
 *     → 出现在款式里说明混进了皮肤描写，归位。
 *
 * ⚠️ 判定从宽还是从严？**从严（少搬）**。搬错方向的代价不对称：
 *     该搬没搬 → 注入「身穿 褪到膝盖的裤子」轻微矛盾，画面仍有信息；
 *     不该搬搬了 → **整件衣服蒸发**，画面直接变装。
 */
const OUTFIT_OFF_HARD_RE = new RegExp([
  String.raw`\b(?:pulled|pushed|tugged|rolled|dragged|worked) down\b`,
  String.raw`\baround (?:his|her|their) (?:knees|ankles|calves|thighs|feet)\b`,
  String.raw`\b(?:taken off|taken|removed|discarded|stripped off|stripped|thrown (?:aside|off)|pooled (?:around|at)|on the floor|wadded|tangled|half[- ]?off)\b`,
].join('|'), 'i');

/**
 * 【裸露词 · 单列】（v0.9.81 从裸露词合并正则里拆出来单独判）
 *
 * bare / naked / nude / exposed / topless / bottomless。
 *
 * ★ v0.9.81 假阳性病例（第三次「词根剥离误伤」，与 thigh-high slit / cap sleeve 同类）：
 *   用户保存款式 `black glassy latex corset plunging deep that pushes up her huge bare breasts, …`
 *   → 该段含 `bare` → 整段被判成「皮肤描写」搬走 → **一件 corset 凭空蒸发**，
 *   且手动保存时裸露框恒有值（空串也算），拆出的片段被丢弃 —— 两边都没有，保存了个寂寞。
 *   全档案库的 NSFW 服装描述都爱写 bare shoulders / bare breasts / exposed cleavage，
 *   这类「**衣服 + 露出的效果**」是合法服装描述，画面就该这么画。
 *
 * → 裸露词命中时**再看片段里有没有服装名词**（GARMENT_RE）：
 *   有 → 「这件衣服露出那个部位」的描述，留在 style；
 *   没有 → 纯皮肤描写（`bare breasts fully exposed`），照旧归位 bare。
 * 「真脱下」动词类（OUTFIT_OFF_HARD_RE）不受此豁免 —— pulled down around knees
 * 这种明确离开了该在的位置，哪怕句子里有衣服名词也照搬。
 */
const OUTFIT_BARE_WORD_RE = /\b(?:bare|naked|nude|exposed|topless|bottomless)\b/i;

export function splitOutfitStyle(style) {
  const raw = String(style || '').trim();
  if (!raw) return { style: '', bare: '', moved: false };

  const parts = raw.split(',').map(x => x.trim()).filter(Boolean);
  const keep = [];
  const moved = [];
  for (const p of parts) {
    if (OUTFIT_OFF_HARD_RE.test(p)) { moved.push(p); continue; }
    // 裸露词 + 片段里有衣服 → 是"衣服露出的效果"，不是皮肤描写，留在款式里
    if (OUTFIT_BARE_WORD_RE.test(p) && !GARMENT_RE.test(p)) { moved.push(p); continue; }
    keep.push(p);
  }
  if (!moved.length) return { style: raw, bare: '', moved: false };
  // 全被拆走了 = 身上没衣服了，style 留空（由 bare 表达，注入侧有兜底）
  return { style: keep.join(', '), bare: moved.join(', '), moved: true };
}

/**
 * 这条描述里有没有**真正的衣服**（上身 / 下装 / 连身）。
 *
 * 只有鞋袜配饰、或只有 "clothes / 衣服 / 穿着" 这类泛称 → 不算。
 *
 * 为什么必须卡这一道：正文常常只写「塑料边缘在衣服上勒出声响」「他低头看自己洗得
 * 发白的球鞋」—— 模型据此"提取"出 `faded white sneakers, worn clothes` 就算交差了。
 * 这种描述一旦落库就会被款式闸门**永久锁死**（之后再也不改），男主从此每帧穿着
 * 一句废话出场。宁可不记（保持"未记录"、下轮再试、或提示用户手动设），也不能记垃圾。
 *
 * @param {string} style 英文 tag 串
 */
const GARMENT_RE = /(shirt|blouse|jacket|coat|pants|trousers|skirt|dress|uniform|sweater|hoodie|sweatshirt|suit|apron|kimono|shorts|jeans|leggings|robe|vest|swimsuit|bikini|jumpsuit|overalls|cardigan|t-shirt|tee|gown|nightgown|pajamas|tracksuit|windbreaker|parka|blazer|corset|bodysuit|lingerie|bra|panties|underwear|diaper|loincloth)/i;

/**
 * 单个服装名词表（用于判断"新款有没有凭空冒出新衣服"）。
 * 与 GARMENT_RE 同一口径，但按**单词**比对，不按类别。
 */
const GARMENT_WORDS = new Set([
  'shirt', 'blouse', 'jacket', 'coat', 'pants', 'trousers', 'skirt', 'dress', 'uniform',
  'sweater', 'hoodie', 'sweatshirt', 'suit', 'apron', 'kimono', 'shorts', 'jeans', 'leggings',
  'robe', 'vest', 'swimsuit', 'bikini', 'jumpsuit', 'overalls', 'cardigan', 't-shirt', 'tee',
  'gown', 'nightgown', 'pajamas', 'pyjamas', 'tracksuit', 'windbreaker', 'parka', 'blazer',
  'bodysuit', 'catsuit', 'bathrobe', 'slip', 'sundress', 'miniskirt', 'sweatpants',
  'loafers', 'sneakers', 'slippers', 'socks', 'tights', 'pantyhose', 'stockings', 'boots', 'heels',
]);

/**
 * 内衣类名词 —— 不计入"新增的衣服"。
 *
 * 脱衣描写里 `black lace bra` 这种往往是**露出来了**（本来就在身上、先前没写），
 * 不是"新穿上一件"。若把它当新增件，脱上衣那一楼就会被拒，旧款里的上衣又回到身上。
 */
const UNDER_WORDS = new Set([
  'bra', 'panties', 'underwear', 'lingerie', 'boxers', 'briefs', 'thong', 'corset',
]);

/**
 * 鞋袜 / 配饰类名词 —— 同样不计入"凭空多出来的衣服"（v0.9.52）。
 *
 * 为什么必须有：UNDER_WORDS 只豁免内衣，**鞋袜仍被当成一件正经衣服**。
 * 后果是脱衣那一楼，模型只要顺手提了一句鞋（`slippers / socks / heels / boots / loafers`），
 * `newGarmentWords` 就返回非空 → `undressing` 判定失败 →
 * 部件守恒闸门与覆盖率闸门**同时**拒绝 → **明明在脱，却被当成"偷换款式"，整楼作废**。
 *
 * 鞋袜的增减不代表"换了一身"（与内衣同口径，见下方"鞋袜丢了不致命"的既有注释），
 * 它的出现不该有能力作废一次真实的脱衣推进。
 *
 * ⚠️ 只影响"新增件"判定，不污染 garmentWordsOf（那边还要用于部件守恒的类别比对）。
 */
const MINOR_WORDS = new Set([
  // 鞋袜（含单复数两种写法：词元提取不做词形还原，两种都要列）
  'loafers', 'loafer', 'sneakers', 'sneaker', 'slippers', 'slipper', 'socks', 'sock',
  'tights', 'pantyhose', 'stockings', 'stocking', 'boots', 'boot', 'heels', 'heel',
  'shoes', 'shoe', 'sandals', 'sandal', 'flats', 'flat', 'pumps', 'pump', 'barefoot',
  // 配饰
  'glasses', 'sunglasses', 'gloves', 'glove', 'scarf', 'belt', 'hat', 'cap',
  'necklace', 'earrings', 'earring', 'bracelet', 'watch', 'bag',
]);

/** 这串描述里出现的所有服装名词（不含内衣类）。 */
export function garmentWordsOf(style) {
  const words = String(style || '').toLowerCase().match(/[a-z][a-z-]{2,}/g) || [];
  const out = new Set();
  for (const w of words) {
    if (UNDER_WORDS.has(w)) continue;
    if (GARMENT_WORDS.has(w)) out.add(w);
  }
  return out;
}

/**
 * 新款相对旧款**凭空多出来的衣服**（外衣/鞋袜，不含内衣）。
 *
 * 用途：区分"脱掉了几件"与"换成了别的"。
 *   `knit sweater, skirt` → `skirt`          ：没多出东西 = 脱掉了上衣 ✓
 *   `gauze slip dress`    → `leather catsuit`：多出 catsuit = 换了一身 ✗
 * 后者即使状态位在前进（真在脱）也必须走防漂移闸门 —— 脱衣只会让衣服变少，不会变多。
 *
 * ⚠️ 鞋袜 / 配饰（MINOR_WORDS）不算"新衣服"（v0.9.52）：
 *    脱衣描写顺手提一句 `slippers / socks` 是常态，若算新增件，`undressing` 会判成 false，
 *    两道闸门同时拒绝 → **明明在脱却被当成偷换款式，整楼作废**。详见 MINOR_WORDS 注释。
 *
 * @returns {string[]}
 */
export function newGarmentWords(oldStyle, newStyle) {
  const A = garmentWordsOf(oldStyle);
  const B = garmentWordsOf(newStyle);
  const out = [];
  for (const w of B) {
    if (A.has(w)) continue;
    if (MINOR_WORDS.has(w)) continue;
    out.push(w);
  }
  return out;
}

export function hasRealGarment(style) {
  return GARMENT_RE.test(String(style || ''));
}

/* ============ 服装件守恒（v0.9.48） ============ */

/**
 * ★ 为什么要有这一层（用户实测病例，2026-09-29）：
 *
 *   结城太太 r7 的款式是 `light blue knit sweater with a wide neckline, no bra, grey cotton long skirt`，
 *   r9 被写成 `black lace bra strap, grey cotton long skirt, pink cotton slippers, barefoot`
 *   —— **针织衫没了**，而剧情里根本没写她脱掉。
 *
 *   防漂移闸门为什么没拦住：覆盖率算法只算"旧款有多少元素被保留"，
 *   旧款 13 个词元里保留了 bra/grey/cotton/long/skirt 共 5 个 → 覆盖率 0.385，
 *   高于阈值 0.34 → 被判定成「同一套衣服写得更细了」→ **合法采纳**，针织衫就此消失。
 *
 *   也就是说：覆盖率能挡"重新描述一遍"，**挡不住"少写一件"**。
 *   少写一件恰好是覆盖率最擅长放过的形态（留下的都是交集）。
 *
 *   所以补一层**部件守恒**：按"衣服件"的类别比对，旧款有上装而新款没有 → 就是丢件，
 *   不看覆盖率。丢件只有在"这次真的脱了"（状态位前进）或显式换装 / 手动改写时才允许。
 */

/**
 * 主体件类别（上装 / 下装 / 连身）。
 * ⚠️ 刻意不含外套（jacket / coat）：外套穿脱太频繁，且它不影响"身上有没有衣服"的观感，
 *    纳入拦截只会制造噪声。也不含内衣与鞋袜 —— 内衣由 bare 那一半表达，鞋袜丢了不致命。
 * ⚠️ 顺序 = 归类优先级（一个片段只归一类）：full 优先，避免
 *    `school uniform blouse` 同时算 top 和 full、导致新款写 `blouse, skirt` 时被误判丢件。
 */
const PIECE_GROUPS = [
  {
    key: 'full',
    label: '连身/套装',
    re: /\b(dress|gown|nightgown|jumpsuit|overalls|playsuit|onesie|kimono|qipao|cheongsam|yukata|robe|pajamas|pyjamas|tracksuit|swimsuit|bikini|suit|uniform|sundress|slip)\b/,
  },
  {
    key: 'top',
    label: '上装',
    re: /\b(shirt|blouse|t-shirt|tee|sweater|jumper|pullover|hoodie|sweatshirt|cardigan|camisole|cami|tank|vest|corset|bodysuit|top|jersey|tunic|sweater vest)\b/,
  },
  {
    key: 'bottom',
    label: '下装',
    re: /\b(skirt|miniskirt|pants|trousers|shorts|jeans|leggings|sweatpants|culottes|chinos|slacks)\b/,
  },
];

/** 把服装串按逗号切成片段，并归到主体件类别（一个片段只归一类）。 */
function groupPieces(style) {
  const items = String(style || '').split(/[,，;；]/).map(x => x.trim()).filter(Boolean);
  const map = new Map();
  for (const it of items) {
    const low = it.toLowerCase();
    for (const g of PIECE_GROUPS) {
      if (g.re.test(low)) {
        if (!map.has(g.key)) map.set(g.key, []);
        map.get(g.key).push(it);
        break;
      }
    }
  }
  return map;
}

/**
 * 新款相对旧款**丢了哪些件**。
 *
 * @param {string} oldStyle
 * @param {string} newStyle
 * @returns {{keys:string[], items:string[], labels:string[]}}
 *   keys = 丢失的类别（top / bottom / full）；items = 被丢掉的具体片段原文（用于告警）
 */
export function missingGarmentPieces(oldStyle, newStyle) {
  const A = groupPieces(oldStyle);
  const B = groupPieces(newStyle);
  const empty = { keys: [], items: [], labels: [] };
  if (!A.size) return empty; // 旧款没记主体件 → 不构成"丢件"判定的基线

  let keys = [];
  if (!B.size) {
    // 新款一个主体件都没有：只写了内衣/鞋袜 → 旧款的主体件全部算丢
    keys = Array.from(A.keys());
  } else if (B.has('full')) {
    // 新款是连身款（连衣裙 / 制服 / 睡衣）→ 视作涵盖上装与下装，不判丢件
    keys = [];
  } else {
    for (const k of ['top', 'bottom']) if (A.has(k) && !B.has(k)) keys.push(k);
    // 旧款是连身款、新款却没有：只有当新款同时写了上装+下装时才算"拆开描述"，否则算丢
    if (A.has('full') && !B.has('full') && !(B.has('top') && B.has('bottom'))) keys.push('full');
  }
  if (!keys.length) return empty;

  const items = [];
  for (const k of keys) items.push(...(A.get(k) || []));
  const labels = keys.map(k => (PIECE_GROUPS.find(g => g.key === k) || {}).label || k);
  return { keys, items, labels };
}

/**
 * 从**未清洗**的原文里捞服装线索 —— 包括 `[metacognition]` 这类元认知块。
 *
 * ★ 这是「女角色有服装、男主没有」的头号成因：
 *   主模型习惯把「谁穿什么」写在元认知块里 ——
 *     `- 角色穿着物理验算：结城太太穿着粉色居家服，周雅穿着灰色亚麻围裙，夜斗穿着牛仔裤。`
 *   而 `cleanBody()` 会把 `[metacognition]…` 整块当噪声删掉（META_RE）。
 *   结果：围裙因为在**正文本体**里也反复出现，清洗后还在 → 抓得到；
 *   男主的牛仔裤只写在元认知块里 → 清洗后消失 → 永远抓不到。
 *
 * 所以扫描器要另看一份**原文**摘录。这里只捞含服装词的行，不进主分析
 * （主分析的 P 编号依赖行结构，动它会让图插错位置）。
 *
 * @param {string} rawText 原始楼层文本
 * @param {number} [maxLines] 最多捞几行（防爆 token）
 */
const CLUE_RE = /(穿(着|上|了)?|套着|裹着|换(上|了|成)|脱(下|掉|了)?|校服|制服|衬衫|外套|裙子|短裙|连衣裙|T恤|卫衣|西装|领带|领结|丝袜|裤|鞋|靴|内衣|胸罩|内裤|泳衣|围裙|护士服|家居服|睡衣|居家服|常服|真空|赤裸|裸)/;

export function outfitCluesFrom(rawText, maxLines = 24) {
  const lines = String(rawText || '').split(/\r?\n/);
  const out = [];
  for (const l of lines) {
    const t = l.trim();
    // 超长行多半是整段正文（不是"某某穿着…"这类线索句），跳过省 token
    if (!t || t.length > 300) continue;
    if (!CLUE_RE.test(t)) continue;
    out.push(t);
    if (out.length >= maxLines) break;
  }
  return out.join('\n');
}

/* ============ 头像裁剪的坐标换算（2026-09-26） ============ */

/**
 * contain 布局：把 w×h 等比塞进 boxW×boxH，返回实际显示尺寸和居中偏移。
 * 裁剪器要用它算"图片在舞台里的真实位置"（两侧留白不能算进裁剪区）。
 */
export function fitContain(w, h, boxW, boxH) {
  const iw = Math.max(1, Number(w) || 1);
  const ih = Math.max(1, Number(h) || 1);
  const bw = Math.max(1, Number(boxW) || 1);
  const bh = Math.max(1, Number(boxH) || 1);
  const scale = Math.min(bw / iw, bh / ih);
  const dw = iw * scale;
  const dh = ih * scale;
  return { scale, dw, dh, ox: (bw - dw) / 2, oy: (bh - dh) / 2 };
}

const clamp01 = (n) => Math.min(1, Math.max(0, Number(n) || 0));

/**
 * 把"图片显示矩形里的裁剪框（比例 0~1）"换算成原图像素坐标。
 *
 * 为什么用比例而不是像素：窗口大小变了、图片换了分辨率，裁剪意图不该跟着变；
 * 比例坐标也让这套换算能在 Node 里单测（不需要 canvas）。
 *
 * @param {{x:number,y:number,w:number,h:number}} crop 相对**图片显示矩形**的比例
 * @param {number} imgW 原图宽
 * @param {number} imgH 原图高
 * @returns {{sx:number,sy:number,sw:number,sh:number}} 原图像素坐标（已夹在图内）
 */
export function mapCropRect(crop, imgW, imgH) {
  const w = Math.max(1, Number(imgW) || 1);
  const h = Math.max(1, Number(imgH) || 1);
  const MIN = 0.05;
  const cw = Math.min(1, Math.max(MIN, clamp01(crop?.w)));
  const chh = Math.min(1, Math.max(MIN, clamp01(crop?.h)));
  const x = Math.min(1 - cw, clamp01(crop?.x));
  const y = Math.min(1 - chh, clamp01(crop?.y));
  return {
    sx: Math.round(x * w),
    sy: Math.round(y * h),
    sw: Math.max(1, Math.round(cw * w)),
    sh: Math.max(1, Math.round(chh * h)),
  };
}

/** 裁剪结果的输出尺寸：等比缩进 max 边长的方框里（头像不需要原图那么大）。 */
export function cropOutputSize(sw, sh, max = 288) {
  const cap = Math.max(32, Number(max) || 288);
  const scale = Math.min(1, cap / Math.max(Number(sw) || 1, Number(sh) || 1));
  return {
    w: Math.max(1, Math.round((Number(sw) || 1) * scale)),
    h: Math.max(1, Math.round((Number(sh) || 1) * scale)),
  };
}

/* ============ 锚点字段归一化（2026-09-26） ============ */

/** 穿戴物件类词 —— 它们是「标志特征 mark」，不是脸型/眼睛/发型。 */
const ACCESSORY_RE = /\b(glasses|spectacles|monocle|sunglasses|goggles|eyepatch|eye\s+patch|blindfold|hat|beret|cap\b|headset|headphones|earphones|mask|veil|coif|hood)\b/i;

/** 纯瞳色值（如 "brown eyes"）—— 出现在 hair 字段时整体搬去 eyes。 */
const EYES_ONLY_RE = /^(?:(?:dark|light|deep|bright)?\s*(?:brown|blue|green|red|golden|amber|grey|gray|hazel|purple|violet|pink|black|white|aqua|crimson))?\s*eyes$/i;

/** hair 里只要出现这些就算真的在写发型（不必搬走）。 */
const HAIR_HINT_RE = /\b(hair|bangs|ponytail|braid|twintails|bun|bob|cut|curl|wavy|straight|long|short|midlength|shoulder.length|blonde|brunette|black hair|brown hair|white hair|silver hair|red hair|blue hair|pink hair|dyed|highlight)\b/i;

/**
 * 修正建档/分析模型放错位的锚点值（实测案例：眼镜进了 face、瞳色进了 hair）。
 * 只搬运、不删改 —— 返回新对象，不动入参。搬动了什么会放到返回值的 moved 里。
 *
 * @param {object} fields 任意来源的锚点字段（会忽略非字符串值）
 * @returns {{ fields: object, moved: string[] }}
 */
export function normalizeAnchorFields(fields) {
  const out = { ...(fields || {}) };
  const moved = [];
  const bump = (v) => {
    const cur = String(out.mark || '').trim();
    const has = cur.toLowerCase().includes(String(v).toLowerCase());
    out.mark = has ? cur : (cur ? `${cur}, ${v}` : v);
  };

  for (const k of ['face', 'eyes', 'hair', 'skin', 'body']) {
    const v = String(out[k] || '').trim();
    if (!v) continue;
    if (ACCESSORY_RE.test(v)) {
      bump(v);
      out[k] = '';
      moved.push(`${k}→mark: ${v}`);
    }
  }

  const hair = String(out.hair || '').trim();
  if (hair && !HAIR_HINT_RE.test(hair) && EYES_ONLY_RE.test(hair)) {
    const curEyes = String(out.eyes || '').trim();
    if (!curEyes) out.eyes = hair;
    else if (!curEyes.toLowerCase().includes(hair.toLowerCase())) out.eyes = `${curEyes}, ${hair}`;
    out.hair = '';
    moved.push(`hair→eyes: ${hair}`);
  }

  // 清掉搬运后留下的空串
  for (const k of Object.keys(out)) {
    if (out[k] === '' || out[k] == null) delete out[k];
  }
  return { fields: out, moved };
}


/* ==========================================================================
 * v0.9.66 —— 角色名归一化（<user> 分裂条目根治的第一层）
 *
 * 以前 store.js 与 consistency.js 各写了一套宏正则（一套只认 <user>/<persona>，
 * 另一套多认 <bot>/<char>），两套不一致 = 名字判定漂移的源头之一。
 * 现在全库只有这里一份，两边都从 util 取。
 * ========================================================================== */

/** 酒馆宏壳：<user> / {{user}} / [user] —— 只要出现就说明这不是真名。 */
const MACRO_NAME_RE = /<[^<>]{1,32}>|\{\{[^}]{1,32}\}\}|^\[[^\[\]]{1,32}\]$/;

/** 宏壳里表示「用户本人 / 主角（persona）」的词。 */
const MACRO_SELF_WORDS = /^(user|persona|you|your|me|i|我|玩家|主角|本人)$/i;
/** 宏壳里表示「当前角色卡 / AI 侧」的词。 */
const MACRO_CHAR_WORDS = /^(char|bot|character|assistant|ai|system|model|角色|助手)$/i;

/**
 * 名字是不是宏 / 占位符（不能拿来建档）。
 * @param {string} name
 * @returns {boolean}
 */
export function isMacroName(name) {
  const t = String(name ?? '').trim();
  if (!t) return true;
  return MACRO_NAME_RE.test(t);
}

/**
 * 剥掉宏壳，取出里面的词。<user> → user；{{user}} → user；周雅 → 周雅。
 * @param {string} name
 * @returns {string} 剥壳后的核心词；原样返回非宏名
 */
export function macroCore(name) {
  const t = String(name ?? '').trim();
  const m = t.match(/^<([^<>]{1,32})>$/) || t.match(/^\{\{([^}]{1,32})\}\}$/) || t.match(/^\[([^\[\]]{1,32})\]$/);
  return m ? String(m[1]).trim() : t;
}

/**
 * 把「宏名」归类到两条通道之一。
 *
 * ⚠️ 主角（用户设定 persona）与 角色卡角色是**两个不同来源**，必须分开：
 *    - <user> / <persona>  → 'self'（主角，真名取 ctx.name1）
 *    - <bot> / <char>      → 'char'（角色卡，真名取 ctx.name2）
 *
 * @param {string} name
 * @returns {'self'|'char'|null} null = 不是宏名，无需归类
 */
export function macroChannel(name) {
  const t = String(name ?? '').trim();
  if (!isMacroName(t)) return null;
  const core = macroCore(t);
  if (MACRO_SELF_WORDS.test(core)) return 'self';
  if (MACRO_CHAR_WORDS.test(core)) return 'char';
  return null;
}
