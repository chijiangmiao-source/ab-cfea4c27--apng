// 页面构建检查（零依赖）：
//  1. 关键文件存在
//  2. 所有 JS 通过语法解析（node --check，含 ESM import 图上的文件）
//  3. index.html 引用的本地资源全部存在
//  4. 内置示例 Base64 能通过引擎完整复核，且具备“半透明 over 两帧 + previous 恢复”证据
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { reviewBase64 } from '../src/apng.js';

const ROOT = process.cwd();
let failures = 0;
const fail = (m) => { failures++; console.error(`构建检查失败：${m}`); };
const ok = (m) => console.log(`  ✓ ${m}`);

for (const f of ['public/index.html', 'public/app.js', 'public/sample.js', 'src/apng.js', 'server.js']) {
  if (!existsSync(join(ROOT, f))) fail(`缺少文件 ${f}`);
  else ok(`存在 ${f}`);
}

// 语法检查
for (const f of ['public/app.js', 'public/sample.js', 'src/apng.js', 'server.js']) {
  const r = spawnSync(process.execPath, ['--check', join(ROOT, f)]);
  if (r.status !== 0) fail(`${f} 语法错误：\n${r.stderr?.toString()}`);
  else ok(`${f} 语法通过`);
}

// HTML 引用资源完整性
const html = readFileSync(join(ROOT, 'public/index.html'), 'utf8');
const refs = [...html.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map((m) => m[1]);
if (!refs.some((r) => r.startsWith('/public/app.js'))) fail('index.html 未引用 /public/app.js');
for (const ref of refs) {
  if (ref.startsWith('/http') || ref.startsWith('//')) continue;
  const local = join(ROOT, ref);
  if (!existsSync(local)) fail(`index.html 引用的资源不存在：${ref}`);
  else ok(`页面资源可解析 ${ref}`);
}

// 内置示例必须能复核通过，并满足题设语义
const { sampleBase64 } = await import('../public/sample.js');
const result = await reviewBase64(sampleBase64);
if (result.numFrames < 3) fail(`内置示例至少需要 3 帧，实际 ${result.numFrames}`);
if (result.frames[0].canvas.sha256 === result.frames[1].canvas.sha256) {
  fail('内置示例前两帧合成画布摘要不应相同（半透明 over 必须产生像素历史）');
} else {
  ok('两个半透明 over 帧产生不同合成画布摘要');
}
if (result.frames[1].control.disposeOp !== 2) fail('内置示例第二帧应为 previous 处置');
if (result.frames[2].canvas.sha256 !== result.frames[0].canvas.sha256) {
  fail('内置示例第三帧画布摘要必须与首帧一致（previous 恢复背景）');
} else {
  ok('previous 处置后第三帧画布恢复为首帧状态');
}

if (failures > 0) {
  console.error(`构建检查共 ${failures} 项失败`);
  process.exit(1);
}
console.log('页面构建检查全部通过');
