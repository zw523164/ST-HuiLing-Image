/**
 * 绘灵 · 分辨率选择器适配（v0.9.104）
 *
 * 出发点是用户 2026-10-19 报的一个「改宽高没反应」：
 *   很多工作流把 `EmptyLatentImage` 的宽高接在 `ResolutionSelector`（比例 + 百万像素 + 倍数）上，
 *   于是后端面板里填的「宽 / 高」**完全没有落点**，改了也不会变。
 *   但也不能粗暴把那节点删掉 —— 极端比例（21:9、512×1536）只有手填宽高才做得出来。
 *
 * 所以做成一个开关：
 *   开 → 保/建 ResolutionSelector，把 EmptyLatent 的宽高接到它输出上，比例/像素/倍数由面板控制
 *   关 → 把 EmptyLatent 的宽高改回 `%width%` / `%height%`，走面板手填
 *
 * ★ 全程**纯函数**：先深拷贝再改，绝不修改传进来的工作流对象
 *   （`config.backends.comfyui.workflowJson` 解析出来的对象可能被别处引用，
 *   就地改会造成「改一次出图参数就永久污染配置」这种极难排查的问题）。
 *
 * ★ 关掉时**不删除** selector 节点：ComfyUI 从输出节点反向遍历依赖，
 *   没人引用的孤立节点不会被执行，也不会让 /prompt 校验失败。
 *   删掉反而可能断掉别的线（用户工作流里节点可能被复用）。
 */

/**
 * `ResolutionSelector` 的 `aspect_ratio` 真实枚举。
 * 来源：`GET /object_info/ResolutionSelector` 的 `input.required.aspect_ratio[1].options`（2026-10-19 实测 8 项）。
 * ⚠️ 这些字符串是 ComfyUI 的**内部值**，必须一字不差 —— 少个括号或改个空格都会被拒。
 */
export const RES_ASPECTS = [
  '1:1 (Square)',
  '2:3 (Portrait Photo)',
  '3:2 (Photo)',
  '3:4 (Portrait Standard)',
  '4:3 (Standard)',
  '9:16 (Portrait Widescreen)',
  '16:9 (Widescreen)',
  '21:9 (Ultrawide)',
];

/**
 * 节点默认值。
 *
 * ★★★ v0.9.159：`multiple` 8 → **16**。
 *
 * 依据（MOSS 官方三处原文，都是硬要求，不是建议）：
 *   · README:8 `use positive multiples of 16; invalid dimensions raise an error`
 *   · USERGUIDE:8 `must provide 16 positive multiples, otherwise it will report an error`
 *   · layout_REFERENCE:10 `positive integer multiples of 16, equal to the eventual image dimensions`
 *
 * 为什么以前 8 没报错：ComfyUI 的 `EmptyFlux2LatentImage` 不校验 16，只按 8 下采样，
 *   所以 888×1184 能出图；但 888 不是 16 的倍数（888/16=55.5），属**违规尺寸**。
 *   改成 16 后同一组参数出 880×1184，两轴都是 16 的倍数。
 *
 * ⚠️ 这只改**新建配置**的默认值：已存配置里的 `multiple: 8` 不会被覆盖（用户主权区），
 *   面板上会显示一行提示让他自己改。
 */
export const RES_DEFAULTS = {
  aspect: '3:4 (Portrait Standard)',
  megapixels: 1,
  multiple: 16,
};

function isSelectorNode(node) {
  return node?.class_type === 'ResolutionSelector';
}

/**
 * EmptyLatentImage / EmptySD3LatentImage / EmptyLatentSDXL / EmptyLatentImageSDXL…
 * 一律认成「空 Latent」。用前缀 + 含 Latent，避免把 VAEEncode 之类误判进来。
 */
function isLatentNode(node) {
  const t = String(node?.class_type || '');
  return /^Empty/i.test(t) && /Latent/i.test(t);
}

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
  // 老浏览器没有 structuredClone 时退回 JSON 往返（工作流本来就是纯 JSON）
  catch { return JSON.parse(JSON.stringify(obj)); }
}

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * 探测工作流里有没有 ResolutionSelector、它当前什么参数、Latent 是不是已经接在它上面。
 *
 * @param {object|string} workflow API 格式工作流（对象或 JSON 文本）
 * @returns {{found:boolean, selectorIds:string[], latentIds:string[],
 *            aspect:string, megapixels:number, multiple:number,
 *            latentUsesSelector:boolean}}
 */
export function detectResolutionSelector(workflow) {
  const wf = asObject(workflow);
  const out = {
    found: false,
    selectorIds: [],
    latentIds: [],
    aspect: RES_DEFAULTS.aspect,
    megapixels: RES_DEFAULTS.megapixels,
    multiple: RES_DEFAULTS.multiple,
    latentUsesSelector: false,
  };
  if (!wf) return out;

  for (const [id, node] of Object.entries(wf)) {
    if (isSelectorNode(node)) out.selectorIds.push(id);
    else if (isLatentNode(node)) out.latentIds.push(id);
  }

  out.found = out.selectorIds.length > 0;
  if (out.found) {
    const inputs = wf[out.selectorIds[0]]?.inputs || {};
    out.aspect = String(inputs.aspect_ratio || RES_DEFAULTS.aspect);
    out.megapixels = num(inputs.megapixels, RES_DEFAULTS.megapixels);
    out.multiple = num(inputs.multiple, RES_DEFAULTS.multiple);
  }

  const selSet = new Set(out.selectorIds);
  out.latentUsesSelector = out.latentIds.some((id) => {
    const w = wf[id]?.inputs?.width;
    return Array.isArray(w) && selSet.has(String(w[0]));
  });

  return out;
}

/** 下一个可用的数字节点 id（不与现有节点撞号） */
function nextNodeId(wf) {
  let max = 0;
  for (const id of Object.keys(wf)) {
    const n = Number(id);
    if (Number.isFinite(n) && n > max) max = n;
  }
  let next = Math.max(1, max + 1);
  while (wf[String(next)]) next += 1;
  return String(next);
}

/**
 * 按开关改接线，返回**新对象**（入参不被修改）。
 *
 * @param {object|string} workflow 原始工作流
 * @param {{enabled?:boolean, aspect?:string, megapixels?:number, multiple?:number}} opts
 * @returns {{workflow:object|null, changed:boolean, mode:'selector'|'manual',
 *            createdSelector:boolean, notes:string[]}}
 */
export function applyResolution(workflow, opts = {}) {
  const src = asObject(workflow);
  if (!src) {
    return {
      workflow: null,
      changed: false,
      mode: 'manual',
      createdSelector: false,
      notes: ['工作流不是合法 JSON，分辨率适配已跳过'],
    };
  }

  const wf = clone(src);
  const notes = [];
  let changed = false;

  const latentIds = Object.keys(wf).filter((id) => isLatentNode(wf[id]));
  const selectorIds = Object.keys(wf).filter((id) => isSelectorNode(wf[id]));

  if (!latentIds.length) {
    notes.push('工作流里没找到 Empty*Latent 节点 —— 分辨率设置没有落点（工作流可能用了别的建 latent 方式）');
    return { workflow: wf, changed: false, mode: opts.enabled ? 'selector' : 'manual', createdSelector: false, notes };
  }

  /* ---------- 关：手填宽高 ---------- */
  if (!opts.enabled) {
    for (const id of latentIds) {
      const inputs = (wf[id].inputs = wf[id].inputs || {});
      if (inputs.width !== '%width%') { inputs.width = '%width%'; changed = true; }
      if (inputs.height !== '%height%') { inputs.height = '%height%'; changed = true; }
    }
    if (selectorIds.length) {
      notes.push(`已断开分辨率选择器（节点 ${selectorIds.join(' / ')} 留在工作流里，但不再参与执行）`);
    }
    return { workflow: wf, changed, mode: 'manual', createdSelector: false, notes };
  }

  /* ---------- 开：走分辨率选择器 ---------- */
  let createdSelector = false;
  let selId = selectorIds[0];

  if (!selId) {
    selId = nextNodeId(wf);
    wf[selId] = {
      class_type: 'ResolutionSelector',
      _meta: { title: '绘灵 · 分辨率选择器' },
      inputs: {
        aspect_ratio: RES_DEFAULTS.aspect,
        megapixels: RES_DEFAULTS.megapixels,
        multiple: RES_DEFAULTS.multiple,
      },
    };
    createdSelector = true;
    changed = true;
    notes.push(`工作流里没有分辨率选择器，已新建节点 ${selId}`);
  }

  const sel = (wf[selId].inputs = wf[selId].inputs || {});
  const aspect = String(opts.aspect || sel.aspect_ratio || RES_DEFAULTS.aspect);
  const megapixels = num(opts.megapixels, num(sel.megapixels, RES_DEFAULTS.megapixels));
  const multiple = num(opts.multiple, num(sel.multiple, RES_DEFAULTS.multiple));

  if (sel.aspect_ratio !== aspect) { sel.aspect_ratio = aspect; changed = true; }
  if (Number(sel.megapixels) !== megapixels) { sel.megapixels = megapixels; changed = true; }
  if (Number(sel.multiple) !== multiple) { sel.multiple = multiple; changed = true; }

  for (const id of latentIds) {
    const inputs = (wf[id].inputs = wf[id].inputs || {});
    const w = inputs.width;
    if (!(Array.isArray(w) && String(w[0]) === selId && Number(w[1]) === 0)) {
      inputs.width = [selId, 0];
      changed = true;
    }
    const h = inputs.height;
    if (!(Array.isArray(h) && String(h[0]) === selId && Number(h[1]) === 1)) {
      inputs.height = [selId, 1];
      changed = true;
    }
  }

  return { workflow: wf, changed, mode: 'selector', createdSelector, notes };
}

/**
 * 1 兆像素 = **1024×1024**，不是 1e6。
 *
 * ★★★ v0.9.159：这条是本项目拖了很久的**坐标系统性偏移**根因。
 *
 * 依据（ComfyUI 内置节点源码 `comfy_extras/nodes_resolution.py:73-78`）：
 *   ```python
 *   total_pixels = megapixels * 1024 * 1024
 *   scale = math.sqrt(total_pixels / (w_ratio * h_ratio))
 *   width  = round(w_ratio * scale / multiple) * multiple
 *   height = round(h_ratio * scale / multiple) * multiple
 *   ```
 *
 * 旧代码用的是 `mp * 1e6`（≈1.048576 的差），于是同一组参数：
 *   · ComfyUI 实际出图：**888×1184**
 *   · 我们编译 bbox 用的画布：**864×1152**
 *   ⇒ 坐标全部按小 2.7% 的画布算 → 整幅构图向中心缩、格线/气泡系统性内缩，
 *     而 MOSS 对 layout 是软约束，模型会把画面自己补满，所以**不会报错也不会明显崩**，
 *     只是「框和人差一点」的余量被悄悄吃掉（排查时极难定位）。
 */
const MEGAPIXEL_PIXELS = 1024 * 1024;

/**
 * Python `round()` 是**银行家舍入**（.5 取偶），JS `Math.round` 是**向上取整**。
 * 只在商恰好落在 .5 上时差 1 个倍数，但那 1 个倍数在 16 对齐下就是 16px ——
 * 足够让一个贴边的 bbox 从「在内」变「越界」。所以显式复刻。
 */
function bankRound(v) {
  const f = Math.floor(v);
  const d = v - f;
  if (Math.abs(d - 0.5) < 1e-9) return (f % 2 === 0) ? f : f + 1;
  return Math.round(v);
}

/**
 * 按「比例 + 百万像素 + 倍数」估算实际输出尺寸。
 *
 * ★ v0.9.159：算法改为**逐行复刻 ComfyUI 的 `ResolutionSelector`**，
 *   不再是「方向一致」。这套值同时被三处使用，必须与出图尺寸**完全相等**：
 *   ① 多格 layout 的 bbox 编译（`canvasOf` → `compileLayout`）
 *   ② 漫画页的分格几何（`buildMangaPage`）
 *   ③ 面板上的尺寸提示
 *   差 1px 都会让贴边框越界，所以这里不取整到整数以外的东西。
 */
export function estimateResolution(aspect, megapixels, multiple) {
  const m = /^(\d+):(\d+)/.exec(String(aspect || ''));
  const rw = m ? Number(m[1]) : 3;
  const rh = m ? Number(m[2]) : 4;
  const mp = Math.min(16, Math.max(0.1, num(megapixels, RES_DEFAULTS.megapixels)));
  const mult = Math.max(1, num(multiple, RES_DEFAULTS.multiple));
  const scale = Math.sqrt((mp * MEGAPIXEL_PIXELS) / (rw * rh));
  const snap = (v) => Math.max(mult, bankRound(v / mult) * mult);
  return { width: snap(rw * scale), height: snap(rh * scale) };
}
