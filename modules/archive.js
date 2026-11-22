/**
 * 绘灵 · 图片归档
 *
 * ── 为什么必须有这一层 ─────────────────────────────────────
 * ComfyUI 的 /view 链接**不是永久地址**：
 *   · ComfyUI 重启、清 history、换输出目录，图立刻 404；
 *   · 出图目录被清理时，昨天的剧情图今天就全没了。
 * 实测最痛的不是"重复出图"，而是"三天后回来发现存档里的图全变破图"。
 *
 * 所以每张图出完立刻落地到酒馆自己的 user/images/ 下：
 *   user/images/绘灵_<角色名>/<roleHash>_<position>_<promptHash>-<ts>.<ext>
 * 结果里同时保留两个地址：
 *   · localUrl  —— /user/images/... 优先用，永久
 *   · url       —— ComfyUI /view 兜底，本地服务器上其实也能用
 * 渲染时优先 localUrl，挂了自动回退 url（见 render.js）。
 *
 * ── 三条纪律 ───────────────────────────────────────────────
 *   ① 归档失败**绝不能让出图失败**。拿不到本地副本就退回 remote 地址，照常出图。
 *   ② 上传失败降级为静默（记 debug），不弹错误 —— 用户不需要知道 ST 存储的事。
 *   ③ 只有出图成功才归档；错误结果里的 images 一律不碰。
 *
 * 接口对应酒馆服务端 /api/images/*（upload 只返回 { path }）。
 */

import { getRequestHeaders, getCharName } from './st.js';
import { hash32, clone } from './util.js';
import { info, debug, warn, STAGE } from './log.js';

/** 归档目录前缀（带它才能在酒馆原生图库里一眼认出来）。 */
export const ARCHIVE_PREFIX = '绘灵_';

const MIME_EXT = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/avif': 'avif',
};

/** 归档目录名。角色名清洗掉路径分隔符与常见非法字符。 */
export function archiveFolder(charName) {
  const raw = String(charName || '').trim() || '未命名';
  const safe = raw.replace(/[\\/:*?"<>|]/g, '_').slice(0, 40);
  return `${ARCHIVE_PREFIX}${safe}`;
}

/**
 * Blob → base64。
 * 刻意不用 FileReader：它在 Node（测试）里没有，而 btoa 浏览器和 Node 都有。
 * 分块处理是因为 String.fromCharCode.apply 的实参数量有上限，
 * 一张 1MB 的图一次性塞进去会直接爆栈。
 */
async function blobToBase64(blob) {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  const CHUNK = 0x8000;
  let bin = '';
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  if (typeof btoa === 'function') return btoa(bin);
  return Buffer.from(bin, 'binary').toString('base64');
}

/**
 * 上传一张图到 user/images/<folder>/。
 * @returns {Promise<string>} 可访问的相对路径（/user/images/...）
 */
async function uploadUserImage(folder, filename, base64, format) {
  const res = await fetch('/api/images/upload', {
    method: 'POST',
    headers: getRequestHeaders(),
    body: JSON.stringify({ image: base64, format, ch_name: folder, filename }),
  });
  if (!res.ok) throw new Error(`上传失败 HTTP ${res.status}`);
  const text = await res.text().catch(() => '');
  let path = '';
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed?.path === 'string') path = parsed.path;
  } catch { /* 落到下面的报错 */ }
  if (!path) throw new Error('服务端未返回图片路径');
  return path;
}

/**
 * 把一张 ComfyUI 结果图搬到 ST 服务器。
 * 失败返回 null（调用方保留原 remote 地址）。
 */
export async function archiveOne(img, { folder, position, promptHash, index = 0, timeoutMs = 20000 }) {
  if (!img?.url) return null;
  // 已经是本地相对路径（/user/...）就不用再搬一次
  if (String(img.url).startsWith('/user/')) return { localUrl: String(img.url), path: String(img.url) };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(img.url, { signal: controller.signal });
    if (!res.ok) throw new Error(`下载原图失败 HTTP ${res.status}`);
    const blob = await res.blob();
    const format = MIME_EXT[blob.type] || 'png';
    const name = `${String(promptHash || 'p').slice(0, 8)}_${position || 'P0'}_${index}_${Date.now()}`;
    const path = await uploadUserImage(folder, `${name}.${format}`, await blobToBase64(blob), format);
    return { localUrl: path, path, size: blob.size, format };
  } catch (err) {
    debug(STAGE.BACKEND, `图片归档未成功（已退回临时地址）：${err?.message || err}`);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 归档一组出图结果，就地补上 localUrl。
 * @param {Array} images 后端返回的 images 数组
 * @returns {Promise<Array>} 新数组（带 localUrl 的那些）
 */
export async function archiveImages(images, { charName, position, promptHash } = {}) {
  const list = Array.isArray(images) ? images : [];
  if (!list.length) return list;

  const folder = archiveFolder(charName || getCharName());
  const out = [];
  let saved = 0;

  for (let i = 0; i < list.length; i += 1) {
    const im = list[i];
    const local = await archiveOne(im, { folder, position, promptHash, index: i });
    if (local) {
      saved += 1;
      out.push({ ...im, ...local });
    } else {
      out.push({ ...im });
    }
  }

  if (saved) info(STAGE.BACKEND, `${position || ''} 已归档 ${saved}/${list.length} 张到 ${folder}`);
  else if (list.length) warn(STAGE.BACKEND, `${position || ''} 图片归档失败，将使用临时地址（重启 ComfyUI 后可能失效）`);

  return out;
}

/** 归档一个楼层结果对象（就地改 images，返回新对象）。 */
export async function archiveResult(result, { charName } = {}) {
  if (!result || !Array.isArray(result.images) || !result.images.length) return result;
  const images = await archiveImages(result.images, {
    charName,
    position: result.position,
    promptHash: result.hash || hash32(result.prompt || ''),
  });
  return { ...clone(result), images };
}

/* ---------- 探测与删除 ---------- */

/**
 * 探一张图在不在。
 * 刻意三分：
 *   { exists: true }  文件在
 *   { exists: false } 服务端明确 404
 *   null              **分不清**（网络抖动/超时/5xx）
 * 第三态是关键 —— 把一次掉线当成"图丢了"会让用户满屏看见"图片已失效"。
 */
export async function probeImage(path, timeoutMs = 6000) {
  if (!path) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(path, { method: 'HEAD', signal: controller.signal });
    if (res.status === 404) return { exists: false };
    if (!res.ok) return null;
    return { exists: true };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** 删除 user/images 下的一张图。返回 false = 本来就不存在。 */
export async function deleteImage(path) {
  if (!path || !String(path).startsWith('/user/')) return false;
  const res = await fetch('/api/images/delete', {
    method: 'POST',
    headers: getRequestHeaders(),
    body: JSON.stringify({ path }),
  });
  if (res.ok) return true;
  if (res.status === 404) return false;
  throw new Error(`删除失败 HTTP ${res.status}`);
}

/* ---------- 下载到本地 ---------- */

/** 把图另存到用户的下载目录。同源文件走 <a download>，不绕 blob。 */
export function downloadImage(url, filename) {
  if (!url) return false;
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = String(filename || 'huiling.png').replace(/[\\/:*?"<>|]/g, '_');
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => a.remove(), 0);
    return true;
  } catch (err) {
    debug(STAGE.RENDER, `下载失败：${err?.message || err}`);
    return false;
  }
}
