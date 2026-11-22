/**
 * 绘灵 · 「服装稳定档」体检（v0.9.91）
 *
 * 用途：SD / Illustrious / 多宫格漫画 LORA 这类**标签驱动 + 一份 prompt 全局生效**
 * 的场景下，找出「服装为什么会漂」的具体原因 —— 落到**具体角色身上**，而不是泛泛建议。
 *
 * ★ 为什么要有这个：服装在绘灵里是**机械注入**的（anchorOf），理论上不该漂；
 *   漂的根因几乎都在数据侧 —— 档案里没写权威服装、预设引用断了、写了中文被清洗……
 *   这些事前看不出来，只表现为「每楼衣服都不一样」。这个体检把它们摆到台面上。
 *
 * 设计约束：
 *   - 纯数据层（不碰 DOM），UI 层负责渲染 —— 便于回归测试；
 *   - 只做**检查与说明**，不改任何设置（人设主权区同样适用于「用户怎么配自己的插件」）。
 */

import { getConfig, activeEngine } from './settings.js';
import {
  listCast, listDyn, listOutfitPresets, resolveOutfitStyle,
} from './store.js';

/** 服装串超过这个长度，在多宫格 / 40 tag 预算里就开始挤掉别的锚点。 */
export const SD_MAX_OUTFIT_CHARS = 180;

/** 中文字符 —— SD 口径下 cleanTag(allowCjk=false) 会把整段丢掉。 */
const HAS_CJK = /[\u4e00-\u9fff]/;

/** 取出（可能存在的）预设引用名：支持 outfit.preset 字段，或 style 写成 @预设名。 */
function refKeyOf(outfit) {
  const o = outfit || {};
  let key = String(o.preset || '').trim();
  if (!key && String(o.style || '').trim().startsWith('@')) key = String(o.style || '').trim();
  return key.replace(/^@/, '').trim();
}

/**
 * 跑一次查体。
 *
 * @returns {{
 *   engine:'sd'|'k2', isSd:boolean, rows:Array<{name:string,level:string,items:string[]}>,
 *   cfgs:Array<{level:string,text:string}>, counts:{error:number,warn:number},
 *   castCount:number, ok:boolean
 * }}
 *   level: 'error'（会直接导致服装缺失/错衣服）| 'warn'（漂移风险）| 'ok'
 */
export function runCastStabilityCheck() {
  const cfg = getConfig() || {};
  const cons = cfg.consistency || {};
  const engine = activeEngine() === 'k2' ? 'k2' : 'sd';
  const isSd = engine === 'sd';

  const presets = listOutfitPresets();
  const cast = listCast();
  const dynMap = new Map((listDyn({ includeSleep: true }) || []).map(x => [x.name, x.dyn]));

  const rows = [];
  const cfgs = [];
  let error = 0;
  let warn = 0;

  /* ---------- ① 角色层面 ---------- */
  for (const it of cast) {
    const name = String(it?.name || '').trim();
    if (!name) continue;
    const f = it.entry?.fields || {};
    const dyn = dynMap.get(name) || {};
    const outfit = dyn.outfit || {};

    const staticOutfit = String(f.outfit || '').trim();      // 静态锚点字段（会进画面词）
    const refKey = refKeyOf(outfit);                          // 预设引用名（可能为空）
    const dynText = String(resolveOutfitStyle(dyn) || '').trim(); // 动态层（已展开预设）
    const hasDyn = Boolean(dynText);

    const items = [];
    let level = 'ok';
    // 只升角色自身等级，不逐条累加 —— 计数口径是「几个角色有问题」，
    // 一个角色身上可能同时有 2 条致命描述，按角色算一次更符合排查直觉。
    const bump = (lv) => {
      if (lv === 'error') level = 'error';
      else if (level !== 'error') level = 'warn';
    };

    // ①-a 悬空预设引用：resolveOutfitStyle 取不到 → style 原文 "@xxx" 直接参与合成，
    //     最终还被 FINAL_REF_RE 当引用记号剥掉 → **整套衣服凭空消失**（这层楼变成裸的/随机衣服）
    if (refKey && !presets[refKey]) {
      items.push(`❌ 服装预设「${refKey}」不存在 —— 引用失效，整套衣服会被当引用记号剥掉进不了画面。到「服装预设」里补这条，或改成直接写描述`);
      bump('error');
    }

    // ①-b 完全没有权威服装定义：模型只能每楼自己编 —— 服装漂移的头号来源
    if (!staticOutfit && !hasDyn) {
      items.push(isSd
        ? '❌ 没有权威服装定义（静态 outfit 字段空、服装层也没有款式）→ 每楼的服装全靠出词模型现场发挥，必然一栋楼一个版本。请在档案里写服装，或引用一条服装预设'
        : '⚠️ 没有权威服装定义（K2 下服装由模型写进英文段，稳定性依赖模版遵循度）');
      bump(isSd ? 'error' : 'warn');
    }

    // ①-c SD 口径下中文服装会被整段清洗掉
    const cjkIn = [staticOutfit, dynText].find(t => t && HAS_CJK.test(t));
    if (cjkIn) {
      items.push(isSd
        ? '❌ 服装里有中文 —— SD 口径会把含中文的字段整段清洗掉（画面里这件衣服直接消失）。请改写英文 tag'
        : '· 服装含中文（当前 K2 口径放行中文，可用）');
      if (isSd) bump('error');
    }

    // ①-d 静态与动态双来源并存 —— 两套描述都会拼进锚点，等于一次画两件
    if (staticOutfit && hasDyn && staticOutfit !== dynText) {
      items.push(`⚠️ 静态 outfit 与服装层款式**同时有值且不一致** → 两条会并列进画面词，等于这套角色的这套衣服被描述两遍（重复/串 isinstance）。建议只留一处：恒定款写静态，会随剧情变的写服装层`);
      bump('warn');
    }

    // ①-e 过长（多宫格 tag 预算）
    const longest = Math.max(staticOutfit.length, dynText.length);
    if (longest > SD_MAX_OUTFIT_CHARS) {
      items.push(`⚠️ 服装描述 ${longest} 字符，超过 ${SD_MAX_OUTFIT_CHARS} —— 多宫格 LORA 自身要吃 token，超预算时最先被牺牲的就是它和被挤在末尾的锚点`);
      bump('warn');
    }

    if (!items.length) {
      items.push('✅ 有唯一权威服装，来源单一，未见中文');
    }
    rows.push({ name, level, items });
  }
  // 角色层面按「有几个角色有问题」计数（每个角色只算一次，取最严重等级）
  for (const r of rows) {
    if (r.level === 'error') error += 1;
    else if (r.level === 'warn') warn += 1;
  }

  /* ---------- ② 配置层面（只报真正影响服装稳定的几条） ---------- */
  let cfgErr = 0;
  let cfgWarn = 0;
  const addCfg = (level, text) => {
    cfgs.push({ level, text });
    if (level === 'error') cfgErr += 1; else cfgWarn += 1;
  };

  if (cons.enabled === false) {
    addCfg('error', '❌ 一致性引擎总开关是关的 —— 锚点注入、服装闸门、防漂移挡全都不生效，画面必然漂');
  }
  const repeat = Number(cons.outfitStyleRepeatFloors ?? 2);
  if (repeat < 2) {
    addCfg('warn', `⚠️ 「同一套新款提到几楼才换」= ${repeat}（默认 2）→ 连续新款保护基本关闭，正文一提到别的衣服下一楼就敢换款。填 2 兼顾灵敏与防漂`);
  }
  if (cons.outfitScan === false) {
    addCfg('warn', '⚠️ 服装态扫描关闭 —— 服装只能靠出词模型主动上报（实测基本不报），款式容易回到旧 pressing 默认');
  }
  if (cons.autoOutfitDims === true) {
    addCfg('warn', '⚠️ 「自动填服装三维度」开着 —— 等于给了模型每楼改写「状态细档/改造/鞋袜」的写权限，这三项英文直接进画面。追稳定可关掉，改在档案页手动指定');
  }
  if (isSd && cfg.nlEnabled !== false) {
    addCfg('warn', '⚠️ SD 口径下「中文描述」是开的 —— SD 辅助 Chinese 段不进画面词，白白占分析预算（想留着看可以不动）');
  }
  if (String(cons.outfitLock || 'normal') === 'off') {
    addCfg('warn', '⚠️ 服装款式保护级别 = 关闭 —— 款式可被任意改写');
  }
  const maxLen = Number(cons.maxTagLength || 0);
  if (maxLen > 600) {
    addCfg('warn', `⚠️ tag 长度上限 ${maxLen} 偏大 —— Illustrious 这类标签模型在长 prompt 里会稀释前段权重，服装锚点容易被冲淡`);
  }

  const ok = (error + cfgErr) === 0 && (warn + cfgWarn) === 0;
  return {
    engine,
    isSd,
    rows,
    cfgs,
    counts: { error: error + cfgErr, warn: warn + cfgWarn },
    castCount: cast.length,
    ok,
  };
}
