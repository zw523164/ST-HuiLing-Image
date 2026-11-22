/**
 * 绘灵 · 「出词 API」面板
 *
 * 一条独立的出词通路，三种模式：
 *   follow   跟随酒馆主 API（零配置）
 *   channel  用酒馆的连接预设
 *   custom   独立 API —— 自己填 Base URL / Key / 模型 / 四个采样参数
 *
 * 三个刻意的设计决定：
 *
 * ① **模式切换只切显隐，不重渲染整块。**
 *    用户在 Base URL 里打到一半切去看「跟随」再切回来，光标和内容都得还在。
 *
 * ② **API Key 用 password 框，但给一个眼睛。**
 *    不给眼睛的话，用户粘完 Key 后想核对一下有没有多带空格都做不到，
 *    而「Key 里混了个换行」正是 401 最常见的来源。
 *
 * ③ **设置与「测试」彻底分开。**
 *    这个页面上改的任何东西都不对外发请求 —— 除了「获取」和「测试 API 连接」这两个
 *    按钮。用户改 base url 时不该因为逐字输入就被打一串请求出去。
 */

import { escapeHtml } from '../util.js';
import { getConfig, saveSettings } from '../settings.js';
import { info, warn, STAGE } from '../log.js';
import { listConnectionProfiles, probeLLM } from '../api.js';
import { $, bindInput, putDatalist, datalistHtml } from './backends/shared.js';
import {
  BASE_URL_PRESETS, PARAM_RANGE, fetchModels, testConnection, logTestResult,
} from '../llmapi.js';

/** 三种通道的说明文案 —— 用户看这个决定选哪个，比按钮名字本身重要。 */
export const MODES = [
  {
    value: 'follow',
    label: '跟随酒馆主 API',
    lead: '零配置。用你在酒馆里配的那个模型来想「这张画什么」—— 和你的主对话同一个模型、同一份额度。',
    note: '主 API 挂了（欠费、限流、上游容量耗尽）绘灵也会跟着哑。',
  },
  {
    value: 'channel',
    label: '连接预设',
    lead: '从酒馆的「连接预设」里挑一个专门用来出词 —— 比如主对话用 Opus，出词用便宜的小模型。',
    note: '仍然共用酒馆的配置体系，切换预设要在这里再选一次。',
  },
  {
    value: 'custom',
    label: '独立 API',
    lead: '绘灵自己直连一个 OpenAI 兼容端点，完全不看酒馆的设置。主对话用 A 家、出词用 B 家（或本地模型）都可以。',
    note: '这条通路不通时绘灵不会偷偷换别的路 —— 会明确告诉你哪里错了。',
  },
];

function modeButton(m, active) {
  return `
      <button class="hl-mode-btn${active ? ' is-on' : ''}" data-mode="${m.value}" type="button">
        <span class="hl-mode-name">${escapeHtml(m.label)}</span>
      </button>`;
}

function paramRow(id, label, range, value, hint) {
  return `
  <div class="hl-field">
    <label class="hl-label" for="${id}">${escapeHtml(label)}
      <span class="hl-param-out" id="${id}-out">${escapeHtml(String(value))}</span>
    </label>
    <input type="range" id="${id}" class="hl-range"
      min="${range.min}" max="${range.max}" step="${range.step}" value="${escapeHtml(String(value))}" />
    ${hint ? `<div class="hl-hint">${hint}</div>` : ''}
  </div>`;
}

/* ============================================================
   HTML
   ============================================================ */

function customHtml(custom) {
  const c = custom || {};
  return `
<div class="hl-section" id="hl-llm-custom">
  <div class="hl-section-title">独立 API 配置</div>

  <div class="hl-preset-box">
    <div class="hl-field">
      <label class="hl-label" for="hl-llm-preset">API 预设</label>
      <div class="hl-inline">
        <select id="hl-llm-preset" class="hl-input hl-grow"></select>
        <button class="hl-btn" id="hl-llm-preset-save" type="button">保存</button>
        <button class="hl-btn hl-btn-danger" id="hl-llm-preset-del" type="button" title="删除当前选中的预设">删除</button>
      </div>
    </div>
    <div class="hl-field">
      <input id="hl-llm-preset-name" class="hl-input" placeholder="输入新预设名称（留空则覆盖当前预设）" value="">
    </div>
    <div class="hl-hint">
      选预设会自动加载它的配置；改完后点「保存」覆盖当前预设，或填个新名字再保存以新建一份。
      <br>预设只存在本机（酒馆的扩展设置里），不含任何同步。
    </div>
  </div>

  <div class="hl-field">
    <label class="hl-label" for="hl-llm-base">Base URL</label>
    <input id="hl-llm-base" class="hl-input" list="hl-dl-base" placeholder="https://api.deepseek.com"
      value="${escapeHtml(c.baseUrl || '')}">
    ${datalistHtml('hl-dl-base')}
    <div class="hl-hint">
      不带 <code>/v1</code> 也行 —— 绘灵会自动补成 <code>…/v1/chat/completions</code>；
      已经贴了完整端点则原样使用（Gemini 兼容层那种 <code>/v1beta/openai</code> 就不会被拼坏）。
    </div>
  </div>

  <div class="hl-field">
    <label class="hl-label" for="hl-llm-key">API Key</label>
    <div class="hl-inline">
      <input id="hl-llm-key" class="hl-input hl-grow" type="password" placeholder="sk-…（本地服务可留空）"
        value="${escapeHtml(c.apiKey || '')}" autocomplete="off" spellcheck="false">
      <button class="hl-btn hl-ghost" id="hl-llm-key-eye" type="button" title="显示 / 隐藏">显示</button>
    </div>
    <div class="hl-hint">
      本地跑的 Ollama / LM Studio 不需要 Key，留空即可（留空时绘灵不会发 Authorization 头）。
    </div>
  </div>

  <div class="hl-field">
    <label class="hl-label" for="hl-llm-model">模型</label>
    <div class="hl-inline">
      <select id="hl-llm-model" class="hl-input hl-grow"></select>
      <input id="hl-llm-model-inp" class="hl-input hl-grow" list="hl-dl-model-llm" placeholder="手输模型名，如 deepseek-chat" hidden>
      <button class="hl-btn" id="hl-llm-fetch" type="button">获取</button>
      <button class="hl-btn" id="hl-llm-edit" type="button" title="在「下拉选择」和「手动输入」之间切换">手输</button>
    </div>
    ${datalistHtml('hl-dl-model-llm')}
    <div id="hl-llm-model-warn" class="hl-warn-box" hidden>
      ⚠ <b>还没选模型 —— 现在跑剧情一张图都不会出。</b><br>
      出词通道是「独立 API」时，模型名为空绘灵会<b>直接放弃请求</b>（不会静默换一条路），
      楼层只会留下一句「出词 API 没有返回内容」。<br>
      点上面的「获取」拉一次模型列表，从下拉里选一个即可。
    </div>
    <div class="hl-hint">
      点「获取」拉一次 <code>…/models</code>，真实模型名全进下拉框 —— 点开直接选。
      各家的模型名拼写差别很大，手打一个字母错就是 404 或空响应；
      接口不提供 /models 时点「手输」自己填。
    </div>
  </div>

  <div class="hl-field">
    <label class="hl-label" for="hl-llm-maxtok">最大 Tokens</label>
    <input id="hl-llm-maxtok" class="hl-input" type="number" min="${PARAM_RANGE.maxTokens.min}"
      max="${PARAM_RANGE.maxTokens.max}" step="1" value="${escapeHtml(String(c.maxTokens ?? PARAM_RANGE.maxTokens.def))}">
    <div class="hl-hint">
      输出的上限（不是输入）。<b>填 0 = 不发送这个参数</b> ——
      o1 / o3 / gpt-5 系只认 <code>max_completion_tokens</code>，收到 <code>max_tokens</code> 会直接 400，这时就得填 0。
    </div>
  </div>

  ${paramRow('hl-llm-temp', '温度（temperature）', PARAM_RANGE.temperature, c.temperature ?? PARAM_RANGE.temperature.def,
    '越低越稳、越高越发散。出词要的是稳定复现，<b>0.6–1.0</b> 比较合适；太低会来回重复同一套构图。')}
  ${paramRow('hl-llm-topp', 'Top P', PARAM_RANGE.topP, c.topP ?? PARAM_RANGE.topP.def,
    '与温度二选一调就好，一般保持 1。')}
  ${paramRow('hl-llm-freq', '频率惩罚（frequency penalty）', PARAM_RANGE.freqPenalty, c.freqPenalty ?? PARAM_RANGE.freqPenalty.def,
    '正值压制重复用词。画面 tag 里本来就该重复（<code>1girl</code> 这类必须稳定出现），<b>建议保持 0</b>。')}
  ${paramRow('hl-llm-pres', '存在惩罚（presence penalty）', PARAM_RANGE.presPenalty, c.presPenalty ?? PARAM_RANGE.presPenalty.def,
    '正值促使模型引入新话题。同样是 0 最稳。')}

  <div class="hl-actions">
    <button class="hl-btn hl-btn-primary" id="hl-llm-test" type="button">测试 API 连接</button>
  </div>
  <div class="hl-status" id="hl-llm-test-status"></div>
  <div class="hl-hint">
    「测试」会真发一条最短的消息过去 —— 只看 <code>/models</code> 是不够的：
    Key 有效 ≠ 能出词（模型名写错、余额耗尽、上下文窗口对不上都能骗过那一关）。
  </div>
</div>`;
}

function builtinHtml(cfg) {
  const l = cfg.llm || {};
  return `
<div class="hl-section" id="hl-llm-builtin">
  <div class="hl-section-title">通道参数</div>

  <div class="hl-field" id="hl-llm-channel-row">
    <label class="hl-label" for="hl-llm-channel">连接预设</label>
    <div class="hl-inline">
      <select id="hl-llm-channel" class="hl-input hl-grow"></select>
      <button class="hl-btn hl-ghost" id="hl-llm-channel-refresh" type="button">刷新列表</button>
    </div>
    <div class="hl-hint">从酒馆的连接预设里挑一个专供出词用。</div>
  </div>

  <div class="hl-grid2">
    <div class="hl-field">
      <label class="hl-label" for="hl-llm-maxTokens">最大 Tokens</label>
      <input id="hl-llm-maxTokens" class="hl-input" type="number" min="256" max="200000" step="128"
        value="${escapeHtml(String(l.maxTokens ?? 4096))}">
    </div>
    <div class="hl-field">
      <label class="hl-label" for="hl-llm-temperature">温度</label>
      <input id="hl-llm-temperature" class="hl-input" type="number" min="0" max="2" step="0.05"
        value="${escapeHtml(String(l.temperature ?? 0.4))}">
    </div>
  </div>

  <div class="hl-field">
    <label class="hl-label" for="hl-llm-timeout">超时（秒）</label>
    <input id="hl-llm-timeout" class="hl-input" type="number" min="10" max="600" step="10"
      value="${escapeHtml(String(l.timeoutSec ?? 120))}">
    <div class="hl-hint">单次出词请求的等待上限。本地小模型或长上下文时调大些。</div>
  </div>

  <div class="hl-hint" id="hl-llm-probe"></div>
</div>`;
}

function html(cfg) {
  const mode = String(cfg.llm?.mode || 'follow');
  const cur = MODES.find(m => m.value === mode) || MODES[0];

  return `
<div class="hl-section">
  <div class="hl-section-title">出词通道</div>
  <div class="hl-hint hl-ui-lead">
    绘灵每层楼要先用一次模型分析剧情、决定画面，再交给生图后端去画。
    这里选的就是「<b>谁来做这一步</b>」—— 和下面「生图后端」（谁来画）是两件事。
  </div>
  <div class="hl-modes" id="hl-llm-modes">
    ${MODES.map(m => modeButton(m, m.value === mode)).join('')}
  </div>
  <div class="hl-mode-body" id="hl-llm-mode-body">
    <div class="hl-mode-lead" id="hl-llm-mode-lead">${cur.lead}</div>
    <div class="hl-mode-note" id="hl-llm-mode-note">${escapeHtml(cur.note)}</div>
  </div>
</div>

${customHtml(cfg.llm?.custom)}
${builtinHtml(cfg)}`;
}

/* ============================================================
   预设
   ============================================================ */

/** custom 的形状（落盘时要剥掉 UI 专属字段，只留这几个）。 */
const CUSTOM_FIELDS = ['baseUrl', 'apiKey', 'model', 'maxTokens', 'temperature', 'topP', 'freqPenalty', 'presPenalty'];

function pickCustom(src) {
  const out = {};
  for (const k of CUSTOM_FIELDS) if (src && src[k] !== undefined) out[k] = src[k];
  return out;
}

/** 预设下拉的 options：'' = 未命名/当前编辑中，其余是已存的名字。 */
export function presetOptions(names, current) {
  const list = ['<option value="">（未命名 · 正在编辑中）</option>'];
  for (const n of names) {
    list.push(`<option value="${escapeHtml(n)}"${n === current ? ' selected' : ''}>${escapeHtml(n)}</option>`);
  }
  return list.join('');
}

/* ============================================================
   绑定
   ============================================================ */

function bindModeButtons(root, onChange) {
  root.querySelectorAll('.hl-mode-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const cfg = getConfig();
      const mode = btn.dataset.mode;
      if (cfg.llm.mode === mode) return;
      cfg.llm.mode = mode;
      saveSettings();
      onChange(mode);
      info(STAGE.UI, `出词通道 → ${MODES.find(m => m.value === mode)?.label || mode}`);
    });
  });
}

/** 按模式切显隐 + 更新按钮态与说明文案（不重渲染，保住输入焦点）。 */
export function applyMode(root, mode) {
  const cur = MODES.find(m => m.value === mode) || MODES[0];
  root.querySelectorAll('.hl-mode-btn').forEach(b => b.classList.toggle('is-on', b.dataset.mode === mode));

  const lead = $(root, '#hl-llm-mode-lead');
  const note = $(root, '#hl-llm-mode-note');
  if (lead) lead.textContent = cur.lead;
  if (note) note.textContent = cur.note;

  const custom = $(root, '#hl-llm-custom');
  const builtin = $(root, '#hl-llm-builtin');
  const channelRow = $(root, '#hl-llm-channel-row');
  if (custom) custom.style.display = mode === 'custom' ? '' : 'none';
  if (builtin) builtin.style.display = mode === 'custom' ? 'none' : '';
  // 连接预设行只在 channel 模式下才有意义
  if (channelRow) channelRow.style.display = mode === 'channel' ? '' : 'none';
  syncModelWarn(root);
}

function fillChannelProfiles(root, cfg) {
  const sel = $(root, '#hl-llm-channel');
  if (!sel) return 0;
  const list = listConnectionProfiles();
  const cur = String(cfg.llm?.channel || '');
  const opts = ['<option value="">（未选择 —— 会回退到跟随主 API）</option>'];
  for (const p of list) {
    const val = p.id || p.name;
    const label = p.model ? `${p.name} · ${p.model}` : p.name;
    opts.push(`<option value="${escapeHtml(val)}"${val === cur ? ' selected' : ''}>${escapeHtml(label)}</option>`);
  }
  // 存的预设名已经不在列表里了（被删/改名）→ 补一条，避免静默丢失
  if (cur && !list.some(p => (p.id || p.name) === cur)) {
    opts.push(`<option value="${escapeHtml(cur)}" selected>${escapeHtml(cur)}（当前值，列表里已找不到）</option>`);
  }
  sel.innerHTML = opts.join('');
  return list.length;
}

function fillPresetSelect(root, cfg) {
  const sel = $(root, '#hl-llm-preset');
  if (!sel) return;
  const names = Object.keys(cfg.llm?.presets || {}).sort((a, b) => a.localeCompare(b));
  sel.innerHTML = presetOptions(names, String(cfg.llm?.presetName || ''));
}

function fillBaseDatalist(root) {
  putDatalist(root, 'hl-dl-base', BASE_URL_PRESETS.map(p => p.url));
  putDatalist(root, 'hl-dl-model-llm', getConfig().llm?.modelCache || []);
}

/** 把一组参数写进 DOM（加载预设时用 —— 只填值，不触发重渲染）。 */
export function applyCustomToDom(root, custom) {
  const c = custom || {};
  const set = (id, v) => { const el = $(root, id); if (el) el.value = v ?? ''; };
  set('#hl-llm-base', c.baseUrl || '');
  set('#hl-llm-key', c.apiKey || '');
  renderModelField(root);
  set('#hl-llm-maxtok', c.maxTokens ?? PARAM_RANGE.maxTokens.def);

  const ranges = [
    ['#hl-llm-temp', 'temperature', PARAM_RANGE.temperature],
    ['#hl-llm-topp', 'topP', PARAM_RANGE.topP],
    ['#hl-llm-freq', 'freqPenalty', PARAM_RANGE.freqPenalty],
    ['#hl-llm-pres', 'presPenalty', PARAM_RANGE.presPenalty],
  ];
  for (const [id, key, range] of ranges) {
    const v = c[key] ?? range.def;
    set(id, v);
    const out = $(root, `${id}-out`);
    if (out) out.textContent = String(v);
  }
}

function bindParams(root) {
  const c = () => {
    const cfg = getConfig();
    if (!cfg.llm.custom || typeof cfg.llm.custom !== 'object') cfg.llm.custom = {};
    return cfg.llm.custom;
  };

  bindInput(root, '#hl-llm-base', el => el.value.trim(), v => { c().baseUrl = v; });
  bindInput(root, '#hl-llm-key', el => el.value, v => { c().apiKey = v; });
  bindInput(root, '#hl-llm-model', el => el.value.trim(), v => { c().model = v; syncModelWarn(root); });
  bindInput(root, '#hl-llm-model-inp', el => el.value.trim(), v => { c().model = v; syncModelWarn(root); });

  // 「手输 / 下拉」切换 —— 有些接口不提供 /models，得留手打的门
  $(root, '#hl-llm-edit')?.addEventListener('click', () => {
    const cc = c();
    cc.modelInputMode = cc.modelInputMode === 'input' ? 'select' : 'input';
    saveSettings();
    renderModelField(root);
    setTestStatus(root, cc.modelInputMode === 'input'
      ? '已切到手动输入 —— 直接打模型名'
      : '已切回下拉选择 —— 点「获取」拉模型列表', false);
  });

  const maxtok = $(root, '#hl-llm-maxtok');
  maxtok?.addEventListener('change', () => {
    let n = Number(maxtok.value);
    if (!Number.isFinite(n) || n < 0) n = 0;
    // 0 是显式语义（不发送该参数），不能当"非法输入"处理
    c().maxTokens = n === 0 ? 0 : Math.min(PARAM_RANGE.maxTokens.max, Math.max(PARAM_RANGE.maxTokens.min, Math.round(n)));
    maxtok.value = c().maxTokens;
    saveSettings();
  });

  // 滑块：拖动时只更新数字（实时落盘会闪），松手才写配置
  const ranges = [
    ['#hl-llm-temp', 'temperature', PARAM_RANGE.temperature],
    ['#hl-llm-topp', 'topP', PARAM_RANGE.topP],
    ['#hl-llm-freq', 'freqPenalty', PARAM_RANGE.freqPenalty],
    ['#hl-llm-pres', 'presPenalty', PARAM_RANGE.presPenalty],
  ];
  for (const [id, key, range] of ranges) {
    const el = $(root, id);
    const out = $(root, `${id}-out`);
    if (!el) continue;
    el.addEventListener('input', () => {
      el.dataset.pending = el.value;
      if (out) out.textContent = String(el.value);
    });
    el.addEventListener('change', () => {
      const v = Math.min(range.max, Math.max(range.min, Number(el.dataset.pending ?? el.value) || 0));
      c()[key] = v;
      el.value = String(v);
      delete el.dataset.pending;
      if (out) out.textContent = String(v);
      saveSettings();
    });
  }

  // 显示 / 隐藏 Key
  $(root, '#hl-llm-key-eye')?.addEventListener('click', (e) => {
    const input = $(root, '#hl-llm-key');
    if (!input) return;
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    e.currentTarget.textContent = show ? '隐藏' : '显示';
  });
}

function bindBuiltinParams(root) {
  const l = () => {
    const cfg = getConfig();
    if (!cfg.llm || typeof cfg.llm !== 'object') cfg.llm = {};
    return cfg.llm;
  };
  const bindNum = (id, key, min, max) => {
    const el = $(root, id);
    if (!el) return;
    el.addEventListener('change', () => {
      let n = Number(el.value);
      if (!Number.isFinite(n)) n = l()[key];
      n = Math.min(max, Math.max(min, n));
      l()[key] = n;
      el.value = n;
      saveSettings();
    });
  };
  bindNum('#hl-llm-maxTokens', 'maxTokens', 256, 200000);
  bindNum('#hl-llm-temperature', 'temperature', 0, 2);
  bindNum('#hl-llm-timeout', 'timeoutSec', 10, 600);

  $(root, '#hl-llm-channel-refresh')?.addEventListener('click', () => {
    const n = fillChannelProfiles(root, getConfig());
    const st = $(root, '#hl-llm-channel');
    if (n) {
      info(STAGE.UI, `拉到 ${n} 个连接预设`);
    } else {
      warn(STAGE.UI, '没找到任何连接预设 —— 酒馆里还没建，或该版本不提供这个接口');
      if (st && !st.value) st.innerHTML = '<option value="">（没找到预设 —— 去酒馆「连接」页建一个）</option>';
    }
  });

  bindInput(root, '#hl-llm-channel', el => el.value, v => { l().channel = v; });
}

function bindPresets(root) {
  const llm = () => {
    const cfg = getConfig();
    if (!cfg.llm.presets || typeof cfg.llm.presets !== 'object') cfg.llm.presets = {};
    return cfg.llm;
  };

  bindInput(root, '#hl-llm-preset', el => el.value, (v) => {
    llm().presetName = v;
    if (!v) return;
    const saved = llm().presets[v];
    if (!saved) return;
    // 加载预设 → 填进当前编辑区。
    // 刻意**逐格填值**而不是整块重渲染：重渲染会把用户的光标位置、已展开的 datalist
    // 一起清掉，切一次预设就得重新找输入框，很难用。
    Object.assign(llm().custom, pickCustom(saved));
    saveSettings();
    applyCustomToDom(root, llm().custom);
    const nameEl = $(root, '#hl-llm-preset-name');
    if (nameEl) nameEl.value = '';
    info(STAGE.UI, `已加载 API 预设「${v}」`);
  });

  $(root, '#hl-llm-preset-save')?.addEventListener('click', () => {
    const nameEl = $(root, '#hl-llm-preset-name');
    const typed = String(nameEl?.value || '').trim();
    const current = String(llm().presetName || '');
    const name = typed || current;

    if (!name) {
      setTestStatus(root, '请先给预设起个名字（或在上面下拉里选中一个已有预设来覆盖）', true);
      return;
    }
    llm().presets[name] = pickCustom(llm().custom);
    llm().presetName = name;
    if (nameEl) nameEl.value = '';
    saveSettings();
    fillPresetSelect(root, getConfig());
    const sel = $(root, '#hl-llm-preset');
    if (sel) sel.value = name;
    setTestStatus(root, `${typed ? '已新建' : '已覆盖'}预设「${name}」`, false);
    info(STAGE.UI, `API 预设「${name}」已保存`);
  });

  $(root, '#hl-llm-preset-del')?.addEventListener('click', () => {
    const cur = String(llm().presetName || '');
    if (!cur) { setTestStatus(root, '当前没有选中任何预设', true); return; }
    if (!llm().presets[cur]) { setTestStatus(root, `预设「${cur}」不存在（可能已被删除）`, true); return; }
    if (typeof confirm === 'function' && !confirm(`删除预设「${cur}」？\n当前编辑区的内容不受影响。`)) return;
    delete llm().presets[cur];
    llm().presetName = '';
    saveSettings();
    fillPresetSelect(root, getConfig());
    setTestStatus(root, `已删除预设「${cur}」（当前编辑区内容保留）`, false);
    info(STAGE.UI, `API 预设「${cur}」已删除`);
  });
}

function bindFetchModels(root) {
  $(root, '#hl-llm-fetch')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const cfg = getConfig();
    const custom = cfg.llm?.custom || {};
    if (!String(custom.baseUrl || '').trim()) {
      setTestStatus(root, '先填接口地址再获取模型列表', true);
      return;
    }
    const old = btn.textContent;
    btn.disabled = true;
    btn.textContent = '获取中…';
    setTestStatus(root, '正在问 …/models …', false);
    try {
      const ids = await fetchModels(custom, { timeoutSec: 20 });
      cfg.llm.modelCache = ids;
      saveSettings();
      putDatalist(root, 'hl-dl-model-llm', ids);
      if (!ids.length) {
        setTestStatus(root, '接口通了，但没返回任何模型名 —— 可能该端点不提供 /models，或返回的不是标准 OpenAI 格式（可点「手输」自己填）', true);
      } else {
        /**
         * 还没选模型时自动选上第一个。
         *
         * 为什么敢替用户做这个决定：实测第一号断点就是"拉到了 172 个模型、
         * 但 custom.model 仍然空着" —— 出词通道走独立 API 时，模型名为空
         * 会让 api.js 直接放弃请求，用户看到的是"跑剧情一张图都不出"。
         * 用户既然点了「获取」，意图就是要挑一个来用；帮他选上并明说是哪一个，
         * 比留个空框等着他再操作一次安全得多。想换随时点下拉改。
         */
        const wasEmpty = !String(custom.model || '').trim();
        if (wasEmpty) {
          custom.model = ids[0];
          saveSettings();
        }
        renderModelField(root);
        setTestStatus(root, wasEmpty
          ? `✅ 拉到 ${ids.length} 个模型，已自动选中「${ids[0]}」（要换点模型框展开选）`
          : `✅ 拉到 ${ids.length} 个模型，点模型框展开选择`, false);
        info(STAGE.UI, `独立 API 模型列表已更新（${ids.length} 个）`
          + (wasEmpty ? `，自动选中 ${ids[0]}` : ''));
      }
    } catch (err) {
      const cause = err?.detail?.cause || '获取失败';
      const fix = err?.detail?.fix || '';
      setTestStatus(root, `获取失败：${cause}${fix ? ` —— ${fix}` : ''}`, true);
      warn(STAGE.API, `获取独立 API 模型列表失败：${err?.message || err}`);
    } finally {
      btn.disabled = false;
      btn.textContent = old;
    }
  });
}

/**
 * 模型字段：默认 <select> 原生下拉，可切「手输」。
 *
 * 为什么不用 datalist：浏览器只在点击/双击输入框时才弹 datalist 下拉，
 * 用户点完「获取」看到的就是"没反应"（实际拉到了 172 个）—— v0.6.3 真实踩坑。
 * select 的 options 是实实在在的 DOM，点开必有。
 */
function modelCustom() {
  const cfg = getConfig();
  if (!cfg.llm.custom || typeof cfg.llm.custom !== 'object') cfg.llm.custom = {};
  return cfg.llm.custom;
}

/** 按配置渲染模型字段（select / 手输 input 二选一显示）。 */
function renderModelField(root) {
  const c = modelCustom();
  const sel = $(root, '#hl-llm-model');
  const inp = $(root, '#hl-llm-model-inp');
  const editBtn = $(root, '#hl-llm-edit');
  if (!sel || !inp) return;

  const manual = c.modelInputMode === 'input';
  sel.hidden = manual;
  inp.hidden = !manual;
  if (editBtn) editBtn.textContent = manual ? '下拉' : '手输';

  if (manual) {
    inp.value = c.model || '';
  } else {
    fillModelSelect(root);
  }
  syncModelWarn(root);
}

/**
 * 模型未选的红灯。
 *
 * 为什么要在 UI 上喊：这是实测出来的第一号断点 —— 出词通道选「独立 API」时，
 * 模型名为空会让 api.js 直接放弃请求，管线只往诊断面板写一行「出词 API 没有返回内容」。
 * 用户看到的就是"跑剧情不出图、所有功能像摆设"，根本想不到是这里。
 * 独立 API 生效时才亮（follow / channel 模式不需要填）。
 */
function syncModelWarn(root) {
  const box = $(root, '#hl-llm-model-warn');
  if (!box) return;
  const cfg = getConfig();
  const isCustom = String(cfg.llm?.mode || 'follow') === 'custom';
  const empty = !String(cfg.llm?.custom?.model || '').trim();
  box.hidden = !(isCustom && empty);
}

/**
 * 填充模型下拉：modelCache 全量进 options，当前值选中；
 * 当前值不在列表里时也插进去（不丢用户手填的值）。
 */
function fillModelSelect(root, ids) {
  const sel = $(root, '#hl-llm-model');
  if (!sel) return;
  const c = modelCustom();
  const cache = (ids || getConfig().llm?.modelCache || []).filter(Boolean);
  const current = String(c.model || '').trim();
  const list = current && !cache.includes(current) ? [current, ...cache] : cache;

  if (!list.length) {
    sel.innerHTML = '<option value="">（先点「获取」拉模型，或点「手输」自己填）</option>';
    return;
  }
  sel.innerHTML = list.map((m) =>
    `<option value="${escapeHtml(m)}"${m === current ? ' selected' : ''}>${escapeHtml(m)}</option>`).join('');
  sel.value = current && list.includes(current) ? current : list[0];
}

function bindTest(root) {
  $(root, '#hl-llm-test')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const cfg = getConfig();
    const custom = cfg.llm?.custom || {};

    if (!String(custom.baseUrl || '').trim()) { setTestStatus(root, '先填接口地址', true); return; }
    if (!String(custom.model || '').trim()) { setTestStatus(root, '先填模型名（点旁边「获取」也行）', true); return; }

    const old = btn.textContent;
    btn.disabled = true;
    btn.textContent = '测试中…';
    setTestStatus(root, '正在真发一条最短的消息过去…', false);

    const res = await testConnection(custom, { timeoutSec: 30 });
    logTestResult(custom, res);

    if (res.ok) {
      setTestStatus(root, `连接正常（${res.elapsed}s）· 模型回：${res.reply}`, false);
    } else {
      setTestStatus(root, `失败：${res.error}${res.cause ? `\n可能原因：${res.cause}` : ''}${res.fix ? `\n建议：${res.fix}` : ''}`, true);
    }
    btn.disabled = false;
    btn.textContent = old;
  });
}

function setTestStatus(root, msg, isErr) {
  const el = $(root, '#hl-llm-test-status');
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle('hl-err', !!isErr);
  el.classList.toggle('hl-ok-text', !isErr);
}

function renderProbe(root) {
  const el = $(root, '#hl-llm-probe');
  if (!el) return;
  const p = probeLLM();
  const bits = [];
  bits.push(p.hasGenerateRaw ? '<span class="hl-ok">generateRaw 可用</span>' : '<span class="hl-bad">generateRaw 不可用</span>');
  bits.push(p.hasQuietPrompt ? '<span class="hl-ok">generateQuietPrompt 可用</span>' : '<span class="hl-bad">generateQuietPrompt 不可用</span>');
  if (p.hasConnectionService) bits.push('<span class="hl-ok">连接预设服务可用</span>');
  else bits.push('<span class="hl-bad">连接预设服务不可用</span>');
  el.innerHTML = `酒馆侧接口探测：${bits.join(' · ')}`;
}

/* ============================================================
   挂载
   ============================================================ */

/**
 * 把「出词 API」面板挂到容器里。
 * @param {HTMLElement} container
 */
export function mountLlm(container) {
  if (!container) return null;

  const cfg = getConfig();
  if (!cfg.llm || typeof cfg.llm !== 'object') cfg.llm = {};
  if (!cfg.llm.custom || typeof cfg.llm.custom !== 'object') cfg.llm.custom = {};
  if (!cfg.llm.presets || typeof cfg.llm.presets !== 'object') cfg.llm.presets = {};

  const render = () => {
    const c = getConfig();
    container.innerHTML = html(c);
    fillBaseDatalist(container);
    fillPresetSelect(container, c);
    renderModelField(container);
    const n = fillChannelProfiles(container, c);
    applyMode(container, String(c.llm?.mode || 'follow'));
    bindModeButtons(container, (mode) => applyMode(container, mode));
    bindParams(container);
    bindBuiltinParams(container);
    bindPresets(container);
    bindFetchModels(container);
    bindTest(container);
    renderProbe(container);
    return n;
  };

  const presetCount = render();
  // 一个预设都没有时，先把话说清楚 —— 免得用户以为「刷新」按钮坏了
  if (!presetCount) {
    const sel = $(container, '#hl-llm-channel');
    if (sel && !sel.value) {
      sel.innerHTML = '<option value="">（没找到预设 —— 去酒馆「连接」页建一个）</option>';
    }
  }

  return container;
}
