import { createHash } from 'node:crypto';

// Stable pixel-canvas summaries used by the review UI.
//
//   sha256  : SHA-256 over raw RGBA bytes (hex), the integrity anchor
//   bytes   : total byte count
//   pixels  : number of non-fully-transparent pixels (alpha > 0)
//   rgbSum  : summed colour load (r+g+b over alpha>0),
//             a cheap, order-independent "how much colour is present" probe
export function summarizePixels(rgba, length = rgba.length) {
  const pixels = length >>> 2;
  let nonEmpty = 0;
  let rgbSum = 0;
  for (let i = 0; i < pixels; i++) {
    const a = rgba[i * 4 + 3];
    if (a !== 0) {
      nonEmpty++;
      rgbSum += rgba[i * 4] + rgba[i * 4 + 1] + rgba[i * 4 + 2];
    }
  }
  const hash = createHash('sha256').update(rgba.subarray(0, length)).digest('hex');
  return { sha256: hash, bytes: length, pixels: nonEmpty, rgbSum };
}

// Digest of an arbitrary byte buffer (e.g. a decompressed zlib stream).
export function sha256Hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}
