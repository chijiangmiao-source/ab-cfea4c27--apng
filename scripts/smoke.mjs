// HTTP 冒烟：启动/复用 server，GET 页面与 /healthz，校验状态码与关键内容。
// 支持外部已运行的服务：SMOKE_BASE_URL=http://host:port node scripts/smoke.mjs
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const BASE = process.env.SMOKE_BASE_URL || `http://127.0.0.1:${process.env.PORT || 8080}`;
const EXTERNAL = Boolean(process.env.SMOKE_BASE_URL);

let serverProc = null;

async function waitFor(url, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return res;
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (e) {
      lastErr = e;
    }
    await sleep(200);
  }
  throw lastErr;
}

async function get(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} => HTTP ${res.status}`);
  return res;
}

let failures = 0;
const fail = (m) => { failures++; console.error(`冒烟失败：${m}`); };

try {
  if (!EXTERNAL) {
    serverProc = spawn(process.execPath, ['server.js'], {
      env: { ...process.env, PORT: process.env.PORT || '8080', HOST: '127.0.0.1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    serverProc.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  }

  await waitFor(`${BASE}/healthz`);

  // /healthz
  const healthRes = await get(`${BASE}/healthz`);
  const health = await healthRes.json();
  if (health.status !== 'ok') fail(`/healthz 内容异常：${JSON.stringify(health)}`);
  else console.log(`  ✓ GET /healthz 200 ${JSON.stringify(health)}`);

  // 页面
  const pageRes = await get(`${BASE}/`);
  const ct = pageRes.headers.get('content-type') || '';
  if (!ct.includes('text/html')) fail(`页面 Content-Type 异常：${ct}`);
  const html = await pageRes.text();
  for (const needle of ['APNG', '提交复核', '清空草稿与结论', '/public/app.js']) {
    if (!html.includes(needle)) fail(`页面缺少关键内容：${needle}`);
  }
  console.log('  ✓ GET / 200 text/html，关键控件齐全');

  // 页面依赖模块可获取（import 图入口）
  const appRes = await get(`${BASE}/public/app.js`);
  if (!(await appRes.text()).includes('reviewBase64')) fail('/public/app.js 内容异常');
  const engRes = await get(`${BASE}/src/apng.js`);
  if (!(await engRes.text()).includes('reviewApng')) fail('/src/apng.js 内容异常');
  console.log('  ✓ 前端模块 /public/app.js 与 /src/apng.js 可加载');

  // /index.html 同样可访问
  if ((await fetch(`${BASE}/index.html`)).status !== 200) fail('/index.html 应返回 200');
  else console.log('  ✓ GET /index.html 200');
} catch (e) {
  fail(e.stack || String(e));
} finally {
  if (serverProc) serverProc.kill('SIGTERM');
}

if (failures > 0) {
  console.error(`HTTP 冒烟共 ${failures} 项失败`);
  process.exit(1);
}
console.log('HTTP 冒烟全部通过');
