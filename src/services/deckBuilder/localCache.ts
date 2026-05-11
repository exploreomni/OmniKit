const VERSION = 1;
const PREFIX = 'omnikit:deck';

export interface CacheEnvelope<T> {
  data: T;
  savedAt: number;
  version: number;
}

function hostKey(baseUrl: string): string {
  try {
    return new URL(baseUrl).host || 'unknown';
  } catch {
    return baseUrl.replace(/^https?:\/\//, '').replace(/\/+$/, '') || 'unknown';
  }
}

function buildKey(baseUrl: string, segment: string): string {
  return `${PREFIX}:${hostKey(baseUrl)}:${segment}`;
}

function safeRead<T>(key: string): CacheEnvelope<T> | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CacheEnvelope<T>;
    if (!parsed || parsed.version !== VERSION) return null;
    return parsed;
  } catch {
    return null;
  }
}

function safeWrite<T>(key: string, data: T): void {
  if (typeof window === 'undefined') return;
  try {
    const envelope: CacheEnvelope<T> = { data, savedAt: Date.now(), version: VERSION };
    window.localStorage.setItem(key, JSON.stringify(envelope));
  } catch {
    // localStorage full or disabled — silently degrade
  }
}

export interface CachedDashboard {
  id: string;
  name: string;
  folderPath?: string;
}

export const dashboardCache = {
  load(baseUrl: string): CacheEnvelope<CachedDashboard[]> | null {
    return safeRead<CachedDashboard[]>(buildKey(baseUrl, 'dashboards'));
  },
  save(baseUrl: string, dashboards: CachedDashboard[]): void {
    safeWrite(buildKey(baseUrl, 'dashboards'), dashboards);
  },
  clear(baseUrl: string): void {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.removeItem(buildKey(baseUrl, 'dashboards'));
    } catch {
      // noop
    }
  },
};

export interface SavedFilterSet {
  id: string;
  name: string;
  savedAt: number;
  overrides: Record<string, FilterOverride>;
}

export interface FilterOverride {
  field: string;
  kind?: string;
  type?: string;
  values: unknown[];
  isNegative?: boolean;
}

export const filterSetCache = {
  load(baseUrl: string, dashboardId: string): SavedFilterSet[] {
    const key = buildKey(baseUrl, `filterSets:${dashboardId}`);
    return safeRead<SavedFilterSet[]>(key)?.data ?? [];
  },
  save(baseUrl: string, dashboardId: string, sets: SavedFilterSet[]): void {
    safeWrite(buildKey(baseUrl, `filterSets:${dashboardId}`), sets);
  },
};

export interface BatchHistoryEntry {
  id: string;
  dashboardId: string;
  dashboardName: string;
  filterField: string | null;
  values: string[];
  generatedAt: number;
  succeeded: number;
  failed: number;
}

const HISTORY_LIMIT = 10;

export const batchHistoryCache = {
  load(baseUrl: string): BatchHistoryEntry[] {
    return safeRead<BatchHistoryEntry[]>(buildKey(baseUrl, 'batchHistory'))?.data ?? [];
  },
  push(baseUrl: string, entry: BatchHistoryEntry): void {
    const existing = batchHistoryCache.load(baseUrl);
    const next = [entry, ...existing].slice(0, HISTORY_LIMIT);
    safeWrite(buildKey(baseUrl, 'batchHistory'), next);
  },
};

export interface CachedFilterValues {
  values: string[];
  fetchedAt: number;
}

const FILTER_VALUES_TTL_MS = 30 * 60_000;

export const filterValuesCache = {
  load(baseUrl: string, dashboardId: string, field: string): CachedFilterValues | null {
    const env = safeRead<CachedFilterValues>(buildKey(baseUrl, `filterValues:${dashboardId}:${field}`));
    if (!env) return null;
    return env.data;
  },
  isFresh(entry: CachedFilterValues | null): boolean {
    return Boolean(entry && Date.now() - entry.fetchedAt < FILTER_VALUES_TTL_MS);
  },
  save(baseUrl: string, dashboardId: string, field: string, values: string[]): void {
    safeWrite(buildKey(baseUrl, `filterValues:${dashboardId}:${field}`), {
      values,
      fetchedAt: Date.now(),
    });
  },
  clear(baseUrl: string, dashboardId: string, field: string): void {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.removeItem(buildKey(baseUrl, `filterValues:${dashboardId}:${field}`));
    } catch {
      // noop
    }
  },
};

export interface CachedTopicCatalog {
  modelId: string;
  topics: string[];
  fields: Array<{
    field: string;
    label: string;
    view: string;
    topic: string;
    modelId: string;
    dataType?: string;
  }>;
  fetchedAt: number;
}

const TOPIC_CATALOG_TTL_MS = 60 * 60_000;

export const topicCatalogCache = {
  load(baseUrl: string, modelId: string): CachedTopicCatalog | null {
    const env = safeRead<CachedTopicCatalog>(buildKey(baseUrl, `topicCatalog:${modelId}`));
    return env?.data ?? null;
  },
  isFresh(entry: CachedTopicCatalog | null): boolean {
    return Boolean(entry && Date.now() - entry.fetchedAt < TOPIC_CATALOG_TTL_MS);
  },
  save(baseUrl: string, modelId: string, data: Omit<CachedTopicCatalog, 'fetchedAt'>): void {
    safeWrite(buildKey(baseUrl, `topicCatalog:${modelId}`), {
      ...data,
      fetchedAt: Date.now(),
    });
  },
  clear(baseUrl: string, modelId: string): void {
    if (typeof window === 'undefined') return;
    try {
      window.localStorage.removeItem(buildKey(baseUrl, `topicCatalog:${modelId}`));
    } catch {
      // noop
    }
  },
};

export interface DeckFilterDefaultsRecord {
  defaults: Record<string, unknown>;
  dashboard_name: string;
  synced_at: string;
}

export const deckFilterDefaultsCache = {
  load(baseUrl: string, dashboardId: string): DeckFilterDefaultsRecord | null {
    const env = safeRead<DeckFilterDefaultsRecord>(
      buildKey(baseUrl, `filterDefaults:${dashboardId}`),
    );
    return env?.data ?? null;
  },
  save(
    baseUrl: string,
    dashboardId: string,
    dashboardName: string,
    defaults: Record<string, unknown>,
  ): void {
    safeWrite(buildKey(baseUrl, `filterDefaults:${dashboardId}`), {
      defaults,
      dashboard_name: dashboardName,
      synced_at: new Date().toISOString(),
    });
  },
};

export function clearAllDeckCache(baseUrl: string): void {
  if (typeof window === 'undefined') return;
  const prefix = `${PREFIX}:${hostKey(baseUrl)}:`;
  try {
    const keys: string[] = [];
    for (let i = 0; i < window.localStorage.length; i += 1) {
      const k = window.localStorage.key(i);
      if (k && k.startsWith(prefix)) keys.push(k);
    }
    for (const k of keys) window.localStorage.removeItem(k);
  } catch {
    // noop
  }
}
