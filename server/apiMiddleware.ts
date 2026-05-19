import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

import bulkCopyDocuments from './handlers/bulk-copy-documents';
import bulkDeleteDocuments from './handlers/bulk-delete-documents';
import bulkMoveDocuments from './handlers/bulk-move-documents';
import enrichDocuments from './handlers/enrich-documents';
import generateEmbedUrl from './handlers/generate-embed-url';
import inspectExport from './handlers/inspect-export';
import listDocuments from './handlers/list-documents';
import listFolders from './handlers/list-folders';
import listModels from './handlers/list-models';
import manageAi from './handlers/manage-ai';
import manageGroups from './handlers/manage-groups';
import manageModels from './handlers/manage-models';
import manageTopics from './handlers/manage-topics';
import manageUsers from './handlers/manage-users';
import migrate from './handlers/migrate';
import omniProxy from './handlers/omni-proxy';
import testConnection from './handlers/test-connection';

type Handler = (req: Request) => Promise<Response>;
const MAX_BODY_BYTES = 25 * 1024 * 1024;

const routes: Record<string, Handler> = {
  'bulk-copy-documents': bulkCopyDocuments,
  'bulk-delete-documents': bulkDeleteDocuments,
  'bulk-move-documents': bulkMoveDocuments,
  'enrich-documents': enrichDocuments,
  'generate-embed-url': generateEmbedUrl,
  'inspect-export': inspectExport,
  'list-documents': listDocuments,
  'list-folders': listFolders,
  'list-models': listModels,
  'manage-ai': manageAi,
  'manage-groups': manageGroups,
  'manage-models': manageModels,
  'manage-topics': manageTopics,
  'manage-users': manageUsers,
  migrate,
  'omni-proxy': omniProxy,
  'test-connection': testConnection,
};

async function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    req.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_BYTES) {
        reject(new Error('Request body is too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function toWebRequest(req: IncomingMessage, bodyBuffer: Buffer, route: string): Request {
  const host = req.headers.host || 'localhost';
  const url = `http://${host}/api/${route}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (!value) continue;
    if (Array.isArray(value)) headers.set(key, value.join(', '));
    else headers.set(key, String(value));
  }
  const init: RequestInit = { method: req.method || 'GET', headers };
  if (req.method && !['GET', 'HEAD', 'OPTIONS'].includes(req.method) && bodyBuffer.length > 0) {
    init.body = new Uint8Array(bodyBuffer);
  }
  return new Request(url, init);
}

async function sendWebResponse(webRes: Response, nodeRes: ServerResponse): Promise<void> {
  nodeRes.statusCode = webRes.status;
  webRes.headers.forEach((value, key) => {
    if (key.toLowerCase() === 'content-encoding') return;
    nodeRes.setHeader(key, value);
  });
  if (!webRes.body) {
    nodeRes.end();
    return;
  }
  const nodeStream = Readable.fromWeb(webRes.body as unknown as import('node:stream/web').ReadableStream);
  nodeStream.pipe(nodeRes);
  nodeStream.on('error', () => nodeRes.end());
}

export function apiMiddleware() {
  return async (req: IncomingMessage, res: ServerResponse, next?: (err?: unknown) => void) => {
    const url = req.url || '';
    if (!url.startsWith('/api/')) {
      if (next) return next();
      res.statusCode = 404;
      res.end();
      return;
    }

    const route = url.slice('/api/'.length).split('?')[0].replace(/\/+$/, '');

    if (route === 'healthz') {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ ok: true, service: 'omnikit-local' }));
      return;
    }

    const handler = routes[route];
    if (!handler) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: `Unknown API route: ${route}` }));
      return;
    }

    try {
      const body = await readBody(req);
      const webReq = toWebRequest(req, body, route);
      const webRes = await handler(webReq);
      await sendWebResponse(webRes, res);
    } catch (err) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Internal error' }));
    }
  };
}
