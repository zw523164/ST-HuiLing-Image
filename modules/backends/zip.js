/**
 * 绘灵 · 最小 ZIP 解包
 *
 * 为什么自己写：NovelAI 的生图接口返回的不是图片字节，而是一个 **zip**
 * （里面包着一张 png）。常见做法是靠 `fflate`（npm 包）解 —— 而绘灵是纯 ESM、
 * 没有打包器，引不了 npm 依赖。
 *
 * 好消息是：zip 的活其实只有两件 ——
 *   ① 按格式把压缩字节切出来（纯字节运算，见下）
 *   ② 解压 deflate 流 —— 这件事**浏览器/Node 原生就有**：
 *      `DecompressionStream('deflate-raw')`
 * 于是整个模块不到 150 行，零依赖，也不需要往插件里塞一个 30KB 的库。
 *
 * 支持：stored(0) / deflate(8)。单文件优先，也能列全部。
 * 不支持（用不到也不打算支持）：zip64、加密、bzip2/lzma 等冷门压缩法。
 */

/** End of central directory record */
const SIG_EOCD = 0x06054b50;
/** Central directory file header */
const SIG_CEN = 0x02014b50;
/** Local file header */
const SIG_LOC = 0x04034b50;

export class ZipError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'ZipError';
    this.detail = detail;
  }
}

/**
 * 从尾部倒着找 EOCD。zip 的注释区最长 65535 字节，所以搜索窗口是
 * 「最后 22 + 65535 字节」，再远不可能有。
 */
function findEocd(dv, byteLength) {
  const min = Math.max(0, byteLength - 22 - 0xffff);
  for (let i = byteLength - 22; i >= min; i -= 1) {
    if (dv.getUint32(i, true) === SIG_EOCD) return i;
  }
  return -1;
}

/**
 * 扫 local file header 的兜底路径。
 *
 * 什么时候用得上：EOCD 里的 central directory 偏移被写成 0xffffffff（zip64 标记），
 * 或者某些非标准打包器把 EOCD 写坏了。这时从文件头顺着 local header 往下走，
 * 一样能把条目切出来（缺点：拿不到 zip64 的大小，靠 DecompressionStream
 * 自己读 deflate 流的结束标记来兜）。
 */
function scanLocalHeaders(dv, byteLength) {
  const out = [];
  let p = 0;
  while (p + 30 <= byteLength) {
    if (dv.getUint32(p, true) !== SIG_LOC) break;
    const method = dv.getUint16(p + 8, true);
    const compSize = dv.getUint32(p + 18, true);
    const uncompSize = dv.getUint32(p + 22, true);
    const nameLen = dv.getUint16(p + 26, true);
    const extraLen = dv.getUint16(p + 28, true);
    const dataStart = p + 30 + nameLen + extraLen;
    const name = new TextDecoder().decode(new Uint8Array(dv.buffer, dv.byteOffset + p + 30, nameLen));
    out.push({ name, method, compSize, uncompSize, dataStart, localOffset: p });
    if (compSize > 0) {
      p = dataStart + compSize;
    } else {
      // 大小写在 data descriptor 里（streamed 模式）—— 只对 stored 能靠 next
      // local header 推，deflate 只能交给解压器自己找流尾
      break;
    }
  }
  return out;
}

/**
 * 列出 zip 里的条目（只读元信息，不解压）。
 * @param {ArrayBuffer|Uint8Array} buffer
 * @returns {Array<{name:string, method:number, compSize:number, uncompSize:number, dataStart:number}>}
 */
export function listZipEntries(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const len = bytes.byteLength;

  if (len < 22) throw new ZipError(`数据太短（${len} 字节），不是 zip`);

  const eocd = findEocd(dv, len);
  if (eocd < 0) {
    const scanned = scanLocalHeaders(dv, len);
    if (!scanned.length) {
      throw new ZipError('没有找到 zip 结构（既无 EOCD 也无 local header）', { byteLength: len });
    }
    return scanned;
  }

  const count = dv.getUint16(eocd + 10, true);
  const cdOffset = dv.getUint32(eocd + 16, true);

  // zip64 标记 → 走兜底扫描
  if (cdOffset === 0xffffffff || count === 0xffff) {
    const scanned = scanLocalHeaders(dv, len);
    if (scanned.length) return scanned;
  }

  const entries = [];
  let p = cdOffset;
  for (let i = 0; i < count; i += 1) {
    if (p + 46 > len || dv.getUint32(p, true) !== SIG_CEN) break;
    const method = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const uncompSize = dv.getUint32(p + 24, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOffset = dv.getUint32(p + 42, true);
    const name = new TextDecoder().decode(new Uint8Array(bytes.buffer, bytes.byteOffset + p + 46, nameLen));

    // local header 的 name/extra 长度可能与 central 不一致（打包器会往 extra 塞东西）
    let dataStart = localOffset + 30;
    if (localOffset + 30 <= len && dv.getUint32(localOffset, true) === SIG_LOC) {
      dataStart = localOffset + 30 + dv.getUint16(localOffset + 26, true) + dv.getUint16(localOffset + 28, true);
    }
    entries.push({ name, method, compSize, uncompSize, dataStart, localOffset });
    p += 46 + nameLen + extraLen + commentLen;
  }

  if (!entries.length) throw new ZipError('zip 里没有条目');
  return entries;
}

/** 把 deflate 原始流解出来（deflate-raw = 不带 zlib 头尾的那版，正是 zip 用的）。 */
async function inflateRaw(bytes) {
  if (typeof DecompressionStream !== 'function') {
    throw new ZipError('当前环境没有 DecompressionStream，无法解压 deflate 流（需要 Chrome 80+ / Node 18+）');
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const out = new Uint8Array(await new Response(stream).arrayBuffer());
  return out;
}

/**
 * 解压出一个条目。
 *
 * `end` 的取法很关键：compSize 为 0（data descriptor 写法）时不知道压缩数据多长，
 * 这时把「从 dataStart 到文件尾」整段喂给 DecompressionStream —— deflate 流的
 * BFINAL 位会告诉解压器在哪结束，多喂的字节不会污染结果。
 * 这比猜一个长度可靠得多。
 */
async function extractEntry(bytes, entries, index) {
  const e = entries[index];
  const start = e.dataStart;
  if (start >= bytes.byteLength) throw new ZipError(`条目「${e.name}」的数据偏移越界`);

  const next = entries
    .filter((x, i) => i !== index && x.localOffset > e.localOffset)
    .sort((a, b) => a.localOffset - b.localOffset)[0];
  // 已知压缩长度就用它，不知道就吃到下一个 local header（吃不到就吃到文件尾）
  const end = e.compSize > 0
    ? Math.min(start + e.compSize, bytes.byteLength)
    : (next ? next.localOffset : bytes.byteLength);

  const raw = bytes.subarray(start, end);
  if (e.method === 0) return new Uint8Array(raw); // stored，原样
  if (e.method === 8) {
    const out = await inflateRaw(raw);
    if (e.uncompSize > 0 && out.byteLength !== e.uncompSize) {
      // 不是致命错，但值得让上层知道（有些打包器会填错）
      console.warn(`[绘灵] zip 条目「${e.name}」解压后 ${out.byteLength} 字节，头里写的是 ${e.uncompSize}`);
    }
    return out;
  }
  throw new ZipError(`不支持的压缩方式 ${e.method}（只支持 stored / deflate）`, { name: e.name });
}

/** 解压全部条目（跳过目录项）。 */
export async function unzipAll(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const entries = listZipEntries(bytes).filter(e => !e.name.endsWith('/'));
  const out = [];
  for (let i = 0; i < entries.length; i += 1) {
    out.push({ name: entries[i].name, bytes: await extractEntry(bytes, entries, i) });
  }
  return out;
}

/** 解压第一个图片条目（跳过目录项 / macOS 的 __MACOSX 垃圾）。 */
export async function unzipFirstImage(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const all = listZipEntries(bytes);
  const usable = all.filter(e => !e.name.endsWith('/') && !e.name.startsWith('__MACOSX/'));
  if (!usable.length) throw new ZipError('zip 里没有文件条目');

  // 优先挑图片；挑不到就用第一个（NAI 包里就一张 png，但第三方站可能塞别的东西）
  const pick = usable.find(e => /\.(png|jpe?g|webp)$/i.test(e.name)) || usable[0];
  const index = all.indexOf(pick);
  return { name: pick.name, bytes: await extractEntry(bytes, all, index) };
}

/** 从文件名猜 MIME（生成 data URL 用）。 */
export function mimeFromName(name) {
  const ext = String(name || '').split('.').pop()?.toLowerCase() || '';
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  if (ext === 'gif') return 'image/gif';
  return 'image/png';
}
