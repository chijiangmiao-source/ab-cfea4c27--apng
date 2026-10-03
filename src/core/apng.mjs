import zlib from 'node:zlib';
import { crc32 } from './crc.mjs';
import { sha256Hex, summarizePixels } from './digest.mjs';

export const MAX_CANVAS = 128;
export const MAX_FRAMES = 8;
export const MAX_INPUT_BYTES = 256 * 1024;

export const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const DISPOSE = ['none', 'background', 'previous'];
const BLEND = ['source', 'over'];

export class APNGError extends Error {
  constructor(code, message, offset, detail = undefined) {
    super(message);
    this.name = 'APNGError';
    this.code = code;
    this.offset = offset; // offset into the submitted byte stream, -1 if n/a
    this.detail = detail;
  }
}

export function adler32(buf, start = 0, end = buf.length) {
  let a = 1;
  let b = 0;
  const MOD = 65521;
  for (let i = start; i < end; i++) {
    a = (a + buf[i]) % MOD;
    b = (b + a) % MOD;
  }
  return ((b << 16) | a) >>> 0;
}

function u32(b, o) {
  return b.readUInt32BE(o);
}

// Strict raw DEFLATE decompression.
//
// Returns { data, consumed } where `consumed` is exactly the number of
// compressed bytes used. If the deflate stream ends before `compressed`
// runs out (trailing garbage), or if it needs more bytes than available
// (truncated), that is reported via TRAILING_GARBAGE / BAD_DEFLATE by
// the caller after length cross-checks.
//
// Node's inflate reports consumption unreliably on truncated streams, so
// we find the minimal prefix that already yields the full output: on a
// complete stream that prefix is the true deflate end position.
function inflateRawAll(compressed) {
  // Default (Z_FINISH) semantics: a prefix that merely contains the full
  // output but lacks the stream's final byte boundary still fails, so the
  // shortest successful prefix is exactly the end of the deflate stream.
  const tryAt = (len) => zlib.inflateRawSync(compressed.subarray(0, len));

  const data = zlib.inflateRawSync(compressed);

  let lo = 1;
  let hi = compressed.length;
  let consumed = hi;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    let ok = null;
    try {
      ok = tryAt(mid);
    } catch {
      ok = null;
    }
    if (ok && ok.length === data.length) {
      consumed = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return { data, consumed };
}

// Per-frame result with frozen pixel buffers (frame switching only reads these).
export async function reviewAPNG(buf) {
  const violations = [];
  const fail = (code, message, offset, detail) => {
    violations.push({ code, message, offset: offset | 0, detail });
  };

  // ---- signature -----------------------------------------------------------
  if (buf.length < PNG_SIGNATURE.length) {
    throw new APNGError('TRUNCATED', '文件短于 PNG 签名长度', 0, {
      have: buf.length,
      need: PNG_SIGNATURE.length,
    });
  }
  for (let i = 0; i < PNG_SIGNATURE.length; i++) {
    if (buf[i] !== PNG_SIGNATURE[i]) {
      throw new APNGError('BAD_SIGNATURE', 'PNG 签名错误（首个错误字节）', i, {
        expected: PNG_SIGNATURE[i],
        actual: buf[i],
      });
    }
  }

  // ---- single forward walk over chunks ------------------------------------
  const chunks = [];
  let off = 8;
  let truncated = null;
  while (off < buf.length) {
    if (buf.length - off < 8) {
      truncated = { code: 'TRUNCATED', message: '块长度/类型字段被截断', offset: off };
      break;
    }
    const length = u32(buf, off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const dataOffset = off + 8;
    const end = dataOffset + length;
    const crcOffset = end;
    if (!/^[A-Za-z]{4}$/.test(type)) {
      fail('BAD_CHUNK_TYPE', `非法块类型 "${type}"`, off + 4);
      break; // cannot trust length for further walking
    }
    if (end + 4 > buf.length) {
      truncated = { code: 'TRUNCATED', message: `块 ${type} 数据或 CRC 越界`, offset: off, length };
      break;
    }

    // CRC covers type bytes + data.
    const want = crc32(buf, off + 4, end);
    const got = buf.readUInt32BE(crcOffset);
    if (want !== got) {
      fail(
        'BAD_CRC',
        `块 ${type} 的 CRC 校验失败（应为 0x${want.toString(16).padStart(8, '0')}，实为 0x${got
          .toString(16)
          .padStart(8, '0')}）`,
        crcOffset,
        { chunk: type }
      );
    }

    chunks.push({ type, offset: off, dataOffset, length, crcOffset });
    off = end + 4;
  }

  // ---- structural / ordering / sequence rules ------------------------------
  let ihdr = null;
  let actl = null;
  let iend = null;
  const fctls = []; // {record, fields}
  const idatList = [];
  const fdatList = []; // {record, seq}
  let firstIdat = null;
  let firstFdat = null;
  let sawIend = false;

  for (let ci = 0; ci < chunks.length; ci++) {
    const c = chunks[ci];

    if (c.type === 'IHDR') {
      if (ci !== 0) fail('ORDER', 'IHDR 必须是第一个块', c.offset);
      if (ihdr) fail('DUP_IHDR', '出现多个 IHDR 块', c.offset);
      if (c.length !== 13) fail('BAD_IHDR', 'IHDR 长度必须为 13', c.offset);
      else {
        ihdr = {
          width: u32(buf, c.dataOffset),
          height: u32(buf, c.dataOffset + 4),
          bitDepth: buf[c.dataOffset + 8],
          colorType: buf[c.dataOffset + 9],
          compression: buf[c.dataOffset + 10],
          filter: buf[c.dataOffset + 11],
          interlace: buf[c.dataOffset + 12],
          offset: c.offset,
        };
      }
      continue;
    }
    if (!ihdr) {
      fail('ORDER', `IHDR 之前出现块 ${c.type}`, c.offset);
    }

    if (sawIend) {
      fail('ORDER', `IEND 之后仍出现块 ${c.type}`, c.offset);
    }

    if (c.type === 'IEND') {
      if (c.length !== 0) fail('BAD_IEND', 'IEND 长度必须为 0', c.offset);
      if (iend) fail('DUP_IEND', '出现多个 IEND 块', c.offset);
      iend = c;
      sawIend = true;
      continue;
    }

    const ancillary = (buf[c.dataOffset - 4] & 0x20) !== 0; // first type letter lowercase

    if (c.type === 'acTL') {
      if (actl) {
        fail('DUP_ACTL', '出现多个 acTL 块', c.offset);
      } else if (c.length !== 8) {
        fail('BAD_ACTL', 'acTL 长度必须为 8', c.offset);
      } else {
        actl = { numFrames: u32(buf, c.dataOffset), numPlays: u32(buf, c.dataOffset + 4), offset: c.offset };
      }
      continue;
    }

    if (c.type === 'fcTL') {
      if (c.length !== 26) {
        fail('BAD_FCTL', `fcTL 长度必须为 26，实为 ${c.length}`, c.offset);
        fctls.push({ record: c, fields: null });
        continue;
      }
      const fields = {
        seq: u32(buf, c.dataOffset),
        width: u32(buf, c.dataOffset + 4),
        height: u32(buf, c.dataOffset + 8),
        xOffset: u32(buf, c.dataOffset + 12),
        yOffset: u32(buf, c.dataOffset + 16),
        delayNum: buf.readUInt16BE(c.dataOffset + 20),
        delayDen: buf.readUInt16BE(c.dataOffset + 22),
        disposeOp: buf[c.dataOffset + 24],
        blendOp: buf[c.dataOffset + 25],
      };
      fctls.push({ record: c, fields });
      continue;
    }

    if (c.type === 'IDAT') {
      if (firstFdat !== null) {
        fail('ORDER', 'IDAT 不得出现在 fdAT 之后', c.offset);
      }
      if (firstIdat === null) firstIdat = c;
      idatList.push(c);
      continue;
    }

    if (c.type === 'fdAT') {
      if (c.length < 4) {
        fail('BAD_FDAT', 'fdAT 长度至少为 4（序号）', c.offset);
        continue;
      }
      if (firstFdat === null) firstFdat = c;
      fdatList.push({ record: c, seq: u32(buf, c.dataOffset) });
      continue;
    }

    // PLTE is allowed (but unused) in color type 6; ignore it.
    if (c.type === 'PLTE') continue;

    if (!ancillary) {
      fail('UNKNOWN_CRITICAL', `不支持的关键块 ${c.type}`, c.offset);
    }
  }

  const earliest = () => {
    const all = truncated ? [...violations, truncated] : violations;
    if (all.length === 0) return null;
    return all.reduce((a, b) => (b.offset < a.offset ? b : a));
  };
  const raise = () => {
    const v = earliest();
    if (v) throw new APNGError(v.code, v.message, v.offset, v.detail);
  };

  // ---- IHDR constraints ----------------------------------------------------
  if (!ihdr) {
    if (!chunks.some((c) => c.type === 'IHDR')) {
      fail('MISSING_IHDR', '缺少 IHDR 块', buf.length);
    }
    raise();
  }
  if (ihdr.width === 0 || ihdr.height === 0) {
    fail('BAD_IHDR', '图像宽高必须大于 0', ihdr.offset + 8);
  }
  if (ihdr.width > MAX_CANVAS || ihdr.height > MAX_CANVAS) {
    fail('BAD_IHDR', `宽高均不得超过 ${MAX_CANVAS} 像素`, ihdr.offset + 8, {
      width: ihdr.width,
      height: ihdr.height,
    });
  }
  if (ihdr.bitDepth !== 8) fail('UNSUPPORTED', `仅接受 8 位图像，实为 ${ihdr.bitDepth} 位`, ihdr.offset + 8 + 8);
  if (ihdr.colorType !== 6) fail('UNSUPPORTED', `仅接受 RGBA（color type 6），实为 ${ihdr.colorType}`, ihdr.offset + 8 + 9);
  if (ihdr.compression !== 0) fail('UNSUPPORTED', '压缩方法必须为 0', ihdr.offset + 8 + 10);
  if (ihdr.filter !== 0) fail('UNSUPPORTED', '滤波方法必须为 0', ihdr.offset + 8 + 11);
  if (ihdr.interlace !== 0) fail('INTERLACED', '不接受交错图像（interlace 必须为 0）', ihdr.offset + 8 + 12);

  if (!iend && !truncated) fail('MISSING_IEND', '缺少 IEND 块', buf.length);

  // ---- APNG scaffolding ----------------------------------------------------
  if (!actl) {
    fail('MISSING_ACTL', '不是 APNG：缺少 acTL 块', chunks[chunks.length - 1]?.offset ?? buf.length);
  } else {
    if (actl.numFrames === 0) fail('BAD_ACTL', 'acTL 声明帧数为 0', actl.offset + 8);
    if (actl.numFrames > MAX_FRAMES) {
      fail('TOO_MANY_FRAMES', `帧数不得超过 ${MAX_FRAMES}（acTL 声明 ${actl.numFrames}）`, actl.offset + 8, {
        numFrames: actl.numFrames,
      });
    }
    if (firstIdat && actl.offset > firstIdat.offset) {
      fail('ORDER', 'acTL 必须出现在第一个 IDAT 之前', actl.offset);
    }
  }
  if (firstIdat === null && !truncated) {
    fail('MISSING_IDAT', '缺少 IDAT 默认图像数据', iend ? iend.offset : buf.length);
  }
  if (fctls.length === 0) {
    fail('MISSING_FCTL', '缺少首帧 fcTL 控制块', firstIdat ? firstIdat.offset : buf.length);
  } else if (firstIdat && fctls[0].record.offset > firstIdat.offset) {
    fail('ORDER', '默认图像的 fcTL 必须出现在第一个 IDAT 之前', fctls[0].record.offset);
  }
  if (fctls.length > MAX_FRAMES) {
    fail('TOO_MANY_FRAMES', `帧数不得超过 ${MAX_FRAMES}（发现 ${fctls.length} 个 fcTL）`, fctls[MAX_FRAMES].record.offset, {
      numFrames: fctls.length,
    });
  }
  if (actl && fctls.length && fctls.length !== actl.numFrames) {
    fail('FRAME_COUNT', `fcTL 数量 ${fctls.length} 与 acTL 声明帧数 ${actl.numFrames} 不一致`, actl.offset + 8);
  }

  // Sequence number space: fcTL + fdAT, in stream order, must be 0,1,2,...
  const seqChunks = [
    ...fctls.filter((f) => f.fields).map((f) => ({ kind: 'fcTL', seq: f.fields.seq, offset: f.record.offset, dataOffset: f.record.dataOffset })),
    ...fdatList.map((f) => ({ kind: 'fdAT', seq: f.seq, offset: f.record.offset, dataOffset: f.record.dataOffset })),
  ].sort((a, b) => a.offset - b.offset);
  seqChunks.forEach((s, i) => {
    if (s.seq !== i) {
      fail(
        'BAD_SEQUENCE',
        `${s.kind} 序号 ${s.seq} 错误（应为 ${i}）：fcTL/fdAT 序号必须从 0 起连续递增`,
        s.dataOffset,
        { seq: s.seq, expected: i }
      );
    }
  });

  // Associate image data with frames while walking fcTL/IDAT/fdAT order.
  //
  // Legal shape:
  //   fcTL(0)  IDAT+  fcTL(1) fdAT+  fcTL(2) fdAT+ ...
  // Any IDAT after the first fcTL...IDAT group, an fdAT with no open
  // frame, or a frame opened by fcTL without any fdAT is an ordering error.
  const laterFrames = []; // {index, fctl, fdats:[]}
  const ordered = chunks
    .filter((c) => c.type === 'fcTL' || c.type === 'fdAT' || c.type === 'IDAT')
    .sort((a, b) => a.offset - b.offset);
  let phase = 'before-default'; // before-default | in-default | frames
  let open = null; // later frame awaiting fdAT bytes
  for (const c of ordered) {
    if (c.type === 'fcTL') {
      const entry = fctls.find((f) => f.record === c);
      if (phase === 'before-default') {
        phase = 'in-default'; // this is the default image's fcTL
      } else if (phase === 'in-default' || phase === 'frames') {
        if (open && open.fdats.length === 0) {
          fail('EMPTY_FRAME', '前一 fcTL 之后没有任何 fdAT 数据', open.fctl.record.offset);
        }
        const rec = { index: laterFrames.length + 1, fctl: entry, fdats: [] };
        laterFrames.push(rec);
        open = rec;
        phase = 'frames';
      }
    } else if (c.type === 'IDAT') {
      if (phase === 'before-default') {
        fail('ORDER', 'IDAT 出现在默认帧 fcTL 之前', c.offset);
        phase = 'in-default';
      } else if (phase === 'frames') {
        fail('ORDER', 'IDAT 只能承载默认图像，却出现在后续帧区域', c.offset);
      }
    } else if (c.type === 'fdAT') {
      const fd = fdatList.find((f) => f.record === c);
      if (phase !== 'frames' || !open) {
        fail('ORDER', 'fdAT 之前缺少打开该帧的 fcTL（或出现在默认图像之前）', c.offset);
      } else {
        open.fdats.push(fd);
      }
    }
  }
  if (open && open.fdats.length === 0) {
    fail('EMPTY_FRAME', `第 ${open.index + 1} 帧只有 fcTL，没有 fdAT 数据`, open.fctl.record.offset);
  }

  raise(); // all structural violations resolved to the earliest byte here

  // ---- fcTL field validation ----------------------------------------------
  const W = ihdr.width;
  const H = ihdr.height;
  fctls.forEach((f, i) => {
    const fld = f.fields;
    if (!fld) return;
    if (fld.disposeOp > 2) {
      fail('BAD_DISPOSE', `非法 dispose_op=${fld.disposeOp}`, f.record.offset + 8 + 24);
    }
    if (fld.blendOp > 1) {
      fail('BAD_BLEND', `非法 blend_op=${fld.blendOp}`, f.record.offset + 8 + 25);
    }
    if (fld.width === 0 || fld.height === 0) {
      fail('BAD_FCTL', '帧区域宽高必须大于 0', f.record.offset + 8 + 4);
    }
    if (
      fld.xOffset + fld.width > W ||
      fld.yOffset + fld.height > H ||
      fld.xOffset >= W ||
      fld.yOffset >= H
    ) {
      fail('BAD_FCTL', '帧区域超出主画布边界', f.record.offset + 8 + 4, {
        region: [fld.xOffset, fld.yOffset, fld.width, fld.height],
        canvas: [W, H],
      });
    }
    if (i === 0 && (fld.xOffset !== 0 || fld.yOffset !== 0 || fld.width !== W || fld.height !== H)) {
      fail('BAD_FCTL', '默认帧必须覆盖整个画布（偏移 0,0 且宽高等于 IHDR）', f.record.offset + 8 + 4);
    }
  });
  raise();

  // ---- assemble per-frame payload spans (logical index -> file offset) ----
  const frame0Spans = idatList.map((r) => ({ fileStart: r.dataOffset, len: r.length, rec: r }));
  const framePayloads = [
    {
      index: 0,
      fctlOffset: fctls[0].record.offset,
      spans: frame0Spans,
      chunks: idatList.map((r) => ({ type: 'IDAT', offset: r.offset, seq: null })),
    },
  ];
  for (const lf of laterFrames) {
    framePayloads.push({
      index: lf.index,
      fctlOffset: lf.fctl.record.offset,
      spans: lf.fdats.map((fd) => ({ fileStart: fd.record.dataOffset + 4, len: fd.record.length - 4, rec: fd.record })),
      chunks: lf.fdats.map((fd) => ({ type: 'fdAT', offset: fd.record.offset, seq: fd.seq })),
    });
  }

  const assemble = (fp) => {
    const parts = fp.spans.map((s) => buf.subarray(s.fileStart, s.fileStart + s.len));
    return { payload: Buffer.concat(parts), spans: fp.spans };
  };
  const mapLogical = (spans, idx) => {
    let acc = 0;
    for (const s of spans) {
      if (idx < acc + s.len) return s.fileStart + (idx - acc);
      acc += s.len;
    }
    return spans[spans.length - 1].fileStart + spans[spans.length - 1].len;
  };

  // ---- per-frame inflate + unfilter + composite ----------------------------
  const canvas = Buffer.alloc(W * H * 4);
  const frames = [];

  for (let fi = 0; fi < framePayloads.length; fi++) {
    const fp = framePayloads[fi];
    const fld = fctls[fi].fields;
    const fw = fld.width;
    const fh = fld.height;
    const fx = fld.xOffset;
    const fy = fld.yOffset;
    const frameOffset = () => fp.fctlOffset;

    const { payload, spans } = assemble(fp);
    // zlib wrapper (RFC 1950): CMF/FLG, no preset dict, Adler-32 trailer.
    if (payload.length < 6) {
      throw new APNGError('BAD_ZLIB', `第 ${fi + 1} 帧 zlib 数据过短`, mapLogical(spans, 0), {
        frame: fi + 1,
      });
    }
    const cmf = payload[0];
    const flg = payload[1];
    if ((cmf & 0x0f) !== 8 || cmf >> 4 > 7) {
      throw new APNGError('BAD_ZLIB', `第 ${fi + 1} 帧 zlib CMF 错误`, mapLogical(spans, 0), {
        frame: fi + 1,
        cmf,
      });
    }
    // (CMF*256 + FLG) must be divisible by 31.
    if ((((cmf << 8) >>> 0) + flg) % 31 !== 0) {
      throw new APNGError('BAD_ZLIB', `第 ${fi + 1} 帧 zlib FCHECK 错误`, mapLogical(spans, 1), {
        frame: fi + 1,
        flg,
      });
    }
    if (flg & 0x20) {
      throw new APNGError('BAD_ZLIB', `第 ${fi + 1} 帧使用了 FDICT 预置字典（不支持）`, mapLogical(spans, 1), {
        frame: fi + 1,
      });
    }

    const deflatePart = payload.subarray(2, payload.length - 4);
    let inflated;
    let consumed = 0;
    try {
      const r = inflateRawAll(deflatePart);
      inflated = r.data;
      consumed = r.consumed;
    } catch (e) {
      throw new APNGError(
        'BAD_DEFLATE',
        `第 ${fi + 1} 帧 DEFLATE 数据流损坏或被截断：${e.message}`,
        mapLogical(spans, deflatePart.length),
        { frame: fi + 1, zlibCode: e.code }
      );
    }
    if (consumed !== deflatePart.length) {
      throw new APNGError(
        'TRAILING_GARBAGE',
        `第 ${fi + 1} 帧压缩流结束后仍有多余字节`,
        mapLogical(spans, 2 + consumed),
        { frame: fi + 1, extra: deflatePart.length - consumed }
      );
    }
    const wantAdler = payload.readUInt32BE(payload.length - 4);
    const gotAdler = adler32(inflated);
    if (wantAdler !== gotAdler) {
      throw new APNGError(
        'BAD_ADLER',
        `第 ${fi + 1} 帧 Adler-32 校验失败（应为 0x${wantAdler.toString(16)}，实为 0x${gotAdler.toString(16)}）`,
        mapLogical(spans, payload.length - 4),
        { frame: fi + 1 }
      );
    }

    const stride = fw * 4;
    const expected = fh * (stride + 1);
    if (inflated.length !== expected) {
      throw new APNGError(
        'BAD_RAW_SIZE',
        `第 ${fi + 1} 帧解压后字节数 ${inflated.length} 与帧区域期望 ${expected} 不符`,
        mapLogical(spans, Math.min(payload.length - 4, Math.max(2, inflated.length))),
        { frame: fi + 1, expected, actual: inflated.length }
      );
    }

    // Reverse the five PNG filters per scanline.
    const region = Buffer.alloc(fh * stride);
    const paeth = (a, b, c) => {
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      if (pa <= pb && pa <= pc) return a;
      if (pb <= pc) return b;
      return c;
    };
    for (let r = 0; r < fh; r++) {
      const srcBase = r * (stride + 1);
      const filter = inflated[srcBase];
      const dstBase = r * stride;
      const prevBase = (r - 1) * stride;
      for (let i = 0; i < stride; i++) {
        const x = inflated[srcBase + 1 + i];
        const a = i >= 4 ? region[dstBase + i - 4] : 0;
        const b = r > 0 ? region[prevBase + i] : 0;
        const c = r > 0 && i >= 4 ? region[prevBase + i - 4] : 0;
        let v;
        switch (filter) {
          case 0: v = x; break;
          case 1: v = x + a; break;
          case 2: v = x + b; break;
          case 3: v = x + ((a + b) >> 1); break;
          case 4: v = x + paeth(a, b, c); break;
          default:
            throw new APNGError(
              'BAD_FILTER',
              `第 ${fi + 1} 帧第 ${r} 行出现非法滤波类型 ${filter}`,
              frameOffset(),
              { frame: fi + 1, row: r, filter }
            );
        }
        region[dstBase + i] = v & 0xff;
      }
    }

    // Snapshot before painting (PREVIOUS disposal restores exactly this).
    const snapshot = Buffer.from(canvas);

    // Blend region into canvas.
    for (let ry = 0; ry < fh; ry++) {
      for (let rx = 0; rx < fw; rx++) {
        const si = (ry * fw + rx) * 4;
        const di = ((fy + ry) * W + (fx + rx)) * 4;
        const sa = region[si + 3];
        if (fld.blendOp === 0) {
          // SOURCE: frame replaces backdrop pixel wholesale.
          canvas[di] = region[si];
          canvas[di + 1] = region[si + 1];
          canvas[di + 2] = region[si + 2];
          canvas[di + 3] = sa;
        } else if (sa === 0) {
          // OVER with fully transparent source: backdrop untouched.
        } else {
          const da = canvas[di + 3];
          const denom = sa * 255 + da * (255 - sa); // outA * 255
          const outA = Math.round(denom / 255);
          for (let k = 0; k < 3; k++) {
            const num = region[si + k] * sa * 255 + canvas[di + k] * da * (255 - sa);
            canvas[di + k] = denom === 0 ? 0 : Math.round(num / denom) & 0xff;
          }
          canvas[di + 3] = outA & 0xff;
        }
      }
    }

    // Freeze the displayed canvas for this frame; switching reads only these.
    const display = Buffer.from(canvas);

    // Disposal, applied after display snapshot.
    if (fld.disposeOp === 1) {
      for (let ry = 0; ry < fh; ry++) {
        for (let rx = 0; rx < fw; rx++) {
          const di = ((fy + ry) * W + (fx + rx)) * 4;
          canvas[di] = canvas[di + 1] = canvas[di + 2] = canvas[di + 3] = 0;
        }
      }
    } else if (fld.disposeOp === 2) {
      canvas.set(snapshot);
    }

    const den = fld.delayDen === 0 ? 100 : fld.delayDen;
    frames.push({
      index: fi,
      control: {
        sequenceNumber: fld.seq,
        width: fw,
        height: fh,
        xOffset: fx,
        yOffset: fy,
        delayNum: fld.delayNum,
        delayDen: fld.delayDen,
        delayMs: den === 0 ? 0 : Math.round((fld.delayNum / den) * 1000),
        disposeOp: fld.disposeOp,
        dispose: DISPOSE[fld.disposeOp],
        blendOp: fld.blendOp,
        blend: BLEND[fld.blendOp],
        fcTlOffset: fp.fctlOffset,
      },
      dataChunks: fp.chunks,
      decodedRegion: {
        width: fw,
        height: fh,
        summary: summarizePixels(region),
        bytes: region,
      },
      composedCanvas: {
        width: W,
        height: H,
        summary: summarizePixels(display),
        bytes: display,
      },
    });
  }

  return {
    width: W,
    height: H,
    numFrames: actl.numFrames,
    numPlays: actl.numPlays,
    ihdr,
    inputSha256: sha256Hex(buf),
    frames,
  };
}
