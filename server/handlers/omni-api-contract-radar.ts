import { jsonHeaders } from '../security';
import {
  getOmniApiContractRadarReport,
  OmniApiContractRadarError,
  type OmniApiContractRadarDependencies,
} from '../services/omniApiContractRadar';
import { getInstance } from '../services/nativeVault';

const ALLOWED_QUERY_PARAMETERS = new Set(['instanceId']);

export interface OmniApiContractRadarHandlerDependencies extends OmniApiContractRadarDependencies {
  getSavedInstance?: typeof getInstance;
}

function json(value: unknown, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...jsonHeaders, ...extraHeaders },
  });
}

function invalidRequest(message: string): Error & { statusCode: 400 } {
  return Object.assign(new Error(message), { statusCode: 400 as const });
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
}

function instanceIdFrom(url: URL): string {
  for (const key of url.searchParams.keys()) {
    if (!ALLOWED_QUERY_PARAMETERS.has(key)) throw invalidRequest('Unsupported Contract Radar query parameter.');
  }
  const values = url.searchParams.getAll('instanceId');
  if (values.length !== 1) throw invalidRequest('Query parameter instanceId is required exactly once.');
  const instanceId = values[0].trim();
  if (!instanceId || instanceId.length > 500 || hasControlCharacters(instanceId)) {
    throw invalidRequest('Query parameter instanceId is invalid.');
  }
  return instanceId;
}

export async function omniApiContractRadarHandlerImplementation(
  request: Request,
  dependencies: OmniApiContractRadarHandlerDependencies = {},
): Promise<Response> {
  if (request.method !== 'GET') {
    return json({ error: 'Method not allowed.' }, 405, { Allow: 'GET' });
  }

  try {
    const instanceId = instanceIdFrom(new URL(request.url));
    const instance = (dependencies.getSavedInstance || getInstance)(instanceId);
    if (!instance) return json({ error: 'Saved Omni instance not found.' }, 404);
    const report = await getOmniApiContractRadarReport(instance, dependencies);
    return json(report);
  } catch (error) {
    const statusCode = error instanceof OmniApiContractRadarError
      ? error.statusCode
      : typeof (error as { statusCode?: unknown }).statusCode === 'number'
        ? (error as { statusCode: number }).statusCode
        : 502;
    const message = statusCode === 423
      ? 'Unlock the native vault before checking the tenant API contract.'
      : statusCode === 404
        ? 'Saved Omni instance not found.'
        : statusCode === 400
          ? error instanceof Error ? error.message : 'Invalid Contract Radar request.'
          : error instanceof OmniApiContractRadarError
            ? error.message
            : 'The tenant API contract could not be checked.';
    return json({ error: message }, statusCode);
  }
}

export default function handler(request: Request): Promise<Response> {
  return omniApiContractRadarHandlerImplementation(request);
}
