/**
 * 绘灵 · 出厂服装款式库（v0.9.68 新增）
 *
 * 来源：K2_V3 融合版的 CLOTH 表（大类 → 次级分类 → 款式），共 141 条，
 *      **英文描述为逐条新写**，不是机翻 —— 见下方「为什么必须是英文」。
 *
 * ── 为什么单独一个文件 ──
 * settings.js 已经 156KB，再塞 141 条中英对照会让它彻底不可维护。
 * 库是**纯数据、无依赖**，抽成叶子模块两边都能安全 import。
 *
 * ── F1：英文是唯一真值，中文只是 UI 标签 ──
 * 每个条目 = [分类, 次级, 中文名, 英文描述]：
 *   · 中文名：给人挑、给人搜、在档案引用下拉里显示 —— 不进提示词。
 *   · 英文串：**唯一真值**，原样进画面词（K2/ComfyUI 只认英文）。
 * 反面教材：若把中文也存进库、每楼再翻译一次，同一件衣服会被翻出不同英文 ——
 * 那是在**制造**漂移，而不是防止漂移。所以中文只做标签，永不出库。
 *
 * ── 分类策略（2026-10-03 用户拍板）──
 * K2 库**保持 K2 自己的分类**（内衣睡衣 / 上衣 / 下装 / 连衣裙 / 外套 / 职业制服 / 传统服饰），
 * 不并入用户自建的那套（礼服 / 校服 / COS / 常服 / 职场 / 男主服装）—— 那套是他自己攒的，
 * 两套并存、互不打乱。出厂五件套仍挂在它原来的分类（校服 / 职场 / 常服）下。
 *
 * ── 格式约定：沿用出厂预设的「英文 tag 串」 ──
 * 逗号分隔短语，不写完整句子。理由：服装段在提示词里是**元素清单**，
 * 写成句子会和动作/氛围段抢语法位，也更容易被模型当氛围词改写。
 * 每条覆盖 4~6 个可复现要素：主件 → 颜色/面料 → 结构细节 → 长度/覆盖度。
 */

/**
 * 出厂款式库。
 * @type {Array<[string, string, string, string]>} [分类, 次级, 中文名, 英文 tag 串]
 */
export const OUTFIT_LIBRARY = [
  /* ============ 内衣睡衣 ============ */
  ['内衣睡衣', '内衣', '黑色蕾丝无钢圈内衣', 'black wireless lace bra, sheer floral lace cups with skin showing through the openwork'],
  ['内衣睡衣', '内衣', '白色运动内衣', 'white sports bra, wide shoulder straps pressing across the collarbones, thick matte fabric'],
  ['内衣睡衣', '内衣', '黑色抹胸', 'black strapless bandeau top, tight around the torso, straight flat upper edge'],
  ['内衣睡衣', '内衣', '黑色蕾丝连体衣', 'black lace bodysuit, clinging to the body, openwork floral pattern over the chest'],
  ['内衣睡衣', '内衣', '酒红色蕾丝内衣套装', 'wine red lace bra and matching lace panties set, adjustable shoulder straps'],
  ['内衣睡衣', '内衣', '粉色棉质少女内衣', 'pink cotton bra, small ribbon bow at the center front, fresh and girlish'],
  ['内衣睡衣', '内衣', '白色刺绣薄纱内衣', 'white embroidered sheer bra, pale floral embroidery on the cups, light and airy'],
  ['内衣睡衣', '睡裙', '香槟色缎面吊带睡裙', 'champagne satin slip dress, thin straps catching light at the collarbones, hem falling to mid-thigh'],
  ['内衣睡衣', '睡裙', '象牙白缎面吊带背心', 'ivory satin camisole, thin straps sliding off the shoulders'],
  ['内衣睡衣', '睡裙', '黑色丝绸吊带睡裙', 'black silk slip dress, deep V neckline, hem to mid-thigh, cold sheen'],
  ['内衣睡衣', '睡裙', '白色荷叶边睡裙', 'white cotton nightdress, ruffled neckline and cuffs, knee-length, pure and innocent'],
  ['内衣睡衣', '睡裙', '粉色蝴蝶结睡裙', 'pink slip nightdress, ribbon bow tied at the chest, spaghetti straps'],
  ['内衣睡衣', '睡裙', '雾蓝色缎面睡裙', 'mist blue satin slip dress, slender straps, slightly slit hem, soft sheen'],
  ['内衣睡衣', '睡衣', '米白色真丝睡袍', 'cream white silk robe worn open over the shoulders, thin translucent fabric'],
  ['内衣睡衣', '睡衣', '白色棉质长袖睡衣', 'white cotton long-sleeve pajama set, buttons done up to the collarbone, thick soft fabric'],
  ['内衣睡衣', '睡衣', '蓝白条纹睡衣套装', 'blue and white pinstripe shirt-style pajama set, button front, slightly rolled hems'],
  ['内衣睡衣', '睡衣', '灰色oversize卫衣睡衣', 'grey oversized hooded sweatshirt pajama set, soft cotton, loose stacked cuffs'],
  ['内衣睡衣', '睡衣', '白色棉质背心短裤', 'white cotton tank top with matching cotton shorts, lazy homewear'],
  ['内衣睡衣', '睡衣', '黑色缎面短睡袍', 'black satin short robe, belt tied loosely, hem barely covering the upper thigh'],

  /* ============ 上衣 ============ */
  ['上衣', '内搭吊带', '奶白色罗纹针织短款吊带背心', 'cream white ribbed knit cropped camisole, ending just below the bust, flat bare midriff'],
  ['上衣', '内搭吊带', '黑色一字肩上衣', 'black off-shoulder top, neckline below the shoulder line, both collarbones and rounded shoulders exposed'],
  ['上衣', '内搭吊带', '深蓝挂脖上衣', 'deep blue halter top, fabric crossing behind the neck, large open back'],
  ['上衣', '内搭吊带', '黑色紧身背心', 'black fitted tank top, deep V neckline, hugging the upper body'],
  ['上衣', '内搭吊带', '白色棉质背心', 'white cotton tank top, loose neckline, slightly wide straps, casual and fresh'],
  ['上衣', '内搭吊带', '酒红色丝绒吊带', 'wine red velvet camisole, spaghetti straps, soft matte sheen'],
  ['上衣', '内搭吊带', '银色亮片吊带', 'silver sequined camisole, party style, glittering under the light'],
  ['上衣', '内搭吊带', '白色缎面吊带背心', 'white satin camisole, thin straps, pearly fabric sheen'],
  ['上衣', '衬衫', '白色棉质宽松衬衫', 'white loose cotton shirt, two buttons open at the collar, sleeves rolled to the forearms'],
  ['上衣', '衬衫', '白色丝质衬衫', 'white silk shirt, fabric draping with a soft sheen'],
  ['上衣', '衬衫', '复古波点衬衫', 'retro polka dot blouse, puff sleeves, slightly open collar'],
  ['上衣', '衬衫', '浅蓝色牛津衬衫', 'light blue oxford shirt, button front, cuffs folded to the forearms'],
  ['上衣', '衬衫', '奶黄色法式衬衫', 'cream yellow French blouse, pussy-bow collar, puff sleeves, gentle French style'],
  ['上衣', '衬衫', '黑色薄纱透视衬衫', 'black sheer chiffon shirt, same-color inner lining, mysterious and sultry'],
  ['上衣', '衬衫', '蓝白竖条纹衬衫', 'blue and white vertical stripe oversized shirt, hem falling to mid-thigh'],
  ['上衣', '针织毛衣', '黑色高领针织毛衣', 'black turtleneck knit sweater, collar covering the whole neck, soft thick fabric'],
  ['上衣', '针织毛衣', '黑色丝绒紧身上衣', 'black velvet fitted top, clinging to the body, warm matte finish'],
  ['上衣', '针织毛衣', '淡粉色裹身上衣', 'pale pink wrap top, crossed tie closing at the waist'],
  ['上衣', '针织毛衣', '奶白色oversize毛衣', 'cream white oversized knit sweater, dropped shoulders, cuffs stacked to the back of the hands'],
  ['上衣', '针织毛衣', '焦糖色短款毛衣', 'caramel cropped sweater, cinched hem, waistline showing'],
  ['上衣', '针织毛衣', '深绿色高领毛衣', 'dark green turtleneck sweater, vintage and warm, fine knit texture'],
  ['上衣', '针织毛衣', '红色慵懒毛衣', 'red round-neck sweater, loose and lazy, festive mood'],
  ['上衣', '针织毛衣', '燕麦色高领毛衣', 'oatmeal turtleneck sweater, fine knit, gentle texture'],
  ['上衣', '针织毛衣', '紫色开衫毛衣', 'purple knit cardigan worn open, camisole underneath'],
  ['上衣', '针织毛衣', '蓝白条纹海魂衫', 'blue and white striped sailor tee, classic naval style, loose'],
  ['上衣', '西装风衣', '深灰色西装外套', 'dark grey blazer, sharp padded shoulders, tailored waist'],
  ['上衣', '西装风衣', '卡其色风衣', 'khaki trench coat, double-breasted, belt tied casually, hem to the calves'],
  ['上衣', '西装风衣', '米白色西装外套', 'cream white blazer, relaxed cut, padded shoulders, soft presence'],
  ['上衣', '西装风衣', '格纹西装外套', 'plaid blazer, vintage British style, three buttons'],
  ['上衣', '西装风衣', '黑色短款皮衣', 'black cropped leather jacket, zip half open, hard-edged'],
  ['上衣', '西装风衣', '浅蓝色牛仔外套', 'light blue denim jacket, distressed finish, slightly rolled cuffs'],
  ['上衣', '西装风衣', '白色oversize西装', 'white oversized blazer, dropped shoulders with wide pads, lazy and refined'],
  ['上衣', '西装风衣', '棕色格纹大衣', 'brown plaid wool coat, robe-style belt, vintage'],

  /* ============ 下装 ============ */
  ['下装', '裙装', '深灰色百褶短裙', 'dark grey pleated mini skirt, hem barely covering the upper thigh, alternating light and shadow on every pleat'],
  ['下装', '裙装', '黑色紧身短裙', 'black tight mini skirt hugging the hips and thighs, silver side zip running to the hem'],
  ['下装', '裙装', '米色包臀裙', 'beige pencil skirt below the knee, fabric clinging to every curve'],
  ['下装', '裙装', '白色网球裙', 'white tennis skirt, built-in shorts, pleated hem spreading from the waist'],
  ['下装', '裙装', '白色纱裙', 'white layered tulle skirt, light and fluffy, hem to the ankles'],
  ['下装', '裙装', '黑色A字短裙', 'black A-line mini skirt, stiff fabric, hem flaring slightly'],
  ['下装', '裙装', '粉色格纹短裙', 'pink plaid mini skirt, school style, button detail'],
  ['下装', '裙装', '牛仔短裙', 'light blue denim mini skirt, raw frayed hem, casual'],
  ['下装', '裙装', '酒红色灯芯绒半身裙', 'wine red corduroy skirt, knee-length, vintage texture'],
  ['下装', '裙装', '黑色长款百褶裙', 'black long pleated skirt, hem to the ankles, swaying with each step'],
  ['下装', '裙装', '卡其色工装短裙', 'khaki utility mini skirt, multiple pockets, androgynous'],
  ['下装', '裙装', '米白色缎面长裙', 'cream white satin long skirt, draping to the ankles, elegant sheen'],
  ['下装', '裤装', '黑色牛仔热裤', 'black denim hot pants, raw cut hems, barely covering the upper thigh'],
  ['下装', '裤装', '米白色高腰阔腿裤', 'cream white high-waisted wide-leg trousers, waistline above the navel, wide flowing legs'],
  ['下装', '裤装', '深灰色瑜伽裤', 'dark grey yoga pants clinging to the legs, tracing the full leg line'],
  ['下装', '裤装', '浅蓝色低腰牛仔裤', 'light blue low-rise jeans, hip bones showing, hems pooling over the shoes'],
  ['下装', '裤装', '蓝色高腰牛仔裤', 'blue high-waisted jeans, slightly rolled hems'],
  ['下装', '裤装', '黑色皮短裤', 'black leather shorts, cut to the upper thigh, sharp patent highlights'],
  ['下装', '裤装', '黑色紧身牛仔裤', 'black skinny jeans, high waist, tracing the leg line'],
  ['下装', '裤装', '深蓝色直筒牛仔裤', 'dark blue straight-leg jeans, classic five-pocket, flat hems'],
  ['下装', '裤装', '黑色西装长裤', 'black tailored trousers, draping straight, mid-rise, crisp crease'],
  ['下装', '裤装', '卡其色工装裤', 'khaki cargo pants, side flap pockets, cinched hems'],
  ['下装', '裤装', '灰色运动短裤', 'grey cotton athletic shorts, loose, elastic waist'],
  ['下装', '裤装', '白色棉质短裤', 'white cotton shorts, slightly rolled hems, fresh'],
  ['下装', '裤装', '白色直筒裤', 'white straight-leg trousers, crisp fabric, clean and sharp'],
  ['下装', '裤装', '深灰色西裤', 'dark grey straight trousers, crisp crease, professional'],
  ['下装', '裤装', '浅色阔腿牛仔裤', 'light wash wide-leg jeans, roomy legs, vintage relaxed'],
  ['下装', '裤装', '黑色小脚裤', 'black slim-fit trousers, tracing the leg shape, versatile'],

  /* ============ 连衣裙 ============ */
  ['连衣裙', '短款', '经典小黑裙', 'classic little black dress, sleeveless square neckline, cinched waist with slightly flared hem, knee-length'],
  ['连衣裙', '短款', '黑色紧身针织连衣裙', 'black fitted knit dress, clinging from the chest to the knees'],
  ['连衣裙', '短款', '浅蓝色条纹衬衫裙', 'light blue striped shirt dress, buttons slightly open at the collar, belt cinched at the waist'],
  ['连衣裙', '短款', '碎花茶歇裙', 'floral tea dress, low crossed neckline showing the collarbones, short ruffled sleeves, hem flaring just past the knee'],
  ['连衣裙', '短款', '白色泡泡袖短裙', 'white cotton puff-sleeve dress, cinched waist, hem to mid-thigh, sweet'],
  ['连衣裙', '短款', '黑色吊带背心裙', 'black camisole dress, straight cut, hem above the knee, minimal'],
  ['连衣裙', '短款', '红白格纹连衣裙', 'red and white gingham fit-and-flare dress, puff sleeves, retro sweet'],
  ['连衣裙', '长款', '深蓝灰缎面吊带裙', 'deep blue-grey satin slip dress, thin straps sliding to the edge of the shoulders, body-hugging, high side slit'],
  ['连衣裙', '长款', '白色缎面吊带长裙', 'white satin slip gown pooling on the floor, thin straps crossed at the back, smooth drape'],
  ['连衣裙', '长款', '雾霾蓝纱裙', 'dusty blue layered tulle gown, spaghetti straps, layered hem trailing on the floor'],
  ['连衣裙', '长款', '墨绿色丝绒长裙', 'deep green velvet gown, high slit, rich vintage'],
  ['连衣裙', '长款', '波西米亚印花长裙', 'boho printed maxi dress, loose V neckline, flowing hem'],
  ['连衣裙', '长款', '米白色针织长裙', 'cream white knit maxi dress, body-hugging, gentle'],
  ['连衣裙', '长款', '黑色蕾丝长裙', 'black lace gown, body-hugging cut, openwork pattern, hem trailing on the floor'],
  ['连衣裙', '长款', '香槟色缎面长裙', 'champagne satin gown, draping to the ankles, soft sheen'],
  ['连衣裙', '长款', '淡雅印花长裙', 'pale floral print maxi dress, light chiffon, flowing'],
  ['连衣裙', '礼服', '酒红色裹身裙', 'wine red wrap dress, low crossed neckline, belt tied at the side waist, hem falling naturally'],
  ['连衣裙', '礼服', '白色抹胸婚纱', 'white strapless wedding gown, lace openwork bodice, layered tulle skirt trailing'],
  ['连衣裙', '礼服', '黑色亮片礼服裙', 'black sequined strapless gown, body-hugging, mermaid hem, glittering under the light'],
  ['连衣裙', '礼服', '香槟金吊带礼服', 'champagne gold satin slip gown, thin straps, draping to the ankles'],
  ['连衣裙', '礼服', '红色鱼尾礼服', 'red mermaid gown, deep V neckline, body-hugging with high slit'],
  ['连衣裙', '礼服', '宝蓝色天鹅绒礼服', 'royal blue velvet gown, strapless, high slit, vintage opulence'],

  /* ============ 外套 ============ */
  ['外套', '大衣', '米白色羊毛大衣', 'cream white wool coat, double-breasted, below the knee, soft texture'],
  ['外套', '大衣', '黑色长款大衣', 'black long coat, below the knee, sharp tailoring'],
  ['外套', '大衣', '驼色浴袍式大衣', 'camel robe-style coat, belted at the waist, lazy and refined'],
  ['外套', '大衣', '格纹羊毛大衣', 'plaid wool coat, vintage British, below the knee'],
  ['外套', '夹克', '黑色机车皮夹克', 'black moto leather jacket, metal zips and studs, hard-edged'],
  ['外套', '夹克', '军绿色飞行员夹克', 'army green bomber jacket, fur collar, loose'],
  ['外套', '夹克', '深蓝色牛仔夹克', 'dark blue denim jacket, washed and distressed'],
  ['外套', '夹克', '红白拼色棒球夹克', 'red and white color-block baseball jacket, classic retro'],
  ['外套', '风衣披肩', '黑色长风衣', 'black long trench coat, hem to the calves, belt defining the waist'],
  ['外套', '风衣披肩', '大针织披肩', 'large knit shawl draped over the shoulders, lazy drape'],
  ['外套', '风衣披肩', '白色皮草短披肩', 'white short fur cape, elegant vintage'],

  /* ============ 职业制服（校服 / 职业装 / 女仆家政） ============ */
  ['职业制服', '校服', '深蓝色西式校服', 'navy blue western-style school uniform, white shirt with a ribbon bow tie, plaid pleated skirt to the knee, white knee-high socks'],
  ['职业制服', '校服', '白色水手服', 'white sailor uniform, navy blue large sailor collar, red neckerchief tied in a knot, navy pleated mini skirt'],
  ['职业制服', '校服', '灰色JK制服', 'grey JK uniform, navy ribbon, plaid pleated skirt, blazer'],
  ['职业制服', '校服', '蓝白运动校服', 'blue and white tracksuit school uniform, zip jacket and shorts'],
  ['职业制服', '职业装', '职场白领套装', 'white dress shirt tucked into a black pencil skirt, black stiletto heels'],
  ['职业制服', '职业装', '深蓝色空姐制服', 'navy blue flight attendant uniform, red neckerchief, pencil skirt to the knee, beret'],
  ['职业制服', '职业装', '白色护士服', 'white nurse uniform, nurse cap, pale pink collar, stethoscope around the neck'],
  ['职业制服', '职业装', '深色警服套裙', 'dark police uniform skirt suit, police cap, radio at the waist, handcuffs at the hip'],
  ['职业制服', '职业装', '黑色修身西装套装', 'black tailored suit set, white shirt, A-line mini skirt'],
  ['职业制服', '职业装', '棕色空乘制服', 'brown flight attendant uniform, scarf tied at the neck, pencil skirt to the knee'],
  ['职业制服', '职业装', '白色厨师服', 'white chef uniform, double-breasted, chef hat'],
  ['职业制服', '职业装', '白大褂医生服', 'white doctor coat, stethoscope around the neck, clinical and professional'],
  ['职业制服', '职业装', '藏青列车员制服', 'navy conductor uniform, gold buttons, scarf at the collar'],
  ['职业制服', '女仆家政', '经典黑白女仆装', 'classic black and white maid outfit, white ruffled apron over a black dress, white lace headpiece'],
  ['职业制服', '女仆家政', '粉白女仆装', 'pink and white maid outfit, pink ribbon apron, lace trim'],
  ['职业制服', '女仆家政', '英式管家制服', 'English butler uniform, white shirt with black vest, bow tie'],
  ['职业制服', '女仆家政', '涩系女仆装', 'dark-toned maid outfit, long sleeves, ribbon bow tie, crisp'],

  /* ============ 传统服饰 ============ */
  ['传统服饰', '旗袍', '红色丝绒旗袍', 'red velvet qipao, mandarin collar with gold frog buttons, high side slit to mid-thigh'],
  ['传统服饰', '旗袍', '青色印花旗袍', 'cyan printed silk qipao, mandarin collar, frog buttons, knee-length, fresh and elegant'],
  ['传统服饰', '旗袍', '黑色蕾丝旗袍', 'black lace qipao, body-hugging, high slit, sultry'],
  ['传统服饰', '旗袍', '白色绣花旗袍', 'white satin embroidered qipao, pale embroidery, gentle'],
  ['传统服饰', '汉服', '白色交领汉服襦裙', 'white crossed-collar hanfu top, pale green chest-high ru skirt, wide flowing sleeves, shawl draped over the arms'],
  ['传统服饰', '汉服', '朱红齐胸襦裙', 'vermilion chest-high ru skirt, gold embroidered sash, flowing shawl'],
  ['传统服饰', '汉服', '魏晋风汉服', 'Wei-Jin style crossed-collar hanfu, wide sleeves, plain gauze skirt'],
  ['传统服饰', '汉服', '唐制坦领襦裙', 'Tang-style tan-collar ru skirt, half-sleeve jacket, red skirt'],
  ['传统服饰', '和服', '粉色樱花和服', 'pink sakura print kimono, tied obi, hem to the ankles'],
  ['传统服饰', '和服', '深蓝色浴衣', 'dark blue yukata, white pattern, obi'],
  ['传统服饰', '和服', '红色渐变和服', 'red gradient kimono, gold obi, gorgeous'],
];

/** 出厂五件套（v0.9.55 起就有的那几条，独立于 K2 库保留）。 */
export const LEGACY_PRESETS = [
  ['校服', '校服', '夏季校服', 'white short-sleeve sailor blouse, navy blue sailor collar with double white stripes, red neckerchief, navy pleated skirt with two white stripes at hem, white knee-high socks, brown loafers'],
  ['校服', '校服', '冬季校服', 'navy blue blazer with school crest on chest, white dress shirt, red striped necktie, grey pleated skirt, black knee-high socks, black leather loafers'],
  ['职场', '职业装', 'OL职场服', 'white fitted dress shirt, black tailored blazer, black pencil skirt above knee, sheer black tights, black pointed-toe heels, thin silver necklace'],
  ['职场', '职业装', '护士制服', 'white short-sleeve nurse dress uniform, white button front, white nurse cap with red cross, white stockings, white nursing shoes'],
  ['常服', '常服', '居家服', 'oversized light grey cotton t-shirt, dark grey shorts, bare feet, loose hair'],
];

/** 出厂库播种版本号：升到 N 时会把 N 对应的新条目补进已有存档（不覆盖用户改过的）。 */
export const PRESET_SEED_VERSION = 2;

/**
 * 展平成「预设名 → 英文 tag 串」。
 *
 * 中文名重复时自动加 `-2/-3` 后缀 —— 预设名是全局唯一 key，
 * 同名会静默覆盖掉前一条（衣服凭空少一件，且无从归因）。
 */
export function libraryToPresets() {
  const out = {};
  const used = new Set();
  for (const [, , zh, en] of [...LEGACY_PRESETS, ...OUTFIT_LIBRARY]) {
    let name = zh;
    let i = 2;
    while (used.has(name)) name = `${zh}-${i++}`;
    used.add(name);
    out[name] = en;
  }
  return out;
}

/** 展平成「预设名 → 分类」（与 libraryToPresets 用同一套改名规则，保证对得上）。 */
export function libraryToCats() {
  const out = {};
  const used = new Set();
  for (const [cat, , zh] of [...LEGACY_PRESETS, ...OUTFIT_LIBRARY]) {
    let name = zh;
    let i = 2;
    while (used.has(name)) name = `${zh}-${i++}`;
    used.add(name);
    out[name] = cat;
  }
  return out;
}

/* ============ 档案服装「留白」检测（v0.9.145） ============ */

/**
 * ★★★ 为什么需要它：档案里「没写」比「写错」更伤人。
 *
 * 实测病例（2026-10-28 · 催眠APP · 西园寺爱丽莎）：
 *   档案只写 `custom-tailored and shortened uniform skirt` —— **没写颜色、没写款式**。
 *   同一楼的第 1 页画成深蓝百褶裙，第 2 页画成浅色紧身包臀裙。
 *   用户报的是「服装漂移」，真因是**档案留白**：模型每页自己选一次。
 *   把颜色款式补成 `navy blue pleated uniform skirt` 之后，两页立刻统一。
 *
 * ⇒ 判据：**逐件判**（不是整串判）。整串里有 `white` 不代表裙子也有颜色 ——
 *   漂移恰恰发生在没写颜色的那一件上。
 *
 * ⚠️ 只判「有没有颜色」这一维，不判「款式对不对」：
 *   款式对不对是审美与设定问题（用户主权），机器不该插嘴；
 *   而「这一件没有任何颜色词」是机器能 100% 判定的客观缺口。
 */
const OUTFIT_COLOR_RE = new RegExp(
  '\\b(?:'
  + 'white|black|navy|blue|red|grey|gray|brown|beige|cream|khaki|ivory|tan|olive|charcoal'
  + '|pink|purple|green|yellow|orange|gold|golden|silver|crimson|scarlet|maroon|burgundy'
  + '|emerald|teal|turquoise|azure|indigo|violet|lavender|mint|coral|peach|rose|wine'
  + '|ruby|jet|ebony|pearl|milky|translucent|transparent|sheer'
  // ★ `dark` / `light` / `pale` 算「有色调但模糊」，收进来是为了**少报**：
  //   它压不住漂移（深蓝→深棕），但机器没法替用户决定该写什么颜色，
  //   报出来只会变成噪音。检测只管「一个颜色词都没有」这种硬缺口。
  + '|dark|light|pale'
  // ★ 时装色名（出厂库自己就在用：香槟 / 焦糖 / 燕麦 / 驼色），不放进来会让库自检全红
  + '|champagne|caramel|oatmeal|mocha|nude|blush|mauve|mustard|plum|rust|sand|taupe|camel|wheat'
  // ★ 图案也算视觉锚点：`plaid wool coat` 没说颜色，但它已经钉住了"格纹"，
  //   再报「没写颜色」属于无理指责 —— 用户不会因为这条去补档案。
  + '|plaid|tartan|floral|paisley|striped|stripes?|checkered|checked|houndstooth|argyle|polka\\s?dot'
  + ')\\b',
  'i',
);
const OUTFIT_COLOR_ZH = /[白黑蓝红灰棕咖米粉紫绿黄橙金银]|藏青|墨绿|酒红|天蓝|驼色|奶白|雪白|香槟|焦糖|燕麦|格纹|条纹|碎花|波点/;

/** ★ 判「颜色」只针对**主件**（上装 / 下装 / 连身 / 外套 / 制服）。
 *
 * 这一版是第二版。第一版把鞋袜、腰带、蝴蝶结、内衬都算进来，结果出厂 146 条预设里
 * **40 多条全红** —— 报出来的全是 `belt tied casually` / `built-in shorts` /
 * `small ribbon bow` 这类东西。它们确实没写颜色，但：
 *   · 腰带 / 蝴蝶结 / 内衬在画面里只有几像素，漂了也看不出来；
 *   · 真正让用户觉得「换了一身」的是裙子、上衣、外套。
 * ⇒ 宁可漏报，不许把用户烦到不再看提示。
 */
const OUTFIT_GARMENT_RE = new RegExp(
  '\\b(?:'
  + 'skirt|blouse|shirt|dress|trousers|pants|slacks|jeans|blazer|jacket|coat|uniform|suit'
  + '|sweater|cardigan|vest|hoodie|top|tee|shirt|camisole|robe|gown|apron'
  + '|kimono|yukata|swimsuit|bikini|bodysuit|bandeau|tracksuit|nightdress|nightgown'
  + '|pajamas?|pyjamas?|shawl|cape|poncho'
  // ★ 传统服饰：出厂库里有旗袍 / 汉服 / 襦裙，不认出来会被判成「没写服装」
  + '|qipao|cheongsam|hanfu|ruqun|hanbok|ao\\s?dai'
  + ')\\b',
  'i',
);
const OUTFIT_GARMENT_ZH = /裙|旗袍|汉服|襦裙|袄|衬衫|衬衣|上衣|外套|裤子|长裤|制服|连衣裙|毛衣|卫衣|马甲|背心|抹胸|吊带|连体衣|睡裙|睡衣|浴袍|披肩|围裙|西装|和服|浴衣|长袍|泳装|T恤|衫/;

/** 配饰 / 鞋袜 / 内衣 —— **不判颜色**，但算「这条确实写了服装」（用于区分 empty）。 */
const OUTFIT_ACC_RE = new RegExp(
  '\\b(?:'
  + 'socks|stockings?|pantyhose|tights|thigh[\\s-]?highs?|knee[\\s-]?highs?|leg\\s?warmers?'
  + '|loafers?|sneakers?|shoes?|boots?|heels?|pumps?|sandals?|flats'
  + '|necktie|tie|ribbon|bow|sash|belt|scarf|gloves?|hat|cap|beret|headband'
  + '|bra|panties|underwear|lingerie|shorts'
  + ')\\b',
  'i',
);
const OUTFIT_ACC_ZH = /袜子|丝袜|连裤袜|鞋|靴|高跟|领带|领结|蝴蝶结|腰带|围巾|帽子|手套|内衣|内裤|短裤/;

const hasColor = (s) => OUTFIT_COLOR_RE.test(s) || OUTFIT_COLOR_ZH.test(s);
const hasGarment = (s) => OUTFIT_GARMENT_RE.test(s) || OUTFIT_GARMENT_ZH.test(s);
/** 宽口径：主件或配饰，用来判「这条到底有没有写衣服」。 */
const hasAnyCloth = (s) => hasGarment(s) || OUTFIT_ACC_RE.test(s) || OUTFIT_ACC_ZH.test(s);

/**
 * 「没有这件衣服」的陈述不是服装件，别问它颜色。
 *
 * 实测误报（2026-10-28 真实档案）：周雅 / 沈墨染 的 style 里有 `no underwear`，
 * 被当成「内裤没写颜色」。可它说的是**没穿**，没有颜色是应该的。
 */
const NOT_GARMENT_RE = /^\s*(?:no|without|nothing|none|bare|naked|topless|bottomless|fully)\b/i;

/**
 * 检查一份 `outfit.style` 有没有「该写没写」的缺口。
 *
 * @param {string} style 服装原文（`dyn.outfit.style`，未经预设展开）
 * @returns {{empty:boolean, pieces:Array<{text:string,noColor:boolean}>, gaps:string[]}}
 *   `gaps` 里是**没写颜色的那些件**的原文，直接给用户看。
 */
export function outfitGapsOf(style) {
  const src = String(style || '').trim();
  if (!src) return { empty: true, pieces: [], gaps: [] };
  const pieces = src.split(/[,，;；]/).map((s) => s.trim()).filter(Boolean);
  const out = [];
  let pendingColor = false; // 上一段只写了颜色、这一段只有主件（`navy blue pleated, skirt`）时接上
  for (const text of pieces) {
    const negated = NOT_GARMENT_RE.test(text);       // `no underwear` —— 说的是没穿
    const g = !negated && hasGarment(text);
    const c = hasColor(text);
    const noColor = g && !c && !pendingColor;
    out.push({ text, noColor });
    pendingColor = c && !g;
  }
  /* 整串一件衣服都没提到 → 这不算「漏颜色」，是「根本没写服装」，单独算空 */
  const noGarmentAtAll = !out.some((p) => hasAnyCloth(p.text) && !NOT_GARMENT_RE.test(p.text));
  return {
    empty: noGarmentAtAll,
    pieces: out,
    gaps: noGarmentAtAll ? [] : out.filter((p) => p.noColor).map((p) => p.text),
  };
}

