// RFC-1918 private ranges, loopback, link-local, and IPv6 private ranges.
// These must never be reachable via the proxy to prevent SSRF attacks.
const PRIVATE_HOST_RE =
  /^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|0\.0\.0\.0|::1$|fc00:|fd[0-9a-f]{2}:)/i;

const LOOPBACK_NAMES = new Set(['localhost', '0.0.0.0']);
const ALLOWED_PROXY_ENDPOINT_RE = /^\/v1(?:\/|$)/;

/**
 * Validates that a base_url is safe to proxy outbound requests to.
 * Returns an error string if invalid, or null if the URL is acceptable.
 *
 * Rules enforced:
 *   1. Must be a parseable URL.
 *   2. Must use https: — no http, file, or other schemes.
 *   3. Must not target loopback, private, or link-local addresses (SSRF prevention).
 */
export function validateBaseUrl(raw: string): string | null {
  if (!raw || typeof raw !== 'string') return 'base_url is required.';

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return 'base_url is not a valid URL.';
  }

  if (parsed.protocol !== 'https:') {
    return 'base_url must use HTTPS (https://).';
  }

  if (parsed.username || parsed.password) {
    return 'base_url must not include embedded credentials.';
  }

  if (parsed.search || parsed.hash) {
    return 'base_url must not include query strings or fragments.';
  }

  const host = parsed.hostname.toLowerCase();

  if (LOOPBACK_NAMES.has(host) || PRIVATE_HOST_RE.test(host)) {
    return 'base_url must not point to a local or private network address.';
  }

  return null;
}

/**
 * Validates the endpoint path forwarded through omni-proxy.
 * Returns an error string if invalid, or null if acceptable.
 */
export function validateEndpoint(endpoint: string): string | null {
  if (!endpoint || typeof endpoint !== 'string') return 'endpoint is required.';
  if (!endpoint.startsWith('/')) return 'endpoint must start with /.';
  if (endpoint.includes('\\')) return 'endpoint must not contain backslashes.';

  let decoded = endpoint;
  try {
    decoded = decodeURIComponent(endpoint);
  } catch {
    return 'endpoint contains invalid encoding.';
  }

  // Block path-traversal sequences regardless of encoding.
  if (decoded.includes('..')) return 'endpoint must not contain path traversal sequences.';

  if (!ALLOWED_PROXY_ENDPOINT_RE.test(decoded)) {
    return 'omni-proxy only forwards Omni /api/v1 endpoints. Use a dedicated handler for other API surfaces.';
  }
  return null;
}

/** Standard JSON response headers for same-origin local API responses. */
export const jsonHeaders: Record<string, string> = {
  'Content-Type': 'application/json',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

/** Standard SSE response headers for streaming operations. */
export const sseHeaders: Record<string, string> = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache, no-store',
  'Connection': 'keep-alive',
  'X-Content-Type-Options': 'nosniff',
};
