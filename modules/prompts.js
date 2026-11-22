/**
 * 绘灵 · 提示词构造
 *
 * 分层拼装（分层拼装的做法）：
 *   system   = 职责提示 + 一致性规范 + 输出协议 + 破限（可选）
 *   user     = 角色档案库 + 历史楼层 + 目标正文（带 ⟦P编号⟧）+ 任务说明
 *
 * 分层的好处：用户改画风规范时，不会意外破坏 JSON 输出协议。
 */

import { getActiveTemplate, getConfig, activeEngine, activeOutput } from './settings.js';
import { renderIndexed, cleanBody, cleanBodyLines, storyLineCount, sceneFactLines } from './util.js';
import { renderLibraryText } from './consistency.js';
import { HAIR_STATE, MAKEUP_SMUDGE } from './appearanceLibrary.js';
import {
  getCharName, getUserName, getCharDescription, getPersonaDescription,
  getCharWorldBookText, getGlobalWorldBookText,
} from './st.js';
import { OUTFIT_STATE_LABEL } from './settings.js';
import { listPendingProfiles, resolveOutfitStyle, recentImageBriefs, autoOutfitDimsOn } from './store.js';
import { buildMossDirective, buildMossJsonDirective, buildMossSingleJsonDirective, mossAdultOn, mossAdultForced, mossSfwOn, normalizeMossEnhance, normalizeMossCover, mossCoverPlan } from './mossLayout.js';
import { poseTableForPrompt, poseClassSkeletonsForPrompt } from './poseLibrary.js';
/** v0.9.186：漫画台原生口径的形态指令 */
import { buildMangaDirective } from './mossMangaNative.js';
import { canvasOf } from './mossJsonLayout.js';
import { mangaLayoutOf } from './mossMangaLayouts.js';
import { OUTFIT_STATE_DETAILS, OUTFIT_MODS, OUTFIT_SHOES } from './outfitStateLibrary.js';

/**
 * 服装三维度的**出厂档名清单**（给扫描模型看）。
 * 只列档名 + 一句极短的中文说明，够模型选就行 —— 扫描请求是每楼必跑的轻量请求，
 * 把英文整句也塞进去等于每楼多花几百 token，而英文由插件自己按档名取，不需要模型写。
 */
function dimListText(items, lead) {
  const keys = (items || []).map(x => x?.key).filter(Boolean);
  return keys.length ? `${lead}：${keys.join(' / ')}` : '';
}

/** 角色档案库 + 状态位图例（图例短，省 token）。 */
function legend() {
  const states = Object.entries(OUTFIT_STATE_LABEL)
    .map(([k, v]) => `${k}=${v}`)
    .join('  ');
  return `状态位图例：${states}`;
}

/**
 * 全量档案名单：优先 p.fullNames（pipeline 传入的全量快照名单），
 * 退回 p.snapshot 自身的名字。返回字符串数组。
 *
 * 用途：世界书关键词、待建档（pending）判断 —— 这两件事都必须看**全量**：
 * 快照被在场预筛裁剪后，「被裁掉 ≠ 不存在」，拿裁后名单判断会让
 * 已建档角色被误判为待建档 → 模型每轮重复建档。
 */
function nameListFor(p = {}) {
  if (Array.isArray(p.fullNames) && p.fullNames.length) {
    return p.fullNames.map(x => (typeof x === 'string' ? x : x?.name)).filter(Boolean);
  }
  if (Array.isArray(p.snapshot)) {
    return p.snapshot.map(x => (typeof x === 'string' ? x : x?.name)).filter(Boolean);
  }
  return [];
}

/**
 * 剧场上下文：角色卡 / 用户设定 / 世界书。
 *
 * ★ 这是「出图跟剧情对不上」的第二层根因 —— 原来只把正文丢给模型，
 *   它不知道主角是谁、这个世界什么规矩，只能凭几百字脑补。
 *   把这三项拆成独立 system 段压在规范之前的，这里照做。
 *
 * 每项独立开关 + 统一截断：长角色卡配大世界书会把请求撑爆，
 * 小模型窗口不够时按项关掉，而不是一刀切全砍。
 */
function buildContextBlocks(cfg, p = {}) {
  const ctxCfg = cfg?.context || {};
  const maxChars = Number(ctxCfg.maxChars) || 4000;
  const cut = (s) => {
    const t = cleanBody(String(s || '')).trim();
    if (!t) return '';
    return t.length > maxChars ? `${t.slice(0, maxChars)}\n…（已截断）` : t;
  };

  const blocks = [];

  if (ctxCfg.charCard !== false) {
    const name = getCharName();
    const desc = cut(getCharDescription());
    if (desc) {
      blocks.push(`【角色设定｜${name || '当前角色'}】\n${desc}\n`
        + '（这是出场人物的设定。画面里的外貌以【角色档案库】为准 —— 那里没有的字段才看这里。）');
    }
  }

  if (ctxCfg.persona !== false) {
    const persona = cut(getPersonaDescription());
    if (persona) {
      blocks.push(`【用户设定｜${getUserName() || '用户'}】\n${persona}\n`
        + '（这是与角色对话的人。他出现在画面里时按此设定画，不要凭空换性别外貌。）');
    }
  }

  if (ctxCfg.worldBook !== false) {
    // 关键词 = 本楼出场人物名。世界书几万字，按相关性排序后截断，
    // 才能保证喂进去的是"月咏深雪人设"而不是排在前面的变量模板。
    // v0.9.38：优先用 fullNames（全量名单）—— 快照可能被在场预筛裁剪，
    // 世界书关键词按全量给，召回才不会漏（多给关键词只是多召回几条，无害）。
    const kw = nameListFor(p).filter(Boolean);
    const wb = cut(`${getCharWorldBookText({ keywords: kw }) || ''}\n${getGlobalWorldBookText({ keywords: kw }) || ''}`);
    if (wb.trim()) {
      blocks.push(`【世界设定】\n${wb.trim()}\n`
        + '（世界观与场景规矩。画面里的地点、服饰风格、时代感要与之相符。）');
    }
  }

  return blocks;
}

/**
 * 主分析请求。
 *
 * @param {object} p
 * @param {string} p.body        目标楼层正文（已清洗）
 * @param {string[]} p.history   最近 N 个 AI 楼层正文（已清洗）
 * @param {Array}  p.snapshot    档案库快照
 * @param {object} p.cfg
 * @param {number} p.round
 * @returns {Array<{role,content}>}
 */
/**
 * 「成人画面优先」指令段（v0.9.82）· 只在用户打开开关时才追加。
 *
 * 病例（2026-10-10 用户报「成人情节的图跟正文八竿子打不着」）——实测 P91/P68 的提示词：
 *   - `his other hand working between her thighs`  ← 模糊动词，画面上什么都看不出来
 *   - 两人各写一句完整主谓宾  ← §3.9 ③.1 明令禁止，是器官错位 / 多肢体的头号来源
 *   - 没写插入方向、没写 `hips aligned`  ← §3.9 ③.2/③.4 的必写项
 *   而裸露部分写得很实（wet pussy exposed…）——说明 NSFW 板块**确实启用了**，
 *   根因不是判定没触发，是模型在姿态段自我降级、并退回了旧的「两人各写各的」口径。
 *
 * 所以这里**不改规范本身**（§3.9 已经写对了），只在最靠近输出的位置再钉一遍判定与写法，
 * 补上被漏掉的那一条「不许用模糊动词」。全部是对既有要求的复述，不新增互相打架的约束。
 */
function adultPriorityBlock() {
  return [
    '11. ★★ 成人画面优先（本会话已由用户开启 —— 优先级高于上文的保守处理倾向）',
    '   ① 判定放宽：正文出现明确的性行为、性器官接触、或隐私部位裸露（露点 / 下体暴露）',
    '      → 判定为成人画面，启用 NSFW 板块 §3.9。不要因为"拿不准"就退回 SFW。',
    '   ② 配图名额优先给正在发生的成人动作本身 —— 不要挑空镜、环境或事后余韵。',
    '   ③ 姿态写实（★ 图跟正文对不对得上，全看这一条）：器官 + 部位 + 方向，一次写死。',
    '      - 插入方向（from behind / from the front / from below …）必写，且只声明一次；',
    '      - 双人下身相接必写 `his hips aligned with hers`（或同义一句）；',
    '      - 🚫 禁止用委婉 / 模糊动词代替实际动作：working between her thighs、touching her、',
    '        intimacy、closeness、pleasuring、caressing —— 画面上什么也看不出来，等于没写。',
    '   ④ 一图一个主动几何：姿态由一人作主语，对方只作从属从句',
    '      （`his hands gripping her waist as he drives into her from behind`）；',
    '      禁止两人各写一句完整主谓宾（模型会各画一份几何 → 多肢体 / 器官错位）。',
    '   ⑤ 不必回避直白措辞：这是成人向创作，解剖学名词与动作写实是允许且被要求的，',
    '      回避只会让画面和正文对不上。合规硬边界（未成年 / 非自愿）仍照 §3.9 ① 执行。',
  ].join('\n');
}

/**
 * 「成人画面写法」· **MOSS 口径专属**（v0.9.125）。
 *
 * 为什么不复用上面的 adultPriorityBlock()：
 *   K2 那段的前提是「@角色名 展开锚点 + 单串 tag」，**MOSS 两版都不成立**
 *   （纯 prompt 版人物段由插件注入、JSON 版靠 bbox 定位）。直接照搬会犯两类错：
 *     · 把 `his hips aligned with hers` 这类**相对方位词**塞进 Layout 的 caption
 *       ——相对词在 bbox 体系里没有落点，模型只能自己猜两人的几何；
 *     · 把「一条 tag 写完」的写法带进多格，**每格都写一遍完整动作** = 每格都多画一份。
 *   而 MOSS 里真正决定手脚会不会被切掉的是**框高**，不是措辞 —— 所以这段必须重写。
 *
 * 病例（2026-10-21 · 楼 144 / 162 真实出图，六张里五张肢体被格线切断）：
 *   ① 上格 object 只有 0.3H（画布 1152 → 345px），character 的 caption 却写
 *      `thighs pressed together around his hips, one knee turning inward` →
 *      膝盖以下画到格线外，被裁成断腿；
 *   ② 同一张图的上格 object caption 是 `extreme close-up at hip level`，
 *      却挂了两个全景 character → 画出一个**没有头的下体碎块**
 *      （正是官方 §13.1「不要用脸大小的框承载全身」说的错法）；
 *   ③ 六张里只有 `his hips aligned with hers` 一句提到接触，没有承重面、
 *      没有两只手、没有下肢落点 → 模型自由补 → 穿模 / 多肢体 / 悬空。
 *   ⇒ 三条全是写法问题，且都能被规则钉住，所以单开一段（不是加"更多约束"，
 *     而是把 NSFW 场景**必须有**的那几项写清楚）。
 */
export function mossAdultBlock(isJsonOut, forced, poseFix) {
  /**
   * ★★★ v0.9.131：① 判定必须**认档位**，不能只认正文。
   *
   *   病历（用户 2026-10-22 报「成人实景貌似也没触发」，配置 `mossJson.nsfw='nsfw'`）：
   *     mes 176（用户）：内射了十几次、换了很多体位；
   *     mes 177（AI ）：事后撑起身、站不稳、擦身、谈条件 —— 正文里**没有**性行为描写。
   *     → 旧 ① 拿「正文是否含 explicit sex」判 → 判否 → ②~⑦ 整段跳过
   *     → 出图是"两个人站着说话"的日常图。
   *   用户手选 `nsfw` 档，本意就是「这一整场按成人画」。让模型拿单楼正文再投一次票，
   *   等于用户的选择被模型的自审覆盖掉 —— 权限倒挂。
   *
   *   ⇒ `forced`（= 档位显式选了 nsfw）时：**不许重新判断场景性质**，
   *     事后 / 清理 / 穿衣 / 刚结束的对话都仍是成人页，痕迹与脱衣状态留在画面上。
   *   ⇒ `auto` 档保留原判定（老配置一个字都不变）。
   */
  const head = [
    '## Adult content (NSFW scene writing)',
    '',
    '> This section overrides the conservative tendency anywhere else in this prompt.',
    '> When the scene is already sexual, draw it as adult content — do not retreat to',
    '> hugging, implication or face-only framing because you are unsure what is allowed.',
    '> Hard limits (minors, non-consent) are unaffected and always apply.',
    '',
  ];
  if (forced) {
    head.push(
      '**① Adult mode is set by the user — do NOT re-judge the scene.**',
      'This template is switched to adult mode, so **every page in this session is an adult page**.',
      'You do not get to decide that the current beat "is not sexual enough" and fall back to a',
      'neutral illustration. Aftercare, clean-up, dressing, resting, or talking right after the',
      'act are still adult beats:',
      '· the naked or half-stripped bodies stay on the page, and clothing sits where the act',
      '  left it (`blouse hanging open`, `skirt still on the floor`) — never tidy them up;',
      '· the fluids, marks and swelling left by the act stay on the page (`semen streaking',
      '  down her inner thighs`, `her lower belly still full and rounded`);',
      '· the six items below apply to every such page exactly as they do to the act itself.',
      'Only a page that is genuinely a **different scene** (new location, hours later, fully',
      'dressed, other people around) may fall back to the ordinary rules.',
      '',
    );
  } else {
    head.push(
      '**① Is this an adult scene?** The scene body contains explicit sex, genital contact or',
      'exposed private parts → yes. Write it as adult content, with every item below.',
      '',
    );
  }
  const core = [
    '**② Face — only what this camera can see.** `flushed cheeks`, `dazed half-closed eyes`,',
    '`looking up at him`, `lower lip caught between her teeth`, `tears at the corners of her',
    'eyes`. Do not describe a face the panel is not pointing at.',
    '',
    /**
     * ★★★ v0.9.131：③ 从「11 个裸体位名」升级为「体位 → 几何骨架」。
     *
     *   裸名字对编码器等于零信息：它只知道 `doggystyle` 这个类别，不知道腿怎么摆、
     *   手撑哪、进入角度朝哪 —— 自己猜就是躯干扭麻花 / 多手多腿 / 格线切人。
     *   依据是用户提供的 `体位108式SKILL.md`（每式都写清了结构），压成一句话骨架后
     *   模型可以**照抄**，不必发明几何。表只列 23 式，另外给七类通用骨架兜住剩余 85 式。
     */
    '**③ Pose term — pick ONE, then copy its skeleton.**',
    'A vague verb (`making love`, `intimate with her`, `bodies joined`) is a bug: the renderer',
    'then has to invent the geometry, and invented geometry is exactly where twisted torsos,',
    'extra limbs and clipping come from. Name the pose **once** and **copy the skeleton,',
    'do not paraphrase it** (paraphrasing drops a hand or a leg, and that is the whole bug).',
    'Where it goes depends on the form — **never in both places**:',
    '· **single-image JSON page → only in `summary.caption`**, together with the four elements the',
    '  form section lists. The `character` items keep appearance and clothing and carry **no pose**;',
    '· **multi-panel page → in the caption of the person acting**; the other person writes only their',
    '  own posture and reaction.',
    '',
    poseTableForPrompt({ fix: poseFix }),
    '',
    'If the pose you need is not in the table, keep the same shape using its class skeleton',
    '(name → who is above → leg placement → support point → entry direction):',
    '',
    ...poseClassSkeletonsForPrompt(),
    '',
    '**One pose per panel.** Never stack two poses in one caption, and never write a second',
    'pose for the other person — the person not acting writes only their own posture and',
    'reaction (see ⑦ "direction is stated once").',
    '',
    '**④ Body fluids — visible surface and state only.**',
    '`sweat`, `saliva`, `vaginal fluid`, `precum`, `semen`, `tears`. Say where it is and',
    'what it does: `sweat running down her spine`, `her inner thighs slick with fluid`,',
    '`semen pooling on her lower belly`, `saliva strung between her lips and his`.',
    'Never use `wet` or `aroused` as a mood word — they draw nothing.',
    '',
    '**⑤ Clothing boundary — no sex while dressed, no sudden full nudity.**',
    'Every garment that has left its place states all three: whose body it is still on,',
    'how far it was pushed, what it still covers.',
    '✅ `her white blouse pushed up above her chest and bunched at her collarbone`',
    '✅ `navy skirt and panties pulled down to mid-thigh, one leg still in them`',
    '🚫 `naked` / `topless` / `no bra` / `bottomless` / `naked from the waist down` **alone** —',
    'those are area words, not boundaries. Pair each of them with what is left on the body.',
    'If the scene is clothed, write `over the clothes, no skin contact`.',
    'If the scene does not say clothed, **never write penetration while the lower garment',
    'is still at her waist** — take it down to a stated position first.',
    '',
    '**⑥ Visible organs — an area word is NOT a part.**',
    'When the panel shows that region, name the part. `bare chest` / `crotch` /',
    '`between her legs` / `bare lower body` alone count as omission.',
    '',
    '| you were about to write | you must add |',
    '|---|---|',
    '| bare chest / cleavage / no bra | `nipples`, `areola` |',
    '| bare lower body / crotch | `erect penis rising from the exposed pelvis` |',
    '| spread legs / female lower body | `vulva`; in a close-up also `labia` or `clitoris` |',
    '| ass / anal visible | `anus` and its contact point |',
    '',
    'If hair, a hand or the camera angle clearly covers a part, write the occluder',
    '(`his forearm hiding her chest`) — never invent the part.',
    '',
    '**⑦ Pelvis anchoring and body mechanics — the anti-floating rules.**',
    /**
     * ★★★ v0.9.187：**器官必须出现在页面上**（用户 2026-11-01 报「男方无器官，光秃秃一片」）。
     *
     * 旧条款只写「已暴露的器官要接在裸露骨盆上」—— 这是个**条件句**：
     * 不写器官就不违规。于是模型写一句 `his hips bare` 就交差，
     * 实拍 03:05 三张男主全都只有 `his hips bare`，画面一片光滑。
     * 而 tail 里又把 `bared pelvis` 列进「可用的身份锚点」，等于给了它一个更省字的替代品。
     * ⇒ 补一条**无条件必须写**的：性行为/生殖器接触时，主动方器官要写出状态 + 位置。
     *   并明确 `bared pelvis` / `groin` 这类**不算**（编码器没有可画的东西）。
     */
    '· **The organ MUST be on the page.** When the action is sex or genital contact — or the',
    '  template is switched to adult mode — the acting partner\'s organ is written out with its',
    '  state and its position. `his hips bare`, `his bared pelvis`, `his groin` do **not**',
    '  count: there is nothing for the encoder to draw, and the result is a smooth blank.',
    '  ✅ `an erect penis rising from his bared pelvis, pressed against her wet vulva`',
    '  ✅ `the head of his penis lodged inside her` · ✅ `her vulva parted and glistening, his',
    '  shaft resting along her slit`',
    '  ⚠️ This is the one item that must never be replaced by a clothing boundary.',
    '· **Organ root**: an exposed penis or vulva must be attached to a bared pelvis, never',
    '  floating, never growing out of furniture — `an erect penis rising directly from his',
    '  bared pelvis`.',
    '· **Contact path**: touch / grip / penetration / oral must state the relative geometry,',
    '  not just the verb — `his hand pushed between her open thighs, gripping his shaft`,',
    '  `the head of his penis inside her vulva`.',
    '· **Height difference and gravity**: on a counter, bed edge or sofa, state who sits /',
    '  lies / stands / kneels and who is higher. Never two people on one level doing a',
    '  vertical insertion — `she sits on the edge of the sink, he stands between her legs`.',
    '· **Support point**: the hands of the person acting must have something to push against',
    '  — `both hands gripping the rim of the counter`, `one palm flat on the mattress beside',
    '  her head`. Never both hands in the air.',
    '· **Both hands need a stated position** — the one in use, and the other one',
    '  (`braced on the tiles`, `hanging at his side`). An unplaced hand gets drawn twice.',
    '· **A close-up must not eat the person**: it still needs one anchored limb or a bearing',
    '  surface of the passive partner — `between her open legs, her back resting on the',
    '  sofa`. A close-up holding nothing but organs means the furniture ate her.',
    '· **Direction is stated once**: `from the front` / `from behind` / `from below` /',
    '  `between her thighs` goes in the caption of the person acting — **or, on a single-image',
    '  JSON page, once in `summary.caption` instead** (never in both places, and never in',
    '  both character captions). The other person only',
    '  writes their own posture and reaction. Both sides writing their own geometry is',
    '  exactly how organs end up misaligned.',
    '· **No abstract relative words**: `bodies pressed together`, `close to each other`,',
    '  `intimacy`, `closeness`, `pleasure` draw nothing at all. Replace with part + direction:',
    '  `his hips against her lower belly`.',
    /**
     * ★★★ v0.9.188：**头部朝向必须由体位推出来**（用户 2026-11-01 04:10 报
     *   「测试的时候记得把女主头部视线也合理下，不然会出现奇怪的女主转头画面」）。
     *
     * 我自己的实验就踩了这个坑：四个体位**每条都写** `her head turned toward the camera`，
     * 结果仰躺那条也在扭头、四肢着地那条还在回头 ⇒ 出图是断颈感。
     * 根因不是模型不会画头，而是**「转向镜头」与体位无关**，等于让它凭空扭一个关节。
     *
     * 官方口径里 `looking back` 本身是合法写法（`R18-MANGA §9.4` 后入的搭配词里就有它），
     * 所以这里不禁回望，而是要求**整段上半身跟着转** —— 只写脖子转就是断颈。
     */
    '· **Head direction follows the body — never a free turn toward the camera.** It is derived,',
    '  not chosen: lying on her back → the head rests back and the face looks up; on all fours →',
    '  the cheek is down or turned to one side; sitting upright → the chin drops toward the',
    '  partner below her; back against a wall → the head tips back against it.',
    '  A head turned to the camera from an unrelated posture is the most reliable way to draw a',
    '  broken neck. If she really does look back over her shoulder, the chest and the shoulder',
    '  turn **with** the head — `her chest and shoulder turned together as she looks back over',
    '  it`. Never write only the neck turning.',
    /**
     * ★★★ v0.9.188：POV 的**写法口径**（用户 2026-11-01 04:11 澄清
     *   「我说的 POV 视角是带入男主视角和女主互动的视角，不是男主作为第三方看着的视角」）
     *   实验依据：`dev_tmp/viewpoint-ab.mjs` r1/r3 —— **只加机位句 4/4 次失败**
     *   （男主整张脸照旧在画面里）；只有同时把他的完整人物质换成「前臂 + 小腹以下」才成立。
     */
    '· **POV = the acting partner\'s own eyes, from inside the embrace** (not a bystander',
    '  watching). When the frame is first person, that person contributes **only forearms and',
    '  lap** to the page: no face, no head, no full-body character item for them. The other',
    '  person is written as right up against them, close enough to touch. Writing the full',
    '  appearance of the person whose eyes we are looking through always puts their head back',
    '  into the frame.',
    '',
  ];
  const layout = [
    '**⑧ The frame must fit the action** (cause #1 of limbs cut by panel borders):',
    '· caption mentions legs / knees / feet / hips → that character box must cover at least',
    '  **70% of the panel height**, with margin left at the feet;',
    '· a panel flatter than 1/4 of the canvas gets **upper body only** (above the waist) —',
    '  do not push lower-body action into it;',
    '· either enlarge the box or shrink the action. Doing both at once guarantees a crop.',
    '',
    '**⑨ No character item inside a close-up panel**: a `close-up` / `extreme close-up`',
    'panel gets an object item describing only that piece (hand / neck / hips / fabric /',
    'fluid) and **no character item**. A full-body character inside a face-sized box is the',
    'documented way to get a headless torso (official §13.1).',
    '',
  ];
  const text = [
    '**⑧ Every panel carries all five**: action + bearing surface + both hands + lower-body',
    'placement + contact direction. Missing any one and the model fills it in — that is where',
    'severed limbs, clipping and extra arms come from. Example:',
    '`He presses her back against the sink rim, his weight on his left palm flat on the',
    'counter, his right hand at her hip, one knee between her thighs, entering her from',
    'behind.`',
    '· On a **single-image page** these five live in that one pose sentence in `summary.caption`;',
    '  the `character` items must not restate them.',
    '',
    '**⑨ Close-up panels describe the piece only** — after `Panel 2, extreme close-up of his',
    'hips flush against her,` do not restate the whole-body action or the full appearance.',
    '',
  ];
  const tail = [
    '**⑩ ★★★ Space priority — this is why items ②~⑦ were going missing.**',
    'The rest of this prompt asks for identity anchor + visible outfit + action',
    'within 50~110 words. In an adult scene the six items above need room on top of that, so the',
    'budget is: **85~130 words in this mode** (it replaces the 50~110 above). Order of',
    'importance:',
    '',
    '  **②~⑦**  >  pose and action  >  clothing boundary  >  appearance',
    '',
    '· Character captions may run **85~130 words** in an adult scene. Never shorten one by',
    '  dropping an item from ②~⑦.',
    '· Write the **full appearance once per character on the page**, usually the first panel.',
    '  In every later panel the same character gets a **5~8 word identity anchor only** —',
    '  hair colour plus one distinguishing item, or `bared pelvis` when undressed',
    '  (**the organ rule above still applies** — an anchor never replaces the organ). Repeating',
    '  the full appearance eats the words ②~⑦ need, and it is also how one body gets drawn',
    '  twice.',
    '· Still short of room? Cut framing adjectives and atmosphere first, then appearance',
    '  detail. **Never cut a pose term, an organ, a fluid, a clothing boundary or a support',
    '  point.**',
  ];
  return [...head, ...core, ...(isJsonOut ? layout : text), ...tail].join('\n');
}

/**
 * 「SFW 写法」· MOSS 口径专属（v0.9.127）。
 *
 * ★ 依据是官方模版原文，不是我编的：
 *   · 中文第 162 行：「**SFW 保持普通角色创作语境**，不擅自改变年龄、性别、体型或加入性化姿势。
 *     默认原创人像可用成年角色；明确未成年 IP 的普通插画保持正常活动与着装，
 *     不借『美学』自动转成人分支。」
 *   · 英文第 691 行：「Keep all content within a normal SFW illustration context.」
 *
 * 为什么需要这一段（用户 2026-10-22 报「现有的缺少这方面」）：
 *   插件此前只有一个「成人画面优先」开关，它只会**往成人方向加力度**。
 *   轮到日常/SFW 剧情时，模型在「正文有点暧昧」时无处可退，就自己往成人方向补 ——
 *   表现是 SFW 楼也画出裸露或性化姿势，和正文对不上。
 *   SFW 模式给出的不是「禁止」，而是**明确的画到什么程度**（临界之前），
 *   模型才有一个可执行的落点。
 *
 * ★ 与成人段**互斥**：注入哪个由 `mossAdultOn()` / `mossSfwOn()` 单点决定，
 *   绝不允许两段同时出现（两套相反规则并存时，模型只会挑一条听）。
 */
function mossSfwBlock(isJsonOut) {
  const head = [
    '## Content rating (SFW scene writing)',
    '',
    '> This section overrides any "be realistic, do not avoid it" tendency elsewhere.',
    '> This page is drawn at normal illustration level.',
    '> Basis: the official template — keep all content within a normal SFW illustration context,',
    '> and do not add sexualized poses on your own.',
    '',
    '**① Keep the outfit intact.** Never write `naked` / `nude` / `topless` / `bare chest` /',
    '`exposed` / `undressed` / `naked from the waist down`, and never remove a garment as a',
    'whole. For "dishevelled", use a degree word instead — `unbuttoned collar`,',
    '`sleeve slipping off one shoulder`, `skirt rumpled`, `tie loosened`, `hair dishevelled`.',
    'The clothes stay on the body.',
    '',
    '**② No sex acts and no sex organs.** No intercourse / oral / masturbation / body fluids',
    'and no anatomical names, and no organ-contact phrasing such as `his hips against her',
    'bare skin`.',
    '',
    '**③ Intimacy ceiling.** Hugging, an arm around the waist, holding hands, foreheads',
    'touching, a kiss on the lips or cheek, her face buried in his shoulder — all fine.',
    '**Stop before the line.** Do not push past it.',
    '',
    '**④ No close-up on private areas.** Chest / crotch / inner thigh / hips do not go into',
    'a close-up panel. For mood, shoot hands, collarbone, eyes, hair tips, a hem, the side',
    'of the neck.',
    '',
    '**⑤ Test it before writing.** Would this caption be a problem as one page of an',
    'all-ages manga? If yes, step back one beat and write that instead.',
    '',
  ];
  const layout = [
    '**⑥ Layout only**: a character caption states **what is worn and what they do**, never',
    '"how far it has come off". A `close-up` / `extreme close-up` panel gets an object item',
    'with the environment or a non-private fragment, and **no character item in that panel**',
    '(official §13.1: do not load a full body into a face-sized box).',
  ];
  const text = [
    '**⑥ Text only**: inside `Panel N,` likewise write "what is worn and what they do"; do',
    'not write the same garment as taken off in a later panel. State the outfit baseline',
    'once, then only the delta per panel.',
  ];
  return [...head, ...(isJsonOut ? layout : text)].join('\n');
}

/**
 * 模版里「这一张图怎么写」那一节的起点。
 *
 * ★ 为什么按它切，而不是把整段 `protocol` 搬过去：
 *   `protocol` 前半讲的是**绘灵自己管档案用的外层结构**（`changes[]` / `images[].position`），
 *   GAL 的返回体是 `{shots:[{anchor, image}]}` —— 两套外层结构同时在场，模型只会挑一条听，
 *   而它挑错的那条会让 `singleJsonPrompt` 拿到一个没有 `summary/items` 的对象，直接报
 *   「items 全被判非法」。**只取后半（画面写法），不取前半（档案外壳）**。
 *
 * ★ 找不到这一节就返回空串，**不许抛错**：模版是用户可编辑的，删掉一节不该让 GAL 整条断掉。
 */
const GAL_PROTOCOL_MARK = '## MOSS 单图口径补充';

function galProtocolSection(protocol) {
  const s = String(protocol || '');
  const i = s.indexOf(GAL_PROTOCOL_MARK);
  if (i < 0) return '';
  const body = s.slice(i);

  /**
   * ★★★ 这一节的首句是「`images[]` 每项输出三个字段：`position`、`cast`、`layout`」——
   *   那是**绘灵自己**的档案外壳，而 GAL 的返回体是 `{shots:[{anchor, image}]}`，
   *   外层由插件管。两句同时在场 = 两条规则互相抵消，模型只会挑一条听
   *   （记忆：分叉要彻底，不许「都别用」了事 —— 它需要一个明确的替代说法）。
   *   ⇒ 命中这一行就**原地换成 GAL 口径**，不删空（删了模型会去 spec §3.1 找 `changes`）。
   *
   *   判据放宽到「同时提到 position 与 layout，且说的是每项/三个字段」，
   *   用户改标点、改顿号都不影响命中；改得面目全非时退回末尾补一句（见下）。
   */
  let replaced = false;
  const lines = body.split('\n').map((line) => {
    const isOuterSpec = line.includes('position')
      && line.includes('layout')
      && /每项|三个字段|3 个字段/.test(line);
    if (!isOuterSpec) return line;
    replaced = true;
    return '`image` 里**直接**写 `summary` + `items`（就是下面「`layout` 的结构」那个对象本身）；'
      + '**不要** `position` / `cast` / `layout` 这层外壳，也不要 `tag` / `nl` —— '
      + '本通道按 `anchor` 定位，没有段落编号。';
  });

  if (!replaced) {
    lines.push(
      '',
      '★ **本通道的外层由插件负责**：`image` 里直接写 `summary` + `items`，'
      + '不要 `position` / `cast` / `layout` 外壳，也不要 `tag` / `nl`。',
    );
  }

  return lines.join('\n').trim();
}

/**
 * 从 `protocol` 里只抽「跨图：构图换，状态留」那一条。
 *
 * ★ 为什么它也要带进 GAL：这条讲的是**一楼的几张图之间**的关系 ——
 *   构图（取景距离与角度 / 同一个瞬间的措辞）不许复述，状态（动作、体位、脱到的程度）
 *   必须再写一遍。它不涉及 `position` / `changes`，跟 GAL 的返回体**没有任何冲突**。
 *
 * 实测依据（用户盘上 23 条 GAL CG，楼 12~22）：每楼三张的 anchor 明明挑的是不同时刻，
 * 画面却全写成「昏暗器材室 + 一束光 + 两人贴身」—— 因为没有任何规则要求构图要换。
 * 用户原话：「演绎的剧情画面氛围很差，有点八竿子打不着的感觉」。
 *
 * ★ 找不到就返回空串（用户可能删了这一条），不抛错。
 */
function galCrossShotRule(protocol) {
  const lines = String(protocol || '').split('\n');
  const start = lines.findIndex((l) => l.includes('跨图') && l.includes('构图'));
  if (start < 0) return '';
  const out = [lines[start]];
  for (let i = start + 1; i < lines.length; i += 1) {
    const l = lines[i];
    /* 这一条的子项是两空格缩进；遇到下一个顶层 `- ` 或标题就结束 */
    if (/^\s+\S/.test(l) || /^\s*$/.test(l)) { out.push(l); continue; }
    break;
  }
  return out.join('\n').trim();
}

/**
 * GAL 桥写词用的**写法规范补充段**。
 *
 * ★★★ 为什么会有这个函数（2026-10-31 用户报「GAL 出的图肢体扭曲、氛围差，
 *   比单独绘灵差很多」）：
 *   `buildGalMessages` 原来只拼 `tpl.system + tpl.spec` = **11936 字**，
 *   而单独绘灵走 `buildAnalyzeMessages` 是 **32274 字**。差的 2 万字正好是三块：
 *     ① `mossAdultBlock` —— 承重面 / 两手 / 下肢落点 / 进入方向（治肢体扭曲的那套）；
 *     ② `protocol` 后半 —— `summary` 三句、`items` 两类（画风句就靠它，缺了只剩
 *        `Anime style illustration` 这种空话）；
 *     ③ `buildMossSingleJsonDirective` —— 单图形态：不分格 / 一人一项 / 动作只写
 *        「主动作 + 承重面」/ 不写景别机位（v0.9.157 的 12 张对照实验结论）。
 *   ⇒ 用户看到的就是「手多一只、腿被拉长」和「画面和剧情对不上」。
 *
 * ★ 只补**写法规范**，不补**资料**（角色档案库 / 剧场上下文 / 历史楼层）：
 *   资料一类会被 GAL 自己的【角色设定】重复描述一遍，两处描述 = 模型挑一条听，
 *   那是服装与外貌漂移的老病。档案走 `appearanceSource` / `outfitSource` 开关替换，
 *   不在这里追加。
 *
 * @returns {string} 可直接接在 `tpl.spec` 之后的一段文本；非 MOSS / 非 JSON 口径返回 `''`
 */
export function buildGalWritingSpec(cfg) {
  const c = cfg || getConfig();
  /**
   * 只有「MOSS + JSON 口径」才需要这段。
   * 纯 prompt 版按段落写 `Panel N,` 或自然语，没有 `summary/items` 这层结构；
   * K2 / SD 更不适用 —— 硬塞进去只会和它们自己的规范打架。
   */
  if (activeEngine() !== 'moss') return '';
  /**
   * ★ v0.9.186：漫画台口径也要这一段 —— GAL 桥自己拼词时缺的正是写法规范
   *   （见本函数开头那段「GAL 出的图肢体扭曲」的病历）。
   *   它同样是 JSON 口径，只是坐标由模型写，规范层一模一样。
   */
  const outMode = activeOutput();
  if (outMode !== 'json' && outMode !== 'manga') return '';

  const tpl = getActiveTemplate() || {};
  const nsfwMode = c.mossJson?.nsfw;
  const adultOn = mossAdultOn(nsfwMode, c.adultPosePriority);
  const sfwOn = mossSfwOn(nsfwMode);
  const poseFix = normalizeMossEnhance(c.mossJson).pose;

  const parts = [];
  /* 与 `buildAnalyzeMessages` 同序：spec → 成人/SFW → 输出协议 → 形态指令 → 破限 */
  if (adultOn) parts.push('', '---', '', mossAdultBlock(true, mossAdultForced(nsfwMode), poseFix));
  if (sfwOn) parts.push('', '---', '', mossSfwBlock(true));
  const cross = galCrossShotRule(tpl.protocol);
  if (cross) parts.push('', '---', '', cross);
  const proto = galProtocolSection(tpl.protocol);
  if (proto) parts.push('', '---', '', proto);
  const directive = outMode === 'manga'
    ? buildMangaDirective({ ...canvasOf(c.backends?.comfyui), mode: tpl?.mangaMode })
    : buildMossSingleJsonDirective(c.mossJson);
  if (directive) parts.push(directive);
  const jb = String(tpl.jailbreak || '').trim();
  if (jb) parts.push('', '---', '', jb);

  return parts.join('\n');
}

export function buildAnalyzeMessages(p) {
  const cfg = p.cfg || getConfig();
  const tpl = getActiveTemplate();
  /**
   * ★ v0.9.117：口径判定 —— 下面有几条**画面写法规则是引擎专属**的，
   *   写死了就会和模版文本自相矛盾（模型照着错的那条办）：
   *   · `@角色名` 引用：K2/SD 靠它注入锚点；MOSS 不认记号，写了反而把外貌丢掉。
   *   · `tag 总长 420 字符`：SD/K2 是单画面 tag 预算；MOSS 多格提示词按格算篇幅，
   *     一条三格提示词 700~900 字符是正常的 —— 用 420 逼它，它只会把格子删掉。
   */
  const isMoss = activeEngine() === 'moss';
  /**
   * ★ v0.9.117：MOSS 口径的「本次出图形态 + 排版」指令。
   *   拼在 protocol 之后（同属 system 段），原因：模版文本是用户可编辑的，
   *   而形态/排版是每次出图都可能变的设置 —— 写死进模版就无法跟着设置走。
   *   非 MOSS 口径返回空串，对 SD / K2 零影响。
   */
  /**
   * ★★★ v0.9.121：两条形态指令，**不能共用**。
   *   · 纯 prompt 版教的是 `Panel N, 方位词:` —— 排版靠英文方位词；
   *   · JSON Layout 版排版靠**真实像素框**，所以指令里必须带
   *     「本次画布 W×H」和各格的坐标分区（模型不会自己算，官方也禁止归一化坐标）。
   *   两者措辞与内容完全不同，混用会让模型一边写 JSON 一边塞 `Panel` 文本段。
   */
  /**
   * ★★★ v0.9.157：两个布尔，**语义不同，不能合并**。
   *   · `isJsonOut`：「JSON 口径」—— layout 与单图 json 都属于它。
   *     它决定的是**分工口径**：外貌谁写 / 服装谁写 / 成人段用哪一版 / 人数怎么算。
   *   · `isLayoutOut`：真正会跑 `compileLayout` 的那一路（多格 / 单格都算）。
   *     它决定的是**坐标**要不要编译。
   *   把这两个当成一个用，单图 json 会掉进「插件注入人物段」的纯 prompt 口径 →
   *   与 spec 里「每人一项写全外貌」重复 ⇒ 又回到「重复＝实体复制」那条老病。
   */
  const isJsonOut = isMoss && activeOutput() !== 'text';
  const isLayoutOut = isMoss && activeOutput() === 'layout';
  /** ★ v0.9.186：漫画台原生口径（坐标由模型写，插件只做逐字移植的 compile）。 */
  const isMangaOut = isMoss && activeOutput() === 'manga';
  /**
   * ★ v0.9.122：Layout 版读**自己的** `cfg.mossJson`，纯 prompt 版继续读 `cfg.moss`。
   *   两个版本是并存的两种输出格式，用户会来回切 —— 共用一份配置时，
   *   在 A 版调过的形态/排版会跟到 B 版（用户的原始要求就是「互不影响」）。
   */
  /**
   * ★★★ v0.9.141：**本楼页数 / 每页格数由代码一次算死**。
   *
   * 形态节（`buildMossJsonDirective`）和任务节（下方 2f）必须**引用同一组数字**，
   * 否则就是上一版那个 28 张 × 2 格的病：两节各给一套约束，模型挑省力的那个组合。
   * 段数也在这里算一次，两节都读 `coverPlan`，不再各算各的。
   */
  const _coverCfg = normalizeMossCover(cfg.mossJson);
  const _planBody = cleanBodyLines(p.body || '');
  /**
   * ★★★ v0.9.144：段数改用**叙事行**数 —— 必须与 `renderIndexed` 的 ⟦P编号⟧ 同源。
   *   旧写法按"非空物理行"数，真实第一楼是 49 行（真剧情只有 11 行，其余是
   *   `<draft>` 施工计划 / charThink / `<action>` 选项）⇒ coverPlan 出 5 页 × 4 格 = 20 格，
   *   而模型手里只有 11 段剧情可填 ⇒ 必然拆步凑格。详见 `util.js` 的 `storyRows` 注释。
   */
  /**
   * ★★★ v0.9.155：第四个参数 = **手选的固定版式格数**。
   *   用户在「漫画页版式」里钉死某一款时，每页格数必须是那款的格数 ——
   *   否则指令要 4 格、版式是 3 格，`pickMangaLayout` 会回落随机池，手选静默失效。
   *   `mangaLayout` 为 `random` / 空 时 `mangaLayoutOf` 返回 null ⇒ 走「格数范围」那一档。
   */
  const _fixedLay = mangaLayoutOf(cfg.mossJson?.mangaLayout);
  const coverPlan = mossCoverPlan(_coverCfg, storyLineCount(_planBody), Math.random, _fixedLay ? _fixedLay.panels : 0);
  const mossDirective = isMoss
    ? (isMangaOut
      /**
       * ★★★ v0.9.186：漫画台口径 —— 教它写**漫画台 page JSON**（含 bbox）。
       *   与下面两条的分工：`json` 禁坐标、`layout` 由插件算坐标，
       *   而这一条**要求模型自己写左上原点像素坐标**（漫画台就是这么干的）。
       */
      ? buildMangaDirective({ ...canvasOf(cfg.backends?.comfyui), mode: tpl?.mangaMode })
      : (activeOutput() === 'json'
      /**
       * ★★★ v0.9.158：**必须传 `cfg.mossJson`**。
       *   原来是无参调用 ⇒ `normalizeMossEnhance(undefined)` ⇒ 全落默认值
       *   （`sfx: 'ja'` / `slant: false` / `pose: true`）⇒ 用户在「画面强化」里改的
       *   拟声词档位（off / ja / zh）与斜切、体位骨架**在单图 JSON 路径下一条都不生效**
       *   —— 面板上有开关、改了没反应，正是 v0.9.154 删 border/fill/pad 时点名的那个病。
       *   多格版 `buildMossJsonDirective(cfg.mossJson, …)` 一直是传的，只有单图这条漏了。
       */
      ? buildMossSingleJsonDirective(cfg.mossJson)
      : (isLayoutOut
        ? buildMossJsonDirective(cfg.mossJson, canvasOf(cfg.backends?.comfyui), undefined, coverPlan)
        : buildMossDirective(cfg.moss))))
    : '';

  /**
   * ★★★ v0.9.127：**剧情模式单点决策**。
   *   以前这里只写 `cfg.adultPosePriority` —— 那是个「只会往成人方向加力」的开关，
   *   轮到 SFW 剧情时模型无处可退，就自己往成人方向补（用户报「SFW 楼也画出裸露」）。
   *   现在两个方向都由 `mossAdultOn` / `mossSfwOn` 决定，且**互斥**：
   *     · `auto`：沿用旧开关（老配置一个字都不变）；
   *     · `sfw` ：只注入 SFW 段，即使「成人画面优先」开着也不注入成人段；
   *     · `nsfw`：只注入成人段，不看旧开关。
   *   两版各读各的那份配置：纯 prompt 版 `cfg.moss`，Layout 版 `cfg.mossJson`。
   */
  const nsfwMode = isJsonOut ? cfg.mossJson?.nsfw : cfg.moss?.nsfw;
  const adultOn = isMoss && mossAdultOn(nsfwMode, cfg.adultPosePriority);
  const sfwOn = isMoss && mossSfwOn(nsfwMode);
  /**
   * ★ v0.9.136：体位表要不要带「头/脸朝向 + 承重面 + 进入方向」补充句。
   *   只有 8 个几何反直觉的体位有条目（见 `poseLibrary.js` 的 fix 字段）；
   *   关掉后表与 v0.9.135 逐字一致。老配置没有这一项 → 归一化给 true。
   */
  const poseFix = normalizeMossEnhance(cfg.mossJson).pose;

  const system = [
    tpl.system,
    '',
    '---',
    '',
    tpl.spec,
    /**
     * ★ v0.9.125：成人画面写法**接进 MOSS**（此前只有 K2 分支有 adultPriorityBlock）。
     *   用户 2026-10-21 报「MOSS 出的图肢体扭曲」，实测根因是 NSFW 场景下
     *   姿态三要素（承重面 / 两手 / 下肢落点）在 MOSS 规范里从未被要求过 ——
     *   而 K2 那套专门治这件事的规则挂不到这里。
     *   放在 spec 之后、protocol 之前：属于内容规范的最后一块，且不打断输出协议。
     *
     * ★ v0.9.127：与「SFW 写法」**二选一**（见上方 nsfwMode 的注释）。
     */
    ...(adultOn ? ['', '---', '', mossAdultBlock(isJsonOut, mossAdultForced(nsfwMode), poseFix)] : []),
    ...(sfwOn ? ['', '---', '', mossSfwBlock(isJsonOut)] : []),
    '',
    '---',
    '',
    tpl.protocol,
    mossDirective,
    tpl.jailbreak?.trim() ? `\n\n---\n\n${tpl.jailbreak.trim()}` : '',
  ].join('\n');

  // 剧场上下文（角色卡 / 用户设定 / 世界书）压在规范之前 —— 先让人物立住，再谈怎么写 tag。
  // 独立成段而不是塞进 user：模型对 system 层的设定遵循度更高，且不会和正文混在一起。
  const contextBlocks = buildContextBlocks(cfg, p);

  /**
   * ★ 目标楼层正文必须在这里清洗 —— 历史上这行漏了，正文原样进了提示词。
   * 后果：主 AI 的 <thinking>/<recap>/<choice>/<update>/[img:] 全被当成剧情，
   * 位置池从 21 个真叙事段落膨胀到 79 个（其中 64 个是垃圾），
   * 模型挑位置时大概率落在推理草稿或选项上 —— 表现就是"提示词跟剧情对不上"。
   */
  const body = cleanBodyLines(p.body || '');

  const userParts = [];

  const libText = renderLibraryText(p.snapshot);
  if (libText) {
    userParts.push(libText, '', legend());
  } else {
    userParts.push('【角色档案库】\n（空。本楼出现的新角色请用 kind="new" 建档，必须给出 hair 与 eyes）');
  }

  if (Array.isArray(p.history) && p.history.length) {
    userParts.push(
      '',
      '【最近剧情】（仅供理解上下文，不要为这些楼层配图）',
      ...p.history.map((h, i) => `— 前 ${p.history.length - i} 楼 —\n${h}`),
    );
  }

  /**
   * ★ v0.9.52 近期已出过的图 —— 填补全项目最大的一块空白。
   *
   * 在此之前**模型从没见过自己上一张写了什么**：`cleanBody` 把 `<hl_image>` 整块删掉，
   * `promptFull` 又只写进存档给 UI 看、从不读回。规范里甚至明写「模型手里没有上一张」。
   * 于是同一段剧情连出两楼时，模型既判断不出"这张和刚才那张重不重复"，
   * 也不知道"上一张已经确立的画面事实"（她已经脱了外套 / 他脸上已经有巴掌印）。
   *
   * 这里补上的正是这两件事，**且明确禁止照抄**（照抄 = 重复出图，比不知道更糟）。
   * 只给摘要不给全文，就是为了让它只能拿"事实"、拿不到"可抄的模板"。
   */
  if (cfg?.consistency?.recentImages !== false) {
    let briefs = [];
    try {
      const lim = Math.max(0, Number(cfg?.consistency?.recentImageCount ?? 3));
      briefs = lim > 0
        ? recentImageBriefs({ mesId: Number(p.mesId ?? Number.MAX_SAFE_INTEGER), limit: lim })
        : [];
    } catch { briefs = []; }
    if (briefs.length) {
      userParts.push(
        '',
        '【近期已出过的图】（同一段剧情里已经画过的画面 —— 用于避免重复、以及延续已确立的事实）',
        ...briefs.map(b => [
          `— 第 ${b.mesId + 1} 楼${b.position ? ` · 位置${b.position}` : ''} —`,
          b.tag ? `画面：${b.tag}` : '',
          b.nl ? `说明：${b.nl}` : '',
          // v0.9.101：K2 的姿态/接触句在人物段尾部，不给这段模型看不见上一张做了什么
          b.pose ? `姿态：${b.pose}` : '',
        ].filter(Boolean).join('\n')),
        '',
        '⚠️ 怎么用这段：',
        '  ① **不许照抄** —— 重复出图比不知道上一张更糟。这里给的是"已经发生过什么"，不是模板。',
        '  ② **延续已确立的事实**：已经脱掉的衣服、已经留下的伤痕/体液/痕迹、已经出现的道具与环境陈设，',
        '     本楼若仍是同一场戏，就应当与之一致（除非正文明确写了变化）。',
        '  ③ **换画面**：本楼若已是新的一幕/新的动作阶段，就换机位、换景别、换构图，不要复述同一个瞬间。',
        '  ④ **不许重复的只有「构图」**：机位、景别、同一个瞬间的措辞 —— 重复这些才会被扩散模型当成多画一个实例。',
        '  ⑤ ★ **必须重述的是「状态」**：正在进行的性行为与体位、已脱到的程度、已确立的接触点、留下的痕迹。',
        '     上一张写了 `sex, vaginal`，这一楼还在这场戏里，就**照写一遍**（K2 就写进 cast[].en 的姿态句）。',
        '     **不写 ≠ 延续，等于这张图里没有这件事** —— 这是「前一张有、后一张突然没了」的头号原因。',
        '     判据：把这条删掉，这张图还成立吗？不成立 = 必须写；只是换个机位也成立 = 才是可选细节。',
        '  ⑥ 「姿态：」那段是上一张人物段的尾部（可能还带着外貌词），**只用它判断姿态与接触**，外貌一个字都不要抄。',
      );
    }
  }

  // ★ v0.9.26：把「<user> 到底叫什么」直接告诉模型。
  //   这是「第二个角色永远没有外貌」的第一层根因 —— 主角常常就是跟你对话的用户本人，
  //   正文里写作 <user>；规范只写了「禁止用宏指代画面角色」，却没说该用什么名字代替，
  //   模型只能凭感觉造一个（或干脆不建档）→ 那个人永远不在档案库里 → 永远没有外貌锚点。
  //   这里把用户 persona 名摆出来，并明确它在建档 / cast / @引用里就是这个字符串。
  const userName = String(getUserName() || '').trim();
  if (userName) {
    userParts.push(
      '',
      `【画面里怎么称呼「你」】正文里出现的 <user> 就是「${userName}」。`,
      `建档（changes[].name）、出场名单（cast[].name）、@引用，一律写「${userName}」这个字符串 ——`,
      `不要写 <user>，不要写「男性」「男人」「我」这类代词，也不要另起一个名字。`,
    );
  }

  // ★ 待建档名单回灌：上一轮（或更早）cast 点过名、但档案库至今没有外貌的角色。
  //   不回灌的话模型永远不知道自己建档失败了，每轮都在同一个地方踏空。
  //   v0.9.38：必须用全量名单判断 —— 快照可能被在场预筛裁剪，裁掉 ≠ 不存在；
  //   拿裁后名单判断会让已建档角色被误判为待建档 → 每轮重复建档。
  const libNames = nameListFor(p);
  let pending = [];
  try {
    pending = listPendingProfiles(libNames);
  } catch { pending = []; }
  if (pending.length) {
    userParts.push(
      '',
      '【欠外貌档案 · 必须在本轮补齐】（这些角色你在之前的楼层里让ta出场了，但档案库至今没有ta的外貌）',
      pending.map(n => `— ${n}`).join('\n'),
      '他们这一楼若还在场，你必须为每人提交一条 `{"name":"<上面的名字>","kind":"new","fields":{...}}`，',
      'fields 里**至少**给 `hair` 与 `eyes`（英文 tag），能看出性别就再给 `sex`（boy/girl）。',
      '⚠️ 只写 `{"kind":"new","fields":{}}` 会被判无效的 —— 没外貌就无法锚定，出图会变成没脸的路人。',
      '⚠️ 名字必须与上面**逐字一致**（改一个字就是另一个角色，建档照样失败）。',
    );
  }

  // ↓ v0.9.50：档案库权威名单回灌。规则 2d 要求模型「照抄档案库里已有的名字」，
  //   但名单从来没给过它 —— 只能从正文猜，猜错就重复建档。
  //   用户真实病例（2026-09-30）：同一人被建成「隔壁太太」「结城美惠」「结城太太」三条，
  //   服装各演化各的，改哪条另外两条都不跟。
  if (libNames.length) {
    userParts.push(
      '',
      `【档案库权威名单】（建档 / cast / @引用只允许用这些名字，逐字照抄）：`,
      libNames.join('、'),
      `正文里的其他叫法（全名 / 简称 / 尊称 / 匿名指代如「隔壁太太」「楼下女人」，`
      + `或真名揭露前后）只要指同一个人，一律**对应到名单里已有的那一条**，禁止再建新档。`,
    );
  }

  /**
   * ★★★ v0.9.144：场景事实旁路。
   *
   * 净化层把卡牌的施工数据（`<draft>` 写作计划 / charThink / `<action>` 选项）整块剥掉了，
   * 但**地点与时间恰恰常只写在那些块里** —— 真实第一楼 11 段真剧情一次都没写地点，
   * 地点只在「- 地点位置: 本馆屋顶平台」和 `<scene_time>` 里。
   * 直接剥干净 = 模型不知道人在哪 = 每格背景自由发挥（"后面几组变室内"的成因之一）。
   *
   * ⇒ 抽出来单独给，**明确不占 P 编号**（否则又变成可配图的段落，回到 49 段的老路）。
   */
  const sceneFacts = sceneFactLines(body);
  userParts.push(
    '',
    '【本次目标楼层】（只为这一楼配图；段落尾部的 ⟦P编号⟧ 用于指定配图位置）',
    renderIndexed(body),
  );
  if (sceneFacts.length) {
    userParts.push(
      '',
      '【本楼场景事实】（从卡牌的变量/状态区抽出，**不占 ⟦P编号⟧**，仅供每个画面写背景时对齐）',
      ...sceneFacts.map(s => `— ${s}`),
      '用法：地点 / 时间 / 天气一律以这里为准；每格背景的地点与光源要和它对上，'
        + '**不要**把它当成一段剧情去配图。正文里若有更新鲜的描写，以正文为准。',
    );
  }
  userParts.push(
    '',
    '【任务】',
    `1. 维护档案：只记录本楼正文**明确写到**的变化（如"她解开领结"、"把外套脱了"）。`
      + `正文没提到的，一律保持档案库原样，不许润色、不许扩写、不许换同义词。`
      + (isMoss
        /**
         * ★★★ v0.9.118：MOSS 口径下这条必须改写，否则会把台词一起杀掉。
         *
         * 用户真实出图（2026-10-21）四张全部是 `A speech bubble beside her reads " "` ——
         * 引号里只剩一个空格。原因不是清洗层，是**两句话互相抵消**：
         *   · 这里写「禁止写中文 —— 中文描述放在图片的 nl 字段里」
         *   · MOSS 模版写「只输出 tag，不要输出 nl」
         * 模型两边都要守 ⇒ 唯一解是**把中文彻底删掉**。台词就是这么没的。
         * 现在改成：台词的落点 = tag 引号内，明确告诉它「这里就是要中文」。
         */
        ? `**changes 里所有字段值必须是英文 tag**（hypnotized、vacant 这类），`
          + `禁止在 changes 字段里写中文。但**台词是唯一的中文落点**：`
          + `正文里的对白要**原样中文**写进 tag 的引号内（\`reads "……别动。"\`）——`
          + `MOSS 的编码器是 Qwen 系，中文台词是它最擅长的部分，不许翻译、不许省略、不许写成拼音。`
        : `**changes 里所有字段值必须是英文 tag**（hypnotized、vacant 这类），`
          + `禁止写中文 —— 中文描述放在图片的 nl 字段里。`),
    // ↓ v0.9.70：外貌状态层 —— 「允许更新，不允许漂移」。
    //   这两个字段是**唯一**能让剧情改动外貌的通道：模型报的值必须命中档名，
    //   命不中就由一致性层丢弃并告警（防止每楼换一种写法）。
    //   ★ 键不存在 = 保持不变，这是刻意的：给 AI 一个默认值等于每天重写一次档案。
    `1b. **外貌状态层**（只有这两个能随剧情变，其余外貌字段一律不许动）：\n`
      + `   · hairState（发状态）只能填：${HAIR_STATE.map(x => x.k).join(' / ')}\n`
      + `   · makeupSmudge（花妆）只能填：${MAKEUP_SMUDGE.map(x => x.k).join(' / ')}\n`
      + `   正文明确写了才更新（淋雨 / 出汗 / 头发乱了 / 哭花妆 / 事后状态）；`
      + `**没写就整个键都不要出现** —— 不输出 = 保持不变。`
      + `清空用空字符串。\n`
      + `   🚫 发长 / 发色 / 卷度 / 扎法 / 刘海 / 妆面是**人设**，改不了也不要写 —— 写了也会被丢弃。`,
    // 单楼最少图片数（>1 时才写进指令）：要求模型尽量凑够下限；
    // 本楼确实没那么多有画面的段落时允许少配，pipeline 会提示。
    (() => {
      const maxN = Math.max(1, Number(cfg.maxImagesPerFloor) || 1);
      const minN = Math.min(maxN, Math.max(1, Number(cfg.minImagesPerFloor) || 1));
      /**
       * ★★★ v0.9.137：「剧情演完」（纯漫画 · 全覆盖）。
       *
       * 用户 2026-10-27：「MOSS模式下我想要的是每楼剧情必须演完的那种纯漫画。」
       *
       * 为什么必须是**另一套规则**而不是给旧规则加一句：
       *   旧规则的任务定义是「从这一楼里**挑**最多 N 个最有画面价值的段落」——
       *   11 条打分规则里还有一条「与近期已出过的图不重复」（天然偏向少挑）。
       *   这是"精选插图"，模型老老实实执行它，换任何 LLM 都一样。
       *   实测（1689 字 / 29 段）：模型挑 3 个 → 3 张 × 2 格 = 6 格，其中 3 格空镜，
       *   实际只画了 3 个情节点、2 句台词（1 句重复、1 句被截断）。
       *   ⇒ 要"演完"就得把任务从"挑"换成"拆"，不能靠打补丁。
       *
       * ⚠️ 措辞里**不许出现「至少」** —— genretry-minimg-test 用 `!prompt.includes('至少')`
       *    判定"min=1 时不该写配满下限"。这里改用"一个都别跳"。
       */
      const cover = normalizeMossCover(cfg.mossJson);
      /**
       * ★★★ v0.9.157：单图 JSON 口径**不能进这个分支**。
       *   这一段整份是「N 页 × 每页 M 格」的任务书（"每格约覆盖 3.9 段正文"
       *   "版面坐标由插件按版式库自动配" "每一张每一格都要重写这是哪"）——
       *   与单图 spec 的「只画一张、不写坐标」是直接对立的两套要求。
       *   同时在场时模型只会挑一条听，而挑错的代价是**重新分格 + 多画人**，
       *   正是用户报的那个症状。所以单图直接走下面的普通任务分支。
       */
      if (isMoss && cover.on && !isJsonOut) {
        /**
         * ★★★ v0.9.139：格数是**主变量**，张数是它的结果。
         *
         * 踩了两次才定下这个形状：
         *   ① 旧文案「张数 = 情节点数 ÷ 3」→ 模型数不准情节点，同一楼给出 1/4/9/10 张。
         *   ② 改成「本楼应出 9 张」→ 张数锁住了（9 张），但**格子塌成 1 格/张**（9 格画 81 段）。
         *      ⇒ 「应出 N 张」与「每张 3~4 格」是两条会互相抵消的规则，模型只满足了前者。
         *   ③ 又改成「格数是硬指标（47 格）+ 不少于 28 格 + 最多 9 页」——
         *      2026-10-28 第一楼真机实测：模型给 **28 张 × 平均 2.07 格**，
         *      用「多出页数」同时满足了格数与下限，**「最多 9 页」被彻底无视**，
         *      截断后正文只演到 P51，后 88 段全丢。
         *   ④ 现在（v0.9.141）：**页数 / 每页格数 / 总格数全部由代码算好，只给一组数字**，
         *      模型没有可权衡的余地 —— 它要做的只剩「填满 N 页 × M 格」。
         *      与形态节共用同一个 `coverPlan`，两节数字必然一致。
         */
        const paraN = coverPlan.paraN;
        return `2. **把本楼正文演完（不是挑几张）**：按时间顺序把这一楼拆成连续的**情节点**，一个都别跳。\n`
          + `   · 情节点 = 读者要看到的那一步：动作开始 / 接触发生 / 姿势变化 / 表情转折 / 一句话说出 / 位置移动。\n`
          /**
           * ★★★ 这一段是唯一给数字的地方，而且**只有一组数**：
           *   「出 N 页 × 每页 M 格 = 共 K 格」。没有区间、没有下限、没有"约"。
           */
          + `   · ★★★ **页数与格数已经算好了，你只负责填满**：本楼正文共 ${paraN} 段（⟦P1⟧~⟦P${paraN}⟧），\n`
          + `     出 **${coverPlan.pages} 页**（images 数组就写 ${coverPlan.pages} 个元素），`
          + `每页**正好 ${coverPlan.perPage} 个 panels**，全楼合计 **${coverPlan.cells} 格**。\n`
          + `     每格约覆盖 ${coverPlan.paraPerCell} 段正文`
          + (coverPlan.truncated
            ? ` —— 正文比 ${coverPlan.cells} 格长，**靠压缩装下**（一格画更多段），`
              + `绝不许靠加页或改格数来解决。\n`
            : `。\n`)
          + `   · ⚠️ **一页只写 1~2 格 = 这一页的另外 ${Math.max(0, coverPlan.perPage - 2)} 个情节点直接消失**，`
          + `而且版式库会把这一页降级成 2 格版式。\n`
          + `     实测病例：第一楼 139 段，模型给 28 张 × 2 格，被上限截成 9 张后只剩 18 格 —— `
          + `**三万字正文只演了开头一小段**。\n`
          /**
           * ★★★ v0.9.140：**内容与坐标分离**（用户 2026-10-27 看完参考实现后定的方向）。
           *   上一版让模型自己写 bbox，实测连跑三次格数是 28 / 10 / 25 —— 那是任务在为难它。
           *   现在版面由插件的版式库计算，模型只回答「这个框里画什么」。
           */
          + `   · ★★★ **版面坐标由插件按版式库自动配**（你给几格就配几格的漫画版式），`
          + `**你一个字都不写 bbox / items**。你只负责每格的内容：背景（地点+光源+时间）、这一格画什么、谁说了哪句原话。\n`
          + `   · 不许按"画面价值"筛、不许因为"和近期已出过的图重复"跳过 —— 这一楼从头到尾都要画到。\n`
          + `   · **每页的 position 必须不同**（同一段落不能出两页），按段落顺序往后推；\n`
          + `     一段里跨了好几步时，把这一步的起点放在**那段正文自己的 ⟦P编号⟧** 上。\n`
          + `   · 同一瞬间不许换机位凑格数。\n`
          /**
           * ★★★ v0.9.139：场景基线必须每张每格重写。
           *   病例（用户 2026-10-27「后面的有组场景都变室内了？」）：楼 11 九张的场景句
           *   从 `rooftop water tank alcove at midnight, cold moonlight` 逐张退化到
           *   `moonlight` → `shadow` → 空。每一步都是独立出图，不写就不继承。
           */
          + `   · ★★★ **每一张、每一格都要重写"这是哪"：地点 + 光源 + 时间，三项都要有。**\n`
          + `     只写 \`moonlight\` / \`shadow\` 这类词不构成地点，出图会自由发挥（实测从屋顶漂成室内）；\n`
          + `     也不许用「同上」「same place as before」代替 —— 模型不会继承上一张。\n`
          /**
           * ★★★ v0.9.139：承重面必须写。
           *   病例（同一轮出图）：楼 11 九张全被画成「坐在白色软床上」——
           *   场景词一个没少（rooftop/midnight/moonlight 每格都在），
           *   丢的是**接触面**：只写 `sits between his legs`，MOSS 就自己补了一张床。
           *   蓝色夜景 + 白床垫 = 用户眼里的「变室内了」。
           */
          + `   · ★★★ **写「坐 / 跪 / 躺 / 靠」时必须写明接触面**（\`sits on the bare concrete floor\`）。\n`
          + `     只写动作不写承重面，出图会自己补家具（实测：屋顶水泥地画出白床垫，看着就像室内）；\n`
          + `     接触面只能用正文/场景里真实存在的东西，**不许自己添床、沙发、软垫**。\n`
          + `   · 台词按它出现的位置放进那一刻那一格；原话超过 10 字就**拆到多格**（前半在说话人那格，`
          + `后半放下一格并换成听话人的视角/反应），一个字都不许删 —— 换视角还能避免连续几格都是同一张脸。\n`
          + `   ⚠️ **本条优先于任何"挑选"口径**：模板或上文里若有「挑选最有画面价值的片段」`
          + `「选出最多 N 个」这类说法，**在本次任务里作废** —— 这一楼要的是"拆完演完"，不是"挑几张"。`;
      }
      // ↓ v0.9.52：「最有画面价值」此前**没有任何判据** —— 规范只写了这么一句，
      //   模型只能凭感觉挑，实测结果是挑中纯对话/纯心理描写的段落，
      //   而真正的动作顶点被跳过（用户抱怨「提示词跟剧情对不上」的一大来源）。
      //   这里给出可执行的打分口径 + 明确的"不配图"清单。
      const RUBRIC = `\n   【什么叫"有画面价值"】按下面 7 条打分，中 3 条以上才值得配图：\n`
        + `   ① **有人物动作或身体接触**（拥抱 / 推搡 / 递东西 / 伸手制止）—— 最优先；\n`
        + `   ② **场景或时间发生变化**（换了地方、天黑了、门被推开）；\n`
        + `   ③ **出现新的视觉要素**（新人入场、新道具、服装变化、伤痕 / 痕迹 / 液体）；\n`
        + `   ④ **是本楼情绪或动作的顶点 / 转折点**（对峙、告白、失控、松口）；\n`
        + `   ⑤ **正文给了足够的空间信息**（谁在哪、朝向哪、什么姿势、离多远）；\n`
        + `   ⑥ **与【近期已出过的图】不重复**（若是同一瞬间的另一个角度，分数减半）；\n`
        + `   ⑦ **读者会想"看到"这一刻**（画面能推进理解，不只是复述已知信息）。\n`
        + `   ✗ **明确不配图的**：纯内心独白 / 纯信息交代 / 转场说明 / 无视觉信息的寒暄对话 /\n`
        + `     重复出现的日常动作（又一次喝茶、又一次点头）。这类段落配出来只会是\n`
        + `     一张"两个人在房间里"的通用废话图。`;
      return minN > 1
        ? `2. 挑选画面：在本楼里选出至少 ${minN} 个、最多 ${maxN} 个最有画面价值的段落。`
          + `画面价值足够的段落达到 ${minN} 个时必须配满；确实不足 ${minN} 个时才允许少配。` + RUBRIC
        : `2. 挑选画面：在本楼里选出最多 ${maxN} 个最有画面价值的段落。` + RUBRIC;
    })(),
    // ★★★ v0.9.119：MOSS 下「在场名单」是**硬清单**，必须覆盖到每一个路人。
    //   用户病例（2026-10-21）：正文里巡查员「坂本先生」出场并说了三句话，
    //   但 5 张图的人物段只有女主 + 男主 —— 第三个人被画成了「第二个穿同款校服的女生」。
    //   根因是旧规则只说「别把整个档案库算进来」，**没说身份指代的人也算在场**，
    //   于是模型只认档案库里的名字，路人被静默忽略。
    isMoss
      ? `2b. ★★ 先定「本楼在场名单」，再**逐人核对有没有漏**：读【最近剧情】与【本次目标楼层】，`
        + `把这一楼**实际在场**的每一个人列出来（被点名、有动作、有对话、被旁白交代在场的都算）。\n`
        + `   · **身份指代也算在场**：正文写「巡查员」「坂本先生」「店员」「楼下的男人」时，`
        + `     那是**一个真实出场的人**，必须进名单 —— 哪怕档案库里根本没有他。\n`
        + `   · 【最近剧情】用来判断谁是**新出场**的：前几楼在场、这一楼已离开或没被提到的旧角色，`
        + `     不要算进名单（否则会多画出一个人）。\n`
        + `   · **名单里的每一个人，都必须在本次 images[].cast 里至少出现一次。**`
        + `     漏一个，那个人就没有外貌锚定 —— 实测会被画成「第二个穿同款衣服的女主角」。\n`
        + `   · 不要用 they / both 代替具体的人；这一楼确实只有两个人时，在 tag 里写清「画面里只有这两人」。`
      : `2b. 先定「本楼在场名单」：读【最近剧情】与【本次目标楼层】的正文，判断**这一楼里实际在场**`
        + `（被点名、有动作、有对话，或被旁白交代就在现场）的角色有哪些。`
        + `**只算本楼在场的人**，不要把整个角色档案库都算进来 —— 档案库是长期资产，`
        + `里面很多人这楼根本没出场。`,
    // ↓ v0.9.25：过去插件只能靠「英文句里出现 her / his」去猜画面里有谁，
    //   猜不出就漏人 —— 用户实测「小精灵没有外貌，男主有」就是这么来的。
    //   现在要求模型先读完上下文定出「本楼在场名单」，再逐图点名 cast（权威来源）。
    // ★★★ v0.9.119：MOSS 下 cast 除了点名，还要承担「给没档案的人一行外貌」。
    //   旧文案写的是「用档案库里的准确名字 + 该角色自己的英文句」—— 前半句限定死了
    //   只能用档案库的名字，于是正文里的路人只能被忽略（第三个人丢失的直接原因）。
    isMoss
      ? `2c. 再逐图点名（MOSS 口径）：每个画面里出现的**每一个人**，都要在 images[].cast 里写一项。`
        + `\n   · 档案里**有的**角色 → 只写 name（逐字照抄档案库，一个字都不改）。`
        + `\n   · 档案里**没有**的人 → 写 name + look。look 是一行英文外貌，`
        + `     以 A / An 开头（如 "A middle-aged man with short grey hair, wearing a dark blue security uniform"），`
        + `     插件直接拿它当人物段。同时给他一条 kind:"new" 的建档，下一楼他才接得上。`
        + `\n   · 同一个人的写法在这一楼的所有图里必须一致（别一张写「巡查员」、一张写「坂本先生」）。`
        + `\n   · 画面里有 2 人就写 2 人；漏掉一人，那个人就没有外貌锚定。`
      : `2c. 再逐图点名：每个画面里出现的**每一个人**，都要在 images[].cast 里写一项`
        + `（用档案库里的准确名字 + 该角色自己的英文句）。画面里有 2 人就写 2 人 ——`
        + `漏掉一人，插件就不会注入他的外貌，出图会变成没脸的路人。`,
    `2d-0. **例外（POV / 特写）**：这张图以某人视角呈现、另一个人只被提到而不该完整入画时，`
      + `给那个人加 \`"offscreen": true\` —— 插件就不注入他的外貌（外貌段 = 把他画完整的指令，`
      + `POV 图里注入只会多画出一个人）。他在 cast 里仍要点名，只是标记不入画。`,
    // ↓ v0.9.49：同名分裂 —— 模型换叫法（全名/简称/尊称）就当新角色建档，
    //   同一人存三份档案（结城太太 / 结城美惠子 / 美惠子），服装和外貌各存一份、
    //   互相打架：用户在 A 名下改服装，出图按 B 名注入 → 怎么改都"没效果"。
    //   v0.9.50 补第二类病例：「隔壁太太」(匿名指代) → 真名揭露后模型又建
    //   「结城美惠」「结城太太」—— 匿名建档的角色在真名出现后必须沿用旧档。
    `2d. **同一个人物，从头到尾只允许用档案库里已有的那一条名字**（名单见上方【档案库权威名单】）：`
      + `① 正文出现全名 / 简称 / 尊称 / 婚后称呼等变体（如「结城美惠子」「美惠子」「结城太太」指同一人）时，`
      + `changes 与 cast 里一律**照抄名单里已有的名字**，一个字不许改；`
      + `② 匿名指代建档的角色（「隔壁太太」「楼下女人」）在真名揭露后**还是同一个人** —— `
      + `继续用最初的建档名，把真名写进 label，**不要**为新名字再建一条；`
      + `③ 只有**首次出场且名单里确实没有**的角色才允许 kind:"new" 建档。`
      + `同一人建两条档案 = 外貌和服装各存一份、互相打架，出图必然漂移。`,
    // ↓ v0.9.50：AI 判同人 → 主动报归并。判断依据必须来自正文证据，拿不准宁可漏报 ——
    //   合并方向错了用户能在档案页手动重建，但误合并两个真不同人比重复建档更难收拾。
    `2e. **发现档案库里已经出现同一人的两条档案时，顺手报归并**：正文里有明确证据`
      + `（括号互注如「结城太太（结城美惠）」、同一段前后切换称呼、剧情点明身份揭露）`
      + `说明两个名字指同一人，而名单/库里两条都在，就额外输出一条：`
      + `{"name":"<保留的名字>","kind":"merge","from":"<被并掉的名字>"}。`
      + `保留**更正式 / 更常用**的那个名字。**没有正文证据就不要报** —— 拿不准宁可漏报，`
      + `合并只按这条通路做，插件不会自动猜。`,
    // ↓ v0.9.52：多图分工此前**零约束** —— 规范只说"选最多 N 个段落"，
    //   模型于是把同一瞬间的同一画面拆成两张（换个形容词又写一遍），
    //   读者看到的是两张几乎一样的图 = 名额浪费 + "重复出图"投诉的主要成因之一。
    // ⚠️ 措辞里**不许出现「至少」** —— 那是「要求配满下限（minImagesPerFloor）」的专属标志串，
    //    genretry-minimg-test 靠 `!prompt.includes('至少')` 断言"min=1 时不写下限要求"。
    //    （2026-09-30 实测：在这里写了「至少」→ 该测试误判 min=1 也要求配满，回归失败。）
    /**
     * ★ v0.9.137：剧情演完模式下，这一条要**收窄成硬要求**。
     *   旧的「五选一」允许用"不同机位"代替"不同时刻"，正好会给"同一瞬间换角度凑格数"
     *   留合法出口 —— 而全覆盖模式的核心就是**不允许同一步占两格**。
     */
    normalizeMossCover(cfg.mossJson).on
      ? `2f. ★★ **本楼的多张图按时间推进**：每一张必须画**不同时刻**的一步剧情。\n`
        + `   "不同时刻"是硬要求 —— 换机位 / 换景别 / 换焦点 / 换空间**都不能替代**它：\n`
        + `   同一瞬间的两个角度 = 相同内容出两张，等于白烧一次 API。\n`
        + `   ⚠️ 张数由情节点决定：不要为了"凑满上限"拆出重复画面，也不要为了"省张数"合并两步。`
      : `2f. ★★ **同一楼出多张图时必须分工** —— 必须在下面五项里**占一项不同**：\n`
        + `   ① **不同时刻**：本楼内部的时间推进（先是…随后…），一张画前、一张画后；\n`
        + `   ② **不同机位 / 景别**：一张全景交代空间与人物位置，一张特写给手 / 脸 / 局部；\n`
        + `   ③ **不同人物焦点**：一张以她为主（他虚化或只入局部），一张以他为主；\n`
        + `   ④ **不同动作阶段**：准备 → 接触 → 进行中 → 余韵，各取一段；\n`
        + `   ⑤ **不同空间**：房间里 / 门口 / 走廊 / 窗外所见。\n`
        + `   **五项全同 = 同一瞬间的两个副本**，读者只会觉得重复，等于白出一张。\n`
        + `   ⚠️ 名额有限时的优先级：动作或情绪的转折点 > 人物特写 > 环境空镜。`,
    // ↓ v0.9.52：时序此前完全空白 —— 正文常在一楼里完成一个小推进
    //   （"她先是站着，随后跪了下来"），模型却常按**开头**画，
    //   或把本楼还没发生的反应先画出来（"他还没来得及回应"就被画成在笑）。
    `2g. ★ **画面状态 = 本楼结束时**（或你指定的 ⟦P编号⟧ 那一刻）的状态，不是开头：\n`
      + `   已经发生且未被撤销的事实必须落进画面 —— 脱掉的衣服、流下的汗与泪、\n`
      + `   留下的痕迹、移动过的位置、已经开始的动作。\n`
      + `   反过来，**本楼还没发生的一律不画**：还没做出的反应、还没说出口的话、\n`
      + `   还没到达的人。\`他愣了一下\` 不等于 \`他在笑\`。`,
    `3. 写提示词：每张图先用 cast 点名画面里的每个角色（每人一项，带该角色自己的英文句），`
      + `再用 tag 写人数、两人之间的交互与情绪张力。`
      + (
        /**
         * ★★★ v0.9.118：MOSS 也必须输出 cast，只是**只写 name**。
         *   插件注入英文人物段靠 `image.cast` → 档案 → eff 这条链；
         *   v0.9.117 写的是「不要输出 cast」，于是 castAnchors 恒空、人物段永远生成不出来
         *   —— 代码写了等于没写，人物照样漂移。现在 cast 收窄成「点名」用途。
         *
         * ★★★ v0.9.122：**Layout 版还要再分一层**（用户要求「用 JSON 时别影响其他的」，
         *   反向也成立 —— 不能让纯 prompt 的规则污染 Layout）：
         *   纯 prompt 版：插件按档案注入英文人物段 → 模型**不许**再写外貌服装（重复即多手）。
         *   JSON Layout 版：`processImage` 短路、`castEn` 恒空 —— **根本没有人物段注入**。
         *   沿用纯 prompt 那句「不要写外貌、不要写服装」，模型就照办 →
         *   每个 character 项的 caption 只剩动作、没有脸和衣服（Layout 版最典型的退化）。
         */
        isJsonOut
          ? `**当前是 MOSS · JSON 口径**：cast **必须输出**，每项只写 name（用档案库里的准确名字），`
            + `不要写 look / en（临时角色的外貌写在它自己的 character 项里）。`
            + `⚠️ 本口径**插件不注入人物段**：外貌与服装要**你自己写**进每个 \`character\` 项的 caption。`
            + `漏了谁，谁就没有 character 项 —— 那一格里就没有这个人。`
          : (isMoss
            ? `**当前是 MOSS 口径**：cast **必须输出**，但**每项只写 name**（用档案库里的准确名字），`
              + `不要写 en、不要写外貌、不要写服装 —— 插件会按档案自动生成英文人物段并插进提示词。`
              + `\`tag\` 里用 \`the girl\` / \`the tall young man\` 指代，**不要写人名、不要写 @**。`
              + `漏了谁，谁就没有外貌锚定（会直接漂移）。`
            : `角色一律用 @角色名 引用（插件会展开成完整外貌+服装锚点）。`)
      ),
    // ↓ v0.9.42：服装原本指望模型写进英文句，结果同一会话连跑 3 楼、服装丢 2 楼
    //   （上衣一下连帽衣一下短袖）—— 服装是唯一没有代码兜底、全靠自觉的字段。
    //   现在改由插件机械注入到中文人物段，这里同步把「别再写一遍」写进规则：
    //   同一件衣服被描述两次 = 重复权重，实测会让模型多画一只手/一条腿。
    //
    // ★★★ v0.9.122：**Layout 版这条必须整个反过来**。
    //   Layout 下没有任何人注入服装（`castEn` 恒空），照抄「都不要在英文句里写」
    //   = 人物全裸 / 服装全丢 —— 与 Layout 模版正文「caption 里写全每一件衣服」直接对打，
    //   模型只会听其中一条（实测这类「两条规则互相抵消」永远是最难查的 bug）。
    isJsonOut
      ? `3b. **服装与裸露都必须写** —— 本口径下插件不注入人物段，没人替你写：`
        + `每个 \`character\` 项的 caption 里写全「发色发型 + 瞳色 + 脸型/肤色/体型 + 每一件衣服（带颜色）」。`
        + `同一项里**只完整写一次**（同义词重写一遍同样会被平均成模糊中间态）。`
        + `格内的衣着变化用**部位词挂在动作上**：\`collar\` / \`hem\` / \`sleeve\` / \`cuff\` / \`waistband\` / \`lapel\`。`
      : `3b. **服装和裸露都不要在英文句里写** —— 两者都由插件按档案原文机械注入到中文人物段，`
        + `你再写一遍就是重复权重（实测同一件衣服写两次会让模型多画出肢体）。`
        + `⚠️ **涉及衣物的动作照写不误**：抓住他的帽衫下摆、把围裙下摆掀开、手指勾住松紧带、`
        + `扯开领口 —— 这些是**动作**，不是服装描述，写了画面才成立。`
        + `⚠️ 反过来也一样：**不要用英文句去补"他穿着什么"**。你不做这个判断，`
        + `插件按档案注入，才不会一会儿有一会儿没有。`,
    `4. 位置必须是上面出现过的 ⟦P编号⟧，只在本楼范围内选，不要引用历史楼层。`,
    // ↓ 这条改写过一次。原版要求"按六要素补全"，模型于是每轮都重写一遍服装，
    //   两次补出的细节不同 → 领结 navy 变 dark red；且越补越长 → tag 从 473 涨到 901。
    //   补全只允许发生在"档案里确实是泛称"的时候，已有细节必须逐字沿用。
    `5. 服装沿用优先：档案里的服装字段**已经有具体描述时，原样沿用，一个字都不要改**。`
      + `只有档案里确实是泛称（school uniform / 校服 / 连衣裙 这类）时才补全六要素`
      + `（主色/质地 + 领型 + 结或领带 + 上衣 + 下装 + 袜鞋）。`
      + `已定下来的主色、质地、领型、结的颜色，哪怕你觉得可以写得更生动也**不许改动**`
      + ` —— 改一个颜色就是换了一件衣服。`,
    `6. 推进服装状态位时，款式描述逐字沿用档案库原文，只追加状态词（unbuttoned / slipped off 等）。`
      // ↓ v0.9.45：脱了又穿上 —— 用户实测「上一段已经脱下了，中间或后面又突然穿上」。
      //   根因是状态位只进不退 + 脱下后画面里没有任何"没穿衣服"的锚定。
      //   这里把状态位拆成互补的两半，并要求"穿回去"必须显式报 redress。
      + `★★ **脱衣服 = 两条字段一起改**：`
      + `① outfit 里**只留还穿在身上的**衣服（脱掉的删掉，别留在里面）；`
      + `② 同时写 outfitBare —— 此刻裸露的部位（英文），`
      + `如 naked from the waist down, sweatpants and underwear pushed down around his knees。`
      + `全脱光就写 outfit="" + outfitState="removed" + outfitBare="completely nude"。`
      + `★★ **穿回去也算变化，必须报**：正文写「把裤子提起来 / 重新穿好 / 拉上拉链 / 扣好扣子」时，`
      + `写 redress:true 并把 outfitState 退回 intact（或 parted），同时把 outfitBare 清空。`
      + `不报这条，插件会按防漂移规则拒绝状态回退 —— 状态位会永久停在"褪下"，`
      + `后面每一楼都还是裸的（或反过来，画面凭印象把衣服画回去）。`,
    `7. 临时状态（出汗、脸红、衣物滑落、失神等）只写**本楼这一刻**画面里真实存在的；`
      + `上一楼出现过、本楼正文没再提的，不要继续带进 tag。`,
    `8. 同一个意思不要换几种写法重复写（写了 shoes off 就别再写 standing barefoot、`
      + `standing_in_tights）。`
      // ★ v0.9.117：MOSS 多格提示词按「格」算篇幅，套 420 字符会把格子砍掉
      // ★ v0.9.157：单图没有格 —— 按「项」给额度，否则模型会以为要写三格的分量
      + (isJsonOut
        ? `MOSS 单图没有格子：每个 character 项 50~110 词（成人场景 85~130 词），`
          + `summary.caption 40~80 词。不要为了压字符数删掉承重面与主动作。`
        : (isMoss
          ? `MOSS 按**格**算篇幅：每格 40~90 词，三格合计 200~300 词（约 700~900 字符）是正常的，`
            + `不要为了压字符数删掉整格。`
          : `tag 总长控制在 ${cfg.consistency?.maxTagLength || 420} 字符内。`)),
    // ↓ v0.9.52：画面补全此前只有"这些由你主动补全"，没划边界 ——
    //   结果"深夜"被画成晨光、"阴天"被画成阳光灿烂（因为那样"更像一张好照片"）。
    //   这是最伤剧情忠实度的一类错误，且用户一眼就能看出不对。
    `9. ★ **画面补全的边界** —— 补「怎么拍」，不补「发生了什么」：\n`
      /**
       * ★★★ v0.9.157：单图口径**不许**让模型自定景别与机位。
       *   12 张单变量对照（`dev_tmp/shot_frame/`）：景别词与「承重面 + 落脚点」同场时，
       *   模型把人纵向拉长去填框（腿 ≈ 躯干两倍）；不写景别那一批比例正常。
       */
      + (isJsonOut
        ? `   可以自己定：构图、光线质感、色调、镜头语言。\n`
          + `   ⚠️ **景别与机位这次不要写**（不写 medium shot / from a low angle）——`
          + `取多大范围由动作自己决定，写了会把人物拉长去填框。\n`
        : `   可以自己定：机位、景别、构图、光线质感、色调、镜头语言。\n`)
      + `   必须从正文推：**时间**（凌晨三点就是暗光/夜色，不许画成晨光）、地点、\n`
      + `   在场的每一个人、人物的姿势与朝向、服装此刻的状态、已经留下的痕迹。\n`
      + `   ⚠️ 正文说「阴天」就不能出阳光，说「没开灯」就必须是暗调 —— `
      + `为了画面好看擅自改时间/光线/天气，是剧情忠实度里最容易被一眼看穿的错误。`,
    // ↓ v0.9.52：此前**没有任何一道剧情忠实度校验**（lintTag 5 项 + processImage 10 项
    //   全在查画面物理正确性）。唯一能发现"模型编了正文没有的东西"的手段，
    //   就是让它在交付前自己过一遍。
    `10. ★ **交付前逐张自检**（四条，任何一条不过就改到过为止）：\n`
      + `   ① **有出处吗**：画面里的每个事实，正文或档案里有依据吗？没有 = 你编的，删掉。\n`
      + `   ② **漏了吗**：本楼已经确立的变化（服装 / 位置 / 痕迹 / 情绪）都体现出来了吗？\n`
      + `   ③ **重复吗**：这张图和【近期已出过的图】（若有）是不是同一个瞬间？\n`
      + `      是 → 按 2f 换时刻 / 换机位 / 换人物焦点。\n`
      + `   ④ **写重了吗**：同一件事有没有被写了两遍？（重复声明 = 多画一个实例，不是强调）`,
    // ↓ v0.9.82「成人画面优先」：用户显式开关（默认关）。开时才追加，不开时一字不加。
    ...(cfg.adultPosePriority ? ['', adultPriorityBlock()] : []),
    '',
    '直接输出 JSON，不要解释、不要 Markdown 代码块。',
  );

  const messages = [
    { role: 'system', content: system },
  ];
  for (const block of contextBlocks) messages.push({ role: 'system', content: block });
  messages.push({ role: 'user', content: userParts.filter(x => x !== undefined).join('\n') });

  // 思维链预填充：以 <thinking> 开头，强迫模型先过检查清单再吐 JSON。
  // 解析端（protocol.js extractJsonText）本来就会剥掉 think 块，二者天然配套。
  // 默认不塞：推理模型（deepseek-v4 / R1 系）会因此把 max_tokens 全烧在思维链上、
  // 只回 reasoning_content 导致正文空 → 0 出图，且每次分析多烧一次调用。
  // 只有用户在设置里显式把 thinking 开成 true 时才加（非推理模型可用）。
  if (cfg.context?.thinking === true) {
    messages.push({ role: 'assistant', content: '<thinking>' });
  }
  return messages;
}

/**
 * USER（酒馆 persona 主角）**独立建档** —— v0.9.44。
 *
 * 为什么单独一步：主角跟几十个世界书群像混在**同一次建档请求**里，persona 段在长上下文里
 * 被淹没 —— 这一条根因链造出了之前每一轮「定位不到」：
 *   外貌层：模型把主角写成 <user> 占位符 → 出图查不到档案 → 没脸的路人（v0.9.26/27 修）；
 *   服装层：档案里并存「夜斗」+「<user>」两条 → 一个有服装一个未记录 → 模型自由发挥（v0.9.41 修）；
 *   建档层：群像卡把「整张卡」当成一个角色建条（v0.9.43 修）。
 * 绝对主角值得一次**只扫他一个人**的请求 —— persona 里有什么就提什么，绝不被群像冲淡。
 *
 * persona 里完全没有外貌描写时输出空数组（绝不脑补）—— 外貌是人设主权区。
 */
export function buildUserProfileScanMessages(p) {
  const userName = String(p.userName || '').trim();
  const sources = [];
  sources.push(`角色卡名称：${p.charName || '(未知)'}`);
  if (p.persona) sources.push(`\n用户设定（persona）—— 酒馆的绝对主角：\n${cleanBody(p.persona)}`);
  if (p.userDesc) sources.push(`\n用户补充设定：\n${cleanBody(p.userDesc)}`);

  const system = `你是「绘灵」的角色建档器。

任务：从用户设定（persona）里提取**这一位主角**的静态外貌锚点。静态锚点指跨楼层不会变的东西：性别、发型发色、眼睛、脸型、肤色、体型、永久标志（疤痕/纹身/耳饰）。

规则：
1. 只提取外貌。性格、背景、兴趣、身份一律不写。
2. hair 只放发型/发色/长度（如 long black hair, straight）；瞳色写 eyes（如 brown eyes）—— 不要把瞳色塞进 hair。
3. face 写**面容类型 / 年龄段气质**：loli face / young face / mature face / oval face / sharp eyes 这类；
   **眼镜、眼罩、帽子、耳机、口罩等穿戴物件不是脸型，一律写进 mark**。
4. 素材里没提的字段**留空字符串**，不要脑补。
5. 字段值用英文 danbooru 短 tag，多词用空格连接（不要下划线）。
6. 服装**不要**写进锚点字段（服装由剧情动态维护）。
7. **★ name 固定写「${userName}」** —— 这是酒馆用户设定（persona）里的绝对主角，名字逐字照抄，一个字都不许改。
   **严禁**写 <user> / <bot> / <char> / 「主角」这类占位符 —— 写了等于没建档，出图时他就是没脸的路人。
8. 若 persona 里**完全没有外貌描写**（只写了性格 / 背景 / 身份），输出 \`{"characters":[]}\` —— 绝不脑补，外貌是人设主权区。

只输出一个 JSON 对象，不要解释、不要代码块：

{
  "characters": [
    {
      "name": "${userName}",
      "label": "主角 / 唯一男性",
      "fields": {
        "sex": "1boy",
        "hair": "long black hair, straight",
        "eyes": "red eyes",
        "face": "young face",
        "skin": "",
        "body": "tall, athletic",
        "mark": "black-framed glasses"
      }
    }
  ]
}`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: sources.join('\n') },
  ];
}

/**
 * 建档请求：从角色卡 + 世界书提取静态锚点（**不含 persona** —— 主角走
 * buildUserProfileScanMessages 独立建档，两边互不干扰。persona / userDesc
 * 参数保留只为兼容旧调用方，这里**不使用** —— 塞进去模型就可能顺手输出主角，
 * 又回到「两条同名档案互相覆盖」的老路）。
 * 首次使用插件时跑一次，之后由主分析请求增量维护。
 */
export function buildProfileScanMessages(p) {
  const sources = [];
  sources.push(`角色卡名称：${p.charName || '(未知)'}`);
  if (p.description) sources.push(`\n角色卡描述：\n${cleanBody(p.description)}`);
  if (p.worldBook) sources.push(`\n内嵌世界书：\n${cleanBody(p.worldBook)}`);

  const system = `你是「绘灵」的角色建档器。

任务：从给出的素材里提取**每个可见角色的静态外貌锚点**。静态锚点指跨楼层不会变的东西：性别、发型发色、眼睛、脸型、肤色、体型、永久标志（疤痕/纹身/耳饰）。

规则：
1. 只提取外貌。性格、背景、兴趣、身份一律不写。
2. hair 只放发型/发色/长度（如 long black hair, straight）；瞳色写 eyes（如 brown eyes）—— 不要把瞳色塞进 hair。
3. face 写**面容类型 / 年龄段气质**：loli face / young face / mature face / oval face / sharp eyes 这类；
   **眼镜、眼罩、帽子、耳机、口罩等穿戴物件不是脸型，一律写进 mark**。
4. 素材里没提的字段**留空字符串**，不要脑补。
5. 字段值用英文 danbooru 短 tag，多词用空格连接（不要下划线）。
6. 服装**不要**写进锚点字段（服装由剧情动态维护）。
7. **★ 名字必须写真名，严禁占位符**（这是最容易出错的一条）：
${(() => {
  const cn = String(getCharName() || '').trim();
  const lines = [];
  if (cn) lines.push(`   - 「角色卡描述」**在写某一个具体人物**时 —— name 固定写「${cn}」。`);
  lines.push('   - 若角色卡描述写的是**场景 / 世界观 / 群像**（不是在写某一个人的外貌），');
  lines.push('     **不要**给卡片本身建条目 —— 实测给群像卡建档时会冒出一条 name=卡名、');
  lines.push('     label=「角色卡」、字段全空的废条目（它不是任何角色，删掉还不长记性还会再扫出来）。');
  lines.push('   - **用户设定（persona）里的主角由插件单独建档，这里不要输出他** ——');
  lines.push('     就算 persona 里写了他的外貌也不要 —— 两条同名档案会让出图时外貌互相覆盖。');
  lines.push('   - **不要**写 <user> / <bot> / <char> / 「男性」/「主角」这类占位符或代词 ——');
  lines.push('     写成占位符等于没建档：出图时插件拿这个名字去查档案，查不到 → 他没有外貌，');
  lines.push('     画面里会变成一个没脸的路人。上面给了名字就**逐字照抄**，一个字都不许改。');
  return lines.join('\n');
})()}

只输出一个 JSON 对象，不要解释、不要代码块：

{
  "characters": [
    {
      "name": "角色名",
      "label": "身份标签（如 女主 / 反派 / 配角）",
      "fields": {
        "sex": "1girl",
        "hair": "long black hair, straight",
        "eyes": "red eyes",
        "face": "young face",
        "skin": "",
        "body": "petite, small breasts",
        "mark": "black-framed glasses"
      }
    }
  ]
}`;

  return [
    { role: 'system', content: system },
    { role: 'user', content: `${sources.join('\n')}\n\n请提取角色档案。` },
  ];
}

/**
 * ★ v0.9.39 服装态扫描请求 —— 把「剧情正文写到的服装」抓进档案。
 *
 * 这个函数早期版本叫 buildOutfitProbeMessages，**从写好到今天从来没有被任何代码调用过**
 * （全项目只有定义处与设计文档提到它）。于是服装态只剩唯一一条写入路径：出词模型在
 * changes 里主动报 outfit。实测后果：22 楼里有 13 楼正文明确写了服装，插件 dyn 里
 * 落库的却是 0 条 —— 档案行里没有服装段，出图时模型只能每轮翻正文现编，服装必漂。
 *
 * 与旧版的两处关键不同：
 *   ① 批量：一次请求覆盖本楼在场的所有角色（旧版一次只问一个人，多人场景要调 N 次）
 *   ② 带历史：把最近 N 楼剧情一起喂进去，问的是「当前穿着」而不是「这楼提到过什么」
 *      ——「延续」正是靠这一条成立：中间没换过衣服的楼层不会把服装冲掉。
 *
 * @param {{names:string[], body:string, history:string[], snapshot:Array}} p
 */
export function buildOutfitScanMessages(p) {
  const names = (p.names || []).map(x => String(x || '').trim()).filter(Boolean);
  const cfg = getConfig();
  const presetNames = Object.keys(cfg.outfitPresets || {});

  // 已记录的角色把当前款式摆出来：模型据此判断"是同一件还是换了"，
  // 而不是每次都从零重新描述一遍。
  const known = [];
  for (const it of p.snapshot || []) {
    if (!names.includes(it?.name)) continue;
    const cur = resolveOutfitStyle(it?.dyn);
    known.push(`- ${it.name}：档案现款 ${cur ? `「${cur}」` : '（未记录）'}／状态 ${it?.dyn?.outfit?.state || 'intact'}`);
  }

  const system = `你是「绘灵」的服装态提取器。任务：从剧情正文里读出**每个角色此刻正穿着什么**，
转成英文短 tag（多词用空格连接），供后续每张出图逐字沿用。

★ 制式服装必须写全六要素（校服 / 西装 / 制服 / 护士服 / 和服这类"制度性服装"）：
  ① 主色 + 质地    ② 领型    ③ 结 / 领带 / 领巾
  ④ 上衣          ⑤ 下装 + 细节   ⑥ 袜 + 鞋
  例：white sailor blouse, navy collar with white stripes, red neckerchief,
      navy pleated skirt, white knee socks, brown loafers

只写 \`school uniform\` 是**不合格**的：这两个词在模型眼里对应几百种具体款式，
每张图都会重新诠释一遍 —— 这正是"一件校服换了好几个版本"的根因。

★ 输出铁律（比写得详细更重要）：
0. **必须写得出具体的衣服才能输出**。正文只写了「他的衣服被勒出声响」「洗得发白的球鞋」
   这类，就等于**没写衣服** —— 此时整个省略他，不要凑出「worn clothes」「everyday clothes」
   这种废话。泛称一旦落库会被永久沿用，比"未记录"更糟。
   具体衣服 = 上身 / 下装 / 连身（衬衫、T恤、卫衣、外套、裙、裤、围裙、制服、连衣裙…）。
   只有鞋袜、或只有"衣服/穿着/常服"这类统称 → 一律返回空、省略该角色。
★★ 0-bis. **你每次都在回答同一个问题：「此刻他身上还有什么、露出了什么」** ——
   不是"他平时穿什么"，也不是"档案里记着他穿什么"。档案现款只是参考基线。
   只要正文（含【服装线索·原文摘录】）出现了这个角色的穿着 / 脱衣 / 裸露描写，
   **就必须输出他**，哪怕结论是"跟档案一样"。省略 = 插件不更新 = 画面沿用旧状态。
1. **只输出正文真的写到的角色**。正文这一楼和最近剧情里没有提到某人的衣着，
   就**整个省略他**，不要凭身份脑补（不要因为"她是学生"就写校服）。
2. **档案里已有现款、且正文没有任何穿着相关描写 → 不要输出该角色**。沿用就是最正确的答案，
   重复输出只会带来措辞变化，那正是款式漂移的来源。
   ⚠️ 但"没有任何穿着描写"的门槛很低 —— 只要写了「褪到膝盖」「露出大腿」「把裤子提起来」
   这类**任何**与衣物位置/身体暴露有关的句子，就算有描写，规则 0-bis 优先。
2-bis. **档案现款照抄回去是允许的**：判断出"跟档案一样"时，就原样输出档案那串，
   不要换个说法重写（换说法才是漂移的来源）。插件靠覆盖率比对，逐字一致最安全。
3. **只有正文明确出现换装描写**（"她换上了…""脱掉外套换了一身…"）才输出新款，
   并把 outfitState 写成 "swapped"。措辞变化（"宽松的围裙"→"粗亚麻围裙"）不是换装。
4. 服装状态位从这五个里选：intact（完好）、parted（半褪）、undone（解开）、
   removed（褪下）、swapped（已换）。判断不了就写 intact。
   · 衣服还在身上、只是被拉开 / 解开 / 滑到肩上 → parted 或 undone
   · 衣服离开了身体（褪到膝盖、掉在地上、被扔到一边）→ removed
   · 上下身状态不同（上衣还在、下身全裸）→ 按**暴露程度更深**的那半写

★★ 5. **脱掉的衣服不许再写进 outfit** —— 这是最容易错的一条（v0.9.45 实测）：
   一旦把已经褪下的衣服留在 outfit 里，插件会照着注入「身穿 XX」，
   画面上就变成「上一段明明脱光了，这一段又穿上了」。
   正确做法是**一分为二**：
     · outfit    = **此刻还穿在身上的**衣服（没有就留空字符串）
     · outfitBare = **此刻裸露的部位**（英文），脱到一半就把褪下的衣物位置也写进去
   例：
     · 只脱下身 → "outfit":"black hoodie",
                 "outfitBare":"naked from the waist down, grey sweatpants and underwear pushed down around his knees"
     · 全脱光   → "outfit":"", "outfitState":"removed", "outfitBare":"completely nude"
     · 没脱     → "outfitBare":""（留空，不要写 clothed / dressed 这种反话）
   ⚠️ 规则 2 的"沿用就不输出"在这里**不适用**：只要穿着状态变了（脱 / 穿回去），
   就必须输出该角色，否则状态位不更新。
6. **重新穿好也是有效变化**：正文写「把裤子提起来 / 重新穿好 / 拉上拉链 / 扣好扣子 /
   套回去」→ outfitState 回到 intact 或 parted，并把 "redress" 写成 true。
   少了这个标记，插件会按防漂移规则拒绝状态回退（那是防止衣服乱换的保护），
   状态位会永久停在"褪下"，与剧情彻底脱节。
7. 若该角色的穿着与下列某个「服装预设」吻合，写 outfitPreset 引用它，outfit 留空：
   ${presetNames.length ? presetNames.map(n => `@${n}`).join(' / ') : '（当前没有预设）'}
   引用预设的好处是以后改一次预设，全体角色同步。

★★ 8. **outfit 要输出"此刻身上的完整一套"，不能只写本楼恰好提到的那一件**（v0.9.48）：
   本楼经常只提一件（「她的针织衫滑到肩上」「裙摆被撩起来」），
   这时正确做法是**拿档案现款当底稿，把本楼的变化套上去**，其余部分照抄补齐。
     · 档案现款：light blue knit sweater with a wide neckline, no bra, grey cotton long skirt
     · 本楼只写了「针织衫滑落一侧肩」→
       outfit: "light blue knit sweater with wide neckline slipped off one shoulder, no bra, grey cotton long skirt"
     · ✗ 反例（针织衫凭空消失）："black lace bra strap, grey cotton long skirt, pink slippers"
   **旧款里的上装 / 下装 / 连身衣，只要正文没写他脱掉、也没写他换掉，就必须原样保留。**
   漏掉一件会被插件判成"提取漏项"直接拒绝 —— 那一楼等于白扫，画面还会沿用旧状态。

★★ 8-bis. **变化 = 同部位替换，禁止追加叠加**（v0.9.58）：
   按规则 8 套变化时，本楼新穿的衣物要**替换**底稿里同一部位的那一件，
   不是在句子后面追加第二件。
     · 档案现款 "...cream-white over-knee socks, ..." + 本楼「换上了黑丝」→
       ✓ "...black thigh-high stockings, ..."（黑丝**替换**白丝）
       ✗ "...cream-white over-knee socks, ..., black stockings"（两双袜子并存 = 错误输出，
         两个颜色词一起进提示词，模型两头一起画 —— 白丝+黑丝叠穿就是这么来的）
   同一部位（袜 / 内裤 / 鞋 / 上装 / 下装）在输出里**只允许出现一件**；
   被脱下还挂在身上的（torn / hanging around her calf）不算穿着，写进 outfitBare。

${
  /**
   * v0.9.72 · 可选段：让扫描模型顺手填「服装三维度」。
   *
   * ★ 只在开关打开时出现（cfg.consistency.autoOutfitDims）—— 这是**写权限**，默认关。
   *   关着时模型根本看不到这一段，就算它自己脑补回这三个字段，落库侧也会忽略（双保险）。
   *
   * ★ 只让模型选**档名**，不让它写英文：
   *   英文由插件按档名从 outfitStateLibrary 取 —— 模型自由发挥的英文会破坏
   *   「只认库档名」这条护栏（允许更新、不允许漂移），也会被 store 静默丢弃，
   *   等于白花 token 还给模型制造"我明明写了怎么没生效"的困惑。
   */
  autoOutfitDimsOn() !== true ? '' : `

★★ 9. **三维度（附加题，只在你有把握时填）**：
   除了 outfit / outfitState，这里还有三个可选字段，用来把"穿成什么样"说得更准。
   三个字段**都只能从下面给的档名里挑一个原文照抄**，写别的（含英文、含自创说法）一律作废。
   · outfitDetail —— 衣物此刻的位置状态。${dimListText(OUTFIT_STATE_DETAILS, '可选档名') || '（无）'}
   · outfitMod    —— 衣物本身被改造成什么样（透明 / 撕裂 / 高开衩…）。${dimListText(OUTFIT_MODS, '可选档名') || '（无）'}
   · outfitShoes  —— 脚上穿什么。${dimListText(OUTFIT_SHOES, '可选档名') || '（无）'}
   拿不准就**整个字段不写**（不写 = 沿用上一楼），不要猜、不要为了填满而填。
   ⚠️ 只有在正文真的写了"衣服滑下来 / 裙子被撩起 / 换了一双高跟鞋"这类描写时才填；
      正文没提就一律留空 —— 填错比不填糟糕得多（它会直接进画面）。`
}

只输出 JSON，不要解释、不要 Markdown 代码块：
{"outfits":[{"name":"周雅","outfit":"grey linen painting apron, side ties, no underwear, barefoot in flip-flops","outfitState":"intact","outfitPreset":"","outfitBare":""${
  /**
   * ★ 关着时示例里也**不能出现**这三个键 —— 示例是模型照抄的模板，
   *   出现在示例里等于变相要求它输出（关了却还在收，就是假关）。
   */
  autoOutfitDimsOn() !== true ? '' : ',"outfitDetail":"","outfitMod":"","outfitShoes":""'
},"redress":false}]}\`${
  autoOutfitDimsOn() !== true ? '' : '（三维度字段只在有把握时才写，没把握就整个不写这个键。）'
}`;

  const userParts = [];
  userParts.push(`【需要判断的角色】\n${names.map(n => `- ${n}`).join('\n')}`);

  /**
   * ★ <user> 到底是谁 —— 与主分析请求（buildAnalyzeMessages）同一条说明，缺了它
   * 服装扫描必然漏掉男主。
   *
   * 实测：主角往往就是跟你对话的用户本人，档案库里有两条独立条目（「夜斗」+「<user>」），
   * 名字逐字不同、外貌描述雷同。扫描请求里若不给这句说明，模型看到 `<user>` 不知道
   * 指的是谁，就**整个不输出他** —— 男主每次都拿不到服装，而女角色因为正文里反复写
   * 「她的围裙」每次都有。这正是「女角色有服装、男主没有」的成因之一。
   */
  const userName = String(getUserName() || '').trim();
  if (userName && names.includes('<user>')) {
    userParts.push(
      `【画面里怎么称呼「你」】名单里的 <user> 就是「${userName}」—— 同一个人。`
      + `请直接为「${userName}」这一项输出他的服装（不要写 <user>，也不要因为分不清就跳过他）。`,
    );
  }
  if (known.length) {
    userParts.push(`【他们档案里的现款】\n${known.join('\n')}`);
  }
  if (Array.isArray(p.history) && p.history.length) {
    userParts.push(
      `【最近剧情】（只看"此刻穿着"，不要为这些楼层单独建档）\n`
      + p.history.map((h, i) => `— 前 ${p.history.length - i} 楼 —\n${h}`).join('\n'),
    );
  }
  userParts.push(`【本楼正文】\n${cleanBody(p.body || '')}`);
  /**
   * ★ 服装线索（原文摘录，含元认知块）—— 男主的衣服几乎只在这里出现。
   *   `cleanBody()` 会把 `[metacognition]…` 整块删掉，而主模型偏偏爱把
   *   「夜斗穿着牛仔裤」写在那里面。少了这一段，扫描器永远看不到男主穿什么。
   */
  if (p.clues) {
    userParts.push(
      `【服装线索·原文摘录】（从原文里捞出的所有衣着描写，含分析/旁白块——**这部分最可靠**）\n${p.clues}`
      + '\n注：上面的【本楼正文】是清洗过的（分析块已移除）；这一段是原文摘录，两者都算数。',
    );
  }
  userParts.push('请输出这些角色此刻的服装（按上面的铁律，该省略的就省略）。');

  return [
    { role: 'system', content: system },
    { role: 'user', content: userParts.join('\n\n') },
  ];
}

/** 供 UI 预览：当前生效模版的字符数与估算 token。 */
export function templateStats() {
  const tpl = getActiveTemplate();
  const total = [tpl.system, tpl.spec, tpl.protocol, tpl.jailbreak].join('').length;
  return {
    name: tpl.name,
    systemChars: tpl.system.length,
    specChars: tpl.spec.length,
    protocolChars: tpl.protocol.length,
    jailbreakChars: tpl.jailbreak?.length || 0,
    totalChars: total,
    // 中文按 1.5 字符/token 粗略估
    roughTokens: Math.round(total / 1.6),
    charName: getCharName(),
    userName: getUserName(),
  };
}
