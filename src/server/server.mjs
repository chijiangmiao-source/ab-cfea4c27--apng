import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { reviewAPNG, MAX_INPUT_BYTES } from '../core/apng.mjs';
import { strictBase64Decode } from '../core/base64.mjs';
import { encodePNG } from '../core/png-encode.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(__dirname, '../../dist');
const PORT = Number(process.env.PORT || 8080);
const HOST = process.env.HOST || '0.0.0.0';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readBody(req, limit = MAX_INPUT_BYTES + 4096) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('请求体过大'), { status: 413, code: 'TOO_LARGE' }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function handleReview(req, res) {
  const raw = await readBody(req);
  let payload;
  try {
    payload = JSON.parse(raw.toString('utf8'));
  } catch {
    return sendJson(res, 400, { ok: false, error: { code: 'BAD_JSON', message: '请求不是合法 JSON', offset: 0 } });
  }
  const b64 = typeof payload?.base64 === 'string' ? payload.base64 : null;
  if (b64 === null) {
    return sendJson(res, 400, { ok: false, error: { code: 'NO_INPUT', message: '缺少 base64 字段', offset: 0 } });
  }
  // The pasted Base64 draft itself must fit in 256 KiB.
  if (Buffer.byteLength(b64, 'utf8') > MAX_INPUT_BYTES) {
    return sendJson(res, 413, {
      ok: false,
      retained: true,
      error: {
        code: 'TOO_LARGE',
        message: `粘贴内容 ${Buffer.byteLength(b64, 'utf8')} 字节，超过 ${MAX_INPUT_BYTES} 字节（256 KiB）上限`,
        offset: MAX_INPUT_BYTES,
      },
    });
  }

  const dec = strictBase64Decode(b64);
  if (dec.error) {
    return sendJson(res, 400, {
      ok: false,
      retained: true,
      error: {
        code: 'BAD_BASE64',
        message: `Base64 内容在第 ${dec.error.offset} 个字符处非法${dec.error.reason ? `：${dec.error.reason}` : ''}`,
        offset: dec.error.offset,
        detail: dec.error,
      },
    });
  }
  const file = dec.data;
  if (file.length > MAX_INPUT_BYTES) {
    return sendJson(res, 413, {
      ok: false,
      retained: true,
      error: {
        code: 'TOO_LARGE',
        message: `解码后 ${file.length} 字节，超过 ${MAX_INPUT_BYTES} 字节（256 KiB）上限`,
        offset: MAX_INPUT_BYTES,
      },
    });
  }

  try {
    const review = await reviewAPNG(file);
    const frames = review.frames.map((f) => ({
      index: f.index,
      control: f.control,
      dataChunks: f.dataChunks,
      decodedRegion: {
        width: f.decodedRegion.width,
        height: f.decodedRegion.height,
        summary: f.decodedRegion.summary,
        png: toDataURL(encodePNG(f.decodedRegion.bytes, f.decodedRegion.width, f.decodedRegion.height)),
      },
      composedCanvas: {
        width: f.composedCanvas.width,
        height: f.composedCanvas.height,
        summary: f.composedCanvas.summary,
        // Frozen snapshot: frame switching only reads these pre-rendered bytes.
        png: toDataURL(encodePNG(f.composedCanvas.bytes, f.composedCanvas.width, f.composedCanvas.height)),
      },
    }));
    return sendJson(res, 200, {
      ok: true,
      width: review.width,
      height: review.height,
      numFrames: review.numFrames,
      numPlays: review.numPlays,
      inputSha256: review.inputSha256,
      inputBytes: file.length,
      frames,
    });
  } catch (e) {
    if (e?.name === 'APNGError') {
      return sendJson(res, 422, {
        ok: false,
        retained: true, // draft input must remain in the browser textarea
        clearedEvidence: true, // no stale success evidence may survive
        error: { code: e.code, message: e.message, offset: e.offset, detail: e.detail ?? null },
      });
    }
    return sendJson(res, 500, {
      ok: false,
      retained: true,
      error: { code: 'INTERNAL', message: String(e?.message || e), offset: -1 },
    });
  }
}

function toDataURL(png) {
  return `data:image/png;base64,${png.toString('base64')}`;
}

function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let rel = decodeURIComponent(url.pathname);
  if (rel === '/') rel = '/index.html';
  const safe = path.normalize(rel).replace(/^([/\\])+/, '');
  const file = path.join(DIST, safe);
  if (!file.startsWith(DIST)) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      return res.end('未找到资源');
    }
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(data);
  });
}

export function createServer() {
  return http.createServer(async (req, res) => {
    try {
      if (req.method === 'GET' && req.url === '/healthz') {
        return sendJson(res, 200, { status: 'ok', uptime: process.uptime(), port: PORT });
      }
      if (req.method === 'POST' && req.url === '/api/review') {
        return await handleReview(req, res);
      }
      if (req.method === 'GET') {
        return serveStatic(req, res);
      }
      res.writeHead(405, { allow: 'GET, POST' });
      res.end('method not allowed');
    } catch (e) {
      if (e?.status) return sendJson(res, e.status, { ok: false, error: { code: e.code, message: e.message } });
      sendJson(res, 500, { ok: false, error: { code: 'INTERNAL', message: String(e?.message || e) } });
    }
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const server = createServer();
  server.listen(PORT, HOST, () => {
    console.log(`APNG review service listening on http://${HOST}:${PORT}`);
  });
}
