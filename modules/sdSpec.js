/**
 * 绘灵 · SD（Illustrious / danbooru）纯 tag 口径规范 v3
 *
 * 为什么要重写（2026-10-18 用户拍板）：
 *   旧「SD漫画宫格」的 spec 是从 K2 那份复制改的，混进了大量 K2 专属规则：
 *     · 要求模型写「身体关系句」→ 输出 `his hips aligned with hers`（danbooru 里搜不到，纯噪声）
 *     · 要求模型自己写人数词 / 每角色分段 → 插件也写一份 ⇒ `1girl, 1girl`、两人挤一段（串台）
 *     · 420 字符硬预算 → 与插件「人物外貌本来就很长，放宽」的口径冲突
 *     · 手写 `no_shoes` 又被 §3.7 判成否定句，自相矛盾
 *
 * v3 的核心是**分工**（做减法）：
 *   插件已自动做：人数词、每人外貌+服装锚点、每角色独立分段 + BREAK
 *   模型只负责：动作 / 承重面 / 接触 / 表情 / 视线 / 景别机位 / 场景 / 光线
 *   ⇒ 模型不再复述外貌服装（复述＝实体复制，多手 / 串台的直接原因）
 */

export const SD_SPEC_VERSION = 4;

/**
 * ★ v0.9.101 · 从 v3 升到 v4 的唯一原因：**成人剧情的跨格/跨楼延续**。
 *
 * 实测病例（2026-10-19 用户报）：正文已经写到抽插 / 撞击，但同一场戏后几张图的 tag
 * 只剩 `sweat` / `trembling` / `on bed` 这类状态词，**没有任何行为 tag**。
 *
 * 三条根因，全部是「规范缺位」而不是模型不听话：
 *   ① v3 的输出协议只写「每张图按 §四 六维度各选 1~2 个」——
 *      §四.3「动作与持物」的词表是 walking / eating / hug / holding cup，**没有性行为**。
 *      模型照协议填表 → 成人场景也只从这六维度里挑 → 行为 tag 根本不进输出。
 *   ② v3 规范里 `阶段` / `进行中` / `延续` 各 0 处（K2 的 §3.9 ④b 有完整五阶段表）。
 *      没有阶段概念，模型就分不清「这格该是前戏还是进行中」，也无法判断"该保持不变"。
 *   ③ 「不要重复」被泛化成跨图规则 → 上一张写过的 `sex, vaginal` 这一张就不写了。
 *      但 danbooru tag 是**无状态**的：不写 ≠ 延续，等于这张图里没有这件事。
 *
 * v4 只做三件事（做减法：不加词表、不加权重语法）：
 *   · §5.1 判定放宽（正文只写动作词也算 NSFW，不必出现「插入」）
 *   · §5.11 五阶段 + 跨格延续（同楼按阶段分工 / 跨楼只能前进 / 进行中每格重写）
 *   · 协议层把「六维度」改成 SFW/NSFW 二选一分支
 */

export const SD_SPEC_V4 = `# 一致性规范（Illustrious / SD · 纯 tag 口径 v4）

## 零、分工：插件已经做的事，你一个都不要重做

绘灵把 tag 交给后端之前，已经自动完成三件事：

1. **人数词**（\`1boy\` / \`1girl\`）—— 由角色档案的性别字段输出，写在每个角色段段首
2. **每个角色的外貌 + 服装锚点** —— 从档案逐字注入，每个角色独立成一段
3. **段间 \`BREAK\`** —— 角色段之间自动隔开

所以你只写一个 \`tag\` 字段，内容是**画面公共区**。
最终提示词由插件拼成：

\`\`\`
1boy, 1girl, <你写的 tag>
BREAK
1boy, <男主外貌服装>
BREAK
1girl, <女主外貌服装>
\`\`\`

**绝对不要写进 tag 的东西**（写了就是第二份 → 权重翻倍 → 多手 / 串台 / 两套衣服）：

- \`1girl\` / \`1boy\` / \`2girls\` 这类人数词
- 发色、发型长度、瞳色、脸型、肤色、体型、胸型
- 服装款式与颜色（衬衫、裙子、丝袜、鞋、领结）
- 「她穿着…」「他的…」这类归属句

\`@角色名\` 可以写 —— 它只用来点名「这一格有谁出场」，插件会把它展开成该角色的独立段
（外貌 + 服装 + 人数词都在那一段里）。**不要**在 tag 里另外抄一遍外貌。

### 零.3 ★★★ 头号铁律：一个意思只写一条

**写第二条不是"强调"，是让模型把这件事画两遍。**

| 你写了 | 模型画出来 |
|---|---|
| \`from behind\` + \`profile\` | 朝向取平均 → **扭身 / 断腰 / 脖子错位** |
| \`vaginal\` + \`penetration\` + \`sex\` | 同一件事画两遍 → **多一套器官 / 肢体折叠** |
| \`close up\` + \`pussy\` | 特写画幅装不下 → **把腿和器官硬塞进头肩**（§2.4 已禁） |
| \`sweat\` + \`tremble\` + \`blush\` | 同一维度超量（§4.2 只允许 0~2）→ **表情扭曲** |

**判定方法**：写完一条，问「再加一个同类的词，这张图会变成两件事吗？」
会 → 只留信息量最大的那一条。不会（\`lying\` + \`on desk\` 是姿态 + 支撑物）→ 可以共存。

**为什么词少反而好看**：生图模型没有"取舍"能力。它会把每条 tag 都画一点 ——
词一多，每一块都"对"，整体全错。**一张图只拍一个瞬间，就只写这个瞬间的那几个词。**

## 一、口径：只认 danbooru 枚举 tag

- **禁止句子**：\`a girl sitting on bed in morning light\` ❌ → \`sitting, on bed, morning, sunlight\` ✅
- **禁止自创词组**：只写 danbooru 词典里真实存在的词。
  \`male uniform\` / \`weight on her left leg\` / \`clothes partially slid down\` / \`looking away\` /
  \`tired\` / \`medium shot\` 这些搜不到，写了等于塞噪声，还会稀释真 tag 的权重。
- **写法统一空格，禁用下划线**：\`looking at viewer\` ✅ / \`looking_at_viewer\` ❌
  （CLIP 会把下划线拆成 \`looking\` + \`_\` + \`at\`，每个词多耗一个 token；整份提示词不得混用两种写法）
- **禁止中文**进 tag（中文标签、中文备注都不行）。
- **判断标准**：这个词能不能在 danbooru 原样搜到。搜不到＝不要写。
- §四 / §五 的词表全部取自 danbooru 词典（本地 tagcomplete），可以直接照抄；
  表里没有的词＝需要先查词典，**不要自造**。

## 二、tag 段的写法

### 2.1 顺序（越靠前越重要）

动作 → 承重面 → 接触 → 表情 → 视线 → 景别 → 机位 → 场景 → 光线时间

前 8~12 个 tag 决定整张图的调性（CLIP 的全局语义只取第一块），所以**动作姿态必须排最前**，
场景光线放后面 —— 把环境词顶到开头，出图就是一张「跟剧情无关的风景照」。

★ 上面这九类**每一类只写 1 条**（只有「接触」和「表情」允许 2 条）。
  这不是建议 —— 写第 2 条就是在让模型把这件事画两遍（见 §零.3）。
  一张图 = 一个瞬间。写满九类各一条 ≈ 12 个 tag，**已经够了**；再多就是噪声。

### 2.2 承重面 / 姿态：**一个就够**，优先用动作词

★ **\`standing\` 一律不写** —— 它是模型的默认姿态（几乎所有立绘都站着）。
  写它不说任何信息，还会和体位词打架。

按下面优先级**只写一条**，命中就停：

1. **体位词**（自带姿态，不用再配姿态词）：
   \`doggystyle\` \`missionary\` \`cowgirl position\` \`reverse cowgirl position\`
   \`standing sex\` \`mating press\` \`spitroast\` \`sitting on lap\`
   → 写了它，就**不要再写** \`all fours\` / \`on back\` / \`on stomach\` / \`lying\` / \`standing\`。
     \`doggystyle\` 本身画的就是趴跪；再写 \`all fours\` 是同一个意思写两遍（§零.3）。
2. **姿态词**（没有体位词时才写，选一个）：\`sitting\` \`kneeling\` \`lying\` \`all fours\`
   \`squatting\` \`bent over\` \`straddling\`
3. **朝向**（最多一个）：\`on back\` \`on side\` \`on stomach\`

★★ **\`lying\` 与朝向词二选一，不能同时写**（用户 2026-10-20 直接质疑：有了躺卧为什么还要俯卧）。

\`lying\` 是**上位词**，danbooru 画出来默认是仰卧；\`on stomach\`（俯卧）/ \`on back\`（仰卧）/
\`on side\`（侧卧）才是它的**细分**。同时写 \`lying\` + \`on stomach\` ＝ 给"仰躺"和"俯卧"
各一份权重 → 模型只能画一个扭曲的中间态（身体朝向打架、四肢翻折）。

| 想表达 | 写 | 不要写 |
|---|---|---|
| 趴着 | \`on stomach\` | \`lying\` + \`on stomach\` |
| 仰躺 | \`on back\` | \`lying\` + \`on back\` |
| 侧躺 | \`on side\` | \`lying\` + \`on side\` |
| 只说"躺着"、朝向无所谓 | \`lying\` | — |
| 趴着且在床上 | \`on stomach, on bed\` | \`lying, on stomach, on bed\` |

贯通 §零.3：**精确词优先，泛化词让位** —— 和 \`socks\` + \`thighhighs\` 是同一条规矩。

**支撑物单独算，可以写**：\`on bed\` \`on floor\` \`on chair\` \`on couch\` \`on desk\`
\`against wall\` \`on lap\`
—— 它不表达"身体怎么摆"，只表达"身体在哪"，与姿态不冲突，写它有实际收益。

★ 写成两套（\`doggystyle\` + \`all fours\`、\`missionary\` + \`standing\`）＝ 让模型各画一半：
  悬空、断肢、两具身体叠成一团。

### 2.3 手位（缺一项必崩）

写清两只手分别在哪：\`hand on hip\` \`arms at sides\` \`crossed arms\` \`arms behind back\`
\`hand in pocket\` \`hand on own face\` \`covering face\` \`holding\` \`holding cup\`
\`holding phone\` \`holding book\`
只写姿态不写手位，一定长出第三只手或多指。

### 2.4 景别与机位（各选一个，**不许并列**）

景别：\`close up\` \`upper body\` \`cowboy shot\` \`full body\` \`wide shot\` \`portrait\` \`lower body\`
- 接触点在躯干以下时**禁用** \`close up\` / \`upper body\`（画面外的东西模型会硬塞进来）
- 选了 \`upper body\` 就别写鞋袜、裙长这类画面外的部位

机位：\`from side\` \`from above\` \`from below\` \`from behind\` \`profile\` \`dutch angle\` \`fisheye\`
- ★ 写了两个机位不是"更准确"，是让模型把人物朝向**取平均** → 身体扭转 / 脖子错位。
  想要侧后方视角就写 \`from behind\`，不要 \`from behind, profile\` 一起写。
- ★ 景别同理：\`close up\` 和 \`full body\` 同时写，模型会画成四不像。

### 2.5 表情 / 视线 / 嘴（每张都要写）

- 表情 1~2 个（见 §四.1）。面无表情也要显式写 \`expressionless\`
- 视线一个：\`looking at viewer\` \`looking at another\` \`looking down\` \`looking up\`
  \`closed eyes\` \`half closed eyes\` \`eye contact\` \`jitome\`
- 嘴可选一个：\`open mouth\` \`closed mouth\` \`parted lips\` \`tongue out\` \`lip bite\` \`teeth\`

### 2.6 多人关系：用 tag，不要用句子（★ K2 的写法在 SD 是负分）

K2 那套要求写句子（\`his hips aligned with hers\`），**Illustrious 完全不认**：
这些词组不在词典里，模型收到的是噪声，还会把外貌服装 tag 的权重稀释掉。

| K2 会写的句子 | SD 写什么 |
|---|---|
| \`his hips aligned with hers\` | \`straddling\` / \`on lap\` / \`mating press\` |
| \`her legs wrapped around his waist\` | \`leg lock\` / \`legs up\` |
| \`weight on her left leg\` | \`standing on one leg\` |
| \`he is behind her\` | \`sex from behind\` / \`doggystyle\` |
| \`looking into each other's eyes\` | \`eye contact\` |
| \`one hand on her waist\` | \`hand on hip\` |
| \`her back pressed against his chest\` | \`hug\`（或直接删掉这句） |

**tag 里出现 \`his\` / \`her\` / \`with hers\` 这类从句＝不合格**，必须换成单个枚举词。
关系由「人数词 + 承重面 + 接触 tag」表达，不靠句子。

### 2.7 禁止项

- **禁止否定句**：想要「没有鞋」就别写鞋，写 \`no shoes\` 反而会画出鞋。
- **禁止权重语法**：\`(tag:1.2)\` \`[tag]\` \`tag:1.2\` 一律不写（原因见 §三）。
- **禁止画风与质量词**：\`masterpiece\` \`best quality\` \`anime style\`（画风由底模与 LoRA 锁）。
- **禁止画面内文字**：\`speech bubble\` 只画气泡框，别指望画出可读字。
- **禁止跨图引用**：\`同上\` / \`承接上一张\` / \`略\`。
- **禁止画外内容**：谁在按快门、机位架在哪、心理因果。
- **禁止重复**：同一个意思只写一次（\`barefoot\` 与 \`no shoes\` 选一个）。

### 2.8 篇幅

单格 40 个 tag 以内。锚点（外貌 / 服装）由插件注入，不计入你的预算 ——
所以**你写满 40 个也压不掉人物**，但写超了会挤掉动作的权重：优先动作与接触，其次场景光线。

## 三、权重：不要加权（插件不过滤，写了就生效）

\`(tag:1.2)\` / \`(tag)\` / \`[tag]\` / \`tag:1.2\` 都不要写。原因：

1. 注意力总量共享，抬高一个＝压低其余 → 真正重要的动作与接触点反而丢失
2. embedding 被数乘放大，Illustrious 没在这种分布上训练过 → 过曝、色块、结构堆叠
3. 等效抬高 CFG → 肢体多余、画面自相矛盾

想强调 → **往前挪**（首因效应 + 相邻 tag 合并成簇）；想弱化 → **往后挪或删掉**（删比减权安全）。

唯一豁免：小物件 / 小饰品，最多 1~2 个词，1.1~1.25，绝不超过 1.3。
人数词、景别机位、\`comic\`、服装 tag **一律不许加权**。

## 四、日常剧情状态（缺这块是「画面跟剧情不搭」的主因）

每格**至少命中 4 个维度**，每个维度只选 1~2 个词。

### 4.1 情绪表情（1~2）
正向：\`smile\` \`grin\` \`smirk\` \`laughing\` \`happy\` \`blush\` \`light blush\` \`shy\` \`embarrassed\` \`seductive smile\`
负向：\`frown\` \`sad\` \`crying\` \`tears\` \`tearing up\` \`wiping tears\` \`angry\` \`annoyed\` \`glaring\` \`shouting\`
\`screaming\` \`sulking\` \`pout\` \`disgust\` \`disappointed\` \`frustrated\` \`despair\` \`sigh\` \`scowl\` \`jitome\`
波动：\`surprised\` \`scared\` \`worried\` \`confused\` \`thinking\` \`serious\` \`smug\` \`wince\`
\`rolling eyes\` \`trembling\` \`twitching\` \`yandere\` \`drunk\`
无表情：\`expressionless\`

### 4.2 生理状态（0~2）
\`sweat\` \`heavy breathing\` \`sleepy\` \`exhausted\` \`awake\` \`yawn\`
\`pain\` \`injured\` \`wound\` \`blood\` \`bruise\` \`cut\` \`bandage\` \`hospital\` \`fever\` \`sick\` \`sneeze\`
\`hungry\` \`disheveled\` \`wet clothes\` \`trembling\` \`blush\`

### 4.3 动作与持物（1~2）
动作：\`walking\` \`running\` \`jumping\` \`sleeping\` \`eating\` \`drinking\` \`reading\` \`pointing\`
\`leaning\` \`leaning forward\` \`carrying\` \`hug\` \`holding hands\` \`interlocked fingers\` \`princess carry\`
持物：\`holding\` \`holding cup\` \`holding phone\` \`holding book\` \`holding bag\` \`holding bottle\`
\`holding umbrella\` \`holding flower\` \`holding food\` \`holding tray\` \`holding knife\`
手势：\`crossed arms\` \`arms behind back\` \`arm up\` \`arms at sides\` \`hand in pocket\`
\`hand on own face\` \`covering face\` \`finger in mouth\`

### 4.4 姿态与承重
\`standing\` \`sitting\` \`lying\` \`on back\` \`on side\` \`on stomach\` \`kneeling\` \`squatting\` \`bent over\`
\`all fours\` \`straddling\` \`wariza\` \`yokozuwari\` \`crossed legs\` \`legs together\` \`legs apart\` \`leg up\`
\`on bed\` \`on floor\` \`on chair\` \`on couch\` \`on lap\` \`against wall\` \`standing on one leg\`

### 4.5 场景（1~2）
室内：\`bedroom\` \`classroom\` \`bathroom\` \`kitchen\` \`stairs\` \`hallway\` \`cafeteria\`
\`office\` \`library\` \`shop\` \`infirmary\` \`clubroom\` \`basement\` \`elevator\` \`entrance\` \`doorway\`
室外：\`rooftop\` \`garden\` \`park\` \`street\` \`road\` \`alley\` \`city\` \`cityscape\` \`bridge\` \`shrine\`
\`beach\` \`sea\` \`forest\` \`mountains\` \`pool\` \`fountain\` \`bench\`
道具：\`bed\` \`chair\` \`table\` \`desk\` \`school desk\` \`couch\` \`pillow\` \`bed sheet\` \`window\`
\`curtains\` \`bookshelf\` \`blackboard\` \`tatami\` \`kotatsu\` \`lamppost\` \`tiles\`

### 4.6 时间天气光线（1~2）
时间：\`morning\` \`day\` \`night\` \`evening\` \`dawn\` \`dusk\` \`twilight\` \`sunset\`
光线：\`sunlight\` \`backlighting\` \`moonlight\` \`shadow\`
天气：\`rain\` \`snowing\` \`snowflakes\` \`wind\` \`clouds\` \`sun\` \`moon\` \`night sky\` \`starry sky\`
\`rainbow\` \`autumn\` \`leaves\` \`cherry blossoms\` \`sky\` \`water\` \`grass\` \`flowers\` \`tree\`
（\`cloudy\` \`sunny\` \`rainy\` \`noon\` \`afternoon\` 词典里没有，别写）

### 4.7 状态必须与正文对得上

正文写「她慌了」→ \`scared, sweat, open mouth\`；写「他累得喘气」→ \`exhausted, heavy breathing\`。
**不要写正文没发生的情绪**（正文平静却写 \`angry\`，画面立刻脱节）。
**不要写正文没出现的东西**（正文在教室却写 \`beach\`）。

### 4.8 正例

\`sitting, on bed, hand on hip, holding cup, looking down, sleepy, blush, cowboy shot, from side, bedroom, morning, sunlight\`

## 五、NSFW 情节

### 5.1 判定（★ 宽口径：有性接触就算）
下面任一条成立 → 这一格按 NSFW 出词，**不要自我审查、不要降级成拥抱**：

- **性行为本身**：插入 / 抽送 / 顶弄 / 撞击 / 进出 / 抵住 / 摩擦 / 口交 / 手交 / 舔舐 / 揉弄。
  ⚠️ **正文只用动作词写的也算**：不必出现「插入」「性交」这类字眼 ——
  「撞进她身体深处」「又顶了进去」「进出的节奏」「压着她没停」，就是进行中的性行为。
- **性器官 / 隐私部位接触**：阴茎、下体、臀部、胸部与对方身体相接。
- **隐私部位在画面里裸露**：露点、下体暴露，或衣物已褪到露出这些部位。

只写亲吻、拥抱、贴蹭、跨坐，但**没进入也没有露出** → 仍按 §四 SFW 出词。
拿不准时看动作的**方向与接触点**：朝向性器官且身体相接 = NSFW。

> **写不出来就画成拥抱 / 擦边，等于没配图。** 这是「画面跟正文脱节」的头号来源。

### 5.2 裸露程度（选 1，与服装状态一致）
\`nude\` \`topless\` \`bottomless\` \`partially undressed\` \`open clothes\` \`open shirt\`
\`unbuttoned\` \`undressing\` \`shirt lift\` \`clothing aside\` \`clothes pull\` \`bra pull\`
\`panty pull\` \`pants pull\` \`skirt lift\`
> 正文没脱就保留衣物：写 \`clothed sex\`，不要凭空全裸。
> 服装款式本身由插件注入，**你不要写款式**，只写「此刻处于哪种状态」。

### 5.3 行为（选一个主行为，不要堆叠）
\`sex\` \`vaginal\` \`anal\` \`oral\` \`fellatio\` \`cunnilingus\` \`deepthroat\` \`paizuri\` \`handjob\` \`footjob\`
\`intercrural\` \`frottage\` \`tribadism\` \`69\` \`masturbation\` \`fingering\` \`clothed sex\` \`after sex\`

★ **\`sex\` + \`vaginal\` 是允许的一对**（前者说明"在做什么"，后者说明"哪种"）。
  除此之外**不许再叠第三个**：写了 \`vaginal\` 就不要再写 \`penetration\` / \`oral\` / \`anal\`。
  §零.3 已说明 —— 第二条不是加分，是让模型把同一件事画两遍（多一套器官 / 肢体折叠）。

### 5.4 体位（选 1，与承重面、朝向必须一致）
\`missionary\` \`cowgirl position\` \`reverse cowgirl position\` \`doggystyle\` \`standing sex\`
\`sex from behind\` \`sitting on lap\` \`mating press\` \`spitroast\`
- 写 \`doggystyle\` 就配 \`on bed\` / \`on floor\` / \`all fours\`，别同时写 \`standing sex\`
- 腿位显式写：\`spread legs\` / \`legs up\` / \`legs apart\`（不写，模型会把腿画成并拢，行为就对不上）

### 5.5 姿态 / 接触（选 1~2）
\`on back\` \`on stomach\` \`on side\` \`all fours\` \`bent over\` \`kneeling\` \`squatting\` \`straddling\`
\`spread legs\` \`legs up\` \`legs apart\` \`leg lock\` \`carrying\` \`restrained\`
\`against wall\` \`on bed\` \`on desk\` \`on floor\` \`sitting on lap\` \`ass up head down\`
\`breast grab\` \`groping\` \`hug\` \`french kiss\` \`licking\` \`hickey\` \`nipple to nipple\`

### 5.6 部位（画面上看得见的就必须写）
\`penis\` \`testicles\` \`pussy\` \`clitoris\` \`nipples\` \`breasts\` \`large breasts\` \`huge breasts\`
\`cleavage\` \`sideboob\` \`underboob\` \`ass\` \`anus\` \`thighs\` \`crotch\` \`groin\` \`pubic hair\`
\`spread pussy\` \`erection\`
**怕写而留白，模型会自己补一个错的版本。**

### 5.7 体液 / 结果（选 0~2）
\`cum\` \`ejaculation\` \`orgasm\` \`bukkake\` \`facial\` \`cum in pussy\` \`cum on body\`
\`drool\` \`drooling\` \`sweat\` \`wet\` \`pussy juice\` \`female ejaculation\`

### 5.8 表情与反应（成人画面必写，选 1~2）
\`ahegao\` \`aroused\` \`moaning\` \`tongue out\` \`closed eyes\` \`half closed eyes\` \`rolling eyes\`
\`blush\` \`tears\` \`crying\` \`embarrassed\` \`heavy breathing\` \`seductive smile\` \`come hither\`
（不要写 \`lewd\` / \`lewd face\` / \`naughty face\` —— 词典里没有）

### 5.9 道具 / 互动（选 0~2）
\`condom\` \`vibrator\` \`dildo\` \`sex toy\` \`onahole\` \`lingerie\` \`panties\` \`bra\` \`bed sheet\`
\`bondage\` \`restrained\` \`rope\` \`blindfold\` \`gag\` \`handcuffs\` \`collar\` \`leash\` \`spanking\` \`whip\`
\`nipple clamps\` \`tentacles\`

### 5.10 禁止
- 不写未成年 / 非自愿相关表述（硬边界）
- **不写模糊动词替代**（用 \`hug\` 代表性行为）—— 那是画面与正文脱节的头号来源
- 不写 \`naked\` / \`penetration\` / \`areola\` / \`labia\` / \`breast hold\` / \`looking away\` / \`averted eyes\`
  （词典里没有），改用 \`nude\` / \`vaginal\` / \`nipples\` / \`breast grab\` / \`looking down\`

### 5.11 行为阶段与跨格延续（★ 缺这块 = 同一场戏后几张没有行为）

一场戏按下表推进。**同一楼出多格时优先按阶段分工** —— 两格都画同一个阶段 = 白出一格。

| 阶段 | 该出现的 tag（照抄，可换体位） | 该阶段**不该**出现 |
|---|---|---|
| ① 前戏（无插入） | 衣物状态 + \`french kiss\` \`groping\` \`breast grab\` \`fingering\` \`licking\` | \`sex\` / \`vaginal\` / 插入类 |
| ② 接触升级 | 体位 + \`spread legs\` \`leg lock\` \`clothing aside\` \`trembling\` | 完整插入 |
| ③ 初次相接 | \`sex\`（或 \`vaginal\`）+ 体位 + \`spread legs\` + 表情反应 | 余韵 |
| ④ **进行中** | \`sex\` + \`vaginal\`（或 \`anal\`）+ 体位 + \`spread legs\` / \`legs up\` + \`sweat\` \`moaning\` | 前戏的迟疑 |
| ⑤ 高潮余韵 | \`after sex\` + \`cum\` / \`orgasm\` + 松弛表情（\`closed eyes\` \`expressionless\`） | 还在持续的节奏 |

- **阶段由正文决定，不由你决定**：正文只写到亲吻，就绝不画到插入；
  正文写「他停下来、伏在她身上不动」才是余韵，写「他没停」「又顶了进去」就是 ④。
- **同楼跨格**：上一格在 ④、下一格正文没写结束 → 下一格**仍是 ④**，只换机位 / 景别。
- **跨楼只能前进或保持**，不许凭空倒退（余韵之后又画回前戏）。
- ★★ **进行中的行为，每一格都要重写一遍**：tag 是**无状态**的，生图模型不会记得上一张。
  \`sex, vaginal, doggystyle\` 上一格写过、这一格还在这件事里，就必须**再写一次** —— **这不算重复**。
  ✓ 「再写一次」＝**原样写同一组词**；换掉的是**构图**（机位 / 景别）。
  ✗ **不要为了"不重复"换说法再写一遍**（\`vaginal\` → \`penetration\` → \`sex\` 轮着写）——
    同一个意思出现第二条，模型就会把这件事画两遍（§零.3）。
  判据：**把这条行为 tag 删掉，这张图还成立吗？** 不成立 = 必须写（且只写一条）；只是换个机位也成立 = 才是可选细节。

## 六、漫画分镜

### 6.1 粒度
本楼正文切 3~5 格，每格 = 一个可上画的瞬间（不是剧情概述）。
一格只拍一个时刻；格与格之间必须推进（视线移动 / 动作起手与落点 / 情绪转折）。

### 6.2 每格必须交代
景别（§2.4 七选一）｜机位（§2.4 七选一）｜核心动作｜视线方向｜状态（§四 至少 4 个维度）

### 6.3 相邻格不得同档
连续两格的「景别 + 机位」组合禁止相同 —— 漫画节奏靠景别落差：远景建立 → 中景交代 → 近景收情绪。

### 6.4 跨格连贯
上一格拿在手里的东西下一格不会消失；上一格站着的人下一格不会自动坐下。
**正在进行的性行为跨格不会消失**：上一格在 ④ 进行中、这一格正文没写结束 → 这一格仍是 ④，
只是换机位 / 景别 / 构图（见 §5.11）。**换构图不等于换状态。**

### 6.5 画面内文字一律不写
本地 SD 画不出可读中文。需要上画的台词由用户后期排版，你只画「说话的人 + 表情 + 口型状态」。

### 6.6 漫画相关真 tag
\`comic\` \`multiple views\` \`monochrome\` \`greyscale\` \`speech bubble\` \`thought bubble\` \`silhouette\`
\`solo focus\` \`close up\` \`peeking\` \`peeking out\`
（\`panel\` / \`2 panels\` / \`comic panel\` / \`medium shot\` / \`full shot\` 词典里没有，别写）

## 七、出词前自检（全过才交）

1. tag 里有没有人数词 / 发色 / 服装？→ 有就删（插件会写）
2. 有没有句子，或 \`his\` / \`her\` 从句？→ 换成枚举 tag
3. 有没有下划线？→ 改成空格
4. 姿态**只有一条**？（有体位词就别再配姿态词；**不许写 \`standing\`**）手位写了？景别与机位**各一个**（不是各两个）？
5. 表情与视线写了？**同一维度不超过 2 个**？
6. 有没有权重语法 / 否定句 / 质量词？→ 删
7. **SFW 格**：§四 命中 ≥4 个维度？
8. **NSFW 格**（按 §5.1 判定）：行为 1 + 体位 1 + 部位或接触 1~2 + 表情反应 1 **四项各一条齐了吗**？
   → 缺行为就是「画面里没有这件事」，不许用 \`hug\` / \`embracing\` 顶替。
   → **多写第 2 条不是加分**（\`vaginal\` 之后又写 \`penetration\` / \`sex\` / \`oral\`）：
     那是让模型把同一件事画两遍 → 多一套器官、肢体折叠。**这一格只拍一个瞬间**（§零.3）。
9. **上一格 / 上一楼还在进行的行为，这一格写了吗**？
   → 没写＝这一张没有行为（tag 无状态，不写不等于延续）。
   → 写了就**原样再写一次**，不要换同义词。
`;

/**
 * v3 配套的 system / protocol —— 旧版这两段都写着「画面 tag 必须照抄库里的字段值」，
 * 与「外貌由插件注入」直接冲突：模型照抄 → 每张图外貌写两遍 → 权重翻倍。
 */
export const SD_SYSTEM_V4 = `你是「绘灵」的图像提示词分析器。每次收到一段小说正文，你要完成两件事：

1. **维护角色档案的一致性**：判断本楼出现了哪些角色、他们的外貌与服装有没有发生变化，把变化写进 changes。
   你看到的【角色档案库】是插件维护的当前真值。
2. **挑选值得配图的画面**：在本楼正文里选出最有画面价值的片段，为每一段写出图像提示词。

★ 分工（务必遵守）：角色外貌与服装由插件按档案**自动注入**，并自动分角色成段。
  你在 images[].tag 里**只写画面公共区**：动作 / 承重面 / 接触 / 表情 / 视线 / 景别 / 机位 / 场景 / 光线。
  **不要**写人数词（1girl / 1boy）、发色瞳色、服装款式 —— 写了就是第二份，权重翻倍、多手、串台。
★★ 一个意思只写一条（规范 §零.3）：机位 1、景别 1、承重面 1、主行为 1、每个状态维度 ≤2。
  写第二条不是"强调"，是**让模型把这件事画两遍** —— 身体扭转、肢体折叠、多一套器官都从这里来。
  一张图通常 12 个 tag 就够；写到 20 个以上基本是重复强调。
★ 成人剧情：**行为必须逐格写进 tag**。正文写的是抽送 / 顶弄 / 撞击就按 NSFW 出词（规范 §5.1），
  正在进行的性行为每格重写一遍 —— 不写不等于延续，等于这一张没有这件事（规范 §5.11）。

工作纪律：
- 你只负责"这楼要不要图、要哪几张、角色状态怎么变"。你不负责改写正文、不负责决定工作流节点。
- 档案库里标记 \`[locked]\` 的条目属于用户主权区，**永远不要为它产生 change**。
- 你不确定的角色外貌不要脑补。没有明确线索时，只写能从正文推出来的部分。
- 宁可少配图，不要为了凑数画出与剧情无关的画面。
`;

export const SD_PROTOCOL_V4 = `# 输出协议（不要删除本节）

只输出一个 JSON 对象，不要 Markdown 代码块，不要解释。

\`\`\`json
{
  "changes": [
    { "name": "角色名", "kind": "new",   "fields": { "hair": "...", "eyes": "...", "outfit": "..." } },
    { "name": "角色名", "kind": "set",   "fields": { "outfit": "...", "outfitState": "parted" } },
    { "name": "角色名", "kind": "state", "fields": { "condition": "...", "mood": "..." } }
  ],
  "images": [
    { "position": "P3", "tag": "@角色名, sitting, on bed, holding cup, looking down, sleepy, bedroom, morning, sunlight" }
  ]
}
\`\`\`

字段说明：
- \`changes[].kind\`：
  - \`new\` —— 本楼首次出现的角色，给出静态锚点字段（hair/eyes/face/skin/body/mark）。全楼生效。
  - \`set\` —— 永久性变化（染发、留疤、换装）。**只对 position 之后的画面生效**，必须带 \`position\`。
  - \`state\` —— 临时状态（情绪、伤势、手持物）。只对当前楼生效。
- \`changes[].position\`：\`set\` 类必填，写生效起点的段落 ID（如 \`P4\`）。
- \`changes[].locked\`：档案里标记 \`[locked]\` 的条目，**不要对它产生任何 change**。
- \`images[].position\`：必须是本次正文里出现过的段落 ID，不得引用历史楼层、不得编造；
  按格的顺序递增（如 P2 → P5 → P7），不得重复。
- \`images[].tag\`：**只写画面公共区**，逗号分隔，全部用空格写法（禁下划线）。
  角色用 \`@角色名\` 点名出场（插件展开成外貌服装独立段），**不要**自己写人数词与外貌服装。
  **只能写 danbooru 真实存在的 tag，禁止句子、禁止中文、禁止自造词组、禁止 his/her 从句。**
  ★ **先判这张是不是 NSFW**（规范 §5.1，宽口径：有性接触就算，正文只写动作词也算）：
  - **SFW** → 按规范 §四 的 6 个维度（情绪 / 身体状态 / 动作持物 / 姿态 / 场景 / 光线）各选 1~2 个
  - **NSFW** → 必须命中规范 §五 的 4 个维度：
    行为 1（\`sex\` \`vaginal\` \`anal\` \`oral\` \`fingering\` …）+ 体位 1（\`missionary\` \`doggystyle\` \`cowgirl position\` …）
    + 部位或接触 1~2（\`penis\` \`pussy\` \`spread legs\` \`breast grab\` …）+ 表情反应 1（\`moaning\` \`ahegao\` …）
    **不许用 §四 的日常动作词顶替**（写 \`hug\` / \`embracing\` 等于把成人画面降级成拥抱）
  ★ **正在进行的性行为，每一格都要重写一遍**（tag 无状态，不写＝这张图没有这件事；见规范 §5.11）。
    需要换的只有构图（机位 / 景别），不是行为 —— **行为原样再写一次，不要换同义词**。
  ★★ **同一个意思只写一条**（规范 §零.3）：机位 1 个、景别 1 个、承重面 1 个、主行为 1 个。
    写第二条 ＝ 让模型把这件事画两遍（多一套器官 / 肢体折叠 / 身体扭转）。
    一张图的 tag 总数通常 **12 个左右就够了**，超过 20 个基本是重复强调。
- **本模版不使用 \`nl\` 字段**（Illustrious 不认中文自然语）—— 不要输出它。
- \`images\` 数量：本楼输出 3~5 个画面（按 spec §六 切分镜），按阅读顺序排列；宁少勿凑。
- 不需要配图时返回 \`{"changes":[...],"images":[]}\`。
- 图片数量不得超过设置的「单楼最大图片数」。
`;

/**
 * 历史导出名（v0.9.97–v0.9.100 的模版正文）。
 *
 * 保留原因：`settings.js` 的 v36 迁移分支与 `dev/sd-spec-v3-097-test.mjs` 按这三个名字比对。
 * ⚠️ 它们现在**指向 v4 文本**（同一份字符串），不要再往里写 v3 内容 ——
 *    判断「模版是不是旧版」请用文本特征（首行 `纯 tag 口径 v3`），不要用 `===`。
 */
export const SD_SPEC_V3 = SD_SPEC_V4;
export const SD_SYSTEM_V3 = SD_SYSTEM_V4;
export const SD_PROTOCOL_V3 = SD_PROTOCOL_V4;
