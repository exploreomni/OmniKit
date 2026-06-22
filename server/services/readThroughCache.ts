const DEFAULT_TTL_MS = 180_000;
const MAX_ENTRIES = 250;

interface CacheEntry<T> {
  expiresAt: number;
  value: T;
}

const cache = new Map<string, CacheEntry<unknown>>();

function cloneValue<T>(value: T): T {
  if (typeof structuredClone === 'function') {
    try {
      return structuredClone(value);
    } catch {
      // Fall through to JSON cloning for plain API payloads.
    }
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

function pruneExpired(now = Date.now()) {
  for (const [key, entry] of cache.entries()) {
    if (entry.expiresAt <= now) cache.delete(key);
  }
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value as string | undefined;
    if (!oldest) break;
    cache.delete(oldest);
  }
}

export async function readThroughCache<T>(
  key: string,
  loader: () => Promise<T>,
  options: { ttlMs?: number; enabled?: boolean } = {},
): Promise<T> {
  if (options.enabled === false) return loader();
  const now = Date.now();
  pruneExpired(now);
  const existing = cache.get(key) as CacheEntry<T> | undefined;
  if (existing && existing.expiresAt > now) return cloneValue(existing.value);
  const value = await loader();
  cache.set(key, {
    expiresAt: now + (options.ttlMs || DEFAULT_TTL_MS),
    value: cloneValue(value),
  });
  return value;
}

export function clearReadThroughCache(prefix?: string): void {
  if (!prefix) {
    cache.clear();
    return;
  }
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}
