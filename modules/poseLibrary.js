/**
 * poseLibrary.js —— 成人档的「体位 → 几何骨架」库（v0.9.131）
 *
 * ## 为什么要有这个文件
 *
 * 用户 2026-10-22 反馈两条，指向同一件事：
 *   ① 「有些体位的时候出现怪异变化和轻微扭曲」；
 *   ② 甩来 `人像提示词/体位108式SKILL.md`（108 式，实际分七类，每式都写清了腿怎么摆、
 *      谁在上谁在下、进入角度、支撑点），说「这个也能作为他档位姿势参考价值」。
 *
 * 取证结论：旧成人段 ③ 只给了 **11 个裸体位名**（`doggystyle` / `cowgirl` …）。
 * 裸名字对编码器等于**零信息** —— 它只能靠先验去猜「谁在上面、腿在哪、手撑哪」，
 * 猜错就是躯干扭成麻花、多手多腿、格线切人。K2 那套能治是因为它要求写姿态句；
 * MOSS 这边从来没要求过。
 *
 * ⇒ 正确做法不是「把 108 式全文塞进 system」（24K 中文，会挤爆编码器上下文，
 *   而且模型会照着写成小说体，一格 85~130 词的额度根本装不下），
 *   而是把每式压成**一句话英文几何骨架**，让模型「照抄骨架、只换人名/场景」。
 *
 * ## 数据来源与用词策略（重要）
 *
 * 中文名、结构描述**逐字**取自 `体位108式SKILL.md`（108 式 / 七类 / 365 行）。
 * 原件有两处可读副本：`F:\AI相关下载\K2\人像提示词\体位108式SKILL.md`（用户指路，首选）、
 * `J:\DSH\deepseekHARNESS\人像提示词\体位108式SKILL.md`。反查测试见 `dev_tmp/pose_lib.mjs`。
 * 英文词**故意不用原件括号里的花名**（`Classic` / `Eagle` / `Chariot` …）：
 * 那些是 Kama Sutra 式的雅称，文本编码器没见过，等于又一个零信息词。
 * 所以主用词换成通用体位名（`missionary` / `legs on shoulders` / `doggystyle`），
 * 原件花名保留在每条的第四个字段 `orig`，**保证每个词都能追溯回原文**。
 *
 * 注入 prompt 的是**每类 2~4 式的精选表**（`POSE_CLASSES[].poses`），共 23 式 ——
 * 这是 caption 额度内真正写得出来的量。每条都成对给出「体位名 + 骨架」，
 * 目的是让模型**不必自己发明几何**。
 *
 * ★ 加新条目时：`sk` 必须是**可照抄的一句话**（谁在上 / 腿位 / 支撑点 / 进入方向），
 *   不许写形容词或氛围词（那些画不出来）；`orig` 必须是原件里真实存在的花名。
 */

/**
 * 七类（原件 Overview 自称「八大类」，实际分节只有七个）。
 * `skeleton` 是该类的**通用骨架**：即使模型没从表里挑具体式，
 * 也必须按这套结构写（类别先定，具体式再定）。
 */
export const POSE_CLASSES = [
  {
    key: 'supine',
    zh: '正位·仰卧类',
    en: 'she on her back, he above her',
    skeleton:
      'She lies on her back, both knees bent and opened; he is above her with his knees between her thighs; '
      + 'entry from the front, angled downward; her hands have to grip something (the sheet, his shoulders, '
      + 'the counter edge).',
    poses: [
      ['missionary', '传教士式', 'she on her back, knees bent and opened, he kneels between her thighs, both palms on the mattress at her sides', 'Classic'],
      /**
       * ★ v0.9.136 起，下面这些条目带第 5 个字段 `fix`。
       *
       * ## 为什么只给这 8 式加（不是 23 式全加）
       *
       * 2026-10-23 真实出图对照（`dev_tmp/ab_pose/05`、`07`）：
       * · 腿架肩式：不补 = 头身倒置折成一团；补了就画对 —— **是崩坏与正确之间的差别**。
       * · 汤匙式 / 扶手椅式 / 反骑式：现行骨架本来就画对，补了三要素**几乎没有可见收益**。
       * ⇒ 全量重写 23 式＝把 20 个本来对的改一遍，风险大于收益。
       *
       * ## fix 写什么（判据）
       *
       * 只补三样，其余一律不写：**头/脸朝向 + 谁承重 + 进入方向**。
       * 缺这三样时模型会用「整体旋转」去凑空间（腿架肩被转 180° 就是这么来的）。
       * 不加形容词、不加氛围词 —— 那些画不出来。
       *
       * 只在几何**反直觉**时才需要：躯干折转超过 90°、有一方完全离地、
       * 或需要限制四肢位置。强先验体位（missionary / doggystyle / cowgirl）写了反而占额度。
       */
      ['legs on shoulders', '腿架肩式', 'she on her back, both calves hooked over his shoulders, he grips her ankles, her hips lifted off the bed', 'Eagle',
        'Her head and shoulders stay flat on the bed with her face turned up toward him the whole time, her upper back takes her weight, and he enters from above, angled down.'],
      ['jackknife', '折刀式', 'she on her back, both knees pulled to her chest by her own hands, folded in half, he kneels and enters straight down', 'Jackknife',
        'Her head and shoulders stay on the bed with her face turned up, her hips and lower back take her weight, and he enters from straight above, pressing down.'],
      ['butterfly', '蝴蝶式', 'she on her back at the bed edge, both legs lifted high and opened wide, he stands on the floor and enters from above', 'Butterfly',
        'Her head and shoulders are on the mattress with her face turned up, her back on the bed takes her weight, he stands on the floor below the bed edge and enters from above.'],
    ],
  },
  {
    key: 'rear',
    zh: '后入类',
    en: 'she in front, he behind her',
    skeleton:
      'She is on all fours / bent over / kneeling with her back arched and her hips raised; he is behind her, '
      + 'one hand on her hip, the other either on her lower back or reaching around to her front; '
      + 'entry from behind and slightly downward.',
    poses: [
      ['doggystyle', '狗爬式', 'she on all fours, back level and hips raised, he kneels behind her gripping her hip', 'Doggy'],
      ['lazy doggy', '懒后入', 'she lies flat on her stomach with both legs together, he lies on top of her back and enters from behind', 'Lazy Doggy'],
      ['kneeling rear entry', '跪姿后入', 'both kneel upright, her back against his chest, he holds her waist and enters from behind', 'Kneeling Doggy'],
      ['standing bent over', '拱背式', 'she stands bent forward with both palms on the floor, back arched and hips up, he stands behind her holding her waist', 'Arch',
        'Her head hangs low between her arms facing the floor, both palms flat on the floor take her weight, and he stands behind her entering from behind at hip height.'],
    ],
  },
  {
    key: 'cowgirl',
    zh: '女上位类',
    en: 'she on top, he below her',
    skeleton:
      'He lies on his back (or sits); she straddles him and controls the movement herself; '
      + 'her knees are on either side of his hips and her hands rest on his chest or the surface; '
      + 'entry from above, she lowers onto him.',
    poses: [
      ['cowgirl', '女牛仔式', 'he on his back, she straddles him facing him, knees on either side of his hips, hands on his chest', 'Cowgirl'],
      ['reverse cowgirl', '反骑式', 'he on his back, she straddles him with her back to him, both hands on his knees', 'Reverse Cowgirl'],
      ['squatting cowgirl', '深蹲式', 'he on his back, she squats above him with her knees wide open, hands on his chest', 'Squatting'],
      ['lotus', '莲花式', 'he sits cross-legged, she sits on his lap facing him with both legs wrapped around his waist, both sitting upright', 'Lotus'],
    ],
  },
  {
    key: 'seated',
    zh: '坐位类',
    en: 'he seated, she on his lap',
    skeleton:
      'He sits on a chair, a bed edge or the floor with his back supported or his hands braced behind him; '
      + 'she sits on his lap, facing him or facing away, her feet on the floor taking her own weight; '
      + 'entry from below, she rises and lowers.',
    poses: [
      ['seated facing', '扶手椅式', 'he sits on the bed edge with both hands braced behind him, she sits facing him on his lap with her feet on the bed', 'Armchair'],
      ['seated reverse', '王座式', 'he sits on a solid chair with his legs apart, she sits on his lap with her back against his chest, he holds her waist and lifts her', 'Throne'],
    ],
  },
  {
    key: 'side',
    zh: '侧位类',
    en: 'both lying on their sides',
    skeleton:
      'Both lie on their sides, close together; how their legs interlock decides the angle — '
      + 'one of her legs is lifted or hooked over his waist; entry from the side.',
    poses: [
      ['spooning', '汤匙式', 'both lie on their sides, her in front and him behind, he wraps one arm around her waist and lifts her top leg', 'Spooning'],
      ['spooning leg up', '抬腿汤匙式', 'both lie on their sides, he lifts her upper leg and hooks it over his waist, he holds her thigh', 'Spooning Leg Up'],
      ['face-to-face sideways', '面对面侧躺', 'both lie on their sides facing each other, their legs tangled together, entry from the front', 'Sideways'],
    ],
  },
  {
    key: 'standing',
    zh: '站立 / 悬空类',
    en: 'both standing, or one of them lifted',
    skeleton:
      'Someone has to carry the weight — a wall, a windowsill, a counter or his arms. '
      + 'State who is standing on the floor and who is lifted; never both airborne.',
    poses: [
      ['standing facing', '面对面站立', 'he stands with one of her legs lifted and braced on his hip, her back against the wall, his hands under her thigh and at her waist', 'Standing Face-to-Face'],
      ['standing rear entry', '背后站立', 'she stands facing the wall with both palms flat on it, back arched and hips out, he stands behind her holding her hip', 'Standing from Behind'],
      ['against the wall', '靠墙托举式', 'he lifts her with her back flat on the wall, her legs wrapped around his waist and her arms around his neck, his hands under her hips', 'Against the Wall',
        'Her back is flat against the wall and her face is beside his, the wall and his two palms under her hips carry her whole weight, her feet never touch the floor, and he enters from the front while standing.'],
      ['koala carry', '考拉式', 'he stands holding her up, her legs locked around his waist and her arms around her neck, his palms under her hips', 'Koala',
        'She faces him with her cheek against his, his two palms under her hips carry her whole weight, her feet are off the floor, and he enters from the front while standing.'],
    ],
  },
  {
    key: 'inverted',
    zh: '倒立 / 杂技类',
    en: 'she is inverted, weight on her shoulders',
    skeleton:
      'Her weight is on her shoulders or her hands; his hands hold her hips or thighs and control the movement; '
      + 'entry from above or from below — say which.',
    poses: [
      ['shoulder stand', '肩倒立式', 'she lies on her back with her pelvis lifted and both legs straight up, he kneels facing her and holds her thighs', 'Shoulder Stand',
        'Her head and both shoulders stay on the bed facing up and her shoulders carry her weight while her hips and legs are raised, he kneels at her hips and enters from underneath her raised pelvis.'],
      /**
       * ★★★ `reverse bridge` 故意**没有** fix（v0.9.136，三版实测全部失败，已撤）：
       *   ① `Both her palms and both her feet are planted on the bed carrying her weight…` → 脚悬空，腿抬起来绕在他身上
       *   ② `Her knees are bent with both soles flat on the bed and both palms planted flat…` → 变成跪坐，膝盖承重
       *   ③ `She is held up by her own two feet and two palms, all four flat on the bed… upside-down U` → 脚又悬空
       *   证据图：`dev_tmp/ab_fix/reverse-bridge.png`、`dev_tmp/ab_rb2/rb2_b.png`、`rb2_c.png`
       *   ⇒ 模型画不出「双脚掌踏床的反弓桥」，加 fix 只是白占 token。要恢复必须先有能画对的写法 + 出图。
       */
      ['reverse bridge', '反向桥式', 'she braces on her hands and feet with her body arched into a bridge, belly up, he kneels under the arch', 'Reverse Bridge'],
    ],
  },
];

/** 摊平成一张「体位名 → 骨架」的查找表（键统一小写）。 */
export const POSE_BY_NAME = (() => {
  const map = {};
  for (const c of POSE_CLASSES) {
    for (const [en, zh, sk, orig, fix] of c.poses) {
      map[en.toLowerCase()] = { en, zh, sk, fix: fix || '', orig, cat: c.key, catZh: c.zh };
    }
  }
  return map;
})();

/** 带 `fix`（三要素补充句）的体位名列表 —— UI 与测试用。 */
export const POSE_FIX_NAMES = Object.values(POSE_BY_NAME)
  .filter((p) => p.fix)
  .map((p) => p.en);

/** 按类 key 取该类（找不到返回 null）。 */
export function poseClassOf(key) {
  return POSE_CLASSES.find((c) => c.key === key) || null;
}

/** 全部英文体位名（测试与 UI 用）。 */
export function poseNames() {
  return POSE_CLASSES.flatMap((c) => c.poses.map((p) => p[0]));
}

/**
 * 生成注入 prompt 的英文表（markdown）。
 *
 * 形态刻意做成「**挑一个**，然后照抄骨架」——写成清单会让模型逐项打勾、
 * 一个格子塞三四种体位（那条实测教训写在 spec 的自检段里）。
 *
 * @param {{fix?: boolean}} [opts]
 *   `fix !== false` 时，带三要素的词条会在骨架后面多一句
 *   「头/脸朝向 + 谁承重 + 进入方向」（只有 8 个几何反直觉的体位有）。
 *   关掉后与 v0.9.135 的表逐字一致。
 */
export function poseTableForPrompt(opts = {}) {
  const withFix = opts.fix !== false;
  const lines = [
    '| pose class | write this pose word | then copy this skeleton |',
    '|---|---|---|',
  ];
  for (const c of POSE_CLASSES) {
    c.poses.forEach(([en, , sk, , fix], i) => {
      const body = withFix && fix ? sk.replace(/[.。]$/, '') + '. ' + fix : sk;
      lines.push('| ' + (i === 0 ? '**' + c.zh + '**' : '') + ' | `' + en + '` | ' + body + ' |');
    });
  }
  return lines.join('\n');
}

/**
 * 类骨架：告诉模型「即使没挑表里的具体式，也必须按这套结构写」。
 * 这样表只覆盖 23 式，剩下 85 式的结构也能被约束到。
 */
export function poseClassSkeletonsForPrompt() {
  return POSE_CLASSES.map((c) => '· **' + c.zh + '** (' + c.en + '): ' + c.skeleton);
}
