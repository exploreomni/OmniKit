import { createHash } from 'node:crypto';

import {
  clearPortfolioOverviewSnapshot,
  getInstance,
  getPortfolioOverviewSnapshot,
  listInstances,
  setPortfolioOverviewSnapshot,
  type SavedInstancePublic,
} from './nativeVault';
import {
  OmniClient,
  OmniClientError,
  OmniPaginationError,
  type OmniConnectionRecord,
  type OmniDocumentRecord,
  type OmniEmbedUserRecord,
  type OmniIdentityUserRecord,
  type OmniModelRecord,
  type OmniRequestPolicy,
} from './omniClient';

export type PortfolioMetricStatus =
  | 'available'
  | 'partial'
  | 'permission_denied'
  | 'unsupported'
  | 'not_configured'
  | 'stale'
  | 'failed';

export type PortfolioMetricSource =
  | 'saved_instance_inventory'
  | 'omni_connections_api'
  | 'omni_identity_users_api'
  | 'omni_embed_users_api'
  | 'omni_models_api'
  | 'omni_model_topics_api'
  | 'omni_documents_api'
  | 'omni_ai_conversations_api'
  | 'derived_identity_activity'
  | 'derived_normalized_identity'
  | 'derived_embed_entity'
  | 'derived_instance_aggregate'
  | 'derived_multiple_api_reads'
  | 'legacy_snapshot_unknown';

export interface PortfolioMetricCoverage {
  included: number;
  total: number;
  unit: 'instances' | 'connections' | 'endpoints' | 'model_kinds';
  ratio: number | null;
}

export interface PortfolioMetric {
  value: number | null;
  status: PortfolioMetricStatus;
  source: PortfolioMetricSource;
  asOf: string;
  coverage: PortfolioMetricCoverage;
  coverageLabel?: string;
  exclusions: string[];
  reasonCode: string | null;
  reasonLabel?: string;
}

export interface PortfolioMetricSet {
  internalMemberships: PortfolioMetric;
  estimatedUniquePeople: PortfolioMetric;
  embedUsers: PortfolioMetric;
  embedEntities: PortfolioMetric;
  active7d: PortfolioMetric;
  active30d: PortfolioMetric;
  active90d: PortfolioMetric;
  staleUsers90d: PortfolioMetric;
  neverLoggedInUsers: PortfolioMetric;
  dashboards: PortfolioMetric;
  models: PortfolioMetric;
  topics: PortfolioMetric;
  aiChats: PortfolioMetric;
  apps: PortfolioMetric;
}

export interface PortfolioOverviewMetrics extends PortfolioMetricSet {
  reportingInstances: PortfolioMetric;
}

export interface PortfolioConnectionSummary {
  id: string;
  name: string;
  instanceId: string;
  instanceLabel: string;
  readiness: 'ready' | 'attention' | 'unavailable' | 'unknown';
  statusLabel: string;
  freshness: PortfolioMetricStatus;
  asOf: string;
  attribution: 'explicit' | 'unknown';
  dashboards: PortfolioMetric;
  models: PortfolioMetric;
  topics: PortfolioMetric;
}

export interface PortfolioInstanceSummary {
  id: string;
  label: string;
  health: 'healthy' | 'attention' | 'unavailable' | 'unknown';
  statusLabel: string;
  freshness: PortfolioMetricStatus;
  asOf: string;
  duplicateSavedOrigin: boolean;
  duplicateSavedOriginCount: number;
  duplicateInstanceLabels: string[];
  metrics: PortfolioMetricSet;
  connections: PortfolioConnectionSummary[];
}

export interface DuplicateSavedOriginSummary {
  canonicalInstanceId: string;
  instanceLabels: string[];
  savedInstanceCount: number;
}

export interface PortfolioFailureSummary {
  id: string;
  message: string;
  instanceId: string;
  instanceLabel: string;
  metric: keyof PortfolioMetricSet;
  status: 'permission_denied' | 'unsupported' | 'failed';
  reasonCode: string | null;
  reasonLabel?: string;
  exclusions: string[];
  asOf: string;
  source: PortfolioMetricSource;
  coverage: PortfolioMetricCoverage;
}

export interface PortfolioOverview {
  schemaVersion: 1;
  generatedAt: string;
  servedAt: string;
  cache: {
    state: 'fresh' | 'stale';
    cachedAt: string;
  };
  refresh: {
    state: 'idle' | 'running';
    startedAt?: string;
    completedAt?: string;
    completedInstances: number;
    totalInstances: number;
  };
  coverage: {
    totalInstances: number;
    reportingInstances: number;
    partialInstances: number;
    staleInstances: number;
    unavailableInstances: number;
    savedInstances: number;
    duplicateSavedOrigins: number;
  };
  metrics: PortfolioOverviewMetrics;
  instances: PortfolioInstanceSummary[];
  connections: PortfolioConnectionSummary[];
  duplicateSavedOrigins: DuplicateSavedOriginSummary[];
  failures: PortfolioFailureSummary[];
  warnings: string[];
  partial: boolean;
  stale: boolean;
}

type ReadFailureStatus = 'permission_denied' | 'unsupported' | 'failed';

interface ReadResult<T> {
  value?: T;
  status: 'available' | 'partial' | ReadFailureStatus;
  source: PortfolioMetricSource;
  reasonCode: string | null;
  exclusions: string[];
  included: number;
  total: number;
  unit: 'endpoints' | 'model_kinds';
  transientFailure: boolean;
}

interface CanonicalTenant {
  selected: SavedInstancePublic;
  saved: SavedInstancePublic[];
}

interface InstanceScan {
  tenant: CanonicalTenant;
  summary: PortfolioInstanceSummary;
  connections: ReadResult<OmniConnectionRecord[]>;
  identities: ReadResult<OmniIdentityUserRecord[]>;
  embedUsers: ReadResult<OmniEmbedUserRecord[]>;
  models: ReadResult<OmniModelRecord[]>;
  topics: ReadResult<OmniModelRecord[]>;
  dashboards: ReadResult<OmniDocumentRecord[]>;
  aiConversations?: ReadResult<number>;
  apps?: ReadResult<OmniDocumentRecord[]>;
  transientFailure: boolean;
}

interface ScanResult {
  overview: PortfolioOverview;
  transientFailure: boolean;
}

interface CacheEntry {
  fingerprint: string;
  storedAt: number;
  overview: PortfolioOverview;
  kind: 'snapshot' | 'placeholder';
  requiresRefresh?: boolean;
}

interface Flight {
  controller: AbortController;
  promise: Promise<void>;
  startedAt: string;
  completedInstances: number;
  totalInstances: number;
}

interface CompletedRefresh {
  completedAt: string;
  completedInstances: number;
  totalInstances: number;
}

const INSTANCE_CONCURRENCY = 3;
const READ_CONCURRENCY_PER_INSTANCE = 3;
const TOPIC_READ_CONCURRENCY_PER_INSTANCE = 6;
const DEFAULT_CACHE_TTL_MS = 10 * 60_000;
const DEFAULT_STALE_TTL_MS = 60 * 60_000;
// Large Omni organizations can require dozens of 100-record document pages.
// Keep the scan bounded while allowing the background inventory to finish.
const DEFAULT_SCAN_DEADLINE_MS = 180_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;
const DEFAULT_REQUEST_RETRIES = 1;
const PORTFOLIO_COLLECTOR_VERSION = 5;
const UNKNOWN_CONNECTION_NAME = 'Unknown connection';
const METRIC_KEYS: Array<keyof PortfolioMetricSet> = [
  'internalMemberships',
  'estimatedUniquePeople',
  'embedUsers',
  'embedEntities',
  'active7d',
  'active30d',
  'active90d',
  'staleUsers90d',
  'neverLoggedInUsers',
  'dashboards',
  'models',
  'topics',
  'aiChats',
  'apps',
];
const LIFECYCLE_METRIC_KEYS = ['staleUsers90d', 'neverLoggedInUsers'] as const;
const ADOPTION_QUALITY_METRIC_KEYS = new Set<keyof PortfolioMetricSet>([
  'estimatedUniquePeople',
  'embedEntities',
  'active7d',
  'active30d',
  'active90d',
  'staleUsers90d',
  'neverLoggedInUsers',
]);
const PORTFOLIO_METRIC_SOURCES = new Set<PortfolioMetricSource>([
  'saved_instance_inventory',
  'omni_connections_api',
  'omni_identity_users_api',
  'omni_embed_users_api',
  'omni_models_api',
  'omni_model_topics_api',
  'omni_documents_api',
  'omni_ai_conversations_api',
  'derived_identity_activity',
  'derived_normalized_identity',
  'derived_embed_entity',
  'derived_instance_aggregate',
  'derived_multiple_api_reads',
  'legacy_snapshot_unknown',
]);

let cacheEntry: CacheEntry | null = null;
const flights = new Map<string, Flight>();
const completedRefreshes = new Map<string, CompletedRefresh>();

export class PortfolioOverviewError extends Error {
  constructor(readonly code: 'REQUEST_CANCELLED' | 'PORTFOLIO_SCAN_FAILED') {
    super(code);
    this.name = 'PortfolioOverviewError';
  }
}

class PortfolioAbortReason extends Error {
  constructor(readonly code: 'REQUEST_CANCELLED' | 'SCAN_DEADLINE_EXCEEDED') {
    super(code);
    this.name = 'PortfolioAbortReason';
  }
}

function configuredDuration(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function configuredCount(name: string, fallback: number): number {
  return Math.max(0, Math.floor(configuredDuration(name, fallback)));
}

function portfolioRequestPolicy(): OmniRequestPolicy {
  return {
    requestPriority: 'background',
    requestTimeoutMs: Math.min(
      DEFAULT_REQUEST_TIMEOUT_MS,
      Math.max(1, configuredDuration('OMNIKIT_PORTFOLIO_REQUEST_TIMEOUT_MS', DEFAULT_REQUEST_TIMEOUT_MS)),
    ),
    maxReadRetries: Math.min(
      DEFAULT_REQUEST_RETRIES,
      configuredCount('OMNIKIT_PORTFOLIO_REQUEST_RETRIES', DEFAULT_REQUEST_RETRIES),
    ),
  };
}

function cloneOverview(value: PortfolioOverview): PortfolioOverview {
  return structuredClone(value);
}

function sanitizeDisplay(value: string | undefined, fallback: string, maxLength = 160): string {
  const cleaned = (value || '')
    .split('')
    .map((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127 ? ' ' : character;
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  return (cleaned || fallback).slice(0, maxLength);
}

function opaqueId(...parts: string[]): string {
  return createHash('sha256').update(parts.join('\u0000')).digest('hex').slice(0, 24);
}

function canonicalOrigin(value: string): string | null {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    return url.origin.toLowerCase();
  } catch {
    return null;
  }
}

function timestamp(value: string | undefined): number {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

function canonicalTenants(instances: SavedInstancePublic[]): CanonicalTenant[] {
  const groups = new Map<string, SavedInstancePublic[]>();
  for (const instance of instances) {
    const origin = canonicalOrigin(instance.baseUrl);
    const key = origin ? opaqueId('origin', origin) : opaqueId('invalid-origin', instance.id);
    groups.set(key, [...(groups.get(key) || []), instance]);
  }

  return [...groups.values()].map((saved) => {
    const ordered = [...saved].sort((left, right) => (
      timestamp(right.lastValidatedAt) - timestamp(left.lastValidatedAt)
      || timestamp(right.updatedAt) - timestamp(left.updatedAt)
      || timestamp(right.createdAt) - timestamp(left.createdAt)
      || left.id.localeCompare(right.id)
    ));
    return { selected: ordered[0]!, saved: ordered };
  }).sort((left, right) => left.selected.label.localeCompare(right.selected.label));
}

function inventoryFingerprint(instances: SavedInstancePublic[]): string {
  const stable = instances
    .map((instance) => ({
      id: instance.id,
      origin: canonicalOrigin(instance.baseUrl),
      updatedAt: instance.updatedAt,
      lastValidatedAt: instance.lastValidatedAt || null,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return createHash('sha256').update(JSON.stringify({
    collectorVersion: PORTFOLIO_COLLECTOR_VERSION,
    instances: stable,
  })).digest('hex');
}

function currentInventoryFingerprint(): string | null {
  try {
    return inventoryFingerprint(listInstances());
  } catch {
    return null;
  }
}

function coverage(
  included: number,
  total: number,
  unit: PortfolioMetricCoverage['unit'],
): PortfolioMetricCoverage {
  return {
    included,
    total,
    unit,
    ratio: total > 0 ? included / total : null,
  };
}

function coverageLabel(included: number, total: number, unit: PortfolioMetricCoverage['unit']): string | undefined {
  if (total <= 0 || included >= total) return undefined;
  const label = unit === 'model_kinds' ? 'model kinds' : unit;
  return `${included} of ${total} ${label}`;
}

function metric(input: {
  value: number | null;
  status: PortfolioMetricStatus;
  source: PortfolioMetricSource;
  asOf: string;
  included: number;
  total: number;
  unit: PortfolioMetricCoverage['unit'];
  exclusions?: string[];
  reasonCode?: string | null;
  reasonLabel?: string;
  coverageLabel?: string;
}): PortfolioMetric {
  const uniqueExclusions = [...new Set(input.exclusions || [])].sort();
  return {
    value: input.value,
    status: input.status,
    source: input.source,
    asOf: input.asOf,
    coverage: coverage(input.included, input.total, input.unit),
    coverageLabel: input.coverageLabel || coverageLabel(input.included, input.total, input.unit),
    exclusions: uniqueExclusions,
    reasonCode: input.reasonCode ?? null,
    ...(input.reasonLabel ? { reasonLabel: input.reasonLabel } : {}),
  };
}

function classifyReadError(
  error: unknown,
  source: PortfolioMetricSource,
  signal?: AbortSignal,
): Omit<ReadResult<never>, 'value'> {
  const abortReason = signal?.aborted && signal.reason instanceof PortfolioAbortReason
    ? signal.reason
    : error instanceof PortfolioAbortReason
      ? error
      : null;
  if (abortReason) {
    return {
      status: 'failed',
      source,
      reasonCode: abortReason.code,
      exclusions: [],
      included: 0,
      total: 1,
      unit: 'endpoints',
      transientFailure: true,
    };
  }
  if (error instanceof OmniPaginationError) {
    return {
      status: 'failed',
      source,
      reasonCode: 'UPSTREAM_PAGINATION_INCOMPLETE',
      exclusions: [],
      included: 0,
      total: 1,
      unit: 'endpoints',
      transientFailure: true,
    };
  }
  if (error instanceof OmniClientError) {
    if (error.status === 401 || error.status === 403) {
      return {
        status: 'permission_denied',
        source,
        reasonCode: 'UPSTREAM_PERMISSION_DENIED',
        exclusions: [],
        included: 0,
        total: 1,
        unit: 'endpoints',
        transientFailure: false,
      };
    }
    if (error.status === 404 || error.status === 405 || error.status === 501) {
      return {
        status: 'unsupported',
        source,
        reasonCode: 'UPSTREAM_ENDPOINT_UNSUPPORTED',
        exclusions: [],
        included: 0,
        total: 1,
        unit: 'endpoints',
        transientFailure: false,
      };
    }
    if (error.status === 429) {
      return {
        status: 'failed',
        source,
        reasonCode: 'UPSTREAM_RATE_LIMIT_RETRY_EXHAUSTED',
        exclusions: [],
        included: 0,
        total: 1,
        unit: 'endpoints',
        transientFailure: true,
      };
    }
  }
  return {
    status: 'failed',
    source,
    reasonCode: 'UPSTREAM_REQUEST_FAILED',
    exclusions: [],
    included: 0,
    total: 1,
    unit: 'endpoints',
    transientFailure: true,
  };
}

async function captureRead<T>(
  work: () => Promise<T>,
  source: PortfolioMetricSource,
  signal?: AbortSignal,
): Promise<ReadResult<T>> {
  try {
    return {
      value: await work(),
      status: 'available',
      source,
      reasonCode: null,
      exclusions: [],
      included: 1,
      total: 1,
      unit: 'endpoints',
      transientFailure: false,
    };
  } catch (error) {
    return classifyReadError(error, source, signal);
  }
}

function collapseFailures<T>(reads: Array<ReadResult<T>>): Omit<ReadResult<T>, 'value'> {
  const statuses = new Set(reads.map((read) => read.status));
  const reasons = new Set(reads.map((read) => read.reasonCode).filter(Boolean));
  const status: ReadFailureStatus = statuses.size === 1 && statuses.has('permission_denied')
    ? 'permission_denied'
    : statuses.size === 1 && statuses.has('unsupported')
      ? 'unsupported'
      : 'failed';
  return {
    status,
    source: reads.every((read) => read.source === reads[0]?.source)
      ? reads[0]?.source || 'derived_multiple_api_reads'
      : 'derived_multiple_api_reads',
    reasonCode: reasons.size === 1 ? [...reasons][0]! : 'MULTIPLE_UPSTREAM_FAILURES',
    exclusions: [...new Set(reads.flatMap((read) => read.exclusions))],
    included: 0,
    total: reads.length,
    unit: reads.every((read) => read.unit === reads[0]?.unit)
      ? reads[0]?.unit || 'endpoints'
      : 'endpoints',
    transientFailure: reads.some((read) => read.transientFailure),
  };
}

function dedupeById<T extends { id: string }>(records: T[]): T[] {
  return [...new Map(records.map((record) => [record.id, record])).values()];
}

async function readSemanticModels(client: OmniClient, signal?: AbortSignal): Promise<ReadResult<OmniModelRecord[]>> {
  const [shared, extension] = await Promise.all([
    captureRead(() => client.listModels({ modelKind: 'SHARED' }, signal), 'omni_models_api', signal),
    captureRead(() => client.listModels({ modelKind: 'SHARED_EXTENSION' }, signal), 'omni_models_api', signal),
  ]);
  const successful = [shared, extension].filter((read) => read.value !== undefined);
  if (successful.length === 0) return {
    ...collapseFailures([shared, extension]),
    unit: 'model_kinds',
  };
  const records = dedupeById(successful.flatMap((read) => read.value || []))
    .filter((model) => !model.deletedAt && ['SHARED', 'SHARED_EXTENSION'].includes((model.kind || '').toUpperCase()));
  return {
    value: records,
    status: successful.length === 2 ? 'available' : 'partial',
    source: 'omni_models_api',
    reasonCode: successful.length === 2 ? null : 'PARTIAL_MODEL_KIND_COVERAGE',
    exclusions: ['DELETED_MODELS', 'NON_SHARED_MODEL_KINDS'],
    included: successful.length,
    total: 2,
    unit: 'model_kinds',
    transientFailure: [shared, extension].some((read) => read.transientFailure),
  };
}

async function readTopicsForModels(
  client: OmniClient,
  modelsRead: ReadResult<OmniModelRecord[]>,
  signal?: AbortSignal,
): Promise<ReadResult<OmniModelRecord[]>> {
  if (modelsRead.value === undefined) {
    return {
      status: modelsRead.status,
      source: modelsRead.source,
      reasonCode: modelsRead.reasonCode,
      exclusions: [...modelsRead.exclusions, 'TOPICS_REQUIRE_MODEL_INVENTORY'],
      included: 0,
      total: modelsRead.total,
      unit: modelsRead.unit,
      transientFailure: modelsRead.transientFailure,
    };
  }

  const models = modelsRead.value.filter((model) => !model.deletedAt);
  if (models.length === 0) {
    return {
      value: [],
      status: modelsRead.status === 'available' ? 'available' : 'partial',
      source: 'omni_model_topics_api',
      reasonCode: modelsRead.reasonCode,
      exclusions: [...modelsRead.exclusions, 'TOPICS_COUNTED_BY_MODEL_ENDPOINT'],
      included: 0,
      total: 0,
      unit: 'endpoints',
      transientFailure: modelsRead.transientFailure,
    };
  }

  const reads = await mapLimit(models, TOPIC_READ_CONCURRENCY_PER_INSTANCE, async (model) => ({
    model,
    read: await captureRead(
      () => client.listModelTopicSummaries(model.id, signal),
      'omni_model_topics_api',
      signal,
    ),
  }));
  const successful = reads.filter((entry) => entry.read.value !== undefined);
  if (successful.length === 0) {
    const collapsed = collapseFailures(reads.map((entry) => entry.read));
    return {
      ...collapsed,
      source: 'omni_model_topics_api',
      exclusions: [...collapsed.exclusions, 'TOPICS_COUNTED_BY_MODEL_ENDPOINT'],
      total: models.length,
      unit: 'endpoints',
      transientFailure: modelsRead.transientFailure || collapsed.transientFailure,
    };
  }

  const records = successful.flatMap(({ model, read }) => (read.value || []).map((topic): OmniModelRecord => ({
    id: opaqueId('topic', model.id, topic.name),
    name: topic.label || topic.name,
    identifier: topic.name,
    connectionId: model.connectionId,
    connectionName: model.connectionName,
    baseModelId: model.id,
    kind: 'TOPIC',
    deletedAt: null,
  })));
  const complete = successful.length === models.length && modelsRead.status === 'available';
  return {
    value: records,
    status: complete ? 'available' : 'partial',
    source: 'omni_model_topics_api',
    reasonCode: complete ? 'TOPIC_MODEL_RECORDS' : 'PARTIAL_TOPIC_MODEL_COVERAGE',
    exclusions: [
      ...modelsRead.exclusions,
      'TOPICS_COUNTED_BY_MODEL_ENDPOINT',
      ...(successful.length < models.length ? ['MODELS_WITH_UNREADABLE_TOPICS'] : []),
    ],
    included: successful.length,
    total: models.length,
    unit: 'endpoints',
    transientFailure: modelsRead.transientFailure || reads.some((entry) => entry.read.transientFailure),
  };
}

function createLimiter(limit: number) {
  let active = 0;
  const queue: Array<() => void> = [];
  const advance = () => {
    active -= 1;
    queue.shift()?.();
  };
  return function run<T>(work: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        active += 1;
        work().then(resolve, reject).finally(advance);
      };
      if (active < limit) start();
      else queue.push(start);
    });
  };
}

async function mapLimit<T, R>(items: T[], limit: number, work: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const run = createLimiter(limit);
  return Promise.all(items.map((item, index) => run(() => work(item, index))));
}

function readMetric<T>(
  read: ReadResult<T>,
  value: number | null,
  asOf: string,
  exclusions: string[] = [],
  reasonCode = read.reasonCode,
  source = read.source,
): PortfolioMetric {
  return metric({
    value: read.value === undefined ? null : value,
    status: read.status,
    source,
    asOf,
    included: read.included,
    total: read.total,
    unit: read.unit,
    exclusions: [...read.exclusions, ...exclusions],
    reasonCode,
  });
}

function normalizeEmail(value: string | undefined): string | null {
  const normalized = (value || '').trim().toLowerCase();
  return /^[^@\s]+@[^@\s]+$/.test(normalized) ? normalized : null;
}

function parseDate(value: string | null | undefined): number | null {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function activeCount(
  identities: OmniIdentityUserRecord[],
  embedUsers: OmniEmbedUserRecord[],
  days: number,
  now: number,
): number {
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  return identities.filter((user) => user.active && (parseDate(user.lastLogin) || 0) >= cutoff).length
    + embedUsers.filter((user) => user.active && (parseDate(user.lastLogin) || 0) >= cutoff).length;
}

function combinedActivityMetric(
  identities: ReadResult<OmniIdentityUserRecord[]>,
  embedUsers: ReadResult<OmniEmbedUserRecord[]>,
  days: number,
  now: number,
  asOf: string,
): PortfolioMetric {
  const availableReads = [identities, embedUsers].filter((read) => read.value !== undefined);
  if (availableReads.length === 0) {
    const failure = collapseFailures([identities, embedUsers]);
    return readMetric(
      failure,
      null,
      asOf,
      ['ACTIVE_USER_RECORDS_NOT_UNIQUE_PEOPLE'],
      failure.reasonCode,
      'derived_identity_activity',
    );
  }
  const users = [...(identities.value || []), ...(embedUsers.value || [])].filter((user) => user.active);
  const usersWithActivityEvidence = users.filter((user) => parseDate(user.lastLogin) !== null);
  if (users.length > 0 && usersWithActivityEvidence.length === 0) {
    return metric({
      value: null,
      status: 'unsupported',
      source: 'derived_identity_activity',
      asOf,
      included: availableReads.length,
      total: 2,
      unit: 'endpoints',
      exclusions: ['ACTIVE_USER_RECORDS_NOT_UNIQUE_PEOPLE', 'USERS_WITHOUT_LAST_LOGIN'],
      reasonCode: 'LAST_LOGIN_EVIDENCE_UNAVAILABLE',
      reasonLabel: 'The user inventory did not expose last-login timestamps',
    });
  }
  const value = activeCount(identities.value || [], embedUsers.value || [], days, now);
  const hasCompleteActivityEvidence = usersWithActivityEvidence.length === users.length;
  const status = availableReads.length === 2
    && availableReads.every((read) => read.status === 'available')
    && hasCompleteActivityEvidence
    ? 'available'
    : 'partial';
  return metric({
    value,
    status,
    source: 'derived_identity_activity',
    asOf,
    included: availableReads.length,
    total: 2,
    unit: 'endpoints',
    exclusions: [
      'ACTIVE_USER_RECORDS_NOT_UNIQUE_PEOPLE',
      ...(!hasCompleteActivityEvidence ? ['USERS_WITHOUT_LAST_LOGIN'] : []),
    ],
    reasonCode: status === 'partial' ? 'PARTIAL_USER_ACTIVITY_COVERAGE' : null,
    ...(status === 'partial' ? { reasonLabel: 'Some user records did not expose last-login timestamps' } : {}),
  });
}

type PortfolioUserRecord = OmniIdentityUserRecord | OmniEmbedUserRecord;

function hasNoLastLogin(user: PortfolioUserRecord): boolean {
  return user.lastLogin === null
    || user.lastLogin === undefined
    || (typeof user.lastLogin === 'string' && user.lastLogin.trim() === '');
}

function lifecycleUserRecordMetric(
  identities: ReadResult<OmniIdentityUserRecord[]>,
  embedUsers: ReadResult<OmniEmbedUserRecord[]>,
  kind: 'stale_90d' | 'never_logged_in',
  now: number,
  asOf: string,
): PortfolioMetric {
  const availableReads = [identities, embedUsers].filter((read) => read.value !== undefined);
  const baseExclusions = ['ACTIVE_USER_RECORDS_NOT_UNIQUE_PEOPLE', 'INACTIVE_USER_RECORDS'];
  if (availableReads.length === 0) {
    const failure = collapseFailures([identities, embedUsers]);
    return readMetric(
      failure,
      null,
      asOf,
      baseExclusions,
      failure.reasonCode,
      'derived_identity_activity',
    );
  }

  const activeRecords: PortfolioUserRecord[] = [
    ...(identities.value || []),
    ...(embedUsers.value || []),
  ].filter((user) => user.active);
  const recordsWithoutLastLogin = activeRecords.filter(hasNoLastLogin);
  const recordsWithInvalidLastLogin = activeRecords.filter((user) => (
    !hasNoLastLogin(user) && parseDate(user.lastLogin) === null
  ));
  const completeEndpointCoverage = availableReads.length === 2
    && availableReads.every((read) => read.status === 'available');

  if (kind === 'never_logged_in') {
    const completeEvidence = completeEndpointCoverage && recordsWithInvalidLastLogin.length === 0;
    return metric({
      value: recordsWithoutLastLogin.length,
      status: completeEvidence ? 'available' : 'partial',
      source: 'derived_identity_activity',
      asOf,
      included: availableReads.length,
      total: 2,
      unit: 'endpoints',
      exclusions: [
        ...baseExclusions,
        ...(recordsWithInvalidLastLogin.length > 0 ? ['USERS_WITH_UNPARSEABLE_LAST_LOGIN'] : []),
      ],
      reasonCode: completeEvidence
        ? 'ACTIVE_USER_RECORDS_WITHOUT_LAST_LOGIN'
        : 'PARTIAL_NEVER_LOGGED_IN_USER_RECORD_COVERAGE',
      reasonLabel: completeEvidence
        ? 'Active internal and embed user records with no last-login value; records are not deduplicated people'
        : 'Partial count of active source records with no last-login value; records are not deduplicated people',
    });
  }

  const recordsWithParseableLastLogin = activeRecords.filter((user) => parseDate(user.lastLogin) !== null);
  const cutoff = now - 90 * 24 * 60 * 60 * 1000;
  const staleRecords = recordsWithParseableLastLogin.filter((user) => (parseDate(user.lastLogin) || 0) < cutoff);
  const completeEvidence = completeEndpointCoverage && recordsWithInvalidLastLogin.length === 0;
  return metric({
    value: staleRecords.length,
    status: completeEvidence ? 'available' : 'partial',
    source: 'derived_identity_activity',
    asOf,
    included: availableReads.length,
    total: 2,
    unit: 'endpoints',
    exclusions: [
      ...baseExclusions,
      ...(recordsWithoutLastLogin.length > 0 ? ['USERS_WITHOUT_LAST_LOGIN'] : []),
      ...(recordsWithInvalidLastLogin.length > 0 ? ['USERS_WITH_UNPARSEABLE_LAST_LOGIN'] : []),
    ],
    reasonCode: completeEvidence
      ? 'ACTIVE_USER_RECORDS_STALE_90D'
      : 'PARTIAL_STALE_USER_RECORD_COVERAGE',
    reasonLabel: completeEvidence
      ? 'Active internal and embed user records with a parseable last-login timestamp older than 90 days; records are not deduplicated people'
      : 'Partial count of active source records with a parseable last-login timestamp older than 90 days; records are not deduplicated people',
  });
}

function estimatedPeopleMetric(read: ReadResult<OmniIdentityUserRecord[]>, asOf: string): PortfolioMetric {
  if (!read.value) return readMetric(read, null, asOf, [], 'ESTIMATED_FROM_NORMALIZED_EMAIL');
  const emails = read.value.map((user) => normalizeEmail(user.email)).filter((email): email is string => Boolean(email));
  const missing = emails.length < read.value.length;
  return metric({
    value: new Set(emails).size,
    status: read.status === 'available' && !missing ? 'available' : 'partial',
    source: 'derived_normalized_identity',
    asOf,
    included: read.included,
    total: read.total,
    unit: read.unit,
    exclusions: missing ? ['MEMBERSHIPS_WITHOUT_NORMALIZED_EMAIL'] : [],
    reasonCode: 'ESTIMATED_FROM_NORMALIZED_EMAIL',
    reasonLabel: 'Estimated by normalized email across internal memberships',
  });
}

function embedEntitiesMetric(read: ReadResult<OmniEmbedUserRecord[]>, asOf: string): PortfolioMetric {
  if (!read.value) return readMetric(read, null, asOf);
  const entities = read.value.map((user) => user.embedEntity.trim().toLowerCase()).filter(Boolean);
  const missing = entities.length < read.value.length;
  return metric({
    value: new Set(entities).size,
    status: read.status === 'available' && !missing ? 'available' : 'partial',
    source: 'derived_embed_entity',
    asOf,
    included: read.included,
    total: read.total,
    unit: read.unit,
    exclusions: missing ? ['EMBED_USERS_WITHOUT_EMBED_ENTITY'] : [],
    reasonCode: missing ? 'PARTIAL_EMBED_ENTITY_COVERAGE' : null,
  });
}

function aiConversationMetric(
  read: ReadResult<number> | undefined,
  identities: ReadResult<OmniIdentityUserRecord[]>,
  asOf: string,
): PortfolioMetric {
  if (identities.value === undefined) {
    return metric({
      value: null,
      status: identities.status,
      source: 'omni_identity_users_api',
      asOf,
      included: 0,
      total: 1,
      unit: 'endpoints',
      exclusions: ['AI_CONVERSATION_COUNT_NOT_REQUESTED_WITHOUT_ORG_SCOPE_EVIDENCE'],
      reasonCode: 'AI_CONVERSATION_SCOPE_UNVERIFIED',
      reasonLabel: 'Organization scope could not be verified through the user inventory endpoint',
      coverageLabel: 'Organization scope unverified',
    });
  }
  if (!read || read.value === undefined) {
    return readMetric(read || {
      status: 'failed',
      source: 'omni_ai_conversations_api',
      reasonCode: 'AI_CONVERSATION_COUNT_NOT_COLLECTED',
      exclusions: [],
      included: 0,
      total: 1,
      unit: 'endpoints',
      transientFailure: true,
    }, null, asOf);
  }
  return metric({
    value: read.value,
    status: read.status,
    source: read.source,
    asOf,
    included: read.included,
    total: read.total,
    unit: read.unit,
    exclusions: ['CONVERSATION_THREADS_NOT_MESSAGES', 'PROMPT_CONTENT_NOT_RETAINED'],
    reasonCode: read.reasonCode,
    reasonLabel: 'Organization-wide conversation threads; prompt content is not retained',
  });
}

function appInventoryMetric(
  tenant: CanonicalTenant,
  documentRead: ReadResult<OmniDocumentRecord[]> | undefined,
  labelRead: ReadResult<OmniDocumentRecord[]> | undefined,
  asOf: string,
): PortfolioMetric {
  if (documentRead?.value !== undefined) {
    const activeDocuments = dedupeById(documentRead.value).filter((document) => !document.deleted);
    const documentsWithAppMetadata = activeDocuments.filter((document) => typeof document.hasApp === 'boolean');
    const missingMetadata = activeDocuments.length - documentsWithAppMetadata.length;
    if (activeDocuments.length === 0 || documentsWithAppMetadata.length > 0) {
      return metric({
        value: documentsWithAppMetadata.filter((document) => document.hasApp === true).length,
        status: documentRead.status === 'available' && missingMetadata === 0 ? 'available' : 'partial',
        source: documentRead.source,
        asOf,
        included: documentRead.included,
        total: documentRead.total,
        unit: documentRead.unit,
        exclusions: [
          'DELETED_DOCUMENTS',
          'APPS_BETA_DOCUMENT_METADATA',
          ...(missingMetadata > 0 ? ['DOCUMENTS_WITHOUT_HAS_APP_METADATA'] : []),
        ],
        reasonCode: missingMetadata > 0 ? 'APP_DOCUMENT_METADATA_PARTIAL' : 'APPS_FROM_DOCUMENT_METADATA',
        reasonLabel: 'App workbooks detected automatically from Omni document metadata',
      });
    }
  }

  const configuredLabel = tenant.selected.portfolioAppLabel;
  if (!configuredLabel) {
    if (documentRead?.value === undefined) {
      return readMetric(documentRead || {
        status: 'failed',
        source: 'omni_documents_api',
        reasonCode: 'APP_INVENTORY_NOT_COLLECTED',
        exclusions: [],
        included: 0,
        total: 1,
        unit: 'endpoints',
        transientFailure: true,
      }, null, asOf);
    }
    return metric({
      value: null,
      status: 'unsupported',
      source: 'omni_documents_api',
      asOf,
      included: 0,
      total: 1,
      unit: 'endpoints',
      exclusions: ['APP_DOCUMENT_METADATA_UNAVAILABLE'],
      reasonCode: 'APP_DOCUMENT_METADATA_UNAVAILABLE',
      reasonLabel: 'This Omni instance did not return App metadata for its documents',
      coverageLabel: 'App metadata unavailable',
    });
  }
  if (!labelRead || labelRead.value === undefined) {
    return readMetric(labelRead || {
      status: 'failed',
      source: 'omni_documents_api',
      reasonCode: 'APP_INVENTORY_NOT_COLLECTED',
      exclusions: [],
      included: 0,
      total: 1,
      unit: 'endpoints',
      transientFailure: true,
    }, null, asOf);
  }

  const activeDocuments = dedupeById(labelRead.value).filter((document) => !document.deleted);
  const matchingDocuments = activeDocuments.filter((document) => document.labels?.includes(configuredLabel));
  const mismatched = activeDocuments.length - matchingDocuments.length;
  return metric({
    value: matchingDocuments.length,
    status: labelRead.status === 'available' && mismatched === 0 ? 'available' : 'partial',
    source: labelRead.source,
    asOf,
    included: labelRead.included,
    total: labelRead.total,
    unit: labelRead.unit,
    exclusions: [
      'APPS_DEFINED_BY_LEGACY_DOCUMENT_LABEL_FALLBACK',
      'DELETED_DOCUMENTS',
      ...(mismatched > 0 ? ['DOCUMENTS_WITHOUT_EXACT_APP_LABEL_MATCH'] : []),
    ],
    reasonCode: mismatched > 0 ? 'APP_LABEL_FILTER_MISMATCH' : labelRead.reasonCode,
    reasonLabel: `Workbooks labeled ${configuredLabel}`,
  });
}

function failureStatus(metrics: PortfolioMetric[]): PortfolioMetricStatus {
  if (metrics.every((entry) => entry.status === 'permission_denied')) return 'permission_denied';
  if (metrics.every((entry) => entry.status === 'unsupported')) return 'unsupported';
  if (metrics.every((entry) => entry.status === 'not_configured')) return 'not_configured';
  return 'failed';
}

function connectionReadiness(metrics: PortfolioMetric[]): PortfolioConnectionSummary['readiness'] {
  if (metrics.every((entry) => entry.value === null)) return 'unavailable';
  if (metrics.every((entry) => entry.status === 'available')) return 'ready';
  return 'attention';
}

interface ConnectionBucket {
  internalKey: string;
  id: string;
  name: string;
  attribution: 'explicit' | 'unknown';
  models: number;
  topics: number;
  dashboards: number;
}

function buildConnectionSummaries(input: {
  instanceId: string;
  instanceLabel: string;
  asOf: string;
  connections: ReadResult<OmniConnectionRecord[]>;
  models: ReadResult<OmniModelRecord[]>;
  topics: ReadResult<OmniModelRecord[]>;
  dashboards: ReadResult<OmniDocumentRecord[]>;
}): PortfolioConnectionSummary[] {
  const buckets = new Map<string, ConnectionBucket>();
  const connectionNames = new Map<string, string>();
  for (const connection of input.connections.value || []) {
    if (connection.deletedAt) continue;
    const name = sanitizeDisplay(connection.name, 'Unnamed connection');
    connectionNames.set(connection.id, name);
    buckets.set(`id:${connection.id}`, {
      internalKey: `id:${connection.id}`,
      id: opaqueId(input.instanceId, 'connection', connection.id),
      name,
      attribution: 'explicit',
      models: 0,
      topics: 0,
      dashboards: 0,
    });
  }

  const resolveBucket = (record: { connectionId?: string; connectionName?: string }): ConnectionBucket => {
    if (record.connectionId && connectionNames.has(record.connectionId)) {
      return buckets.get(`id:${record.connectionId}`)!;
    }
    if (record.connectionName) {
      const name = sanitizeDisplay(record.connectionName, 'Unnamed connection');
      const key = `name:${name.toLowerCase()}`;
      if (!buckets.has(key)) {
        buckets.set(key, {
          internalKey: key,
          id: opaqueId(input.instanceId, 'connection-name', name.toLowerCase()),
          name,
          attribution: 'explicit',
          models: 0,
          topics: 0,
          dashboards: 0,
        });
      }
      return buckets.get(key)!;
    }
    const key = 'unknown';
    if (!buckets.has(key)) {
      buckets.set(key, {
        internalKey: key,
        id: opaqueId(input.instanceId, 'unknown-connection'),
        name: UNKNOWN_CONNECTION_NAME,
        attribution: 'unknown',
        models: 0,
        topics: 0,
        dashboards: 0,
      });
    }
    return buckets.get(key)!;
  };

  for (const model of input.models.value || []) resolveBucket(model).models += 1;
  for (const topic of input.topics.value || []) resolveBucket(topic).topics += 1;
  for (const dashboard of input.dashboards.value || []) resolveBucket(dashboard).dashboards += 1;

  const resourceMetric = (
    read: ReadResult<unknown[]>,
    count: number,
    bucket: ConnectionBucket,
    exclusions: string[],
    availableReasonCode: string | null = null,
  ) => metric({
    value: read.value === undefined ? null : count,
    status: read.status,
    source: read.source,
    asOf: input.asOf,
    included: read.value === undefined ? 0 : 1,
    total: 1,
    unit: 'connections',
    exclusions: [
      ...read.exclusions,
      ...exclusions,
      ...(bucket.attribution === 'unknown' && count > 0 ? ['MISSING_EXPLICIT_CONNECTION_ATTRIBUTION'] : []),
    ],
    reasonCode: read.value === undefined
      ? read.reasonCode
      : bucket.attribution === 'unknown' && count > 0
        ? 'UNKNOWN_CONNECTION_ATTRIBUTION'
        : availableReasonCode || read.reasonCode,
  });

  return [...buckets.values()].map((bucket) => {
    const dashboards = resourceMetric(
      input.dashboards,
      bucket.dashboards,
      bucket,
      ['DELETED_DOCUMENTS', 'DOCUMENTS_WITHOUT_HAS_DASHBOARD_TRUE'],
    );
    const models = resourceMetric(
      input.models,
      bucket.models,
      bucket,
      ['DELETED_MODELS', 'NON_SHARED_MODEL_KINDS'],
    );
    const topics = resourceMetric(
      input.topics,
      bucket.topics,
      bucket,
      ['DELETED_TOPICS', 'TOPICS_COUNTED_BY_MODEL_ENDPOINT'],
      'TOPIC_MODEL_RECORDS',
    );
    const readiness = connectionReadiness([dashboards, models, topics]);
    return {
      id: bucket.id,
      name: bucket.name,
      instanceId: input.instanceId,
      instanceLabel: input.instanceLabel,
      readiness,
      statusLabel: readiness === 'ready' ? 'Ready' : readiness === 'attention' ? 'Partial coverage' : 'Unavailable',
      freshness: readiness === 'ready' ? 'available' : readiness === 'attention' ? 'partial' : failureStatus([dashboards, models, topics]),
      asOf: input.asOf,
      attribution: bucket.attribution,
      dashboards,
      models,
      topics,
    };
  }).sort((left, right) => (
    Number(left.attribution === 'unknown') - Number(right.attribution === 'unknown')
    || left.name.localeCompare(right.name)
  ));
}

interface InstanceReadState {
  connections?: ReadResult<OmniConnectionRecord[]>;
  identities?: ReadResult<OmniIdentityUserRecord[]>;
  embedUsers?: ReadResult<OmniEmbedUserRecord[]>;
  models?: ReadResult<OmniModelRecord[]>;
  topics?: ReadResult<OmniModelRecord[]>;
  documents?: ReadResult<OmniDocumentRecord[]>;
  aiConversations?: ReadResult<number>;
  apps?: ReadResult<OmniDocumentRecord[]>;
}

function pendingRead<T>(
  source: PortfolioMetricSource,
  unit: ReadResult<T>['unit'] = 'endpoints',
  total = 1,
): ReadResult<T> {
  return {
    status: 'partial',
    source,
    reasonCode: 'REFRESH_IN_PROGRESS',
    exclusions: [],
    included: 0,
    total,
    unit,
    transientFailure: false,
  };
}

function buildInstanceScan(
  tenant: CanonicalTenant,
  asOf: string,
  now: number,
  state: InstanceReadState,
): InstanceScan {
  const instanceId = tenant.selected.id;
  const instanceLabel = sanitizeDisplay(tenant.selected.label, 'Unnamed instance');
  const requiredReads = 7 + (tenant.selected.portfolioAppLabel ? 1 : 0);
  const pending = Object.values(state).length < requiredReads;
  const connectionsSource = state.connections || pendingRead<OmniConnectionRecord[]>('omni_connections_api');
  const identities = state.identities || pendingRead<OmniIdentityUserRecord[]>('omni_identity_users_api');
  const embedUsers = state.embedUsers || pendingRead<OmniEmbedUserRecord[]>('omni_embed_users_api');
  const models = state.models || pendingRead<OmniModelRecord[]>('omni_models_api', 'model_kinds', 2);
  const topicsSource = state.topics || pendingRead<OmniModelRecord[]>('omni_model_topics_api');
  const documentsSource = state.documents || pendingRead<OmniDocumentRecord[]>('omni_documents_api');
  const connections = connectionsSource.value === undefined ? connectionsSource : {
    ...connectionsSource,
    value: dedupeById(connectionsSource.value).filter((connection) => !connection.deletedAt),
    exclusions: ['DELETED_CONNECTIONS'],
  };
  const topics = topicsSource.value === undefined ? topicsSource : {
    ...topicsSource,
    value: dedupeById(topicsSource.value)
      .filter((topic) => !topic.deletedAt && (topic.kind || '').toUpperCase() === 'TOPIC'),
    reasonCode: topicsSource.reasonCode || 'TOPIC_MODEL_RECORDS',
    exclusions: [...topicsSource.exclusions, 'DELETED_TOPICS', 'NON_TOPIC_MODEL_KINDS'],
  };
  const documents = documentsSource.value === undefined ? documentsSource : {
    ...documentsSource,
    value: dedupeById(documentsSource.value)
      .filter((document) => !document.deleted && document.hasDashboard === true),
    exclusions: ['DELETED_DOCUMENTS', 'DOCUMENTS_WITHOUT_HAS_DASHBOARD_TRUE'],
  };

  const metrics: PortfolioMetricSet = {
    internalMemberships: readMetric(identities, identities.value?.length ?? null, asOf),
    estimatedUniquePeople: estimatedPeopleMetric(identities, asOf),
    embedUsers: readMetric(embedUsers, embedUsers.value?.length ?? null, asOf),
    embedEntities: embedEntitiesMetric(embedUsers, asOf),
    active7d: combinedActivityMetric(identities, embedUsers, 7, now, asOf),
    active30d: combinedActivityMetric(identities, embedUsers, 30, now, asOf),
    active90d: combinedActivityMetric(identities, embedUsers, 90, now, asOf),
    staleUsers90d: lifecycleUserRecordMetric(identities, embedUsers, 'stale_90d', now, asOf),
    neverLoggedInUsers: lifecycleUserRecordMetric(identities, embedUsers, 'never_logged_in', now, asOf),
    dashboards: readMetric(documents, documents.value?.length ?? null, asOf, ['DELETED_DOCUMENTS', 'DOCUMENTS_WITHOUT_HAS_DASHBOARD_TRUE']),
    models: readMetric(models, models.value?.length ?? null, asOf, ['DELETED_MODELS', 'NON_SHARED_MODEL_KINDS']),
    topics: readMetric(topics, topics.value?.length ?? null, asOf, ['DELETED_TOPICS'], topics.reasonCode),
    aiChats: aiConversationMetric(state.aiConversations, identities, asOf),
    apps: appInventoryMetric(tenant, state.documents, state.apps, asOf),
  };
  const connectionsByInstance = buildConnectionSummaries({
    instanceId,
    instanceLabel,
    asOf,
    connections,
    models,
    topics,
    dashboards: documents,
  });
  const configuredMetrics = METRIC_KEYS
    .filter((key) => key !== 'aiChats' && key !== 'apps' && !ADOPTION_QUALITY_METRIC_KEYS.has(key))
    .map((key) => metrics[key]);
  const reportingMetrics = configuredMetrics.filter((entry) => entry.value !== null);
  const health: PortfolioInstanceSummary['health'] = pending
    ? 'attention'
    : reportingMetrics.length === 0
      ? 'unavailable'
      : configuredMetrics.every((entry) => entry.status === 'available')
        ? 'healthy'
        : 'attention';
  const freshness: PortfolioMetricStatus = pending
    ? 'partial'
    : health === 'healthy'
      ? 'available'
      : health === 'attention'
        ? 'partial'
        : failureStatus(configuredMetrics);
  const labels = tenant.saved.map((instance) => sanitizeDisplay(instance.label, 'Unnamed instance')).sort();
  const summary: PortfolioInstanceSummary = {
    id: instanceId,
    label: instanceLabel,
    health,
    statusLabel: pending ? 'Refreshing' : health === 'healthy' ? 'Healthy' : health === 'attention' ? 'Partial coverage' : 'Unavailable',
    freshness,
    asOf,
    duplicateSavedOrigin: tenant.saved.length > 1,
    duplicateSavedOriginCount: tenant.saved.length,
    duplicateInstanceLabels: labels,
    metrics,
    connections: connectionsByInstance,
  };
  return {
    tenant,
    summary,
    connections,
    identities,
    embedUsers,
    models,
    topics,
    dashboards: documents,
    aiConversations: state.aiConversations,
    apps: state.apps,
    transientFailure: [connections, identities, embedUsers, models, topics, documents, state.aiConversations, state.apps]
      .some((read) => read?.transientFailure === true),
  };
}

async function scanInstance(
  tenant: CanonicalTenant,
  asOf: string,
  now: number,
  signal: AbortSignal,
  onMetricProgress?: (scan: InstanceScan) => void,
): Promise<InstanceScan> {
  const instanceId = tenant.selected.id;
  let client: OmniClient | null = null;
  try {
    const saved = getInstance(instanceId);
    if (saved) client = new OmniClient(saved, portfolioRequestPolicy());
  } catch {
    client = null;
  }

  const failed = <T,>(source: PortfolioMetricSource): ReadResult<T> => ({
    status: 'failed',
    source,
    reasonCode: 'SAVED_INSTANCE_UNAVAILABLE',
    exclusions: [],
    included: 0,
    total: 1,
    unit: 'endpoints',
    transientFailure: true,
  });

  const state: InstanceReadState = {};

  if (!client) {
    state.connections = failed('omni_connections_api');
    state.identities = failed('omni_identity_users_api');
    state.embedUsers = failed('omni_embed_users_api');
    state.models = failed('omni_models_api');
    state.topics = failed('omni_model_topics_api');
    state.documents = failed('omni_documents_api');
    state.aiConversations = failed('omni_ai_conversations_api');
    if (tenant.selected.portfolioAppLabel) state.apps = failed('omni_documents_api');
  } else {
    const run = createLimiter(READ_CONCURRENCY_PER_INSTANCE);
    const publish = () => onMetricProgress?.(buildInstanceScan(tenant, asOf, now, state));
    const identityTask = run(async () => {
      state.identities = await captureRead(
        () => client!.listIdentityUsers(signal),
        'omni_identity_users_api',
        signal,
      );
      publish();
    });
    const tasks: Promise<void>[] = [
      run(async () => {
        state.connections = await captureRead(() => client!.listConnections(signal), 'omni_connections_api', signal);
        publish();
      }),
      identityTask,
      run(async () => {
        state.embedUsers = await captureRead(() => client!.listEmbedUsers(signal), 'omni_embed_users_api', signal);
        publish();
      }),
      run(async () => {
        state.models = await readSemanticModels(client!, signal);
        publish();
        state.topics = await readTopicsForModels(client!, state.models, signal);
        publish();
      }),
      run(async () => {
        state.documents = await captureRead(
          () => client!.listFolderDocuments(undefined, false, signal),
          'omni_documents_api',
          signal,
        );
        publish();
      }),
    ];
    tasks.push(run(async () => {
      await identityTask;
      if (state.identities?.value === undefined) {
        state.aiConversations = {
          status: state.identities?.status || 'failed',
          source: 'omni_identity_users_api',
          reasonCode: 'AI_CONVERSATION_SCOPE_UNVERIFIED',
          exclusions: ['AI_CONVERSATION_COUNT_NOT_REQUESTED_WITHOUT_ORG_SCOPE_EVIDENCE'],
          included: 0,
          total: 1,
          unit: 'endpoints',
          transientFailure: state.identities?.transientFailure ?? false,
        };
      } else {
        state.aiConversations = await captureRead(
          () => client!.countAiConversations(signal),
          'omni_ai_conversations_api',
          signal,
        );
      }
      publish();
    }));
    if (tenant.selected.portfolioAppLabel) {
      tasks.push(run(async () => {
        state.apps = await captureRead(
          () => client!.listFolderDocuments({
            includeLabels: true,
            labels: tenant.selected.portfolioAppLabel,
          }, false, signal),
          'omni_documents_api',
          signal,
        );
        publish();
      }));
    }
    await Promise.all(tasks);
  }
  return buildInstanceScan(tenant, asOf, now, state);
}

function combinedMetric(
  summaries: PortfolioInstanceSummary[],
  key: keyof PortfolioMetricSet,
  asOf: string,
  availableReasonCode: string | null = null,
  totalInstances = summaries.length,
  availableReasonLabel?: string,
): PortfolioMetric {
  if (summaries.length === 0) {
    if (totalInstances > 0) {
      return metric({
        value: null,
        status: 'partial',
        source: 'derived_instance_aggregate',
        asOf,
        included: 0,
        total: totalInstances,
        unit: 'instances',
        reasonCode: 'REFRESH_IN_PROGRESS',
        coverageLabel: `0 of ${totalInstances} instances`,
      });
    }
    return metric({
      value: null,
      status: 'not_configured',
      source: 'saved_instance_inventory',
      asOf,
      included: 0,
      total: 0,
      unit: 'instances',
      reasonCode: 'NO_SAVED_INSTANCES',
      coverageLabel: 'No saved instances',
    });
  }
  const entries = summaries.map((summary) => summary.metrics[key]);
  const reporting = entries.filter((entry) => entry.value !== null);
  if (reporting.length === 0) {
    const status = failureStatus(entries);
    const reasons = new Set(entries.map((entry) => entry.reasonCode).filter(Boolean));
    return metric({
      value: null,
      status,
      source: 'derived_instance_aggregate',
      asOf,
      included: 0,
      total: totalInstances,
      unit: 'instances',
      exclusions: entries.flatMap((entry) => entry.exclusions),
      reasonCode: reasons.size === 1 ? [...reasons][0]! : 'NO_REPORTING_INSTANCES',
    });
  }
  const isComplete = summaries.length === totalInstances
    && reporting.length === summaries.length
    && reporting.every((entry) => entry.status === 'available');
  const reportingAsOf = reporting.reduce((oldest, entry) => {
    const entryTimestamp = timestamp(entry.asOf);
    if (entryTimestamp === 0) return oldest;
    const oldestTimestamp = timestamp(oldest);
    return oldestTimestamp === 0 || entryTimestamp < oldestTimestamp ? entry.asOf : oldest;
  }, asOf);
  return metric({
    value: reporting.reduce((sum, entry) => sum + (entry.value || 0), 0),
    status: isComplete ? 'available' : 'partial',
    source: 'derived_instance_aggregate',
    asOf: reportingAsOf,
    included: reporting.length,
    total: totalInstances,
    unit: 'instances',
    exclusions: entries.flatMap((entry) => entry.exclusions),
    reasonCode: isComplete ? availableReasonCode : 'PARTIAL_INSTANCE_COVERAGE',
    ...(isComplete && availableReasonLabel ? { reasonLabel: availableReasonLabel } : {}),
  });
}

function aggregateEstimatedPeople(scans: InstanceScan[], asOf: string, totalInstances = scans.length): PortfolioMetric {
  if (scans.length === 0) return combinedMetric([], 'estimatedUniquePeople', asOf, null, totalInstances);
  const reporting = scans.filter((scan) => scan.identities.value !== undefined);
  if (reporting.length === 0) return combinedMetric(scans.map((scan) => scan.summary), 'estimatedUniquePeople', asOf);
  const emails = new Set<string>();
  let membershipsWithoutEmail = 0;
  for (const scan of reporting) {
    for (const user of scan.identities.value || []) {
      const email = normalizeEmail(user.email);
      if (email) emails.add(email);
      else membershipsWithoutEmail += 1;
    }
  }
  const complete = scans.length === totalInstances
    && reporting.length === scans.length
    && reporting.every((scan) => scan.identities.status === 'available')
    && membershipsWithoutEmail === 0;
  return metric({
    value: emails.size,
    status: complete ? 'available' : 'partial',
    source: 'derived_normalized_identity',
    asOf,
    included: reporting.length,
    total: totalInstances,
    unit: 'instances',
    exclusions: membershipsWithoutEmail > 0 ? ['MEMBERSHIPS_WITHOUT_NORMALIZED_EMAIL'] : [],
    reasonCode: 'ESTIMATED_FROM_NORMALIZED_EMAIL',
    reasonLabel: 'Estimated by normalized email across canonical instances',
  });
}

function refreshingMetric(entry: PortfolioMetric): PortfolioMetric {
  if (entry.value === null || entry.status === 'not_configured') return entry;
  return {
    ...entry,
    status: 'stale',
    exclusions: [...new Set([...entry.exclusions, 'REFRESH_IN_PROGRESS'])].sort(),
    reasonCode: 'STALE_WHILE_REVALIDATE',
    reasonLabel: 'Serving the previous aggregate while this instance refreshes',
  };
}

function refreshingMetricSet(metrics: PortfolioMetricSet): PortfolioMetricSet {
  return Object.fromEntries(METRIC_KEYS.map((key) => [key, refreshingMetric(metrics[key])])) as unknown as PortfolioMetricSet;
}

function refreshingInstance(instance: PortfolioInstanceSummary): PortfolioInstanceSummary {
  const cloned = structuredClone(instance);
  return {
    ...cloned,
    health: instance.health === 'unavailable' ? 'unavailable' : 'attention',
    statusLabel: instance.health === 'unavailable' ? 'Unavailable' : 'Refreshing previous snapshot',
    freshness: instance.health === 'unavailable' ? instance.freshness : 'stale',
    metrics: refreshingMetricSet(instance.metrics),
    connections: instance.connections.map((connection) => ({
      ...connection,
      readiness: connection.readiness === 'unavailable' ? 'unavailable' : 'attention',
      statusLabel: connection.readiness === 'unavailable' ? 'Unavailable' : 'Refreshing previous snapshot',
      freshness: connection.readiness === 'unavailable' ? connection.freshness : 'stale',
      dashboards: refreshingMetric(connection.dashboards),
      models: refreshingMetric(connection.models),
      topics: refreshingMetric(connection.topics),
    })),
  };
}

function duplicateOriginSummaries(tenants: CanonicalTenant[]): DuplicateSavedOriginSummary[] {
  return tenants
    .filter((tenant) => tenant.saved.length > 1)
    .map((tenant) => ({
      canonicalInstanceId: tenant.selected.id,
      instanceLabels: tenant.saved.map((instance) => sanitizeDisplay(instance.label, 'Unnamed instance')).sort(),
      savedInstanceCount: tenant.saved.length,
    }));
}

function failureSummaries(instances: PortfolioInstanceSummary[]): PortfolioFailureSummary[] {
  const failureStatuses = new Set<PortfolioMetricStatus>(['permission_denied', 'unsupported', 'failed']);
  return instances.flatMap((instance) => METRIC_KEYS.flatMap((metricKey) => {
    const evidence = instance.metrics[metricKey];
    if (!failureStatuses.has(evidence.status)) return [];
    const status = evidence.status as PortfolioFailureSummary['status'];
    return [{
      id: opaqueId(
        'portfolio-failure',
        instance.id,
        metricKey,
        status,
        evidence.reasonCode || 'NO_REASON_CODE',
      ),
      message: 'A portfolio metric could not be collected for this instance.',
      instanceId: instance.id,
      instanceLabel: instance.label,
      metric: metricKey,
      status,
      reasonCode: evidence.reasonCode,
      ...(evidence.reasonLabel ? { reasonLabel: evidence.reasonLabel } : {}),
      exclusions: [...evidence.exclusions],
      asOf: evidence.asOf,
      source: evidence.source,
      coverage: { ...evidence.coverage },
    }];
  }));
}

function assemblePortfolio(input: {
  scans: InstanceScan[];
  tenants: CanonicalTenant[];
  savedCount: number;
  asOf: string;
  previous?: PortfolioOverview;
  completedInstances?: number;
}): ScanResult {
  const scansByInstance = new Map(input.scans.map((scan) => [scan.summary.id, scan]));
  const previousByInstance = new Map((input.previous?.instances || []).map((instance) => [instance.id, instance]));
  const instances = input.tenants.flatMap((tenant) => {
    const current = scansByInstance.get(tenant.selected.id)?.summary;
    if (current) return [current];
    const previous = previousByInstance.get(tenant.selected.id);
    return previous ? [refreshingInstance(previous)] : [];
  });
  const totalInstances = input.tenants.length;
  const completedInstances = input.completedInstances ?? input.scans.length;
  const connections = instances.flatMap((instance) => instance.connections);
  const reportingInstances = instances.filter((instance) => instance.health !== 'unavailable').length;
  const partialInstances = instances.filter((instance) => instance.health === 'attention').length;
  const staleInstances = instances.filter((instance) => instance.freshness === 'stale').length;
  const unavailableInstances = instances.filter((instance) => instance.health === 'unavailable').length;
  const duplicateSavedOrigins = duplicateOriginSummaries(input.tenants);
  const priorEstimate = completedInstances < totalInstances ? input.previous?.metrics.estimatedUniquePeople : undefined;
  const estimatedUniquePeople = priorEstimate?.value !== null && priorEstimate !== undefined
    ? refreshingMetric(priorEstimate)
    : aggregateEstimatedPeople(input.scans, input.asOf, totalInstances);
  const metrics: PortfolioOverviewMetrics = {
    reportingInstances: metric({
      value: reportingInstances,
      status: completedInstances === totalInstances && reportingInstances === totalInstances ? 'available' : 'partial',
      source: 'saved_instance_inventory',
      asOf: input.asOf,
      included: reportingInstances,
      total: totalInstances,
      unit: 'instances',
      reasonCode: completedInstances === totalInstances && reportingInstances === totalInstances
        ? null
        : 'PARTIAL_INSTANCE_COVERAGE',
    }),
    internalMemberships: combinedMetric(instances, 'internalMemberships', input.asOf, null, totalInstances),
    estimatedUniquePeople,
    embedUsers: combinedMetric(instances, 'embedUsers', input.asOf, null, totalInstances),
    embedEntities: combinedMetric(instances, 'embedEntities', input.asOf, null, totalInstances),
    active7d: combinedMetric(instances, 'active7d', input.asOf, null, totalInstances),
    active30d: combinedMetric(instances, 'active30d', input.asOf, null, totalInstances),
    active90d: combinedMetric(instances, 'active90d', input.asOf, null, totalInstances),
    staleUsers90d: combinedMetric(
      instances,
      'staleUsers90d',
      input.asOf,
      'ACTIVE_USER_RECORDS_STALE_90D',
      totalInstances,
      'Active internal and embed user records with a parseable last-login timestamp older than 90 days; records are not deduplicated people',
    ),
    neverLoggedInUsers: combinedMetric(
      instances,
      'neverLoggedInUsers',
      input.asOf,
      'ACTIVE_USER_RECORDS_WITHOUT_LAST_LOGIN',
      totalInstances,
      'Active internal and embed user records with no last-login value; records are not deduplicated people',
    ),
    dashboards: combinedMetric(instances, 'dashboards', input.asOf, null, totalInstances),
    models: combinedMetric(instances, 'models', input.asOf, null, totalInstances),
    topics: combinedMetric(instances, 'topics', input.asOf, 'TOPIC_MODEL_RECORDS', totalInstances),
    aiChats: combinedMetric(instances, 'aiChats', input.asOf, null, totalInstances),
    apps: combinedMetric(instances, 'apps', input.asOf, 'APPS_FROM_DOCUMENT_METADATA', totalInstances),
  };
  const partial = completedInstances < totalInstances || partialInstances > 0 || unavailableInstances > 0;
  return {
    overview: {
      schemaVersion: 1,
      generatedAt: input.asOf,
      servedAt: input.asOf,
      cache: { state: 'fresh', cachedAt: input.asOf },
      refresh: {
        state: completedInstances < totalInstances ? 'running' : 'idle',
        completedInstances,
        totalInstances,
      },
      coverage: {
        totalInstances,
        reportingInstances,
        partialInstances,
        staleInstances,
        unavailableInstances,
        savedInstances: input.savedCount,
        duplicateSavedOrigins: duplicateSavedOrigins.length,
      },
      metrics,
      instances,
      connections,
      duplicateSavedOrigins,
      failures: failureSummaries(instances),
      warnings: [
        ...(duplicateSavedOrigins.length > 0 ? ['DUPLICATE_SAVED_ORIGIN'] : []),
        ...(completedInstances < totalInstances ? ['REFRESH_IN_PROGRESS'] : []),
      ],
      partial,
      stale: staleInstances > 0,
    },
    transientFailure: input.scans.some((scan) => scan.transientFailure),
  };
}

async function scanPortfolio(
  tenants: CanonicalTenant[],
  savedCount: number,
  signal: AbortSignal,
  previous: PortfolioOverview | undefined,
  onProgress: (result: ScanResult, completedInstances: number) => void,
): Promise<ScanResult> {
  const now = Date.now();
  const asOf = new Date(now).toISOString();
  const latest = new Map<string, InstanceScan>();
  const completed = new Set<string>();
  await mapLimit(tenants, INSTANCE_CONCURRENCY, async (tenant) => {
    const publish = (scan: InstanceScan) => {
      latest.set(tenant.selected.id, scan);
      const progress = assemblePortfolio({
        scans: [...latest.values()],
        tenants,
        savedCount,
        asOf,
        previous,
        completedInstances: completed.size,
      });
      onProgress(progress, completed.size);
    };
    const scan = await scanInstance(tenant, asOf, now, signal, publish);
    latest.set(tenant.selected.id, scan);
    completed.add(tenant.selected.id);
    const result = assemblePortfolio({
      scans: [...latest.values()],
      tenants,
      savedCount,
      asOf,
      previous,
      completedInstances: completed.size,
    });
    onProgress(result, completed.size);
    return scan;
  });
  return assemblePortfolio({
    scans: [...latest.values()],
    tenants,
    savedCount,
    asOf,
    previous,
    completedInstances: completed.size,
  });
}

function staleMetric(
  entry: PortfolioMetric,
  reasonCode = 'STALE_IF_ERROR',
  reasonLabel = 'Serving the last aggregate after a refresh could not complete',
  exclusion = 'REFRESH_FAILED',
): PortfolioMetric {
  if (entry.value === null || entry.status === 'not_configured') return entry;
  return {
    ...entry,
    status: 'stale',
    exclusions: [...new Set([...entry.exclusions, exclusion])].sort(),
    reasonCode,
    reasonLabel,
  };
}

function staleMetricSet(
  metrics: PortfolioMetricSet,
  reasonCode?: string,
  reasonLabel?: string,
  exclusion?: string,
): PortfolioMetricSet {
  return Object.fromEntries(METRIC_KEYS.map((key) => [
    key,
    staleMetric(metrics[key], reasonCode, reasonLabel, exclusion),
  ])) as unknown as PortfolioMetricSet;
}

function asStale(
  value: PortfolioOverview,
  options: {
    servedAt?: string;
    reasonCode?: string;
    reasonLabel?: string;
    exclusion?: string;
    warning?: string;
  } = {},
): PortfolioOverview {
  const overview = cloneOverview(value);
  const reasonCode = options.reasonCode || 'STALE_IF_ERROR';
  const reasonLabel = options.reasonLabel || 'Serving the last aggregate after a refresh could not complete';
  const exclusion = options.exclusion || 'REFRESH_FAILED';
  overview.servedAt = options.servedAt || new Date().toISOString();
  overview.cache.state = 'stale';
  overview.stale = true;
  overview.partial = true;
  overview.warnings = [...new Set([...overview.warnings, options.warning || 'STALE_IF_ERROR'])];
  overview.metrics = {
    ...staleMetricSet(overview.metrics, reasonCode, reasonLabel, exclusion),
    reportingInstances: staleMetric(overview.metrics.reportingInstances, reasonCode, reasonLabel, exclusion),
  };
  overview.instances = overview.instances.map((instance) => ({
    ...instance,
    health: instance.health === 'unavailable' ? 'unavailable' : 'attention',
    statusLabel: instance.health === 'unavailable' ? 'Unavailable' : 'Stale',
    freshness: instance.health === 'unavailable' ? instance.freshness : 'stale',
    metrics: staleMetricSet(instance.metrics, reasonCode, reasonLabel, exclusion),
    connections: instance.connections.map((connection) => ({
      ...connection,
      readiness: connection.readiness === 'unavailable' ? 'unavailable' : 'attention',
      statusLabel: connection.readiness === 'unavailable' ? 'Unavailable' : 'Stale',
      freshness: connection.readiness === 'unavailable' ? connection.freshness : 'stale',
      dashboards: staleMetric(connection.dashboards, reasonCode, reasonLabel, exclusion),
      models: staleMetric(connection.models, reasonCode, reasonLabel, exclusion),
      topics: staleMetric(connection.topics, reasonCode, reasonLabel, exclusion),
    })),
  }));
  overview.connections = overview.instances.flatMap((instance) => instance.connections);
  overview.coverage.staleInstances = overview.coverage.reportingInstances;
  return overview;
}

function isPortfolioOverview(value: unknown): value is PortfolioOverview {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const candidate = value as Partial<PortfolioOverview>;
  return candidate.schemaVersion === 1
    && typeof candidate.generatedAt === 'string'
    && typeof candidate.servedAt === 'string'
    && Boolean(candidate.cache && typeof candidate.cache === 'object')
    && Boolean(candidate.refresh && typeof candidate.refresh === 'object')
    && Boolean(candidate.coverage && typeof candidate.coverage === 'object')
    && Boolean(candidate.metrics && typeof candidate.metrics === 'object')
    && Array.isArray(candidate.instances)
    && Array.isArray(candidate.connections)
    && Array.isArray(candidate.duplicateSavedOrigins)
    && (candidate.failures === undefined || Array.isArray(candidate.failures))
    && Array.isArray(candidate.warnings)
    && typeof candidate.partial === 'boolean'
    && typeof candidate.stale === 'boolean';
}

function hydratePersistedEvidence(value: PortfolioOverview): PortfolioOverview {
  const overview = cloneOverview(value);
  let provenanceBackfilled = false;
  let lifecycleMetricsBackfilled = false;
  const ensureSource = (entry: PortfolioMetric) => {
    if (PORTFOLIO_METRIC_SOURCES.has(entry.source)) return;
    entry.source = 'legacy_snapshot_unknown';
    provenanceBackfilled = true;
  };
  const legacyLifecycleMetric = (
    asOf: string,
    total: number,
    unit: PortfolioMetricCoverage['unit'],
  ): PortfolioMetric => metric({
    value: null,
    status: 'unsupported',
    source: 'legacy_snapshot_unknown',
    asOf,
    included: 0,
    total,
    unit,
    exclusions: ['ACTIVE_USER_RECORDS_NOT_UNIQUE_PEOPLE', 'LEGACY_SNAPSHOT_METRIC_UNAVAILABLE'],
    reasonCode: 'LEGACY_SNAPSHOT_METRIC_UNAVAILABLE',
    reasonLabel: 'This legacy snapshot predates the source-record lifecycle metric',
  });
  const ensureMetricSet = (
    metrics: PortfolioMetricSet,
    asOf: string,
    total: number,
    unit: PortfolioMetricCoverage['unit'],
  ) => {
    const partialMetrics = metrics as Partial<PortfolioMetricSet>;
    for (const key of LIFECYCLE_METRIC_KEYS) {
      if (!partialMetrics[key]) {
        partialMetrics[key] = legacyLifecycleMetric(asOf, total, unit);
        lifecycleMetricsBackfilled = true;
      }
    }
    for (const key of METRIC_KEYS) ensureSource(metrics[key]);
  };

  ensureMetricSet(
    overview.metrics,
    overview.generatedAt,
    overview.coverage.totalInstances,
    'instances',
  );
  ensureSource(overview.metrics.reportingInstances);
  for (const instance of overview.instances) {
    ensureMetricSet(instance.metrics, instance.asOf, 2, 'endpoints');
    for (const connection of instance.connections) {
      ensureSource(connection.dashboards);
      ensureSource(connection.models);
      ensureSource(connection.topics);
    }
  }
  for (const connection of overview.connections) {
    ensureSource(connection.dashboards);
    ensureSource(connection.models);
    ensureSource(connection.topics);
  }
  overview.failures = failureSummaries(overview.instances);
  if (provenanceBackfilled) {
    overview.warnings = [...new Set([...overview.warnings, 'LEGACY_SNAPSHOT_PROVENANCE_UNKNOWN'])];
  }
  if (lifecycleMetricsBackfilled) {
    overview.warnings = [...new Set([...overview.warnings, 'LEGACY_SNAPSHOT_METRICS_UNAVAILABLE'])];
  }
  return overview;
}

function hasLegacyLifecycleMetricGap(value: PortfolioOverview): boolean {
  const globalMetrics = value.metrics as Partial<PortfolioOverviewMetrics>;
  if (LIFECYCLE_METRIC_KEYS.some((key) => !globalMetrics[key])) return true;
  return value.instances.some((instance) => {
    const instanceMetrics = instance.metrics as Partial<PortfolioMetricSet>;
    return LIFECYCLE_METRIC_KEYS.some((key) => !instanceMetrics[key]);
  });
}

function isFailedRefreshFallback(value: PortfolioOverview): boolean {
  return value.cache.state === 'stale'
    && value.warnings.includes('STALE_IF_ERROR');
}

function hydrateCache(fingerprint: string): CacheEntry | null {
  if (cacheEntry?.fingerprint === fingerprint) return cacheEntry;
  try {
    const persisted = getPortfolioOverviewSnapshot();
    if (!persisted || !isPortfolioOverview(persisted.overview)) return null;
    if (persisted.fingerprint !== fingerprint) return null;
    const legacyLifecycleMetricGap = hasLegacyLifecycleMetricGap(persisted.overview);
    let overview = hydratePersistedEvidence(cloneOverview(persisted.overview));
    const interruptedCheckpoint = overview.refresh.state === 'running'
      || !Number.isInteger(overview.refresh.completedInstances)
      || !Number.isInteger(overview.refresh.totalInstances)
      || overview.refresh.completedInstances !== overview.refresh.totalInstances;
    const failedRefreshFallback = isFailedRefreshFallback(overview);
    if (interruptedCheckpoint && !failedRefreshFallback) {
      overview = asStale(overview, {
        reasonCode: 'INTERRUPTED_REFRESH_CHECKPOINT',
        reasonLabel: 'The previous refresh was interrupted; serving its checkpoint while a new refresh runs',
        exclusion: 'INTERRUPTED_REFRESH_CHECKPOINT',
        warning: 'INTERRUPTED_REFRESH_CHECKPOINT',
      });
    }
    cacheEntry = {
      fingerprint,
      storedAt: persisted.storedAt,
      overview,
      kind: 'snapshot',
      ...(interruptedCheckpoint || failedRefreshFallback || legacyLifecycleMetricGap
        ? { requiresRefresh: true }
        : {}),
    };
    return cacheEntry;
  } catch {
    return null;
  }
}

function persistSnapshotEntry(entry: CacheEntry): CacheEntry {
  if (entry.kind !== 'snapshot') return entry;
  try {
    setPortfolioOverviewSnapshot({
      fingerprint: entry.fingerprint,
      storedAt: entry.storedAt,
      overview: entry.overview as unknown as Record<string, unknown>,
    });
    return entry;
  } catch {
    const overview = cloneOverview(entry.overview);
    overview.warnings = [...new Set([...overview.warnings, 'DURABLE_SNAPSHOT_WRITE_FAILED'])];
    const failedEntry: CacheEntry = { ...entry, overview };
    cacheEntry = failedEntry;
    return failedEntry;
  }
}

function storeSnapshot(
  fingerprint: string,
  value: PortfolioOverview,
  storedAt = Date.now(),
  persistDurably = true,
): CacheEntry {
  const overview = cloneOverview(value);
  overview.cache = {
    state: 'fresh',
    cachedAt: new Date(storedAt).toISOString(),
  };
  overview.servedAt = new Date().toISOString();
  const entry: CacheEntry = { fingerprint, storedAt, overview, kind: 'snapshot' };
  cacheEntry = entry;
  return persistDurably ? persistSnapshotEntry(entry) : entry;
}

function applyRefreshMetadata(
  value: PortfolioOverview,
  fingerprint: string,
  totalInstances: number,
): PortfolioOverview {
  const overview = cloneOverview(value);
  const flight = flights.get(fingerprint);
  const completed = completedRefreshes.get(fingerprint);
  overview.servedAt = new Date().toISOString();
  overview.refresh = flight
    ? {
        state: 'running',
        startedAt: flight.startedAt,
        completedInstances: flight.completedInstances,
        totalInstances: flight.totalInstances,
      }
    : {
        state: 'idle',
        ...(completed?.completedAt || overview.refresh.completedAt
          ? { completedAt: completed?.completedAt || overview.refresh.completedAt }
          : {}),
        completedInstances: completed?.completedInstances
          ?? overview.refresh.completedInstances
          ?? overview.instances.length,
        totalInstances: completed?.totalInstances ?? overview.refresh.totalInstances ?? totalInstances,
      };
  return overview;
}

function cachedResponse(entry: CacheEntry, fingerprint: string, totalInstances: number): PortfolioOverview {
  if (entry.kind === 'placeholder') {
    const overview = cloneOverview(entry.overview);
    overview.cache.state = 'stale';
    return applyRefreshMetadata(overview, fingerprint, totalInstances);
  }
  if (entry.requiresRefresh) {
    const overview = cloneOverview(entry.overview);
    overview.cache.state = 'stale';
    return applyRefreshMetadata(overview, fingerprint, totalInstances);
  }
  const now = Date.now();
  const age = Math.max(0, now - entry.storedAt);
  const freshTtl = configuredDuration('OMNIKIT_PORTFOLIO_CACHE_TTL_MS', DEFAULT_CACHE_TTL_MS);
  const staleTtl = configuredDuration('OMNIKIT_PORTFOLIO_STALE_TTL_MS', DEFAULT_STALE_TTL_MS);
  if (age <= freshTtl) {
    const overview = cloneOverview(entry.overview);
    overview.cache.state = 'fresh';
    return applyRefreshMetadata(overview, fingerprint, totalInstances);
  }
  const beyondStaleIfError = age > staleTtl;
  const overview = asStale(entry.overview, {
    reasonCode: beyondStaleIfError ? 'STALE_SNAPSHOT_EXPIRED' : 'STALE_WHILE_REVALIDATE',
    reasonLabel: beyondStaleIfError
      ? 'The last aggregate is older than the configured stale-if-error window'
      : 'Serving the previous aggregate while a background refresh runs',
    exclusion: beyondStaleIfError ? 'STALE_TTL_EXCEEDED' : 'REFRESH_IN_PROGRESS',
    warning: beyondStaleIfError ? 'STALE_SNAPSHOT_EXPIRED' : 'STALE_WHILE_REVALIDATE',
  });
  return applyRefreshMetadata(overview, fingerprint, totalInstances);
}

async function refreshPortfolio(
  fingerprint: string,
  tenants: CanonicalTenant[],
  savedCount: number,
  signal: AbortSignal,
  flight: Flight,
): Promise<void> {
  const startingEntry = cacheEntry?.fingerprint === fingerprint && cacheEntry.kind === 'snapshot'
    ? cacheEntry
    : undefined;
  const previous = startingEntry ? cloneOverview(startingEntry.overview) : undefined;
  let lastDurableEntry = startingEntry;
  let lastDurableCompletedInstances = 0;
  try {
    const result = await scanPortfolio(
      tenants,
      savedCount,
      signal,
      previous,
      (progress, completedInstances) => {
        if (signal.aborted && signal.reason instanceof PortfolioAbortReason
          && signal.reason.code === 'REQUEST_CANCELLED') return;
        if (currentInventoryFingerprint() !== fingerprint) return;
        flight.completedInstances = completedInstances;
        progress.overview.refresh = {
          state: 'running',
          startedAt: flight.startedAt,
          completedInstances,
          totalInstances: tenants.length,
        };
        const completedInstanceCheckpoint = completedInstances > lastDurableCompletedInstances
          && completedInstances < tenants.length;
        if (completedInstanceCheckpoint) lastDurableCompletedInstances = completedInstances;
        const progressEntry = storeSnapshot(
          fingerprint,
          progress.overview,
          Date.now(),
          completedInstanceCheckpoint,
        );
        if (completedInstanceCheckpoint) lastDurableEntry = progressEntry;
      },
    );
    if (signal.aborted && signal.reason instanceof PortfolioAbortReason
      && signal.reason.code === 'REQUEST_CANCELLED') return;
    if (currentInventoryFingerprint() !== fingerprint) return;
    const completedAt = new Date().toISOString();
    flight.completedInstances = tenants.length;
    result.overview.refresh = {
      state: 'idle',
      startedAt: flight.startedAt,
      completedAt,
      completedInstances: tenants.length,
      totalInstances: tenants.length,
    };
    storeSnapshot(fingerprint, result.overview);
    completedRefreshes.set(fingerprint, {
      completedAt,
      completedInstances: tenants.length,
      totalInstances: tenants.length,
    });
  } catch {
    if (signal.aborted && signal.reason instanceof PortfolioAbortReason
      && signal.reason.code === 'REQUEST_CANCELLED') return;
    completedRefreshes.delete(fingerprint);
    if (currentInventoryFingerprint() !== fingerprint) return;
    if (cacheEntry?.fingerprint !== fingerprint) return;
    const currentEntry = cacheEntry;
    const fallbackEntry = lastDurableEntry || currentEntry;
    if (fallbackEntry) {
      const fallback = asStale(fallbackEntry.overview, {
        reasonCode: 'STALE_IF_ERROR',
        reasonLabel: 'Serving the last aggregate after the background refresh failed',
        exclusion: 'REFRESH_FAILED',
        warning: 'STALE_IF_ERROR',
      });
      fallback.refresh = {
        state: 'running',
        startedAt: flight.startedAt,
        completedInstances: lastDurableCompletedInstances,
        totalInstances: tenants.length,
      };
      cacheEntry = {
        ...fallbackEntry,
        overview: fallback,
        requiresRefresh: true,
      };
      persistSnapshotEntry(cacheEntry);
    }
  }
}

function startFlight(
  fingerprint: string,
  tenants: CanonicalTenant[],
  savedCount: number,
): Flight {
  const controller = new AbortController();
  const deadlineMs = configuredDuration('OMNIKIT_PORTFOLIO_SCAN_DEADLINE_MS', DEFAULT_SCAN_DEADLINE_MS);
  const deadline = setTimeout(() => {
    controller.abort(new PortfolioAbortReason('SCAN_DEADLINE_EXCEEDED'));
  }, deadlineMs);
  deadline.unref?.();

  const flight: Flight = {
    controller,
    promise: Promise.resolve(),
    startedAt: new Date().toISOString(),
    completedInstances: 0,
    totalInstances: tenants.length,
  };
  flights.set(fingerprint, flight);
  flight.promise = refreshPortfolio(fingerprint, tenants, savedCount, controller.signal, flight)
    .finally(() => {
      clearTimeout(deadline);
      if (flights.get(fingerprint) === flight) flights.delete(fingerprint);
    });
  return flight;
}

export async function getPortfolioOverview(options: {
  signal?: AbortSignal;
  forceRefresh?: boolean;
} = {}): Promise<PortfolioOverview> {
  if (options.signal?.aborted) throw new PortfolioOverviewError('REQUEST_CANCELLED');
  const instances = listInstances();
  const fingerprint = inventoryFingerprint(instances);
  const tenants = canonicalTenants(instances);
  let entry = hydrateCache(fingerprint);
  const freshTtl = configuredDuration('OMNIKIT_PORTFOLIO_CACHE_TTL_MS', DEFAULT_CACHE_TTL_MS);
  const isFresh = entry && !entry.requiresRefresh && Date.now() - entry.storedAt <= freshTtl;
  if (options.forceRefresh || !isFresh) {
    if (!flights.has(fingerprint)) startFlight(fingerprint, tenants, instances.length);
  }
  if (!entry) {
    const empty = assemblePortfolio({
      scans: [],
      tenants,
      savedCount: instances.length,
      asOf: new Date().toISOString(),
    }).overview;
    empty.refresh = {
      state: 'running',
      startedAt: flights.get(fingerprint)?.startedAt,
      completedInstances: 0,
      totalInstances: tenants.length,
    };
    empty.warnings = [...new Set([...empty.warnings, 'NO_CACHED_SNAPSHOT'])];
    empty.cache.state = 'stale';
    entry = {
      fingerprint,
      storedAt: Date.now(),
      overview: cloneOverview(empty),
      kind: 'placeholder',
    };
    cacheEntry = entry;
  }
  return cachedResponse(entry, fingerprint, tenants.length);
}

export function clearPortfolioOverviewCache(): void {
  cacheEntry = null;
  for (const flight of flights.values()) {
    flight.controller.abort(new PortfolioAbortReason('REQUEST_CANCELLED'));
  }
  flights.clear();
  completedRefreshes.clear();
  try {
    clearPortfolioOverviewSnapshot();
  } catch {
    // Tests and shutdown paths may clear memory after the vault has already locked.
  }
}
