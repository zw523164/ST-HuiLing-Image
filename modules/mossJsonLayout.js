import { estimateResolution } from './resSelector.js';
import { getPickedLayout, fallbackLayoutFor, normalizeMossEnhance, normalizeMossCover } from './mossLayout.js';
import { ENH_TEXT, RE_HAS_SLANT, dropTailDot } from './mossEnhanceText.js';

/**
 * MOSS JSON Layout —— 坐标编译与校验（v0.9.121）。
 *
 * 为什么要有这个模块：
 *   MOSS 官方支持的 Layout 格式，**成稿要求是「中心化绝对像素 + yxyx 顺序」**
 *   （`bbox_coord_space="abs_centralized"` / `bbox_format="yxyx"`，且根字段不含 width/height）。
 *   而出词模型按「左上角原点 + xyxy」思考最自然 —— 让它自己做「减半宽半高 + 换顺序」的算术，
 *   每项错一处就整张图偏位。官方模板 §12.3 的原话就是：
 *     「有小数边时，先对左/上边向下取整、右/下边向上取整，再减画布中心并改为 yxyx。
 *      **优先使用官方编译器或计算工具完成机械转换；逐项检查结果，不凭目测估算。**」
 *   ⇒ 所以本模块就扮演那个「编译器」：模型只给草稿，机械转换由代码做，代码不会算错。
 *
 * 依据（`MOSS酒馆生图模型/提示词模版/MOSS二次元提示词模板_sfw版.md`）：
 *   · §12.2 `label` 只能是 character / object / text；禁止 panels / panel_id / children / style / id
 *   · §12.3 最终根字段仅 summary / items / bbox_coord_space / bbox_format，一行紧凑 JSON
 *   · §12.4 `summary.canvas` 取 single / multi_panel / collage；多格的格框用 object 表示每格可见背景
 *   · §12 坑表「草稿写 0.1–0.9」→ 归一化坐标会被当成不到一像素的实际数值（必须拦）
 */

/** @returns {{width:number, height:number}} 当前生效的画布尺寸。 */
export function canvasOf(be) {
  const b = be || {};
  let W = 0; let H = 0;
  try {
    if (b.resSelector?.enabled !== false) {
      const r = estimateResolution(b.resSelector?.aspect, b.resSelector?.megapixels, b.resSelector?.multiple);
      W = r.width; H = r.height;
    } else {
      W = Number(b.width) || 0; H = Number(b.height) || 0;
    }
  } catch { /* 落到默认 */ }
  /**
   * ★ v0.9.159：回落值不再写死 `864×1152`。
   *
   * 那个常数是 v0.9.121 凭「3:4 / 1MP / 8 倍」手算的，而当时算错了（用了 1e6 而不是 1024²）。
   * 写死常数等于把错误固化 —— 现在改成**同一套默认参数现算**，
   * 与 `estimateResolution` 永远同源（记忆：「算」与「比」必须是同一份数据）。
   */
  if (!W || !H) { const r = estimateResolution(); W = r.width; H = r.height; }
  return { width: Math.round(W), height: Math.round(H) };
}

export const LAYOUT_LABELS = ['character', 'object', 'text'];
export const LAYOUT_CANVAS = ['single', 'multi_panel', 'collage'];

/** 草稿/成稿里允许出现的根字段（其余一律丢弃 —— 官方 schema 不接受多余字段）。 */
const ROOT_KEEP = ['summary', 'items'];

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : NaN);

/**
 * 从模型输出里取 Layout 对象。
 * 模型可能给：① `images[].layout` 嵌套对象（推荐）② `images[].tag` 里塞 JSON 文本。
 * @returns {{ok:boolean, layout?:object, err?:string}}
 */
export function pickLayout(image) {
  const direct = image?.layout;
  if (direct && typeof direct === 'object' && !Array.isArray(direct)) return { ok: true, layout: direct };
  const raw = String(image?.tag || '').trim();
  if (!raw) return { ok: false, err: '既没有 layout 对象，tag 也是空的' };
  const a = raw.indexOf('{');
  const b = raw.lastIndexOf('}');
  if (a < 0 || b <= a) return { ok: false, err: 'tag 里找不到 JSON 对象' };
  try {
    const v = JSON.parse(raw.slice(a, b + 1));
    if (!v || typeof v !== 'object' || Array.isArray(v)) return { ok: false, err: 'tag 里的 JSON 不是对象' };
    return { ok: true, layout: v };
  } catch (e) {
    return { ok: false, err: `tag 里的 JSON 解析失败：${e.message}` };
  }
}

/**
 * 一个 bbox 是不是「归一化坐标」（全部落在 0~1 之间）。
 *
 * ★ 这是官方坑表里的一条：模型爱写 `[0.1, 0.05, 0.9, 0.45]`，
 *   官方会把它当成「不到一像素的实际数值」→ 所有东西挤在画布中心一小块。
 *   必须在编译前拦下来，否则出图结果是「一格小图漂在大白底上」。
 */
function looksNormalized(b) {
  return b.every((v) => v >= 0 && v <= 1.001) && b.some((v) => v > 0 && v < 1);
}

/**
 * 把一个 bbox 规范化成**草稿口径**（左上原点 abs + xyxy，整数）。
 * @returns {{ok:boolean, box?:number[], err?:string}}
 */
function toDraftBox(bbox, space, format, W, H) {
  if (!Array.isArray(bbox) || bbox.length !== 4) return { ok: false, err: `bbox 不是 4 个数：${JSON.stringify(bbox)}` };
  const v = bbox.map(num);
  if (v.some((x) => !Number.isFinite(x))) return { ok: false, err: `bbox 含非数字：${JSON.stringify(bbox)}` };
  if (looksNormalized(v)) return { ok: false, err: `bbox 像是归一化坐标（0~1）：${JSON.stringify(bbox)} —— 必须写真实像素` };

  /**
   * 判「模型给的是草稿还是成稿」必须看**它自己声明的那两个字段**，
   * 不能按位置猜 —— 两套格式的坐标顺序和原点都不一样（官方坑表：
   * 「直接把 xyxy 草稿标成 yxyx → 坐标顺序和原点不一致」）。
   */
  if (format === 'yxyx' || space === 'abs_centralized') {
    // 成稿：中心化 + yxyx → 还原成左上原点 + xyxy
    const [cy0, cx0, cy1, cx1] = v;
    return { ok: true, box: [cx0 + W / 2, cy0 + H / 2, cx1 + W / 2, cy1 + H / 2] };
  }
  // 草稿：左上原点 + xyxy
  const [x0, y0, x1, y1] = v;
  return { ok: true, box: [x0, y0, x1, y1] };
}

/** 从 summary.caption 里数格数（"a vertical two-panel page" → 2）。拿不到返回 0。
 *
 * ★ v0.9.125 修正：旧正则只认 `two panels` / `two-panel`，
 *   **不认 `Three stacked panels`** —— 而后者正是模型实际最爱写的形态
 *   （楼 144 三张全是这个措辞），于是「声明与几何对齐」整条逻辑从未触发过。
 *   这里允许数字与 `panels` 之间夹一个版式形容词（白名单，避免误吃
 *   `exactly two people in this panel` 这类人数句）。
 */
function panelCountFromCaption(cap) {
  const ADJ = '(?:stacked|vertical|horizontal|equal|unequal|wide|narrow|tight|large|small|comic|manga)';
  const m = new RegExp(`(two|three|four|five|\\d+)[\\s-]+(?:${ADJ}[\\s-]+)*panels?\\b`, 'i').exec(String(cap || ''));
  if (!m) return 0;
  const words = { two: 2, three: 3, four: 4, five: 5 };
  return words[String(m[1]).toLowerCase()] || (Number(m[1]) || 0);
}

/** 版式的归一化 rect `[x0,y0,x1,y1]`(0~1) → 中心化 yxyx 像素框（与成稿坐标系一致）。 */
function slotToCenteredBox(rect, W, H) {
  const H2 = H / 2;
  const W2 = W / 2;
  const x0 = Math.round(Number(rect[0]) * W);
  const y0 = Math.round(Number(rect[1]) * H);
  const x1 = Math.round(Number(rect[2]) * W);
  const y1 = Math.round(Number(rect[3]) * H);
  return [
    Math.round(y0 - H2), Math.round(x0 - W2),
    Math.round(y1 - H2), Math.round(x1 - W2),
  ];
}

/** 中心化 yxyx 框的面积（用于「谁的格子更大」的配对，正负号无关）。 */
function boxArea(b) {
  return Math.abs(b[2] - b[0]) * Math.abs(b[3] - b[1]);
}

/**
 * 缺格兜底用的**具体室物清单** —— 按这一格该承担的景别挑一套。
 *
 * ★★★ 为什么必须写具体物体（2026-10-23 实测）：
 *   `medium shot of the same room and the same light, empty of people` 只给抽象关系、
 *   **没有具体物体** ⇒ 模型没东西可画，就从相邻格搬人进来，两格全画成人体局部（`jpad`）。
 *   换成室物清单才空得住（`jroom` 两张都真空）。加不加 `Nobody is in this panel` 结果一样
 *   ⇒ 关键是有没有具体物体，不是肯定/否定（cfg≈1 下否定句本来就弱）。
 */
const ROOM_PROPS = {
  far: ENH_TEXT.padPropsFar,
  detail: ENH_TEXT.padPropsDetail,
  near: ENH_TEXT.padPropsNear,
  medium: ENH_TEXT.padPropsMedium,
};

/**
 * 机位句 —— **只用实测有效的那几句**（`ab_pose/08_景别与机位.png`，10 张对照）。
 * 抽象景别词（`wide shot` / `close-up` / `from above`）全部无效，必须写「镜头在哪 + 画面里有什么」。
 */
const ANGLE_SENTENCES = {
  far: ENH_TEXT.padAngleFar,
  low: ENH_TEXT.padAngleLow,
  side: ENH_TEXT.padAngleSide,
};

/** 这一格该承担什么景别（读版式的 `slot.shot`）。 */
function roomKindOf(slot) {
  const shot = String((slot && slot.shot) || '');
  if (/空镜|远景/.test(shot)) return 'far';
  if (/特写/.test(shot)) return 'detail';
  if (/近景/.test(shot)) return 'near';
  return 'medium';
}

/**
 * 补格的 caption。
 *
 * @param {object} slot  版式的这一格
 * @param {number} panelNo 真实格号
 * @param {'empty'|'angle'} [pad]
 *   - `angle`（默认）：室物清单 + **机位句** —— 同一空间换一个角度，画面不单调
 *   - `empty`：只给室物清单（不提机位，最保守）
 */
function emptyPanelCaption(slot, panelNo, pad) {
  const kind = roomKindOf(slot);
  const props = ROOM_PROPS[kind];
  if (pad === 'empty') return `Panel ${panelNo}: ${props}, ${ENH_TEXT.padNoPeople}.`;
  const angle = ANGLE_SENTENCES[kind === 'far' ? 'far' : kind === 'detail' ? 'low' : 'side'];
  return `Panel ${panelNo}: ${angle}, ${props}, ${ENH_TEXT.padNoPeople}.`;
}

/** caption 开头的 `Panel N:` 换成真实格号（坐标换了位置，编号必须跟着换）。 */
function renumberCaption(cap, panelNo) {
  const s = String(cap || '');
  if (new RegExp('^\\s*Panel\\s*' + panelNo + '\\s*[:：]', 'i').test(s)) return s;
  const m = /^\s*Panel\s*\d+\s*[:：]\s*/i.exec(s);
  if (m) return 'Panel ' + panelNo + ': ' + s.slice(m[0].length);
  return 'Panel ' + panelNo + ': ' + s;
}

/**
 * 两个中心化 yxyx 框的重叠面积（无重叠返回 0）。判「这个人物属于哪一格」用。
 */
function overlapBoxArea(a, b) {
  const ay0 = Math.min(a[0], a[2]); const ay1 = Math.max(a[0], a[2]);
  const ax0 = Math.min(a[1], a[3]); const ax1 = Math.max(a[1], a[3]);
  const by0 = Math.min(b[0], b[2]); const by1 = Math.max(b[0], b[2]);
  const bx0 = Math.min(b[1], b[3]); const bx1 = Math.max(b[1], b[3]);
  const h = Math.min(ay1, by1) - Math.max(ay0, by0);
  const w = Math.min(ax1, bx1) - Math.max(ax0, bx0);
  return h > 0 && w > 0 ? h * w : 0;
}

/** 把框按「旧格 → 新格」线性映射：保持它在格内的相对位置与相对大小。 */
function mapBoxLinear(b, oldBox, newBox) {
  const map = (v, o0, o1, n0, n1) => {
    const span = o1 - o0;
    if (!Number.isFinite(span) || Math.abs(span) < 1e-6) return n0;
    return n0 + ((v - o0) / span) * (n1 - n0);
  };
  return [
    map(b[0], oldBox[0], oldBox[2], newBox[0], newBox[2]),
    map(b[1], oldBox[1], oldBox[3], newBox[1], newBox[3]),
    map(b[2], oldBox[0], oldBox[2], newBox[0], newBox[2]),
    map(b[3], oldBox[1], oldBox[3], newBox[1], newBox[3]),
  ];
}

/** 夹回新格内，并保证至少 1px（零面积会被下游当错误报掉）。同时归一化成 y0<y1 / x0<x1。 */
function clampBoxInto(b, box) {
  const y0 = Math.min(box[0], box[2]); const y1 = Math.max(box[0], box[2]);
  const x0 = Math.min(box[1], box[3]); const x1 = Math.max(box[1], box[3]);
  const cy0 = Math.max(y0, Math.min(y1 - 1, Math.round(Math.min(b[0], b[2]))));
  const cy1 = Math.min(y1, Math.max(cy0 + 1, Math.round(Math.max(b[0], b[2]))));
  const cx0 = Math.max(x0, Math.min(x1 - 1, Math.round(Math.min(b[1], b[3]))));
  const cx1 = Math.min(x1, Math.max(cx0 + 1, Math.round(Math.max(b[1], b[3]))));
  return [cy0, cx0, cy1, cx1];
}

/**
 * ★★★ v0.9.138：**格子被强制对齐时，格里的成员（character / text）必须跟着一起搬**。
 *
 * 病例（用户 2026-10-27，楼 11 端到端真实出图）：
 *   模型给的是「4 竖条」布局（左窄全高 / 左中 / 右中 / 右宽全高），
 *   本次版式是 `p4-unequal`（上扁条 + 中二 + 下大）。`enforceLayoutGeometry`
 *   把 4 个 object 的 bbox **全部换成正版式坐标，character 却留在原地**
 *   → 人物框掉到新格线外面 → 底部大格渲染成一张**纯空房间**。
 *   而统计还报 `emptyPanels = 0`（那句只在 caption 里找 `no people`），是假绿。
 *
 * 楼 5 没崩只是因为模型那次给的就是横排布局，与 `p4-unequal` 巧合一致 ——
 * 换句话说这是**系统性 bug**，出不出问题全看模型这次写的布局碰不碰巧对。
 *
 * 判据：按「重叠面积 / 旧格面积」取比例最高的那一格（不用「完全包含」——
 *   模型常把人物框写溢出到邻格，楼 11 就有两项越界）。
 * 搬法：线性仿射，保持人物在该格内的相对位置与相对大小。
 */
function remapPanelMembers(items, pairs) {
  if (!pairs.length) return 0;
  let moved = 0;
  for (const it of items) {
    if (it.label === 'object') continue;
    const b = it.bbox;
    if (!Array.isArray(b) || b.length !== 4) continue;
    let best = null; let bestScore = 0;
    for (const p of pairs) {
      const a = overlapBoxArea(b, p.old);
      if (a <= 0) continue;
      const score = a / Math.max(1, boxArea(p.old));
      if (score > bestScore) { bestScore = score; best = p; }
    }
    // 一项都不在任何旧格里 → 原文本就不合法，交给后面既有的「不在任何一格之内」校验报
    if (!best) continue;
    it.bbox = clampBoxInto(mapBoxLinear(b, best.old, best.next), best.next);
    moved += 1;
  }
  return moved;
}

/**
 * ★★★ v0.9.139：**把格子之间的缝收窄**（剧情演完模式专用）。
 *
 * 实测（2026-10-27，`dev_tmp/border_ab/`，同一份 layout、同 seed，只改一个变量）：
 *   | 组 | 改动 | 出图 |
 *   |---|---|---|
 *   | A | 现状（caption 有 `framed by a thick black panel border` + 斜切） | **没有黑框**，51px 宽白色发光带 |
 *   | B | 去掉斜切 | 还是没有黑框 |
 *   | C | 边框换成 `enclosed on all four sides by a heavy solid black ink frame line, high contrast` | **还是没有** |
 *   | D | 去掉斜切 + 把格间空白从 0.04 收到 0.012（≈15px） | **出现细黑分隔线，像漫画了** |
 *
 * ⇒ 结论：MOSS **不按 caption 里的 border 句画黑框**；它把「格子之间的空白」当画面内容来画 ——
 *   空白宽就画成一条白色发光带，空白窄才画成深色分隔线。
 *   ★ 这条推翻了 v0.9.136「写进每格 object 的 caption 才出黑框」的结论（至少在当前模型 + 工作流下不成立）。
 *
 * 做法：只**向外扩张 object**，不动 character（格子变大，人物仍然在格内，安全）。
 * 只对 coverMode 生效 —— 其他口径的格子间隙保持原样。
 */
function closePanelGutters(items, W, H, gapPx) {
  const objs = items.filter((x) => x.label === 'object');
  if (objs.length < 2) return 0;
  const half = gapPx / 2;
  /**
   * 只处理**真正的近邻**：间隙超过画布 12% 的那是「对角两格」（左上 + 右下），
   * 它们本来就不该接壤 —— 强行拉近会把版面拉散。
   */
  const maxGapY = Math.max(gapPx * 4, Math.round(H * 0.12));
  const maxGapX = Math.max(gapPx * 4, Math.round(W * 0.12));
  const edits = [];
  for (const a of objs) {
    for (const b of objs) {
      if (a === b) continue;
      // y 方向：a 在上、b 在下，且 x 区间有重叠
      const ox = Math.min(a.bbox[3], b.bbox[3]) - Math.max(a.bbox[1], b.bbox[1]);
      if (ox > 0) {
        const gap = b.bbox[0] - a.bbox[2];
        if (gap > gapPx && gap <= maxGapY) {
          const mid = (a.bbox[2] + b.bbox[0]) / 2;
          edits.push([a, 2, Math.round(mid - half)]);
          edits.push([b, 0, Math.round(mid + half)]);
        }
      }
      // x 方向：a 在左、b 在右，且 y 区间有重叠
      const oy = Math.min(a.bbox[2], b.bbox[2]) - Math.max(a.bbox[0], b.bbox[0]);
      if (oy > 0) {
        const gap = b.bbox[1] - a.bbox[3];
        if (gap > gapPx && gap <= maxGapX) {
          const mid = (a.bbox[3] + b.bbox[1]) / 2;
          edits.push([a, 3, Math.round(mid - half)]);
          edits.push([b, 1, Math.round(mid + half)]);
        }
      }
    }
  }
  /** 同一格可能被多对邻居改同一条边 —— 取最靠近中线的那个（最保守，不会把格子扩到别人身上）。 */
  const best = new Map();
  for (const [it, idx, v] of edits) {
    const key = objs.indexOf(it) + '|' + idx;   // ★ 用对象身份，不用 caption（caption 会重复）
    const prev = best.get(key);
    if (prev === undefined) { best.set(key, v); continue; }
    // idx 0/1 是「左上边」：取更大值（更靠中线）；idx 2/3 是「右下边」：取更小值
    best.set(key, idx <= 1 ? Math.max(prev, v) : Math.min(prev, v));
  }
  let n = 0;
  objs.forEach((it, i) => {
    let touched = false;
    for (const idx of [0, 1, 2, 3]) {
      const v = best.get(i + '|' + idx);
      if (v === undefined) continue;
      it.bbox[idx] = v;
      touched = true;
    }
    if (touched) n += 1;
  });
  return n;
}

/**
 * ★★★ v0.9.130：**把版面强制成版式的形状**。
 *
 * 病例（用户 2026-10-22「完全不像漫画分镜」，楼 174 / 172 全部命中）：
 *   指令里已经按本次画布算好不等分三格（实测 `[0,0,415,300]` / `[449,0,864,300]` / `[0,346,864,1152]`），
 *   并明确写「坐标照抄」，模型却回了 `[0,0,864,645]` 一个全宽大格。
 *   旧编译层**完全信任**模型给的 bbox → 版面不是我选的那套；
 *   接着旧的 `padPanelObjects` 按「空白处平分」补出两条全宽横条 + 同视角文案
 *   → 三格内容一模一样，而且几何上根本不是漫画版面。
 *
 * 做法：按**面积从大到小**把模型的 object 与版式的 slot 一一配对。
 *   - 为什么按面积而不是按顺序：模型把最多内容写在最大的格子里（「wide main panel」），
 *     那个意图要保留 —— 它应该落到版式里最大的那一格，而不是被塞进顶部小格。
 *   - 数量不够 → 用版式剩下的 slot 补**空镜**（明确 `empty of people`）。
 *   - 数量多出来 → 不动（宁可留一个不合版式的格，也不丢模型写的内容），并给 warning。
 *
 * @returns {{applied:number, padded:number, spare:number, moved:number}}
 * @param {boolean} [coverOn] 剧情演完模式（**只有它为 true 才搬格内成员**）
 */
function enforceLayoutGeometry(items, lay, W, H, warnings, pad, coverOn) {
  const slots = (lay && Array.isArray(lay.slots)) ? lay.slots : [];
  if (!slots.length) return { applied: 0, padded: 0, spare: 0, moved: 0 };
  const objs = items.filter((x) => x.label === 'object');
  if (!objs.length) return { applied: 0, padded: 0, spare: 0, moved: 0 };
  /**
   * `pad === 'off'`：模型少写格就**不补**（版面会空一块，但内容全是模型自己写的）。
   * 这是给「补出来的格总是被邻格人物溢出」的用户留的退路。
   */
  const noPad = pad === 'off';

  const slotOrder = slots
    .map((s, i) => ({ s, i, a: Math.abs((s.rect[2] - s.rect[0]) * (s.rect[3] - s.rect[1])) }))
    .sort((x, y) => y.a - x.a || x.i - y.i);
  const objOrder = objs
    .map((o, i) => ({ o, i, a: boxArea(o.bbox || [0, 0, 1, 1]) }))
    .sort((x, y) => y.a - x.a || x.i - y.i);

  let applied = 0;
  let padded = 0;
  /** ★ v0.9.138：记下每个 object 的「旧框 → 新框」，循环完再统一搬格内成员。
   *  必须等**全部 object 都换过位置**之后才搬 —— 提前搬，重叠归属判断会拿新旧混着的坐标去比。 */
  const pairs = [];
  for (let k = 0; k < slotOrder.length; k += 1) {
    const slot = slotOrder[k].s;
    const box = slotToCenteredBox(slot.rect, W, H);
    if (k < objOrder.length) {
      const o = objOrder[k].o;
      const oldBox = Array.isArray(o.bbox) && o.bbox.length === 4 ? o.bbox.slice() : null;
      o.bbox = box;
      o.caption = renumberCaption(o.caption, slotOrder[k].i + 1);
      if (oldBox) pairs.push({ old: oldBox, next: box });
      applied += 1;
    } else {
      // 模型没写这一格 → 按版式补空镜（明确 empty of people，不会把人物引进这一格）
      if (noPad) continue;
      const lastObjIdx = items.map((x, i) => (x.label === 'object' ? i : -1)).filter((i) => i >= 0).pop();
      items.splice(lastObjIdx + 1, 0, {
        label: 'object',
        caption: emptyPanelCaption(slot, slotOrder[k].i + 1, pad),
        bbox: box,
      });
      padded += 1;
    }
  }
  /**
   * ★★★ v0.9.138：格子挪位 → 格里的成员跟着走。
   * 不做这一步，人物框会留在旧位置、掉到新格线外面（楼 11 底部大格就是这么空掉的）。
   *
   * ★★ **只在剧情演完模式（coverMode）下执行**（用户 2026-10-27：「记得做好隔离，
   *    别影响到其他口径」）。其他 MOSS 多格走原路径，行为与 v0.9.137 完全一致 ——
   *    `coverOn` 由 `opts.enhance.coverMode` 决定，测试/非 MOSS 调用不传就是 false。
   */
  let moved = 0;
  if (coverOn) {
    moved = remapPanelMembers(items, pairs);
    if (moved) warnings.push(`格子换位时把 ${moved} 个人物/台词框一起搬了（不搬的话人物会掉到格子外面）`);
  }

  const spare = Math.max(0, objOrder.length - slotOrder.length);
  if (padded) warnings.push(`模型少写了 ${padded} 格 —— 已按版式补成空镜（不会和别的格重复）`);
  if (spare) warnings.push(`模型多写了 ${spare} 个格，超出本次版式 —— 保留原样（版面可能不齐）`);
  return { applied, padded, spare, moved };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 画面强化后处理（v0.9.136 起；**v0.9.154 只剩「斜切分格」**）
 *
 * ★★★ v0.9.154：删掉「粗黑边框」「主格撑满」两项（用户 2026-10-29 决定）。
 *   删的理由不是没证据，而是**这两项只在旧 `compileLayout` 路径落地**：
 *   漫画页自造 items、完全不经过本函数 ⇒ 面板上开着也一页都不生效。
 *   其中「主格撑满」方向还与用户 2026-10-29 否掉的「脸填满框」同向，**不许复活**。
 *
 * 剩下的 `slant`：坐标仍是矩形，模型照 caption 画斜线（`slant_r2` / `slant_c` 有出图）。
 * 幂等：先测「是不是已经有了」，重复跑不会叠加（见 `dev/enh-test.mjs`）。
 * ══════════════════════════════════════════════════════════════════════════ */



/**
 * 把「画面强化」三项落到成稿上。
 *
 * @param {Array} items  成稿 items（会被就地改）
 * @param {object} summary 成稿 summary（会被就地改）
 * @param {number} W @param {number} H 画布
 * @param {object} enh  `normalizeMossEnhance()` 的结果
 * @param {string[]} warnings 收集提示
 * @returns {{border:number, slant:number, fill:number}} 各加了几处
 */
export function applyVisualEnhance(items, summary, W, H, enh, warnings) {
  const stat = { slant: 0 };
  if (!enh || !Array.isArray(items)) return stat;
  const warn = Array.isArray(warnings) ? warnings : [];

  /* 斜切分格 —— summary 与每格都要写（实测两处一起写才出斜线） */
  if (enh.slant) {
    const cap = String(summary && summary.caption || '');
    if (cap && !RE_HAS_SLANT.test(cap)) {
      summary.caption = dropTailDot(cap) + ', ' + ENH_TEXT.slantPage;
      stat.slant += 1;
    }
    for (const it of items) {
      if (it.label !== 'object') continue;
      if (RE_HAS_SLANT.test(it.caption)) continue;
      it.caption = dropTailDot(it.caption) + ', ' + ENH_TEXT.slantPanel;
      stat.slant += 1;
    }
    if (stat.slant) warn.push(`已改成斜切分格（${stat.slant} 处描述，坐标仍是矩形 —— 模型照 caption 画斜线）`);
  }

  return stat;
}

/**
 * 版面铺满归一化（中心化 yxyx 坐标系）。
 *
 * 现场依据（同一份诊断报告 · 楼层 #160 P17）：
 *   caption 写着 "A vertical two-panel page"，实际两格只占 y -576..-207 / -184..173
 *   → **下方 35% 整片空白**（画布 1152 高，只用了 1008）。同批的 P9 三格却是铺满的
 *   —— 说明模型算坐标不稳定，不是指令没写清。
 *
 * 做法：只看 object 并集的跨度，单方向不足画布 88% 就按比例拉伸到满。
 * 所有 items 用**同一个仿射**变换（含 character / text），保证人物与格子的相对位置不变。
 * 已经铺满的一律不动（88% 是「明显缺」的阈值，正常留白不会被误伤）。
 */
function fitPanelsToCanvas(items, width, height, warnings) {
  const objs = items.filter((x) => x.label === 'object');
  if (!objs.length) return false;
  const H2 = height / 2;
  const W2 = width / 2;
  const minY = Math.min(...objs.map((o) => o.bbox[0]));
  const maxY = Math.max(...objs.map((o) => o.bbox[2]));
  const minX = Math.min(...objs.map((o) => o.bbox[1]));
  const maxX = Math.max(...objs.map((o) => o.bbox[3]));
  const spanY = maxY - minY;
  const spanX = maxX - minX;
  const needY = spanY > 0 && spanY < height * 0.88;
  const needX = spanX > 0 && spanX < width * 0.88;
  if (!needY && !needX) return false;

  const ky = needY ? height / spanY : 1;
  const kx = needX ? width / spanX : 1;
  const mapY = (v) => (needY ? Math.round((v - minY) * ky - H2) : v);
  const mapX = (v) => (needX ? Math.round((v - minX) * kx - W2) : v);

  for (const it of items) {
    const [y0, x0, y1, x1] = it.bbox;
    let ny0 = Math.max(-H2, Math.min(H2 - 1, mapY(y0)));
    let ny1 = Math.max(-H2 + 1, Math.min(H2, mapY(y1)));
    let nx0 = Math.max(-W2, Math.min(W2 - 1, mapX(x0)));
    let nx1 = Math.max(-W2 + 1, Math.min(W2, mapX(x1)));
    // 夹边后可能退化成零面积（只在极端小框上出现）—— 补 1px，别把框弄没
    if (ny1 <= ny0) ny1 = ny0 + 1;
    if (nx1 <= nx0) nx1 = nx0 + 1;
    it.bbox = [ny0, nx0, ny1, nx1];
  }

  const worst = needY ? spanY / height : spanX / width;
  warnings.push(`版面只铺了 ${Math.round(worst * 100)}% 的画布 —— 已按比例拉伸铺满整页`);
  return true;
}

/**
 * 让 summary.caption 里声明的格数**与实际的 object 数一致**（v0.9.125）。
 *
 * 病例（2026-10-21 楼 144 三张，全部命中）：
 *   caption 写着 `Three stacked panels`，items 里却只有 **2 个 object**
 *   （版式是「上小下大」两格，`0~0.3H` + `0.32H~H`），而且两个 object 并集已铺满画布，
 *   padPanelObjects 无空白可补 → 声明和几何永久对不上。
 *   后果：模型一边读到「三格」一边只看到两个框，只能自己均分版面 ——
 *   实拍结果是它把主角搬进大格，人物在格线上被切断。
 *
 * 做法：**只改数字**（two/three/four/five），不动句式与其它内容。
 *   能安全改的两种形态：`three panels` / `three stacked panels` / `two-panel page`。
 *   改不动（措辞太自由）就只报 warning，绝不整句重写。
 */
function alignCaptionPanelCount(summary, nObj, warnings) {
  const cap = String(summary.caption || '');
  const declared = panelCountFromCaption(cap);
  if (!declared || declared === nObj) return false;
  const wordOf = { 2: 'two', 3: 'three', 4: 'four', 5: 'five' }[nObj] || String(nObj);
  // 保大小写：原文是 `Three stacked panels` 时不能改成 `two`（句首小写很难看，也像语法错误）
  const sameCase = (orig, w) => (orig && orig[0] === orig[0].toUpperCase() ? w[0].toUpperCase() + w.slice(1) : w);
  const NUM = '(two|three|four|five|\\d+)';
  const ADJ = '(?:stacked|vertical|horizontal|equal|unequal|wide|narrow|tight)';
  let out = cap
    .replace(new RegExp(`\\b${NUM}(-)(panels?)\\b`, 'i'), (m0, num, dash, panel) => `${sameCase(num, wordOf)}${dash}${panel}`)
    .replace(new RegExp(`\\b${NUM}(\\s+(?:${ADJ}\\s+)?)(panels?)\\b`, 'i'), (m0, num, mid, panel) => `${sameCase(num, wordOf)}${mid}${panel}`);
  if (out === cap) {
    warnings.push(`caption 声明 ${declared} 格，实际只有 ${nObj} 个格背景（object）—— 声明与几何不一致，模型会自己均分版面`);
    return false;
  }
  summary.caption = out;
  warnings.push(`caption 声明 ${declared} 格但实际只有 ${nObj} 个格背景 —— 已把 caption 的格数改成 ${nObj}（声明与几何不一致时模型会自己均分版面）`);
  return true;
}

/**
 * 人物框 / 格子的匹配体检（v0.9.125）。
 *
 * 依据全部来自模版自己的规则：
 *   §3.2「每格高度不低于整页的 1/4，太窄人物会被压成剪影」「角色框放进它所在那格，
 *        人物不要顶到格边（会被裁）」；官方 §13.1「**不要用脸大小的框承载全身**」。
 * 规则一直在，但**从来没人检查它**，所以每次都靠出图之后肉眼发现。
 *
 * 病例（楼 144 P15，一张图里同时踩两条）：
 *   ① 上格 object 高 369px（画布 1152 → 32%），character 的 caption 却写
 *      `thighs pressed together around his hips, one knee turning inward`
 *      → 膝盖以下落到格线外，出来就是断腿。
 *   ② 同一格 object caption 是 `extreme close-up at hip level`，里面挂了两个 character
 *      → 画出一个没有头的下体碎块（正是 §13.1 说的「用脸大小的框承载全身」）。
 *
 * 判据用**绝对比例**（格高 / 画布），不用「人物框占格多少」：
 *   后者在高格里会误报（一个 690/700 的框写跪姿其实是放得下的）。
 *   40% 是实测阈值：32% 的格必断腿，61% 的格正常。
 *
 * 只报 warning、**不自动改框** —— 改框要跨格重排，等于改画面。
 */
function warnTightCharacterBox(items, width, height, warnings) {
  const LIMB = /\b(thighs?|knees?|legs?|calves|calf|ankles?|feet|foot|kneel\w*|crouch\w*|straddl\w*|squat\w*)\b/i;
  const CU = /\b(extreme close-?up|close-?up|macro shot|detail shot)\b/i;
  const objs = items.filter((x) => x.label === 'object');
  if (!objs.length) return;
  const holder = (it) => {
    const [y0, x0, y1, x1] = it.bbox;
    let best = null; let area = Infinity;
    for (const ob of objs) {
      const [Y0, X0, Y1, X1] = ob.bbox;
      if (!(X0 - 16 <= x0 && Y0 - 16 <= y0 && x1 <= X1 + 16 && y1 <= Y1 + 16)) continue;
      const a = (Y1 - Y0) * (X1 - X0);
      if (a < area) { area = a; best = ob; }
    }
    return best;
  };
  items.forEach((it, i) => {
    if (it.label !== 'character') return;
    const holderObj = holder(it);
    if (!holderObj) return;
    const cap = String(it.caption || '');
    const objH = holderObj.bbox[2] - holderObj.bbox[0];
    const objRatio = objH / height;
    if (CU.test(String(holderObj.caption || ''))) {
      warnings.push(`items[${i}]（character）落在特写格里（该格 caption 是 close-up）—— 人物会被画成局部碎块；特写格只放 object，人物项请放到中景/全景格`);
      return;
    }
    if (objRatio >= 0.4) return;
    if (!LIMB.test(cap)) return;
    warnings.push(`items[${i}]（character）所在格只有画布高的 ${Math.round(objRatio * 100)}%，caption 里却写了下肢动作 —— 腿脚会被格线切断（要么放大格/框，要么把动作收到半身）`);
  });
}

/**
 * 编译：草稿 → 成稿（abs_centralized + yxyx + 整数）。
 *
 * @param {object} layout 模型给的 Layout（可能是草稿，也可能是成稿）
 * @param {number} W 实际画布宽（来自 cfg.backends.comfyui，每次出图都可能不同）
 * @param {number} H 实际画布高
 * @returns {{ok:boolean, out?:object, errors:string[], warnings:string[], stats:object}}
 */
export function compileLayout(layout, W, H, opts) {
  const errors = [];
  const warnings = [];
  const width = Math.max(1, Math.round(num(W) || 0));
  const height = Math.max(1, Math.round(num(H) || 0));

  if (!layout || typeof layout !== 'object' || Array.isArray(layout)) {
    return { ok: false, errors: ['Layout 不是对象'], warnings, stats: {} };
  }

  const space = String(layout.bbox_coord_space || 'abs');
  const format = String(layout.bbox_format || 'xyxy');

  /**
   * 草稿自带的 width/height 与实际画布不一致 → 按比例缩放。
   * 官方 §12.3：「改尺寸后，若要保持相对占比，先按新旧宽高分别缩放草稿坐标，
   * 复查构图后重新转换；**只更改尺寸不会自动缩放对象**。」
   * ⇒ 用户改了分辨率而模型还在按旧尺寸算，就会整张图偏位 —— 这里替他缩放。
   */
  const dw = num(layout.width);
  const dh = num(layout.height);
  const draftW = Number.isFinite(dw) && dw > 0 ? dw : width;
  const draftH = Number.isFinite(dh) && dh > 0 ? dh : height;
  const sx = width / draftW;
  const sy = height / draftH;
  const scaled = Math.abs(sx - 1) > 1e-6 || Math.abs(sy - 1) > 1e-6;
  if (scaled) {
    warnings.push(`草稿尺寸 ${draftW}x${draftH} ≠ 实际画布 ${width}x${height}，坐标已按比例缩放`);
  }

  const items = [];
  const src = Array.isArray(layout.items) ? layout.items : [];
  if (!src.length) return { ok: false, errors: ['items 是空的（至少要有一个 object 表示画面/格子）'], warnings, stats: {} };

  let nChar = 0; let nObj = 0; let nText = 0;
  src.forEach((it, i) => {
    if (!it || typeof it !== 'object') { errors.push(`items[${i}] 不是对象`); return; }
    const label = String(it.label || '').trim();
    if (!LAYOUT_LABELS.includes(label)) {
      errors.push(`items[${i}] label="${label}" 非法（只能是 character / object / text）`);
      return;
    }
    const caption = String(it.caption || '').trim();
    if (!caption) { errors.push(`items[${i}]（${label}）caption 是空的`); return; }

    const box = toDraftBox(it.bbox, space, format, width, height);
    if (!box.ok) { errors.push(`items[${i}]（${label}）${box.err}`); return; }
    let [x0, y0, x1, y1] = box.box;
    if (scaled) { x0 *= sx; x1 *= sx; y0 *= sy; y1 *= sy; }

    /**
     * ★ 零面积框必须报错，**不能靠下面那句「至少 1px」静默兜住**。
     *   `x0 == x1` 说明模型根本没想清楚这一项放在哪；静默改成 1px 宽，
     *   出图结果就是「一条竖线漂在那里」—— 比直接报错难查得多。
     *   反向验证时就是这条漏了（夹边逻辑把它吞了），所以判在这里、判缩放后的原始值。
     */
    if (x1 - x0 < 0.5) { errors.push(`items[${i}]（${label}）宽度为 0（x0 ≈ x1 = ${Math.round(x0)}）`); return; }
    if (y1 - y0 < 0.5) { errors.push(`items[${i}]（${label}）高度为 0（y0 ≈ y1 = ${Math.round(y0)}）`); return; }

    // 小数边：左上向下取整、右下向上取整（官方 §12.3 明文）
    x0 = Math.floor(x0); y0 = Math.floor(y0);
    x1 = Math.ceil(x1); y1 = Math.ceil(y1);
    // 夹进画布
    x0 = Math.max(0, Math.min(width - 1, x0));
    x1 = Math.max(x0 + 1, Math.min(width, x1));
    y0 = Math.max(0, Math.min(height - 1, y0));
    y1 = Math.max(y0 + 1, Math.min(height, y1));

    // 转成中心化 yxyx
    const cy0 = y0 - height / 2;
    const cy1 = y1 - height / 2;
    const cx0 = x0 - width / 2;
    const cx1 = x1 - width / 2;
    const bbox = [Math.round(cy0), Math.round(cx0), Math.round(cy1), Math.round(cx1)];

    const out = { label, caption, bbox };
    if (label === 'text') {
      const t = String(it.text || '').trim();
      if (!t) { errors.push(`items[${i}] 是 text 项但 text 是空的（没台词就不要放 text 项）`); return; }
      out.text = t;
      nText += 1;
    }
    if (label === 'character') nChar += 1;
    if (label === 'object') nObj += 1;
    items.push(out);
  });

  if (!items.length) return { ok: false, errors: [...errors, '编译后没有可用 item'], warnings, stats: {} };

  const summaryIn = layout.summary && typeof layout.summary === 'object' ? layout.summary : {};
  const summary = { caption: String(summaryIn.caption || '').trim() };
  if (!summary.caption) errors.push('summary.caption 是空的（画风句就写在这里）');
  const canvas = LAYOUT_CANVAS.includes(summaryIn.canvas) ? summaryIn.canvas : (nObj > 1 ? 'multi_panel' : 'single');
  summary.canvas = canvas;
  const meta = Array.isArray(summaryIn.meta) ? summaryIn.meta.filter((x) => typeof x === 'string' && x.trim()).slice(0, 6) : [];
  if (meta.length) summary.meta = meta;

  /**
   * 多格：每格一个 object（§12.4「canvas="multi_panel" 只标类型，实际格框用 object
   * 表示每格可见背景」）。少一个 object 时**补齐**而不是整张不出图 —— 理由见
   * padPanelObjects 的注释（诊断报告里真的因此丢了一张图）。
   */
  /**
   * ★★★ v0.9.130：**多格的版面坐标由版式决定**，不再「模型给什么就用什么 + 空白处硬补」。
   *
   * 旧逻辑只看 `nObj < 2`：模型写了 1 个大格时，`padPanelObjects` 按空白平分补出
   * 两条全宽横条，文案统一是「同房间、同光、同瞬间、同视角」
   * → 用户看到的正是「三格内容几乎一样、完全不像漫画分镜」。
   *
   * 另外：`layout=random` 时版式是**每次抽**的，所以这里必须读
   * `getPickedLayout()`（生成提示词时抽中的那一个），不能再抽一次 ——
   * 「算」和「比」必须是同一份数据。
   */
  if (canvas === 'multi_panel') {
    const declared = panelCountFromCaption(summary.caption) || 0;
    let lay = opts && opts.layout && Array.isArray(opts.layout.slots) && opts.layout.slots.length
      ? opts.layout : getPickedLayout();
    if (!lay || !Array.isArray(lay.slots) || !lay.slots.length) {
      lay = fallbackLayoutFor(Math.max(2, declared || nObj || 2));
      warnings.push('拿不到本次版式 —— 已用不等分兜底版式（不是等分三块）');
    }
    /**
     * 模型写的格数比版式多 → 换一个装得下它的兜底版式，别把内容丢掉。
     * 比版式少是常态（模型注意力在人物上），由 enforceLayoutGeometry 补空镜。
     */
    if (nObj > lay.slots.length) lay = fallbackLayoutFor(nObj);
    /** ★ 剧情演完模式（coverMode）—— 只影响「格内成员是否跟着格子搬」，不影响别的口径。 */
    const coverOn = normalizeMossCover(opts && opts.enhance).on;
    /**
     * ★★★ v0.9.138：剧情演完模式下，**模型少写格不补空镜**，按它实际写的格数收窄版面。
     *
     * 病例（用户 2026-10-27 端到端，楼 11 九张全部命中）：模型只写了 1 个 object，
     * 本次版式是 3 格 → 补成「1 格内容 + 2 格空镜」。而「不许空镜」正是这模式的第一条规则，
     * 补出来的空格既没人、又占掉了本该画剧情的位置。
     * ⇒ coverMode 下格数跟着模型走；它写少了给 warning 让用户知道是模型退化，不是版面问题。
     * ★ 非 coverMode 保持原行为（补空镜）—— 用户要求与其他口径隔离。
     */
    if (coverOn && nObj < lay.slots.length) {
      const fit = fallbackLayoutFor(Math.max(2, nObj));
      if (fit && Array.isArray(fit.slots) && fit.slots.length && fit.slots.length < lay.slots.length) lay = fit;
      if (nObj < 3) {
        warnings.push(`这一张模型只写了 ${nObj} 格（剧情演完模式要求每张 3~4 格）—— 已按实际格数收窄版面，没有补空镜；剧情可能被压缩`);
      }
    }
    /**
     * ★ v0.9.154：补格策略**固定成 `angle`**（原来由面板「正文填不满格子时怎么办」控制）。
     *   那个开关已随用户 2026-10-29 的决定删除 —— 它只在旧 compileLayout 路径有消费点，
     *   漫画页路径完全不读。这里保留原有默认行为（换机位补格），免得删 UI 顺带改了旧路径出图。
     */
    const geo = enforceLayoutGeometry(items, lay, width, height, warnings, 'angle', coverOn);
    nObj = items.filter((x) => x.label === 'object').length;
    if (geo.applied) {
      warnings.push(`版面已按「${lay.name || lay.key}」强制对齐（${geo.applied} 格换成正版式坐标）`);
    }
  }

  /**
   * 版面铺满归一化：放在补格之后 —— 补出来的格本身就会把空白填上，
   * 只有「object 数量够但坐标被压缩」的情况才走拉伸。
   */
  fitPanelsToCanvas(items, width, height, warnings);

  /**
   * ★★★ v0.9.139：剧情演完模式下**把格间空白收窄**（实测这是唯一能出黑分隔线的办法）。
   * 必须在 `fitPanelsToCanvas` 之后（要按最终 bbox 算间隙）、`applyVisualEnhance` 之前
   * （撑满那项要按最终格子挑主格）。
   */
  if (canvas === 'multi_panel' && normalizeMossCover(opts && opts.enhance).on) {
    const gapPx = Math.max(8, Math.round(height * 0.012));
    const closed = closePanelGutters(items, width, height, gapPx);
    if (closed) warnings.push(`格间空白已收到 ${gapPx}px（${closed} 格）—— 实测宽缝会被画成白色发光带，收窄才出漫画分隔线`);
  }

  /**
   * ★ v0.9.136：画面强化（粗黑边框 / 斜切 / 主格撑满）。
   *
   * 位置必须在 `fitPanelsToCanvas` **之后** —— 它要靠最终 bbox 找「最大的那一格」；
   * 在拉伸之前判定，会拿旧坐标选错主格。
   * 放在 `alignCaptionPanelCount` 之前是因为后者只改格数词，两者不冲突（但先加后改更稳）。
   */
  if (canvas === 'multi_panel') {
    applyVisualEnhance(items, summary, width, height, normalizeMossEnhance(opts && opts.enhance), warnings);
  }

  /**
   * ★ v0.9.125：格数声明对齐 + 人物框高度体检。
   *   放在 fitPanelsToCanvas **之后** —— 补格与拉伸都做完了，object 数才是最终值。
   */
  if (canvas === 'multi_panel') {
    const finalObj = items.filter((x) => x.label === 'object').length;
    alignCaptionPanelCount(summary, finalObj, warnings);
  }
  warnTightCharacterBox(items, width, height, warnings);

  /* 角色/文字框必须落在某一格之内（允许 16px 外扩）—— 跨格是最常见的一种崩法 */
  if (nObj >= 2) {
    const objs = items.filter((x) => x.label === 'object');
    items.forEach((it, i) => {
      if (it.label === 'object') return;
      const [y0, x0, y1, x1] = it.bbox;
      const inside = objs.some((ob) => {
        const [Y0, X0, Y1, X1] = ob.bbox;
        return X0 - 16 <= x0 && Y0 - 16 <= y0 && x1 <= X1 + 16 && y1 <= Y1 + 16;
      });
      if (!inside) warnings.push(`items[${i}]（${it.label}）的框不在任何一格之内 —— 可能被画到格子外面`);
    });
  }

  if (!nChar) warnings.push('没有任何 character 项 —— 这张图里的人不会带外貌描述（会随机长）');

  const out = {
    summary,
    items,
    bbox_coord_space: 'abs_centralized',
    bbox_format: 'yxyx',
  };

  /**
   * 兜底：只留官方允许的根字段。
   * §12.3「最终根字段仅为 summary / items / bbox_coord_space / bbox_format。**不含 width 和 height**」
   * —— 多带字段模型不一定报错，但既然官方明说不含，就别带。
   */
  for (const k of Object.keys(layout)) {
    if (!ROOT_KEEP.includes(k) && !['bbox_coord_space', 'bbox_format', 'width', 'height'].includes(k)) {
      warnings.push(`丢弃了非官方根字段 "${k}"`);
    }
  }

  return { ok: errors.length === 0, out, errors, warnings, stats: { nChar, nObj, nText, w: width, h: height } };
}

/** 成稿 → 单行紧凑 JSON（官方 §12.3「以一行紧凑 JSON 交付」）。 */
export function layoutToLine(out) {
  return JSON.stringify(out);
}

/** 给诊断页用的人话摘要。 */
export function describeLayout(out) {
  if (!out?.items) return '(空)';
  const c = out.items.filter((x) => x.label === 'character').length;
  const o = out.items.filter((x) => x.label === 'object').length;
  const t = out.items.filter((x) => x.label === 'text').length;
  return `canvas=${out.summary?.canvas} · ${o} 格背景 / ${c} 角色 / ${t} 台词`;
}
