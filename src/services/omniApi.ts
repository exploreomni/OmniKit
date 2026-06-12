import { emitVaultLocked } from '@/services/vaultEvents';

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
const requestQueue: Array<() => void> = [];
const inFlightRequests = new Map<string, Promise<Response>>();
const metadataCache = new Map<string, { expiresAt: number; value: unknown }>();

export class ApiError extends Error {
  status: number;
  detail?: string;

  constructor(status: number, message: string, detail?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.detail = detail;
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function releaseRequestSlot() {
  activeRequestCount = Math.max(0, activeRequestCount - 1);
  const next = requestQueue.shift();
  if (next) next();
}

async function runQueued<T>(task: () => Promise<T>): Promise<T> {
  if (activeRequestCount >= MAX_CONCURRENT_REQUESTS) {
    await new Promise<void>((resolve) => requestQueue.push(resolve));
  }
  activeRequestCount += 1;
  try {
    const now = Date.now();
    const waitMs = Math.max(0, nextRequestAt - now);
    nextRequestAt = Math.max(now, nextRequestAt) + REQUEST_SPACING_MS;
    if (waitMs > 0) await sleep(waitMs);
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
    await sleep(retryDelayMs(res, attempt));
  }

  return lastResponse || fetch(url, options);
}

function clearMetadataCache(prefix: string) {
  Array.from(metadataCache.keys()).forEach((key) => {
    if (key.startsWith(prefix)) metadataCache.delete(key);
  });
}

function cacheScope(baseUrl: string, apiKey: string) {
  return `${baseUrl.replace(/\/+$/, '').toLowerCase()}|key-${hashForKey(apiKey)}`;
}

async function withMetadataCache<T>(key: string, loader: () => Promise<T>, ttlMs = METADATA_CACHE_TTL_MS): Promise<T> {
  const now = Date.now();
  const cached = metadataCache.get(key);
  if (cached && cached.expiresAt > now) return cached.value as T;
  const value = await loader();
  metadataCache.set(key, { value, expiresAt: now + ttlMs });
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
  try {
    const body = await res.json();
    serverMessage = body.error || body.message || '';
    detail = body.detail || (typeof body === 'string' ? body : JSON.stringify(body));
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

  throw new ApiError(res.status, friendlyMessage, redactSensitiveText(detail) || undefined);
}

async function safeFetch(url: string, options: RequestInit, context: string): Promise<Response> {
  try {
    const key = requestKey(url, options);
    let promise = inFlightRequests.get(key);
    if (!promise) {
      promise = runQueued(() => fetchWithRetry(url, options, context))
        .finally(() => inFlightRequests.delete(key));
      inFlightRequests.set(key, promise);
    }
    const res = (await promise).clone();
    return await handleResponse(res, context);
  } catch (err) {
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
  return withMetadataCache(cacheKey, async () => {
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
      'List folders'
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
  return withMetadataCache(cacheKey, async () => {
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
      'List documents'
    );
    return res.json();
  });
}

export async function listModels(
  baseUrl: string,
  apiKey: string,
  options?: {
    connectionId?: string;
    modelKind?: string;
    includeDeleted?: boolean;
    include?: string;
    sortField?: string;
    sortDirection?: 'asc' | 'desc';
    allPages?: boolean;
    pageSize?: number;
    cursor?: string;
  }
) {
  const cacheKey = `${cacheScope(baseUrl, apiKey)}|models|${JSON.stringify(options || {})}`;
  return withMetadataCache(cacheKey, async () => {
    const res = await safeFetch(
      edgeFunctionUrl('list-models'),
      {
        method: 'POST',
        headers: defaultHeaders,
        body: JSON.stringify({
          base_url: baseUrl,
          api_key: apiKey,
          model_kind: options?.modelKind,
          connection_id: options?.connectionId,
          include_deleted: options?.includeDeleted,
          include: options?.include,
          sort_field: options?.sortField,
          sort_direction: options?.sortDirection,
          all_pages: options?.allPages,
          page_size: options?.pageSize,
          cursor: options?.cursor,
        }),
      },
      'List models'
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
  }
) {
  const queryParams: Record<string, string> = {};
  if (options?.branchId) queryParams.branchId = options.branchId;
  if (options?.fileName) queryParams.fileName = options.fileName;
  if (options?.mode) queryParams.mode = options.mode;
  if (options?.includeChecksums !== undefined) queryParams.includeChecksums = String(options.includeChecksums);
  if (options?.fullyResolved !== undefined) queryParams.fullyResolved = String(options.fullyResolved);

  const cacheKey = `${cacheScope(baseUrl, apiKey)}|model-yaml|${modelId}|${JSON.stringify(queryParams)}`;
  return withMetadataCache(cacheKey, () => omniProxy<OmniModelYamlResponse>(
      baseUrl,
      apiKey,
      'GET',
      `/v1/models/${modelId}/yaml`,
      { queryParams: Object.keys(queryParams).length ? queryParams : undefined }
    ),
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

export async function validateModelContent(baseUrl: string, apiKey: string, modelId: string, branchId?: string) {
  return omniProxy<Record<string, unknown>>(
    baseUrl,
    apiKey,
    'GET',
    `/v1/models/${modelId}/content-validator`,
    { queryParams: branchId ? { branch_id: branchId } : undefined }
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
  }
): Promise<OmniAiJob> {
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
      }),
    },
    'Create AI job'
  );
  return res.json();
}

export async function getAiJob(baseUrl: string, apiKey: string, jobId: string): Promise<OmniAiJob> {
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
      }),
    },
    'Get AI job'
  );
  return res.json();
}

export async function getAiJobResult(baseUrl: string, apiKey: string, jobId: string): Promise<OmniAiJobResult> {
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
    },
    'Get AI job result'
  );
  return res.json();
}

export async function cancelAiJob(baseUrl: string, apiKey: string, jobId: string): Promise<OmniAiJob> {
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
      }),
    },
    'Cancel AI job'
  );
  return res.json();
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

interface MigrateParams {
  source: { base_url: string; api_key: string };
  target: { base_url: string; api_key: string };
  dashboards: { id: string; name: string; base_model_id?: string }[];
  model_mapping: Record<string, string>;
  target_folder?: string;
  dry_run: boolean;
  in_place?: boolean;
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

export async function migrate(
  params: MigrateParams,
  onEvent: (event: Record<string, unknown>) => void
): Promise<void> {
  const res = await safeFetch(
    edgeFunctionUrl('migrate'),
    { method: 'POST', headers: defaultHeaders, body: JSON.stringify(params) },
    'Migration'
  );
  await consumeSseStream(res, onEvent);
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

export async function listUsers(baseUrl: string, apiKey: string, count = 100, startIndex = 1) {
  const res = await safeFetch(
    edgeFunctionUrl('manage-users'),
    { method: 'POST', headers: defaultHeaders, body: JSON.stringify({ base_url: baseUrl, api_key: apiKey, action: 'list', count, start_index: startIndex }) },
    'List users'
  );
  return res.json();
}

type ScimListResponse = {
  Resources?: Array<Record<string, unknown>>;
  totalResults?: number;
  itemsPerPage?: number;
  startIndex?: number;
  error?: unknown;
  loadedResults?: number;
  truncated?: boolean;
  [key: string]: unknown;
};

export async function listAllUsers(
  baseUrl: string,
  apiKey: string,
  options?: { pageSize?: number; maxPages?: number }
): Promise<ScimListResponse> {
  const pageSize = options?.pageSize || 100;
  const maxPages = options?.maxPages || 200;
  const resources: Array<Record<string, unknown>> = [];
  let startIndex = 1;
  let totalResults = 0;
  let lastResponse: ScimListResponse = {};

  for (let page = 0; page < maxPages; page += 1) {
    const response = (await listUsers(baseUrl, apiKey, pageSize, startIndex)) as ScimListResponse;
    lastResponse = response;

    if (response.error) {
      return {
        ...response,
        Resources: resources,
        loadedResults: resources.length,
        truncated: resources.length > 0,
      };
    }

    const pageResources = Array.isArray(response.Resources) ? response.Resources : [];
    resources.push(...pageResources);
    totalResults = Number(response.totalResults) || resources.length;

    if (pageResources.length === 0 || resources.length >= totalResults) break;
    startIndex += pageResources.length;
  }

  return {
    ...lastResponse,
    Resources: resources,
    totalResults: totalResults || resources.length,
    itemsPerPage: resources.length,
    startIndex: 1,
    loadedResults: resources.length,
    truncated: Boolean(totalResults && resources.length < totalResults),
  };
}

export async function findUserByEmail(baseUrl: string, apiKey: string, email: string) {
  const res = await safeFetch(
    edgeFunctionUrl('manage-users'),
    { method: 'POST', headers: defaultHeaders, body: JSON.stringify({ base_url: baseUrl, api_key: apiKey, action: 'find', email }) },
    'Find user'
  );
  return res.json();
}

export async function createUser(baseUrl: string, apiKey: string, body: Record<string, unknown>) {
  const res = await safeFetch(
    edgeFunctionUrl('manage-users'),
    { method: 'POST', headers: defaultHeaders, body: JSON.stringify({ base_url: baseUrl, api_key: apiKey, action: 'create', user_data: body }) },
    'Create user'
  );
  return res.json();
}

export async function updateUser(baseUrl: string, apiKey: string, userId: string, body: Record<string, unknown>) {
  const res = await safeFetch(
    edgeFunctionUrl('manage-users'),
    { method: 'POST', headers: defaultHeaders, body: JSON.stringify({ base_url: baseUrl, api_key: apiKey, action: 'update', user_id: userId, user_data: body }) },
    'Update user'
  );
  return res.json();
}

export async function deleteUser(baseUrl: string, apiKey: string, userId: string) {
  const res = await safeFetch(
    edgeFunctionUrl('manage-users'),
    { method: 'POST', headers: defaultHeaders, body: JSON.stringify({ base_url: baseUrl, api_key: apiKey, action: 'delete', user_id: userId }) },
    'Delete user'
  );
  return res.json();
}

export async function listGroups(baseUrl: string, apiKey: string, count = 100, startIndex = 1) {
  const res = await safeFetch(
    edgeFunctionUrl('manage-groups'),
    { method: 'POST', headers: defaultHeaders, body: JSON.stringify({ base_url: baseUrl, api_key: apiKey, action: 'list', count, start_index: startIndex }) },
    'List groups'
  );
  return res.json();
}

export async function getGroup(baseUrl: string, apiKey: string, groupId: string) {
  const res = await safeFetch(
    edgeFunctionUrl('manage-groups'),
    { method: 'POST', headers: defaultHeaders, body: JSON.stringify({ base_url: baseUrl, api_key: apiKey, action: 'get', group_id: groupId }) },
    'Get group'
  );
  return res.json();
}

export async function updateGroup(baseUrl: string, apiKey: string, groupId: string, body: Record<string, unknown>) {
  const res = await safeFetch(
    edgeFunctionUrl('manage-groups'),
    { method: 'POST', headers: defaultHeaders, body: JSON.stringify({ base_url: baseUrl, api_key: apiKey, action: 'update', group_id: groupId, group_data: body }) },
    'Update group'
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

export async function listTopics(baseUrl: string, apiKey: string, modelId: string): Promise<Array<{ name: string; label?: string; description?: string }>> {
  const cacheKey = `${cacheScope(baseUrl, apiKey)}|topics|${modelId}`;
  return withMetadataCache(cacheKey, async () => {
    const res = await safeFetch(
      edgeFunctionUrl('manage-topics'),
      { method: 'POST', headers: defaultHeaders, body: JSON.stringify({ base_url: baseUrl, api_key: apiKey, action: 'list', model_id: modelId }) },
      'List topics'
    );
    const data = await res.json();
    return Array.isArray(data.topics) ? data.topics : [];
  });
}

export async function getTopic(baseUrl: string, apiKey: string, modelId: string, topicName: string) {
  const cacheKey = `${cacheScope(baseUrl, apiKey)}|topic|${modelId}|${topicName}`;
  return withMetadataCache(cacheKey, async () => {
    const res = await safeFetch(
      edgeFunctionUrl('manage-topics'),
      { method: 'POST', headers: defaultHeaders, body: JSON.stringify({ base_url: baseUrl, api_key: apiKey, action: 'get', model_id: modelId, topic_name: topicName }) },
      'Get topic'
    );
    return res.json();
  });
}

export async function createTopic(
  baseUrl: string,
  apiKey: string,
  modelId: string,
  baseViewName: string,
  body: Record<string, unknown>
) {
  const res = await safeFetch(
    edgeFunctionUrl('manage-topics'),
    { method: 'POST', headers: defaultHeaders, body: JSON.stringify({ base_url: baseUrl, api_key: apiKey, action: 'create', model_id: modelId, base_view_name: baseViewName, topic_data: body }) },
    'Create topic'
  );
  const data = await res.json();
  clearMetadataCache(`${cacheScope(baseUrl, apiKey)}|topics|${modelId}`);
  return data;
}

export async function updateTopic(
  baseUrl: string,
  apiKey: string,
  modelId: string,
  topicName: string,
  body: Record<string, unknown>
) {
  const res = await safeFetch(
    edgeFunctionUrl('manage-topics'),
    { method: 'POST', headers: defaultHeaders, body: JSON.stringify({ base_url: baseUrl, api_key: apiKey, action: 'update', model_id: modelId, topic_name: topicName, topic_data: body }) },
    'Update topic'
  );
  const data = await res.json();
  const scope = cacheScope(baseUrl, apiKey);
  clearMetadataCache(`${scope}|topics|${modelId}`);
  clearMetadataCache(`${scope}|topic|${modelId}|${topicName}`);
  return data;
}

export async function deleteTopic(baseUrl: string, apiKey: string, modelId: string, topicName: string) {
  const res = await safeFetch(
    edgeFunctionUrl('manage-topics'),
    { method: 'POST', headers: defaultHeaders, body: JSON.stringify({ base_url: baseUrl, api_key: apiKey, action: 'delete', model_id: modelId, topic_name: topicName }) },
    'Delete topic'
  );
  const data = await res.json();
  const scope = cacheScope(baseUrl, apiKey);
  clearMetadataCache(`${scope}|topics|${modelId}`);
  clearMetadataCache(`${scope}|topic|${modelId}|${topicName}`);
  return data;
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

export async function omniProxy<T = unknown>(
  baseUrl: string,
  apiKey: string,
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
  endpoint: string,
  options?: { body?: unknown; queryParams?: Record<string, string>; rawResponse?: boolean }
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
    `${method} ${endpoint}`
  );
  if (res.status === 204) return undefined as T;
  return res.json();
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

export async function generateEmbedUrl(baseUrl: string, apiKey: string, body: Record<string, unknown>) {
  const res = await safeFetch(
    edgeFunctionUrl('generate-embed-url'),
    { method: 'POST', headers: defaultHeaders, body: JSON.stringify({ base_url: baseUrl, api_key: apiKey, embed_data: body }) },
    'Generate embed URL'
  );
  return res.json();
}
