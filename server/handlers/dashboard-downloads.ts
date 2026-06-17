import { jsonHeaders } from '../security';
import { getInstance, isVaultUnlocked } from '../services/nativeVault';
import { OmniClient, OmniClientError } from '../services/omniClient';
import { redactSensitiveText } from '../services/jobSanitizer';

const FORMATS = new Set(['pdf', 'png', 'csv', 'xlsx', 'json']);
const SCOPES = new Set(['dashboard', 'tile']);

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: jsonHeaders });
}

function requireUnlocked(): Response | null {
  return isVaultUnlocked() ? null : json({ error: 'vault locked' }, 423);
}

function cleanString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

async function bodyJson(req: Request): Promise<Record<string, unknown>> {
  try {
    const parsed = await req.json();
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function parseDashboardDownloadJobId(value: unknown): string {
  if (!value) return '';
  if (isRecord(value)) return String(value.job_id || value.jobId || value.id || value.download_job_id || '');
  if (typeof value !== 'string') return '';
  try {
    return parseDashboardDownloadJobId(JSON.parse(value));
  } catch {
    const match = value.match(/"?(?:job_id|jobId|download_job_id)"?\s*[:=]\s*"([^"]+)"/i);
    return match?.[1] || '';
  }
}

function normalizeJobStatus(status: string): 'processing' | 'complete' | 'error' {
  const normalized = status.toLowerCase();
  if (['complete', 'completed', 'success', 'succeeded', 'done'].includes(normalized)) return 'complete';
  if (['error', 'failed', 'failure'].includes(normalized)) return 'error';
  return 'processing';
}

function parseStartBody(body: Record<string, unknown>): {
  request: Record<string, unknown>;
  format: string;
  scope: string;
  queryIdentifierMapKey?: string;
} {
  const request = isRecord(body.request) ? body.request : body;
  const format = cleanString(request.format);
  const scope = cleanString(body.scope) || (cleanString(request.queryIdentifierMapKey) ? 'tile' : 'dashboard');
  const queryIdentifierMapKey = cleanString(request.queryIdentifierMapKey);

  if (!format || !FORMATS.has(format)) throw Object.assign(new Error('A valid download format is required.'), { statusCode: 400 });
  if (!SCOPES.has(scope)) throw Object.assign(new Error('A valid download scope is required.'), { statusCode: 400 });
  if (format === 'json' && !queryIdentifierMapKey) throw Object.assign(new Error('JSON downloads require a single tile selection.'), { statusCode: 400 });
  if (scope === 'tile' && !queryIdentifierMapKey) throw Object.assign(new Error('Single-tile downloads require queryIdentifierMapKey.'), { statusCode: 400 });
  if (typeof request.filename === 'string' && request.filename.length > 255) {
    throw Object.assign(new Error('Filename must be 255 characters or fewer.'), { statusCode: 400 });
  }

  return { request, format, scope, queryIdentifierMapKey };
}

function contentDisposition(filename: string | undefined): string {
  const safe = (filename || 'dashboard-download')
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '-')
    .slice(0, 255) || 'dashboard-download';
  return `attachment; filename="${safe.replace(/"/g, '')}"`;
}

export default async function handler(req: Request): Promise<Response> {
  try {
    const locked = requireUnlocked();
    if (locked) return locked;

    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/api\/dashboard-downloads\/?/, '');
    const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
    const instanceId = parts[0];
    if (!instanceId) return json({ error: 'Instance id required.' }, 400);

    const secret = getInstance(instanceId);
    if (!secret) return json({ error: 'Instance not found.' }, 404);
    const client = new OmniClient(secret);

    if (parts[1] !== 'dashboards') return json({ error: `Unknown dashboard downloads route: ${path}` }, 404);
    const dashboardId = parts[2];
    if (!dashboardId) return json({ error: 'Dashboard id required.' }, 400);

    if (req.method === 'GET' && parts[3] === 'details') {
      const details = await client.getDashboardDownloadDetails(dashboardId);
      return json({ details });
    }

    if (req.method === 'POST' && parts[3] === 'jobs' && parts.length === 4) {
      const parsed = parseStartBody(await bodyJson(req));
      if (parsed.queryIdentifierMapKey) {
        const details = await client.getDashboardDownloadDetails(dashboardId);
        const found = details.tiles.some((tile) => tile.queryIdentifierMapKey === parsed.queryIdentifierMapKey);
        if (!found) return json({ error: 'Selected tile is not available for this dashboard.' }, 400);
      }
      try {
        const started = await client.startDashboardDownload(dashboardId, parsed.request);
        return json({ jobId: started.jobId, attached: false });
      } catch (error) {
        if (error instanceof OmniClientError && error.status === 409) {
          const jobId = parseDashboardDownloadJobId(error.message);
          if (jobId) return json({ jobId, attached: true });
          return json({ error: 'A download is already running, but Omni did not return the existing job id.' }, 409);
        }
        throw error;
      }
    }

    if (req.method === 'GET' && parts[3] === 'jobs' && parts[5] === 'status') {
      const jobId = parts[4];
      if (!jobId) return json({ error: 'Job id required.' }, 400);
      const status = await client.getDashboardDownloadStatus(dashboardId, jobId);
      return json({
        status: normalizeJobStatus(status.status),
        rawStatus: status.status,
        error: status.error ? redactSensitiveText(status.error) : undefined,
      });
    }

    if (req.method === 'GET' && parts[3] === 'jobs' && parts[5] === 'file') {
      const jobId = parts[4];
      if (!jobId) return json({ error: 'Job id required.' }, 400);
      const upstream = await client.getDashboardDownloadFile(dashboardId, jobId);
      const headers = new Headers();
      headers.set('content-type', upstream.headers.get('content-type') || 'application/octet-stream');
      headers.set('content-disposition', contentDisposition(url.searchParams.get('filename') || undefined));
      return new Response(upstream.body, { status: 200, headers });
    }

    return json({ error: `Unknown dashboard downloads route: ${path}` }, 404);
  } catch (error) {
    const statusCode = typeof (error as { statusCode?: unknown }).statusCode === 'number'
      ? (error as { statusCode: number }).statusCode
      : error instanceof OmniClientError && error.status >= 400 && error.status < 500
        ? error.status
        : 500;
    const message = error instanceof Error ? redactSensitiveText(error.message) : 'Dashboard download operation failed.';
    return json({ error: message }, statusCode);
  }
}
