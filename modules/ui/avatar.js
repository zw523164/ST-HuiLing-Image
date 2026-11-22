/**
 * 绘灵 · 角色头像（选图 + 裁剪）
 *
 * 三条来源，最后都汇到同一个裁剪器：
 *   ① 本聊天已经出过的图 —— 从存档里捞，不用再去找文件（最省事的一条）
 *   ② 本地上传（png/jpg/webp…）
 *   ③ 图片地址（外链）
 *
 * ── 为什么先转 dataURL 再裁剪 ──────────────────────────────
 * 出过的图里有一部分还是 ComfyUI 的临时 /view 地址（跨域）。
 * 直接把跨域 <img> 画进 canvas 会把画布"污染"，toDataURL 直接抛错 ——
 * 所以统一 fetch → blob → dataURL，画布只吃同源数据，稳。
 * 头像最终存进档案的是裁剪压缩后的小图（≤768px），跟着导出/导入一起走。
 */

import { listChatImages } from '../store.js';
import { fitContain, mapCropRect, cropOutputSize, escapeHtml, hash32 } from '../util.js';
import { info, warn, debug, STAGE } from '../log.js';

/** 头像输出的最大边长。768 = 高清（v0.9.10，展示最大 720px 也不糊），一张 JPEG 约 100~200KB。 */
export const AVATAR_MAX = 768;

/* ============ 模态壳 ============ */

function makeModal(title, width = 760, onClose = null) {
  const back = document.createElement('div');
  back.className = 'hl-modal-back';
  back.innerHTML = `
    <div class="hl-modal" style="max-width:${width}px">
      <div class="hl-modal-head">
        <b>${escapeHtml(title)}</b>
        <span class="hl-spacer"></span>
        <button class="hl-btn hl-mini hl-ghost hl-modal-x" type="button">✕</button>
      </div>
      <div class="hl-modal-body"></div>
    </div>`;
  document.body.appendChild(back);

  // onClose 是给调用方收尾用的（解绑 window 监听、把挂起的 Promise 落地）。
  // 少了它，按 ESC / 点遮罩关闭时 Promise 永远不会 resolve —— 调用方会一直 await。
  const close = () => {
    try { onClose?.(); } catch { /* 收尾失败也要把模态关掉 */ }
    back.remove();
  };
  back.querySelector('.hl-modal-x').addEventListener('click', close);
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
  document.addEventListener('keydown', function esc(e) {
    if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); }
  });

  return { back, body: back.querySelector('.hl-modal-body'), close };
}

/** 远程/本地地址 → dataURL。失败返回 null（调用方给出人话提示）。 */
async function urlToDataUrl(url) {
  if (!url) return null;
  if (String(url).startsWith('data:')) return String(url);
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const blob = await res.blob();
    return await blobToDataUrl(blob);
  } catch (err) {
    debug(STAGE.UI, `取图失败（${url.slice(0, 60)}）：${err?.message || err}`);
    return null;
  }
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    try {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result || ''));
      fr.onerror = () => reject(new Error('读取文件失败'));
      fr.readAsDataURL(blob);
    } catch (err) { reject(err); }
  });
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result || ''));
    fr.onerror = () => reject(new Error('读取文件失败'));
    fr.readAsDataURL(file);
  });
}

/* ============ ① 选图器 ============ */

/**
 * 打开选图器：本聊天的图 / 本地上传 / 图片地址。
 * @param {{title?:string}} [opts]
 * @returns {Promise<string|null>} 原始图 dataURL（未裁剪）；取消返回 null
 */
export function pickAvatarImage(opts = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; resolve(v || null); modal.close(); };

    const modal = makeModal(opts.title || '选一张图当角色形象', 780, () => resolve(null));
    const imgs = listChatImages();

    modal.body.innerHTML = `
      <div class="hl-crop-tabs">
        <button class="hl-btn hl-mini hl-crop-tab active" data-tab="chat" type="button">本聊天出过的图（${imgs.length}）</button>
        <button class="hl-btn hl-mini hl-ghost hl-crop-tab" data-tab="file" type="button">上传本地图片</button>
        <button class="hl-btn hl-mini hl-ghost hl-crop-tab" data-tab="url" type="button">图片地址</button>
      </div>

      <div class="hl-crop-pane" data-pane="chat">
        <input class="hl-input" id="hl-av-search" placeholder="搜提示词 / 楼层号…" />
        <div class="hl-pick-grid" id="hl-av-grid"></div>
      </div>

      <div class="hl-crop-pane" data-pane="file" hidden>
        <div class="hl-hint">选一张本地图片（png / jpg / webp / gif）。选完直接进裁剪。</div>
        <button class="hl-btn" id="hl-av-file" type="button">选择图片文件…</button>
      </div>

      <div class="hl-crop-pane" data-pane="url" hidden>
        <div class="hl-hint">贴一个图片直链。跨域取不到的话，用「上传本地图片」更稳。</div>
        <div class="hl-inline">
          <input class="hl-input" id="hl-av-url" placeholder="https://…/xxx.png" />
          <button class="hl-btn" id="hl-av-url-go" type="button">取图</button>
        </div>
      </div>

      <div class="hl-status" id="hl-av-status"></div>`;

    const status = modal.body.querySelector('#hl-av-status');
    const setStatus = (m, isErr) => { status.textContent = m; status.classList.toggle('hl-err', !!isErr); };

    modal.body.querySelectorAll('.hl-crop-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        modal.body.querySelectorAll('.hl-crop-tab').forEach(b => {
          b.classList.toggle('active', b === btn);
          b.classList.toggle('hl-ghost', b !== btn);
        });
        modal.body.querySelectorAll('.hl-crop-pane').forEach(p => {
          if (p.dataset.pane === btn.dataset.tab) p.removeAttribute('hidden');
          else p.setAttribute('hidden', '');
        });
      });
    });

    /* --- 本聊天的图 --- */
    const grid = modal.body.querySelector('#hl-av-grid');
    const paint = (kw) => {
      const list = !kw ? imgs : imgs.filter(it => [it.prompt, it.nl, it.position, String(it.mesId)]
        .some(s => String(s || '').toLowerCase().includes(kw)));
      grid.replaceChildren();
      if (!list.length) {
        const empty = document.createElement('div');
        empty.className = 'hl-hint';
        empty.textContent = imgs.length ? '没有匹配的图。' : '这个聊天还没出过图 —— 用「上传本地图片」。';
        grid.appendChild(empty);
        return;
      }
      for (const it of list) {
        const cell = document.createElement('div');
        cell.className = 'hl-pick-cell';
        cell.title = `${it.position} · 楼层 #${it.mesId}\n${String(it.prompt || '').slice(0, 160)}`;
        const im = document.createElement('img');
        im.loading = 'lazy';
        im.decoding = 'async';
        im.src = it.url;
        im.alt = it.position || '绘灵图';
        cell.appendChild(im);
        const tag = document.createElement('span');
        tag.className = 'hl-pick-tag';
        tag.textContent = `${it.position} · #${it.mesId}`;
        cell.appendChild(tag);
        cell.addEventListener('click', async () => {
          setStatus('正在取图…');
          // 归档过的优先用本地地址（同源，一定能取到）
          const data = await urlToDataUrl(it.localUrl || it.url) || await urlToDataUrl(it.url);
          if (!data) { setStatus('这张图取不到（可能是 ComfyUI 临时地址已失效），换一张或改用本地上传', true); return; }
          finish(data);
        });
        grid.appendChild(cell);
      }
    };
    paint('');
    let t = null;
    modal.body.querySelector('#hl-av-search').addEventListener('input', (e) => {
      clearTimeout(t);
      const v = e.target.value.trim().toLowerCase();
      t = setTimeout(() => paint(v), 180);
    });

    /* --- 本地文件 --- */
    modal.body.querySelector('#hl-av-file').addEventListener('click', () => {
      const inp = document.createElement('input');
      inp.type = 'file';
      inp.accept = 'image/*';
      inp.addEventListener('change', async () => {
        const f = inp.files?.[0];
        if (!f) return;
        try {
          const data = await readFileAsDataUrl(f);
          if (data) finish(data);
          else setStatus('读取失败', true);
        } catch (err) {
          setStatus(`读取失败：${err?.message || err}`, true);
        }
      });
      inp.click();
    });

    /* --- 图片地址 --- */
    modal.body.querySelector('#hl-av-url-go').addEventListener('click', async () => {
      const u = modal.body.querySelector('#hl-av-url').value.trim();
      if (!u) { setStatus('先填地址', true); return; }
      setStatus('正在取图…');
      const data = await urlToDataUrl(u);
      if (!data) { setStatus('取不到这张图（跨域或地址失效）。改「上传本地图片」吧', true); return; }
      finish(data);
    });

  });
}

/* ============ ② 裁剪器 ============ */

const RATIOS = [
  { key: '1:1', label: '方形 1:1', f: null },
  { key: '3:4', label: '竖版 3:4', f: 3 / 4 },
  { key: 'free', label: '自由', f: 0 },
];

/**
 * 打开裁剪器。
 * @param {string} srcDataUrl 原始图
 * @param {{title?:string}} [opts]
 * @returns {Promise<string|null>} 裁剪后的 dataURL；取消返回 null
 */
export function cropImage(srcDataUrl, opts = {}) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (done) return; done = true; resolve(v || null); modal.close(); };

    const modal = makeModal(opts.title || '裁剪头像（拖框移动 · 拖角缩放）', 780, () => {
      // 关闭（✕ / ESC / 点遮罩）时收尾：解绑 window 监听 + 把 Promise 落地
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      resolve(null);
    });
    modal.body.innerHTML = `
      <div class="hl-crop-stage" id="hl-crop-stage">
        <img class="hl-crop-img" id="hl-crop-img" alt="待裁剪" />
        <div class="hl-crop-box" id="hl-crop-box">
          <span class="hl-crop-handle" data-corner="nw"></span>
          <span class="hl-crop-handle" data-corner="ne"></span>
          <span class="hl-crop-handle" data-corner="sw"></span>
          <span class="hl-crop-handle hl-crop-handle-se" data-corner="se"></span>
        </div>
      </div>
      <div class="hl-crop-bar">
        ${RATIOS.map((r, i) => `<button class="hl-btn hl-mini${i === 0 ? '' : ' hl-ghost'} hl-crop-ratio${i === 0 ? ' active' : ''}" data-ratio="${r.key}" type="button">${r.label}</button>`).join('')}
        <button class="hl-btn hl-mini hl-ghost hl-crop-reset" type="button">重置选框</button>
        <span class="hl-spacer"></span>
        <span class="hl-crop-size" id="hl-crop-size"></span>
        <button class="hl-btn hl-ghost hl-mini" id="hl-crop-cancel" type="button">取消</button>
        <button class="hl-btn hl-mini" id="hl-crop-ok" type="button">用这张</button>
      </div>
      <div class="hl-hint">框里的内容就是卡片上显示的样子。滚轮也能缩放选框。</div>`;

    const stage = modal.body.querySelector('#hl-crop-stage');
    const imgEl = modal.body.querySelector('#hl-crop-img');
    const boxEl = modal.body.querySelector('#hl-crop-box');
    const sizeEl = modal.body.querySelector('#hl-crop-size');

    /** 图片在舞台里的显示矩形（px），含居中留白。 */
    let disp = { ox: 0, oy: 0, dw: 1, dh: 1 };
    /** 裁剪框，相对显示矩形的比例。 */
    let crop = { x: 0.1, y: 0.1, w: 0.8, h: 0.8 };
    let ratio = '1:1';
    let natural = { w: 1, h: 1 };

    function layout() {
      const box = stage.getBoundingClientRect();
      const f = fitContain(natural.w, natural.h, box.width || 600, box.height || 380);
      disp = { ox: f.ox, oy: f.oy, dw: f.dw, dh: f.dh };
      imgEl.style.left = `${f.ox}px`;
      imgEl.style.top = `${f.oy}px`;
      imgEl.style.width = `${f.dw}px`;
      imgEl.style.height = `${f.dh}px`;
      syncBox();
    }

    function syncBox() {
      boxEl.style.left = `${disp.ox + crop.x * disp.dw}px`;
      boxEl.style.top = `${disp.oy + crop.y * disp.dh}px`;
      boxEl.style.width = `${crop.w * disp.dw}px`;
      boxEl.style.height = `${crop.h * disp.dh}px`;
      const r = mapCropRect(crop, natural.w, natural.h);
      const out = cropOutputSize(r.sw, r.sh, AVATAR_MAX);
      sizeEl.textContent = `裁出 ${out.w}×${out.h}`;
    }

    /** 按当前比例约束选框尺寸（以宽为准反推高）。 */
    function applyRatio(srcCrop) {
      const R = RATIOS.find(r => r.key === ratio);
      if (!R || !R.f) return srcCrop;
      const targetDisplayRatio = R.f;              // 宽/高（显示像素）
      const h = (srcCrop.w * disp.dw) / targetDisplayRatio / disp.dh;
      return { ...srcCrop, h: Math.min(1, Math.max(0.05, h)) };
    }

    function resetCrop() {
      const side = Math.min(disp.dw, disp.dh) * 0.8;
      let c = { w: side / disp.dw, h: side / disp.dh };
      c = applyRatio(c);
      crop = {
        x: (1 - c.w) / 2,
        y: (1 - c.h) / 2,
        w: c.w,
        h: c.h,
      };
      syncBox();
    }

    imgEl.addEventListener('load', () => {
      natural = { w: imgEl.naturalWidth || 1, h: imgEl.naturalHeight || 1 };
      layout();
      resetCrop();
    });
    imgEl.src = srcDataUrl;

    /* --- 拖动：移动 / 缩放 --- */
    let drag = null;
    boxEl.addEventListener('pointerdown', (e) => {
      if (e.target.classList.contains('hl-crop-handle')) return;
      drag = { mode: 'move', px: e.clientX, py: e.clientY, crop: { ...crop } };
      boxEl.setPointerCapture?.(e.pointerId);
      e.preventDefault();
    });
    boxEl.querySelectorAll('.hl-crop-handle').forEach(h => {
      h.addEventListener('pointerdown', (e) => {
        drag = { mode: h.dataset.corner, px: e.clientX, py: e.clientY, crop: { ...crop } };
        h.setPointerCapture?.(e.pointerId);
        e.stopPropagation();
        e.preventDefault();
      });
    });

    const onMove = (e) => {
      if (!drag) return;
      const dx = (e.clientX - drag.px) / disp.dw;
      const dy = (e.clientY - drag.py) / disp.dh;
      const c0 = drag.crop;
      if (drag.mode === 'move') {
        crop = {
          ...c0,
          x: Math.min(1 - c0.w, Math.max(0, c0.x + dx)),
          y: Math.min(1 - c0.h, Math.max(0, c0.y + dy)),
        };
      } else if (drag.mode === 'se') {
        let w = Math.min(1 - c0.x, Math.max(0.05, c0.w + dx));
        let hh = Math.min(1 - c0.y, Math.max(0.05, c0.h + dy));
        let c = { x: c0.x, y: c0.y, w, h: hh };
        const R = RATIOS.find(r => r.key === ratio);
        if (R?.f) {
          // 锁定比例：取变化量大的那个方向为准
          if (Math.abs(dx) >= Math.abs(dy)) c = { ...c, h: (w * disp.dw) / R.f / disp.dh };
          else c = { ...c, w: (hh * disp.dh) * R.f / disp.dw };
          c.w = Math.min(1 - c0.x, Math.max(0.05, c.w));
          c.h = Math.min(1 - c0.y, Math.max(0.05, c.h));
        }
        crop = c;
      } else {
        // 其余三个角：以对角为锚点
        const right = c0.x + c0.w;
        const bottom = c0.y + c0.h;
        let x = c0.x, y = c0.y, w = c0.w, h = c0.h;
        if (drag.mode === 'nw') { x = Math.min(right - 0.05, Math.max(0, c0.x + dx)); y = Math.min(bottom - 0.05, Math.max(0, c0.y + dy)); }
        if (drag.mode === 'ne') { y = Math.min(bottom - 0.05, Math.max(0, c0.y + dy)); w = Math.min(1 - x, Math.max(0.05, c0.w + dx)); }
        if (drag.mode === 'sw') { x = Math.min(right - 0.05, Math.max(0, c0.x + dx)); h = Math.min(1 - y, Math.max(0.05, c0.h + dy)); }
        if (drag.mode === 'ne' || drag.mode === 'sw') {
          const R = RATIOS.find(r => r.key === ratio);
          if (R?.f) {
            if (drag.mode === 'ne') h = (w * disp.dw) / R.f / disp.dh;
            else w = (h * disp.dh) * R.f / disp.dw;
            w = Math.min(1 - x, Math.max(0.05, w));
            h = Math.min(1 - y, Math.max(0.05, h));
          }
        }
        crop = { x, y, w, h };
      }
      syncBox();
    };
    const onUp = () => { drag = null; };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);

    // 滚轮缩放选框（以中心为锚）
    stage.addEventListener('wheel', (e) => {
      e.preventDefault();
      const k = e.deltaY > 0 ? 0.94 : 1.06;
      const cx = crop.x + crop.w / 2;
      const cy = crop.y + crop.h / 2;
      let w = Math.min(1, Math.max(0.05, crop.w * k));
      let h = Math.min(1, Math.max(0.05, crop.h * k));
      crop = { x: Math.min(1 - w, Math.max(0, cx - w / 2)), y: Math.min(1 - h, Math.max(0, cy - h / 2)), w, h };
      syncBox();
    }, { passive: false });

    modal.body.querySelectorAll('.hl-crop-ratio').forEach(b => {
      b.addEventListener('click', () => {
        ratio = b.dataset.ratio;
        modal.body.querySelectorAll('.hl-crop-ratio').forEach(x => {
          x.classList.toggle('active', x === b);
          x.classList.toggle('hl-ghost', x !== b);
        });
        crop = applyRatio(crop);
        syncBox();
      });
    });
    modal.body.querySelector('.hl-crop-reset').addEventListener('click', resetCrop);
    modal.body.querySelector('#hl-crop-cancel').addEventListener('click', () => finish(null));

    modal.body.querySelector('#hl-crop-ok').addEventListener('click', () => {
      try {
        const r = mapCropRect(crop, natural.w, natural.h);
        const out = cropOutputSize(r.sw, r.sh, AVATAR_MAX);
        const cv = document.createElement('canvas');
        cv.width = out.w;
        cv.height = out.h;
        const ctx = cv.getContext('2d');
        ctx.fillStyle = '#fff';                       // JPEG 没有透明通道，先垫白底
        ctx.fillRect(0, 0, out.w, out.h);
        ctx.drawImage(imgEl, r.sx, r.sy, r.sw, r.sh, 0, 0, out.w, out.h);
        const data = cv.toDataURL('image/jpeg', 0.9);
        if (!data || data.length < 32) throw new Error('画布导出为空');
        info(STAGE.UI, `头像裁剪完成 ${out.w}×${out.h}（${Math.round(data.length / 1024)}KB）`);
        finish(data);
      } catch (err) {
        warn(STAGE.UI, `裁剪失败：${err?.message || err}`);
        finish(null);
      }
    });

    // 图片加载不出来（地址失效 / 非图片）时给个出口，别让用户对着空白框
    imgEl.addEventListener('error', () => {
      const s = document.createElement('div');
      s.className = 'hl-err';
      s.textContent = '这张图加载不出来，换一张吧。';
      modal.body.prepend(s);
    });
  });
}

/* ============ ③ 一步到位：选图 → 裁剪 ============ */

/**
 * 选一张图并裁剪成头像。
 * @param {{title?:string}} [opts]
 * @returns {Promise<string|null>} 裁剪后的 dataURL
 */
export async function makeAvatar(opts = {}) {
  const raw = await pickAvatarImage(opts);
  if (!raw) return null;
  return await cropImage(raw, opts);
}

/**
 * 对已有头像重新裁剪。
 * @param {string} currentDataUrl
 */
export async function recropAvatar(currentDataUrl) {
  if (!currentDataUrl) return await makeAvatar();
  return await cropImage(currentDataUrl, { title: '重新裁剪当前头像' });
}

/** 头像 dataURL 的短指纹（测试/日志用，不参与出图）。 */
export function avatarFingerprint(dataUrl) {
  return hash32(String(dataUrl || ''));
}
