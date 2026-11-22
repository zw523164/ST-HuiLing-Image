/**
 * 机位角度 / 人称库 —— 让**同一个体位动作**在不同格、不同图里不呆板。
 *
 * ▍为什么要这个模块（2026-11-01 用户报障）
 *   「感觉应该也和体位+视角角度有关，有些角度很难画出来，还有就是景别机位方面，
 *    感觉我们现在视角很单调。模型好像不会自己用一些其他视角构图，例如 POV 这种。
 *    导致成人剧情画面很单调」
 *
 * ▍改之前的实况（读代码取证，不是推测）
 *   · `mossMangaPage.js` 的 `FRAMING_PIN` 只有 `face` / `detail` / `full` 三档
 *     —— 那是**景别**（画面里放多少），跟**机位角度**（镜头站在哪）是两个轴。
 *   · 版式库里的 `slot.shot`（`environment`/`face`/`upper`/`detail`/`full`）
 *     只用于「选哪个版式」（`faceFitOf` / `shapeFitOf`），**一个词都不进 caption**。
 *   · `mossJsonLayout.js` 的 `ANGLE_SENTENCES` 只有 3 句，而且**只给补格空镜**用，
 *     故事格永远拿不到。
 *   ⇒ 三个轴里只有「景别」有约束，「机位」和「人称」完全没有 ⇒ 模型每格都用自己的先验，
 *     同一个体位连出几格就是同一个机位。这就是「呆板」的机制原因。
 *
 * ▍档位从哪来（照抄官方，不自己发明）
 *   `AINIMA漫画台/references/R18-MANGA.md`
 *     §5「镜头」表：双人动作 `side view, full body`／单人表情 `upper body`／
 *                    器官特写 `no faces`／**不要**小格里用 `xclose`；一页最多一个 `xclose`
 *     §5「再加的 tag 和构图怎么对应」：更近 `upper body`、七分身 `cowboy shot`、
 *                    低角度 `from below`、摇晃 `dutch angle`、逆光 `backlighting`
 *     §9.4「机位与姿势」：`pov` `pov hands` `pov crotch` `character pov`（第一人称）、
 *                    `from below` `from behind` `dutch angle` `backlighting`、
 *                    `cowboy shot` `upper body` `full body` `feet out of frame`
 *     §9.4 对 `pov` 的备注原文：**「第一人称；`pov` 时男方只出手和下身」**
 *
 * ▍但**词不能照搬**（项目自己的实拍结论）
 *   `mossJsonLayout.js:166`：「抽象景别词（`wide shot` / `close-up` / `from above`）
 *   全部无效，必须写『镜头在哪 + 画面里有什么』」（`ab_pose/08_景别与机位.png`，10 张对照）。
 *   ⇒ 这里每个档位存的都是一句**具体机位句**：镜头站在哪 + 画面里哪样东西在近处 + 谁挡住谁。
 *     `from below` 这类抽象 tag 只当内部 id，不直接进提示词。
 *
 * ▍两条硬约束（项目里已有同类病例，别踩第二次）
 *   ① **一格里出现两次机位句 = 模型取平均**（记忆：「两条规则互相抵消时模型只挑一条听」）
 *      ⇒ 调用方必须保证**一格只追加一次**，不能每个人物项各加一份。
 *   ② **POV 格的男方不能建 character 项**（官方：pov 时男方只出手和下身）。
 *      按「通高人物本人不建 character 项」的经验（`mossMangaPage.js:812`），
 *      一旦给他建项，模型一定在画面里再安排一个完整的人。
 *      ⇒ 本模块只给出「这格是 pov」这个事实，**摘除人物质是调用方的事**（见 `isPov`）。
 */

/**
 * 机位档位表。
 *
 * 字段：
 *   cn         中文名（警告/日志用）
 *   sentence   要写进 caption 的具体机位句（英文，MOSS 更认英文）
 *   framings   能和哪些景别搭配（`face`/`upper`/`full`/`detail`）
 *   needsMale  需要画面里有男性
 *   needsNsfw  只在成人向画面里用（怕把日常戏拍成第一人称怪异构图）
 *   firstPerson 只给第一人称叙事用
 */
const DEF = {
  pov: {
    cn: '第一人称 POV',
    /**
     * ★★★ 用户 2026-11-01 04:11 澄清：
     *   「我说的 POV 视角是带入男主视角和女主互动的视角，不是男主作为第三方看着的视角。」
     *   ⇒ 句子必须同时写两件事：**眼睛就在那个人身上**（不是旁观机位），
     *     以及**两人近到贴在一起**（能伸手碰到）。只写「looking down at the other」
     *     会退化成「站在旁边看」——那正是 r1/r3 失败的形态之一。
     *
     * ★★★ 落地前提（r1/r3 实测，4/4 次）：**只加句子必然失败**。
     *   男方的人物质段必须同时换成「只有前臂 + 小腹以下」，否则模型照旧画出他的整张脸。
     *   调用方拿到 `isPov()` 为真时，必须自己摘掉那个人的完整人物质。
     *
     * ★ 句子**不指名性别**：档案里 `sex` 大量为空，判不出性别
     *   （`consistency.js:1977` 已有教训：「猜错性别比不写更糟」）⇒ 谁在看由调用方定。
     */
    sentence: 'The picture is taken from that one person\'s own eyes, inside the embrace, looking down along'
      + ' their own body: their forearms and their lap are the nearest things in it and lie across the bottom'
      + ' edge of the picture, and the other person is right up against them, close enough to touch, filling'
      + ' the rest of the picture from the middle up.',
    /**
     * ★★★ 只给 `upper` / `detail`，不给 `full` —— 全身景别里的第一人称是不可能的
     *   （自己的全身不可能出现在自己的视野里）。
     *
     * ★★★ 还有一个**几何前提**，写法改不动它（`pose_pov` m2，四个体位各一张）：
     *   骑乘式 ✅ 成立（他躺着，头在镜头外，只能看到她的手/腿与她的正脸）；
     *   传教士 / 后入 / 站立 ❌ 三次全失败 —— 因为这三个体位里"视角主人"的头
     *   **必然落在画面里**（他俯身在她上方 / 他在她身后上方 / 面对面站在她面前）。
     *   ⇒ 调用方要在这三个体位下用 POV，必须**另加一条把画面上缘压到他胸口以下**，
     *     即把景别降到 `detail`。只靠 `pov` 这一句，模型一定会把他的脸画回来。
     */
    framings: ['upper', 'detail'],
    needsPartner: true,
  },
  below: {
    cn: '低机位仰拍',
    /**
     * ★★★ r1 实测失效（`dev_tmp/viewpoint/SHEET_r1_s20261101.jpg` 第 2 行左）：
     *   旧句 `The camera sits on the floor below their hips … the far wall rises behind them`
     *   里两个要素**都不在画面内**（地板、远墙），模型无从下笔 ⇒ 画出来与「不加机位」几乎一样。
     *   r2 改成点明「画面下缘是什么、两侧是什么」—— 只写画得出来的东西。
     */
    sentence: 'The picture is taken from low on the floor, so its bottom edge is bare floor boards in'
      + ' front of the bodies and the two of them rise upright above that, with their heads near the top'
      + ' edge of the picture.',
    framings: ['face', 'upper', 'full', 'detail'],
  },
  above: {
    cn: '高机位俯拍',
    /**
     * r1 失效：旧句说的是「她的肩在前景」，但她的肩根本不在那张构图里。
     * r2 改成「画面上缘/下缘分别是什么」，把它能看见的部位点出来。
     */
    sentence: 'The picture is taken from just above her head, so her upturned face fills the bottom part'
      + ' of the picture looking straight up at us, her raised knees and chest come next above it, and his'
      + ' body is the furthest thing in the picture beyond her knees.',
    framings: ['face', 'upper', 'full', 'detail'],
  },
  side: {
    cn: '侧面平视',
    sentence: 'The camera stands off to one side level with their hips and looks straight across, so'
      + ' both bodies are seen in profile and neither one hides the other.',
    framings: ['upper', 'full', 'detail'],
  },
  /* `overhead`（正上方俯视）已删：
     r1「the mat itself fills the whole frame」/ r2「someone standing on the ceiling sees…」
     两个 seed 都没俯下来，而 `above`（从她头顶上方往下）实测成立 —— 两档在模型那里是同一件事，
     留两档只会让轮换重复。
     `dutch`（整幅倾斜）同样已删，三轮三种写法一次都没歪出来，位置让给 `front`。 */
  /* `behind`（过肩 / 背后）已删 —— 四轮全灭，而且最后一种写法闯了更大的祸：
     「画面最近处是他的后脑勺、在右下角」被模型读成**第二个人的头**，
     `pose_pov/miss-behind2_*.png` 右下角真的多出一颗头（叠加「同一对象写两次＝画两份」的老规律）。
     ⇒ 这一档不是「换个说法就能用」，是**MOSS 拿不到「背面视角」这个概念**：它只能靠
       「画面里出现某人」来定位镜头，而一出现「某个人的某部位」就会多画一个人。 */
  front: {
    cn: '正面（从脚那端）',
    /**
     * ★ 这一档是**替换 `dutch` 进来的**。
     *   `dutch`（整幅倾斜）三轮三种写法，一次都没歪出来（r1 抽象 / r2 点名窗框与垫边 /
     *   r3 给坡度与不平行）⇒ 判死，不留"能用的档位"占位。
     *   换成成人图里真正有用的正面机位：从她脚那一端沿身体往上看，
     *   脚与膝盖是最靠近镜头的东西，他在更远处正对镜头。
     */
    sentence: 'The picture is taken straight along her body from her feet toward her head, so the soles of'
      + ' her feet and her raised knees are the nearest things in the picture and his body is beyond them'
      + ' turned toward the camera.',
    framings: ['upper', 'full', 'detail'],
  },
};

/**
 * 固定顺序（轮换就按这个顺序循环，保证可复现，不用 random）。
 * 顺序是按**实测可信度**排的：最前面两档是每一轮都稳定生效的，POV 放最后（要显式开门）。
 */
export const VIEWPOINT_IDS = ['side', 'above', 'below', 'front', 'pov'];

/** 把草稿里的 `shot` 归一到四个景别档。与 `mossMangaPage.js` 的 `framing` 同口径。 */
export function framingOfShot(shot) {
  const s = String(shot == null ? '' : shot).trim().toLowerCase();
  if (s === 'face') return 'face';
  if (s === 'detail') return 'detail';
  if (s === 'full' || s === 'action') return 'full';
  return 'upper';
}

/**
 * 这一档机位在**这个景别 + 这个场面**下能不能用。
 * @param {string} id
 * @param {{framing?:string, partner?:boolean, povOk?:boolean}} env
 */
export function allowedViewpoint(id, env) {
  const d = DEF[id];
  if (!d) return false;
  const framing = env && env.framing ? String(env.framing) : 'upper';
  if (Array.isArray(d.framings) && !d.framings.includes(framing)) return false;
  if (d.needsPartner && !(env && env.partner)) return false;
  /* ★ POV 是**要显式开门**的档：调用方必须能承担「只画手和下身」这个代价才给开。
     漫画页那条路要按格摘人物项，目前做不到 ⇒ 那边传 false。 */
  if (id === 'pov' && !(env && env.povOk)) return false;
  return true;
}

/** 某个景别下可用的机位清单（固定顺序）。 */
export function verbsFor(env) {
  return VIEWPOINT_IDS.filter((id) => allowedViewpoint(id, env));
}

/** 取一个档位的完整信息（含要写进 caption 的句子）。未知 id 返回 null。 */
export function viewpointById(id) {
  const d = DEF[id];
  if (!d) return null;
  return { id, cn: d.cn, sentence: d.sentence };
}

/** 这一格是不是第一人称（POV）—— 调用方据此摘掉男方的人物质。 */
export function isPov(vp) {
  return !!(vp && vp.id === 'pov');
}

/**
 * 一组画面（一页的多格 / 连续多张）的机位安排。
 *
 * 分配规则（全部确定性，无 random —— 端到端测试要能复现）：
 *   ① 只看「这一格有没有人」；空镜格拿 `null`（空镜不需要机位，机位句只会给它添人）。
 *   ② 按 `VIEWPOINT_IDS` 的固定顺序轮转，**相邻两格不许同档**（用户要的「不呆板」就是这条）。
 *   ③ `offset` 用来跨页/跨图接续：第 2 页从第 1 页停下的下一档开始，
 *      否则每页都从 `side` 起头，翻三页又是三张侧面。
 *   ④ `avoid` 是「最近已经用过的档位」（GAL 连续出图用），优先跳过。
 *
 * @param {object} opts
 * @param {number} opts.count            画面数
 * @param {(i:number)=>string} [opts.framingAt] 每格的景别，返回 `face`/`upper`/`full`/`detail`
 * @param {(i:number)=>boolean} [opts.occupiedAt] 这格有没有人（默认全有）
 * @param {boolean} [opts.partner]  画面里有没有第二个人（POV 需要）
 * @param {boolean} [opts.povOk]    允许用 POV（默认 false，见 `allowedViewpoint`）
 * @param {number}  [opts.offset]
 * @param {string[]}[opts.avoid]
 * @returns {Array<null|{id:string,cn:string,sentence:string}>}
 */
export function planViewpoints(opts) {
  const o = opts || {};
  const count = Math.max(0, Math.round(Number(o.count) || 0));
  const framingAt = typeof o.framingAt === 'function' ? o.framingAt : () => 'upper';
  const occupiedAt = typeof o.occupiedAt === 'function' ? o.occupiedAt : () => true;
  const avoid = Array.isArray(o.avoid) ? o.avoid.filter((x) => !!DEF[x]) : [];
  const offset = Math.max(0, Math.round(Number(o.offset) || 0));

  const out = new Array(count).fill(null);
  let cursor = offset;
  let lastId = avoid.length ? avoid[avoid.length - 1] : '';

  for (let i = 0; i < count; i += 1) {
    if (!occupiedAt(i)) { out[i] = null; continue; }
    const env = {
      framing: framingAt(i),
      partner: !!o.partner,
      povOk: !!o.povOk,
    };
    let pool = verbsFor(env);
    if (!pool.length) { out[i] = null; continue; }

    /* 避开「最近用过的」—— 池子够大才避，否则会把唯一的可选档也避掉。 */
    const fresh = pool.filter((id) => !avoid.includes(id));
    if (fresh.length) pool = fresh;

    /* 扫一圈找第一个 ≠ 上一格的档。 */
    let picked = '';
    for (let k = 0; k < pool.length; k += 1) {
      const id = pool[(cursor + k) % pool.length];
      if (id !== lastId || pool.length === 1) { picked = id; cursor = (cursor + k + 1) % Math.max(1, pool.length); break; }
    }
    if (!picked) picked = pool[0];
    if (!out[i]) out[i] = viewpointById(picked);
    lastId = picked;
  }
  return out;
}

/**
 * 单张（GAL / 单图）用：从最近没用的档位里挑一个。
 *
 * 与 `planViewpoints` 分开是因为单张没有「同一页的其他格」，只有「上一张用了什么」。
 * @param {object} opts 同 `planViewpoints` 的 env 字段 + `avoid`
 * @returns {{id:string,cn:string,sentence:string}|null}
 */
export function pickViewpoint(opts) {
  const o = opts || {};
  const env = { framing: o.framing || 'upper', partner: !!o.partner, povOk: !!o.povOk };
  const pool = verbsFor(env);
  if (!pool.length) return null;
  const avoid = Array.isArray(o.avoid) ? o.avoid : [];
  const fresh = pool.filter((id) => !avoid.includes(id));
  const use = fresh.length ? fresh : pool;
  return viewpointById(use[0]);
}

/**
 * 从一段最终提示词里反查「它用的是哪一档机位」。
 *
 * 为什么要反查而不是一路带着变量走：写词与落库隔着模型调用（`galBridge.generate`），
 * 中间任何一处漏传就会记错。提示词里带着那句原文，从原文反查是唯一不会失真的一条。
 * @returns {string} 机位 id；认不出返回 `''`
 */
export function angleOfPrompt(prompt) {
  const s = String(prompt == null ? '' : prompt);
  if (!s) return '';
  for (const id of VIEWPOINT_IDS) {
    const d = DEF[id];
    /* 只比对句子的**前半截**（后半截可能被模型改写标点）。 */
    const head = d.sentence.slice(0, 48);
    if (head && s.includes(head)) return id;
  }
  return '';
}
