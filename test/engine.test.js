import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reviewApng, reviewBase64, APNGError, MAX_INPUT_BYTES } from '../src/apng.js';
import {
  SIGNATURE,
  ihdr,
  actl,
  fctl,
  fdat,
  chunk,
  concat,
  buildApng,
  rawFrame,
  deflate,
  toBase64,
  corruptByte,
} from './fixtures/apng-builder.js';

const RED_128 = [255, 0, 0, 128];
const GREEN_128 = [0, 255, 0, 128];
const BLUE_128 = [0, 0, 255, 128];
const TRANSPARENT = [0, 0, 0, 0];

const u32be = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;

async function expectError(bytes, pattern) {
  await assert.rejects(
    () => reviewApng(bytes),
    (err) => {
      assert.ok(err instanceof APNGError, `期望 APNGError，实际 ${err.constructor.name}: ${err.message}`);
      assert.equal(typeof err.offset, 'number');
      assert.ok(err.offset >= 0, 'offset 必须为非负字节偏移');
      if (pattern) {
        if (pattern instanceof RegExp) assert.match(err.message, pattern);
        else assert.ok(err.message.includes(pattern), `错误信息应包含 "${pattern}"，实际：${err.message}`);
      }
      return true;
    },
  );
}

/* ---------------------------- 正常合成场景 ---------------------------- */

test('两个半透明帧 + 第二帧 over：两帧摘要必须不同', async () => {
  const bytes = buildApng(4, 4, [
    { painter: () => RED_128, blend: 1, dispose: 0 },
    { painter: () => GREEN_128, blend: 1, dispose: 2 },
    { painter: () => TRANSPARENT, blend: 1, dispose: 0 },
  ]);
  const r = await reviewApng(bytes);
  assert.equal(r.numFrames, 3);
  assert.equal(r.width, 4);
  assert.equal(r.height, 4);

  const f1 = r.frames[0];
  const f2 = r.frames[1];
  // 解滤波像素摘要不同
  assert.notEqual(f1.reconstructed.sha256, f2.reconstructed.sha256);
  // over 混合后合成画布摘要不同
  assert.notEqual(f1.canvas.sha256, f2.canvas.sha256);

  // over 混合像素核对：透明底上 over 红半透明
  const p1 = f1.snapshot[3];
  assert.equal(p1, 128, '首帧红 alpha 应为 128');
  assert.equal(f1.snapshot[0], 255);

  // 第二帧在红 128 之上 over 绿 128
  const p2 = f2.snapshot;
  const outA = 128 + (128 * (255 - 128)) / 255; // ≈192
  assert.ok(Math.abs(p2[3] - Math.round(outA)) <= 1, `第二帧合成 alpha 应≈${Math.round(outA)}，实际 ${p2[3]}`);
  // 绿色分量应大于红色分量
  assert.ok(p2[1] > p2[0], 'over 后绿色应主导：G>R');
});

test('第二帧 previous 处置后，第三帧看到的画布恢复为绘制前（首帧）状态', async () => {
  const bytes = buildApng(4, 4, [
    { painter: () => RED_128, blend: 1, dispose: 0 },
    { painter: () => GREEN_128, blend: 1, dispose: 2 },
    { painter: () => TRANSPARENT, blend: 1, dispose: 0 },
  ]);
  const r = await reviewApng(bytes);
  // 第三帧显示快照必须与首帧显示快照逐字节相同（previous 恢复成功）
  assert.deepEqual(Array.from(r.frames[2].snapshot), Array.from(r.frames[0].snapshot));
  assert.equal(r.frames[2].canvas.sha256, r.frames[0].canvas.sha256);
  // 而第二帧快照确实被冻结保留，未被后续处置改写
  assert.notEqual(r.frames[1].canvas.sha256, r.frames[0].canvas.sha256);
});

test('background 处置：帧区域在下一帧绘制前恢复全透明', async () => {
  const bytes = buildApng(4, 4, [
    { painter: () => RED_128, blend: 0, dispose: 1 },
    { painter: () => TRANSPARENT, blend: 1, dispose: 0 },
  ]);
  const r = await reviewApng(bytes);
  const f2 = r.frames[1].snapshot;
  for (let i = 0; i < f2.length; i += 4) {
    assert.equal(f2[i + 3], 0, 'background 处置后第二帧画布应全透明');
  }
});

test('source 混合直接覆盖目标像素（含 alpha）', async () => {
  const bytes = buildApng(2, 2, [
    { painter: () => RED_128, blend: 1, dispose: 0 },
    { painter: () => BLUE_128, blend: 0, dispose: 0 },
  ]);
  const r = await reviewApng(bytes);
  const p = r.frames[1].snapshot;
  assert.equal(p[0], 0);
  assert.equal(p[2], 255);
  assert.equal(p[3], 128, 'source 必须覆盖 alpha，而不是叠加');
});

test('previous 恢复整画布到绘制前（首帧仅部分位置有像素）', async () => {
  // 首帧覆盖全画布但只在左上 2x2 有红色，dispose none；第二帧右上 2x2 画绿 dispose previous；
  // previous 应恢复整画布到“第二帧绘制前”（即只含红）
  const bytes = buildApng(4, 4, [
    { painter: (x, y) => (x < 2 && y < 2 ? RED_128 : TRANSPARENT), blend: 1, dispose: 0 },
    { w: 2, h: 2, x: 2, y: 0, painter: () => GREEN_128, blend: 1, dispose: 2 },
    { painter: () => TRANSPARENT, blend: 1, dispose: 0 },
  ]);
  const r = await reviewApng(bytes);
  const s3 = r.frames[2].snapshot;
  assert.equal(s3[3], 128, '左上红色保留');
  assert.equal(s3[0], 255);
  // 右上起点 (2,0) => index ((0*4+2)*4)=8
  assert.equal(s3[8 + 3], 0, '右上绿色必须被 previous 恢复清除');
});

/* ---------------------------- 五种过滤规则 ---------------------------- */

test('五种 PNG 过滤规则逐行还原结果一致', async () => {
  const painter = (x, y) => [(x * 50) & 0xff, (y * 70) & 0xff, ((x + y) * 30) & 0xff, 100 + ((x * 9 + y * 3) % 100)];
  const filters = [0, 1, 2, 3, 4];
  const shas = new Set();
  for (const f of filters) {
    const bytes = buildApng(8, 5, [{ painter, filterFor: () => f, blend: 0 }]);
    const r = await reviewApng(bytes);
    shas.add(r.frames[0].reconstructed.sha256);
  }
  // 全部五种过滤编码同一图像，解滤波像素摘要必须完全相同
  assert.equal(shas.size, 1, `五种过滤还原结果不一致：${[...shas].join(', ')}`);

  // 同一帧内逐行混用五种过滤器也必须还原
  const bytes = buildApng(8, 5, [{ painter, filterFor: (y) => y % 5, blend: 0 }]);
  const r = await reviewApng(bytes);
  assert.ok(shas.has(r.frames[0].reconstructed.sha256), '混合过滤行也应还原为同一像素结果');

  // 直接核对一个像素
  const snap = r.frames[0].snapshot;
  assert.equal(snap[3], painter(0, 0)[3]);
  assert.equal(snap[(2 * 8 + 3) * 4 + 0], painter(3, 2)[0]);
});

/* ---------------------------- 违约检测：稳定定位首个原始字节错误 ---------------------------- */

test('PNG 签名错误：定位到首个错误字节', async () => {
  const bytes = buildApng(2, 2, [{ painter: () => RED_128 }]);
  bytes[2] = 0x42;
  await expectError(bytes, /签名/);
  try {
    await reviewApng(bytes);
  } catch (e) {
    assert.equal(e.offset, 2, '签名第 3 字节错误必须报告偏移 2');
  }
});

test('块 CRC 错误：偏移指向该块 CRC 首字节，且多次解析稳定', async () => {
  const bytes = buildApng(4, 4, [
    { painter: () => RED_128, dispose: 0 },
    { painter: () => GREEN_128, dispose: 0 },
  ]);
  // 找到第二个 fcTL 之前不损坏数据；改为损坏某块 CRC 的首字节
  // 直接损坏 fdAT 的 CRC 区域：fdAT = 4(seq)+zlen，CRC 在块尾
  const marker = Buffer.from('fdAT');
  const fdatPos = Buffer.from(bytes).indexOf(marker);
  const zlen = u32be(bytes, fdatPos - 4) - 4;
  const crcOff = fdatPos + 4 + 4 + zlen; // type(4) 后 data(4+zlen)
  const bad = corruptByte(bytes, crcOff, 1);
  const offsets = [];
  for (let i = 0; i < 3; i++) {
    try {
      await reviewApng(bad);
      assert.fail('应当抛出 CRC 错误');
    } catch (e) {
      assert.ok(e instanceof APNGError);
      assert.match(e.message, /CRC/);
      offsets.push(e.offset);
    }
  }
  assert.deepEqual(offsets, [crcOff, crcOff, crcOff], '首个 CRC 错误偏移必须稳定');
});

test('fcTL 自身 CRC 错误先于语义检查被报告', async () => {
  const bytes = buildApng(2, 2, [{ painter: () => RED_128 }]);
  const pos = Buffer.from(bytes).indexOf(Buffer.from('fcTL'));
  const len = u32be(bytes, pos - 4);
  const crcOff = pos + 4 + len;
  const bad = corruptByte(bytes, crcOff, 1);
  try {
    await reviewApng(bad);
    assert.fail('应当抛错');
  } catch (e) {
    assert.match(e.message, /fcTL 块 CRC/);
    assert.equal(e.offset, crcOff);
  }
});

test('fdAT 序号跳变：定位到 fdAT sequence_number 字段偏移', async () => {
  // 手工拼三帧，并让第二帧的 fdAT seq 跳号
  const w = 4;
  const h = 4;
  let seq = 0;
  const z = (color) => deflate(rawFrame(w, h, () => color));
  const f0 = fctl({ w, h, seq: seq++ });
  const idat = chunk('IDAT', z(RED_128));
  const f1Ctl = fctl({ w, h, seq: seq++ });
  const f1Data = fdat(z(GREEN_128), 99); // 故意跳变
  const bytes = concat([SIGNATURE, ihdr(w, h), actl(2), f0, idat, f1Ctl, f1Data, chunk('IEND')]);
  // 期望偏移 = fdAT 块数据起点
  const expectedOff = (() => {
    const pos = Buffer.from(bytes).indexOf(Buffer.from('fdAT'));
    return pos + 4;
  })();
  try {
    await reviewApng(bytes);
    assert.fail('应当抛错');
  } catch (e) {
    assert.ok(e instanceof APNGError);
    assert.match(e.message, /sequence_number 跳变/);
    assert.equal(e.offset, expectedOff);
  }
});

test('fcTL 顺序错误：首帧 fcTL 被放到首个 IDAT 之后', async () => {
  const w = 2;
  const h = 2;
  const z = deflate(rawFrame(w, h, () => RED_128));
  const ctl = fctl({ w, h, seq: 0 });
  const bytes = concat([SIGNATURE, ihdr(w, h), actl(1), chunk('IDAT', z), ctl, chunk('IEND')]);
  // 首条错误：IDAT 出现在 fcTL 之前
  const idatPos = Buffer.from(bytes).indexOf(Buffer.from('IDAT'));
  try {
    await reviewApng(bytes);
    assert.fail('应当抛错');
  } catch (e) {
    assert.match(e.message, /fcTL/);
    assert.equal(e.offset, idatPos);
  }
});

test('fcTL sequence_number 不为 0：定位到序号字段', async () => {
  const w = 2;
  const h = 2;
  const badCtl = fctl({ w, h, seq: 5 });
  const bytes = concat([
    SIGNATURE,
    ihdr(w, h),
    actl(1),
    badCtl,
    chunk('IDAT', deflate(rawFrame(w, h, () => RED_128))),
    chunk('IEND'),
  ]);
  const fcPos = Buffer.from(bytes).indexOf(Buffer.from('fcTL'));
  try {
    await reviewApng(bytes);
    assert.fail('应当抛错');
  } catch (e) {
    assert.match(e.message, /sequence_number 错误/);
    assert.equal(e.offset, fcPos + 4);
  }
});

test('acTL 缺失（普通静态 PNG）被拒绝', async () => {
  const w = 2;
  const bytes = concat([
    SIGNATURE,
    ihdr(w, w),
    chunk('IDAT', deflate(rawFrame(w, w, () => RED_128))),
    chunk('IEND'),
  ]);
  await expectError(bytes, 'acTL');
});

test('acTL 声明帧数与实际 fcTL 数量不符', async () => {
  const bytes = buildApng(2, 2, [{ painter: () => RED_128 }]);
  // 把 acTL numFrames 从 1 改为 3（之后需重算 CRC，保持其它校验先通过）
  const pos = Buffer.from(bytes).indexOf(Buffer.from('acTL'));
  const dataStart = pos + 4;
  const fixed = bytes.slice();
  fixed[dataStart] = 0;
  fixed[dataStart + 1] = 0;
  fixed[dataStart + 2] = 0;
  fixed[dataStart + 3] = 3;
  // 重算 CRC
  let crc = 0xffffffff;
  const { CRC_TABLE } = await import('./fixtures/apng-builder.js');
  for (let i = pos; i < dataStart + 8; i++) crc = CRC_TABLE[(crc ^ fixed[i]) & 0xff] ^ (crc >>> 8);
  crc = (crc ^ 0xffffffff) >>> 0;
  fixed[dataStart + 8] = (crc >>> 24) & 0xff;
  fixed[dataStart + 9] = (crc >>> 16) & 0xff;
  fixed[dataStart + 10] = (crc >>> 8) & 0xff;
  fixed[dataStart + 11] = crc & 0xff;
  await expectError(fixed, /声明 3 帧/);
});

test('IDAT 之后再出现 IDAT 归属下一帧被拒绝', async () => {
  const w = 2;
  const h = 2;
  let seq = 0;
  const bytes = concat([
    SIGNATURE,
    ihdr(w, h),
    actl(2),
    fctl({ w, h, seq: seq++ }),
    chunk('IDAT', deflate(rawFrame(w, h, () => RED_128))),
    fctl({ w, h, seq: seq++ }),
    chunk('IDAT', deflate(rawFrame(w, h, () => GREEN_128))), // 必须是 fdAT
    chunk('IEND'),
  ]);
  await expectError(bytes, /不得再出现 IDAT/);
});

test('块被截断：首个原始字节错误定位到截断处', async () => {
  const bytes = buildApng(2, 2, [{ painter: () => RED_128 }]);
  await expectError(bytes.slice(0, 20), /截断|签名/);
});

test('IEND 后多余字节被拒绝并定位', async () => {
  const bytes = buildApng(2, 2, [{ painter: () => RED_128 }]);
  const withTail = concat([bytes, new Uint8Array([0, 0, 0, 1, 0x78])]);
  await expectError(withTail, /IEND 之后/);
});

/* ---------------------------- 格式约束 ---------------------------- */

test('拒绝非 8 位 / 非 RGBA / 交错 PNG', async () => {
  const mk = (opts) =>
    concat([
      SIGNATURE,
      ihdr(2, 2, opts),
      actl(1),
      fctl({ w: 2, h: 2, seq: 0 }),
      chunk('IDAT', deflate(rawFrame(2, 2, () => RED_128))),
      chunk('IEND'),
    ]);
  await expectError(mk({ bitDepth: 16 }), /8 位/);
  await expectError(mk({ colorType: 2 }), /RGBA/);
  await expectError(mk({ interlace: 1 }), /交错/);
});

test('拒绝宽高超过 128', async () => {
  const w = 129;
  const h = 1;
  await expectError(
    concat([
      SIGNATURE,
      ihdr(w, h),
      actl(1),
      fctl({ w, h, seq: 0 }),
      chunk('IDAT', deflate(rawFrame(w, h, () => RED_128))),
      chunk('IEND'),
    ]),
    /128/,
  );
});

test('拒绝超过 8 帧', async () => {
  const w = 1;
  const h = 1;
  let seq = 0;
  const parts = [SIGNATURE, ihdr(w, h), actl(9)];
  for (let i = 0; i < 9; i++) {
    parts.push(fctl({ w, h, seq: seq++ }));
    const z = deflate(rawFrame(w, h, () => RED_128));
    if (i === 0) parts.push(chunk('IDAT', z));
    else parts.push(fdat(z, seq++));
  }
  parts.push(chunk('IEND'));
  await expectError(concat(parts), /8 帧/);
});

test('帧区域越界被拒绝', async () => {
  const bytes = buildApng(4, 4, [
    { w: 4, h: 4, painter: () => RED_128 },
    { w: 4, h: 2, x: 1, y: 3, painter: () => GREEN_128 },
  ]);
  await expectError(bytes, /越界/);
});

test('非法 dispose_op / blend_op 被拒绝', async () => {
  const w = 2;
  const mk = (dispose, blend) => {
    const ctl = fctl({ w, h: w, seq: 0, dispose, blend });
    return concat([
      SIGNATURE,
      ihdr(w, w),
      actl(1),
      ctl,
      chunk('IDAT', deflate(rawFrame(w, w, () => RED_128))),
      chunk('IEND'),
    ]);
  };
  await expectError(mk(3, 1), /dispose_op/);
  await expectError(mk(0, 2), /blend_op/);
});

/* ---------------------------- Base64 输入 ---------------------------- */

test('Base64 长度上限 256 KiB', async () => {
  const over = 'A'.repeat(MAX_INPUT_BYTES + 4);
  await assert.rejects(() => reviewBase64(over), (e) => {
    assert.ok(e instanceof APNGError);
    assert.match(e.message, /256 ?KiB|262144/);
    return true;
  });
});

test('非法 Base64 文本被拒绝；data URL 前缀可接受', async () => {
  const bytes = buildApng(1, 1, [{ painter: () => [10, 20, 30, 40] }]);
  const b64 = toBase64(bytes);
  const r = await reviewBase64(`data:image/png;base64,${b64}`);
  assert.equal(r.numFrames, 1);
  assert.equal(r.frames[0].snapshot[0], 10);
  await assert.rejects(() => reviewBase64('@@@nope'), APNGError);
  await assert.rejects(() => reviewBase64(''), APNGError);
});

test('控制参数完整输出（延时 / 序号 / 块计数 / 处置与混合名称）', async () => {
  const bytes = buildApng(2, 2, [
    { delayNum: 2, delayDen: 10, painter: () => RED_128, blend: 1, dispose: 2 },
  ]);
  const r = await reviewApng(bytes);
  const c = r.frames[0].control;
  assert.equal(c.delayNumerator, 2);
  assert.equal(c.delayDenominator, 10);
  assert.ok(Math.abs(c.delaySeconds - 0.2) < 1e-9);
  assert.equal(c.disposeOp, 2);
  assert.match(c.dispose, /previous/);
  assert.equal(c.blendOp, 1);
  assert.match(c.blend, /over/);
  assert.equal(r.frames[0].dataKind, 'IDAT');
});

test('冻结快照隔离：外部修改返回快照不影响其它帧数据', async () => {
  const bytes = buildApng(2, 2, [
    { painter: () => RED_128, dispose: 0 },
    { painter: () => GREEN_128, dispose: 2 },
    { painter: () => TRANSPARENT },
  ]);
  const r = await reviewApng(bytes);
  const before = Array.from(r.frames[0].snapshot);
  r.frames[1].snapshot[0] = 99;
  r.frames[2].snapshot.fill(7);
  assert.deepEqual(Array.from(r.frames[0].snapshot), before);
});

test('一帧数据跨多个连续 IDAT/fdAT 块时逐帧拼接解压正确', async () => {
  const w = 4;
  const h = 4;
  let seq = 0;
  const split = (u8) => [u8.subarray(0, Math.floor(u8.length / 2)), u8.subarray(Math.floor(u8.length / 2))];
  const z0 = deflate(rawFrame(w, h, () => RED_128));
  const [a0, b0] = split(z0);
  const z1 = deflate(rawFrame(w, h, () => GREEN_128));
  const [a1, b1] = split(z1);
  const bytes = concat([
    SIGNATURE, ihdr(w, h), actl(2),
    fctl({ w, h, seq: seq++ }),
    chunk('IDAT', a0), chunk('IDAT', b0),
    fctl({ w, h, seq: seq++ }),
    fdat(a1, seq++), fdat(b1, seq++),
    chunk('IEND'),
  ]);
  const r = await reviewApng(bytes);
  assert.equal(r.frames[0].dataChunks, 2);
  assert.equal(r.frames[1].dataChunks, 2);
  // 解滤波原帧核对（与混合无关）
  assert.equal(r.frames[0].reconstructedPixels[0], 255);
  assert.equal(r.frames[1].reconstructedPixels[1], 255);
  assert.notEqual(r.frames[0].canvas.sha256, r.frames[1].canvas.sha256);
  // 第二帧 over 于红之上：alpha≈192
  assert.ok(Math.abs(r.frames[1].snapshot[3] - 192) <= 1);
});

test('损坏的帧压缩数据：以帧数据首字节偏移报 zlib 错误', async () => {
  const bytes = buildApng(2, 2, [{ painter: () => RED_128 }]);
  const pos = Buffer.from(bytes).indexOf(Buffer.from('IDAT'));
  const dataStart = pos + 4;
  const bad = bytes.slice();
  bad[dataStart] = 0x00; // CMF=0 非法
  bad[dataStart + 1] = 0x00;
  // CRC 也会失败；先命中 CRC（CRC 覆盖数据），这本身就是“首个原始字节错误”
  try {
    await reviewApng(bad);
    assert.fail('应抛错');
  } catch (e) {
    assert.ok(e instanceof APNGError);
    assert.ok(/CRC|zlib/.test(e.message), `信息：${e.message}`);
  }
});

test('delayDen=0 按 100 处理', async () => {
  const bytes = buildApng(1, 1, [{ delayNum: 5, delayDen: 0, painter: () => RED_128 }]);
  const r = await reviewApng(bytes);
  assert.ok(Math.abs(r.frames[0].control.delaySeconds - 0.05) < 1e-9);
});
