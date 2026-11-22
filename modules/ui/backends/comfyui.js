/**
 * 绘灵 · ComfyUI 后端面板
 *
 * 从 modules/ui/backend.js 搬过来的（渠道化改造时拆出来），DOM 结构与 ID 全部保持不变 ——
 * 现有测试和用户已经形成的肌肉记忆都依赖它们。
 *
 * 可控性优先：模型 / VAE / LoRA / 采样器 / 调度器 全部走 **input + datalist**
 * ——既是下拉（从 ComfyUI 拉真实列表，避免手打形近字），又能手输任意值。
 * LoRA 不限数量，行可随时增删改。
 */

import { getConfig, saveSettings } from '../../settings.js';
import {
  analyzeWorkflow, auditWorkflow, probe, fetchResources, CLIP_TYPE_FALLBACK, guessClipType,
} from '../../backends/comfyui.js';
import {
  detectWorkflowFormat, convertUiToApi, planAdaptation, applyPatch,
  buildAiMessages, parseAiPatchText, validateAiPatch, mergeAiAdditions,
  insertLoraSlots, maxLoraSlotIn, removeLoraSlot, loraSlotTypeIn,
} from '../../backends/wfadapter.js';
import { LORA_SLOT_LIMIT } from '../../backends/comfyui.js';
import { RES_ASPECTS, RES_DEFAULTS, estimateResolution } from '../../resSelector.js';
import { detectEnhance, DLSS_FIELDS, MASK_FIELDS, defaultValueOf } from '../../enhanceControl.js';
import { callAnalyzeLLM } from '../../api.js';
import { backendMeta } from '../../backends/index.js';
import { enableSectionCollapse } from '../collapse.js';
import { info, warn, STAGE } from '../../log.js';
import {
  escapeHtml, $, bindInput, bindCheck, bindSelect, putDatalist, renderStatus, channelHeader,
  bindChannelHeader,
} from './shared.js';

/**
 * CLIP 类型的中文注解（只标注最常撞上的几个）。
 *
 * 下拉里默认显示 ComfyUI 的内部名（`qwen_image`）—— 这是**提交时真正要传的值**，
 * 汉化界面上的「Qwen千问图像」反而不能用。这里加个括号注解，纯粹是让选的人知道
 * 哪个是自己要的，值的部分一个字都不能改。
 */
const CLIP_TYPE_LABEL = {
  qwen_image: 'qwen_image（Qwen 千问图像 · Krea2 用这个）',
  krea2: 'krea2（Krea2）',
  wan: 'wan（Wan 万相）',
  stable_diffusion: 'stable_diffusion（SD1.5 / SDXL）',
  sd3: 'sd3（Stable Diffusion 3）',
  flux2: 'flux2（FLUX）',
  lumina2: 'lumina2（Lumina）',
  hunyuan_image: 'hunyuan_image（混元图像）',
};

/**
 * 「中文描述」当前走到哪条路 —— 一句话说清，免得用户以为关了开关中文还在发。
 *
 * 两条路：工作流里写了 %nl% → 中文走独立占位符；没写 → 兜底追加到提示词末尾。
 * 开关关掉则两条都断（只发 tag）。
 */
function renderNlState(container) {
  const box = $(container, '#hl-nl-state');
  if (!box) return;
  const cfg = getConfig();
  const be = cfg.backends.comfyui || {};
  if (cfg.nlEnabled === false) {
    box.innerHTML = '<b>当前：已关闭</b> —— 出图只发英文 tag 串。';
    return;
  }
  const hasSlot = /%nl%/i.test(String(be.workflowJson || ''));
  box.innerHTML = hasSlot
    ? '<b>当前：已开启</b> —— 工作流里有 <code>%nl%</code>，中文走独立占位符。'
    : '<b>当前：已开启</b> —— 工作流里没有 <code>%nl%</code>，中文会<b>追加到提示词末尾</b>一起送出。';
}

/**
 * 「分辨率选择器」开关的联动（v0.9.104）。
 *
 * 开关开着时「宽 / 高」两个输入框是**不参与出图的**（值还留着，切回来就恢复）。
 * 必须让它看起来就是灰的 —— 否则用户会继续改那两个数字、继续以为功能坏了，
 * 这正是这个开关要解决的那个坑。
 */
function syncResState(container, be) {
  const rs = (be.resSelector && typeof be.resSelector === 'object') ? be.resSelector : {};
  const on = rs.enabled === true;

  const box = $(container, '#hl-res-selector-fields');
  if (box) box.style.display = on ? '' : 'none';

  for (const id of ['#hl-w', '#hl-h']) {
    const el = $(container, id);
    if (!el) continue;
    el.disabled = on;
    el.style.opacity = on ? '0.45' : '';
    el.title = on ? '由「分辨率选择器」决定 —— 关掉上面的开关才能手填' : '';
  }

  const est = $(container, '#hl-res-est');
  if (est) {
    if (on) {
      const { width, height } = estimateResolution(rs.aspect, rs.megapixels, rs.multiple);
      /**
       * ★★★ v0.9.159：MOSS 官方硬要求「宽高必须是 16 的正整数倍」。
       *   README:8 / USERGUIDE:8 / layout_REFERENCE:10 三处原文都是 `multiples of 16`，
       *   USERGUIDE 还写明「otherwise it will report an error」。
       *   而 ComfyUI 的 `ResolutionSelector` 只按 `multiple` 对齐（默认 8），
       *   于是 3:4 / 1MP / 8 倍会出 **888×1184** —— 888 不是 16 的倍数（888/16=55.5）。
       *
       * 这里只**提示**，不替用户改：采样与尺寸是用户主权区（记忆硬规则），
       * 但违反官方硬规范这件事必须让他看得见，而不是等出图质量莫名下降再去查。
       */
      const offW = width % 16;
      const offH = height % 16;
      const warn = (offW || offH)
        ? ` <span style="color:#e0a030">⚠ ${offW ? width : height} 不是 16 的倍数`
          + ` —— MOSS 官方要求宽高必须为 16 的正整数倍，建议把「倍数」改成 16</span>`
        : '';
      est.innerHTML = `≈ <b>${width} × ${height}</b>（${escapeHtml(String(rs.aspect || ''))} / ${Number(rs.megapixels) || 1}MP）${warn}`;
    } else {
      est.innerHTML = `用上方的 <b>${Number(be.width) || '?'} × ${Number(be.height) || '?'}</b>`;
    }
  }
}

/** 生成「CLIP 类型」下拉的 options。当前值不在候选里时补一条，避免读出来变空。 */
function clipTypeOptionsHtml(current, cache) {
  const cur = String(current || '').trim();
  const list = (Array.isArray(cache?.clipTypes) && cache.clipTypes.length)
    ? cache.clipTypes
    : CLIP_TYPE_FALLBACK;
  const seen = new Set();
  const parts = ['<option value="">（不改 · 保持工作流里的原值）</option>'];
  for (const raw of list) {
    const v = String(raw || '').trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    parts.push(`<option value="${escapeHtml(v)}">${escapeHtml(CLIP_TYPE_LABEL[v] || v)}</option>`);
  }
  if (cur && !seen.has(cur)) {
    parts.push(`<option value="${escapeHtml(cur)}">${escapeHtml(cur)}（当前值）</option>`);
  }
  return parts.join('');
}

/** 体检提示是纯文本（含用户的工作流值），先转义再给 %占位符% 加等宽样式。 */
function markPlaceholders(text) {
  return escapeHtml(text).replace(/(%[a-z0-9_]+%)/gi, '<code>$1</code>');
}

function html(cfg) {
  const be = cfg.backends.comfyui;
  const fw = be.followWorkflow || {};
  // 分辨率选择器开关（v0.9.104）：老存档没这个字段时给一份安全默认，别让面板读崩
  const rs = (be.resSelector && typeof be.resSelector === 'object')
    ? be.resSelector
    : { enabled: false, ...RES_DEFAULTS };

  const presetNames = Object.keys(be.presets || {}).sort((a, b) => a.localeCompare(b, 'zh'));

  return `
${channelHeader('comfyui', backendMeta('comfyui'), cfg)}

<div class="hl-section">
  <div class="hl-section-title">工作流预设（整套配置模版）</div>
  <div class="hl-inline">
    <select id="hl-wfpreset" class="hl-input hl-grow"></select>
    <button class="hl-btn" id="hl-wfpreset-new" title="把当前整套配置存成一份新预设">新建</button>
    <button class="hl-btn" id="hl-wfpreset-save" title="把当前改动写回选中的预设">保存改动</button>
    <button class="hl-btn" id="hl-wfpreset-rename">重命名</button>
    <button class="hl-btn hl-btn-danger" id="hl-wfpreset-del" title="删除当前选中的预设">删除</button>
  </div>
  <div class="hl-hint">
    预设 = <b>整套本地生成配置</b>（工作流 JSON + 模型 / VAE / CLIP / CLIP 类型 + 采样参数 + LoRA + 跟随标志）。
    Krea2 工作流和 Checkpoint 工作流各存一份，切换即整套换 —— 只换 JSON 不换资源组，切换后必然跑挂。<br>
    改动只写在下面各输入框里，要沉淀进预设必须点「保存改动」；没保存就切预设会丢。
  </div>
</div>

<div class="hl-section">
  <div class="hl-section-title">连接</div>
  <div class="hl-inline">
    <input id="hl-url" class="hl-input hl-grow" placeholder="http://127.0.0.1:8186" value="${escapeHtml(be.serverUrl || '')}">
    <button class="hl-btn" id="hl-probe">测试连接</button>
    <button class="hl-btn" id="hl-fetch">拉取资源</button>
  </div>
  <div class="hl-hint">ComfyUI 默认端口是 8188；你的环境是 <b>8186</b>。点「拉取资源」后，下面所有下拉框才会填满。</div>
  <div class="hl-field">
    <label class="hl-label">出图超时（秒）</label>
    <div class="hl-inline">
      <input id="hl-cfy-timeout" class="hl-input" type="number" min="30" max="1800" step="30" value="${Number(be.timeoutSec) || 300}">
    </div>
    <div class="hl-hint">
      提交后等 ComfyUI 出图的上限。后端是<b>串行队列</b>（一次只跑一张），
      所以「本楼 N 张」的等待时间是成倍累加的 —— 一张画得很慢时，后面的图还在排队，
      用单张的时间去等就会把<b>已经画好的图</b>判成超时。<br>
      GAL 模式会自动按「上次要的张数」放大这个值（最多 1800 秒）；这里填的是<b>单张基准</b>。
    </div>
  </div>
  <div class="hl-status" id="hl-conn-status"></div>
</div>

<datalist id="hl-dl-model"></datalist>
<datalist id="hl-dl-vae"></datalist>
<datalist id="hl-dl-clip"></datalist>
<datalist id="hl-dl-lora"></datalist>
<datalist id="hl-dl-sampler"></datalist>
<datalist id="hl-dl-scheduler"></datalist>

<div class="hl-section">
  <div class="hl-section-title">模型资源</div>
  <div class="hl-field">
    <label class="hl-label">模型（UNET / Checkpoint）</label>
    <div class="hl-inline">
      <input id="hl-model" class="hl-input hl-grow" list="hl-dl-model" placeholder="从下拉选，或直接手输" value="${escapeHtml(be.model || '')}">
      <label class="hl-check" title="勾选后绘灵不改工作流，直接用工作流里写的模型">
        <input type="checkbox" id="hl-follow-model" ${fw.model ? 'checked' : ''}><span>跟随工作流</span>
      </label>
    </div>
    <div class="hl-hint">对应工作流里的 <code>%model%</code></div>
  </div>
  <div class="hl-field">
    <label class="hl-label">CLIP / 文本编码器</label>
    <div class="hl-inline">
      <input id="hl-clip" class="hl-input hl-grow" list="hl-dl-clip" placeholder="从下拉选，或直接手输" value="${escapeHtml(be.clip || '')}">
      <label class="hl-check" title="Checkpoint 自带 CLIP / 工作流已写死时勾这个，绘灵就不插手">
        <input type="checkbox" id="hl-follow-clip" ${fw.clip ? 'checked' : ''}><span>跟随工作流</span>
      </label>
    </div>
    <div class="hl-hint">
      对应工作流里的 <code>%clip%</code>（<code>CLIPLoader</code> 节点的 <code>clip_name</code>）。<br>
      Krea2 走 <b>Qwen2.5-VL</b> 系（如 <code>qwen_2.5_vl_7b_fp8_scaled.safetensors</code>）；
      SDXL 系一般是 <code>clip_l</code> + <code>t5xxl</code>。点「拉取资源」会从 CLIPLoader / DualCLIPLoader 拉真实文件名。
    </div>
  </div>
  <div class="hl-field">
    <label class="hl-label">CLIP 类型（type）</label>
    <div class="hl-inline">
      <select id="hl-clip-type" class="hl-input hl-grow">${clipTypeOptionsHtml(be.clipType, cfg.resourceCache)}</select>
      <label class="hl-check" title="用工作流里写死的 type，面板不插手">
        <input type="checkbox" id="hl-follow-clipType" ${fw.clipType ? 'checked' : ''}><span>跟随工作流</span>
      </label>
    </div>
    <div class="hl-hint" id="hl-clip-type-hint">
      对应工作流里的 <code>%clip_type%</code>（<code>CLIPLoader</code> 节点的 <code>type</code>）。<br>
      这是 <b>另一个独立的下拉框</b>：文件名对了、类型错了照样跑挂
      （Qwen 系 CLIP 配 <code>wan</code> 的类型就是典型）。<br>
      <b>要把工作流里的 <code>type</code> 写成 <code>%clip_type%</code>，这里的选择才生效</b> ——
      写死的值不受面板控制。点「拉取资源」会从 ComfyUI 拉真实类型列表。
    </div>
  </div>
  <div class="hl-field">
    <label class="hl-label">VAE</label>
    <div class="hl-inline">
      <input id="hl-vae" class="hl-input hl-grow" list="hl-dl-vae" placeholder="模型内置 VAE 时留空或勾「跟随工作流」" value="${escapeHtml(be.vae || '')}">
      <label class="hl-check" title="Checkpoint 自带 VAE 时勾这个，绘灵不插手">
        <input type="checkbox" id="hl-follow-vae" ${fw.vae ? 'checked' : ''}><span>跟随工作流</span>
      </label>
    </div>
    <div class="hl-hint">对应工作流里的 <code>%vae%</code>；模型内置 VAE 时留空或勾「跟随工作流」</div>
  </div>
  <div class="hl-hint">
    <b>没勾「跟随工作流」时：模型 / VAE / CLIP / CLIP 类型都是「留空则该项被报为缺失」</b> ——
    留空时绘灵不会把 <code>""</code> 塞进工作流（那只会换回一句 ComfyUI 的 node_errors），
    而是直接告诉你工作流里哪个占位符没值。<br>
    <b>勾了「跟随工作流」</b>：这类资源不改成占位符 —— 导入 / AI 适配时保留工作流里的原值
    （Checkpoint 自带 VAE / CLIP 就不用另外填了），原值会记录下来，跟随显示在输入框里。
  </div>
</div>

<div class="hl-section">
  <div class="hl-section-title">LoRA（不限数量，随时增删）</div>
  <div id="hl-lora-slotinfo" class="hl-hint" style="margin-bottom:4px;"></div>
  <div id="hl-lora-list" class="hl-lora-list"></div>
  <div class="hl-actions">
    <button class="hl-btn hl-ghost" id="hl-lora-add">+ 添加 LoRA</button>
    <button class="hl-btn" id="hl-lora-slots" title="工作流里没有 %loraN% 入口时，加的行是空转的 —— 这个按钮给工作流补出标准的 LoRA 节点">补齐槽位…</button>
    <button class="hl-btn hl-ghost" id="hl-lora-clear">清空全部</button>
  </div>
  <div class="hl-hint">
    顺序即槽位：第 1 行 → <code>%lora1%</code>，第 2 行 → <code>%lora2%</code> …<br>
    ✅ <b>加行会自动补槽</b>：行号超过工作流槽位时，自动在模型链上补一个对应的「绘灵 LoRA 槽」。<br>
    ✅ <b>删行会同步删槽</b>：点行右侧 <code>×</code> 会把工作流里对应的「绘灵 LoRA 槽」一起删掉，后面的槽号自动前移。<br>
    ⚠️ <b>不要留空行</b>——空行会让它后面的 LoRA 整体前移，槽位全错位（且会报占位符没值）。<br>
    <b>停用</b>某支 LoRA：取消勾选或把强度设 <code>0</code> —— 会以 0 强度加载，<b>不影响画面</b>，不会报错。<br>
    <b>加行不生效？</b>说明工作流里没有 <code>%loraN%</code> 入口（很多工作流把 LoRA 写死在自己节点里）。
    点「补齐槽位」会在模型链上串接标准 LoRA 节点，加出来的行才真的有用。
  </div>
</div>

<div class="hl-section">
  <div class="hl-section-title">采样参数</div>
  <div class="hl-field">
    <label class="hl-check">
      <input type="checkbox" id="hl-res-selector" ${rs.enabled ? 'checked' : ''}>
      <span>📐 用工作流里的「分辨率选择器」节点</span>
    </label>
    <div class="hl-hint">
      <b>开</b>：宽高按下面的<b>比例 + 百万像素</b>算（工作流里的 <code>ResolutionSelector</code> 生效；里面没有就自动串一个）。
      这时下面「宽 / 高」两个数字<b>不生效</b>，输入框会变灰。<br>
      <b>关</b>：用你手填的「宽 / 高」—— 想跑 21:9、512×1536 这类极端比例时关掉它。
    </div>
  </div>
  <div id="hl-res-selector-fields">
    <div class="hl-grid2">
      <div class="hl-field">
        <label class="hl-label">宽高比</label>
        <input id="hl-res-aspect" class="hl-input" list="hl-dl-aspect" value="${escapeHtml(String(rs.aspect || RES_DEFAULTS.aspect))}">
        <datalist id="hl-dl-aspect">${RES_ASPECTS.map(a => `<option value="${escapeHtml(a)}"></option>`).join('')}</datalist>
      </div>
      <div class="hl-field">
        <label class="hl-label">百万像素</label>
        <input id="hl-res-mp" class="hl-input" type="number" min="0.1" max="16" step="0.1" value="${Number(rs.megapixels) || RES_DEFAULTS.megapixels}">
      </div>
    </div>
    <div class="hl-grid2">
      <div class="hl-field">
        <label class="hl-label">倍数</label>
        <input id="hl-res-mult" class="hl-input" type="number" min="8" max="128" step="4" value="${Number(rs.multiple) || RES_DEFAULTS.multiple}">
      </div>
      <div class="hl-field">
        <label class="hl-label">实际输出</label>
        <div class="hl-hint" id="hl-res-est">…</div>
      </div>
    </div>
  </div>
  <div class="hl-grid2">
    <div class="hl-field"><label class="hl-label">Steps</label><input id="hl-steps" class="hl-input" type="number" min="1" max="150" value="${be.steps}"></div>
    <div class="hl-field"><label class="hl-label">CFG</label><input id="hl-cfg" class="hl-input" type="number" min="0" max="30" step="0.5" value="${be.cfg}"></div>
    <div class="hl-field"><label class="hl-label">宽</label><input id="hl-w" class="hl-input" type="number" min="64" max="4096" step="64" value="${be.width}"></div>
    <div class="hl-field"><label class="hl-label">高</label><input id="hl-h" class="hl-input" type="number" min="64" max="4096" step="64" value="${be.height}"></div>
    <div class="hl-field"><label class="hl-label">采样器</label><input id="hl-sampler" class="hl-input" list="hl-dl-sampler" value="${escapeHtml(be.sampler || '')}"></div>
    <div class="hl-field"><label class="hl-label">调度器</label><input id="hl-scheduler" class="hl-input" list="hl-dl-scheduler" value="${escapeHtml(be.scheduler || '')}"></div>
  </div>
  <div class="hl-hint">Krea2 蒸馏模型建议 CFG=<b>1</b>、steps 8、euler + simple；CFG 大于 1 容易过曝。</div>
</div>

<div class="hl-section">
  <div class="hl-section-title">画质增强（DLSS 上采样 / 遮罩羽化）</div>
  <div class="hl-hint">
    这里的值<b>直接写进工作流节点</b>，改完出图即生效，不用重新导入工作流。<br>
    面板显示的是工作流<b>当前值</b>；没动过的字段不会被写进配置，所以换工作流不会带上旧值。
  </div>
  <div id="hl-enhance-body"></div>
</div>

<div class="hl-section">
  <div class="hl-section-title">负面提示词（%negative_prompt%）</div>
  <textarea id="hl-negative" class="hl-textarea" rows="3">${escapeHtml(be.negative || '')}</textarea>
</div>

<div class="hl-section">
  <div class="hl-section-title">中文描述（nl）</div>
  <label class="hl-check">
    <input type="checkbox" id="hl-nl-enabled" ${cfg.nlEnabled !== false ? 'checked' : ''}>
    <span>出图时带上中文描述</span>
  </label>
  <div class="hl-hint">
    开（默认）＝ 送给生图的提示词是「英文 tag 串 + 中文自然段」：
    K2 的文本编码器是 Qwen 系，中文理解远好于英文 tag 堆叠，构图/光线/情绪这类
    tag 说不圆的东西全靠它，画面氛围明显更足。<br>
    关 ＝ <b>只发英文 tag 串</b>，画面偏"标签堆砌"、氛围变呆。
    想对比「中文到底有没有用」时，切它重生成同一张图最快。<br>
    切换只对<b>之后</b>生成的图生效（已有图不受影响）；悬浮框里始终能看到那段中文，
    关掉只是不让它参与出图。
  </div>
  <div class="hl-hint">
    <b>⚠️ 「MOSS」与「K2 纯英文单段」两个口径下这个开关不生效</b>（v0.9.118 起）：
    它们的 <code>tag</code> 本身就是一整套完整提示词（版面 + 人物 + 每格 + 台词），
    插件不会产出 nl，也不会往 prompt 后面追加中文 ——
    开了也不会有任何东西被送进模型，不用管它。
    另外 MOSS 走的是**单串整段**：中文只出现在台词引号里，其余全是英文画面词。
  </div>
  <div class="hl-hint" id="hl-nl-state"></div>
</div>

<div class="hl-section">
  <div class="hl-section-title">工作流（ComfyUI 的 API 格式 JSON）</div>
  <div class="hl-actions">
    <button class="hl-btn" id="hl-wf-import">导入工作流…</button>
    <button class="hl-btn" id="hl-wf-adapt-btn" title="AI 分析这份工作流，把模型/参数自动改成 %占位符%，并回填到面板">AI 分析适配</button>
    <button class="hl-btn" id="hl-wf-check" title="格式检查 + 深度检查：占位符与面板值是否配齐、LoRA 行数够不够、宽高通路、模型文件在 ComfyUI 上存不存在">体检</button>
    <button class="hl-btn hl-ghost" id="hl-wf-clear">清空</button>
  </div>
  <input type="file" id="hl-wf-import-file" accept=".json,application/json" hidden>
  <textarea id="hl-wf" class="hl-textarea hl-code" rows="10" placeholder="把 ComfyUI「保存（API 格式）」导出的 JSON 粘进来，或点「导入工作流」选文件（UI 格式会自动转）">${escapeHtml(be.workflowJson || '')}</textarea>
  <div id="hl-wf-result" class="hl-report"></div>
  <div id="hl-wf-audit" class="hl-report"></div>
  <div id="hl-wf-adapt" class="hl-report"></div>
</div>`;
}

/* ============ LoRA 行 ============ */

function makeLoraRow(container, list, index) {
  const cfg = getConfig();
  const be = cfg.backends.comfyui;
  const l = be.loras[index];

  const row = document.createElement('div');
  row.className = 'hl-lora-row';

  const en = document.createElement('input');
  en.type = 'checkbox';
  en.checked = l.enabled !== false;
  en.title = '启用';
  en.addEventListener('change', () => { l.enabled = en.checked; saveSettings(); });

  const idx = document.createElement('span');
  idx.className = 'hl-lora-idx';
  idx.textContent = `%lora${index + 1}%`;

  const name = document.createElement('input');
  name.className = 'hl-input hl-lora-name';
  name.setAttribute('list', 'hl-dl-lora');
  name.placeholder = 'LoRA 文件名（从下拉选）';
  name.value = l.name || '';
  name.addEventListener('change', () => { l.name = name.value.trim(); saveSettings(); });

  const str = document.createElement('input');
  str.className = 'hl-input hl-lora-str';
  str.type = 'number';
  str.step = '0.05';
  str.min = '0';
  str.max = '3';
  str.value = l.strength ?? 1;
  str.title = '强度';
  str.addEventListener('change', () => {
    const n = Number(str.value);
    l.strength = Number.isFinite(n) ? n : 1;
    str.value = l.strength;
    saveSettings();
  });

  const del = document.createElement('button');
  del.className = 'hl-lora-del';
  del.textContent = '×';
  del.title = '删除这一行（同时删掉工作流里对应的「绘灵 LoRA 槽」，后面的槽号自动前移）';
  del.addEventListener('click', () => {
    const slot = index + 1;
    be.loras.splice(index, 1);
    // 删行同步删槽：工作流里对应的「绘灵 LoRA 槽」一起删，槽号前移 —— 行↔槽对应关系保持
    const det = detectWorkflowFormat(be.workflowJson || '');
    if (det.format === 'api' && maxLoraSlotIn(det.parsed) >= slot) {
      const res = removeLoraSlot(det.parsed, slot);
      if (res.ok) be.workflowJson = res.text;
      else wfMsg(container, `行已删除，但工作流槽位没动：${res.problems[0]}`, true);
    }
    saveSettings();
    renderLoraRows(container);
  });

  row.append(en, idx, name, str, del);
  return row;
}

/** 常驻槽位信息：工作流里有几个槽 / 面板填到第几行 / 哪些行还空着（空行＝出图会报占位符错）。 */
function renderLoraSlotInfo(container) {
  const el = $(container, '#hl-lora-slotinfo');
  if (!el) return;
  const be = getConfig().backends.comfyui;
  const det = detectWorkflowFormat(be.workflowJson || '');
  const cur = det.format === 'api' ? maxLoraSlotIn(det.parsed) : 0;
  const rows = Array.isArray(be.loras) ? be.loras : [];
  const filled = rows.filter((l) => String(l?.name || '').trim()).length;
  const missing = [];
  for (let i = 1; i <= cur; i += 1) {
    const row = rows[i - 1];
    if (!row || !String(row?.name || '').trim()) missing.push(`%lora${i}%`);
  }
  const parts = [`工作流 LoRA 槽位：${cur} 个`, `面板 ${rows.length} 行（已填 ${filled}）`];
  if (missing.length) parts.push(`⚠️ 缺值：${missing.join(' ')} —— 出图会报「未替换的占位符」，填上或删掉这些行`);
  else if (cur) parts.push('✅ 无缺值');
  el.textContent = parts.join(' ｜ ');
}

function renderLoraRows(container) {
  const cfg = getConfig();
  const be = cfg.backends.comfyui;
  const list = $(container, '#hl-lora-list');
  if (!list) return;
  list.innerHTML = '';
  renderLoraSlotInfo(container);

  if (!be.loras?.length) {
    const empty = document.createElement('div');
    empty.className = 'hl-hint';
    empty.textContent = '还没有 LoRA。点下面的「+ 添加 LoRA」。';
    list.appendChild(empty);
    return;
  }
  be.loras.forEach((_, i) => list.appendChild(makeLoraRow(container, list, i)));
}

/* ============ 资源下拉填充 ============ */

function fillDatalists(container, cache) {
  const put = (id, items) => putDatalist(container, id, items);
  put('hl-dl-model', [...(cache.unet || []), ...(cache.models || [])]);
  put('hl-dl-vae', cache.vae || []);
  put('hl-dl-clip', cache.clips || []);
  put('hl-dl-lora', cache.loras || []);
  put('hl-dl-sampler', cache.samplers || []);
  put('hl-dl-scheduler', cache.schedulers || []);
}

/**
 * 重填「CLIP 类型」下拉。
 *
 * select 不能像 datalist 那样只换 options —— 重填后必须把当前选中值**再设一遍**，
 * 否则浏览器会回落到第一项（「不改」），看起来像用户的选择被清空了。
 */
function fillClipTypes(container, be, cache) {
  const el = $(container, '#hl-clip-type');
  if (!el) return;
  const cur = String(be.clipType || '').trim();
  el.innerHTML = clipTypeOptionsHtml(cur, cache);
  el.value = cur;
}

/**
 * 换 CLIP 模型时提示一句「这个文件名像是 X 系」。
 *
 * 只提示、不自动填 —— 猜错 type 会让出图直接跑挂，比不填更糟（不填至少当场报缺失）。
 * 用户明确授权由人来定：见 K2 内容生产规则里的「人设与服装＝用户主权区」同一条精神，
 * 参数层面同理。
 */
function renderClipTypeHint(container, be) {
  const box = $(container, '#hl-clip-type-hint');
  if (!box) return;
  const base = box.dataset.base || (box.dataset.base = box.innerHTML);

  const guess = guessClipType(be.clip);
  const cur = String(be.clipType || '').trim();
  if (!guess || guess === cur) { box.innerHTML = base; return; }

  const note = !cur
    ? `看名字像是 <code>${escapeHtml(guess)}</code> 系 —— 如果工作流里用了 <code>%clip_type%</code>，建议选它。`
    : `看名字像是 <code>${escapeHtml(guess)}</code> 系，而当前选的是 <code>${escapeHtml(cur)}</code> —— 类型与文件名对不上是跑挂的常见原因，确认一下。`;
  box.innerHTML = `${base}<div class="hl-note">💡 ${note}</div>`;
}

/** 顺手把 KSampler 的采样器/调度器选项也拉下来。 */
async function fetchSamplerOptions(url) {
  const out = { samplers: [], schedulers: [] };
  try {
    const res = await fetch(`${url.replace(/\/+$/, '')}/object_info/KSampler`);
    if (!res.ok) return out;
    const data = await res.json();
    const req = data?.KSampler?.input?.required || {};
    if (Array.isArray(req.sampler_name?.[0])) out.samplers = req.sampler_name[0];
    if (Array.isArray(req.scheduler?.[0])) out.schedulers = req.scheduler[0];
  } catch { /* 拉不到就留空，用户可手输 */ }
  return out;
}

/* ============ 画质增强面板（v0.9.108） ============ */

/** 摘要行：收起状态下也能一眼看到这台节点的关键值 */
function enhSummary(kind, values) {
  const bits = [];
  if (kind === 'dlss') {
    if (values.nr_intensity !== undefined && values.nr_intensity !== '') bits.push(`降噪 ${values.nr_intensity}`);
    if (values.local_structure_strength !== undefined && values.local_structure_strength !== '') bits.push(`结构 ${values.local_structure_strength}`);
    if (values.dlss_model_preset) bits.push(String(values.dlss_model_preset));
    if (values.automatic_mask === false || values.automatic_mask === 'false') bits.push('不自动遮罩');
  } else {
    if (values.expand !== undefined && values.expand !== '') bits.push(`扩展 ${values.expand}`);
    if (values.blur_radius !== undefined && values.blur_radius !== '') bits.push(`羽化 ${values.blur_radius}`);
  }
  return bits.join(' · ');
}

function enhFieldHtml(kind, nodeId, field, current) {
  const val = defaultValueOf(field, current);
  const attrs = `data-enh-kind="${kind}" data-enh-node="${escapeHtml(nodeId)}" data-enh-key="${field.key}"`;
  const id = `hl-enh-${kind}-${nodeId}-${field.key}`;

  if (field.type === 'bool') {
    return `<label class="hl-check hl-enh-chk"><input type="checkbox" id="${id}" ${attrs} data-enh-type="bool" ${val ? 'checked' : ''}><span>${escapeHtml(field.label)}</span></label>`;
  }
  if (field.type === 'number') {
    return `<div class="hl-field hl-enh-f">
      <label class="hl-label">${escapeHtml(field.label)}</label>
      <input class="hl-input" type="number" step="${field.step ?? 1}" id="${id}" ${attrs} data-enh-type="number" value="${escapeHtml(String(val))}">
    </div>`;
  }
  return `<div class="hl-field hl-enh-f">
    <label class="hl-label">${escapeHtml(field.label)}</label>
    <input class="hl-input" list="hl-dl-enh-${kind}-${field.key}" id="${id}" ${attrs} data-enh-type="enum" value="${escapeHtml(String(val))}">
  </div>`;
}

/** 枚举候选下拉 —— 所有节点共用同一份，别按节点重复生成 */
function enhDatalistsHtml() {
  const out = [];
  for (const f of DLSS_FIELDS) {
    if (f.type !== 'enum' || !Array.isArray(f.options)) continue;
    out.push(`<datalist id="hl-dl-enh-dlss-${f.key}">${f.options.map((o) => `<option value="${escapeHtml(o)}"></option>`).join('')}</datalist>`);
  }
  return out.join('');
}

function enhGroupHtml(kind, node, index, merged) {
  const fields = kind === 'dlss' ? DLSS_FIELDS : MASK_FIELDS;
  // 和 LoRA 一样用序号标识分组（DLSS1/DLSS2…），后面跟工作流里的真实节点号，方便进 ComfyUI 对照
  const head = kind === 'dlss' ? `DLSS${index + 1}` : '遮罩羽化';
  return `<details class="hl-enh-group" data-enh-group="${kind}-${escapeHtml(node.id)}"${kind === 'mask' ? ' open' : ''}>
    <summary class="hl-enh-head">
      <span class="hl-enh-nm">${head} <span class="hl-enh-id">#${escapeHtml(node.id)}</span></span>
      <span class="hl-enh-sum">${escapeHtml(enhSummary(kind, merged))}</span>
    </summary>
    <div class="hl-enh-fields">${fields.map((f) => enhFieldHtml(kind, node.id, f, merged[f.key])).join('')}</div>
  </details>`;
}

/**
 * 渲染画质增强区。
 *
 * 值优先级：面板存值 > 工作流当前值。
 * 面板只存**被改过的字段**，所以换工作流后旧 id 对不上就自动回落工作流原值。
 */
function renderEnhance(container, be) {
  const body = $(container, '#hl-enhance-body');
  if (!body) return;

  if (!be.enhance || typeof be.enhance !== 'object') be.enhance = {};
  const E = be.enhance;
  for (const kind of ['dlss', 'mask']) {
    if (!E[kind] || typeof E[kind] !== 'object') E[kind] = { enabled: true, nodes: {} };
    if (!E[kind].nodes || typeof E[kind].nodes !== 'object') E[kind].nodes = {};
  }

  const det = detectEnhance(be.workflowJson);
  const parts = [];

  if (det.dlss.length) {
    parts.push(`<div class="hl-subtitle">DLSS 上采样 · 检测到 ${det.dlss.length} 个节点</div>`);
    det.dlss.forEach((n, i) => {
      parts.push(enhGroupHtml('dlss', n, i, { ...n.values, ...(E.dlss.nodes[n.id] || {}) }));
    });
  }
  if (det.mask.length) {
    parts.push(`<div class="hl-subtitle">遮罩羽化 · 检测到 ${det.mask.length} 个节点</div>`);
    det.mask.forEach((n, i) => {
      parts.push(enhGroupHtml('mask', n, i, { ...n.values, ...(E.mask.nodes[n.id] || {}) }));
    });
  }
  if (!parts.length) {
    parts.push('<div class="hl-hint">当前工作流里没有 <code>NvidiaDLSSImageUpscale</code> / <code>GrowMaskWithBlur</code> 节点 —— 这个面板只对包含它们的预设生效。</div>');
  }

  body.innerHTML = parts.join('') + enhDatalistsHtml();
}

function updateEnhSummary(body, kind, nodeId) {
  const g = body.querySelector(`[data-enh-group="${kind}-${nodeId}"]`);
  if (!g) return;
  const vals = {};
  g.querySelectorAll('[data-enh-key]').forEach((el) => {
    vals[el.dataset.enhKey] = el.dataset.enhType === 'bool' ? !!el.checked : el.value;
  });
  const sum = g.querySelector('.hl-enh-sum');
  if (sum) sum.textContent = enhSummary(kind, vals);
}

/**
 * 换工作流时把**上一份工作流的节点参数**清掉。
 *
 * 为什么必须清：参数是按节点 id 存的（`nodes["20"]`），新工作流里
 * 恰好也有个 id=20 的节点时，旧值会被当成"用户调过的值"写进新工作流 ——
 * 而这种误差没有任何提示，用户只会觉得「换了工作流画质不对」。
 * 注意只在**导入 / 清空**时清，手改 JSON 时不清（那可能只是改了别处）。
 */
function resetEnhanceNodes(be) {
  be.enhance = { dlss: { enabled: true, nodes: {} }, mask: { enabled: true, nodes: {} } };
}

/** 事件委托：面板内容会整块重渲染，逐个绑监听会漏 */
function bindEnhance(container, be) {
  const body = $(container, '#hl-enhance-body');
  if (!body || body.dataset.hlEnhBound === '1') return;
  body.dataset.hlEnhBound = '1';

  body.addEventListener('change', (e) => {
    const el = e.target;
    const { enhKind: kind, enhNode: nodeId, enhKey: key, enhType: type } = el?.dataset || {};
    if (!kind || !nodeId || !key) return;

    const E = be.enhance;
    const bucket = kind === 'dlss' ? E.dlss : E.mask;
    if (!bucket?.nodes) return;

    let val;
    if (type === 'bool') {
      val = !!el.checked;
    } else if (type === 'number') {
      const n = Number(el.value);
      if (!Number.isFinite(n)) return;      // 非法输入：不动配置，等用户改
      val = n;
    } else {
      val = String(el.value ?? '').trim();
    }

    if (!bucket.nodes[nodeId]) bucket.nodes[nodeId] = {};
    if (type !== 'bool' && val === '') delete bucket.nodes[nodeId][key];
    else bucket.nodes[nodeId][key] = val;

    // 该节点一个字段都没改过 → 删掉空壳，回落工作流原值
    if (!Object.keys(bucket.nodes[nodeId]).length) delete bucket.nodes[nodeId];

    saveSettings();
    updateEnhSummary(body, kind, nodeId);
  });
}

/* ============ 工作流体检 ============ */

function renderWorkflowReport(container, text) {
  const box = $(container, '#hl-wf-result');
  if (!box) return;
  const res = analyzeWorkflow(text);

  if (!text?.trim()) {
    box.innerHTML = '<div class="hl-hint">还没有工作流。粘进来后点「体检」。</div>';
    return;
  }

  // 提示（hints）不阻断提交，只是"可以更好"的地方 —— 与 problems 分开显示，
  // 免得用户以为工作流不能用了。
  const hints = res.hints?.length
    ? `<div class="hl-hints">
         <div class="hl-hints-title">可以更顺手（不影响出图）</div>
         ${res.hints.map(h => `<div class="hl-note">· ${markPlaceholders(h)}</div>`).join('')}
       </div>`
    : '';

  if (res.ok) {
    const size = `${Object.keys(res.workflow).length} 个节点`;
    box.innerHTML = `
      <div class="hl-ok">体检通过 · ${size}</div>
      <div class="hl-hint">识别到占位符：<code>${res.placeholders.map(escapeHtml).join('</code> <code>')}</code></div>
      ${res.samplers?.length ? `<div class="hl-hint">采样器节点：${escapeHtml(res.samplers.join(', '))}</div>` : ''}
      ${hints}`;
  } else {
    box.innerHTML = `
      <div class="hl-bad">体检不通过</div>
      <ul class="hl-problems">${res.problems.map(p => `<li>${escapeHtml(p)}</li>`).join('')}</ul>
      ${hints}`;
  }
}

/* ============ 深度体检（v0.9.108） ============ */

/**
 * 渲染深检结果。
 *
 * 为什么和「格式体检」分开显示：格式不通过 = 这份工作流根本提交不了；
 * 深检发现的是「能提交但会跑挂 / 静默不生效」的问题 —— 两者严重程度和修法都不同，
 * 混在一个框里用户会以为是一回事。
 *
 * @param {object} be
 * @param {{resources?:object|null, stamp?:string, loading?:boolean}} opts
 */
function renderAudit(container, be, opts = {}) {
  const box = $(container, '#hl-wf-audit');
  if (!box) return;

  if (opts.loading) {
    box.innerHTML = '<div class="hl-hint">深度体检中…（正在核对工作流里的模型 / CLIP / LoRA 在 ComfyUI 上是否真实存在）</div>';
    return;
  }
  if (!String(be.workflowJson || '').trim()) {
    box.innerHTML = '';
    return;
  }

  const res = auditWorkflow(be.workflowJson, {
    panel: {
      model: be.model, vae: be.vae, clip: be.clip, clipType: be.clipType,
      negative: be.negative, loras: be.loras,
    },
    resources: opts.resources ?? null,
  });

  const stamp = opts.stamp ? ` · ${escapeHtml(opts.stamp)}` : '';
  const errs = res.items.filter((i) => i.level === 'error');
  const warns = res.items.filter((i) => i.level === 'warn');
  const infos = res.items.filter((i) => i.level === 'info');

  const head = errs.length
    ? `<div class="hl-bad">深度体检：发现 ${errs.length} 个会导致失败的问题${stamp}</div>`
    : `<div class="hl-ok">深度体检通过${stamp}</div>`;

  const ul = (list, cls) => `<ul class="${cls}">${list.map((i) => `<li>${markPlaceholders(i.text)}</li>`).join('')}</ul>`;

  box.innerHTML = `
    ${head}
    ${errs.length ? ul(errs, 'hl-problems') : ''}
    ${warns.length ? `<div class="hl-hints"><div class="hl-hints-title">建议修一下（不出错，但会静默不生效）</div>${ul(warns, 'hl-audit-list')}</div>` : ''}
    ${infos.length ? `<div class="hl-hints"><div class="hl-hints-title">说明</div>${ul(infos, 'hl-audit-list')}</div>` : ''}`;
}

/** 带超时的资源拉取 —— ComfyUI 不在时别让按钮卡在那里转 */
function fetchResourcesWithTimeout(url, ms = 4000) {
  return Promise.race([
    fetchResources(url).catch(() => null),
    new Promise((r) => setTimeout(() => r(null), ms)),
  ]);
}

/**
 * 点击「体检」跑的完整流程（异步）。
 *
 * 关键：**先出本地结论、再补资源核对** —— 用户点下去立刻看到东西，
 * 而不是等 4 秒网络超时才知道有没有问题。
 */
async function runAudit(container, be, btn) {
  renderAudit(container, be, { loading: true, resources: null });

  const cfg = getConfig();
  let resources = null;
  const cached = cfg.resourceCache;
  // 「缓存可用」= 有 at 时间戳 **且** 至少拉到过一个非空列表。
  // 只判 at 会把「拉过一次但全失败」的空壳缓存当成有效资源，接着一条都不核对却显示"通过"。
  const hasList = (r) => !!r && ['checkpoints', 'unet', 'vae', 'clips', 'loras'].some((k) => Array.isArray(r[k]) && r[k].length);
  const fresh = hasList(cached) && (Date.now() - Number(cached.at || 0)) < 10 * 60 * 1000;

  if (fresh) {
    resources = cached;
  } else {
    resources = await fetchResourcesWithTimeout(be.serverUrl);
    // fetchResources 拉不到时返回 {} —— 空对象没意义，别写进缓存
    if (hasList(resources)) {
      cfg.resourceCache = { ...resources, at: Date.now() };
      saveSettings();
      fillDatalists(container, cfg.resourceCache);
    } else {
      resources = null;
    }
  }

  const now = new Date();
  const stamp = `刚刚 ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')} 检查`;
  renderAudit(container, be, { resources, stamp });

  if (btn) { btn.disabled = false; btn.textContent = '体检'; }
}

/* ============ 预设管理 ============ */

/**
 * 预设快照覆盖的字段 —— 刻意排除 serverUrl / enabled / timeoutSec：
 * 连接是全局的，不随工作流换。其余（工作流 + 资源 + 参数 + LoRA + 跟随标志）整套换。
 */
const PRESET_FIELDS = [
  'workflowJson', 'model', 'vae', 'clip', 'clipType', 'clipSkip', 'loras',
  'steps', 'cfg', 'sampler', 'scheduler', 'width', 'height', 'negative',
  'nlFallback', 'followWorkflow', 'wfDefaults', 'enhance',
];

const snapshotPreset = (be) => Object.fromEntries(
  PRESET_FIELDS.map((k) => [k, JSON.parse(JSON.stringify(be[k] ?? null))]),
);

function applyPreset(be, snap) {
  for (const k of PRESET_FIELDS) {
    if (k in snap) be[k] = JSON.parse(JSON.stringify(snap[k]));
  }
}

/** 确保新字段存在（老配置还没走过 mergeDefaults 的极端情况）。 */
function ensurePresetState(be) {
  if (!be.presets || typeof be.presets !== 'object') be.presets = {};
  if (typeof be.presetName !== 'string') be.presetName = '';
  if (!be.followWorkflow || typeof be.followWorkflow !== 'object') {
    be.followWorkflow = { model: false, vae: false, clip: false, clipType: false };
  }
  if (!be.wfDefaults || typeof be.wfDefaults !== 'object') {
    be.wfDefaults = { model: '', vae: '', clip: '', clipType: '' };
  }
}

function fillPresetSelect(container, be) {
  const el = $(container, '#hl-wfpreset');
  if (!el) return;
  const names = Object.keys(be.presets).sort((a, b) => a.localeCompare(b, 'zh'));
  // 选中名已不在列表（被删/改名）→ 归位到「当前配置」，别让 select 静默显示第一项
  if (be.presetName && !names.includes(be.presetName)) be.presetName = '';
  el.innerHTML = [
    '<option value="">（当前配置 · 未存为预设）</option>',
    ...names.map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`),
  ].join('');
  el.value = String(be.presetName || '');
}

/**
 * 「跟随工作流」勾选状态 → 输入框的可用性 / 显示值。
 * 跟随的格子禁用并显示记录下来的工作流原值（没有就空着），让用户看得见绘灵在跟什么。
 */
function syncFollowState(container, be) {
  const fw = be.followWorkflow || {};
  const defs = be.wfDefaults || {};
  for (const kind of ['model', 'clip', 'vae']) {
    const el = $(container, `#hl-${kind}`);
    const cb = $(container, `#hl-follow-${kind}`);
    if (!el || !cb) continue;
    if (cb.checked !== !!fw[kind]) cb.checked = !!fw[kind];
    el.disabled = !!fw[kind];
    el.value = fw[kind] ? String(defs[kind] || '') : String(be[kind] || '');
  }
  const ct = $(container, '#hl-clip-type');
  const cbt = $(container, '#hl-follow-clipType');
  if (ct && cbt) {
    cbt.checked = !!fw.clipType;
    ct.disabled = !!fw.clipType;
    const val = fw.clipType ? String(defs.clipType || '') : String(be.clipType || '');
    ct.innerHTML = clipTypeOptionsHtml(val, getConfig().resourceCache);
    ct.value = val;
  }
}

/* ============ AI 适配报告 ============ */

function renderAdaptReport(container, r) {
  const box = $(container, '#hl-wf-adapt');
  if (!box) return;
  const df = r.defaults || {};
  const defLine = ['model', 'vae', 'clip', 'clipType'].filter((k) => df[k])
    .map((k) => `${k}=${df[k]}`).join(' · ');
  box.innerHTML = `
    <div class="hl-ok">适配完成（${escapeHtml(r.source)}）：${r.changes.length} 处替换</div>
    ${defLine ? `<div class="hl-hint">工作流原值已记录（跟随工作流时用它）：${markPlaceholders(defLine)}</div>` : ''}
    ${r.changes.length ? `<ul class="hl-problems">${r.changes.map((c) => `<li>${markPlaceholders(c)}</li>`).join('')}</ul>` : ''}
    ${r.warnings.length ? `<div class="hl-bad">需要人工确认：</div><ul class="hl-problems">${r.warnings.map((w) => `<li>${markPlaceholders(w)}</li>`).join('')}</ul>` : ''}
    ${r.notes.length ? `<div class="hl-hints">${r.notes.map((n) => `<div class="hl-note">· ${markPlaceholders(n)}</div>`).join('')}</div>` : ''}`;
}

/** 工作流区自己的消息行（连接状态行离得远，导入/适配的消息贴着报告显示）。 */
function wfMsg(container, msg, isErr) {
  const box = $(container, '#hl-wf-adapt');
  if (!box) return;
  box.innerHTML = `<div class="hl-hint${isErr ? ' hl-err' : ''}">${escapeHtml(msg)}</div>`;
}

/* ============ 挂载 ============ */

/**
 * @param {HTMLElement} container 面板容器
 * @param {(key:string)=>void} [onChannelChange] 渠道头里改了「启用/生效」后回调外层重渲染
 */
export async function mount(container, onChannelChange) {
  const cfg = getConfig();
  const be = cfg.backends.comfyui;
  ensurePresetState(be);

  /** 预设切换 / 适配后整套字段都变了 —— 重挂面板是最省心的同步方式。 */
  const remount = () => mount(container, onChannelChange);

  container.innerHTML = html(cfg);

  if (cfg.resourceCache?.at) fillDatalists(container, cfg.resourceCache);
  fillClipTypes(container, be, cfg.resourceCache);

  renderLoraRows(container);
  renderWorkflowReport(container, be.workflowJson);
  renderClipTypeHint(container, be);
  renderNlState(container);
  fillPresetSelect(container, be);
  syncFollowState(container, be);
  renderEnhance(container, be);
  bindEnhance(container, be);
  renderAudit(container, be, { resources: cfg.resourceCache || null });
  enableSectionCollapse(container);

  bindChannelHeader(container, 'comfyui', onChannelChange);

  const status = (msg, isErr) => renderStatus(container, 'hl-conn-status', msg, isErr);

  bindInput(container, '#hl-url', el => el.value.trim(), v => { be.serverUrl = v; });
  bindInput(container, '#hl-cfy-timeout', el => Number(el.value), v => {
    // 留空 / 填 0 时存 0，读取侧用 `|| 300` 兜底；夹在 [30,1800] 防止手滑
    be.timeoutSec = v > 0 ? Math.min(1800, Math.max(30, Math.round(v))) : 0;
  }, { after: el => { el.value = Number(be.timeoutSec) || 300; } });
  bindInput(container, '#hl-model', el => el.value.trim(), v => { be.model = v; });
  bindInput(container, '#hl-clip', el => el.value.trim(), v => {
    be.clip = v;
    renderClipTypeHint(container, be);
  });
  bindSelect(container, '#hl-clip-type', v => { be.clipType = v; renderClipTypeHint(container, be); });
  bindInput(container, '#hl-vae', el => el.value.trim(), v => { be.vae = v; });
  // 全局前缀/后缀/负面已搬到「全局词库」页（v0.9.11）—— 配置字段没动，出图管线无感
  bindInput(container, '#hl-negative', el => el.value, v => { be.negative = v; });

  bindInput(container, '#hl-steps', el => Number(el.value), v => { be.steps = v; }, { after: el => { el.value = be.steps; } });
  bindInput(container, '#hl-cfg', el => Number(el.value), v => { be.cfg = v; }, { after: el => { el.value = be.cfg; } });
  bindInput(container, '#hl-w', el => Number(el.value), v => { be.width = v; }, { after: el => { el.value = be.width; syncResState(container, be); } });
  bindInput(container, '#hl-h', el => Number(el.value), v => { be.height = v; }, { after: el => { el.value = be.height; syncResState(container, be); } });
  bindInput(container, '#hl-sampler', el => el.value.trim(), v => { be.sampler = v; });
  bindInput(container, '#hl-scheduler', el => el.value.trim(), v => { be.scheduler = v; });

  /* ---- 分辨率选择器（v0.9.104）：开了 = 比例+像素，关了 = 手填宽高 ---- */
  if (!be.resSelector || typeof be.resSelector !== 'object') {
    be.resSelector = { enabled: false, ...RES_DEFAULTS };
  }
  bindCheck(container, '#hl-res-selector', (checked) => {
    be.resSelector.enabled = checked;
    info(STAGE.UI, `分辨率：${checked ? '用工作流的分辨率选择器（比例 + 百万像素）' : '用手填的宽 / 高'}`);
  }, { after: () => syncResState(container, be) });

  bindInput(container, '#hl-res-aspect', el => el.value.trim(), (v) => {
    be.resSelector.aspect = v || RES_DEFAULTS.aspect;
  }, { after: (el) => { el.value = be.resSelector.aspect; syncResState(container, be); } });

  bindInput(container, '#hl-res-mp', el => Number(el.value), (v) => {
    be.resSelector.megapixels = Number.isFinite(v) && v > 0
      ? Math.min(16, Math.max(0.1, v))
      : RES_DEFAULTS.megapixels;
  }, { after: (el) => { el.value = be.resSelector.megapixels; syncResState(container, be); } });

  bindInput(container, '#hl-res-mult', el => Number(el.value), (v) => {
    be.resSelector.multiple = Number.isFinite(v) && v >= 8
      ? Math.min(128, Math.round(v / 4) * 4)
      : RES_DEFAULTS.multiple;
  }, { after: (el) => { el.value = be.resSelector.multiple; syncResState(container, be); } });

  syncResState(container, be);

  bindInput(container, '#hl-wf', el => el.value, v => { be.workflowJson = v; });

  /* ---- 跟随工作流：四个勾选框 ---- */
  for (const kind of ['model', 'clip', 'clipType', 'vae']) {
    bindCheck(container, `#hl-follow-${kind}`, (checked) => {
      be.followWorkflow[kind] = checked;
      info(STAGE.UI, `「${kind}」跟随工作流：${checked ? '开 —— 用工作流里的原值' : '关 —— 由面板控制'}`);
    }, { after: () => syncFollowState(container, be) });
  }

  /* ---- 预设管理 ---- */
  bindSelect(container, '#hl-wfpreset', (v) => {
    be.presetName = v;
    if (v && be.presets[v]) {
      applyPreset(be, be.presets[v]);
      info(STAGE.UI, `已切换到预设「${v}」（工作流 + 资源 + 参数整套应用）`);
    }
    saveSettings();
  }, { after: () => remount() });

  $(container, '#hl-wfpreset-new')?.addEventListener('click', () => {
    const name = (prompt('新预设名称（保存当前整套本地生成配置）：',
      `预设${Object.keys(be.presets).length + 1}`) || '').trim();
    if (!name) return;
    if (be.presets[name] && !confirm(`预设「${name}」已存在，覆盖它？`)) return;
    be.presets[name] = snapshotPreset(be);
    be.presetName = name;
    saveSettings();
    info(STAGE.UI, `预设「${name}」已保存`);
    remount();
  });

  $(container, '#hl-wfpreset-save')?.addEventListener('click', () => {
    if (!be.presetName) {
      // 没选中预设 → 「保存改动」等同新建（先问名字）
      const name = (prompt('当前配置还没存为预设 —— 给它起个名字：',
        `预设${Object.keys(be.presets).length + 1}`) || '').trim();
      if (!name) return;
      be.presets[name] = snapshotPreset(be);
      be.presetName = name;
    } else {
      be.presets[be.presetName] = snapshotPreset(be);
    }
    saveSettings();
    wfMsg(container, `已保存到预设「${be.presetName}」`);
    remount();
  });

  $(container, '#hl-wfpreset-rename')?.addEventListener('click', () => {
    if (!be.presetName) { wfMsg(container, '当前是未存为预设的配置 —— 先「新建」或从下拉选一个', true); return; }
    const to = (prompt(`把预设「${be.presetName}」重命名为：`, be.presetName) || '').trim();
    if (!to || to === be.presetName) return;
    if (be.presets[to] && !confirm(`预设「${to}」已存在，覆盖它？`)) return;
    be.presets[to] = be.presets[be.presetName];
    delete be.presets[be.presetName];
    be.presetName = to;
    saveSettings();
    remount();
  });

  $(container, '#hl-wfpreset-del')?.addEventListener('click', () => {
    if (!be.presetName) { wfMsg(container, '请先从下拉里选中要删除的预设', true); return; }
    if (!confirm(`确定删除预设「${be.presetName}」？（不影响当前配置本身）`)) return;
    delete be.presets[be.presetName];
    be.presetName = '';
    saveSettings();
    remount();
  });

  // 中文描述总开关（开着才可能带中文；关了就是纯 tag）
  bindCheck(container, '#hl-nl-enabled', v => { cfg.nlEnabled = v; }, { after: () => renderNlState(container) });

  // 工作流改动即时体检（防抖）
  let wfTimer = null;
  $(container, '#hl-wf')?.addEventListener('input', (e) => {
    if (wfTimer) clearTimeout(wfTimer);
    wfTimer = setTimeout(() => {
      renderWorkflowReport(container, e.target.value);
      renderNlState(container);   // 工作流改了，中文走的路可能也变了
      // 画质增强面板跟着工作流走 —— 不重渲染的话，用户看到的还是上一份工作流的节点，
      // 改了参数也对不上（applyEnhance 按 id 找节点），静默无效。
      renderEnhance(container, be);
      // 深检用缓存里的资源列表跑一遍本地项（不联网，不打扰）；要看资源核对得点「体检」
      renderAudit(container, be, { resources: getConfig().resourceCache || null });
    }, 500);
  });

  $(container, '#hl-wf-check')?.addEventListener('click', async () => {
    const btn = $(container, '#hl-wf-check');
    const t = $(container, '#hl-wf').value;
    be.workflowJson = t;
    saveSettings();
    renderWorkflowReport(container, t);   // ① 格式体检（同步，立刻出）
    renderNlState(container);
    renderEnhance(container, be);
    if (btn) { btn.disabled = true; btn.textContent = '体检中…'; }
    await runAudit(container, be, btn);   // ② 深度体检（可能连 ComfyUI 核对资源）
  });

  $(container, '#hl-wf-clear')?.addEventListener('click', () => {
    if (!confirm('确定清空工作流？')) return;
    be.workflowJson = '';
    $(container, '#hl-wf').value = '';
    resetEnhanceNodes(be);        // 工作流都没了，按节点 id 存的参数留着只会污染下一份
    saveSettings();
    renderWorkflowReport(container, '');
    renderEnhance(container, be);
    renderAudit(container, be, { resources: null });
  });

  /* ---- 导入工作流（文件；UI 格式自动转 API 格式） ---- */
  const fileInput = $(container, '#hl-wf-import-file');
  $(container, '#hl-wf-import')?.addEventListener('click', () => fileInput?.click());
  fileInput?.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    fileInput.value = '';
    if (!file) return;
    let text = '';
    try { text = await file.text(); } catch (e) { wfMsg(container, `读文件失败：${e?.message || e}`, true); return; }

    const det = detectWorkflowFormat(text);
    if (det.format === 'api') {
      be.workflowJson = text;
      $(container, '#hl-wf').value = text;
      resetEnhanceNodes(be);   // 换了工作流 = 旧的按 id 存的参数全部作废
      saveSettings();
      renderWorkflowReport(container, text);
      renderNlState(container);
      renderEnhance(container, be);
      renderAudit(container, be, { resources: getConfig().resourceCache || null });
      wfMsg(container, `已导入 API 格式工作流（${file.name}）—— 建议点「AI 分析适配」自动改成占位符工作流`);
    } else if (det.format === 'ui') {
      wfMsg(container, 'UI 格式，正在转成 API 格式（借 ComfyUI 查各节点的控件定义）…');
      const url = be.serverUrl || '';
      const fetchNodeInfo = async (cls) => {
        try {
          const res = await fetch(`${url.replace(/\/+$/, '')}/object_info/${encodeURIComponent(cls)}`);
          if (!res.ok) return null;
          const data = await res.json();
          return data?.[cls] || null;
        } catch { return null; }
      };
      const conv = await convertUiToApi(det.parsed, fetchNodeInfo);
      if (!conv.ok) {
        wfMsg(container, `UI 格式转换失败 —— 请在 ComfyUI 里用「保存（API 格式）」导出后重试。第一个问题：${conv.problems[0]}`, true);
        warn(STAGE.UI, `工作流 UI→API 转换失败：${conv.problems.join('；')}`);
        return;
      }
      const apiText = JSON.stringify(conv.workflow, null, 1);
      be.workflowJson = apiText;
      $(container, '#hl-wf').value = apiText;
      resetEnhanceNodes(be);
      saveSettings();
      renderWorkflowReport(container, apiText);
      renderNlState(container);
      renderEnhance(container, be);
      renderAudit(container, be, { resources: getConfig().resourceCache || null });
      wfMsg(container, `已导入并转换为 API 格式（${file.name}）—— 建议点「AI 分析适配」自动改成占位符工作流`);
      if (conv.warnings.length) info(STAGE.UI, `转换提示：${conv.warnings.join('；')}`);
    } else {
      wfMsg(container, `导入失败：${det.error}`, true);
    }
  });

  /* ---- AI 分析适配 ---- */
  $(container, '#hl-wf-adapt-btn')?.addEventListener('click', async () => {
    const btn = $(container, '#hl-wf-adapt-btn');
    if (btn) btn.disabled = true;
    try {
      const t = $(container, '#hl-wf').value;
      be.workflowJson = t;
      saveSettings();

      const det = detectWorkflowFormat(t);
      if (det.format !== 'api') {
        wfMsg(container, det.format === 'ui'
          ? '这是 UI 格式工作流 —— 请先点「导入工作流」自动转换，或在 ComfyUI 里用「保存（API 格式）」导出'
          : `无法解析：${det.error}`, true);
        return;
      }
      const wf0 = det.parsed;

      wfMsg(container, '本地规则分析中…');
      const plan = planAdaptation(wf0, { follow: be.followWorkflow });

      const notes = [];
      let source = '本地规则';
      try {
        wfMsg(container, '本地规则完成 —— AI 分析中（走出词 API 通道，可能要几十秒）…');
        const msgs = buildAiMessages(wf0, plan, { follow: be.followWorkflow });
        const reply = await callAnalyzeLLM(msgs, { source: '工作流适配' });
        if (!String(reply || '').trim()) throw new Error('出词通道返回为空');
        const ai = parseAiPatchText(reply);
        const v = validateAiPatch(wf0, ai, plan);
        notes.push(...v.notes);
        if (!v.ok) {
          notes.unshift(`AI 补丁有 ${v.problems.length} 条没过校验被丢弃（首条：${v.problems[0]}）`);
        } else if (Object.keys(v.additions).length) {
          mergeAiAdditions(plan, v.additions);
          source = '本地规则 + AI';
        }
      } catch (e) {
        notes.push(`AI 分析不可用（${String(e?.message || e).slice(0, 140)}）—— 已按本地规则结果应用，拿不准的条目看下方「需要人工确认」`);
      }

      // 应用补丁 + 回填面板
      const { text } = applyPatch(wf0, plan.patch);
      be.workflowJson = text;
      be.wfDefaults = { ...be.wfDefaults, ...plan.defaults };
      const bf = plan.backfill || {};
      for (const kind of ['model', 'vae', 'clip', 'clipType']) {
        if (bf[kind] && !bf[kind].follow) be[kind] = bf[kind].value;
      }
      if (bf.width) be.width = bf.width;
      if (bf.height) be.height = bf.height;
      if (bf.steps) be.steps = bf.steps;
      if (bf.cfg) be.cfg = bf.cfg;
      if (bf.sampler) be.sampler = bf.sampler;
      if (bf.scheduler) be.scheduler = bf.scheduler;
      if (bf.clipSkip !== undefined) be.clipSkip = bf.clipSkip;
      if (!String(be.negative || '').trim() && bf.negativePrompt) be.negative = bf.negativePrompt;
      if (plan.loras?.length) {
        be.loras = plan.loras.map((l) => ({ name: l.name, strength: l.strength, enabled: true }));
      }
      saveSettings();
      info(STAGE.UI, `工作流适配完成（${source}）：${plan.changes.length} 处替换`);

      await remount();
      renderAdaptReport(container, {
        source, changes: plan.changes, warnings: plan.warnings, notes, defaults: plan.defaults,
      });
    } finally {
      const btn2 = $(container, '#hl-wf-adapt-btn');
      if (btn2) btn2.disabled = false;
    }
  });

  $(container, '#hl-lora-add')?.addEventListener('click', () => {
    if (!Array.isArray(be.loras)) be.loras = [];
    const newRow = be.loras.length + 1;
    be.loras.push({ name: '', strength: 1, enabled: true });
    // 加行自动补槽：行号超过工作流槽位时，自动在模型链上补出对应的「绘灵 LoRA 槽」
    // （以前要单独点「补齐槽位」—— 用户 2026-10-18：加行就该带上槽）
    const det = detectWorkflowFormat(be.workflowJson || '');
    if (det.format === 'api') {
      const cur = maxLoraSlotIn(det.parsed);
      if (newRow > cur) {
        // 自动适配加载器类型：工作流已有绘灵槽是「带 CLIP」的就补带 CLIP 的，否则补仅模型的
        const withClip = loraSlotTypeIn(det.parsed) === 'clip';
        const res = insertLoraSlots(det.parsed, { count: newRow - cur, withClip });
        if (res.ok) {
          be.workflowJson = res.text;
          wfMsg(container, `已自动给工作流补出${withClip ? '「带 CLIP」' : '「仅模型」'}槽 ${res.slots.map((s) => `%lora${s}%`).join(' ')}（沿用你现有槽的类型）—— 新行填上 LoRA 名即可生效`);
        } else {
          wfMsg(container, `补槽失败：${res.problems[0]}`, true);
        }
      }
    }
    saveSettings();
    renderLoraRows(container);
  });

  $(container, '#hl-lora-clear')?.addEventListener('click', () => {
    if (!confirm('确定清空全部 LoRA 槽位？')) return;
    be.loras = [];
    saveSettings();
    renderLoraRows(container);
  });

  /**
   * 补齐槽位：工作流里没有 %loraN% 入口时，在模型链末端串接标准 LoRA 节点。
   * 用户问「工作流本身没加 LoRA，我在绘灵里加能起效果吗」—— 补完槽就能。
   */
  $(container, '#hl-lora-slots')?.addEventListener('click', async () => {
    const det = detectWorkflowFormat(be.workflowJson);
    if (det.format !== 'api') {
      wfMsg(container, '先有工作流才能补槽 —— 导入或粘贴一份 API 格式工作流', true);
      return;
    }
    const cur = maxLoraSlotIn(det.parsed);
    // 自动适配：现有槽是带 CLIP 的就默认补带 CLIP 的（用户两种加载器都用）
    const curType = loraSlotTypeIn(det.parsed);
    const suggest = Math.min(LORA_SLOT_LIMIT, cur + 3);
    const ans = (prompt(
      `当前工作流里的 LoRA 槽位：${cur ? `%lora1% ~ %lora${cur}%${curType === 'clip' ? '（带 CLIP 型）' : curType === 'model' ? '（仅模型型）' : ''}` : '一个都没有（面板上的行都是空转的）'}\n`
      + `补到几个槽？（1-${LORA_SLOT_LIMIT}，上限内随便填）\n`
      + '⚠️ 只补数量：槽的类型沿用现有类型；想换成另一种，先在面板删掉所有槽再补。',
      String(suggest),
    ) || '').trim();
    if (!ans) return;
    const target = Number(ans);
    if (!Number.isFinite(target) || target < 1 || target > LORA_SLOT_LIMIT) {
      wfMsg(container, `槽位数要在 1-${LORA_SLOT_LIMIT} 之间`, true);
      return;
    }
    const count = target - cur;
    if (count <= 0) {
      wfMsg(container, `工作流已有 ${cur} 个槽，不用补 —— 直接在上面加行即可`);
      return;
    }

    const res = insertLoraSlots(det.parsed, { count, withClip: curType === 'clip' });
    if (!res.ok) {
      wfMsg(container, `补槽失败：${res.problems[0]}`, true);
      warn(STAGE.UI, `补 LoRA 槽失败：${res.problems.join('；')}`);
      return;
    }

    // 新行不能留空（空行会报占位符没值）—— 用一支真实存在的 LoRA 名兜底、强度 0、默认不启用
    const cache = getConfig().resourceCache || {};
    const fill = (be.loras || []).map((l) => String(l?.name || '').trim()).find(Boolean)
      || (cache.loras || [])[0] || '';
    if (!fill) {
      wfMsg(container, '补槽需要一个真实 LoRA 名来填新行 —— 先点上方「拉取资源」，或手动在第一行填一个 LoRA 文件名', true);
      return;
    }
    if (!Array.isArray(be.loras)) be.loras = [];
    while (be.loras.length < target) be.loras.push({ name: fill, strength: 0, enabled: false });

    be.workflowJson = res.text;
    saveSettings();
    info(STAGE.UI, `已给工作流补出 LoRA 槽 %lora${res.slots[0]}% ~ %lora${res.slots[res.slots.length - 1]}%`);
    await remount();
    wfMsg(container, `已补出 ${res.slots.length} 个槽（%lora${res.slots[0]}% ~ %lora${res.slots[res.slots.length - 1]}%）—— `
      + '面板最后几行就是它们，勾上并改成你要的 LoRA 即可（默认强度 0、不启用，不影响画面）');
  });

  $(container, '#hl-probe')?.addEventListener('click', async () => {
    status('正在测试连接…');
    const res = await probe(be.serverUrl);
    status(res.ok ? `连接正常：${res.device}${res.version ? ` (${res.version})` : ''}` : `连接失败：${res.error}｜${res.hint || ''}`, !res.ok);
  });

  $(container, '#hl-fetch')?.addEventListener('click', async () => {
    status('正在拉取资源列表…');
    const url = be.serverUrl || '';
    const res = await fetchResources(url);
    const extra = await fetchSamplerOptions(url);
    const cache = {
      at: Date.now(),
      models: res.checkpoints || [],
      unet: res.unet || [],
      loras: res.loras || [],
      vae: res.vae || [],
      clips: res.clips || [],
      clipTypes: res.clipTypes || [],
      samplers: extra.samplers,
      schedulers: extra.schedulers,
    };
    cfg.resourceCache = cache;
    saveSettings();
    fillDatalists(container, cache);
    fillClipTypes(container, be, cache);
    renderClipTypeHint(container, be);

    const total = cache.models.length + cache.unet.length + cache.loras.length
      + cache.vae.length + cache.clips.length;
    if (total) {
      status(`已拉取：模型 ${cache.unet.length + cache.models.length} · LoRA ${cache.loras.length} · VAE ${cache.vae.length} · CLIP ${cache.clips.length} · CLIP 类型 ${cache.clipTypes.length} · 采样器 ${cache.samplers.length}${cache.clipTypes.length ? '' : '（这个 ComfyUI 没给类型枚举，用了内置列表）'}`);
      info(STAGE.UI, `资源列表已更新（LoRA ${cache.loras.length} 条 · CLIP ${cache.clips.length} 条 · CLIP 类型 ${cache.clipTypes.length} 条）`);
    } else {
      status('没拉到任何资源——确认 ComfyUI 正在运行、地址正确', true);
      warn(STAGE.UI, '拉取资源返回空');
    }
  });

  // 打开面板时后台拉一次最新资源 —— 新加的模型/LoRA 不用再手动点「拉取资源」
  // （2026-10-18：用户整理文件夹后下拉全是旧缓存，搜不到新 LoRA）。失败静默，不打扰。
  refreshResourcesSilently(container);
}

/**
 * 后台静默刷新资源下拉（mount 时调用一次）。
 * 只更新内存与下拉框，**不落盘** —— 写盘仍由「拉取资源」按钮负责（避免每次开面板都写 settings.json）。
 * ComfyUI 没开 / 地址不对 → 静默吞掉，连状态条都不动（手动按钮才报错）。
 */
async function refreshResourcesSilently(container) {
  const cfg = getConfig();
  const be = cfg.backends.comfyui;
  const url = String(be.serverUrl || '').trim();
  if (!url) return;
  try {
    const res = await fetchResources(url);
    if (!res || !Object.keys(res).length) return;
    const extra = await fetchSamplerOptions(url);
    const cache = {
      at: Date.now(),
      models: res.checkpoints || [],
      unet: res.unet || [],
      loras: res.loras || [],
      vae: res.vae || [],
      clips: res.clips || [],
      clipTypes: res.clipTypes || [],
      samplers: extra.samplers,
      schedulers: extra.schedulers,
    };
    cfg.resourceCache = cache;
    fillDatalists(container, cache);
    fillClipTypes(container, be, cache);
    renderLoraSlotInfo(container);
    const n = cache.loras.length + cache.models.length + cache.unet.length;
    if (n) info(STAGE.UI, `资源下拉已自动刷新（LoRA ${cache.loras.length} 条 · 模型 ${cache.models.length + cache.unet.length} 个）`);
  } catch { /* ComfyUI 没开 —— 静默 */ }
}
