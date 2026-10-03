// HTTP smoke test:
//   GET  /healthz  -> 200 JSON ok
//   GET  /         -> 200 HTML containing the review UI
//   POST /api/review with a valid APNG -> 200, distinct over-frame digest,
//        previous disposal verified by frame 3
//   POST /api/review with a CRC-corrupted APNG -> 422, offset reported
// Exits non-zero on any failure.
import { spawn } from 'node:child_process';
import { buildAPNG, corruptChunkCrc } from '../tests/apng-builder.mjs';

const BASE_URL = process.env.BASE_URL;
const PORT = process.env.SMOKE_PORT || String(8080 + Math.floor(Math.random() * 1000));

let child = null;
let baseUrl = BASE_URL;

function waitForHealth(url, deadlineMs = 15000) {
  const deadline = Date.now() + deadlineMs;
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const r = await fetch(url);
        if (r.ok) return resolve();
      } catch {
        // retry
      }
      if (Date.now() > deadline) return reject(new Error(`server did not become healthy at ${url}`));
      setTimeout(tick, 150);
    };
    tick();
  });
}

async function startLocal() {
  if (BASE_URL) {
    baseUrl = BASE_URL.replace(/\/$/, '');
    return;
  }
  baseUrl = `http://127.0.0.1:${PORT}`;
  child = spawn(process.execPath, ['src/server/server.mjs'], {
    env: { ...process.env, PORT, HOST: '127.0.0.1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', () => {});
  child.stderr.on('data', (d) => process.stderr.write(d));
  await waitForHealth(`${baseUrl}/healthz`);
}

let failures = 0;
function check(name, cond, extra = '') {
  if (cond) {
    console.log(`  ok - ${name}`);
  } else {
    failures++;
    console.error(`  FAIL - ${name} ${extra}`);
  }
}

async function main() {
  await startLocal();
  console.log(`smoke target: ${baseUrl}`);

  // 1. /healthz
  {
    const r = await fetch(`${baseUrl}/healthz`);
    const j = await r.json();
    check('GET /healthz 返回 200', r.status === 200, `status=${r.status}`);
    check('GET /healthz status=ok', j.status === 'ok', JSON.stringify(j));
  }

  // 2. index page
  {
    const r = await fetch(`${baseUrl}/`);
    const body = await r.text();
    check('GET / 返回 200', r.status === 200, `status=${r.status}`);
    check('页面含 APNG 复核台标题', body.includes('APNG 复核台'));
    check('页面含提交/清空按钮', body.includes('id="submit"') && body.includes('id="clear"'));
    check('页面加载 app.js', body.includes('./app.js'));
    const js = await fetch(`${baseUrl}/app.js`);
    check('app.js 可访问且非空', js.status === 200 && (await js.text()).length > 100);
  }

  // 3. valid APNG review
  const good = buildAPNG({
    width: 4,
    height: 4,
    frames: [
      { disposeOp: 0, blendOp: 0, pixels: () => [255, 0, 0, 64] },
      {
        width: 2, height: 2, xOffset: 1, yOffset: 1,
        disposeOp: 2, blendOp: 1, pixels: () => [0, 255, 0, 128],
      },
      { width: 1, height: 1, xOffset: 2, yOffset: 2, blendOp: 1, pixels: () => [0, 0, 0, 0] },
    ],
  });
  {
    const r = await fetch(`${baseUrl}/api/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ base64: good.toString('base64') }),
    });
    const j = await r.json();
    check('合法 APNG 返回 200', r.status === 200, `status=${r.status} ${JSON.stringify(j.error || '')}`);
    check('复核 ok=true', j.ok === true);
    check('识别为 3 帧', j.numFrames === 3);
    check(
      '半透明 over 第二帧摘要与首帧不同',
      j.frames?.[1]?.composedCanvas?.summary?.sha256 !== j.frames?.[0]?.composedCanvas?.summary?.sha256
    );
    check(
      'previous 处置后第三帧恢复背景（摘要等于首帧）',
      j.frames?.[2]?.composedCanvas?.summary?.sha256 === j.frames?.[0]?.composedCanvas?.summary?.sha256
    );
    check('每帧附带冻结快照 PNG', j.frames?.every((f) => f.composedCanvas.png.startsWith('data:image/png')));
    check('第二帧控制参数 over/previous', j.frames?.[1]?.control?.blend === 'over' && j.frames?.[1]?.control?.dispose === 'previous');
  }

  // 4. CRC corruption
  const bad = corruptChunkCrc(good, 'IHDR');
  {
    const r = await fetch(`${baseUrl}/api/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ base64: bad.toString('base64') }),
    });
    const j = await r.json();
    check('CRC 错误返回 422', r.status === 422, `status=${r.status}`);
    check('错误码 BAD_CRC 且保留输入', j.ok === false && j.error?.code === 'BAD_CRC' && j.retained === true);
    check('报告首个违约偏移（非负数字）', Number.isInteger(j.error?.offset) && j.error.offset >= 0, JSON.stringify(j.error));
    check('清除旧成功证据标记', j.clearedEvidence === true);
  }

  // 5. malformed base64
  {
    const r = await fetch(`${baseUrl}/api/review`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ base64: '!!!not-base64!!!' }),
    });
    const j = await r.json();
    check('非法 Base64 返回 400 与字符偏移', r.status === 400 && j.error?.code === 'BAD_BASE64' && j.error.offset === 0);
  }
}

main()
  .then(() => {
    if (child) child.kill();
    if (failures > 0) {
      console.error(`\nsmoke FAILED: ${failures} check(s)`);
      process.exit(1);
    }
    console.log('\nsmoke ok');
    process.exit(0);
  })
  .catch((e) => {
    if (child) child.kill();
    console.error('smoke error:', e);
    process.exit(1);
  });
