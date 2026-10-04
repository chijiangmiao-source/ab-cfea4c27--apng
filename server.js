// 极简零依赖静态服务器：页面与 /healthz
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(new URL('.', import.meta.url)));
const PUBLIC_DIRS = ['public', 'src'];
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function send(res, status, body, headers = {}) {
  res.writeHead(status, { 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = decodeURIComponent(url.pathname);

  if (pathname === '/healthz') {
    send(res, 200, JSON.stringify({ status: 'ok', service: 'apng-frame-review', time: new Date().toISOString() }), {
      'Content-Type': 'application/json; charset=utf-8',
    });
    return;
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    send(res, 405, 'Method Not Allowed');
    return;
  }

  let rel = pathname === '/' || pathname === '/index.html' ? '/public/index.html' : pathname;
  rel = normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const top = rel.split('/').filter(Boolean)[0];
  if (!PUBLIC_DIRS.includes(top)) {
    send(res, 403, 'Forbidden');
    return;
  }
  const filePath = join(ROOT, rel);
  if (!filePath.startsWith(join(ROOT, top))) {
    send(res, 403, 'Forbidden');
    return;
  }
  try {
    const body = await readFile(filePath);
    send(res, 200, body, { 'Content-Type': MIME[extname(filePath)] || 'application/octet-stream' });
  } catch {
    send(res, 404, 'Not Found');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`APNG 复核服务已启动: http://${HOST}:${PORT}/ （健康检查 /healthz）`);
});

export { server };
