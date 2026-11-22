/**
 * 绘灵 · NovelAI 后端面板
 *
 * 字段编排参照「渠道」页：
 *   连接（地址 + Key + 两个测试按钮）→ 模型与采样 → 画幅 → 提示词 → 超时
 *
 * 两个测试按钮是刻意的：**Key 有效 ≠ 生图能通**。
 * NAI 这条路上「能连上但一出图就 402/403」太常见（额度、Curated 内容过滤），
 * 所以除了「测试连接」还给一个真跑一张的「测试生图」。
 */

import { getConfig, saveSettings } from '../../settings.js';
import {
  NAI_MODELS, NAI_NOISE_SCHEDULES, naiSamplers,
  naiDefaultQualityTags, naiDefaultUndesired,
} from '../../backends/nai.js';
import { backendMeta, probe as probeBackend, testGenerate as testGenBackend } from '../../backends/index.js';
import {
  escapeHtml, $, bindInput, bindCheck, bindSelect, renderStatus,
  channelHeader, bindChannelHeader, testAreaHtml, renderTestPreview,
} from './shared.js';

/** 模型下拉：列表里没有的当前值也照样显示（用户可能填了新模型）。 */
function modelOptions(current) {
  const known = NAI_MODELS.some(m => m.value === current);
  const extra = current && !known
    ? `<option value="${escapeHtml(current)}" selected>自定义：${escapeHtml(current)}</option>`
    : '';
  const rows = NAI_MODELS.map(m => {
    const sel = m.value === current ? ' selected' : '';
    return `<option value="${escapeHtml(m.value)}"${sel}>${escapeHtml(m.label)}</option>`;
  }).join('');
  return extra + rows;
}

function samplerOptions(model, current) {
  const list = naiSamplers(model);
  const has = list.some(s => s.value === current);
  const extra = current && !has ? `<option value="${escapeHtml(current)}" selected>${escapeHtml(current)}（该模型可能不支持）</option>` : '';
  const rows = list.map(s => {
    const sel = s.value === current ? ' selected' : '';
    return `<option value="${escapeHtml(s.value)}"${sel}>${escapeHtml(s.label)}</option>`;
  }).join('');
  return extra + rows;
}

function html(cfg) {
  const be = cfg.backends.nai;
  const officialQuality = naiDefaultQualityTags(be.model);
  const officialNegative = naiDefaultUndesired(be.model);

  return `
${channelHeader('nai', backendMeta('nai'), cfg)}

<div class="hl-section">
  <div class="hl-section-title">连接</div>
  <div class="hl-field">
    <label class="hl-label">接口地址</label>
    <input id="hl-nai-url" class="hl-input" placeholder="https://api.novelai.net" value="${escapeHtml(be.serverUrl || '')}">
    <div class="hl-hint">官方是 <code>https://api.novelai.net</code>；用<b>第三方兼容站</b>就填它给你的地址（协议一致，直接替换即可）。</div>
  </div>
  <div class="hl-field">
    <label class="hl-label">API Key（Persistent Token）</label>
    <div class="hl-inline">
      <input id="hl-nai-key" class="hl-input hl-grow" type="password" placeholder="pst-…" value="${escapeHtml(be.apiKey || '')}">
      <button class="hl-btn hl-ghost" id="hl-nai-key-eye" type="button">显示</button>
    </div>
    <div class="hl-hint">NAI 官网 → Account → <b>Persistent Token</b>。只存在你自己的酒馆配置里，不会外发。</div>
  </div>
  ${testAreaHtml({ withTestGen: true, genHint: '测试生图用一条固定的短提示词，不消耗剧情内容。' })}
</div>

<div class="hl-section">
  <div class="hl-section-title">模型与采样</div>
  <div class="hl-field">
    <label class="hl-label">模型</label>
    <select id="hl-nai-model" class="hl-input">${modelOptions(be.model)}</select>
    <div class="hl-hint">Full 系列无内容过滤，Curated 有。4.5 / 5 支持自然语言描述（绘灵会把中文描述一并发出）。</div>
  </div>
  <div class="hl-grid2">
    <div class="hl-field">
      <label class="hl-label">采样器</label>
      <select id="hl-nai-sampler" class="hl-input">${samplerOptions(be.model, be.sampler)}</select>
    </div>
    <div class="hl-field">
      <label class="hl-label">噪声调度</label>
      <select id="hl-nai-noise" class="hl-input">
        ${NAI_NOISE_SCHEDULES.map(n => `<option value="${escapeHtml(n.value)}"${n.value === be.noiseSchedule ? ' selected' : ''}>${escapeHtml(n.label)}</option>`).join('')}
      </select>
    </div>
    <div class="hl-field"><label class="hl-label">Steps</label><input id="hl-nai-steps" class="hl-input" type="number" min="1" max="50" value="${be.steps}"></div>
    <div class="hl-field"><label class="hl-label">CFG（scale）</label><input id="hl-nai-scale" class="hl-input" type="number" min="0" max="30" step="0.1" value="${be.scale}"></div>
    <div class="hl-field"><label class="hl-label">CFG Rescale</label><input id="hl-nai-rescale" class="hl-input" type="number" min="0" max="1" step="0.01" value="${be.cfgRescale}"></div>
    <div class="hl-field"><label class="hl-label">种子（0 = 每张随机）</label><input id="hl-nai-seed" class="hl-input" type="number" min="0" value="${be.seed}"></div>
  </div>
  <label class="hl-switch">
    <input type="checkbox" id="hl-nai-variety" ${be.varietyBoost !== false ? 'checked' : ''}>
    <span>Variety Boost（按画幅自动调 skip_cfg_above_sigma）</span>
  </label>
</div>

<div class="hl-section">
  <div class="hl-section-title">画幅</div>
  <div class="hl-grid2">
    <div class="hl-field"><label class="hl-label">宽</label><input id="hl-nai-w" class="hl-input" type="number" min="256" max="2048" step="64" value="${be.width}"></div>
    <div class="hl-field"><label class="hl-label">高</label><input id="hl-nai-h" class="hl-input" type="number" min="256" max="2048" step="64" value="${be.height}"></div>
  </div>
  <div class="hl-hint">NAI 要求宽高都是 <b>64 的倍数</b>，且落在 256–2048。常用竖构图 <code>832×1216</code>，横构图 <code>1216×832</code>。</div>
</div>

<div class="hl-section">
  <div class="hl-section-title">质量词与负面</div>
  <label class="hl-switch">
    <input type="checkbox" id="hl-nai-usequality" ${be.useQualityTags !== false ? 'checked' : ''}>
    <span>自动追加质量词</span>
  </label>
  <div class="hl-field">
    <label class="hl-label">质量词（留空 = 用该模型的官方词）</label>
    <textarea id="hl-nai-quality" class="hl-textarea" rows="2" placeholder="${escapeHtml(officialQuality)}">${escapeHtml(be.qualityTags || '')}</textarea>
    <div class="hl-hint">当前模型的官方词：<code>${escapeHtml(officialQuality || '（无）')}</code>。Krea2 那种「禁质量词」的口径，把上面的开关关掉即可。</div>
  </div>
  <div class="hl-field">
    <label class="hl-label">负面（undesired content，留空 = 用官方 Heavy 词）</label>
    <textarea id="hl-nai-negative" class="hl-textarea" rows="4" placeholder="${escapeHtml(officialNegative.slice(0, 160))}…">${escapeHtml(be.negative || '')}</textarea>
    <div class="hl-hint">这里留空时用该模型的官方 Heavy 负面词；「生图规范」里配的全局负面会<b>优先</b>于这里。</div>
  </div>
</div>

<div class="hl-section">
  <div class="hl-section-title">其它</div>
  <div class="hl-field"><label class="hl-label">超时（秒）</label><input id="hl-nai-timeout" class="hl-input" type="number" min="10" max="900" value="${be.timeoutSec}"></div>
  <div class="hl-hint">NAI 高峰期排队可能几十秒，不建议低于 60。</div>
</div>`;
}

/**
 * @param {HTMLElement} container
 * @param {(key:string)=>void} [onChannelChange]
 */
export async function mount(container, onChannelChange) {
  const cfg = getConfig();
  const be = cfg.backends.nai;

  container.innerHTML = html(cfg);
  bindChannelHeader(container, 'nai', onChannelChange);

  const status = (msg, isErr) => renderStatus(container, 'hl-conn-status', msg, isErr);

  /* 连接 */
  bindInput(container, '#hl-nai-url', el => el.value.trim(), v => { be.serverUrl = v; });
  bindInput(container, '#hl-nai-key', el => el.value.trim(), v => { be.apiKey = v; });

  // 显示/隐藏 Key —— 只在本地切 input 类型，不写任何配置
  $(container, '#hl-nai-key-eye')?.addEventListener('click', (e) => {
    const input = $(container, '#hl-nai-key');
    if (!input) return;
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    e.currentTarget.textContent = show ? '隐藏' : '显示';
  });

  $(container, '#hl-probe')?.addEventListener('click', async () => {
    status('正在测试连接…');
    const res = await probeBackend('nai', cfg);
    status(res.ok ? `✓ ${res.message}` : `✗ ${res.error}${res.hint ? `｜${res.hint}` : ''}`, !res.ok);
  });

  $(container, '#hl-testgen')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = '生图中…';
    status('正在跑一张测试图（可能要十几秒）…');
    const res = await testGenBackend('nai', cfg, '');
    btn.disabled = false;
    btn.textContent = '测试生图';
    status(res.ok ? `✓ 测试生图成功（${res.elapsed}s）` : `✗ ${res.error}`, !res.ok);
    renderTestPreview(container, res);
  });

  /* 模型与采样 */
  const modelSel = $(container, '#hl-nai-model');
  modelSel?.addEventListener('change', () => {
    be.model = modelSel.value;
    saveSettings();
    // 换模型要跟着换采样器列表（NAI5 砍掉了 DDIM V3），
    // 以及质量词/负面词的「官方默认」提示
    const samplerSel = $(container, '#hl-nai-sampler');
    if (samplerSel) samplerSel.innerHTML = samplerOptions(be.model, be.sampler);
    const qPlaceholder = $(container, '#hl-nai-quality');
    if (qPlaceholder) qPlaceholder.placeholder = naiDefaultQualityTags(be.model);
    const nPlaceholder = $(container, '#hl-nai-negative');
    if (nPlaceholder) nPlaceholder.placeholder = `${naiDefaultUndesired(be.model).slice(0, 160)}…`;
  });

  bindSelect(container, '#hl-nai-sampler', v => { be.sampler = v; });
  bindSelect(container, '#hl-nai-noise', v => { be.noiseSchedule = v; });
  bindInput(container, '#hl-nai-steps', el => Number(el.value), v => { be.steps = v; }, { after: el => { el.value = be.steps; } });
  bindInput(container, '#hl-nai-scale', el => Number(el.value), v => { be.scale = v; }, { after: el => { el.value = be.scale; } });
  bindInput(container, '#hl-nai-rescale', el => Number(el.value), v => { be.cfgRescale = v; }, { after: el => { el.value = be.cfgRescale; } });
  bindInput(container, '#hl-nai-seed', el => Number(el.value), v => { be.seed = v; }, { after: el => { el.value = be.seed; } });
  bindCheck(container, '#hl-nai-variety', v => { be.varietyBoost = v; });

  /* 画幅 */
  bindInput(container, '#hl-nai-w', el => Number(el.value), v => { be.width = v; }, { after: el => { el.value = be.width; } });
  bindInput(container, '#hl-nai-h', el => Number(el.value), v => { be.height = v; }, { after: el => { el.value = be.height; } });

  /* 提示词 */
  bindCheck(container, '#hl-nai-usequality', v => { be.useQualityTags = v; });
  bindInput(container, '#hl-nai-quality', el => el.value, v => { be.qualityTags = v; });
  bindInput(container, '#hl-nai-negative', el => el.value, v => { be.negative = v; });

  /* 其它 */
  bindInput(container, '#hl-nai-timeout', el => Number(el.value), v => { be.timeoutSec = v; }, { after: el => { el.value = be.timeoutSec; } });
}
