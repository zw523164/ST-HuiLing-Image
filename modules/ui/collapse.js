/**
 * 绘灵 · 区块折叠（v0.9.136 从 `ui/backends/comfyui.js` 提出来复用）
 *
 * ## 为什么提出来
 *
 * 这个函数原本只服务 ComfyUI 后端面板，注释里就写着「需要时把本函数提到 shared.js 里复用」。
 * v0.9.136 用户提出「提示词模版那 UI 面板都能折叠隐藏，因为加了很多功能后导致面板越来越庞大
 * 不利于管理和快速查看」—— 模版页现在有 6 个区块（模版 / 引擎 / 输出格式 / MOSS / JSON /
 * 四个正文框），一屏根本看不完，必须也能折叠。
 *
 * 做成**独立模块**而不是复制一份实现：两份实现一定会漂（改了一份忘另一份）。
 *
 * ## 做法
 *
 * 给 `.hl-section` 的标题加点击折叠：收起时 `> *:not(.hl-section-title)` 全部 `display:none`。
 * 不给内容包 wrapper —— 现有 HTML 结构一个字都不用动，以后加新区块**自动获得折叠能力**。
 * 状态存进 `config.ui.collapsedSections`（按标题文字），刷新后保持。
 *
 * ★ key 用**标题文字**而不是索引：加/删区块不会让别人的折叠状态错位。
 * ★ key 在插箭头之前算 —— 否则箭头字符会混进 key，刷新后永远对不上（踩过）。
 */

import { getConfig, saveSettings } from '../settings.js';

/**
 * 给容器内所有 `.hl-section` 挂上折叠。
 *
 * @param {Element} container 面板根节点
 * @param {{force?: 'open'|'closed'}} [opts]
 *   `force` 用于「展开全部 / 收起全部」按钮：不写 config，只改当前 DOM。
 */
export function enableSectionCollapse(container, opts = {}) {
  if (!container || typeof container.querySelectorAll !== 'function') return;
  const cfg = getConfig();
  if (!cfg.ui || typeof cfg.ui !== 'object') cfg.ui = {};
  if (!cfg.ui.collapsedSections || typeof cfg.ui.collapsedSections !== 'object') {
    cfg.ui.collapsedSections = {};
  }
  const state = cfg.ui.collapsedSections;

  container.querySelectorAll('.hl-section').forEach((sec) => {
    const title = sec.querySelector(':scope > .hl-section-title');
    if (!title || title.dataset.hlCollapse === '1') return;
    title.dataset.hlCollapse = '1';
    title.classList.add('hl-collapsible');

    // 先算 key 再插箭头 —— 否则箭头字符会混进 key，刷新后对不上
    const key = String(title.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 40) || 'section';
    /** ★ 存一份给 `setAllSectionsCollapsed` 用：那时箭头已经插进 title，textContent 会多出 ▾。 */
    title.dataset.hlKey = key;

    const caret = document.createElement('span');
    caret.className = 'hl-caret';
    title.appendChild(caret);

    const apply = (collapsed) => {
      sec.classList.toggle('hl-sec-collapsed', collapsed);
      caret.textContent = collapsed ? '▸' : '▾';
      title.title = collapsed ? '点击展开' : '点击收起';
    };
    const initial = opts.force === 'closed' ? true : opts.force === 'open' ? false : !!state[key];
    apply(initial);

    title.addEventListener('click', (e) => {
      // 标题栏里可能嵌着按钮 / 下拉（图库的视图切换、标题行操作）—— 点它们不折叠
      if (e.target.closest('button, select, input, textarea, a')) return;
      const next = !sec.classList.contains('hl-sec-collapsed');
      state[key] = next;
      apply(next);
      saveSettings();
    });
  });
}

/**
 * 展开 / 收起容器内全部区块（给「全部展开 / 全部收起」按钮用）。
 * 会写回 `config.ui.collapsedSections`，所以刷新后保持。
 */
export function setAllSectionsCollapsed(container, collapsed) {
  if (!container) return;
  const cfg = getConfig();
  if (!cfg.ui || typeof cfg.ui !== 'object') cfg.ui = {};
  if (!cfg.ui.collapsedSections || typeof cfg.ui.collapsedSections !== 'object') {
    cfg.ui.collapsedSections = {};
  }
  container.querySelectorAll('.hl-section').forEach((sec) => {
    const title = sec.querySelector(':scope > .hl-section-title');
    if (!title) return;
    /** 优先读 dataset（`enableSectionCollapse` 里插箭头**之前**算好的那个）；
     *  没走过那边的（理论上不会有）才退回剥掉箭头字符现算。 */
    const key = title.dataset.hlKey
      || String(title.textContent || '').replace(/[▸▾]/g, '').trim().replace(/\s+/g, ' ').slice(0, 40)
      || 'section';
    cfg.ui.collapsedSections[key] = !!collapsed;
    sec.classList.toggle('hl-sec-collapsed', !!collapsed);
    const caret = title.querySelector('.hl-caret');
    if (caret) caret.textContent = collapsed ? '▸' : '▾';
    title.title = collapsed ? '点击展开' : '点击收起';
  });
  saveSettings();
}
