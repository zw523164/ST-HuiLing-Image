/**
 * 绘灵 · 图库面板（v0.9.13 重构）
 *
 * 两个视图：
 *   【本聊天】当前聊天出过的图（数据源 = floors 出图位记录，正文才是真源）；
 *   【历史生图】所有聊天生成过的图（数据源 = 全局 floors 聚合 + 出图历史），
 *     支持按角色卡分类；出图位被正文重建清掉的图，只要历史流水里还有也能看。
 *
 * 共有能力：
 *   - 搜索（提示词 / 楼层 / 角色卡 / 聊天ID）；
 *   - 展示缩放（比例 + 大小，仿角色档案页，localStorage 记忆）；
 *   - 智能批量选择：全选本视图 / 反选 / Shift 点击范围选；
 *   - 破图自动检测 + 一键清理（地址失效的图打标记，点一下全清）；
 *   - 灯箱 ←/→ 连翻整个当前视图，右侧出图参数面板。
 */

import {
  listChatImages, listAllImages, listHistory, listCharsWithImages, listVersionHistory,
  removeResultImage, removeResultImageChat, removeHistoryByUrls,
} from '../store.js';
import { deleteImage, downloadImage } from '../archive.js';
import { openPreview } from '../render.js';
import { getChatId } from '../st.js';
import { info, warn, STAGE } from '../log.js';

/** 面板内部状态（面板存活期间有效；跨视图记忆关键字与缩放）。 */
const state = {
  view: 'chat',        // 'chat' | 'history'
  selecting: false,
  picked: new Set(),
  lastPickedIdx: -1,   // Shift 范围选锚点
  keyword: '',
  floor: '',
  scope: 'all',        // 历史视图范围：'all' | 'chat'（本聊天）| 'char:角色卡名'
  broken: new Set(),   // 加载失败的 key
};

/* ---- 展示缩放（仿角色档案页：比例 + 大小，localStorage 记忆） ---- */
const SIZE_KEY = 'hl_gal_card_w';
const AR_KEY = 'hl_gal_card_ar';
const AR_MIGRATED_KEY = 'hl_gal_card_ar_v98';
const SIZES = [
  /**
   * ★ v0.9.98：默认改成「适应原图」。
   *   固定 2:3 竖框 + object-fit:cover ⇒ 横向漫画宫格只显示中间一条（用户原话
   *   「滑动后图放大了，图库里很多图莫名放大和丢失」—— 不是图丢了，是被裁掉了）。
   *   想要整齐的网格仍可手动选竖图/横图，那时才是裁切铺满。
   */
  { v: 'auto', label: '适应原图（不裁切）' },
  { v: '2/3', label: '竖图 2:3（裁切铺满）' },
  { v: '3/4', label: '竖图 3:4' },
  { v: '1/1', label: '方图 1:1' },
  { v: '4/3', label: '横图 4:3' },
  { v: '16/9', label: '横图 16:9' },
];
function cardW() {
  try {
    const n = parseInt(localStorage.getItem(SIZE_KEY) || '', 10);
    if (Number.isFinite(n) && n >= 100 && n <= 360) return n;
  } catch { /* Node 侧无 localStorage */ }
  return 150;
}
function cardAr() {
  try {
    // v0.9.98 一次性迁移：旧代码默认 '2/3'（竖框 + cover），横向漫画宫格会被裁成
    // 中间一条。老存档 localStorage 里存着 '2/3' 的用户升级后依然看不到变化
    // （选项换了、记忆还是旧的），所以升级后第一次读就把它改回 'auto'。
    // 用户之后手动选回 2/3 不会被再次改写（marker 已落盘）。
    if (!localStorage.getItem(AR_MIGRATED_KEY)) {
      localStorage.setItem(AR_MIGRATED_KEY, '1');
      if ((localStorage.getItem(AR_KEY) || '') === '2/3') localStorage.setItem(AR_KEY, 'auto');
    }
    const v = localStorage.getItem(AR_KEY) || '';
    if (SIZES.some(s => s.v === v)) return v;
  } catch { /* ignore */ }
  return 'auto';
}

/** 这张图在服务器上的文件地址：历史流水条目只有 path（localUrl 是空串）。 */
function fileOf(it) {
  return it.localUrl || it.path || it.url || '';
}
function applyCardVars(host) {
  const grid = host.querySelector('#hl-gal-grid');
  if (!grid) return;
  grid.style.setProperty('--hl-gal-w', `${cardW()}px`);
  grid.style.setProperty('--hl-gal-ar', cardAr());
}

function fmtTime(ts) {
  if (!ts) return '';
  try {
    const d = new Date(ts);
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  } catch {
    return '';
  }
}

function keyOf(item) {
  return `${item.chatId || ''}|${item.mesId}|${item.swipeId}|${item.position}|${item.url}`;
}

/** 灯箱画廊条目（render.openPreview 的 list 协议）+ 参数面板数据。 */
function galleryOf(items, paramsByUrl) {
  return items.map(it => ({
    url: it.url,
    // v0.9.98：历史流水条目 localUrl 是空串、只有 path —— 原来直接回落 it.url，
    // 「全部下载」会拿到临时地址（ComfyUI 一重启就是死链）。统一走 fileOf。
    downloadUrl: fileOf(it),
    prompt: it.prompt,
    nl: it.nl,
    position: `${it.position || ''}${it.mesId !== undefined ? ` #${it.mesId}` : ''}`,
    ts: it.at,
    params: paramsByUrl?.get(it.url) || null,
  }));
}

export async function mountGallery(host) {
  host.innerHTML = `
<div class="hl-section">
  <div class="hl-section-title">
    <div class="hl-gal-viewtabs">
      <button class="hl-btn hl-gal-viewtab on" data-view="chat" type="button">本聊天的图</button>
      <button class="hl-btn hl-gal-viewtab" data-view="history" type="button">历史生图</button>
    </div>
    <span class="hl-gal-total" id="hl-gal-total"></span>
  </div>
  <div class="hl-gallery-bar">
    <input type="search" id="hl-gal-search" class="hl-input hl-gal-search"
           placeholder="搜提示词 / 楼层号 / 角色卡…" />
    <select id="hl-gal-scope" class="hl-select hl-gal-scope" hidden></select>
    <select id="hl-gal-floor" class="hl-select hl-gal-floor"></select>
    <label class="hl-check hl-gallery-sel">
      <input type="checkbox" id="hl-gal-selecting" />
      <span>选择</span>
    </label>
    <button class="hl-btn hl-ghost hl-mini" id="hl-gal-pickall" hidden>全选</button>
    <button class="hl-btn hl-ghost hl-mini" id="hl-gal-invert" hidden>反选</button>
    <button class="hl-btn hl-ghost hl-mini" id="hl-gal-clearpick" hidden>清空</button>
    <button class="hl-btn hl-ghost hl-gal-broken" id="hl-gal-clean-broken" hidden>清理破图</button>
    <button class="hl-btn hl-ghost" id="hl-gal-refresh">刷新</button>
    <button class="hl-btn hl-ghost" id="hl-gal-download-all">全部下载</button>
    <button class="hl-btn hl-btn-danger" id="hl-gal-delete" disabled>删除选中</button>
  </div>
  <div class="hl-gal-zoombar">
    <span class="hl-gal-zoom-label">比例</span>
    <select id="hl-gal-ar" class="hl-select">
      ${SIZES.map(s => `<option value="${s.v}">${s.label}</option>`).join('')}
    </select>
    <span class="hl-gal-zoom-label">大小</span>
    <input type="range" id="hl-gal-size" class="hl-gal-size" min="100" max="360" step="10" />
    <span class="hl-gallery-count" id="hl-gal-count"></span>
  </div>
  <div class="hl-hint">
    点图进灯箱，<b>← / → 能连着翻整个当前视图</b>，右侧是这张图的出图参数。
    勾「选择」后：全选 / 反选 / Shift+点击范围选；加载失败（破图）会打上标记，可一键清理。
    删除会同时删掉图片文件，正文里的出图位保留，随时能重新生成。
  </div>
  <div class="hl-gallery-grid" id="hl-gal-grid"></div>
</div>`;

  const grid = host.querySelector('#hl-gal-grid');
  const countEl = host.querySelector('#hl-gal-count');
  const totalEl = host.querySelector('#hl-gal-total');
  const selBox = host.querySelector('#hl-gal-selecting');
  const delBtn = host.querySelector('#hl-gal-delete');
  const searchEl = host.querySelector('#hl-gal-search');
  const floorEl = host.querySelector('#hl-gal-floor');
  const scopeEl = host.querySelector('#hl-gal-scope');
  const arEl = host.querySelector('#hl-gal-ar');
  const sizeEl = host.querySelector('#hl-gal-size');
  const brokenBtn = host.querySelector('#hl-gal-clean-broken');
  const pickallBtn = host.querySelector('#hl-gal-pickall');
  const invertBtn = host.querySelector('#hl-gal-invert');
  const clearpickBtn = host.querySelector('#hl-gal-clearpick');

  let items = [];          // 当前视图全量
  let view = [];           // 筛选后的当前视图（灯箱连翻用这份）
  const brokenKeys = state.broken;

  /* ---- 缩放控件 ---- */
  arEl.value = cardAr();
  sizeEl.value = String(cardW());
  applyCardVars(host);
  arEl.addEventListener('change', () => {
    try { localStorage.setItem(AR_KEY, arEl.value); } catch { /* ignore */ }
    applyCardVars(host);
  });
  sizeEl.addEventListener('input', () => {
    const n = parseInt(sizeEl.value, 10);
    if (!Number.isFinite(n)) return;
    try { localStorage.setItem(SIZE_KEY, String(n)); } catch { /* ignore */ }
    applyCardVars(host);
  });

  /* ---- 视图切换 ---- */
  const viewTabs = Array.from(host.querySelectorAll('.hl-gal-viewtab'));
  viewTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      if (state.view === tab.dataset.view) return;
      state.view = tab.dataset.view;
      state.picked.clear();
      state.lastPickedIdx = -1;
      state.floor = '';
      viewTabs.forEach(t => t.classList.toggle('on', t === tab));
      paint();
    });
  });

  /* ---- 历史视图：范围下拉（所有聊天 / 本聊天 / 指定角色卡） ---- */
  function syncScopeOptions() {
    if (state.view !== 'history') { scopeEl.hidden = true; return; }
    const chars = listCharsWithImages();
    scopeEl.replaceChildren();
    const mk = (v, label) => {
      const o = document.createElement('option');
      o.value = v; o.textContent = label;
      scopeEl.appendChild(o);
    };
    mk('all', `所有聊天`);
    mk('chat', `本聊天（${getChatId().slice(0, 12)}…）`);
    for (const c of chars) mk(`char:${c}`, `角色卡：${c}`);
    if (!Array.from(scopeEl.options).some(o => o.value === state.scope)) state.scope = 'all';
    scopeEl.value = state.scope;
    scopeEl.hidden = false;
  }
  scopeEl.addEventListener('change', () => {
    state.scope = scopeEl.value;
    paint();
  });

  /* ---- 搜索 / 楼层 ---- */
  let timer = null;
  searchEl.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      state.keyword = searchEl.value.trim();
      paint();
    }, 200);
  });

  floorEl.addEventListener('change', () => {
    state.floor = floorEl.value;
    paint();
  });

  /* ---- 计数与按钮状态 ---- */
  function syncCount() {
    const total = view.length;
    const brokenN = view.filter(it => brokenKeys.has(keyOf(it))).length;
    const archivedN = state.view === 'chat' ? view.filter(i => i.archived).length : 0;
    countEl.textContent = total
      ? `${total} 张`
        + (archivedN || state.view === 'chat' ? ` · 已归档 ${archivedN} 张` : '')
        + (brokenN ? ` · 破图 ${brokenN}` : '')
        + (total !== items.length ? `（共 ${items.length} 张）` : '')
      : '';
    totalEl.textContent = state.view === 'history'
      ? `所有聊天生成过的图 · ${items.length} 张`
      : '';
    delBtn.disabled = state.picked.size === 0;
    delBtn.textContent = state.picked.size ? `删除选中（${state.picked.size}）` : '删除选中';
    brokenBtn.hidden = !brokenN;
    brokenBtn.textContent = `清理破图（${brokenN}）`;
    const batch = state.selecting;
    pickallBtn.hidden = !batch;
    invertBtn.hidden = !batch;
    clearpickBtn.hidden = !batch;
  }

  function syncFloorOptions() {
    if (state.view !== 'chat') { floorEl.hidden = true; return; }
    floorEl.hidden = false;
    const floors = Array.from(new Set(items.map(i => String(i.mesId)))).sort((a, b) => Number(a) - Number(b));
    const cur = state.floor;
    floorEl.replaceChildren();
    const optAll = document.createElement('option');
    optAll.value = '';
    optAll.textContent = `全部楼层（${floors.length}）`;
    floorEl.appendChild(optAll);
    for (const f of floors) {
      const o = document.createElement('option');
      o.value = f;
      o.textContent = `楼层 #${f}`;
      floorEl.appendChild(o);
    }
    if (cur && floors.includes(cur)) floorEl.value = cur;
    else { state.floor = ''; floorEl.value = ''; }
  }

  function filtered() {
    const kw = state.keyword.toLowerCase();
    return items.filter((it) => {
      if (state.view === 'chat' && state.floor && String(it.mesId) !== state.floor) return false;
      if (state.view === 'history') {
        if (state.scope === 'chat' && it.chatId !== getChatId()) return false;
        if (state.scope.startsWith('char:') && it.charName !== state.scope.slice(5)) return false;
      }
      if (!kw) return true;
      return [it.prompt, it.nl, it.position, String(it.mesId), it.charName, it.chatId]
        .some(s => String(s || '').toLowerCase().includes(kw));
    });
  }

  /** 数据源：本聊天 = floors；历史 = 全局聚合 + 仅存在于历史流水的图。 */
  function loadData() {
    /**
     * ★ v0.9.52：两个视图都要并上**旧版本图**（`results[].history[]`）。
     *
     * 此前图库只读"每个出图位最后一次生成的那张"，重生成时被换下来的旧图
     * 在灯箱里能左右翻到、在图库里却一张都没有 —— 用户原话：
     * 「只显示最后生成的灯箱里的图？历史的呢？以前还有，怎么都没了」。
     * 那些文件一直躺在磁盘上（已归档），缺的只是有人去读。
     *
     * 去重：URL 已经在现任里就跳过（现任优先，避免同一张图出现两条）。
     */
    const mergeOldVersions = (list, { chatOnly = false } = {}) => {
      const seen = new Set(list.map(it => it.url).filter(Boolean));
      const curChat = getChatId();
      const olds = listVersionHistory().filter(v =>
        v.url && !seen.has(v.url) && (!chatOnly || v.chatId === curChat));
      return list.concat(olds).sort((a, b) => (b.at - a.at) || (b.mesId - a.mesId));
    };

    if (state.view === 'chat') {
      const cur = listChatImages().map(it => ({ ...it, chatId: getChatId() }));
      items = mergeOldVersions(cur, { chatOnly: true });
      return;
    }
    const all = listAllImages();
    const seen = new Set(all.map(it => it.url));
    // 历史流水里有、出图位已被清理的图：URL 可能已失效，显示出来让用户自己清理
    const extra = listHistory()
      .filter(h => h.url && !seen.has(h.url))
      .map(h => ({
        chatId: h.chatId || '',
        charName: h.charName || '',
        mesId: h.mesId || -1,
        swipeId: 0,
        position: h.position || '',
        prompt: h.prompt || '',
        nl: h.nl || '',
        url: h.url,
        localUrl: '',
        path: h.path || '',
        at: h.at || 0,
        archived: !!h.path,
        historyOnly: true,
      }));
    items = mergeOldVersions([...all, ...extra]);
  }

  /** URL → 出图参数（新图有完整记录；旧图为 null → 面板显示占位说明）。 */
  function paramsMap() {
    const m = new Map();
    for (const h of listHistory()) if (h.url) m.set(h.url, h);
    return m;
  }

  function paint() {
    loadData();
    syncScopeOptions();
    syncFloorOptions();
    view = filtered();

    // 清掉已不存在的勾选与破图标记
    const alive = new Set(items.map(keyOf));
    for (const k of Array.from(state.picked)) if (!alive.has(k)) state.picked.delete(k);
    for (const k of Array.from(brokenKeys)) if (!alive.has(k)) brokenKeys.delete(k);

    grid.replaceChildren();
    if (!view.length) {
      const empty = document.createElement('div');
      empty.className = 'hl-hint';
      empty.textContent = items.length ? '没有符合筛选条件的图。' : (state.view === 'chat' ? '这个聊天还没有出过图。' : '还没有任何生图记录。');
      grid.appendChild(empty);
      syncCount();
      return;
    }

    const paramsByUrl = paramsMap();
    const gal = galleryOf(view, paramsByUrl);

    for (let i = 0; i < view.length; i += 1) {
      const it = view[i];
      const k = keyOf(it);
      const card = document.createElement('div');
      card.className = `hl-gal-card${state.picked.has(k) ? ' hl-gal-picked' : ''}${brokenKeys.has(k) ? ' hl-gal-broken-card' : ''}`;
      const src = [it.charName, it.mesId >= 0 ? `楼层 #${it.mesId}` : '历史'].filter(Boolean).join(' · ');
      card.title = `${it.position || ''} · ${src} · ${fmtTime(it.at)}${it.archived ? '' : ' · 临时地址'}\n${String(it.prompt || '').slice(0, 200)}`;

      const im = document.createElement('img');
      im.className = 'hl-gal-img';
      im.loading = 'lazy';
      im.decoding = 'async';
      im.src = it.url;
      im.alt = `绘灵 ${it.position}`;
      // 破图检测：地址失效（ComfyUI 重启 / 归档被删）的图打标记
      im.addEventListener('error', () => {
        if (brokenKeys.has(k)) return;
        brokenKeys.add(k);
        card.classList.add('hl-gal-broken-card');
        card.title = `⚠ 这张图加载失败（地址失效）：${card.title}`;
        syncCount();
      });
      im.addEventListener('load', () => {
        if (!brokenKeys.has(k)) return;
        brokenKeys.delete(k);
        card.classList.remove('hl-gal-broken-card');
        syncCount();
      });
      card.appendChild(im);

      const tag = document.createElement('span');
      tag.className = 'hl-gal-tag';
      tag.textContent = state.view === 'history'
        ? `${it.position || '历史'}${it.charName ? ` · ${it.charName}` : ''}`
        : `${it.position} · #${it.mesId}`;
      card.appendChild(tag);

      // v0.9.52：旧版本角标 —— 同一个出图位被重新生成后换下来的那一版
      // （此前这些图只在灯箱里能翻到，图库里完全看不到，用户以为"没了"）
      if (it.oldVersion) {
        const oldDot = document.createElement('span');
        oldDot.className = 'hl-gal-old';
        oldDot.textContent = '旧版本';
        oldDot.title = '这个出图位被重新生成过，这是被换下来的旧图（当前的图不带这个角标）';
        card.appendChild(oldDot);
      }

      if (!it.archived) {
        const warnDot = document.createElement('span');
        warnDot.className = 'hl-gal-warn';
        warnDot.textContent = '临时';
        warnDot.title = '这张图还没归档到酒馆，重启 ComfyUI 后可能失效';
        card.appendChild(warnDot);
      }

      card.addEventListener('click', (e) => {
        e.stopPropagation();
        if (state.selecting) {
          // Shift + 点击：从上次点到这次，范围选
          if (e.shiftKey && state.lastPickedIdx >= 0) {
            const [a, b] = [Math.min(state.lastPickedIdx, i), Math.max(state.lastPickedIdx, i)];
            for (let j = a; j <= b; j += 1) state.picked.add(keyOf(view[j]));
          } else if (state.picked.has(k)) {
            state.picked.delete(k);
          } else {
            state.picked.add(k);
          }
          state.lastPickedIdx = i;
          grid.querySelectorAll('.hl-gal-card').forEach((c, j) => {
            c.classList.toggle('hl-gal-picked', state.picked.has(keyOf(view[j])));
          });
          syncCount();
          return;
        }
        // 关键体验：把筛选后的整个视图传进灯箱 —— ←/→ 连着翻全库
        openPreview(it.url, { list: gal, index: i, showSide: true });
      });

      grid.appendChild(card);
    }

    syncCount();
  }

  /* ---- 批量选择增强 ---- */
  selBox.addEventListener('change', () => {
    state.selecting = selBox.checked;
    state.picked.clear();
    state.lastPickedIdx = -1;
    grid.classList.toggle('hl-gal-selecting', state.selecting);
    paint();
  });

  pickallBtn.addEventListener('click', () => {
    for (const it of view) state.picked.add(keyOf(it));
    paint();
  });
  invertBtn.addEventListener('click', () => {
    for (const it of view) {
      const k = keyOf(it);
      if (state.picked.has(k)) state.picked.delete(k);
      else state.picked.add(k);
    }
    paint();
  });
  clearpickBtn.addEventListener('click', () => {
    state.picked.clear();
    state.lastPickedIdx = -1;
    paint();
  });

  host.querySelector('#hl-gal-refresh').addEventListener('click', () => {
    paint();
    info(STAGE.UI, `图库已刷新：当前视图 ${items.length} 张`);
  });

  host.querySelector('#hl-gal-download-all').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    const target = view.length ? view : items;
    if (!target.length) return;
    btn.disabled = true;
    const before = btn.textContent;
    let n = 0;
    for (let i = 0; i < target.length; i += 1) {
      const it = target[i];
      btn.textContent = `下载中… ${i + 1}/${target.length}`;
      if (downloadImage(fileOf(it), `绘灵_${it.position}_${it.mesId}_${i + 1}.png`)) n += 1;
      // 浏览器对连续下载有节流，隔一下更稳
      await new Promise(r => setTimeout(r, 180));
    }
    btn.disabled = false;
    btn.textContent = before;
    info(STAGE.UI, `图库：已请求下载 ${n}/${target.length} 张`);
  });

  /* ---- 删除：本聊天 / 历史通用；历史跨聊天要按 chatId 删记录 ---- */
  async function deletePicked(picked) {
    const hasFile = picked.filter(p => p.path || p.localUrl).length;
    const yes = typeof globalThis.confirm === 'function'
      ? globalThis.confirm(
        `删除选中的 ${picked.length} 张图？\n`
        + `其中 ${hasFile} 张会同时删掉服务器上的文件（不可恢复）。\n`
        + '正文里的出图位会保留，可以重新生成。',
      )
      : true;
    if (!yes) return;

    delBtn.disabled = true;
    let ok = 0;
    const deadUrls = [];
    for (const it of picked) {
      const path = it.path || it.localUrl;
      if (path) {
        try {
          await deleteImage(path);
          ok += 1;
        } catch (err) {
          // 历史图/破图的文件可能已失效，删失败不阻断记录清理
          warn(STAGE.UI, `删除文件失败（${it.position}）：${err?.message || err}`);
        }
      }
      try {
        if (state.view === 'chat') removeResultImage(it.mesId, it.swipeId, it.position, it.url);
        else removeResultImageChat(it.chatId, it.mesId, it.swipeId, it.position, it.url);
      } catch (err) {
        warn(STAGE.UI, `清理记录失败（${it.position}）：${err?.message || err}`);
      }
      deadUrls.push(it.url);
    }
    try { removeHistoryByUrls(deadUrls); } catch { /* 历史流水清理失败不阻断 */ }
    state.picked.clear();
    paint();   // paint 里会按 alive 集合清掉对应的勾选与破图标记
    info(STAGE.UI, `图库：已删除 ${picked.length} 张（服务器文件 ${ok} 个）`);
  }

  delBtn.addEventListener('click', async () => {
    const picked = items.filter(it => state.picked.has(keyOf(it)));
    if (!picked.length) return;
    await deletePicked(picked);
  });

  /* ---- 破图一键清理：加载失败的全部删掉（文件多半已没了，主要是清记录） ---- */
  brokenBtn.addEventListener('click', async () => {
    const broken = view.filter(it => brokenKeys.has(keyOf(it)));
    if (!broken.length) return;
    const yes = typeof globalThis.confirm === 'function'
      ? globalThis.confirm(`清理 ${broken.length} 张加载失败的图？\n它们的文件已经失效，删除只清理记录和残留文件。`)
      : true;
    if (!yes) return;
    state.picked.clear();
    await deletePicked(broken);
  });

  paint();
  info(STAGE.UI, `图库面板已挂载（${state.view === 'history' ? '历史生图' : getChatId()}）`);
}
