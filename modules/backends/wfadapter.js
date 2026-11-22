/**
 * 绘灵 · 工作流导入 / AI 适配（纯逻辑，不碰 DOM、不读配置）
 *
 * 用户的诉求（2026-10-16）：从别处拿来的 ComfyUI 工作流，不想手工一个个把
 * 模型名改成 %占位符% —— 导入后让绘灵「分析一遍，改成能直接用」的形状。
 *
 * 设计上刻意分成两层：
 *
 *   ① **确定性规则（planAdaptation）** —— 靠 API 格式里的连线信息做**链路追踪**：
 *      KSampler 的 positive 连到哪个 CLIPTextEncode，那个节点的 text 就是 %prompt%。
 *      这类判断不靠猜，规则覆盖的部分（loader / 采样参数 / 潜图尺寸 / 提示词 / LoRA）
 *      全部本地完成，零成本、零幻觉。
 *
 *   ② **AI 补丁（validateAiPatch）** —— 规则搞不定的（自定义节点、绕了弯的连线、
 *      分不清哪个 text 是正/负向），把工作流交给出词 LLM 裁决。但 **LLM 只出「意图」
 *      （哪个节点的哪个输入改成哪个占位符），JSON 的改写永远由这里的代码执行** ——
 *      让模型直接重写整个工作流 JSON 是自找崩溃（丢节点、改坏连线）。
 *      且每一条 AI 补丁都要过白名单校验：节点存在、输入存在且不是连线、
 *      占位符在该 (class_type, input) 组合下是允许的。
 *
 * 「跟随工作流」语义（用户拍板）：Checkpoint 自带 VAE/CLIP，这类工作流不想被面板
 * 管着 —— 勾上跟随的资源种类**不改成占位符**，保留工作流里的原值，并把原值记录到
 * wfDefaults（出图时若工作流里仍是占位符，回落到记录的原值，见 comfyui.js buildVars）。
 */

import { LORA_SLOT_LIMIT, knownPlaceholders } from './comfyui.js';

/* ============ 基础判定 ============ */

/** API 格式里连线长这样：["3", 0]（来源节点 id + 输出槽序号）。 */
export function isLinkValue(v) {
  return Array.isArray(v)
    && v.length === 2
    && (typeof v[0] === 'string' || typeof v[0] === 'number')
    && typeof v[1] === 'number' && Number.isInteger(v[1]);
}

const hasPlaceholder = (v) => typeof v === 'string' && /%[a-z0-9_]+%/i.test(v);

/**
 * 识别工作流文本的格式。
 * API 格式：{ "3": { class_type, inputs } }（可能包一层 {prompt:{...}}）；
 * UI 格式：{ nodes: [...], links: [...] } —— ComfyUI「保存」按钮导出的那份。
 */
export function detectWorkflowFormat(text) {
  let parsed;
  try {
    parsed = JSON.parse(String(text || ''));
  } catch {
    return { format: 'unknown', error: '不是合法 JSON' };
  }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    if (Array.isArray(parsed.nodes) && Array.isArray(parsed.links)) return { format: 'ui', parsed };
    let wf = parsed;
    if (wf.prompt && typeof wf.prompt === 'object' && !wf.class_type) wf = wf.prompt;
    if (wf && typeof wf === 'object' && !Array.isArray(wf)
      && Object.values(wf).some((n) => n && typeof n === 'object' && 'class_type' in n)) {
      return { format: 'api', parsed: wf };
    }
  }
  return { format: 'unknown', error: '既不是 API 格式（{节点:{class_type}}）也不是 UI 格式（{nodes,links}）' };
}

/* ============ UI 格式 → API 格式 ============ */

/** object_info 里这些「类型引用」表示连线输入（而不是控件）。 */
const LINK_TYPES = new Set([
  'MODEL', 'CLIP', 'VAE', 'CONDITIONING', 'LATENT', 'IMAGE', 'MASK', 'CONTROL_NET',
  'UPSCALE_MODEL', 'STYLE_MODEL', 'CLIP_VISION', 'CLIP_VISION_OUTPUT', 'NOISE',
  'GUIDER', 'SAMPLER', 'SIGMAS', 'CLIP_OUT', 'AUDIO', 'LATENT_UPSCALE', 'WEIGHT_HOOK',
  'MODEL_CONNECTOR', 'PIN', 'TOKEN', 'SAMPLER_STATE',
]);
const WIDGET_TYPE_NAMES = new Set(['INT', 'FLOAT', 'NUMBER', 'STRING', 'BOOLEAN', 'COMBO']);
const SEED_CONTROL_WORDS = /^(fixed|increment|decrement|randomize)$/i;
const PASS_THROUGH_TYPES = new Set(['NoteNode', 'MarkdownNote']);

function isLinkDef(def) {
  const d = def?.[0];
  if (Array.isArray(d)) return d.length === 1 && LINK_TYPES.has(String(d[0]).toUpperCase());
  if (typeof d === 'string') return LINK_TYPES.has(d.toUpperCase());
  return false;
}

function isWidgetDef(def) {
  const d = def?.[0];
  if (Array.isArray(d)) return d.length > 1 || (d.length === 1 && !LINK_TYPES.has(String(d[0]).toUpperCase()));
  return typeof d === 'string' && WIDGET_TYPE_NAMES.has(d);
}

/** 控件值与定义类型粗对账 —— 错位时当场报出来，而不是静默填错格。 */
function widgetValueMatches(def, v) {
  const d = def?.[0];
  if (v === null || v === undefined) return false;
  if (Array.isArray(d)) {
    if (d.length > 1) return d.some((x) => String(x) === String(v)); // combo
    return true;
  }
  switch (d) {
    case 'INT': return typeof v === 'number' ? Number.isInteger(v) : Number.isInteger(Number(v)) && String(v).trim() !== '';
    case 'FLOAT': return typeof v === 'number' ? Number.isFinite(v) : v !== '' && Number.isFinite(Number(v));
    case 'BOOLEAN': return typeof v === 'boolean' || v === 'true' || v === 'false';
    case 'STRING': return typeof v === 'string';
    default: return true;
  }
}

/**
 * UI 格式转 API 格式。
 *
 * @param {object} ui      UI 格式 JSON（含 nodes / links）
 * @param {Function} fetchNodeInfo  async (classType) => 该节点的 object_info（借运行中的 ComfyUI 查控件顺序）
 * @returns {{ok:boolean, workflow?:object, problems:string[], warnings:string[]}}
 */
export async function convertUiToApi(ui, fetchNodeInfo) {
  const problems = [];
  const warnings = [];

  const links = new Map(); // linkId -> { from, slot }
  for (const l of (ui.links || [])) {
    // [linkId, originId, originSlot, targetId, targetSlot, type]
    links.set(String(l[0]), { from: String(l[1]), slot: l[2] });
  }
  const nodesById = new Map((ui.nodes || []).map((n) => [String(n.id), n]));

  /** 沿连线找来源，穿透 Reroute；PrimitiveNode 返回 { primitive: 节点 }。 */
  const resolveOrigin = (nodeId, slot, depth = 0) => {
    if (depth > 12) return null;
    const n = nodesById.get(String(nodeId));
    if (!n) return null;
    if (n.type === 'Reroute' || n.type === 'PythonJsReroute') {
      const inp = (n.inputs || []).find((x) => x?.link != null);
      if (!inp) return null;
      const lk = links.get(String(inp.link));
      if (!lk) return null;
      return resolveOrigin(lk.from, lk.slot, depth + 1);
    }
    if (n.type === 'PrimitiveNode') return { primitive: n };
    return { from: String(nodeId), slot };
  };

  const out = {};
  for (const n of (ui.nodes || [])) {
    const id = String(n.id);
    if (PASS_THROUGH_TYPES.has(n.type)) continue;
    if (n.type === 'Reroute' || n.type === 'PythonJsReroute' || n.type === 'PrimitiveNode') continue;

    const inputsOut = {};
    const connNames = new Set();

    for (const inp of (n.inputs || [])) {
      if (inp?.link == null) continue;
      const lk = links.get(String(inp.link));
      if (!lk) { problems.push(`节点 ${id} [${n.type}] 的输入「${inp.name}」连线找不到来源`); continue; }
      const origin = resolveOrigin(lk.from, lk.slot);
      if (!origin) { problems.push(`节点 ${id} [${n.type}] 的输入「${inp.name}」连到了空节点`); continue; }
      if (origin.primitive) {
        // PrimitiveNode 把一个字面值「注入」到连着的控件上 —— 取它的第一个控件值
        const pv = Array.isArray(origin.primitive.widgets_values) ? origin.primitive.widgets_values[0] : undefined;
        if (pv === undefined) { problems.push(`节点 ${id} [${n.type}] 的输入「${inp.name}」来自 PrimitiveNode，但取不到它的值`); continue; }
        inputsOut[inp.name] = pv;
        warnings.push(`节点 ${id} [${n.type}] 的「${inp.name}」来自 PrimitiveNode，已取其值 ${JSON.stringify(pv)?.slice(0, 60)}`);
      } else {
        inputsOut[inp.name] = [origin.from, origin.slot];
      }
      connNames.add(inp.name);
    }

    // 控件输入：按 object_info 的声明顺序消费 widgets_values
    let info = null;
    try { info = await fetchNodeInfo(n.type); } catch { /* 下面统一报 */ }
    if (!info) {
      problems.push(`节点 ${id}：ComfyUI 里查不到类型「${n.type}」—— 可能没装对应插件，或 ComfyUI 没在运行`);
      continue;
    }
    let wvals;
    if (Array.isArray(n.widgets_values)) wvals = [...n.widgets_values];
    else if (n.widgets_values && typeof n.widgets_values === 'object') { Object.assign(inputsOut, n.widgets_values); wvals = []; }
    else wvals = [];

    let wi = 0;
    const defs = [
      ...Object.entries(info?.input?.required || {}),
      ...Object.entries(info?.input?.optional || {}),
    ];
    for (const [name, def] of defs) {
      if (connNames.has(name)) continue;          // 已是连线
      if (isLinkDef(def)) continue;               // 连接型输入但没连线 → 留给 ComfyUI 校验报缺
      if (!isWidgetDef(def)) {
        if (typeof def?.[0] === 'string' && !WIDGET_TYPE_NAMES.has(def[0])) continue; // 未知自定义类型，跳过
        continue;
      }
      if (wi >= wvals.length) break;              // 控件值用尽（尾部可选控件缺省）
      let v = wvals[wi];
      wi += 1;
      if (def?.[1]?.control_after_generate && wi < wvals.length && SEED_CONTROL_WORDS.test(String(wvals[wi]))) {
        wi += 1;                                  // seed 控件后面跟着的「随机化策略」不是真参数
      }
      if (!widgetValueMatches(def, v)) {
        problems.push(`节点 ${id} [${n.type}] 的控件「${name}」期望 ${Array.isArray(def[0]) ? '选项' : def[0]}，但取到 ${JSON.stringify(v)?.slice(0, 40)} —— 控件值错位，请改用 API 格式导出`);
        continue;
      }
      inputsOut[name] = v;
    }
    if (wi < wvals.length) {
      warnings.push(`节点 ${id} [${n.type}] 有 ${wvals.length - wi} 个多余控件值未映射（自定义控件的常见现象，不影响提交）`);
    }

    out[id] = { class_type: n.type, inputs: inputsOut };
  }

  if (!Object.keys(out).length) problems.push('没有转换出任何节点');
  return { ok: problems.length === 0, workflow: out, problems, warnings };
}

/* ============ 确定性适配计划 ============ */

/** 资源加载节点 → 允许改成占位符的输入名。 */
const MODEL_LOADER_INPUTS = {
  CheckpointLoaderSimple: ['ckpt_name'],
  CheckpointLoader: ['ckpt_name'],
  unCLIPCheckpointLoader: ['ckpt_name'],
  CheckpointLoaderNF4: ['ckpt_name'],
  UNETLoader: ['unet_name'],
  UnetLoaderGGUF: ['unet_name'],
  UnetLoaderGGUFAdvanced: ['unet_name'],
};
const VAE_LOADER_INPUTS = {
  VAELoader: ['vae_name'],
  VAELoaderGGUF: ['vae_name'],
};
const CLIP_LOADER_INPUTS = { CLIPLoader: { clip_name: '%clip%', type: '%clip_type%' } };

const SAMPLER_INPUT_PH = {
  seed: '%seed%', noise_seed: '%seed%', steps: '%steps%', cfg: '%cfg%',
  sampler_name: '%sampler%', scheduler: '%scheduler%',
};
const LATENT_INPUT_PH = { width: '%width%', height: '%height%' };
const CLIP_SKIP_INPUT_PH = { stop_at_clip_layer: '%clip_skip%' };

/** 占位符 → 面板资源种类（仅这四种有「跟随工作流」）。 */
const PH_KIND = { '%model%': 'model', '%vae%': 'vae', '%clip%': 'clip', '%clip_type%': 'clipType' };
const KIND_DEFAULT_KEY = { model: 'model', vae: 'vae', clip: 'clip', clipType: 'clipType' };

const isSamplerNode = (cls) => /KSampler/i.test(String(cls || ''));
const isLatentNode = (cls) => /empty/i.test(String(cls || '')) && /latent/i.test(String(cls || ''));

/**
 * rgthree 的「Power Lora Loader (rgthree)」—— 多槽位 LoRA 加载器。
 *
 * 与标准 LoraLoader 的差别：LoRA 不是「一个节点一支」，而是**一个节点里挂着 N 个槽**
 * （`lora_1` / `lora_2` …，每个槽是 `{ on, lora, strength }` 对象）。
 * 用户用它来开关 / 增删 LoRA，所以适配必须支持它 —— 否则工作流自带的 LoRA
 * 面板完全看不到、也关不掉（2026-10-17 用户反馈）。
 */
const RGTHREE_LORA_RE = /^power\s*lora\s*loader/i;
const LORA_KEY_RE = /^lora_(\d+)$/i;
/**
 * 给 rgthree 加载器预留几个空槽（K2 变量版工作流的惯例是预留 5 个）。
 * 3 个够日常：再多会让每次出图都白加载几支 0 强度 LoRA。
 */
export const RGTHREE_RESERVE_SLOTS = 3;

/**
 * 生成适配计划。
 *
 * @param {object} workflow  API 格式工作流
 * @param {{follow?:object}} opts  follow = { model,vae,clip,clipType } 勾选状态
 * @returns {{
 *   patch: Object<string, Object<string, string>>,
 *   defaults: Object<string, string>,
 *   changes: string[], warnings: string[],
 *   loras: Array<{name:string, strength:number}>,
 *   backfill: object,
 * }}
 */
export function planAdaptation(workflow, opts = {}) {
  const follow = opts.follow || {};
  const patch = {};       // nodeId -> { input -> ph }
  const kept = {};        // nodeId -> { input -> 'KEEP' }（跟随工作流：保留原值）
  const defaults = { model: '', vae: '', clip: '', clipType: '' };
  const changes = [];
  const warnings = [];
  const backfill = {};
  const loras = [];

  /** 同一占位符的所有候选原值必须一致，否则宁可不改（两处不同值共用一个面板格 = 必错一个）。 */
  const groups = new Map(); // ph -> [{ id, input, value, kind }]
  const addCandidate = (ph, id, input, value, kind = '') => {
    if (!groups.has(ph)) groups.set(ph, []);
    groups.get(ph).push({ id, input, value, kind });
  };

  /* ---- ① 资源类加载节点 ---- */
  for (const [id, node] of Object.entries(workflow)) {
    const cls = String(node?.class_type || '');
    const ins = node?.inputs || {};

    if (MODEL_LOADER_INPUTS[cls]) {
      for (const f of MODEL_LOADER_INPUTS[cls]) {
        const v = ins[f];
        if (typeof v !== 'string' || !v.trim()) continue;
        if (hasPlaceholder(v)) continue;
        addCandidate('%model%', id, f, v, 'model');
      }
    }
    if (VAE_LOADER_INPUTS[cls]) {
      for (const f of VAE_LOADER_INPUTS[cls]) {
        const v = ins[f];
        if (typeof v !== 'string' || !v.trim()) continue;
        if (hasPlaceholder(v)) continue;
        addCandidate('%vae%', id, f, v, 'vae');
      }
    }
    if (CLIP_LOADER_INPUTS[cls]) {
      for (const [f, ph] of Object.entries(CLIP_LOADER_INPUTS[cls])) {
        const v = ins[f];
        if (typeof v !== 'string' || !String(v).trim()) continue;
        if (hasPlaceholder(v)) continue;
        addCandidate(ph, id, f, v, PH_KIND[ph]);
      }
    }
    if (/^DualCLIPLoader$/i.test(cls)) {
      const f1 = ins.clip_name1; const f2 = ins.clip_name2;
      warnings.push(`节点 ${id} [DualCLIPLoader] 有两个 CLIP 文件（${f1 || '?'} / ${f2 || '?'}）—— 绘灵面板只有一个 CLIP 格，保持工作流原值不改`);
    }
    if (/^CLIPSetLastLayer$/i.test(cls)) {
      for (const [f, ph] of Object.entries(CLIP_SKIP_INPUT_PH)) {
        const v = ins[f];
        if (v === undefined || hasPlaceholder(String(v))) continue;
        addCandidate(ph, id, f, v);
      }
    }
    if (isLatentNode(cls)) {
      for (const [f, ph] of Object.entries(LATENT_INPUT_PH)) {
        const v = ins[f];
        if (typeof v !== 'number' || hasPlaceholder(String(v))) continue;
        addCandidate(ph, id, f, v);
      }
    }
    if (isSamplerNode(cls)) {
      for (const [f, ph] of Object.entries(SAMPLER_INPUT_PH)) {
        const v = ins[f];
        if (v === undefined || isLinkValue(v) || hasPlaceholder(String(v))) continue;
        addCandidate(ph, id, f, v);
      }
    }
    /**
     * rgthree「Power Lora Loader」：一个节点挂 N 个槽（lora_1 / lora_2 …，
     * 每槽是 { on, lora, strength }）。把**已启用且有名字**的槽按编号接成
     * %loraN%，关着的槽不占号（否则面板中间留洞会让后面的槽整体前移）。
     */
    if (RGTHREE_LORA_RE.test(cls)) {
      const slotKeys = Object.keys(ins)
        .map((k) => ({ m: LORA_KEY_RE.exec(k), k }))
        .filter((x) => x.m && ins[x.k] && typeof ins[x.k] === 'object')
        .sort((a, b) => Number(a.m[1]) - Number(b.m[1]));

      let loraIdx = loras.length;   // 接续标准 LoraLoader 已占用的槽号
      let firstRealName = '';
      for (const { k, m } of slotKeys) {
        const slot = ins[k];
        const name = typeof slot.lora === 'string' ? slot.lora.trim() : '';
        if (!name || hasPlaceholder(name) || slot.on === false) continue;
        loraIdx += 1;
        if (loraIdx > LORA_SLOT_LIMIT) {
          warnings.push(`节点 ${id} [${cls}]：LoRA 超出 ${LORA_SLOT_LIMIT} 个槽位上限，槽 ${k} 保持原值`);
          break;
        }
        if (!firstRealName) firstRealName = name;
        loras.push({ name, strength: Number(slot.strength ?? 1) });
        (patch[id] ||= {})[`${k}.lora`] = `%lora${loraIdx}%`;
        (patch[id] ||= {})[`${k}.strength`] = `%lora${loraIdx}_strength%`;
        changes.push(`节点 ${id} [${cls}] 槽 ${k}：LoRA「${name}」→ %lora${loraIdx}%（强度 ${slot.strength ?? 1}）`);
      }

      /**
       * 预留若干空槽 —— 让面板能自己加新 LoRA（否则导入的工作流没有 %loraN% 入口，
       * 面板行只是空转：用户点半天没反应）。
       *
       * 空槽不能直接留空：空的 LoRA 槽会让占位符没值、提交前就报缺失。
       * 所以预填「工作流里第一支真实 LoRA + 强度 0」，面板上显示为**未启用**的行：
       * 0 强度对画面无影响，用户想加新 LoRA 就勾上、改名字和强度。
       */
      if (firstRealName) {
        const maxSlot = slotKeys.length ? Math.max(...slotKeys.map((x) => Number(x.m[1]))) : 0;
        for (let n = 1; n <= RGTHREE_RESERVE_SLOTS; n += 1) {
          const nextIdx = loraIdx + n;
          if (nextIdx > LORA_SLOT_LIMIT) break;
          const key = `lora_${maxSlot + n}`;
          (patch[id] ||= {})[`${key}.on`] = true;
          (patch[id] ||= {})[`${key}.lora`] = `%lora${nextIdx}%`;
          (patch[id] ||= {})[`${key}.strength`] = `%lora${nextIdx}_strength%`;
          loras.push({ name: firstRealName, strength: 0, enabled: false });
        }
        changes.push(`节点 ${id}：已预留 ${Math.min(RGTHREE_RESERVE_SLOTS, LORA_SLOT_LIMIT - loraIdx)} 个空槽（%lora${loraIdx + 1}%…）`
          + ' —— 面板最后几行就是它们，勾上并改名字即可加新 LoRA（强度 0 时不影响画面）');
      }
    }

    if (/^LoraLoader(ModelOnly)?$/i.test(cls)) {
      const name = typeof ins.lora_name === 'string' ? ins.lora_name.trim() : '';
      if (name && !hasPlaceholder(name) && loras.length < LORA_SLOT_LIMIT) {
        const slot = loras.length + 1;
        const strength = Number(ins.strength_model ?? ins.strength ?? 1);
        loras.push({ name, strength: Number.isFinite(strength) ? strength : 1 });
        (patch[id] ||= {}).lora_name = `%lora${slot}%`;
        if (ins.strength_model !== undefined && !isLinkValue(ins.strength_model)) {
          (patch[id] ||= {}).strength_model = `%lora${slot}_strength%`;
        }
        if (ins.strength_clip !== undefined && !isLinkValue(ins.strength_clip)) {
          (patch[id] ||= {}).strength_clip = `%lora${slot}_strength%`;
        }
        changes.push(`节点 ${id} [${cls}]：LoRA「${name}」→ %lora${slot}%（强度 ${strength}）`);
      } else if (name && loras.length >= LORA_SLOT_LIMIT) {
        warnings.push(`节点 ${id} [${cls}]：LoRA 超出 ${LORA_SLOT_LIMIT} 个槽位上限，保持原值`);
      }
    }
  }

  /* ---- ② 提示词：沿采样器的 positive/negative 连线追踪 ---- */
  const promptTargets = new Map(); // 'positive' | 'negative' -> Set(nodeId)
  for (const [id, node] of Object.entries(workflow)) {
    const cls = String(node?.class_type || '');
    if (!isSamplerNode(cls) && !/^SamplerCustom(Advanced)?$/i.test(cls)) continue;
    for (const side of ['positive', 'negative']) {
      const link = node?.inputs?.[side];
      if (!isLinkValue(link)) continue;
      const target = workflow[String(link[0])];
      if (!target) continue;
      if (!/^CLIPTextEncode/i.test(String(target.class_type || ''))) {
        warnings.push(`采样器 ${id} 的 ${side} 连到 ${target.class_type}（不是 CLIPTextEncode）—— 未能自动定位${side === 'positive' ? '正向' : '负向'}提示词`);
        continue;
      }
      if (!promptTargets.has(side)) promptTargets.set(side, new Set());
      promptTargets.get(side).add(String(link[0]));
    }
  }
  for (const [side, ids] of promptTargets) {
    if (ids.size !== 1) {
      warnings.push(`多个采样器的 ${side} 连到了不同节点 —— 不敢自动定${side === 'positive' ? '正向' : '负向'}提示词，请手工确认`);
      continue;
    }
    const nid = Array.from(ids)[0];
    const text = workflow[nid]?.inputs?.text;
    if (typeof text !== 'string' || hasPlaceholder(text)) continue;
    addCandidate(side === 'positive' ? '%prompt%' : '%negative_prompt%', nid, 'text', text);
  }

  /* ---- ③ 唯一性裁决 + 跟随工作流 ---- */
  for (const [ph, cands] of groups) {
    const kind = cands[0].kind;
    const values = cands.map((c) => String(c.value));
    const unique = values.every((v) => v === values[0]);

    // 原值记录不因冲突跳过 —— 冲突时保留的是工作流原值，第一处就是「工作流默认」
    if (kind && KIND_DEFAULT_KEY[kind]) {
      defaults[KIND_DEFAULT_KEY[kind]] = values[0];
    }

    if (!unique) {
      const preview = Array.from(new Set(values)).slice(0, 3).join(' / ');
      warnings.push(`工作流里有 ${cands.length} 处不同的「${ph}」原值（${preview}…）—— 共用一个面板格必错一个，已全部保留原值，请手工处理`);
      continue;
    }
    const value = cands[0].value;

    const isFollow = kind && follow[kind];
    for (const c of cands) {
      if (isFollow) {
        (kept[c.id] ||= {})[c.input] = 'KEEP';
        changes.push(`节点 ${c.id} 的「${c.input}」保留工作流原值「${String(value).slice(0, 60)}」（跟随工作流）`);
      } else {
        (patch[c.id] ||= {})[c.input] = ph;
        changes.push(`节点 ${c.id} 的「${c.input}」→ ${ph}（原值 ${String(value).slice(0, 60)}）`);
      }
    }

    // 面板回填：跟随的种类不动面板；其余把工作流原值回填成面板当前值
    if (kind && KIND_DEFAULT_KEY[kind]) {
      backfill[kind] = { value: String(value), follow: !!isFollow };
    } else if (ph === '%width%') backfill.width = Number(value);
    else if (ph === '%height%') backfill.height = Number(value);
    else if (ph === '%steps%') backfill.steps = Number(value);
    else if (ph === '%cfg%') backfill.cfg = Number(value);
    else if (ph === '%sampler%') backfill.sampler = String(value);
    else if (ph === '%scheduler%') backfill.scheduler = String(value);
    else if (ph === '%clip_skip%') backfill.clipSkip = Number(value);
    else if (ph === '%negative_prompt%') backfill.negativePrompt = String(value);
  }

  return { patch, kept, defaults, changes, warnings, loras, backfill };
}

/* ============ 补丁应用 ============ */

/**
 * 按点路径写入（rgthree 的 LoRA 槽是嵌套对象：`lora_1.lora`）。
 * 中间层不存在就**新建** —— 预留的空槽就是这样造出来的（工作流里本来没有那个 lora_N）。
 */
function setPathCreate(root, path, value) {
  const parts = String(path).split('.');
  let cur = root;
  for (let i = 0; i < parts.length - 1; i += 1) {
    if (cur[parts[i]] === null || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = value;
  return true;
}

/** 把补丁写进工作流（深拷贝，不动原对象）。键支持 'input' 与 'lora_1.lora' 两种。 */
export function applyPatch(workflow, patch) {
  const out = JSON.parse(JSON.stringify(workflow));
  for (const [id, inputsObj] of Object.entries(patch || {})) {
    const node = out[id];
    if (!node?.inputs) continue;
    for (const [input, ph] of Object.entries(inputsObj)) {
      if (String(input).includes('.')) setPathCreate(node.inputs, input, ph);
      else if (input in node.inputs) node.inputs[input] = ph;
    }
  }
  return { workflow: out, text: JSON.stringify(out, null, 1) };
}

/* ============ 补 LoRA 槽位（给工作流串接标准 LoRA 节点） ============ */

/** 工作流里已经用了的最大 LoRA 槽号（看 %loraN% 出现到几）。 */
export function maxLoraSlotIn(workflow) {
  let max = 0;
  const walk = (n) => {
    if (typeof n === 'string') {
      for (const m of n.matchAll(/%lora(\d+)%/gi)) max = Math.max(max, Number(m[1]));
    } else if (Array.isArray(n)) n.forEach(walk);
    else if (n && typeof n === 'object') Object.values(n).forEach(walk);
  };
  walk(workflow);
  return max;
}

/**
 * 在模型链的末端串接 N 个标准 `LoraLoaderModelOnly`，把 %loraK% 槽位补出来。
 *
 * 为什么需要：K2 变量版工作流自带 5 个槽（%lora1%~%lora5%），想再加就没入口了；
 * 新导入的工作流更是可能一个槽都没有。面板上的行没有 %loraN% 可落 = 空转。
 *
 * 做法（不猜链路）：找**真正消费 MODEL 的节点**（KSampler 系）的 model 连线 →
 * 把原本指向的源，替换成「新 LoRA 链的最后一个节点」；
 * 链上每个新节点吃前一个节点的 MODEL 输出。这样串行叠加，语义与手工串接一致。
 *
 * @returns {{ok:boolean, workflow?:object, text?:string, slots?:number[], problems:string[]}}
 */
export function insertLoraSlots(workflow, { count = 3, startSlot, withClip = false } = {}) {
  const problems = [];
  const wf = JSON.parse(JSON.stringify(workflow));
  const want = Math.max(0, Math.min(LORA_SLOT_LIMIT, Number(count) || 0));
  if (!want) return { ok: true, workflow: wf, slots: [], problems };

  // ① 找消费 MODEL 的采样器，定位 model 链路的源
  const consumers = [];
  for (const [id, n] of Object.entries(wf)) {
    const cls = String(n?.class_type || '');
    if (!isSamplerNode(cls)) continue;
    const link = n?.inputs?.model;
    if (isLinkValue(link)) consumers.push({ id, link, cls });
  }
  if (!consumers.length) {
    problems.push('没找到吃 MODEL 的采样器节点（KSampler 系）—— 不知道该把 LoRA 串在哪');
    return { ok: false, problems };
  }
  const srcKey = `${consumers[0].link[0]}#${consumers[0].link[1]}`;
  const mixed = consumers.filter((c) => `${c.link[0]}#${c.link[1]}` !== srcKey);
  if (mixed.length) {
    problems.push(`多个采样器的 model 来源不一致（${consumers.map((c) => c.id).join('/')}）—— 手工确认后再补槽`);
    return { ok: false, problems };
  }

  /* ①b 带 CLIP 的槽还要串进 CLIP 链：找所有吃 clip 的节点（正负提示词编码各一个，
     通常同源），把它们的 clip 改指新链的 CLIP 输出。 */
  let clipConsumers = [];
  let clipSrc = null;
  if (withClip) {
    for (const [id, n] of Object.entries(wf)) {
      const fv = n?.inputs?.clip;
      if (isLinkValue(fv)) clipConsumers.push({ id, link: fv });
    }
    if (!clipConsumers.length) {
      problems.push('没找到吃 CLIP 的节点（CLIPTextEncode）—— 带 CLIP 的 LoRA 不知道往哪串');
      return { ok: false, problems };
    }
    const ck = `${clipConsumers[0].link[0]}#${clipConsumers[0].link[1]}`;
    const mixedC = clipConsumers.filter((c) => `${c.link[0]}#${c.link[1]}` !== ck);
    if (mixedC.length) {
      problems.push(`多个节点的 clip 来源不一致（${[...new Set(clipConsumers.map((c) => c.id))].join('/')}）—— 手工确认后再补 CLIP 槽`);
      return { ok: false, problems };
    }
    clipSrc = [String(clipConsumers[0].link[0]), clipConsumers[0].link[1]];
  }

  // ② 新节点 id：从现有最大数字 id +1 开始（避开字符串 id 冲突）
  let maxId = 0;
  for (const k of Object.keys(wf)) {
    const num = Number(k);
    if (Number.isInteger(num)) maxId = Math.max(maxId, num);
  }

  const first = (startSlot ?? maxLoraSlotIn(wf)) + 1;
  if (first + want - 1 > LORA_SLOT_LIMIT) {
    problems.push(`补到 %lora${first + want - 1}% 超过 ${LORA_SLOT_LIMIT} 个槽位上限`);
    return { ok: false, problems };
  }

  const slots = [];
  let prev = [String(consumers[0].link[0]), consumers[0].link[1]];
  let clipPrev = clipSrc ? [String(clipSrc[0]), clipSrc[1]] : null;
  for (let i = 0; i < want; i += 1) {
    maxId += 1;
    const id = String(maxId);
    const slot = first + i;
    const base = {
      lora_name: `%lora${slot}%`,
      strength_model: `%lora${slot}_strength%`,
      model: [String(prev[0]), prev[1]],
    };
    if (withClip) {
      // LoraLoader：MODEL 与 CLIP 都过一遍 LoRA（用户要「权重 LoRA 里的 CLIP」时用它）
      wf[id] = {
        class_type: 'LoraLoader',
        _meta: { title: `绘灵 LoRA 槽 ${slot}` },
        inputs: { ...base, strength_clip: `%lora${slot}_strength%`, clip: [String(clipPrev[0]), clipPrev[1]] },
      };
      clipPrev = [id, 1];
    } else {
      wf[id] = {
        class_type: 'LoraLoaderModelOnly',
        _meta: { title: `绘灵 LoRA 槽 ${slot}` },
        inputs: base,
      };
    }
    slots.push(slot);
    prev = [id, 0];
  }

  // ③ 把所有原本吃旧源的 model / clip 输入，改指新链末尾
  for (const c of consumers) wf[c.id].inputs.model = [String(prev[0]), prev[1]];
  if (withClip) for (const c of clipConsumers) wf[c.id].inputs.clip = [String(clipPrev[0]), clipPrev[1]];

  return { ok: true, workflow: wf, text: JSON.stringify(wf, null, 1), slots, problems };
}

/**
 * 工作流里已有的「绘灵 LoRA 槽」是哪种 —— 用来让新补的槽自动沿用同一类型。
 * @returns {'clip'|'model'|null}  '(null = 一个槽都没有，随调用方默认)'
 */
export function loraSlotTypeIn(workflow) {
  for (const [, n] of Object.entries(workflow || {})) {
    if (!/^绘灵\s*LoRA\s*槽\s*\d+$/.test(String(n?._meta?.title || ''))) continue;
    const cls = String(n?.class_type || '');
    if (/^LoraLoader$/.test(cls)) return 'clip';
    if (/^LoraLoaderModelOnly$/.test(cls)) return 'model';
  }
  return null;
}

/**
 * 删掉第 slot 号 LoRA 槽，并把比它大的槽号依次前移一号（与面板删行的语义对齐：
 * 删第 K 行 = 不再用第 K 个 LoRA，后面整体前移，行号↔槽号对应关系保持不变）。
 *
 * 为什么只认「绘灵补的标准槽」：用户自己在 ComfyUI 里搭的 LoRA 节点，名字与链路
 * 各有讲究，删错一个整条模型链就断 —— 只动 `LoraLoader(ModelOnly)` 且带
 * 「绘灵 LoRA 槽 N」标记的；没有标记时退而求其次，要求 `lora_name` 精确等于
 * `%loraN%`（模板化后的标准形态）。rgthree 的嵌套槽不在删除范围。
 *
 * 链重接：被删节点的下游直接改吃被删节点的 model 源（串行链少一环，语义不变）。
 *
 * @returns {{ok:boolean, workflow?:object, text?:string, removed?:number, problems:string[]}}
 */
export function removeLoraSlot(workflow, slot) {
  const problems = [];
  const wf = JSON.parse(JSON.stringify(workflow));
  const k = Math.trunc(Number(slot));
  if (!(k >= 1 && k <= LORA_SLOT_LIMIT)) {
    problems.push(`槽号要在 1-${LORA_SLOT_LIMIT} 之间`);
    return { ok: false, problems };
  }

  // ① 定位被删节点：只认绘灵补的标准槽 —— LoraLoaderModelOnly（仅模型）或 LoraLoader（带 CLIP）。
  //    先认「绘灵 LoRA 槽 N」标题，退而求其次 lora_name 精确匹配。
  let delId = null;
  for (const [id, n] of Object.entries(wf)) {
    if (!/^LoraLoader(ModelOnly)?$/.test(String(n?.class_type || ''))) continue;
    if (String(n?._meta?.title || '').replace(/\s+/g, ' ') === `绘灵 LoRA 槽 ${k}`) { delId = id; break; }
  }
  if (!delId) {
    for (const [id, n] of Object.entries(wf)) {
      if (!/^LoraLoader(ModelOnly)?$/.test(String(n?.class_type || ''))) continue;
      if (String(n?.inputs?.lora_name || '') === `%lora${k}%`) { delId = id; break; }
    }
  }
  if (!delId) {
    problems.push(`工作流里没有第 ${k} 号标准 LoRA 槽（%lora${k}%）—— 只能删「补齐槽位」补出的标准槽`);
    return { ok: false, problems };
  }

  // ② 下游重接（★ 按输出口区分）：ComfyUI 的连线是 [节点id, 输出口序号]，
  //    LoraLoader 的输出是 [MODEL, CLIP] —— 吃 [id,0] 的接回 model 源，吃 [id,1] 的接回 clip 源。
  //    不区分会把 CLIP 消费者接到 MODEL 上，CLIP 链当场断掉。
  const D = wf[delId];
  const srcModel = D?.inputs?.model;
  const srcClip = D?.inputs?.clip;
  for (const [, n] of Object.entries(wf)) {
    for (const [fname, fv] of Object.entries(n?.inputs || {})) {
      if (!Array.isArray(fv) || String(fv[0]) !== String(delId)) continue;
      const wantClip = Number(fv[1]) === 1;
      const src = wantClip ? srcClip : srcModel;
      if (!Array.isArray(src)) {
        problems.push(`第 ${k} 号槽的下游要接 ${wantClip ? 'CLIP' : 'MODEL'}，但被删节点上没有对应的 ${wantClip ? 'clip' : 'model'} 输入 —— 已放弃删除`);
        return { ok: false, problems };
      }
      n.inputs[fname] = [String(src[0]), src[1]];
    }
  }

  // ③ 删节点
  delete wf[delId];

  // ④ 槽号 > k 的绘灵槽依次前移一号（先收集后修改）
  const rest = [];
  for (const [, n] of Object.entries(wf)) {
    const m = String(n?._meta?.title || '').match(/^绘灵\s*LoRA\s*槽\s*(\d+)$/);
    if (m) rest.push({ n, slot: Number(m[1]) });
  }
  for (const { n, slot: s } of rest.sort((a, b) => a.slot - b.slot)) {
    if (s <= k) continue;
    const ns = s - 1;
    n.inputs.lora_name = `%lora${ns}%`;
    if ('strength_model' in n.inputs) n.inputs.strength_model = `%lora${ns}_strength%`;
    if ('strength' in n.inputs) n.inputs.strength = `%lora${ns}_strength%`;
    if ('strength_clip' in n.inputs) n.inputs.strength_clip = `%lora${ns}_strength%`;
    if (n._meta) n._meta.title = `绘灵 LoRA 槽 ${ns}`;
  }

  return { ok: true, workflow: wf, text: JSON.stringify(wf, null, 1), removed: k, problems };
}

/** 取节点的 model 输入源（[节点id, 输出口]），没有就 null。 */
function delNode_modelSource(node) {
  const m = node?.inputs?.model;
  return Array.isArray(m) ? [String(m[0]), m[1]] : null;
}

/* ============ AI 补丁：提示词 / 解析 / 校验 ============ */

/**
 * (class_type, input) → 允许的占位符。AI 的补丁只许落在这张表内 ——
 * 语义上安全的车道由代码圈死，模型只负责「选哪个节点」这类模糊判断。
 */
const AI_PATCH_ALLOWED = (() => {
  const m = new Map(); // class_type(精确) -> { input: [ph...] }
  const put = (cls, input, phs) => {
    if (!m.has(cls)) m.set(cls, {});
    m.get(cls)[input] = phs;
  };
  for (const [cls, fields] of Object.entries(MODEL_LOADER_INPUTS)) {
    for (const f of fields) put(cls, f, ['%model%']);
  }
  for (const [cls, fields] of Object.entries(VAE_LOADER_INPUTS)) {
    for (const f of fields) put(cls, f, ['%vae%']);
  }
  for (const [cls, map] of Object.entries(CLIP_LOADER_INPUTS)) {
    for (const [f, ph] of Object.entries(map)) put(cls, f, [ph]);
  }
  for (const [f, ph] of Object.entries(CLIP_SKIP_INPUT_PH)) put('CLIPSetLastLayer', f, [ph]);
  for (const [f, ph] of Object.entries(SAMPLER_INPUT_PH)) {
    put('KSampler', f, [ph]); put('KSamplerAdvanced', f, [ph]);
  }
  for (const [f, ph] of Object.entries(LATENT_INPUT_PH)) {
    put('EmptyLatentImage', f, [ph]); put('EmptySD3LatentImage', f, [ph]);
  }
  put('CLIPTextEncode', 'text', ['%prompt%', '%negative_prompt%']);
  for (let i = 1; i <= LORA_SLOT_LIMIT; i += 1) {
    put('LoraLoader', 'lora_name', [`%lora${i}%`]);
    put('LoraLoader', 'strength_model', [`%lora${i}_strength%`]);
    put('LoraLoader', 'strength_clip', [`%lora${i}_strength%`]);
    put('LoraLoaderModelOnly', 'lora_name', [`%lora${i}%`]);
    put('LoraLoaderModelOnly', 'strength', [`%lora${i}_strength%`]);
  }
  return m;
})();

/** 宽匹配：精确类名之外，KSampler 系变体 / Empty 潜图变体 / CLIPTextEncode 系也认。 */
function allowedPlaceholdersFor(cls, input) {
  const exact = AI_PATCH_ALLOWED.get(cls)?.[input];
  if (exact) return exact;
  if (isSamplerNode(cls) && SAMPLER_INPUT_PH[input]) return [SAMPLER_INPUT_PH[input]];
  if (isLatentNode(cls) && LATENT_INPUT_PH[input]) return [LATENT_INPUT_PH[input]];
  if (/^CLIPTextEncode/i.test(cls) && input === 'text') return ['%prompt%', '%negative_prompt%'];
  if (/^CLIPSetLastLayer$/i.test(cls) && input === 'stop_at_clip_layer') return ['%clip_skip%'];
  if (/^LoraLoader(ModelOnly)?$/i.test(cls)) {
    const m = /^(?:lora_name|strength_model|strength_clip|strength)$/.test(input);
    if (m) return null; // LoRA 槽位由本地计划分配，AI 不许另指槽号
  }
  return null;
}

/** 组装 AI 分析的消息（走绘灵既有的出词通道，见 api.js callAnalyzeLLM）。 */
export function buildAiMessages(workflow, plan, opts = {}) {
  const follow = opts.follow || {};
  const followDesc = Object.entries(follow).filter(([, v]) => v).map(([k]) => k).join('、') || '无';

  const system = [
    '你是 ComfyUI 工作流适配助手。用户会给你一个 ComfyUI「API 格式」的工作流 JSON，',
    '你的任务是输出一个「补丁」对象，指出哪些节点的哪些输入应该改成绘灵的占位符。',
    '',
    '【可用占位符】',
    '%model% 模型文件名（Checkpoint/UNET 加载节点的 ckpt_name/unet_name）',
    '%vae% VAE 文件名（VAELoader 的 vae_name）',
    '%clip% 文本编码器文件名（CLIPLoader 的 clip_name）',
    '%clip_type% CLIPLoader 的 type 枚举值',
    '%clip_skip% CLIPSetLastLayer 的 stop_at_clip_layer',
    '%prompt% 正向提示词（连接到采样器 positive 的 CLIPTextEncode 的 text）',
    '%negative_prompt% 负向提示词（连接到 negative 的 CLIPTextEncode 的 text）',
    '%seed% %steps% %cfg% %sampler% %scheduler% 采样参数',
    '%width% %height% 空潜图尺寸',
    '%lora1%..%lora20% 与 %lora1_strength%..（LoRA 槽位由本地规则分配，你不许输出 LoRA 相关补丁）',
    '',
    '【补丁格式】只输出一个 JSON 对象：',
    '{"patches":{"节点id":{"输入名":"%占位符%" 或 "KEEP"}},"notes":["一句一个说明"]}',
    '- "KEEP" 表示这个输入保留工作流原值（例如 Checkpoint 自带 VAE/CLIP）',
    '- 只能改「输入值是字符串或数字」的字段；["3",0] 这种连线一律不许动',
    '- 不许增删节点、不许改结构、不许发明上面列表之外的占位符',
    '- 采样器的 seed/steps/cfg/sampler_name/scheduler、潜图的 width/height、',
    '  正向/负向 CLIPTextEncode 的 text，通常都应改成对应占位符',
    `- 用户勾了「跟随工作流」的资源种类：${followDesc} —— 这些一律 KEEP`,
    '- 拿不准的就输出 KEEP，宁缺毋滥',
    '',
    '【硬性要求】只输出 JSON 本体，不要 markdown 代码块，不要任何解释文字。',
  ].join('\n');

  const decided = {};
  for (const [id, inputsObj] of Object.entries(plan.patch)) {
    decided[id] = { ...(decided[id] || {}), ...inputsObj };
  }
  for (const [id, inputsObj] of Object.entries(plan.kept || {})) {
    decided[id] = { ...(decided[id] || {}), ...inputsObj };
  }

  const user = [
    '【本地规则已确定的补丁】（这些不用你重复判断；你的价值在补全本地规则搞不定的部分）：',
    JSON.stringify(decided),
    '',
    plan.warnings.length ? `【本地规则拿不准的问题】\n- ${plan.warnings.join('\n- ')}` : '【本地规则没有遗留问题】',
    '',
    '【工作流 JSON】',
    JSON.stringify(workflow),
  ].join('\n');

  return [{ role: 'system', content: system }, { role: 'user', content: user }];
}

/** 解析 AI 返回的补丁文本（容忍代码块围栏与前后杂文字）。 */
export function parseAiPatchText(text) {
  let t = String(text || '').trim();
  t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('AI 返回里找不到 JSON 对象');
  const obj = JSON.parse(t.slice(start, end + 1));
  if (!obj || typeof obj !== 'object' || Array.isArray(obj) || typeof obj.patches !== 'object' || !obj.patches) {
    throw new Error('AI 返回的 JSON 缺少 patches 字段');
  }
  return obj;
}

/**
 * 校验 AI 补丁，产出「可合并的增量」。
 * 只做结构 + 白名单校验；与本地计划冲突的条目在这里就被丢弃（本地规则胜出）。
 */
export function validateAiPatch(workflow, aiObj, localPlan) {
  const problems = [];
  const notes = [];
  const additions = {};

  for (const [id, inputsObj] of Object.entries(aiObj.patches || {})) {
    const node = workflow[id];
    if (!node?.inputs) { problems.push(`节点 ${id} 不存在（AI 补丁）`); continue; }
    if (!inputsObj || typeof inputsObj !== 'object') { problems.push(`节点 ${id} 的补丁不是对象`); continue; }

    for (const [input, val] of Object.entries(inputsObj)) {
      // 本地已裁决的条目：AI 意见不覆盖（提示词/参数的连线追踪是实锤，比模型猜的可靠）
      if (localPlan?.patch?.[id]?.[input] || localPlan?.kept?.[id]?.[input]) {
        notes.push(`节点 ${id} 的「${input}」本地已裁决，忽略 AI 意见（${val}）`);
        continue;
      }
      if (val === 'KEEP') {
        if (!(input in node.inputs)) {
          problems.push(`节点 ${id} 里没有输入「${input}」（AI 补丁的 KEEP）`);
        } else {
          notes.push(`节点 ${id} 的「${input}」AI 建议保留原值`);
        }
        continue;
      }
      if (typeof val !== 'string' || !/^%[a-z0-9_]+%$/i.test(val)) {
        problems.push(`节点 ${id} 的「${input}」AI 给了非法值：${JSON.stringify(val)?.slice(0, 40)}`);
        continue;
      }
      if (!knownPlaceholders().has(val.toLowerCase())) {
        problems.push(`节点 ${id} 的「${input}」AI 用了绘灵不认识的占位符 ${val}`);
        continue;
      }
      const cur = node.inputs[input];
      if (isLinkValue(cur)) {
        problems.push(`节点 ${id} 的「${input}」是连线，AI 却想改成 ${val} —— 已拒绝`);
        continue;
      }
      if (hasPlaceholder(String(cur))) continue; // 已经是占位符，无需改
      const allowed = allowedPlaceholdersFor(String(node.class_type || ''), input);
      if (!allowed || !allowed.includes(val)) {
        problems.push(`节点 ${id} [${node.class_type}] 的「${input}」不允许改成 ${val}（白名单外）`);
        continue;
      }
      (additions[id] ||= {})[input] = val;
    }
  }

  // LoRA 槽位连续性：AI 不许指槽位，这里兜一道（万一白名单未来放开）
  const loraSlots = new Set();
  for (const inputsObj of Object.values(additions)) {
    for (const ph of Object.values(inputsObj)) {
      const m = /^%lora(\d+)%$/i.exec(ph);
      if (m) loraSlots.add(Number(m[1]));
    }
  }
  if (loraSlots.size) {
    const max = Math.max(...loraSlots);
    for (let i = 1; i <= max; i += 1) {
      if (!loraSlots.has(i)) problems.push(`AI 补丁的 LoRA 槽位不连续：缺 %lora${i}%`);
    }
  }

  return { ok: problems.length === 0, additions, problems, notes };
}

/** 合并 AI 增量进本地计划（就地修改 plan.patch）。 */
export function mergeAiAdditions(plan, additions) {
  for (const [id, inputsObj] of Object.entries(additions || {})) {
    plan.patch[id] = { ...(plan.patch[id] || {}), ...inputsObj };
  }
}
