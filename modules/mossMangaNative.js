/**
 * 漫画台原生口径（照搬 AINIMA 漫画台）。
 *
 * 用户要求（2026-11-01）：「这 2 个模版采用原生 AINIMA 漫画台的模版方式出图，
 * **先不改他的提示词手法**，我需要原汁原味，就和我单独使用漫画台时出图质量一样，
 * 相当于照搬迁移到绘灵，因为我发现他真的很稳。」
 *
 * ⇒ 所以本文件里的每一句英文（`phrase` / `SNIPPETS` / 收尾约束）都**逐字照抄**，
 *   一个字都不许改、不许"优化措辞"。改一个词就不是"原汁原味"了。
 *
 * 来源（只读参考，运行时不依赖）：
 *   C:/ComfyUI_CJ/AINIMA漫画台/config/manga.mjs      —— 词表 / 句子模板 / buildSummary
 *   C:/ComfyUI_CJ/AINIMA漫画台/core/compile.mjs      —— items → Moss doc 的 walker
 *   C:/ComfyUI_CJ/AINIMA漫画台/core/manga-doc.mjs    —— toMoss 坐标换算
 *
 * 与漫画台唯一的差别：**不读项目存档**。漫画台的 `project.characters` 由人维护，
 * 这里改成由调用方传 `resolveCharacter(ref)` —— 绘灵拿角色档案的静态锚点填。
 *
 * 产物形状与漫画台完全一致：
 *   { summary:{meta,canvas,caption}, items:[{label,caption,bbox,text?,tags?,palette?}],
 *     bbox_coord_space:'abs_centralized', bbox_format:'yxyx' }
 */

const pick = (list, value) => list.find((o) => o.value === value) || null;
const fill = (tpl, vars = {}) =>
  String(tpl || '').replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? String(vars[k]) : m));

/* ---------------------------------------------------------------- 词表（逐字照抄） */

export const SHAPES = [
  { value: 'rect', label: '矩形', phrase: 'rectangular panel' },
  { value: 'slant-top', label: '斜切上边', phrase: 'panel with a slanted top edge' },
  { value: 'slant-side', label: '斜切侧边', phrase: 'panel with a slanted side edge' },
  { value: 'bleed-top', label: '出血·上', phrase: 'panel bleeding off the top edge, no border', bleed: true },
  { value: 'bleed-bottom', label: '出血·下', phrase: 'panel bleeding off the bottom edge, no border', bleed: true },
  { value: 'bleed-left', label: '出血·左', phrase: 'panel bleeding off the left edge, no border', bleed: true },
  { value: 'bleed-right', label: '出血·右', phrase: 'panel bleeding off the right edge, no border', bleed: true },
  { value: 'bleed-all', label: '满版', phrase: 'full-bleed panel, no border', bleed: true },
  { value: 'circle', label: '圆形', phrase: 'circular panel' },
];

export const FRAMES = [
  { value: 'border', label: '描边', phrase: 'crisp black panel border' },
  { value: 'none', label: '无边', phrase: 'no border' },
  { value: 'thick', label: '粗边', phrase: 'heavy black panel border' },
];

export const CAMERAS = [
  { value: 'eye', label: '平视', phrase: 'eye-level shot' },
  { value: 'high', label: '俯视', phrase: 'high-angle shot looking down' },
  { value: 'low', label: '仰视', phrase: 'low-angle shot looking up' },
  { value: 'wide', label: '全景', phrase: 'wide establishing shot' },
  { value: 'medium', label: '中景', phrase: 'medium shot' },
  { value: 'close', label: '特写', phrase: 'close-up' },
  { value: 'xclose', label: '大特写', phrase: 'extreme close-up' },
  { value: 'ots', label: '过肩', phrase: 'over-the-shoulder shot' },
  { value: 'dutch', label: '荷兰角', phrase: 'dutch angle with a tilted horizon' },
];

export const STYLES = [
  {
    value: 'mono',
    label: '黑白网点',
    meta: ['comic', 'multi_panel', 'digital_painting', 'monochrome'],
    phrase: 'High-taste, black and white vertical 2D manga comic, black ink on white paper, grey screentone dots only, zero colour.',
  },
  {
    value: 'color',
    label: '彩色',
    meta: ['comic', 'multi_panel', 'digital_painting', 'full color'],
    phrase: 'High-taste, fully colored vertical 2D digital painting comic, clean ink lineart with soft muted colouring.',
  },
  {
    value: 'sketch',
    label: '线稿',
    meta: ['comic', 'multi_panel', 'digital_painting', 'monochrome'],
    phrase: 'High-taste, vertical 2D manga lineart, black ink lines only on white paper, no tone, no colour.',
  },
];

export const BUBBLES = [
  { value: 'speech', label: '对话', phrase: 'white oval speech bubble, thin black outline' },
  { value: 'speech-notail', label: '对话·无指向', phrase: 'white oval speech bubble, thin black outline, no tail, no point, round bubbles' },
  { value: 'shout', label: '喊叫', phrase: 'jagged spiky speech bubble' },
  { value: 'whisper', label: '小声', phrase: 'small round white speech bubble, tail of tiny circles' },
  { value: 'tremble', label: '颤抖', phrase: 'white speech bubble with a shaky wavy outline' },
  { value: 'thought', label: '内心', phrase: 'white cloud-shaped thought bubble, scalloped edge' },
  { value: 'heart', label: '心之声', phrase: 'speech bubble with a dashed outline' },
  { value: 'narration', label: '旁白·白框', phrase: 'narration in a plain white rectangular box with a thin black border' },
  { value: 'narration-bare', label: '旁白·裸字', phrase: 'narration printed directly on the artwork, no box, thin white outline' },
  { value: 'sfx', label: '拟声词', phrase: 'hand-lettered sound effect, bold brush strokes, no bubble' },
];

export const MOSS_LABELS = ['object', 'character', 'text'];

export const SNIPPETS = {
  panelCount: 'The page is divided into {n} {panels}. {order}',
  readingOrder: 'Panels are read RIGHT TO LEFT, top to bottom.',
  textLock:
    'This page has exactly {panels} panel(s) and exactly {texts} text element(s). Render ONLY the text listed below, with the exact wording given. Do NOT invent any additional dialogue, speech bubble, caption, sound effect or lettering, and do not fill empty space with text — any text that is not listed is an error.',
  bubbleRule:
    'Dialogue uses white speech bubbles with tails, thoughts use white cloud bubbles with no tail, and narration sits in a small plain white rectangular caption box. Every bubble and caption box stays INSIDE one panel and never crosses a panel border.',
  noLettering:
    'This page contains NO lettering at all: no speech bubbles, no captions, no sound effects, no text of any kind.',
};

/* ---------------------------------------------------------------- 坐标 */

/** 左上原点像素 → 中心化 yxyx（与漫画台 core/manga-doc.mjs 逐行一致） */
export function toMoss(bbox, size) {
  const [x1, y1, x2, y2] = bbox;
  const dx = size.width / 2;
  const dy = size.height / 2;
  const l = Math.floor(Math.min(x1, x2));
  const t = Math.floor(Math.min(y1, y2));
  const r = Math.ceil(Math.max(x1, x2));
  const b = Math.ceil(Math.max(y1, y2));
  return [t - dy, l - dx, b - dy, r - dx];
}

export function normalizeBbox(bbox, size) {
  if (!Array.isArray(bbox) || bbox.length !== 4) return [0, 0, size.width, size.height];
  const n = bbox.map((v) => (Number.isFinite(Number(v)) ? Number(v) : 0));
  return [Math.min(n[0], n[2]), Math.min(n[1], n[3]), Math.max(n[0], n[2]), Math.max(n[1], n[3])];
}

/* ---------------------------------------------------------------- 辅助（照抄） */

const PANEL_KEYS = new Set(['panel']);
const panelsOf = (page) => (page.items || []).filter((it) => PANEL_KEYS.has(it.type));

function textLayoutOf(page, item) {
  const vertical = typeof item.vertical === 'boolean' ? item.vertical : page.vertical !== false;
  return vertical ? 'vertical lettering, columns read right to left' : 'horizontal lettering';
}

const bubblePhrase = (b) => (pick(BUBBLES, b.kind) || pick(BUBBLES, 'speech')).phrase;
const styleOf = (page) => pick(STYLES, page.style) || pick(STYLES, 'mono');

/* ---------------------------------------------------------------- item 编译（逐字照抄） */

function compileItem(item, page, resolveCharacter) {
  switch (item.type) {
    case 'panel': {
      const shape = pick(SHAPES, item.shape);
      const parts = [shape?.phrase];
      if (!shape?.bleed) parts.push(pick(FRAMES, item.frame)?.phrase);
      if (item.camera) parts.push(pick(CAMERAS, item.camera)?.phrase);
      const body = (item.desc || '').trim();
      if (body) parts.push(body);
      return { label: 'object', caption: parts.filter(Boolean).join(', ') };
    }
    case 'character': {
      const body = String(item.desc || '').replace(/^!/, '').trim().replace(/[.。]+$/, '');
      if (!item.ref || !body) return null;
      return { label: 'character', caption: `${body}.` };
    }
    case 'bubble': {
      const parts = [bubblePhrase(item)];
      if (item.desc) parts.push(String(item.desc));
      parts.push(textLayoutOf(page, item));
      return {
        label: 'text',
        caption: parts.filter(Boolean).join(', '),
        ...(item.text ? { text: item.text } : {}),
      };
    }
    case 'native': {
      return {
        label: item.label || 'object',
        caption: item.caption || '',
        ...(item.text ? { text: item.text } : {}),
      };
    }
    default:
      return null;
  }
}

/** summary 角色表里的一行：名字 + 外貌 */
function castLine(item, resolveCharacter) {
  const c = resolveCharacter ? resolveCharacter(item.ref) : null;
  return { name: c?.name || item.ref || 'character', text: String(c?.look || '').trim() };
}

/**
 * 整页 summary（与漫画台 `buildSummary` 同一顺序）：
 * 画风 → 格数 → 文字锁 → scene → note → 角色表。
 * `summaryCaption` 非空 = 整段覆盖（连角色表都不追加），这是漫画台的既有语义。
 */
export function buildSummary({ page, items, resolveCharacter }) {
  const style = styleOf(page);
  const panels = panelsOf(page);
  const texts = items.filter((it) => it.label === 'text');
  const parts = [style.phrase];

  if (panels.length > 0) {
    parts.push(fill(SNIPPETS.panelCount, {
      n: panels.length,
      panels: panels.length === 1 ? 'panel' : 'panels',
      order: SNIPPETS.readingOrder,
    }));
  }

  if (texts.length > 0) {
    parts.push(fill(SNIPPETS.textLock, { panels: panels.length, texts: texts.length }));
    parts.push(SNIPPETS.bubbleRule);
  } else {
    parts.push(SNIPPETS.noLettering);
  }

  if (page.scene) parts.push(page.scene);
  if (page.note) parts.push(page.note);

  const cast = [];
  const seen = new Set();
  for (const item of page.items || []) {
    if (item.type !== 'character' || !item.ref || seen.has(item.ref)) continue;
    if (String(item.desc || '').trim().startsWith('!')) continue;
    seen.add(item.ref);
    cast.push(castLine(item, resolveCharacter));
  }
  const castBlock = cast.length
    ? `<|character_list|>\nCHARACTERS IN THIS PAGE (each one appears only inside its own box):\n${cast
      .map((c) => `- ${c.name}${c.text ? `: ${c.text}` : ''}`)
      .join('\n')}\n<|/character_list|>`
    : '';
  if (castBlock) parts.push(castBlock);

  const meta = Array.isArray(page.summaryMeta) && page.summaryMeta.length ? page.summaryMeta : style.meta;
  const override = String(page.summaryCaption || '').trim();

  return {
    meta,
    canvas: panels.length > 1 || texts.length > 1 ? 'multi_panel' : 'single',
    caption: override || parts.filter(Boolean).join('\n\n'),
  };
}

/* ---------------------------------------------------------------- 入口 */

/**
 * page JSON → 可直接提交的 Moss doc。
 *
 * @param {object} page   模型给的页面（漫画台 page.json 结构）
 * @param {object} opt    { width, height, resolveCharacter(ref) -> {name, look} }
 * @returns {{ok:boolean, doc?:object, json?:string, errors:string[], warnings:string[], stats?:object}}
 */
export function compileMangaPage(page, opt = {}) {
  const errors = [];
  const warnings = [];
  const W = Math.round(Number(opt.width) || 0);
  const H = Math.round(Number(opt.height) || 0);
  const size = { width: W, height: H };
  if (!W || !H) errors.push('画布尺寸未知 —— 调用方必须先算好 W/H（坐标全靠它换算）');
  if (!page || typeof page !== 'object') return { ok: false, errors: ['页面 JSON 不是对象'], warnings };

  const items = [];
  for (const item of page.items || []) {
    const compiled = compileItem(item, page, opt.resolveCharacter);
    if (!compiled) {
      // 漫画台的语义：这一项还不完整（角色项没 ref / 没 desc）→ 跳过，不报错
      warnings.push(`${item?.type || 'item'} ${item?.id || ''} 缺必填字段，已跳过`);
      continue;
    }
    const override = String(item.caption || '').trim();
    const bbox = normalizeBbox(item.bbox, size);
    if (bbox[0] < 0 || bbox[1] < 0 || bbox[2] > W || bbox[3] > H) {
      // 漫画台：非出血形状越界只是警告（会被裁），不出错
      const shape = pick(SHAPES, item.shape);
      if (!shape?.bleed) warnings.push(`${item?.type || 'item'} ${item?.id || ''} 的 bbox 越界，会被裁`);
    }
    const out = {
      label: item.label || compiled.label,
      caption: override || compiled.caption,
      bbox: toMoss(bbox, size),
    };
    if (compiled.text) out.text = compiled.text;
    if (Array.isArray(item.tags) && item.tags.length) out.tags = item.tags;
    if (Array.isArray(item.palette) && item.palette.length) out.palette = item.palette;
    items.push(out);
  }

  if (!items.length) errors.push('一个 item 都没有 —— 这张图不出（重跑一次通常就好）');

  const doc = {
    summary: buildSummary({ page, items, resolveCharacter: opt.resolveCharacter }),
    items,
    bbox_coord_space: 'abs_centralized',
    bbox_format: 'yxyx',
  };
  const json = JSON.stringify(doc);

  return {
    ok: errors.length === 0,
    doc,
    json,
    errors,
    warnings,
    stats: {
      items: items.length,
      chars: items.filter((i) => i.label === 'character').length,
      texts: items.filter((i) => i.label === 'text').length,
      bytes: new TextEncoder().encode(json).length,
    },
  };
}


/* ---------------------------------------------------------------- 形态指令 */

/**
 * 漫画台口径的「本次出图形态」指令。
 *
 * 为什么单独一段、不并进 spec：画布 W×H 每次可能变（分辨率选择器），
 * 而 spec 是用户可编辑的静态文本 —— 写死进 spec 就跟着设置跑不动。
 * 这条与绘灵其它形态指令同一条纪律（见 `buildMossSingleJsonDirective` 开头）。
 *
 * 措辞依据：漫画台 `references/FORMAT.md` §2/§3/§4/§5/§8（字段与坐标规则）、
 * `TECHNIQUES.md`「页面提示词的结构」。**只讲格式，不讲怎么画得好** ——
 * 那是 spec 的事，两边不要互相扩散。
 */
export function buildMangaDirective({ width, height, mode } = {}) {
  const W = Math.round(Number(width) || 0);
  const H = Math.round(Number(height) || 0);
  const single = mode === 'single';
  const lines = ['', '---', '', '## 本次出图的形态与画布（插件设置，优先于上文；冲突时以本节为准）', ''];

  lines.push(
    `**画布尺寸：${W} x ${H} 像素**（每次出图可能不同，坐标一律按这一次的数字算）`,
    '',
    '- 输出**一份 page JSON**（漫画台页面），形如：',
    '  `{"style":"color","vertical":false,"scene":"…","characters":[…],"items":[…]}`',
    '- ★★★ **每个 item 都必须带 `bbox`**：`[x1, y1, x2, y2]`，**左上角原点 + 绝对像素整数**。',
    `  合法范围：\`0 <= x1 < x2 <= ${W}\`、\`0 <= y1 < y2 <= ${H}\`，四边留 8~16px 安全边。`,
    '- 🚫 **不要写中心化坐标、不要写 yxyx、不要归一化到 0~1** —— 那是编译器的活，你只管左上原点像素。',
    '',
    '**四种 item（`type`）**：',
    '',
    '| type | 必填 | 说明 |',
    '| --- | --- | --- |',
    '| `panel` | `bbox` `desc` | 一格。`desc` 开头自己写 `PANEL ONE,` 再加方位与横竖，最后写画面。`shape`（`rect`/`bleed-*`/`circle`…）、`frame`（`border`/`none`/`thick`）、`camera`（`eye`/`high`/`low`/`wide`/`medium`/`close`/`xclose`/`ots`/`dutch`）可选 |',
    '| `character` | `bbox` `ref` `desc` | 一个人。`desc` 写全：`编号 + 名字 + 位置 + 姿势`，开头带 `PANEL ONE` 说明在哪一格。**外貌绝不写在这里** |',
    '| `bubble` | `bbox` `text` | 一句文字。`text` 是**要渲染的原话**；`desc` 只写「在哪 + 谁说」，形如 `in the TOP LEFT of PANEL ONE, SPOKEN BY CHARACTER ONE - 影` |',
    '| `native` | `bbox` | 逃生口：直接写 `label`（`object`/`character`/`text`）+ `caption` |',
    '',
    '**`characters` 数组（本页角色表，外貌只在这里出现一次）**：',
    '```json',
    '{"id":"zero","name":"CHARACTER ONE - 影","look":"20-year-old man, short black hair, white shirt"}',
    '```',
    '- `name` 必须是 `角色 N - 名字` 这个格式；`id` 是 ASCII，`character.ref` 用它。',
    '- `look` 留空 = 插件从角色档案自动填（推荐留空 —— 档案里的锚点跨楼一致）。',
    '',
  );

  if (single) {
    lines.push(
      '**形态：单图（整页只有一张画）**',
      '',
      '- `items` 里**只有一个 `panel`**，铺满整页：`[8, 8, ' + (W - 8) + ', ' + (H - 8) + ']`，'
      + '**不要**拆格、不要建第二个 panel。',
      '- 没有对白 → 不建 `bubble` 项（整页将带 `no lettering` 约束）。',
      '- 有对白 → 每句一个 `bubble` 项，`bbox` 做成**窄而高**贴在画面空处，不要压在脸上。',
      '- `style`：`mono` 黑白网点 / `color` 彩色 / `sketch` 线稿。',
    );
  } else {
    lines.push(
      '**形态：多格漫画（一页 2 格以上）**',
      '',
      '- 每个格子一个 `panel` 项，`bbox` 按你排的版面写；**格与格之间必须留 10~20px 的缝**。',
      '- 每格里的 `character` / `bubble` 的 `bbox` **必须落在它所属那一格的框内**（可以留 20~40px 余量）。',
      '- 阅读顺序：**右到左、上到下**（编译器会在 summary 里声明，你排的时候也照这个来）。',
      '- `style`：`mono` 黑白网点 / `color` 彩色 / `sketch` 线稿。',
    );
  }

  lines.push(
    '',
    '- ★ **`note` 一律写中文**（说明这一格在干什么），它不进提示词，只给人看。',
    '- ★ **`summaryCaption` 保持空** —— 填了它会整段覆盖 summary，格数/文字锁/角色表全部失效。',
  );

  return lines.join('\n');
}
