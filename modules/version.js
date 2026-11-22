/**
 * 绘灵 · 版本号（唯一真相源）
 *
 * ⚠️ 为什么单独一个文件：面板（ui/panel.js）要在标题栏显示版本号，
 *    但它**不能**从 index.js 导入 —— index.js 顶部就 import 了 ui/panel.js，
 *    反向导入会形成循环，ESM 下 `VERSION` 会落在 TDZ 里（读到 undefined 或直接抛错）。
 *    抽成无依赖的叶子模块，两边都能安全 import。
 *
 * ⚠️ 改版本号时**必须同时改 manifest.json 的 version**：
 *    酒馆「扩展」列表显示的是 manifest 里的那个值。历史上 manifest 长期停在 0.6.5，
 *    而实际已到 0.9.x —— 用户看到的版本一直是错的。
 */
export const VERSION = '0.9.188';
