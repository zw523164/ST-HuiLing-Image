/**
 * 绘灵（ST-HuiLing-Image）· 入口
 *
 * 加载顺序：
 *   ① 等酒馆上下文就绪（extensionSettings + 扩展设置容器出现）
 *   ② 挂设置面板
 *   ③ 注册正文隐藏正则（幂等，用固定 ID）
 *   ④ 启动扫描器
 *
 * 任何一步失败都记进诊断中心，不静默死掉 —— 这是从「失败要留痕」来的态度。
 */

import { getCtx, primeScriptModule } from './modules/st.js';
import { getConfig } from './modules/settings.js';
import { cleanupTempImages } from './modules/store.js';
import { info, warn, error, STAGE } from './modules/log.js';
import {
  startScanner, stopScanner, scanAll, forceRerun, runManual, runManualMany,
} from './modules/scanner.js';
import {
  registerRegex, unregisterRegex,
  installRenderHooks, installIframeWatcher, render, regenerate, clearFloorRender, preloadSlotCss,
  setInlineMode,
} from './modules/render.js';
import { mountQuickCard } from './modules/ui/panel.js';
import { syncLauncher, openWindow, closeWindow, toggleWindow } from './modules/ui/launcher.js';
import {
  installGalBridge, uninstallGalBridge, galBridgeStatus, cleanHlImageFloors, countHlImageFloors,
  auditLatestFloor, fixLatestFloorStructure,
} from './modules/galBridge.js';

// 版本号改到 modules/version.js（面板要用，不能让它反向 import index.js 造成循环）
import { VERSION } from './modules/version.js';
export { VERSION };

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * 等酒馆把上下文准备好。
 *
 * 注意这里**不再要求**扩展设置容器出现 —— 绘灵的主体界面是独立窗口，
 * 扩展设置里那张卡只是「能在扩展列表里找到它」的入口。容器没就绪不该拖垮整个插件。
 */
async function waitForReady(timeoutMs = 45000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (getCtx().extensionSettings) return { ok: true };
    await sleep(300);
  }
  return { ok: false, reason: 'extensionSettings 未就绪' };
}

async function boot() {
  const ready = await waitForReady();
  if (!ready.ok) {
    error(STAGE.BOOT, `等待酒馆就绪超时（${ready.reason}）`, {
      cause: '酒馆前端没有在预期时间内完成初始化',
      fix: '刷新一次页面；若反复出现，检查是否有其它扩展抛出异常阻断了初始化',
    });
    return;
  }

  try {
    const cfg = getConfig();

    // ★ 预热「生成中」判定要用的 ST 脚本模块（异步，不阻塞后续初始化）。
    //   这是 v0.9.33 卡死修复的关键：拿不到它，render 的「流式期间挂起」防线
    //   就是死代码（globalThis.is_send_press 恒 false），正文每变一次就整楼重建。
    primeScriptModule().then((mod) => {
      if (!mod) warn(STAGE.BOOT, '没能拿到酒馆 script 模块，「生成中」判定只能靠 DOM 兜底（渲染挂起可能偏保守）');
    }).catch(() => { /* 兜底已在 st.js 里，不阻断启动 */ });

    // 扩展设置里只放一张启动卡；完整面板在窗口里（打开时才挂载）
    try {
      mountQuickCard();
    } catch (err) {
      warn(STAGE.UI, `扩展设置里的启动卡没挂上（不影响窗口）：${err?.message || err}`);
    }

    if (cfg.registerRegex) registerRegex();

    /**
     * 一次性数据清洗（v0.9.100）：把老存档里 `type:'temp'` 的 ComfyUI 临时预览图摘掉。
     * 那些是高清放大/分块重绘节点的局部裁切预览，混在正式图里就是「图库里好几张被裁剪的图」。
     * 幂等：跑过落 marker，只动这一次。
     */
    try {
      cleanupTempImages();
    } catch (err) {
      warn(STAGE.BOOT, `清理临时预览图失败（不影响使用）：${err?.message || err}`);
    }

    //样式表文本预拉取：正文被搬进 srcdoc iframe 时，图框要带着样式在那边的文档里重生（v0.9.78）
    preloadSlotCss();

    // 渲染钩子必须在扫描器之前装好：出图后要靠它把图顶到段落位置
    installRenderHooks();

    // 美化 iframe 常常在绘灵渲染之后才被创建 —— 盯住 chat 树，出现就补一轮（v0.9.78）
    installIframeWatcher();

    // 顶栏 / 魔杖菜单 / 悬浮球三条入口，按配置增减
    syncLauncher();

    /**
     * GAL 前端联动（v0.9.164）：按配置决定要不要以 `window.NaiDbGen` 的身份挂上去。
     * 放在 launcher 之后、扫描器之前 —— 它是纯全局注册，不依赖扫描器状态；
     * 挂载失败绝不能拖垮启动（GAL 可能还没加载，也可能已占用同名）。
     */
    try {
      installGalBridge(cfg);
    } catch (err) {
      warn(STAGE.GAL, `GAL 联动挂载失败（不影响绘灵自身）：${err?.message || err}`);
    }

    startScanner();

    info(STAGE.BOOT, `绘灵 v${VERSION} 已加载（插件${cfg.enabled ? '已开启' : '未开启'}｜自动分析${cfg.autoRun ? '开' : '关'}｜渲染 ${cfg.render?.mode || 'inline'}）`);
  } catch (err) {
    error(STAGE.BOOT, `初始化失败：${err?.message || err}`, {
      cause: '面板挂载或模块加载出错',
      fix: '把这条日志导出后反馈；临时可先禁用插件',
    }, err?.stack);
  }
}

jQuery(async () => { await boot(); });

/* ============ 对外接口（控制台/其它扩展可调） ============ */

globalThis.HuiLing = {
  version: VERSION,
  getConfig,
  scanAll,
  rerunFloor: forceRerun,
  /**
   * 手动跑指定楼层（兜底通道，不看 autoRun / 不看失败次数）：
   *   HuiLing.runFloors(3)          // 单楼
   *   HuiLing.runFloors([3, 5, 7])  // 多楼，串行
   *   HuiLing.runFloors(3, { body: '新正文…', writeBody: true })  // 改正文后覆盖再跑
   */
  runFloors: (ids, opts) => runManualMany(Array.isArray(ids) ? ids : [Number(ids)], opts),
  runFloor: runManual,
  /** 直接打开「手动生图」页：HuiLing.openManual() */
  openManual: () => openWindow('manual'),
  startScanner,
  stopScanner,
  registerRegex,
  unregisterRegex,
  /**
   * 图是堆在楼顶还是回到剧情里 —— 两个开关的组合（v0.9.78）。
   *   预览内联： HuiLing.setInlineMode(true)
   *   回到楼顶： HuiLing.setInlineMode(false)
   * 原理写在 render.js / settings.js 那两个开关的注释里。
   */
  setInlineMode,   // 实现在 render.js（面板开关与控制台共用同一份）
  /** iframe 域渲染总开关（出问题时兜底关掉，退回只认宿主文档的老行为）。 */
  setIframeRender: (on = true) => { getConfig().renderInsideIframe = !!on; return getConfig().renderInsideIframe; },
  /** 手动重渲某楼层（控制台调试用）：HuiLing.render(3) */
  render,
  /** 重生成某个出图位：HuiLing.regen(3, 'P2') */
  regen: regenerate,
  /** 清掉某楼层的图：HuiLing.clearFloor(3) */
  clearFloor: clearFloorRender,
  /** 打开绘灵窗口（可带页签：HuiLing.openWindow('cast')） */
  openWindow,
  closeWindow,
  toggleWindow,
  /** 旧名字，保留兼容；指向开窗 */
  openPanel: openWindow,
  /** 重建入口（改完 ui 配置后调一次即可生效） */
  syncLauncher,
  /**
   * GAL 联动（v0.9.164）：
   *   HuiLing.galStatus()             // 看现在挂没挂、当前口径与画布
   *   HuiLing.galOn(true)             // 开（会写进配置并立刻挂上）
   *   HuiLing.galOn(false)            // 关（只摘自己挂的那个，不动别人的 NaiDbGen）
   */
  galStatus: galBridgeStatus,
  /** 清理本对话里绘灵写的 <hl_image> 图位（GAL 模式下必须清，否则阅读器把 JSON 当正文显示） */
  galCleanHlImage: () => cleanHlImageFloors(),
  galCountHlImage: () => countHlImageFloors(),
  /**
   * 正文结构体检 / 急救（v0.9.174）：
   *   HuiLing.galAuditBody()          // 看最新 AI 楼有没有「未闭合伪标签」把插图位置全废掉
   *   HuiLing.galFixBody()            // 给这一楼的剧情套 <content>（会改正文，只在你手动调时执行）
   */
  galAuditBody: () => auditLatestFloor(),
  galFixBody: () => fixLatestFloorStructure(),
  galOn: (on = true) => {
    const c = getConfig();
    if (!c.galBridge) c.galBridge = {};
    c.galBridge.enabled = !!on;
    if (on) installGalBridge(c);
    else uninstallGalBridge();
    return galBridgeStatus();
  },
};
