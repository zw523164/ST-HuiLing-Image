/**
 * 读「龙血玄黄·数据库（shujuku）」里的场景与状态事实（v0.9.187）。
 *
 * ── 为什么接它 ────────────────────────────────────────────────
 * 用户 2026-11-01 报了两件事，本质是同一个：
 *   ① 「提示词不能延续之前楼层状态，到后面直接变其他不相关画面」；
 *   ② 实拍证据：同一场景（体育器材室 / 2026-04-15 深夜）连出 3 张，
 *      summary 里全写成 `a dim classroom at night`，还自己编出 `desks and chairs pushed to the walls`
 *      —— 正文里「教室」出现 0 次，「器材室」出现 3 次。
 * 这两件事都是「让模型从正文里重新推场景与状态」的后果。而这个数据库里
 * **已经有结构化的真值**：全局数据表存着「当前详细地点 / 当前时间」，
 * 重要角色表存着「所在地点 / 在场状态」，纪要表存着每一段剧情的压缩摘要。
 *
 * ── 数据在哪（实测，不是猜）────────────────────────────────────
 * 位置：聊天 jsonl 每条消息的顶层字段
 *   `message.TavernDB_ACU_IsolatedData[''].storageFrame.perSheetCheckpoints[sheetId].data`
 *   - `data.content` 是二维数组，**第 0 行是表头**
 *   - `data.name` 是中文表名（全局数据表 / 重要角色表 / 纪要表 …）
 * 坑：**只有部分楼写快照**（实测第 25 楼是 `{}`，第 13 楼才有）⇒ 必须向上回溯。
 * 另一条路是运行时 API `window.AutoCardUpdaterAPI.exportTableAsJson()`（合并后的当前值），
 * 优先用它；拿不到再退回读聊天楼层。
 *
 * ── 边界（用户主权）─────────────────────────────────────────────
 * 这里**只读**，一个字都不往数据库写。读不到就返回 null，调用方什么都不加 ——
 * 绝不编造地点/时间（编造比不注入更糟，会把画面拽到另一个房间）。
 */

/** 表头里「地点」这一类的列名 */
const LOC_KEYS = ['当前详细地点', '详细地点', '当前地点', '所在地点', '地点', '场景', '位置'];
/** 表头里「时间」这一类的列名 */
const TIME_KEYS = ['当前时间', '时间', '上轮场景时间'];
/** 「在场」判定 */
const PRESENT_KEYS = ['在场状态', '状态'];

function pickIdx(header, keys) {
  if (!Array.isArray(header)) return -1;
  const hs = header.map((h) => String(h == null ? '' : h).trim());
  // 先按优先级精确命中，再退化到包含
  for (const k of keys) {
    const i = hs.indexOf(k);
    if (i >= 0) return i;
  }
  for (const k of keys) {
    const i = hs.findIndex((h) => h.includes(k));
    if (i >= 0) return i;
  }
  return -1;
}

function cell(row, idx) {
  if (!Array.isArray(row) || idx < 0) return '';
  const v = row[idx];
  if (v == null) return '';
  return String(v).trim();
}

/** 把 `content`（二维数组）解析成对象数组，表头归一化到 key */
function rowsOf(content) {
  if (!Array.isArray(content) || content.length < 2) return { header: [], rows: [] };
  const header = content[0];
  return { header, rows: content.slice(1).filter(Array.isArray) };
}

/**
 * 从 perSheetCheckpoints 里挑出我们需要的那几张表。
 * 不按 `sheetId` 写死 —— 不同卡的 sheetId 可能变，认中文表名与表头更稳。
 */
function collectFromSheets(psc) {
  const out = { global: null, npc: null, summary: null, protagonist: null };
  for (const [, v] of Object.entries(psc || {})) {
    const d = v && v.data;
    if (!d) continue;
    const name = String(d.name || '');
    const { header, rows } = rowsOf(d.content);
    if (!rows.length) continue;
    if (!out.global && (name.includes('全局') || pickIdx(header, LOC_KEYS) >= 0 && pickIdx(header, TIME_KEYS) >= 0)) {
      out.global = { header, rows };
    }
    if (!out.npc && (name.includes('重要角色') || name.includes('角色表'))) out.npc = { header, rows };
    if (!out.protagonist && name.includes('主角')) out.protagonist = { header, rows };
    if (!out.summary && name.includes('纪要')) out.summary = { header, rows };
  }
  return out;
}

/** 从聊天楼层回溯最近的快照 */
function fromChat() {
  let chat = null;
  try {
    const ctx = globalThis.SillyTavern && globalThis.SillyTavern.getContext
      ? globalThis.SillyTavern.getContext()
      : null;
    chat = ctx && Array.isArray(ctx.chat) ? ctx.chat : null;
  } catch { chat = null; }
  if (!chat || !chat.length) return null;
  for (let i = chat.length - 1; i >= 0; i -= 1) {
    const raw = chat[i] && chat[i].TavernDB_ACU_IsolatedData;
    if (!raw || typeof raw !== 'object') continue;
    // 键名可能是 ''（实测），也可能是别的 —— 只认带 storageFrame 的那个
    for (const k of Object.keys(raw)) {
      const sf = raw[k] && raw[k].storageFrame;
      const psc = sf && sf.perSheetCheckpoints;
      if (psc && Object.keys(psc).length) return { psc, floor: i };
    }
  }
  return null;
}

/** 从运行时 API 取（合并后的当前值） */
function fromApi() {
  try {
    const api = (globalThis.AutoCardUpdaterAPI)
      || (typeof window !== 'undefined' ? window.AutoCardUpdaterAPI : null);
    if (!api || typeof api.exportTableAsJson !== 'function') return null;
    const data = api.exportTableAsJson();
    if (!data || typeof data !== 'object') return null;
    // 两种形态都兼容：{ sheet_x: {data:{content}} } 或 { sheet_x: {name, content} }
    const psc = {};
    for (const [k, v] of Object.entries(data)) {
      if (!v || typeof v !== 'object') continue;
      if (v.data) psc[k] = v;
      else if (Array.isArray(v.content)) psc[k] = { data: v };
    }
    return Object.keys(psc).length ? { psc, floor: -1 } : null;
  } catch { return null; }
}

/**
 * 读一次场景/状态事实。
 * @returns {null | {location:string, region:string, time:string, present:Array<{name,at,present}>, summary:string, source:string}}
 */
export function readSceneFacts() {
  let got = fromApi();
  let source = 'api';
  if (!got) { got = fromChat(); source = 'chat'; }
  if (!got) return null;

  const t = collectFromSheets(got.psc);
  const facts = { location: '', region: '', time: '', present: [], summary: '', source };

  /* ---- 全局数据表：地点 / 时间 ---- */
  if (t.global) {
    const row = t.global.rows[0];
    facts.location = cell(row, pickIdx(t.global.header, LOC_KEYS));
    facts.time = cell(row, pickIdx(t.global.header, TIME_KEYS));
    // 地区：次要地区 / 主要地区 拼起来（有就带上，帮模型理解「校舍一楼」这类相对位置）
    const secIdx = pickIdx(t.global.header, ['当前次要地区']);
    const mainIdx = pickIdx(t.global.header, ['当前主要地区', '主要地区']);
    facts.region = [cell(row, secIdx), cell(row, mainIdx)].filter(Boolean).join(' · ');
  }

  /* ---- 重要角色表：谁在场、各自在哪 ---- */
  for (const tb of [t.npc, t.protagonist]) {
    if (!tb) continue;
    const nIdx = pickIdx(tb.header, ['姓名', '名字']);
    const atIdx = pickIdx(tb.header, ['所在地点', '地点', '位置']);
    const pIdx = pickIdx(tb.header, PRESENT_KEYS);
    for (const row of tb.rows) {
      const name = cell(row, nIdx);
      if (!name) continue;
      const present = cell(row, pIdx);
      // 「离场」的不要 —— 写进画面等于告诉模型他要出场
      if (present && /离场|不在场|离开/.test(present)) continue;
      facts.present.push({
        name,
        at: cell(row, atIdx),
        present: present || (atIdx >= 0 ? '在场' : ''),
      });
    }
  }

  /* ---- 纪要表：最近一条（时间跨度 + 概览 + 纪要） ---- */
  if (t.summary) {
    const rows = t.summary.rows;
    const row = rows[rows.length - 1] || [];
    const spanIdx = pickIdx(t.summary.header, ['时间跨度']);
    const briefIdx = pickIdx(t.summary.header, ['概览']);
    const noteIdx = pickIdx(t.summary.header, ['纪要', '摘要']);
    const span = cell(row, spanIdx);
    const brief = cell(row, briefIdx);
    const note = cell(row, noteIdx);
    facts.summary = [span ? `时间跨度 ${span}` : '', brief ? `概览：${brief}` : '', note]
      .filter(Boolean).join('\n');
    if (facts.summary.length > 700) facts.summary = `${facts.summary.slice(0, 700)}…`;
  }

  if (!facts.location && !facts.time && !facts.present.length && !facts.summary) return null;
  return facts;
}

/**
 * 转成喂给写词模型的一段话。
 *
 * 语气是「照抄」而不是「参考」—— 今天的错就是模型把器材室「参考」成了教室。
 * 返回空数组表示没读到（或用户把这一段关了），调用方一个字都别加。
 *
 * @param {object} facts readSceneFacts() 的返回值
 * @param {{scene?:boolean, cast?:boolean, summary?:boolean}} [opts] 分段开关（默认全开）
 */
export function sceneDbLines(facts, opts = {}) {
  if (!facts) return [];
  const on = (k) => opts[k] !== false;
  const lines = [];
  if (on('scene') && (facts.location || facts.time || facts.region)) {
    lines.push('【数据库里的当前场景】（这是这一楼的真值，**照抄**，不许换成别的房间）');
    if (facts.location) {
      lines.push(`— 地点：${facts.location}${facts.region ? `（${facts.region}）` : ''}`);
    }
    if (facts.time) lines.push(`— 时间：${facts.time}`);
    lines.push('用法：画面背景必须就是这个地点——家具、陈设、光源都按它写；'
      + '正文没写「换了地方」就**不许**换成教室/卧室/浴室。');
  }
  if (on('cast') && facts.present && facts.present.length) {
    const names = facts.present.map((p) => `${p.name}${p.at ? `（在${p.at}）` : ''}`).join('、');
    if (lines.length) lines.push('');
    lines.push(`【数据库里的在场角色】${names}`);
    lines.push('用法：这些人**就在这一场里**，画面要能对上他们的位置；没列的不要凭空加进来。');
  }
  if (on('summary') && facts.summary) {
    if (lines.length) lines.push('');
    lines.push('【数据库纪要·最近一段】（这是已经发生过的事，用来延续状态，不是这一张要画的画面）',
      facts.summary);
    lines.push('用法：体位/接触/脱到哪/关系进展接着这里往下走，别退回更早的状态。');
  }
  return lines;
}

/**
 * 按配置读并格式化 —— 生产链路只调这一个，避免各处自己判断开关。
 *
 * @param {object} cfg 插件配置（读 `cfg.sceneDb`）
 * @returns {string[]} 空数组 = 关闭 / 没读到 / 结构不认识
 */
export function sceneDbPromptLines(cfg) {
  const c = (cfg && cfg.sceneDb) || {};
  if (c.enabled === false) return [];
  const facts = readSceneFacts();
  if (!facts) return [];
  return sceneDbLines(facts, { scene: c.scene, cast: c.cast, summary: c.summary });
}

/** 测试用：清掉内部缓存（目前无缓存，留接口统一） */
export function resetSceneDb() { /* no-op */ }
