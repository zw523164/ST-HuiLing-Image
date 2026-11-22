/**
 * 绘灵 · 数据库页（v0.9.187）
 *
 * 用户 2026-11-01 提：「GAL 模式好像还对接了一个酒馆插件数据库…我觉得你可以看下这个数据库，
 * 对我们绘灵有没有帮助」→「接入数据库也做一个 UI 面板方便管理」。
 *
 * 这一页只做四件事：
 *   ① 说清「现在读到了什么」——来源、楼层、地点、时间、在场、纪要长度；
 *   ② 给四个开关（总开关 / 场景 / 在场角色 / 纪要）；
 *   ③ 把**实际注入给写词模型的原文**原样显示（没有预览就等于让用户盲开）；
 *   ④ 一个「打开数据库」的跳板，省得他去别的菜单里翻。
 *
 * 为什么必须只读：数据库是「龙血玄黄」那边的主场，绘灵一旦写它，
 * 用户两个插件的状态就会互相踩（长期规矩：最小范围实现，不越界）。
 */
import { getConfig, saveSettings } from '../settings.js';
import { readSceneFacts, sceneDbLines } from '../sceneDb.js';
import { escapeHtml } from '../util.js';

function dbConfig() {
  const c = getConfig();
  if (!c.sceneDb || typeof c.sceneDb !== 'object') {
    c.sceneDb = { enabled: true, scene: true, cast: true, summary: true };
  }
  return c.sceneDb;
}

function statusHtml() {
  let facts = null;
  let err = '';
  try { facts = readSceneFacts(); } catch (e) { err = e?.message || String(e); }

  if (err) {
    return `<div class="hl-err">读取数据库时出错：${escapeHtml(err)}</div>`;
  }
  if (!facts) {
    return `
<div class="hl-hint" style="line-height:1.9">
  <span class="hl-err">现在读不到数据库。</span><br>
  可能的原因：① 这张卡 / 这个对话没有启用「龙血玄黄·数据库」；② 还没有任何一楼写入过表格；
  ③ 数据结构不是这个插件。<br>
  <b>读不到时绘灵一个字都不加</b>（编造地点比不注入更糟），下面的开关留着也不影响出图。
</div>`;
  }

  const src = facts.source === 'api' ? '运行时 API（合并后的当前值）' : '聊天楼层快照（向上回溯）';
  const present = (facts.present || []).map((p) => `${escapeHtml(p.name)}${p.at ? `<span style="opacity:.65">（在${escapeHtml(p.at)}）</span>` : ''}`).join('　');
  return `
<div class="hl-hint" style="line-height:1.95">
  <span class="hl-ok">✅ 已连上数据库</span>（来源：${escapeHtml(src)}）<br>
  <b>地点</b>：${escapeHtml(facts.location || '—')}${facts.region ? `<span style="opacity:.65">（${escapeHtml(facts.region)}）</span>` : ''}<br>
  <b>时间</b>：${escapeHtml(facts.time || '—')}<br>
  <b>在场</b>：${present || '—'}<br>
  <b>纪要</b>：${facts.summary ? `最近一段 ${facts.summary.length} 字` : '—'}
</div>`;
}

function previewHtml() {
  const c = dbConfig();
  let lines = [];
  try { lines = sceneDbLines(readSceneFacts(), { scene: c.scene, cast: c.cast, summary: c.summary }); } catch { lines = []; }
  if (c.enabled === false) {
    return '<div class="hl-hint">总开关已关 —— 下面这些内容一个字都不会进提示词。</div>';
  }
  if (!lines.length) {
    return '<div class="hl-hint">当前没有可注入的内容（没读到，或三段都关了）。</div>';
  }
  const text = lines.join('\n');
  return `
<div class="hl-hint" style="margin-bottom:6px">下面是**原样**加进写词请求的内容（${text.length} 字）：</div>
<pre style="white-space:pre-wrap;line-height:1.75;font-size:12px;max-height:340px;overflow:auto;background:rgba(0,0,0,.18);padding:10px;border-radius:8px;margin:0">${escapeHtml(text)}</pre>`;
}

function toggleRow(key, label, hint) {
  const c = dbConfig();
  const on = key === 'enabled' ? c.enabled !== false : c[key] !== false;
  return `
<label class="hl-row" style="display:flex;gap:10px;align-items:flex-start;margin:8px 0;cursor:pointer">
  <input type="checkbox" data-db-key="${key}" ${on ? 'checked' : ''} style="margin-top:3px">
  <span><b>${label}</b><br><span class="hl-hint">${hint}</span></span>
</label>`;
}

export function mountDb(pane) {
  const c = dbConfig();
  pane.innerHTML = `
<div class="hl-section">
  <div class="hl-section-title">数据库联动（龙血玄黄 · shujuku）</div>
  <div class="hl-hint" style="line-height:1.9">
    写提示词时，<b>地点 / 时间 / 在场角色 / 最近一段纪要</b>直接从数据库取，不再让模型从正文里猜。<br>
    昨天实测的问题正是「猜」出来的：同一场戏（<b>体育器材室</b>）连出 3 张，
    summary 全写成 <code>a dim classroom at night</code>，还自己编了课桌 —— 正文里「教室」出现 0 次。
  </div>
</div>

<div class="hl-section">
  <div class="hl-section-title">现在读到了什么</div>
  <div id="hl-db-status">${statusHtml()}</div>
  <div style="margin-top:10px">
    <button class="hl-btn hl-ghost" id="hl-db-refresh" type="button">重新读取</button>
    <button class="hl-btn hl-ghost" id="hl-db-open" type="button" style="margin-left:8px">打开数据库</button>
  </div>
</div>

<div class="hl-section">
  <div class="hl-section-title">注入开关</div>
  ${toggleRow('enabled', '总开关', '关掉 = 写词时完全不读数据库。')}
  ${toggleRow('scene', '场景（地点 / 时间 / 地区）', '让模型「照抄」地点，不许换成教室/卧室。')}
  ${toggleRow('cast', '在场角色名单', '只列「在场」的人；「离场」的会被剔除 —— 写进去等于告诉模型他要出场。')}
  ${toggleRow('summary', '纪要（最近一段）', '跨楼延续的主要依据：体位 / 接触 / 脱到哪接着往下走。')}
  <div class="hl-hint" style="margin-top:8px;opacity:.85">
    绘灵<b>只读不写</b>数据库。要改数据请用「打开数据库」那一侧 —— 两边各管各的，不会互相踩。
  </div>
</div>

<div class="hl-section">
  <div class="hl-section-title">注入内容预览</div>
  <div id="hl-db-preview">${previewHtml()}</div>
</div>`;

  const refresh = () => {
    const s = pane.querySelector('#hl-db-status');
    const p = pane.querySelector('#hl-db-preview');
    if (s) s.innerHTML = statusHtml();
    if (p) p.innerHTML = previewHtml();
  };

  pane.querySelectorAll('[data-db-key]').forEach((input) => {
    input.addEventListener('change', () => {
      const conf = dbConfig();
      conf[input.dataset.dbKey] = input.checked;
      saveSettings();
      refresh();
    });
  });

  pane.querySelector('#hl-db-refresh')?.addEventListener('click', refresh);

  pane.querySelector('#hl-db-open')?.addEventListener('click', () => {
    const api = (globalThis.AutoCardUpdaterAPI)
      || (typeof window !== 'undefined' ? window.AutoCardUpdaterAPI : null);
    try {
      if (api && typeof api.open === 'function') { api.open(); return; }
      if (api && typeof api.openVisualizer === 'function') { api.openVisualizer(); return; }
    } catch { /* 打不开就走下面那句提示 */ }
    // toastr 是酒馆的全局，但测试环境里没有 —— 用 globalThis 取，避免 ReferenceError
    globalThis.toastr?.info?.('没找到数据库的打开接口 —— 请从酒馆侧栏「奶-数据库」进');
  });

  // 总开关关掉时，三个分项置灰（避免「关了却看不出」）
  const syncDisabled = () => {
    const on = dbConfig().enabled !== false;
    pane.querySelectorAll('[data-db-key]:not([data-db-key="enabled"])').forEach((el) => {
      el.disabled = !on;
      el.parentElement.style.opacity = on ? '1' : '.45';
    });
  };
  pane.querySelector('[data-db-key="enabled"]')?.addEventListener('change', syncDisabled);
  syncDisabled();
}
