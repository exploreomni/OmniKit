import { lookup as dnsLookup } from 'node:dns';
import type { LookupAddress, LookupOptions } from 'node:dns';
import { request as httpsRequest } from 'node:https';
import type { IncomingMessage } from 'node:http';
import type { LookupFunction } from 'node:net';
import { isIP } from 'node:net';
import { isPrivateOrLocalAddress, validatePublicHttpsUrl } from '../security';

const DEFAULT_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;

export interface OmniJsonResponse {
  status: number;
  data?: unknown;
}

function isJsonContentType(
  contentType: string | string[] | undefined,
  allowOctetStreamJson = false,
): boolean {
  const normalized = (Array.isArray(contentType) ? contentType[0] : contentType)
    ?.split(';', 1)[0].trim().toLowerCase() || '';
  return normalized === 'application/json'
    || normalized.endsWith('+json')
    || (allowOctetStreamJson && normalized === 'application/octet-stream');
}

export async function readBoundedJson(
  response: IncomingMessage,
  maximumBytes = DEFAULT_RESPONSE_MAX_BYTES,
  allowOctetStreamJson = false,
  expectedRoot: 'object' | 'array' = 'object',
): Promise<unknown> {
  const declaredLength = Number(response.headers['content-length'] || '0');
  if (Number.isFinite(declaredLength) && declaredLength > maximumBytes) {
    response.destroy();
    throw Object.assign(new Error('response-too-large'), { statusCode: 502 });
  }
  if (!isJsonContentType(response.headers['content-type'], allowOctetStreamJson)) {
    response.destroy();
    throw Object.assign(new Error('non-json-response'), { statusCode: 502 });
  }
  const chunks: Buffer[] = [];
  let bytesRead = 0;
  for await (const value of response) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    bytesRead += chunk.byteLength;
    if (bytesRead > maximumBytes) {
      response.destroy();
      throw Object.assign(new Error('response-too-large'), { statusCode: 502 });
    }
    chunks.push(chunk);
  }

  const text = Buffer.concat(chunks, bytesRead).toString('utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw Object.assign(new Error('invalid-json-response'), { statusCode: 502 });
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) !== (expectedRoot === 'array')) {
    throw Object.assign(new Error('invalid-json-response'), { statusCode: 502 });
  }
  return parsed;
}

type DnsLookup = typeof dnsLookup;

/** Validate every DNS answer used to establish the HTTPS connection. */
export function createPublicOnlyLookup(resolve: DnsLookup = dnsLookup): LookupFunction {
  return (hostname, options, callback) => {
    const requestedAll = options.all === true;
    const lookupOptions: LookupOptions = { ...options, all: true, verbatim: true };
    resolve(hostname, lookupOptions, (error, records) => {
      if (error) {
        callback(error, '', 0);
        return;
      }
      const addresses = records as LookupAddress[];
      if (addresses.length === 0) {
        callback(Object.assign(new Error('base_url host could not be resolved safely while connecting.'), {
          code: 'ENOTFOUND',
          statusCode: 502,
        }), '', 0);
        return;
      }
      if (addresses.some((record) => isPrivateOrLocalAddress(record.address))) {
        callback(Object.assign(new Error('base_url resolved to a local or private network address while connecting.'), {
          code: 'EACCES',
          statusCode: 400,
        }), '', 0);
        return;
      }
      if (requestedAll) callback(null, addresses);
      else callback(null, addresses[0].address, addresses[0].family);
    });
  };
}

export interface OmniJsonRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal: AbortSignal;
  maximumResponseBytes?: number;
  allowOctetStreamJson?: boolean;
  expectedRoot?: 'object' | 'array';
}

export async function requestOmniJson(request: OmniJsonRequest): Promise<OmniJsonResponse> {
  // IP literals bypass Node's DNS lookup callback.
  const urlError = validatePublicHttpsUrl(request.url, { label: 'base_url' });
  if (urlError) throw Object.assign(new Error(urlError), { statusCode: 400 });
  const parsed = new URL(request.url);
  return new Promise((resolve, reject) => {
    const outbound = httpsRequest(parsed, {
      method: request.method,
      headers: request.headers,
      agent: false,
      lookup: createPublicOnlyLookup(),
      ...(isIP(parsed.hostname) ? {} : { servername: parsed.hostname }),
      signal: request.signal,
    }, (response) => {
      const status = response.statusCode || 0;
      if (status < 200 || status >= 300) {
        response.destroy();
        resolve({ status });
        return;
      }
      if (status === 204) {
        response.destroy();
        resolve({ status, data: { success: true } });
        return;
      }
      void readBoundedJson(
        response,
        request.maximumResponseBytes,
        request.allowOctetStreamJson,
        request.expectedRoot,
      ).then((data) => resolve({ status, data }), reject);
    });
    outbound.once('error', reject);
    if (request.body !== undefined) outbound.write(request.body);
    outbound.end();
  });
}
