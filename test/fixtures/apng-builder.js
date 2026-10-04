// 测试夹具：纯手工拼装 PNG/APNG（含正确 CRC），用于构造合法样本与各类违约样本。
import zlib from 'node:zlib';

export const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const enc = new TextEncoder();

export function chunk(type, data) {
  const typeBytes = enc.encode(type);
  const d = data ?? new Uint8Array(0);
  const len = d.length;
  const out = new Uint8Array(12 + d.length);
  out[0] = (len >>> 24) & 0xff;
  out[1] = (len >>> 16) & 0xff;
  out[2] = (len >>> 8) & 0xff;
  out[3] = len & 0xff;
  out.set(typeBytes, 4);
  out.set(d, 8);
  const crc = crc32(out.subarray(4, 8 + d.length));
  out[8 + d.length] = (crc >>> 24) & 0xff;
  out[8 + d.length + 1] = (crc >>> 16) & 0xff;
  out[8 + d.length + 2] = (crc >>> 8) & 0xff;
  out[8 + d.length + 3] = crc & 0xff;
  return out;
}

export function concat(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export const SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

export function ihdr(w, h, { bitDepth = 8, colorType = 6, interlace = 0 } = {}) {
  const d = new Uint8Array(13);
  const dv = new DataView(d.buffer);
  dv.setUint32(0, w);
  dv.setUint32(4, h);
  d[8] = bitDepth;
  d[9] = colorType;
  d[10] = 0;
  d[11] = 0;
  d[12] = interlace;
  return chunk('IHDR', d);
}

export function actl(numFrames, numPlays = 0) {
  const d = new Uint8Array(8);
  new DataView(d.buffer).setUint32(0, numFrames);
  new DataView(d.buffer).setUint32(4, numPlays);
  return chunk('acTL', d);
}

let SEQ = 0;
export function resetSeq(v = 0) {
  SEQ = v;
}

export function fctl({
  w,
  h,
  x = 0,
  y = 0,
  delayNum = 0,
  delayDen = 100,
  dispose = 0,
  blend = 1,
  seq = SEQ++,
}) {
  const d = new Uint8Array(26);
  const dv = new DataView(d.buffer);
  dv.setUint32(0, seq);
  dv.setUint32(4, w);
  dv.setUint32(8, h);
  dv.setUint32(12, x);
  dv.setUint32(16, y);
  dv.setUint16(20, delayNum);
  dv.setUint16(22, delayDen);
  d[24] = dispose;
  d[25] = blend;
  return chunk('fcTL', d);
}

export function fdat(data, seq = SEQ++) {
  const d = new Uint8Array(4 + data.length);
  new DataView(d.buffer).setUint32(0, seq);
  d.set(data, 4);
  return chunk('fdAT', d);
}

// 生成一帧 RGBA 图像；filterFor(y) 选择该行过滤器（0..4），用于检验五种解滤波路径
export function rawFrame(w, h, painter, filterFor = () => 0) {
  const bpp = 4;
  const stride = w * bpp;
  const out = new Uint8Array((stride + 1) * h);
  const raw = new Uint8Array(stride * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const px = painter ? painter(x, y) : [0, 0, 0, 0];
      raw.set(px, y * stride + x * 4);
    }
  }
  for (let y = 0; y < h; y++) {
    const f = filterFor(y);
    const rowOff = y * (stride + 1);
    out[rowOff] = f;
    for (let x = 0; x < stride; x++) {
      const v = raw[y * stride + x];
      const a = x >= bpp ? raw[y * stride + x - bpp] : 0;
      const b = y > 0 ? raw[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? raw[(y - 1) * stride + x - bpp] : 0;
      const paeth = (() => {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        if (pa <= pb && pa <= pc) return a;
        if (pb <= pc) return b;
        return c;
      })();
      let filtered = v;
      if (f === 1) filtered = v - a;
      else if (f === 2) filtered = v - b;
      else if (f === 3) filtered = v - ((a + b) >> 1);
      else if (f === 4) filtered = v - paeth;
      out[rowOff + 1 + x] = filtered & 0xff;
    }
  }
  return out;
}

export function deflate(bytes) {
  return new Uint8Array(zlib.deflateSync(Buffer.from(bytes)));
}

// 便捷构造：frames = [{w,h,x,y,dispose,blend,painter,delayNum,delayDen}]
export function buildApng(width, height, frameSpecs, parts = []) {
  resetSeq();
  const body = [SIGNATURE, ihdr(width, height), actl(frameSpecs.length)];
  body.push(...parts);
  frameSpecs.forEach((f, i) => {
    body.push(
      fctl({
        w: f.w ?? width,
        h: f.h ?? height,
        x: f.x ?? 0,
        y: f.y ?? 0,
        dispose: f.dispose ?? 0,
        blend: f.blend ?? 1,
        delayNum: f.delayNum ?? 1,
        delayDen: f.delayDen ?? 10,
      }),
    );
    const raw = rawFrame(f.w ?? width, f.h ?? height, f.painter, f.filterFor ?? (() => 0));
    const z = deflate(raw);
    if (i === 0) body.push(chunk('IDAT', z));
    else body.push(fdat(z));
  });
  body.push(chunk('IEND'));
  return concat(body);
}

export function toBase64(bytes) {
  return Buffer.from(bytes).toString('base64');
}

export function corruptByte(bytes, offset, delta = 1) {
  const out = bytes.slice();
  out[offset] = (out[offset] + delta) & 0xff;
  return out;
}
