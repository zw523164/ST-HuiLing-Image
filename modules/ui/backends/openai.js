/**
 * 绘灵 · OpenAI 兼容图像 API 面板
 *
 * 这个后端「能填的东西最多」，因为它的用户来自不同地方：
 * 官方 OpenAI、Gemini 的 OpenAI 兼容层、国内中转、自建服务……
 * 所以面板的策略是「默认什么都不传」+「额外参数兜底」：
 * 常用字段做成下拉，下拉里有「不指定」这一档（对应不传该字段）；
 * 对方文档里的冷门字段，直接写进「额外参数」JSON，不用等绘灵发版。
 */

import { getConfig, saveSettings } from '../../settings.js';
import {
  OPENAI_MODEL_SUGGESTIONS, OPENAI_SIZE_SUGGESTIONS, OPENAI_QUALITY_SUGGESTIONS,
  NEGATIVE_MODES, parseExtraBody,
} from '../../backends/openai.js';
import { backendMeta, probe as probeBackend, testGenerate as testGenBackend } from '../../backends/index.js';
import {
  escapeHtml, $, bindInput, bindSelect, renderStatus,
  channelHeader, bindChannelHeader, testAreaHtml, renderTestPreview, datalistHtml, putDatalist,
} from './shared.js';

function html(cfg) {
  const be = cfg.backends.openai;

  const opt = (list, current, emptyLabel) => {
    const rows = list.map(v => {
      const sel = String(current ?? '') === v ? ' selected' : '';
      return `<option value="${escapeHtml(v)}"${sel}>${escapeHtml(v || emptyLabel)}</option>`;
    }).join('');
    // 当前值不在预设列表里（用户手输过）也要能显示出来
    const inList = list.some(v => v === String(current ?? ''));
    const extra = (!inList && current) ? `<option value="${escapeHtml(current)}" selected>${escapeHtml(current)}（自定义）</option>` : '';
    return extra + rows;
  };

  return `
${channelHeader('openai', backendMeta('openai'), cfg)}

${datalistHtml('hl-oa-dl-model')}
${datalistHtml('hl-oa-dl-size')}
${datalistHtml('hl-oa-dl-quality')}

<div class="hl-section">
  <div class="hl-section-title">连接</div>
  <div class="hl-field">
    <label class="hl-label">接口地址（base url）</label>
    <input id="hl-oa-url" class="hl-input" placeholder="https://api.openai.com/v1" value="${escapeHtml(be.serverUrl || '')}">
    <div class="hl-hint">
      官方是 <code>https://api.openai.com/v1</code>（绘灵自动补 <code>/images/generations</code>）。<br>
      用中转 / 兼容层就填它给的 base url；也可以直接贴完整端点。<br>
      Gemini 兼容层一般是 <code>https://generativelanguage.googleapis.com/v1beta/openai</code>。
    </div>
  </div>
  <div class="hl-field">
    <label class="hl-label">API Key</label>
    <div class="hl-inline">
      <input id="hl-oa-key" class="hl-input hl-grow" type="password" placeholder="sk-…" value="${escapeHtml(be.apiKey || '')}">
      <button class="hl-btn hl-ghost" id="hl-oa-key-eye" type="button">显示</button>
    </div>
    <div class="hl-hint">填这家服务发给你的 Key。只存在你自己的酒馆配置里，不会外发。</div>
  </div>
  ${testAreaHtml({ withTestGen: true, genHint: '测试生图用一条固定的短提示词。' })}
</div>

<div class="hl-section">
  <div class="hl-section-title">模型与尺寸</div>
  <div class="hl-field">
    <label class="hl-label">模型</label>
    <input id="hl-oa-model" class="hl-input" list="hl-oa-dl-model" placeholder="gpt-image-1" value="${escapeHtml(be.model || '')}">
    <div class="hl-hint">
      <code>gpt-image-1</code> 只吃 1024×1024 / 1024×1536 / 1536×1024；<br>
      <code>dall-e-3</code> 是 1024×1024 / 1792×1024 / 1024×1792，且只出 1 张；<br>
      中转站往往有自己的模型名 —— 点「测试连接」能看到对方有哪些模型。
    </div>
  </div>
  <div class="hl-grid2">
    <div class="hl-field">
      <label class="hl-label">尺寸</label>
      <input id="hl-oa-size" class="hl-input" list="hl-oa-dl-size" placeholder="留空 = 不传" value="${escapeHtml(be.size || '')}">
    </div>
    <div class="hl-field">
      <label class="hl-label">质量</label>
      <input id="hl-oa-quality" class="hl-input" list="hl-oa-dl-quality" placeholder="留空 = 不传" value="${escapeHtml(be.quality || '')}">
    </div>
    <div class="hl-field">
      <label class="hl-label">张数</label>
      <input id="hl-oa-count" class="hl-input" type="number" min="1" max="10" value="${be.count}">
    </div>
    <div class="hl-field">
      <label class="hl-label">超时（秒）</label>
      <input id="hl-oa-timeout" class="hl-input" type="number" min="10" max="900" value="${be.timeoutSec}">
    </div>
  </div>
  <div class="hl-hint"><b>留空 = 不发这个字段</b>。图像接口对陌生字段很敏感，多传一个就可能被 400 顶回来（gpt-image-1 就是不吃 <code>response_format</code> 的典型）。</div>
</div>

<div class="hl-section">
  <div class="hl-section-title">兼容性</div>
  <div class="hl-grid2">
    <div class="hl-field">
      <label class="hl-label">返回格式</label>
      <select id="hl-oa-respformat" class="hl-input">
        <option value="auto"${be.responseFormat === 'auto' || !be.responseFormat ? ' selected' : ''}>不指定（推荐，兼容性最好）</option>
        <option value="b64_json"${be.responseFormat === 'b64_json' ? ' selected' : ''}>b64_json（返回 base64）</option>
        <option value="url"${be.responseFormat === 'url' ? ' selected' : ''}>url（返回链接）</option>
      </select>
    </div>
    <div class="hl-field">
      <label class="hl-label">输出格式</label>
      <select id="hl-oa-outformat" class="hl-input">
        <option value=""${!be.outputFormat ? ' selected' : ''}>不指定</option>
        <option value="png"${be.outputFormat === 'png' ? ' selected' : ''}>png</option>
        <option value="jpeg"${be.outputFormat === 'jpeg' ? ' selected' : ''}>jpeg</option>
        <option value="webp"${be.outputFormat === 'webp' ? ' selected' : ''}>webp</option>
      </select>
    </div>
  </div>
  <div class="hl-field">
    <label class="hl-label">负面提示词处理</label>
    <select id="hl-oa-negmode" class="hl-input">
      ${NEGATIVE_MODES.map(m => `<option value="${escapeHtml(m.value)}"${be.negativeMode === m.value ? ' selected' : ''}>${escapeHtml(m.label)}</option>`).join('')}
    </select>
    <div class="hl-hint">图像接口没有独立的负面通道，只能把负面词拼进正向提示词 —— 所以画质/解剖类负面词在这里的效果不如 ComfyUI 那条路。</div>
  </div>
</div>

<div class="hl-section">
  <div class="hl-section-title">额外参数（高级）</div>
  <textarea id="hl-oa-extra" class="hl-textarea hl-code" rows="4" placeholder='{"style":"vivid"}'>${escapeHtml(be.extraBody || '')}</textarea>
  <div class="hl-hint">
    一个 JSON 对象，会<b>合并进请求体并覆盖</b>上面的设置 —— 给中转站的私有字段（如 <code>{"extra_body":{…}}</code>）留的口子，不用等绘灵发版。
  </div>
  <div class="hl-status" id="hl-oa-extra-status"></div>
</div>`;
}

/**
 * @param {HTMLElement} container
 * @param {(key:string)=>void} [onChannelChange]
 */
export async function mount(container, onChannelChange) {
  const cfg = getConfig();
  const be = cfg.backends.openai;

  container.innerHTML = html(cfg);
  bindChannelHeader(container, 'openai', onChannelChange);

  // 建议值只是"提示"，用户可自由手输
  putDatalist(container, 'hl-oa-dl-model', OPENAI_MODEL_SUGGESTIONS);
  putDatalist(container, 'hl-oa-dl-size', OPENAI_SIZE_SUGGESTIONS);
  putDatalist(container, 'hl-oa-dl-quality', OPENAI_QUALITY_SUGGESTIONS);

  const status = (msg, isErr) => renderStatus(container, 'hl-conn-status', msg, isErr);

  /* 连接 */
  bindInput(container, '#hl-oa-url', el => el.value.trim(), v => { be.serverUrl = v; });
  bindInput(container, '#hl-oa-key', el => el.value.trim(), v => { be.apiKey = v; });

  $(container, '#hl-oa-key-eye')?.addEventListener('click', (e) => {
    const input = $(container, '#hl-oa-key');
    if (!input) return;
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    e.currentTarget.textContent = show ? '隐藏' : '显示';
  });

  $(container, '#hl-probe')?.addEventListener('click', async () => {
    status('正在测试连接…');
    const res = await probeBackend('openai', cfg);
    status(res.ok ? `✓ ${res.message}` : `✗ ${res.error}${res.hint ? `｜${res.hint}` : ''}`, !res.ok);
  });

  $(container, '#hl-testgen')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = '生图中…';
    status('正在跑一张测试图…');
    const res = await testGenBackend('openai', cfg, '');
    btn.disabled = false;
    btn.textContent = '测试生图';
    status(res.ok ? `✓ 测试生图成功（${res.elapsed}s）` : `✗ ${res.error}`, !res.ok);
    renderTestPreview(container, res);
  });

  /* 模型与参数 */
  bindInput(container, '#hl-oa-model', el => el.value.trim(), v => { be.model = v; });
  bindInput(container, '#hl-oa-size', el => el.value.trim(), v => { be.size = v; });
  bindInput(container, '#hl-oa-quality', el => el.value.trim(), v => { be.quality = v; });
  bindInput(container, '#hl-oa-count', el => Number(el.value), v => { be.count = v; }, { after: el => { el.value = be.count; } });
  bindInput(container, '#hl-oa-timeout', el => Number(el.value), v => { be.timeoutSec = v; }, { after: el => { el.value = be.timeoutSec; } });

  /* 兼容性 */
  bindSelect(container, '#hl-oa-respformat', v => { be.responseFormat = v; });
  bindSelect(container, '#hl-oa-outformat', v => { be.outputFormat = v; });
  bindSelect(container, '#hl-oa-negmode', v => { be.negativeMode = v; });

  /* 额外参数：边写边校验，别等出图才报错 */
  const extraStatus = (msg, isErr) => renderStatus(container, 'hl-oa-extra-status', msg, isErr);

  const checkExtra = (text) => {
    if (!text?.trim()) { extraStatus('', false); return; }
    try {
      const obj = parseExtraBody(text);
      const keys = Object.keys(obj);
      extraStatus(keys.length ? `✓ JSON 合法，将覆盖：${keys.join(', ')}` : '✓ JSON 合法（空对象）', false);
    } catch (err) {
      extraStatus(`✗ ${err.message}`, true);
    }
  };

  let extraTimer = null;
  const extraEl = $(container, '#hl-oa-extra');
  extraEl?.addEventListener('input', (e) => {
    if (extraTimer) clearTimeout(extraTimer);
    extraTimer = setTimeout(() => checkExtra(e.target.value), 400);
  });
  bindInput(container, '#hl-oa-extra', el => el.value, v => { be.extraBody = v; }, { after: () => checkExtra(be.extraBody) });
  checkExtra(be.extraBody);
}
