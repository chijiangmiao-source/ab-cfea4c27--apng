import zlib from 'node:zlib';
import { crc32 } from '../src/core/crc.mjs';

// Minimal APNG/PNG builder for tests. Frames are drawn by a user function
// (x,y,frameIndex) -> [r,g,b,a]. All frames are RGBA color type 6, 8-bit,
// non-interlaced. Scanlines use filter type 0 by default; a custom per-row
// filter may be injected for unfilter tests.

export function chunk(type, data = Buffer.alloc(0)) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

export function ihdr({
  width,
  height,
  bitDepth = 8,
  colorType = 6,
  compression = 0,
  filter = 0,
  interlace = 0,
}) {
  const b = Buffer.alloc(13);
  b.writeUInt32BE(width, 0);
  b.writeUInt32BE(height, 4);
  b[8] = bitDepth;
  b[9] = colorType;
  b[10] = compression;
  b[11] = filter;
  b[12] = interlace;
  return b;
}

export function fcTL({
  seq,
  width,
  height,
  xOffset = 0,
  yOffset = 0,
  delayNum = 0,
  delayDen = 0,
  disposeOp = 0,
  blendOp = 0,
}) {
  const b = Buffer.alloc(26);
  b.writeUInt32BE(seq, 0);
  b.writeUInt32BE(width, 4);
  b.writeUInt32BE(height, 8);
  b.writeUInt32BE(xOffset, 12);
  b.writeUInt32BE(yOffset, 16);
  b.writeUInt16BE(delayNum, 20);
  b.writeUInt16BE(delayDen, 22);
  b[24] = disposeOp;
  b[25] = blendOp;
  return b;
}

function encodeRegion(width, height, pixelFn, frameIndex, rowFilterFn = null) {
  const stride = width * 4;
  // True unfiltered bytes (which equal correctly reconstructed neighbors).
  const orig = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const px = pixelFn(x, y, frameIndex) ?? [0, 0, 0, 0];
      const o = (y * width + x) * 4;
      orig[o] = px[0] & 0xff;
      orig[o + 1] = px[1] & 0xff;
      orig[o + 2] = px[2] & 0xff;
      orig[o + 3] = px[3] & 0xff;
    }
  }
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    const base = y * (stride + 1);
    const f = rowFilterFn ? rowFilterFn(y, frameIndex) : 0;
    raw[base] = f;
    for (let i = 0; i < stride; i++) {
      const v = orig[y * stride + i];
      const a = i >= 4 ? orig[y * stride + i - 4] : 0;
      const b = y > 0 ? orig[(y - 1) * stride + i] : 0;
      const c = y > 0 && i >= 4 ? orig[(y - 1) * stride + i - 4] : 0;
      let out;
      switch (f) {
        case 0: out = v; break;
        case 1: out = (v - a) & 0xff; break;
        case 2: out = (v - b) & 0xff; break;
        case 3: out = (v - ((a + b) >> 1)) & 0xff; break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          out = (v - pred) & 0xff;
          break;
        }
        default:
          throw new Error(`bad filter ${f}`);
      }
      raw[base + 1 + i] = out;
    }
  }
  return zlib.deflateSync(raw);
}

// Build a complete APNG file.
// frames: [{ width?, height?, xOffset?, yOffset?, delayNum, delayDen,
//            disposeOp, blendOp, pixels(x,y,i)->[r,g,b,a], filters? }]
export function buildAPNG({
  width,
  height,
  frames,
  numPlays = 0,
  ihdrOpts = {},
  actlNumFrames = undefined,
  rowFilters = null,
}) {
  const parts = [Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])];
  parts.push(chunk('IHDR', ihdr({ width, height, ...ihdrOpts })));
  const numFrames = actlNumFrames ?? frames.length;
  const actl = Buffer.alloc(8);
  actl.writeUInt32BE(numFrames, 0);
  actl.writeUInt32BE(numPlays, 4);
  parts.push(chunk('acTL', actl));

  let seq = 0;
  frames.forEach((fr, i) => {
    const fw = fr.width ?? width;
    const fh = fr.height ?? height;
    parts.push(
      chunk(
        'fcTL',
        fcTL({
          seq: seq++,
          width: fw,
          height: fh,
          xOffset: fr.xOffset ?? 0,
          yOffset: fr.yOffset ?? 0,
          delayNum: fr.delayNum ?? 1,
          delayDen: fr.delayDen ?? 10,
          disposeOp: fr.disposeOp ?? 0,
          blendOp: fr.blendOp ?? 0,
        })
      )
    );
    const data = encodeRegion(fw, fh, fr.pixels, i, fr.filters ?? rowFilters ?? null);
    if (i === 0) {
      parts.push(chunk('IDAT', data));
    } else {
      const withSeq = Buffer.alloc(data.length + 4);
      withSeq.writeUInt32BE(seq++, 0);
      data.copy(withSeq, 4);
      parts.push(chunk('fdAT', withSeq));
    }
  });
  parts.push(chunk('IEND'));
  return Buffer.concat(parts);
}

// Corrupt the CRC field of the nth chunk matching `type` (by occurrence).
export function corruptChunkCrc(file, type, occurrence = 0) {
  const out = Buffer.from(file);
  let off = 8;
  let seen = 0;
  while (off < out.length) {
    const len = out.readUInt32BE(off);
    const t = out.toString('ascii', off + 4, off + 8);
    if (t === type && seen++ === occurrence) {
      out[off + 8 + len] ^= 0xff;
      return out;
    }
    off += 12 + len;
  }
  throw new Error(`chunk ${type} not found`);
}

export function findChunkOffset(file, type, occurrence = 0) {
  let off = 8;
  let seen = 0;
  while (off < file.length) {
    const len = file.readUInt32BE(off);
    const t = file.toString('ascii', off + 4, off + 8);
    if (t === type && seen++ === occurrence) return { offset: off, length: len, dataOffset: off + 8 };
    off += 12 + len;
  }
  return null;
}
