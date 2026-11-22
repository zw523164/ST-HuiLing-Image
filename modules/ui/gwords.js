/**
 * 绘灵 · 全局词库页（v0.9.11 从「生图后端」里独立出来）
 *
 * 这里管三样"贴在每条提示词上"的东西：
 *   - 全局前缀（拼在提示词最前）
 *   - 全局后缀（拼在提示词最后）
 *   - 全局负面（Krea2 质量词别放这 —— 那是负面槽的事）
 *
 * 三件套可以存成命名预设：换风格（油画 / 写实 / 二次元）时一键切换，
 * 改完忘了存也不怕 —— 预设内容是快照，当前值随时可改、可另存、可重命名。
 *
 * 数据仍在 cfg.globalPrefix / globalSuffix / globalNegative（生图管线读的就是它们），
 * 预设只是存快照，搬到哪个页签都不影响出图。
 */

import { getConfig, saveSettings, activeEngine } from '../settings.js';
import {
  listGwordPresets, getActiveGwordPreset,
  saveGwordPreset, removeGwordPreset, renameGwordPreset, applyGwordPreset,
} from '../settings.js';
import { info, STAGE } from '../log.js';
import { escapeHtml, $, bindInput, bindSelect, renderStatus } from './backends/shared.js';
import { buildLayoutEditor } from './promptlayout.js';
import { STYLE_PRESETS, STYLE_CUSTOM, styleApplied } from '../stylePreset.js';

function html(cfg) {
  const presets = Object.keys(listGwordPresets());
  const active = getActiveGwordPreset();
  const sty = cfg.style || {};
  const pick = String(sty.preset == null ? '' : sty.preset);
  /**
   * 必须拿**未替换的原文**来判断命中率 —— `getActiveTemplate()` 返回的那份已经过
   * `applyStylePreset`，再拿去比「还有没有 anime」永远是「已替换」，等于自证成功。
   */
  const rawProto = String((cfg.templates?.[cfg.activeTemplate] || {}).protocol || '');
  const chk = styleApplied(rawProto, cfg);

  return `
<div class="hl-section">
  <div class="hl-section-title">画风（v0.9.182 · 覆盖模版里写死的画风示例）</div>
  <div class="hl-field">
    <label class="hl-label">画风档位</label>
    <select id="hl-style-preset" class="hl-input">
      <option value="" ${pick ? '' : 'selected'}>（不覆盖 · 用模版原文）</option>
      ${STYLE_PRESETS.map((p) => `<option value="${escapeHtml(p.id)}" ${p.id === pick ? 'selected' : ''}>${escapeHtml(p.label)}</option>`).join('')}
      <option value="${STYLE_CUSTOM}" ${pick === STYLE_CUSTOM ? 'selected' : ''}>自定义…</option>
    </select>
  </div>
  <div id="hl-style-custom" ${pick === STYLE_CUSTOM ? '' : 'hidden'}>
    <div class="hl-field">
      <label class="hl-label">画风句（写进 <code>summary.caption</code> 第一句）</label>
      <input id="hl-style-line" class="hl-input" value="${escapeHtml(sty.customLine || '')}"
             placeholder="Photorealistic photograph, editorial portrait lighting…">
    </div>
    <div class="hl-field">
      <label class="hl-label">meta 标签（逗号分隔）</label>
      <input id="hl-style-meta" class="hl-input" value="${escapeHtml(sty.customMeta || '')}"
             placeholder="photorealistic, photograph">
    </div>
  </div>
  <div class="hl-hint" style="line-height:1.8">
    <b>「画风」以前不在任何界面上，因为它是藏在模版里的两句示例</b> ——
    <code>## MOSS 单图口径补充</code> 里的 <code>"meta": ["anime", …]</code> 与
    <code>\`Clean anime line art, …\`</code>。写词模型只会<b>照抄示例</b>，所以调什么都没用。<br>
    这里改的是<b>读出来的那一份</b>：你模版里的原文一个字不动，切回「不覆盖」立刻恢复原样。<br>
    ${chk.active
      ? (chk.ok
        ? '<span style="color:var(--hl-ok,#4caf50)">✓ 已替换成功（模版里那两处都命中了）</span>'
        : `<span class="hl-warn">⚠ 只替换了 ${chk.metaOk ? '画风句' : 'meta'}，另一处没在你的模版里找到 —— 说明你改过那段示例，画风可能不完整生效</span>`)
      : '当前是「不覆盖」，出图沿用模版里那句画风写什么就是什么。'}<br>
    ★ 这里只管<b>画风描述</b>：采样参数（步数 / CFG / 采样器）和负面词一律不动，那些归你。
    MOSS 是**基座模型**（官方：没做过任何后训练），写实程度最终取决于模型本身，这里只是让它往那个方向画。
  </div>
</div>

<div class="hl-section">
  <div class="hl-section-title">词库预设</div>
  <div class="hl-inline">
    <select id="hl-gw-preset" class="hl-input hl-grow">
      <option value="" ${active ? '' : 'selected'}>（自定义 · 未对应预设）</option>
      ${presets.map(n => `<option value="${escapeHtml(n)}" ${n === active ? 'selected' : ''}>${escapeHtml(n)}</option>`).join('')}
    </select>
    <button class="hl-btn hl-ghost" id="hl-gw-apply" type="button">应用</button>
    <button class="hl-btn hl-ghost" id="hl-gw-rename" type="button">重命名</button>
    <button class="hl-btn hl-ghost" id="hl-gw-del" type="button">删除</button>
  </div>
  <div class="hl-inline">
    <input id="hl-gw-newname" class="hl-input hl-grow" placeholder="输入预设名（如：油画风 / 写实风）">
    <button class="hl-btn" id="hl-gw-save" type="button">把当前三件套存成预设</button>
  </div>
  <div class="hl-hint">
    应用 = 把选中预设的三件套写进下面三个框；改了值就立即生效（自动保存）。<br>
    「存成预设」保存的是<b>下面三个框的当前值</b>；名字填已有预设名 = 覆盖它。
  </div>
  <div class="hl-status" id="hl-gw-status"></div>
</div>

<div class="hl-section">
  <div class="hl-section-title">当前生效（改完即时生效，出图就用这份）</div>
  <div class="hl-field">
    <label class="hl-label">前缀（拼在提示词最前）</label>
    <input id="hl-gw-prefix" class="hl-input" value="${escapeHtml(cfg.globalPrefix || '')}">
  </div>
  <div class="hl-field">
    <label class="hl-label">后缀（拼在提示词最后）</label>
    <input id="hl-gw-suffix" class="hl-input" value="${escapeHtml(cfg.globalSuffix || '')}">
  </div>
  <div class="hl-field">
    <label class="hl-label">全局负面</label>
    <input id="hl-gw-neg" class="hl-input" value="${escapeHtml(cfg.globalNegative || '')}">
  </div>
  <div class="hl-hint">
    Krea2 禁质量词，前缀建议留空；质量负面词在「生图后端 → 负面提示词」。<br>
    当前对应预设：<b id="hl-gw-active">${active ? escapeHtml(active) : '自定义（未对应预设）'}</b>
    —— 手改下面任何一框，预设内容不会跟着变（预设是快照）。<br>
    <b>MOSS JSON Layout 模版</b>下：前缀 / 后缀会并进 Layout 的 <code>summary.caption</code>
    （不进各格坐标框），全局负面照常送后端。
    想让 Layout <b>不接收</b>前缀 / 后缀 → 「提示词模版」页 → JSON 版块 → 「全局词库落点」选「不注入」。
  </div>
</div>

<div class="hl-section">
  <div class="hl-section-title">提示词段落编排（v0.9.53）</div>
  <div id="hl-gw-layout"></div>
</div>`;
}

export function mountGwords(container) {
  const cfg = getConfig();

  container.innerHTML = html(cfg);
  const status = (msg, isErr) => renderStatus(container, 'hl-gw-status', msg, isErr);

  const presetSel = $(container, '#hl-gw-preset');

  /* ---- v0.9.182：画风。改完**重挂一次**，让「是否替换成功」那行跟着刷新 ---- */
  cfg.style = cfg.style || {};
  bindSelect(container, '#hl-style-preset', (v) => {
    cfg.style.preset = v;
  }, {
    after: () => {
      /**
       * ★ 必须重挂：下面那行提示是「模版里那两处有没有命中」的实测结果，
       *   不重挂就永远显示选择前的状态，用户会以为没生效。
       *   重挂代价 = 重设一次 innerHTML（本页没有长列表，可以接受）。
       */
      mountGwords(container);
    },
  });
  bindInput(container, '#hl-style-line', (el) => el.value, (v) => {
    cfg.style = cfg.style || {};
    cfg.style.customLine = v;
  }, { after: () => mountGwords(container) });
  bindInput(container, '#hl-style-meta', (el) => el.value, (v) => {
    cfg.style = cfg.style || {};
    cfg.style.customMeta = v;
  });

  /** 改完当前值后刷新「当前对应预设」显示（不重建 DOM，免得输入框失焦）。 */
  function paintActive() {
    const el = $(container, '#hl-gw-active');
    if (el) el.textContent = getActiveGwordPreset() || '自定义（未对应预设）';
  }

  /* ---- 当前三件套：即时生效 ---- */
  bindInput(container, '#hl-gw-prefix', el => el.value, v => { cfg.globalPrefix = v; }, { after: paintActive });
  bindInput(container, '#hl-gw-suffix', el => el.value, v => { cfg.globalSuffix = v; }, { after: paintActive });
  bindInput(container, '#hl-gw-neg', el => el.value, v => { cfg.globalNegative = v; }, { after: paintActive });

  /* ---- v0.9.53：全局段落编排（改完即时生效，对之后所有新图） ---- */
  const layoutHost = $(container, '#hl-gw-layout');
  if (layoutHost) {
    buildLayoutEditor(
      layoutHost,
      () => cfg.promptLayout || {},
      (next) => { cfg.promptLayout = next; saveSettings(); },
      {
        hint: '段的内容全部来自本楼剧情与角色档案（这里不填内容），只决定「排不排、排第几」。'
          + '不改编排 = 出厂顺序；单张图可在它的提示词编辑器里单独覆盖。'
          + '★ 每个段的「生效 / 已关闭 / 本口径无内容」是当前模版口径下的真实状态 —— SD 与 K2 能用的段不一样。',
        getEngine: () => activeEngine(),
      },
    );
  }

  /* ---- 应用：把选中预设写进三个框 ---- */
  $(container, '#hl-gw-apply')?.addEventListener('click', () => {
    const name = presetSel?.value;
    if (!name) { status('先在上面选中一个预设', true); return; }
    if (!applyGwordPreset(name)) { status(`预设「${name}」不存在（可能已被删除）`, true); return; }
    $(container, '#hl-gw-prefix').value = cfg.globalPrefix || '';
    $(container, '#hl-gw-suffix').value = cfg.globalSuffix || '';
    $(container, '#hl-gw-neg').value = cfg.globalNegative || '';
    paintActive();
    status(`已应用预设「${name}」`);
    info(STAGE.UI, `全局词库已应用预设「${name}」`);
  });

  /* ---- 保存为预设 ---- */
  $(container, '#hl-gw-save')?.addEventListener('click', () => {
    const typed = $(container, '#hl-gw-newname')?.value.trim();
    const name = typed || presetSel?.value;
    if (!name) { status('给预设起个名字（或选中一个已有预设来覆盖）', true); return; }
    const overwrite = !!listGwordPresets()[name] && name !== getActiveGwordPreset();
    if (overwrite && !confirm(`已有预设「${name}」，覆盖它？`)) return;
    const res = saveGwordPreset(name, {
      prefix: $(container, '#hl-gw-prefix').value,
      suffix: $(container, '#hl-gw-suffix').value,
      negative: $(container, '#hl-gw-neg').value,
    });
    if (!res.ok) { status(res.reason, true); return; }
    if (presetSel) {
      // 重建 options（新名字要出现在列表里），再选中它
      const names = Object.keys(listGwordPresets());
      presetSel.innerHTML = `<option value="">（自定义 · 未对应预设）</option>`
        + names.map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('');
      presetSel.value = name;
    }
    const box = $(container, '#hl-gw-newname');
    if (box) box.value = '';
    paintActive();
    status(`${overwrite ? '已覆盖' : '已保存'}预设「${name}」—— 出图即刻用它`);
    info(STAGE.UI, `全局词库预设「${name}」已保存`);
  });

  /* ---- 重命名 ---- */
  $(container, '#hl-gw-rename')?.addEventListener('click', () => {
    const oldName = presetSel?.value;
    if (!oldName) { status('「自定义」不是预设，先选中一个要改名的预设', true); return; }
    const name = prompt(`把预设「${oldName}」改成什么名字：`, oldName);
    if (!name || name === oldName) return;
    const res = renameGwordPreset(oldName, name.trim());
    if (!res.ok) { status(res.reason, true); return; }
    // 不用 CSS.escape 选择器（jsdom 没有 CSS 全局），遍历 options 找值最稳
    const opt = Array.from(presetSel.options).find(o => o.value === oldName);
    if (opt) { opt.value = res.name; opt.textContent = res.name; }
    presetSel.value = res.name;
    paintActive();
    status(`已重命名为「${res.name}」`);
  });

  /* ---- 删除 ---- */
  $(container, '#hl-gw-del')?.addEventListener('click', () => {
    const name = presetSel?.value;
    if (!name) { status('「自定义」不是预设，没东西可删', true); return; }
    if (!confirm(`删除词库预设「${name}」？\n下面三个框的当前值不受影响。`)) return;
    removeGwordPreset(name);
    const opt = Array.from(presetSel.options).find(o => o.value === name);
    opt?.remove();
    presetSel.value = '';
    paintActive();
    status(`已删除预设「${name}」（当前值保留）`);
    info(STAGE.UI, `全局词库预设「${name}」已删除`);
  });
}
