/**
 * 绘灵 · 外部联动页（v0.9.164）
 *
 * 目前只有一件事：把绘灵挂成 GAL（IGS）认的那个 `NaiDbGen`，
 * 让 GAL 在「图像来源」里选「数据库生图插件」时，实际由绘灵写词 + 出图。
 *
 * 为什么这页必须存在（而不是只在控制台留 `HuiLing.galOn()`）：
 * 用户长期规矩 —— 功能必须有界面入口，否则等于没做。
 */
import { getConfig, saveSettings } from '../settings.js';
import {
  installGalBridge, uninstallGalBridge, galBridgeStatus, GAL_ENTRY_NAME,
  GAL_UPDATE_EVENT,
  countHlImageFloors, cleanHlImageFloors,
  auditLatestFloor, fixLatestFloorStructure,
} from '../galBridge.js';
import { escapeHtml } from '../util.js';

function auditSectionHtml() {
  const au = auditLatestFloor();
  if (!au) {
    return `
<div class="hl-section">
  <div class="hl-section-title">正文结构体检</div>
  <div class="hl-hint">当前对话还没有可读的 AI 楼层。</div>
</div>`;
  }
  const bad = au.blockers.filter((b) => !b.neutralized);
  const rows = bad.map((b) => `
    <div class="hl-hint" style="margin-top:6px;line-height:1.7">
      <span class="hl-err">${b.kind === '标签' ? `&lt;${escapeHtml(b.name)}&gt;` : `${escapeHtml(b.name)}（方括号）`}</span>
      未闭合 · 第 ${b.start} 字<br>
      <span style="opacity:.8">…${escapeHtml(b.snippet)}…</span>
    </div>`).join('');

  return `
<div class="hl-section">
  <div class="hl-section-title">正文结构体检（第 ${au.index} 楼，${au.length} 字）</div>
  <div class="hl-hint" style="line-height:1.9">
    GAL 插图前会先解析正文结构：<b>任何一处没闭合的尖括号词或方括号</b>都会被它当成
    「一个罩到结尾的块」，于是那个位置之后<b>整楼都插不进图</b> ——
    界面只报一句「没有安全的独占行插入位置」，看不出是哪个标签。<br>
    模型经常在 <code>&lt;draft&gt;</code> 里顺手写一句
    <code>(对标&lt;writing_covenant&gt;)</code> 这种话，就足够把整楼废掉。
  </div>
  ${bad.length
    ? `<div style="margin-top:8px">发现 ${bad.length} 处：${rows}</div>
       <div style="margin-top:10px">
         <button class="hl-btn hl-ghost" id="hl-gal-fix-body">给本楼剧情套 &lt;content&gt;</button>
         <span class="hl-hint" style="margin-left:8px">
           把 <code>&lt;now_plot&gt;</code> 里那段正文包起来，让 GAL 只认它 —— 施工块留在外面。
           <b>会改这一楼的正文</b>（只加两个标签，别的一字不动）。
         </span>
       </div>`
    : '<div class="hl-hint" style="margin-top:8px"><span class="hl-ok">✅ 结构干净，GAL 可以正常插图</span></div>'}
  <div class="hl-hint" style="margin-top:8px;opacity:.85">
    根治办法是改卡/预设的输出格式：让剧情外面常驻一层 <code>&lt;content&gt;…&lt;/content&gt;</code>，
    这样每一楼都不用再点急救。
  </div>
</div>`;
}

/**
 * 「本楼 CG 提示词」（v0.9.177）。
 *
 * ★ 为什么必须有这一块：用户能看到的结果只有一张图，而「为什么画成这样」
 *   「我填的服装有没有真的进去」只能靠读词回答。GAL 自己把 caption 写进
 *   `user/files/igs-cg-records.json`，但它没有任何界面入口 —— 以前只能由我
 *   在文件里翻出来贴给他。现在直接在面板上看。
 *
 * 两层，分工不同：
 *   · 写词结果  = 出词模型写的那句话（锚点 + caption 原文）
 *   · 实际送图  = 后端真正收到的正向/负向（已并入画师串、透明底等前置词条）
 */
/**
 * 「外貌来源」当前的实际效果。
 *
 * ★ 必须把「开关值」和「上次实际替换了几个」分开写：
 *   只显示开关，用户会以为「选了绘灵就一定用绘灵」；实际可能是 GAL 这次
 *   没给【角色设定】段（0 个），或者档案里没有这个人（0 个）—— 两种 0 的处理方式完全不同。
 */
function lookStatsHint(st) {
  if (st.appearanceSource !== 'huilin') {
    return 'GAL 给什么就用什么。它的「角色 DNA」为空时，写词模型只能从剧情正文里猜外貌 —— '
      + '这也是「改了档案不生效」的原因。';
  }
  const s = st.lastLookStats;
  if (!s) return '绘灵档案优先：写词时把【角色设定】里每个角色的「外貌：」换成档案的 nlProfile。还没跑过写词。';
  if (s.replaced > 0) {
    return `<span class="hl-ok">上次写词换了 ${s.replaced} 个角色的外貌</span>（取自绘灵角色档案）。`;
  }
  return '<span class="hl-warn">上次写词一个都没换上</span>：'
    + '要么 GAL 这次没给【角色设定】段，要么档案里没有这些人（名字要对得上，简称也算）。';
}

/** 「服装来源」当前的实际效果 —— 款式/状态/裸露是整包换的，这里必须说清 */
function outfitStatsHint(st) {
  if (st.outfitSource !== 'huilin') {
    return '跟随 GAL：它按正文换衣装名（半脱/褪下就是另起一个衣装名 + 该名字的描述）。';
  }
  const s = st.lastOutfitStats;
  const live = st.outfitScan !== false;
  const tail = live
    ? '<br>「GAL 接管期间仍按正文更新服装态」开着，所以档案是<b>活的</b>：每楼读一次正文更新，'
      + '半脱 / 褪下 / 裸露都会跟着剧情走。'
    : '<br><b>注意</b>：你关掉了「GAL 接管期间仍按正文更新服装态」，'
      + '档案里的服装停在「最后一次单独用绘灵时」的状态 —— 现在换到的可能是旧衣服。';
  if (!s) return `绘灵档案优先：整包换成「服装=款式（服装状态=…；裸露=…）」那一行。还没跑过写词。${tail}`;
  if (s.replaced > 0) {
    return `<span class="hl-ok">上次写词整包换了 ${s.replaced} 个角色的款式+状态+裸露</span>（取自绘灵档案）。${tail}`;
  }
  return `<span class="hl-warn">上次写词一个都没换上</span>：角色没建档，或者款式和状态都还是空的。${tail}`;
}

/**
 * 「这批画了多大」—— 面板必须显示**实际送图**的尺寸，不是只显示绘灵自己那套。
 *
 * ★ 病例（2026-10-31）：面板写 `864×1152`，实际送进 ComfyUI 的是 GAL 的 `1216×832`，
 *   我拿面板的数去判断「竖版怎么会把人画扁」，方向一开始就错了。
 *   两个口径不同时，把实际生效的那个标出来；GAL 没给尺寸就退回绘灵口径。
 */
function canvasNoteOf(batch, st) {
  const gal = batch && batch.galCanvas;
  const own = Number(batch && batch.width) > 0 ? `${batch.width}×${batch.height}` : '';
  if (!gal || !(Number(gal.width) > 0)) return own ? ` · 画布 ${own}` : '';
  const live = st && st.canvasSource === 'gal';
  return ` · 画布 ${gal.width}×${gal.height}${live ? '（GAL 口径，实际用这个）' : '（GAL 要的；当前用绘灵口径）'}`;
}

export function promptSectionHtml(st) {
  const log = Array.isArray(st.promptLog) ? st.promptLog : [];
  const paint = st.lastPaint;

  const paintHtml = paint
    ? `
  <details style="margin-top:10px">
    <summary class="hl-hint" style="cursor:pointer">
      最近一次实际送进后端的词（${escapeHtml(new Date(paint.at).toLocaleTimeString())} ·
      ${paint.width || '?'}×${paint.height || '?'} · ${String(paint.prompt || '').length} 字）
    </summary>
    <div class="hl-hint" style="margin-top:6px">正向：</div>
    <pre class="hl-gal-prompt" id="hl-gal-paint-pos">${escapeHtml(paint.prompt || '')}</pre>
    ${paint.negative ? `<div class="hl-hint" style="margin-top:6px">负向：</div>
    <pre class="hl-gal-prompt" id="hl-gal-paint-neg">${escapeHtml(paint.negative)}</pre>` : ''}
  </details>`
    : '';

  if (!log.length) {
    return `
<div class="hl-section">
  <div class="hl-section-title">本楼 CG 提示词</div>
  <div class="hl-hint">
    还没有写过词。到 GAL 里点一次「绘制 CG」，这里就会出现<b>这一楼每张图</b>的锚点与提示词原文。
  </div>
  ${paintHtml}
</div>`;
  }

  const batchHtml = (b, idx) => {
    const when = new Date(b.at).toLocaleString('zh-CN', { hour12: false });
    const items = (b.items || []).map((it) => `
      <div style="margin-top:8px">
        <div class="hl-hint" style="line-height:1.7">
          <b>#${it.slotId}</b>　锚点：
          ${it.anchor
            ? escapeHtml(it.anchor)
            : '<span class="hl-err">没有锚点 —— GAL 会把这张判成「没有能对上正文的生成点」而丢掉</span>'}
        </div>
        <pre class="hl-gal-prompt" id="hl-gal-p-${idx}-${it.slotId}">${escapeHtml(it.caption || '')}</pre>
        <div style="margin-top:4px">
          <button class="hl-btn hl-ghost hl-gal-copy" data-copy="hl-gal-p-${idx}-${it.slotId}">复制这段提示词</button>
        </div>
      </div>`).join('');

    return `
    <div class="hl-hint" style="margin-top:${idx === 0 ? '4' : '10'}px;line-height:1.8">
      <b>第 ${b.messageId ?? '-'} 楼</b> · ${escapeHtml(when)} ·
      ${(b.items || []).length} 张${canvasNoteOf(b, st)}${b.note ? ` · ${escapeHtml(b.note)}` : ''}
    </div>
    ${items}`;
  };

  const rest = log.slice(1);
  const restHtml = rest.length
    ? `
  <details style="margin-top:12px">
    <summary class="hl-hint" style="cursor:pointer">更早的 ${rest.length} 批（翻回去看上一楼画了什么词）</summary>
    ${rest.map((b, i) => batchHtml(b, i + 1)).join('')}
  </details>`
    : '';

  return `
<div class="hl-section">
  <div class="hl-section-title">本楼 CG 提示词（最新一批）</div>
  ${batchHtml(log[0], 0)}
  ${restHtml}
  ${paintHtml}
  <div class="hl-hint" style="margin-top:10px;opacity:.85">
    提示词里的时段光色（<code>warm evening light</code> / <code>dim amber light</code>）是出词模型
    照着剧情里的时间写的。它会和 GAL 的「环境滤镜」叠加 —— 觉得图偏色时先看这里有没有这类词。
  </div>
</div>`;
}

function shell() {
  const g = getConfig().galBridge || {};
  const st = galBridgeStatus();
  const hl = countHlImageFloors();

  const stateText = st.enabled
    ? (st.mounted
      ? `<span class="hl-ok">已挂载</span>（${st.hosts} 个宿主对象）`
      : '<span class="hl-err">已开启但没挂上</span>')
    : '<span class="hl-hint">未开启</span>';

  /**
   * 最近一次调用 —— ★ 这块是给「GAL 只弹一句『未返回可用提示词』」准备的。
   * GAL 那边从不显示我们的错误原文（它自己拼文案），所以失败原因必须在这里落地，
   * 否则用户只能干看着一句没有任何信息的话。
   */
  const lc = st.lastCall;
  const lastCallHtml = !lc
    ? '<span class="hl-hint">还没有被调用过</span>'
    : `${new Date(lc.at).toLocaleTimeString()} · ${lc.kind === 'prompt' ? '写词' : '出图'} · `
      + (lc.ok
        ? `<span class="hl-ok">成功</span> ${escapeHtml(lc.message)}`
        : `<span class="hl-err">失败 ${escapeHtml(lc.code)}</span> ${escapeHtml(lc.message)}`);

  return `
<i data-hl-gal-panel="1" hidden></i>
<div class="hl-section">
  <div class="hl-section-title">GAL 前端联动（Galgame.json / IGS）</div>
  <label class="hl-check">
    <input id="hl-gal-enabled" type="checkbox" ${g.enabled ? 'checked' : ''}>
    <span>允许 GAL 前端调用绘灵写词与出图</span>
    <div class="hl-hint">
      打开后，绘灵会以 <code>window.${GAL_ENTRY_NAME}</code> 的身份注册到页面上 ——
      这个名字是 GAL 的「数据库生图插件」通道在找的入口，GAL 那边一个字都不用改。
      <br>关掉即撤销注册：只清绘灵自己挂的那个，不会误删别人。
    </div>
  </label>
  <div class="hl-hint" style="margin-top:8px">
    当前状态：${stateText}　·　模版口径：<code>${escapeHtml(st.output)}</code>　·　画布：<code>${st.canvas.width}×${st.canvas.height}</code>
  </div>
  <div class="hl-hint" style="margin-top:6px">
    最近一次调用：${lastCallHtml}
  </div>
  <div class="hl-hint" style="margin-top:6px">
    <b>提示</b>：GAL 那边只会弹一句「未返回可用提示词（DBGen 写词）」，不会显示原因 ——
    真正的失败原因看上面这一行。点一次「刷新状态」就能更新。
  </div>
  <div style="margin-top:10px">
    <button class="hl-btn hl-ghost" id="hl-gal-reinstall">重新挂载</button>
    <button class="hl-btn hl-ghost" id="hl-gal-refresh">刷新状态</button>
  </div>
</div>

<div class="hl-section">
  <div class="hl-section-title">适配开关：这几项由你决定听谁的</div>
  <label class="hl-check">
    <input id="hl-gal-artist" type="checkbox" ${st.useGalArtist ? 'checked' : ''}>
    <span>并入 GAL 的画师串</span>
    <div class="hl-hint">
      GAL 把画师串按图片类型分成 9 组：立绘 / 表情差分 / Q版头像 / 衣柜 / 背景 / 物品 / CG / NSFW CG / 非人。
      打开时，GAL 传哪一组就并哪一组（正向放提示词最前、负向并进负面）。<br>
      <b>绘灵自己的全局前缀 / 后缀始终生效</b> —— 想只用 GAL 的画风，
      把「全局词库 → 全局前缀/后缀」清空即可，不用在这里折腾。
    </div>
  </label>
  <div class="hl-hint" style="margin-top:10px">
    画布尺寸：
    <select id="hl-gal-canvas">
      <option value="huilin" ${st.canvasSource === 'huilin' ? 'selected' : ''}>用绘灵的（${st.canvas.width}×${st.canvas.height}）</option>
      <option value="gal" ${st.canvasSource === 'gal' ? 'selected' : ''}>跟随 GAL（默认）</option>
    </select>
    <div class="hl-hint" style="margin-top:4px">
      GAL 那边几类图尺寸各不相同（CG / 立绘 / 背景 / 小道具），
      选了「跟随 GAL」之后，它要多大就出多大 —— <b>但会一律对齐到 ${st.multiple} 的整数倍</b>。
      这一步不能省：MOSS 的分桶就在 ${st.multiple} 的倍数上，给个奇数会被它悄悄挪进最近一档，
      表现就是「尺寸不对 + 人物漂移」，而且日志里一切正常。
    </div>
    <div class="hl-hint" style="margin-top:4px">
      尺寸有<b>两级</b>来源：① GAL 图位设了尺寸就用它；② 没设就用它 description 里写的
      构图尺寸（原句形如「画面是横的，宽1216，高832」）。两级都没有才回到绘灵自己算的。
    </div>
    ${st.descCanvas ? `<div class="hl-hint" style="margin-top:4px">
      GAL 最近一次要的是 <b>${st.descCanvas.width}×${st.descCanvas.height}</b>
      （从它 description 的构图尺寸解析出来的）。
    </div>` : ''}
    <div class="hl-hint" style="margin-top:4px">
      对齐用「后端 › 分辨率选择器 › 倍数」那个值（现在是 <code>${st.multiple}</code>）。
      两边不一样时，<b>绘灵这边仍是你自己的设置</b>，只有这一项会临时跟着 GAL 走。
    </div>
  </div>
  <div class="hl-hint" style="margin-top:12px">
    角色<b>外貌</b>来源：
    <select id="hl-gal-appearance">
      <option value="huilin" ${st.appearanceSource === 'huilin' ? 'selected' : ''}>绘灵角色档案（默认）</option>
      <option value="gal" ${st.appearanceSource === 'gal' ? 'selected' : ''}>跟随 GAL 的【角色设定】</option>
    </select>
    <div class="hl-hint" style="margin-top:4px">${lookStatsHint(st)}</div>
  </div>
  <div class="hl-hint" style="margin-top:12px">
    角色<b>服装</b>来源（款式 + 状态 + 裸露，整包一起换）：
    <select id="hl-gal-outfit">
      <option value="gal" ${st.outfitSource === 'gal' ? 'selected' : ''}>跟随 GAL（默认）</option>
      <option value="huilin" ${st.outfitSource === 'huilin' ? 'selected' : ''}>绘灵角色档案</option>
    </select>
    <div class="hl-hint" style="margin-top:4px">${outfitStatsHint(st)}</div>
    <label class="hl-check" style="margin-top:8px">
      <input id="hl-gal-outfit-scan" type="checkbox" ${st.outfitScan !== false ? 'checked' : ''}>
      <span>GAL 接管期间仍按正文更新服装态</span>
      <div class="hl-hint">
        只读正文、只写档案，<b>不写图位</b>（插图仍然全交给 GAL）。关掉它，档案里的款式 / 状态 / 裸露
        就停在「你最后一次单独用绘灵时」—— 这时候选「服装来源＝绘灵档案」拿到的会是旧衣服。
      </div>
    </label>
  </div>
</div>

<div class="hl-section">
  <div class="hl-section-title">GAL 上次带来的角色与衣装</div>
  <div class="hl-hint" style="margin-bottom:6px">
    服装状态是 <b>GAL 自己维护</b>的：它解析正文里的衣装指令 → 更新角色当前衣装 →
    写进下一次请求。绘灵看不到它的内部状态，所以这里直接摊<b>它原文传过来的那段</b>。
  </div>
  ${st.cast.length
    ? st.cast.map((c) => `
      <div class="hl-hint" style="margin-top:6px;line-height:1.7">
        <b>${escapeHtml(c.name)}</b>${c.outfitName ? ` · 当前衣装「${escapeHtml(c.outfitName)}」` : ' · 没写衣装名'}
        ${c.outfit ? `<br><span style="opacity:.85">${escapeHtml(c.outfit)}</span>` : '<br><span class="hl-hint">（没有衣装描述）</span>'}
      </div>`).join('')
    : (st.lastCall
      ? `<div class="hl-hint" style="line-height:1.8">
          <span class="hl-warn">上一批请求里<b>没有【角色设定】段</b></span> ——
          说明 GAL 那边的<b>角色 DNA（外貌 / 当前衣装）是空的</b>，它压根没往外拼这一段。<br>
          绘灵的替换是<b>在它给的这一段里换字</b>：没有这一段，就没有「外貌：」「当前衣装」这两行可换，
          两个来源开关选什么都一样。<br>
          根治办法是去 GAL「素材 → 角色立绘 → 角色设定」把外貌和衣装填上。
        </div>`
      : '<span class="hl-hint">还没有收到过带角色设定的请求（GAL 那边画一次 CG 之后这里就会有）</span>')}
  ${st.castText
    ? `<details style="margin-top:10px">
        <summary class="hl-hint" style="cursor:pointer">
          展开 GAL 这次的【角色设定】原文（${st.castText.length} 字 · 外貌 / 排除项 / 性格 / 当前衣装都在这里）
        </summary>
        <pre class="hl-gal-prompt" id="hl-gal-casttext">${escapeHtml(st.castText)}</pre>
      </details>`
    : ''}
</div>

${promptSectionHtml(st)}

${auditSectionHtml()}

<div class="hl-section">
  <div class="hl-section-title">正文图位：两套系统只能留一套</div>
  <div class="hl-hint" style="line-height:1.9">
    GAL 往正文里写的是 <code>[igs-img:N]</code> 标记，由它的阅读器按图库渲染；
    绘灵写的是 <code>&lt;hl_image pos="Pn"&gt;提示词&lt;/hl_image&gt;</code>。<br>
    <b>GAL 阅读器不认识后者</b>，会把它当普通正文显示出来 —— 你看到正文里横着一大段
    <code>{"summary":…}</code> 就是这个原因。<br>
    所以开关打开后，绘灵**不再自动分析楼层、也不再写图位**，插图全交给 GAL。
  </div>
  <div class="hl-hint" style="margin-top:8px">
    本对话残留的绘灵图位：
    ${hl.floors
      ? `<span class="hl-err">${hl.floors} 个楼层 / ${hl.blocks} 个块</span>`
      : '<span class="hl-ok">没有</span>'}
  </div>
  <div style="margin-top:8px">
    <button class="hl-btn hl-ghost" id="hl-gal-clean" ${hl.floors ? '' : 'disabled'}>清理这些图位</button>
    <span class="hl-hint" style="margin-left:8px">只删 <code>&lt;hl_image&gt;…&lt;/hl_image&gt;</code> 整块，别的一字不动</span>
  </div>
</div>

<div class="hl-section">
  <div class="hl-section-title">在 GAL 里怎么用</div>
  <div class="hl-hint" style="line-height:1.9">
    ① 打开 GAL →「生图与AI › 图像来源」，把来源切成 <b>数据库生图插件</b>（图上叫「数据集生图插件」的那个）。<br>
    ② 之后 GAL 要点「画 CG」时，会先把画面描述 + 角色设定交给绘灵写词，再让绘灵出图。<br>
    ③ 两条接口必须都在：只有出图没有写词，GAL 会自动出图/补全素材时会报「版本过旧」。
  </div>
</div>

<div class="hl-section">
  <div class="hl-section-title">设定与参数以谁为准</div>
  <div class="hl-hint" style="line-height:1.9">
    · <b>人物外貌</b>：按上面「角色外貌来源」的开关走。选<b>绘灵角色档案</b>时，绘灵把
      【角色设定】里每个人的「外貌：」整段换成档案里的写法，<b>性格 / 排除项原样保留</b>；
      选 GAL 就原样透传。只换被选中的那一项 —— 两套设定同时写进同一张图，
      模型只会挑一条听（这就是「同一件事写两遍」的老病）。<br>
    · <b>服装</b>：按「服装来源」开关走。<b>款式 / 状态 / 裸露是整包一起换的</b>，
      选绘灵档案时 GAL 的「当前衣装」内容被整段替换；GAL 自己给的那套衣装名和时间线
      仍留在请求里，上面「GAL 上次带来的角色与衣装」能对照原文。<br>
    · <b>画布尺寸 / seed / 负面</b>：一律用绘灵这边的设置，GAL 传的值只记进日志。
      尺寸归你（上面显示的 ${st.canvas.width}×${st.canvas.height}），负面只用「全局词库 → 全局负面」的原文。<br>
    · GAL 默认尺寸是 <code>832x1216</code>（约 2:3），绘灵这边是 3:4，接过去会让画面变窄长，
      所以默认不接它的尺寸。
  </div>
</div>

<div class="hl-section">
  <div class="hl-section-title">对接状态（按 GAL 0.37.52 的接口逐条核过）</div>
  <div class="hl-hint" style="line-height:1.95">
    <span class="hl-ok">✅ 写词</span> generateSinglePrompt —— description 与【角色设定】原样吃进来<br>
    <span class="hl-ok">✅ 出图</span> generate —— 返回真 Blob，GAL 自己转 dataURL 存图<br>
    <span class="hl-ok">✅ 插件设置按钮</span> openManagement —— 缺它 GAL 会报「未检测到数据库生图插件」<br>
    <span class="hl-ok">✅ 插入锚点</span> anchorSentence —— 图能不能贴进正文全看它（GAL 找不到锚点会静默丢图）<br>
    <span class="hl-ok">✅ 画师串</span> 9 类按类型分别并入<br>
    <span class="hl-ok">✅ CG / 立绘 / 背景 / 物品</span> 四类图共用同一条接口，全部由绘灵出<br>
    <span class="hl-warn">⚠ 透明底</span> 立绘要 <code>straight_alpha</code>，得你的后端工作流本身支持透明通道<br>
    <span class="hl-err">✕ 局部重绘</span> GAL 走 NAI inpaint，dbgen 通道没有这一项，它会提示改用内置 NAI<br>
    <span class="hl-err">✕ 多格 Layout</span> 绘灵的「一页 N 格」口径交给 GAL 会变四格漫画，所以被拒绝
  </div>
</div>

<div class="hl-section">
  <div class="hl-section-title">做不到的事（不是 bug）</div>
  <div class="hl-hint" style="line-height:1.9">
    · <b>不会新增「第五条图像来源」</b>：GAL 的来源列表是写死的
      <code>["nai","dbgen","extension","baibai"]</code>，没有注册位，只能借 dbgen 这条。<br>
    · <b>多格 Layout 口径会被拒绝</b>：那套成品是「一页 N 格」，交给 GAL 当一张 CG 会变成四格漫画。
      要用 GAL 联动，请把模版切成单图类。<br>
    · <b>不支持局部重绘</b>：和 dbgen 原通道一致，GAL 会提示改用内置 NAI。
  </div>
</div>`;
}

/**
 * 面板「跟着最新数据走」的订阅（v0.9.181）。
 *
 * ★ 病例：用户已经画到 22 楼，面板里最新一批还停在 **12 楼**。
 *   数据一直是好的（`promptLog[0].messageId === 22`），是整页 HTML 只在
 *   **挂载那一刻**生成过一次 —— 之后写词、出图、记日志都不会重绘。
 *   以前只能靠用户自己点「刷新状态」，而他根本不知道该点。
 *
 * ★ 三条纪律：
 *   ① 订阅必须能解绑：面板每次重挂都先 `removeEventListener` 掉上一个 handler，
 *      否则来回切页面会累积一堆监听（泄漏 + 重绘风暴）。
 *      **为什么不用 `AbortController` + `{signal}`**：`signal` 要求 AbortSignal 与
 *      EventTarget 同源，跨环境（JSDOM / 测试垫的 EventTarget）会**静默失败** ——
 *      监听根本没注册、一条广播都收不到，而代码里一点报错都没有。成对 add/remove
 *      没有这个前提，行为在每个环境都一样。
 *   ② **宿主不在文档里就不重绘**：面板切到别的 tab 时元素已被移走，
 *      这时整页重写会把别的内容盖掉。
 *   ③ 合并抖动：一次写词会连着触发 record → rememberPromptBatch → rememberPaint
 *      三条广播，节流到一次重绘，别让用户看到面板闪三下。
 */
const REDRAW_DELAY_MS = 350;
let liveHost = null;
let liveHandler = null;
let liveTimer = null;

function unbindLiveRefresh() {
  if (!liveHandler) return;
  try { globalThis.removeEventListener(GAL_UPDATE_EVENT, liveHandler); } catch { /* 环境不支持：忽略 */ }
  liveHandler = null;
}

function bindLiveRefresh(host) {
  liveHost = host;
  unbindLiveRefresh();
  /**
   * ★ 判据不是 `isConnected` 就够：多 tab 面板切换时 host 元素**仍在文档里**，
   *   只是 innerHTML 被换成了另一个页签的内容 —— 只看连接状态会把别人的页面覆盖掉。
   *   所以认一个哨兵节点：它还在，就说明这块 DOM 仍然是我们画的。
   */
  const alive = () => !!liveHost && !!liveHost.querySelector?.('[data-hl-gal-panel]');
  liveHandler = () => {
    if (!alive()) return;
    if (liveTimer) clearTimeout(liveTimer);
    liveTimer = setTimeout(() => {
      liveTimer = null;
      if (!alive()) return;
      mountGal(liveHost);
    }, REDRAW_DELAY_MS);
  };
  try { globalThis.addEventListener(GAL_UPDATE_EVENT, liveHandler); } catch { liveHandler = null; }
}

export function mountGal(host) {
  if (!host) return null;
  host.innerHTML = shell();
  bindLiveRefresh(host);

  const cb = host.querySelector('#hl-gal-enabled');
  const btn = host.querySelector('#hl-gal-reinstall');

  const apply = (on) => {
    const cfg = getConfig();
    if (!cfg.galBridge || typeof cfg.galBridge !== 'object') cfg.galBridge = {};
    cfg.galBridge.enabled = !!on;
    saveSettings();
    if (on) installGalBridge(cfg);
    else uninstallGalBridge();
    /* 重挂一遍整页：状态文案要跟着变（手写 diff 容易漏，直接重渲染最省事） */
    mountGal(host);
  };

  cb?.addEventListener('change', () => apply(cb.checked));

  const patch = (fn) => {
    const c = getConfig();
    if (!c.galBridge || typeof c.galBridge !== 'object') c.galBridge = {};
    fn(c.galBridge);
    saveSettings();
    mountGal(host);
  };
  host.querySelector('#hl-gal-artist')?.addEventListener('change', (ev) => {
    patch((gb) => { gb.useGalArtist = !!ev.target.checked; });
  });
  host.querySelector('#hl-gal-canvas')?.addEventListener('change', (ev) => {
    patch((gb) => { gb.canvasSource = ev.target.value === 'gal' ? 'gal' : 'huilin'; });
  });
  host.querySelector('#hl-gal-appearance')?.addEventListener('change', (ev) => {
    patch((gb) => { gb.appearanceSource = ev.target.value === 'gal' ? 'gal' : 'huilin'; });
  });
  host.querySelector('#hl-gal-outfit')?.addEventListener('change', (ev) => {
    patch((gb) => { gb.outfitSource = ev.target.value === 'huilin' ? 'huilin' : 'gal'; });
  });
  host.querySelector('#hl-gal-outfit-scan')?.addEventListener('change', (ev) => {
    patch((gb) => { gb.outfitScan = !!ev.target.checked; });
  });

  /**
   * 复制提示词：读 `<pre>` 的 textContent（就是原文）。
   * ★ 不能从属性里存原文 —— 引号/尖括号会被 HTML 转义，复制出来就不是原来那句了。
   */
  host.querySelectorAll('.hl-gal-copy').forEach((el) => {
    el.addEventListener('click', async (ev) => {
      const id = ev.currentTarget?.dataset?.copy;
      const pre = id ? host.querySelector(`#${id}`) : null;
      const text = pre ? pre.textContent : '';
      if (!text) return;
      try {
        await navigator.clipboard.writeText(text);
        toastr?.success?.('提示词已复制');
      } catch {
        toastr?.warning?.('浏览器不让写剪贴板 —— 手动选中那段文字复制即可');
      }
    });
  });

  host.querySelector('#hl-gal-refresh')?.addEventListener('click', () => mountGal(host));
  host.querySelector('#hl-gal-clean')?.addEventListener('click', async (ev) => {
    const btnEl = ev.currentTarget;
    btnEl.disabled = true;
    try {
      const r = await cleanHlImageFloors();
      toastr?.success?.(`已清理 ${r.floors} 个楼层、${r.blocks} 个绘灵图位`);
      if (r.failed) toastr?.warning?.(`有 ${r.failed} 个楼层写入失败（正文可能刚被改过），可再点一次`);
    } finally {
      mountGal(host);
    }
  });
  host.querySelector('#hl-gal-fix-body')?.addEventListener('click', async (ev) => {
    const btnEl = ev.currentTarget;
    btnEl.disabled = true;
    try {
      const r = await fixLatestFloorStructure();
      if (r.ok) {
        toastr?.success?.(`第 ${r.index} 楼已套上 <content>（+${r.added} 字），现在回 GAL 点「绘制 CG」`);
      } else if (r.reason === 'already') {
        toastr?.info?.('这一楼已经有 <content> 了，不需要再套');
      } else if (r.reason === 'no-block') {
        toastr?.warning?.('这一楼找不到完整的 <now_plot>…</now_plot>（可能模型没写闭合标签），没法自动包裹');
      } else if (r.reason === 'still-blocked') {
        toastr?.warning?.('包了 <content> 之后剧情区自己还有未闭合标签，套了也没用 —— 先看体检里列出的那些');
      } else {
        toastr?.error?.(`修补失败：${r.reason || '未知原因'}`);
      }
    } finally {
      mountGal(host);
    }
  });
  btn?.addEventListener('click', () => {
    const cfg = getConfig();
    if (!cfg.galBridge?.enabled) return apply(false);
    uninstallGalBridge();
    installGalBridge(cfg);
    mountGal(host);
  });

  return {
    refresh: () => mountGal(host),
  };
}
