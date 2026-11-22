/**
 * mossMangaLayouts.js —— 漫画页版式库（预置分镜）
 *
 * ## 这个文件解决的是「结构性」问题，不是措辞问题
 *
 * 参考实现（wuhehen176/ComfyUI-MOSS-MangaLayout）之所以稳定出「正常漫画」，
 * 核心不是提示词写得好，而是**版式是人（或程序）事先摆好的**，
 * 图片模型只负责回答「这个框里画什么」。而本插件原来的做法是让 chat 模型
 * 同时判断剧情、分镜、格数、坐标 —— 实测连跑三次格数是 28 / 10 / 25。
 *
 * 所以这里把「格数 → 格框坐标」从模型手里拿走，做成**查表**：
 *   · 每页格数 → 一组不等高/不等宽的框（模拟漫画家手工分镜的节奏）
 *   · 阅读顺序 = frames 数组顺序（从左上到右下，或竖排从上到下）
 *   · 部分版式带一个**通高人物**（跨格前景主体，遮住格线，不另计格）
 *
 * ## 坐标系（与成品 Layout 严格一致）
 *
 * 这里全部用 **0~1 百分比 + 左上原点 + xyxy**，只在 `mossMangaPage.js`
 * 转成「中心化 yxyx 像素」的成品格式。中间不做任何归一化假设，
 * 免得和 `mossJsonLayout.js` 里那套 `bbox_coord_space` / `bbox_format` 混掉。
 */

/* ═══════════ 版式构造器（保证几何正确，不手算坐标系） ═══════════ */

/** 竖排：在 x0~x1 这条列里，按 heights 从上往下切。 */
function stackV(x0, x1, heights) {
  const out = [];
  let y = 0;
  for (const h of heights) {
    out.push([x0, y, x1, y + h]);
    y += h;
  }
  return out;
}

/** 横排：在 y0~y1 这条带里，按 widths 从左往右切。 */
function stackH(y0, y1, widths) {
  const out = [];
  let x = 0;
  for (const w of widths) {
    out.push([x, y0, x + w, y1]);
    x += w;
  }
  return out;
}

/** n 等分（用于「下排 k 格」这种均分）。 */
function even(n) {
  const out = [];
  for (let i = 0; i < n; i += 1) out.push(1 / n);
  return out;
}

/* ═══════════ 高度节奏表 ═══════════
 *
 * ★ 全部**不等高**。均分是「表格」，不等高才是「漫画」——
 *   张力格（动作/接触）给大格，台词格/look 格给窄条。
 *   数字来自参考图与漫画家习惯：底部最后一格通常最高（收尾大格）。
 */
const H3 = [0.30, 0.31, 0.39];
const H4 = [0.185, 0.205, 0.200, 0.410];
/** v0.9.147：H5/H6 随 strip5-figR / strip6-figR 一起删除 —— 留着一张没人用的节奏表，
 *  下一个人会以为「5 格横排」还有可用版式。 */

/* ═══════════ 版式清单 ═══════════ */
/**
 * 每个版式：
 *   id     唯一名（日志/测试用）
 *   panels 格数（必须精确等于 frames.length，供按格数查表）
 *   family 家族（竖排 / 一大几小 / 网格 / 交错 / 横带）
 *   frames 格框（0~1 · 左上原点 · xyxy · 数组顺序 = 阅读顺序）
 *   figure 通高人物所在栏 `{x0,x1}`；null = 这页没有跨格主体
 *   note   给日志看的一句话
 */
export const MANGA_LAYOUTS = [
  /* ── 竖排 + 右侧通高人物（复刻参考图那张，实测出图最稳） ── */
  { id: 'strip3-figR', panels: 3, family: 'strip', frames: stackV(0, 0.450, H3), figure: { x0: 0.458, x1: 1 }, note: '左 3 条竖排 + 右侧通高人物' },
  { id: 'strip4-figR', panels: 4, family: 'strip', frames: stackV(0, 0.430, H4), figure: { x0: 0.438, x1: 1 }, note: '左 4 条竖排 + 右侧通高人物（参考图同款）' },
  /**
   * ★★★ v0.9.147：`strip5-figR` / `strip6-figR` **已删**（不是降权，是删）。
   *
   * 实测几何（848×1136 画布，扣 15px 缝）：
   *   · strip5-figR 最小格 324×155 = 画布 **5.2%**；
   *   · strip6-figR 最小格 307×133 = 画布 **4.2%**。
   * 307×133 的框里连一张脸都放不下，只会被画成一道色块或直接省略 ——
   * 而它们还各带一条通高人物栏（再吃掉 38% 宽度），留给格子的更窄。
   * 更糟的是**5 格档原本只有 strip5-figR 一个选项** ⇒ 用户手选「固定 5 格」
   * 等于必定拿到最差的版式（不是运气问题）。所以删掉，并在 5 格档补两个正常版式。
   */
  { id: 'strip3-figL', panels: 3, family: 'strip', frames: stackV(0.550, 1, H3), figure: { x0: 0, x1: 0.542 }, note: '右 3 条竖排 + 左侧通高人物' },
  { id: 'strip4-figL', panels: 4, family: 'strip', frames: stackV(0.570, 1, H4), figure: { x0: 0, x1: 0.562 }, note: '右 4 条竖排 + 左侧通高人物' },

  /* ── 竖排无人物（纯剧情页，人物在各格里） ── */
  { id: 'strip3-plain', panels: 3, family: 'strip', frames: stackV(0, 1, H3), figure: null, note: '全宽 3 条竖排（无人物的连续剧情页）' },
  { id: 'strip4-plain', panels: 4, family: 'strip', frames: stackV(0, 1, H4), figure: null, note: '全宽 4 条竖排' },

  /* ── 一大几小（张力格 + 分镜格，漫画最常用的节奏） ── */
  { id: 'hero-top-3', panels: 4, family: 'hero', frames: [[0, 0, 1, 0.500], ...stackH(0.512, 1, even(3))], figure: null, note: '上部大格（张力）+ 下排 3 小格' },
  { id: 'hero-top-4', panels: 5, family: 'hero', frames: [[0, 0, 1, 0.460], ...stackH(0.472, 1, even(4))], figure: null, note: '上部大格 + 下排 4 小格' },
  { id: 'hero-bottom-3', panels: 4, family: 'hero', frames: [...stackH(0, 0.440, even(3)), [0, 0.452, 1, 1]], figure: null, note: '上排 3 小格 + 下部大格（收尾）' },
  { id: 'hero-left-3', panels: 4, family: 'hero', frames: [[0, 0, 0.560, 1], ...stackV(0.572, 1, H3)], figure: null, note: '左侧大格（整高）+ 右侧 3 小格' },
  /**
   * ★★★ v0.9.141：frames 的**顺序必须等于读者的阅读顺序** —— 剧情第 1 步落在 frames[0]。
   *
   * 这一款在「左到右」的读法下**本质上是有歧义的**（左列 3 窄格 + 右列整高大格）：
   *   按 Z 形排，右大格 y0=0 会跟左上格同带，于是它排第 2；
   *   但视觉上读者第一眼看到的是**面积 44%×100% 的右大格**。
   * ⇒ 不假装是 Z 形，**如实声明读法** `right-big`：先右大格，再左列从上到下。
   *   （`hero-left-3` 是它的镜像，声明 `left-big`；45° 版面靠这个保证剧情不读岔。）
   */
  { id: 'hero-right-3', panels: 4, family: 'hero', frames: [[0.440, 0, 1, 1], ...stackV(0, 0.428, H3)], figure: null, note: '右侧大格（整高）+ 左侧 3 小格' },
  { id: 'hero-top-2', panels: 3, family: 'hero', frames: [[0, 0, 1, 0.560], ...stackH(0.572, 1, even(2))], figure: null, note: '上部大格 + 下排 2 格' },
  /**
   * ★★★ v0.9.149：**4 格档里唯一「主格在第 3 格」的版式**（补空缺，不是加花样）。
   *
   * 起因：`mainBeat`（这一页最重的是第几条）上线后才发现，4 格档 11 个版式的主格
   * 只落在第 1 格（`hero-top-3`/`hero-left-3`/`hero-right-3`）、第 2 格
   * （`grid-2x2-stag`）或第 4 格（`hero-bottom-3`/`strip4-*`）—— **第 3 格一个都没有**。
   * 而真实草稿里「主戏在第 3 步」非常常见（A/B 实验 9 页里有 4 页如此：
   * 空镜地板 → 她的腿 → **她直起身**；他说话 → 她沉默 → **她靠肩** …）。
   * 没有这一款，那 4 页永远只能拿到「四格等大」，重头戏被压成 25%。
   *
   * 几何与 `hero-mid-5` 同族（上排两小格 → 中间大格 → 底部收尾），只是去掉一排：
   *   上排 2 格各 424×295px，中间大格 848×509px，底部 848×304px（848×1136 画布）。
   */
  { id: 'hero-mid-4', panels: 4, family: 'hero', frames: [
    [0, 0, 0.500, 0.260], [0.512, 0, 1, 0.260],
    [0, 0.272, 1, 0.720],
    [0, 0.732, 1, 1],
  ], figure: null, note: '上排 2 格 + 中间大格 + 底部收尾格' },
  /**
   * ★★★ v0.9.152：**主格在第 3 格，而且那一格是竖的**（补空缺，第二个）。
   *
   * 起因（用户 2026-10-29 04:11 / 04:13）：
   *   「剧情提示词只适合某版式那就选用这个版式不就行了？为啥非要强行用不合适的版式，
   *     然后还恰到好处把这 1 小格剧情硬塞到不适合的版式格里？这个横版特写不就是典型例子吗？」
   *   「A 适合横版就给个横版，B 适合竖给个竖，C 适合特写（刚好剧情需要）……」
   *
   * `hero-mid-4` 解决了「主格在第 3 格」，但它的中间大格是 **1.67:1 横框**。
   * 半身（`upper`）和需要身体的动作放在横大格里会被拉宽，竖格更自然 —— 这一款补的就是这个：
   * 主格在第 3 位、面积 40%、而且是一块**竖格**（aspect 0.67）。
   *
   * ★ 它**不是给特写用的**。用户 04:15 的原话定了优先级：
   *   「给特写的时候挑个小格不就行了，需要整体或者半身或者全身就给大格。」
   *   一张脸不需要 40% 的页面，给了它就会逼模型加手臂肩背去填满（P24 趴地托腮就是这么来的）。
   *   所以 `face` 的判据是「**小格** + 不扁」，大格在 `shapeFitOf` 里对特写直接 0 分，
   *   这一款对特写页反而不会入选 —— 这是对的。
   *
   * ★ 第一版设计（`hero-right-m`，右侧通高格）被既有测试当场否掉：
   *   大格 y0=0 与上排格同带，按行读序是 0→2→1→3，而 frames 顺序是 0→1→2→3 ——
   *   **读者会把第 3 条读成第 1 条**。几何算错可以修，读序错等于剧情读岔。
   *   数学上也绕不开：4 格里要有一格「全宽且 aspect≤1.2」需高 ≥0.62 页，
   *   剩下的高度分不出 3 个「短边 ≥0.23」的格（0.62+3×0.23 > 1）。
   *
   * ⇒ 换成**上下两排各 2 格、下排左大右小**：大格只占下排左侧，按行读序天然 0→1→2→3。
   *   几何（848×1136）：上排 424×364 / 424×364，下排 509×759（主格）/ 329×759。
   *   面积 16% / 15.6% / **40.1%** / 25.9%（平均 25%，`mainPanelIndex` 判主格 = 第 3 格）。
   *   每格短边 364 / 364 / 509 / 329px，全部过得了页高 23%（261px）的几何底线。
   */
  { id: 'hero-split-tall', panels: 4, family: 'hero', frames: [
    [0, 0, 0.500, 0.320], [0.512, 0, 1, 0.320],
    [0, 0.332, 0.600, 1],
    [0.612, 0.332, 1, 1],
  ], figure: null, note: '上排 2 小格 + 下排左大竖格（主格在第 3 格）+ 右下竖格' },

  /* ── 网格（对话戏 / 平行动作） ── */
  { id: 'grid-2x2', panels: 4, family: 'grid', frames: [[0, 0, 0.500, 0.500], [0.512, 0, 1, 0.500], [0, 0.512, 0.500, 1], [0.512, 0.512, 1, 1]], figure: null, note: '2x2 网格（等分，对话戏）' },
  { id: 'grid-2x2-stag', panels: 4, family: 'grid', frames: [[0, 0, 0.580, 0.340], [0, 0.352, 0.580, 1], [0.592, 0, 1, 0.640], [0.592, 0.652, 1, 1]], figure: null, note: '2x2 错位（列不等高，避免表格感）' },
  { id: 'grid-2x3', panels: 6, family: 'grid', frames: [
    [0, 0, 0.500, 0.333], [0.512, 0, 1, 0.333],
    [0, 0.345, 0.500, 0.667], [0.512, 0.345, 1, 0.667],
    [0, 0.679, 0.500, 1], [0.512, 0.679, 1, 1],
  ], figure: null, note: '2 列 x 3 行' },
  { id: 'grid-3x2', panels: 6, family: 'grid', frames: [
    [0, 0, 0.333, 0.500], [0.345, 0, 0.667, 0.500], [0.679, 0, 1, 0.500],
    [0, 0.512, 0.333, 1], [0.345, 0.512, 0.667, 1], [0.679, 0.512, 1, 1],
  ], figure: null, note: '3 列 x 2 行' },

  /* ── 横带 + 插图（杂志漫画/海报感） ── */
  { id: 'band-top-inset', panels: 4, family: 'band', frames: [
    [0, 0, 1, 0.220], [0, 0.232, 0.520, 0.740], [0.532, 0.232, 1, 0.740], [0, 0.752, 1, 1],
  ], figure: null, note: '上横带（环境）+ 中 2 格 + 下横带（收尾）' },
  /**
   * ★★★ v0.9.141：上横带 0.160 → **0.200**。
   *
   * 病例（第一楼 page07 实测）：0.160 的横带在 880×1184 下只有 190px 高，
   * 模型把它**从中间竖切成左右两格**（左边男主的手、右边女主的脸），
   * 版式 4 格出图像 5 格。
   *
   * ⚠️ **抬到 0.200 并没有解决竖切**（单变量重出后仍然切开），
   * 加「do not split it into a left half and a right half」也没有 ——
   * 因为真因不在形状，在**那一格写了两个主体**（一只手 + 一张脸）：
   *   同批 page04 的 `band-top-inset`（0.220）单主体 → 完整一格没被切；
   *   page09 的 `strip4-plain` 四条横带全是单主体 → 也没被切。
   * ⇒ 保留 0.200 只是因为它让 190px 的条带没那么扁（视觉），
   *   竖切属**已知限制**，见 `MEMORY.md`，别再在这上面调措辞。
   */
  { id: 'band-mid-hero', panels: 4, family: 'band', frames: [
    [0, 0, 1, 0.200], [0, 0.212, 0.660, 0.775], [0.672, 0.212, 1, 0.775], [0, 0.787, 1, 1],
  ], figure: null, note: '上横带 + 中左大格 + 中右窄格 + 下横带' },

  /* ── 5 格（v0.9.147 新增：原来这一档只有一款 155px 的横排，等于没有） ── */
  /**
   * ★ 这两个版式的几何底线：**每格短边 ≥ 画布短边的 30%**（848 下 ≈ 258px），
   *   比被删掉的 strip5-figR（155px）宽出六成。
   *   一格 258~309px 高，够画半身 + 气泡，不够画两人全身 —— 所以它们是「对话/推进」版式，
   *   不是「拥抱/动作」版式。选型交给 `rankLayouts` 按 `mood` 排序，这里只保证不出现废格。
   */
  { id: 'hero-top-quad', panels: 5, family: 'hero', frames: [
    [0, 0, 1, 0.420],
    [0, 0.432, 0.500, 0.714], [0.512, 0.432, 1, 0.714],
    [0, 0.726, 0.500, 1], [0.512, 0.726, 1, 1],
  ], figure: null, note: '上大格（张力）+ 下 2x2 四格' },
  { id: 'hero-mid-5', panels: 5, family: 'hero', frames: [
    [0, 0, 0.500, 0.240], [0.512, 0, 1, 0.240],
    [0, 0.252, 1, 0.680],
    [0, 0.692, 0.500, 1], [0.512, 0.692, 1, 1],
  ], figure: null, note: '上排 2 格 + 中间大格 + 下排 2 格' },

  /* ── 2 格（极简节奏：一问一答 / 前后对比） ── */
  { id: 'two-stack', panels: 2, family: 'duo', frames: [[0, 0, 1, 0.520], [0, 0.532, 1, 1]], figure: null, note: '上下 2 格（前 / 后）' },
  { id: 'two-side-fig', panels: 2, family: 'duo', frames: stackV(0, 0.560, [0.450, 0.550]), figure: { x0: 0.568, x1: 1 }, note: '左 2 格 + 右侧通高人物' },
  { id: 'two-side', panels: 2, family: 'duo', frames: [[0, 0, 0.500, 1], [0.512, 0, 1, 1]], figure: null, note: '左右 2 格（对峙 / 对望）' },
];

/** 按格数分桶（只建一次）。 */
const BY_PANELS = (() => {
  const m = new Map();
  for (const l of MANGA_LAYOUTS) {
    if (!m.has(l.panels)) m.set(l.panels, []);
    m.get(l.panels).push(l);
  }
  return m;
})();

/* ═══════════ 几何体检：这一格到底画不画得下人 ═══════════ */
/**
 * ★★★ v0.9.147：把「版式好不好用」变成**可计算的数**。
 *
 * 起因（用户 2026-10-29 两张实拍）：随机抽到 `strip4-plain`（4 条全宽横带，
 * 最矮 195px）和 `band-top-inset`，出图里人物被画成一排局部，
 * 「从身后抱住」的动作完全消失。用户原话：
 *   「你给的版式很多，但真正稳定的很少，而且忽略了模型能不能画得下。」
 *
 * 三个量（**全部相对**，不写死像素阈值 —— 换分辨率/换画幅都成立）：
 *   · `minShort` 最短边（以「页高」为单位）：决定这格能不能画下一个半身；
 *   · `minArea`  最小格占格总面积的比例：防「边角料格」（模型在那儿只能画块颜色）；
 *   · `flatness` 最扁那格的长宽比：越大越像横带，只适合环境 / 单主体。
 *
 * ⚠️ 这里**只用来排序与截断，不硬禁** —— 横带版式在「环境空镜页」仍然是正解，
 * 所以它留在一个更小的候选池里由 `mood` 决定要不要用。
 */
const PAGE_AR = 848 / 1136; // 竖版页幅；只用于把归一化 w/h 换到同一单位

function layoutMetrics(lay) {
  const cells = ((lay && lay.frames) || []).map((f) => {
    const w = (f[2] - f[0]) * PAGE_AR;
    const h = f[3] - f[1];
    return { w, h, area: w * h, short: Math.min(w, h) };
  });
  if (!cells.length) return null;
  const total = cells.reduce((a, c) => a + c.area, 0) || 1;
  return {
    minShort: Math.min(...cells.map((c) => c.short)),
    minArea: Math.min(...cells.map((c) => c.area / total)),
    maxArea: Math.max(...cells.map((c) => c.area / total)),
    flatness: Math.max(...cells.map((c) => Math.max(c.w / c.h, c.h / c.w))),
  };
}

/** 这个版式有多「能画人」。0~1，越大越好。导出给测试与诊断看。 */
export function layoutDrawability(lay) {
  const m = layoutMetrics(lay);
  return m ? Number(m.minShort.toFixed(3)) : 0;
}

/**
 * 戏型 → 排序键。`mood` 由模型在草稿顶层答一个词（见 `mossLayout` 的指令）。
 *
 * ★ 为什么让模型答「这一页是什么戏」而不是让它挑版式 id：
 *   模型看不到图，从 20 多个 id 里挑等于盲选；但「对话 / 动作 / 亲密 / 氛围」
 *   是它读正文就能答准的分类，而且**答一个词**属于填空类（实测 ≈100%），
 *   不是数数类（实测不稳）。
 */
const MOOD_RANK = {
  /** 亲密 / 动作：先保「每格都能画下人」，再奖励「有一格明显大」——那是拥抱能站住的地方。 */
  intimate: (a, b) => (b.m.minShort * 3 + b.m.maxArea) - (a.m.minShort * 3 + a.m.maxArea),
  action: (a, b) => (b.m.minShort * 3 + b.m.maxArea) - (a.m.minShort * 3 + a.m.maxArea),
  /** 对话：格子和格子之间要均匀（你来我往），所以把「最小格」的权重放高。 */
  dialogue: (a, b) => (b.m.minShort * 2 + b.m.minArea) - (a.m.minShort * 2 + a.m.minArea),
  /** 氛围：反过来要扁 —— 横带正好是环境 / 空镜的常规画法。 */
  scenery: (a, b) => b.m.flatness - a.m.flatness,
};

/**
 * 每格面积（归一化单位，只用于比值）。抽出来是因为「空镜占大格」与
 * 「主格落在第几条」两处判据必须用**同一份面积数据** —— 项目里踩过
 * 「算用一套坐标系、比用另一套」的坑。
 */
function cellAreas(lay) {
  return ((lay && lay.frames) || [])
    .map((f) => Math.max(0, f[2] - f[0]) * Math.max(0, f[3] - f[1]));
}

/**
 * ★★★ v0.9.148：**空镜格拿到了多少面积**。
 *
 * 病例（用户 2026-10-29 实拍，`hero-top-3` 的 P10/P35）：上面那格占 50% 页面，
 * 而草稿里第 1 条情节恰好是 `shot:'environment'`（空器材室）——
 * 于是**半页画了一张空房间**，用户原话是「开头啥也没有」。
 *
 * 这不是措辞问题：模型并不知道自己那条空镜会被分到多大的格子（版式是代码选的），
 * 所以只能由选版式这一层避开。判据用**面积比**而不是写死像素：
 *   · `share` 空镜格总面积 / 格总面积 —— 和「平均格面积 1/n」比；
 *   · `hitsBig` 空镜是否命中了**最大那格**（哪怕只有两格时也是它）。
 *
 * @param {object} lay
 * @param {string[]} [shots] 与 frames 索引对齐的 shot 列表（短了按末条补齐，
 *   和 `buildMangaPage` 里 `panelsIn[Math.min(i, len-1)]` 的口径**必须一致**）
 * @returns {{idx:number[], share:number, mean:number, hitsBig:boolean, count:number, waste:boolean}}
 */
export function emptySlotsOf(lay, shots) {
  const frames = (lay && lay.frames) || [];
  const n = frames.length;
  const cells = cellAreas(lay);
  const total = cells.reduce((a, b) => a + b, 0) || 1;
  const list = Array.isArray(shots) ? shots : [];
  const idx = [];
  for (let i = 0; i < n; i++) {
    const s = String(list[Math.min(i, Math.max(0, list.length - 1))] || '').trim().toLowerCase();
    if (s === 'environment') idx.push(i);
  }
  if (!n || !idx.length) {
    return { idx: [], share: 0, mean: n ? 1 / n : 1, hitsBig: false, count: 0, waste: false };
  }
  const share = idx.reduce((a, i) => a + cells[i], 0) / total;
  const mean = 1 / n;
  const biggest = Math.max(...cells);
  /**
   * ⚠️ 判「大格」不能直接比 `=== 最大值`：`grid-2x2` 四格完全等大（各 25%），
   * 那样每一格都会被当成"最大格"，于是空镜放哪儿都算浪费 —— 实测立刻误杀
   * `grid-2x2`（本来最稳的对话版式）。必须要求**最大格明显大于平均**才算「有大格」。
   */
  const hasBigCell = biggest > (total / n) * 1.15;
  const hitsBig = hasBigCell && idx.some((i) => cells[i] >= biggest - 1e-9);
  /* 允许 15% 容差：`grid-2x2` 四格因缝线不完全等大（第一格 25.6% vs 平均 25%），
     容差太小时会把它误杀 —— 那是本项目最稳的对话版式，不能因为一丝缝就出局。 */
  const waste = hitsBig || share > mean * 1.15;
  return { idx, share, mean, hitsBig, count: idx.length, waste };
}

/**
 * ★★★ v0.9.152：**一张脸最多能塞进多扁的框**。
 *
 * 用户 2026-10-29 04:11 的原话（这就是这条判据的来源）：
 *   「剧情提示词只适合某板式那就选用这个板式不就行了？为啥非要强行用不合适的板式，
 *     然后还恰到好处的把这 1 小格剧情硬塞到不适合的版式格里？这个横版特写不就是典型的例子吗？」
 *
 * 阈值 1.2 是实测定的，不是拍的（宽/高）：
 *   · 1.69（P24 大格 833×494）⇒ 出图「趴地托腮」，整格演绎废掉；
 *   · 1.33（P28 大格 848×636）⇒ 同一份提示词连跑 4 次，**4 次全带托腮的手**；
 *   · 1.06~1.16（`hero-left-3` 右列、`grid-2x3` 每格）⇒ 近正方，脸画得正常。
 * `mossMangaPage` 的兜底降级**必须用同一个常量**，否则「拦」和「降」两条线会漂移。
 */
export const FACE_MAX_ASPECT = 1.2;

/**
 * ★★★ v0.9.153：**一张脸该占多少页面**（特写要小格）。
 *
 * 用户 2026-10-29 04:15 的原话就是这条判据：
 *   「给特写的时候挑个小格不就行了，需要整体或者半身或者全身就给大格。」
 *
 * 为什么光有宽高比不够 —— 两页实测把这件事说透了：
 *   · P24 第 3 格 **833×494（aspect 1.69 · 面积 0.45 页）** ⇒ 趴地托腮、身体占六成；
 *   · P28 上部大格 **848×636（aspect 1.33 · 面积 0.56 页）** ⇒ 同一份提示词连跑 4 次，
 *     **4 次全带托腮的手 / 手臂**。
 * P28 的 1.33 在旧判据里算「勉强及格（1 分）」，于是照样被选中 —— 但它的真问题是**太大**：
 * 一张脸给了半个页面，模型必须造手臂和肩背去填满那块面积。
 *
 * 阈值 0.30 页的来历（不是拍的）：四格等大 = 0.25 页 ⇒ 2 分；`hero-split-tall` 主格 0.40 页
 * ⇒ 1 分（画得下但浪费）；P28 的 0.56 页 ⇒ 0 分。0.30 正好把「四格等大的正常格」
 * 与「占了三分之一页面以上的大格」分开。
 */
export const FACE_MAX_AREA = 0.30;

/**
 * ★★★ v0.9.152：**特写格有没有拿到能装下脸的框**（内容×几何的第二条匹配）。
 *
 * 第一条是 `emptySlotsOf`（空镜不许占大格）。这一条补的是「竖东西不进扁框」：
 * 选版式时如果一页里有 `shot:face`，先只在「那一格够方/够竖」的版式里挑 ——
 * 这就是用户说的「剧情适合某版式就选那个」。只有当**一款都不满足**时才回到原池，
 * 由 `buildMangaPage` 把那一格降级成半身（别硬塞）。
 *
 * 为什么阈值算 aspect 要传 `pageAspect`：frames 是归一化坐标，
 * 归一化宽高比 × (画布宽/高) 才是模型实际看到的框形。
 * 项目里踩过「算用一套坐标系、比用另一套」的坑（`toBox` 那次），所以口径由调用方给。
 *
 * @param {object} lay
 * @param {string[]} [shots] 与 frames 索引对齐（短的按末条补齐，同 `emptySlotsOf`）
 * @param {number} [pageAspect] 画布宽/高（生产 848×1136 ≈ 0.746）
 * @returns {{ok:boolean, bad:{i:number, aspect:number}[], count:number}}
 */
/**
 * ★★★ v0.9.154：`full` 的两个维度 —— **面积** 与 **宽度**。
 *
 * 起因（P35 病例，2026-10-29 出图 4 张定案）：
 *   旧判据是「够高（hNorm ≥0.28）且不宽（aspect ≤1.3）⇒ 2 分」，等于在奖励「又高又窄」。
 *   拿三个有出图证据的 full 格一套，判据正好把结果反过来打：
 *     P34  833×608  面积 0.525 · 宽 0.98  → 旧 1 分  → 出图**好**（两人全身舒展）
 *     P21  460×1121 面积 0.535 · 宽 0.54  → 旧 2 分  → 出图好
 *     P35  314×744  面积 **0.243** · 宽 **0.37** → 旧 **2 分** → 出图**远景小人 + 门占半格**
 *   ⇒ 全身真正需要的是**铺开的面积**和**并排的宽度**，不是「高」。窄高条再高也站不下两个人。
 *
 * 这条和 `FACE_MAX_AREA` 是同一个错误的两面：特写要**小**面积，全身要**大**面积。
 * 同一个陷阱不要放过：以后新增任何 `shot` 类型，先问「它要的是面积、宽度，还是高度」。
 */
export const FULL_MIN_AREA = 0.40;   // 2 分：真正铺得开（两人并排也够）
export const FULL_MIN_WIDTH = 0.45;  // 2 分：并排宽度下限（窄条只能画成远景小人）
export const FULL_OK_AREA = 0.28;    // 1 分：至少装得下一个人站着

export function faceFitOf(lay, shots, pageAspect = 848 / 1136) {
  const frames = (lay && lay.frames) || [];
  const list = Array.isArray(shots) ? shots : [];
  const pa = Number(pageAspect) > 0 ? Number(pageAspect) : 848 / 1136;
  const bad = [];
  let count = 0;
  for (let i = 0; i < frames.length; i++) {
    const s = String(list[Math.min(i, Math.max(0, list.length - 1))] || '').trim().toLowerCase();
    if (s !== 'face') continue;
    count += 1;
    const f = frames[i];
    const h = Math.max(0, f[3] - f[1]);
    if (h <= 1e-6) continue;
    const w = Math.max(0, f[2] - f[0]);
    const aspect = (w * pa) / h;
    const area = w * h;
    if (aspect > FACE_MAX_ASPECT || area > FACE_MAX_AREA) bad.push({ i, aspect, area });
  }
  return { ok: bad.length === 0, bad, count };
}

/**
 * ★★★ v0.9.152：**每一格「要什么形状」，与版式「给什么形状」，逐格对上多少。**
 *
 * 用户 2026-10-29 04:13 的原话（这就是这条判据的设计稿）：
 *   「根据先一步生成好的剧情提示词去挑选板式……比如分 ABCD，4 格，
 *     例如 A 适合横版就给个横版，B 适合竖给个竖，C 适合特写（刚好剧情需要），
 *     D 又适合 XXX，看着剧情填合适比例不是更好？」
 *
 * 为什么不是「整页选一款版式」：整页匹配只能表达「这页偏动作 / 偏对话」，
 * 表达不了「第 3 条要一张脸、第 1 条要两个人并排」。粒度错了，就必然出现
 * 「整页合格、某一格硬塞」—— 横框特写就是这一格被硬塞。
 *
 * 打分规则（每格 0/1/2 分，`shot` 决定要什么）：
 *   · `face`        **小格且不扁**（面积 ≤0.30 页 且 aspect ≤1.2）⇒ 2 分；
 *                   竖但太大 ⇒ 1 分（画得下，浪费）；扁 ⇒ 0 分（实测崩）
 *   · `full`        **面积 ≥0.40 页 且 宽 ≥0.45 页宽** ⇒ 2 分（v0.9.154 改：要铺得开）；
 *                   面积 ≥0.28 ⇒ 1 分（站得下一个人）；否则 0 分（窄高条 = 远景小人）
 *   · `action`      够宽（≥1.3）⇒ 2 分；≥1.0 ⇒ 1 分（两人并排要横向空间）
 *   · `environment` 够宽（≥1.5）⇒ 2 分；≥1.1 ⇒ 1 分（空镜横着才像场景）
 *   · `detail` / `upper` / `response` —— 中性，不计入分母（局部与半身横竖都能画，
 *      真实出图里 2.88 的耳朵格是正常的，给它们打分会把版式池无故削薄）
 *
 * ★ `face` 为什么要两个维度（v0.9.153，用户 04:15「特写挑个小格，整体/半身/全身给大格」）：
 *   只判宽高比时，P28 那个 848×636（aspect 1.33 · 面积 0.56 页）算「勉强及格」，
 *   于是被选中 → 同一份提示词连跑 4 次，**4 次全出托腮的手**。
 *   一张脸给了半个页面，模型必须造手臂和肩背去填满那块面积 —— 这是**面积**的问题，不是框形。
 *
 * 返回值是 0~1 的比率（不是总分），这样格数不同的页之间可比。
 *
 * @param {object} lay
 * @param {string[]} [shots] 与 frames 索引对齐（短的按末条补齐，同 `emptySlotsOf`）
 * @param {number} [pageAspect] 画布宽/高
 * @returns {{score:number, cells:{i:number, need:string, aspect:number, got:number}[], counted:number}}
 */
export function shapeFitOf(lay, shots, pageAspect = 848 / 1136) {
  const frames = (lay && lay.frames) || [];
  const list = Array.isArray(shots) ? shots : [];
  const pa = Number(pageAspect) > 0 ? Number(pageAspect) : 848 / 1136;
  const cells = [];
  let sum = 0;
  for (let i = 0; i < frames.length; i++) {
    const s = String(list[Math.min(i, Math.max(0, list.length - 1))] || '').trim().toLowerCase();
    const f = frames[i];
    const wNorm = Math.max(0, f[2] - f[0]);
    const hNorm = Math.max(0, f[3] - f[1]);
    const aspect = hNorm > 1e-6 ? (wNorm * pa) / hNorm : 99;
    let got = null;
    /**
     * `face` 两件事都要满足：**不扁**（脸是竖的）且**不大**（特写不需要大画面）。
     * 只判宽高比时 P28 那种 848×636 会拿到「勉强及格」而被选中，然后连跑 4 次都出托腮手 ——
     * 面积这一维就是为它补的（见 `FACE_MAX_AREA` 的病例）。
     */
    if (s === 'face') {
      const small = wNorm * hNorm <= FACE_MAX_AREA;
      got = (aspect <= FACE_MAX_ASPECT && small) ? 2
        : ((aspect <= FACE_MAX_ASPECT || (aspect <= 1.6 && small)) ? 1 : 0);
    }
    /**
     * `full` = 面积 + 宽度，**不看高度**（v0.9.154，见 `FULL_MIN_AREA` 的 P35 病例）。
     * 旧写法 `hNorm >= 0.28 && aspect <= 1.3` 把唯一画崩的 314×744 判满分、
     * 把出得最好的 833×608 判 1 分，方向是反的。
     */
    else if (s === 'full') {
      const area = wNorm * hNorm;
      got = (area >= FULL_MIN_AREA && wNorm >= FULL_MIN_WIDTH) ? 2
        : (area >= FULL_OK_AREA ? 1 : 0);
    }
    else if (s === 'action') got = aspect >= 1.3 ? 2 : (aspect >= 1.0 ? 1 : 0);
    else if (s === 'environment') got = aspect >= 1.5 ? 2 : (aspect >= 1.1 ? 1 : 0);
    if (got === null) continue;
    cells.push({ i, need: s, aspect, area: wNorm * hNorm, got });
    sum += got;
  }
  const counted = cells.length;
  return { score: counted ? sum / (counted * 2) : 0, cells, counted };
}

/**
 * 按戏型把候选池排一遍（稳定的 tiebreak，避免「同一页每次排序不同」）。
 * @returns {object[]} 排好序的版式（长度不变）
 */
export function rankLayouts(pool, mood) {  const list = (pool || []).map((l) => ({ l, m: layoutMetrics(l) })).filter((x) => x.m);
  const cmp = MOOD_RANK[String(mood || '').trim().toLowerCase()];
  /* 模型漏答 mood 时用中性排序：纯按「能画人」排。
     这样即使它一个字不填，最差的横带款也已经被截掉了（不是"随机等于没改"）。 */
  const use = cmp || ((a, b) => b.m.minShort - a.m.minShort);
  list.sort((a, b) => use(a, b) || String(a.l.id).localeCompare(String(b.l.id)));
  return list.map((x) => x.l);
}

/**
 * ★★★ v0.9.148：在**已经截断好的**候选池里，把「空镜占大格」的版式**摘掉**。
 *
 * ⚠️ 两步顺序不能颠倒 —— 第一版把这一步并进 `rankLayouts` 当排序主键，实测立刻翻车：
 *   把 `hero-top-3`（主格住空镜）沉底后，池尾的横带款（`band-top-inset` 220px /
 *   `band-mid-hero` 200px）反而被顶进候选，P10 有 **30%** 落到「一排横条」，比修复前更差。
 *   正确顺序：几何先决定「哪些版式画得下人」，再在这些人能画下的版式里挑「空镜不占大格」的。
 *
 * ⚠️ 也不能只排序不筛：候选池是**均匀随机取**的，排序只改变顺序，
 *   P10 实测仍有 **61.5%** 抽到「半页空房间」。必须真的从池里拿掉。
 *
 * @param {object[]} list 已截断的候选池
 * @param {string[]} [shots] 每格 shot
 * @returns {object[]} 只留「空镜不占大格」的；一个都不剩时退回原池（不能选不出图）
 */
export function sinkEmptyLayouts(list, shots) {
  const arr = Array.isArray(list) ? list : [];
  if (!Array.isArray(shots) || !shots.length) return arr;
  const good = arr.filter((l) => !emptySlotsOf(l, shots).waste);
  return good.length ? good : arr;
}

/**
 * ★★★ v0.9.149：**主格落在第几格**（0 基；没有明显主格 → -1）。
 *
 * 起因（用户 2026-10-29 A/B 实验，9 页同一份草稿、只换版式）：
 *   · P21 四格等大 → 「头到脚」的全身镜头消失，四格全是半身；
 *   · P12 大格在底部 → 46% 画面分给了第 4 条「她的手按在他胸口」，
 *     而第 1 条「把她揽进怀里」被塞进 25% 的小格 ⇒ 关键动作看不清；
 *   · P31 第 1、4 条都是 `face` → 一页两格都是她的脸。
 * 反过来，B 组（我按剧情手工指定版式）赢的地方**全部是「大格落在最重的那一步」**。
 * ⇒ 版式不是不知道剧情，是**没人告诉它剧情重点在哪儿**。
 *
 * 判据与 `emptySlotsOf` 共用 `cellAreas` 和同一道「明显大于平均才算主格」的门槛
 * （1.15 倍）—— 否则 `grid-2x2` 四格等大时会被判出「主格 = 第 1 格」，
 * 于是任何 `mainBeat` 都会把它筛掉，那是本项目最稳的对话版式。
 */
export function mainPanelIndex(lay) {
  const cells = cellAreas(lay);
  const n = cells.length;
  if (!n) return -1;
  const total = cells.reduce((a, b) => a + b, 0) || 1;
  const biggest = Math.max(...cells);
  if (biggest <= (total / n) * 1.15) return -1;
  return cells.indexOf(biggest);
}

/**
 * 这个版式对「第 beat 条最重要」的契合度：**0 = 主格正好是它，1 = 不亏待，2 = 被压成小格**。
 * @param {object} lay
 * @param {number} beat 1 基（草稿里的 `mainBeat`）
 */
export function mainBeatScore(lay, beat) {
  const cells = cellAreas(lay);
  const n = cells.length;
  const k = Math.round(Number(beat) || 0);
  if (!n || k < 1) return 1;
  /* 格数对不上（走的是「取不小于 want 的最小档」兜底）→ 没法把条数与格子一一对应，按中性处理。 */
  if (k > n) return 1;
  const total = cells.reduce((a, b) => a + b, 0) || 1;
  const mean = total / n;
  const biggest = Math.max(...cells);
  const area = cells[k - 1];
  if (area >= biggest - 1e-9 && biggest > mean * 1.15) return 0;
  /* 容差 10%：`strip3-*` 第 2 格 0.31 vs 平均 0.3333 差 7%，那只是"不等高节奏"，
     不算"被压小"；真正被压的是 `strip4-plain` 第 3 格 0.20 / 平均 0.25 = 80%。 */
  return area >= mean * 0.9 ? 1 : 2;
}

/**
 * ★★★ v0.9.149：把「这一页最重的是第几条」变成候选池的硬约束。
 *
 * 规则（三级回落，任何一级都不许返回空池 —— 选不出图比版式不完美更糟）：
 *   ① 主格正好落在这一条（`score===0`）有 **≥2 个** → 只用它们（有得挑，还要保持变化）；
 *   ② 只有 1 个 → 它 + 「不亏待」的那批（`score===1`），避免整楼同一种版式；
 *   ③ 一个都没有 → 只用「不亏待」那批；再没有 → 原池。
 *
 * ⚠️ 必须在**几何截断 + 空镜筛选之后**调用：顺序反过来会让「画不下人」的横条款
 *   因为主格位置正确而挤掉好版式（`sinkEmptyLayouts` 注释里记着同类翻车）。
 *
 * @param {object[]} list 已过几何与空镜两道筛的候选池
 * @param {number} beat 1 基序号（模型填的 `mainBeat`；0 / 缺省 = 不筛）
 * @param {boolean} [strict] ★ 实验开关（v0.9.150，**默认关闭**）：命中款即使只有 1 个也**只用它**，
 *   不并「不亏待」那批。用于 A/B 验证「为一页的命中率，值不值得牺牲整楼版式的变化」——
 *   实测（真实草稿 9 页）非 strict 下 `mainBeat=3` 四页里只有 1 页命中，
 *   因为 4 格档只有 `hero-mid-4` 一款主格在第 3 格，并进四格等大后它被稀释到 25%~33%。
 */
export function preferMainBeat(list, beat, strict = false) {
  const arr = Array.isArray(list) ? list : [];
  const k = Math.round(Number(beat) || 0);
  if (k < 1 || !arr.length) return arr;
  const best = arr.filter((l) => mainBeatScore(l, k) === 0);
  const ok = arr.filter((l) => mainBeatScore(l, k) === 1);
  if (strict && best.length) return best;
  if (best.length >= 2) return best;
  if (best.length === 1) return ok.length ? [...best, ...ok] : best;
  return ok.length ? ok : arr;
}

/* ═══════════ 版式选取 ═══════════ */

/** 库里出现过的格数（升序）。 */
export function mangaPanelCounts() {
  return [...BY_PANELS.keys()].sort((a, b) => a - b);
}

/** 按 id 精确取（手选版式 / 复现某张图）。 */
export function mangaLayoutOf(id) {
  const v = String(id || '').trim();
  return MANGA_LAYOUTS.find((l) => l.id === v) || null;
}

/**
 * 按**实际情节条数**选版式。
 *
 * ★ 格数由内容决定，不由模型数。这是本文件存在的全部意义：
 *   模型只输出 N 条情节，程序按 N 查表拿版式，两者天然对齐，
 *   不存在「模型写了 3 格但版式是 4 格」这种错位。
 *
 * ★★★ v0.9.147：先按几何**截掉最差的那三分之一**，再按 `mood` 排序。
 *   实测（同一份 4 格草稿连抽 200 次）：不加这一步时 9 个版式各占 11%，
 *   其中 `strip4-plain`(195px) / `band-mid-hero`(212px) / `band-top-inset`(235px)
 *   三款横带合占 **33%** —— 也就是说每三页就有一页被画成一排横条。
 *   用户看到的「版式随机到很不好用的那种」正是这三款。
 *
 * @param {number} n      本次实际情节条数
 * @param {Function} rand 随机源（测试注入）
 * @param {string} [prefer] 指定版式 id（命中且格数够就用它）
 * @param {object} [opts]
 *   - `noFigure` 只要**不带通高人物栏**的版式
 *   - `preferFigure` 这一页**真的要**那个人物栏（调用方已确认这个人不参与格内戏）
 *   - `mood`     这一页的戏型：`intimate|action|dialogue|scenery`（模型答，可缺省）
 *   - `panelShots` 每格 shot（v0.9.148）。给了就避开「空镜占大格」（见 `emptySlotsOf`）
 *   - `mainBeat` 这一页最重的是第几条（1 基，v0.9.149）。给了就让主格落在这一条
 *                （见 `preferMainBeat`）；0 / 缺省 = 不筛
 * @returns {object|null}  null = 没有可用版式（n<2 或库不覆盖）
 */
export function pickMangaLayout(n, rand = Math.random, prefer, opts = {}) {
  const want = Math.max(0, Math.round(Number(n) || 0));
  const noFigure = opts && opts.noFigure === true;
  const ok = (l) => !!l && (!noFigure || !l.figure);
  const fixed = mangaLayoutOf(prefer);
  if (ok(fixed) && fixed.panels >= want) return fixed;
  if (want < 2) return null;
  const pickFrom = (arr) => {
    const pool = (arr || []).filter(ok);
    if (!pool.length) return null;
    const r = typeof rand === 'function' ? rand() : Math.random();
    return pool[Math.min(pool.length - 1, Math.max(0, Math.floor(r * pool.length)))];
  };
  /**
   * 候选池 = 排序后保留**前一半**（池子小于 5 个时不截，本来选择就少）。
   *
   * 实测 4 格档 11 个版式的 `minShort`（以页高为单位）：
   *   grid-2x2 .373 > grid-2x2-stag .340 > hero-left/right .300 > hero-top/bottom .249
   *   > band-top-inset .220 > band-mid-hero .200 > strip4-* .185
   * 保留前 6 = 切掉 **band-top-inset / band-mid-hero / strip4-plain(+figL/figR)**，
   * 也就是用户实拍里那三款「一排横条」。`mood='scenery'` 时排序反转，它们会回到池首。
   */
  const shore = (pool, exact) => {
    const ranked = rankLayouts(pool, opts.mood);
    /**
     * ★★★ v0.9.152：**逐格形状匹配排在「整页戏型」之前**。
     *
     * 粒度差别是这次的关键：
     *   · `rankLayouts(pool, mood)` 只知道「这一页偏亲密 / 偏动作」，是**整页**一级；
     *   · `shapeFitOf` 知道「第 1 条要横、第 3 条要竖、第 4 条要特写」，是**逐格**一级。
     * 用户的话说得很准：「A 适合横版就给个横版，B 适合竖给个竖，C 适合特写（刚好剧情需要）」。
     * 整页粗判会把「刚好 C 需要特写」这一格塞进横框 —— 就是这个毛病。
     *
     * 用排序而不是硬筛：硬筛会把候选池削薄，实测导致 4 页撞同一款版式。
     * 排序 + 后面那道「留前一半」自然让形状合适的进候选，又不会把池子掏空
     * （`sort` 在 ES2019 后稳定，同分保持 `mood` 的原顺序）。
     */
    const shapeShots = Array.isArray(opts.panelShots) ? opts.panelShots : [];
    const shapeRanked = shapeShots.length
      ? [...ranked]
        .map((l) => ({ l, s: shapeFitOf(l, shapeShots, opts.pageAspect).score }))
        .sort((a, b) => b.s - a.s)
        .map((x) => x.l)
      : ranked;
    if (opts.diag) {
      opts.diag.shapeBest = shapeShots.length ? shapeFitOf(shapeRanked[0], shapeShots, opts.pageAspect).score : 0;
    }
    /**
     * ★★★ v0.9.147：**只有调用方明确说要人物栏时**，才把带栏版式排到最前。
     *
     * 为什么需要这个开关（第一版写错，测试直接抓到）：带栏版式的格子天然窄
     * （`strip4-figR` 只有 0.43 页宽），几何排序会把它们压到队尾，截断后一个不剩 ——
     * 于是 `figure` 链路永远选不到出口。但反过来「只要池里有带栏的就排最前」也是错的：
     * 没有 figure 的普通页会因此**优先拿到最差的两款横条**。
     * ⇒ 判据必须是「这一页真的要那个页边站着的人」，由调用方给 `preferFigure`。
     */
    const list = (opts.preferFigure === true && !noFigure && pool.some((l) => l.figure))
      ? [...shapeRanked.filter((l) => l.figure), ...shapeRanked.filter((l) => !l.figure)]
      : shapeRanked;
    const keep = list.length >= 5 ? Math.max(3, Math.ceil(list.length / 2)) : list.length;
    const cut = list.slice(0, keep);
    /**
     * ★★★ v0.9.149：**几何底线是一道真门，不是排序参考**。
     *
     * 原来只有「按数量留前一半」，池子被别的筛子削薄时，横带款就会**递补**进候选。
     * 病例（真实草稿 P31，`mood=dialogue` + 空镜筛选之后）：`band-top-inset`（minShort .220）
     * 混了进来，200 次抽样里占 47 次 —— 那正是用户说的「一排横条」版式。
     *
     * 底线 **每格短边 ≥ 页高的 23%**（848×1136 下 ≈ 261px，够画一张半身 + 气泡），
     * 和 5 格档版式的几何注释是同一个口径。
     * 两个例外（它们要的就是扁格 / 窄栏，底线对它们不成立）：
     *   · `mood=scenery` —— 空镜页本来就该用横带；
     *   · `preferFigure` —— 通高人物栏的格子天然窄，那是设计代价不是失误。
     * 兜底：过门的不足 3 款时退回原截断（宁可出一张不完美的图，也不能选不出图）。
     */
    const FLOOR_SHORT = 0.23;
    const scenery = String(opts.mood || '').trim().toLowerCase() === 'scenery';
    const floorFree = scenery || opts.preferFigure === true;
    let base = cut;
    if (!floorFree) {
      const solid = cut.filter((l) => { const m = layoutMetrics(l); return m && m.minShort >= FLOOR_SHORT; });
      if (solid.length >= 3) base = solid;
      /**
       * ★★★ v0.9.154：**`cut` 里过底线的不足 3 款时，不许整池退回。**
       *
       * 病例（P35，`shots=environment|detail|upper|full`，mainBeat=4）：
       *   `shapeFitOf` 给 `strip4-plain` 打了 1.00（848×210 的横条把「空镜」伺候得最好，
       *   而 `detail`/`upper` 判中性不计分 ⇒ 那三格被迫变成 210 高的横条，**代价没被计入**）。
       *   于是形状排序把三款 `strip4-*` 全推到前面，`cut`（前一半）里几乎没有过底线的款
       *   ⇒ `solid.length < 3` ⇒ 退回 `cut` ⇒ 横带版式拿回控制权，出图就是「一排横条」。
       *   实测 300 次：strip4-* 合计 **73%**，唯一正确的 `hero-bottom-3` 只 28%。
       *
       * 改法：退回时**从形状排序后的全池里取过底线的款**（P35 有 8 款），
       * 既不让横带进来，也不会把池子掏空到只剩一款。
       * 兜底仍然保留在最外层（一款都没有时还是要出图，见 `pickMangaLayout` 的调用方）。
       */
      else {
        const solidAll = list.filter((l) => { const m = layoutMetrics(l); return m && m.minShort >= FLOOR_SHORT; });
        if (solidAll.length >= 3) base = solidAll;
      }
    }
    /**
     * ★★★ v0.9.149：**「主格命中」可以豁免上面的「留前一半」，但豁免不了这条几何底线。**
     *
     * 病例（真实草稿跑覆盖检查时发现）：4 格档按 `mood=intimate` 排序后，
     * `hero-mid-4`（唯一主格在第 3 格的版式，minShort .260）排第 7，**正好被截掉** ——
     * 于是 mainBeat=3 的页（9 页里占 4 页）永远只能拿到四格等大，命中率只有 43.9%，
     * 而且日志会逐页报「候选池里没有主格在这一条的版式」。机制在，版式被自己的筛子挡在门外。
     *
     * 注意 `strip4-*`(.185) / `band-mid-hero`(.200) 的「主格在末位」只是几何巧合，
     * 它们连底线都过不了，不该因此被放回来。
     */
    const resc = exact && Math.round(Number(opts.mainBeat) || 0) >= 1
      ? pool.filter((l) => ok(l)
        && mainBeatScore(l, opts.mainBeat) === 0
        && layoutMetrics(l).minShort >= FLOOR_SHORT
        && !base.includes(l))
      : [];
    const merged = resc.length ? [...base, ...resc] : base;
    /* 几何截断之后再处理空镜（顺序不能反，见 `sinkEmptyLayouts` 的病例）。 */
    const afterEmpty = scenery ? merged : sinkEmptyLayouts(merged, opts.panelShots);
    /**
     * ★★★ v0.9.152：**「这页剧情适合哪款版式」的第二条判据 —— 特写要竖框。**
     *
     * 第一条是空镜（`sinkEmptyLayouts`）。缺这一条的时候，一页 4 格剧情会配上
     * 一款「四格全横」的版式：格数够、形状不对，于是第 3 条「她呼吸一窒」的
     * 一张脸被塞进 1.67:1 的横框 —— 模型只能加手臂和肩背去铺满宽度，
     * 出图就是趴地托腮。用户管这叫「硬塞」，判据上就是这一条缺失。
     *
     * 与「降级」的分工（两层，缺一不可）：
     *   · 本函数 = **先尽量选对的**：池里有能装下脸的款，就只在它们里挑；
     *   · `buildMangaPage` 的 `FACE_FALLBACK` = 一款都没有时，把那一格降成半身，
     *     而不是逼模型把脸塞进扁框（`hero-mid-4` 四格全 ≥1.40 就属于这种页）。
     *
     * 兜底顺序照旧（`good.length ? good : arr`）：宁可出一张形状不完美的图，
     * 也不能让这一页选不出图 —— 与 `sinkEmptyLayouts` 同一个口径。
     */
    const fitFace = (arr) => {
      const shots = Array.isArray(opts.panelShots) ? opts.panelShots : [];
      const hasFace = shots.some((s) => String(s || '').trim().toLowerCase() === 'face');
      if (!hasFace || !arr.length) return arr;
      const good = arr.filter((l) => faceFitOf(l, shots, opts.pageAspect).ok);
      if (opts.diag) opts.diag.facePoolSize = good.length;
      return good.length ? good : arr;
    };
    const afterFace = fitFace(afterEmpty);
    /**
     * ★★★ v0.9.150：把「池里到底有没有主格命中款」**如实吐给调用方**。
     *
     * 病例（真实草稿 P24 实测暴露）：日志写「候选池里没有主格在这一条的版式」，
     * 而这句是 `buildMangaPage` **假设**的 —— 实际池里有 `hero-mid-4`（300 次抽样占 92 次），
     * 只是 `preferMainBeat` 三级回落把四格等大并了进来，抽到了 `grid-2x2`。
     * 一句假设性文案会让人把「这次抽到别的」误判成「库里没这款」，然后去库里瞎加版式。
     * ⇒ 判据必须由结果给出：`bestSize` 是**本次真实可用池**里命中款的个数。
     */
    if (opts.diag && exact) {
      opts.diag.poolSize = afterFace.length;
      opts.diag.bestSize = afterFace.filter((l) => mainBeatScore(l, opts.mainBeat) === 0).length;
    }
    /**
     * ★★★ v0.9.149：最后才按「主格落在第几条」筛（`preferMainBeat` 的三级回落）。
     * 顺序：几何（画得下）→ 空镜（别把半页给空房间）→ 主格位置 → **特写竖框（软门）**。
     * 只在**格数正好等于情节条数**时启用 —— 走「取大档」兜底时条数与格子不再一一对应。
     */
    const mainFinal = exact ? preferMainBeat(afterFace, opts.mainBeat, opts.strictBeat === true) : afterFace;
    /**
     * ★★★ v0.9.152：**「这页剧情适合哪款版式」的第二条判据 —— 特写要竖框。**
     *
     * 用户 2026-10-29 04:11 的原话：
     *   「剧情提示词只适合某板式那就选用这个版式不就行了？为啥非要强行用不合适的板式，
     *     然后还恰到好处把这 1 小格剧情硬塞到不适合的版式格里？这个横版特写不就是典型例子吗？」
     *
     * 缺这一条时，一页 4 格剧情会配上「四格全横」的版式：格数够、形状不对，
     * 第 3 条「她呼吸一窒」的一张脸被塞进 1.67:1 的横框 ⇒ 模型加手臂肩背铺满 ⇒ 趴地托腮。
     *
     * ★ 为什么是**软门**（`hitFit >= hitAll` 才收缩），不是硬门 —— 硬门版本实测代价：
     *   真实草稿 9 页里 5 页带 `face` 格，硬门把 4 格档削到只剩「四格等大」那一系，
     *   **4 页同时落到 `grid-2x2`**，主格命中从 6 掉到 4。
     *   两害相权：主次（哪个格子大）丢了整页就看不出重点；特写丢了只是那一格降成半身，戏还在。
     *   所以不能让「特写合适」压过「主格命中」—— 判据是「收缩后主格命中款不许变少」。
     *   变少就用原池，由 `buildMangaPage` 的 `FACE_FALLBACK` 把那一格降成半身
     *   （`hero-mid-4` 四格全 ≥1.40 就属于这种页：它是唯一主格在第 3 格的款，筛掉它 mainBeat 直接失效）。
     */
    let finalPool = mainFinal;
    if (opts.diag) { opts.diag.faceFitSize = 0; opts.diag.faceFitApplied = false; }
    const shotsNow = Array.isArray(opts.panelShots) ? opts.panelShots : [];
    if (shotsNow.some((s) => String(s || '').trim().toLowerCase() === 'face') && finalPool.length) {
      const fit = finalPool.filter((l) => faceFitOf(l, shotsNow, opts.pageAspect).ok);
      const k = Math.round(Number(opts.mainBeat) || 0);
      const hitAll = k >= 1 ? finalPool.filter((l) => mainBeatScore(l, k) === 0).length : 0;
      const hitFit = k >= 1 ? fit.filter((l) => mainBeatScore(l, k) === 0).length : 0;
      if (opts.diag) opts.diag.faceFitSize = fit.length;
      if (fit.length && hitFit >= hitAll) {
        finalPool = fit;
        if (opts.diag) opts.diag.faceFitApplied = true;
      }
    }
    if (opts.diag && exact) {
      opts.diag.poolSize = finalPool.length;
      opts.diag.bestSize = finalPool.filter((l) => mainBeatScore(l, opts.mainBeat) === 0).length;
    }
    return finalPool;
  };
  /**
   * ★★★ v0.9.156：`noFigure` 必须在**候选池入口**就过掉，不能留到最后抽签那一步。
   *
   * 病例（3 格档，`dev_tmp/_panel3_run.mjs` 代写出图时暴露）：
   *   一页三条全是人物格 `face/response/upper` ⇒ `noFigure=true`（草稿没有 figure）。
   *   旧写法 `pool` 不筛 `noFigure`，于是：
   *     ① 4 款 3 格版式全进池（含 `strip3-figL/figR` 两款带栏的）；
   *     ② `fitFace` 只认「不扁的小格」——带栏款的窄栏 367×326 正好合格，
   *        无栏的两款（`strip3-plain` 833×326 asp 2.49、`hero-top-2` 833×621 面积 0.56）
   *        全被判死 ⇒ 池子收缩成 **只剩这两款带栏的**；
   *     ③ 最后 `pickFrom` 才 `.filter(ok)`，把它们俩一起删掉 ⇒ **候选池空 ⇒ 整页不出图**。
   *   实测 300 次全部返回 null（不是偶发）。
   *
   * 判据：一个筛子如果在前面所有过滤之后才生效，它就会把「唯一幸存者」全部作废。
   *   ⇒ 入口筛掉，后续每一道门看到的池子都和最终抽签的口径一致。
   */
  const pool = (BY_PANELS.get(want) || []).filter(ok);
  if (!pool.length) {
    /* 没正好这个格数 → 取「不小于 want 的最小档」，多出来的格由调用方合并 */
    const bigger = mangaPanelCounts().filter((c) => c > want);
    if (!bigger.length) return null;
    return pickFrom(shore((BY_PANELS.get(bigger[0]) || []).filter(ok), false));
  }
  return pickFrom(shore(pool, true));
}

/**
 * 阅读顺序的**声明表**（v0.9.141）。
 *
 * ★ 为什么不能像旧版那样按 `family` 一句话套所有版式：
 *   旧代码是 `family==='strip' ? 'top down' : 'left to right, then top to bottom'`，
 *   而 `grid-2x2-stag` 是**错位网格**，它的列不等高（左列 0.34/0.65，右列 0.64/0.35），
 *   按行读会把「左下」和「右上」的先后判反 —— 用户看到的剧情顺序就和模型写的顺序不一致。
 *   错位网格的正确读法是**列优先**：左列从上到下，再右列从上到下。
 *
 * 三种读法（这也是漫画本身的三种读法，见 `[K]` 段测试）：
 *   · `down` — 单列，从上到下（条漫 / 竖排窄格）
 *   · `rows` — 左到右，再上到下（页漫的 Z 形，中文横排正文用这个）
 *   · `cols` — 列优先（错位网格专用）
 */
const READ_OVERRIDE = {
  'grid-2x2-stag': 'cols',
  'hero-left-3': 'left-big',
  'hero-right-3': 'right-big',
};

/** 这个版式按什么顺序读。 */
export function mangaReadOrder(lay) {
  const l = lay || {};
  const id = String(l.id || '');
  if (READ_OVERRIDE[id]) return READ_OVERRIDE[id];
  if (l.family === 'strip') return 'down';
  return 'rows';
}

const ORDINALS = ['first', 'second', 'third', 'fourth', 'fifth', 'sixth', 'seventh', 'eighth', 'ninth', 'tenth'];
const ordOf = (k) => ORDINALS[k] || ('number ' + (k + 1));

/**
 * 这一格在页面上「长什么样、在哪」—— 给每格 caption 的语义锚点。
 *
 * ★★★ v0.9.141 病例（第一楼 page08，`strip4-plain`）：
 *   bbox 是四条**全宽横带**上下堆叠（yxyx 里 y 变化、x 满宽），几何完全正确；
 *   但 bg caption 只写「panel 3, background layer filling this panel only: ...」，
 *   **模型完全不知道这一格是长横条** → 拿「4 格漫画」的先验画成 2×2 + 右侧一条竖窄条。
 *   ⇒ 结论：**几何正确但语义缺失时，模型会用自己的先验覆盖几何**。
 *     坐标算得再准也没用，必须在 caption 里把「形状 + 第几条」说成人话。
 *
 * 判据全部从 `frames` 几何现算（不读版式 id / family），所以新版式自动适用。
 *
 * @param {number[][]} frames 0~1 · 左上原点 · xyxy 数组
 * @param {number} i 第几格（0 起）
 * @returns {string} 一句英文（空数组时返回 ''）
 */
export function panelWhere(frames, i) {
  const fs = Array.isArray(frames) ? frames : [];
  const n = fs.length;
  if (!n) return '';
  const f = fs[Math.max(0, Math.min(n - 1, i))];
  const w = f[2] - f[0];
  const h = f[3] - f[1];
  /**
   * ★ 判「整页是不是横带堆叠」要看**全部格**，不能只看这一格。
   *   反面病例：`hero-top-3` 的第 1 格是全宽大格（1 × 0.5），只看自己会被判成横带，
   *   于是说出「邻居在上下」—— 而它下面还有一整排 3 格，说错了模型就照错画。
   */
  const allWide = fs.every((g) => (g[2] - g[0]) >= 0.9);
  const allTall = fs.every((g) => (g[3] - g[1]) >= 0.9);
  /**
   * ★ 只留「不要改形状」——「不可切分」由 bg caption 尾句负责说。
   *   同一件事说两遍会稀释权重（两个分句抢同一个指令位）。
   */
  const noSplit = ' Keep to exactly this footprint.';

  /* ① 全宽横带（strip 家族）：上下堆叠，窄而宽 */
  if (allWide && !allTall) {
    const head = n >= 2
      ? 'This panel is the ' + ordOf(i) + ' of ' + n + ' full-width horizontal bands stacked down the page'
      : 'This panel is a full-width horizontal band';
    return head + ': it spans the entire width and is only a slice of the page height,'
      + ' so it is a wide low band — not a square and not a vertical strip.'
      + ' Nothing sits to its left or right; the neighbouring panels are directly above and below it.' + noSplit;
  }

  /* ② 全高竖条：并排，窄而高 */
  if (allTall && !allWide) {
    const head = n >= 2
      ? 'This panel is the ' + ordOf(i) + ' of ' + n + ' full-height vertical strips standing side by side'
      : 'This panel is a full-height vertical strip';
    return head + ': it runs the entire page height and is only a slice of the page width,'
      + ' so it is a tall narrow strip — not a square and not a horizontal band.'
      + ' Nothing sits above or below it; the neighbouring panels are directly to its left and right.' + noSplit;
  }

  /* ②b 单列多格（`strip*-figR/figL`：一竖列窄条 + 另一侧通高人物）—— 实测最稳的版式 */
  const sameCol = fs
    .filter((g) => Math.abs(g[0] - f[0]) < 0.02 && Math.abs(g[2] - f[2]) < 0.02)
    .sort((a, b) => a[1] - b[1]);
  if (sameCol.length >= 3) {
    const k = sameCol.indexOf(f);
    const side = (f[0] + f[2]) / 2 < 0.5 ? 'left' : 'right';
    return 'This panel is the ' + ordOf(k < 0 ? 0 : k) + ' of ' + sameCol.length
      + ' narrow panels stacked in a single vertical column on the ' + side + ' side of the page.'
      + ' It is ' + Math.round(w * 100) + '% of the page width and ' + Math.round(h * 100) + '% of the height,'
      + ' so it is a narrow band — the panels above and below it are in the same column,'
      + ' and nothing of them may spill into this one.' + noSplit;
  }

  /* ③ 网格 / 一大几小：按面积和位置说话 */
  const cx = (f[0] + f[2]) / 2;
  const cy = (f[1] + f[3]) / 2;
  const area = w * h;
  const maxArea = Math.max.apply(null, fs.map((g) => (g[2] - g[0]) * (g[3] - g[1])));
  const posX = cx < 0.34 ? 'left' : (cx > 0.66 ? 'right' : 'centre');
  const posY = cy < 0.34 ? 'top' : (cy > 0.66 ? 'bottom' : 'middle');
  let size = '';
  /**
   * ★ 只在「最大格」上说一句「这是本页最大的格子」。
   *   反面教训：旧版还写了「小格 ⇒ 近景」，但版面小不代表该画近景
   *   （`strip*-figR` 左列每格都是 45%×18% 的窄条，画近景就错了）——
   *   景别由该格的 `shot` 决定，这里只说几何事实。
   *
   * ★★★ v0.9.151：**「so it carries the widest view」删掉了。**
   * 病例（真实出图，催眠APP P24 中间大格 833×494）：这句在暗示「大格 = 宽幅场景」，
   * 而那一格的 shot 是 `face`（只画头颈）。两条指令相反，模型选了宽的那条，
   * 于是把一张竖着的脸加手加肩背铺满 1.69 倍宽的框，画出「趴地托腮」。
   * 用户原话：「有时候裁掉总比全体崩要好吧？」
   * 出图验证（`dev_tmp/framing150/`）：只把 face 措辞改成「允许被裁」还不够（v5 手肩背都在），
   * **再删掉这一句（v6）才干净** —— 尺寸百分比已经说清多大了，不需要再暗示构图方式。
   */
  if (area >= maxArea - 1e-9 && maxArea > 0) {
    size = ' It is the largest panel on this page.';
  }
  return 'This panel sits in the ' + posY + '-' + posX + ' area of the page and covers about '
    + Math.round(w * 100) + '% of the width and ' + Math.round(h * 100) + '% of the height.' + size
    + ' Its neighbours are laid out around it — nothing of them may spill into this area.' + noSplit;
}

/** 读法的英文句子（进 summary，只陈述结构事实）。 */
const READ_PHRASE = {
  down: 'from the top panel down to the bottom panel',
  rows: 'from the top left panel, left to right, then top to bottom',
  cols: 'down the left column first, then down the right column',
  'left-big': 'starting with the tall panel on the left, then the three narrow panels on the right from top to bottom',
  'right-big': 'starting with the tall panel on the right, then the three narrow panels on the left from top to bottom',
};

/**
 * 版式的一句话说明（进 summary.caption 与日志）。
 * ★ 只描述**结构事实**（几格、怎么读、有没有跨格人物），不描述内容 ——
 *   内容由每格的 caption 负责，summary 里复述内容会稀释每格权重。
 */
export function mangaLayoutBrief(lay, figureName) {
  const l = lay || {};
  const frames = Array.isArray(l.frames) ? l.frames : [];
  if (!frames.length) return '';
  const order = READ_PHRASE[mangaReadOrder(l)] || READ_PHRASE.rows;
  const fig = l.figure
    ? ' A single page-tall foreground figure' + (figureName ? ' of ' + figureName : '')
      + ' occupies the right-hand column, crossing in front of the panel edges'
      + ' and hiding only the seams behind it; it is a foreground cutout, not an extra panel.'
    : '';
  return 'The page is divided into ' + frames.length + ' panels; read them ' + order + '.' + fig;
}

/**
 * 版式的**文字版**（给用户的「这页是怎么排的」日志，以及测试断言用）。
 * 不参与出图。
 */
export function describeMangaLayout(lay) {
  const l = lay || {};
  const frames = Array.isArray(l.frames) ? l.frames : [];
  const pct = (v) => (Math.round(v * 1000) / 10 + '%');
  const lines = [`版式 ${l.id || '?'}（${l.family || '?'} · ${frames.length} 格）${l.note || ''}`];
  frames.forEach((f, i) => {
    lines.push(`  格${i + 1}  x ${pct(f[0])}~${pct(f[2])}  y ${pct(f[1])}~${pct(f[3])}`
      + `  （${pct(f[2] - f[0])} x ${pct(f[3] - f[1])}）`);
  });
  if (l.figure) lines.push(`  通高人物  x ${pct(l.figure.x0)}~${pct(l.figure.x1)}  y 0%~100%`);
  return lines.join('\n');
}
