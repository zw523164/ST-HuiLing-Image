/**
 * 同类词聚类削减（v0.9.114）
 *
 * 用户 2026-10-20 的原话（两次补充，方向很明确）：
 *   「主要是同类型的词不需要叠加太多」
 *   「特别是同时出现容易混乱权重」
 *
 * ★ 要解决的**不是**「自创词不好看」，而是**权重混乱**：
 *   SD/danbooru 的 tag 是**叠加权重**。同一个语义维度写两条以上时，
 *   模型不会"两个都画"，而是在两者之间随机取，或取一个扭曲的中间态。
 *
 *   真机病例（用户截图，2026-10-20）：
 *     · 花妆：`makeup slightly smudged` + `lipstick blurred at the edges`
 *       → 同一件事（妆花了）写两遍 → 妆容时轻时重
 *     · 衣服滑落：`clothes partially slid down` + `sleeves slipping`
 *       → 同一件事（衣服在往下滑）写两遍 → 衣服位置每次不一样
 *     · 长相：`handsome` + `delicate feminine features` + `slender face` + `lean muscular build`
 *       → 四条形容同一张脸 / 同一副身材 → 脸每次都不像同一个人
 *
 * ★ 与已有模块的分工（不要混）：
 *   · `outfitTagFix.js` —— 管**服装品类**（一件衣物只许一条 tag、腿袜档位、颜色继承）
 *   · `sdComposeFix.js` —— 管**画面结构**（机位/景别/朝向/姿态/禁词）
 *   · `本模块` —— 管**语义同组超量**（花妆 / 嘴型 / 眼睛 / 衣服滑落 / 长相气质）
 *
 * ★★ 保留策略：**优先保留最像标准 tag 的那条**，不是"保留第一条"。
 *   理由：danbooru tag 普遍是 1~3 个词、不含介词。
 *   `handsome`(1 词) 比 `delicate feminine features`(3 词) 更像标准 tag → 留 `handsome`。
 *   打分相同才按出现顺序（先写的赢）。
 *
 * ★ 宁缺不错：只收**能 100% 确定同义 / 互斥**的组。
 *   以下刻意**不收**（它们是真的不同维度，删了就是改画面）：
 *   · `sweat` + `trembling` + `blush` —— 出汗 / 发抖 / 脸红是三件事（已有体检，上限 2 的提示在 sdComposeFix）
 *   · `black hair` + `long hair` + `straight hair` —— 颜色 / 长度 / 直卷是三个维度
 *   · `black pantyhose` + `torn pantyhose` —— 由 outfitTagFix 合并成 `black torn pantyhose`，不归这里
 */

/** 介词 / 连词：danbooru tag 里几乎不出现，出现就说明是句子。 */
const PREP_RE = /\b(?:of|with|at|from|on|in|to|and|but|that|which|while|as)\b/i;

/**
 * 语义组。`test(tag)` 收**小写 tag**，返回是否属于该组。
 * `limit` = 该组最多留几条。
 */
export const CLUSTER_RULES = [
  {
    id: 'mouth',
    label: '嘴型',
    limit: 1,
    why: '嘴只有一张：闭着 / 张开 / 半张 是互斥状态，写两条模型只能画一个不闭合的嘴（牙齿错位、嘴唇糊）',
    test: (t) => /^(?:closed|open|slightly open|parted|half-open)\s+(?:mouth|lips)$/.test(t),
  },
  {
    id: 'eyes',
    label: '眼睛',
    limit: 1,
    why: '眼睛只有一双：闭眼 / 半闭 / 睁大是互斥状态，写两条会画成一只闭一只睁（或瞳孔错位）',
    test: (t) => /^(?:closed|open|half[- ]closed|narrowed)\s+eyes$/.test(t) || t === 'wide eyed',
  },
  {
    id: 'makeup',
    label: '花妆',
    limit: 1,
    why: '「妆花了」是一件事：写两条（smudged makeup + blurred lipstick）会让妆容时轻时重',
    test: (t) => /(?:makeup|lipstick)/.test(t)
      && /(?:smudged|smeared|messy|blurred|running|messed)/.test(t),
  },
  {
    id: 'clothes',
    label: '衣服滑落',
    limit: 1,
    why: '「衣服正在往下滑」是一件事：写两条会让衣服位置每次都不同（滑一半 / 滑到底）',
    /**
     * ★ `sleeves slipping` 必须单独收：它是「袖子在往下滑」，语义与 `clothes partially slid down`
     *   完全相同，但形式上 `slipping` 后面**没有** down/off —— 只按「动词 + 方位词」匹配会漏掉它
     *   （实测：用户 2026-10-20 截图里这一组就是漏的）。
     */
    test: (t) => /(?:slid|slipping|slipped|pulled|pushing|pushed)\s+(?:down|aside|off)\b/.test(t)
      || /^sleeves?\s+slipping$/.test(t)
      || /^off[- ]shoulder$/.test(t)
      || /clothes?\s+(?:aside|displaced|disarray)/.test(t),
  },
  /**
   * ★★★ 刻意**没有**「长相气质」组 —— 这是本模块第一版设计过的，被我撤掉了。
   *
   * 当时的想法：`handsome` + `delicate feminine features` + `slender face` + `lean muscular build`
   * 四条形容同一张脸 → 当成"同义叠加"删到只剩 `handsome`。
   *
   * 为什么撤掉（`sd-break-structure-097` 的 B5 当场打回）：
   *   这四个**不是同义**，是同一张脸的**四个维度** ——
   *   `handsome`＝英俊（气质）、`delicate feminine features`＝柔美五官（风格）、
   *   `slender face`＝瘦削脸型（骨相）、`lean muscular build`＝精瘦有肌肉（身材）。
   *   删掉三条 = 把「清瘦美少年」简化成「英俊」→ **改用户的角色设定**。
   *   人设是用户主权区，插件不许自行"合理化"。
   *
   * ⇒ 长相 / 气质 / 身材描述**一律不自动削**，只由体检提示（见 auditTagClusters 的 sentence 检查）。
   *   真正该削的只有「同一件事的两种说法」和「互斥状态」——下面四组都是这种。
   */
];

/**
 * 「像不像标准 tag」打分：分越低越标准。
 * ① 词数越少越好（danbooru 多是 1~3 词）
 * ② 含介词 / 连词重罚（那是句子，不是 tag）
 * ③ 含 and / 逗号残留更差
 */
export function standardScore(tag) {
  const t = String(tag || '').trim().toLowerCase();
  const words = t.split(/\s+/).filter(Boolean).length;
  let score = words;
  if (PREP_RE.test(t)) score += 10;
  if (/\band\b/.test(t)) score += 4;
  return score;
}

const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();

/** 按 BREAK 切段（BREAK 是段分隔符，绝不能让它被逗号切分扫过）。 */
const splitSegs = (text) => String(text || '').split(/\s*\bBREAK\b\s*/);
const joinSegs = (segs) => segs.filter(Boolean).join('\nBREAK\n');
const splitTags = (seg) => String(seg || '').split(',').map((t) => t.trim()).filter(Boolean);

/**
 * 同组超量 → 削到上限。
 *
 * @param {string} text 已过 tidySeparators 的整串（可含 BREAK）
 * @param {{protectTags?:string[]}} [opts]
 *   `protectTags`：**不参与**统计与削减的 tag（v0.9.115）。
 *   用于用户手工拼的全局前缀 / 后缀 —— 用户原话「局外加的前缀不需要你管，你主要管主体的」。
 *   注意按**整 tag 相等**匹配（小写），不做子串匹配，避免 `closed eyes` 保护掉 `closed eye` 之类。
 * @returns {{text:string, changes:Array<{id:string,label:string,kept:string,dropped:string[]}>}}
 */
export function fixTagClusters(text, opts = {}) {
  const src = String(text ?? '');
  if (!src) return { text: src, changes: [] };
  const protect = new Set(
    (opts?.protectTags || []).map((x) => String(x || '').trim().toLowerCase()).filter(Boolean),
  );
  const changes = [];

  const segs = splitSegs(src).map((seg) => {
    let tags = splitTags(seg);
    if (!tags.length) return seg;

    for (const rule of CLUSTER_RULES) {
      const hits = [];
      tags.forEach((t, i) => {
        if (protect.has(t.toLowerCase())) return;   // 用户手工拼的前后缀 → 不统计、不动
        if (rule.test(t.toLowerCase())) hits.push({ t, i });
      });
      if (hits.length <= rule.limit) continue;

      /* 打分：标准度优先（分低），同分按出现顺序 */
      const ranked = [...hits].sort((a, b) => (
        standardScore(a.t) - standardScore(b.t) || a.i - b.i
      ));
      const kept = ranked.slice(0, rule.limit);
      const dropped = ranked.slice(rule.limit);
      const dropIdx = new Set(dropped.map((d) => d.i));

      tags = tags.filter((_, i) => !dropIdx.has(i));
      changes.push({
        id: rule.id,
        label: rule.label,
        kept: kept.map((k) => k.t).join(' / '),
        dropped: dropped.map((k) => k.t),
        why: rule.why,
      });
    }
    return tags.join(', ');
  });

  return { text: joinSegs(segs), changes };
}

/**
 * 体检（只报不改）—— 给诊断页 / 日志用。
 * @param {string} text
 * @returns {Array<{level:'warn'|'hint', code:string, text:string}>}
 */
export function auditTagClusters(text) {
  const out = [];
  const sentenceLike = [];
  for (const seg of splitSegs(text)) {
    const tags = splitTags(seg);
    for (const rule of CLUSTER_RULES) {
      const hits = tags.filter((t) => rule.test(t.toLowerCase()));
      if (hits.length <= rule.limit) continue;
      out.push({
        level: 'warn',
        code: `cluster-${rule.id}`,
        text: `${rule.label}写了 ${hits.length} 条（${hits.join(' / ')}）—— ${rule.why}`,
      });
    }
    /* 像句子的自创词：≥4 词且含介词/连词。danbooru 几乎没有这种写法，模型只能当噪声。 */
    for (const t of tags) {
      const low = t.toLowerCase();
      if (low.split(/\s+/).filter(Boolean).length >= 4 && PREP_RE.test(low)) sentenceLike.push(t);
    }
  }
  if (sentenceLike.length) {
    out.push({
      level: 'hint',
      code: 'sentence-like',
      text: `有 ${sentenceLike.length} 条是「句子」而不是 danbooru tag（${sentenceLike.slice(0, 3).join(' / ')}${sentenceLike.length > 3 ? '…' : ''}）—— 模型只能当噪声处理。`
        + '没有自动删：这些多半是你在档案里写的人设细节，删了会改设定。想收敛请改成短语（`damp hair clinging to the skin` → `wet hair`）',
    });
  }
  return out;
}

export const __internals = { splitSegs, splitTags, PREP_RE };
