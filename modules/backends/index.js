/**
 * 绘灵 · 生图后端注册表
 *
 * 三个后端（ComfyUI / NovelAI / OpenAI 兼容）对外必须是**同一个形状**：
 *   submit({ prompt, negative, nl, cfg, taskId, label }) → { ok, images, error, elapsed }
 *   probe(be) → { ok, message, error, hint }
 *   可选 testGenerate(be, prompt) → { ok, images, error, elapsed }
 * pipeline、UI、诊断面板都只认这套契约，不知道底下是谁在出图。
 *
 * 为什么用**动态 import**而不是顶部静态导入：三个后端里有两个会连带加载
 * zip 解包 / 各家协议解析，而用户实际只用一个。静态导入等于每次开插件
 * 都把三份代码读进内存；动态导入让「只用 ComfyUI」的人不为另两个付出代价。
 */

export const BACKENDS = [
  {
    key: 'comfyui',
    name: 'ComfyUI',
    short: 'ComfyUI',
    hint: '本地/局域网工作流，走 %占位符% 替换',
    /** 云后端要 Key，ComfyUI 不用 —— UI 用它决定提示语的措辞 */
    needsKey: false,
  },
  {
    key: 'nai',
    name: 'NovelAI',
    short: 'NAI',
    hint: '官方 /ai/generate-image，也兼容第三方镜像站',
    needsKey: true,
  },
  {
    key: 'openai',
    name: 'OpenAI 兼容',
    short: 'OpenAI',
    hint: 'images/generations 口径：官方 / 中转 / Gemini 兼容层',
    needsKey: true,
  },
];

const LOADERS = {
  comfyui: () => import('./comfyui.js'),
  nai: () => import('./nai.js'),
  openai: () => import('./openai.js'),
};

export const DEFAULT_BACKEND = 'comfyui';

/**
 * 「不出图」哨兵值。
 *
 * 这不是"配错了"的兜底，而是一个**显式选项**：只让绘灵分析出词、写出图位，
 * 但不真的提交生图。调提示词、试规范、跑 DRY 测试都靠它 ——
 * 否则每次调词都要真出图，既慢又费额度。
 */
export const OFF_BACKEND = 'none';

/** 是否是我们认识的后端 key（用户配置文件里可能残留别的值）。 */
export function isKnownBackend(key) {
  return Object.prototype.hasOwnProperty.call(LOADERS, String(key || ''));
}

export function backendMeta(key) {
  return BACKENDS.find(b => b.key === key) || BACKENDS[0];
}

/**
 * 取当前生效的后端 key。
 * · 'none' → 原样返回（显式不出图）
 * · 认识的 key → 原样返回
 * · 空 / 不认识（比如旧配置里的残留值）→ 回落 ComfyUI，不抛错
 */
export function activeBackendKey(cfg) {
  const key = String(cfg?.activeBackend || '').trim();
  if (key === OFF_BACKEND) return OFF_BACKEND;
  return isKnownBackend(key) ? key : DEFAULT_BACKEND;
}

/** 动态加载某个后端模块；加载失败返回 null（调用方负责记诊断）。 */
export async function loadBackend(key) {
  const loader = LOADERS[key] || LOADERS[DEFAULT_BACKEND];
  try {
    return await loader();
  } catch (err) {
    return null;
  }
}

/** 该后端是否「看起来配好了」——UI 用来在渠道条上打勾/打感叹号。 */
export function backendReadiness(key, cfg) {
  const be = cfg?.backends?.[key] || {};
  if (key === OFF_BACKEND) return { ready: false, reason: '设为不出图', off: true };
  if (be.enabled === false) return { ready: false, reason: '未启用' };

  if (key === 'comfyui') {
    if (!String(be.serverUrl || '').trim()) return { ready: false, reason: '缺服务地址' };
    if (!String(be.workflowJson || '').trim()) return { ready: false, reason: '缺工作流' };
    return { ready: true, reason: '已配置' };
  }
  if (key === 'nai') {
    if (!String(be.serverUrl || '').trim()) return { ready: false, reason: '缺接口地址' };
    if (!String(be.apiKey || '').trim()) return { ready: false, reason: '缺 API Key' };
    if (!String(be.model || '').trim()) return { ready: false, reason: '缺模型' };
    return { ready: true, reason: '已配置' };
  }
  if (key === 'openai') {
    if (!String(be.serverUrl || '').trim()) return { ready: false, reason: '缺接口地址' };
    if (!String(be.apiKey || '').trim()) return { ready: false, reason: '缺 API Key' };
    if (!String(be.model || '').trim()) return { ready: false, reason: '缺模型' };
    return { ready: true, reason: '已配置' };
  }
  return { ready: false, reason: '未知后端' };
}

/**
 * 统一的提交入口 —— pipeline 只调这一个。
 * 未启用/未配置的后端会返回一份可读的失败结果，而不是抛异常把整条管线炸掉。
 */
export async function submit({ cfg, taskId, label, prompt, negative, nl }) {
  const key = activeBackendKey(cfg);
  if (key === OFF_BACKEND) {
    return { ok: false, error: '当前设为「不出图」（只写出图位）', backend: key, skipped: true };
  }
  const mod = await loadBackend(key);
  if (!mod || typeof mod.submit !== 'function') {
    return { ok: false, error: `后端「${key}」加载失败（模块缺失或语法错误）`, backend: key };
  }
  const res = await mod.submit({ prompt, negative, nl, cfg, taskId, label });
  return { ...res, backend: key };
}

/** 统一的连通性测试。 */
export async function probe(key, cfg) {
  const mod = await loadBackend(key);
  if (!mod || typeof mod.probe !== 'function') return { ok: false, error: '该后端没有提供连接测试' };
  const be = cfg?.backends?.[key] || {};
  return mod.probe(be);
}

/** 统一的测试生图。返回 unsupported=true 表示后端没实现（UI 需要隐藏按钮）。 */
export async function testGenerate(key, cfg, prompt) {
  const mod = await loadBackend(key);
  if (!mod || typeof mod.testGenerate !== 'function') return { ok: false, unsupported: true, error: '该后端没提供测试生图' };
  const be = cfg?.backends?.[key] || {};
  const res = await mod.testGenerate(be, prompt);
  mod.logTestResult?.(res);
  return res;
}
