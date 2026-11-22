/**
 * 绘灵 · ComfyUI 后端
 *
 * 占位符替换沿用已在「生图助手变量版工作流」上验证过的那套（20/20 命中）。
 * 关键实现要点（都是踩过的坑）：
 *   ① 在**对象层**替换，不在 JSON 字符串上替换 —— 避免路径反斜杠被二次转义
 *   ② 整个值就是占位符时（如 "seed": "%seed%"）保留原始类型，否则 ComfyUI 校验会因
 *      "不是 int" 而拒绝，且错误信息很难看懂
 *   ③ 替换后必须检查残留占位符 —— 残留会带着字面量 "%lora3%" 提交，同样校验失败
 *   ④ 把 ComfyUI 的 node_errors 翻译成人话 —— 这是"后台求助信息"的落地处
 */

import { getConfig } from '../settings.js';
import { applyResolution } from '../resSelector.js';
import { applyEnhance, DLSS_CLASS, MASK_BLUR_CLASS, DLSS_UPSCALE_MODES } from '../enhanceControl.js';
import { randomClientId } from '../st.js';
import { diagnose, info, warn, debug, STAGE } from '../log.js';

const PLACEHOLDER_RE = /%([a-z0-9_]+)%/gi;
const EXACT_PLACEHOLDER_RE = /^%([a-z0-9_]+)%$/i;

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** LoRA 槽位上限 —— 只是"认识哪些占位符"的上限，面板上可以填到这个数 */
export const LORA_SLOT_LIMIT = 20;

/**
 * 等出图的默认上限（秒）。
 *
 * ★ 以前写 180。ComfyUI 是**串行队列**（一次只跑一张），GAL 一楼要 N 张、
 *   还可能同时排着立绘/场景，后面的图等待时间会成倍上涨 —— 180 秒会把
 *   **已经画好的图**判成超时（实测一张跑了 282.7s 成功、却在 181s 被放弃）。
 *   300 只是「单张宽松线」，多张时由 `galPaintTimeout` 再按张数放大。
 */
export const COMFY_DEFAULT_TIMEOUT_SEC = 300;

/** 后端元信息 —— 与 modules/backends/index.js 的注册表同形状。 */
export const meta = {
  key: 'comfyui',
  name: 'ComfyUI',
  short: 'ComfyUI',
  hint: '本地/局域网工作流，走 %占位符% 替换',
};

/** 绘制可识别的占位符全集。 */
export function knownPlaceholders() {
  const s = new Set([
    '%prompt%', '%negative_prompt%', '%negative%', '%nl%', '%seed%', '%model%',
    '%steps%', '%cfg%', '%sampler%', '%scheduler%', '%width%', '%height%',
    '%vae%', '%clip%', '%clip_skip%', '%clip_type%',
  ]);
  for (let i = 1; i <= LORA_SLOT_LIMIT; i += 1) {
    s.add(`%lora${i}%`);
    s.add(`%lora${i}_strength%`);
  }
  return s;
}

/**
 * CLIP 类型（`CLIPLoader` 节点的 `type` 字段）兜底枚举。
 *
 * 真实来源是 ComfyUI 的 `/object_info/CLIPLoader` —— 点「拉取资源」时会被真值覆盖。
 * 这份常量只是「还没连上 ComfyUI」时的可选项，保证下拉框不至于空着。
 *
 * ⚠️ 必须是小写内部名（`qwen_image`），**不是** ComfyUI 界面上显示的本地化名字
 * （汉化版会显示成「Qwen千问图像」，直接用那个提交会被拒）。
 */
export const CLIP_TYPE_FALLBACK = [
  'stable_diffusion', 'stable_cascade', 'sd3', 'stable_audio', 'mochi', 'ltxv',
  'pixart', 'cosmos', 'lumina2', 'wan', 'hidream', 'chroma', 'ace', 'omnigen2',
  'qwen_image', 'hunyuan_image', 'flux2', 'ovis', 'longcat_image', 'cogvideox',
  'lens', 'pixeldit', 'ideogram4', 'boogu', 'krea2', 'joyimage', 'mage', 'minimax',
];

/**
 * 从 CLIP 文件名猜它属于哪个 type —— 只用来在面板上给一句**建议**，不自动填。
 *
 * 动机：换 CLIP 模型时最容易忘的就是同步改 type（qwen 系 CLIP 配 wan 的 type 会直接跑挂），
 * 而报错信息晦涩。这里做一个保守猜测，命中了就提示一句，让用户自己决定。
 *
 * 保守的含义：**多义的一律不猜**。`t5xxl` 在 SD3 / Flux 下都用，猜哪个都是害人，
 * 所以返回空串（宁可不猜，也不要猜错把人带沟里）。
 */
export function guessClipType(fileName) {
  const n = String(fileName || '').toLowerCase();
  if (!n) return '';
  if (/qwen/.test(n)) return 'qwen_image';
  if (/umt5/.test(n)) return 'wan';                        // umt5 是 Wan 系的文本编码器
  if (/clip[-_]?(l|g)\b|clip-vit/.test(n)) return 'stable_diffusion';
  if (/gemma/.test(n)) return 'lumina2';
  if (/llama/.test(n)) return 'hidream';
  return '';
}

/* ============ 变量表 ============ */

/** 导出是为了可测：占位符取值的纪律（谁注册、谁不注册）是纯逻辑，值得直接断言。 */
/**
 * 中文描述怎么混进提示词 —— 纯函数，好测。
 *
 * 规则（两道开关，先全局再兜底）：
 *   ① nlEnabled=false → 中文一条都不发（prompt 原样返回、nl 置空），纯 tag 模式；
 *   ② 工作流有 %nl% → 中文走独立占位符，prompt 不动；
 *   ③ 工作流没 %nl% 且兜底开着 → 中文追加到 prompt 末尾（tag 行 + 中文行）；
 *   ④ 工作流没 %nl% 且兜底关了 → 中文丢弃（只在调用处告警，这里静默返回）。
 *
 * @returns {{prompt:string, nl:string, useFallback:boolean, hasNlSlot:boolean, nlFallback:boolean}}
 */
export function composeComfyNlPrompt(prompt, nl, opts = {}) {
  const hasNlSlot = !!opts.hasNlSlot;
  const nlFallback = opts.nlFallback !== false;
  const nlEnabled = opts.nlEnabled !== false;
  const text = nlEnabled ? String(nl || '').trim() : '';
  const useFallback = !hasNlSlot && !!text && nlFallback;
  return {
    prompt: useFallback ? `${String(prompt || '')}\n${text}` : String(prompt || ''),
    nl: text,
    useFallback,
    hasNlSlot,
    nlFallback,
  };
}

export function buildVars({ prompt, negative, nl, cfg }) {
  const be = cfg.backends?.comfyui || {};
  const negText = (negative ?? '').trim() || (be.negative || '').trim();

  const vars = {
    prompt: String(prompt ?? ''),
    negative_prompt: negText,
    negative: negText,
    nl: String(nl ?? ''),
    seed: Math.floor(Math.random() * 2147483647),
    clip_skip: Number(be.clipSkip ?? -2),
    steps: Number(be.steps) || 20,
    cfg: Number(be.cfg ?? 7),
    sampler: be.sampler || 'euler',
    scheduler: be.scheduler || 'normal',
    width: Number(be.width) || 832,
    height: Number(be.height) || 1216,
  };

  /**
   * 资源类占位符（模型 / VAE / CLIP / CLIP 类型）：**留空不注册**。
   *
   * 注册成空串的后果是：工作流里的 `%clip%` 被替换成 `""` 提交上去，
   * ComfyUI 只会回一句晦涩的 node_errors（"clip_name 不是有效值"），
   * 用户根本看不出是面板上那格没填。
   * 不注册则它会立刻进 missing 列表，绘灵能直说「%clip% 没有值，去面板填 CLIP 模型」——
   * 与 LoRA 空槽位是同一条纪律。
   *
   * `%clip_type%` 也走这条纪律：type 是有限枚举（qwen_image / wan / krea2 …），
   * 填错比不填更糟 —— 不填会当场报缺失，填错要等 ComfyUI 跑起来才炸。
   */
  const putIfFilled = (key, value) => {
    const text = String(value ?? '').trim();
    if (text) vars[key] = text;
  };

  /**
   * 「跟随工作流」（v0.9.88）：勾上的种类不用面板值，改用导入/AI 适配时记录在
   * wfDefaults 里的工作流原值（Checkpoint 自带 VAE/CLIP 的场景）。
   * 原值没记录到（老工作流、或导入时该节点就没有）→ 不注册 → 走缺失报错，
   * 诊断里会提示「跟随开着但没记录到原值」，而不是静默提交空串。
   */
  const follow = be.followWorkflow || {};
  const wfDefs = be.wfDefaults || {};
  const resourceValue = (kind, panelVal) => {
    if (follow[kind]) return String(wfDefs[kind] ?? '').trim();
    return String(panelVal ?? '').trim();
  };
  putIfFilled('model', resourceValue('model', be.model));
  putIfFilled('vae', resourceValue('vae', be.vae));
  putIfFilled('clip', resourceValue('clip', be.clip));
  putIfFilled('clip_type', resourceValue('clipType', be.clipType));

  /**
   * LoRA 槽位。
   *
   * ① **留空** = 这一行没有名字 → 不注册 → 提交前报缺失（保留这条纪律：
   *    面板顺序即槽位号，中间的洞会让后面的 LoRA 整体前移，必须明确报出来）。
   *
   * ② **停用（取消勾选）= 强度 0，不是"不注册"**（v0.9.89）。
   *    以前停用会让 `%loraN%` 没值 → 出图当场报「未替换的占位符」——
   *    用户勾掉一支 LoRA 本意是"这支护盾先关掉"，结果整张图出不来，这是 bug。
   *    现在停用照常注册文件名、强度记 0：ComfyUI 会加载但**对画面无影响**。
   */
  (be.loras || []).forEach((l, i) => {
    if (i >= LORA_SLOT_LIMIT) return;
    const name = String(l?.name || '').trim();
    if (!name) return;
    vars[`lora${i + 1}`] = name;
    vars[`lora${i + 1}_strength`] = l.enabled === false ? 0 : Number(l?.strength ?? 1);
  });

  return vars;
}

/* ============ 替换 ============ */

function substitute(node, vars, missing) {
  if (typeof node === 'string') {
    const exact = EXACT_PLACEHOLDER_RE.exec(node);
    if (exact) {
      const key = exact[1].toLowerCase();
      if (key in vars) return vars[key]; // 保留原始类型（数字仍是数字）
      missing.add(node);
      return node;
    }
    return node.replace(PLACEHOLDER_RE, (full, key) => {
      const k = String(key).toLowerCase();
      if (k in vars) return String(vars[k]);
      missing.add(full);
      return full;
    });
  }
  if (Array.isArray(node)) return node.map(x => substitute(x, vars, missing));
  if (node && typeof node === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(node)) out[k] = substitute(v, vars, missing);
    return out;
  }
  return node;
}

/* ============ 工作流校验 ============ */

/**
 * 解析并体检工作流文本。
 * @returns {{ok:boolean, workflow?:object, placeholders?:string[], problems:string[], hints:string[], samplers?:string[]}}
 */
export function analyzeWorkflow(text) {
  const problems = [];
  const hints = [];
  if (!text || !String(text).trim()) {
    return { ok: false, problems: ['工作流 JSON 为空 —— 请从 ComfyUI 用「保存（API 格式）」导出后粘贴'], hints };
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      ok: false,
      problems: [`JSON 解析失败：${err.message}`],
      hints,
    };
  }

  // 兼容 {"prompt": {...}} 包一层的形式
  if (parsed && typeof parsed.prompt === 'object' && parsed.prompt !== null && !parsed.class_type) {
    parsed = parsed.prompt;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, problems: ['不是 API 格式的节点对象（应形如 {"3": {"class_type": ...}}）'], hints };
  }

  const firstNode = Object.values(parsed)[0];
  if (!firstNode || typeof firstNode !== 'object' || !('class_type' in firstNode)) {
    problems.push('节点缺少 class_type 字段 —— 可能导成了「工作流格式」而不是「API 格式」');
  }

  const placeholders = new Set();
  const walk = (n) => {
    if (typeof n === 'string') {
      for (const m of n.matchAll(PLACEHOLDER_RE)) placeholders.add(m[0]);
    } else if (Array.isArray(n)) n.forEach(walk);
    else if (n && typeof n === 'object') Object.values(n).forEach(walk);
  };
  walk(parsed);

  const list = Array.from(placeholders).sort();
  if (!list.includes('%prompt%')) {
    problems.push('工作流里没有 %prompt% —— 提示词没有落脚点，出图内容不会变');
  }

  const known = knownPlaceholders();
  const unknown = list.filter(x => !known.has(x.toLowerCase()));
  if (unknown.length) {
    problems.push(`发现绘灵不认识的占位符：${unknown.join(', ')} —— 它们会被原样提交导致校验失败`);
  }

  // 找 KSampler 类节点，确认 seed 可替换
  const samplers = Object.entries(parsed)
    .filter(([, n]) => /KSampler/i.test(n?.class_type || ''))
    .map(([id, n]) => `${id}(${n.class_type})`);
  if (!samplers.length) problems.push('没找到 KSampler 类节点，请确认导出的工作流包含采样器');

  /**
   * CLIP 相关提示（不阻断，只提醒）。
   *
   * 这是用户实际踩到的坑：CLIPLoader 的「类型」和「CLIP 文件名」在 ComfyUI 里是
   * 两个独立的下拉框，导出成 API 格式后就变成两个写死的字符串。换 CLIP 模型时
   * 很容易只改文件名忘了改类型，一跑就炸，而报错信息看不出是这里。
   * 提示一句"可以改成占位符交给面板管"，比事后翻译 node_errors 省事得多。
   */
  for (const [id, n] of Object.entries(parsed)) {
    const cls = n?.class_type || '';
    if (!/^(Dual)?CLIPLoader$/i.test(cls)) continue;
    const ins = n?.inputs || {};

    const t = ins.type;
    if (typeof t === 'string' && !t.includes('%')) {
      hints.push(
        `节点 ${id} [${cls}] 的「类型」写死为「${t}」—— 换 CLIP 模型时这里也得同步改。`
        + '把它改成 %clip_type%，就能在面板上切换类型而不用动工作流。',
      );
    }

    for (const f of ['clip_name', 'clip_name1', 'clip_name2']) {
      const v = ins[f];
      if (typeof v === 'string' && v && !v.includes('%')) {
        hints.push(
          `节点 ${id} [${cls}] 的 CLIP 文件名写死为「${v}」—— 改成 %clip% 可由面板控制。`,
        );
      }
    }
  }

  return { ok: problems.length === 0, workflow: parsed, placeholders: list, problems, hints, samplers };
}

/* ============ 深度体检（v0.9.108） ============ */

/**
 * 比 `analyzeWorkflow` 更深一层的检查 —— 专查「工作流本身合法、但一跑就炸」的那类问题。
 *
 * 为什么单独一个函数而不是塞进 analyzeWorkflow：
 *   analyzeWorkflow 是纯 JSON 检查（不依赖面板、不依赖网络），出图前也会用它；
 *   这里要拿**面板值**和**ComfyUI 资源列表**做交叉核对，属于"体检按钮专属"的深检。
 *   混在一起会让出图路径被迫依赖网络。
 *
 * 检查四类（全部是已发生过的事故，不是猜的）：
 *   ① 占位符 ↔ 面板值：`%model%` 有但面板空 → 提交时抛「未替换的占位符」
 *   ② LoRA 配齐：工作流要 `%lora3%` 而面板只有 2 行 → 第 3 个原样提交，校验失败
 *   ③ 宽高通路：`EmptyLatentImage` 的宽高写死 → 面板填多少都没用（v0.9.104 踩过）
 *   ④ 资源存在性：模型/VAE/CLIP/LoRA 文件名在 ComfyUI 上不存在 → 提交后被拒，
 *      而 ComfyUI 的报错信息完全看不出是文件名的问题
 *
 * @param {object|string} workflow
 * @param {{panel?:object, resources?:object|null}} ctx
 *        panel: { model, vae, clip, clipType, negative, loras:[{name}] }
 *        resources: fetchResources() 的返回；null = 没联网，资源项跳过并说明
 * @returns {{items:Array<{level:'error'|'warn'|'info', text:string}>, checkedResources:boolean}}
 */
export function auditWorkflow(workflow, ctx = {}) {
  const items = [];
  const add = (level, text) => items.push({ level, text });

  let wf = workflow;
  if (typeof wf === 'string') {
    try { wf = JSON.parse(wf); } catch { return { items: [{ level: 'error', text: '工作流不是合法 JSON' }], checkedResources: false }; }
  }
  if (!wf || typeof wf !== 'object' || Array.isArray(wf)) {
    return { items: [{ level: 'error', text: '工作流不是 API 格式的节点对象' }], checkedResources: false };
  }
  if (wf.prompt && typeof wf.prompt === 'object' && !wf.class_type) wf = wf.prompt;

  const panel = ctx.panel || {};
  const resources = ctx.resources || null;
  const loras = Array.isArray(panel.loras) ? panel.loras : [];

  /* ---- 扫出全部占位符 + 找关键节点 ---- */
  const ph = new Set();
  const nodes = [];
  for (const [id, n] of Object.entries(wf)) {
    if (!n || typeof n !== 'object') continue;
    nodes.push({ id, cls: String(n.class_type || ''), inputs: n.inputs || {} });
    const walk = (v) => {
      if (typeof v === 'string') { for (const m of v.matchAll(PLACEHOLDER_RE)) ph.add(m[0]); }
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') Object.values(v).forEach(walk);
    };
    walk(n);
  }

  /* ---- ① 占位符 ↔ 面板值 ---- */
  const need = [
    ['%model%', panel.model, '模型'],
    ['%vae%', panel.vae, 'VAE'],
    ['%clip%', panel.clip, 'CLIP'],
    ['%clip_type%', panel.clipType, 'CLIP 类型'],
  ];
  for (const [token, val, label] of need) {
    if (ph.has(token) && !String(val ?? '').trim()) {
      add('error', `工作流要 ${token}，但面板上的「${label}」是空的 —— 提交时会报「未替换的占位符」。`);
    }
  }
  if (ph.has('%negative_prompt%') && !String(panel.negative ?? '').trim()) {
    add('warn', '工作流有 %negative_prompt%，但面板的负面提示词是空的 —— 负面词不会生效。');
  }

  /* ---- ② LoRA 配齐 ---- */
  const loraSlots = [...ph]
    .map((t) => /^%lora(\d+)%$/.exec(t))
    .filter(Boolean)
    .map((m) => Number(m[1]))
    .sort((a, b) => a - b);
  if (loraSlots.length) {
    const maxSlot = loraSlots[loraSlots.length - 1];
    if (loras.length < maxSlot) {
      add('error', `工作流要用到 %lora${maxSlot}%，但面板只配了 ${loras.length} 行 LoRA —— 缺的那几个会原样提交，校验失败。`);
    }
    const empty = loraSlots.filter((i) => !String(loras[i - 1]?.name || '').trim());
    if (empty.length && loras.length >= maxSlot) {
      add('error', `面板第 ${empty.join('、')} 行 LoRA 是空的，而工作流要 %lora${empty[0]}% —— 提交时会报「未替换的占位符」。`);
    }
  }
  // LoRA 名写死 → 面板的 LoRA 行对它完全无效（用户会以为面板上的 LoRA 生效了）
  const hardLora = nodes.filter((n) => /^LoraLoader/.test(n.cls)
    && typeof n.inputs.lora_name === 'string'
    && !n.inputs.lora_name.includes('%'));
  if (hardLora.length && loras.length) {
    add('warn', `节点 ${hardLora.map((n) => n.id).join('、')} 的 LoRA 文件名是写死的（没走 %loraN%）—— 面板上的 LoRA 行对它们不起作用。`);
  }

  /* ---- ③ 宽高通路 ---- */
  const latents = nodes.filter((n) => /^Empty(SD3)?LatentImage$/.test(n.cls));
  if (!latents.length) {
    add('info', '没找到空 latent 节点 —— 这份工作流大概是图生图/放大类，面板的宽高不参与。');
  } else {
    for (const n of latents) {
      const w = n.inputs.width;
      const h = n.inputs.height;
      if (typeof w === 'number' && typeof h === 'number') {
        add('warn', `节点 ${n.id} 的宽高写死为 ${w}×${h} —— 面板上的「宽 / 高」对它无效（要用面板控制就改成 %width% / %height%）。`);
      } else if (Array.isArray(w) || Array.isArray(h)) {
        const from = Array.isArray(w) ? String(w[0]) : (Array.isArray(h) ? String(h[0]) : '?');
        const src = nodes.find((x) => x.id === from);
        add('info', `节点 ${n.id} 的宽高接在节点 ${from}${src ? `（${src.cls}）` : ''} 的输出上 —— 面板宽高不参与，改由那个节点决定。`);
      }
    }
  }

  /* ---- ④ 画质增强节点参数合法性 ---- */
  for (const n of nodes) {
    if (n.cls === DLSS_CLASS) {
      const mode = n.inputs.upscale_mode;
      if (mode !== undefined && !DLSS_UPSCALE_MODES.includes(mode)) {
        add('warn', `节点 ${n.id} 的「上采样模式」是「${mode}」，不在已知选项里（${DLSS_UPSCALE_MODES.join(' / ')}）—— ComfyUI 可能直接拒收。`);
      }
      for (const k of ['nr_intensity', 'output_detail_strength', 'local_structure_strength', 'skin_structure_strength', 'local_tone_strength']) {
        const v = n.inputs[k];
        if (v !== undefined && typeof v !== 'number') {
          add('warn', `节点 ${n.id} 的 ${k} 是「${v}」，看起来不是数字 —— 该字段要数值。`);
        }
      }
    }
    if (n.cls === MASK_BLUR_CLASS) {
      for (const k of ['expand', 'blur_radius']) {
        const v = n.inputs[k];
        if (v !== undefined && typeof v !== 'number') {
          add('warn', `节点 ${n.id} 的 ${k} 是「${v}」—— 该字段要数值。`);
        }
      }
    }
  }

  /* ---- ⑤ 资源存在性 ---- */
  /**
   * 判定「这份资源列表能不能用来核对」—— 必须是**有非空列表**，
   * 不能只看对象非空：`resourceCache` 里可能只有一个 `at` 时间戳（拉过一次但一个列表都没拿到），
   * 按「对象非空」判会走到"已核对"分支、一条检查都不做，然后显示"通过"——
   * 用户看到绿色就等于被骗了一次（这种事必须报「没核对」）。
   */
  const listKeys = ['checkpoints', 'unet', 'vae', 'clips', 'loras'];
  const usable = !!resources && listKeys.some((k) => Array.isArray(resources[k]) && resources[k].length);

  let checkedResources = false;
  if (usable) {
    checkedResources = true;
    /** 占位符换成面板的真实值再核对；写死的值直接核对 */
    const resolve = (v) => {
      if (typeof v !== 'string') return '';
      const s = v.trim();
      if (!s) return '';
      if (s === '%model%') return String(panel.model || '').trim();
      if (s === '%vae%') return String(panel.vae || '').trim();
      if (s === '%clip%') return String(panel.clip || '').trim();
      const m = /^%lora(\d+)%$/.exec(s);
      if (m) return String(loras[Number(m[1]) - 1]?.name || '').trim();
      return s.includes('%') ? '' : s;      // 其它占位符（如 %clip_type%）不是文件名，跳过
    };
    const pools = [
      { field: 'ckpt_name', list: resources.checkpoints, label: '模型', nodeRe: /^CheckpointLoader(Simple)?$/ },
      { field: 'unet_name', list: resources.unet, label: 'UNET', nodeRe: /^UNETLoader$/ },
      { field: 'vae_name', list: resources.vae, label: 'VAE', nodeRe: /^VAELoader$/ },
      { field: 'clip_name', list: resources.clips, label: 'CLIP', nodeRe: /^(Dual)?CLIPLoader$/ },
      { field: 'clip_name1', list: resources.clips, label: 'CLIP', nodeRe: /^DualCLIPLoader$/ },
      { field: 'clip_name2', list: resources.clips, label: 'CLIP', nodeRe: /^DualCLIPLoader$/ },
      { field: 'lora_name', list: resources.loras, label: 'LoRA', nodeRe: /^LoraLoader/ },
    ];
    for (const p of pools) {
      if (!Array.isArray(p.list) || !p.list.length) continue;   // 没拉到这个列表 → 不判（宁缺不错）
      for (const n of nodes) {
        if (!p.nodeRe.test(n.cls)) continue;
        const name = resolve(n.inputs[p.field]);
        if (!name) continue;
        if (!p.list.includes(name)) {
          add('error', `节点 ${n.id} 的${p.label}「${name}」在 ComfyUI 上找不到 —— 提交会被拒（文件名改过 / 没放进去 / 路径不对）。`);
        }
      }
    }
  } else {
    add('info', '没连上 ComfyUI（或没拉到资源列表）—— 模型 / CLIP / LoRA 是否真实存在这一项没有核对。');
  }

  return { items, checkedResources };
}

/** 从工作流里推断默认尺寸（用于面板回填）。 */
export function inferSize(workflow) {
  let size = null;
  const walk = (n) => {
    if (size) return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (n && typeof n === 'object') {
      if (n.class_type === 'EmptyLatentImage' && n.inputs) {
        const w = n.inputs.width;
        const h = n.inputs.height;
        if (typeof w === 'number' && typeof h === 'number') size = { width: w, height: h };
      }
      Object.values(n).forEach(walk);
    }
  };
  walk(workflow);
  return size;
}

/* ============ 探测服务 ============ */

export async function probe(serverUrl) {
  const url = normalizeUrl(serverUrl);
  if (!url) return { ok: false, error: '地址为空' };
  try {
    const res = await fetch(`${url}/system_stats`, { method: 'GET' });
    if (!res.ok) {
      return {
        ok: false,
        error: `HTTP ${res.status}`,
        hint: res.status === 404 ? '这个地址上没有 ComfyUI（可能是别的服务占用了端口）' : '服务有响应但拒绝了请求',
      };
    }
    const data = await res.json();
    return {
      ok: true,
      device: data?.devices?.[0]?.name || data?.system?.comfyui_version || 'ComfyUI',
      version: data?.system?.comfyui_version || '',
      raw: data,
    };
  } catch (err) {
    return {
      ok: false,
      error: err?.message || String(err),
      hint: '连不上 —— 确认 ComfyUI 已启动、端口正确（默认 8188，你的环境是 8186）、没有被防火墙拦',
    };
  }
}

function normalizeUrl(u) {
  let url = String(u || '').trim();
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  return url.replace(/\/+$/, '');
}

/* ============ 提交 ============ */

/**
 * 提交一次生图。
 * @returns {{ok:boolean, images?:Array, error?:string, promptId?:string, elapsed?:number}}
 */
export async function submit({ prompt, negative, nl, cfg, taskId, label, timeoutSec }) {
  const conf = cfg || getConfig();
  const be = conf.backends?.comfyui || {};

  if (!be.enabled) {
    diagnose(STAGE.BACKEND, 'ComfyUI 后端未启用', {
      cause: '配置里 comfyui.enabled 是关闭状态',
      fix: '到「生图后端」页把 ComfyUI 打开',
    });
    return { ok: false, error: 'ComfyUI 后端未启用' };
  }

  const url = normalizeUrl(be.serverUrl);
  if (!url) {
    diagnose(STAGE.BACKEND, 'ComfyUI 地址为空', {
      cause: '没填服务地址',
      fix: '到「生图后端」页填 http://127.0.0.1:8186（你的 ComfyUI 端口）',
    });
    return { ok: false, error: '地址为空' };
  }

  const check = analyzeWorkflow(be.workflowJson);
  if (!check.ok) {
    diagnose(STAGE.BACKEND, `工作流体检不通过（${label || '本图'}）`, {
      cause: check.problems[0],
      fix: '到「生图后端」页重新粘贴 API 格式工作流，右侧会实时显示问题清单',
    }, check.problems);
    return { ok: false, error: check.problems.join('；') };
  }

  /**
   * 中文描述（nl）的两道开关 —— 先全局、再兜底。
   *
   * ① 全局「中文描述」开关（cfg.nlEnabled，面板/图菜单都能切）：
   *    关掉 = 这次只发英文 tag 串，中文既不走 %nl% 也不追加 —— 想对比
   *    「中文到底有没有用」时最快的方式（悬浮框里仍然能看到那段中文，
   *    它只是不参与出图）。
   *
   * ② nl 兜底（be.nlFallback）：很多工作流（包括从生图助手迁移过来的那份）
   *    只有 %prompt%、没有 %nl%，而 buildVars 只在工作流**真的写了** %nl%
   *    时才有地方放它 —— 于是中文被静默丢弃。这恰恰是 Krea2 最吃的一块：
   *    它的文本编码器是 Qwen 系，中文理解远好于英文 tag 堆叠，丢了画面会变呆。
   *    策略：工作流没有 %nl% 就把 nl 追加到 prompt 末尾（tag 行 + 中文行）。
   *
   * 想分开处理 → 在工作流里显式加 %nl%（如 "text": "%prompt%\n%nl%"）。
   * 想彻底不要 → 关掉全局「中文描述」。
   */
  const nlMix = composeComfyNlPrompt(prompt, nl, {
    hasNlSlot: /%nl%/i.test(String(be.workflowJson || '')),
    nlFallback: be.nlFallback !== false,
    nlEnabled: conf.nlEnabled !== false,
  });
  const { prompt: promptText, nl: nlText, useFallback, hasNlSlot } = nlMix;

  if (conf.nlEnabled === false && String(nl || '').trim()) {
    info(STAGE.BACKEND, '「中文描述」已关闭 —— 本次只发英文 tag 串');
  } else if (!hasNlSlot && nlText && !nlMix.nlFallback) {
    warn(STAGE.BACKEND, '工作流没有 %nl% 且「nl 兜底」已关闭 —— 本次的中文描述会被丢弃');
  } else if (useFallback) {
    info(STAGE.BACKEND, `工作流里没有 %nl% 占位符 —— 已把中文描述追加到提示词末尾（${nlText.length} 字）`);
  }

  const vars = buildVars({ prompt: promptText, negative, nl: nlText, cfg: conf });

  /**
   * 分辨率接线（v0.9.104）。
   *
   * 为什么必须在 substitute 之前做：这里改的是**节点引用**（`["13",0]` ↔ `%width%`），
   * 而 substitute 负责把 `%width%` 换成数字。顺序反了的话，接在 ResolutionSelector 上的
   * 宽高根本不会去看面板值 —— 这正是用户报「改宽高完全没反应」的根因。
   *
   * applyResolution 是纯函数（内部深拷贝），不会污染配置里的 workflowJson。
   */
  const resApplied = applyResolution(check.workflow, {
    enabled: be.resSelector?.enabled === true,
    aspect: be.resSelector?.aspect,
    megapixels: be.resSelector?.megapixels,
    multiple: be.resSelector?.multiple,
  });
  if (resApplied.notes.length) {
    debug(STAGE.BACKEND, `分辨率适配：${resApplied.notes.join('；')}`);
  }
  if (resApplied.mode === 'selector' && resApplied.createdSelector) {
    info(STAGE.BACKEND, '工作流里没有分辨率选择器 —— 已按开关自动串接一个（比例/像素/倍数取自后端面板）');
  }
  if (resApplied.mode === 'manual') {
    debug(STAGE.BACKEND, `分辨率走手填：${be.width}×${be.height}`);
  }

  /**
   * 画质增强接线（v0.9.108）。
   *
   * 和分辨率同理：这里改的是节点**参数值**，必须在 substitute 之前做完。
   * `applyEnhance` 也是纯函数（内部深拷贝），不会污染配置里的 workflowJson。
   *
   * 为什么按节点 id 存值：DLSS 是主图三连击（强度 2→2→0）+ 人脸单次（1），
   * 4 个节点参数本来就各不相同，合并成一组值会把调好的渐变抹平。
   * 换工作流后 id 变了 → 旧配置里的键对不上，自动跳过，不会串味。
   */
  const enhApplied = applyEnhance(resApplied.workflow || check.workflow, {
    dlss: be.enhance?.dlss,
    mask: be.enhance?.mask,
  });
  if (enhApplied.notes.length) {
    debug(STAGE.BACKEND, `画质增强：${enhApplied.notes.join('；')}`);
  }

  const missing = new Set();
  const finalWf = substitute(enhApplied.workflow || resApplied.workflow || check.workflow, vars, missing);

  if (missing.size) {
    const list = Array.from(missing).join(', ');
    // 最常见的成因：面板上某个 LoRA 槽位空着
    const emptySlots = (be.loras || [])
      .map((l, i) => ({ i, name: String(l?.name || '').trim() }))
      .filter(x => !x.name)
      .map(x => `LoRA${x.i + 1}`);

    // 「跟随工作流」开着却报缺失 = 原值没记录到（老工作流没走过导入/适配）
    const follow = be.followWorkflow || {};
    const wfDefs = be.wfDefaults || {};
    const followBroken = ['model', 'vae', 'clip', 'clipType'].filter((k) => follow[k] && !String(wfDefs[k] || '').trim()
      && missing.has(k === 'clipType' ? '%clip_type%' : `%${k}%`));

    diagnose(STAGE.BACKEND, `工作流有 ${missing.size} 个占位符没被替换：${list}`, {
      cause: followBroken.length
        ? `「跟随工作流」对 ${followBroken.join('、')} 开着，但导入时没记录到工作流原值 —— 跟随无值可跟`
        : emptySlots.length
          ? `面板上这些槽位是空的：${emptySlots.join('、')} —— 空槽位不会产生替换值，占位符就原样留在工作流里`
          : '这些占位符对应的值在面板上没填（模型名为空、或工作流用了绘灵不支持的占位符）',
      fix: followBroken.length
        ? `关掉 ${followBroken.join('、')} 的「跟随工作流」改为手填；或重新导入工作流跑一次 AI 适配（会记录原值）`
        : emptySlots.length
          ? `把 ${emptySlots.join('、')} 填上真实 LoRA 名；不用的槽位也请填一个真实名字并把强度设为 0`
          : '补齐模型名 / 检查工作流里的占位符拼写',
    }, { missing: list, emptySlots, followBroken });
    return { ok: false, error: `未替换的占位符：${list}` };
  }

  // 自动重试次数（cfg.genRetries，v0.9.12 起可配；0 = 失败直接报错）。
  // 只重「等一等就好」的错：网络抖动、HTTP 429/5xx；超时与 4xx（工作流/配置问题）不重试。
  const retries = Math.max(0, Math.min(5, Number(conf.genRetries ?? 1) || 0));
  const RETRY_DELAY_MS = Number(be.retryDelayMs) || 2000;

  let t0 = Date.now();

  /**
   * 等出图的上限（秒）。三级取值：
   *   ① 调用方显式传的 `timeoutSec`（GAL 模式按张数放大，见 `galPaintTimeout`）
   *   ② 面板「出图超时」（`be.timeoutSec`）
   *   ③ 默认 300
   *
   * ★ v0.9.176 默认从 180 提到 300：后端是**串行排队**，一楼多张时后面几张
   *   要等前面跑完；180 秒在「单张略慢」时就会把**已经画好的图**判成失败
   *   （实测 slot2 跑了 282.7s 成功、却在 181s 被放弃，白烧一次）。
   */
  const waitSec = Math.max(30, Number(timeoutSec ?? be.timeoutSec) || COMFY_DEFAULT_TIMEOUT_SEC);

  for (let attempt = 0; attempt <= retries; attempt += 1) {
  const clientId = randomClientId();

  try {
    const res = await fetch(`${url}/prompt`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: finalWf, client_id: clientId }),
    });

    if (!res.ok) {
      const rawText = await res.text();
      const friendly = explainComfyError(res.status, rawText);
      const retriable = res.status === 429 || (res.status >= 500 && res.status < 600);
      if (retriable && attempt < retries) {
        warn(STAGE.BACKEND, `ComfyUI 临时失败（HTTP ${res.status}），${Math.round(RETRY_DELAY_MS / 1000)} 秒后重试（第 ${attempt + 1}/${retries} 次）`);
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
        t0 = Date.now();
        continue;
      }
      diagnose(STAGE.BACKEND, `ComfyUI 拒绝了这次提交（HTTP ${res.status}）`, friendly, rawText.slice(0, 1500));
      return { ok: false, error: friendly.cause };
    }

    const data = await res.json();
    const promptId = data?.prompt_id;
    if (!promptId) {
      diagnose(STAGE.BACKEND, 'ComfyUI 接受了请求但没有返回任务号', {
        cause: '响应格式异常，可能是中间有代理或反代改写了响应',
        fix: '直接用 curl 或浏览器访问 /prompt 确认返回结构',
      }, data);
      return { ok: false, error: '未拿到 prompt_id' };
    }

    debug(STAGE.BACKEND, `已提交任务 ${promptId}（${label || ''}），等待出图`);
    const images = await pollHistory(url, promptId, waitSec);
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    info(STAGE.BACKEND, `${label || '图片'} 生成完成：${images.length} 张，耗时 ${elapsed}s`);
    // seed / loras 带回去 —— 出图历史（灯箱参数面板）要展示本次真实参数
    const loras = (be.loras || [])
      .filter(l => String(l?.name || '').trim())
      .map(l => ({ name: String(l.name).trim(), weight: Number(l.weight) || 0 }));
    return { ok: true, images, promptId, elapsed, seed: vars.seed, loras };
  } catch (err) {
    const msg = err?.message || String(err);
    // 非超时的异常（网络抖动、连接中断）且还有重试额度 → 重试；超时重试只会排队更久
    if (!/超时/.test(msg) && attempt < retries) {
      warn(STAGE.BACKEND, `ComfyUI 临时失败（${msg.slice(0, 80)}），${Math.round(RETRY_DELAY_MS / 1000)} 秒后重试（第 ${attempt + 1}/${retries} 次）`);
      await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
      t0 = Date.now();
      continue;
    }
    if (/超时/.test(msg)) {
      diagnose(STAGE.BACKEND, `生图超时（${waitSec}s）`, {
        cause: 'ComfyUI 还在跑，或者卡在模型加载；也可能是首次运行要载入大模型',
        fix: '到 ComfyUI 界面看队列状态；确认显存够用；必要时把超时时间调大',
      });
    } else {
      diagnose(STAGE.BACKEND, `提交失败：${msg}`, {
        cause: '网络层错误 —— 通常是 ComfyUI 没启动或端口不对',
        fix: `在浏览器打开 ${url} 看有没有 ComfyUI 界面`,
      }, err?.stack);
    }
    // errStack 带回抛点堆栈 —— 错误槽 hover 就能定位是哪个文件抛的（排查过
    // 「reading 'title'」这类来源不明的错误后加的：没有堆栈只能瞎猜）
    return { ok: false, error: msg, errStack: String(err?.stack || '').slice(0, 1200) };
  }
  }
}

/** 把 ComfyUI 的节点级报错翻译成人话。 */
function explainComfyError(status, rawText) {
  let nodeErrors = '';
  let general = '';

  try {
    const j = JSON.parse(rawText);
    if (j?.error) {
      general = j.error.message || j.error.type || JSON.stringify(j.error);
      if (j.error.details) general += ` — ${j.error.details}`;
    }
    if (j?.node_errors && typeof j.node_errors === 'object') {
      const parts = [];
      for (const [nid, e] of Object.entries(j.node_errors)) {
        const cls = e?.class_type || '';
        const errs = (e?.errors || []).map(x => {
          const input = x?.extra_info?.input_name ? `字段「${x.extra_info.input_name}」` : '';
          const recv = x?.extra_info?.received_value !== undefined
            ? `收到「${JSON.stringify(x.extra_info.received_value)}」`
            : '';
          return [input, x?.message, recv].filter(Boolean).join(' ');
        }).join('；');
        parts.push(`节点 ${nid} [${cls}]：${errs}`);
      }
      nodeErrors = parts.join('\n');
    }
  } catch { /* 不是 JSON，用原文 */ }

  const detail = nodeErrors || general || String(rawText).slice(0, 400);

  let cause = 'ComfyUI 校验工作流失败';
  let fix = '按下面的节点级报错逐条修：多半是模型/LoRA 文件名在磁盘上不存在（形近字、少一个反斜杠都会导致）';

  if (/not in \(list of|value not in list/i.test(detail)) {
    cause = '资源名对不上 —— 工作流里引用的模型 / LoRA 名称，在 ComfyUI 的可用列表里找不到';
    fix = '到「生图后端」页点「从 ComfyUI 拉取资源列表」，从下拉里选，不要手打（手打极易出现形近字，比如「口」和「ロ」）';
  } else if (/not a int|expected int|not of type/i.test(detail)) {
    cause = '字段类型不对 —— 多半是占位符替换后类型从数字变成了字符串';
    fix = '检查工作流里 seed / steps / cfg 这类字段是不是写成了 "%seed%" 这种带引号的形式（应该是不带引号的占位符）';
  } else if (/required input|missing/i.test(detail)) {
    cause = '缺少必填输入 —— 有个字段没被赋上值';
    fix = '对照报错里的字段名，检查工作流 JSON 是否被手工改坏了';
  }

  return { cause, fix, detail, status };
}

/* ============ 轮询出图 ============ */

/**
 * 从 `/history/<id>.outputs` 里挑出**最终成品图**（v0.9.100）。
 *
 * ★ 血亏现场（用户 2026-10-19 报「图库里有好几张被裁剪的旧图」）：
 *   `/history` 的 outputs 会把**每一个**产出图片的节点都列出来 —— 包括
 *   `PreviewImage` 写的 `type:'temp'` 临时预览。高清放大 / 分块重绘类工作流
 *   的中间节点会往 temp 里丢一堆**局部裁切图**（实测同一张 888×1184 的成品
 *   旁边并排躺着 876×836、439×432、104×104 三张裁切预览）。
 *   原来的实现把它们和 SaveImage 的成品一视同仁收进 `images[]`，于是：
 *   ①图库出现好几张「同一张图但被裁掉一半」的卡片；②出图位的 ‹ › 也能翻到它们。
 *
 * 规则：有 `type:'output'`（SaveImage 成品）就**只取成品**；
 *       一个都没有（工作流只挂了 PreviewImage）才退回 temp —— 不能因为过滤把图全吃掉。
 *
 * @param {object} outputs  `item.outputs`
 * @returns {{finals:Array, temps:Array, picked:Array, onlyTemp:boolean}}
 */
export function pickFinalImages(outputs) {
  const finals = [];
  const temps = [];
  for (const [nid, out] of Object.entries(outputs || {})) {
    for (const f of (out?.images || [])) {
      if (!f?.filename) continue;
      const type = String(f.type || 'output');
      const rec = {
        filename: f.filename,
        subfolder: f.subfolder || '',
        type,
        node: nid,
      };
      (type === 'temp' ? temps : finals).push(rec);
    }
  }
  return {
    finals,
    temps,
    picked: finals.length ? finals : temps,
    onlyTemp: !finals.length && temps.length > 0,
  };
}

async function pollHistory(baseUrl, promptId, timeoutSec) {
  const deadline = Date.now() + timeoutSec * 1000;
  let lastStatus = '';

  while (Date.now() < deadline) {
    await sleep(1200);
    const res = await fetch(`${baseUrl}/history/${promptId}`);
    if (!res.ok) continue;
    const hist = await res.json();
    const item = hist?.[promptId];
    if (!item) continue;

    const st = item.status || {};
    lastStatus = st.status_str || lastStatus;

    if (st.status_str === 'error' || st.status_str === 'failed') {
      const msgs = (st.messages || [])
        .filter(m => Array.isArray(m) && /error/i.test(String(m[0])))
        .map(m => JSON.stringify(m[1]).slice(0, 300))
        .join('\n');
      diagnose(STAGE.BACKEND, 'ComfyUI 执行时报错（工作流已被接受，但跑挂了）', {
        cause: '典型原因：显存不足、节点缺少依赖、LoRA 与底模不匹配',
        fix: '到 ComfyUI 控制台看完整堆栈；报错信息见下方原始数据',
      }, msgs || st);
      throw new Error(`执行失败：${msgs || '未知错误'}`);
    }

    const outputs = item.outputs || {};
    const { picked, temps, onlyTemp } = pickFinalImages(outputs);
    const images = picked.map((f) => ({
      filename: f.filename,
      subfolder: f.subfolder,
      type: f.type,
      node: f.node,
      url: `${baseUrl}/view?filename=${encodeURIComponent(f.filename)}&subfolder=${encodeURIComponent(f.subfolder)}&type=${encodeURIComponent(f.type)}`,
    }));
    if (images.length) {
      if (temps.length && !onlyTemp) {
        // 有正式成品时丢掉 temp —— 这些是中间节点的局部裁切预览，收进来就是「被裁剪的图」
        debug(STAGE.BACKEND, `已忽略 ${temps.length} 张 ComfyUI 临时预览图（type=temp），只取 ${images.length} 张成品`);
      } else if (onlyTemp) {
        diagnose(STAGE.BACKEND, `工作流只找到 ${temps.length} 张临时预览图（没有 SaveImage 成品），按预览图收下`, {
          cause: '导出的工作流里只有 PreviewImage，没有 SaveImage 节点 —— 这类图可能是中间节点的局部裁切预览',
          fix: '在 ComfyUI 里给最终图接一个 SaveImage 节点再重新导出工作流',
        });
      }
      return images;
    }
    if (st.completed === true && !images.length) {
      diagnose(STAGE.BACKEND, '工作流跑完了但没有产出图片', {
        cause: '工作流里没有 SaveImage / PreviewImage 节点，或者输出被丢弃了',
        fix: '确认导出的工作流里有 SaveImage 节点',
      });
      throw new Error('工作流完成但无输出图片');
    }
  }
  throw new Error(`超时（${timeoutSec}s，最后状态：${lastStatus || '未知'}）`);
}

/* ============ 资源清单 ============ */

/**
 * 拉取 ComfyUI 上的可用资源名（避免手打出错）。
 *
 * 按**节点**分组请求：同一个节点要几个字段就一次拿回来（CLIPLoader 既要
 * `clip_name` 文件列表、又要 `type` 类型枚举，没必要问两遍）。
 * `merge: true` 表示这个节点的结果**并进**已有数组而不是覆盖 ——
 * DualCLIPLoader 与 CLIPLoader 的候选是同一批文件，合并进来只是提高命中率
 * （有些环境只装了 Dual 节点，光问 CLIPLoader 会一无所获）。
 */
export async function fetchResources(serverUrl) {
  const url = normalizeUrl(serverUrl);
  const want = [
    { node: 'CheckpointLoaderSimple', fields: { checkpoints: 'ckpt_name' } },
    { node: 'UNETLoader', fields: { unet: 'unet_name' } },
    { node: 'LoraLoaderModelOnly', fields: { loras: 'lora_name' } },
    { node: 'VAELoader', fields: { vae: 'vae_name' } },
    { node: 'CLIPLoader', fields: { clips: 'clip_name', clipTypes: 'type' } },
    { node: 'DualCLIPLoader', fields: { clips: 'clip_name1', clipTypes: 'type' }, merge: true },
  ];
  const out = {};
  for (const w of want) {
    try {
      const res = await fetch(`${url}/object_info/${w.node}`);
      if (!res.ok) continue;
      const data = await res.json();
      const required = data?.[w.node]?.input?.required || {};
      for (const [key, field] of Object.entries(w.fields)) {
        const opts = required?.[field]?.[0];
        // 非枚举字段在 object_info 里不是数组（如 INT / STRING），跳过即可
        if (!Array.isArray(opts)) continue;
        out[key] = w.merge
          ? Array.from(new Set([...(out[key] || []), ...opts]))
          : opts;
      }
    } catch { /* 单个节点失败不影响其他 */ }
  }
  if (!Object.keys(out).length) {
    warn(STAGE.BACKEND, '没能拉到任何资源列表 —— 确认 ComfyUI 正在运行');
  }
  return out;
}
