// APNG 帧处置 / 透明叠加严格复核引擎（纯 ESM，无第三方依赖，浏览器与 Node 共用）
//
// 职责：
//  1. 校验 PNG 签名、每个块的 CRC、IHDR 约束（8 位 RGBA / 非交错 / ≤128）
//  2. 校验 acTL / fcTL / IDAT / fdAT 的出现顺序与 sequence_number 连续性
//  3. 逐帧独立 zlib 解压，按五种 PNG 过滤器（None/Sub/Up/Average/Paeth）还原扫描行
//  4. 严格执行 source / over 混合与 none / background / previous 处置
//  5. previous 处置恢复“绘制前快照”；对外只暴露冻结快照，帧切换只读冻结数据
//  任何违约都抛出带“首个原始字节偏移”的 APNGError。

export const MAX_INPUT_BYTES = 262144; // 256 KiB（粘贴的 Base64 文本上限）
export const MAX_DIMENSION = 128;
export const MAX_FRAMES = 8;
export const RGBA_BPP = 4;

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

export class APNGError extends Error {
  constructor(message, offset) {
    super(message);
    this.name = 'APNGError';
    this.offset = offset; // 首个违约字节在原始输入中的偏移
  }
}

/* ------------------------------ CRC32 ------------------------------ */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf, start, end) {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function u32(buf, off) {
  return ((buf[off] << 24) | (buf[off + 1] << 16) | (buf[off + 2] << 8) | buf[off + 3]) >>> 0;
}

/* --------------------------- Base64 输入 --------------------------- */

export function decodeBase64Input(text) {
  const input = String(text ?? '');
  if (input.length === 0) throw new APNGError('输入为空：请粘贴 Base64 APNG 数据', 0);
  if (input.length > MAX_INPUT_BYTES) {
    throw new APNGError(
      `输入超过 ${MAX_INPUT_BYTES} 字节（256 KiB）上限：实际 ${input.length} 字节`,
      MAX_INPUT_BYTES,
    );
  }
  let s = input.trim().replace(/\s+/g, '');
  const m = /^data:[^,]*?;base64,(.*)$/i.exec(s);
  if (m) s = m[1];
  if (s.length === 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.length % 4 !== 0) {
    throw new APNGError('不是合法的 Base64 文本', 0);
  }
  const bin = atob(s);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i) & 0xff;
  return bytes;
}

/* ----------------------------- 块遍历 ----------------------------- */

function parseChunks(buf) {
  if (buf.length < 8) throw new APNGError('数据过短，缺少 PNG 签名', buf.length);
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== PNG_SIGNATURE[i]) {
      throw new APNGError(`PNG 签名错误：第 ${i} 字节应为 0x${PNG_SIGNATURE[i].toString(16).padStart(2, '0')}`, i);
    }
  }

  const chunks = [];
  let p = 8;
  while (p < buf.length) {
    if (p + 8 > buf.length) {
      throw new APNGError('块长度/类型字段被截断', p);
    }
    const len = u32(buf, p);
    const typeStart = p + 4;
    const dataStart = p + 8;
    const dataEnd = dataStart + len;
    const crcOff = dataEnd;
    const end = crcOff + 4;
    if (end > buf.length) {
      throw new APNGError(`块数据或 CRC 被截断（声明长度 ${len}）`, buf.length);
    }
    const type = String.fromCharCode(buf[typeStart], buf[typeStart + 1], buf[typeStart + 2], buf[typeStart + 3]);
    const storedCrc = u32(buf, crcOff);
    const actualCrc = crc32(buf, typeStart, dataEnd);
    if (storedCrc !== actualCrc) {
      throw new APNGError(
        `${type} 块 CRC 校验失败：存储 0x${storedCrc.toString(16).padStart(8, '0')}，计算 0x${actualCrc.toString(16).padStart(8, '0')}`,
        crcOff,
      );
    }
    chunks.push({ type, len, start: p, typeStart, dataStart, dataEnd, crcOff, end });
    if (type === 'IEND') {
      if (end !== buf.length) {
        throw new APNGError('IEND 之后存在多余字节', end);
      }
      return chunks;
    }
    p = end;
  }
  throw new APNGError('缺少 IEND 结束块', buf.length);
}

/* --------------------------- 结构 / 语义校验 --------------------------- */

const DISPOSE_NAMES = ['none（不处置）', 'background（恢复背景）', 'previous（恢复前帧）'];
const BLEND_NAMES = ['source（直接覆盖）', 'over（Alpha 叠加）'];

function parseStructure(buf, chunks) {
  if (chunks.length === 0 || chunks[0].type !== 'IHDR') {
    throw new APNGError('首个块必须是 IHDR', chunks[0] ? chunks[0].typeStart : 8);
  }
  if (chunks[chunks.length - 1].type !== 'IEND') {
    throw new APNGError('最后一个块必须是 IEND', chunks[chunks.length - 1].end);
  }

  // IHDR
  const ihdr = chunks[0];
  if (ihdr.len !== 13) throw new APNGError('IHDR 长度必须为 13', ihdr.dataStart);
  const width = u32(buf, ihdr.dataStart);
  const height = u32(buf, ihdr.dataStart + 4);
  const bitDepth = buf[ihdr.dataStart + 8];
  const colorType = buf[ihdr.dataStart + 9];
  const compression = buf[ihdr.dataStart + 10];
  const filterMethod = buf[ihdr.dataStart + 11];
  const interlace = buf[ihdr.dataStart + 12];

  const fail = (msg, rel) => { throw new APNGError(msg, ihdr.dataStart + rel); };
  if (width === 0) fail('IHDR 宽度不能为 0', 0);
  if (height === 0) fail('IHDR 高度不能为 0', 4);
  if (width > MAX_DIMENSION) fail(`宽度 ${width} 超过 ${MAX_DIMENSION} 上限`, 0);
  if (height > MAX_DIMENSION) fail(`高度 ${height} 超过 ${MAX_DIMENSION} 上限`, 4);
  if (bitDepth !== 8) fail(`仅接受 8 位图像，实际位深 ${bitDepth}`, 8);
  if (colorType !== 6) fail(`仅接受 RGBA（color type 6），实际 color type ${colorType}`, 9);
  if (compression !== 0) fail('仅支持压缩方法 0（deflate）', 10);
  if (filterMethod !== 0) fail('仅支持过滤方法 0', 11);
  if (interlace !== 0) fail('不接受交错（Adam7）PNG', 12);

  let actl = null;
  const frames = [];
  let idatStarted = false; // 首帧 IDAT 流是否已经开始
  let expectedSeq = 0; // 下一个 fcTL / fdAT 必须持有的序号

  for (let ci = 1; ci < chunks.length; ci++) {
    const c = chunks[ci];
    const d = c.dataStart;
    switch (c.type) {
      case 'IHDR':
        throw new APNGError('出现重复 IHDR 块', c.typeStart);
      case 'acTL': {
        if (actl) throw new APNGError('出现重复 acTL 块', c.typeStart);
        if (idatStarted) throw new APNGError('acTL 必须位于首个 IDAT 之前', c.typeStart);
        if (c.len !== 8) throw new APNGError('acTL 长度必须为 8', c.dataStart);
        const numFrames = u32(buf, d);
        const numPlays = u32(buf, d + 4);
        if (numFrames === 0) throw new APNGError('acTL 声明帧数为 0', d);
        if (numFrames > MAX_FRAMES) throw new APNGError(`acTL 声明帧数 ${numFrames} 超过 ${MAX_FRAMES} 帧上限`, d);
        actl = { numFrames, numPlays, chunk: c };
        break;
      }
      case 'fcTL': {
        if (!actl) throw new APNGError('fcTL 之前必须先出现 acTL', c.typeStart);
        if (frames.length === 0 && idatStarted) {
          throw new APNGError('首帧 fcTL 必须位于首个 IDAT 之前', c.typeStart);
        }
        if (c.len !== 26) throw new APNGError('fcTL 长度必须为 26', c.dataStart);
        const seq = u32(buf, d);
        if (seq !== expectedSeq) {
          throw new APNGError(
            `sequence_number 错误：块顺序要求 ${expectedSeq}，实际 ${seq}`,
            d,
          );
        }
        const fw = u32(buf, d + 4);
        const fh = u32(buf, d + 8);
        const xOff = u32(buf, d + 12);
        const yOff = u32(buf, d + 16);
        const delayNum = (buf[d + 20] << 8) | buf[d + 21];
        const delayDen = (buf[d + 22] << 8) | buf[d + 23];
        const disposeOp = buf[d + 24];
        const blendOp = buf[d + 25];
        if (fw === 0) throw new APNGError('fcTL 帧宽度不能为 0', d + 4);
        if (fh === 0) throw new APNGError('fcTL 帧高度不能为 0', d + 8);
        if (fw > MAX_DIMENSION) throw new APNGError(`fcTL 帧宽度 ${fw} 超过 ${MAX_DIMENSION}`, d + 4);
        if (fh > MAX_DIMENSION) throw new APNGError(`fcTL 帧高度 ${fh} 超过 ${MAX_DIMENSION}`, d + 8);
        if (xOff + fw > width || yOff + fh > height) {
          throw new APNGError(
            `帧区域越界：(${xOff},${yOff}) ${fw}x${fh} 超出画布 ${width}x${height}`,
            d + 12,
          );
        }
        if (frames.length === 0 && (xOff !== 0 || yOff !== 0 || fw !== width || fh !== height)) {
          throw new APNGError(
            `首帧 fcTL 区域必须覆盖整个画布 ${width}x${height}，实际 (${xOff},${yOff}) ${fw}x${fh}`,
            d + 4,
          );
        }
        if (disposeOp > 2) throw new APNGError(`dispose_op 非法：${disposeOp}（只允许 0/1/2）`, d + 24);
        if (blendOp > 1) throw new APNGError(`blend_op 非法：${blendOp}（只允许 0/1）`, d + 25);

        // 上一帧在遇到新 fcTL 时必须已经携带图像数据
        if (frames.length > 0 && frames[frames.length - 1].data.length === 0) {
          throw new APNGError(
            `第 ${frames.length} 帧缺少图像数据（fcTL 后未跟随 IDAT/fdAT）`,
            c.typeStart,
          );
        }
        frames.push({
          index: frames.length,
          seq,
          width: fw,
          height: fh,
          xOff,
          yOff,
          delayNum,
          delayDen,
          disposeOp,
          blendOp,
          chunk: c,
          data: [],
        });
        expectedSeq++;
        break;
      }
      case 'IDAT': {
        if (!actl) throw new APNGError('IDAT 之前必须先出现 acTL 与首帧 fcTL', c.typeStart);
        if (frames.length === 0) throw new APNGError('首个 fcTL 必须位于首个 IDAT 之前', c.typeStart);
        if (frames.length > 1) {
          throw new APNGError('首帧之后不得再出现 IDAT（后续帧必须使用 fdAT）', c.typeStart);
        }
        idatStarted = true;
        frames[0].data.push({ chunk: c, bytes: buf.subarray(c.dataStart, c.dataEnd) });
        break;
      }
      case 'fdAT': {
        if (!idatStarted) throw new APNGError('fdAT 不得出现在首帧 IDAT 之前', c.typeStart);
        if (frames.length < 2) throw new APNGError('fdAT 只能用于第 2 帧及以后', c.typeStart);
        if (c.len < 4) throw new APNGError('fdAT 长度不能小于 4（缺少 sequence_number）', c.dataStart);
        const seq = u32(buf, d);
        if (seq !== expectedSeq) {
          throw new APNGError(
            `fdAT sequence_number 跳变：块顺序要求 ${expectedSeq}，实际 ${seq}`,
            d,
          );
        }
        const cur = frames[frames.length - 1];
        cur.data.push({ chunk: c, bytes: buf.subarray(d + 4, c.dataEnd) });
        expectedSeq++;
        break;
      }
      case 'PLTE':
        throw new APNGError('RGBA（color type 6）图像不得包含 PLTE 块', c.typeStart);
      case 'IEND': {
        if (frames.length === 0) throw new APNGError('动画缺少任何 fcTL 帧', c.typeStart);
        const last = frames[frames.length - 1];
        if (last.data.length === 0) {
          throw new APNGError(`第 ${last.index + 1} 帧缺少图像数据`, c.typeStart);
        }
        if (actl.numFrames !== frames.length) {
          throw new APNGError(
            `acTL 声明 ${actl.numFrames} 帧，实际出现 ${frames.length} 个 fcTL`,
            last.chunk.typeStart,
          );
        }
        break;
      }
      default: {
        // 未知关键块（首字母大写）拒绝；辅助块若夹在同一帧连续的
        // IDAT…IDAT 或 fdAT…fdAT 之间，即打断压缩数据流，同样拒绝
        const firstChar = c.type.charCodeAt(0);
        const ancillary = firstChar >= 97 && firstChar <= 122;
        if (!ancillary) throw new APNGError(`不支持的关键块 ${c.type}`, c.typeStart);
        const cur = frames[frames.length - 1];
        if (cur && cur.data.length === 0) {
          throw new APNGError(`fcTL 之后必须紧随 ${cur.index === 0 ? 'IDAT' : 'fdAT'} 图像数据，中间不得插入 ${c.type} 块`, c.typeStart);
        }
        if (ci > 0) {
          const prevType = chunks[ci - 1].type;
          if (prevType === 'IDAT' || prevType === 'fdAT') {
            throw new APNGError(`${prevType} 图像数据必须连续，中间不得插入 ${c.type} 块`, c.typeStart);
          }
        }
        break;
      }
    }
  }

  return { width, height, bitDepth, colorType, numPlays: actl.numPlays, frames };
}

/* ----------------------------- zlib 解压 ----------------------------- */

async function inflateZlib(bytes, frame) {
  // 先做 zlib 头静态检查，给出帧数据首字节偏移
  const head = frame.data[0].chunk.dataStart;
  if (bytes.length < 2) throw new APNGError('帧压缩数据过短，缺少 zlib 头', head);
  const cmf = bytes[0];
  const flg = bytes[1];
  if ((cmf & 0x0f) !== 8) throw new APNGError('zlib CM 必须为 8（deflate）', head);
  if ((cmf * 256 + flg) % 31 !== 0) throw new APNGError('zlib 头 CMF/FLG 校验错误', head);
  if (flg & 0x20) throw new APNGError('不支持带 FDICT 预置字典的 zlib 流', head + 1);

  if (globalThis.DecompressionStream) {
    try {
      const ds = new DecompressionStream('deflate');
      const stream = new Blob([bytes]).stream().pipeThrough(ds);
      const ab = await new Response(stream).arrayBuffer();
      return new Uint8Array(ab);
    } catch (e) {
      throw new APNGError(`第 ${frame.index + 1} 帧 zlib 解压失败：${e.message || e}`, head);
    }
  }
  const zlib = await import('node:zlib');
  try {
    return new Uint8Array(await zlib.default.promises.inflate(bytes));
  } catch (e) {
    throw new APNGError(`第 ${frame.index + 1} 帧 zlib 解压失败：${e.message}`, head);
  }
}

/* ----------------------------- 解滤波 ----------------------------- */

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function reconstructFrame(frame) {
  const { width: w, height: h } = frame;
  const stride = w * RGBA_BPP + 1;
  const expected = h * stride;
  if (frame.raw.length !== expected) {
    throw new APNGError(
      `第 ${frame.index + 1} 帧解压后字节数不匹配：期望 ${expected}，实际 ${frame.raw.length}`,
      frame.data[0].chunk.dataStart,
    );
  }
  const out = new Uint8Array(w * h * RGBA_BPP);
  for (let y = 0; y < h; y++) {
    const rowStart = y * stride;
    const filter = frame.raw[rowStart];
    if (filter > 4) {
      throw new APNGError(
        `第 ${frame.index + 1} 帧第 ${y} 行出现非法过滤类型 ${filter}`,
        rowStart,
      );
    }
    const cur = rowStart + 1;
    for (let x = 0; x < w * RGBA_BPP; x++) {
      const raw = frame.raw[cur + x];
      const a = x >= RGBA_BPP ? out[(y * w) * RGBA_BPP + x - RGBA_BPP] : 0;
      const b = y > 0 ? out[((y - 1) * w) * RGBA_BPP + x] : 0;
      const c = x >= RGBA_BPP && y > 0 ? out[((y - 1) * w) * RGBA_BPP + x - RGBA_BPP] : 0;
      let v;
      switch (filter) {
        case 0: v = raw; break;
        case 1: v = raw + a; break;
        case 2: v = raw + b; break;
        case 3: v = raw + ((a + b) >> 1); break;
        default: v = raw + paeth(a, b, c);
      }
      out[y * w * RGBA_BPP + x] = v & 0xff;
    }
  }
  return out;
}

/* ----------------------------- 混合 / 处置 ----------------------------- */

function compositeOver(dst, di, sr, sg, sb, sa) {
  const da = dst[di + 3];
  const outA = sa + (da * (255 - sa)) / 255;
  if (outA === 0) {
    dst[di] = dst[di + 1] = dst[di + 2] = dst[di + 3] = 0;
    return;
  }
  const invSa = (255 - sa) / 255;
  dst[di] = Math.round((sr * (sa / 255) + dst[di] * (da / 255) * invSa) / (outA / 255));
  dst[di + 1] = Math.round((sg * (sa / 255) + dst[di + 1] * (da / 255) * invSa) / (outA / 255));
  dst[di + 2] = Math.round((sb * (sa / 255) + dst[di + 2] * (da / 255) * invSa) / (outA / 255));
  dst[di + 3] = Math.round(outA);
}

/* ----------------------------- 摘要 ----------------------------- */

// 纯 JS SHA-256（后备：非安全上下文 http 下 crypto.subtle 可能不可用）
const SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function sha256Js(bytes) {
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const bitLenHi = Math.floor(bytes.length / 0x20000000);
  const bitLenLo = (bytes.length << 3) >>> 0;
  const withPad = ((bytes.length + 8) >> 6 << 6) + 64;
  const msg = new Uint8Array(withPad);
  msg.set(bytes);
  msg[bytes.length] = 0x80;
  const dv = new DataView(msg.buffer);
  dv.setUint32(withPad - 8, bitLenHi);
  dv.setUint32(withPad - 4, bitLenLo);
  const w = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let block = 0; block < withPad; block += 64) {
    for (let i = 0; i < 16; i++) w[i] = dv.getUint32(block + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const t1 = (hh + S1 + ch + SHA256_K[i] + w[i]) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (S0 + maj) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0;
      d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0; h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0; h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0; h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0; h[7] = (h[7] + hh) >>> 0;
  }
  return Array.from(h).map((v) => v.toString(16).padStart(8, '0')).join('');
}

async function sha256Hex(bytes) {
  if (globalThis.crypto?.subtle) {
    try {
      const digest = await crypto.subtle.digest('SHA-256', bytes);
      return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('');
    } catch {
      // 落到纯 JS 实现
    }
  }
  return sha256Js(bytes);
}

async function pixelSummary(label, bytes) {
  let nonZeroAlpha = 0;
  let alphaSum = 0;
  for (let i = 3; i < bytes.length; i += 4) {
    if (bytes[i] !== 0) nonZeroAlpha++;
    alphaSum += bytes[i];
  }
  return {
    label,
    bytes: bytes.length,
    sha256: await sha256Hex(bytes),
    nonZeroAlphaPixels: nonZeroAlpha,
    alphaSum,
  };
}

/* ----------------------------- 主入口 ----------------------------- */

export async function reviewApng(bytes) {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const chunks = parseChunks(buf);
  const struct = parseStructure(buf, chunks);

  const framesOut = [];
  // 合成画布：起始为全透明
  let canvas = new Uint8Array(struct.width * struct.height * RGBA_BPP);

  for (const frame of struct.frames) {
    // 1) 逐帧分别解压（绝不跨帧拼接 zlib 流）
    const total = frame.data.reduce((n, p) => n + p.bytes.length, 0);
    const compressed = new Uint8Array(total);
    let off = 0;
    for (const part of frame.data) {
      compressed.set(part.bytes, off);
      off += part.bytes.length;
    }
    frame.raw = await inflateZlib(compressed, frame);

    // 2) 解滤波还原该帧自己的像素
    const pixels = reconstructFrame(frame);
    const reconstructedSummary = await pixelSummary(`第 ${frame.index + 1} 帧解滤波像素`, pixels);

    // 3) 绘制前完整快照（previous 处置唯一可恢复的数据源）
    const beforePaint = canvas.slice();

    // 4) 按 blend_op 合成到帧区域
    const { xOff, yOff, width: fw, height: fh, disposeOp, blendOp } = frame;
    for (let fy = 0; fy < fh; fy++) {
      for (let fx = 0; fx < fw; fx++) {
        const si = (fy * fw + fx) * RGBA_BPP;
        const di = ((yOff + fy) * struct.width + (xOff + fx)) * RGBA_BPP;
        if (blendOp === 0) {
          canvas[di] = pixels[si];
          canvas[di + 1] = pixels[si + 1];
          canvas[di + 2] = pixels[si + 2];
          canvas[di + 3] = pixels[si + 3];
        } else {
          compositeOver(canvas, di, pixels[si], pixels[si + 1], pixels[si + 2], pixels[si + 3]);
        }
      }
    }

    // 5) 冻结显示快照：帧摘要与帧切换都只能读这份
    const displaySnapshot = canvas.slice();
    const canvasSummary = await pixelSummary(`第 ${frame.index + 1} 帧合成画布`, displaySnapshot);

    // 6) 显示之后再执行处置
    if (disposeOp === 1) {
      // background：帧区域恢复为全透明
      for (let fy = 0; fy < fh; fy++) {
        for (let fx = 0; fx < fw; fx++) {
          const di = ((yOff + fy) * struct.width + (xOff + fx)) * RGBA_BPP;
          canvas[di] = canvas[di + 1] = canvas[di + 2] = canvas[di + 3] = 0;
        }
      }
    } else if (disposeOp === 2) {
      // previous：整画布恢复为绘制前快照
      canvas = beforePaint;
    }

    const delayDen = frame.delayDen === 0 ? 100 : frame.delayDen;
    framesOut.push({
      index: frame.index,
      sequenceNumber: frame.seq,
      control: {
        width: fw,
        height: fh,
        xOffset: xOff,
        yOffset: yOff,
        delayNumerator: frame.delayNum,
        delayDenominator: frame.delayDen,
        delaySeconds: frame.delayNum / delayDen,
        disposeOp,
        dispose: DISPOSE_NAMES[disposeOp],
        blendOp,
        blend: BLEND_NAMES[blendOp],
      },
      dataChunks: frame.data.length,
      dataKind: frame.index === 0 ? 'IDAT' : 'fdAT',
      reconstructed: reconstructedSummary,
      canvas: canvasSummary,
      reconstructedPixels: pixels, // 该帧解滤波后的原始像素（帧区域尺寸，冻结）
      snapshot: displaySnapshot, // 合成画布冻结快照，外部只读
    });
  }

  return {
    ok: true,
    width: struct.width,
    height: struct.height,
    numFrames: struct.frames.length,
    numPlays: struct.numPlays,
    frames: framesOut,
  };
}

export async function reviewBase64(text) {
  const bytes = decodeBase64Input(text);
  return reviewApng(bytes);
}
