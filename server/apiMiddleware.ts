import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

import bulkCopyDocuments from './handlers/bulk-copy-documents';
import bulkDeleteDocuments from './handlers/bulk-delete-documents';
import bulkMoveDocuments from './handlers/bulk-move-documents';
import enrichDocuments from './handlers/enrich-documents';
import generateEmbedUrl from './handlers/generate-embed-url';
import inspectExport from './handlers/inspect-export';
import instanceDashboard from './handlers/instance-dashboard';
import instances from './handlers/instances';
import listDocuments from './handlers/list-documents';
import listFolders from './handlers/list-folders';
import listModels from './handlers/list-models';
import manageAi from './handlers/manage-ai';
import manageGroups from './handlers/manage-groups';
import manageModels from './handlers/manage-models';
import manageTopics from './handlers/manage-topics';
import manageUsers from './handlers/manage-users';
import migrate from './handlers/migrate';
import migrationJobs from './handlers/migration-jobs';
import omniProxy from './handlers/omni-proxy';
import testConnection from './handlers/test-connection';
import vault from './handlers/vault';
import { getInstance } from './services/nativeVault';

type Handler = (req: Request) => Promise<Response>;
const MAX_BODY_BYTES = 25 * 1024 * 1024;
const VAULT_API_KEY_REFERENCE_PREFIX = '__omnikit_vault_instance__:';
const VAULT_HYDRATION_SKIP_PREFIXES = new Set(['vault', 'instances', 'migration-jobs', 'instance-dashboard']);

const routes: Record<string, Handler> = {
  'bulk-copy-documents': bulkCopyDocuments,
  'bulk-delete-documents': bulkDeleteDocuments,
  'bulk-move-documents': bulkMoveDocuments,
  'enrich-documents': enrichDocuments,
  'generate-embed-url': generateEmbedUrl,
  'inspect-export': inspectExport,
  'instance-dashboard': instanceDashboard,
  instances,
  'list-documents': listDocuments,
  'list-folders': listFolders,
  'list-models': listModels,
  'manage-ai': manageAi,
  'manage-groups': manageGroups,
  'manage-models': manageModels,
  'manage-topics': manageTopics,
  'manage-users': manageUsers,
  migrate,
  'migration-jobs': migrationJobs,
  'omni-proxy': omniProxy,
  'test-connection': testConnection,
  vault,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function vaultReferenceId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  if (!value.startsWith(VAULT_API_KEY_REFERENCE_PREFIX)) return null;
  const id = value.slice(VAULT_API_KEY_REFERENCE_PREFIX.length).trim();
  return id || null;
}

function statusError(message: string, statusCode: number): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode });
}

export function hydrateVaultCredentialReferences(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(hydrateVaultCredentialReferences);
  if (!isRecord(value)) return value;

  const next: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    next[key] = hydrateVaultCredentialReferences(item);
  }

  const snakeId = vaultReferenceId(next.api_key);
  const camelId = vaultReferenceId(next.apiKey);
  const instanceId = snakeId || camelId;
  if (!instanceId) return next;

  let instance;
  try {
    instance = getInstance(instanceId);
  } catch (error) {
    if ((error as { statusCode?: unknown }).statusCode === 423) {
      throw statusError('Unlock the native vault before using this saved Omni instance.', 423);
    }
    throw error;
  }
  if (!instance) throw statusError('Saved Omni instance not found. Reconnect from the vault and try again.', 404);

  if (snakeId) {
    next.api_key = instance.apiKey;
    next.base_url = instance.baseUrl;
  }
  if (camelId) {
    next.apiKey = instance.apiKey;
    next.baseUrl = instance.baseUrl;
  }
  return next;
}

function maybeHydrateBody(bodyBuffer: Buffer, routePrefix: string): Buffer {
  if (bodyBuffer.length === 0 || VAULT_HYDRATION_SKIP_PREFIXES.has(routePrefix)) return bodyBuffer;
  try {
    const parsed = JSON.parse(bodyBuffer.toString('utf8')) as unknown;
    const hydrated = hydrateVaultCredentialReferences(parsed);
    return Buffer.from(JSON.stringify(hydrated));
  } catch (error) {
    if ((error as { statusCode?: unknown }).statusCode) throw error;
    return bodyBuffer;
  }
}

function toWebRequest(req: IncomingMessage, bodyBuffer: Buffer, route: string): Request {
  const host = req.headers.host || 'localhost';
  const url = `http://${host}/api/${route}`;
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (!value) continue;
    if (key.toLowerCase() === 'content-length') continue;
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
      res.end(JSON.stringify({ ok: true, service: 'omnikit' }));
      return;
    }

    const routePrefix = route.split('/')[0] || route;
    const handler = routes[route] || routes[routePrefix];
    if (!handler) {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: `Unknown API route: ${route}` }));
      return;
    }

    try {
      const body = await readBody(req);
      const hydratedBody = maybeHydrateBody(body, routePrefix);
      const webReq = toWebRequest(req, hydratedBody, route);
      const webRes = await handler(webReq);
      await sendWebResponse(webRes, res);
    } catch (err) {
      res.statusCode = typeof (err as { statusCode?: unknown }).statusCode === 'number'
        ? (err as { statusCode: number }).statusCode
        : 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : 'Internal error' }));
    }
  };
}
