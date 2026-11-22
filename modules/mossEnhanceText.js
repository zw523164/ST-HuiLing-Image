/**
 * mossEnhanceText.js —— 画面强化用到的**全部英文句子**，一处定义（v0.9.136）
 *
 * ## 为什么必须单独拎出来
 *
 * 这些句子不是凭语感写的，每一条都是**真实出图对照**出来的；改一个词就可能画不出来了。
 * 实测踩过的两个例子：
 *   · 粗黑边框写在 `summary.caption` 里**完全无效**，写进每一格 object 才出黑线；
 *   · 「人物出框」怎么都画不出来，换成「被画幅裁切」立刻见效。
 *
 * 所以这里除了文本，还给每条配 `ENH_PROOF`（证据图路径）。
 * `dev/evidence-test.mjs` 会：
 *   ① 逐字钉住文本 —— 谁改了措辞，测试立刻红；
 *   ② 断言证据图还在 —— 谁删了证据，测试也红（防止"没证据还挂着"）。
 *
 * ★ 用户 2026-10-23 的原话：「你自创的除非有测试。或者能保证不出错的那种。」
 *   这个文件就是那条要求的落地物：**不留没证据的句子**。
 */

/**
 * ★★★ v0.9.154：**「这句是不是已经写过了」的判据与句子同源**。
 *
 * 原来 `RE_HAS_SLANT` 只在 `mossJsonLayout.js` 里定义一份，漫画页要用时只能
 * 再抄一个正则 —— 抄副本的结局是「改了句子没改正则」或反过来，幂等判断静默失效。
 * 项目纪律：判据引用常量，不抄字符串。
 */
export const RE_HAS_SLANT = /cut on a slant|slanted|diagonal (?:border|edge|split)/i;

/** 追加子句前去掉句末标点（避免 `..`）。**两条路径共用一份**，别各写一个。 */
export function dropTailDot(s) {
  return String(s || '').trim().replace(/[.。]+$/, '');
}

export const ENH_TEXT = {
  /**
   * ★★★ v0.9.154：`border` 与 `fillFemale` **已下线**（用户 2026-10-29 要求删面板死项）。
   *   它们只在旧 `compileLayout` 路径落地，漫画页一条都不读 ⇒ 面板上开着也一页不生效。
   *   常量**故意保留**：① `dev/enh-test.mjs` 用它们做「不许再出现」的反向断言；
   *   ② 证据图仍在 `docs/evidence/`。将来要复活必须重新出图验证，不许直接开回来。
   */
  border: 'framed by a thick black panel border',

  /** 已下线（同上）。证据：r5crop、f1/f2/f3、a_on、d_left3。 */
  fillFemale: 'Her body fills the whole panel, her head cropped by the top border and one knee cropped by the bottom border',
  /**
   * ★★★ 中性句 `The body fills the whole panel, ...` 已删（v0.9.136）：
   *   它只是女性句换代词，**从没单独出过图**。按用户纪律，没证据就不上 ——
   *   判不出性别时干脆不加撑满（少一句不影响画面，加一句没验证的才有风险）。
   *   落地见 `mossJsonLayout.js:applyVisualEnhance()` 的 `if (fem)` 分支。
   */

  /** 斜切：每格边界句。证据：r2、f2、c_slant。 */
  slantPanel: 'its edges cut on a slant',
  /** 斜切：整页句（两处一起写才出斜线）。证据：c_slant（新措辞首张）。 */
  slantPage: 'the panel borders cutting across the page on a slant with uneven angled gutters',

  /** 拟声词 caption。证据：r4sfx（日文 ドキッ 画出黑色粗笔画）。 */
  sfxJa: 'a large hand-lettered Japanese sound effect in bold black strokes, floating in an empty corner of the panel',
  /** 中文拟声词。证据：ab_fix/sfx_zh（本轮补测）。 */
  sfxZh: 'a large hand-lettered Chinese sound effect in bold black strokes, floating in an empty corner of the panel',

  /**
   * 补格用的三句机位（只用实测有效的，见 ab_pose/08_景别与机位）。
   *
   * ★★★ 第四句「俯拍」`The camera is mounted high and looks straight down at them` 已删（v0.9.136）：
   *   机位本身生效（`dev_tmp/ab_pad/high.png` 第 2 格确实是俯视全景），
   *   但**那一格被人填满了** —— caption 明写 `no people in this panel` 也拦不住
   *   （俯拍信息量大，模型倾向补人；cfg≈1 下否定句本来就弱）。
   *   补格是为了「空镜凑版面」，画进人就不是空镜了 ⇒ 不做推荐机位。
   */
  padAngleFar: 'From the doorway across the room, the door frame dark in the foreground',
  padAngleLow: 'The camera is low near the floor looking up, the ceiling and the lamp visible above',
  padAngleSide: 'A pure side-on view, seen in profile from one side',

  /**
   * 补格用的具体室物清单 —— 按这一格该承担的景别挑一套。
   * 证据：jroom（两张空镜都真空）。关键不在肯定/否定，而在**有没有具体物体**。
   */
  padPropsFar: 'the doorway with the door frame dark in the foreground, the floor and the far wall, the whole room small and still',
  padPropsDetail: 'a corner of the sheets with deep creases, the edge of the pillow, one fold of the curtain',
  padPropsNear: 'the bed with its crumpled sheets, the wooden headboard, a curtained window with daylight',
  padPropsMedium: 'the bed and the nightstand beside it, a curtained window with daylight, the striped wall',

  /** 补格时必须声明这一格没人（与指令层的「每格写人数」规则对齐）。 */
  padNoPeople: 'no people in this panel',
};

/**
 * 每条文本的**证据图**（相对插件根目录）。
 * 测试会断言「每个 key 至少有一张图还存在且不是空文件」。
 *
 * ★ 为什么是 `docs/evidence/`（缩略图）而不是 `dev_tmp/`（原图）：
 *   部署会删掉 `dev/` 与 `dev_tmp/`，那份副本上测试会**全部 SKIP** ——
 *   跳过看着是绿的，其实什么都没验。`docs/` 会随部署一起走，两边都能真跑。
 *   原图在 `dev_tmp/ab_*`，重新打包：`python tools/pack_evidence.py`。
 *   文件名里的 `_REJECTED` / `_FAILED` 是**反例**：证明某条写法被实测否掉才删的，
 *   不是漏写。
 */
export const ENH_PROOF = {
  border: ['docs/evidence/border_r5ink.jpg', 'docs/evidence/border_f2.jpg', 'docs/evidence/border_a_on.jpg', 'docs/evidence/border_d_left3.jpg'],
  fillFemale: ['docs/evidence/fill_r5crop.jpg', 'docs/evidence/border_f2.jpg', 'docs/evidence/border_a_on.jpg', 'docs/evidence/border_d_left3.jpg'],
  /** ★ 没有 `fillNeutral`：判不出性别时**不加**撑满（那句从没出过图，已删）。 */
  slantPanel: ['docs/evidence/slant_r2.jpg', 'docs/evidence/border_f2.jpg', 'docs/evidence/slant_c.jpg'],
  slantPage: ['docs/evidence/slant_c.jpg'],
  sfxJa: ['docs/evidence/sfx_ja_r4sfx.jpg', 'docs/evidence/border_f2.jpg'],
  sfxZh: ['docs/evidence/sfx_zh.jpg'],
  padAngleFar: ['docs/evidence/angle_far.jpg'],
  padAngleLow: ['docs/evidence/angle_low.jpg'],
  padAngleSide: ['docs/evidence/angle_side.jpg'],
  /**
   * 反例（不是 padAngleHigh 的正面证据）：俯拍机位生效，但那一格被人填满 ⇒ 已删，
   * 只留图证明「删是因为实测画不出空镜」，不是忘了写。
   */
  padAngleHigh: ['docs/evidence/angle_high_REJECTED.jpg'],
  padPropsFar: ['docs/evidence/props_jroom.jpg'],
  padPropsDetail: ['docs/evidence/props_jroom.jpg'],
  padPropsNear: ['docs/evidence/props_jroom2.jpg'],
  padPropsMedium: ['docs/evidence/props_jroom2.jpg'],
  padNoPeople: ['docs/evidence/props_jroom.jpg', 'docs/evidence/props_jroom2.jpg'],
};

/**
 * 体位 `fix` 的证据（`poseLibrary.js` 的 `fix` 字段）。
 *
 * 通过的那 7 条各自一张复验图；`reverse bridge` 三张全是**反例** ——
 * 三种写法都画不出「双脚掌踏床的反弓桥」，所以那条 fix 已整条撤掉。
 */
export const POSE_FIX_PROOF = {
  'jackknife': ['docs/evidence/pose_jackknife.jpg'],
  'butterfly': ['docs/evidence/pose_butterfly.jpg'],
  'standing bent over': ['docs/evidence/pose_standing-bent-over.jpg'],
  'against the wall': ['docs/evidence/pose_against-the-wall.jpg'],
  'koala carry': ['docs/evidence/pose_koala-carry.jpg'],
  'shoulder stand': ['docs/evidence/pose_shoulder-stand.jpg'],
  /** `legs on shoulders` 的证据在上一轮（W3 修好），图已归档在 ab_pose 系列。 */
  'legs on shoulders': ['docs/evidence/pose_legs-on-shoulders.jpg'],
};

/** 被实测否掉、故意不写的方案 —— 测试断言「它们**不在**生产路径里」。 */
export const ENH_REJECTED = {
  /** 俯拍不能用于补格（`angle_high_REJECTED.jpg`：整格被人填满）。 */
  padAngleHigh: 'The camera is mounted high and looks straight down at them',
  /** 反向桥式的三版 fix 全部失败，不许加回来。 */
  reverseBridgeFix: [
    'Both her palms and both her feet are planted on the bed carrying her weight',
    'Her knees are bent with both soles flat on the bed',
    'She is held up by her own two feet and two palms',
  ],
};
