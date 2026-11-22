/**
 * 绘灵 · 生图后端面板的共用件
 *
 * 三个后端（ComfyUI / NovelAI / OpenAI 兼容）的面板长得像、踩的坑也一样：
 * 选择器拼接、输入绑定、状态回显、渠道头（启用 / 设为生效）。
 * 集中在这里是有教训的 —— 上一轮那个 `##hl-url` 非法选择器
 * 就只崩了 ComfyUI 面板那一处，因为当时每个面板各写各的绑定代码。
 */

import { escapeHtml } from '../../util.js';
import { getConfig, saveSettings } from '../../settings.js';
import { activeBackendKey, backendReadiness, backendMeta } from '../../backends/index.js';
import { info, STAGE } from '../../log.js';

export { escapeHtml };

/* ============ 选择器与绑定 ============ */

/**
 * 容错选择器：调用方写 'hl-url' 或 '#hl-url' 都对。
 * 直接 `#${id}` 会在调用方已带 # 时拼出 '##hl-url' —— 非法选择器，
 * 整页 bind 当场抛错（历史 bug）。
 */
export function sel(id) {
  const s = String(id);
  return /^[#.[]/.test(s) ? s : `#${s}`;
}

export function $(container, id) {
  return container?.querySelector(sel(id)) || null;
}

/** 绑定一个输入框：change 时写回配置并保存。 */
export function bindInput(container, id, get, set, opts = {}) {
  const el = $(container, id);
  if (!el) return null;
  el.addEventListener(opts.event || 'change', () => {
    set(get(el));
    if (opts.save !== false) saveSettings();
    opts.after?.(el);
  });
  return el;
}

/** 绑定一个复选框。 */
export function bindCheck(container, id, set, opts = {}) {
  const el = $(container, id);
  if (!el) return null;
  el.addEventListener('change', () => {
    set(el.checked);
    if (opts.save !== false) saveSettings();
    opts.after?.(el);
  });
  return el;
}

/** 绑定一个下拉（select）。 */
export function bindSelect(container, id, set, opts = {}) {
  return bindInput(container, id, el => el.value, set, opts);
}

/* ============ 状态回显 ============ */

export function renderStatus(container, id, msg, isErr) {
  const el = $(container, id);
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle('hl-err', !!isErr);
  el.classList.toggle('hl-ok-text', !isErr && !!msg);
}

/** 填充 datalist（下拉建议）。 */
export function putDatalist(container, id, items) {
  const el = $(container, id);
  if (!el) return;
  const list = (items || []).filter(v => v !== undefined && v !== null && String(v).trim() !== '');
  el.innerHTML = list.map(v => `<option value="${escapeHtml(String(v))}"></option>`).join('');
}

/** 生成 datalist 的 HTML 片段。 */
export function datalistHtml(id) {
  return `<datalist id="${escapeHtml(id)}"></datalist>`;
}

/* ============ 渠道头（启用 / 设为生效 / 状态徽标） ============ */

/**
 * 每个后端面板顶部的统一头部。
 * 「切换面板」与「切换生效后端」刻意分开：用户点渠道条只是想看看另一个后端，
 * 不该顺手就把出图后端换掉（尤其那个后端还没配好）。
 */
export function channelHeader(key, meta, cfg) {
  const be = cfg.backends?.[key] || {};
  const readiness = backendReadiness(key, cfg);
  const isActive = activeBackendKey(cfg) === key;

  const badge = readiness.ready
    ? '<span class="hl-badge hl-badge-ok">已配置</span>'
    : `<span class="hl-badge hl-badge-warn">${escapeHtml(readiness.reason)}</span>`;

  return `
<div class="hl-chan-head">
  <div class="hl-chan-title">
    <span class="hl-chan-name">${escapeHtml(meta.name)}</span>
    ${isActive ? '<span class="hl-badge hl-badge-on">生效中</span>' : ''}
    ${badge}
  </div>
  <div class="hl-chan-actions">
    <label class="hl-switch" title="关掉后这个后端不会被提交，即使它是生效后端">
      <input type="checkbox" id="hl-be-enabled" ${be.enabled !== false ? 'checked' : ''}><span>启用</span>
    </label>
    <button class="hl-btn ${isActive ? 'hl-ghost' : ''}" id="hl-be-activate" ${isActive ? 'disabled' : ''}>
      ${isActive ? '已是生效后端' : '设为生效后端'}
    </button>
  </div>
  <div class="hl-chan-hint">${escapeHtml(meta.hint || '')}</div>
</div>`;
}

/**
 * 绑定渠道头。
 *
 * 改完「启用 / 设为生效」之后，头部自身的状态（生效中徽标、按钮文案）必须**就地刷新** ——
 * 只重渲染外层渠道条是不够的：用户会看到按钮还写着"设为生效后端"，
 * 以为没点中，然后再点一次。
 *
 * 这里刻意只替换 `.hl-chan-head` 这一块，不重挂整个面板 ——
 * 重挂会把用户正在编辑的输入框焦点和光标位置一起清掉。
 *
 * @param {HTMLElement} container
 * @param {string} key
 * @param {() => void} [onChanged] 外层回调（用来刷新渠道条）
 */
export function bindChannelHeader(container, key, onChanged) {
  const refreshHead = () => {
    const head = container.querySelector('.hl-chan-head');
    if (!head) return;
    const holder = document.createElement('div');
    holder.innerHTML = channelHeader(key, backendMeta(key), getConfig()).trim();
    const fresh = holder.firstElementChild;
    if (!fresh) return;
    head.replaceWith(fresh);
    bind();
  };

  const bind = () => {
    bindCheck(container, '#hl-be-enabled', (checked) => {
      const cfg = getConfig();
      if (!cfg.backends[key]) cfg.backends[key] = {};
      cfg.backends[key].enabled = checked;
    }, { after: () => { refreshHead(); onChanged?.(); } });

    $(container, '#hl-be-activate')?.addEventListener('click', () => {
      const cfg = getConfig();
      cfg.activeBackend = key;
      saveSettings();
      info(STAGE.UI, `生效生图后端已切换到「${backendMeta(key).name}」`);
      refreshHead();
      onChanged?.();
    });
  };

  bind();
}

/* ============ 测试区（连接 + 测试生图） ============ */

/** 统一的「测试连接 / 测试生图」按钮组 + 状态行。 */
export function testAreaHtml({ withTestGen = true, genHint = '' } = {}) {
  return `
  <div class="hl-actions">
    <button class="hl-btn" id="hl-probe">测试连接</button>
    ${withTestGen ? '<button class="hl-btn hl-ghost" id="hl-testgen">测试生图</button>' : ''}
  </div>
  <div class="hl-status" id="hl-conn-status"></div>
  ${withTestGen ? `<div class="hl-hint">「测试生图」会真跑一张最小图 —— 光测连接不够，Key 有效 ≠ 生图这条路通（额度、模型名、尺寸都可能挂在这条路上）。${escapeHtml(genHint)}</div>` : ''}
  <div class="hl-test-preview" id="hl-test-preview"></div>`;
}

/** 把测试生图的结果渲染成一张缩略图（成功）或错误行（失败）。 */
export function renderTestPreview(container, res) {
  const box = $(container, '#hl-test-preview');
  if (!box) return;
  if (res?.ok && res.images?.length) {
    const url = res.images[0].url;
    box.innerHTML = `
      <div class="hl-test-ok">测试生图成功（${escapeHtml(String(res.elapsed || '?'))}s）</div>
      <a href="${escapeHtml(url)}" target="_blank" rel="noopener">
        <img class="hl-test-img" src="${escapeHtml(url)}" alt="测试生图结果">
      </a>`;
  } else {
    box.innerHTML = `<div class="hl-bad">${escapeHtml(res?.error || '测试失败')}</div>`;
  }
}
