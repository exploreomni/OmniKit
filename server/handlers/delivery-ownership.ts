import { jsonHeaders } from '../security';
import { getDeliveryOwnershipEvidence } from '../services/deliveryOwnership';
import { getInstance } from '../services/nativeVault';

function json(value: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), { status, headers: { ...jsonHeaders, ...extraHeaders } });
}

function parameter(url: URL, name: string): string | null {
  const values = url.searchParams.getAll(name);
  if (values.length !== 1) return null;
  const value = values[0]?.trim() ?? '';
  if (!value || value.length > 500 || /[\u0000-\u001f\u007f]/.test(value)) return null;
  return value;
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'GET') return json({ error: 'METHOD_NOT_ALLOWED' }, 405, { Allow: 'GET' });
  const url = new URL(req.url);
  if ([...url.searchParams.keys()].some((key) => !['instanceId', 'scheduleId'].includes(key))) {
    return json({ error: 'INVALID_QUERY' }, 400);
  }
  const instanceId = parameter(url, 'instanceId');
  const scheduleId = parameter(url, 'scheduleId');
  if (!instanceId || !scheduleId) return json({ error: 'INVALID_QUERY' }, 400);
  try {
    const instance = getInstance(instanceId);
    if (!instance) return json({ error: 'INSTANCE_NOT_FOUND' }, 404);
    return json(await getDeliveryOwnershipEvidence(instance, scheduleId, req.signal));
  } catch (error) {
    const upstreamStatus = typeof (error as { status?: unknown }).status === 'number'
      ? (error as { status: number }).status
      : undefined;
    const statusCode = typeof (error as { statusCode?: unknown }).statusCode === 'number'
      ? (error as { statusCode: number }).statusCode
      : req.signal.aborted ? 499 : upstreamStatus === 404 ? 404 : upstreamStatus === 401 || upstreamStatus === 403 ? 403 : 502;
    return json({
      error: statusCode === 423
        ? 'VAULT_LOCKED'
        : statusCode === 404
          ? 'SCHEDULE_NOT_FOUND'
          : statusCode === 403
            ? 'PERMISSION_DENIED'
            : statusCode === 499
              ? 'REQUEST_CANCELLED'
              : 'DELIVERY_OWNERSHIP_READ_FAILED',
    }, statusCode);
  }
}
