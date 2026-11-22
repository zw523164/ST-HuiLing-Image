/**
 * 绘灵 · 画质增强控制（v0.9.108）
 *
 * 起因（2026-10-20 用户报）：工作流里串了 4 个 `NvidiaDLSSImageUpscale` 和 1 个
 * `GrowMaskWithBlur`（遮罩羽化），但面板上完全够不着 —— 想调降噪强度、想调羽化半径，
 * 只能进 ComfyUI 改工作流再重新导一遍。
 *
 * 与 `resSelector.js` 同一套纪律：
 *   ★ 全程**纯函数**：先深拷贝再改，绝不修改传进来的工作流对象
 *     （`config.backends.comfyui.workflowJson` 解析出的对象可能被别处引用，
 *      就地改会变成「改一次参数就永久污染配置」这种极难排查的问题）。
 *   ★ 只写**白名单字段**：`image` / `mask` 这些是节点引用数组 `["79",0]`，
 *     误写成数字会直接断线。所以注入按字段表逐项校验，表外的一律不碰。
 *   ★ **按节点 id 存值**，但工作流里没有该 id 时静默跳过 ——
 *     换工作流后 id 变了，旧配置不会污染新工作流。
 *
 * 语义（很关键，决定了 UI 怎么排）：
 *   主图分支是三连击（DLSS A → B → C，降噪强度 2 → 2 → 0 渐进），
 *   人脸分支是单独一次（DLSS D，强度 1）。
 *   所以 4 个节点**参数本来就各不相同**，不能合并成一组值。
 */

/** 节点类型名 —— ComfyUI API 格式里的 `class_type`，一字不差 */
export const DLSS_CLASS = 'NvidiaDLSSImageUpscale';
export const MASK_BLUR_CLASS = 'GrowMaskWithBlur';

/**
 * DLSS 节点可调参数表。
 *
 * `type` 决定 UI 控件与注入时的类型守卫：
 *   number → 数字输入（注入前 Number() 并校验 isFinite）
 *   bool   → 复选（注入前强制 Boolean）
 *   enum   → 文本 + 候选下拉（注入前 String().trim()，空串不覆盖）
 */
export const DLSS_FIELDS = [
  { key: 'nr_intensity', label: '降噪强度', type: 'number', step: 0.1, hint: '主图三连击一般 2 → 2 → 0，越靠后越轻' },
  { key: 'output_detail_strength', label: '输出细节', type: 'number', step: 0.1 },
  { key: 'local_structure_strength', label: '局部结构', type: 'number', step: 0.1 },
  { key: 'skin_structure_strength', label: '皮肤结构', type: 'number', step: 0.1 },
  { key: 'local_tone_strength', label: '局部影调', type: 'number', step: 0.1 },
  { key: 'dlss_model_preset', label: '模型预设', type: 'enum', options: ['M', 'Default'] },
  { key: 'nr_preset', label: '降噪预设', type: 'enum', options: ['Default'] },
  { key: 'nr_style', label: '降噪风格', type: 'enum', options: ['Default'] },
  { key: 'upscale_mode', label: '上采样模式', type: 'enum', options: ['1× (DLAA / native)', '2×', '4×'] },
  { key: 'automatic_mask', label: '自动遮罩', type: 'bool' },
  { key: 'require_neural_upscaling', label: '强制神经上采样', type: 'bool' },
];

/**
 * 遮罩羽化可调参数表 —— 按用户要求只放最常调的两个，
 * 其余（tapered_corners / lerp_alpha / decay_factor / fill_holes）保持工作流原样。
 */
export const MASK_FIELDS = [
  { key: 'expand', label: '扩展', type: 'number', step: 1, hint: '往外扩多少像素，消除缩放后边缘的断层' },
  { key: 'blur_radius', label: '模糊半径', type: 'number', step: 0.1, hint: '羽化过渡带宽度，越大越软' },
];

const DLSS_KNOWN = new Set(DLSS_FIELDS.map((f) => f.key));
const MASK_KNOWN = new Set(MASK_FIELDS.map((f) => f.key));

/** 上采样模式候选 —— 体检时判「工作流里的值不在选项里」用（从字段表派生，不另存一份） */
export const DLSS_UPSCALE_MODES = DLSS_FIELDS.find((f) => f.key === 'upscale_mode')?.options || [];

function asObject(workflow) {
  if (!workflow) return null;
  if (typeof workflow === 'string') {
    try { return JSON.parse(workflow); } catch { return null; }
  }
  if (typeof workflow === 'object') return workflow;
  return null;
}

function clone(obj) {
  try { return structuredClone(obj); }
  catch { return JSON.parse(JSON.stringify(obj)); }
}

/** 节点标题（面板上给用户认节点用，没有就退回 id） */
function titleOf(node, id) {
  const t = node?._meta?.title || node?._meta?.name;
  return String(t || `#${id}`);
}

/**
 * 扫描工作流里有哪些画质增强节点、当前各是什么值。
 *
 * 返回的 `values` 是**工作流现值**，面板拿它当默认值 ——
 * 用户没动过的字段就不会写进配置，换工作流也不会带上旧值。
 *
 * @param {object|string} workflow API 格式工作流
 * @returns {{dlss:Array<{id:string,title:string,values:object}>,
 *            mask:Array<{id:string,title:string,values:object}>}}
 */
export function detectEnhance(workflow) {
  const wf = asObject(workflow);
  const out = { dlss: [], mask: [] };
  if (!wf) return out;

  for (const [id, node] of Object.entries(wf)) {
    const ct = node?.class_type;
    if (ct === DLSS_CLASS) {
      const inputs = node.inputs || {};
      const values = {};
      for (const f of DLSS_FIELDS) {
        if (inputs[f.key] !== undefined) values[f.key] = inputs[f.key];
      }
      out.dlss.push({ id, title: titleOf(node, id), values });
    } else if (ct === MASK_BLUR_CLASS) {
      const inputs = node.inputs || {};
      const values = {};
      for (const f of MASK_FIELDS) {
        if (inputs[f.key] !== undefined) values[f.key] = inputs[f.key];
      }
      out.mask.push({ id, title: titleOf(node, id), values });
    }
  }

  // 按节点 id 数值排序 —— 和 ComfyUI 里的处理顺序基本一致，面板上也更好认
  const byId = (a, b) => (Number(a.id) || 0) - (Number(b.id) || 0);
  out.dlss.sort(byId);
  out.mask.sort(byId);
  return out;
}

/**
 * 把面板值写进工作流（返回**新对象**，入参不变）。
 *
 * @param {object|string} workflow 原始工作流
 * @param {{dlss?:{enabled?:boolean,nodes?:object},
 *          mask?:{enabled?:boolean,nodes?:object}}} opts
 *        nodes 形如 `{ "7": { nr_intensity: 2, automatic_mask: true } }`
 * @returns {{workflow:object|null, changed:boolean, touched:{dlss:number,mask:number}, notes:string[]}}
 */
export function applyEnhance(workflow, opts = {}) {
  const src = asObject(workflow);
  if (!src) {
    return { workflow: null, changed: false, touched: { dlss: 0, mask: 0 }, notes: ['工作流不是合法 JSON，画质增强已跳过'] };
  }

  const wf = clone(src);
  const notes = [];
  const touched = { dlss: 0, mask: 0 };
  let changed = false;

  const dlssOpt = opts.dlss || {};
  const maskOpt = opts.mask || {};

  /** 按字段表逐项校验后写入；返回是否真的变了 */
  const writeFields = (inputs, fieldsDef, knownSet, panelValues) => {
    let did = false;
    for (const [key, raw] of Object.entries(panelValues || {})) {
      if (!knownSet.has(key)) continue;                 // 表外字段不碰
      const def = fieldsDef.find((f) => f.key === key);
      if (!def) continue;

      let val;
      if (def.type === 'number') {
        const n = Number(raw);
        if (!Number.isFinite(n)) continue;              // 非法数字 → 保持工作流原值
        val = n;
      } else if (def.type === 'bool') {
        val = Boolean(raw);
      } else {
        const s = String(raw ?? '').trim();
        if (!s) continue;                               // 空串不覆盖（工作流可能用别处的默认）
        val = s;
      }

      if (inputs[key] !== val) {
        inputs[key] = val;
        did = true;
      }
    }
    return did;
  };

  if (dlssOpt.enabled !== false && dlssOpt.nodes && typeof dlssOpt.nodes === 'object') {
    for (const [id, node] of Object.entries(wf)) {
      if (node?.class_type !== DLSS_CLASS) continue;
      const panel = dlssOpt.nodes[id];
      if (!panel || typeof panel !== 'object') continue;
      node.inputs = node.inputs || {};
      if (writeFields(node.inputs, DLSS_FIELDS, DLSS_KNOWN, panel)) {
        changed = true;
        touched.dlss += 1;
      }
    }
    if (touched.dlss) notes.push(`已应用画质增强：${touched.dlss} 个 DLSS 节点`);
  }

  if (maskOpt.enabled !== false && maskOpt.nodes && typeof maskOpt.nodes === 'object') {
    for (const [id, node] of Object.entries(wf)) {
      if (node?.class_type !== MASK_BLUR_CLASS) continue;
      const panel = maskOpt.nodes[id];
      if (!panel || typeof panel !== 'object') continue;
      node.inputs = node.inputs || {};
      if (writeFields(node.inputs, MASK_FIELDS, MASK_KNOWN, panel)) {
        changed = true;
        touched.mask += 1;
      }
    }
    if (touched.mask) notes.push(`已应用遮罩羽化：${touched.mask} 个节点`);
  }

  return { workflow: wf, changed, touched, notes };
}

/**
 * 面板上的默认值：工作流现值优先，其次字段表里的第一个候选。
 * 只用于 UI 显示，不写回配置。
 */
export function defaultValueOf(def, current) {
  if (current !== undefined && current !== null && current !== '') return current;
  if (def.type === 'bool') return false;
  if (def.type === 'number') return 0;
  return (def.options && def.options[0]) || '';
}
