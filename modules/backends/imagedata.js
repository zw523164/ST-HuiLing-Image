/**
 * 绘灵 · 图片数据小工具（NAI / OpenAI 两个云后端共用）
 *
 * 云后端拿到的图有五种形态，全都要认：
 *   zip 包里的 png 字节、裸 png/jpeg 字节、data URL、裸 base64 串、http 链接。
 * 各写一遍容易走形（一个后端认了、另一个没认），所以统一放这儿。
 */

/** Uint8Array → base64。分块是因为 fromCharCode.apply 的实参有上限，大图会爆栈。 */
export function bytesToBase64(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < u8.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
  }
  if (typeof btoa === 'function') return btoa(bin);
  return Buffer.from(bin, 'binary').toString('base64'); // Node（测试）兜底
}

const MAGIC_PNG = [0x89, 0x50, 0x4e, 0x47];
const MAGIC_JPEG = [0xff, 0xd8, 0xff];
const MAGIC_GIF = [0x47, 0x49, 0x46, 0x38];
const MAGIC_WEBP = [0x52, 0x49, 0x46, 0x46]; // RIFF....WEBP

/** 看开头几个字节判断是不是图片、是什么图片。不是图片返回 null。 */
export function sniffImageBytes(bytes) {
  if (!bytes || bytes.length < 4) return null;
  const head = Array.from(bytes.subarray(0, 4));
  const eq = (magic) => magic.every((b, i) => head[i] === b);
  if (eq(MAGIC_PNG)) return { mime: 'image/png', ext: 'png' };
  if (eq(MAGIC_JPEG)) return { mime: 'image/jpeg', ext: 'jpg' };
  if (eq(MAGIC_GIF)) return { mime: 'image/gif', ext: 'gif' };
  if (eq(MAGIC_WEBP)) return { mime: 'image/webp', ext: 'webp' };
  return null;
}

/**
 * 把一个「可能是图的东西」归一成 { url, format }。
 * 认 data URL、http 链接、裸 base64。认不出返回 null。
 *
 * @param {string} value
 * @param {object} [opts]
 * @param {boolean} [opts.strict] 裸 base64 是否要求「长且干净」。
 *   默认 true（防把哈希/ID 误当图片）；在已知图片字段（images / b64_json…）
 *   里降为 false —— 那里出现的 base64 哪怕只有几十字符也应当认
 *   （小尺寸测试图、缩略图就是这么短）。
 * @param {boolean} [opts.allowRelative] 是否认「以图片扩展名结尾的相对路径」。
 *   一些自建/中转端点返回 `/files/a.png` 这种半截地址，必须按同源补全才用得了。
 *   默认关：相对路径太容易误判，只在明确知道对方这么干的调用点打开。
 */
export function normalizeImageValue(value, opts = {}) {
  const strict = opts.strict !== false;
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!s) return null;

  if (s.startsWith('data:image/')) {
    const mime = s.slice(5, s.indexOf(';')) || 'image/png';
    return { url: s, format: mime.split('/')[1] || 'png' };
  }
  if (/^https?:\/\//i.test(s)) {
    // 有些站给的是 http 链接（临时地址），交给归档层去下载
    return { url: s, format: 'png', remote: true };
  }
  // 相对路径：必须带图片扩展名，否则 '/v1/chat' 这种也会被当成图
  if (opts.allowRelative && /^\/[^\s?]*\.(png|jpe?g|webp|gif|avif)$/i.test(s)) {
    const ext = s.split('.').pop().toLowerCase();
    return { url: s, format: ext === 'jpg' ? 'jpeg' : ext, remote: true, relative: true };
  }
  // 裸 base64：字符集对得上 + 长度够（已知图片字段里门槛放低）
  const compact = s.replace(/\s+/g, '');
  const minLen = strict ? 512 : 16;
  if (compact.length > minLen && /^[A-Za-z0-9+/=]+$/.test(compact)) {
    return { url: `data:image/png;base64,${compact}`, format: 'png' };
  }
  return null;
}

/** 这些字段里出现的字符串，基本可以确定是图。 */
const IMAGE_KEYS = new Set([
  'images', 'image', 'b64_json', 'b64', 'base64', 'image_url',
  'data', 'output', 'result', 'url',
]);

function walk(node, depth, visit, seen, inImageKey) {
  if (depth > 8 || node == null) return;
  if (typeof node === 'string') { visit(node, inImageKey); return; }
  if (Array.isArray(node)) {
    for (const item of node) walk(item, depth + 1, visit, seen, inImageKey);
    return;
  }
  if (typeof node === 'object') {
    if (seen.has(node)) return;
    seen.add(node);
    for (const [k, v] of Object.entries(node)) {
      const flag = inImageKey || IMAGE_KEYS.has(k);
      if (typeof v === 'string') visit(v, flag);
      else walk(v, depth + 1, visit, seen, flag);
    }
  }
}

/**
 * 从任意 JSON 结构里挖出**全部**图片（保序、去重）。
 * @param {object} [opts] 透传给 normalizeImageValue（如 { allowRelative: true }）
 */
export function collectImagesFromJson(json, opts = {}) {
  const out = [];
  const seenUrl = new Set();
  walk(json, 0, (raw, inImageKey) => {
    const norm = normalizeImageValue(raw, { strict: !inImageKey, ...opts });
    if (!norm || seenUrl.has(norm.url)) return;
    seenUrl.add(norm.url);
    out.push(norm);
  }, new Set(), false);
  return out;
}

/** 只挖第一张（NAI 一次就一张，用它够了）。 */
export function pickImageFromJson(json) {
  return collectImagesFromJson(json)[0] || null;
}

/** 从 JSON 里挖错误信息（各家的字段名不一样）。 */
export function extractErrorMessage(json) {
  if (!json || typeof json !== 'object') return '';
  const e = json.error ?? json.errors ?? json.message ?? json.detail;
  if (!e) return '';
  if (typeof e === 'string') return e;
  if (typeof e === 'object') return e.message || e.msg || JSON.stringify(e).slice(0, 300);
  return String(e);
}
