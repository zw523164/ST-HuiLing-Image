/**
 * 绘灵 · 入口安装器
 *
 * 三条互相独立的路，把「绘灵窗口」调出来：
 *   ① 顶栏按钮  —— 挨着酒馆原生顶栏图标，用 ST 自己的 .drawer / .drawer-icon 类名，跟随主题
 *   ② 魔杖菜单  —— 🪄 菜单里加一项，和其它扩展的口径一致
 *   ③ 悬浮球    —— 屏幕边缘一枚可拖动的球，贴边半隐、hover 滑出
 *
 * 为什么三个都要：用户原来的抱怨是「调出方式简陋」—— 得先开扩展设置抽屉、找到绘灵、
 * 展开，才能看见面板。三条路任挑一条，都是一步到位。
 *
 * 全部幂等：重复调用不会插出两份；开关变化时 syncLauncher() 增删即可。
 */

import { getConfig } from '../settings.js';
import { openWindow, closeWindow, isWindowOpen, toggleWindow } from './window.js';
import { info, STAGE } from '../log.js';

const TOPBAR_ID = 'hl-topbar-button';
const MENU_ID = 'hl-menu-item';
const ORB_ID = 'hl-orb';
const ORB_POS_KEY = 'hl.orb.pos.v1';

/** 轮询上限：酒馆顶栏/菜单是懒加载的，等一会儿；始终不出现就放弃，绝不常驻空转 */
const POLL_MS = 500;
const POLL_MAX = 40;

/* ---------- 图标 ---------- */

const ICON_CLASS = 'fa-solid fa-wand-magic-sparkles';

/**
 * 图标位能不能用，得同时满足两件事：
 *   ① 伪元素的 content 有字形 —— 有些美化主题会把 FontAwesome 的字形清掉
 *   ② 字体真的加载了 —— CDN 挂了 / 字体还没到位时，content 有值也是空白方块
 * 两条都过才用图标，否则退成「绘」字。
 */
let faOk = null;
function fontAwesomeWorks() {
  if (faOk !== null) return faOk;
  try {
    const probe = document.createElement('i');
    probe.className = 'fa-solid fa-circle';
    probe.style.cssText = 'position:absolute;left:-9999px;visibility:hidden';
    document.body.appendChild(probe);
    const pseudo = getComputedStyle(probe, '::before');
    const content = pseudo.content;
    const family = pseudo.fontFamily || '';
    probe.remove();

    const hasGlyph = !!content && content !== 'none' && content !== 'normal' && content !== '""';

    let fontReady = true;
    try {
      const quoted = family.match(/["']([^"']+)["']/);
      const name = (quoted ? quoted[1] : family.split(',')[0]).trim();
      if (name && document.fonts?.check) fontReady = document.fonts.check(`900 16px "${name}"`);
    } catch {
      /* 查不了就当字体没问题，别因为探测失败把图标也砍了 */
    }

    faOk = hasGlyph && fontReady;
  } catch {
    faOk = false;
  }
  return faOk;
}

/** 图标位：FA 可用就给图标，不可用就退成一个「绘」字（保证永远看得见） */
function iconHtml(tag = 'i') {
  return fontAwesomeWorks()
    ? `<${tag} class="${ICON_CLASS}"></${tag}>`
    : '<span class="hl-icon-fallback">绘</span>';
}

/* ---------- ① 顶栏按钮 ---------- */

function buildTopBarButton() {
  const btn = document.createElement('div');
  btn.id = TOPBAR_ID;
  btn.className = 'drawer';
  btn.innerHTML = `
  <div class="drawer-toggle">
    <div class="drawer-icon ${fontAwesomeWorks() ? ICON_CLASS : 'hl-icon-text'} fa-fw closedIcon" title="绘灵">${
      fontAwesomeWorks() ? '' : '绘'
    }</div>
  </div>`;

  // 只负责开窗：preventDefault + stopPropagation，避免被酒馆的
  // doNavbarIconClick 当成抽屉来开合
  btn.querySelector('.drawer-toggle')?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleWindow();
  });
  return btn;
}

function tryTopBar() {
  if (!getConfig().ui?.topbar) {
    document.getElementById(TOPBAR_ID)?.remove();
    return true;
  }
  const holder = document.getElementById('top-settings-holder');
  if (!holder) return false;
  if (document.getElementById(TOPBAR_ID)) return true;

  const btn = buildTopBarButton();
  // 插在「用户设定管理」左边；它还没渲染就退到顶栏末尾
  const persona = document.getElementById('persona-management-button');
  if (persona?.parentElement) persona.before(btn);
  else holder.appendChild(btn);
  return true;
}

/* ---------- ② 魔杖菜单项 ---------- */

function tryMenu() {
  if (!getConfig().ui?.menu) {
    document.getElementById(MENU_ID)?.remove();
    return true;
  }
  const menu = document.getElementById('extensionsMenu');
  if (!menu) return false;
  if (document.getElementById(MENU_ID)) return true;

  const item = document.createElement('div');
  item.className = 'extension_container interactable';
  item.tabIndex = 0;
  item.innerHTML = `
    <a id="${MENU_ID}" class="list-group-item" href="#" title="绘灵">
      ${iconHtml()}
      <span>绘灵</span>
    </a>`;

  item.addEventListener('click', (e) => {
    e.preventDefault();
    openWindow();
    // 点完收起魔杖菜单，贴合酒馆原生行为
    const m = document.getElementById('extensionsMenu');
    if (m) m.style.display = 'none';
  });
  menu.appendChild(item);
  return true;
}

/* ---------- ③ 悬浮球 ---------- */

const SNAP_ZONE = 56; // 松手时距左/右边缘 ≤ 此值即贴边
const CLICK_SLOP = 6; // 位移小于此值算点击而非拖动

let orbEl = null;
let orbDrag = null;

function loadOrbPos() {
  const fallback = { dock: 'right', x: 0, y: Math.round(window.innerHeight * 0.58) };
  try {
    const raw = localStorage.getItem(ORB_POS_KEY);
    if (!raw) return fallback;
    const p = JSON.parse(raw);
    if (p && (p.dock === 'left' || p.dock === 'right' || p.dock === 'none')) {
      return { dock: p.dock, x: Number(p.x) || 0, y: Number(p.y) || 0 };
    }
  } catch {
    /* ignore */
  }
  return fallback;
}

function saveOrbPos(pos) {
  try {
    localStorage.setItem(ORB_POS_KEY, JSON.stringify(pos));
  } catch {
    /* ignore */
  }
}

function orbSize() {
  const n = Number(getConfig().ui?.orbSize);
  return Number.isFinite(n) && n >= 28 && n <= 96 ? n : 46;
}

function placeOrb(pos, state) {
  if (!orbEl) return;
  const size = orbSize();
  const maxY = Math.max(0, window.innerHeight - size);
  pos.y = Math.min(Math.max(0, pos.y), maxY);
  if (pos.dock === 'none') {
    const maxX = Math.max(0, window.innerWidth - size);
    pos.x = Math.min(Math.max(0, pos.x), maxX);
  }

  orbEl.style.top = `${pos.y}px`;
  orbEl.style.width = `${size}px`;
  orbEl.style.height = `${size}px`;
  orbEl.style.left = '';
  orbEl.style.right = '';
  orbEl.style.transform = '';

  const awake = state?.dragging || state?.hover;
  // v0.9.102：贴边位移 58% → 40%。
  // 58% 时 46px 的球只露 19px，叠上 60% 不透明度，在深色页面边缘等于隐形
  // （用户因此以为开关没生效）。40% 露出约 28px，仍然「半隐」，但一眼能看出有东西。
  if (pos.dock === 'left') {
    orbEl.style.left = '0px';
    orbEl.style.transform = awake ? 'translateX(0)' : 'translateX(-40%)';
  } else if (pos.dock === 'right') {
    orbEl.style.right = '0px';
    orbEl.style.transform = awake ? 'translateX(0)' : 'translateX(40%)';
  } else {
    orbEl.style.left = `${pos.x}px`;
  }
}

function buildOrb() {
  const el = document.createElement('div');
  el.id = ORB_ID;
  el.className = 'hl-orb';
  el.setAttribute('role', 'button');
  el.setAttribute('tabindex', '0');
  el.setAttribute('aria-label', '打开绘灵');
  el.title = '绘灵';
  el.innerHTML = `<span class="hl-orb-glyph">${
    fontAwesomeWorks() ? `<i class="${ICON_CLASS} hl-orb-icon"></i>` : '<span class="hl-orb-text">绘</span>'
  }</span>`;

  const pos = loadOrbPos();
  const state = { dragging: false, hover: false };
  const opacity = Number(getConfig().ui?.orbOpacity);
  el.style.setProperty('--hl-orb-rest', String(Math.min(100, Math.max(20, Number.isFinite(opacity) ? opacity : 60)) / 100));
  // 图标字号随球体缩放，比例才协调
  el.style.setProperty('--hl-orb-icon-size', `${Math.round(orbSize() * 0.44)}px`);
  /**
   * ★ v0.9.103：层级写在内联上，不只写在 style.css 里。
   *
   * 教训：v0.9.102 把 `.hl-orb` 的 z-index 从 99980 提到 99995，用户 F5 后仍报「看不见」。
   * 只要浏览器还在用旧的 style.css（强缓存 / 中间代理 / ST 未重启），改 CSS 就等于没改。
   * 内联样式不受这份缓存影响，是唯一「改了立刻生效」的层级保证。
   * 数值必须与 style.css 里 `.hl-orb` 一致（orb-layer-0102-test 会交叉校验）。
   */
  el.style.zIndex = '99995';

  let pointerId = null;
  let sx = 0;
  let sy = 0;
  let grabDX = 0;
  let grabDY = 0;
  let moved = 0;

  const currentLeft = () => {
    if (pos.dock === 'right') return window.innerWidth - orbSize();
    if (pos.dock === 'left') return 0;
    return pos.x;
  };

  el.addEventListener('pointerdown', (e) => {
    pointerId = e.pointerId;
    state.dragging = true;
    moved = 0;
    sx = e.clientX;
    sy = e.clientY;
    grabDX = e.clientX - currentLeft();
    grabDY = e.clientY - pos.y;
    el.classList.add('is-dragging');
    el.setPointerCapture?.(e.pointerId);
  });

  el.addEventListener('pointermove', (e) => {
    if (!state.dragging || e.pointerId !== pointerId) return;
    moved = Math.max(moved, Math.abs(e.clientX - sx) + Math.abs(e.clientY - sy));
    if (moved < CLICK_SLOP) return;
    pos.dock = 'none';
    pos.x = e.clientX - grabDX;
    pos.y = e.clientY - grabDY;
    placeOrb(pos, state);
  });

  const finish = (e) => {
    if (!state.dragging || e.pointerId !== pointerId) return;
    state.dragging = false;
    pointerId = null;
    el.classList.remove('is-dragging');

    if (moved < CLICK_SLOP) {
      toggleWindow();
      return;
    }
    // 松手吸附：靠近左右边缘才贴边，否则停在原地
    const left = pos.x;
    const right = window.innerWidth - (pos.x + orbSize());
    if (left <= SNAP_ZONE) pos.dock = 'left';
    else if (right <= SNAP_ZONE) pos.dock = 'right';
    else pos.dock = 'none';
    placeOrb(pos, state);
    saveOrbPos(pos);
  };
  el.addEventListener('pointerup', finish);
  el.addEventListener('pointercancel', finish);

  el.addEventListener('pointerenter', () => {
    state.hover = true;
    placeOrb(pos, state);
  });
  el.addEventListener('pointerleave', () => {
    state.hover = false;
    placeOrb(pos, state);
  });
  el.addEventListener('focus', () => {
    state.hover = true;
    placeOrb(pos, state);
  });
  el.addEventListener('blur', () => {
    state.hover = false;
    placeOrb(pos, state);
  });
  el.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggleWindow();
    }
  });

  window.addEventListener('resize', () => placeOrb(pos, state));

  placeOrb(pos, state);
  return el;
}

function tryOrb() {
  if (!getConfig().ui?.orb) {
    orbEl?.remove();
    orbEl = null;
    return;
  }
  /**
   * ★ v0.9.103：变量还指着元素、元素已被摘掉 → 原来 `if (orbEl) return` 会让球
   * **永久消失直到刷新**。ST 切角色 / 重渲染 / 别的扩展动 body 都可能把它摘走，
   * 而模块级变量不会跟着清零。这是「球明明该在却一直没有」的一条真实通路。
   */
  if (orbEl && !document.body.contains(orbEl)) orbEl = null;
  if (orbEl) return;
  orbEl = buildOrb();
  document.body.appendChild(orbEl);
}

/* ---------- 安装 ---------- */

let pollTimer = null;

/** 立即尝试三条入口；顶栏/菜单没就绪的留给轮询 */
function attempt() {
  const a = tryTopBar();
  const b = tryMenu();
  tryOrb();
  return a && b;
}

/** 幂等安装（并处理配置开关的增删）。开关变化时再调一次即可。 */
export function syncLauncher() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  if (attempt()) {
    info(STAGE.UI, '入口已就绪（顶栏 / 魔杖菜单 / 悬浮球）');
    return;
  }
  let tries = 0;
  pollTimer = setInterval(() => {
    if (attempt() || ++tries > POLL_MAX) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }, POLL_MS);
}

/** 供控制台/其它模块调用 */
export { openWindow, closeWindow, toggleWindow, isWindowOpen };

/**
 * 按当前配置重建悬浮球。
 * 尺寸 / 不透明度是建球时一次性算进内联样式的，改了配置必须重建才对得上。
 */
export function refreshOrb() {
  orbEl?.remove();
  orbEl = null;
  tryOrb();
}

/* ---------- 悬浮球自检（v0.9.103） ---------- */

let probeTimer = null;

/** 让球在视口里明显闪 6 秒。贴边半隐 / 低不透明度都会让人「看不见」，自检时必须强制拉出来。 */
function flashOrb(el) {
  if (!el) return;
  el.classList.add('is-probe');
  el.style.transform = 'none';
  el.style.opacity = '1';
  if (probeTimer) clearTimeout(probeTimer);
  probeTimer = setTimeout(() => {
    probeTimer = null;
    el.classList.remove('is-probe');
    el.style.opacity = '';
    placeOrb(loadOrbPos(), { dragging: false, hover: false });
  }, 6000);
}

/**
 * 悬浮球自检。给界面一个「点一下就能自证」的入口。
 *
 * 为什么必须有这个东西：jsdom 测不出「看得见」—— 遮挡、位置、透明度、层级它一律不知道，
 * 所以 window-test 里那几条「球在不在 DOM」的断言永远绿，用户却报「没有球」。
 * 这个函数返回的是**运行时的真实几何与遮挡关系**，不是推测。
 *
 * @returns {{ok:boolean, switchedOn:boolean, created:boolean, rescued?:boolean,
 *            rect?:{x:number,y:number,w:number,h:number}, inView?:boolean,
 *            opacity?:string, display?:string, visibility?:string, zIndex?:string,
 *            coveredBy?:string, viewport?:{w:number,h:number}, reason?:string}}
 */
export function probeOrb() {
  const existed = !!orbEl && document.body.contains(orbEl);
  if (!existed) {
    if (orbEl) { orbEl.remove(); orbEl = null; }
    tryOrb();
  }
  const el = document.getElementById(ORB_ID);
  const switchedOn = !!getConfig().ui?.orb;
  if (!el) {
    return { ok: false, switchedOn, created: false, reason: switchedOn ? 'create-failed' : 'switch-off' };
  }

  const inViewOf = (r) => r.width > 0 && r.height > 0
    && r.right > 0 && r.bottom > 0
    && r.left < window.innerWidth && r.top < window.innerHeight;

  // 位置坐标坏了（老存档 / 视口缩小 / 拖到屏幕外）→ 先拉回右侧中间再看
  let rescued = false;
  if (!inViewOf(el.getBoundingClientRect())) {
    const p = loadOrbPos();
    p.dock = 'right';
    p.y = Math.round(window.innerHeight * 0.5);
    placeOrb(p, { dragging: false, hover: false });
    saveOrbPos(p);
    rescued = true;
  }

  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);

  // 谁盖住了它：取球心那一摞元素，球不在最上层就是被压住了
  let coveredBy = '';
  try {
    const cx = Math.min(Math.max(1, Math.round(r.left + r.width / 2)), Math.max(1, window.innerWidth - 1));
    const cy = Math.min(Math.max(1, Math.round(r.top + r.height / 2)), Math.max(1, window.innerHeight - 1));
    const stack = document.elementsFromPoint(cx, cy) || [];
    if (stack.length && stack[0] !== el) {
      const top = stack[0];
      const cls = typeof top.className === 'string'
        ? top.className.split(/\s+/).filter(Boolean).slice(0, 2).map((c) => `.${c}`).join('')
        : '';
      coveredBy = `${top.tagName.toLowerCase()}${top.id ? `#${top.id}` : ''}${cls}`;
      if (stack.indexOf(el) === -1) coveredBy += '（球完全不在命中栈里）';
    }
  } catch { /* elementsFromPoint 不可用时忽略 */ }

  flashOrb(el);
  return {
    ok: true,
    switchedOn,
    created: !existed,
    rescued,
    rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
    inView: inViewOf(r),
    opacity: cs.opacity,
    display: cs.display,
    visibility: cs.visibility,
    zIndex: cs.zIndex,
    coveredBy,
    viewport: { w: window.innerWidth, h: window.innerHeight },
  };
}
