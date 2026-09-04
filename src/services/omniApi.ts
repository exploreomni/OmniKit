import { emitVaultLocked } from './vaultEvents';
import type { OmniUserAttributes } from '@/types';
import { parseTopicInventoryResponse, type TopicInventoryRecord } from './topicsRequestState';

function edgeFunctionUrl(name: string): string {
  return `/api/${name}`;
}

const defaultHeaders = {
  'Content-Type': 'application/json',
};

const MAX_CONCURRENT_REQUESTS = 2;
const MAX_RETRY_ATTEMPTS = 3;
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503]);
const METADATA_CACHE_TTL_MS = 90_000;
const REQUEST_SPACING_MS = 250;

let activeRequestCount = 0;
let nextRequestAt = 0;
interface RequestQueueWaiter {
  resolve: () => void;
  reject: (error: DOMException) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}
const requestQueue: RequestQueueWaiter[] = [];
const inFlightRequests = new Map<string, Promise<Response>>();
const metadataCache = new Map<string, { expiresAt: number; value: unknown }>();
const metadataCacheGenerations = new Map<string, number>();

interface SafeFetchPolicy {
  deduplicate?: boolean;
  deduplicationScope?: string;
  retry?: boolean;
  requestSpacingMs?: number;
}

interface MetadataCacheLoadContext {
  generation: number;
  deduplicationScope: string;
}

export class ApiError extends Error {
  status: number;
  detail?: string;
  code?: string;
  retryAfterMs?: number;

  constructor(status: number, message: string, detail?: string, code?: string, retryAfterMs?: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail;
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

const RETRYABLE_AI_JOB_READ_STATUSES = new Set([
  404,
  408,
  409,
  425,
  429,
  500,
  502,
  503,
  504,
]);

/**
 * Classifies failures from idempotent AI job status and result reads.
 *
 * Create calls must never use this classifier: an interrupted create may have
 * been accepted by Omni and resubmitting it could duplicate a write-capable
 * job. Status/result reads are safe to retry within their caller's bounded
 * lifecycle, including local network failures and request timeouts.
 */
export function isRetryableAiJobReadError(error: unknown): boolean {
  return error instanceof ApiError && (
    error.status <= 0 || RETRYABLE_AI_JOB_READ_STATUSES.has(error.status)
  );
}

function sleep(ms: number, signal?: AbortSignal | null) {
  if (signal?.aborted) return Promise.reject(new DOMException('The request was cancelled.', 'AbortError'));
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(new DOMException('The request was cancelled.', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function requestAbortError() {
  return new DOMException('The request was cancelled.', 'AbortError');
}

function grantQueuedRequestSlot() {
  while (activeRequestCount < MAX_CONCURRENT_REQUESTS && requestQueue.length > 0) {
    const next = requestQueue.shift();
    if (!next) return;
    if (next.onAbort) next.signal?.removeEventListener('abort', next.onAbort);
    if (next.signal?.aborted) {
      next.reject(requestAbortError());
      continue;
    }
    activeRequestCount += 1;
    next.resolve();
  }
}

function releaseRequestSlot() {
  activeRequestCount = Math.max(0, activeRequestCount - 1);
  grantQueuedRequestSlot();
}

async function acquireRequestSlot(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw requestAbortError();
  if (activeRequestCount < MAX_CONCURRENT_REQUESTS) {
    activeRequestCount += 1;
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const waiter: RequestQueueWaiter = {
      resolve,
      reject,
      signal,
    };
    if (signal) {
      waiter.onAbort = () => {
        const index = requestQueue.indexOf(waiter);
        if (index >= 0) requestQueue.splice(index, 1);
        reject(requestAbortError());
      };
      signal.addEventListener('abort', waiter.onAbort, { once: true });
    }
    requestQueue.push(waiter);
  });
}

async function runQueued<T>(
  task: () => Promise<T>,
  signal?: AbortSignal,
  requestSpacingMs = REQUEST_SPACING_MS,
): Promise<T> {
  await acquireRequestSlot(signal);
  try {
    if (signal?.aborted) throw requestAbortError();
    const now = Date.now();
    const waitMs = Math.max(0, nextRequestAt - now);
    nextRequestAt = Math.max(now, nextRequestAt) + requestSpacingMs;
    if (waitMs > 0) await sleep(waitMs, signal);
    if (signal?.aborted) throw requestAbortError();
    return await task();
  } finally {
    releaseRequestSlot();
  }
}

function hashForKey(value: string) {
  let hash = 0;
  for (let i = 0; i < value.length; i += 1) {
    hash = ((hash << 5) - hash + value.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

function sanitizeRequestBodyForKey(body: BodyInit | null | undefined) {
  if (typeof body !== 'string') return '';
  try {
    const parsed = JSON.parse(body) as unknown;
    const scrub = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(scrub);
      if (!value || typeof value !== 'object') return value;
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, item]) => [
          key,
          key.toLowerCase().includes('api_key') && typeof item === 'string'
            ? `key-${hashForKey(item)}`
            : scrub(item),
        ])
      );
    };
    return JSON.stringify(scrub(parsed));
  } catch {
    return body.replace(/"api_key"\s*:\s*"[^"]*"/gi, '"api_key":"[redacted]"');
  }
}

function requestKey(url: string, options: RequestInit) {
  return [
    options.method || 'GET',
    url,
    sanitizeRequestBodyForKey(options.body),
  ].join('|');
}

function retryDelayMs(res: Response, attempt: number) {
  const retryAfter = res.headers.get('Retry-After');
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, 30_000);
    const retryDate = Date.parse(retryAfter);
    if (Number.isFinite(retryDate)) return Math.min(Math.max(retryDate - Date.now(), 0), 30_000);
  }
  return Math.min(1000 * 2 ** attempt, 8000) + Math.round(Math.random() * 250);
}

function isRetrySafeContext(context: string) {
  return /^(List|Get|Validate|Connection test|Inspect|Enrich|Fetch|GET\s+|POST\s+\/v1\/query\/run)/i.test(context);
}

async function fetchWithRetry(url: string, options: RequestInit, context: string) {
  const allowRetry = isRetrySafeContext(context);
  let lastResponse: Response | null = null;

  for (let attempt = 0; attempt < MAX_RETRY_ATTEMPTS; attempt += 1) {
    const res = await fetch(url, options);
    if (!allowRetry || !RETRYABLE_STATUSES.has(res.status) || attempt === MAX_RETRY_ATTEMPTS - 1) {
      return res;
    }
    lastResponse = res;
    await sleep(retryDelayMs(res, attempt), options.signal);
  }

  return lastResponse || fetch(url, options);
}

function clearMetadataCache(prefix: string) {
  const matchingKeys = new Set([
    ...metadataCache.keys(),
    ...metadataCacheGenerations.keys(),
  ]);
  matchingKeys.forEach((key) => {
    if (!key.startsWith(prefix)) return;
    metadataCache.delete(key);
    metadataCacheGenerations.set(key, (metadataCacheGenerations.get(key) || 0) + 1);
  });
}

function cacheScope(baseUrl: string, apiKey: string) {
  return `${baseUrl.replace(/\/+$/, '').toLowerCase()}|key-${hashForKey(apiKey)}`;
}

async function withMetadataCache<T>(
  key: string,
  loader: (context: MetadataCacheLoadContext) => Promise<T>,
  ttlMs = METADATA_CACHE_TTL_MS,
): Promise<T> {
  const now = Date.now();
  const generation = metadataCacheGenerations.get(key) || 0;
  if (!metadataCacheGenerations.has(key)) metadataCacheGenerations.set(key, generation);
  const cached = metadataCache.get(key);
  if (cached && cached.expiresAt > now) return cached.value as T;
  const value = await loader({
    generation,
    deduplicationScope: `${key}|generation:${generation}`,
  });
  if (metadataCacheGenerations.get(key) === generation) {
    metadataCache.set(key, { value, expiresAt: now + ttlMs });
  }
  return value;
}

const STATUS_MESSAGES: Record<number, string> = {
  400: 'The request was invalid. Please check your input and try again.',
  401: 'Authentication failed. Please verify your API key is correct.',
  403: 'You do not have permission to perform this action.',
  404: 'The requested resource was not found. Check your Base URL.',
  408: 'The request timed out. Please try again.',
  429: 'Too many requests. Please wait a moment and try again.',
  500: 'An internal server error occurred. Please try again later.',
  502: 'The server is temporarily unavailable. Please try again later.',
  503: 'The service is currently unavailable. Please try again later.',
};

function redactSensitiveText(value: string) {
  if (!value) return value;
  return value
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/(api[_-]?key|authorization|token|secret)(["'\s:=]+)([^"',\s}]+)/gi, '$1$2[redacted]')
    .replace(/("api_key"\s*:\s*")[^"]+(")/gi, '$1[redacted]$2');
}

function isHtmlResponse(res: Response): boolean {
  const ct = res.headers.get('content-type') || '';
  return ct.includes('text/html');
}

async function handleResponse(res: Response, context: string): Promise<Response> {
  if (res.ok) {
    if (isHtmlResponse(res)) {
      throw new ApiError(
        502,
        'The server returned an unexpected response. This is usually temporary -- please try again.',
      );
    }
    return res;
  }

  if (isHtmlResponse(res)) {
    throw new ApiError(
      res.status,
      STATUS_MESSAGES[res.status] || `${context} failed (HTTP ${res.status}). Please try again.`,
    );
  }

  let serverMessage = '';
  let detail = '';
  let code = '';
  let retryAfterMs: number | undefined;
  try {
    const body = await res.json() as unknown;
    const record = body && typeof body === 'object' && !Array.isArray(body)
      ? body as Record<string, unknown>
      : undefined;
    serverMessage = typeof record?.error === 'string'
      ? record.error
      : typeof record?.message === 'string'
        ? record.message
        : '';
    detail = typeof record?.detail === 'string'
      ? record.detail
      : typeof body === 'string'
        ? body
        : JSON.stringify(body);
    const candidateCode = record?.code;
    code = typeof candidateCode === 'string' && /^[A-Z][A-Z0-9_]{0,79}$/.test(candidateCode)
      ? candidateCode
      : '';
    const candidateRetryAfterMs = record?.retryAfterMs;
    retryAfterMs = Number.isSafeInteger(candidateRetryAfterMs)
      && Number(candidateRetryAfterMs) > 0
      && Number(candidateRetryAfterMs) <= 60_000
      ? Number(candidateRetryAfterMs)
      : undefined;
  } catch {
    try {
      detail = await res.text();
    } catch {
      // ignore
    }
  }

  const friendlyMessage =
    redactSensitiveText(serverMessage) ||
    STATUS_MESSAGES[res.status] ||
    `${context} failed (HTTP ${res.status})`;

  throw new ApiError(
    res.status,
    friendlyMessage,
    redactSensitiveText(detail) || undefined,
    code || undefined,
    retryAfterMs,
  );
}

async function safeFetch(
  url: string,
  options: RequestInit,
  context: string,
  policy: SafeFetchPolicy = {},
): Promise<Response> {
  try {
    const fetchOnce = () => policy.retry === false
      ? fetch(url, options)
      : fetchWithRetry(url, options, context);
    let promise: Promise<Response>;
    if (policy.deduplicate === false) {
      // Credential-bearing one-time requests must never enter a retained request-key map.
      promise = runQueued(fetchOnce, options.signal || undefined, policy.requestSpacingMs);
    } else {
      const baseRequestKey = requestKey(url, options);
      const key = policy.deduplicationScope
        ? `${baseRequestKey}|scope:${policy.deduplicationScope}`
        : baseRequestKey;
      const existing = inFlightRequests.get(key);
      promise = existing || runQueued(fetchOnce, options.signal || undefined, policy.requestSpacingMs)
        .finally(() => inFlightRequests.delete(key));
      if (!existing) inFlightRequests.set(key, promise);
    }
    const res = (await promise).clone();
    return await handleResponse(res, context);
  } catch (err) {
    if ((err instanceof DOMException && err.name === 'AbortError') || options.signal?.aborted) {
      if (err instanceof DOMException && err.name === 'AbortError') throw err;
      throw new DOMException('The request was cancelled.', 'AbortError');
    }
    if (err instanceof ApiError) {
      if (err.status === 423) emitVaultLocked(err.message);
      throw err;
    }
    if (err instanceof TypeError) {
      throw new ApiError(0, 'Network error -- check your internet connection and try again.');
    }
    throw new ApiError(0, err instanceof Error ? err.message : `${context} failed unexpectedly.`);
  }
}

export async function testConnection(baseUrl: string, apiKey: string) {
  const res = await safeFetch(
    edgeFunctionUrl('test-connection'),
    { method: 'POST', headers: defaultHeaders, body: JSON.stringify({ base_url: baseUrl, api_key: apiKey }) },
    'Connection test'
  );
  return res.json();
}

export async function listFolders(
  baseUrl: string,
  apiKey: string,
  options?: { allPages?: boolean; pageSize?: number; cursor?: string }
) {
  const cacheKey = `${cacheScope(baseUrl, apiKey)}|folders|${JSON.stringify(options || {})}`;
  return withMetadataCache(cacheKey, async ({ deduplicationScope }) => {
    const res = await safeFetch(
      edgeFunctionUrl('list-folders'),
      {
        method: 'POST',
        headers: defaultHeaders,
        body: JSON.stringify({
          base_url: baseUrl,
          api_key: apiKey,
          all_pages: options?.allPages,
          page_size: options?.pageSize,
          cursor: options?.cursor,
        }),
      },
      'List folders',
      { deduplicationScope },
    );
    return res.json();
  });
}

export async function listDocuments(
  baseUrl: string,
  apiKey: string,
  folderId?: string,
  options?: { allPages?: boolean; pageSize?: number; cursor?: string }
) {
  const cacheKey = `${cacheScope(baseUrl, apiKey)}|documents|${folderId || 'root'}|${JSON.stringify(options || {})}`;
  return withMetadataCache(cacheKey, async ({ deduplicationScope }) => {
    const res = await safeFetch(
      edgeFunctionUrl('list-documents'),
      {
        method: 'POST',
        headers: defaultHeaders,
        body: JSON.stringify({
          base_url: baseUrl,
          api_key: apiKey,
          folder_id: folderId,
          all_pages: options?.allPages,
          page_size: options?.pageSize,
          cursor: options?.cursor,
        }),
      },
      'List documents',
      { deduplicationScope },
    );
    return res.json();
  });
}

export async function listModels(
  baseUrl: string,
  apiKey: string,
  options?: {
    modelId?: string;
    connectionId?: string;
    modelKind?: string;
    includeDeleted?: boolean;
    include?: string;
    sortField?: string;
    sortDirection?: 'asc' | 'desc';
    allPages?: boolean;
    pageSize?: number;
    cursor?: string;
    forceRefresh?: boolean;
    signal?: AbortSignal;
  }
) {
  const { forceRefresh = false, signal, ...requestOptions } = options || {};
  const cacheKey = `${cacheScope(baseUrl, apiKey)}|models|${JSON.stringify(requestOptions)}`;
  if (forceRefresh) clearMetadataCache(cacheKey);
  return withMetadataCache(cacheKey, async ({ deduplicationScope }) => {
    const res = await safeFetch(
      edgeFunctionUrl('list-models'),
      {
        method: 'POST',
        headers: defaultHeaders,
        signal,
        body: JSON.stringify({
          base_url: baseUrl,
          api_key: apiKey,
          model_id: requestOptions.modelId,
          model_kind: requestOptions.modelKind,
          connection_id: requestOptions.connectionId,
          include_deleted: requestOptions.includeDeleted,
          include: requestOptions.include,
          sort_field: requestOptions.sortField,
          sort_direction: requestOptions.sortDirection,
          all_pages: requestOptions.allPages,
          page_size: requestOptions.pageSize,
          cursor: requestOptions.cursor,
        }),
      },
      'List models',
      signal ? { deduplicate: false, retry: false } : { deduplicationScope, retry: false },
    );
    return res.json();
  });
}

export async function listConnections(
  baseUrl: string,
  apiKey: string,
  options: { forceRefresh?: boolean; signal?: AbortSignal } = {},
): Promise<unknown> {
  const cacheKey = `${cacheScope(baseUrl, apiKey)}|connections`;
  if (options.forceRefresh) clearMetadataCache(cacheKey);
  return withMetadataCache(cacheKey, async ({ deduplicationScope }) => {
    const res = await safeFetch(
      edgeFunctionUrl('omni-proxy'),
      {
        method: 'POST',
        headers: defaultHeaders,
        signal: options.signal,
        body: JSON.stringify({
          base_url: baseUrl,
          api_key: apiKey,
          method: 'GET',
          endpoint: '/v1/connections',
        }),
      },
      'List connections',
      options.signal
        ? { deduplicate: false, retry: false }
        : { deduplicationScope, retry: false },
    );
    return res.json();
  });
}

export async function validateModel(baseUrl: string, apiKey: string, modelId: string, branchId?: string) {
  return omniProxy<Array<{ message?: string; is_warning?: boolean; yaml_path?: string }>>(
    baseUrl,
    apiKey,
    'GET',
    `/v1/models/${modelId}/validate`,
    { queryParams: branchId ? { branchId } : undefined }
  );
}

export interface OmniModelYamlResponse {
  files?: Record<string, string>;
  version?: number;
  viewNames?: Record<string, unknown>;
  checksums?: Record<string, string>;
}

export interface OmniDocumentV2State {
  id?: string;
  documentId?: string;
  name?: string;
  description?: string;
  modelId?: string;
  workbookModelId?: string;
  queryPresentations?: Record<string, unknown>;
  containers?: Record<string, unknown> | unknown[];
  controls?: Record<string, unknown> | unknown[];
  settings?: Record<string, unknown>;
  [key: string]: unknown;
}

export async function getDocumentStateV2(
  baseUrl: string,
  apiKey: string,
  documentId: string,
): Promise<OmniDocumentV2State> {
  const normalizedId = documentId.trim();
  if (!normalizedId || normalizedId.includes('/') || normalizedId.includes('?') || normalizedId.includes('#')) {
    throw new Error('A valid Omni document ID or slug is required.');
  }
  return omniProxy<OmniDocumentV2State>(
    baseUrl,
    apiKey,
    'GET',
    `/v2/documents/${encodeURIComponent(normalizedId)}`,
  );
}

export async function getModelYaml(
  baseUrl: string,
  apiKey: string,
  modelId: string,
  options?: {
    branchId?: string;
    fileName?: string;
    mode?: 'combined' | 'extension' | 'staged';
    includeChecksums?: boolean;
    fullyResolved?: boolean;
    fresh?: boolean;
  }
) {
  const queryParams: Record<string, string> = {};
  if (options?.branchId) queryParams.branchId = options.branchId;
  if (options?.fileName) queryParams.fileName = options.fileName;
  if (options?.mode) queryParams.mode = options.mode;
  if (options?.includeChecksums !== undefined) queryParams.includeChecksums = String(options.includeChecksums);
  if (options?.fullyResolved !== undefined) queryParams.fullyResolved = String(options.fullyResolved);

  const load = (requestPolicy: SafeFetchPolicy = {}) => omniProxyRequest<OmniModelYamlResponse>(
      baseUrl,
      apiKey,
      'GET',
      `/v1/models/${modelId}/yaml`,
      { queryParams: Object.keys(queryParams).length ? queryParams : undefined },
      requestPolicy,
    );
  if (options?.fresh) return load({ deduplicate: false });
  const cacheKey = `${cacheScope(baseUrl, apiKey)}|model-yaml|${modelId}|${JSON.stringify(queryParams)}`;
  return withMetadataCache(cacheKey, ({ deduplicationScope }) => load({ deduplicationScope }),
    options?.branchId ? 15_000 : 90_000
  );
}

export async function updateModelYamlFile(
  baseUrl: string,
  apiKey: string,
  params: {
    modelId: string;
    fileName: 'model' | 'relationships' | `${string}.topic` | `${string}.view`;
    yaml: string;
    mode?: 'combined' | 'extension' | 'staged' | 'merged' | 'history';
    branchId?: string;
    commitMessage?: string;
    previousChecksum?: string;
    fullyResolved?: boolean;
  }
) {
  const result = await omniProxy<{ fileName?: string; success?: boolean }>(
    baseUrl,
    apiKey,
    'POST',
    `/v1/models/${params.modelId}/yaml`,
    {
      body: {
        fileName: params.fileName,
        yaml: params.yaml,
        mode: params.mode || 'combined',
        branchId: params.branchId,
        commitMessage: params.commitMessage,
        previousChecksum: params.previousChecksum,
        fullyResolved: params.fullyResolved,
      },
    }
  );
  clearMetadataCache(`${cacheScope(baseUrl, apiKey)}|model-yaml|${params.modelId}|`);
  return result;
}

export async function updateModelYamlFiles(
  baseUrl: string,
  apiKey: string,
  params: {
    modelId: string;
    files: Array<{ fileName: string; yaml: string; previousChecksum?: string }>;
    mode?: 'combined' | 'extension' | 'staged' | 'merged' | 'history';
    branchId?: string;
    commitMessage?: string;
    fullyResolved?: boolean;
  }
) {
  if (params.files.length === 0) return { success: true };
  const files = [];
  for (const file of params.files) {
    files.push(await updateModelYamlFile(baseUrl, apiKey, {
      modelId: params.modelId,
      fileName: file.fileName as 'model' | 'relationships' | `${string}.topic` | `${string}.view`,
      yaml: file.yaml,
      mode: params.mode,
      branchId: params.branchId,
      commitMessage: params.commitMessage,
      previousChecksum: file.previousChecksum,
      fullyResolved: params.fullyResolved,
    }));
  }
  return { success: true, files };
}

export async function deleteModelYamlFile(
  baseUrl: string,
  apiKey: string,
  params: {
    modelId: string;
    fileName: string;
    branchId?: string;
    mode?: 'combined' | 'extension' | 'staged' | 'merged' | 'history';
    commitMessage?: string;
  }
) {
  const queryParams: Record<string, string> = { fileName: params.fileName };
  if (params.branchId) queryParams.branchId = params.branchId;
  if (params.mode) queryParams.mode = params.mode;
  if (params.commitMessage) queryParams.commitMessage = params.commitMessage;
  const result = await omniProxy<Record<string, unknown>>(
    baseUrl,
    apiKey,
    'DELETE',
    `/v1/models/${params.modelId}/yaml`,
    { queryParams }
  );
  clearMetadataCache(`${cacheScope(baseUrl, apiKey)}|model-yaml|${params.modelId}|`);
  return result;
}

export async function deleteModelView(
  baseUrl: string,
  apiKey: string,
  params: {
    modelId: string;
    viewName: string;
    mode?: 'COMBINED' | 'EXTENSION' | 'MERGED';
    branchId?: string;
  }
) {
  const queryParams: Record<string, string> = {};
  if (params.mode) queryParams.mode = params.mode;
  if (params.branchId) queryParams.branchId = params.branchId;
  const result = await omniProxy<Record<string, unknown>>(
    baseUrl,
    apiKey,
    'DELETE',
    `/v1/models/${params.modelId}/view/${encodeURIComponent(params.viewName)}`,
    { queryParams: Object.keys(queryParams).length ? queryParams : undefined }
  );
  clearMetadataCache(`${cacheScope(baseUrl, apiKey)}|model-yaml|${params.modelId}|`);
  return result;
}

export interface OmniModelBranch {
  id?: string;
  name?: string;
  modelName?: string;
  model_name?: string;
  kind?: string;
  modelKind?: string;
  model_kind?: string;
  error?: string;
  [key: string]: unknown;
}

export async function createModelBranch(
  baseUrl: string,
  apiKey: string,
  params: {
    connectionId: string;
    baseModelId: string;
    branchName: string;
  }
) {
  const data = await createModel(
    baseUrl,
    apiKey,
    params.connectionId,
    params.branchName,
    'BRANCH',
    params.baseModelId
  );
  clearMetadataCache(`${cacheScope(baseUrl, apiKey)}|models|`);
  return data as OmniModelBranch;
}

export async function mergeModelBranch(
  baseUrl: string,
  apiKey: string,
  params: {
    modelId: string;
    branchName: string;
    publishDrafts?: boolean;
    deleteBranch?: boolean;
    forceOverrideGitSettings?: boolean;
  }
) {
  const result = await omniProxy<Record<string, unknown>>(
    baseUrl,
    apiKey,
    'POST',
    `/v1/models/${params.modelId}/branch/${encodeURIComponent(params.branchName)}/merge`,
    {
      body: {
        publish_drafts: params.publishDrafts === true,
        delete_branch: params.deleteBranch === true,
        force_override_git_settings: params.forceOverrideGitSettings === true,
      },
    }
  );
  clearMetadataCache(`${cacheScope(baseUrl, apiKey)}|models|`);
  clearMetadataCache(`${cacheScope(baseUrl, apiKey)}|model-yaml|${params.modelId}|`);
  return result;
}

export interface OmniModelGitConfiguration {
  baseBranch?: string;
  base_branch?: string;
  branchPerPullRequest?: boolean;
  branch_per_pull_request?: boolean;
  gitFollower?: boolean;
  git_follower?: boolean;
  requirePullRequest?: 'always' | 'users-only' | 'never' | string;
  require_pull_request?: 'always' | 'users-only' | 'never' | string;
  webUrl?: string;
  web_url?: string;
  [key: string]: unknown;
}

export async function getModelGitConfiguration(baseUrl: string, apiKey: string, modelId: string) {
  return omniProxy<OmniModelGitConfiguration>(
    baseUrl,
    apiKey,
    'GET',
    `/v1/models/${modelId}/git`
  );
}

export async function createOrUpdateModelBranchPullRequest(
  baseUrl: string,
  apiKey: string,
  params: {
    modelId: string;
    branchId: string;
    commitMessage: string;
    allowBranchExists?: boolean;
    requireBranchExists?: boolean;
  }
) {
  return omniProxy<Record<string, unknown>>(
    baseUrl,
    apiKey,
    'POST',
    `/v1/models/${params.modelId}/git/commit`,
    {
      body: {
        branch_id: params.branchId,
        commit_message: params.commitMessage,
        allow_branch_exists: params.allowBranchExists !== false,
        require_branch_exists: params.requireBranchExists === true,
      },
    }
  );
}

export async function deleteModelBranch(
  baseUrl: string,
  apiKey: string,
  modelId: string,
  branchName: string,
) {
  const result = await omniProxy<Record<string, unknown>>(
    baseUrl,
    apiKey,
    'DELETE',
    `/v1/models/${modelId}/branch/${encodeURIComponent(branchName)}`
  );
  clearMetadataCache(`${cacheScope(baseUrl, apiKey)}|models|`);
  return result;
}

export async function refreshModel(
  baseUrl: string,
  apiKey: string,
  modelId: string,
  options?: { branchId?: string },
) {
  return omniProxy<{ jobId?: string; job_id?: string; id?: string; status?: string }>(
    baseUrl,
    apiKey,
    'POST',
    `/v1/models/${modelId}/refresh`,
    { queryParams: options?.branchId ? { branch_id: options.branchId } : undefined }
  );
}

export interface ValidateModelContentOptions {
  branchId?: string;
  userId?: string;
  includePersonalFolders?: boolean;
  find?: string;
  findType?: 'VIEW' | 'FIELD' | 'TOPIC';
}

export async function validateModelContent(
  baseUrl: string,
  apiKey: string,
  modelId: string,
  branchOrOptions?: string | ValidateModelContentOptions,
) {
  const options = typeof branchOrOptions === 'string'
    ? { branchId: branchOrOptions }
    : branchOrOptions;
  const queryParams: Record<string, string> = {};
  if (options?.branchId) queryParams.branch_id = options.branchId;
  if (options?.userId) queryParams.userId = options.userId;
  if (options?.includePersonalFolders !== undefined) queryParams.include_personal_folders = String(options.includePersonalFolders);
  if (options?.find) queryParams.find = options.find;
  if (options?.findType) queryParams.find_type = options.findType;
  return omniProxy<Record<string, unknown>>(
    baseUrl,
    apiKey,
    'GET',
    `/v1/models/${modelId}/content-validator`,
    { queryParams: Object.keys(queryParams).length ? queryParams : undefined }
  );
}

export interface RunOmniMigrationQueryOptions {
  branchId?: string;
  planOnly?: boolean;
  resultType?: 'json';
  cache?: 'Standard' | 'SkipRequery' | 'SkipCache';
}

export async function runOmniMigrationQuery(
  baseUrl: string,
  apiKey: string,
  query: Record<string, unknown>,
  options: RunOmniMigrationQueryOptions = {},
) {
  return omniProxy<Record<string, unknown>>(
    baseUrl,
    apiKey,
    'POST',
    '/v1/query/run',
    {
      body: {
        query,
        ...(options.branchId ? { branchId: options.branchId } : {}),
        ...(options.planOnly ? { planOnly: true } : {}),
        ...(!options.planOnly && options.resultType ? { resultType: options.resultType } : {}),
        ...(!options.planOnly && options.cache ? { cache: options.cache } : {}),
        ...(!options.planOnly && options.resultType ? { formatResults: false } : {}),
      },
    },
  );
}

export interface OmniAiJob {
  jobId?: string;
  id?: string;
  conversationId?: string;
  conversation_id?: string;
  omniChatUrl?: string;
  omni_chat_url?: string;
  state?: string;
  status?: string;
  resultSummary?: string;
  result_summary?: string;
  message?: string;
  topicName?: string;
  topic_name?: string;
  topic?: string;
  actions?: Array<Record<string, unknown>>;
  error?: unknown;
}

export const OMNI_AI_CONTENT_STUDIO_COMPLETE_NO_USABLE_RESULT_CODE = 'COMPLETE_NO_USABLE_RESULT';

export type OmniAiContentStudioProjectionIssue =
  | 'MESSAGE_DROPPED'
  | 'RESULT_SUMMARY_DROPPED'
  | 'ACTIONS_DROPPED'
  | 'ACTION_DROPPED'
  | 'ACTIONS_TRUNCATED'
  | 'TOPIC_DROPPED'
  | 'OMNI_CHAT_URL_DROPPED';

export interface OmniAiContentStudioProjectedAction extends Record<string, unknown> {
  type: string;
  message: string;
  timestamp: string;
  documentId?: string;
}

export interface OmniAiJobResult {
  actions?: Array<Record<string, unknown>>;
  message?: string;
  resultSummary?: string;
  result_summary?: string;
  finalMessage?: string;
  final_message?: string;
  answer?: string;
  topic?: string;
  omniChatUrl?: string;
  omni_chat_url?: string;
  projectionIssues?: OmniAiContentStudioProjectionIssue[];
}

export interface OmniAiContentStudioJobResult {
  actions?: OmniAiContentStudioProjectedAction[];
  message?: string;
  resultSummary?: string;
  topic?: string;
  omniChatUrl?: string;
  projectionIssues?: OmniAiContentStudioProjectionIssue[];
}

export const OMNI_AI_ATTACHMENT_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
  'application/pdf',
] as const;

export type OmniAiAttachmentMimeType = typeof OMNI_AI_ATTACHMENT_MIME_TYPES[number];

export interface OmniAiAttachment {
  data: string;
  mimeType: OmniAiAttachmentMimeType;
  name?: string;
}

export const OMNI_AI_ATTACHMENT_MAX_COUNT = 5;
export const OMNI_AI_IMAGE_ATTACHMENT_MAX_RAW_BYTES = 3 * 1024 * 1024;
export const OMNI_AI_ATTACHMENTS_MAX_COMBINED_RAW_BYTES = 15 * 1024 * 1024;
const AI_CONTENT_STUDIO_RESPONSE_CONTRACT = 'ai-content-studio-v1';

const OMNI_AI_ATTACHMENT_MIME_TYPE_SET = new Set<string>(OMNI_AI_ATTACHMENT_MIME_TYPES);
function isCanonicalAiBase64(data: string): boolean {
  if (!data || data.length % 4 !== 0) return false;
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  const contentLength = data.length - padding;
  let lastValue = 0;
  for (let index = 0; index < contentLength; index += 1) {
    const code = data.charCodeAt(index);
    const valid = (code >= 65 && code <= 90)
      || (code >= 97 && code <= 122)
      || (code >= 48 && code <= 57)
      || code === 43
      || code === 47;
    if (!valid) return false;
    lastValue = code >= 65 && code <= 90
      ? code - 65
      : code >= 97 && code <= 122
        ? code - 71
        : code >= 48 && code <= 57
          ? code + 4
          : code === 43 ? 62 : 63;
  }
  for (let index = contentLength; index < data.length; index += 1) {
    if (data.charCodeAt(index) !== 61) return false;
  }
  if ((padding === 2 && (lastValue & 15) !== 0) || (padding === 1 && (lastValue & 3) !== 0)) return false;
  return true;
}

function aiAttachmentRawByteLength(data: string): number | null {
  if (!isCanonicalAiBase64(data)) return null;
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0;
  return (data.length / 4) * 3 - padding;
}

function assertValidAiAttachments(attachments: OmniAiAttachment[] | undefined): void {
  if (!attachments) return;
  if (attachments.length > OMNI_AI_ATTACHMENT_MAX_COUNT) {
    throw new ApiError(413, `A maximum of ${OMNI_AI_ATTACHMENT_MAX_COUNT} AI attachments is allowed.`);
  }
  let combinedRawBytes = 0;
  attachments.forEach((attachment, index) => {
    if (!OMNI_AI_ATTACHMENT_MIME_TYPE_SET.has(attachment.mimeType)) {
      throw new ApiError(400, `Attachment ${index + 1} has an unsupported MIME type.`);
    }
    const rawBytes = aiAttachmentRawByteLength(attachment.data);
    if (rawBytes == null) {
      throw new ApiError(400, `Attachment ${index + 1} data must be canonical base64.`);
    }
    if (attachment.mimeType.startsWith('image/') && rawBytes > OMNI_AI_IMAGE_ATTACHMENT_MAX_RAW_BYTES) {
      throw new ApiError(413, `Image attachment ${index + 1} exceeds the 3 MiB raw file limit.`);
    }
    if (attachment.name !== undefined && (!attachment.name.trim() || attachment.name.length > 255 || /[\0\r\n]/.test(attachment.name))) {
      throw new ApiError(400, `Attachment ${index + 1} has an invalid name.`);
    }
    combinedRawBytes += rawBytes;
  });
  if (combinedRawBytes > OMNI_AI_ATTACHMENTS_MAX_COMBINED_RAW_BYTES) {
    throw new ApiError(413, 'AI attachments exceed the 15 MiB combined raw file limit.');
  }
}

export async function pickAiTopic(
  baseUrl: string,
  apiKey: string,
  params: {
    modelId: string;
    prompt: string;
    branchId?: string;
    currentTopicName?: string;
    potentialTopicNames?: string[];
    userId?: string;
  }
) {
  const res = await safeFetch(
    edgeFunctionUrl('manage-ai'),
    {
      method: 'POST',
      headers: defaultHeaders,
      body: JSON.stringify({
        base_url: baseUrl,
        api_key: apiKey,
        action: 'pick-topic',
        model_id: params.modelId,
        prompt: params.prompt,
        branch_id: params.branchId,
        current_topic_name: params.currentTopicName,
        potential_topic_names: params.potentialTopicNames,
        user_id: params.userId,
      }),
    },
    'Pick AI topic'
  );
  return res.json() as Promise<{ topicId?: string; error?: string }>;
}

async function createAiJobRequest(
  baseUrl: string,
  apiKey: string,
  params: {
    modelId: string;
    prompt: string;
    topicName?: string;
    branchId?: string;
    conversationId?: string;
    userId?: string;
    attachments?: OmniAiAttachment[];
  },
  signal?: AbortSignal,
  responseContract?: string,
): Promise<OmniAiJob> {
  assertValidAiAttachments(params.attachments);
  const attachmentBytes = params.attachments?.reduce((sum, attachment) => (
    sum + (aiAttachmentRawByteLength(attachment.data) || 0)
  ), 0) || 0;
  if (new TextEncoder().encode(params.prompt).byteLength + attachmentBytes > OMNI_AI_ATTACHMENTS_MAX_COMBINED_RAW_BYTES) {
    throw new ApiError(413, 'The AI prompt and attachments exceed the 15 MiB combined request limit.');
  }
  const res = await safeFetch(
    edgeFunctionUrl('manage-ai'),
    {
      method: 'POST',
      headers: defaultHeaders,
      body: JSON.stringify({
        base_url: baseUrl,
        api_key: apiKey,
        action: 'create-job',
        model_id: params.modelId,
        prompt: params.prompt,
        topic_name: params.topicName,
        branch_id: params.branchId,
        conversation_id: params.conversationId,
        user_id: params.userId,
        attachments: params.attachments,
        response_contract: responseContract,
      }),
      signal,
    },
    'Create AI job',
    { deduplicate: false },
  );
  return res.json();
}

export async function createAiJob(
  baseUrl: string,
  apiKey: string,
  params: {
    modelId: string;
    prompt: string;
    topicName?: string;
    branchId?: string;
    conversationId?: string;
    userId?: string;
    attachments?: OmniAiAttachment[];
  },
  signal?: AbortSignal,
): Promise<OmniAiJob> {
  return createAiJobRequest(baseUrl, apiKey, params, signal);
}

export async function createAiContentStudioJob(
  baseUrl: string,
  apiKey: string,
  params: {
    modelId: string;
    prompt: string;
    topicName?: string;
    branchId?: string;
    conversationId?: string;
    userId?: string;
    attachments?: OmniAiAttachment[];
  },
  signal?: AbortSignal,
): Promise<OmniAiJob> {
  return createAiJobRequest(baseUrl, apiKey, params, signal, AI_CONTENT_STUDIO_RESPONSE_CONTRACT);
}

async function getAiJobRequest(
  baseUrl: string,
  apiKey: string,
  jobId: string,
  signal?: AbortSignal,
  responseContract?: string,
): Promise<OmniAiJob> {
  const res = await safeFetch(
    edgeFunctionUrl('manage-ai'),
    {
      method: 'POST',
      headers: defaultHeaders,
      body: JSON.stringify({
        base_url: baseUrl,
        api_key: apiKey,
        action: 'get-job',
        job_id: jobId,
        response_contract: responseContract,
      }),
      signal,
    },
    'Get AI job',
    { deduplicate: false },
  );
  return res.json();
}

export async function getAiJob(baseUrl: string, apiKey: string, jobId: string, signal?: AbortSignal): Promise<OmniAiJob> {
  return getAiJobRequest(baseUrl, apiKey, jobId, signal);
}

export async function getAiContentStudioJob(
  baseUrl: string,
  apiKey: string,
  jobId: string,
  signal?: AbortSignal,
): Promise<OmniAiJob> {
  return getAiJobRequest(baseUrl, apiKey, jobId, signal, AI_CONTENT_STUDIO_RESPONSE_CONTRACT);
}

export async function getAiJobResult(baseUrl: string, apiKey: string, jobId: string, signal?: AbortSignal): Promise<OmniAiJobResult> {
  const res = await safeFetch(
    edgeFunctionUrl('manage-ai'),
    {
      method: 'POST',
      headers: defaultHeaders,
      body: JSON.stringify({
        base_url: baseUrl,
        api_key: apiKey,
        action: 'get-job-result',
        job_id: jobId,
      }),
      signal,
    },
    'Get AI job result',
    { deduplicate: false },
  );
  return res.json();
}

/**
 * AI Content Studio result reader. The local proxy projects away query definitions,
 * CSV rows, and other action result data before the response reaches the browser.
 */
export async function getAiContentStudioJobResult(
  baseUrl: string,
  apiKey: string,
  jobId: string,
  signal?: AbortSignal,
): Promise<OmniAiContentStudioJobResult> {
  const res = await safeFetch(
    edgeFunctionUrl('manage-ai'),
    {
      method: 'POST',
      headers: defaultHeaders,
      body: JSON.stringify({
        base_url: baseUrl,
        api_key: apiKey,
        action: 'get-content-studio-job-result',
        job_id: jobId,
      }),
      signal,
    },
    'Get AI Content Studio job result',
    { deduplicate: false },
  );
  return res.json();
}

export interface AiContentDocumentVerification {
  identifier: string;
  name: string;
  modelId: string;
  queryCount: number;
  queries: Array<{
    id: string;
    name: string;
    modelIds: string[];
  }>;
  queryPresentationCount: number;
  queryPresentationTypes: Array<{
    type: 'blank' | 'csv' | 'query' | 'dataset' | 'spreadsheet' | 'sql' | 'dbt' | 'query-view' | 'linked' | 'app';
    count: number;
  }>;
  layoutContainerCount: number;
  filterCount: number;
  controlCount: number;
  accessGrantCount: number;
  directAccessGrantCount: number;
  inheritedAccessGrantCount: number;
  ownerGrantCount: number;
  accessListComplete: true;
  contentValidationIssues: string[];
  verifiedAt: string;
}

export interface AiContentDocumentTrashResult {
  identifier: string;
  trashed: true;
  trashedAt: string;
}

/**
 * Authoritatively rereads a known dashboard identifier using current Documents
 * v2 state plus documented query, filter/control, complete access-list, and
 * content-validator endpoints. Non-dashboard artifacts fail closed when the
 * dashboard-specific postconditions cannot be read.
 */
export async function verifyAiContentDocument(
  baseUrl: string,
  apiKey: string,
  documentId: string,
  signal?: AbortSignal,
): Promise<AiContentDocumentVerification> {
  const res = await safeFetch(
    edgeFunctionUrl('manage-ai'),
    {
      method: 'POST',
      headers: defaultHeaders,
      body: JSON.stringify({
        base_url: baseUrl,
        api_key: apiKey,
        action: 'verify-content-document',
        document_id: documentId,
      }),
      signal,
    },
    'Verify AI Content Studio document',
    { deduplicate: false },
  );
  return res.json();
}

/** Moves one explicitly identified AI-created document to recoverable Omni Trash. */
export async function trashAiContentDocument(
  baseUrl: string,
  apiKey: string,
  documentId: string,
  signal?: AbortSignal,
): Promise<AiContentDocumentTrashResult> {
  const res = await safeFetch(
    edgeFunctionUrl('manage-ai'),
    {
      method: 'POST',
      headers: defaultHeaders,
      body: JSON.stringify({
        base_url: baseUrl,
        api_key: apiKey,
        action: 'trash-content-document',
        document_id: documentId,
      }),
      signal,
    },
    'Trash AI Content Studio document',
    { deduplicate: false },
  );
  return res.json();
}

async function cancelAiJobRequest(
  baseUrl: string,
  apiKey: string,
  jobId: string,
  signal?: AbortSignal,
  responseContract?: string,
): Promise<OmniAiJob> {
  const res = await safeFetch(
    edgeFunctionUrl('manage-ai'),
    {
      method: 'POST',
      headers: defaultHeaders,
      body: JSON.stringify({
        base_url: baseUrl,
        api_key: apiKey,
        action: 'cancel-job',
        job_id: jobId,
        response_contract: responseContract,
      }),
      signal,
    },
    'Cancel AI job',
    { deduplicate: false },
  );
  return res.json();
}

export async function cancelAiJob(baseUrl: string, apiKey: string, jobId: string, signal?: AbortSignal): Promise<OmniAiJob> {
  return cancelAiJobRequest(baseUrl, apiKey, jobId, signal);
}

export async function cancelAiContentStudioJob(
  baseUrl: string,
  apiKey: string,
  jobId: string,
  signal?: AbortSignal,
): Promise<OmniAiJob> {
  return cancelAiJobRequest(baseUrl, apiKey, jobId, signal, AI_CONTENT_STUDIO_RESPONSE_CONTRACT);
}

export async function getDashboardFilters(baseUrl: string, apiKey: string, dashboardId: string) {
  return omniProxy<Record<string, unknown>>(
    baseUrl,
    apiKey,
    'GET',
    `/v1/dashboards/${dashboardId}/filters`
  );
}

export interface EnrichmentResult {
  baseModelId: string | null;
  baseModelName: string | null;
  topicNames: string[] | null;
  connectionName: string | null;
  connectionId: string | null;
  enrichmentError: string | null;
}

async function enrichDocumentsNetwork(
  baseUrl: string,
  apiKey: string,
  documentIds: string[]
): Promise<Record<string, EnrichmentResult>> {
  const res = await safeFetch(
    edgeFunctionUrl('enrich-documents'),
    { method: 'POST', headers: defaultHeaders, body: JSON.stringify({ base_url: baseUrl, api_key: apiKey, document_ids: documentIds }) },
    'Enrich documents'
  );
  const data = await res.json();
  const map: Record<string, EnrichmentResult> = {};
  if (Array.isArray(data.enrichments)) {
    for (const e of data.enrichments) {
      map[e.id] = {
        baseModelId: e.baseModelId || null,
        baseModelName: e.baseModelName || null,
        topicNames: Array.isArray(e.topicNames) ? e.topicNames : null,
        connectionName: e.connectionName || null,
        connectionId: e.connectionId || null,
        enrichmentError: e.enrichmentError || null,
      };
    }
  }
  return map;
}

export async function enrichDocuments(
  baseUrl: string,
  apiKey: string,
  documentIds: string[]
): Promise<Record<string, EnrichmentResult>> {
  if (documentIds.length === 0) return {};
  const { getCachedEnrichments, setCachedEnrichments } = await import('./enrichmentCache');
  const { hits, missing } = getCachedEnrichments(baseUrl, documentIds);
  if (missing.length === 0) return hits;
  const fresh = await enrichDocumentsNetwork(baseUrl, apiKey, missing);
  setCachedEnrichments(baseUrl, fresh);
  return { ...hits, ...fresh };
}

async function consumeSseStream(
  res: Response,
  onEvent: (event: Record<string, unknown>) => void
): Promise<void> {
  const reader = res.body?.getReader();
  if (!reader) throw new ApiError(0, 'No response stream available.');

  const decoder = new TextDecoder();
  let buffer = '';
  let receivedComplete = false;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.startsWith('data: ')) {
        try {
          const data = JSON.parse(trimmed.slice(6));
          if (data.type === 'heartbeat') continue;
          if (data.type === 'complete') receivedComplete = true;
          onEvent(data);
        } catch {
          // skip malformed SSE lines
        }
      }
    }
  }

  if (buffer.trim().startsWith('data: ')) {
    try {
      const data = JSON.parse(buffer.trim().slice(6));
      if (data.type === 'heartbeat') {
        // skip
      } else {
        if (data.type === 'complete') receivedComplete = true;
        onEvent(data);
      }
    } catch {
      // skip
    }
  }

  if (!receivedComplete) {
    onEvent({
      type: 'complete',
      summary: { succeeded: 0, failed: 0, skipped: 0, total: 0 },
      results: [],
      warning: 'Connection ended before operation completed. Results may be incomplete.',
    });
  }
}

export async function bulkDeleteDocuments(
  params: {
    base_url: string;
    api_key: string;
    document_ids: Array<{ id: string; name: string }>;
  },
  onEvent: (event: Record<string, unknown>) => void
): Promise<void> {
  const res = await safeFetch(
    edgeFunctionUrl('bulk-delete-documents'),
    { method: 'POST', headers: defaultHeaders, body: JSON.stringify(params) },
    'Bulk delete'
  );
  await consumeSseStream(res, onEvent);
}

export async function bulkMoveDocuments(
  params: {
    base_url: string;
    api_key: string;
    document_ids: Array<{ id: string; name: string; base_model_id?: string }>;
    target_folder_path: string;
    target_folder_id?: string;
    scope?: string;
  },
  onEvent: (event: Record<string, unknown>) => void
): Promise<void> {
  const res = await safeFetch(
    edgeFunctionUrl('bulk-move-documents'),
    { method: 'POST', headers: defaultHeaders, body: JSON.stringify(params) },
    'Bulk move'
  );
  await consumeSseStream(res, onEvent);
}

export async function bulkCopyDocuments(
  params: {
    base_url: string;
    api_key: string;
    document_ids: Array<{ id: string; name: string; base_model_id?: string }>;
    target_folder_path: string;
    target_folder_id?: string;
    scope?: string;
    base_model_id_override?: string;
    rename_suffix?: string;
  },
  onEvent: (event: Record<string, unknown>) => void
): Promise<void> {
  const res = await safeFetch(
    edgeFunctionUrl('bulk-copy-documents'),
    { method: 'POST', headers: defaultHeaders, body: JSON.stringify(params) },
    'Bulk copy'
  );
  await consumeSseStream(res, onEvent);
}

export type ScimListResponse = {
  Resources?: Array<Record<string, unknown>>;
  totalResults?: number;
  itemsPerPage?: number;
  startIndex?: number;
  error?: unknown;
  validationReasonCode?: string;
  loadedResults?: number;
  truncated?: boolean;
  [key: string]: unknown;
};

export type ScimCollectionKind = 'user' | 'group';

export const SCIM_USER_ATTRIBUTE_LIMITS = {
  maxAttributes: 128,
  maxKeyLength: 256,
  maxStringLength: 16 * 1024,
  maxArrayEntries: 1_000,
  maxSerializedBytes: 256 * 1024,
} as const;

const PROTOTYPE_DANGEROUS_ATTRIBUTE_KEYS = new Set(['__proto__', 'prototype', 'constructor']);

function hasAttributeKeyControlCharacters(key: string): boolean {
  for (const character of key) {
    const codePoint = character.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 31 || codePoint === 127)) return true;
  }
  return false;
}

export function isSafeScimUserAttributeKey(key: string): boolean {
  return key.length > 0
    && key.length <= SCIM_USER_ATTRIBUTE_LIMITS.maxKeyLength
    && key.trim() === key
    && !hasAttributeKeyControlCharacters(key)
    && !PROTOTYPE_DANGEROUS_ATTRIBUTE_KEYS.has(key.toLowerCase());
}

type ScimListValidationReason =
  | 'BODY_NOT_OBJECT'
  | 'BODY_INVALID_JSON'
  | 'RESOURCES_NOT_ARRAY'
  | 'TOTAL_RESULTS_INVALID'
  | 'ITEMS_PER_PAGE_INVALID'
  | 'START_INDEX_INVALID'
  | 'START_INDEX_MISMATCH'
  | 'ITEMS_PER_PAGE_MISMATCH'
  | 'REQUEST_COUNT_EXCEEDED'
  | 'RESULT_WINDOW_EXCEEDED'
  | 'EMPTY_PAGE_BEFORE_TOTAL'
  | 'RESOURCE_NOT_OBJECT'
  | 'RESOURCE_ID_INVALID'
  | 'USER_NAME_INVALID'
  | 'USER_DISPLAY_NAME_INVALID'
  | 'USER_ACTIVE_INVALID'
  | 'USER_GROUPS_INVALID'
  | 'USER_ATTRIBUTES_NOT_OBJECT'
  | 'USER_ATTRIBUTES_LIMIT_EXCEEDED'
  | 'USER_ATTRIBUTE_KEY_INVALID'
  | 'USER_ATTRIBUTE_VALUE_INVALID'
  | 'USER_ATTRIBUTES_SIZE_EXCEEDED'
  | 'USER_ATTRIBUTES_SERIALIZATION_FAILED'
  | 'GROUP_DISPLAY_NAME_INVALID'
  | 'GROUP_MEMBERS_INVALID'
  | 'DUPLICATE_RESOURCE'
  | 'SNAPSHOT_TOTAL_CHANGED'
  | 'PAGINATION_NO_PROGRESS'
  | 'FILTER_TOTAL_MISMATCH'
  | 'FILTER_IDENTITY_MISMATCH'
  | 'RESOURCE_IDENTITY_MISMATCH';

class ScimListValidationError extends Error {
  readonly code: string;

  constructor(kind: ScimCollectionKind, reason: ScimListValidationReason) {
    const code = `SCIM_${kind.toUpperCase()}_LIST_${reason}`;
    super(`Omni returned an invalid SCIM ${kind} list response. Try again or verify the endpoint contract. Diagnostic code: ${code}.`);
    this.name = 'ScimListValidationError';
    this.code = code;
  }
}

function invalidScimListResponse(kind: ScimCollectionKind, reason: ScimListValidationReason): Error {
  return new ScimListValidationError(kind, reason);
}

function scimListValidationCode(error: unknown): string | undefined {
  return error instanceof ScimListValidationError ? error.code : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isScimMember(value: unknown): value is { value: string; display?: string } {
  if (!isRecord(value) || !isNonBlankString(value.value)) return false;
  return value.display === undefined || typeof value.display === 'string';
}

export function parseScimGroupMembers(value: unknown): Array<{ value: string; display: string }> | null {
  if (!Array.isArray(value) || !value.every(isScimMember)) return null;
  return value.map((member) => ({
    value: member.value,
    display: member.display ?? '',
  }));
}

export function hasAvailableScimGroupMembershipEvidence(
  evidence: 'available' | 'unknown' | 'failed' | undefined,
  detailedMembers: unknown,
  listedMembers: unknown,
): boolean {
  return evidence === 'available'
    && (parseScimGroupMembers(detailedMembers) !== null || parseScimGroupMembers(listedMembers) !== null);
}

function isBoundedScimString(value: unknown): value is string {
  return typeof value === 'string' && value.length <= SCIM_USER_ATTRIBUTE_LIMITS.maxStringLength;
}

function isFiniteScimNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isDenseArray(value: unknown[]): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) return false;
  }
  return true;
}

function isSafeScimAttributeValue(value: unknown): boolean {
  // Omni exposes read-only system user attributes (for example,
  // omni_is_org_admin) as booleans alongside string/number custom values.
  // Omni may also return null for unset or cleared attributes.
  if (value === null) return true;
  if (isBoundedScimString(value) || isFiniteScimNumber(value) || typeof value === 'boolean') return true;
  if (!Array.isArray(value) || value.length > SCIM_USER_ATTRIBUTE_LIMITS.maxArrayEntries || !isDenseArray(value)) {
    return false;
  }
  if (value.length === 0) return true;
  if (typeof value[0] === 'string') return value.every(isBoundedScimString);
  if (typeof value[0] === 'number') return value.every(isFiniteScimNumber);
  return false;
}

function scimUserAttributesInvalidReason(value: unknown): ScimListValidationReason | null {
  if (!isRecord(value)) return 'USER_ATTRIBUTES_NOT_OBJECT';
  const entries = Object.entries(value);
  if (entries.length > SCIM_USER_ATTRIBUTE_LIMITS.maxAttributes) return 'USER_ATTRIBUTES_LIMIT_EXCEEDED';

  for (const [key, attribute] of entries) {
    if (!isSafeScimUserAttributeKey(key)) return 'USER_ATTRIBUTE_KEY_INVALID';
    if (!isSafeScimAttributeValue(attribute)) return 'USER_ATTRIBUTE_VALUE_INVALID';
  }

  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength
      <= SCIM_USER_ATTRIBUTE_LIMITS.maxSerializedBytes
      ? null
      : 'USER_ATTRIBUTES_SIZE_EXCEEDED';
  } catch {
    return 'USER_ATTRIBUTES_SERIALIZATION_FAILED';
  }
}

function isSafeScimUserAttributes(value: unknown): value is OmniUserAttributes {
  return scimUserAttributesInvalidReason(value) === null;
}

export function cloneScimUserAttributes(attributes: OmniUserAttributes | undefined): OmniUserAttributes {
  const source = attributes ?? {};
  if (!isSafeScimUserAttributes(source)) {
    throw new Error('Omni returned invalid user attributes.');
  }
  const cloned = Object.create(null) as OmniUserAttributes;
  for (const [key, value] of Object.entries(source)) {
    cloned[key] = value === null
      ? null
      : Array.isArray(value)
        ? value.length > 0 && typeof value[0] === 'number'
          ? [...value] as number[]
          : [...value] as string[]
        : value;
  }
  return cloned;
}

type ScimCollectionResource = Record<string, unknown> & {
  id: string;
  userName?: string;
  displayName?: string;
  members?: Array<{ value: string; display?: string }>;
};

function scimCollectionResourceInvalidReason(
  value: unknown,
  kind: ScimCollectionKind,
): ScimListValidationReason | null {
  if (!isRecord(value)) return 'RESOURCE_NOT_OBJECT';
  if (!isNonBlankString(value.id)) return 'RESOURCE_ID_INVALID';
  if (kind === 'user') {
    if (!isNonBlankString(value.userName)) return 'USER_NAME_INVALID';
    if (value.displayName !== undefined && typeof value.displayName !== 'string') return 'USER_DISPLAY_NAME_INVALID';
    if (Object.prototype.hasOwnProperty.call(value, 'active') && typeof value.active !== 'boolean') return 'USER_ACTIVE_INVALID';
    if (value.groups !== undefined && (!Array.isArray(value.groups) || !value.groups.every(isScimMember))) {
      return 'USER_GROUPS_INVALID';
    }
    const attributes = value['urn:omni:params:1.0:UserAttribute'];
    if (Object.prototype.hasOwnProperty.call(value, 'urn:omni:params:1.0:UserAttribute')) {
      const attributeReason = scimUserAttributesInvalidReason(attributes);
      if (attributeReason) return attributeReason;
    }
  }
  if (kind === 'group' && !isNonBlankString(value.displayName)) return 'GROUP_DISPLAY_NAME_INVALID';
  if (kind === 'group' && value.members !== undefined) {
    if (!Array.isArray(value.members) || !value.members.every(isScimMember)) return 'GROUP_MEMBERS_INVALID';
  }
  return null;
}

export function parseScimListResponse(
  payload: unknown,
  kind: ScimCollectionKind,
  requestedCount: number,
  requestedStartIndex: number,
): ScimListResponse {
  if (!isRecord(payload)) throw invalidScimListResponse(kind, 'BODY_NOT_OBJECT');

  // A service error must reject the read and must not expose the raw response value.
  if (Object.prototype.hasOwnProperty.call(payload, 'error')) {
    throw new Error(`Omni could not complete the SCIM ${kind} list request.`);
  }

  const resources = payload.Resources;
  const totalResults = payload.totalResults;
  const itemsPerPage = payload.itemsPerPage;
  const startIndex = payload.startIndex;

  if (!Array.isArray(resources)) throw invalidScimListResponse(kind, 'RESOURCES_NOT_ARRAY');
  if (!isNonNegativeInteger(totalResults)) throw invalidScimListResponse(kind, 'TOTAL_RESULTS_INVALID');
  if (!isNonNegativeInteger(itemsPerPage)) throw invalidScimListResponse(kind, 'ITEMS_PER_PAGE_INVALID');
  if (!isPositiveInteger(startIndex)) throw invalidScimListResponse(kind, 'START_INDEX_INVALID');
  if (startIndex !== requestedStartIndex) throw invalidScimListResponse(kind, 'START_INDEX_MISMATCH');
  if (itemsPerPage !== resources.length) throw invalidScimListResponse(kind, 'ITEMS_PER_PAGE_MISMATCH');
  if (resources.length > requestedCount) throw invalidScimListResponse(kind, 'REQUEST_COUNT_EXCEEDED');

  const remainingResults = Math.max(0, totalResults - (startIndex - 1));
  const maximumPageLength = Math.min(requestedCount, remainingResults);
  if (resources.length > maximumPageLength) throw invalidScimListResponse(kind, 'RESULT_WINDOW_EXCEEDED');
  if (remainingResults > 0 && resources.length === 0) {
    throw invalidScimListResponse(kind, 'EMPTY_PAGE_BEFORE_TOTAL');
  }

  const ids = new Set<string>();
  for (const resource of resources) {
    const resourceReason = scimCollectionResourceInvalidReason(resource, kind);
    if (resourceReason) throw invalidScimListResponse(kind, resourceReason);
    const resourceId = (resource as ScimCollectionResource).id;
    if (ids.has(resourceId)) throw invalidScimListResponse(kind, 'DUPLICATE_RESOURCE');
    ids.add(resourceId);
  }

  return payload as ScimListResponse;
}

function scimPaginationOptions(options?: { pageSize?: number; maxPages?: number }) {
  const pageSize = options?.pageSize ?? 100;
  const maxPages = options?.maxPages ?? 200;
  if (
    !Number.isSafeInteger(pageSize)
    || pageSize < 1
    || !Number.isSafeInteger(maxPages)
    || maxPages < 1
  ) {
    throw new Error('Invalid SCIM pagination configuration.');
  }
  return { pageSize, maxPages };
}

export async function listUsers(
  baseUrl: string,
  apiKey: string,
  count = 100,
  startIndex = 1,
  options: { signal?: AbortSignal } = {},
): Promise<ScimListResponse> {
  if (!isPositiveInteger(count) || !isPositiveInteger(startIndex)) {
    throw new Error('Invalid SCIM pagination configuration.');
  }
  const res = await safeFetch(
    edgeFunctionUrl('manage-users'),
    { method: 'POST', headers: defaultHeaders, signal: options.signal, body: JSON.stringify({ base_url: baseUrl, api_key: apiKey, action: 'list', count, start_index: startIndex }) },
    'List users',
    options.signal ? { deduplicate: false, retry: false } : undefined,
  );
  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    throw invalidScimListResponse('user', 'BODY_INVALID_JSON');
  }
  return parseScimListResponse(payload, 'user', count, startIndex);
}

export async function listUserAttributes(baseUrl: string, apiKey: string, options: { signal?: AbortSignal } = {}) {
  const res = await safeFetch(
    edgeFunctionUrl('manage-users'),
    { method: 'POST', headers: defaultHeaders, signal: options.signal, body: JSON.stringify({ base_url: baseUrl, api_key: apiKey, action: 'list_attributes' }) },
    'List user attributes',
    options.signal ? { deduplicate: false, retry: false } : undefined,
  );
  return res.json();
}

export async function listAllUsers(
  baseUrl: string,
  apiKey: string,
  options?: { pageSize?: number; maxPages?: number; signal?: AbortSignal }
): Promise<ScimListResponse> {
  const { pageSize, maxPages } = scimPaginationOptions(options);
  const resources: Array<Record<string, unknown>> = [];
  let startIndex = 1;
  let totalResults: number | null = null;
  let lastResponse: ScimListResponse = {};
  const resourceIds = new Set<string>();

  for (let page = 0; page < maxPages; page += 1) {
    let response: ScimListResponse;
    try {
      response = await listUsers(baseUrl, apiKey, pageSize, startIndex, { signal: options?.signal });
    } catch (error) {
      if (resources.length === 0) throw error;
      const validationReasonCode = scimListValidationCode(error);
      return {
        ...lastResponse,
        Resources: resources,
        totalResults: totalResults ?? resources.length,
        itemsPerPage: resources.length,
        startIndex: 1,
        loadedResults: resources.length,
        truncated: true,
        error: 'partial_collection_read_failed',
        // Always overwrite any same-named upstream field. Only locally
        // generated, fixed-enum diagnostic codes may survive this boundary.
        validationReasonCode,
      };
    }
    lastResponse = response;

    if (response.error) {
      return {
        ...response,
        Resources: resources,
        loadedResults: resources.length,
        truncated: resources.length > 0,
      };
    }

    const pageResources = response.Resources as Array<Record<string, unknown>>;
    const responseTotal = response.totalResults as number;
    const responseStartIndex = response.startIndex as number;
    const responseItemsPerPage = response.itemsPerPage as number;

    if (totalResults === null) totalResults = responseTotal;
    if (responseTotal !== totalResults) throw invalidScimListResponse('user', 'SNAPSHOT_TOTAL_CHANGED');
    for (const resource of pageResources) {
      const resourceId = resource.id as string;
      if (resourceIds.has(resourceId)) throw invalidScimListResponse('user', 'DUPLICATE_RESOURCE');
      resourceIds.add(resourceId);
    }
    resources.push(...pageResources);

    if (resources.length === totalResults) break;
    const nextStartIndex = responseStartIndex + responseItemsPerPage;
    if (nextStartIndex <= startIndex) throw invalidScimListResponse('user', 'PAGINATION_NO_PROGRESS');
    startIndex = nextStartIndex;
  }

  const exactTotalResults = totalResults ?? 0;
  return {
    ...lastResponse,
    Resources: resources,
    totalResults: exactTotalResults,
    itemsPerPage: resources.length,
    startIndex: 1,
    loadedResults: resources.length,
    truncated: resources.length < exactTotalResults,
  };
}

export async function findUserByEmail(baseUrl: string, apiKey: string, email: string, options: { signal?: AbortSignal } = {}) {
  const normalizedEmail = email.trim().toLowerCase();
  if (
    !normalizedEmail
    || normalizedEmail.length > 320
    || !/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+$/.test(normalizedEmail)
  ) throw new Error('A valid user email is required.');
  const res = await safeFetch(
    edgeFunctionUrl('manage-users'),
    { method: 'POST', headers: defaultHeaders, signal: options.signal, body: JSON.stringify({ base_url: baseUrl, api_key: apiKey, action: 'find', email }) },
    'Find user',
    options.signal ? { deduplicate: false, retry: false } : undefined,
  );
  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    throw invalidScimListResponse('user', 'BODY_INVALID_JSON');
  }
  const row = isRecord(payload) ? payload : null;
  const resourceCount = row && Array.isArray(row.Resources) ? row.Resources.length : 0;
  const parsed = parseScimListResponse(payload, 'user', Math.max(resourceCount, 1), 1);
  const resources = parsed.Resources as Array<Record<string, unknown>>;
  if (parsed.totalResults !== resources.length) throw invalidScimListResponse('user', 'FILTER_TOTAL_MISMATCH');
  if (resources.some((resource) => (resource.userName as string).trim().toLowerCase() !== normalizedEmail)) {
    throw invalidScimListResponse('user', 'FILTER_IDENTITY_MISMATCH');
  }
  return parsed;
}

export const USER_MODEL_ROLE_NAMES = [
  'VIEWER',
  'QUERY_TOPICS',
  'QUERIER',
  'MODELER',
  'CONNECTION_ADMIN',
  'NO_ACCESS',
] as const;

export type UserModelRoleName = typeof USER_MODEL_ROLE_NAMES[number];

export interface UserModelRoleRecord {
  roleName: string;
  baseRole: string;
  connectionId: string | null;
  modelId: string | null;
  priority: number;
  resolved: boolean;
  from: {
    type: string;
  };
}

export interface UserModelRoleListResponse {
  membershipId: string;
  results: UserModelRoleRecord[];
}

export interface UserModelRoleAssignmentProof {
  userId: string;
  roleName: UserModelRoleName;
  connectionId: string | null;
  modelId: string | null;
}

export interface UserModelRoleAssignmentResponse extends UserModelRoleListResponse {
  assignment: UserModelRoleAssignmentProof;
  role: UserModelRoleRecord;
  verified: true;
}

export interface UserModelRoleListOptions {
  modelId?: string;
  connectionId?: string;
  signal?: AbortSignal;
  requestSpacingMs?: number;
}

export interface AssignUserModelRoleInput {
  roleName: UserModelRoleName;
  modelId?: string;
  connectionId?: string;
}

const USER_MODEL_ROLE_NAME_SET = new Set<string>(USER_MODEL_ROLE_NAMES);
const OMNI_OPAQUE_ID_PATTERN = /^[\w-]+$/;
const USER_MODEL_ROLE_MAX_RESULTS = 1_000;

function isUserModelRoleName(value: unknown): value is UserModelRoleName {
  return typeof value === 'string' && USER_MODEL_ROLE_NAME_SET.has(value);
}

function isUserModelRoleUuid(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && OMNI_OPAQUE_ID_PATTERN.test(value);
}

function isUserModelRoleUuidOrNull(value: unknown): value is string | null {
  return value === null || isUserModelRoleUuid(value);
}

function isSafeUserModelRoleString(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.trim() !== value || value.length > 160) return false;
  if (value.includes('@') || value.includes('<') || value.includes('>') || [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  })) return false;
  return !/(?:https?:\/\/|\bbearer\s+|\b(?:api[_ -]?key|authorization|token|secret|password|signature)\b\s*[:=])/i.test(value);
}

function validateUserModelRoleReadScope(
  userId: string,
  input: { modelId?: string; connectionId?: string },
): { userId: string; modelId?: string; connectionId?: string } {
  if (!isUserModelRoleUuid(userId)) throw new Error('userId must be a valid identifier for model-role actions.');
  if (input.modelId !== undefined && !isUserModelRoleUuid(input.modelId)) {
    throw new Error('modelId must be a valid identifier when provided.');
  }
  if (input.connectionId !== undefined && !isUserModelRoleUuid(input.connectionId)) {
    throw new Error('connectionId must be a valid identifier when provided.');
  }
  return {
    userId,
    ...(input.modelId ? { modelId: input.modelId } : {}),
    ...(input.connectionId ? { connectionId: input.connectionId } : {}),
  };
}

function parseUserModelRoleRecord(
  value: unknown,
  scope: { modelId?: string; connectionId?: string },
): UserModelRoleRecord {
  if (
    !isRecord(value)
    || !isSafeUserModelRoleString(value.roleName)
    || !isSafeUserModelRoleString(value.baseRole)
    || !isUserModelRoleUuidOrNull(value.modelId)
    || !isUserModelRoleUuidOrNull(value.connectionId)
    || !Number.isSafeInteger(value.priority)
    || Number(value.priority) < 0
    || typeof value.resolved !== 'boolean'
    || !isRecord(value.from)
    || typeof value.from.type !== 'string'
    || !/^[A-Za-z][A-Za-z _-]{0,79}$/.test(value.from.type)
  ) {
    throw new Error('OmniKit returned an invalid user model-role response.');
  }
  if (scope.modelId && value.modelId !== scope.modelId) {
    throw new Error('OmniKit returned a user model role outside the requested model scope.');
  }
  if (scope.connectionId && value.connectionId !== scope.connectionId) {
    throw new Error('OmniKit returned a user model role outside the requested connection scope.');
  }
  return {
    roleName: value.roleName,
    baseRole: value.baseRole,
    connectionId: value.connectionId,
    modelId: value.modelId,
    priority: value.priority as number,
    resolved: value.resolved,
    from: { type: value.from.type },
  };
}

function parseUserModelRoleListResponse(
  value: unknown,
  scope: { userId: string; modelId?: string; connectionId?: string },
): UserModelRoleListResponse {
  if (!isRecord(value) || !Array.isArray(value.results) || value.results.length > USER_MODEL_ROLE_MAX_RESULTS) {
    throw new Error('OmniKit returned an invalid user model-role response.');
  }
  if (!isUserModelRoleUuid(value.membershipId)) {
    throw new Error('OmniKit returned an invalid user model-role response.');
  }
  const results = value.results.map((role) => parseUserModelRoleRecord(role, scope));
  return {
    membershipId: value.membershipId,
    results,
  };
}

function parseUserModelRoleAssignmentProof(
  value: unknown,
  scope: { userId: string; modelId?: string; connectionId?: string },
  roleName: UserModelRoleName,
): UserModelRoleAssignmentProof {
  if (
    !isRecord(value)
    || value.userId !== scope.userId
    || value.roleName !== roleName
    || !isUserModelRoleUuidOrNull(value.modelId)
    || !isUserModelRoleUuidOrNull(value.connectionId)
    || (scope.modelId !== undefined && value.modelId !== scope.modelId)
    || (scope.connectionId !== undefined && value.connectionId !== scope.connectionId)
  ) {
    throw new Error('OmniKit returned an invalid user model-role assignment proof.');
  }
  return {
    userId: value.userId,
    roleName,
    modelId: value.modelId,
    connectionId: value.connectionId,
  };
}

export async function listUserModelRoles(
  baseUrl: string,
  apiKey: string,
  userId: string,
  options: UserModelRoleListOptions = {},
): Promise<UserModelRoleListResponse> {
  const { signal, requestSpacingMs, ...requestedScope } = options;
  if (
    requestSpacingMs !== undefined
    && (!Number.isSafeInteger(requestSpacingMs) || requestSpacingMs < 100 || requestSpacingMs > 60_000)
  ) {
    throw new Error('requestSpacingMs must be an integer between 100 and 60000.');
  }
  const scope = validateUserModelRoleReadScope(userId, requestedScope);
  const res = await safeFetch(
    edgeFunctionUrl('manage-users'),
    {
      method: 'POST',
      headers: defaultHeaders,
      signal,
      body: JSON.stringify({
        base_url: baseUrl,
        api_key: apiKey,
        action: 'list_model_roles',
        user_id: scope.userId,
        model_id: scope.modelId,
        connection_id: scope.connectionId,
      }),
    },
    'List user model roles',
    { deduplicate: false, retry: false, requestSpacingMs },
  );
  const payload: unknown = await res.json();
  return parseUserModelRoleListResponse(payload, scope);
}

export async function assignUserModelRole(
  baseUrl: string,
  apiKey: string,
  userId: string,
  input: AssignUserModelRoleInput,
  options: { signal?: AbortSignal } = {},
): Promise<UserModelRoleAssignmentResponse> {
  const scope = validateUserModelRoleReadScope(userId, input);
  if (!isUserModelRoleName(input.roleName)) {
    throw new Error('roleName must be one of the supported built-in model roles.');
  }
  if (input.roleName === 'CONNECTION_ADMIN') {
    if (!scope.connectionId) throw new Error('connectionId is required for CONNECTION_ADMIN.');
    if (scope.modelId) throw new Error('modelId is not permitted for CONNECTION_ADMIN.');
  } else if (!scope.modelId) {
    throw new Error('modelId is required for non-admin model roles.');
  }

  const res = await safeFetch(
    edgeFunctionUrl('manage-users'),
    {
      method: 'POST',
      headers: defaultHeaders,
      signal: options.signal,
      body: JSON.stringify({
        base_url: baseUrl,
        api_key: apiKey,
        action: 'assign_model_role',
        user_id: scope.userId,
        role_name: input.roleName,
        model_id: scope.modelId,
        connection_id: scope.connectionId,
      }),
    },
    'Assign user model role',
    { deduplicate: false, retry: false },
  );
  const payload: unknown = await res.json();
  if (!isRecord(payload) || payload.verified !== true) {
    throw new Error('OmniKit could not verify the user model-role assignment.');
  }
  const list = parseUserModelRoleListResponse(payload, scope);
  const assignment = parseUserModelRoleAssignmentProof(payload.assignment, scope, input.roleName);
  const role = parseUserModelRoleRecord(payload.role, scope);
  if (
    role.roleName !== input.roleName
    || role.modelId !== assignment.modelId
    || role.connectionId !== assignment.connectionId
    || (role.from.type !== 'USER' && role.from.type !== 'User Role')
    || !list.results.some((candidate) => (
      candidate.roleName === role.roleName
      && candidate.modelId === assignment.modelId
      && candidate.connectionId === assignment.connectionId
      && (candidate.from.type === 'USER' || candidate.from.type === 'User Role')
    ))
  ) {
    throw new Error('OmniKit could not verify the user model-role assignment.');
  }
  return { ...list, assignment, role, verified: true };
}

export async function createUser(baseUrl: string, apiKey: string, body: Record<string, unknown>, options: { signal?: AbortSignal } = {}) {
  const res = await safeFetch(
    edgeFunctionUrl('manage-users'),
    { method: 'POST', headers: defaultHeaders, signal: options.signal, body: JSON.stringify({ base_url: baseUrl, api_key: apiKey, action: 'create', user_data: body }) },
    'Create user',
    { deduplicate: false, retry: false },
  );
  return res.json();
}

export async function updateUser(baseUrl: string, apiKey: string, userId: string, body: Record<string, unknown>, options: { signal?: AbortSignal } = {}) {
  const res = await safeFetch(
    edgeFunctionUrl('manage-users'),
    { method: 'POST', headers: defaultHeaders, signal: options.signal, body: JSON.stringify({ base_url: baseUrl, api_key: apiKey, action: 'update', user_id: userId, user_data: body }) },
    'Update user',
    { deduplicate: false, retry: false },
  );
  return res.json();
}

export async function deleteUser(baseUrl: string, apiKey: string, userId: string, options: { signal?: AbortSignal } = {}) {
  const res = await safeFetch(
    edgeFunctionUrl('manage-users'),
    { method: 'POST', headers: defaultHeaders, signal: options.signal, body: JSON.stringify({ base_url: baseUrl, api_key: apiKey, action: 'delete', user_id: userId }) },
    'Delete user',
    { deduplicate: false, retry: false },
  );
  return res.json();
}

export async function listGroups(
  baseUrl: string,
  apiKey: string,
  count = 100,
  startIndex = 1,
  options: { signal?: AbortSignal } = {},
): Promise<ScimListResponse> {
  if (!isPositiveInteger(count) || !isPositiveInteger(startIndex)) {
    throw new Error('Invalid SCIM pagination configuration.');
  }
  const res = await safeFetch(
    edgeFunctionUrl('manage-groups'),
    { method: 'POST', headers: defaultHeaders, signal: options.signal, body: JSON.stringify({ base_url: baseUrl, api_key: apiKey, action: 'list', count, start_index: startIndex }) },
    'List groups',
    options.signal ? { deduplicate: false, retry: false } : undefined,
  );
  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    throw invalidScimListResponse('group', 'BODY_INVALID_JSON');
  }
  return parseScimListResponse(payload, 'group', count, startIndex);
}

export async function listAllGroups(
  baseUrl: string,
  apiKey: string,
  options?: { pageSize?: number; maxPages?: number; signal?: AbortSignal }
): Promise<ScimListResponse> {
  const { pageSize, maxPages } = scimPaginationOptions(options);
  const resources: Array<Record<string, unknown>> = [];
  let startIndex = 1;
  let totalResults: number | null = null;
  let lastResponse: ScimListResponse = {};
  const resourceIds = new Set<string>();

  for (let page = 0; page < maxPages; page += 1) {
    let response: ScimListResponse;
    try {
      response = await listGroups(baseUrl, apiKey, pageSize, startIndex, { signal: options?.signal });
    } catch (error) {
      if (resources.length === 0) throw error;
      const validationReasonCode = scimListValidationCode(error);
      return {
        ...lastResponse,
        Resources: resources,
        totalResults: totalResults ?? resources.length,
        itemsPerPage: resources.length,
        startIndex: 1,
        loadedResults: resources.length,
        truncated: true,
        error: 'partial_collection_read_failed',
        // Always overwrite any same-named upstream field. Only locally
        // generated, fixed-enum diagnostic codes may survive this boundary.
        validationReasonCode,
      };
    }
    lastResponse = response;

    if (response.error) {
      return {
        ...response,
        Resources: resources,
        loadedResults: resources.length,
        truncated: resources.length > 0,
      };
    }

    const pageResources = response.Resources as Array<Record<string, unknown>>;
    const responseTotal = response.totalResults as number;
    const responseStartIndex = response.startIndex as number;
    const responseItemsPerPage = response.itemsPerPage as number;

    if (totalResults === null) totalResults = responseTotal;
    if (responseTotal !== totalResults) throw invalidScimListResponse('group', 'SNAPSHOT_TOTAL_CHANGED');
    for (const resource of pageResources) {
      const resourceId = resource.id as string;
      if (resourceIds.has(resourceId)) throw invalidScimListResponse('group', 'DUPLICATE_RESOURCE');
      resourceIds.add(resourceId);
    }
    resources.push(...pageResources);

    if (resources.length === totalResults) break;
    const nextStartIndex = responseStartIndex + responseItemsPerPage;
    if (nextStartIndex <= startIndex) throw invalidScimListResponse('group', 'PAGINATION_NO_PROGRESS');
    startIndex = nextStartIndex;
  }

  const exactTotalResults = totalResults ?? 0;
  return {
    ...lastResponse,
    Resources: resources,
    totalResults: exactTotalResults,
    itemsPerPage: resources.length,
    startIndex: 1,
    loadedResults: resources.length,
    truncated: resources.length < exactTotalResults,
  };
}

export async function createGroup(baseUrl: string, apiKey: string, body: Record<string, unknown>, options: { signal?: AbortSignal } = {}) {
  const res = await safeFetch(
    edgeFunctionUrl('manage-groups'),
    { method: 'POST', headers: defaultHeaders, signal: options.signal, body: JSON.stringify({ base_url: baseUrl, api_key: apiKey, action: 'create', group_data: body }) },
    'Create group',
    { deduplicate: false, retry: false },
  );
  return res.json();
}

export async function getGroup(baseUrl: string, apiKey: string, groupId: string, options: { signal?: AbortSignal } = {}) {
  const res = await safeFetch(
    edgeFunctionUrl('manage-groups'),
    { method: 'POST', headers: defaultHeaders, signal: options.signal, body: JSON.stringify({ base_url: baseUrl, api_key: apiKey, action: 'get', group_id: groupId }) },
    'Get group',
    options.signal ? { deduplicate: false, retry: false } : undefined,
  );
  let payload: unknown;
  try {
    payload = await res.json();
  } catch {
    throw invalidScimListResponse('group', 'BODY_INVALID_JSON');
  }
  const resourceReason = scimCollectionResourceInvalidReason(payload, 'group');
  if (resourceReason) throw invalidScimListResponse('group', resourceReason);
  const group = payload as ScimCollectionResource;
  if (group.id !== groupId) throw invalidScimListResponse('group', 'RESOURCE_IDENTITY_MISMATCH');
  return group;
}

export async function updateGroup(baseUrl: string, apiKey: string, groupId: string, body: Record<string, unknown>) {
  const res = await safeFetch(
    edgeFunctionUrl('manage-groups'),
    { method: 'POST', headers: defaultHeaders, body: JSON.stringify({ base_url: baseUrl, api_key: apiKey, action: 'update', group_id: groupId, group_data: body }) },
    'Update group'
  );
  return res.json();
}

export async function patchGroup(baseUrl: string, apiKey: string, groupId: string, body: Record<string, unknown>, options: { signal?: AbortSignal } = {}) {
  const res = await safeFetch(
    edgeFunctionUrl('manage-groups'),
    { method: 'POST', headers: defaultHeaders, signal: options.signal, body: JSON.stringify({ base_url: baseUrl, api_key: apiKey, action: 'patch', group_id: groupId, group_data: body }) },
    'Update group membership',
    { deduplicate: false, retry: false },
  );
  return res.json();
}

export async function createModel(
  baseUrl: string,
  apiKey: string,
  connectionId: string,
  modelName: string,
  modelKind = 'SHARED',
  baseModelId?: string
) {
  const res = await safeFetch(
    edgeFunctionUrl('manage-models'),
    { method: 'POST', headers: defaultHeaders, body: JSON.stringify({ base_url: baseUrl, api_key: apiKey, action: 'create', connection_id: connectionId, model_name: modelName, model_kind: modelKind, base_model_id: baseModelId }) },
    'Create model'
  );
  return res.json();
}

export async function listTopics(
  baseUrl: string,
  apiKey: string,
  modelId: string,
  options: { signal?: AbortSignal; forceRefresh?: boolean } = {},
): Promise<TopicInventoryRecord[]> {
  const cacheKey = `${cacheScope(baseUrl, apiKey)}|topics|${modelId}`;
  if (options.forceRefresh) clearMetadataCache(cacheKey);
  return withMetadataCache(cacheKey, async ({ deduplicationScope }) => {
    const res = await safeFetch(
      edgeFunctionUrl('manage-topics'),
      {
        method: 'POST',
        headers: defaultHeaders,
        signal: options.signal,
        body: JSON.stringify({ base_url: baseUrl, api_key: apiKey, action: 'list', model_id: modelId }),
      },
      'List topics',
      options.signal ? { deduplicate: false } : { deduplicationScope },
    );
    const data: unknown = await res.json();
    return parseTopicInventoryResponse(data);
  });
}

export async function getTopic(baseUrl: string, apiKey: string, modelId: string, topicName: string) {
  const cacheKey = `${cacheScope(baseUrl, apiKey)}|topic|${modelId}|${topicName}`;
  return withMetadataCache(cacheKey, async ({ deduplicationScope }) => {
    const res = await safeFetch(
      edgeFunctionUrl('manage-topics'),
      { method: 'POST', headers: defaultHeaders, body: JSON.stringify({ base_url: baseUrl, api_key: apiKey, action: 'get', model_id: modelId, topic_name: topicName }) },
      'Get topic',
      { deduplicationScope },
    );
    return res.json();
  });
}

export interface InspectExportResult {
  documentId: string;
  diagnostics: {
    topLevelKeys: string[];
    payloadSizeBytes: number;
    modelIdLocations: Array<{ path: string; key: string; value: string }>;
    modelIdCount: number;
    hasTopLevelModelId: boolean;
    envelopePattern: { pattern: string; innerKeys: string[] } | null;
    nullOrUndefinedFields: string[];
  };
  rawPayload: unknown;
  error?: string;
}

export async function inspectExport(
  baseUrl: string,
  apiKey: string,
  documentId: string
): Promise<InspectExportResult> {
  const res = await safeFetch(
    edgeFunctionUrl('inspect-export'),
    {
      method: 'POST',
      headers: defaultHeaders,
      body: JSON.stringify({ base_url: baseUrl, api_key: apiKey, document_id: documentId }),
    },
    'Inspect export'
  );
  return res.json();
}

async function omniProxyRequest<T = unknown>(
  baseUrl: string,
  apiKey: string,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  endpoint: string,
  options: { body?: unknown; queryParams?: Record<string, string>; rawResponse?: boolean } | undefined,
  requestPolicy: SafeFetchPolicy,
): Promise<T> {
  const res = await safeFetch(
    edgeFunctionUrl('omni-proxy'),
    {
      method: 'POST',
      headers: defaultHeaders,
      body: JSON.stringify({
        base_url: baseUrl,
        api_key: apiKey,
        method,
        endpoint,
        body: options?.body,
        query_params: options?.queryParams,
        raw_response: options?.rawResponse,
      }),
    },
    `${method} ${endpoint}`,
    requestPolicy,
  );
  if (res.status === 204) return undefined as T;
  return res.json();
}

export async function omniProxy<T = unknown>(
  baseUrl: string,
  apiKey: string,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  endpoint: string,
  options?: { body?: unknown; queryParams?: Record<string, string>; rawResponse?: boolean }
): Promise<T> {
  return omniProxyRequest(baseUrl, apiKey, method, endpoint, options, {});
}

export async function omniProxyDownload(
  baseUrl: string,
  apiKey: string,
  endpoint: string,
): Promise<Blob> {
  const res = await safeFetch(
    edgeFunctionUrl('omni-proxy'),
    {
      method: 'POST',
      headers: defaultHeaders,
      body: JSON.stringify({
        base_url: baseUrl,
        api_key: apiKey,
        method: 'GET',
        endpoint,
        raw_response: true,
      }),
    },
    `GET ${endpoint}`
  );
  return res.blob();
}

export interface DeckFilterDefaultsRow {
  defaults: Record<string, unknown>;
  dashboard_name: string;
  synced_at: string;
}

import { deckFilterDefaultsCache } from './deckBuilder/localCache';

export async function fetchDeckFilterDefaults(
  omniBaseUrl: string,
  dashboardId: string,
): Promise<DeckFilterDefaultsRow | null> {
  return deckFilterDefaultsCache.load(omniBaseUrl, dashboardId);
}

export async function upsertDeckFilterDefaults(
  omniBaseUrl: string,
  dashboardId: string,
  dashboardName: string,
  defaults: Record<string, unknown>,
): Promise<void> {
  deckFilterDefaultsCache.save(omniBaseUrl, dashboardId, dashboardName, defaults);
}

export async function generateEmbedUrl(baseUrl: string, embedSecret: string, body: Record<string, unknown>) {
  const res = await safeFetch(
    edgeFunctionUrl('generate-embed-url'),
    { method: 'POST', headers: defaultHeaders, body: JSON.stringify({ base_url: baseUrl, embed_secret: embedSecret, embed_data: body }) },
    'Generate embed URL',
    { deduplicate: false },
  );
  return res.json();
}
