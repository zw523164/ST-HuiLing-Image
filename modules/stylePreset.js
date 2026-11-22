/**
 * 画风（Style）—— 覆盖模版示例里那句写死的画风。
 *
 * ══ 为什么需要这一层 ══
 *
 * 用户 2026-10-31 问：「这个画风设定是谁写的？这玩意是固定的吗？假如我想出写实的该怎么办？」
 *
 * 答案：**是插件出厂模版教的，不是 MOSS 硬性规定的。**
 *   · MOSS 官方 USERGUIDE 里 `meta` 只是 JSON 的一个字段（示例 `"meta": ["poster"]`），
 *     官方没有任何「必须是 anime」的要求；它是基座模型，画风完全由提示词决定。
 *   · 真正写死的是模版 `## MOSS 单图口径补充` 里的**两条示例**：
 *       1. `"meta": ["anime", "digital illustration"],`
 *       2. `1. **画风**（整图只写一次）：\`Clean anime line art, cinematic lighting…\``
 *     写词模型是照抄示例的（实测输出首句逐字就是 `Clean anime line art with cinematic dusk lighting.`），
 *     所以只要示例写着 anime，出图永远是动漫线稿。
 *
 * ══ 为什么用「运行时替换」而不是改模版默认值 ══
 *   模版文本是用户可编辑、且**已经存进他配置里的**（`config.templates[...]`）。
 *   改 `settings.js` 里的默认值只影响**新装用户**，老用户那份永远不会更新 ——
 *   要更新就得写迁移，而迁移会覆盖用户自己改过的模版文本（更危险）。
 *   运行时替换只在读出来的那一刻生效：用户模版一个字不动，升级即生效。
 *
 * ══ 为什么只替换这两处、不追加 ══
 *   「两条规则互相抵消时模型只挑一条听」——如果示例说 anime、后面再补一句「要写实」，
 *   模型会随机挑一条，出图一半动漫一半写实，比不写真话更难查。
 *   必须**分叉彻底**：把示例本身换掉，新规则不出现第二处。
 *
 * @module stylePreset
 */

/**
 * ★ 刻意**不 import settings.js**。
 *   `getActiveTemplate`（在 settings.js 里）要调本模块的 `applyStylePreset`，
 *   本模块再反向 import `getConfig` 就成环了 —— ESM 的循环依赖在这里恰好能用，
 *   但只要哪天有人在模块顶层读 `getConfig()` 就会踩 TDZ，排查成本极高。
 *   改成 cfg 必传，零依赖。
 */

/**
 * 出厂预设。
 *
 * ★ 只给「画风句 + meta 标签」两样，**不给采样参数、不给负面词** ——
 *   那两样是用户主权（见长期约定：采样参数属后端工作流，与提示词零关联）。
 *
 * ★ `line` 会被原样塞进 caption 的第一句，所以要写成**能直接接场景句的短语**，
 *   不要写成一整句（后面还会接 `A narrow school equipment storage room…`）。
 */
export const STYLE_PRESETS = [
  {
    id: 'anime',
    label: '动漫线稿（出厂默认）',
    line: 'Clean anime line art, cinematic lighting',
    meta: ['anime', 'digital illustration'],
  },
  {
    id: 'real-cinema',
    label: '写实 · 电影感',
    line: 'Photorealistic cinematic film still, natural skin texture with visible pores, soft volumetric light, subtle film grain',
    meta: ['photorealistic', 'cinematic still'],
  },
  {
    id: 'real-photo',
    label: '写实 · 摄影写真',
    line: 'Photorealistic photograph, editorial portrait lighting, shallow depth of field, natural skin texture and fine hair strands',
    meta: ['photorealistic', 'photograph'],
  },
  {
    id: 'semi-real',
    label: '半写实 · 厚涂插画',
    line: 'Semi-realistic painterly digital art, detailed rendering, soft rim light, realistic proportions',
    meta: ['semi-realistic', 'digital painting'],
  },
];

export const STYLE_CUSTOM = 'custom';

/** 按 id 取预设；未知 id 返回 null。 */
export function stylePresetOf(id) {
  const key = String(id == null ? '' : id);
  return STYLE_PRESETS.find((p) => p.id === key) || null;
}

/**
 * 当前生效的画风。
 *
 * 返回值 `null` 表示**不改**——此时模版原样生效（出厂仍是动漫）。
 * 返回 `{ line, meta: string[] }` 时才替换。
 *
 * 自定义档位下 `line` 为空也返回 null：空画风句替换进去等于把画风那一条删了，
 * 模型会自己编，比留着默认更差。
 */
export function styleOf(cfg) {
  const c = cfg || null;
  if (!c) return null;
  const s = c.style || {};
  const pick = String(s.preset == null ? '' : s.preset);

  if (pick === STYLE_CUSTOM) {
    const line = String(s.customLine == null ? '' : s.customLine).trim();
    if (!line) return null;
    const meta = String(s.customMeta == null ? '' : s.customMeta)
      .split(/[,，]/)
      .map((x) => x.trim().replace(/^["']|["']$/g, ''))
      .filter(Boolean);
    return { line, meta };
  }

  const p = stylePresetOf(pick);
  if (!p) return null;
  return { line: p.line, meta: p.meta.slice() };
}

/**
 * 把画风套到模版文本上（只动示例，别的一个字不碰）。
 *
 * 两个锚点都写成**宽容正则**，因为用户的模版可能被他手动改过措辞：
 *   ① `"meta": [ … "anime" … ]` —— 必须带 anime 才替换，避免误伤多格版的
 *     `"meta": ["manga", "comic page"]`（那是体裁不是画风，换了会把漫画版识别成单图）。
 *   ② 反引号里第一个含 `anime` 的短语 —— 就是那句画风示例。
 *
 * @param {string} text 模版 protocol 原文
 * @param {object} [cfg]
 * @returns {string}
 */
export function applyStylePreset(text, cfg) {
  const src = typeof text === 'string' ? text : String(text == null ? '' : text);
  if (!src) return src;
  const st = styleOf(cfg);
  if (!st) return src;

  let out = src;

  /* ① meta 示例 */
  const metaLit = st.meta.length
    ? `[${st.meta.map((m) => JSON.stringify(m)).join(', ')}]`
    : '[]';
  out = out.replace(/("meta"\s*:\s*)\[[^\]]*"anime"[^\]]*\]/g, `$1${metaLit}`);

  /* ② 画风句示例 */
  out = out.replace(/`[^`]*anime[^`]*`/i, () => `\`${st.line}\``);

  return out;
}

/**
 * 画风能不能在这份模版上生效（面板用）。
 *
 * ★ 入参必须是**未替换的原文**（`cfg.templates[name].protocol`）。
 *   第一版这里判的是「替换后还有没有 anime」—— 可调用方拿到的是原文，
 *   于是恒为 `ok:false`，面板一直报「没找到」，明明替换是成功的。
 *   改判「原文里有没有那两个锚点」，跟真实替换动作解耦。
 *
 * @param {string} text 模版 protocol **原文**
 * @param {object} [cfg]
 */
export function styleApplied(text, cfg) {
  const src = typeof text === 'string' ? text : '';
  const st = styleOf(cfg);
  if (!st) return { active: false, ok: true };
  const metaOk = /"meta"\s*:\s*\[[^\]]*"anime"[^\]]*\]/.test(src);
  const lineOk = /`[^`]*anime[^`]*`/i.test(src);
  return { active: true, ok: metaOk && lineOk, metaOk, lineOk, style: st };
}
