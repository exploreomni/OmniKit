import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { apiMiddleware } from './apiMiddleware';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(__dirname, '..', 'dist');
const port = Number(process.env.PORT || 5173);

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
};

async function serveStatic(urlPath: string, res: http.ServerResponse): Promise<void> {
  const safePath = path.normalize(urlPath).replace(/^(\.\.[\/\\])+/, '');
  let filePath = path.join(distDir, safePath === '/' ? 'index.html' : safePath);

  try {
    const info = await stat(filePath);
    if (info.isDirectory()) filePath = path.join(filePath, 'index.html');
  } catch {
    filePath = path.join(distDir, 'index.html');
  }

  try {
    const content = await readFile(filePath);
    res.statusCode = 200;
    res.setHeader('Content-Type', MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream');
    res.end(content);
  } catch {
    res.statusCode = 404;
    res.end('Not found');
  }
}

const api = apiMiddleware();

const server = http.createServer((req, res) => {
  if (req.url?.startsWith('/api/')) {
    api(req, res);
    return;
  }
  serveStatic(req.url || '/', res);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`OmniKit Local running at http://localhost:${port}`);
});
