/**
 * 绘灵 · 设置面板外壳
 *
 * 五个页签：基本 / 生图后端 / 提示词模版 / 角色档案 / 诊断
 * 纯手写 DOM，不引入框架 —— 改一行刷新即生效，不需要重新打包。
 */

import { escapeHtml } from '../util.js';
import {
  getConfig, saveSettings, getActiveTemplate, addTemplate, removeTemplate,
} from '../settings.js';
import { mountBackend } from './backend.js';
import { enableSectionCollapse } from './collapse.js';
import { mountCast } from './cast.js';
import { mountDiag } from './diag.js';
import { mountGallery } from './gallery.js';
import { scanAll, forceRerun, isRunning, inflightCount } from '../scanner.js';
import { registerRegex, unregisterRegex, render, pauseRateLimit, setInlineMode } from '../render.js';
import { getLastAiMesId, getChat } from '../st.js';
import { getRound, listCast } from '../store.js';
import { VERSION } from '../version.js';
import { info, warn, STAGE } from '../log.js';
import { MOSS_LAYOUTS, normalizeMossOptions, normalizeMossNsfw, normalizeMossEnhance, normalizeMossCover } from '../mossLayout.js';
/**
 * ★ v0.9.140：漫画页版式库（只给「剧情演完」用）。
 *   坐标由这套版式算，模型不再写 bbox —— 所以用户在这里选的是**整页排版**。
 *   （原来的「多格排版（旧）」下拉只对旧 JSON 路径生效，v0.9.154 已随面板瘦身删除。）
 */
import { MANGA_LAYOUTS } from '../mossMangaLayouts.js';

/**
 * 按当前设置重绘所有楼层，返回被重绘的楼层数。
 * 用 pauseRateLimit 包住：这是用户主动的一次性全量重绘，不该被风暴闸门冻住
 * （v0.9.33 —— 闸门新增了全局耗时维度后，不豁免的话一次「全部刷新」就自己把自己冻了）。
 */
function renderAllFloors() {
  return pauseRateLimit(() => {
    try {
      let n = 0;
      getChat().forEach((_, i) => {
        try { if (render(i) > 0) n += 1; } catch { /* 单层失败不影响其它层 */ }
      });
      return n;
    } catch {
      return 0;
    }
  });
}

const TABS = [
  { key: 'basic', label: '基本', short: '基本', icon: 'fa-sliders' },
  // 「手动」排第二：它是兜底入口（自动漏触发时手动补），用得比调参频繁
  { key: 'manual', label: '手动生图', short: '手动', icon: 'fa-wand-magic-sparkles' },
  // 「出词」在前、「生图」在后 —— 顺序就是管线的顺序：先想画什么，再画
  { key: 'llm', label: '出词 API', short: '出词', icon: 'fa-brain' },
  { key: 'backend', label: '生图后端', short: '后端', icon: 'fa-server' },
  // 全局词库（前缀/后缀/全局负面 + 预设）从后端页独立出来，改词不用翻参数堆
  { key: 'gwords', label: '全局词库', short: '词库', icon: 'fa-tags' },
  { key: 'template', label: '提示词模版', short: '模板', icon: 'fa-file-lines' },
  { key: 'cast', label: '角色档案', short: '档案', icon: 'fa-users' },
  { key: 'gallery', label: '图库', short: '图库', icon: 'fa-images' },
  // v0.9.164：GAL（IGS）借用绘灵写词 + 出图 —— 跨插件联动的开关都在这一页
  { key: 'gal', label: '外部联动', short: '联动', icon: 'fa-plug' },
  // v0.9.187：「龙血玄黄·数据库」的场景/时间/在场/纪要注入 —— 只读，开关与预览都在这
  { key: 'db', label: '数据库', short: '库', icon: 'fa-database' },
  { key: 'diag', label: '诊断', short: '诊断', icon: 'fa-stethoscope' },
];

/**
 * 面板外壳。
 *
 * @param {'embedded'|'window'} variant
 *   embedded —— 扩展设置里用的那版：inline-drawer，带折叠三角
 *   window   —— 绘灵窗口里用的那版：不要 inline-drawer 那套（窗口自己有头），
 *               页签由窗口的侧边导航驱动
 */
function shellHtml(variant = 'embedded') {
  const tabs = TABS.map((t, i) => `
        <button class="hl-tab${i === 0 ? ' active' : ''}" data-tab="${t.key}" title="${t.label}" type="button">
          <i class="fa-solid ${t.icon} hl-tab-ico"></i><span class="hl-tab-txt">${t.label}</span><span class="hl-tab-short">${t.short}</span>
        </button>`).join('');
  const panes = TABS.map((t, i) => `
        <div class="hl-pane${i === 0 ? ' active' : ''}" data-pane="${t.key}"></div>`).join('');

  if (variant === 'window') {
    return `
<div class="hl-root hl-root-window">
  <div class="hl-tabs">${tabs}
  </div>
  <div class="hl-panes">${panes}
  </div>
</div>`;
  }

  return `
<div class="hl-root">
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header hl-header">
      <b>绘灵</b>
      <small class="hl-sub">剧情自动配图 · 角色一致性引擎</small>
      <span class="hl-ver" title="插件版本 —— 刷新后若与你刚部署的不一致，说明酒馆加载的是另一份副本">v${VERSION}</span>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">
      <div class="hl-tabs">${tabs}
      </div>
      <div class="hl-panes">${panes}
      </div>
    </div>
  </div>
</div>`;
}

/* ============ 基本页 ============ */

function basicHtml() {
  const cfg = getConfig();
  const row = (id, label, hint, type, value, extra = '') => `
    <div class="hl-field">
      <label class="hl-label" for="${id}">${label}</label>
      <input id="${id}" type="${type}" value="${escapeHtml(String(value))}" ${extra}>
      ${hint ? `<div class="hl-hint">${hint}</div>` : ''}
    </div>`;

  const check = (id, label, hint, checked) => `
    <label class="hl-check">
      <input id="${id}" type="checkbox" ${checked ? 'checked' : ''}>
      <span>${label}</span>
      ${hint ? `<div class="hl-hint">${hint}</div>` : ''}
    </label>`;

  return `
<div class="hl-section">
  <div class="hl-section-title">运行</div>
  ${check('hl-enabled', '启用绘灵', '总开关。关闭后完全不触发，不消耗 API。', cfg.enabled)}
  ${check('hl-autorun', '自动分析新的 AI 楼层', '关掉后只能手动点「处理最后楼层」。', cfg.autoRun)}
  ${check('hl-include-user', '历史上下文包含用户楼层', '', cfg.includeUserFloors)}
  ${check('hl-notify', '出图气泡通知（SD 助手式）', '开始分析/生图、成功插了几张图、失败原因，都弹在屏幕角落。', cfg.notify !== false)}
  <div class="hl-grid2">
    ${row('hl-genretry', '生图失败自动重试次数', '生图请求临时失败（限流 / 服务端 5xx / 网络抖动）时自动重试几回，0 = 失败直接报错。配错类失败（Key 无效、工作流问题）不重试。', 'number', cfg.genRetries ?? 1, 'min="0" max="5"')}
  </div>
</div>

<div class="hl-section">
  <div class="hl-section-title">触发条件</div>
  <div class="hl-grid2">
    ${row('hl-carry', '携带最近 AI 楼数', '只用于理解上下文，不会为这些楼配图。', 'number', cfg.carryFloors, 'min="0" max="10"')}
    ${row('hl-maximg', '单楼最大图片数', '', 'number', cfg.maxImagesPerFloor, 'min="1" max="9"')}
    ${row('hl-minimg', '单楼最少图片数', '写入出图指令：要求模型每楼至少配几张（1 = 不强制）。模型判断画面不足时仍可能少配，日志里会提示。', 'number', cfg.minImagesPerFloor ?? 1, 'min="1" max="9"')}
    ${row('hl-minlen', '正文最短长度（字符）', '低于这个长度不出图，避免闲聊也触发。', 'number', cfg.minBodyLength, 'min="0" max="2000"')}
  </div>
</div>

<div class="hl-section">
  <div class="hl-section-title">服装延续</div>
  ${check('hl-outfitscan', '生图前扫描正文服装（推荐开）',
    '每楼生图前用一次轻量请求，从「本楼 + 最近剧情」里读出各在场角色<strong>此刻穿着</strong>写进角色档案，出图时逐字沿用 —— 服装不再每轮重新编一遍。'
    + '<br>已记录服装、且本楼没有换装描写的角色会直接跳过沿用，多数楼实际只扫 1–2 人。'
    + '<br>换装动词（「她换上了…」「脱掉外套换了一身…」）一命中就换；'
    + '只写了具体衣服（「她穿着白色丝质睡裙」）则计入「几楼才换」门槛，达标才换。'
    + '同一件衣服只是换个说法不算换装，会被挡住并把原因写进诊断日志。'
    + '<br>关掉就退回旧行为：服装只能靠出词模型主动上报（实测基本不报，服装会漂）。',
    cfg.consistency ? cfg.consistency.outfitScan !== false : true)}
  ${row('hl-outfitfloors', '服装扫描回看几楼', '出图只要接得上上一张（2 楼够），但<b>服装态是跨楼延续的</b> —— 只看 2 楼，模型判断不出「三楼前他脱了、这一楼穿回去没有」，只能沿用旧值。这里单独给服装扫描一个更宽的窗口，不影响出图。', 'number', cfg.consistency?.outfitScanFloors ?? 5, 'min="1" max="12"')}
  ${row('hl-outfitrepeat', '同一套新款提到几楼才换', '防漂移挡的是「模型每楼重新描述一遍」。但剧情<b>直接改写</b>服装又没写「换上」时（如正文改口叫他穿灰色运动裤），旧款会被永久锁死。这里设一个门槛：同一套具体衣服被剧情反复提到 N 楼 → 认定为剧情改了设定，放行。'
    + '<br><b>v0.9.67 起：正文只要具体写了件衣服</b>（「她穿着白色丝质睡裙」）就会开始计数，'
    + '不再要求出现「换上/改穿」这类换装动词 —— 换装动词仍然是一写就换，不受此限。'
    + '<br>填 <b>1</b> ＝ 正文一写就换（最快，但可能把"一件校服八个版本"放回来）；'
    + '填 <b>2</b>（默认）＝ 隔一楼确认才换，兼顾灵敏与防漂；数字越大越保守。', 'number', cfg.consistency?.outfitStyleRepeatFloors ?? 2, 'min="1" max="5"')}
  ${check('hl-autodims', '让模型自动填「服装三维度」（默认关）',
    '扫描正文服装时，顺手让模型填<strong>状态细档 / 改造 / 鞋袜</strong>这三档（如「裙摆撩起」「透明化」「黑色细高跟」），'
    + '省得每楼去档案页手动选。'
    + '<br><b>默认关是故意的</b>：这是给模型的<strong>写权限</strong> —— 开着它每楼都能改写这三项，'
    + '而这三项的英文是<strong>直接进画面</strong>的。模型判断与正文有出入时，画面会立刻穿帮'
    + '（比如正文只写了「裙子有点乱」，它填成「全裸」）。'
    + '<br>关着时：三维度只能由你在「角色档案 → 服装」里手动设定，'
    + '模型就算自己回了这三个字段也会被忽略（不入库、不进画面）。'
    + '<br>开着时：只对这三档生效，<b>不动款式本身</b> —— 款式仍走上面那套防漂移闸门。',
    cfg.consistency?.autoOutfitDims === true)}
</div>

<div class="hl-section">
  <div class="hl-section-title">正文 tag 与正则</div>
  ${check('hl-regex', '注册绘灵正则（推荐，两条）', '一条管显示（把 tag 换成出图位占位符），一条管提示词（把 tag 删干净）。都用固定 ID 更新，不动你已有的正则。', cfg.registerRegex)}
  ${check('hl-inline', '图内联到剧情正文（改完需刷新页面）',
    '<strong>开</strong>：图跟着正文走，显示在剧情对应位置（依赖"美化卡片把正文搬进 iframe"，'
    + '绘灵会进那个 iframe 里渲染）。想看图嵌在故事里就开这个。'
    + '<br><strong>关（默认）</strong>：出图位搬到正文块外，图统一堆在楼层顶部 —— 所有卡都吃这套，最稳。'
    + '<br><b>两种情况请关掉它</b>：① 图一张都不显示了；② 你的卡没用正文美化（没有 iframe），开了等于没有槽位。'
    + '<br>注意：切换只对新渲染的楼立即生效，<b>已经显示出来的旧楼要 Ctrl+F5 刷新</b>才会变。',
    cfg.moveSlotsOutOfNowPlot === false)}
  ${check('hl-adult', '成人画面优先（成人情节按成人方式配图）',
    '<strong>开</strong>：正文出现明确性行为 / 性器官接触 / 隐私部位裸露时，按成人画面判定'
    + '（不再"拿不准就退回 SFW"），配图名额优先给正在发生的动作，并要求姿态写实 ——'
    + '器官+部位+方向一次写死、必写插入方向与胯部对齐，禁止 working between her thighs 这类模糊动词。'
    + '<br><strong>MOSS 口径同样生效</strong>（纯 prompt 版与 JSON Layout 版都接）：'
    + '打开后追加「成人画面写法」—— 承重面 / 两只手 / 下肢落点必写、'
    + '特写格不挂全身人物、框高必须装得下写的动作（这三条是肢体被格线切断的直接解药）。'
    + '<br><strong>关（默认）</strong>：不追加任何指令，行为与以前完全一致。'
    + '<br>用途：解决成人情节的图跟正文八竿子打不着（画面被写成拥抱 / 擦边 / 暗示）。'
    + '合规硬边界（未成年 / 非自愿）不受本开关影响。',
    cfg.adultPosePriority === true)}
  <div class="hl-actions">
    <button class="hl-btn" id="hl-run-last">处理最后楼层</button>
    <button class="hl-btn" id="hl-run-all">扫描全部楼层</button>
    <button class="hl-btn hl-ghost" id="hl-toggle-regex">重新注册正则</button>
  </div>
  <div class="hl-status" id="hl-basic-status"></div>
</div>

<div class="hl-section">
  <div class="hl-section-title">图片渲染</div>
  <div class="hl-field">
    <label class="hl-label" for="hl-render-mode">显示方式</label>
    <select id="hl-render-mode" class="hl-input">
      <option value="inline"${cfg.render?.mode === 'inline' ? ' selected' : ''}>段落级 —— 图顶掉出图位（推荐）</option>
      <option value="media"${cfg.render?.mode === 'media' ? ' selected' : ''}>消息末尾 —— 图集中在消息底部</option>
      <option value="off"${cfg.render?.mode === 'off' ? ' selected' : ''}>不显示 —— 只保留出图位文本</option>
    </select>
    <div class="hl-hint">段落级：图出现在它所属那一段的下面，剧情顺序一眼对得上。</div>
  </div>
  ${check('hl-render-pending', '未出图时显示占位框', '出图位先显示「等待出图…」，而不是一片空白。', cfg.render?.showPending)}
  ${check('hl-render-retry', '占位框带「重新生成」按钮', '某张图失败或想换一张时，不用整楼重跑。', cfg.render?.retry)}
  ${check('hl-render-all', '显示全部图片', '关掉则每次只显示第一张（省流量）。', cfg.render?.allImages)}
  ${row('hl-render-maxh', '图片最大高度(px)', '0 = 不限，跟随图片原始比例。', 'number', cfg.render?.maxHeight ?? 0, 'min="0" max="2000"')}
  <div class="hl-field">
    <label class="hl-label" for="hl-render-scale">
      默认图片宽度 <span class="hl-scale-out" id="hl-render-scale-out">${cfg.render?.defaultScale ?? 100}%</span>
    </label>
    <input type="range" id="hl-render-scale" class="hl-range" min="20" max="200" step="5" value="${cfg.render?.defaultScale ?? 100}" />
    <div class="hl-hint">正文里所有图的默认宽度。单张图还能用图片右上角的工具条、或右下角的把手单独调，互不影响。</div>
  </div>
</div>

<div class="hl-section">
  <div class="hl-section-title">图片存储</div>
  ${check('hl-archive', '出图后归档到酒馆图库（推荐开）',
    '开：每张图出完立刻复制一份到 <code>/user/images/绘灵_&lt;角色名&gt;/</code>，链接永久有效 —— ComfyUI 重启、清 history、清理输出目录都不影响。' +
    '<br>关：图只留在 ComfyUI 输出目录，省一半空间，但 ComfyUI 重启或你清理输出目录后，存档里的图会变破图。' +
    '<br>⚠️ 本开关只管<strong>以后</strong>的图，已归档的图不受影响。',
    cfg.storage ? cfg.storage.archive !== false : true)}
  <div class="hl-hint">归档位置：<code>/user/images/绘灵_&lt;角色名&gt;/</code>（由酒馆服务端管理，插件改不了它的绝对路径）。</div>
  <div class="hl-hint hl-storage-lead">C 盘吃紧时，可以把整个绘灵图库搬到别的硬盘：搬走后在原位留一个<strong>目录联接</strong>，路径不变 —— 图库和存档里的图<strong>一张都不会失效</strong>，也不需要改任何配置。</div>
  <div class="hl-hint">迁移是磁盘操作，浏览器里的插件没权限做，请用源码目录下的 <code>tools/migrate-archive.mjs</code>（<code>--to</code> 指定新位置，先空跑 <code>--dry-run</code> 看计划）。</div>
</div>

<div class="hl-section">
  <div class="hl-section-title">界面入口</div>
  <div class="hl-hint hl-ui-lead">绘灵的主界面是独立窗口。下面三条路任挑一条，都是一步打开 —— 都开也不冲突。</div>
  ${check('hl-ui-topbar', '顶栏按钮', '挨着酒馆原生顶栏图标，跟随你的主题美化。', cfg.ui?.topbar !== false)}
  ${check('hl-ui-menu', '魔杖菜单项', '和别的扩展一个口径，在 🪄 菜单里。', cfg.ui?.menu !== false)}
  ${check('hl-ui-orb', '屏幕边缘悬浮球', '可拖动；拖到左右边缘会贴边半隐、悬停滑出。', !!cfg.ui?.orb)}
  <div class="hl-grid2">
    ${row('hl-orb-size', '悬浮球尺寸(px)', '28–96。', 'number', cfg.ui?.orbSize ?? 46, 'min="28" max="96"')}
    ${row('hl-orb-opacity', '悬浮球不透明度(%)', '静止时的透明度，悬停会全显。', 'number', cfg.ui?.orbOpacity ?? 60, 'min="20" max="100"')}
  </div>
  <div class="hl-field">
    <label class="hl-label">🩺 悬浮球自检</label>
    <div class="hl-hint" id="hl-orb-diag">勾了却看不见？点下面的按钮：会强制重建、把球拉回屏幕内、并让它闪烁 6 秒，同时报出位置和「被谁盖住」。</div>
    <div class="hl-actions">
      <button class="hl-btn hl-ghost hl-mini" id="hl-orb-probe" type="button">检查并定位悬浮球</button>
    </div>
  </div>
  <div class="hl-actions">
    <button class="hl-btn" id="hl-open-window">打开绘灵窗口</button>
    <button class="hl-btn hl-ghost" id="hl-reset-win">窗口复位（大小与位置）</button>
  </div>
  <div class="hl-status" id="hl-ui-status"></div>
</div>`;
}

function bindBasic(root) {
  const cfg = getConfig();

  const bindCheck = (id, key, after) => {
    const el = root.querySelector(`#${id}`);
    if (!el) return;
    el.addEventListener('change', () => {
      cfg[key] = el.checked;
      saveSettings();
      after?.(el.checked);
    });
  };
  const bindNum = (id, key) => {
    const el = root.querySelector(`#${id}`);
    if (!el) return;
    el.addEventListener('change', () => {
      const n = Number(el.value);
      cfg[key] = Number.isFinite(n) ? n : cfg[key];
      el.value = cfg[key];
      saveSettings();
    });
  };

  bindCheck('hl-enabled', 'enabled', (on) => {
    setStatus(`插件已${on ? '开启' : '关闭'}`);
  });
  bindCheck('hl-autorun', 'autoRun');
  bindCheck('hl-include-user', 'includeUserFloors');
  bindCheck('hl-notify', 'notify');
  bindCheck('hl-regex', 'registerRegex', (on) => {
    if (on) registerRegex();
    else unregisterRegex();
  });

  // 图内联开关：一次要改 moveSlotsOutOfNowPlot + renderInsideIframe 两个键、还要重注册正则，
  // bindCheck 只认单个顶层 key，所以单独写（逻辑收口在 render.js:setInlineMode）
  {
    const el = root.querySelector('#hl-inline');
    if (el) el.addEventListener('change', () => {
      setInlineMode(el.checked);
      saveSettings();
      setStatus(el.checked
        ? '图内联已开启：Ctrl+F5 刷新后，新楼的图片会显示在剧情正文对应位置（旧楼需重跑出图）'
        : '图内联已关闭：Ctrl+F5 刷新后，图片恢复堆在楼层顶部（兼容性最好）');
    });
  }

  // 成人画面优先（v0.9.82）：顶层 key，bindCheck 自带 saveSettings
  bindCheck('hl-adult', 'adultPosePriority', (on) => {
    setStatus(on
      ? '成人画面优先已开启：下一楼起，成人情节按成人方式配图（判定放宽 + 姿态写实）'
      : '成人画面优先已关闭：恢复原有判定与写法');
  });

  // 图片归档开关：storage.archive 是**嵌套**字段，bindCheck 只认顶层 key，单独写
  {
    const el = root.querySelector('#hl-archive');
    if (el) el.addEventListener('change', () => {
      if (!cfg.storage || typeof cfg.storage !== 'object') cfg.storage = {};
      cfg.storage.archive = el.checked;
      saveSettings();
      setStatus(el.checked
        ? '图片归档已开启（新图会存一份到酒馆图库，永久有效）'
        : '图片归档已关闭（新图只留在 ComfyUI 输出目录，重启可能失效）');
    });
  }

  // 服装态扫描：consistency.outfitScan 是**嵌套**字段，bindCheck 只认顶层 key，单独写
  {
    const el = root.querySelector('#hl-outfitscan');
    if (el) el.addEventListener('change', () => {
      if (!cfg.consistency || typeof cfg.consistency !== 'object') cfg.consistency = {};
      cfg.consistency.outfitScan = el.checked;
      saveSettings();
      setStatus(el.checked
        ? '服装扫描已开启：生图前会从正文读出各角色此刻穿着，之后逐字沿用'
        : '服装扫描已关闭：服装只能靠出词模型主动上报，容易漂移');
    });
  }

  // 服装扫描的两个新数值也是 consistency 的**嵌套**字段，bindNum 只认顶层，单独写
  {
    const el = root.querySelector('#hl-outfitfloors');
    if (el) el.addEventListener('change', () => {
      if (!cfg.consistency || typeof cfg.consistency !== 'object') cfg.consistency = {};
      const n = Math.min(12, Math.max(1, Number(el.value) || 5));
      cfg.consistency.outfitScanFloors = n;
      el.value = n;
      saveSettings();
      setStatus(`服装扫描回看 ${n} 楼（出图仍用 ${cfg.carryFloors} 楼，互不影响）`);
    });
  }
  {
    const el = root.querySelector('#hl-outfitrepeat');
    if (el) el.addEventListener('change', () => {
      if (!cfg.consistency || typeof cfg.consistency !== 'object') cfg.consistency = {};
      const n = Math.min(5, Math.max(1, Number(el.value) || 2));
      cfg.consistency.outfitStyleRepeatFloors = n;
      el.value = n;
      saveSettings();
      setStatus(n === 1
        ? '款式改写已完全放开（不设防，可能回到「一件校服出八个版本」的老路）'
        : `同一套新款被剧情提到 ${n} 楼才放行改写款式`);
    });
  }

  // v0.9.72 · 三维度自动填写开关（consistency 嵌套字段，bindCheck 认不到，单独写）
  {
    const el = root.querySelector('#hl-autodims');
    if (el) el.addEventListener('change', () => {
      if (!cfg.consistency || typeof cfg.consistency !== 'object') cfg.consistency = {};
      cfg.consistency.autoOutfitDims = el.checked;
      saveSettings();
      setStatus(el.checked
        ? '已放开：扫描模型会自动填状态细档 / 改造 / 鞋袜（款式本身仍受防漂移闸门保护）'
        : '已收回：三维度只能由你在「角色档案 → 服装」手动设定，模型不再有写权限');
    });
  }

  bindNum('hl-carry', 'carryFloors');
  bindNum('hl-maximg', 'maxImagesPerFloor');
  bindNum('hl-minimg', 'minImagesPerFloor');
  bindNum('hl-minlen', 'minBodyLength');
  bindNum('hl-genretry', 'genRetries');

  root.querySelector('#hl-run-last')?.addEventListener('click', async () => {
    const mesId = getLastAiMesId();
    if (mesId < 0) { setStatus('没有找到 AI 楼层', true); return; }
    setStatus(`正在处理楼层 #${mesId}…`);
    await forceRerun(mesId);
    setStatus(`楼层 #${mesId} 已处理（详情见「诊断」页）`);
  });

  root.querySelector('#hl-run-all')?.addEventListener('click', async () => {
    setStatus('正在排队扫描…');
    const n = await scanAll();
    setStatus(`已排队 ${n} 个楼层`);
  });

  root.querySelector('#hl-toggle-regex')?.addEventListener('click', () => {
    const ok = registerRegex();
    setStatus(ok ? '绘灵正则已重新注册（显示槽 + 提示词清理）' : '注册失败（详见诊断页）', !ok);
  });

  /* ---- 渲染设置 ---- */

  const rcfg = () => {
    const c = getConfig();
    if (!c.render || typeof c.render !== 'object') c.render = {};
    return c.render;
  };

  root.querySelector('#hl-render-mode')?.addEventListener('change', (e) => {
    rcfg().mode = e.target.value;
    saveSettings();
    const n = renderAllFloors();
    setStatus(`显示方式 → ${e.target.value}${n ? `（已重绘 ${n} 层）` : ''}`);
  });

  const bindRenderCheck = (id, key) => {
    const el = root.querySelector(`#${id}`);
    if (!el) return;
    el.addEventListener('change', () => {
      rcfg()[key] = el.checked;
      saveSettings();
      renderAllFloors();
    });
  };
  bindRenderCheck('hl-render-pending', 'showPending');
  bindRenderCheck('hl-render-retry', 'retry');
  bindRenderCheck('hl-render-all', 'allImages');

  const maxhEl = root.querySelector('#hl-render-maxh');
  maxhEl?.addEventListener('change', () => {
    const n = Number(maxhEl.value);
    rcfg().maxHeight = Number.isFinite(n) && n >= 0 ? n : 0;
    maxhEl.value = rcfg().maxHeight;
    saveSettings();
    renderAllFloors();
  });

  // 默认图片宽度：拖动时只更新数字（实时重绘会闪），松手才落盘 + 重绘
  const scaleEl = root.querySelector('#hl-render-scale');
  const scaleOut = root.querySelector('#hl-render-scale-out');
  const showScale = () => {
    if (scaleOut) scaleOut.textContent = `${Number(rcfg().defaultScale) || 100}%`;
  };
  scaleEl?.addEventListener('input', () => {
    rcfg().defaultScale = Number(scaleEl.value);
    showScale();
  });
  scaleEl?.addEventListener('change', () => {
    rcfg().defaultScale = Number(scaleEl.value);
    showScale();
    saveSettings();
    renderAllFloors();
  });

  /* ---- 界面入口 ---- */

  // 用动态 import：panel ← launcher ← window ← panel 是个环，
  // 静态引入会在模块初始化阶段拿到 undefined，动态引入绕开。
  const ucfg = () => {
    const c = getConfig();
    if (!c.ui || typeof c.ui !== 'object') c.ui = {};
    return c.ui;
  };
  const uiStatus = (msg) => {
    const el = root.querySelector('#hl-ui-status');
    if (el) el.textContent = msg;
  };
  const syncLauncher = () => {
    import('./launcher.js').then(m => m.syncLauncher()).catch(() => { /* 入口失败不阻断面板 */ });
  };

  const bindUiCheck = (id, key) => {
    const el = root.querySelector(`#${id}`);
    if (!el) return;
    el.addEventListener('change', () => {
      ucfg()[key] = el.checked;
      saveSettings();
      syncLauncher();
      uiStatus(`入口设置已更新（${el.checked ? '开' : '关'}）`);
      /**
       * ★ v0.9.103：勾上悬浮球当场闪 6 秒。
       * 用户反复报「勾了没有球」，而球默认是**贴边半隐 + 60% 不透明度**，
       * 在深色页面边缘几乎等于隐形。开的时候主动闪一下，比让他去屏幕边上找靠谱得多；
       * 顺带如果球根本没被建出来，probeOrb 会强制重建一次并如实报告。
       */
      if (key === 'orb' && el.checked) {
        import('./launcher.js').then((m) => {
          const r = m.probeOrb();
          uiStatus(r.ok
            ? `悬浮球已开启 —— 正在闪 6 秒，看屏幕${r.rect && r.rect.x > window.innerWidth / 2 ? '右' : '左'}边缘`
            : '悬浮球没有建出来，点下方「检查并定位悬浮球」看原因');
        }).catch((err) => {
          uiStatus(`悬浮球自检没跑起来：${err?.message || err}`);
        });
      }
    });
  };
  bindUiCheck('hl-ui-topbar', 'topbar');
  bindUiCheck('hl-ui-menu', 'menu');
  bindUiCheck('hl-ui-orb', 'orb');

  const bindUiNum = (id, key, min, max, rebuildOrb) => {
    const el = root.querySelector(`#${id}`);
    if (!el) return;
    el.addEventListener('change', () => {
      const n = Number(el.value);
      const v = Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : ucfg()[key];
      ucfg()[key] = v;
      el.value = v;
      saveSettings();
      // 改了尺寸/透明度得重建球才对得上（球是照配置一次性算出来的）
      if (rebuildOrb) import('./launcher.js').then(m => m.refreshOrb()).catch(() => {});
    });
  };
  bindUiNum('hl-orb-size', 'orbSize', 28, 96, true);
  bindUiNum('hl-orb-opacity', 'orbOpacity', 20, 100, true);

  /**
   * 悬浮球自检（v0.9.103）。
   * 「开关是开的、磁盘也是 true、界面就是没有球」这种事，光看配置和 DOM 都判不出来 ——
   * 必须拿运行时的几何 + 遮挡关系。这个按钮就是那把手电筒。
   */
  root.querySelector('#hl-orb-probe')?.addEventListener('click', async () => {
    const box = root.querySelector('#hl-orb-diag');
    const say = (text, bad = false) => {
      if (!box) return;
      box.textContent = text;
      box.style.color = bad ? '#ff9b8a' : '#8ee6a8';
    };
    try {
      const m = await import('./launcher.js');
      const r = m.probeOrb();
      if (!r.ok) {
        say(r.reason === 'switch-off'
          ? '❌ 配置里 ui.orb = false（开关是关的）—— 先把「屏幕边缘悬浮球」勾上。'
          : '❌ 开关是开的，但球没有被建出来。这是插件 bug，请把这句话发我。', true);
        return;
      }
      const at = `(${r.rect.x}, ${r.rect.y}) ${r.rect.w}×${r.rect.h}`;
      if (r.rescued) {
        say(`⚠️ 球原来在屏幕外（保存的坐标失效），已拉回右侧中间 ${at} —— 正在闪 6 秒。`, true);
      } else if (r.coveredBy) {
        say(`⚠️ 球在 ${at}，但被 ${r.coveredBy} 盖住了（z=${r.zIndex}）—— 正在闪，看不见就是它压着。`, true);
      } else if (r.display === 'none' || r.visibility === 'hidden' || Number(r.opacity) < 0.05) {
        say(`⚠️ 球在 ${at}，但被隐藏了：display=${r.display} visibility=${r.visibility} opacity=${r.opacity}。`, true);
      } else {
        say(`✅ 球在 ${at} · 不透明度 ${r.opacity} · z=${r.zIndex} · 视口 ${r.viewport.w}×${r.viewport.h}`
          + `${r.created ? ' · 刚重建' : ''} —— 正在闪 6 秒。`);
      }
    } catch (err) {
      say(`❌ 自检失败：${err?.message || err}`, true);
    }
  });

  root.querySelector('#hl-open-window')?.addEventListener('click', () => {
    import('./window.js').then(m => m.openWindow()).catch(err => {
      uiStatus(`打开窗口失败：${err?.message || err}`);
    });
  });

  root.querySelector('#hl-reset-win')?.addEventListener('click', () => {
    import('./window.js').then(m => {
      m.resetWindowSize();
      uiStatus('窗口大小已恢复默认（下次打开生效）');
    }).catch(() => {});
  });

  function setStatus(msg, isErr) {
    const el = root.querySelector('#hl-basic-status');
    if (!el) return;
    el.textContent = msg;
    el.classList.toggle('hl-err', !!isErr);
  }

  refreshStatus();
  function refreshStatus() {
    const parts = [];
    parts.push(isRunning() ? '扫描器运行中' : '扫描器未启动');
    if (inflightCount()) parts.push(`${inflightCount()} 个楼层处理中`);
    parts.push(`当前轮次 ${getRound()}`);
    setStatus(parts.join(' · '));
  }
}

/* ============ 模版页 ============ */

function templateHtml() {
  const cfg = getConfig();
  const names = Object.keys(cfg.templates || {});
  const tpl = getActiveTemplate();
  /** v0.9.96：SD 口径专属开关（K2 不读它们）。 */
  const sdOpts = cfg.sdOptions || {};
  /** v0.9.136：画面强化（只对 JSON Layout 版生效）。 */
  const enh = normalizeMossEnhance(cfg.mossJson);
  /** v0.9.137：剧情演完（纯漫画 · 全覆盖）。 */
  const cover = normalizeMossCover(cfg.mossJson);
  /** v0.9.141：叙述者候选（本卡 + 全局人设里的名字），给输入框做 datalist 提示。 */
  let CARD_CHARS = [];
  try { CARD_CHARS = (listCast() || []).map((x) => String(x?.name || '')).filter(Boolean); } catch { CARD_CHARS = []; }

  return `
<div class="hl-section">
  <div class="hl-section-title">模版</div>
  <div class="hl-inline">
    <select id="hl-tpl-select" class="hl-input">
      ${names.map(n => `<option value="${escapeHtml(n)}" ${n === cfg.activeTemplate ? 'selected' : ''}>${escapeHtml(n)}</option>`).join('')}
    </select>
    <button class="hl-btn hl-ghost" id="hl-tpl-new">新建</button>
    <button class="hl-btn hl-ghost" id="hl-tpl-rename" title="改当前模版的名字（内容不变）">重命名</button>
    <button class="hl-btn hl-ghost" id="hl-tpl-del">删除</button>
  </div>
  <div class="hl-hint">模版分四层：职责 / 一致性规范 / 输出协议 / 破限。改「一致性规范」不影响输出协议，安全。</div>
  <div class="hl-field" style="margin-top:6px;">
    <label class="hl-label">引擎口径（决定走哪条组装路径，顺带决定中文进不进画面词）</label>
    <select id="hl-tpl-engine" class="hl-input">
      <option value="sd">SD / 纯 TAG — 单串 tag 拼接，字段里的中文自动剥除</option>
      <option value="k2">K2 / 自然语 — 按角色分段拼装，字段里的中文原样放行</option>
      <option value="moss">MOSS / 自然语 + Tag — tag 即整段（多格漫画 / 单图剧情，注入英文人物段 + 中文台词）</option>
    </select>
    <div class="hl-hint">
      它不只是「清洗口径」，而是决定插件<b>怎么拼提示词</b>：<br>
      · <b>K2 / 自然语</b> → 三明治（人物段 / 场景段 / 收尾段分段拼）。吃自然语的模型用它（K2、ZIT，以及 TAG+自然语都能吃的 ANIMA）。<br>
      · <b>SD / 纯 TAG</b> → 单串 tag 顺序拼接。只认 danbooru tag 的模型用它。<br>
      · <b>MOSS / 自然语 + Tag</b> → <b>tag 就是最终整段提示词</b>，插件只做两件事：
      在<b>版面声明之后、第一格之前</b>插入<b>英文人物段</b>（按角色档案逐字生成，所以人物不会漂），
      并把整段<b>按段落排开</b>（方便你逐段核对）。它<b>不插写实锚定块</b>、也不读 SD 的人数词与 BREAK。<br>
      想让 K2 口径输出纯 tag：去「生图后端」关掉 <b>🌐 中文描述</b>（nl），不必改这里。
    </div>
  </div>

  <div class="hl-field" id="hl-tpl-output-wrap" style="margin-top:10px;display:none;">
    <label class="hl-label">输出格式（引擎选 MOSS 时才出现）</label>
    <select id="hl-tpl-output" class="hl-input">
      <option value="text">纯 prompt — 一整段英文提示词（简单场景 / 单人，最稳）</option>
      <option value="json">JSON · 单图 — 每人一项、不写坐标（多人同框最稳，推荐）</option>
      <option value="layout">JSON Layout — 坐标分格（多格漫画页）</option>
    </select>
    <div class="hl-hint">
      两种格式<b>共用同一套内容规范</b>（分镜 / 服装 / 台词 / 边界），区别只在「怎么把画面交给模型」：<br>
      · <b>纯 prompt</b> → 一段英文提示词，人物外貌由插件在格前插入。<b>简单画面用它</b>。<br>
      · <b>JSON Layout</b> → 官方支持的结构化输入：每格一个 <code>object</code>（带坐标框）、
      每个角色一个 <code>character</code>（caption 自带外貌）、台词一个 <code>text</code>。
      坐标把「谁在哪一格」钉死，所以<b>多人同框时人是不会串的</b>。<b>复杂画面用它</b>。<br>
      ⚠️ 切到 JSON Layout 后，<b>务必同时把「一致性规范 / 输出协议」换成 Layout 版正文</b>
      （出厂模版「MOSS(多格漫画)_JSON版」已经是了）。只改下拉不换正文，模型会按纯 prompt 的规则写、你拿到的是坏 JSON。
    </div>
  </div>

  <div class="hl-field" id="hl-moss-opts" style="margin-top:10px;display:none;">
    <label class="hl-label">MOSS 出图形态（仅 MOSS 口径生效）</label>
    <select id="hl-moss-mode" class="hl-input">
      <option value="auto">自动 — 按正文自己判断（有连续瞬间就拆格）</option>
      <option value="multi">多格漫画 — 每张都拆格</option>
      <option value="single">单图剧情 — 每张只画一个瞬间</option>
    </select>
    <label class="hl-label" style="margin-top:8px;">多格排版（形态为「单图」时不生效）</label>
    <select id="hl-moss-layout" class="hl-input">
      <option value="random">🎲 随机 — 每张换一种（避免整本一个版式）</option>
      <option value="auto">自动 — 交给模型自己排（实测会均分成整齐网格）</option>
      ${MOSS_LAYOUTS.map((l) => `<option value="${l.key}">固定 · ${escapeHtml(l.name)}</option>`).join('')}
    </select>
    <div class="hl-hint">
      为什么要有这个：官方做法实测 <b>不写格子类型，模型不会随机发挥，它会均分</b>（四格 = 2×2 整齐网格）——
      所以「不指定」等于「每张都同一个版式」。<br>
      · <b>随机</b>：每出一张换一种排版，剧情漫画才不会整本一个样。<br>
      · <b>固定</b>：想要统一版式（或某个版式稳定好用）就钉死它。<br>
      台词与气泡不在这里控制 —— 正文有人说话时，插件要求模型把<b>原话</b>写进气泡（中文、≤12 字）。
    </div>
    <label class="hl-label" style="margin-top:8px;">剧情模式（画面尺度）</label>
    <select id="hl-moss-nsfw" class="hl-input">
      <option value="auto">自动 — 沿用「成人画面优先」开关（默认，与旧版一致）</option>
      <option value="sfw">仅 SFW — 服装完整、不画性行为（只画到临界之前）</option>
      <option value="nsfw">成人写实 — 按成年人间的情节画，器官与动作写实</option>
    </select>
    <div class="hl-hint">
      为什么要有这个：官方模版只有 <b>SFW 语境</b>，而插件此前只有一个「往成人方向加力」的开关 ——
      轮到日常剧情时模型无处可退，就会自己往成人方向补（SFW 楼也画出裸露，和正文对不上）。<br>
      · <b>自动</b>：行为与旧版完全一致（看「成人画面优先」那个开关）。<br>
      · <b>仅 SFW</b>：即使「成人画面优先」开着，也<b>不注入</b>成人写法，改为注入 SFW 尺度约束。<br>
      · <b>成人写实</b>：不看那个开关，强制注入成人写法。<br>
      两档互斥 —— 同一份提示词里绝不会出现两套相反的尺度规则。
    </div>
  </div>

  <div class="hl-field" id="hl-mossjson-opts" style="margin-top:10px;display:none;">
    <label class="hl-label">JSON Layout 出图形态（只对 JSON 版生效 · 与纯 prompt 版各自独立）</label>
    <select id="hl-mj-mode" class="hl-input">
      <option value="multi">多格漫画 — 每张都拆格（JSON 版的主场）</option>
      <option value="auto">自动 — 按正文自己判断（有连续瞬间就拆格）</option>
      <option value="single">单图剧情 — 每张只画一个瞬间</option>
    </select>
    <label class="hl-label" style="margin-top:8px;">全局词库（前缀 / 后缀）在 Layout 下往哪放</label>
    <select id="hl-mj-gword" class="hl-input">
      <option value="caption">并进 summary.caption —— 接在画风句前后（默认）</option>
      <option value="off">不注入 —— 前缀是 SD 式 tag 串时选这个</option>
    </select>
    <div class="hl-hint">
      全局负面提示词<b>不受这里影响</b>，照常送后端。<br>
      为什么不塞进 items：那是<b>坐标框</b>，往里加词等于给某一格单独加权重。<br>
      前缀若是 <code>masterpiece, best quality, score_9</code> 这类 tag 串，并进自然语 caption 会被稀释 → 选「不注入」。
    </div>
    <label class="hl-label" style="margin-top:8px;">剧情模式（只对 JSON 版 · 与纯 prompt 版各自独立）</label>
    <select id="hl-mj-nsfw" class="hl-input">
      <option value="auto">自动 — 沿用「成人画面优先」开关（默认，与旧版一致）</option>
      <option value="sfw">仅 SFW — 服装完整、不画性行为（只画到临界之前）</option>
      <option value="nsfw">成人写实 — 按成年人间的情节画，器官与动作写实</option>
    </select>
    <div class="hl-hint">
      这一项和纯 prompt 版<b>各存一份</b>：在这里切成 SFW，不会影响纯 prompt 版。<br>
      Layout 版额外约束：character 项只写「穿着什么 + 在做什么」，<b>不写脱到哪</b>；特写格不建 character 项。
    </div>

    <div class="hl-subtitle">叙事目标（只对 JSON 版生效 · 多格模式）</div>
    <div class="hl-hint">
      默认是<b>「精选」</b>：从这一楼挑几个最有画面价值的瞬间（一页 3 格常只画 1 步剧情）。<br>
      打开下面这项换成<b>「拆分」</b>：按时间顺序把这一楼拆成连续的步骤，一格一步全部画出来。
    </div>
    <label class="hl-check">
      <input id="hl-mj-cover" type="checkbox" ${cover.on ? 'checked' : ''}>
      <span>剧情演完（纯漫画 · 不挑不跳）</span>
      <div class="hl-hint">
        每一格都必须有人（禁空镜），<b>格序＝时间序</b>；一句台词都不省，原话超过 12 字自动拆成 2~3 个气泡。<br>
        ⚠️ 张数会明显变多 —— 实测 1689 字的一段剧情要 <b>9 张 × 3 格（27 格）</b>才演得完；
        同一段在「精选」下只出 3 张 6 格、其中 3 格是空镜。
      </div>
    </label>
    <label class="hl-label">演完时单楼最多几张（2~12）</label>
    <input id="hl-mj-covermax" class="hl-input" type="number" min="2" max="12" value="${cover.max}">
    <div class="hl-hint">
      这个数<b>只在这个开关打开时生效</b>；关着的时候仍按上面「单楼最大图片数」走。<br>
      张数直接等于 API 成本 —— 短剧情调小，长剧情调大。超过这个数时模型会合并"同一秒的连续动作"，但台词一句不省。
    </div>

    <div id="hl-mj-coverbox" style="display:none;">
      <label class="hl-label" style="margin-top:8px;">漫画页版式（预置分镜库 · 只在「剧情演完」下生效）</label>
      <select id="hl-mj-mangalayout" class="hl-input">
        <option value="random">🎲 自动配版 — 按这一页的情节条数查表（推荐）</option>
        ${MANGA_LAYOUTS.map((l) => `<option value="${l.id}">固定 · ${l.panels} 格 · ${escapeHtml(l.note)}</option>`).join('')}
      </select>
      <div class="hl-hint">
        <b>这是「坐标交给谁」的分水岭</b>：选了这里，格子在哪、多大、气泡放哪，全部由插件按版式算成像素框，
        模型只回答「这一格画什么、谁说了哪句」。<br>
        · <b>自动配版</b>：模型给出这一页几条情节，插件按 2~6 格档位查表挑一个（每页可以不同，避免整本一个版式）。<br>
        · <b>固定</b>：整本都用同一个版式（通高人物那几款最适合单人跟拍）。<br>
        ⚠️ 只有这里的版式带「不等高节奏 + 跨格人物 + 每格独立背景层」；上面那个旧排版是让模型自己数格子的。
      </div>

      <!--
        ★★★ v0.9.155：每页格数的随机范围（用户 2026-10-29 要求）。
        留空 = 不限制；两个都填 = 每楼在 [最小, 最大] 里抽一个格数，整楼统一。
        格数变少时页数自动变多（pages = ceil(段数 / 每页格数)），总格数照样覆盖全部情节点。
      -->
      <label class="hl-label" style="margin-top:8px;">每页格数范围（留空 = 不限制 · 只在版式为「自动配版」时生效）</label>
      <div class="hl-inline">
        <input id="hl-mj-panelmin" class="hl-input" type="number" min="2" max="6" step="1"
               placeholder="最小" value="${cover.panelMin ? cover.panelMin : ''}" style="width:92px;">
        <span style="opacity:.55;">~</span>
        <input id="hl-mj-panelmax" class="hl-input" type="number" min="2" max="6" step="1"
               placeholder="最大" value="${cover.panelMax ? cover.panelMax : ''}" style="width:92px;">
      </div>
      <div class="hl-hint">
        例：填 <b>3</b> ~ <b>4</b> ⇒ 每楼在 3 格 / 4 格之间随机挑一种，<b>整楼统一</b>（不会这页 3 格下页 4 格）。<br>
        <b>格数变少不丢剧情</b>：页数会自动变多，总格数照样覆盖全部情节点 —— 代价只是出图张数变多。<br>
        ⚠️ 上面选了<b>固定版式</b>时不生效（那种情况格数以版式为准，否则指令要的格数和版式对不上）。
      </div>

      <!--
        ★★★ v0.9.141 叙述者：正文第一人称「我」在角色档案里是谁。
        2026-10-28 第一楼实测：模型 10/10 页把 narrator 答成「我」（正文里男主从没被点名），
        于是 9 页主角没有外貌 → 「同一个人每页长得都不一样」。这一格只能人来填。
      -->
      <label class="hl-label" style="margin-top:8px;">叙述者是谁（正文第一人称「我」= 角色档案里的谁）</label>
      <input id="hl-mj-narrator" class="hl-input" type="text" list="hl-mj-narrator-list"
             placeholder="留空 = 不注入（正文不是第一人称就留空）" value="${escapeHtml(String(cfg.mossJson?.narrator || ''))}">
      <datalist id="hl-mj-narrator-list">
        ${(CARD_CHARS || []).map((n) => `<option value="${escapeHtml(n)}"></option>`).join('')}
      </datalist>
      <div class="hl-hint">
        正文里写「我」的那一格，插件要按名字去角色档案里取脸和衣服。名字对不上就什么都不注入。<br>
        ⚠️ <b>不能让模型自己猜</b>：正文常常从头到尾不点主角的名字，它只能答「我」——
        实测 10 页全这么答，等于没答。填了这里，<code>cast</code> 里写「我」也会自动换成这个人。
      </div>
    </div>

    <!--
      ★★★ v0.9.158：单图「文字台词」总开关。
      摆在「画面强化」之前，因为它是画不画字的总闸，比强化项的优先级高。
      双层生效：指令层少写一段活 + <code>singleJsonPrompt</code> 里把 text 项直接丢掉（真正生效的那层）。
      ⚠️ 这段 HTML 在 JS 模板字符串里 —— 注释里**绝对不许出现反引号**，
         否则会把模板串提前闭合（本轮就踩了：整块面板 import 直接 SyntaxError）。
    -->
    <div id="hl-mj-textbox" style="margin-top:10px;display:none;">
      <label class="hl-check">
        <input id="hl-mj-textbubble" type="checkbox" ${cfg.mossJson?.textBubble === false ? '' : 'checked'}>
        <span>输出文字台词（对白气泡）</span>
        <div class="hl-hint">
          关掉后这张图里<b>一个字的框都不出现</b> —— 对白与拟声词都不画，人物照常画。
          只在<b>单图</b>口径下有效（多格漫画页靠气泡交代剧情，不给这个开关）。
          <br>⚠️ 汉字超过约 <b>10 个字</b>模型就开始画错：实测会<b>稳定丢掉「不」这类单字虚词</b>
          （<code>是不是</code>→<code>是是</code>），笔画多的字随机错（<code>坏</code>→<code>块</code>/<code>坎</code>）。
          所以长原话由插件<b>自动拆成多个气泡</b>，一个字都不删。
        </div>
      </label>
    </div>

    <div class="hl-subtitle">画面强化（只对 JSON 版生效 · 每一项都能单独关掉）</div>
    <div class="hl-hint">
      这几项<b>都是真实出图对照出来的</b>（2026-10-23，13 张同 seed 实验），不是凭感觉加的。
      出问题时先关对应的那一项，不用回滚插件。
    </div>
    <label class="hl-check">
      <input id="hl-enh-slant" type="checkbox" ${enh.slant ? 'checked' : ''}>
      <span>斜切分格</span>
      <div class="hl-hint">格线走斜线、留斜向白缝，冲击力更强。<b>坐标仍是矩形</b> —— 模型照描述画斜线，不改版式几何。默认关。</div>
    </label>
    <label class="hl-label" style="margin-top:10px;">拟声词（环境音 / 动作力度）</label>
    <select id="hl-enh-sfx" class="hl-input">
      <option value="ja" ${enh.sfx === 'ja' ? 'selected' : ''}>日文假名（ドキッ / ドサッ）— 漫画惯例，实测能画</option>
      <option value="zh" ${enh.sfx === 'zh' ? 'selected' : ''}>中文（咚 / 啪 / 吱）</option>
      <option value="off" ${enh.sfx === 'off' ? 'selected' : ''}>关闭 — 只允许对白气泡</option>
    </select>
    <div class="hl-hint">
      只在原文真有声音或动作落点时才加（脚步 / 床架作响 / 门 / 水声 / 猛地一颤）；安静的对视不加。
      一页最多一个，已经有对白气泡的格子不加。
    </div>
    <label class="hl-check" style="margin-top:10px;">
      <input id="hl-enh-pose" type="checkbox" ${enh.pose ? 'checked' : ''}>
      <span>体位骨架强化</span>
      <div class="hl-hint">只给 <b>8 个几何反直觉的体位</b>（腿架肩 / 折刀 / 蝴蝶 / 拱背 / 靠墙托举 / 考拉 / 肩倒立 / 反向桥）
        在骨架后面补一句「<b>头脸朝哪 + 谁承重 + 进入方向</b>」。
        <br>依据：腿架肩式不补＝头身倒置折成一团；而汤匙式、扶手椅式本来就画得对，补了没有收益 ——
        所以不做法「23 式全量重写」。</div>
    </label>
  </div>

  <div class="hl-field" id="hl-sd-opts" style="margin-top:10px;">
    <label class="hl-label">SD 输出结构（仅 SD / 纯 TAG 口径生效，K2 不读）</label>
    <label class="hl-check">
      <input id="hl-sd-count" type="checkbox" ${sdOpts.countTags !== false ? 'checked' : ''}>
      <span>输出人数词（1girl / 1boy）</span>
      <div class="hl-hint">
        按出场角色写在每个角色段首；两人以上时首段再补一句总览（<code>1boy, 1girl</code>）。<br>
        <b>不写就没有人数声明</b> —— danbooru 口径不认「一个男人」这种自然语，只认 tag。
      </div>
    </label>
    <label class="hl-check">
      <input id="hl-sd-break" type="checkbox" ${sdOpts.breakSeparator ? 'checked' : ''}>
      <span>段间插入 BREAK</span>
      <div class="hl-hint">
        ⚠ 只有 <b>ComfyUI-Easy-Use / Impact-Pack</b> 的编码节点认它；
        原生 <code>CLIPTextEncode</code> 会把它当普通单词（实测切成 <code>break&lt;/w&gt;</code>）。
      </div>
    </label>
    <label class="hl-check">
      <input id="hl-sd-nodyn" type="checkbox" ${sdOpts.excludeDynamic !== false ? 'checked' : ''}>
      <span>排除动态字段（状态 / 情绪 / 动作 / 表情）</span>
      <div class="hl-hint">
        关掉 → 这些字段会被当成<b>跨轮次永不改变的静态锚点</b>，
        上一楼的动作会钉进之后每一张图（实测病例：《雾津市播种计划！》的 <code>状态</code> 字段）。
      </div>
    </label>
  </div>
</div>

<div class="hl-section">
  <div class="hl-section-title">① 系统职责</div>
  <textarea id="hl-tpl-system" class="hl-textarea" rows="7"></textarea>
  <div class="hl-hint">定义模型是谁、干什么、纪律是什么。</div>
</div>

<div class="hl-section">
  <div class="hl-section-title">② 一致性规范</div>
  <textarea id="hl-tpl-spec" class="hl-textarea" rows="16"></textarea>
  <div class="hl-hint">静态锚点、服装状态位、画面写法。换模型口径（Krea2 / danbooru）就改这里。</div>
</div>

<div class="hl-section">
  <div class="hl-section-title">③ 输出协议（不建议删）</div>
  <textarea id="hl-tpl-protocol" class="hl-textarea" rows="12"></textarea>
  <div class="hl-hint">删掉它模型就不会输出合法 JSON，会导致零张图。</div>
</div>

<div class="hl-section">
  <div class="hl-section-title">④ 破限 / 附加（可空）</div>
  <textarea id="hl-tpl-jailbreak" class="hl-textarea" rows="6"></textarea>
</div>

<div class="hl-actions">
  <button class="hl-btn" id="hl-tpl-save">保存模版</button>
  <button class="hl-btn hl-ghost" id="hl-tpl-reload">放弃改动</button>
</div>
<div class="hl-status" id="hl-tpl-status"></div>`;
}

function bindTemplate(root) {
  const cfg = getConfig();
  const sel = root.querySelector('#hl-tpl-select');
  const taSystem = root.querySelector('#hl-tpl-system');
  const taSpec = root.querySelector('#hl-tpl-spec');
  const taProtocol = root.querySelector('#hl-tpl-protocol');
  const taJail = root.querySelector('#hl-tpl-jailbreak');
  const selEngine = root.querySelector('#hl-tpl-engine');
  const selOutput = root.querySelector('#hl-tpl-output');
  const outputWrap = root.querySelector('#hl-tpl-output-wrap');
  /**
   * v0.9.96：SD 输出结构开关只在「SD / 纯 TAG」口径下显示。
   * 用 style.display 而不是 hidden 属性 —— `.hl-field` 是 flex，hidden 会被 display:flex 盖掉。
   */
  const sdOptsBox = root.querySelector('#hl-sd-opts');
  /**
   * ★ v0.9.117：MOSS 口径专属块（出图形态 / 多格排版）。
   *   和 SD 开关同一套显隐规则：用 style.display —— `.hl-field` 是 flex，hidden 会被盖掉。
   */
  const mossBox = root.querySelector('#hl-moss-opts');
  const selMossMode = root.querySelector('#hl-moss-mode');
  const selMossLayout = root.querySelector('#hl-moss-layout');
  const selMossNsfw = root.querySelector('#hl-moss-nsfw');
  /**
   * ★★★ v0.9.127：纯 prompt 版的三个下拉**必须走同一个保存函数**。
   *   旧写法每个 handler 都 `c.moss = { ...normalizeMossOptions(c.moss), xxx }` ——
   *   而 `normalizeMossOptions` 只返回 `{ mode, layout }`，于是每加一个字段
   *   （`gword`、现在的 `nsfw`）就会被别的下拉的 change 事件悄悄抹掉。
   *   ⇒ 保存只此一处，新字段先归一化再合并，任何下拉都不会丢别人的值。
   */
  const saveMoss = (patch, msg) => {
    const c = getConfig();
    c.moss = {
      ...normalizeMossOptions(c.moss),
      nsfw: normalizeMossNsfw(c.moss?.nsfw),
      ...patch,
    };
    saveSettings();
    if (msg) setStatus(msg);
  };
  /** 形态选「单图剧情」时排版没有意义 —— 置灰但**不藏**（用户要看得见它存在） */
  const syncMossModeGuards = () => {
    if (!selMossLayout) return;
    const single = selMossMode?.value === 'single';
    selMossLayout.disabled = single;
    selMossLayout.style.opacity = single ? '0.5' : '';
  };
  /**
   * ★ v0.9.122：**JSON Layout 版专属**设置块。
   *   它跟 `#hl-moss-opts`（纯 prompt 版）**互斥显示** ——
   *   两个版本是并存的两种输出格式（用户原话：「一个纯 prompt，一个 JSON。
   *   简单的用纯 prompt，复杂就能切 JSON 生图」），配置也各存一份
   *   （`cfg.mossJson` vs `cfg.moss`），切版本互不影响。
   */
  const mossJsonBox = root.querySelector('#hl-mossjson-opts');
  const selMjMode = root.querySelector('#hl-mj-mode');
  const selMjGword = root.querySelector('#hl-mj-gword');
  const selMjNsfw = root.querySelector('#hl-mj-nsfw');
  /**
   * v0.9.140：版式库选择器 + 「剧情演完」那两个控件。
   * ★ 提前 query 是因为 `syncMjGuards()` 要读 `chkMjCover.checked` 来显隐版式块 ——
   *   而 `syncMjGuards()` 在下面 `loadInto()` 里就会被调用（早于 1058 行那批声明），
   *   常量声明有 TDZ，晚声明会在第一次渲染时抛 ReferenceError。
   */
  const selMjMangaLayout = root.querySelector('#hl-mj-mangalayout');
  const mjCoverBox = root.querySelector('#hl-mj-coverbox');
  const chkMjCover = root.querySelector('#hl-mj-cover');
  const numMjCoverMax = root.querySelector('#hl-mj-covermax');
  const syncMjGuards = () => {
    /**
     * ★ 版式库只对「剧情演完 + 多格」有意义：
     *   · 精选模式仍走旧的（模型自己算坐标）路径，版式库不参与；
     *   · 切到「单图」时一页只有 1 个画面，没有版式可分。
     *   两个条件任一不满足就藏起来 —— 留着可点会让人以为改了有作用。
     */
    if (mjCoverBox) {
      const usable = !!chkMjCover?.checked && selMjMode?.value !== 'single';
      mjCoverBox.style.display = usable ? '' : 'none';
    }
  };
  const syncSdOptsVisibility = () => {
    const ev = selEngine?.value;
    const isJsonOut = selOutput?.value !== 'text';
    // v0.9.117：K2 与 MOSS 都不读 SD 的人数词 / BREAK 开关 → 一并隐藏
    if (sdOptsBox) sdOptsBox.style.display = (ev === 'k2' || ev === 'moss') ? 'none' : '';
    // 纯 prompt 版块：MOSS 且**不是** JSON 口径时才显示
    if (mossBox) mossBox.style.display = (ev === 'moss' && !isJsonOut) ? '' : 'none';
    // JSON 版块：MOSS 且选了 JSON（单图 json / 多格 layout）才显示
    if (mossJsonBox) mossJsonBox.style.display = (ev === 'moss' && isJsonOut) ? '' : 'none';
    // ★ v0.9.157：**单图 JSON 没有「格」** —— 形态 / 剧情演完 / 格数这几项对它无效。
    //   这里只禁用、不隐藏：隐藏要重排 DOM 结构（这些 label/input 是平铺的，没有包裹容器），
    //   禁用至少能让用户看见「这几项为什么没用」，也不会把有效项一起藏掉。
    const singleJson = ev === 'moss' && selOutput?.value === 'json';
    if (selMjMode) {
      selMjMode.disabled = singleJson;
      if (singleJson) selMjMode.value = 'single';
    }
    if (chkMjCover) chkMjCover.disabled = singleJson;
    if (numMjCoverMax) numMjCoverMax.disabled = singleJson;
    /**
     * ★ v0.9.158：「文字台词」开关**只属于单图** —— 多格漫画页靠气泡交代剧情，
     *   关掉它等于整页没人说话。这里用「隐藏」而不是「禁用」：
     *   它整块有独立包裹容器（`hl-mj-textbox`），藏起来不会把别的有效项一起带走。
     */
    const tbBox = root.querySelector('#hl-mj-textbox');
    if (tbBox) tbBox.style.display = singleJson ? '' : 'none';
    // 输出格式只对 MOSS 口径有意义（SD 是纯 tag、K2 是三明治，都没有 Layout 通道）
    if (outputWrap) outputWrap.style.display = ev === 'moss' ? '' : 'none';
    syncMossModeGuards();
    syncMjGuards();
  };

  function loadInto(name) {
    const t = cfg.templates[name] || getActiveTemplate();
    taSystem.value = t.system || '';
    taSpec.value = t.spec || '';
    taProtocol.value = t.protocol || '';
    taJail.value = t.jailbreak || '';
    if (selEngine) selEngine.value = t.engine === 'k2' || t.engine === 'moss' ? t.engine : 'sd';
    // v0.9.121：输出格式（text / json / layout）—— 老模版没有这个字段，默认纯 prompt
    if (selOutput) selOutput.value = t.output === 'json' ? 'json' : (t.output === 'layout' ? 'layout' : 'text');
    // MOSS 形态 / 排版是全局口径配置（不跟随单张模版），但显示要跟着载入刷新
    const mo = normalizeMossOptions(getConfig().moss);
    if (selMossMode) selMossMode.value = mo.mode;
    if (selMossNsfw) selMossNsfw.value = normalizeMossNsfw(getConfig().moss?.nsfw);
    if (selMossLayout) {
      selMossLayout.value = mo.layout;
      // 配置里存着某个已下线的排版 key 时，select 会变空 —— 回落到随机，别让用户看到空白框
      if (!selMossLayout.value) selMossLayout.value = 'random';
    }
    // Layout 版自己那一份
    const mj = normalizeMossOptions(getConfig().mossJson);
    if (selMjMode) selMjMode.value = mj.mode;
    if (selMjGword) selMjGword.value = getConfig().mossJson?.gword === 'off' ? 'off' : 'caption';
    if (selMjNsfw) selMjNsfw.value = normalizeMossNsfw(getConfig().mossJson?.nsfw);
    if (selMjMangaLayout) {
      const ml = getConfig().mossJson?.mangaLayout;
      selMjMangaLayout.value = (typeof ml === 'string' && ml) ? ml : 'random';
      // 存着已下线 / 手改错的 id 时 select 会空 → 回落自动配版，别留白框
      if (!selMjMangaLayout.value) selMjMangaLayout.value = 'random';
    }
    syncSdOptsVisibility();
  }

  loadInto(cfg.activeTemplate);

  selEngine?.addEventListener('change', syncSdOptsVisibility);
  // v0.9.122：切输出格式（text ⇄ layout）时，两个形态块互斥显隐
  selOutput?.addEventListener('change', syncSdOptsVisibility);

  /** SD 输出结构开关：改了就落盘（这些是全局口径配置，不跟随单张模版）。 */
  const bindSdOpt = (selId, key, label) => {
    const el = root.querySelector(selId);
    if (!el) return;
    el.addEventListener('change', () => {
      const c = getConfig();
      c.sdOptions = { ...(c.sdOptions || {}), [key]: !!el.checked };
      saveSettings();
      setStatus(`${label}：已${el.checked ? '开启' : '关闭'}`);
    });
  };
  bindSdOpt('#hl-sd-count', 'countTags', '输出人数词');
  bindSdOpt('#hl-sd-break', 'breakSeparator', '段间 BREAK');
  bindSdOpt('#hl-sd-nodyn', 'excludeDynamic', '排除动态字段');

  /**
   * MOSS 出图形态 / 排版：改了就落盘（同 sdOptions，是全局口径配置）。
   * ★ 这两个值由 `buildMossDirective()` 在拼分析提示词时读取 ——
   *   「设置里选了什么」与「模型收到什么」永远是同一份数据。
   */
  const MOSS_MODE_LABEL = { auto: '自动（按正文判断）', multi: '多格漫画（每张都拆格）', single: '单图剧情（不分格）' };
  selMossMode?.addEventListener('change', () => {
    saveMoss({ mode: selMossMode.value },
      `MOSS 出图形态：${MOSS_MODE_LABEL[selMossMode.value] || selMossMode.value}`);
    syncMossModeGuards();
  });
  selMossLayout?.addEventListener('change', () => {
    const picked = MOSS_LAYOUTS.find((l) => l.key === selMossLayout.value);
    saveMoss({ layout: selMossLayout.value },
      `MOSS 多格排版：${picked ? `固定「${picked.name}」` : selMossLayout.value === 'random' ? '随机（每张换一种）' : '自动（模型自己排，会均分）'}`);
  });
  /** v0.9.127：剧情模式（纯 prompt 版）。只写 `cfg.moss.nsfw`，绝不碰 JSON 版那份。 */
  const NSFW_LABEL = { auto: '自动（跟随「成人画面优先」）', sfw: '仅 SFW', nsfw: '成人写实' };
  selMossNsfw?.addEventListener('change', () => {
    saveMoss({ nsfw: normalizeMossNsfw(selMossNsfw.value) },
      `MOSS 剧情模式：${NSFW_LABEL[selMossNsfw.value] || selMossNsfw.value}`);
  });

  /**
   * ★ v0.9.122：JSON Layout 版的三项设置 —— 一律写 `cfg.mossJson`。
   *   绝不能写回 `cfg.moss`：那是纯 prompt 版的，写串了就是用户最怕的
   *   「切回纯 prompt 发现形态/排版全变了」。
   */
  const saveMj = (patch, msg) => {
    const c = getConfig();
    const cur = {
      mode: ['auto', 'multi', 'single'].includes(c.mossJson?.mode) ? c.mossJson.mode : 'multi',
      layout: typeof c.mossJson?.layout === 'string' && c.mossJson.layout ? c.mossJson.layout : 'random',
      gword: c.mossJson?.gword === 'off' ? 'off' : 'caption',
      nsfw: normalizeMossNsfw(c.mossJson?.nsfw),
      /**
       * ★★★ v0.9.136：`enh` 必须列进这个白名单。
       *   这个函数是「白名单重建再覆盖」—— 不在 `cur` 里的字段会被整段丢掉。
       *   漏了它，用户改一次排版 / 剧情模式，画面强化的六项设置就全部被清空，
       *   而且不会有任何报错（面板一刷新就是默认值）。
       */
      enh: normalizeMossEnhance(c.mossJson),
      /**
       * ★★★ v0.9.137：`coverMode` / `coverMax` 同样必须列进白名单。
       *   同一个坑（v0.9.136 的 `enh` 就是这样被吞的）：不在 `cur` 里，
       *   用户改一次排版 → 剧情演完开关被静默恢复成关，且不会有任何提示。
       */
      coverMode: normalizeMossCover(c.mossJson).on,
      coverMax: normalizeMossCover(c.mossJson).max,
      /**
       * ★★★ v0.9.155：每页格数的随机范围，同样必须列进白名单（第五次踩同一个坑）。
       *   漏了它 → 用户填完「3~4 格」，只要再动一下别的设置就被静默清空，且无任何报错。
       */
      panelMin: normalizeMossCover(c.mossJson).panelMin,
      panelMax: normalizeMossCover(c.mossJson).panelMax,
      /**
       * ★★★ v0.9.140：`mangaLayout` 同样必须在白名单里（同一个坑第三次了）。
       *   漏了它 → 用户改一次剧情模式，选好的版式就被静默改回随机。
       */
      mangaLayout: typeof c.mossJson?.mangaLayout === 'string' && c.mossJson.mangaLayout
        ? c.mossJson.mangaLayout : 'random',
      /**
       * ★★★ v0.9.141：`narrator` 同样必须列进白名单（同一个坑第四次）。
       *   漏了它 → 用户填好「我=夜斗」，再去改一次版式，叙述者就被静默清空，
       *   表现是「主角的脸又变回陌生人了」而界面上看不出任何异常。
       */
      narrator: typeof c.mossJson?.narrator === 'string' ? c.mossJson.narrator : '',
      /**
       * ★★★ v0.9.158：`textBubble` 同样必须列进白名单（同一个坑第六次）。
       *   漏了它 → 用户关掉「文字台词」，只要再动一下排版/剧情模式，就被静默恢复成开，
       *   表现是「明明关了，图里又有气泡了」，界面上还显示着关闭状态（刷新后才变回来）。
       *   ★ 默认 **true**：只有明确的 `false` 才算关（老配置没这个字段 = 要台词）。
       */
      textBubble: c.mossJson?.textBubble === false ? false : true,
    };
    c.mossJson = { ...cur, ...patch };
    saveSettings();
    if (msg) setStatus(msg);
  };
  selMjMode?.addEventListener('change', () => {
    saveMj({ mode: selMjMode.value }, `JSON 版出图形态：${MOSS_MODE_LABEL[selMjMode.value] || selMjMode.value}`);
    syncMjGuards();
  });
  selMjGword?.addEventListener('change', () => {
    saveMj({ gword: selMjGword.value === 'off' ? 'off' : 'caption' },
      `JSON 版全局前缀/后缀：${selMjGword.value === 'off' ? '不注入' : '并进 summary.caption'}`);
  });
  /**
   * v0.9.137：叙事目标 —— 精选 / 剧情演完。
   * 两个字段都写 `cfg.mossJson`，并借 `saveMj` 走同一个保存入口。
   * ★ v0.9.140：`chkMjCover` / `numMjCoverMax` 的 query 已上移到 `syncMjGuards` 之前
   *   （那里要先读 checked 才能显隐版式块），这里只用不重声明。
   */
  const saveCover = (patch, msg) => {
    const cur = normalizeMossCover(getConfig().mossJson);
    saveMj({ coverMode: cur.on, coverMax: cur.max, ...patch }, msg);
  };
  selMjMangaLayout?.addEventListener('change', () => {
    const picked = MANGA_LAYOUTS.find((l) => l.id === selMjMangaLayout.value);
    saveMj({ mangaLayout: selMjMangaLayout.value },
      picked ? `漫画页版式：固定「${picked.panels} 格 · ${picked.note}」` : '漫画页版式：自动配版（按情节条数查表）');
  });
  /**
   * ★ v0.9.141：叙述者 —— 正文第一人称「我」在档案里是谁。
   *   `change` 而不是 `input`：每敲一个字就落库会把 settings.json 写爆。
   */
  const inputMjNarrator = root.querySelector('#hl-mj-narrator');
  inputMjNarrator?.addEventListener('change', () => {
    const v = String(inputMjNarrator.value || '').trim();
    inputMjNarrator.value = v;
    saveMj({ narrator: v },
      v ? `叙述者：「我」= ${v}（按他的名字注入外貌与服装）` : '叙述者：未指定（正文写「我」的格子不注入外貌）');
  });
  chkMjCover?.addEventListener('change', () => {
    saveCover({ coverMode: chkMjCover.checked },
      `JSON 版叙事目标：${chkMjCover.checked ? '剧情演完（一格一步 · 禁空镜 · 台词不省）' : '精选最精彩的瞬间'}`);
    // v0.9.140：开关一变，下面「漫画页版式」跟着显隐
    syncMjGuards();
  });
  numMjCoverMax?.addEventListener('change', () => {
    const v = normalizeMossCover({ coverMax: numMjCoverMax.value }).max;
    numMjCoverMax.value = String(v);     // 越界时把输入框拉回合法值，别让用户以为填进去了
    saveCover({ coverMax: v }, `JSON 版剧情演完 · 单楼最多 ${v} 张`);
  });

  /**
   * ★★★ v0.9.155：每页格数范围（留空 = 不限制）。
   *
   * 两个框共用一次保存：只填一个 = 视为不限制（`normalizeMossCover` 会把两端清成 0），
   * 保存后**把输入框拉回归一化结果** —— 否则用户填了 7 会看到一个 7，而实际生效是 6。
   */
  const numMjPanelMin = root.querySelector('#hl-mj-panelmin');
  const numMjPanelMax = root.querySelector('#hl-mj-panelmax');
  const savePanelRange = () => {
    const cur = normalizeMossCover(getConfig().mossJson);
    const next = normalizeMossCover({
      coverMax: cur.max,
      panelMin: numMjPanelMin ? numMjPanelMin.value : cur.panelMin,
      panelMax: numMjPanelMax ? numMjPanelMax.value : cur.panelMax,
    });
    if (numMjPanelMin) numMjPanelMin.value = next.panelMin ? String(next.panelMin) : '';
    if (numMjPanelMax) numMjPanelMax.value = next.panelMax ? String(next.panelMax) : '';
    saveMj({ panelMin: next.panelMin, panelMax: next.panelMax },
      next.panelMin
        ? `JSON 版每页格数：${next.panelMin}~${next.panelMax} 格随机（整楼统一）`
        : 'JSON 版每页格数：不限制（按情节条数与版式库自动定）');
  };
  numMjPanelMin?.addEventListener('change', savePanelRange);
  numMjPanelMax?.addEventListener('change', savePanelRange);

  /** v0.9.127：剧情模式（JSON 版）。同样只写 `cfg.mossJson.nsfw`。 */
  selMjNsfw?.addEventListener('change', () => {
    saveMj({ nsfw: normalizeMossNsfw(selMjNsfw.value) },
      `JSON 版剧情模式：${NSFW_LABEL[selMjNsfw.value] || selMjNsfw.value}`);
  });

  /**
   * v0.9.136：画面强化六项 —— 一律写 `cfg.mossJson.enh`。
   * 走 `saveMj` 是为了复用同一个保存入口（它也负责把 `enh` 保留在白名单里）。
   */
  const saveEnh = (patch, msg) => {
    saveMj({ enh: { ...normalizeMossEnhance(getConfig().mossJson), ...patch } }, msg);
  };
  const enhSlant = root.querySelector('#hl-enh-slant');
  const enhSfx = root.querySelector('#hl-enh-sfx');
  const enhPose = root.querySelector('#hl-enh-pose');
  enhSlant?.addEventListener('change', () => saveEnh({ slant: !!enhSlant.checked },
    `画面强化 · 斜切分格：${enhSlant.checked ? '开' : '关'}`));
  enhPose?.addEventListener('change', () => saveEnh({ pose: !!enhPose.checked },
    `画面强化 · 体位骨架：${enhPose.checked ? '开' : '关'}`));
  enhSfx?.addEventListener('change', () => saveEnh({ sfx: enhSfx.value },
    `画面强化 · 拟声词：${enhSfx.value === 'off' ? '关闭' : enhSfx.value === 'ja' ? '日文假名' : '中文'}`));

  /**
   * ★★★ v0.9.158：单图「文字台词」总开关 —— 写 `cfg.mossJson.textBubble`（不在 `enh` 里）。
   *   走 `saveMj` 是为了复用白名单保存入口（`textBubble` 已列进 `cur`，否则会被静默清空）。
   */
  const enhTextBubble = root.querySelector('#hl-mj-textbubble');
  enhTextBubble?.addEventListener('change', () => saveMj(
    { textBubble: !!enhTextBubble.checked },
    `单图文字台词：${enhTextBubble.checked ? '画（长原话自动拆成多个气泡，不删字）' : '不画（画面里不出现任何文字）'}`,
  ));

  sel?.addEventListener('change', () => {
    cfg.activeTemplate = sel.value;
    saveSettings();
    loadInto(sel.value);
    setStatus(`已切换到「${sel.value}」`);
  });

  root.querySelector('#hl-tpl-new')?.addEventListener('click', () => {
    const name = prompt('新模版名称（会复制当前模版内容）：', `模版${Object.keys(cfg.templates).length + 1}`);
    if (!name) return;
    addTemplate(name);
    reloadPanel(root);
  });

  root.querySelector('#hl-tpl-rename')?.addEventListener('click', () => {
    const oldName = sel.value;
    const name = (prompt(`把模版「${oldName}」改成什么名字：`, oldName) || '').trim();
    if (!name || name === oldName) return;
    if (cfg.templates[name]) { setStatus(`已有同名模版「${name}」`, true); return; }
    // 改名 = 搬内容 + 改条目自带 name + 当前指针跟着走
    cfg.templates[name] = { ...cfg.templates[oldName], name };
    delete cfg.templates[oldName];
    if (cfg.activeTemplate === oldName) cfg.activeTemplate = name;
    saveSettings();
    reloadPanel(root);
    setStatus(`已重命名为「${name}」`);
    info(STAGE.UI, `模版「${oldName}」已重命名为「${name}」`);
  });

  root.querySelector('#hl-tpl-del')?.addEventListener('click', () => {
    const name = sel.value;
    if (Object.keys(cfg.templates).length <= 1) { setStatus('至少保留一套模版', true); return; }
    if (!confirm(`确定删除模版「${name}」？`)) return;
    removeTemplate(name);
    reloadPanel(root);
  });

  root.querySelector('#hl-tpl-save')?.addEventListener('click', () => {
    const name = cfg.activeTemplate;
    if (!cfg.templates[name]) cfg.templates[name] = { name };
    const t = cfg.templates[name];
    t.system = taSystem.value;
    t.spec = taSpec.value;
    t.protocol = taProtocol.value;
    t.jailbreak = taJail.value;
    const ev = selEngine?.value;
    t.engine = ev === 'k2' || ev === 'moss' ? ev : 'sd';
    /**
     * ★★★ v0.9.121：输出格式必须**存进模版**，不能只存全局。
     *   它是「这个模版的正文按哪种格式写的」的属性 —— 换模版就跟着换。
     */
    t.output = selOutput?.value === 'json' ? 'json' : (selOutput?.value === 'layout' ? 'layout' : 'text');
    t.name = name;
    saveSettings();
    const total = (t.system + t.spec + t.protocol + t.jailbreak).length;
    setStatus(`已保存「${name}」｜${total} 字符 ≈ ${Math.round(total / 1.6)} token｜引擎口径 ${t.engine === 'k2' ? 'K2 / 自然语（分段三明治）' : t.engine === 'moss' ? 'MOSS / 自然语+Tag（tag 即整段，不注入人物段）' : 'SD / 纯 TAG（单串）'}`);
    info(STAGE.UI, `模版「${name}」已保存（${total} 字符，引擎口径 ${t.engine}）`);
  });

  root.querySelector('#hl-tpl-reload')?.addEventListener('click', () => {
    loadInto(cfg.activeTemplate);
    setStatus('已放弃改动');
  });

  function setStatus(msg, isErr) {
    const el = root.querySelector('#hl-tpl-status');
    if (!el) return;
    el.textContent = msg;
    el.classList.toggle('hl-err', !!isErr);
  }
}

/** 重建整个面板（模版增删后需要）。 */
function reloadPanel(oldRoot) {
  const paneRoot = oldRoot.closest('.hl-root');
  if (!paneRoot) return;
  const container = paneRoot.querySelector('.hl-pane[data-pane="template"]');
  if (!container) return;
  container.innerHTML = templateHtml();
  bindTemplate(container);
}

/* ============ 挂载 ============ */

/** 已经挂过面板的容器：窄栏一份、窗口一份，各挂各的、互不干扰 */
const mountedIn = new WeakSet();

/**
 * 把面板挂到容器里。
 *
 * @param {HTMLElement} [container] 目标容器。不传 = 挂到酒馆「扩展设置」里（老行为，
 *        方便用户在扩展列表里直接看到）；传 = 挂到指定容器（绘灵窗口用的是这条）。
 * @param {{variant?: 'embedded'|'window'}} [opts]
 * @returns {HTMLElement|null} 生成出来的 .hl-root
 */
export function mountPanel(container, opts = {}) {
  const host = container
    || document.getElementById('extensions_settings2')
    || document.getElementById('extensions_settings');
  if (!host) throw new Error('找不到扩展设置容器');
  if (mountedIn.has(host)) return host.querySelector('.hl-root');
  const variant = opts.variant || (container ? 'window' : 'embedded');

  const wrap = document.createElement('div');
  wrap.innerHTML = shellHtml(variant);
  const root = wrap.firstElementChild;
  host.appendChild(root);
  mountedIn.add(host);

  // 页签切换
  root.querySelectorAll('.hl-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.tab;
      root.querySelectorAll('.hl-tab').forEach(b => b.classList.toggle('active', b === btn));
      root.querySelectorAll('.hl-pane').forEach(p => p.classList.toggle('active', p.dataset.pane === key));
    });
  });

  const paneBasic = root.querySelector('.hl-pane[data-pane="basic"]');
  paneBasic.innerHTML = basicHtml();
  bindBasic(paneBasic);
  /**
   * ★ v0.9.136：基本页 / 模版页的区块折叠。
   *   用户原话：「提示词模版那 UI 面板都能折叠隐藏，因为加了很多功能后导致面板越来越庞大
   *   不利于管理和快速查看」。这两页区块最多（模版页 6 个），一屏看不完。
   *   ComfyUI 页早就有折叠（同一个函数，现搬到 `ui/collapse.js` 复用）。
   */
  enableSectionCollapse(paneBasic);

  // 手动生图：只挂一次，切到该页时刷新楼层列表（聊天会变）
  const paneManual = root.querySelector('.hl-pane[data-pane="manual"]');
  if (paneManual) {
    paneManual.innerHTML = '<div class="hl-loading">加载中…</div>';
    let manualApi = null;
    import('./manual.js')
      .then(m => { manualApi = m.mountManual(paneManual); })
      .catch(err => {
        paneManual.innerHTML = `<div class="hl-err">手动生图面板加载失败：${escapeHtml(err?.message || String(err))}</div>`;
      });
    root.querySelectorAll('.hl-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.dataset.tab !== 'manual' || !manualApi) return;
        try { manualApi.refresh(); } catch { /* 刷新失败不打断切页 */ }
      });
    });
  }

  // 外部联动（GAL）：纯开关 + 说明，没有要刷新的数据，所以不用管切页
  const paneGal = root.querySelector('.hl-pane[data-pane="gal"]');
  if (paneGal) {
    paneGal.innerHTML = '<div class="hl-loading">加载中…</div>';
    import('./gal.js')
      .then(m => m.mountGal(paneGal))
      .catch(err => {
        paneGal.innerHTML = `<div class="hl-err">外部联动面板加载失败：${escapeHtml(err?.message || String(err))}</div>`;
      });
  }

  // 数据库（v0.9.187）：读一次数据库，把地点/时间/在场/纪要摆出来 + 注入开关 + 原文预览
  const paneDb = root.querySelector('.hl-pane[data-pane="db"]');
  if (paneDb) {
    paneDb.innerHTML = '<div class="hl-loading">加载中…</div>';
    import('./db.js')
      .then(m => m.mountDb(paneDb))
      .catch(err => {
        paneDb.innerHTML = `<div class="hl-err">数据库面板加载失败：${escapeHtml(err?.message || String(err))}</div>`;
      });
  }

  const paneLlm = root.querySelector('.hl-pane[data-pane="llm"]');  if (paneLlm) {
    paneLlm.innerHTML = '<div class="hl-loading">加载中…</div>';
    import('./llm.js')
      .then(m => m.mountLlm(paneLlm))
      .catch(err => {
        paneLlm.innerHTML = `<div class="hl-err">出词 API 面板加载失败：${escapeHtml(err?.message || String(err))}</div>`;
      });
  }

  const paneTpl = root.querySelector('.hl-pane[data-pane="template"]');
  paneTpl.innerHTML = templateHtml();
  bindTemplate(paneTpl);
  enableSectionCollapse(paneTpl);

  const paneBackend = root.querySelector('.hl-pane[data-pane="backend"]');
  paneBackend.innerHTML = '<div class="hl-loading">加载中…</div>';
  mountBackend(paneBackend).catch(err => {
    paneBackend.innerHTML = `<div class="hl-err">后端面板加载失败：${escapeHtml(err?.message || String(err))}</div>`;
  });

  const paneGwords = root.querySelector('.hl-pane[data-pane="gwords"]');
  if (paneGwords) {
    paneGwords.innerHTML = '<div class="hl-loading">加载中…</div>';
    import('./gwords.js')
      .then(m => m.mountGwords(paneGwords))
      .catch(err => {
        paneGwords.innerHTML = `<div class="hl-err">全局词库加载失败：${escapeHtml(err?.message || String(err))}</div>`;
      });
  }

  const paneCast = root.querySelector('.hl-pane[data-pane="cast"]');
  paneCast.innerHTML = '<div class="hl-loading">加载中…</div>';
  let castApi = null;
  mountCast(paneCast)
    .then((api) => { castApi = api; })
    .catch(err => {
      paneCast.innerHTML = `<div class="hl-err">档案面板加载失败：${escapeHtml(err?.message || String(err))}</div>`;
    });
  /**
   * ★ v0.9.123：切到档案页时刷新「当前口径」卡。
   *   口径卡讲的是「这个模版下外貌怎么进提示词」—— 用户在模版页切完模版再回来看，
   *   不刷新就会看到上一档的说明（比不写更糟：会把人引到错的操作上）。
   */
  root.querySelectorAll('.hl-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.tab !== 'cast') return;
      try { castApi?.refreshPersona?.(); } catch { /* 刷新失败不打断切页 */ }
    });
  });

  const paneDiag = root.querySelector('.hl-pane[data-pane="diag"]');
  paneDiag.innerHTML = '<div class="hl-loading">加载中…</div>';
  mountDiag(paneDiag).catch(err => {
    paneDiag.innerHTML = `<div class="hl-err">诊断面板加载失败：${escapeHtml(err?.message || String(err))}</div>`;
  });

  const paneGallery = root.querySelector('.hl-pane[data-pane="gallery"]');
  paneGallery.innerHTML = '<div class="hl-loading">加载中…</div>';
  mountGallery(paneGallery).catch(err => {
    paneGallery.innerHTML = `<div class="hl-err">图库加载失败：${escapeHtml(err?.message || String(err))}</div>`;
  });

  // 切到图库时重新读一遍（别的时候出的图要能看见）
  root.querySelectorAll('.hl-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.tab !== 'gallery') return;
      mountGallery(paneGallery).catch(() => { /* 上面那次已经报过错 */ });
    });
  });

  info(STAGE.UI, '设置面板已挂载');
  return root;
}

/* ============ 扩展设置里的轻量启动卡 ============ */

/**
 * 扩展设置抽屉里只放这么一张卡：说明 + 打开窗口的按钮 + 两个最常用的开关。
 *
 * 绘灵的主体界面已经搬进独立窗口了，这里再塞一整套面板只会被挤成窄条
 * （六行页签在一列宽里根本没法看）。留这张卡是为了「在扩展列表里还能找到它」。
 */
export function mountQuickCard(hostEl) {
  const host = hostEl
    || document.getElementById('extensions_settings2')
    || document.getElementById('extensions_settings');
  if (!host) throw new Error('找不到扩展设置容器');
  if (mountedIn.has(host)) return host.querySelector('.hl-quick-card');
  mountedIn.add(host);

  const cfg = getConfig();
  const card = document.createElement('div');
  card.className = 'hl-root hl-quick-card';
  card.innerHTML = `
  <div class="inline-drawer">
    <div class="inline-drawer-toggle inline-drawer-header hl-header">
      <b>绘灵</b>
      <small class="hl-sub">剧情自动配图 · 角色一致性引擎</small>
      <span class="hl-ver" title="插件版本 —— 刷新后若与你刚部署的不一致，说明酒馆加载的是另一份副本">v${VERSION}</span>
      <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
    </div>
    <div class="inline-drawer-content">
      <p class="hl-quick-lead">主体界面已搬到独立窗口 —— 面板太大，塞在这里会被挤成一条。</p>
      <button class="hl-btn hl-btn-primary hl-quick-open" type="button">
        <i class="fa-solid fa-up-right-and-down-left-from-center"></i> 打开绘灵窗口
      </button>
      <div class="hl-quick-rows">
        <label class="hl-check">
          <input type="checkbox" id="hl-quick-enabled" ${cfg.enabled ? 'checked' : ''}>
          <span>启用绘灵（关掉后完全不跑，不消耗 API）</span>
        </label>
        <label class="hl-check">
          <input type="checkbox" id="hl-quick-auto" ${cfg.autoRun ? 'checked' : ''}>
          <span>自动分析剧情并配图</span>
        </label>
      </div>
      <p class="hl-quick-hint">
        顶栏图标 / 魔杖菜单 / 悬浮球 —— 入口在窗口的「基本」页里开关。
      </p>
    </div>
  </div>`;
  host.appendChild(card);

  card.querySelector('.hl-quick-open')?.addEventListener('click', () => {
    import('./window.js').then(m => m.openWindow()).catch(err => {
      warn(STAGE.UI, `打开窗口失败：${err?.message || err}`);
    });
  });

  const en = card.querySelector('#hl-quick-enabled');
  en?.addEventListener('change', () => {
    const c = getConfig();
    c.enabled = !!en.checked;
    saveSettings();
    info(STAGE.UI, `绘灵已${c.enabled ? '开启' : '关闭'}`);
  });

  const au = card.querySelector('#hl-quick-auto');
  au?.addEventListener('change', () => {
    const c = getConfig();
    c.autoRun = !!au.checked;
    saveSettings();
  });

  return card;
}
