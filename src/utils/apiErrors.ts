export function friendlyApiError(err: unknown, fallback = 'Request failed') {
  const message = err instanceof Error ? err.message : typeof err === 'string' ? err : fallback;
  const normalized = message.toLowerCase();

  if (normalized.includes('too many requests') || normalized.includes('429')) {
    return 'Omni is rate limiting this request. Wait a moment, then try again.';
  }

  if (normalized.includes('unexpected end of json input')) {
    return 'Omni returned an empty response for this request. Try again in a moment.';
  }

  return message || fallback;
}
