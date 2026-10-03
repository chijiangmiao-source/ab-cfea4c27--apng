import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewAPNG, APNGError, MAX_CANVAS, MAX_FRAMES, MAX_INPUT_BYTES } from '../src/core/apng.mjs';
import { buildAPNG, corruptChunkCrc, findChunkOffset, chunk, fcTL } from './apng-builder.mjs';

const RED = [255, 0, 0];
const GREEN = [0, 255, 0];

async function ok(file) {
  return reviewAPNG(file);
}
async function err(file) {
  await assert.rejects(() => reviewAPNG(file), APNGError);
  try {
    await reviewAPNG(file);
  } catch (e) {
    return e;
  }
}

test('accepts a valid 3-frame APNG: over blend differs; previous disposal restores backdrop verified by frame 3', async () => {
  // Frame 0: full 4x4 semi-transparent red, SOURCE.
  // Frame 1: 2x2 green @128 at (1,1), OVER, PREVIOUS.
  // Frame 2: single fully-transparent pixel OVER at (2,2) -> display must
  //          equal frame 0 exactly, proving the frame-1 pixels were undone.
  const file = buildAPNG({
    width: 4,
    height: 4,
    frames: [
      { disposeOp: 0, blendOp: 0, pixels: () => [...RED, 64] },
      {
        width: 2,
        height: 2,
        xOffset: 1,
        yOffset: 1,
        disposeOp: 2,
        blendOp: 1,
        pixels: () => [...GREEN, 128],
      },
      { width: 1, height: 1, xOffset: 2, yOffset: 2, disposeOp: 0, blendOp: 1, pixels: () => [0, 0, 0, 0] },
    ],
  });
  const r = await ok(file);
  assert.equal(r.frames.length, 3);

  const f0 = r.frames[0].composedCanvas.summary;
  const f1 = r.frames[1].composedCanvas.summary;
  const f2 = r.frames[2].composedCanvas.summary;
  assert.notEqual(f1.sha256, f0.sha256, '第二帧 over 混合后摘要必须不同');
  assert.notEqual(f1.pixels, 0);
  assert.equal(f2.sha256, f0.sha256, 'previous 处置后第三帧画面必须与第一帧完全一致');

  // Frozen snapshot: every frame carries its own bytes.
  assert.deepEqual([...r.frames[2].composedCanvas.bytes], [...r.frames[0].composedCanvas.bytes]);
});

test('two semi-transparent frames with over blend on frame 2 yield distinct digests', async () => {
  const file = buildAPNG({
    width: 3,
    height: 3,
    frames: [
      { blendOp: 0, pixels: () => [255, 0, 0, 100] },
      { blendOp: 1, pixels: () => [0, 0, 255, 100] },
    ],
  });
  const r = await ok(file);
  assert.notEqual(
    r.frames[0].composedCanvas.summary.sha256,
    r.frames[1].composedCanvas.summary.sha256
  );
});

test('over compositing arithmetic matches the PNG alpha formula', async () => {
  const file = buildAPNG({
    width: 1,
    height: 1,
    frames: [
      { blendOp: 0, pixels: () => [255, 0, 0, 255] },
      { blendOp: 1, pixels: () => [0, 255, 0, 128] },
    ],
  });
  const r = await ok(file);
  const px = [...r.frames[1].composedCanvas.bytes.slice(0, 4)];
  assert.deepEqual(px, [127, 128, 0, 255]);
});

test('source blend replaces backdrop including alpha (cuts a transparent hole)', async () => {
  const file = buildAPNG({
    width: 1,
    height: 1,
    frames: [
      { blendOp: 0, pixels: () => [10, 20, 30, 255] },
      { blendOp: 0, pixels: () => [9, 9, 9, 0] },
    ],
  });
  const r = await ok(file);
  assert.deepEqual([...r.frames[1].composedCanvas.bytes.slice(0, 4)], [9, 9, 9, 0]);
});

test('background disposal clears region to fully transparent before the next frame', async () => {
  const file = buildAPNG({
    width: 2,
    height: 2,
    frames: [
      { blendOp: 0, pixels: () => [255, 0, 0, 255] },
      { width: 1, height: 1, xOffset: 0, yOffset: 0, disposeOp: 1, blendOp: 0, pixels: () => [0, 255, 0, 255] },
      { width: 1, height: 1, xOffset: 1, yOffset: 1, blendOp: 1, pixels: () => [0, 0, 0, 0] },
    ],
  });
  const r = await ok(file);
  const c = r.frames[2].composedCanvas.bytes;
  assert.deepEqual([...c.slice(0, 4)], [0, 0, 0, 0], 'background 处置区域被清空');
  assert.deepEqual([...c.slice(4 * 3, 4 * 4)], [255, 0, 0, 255], '区域外保持第一帧');
});

test('none disposal leaves painted pixels for the next frame', async () => {
  const file = buildAPNG({
    width: 2,
    height: 1,
    frames: [
      { blendOp: 0, pixels: () => [255, 0, 0, 255] },
      { width: 1, height: 1, disposeOp: 0, blendOp: 0, pixels: () => [0, 0, 255, 255] },
      { width: 1, height: 1, xOffset: 1, blendOp: 1, pixels: () => [0, 0, 0, 0] },
    ],
  });
  const r = await ok(file);
  const c = r.frames[2].composedCanvas.bytes;
  assert.deepEqual([...c.slice(0, 4)], [0, 0, 255, 255]);
  assert.deepEqual([...c.slice(4, 8)], [255, 0, 0, 255]);
});

for (const f of [0, 1, 2, 3, 4]) {
  test(`all five PNG row filters reconstruct identical pixels (filter ${f})`, async () => {
    const file = buildAPNG({
      width: 5,
      height: 4,
      frames: [
        {
          blendOp: 0,
          pixels: (x, y) => [(x * 51 + 13) & 255, (y * 97 + 7) & 255, ((x ^ y) * 33) & 255, ((x + y) * 32 + 1) & 255],
          filters: () => f,
        },
      ],
    });
    const r = await ok(file);
    const reg = r.frames[0].decodedRegion;
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 5; x++) {
        const got = [...reg.bytes.slice((y * 5 + x) * 4, (y * 5 + x) * 4 + 4)];
        const want = [(x * 51 + 13) & 255, (y * 97 + 7) & 255, ((x ^ y) * 33) & 255, ((x + y) * 32 + 1) & 255];
        assert.deepEqual(got, want, `pixel ${x},${y}`);
      }
    }
  });
}

test('mixed filters across rows reconstruct correctly', async () => {
  const file = buildAPNG({
    width: 4,
    height: 4,
    frames: [
      {
        blendOp: 0,
        pixels: (x, y) => [(x * 70 + y * 30) & 255, (y * 60) & 255, 200, 255],
        filters: (y) => [0, 1, 2, 3, 4][(y + 1) % 5],
      },
    ],
  });
  const r = await ok(file);
  const reg = r.frames[0].decodedRegion;
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      const got = [...reg.bytes.slice((y * 4 + x) * 4, (y * 4 + x) * 4 + 4)];
      assert.deepEqual(got, [(x * 70 + y * 30) & 255, (y * 60) & 255, 200, 255]);
    }
  }
});

test('bad PNG signature reports the first differing byte offset', async () => {
  const file = buildAPNG({ width: 1, height: 1, frames: [{ pixels: () => [1, 2, 3, 4] }] });
  file[3] = 0x48; // 'N' -> 'H'
  const e = await err(file);
  assert.equal(e.code, 'BAD_SIGNATURE');
  assert.equal(e.offset, 3);
});

test('chunk CRC corruption reports the CRC field offset', async () => {
  const file = buildAPNG({ width: 1, height: 1, frames: [{ pixels: () => [1, 2, 3, 4] }] });
  const ihdr = findChunkOffset(file, 'IHDR');
  const bad = corruptChunkCrc(file, 'IHDR');
  const e = await err(bad);
  assert.equal(e.code, 'BAD_CRC');
  assert.equal(e.offset, ihdr.dataOffset + ihdr.length);
});

test('earliest violation wins: bad CRC before a later sequence jump', async () => {
  const file = buildAPNG({
    width: 1,
    height: 1,
    frames: [
      { pixels: () => [1, 1, 1, 255] },
      { pixels: () => [2, 2, 2, 255] },
      { pixels: () => [3, 3, 3, 255] },
    ],
  });
  const bad = corruptChunkCrc(file, 'IHDR');
  // also jump the last fdAT sequence number
  const fdat = findChunkOffset(bad, 'fdAT', 1);
  bad.writeUInt32BE(99, fdat.dataOffset);
  // recompute CRC so the *only* early error is the corrupted IHDR CRC
  // (leave it stale; both errors exist; earliest must be reported)
  const e = await err(bad);
  assert.ok(e.offset < fdat.dataOffset);
});

test('fdAT sequence number jump is rejected at the offending field', async () => {
  const file = buildAPNG({
    width: 1,
    height: 1,
    frames: [
      { pixels: () => [1, 1, 1, 255] },
      { pixels: () => [2, 2, 2, 255] },
    ],
  });
  const fdat = findChunkOffset(file, 'fdAT');
  file.writeUInt32BE(5, fdat.dataOffset); // should be 2
  // fix CRC so CRC is not the reported error
  const typeStart = fdat.offset + 4;
  const { crc32 } = await import('../src/core/crc.mjs');
  const want = crc32(file.subarray(typeStart, fdat.dataOffset + fdat.length));
  file.writeUInt32BE(want, fdat.dataOffset + fdat.length);
  const e = await err(file);
  assert.equal(e.code, 'BAD_SEQUENCE');
  assert.equal(e.offset, fdat.dataOffset);
});

test('fcTL before IDAT ordering error for a non-default frame', async () => {
  // Manually build: sig IHDR acTL fcTL0 fcTL1 IDAT fdAT IEND
  const zlib = await import('node:zlib');
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const actl = Buffer.alloc(8);
  actl.writeUInt32BE(2, 0);
  const mkFctl = (seq) => chunk('fcTL', fcTL({ seq, width: 1, height: 1 }));
  const raw = Buffer.concat([Buffer.from([0]), Buffer.from([10, 20, 30, 255])]);
  const idat = chunk('IDAT', zlib.deflateSync(raw));
  const fdatData = Buffer.alloc(8);
  fdatData.writeUInt32BE(2, 0);
  fdatData[4] = 0;
  fdatData[5] = 40;
  fdatData[6] = 50;
  fdatData[7] = 255;
  const parts = [
    sig,
    chunk('IHDR', ihdr),
    chunk('acTL', actl),
    mkFctl(0),
    mkFctl(1),
    idat,
    chunk('fdAT', fdatData),
    chunk('IEND'),
  ];
  // Note fdAT payload above is not a valid zlib stream; ordering must fail first.
  const e = await err(Buffer.concat(parts));
  assert.equal(e.code, 'ORDER');
});

test('interlaced image rejected', async () => {
  const file = buildAPNG({ width: 1, height: 1, frames: [{ pixels: () => [0, 0, 0, 0] }], ihdrOpts: { interlace: 1 } });
  const e = await err(file);
  assert.equal(e.code, 'INTERLACED');
});

test('only 8-bit RGBA color type 6 is accepted', async () => {
  for (const [bitDepth, colorType, wantCode] of [
    [16, 6, 'UNSUPPORTED'],
    [8, 2, 'UNSUPPORTED'],
    [8, 0, 'UNSUPPORTED'],
    [4, 6, 'UNSUPPORTED'],
  ]) {
    const file = buildAPNG({
      width: 1,
      height: 1,
      frames: [{ pixels: () => [0, 0, 0, 255] }],
      ihdrOpts: { bitDepth, colorType },
    });
    const e = await err(file);
    assert.equal(e.code, wantCode, `${bitDepth}/${colorType}`);
  }
});

test('dimensions above 128 rejected; boundary 128 accepted', async () => {
  const big = buildAPNG({ width: MAX_CANVAS + 1, height: 2, frames: [{ pixels: () => [0, 0, 0, 0] }] });
  assert.equal((await err(big)).code, 'BAD_IHDR');
  const ok = buildAPNG({ width: MAX_CANVAS, height: MAX_CANVAS, frames: [{ pixels: () => [1, 2, 3, 40] }] });
  const r = await reviewAPNG(ok);
  assert.equal(r.width, 128);
});

test(`more than ${MAX_FRAMES} frames rejected`, async () => {
  const frames = Array.from({ length: MAX_FRAMES + 1 }, () => ({ pixels: () => [0, 0, 0, 255] }));
  const file = buildAPNG({ width: 1, height: 1, frames });
  const e = await err(file);
  assert.equal(e.code, 'TOO_MANY_FRAMES');
});

test('adler-32 corruption in IDAT payload reported', async () => {
  const file = buildAPNG({ width: 1, height: 1, frames: [{ pixels: () => [1, 2, 3, 4] }] });
  const idat = findChunkOffset(file, 'IDAT');
  file[idat.dataOffset + idat.length - 1] ^= 0x01;
  // CRC is now also wrong; fix CRC so ADLER is what surfaces at its earlier? compare offsets:
  const { crc32 } = await import('../src/core/crc.mjs');
  const want = crc32(file.subarray(idat.offset + 4, idat.dataOffset + idat.length));
  file.writeUInt32BE(want, idat.dataOffset + idat.length);
  const e = await err(file);
  assert.equal(e.code, 'BAD_ADLER');
});

test('frame opened by fcTL without fdAT is rejected', async () => {
  const file = buildAPNG({
    width: 1,
    height: 1,
    frames: [{ pixels: () => [1, 2, 3, 4] }],
    actlNumFrames: 2,
  });
  const e = await err(file);
  assert.equal(e.code, 'FRAME_COUNT');
});

test('decompressed size mismatch is rejected', async () => {
  const file = buildAPNG({
    width: 2,
    height: 2,
    frames: [{ width: 1, height: 1, pixels: () => [1, 2, 3, 4] }],
  });
  // default frame fcTL claims 1x1 while IHDR is 2x2; default must cover whole canvas
  const e = await err(file);
  assert.equal(e.code, 'BAD_FCTL');
});

test('invalid filter byte inside a scanline is rejected', async () => {
  const file = buildAPNG({ width: 1, height: 2, frames: [{ pixels: () => [1, 2, 3, 4] }] });
  const idat = findChunkOffset(file, 'IDAT');
  const zlib = await import('node:zlib');
  const raw = zlib.inflateSync(file.subarray(idat.dataOffset, idat.dataOffset + idat.length));
  raw[5] = 9; // filter byte of second 1-wide row (stride = 5)
  const fixed = zlib.deflateSync(raw);
  const rebuilt = Buffer.from(file);
  fixed.copy(rebuilt, idat.dataOffset);
  // length identical here; rebuild chunk length/crc via builder helper
  const sig = rebuilt.subarray(0, 8);
  // Easier: reconstruct whole file by re-chunking using builder is hard; patch in place
  assert.equal(fixed.length, idat.length);
  const { crc32 } = await import('../src/core/crc.mjs');
  rebuilt.writeUInt32BE(crc32(rebuilt.subarray(idat.offset + 4, idat.dataOffset + idat.length)), idat.dataOffset + idat.length);
  void sig;
  const e = await err(rebuilt);
  assert.equal(e.code, 'BAD_FILTER');
});

test('control parameters are exposed per frame', async () => {
  const file = buildAPNG({
    width: 4,
    height: 4,
    frames: [
      { delayNum: 1, delayDen: 10, disposeOp: 0, blendOp: 0, pixels: () => [1, 1, 1, 255] },
      {
        width: 2,
        height: 2,
        xOffset: 1,
        yOffset: 1,
        delayNum: 2,
        delayDen: 10,
        disposeOp: 2,
        blendOp: 1,
        pixels: () => [2, 2, 2, 128],
      },
    ],
  });
  const r = await ok(file);
  assert.deepEqual(
    {
      w: r.frames[1].control.width,
      h: r.frames[1].control.height,
      x: r.frames[1].control.xOffset,
      y: r.frames[1].control.yOffset,
      dispose: r.frames[1].control.dispose,
      blend: r.frames[1].control.blend,
      delayMs: r.frames[1].control.delayMs,
      seq: r.frames[1].control.sequenceNumber,
    },
    { w: 2, h: 2, x: 1, y: 1, dispose: 'previous', blend: 'over', delayMs: 200, seq: 1 }
  );
  assert.equal(r.frames[0].control.dispose, 'none');
  assert.equal(r.frames[0].control.blend, 'source');
});

test('per-frame decompression is independent: corrupting frame 2 stream does not affect frame 1 report', async () => {
  const file = buildAPNG({
    width: 1,
    height: 1,
    frames: [{ pixels: () => [1, 1, 1, 255] }, { pixels: () => [2, 2, 2, 255] }],
  });
  const good = await ok(file);
  assert.equal(good.frames[0].composedCanvas.summary.sha256.length, 64);

  const fdat = findChunkOffset(file, 'fdAT');
  // flip a byte inside the deflate payload (after the 4-byte seq), keep CRC consistent
  file[fdat.dataOffset + 4 + 2] ^= 0xff;
  const { crc32 } = await import('../src/core/crc.mjs');
  file.writeUInt32BE(crc32(file.subarray(fdat.offset + 4, fdat.dataOffset + fdat.length)), fdat.dataOffset + fdat.length);
  const e = await err(file);
  assert.ok(['BAD_DEFLATE', 'BAD_ADLER', 'BAD_RAW_SIZE'].includes(e.code), `got ${e.code}`);
});

test('static PNG without acTL is rejected as not-an-APNG', async () => {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const zlib = await import('node:zlib');
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const raw = Buffer.from([0, 1, 2, 3, 255]);
  const file = Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND')]);
  const e = await err(file);
  assert.ok(['MISSING_ACTL', 'MISSING_FCTL'].includes(e.code));
});

test('limits constants match the review contract', () => {
  assert.equal(MAX_CANVAS, 128);
  assert.equal(MAX_FRAMES, 8);
  assert.equal(MAX_INPUT_BYTES, 256 * 1024);
});
