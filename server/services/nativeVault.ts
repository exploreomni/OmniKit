import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { validateRecipe } from '../../src/services/deckBuilder/deckRecipe';
import type { DeckRecipe } from '../../src/services/deckBuilder/types';
import { clearReadThroughCache } from './readThroughCache';

const VAULT_VERSION = 1;
const SALT_LEN = 16;
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
const SCRYPT_N = 1 << 15;
const SCRYPT_R = 8;
const SCRYPT_P = 1;

const DEFAULT_VAULT_PATH = './data/vault.enc';
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1000;

// Unlock throttling. Key derivation is deliberately expensive, but without a
// backoff an attacker with local API reach can still grind roughly 10-20
// guesses per second against a weak passphrase.
const UNLOCK_FREE_ATTEMPTS = 5;
const UNLOCK_BACKOFF_BASE_MS = 500;
const UNLOCK_BACKOFF_MAX_MS = 30 * 1000;
const UNLOCK_ATTEMPT_RESET_MS = 15 * 60 * 1000;

export type InstanceRole = 'source' | 'destination' | 'both';

export interface InstanceMetricFilter {
  connectionDatabaseContains: string[];
  connectionDatabaseExact: string[];
  embedExternalIdContains: string[];
  embedExternalIdExact: string[];
}

export interface PostMigrationAction {
  kind?: 'webhook' | 'refresh-schema';
  name: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  url: string;
  headers: Record<string, string>;
  body: string;
  destinationInstanceId?: string;
  targetModelId?: string;
  targetModelName?: string;
}

export const VAULT_SESSION_ABORT_SIGNAL: unique symbol = Symbol('omnikit.vaultSessionAbortSignal');

export interface VaultSessionBoundInstance {
  readonly [VAULT_SESSION_ABORT_SIGNAL]?: AbortSignal;
}

export interface SavedInstance extends VaultSessionBoundInstance {
  id: string;
  label: string;
  role: InstanceRole;
  baseUrl: string;
  apiKey: string;
  defaultModelId?: string;
  defaultFolderId?: string;
  defaultFolderPath?: string;
  entityGroupSeparator?: string;
  organizationApiKeyConfirmed?: boolean;
  portfolioAppLabel?: string;
  metricFilter: InstanceMetricFilter;
  postMigrationActions: PostMigrationAction[];
  createdAt: string;
  updatedAt: string;
  lastValidatedAt?: string;
}

export type SavedInstancePublic = Omit<SavedInstance, 'apiKey'> & {
  apiKeyMasked: string;
};

export interface VaultDeckRecipeRecord {
  id: string;
  name: string;
  description?: string;
  savedForInstanceId?: string;
  savedForInstanceLabel?: string;
  savedForBaseUrlHost?: string;
  createdAt: number;
  updatedAt: number;
  recipe: DeckRecipe;
}

export interface SaveDeckRecipeInput {
  id?: string;
  name: string;
  description?: string;
  savedForInstanceId?: string;
  savedForInstanceLabel?: string;
  savedForBaseUrlHost?: string;
  recipe: DeckRecipe;
}

export interface VaultPortfolioOverviewSnapshot {
  fingerprint: string;
  storedAt: number;
  overview: Record<string, unknown>;
}

export interface VaultPortfolioOverviewHistoryMetric {
  value: number | null;
  status: string;
  source: string;
  asOf: string;
  coverage: {
    included: number;
    total: number;
  };
  exclusions: string[];
  reasonCode: string | null;
  reasonLabel?: string;
}

export interface VaultPortfolioOverviewHistoryEntry {
  day: string;
  storedAt: number;
  generatedAt: string;
  coverage: {
    totalInstances: number;
    reportingInstances: number;
    partialInstances: number;
    staleInstances: number;
    unavailableInstances: number;
    savedInstances: number;
    duplicateSavedOrigins: number;
  };
  metrics: Record<string, VaultPortfolioOverviewHistoryMetric>;
  partial: boolean;
  stale: boolean;
}

interface VaultPayload {
  version: typeof VAULT_VERSION;
  instances: SavedInstance[];
  deckRecipes: VaultDeckRecipeRecord[];
  /**
   * Retained as opaque encrypted data so an upgrade never silently discards
   * credentials from the retired BI Migration Studio. The only supported
   * operation is the explicit purge exposed from Data & Privacy.
   */
  llmProviders: unknown[];
  platformConnections: unknown[];
  portfolioOverviewSnapshot?: VaultPortfolioOverviewSnapshot;
  portfolioOverviewHistory: VaultPortfolioOverviewHistoryEntry[];
}

interface UnlockedVault {
  key: Buffer;
  salt: Buffer;
  payload: VaultPayload;
}

let unlockedVault: UnlockedVault | null = null;
let lastVaultActivityAt = 0;
let idleTimer: NodeJS.Timeout | null = null;
let vaultSessionAbortController = new AbortController();

function rotateVaultSessionBoundary(reason: string): void {
  vaultSessionAbortController.abort(new Error(reason));
  vaultSessionAbortController = new AbortController();
}

export function getVaultPath(): string {
  return process.env.OMNIKIT_VAULT_PATH || DEFAULT_VAULT_PATH;
}

/**
 * Resolves the idle auto-lock timeout.
 *
 * Blank and unparseable values fall back to the default rather than disabling
 * the lock. `Number('')` is 0, so a half-filled `.env` or compose file that
 * declares OMNIKIT_VAULT_IDLE_TIMEOUT_MS with no value used to silently turn
 * auto-lock off. Disabling it now requires the explicit string `off`.
 *
 * Small values are honoured as written — "lock sooner" is a legitimate operator
 * choice and the test suite relies on it. Only the upper bound is capped, since
 * an enormous timeout disables the lock without saying so.
 */
export function getVaultIdleTimeoutMs(): number {
  const configured = (process.env.OMNIKIT_VAULT_IDLE_TIMEOUT_MS || '').trim();
  if (!configured) return DEFAULT_IDLE_TIMEOUT_MS;
  if (configured.toLowerCase() === 'off') return 0;
  const raw = Number(configured);
  if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_IDLE_TIMEOUT_MS;
  return Math.min(raw, MAX_IDLE_TIMEOUT_MS);
}

export function vaultExists(): boolean {
  return existsSync(getVaultPath());
}

export function isVaultUnlocked(): boolean {
  enforceIdleTimeout();
  return unlockedVault !== null;
}

function clearIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
}

function scheduleIdleTimer(): void {
  clearIdleTimer();
  const timeout = getVaultIdleTimeoutMs();
  if (!unlockedVault || timeout <= 0) return;
  idleTimer = setTimeout(() => {
    lockVault();
  }, timeout);
  idleTimer.unref?.();
}

function touchVault(): void {
  if (!unlockedVault) return;
  lastVaultActivityAt = Date.now();
  scheduleIdleTimer();
}

export function touchVaultSession() {
  requireUnlocked();
  return vaultStatus();
}

function enforceIdleTimeout(): void {
  if (!unlockedVault) return;
  const timeout = getVaultIdleTimeoutMs();
  if (timeout <= 0) return;
  if (Date.now() - lastVaultActivityAt >= timeout) lockVault();
}

function defaultFilter(): InstanceMetricFilter {
  return {
    connectionDatabaseContains: [],
    connectionDatabaseExact: [],
    embedExternalIdContains: [],
    embedExternalIdExact: [],
  };
}

function normalizeFilter(filter: Partial<InstanceMetricFilter> | undefined): InstanceMetricFilter {
  const clean = (value: unknown) => Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
    : [];
  return {
    connectionDatabaseContains: clean(filter?.connectionDatabaseContains),
    connectionDatabaseExact: clean(filter?.connectionDatabaseExact),
    embedExternalIdContains: clean(filter?.embedExternalIdContains),
    embedExternalIdExact: clean(filter?.embedExternalIdExact),
  };
}

function normalizeActions(actions: unknown): PostMigrationAction[] {
  if (!Array.isArray(actions)) return [];
  return actions
    .filter((action): action is Partial<PostMigrationAction> => Boolean(action) && typeof action === 'object' && !Array.isArray(action))
    .map((action) => ({
      kind: action.kind === 'refresh-schema' ? 'refresh-schema' as const : 'webhook' as const,
      name: typeof action.name === 'string' && action.name.trim() ? action.name.trim() : 'Post-migration action',
      method: normalizeMethod(action.method),
      url: typeof action.url === 'string' ? action.url.trim() : '',
      headers: action.headers && typeof action.headers === 'object' && !Array.isArray(action.headers)
        ? Object.fromEntries(Object.entries(action.headers).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
        : {},
      body: typeof action.body === 'string' ? action.body : '',
      destinationInstanceId: typeof action.destinationInstanceId === 'string' && action.destinationInstanceId.trim() ? action.destinationInstanceId.trim() : undefined,
      targetModelId: typeof action.targetModelId === 'string' && action.targetModelId.trim() ? action.targetModelId.trim() : undefined,
      targetModelName: typeof action.targetModelName === 'string' && action.targetModelName.trim() ? action.targetModelName.trim() : undefined,
    }))
    .filter((action) => action.kind === 'refresh-schema' ? Boolean(action.targetModelId) : Boolean(action.url));
}

function normalizeMethod(value: unknown): PostMigrationAction['method'] {
  const method = typeof value === 'string' ? value.toUpperCase() : 'POST';
  if (method === 'GET' || method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') return method;
  return 'POST';
}

function normalizeRole(value: unknown): InstanceRole {
  return value === 'source' || value === 'destination' || value === 'both' ? value : 'destination';
}

const FORBIDDEN_DECK_RECIPE_KEYS = new Set([
  'apikey',
  'api_key',
  'token',
  'secret',
  'password',
  'passphrase',
]);

function cleanOptionalText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, maxLength) : undefined;
}

function createDeckRecipeId(): string {
  return `recipe_${Date.now()}_${randomUUID().slice(0, 8)}`;
}

export function deckRecipeRecordContainsForbiddenKeys(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((entry) => deckRecipeRecordContainsForbiddenKeys(entry));
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_DECK_RECIPE_KEYS.has(key.toLowerCase())) return true;
    if (deckRecipeRecordContainsForbiddenKeys(child)) return true;
  }
  return false;
}

const PORTFOLIO_SNAPSHOT_KEYS = new Set([
  'schemaVersion', 'generatedAt', 'servedAt', 'cache', 'refresh', 'coverage', 'metrics',
  'instances', 'connections', 'duplicateSavedOrigins', 'failures', 'warnings', 'partial', 'stale',
  'state', 'cachedAt', 'startedAt', 'completedAt', 'completedInstances', 'totalInstances',
  'reportingInstances', 'partialInstances', 'staleInstances', 'unavailableInstances',
  'savedInstances', 'internalMemberships', 'estimatedUniquePeople', 'embedUsers',
  'embedEntities', 'active7d', 'active30d', 'active90d', 'staleUsers90d',
  'neverLoggedInUsers', 'dashboards', 'models', 'topics',
  'aiChats', 'apps', 'value', 'status', 'source', 'asOf', 'included', 'total', 'unit', 'ratio',
  'coverageLabel', 'exclusions', 'reasonCode', 'reasonLabel', 'id', 'label', 'health',
  'statusLabel', 'freshness', 'duplicateSavedOrigin', 'duplicateSavedOriginCount',
  'duplicateInstanceLabels', 'name', 'instanceId', 'instanceLabel', 'readiness',
  'attribution', 'canonicalInstanceId', 'instanceLabels', 'savedInstanceCount', 'metric', 'message',
]);

const PORTFOLIO_SNAPSHOT_MAX_BYTES = 5 * 1024 * 1024;
const PORTFOLIO_HISTORY_MAX_BYTES = 2 * 1024 * 1024;
const PORTFOLIO_HISTORY_MAX_DAYS = 90;
const EMAIL_LIKE_TEXT = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;

function sanitizePortfolioSnapshotValue(value: unknown, depth = 0): unknown {
  if (depth > 14) throw new Error('Portfolio snapshot is too deeply nested.');
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Portfolio snapshot contains a non-finite number.');
    return value;
  }
  if (typeof value === 'string') {
    if (EMAIL_LIKE_TEXT.test(value) || /^https?:\/\//i.test(value.trim())) {
      throw new Error('Portfolio snapshot contains prohibited identity or URL data.');
    }
    return value.slice(0, 1_000);
  }
  if (Array.isArray(value)) {
    if (value.length > 50_000) throw new Error('Portfolio snapshot contains an oversized array.');
    return value.map((entry) => sanitizePortfolioSnapshotValue(entry, depth + 1));
  }
  if (!value || typeof value !== 'object') {
    throw new Error('Portfolio snapshot contains an unsupported value.');
  }
  const output: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (child === undefined) continue;
    if (!PORTFOLIO_SNAPSHOT_KEYS.has(key)) {
      throw new Error(`Portfolio snapshot contains a prohibited key: ${key}`);
    }
    output[key] = sanitizePortfolioSnapshotValue(child, depth + 1);
  }
  return output;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isPortfolioMetricSnapshot(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.coverage)) return false;
  return (value.value === null || typeof value.value === 'number')
    && typeof value.status === 'string'
    && (value.source === undefined || typeof value.source === 'string')
    && typeof value.asOf === 'string'
    && typeof value.coverage.included === 'number'
    && typeof value.coverage.total === 'number'
    && Array.isArray(value.exclusions)
    && (value.reasonCode === null || typeof value.reasonCode === 'string');
}

function isPortfolioFailureSnapshot(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.coverage)) return false;
  return typeof value.id === 'string'
    && typeof value.message === 'string'
    && typeof value.instanceId === 'string'
    && typeof value.instanceLabel === 'string'
    && typeof value.metric === 'string'
    && typeof value.status === 'string'
    && (value.reasonCode === null || typeof value.reasonCode === 'string')
    && (value.reasonLabel === undefined || typeof value.reasonLabel === 'string')
    && Array.isArray(value.exclusions)
    && value.exclusions.every((exclusion) => typeof exclusion === 'string')
    && typeof value.asOf === 'string'
    && typeof value.source === 'string'
    && typeof value.coverage.included === 'number'
    && typeof value.coverage.total === 'number'
    && typeof value.coverage.unit === 'string'
    && (value.coverage.ratio === null || typeof value.coverage.ratio === 'number');
}

const PORTFOLIO_LEGACY_METRIC_SET_KEYS = [
  'internalMemberships', 'estimatedUniquePeople', 'embedUsers', 'embedEntities',
  'active7d', 'active30d', 'active90d', 'dashboards', 'models', 'topics', 'aiChats', 'apps',
];
const PORTFOLIO_LIFECYCLE_METRIC_KEYS = ['staleUsers90d', 'neverLoggedInUsers'];
const PORTFOLIO_METRIC_SET_KEYS = [
  ...PORTFOLIO_LEGACY_METRIC_SET_KEYS,
  ...PORTFOLIO_LIFECYCLE_METRIC_KEYS,
];
const PORTFOLIO_HISTORY_METRIC_KEYS = ['reportingInstances', ...PORTFOLIO_METRIC_SET_KEYS];
const PORTFOLIO_HISTORY_COVERAGE_KEYS = [
  'totalInstances', 'reportingInstances', 'partialInstances', 'staleInstances',
  'unavailableInstances', 'savedInstances', 'duplicateSavedOrigins',
] as const;

function isPortfolioMetricSetSnapshot(value: unknown, includeReporting = false): boolean {
  if (!isRecord(value)) return false;
  const requiredKeys = [...(includeReporting ? ['reportingInstances'] : []), ...PORTFOLIO_LEGACY_METRIC_SET_KEYS];
  return requiredKeys.every((key) => isPortfolioMetricSnapshot(value[key]))
    && PORTFOLIO_LIFECYCLE_METRIC_KEYS.every((key) => (
      value[key] === undefined || isPortfolioMetricSnapshot(value[key])
    ));
}

function isPortfolioConnectionSnapshot(value: unknown): boolean {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.name === 'string'
    && typeof value.instanceId === 'string'
    && typeof value.instanceLabel === 'string'
    && isPortfolioMetricSnapshot(value.dashboards)
    && isPortfolioMetricSnapshot(value.models)
    && isPortfolioMetricSnapshot(value.topics);
}

function isPortfolioInstanceSnapshot(value: unknown): boolean {
  return isRecord(value)
    && typeof value.id === 'string'
    && typeof value.label === 'string'
    && isPortfolioMetricSetSnapshot(value.metrics)
    && Array.isArray(value.connections)
    && value.connections.every(isPortfolioConnectionSnapshot);
}

function isPortfolioOverviewSnapshotShape(value: unknown): value is Record<string, unknown> {
  return isRecord(value)
    && value.schemaVersion === 1
    && typeof value.generatedAt === 'string'
    && typeof value.servedAt === 'string'
    && isRecord(value.cache)
    && isRecord(value.refresh)
    && isRecord(value.coverage)
    && isPortfolioMetricSetSnapshot(value.metrics, true)
    && Array.isArray(value.instances)
    && value.instances.every(isPortfolioInstanceSnapshot)
    && Array.isArray(value.connections)
    && value.connections.every(isPortfolioConnectionSnapshot)
    && Array.isArray(value.duplicateSavedOrigins)
    && (value.failures === undefined
      || (Array.isArray(value.failures) && value.failures.every(isPortfolioFailureSnapshot)))
    && Array.isArray(value.warnings)
    && value.warnings.every((warning) => typeof warning === 'string')
    && typeof value.partial === 'boolean'
    && typeof value.stale === 'boolean';
}

function normalizePortfolioOverviewSnapshot(raw: unknown): VaultPortfolioOverviewSnapshot | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const candidate = raw as Partial<VaultPortfolioOverviewSnapshot>;
  const fingerprint = cleanOptionalText(candidate.fingerprint, 128);
  if (!fingerprint || !/^[a-f0-9]{64}$/i.test(fingerprint) || !Number.isFinite(candidate.storedAt)) return undefined;
  try {
    const overview = sanitizePortfolioSnapshotValue(candidate.overview);
    if (!isPortfolioOverviewSnapshotShape(overview)) return undefined;
    const normalized: VaultPortfolioOverviewSnapshot = {
      fingerprint: fingerprint.toLowerCase(),
      storedAt: Math.max(0, Math.floor(candidate.storedAt!)),
      overview,
    };
    if (Buffer.byteLength(JSON.stringify(normalized), 'utf8') > PORTFOLIO_SNAPSHOT_MAX_BYTES) return undefined;
    return normalized;
  } catch {
    return undefined;
  }
}

function utcDay(storedAt: number): string | null {
  if (!Number.isFinite(storedAt) || storedAt < 0) return null;
  try {
    return new Date(Math.floor(storedAt)).toISOString().slice(0, 10);
  } catch {
    return null;
  }
}

function isPortfolioHistoryTimestamp(value: string): boolean {
  return !EMAIL_LIKE_TEXT.test(value)
    && !/^https?:\/\//i.test(value)
    && Number.isFinite(Date.parse(value));
}

function compactHistoryMetric(raw: unknown): VaultPortfolioOverviewHistoryMetric | null {
  if (!isRecord(raw) || !isRecord(raw.coverage)) return null;
  const metric = raw as Record<string, unknown> & { coverage: Record<string, unknown> };
  const status = cleanOptionalText(metric.status, 80);
  const source = cleanOptionalText(metric.source, 120) || 'legacy_snapshot_unknown';
  const asOf = cleanOptionalText(metric.asOf, 80);
  const included = metric.coverage.included;
  const total = metric.coverage.total;
  const value = metric.value;
  const reasonCode = metric.reasonCode === null ? null : cleanOptionalText(metric.reasonCode, 160);
  const reasonLabel = cleanOptionalText(metric.reasonLabel, 320);
  const rawExclusions = metric.exclusions;
  const exclusions = rawExclusions === undefined
    ? ['LEGACY_HISTORY_PROVENANCE_UNKNOWN']
    : Array.isArray(rawExclusions)
      ? rawExclusions.map((entry) => cleanOptionalText(entry, 160)).filter((entry): entry is string => Boolean(entry))
      : null;
  if (!status
    || !source
    || !asOf
    || EMAIL_LIKE_TEXT.test(status)
    || EMAIL_LIKE_TEXT.test(source)
    || !isPortfolioHistoryTimestamp(asOf)
    || /^https?:\/\//i.test(status)
    || /^https?:\/\//i.test(source)
    || /^https?:\/\//i.test(asOf)
    || (value !== null && (!Number.isFinite(value) || typeof value !== 'number'))
    || !Number.isFinite(included)
    || !Number.isFinite(total)
    || (included as number) < 0
    || (total as number) < 0
    || (metric.reasonCode !== null && (!reasonCode
      || EMAIL_LIKE_TEXT.test(reasonCode)
      || /^https?:\/\//i.test(reasonCode)))
    || exclusions === null
    || (Array.isArray(rawExclusions) && exclusions.length !== rawExclusions.length)
    || exclusions.some((entry) => EMAIL_LIKE_TEXT.test(entry) || /^https?:\/\//i.test(entry))
    || (metric.reasonLabel !== undefined && (!reasonLabel
      || EMAIL_LIKE_TEXT.test(reasonLabel)
      || /^https?:\/\//i.test(reasonLabel)))) return null;
  return {
    value: value as number | null,
    status,
    source,
    asOf,
    coverage: {
      included: Math.max(0, Math.floor(included as number)),
      total: Math.max(0, Math.floor(total as number)),
    },
    exclusions: [...new Set(exclusions)].sort(),
    reasonCode: reasonCode || null,
    ...(reasonLabel ? { reasonLabel } : {}),
  };
}

function compactHistoryCoverage(raw: unknown): VaultPortfolioOverviewHistoryEntry['coverage'] | null {
  if (!isRecord(raw)) return null;
  const result = {} as VaultPortfolioOverviewHistoryEntry['coverage'];
  for (const key of PORTFOLIO_HISTORY_COVERAGE_KEYS) {
    const value = raw[key];
    if (!Number.isFinite(value) || (value as number) < 0) return null;
    result[key] = Math.floor(value as number);
  }
  return result;
}

function buildPortfolioOverviewHistoryEntry(
  snapshot: VaultPortfolioOverviewSnapshot,
): VaultPortfolioOverviewHistoryEntry | null {
  const overview = snapshot.overview;
  if (!isRecord(overview.refresh) || overview.refresh.state !== 'idle') return null;
  const completedInstances = overview.refresh.completedInstances;
  const totalInstances = overview.refresh.totalInstances;
  if (!Number.isInteger(completedInstances)
    || !Number.isInteger(totalInstances)
    || (completedInstances as number) < 0
    || (totalInstances as number) < 0
    || completedInstances !== totalInstances
    || typeof overview.refresh.completedAt !== 'string'
    || !isPortfolioHistoryTimestamp(overview.refresh.completedAt)) return null;
  const day = utcDay(snapshot.storedAt);
  const generatedAt = cleanOptionalText(overview.generatedAt, 80);
  const coverage = compactHistoryCoverage(overview.coverage);
  if (!day
    || !generatedAt
    || !isPortfolioHistoryTimestamp(generatedAt)
    || !coverage
    || coverage.totalInstances !== totalInstances
    || !isRecord(overview.metrics)) return null;
  const metrics: Record<string, VaultPortfolioOverviewHistoryMetric> = {};
  for (const key of PORTFOLIO_HISTORY_METRIC_KEYS) {
    const metric = compactHistoryMetric(overview.metrics[key]);
    if (!metric) return null;
    metrics[key] = metric;
  }
  return {
    day,
    storedAt: snapshot.storedAt,
    generatedAt,
    coverage,
    metrics,
    partial: overview.partial as boolean,
    stale: overview.stale as boolean,
  };
}

function legacyLifecycleHistoryMetric(
  asOf: string,
  totalInstances: number,
): VaultPortfolioOverviewHistoryMetric {
  return {
    value: null,
    status: 'unsupported',
    source: 'legacy_snapshot_unknown',
    asOf,
    coverage: { included: 0, total: totalInstances },
    exclusions: ['ACTIVE_USER_RECORDS_NOT_UNIQUE_PEOPLE', 'LEGACY_HISTORY_METRIC_UNAVAILABLE'],
    reasonCode: 'LEGACY_HISTORY_METRIC_UNAVAILABLE',
    reasonLabel: 'This legacy history entry predates the source-record lifecycle metric',
  };
}

function normalizePortfolioOverviewHistoryEntry(raw: unknown): VaultPortfolioOverviewHistoryEntry | null {
  if (!isRecord(raw)) return null;
  const storedAt = Number.isFinite(raw.storedAt) ? Math.max(0, Math.floor(raw.storedAt as number)) : NaN;
  const day = cleanOptionalText(raw.day, 10);
  const generatedAt = cleanOptionalText(raw.generatedAt, 80);
  const coverage = compactHistoryCoverage(raw.coverage);
  if (!day
    || day !== utcDay(storedAt)
    || !generatedAt
    || !isPortfolioHistoryTimestamp(generatedAt)
    || !coverage
    || !isRecord(raw.metrics)) return null;
  if (typeof raw.partial !== 'boolean' || typeof raw.stale !== 'boolean') return null;
  const metrics: Record<string, VaultPortfolioOverviewHistoryMetric> = {};
  for (const key of PORTFOLIO_HISTORY_METRIC_KEYS) {
    const metric = compactHistoryMetric(raw.metrics[key]);
    if (metric) {
      metrics[key] = metric;
      continue;
    }
    if (PORTFOLIO_LIFECYCLE_METRIC_KEYS.includes(key)) {
      metrics[key] = legacyLifecycleHistoryMetric(generatedAt, coverage.totalInstances);
      continue;
    }
    return null;
  }
  const entry: VaultPortfolioOverviewHistoryEntry = {
    day,
    storedAt,
    generatedAt,
    coverage,
    metrics,
    partial: raw.partial,
    stale: raw.stale,
  };
  return Buffer.byteLength(JSON.stringify(entry), 'utf8') <= PORTFOLIO_HISTORY_MAX_BYTES ? entry : null;
}

function normalizePortfolioOverviewHistory(raw: unknown): VaultPortfolioOverviewHistoryEntry[] {
  if (!Array.isArray(raw)) return [];
  const byDay = new Map<string, VaultPortfolioOverviewHistoryEntry>();
  for (const candidate of raw) {
    const entry = normalizePortfolioOverviewHistoryEntry(candidate);
    const existing = entry ? byDay.get(entry.day) : undefined;
    if (entry && (!existing || entry.storedAt >= existing.storedAt)) byDay.set(entry.day, entry);
  }
  const normalized = [...byDay.values()]
    .sort((left, right) => right.day.localeCompare(left.day) || right.storedAt - left.storedAt)
    .slice(0, PORTFOLIO_HISTORY_MAX_DAYS);
  return Buffer.byteLength(JSON.stringify(normalized), 'utf8') <= PORTFOLIO_HISTORY_MAX_BYTES
    ? normalized
    : [];
}

function normalizeDeckRecipeRecord(raw: Partial<VaultDeckRecipeRecord> & { recipe?: unknown }, existing?: VaultDeckRecipeRecord): VaultDeckRecipeRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  try {
    const now = Date.now();
    const record: VaultDeckRecipeRecord = {
      id: cleanOptionalText(raw.id, 120) || existing?.id || createDeckRecipeId(),
      name: cleanOptionalText(raw.name, 100) || existing?.name || 'Untitled recipe',
      description: cleanOptionalText(raw.description, 240),
      savedForInstanceId: cleanOptionalText(raw.savedForInstanceId, 120),
      savedForInstanceLabel: cleanOptionalText(raw.savedForInstanceLabel, 120),
      savedForBaseUrlHost: cleanOptionalText(raw.savedForBaseUrlHost, 160),
      createdAt: Number.isFinite(raw.createdAt) ? Number(raw.createdAt) : existing?.createdAt || now,
      updatedAt: Number.isFinite(raw.updatedAt) ? Number(raw.updatedAt) : now,
      recipe: validateRecipe(raw.recipe),
    };
    if (deckRecipeRecordContainsForbiddenKeys(record)) {
      throw Object.assign(new Error('Deck recipe contains secret-shaped keys and cannot be stored in the vault.'), { statusCode: 400 });
    }
    return record;
  } catch {
    if (existing) throw Object.assign(new Error('Saved recipe could not be updated because the recipe payload is invalid.'), { statusCode: 400 });
    return null;
  }
}

export function normalizeVaultPayload(raw: unknown): VaultPayload {
  const parsed = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Partial<VaultPayload> : {};
  return {
    version: VAULT_VERSION,
    instances: Array.isArray(parsed.instances)
      ? parsed.instances.map((instance) => normalizeInstance(instance as SavedInstance))
      : [],
    deckRecipes: Array.isArray(parsed.deckRecipes)
      ? parsed.deckRecipes
          .map((record) => normalizeDeckRecipeRecord(record as Partial<VaultDeckRecipeRecord> & { recipe?: unknown }))
          .filter((record): record is VaultDeckRecipeRecord => Boolean(record))
          .sort((a, b) => b.updatedAt - a.updatedAt)
      : [],
    llmProviders: Array.isArray(parsed.llmProviders) ? parsed.llmProviders : [],
    platformConnections: Array.isArray(parsed.platformConnections) ? parsed.platformConnections : [],
    portfolioOverviewSnapshot: normalizePortfolioOverviewSnapshot(parsed.portfolioOverviewSnapshot),
    portfolioOverviewHistory: normalizePortfolioOverviewHistory(parsed.portfolioOverviewHistory),
  };
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase.normalize('NFKC'), salt, KEY_LEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 128 * SCRYPT_N * SCRYPT_R * 2,
  });
}

function encrypt(plaintext: string, key: Buffer): Buffer {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]);
}

function decrypt(blob: Buffer, key: Buffer): string {
  const iv = blob.subarray(0, IV_LEN);
  const tag = blob.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const ciphertext = blob.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

export function decryptVaultBlob(passphrase: string, blob: Buffer): string {
  if (blob.length < SALT_LEN + IV_LEN + TAG_LEN + 1) {
    throw new Error('Vault file is too small or malformed.');
  }
  const salt = blob.subarray(0, SALT_LEN);
  const encrypted = blob.subarray(SALT_LEN);
  const key = deriveKey(passphrase, salt);
  try {
    return decrypt(encrypted, key);
  } finally {
    key.fill(0);
  }
}

/**
 * Writes the vault atomically, mirroring writeJobsFile in ./jobStore.ts.
 *
 * The vault is the only copy of every saved API key, so it must never be
 * truncated in place: a crash, a full disk, or power loss part-way through a
 * direct overwrite would leave an unreadable file with no recovery path. The
 * previous ciphertext is also retained as a single `.bak` generation before the
 * rename, which is what makes an interrupted changeVaultPassphrase recoverable
 * — without it, a failed write leaves ciphertext that neither the old nor the
 * new passphrase can open.
 */
function persist(): void {
  if (!unlockedVault) throw new Error('vault locked');
  const vaultPath = getVaultPath();
  mkdirSync(dirname(vaultPath), { recursive: true });
  const encrypted = encrypt(JSON.stringify(unlockedVault.payload), unlockedVault.key);
  const contents = Buffer.concat([unlockedVault.salt, encrypted]);
  const tempPath = `${vaultPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tempPath, contents, { mode: 0o600 });
    chmodSync(tempPath, 0o600);
    if (existsSync(vaultPath)) {
      const backupPath = `${vaultPath}.bak`;
      try {
        copyFileSync(vaultPath, backupPath);
        chmodSync(backupPath, 0o600);
      } catch {
        // A backup is best effort. Never block the primary write on it.
      }
    }
    renameSync(tempPath, vaultPath);
    chmodSync(vaultPath, 0o600);
  } catch (error) {
    if (existsSync(tempPath)) {
      try {
        rmSync(tempPath, { force: true });
      } catch {
        // Best-effort cleanup only; preserve the original write error.
      }
    }
    throw error;
  }
}

/**
 * Writes a credential-purged payload to both recoverable vault generations.
 * A normal persist intentionally backs up the pre-write vault, which is unsafe
 * for an explicit secret purge because that backup would remain decryptable.
 */
function persistRetiredCredentialPurge(
  payload: VaultPayload,
  renameFile: typeof renameSync = renameSync,
): void {
  if (!unlockedVault) throw new Error('vault locked');
  const vaultPath = getVaultPath();
  const backupPath = `${vaultPath}.bak`;
  mkdirSync(dirname(vaultPath), { recursive: true });
  const encrypted = encrypt(JSON.stringify(payload), unlockedVault.key);
  const contents = Buffer.concat([unlockedVault.salt, encrypted]);
  const nonce = `${process.pid}.${Date.now()}`;
  const primaryTempPath = `${vaultPath}.${nonce}.purge.tmp`;
  const backupTempPath = `${backupPath}.${nonce}.purge.tmp`;
  try {
    writeFileSync(primaryTempPath, contents, { mode: 0o600 });
    chmodSync(primaryTempPath, 0o600);
    writeFileSync(backupTempPath, contents, { mode: 0o600 });
    chmodSync(backupTempPath, 0o600);

    // Replace the recovery generation first. If that replacement fails, both
    // original generations remain intact and the purge reports failure. If the
    // active replacement fails next, the only remaining secret-bearing copy is
    // the visible active vault; a stale recovery copy cannot silently retain
    // credentials after the primary has been purged.
    renameFile(backupTempPath, backupPath);
    chmodSync(backupPath, 0o600);
    renameFile(primaryTempPath, vaultPath);
    chmodSync(vaultPath, 0o600);

    const directory = dirname(vaultPath);
    const base = `${basename(vaultPath)}.`;
    for (const entry of readdirSync(directory)) {
      if (entry.startsWith(base) && entry.endsWith('.tmp')) {
        rmSync(join(directory, entry), { force: true });
      }
    }
  } catch (error) {
    for (const path of [primaryTempPath, backupTempPath]) {
      if (existsSync(path)) {
        try {
          rmSync(path, { force: true });
        } catch {
          // Preserve the purge failure; cleanup remains best effort.
        }
      }
    }
    throw error;
  }
}

function requireUnlocked(): UnlockedVault {
  enforceIdleTimeout();
  if (!unlockedVault) throw Object.assign(new Error('vault locked'), { statusCode: 423 });
  touchVault();
  return unlockedVault;
}

function maskApiKey(apiKey: string): string {
  if (apiKey.length <= 8) return '••••';
  return `${apiKey.slice(0, 4)}••••${apiKey.slice(-4)}`;
}

function labelFromBaseUrl(baseUrl: string): string {
  try {
    const withProtocol = /^https?:\/\//i.test(baseUrl) ? baseUrl : `https://${baseUrl}`;
    return new URL(withProtocol).host;
  } catch {
    return baseUrl;
  }
}

function toPublic(instance: SavedInstance): SavedInstancePublic {
  const { apiKey: _apiKey, ...rest } = instance;
  void _apiKey;
  return { ...rest, apiKeyMasked: maskApiKey(instance.apiKey) };
}

function normalizePortfolioAppLabel(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const label = value.trim();
  if (label.length > 160) throw new Error('App inventory label must be 160 characters or fewer.');
  if (label.includes(',') || [...label].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  })) {
    throw new Error('App inventory label cannot contain commas or control characters.');
  }
  return label;
}

function normalizeInstance(raw: Partial<SavedInstance> & { apiKey?: string }, existing?: SavedInstance): SavedInstance {
  const now = new Date().toISOString();
  const baseUrl = typeof raw.baseUrl === 'string' ? raw.baseUrl.trim().replace(/\/+$/, '') : existing?.baseUrl || '';
  const replacementApiKey = typeof raw.apiKey === 'string' && raw.apiKey.trim() ? raw.apiKey.trim() : undefined;
  const apiKey = replacementApiKey || existing?.apiKey || '';
  if (!baseUrl || !apiKey) throw new Error('Instance Base URL and API key are required.');
  const baseUrlChanged = Boolean(existing && baseUrl !== existing.baseUrl);
  if (baseUrlChanged && !replacementApiKey) {
    throw Object.assign(new Error('Changing an instance Base URL requires a replacement API key.'), { statusCode: 400 });
  }
  const credentialBoundaryChanged = Boolean(existing && (
    baseUrlChanged || apiKey !== existing.apiKey
  ));

  return {
    id: existing?.id || raw.id || randomUUID(),
    label: typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : existing?.label || labelFromBaseUrl(baseUrl),
    role: normalizeRole(raw.role ?? existing?.role),
    baseUrl,
    apiKey,
    defaultModelId: typeof raw.defaultModelId === 'string' && raw.defaultModelId.trim() ? raw.defaultModelId.trim() : undefined,
    defaultFolderId: typeof raw.defaultFolderId === 'string' && raw.defaultFolderId.trim() ? raw.defaultFolderId.trim() : undefined,
    defaultFolderPath: typeof raw.defaultFolderPath === 'string' && raw.defaultFolderPath.trim() ? raw.defaultFolderPath.trim() : undefined,
    entityGroupSeparator: typeof raw.entityGroupSeparator === 'string' && raw.entityGroupSeparator.trim() ? raw.entityGroupSeparator : undefined,
    organizationApiKeyConfirmed: credentialBoundaryChanged ? false : raw.organizationApiKeyConfirmed === true,
    portfolioAppLabel: normalizePortfolioAppLabel(raw.portfolioAppLabel),
    metricFilter: normalizeFilter(raw.metricFilter ?? existing?.metricFilter ?? defaultFilter()),
    postMigrationActions: normalizeActions(raw.postMigrationActions ?? existing?.postMigrationActions ?? []),
    createdAt: existing?.createdAt || raw.createdAt || now,
    updatedAt: now,
    lastValidatedAt: credentialBoundaryChanged ? undefined : raw.lastValidatedAt || existing?.lastValidatedAt,
  };
}

let unlockFailureCount = 0;
let lastUnlockFailureAt = 0;
let unlockBlockedUntil = 0;

/**
 * Rejects rather than sleeps. unlockVault is synchronous, and a sleep would not
 * help anyway — concurrent requests pipeline straight past it. Refusing the
 * attempt outright bounds the guess rate no matter how many callers try at once.
 */
function assertUnlockAttemptAllowed(): void {
  const now = Date.now();
  if (unlockBlockedUntil > now) {
    const seconds = Math.ceil((unlockBlockedUntil - now) / 1000);
    throw Object.assign(
      new Error(`Too many failed unlock attempts. Wait ${seconds} second${seconds === 1 ? '' : 's'} and try again.`),
      { statusCode: 429, retryAfterSeconds: seconds },
    );
  }
  if (lastUnlockFailureAt && now - lastUnlockFailureAt > UNLOCK_ATTEMPT_RESET_MS) {
    unlockFailureCount = 0;
    lastUnlockFailureAt = 0;
  }
}

function recordUnlockFailure(): void {
  unlockFailureCount += 1;
  lastUnlockFailureAt = Date.now();
  if (unlockFailureCount <= UNLOCK_FREE_ATTEMPTS) return;
  const backoff = Math.min(
    UNLOCK_BACKOFF_MAX_MS,
    UNLOCK_BACKOFF_BASE_MS * 2 ** (unlockFailureCount - UNLOCK_FREE_ATTEMPTS - 1),
  );
  unlockBlockedUntil = Date.now() + backoff;
}

function clearUnlockFailures(): void {
  unlockFailureCount = 0;
  lastUnlockFailureAt = 0;
  unlockBlockedUntil = 0;
}

/** Exposed for tests only. */
export function resetUnlockThrottleForTests(): void {
  clearUnlockFailures();
}

export function unlockVault(passphrase: string): void {
  if (!passphrase.trim()) throw new Error('Enter a vault passphrase.');
  assertUnlockAttemptAllowed();
  const vaultPath = getVaultPath();
  mkdirSync(dirname(vaultPath), { recursive: true });

  if (!existsSync(vaultPath)) {
    const salt = randomBytes(SALT_LEN);
    const key = deriveKey(passphrase, salt);
    unlockedVault = {
      key,
      salt,
      payload: {
        version: VAULT_VERSION,
        instances: [],
        deckRecipes: [],
        llmProviders: [],
        platformConnections: [],
        portfolioOverviewHistory: [],
      },
    };
    rotateVaultSessionBoundary('A new vault session replaced the prior authorization boundary.');
    touchVault();
    persist();
    return;
  }

  const blob = readFileSync(vaultPath);
  const salt = blob.subarray(0, SALT_LEN);
  const encrypted = blob.subarray(SALT_LEN);
  const key = deriveKey(passphrase, salt);
  // Only the decrypt step distinguishes a wrong passphrase: AES-GCM verifies the
  // auth tag here, so anything that fails later is corruption, not a bad guess,
  // and must not count against the throttle.
  let json: string;
  try {
    json = decrypt(encrypted, key);
  } catch (error) {
    key.fill(0);
    recordUnlockFailure();
    throw error;
  }
  clearUnlockFailures();
  const parsed = JSON.parse(json) as Partial<VaultPayload>;
  if (parsed.version !== VAULT_VERSION) throw new Error(`Unsupported vault version: ${String(parsed.version)}`);
  unlockedVault = {
    key,
    salt: Buffer.from(salt),
    payload: normalizeVaultPayload(parsed),
  };
  rotateVaultSessionBoundary('A new vault session replaced the prior authorization boundary.');
  touchVault();
}

export function lockVault(): void {
  clearIdleTimer();
  rotateVaultSessionBoundary('The vault was locked.');
  if (unlockedVault?.key) unlockedVault.key.fill(0);
  unlockedVault = null;
  lastVaultActivityAt = 0;
  // Locking is a memory boundary as well as an authorization boundary. Cache
  // keys are credential-bound so a locked vault already blocks new reads, but
  // decrypted Omni content would otherwise sit in process memory until its TTL.
  clearReadThroughCache();
}

export function resetVault(): void {
  lockVault();
  // A reset must not leave the operator throttled out of the fresh vault.
  clearUnlockFailures();
  const vaultPath = getVaultPath();
  // Reset must leave no recoverable ciphertext behind, including the backup
  // generation persist() keeps and any temp file from an interrupted write.
  for (const path of [vaultPath, `${vaultPath}.bak`]) {
    if (existsSync(path)) rmSync(path, { force: true });
  }
  try {
    const directory = dirname(vaultPath);
    const base = `${basename(vaultPath)}.`;
    for (const entry of readdirSync(directory)) {
      if (entry.startsWith(base) && entry.endsWith('.tmp')) {
        rmSync(join(directory, entry), { force: true });
      }
    }
  } catch {
    // A missing or unreadable vault directory means there is nothing to clear.
  }
}

export function changeVaultPassphrase(currentPassphrase: string, nextPassphrase: string): void {
  if (!nextPassphrase.trim()) throw Object.assign(new Error('Enter a new vault passphrase.'), { statusCode: 400 });
  const current = requireUnlocked();
  const verify = deriveKey(currentPassphrase, current.salt);
  if (!timingSafeEqual(verify, current.key)) {
    verify.fill(0);
    throw Object.assign(new Error('Incorrect current passphrase.'), { statusCode: 400 });
  }
  verify.fill(0);
  const oldKey = current.key;
  const oldSalt = current.salt;
  const nextSalt = randomBytes(SALT_LEN);
  const nextKey = deriveKey(nextPassphrase, nextSalt);
  unlockedVault = { key: nextKey, salt: nextSalt, payload: current.payload };
  try {
    persist();
    oldKey.fill(0);
    rotateVaultSessionBoundary('The vault credential boundary changed.');
  } catch (err) {
    unlockedVault = { key: oldKey, salt: oldSalt, payload: current.payload };
    throw err;
  }
}

export function listInstances(): SavedInstancePublic[] {
  return requireUnlocked().payload.instances.map(toPublic);
}

export function getInstance(id: string): SavedInstance | undefined {
  const instance = requireUnlocked().payload.instances.find((candidate) => candidate.id === id);
  return instance ? {
    ...instance,
    [VAULT_SESSION_ABORT_SIGNAL]: vaultSessionAbortController.signal,
  } : undefined;
}

export function getPortfolioOverviewSnapshot(): VaultPortfolioOverviewSnapshot | undefined {
  const snapshot = requireUnlocked().payload.portfolioOverviewSnapshot;
  return snapshot ? structuredClone(snapshot) : undefined;
}

export function getPortfolioOverviewHistory(): VaultPortfolioOverviewHistoryEntry[] {
  return structuredClone(requireUnlocked().payload.portfolioOverviewHistory);
}

export function setPortfolioOverviewSnapshot(raw: VaultPortfolioOverviewSnapshot): void {
  const vault = requireUnlocked();
  const snapshot = normalizePortfolioOverviewSnapshot(raw);
  if (!snapshot) {
    throw Object.assign(new Error('Portfolio overview snapshot is invalid or contains prohibited data.'), { statusCode: 400 });
  }
  vault.payload.portfolioOverviewSnapshot = snapshot;
  const historyEntry = buildPortfolioOverviewHistoryEntry(snapshot);
  if (historyEntry) {
    vault.payload.portfolioOverviewHistory = normalizePortfolioOverviewHistory([
      historyEntry,
      ...vault.payload.portfolioOverviewHistory.filter((entry) => entry.day !== historyEntry.day),
    ]);
  }
  persist();
}

export function clearPortfolioOverviewSnapshot(): void {
  const vault = requireUnlocked();
  if (!vault.payload.portfolioOverviewSnapshot) return;
  delete vault.payload.portfolioOverviewSnapshot;
  persist();
}

export function upsertInstance(raw: Partial<SavedInstance> & { id?: string; apiKey?: string }): SavedInstancePublic {
  const vault = requireUnlocked();
  const existing = raw.id
    ? vault.payload.instances.find((instance) => instance.id === raw.id)
    : vault.payload.instances.find((instance) => instance.baseUrl.toLowerCase() === raw.baseUrl?.toLowerCase());
  const saved = normalizeInstance(raw, existing);
  vault.payload.instances = [
    ...vault.payload.instances.filter((instance) => instance.id !== saved.id),
    saved,
  ].sort((a, b) => a.label.localeCompare(b.label));
  persist();
  rotateVaultSessionBoundary('A saved instance authorization boundary changed.');
  return toPublic(saved);
}

export function deleteInstance(id: string): void {
  const vault = requireUnlocked();
  vault.payload.instances = vault.payload.instances.filter((instance) => instance.id !== id);
  persist();
  rotateVaultSessionBoundary('A saved instance authorization boundary was removed.');
}

export function markInstanceValidated(id: string): SavedInstancePublic {
  const vault = requireUnlocked();
  const existing = vault.payload.instances.find((instance) => instance.id === id);
  if (!existing) throw new Error('Instance not found.');
  existing.lastValidatedAt = new Date().toISOString();
  existing.updatedAt = existing.lastValidatedAt;
  persist();
  return toPublic(existing);
}

export function listDeckRecipes(): VaultDeckRecipeRecord[] {
  return [...requireUnlocked().payload.deckRecipes].sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getDeckRecipe(id: string): VaultDeckRecipeRecord | undefined {
  return requireUnlocked().payload.deckRecipes.find((record) => record.id === id);
}

export function upsertDeckRecipe(raw: SaveDeckRecipeInput): VaultDeckRecipeRecord {
  const vault = requireUnlocked();
  const existing = raw.id ? vault.payload.deckRecipes.find((record) => record.id === raw.id) : undefined;
  const saved = normalizeDeckRecipeRecord(raw, existing);
  if (!saved) throw Object.assign(new Error('Deck recipe payload is invalid.'), { statusCode: 400 });
  vault.payload.deckRecipes = [
    ...vault.payload.deckRecipes.filter((record) => record.id !== saved.id),
    saved,
  ].sort((a, b) => b.updatedAt - a.updatedAt);
  persist();
  return saved;
}

export function renameDeckRecipe(id: string, name: string): VaultDeckRecipeRecord | undefined {
  const vault = requireUnlocked();
  const existing = vault.payload.deckRecipes.find((record) => record.id === id);
  if (!existing) return undefined;
  const saved = normalizeDeckRecipeRecord({ ...existing, name, updatedAt: Date.now() }, existing);
  if (!saved) throw Object.assign(new Error('Deck recipe payload is invalid.'), { statusCode: 400 });
  vault.payload.deckRecipes = vault.payload.deckRecipes.map((record) => record.id === id ? saved : record).sort((a, b) => b.updatedAt - a.updatedAt);
  persist();
  return saved;
}

export function duplicateDeckRecipe(id: string): VaultDeckRecipeRecord | undefined {
  const vault = requireUnlocked();
  const existing = vault.payload.deckRecipes.find((record) => record.id === id);
  if (!existing) return undefined;
  const now = Date.now();
  const copy = normalizeDeckRecipeRecord({
    ...existing,
    id: createDeckRecipeId(),
    name: `Copy of ${existing.name}`.slice(0, 100),
    createdAt: now,
    updatedAt: now,
  });
  if (!copy) throw Object.assign(new Error('Deck recipe payload is invalid.'), { statusCode: 400 });
  vault.payload.deckRecipes = [copy, ...vault.payload.deckRecipes].sort((a, b) => b.updatedAt - a.updatedAt);
  persist();
  return copy;
}

export function deleteDeckRecipe(id: string): void {
  const vault = requireUnlocked();
  vault.payload.deckRecipes = vault.payload.deckRecipes.filter((record) => record.id !== id);
  persist();
}

export function importDeckRecipes(records: unknown[]): VaultDeckRecipeRecord[] {
  const imported: VaultDeckRecipeRecord[] = [];
  for (const record of records) {
    const normalized = normalizeDeckRecipeRecord(record as Partial<VaultDeckRecipeRecord> & { recipe?: unknown });
    if (!normalized) continue;
    imported.push(upsertDeckRecipe(normalized));
  }
  return imported;
}

export function purgeRetiredBiMigrationCredentials(
  dependenciesForTests: { renameFile?: typeof renameSync } = {},
): {
  removedProviderProfiles: number;
  removedSourceConnections: number;
} {
  const vault = requireUnlocked();
  const removedProviderProfiles = vault.payload.llmProviders.length;
  const removedSourceConnections = vault.payload.platformConnections.length;
  const purgedPayload: VaultPayload = {
    ...vault.payload,
    llmProviders: [],
    platformConnections: [],
  };
  // Keep the in-memory authority purged even if the disk rewrite reports an
  // error, so a later ordinary save cannot reintroduce retired credentials.
  vault.payload = purgedPayload;
  persistRetiredCredentialPurge(purgedPayload, dependenciesForTests.renameFile);
  return { removedProviderProfiles, removedSourceConnections };
}

export function vaultStatus() {
  enforceIdleTimeout();
  return {
    unlocked: isVaultUnlocked(),
    exists: vaultExists(),
    path: getVaultPath(),
    idleTimeoutMs: getVaultIdleTimeoutMs(),
    lastActivityAt: lastVaultActivityAt || undefined,
    instanceCount: unlockedVault?.payload.instances.length ?? 0,
    deckRecipeCount: unlockedVault?.payload.deckRecipes.length ?? 0,
    retiredBiMigrationProviderCount: unlockedVault?.payload.llmProviders.length ?? 0,
    retiredBiMigrationSourceCount: unlockedVault?.payload.platformConnections.length ?? 0,
  };
}
