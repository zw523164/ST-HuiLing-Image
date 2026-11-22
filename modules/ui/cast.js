/**
 * 绘灵 · 角色档案面板
 *
 * 这里是"人设主权区"的界面入口：
 *   - 锁定（locked）的条目，AI 不能改它的锚点；只有你能改。
 *   - 服装状态位可以在这里手动拨，也可以看 AI 推进到哪一档了。
 *
 * 展示形态（2026-09-26 改）：
 *   角色一多，原来的长列表根本翻不动 —— 现在是**卡片网格**：
 *   每人一张卡，卡上只有形象图 + 名字 + 标签（外貌明细只在编辑面板里，卡片面保持干净），
 *   点卡片整行展开成编辑面板。顶上还有搜索框：角色名 / 标签 / 外貌关键词都能搜。
 *   展开后卡片顶图变成预览：高度可控（右下角手柄拖动 / 双击复位），横竖图自适应。
 *
 * ⚠️ 形象图只是**给你看的参考图**，不参与出图提示词 ——
 *    提示词用的是下面那些英文锚点字段，两张皮互不干扰。
 */

import { escapeHtml } from '../util.js';
import {
  listCast, upsertEntry, removeEntry, stats, exportAll, importAll, clearAllCast,
  getDyn, updateOutfit, getRound, setOutfitSd,
  resolveOutfitStyle, listOutfitPresets, saveOutfitPreset, removeOutfitPreset,
  listPresetCats, setPresetCat, renamePresetCat, getPresetImage, setPresetImage,
  getAvatar, setAvatar, clearAvatar, macroAliasName, outfitStyleFor,
  unlockOutfitStyle, isOutfitStyleUnlocked,
  twinOfSelf, mergeSelfTwins, mergeCastEntries,
  saveAppearance, presetUsageCounts,
} from '../store.js';
import {
  ANCHOR_FIELDS, ANCHOR_FIELD_LABEL, OUTFIT_STATES, OUTFIT_STATE_LABEL,
  OUTFIT_LOCK_LEVELS, OUTFIT_LOCK_LABEL, saveSettings, activeEngine,
  OUTFIT_FOLLOW_MODES, OUTFIT_FOLLOW_LABEL, OUTFIT_STATE_MODES, OUTFIT_STATE_MODE_LABEL,
  SD_ONLY_FIELDS, SD_ONLY_FIELD_LABEL, DYNAMIC_FIELD_KEYS, getConfig,
} from '../settings.js';
import { OUTFIT_STATE_DETAILS, OUTFIT_MODS, OUTFIT_SHOES } from '../outfitStateLibrary.js';
import { outfitGapsOf } from '../outfitLibrary.js';
import { personaSummary } from '../persona.js';
import {
  HAIR_DIMS, MAKEUP_DIMS, optionsFor, composeHair, composeMakeup,
  hairToZh, makeupToZh, resolveHairConflicts, resolveMakeupConflicts,
} from '../appearanceLibrary.js';
import { scanProfile } from '../pipeline.js';
import {
  buildNaturalProfile, aiNaturalProfiles, nlProfilePayload, dictFallbackProfile, aiExpandOutfit,
  aiPresetTool, hasChinese, outfitAskMessages, parseOutfitAskOut, BARE_FALLBACK, anchorOf,
} from '../consistency.js';
import { fixSdOutfit, auditSdOutfit } from '../outfitTagFix.js';
import { callAnalyzeLLM } from '../api.js';
import { getCharWorldBookText, uploadUserFile, deleteUserFile } from '../st.js';
import { info, warn, STAGE } from '../log.js';

/* ---- 自然语输出语言（档案与服装预设共用，本机记忆） ---- */
const NL_LANG_KEY = 'hl_nl_lang';
function nlLang() { return lsGet(NL_LANG_KEY) === 'en' ? 'en' : 'zh'; }
function setNlLang(v) { lsSet(NL_LANG_KEY, v === 'en' ? 'en' : 'zh'); }

/**
 * 按角色名检索角色卡内嵌世界书里的相关设定原文（外貌参考资料的来源）。
 * 铁律：只是把原文交给 AI 提取，插件本身不从里面添任何设定。
 *
 * 检索增强（2026-09-27 实测：世界书里有详细设定却没被用上）：
 * ① 复合名拆段：「小精灵-菲」→ ['小精灵-菲','小精灵','菲'] 多关键词一起匹配，
 *    名字写法与世界书条目名不一致时也能命中；
 * ② 兜底全书：名字完全匹配不上（如单字名被 st.js 的 ≥2 过滤、条目里没写名字）时，
 *    退化为不带关键词检索（全书按「人设/设定」类条目优先返回前段）——
 *    宁可多给参考资料让 AI 自己筛，也不能空手（空 refs = AI 只能照简陋字段硬编）。
 */
function charRefsOf(name) {
  try {
    const segs = String(name || '').split(/[-·・_／/\s]+/).filter(s => s && s !== name);
    const kws = [name, ...segs].filter(Boolean);
    let text = getCharWorldBookText({ keywords: kws, perEntryChars: 600 }) || '';
    if (text.replace(/\s/g, '').length < 100) {
      text = getCharWorldBookText({ keywords: [], perEntryChars: 600 }) || '';
    }
    return text.length > 1800 ? `${text.slice(0, 1800)}\n…（参考资料已截断）` : text;
  } catch { return ''; }
}

/** AI 撰写通道（LLM 出词 API 通道照常生效：跟随主 API / 连接预设 / 独立 API）。 */
async function translateViaAi(items, lang) {
  return aiNaturalProfiles(items, (messages, opts) => callAnalyzeLLM(messages, opts), { lang });
}

/** AI 优先、词典兜底：返回 { map, aiCount, dictCount } */
async function translateProfiles(items) {
  const lang = nlLang();
  const map = {};
  let aiCount = 0;
  const pending = [];
  for (const it of items) {
    const nl = dictFallbackProfile(it.fields, lang);   // 先垫词典版，AI 出结果再覆盖
    if (nl) map[it.name] = nl;
  }
  try {
    // ★ v0.9.90 修复：lang 此前只传给了词典兜底，AI 通道漏传 → 「输出：英文」永远生成中文
    const res = await translateViaAi(items, lang);
    if (res.ok) {
      for (const [name, nl] of Object.entries(res.map)) {
        if (nl) { if (!(name in map)) aiCount += 1; map[name] = nl; pending.push(name); }
      }
      return { map, aiCount: pending.length, dictCount: Object.keys(map).length - pending.length, aiError: '' };
    }
    return { map, aiCount: 0, dictCount: Object.keys(map).length, aiError: res.error || '' };
  } catch (e) {
    return { map, aiCount: 0, dictCount: Object.keys(map).length, aiError: String(e?.message || e || '') };
  }
}

/** 面板内的筛选状态（刷新列表时保留）。 */
const filter = { kw: '', scope: 'all' };

/* ---- 卡片展示样式（比例 + 大小），本机视觉态存 localStorage ---- */
const CARD_AR_KEY = 'hl_cast_card_ar';
const CARD_W_KEY = 'hl_cast_card_w';
const CARD_W_DEFAULT = 168;
const CARD_W_MIN = 120;
const CARD_W_MAX = 360;

function lsGet(key) {
  try { return globalThis.localStorage?.getItem(key) || ''; } catch { return ''; }
}
function lsSet(key, val) {
  try { globalThis.localStorage?.setItem(key, val); } catch { /* 忽略 */ }
}
function lsDel(key) {
  try { globalThis.localStorage?.removeItem(key); } catch { /* 忽略 */ }
}

const cardView = {
  ar: lsGet(CARD_AR_KEY) || '2 / 3',
  w: (() => {
    const n = parseInt(lsGet(CARD_W_KEY), 10);
    return Number.isFinite(n) && n >= CARD_W_MIN && n <= CARD_W_MAX ? n : CARD_W_DEFAULT;
  })(),
};

/** 把展示样式落到卡片网格上。 */
function applyCardView(list) {
  if (!list) return;
  list.style.setProperty('--hl-card-ar', cardView.ar);
  list.style.setProperty('--hl-card-w', `${cardView.w}px`);
}

/**
 * 极简 markdown（只处理 `**粗**` 与 `` `代码` ``）。
 * persona.js 里的说明文字带这两种标记 —— 直接 innerHTML 会把星号显示出来。
 */
function mdLite(s) {
  return escapeHtml(String(s || ''))
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/`(.+?)`/g, '<code>$1</code>');
}

/**
 * 口径适配卡（v0.9.123）。
 *
 * 用户原话：「现在口径多了管理也比较混乱了，特别是角色档案这块。」
 * 解法不是再开一个面板，而是**在档案页直接把当前口径讲清楚**：
 * 谁写外貌、落在哪个字段、改了档案要怎么做才生效、这档最容易踩什么坑。
 *
 * ★ 内容全部来自 `persona.js`（单一真源）。这里只做渲染，不许再写一套 if ——
 *   一旦这里也判口径，就又回到「四处各写一遍、改一处漏三处」的老路。
 */
function renderPersonaCard(container) {
  const box = container.querySelector('#hl-persona-body');
  if (!box) return;
  const s = personaSummary();
  const warnLine = s.canRefresh
    ? '改档案后：直接「重新生成这张」就会按新档案重取（不用重分析本楼）。'
    : '⚠️ 改档案后：<b>必须重新分析本楼</b> —— 这个口径下插件不注入人物文本，「重新生成」只重编译坐标与排版，不会重取档案。';
  box.innerHTML = [
    `<div style="font-weight:700;margin-bottom:6px;">${mdLite(s.headline)}</div>`,
    `<div>当前模版：<b>${escapeHtml(s.templateName)}</b></div>`,
    `<div>外貌与服装落在：${mdLite(s.where)}</div>`,
    `<div>${mdLite(s.refresh)}</div>`,
    `<div>${warnLine}</div>`,
    `<div style="opacity:.8;">易踩的坑：${mdLite(s.plan.note)}</div>`,
    `<div style="opacity:.7;margin-top:4px;">切模版会改变这里 —— 这段说明随当前模版实时更新。</div>`,
  ].join('');
}

function html() {
  return `
<div class="hl-section" id="hl-persona-card">
  <div class="hl-section-title">当前口径 · 外貌与服装怎么进提示词</div>
  <div id="hl-persona-body" class="hl-hint"></div>
</div>

<div class="hl-section">
  <div class="hl-section-title">档案库状态</div>
  <div id="hl-cast-stats" class="hl-stats"></div>
  <div class="hl-actions">
    <button class="hl-btn" id="hl-cast-scan">从角色卡建档</button>
    <button class="hl-btn hl-ghost" id="hl-cast-new">新建角色</button>
    <button class="hl-btn hl-ghost" id="hl-cast-export">导出档案</button>
    <button class="hl-btn hl-ghost" id="hl-cast-import">导入档案</button>
    <button class="hl-btn hl-ghost" id="hl-cast-clearall" title="清空本卡与全局的全部角色档案（清空前自动下载一份备份），方便重新导入">🗑 清空全部档案</button>
  </div>
  <div class="hl-hint">
    建档会读角色卡描述 + 内嵌世界书 + persona，让模型提取每个角色的静态外貌锚点。<br>
    建档是<b>一次性</b>动作；之后的服装与状态变化由每次生图时自动增量维护。
  </div>
  <div class="hl-status" id="hl-cast-status"></div>
</div>

<div class="hl-section" id="hl-preset-section">
  <div class="hl-section-title hl-psec-head" id="hl-preset-sectoggle" title="点这里折叠 / 展开整个服装预设库">
    <span class="hl-psec-arrow" id="hl-preset-secarrow">▾</span>服装预设库（制服类必用）
  </div>
  <div id="hl-preset-secbody">
  <div class="hl-hint">
    「白校服」「OL 套装」这类制式服装，只写两个词是锁不住款式的 ——
    模型每张图都会重新诠释一遍。把成套款式写细到这里命名存好，
    角色档案里引用它（如 <code>@夏季校服</code>），以后所有图都用同一套描述，
    <b>改一次全体同步</b>。点分类标题展开/收起抽屉。
  </div>
  <div class="hl-preset-toolbar">
    <input type="search" id="hl-preset-search" class="hl-input hl-preset-search"
           placeholder="搜索预设名 / 描述关键词…" />
    <select id="hl-preset-catfilter" class="hl-input hl-preset-catfilter" title="按分类筛选">
      <option value="">全部分类</option>
    </select>
    <button class="hl-btn hl-ghost hl-mini" id="hl-preset-expandall" type="button">展开全部</button>
    <button class="hl-btn hl-ghost hl-mini" id="hl-preset-collapseall" type="button">收起全部</button>
    <label class="hl-check hl-preset-bulkmode" title="勾选后每张卡出现复选框，可批量操作">
      <input type="checkbox" id="hl-preset-bulkmode"><span>批量</span>
    </label>
    <span class="hl-spacer"></span>
    <button class="hl-btn hl-ghost hl-mini" id="hl-preset-export" type="button"
      title="把全部预设（含分类与服装图片）导出成一个 JSON 文件备份 / 搬家">⬇导出预设</button>
    <button class="hl-btn hl-ghost hl-mini" id="hl-preset-import" type="button"
      title="从导出的 JSON 文件导入预设（含服装图片）">⬆导入预设</button>
    <label class="hl-cast-view">比例
      <select id="hl-preset-ar" class="hl-input hl-cast-ar" title="预设卡片图的比例">
        <option value="2 / 3">竖图 2:3</option>
        <option value="3 / 4">竖图 3:4</option>
        <option value="1 / 1">方图 1:1</option>
        <option value="4 / 3">横图 4:3</option>
        <option value="16 / 9">横图 16:9</option>
      </select>
    </label>
    <label class="hl-cast-view">大小
      <input type="range" id="hl-preset-size" class="hl-cast-size" min="120" max="360" step="12" title="预设卡片大小" />
    </label>
  </div>
  <div id="hl-preset-list" class="hl-preset-list"></div>
  <div id="hl-preset-bulkbar" class="hl-preset-bulkbar" hidden>
    <span class="hl-preset-bulkcount">已选 <b id="hl-preset-bulkcount">0</b> 项</span>
    <div class="hl-ask-row">
      <input class="hl-input hl-preset-bulk-ask" id="hl-preset-bulk-ask"
             placeholder="AI 指令（供「按指令改」用，如：改性感一点 / 换成黑色系 / 写成中文自然语）" />
      ${presetFmtSelect('hl-preset-bulk-fmt')}
    </div>
    <div class="hl-preset-bulk-ops">
      <button class="hl-btn hl-mini" data-bulk="expand" type="button" title="批量扩写为自然语（语言看下方输出语言）">✨批量扩写</button>
      <button class="hl-btn hl-mini" data-bulk="translate" type="button" title="批量翻译：中文→英文 tag，英文→中文自然语（自动判向）">⇄批量翻译</button>
      <button class="hl-btn hl-mini" data-bulk="tagify" type="button" title="批量整理成英文六要素 tag 串">#批量TAG</button>
      <button class="hl-btn hl-mini" data-bulk="refine" type="button" title="按上面指令框批量 AI 修改">✦按指令改</button>
      <button class="hl-btn hl-mini" data-bulk="cat" type="button" title="把选中项移到某个分类">📁改分类</button>
      <button class="hl-btn hl-mini hl-ghost" data-bulk="del" type="button" title="删除选中的预设">🗑删除</button>
    </div>
  </div>
  <div class="hl-cast-tools">
    <select id="hl-preset-lang" class="hl-input hl-cast-scope" title="自然语输出语言（档案与服装预设共用）">
      <option value="zh">扩写输出：中文自然语</option>
      <option value="en">扩写输出：英文自然语</option>
    </select>
    <span class="hl-hint">每行按钮：✎编辑 · ✨扩写（tag→自然语）· ⇄译（中↔英自动判向）· #TAG（整理成六要素）· ✦AI（按指令修改）。</span>
  </div>
  <div class="hl-grid2">
    <div class="hl-field">
      <label class="hl-label">预设名</label>
      <input class="hl-input" id="hl-preset-name" placeholder="夏季校服">
    </div>
    <div class="hl-field">
      <label class="hl-label">分类（可输入新分类）</label>
      <input class="hl-input" id="hl-preset-newcat" list="hl-preset-cat-list" placeholder="如：校服 / 制服 / 性感 / 家常">
      <datalist id="hl-preset-cat-list"></datalist>
    </div>
  </div>
  <div class="hl-field">
    <label class="hl-label">款式描述（英文 tag 串 · 英文是唯一真值）</label>
    <input class="hl-input" id="hl-preset-text" placeholder="white sailor blouse, navy collar with white stripes, red neckerchief, navy pleated skirt, white knee socks, brown loafers">
    <div class="hl-hint">写<b>英文</b>：这条串会原样进画面词，中文只作显示名。存中文等于每楼翻译一次 —— 同一件衣服会被翻出不同英文，那是在制造漂移。</div>
  <div class="hl-field">
    <label class="hl-label">✦ AI 生成 / 改写指令（想要什么风格直接说，内容随意）</label>
    <div class="hl-ask-row">
      <input class="hl-input" id="hl-preset-ask" placeholder="如：性感的透明睡裙 / 正式的职场西装，裙过膝 / 写成中文自然语，通勤风">
      ${presetFmtSelect('hl-preset-aigen-fmt')}
    </div>
    <div class="hl-hint">填了指令点「✦ AI 生成」：描述为空时按指令从零生成，描述有内容时按指令改写。输出格式默认跟随指令（说写 TAG 就写 TAG，说写中文就写中文），也可用右侧下拉强制指定 —— 结果先填进上面的框，确认后才落库。</div>
  </div>
  <div class="hl-actions">
    <button class="hl-btn hl-ghost" id="hl-preset-aigen">✦ AI 生成款式</button>
    <button class="hl-btn" id="hl-preset-save">保存预设</button>
  </div>
  </div><!-- /hl-preset-secbody -->
</div>

<div class="hl-section">
  <div class="hl-section-title">角色卡片</div>
  <div class="hl-cast-tools">
    <input type="search" id="hl-cast-search" class="hl-input hl-cast-search"
           placeholder="搜索角色名 / 标签 / 外貌关键词（金发、蓝瞳、校服…）" />
    <select id="hl-cast-scope" class="hl-input hl-cast-scope">
      <option value="all">全部角色</option>
      <option value="locked">只看锁定</option>
      <option value="char">只看本角色卡</option>
      <option value="noimg">还没设形象图</option>
    </select>
    <button class="hl-btn hl-ghost hl-mini" id="hl-cast-clear-search" type="button">清空</button>
    <span class="hl-spacer"></span>
    <label class="hl-cast-view">比例
      <select id="hl-cast-ar" class="hl-input hl-cast-ar">
        <option value="2 / 3">竖图 2:3</option>
        <option value="3 / 4">竖图 3:4</option>
        <option value="1 / 1">方图 1:1</option>
        <option value="4 / 3">横图 4:3</option>
        <option value="16 / 9">横图 16:9</option>
      </select>
    </label>
    <label class="hl-cast-view">大小
      <input type="range" id="hl-cast-size" class="hl-cast-size" min="120" max="360" step="12" />
    </label>
    <span class="hl-cast-count" id="hl-cast-count"></span>
  </div>
  <div class="hl-cast-tools">
    <select id="hl-cast-nlmode" class="hl-input hl-cast-scope" title="批量模式">
      <option value="fill">补空模式：只给还没有自然语档案的角色生成</option>
      <option value="rebuild">重建模式：覆盖范围内所有角色（含已锁定）</option>
    </select>
    <select id="hl-cast-nllang" class="hl-input hl-cast-scope" title="自然语输出语言（档案与服装预设共用）">
      <option value="zh">输出：中文自然语</option>
      <option value="en">输出：英文自然语</option>
    </select>
    <button class="hl-btn hl-mini" id="hl-cast-batch-nl" type="button">⚡ 批量生成自然语档案（读世界书 · 按当前筛选范围）</button>
  </div>
  <div class="hl-cast-tools">
    <!-- v0.9.91：SD / 多宫格场景的「服装为什么漂」体检 —— 逐角色列出原因 -->
    <button class="hl-btn hl-mini hl-ghost" id="hl-cast-sdcheck" type="button">🔍 服装稳定档体检（SD / 多宫格专用）</button>
  </div>
  <div class="hl-status" id="hl-cast-sdcheck-out" style="white-space:normal;line-height:1.6;"></div>
  <div class="hl-hint">点卡片展开编辑面板（锚点 / 服装 / 形象图都在里面）；再点一次收起。</div>
  <div id="hl-cast-list" class="hl-cast-grid"></div>
</div>`;
}

/* ============ 单个角色卡片 ============ */

/** 没形象图时的占位：名字首字（中文取第一个字，英文取首字母）。 */
function initialOf(name) {
  const s = String(name || '?').trim();
  return s ? s.slice(0, 1).toUpperCase() : '?';
}

function avatarHtml(name) {
  const url = getAvatar(name);
  if (url) {
    return `<img class="hl-cast-avatar" src="${escapeHtml(url)}" alt="${escapeHtml(name)}" loading="lazy" decoding="async" />`;
  }
  return `<div class="hl-cast-avatar hl-cast-avatar-none"><span>${escapeHtml(initialOf(name))}</span></div>`;
}

/* 展开态预览高度（拖右下角手柄可调，记住上次的大小）。 */
const AV_SIZE_KEY = 'hl_cast_preview_h';
const AV_H_DEFAULT = 300;
const AV_H_MIN = 140;
const AV_H_MAX = 720;

function previewH() {
  let raw = null;
  try { raw = globalThis.localStorage?.getItem(AV_SIZE_KEY); } catch { /* Node 侧无 localStorage */ }
  const n = parseInt(raw || '', 10);
  return Number.isFinite(n) && n >= AV_H_MIN && n <= AV_H_MAX ? n : AV_H_DEFAULT;
}

/** 展开态预览右下角的拖拽手柄：上下拖 = 调预览高度，宽度自适应横竖图。 */
function bindPreviewGrip(card, grip, figure) {
  grip.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    const startY = e.clientY;
    const startH = figure.getBoundingClientRect().height;
    const onMove = (ev) => {
      const h = Math.min(AV_H_MAX, Math.max(AV_H_MIN, Math.round(startH + (ev.clientY - startY))));
      figure.style.setProperty('--hl-av-h', `${h}px`);
      grip.dataset.size = `${h}`;
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      const h = parseInt(figure.style.getPropertyValue('--hl-av-h'), 10);
      if (Number.isFinite(h) && h !== previewH()) {
        try { globalThis.localStorage?.setItem(AV_SIZE_KEY, String(h)); } catch { /* 忽略 */ }
      }
      delete grip.dataset.size;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  });
  grip.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    figure.style.removeProperty('--hl-av-h');
    try { globalThis.localStorage?.removeItem(AV_SIZE_KEY); } catch { /* 忽略 */ }
  });
}

/* 列表上显示的名字：`<user>` 这类宏占位名显示成对应的真名，避免用户以为档案建错了。 */
function aliasOf(name) {
  try { return macroAliasName(name, listCast()) || name; } catch { return name; }
}

/**
 * ★★★ v0.9.145 · 服装「留白」提示的 HTML（卡片与编辑面板共用一段，避免两处说法不一致）。
 *
 * 抽成导出函数是为了**能单测**：纯 innerHTML 拼在模板字符串里的话，
 * 只能靠肉眼点开 UI 才知道有没有显示（记忆里的老坑：功能写了但用户看不见）。
 *
 * @param {string} style  `dyn.outfit.style` 原文
 * @param {'card'|'editor'} where 卡片上说得短，编辑面板里说得细
 */
export function outfitGapHintHtml(style, where = 'card') {
  const r = outfitGapsOf(style);
  const WARN = 'style="border-left-color:#c9761f"';
  if (r.empty) {
    return `<div class="hl-hint" ${WARN}>⚠ <b>没填服装</b> —— `
      + '出图时穿什么由模型自己定，同一楼不同页每次都可能不一样。'
      + '<b>点开编辑补一句。</b></div>';
  }
  if (!r.gaps.length) return '';
  const list = r.gaps.map((g) => `<code>${escapeHtml(g)}</code>`).join('、');
  if (where === 'card') {
    return `<div class="hl-hint" ${WARN}>⚠ 服装有 <b>${r.gaps.length}</b> 件<b>没写颜色</b>（${list}）`
      + ' —— 实测这会让同一楼不同页各穿一套。<b>点开编辑补颜色。</b></div>';
  }
  return `<div class="hl-hint" ${WARN}>⚠ 有 <b>${r.gaps.length}</b> 件<b>没写颜色</b>：${list}`
    + '<br>实测：只写 <code>uniform skirt</code> 时，同一楼第 1 页画成深蓝百褶、第 2 页变成浅色包臀裙 —— '
    + '模型<b>每页自己选一次</b>。补成 <code>navy blue pleated uniform skirt</code> 就统一了。'
    + '<b>改完记得点保存。</b></div>';
}

function makeCard(container, item) {
  const { name, entry, locked, scope } = item;
  const dyn = getDyn(name);
  // 主角的孪生档案（<user> ↔ 真名）—— 只有对方**真的在库里**才算重复
  const twinRaw = twinOfSelf(name);
  const twin = twinRaw && listCast().some(c => c.name === twinRaw) ? twinRaw : '';

  const card = document.createElement('div');
  card.className = 'hl-cast-card';
  card.dataset.name = name;
  card.style.setProperty('--hl-av-h', `${previewH()}px`);

  card.innerHTML = `
    <div class="hl-cast-figure">
      ${avatarHtml(name)}
      ${locked ? '<span class="hl-badge hl-cast-flag">锁定</span>' : ''}
      ${scope === 'global' ? '<span class="hl-badge hl-cast-flag">全局</span>' : ''}
      <span class="hl-av-grip" title="上下拖动调预览大小 · 双击恢复默认" aria-hidden="true"></span>
    </div>
    <div class="hl-cast-meta">
      <div class="hl-cast-name">
        <b>${escapeHtml(aliasOf(name))}</b>
        ${entry?.label ? `<span class="hl-badge">${escapeHtml(entry.label)}</span>` : ''}
      </div>
      ${(aliasOf(name) !== name)
        ? `<div class="hl-hint">这条是上次「一键建档」从用户设定里扫出来的 —— 存档名仍写作 <code>${escapeHtml(name)}</code>，
           出图时按 <b>${escapeHtml(aliasOf(name))}</b> 匹配。<b>字段照常编辑，不用改名。</b></div>`
        : ''}
      ${twin
        ? `<div class="hl-hint" style="border-left-color:#c9761f">⚠ 主角有两条档案：这条与 <b>${escapeHtml(aliasOf(twin))}</b>
           是<b>同一个人</b>。服装已共用，但出图时模型仍会看见两条（一条有服装、一条没有，它就容易照着空的那条自由发挥）——
           <b>建议合并成一条。</b></div>`
        : ''}
      ${(() => {
        /**
         * ★★★ v0.9.145 · 服装留白角标（见 outfitGapHintHtml / outfitGapsOf）。
         * 放在卡片上是为了**不用点进去就能扫出哪些角色没补** ——
         * 实测《雾津市播种计划！》43 个角色里 30+ 个没填服装，逐条点开找太费事。
         * 引用服装预设时不判（预设原文是库里写全的）。
         */
        if (String(dyn?.outfit?.preset || '').trim()) return '';
        return outfitGapHintHtml(dyn?.outfit?.style || '', 'card');
      })()}
    </div>
    <div class="hl-cast-row">
      <button class="hl-btn hl-mini hl-cast-toggle" type="button">编辑</button>
      ${twin ? '<button class="hl-btn hl-mini hl-ghost hl-cast-merge" type="button">合并重复</button>' : ''}
      ${(scope !== 'global' && !locked)
        ? '<button class="hl-btn hl-mini hl-ghost hl-cast-merge-any" type="button">并入…</button>'
        : ''}
      <button class="hl-btn hl-mini hl-ghost hl-cast-del" type="button">删除</button>
    </div>
    <div class="hl-cast-merge-panel" hidden></div>
    <div class="hl-cast-editor" hidden></div>`;

  bindPreviewGrip(card, card.querySelector('.hl-av-grip'), card.querySelector('.hl-cast-figure'));

  const editor = card.querySelector('.hl-cast-editor');

  const toggle = (force) => {
    const show = typeof force === 'boolean' ? force : editor.hasAttribute('hidden');
    if (show) {
      renderEditor(container, editor, item, dyn);
      editor.removeAttribute('hidden');
      card.classList.add('hl-cast-open');
    } else {
      editor.setAttribute('hidden', '');
      card.classList.remove('hl-cast-open');
    }
  };

  card.querySelector('.hl-cast-toggle').addEventListener('click', (e) => {
    e.stopPropagation();
    toggle();
  });

  // 点卡片任意空白处 = 进编辑面板（用户要的"点进去就能编辑"）
  // 手柄要排除：拖完松手浏览器会补一个 click，不能被当成"再点一次收起"
  card.addEventListener('click', (e) => {
    if (e.target.closest('button') || e.target.closest('.hl-cast-editor') || e.target.closest('.hl-av-grip')) return;
    toggle();
  });

  card.querySelector('.hl-cast-del').addEventListener('click', (e) => {
    e.stopPropagation();
    if (!confirm(`确定删除角色「${name}」的档案？`)) return;
    removeEntry(name, { global: scope === 'global' });
    refresh(container);
  });

  /* ---- v0.9.50：手动合并（重复建档兜底） ----
   * 用户真实场景：同一人被建成「隔壁太太」「结城美惠」「结城太太」三条 ——
   * 从提示词的人物段前缀（「结城美惠：…」「结城太太：…」）一眼看出谁跟谁重复了，
   * 在多余那条的卡片上点「并入…」，选保留的目标，一键归并。 */
  const mergePanel = card.querySelector('.hl-cast-merge-panel');
  card.querySelector('.hl-cast-merge-any')?.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!mergePanel.hasAttribute('hidden')) {
      mergePanel.setAttribute('hidden', '');
      return;
    }
    const others = listCast().filter((c) => c.name !== name).map((c) => c.name);
    if (!others.length) {
      setStatus(container, '档案库里没有其他角色，没有可并入的目标');
      return;
    }
    mergePanel.innerHTML = `
      <div class="hl-cast-merge-row">
        <span>把「${escapeHtml(aliasOf(name))}」并入：</span>
        <select class="hl-input hl-cast-merge-target">
          ${others.map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(aliasOf(n))}</option>`).join('')}
        </select>
        <button class="hl-btn hl-mini hl-cast-merge-go" type="button">确认并入</button>
      </div>
      <div class="hl-hint">这条档案会被删除；空缺字段补进目标（目标已有的值不动），服装状态与历史一并搬家。合并前会在诊断日志留档。</div>`;
    mergePanel.removeAttribute('hidden');
    mergePanel.querySelector('.hl-cast-merge-go').addEventListener('click', async (ev) => {
      ev.stopPropagation();
      const target = mergePanel.querySelector('.hl-cast-merge-target')?.value;
      if (!target || target === name) return;
      if (!confirm(
        `把「${escapeHtml(aliasOf(name))}」并入「${escapeHtml(aliasOf(target))}」？\n\n`
        + `· 「${escapeHtml(aliasOf(name))}」的档案会删除，空缺字段补进目标\n`
        + `· 目标已有的外貌/服装值不会被覆盖\n`
        + `· 服装状态与历史一并搬家，合并前会留档到诊断日志`,
      )) return;
      const res = mergeCastEntries(name, target);
      if (!res.ok) {
        alert(`合并失败：${res.reason}`);
        return;
      }
      refresh(container);
      setStatus(container, `已把「${aliasOf(name)}」并入「${aliasOf(target)}」`
        + `（补字段 ${res.movedFields?.join('、') || '无'}）`);
    });
  });

  card.querySelector('.hl-cast-merge')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const target = aliasOf(twin);
    if (!confirm(
      `把主角的占位档案（${escapeHtml(name)}）合并进「${target}」？\n\n`
      + `· 只补空缺字段 —— 已填的外貌不会被覆盖\n`
      + `· 服装取有值的那条\n`
      + `· 合并后占位档案会删除，主角只剩一条\n\n`
      + `确定吗？`,
    )) return;
    const res = mergeSelfTwins();
    if (!res.ok) {
      alert(`合并失败：${res.reason}`);
      return;
    }
    refresh(container);
    setStatus(container, `已把 ${res.moved} 条占位档案合并进「${res.name}」`);
  });

  return card;
}

/* ============ 形象图区（编辑面板顶部） ============ */

function renderAvatarBlock(container, editor, item) {
  const { name, scope } = item;
  const box = editor.querySelector('.hl-av-box');
  if (!box) return;
  const opts = { global: scope === 'global' };

  const paint = () => {
    box.innerHTML = `
      <div class="hl-av-preview">${avatarHtml(name)}</div>
      <div class="hl-av-btns">
        <button class="hl-btn hl-mini hl-av-pick" type="button">选图 / 上传</button>
        <button class="hl-btn hl-mini hl-ghost hl-av-recrop" type="button">重新裁剪</button>
        <button class="hl-btn hl-mini hl-ghost hl-av-clear" type="button">清除</button>
        <div class="hl-hint">
          形象图只是给你在卡片上对照用的<b>参考</b>，不会写进出图提示词 ——
          真正决定画面长相的是下面那些锚点字段。
        </div>
      </div>`;

    box.querySelector('.hl-av-pick').addEventListener('click', async () => {
      try {
        const mod = await import('./avatar.js');
        const data = await mod.makeAvatar({ title: `给「${name}」选一张形象图` });
        if (!data) return;
        setAvatar(name, data, opts);
        paint();
        setStatus(container, `「${name}」的形象图已更新`);
        info(STAGE.UI, `档案「${name}」形象图已更新`);
      } catch (err) {
        warn(STAGE.UI, `头像模块加载失败：${err?.message || err}`);
        setStatus(container, `形象图功能加载失败：${err?.message || err}`, true);
      }
    });

    box.querySelector('.hl-av-recrop').addEventListener('click', async () => {
      try {
        const mod = await import('./avatar.js');
        const data = await mod.recropAvatar(getAvatar(name));
        if (!data) return;
        setAvatar(name, data, opts);
        paint();
        setStatus(container, `「${name}」的形象图已重新裁剪`);
      } catch (err) {
        setStatus(container, `裁剪失败：${err?.message || err}`, true);
      }
    });

    box.querySelector('.hl-av-clear').addEventListener('click', () => {
      if (!getAvatar(name)) { setStatus(container, '这个角色本来就没设形象图'); return; }
      clearAvatar(name, opts);
      paint();
      setStatus(container, `「${name}」的形象图已清除`);
    });
  };

  paint();
}

/* ============ 编辑面板 ============ */

/**
 * 用分析模型把 K2 的自然语服装描述转成 SD（danbooru）短 tag。
 *
 * 口径铁律（照抄 SD 模版 v3 的分工）：
 *   - 逗号分隔、每项 1~4 词、下划线一律写空格
 *     （实测 CLIP 会把 `long_hair` 拆成 long + _ + hair，白烧 token）；
 *   - 删掉 with / and 从句与完整句子，只留 danbooru 真有的写法，不许自造；
 *   - 已经脱掉的衣服不许留在 style，改写成裸露 tag 放进 bare。
 *
 * ★ v0.9.109 新增三条（用户病例 2026-10-20「一下过膝长袜一下短袜」「裙子颜色忽深忽浅」）：
 *   根因不是模型"翻译错了"，是它把**一句话拆成了多条 tag**：
 *     `black over-knee socks` ⇒ `over knee socks, black socks`
 *     `navy pleated school skirt` ⇒ `short skirt, pleated skirt, navy skirt`
 *   多条同部位 tag 在 SD 里是**权重叠加**，模型随机偏向其中一条 —— 视觉上就是漂移。
 *   所以要求「一件衣物一条 tag、颜色与品类写在一起、禁止泛化词与精确词并存」。
 *
 * 只发请求、不碰 DOM —— 手动按钮和「⚡ 自动转换」共用这一份提示词。
 */
async function aiSdOutfitTags(srcStyle, srcBare) {
  const ask = '把 style 与 bare 两半全部改写成 danbooru 短 tag：逗号分隔、每项 1~4 个词、'
    + '下划线一律写成空格、删掉 with / and 从句与所有完整句子。只保留 danbooru 里真实存在的写法，'
    + '不要自造词组。已经脱掉的衣服不要留在 style，改写成裸露部位放进 bare'
    + '（例：naked breasts, pussy, bare legs）。款式颜色照原文，不许改写设定。'
    // —— v0.9.109 三条硬约束 ——
    + '【一件衣物只写一条】颜色必须和品类写在同一条 tag 里：写 black thighhighs，'
    + '不许拆成 black socks + over knee socks；同一件衣服不许同时写泛化词和精确词（写了 thighhighs 就不要再写 socks）。'
    + '【腿袜标准写法】过膝袜 = thighhighs；及膝袜 = kneehighs；短袜 / 一般袜 = socks；连裤袜 = pantyhose。'
    + '禁止写 over-knee socks / thigh-high socks / over the knee socks 这类 danbooru 没有的词组。'
    + '【上下装】一条裙子或一条裤子只写一条 tag，颜色直接修饰品类（navy skirt / navy pleated skirt），'
    + '不许拆成 short skirt + navy skirt + pleated skirt 三条，也不许加原文没有的长度词。';
  const out = await callAnalyzeLLM(outfitAskMessages(srcStyle, srcBare, ask), {
    source: '档案·SD 服装 tag 转换',
    maxTokens: Math.min(2048, Math.max(512, Math.ceil((srcStyle.length + srcBare.length) * 2))),
    temperature: 0.2,
  });
  return parseOutfitAskOut(out);
}

function renderEditor(container, editor, item, dyn) {
  const { name, entry, locked, scope } = item;

  // 字段行 = 固定 7 锚点 + 档案里已有的自定义字段（都可见、可改、可清空）
  const known = new Set(ANCHOR_FIELDS);
  const custom = Object.keys(entry?.fields || {}).filter(f => !known.has(f));
  const fieldHint = {
    face: '面容类型 / 年龄段：loli face / young face / mature face；眼镜等穿戴物件写「标志特征」',
    hair: '发型 / 发色 / 长度；瞳色不要写这里（归「眼睛」）',
    eyes: '瞳色 / 眼型；眼镜不要写这里（归「标志特征」）',
    mark: '眼镜 / 疤痕 / 纹身 / 耳饰等永久物件',
  };
  /**
   * ★ v0.9.96：动态字段标记。
   * 这些字段（状态 / 情绪 / 动作 / 表情）**不会进画面词** —— 它们是上一楼的残留，
   * 拼进「跨轮次永不变的静态锚点」会把上一楼的动作钉死（实测病例见 settings.js 的注释）。
   * 这里标出来是让人知道「填了也不出图」，免得以为没生效。
   */
  const isDynField = (f) => DYNAMIC_FIELD_KEYS.some((d) => String(d).toLowerCase() === String(f).toLowerCase());
  const dynNote = (f) => (isDynField(f) ? '<span class="hl-badge hl-badge-warn">不进画面</span>' : '');
  const rowHtml = (f, val, isCustom) => `
    <div class="hl-field hl-edit-row" data-field="${escapeHtml(f)}">
      <label class="hl-label">${isCustom ? escapeHtml(f) : `${ANCHOR_FIELD_LABEL[f] || f}`} <code>${escapeHtml(f)}</code>${dynNote(f)}</label>
      <input class="hl-input hl-edit-field" data-field="${escapeHtml(f)}" value="${escapeHtml(val || '')}"
        placeholder="${fieldHint[f] ? escapeHtml(fieldHint[f]) : '留空保存 = 删除该字段'}">
    </div>`;
  /** SD 口径专属字段（K2 不读）。放在固定锚点之后。 */
  const sdOnlyRows = SD_ONLY_FIELDS.map((f) => `
    <div class="hl-field hl-edit-row" data-field="${escapeHtml(f)}">
      <label class="hl-label">${escapeHtml(SD_ONLY_FIELD_LABEL[f] || f)} <code>${escapeHtml(f)}</code><span class="hl-badge">仅 SD</span></label>
      <input class="hl-input hl-edit-field" data-field="${escapeHtml(f)}" value="${escapeHtml(entry?.fields?.[f] || '')}"
        placeholder="角色 LoRA 的触发词（如 ilshinjouakane）；紧跟人数词输出，K2 口径忽略">
    </div>`).join('');
  const fixedRows = ANCHOR_FIELDS.map(f => rowHtml(f, entry?.fields?.[f], false)).join('') + sdOnlyRows;
  const customRows = custom.map(f => rowHtml(f, entry?.fields?.[f], true)).join('');
  const engineK2 = activeEngine() === 'k2';

  /* ============ v0.9.70 · 发型 / 妆容维度（建档时细，出图时简） ============
   *
   * ★ 这些下拉**不是**出图时会读的东西 —— 它们只是让人挑得准。
   *   保存时会被 `composeHair/composeMakeup` 合成成**一条**，
   *   出图注入的仍然只有那一条，画面约束数一个都没增加。
   *
   * ★ 原始选择值存在 `entry.spec`（不进画面），状态层的值存在 `dyn.appear`；
   *   两者来源不同 —— 前者是静态人设，后者剧情可以改。
   */
  const hSpec = (entry?.spec?.hair && typeof entry.spec.hair === 'object') ? entry.spec.hair : {};
  const mSpec = (entry?.spec?.makeup && typeof entry.spec.makeup === 'object') ? entry.spec.makeup : {};
  const apNow = (dyn?.appear && typeof dyn.appear === 'object') ? dyn.appear : {};
  const curSex = entry?.fields?.sex || '';
  /** 维度 id → 状态层字段名（只有这两个往后填 dyn.appear）。 */
  const STATE_FIELD = { state: 'hairState', smudge: 'makeupSmudge' };

  const apSelHtml = (groupId, dim) => {
    const bank = groupId === 'hair' ? hSpec : mSpec;
    const cur = dim.state ? (apNow[STATE_FIELD[dim.id]] || '') : (bank[dim.id] || '');
    // en 为空的档（如「无刘海」）根本输出不了画面词 → 不列出来，免得选了看着没反应
    const list = optionsFor(dim.id, curSex).filter((x) => String(x.en || '').trim());
    return `<select class="hl-input hl-ap-dim" data-group="${groupId}" data-dim="${escapeHtml(dim.id)}" data-state="${dim.state ? '1' : ''}">
      <option value="">— 不使用 —</option>
      ${list.map((o) => `<option value="${escapeHtml(o.k)}"${o.k === cur ? ' selected' : ''}>${escapeHtml(o.k)}</option>`).join('')}
    </select>`;
  };
  const apRow = (groupId, dim) => `
    <div class="hl-field">
      <label class="hl-label">${escapeHtml(dim.label)}</label>
      ${apSelHtml(groupId, dim)}
    </div>`;

  const appearBlock = `
    <div class="hl-subtitle">发型 / 妆容 · 分维度挑选</div>
    <div class="hl-grid2">${HAIR_DIMS.map((d) => apRow('hair', d)).join('')}</div>
    <div class="hl-grid2">${MAKEUP_DIMS.map((d) => apRow('makeup', d)).join('')}</div>
    <div class="hl-hint">
      <b>挑得细是为了选得准，不是为了让画面词变长</b> —— 改动会即时合成成一条，填回上面的
      「发型发色 / 妆容」输入框，出图注入的仍然是那一条约束。
      <br>切换时按冲突表自动清掉不合法组合：<b>短发不能扎马尾 / 做大波浪</b>、<b>披散时编发类发饰无处固定</b>、
      <b>素颜不能叠妆面细节、也没有妆可以被弄花</b>。
      <br><b>发状态 / 花妆属于状态层</b>（存在当前会话的动态层里）：剧情里模型可以按档名自己改；
      其余维度是<b>人设</b>，AI 改不动（写过会被硬校验打回）。
      <br>全部留空 = 不动你手填的原文；想清空请直接清空上面输入框。
    </div>`;

  /**
   * v0.9.71 · A2 服装引用闭环（P1 可见 + P2 显式脱离）。
   *
   * ★ 款式框在引用状态下显示的是**预设原文**，不是 o.style ——
   *   旧版显示 o.style，而 resolveOutfitStyle 优先用 preset，于是框里显示的
   *   跟实际注入的完全不是一回事（用户改它也不生效），等于一条永久误导。
   * ★ 口径：框里的内容 == 引用原文 → 保存时保留引用；改了 → 兑现成自由文本并脱链。
   *   两侧配合点在 store.js 的 ①b 判定与「finalStyle !== o.style」那行。
   */
  const refKey = String(dyn?.outfit?.preset || '').trim();
  const refName = refKey
    ? (Object.keys(listOutfitPresets()).find((k) => k === refKey) || refKey)
    : '';
  const styleBoxText = refKey ? resolveOutfitStyle(dyn) : String(dyn?.outfit?.style || '');

  editor.innerHTML = `
    <div class="hl-subtitle">形象图</div>
    <div class="hl-av-box"></div>

    <div class="hl-grid2">
      <div class="hl-field">
        <label class="hl-label">显示名 / 标签</label>
        <input class="hl-input hl-edit-label" value="${escapeHtml(entry?.label || '')}" placeholder="如：女主 / 反派">
      </div>
      <div class="hl-field">
        <label class="hl-label">锁定（AI 不得改锚点）</label>
        <label class="hl-check"><input type="checkbox" class="hl-edit-lock" ${locked ? 'checked' : ''}><span>${scope === 'global' ? '全局条目永远锁定' : '保护这个角色的外貌'}</span></label>
      </div>
    </div>
    <div class="hl-subtitle">静态锚点（出图时 @角色 展开的就是这些字段）</div>
    <div class="hl-grid2">${fixedRows}</div>
    <div class="hl-hint">${engineK2
      ? '<b>K2 中英混合口径：</b>英文短 tag、英文自然语、<b>中文自然语都可以</b>（如「长发及腰的银发少女，眼神慵懒」），会原样拼进画面词。'
      : '英文短 tag 或<b>整句英文自然语</b>都行，会原样拼进画面词（写句子反而更具体）；<b>中文会被自动清洗掉进不了画面</b>，外貌请用英文写。要写中文请把「提示词模版」切到 K2 中英混合模版。'}</div>
    ${appearBlock}
    <div class="hl-subtitle">自然语外貌档案（K2 推荐 ★）</div>
    <div class="hl-field">
      <textarea class="hl-input hl-textarea hl-edit-field" data-field="nlProfile" rows="3"
        placeholder="留空 = K2 人物段回退到上面的逐字段拼接。写中文自然语（贴 v4 定稿写法），如：成年女性；黑色长发，松松的低马尾；白皙肌肤；成熟丰腴，丰满巨乳"></textarea>
      <div class="hl-hint"><b>K2 模版下人物段优先用这一段</b>（不再逐字段拼 tag，杜绝「英文 tag 堆叠」的崩坏感）。
        原则上只写外貌，服装仍归英文段。上面的 tag 字段保留不动（切回 SD 模版时照常使用）。</div>
    </div>
    <div class="hl-actions">
      <button class="hl-btn hl-ghost hl-edit-gennl">⚡ AI 生成自然语档案（读世界书设定）</button>
      <!-- v0.9.90：输出语言就地切换（与档案列表区/服装区的「输出」下拉共用同一份记忆） -->
      <select class="hl-input hl-edit-gennl-lang" title="AI 生成的输出语言（档案与服装扩写共用）" style="width:auto;">
        <option value="zh">中文输出</option>
        <option value="en">英文输出</option>
      </select>
    </div>

    <div class="hl-subtitle">自定义字段（可选，按字段名排序拼进画面 tag）</div>
    <div class="hl-edit-custom">${customRows}</div>
    <div class="hl-hint">${engineK2 ? '支持英文短 tag、英文/中文自然语句子。' : '同样支持英文短 tag 或英文自然语句子；中文会被清洗掉。'}</div>
    <div class="hl-actions">
      <button class="hl-btn hl-ghost hl-edit-addfield">＋ 自定义字段</button>
    </div>

    <div class="hl-subtitle">服装（随剧情推进）</div>
    <div class="hl-grid2">
      <div class="hl-field">
        <label class="hl-label">引用服装预设</label>
        <div class="hl-preset-pick">
          <select class="hl-input hl-edit-outfit-preset-cat" title="按分类筛选（预设多了先用它缩小范围）">
            <option value="">全部分类</option>
            ${allPresetCats(listPresetCats(), Object.keys(listOutfitPresets())).map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('')}
          </select>
          <!-- v0.9.74：原生 select 换成可搜索下拉（输入即过滤；每行右侧显示所属分类） -->
          <div class="hl-combo hl-edit-outfit-preset" data-value="${escapeHtml(dyn?.outfit?.preset || '')}">
            <input class="hl-input hl-combo-input" type="text" ${dyn?.outfit?.preset ? `value="${escapeHtml(dyn.outfit.preset)}"` : ''}
              placeholder="（不用预设，直接写描述）—— 点击选择或输入搜索">
            <div class="hl-combo-list" hidden></div>
          </div>
        </div>
      </div>
      <div class="hl-field">
        <label class="hl-label">款式保护（防漂移强度）</label>
        <select class="hl-input hl-edit-outfit-lock">
          <option value="" ${!dyn?.outfit?.lockLevel ? 'selected' : ''}>跟随全局</option>
          ${OUTFIT_LOCK_LEVELS.map(l => `<option value="${l}" ${dyn?.outfit?.lockLevel === l ? 'selected' : ''}>${OUTFIT_LOCK_LABEL[l]}</option>`).join('')}
        </select>
      </div>
      <!-- v0.9.67 E1：服装跟随剧情 ⇄ 固定死（用户勾选）。与上面「款式保护」是两码事：
           款式保护管的是"模型每楼重描述一遍"的噪声；这里是明确的二选一。 -->
      <div class="hl-field">
        <label class="hl-label">服装模式（跟随 ⇄ 固定）</label>
        <select class="hl-input hl-edit-outfit-follow">
          ${OUTFIT_FOLLOW_MODES.map(m => `<option value="${m}" ${(dyn?.outfit?.followMode || 'auto') === m ? 'selected' : ''}>${OUTFIT_FOLLOW_LABEL[m]}</option>`).join('')}
        </select>
      </div>
      <!-- v0.9.67 E2：状态位跟随剧情 ⇄ 锁定当前档位 -->
      <div class="hl-field">
        <label class="hl-label">状态位模式（跟随 ⇄ 锁定）</label>
        <select class="hl-input hl-edit-outfit-statemode">
          ${OUTFIT_STATE_MODES.map(m => `<option value="${m}" ${(dyn?.outfit?.stateMode || 'auto') === m ? 'selected' : ''}>${OUTFIT_STATE_MODE_LABEL[m]}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="hl-hint">「固定」= 本楼起沿用你最后保存的这套，正文再怎么写都不改；状态位可单独设「锁定」，锁了之后脱衣/穿回也不跟随剧情。</div>
    <div class="hl-field">
      <label class="hl-label">当前着装 · 制式服装请写全六件套（主色/质地 + 领型 + 结或领带 + 上衣 + 下装 + 袜鞋）<br>⚠️ 只写<b>还穿在身上</b>的 —— 已经脱掉的写到这里，画面会把他画回去</label>
      <textarea class="hl-input hl-textarea hl-edit-outfit" rows="4"
        placeholder="white sailor blouse, navy collar with white stripes, red neckerchief, navy pleated skirt, white knee socks, brown loafers">${escapeHtml(styleBoxText)}</textarea>
      <div class="hl-refbar hl-actions" ${refKey ? '' : 'hidden'}>
        <span class="hl-refbadge">⛓ 正在引用服装库「<b>${escapeHtml(refName)}</b>」—— 改库里那条，这身跟着变</span>
        <button class="hl-btn hl-ghost hl-ref-detach" type="button">转为自由文本</button>
      </div>
      ${(() => {
        /**
         * v0.9.46：存量数据现在**会自动拆**（保存时把状态词搬到「裸露部位」），
         * 这里改成告知 + 手动入口。仍然不静默改用户的数据 —— 只在保存那一刻拆，
         * 用户看得见、也能改回去。
         */
        const s = String(styleBoxText || '');
        if (!s) return '';
        if (!/(pulled down|pushed down|slipped off|taken off|down around|around (his|her) (knees|ankles|thighs)|hanging open|unzipped|unbuttoned|off (one|the) shoulder|discarded|removed|bare|naked|nude|exposed|soaked)/i.test(s)) return '';
        return '<div class="hl-hint">⚠️ 这句里混着<b>已经褪下</b>的衣物（pulled down / around his knees 这类）。'
          + '<b>点保存时会自动拆</b>：脱掉的挪到下面「裸露部位」，这里只留还穿着的。'
          + '想自己指定就直接改这两个框。</div>';
      })()}
      <div class="hl-outfit-gap"></div>
    </div>
    <div class="hl-field">
      <label class="hl-label">裸露部位（英文）· 脱掉的那一半写在这里 · 空着 = 没露</label>
      <textarea class="hl-input hl-textarea hl-edit-outfit-bare" rows="3"
        placeholder="naked from the waist down, grey sweatpants and underwear pushed down around his knees">${escapeHtml(dyn?.outfit?.bare || '')}</textarea>
    </div>
    ${(() => {
      /**
       * ★★ v0.9.98 · SD 口径专用服装（用户 2026-10-18 拍板要的"另一套只作用在 SD 的方案"）。
       *
       * 为什么必须另开两个框，而不是共用上面那两个：
       *   K2 是**自然语句**口径 —— 服装写成 `white blouse with sailor collar` 这种句子，
       *   状态靠"衣服还穿在身上、只是被拉开"的措辞表达，服装细节可以原样留着；
       *   SD / Illustrious 是**tag 叠加**口径 —— 每项必须能在 danbooru 原样搜到，
       *   而且"叠上去就是同时成立"，所以脱掉的必须从服装里删掉、改写成裸露 tag。
       *   同一段文字喂两个口径，必然有一边是错的（实测 SD 侧出过
       *   「穿着全套校服 + clothes removed, undressed」同时出现，模型只能随机选）。
       *
       * 显示策略：**始终显示**（不随当前模版隐藏）—— 否则用户切到 K2 时会以为填的内容丢了。
       * 生效策略：只由 SD 口径的锚点读取（consistency.js 的 isSdAnchor 分支），K2 完全不读。
       */
      const sdOn = activeEngine() === 'sd';
      const sdAutoOn = getConfig().autoSdOutfit === true;
      return `
    <div class="hl-field">
      <label class="hl-label">SD 口径专用 · 服装 tag（逗号分隔的 danbooru 短 tag，<b>只写还穿在身上</b>的）
        <span class="hl-tag-sd">${sdOn ? '当前口径生效中' : '当前是 K2 口径 · 不生效'}</span></label>
      <textarea class="hl-input hl-textarea hl-edit-outfit-sd" rows="3"
        placeholder="white blouse, open shirt, pleated skirt, black thighhighs, black pumps">${escapeHtml(dyn?.outfit?.styleSd || '')}</textarea>
      <div class="hl-actions">
        <button class="hl-btn hl-ghost hl-outfit-sd-convert" type="button">✨ 把上面的 K2 描述转成 SD tag</button>
        <button class="hl-btn hl-ghost hl-outfit-sd-fix" type="button"
          title="把同一件衣服的多条 tag 合并成一条、把 over-knee socks 这类非标准写法换成 danbooru 标准 tag（thighhighs）。★ 保存时会自动做，这个按钮只是让你提前看一眼结果">🩹 归一</button>
        <label class="hl-check hl-outfit-sd-auto-wrap" title="开启后：这个框空着时，保存会自动把上面的 K2 描述转成 SD tag 并落库（已经填过内容的一律不覆盖）">
          <input type="checkbox" class="hl-outfit-sd-auto" ${sdAutoOn ? 'checked' : ''}>
          <span>⚡ 自动转换</span>
        </label>
      </div>
      <div class="hl-hint hl-outfit-sd-auto-hint">
        ${sdAutoOn
          ? '⚡ <b>自动转换已开</b>：框空着就自动补 —— 保存时转一次，勾上开关时也会立刻转当前这张。<b>已填过的内容不会被覆盖</b>。'
          : '空着 = SD 下回落上面的 K2 描述（长句会被打折）。想省掉手动点按钮，就勾「⚡ 自动转换」。'}
      </div>
      <div class="hl-report hl-outfit-sd-audit"></div>
    </div>
    <div class="hl-field">
      <label class="hl-label">SD 口径专用 · 裸露 tag（脱掉的那一半 · 空着且状态=褪下时写 completely nude）</label>
      <textarea class="hl-input hl-textarea hl-edit-outfit-sd-bare" rows="2"
        placeholder="naked breasts, pussy, bare legs">${escapeHtml(dyn?.outfit?.bareSd || '')}</textarea>
      <div class="hl-hint">SD 下留空 → 回落上面的 K2 描述（长句会被打折，出图时会提示你）。填了就以这里为准。</div>
    </div>`;
    })()}
    <div class="hl-field hl-outfit-ask">
      <label class="hl-label">✨ AI 优化服装态 · 把要改的点写成指令，AI 改完填回上面两个框（<b>点「保存」才生效</b>，AI 不直接动档案）</label>
      <textarea class="hl-input hl-textarea hl-outfit-ask-ta" rows="2"
        placeholder="例：把黑丝换成白丝；删掉所有首饰描写；外套已经脱掉搭在椅背上（挪进裸露部位）；指令没提的内容保持原样"></textarea>
      <div class="hl-actions">
        <button class="hl-btn hl-ghost hl-outfit-ask-go" type="button">✨ AI 按指令优化服装态</button>
        <span class="hl-hint">输出仍是英文 style + bare 两框，确认无误再保存</span>
      </div>
    </div>
    <div class="hl-grid2">
      <div class="hl-field">
        <label class="hl-label">状态位</label>
        <select class="hl-input hl-edit-outfit-state">
          ${OUTFIT_STATES.map(s => `<option value="${s}" ${dyn?.outfit?.state === s ? 'selected' : ''}>${OUTFIT_STATE_LABEL[s]}（${s}）</option>`).join('')}
        </select>
      </div>
    </div>
    <!--
      v0.9.99 · 角色档案诊断（用户 2026-10-19：「这里可以给个大的文字诊断框，
     这样我就知道我使用了哪些，哪些分类内容是实际填进生图提示词里的」）。
      内容按**框里当前内容 + 当前口径**算，改一个框立刻重算；
      另附一段「已保存版本的锚点真值」（直接调 anchorOf，不模拟）。
    -->
    <div class="hl-field hl-cast-diag">
      <label class="hl-label">🔍 这份档案实际进提示词的内容
        <button class="hl-btn hl-ghost hl-mini hl-cast-diag-copy" type="button">复制</button>
      </label>
      <pre class="hl-cast-diag-box"></pre>
      <div class="hl-hint">外貌与服装按<b>框里当前内容</b>算（改了还没保存也会显示）；出图真值以「已保存版本」那一段为准。</div>
    </div>

    <!--
      v0.9.69 · 服装三维度（状态细档 / 改造 / 鞋袜）
      v0.9.74 · 应用户要求放开 NSFW 门禁：SFW 普通模式同样可选、同样进画面
        （库档名本身就是明确的画面词，选保守档就是保守画面）。
    -->
    <div class="hl-grid2">
      <div class="hl-field">
        <label class="hl-label">状态细档</label>
        <select class="hl-input hl-edit-outfit-detail">
          <option value="">不使用（沿用上面的五档状态位）</option>
          ${OUTFIT_STATE_DETAILS.map(d => `<option value="${escapeHtml(d.key)}" ${dyn?.outfit?.stateDetail === d.key ? 'selected' : ''}>${escapeHtml(d.key)}${d.mode === 'replace' ? '（替换款式）' : ''}</option>`).join('')}
        </select>
      </div>
      <div class="hl-field">
        <label class="hl-label">改造维度</label>
        <select class="hl-input hl-edit-outfit-mod">
          <option value="">不使用</option>
          ${OUTFIT_MODS.map(m => `<option value="${escapeHtml(m.key)}" ${dyn?.outfit?.mod === m.key ? 'selected' : ''}>${escapeHtml(m.key)}</option>`).join('')}
        </select>
      </div>
      <div class="hl-field">
        <label class="hl-label">鞋袜</label>
        <select class="hl-input hl-edit-outfit-shoes">
          <option value="">不指定（沿用款式里写的鞋袜）</option>
          ${OUTFIT_SHOES.map(s => `<option value="${escapeHtml(s.key)}" ${dyn?.outfit?.shoes === s.key ? 'selected' : ''}>${escapeHtml(s.key)}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="hl-hint">这三项 <b>SFW / NSFW 都进画面</b>（v0.9.74 起）。
      状态细档里标「替换款式」的那几档（全裸 / 仅剩配饰 / 只余内衣 / 浴巾遮身）会<b>整段替换</b>上面的款式描述；
      选了鞋袜档时，款式描述里自带的鞋袜会被<b>自动剥掉</b>，避免脚上出现两套。</div>

    <div class="hl-actions">
      <button class="hl-btn hl-cast-save">保存</button>
      ${(() => {
        /**
         * v0.9.47「解锁款式」：剧情确实换了衣服但扫描没跟上时（正文没写「换上」、
         * 也没踩中场景切换），防漂移闸门会一直挡着。点一下放行**下一次**改写。
         */
        const pend = dyn?.outfit?.pending;
        if (isOutfitStyleUnlocked(name)) {
          return '<span class="hl-hint hl-inline">款式已解锁 —— 下一次扫描报新款时会放行（用后自动失效）</span>';
        }
        return `<button class="hl-btn hl-ghost hl-cast-unlock" type="button" title="剧情换了衣服但插件没跟上时用：放行下一次款式改写">解锁款式</button>`
          + (pend?.style
            ? `<span class="hl-hint hl-inline">剧情里提到过另一套「${escapeHtml(String(pend.style).slice(0, 40))}」已 ${Number(pend.count || 0)} 次</span>`
            : '');
      })()}
      <button class="hl-btn hl-ghost hl-cast-close">收起</button>
    </div>`;

  renderAvatarBlock(container, editor, item);

  // v0.9.74：预设下拉 = 可搜索自定义组件（setupPresetCombo 提供 value / change 接口）
  const presetCombo = editor.querySelector('.hl-edit-outfit-preset');
  setupPresetCombo(presetCombo);

  // 引用预设的分类筛选：换分类就重建下拉列表（当前已选的还在该分类里则保留）
  editor.querySelector('.hl-edit-outfit-preset-cat')?.addEventListener('change', (ev) => {
    presetCombo?._setCatFilter(ev.currentTarget.value);
  });

  /**
   * v0.9.71 · A2 服装引用闭环。
   *
   * ★ 下拉一换就把款式框填成该条的内容 —— 让「引用了什么」变成看得见的东西。
   *   旧的 UI 里选完预设框里还是上次的自由文本，跟实际注入的完全是两回事。
   *
   * ★ 选回「不用预设」时 **不清空** 框：
   *   用户可能是误选了一下想退回去，清空会把原来的款式弄丢。
   *   保留当前内容 = 兑现成自由文本，正是想要的语义（点保存才落盘）。
   */
  const syncRefBar = (key) => {
    const bar = editor.querySelector('.hl-refbar');
    if (!bar) return;
    if (!key) { bar.setAttribute('hidden', ''); return; }
    bar.removeAttribute('hidden');
    const b = bar.querySelector('.hl-refbadge');
    if (b) b.innerHTML = `⛓ 正在引用服装库「<b>${escapeHtml(key)}</b>」—— 改库里那条，这身跟着变`;
  };

  editor.querySelector('.hl-edit-outfit-preset')?.addEventListener('change', (ev) => {
    const key = String(ev.currentTarget.value || '').trim();
    const ta = editor.querySelector('.hl-edit-outfit');
    if (key && ta) ta.value = String(listOutfitPresets()[key] || '');
    syncRefBar(key);
    if (key) setStatus(`已选中「${key}」—— 下面框里填的就是它的内容，改动后即转为自由文本（点保存生效）`);
  });

  editor.querySelector('.hl-ref-detach')?.addEventListener('click', () => {
    const sel = editor.querySelector('.hl-edit-outfit-preset');
    if (sel) sel.value = '';
    syncRefBar('');
    setStatus('已转为自由文本（点保存生效）—— 这段现在是独立款式，不再跟着服装库变');
  });

  /**
   * ★★★ v0.9.145 · 服装「留白」实时提示。
   *
   * 用户报的是「服装漂移」，真因是档案**没写颜色款式** —— 模型每页自己选一次。
   * 补上就统一（实测爱丽莎：只写 `uniform skirt` → p1 深蓝百褶 / p2 浅色包臀；
   * 补成 `navy blue pleated uniform skirt` → 两页一致）。
   * 所以这里不替他写，只在**缺口存在时**指出来，让他自己补。
   */
  const gapBox = editor.querySelector('.hl-outfit-gap');
  const renderGap = () => {
    if (!gapBox) return;
    const ta = editor.querySelector('.hl-edit-outfit');
    gapBox.innerHTML = outfitGapHintHtml(ta ? ta.value : '', 'editor');
  };
  renderGap();
  editor.querySelector('.hl-edit-outfit')?.addEventListener('input', renderGap);

  editor.querySelector('.hl-cast-unlock')?.addEventListener('click', () => {
    if (!unlockOutfitStyle(name)) return;
    setStatus(`「${name}」的款式已解锁 —— 下一次扫描读到剧情里的新款时会放行（一次性，用后失效）`);
    refresh(container);
  });

  editor.querySelector('.hl-cast-close').addEventListener('click', () => {
    editor.setAttribute('hidden', '');
    editor.closest('.hl-cast-card')?.classList.remove('hl-cast-open');
  });

  // ＋ 自定义字段：行内加一个 名字+值 的输入对（保存时并入 fields）
  editor.querySelector('.hl-edit-addfield').addEventListener('click', () => {
    const fname = prompt('字段名（英文，如 accessory、 aura）：');
    if (!fname) return;
    const key = fname.trim().toLowerCase().replace(/\s+/g, '_');
    if (!key) return;
    const box = editor.querySelector('.hl-edit-custom');
    const row = document.createElement('div');
    row.className = 'hl-field hl-edit-row';
    row.innerHTML = `
      <label class="hl-label">${escapeHtml(key)} <code>${escapeHtml(key)}</code></label>
      <input class="hl-input hl-edit-field" data-field="${escapeHtml(key)}" placeholder="英文短 tag；留空保存 = 不添加">`;
    box.appendChild(row);
    row.querySelector('input').focus();
  });

  // ⚡ 一键生成自然语档案：读编辑器当前输入（含未保存的修改）。
  //   AI 撰写优先：档案字段 + 该角色相关的世界书/角色卡设定原文一起交给 AI，
  //   提取外貌写成连贯自然语（字段简陋时描述才有血肉）；失败/未配置回落内置词典。
  //   只做预览填充，落库仍由「保存」按钮决定（人设主权区铁律）。
  // v0.9.90：编辑器内加输出语言下拉（与列表区「输出」下拉共用记忆，双向同步）。
  {
    const langSel = editor.querySelector('.hl-edit-gennl-lang');
    if (langSel) {
      langSel.value = nlLang();
      langSel.addEventListener('change', () => {
        setNlLang(langSel.value);
        // 列表区 / 服装预设区的两个下拉同步（在同一面板 DOM 里就一并刷新）
        for (const sel of [container.querySelector('#hl-cast-nllang'), container.querySelector('#hl-preset-lang')]) {
          if (sel) sel.value = langSel.value;
        }
        setStatus(container, `自然语输出语言已切换为${langSel.value === 'en' ? '英文' : '中文'}（档案与服装扩写共用）`);
      });
    }
  }
  editor.querySelector('.hl-edit-gennl').addEventListener('click', async (ev) => {
    const btnEl = ev.currentTarget;
    const fields = {};
    editor.querySelectorAll('.hl-edit-field').forEach(inp => {
      const v = inp.value.trim();
      if (v) fields[inp.dataset.field] = v;
    });
    const box = editor.querySelector('textarea[data-field="nlProfile"]');
    const refs = charRefsOf(name);
    if (!Object.keys(fields).length && !refs) {
      setStatus(container, '没有可撰写的内容 —— 先填外貌字段（hair/eyes/body…），或在世界书里写好角色设定', true);
      return;
    }
    btnEl.disabled = true;
    setStatus(container, `正在撰写自然语档案（读世界书 · ${nlLang() === 'en' ? '英文' : '中文'}输出 · 通常几秒到十几秒）…`);
    try {
      const res = await translateProfiles([{ name, fields, refs }]);
      const nl = res.map[name] || '';
      if (!nl) {
        setStatus(container, '没有可撰写的内容 —— 字段和世界书里都找不到外貌信息', true);
        return;
      }
      box.value = nl;
      setStatus(container, res.aiCount
        ? '已生成（AI 读世界书撰写）—— 检查一遍有没有擅自添加的设定，点「保存」才生效'
        : `已生成（内置词典兜底${res.aiError ? `：AI 不可用 ${res.aiError}` : ''}）—— 点「保存」才生效`);
    } finally {
      btnEl.disabled = false;
    }
  });

  /* ============ v0.9.70 · 发型 / 妆容联动 ============ */

  // 上次由下面这段逻辑写进 nlProfile 的片段 —— 摘掉它才能做到幂等。
  // 不能每次都拿 `entry.spec.nlAppear` 去摘：连续改两次下拉时，第二次要摘的其实是第一次刚写进去的。
  let lastNlFrag = String(entry?.spec?.nlAppear || '');

  const readApSpec = (groupId) => {
    const out = {};
    editor.querySelectorAll(`.hl-ap-dim[data-group="${groupId}"]`).forEach((sel) => {
      if (sel.dataset.state === '1') return;   // 状态层不进人设 spec
      const v = String(sel.value || '').trim();
      if (v) out[sel.dataset.dim] = v;
    });
    return out;
  };

  /** 性别一变，性别专属的档（男/女）要整个换一批。 */
  const rebuildApOptions = () => {
    const sexNow = String(editor.querySelector('.hl-edit-field[data-field="sex"]')?.value || '');
    editor.querySelectorAll('.hl-ap-dim').forEach((sel) => {
      const dimId = sel.dataset.dim;
      const dim = [...HAIR_DIMS, ...MAKEUP_DIMS].find((d) => d.id === dimId);
      if (!dim) return;
      const cur = String(sel.value || '');
      const list = optionsFor(dimId, sexNow).filter((x) => String(x.en || '').trim());
      sel.innerHTML = '<option value="">— 不使用 —</option>'
        + list.map((o) => `<option value="${escapeHtml(o.k)}">${escapeHtml(o.k)}</option>`).join('');
      sel.value = cur;   // 新性别下没有这一档 → 自动落回「不使用」
    });
  };

  const syncAppearFields = () => {
    const h2 = resolveHairConflicts(readApSpec('hair'));
    const m2 = resolveMakeupConflicts(readApSpec('makeup'));

    // 被冲突规则清掉的维度 → 下拉拨回「不使用」，让 UI 和实际生效的规则保持一致
    editor.querySelectorAll('.hl-ap-dim').forEach((sel) => {
      if (sel.dataset.state === '1') return;
      const bank = sel.dataset.group === 'hair' ? h2.spec : m2.spec;
      if (sel.value && bank[sel.dataset.dim] !== sel.value) sel.value = '';
    });

    const hb = composeHair(h2.spec);
    const mb = composeMakeup(m2.spec);
    const pick = (f) => editor.querySelector(`.hl-edit-field[data-field="${f}"]`);
    // ★ 空串 = 这次没挑 → 不动那一栏（保住旧档案里手写的原文）
    if (hb.en) { const el = pick('hair'); if (el) el.value = hb.en; }
    if (mb.en) { const el = pick('makeup'); if (el) el.value = mb.en; }

    /**
     * K2 自然语档案同步：先摘掉上次写进去的那段，再写新的 —— 幂等。
     * 不去猜用户句子里哪一段是发型（必猜错，还会删掉别的内容）。
     */
    const add = hairToZh(h2.spec) + makeupToZh(m2.spec);
    const nlEl = pick('nlProfile');
    if (nlEl) {
      let cur = String(nlEl.value || '');
      if (lastNlFrag && cur.includes(lastNlFrag)) cur = cur.replace(lastNlFrag, '');
      const merged = String(add + cur || '').replace(/；{2,}/g, '；').replace(/，{2,}/g, '，').trim();
      if (add || lastNlFrag) nlEl.value = merged;
    }
    lastNlFrag = add;

    const cleared = [...h2.cleared, ...m2.cleared];
    if (cleared.length) setStatus(container, `已按冲突表清理：${cleared.join('；')}`);
  };

  editor.addEventListener('change', (ev) => {
    if (ev.target?.classList?.contains('hl-ap-dim')) syncAppearFields();
    else if (ev.target?.dataset?.field === 'sex') rebuildApOptions();
  });

  // ✨ AI 优化服装态（v0.9.60）：读两个框的现值 + 用户指令 → AI 改写 → 填回两个框。
  //   与自然语档案同一个铁律：**只做预览填充，落库仍由「保存」按钮决定**（人设主权区）。
  editor.querySelector('.hl-outfit-ask-go')?.addEventListener('click', async (ev) => {
    const btnEl = ev.currentTarget;
    const styleEl = editor.querySelector('.hl-edit-outfit');
    const bareEl = editor.querySelector('.hl-edit-outfit-bare');
    const askEl = editor.querySelector('.hl-outfit-ask-ta');
    if (!styleEl || !bareEl) return;
    const style = styleEl.value.trim();
    const bare = bareEl.value.trim();
    if (!style && !bare) {
      setStatus(container, '两个框都是空的 —— 先填当前着装（或裸露部位），再让 AI 改', true);
      return;
    }
    const ask = String(askEl?.value || '').trim();
    btnEl.disabled = true;
    const oldLabel = btnEl.textContent;
    btnEl.textContent = '✨ AI 分析中…';
    try {
      const out = await callAnalyzeLLM(outfitAskMessages(style, bare, ask), {
        source: '档案·服装态优化',
        maxTokens: Math.min(2048, Math.max(512, Math.ceil((style.length + bare.length) * 2))),
        temperature: 0.3,
      });
      const parsed = parseOutfitAskOut(out);
      if (!parsed.ok) {
        setStatus(container, `AI 优化服装态失败：${parsed.error}（原因见「诊断」页）`, true);
        return;
      }
      if (parsed.style !== null) styleEl.value = parsed.style;
      if (parsed.bare !== null) bareEl.value = parsed.bare;
      setStatus(container, 'AI 已把结果填进上面两个框 —— 检查无误后点「保存」才生效（AI 不直接动档案）');
      info(STAGE.UI, `档案「${name}」服装态 AI 优化完成（指令：${ask ? ask.slice(0, 40) : '（无，梳理）'}）`);
    } catch (err) {
      setStatus(container, `AI 优化服装态失败：${err?.message || err}`, true);
      warn(STAGE.UI, `服装态 AI 优化失败：${err?.message || err}`);
    } finally {
      btnEl.disabled = false;
      btnEl.textContent = oldLabel;
    }
  });

  /* ---- v0.9.99 · 角色档案诊断（大的文字框；SD / K2 两个口径都覆盖） ---- */
  /**
   * 用户要求（2026-10-19）：
   *   「这里可以给个大的文字诊断框，这样我就知道我使用了哪些，
   *     哪些分类内容是实际填进生图提示词里的」+「K2 也要同步更新」。
   *
   * 两段信息，用途不同：
   *   ① 逐字段清单 —— 按**框里当前值**算（改了没保存也看得见），告诉你"用了哪些"；
   *   ② 已保存版本的锚点串 —— 直接调 `anchorOf()`（唯一真值，不模拟），
   *      这才是出图时真正进提示词的那一段。
   * 「当前口径不读」那一节按 `anchorOf` 的真实分支写，不是凭印象。
   */
  const diagBox = editor.querySelector('.hl-cast-diag-box');
  const renderCastDiag = () => {
    if (!diagBox) return;
    const isSd = activeEngine() === 'sd';
    const cfg = getConfig();
    const sdOpt = cfg.sdOptions || {};
    const engineName = isSd ? 'SD（Illustrious 系 · 只认 danbooru tag）' : 'K2（Krea2 · 自然语句 + tag）';
    const L = [];
    const push = (s = '') => L.push(s);
    const dirty = [];

    /* ① 外貌锚点：逐字段 */
    push(`【${name}】当前口径：${engineName}`);
    push(`档案归属：${scope === 'global' ? '全局（所有聊天共用）' : '角色卡'}${locked ? ' · 已锁定（AI 不改这条）' : ''}`);
    push('');
    push('■ 会进提示词 · 外貌锚点（按框里当前内容）');
    let filled = 0;
    for (const k of ANCHOR_FIELDS) {
      const inp = editor.querySelector(`.hl-edit-field[data-field="${k}"]`);
      const v = String(inp?.value ?? entry?.fields?.[k] ?? '').trim();
      const saved = String(entry?.fields?.[k] ?? '').trim();
      if (v) filled += 1;
      if (v !== saved) dirty.push(k);
      push(`  ${k.padEnd(9)}${v || '(空)'}`);
    }
    push(`  有值 ${filled} / ${ANCHOR_FIELDS.length} 项`);
    /**
     * nlProfile（人设档案整句）单独一行：它是 FIELD_SCOPE 里唯一
     * 「K2 读 / SD 丢」的长文本字段（settings.js:178），也是用户最容易
     * 以为"写了就一定进画面"的一项。
     *
     * ★ 编辑器里 nlProfile 有**两个**同名控件（自定义字段自动生成的 input 带值、
     *   下面手写的 textarea 是空壳）—— 所以取「第一个非空」而不是 querySelector
     *   的第一个（那个是空壳，会误报"没写"）。保存时靠 DOM 顺序（input 在后）
     *   才没被清空，这点已实测确认。
     */
    const nlVal = Array.from(editor.querySelectorAll('.hl-edit-field[data-field="nlProfile"]'))
      .map((el) => String(el.value || '').trim())
      .filter(Boolean)[0] || String(entry?.fields?.nlProfile || '').trim();
    if (nlVal) {
      push(`  nlProfile ${nlVal.slice(0, 100)}${nlVal.length > 100 ? '…' : ''}`);
      push(`            → ${isSd ? 'SD 不读（自然语整句在 tag 口径里是噪声）' : 'K2 会读（作为人设自然语）'}`);
    }
    const sexV = String(editor.querySelector('.hl-edit-field[data-field="sex"]')?.value || '').trim();
    if (isSd && !sexV) {
      push('  ⚠ sex 空着 → SD 不会写 1girl / 1boy，多人同框最容易串台');
    }
    push('');

    /* ② 服装：两个口径吃的是两套字段 */
    const k2Style = String(editor.querySelector('.hl-edit-outfit')?.value || '').trim();
    const k2Bare = String(editor.querySelector('.hl-edit-outfit-bare')?.value || '').trim();
    const sdStyle = String(editor.querySelector('.hl-edit-outfit-sd')?.value || '').trim();
    const sdBare = String(editor.querySelector('.hl-edit-outfit-sd-bare')?.value || '').trim();
    const state = editor.querySelector('.hl-edit-outfit-state')?.value || 'intact';
    const detail = editor.querySelector('.hl-edit-outfit-detail')?.value || '';
    const mod = editor.querySelector('.hl-edit-outfit-mod')?.value || '';
    const shoes = editor.querySelector('.hl-edit-outfit-shoes')?.value || '';
    const stateZh = OUTFIT_STATE_LABEL[state] || state;
    const removed = state === 'removed';

    if (isSd) {
      const effStyle = sdStyle || k2Style;
      const effBare = sdBare || k2Bare;
      push('■ 会进提示词 · 服装（SD 专用 tag）');
      push(`  服装 tag  ${effStyle || '(空)'}`);
      if (effBare) push(`  裸露 tag  ${effBare}`);
      if (sdStyle) {
        const n = sdStyle.split(',').filter((x) => x.trim()).length;
        push(`  → ≈ ${n} 项 · ${sdStyle.length} 字符 · 用的是 SD 专用 tag`);
      } else if (k2Style) {
        push('  ⚠ SD 服装 tag 空着 → 回落 K2 的长句描述（会被打折）');
      }
      if (removed) {
        push(`  状态=褪下 → 不拼服装 tag，只拼裸露 tag（空则写 ${BARE_FALLBACK}）`);
      }
    } else {
      const style = k2Style || outfitStyleFor(name) || '';
      push('■ 会进提示词 · 服装（K2 自然语）');
      push(`  款式      ${style || '(未设置)'}`);
      if (k2Bare) push(`  裸露部位  ${k2Bare}`);
      const own = resolveOutfitStyle(dyn) || '';
      const twinName = twinOfSelf(name);
      if (!own && outfitStyleFor(name) && twinName) {
        push(`  （这条没记服装，画面用同一人的另一条档案「${twinName}」的款式）`);
      }
    }
    push('');

    /* ③ 状态：两个口径都读三维度，但 removed 时只读细档 */
    push('■ 会进提示词 · 状态');
    push(`  状态位    ${stateZh}（${state}）`);
    push(`  细档      ${detail || '(未选)'}`);
    push(`  改造      ${mod || (removed ? '(未选)' : '(未选)')}`);
    push(`  鞋袜      ${shoes || '(未选)'}`);
    if (removed && (mod || shoes)) {
      push('  注：状态=褪下时，改造 / 鞋袜不会拼进提示词（都脱光了不该还有鞋）');
    }
    push('');

    /* ④ 动态字段（每楼会变的那些，dyn.fields） */
    const dynFields = dyn?.fields || {};
    const dynKeys = ['condition', 'wound', 'mood', 'held'].filter((k) => String(dynFields[k] || '').trim());
    if (dynKeys.length) {
      const excluded = isSd && sdOpt.excludeDynamic !== false;
      push(`■ 动态字段（${excluded ? '当前设置：不读' : '会进提示词'}）`);
      for (const k of dynKeys) push(`  ${k.padEnd(9)}${dynFields[k]}`);
      if (excluded) push('  注：SD 下勾了「排除动态字段」→ 上面这些不进锚点（防上一楼动作被钉死）');
      else if (!isSd) push('  注：K2 的动作走 cast 段，这几项会跟着锚点一起进画面');
      push('');
    }

    /* ⑤ 当前口径不读的 */
    push('■ 当前口径不读（不会进提示词）');
    if (isSd) {
      push('  · nlProfile（K2 自然语整句）—— SD 只吃 tag，整句是噪声');
      if (!dynKeys.length) push('  · 动态字段 —— 当前没有值');
    } else {
      push('  · SD 服装 tag / SD 裸露 tag —— K2 完全不用');
      push('  · LoRA 触发词、人数词（1girl / 1boy）—— K2 禁写人数声明');
      if (!String(dynFields.condition || '').trim() && !String(dynFields.mood || '').trim()) {
        push('  · 动态字段 —— 当前没有值');
      }
    }
    push('');

    /* ⑥ 已保存版本的锚点真值（直接调 anchorOf，绝不模拟） */
    push('■ 已保存版本的锚点串（出图真值 · anchorOf 实际输出）');
    let real = '';
    try {
      real = anchorOf(name, { entry, dyn }) || '';
    } catch (err) {
      real = `(计算失败：${err?.message || err})`;
    }
    push(real ? `  ${real}` : '  (空 —— 这个角色没有任何锚点，画面全靠模型自由发挥)');
    if (real && !real.startsWith('(')) {
      const n = real.split(',').filter((x) => x.trim()).length;
      push(`  → ≈ ${n} 项 · ${real.length} 字符${real.length > 300 ? ' · ⚠ 偏长，过了 77 token 的部分只影响局部' : ''}`);
    }
    push('');

    /* ⑦ 未保存提示 */
    const dirtyOutfit = [
      ['服装', k2Style, String(dyn?.outfit?.style || '').trim()],
      ['裸露部位', k2Bare, String(dyn?.outfit?.bare || '').trim()],
      ['SD 服装 tag', sdStyle, String(dyn?.outfit?.styleSd || '').trim()],
      ['SD 裸露 tag', sdBare, String(dyn?.outfit?.bareSd || '').trim()],
    ].filter(([, a, b]) => a !== b).map(([k]) => k);
    const pend = dirty.concat(dirtyOutfit);
    if (pend.length) {
      push(`⚠ 有未保存的改动：${pend.slice(0, 6).join('、')}${pend.length > 6 ? ' 等' : ''}`);
      push('  点「保存」后才按上面的内容进画面（「已保存版本的锚点串」那段在保存前仍是旧的）。');
    } else {
      push('✓ 框里内容与已保存档案一致。');
    }

    diagBox.textContent = L.join('\n');
  };

  /**
   * ★ v0.9.109 · SD 服装 tag 漂移体检（用户 2026-10-20 报「一下过膝长袜一下短袜」「裙子颜色忽深忽浅」）。
   *
   * 根因不是模型"翻译错了"，是它把**一句话拆成了多条 tag**：
   *     black over-knee socks ⇒ over knee socks, black socks
   *     navy pleated school skirt ⇒ short skirt, pleated skirt, navy skirt
   * 多条同部位 tag 在 SD 里是权重叠加 → 模型每次随机偏向其中一条 → 视觉上就是漂移。
   *
   * 这里把"会漂移的写法"当场点出来；「一键归一」直接改框里的字（**不落库** —— 仍由保存决定，
   * 守住「AI 只填框」的铁律）。
   */
  const renderSdAudit = () => {
    const box = editor.querySelector('.hl-outfit-sd-audit');
    if (!box) return;
    const sd = String(editor.querySelector('.hl-edit-outfit-sd')?.value || '').trim();
    const k2 = String(editor.querySelector('.hl-edit-outfit')?.value || '').trim();
    if (!sd) { box.innerHTML = ''; return; }
    let items = [];
    try {
      items = auditSdOutfit(sd, k2 || undefined);
    } catch (err) {
      warn(STAGE.UI, `SD tag 体检失败：${err?.message || err}`);
      items = [];
    }
    if (!items.length) {
      box.innerHTML = '<span class="hl-ok">✓ 没有发现会导致漂移的写法（同一部位各一条 · 都是标准 tag）</span>';
      return;
    }
    box.innerHTML = items.map((x) => (x.level === 'warn'
      ? `<div class="hl-bad">⚠ ${escapeHtml(x.text)}</div>`
      : `<div class="hl-hint">ⓘ ${escapeHtml(x.text)}</div>`)).join('');
  };

  ['.hl-edit-outfit', '.hl-edit-outfit-sd'].forEach((sel) => {
    editor.querySelector(sel)?.addEventListener('input', renderSdAudit);
  });
  renderSdAudit();

  /* 🩹 一键归一：只改框里的字，保存才落库 */
  editor.querySelector('.hl-outfit-sd-fix')?.addEventListener('click', (ev) => {
    ev.preventDefault();
    const el = editor.querySelector('.hl-edit-outfit-sd');
    if (!el) return;
    const before = String(el.value || '').trim();
    if (!before) {
      setStatus(container, 'SD 服装 tag 框是空的 —— 先填内容，或点「✨ 把上面的 K2 描述转成 SD tag」', true);
      return;
    }
    const r = fixSdOutfit(before);
    if (!r.changes.length) {
      setStatus(container, '没有需要归一的重复或非标准写法');
      return;
    }
    el.value = r.text;
    renderSdAudit();
    renderCastDiag();
    setStatus(container, `🩹 已归一 ${r.changes.length} 处：${r.changes.join('；')} —— 点「保存」才生效`);
    info(STAGE.UI, `档案「${name}」SD 服装 tag 手动归一：${r.changes.join('；')}`);
  });

  ['.hl-edit-outfit', '.hl-edit-outfit-bare', '.hl-edit-outfit-sd', '.hl-edit-outfit-sd-bare']
    .forEach((sel) => editor.querySelector(sel)?.addEventListener('input', renderCastDiag));
  ['.hl-edit-outfit-state', '.hl-edit-outfit-detail', '.hl-edit-outfit-mod', '.hl-edit-outfit-shoes']
    .forEach((sel) => editor.querySelector(sel)?.addEventListener('change', renderCastDiag));
  editor.querySelectorAll('.hl-edit-field').forEach((inp) => inp.addEventListener('input', renderCastDiag));
  editor.querySelector('.hl-cast-diag-copy')?.addEventListener('click', (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const text = String(diagBox?.textContent || '');
    if (!text.trim()) return;
    copyTextToClipboard(text).then((ok) => {
      setStatus(container, ok ? '诊断内容已复制' : '复制失败：浏览器拒绝了剪贴板权限', !ok);
    }).catch(() => setStatus(container, '复制失败：浏览器拒绝了剪贴板权限', true));
  });
  renderCastDiag();

  // ✨ / ⚡ 共用的转换实现（v0.9.99）：只在「SD 框空 + K2 有内容」时被自动流程调用，
  //   手动按钮则无条件转。结果直接落库（保存动作 = 授权），并当场填进框里。
  const autoConvertSd = async (srcStyle, srcBare, { silent = false } = {}) => {
    if (!srcStyle && !srcBare) return 'skipped';
    if (!silent) setStatus(container, '⚡ 正在把 K2 服装描述自动转成 SD tag…');
    try {
      const parsed = await aiSdOutfitTags(srcStyle, srcBare);
      if (!parsed.ok) {
        setStatus(container, `⚡ 自动转 SD tag 失败：${parsed.error} —— 可手动点「✨ 把上面的 K2 描述转成 SD tag」重试`, true);
        return 'fail';
      }
      /*
       * ★ v0.9.109 · 落库前先过一遍确定性归一。
       *   模型转换是"自由拆分"，同一件衣服常被拆成多条 tag：
       *     `black over-knee socks` ⇒ `over knee socks, black socks`（还自造了不存在的 tag）
       *   多条并存 = 出图时随机偏向其中一条 → 用户看到「一下长袜一下短袜」。
       *   fixSdOutfit 只做确定性合并（不调 LLM、不新增设定），改了什么会写进状态栏。
       */
      const fixed = fixSdOutfit(parsed.style || '');
      setOutfitSd(name, { styleSd: fixed.text, bareSd: parsed.bare || '' });
      // 编辑器还在页面上就当场填进框（用户能立刻看到 AI 改成了什么）
      const sdEl = editor.querySelector('.hl-edit-outfit-sd');
      const sdBareEl = editor.querySelector('.hl-edit-outfit-sd-bare');
      if (sdEl && parsed.style !== null) sdEl.value = fixed.text;
      if (sdBareEl && parsed.bare !== null) sdBareEl.value = parsed.bare;
      renderCastDiag();   // 转换完立刻同步下面那块诊断（用户 2026-10-19 要求）
      renderSdAudit();    // 顺手跑一遍漂移体检（转完还残留重复会当场标红）
      if (container.isConnected) {
        setStatus(container, `⚡ 已自动转成 SD tag 并保存${fixed.changes.length ? `（已合并 ${fixed.changes.length} 处重复：${fixed.changes[0]}）` : ''} —— 不满意可以直接改这两个框，改完点「保存」覆盖`);
        info(STAGE.UI, `档案「${name}」SD 服装 tag 已自动生成（可在框里复核）`);
        if (fixed.changes.length) info(STAGE.UI, `SD tag 归一：${fixed.changes.join('；')}`);
      }
      return 'ok';
    } catch (err) {
      setStatus(container, `⚡ 自动转 SD tag 失败：${err?.message || err}`, true);
      warn(STAGE.UI, `SD 服装 tag 自动转换失败：${err?.message || err}`);
      return 'fail';
    }
  };

  // ⚡ 自动转换开关（v0.9.99）：勾上 = 这框空着就自动补，已填内容一律不碰。
  editor.querySelector('.hl-outfit-sd-auto')?.addEventListener('change', (ev) => {
    const on = !!ev.currentTarget.checked;
    const cfg = getConfig();
    cfg.autoSdOutfit = on;
    saveSettings();
    const hint = editor.querySelector('.hl-outfit-sd-auto-hint');
    if (hint) {
      hint.innerHTML = on
        ? '⚡ <b>自动转换已开</b>：框空着就自动补 —— 保存时转一次，勾上开关时也会立刻转当前这张。<b>已填过的内容不会被覆盖</b>。'
        : '空着 = SD 下回落上面的 K2 描述（长句会被打折）。想省掉手动点按钮，就勾「⚡ 自动转换」。';
    }
    if (!on) { setStatus(container, '已关闭 SD tag 自动转换（已经转好的内容保留）'); return; }

    // 勾上就立刻对当前这张补一次 —— 否则用户会以为"开了却没动静"
    const sdNow = String(editor.querySelector('.hl-edit-outfit-sd')?.value || '').trim();
    if (sdNow) {
      setStatus(container, '⚡ 已开启自动转换 —— 这张已经有 SD tag，不会覆盖；以后空着的卡保存时会自动补');
      return;
    }
    const srcStyle = String(editor.querySelector('.hl-edit-outfit')?.value || '').trim();
    const srcBare = String(editor.querySelector('.hl-edit-outfit-bare')?.value || '').trim();
    if (!srcStyle && !srcBare) {
      setStatus(container, '⚡ 已开启自动转换 —— 等这张填了 K2 服装描述，保存时会自动转');
      return;
    }
    void autoConvertSd(srcStyle, srcBare);
  });

  // ✨ v0.9.98 · 把 K2 的自然语服装描述转成 SD 口径的 danbooru 短 tag（手动，无条件覆盖框）。
  //   铁律不变：AI 只填框，落库仍由「保存」决定。
  editor.querySelector('.hl-outfit-sd-convert')?.addEventListener('click', async (ev) => {
    const btnEl = ev.currentTarget;
    const sdStyleEl = editor.querySelector('.hl-edit-outfit-sd');
    const sdBareEl = editor.querySelector('.hl-edit-outfit-sd-bare');
    if (!sdStyleEl || !sdBareEl) return;
    const srcStyle = editor.querySelector('.hl-edit-outfit')?.value.trim() || sdStyleEl.value.trim();
    const srcBare = editor.querySelector('.hl-edit-outfit-bare')?.value.trim() || sdBareEl.value.trim();
    if (!srcStyle && !srcBare) {
      setStatus(container, '上面的服装与裸露框都是空的 —— 先填内容（或用服装预设）再转换', true);
      return;
    }
    btnEl.disabled = true;
    const oldLabel = btnEl.textContent;
    btnEl.textContent = '✨ 转换中…';
    try {
      const parsed = await aiSdOutfitTags(srcStyle, srcBare);
      if (!parsed.ok) {
        setStatus(container, `SD tag 转换失败：${parsed.error}（原因见「诊断」页）`, true);
        return;
      }
      // v0.9.109：同 autoConvertSd —— 落框前先做确定性归一，避免同件衣服多条 tag 并存
      const fixed = fixSdOutfit(parsed.style || '');
      if (parsed.style !== null) sdStyleEl.value = fixed.text;
      if (parsed.bare !== null) sdBareEl.value = parsed.bare;
      renderCastDiag();   // 手动转换同样要同步诊断块
      renderSdAudit();
      setStatus(container, fixed.changes.length
        ? `已转成 SD tag（合并 ${fixed.changes.length} 处重复：${fixed.changes.join('；')}）—— 检查无误后点「保存」才生效`
        : '已转成 SD tag 填进下面两个框 —— 检查无误后点「保存」才生效');
      info(STAGE.UI, `档案「${name}」SD 服装 tag 转换完成`);
    } catch (err) {
      setStatus(container, `SD tag 转换失败：${err?.message || err}`, true);
      warn(STAGE.UI, `SD 服装 tag 转换失败：${err?.message || err}`);
    } finally {
      btnEl.disabled = false;
      btnEl.textContent = oldLabel;
    }
  });

  editor.querySelector('.hl-cast-save').addEventListener('click', () => {
    // 三种保存语义（对齐 store.upsertEntry）：
    //   填了值   → 写入 / 覆盖
    //   清空了已有字段 → null = 显式删除该字段（2026-09-26 修「清空保存不生效」）
    //   本来就没有的空字段 → 忽略
    const fields = {};
    editor.querySelectorAll('.hl-edit-field').forEach(inp => {
      const f = inp.dataset.field;
      const v = inp.value.trim();
      if (v) fields[f] = v;
      else if (entry?.fields?.[f]) fields[f] = null;
    });
    const label = editor.querySelector('.hl-edit-label').value.trim();
    const lock = editor.querySelector('.hl-edit-lock').checked;

    upsertEntry(name, { fields, label, locked: lock }, { global: scope === 'global' });

    // 服装走状态机（校验状态位回退 + 款式漂移）；但这里是用户手动操作 → force
    // 跳过漂移闸门：主权在你，AI 才需要被拦。
    const outfitStyle = editor.querySelector('.hl-edit-outfit').value.trim();
    const outfitState = editor.querySelector('.hl-edit-outfit-state').value;
    const outfitPreset = editor.querySelector('.hl-edit-outfit-preset').value;
    const outfitLock = editor.querySelector('.hl-edit-outfit-lock').value;
    /**
     * v0.9.45：裸露部位手动可编辑。
     * 手动操作一律 force（主权在你，AI 才需要被拦），但 **redress 不能跟着 force 一起开**
     * —— redress 是「正文里真的写了重新穿好」的信号，用户在面板里把状态从 removed
     * 调回 intact 时，那是直接设定，不是剧情回退，开不开都能过（force 已经跳过闸门了）。
     * 这里传 bare 是为了让空串也能落库：不传的话 updateOutfit 会保持旧值，用户清不掉。
     */
    const outfitBare = editor.querySelector('.hl-edit-outfit-bare').value.trim();
    /** v0.9.67 E1/E2：两个模式下拉。强制读（没有该元素时退回 auto，不覆盖已存值）。 */
    const outfitFollow = editor.querySelector('.hl-edit-outfit-follow')?.value || 'auto';
    const outfitStateMode = editor.querySelector('.hl-edit-outfit-statemode')?.value || 'auto';
    /**
     * v0.9.69 三维度：空串必须当成"显式清空"传进去 ——
     * 同 lockLevel / followMode 那条踩过的坑：不传的话 updateOutfit 会保持旧值，
     * 用户把下拉选回「不使用」反而在档案里清不掉。
     */
    const outfitDetail = editor.querySelector('.hl-edit-outfit-detail')?.value || '';
    const outfitMod = editor.querySelector('.hl-edit-outfit-mod')?.value || '';
    const outfitShoes = editor.querySelector('.hl-edit-outfit-shoes')?.value || '';
    const res = updateOutfit(name, outfitStyle, outfitState, getRound(), {
      preset: outfitPreset, lockLevel: outfitLock, force: true, bare: outfitBare,
      followMode: outfitFollow, stateMode: outfitStateMode,
      stateDetail: outfitDetail, mod: outfitMod, shoes: outfitShoes,
    });
    if (!res.ok) {
      warn(STAGE.UI, `服装未能更新：${res.reason}`);
      setStatus(container, res.reason, true);
      return;
    }

    /**
     * v0.9.98 · SD 专用服装两框单独落库（不走状态机，见 store.setOutfitSd 注释）。
     * ★ 必须每张卡都写（哪怕为空）—— 空串是"显式清空"，不写就清不掉。
     */
    const sdStyleVal = editor.querySelector('.hl-edit-outfit-sd')?.value ?? '';
    const sdBareVal = editor.querySelector('.hl-edit-outfit-sd-bare')?.value ?? '';
    /**
     * ★★ v0.9.111 · 落库前**自动归一**（用户 2026-10-20：「这个一键归一不用每次手动按吧？」）
     *
     * 为什么必须在这里做：出图路径本来就会归一（`consistency.js` 里 `fixSdOutfit` 跑在
     * `dedupeOutfitSlots` 之前），但那是**不落库**的 —— 于是框里留着
     * `over knee socks, black socks`、出图却是 `black thighhighs`，两边不一致，
     * 用户重开档案看到旧内容会以为没修好。
     *
     * 只做确定性合并（同件衣服多条 tag 合成一条 / 非标准写法换 danbooru 标准 tag），
     * **不改款式与颜色** —— 服装是用户主权区，插件只负责"同一件别写两遍"。
     * 框是空的就什么都不做，交给下面的 ⚡ 自动转换，不凭空造 tag。
     */
    const sdFixed = fixSdOutfit(String(sdStyleVal).trim());
    const sdStyleSave = sdFixed.changes.length ? sdFixed.text : sdStyleVal;
    if (sdFixed.changes.length) {
      const sdEl0 = editor.querySelector('.hl-edit-outfit-sd');
      if (sdEl0) sdEl0.value = sdStyleSave;   // 框里同步，用户能看到改成了什么
      renderSdAudit();                        // 后面若因别的原因提前 return，体检也不能停在旧结论上
    }
    setOutfitSd(name, { styleSd: sdStyleSave, bareSd: sdBareVal });

    /**
     * ⚡ v0.9.99 · 自动转换的触发点。
     * 条件全中才动手：开关是开的 + 这张 SD tag 原本是空的 + K2 服装描述有内容。
     * 「点保存」本身就是授权，所以这里可以直接转并落库，不用再点一次 ✨ 按钮。
     * 已经在框里填过内容的一律不碰（人设与服装是主权区）。
     */
    const needAutoSd = getConfig().autoSdOutfit === true
      && !String(sdStyleVal).trim()
      && Boolean(outfitStyle || outfitBare);

    /**
     * v0.9.70 · 落「原始选择值 spec」+「状态层 dyn.appear」。
     *
     * ★ `fields: false` / `nl: false`：hair / makeup / nlProfile 三个输入框的值
     *   已经在下拉切换时被同步过去了，这里再用合成值覆写一次，
     *   会把用户同步之后又手动改过的内容吃掉（同步是预览，改动权一直在用户手里）。
     *
     * ★ appear 的两个键**总是显式传**（空串 = 清空），否则用户在下拉里选回
     *   「不使用」时状态层清不掉 —— 同 updateOutfit 那三维度踩过的坑。
     */
    const hInput = {};
    const mInput = {};
    const appearInput = { hairState: '', makeupSmudge: '' };
    editor.querySelectorAll('.hl-ap-dim').forEach((sel) => {
      const v = String(sel.value || '').trim();
      const dimId = sel.dataset.dim;
      if (sel.dataset.state === '1') { appearInput[STATE_FIELD[dimId]] = v; return; }
      if (!v) return;
      if (sel.dataset.group === 'hair') hInput[dimId] = v;
      else mInput[dimId] = v;
    });
    const apRes = saveAppearance(
      name, { hair: hInput, makeup: mInput, appear: appearInput }, getRound(),
      { fields: false, nl: false },
    );
    if (!apRes.ok) warn(STAGE.UI, `外观维度未能保存：${apRes.reason}`);

    info(STAGE.UI, `档案「${name}」已更新`);
    if (sdFixed.changes.length) {
      info(STAGE.UI, `档案「${name}」SD 服装 tag 保存时自动归一：${sdFixed.changes.join('；')}`);
    }
    setStatus(container, sdFixed.changes.length
      ? `「${name}」已保存 —— SD 服装 tag 自动合并了 ${sdFixed.changes.length} 处重复（同一件衣服不再写两条），之后出图就按合并后的走`
      : `「${name}」已保存 —— 之后生成的图就会用新外貌（已有图不变）`);
    refresh(container);

    // 放在 refresh 之后：先把档案与 UI 落定，再异步补 SD tag（失败也不影响这次保存）
    if (needAutoSd) void autoConvertSd(outfitStyle, outfitBare);
  });
}

/* ============ 服装预设（v0.9.55：分类抽屉 + 搜索 + 批量 + AI 工具） ============ */

/* ---- 面板内筛选/勾选状态（抽屉开合记入 localStorage） ---- */
const PRESET_DRAWER_KEY = 'hl_preset_drawers';
const presetUi = {
  kw: '',
  cat: '',
  bulk: false,
  checked: new Set(),     // 批量勾选的预设名
  expanded: (() => {      // 展开中的分类集合
    try {
      const a = JSON.parse(globalThis.localStorage?.getItem(PRESET_DRAWER_KEY) || '[]');
      return new Set(Array.isArray(a) ? a : []);
    } catch { return new Set(); }
  })(),
};
function saveDrawers() {
  try { globalThis.localStorage?.setItem(PRESET_DRAWER_KEY, JSON.stringify([...presetUi.expanded])); } catch { /* 忽略 */ }
}

/* ---- 预设卡片展示样式（比例 + 大小），本机视觉态存 localStorage（与角色卡分开记） ---- */
const PRESET_AR_KEY = 'hl_preset_card_ar';
const PRESET_W_KEY = 'hl_preset_card_w';
const PRESET_W_DEFAULT = 148;
const presetCardView = {
  ar: lsGet(PRESET_AR_KEY) || '2 / 3',
  w: (() => {
    const n = parseInt(lsGet(PRESET_W_KEY), 10);
    return Number.isFinite(n) && n >= CARD_W_MIN && n <= CARD_W_MAX ? n : PRESET_W_DEFAULT;
  })(),
};
function applyPresetCardView(list) {
  if (!list) return;
  list.style.setProperty('--hl-card-ar', presetCardView.ar);
  list.style.setProperty('--hl-card-w', `${presetCardView.w}px`);
}

/* ---- 整节折叠（服装预设库整个 section 收成一行标题） ---- */
const PRESET_SEC_KEY = 'hl_preset_sec_open';
function presetSecOpen() { return lsGet(PRESET_SEC_KEY) !== '0'; }

/** 复制文本（clipboard API 优先，失败回退 execCommand —— ST 内嵌环境两种都得备）。 */
async function copyTextToClipboard(text) {
  try {
    await globalThis.navigator?.clipboard?.writeText(text);
    return true;
  } catch { /* 落到兜底 */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}

/** 某预设归属的分类（没设过 = 「未分类」）。 */
function catOf(cats, name) {
  return String(cats[name] || '').trim() || '未分类';
}

/**
 * v0.9.74 · 把 /user/files/ 引用抓成 dataURL（导出预设包用）。
 * dataURL 原样返回；别的路径 fetch 失败返回 ''（导出不因一张图失败而中断）。
 */
async function imageUrlToDataUrl(ref) {
  const r = String(ref || '');
  if (!r) return '';
  if (r.startsWith('data:')) return r;
  try {
    const res = await fetch(r);
    if (!res.ok) return '';
    const blob = await res.blob();
    return await new Promise((resolve) => {
      const fr = new FileReader();
      fr.onload = () => resolve(String(fr.result || ''));
      fr.onerror = () => resolve('');
      fr.readAsDataURL(blob);
    });
  } catch { return ''; }
}

/* ---- AI 输出格式下拉（三处指令框共用：编辑抽屉 / 新增表单 / 批量栏） ---- */
const PRESET_FMT_OPTS = [
  ['auto', '格式：跟随指令'],
  ['tag', '格式：英文 TAG 串'],
  ['en-nl', '格式：英文自然语'],
  ['zh-nl', '格式：中文自然语'],
];
function presetFmtSelect(id) {
  return `<select class="hl-input hl-preset-fmt" ${id ? `id="${id}"` : ''}
    title="AI 输出格式。「跟随指令」= 指令里说写 TAG 就写 TAG、说写中文就写中文；没说则保持原文格式">
    ${PRESET_FMT_OPTS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>`;
}

/**
 * v0.9.74 · 「引用服装预设」下拉的数据源：按分类分组 + 关键词 / 分类过滤。
 * 原生 select 无法加搜索框、optgroup 标签颜色也改不动（用户反馈看不清），
 * 所以换成了自定义可搜索下拉（hl-combo），这个函数只管出数据。
 */
function presetGroupsOf(catFilter = '', kw = '') {
  const presets = listOutfitPresets();
  const cats = listPresetCats();
  let names = Object.keys(presets);
  const k = String(kw || '').toLowerCase().trim();
  if (catFilter) names = names.filter(n => catOf(cats, n) === catFilter);
  if (k) names = names.filter(n => `${n} ${presets[n]} ${catOf(cats, n)}`.toLowerCase().includes(k));
  const groups = new Map();
  for (const n of names) {
    const c = catOf(cats, n);
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c).push(n);
  }
  return [...groups.keys()]
    .sort((a, b) => ((a === '未分类') - (b === '未分类')) || a.localeCompare(b, 'zh'))
    .map(c => ({ cat: c, names: groups.get(c).sort((a, b) => a.localeCompare(b, 'zh')) }));
}

/**
 * v0.9.74 · 可搜索预设下拉（hl-combo）。
 * 对外保持原生 select 的两个接口，下游零改动：
 *   - `combo.value` —— defineProperty 提供（保存逻辑 / change 监听都在用它）
 *   - `change` 事件 —— 选中项时派发（ev.currentTarget.value 即新值）
 * 额外能力：输入即搜（名字/描述/分类都命中）、每行右侧显示所属分类、
 *           combo._setCatFilter(cat) 供左侧分类下拉联动。
 */
function setupPresetCombo(combo) {
  if (!combo || combo._comboReady) return;
  combo._comboReady = true;
  const input = combo.querySelector('.hl-combo-input');
  const list = combo.querySelector('.hl-combo-list');
  let value = combo.dataset.value || '';
  let catFilter = '';

  const setVal = (v) => {
    value = String(v || '');
    combo.dataset.value = value;
    input.value = value;
    combo.dispatchEvent(new Event('change', { bubbles: true }));
  };

  const renderList = () => {
    const groups = presetGroupsOf(catFilter, input.value);
    const hasKw = input.value.trim() !== '';
    // 有搜索词时把「不用预设」也当一条候选（搜它的名字搜不到时仍可一键清除引用）
    list.innerHTML =
      `<div class="hl-combo-opt${value === '' && !hasKw ? ' hl-combo-sel' : ''}" data-value="">（不用预设，直接写描述）</div>`
      + groups.map(g =>
        `<div class="hl-combo-group">${escapeHtml(g.cat)}<span class="hl-combo-gcount">${g.names.length}</span></div>`
        + g.names.map(n =>
          `<div class="hl-combo-opt${n === value ? ' hl-combo-sel' : ''}" data-value="${escapeHtml(n)}">`
          + `<span class="hl-combo-name">${escapeHtml(n)}</span>`
          + (catFilter ? '' : `<span class="hl-combo-cat">${escapeHtml(g.cat)}</span>`)
          + `</div>`).join('')
      ).join('');
    list.querySelectorAll('.hl-combo-opt').forEach(opt => {
      // pointerdown preventDefault：不让 input 先 blur（否则列表先收起、click 就没了）
      opt.addEventListener('pointerdown', (e) => e.preventDefault());
      opt.addEventListener('click', () => {
        setVal(opt.dataset.value || '');
        list.setAttribute('hidden', '');
        input.blur();
      });
    });
  };

  const open = () => {
    renderList();
    list.removeAttribute('hidden');
    const sel = list.querySelector('.hl-combo-sel');
    if (sel) sel.scrollIntoView({ block: 'nearest' });
  };
  const close = () => list.setAttribute('hidden', '');

  input.addEventListener('focus', open);
  input.addEventListener('click', open);
  input.addEventListener('input', open);   // 输入即过滤（open 内会重渲染）
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { input.value = value; close(); input.blur(); }
  });
  // 失焦回填：没点选项就离开时，把框恢复成当前值（否则搜索词会冒充选中值）
  input.addEventListener('blur', () => { input.value = value; setTimeout(close, 120); });
  combo.addEventListener('focusout', (e) => {
    if (!combo.contains(e.relatedTarget)) close();
  });

  Object.defineProperty(combo, 'value', {
    get: () => value,
    set: (v) => {
      value = String(v || '');
      combo.dataset.value = value;
      input.value = value;
    },
  });
  combo._setCatFilter = (c) => { catFilter = String(c || ''); if (!list.hasAttribute('hidden')) renderList(); };
}

/** 现有全部分类名（排序，「未分类」永远排最后）。 */
function allPresetCats(cats, names) {
  const set = new Set(names.map(n => catOf(cats, n)));
  return [...set].sort((a, b) => ((a === '未分类') - (b === '未分类')) || a.localeCompare(b, 'zh'));
}

/** 预设卡片（复用角色卡的卡片类族：图 / 名 / 徽标 / 按钮行 / 展开编辑）。 */
function presetCardHtml(name, text, cat, checked, usage = 0) {
  const img = getPresetImage(name);
  const figure = img
    ? `<img class="hl-cast-avatar" src="${escapeHtml(img)}" alt="${escapeHtml(name)}" loading="lazy" decoding="async" />`
    : `<div class="hl-cast-avatar hl-cast-avatar-none"><span>${escapeHtml(initialOf(name))}</span></div>`;
  /**
   * v0.9.72 · 引用计数徽标。
   * 只显示 >0 的情况 —— 146 条库绝大多数当下没人引用，全打上"未使用"是纯噪音，
   * 反而把真正被引用那几条淹了。没徽标 = 没人引用（可放心删）。
   */
  const usageBadge = usage > 0
    ? `<span class="hl-badge hl-preset-usagebadge" title="有 ${usage} 个角色正在引用它 —— 改内容会一起变">⛓ ${usage} 个角色在用</span>`
    : '';
  return `
  <div class="hl-preset-card" data-name="${escapeHtml(name)}">
    <div class="hl-cast-figure">
      ${figure}
      <label class="hl-preset-cardpick" title="选中做批量操作"><input type="checkbox" class="hl-preset-ck" ${checked ? 'checked' : ''}></label>
      ${cat !== '未分类' ? `<span class="hl-badge hl-cast-flag hl-preset-catflag">${escapeHtml(cat)}</span>` : ''}
    </div>
    <div class="hl-cast-meta">
      <div class="hl-cast-name"><b title="${escapeHtml(name)}">${escapeHtml(name)}</b>${usageBadge}</div>
      ${text ? `<div class="hl-preset-desc" title="${escapeHtml(text)}">${escapeHtml(text)}</div>` : ''}
    </div>
    <div class="hl-cast-row">
      <button class="hl-btn hl-mini hl-preset-editbtn" type="button" title="编辑（图 / 名字 / 分类 / 描述 + AI 指令框）">编辑</button>
      <button class="hl-btn hl-mini hl-ghost hl-preset-copy" type="button" title="一键复制这套服装的提示词描述">📋复制</button>
      <button class="hl-btn hl-mini hl-ghost hl-preset-insert" type="button"
        title="把这套款式追加进正在编辑的预设的款式描述框（上衣+下装这类单件拼接用）">⤵插入</button>
      <button class="hl-btn hl-mini hl-ghost hl-preset-del" type="button" title="删除这个预设">删</button>
    </div>
    <div class="hl-preset-edit" hidden></div>
  </div>`;
}

function renderPresets(container) {
  const box = container.querySelector('#hl-preset-list');
  if (!box) return;
  const presets = listOutfitPresets();
  const cats = listPresetCats();
  const names = Object.keys(presets);

  // 分类筛选下拉 + 新增表单的 datalist 与现势分类同步
  const allCats = allPresetCats(cats, names);
  const cf = container.querySelector('#hl-preset-catfilter');
  if (cf) {
    cf.innerHTML = '<option value="">全部分类</option>'
      + allCats.map(c => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join('');
    if (!allCats.includes(presetUi.cat)) presetUi.cat = '';
    cf.value = presetUi.cat;
  }
  const dl = container.querySelector('#hl-preset-cat-list');
  if (dl) dl.innerHTML = allCats.map(c => `<option value="${escapeHtml(c)}">`).join('');

  applyPresetCardView(box);
  box.classList.toggle('hl-bulk', presetUi.bulk);

  if (!names.length) {
    box.innerHTML = '<div class="hl-hint">还没有预设。在下方填名字和款式描述（或点「✦ AI 生成款式」）再保存。</div>';
    updateBulkBar(container);
    return;
  }

  const kw = presetUi.kw.toLowerCase().trim();
  const visible = names.filter(n => {
    if (presetUi.cat && catOf(cats, n) !== presetUi.cat) return false;
    if (!kw) return true;
    return `${n} ${presets[n]} ${catOf(cats, n)}`.toLowerCase().includes(kw);
  });
  if (!visible.length) {
    box.innerHTML = '<div class="hl-hint">没有匹配的预设 —— 换个关键词，或清空搜索 / 分类筛选。</div>';
    updateBulkBar(container);
    return;
  }

  // 按分类分组渲染抽屉，抽屉体内是卡片网格
  const groups = new Map();
  for (const n of visible) {
    const c = catOf(cats, n);
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c).push(n);
  }
  // v0.9.72 · 引用计数：渲染前算一次，避免每张卡片各扫一遍全库
  const usageCounts = presetUsageCounts();
  const catOrder = [...groups.keys()].sort((a, b) => ((a === '未分类') - (b === '未分类')) || a.localeCompare(b, 'zh'));

  box.innerHTML = catOrder.map(cat => {
    const open = presetUi.expanded.has(cat);
    const cards = groups.get(cat).sort((a, b) => a.localeCompare(b, 'zh'))
      .map(n => presetCardHtml(n, presets[n], cat, presetUi.checked.has(n), usageCounts[n] || 0)).join('');
    return `
    <div class="hl-pdrawer" data-cat="${escapeHtml(cat)}">
      <div class="hl-pdrawer-head" type="button">
        <span class="hl-pdrawer-arrow">${open ? '▾' : '▸'}</span>
        <span class="hl-pdrawer-title">${escapeHtml(cat)}</span>
        <span class="hl-pdrawer-count">${groups.get(cat).length}</span>
        ${cat !== '未分类' ? `<button class="hl-btn hl-mini hl-ghost hl-pdrawer-rename" type="button"
          title="重命名这个分类（分类下所有预设一起改）">✎改名</button>` : ''}
      </div>
      <div class="hl-pdrawer-body" ${open ? '' : 'hidden'}><div class="hl-cast-grid hl-preset-grid">${cards}</div></div>
    </div>`;
  }).join('');

  bindPresetRows(container);
  updateBulkBar(container);
}

/** 批量操作栏显隐 + 计数。 */
function updateBulkBar(container) {
  const bar = container.querySelector('#hl-preset-bulkbar');
  const count = container.querySelector('#hl-preset-bulkcount');
  if (count) count.textContent = String(presetUi.checked.size);
  if (bar) bar.hidden = !presetUi.bulk;
  const box = container.querySelector('#hl-preset-list');
  if (box) box.classList.toggle('hl-bulk', presetUi.bulk);
}

/** 行内编辑抽屉（✎）：图 / 名字 / 分类 / 描述 + AI 指令框，保存才落库。 */
function openPresetEditor(container, editBox, name) {
  const raw = String(listOutfitPresets()[name] || '');
  const cats = listPresetCats();
  editBox.innerHTML = `
    <div class="hl-av-box hl-pe-imgbox"></div>
    <div class="hl-grid2">
      <div class="hl-field"><label class="hl-label">预设名</label>
        <input class="hl-input hl-pe-name" value="${escapeHtml(name)}"></div>
      <div class="hl-field"><label class="hl-label">分类（留空 = 未分类）</label>
        <input class="hl-input hl-pe-cat" list="hl-preset-cat-list" value="${escapeHtml(String(cats[name] || ''))}"></div>
    </div>
    <div class="hl-field"><label class="hl-label">款式描述（英文 tag 串 · 英文是唯一真值）</label>
      <textarea class="hl-input hl-textarea hl-pe-text" rows="2">${escapeHtml(raw)}</textarea>
      <div class="hl-hint">这条串原样进画面词。存中文 = 每楼翻译一次，同一件衣服会翻出不同英文 —— 那是在制造漂移。<br>
      💡 上衣、下装分开存的：直接点<b>其他卡片上的「⤵插入」</b>，就能把那套款式追加拼进这个框。</div></div>
    <div class="hl-field"><label class="hl-label">✦ AI 修改指令（结果填进描述框，保存才生效）</label>
      <div class="hl-ask-row">
        <input class="hl-input hl-pe-ask" placeholder="如：改性感一点 / 换黑色系 / 裙子改长 / 加一条项链 / 写成中文自然语">
        ${presetFmtSelect('')}
      </div></div>
    <div class="hl-actions">
      <button class="hl-btn hl-ghost hl-mini hl-pe-ai" type="button">✦ AI 按指令改</button>
      <button class="hl-btn hl-ghost hl-mini hl-pe-expand" type="button" title="AI 扩写为连贯自然语（语言看下方输出语言）">✨扩写</button>
      <button class="hl-btn hl-ghost hl-mini hl-pe-trans" type="button" title="翻译：中文→英文 tag 串，英文→中文自然语（自动判向）">⇄译</button>
      <button class="hl-btn hl-ghost hl-mini hl-pe-tagify" type="button" title="整理成规范英文六要素 tag 串（乱序 / 中英混合都能收）">#TAG</button>
      <button class="hl-btn hl-mini hl-pe-save" type="button">保存</button>
      <button class="hl-btn hl-ghost hl-mini hl-pe-cancel" type="button">取消</button>
    </div>`;

  /* ---- 展示图（上传到酒馆服务端 user/files，原始文件防丢；只影响卡片显示） ---- */
  const imgBox = editBox.querySelector('.hl-pe-imgbox');
  const paintImg = () => {
    const cur = getPresetImage(name);
    imgBox.innerHTML = `
      <div class="hl-av-preview">${cur
        ? `<img class="hl-cast-avatar" src="${escapeHtml(cur)}" alt="">`
        : '<div class="hl-cast-avatar hl-cast-avatar-none"><span>' + escapeHtml(initialOf(name)) + '</span></div>'}</div>
      <div class="hl-av-btns">
        <button class="hl-btn hl-mini hl-pe-img-pick" type="button">选图 / 上传</button>
        ${cur ? '<button class="hl-btn hl-mini hl-ghost hl-pe-img-recrop" type="button">重新裁剪</button>' : ''}
        ${cur ? '<button class="hl-btn hl-mini hl-ghost hl-pe-img-clear" type="button">清除</button>' : ''}
        <div class="hl-hint">展示图只给你在卡片上认服装用，<b>不写进出图提示词</b>。裁剪后 ≤768px 高清存酒馆
          <code>user/files/huiling-preset-*.jpg</code>，每个预设只留一张（换图自动删旧），不占存档体积。</div>
      </div>`;

    const applyData = async (data) => {
      if (!data) return;
      setStatus(container, `正在上传「${name}」的展示图…`);
      const path = await uploadUserFile(name, data);
      const old = getPresetImage(name);
      if (path) {
        if (old && old.startsWith('/user/files/') && old !== path) deleteUserFile(old);
        setPresetImage(name, path);
        setStatus(container, `「${name}」展示图已更新（原始文件已存到酒馆 user/files 目录）`);
      } else {
        setPresetImage(name, data);   // 上传失败回退嵌存档，功能不断
        setStatus(container, '图已保存（服务端上传没成功，先嵌在存档里；不影响使用）', true);
      }
      paintImg();
      renderPresets(container);
    };

    imgBox.querySelector('.hl-pe-img-pick').addEventListener('click', async () => {
      try {
        const mod = await import('./avatar.js');
        const data = await mod.makeAvatar({ title: `给「${name}」选一张服装展示图` });
        await applyData(data);
      } catch (err) {
        setStatus(container, `选图失败：${err?.message || err}`, true);
      }
    });
    imgBox.querySelector('.hl-pe-img-recrop')?.addEventListener('click', async () => {
      try {
        const mod = await import('./avatar.js');
        const data = await mod.recropAvatar(getPresetImage(name));
        await applyData(data);
      } catch (err) {
        setStatus(container, `裁剪失败：${err?.message || err}`, true);
      }
    });
    imgBox.querySelector('.hl-pe-img-clear')?.addEventListener('click', async () => {
      const old = getPresetImage(name);
      setPresetImage(name, '');
      if (old && old.startsWith('/user/files/')) await deleteUserFile(old);
      paintImg();
      renderPresets(container);
      setStatus(container, `「${name}」展示图已清除`);
    });
  };
  paintImg();

  editBox.removeAttribute('hidden');
  editBox.querySelector('.hl-pe-cancel').addEventListener('click', () => {
    editBox.setAttribute('hidden', '');
    editBox.innerHTML = '';
  });
  editBox.querySelector('.hl-pe-ai').addEventListener('click', async (ev) => {
    const btnEl = ev.currentTarget;
    const ask = editBox.querySelector('.hl-pe-ask').value.trim();
    const text = editBox.querySelector('.hl-pe-text').value.trim();
    if (!ask) { setStatus(container, '先写一句 AI 指令（想改成什么样）', true); return; }
    btnEl.disabled = true;
    setStatus(container, `正在按指令改写「${name}」…`);
    try {
      const fmt = editBox.querySelector('.hl-preset-fmt')?.value || 'auto';
      const res = await aiPresetTool(name, text, 'refine', (m, o) => callAnalyzeLLM(m, o), { instruction: ask, format: fmt });
      if (!res.ok) { setStatus(container, `AI 改写失败：${res.error || '详见诊断页'}`, true); return; }
      editBox.querySelector('.hl-pe-text').value = res.text;
      setStatus(container, '已填进描述框 —— 检查后点「保存」才生效');
    } finally {
      btnEl.disabled = false;
    }
  });
  editBox.querySelector('.hl-pe-expand').addEventListener('click', () => { editBox.setAttribute('hidden', ''); editBox.innerHTML = ''; runPresetAi(container, name, 'expand'); });
  editBox.querySelector('.hl-pe-trans').addEventListener('click', () => { editBox.setAttribute('hidden', ''); editBox.innerHTML = ''; runPresetAi(container, name, 'translate'); });
  editBox.querySelector('.hl-pe-tagify').addEventListener('click', () => { editBox.setAttribute('hidden', ''); editBox.innerHTML = ''; runPresetAi(container, name, 'tagify'); });
  editBox.querySelector('.hl-pe-save').addEventListener('click', () => {
    const newName = editBox.querySelector('.hl-pe-name').value.trim();
    const newCat = editBox.querySelector('.hl-pe-cat').value.trim();
    const text = editBox.querySelector('.hl-pe-text').value.trim();
    if (!newName || !text) { setStatus(container, '预设名和款式描述都要填', true); return; }
    const presets = listOutfitPresets();
    if (newName !== name && presets[newName]) {
      setStatus(container, `已有同名预设「${newName}」—— 换个名字，或先删掉它`, true);
      return;
    }
    // 改名要先取展示图引用再删旧 —— removeOutfitPreset 会把 presetImages[name] 一并删掉
    const movedImg = newName !== name ? getPresetImage(name) : '';
    if (newName !== name) removeOutfitPreset(name);   // 改名：删旧（分类/展示图记录同名同命一并删）
    saveOutfitPreset(newName, text);
    setPresetCat(newName, newCat);
    if (movedImg) setPresetImage(newName, movedImg);  // 展示图记录搬家（服务器文件不用动）
    renderPresets(container);
    refresh(container);
    const renamed = newName !== name
      ? `（原「${name}」已改名 —— 档案里引用旧名的角色需要重新选一次预设）`
      : '（引用它的角色全体同步）';
    setStatus(container, `预设「${newName}」已保存 ${renamed}`);
  });
}

/**
 * 单个预设 AI 操作的公共管线：confirm → 调 AI → 结果确认 → 替换保存。
 * op='expand' 走专用 aiExpandOutfit，其余走 aiPresetTool。
 */
async function runPresetAi(container, name, op, instruction = '') {
  const raw = String(listOutfitPresets()[name] || '').trim();
  if (!raw && op !== 'expand') { setStatus(container, `预设「${name}」没有描述可转换`, true); return; }
  const labels = {
    expand: '扩写为自然语', 'translate-en': '翻译成英文 tag 串', 'translate-zh': '翻译成中文自然语',
    tagify: '整理成英文六要素 tag 串', refine: '按指令改写',
  };
  let realOp = op;
  if (op === 'translate') realOp = hasChinese(raw) ? 'translate-en' : 'translate-zh';
  if (!confirm(`预设「${name}」→ ${labels[realOp]}：\n${raw.slice(0, 160)}${raw.length > 160 ? '…' : ''}\n\n`
    + `替换后所有引用该预设的角色同步生效。继续？`)) return;
  setStatus(container, `正在处理预设「${name}」（${labels[realOp]}）…`);
  try {
    const res = realOp === 'expand'
      ? await aiExpandOutfit(name, raw, (m, o) => callAnalyzeLLM(m, o), { lang: nlLang() })
      : await aiPresetTool(name, raw, realOp, (m, o) => callAnalyzeLLM(m, o), { instruction, lang: nlLang() });
    if (!res.ok) { setStatus(container, `失败：${res.error || res.reason || '详见诊断页'}`, true); return; }
    if (!confirm(`「${name}」${labels[realOp]}结果：\n\n${res.text}\n\n替换保存？（引用它的角色全体同步）`)) {
      setStatus(container, '已取消，原文未动');
      return;
    }
    saveOutfitPreset(name, res.text);
    renderPresets(container);
    refresh(container);
    setStatus(container, `预设「${name}」已替换 —— 引用它的角色下次生图即生效`);
  } catch (e) {
    setStatus(container, `失败：${e?.message || e}`, true);
  }
}

/** 批量 AI 操作：串行逐个处理（进度实时显示），失败项跳过并汇报。 */
async function runBulkAi(container, op) {
  const presets = listOutfitPresets();
  const names = [...presetUi.checked].filter(n => presets[n]);
  if (!names.length) { setStatus(container, '先勾选要批量处理的预设（勾「批量」后每行有复选框）', true); return; }
  const instruction = String(container.querySelector('#hl-preset-bulk-ask')?.value || '').trim();
  if (op === 'refine' && !instruction) {
    setStatus(container, '批量「按指令改」需要先在指令框里写要怎么改', true);
    return;
  }
  const bulkFmt = String(container.querySelector('#hl-preset-bulk-fmt')?.value || 'auto');
  const opLabel = { expand: '扩写', translate: '翻译', tagify: 'TAG 整理', refine: '按指令改' }[op];
  if (!confirm(`对选中的 ${names.length} 个预设批量「${opLabel}」？\n\n`
    + (op === 'refine' ? `指令：${instruction}\n` : '')
    + `逐个调 AI（数量多会稍慢），结果直接替换保存 —— 引用的角色全体同步。\n`
    + `建议先备份（导出档案按钮包含预设）。继续？`)) return;
  let done = 0;
  const failed = [];
  for (const n of names) {
    setStatus(container, `批量${opLabel}中：${done + 1} / ${names.length}（${n}）…`);
    try {
      const raw = String(presets[n] || '').trim();
      const realOp = op === 'translate' ? (hasChinese(raw) ? 'translate-en' : 'translate-zh') : op;
      const res = realOp === 'expand'
        ? await aiExpandOutfit(n, raw, (m, o) => callAnalyzeLLM(m, o), { lang: nlLang() })
        : await aiPresetTool(n, raw, realOp, (m, o) => callAnalyzeLLM(m, o), { instruction, lang: nlLang(), format: bulkFmt });
      if (!res.ok || !res.text) { failed.push(`${n}（${res.error || res.reason || '空结果'}）`); continue; }
      saveOutfitPreset(n, res.text);
      done += 1;
    } catch (e) {
      failed.push(`${n}（${e?.message || e}）`);
    }
  }
  presetUi.checked.clear();
  renderPresets(container);
  refresh(container);
  setStatus(container, `批量${opLabel}完成：成功 ${done} / ${names.length}`
    + (failed.length ? `；失败 ${failed.length}：${failed.join('、')}` : ''));
}

/** 给当前列表的行 / 抽屉头绑事件（renderPresets 每次重绘后调用）。 */
function bindPresetRows(container) {
  const box = container.querySelector('#hl-preset-list');
  if (!box) return;

  // 抽屉头开合：只切 body 显隐，不整体重渲染（编辑抽屉不丢）
  box.querySelectorAll('.hl-pdrawer-head').forEach(head => {
    head.addEventListener('click', () => {
      const drawer = head.closest('.hl-pdrawer');
      const cat = drawer?.dataset.cat || '';
      const body = drawer?.querySelector('.hl-pdrawer-body');
      if (!body) return;
      const show = body.hasAttribute('hidden');
      body.toggleAttribute('hidden', !show);
      const arrow = head.querySelector('.hl-pdrawer-arrow');
      if (arrow) arrow.textContent = show ? '▾' : '▸';
      if (show) presetUi.expanded.add(cat); else presetUi.expanded.delete(cat);
      saveDrawers();
    });
  });

  // v0.9.74 · 分类重命名：整类预设一起改归新分类名（未分类没有按钮）
  box.querySelectorAll('.hl-pdrawer-rename').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();   // 别把抽屉头也点开了
      const drawer = btn.closest('.hl-pdrawer');
      const from = drawer?.dataset.cat || '';
      if (!from || from === '未分类') return;
      const to = prompt(`把分类「${from}」重命名为：\n（清空 = 整类移回「未分类」）`, from);
      if (to === null) return;
      const n = renamePresetCat(from, to.trim());
      // 抽屉开合记忆跟着搬家，不然改名后抽屉全收上了
      if (presetUi.expanded.has(from)) {
        presetUi.expanded.delete(from);
        if (to.trim()) presetUi.expanded.add(to.trim());
        saveDrawers();
      }
      renderPresets(container);
      refresh(container);
      setStatus(container, to.trim()
        ? `分类已改名「${from}」→「${to.trim()}」（${n} 个预设同步）`
        : `「${from}」整类已移回未分类（${n} 个预设）`);
    });
  });

  // 批量勾选（卡片左上角复选框，bulk 模式才显示）
  box.querySelectorAll('.hl-preset-ck').forEach(ck => {
    ck.addEventListener('change', () => {
      const name = ck.closest('.hl-preset-card')?.dataset.name;
      if (!name) return;
      if (ck.checked) presetUi.checked.add(name); else presetUi.checked.delete(name);
      updateBulkBar(container);
    });
  });

  // ✎ 卡内编辑抽屉（同时只开一个）
  box.querySelectorAll('.hl-preset-editbtn').forEach(btn => {
    btn.addEventListener('click', () => {
      const card = btn.closest('.hl-preset-card');
      const editBox = card?.querySelector('.hl-preset-edit');
      if (!editBox) return;
      if (!editBox.hasAttribute('hidden')) {   // 再点一次 = 收起
        editBox.setAttribute('hidden', '');
        editBox.innerHTML = '';
        card.classList.remove('hl-cast-open');
        return;
      }
      box.querySelectorAll('.hl-preset-edit:not([hidden])').forEach(o => {
        o.setAttribute('hidden', '');
        o.innerHTML = '';
        o.closest('.hl-preset-card')?.classList.remove('hl-cast-open');
      });
      card.classList.add('hl-cast-open');      // 展开态吃掉整行，编辑面板才有地方放
      openPresetEditor(container, editBox, card.dataset.name);
    });
  });

  // 卡片空白处点击 = 进编辑（对齐角色卡的手感）
  box.querySelectorAll('.hl-preset-card').forEach(card => {
    card.addEventListener('click', (e) => {
      if (e.target.closest('button') || e.target.closest('.hl-preset-edit') || e.target.closest('.hl-preset-cardpick')) return;
      card.querySelector('.hl-preset-editbtn')?.click();
    });
  });

  // 📋 复制服装提示词 + ⤵插入 + 删除
  box.querySelectorAll('.hl-preset-card').forEach(card => {
    const name = card.dataset.name;
    card.querySelector('.hl-preset-copy')?.addEventListener('click', async () => {
      const text = String(listOutfitPresets()[name] || '');
      if (!text) { setStatus(container, `预设「${name}」没有描述可复制`, true); return; }
      const ok = await copyTextToClipboard(text);
      setStatus(container, ok
        ? `「${name}」的服装描述已复制到剪贴板（${text.length} 字）`
        : '复制失败 —— 浏览器拦了剪贴板，点开编辑手动全选复制', !ok);
    });
    /**
     * v0.9.74 · ⤵插入：把这张卡的款式追加进「正在编辑的目标」的款式描述框。
     * 单件服装（上衣 / 下装各存一条预设）拼成一套全靠它，省得手动复制粘贴。
     * 目标优先级：① 打开中的预设编辑抽屉；② 底部「新增预设」表单。
     */
    card.querySelector('.hl-preset-insert')?.addEventListener('click', () => {
      const src = String(listOutfitPresets()[name] || '').trim();
      if (!src) { setStatus(container, `预设「${name}」没有描述可插入`, true); return; }
      const openEdit = [...box.querySelectorAll('.hl-preset-edit:not([hidden]) .hl-pe-text')]
        .find(ta => ta.closest('.hl-preset-card') !== card);
      const target = openEdit || container.querySelector('#hl-preset-text');
      if (!target) { setStatus(container, '没有可插入的目标 —— 先点开某个预设的「编辑」（或用下方新增表单）再试', true); return; }
      const cur = target.value.trim();
      // 拼接：已有内容就以 ", " 接上（tag 串习惯）；避免出现双逗号/悬空逗号
      target.value = cur ? `${cur.replace(/[,;\s]+$/, '')}, ${src}` : src;
      const where = openEdit ? '正在编辑的预设' : '下方「新增预设」表单';
      setStatus(container, `「${name}」的款式已插入${where}的描述框 —— 记得点「保存」才生效`);
      target.focus();
    });
    card.querySelector('.hl-preset-del')?.addEventListener('click', async () => {
      if (!confirm(`删除预设「${name}」？引用它的角色会退回手写描述（引用字段还挂着，但读不到内容了）。`)) return;
      const img = getPresetImage(name);
      removeOutfitPreset(name);
      presetUi.checked.delete(name);
      if (img && img.startsWith('/user/files/')) await deleteUserFile(img);   // 服务器原始文件一并清
      renderPresets(container);
      refresh(container);
      setStatus(container, `预设「${name}」已删除`);
    });
  });
}

/* ============ 列表渲染 ============ */

/** 搜索命中：角色名 / 标签 / 所有锚点字段 / 服装描述 / 预设名。 */
function matchItem(item, kw) {
  if (!kw) return true;
  const dyn = getDyn(item.name);
  const hay = [
    item.name,
    item.entry?.label,
    ...Object.values(item.entry?.fields || {}),
    dyn?.outfit?.style,
    dyn?.outfit?.preset,
    resolveOutfitStyle(dyn),
  ].map(v => String(v || '')).join(' ').toLowerCase();
  return hay.includes(kw);
}

function inScope(item) {
  if (filter.scope === 'locked') return !!item.locked;
  if (filter.scope === 'char') return item.scope === 'char';
  if (filter.scope === 'noimg') return !getAvatar(item.name);
  return true;
}

function refresh(container) {
  const list = container.querySelector('#hl-cast-list');
  const statBox = container.querySelector('#hl-cast-stats');
  const countEl = container.querySelector('#hl-cast-count');
  if (!list) return;
  list.innerHTML = '';

  const s = stats();
  statBox.innerHTML = `
    <div class="hl-stat"><b>${s.castCount}</b><span>角色</span></div>
    <div class="hl-stat"><b>${s.withAnchorCount}</b><span>带完整锚点</span></div>
    <div class="hl-stat"><b>${s.lockedCount}</b><span>已锁定</span></div>
    <div class="hl-stat"><b>${s.dynCount}</b><span>动态状态</span></div>
    <div class="hl-stat"><b>${s.round}</b><span>当前轮次</span></div>`;

  const items = listCast();
  if (!items.length) {
    list.innerHTML = '<div class="hl-hint">档案库是空的。点「从角色卡建档」让模型提取一次，或手动「新建角色」。</div>';
    if (countEl) countEl.textContent = '';
    return;
  }

  // 全局锁定条目排前面
  items.sort((a, b) => (Number(b.locked) - Number(a.locked)) || a.name.localeCompare(b.name, 'zh'));

  const kw = filter.kw.toLowerCase().trim();
  const view = items.filter(it => inScope(it) && matchItem(it, kw));

  if (!view.length) {
    list.innerHTML = `<div class="hl-hint">没有匹配的角色（共 ${items.length} 个）。换个关键词，或点「清空」看全部。</div>`;
    if (countEl) countEl.textContent = `0 / ${items.length}`;
    return;
  }

  for (const item of view) list.appendChild(makeCard(container, item));
  if (countEl) {
    countEl.textContent = view.length === items.length
      ? `${items.length} 个角色`
      : `${view.length} / ${items.length} 个角色`;
  }
}

function setStatus(container, msg, isErr) {
  const el = container.querySelector('#hl-cast-status');
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle('hl-err', !!isErr);
}

/* ============ 挂载 ============ */

export async function mountCast(container) {
  container.innerHTML = html();
  /** 口径卡随当前模版变，切页时由 panel.js 回调刷新 */
  const refreshPersona = () => {
    try { renderPersonaCard(container); } catch { /* 渲染失败不打断档案页 */ }
  };
  refreshPersona();
  refresh(container);
  renderPresets(container);

  /* ---- 卡片展示样式（比例 / 大小） ---- */
  const listEl = container.querySelector('#hl-cast-list');
  const arEl = container.querySelector('#hl-cast-ar');
  const sizeEl = container.querySelector('#hl-cast-size');
  applyCardView(listEl);
  if (arEl) {
    arEl.value = cardView.ar;
    arEl.addEventListener('change', () => {
      cardView.ar = arEl.value || '2 / 3';
      lsSet(CARD_AR_KEY, cardView.ar);
      applyCardView(listEl);
    });
  }
  if (sizeEl) {
    sizeEl.value = String(cardView.w);
    sizeEl.addEventListener('input', () => {
      const n = parseInt(sizeEl.value, 10);
      if (!Number.isFinite(n)) return;
      cardView.w = Math.min(CARD_W_MAX, Math.max(CARD_W_MIN, n));
      lsSet(CARD_W_KEY, String(cardView.w));
      applyCardView(listEl);
    });
  }

  /* ---- 搜索 ---- */
  const searchEl = container.querySelector('#hl-cast-search');
  const scopeEl = container.querySelector('#hl-cast-scope');
  let timer = null;
  searchEl?.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      filter.kw = searchEl.value.trim();
      refresh(container);
    }, 180);
  });
  scopeEl?.addEventListener('change', () => {
    filter.scope = scopeEl.value;
    refresh(container);
  });
  container.querySelector('#hl-cast-clear-search')?.addEventListener('click', () => {
    filter.kw = '';
    filter.scope = 'all';
    if (searchEl) searchEl.value = '';
    if (scopeEl) scopeEl.value = 'all';
    refresh(container);
  });

  /* ---- 预设库工具栏：搜索 / 分类筛选 / 抽屉开合 / 批量模式 / 卡片比例大小 / 整节折叠 ---- */
  const pSearch = container.querySelector('#hl-preset-search');
  const pCat = container.querySelector('#hl-preset-catfilter');
  let pTimer = null;
  pSearch?.addEventListener('input', () => {
    clearTimeout(pTimer);
    pTimer = setTimeout(() => {
      presetUi.kw = pSearch.value.trim();
      renderPresets(container);
    }, 180);
  });
  pCat?.addEventListener('change', () => {
    presetUi.cat = pCat.value;
    renderPresets(container);
  });

  // 预设卡片比例 / 大小（视觉态本机记忆，与角色卡分开）
  const pListEl = container.querySelector('#hl-preset-list');
  const pArEl = container.querySelector('#hl-preset-ar');
  const pSizeEl = container.querySelector('#hl-preset-size');
  applyPresetCardView(pListEl);
  if (pArEl) {
    pArEl.value = presetCardView.ar;
    pArEl.addEventListener('change', () => {
      presetCardView.ar = pArEl.value || '2 / 3';
      lsSet(PRESET_AR_KEY, presetCardView.ar);
      applyPresetCardView(pListEl);
    });
  }
  if (pSizeEl) {
    pSizeEl.value = String(presetCardView.w);
    pSizeEl.addEventListener('input', () => {
      const n = parseInt(pSizeEl.value, 10);
      if (!Number.isFinite(n)) return;
      presetCardView.w = Math.min(CARD_W_MAX, Math.max(CARD_W_MIN, n));
      lsSet(PRESET_W_KEY, String(presetCardView.w));
      applyPresetCardView(pListEl);
    });
  }

  // 整节折叠：只切 secbody 显隐，不重渲染（编辑抽屉不丢）
  const secBody = container.querySelector('#hl-preset-secbody');
  const secArrow = container.querySelector('#hl-preset-secarrow');
  const paintSec = (open) => {
    if (secBody) secBody.hidden = !open;
    if (secArrow) secArrow.textContent = open ? '▾' : '▸';
  };
  paintSec(presetSecOpen());
  container.querySelector('#hl-preset-sectoggle')?.addEventListener('click', () => {
    const open = !presetSecOpen();
    lsSet(PRESET_SEC_KEY, open ? '1' : '0');
    paintSec(open);
  });
  container.querySelector('#hl-preset-expandall')?.addEventListener('click', () => {
    const box = container.querySelector('#hl-preset-list');
    box?.querySelectorAll('.hl-pdrawer').forEach(d => {
      const cat = d.dataset.cat;
      d.querySelector('.hl-pdrawer-body')?.removeAttribute('hidden');
      const arrow = d.querySelector('.hl-pdrawer-arrow');
      if (arrow) arrow.textContent = '▾';
      if (cat) presetUi.expanded.add(cat);
    });
    saveDrawers();
  });
  container.querySelector('#hl-preset-collapseall')?.addEventListener('click', () => {
    const box = container.querySelector('#hl-preset-list');
    box?.querySelectorAll('.hl-pdrawer').forEach(d => {
      d.querySelector('.hl-pdrawer-body')?.setAttribute('hidden', '');
      const arrow = d.querySelector('.hl-pdrawer-arrow');
      if (arrow) arrow.textContent = '▸';
    });
    presetUi.expanded.clear();
    saveDrawers();
  });
  container.querySelector('#hl-preset-bulkmode')?.addEventListener('change', (ev) => {
    presetUi.bulk = ev.currentTarget.checked;
    if (!presetUi.bulk) presetUi.checked.clear();
    renderPresets(container);
  });

  /* ---- 批量操作栏 ---- */
  container.querySelectorAll('#hl-preset-bulkbar [data-bulk]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const op = btn.dataset.bulk;
      btn.disabled = true;
      try {
        if (op === 'cat') {
          const names = [...presetUi.checked].filter(n => listOutfitPresets()[n]);
          if (!names.length) { setStatus(container, '先勾选要改分类的预设', true); return; }
          const cat = prompt(`把选中的 ${names.length} 个预设移到哪个分类？（留空 = 移回未分类）`);
          if (cat === null) return;
          for (const n of names) setPresetCat(n, cat.trim());
          presetUi.checked.clear();
          renderPresets(container);
          refresh(container);
          setStatus(container, `已把 ${names.length} 个预设移到「${cat.trim() || '未分类'}」`);
          return;
        }
        if (op === 'del') {
          const names = [...presetUi.checked].filter(n => listOutfitPresets()[n]);
          if (!names.length) { setStatus(container, '先勾选要删除的预设', true); return; }
          if (!confirm(`删除选中的 ${names.length} 个预设？\n${names.slice(0, 12).map(n => `· ${n}`).join('\n')}${names.length > 12 ? '\n…' : ''}\n\n引用它们的角色会退回手写描述。建议先导出档案备份。`)) return;
          for (const n of names) removeOutfitPreset(n);
          presetUi.checked.clear();
          renderPresets(container);
          refresh(container);
          setStatus(container, `已删除 ${names.length} 个预设`);
          return;
        }
        await runBulkAi(container, op);   // expand / translate / tagify / refine
      } finally {
        btn.disabled = false;
      }
    });
  });

  /* ---- v0.9.74 · 导出预设包：预设 + 分类 + 服装图片（dataURL 打包成一个 JSON） ---- */
  container.querySelector('#hl-preset-export')?.addEventListener('click', async () => {
    const presets = listOutfitPresets();
    const names = Object.keys(presets);
    if (!names.length) { setStatus(container, '还没有预设可导出', true); return; }
    const cats = listPresetCats();
    const images = {};
    let imgOk = 0;
    setStatus(container, `正在打包 ${names.length} 个预设（含服装图片）…`);
    for (const n of names) {
      const dataUrl = await imageUrlToDataUrl(getPresetImage(n));
      if (dataUrl) { images[n] = dataUrl; imgOk += 1; }
    }
    const pack = {
      kind: 'huilin-preset-pack', version: 1, exportedAt: new Date().toISOString(),
      presets, cats, images,
    };
    const blob = new Blob([JSON.stringify(pack)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `绘灵服装预设-${Date.now()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    setStatus(container, `已导出 ${names.length} 个预设（含图片 ${imgOk} 张）—— 导入用「⬆导入预设」`);
  });

  /* ---- v0.9.74 · 导入预设包：重建预设 / 分类 / 图片（图片重新上传到服务器，失败回退嵌存档） ---- */
  container.querySelector('#hl-preset-import')?.addEventListener('click', () => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.json,application/json';
    inp.addEventListener('change', async () => {
      const file = inp.files?.[0];
      if (!file) return;
      let pack;
      try { pack = JSON.parse(await file.text()); } catch (e) { setStatus(container, `导入失败：JSON 解析错误（${e?.message || e}）`, true); return; }
      if (pack?.kind !== 'huilin-preset-pack' || typeof pack.presets !== 'object' || !pack.presets) {
        setStatus(container, '导入失败：这不是绘灵服装预设导出文件（缺 kind 标记）', true);
        return;
      }
      const names = Object.keys(pack.presets);
      const overwrite = !confirm(`导入 ${names.length} 个预设（含图片 ${Object.keys(pack.images || {}).length} 张）。\n\n`
        + '点「确定」= 只补充缺失的预设（同名跳过）\n点「取消」= 覆盖同名预设');
      const existing = listOutfitPresets();
      const targets = names.filter(n => overwrite || !existing[n]);
      if (!targets.length) { setStatus(container, '没有需要导入的（全部已存在且选了补充模式）'); return; }
      let done = 0, imgOk = 0, imgFail = 0;
      for (const n of targets) {
        setStatus(container, `导入预设中：${done + 1} / ${targets.length}（${n}）…`);
        saveOutfitPreset(n, String(pack.presets[n] || ''));
        if (pack.cats && typeof pack.cats[n] === 'string') setPresetCat(n, pack.cats[n]);
        const img = String(pack.images?.[n] || '');
        if (img.startsWith('data:')) {
          const path = await uploadUserFile(n, img);   // 重新上传，文件名带内容 hash
          const old = getPresetImage(n);
          if (path) {
            if (old && old.startsWith('/user/files/') && old !== path) deleteUserFile(old);
            setPresetImage(n, path);
            imgOk += 1;
          } else {
            setPresetImage(n, img);   // 上传失败回退嵌存档
            imgFail += 1;
          }
        }
        done += 1;
      }
      presetUi.expanded.clear();   // 重建后抽屉开合记忆可能对不上，回到全收起
      saveDrawers();
      renderPresets(container);
      refresh(container);
      setStatus(container, `导入完成：预设 ${done} 个，图片成功 ${imgOk}${imgFail ? `（${imgFail} 张上传失败已嵌进存档）` : ''} —— 分类记录一并恢复`);
    });
    inp.click();
  });

  /* ---- 新增预设：保存（带分类） ---- */
  container.querySelector('#hl-preset-save').addEventListener('click', () => {
    const nm = container.querySelector('#hl-preset-name');
    const tx = container.querySelector('#hl-preset-text');
    const nc = container.querySelector('#hl-preset-newcat');
    const name = nm.value.trim();
    const text = tx.value.trim();
    if (!name || !text) { setStatus(container, '预设名和款式描述都要填', true); return; }
    if (listOutfitPresets()[name] && !confirm(`预设「${name}」已存在，覆盖它？`)) return;
    saveOutfitPreset(name, text);
    setPresetCat(name, nc?.value.trim() || '');
    nm.value = '';
    tx.value = '';
    if (nc) nc.value = '';
    presetUi.expanded.add(catOf(listPresetCats(), name));   // 保存后展开它所在的抽屉
    saveDrawers();
    renderPresets(container);
    refresh(container);
    setStatus(container, `预设「${name}」已保存 —— 在角色档案里引用它即可生效`);
  });

  /* ---- 新增预设：✦ AI 生成款式（指令框驱动，结果先填进描述框） ---- */
  container.querySelector('#hl-preset-aigen')?.addEventListener('click', async (ev) => {
    const btnEl = ev.currentTarget;
    const ask = container.querySelector('#hl-preset-ask')?.value.trim() || '';
    const text = container.querySelector('#hl-preset-text')?.value.trim() || '';
    if (!ask && !text) { setStatus(container, '先写一句你想要的款式（如：性感的透明睡裙 / 正式的职场西装）', true); return; }
    btnEl.disabled = true;
    setStatus(container, `正在${text ? '按指令改写' : '生成'}服装描述…`);
    try {
      const res = await aiPresetTool('', text, text ? 'refine' : 'create', (m, o) => callAnalyzeLLM(m, o),
        { instruction: ask, format: container.querySelector('#hl-preset-aigen-fmt')?.value || 'auto' });
      if (!res.ok) { setStatus(container, `AI 生成失败：${res.error || '详见诊断页'}`, true); return; }
      container.querySelector('#hl-preset-text').value = res.text;
      setStatus(container, '已填进「款式描述」—— 检查 / 补预设名和分类后点「保存预设」');
    } finally {
      btnEl.disabled = false;
    }
  });

  container.querySelector('#hl-cast-scan').addEventListener('click', async () => {
    const btn = container.querySelector('#hl-cast-scan');
    btn.disabled = true;
    setStatus(container, '正在建档…（模型提取中，通常 10~40 秒）');
    try {
      const res = await scanProfile();
      if (res.ok) setStatus(container, `建档完成：${res.count} 个角色`);
      else setStatus(container, `建档失败：${res.reason || '详见诊断页'}`, true);
    } finally {
      btn.disabled = false;
      refresh(container);
    }
  });

  container.querySelector('#hl-cast-new').addEventListener('click', () => {
    const name = prompt('角色名（要和正文里出现的写法一致）：');
    if (!name) return;
    const clean = name.trim();
    // 拦住 <user> / <bot> 这类占位符 —— 建成这种名字的档案是废的：
    // 出图时按真名查，永远查不到，等于这个人没有外貌。
    if (/^<(user|bot|char|persona|assistant|system)>$/i.test(clean)) {
      const real = aliasOf(clean);
      setStatus(container, `「${clean}」是占位符，不能当角色名${
        real !== clean ? ` —— 请填他的真名（当前是这个角色：**${real}**）` : ' —— 请填他在正文里的真名'
      }`, true);
      return;
    }
    upsertEntry(clean, { fields: {}, label: '', source: 'manual' }, {});
    refresh(container);
    setStatus(container, `已新建「${name}」，点卡片补字段和形象图`);
  });

  // ⚡ 批量生成自然语档案：对「当前筛选范围」内的角色生成。
  //   AI 撰写优先：一次请求处理全部角色 —— 除了档案字段，还会把每个角色相关的
  //   世界书/角色卡设定原文一并交给 AI 提取外貌（字段太简陋时描述才有血肉）。
  //   失败/未配置时自动回落内置词典。输出语言看「输出」下拉（中/英共用）。
  //   补空模式 —— 只处理 nlProfile 为空的角色，已有的一个不动（默认，安全）；
  //   重建模式 —— 覆盖范围内全部角色（含已锁定），需 confirm 二次确认。
  container.querySelector('#hl-cast-batch-nl')?.addEventListener('click', async (ev) => {
    const btnEl = ev.currentTarget;
    const mode = container.querySelector('#hl-cast-nlmode')?.value || 'fill';
    const kw = filter.kw.toLowerCase().trim();
    const items = listCast().filter(it => inScope(it) && matchItem(it, kw));
    if (!items.length) {
      setStatus(container, '当前筛选范围内没有角色 —— 放宽筛选（或点「清空」）再批量', true);
      return;
    }
    // 圈定要生成的目标：补空模式剔除已有 nlProfile 的；字段与参考资料全无的剔除
    const targets = [];
    let skipHas = 0, skipEmpty = 0;
    for (const it of items) {
      const fields = it.entry?.fields || {};
      if (mode === 'fill' && String(fields.nlProfile || '').trim()) { skipHas += 1; continue; }
      const refs = charRefsOf(it.name);
      if (!nlProfilePayload(fields).length && !refs) { skipEmpty += 1; continue; } // 字段与世界书都无外貌可提
      targets.push({ name: it.name, fields, refs, global: it.scope === 'global' });
    }
    if (!targets.length) {
      setStatus(container, `范围内 ${items.length} 个角色都没有需要生成的（已有 ${skipHas} / 无外貌来源 ${skipEmpty}）`);
      return;
    }
    if (mode === 'rebuild') {
      if (!confirm(`重建模式：将覆盖 ${targets.length} 个角色的自然语外貌档案（含已锁定角色），已有的手写内容会被新译文替换。\n确定继续？（想保留手写的请用「补空模式」）`)) return;
    }

    btnEl.disabled = true;
    setStatus(container, `正在批量撰写 ${targets.length} 个角色的自然语档案（读世界书 · ${nlLang() === 'en' ? '英文' : '中文'}输出 · 人多会稍慢）…`);
    try {
      const res = await translateProfiles(targets);
      let gen = 0;
      for (const t of targets) {
        const nl = res.map[t.name];
        if (!nl) continue;
        upsertEntry(t.name, { fields: { nlProfile: nl } }, { global: t.global });
        gen += 1;
      }
      refresh(container);
      const src = res.aiCount
        ? `AI 撰写 ${res.aiCount}${res.dictCount ? ` + 词典兜底 ${res.dictCount}` : ''}`
        : `内置词典兜底${res.aiError ? `（AI 不可用：${res.aiError}）` : ''}`;
      setStatus(container,
        `批量完成（${mode === 'fill' ? '补空' : '重建'} · 范围 ${items.length} 个角色）：生成 ${gen}（${src}），`
        + (mode === 'fill' ? `已有跳过 ${skipHas}，` : '')
        + `无外貌来源跳过 ${skipEmpty}`);
    } finally {
      btnEl.disabled = false;
    }
  });

  // 🔍 服装稳定档体检（v0.9.91）：逐角色说明「服装为什么会漂」。
  //   只读检查，不自动改任何设置 —— 人设与配置都是用户主权区，插件只负责把问题指出来。
  container.querySelector('#hl-cast-sdcheck')?.addEventListener('click', async (ev) => {
    const btnEl = ev.currentTarget;
    const out = container.querySelector('#hl-cast-sdcheck-out');
    btnEl.disabled = true;
    try {
      const { runCastStabilityCheck } = await import('../sdcheck.js');
      const r = runCastStabilityCheck();
      const lvText = { error: '❌ 会让服装缺失/错衣服', warn: '⚠️ 漂移风险', ok: '✅ 正常' };
      const lines = [];
      lines.push(`<b>体检结果：${r.counts.error} 个致命项 / ${r.counts.warn} 个风险项</b>（当前 ${r.engine === 'sd' ? 'SD' : 'K2'} 口径 · 本卡 ${r.castCount} 个角色）`);
      if (!r.castCount) {
        lines.push('<div class="hl-hint">本卡还没有任何角色档案 —— 先建档再体检。</div>');
      }
      for (const row of r.rows) {
        if (row.level === 'ok') continue;
        lines.push(`<div style="margin-top:6px;"><b>${escapeHtml(row.name)}</b> <span class="hl-hint">${lvText[row.level]}</span>`);
        for (const t of row.items) lines.push(`<div>&nbsp;&nbsp;${escapeHtml(t)}</div>`);
        lines.push('</div>');
      }
      if (r.rows.length && r.rows.every(x => x.level === 'ok')) {
        lines.push(`<div class="hl-hint">全部 ${r.rows.length} 个角色：${escapeHtml(r.rows[0].items[0])}</div>`);
      }
      if (r.cfgs.length) {
        lines.push('<div style="margin-top:8px;"><b>全局设置</b></div>');
        for (const c of r.cfgs) lines.push(`<div>${escapeHtml(c.text)}</div>`);
      }
      if (out) out.innerHTML = lines.join('');
      setStatus(container, `服装稳定档体检完成：${r.counts.error} 致命 / ${r.counts.warn} 风险${r.counts.error ? ' —— 先看致命项，服装会直接画不出来' : ''}`);
    } catch (e) {
      if (out) out.innerHTML = `<div class="hl-hint">体检失败：${escapeHtml(String(e?.message || e))}</div>`;
      setStatus(container, `体检失败：${String(e?.message || e)}`, true);
    } finally {
      btnEl.disabled = false;
    }
  });

  // 🗑 一键清空全部档案：自动备份 → confirm → 清空（本卡 + 全局）
  container.querySelector('#hl-cast-clearall')?.addEventListener('click', () => {
    const s = stats();
    if (!s.castCount) { setStatus(container, '档案库已经是空的'); return; }
    if (!confirm(`将删除全部 ${s.castCount} 个角色档案（本卡 + 全局锁定条目，含形象图与自然语档案）。\n\n清空前会自动下载一份 JSON 备份到浏览器默认下载目录。\n确定继续？`)) return;
    try {   // 自动备份（和「导出档案」同一格式），防手滑
      const text = exportAll();
      const blob = new Blob([text], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `绘灵档案-清空备份-${Date.now()}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } catch { /* 备份失败不阻断清空 —— 用户已明确确认两次 */ }
    const r = clearAllCast({ includeGlobal: true });
    refresh(container);
    setStatus(container, `已清空全部档案：本卡 ${r.removed} 个 + 全局 ${r.globalRemoved} 个（备份已自动下载）—— 现在可以重新导入了`);
  });

  // 输出语言下拉（档案区 + 预设区共用一个记忆，任一处切换两处同步）
  const langEls = [
    container.querySelector('#hl-cast-nllang'),
    container.querySelector('#hl-preset-lang'),
  ].filter(Boolean);
  for (const el of langEls) {
    el.value = nlLang();
    el.addEventListener('change', () => {
      setNlLang(el.value);
      for (const other of langEls) other.value = el.value;
      setStatus(container, `自然语输出语言已切换为${el.value === 'en' ? '英文' : '中文'}（档案与服装扩写共用）`);
    });
  }

  container.querySelector('#hl-cast-export').addEventListener('click', () => {
    const text = exportAll();
    const blob = new Blob([text], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `绘灵档案-${Date.now()}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    setStatus(container, '档案已导出');
  });

  container.querySelector('#hl-cast-import').addEventListener('click', () => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.json,application/json';
    inp.addEventListener('change', async () => {
      const file = inp.files?.[0];
      if (!file) return;
      const text = await file.text();
      const mode = confirm('点「确定」= 只补充缺失条目（推荐）\n点「取消」= 覆盖同名条目');
      const res = importAll(text, { overwrite: !mode });
      if (res.ok) {
        setStatus(container, `导入完成：新增 ${res.added}，跳过 ${res.skipped}`);
        refresh(container);
      } else {
        setStatus(container, `导入失败：${res.reason}`, true);
      }
    });
    inp.click();
  });
  return { refreshPersona };
}
