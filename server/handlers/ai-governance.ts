import { jsonHeaders } from '../security';
import { getAIGovernanceFleet } from '../services/aiGovernanceFleet';
import { isVaultUnlocked } from '../services/nativeVault';
import { fetchTenantOpenApiSnapshot } from '../services/omniApiContractRadar';

function json(value: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...jsonHeaders, ...extraHeaders },
  });
}

function requestedInstanceId(url: URL): string | undefined | null {
  if ([...url.searchParams.keys()].some((key) => key !== 'instanceId')) return null;
  const values = url.searchParams.getAll('instanceId');
  if (values.length > 1) return null;
  const value = values[0]?.trim();
  if (!value) return undefined;
  if (value.length > 500 || /[\u0000-\u001f\u007f]/.test(value)) return null;
  return value;
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'GET') return json({ error: 'METHOD_NOT_ALLOWED' }, 405, { Allow: 'GET' });
  if (!isVaultUnlocked()) return json({ error: 'VAULT_LOCKED' }, 423);
  const instanceId = requestedInstanceId(new URL(req.url));
  if (instanceId === null) return json({ error: 'INVALID_QUERY' }, 400);

  try {
    return json(await getAIGovernanceFleet({
      ...(instanceId ? { instanceId } : {}),
      signal: req.signal,
      discoverTenantContract: async (instance, signal) => (
        await fetchTenantOpenApiSnapshot(instance, { signal })
      ).operations,
    }));
  } catch (error) {
    const status = typeof (error as { statusCode?: unknown }).statusCode === 'number'
      ? (error as { statusCode: number }).statusCode
      : req.signal.aborted ? 499 : 502;
    const code = status === 404
      ? 'INSTANCE_NOT_FOUND'
      : status === 499
        ? 'REQUEST_CANCELLED'
        : 'AI_GOVERNANCE_READ_FAILED';
    return json({ error: code }, status);
  }
}
