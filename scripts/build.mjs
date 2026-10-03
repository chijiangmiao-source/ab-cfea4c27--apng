// Frontend build: validate the page and emit dist/. No bundler is needed
// (zero-dependency ES modules), but the build still fails if the HTML
// references a missing local asset, so the acceptance gate can catch it.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.resolve(__dirname, '../web');
const DIST = path.resolve(__dirname, '../dist');

function rmrf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function walk(dir) {
  const out = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

rmrf(DIST);
fs.mkdirSync(DIST, { recursive: true });

const files = walk(WEB);
for (const f of files) {
  const rel = path.relative(WEB, f);
  const dest = path.join(DIST, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(f, dest);
}

// Validate index.html structural markers and referenced local assets.
const htmlPath = path.join(DIST, 'index.html');
if (!fs.existsSync(htmlPath)) throw new Error('build: web/index.html missing');
const html = fs.readFileSync(htmlPath, 'utf8');
for (const marker of ['id="paste"', 'id="submit"', 'id="clear"', 'id="frames"', 'id="conclusion"', 'id="error"']) {
  if (!html.includes(marker)) throw new Error(`build: index.html 缺少必需节点 ${marker}`);
}
const refs = [...html.matchAll(/(?:src|href)="(\.\/[^"#?]+|[a-zA-Z0-9_.-]+\.(?:js|css))"/g)].map((m) => m[1]);
for (const ref of refs) {
  const asset = path.join(DIST, ref.replace(/^\.\//, ''));
  if (!fs.existsSync(asset)) throw new Error(`build: index.html 引用了不存在的资源 ${ref}`);
  const stat = fs.statSync(asset);
  if (stat.size === 0) throw new Error(`build: 资源 ${ref} 为空文件`);
}

// Basic JS syntax check for every shipped script.
import { execFileSync } from 'node:child_process';
for (const f of walk(DIST).filter((x) => x.endsWith('.js'))) {
  execFileSync(process.execPath, ['--check', f], { stdio: 'pipe' });
}

console.log(`build ok: ${files.length} files -> dist/`);
