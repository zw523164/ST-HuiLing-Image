/**
 * 绘灵 · 独立悬浮窗
 *
 * 为什么要有这个：绘灵原来整个面板是挂在酒馆「扩展设置」抽屉里的，
 * 那是个窄栏 —— 六行页签挤在一列宽里、表单被压成一条，根本没法用。
 * 这里把它搬进一个独立窗口（遮罩 + 浮窗），对标那种独立窗形态。
 *
 * 形态要点：
 *   · 遮罩半透明 + 毛玻璃，窗口浮在正中、圆角、投影
 *   · 左上角品牌区，右上角「收起」+「关闭」；Esc / 点遮罩 / 点按钮，多条关闭路径
 *   · 拖题首移动、拖右下角改尺寸，位置与尺寸都记在 localStorage（本机视觉态）
 *   · 可收起成一条题首条，再点展开还原 —— 「可展开的悬浮窗」
 *   · 侧边竖排导航（PC）／顶部横排可横滚（窄屏），由 CSS 断点自动切
 *   · 面板内容懒挂载：没打开过窗口就不跑那些面板初始化（档案/诊断有网络请求）
 *
 * ── 定位语义（v0.5.2 踩过的坑，改动前务必读完）─────────────────────
 * 窗口是 `position: absolute`，包含块是 .hl-overlay 的 padding box，而遮罩
 * 是 `position: fixed; inset: 0; padding: 0`，所以 **窗口的 left/top 就是视口坐标**。
 * v0.5.1 这里是 `position: relative`：对 relative 元素来说 left/top 只是相对偏移，
 * 于是拖动写进去的绝对坐标被叠加到 flex 居中的位置上，同时夹取范围又只按
 * 「视口宽 - 窗宽」算（几十像素），两下一夹 → 窗口几乎纹丝不动；
 * 恢复上次位置时偏移量二次叠加 → 窗口直接甩到右下角溢出屏幕。
 * 结论：CSS 的 position 和这里写 left/top 的语义**必须**是同一套绝对坐标。
 *
 * 刻意不上 shadow DOM：绘灵的 style.css 全用 .hl- 前缀 + 自己的 --hl-* 变量，
 * 泄漏面已经收得很窄；换 shadow 的话所有既有选择器和测试都得推倒重来，不划算。
 */

import { mountPanel } from './panel.js';
import { info, warn, STAGE } from '../log.js';

const OVERLAY_ID = 'hl-app-window';
/** 窗口矩形（位置 + 尺寸）——本机视觉态，记在 localStorage */
const RECT_KEY = 'hl.window.rect.v1';
/** v0.5.0 只存了尺寸，没有位置。打开时兼容读一次，之后不再写 */
const LEGACY_SIZE_KEY = 'hl.window.size.v1';
const TAB_KEY = 'hl.window.tab.v1';

const MIN_W = 720;
const MIN_H = 480;
/** 窗口四周至少留这么多，避免贴死边看不出是浮窗 */
const EDGE_GAP = 32;
/** 窄屏由 CSS 强制铺满（贴底抽屉），不上浮窗那套定位 */
const NARROW_BP = 760;
/** 刚打开那一小会儿忽略遮罩点击，避免触发开窗的那次点击穿透秒关 */
const OPEN_GUARD_MS = 320;
/** 收起态只剩一条题首，宽度收窄到这个值 */
const FOLDED_W = 380;

let overlayEl = null;
let panelMounted = false;
let openedAt = 0;
let pressedOnOverlay = false;
/** 视口尺寸监听只注册一次 */
let viewportBound = false;

/* ---------- 几何状态（位置与尺寸的唯一真源） ---------- */

/** 视口坐标下的窗口矩形；null = 尚未初始化 */
let rectState = null;
/**
 * 用户是否手动摆过（拖动过 / 缩放 / 收起）。
 * 没摆过 → 尺寸继续吃 CSS 的 `min(1180px, 96vw)` 自适应，位置每次重算居中，
 *          改浏览器窗口大小时窗口会跟着变；
 * 摆过   → 位置尺寸全固化，改视口只做「夹回屏幕内」。
 */
let manualBox = false;
/** 收起前的矩形，展开时原样还原 */
let rectBeforeFold = null;

/* ---------- 本机视觉态 ---------- */

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key, val) {
  try {
    localStorage.setItem(key, JSON.stringify(val));
  } catch {
    /* 隐私模式下写不进去，忽略即可 */
  }
}

/* ---------- 主题 ---------- */

/**
 * 窗口不吃酒馆的 --SmartTheme* 当底色（那类 tint 常带透明度，正文会透上来），
 * 所以自己判断明暗：读 body 的文字色亮度 —— 字亮 = 暗底。
 */
function detectTheme() {
  try {
    const color = getComputedStyle(document.body).color || '';
    const nums = color.match(/[\d.]+/g);
    if (!nums || nums.length < 3) return 'dark';
    const [r, g, b] = nums.slice(0, 3).map(Number);
    const lum = 0.299 * r + 0.587 * g + 0.114 * b;
    return lum > 140 ? 'dark' : 'light';
  } catch {
    return 'dark';
  }
}

/* ---------- 构建 ---------- */

function buildOverlay() {
  const el = document.createElement('div');
  el.id = OVERLAY_ID;
  el.className = 'hl-overlay';
  el.dataset.hlTheme = detectTheme();
  el.innerHTML = `
  <div class="hl-window" role="dialog" aria-modal="true" aria-label="绘灵">
    <header class="hl-win-head">
      <span class="hl-win-brand">
        <i class="fa-solid fa-wand-magic-sparkles hl-win-logo"></i>
        <span class="hl-win-name">绘灵</span>
      </span>
      <span class="hl-win-sub">剧情自动配图 · 角色一致性引擎</span>
      <span class="hl-win-size"></span>
      <div class="hl-win-actions">
        <button class="hl-win-btn" type="button" data-act="fold" title="收起 / 展开">
          <i class="fa-solid fa-chevron-up hl-fold-ico"></i>
        </button>
        <button class="hl-win-btn" type="button" data-act="close" title="关闭（Esc）">
          <i class="fa-solid fa-xmark"></i>
        </button>
      </div>
    </header>
    <div class="hl-win-body"></div>
    <div class="hl-win-resize" title="拖动调整窗口大小"></div>
  </div>`;
  document.body.appendChild(el);

  bindOverlayEvents(el);
  bindDragMove(el);
  bindDragResize(el);
  bindFold(el);
  initGeom(el.querySelector('.hl-window'));
  return el;
}

function bindOverlayEvents(el) {
  // 只在「按下与松开都落在遮罩本身」时才算点击遮罩 ——
  // 否则从窗内拖到窗外松手会误关（这个坑踩过）
  el.addEventListener('pointerdown', (e) => {
    pressedOnOverlay = e.target === el;
  });

  el.addEventListener('click', (e) => {
    if (e.target !== el || !pressedOnOverlay) return;
    if (Date.now() - openedAt < OPEN_GUARD_MS) return;
    closeWindow();
  });

  el.querySelector('[data-act="close"]')?.addEventListener('click', (e) => {
    e.stopPropagation();
    closeWindow();
  });

  // Esc 关闭。挂在 document 上而不是遮罩上 —— 焦点在窗内输入框时也要能关
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!overlayEl?.classList.contains('on')) return;
    // 灯箱开着时先关灯箱（灯箱自己处理），别把窗口一起关了
    if (document.querySelector('.hl-lightbox.on')) return;
    closeWindow();
  });
}

/* ---------- 视口与夹取 ---------- */

function isNarrow() {
  return window.innerWidth <= NARROW_BP;
}

/** 视口允许的尺寸区间。窄屏时下限自动跟着降，不然 MIN_W 会直接把窗口撑出屏幕 */
function viewportLimits() {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const maxW = Math.max(280, vw - EDGE_GAP);
  const maxH = Math.max(240, vh - EDGE_GAP);
  return {
    vw, vh, maxW, maxH,
    minW: Math.min(MIN_W, maxW),
    minH: Math.min(MIN_H, maxH),
  };
}

const clampNum = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

/**
 * 把矩形夹回视口内 —— 缩放、恢复、视口变化，全都只能走这一个口子。
 *
 * ★ v0.5.0 那个「缩放后右边溢出屏幕」就是这里写漏的：
 *   旧代码只判 `w <= vw - EDGE_GAP`，**没有减去窗口当前的 left**，
 *   窗口默认居中（left ≈ 100+），允许的宽度却按 left=0 算，
 *   于是拉到上限必然从右边跑出去。正解：先按视口定尺寸上限，
 *   再按「放得下」夹位置，两步缺一不可。
 */
function clampRect(rect) {
  const { vw, vh, minW, minH, maxW, maxH } = viewportLimits();
  const w = clampNum(Number(rect.w) || 0, minW, maxW);
  const h = clampNum(Number(rect.h) || 0, minH, maxH);
  const x = clampNum(Number(rect.x) || 0, 0, Math.max(0, vw - w));
  const y = clampNum(Number(rect.y) || 0, 0, Math.max(0, vh - h));
  return { x, y, w, h };
}

/**
 * 只夹位置、**不动尺寸**（拖动时用）。
 * 拖动不改变尺寸，走 clampRect 会拿 minW/maxW 去比一遍，
 * 万一当前尺寸已经越界（比如 CSS 在超窄视口下算出的宽 < MIN_W），
 * 一按下题首窗口就会「啪」地跳一下尺寸。
 */
function clampPos(x, y, w, h) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  return {
    x: clampNum(Number(x) || 0, 0, Math.max(0, vw - w)),
    y: clampNum(Number(y) || 0, 0, Math.max(0, vh - h)),
    w, h,
  };
}

/** 居中矩形（尺寸由调用方给） */
function centerBox(w, h) {
  return {
    x: (window.innerWidth - w) / 2,
    y: (window.innerHeight - h) / 2,
    w, h,
  };
}

/**
 * 当前「天生」尺寸：没写 inline 尺寸时就是 CSS 算出来的 min(1180px,96vw) 那套。
 * 读不到布局（jsdom / display:none 容器）时按同一公式兜底 ——
 * 公式和 CSS 是重复的真源，改 CSS 的 .hl-window 尺寸时这里要跟着改。
 */
function naturalSize(win) {
  const w = win?.offsetWidth || 0;
  const h = win?.offsetHeight || 0;
  if (w > 0 && h > 0) return { w, h };
  return {
    w: Math.min(1180, window.innerWidth * 0.96),
    h: Math.min(940, window.innerHeight * 0.88),
  };
}

/**
 * 读窗口「当前的」矩形。
 * 尺寸用 offsetWidth/Height 而不是 getBoundingClientRect ——
 * off 态窗口带 `transform: scale(0.965)`，rect 会返回缩小后的值，
 * 存下来就变成每开一次缩水 3.5%。
 * 位置用 offsetLeft/offsetTop（窗口 absolute，offsetParent 就是全屏遮罩，
 * 所以这两个值直接是视口坐标，且同样不受 transform 影响）。
 */
function currentBox(win) {
  if (!win) return null;
  const w = win.offsetWidth;
  const h = win.offsetHeight;
  if (!(w > 0 && h > 0)) return rectState ? { ...rectState } : null;
  return { x: win.offsetLeft, y: win.offsetTop, w, h };
}

/** 把矩形写进 inline style。size=false 只改位置（让尺寸继续吃 CSS 自适应） */
function applyBox(win, box, { size = true } = {}) {
  if (size) {
    win.style.width = `${Math.round(box.w)}px`;
    win.style.height = `${Math.round(box.h)}px`;
  }
  win.style.left = `${Math.round(box.x)}px`;
  win.style.top = `${Math.round(box.y)}px`;
}

/** 清掉 inline 几何，交回 CSS（窄屏贴底抽屉用） */
function clearInline(win) {
  if (!win) return;
  win.style.left = '';
  win.style.top = '';
  win.style.width = '';
  win.style.height = '';
}

/** 拖动/缩放时在题首显示「宽 × 高」，松手即隐（传 null 清除） */
function showSize(el, box) {
  const tag = el.querySelector('.hl-win-size');
  if (!tag) return;
  tag.textContent = box ? `${Math.round(box.w)} × ${Math.round(box.h)}` : '';
}

function saveRect(win) {
  const b = currentBox(win) || rectState;
  if (!b) return;
  writeJson(RECT_KEY, {
    x: Math.round(b.x), y: Math.round(b.y),
    w: Math.round(b.w), h: Math.round(b.h),
  });
}

/** 没被手动摆过：清掉 inline 尺寸 → 读 CSS 算出的尺寸 → 居中 */
function layoutAuto(win) {
  if (!win) return;
  win.style.width = '';
  win.style.height = '';
  const nat = naturalSize(win);
  const box = clampRect(centerBox(nat.w, nat.h));
  rectState = box;
  applyBox(win, box, { size: false });
}

/**
 * 初始化窗口几何（建窗时跑一次）。
 * 优先用上次记录的位置，其次 v0.5.0 的纯尺寸记录，最后才是默认居中。
 */
function initGeom(win) {
  if (!win) return;
  const nat = naturalSize(win);

  const saved = readJson(RECT_KEY, null);
  if (saved && Number.isFinite(saved.x) && Number.isFinite(saved.y)) {
    manualBox = true;
    rectState = clampRect({
      x: saved.x, y: saved.y,
      w: Number.isFinite(saved.w) ? saved.w : nat.w,
      h: Number.isFinite(saved.h) ? saved.h : nat.h,
    });
    applyBox(win, rectState);
    return;
  }

  const legacy = readJson(LEGACY_SIZE_KEY, null);
  if (legacy && Number.isFinite(legacy.w) && Number.isFinite(legacy.h)) {
    // 老记录只有尺寸没有位置 → 尺寸认，位置仍居中
    manualBox = true;
    rectState = clampRect(centerBox(legacy.w, legacy.h));
    applyBox(win, rectState);
    return;
  }

  manualBox = false;
  layoutAuto(win);
}

/** 视口变化 / 重新打开时的统一收口 */
function relayout(win) {
  if (!win) return;
  if (isNarrow()) {
    clearInline(win);
    rectState = null;
    return;
  }
  // 没手动摆过 → 每次重算居中；尺寸不写 inline，继续吃 CSS 的 96vw/88vh 自适应。
  // （用户改浏览器窗口大小时，没动过的窗口应当跟着缩放并保持居中，
  //   而不是像手动摆过的窗口那样被「夹住原地不动」。）
  if (!manualBox) {
    layoutAuto(win);
    return;
  }
  const base = rectState || currentBox(win);
  if (!base) return;
  // 收起态窗口高度是内容撑的，别用记录里的大高度去夹 y
  const folded = overlayEl?.classList.contains('is-folded');
  const nat = folded ? naturalSize(win) : null;
  rectState = folded ? clampPos(base.x, base.y, nat.w, nat.h) : clampRect(base);
  applyBox(win, rectState, { size: !folded });
}

/* ---------- 收起 / 展开 ---------- */

/**
 * 收起：只留一条题首。
 * 高度交给 CSS（`.is-folded .hl-window { height: auto }`），这里只负责
 * 把宽度收窄并把位置夹回屏幕内 —— 收起后窗口变窄了，本来靠右的窗口
 * 不夹一下就会在右下角露一截身子。
 */
function setFolded(el, win, folded) {
  if (!el || !win) return;
  const btn = el.querySelector('[data-act="fold"]');
  if (el.classList.contains('is-folded') === folded) return;
  // 窄屏本来就是铺满贴底的抽屉，收起没有意义（入口也被 CSS 藏了）
  if (folded && isNarrow()) return;

  if (folded) {
    rectBeforeFold = rectState ? { ...rectState } : null;
    el.classList.add('is-folded');
    const w = Math.min(FOLDED_W, Math.max(240, window.innerWidth - EDGE_GAP));
    const box = clampPos(rectState?.x ?? 0, rectState?.y ?? 0, w, rectState?.h ?? MIN_H);
    rectState = { x: box.x, y: box.y, w, h: rectState?.h ?? MIN_H };
    win.style.left = `${Math.round(box.x)}px`;
    win.style.top = `${Math.round(box.y)}px`;
    btn?.setAttribute('title', '展开');
  } else {
    el.classList.remove('is-folded');
    const back = rectBeforeFold || rectState;
    rectBeforeFold = null;
    // 收起期间可能换过视口，展开也要过一遍夹取
    rectState = back ? clampRect(back) : rectState;
    if (rectState) applyBox(win, rectState);
    btn?.setAttribute('title', '收起 / 展开');
  }
  manualBox = true;
  info(STAGE.UI, folded ? '窗口已收起' : '窗口已展开');
}

function bindFold(el) {
  el.querySelector('[data-act="fold"]')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const win = el.querySelector('.hl-window');
    setFolded(el, win, !el.classList.contains('is-folded'));
  });
  // 收起态双击题首也能展开，符合「条状窗」的直觉
  el.querySelector('.hl-win-head')?.addEventListener('dblclick', (e) => {
    if (e.target.closest('button')) return;
    const win = el.querySelector('.hl-window');
    setFolded(el, win, !el.classList.contains('is-folded'));
  });
}

/* ---------- 拖动移动（拖题首） ---------- */

function bindDragMove(el) {
  const head = el.querySelector('.hl-win-head');
  const win = el.querySelector('.hl-window');
  if (!head || !win) return;

  head.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    // 按钮上按下不算拖窗口
    if (e.target.closest('button, a, input, select, textarea, .hl-win-resize')) return;
    if (isNarrow()) return; // 窄屏是贴底抽屉，位置由 CSS 锁死

    e.preventDefault();
    // 起点直接用窗口当前渲染出来的矩形（收起态高度是内容撑的，只有 DOM 知道）
    const start = currentBox(win) || rectState;
    if (!start) return;
    const offX = e.clientX - start.x;
    const offY = e.clientY - start.y;

    manualBox = true;
    el.classList.add('is-moving');
    // 指针捕获：鼠标划出窗口/浏览器边缘也不丢 pointermove
    try { head.setPointerCapture?.(e.pointerId); } catch { /* 环境不支持就算了 */ }

    const onMove = (ev) => {
      const box = clampPos(ev.clientX - offX, ev.clientY - offY, start.w, start.h);
      rectState = box;
      applyBox(win, box, { size: !el.classList.contains('is-folded') });
      showSize(el, box);
    };

    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      el.classList.remove('is-moving');
      showSize(el, null);
      saveRect(win);
    };

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  });
}

/* ---------- 拖拽缩放（拖右下角） ---------- */

function bindDragResize(el) {
  const handle = el.querySelector('.hl-win-resize');
  const win = el.querySelector('.hl-window');
  if (!handle || !win) return;

  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();

    const start = currentBox(win) || rectState;
    if (!start) return;
    const sx = e.clientX;
    const sy = e.clientY;

    manualBox = true;
    el.classList.add('is-resizing');
    try { handle.setPointerCapture?.(e.pointerId); } catch { /* ignore */ }

    const onMove = (ev) => {
      // 左上角钉住，只有右下角跟手；左上也一并夹，避免窗口被推到屏幕外
      const box = clampRect({
        x: start.x,
        y: start.y,
        w: start.w + (ev.clientX - sx),
        h: start.h + (ev.clientY - sy),
      });
      rectState = box;
      applyBox(win, box);
      showSize(el, box);
    };

    const onUp = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      el.classList.remove('is-resizing');
      showSize(el, null);
      saveRect(win);
    };

    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
  });
}

/** 视口变了（改浏览器窗口 / 转屏）：窗口重新摆一次，别让它留在屏幕外 */
function bindViewportGuard() {
  if (viewportBound) return;
  viewportBound = true;
  window.addEventListener('resize', () => {
    if (!overlayEl?.classList.contains('on')) return;
    relayout(overlayEl.querySelector('.hl-window'));
  });
}

/* ---------- 页签记忆 ---------- */

function restoreTab(root) {
  const key = readJson(TAB_KEY, null);
  if (!key) return;
  const btn = root.querySelector(`.hl-tab[data-tab="${key}"]`);
  if (!btn || btn.classList.contains('active')) return;
  btn.click();
}

function rememberTab(root) {
  root.querySelectorAll('.hl-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      writeJson(TAB_KEY, btn.dataset.tab);
    });
  });
}

/* ---------- 对外 ---------- */

export function isWindowOpen() {
  return !!overlayEl?.classList.contains('on');
}

export function openWindow(tabKey) {
  try {
    if (!overlayEl) overlayEl = buildOverlay();
    // 每次打开都重判：用户可能中途换过酒馆主题
    overlayEl.dataset.hlTheme = detectTheme();

    // 面板懒挂载：第一次打开窗口才跑那些面板初始化
    const body = overlayEl.querySelector('.hl-win-body');
    if (!panelMounted && body) {
      body.innerHTML = '';
      try {
        const root = mountPanel(body, { variant: 'window' });
        if (root) {
          restoreTab(root);
          rememberTab(root);
        }
        panelMounted = true;
      } catch (err) {
        body.innerHTML = `<div class="hl-err">面板挂载失败：${err?.message || err}</div>`;
        warn(STAGE.UI, `窗口面板挂载失败：${err?.message || err}`);
      }
    }

    if (tabKey && panelMounted) {
      const btn = overlayEl.querySelector(`.hl-tab[data-tab="${tabKey}"]`);
      if (btn && !btn.classList.contains('active')) btn.click();
    }

    openedAt = Date.now();
    // 收起是临时状态，重新打开一律回到完整窗口
    const win = overlayEl.querySelector('.hl-window');
    if (win?.parentElement) setFolded(overlayEl, win, false);
    overlayEl.classList.add('on');
    document.body.classList.add('hl-win-lock');

    // 每次打开重新摆一次：这期间视口可能变小了（改窗口大小 / 转屏 / 换显示器）
    bindViewportGuard();
    relayout(win);

    info(STAGE.UI, '绘灵窗口已打开');
  } catch (err) {
    warn(STAGE.UI, `打开窗口失败：${err?.message || err}`);
  }
}

export function closeWindow() {
  if (!overlayEl) return;
  overlayEl.classList.remove('on');
  // 位置和尺寸**故意留着** —— 用户拖到哪儿、拉到多大，下次打开还在那儿。
  // 想回默认走「恢复窗口默认大小与位置」按钮。
  overlayEl.classList.remove('is-resizing', 'is-moving');
  document.body.classList.remove('hl-win-lock');
}

export function toggleWindow() {
  if (isWindowOpen()) closeWindow();
  else openWindow();
}

/** 忘掉记下来的窗口矩形，回到默认（居中 + CSS 默认尺寸）。 */
export function resetWindowSize() {
  try {
    localStorage.removeItem(RECT_KEY);
    localStorage.removeItem(LEGACY_SIZE_KEY);
  } catch {
    /* ignore */
  }
  const win = overlayEl?.querySelector('.hl-window');
  if (win && overlayEl) setFolded(overlayEl, win, false);
  manualBox = false;
  rectBeforeFold = null;
  if (win) layoutAuto(win);
  else rectState = null;
}

/** 当前是否收起态（供面板 / 测试用） */
export function isWindowFolded() {
  return !!overlayEl?.classList.contains('is-folded');
}

/** 供测试与诊断用：当前窗口矩形 */
export function windowRect() {
  return currentBox(overlayEl?.querySelector('.hl-window'));
}

/**
 * 供测试用的纯函数出口 —— 位置/尺寸的夹取规则是这一层最容易回归的地方
 * （v0.5.0 的「缩放后右边溢出屏幕」、v0.5.1 的「压根拖不动」都出在这里），
 * 值得单独测。
 */
export const __clampRect = clampRect;
export const __clampPos = clampPos;
