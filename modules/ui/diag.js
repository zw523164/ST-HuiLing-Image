/**
 * 绘灵 · 诊断面板 v2
 *
 * 按「请求历史」页重做：别让用户在一串流水日志里自己拼时间线，
 * 每次生图请求就是一张卡片 —— 状态、模型、耗时一目了然，点开看全文，一键复制。
 *
 *   ① 请求历史：每张卡片 = 一次生图（位置 / 后端 / 模型 / 耗时 / 成败），
 *      展开看 prompt / nl / 负面 / 错误堆栈全文，单条可复制（求助时甩这一条就够）
 *   ② 最近任务：楼层处理时间线，默认收起，点头展开
 *   ③ 日志流：级别筛选；错误条目带原因/建议；原始数据折叠；单条可复制
 *   ④ 导出报告保留（全量文本，甩给别人求助用）
 */

import { escapeHtml } from '../util.js';
import { auditSdCompose } from '../sdComposeFix.js';
import {
  subscribe, getEntries, clearEntries, exportText, getTasks,
  getRequests, clearRequests,
} from '../log.js';
import { snapshot, costOf, cacheRate, clearUsage } from '../usage.js';

const LEVEL_LABEL = { debug: '调试', info: '信息', warn: '警告', error: '错误' };
const LEVEL_RANK = { debug: 0, info: 1, warn: 2, error: 3 };

function html() {
  return `
<div class="hl-section">
  <div class="hl-section-title">用量与花费</div>
  <div id="hl-diag-usage" class="hl-tasks"></div>
</div>

<div class="hl-section">
  <div class="hl-section-title">请求历史 <span id="hl-diag-req-count" class="hl-count"></span></div>
  <div class="hl-inline">
    <div class="hl-seg" id="hl-diag-req-filter">
      <button class="hl-seg-btn is-on" data-v="">全部</button>
      <button class="hl-seg-btn" data-v="ok">成功</button>
      <button class="hl-seg-btn" data-v="bad">失败</button>
    </div>
    <span class="hl-spacer"></span>
    <button class="hl-btn hl-ghost" id="hl-diag-req-clear">清空历史</button>
  </div>
  <div id="hl-diag-reqs" class="hl-reqs"></div>
</div>

<div class="hl-section">
  <div class="hl-section-title">最近任务</div>
  <div id="hl-diag-tasks" class="hl-tasks"></div>
</div>

<div class="hl-section">
  <div class="hl-section-title">日志流</div>
  <div class="hl-inline">
    <select id="hl-diag-level" class="hl-input">
      <option value="">全部级别</option>
      <option value="info">信息及以上</option>
      <option value="warn">警告及以上</option>
      <option value="error">仅错误</option>
    </select>
    <button class="hl-btn" id="hl-diag-export">导出报告</button>
    <button class="hl-btn hl-ghost" id="hl-diag-clear">清空日志</button>
  </div>
  <div class="hl-hint">出问题时先看请求历史 —— 每条失败都带「可能原因」「该怎么修」和完整提示词，点「复制」直接甩给别人求助。</div>
  <div id="hl-diag-log" class="hl-log"></div>
</div>`;
}

/* ============ 请求历史 ============ */

/** v0.9.98：段 id → 中文名（诊断里显示"这张图实际是怎么拼的"）。 */
const SEG_LABEL = {
  prefix: '风格前缀', count: '人数词', anchor: '写实锚定', scene: '场景段',
  cast: '角色段', costume: '服装段', tag: '动作段', suffix: '风格后缀',
  head: '首段（前缀+人数+动作）', guard: '人数守卫',
};
const ENGINE_LABEL = { sd: 'SD 口径', k2: 'K2 口径' };

/**
 * 「提示词结构」区块（用户 2026-10-18：「哪些起作用、哪些没用、代价是什么都不知道」）。
 *
 * 只显示事实，不做猜测：
 *   - 每段几项、从第几项开始（估算 token）；
 *   - 走的是「按你排的顺序」还是「出厂顺序」；
 *   - 动作段若落在前 77 token 之外 → 明确告警（`sd1_clip.py:49` 只取第 1 块做全局语义）。
 */
function structureBlock(st) {
  if (!st || !Array.isArray(st.segments) || !st.segments.length) return '';
  const rows = st.segments.map((s, i) => {
    const label = SEG_LABEL[s.id] || s.id;
    return `<div class="hl-struct-row">
      <span class="hl-struct-idx">${i + 1}</span>
      <span class="hl-struct-name">${escapeHtml(label)}</span>
      <span class="hl-struct-meta">${s.items} 项 · 第 ${s.at + 1} 项起 · ≈${s.approxToken} token</span>
    </div>`;
  }).join('');
  const tagSeg = st.segments.find((s) => s.id === 'tag');
  const late = tagSeg && tagSeg.at > 70;
  const countSeg = st.segments.find((s) => s.id === 'count' || s.id === 'head');
  return `<div class="hl-req-field"><label>提示词结构 · ${escapeHtml(ENGINE_LABEL[st.engine] || st.engine)} · ${
    st.mode === 'layout' ? '按你排的顺序' : '出厂顺序'}${st.hasBreak ? ' · 段间 BREAK' : ''}</label>
    <div class="hl-struct">${rows}</div>
    ${late ? `<div class="hl-struct-warn">动作段从第 ${tagSeg.at} 个 token 才开始 —— 已进入第 2 个 CLIP 块。
      前 77 token 决定整张图的调性（sd1_clip.py:49 只取第 1 块），想让动作主导画面就把「动作段」往上移。</div>` : ''}
    ${!countSeg ? '<div class="hl-struct-warn">这张图没有人数词段（1girl / 1boy）—— SD 下人数可能出错。</div>' : ''}
    <div class="hl-hint">token 数是估算（英文 tag ≈ 4 字符 / token），只用来判断"落在第几个 CLIP 块"。</div>
  </div>`;
}

/**
 * 画面结构体检块（v0.9.112）—— 用户 2026-10-20 报「肢体扭曲」的界面入口。
 *
 * ★ 为什么放在这一页：这里的「正向提示词」是用户唯一会逐字看的地方（他一直截图的就是它）。
 *   体检结果如果只在日志流里，他永远找不到 —— 而这一页展开就能对照着看。
 *
 * ★ 两级口径：`warn` = 会让结构崩的硬冲突（机位/景别多条、躯干以下配特写、多视图只给一套机位）；
 *   `hint` = 容易崩但没有定论的（无手位、无视线、像句子的自创词组）。分开渲染，别一个颜色。
 *
 * ★ 只对 SD 口径跑：K2 是自然语，拿 tag 规则去量它全是「自创词组」，那是纯噪声。
 */
function composeBlock(prompt, structure) {
  const p = String(prompt || '');
  if (!p.trim()) return '';
  if (structure && structure.engine && structure.engine !== 'sd') return '';
  // 中文兜底：SD 口径不可能出现中文；出现了说明是 K2 的中英混合串，别乱报
  if (/[\u4e00-\u9fff]/.test(p)) return '';

  let items = [];
  try { items = auditSdCompose(p); } catch (err) { return ''; }

  if (!items.length) {
    return `<div class="hl-req-field"><label>画面结构体检</label>
      <div class="hl-ok">✓ 景别 / 机位各一个 · 主行为不堆叠 · 有承重面 —— 没有会让肢体崩坏的冲突</div>
    </div>`;
  }
  const warns = items.filter((x) => x.level === 'warn');
  const hints = items.filter((x) => x.level !== 'warn');
  const row = (x) => (x.level === 'warn'
    ? `<div class="hl-bad">⚠ ${escapeHtml(x.text)}</div>`
    : `<div class="hl-hint">ⓘ ${escapeHtml(x.text)}</div>`);
  return `<div class="hl-req-field"><label>画面结构体检 · ${warns.length} 个硬冲突 / ${hints.length} 条建议</label>
    <div class="hl-struct">${[...warns, ...hints].map(row).join('')}</div>
    <div class="hl-hint">检查的是真正送去出图的这一串（已过自动归一）。
      机位/景别多条、躯干以下配特写、penetration 在出图前已经被自动改掉，所以这里通常看不到 ——
      要看改了哪些，到下面的「日志流」搜「画面结构已归一」。
      规范出处：SD 模版 §2.2 承重面 / §2.3 手位 / §2.4 景别机位各选一个 / §5.3 主行为选一个。</div>
  </div>`;
}

function reqCard(r, i) {
  const time = new Date(r.at).toLocaleTimeString();
  const dur = r.durationMs != null ? `${(r.durationMs / 1000).toFixed(1)}s` : '—';
  const state = r.ok ? 'ok' : 'bad';
  const stateText = r.ok ? '成功' : '失败';
  const imgs = r.images ? ` · ${r.images} 图` : '';
  const model = r.model ? escapeHtml(r.model) : '';
  const errHead = r.error ? String(r.error).split('\n')[0] : '';

  return `
  <div class="hl-req ${state}" data-idx="${i}">
    <div class="hl-req-head" data-act="toggle">
      <span class="hl-req-dot"></span>
      <span class="hl-req-pos">${escapeHtml(r.position || '?')}</span>
      <span class="hl-req-meta">${escapeHtml(r.backend || '')}${model ? ` · ${model}` : ''}</span>
      <span class="hl-spacer"></span>
      <span class="hl-req-state">${stateText}${imgs}</span>
      <span class="hl-req-dur">${dur}</span>
      <span class="hl-req-time">${time}</span>
      <span class="hl-req-caret">▸</span>
    </div>
    ${errHead ? `<div class="hl-req-err">${escapeHtml(errHead)}</div>` : ''}
    <div class="hl-req-body" hidden>
      ${structureBlock(r.structure)}
      ${composeBlock(r.prompt, r.structure)}
      <div class="hl-req-field"><label>正向提示词</label><pre>${escapeHtml(r.prompt || '(空)')}</pre></div>
      ${r.nl ? `<div class="hl-req-field"><label>中文描述（nl）</label><pre>${escapeHtml(r.nl)}</pre></div>` : ''}
      ${r.negative ? `<div class="hl-req-field"><label>负面</label><pre>${escapeHtml(r.negative)}</pre></div>` : ''}
      ${r.error ? `<div class="hl-req-field"><label>错误</label><pre class="hl-req-err-full">${escapeHtml([r.error, r.errStack].filter(Boolean).join('\n\n── 堆栈 ──\n'))}</pre></div>` : ''}
      <div class="hl-req-actions">
        <button class="hl-btn hl-btn-sm" data-act="copy">❐ 复制这条</button>
        <span class="hl-hint">楼层 #${escapeHtml(String(r.mesId ?? '—'))} · ${new Date(r.at).toLocaleString()}</span>
      </div>
    </div>
  </div>`;
}

/** 大数字压缩显示，避免一行塞不下。 */
function fmtTok(n) {
  const v = Number(n) || 0;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return String(Math.round(v));
}

/**
 * 用量与花费（v0.9.143）。
 *
 * 用户原话：「我不看后台都不知道被烧了这么多」。所以这里第一眼就要给三件事：
 *   **今天花了多少 token / 缓存命中多少 / 大约多少钱**。
 * 金额是按可配置单价的**估算**，必须标注清楚，不能让人以为这是账单。
 */
function renderUsage(container) {
  const box = container.querySelector('#hl-diag-usage');
  if (!box) return;
  const s = snapshot();
  const t = s.today;
  const row = (k, v) => `<div class="hl-inline"><b>${k}</b><span class="hl-spacer"></span><span>${v}</span></div>`;

  if (!t.calls) {
    box.innerHTML = `<div class="hl-empty">今天还没有用量记录。只有**真正拿到 usage** 的请求才会记在这里 —— 拿不到就不记，不靠字数估算。</div>`;
    return;
  }

  const rate = Math.round(cacheRate(t) * 100);
  const cny = costOf(t, s.price);
  const per = Math.round(t.total / t.calls);
  const last = s.last;
  const days = (s.days || []).slice(0, 7).map((d) => {
    const c = costOf(d, s.price);
    return `<div class="hl-inline"><span>${escapeHtml(d.date)}</span><span class="hl-spacer"></span><span>${d.calls} 次 · ${fmtTok(d.total)} tok · 约 ¥${c.toFixed(3)}</span></div>`;
  }).join('');

  box.innerHTML = [
    row('今日', `${t.calls} 次 · ${t.total.toLocaleString()} tok · 平均 ${per.toLocaleString()} tok/次`),
    row('缓存命中', `${rate}%（命中 ${t.hit.toLocaleString()} / 未命中 ${t.miss.toLocaleString()}）`),
    row('估算花费', `约 ¥${cny.toFixed(3)} <span class="hl-count">按你设的单价估算，不是账单</span>`),
    last ? row('本次', `${escapeHtml(last.source)} · ${last.total.toLocaleString()} tok · ${last.peak ? '高峰' : '空闲'} · ${new Date(last.at).toLocaleTimeString()}`) : '',
    '<div class="hl-section-title" style="margin-top:8px">近 7 天</div>',
    days,
    '<div class="hl-inline"><span class="hl-spacer"></span><button class="hl-btn hl-ghost" id="hl-usage-clear">清空统计</button></div>',
  ].filter(Boolean).join('');
}

function renderReqs(container) {
  const box = container.querySelector('#hl-diag-reqs');
  if (!box) return;
  const filter = container.dataset.reqFilter || '';
  const all = getRequests();
  const list = filter === 'ok' ? all.filter(r => r.ok)
    : filter === 'bad' ? all.filter(r => !r.ok)
    : all;

  const count = container.querySelector('#hl-diag-req-count');
  if (count) count.textContent = String(all.length);

  if (!list.length) {
    box.innerHTML = `<div class="hl-hint">${all.length ? '该状态下没有记录。' : '还没有生图请求。触发一次生图后，这里每次请求都会落一张卡片。'}</div>`;
    return;
  }
  box.innerHTML = list.map((r, i) => reqCard(r, i)).join('');
}

/* ============ 任务 ============ */

function renderTasks(container) {
  const box = container.querySelector('#hl-diag-tasks');
  if (!box) return;
  const tasks = getTasks();
  if (!tasks.length) {
    box.innerHTML = '<div class="hl-hint">还没有任务。触发一次生图后这里会显示每个楼层的处理过程。</div>';
    return;
  }

  box.innerHTML = tasks.map((t, i) => {
    const dur = t.endedAt ? `${((t.endedAt - t.startedAt) / 1000).toFixed(1)}s` : '进行中';
    const state = t.ok === null ? 'hl-run' : (t.ok ? 'hl-ok' : 'hl-bad');
    const stateText = t.ok === null ? '进行中' : (t.ok ? '成功' : `失败于「${t.failedStage || '未知阶段'}」`);
    const steps = t.steps?.length
      ? `<div class="hl-task-steps" ${t.ok === false ? '' : 'hidden'}>${t.steps.map(s => {
          const st = new Date(s.t).toLocaleTimeString();
          return `<div>· <span class="hl-log-time">${st}</span> [${escapeHtml(s.stage)}] ${escapeHtml(s.msg)}</div>`;
        }).join('')}</div>`
      : '';
    return `
      <div class="hl-task ${state}" data-task="${i}">
        <div class="hl-task-head" data-act="toggle-task">
          <b>${escapeHtml(t.label)}</b>
          <span class="hl-spacer"></span>
          <span class="hl-task-state">${stateText}</span>
          <span class="hl-task-dur">${dur}</span>
          <span class="hl-req-caret">▸</span>
        </div>
        ${steps}
      </div>`;
  }).join('');
}

/* ============ 日志流 ============ */

function renderLog(container) {
  const box = container.querySelector('#hl-diag-log');
  if (!box) return;
  const minLevel = container.querySelector('#hl-diag-level')?.value || '';
  const minRank = minLevel ? LEVEL_RANK[minLevel] : 0;

  const list = getEntries()
    .filter(e => LEVEL_RANK[e.level] >= minRank)
    .slice(-160)
    .reverse();

  if (!list.length) {
    box.innerHTML = '<div class="hl-hint">暂无日志。</div>';
    return;
  }

  box.innerHTML = list.map((e, i) => {
    const time = new Date(e.t).toLocaleTimeString();
    const hasData = e.data !== undefined && e.data !== null
      && !(typeof e.data === 'object' && !Object.keys(e.data).length);
    const copyPayload = [e.msg, e.cause ? `可能原因：${e.cause}` : '', e.fix ? `建议：${e.fix}` : '',
      hasData ? `数据：${JSON.stringify(e.data, null, 1)}` : ''].filter(Boolean).join('\n');
    const diag = e.diag ? `
      ${e.cause ? `<div class="hl-log-cause">可能原因：${escapeHtml(e.cause)}</div>` : ''}
      ${e.fix ? `<div class="hl-log-fix">建议：${escapeHtml(e.fix)}</div>` : ''}` : '';
    const data = hasData ? `
      <details class="hl-log-data"><summary>原始数据</summary><pre>${escapeHtml(JSON.stringify(e.data, null, 1))}</pre></details>` : '';
    return `
      <div class="hl-log-item hl-lv-${e.level}" data-log="${i}">
        <div class="hl-log-head">
          <span class="hl-log-time">${time}</span>
          <span class="hl-log-stage">${escapeHtml(e.stage)}</span>
          <span class="hl-log-level">${LEVEL_LABEL[e.level] || e.level}</span>
          <span class="hl-spacer"></span>
          <button class="hl-log-copy" data-act="copy-log" title="复制这条日志">❐</button>
        </div>
        <div class="hl-log-msg">${escapeHtml(e.msg)}</div>
        ${diag}${data}
        <textarea class="hl-copy-holder" hidden>${escapeHtml(copyPayload)}</textarea>
      </div>`;
  }).join('');
}

/* ============ 复制 ============ */

function copyText(text) {
  const done = navigator.clipboard?.writeText?.(text);
  if (done?.catch) done.catch(() => {
    // 剪贴板被拒时兜底：选中一个临时 textarea 让用户 Ctrl+C
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch { /* 都不行就只能提醒 */ }
    ta.remove();
  });
}

/* ============ 挂载 ============ */

export async function mountDiag(container) {
  /**
   * ★★★ v0.9.115 · 先拆掉**上一次挂载**留下的委托监听器。
   *
   * `mountDiag` 可以被调用多次（打开诊断页 / 测试里反复 mount），每次都
   * `container.innerHTML = html()` 重建内容 —— 但下面那个 `container.addEventListener('click')`
   * 是**委托在 container 自身**上的，元素重建它不会消失，于是**越挂越多**。
   *
   * 后果：点一次卡片 = 触发 N 次 toggle = 展开/收起互相抵消
   *   ⇒ 用户看到的就是「点了没反应」（奇数个监听器时才碰巧能开）。
   * 这不是测试环境的怪癖，真机上反复进出诊断页同样会中招。
   *
   * 用 AbortController 一次性解绑：只清 container 上的委托，
   * 挂在子元素（筛选 / 清空 / 导出）的那些随 `innerHTML` 重建自然失效。
   */
  container.__hlDiagAbort?.abort?.();
  /**
   * ★ 必须取**容器所属文档**的 AbortController，不能用全局的：
   *   jsdom（测试环境）里 `globalThis.AbortController` 是 Node 的，
   *   而 `addEventListener` 是 jsdom window 的，两者跨 realm 不认 → TypeError。
   *   真机两者同源，取 ownerDocument 一样正确。
   */
  const AC = container?.ownerDocument?.defaultView?.AbortController || globalThis.AbortController;
  const ac = new AC();
  container.__hlDiagAbort = ac;

  container.innerHTML = html();

  const render = () => { renderUsage(container); renderReqs(container); renderTasks(container); renderLog(container); };
  render();

  // —— 筛选 ——
  container.querySelector('#hl-diag-level')?.addEventListener('change', () => renderLog(container));
  container.querySelector('#hl-diag-req-filter')?.addEventListener('click', (e) => {
    const btn = e.target.closest('.hl-seg-btn');
    if (!btn) return;
    container.dataset.reqFilter = btn.dataset.v || '';
    container.querySelectorAll('#hl-diag-req-filter .hl-seg-btn')
      .forEach(b => b.classList.toggle('is-on', b === btn));
    renderReqs(container);
  });

  /* —— 用量统计：清空 ——
   * 这块内容由 renderUsage 用 innerHTML 重建，所以按钮必须**委托在 container 上**，
   * 并且带 signal 解绑（否则重复 mount 会累加监听器，见函数开头的说明）。 */
  container.addEventListener('click', (e) => {
    if (!e.target?.closest?.('#hl-usage-clear')) return;
    if (!globalThis.confirm?.('清空用量统计？（只是统计数字，不影响出图与配置）')) return;
    clearUsage();
    renderUsage(container);
  }, { signal: ac.signal });

  // —— 清空 / 导出 ——
  container.querySelector('#hl-diag-req-clear')?.addEventListener('click', () => {
    if (!globalThis.confirm?.('清空全部请求历史？（不影响出图与正文）')) return;
    clearRequests();
    render();
  });
  container.querySelector('#hl-diag-clear')?.addEventListener('click', () => {
    clearEntries();
    renderLog(container);
  });
  container.querySelector('#hl-diag-export')?.addEventListener('click', () => {
    const blob = new Blob([exportText()], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `绘灵诊断报告-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  });

  // —— 事件委托：展开 / 复制 ——
  // ★ 必须带 signal：否则重复 mount 会累加监听器（见函数开头说明）
  container.addEventListener('click', (e) => {
    const act = e.target.closest('[data-act]');
    if (!act) return;
    const kind = act.dataset.act;

    if (kind === 'toggle') {
      const card = act.closest('.hl-req');
      const body = card?.querySelector('.hl-req-body');
      if (body) {
        body.hidden = !body.hidden;
        card.classList.toggle('is-open', !body.hidden);
      }
    } else if (kind === 'toggle-task') {
      const card = act.closest('.hl-task');
      const steps = card?.querySelector('.hl-task-steps');
      if (steps) {
        steps.hidden = !steps.hidden;
        card.classList.toggle('is-open', !steps.hidden);
      }
    } else if (kind === 'copy') {
      const card = act.closest('.hl-req');
      const r = getRequests()[Number(card?.dataset.idx ?? -1)];
      if (!r) return;
      const text = [
        `绘灵生图请求 · ${r.ok ? '成功' : '失败'}`,
        `时间：${new Date(r.at).toLocaleString()}｜楼层 #${r.mesId ?? '—'}｜位置 ${r.position}`,
        `后端：${r.backend}${r.model ? ` / ${r.model}` : ''}｜耗时 ${r.durationMs != null ? `${(r.durationMs / 1000).toFixed(1)}s` : '?'}｜出图 ${r.images} 张`,
        '',
        `正向提示词：\n${r.prompt || '(空)'}`,
        r.nl ? `\n中文描述（nl）：\n${r.nl}` : '',
        r.negative ? `\n负面：\n${r.negative}` : '',
        r.error ? `\n错误：\n${[r.error, r.errStack].filter(Boolean).join('\n\n── 堆栈 ──\n')}` : '',
      ].filter(Boolean).join('\n');
      copyText(text);
      act.textContent = '✓ 已复制';
      setTimeout(() => { act.textContent = '❐ 复制这条'; }, 1500);
    } else if (kind === 'copy-log') {
      const item = act.closest('.hl-log-item');
      const ta = item?.querySelector('.hl-copy-holder');
      if (ta) {
        copyText(ta.value);
        act.textContent = '✓';
        setTimeout(() => { act.textContent = '❐'; }, 1200);
      }
    }
  }, { signal: ac.signal });

  // 实时订阅（节流到 400ms，避免日志刷屏时卡 UI）
  // ★ 同样必须退订：`subscribe` 往全局 Set 里加，重复 mount 会留下 N 个订阅
  //   → 每来一条日志就 render N 次（旧的那几次还在往已经被丢弃的 DOM 上写）。
  container.__hlDiagUnsub?.();
  let pending = false;
  container.__hlDiagUnsub = subscribe(() => {
    if (pending) return;
    pending = true;
    setTimeout(() => { pending = false; render(); }, 400);
  });
}
