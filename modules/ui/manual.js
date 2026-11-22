/**
 * 绘灵 · 手动生图页
 *
 * 存在的理由：**兜底**。自动通道靠事件驱动，偶尔会漏（扩展抢事件、生成被打断、
 * 自动分析当时关着、某楼失败 3 次后被停止重试）。这页让用户自己挑楼层、
 * 自己决定正文，按同一条管线（出词 → 生图 → 插回正文）跑一遍。
 *
 * 与自动通道（scanner.runFor）的差别：不看 autoRun、不看失败次数、不等正文稳定，
 * 人点了就是"现在、就这一楼、就这段正文"。
 */

import { getChat, getMessageText, getLastAiMesId } from '../st.js';
import { cleanBody, escapeHtml } from '../util.js';
import { runManualMany } from '../scanner.js';
import { getFloorRecord } from '../store.js';
import { info, warn, STAGE } from '../log.js';

/* ============ 纯函数（可单测） ============ */

/**
 * 解析楼层号写法："12" / "3,5,7" / "10-15" / "3, 7-9"。
 * 越界、非数字一律丢弃（不报错，避免手抖打错一个字母整页崩）。
 *
 * @param {string} spec
 * @param {number} maxIndex 当前聊天最大楼层号
 * @returns {number[]} 升序去重
 */
export function parseFloorSpec(spec, maxIndex = 0) {
  const out = new Set();
  const text = String(spec || '').trim();
  if (!text) return [];
  for (const part of text.split(/[,，;；\s]+/)) {
    const seg = part.trim();
    if (!seg) continue;
    const m = seg.match(/^(\d+)(?:\s*[-~]\s*(\d+))?$/);
    if (!m) continue;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    for (let i = lo; i <= hi && i <= maxIndex; i += 1) out.add(i);
  }
  return Array.from(out).sort((x, y) => x - y);
}

/**
 * v0.9.59：手动生图「正文 AI 指令优化」—— 纯函数（可单测）。
 *
 * ★ 用户场景（2026-10-01）：主模型会在正文里自作主张加服装/饰品，不手动清掉
 *   下一楼就照着延续，服装风格越滚越乱。所以这个指令块**自由度必须高**——
 *   这是剧情正文，不是提示词：指令说删服装就删服装、说删饰品就删饰品，
 *   system 里明确"不要保护原文"，和提示词优化器（锚点一字不许动）正好相反。
 *
 * @param {string} body 编辑框里的楼层正文
 * @param {string} ask 用户的自由指令（空 = 只做轻度润色）
 * @returns {Array<{role:string,content:string}>}
 */
export function buildManualAskMessages(body, ask) {
  const text = String(body || '');
  const instruction = String(ask || '').trim();
  const sys = [
    '你是小说正文编辑器。用户会给你一段楼层正文，你按指令直接改写这段正文。',
    '你的修改自由度很高：指令要求删什么就整句删掉（包括服装、饰品、外貌、动作描写的句子），要求改写、精简、补写都照做；',
    '指令没提到的内容尽量保持原样——人名、剧情走向、段落结构、叙述语气不要无故改动。',
    instruction
      ? '严格执行用户的修改指令；指令与原文已有内容冲突时，以指令为准（那是用户刚定的主意）。'
      : '用户没有给具体指令时，只做轻度润色：修病句和明显错字，不做任何内容增删。',
    '只输出修改后的正文全文本身，不要任何解释、前言、引号或代码块。',
  ].join('\n');
  const user = instruction
    ? `【修改指令】\n${instruction}\n\n【正文原文】\n${text}`
    : text;
  return [
    { role: 'system', content: sys },
    { role: 'user', content: user },
  ];
}

/**
 * 收集当前聊天每一楼的展示信息（用户楼层也列出来 —— 手动模式允许给它配图）。
 * @returns {Array<{mesId:number,isUser:boolean,chars:number,preview:string,tags:number,imgs:number}>}
 */
export function collectFloorRows() {
  const chat = getChat() || [];
  const rows = [];
  for (let i = 0; i < chat.length; i += 1) {
    const m = chat[i];
    if (!m) continue;
    const text = String(getMessageText(i) || '');
    const clean = cleanBody(text);
    // v0.9.24：连字符写法 <hl-image> 也要数进去（主模型常写成这样）
    const tags = (text.match(/<hl[_-]image/gi) || []).length;
    let imgs = 0;
    try {
      const rec = getFloorRecord(i, Number.isFinite(m.swipe_id) ? m.swipe_id : 0);
      imgs = (rec?.results || []).filter(r => Array.isArray(r.images) && r.images.length).length;
    } catch { imgs = 0; }
    rows.push({
      mesId: i,
      isUser: !!m.is_user,
      chars: clean.length,
      preview: clean.replace(/\s+/g, ' ').trim().slice(0, 56),
      tags,
      imgs,
    });
  }
  return rows;
}

/* ============ 页面 ============ */

const QUICK = [
  { key: 'last1', label: '最近 1 楼' },
  { key: 'last3', label: '最近 3 楼' },
  { key: 'last5', label: '最近 5 楼' },
  { key: 'all', label: '全部' },
  { key: 'none', label: '清空' },
  { key: 'invert', label: '反选' },
];

function shell() {
  return `
<div class="hl-section">
  <div class="hl-section-title">选择楼层</div>
  <div class="hl-hint hl-manual-lead">
    自动没触发时的兜底：挑楼层 → 手动跑一次完整流程（出词 → 生图 → 插回正文）。
    和自动流程完全一样，只是由你决定跑哪些楼、什么时候跑。
  </div>
  <div class="hl-actions hl-manual-quick">
    ${QUICK.map(q => `<button class="hl-btn hl-ghost" data-quick="${q.key}" type="button">${q.label}</button>`).join('')}
    <button class="hl-btn hl-ghost" id="hl-manual-refresh" type="button">刷新列表</button>
  </div>
  <div class="hl-manual-pick">
    <input id="hl-manual-spec" class="hl-input" type="text" placeholder="楼层号：12 或 3,5,7-9 或 10-15">
    <button class="hl-btn" id="hl-manual-spec-go" type="button">按号选</button>
  </div>
  <div class="hl-manual-list" id="hl-manual-list"></div>
  <div class="hl-hint" id="hl-manual-sel">已选 0 楼</div>
</div>

<div class="hl-section">
  <div class="hl-section-title">正文（可手动改）</div>
  <div class="hl-manual-modes">
    <label class="hl-check">
      <input type="radio" name="hl-manual-mode" value="origin" checked>
      <span>用楼层原正文</span>
    </label>
    <label class="hl-check">
      <input type="radio" name="hl-manual-mode" value="custom">
      <span>用我填的正文（写回该楼层）</span>
    </label>
  </div>
  <div class="hl-actions">
    <button class="hl-btn hl-ghost" id="hl-manual-fetch" type="button">⬇ 提取选中楼层正文</button>
    <button class="hl-btn hl-ghost" id="hl-manual-fetch-last" type="button">⬇ 提取最后一楼</button>
    <button class="hl-btn hl-ghost" id="hl-manual-clear" type="button">清空正文</button>
  </div>
  <textarea id="hl-manual-body" class="hl-textarea hl-manual-body" rows="7"
    placeholder="点上面「提取」把楼层正文抓到这里，然后随便改；改完选「用我填的正文」再开始。留空 + 原正文模式 = 直接跑。"></textarea>
  <div class="hl-edit-ask hl-manual-ask">
    <div class="hl-edit-label"><span>✨ AI 分析优化正文（把要改的点写成指令，AI 照着改这段正文）</span></div>
    <textarea id="hl-manual-ask" class="hl-edit-ask-ta" rows="2"
      placeholder="自由度很高，直接下指令。例：删掉正文里所有服装和首饰的描写，其余一字不动（防止这楼自加的服装延续污染下一楼）；也可以要求改写、精简、补写任何内容"></textarea>
    <div class="hl-actions hl-manual-ask-actions">
      <button class="hl-btn hl-ghost" id="hl-manual-ask-go" type="button">✨ AI 按指令优化正文</button>
      <span class="hl-hint">改完会自动切到「用我填的正文」；不填指令 = 只做轻度润色</span>
    </div>
  </div>
  <div class="hl-hint" id="hl-manual-body-hint">改过正文记得切到「用我填的正文」—— 否则填了也是白填（会跑原正文）。</div>
</div>

<div class="hl-section">
  <div class="hl-section-title">执行</div>
  <label class="hl-check hl-manual-force">
    <input type="checkbox" id="hl-manual-force">
    <span>强制重跑（忽略「本楼正在处理中」，直接接管）</span>
    <div class="hl-hint">自动通道正在跑这楼时，手动会被挡住 —— 勾上就能打断重来。旧任务不会立刻停，它跑完可能还会写一次正文。</div>
  </label>
  <label class="hl-check">
    <input type="checkbox" id="hl-manual-preview" checked>
    <span>生图前先弹预览（分析完停下来，看/改每段提示词、给 AI 下指令，确认后才出图）</span>
    <div class="hl-hint">批量跑多楼时每楼都会停一次 —— 不想被打断就取消勾选。</div>
  </label>
  <div class="hl-actions">
    <button class="hl-btn hl-btn-primary" id="hl-manual-run" type="button">▶ 开始（0 楼）</button>
    <button class="hl-btn hl-ghost" id="hl-manual-stop" type="button" disabled>■ 停止</button>
  </div>
  <div class="hl-manual-progress" id="hl-manual-progress"></div>
  <div class="hl-status" id="hl-manual-status"></div>
</div>`;
}

/** @param {HTMLElement} host */
export function mountManual(host) {
  if (!host) return null;
  host.innerHTML = shell();

  const listEl = host.querySelector('#hl-manual-list');
  const selEl = host.querySelector('#hl-manual-sel');
  const specEl = host.querySelector('#hl-manual-spec');
  const bodyEl = host.querySelector('#hl-manual-body');
  const progEl = host.querySelector('#hl-manual-progress');
  const statusEl = host.querySelector('#hl-manual-status');
  const runBtn = host.querySelector('#hl-manual-run');
  const stopBtn = host.querySelector('#hl-manual-stop');
  const hintEl = host.querySelector('#hl-manual-body-hint');

  const selected = new Set();
  let rows = [];
  let busy = false;
  let stopFlag = false;

  const setStatus = (msg, bad = false) => {
    if (!statusEl) return;
    statusEl.textContent = msg || '';
    statusEl.classList.toggle('hl-err', !!bad);
  };

  const mode = () => host.querySelector('input[name="hl-manual-mode"]:checked')?.value || 'origin';

  function renderList() {
    if (!listEl) return;
    rows = collectFloorRows();
    if (!rows.length) {
      listEl.innerHTML = '<div class="hl-hint">当前聊天没有楼层。</div>';
      return;
    }
    listEl.innerHTML = rows.slice().reverse().map(r => {
      const on = selected.has(r.mesId);
      const badge = r.isUser
        ? '<span class="hl-manual-badge hl-manual-badge-user">用户</span>'
        : (r.imgs ? `<span class="hl-manual-badge hl-manual-badge-done">已出图 ${r.imgs}</span>`
          : '<span class="hl-manual-badge">未出图</span>');
      return `
        <div class="hl-manual-row${on ? ' on' : ''}" data-id="${r.mesId}">
          <label class="hl-manual-cb">
            <input type="checkbox" data-pick="${r.mesId}" ${on ? 'checked' : ''}>
            <span class="hl-manual-id">#${r.mesId}</span>
          </label>
          ${badge}
          <span class="hl-manual-preview">${escapeHtml(r.preview || '（空）')}</span>
          <button class="hl-btn hl-ghost hl-manual-fetchone" data-fetch="${r.mesId}" type="button" title="把这一楼的正文抓到下面的编辑框">取</button>
        </div>`;
    }).join('');
  }

  function updateSel() {
    const n = selected.size;
    if (selEl) selEl.textContent = `已选 ${n} 楼${n ? `（${Array.from(selected).sort((a, b) => a - b).map(i => `#${i}`).join(' ')}）` : ''}`;
    if (runBtn) runBtn.textContent = busy ? '⏳ 运行中…' : `▶ 开始（${n} 楼）`;
    const custom = mode() === 'custom';
    if (hintEl) {
      hintEl.textContent = custom
        ? (n > 1 ? '自定义正文一次只能用于一个楼层 —— 多选时请切回「用楼层原正文」。' : '这段正文会覆盖该楼层原文后再分析（图按新正文的行号插）。')
        : '改过正文记得切到「用我填的正文」—— 否则填了也是白填（会跑原正文）。';
    }
  }

  function lastAiFloors(n) {
    const ai = rows.filter(r => !r.isUser).map(r => r.mesId);
    return ai.slice(Math.max(0, ai.length - n));
  }

  function applyQuick(key) {
    if (key === 'none') { selected.clear(); }
    else if (key === 'all') { rows.forEach(r => selected.add(r.mesId)); }
    else if (key === 'invert') {
      const all = rows.map(r => r.mesId);
      all.forEach(id => { if (selected.has(id)) selected.delete(id); else selected.add(id); });
    } else if (key === 'last1' || key === 'last3' || key === 'last5') {
      const n = key === 'last1' ? 1 : key === 'last3' ? 3 : 5;
      selected.clear();
      lastAiFloors(n).forEach(id => selected.add(id));
    }
    renderList();
    updateSel();
  }

  /** 把某楼正文抓进编辑框。 */
  function fetchBody(mesId, { alsoSelect = true } = {}) {
    const id = Number(mesId);
    if (!Number.isInteger(id) || id < 0) { setStatus('楼层不存在', true); return false; }
    const text = String(getMessageText(id) || '');
    if (!text.trim()) { setStatus(`楼层 #${id} 正文为空`, true); return false; }
    if (bodyEl) bodyEl.value = text;
    if (alsoSelect) { selected.clear(); selected.add(id); }
    renderList();
    updateSel();
    setStatus(`已提取楼层 #${id} 的正文（${text.length} 字）${alsoSelect ? '，并已选中该楼' : ''}。改完记得切到「用我填的正文」。`);
    return true;
  }

  /* ---- 事件 ---- */

  listEl?.addEventListener('change', (e) => {
    const cb = e.target.closest?.('[data-pick]');
    if (!cb) return;
    const id = Number(cb.dataset.pick);
    if (cb.checked) selected.add(id); else selected.delete(id);
    cb.closest('.hl-manual-row')?.classList.toggle('on', cb.checked);
    updateSel();
  });

  listEl?.addEventListener('click', (e) => {
    const fb = e.target.closest?.('[data-fetch]');
    if (!fb) return;
    e.stopPropagation();
    fetchBody(fb.dataset.fetch);
  });

  host.querySelectorAll('[data-quick]').forEach(btn => {
    btn.addEventListener('click', () => applyQuick(btn.dataset.quick));
  });

  host.querySelector('#hl-manual-refresh')?.addEventListener('click', () => {
    renderList();
    updateSel();
    setStatus(`列表已刷新（共 ${rows.length} 楼）`);
  });

  host.querySelector('#hl-manual-spec-go')?.addEventListener('click', () => {
    const max = rows.length ? rows[rows.length - 1].mesId : 0;
    const ids = parseFloorSpec(specEl?.value || '', max);
    if (!ids.length) { setStatus('没解析出有效楼层号（示例：12 或 3,5,7-9）', true); return; }
    selected.clear();
    ids.forEach(id => selected.add(id));
    renderList();
    updateSel();
    setStatus(`已按号选中 ${ids.length} 楼`);
  });

  host.querySelector('#hl-manual-fetch')?.addEventListener('click', () => {
    const ids = Array.from(selected);
    if (ids.length !== 1) { setStatus(ids.length ? '多选时不确定提取哪一楼 —— 请用列表右侧的「取」按钮，或点「提取最后一楼」' : '先选一个楼层', true); return; }
    fetchBody(ids[0]);
  });

  host.querySelector('#hl-manual-fetch-last')?.addEventListener('click', () => {
    const id = getLastAiMesId();
    if (id < 0) { setStatus('没有找到 AI 楼层', true); return; }
    fetchBody(id);
  });

  host.querySelector('#hl-manual-clear')?.addEventListener('click', () => {
    if (bodyEl) bodyEl.value = '';
    setStatus('正文已清空');
  });

  // v0.9.59：正文 AI 指令优化 —— 把编辑框正文 + 用户指令发给分析模型，结果直接替换正文
  const askEl = host.querySelector('#hl-manual-ask');
  const askBtn = host.querySelector('#hl-manual-ask-go');
  askBtn?.addEventListener('click', async () => {
    const body = String(bodyEl?.value || '');
    if (!body.trim()) { setStatus('正文是空的 —— 先点「提取」把楼层正文抓进来，再让 AI 改', true); return; }
    const ask = String(askEl?.value || '').trim();
    if (askBtn.disabled) return;
    askBtn.disabled = true;
    const oldLabel = askBtn.textContent;
    askBtn.textContent = '✨ AI 分析中…';
    try {
      const { callAnalyzeLLM } = await import('../api.js');
      const out = await callAnalyzeLLM(buildManualAskMessages(body, ask), {
        source: '手动生图·正文优化',
        maxTokens: Math.min(8192, Math.max(1024, Math.ceil(body.length * 1.6))),
        temperature: ask ? 0.5 : 0.3,
      });
      const cleaned = String(out || '').replace(/```[a-z]*\n?|```/g, '').trim();
      if (!cleaned) { setStatus('AI 返回为空，正文保持原样（原因见「诊断」页）', true); return; }
      if (bodyEl) bodyEl.value = cleaned;
      // 改完自动切「用我填的正文」—— 不切的话改了也白改（会跑原正文）
      const customRadio = host.querySelector('input[name="hl-manual-mode"][value="custom"]');
      if (customRadio) customRadio.checked = true;
      updateSel();
      setStatus(`AI 已改完正文（${cleaned.length} 字），已自动切到「用我填的正文」—— 检查无误再点开始`);
      info(STAGE.UI, `手动生图：正文 AI 优化完成（指令：${ask ? ask.slice(0, 40) : '（无，轻度润色）'}，${body.length} → ${cleaned.length} 字）`);
    } catch (err) {
      setStatus(`AI 优化正文失败：${err?.message || err}`, true);
      warn(STAGE.UI, `正文 AI 优化失败：${err?.message || err}`);
    } finally {
      askBtn.disabled = false;
      askBtn.textContent = oldLabel;
    }
  });

  host.querySelectorAll('input[name="hl-manual-mode"]').forEach(r => {
    r.addEventListener('change', updateSel);
  });

  stopBtn?.addEventListener('click', () => {
    if (!busy) return;
    stopFlag = true;
    setStatus('停止中…（当前这楼跑完就停）');
  });

  runBtn?.addEventListener('click', async () => {
    if (busy) return;
    const ids = Array.from(selected).sort((a, b) => a - b);
    if (!ids.length) { setStatus('先选楼层（或直接点「提取最后一楼」）', true); return; }

    const text = String(bodyEl?.value || '');
    const custom = mode() === 'custom';
    const opts = {};
    if (host.querySelector('#hl-manual-force')?.checked) opts.force = true;
    // v0.9.53：生图前先弹预览编辑器（默认勾上；批量跑多楼时可关）
    if (host.querySelector('#hl-manual-preview')?.checked) opts.preview = true;

    if (custom) {
      if (!text.trim()) { setStatus('「用我填的正文」模式下正文不能为空 —— 先点提取或自己写', true); return; }
      if (ids.length > 1) { setStatus('自定义正文一次只能用于一个楼层 —— 多选请切回「用楼层原正文」', true); return; }
      const ok = typeof globalThis.confirm === 'function'
        ? globalThis.confirm(`将用编辑框里的正文覆盖楼层 #${ids[0]} 的原文（原正文会被替换），确定吗？`)
        : true;
      if (!ok) return;
      opts.body = text;
      opts.writeBody = true;
    }

    busy = true;
    stopFlag = false;
    runBtn.disabled = true;
    if (stopBtn) stopBtn.disabled = false;
    updateSel();

    if (progEl) {
      progEl.innerHTML = ids.map(id => `
        <div class="hl-manual-p-row" data-row="${id}">
          <span class="hl-manual-p-id">#${id}</span>
          <span class="hl-manual-p-state">排队中</span>
          <span class="hl-manual-p-why"></span>
        </div>`).join('');
    }
    setStatus(`开始处理 ${ids.length} 个楼层（串行，逐楼分析 + 生图）…`);
    info(STAGE.UI, `手动生图：开始处理 ${ids.length} 个楼层 ${ids.map(i => `#${i}`).join(' ')}`);

    const t0 = Date.now();
    let doneN = 0;
    let failN = 0;
    let skipN = 0;
    const firstProblem = { reason: '' };

    const results = await runManualMany(ids, {
      ...opts,
      shouldStop: () => stopFlag,
      onProgress: (id, state, r) => {
        const row = progEl?.querySelector(`[data-row="${id}"]`);
        if (!row) return;
        const stEl = row.querySelector('.hl-manual-p-state');
        if (!stEl) return;
        /**
         * ★ v0.9.106：失败/跳过必须把「为什么」摆在脸上。
         *   以前一行只写 `✗ 正文写入被跳过`，用户完全不知道该降哪一步 ——
         *   而这一条底下其实是三种完全不同的病（见 pipeline 的 why 分档）。
         */
        const whyEl = row.querySelector('.hl-manual-p-why');
        const setWhy = (text, tip) => {
          if (!whyEl) return;
          whyEl.textContent = text || '';
          whyEl.title = tip || '';
        };
        if (state === 'running') {
          stEl.textContent = '分析中 / 生图中…';
          stEl.className = 'hl-manual-p-state run';
          setWhy('');
        } else if (state === 'done') {
          /**
           * ★ v0.9.105：区分「真完成」与「跳过」。
           * 以前这里只有 `✓ 完成` —— 无配图 / 位置对不上 / 预览取消 也都是这个字样，
           * 用户点完看到 6 秒「完成」，图却没变，完全无从判断。
           */
          if (r?.skipped) {
            skipN += 1;
            if (!firstProblem.reason) firstProblem.reason = r.reason || '';
            stEl.textContent = `⤼ ${r.reason || '跳过（未出图）'}`;
            stEl.className = 'hl-manual-p-state skip';
            setWhy(r?.cause || '');
          } else {
            doneN += 1;
            stEl.textContent = '✓ 完成';
            stEl.className = 'hl-manual-p-state ok';
            setWhy(r?.reason || '');
          }
        } else {
          failN += 1;
          if (!firstProblem.reason) firstProblem.reason = r?.reason || '';
          stEl.textContent = `✗ ${r?.reason || '失败'}`;
          stEl.className = 'hl-manual-p-state bad';
          setWhy(r?.cause || '', r?.fix ? `建议：${r.fix}` : '');
        }
      },
    });

    const stopped = results.some(r => r.stopped);
    busy = false;
    runBtn.disabled = false;
    if (stopBtn) stopBtn.disabled = true;
    updateSel();
    renderList();

    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    if (stopped) setStatus(`已停止：完成 ${doneN} 楼${skipN ? `、跳过 ${skipN} 楼` : ''}、失败 ${failN} 楼（耗时 ${secs}s）`);
    else if (failN || skipN) {
      const parts = [`完成 ${doneN} 楼`];
      if (skipN) parts.push(`跳过 ${skipN} 楼`);
      if (failN) parts.push(`失败 ${failN} 楼`);
      setStatus(`${parts.join('，')}（耗时 ${secs}s）—— ${firstProblem.reason || '原因见「诊断」页'}`, true);
    } else setStatus(`全部完成：${doneN} 楼（耗时 ${secs}s）。图已插回正文；诊断页可看每一步。`);

    warn(STAGE.UI, `手动生图结束：完成 ${doneN} / 跳过 ${skipN} / 失败 ${failN}${stopped ? '（已停止）' : ''}`);
    return results;
  });

  renderList();
  updateSel();
  return { refresh: () => { renderList(); updateSel(); }, fetchBody, selected };
}
