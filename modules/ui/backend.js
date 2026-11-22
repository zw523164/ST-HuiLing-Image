/**
 * 绘灵 · 「生图后端」页 —— 渠道条 + 面板分发
 *
 * 这一页现在只是壳：真正的三个后端面板在 modules/ui/backends/ 下，
 * 这里负责「列渠道、显示状态、切面板」。
 *
 * 两个刻意的设计：
 *
 * ① **「在看哪个渠道」与「哪个渠道生效」是两件事。**
 *    点渠道标签只是切换查看，不会改生效后端 —— 否则用户想瞄一眼 NAI 的配置，
 *    出图后端就被悄悄换掉了（而且多半还没配好）。要生效必须点面板里的
 *    「设为生效后端」，一步明确的动作。
 *
 * ② **「不出图」独立于渠道之外。**
 *    它不是"第四个后端"，而是一个开关：只让绘灵分析出词、写出图位，不提交生图。
 *    调提示词、试规范、跑 DRY 都靠它 —— 挂在渠道条最右侧。
 */

import { getConfig, saveSettings } from '../settings.js';
import { BACKENDS, activeBackendKey, backendReadiness, OFF_BACKEND } from '../backends/index.js';
import { info, error, STAGE } from '../log.js';
import { escapeHtml, $ } from './backends/shared.js';

import { mount as mountComfyui } from './backends/comfyui.js';
import { mount as mountNai } from './backends/nai.js';
import { mount as mountOpenai } from './backends/openai.js';

const PANELS = {
  comfyui: mountComfyui,
  nai: mountNai,
  openai: mountOpenai,
};

/** 页内状态：正在查看哪个渠道。不落盘 —— 重开面板回到"生效后端"那一页。 */
let viewingKey = '';

/** 防竞态：快速连点渠道时，只认最后一次的挂载结果。 */
let mountToken = 0;

/* ============ 渠道条 ============ */

function barHtml(cfg) {
  const activeKey = activeBackendKey(cfg);
  const off = activeKey === OFF_BACKEND;

  const tabs = BACKENDS.map((b) => {
    const readiness = backendReadiness(b.key, cfg);
    const isActive = activeKey === b.key;
    const isViewing = viewingKey === b.key;
    const cls = [
      'hl-chan-tab',
      isViewing ? 'is-viewing' : '',
      isActive ? 'is-active' : '',
      readiness.ready ? 'is-ready' : 'is-unready',
    ].filter(Boolean).join(' ');
    const dot = readiness.ready ? '●' : '○';
    return `
      <button class="${cls}" data-chan="${escapeHtml(b.key)}" title="${escapeHtml(readiness.reason)}">
        <span class="hl-chan-dot">${dot}</span>
        <span class="hl-chan-label">${escapeHtml(b.name)}</span>
        ${isActive && !off ? '<span class="hl-chan-flag">生效</span>' : ''}
      </button>`;
  }).join('');

  return `
    <div class="hl-chan-tabs">${tabs}</div>
    <button class="hl-chan-off${off ? ' is-on' : ''}" id="hl-backend-off"
            title="只让绘灵分析出词、写出图位，不真的提交生图（调提示词时用）">
      ${off ? '⏸ 当前：不做生图' : '⏸ 不做生图'}
    </button>`;
}

function bindBar(container) {
  const cfg = getConfig();

  container.querySelectorAll('[data-chan]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.chan;
      if (viewingKey === key) return;
      viewingKey = key;
      renderBar(container);
      renderPanel(container);
    });
  });

  $(container, '#hl-backend-off')?.addEventListener('click', () => {
    if (activeBackendKey(cfg) === OFF_BACKEND) {
      // 再点一次 = 取消，回到之前那个渠道（默认 ComfyUI）
      cfg.activeBackend = viewingKey || 'comfyui';
      info(STAGE.UI, '已恢复提交生图');
    } else {
      cfg.activeBackend = OFF_BACKEND;
      info(STAGE.UI, '已切换为「不做生图」—— 只写出图位');
    }
    saveSettings();
    renderBar(container);
    // 「不做生图」会影响渠道头的"生效中"标记，面板也要跟着刷新
    renderPanel(container);
  });
}

function renderBar(container) {
  const bar = $(container, '#hl-chan-bar');
  if (!bar) return;
  bar.innerHTML = barHtml(getConfig());
  bindBar(container);
}

/* ============ 面板 ============ */

async function renderPanel(container) {
  const pane = $(container, '#hl-chan-panel');
  if (!pane) return;

  const key = PANELS[viewingKey] ? viewingKey : 'comfyui';
  const token = ++mountToken;

  pane.innerHTML = '<div class="hl-hint">正在加载面板…</div>';

  try {
    await PANELS[key](pane, () => {
      // 渠道头里改了「启用 / 设为生效」→ 只刷新渠道条，不重挂面板（免得丢焦点）
      renderBar(container);
    });
    if (token !== mountToken) return; // 期间又被切走了，丢弃这次结果
  } catch (err) {
    if (token !== mountToken) return;
    pane.innerHTML = '';
    error(STAGE.UI, `「${key}」后端面板挂载失败：${err?.message || err}`, {
      cause: '面板渲染或事件绑定时抛错',
      fix: '把这条日志导出后反馈；期间可以先用其它渠道',
    }, err?.stack);
  }
}

/* ============ 入口 ============ */

export async function mountBackend(container) {
  const cfg = getConfig();

  // 首次进来停在「生效后端」那一页；"不出图"没有面板，落到 ComfyUI
  if (!viewingKey) {
    const active = activeBackendKey(cfg);
    viewingKey = active === OFF_BACKEND ? 'comfyui' : active;
  }

  container.innerHTML = `
    <div class="hl-chan-bar" id="hl-chan-bar">${barHtml(cfg)}</div>
    <div class="hl-chan-panel" id="hl-chan-panel"></div>`;

  bindBar(container);
  await renderPanel(container);
}
