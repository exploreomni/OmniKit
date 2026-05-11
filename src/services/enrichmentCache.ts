import type { EnrichmentResult } from './omniApi';

const STORAGE_KEY = 'omni.enrichment.v1';
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 5000;

interface CachedEntry extends EnrichmentResult {
  cachedAt: number;
}

type CacheShape = Record<string, CachedEntry>;

function cacheKey(baseUrl: string, documentId: string): string {
  return `${baseUrl}::${documentId}`;
}

function readAll(): CacheShape {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as CacheShape;
    }
    return {};
  } catch {
    return {};
  }
}

function writeAll(cache: CacheShape): void {
  try {
    const keys = Object.keys(cache);
    if (keys.length > MAX_ENTRIES) {
      const entries = keys.map((k) => [k, cache[k].cachedAt] as const);
      entries.sort((a, b) => a[1] - b[1]);
      const removeCount = entries.length - MAX_ENTRIES;
      for (let i = 0; i < removeCount; i += 1) {
        delete cache[entries[i][0]];
      }
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
  } catch {
    // localStorage quota exceeded or unavailable; ignore
  }
}

export function getCachedEnrichments(
  baseUrl: string,
  documentIds: string[]
): { hits: Record<string, EnrichmentResult>; missing: string[] } {
  const cache = readAll();
  const hits: Record<string, EnrichmentResult> = {};
  const missing: string[] = [];
  const now = Date.now();
  for (const id of documentIds) {
    const entry = cache[cacheKey(baseUrl, id)];
    if (entry && now - entry.cachedAt < TTL_MS) {
      hits[id] = {
        baseModelId: entry.baseModelId,
        baseModelName: entry.baseModelName,
        topicNames: entry.topicNames,
        connectionName: entry.connectionName,
        connectionId: entry.connectionId,
        enrichmentError: entry.enrichmentError,
      };
    } else {
      missing.push(id);
    }
  }
  return { hits, missing };
}

export function setCachedEnrichments(
  baseUrl: string,
  results: Record<string, EnrichmentResult>
): void {
  const cache = readAll();
  const now = Date.now();
  for (const [id, result] of Object.entries(results)) {
    if (result.enrichmentError && !result.baseModelId) continue;
    cache[cacheKey(baseUrl, id)] = { ...result, cachedAt: now };
  }
  writeAll(cache);
}

export function clearEnrichmentCache(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}
