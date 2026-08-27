import { createHash } from 'node:crypto';
import { lookup as dnsLookup } from 'node:dns';
import type { LookupAddress, LookupOptions } from 'node:dns';
import { request as httpsRequest } from 'node:https';
import type { IncomingMessage } from 'node:http';
import type { LookupFunction } from 'node:net';
import { isIP } from 'node:net';
import {
  assertSafeOutboundUrl,
  isPrivateOrLocalAddress,
  jsonHeaders,
  validateBaseUrl,
} from '../security';
import {
  deleteInstance,
  getInstance,
  isVaultUnlocked,
  listInstances,
  markInstanceValidated,
  upsertInstance,
  type InstanceMetricFilter,
  type InstanceRole,
  type PostMigrationAction,
  type SavedInstance,
} from '../services/nativeVault';
import {
  OmniClient,
  OmniClientError,
  OmniDocumentInventoryDeadlineError,
  OmniPaginationError,
  OmniRequestDeadlineError,
  OmniResponseLimitError,
  OmniResponseReadDeadlineError,
  type OmniDocumentInventoryPagination,
  type OmniDocumentRecord,
  type OmniModelRecord,
} from '../services/omniClient';
import { importLegacyVault } from '../services/legacyVaultImport';
import { validatePostMigrationActionTarget } from '../services/postMigrationActions';
import { redactSensitiveText } from '../services/jobSanitizer';
import { createPerformanceTracker } from '../services/performanceTimings';
import {
  clearReadThroughCache,
  readThroughCache,
  readThroughCacheResult,
} from '../services/readThroughCache';
import {
  INSTANCE_CONNECTION_DIAGNOSTICS,
  INSTANCE_CONNECTION_ERROR_CODES,
  type InstanceConnectionErrorCode,
} from '../../shared/instanceConnectionErrors';

const VAULT_API_KEY_REFERENCE_PREFIX = '__omnikit_vault_instance__:';
const INTERACTIVE_TEST_TIMEOUT_MS = 8_000;
const CONNECT_VALIDATION_REUSE_MS = 15 * 60 * 1_000;
const INSTANCE_PROBE_MAX_RESPONSE_BYTES = 256 * 1024;
const DOCUMENT_INVENTORY_REQUEST_TIMEOUT_MS = 15_000;
const DOCUMENT_INVENTORY_MAX_READ_RETRIES = 1;
const DOCUMENT_INVENTORY_TRANSPORT_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const DOCUMENT_METADATA_TRANSPORT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const MAX_DOCUMENT_METADATA_IDS = 50;
const MAX_DOCUMENT_IDENTIFIER_LENGTH = 256;

export interface InstanceHandlerDependencies {
  probeFetch?: typeof fetch;
  validateProbeOutbound?: (url: string) => Promise<void>;
  probeLookup?: typeof dnsLookup;
  pinnedRequest?: typeof httpsRequest;
}

export class InstanceValidationDeadlineError extends Error {
  readonly code = 'INSTANCE_VALIDATION_TIMEOUT';

  constructor(timeoutMs: number) {
    super(`Instance validation exceeded its ${timeoutMs}ms deadline.`);
    this.name = 'InstanceValidationDeadlineError';
  }
}

export class InstanceValidationCancelledError extends Error {
  readonly code = 'INSTANCE_VALIDATION_CANCELLED';

  constructor() {
    super('Instance validation was cancelled.');
    this.name = 'InstanceValidationCancelledError';
  }
}

class InstanceProbeResponseError extends Error {
  constructor() {
    super('The Omni identity probe returned an invalid success response.');
    this.name = 'InstanceProbeResponseError';
  }
}

class InstanceUrlValidationError extends Error {
  constructor() {
    super('The saved Omni instance URL is invalid or no longer permitted.');
    this.name = 'InstanceUrlValidationError';
  }
}

interface CachedDashboardInventory {
  dashboards: OmniDocumentRecord[];
  dashboardsByConnection: Record<string, OmniDocumentRecord[]>;
  pagination: OmniDocumentInventoryPagination;
  sourceRecordCount: number;
  missingConnectionId: number;
  missingDashboardEvidence: number;
}

function documentInventoryCredentialScope(
  instance: Pick<SavedInstance, 'baseUrl' | 'apiKey'>,
): string {
  return createHash('sha256')
    .update(instance.baseUrl.replace(/\/+$/, '').toLowerCase())
    .update('\0')
    .update(instance.apiKey)
    .digest('hex');
}

function documentInventoryCacheKey(
  instanceId: string,
  instance: Pick<SavedInstance, 'baseUrl' | 'apiKey'>,
  folderId?: string,
): string {
  const scope = documentInventoryCredentialScope(instance);
  return `instance:${instanceId}:documents:inventory:v2:${scope}:${JSON.stringify({
    includeLabels: true,
    folderId: folderId || null,
  })}`;
}

function buildCachedDashboardInventory(input: {
  documents: OmniDocumentRecord[];
  pagination: OmniDocumentInventoryPagination;
}): CachedDashboardInventory {
  const dashboards: OmniDocumentRecord[] = [];
  const groups = new Map<string, OmniDocumentRecord[]>();
  let missingConnectionId = 0;
  let missingDashboardEvidence = 0;

  for (const document of input.documents) {
    // List Documents supplies an explicit hasDashboard field. Fail closed when
    // it is absent or false rather than inferring write-capable migration scope
    // from a document name or a speculative type string.
    if (document.hasDashboard !== true) {
      missingDashboardEvidence += 1;
      continue;
    }
    dashboards.push(document);
    if (!document.connectionId) {
      missingConnectionId += 1;
      continue;
    }
    const group = groups.get(document.connectionId) ?? [];
    group.push(document);
    groups.set(document.connectionId, group);
  }

  return {
    dashboards,
    dashboardsByConnection: Object.fromEntries(groups),
    pagination: input.pagination,
    sourceRecordCount: input.documents.length,
    missingConnectionId,
    missingDashboardEvidence,
  };
}

function dashboardsForConnection(
  inventory: CachedDashboardInventory,
  connectionId?: string,
): OmniDocumentRecord[] {
  if (!connectionId) return inventory.dashboards;
  return Object.prototype.hasOwnProperty.call(inventory.dashboardsByConnection, connectionId)
    ? inventory.dashboardsByConnection[connectionId]
    : [];
}

function publicOnlyProbeLookup(resolver: typeof dnsLookup = dnsLookup): LookupFunction {
  return (hostname, options, callback) => {
    const requestedAll = options.all === true;
    const lookupOptions: LookupOptions = { ...options, all: true, verbatim: true };
    resolver(hostname, lookupOptions, (error, records) => {
      if (error) {
        callback(error, '', 0);
        return;
      }
      const addresses = records as LookupAddress[];
      if (addresses.length === 0) {
        callback(Object.assign(new Error('The Omni instance host could not be resolved.'), {
          code: 'ENOTFOUND',
        }), '', 0);
        return;
      }
      if (addresses.some((record) => isPrivateOrLocalAddress(record.address))) {
        callback(Object.assign(new Error('The Omni instance host resolved to a local or private address.'), {
          code: 'EACCES',
        }), '', 0);
        return;
      }
      if (requestedAll) callback(null, addresses);
      else callback(null, addresses[0].address, addresses[0].family);
    });
  };
}

function declaredProbeBytes(value: string | string[] | null | undefined): number | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string' || !/^\d+$/.test(raw.trim())) return null;
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

async function readBoundedProbeStream(
  stream: AsyncIterable<unknown>,
  declaredBytes: number | null,
  destroy: () => void,
  maxResponseBytes = INSTANCE_PROBE_MAX_RESPONSE_BYTES,
): Promise<Uint8Array> {
  if (declaredBytes !== null && declaredBytes > maxResponseBytes) {
    destroy();
    throw new InstanceProbeResponseError();
  }
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  for await (const value of stream) {
    const chunk = typeof value === 'string' ? Buffer.from(value) : new Uint8Array(value as ArrayBufferLike);
    bytesRead += chunk.byteLength;
    if (bytesRead > maxResponseBytes) {
      destroy();
      throw new InstanceProbeResponseError();
    }
    chunks.push(chunk);
  }
  const body = new Uint8Array(bytesRead);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function readBoundedFetchProbe(response: Response): Promise<Uint8Array> {
  if (!response.body) throw new InstanceProbeResponseError();
  const declared = declaredProbeBytes(response.headers.get('content-length'));
  if (declared !== null && declared > INSTANCE_PROBE_MAX_RESPONSE_BYTES) {
    await response.body.cancel().catch(() => undefined);
    throw new InstanceProbeResponseError();
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytesRead = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > INSTANCE_PROBE_MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new InstanceProbeResponseError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(bytesRead);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

async function readBoundedNodeProbe(response: IncomingMessage): Promise<Uint8Array> {
  return readBoundedProbeStream(
    response,
    declaredProbeBytes(response.headers['content-length']),
    () => response.destroy(),
  );
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function validateIdentityProbeEnvelope(bytes: Uint8Array): void {
  let value: unknown;
  try {
    const text = new TextDecoder().decode(bytes);
    if (!text.trim()) throw new InstanceProbeResponseError();
    value = JSON.parse(text);
  } catch (error) {
    if (error instanceof InstanceProbeResponseError) throw error;
    throw new InstanceProbeResponseError();
  }
  if (
    !isRecord(value)
    || Object.prototype.hasOwnProperty.call(value, 'error')
    || Object.prototype.hasOwnProperty.call(value, 'errors')
    || value.ok === false
    || value.success === false
    || (value.keyScope !== 'user' && value.keyScope !== 'organization')
    || (value.orgRole !== 'MEMBER' && value.orgRole !== 'ORG_ADMIN')
    || !isRecord(value.rolesByModel)
    || !isRecord(value.user)
    || !isNonBlankString(value.user.id)
    || !isNonBlankString(value.user.membershipId)
    || (value.rolesByModelTruncated !== undefined && typeof value.rolesByModelTruncated !== 'boolean')
  ) {
    throw new InstanceProbeResponseError();
  }
}

async function pinnedIdentityProbe(
  url: string,
  apiKey: string,
  signal: AbortSignal,
  dependencies: InstanceHandlerDependencies,
): Promise<void> {
  const parsed = new URL(url);
  await new Promise<void>((resolve, reject) => {
    // testInstance validates the HTTPS base URL before reaching this point.
    // The custom lookup below validates the exact address used by the socket;
    // a separate DNS preflight would add latency and reintroduce a rebinding gap.
    const outbound = (dependencies.pinnedRequest || httpsRequest)(parsed, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: 'application/json',
        'Accept-Encoding': 'identity',
      },
      agent: false,
      lookup: publicOnlyProbeLookup(dependencies.probeLookup),
      ...(isIP(parsed.hostname) ? {} : { servername: parsed.hostname }),
      signal,
    }, (response) => {
      const status = response.statusCode || 0;
      if (status < 200 || status >= 300) {
        response.destroy();
        reject(new OmniClientError(status, url, 'Connection probe failed.'));
        return;
      }
      void readBoundedNodeProbe(response)
        .then((bytes) => {
          validateIdentityProbeEnvelope(bytes);
          resolve();
        }, reject);
    });
    outbound.once('error', reject);
    outbound.end();
  });
}

async function injectedIdentityProbe(
  url: string,
  apiKey: string,
  signal: AbortSignal,
  dependencies: InstanceHandlerDependencies,
): Promise<void> {
  await (dependencies.validateProbeOutbound
    || ((candidate: string) => assertSafeOutboundUrl(candidate, { label: 'base_url' })))(url);
  const response = await dependencies.probeFetch!(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
    redirect: 'manual',
    signal,
  });
  if (!response.ok) throw new OmniClientError(response.status, url, 'Connection probe failed.');
  validateIdentityProbeEnvelope(await readBoundedFetchProbe(response));
}

function nodeResponseHeaders(response: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(response.headers)) {
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else if (typeof value === 'string') {
      headers.set(name, value);
    }
  }
  return headers;
}

export async function pinnedOmniFetch(
  input: Parameters<typeof fetch>[0],
  init: Parameters<typeof fetch>[1],
  dependencies: InstanceHandlerDependencies,
  maxResponseBytes: number,
): Promise<Response> {
  const request = input instanceof Request ? input : undefined;
  const url = request?.url || String(input);
  await (dependencies.validateProbeOutbound
    || ((candidate: string) => assertSafeOutboundUrl(candidate, { label: 'base_url' })))(url);
  const parsed = new URL(url);
  const method = (init?.method || request?.method || 'GET').toUpperCase();
  if (method !== 'GET') throw new Error('The pinned Omni inventory transport permits GET requests only.');
  if (init?.body || request?.body) throw new Error('The pinned Omni inventory transport does not permit request bodies.');
  const headers = new Headers(request?.headers);
  new Headers(init?.headers).forEach((value, name) => headers.set(name, value));
  if (!headers.has('accept-encoding')) headers.set('accept-encoding', 'identity');
  const outboundHeaders: Record<string, string> = {};
  headers.forEach((value, name) => {
    outboundHeaders[name] = value;
  });

  return new Promise<Response>((resolve, reject) => {
    const outbound = (dependencies.pinnedRequest || httpsRequest)(parsed, {
      method,
      headers: outboundHeaders,
      agent: false,
      lookup: publicOnlyProbeLookup(dependencies.probeLookup),
      ...(isIP(parsed.hostname) ? {} : { servername: parsed.hostname }),
      ...(init?.signal ? { signal: init.signal } : {}),
    }, (response) => {
      const status = response.statusCode || 0;
      if (status < 200 || status > 599) {
        response.destroy();
        reject(new Error('The pinned Omni transport returned an unsupported HTTP status.'));
        return;
      }
      void readBoundedProbeStream(
        response,
        declaredProbeBytes(response.headers['content-length']),
        () => response.destroy(),
        maxResponseBytes,
      ).then((bytes) => {
        const body = Uint8Array.from(bytes).buffer;
        resolve(new Response(status === 204 || status === 205 || status === 304 ? null : body, {
          status,
          statusText: response.statusMessage,
          headers: nodeResponseHeaders(response),
        }));
      }, reject);
    });
    outbound.once('error', reject);
    outbound.end();
  });
}

/**
 * Bounds the complete operation, including DNS validation that cannot itself be
 * interrupted by an AbortSignal. The losing operation remains observed so a
 * late rejection cannot become an unhandled rejection.
 */
export async function runWithInstanceValidationDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  options: { timeoutMs: number; signal?: AbortSignal },
): Promise<T> {
  if (options.signal?.aborted) throw new InstanceValidationCancelledError();

  const controller = new AbortController();
  let interrupt: ((error: Error) => void) | undefined;
  let interrupted = false;
  const interruption = new Promise<never>((_resolve, reject) => {
    interrupt = (error) => {
      if (interrupted) return;
      interrupted = true;
      controller.abort(error);
      reject(error);
    };
  });
  const cancel = () => interrupt?.(new InstanceValidationCancelledError());
  options.signal?.addEventListener('abort', cancel, { once: true });
  const timeout = setTimeout(() => {
    interrupt?.(new InstanceValidationDeadlineError(options.timeoutMs));
  }, options.timeoutMs);

  const operationPromise = Promise.resolve().then(() => operation(controller.signal));
  // Promise.race observes this promise too, but the explicit observer documents
  // and preserves the invariant if this helper is refactored later.
  void operationPromise.catch(() => undefined);
  try {
    return await Promise.race([operationPromise, interruption]);
  } finally {
    interrupted = true;
    clearTimeout(timeout);
    options.signal?.removeEventListener('abort', cancel);
  }
}

async function bodyJson(req: Request): Promise<Record<string, unknown>> {
  try {
    return await req.json() as Record<string, unknown>;
  } catch {
    return {};
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: jsonHeaders });
}

function requireUnlocked(): Response | null {
  return isVaultUnlocked() ? null : json({ error: 'vault locked' }, 423);
}

function cleanString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function normalizeFolderPath(value: string | undefined): string {
  return (value || '').trim().replace(/^\/+|\/+$/g, '').toLowerCase();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nestedString(obj: unknown, ...path: string[]): string | undefined {
  let current: unknown = obj;
  for (const key of path) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return typeof current === 'string' && current.trim() ? current : undefined;
}

const MODEL_PLACEHOLDER_VALUES = new Set([
  'unknown',
  'model unknown',
  'model not detected',
  'not detected',
  'n/a',
  'none',
  '-',
]);

function cleanModelMetadata(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return MODEL_PLACEHOLDER_VALUES.has(trimmed.toLowerCase()) ? undefined : trimmed;
}

function findStringByKey(obj: unknown, keys: string[], maxDepth = 6): string | undefined {
  if (maxDepth <= 0) return undefined;
  if (Array.isArray(obj)) {
    for (const value of obj) {
      const found = findStringByKey(value, keys, maxDepth - 1);
      if (found) return found;
    }
    return undefined;
  }
  if (!isRecord(obj)) return undefined;
  for (const key of keys) {
    const value = obj[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  for (const value of Object.values(obj)) {
    const found = findStringByKey(value, keys, maxDepth - 1);
    if (found) return found;
  }
  return undefined;
}

function collectTopicMetadata(payload: unknown): { topicNames: string[]; topicIds: string[] } {
  const topicNames = new Set<string>();
  const topicIds = new Set<string>();

  function addName(value: unknown): void {
    const cleaned = cleanModelMetadata(value);
    if (cleaned) topicNames.add(cleaned);
  }

  function addId(value: unknown): void {
    const cleaned = cleanModelMetadata(value);
    if (cleaned) topicIds.add(cleaned);
  }

  function walk(value: unknown, maxDepth = 8): void {
    if (maxDepth <= 0 || !value || typeof value !== 'object') return;
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item && typeof item === 'object') walk(item, maxDepth - 1);
      }
      return;
    }

    const record = value as Record<string, unknown>;
    addName(record.topicName);
    addName(record.topic_name);
    if (typeof record.topic === 'string') addName(record.topic);
    addId(record.topicId);
    addId(record.topic_id);
    addId(record.topicIdentifier);
    addId(record.topic_identifier);
    addId(record.topicKey);
    addId(record.topic_key);
    if (isRecord(record.topic)) {
      addName(record.topic.label || record.topic.name);
      addId(record.topic.id || record.topic.identifier || record.topic.name);
    }

    for (const key of ['topicNames', 'topic_names', 'topicIdentifiers', 'topic_identifiers']) {
      const raw = record[key];
      if (!Array.isArray(raw)) continue;
      for (const item of raw) {
        if (typeof item === 'string') addName(item);
        else if (isRecord(item)) {
          addName(item.label || item.name);
          addId(item.id || item.identifier || item.name);
        }
      }
    }

    for (const child of Object.values(record)) {
      if (child && typeof child === 'object') walk(child, maxDepth - 1);
    }
  }

  walk(payload);
  const names = [...topicNames].sort((a, b) => a.localeCompare(b));
  const ids = [...topicIds].sort((a, b) => a.localeCompare(b));
  return {
    topicNames: names,
    topicIds: ids.length > 0 ? ids : names,
  };
}

function modelLabel(model: OmniModelRecord): string {
  return model.name || model.identifier || model.id;
}

function modelNameByKey(models: OmniModelRecord[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const model of models) {
    const label = modelLabel(model);
    for (const key of [model.id, model.identifier, model.baseModelId, model.name]) {
      if (key && !names.has(key)) names.set(key, label);
    }
  }
  return names;
}

function extractModelDetails(payload: unknown): { baseModelId?: string; baseModelName?: string } {
  const baseModelId = cleanModelMetadata(nestedString(payload, 'dashboard', 'sharedModelId')
    || nestedString(payload, 'dashboard', 'model', 'baseModelId')
    || nestedString(payload, 'dashboard', 'model', 'id')
    || nestedString(payload, 'dashboard', 'baseModel', 'id')
    || nestedString(payload, 'dashboard', 'baseModelId')
    || nestedString(payload, 'workbookModel', 'baseModelId')
    || nestedString(payload, 'workbookModel', 'id')
    || nestedString(payload, 'workbookModel', 'modelId')
    || nestedString(payload, 'document', 'sharedModelId')
    || nestedString(payload, 'document', 'baseModel', 'id')
    || nestedString(payload, 'document', 'baseModelId')
    || nestedString(payload, 'document', 'model', 'id')
    || nestedString(payload, 'model', 'id')
    || findStringByKey(payload, [
      'sharedModelId',
      'shared_model_id',
      'baseModelId',
      'base_model_id',
      'modelId',
      'model_id',
    ]));
  const baseModelName = cleanModelMetadata(nestedString(payload, 'document', 'baseModel', 'name')
    || nestedString(payload, 'dashboard', 'baseModel', 'name')
    || nestedString(payload, 'dashboard', 'model', 'name')
    || nestedString(payload, 'workbookModel', 'name')
    || nestedString(payload, 'workbookModel', 'modelName')
    || nestedString(payload, 'document', 'model', 'name')
    || nestedString(payload, 'model', 'name')
    || findStringByKey(payload, ['modelName', 'model_name'], 4));
  return { baseModelId, baseModelName };
}

function topicLabelFromYaml(content: string): string | undefined {
  const labelMatch = content.match(/^label:\s*["']?(.+?)["']?\s*$/m);
  return cleanModelMetadata(labelMatch?.[1]);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new DOMException('The operation was aborted.', 'AbortError');
}

function isAbortFailure(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true
    || (error instanceof DOMException && error.name === 'AbortError')
    || (error instanceof Error && error.name === 'AbortError');
}

async function mapWithBoundedConcurrency<T, U>(
  values: T[],
  concurrency: number,
  mapper: (value: T, index: number) => Promise<U>,
  signal?: AbortSignal,
): Promise<U[]> {
  if (values.length === 0) return [];
  const output = new Array<U>(values.length);
  let nextIndex = 0;
  const worker = async () => {
    while (true) {
      throwIfAborted(signal);
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      output[index] = await mapper(values[index], index);
    }
  };
  await Promise.all(Array.from(
    { length: Math.min(values.length, Math.max(1, concurrency)) },
    () => worker(),
  ));
  return output;
}

async function inferSingleTopicFromModel(
  client: OmniClient,
  modelId: string | undefined,
  signal?: AbortSignal,
): Promise<{ topicNames: string[]; topicIds: string[] }> {
  const cleanModelId = cleanModelMetadata(modelId);
  if (!cleanModelId) return { topicNames: [], topicIds: [] };
  try {
    const files = await client.getModelYamlFiles(cleanModelId, signal);
    const topics = Object.entries(files)
      .filter(([filePath]) => filePath.split('/').pop()?.endsWith('.topic'))
      .map(([filePath, content]) => {
        const fileName = filePath.split('/').pop() || filePath;
        const id = cleanModelMetadata(fileName.replace(/\.topic$/, ''));
        if (!id) return null;
        return {
          id,
          name: topicLabelFromYaml(content) || id,
        };
      })
      .filter((topic): topic is { id: string; name: string } => Boolean(topic));
    if (topics.length !== 1) return { topicNames: [], topicIds: [] };
    return { topicNames: [topics[0].name], topicIds: [topics[0].id] };
  } catch (error) {
    if (isAbortFailure(error, signal)) throw error;
    return { topicNames: [], topicIds: [] };
  }
}

function activeConnectionModels(models: OmniModelRecord[], connectionId?: string): OmniModelRecord[] {
  return models
    .filter((model) => !model.deletedAt)
    .filter((model) => !connectionId || model.connectionId === connectionId);
}

async function enrichDocumentModelDetails(
  client: OmniClient,
  documents: OmniDocumentRecord[],
  options: { connectionId?: string; signal?: AbortSignal } = {},
): Promise<OmniDocumentRecord[]> {
  throwIfAborted(options.signal);
  let listedModels: OmniModelRecord[] = [];
  try {
    listedModels = await client.listModels(
      { modelKind: 'SHARED', connectionId: options.connectionId },
      options.signal,
    );
  } catch (error) {
    if (isAbortFailure(error, options.signal)) throw error;
  }
  const models = activeConnectionModels(listedModels, options.connectionId);
  const namesByKey = modelNameByKey(models);
  const connectionFallbackModel = options.connectionId && models.length === 1 ? models[0] : undefined;
  const exportedByDocument = new Map<string, Promise<Record<string, unknown>>>();
  const queriesByDocument = new Map<string, ReturnType<OmniClient['getDocumentQueries']>>();
  const topicsByModel = new Map<string, Promise<{ topicNames: string[]; topicIds: string[] }>>();

  const exportDocument = (identifier: string) => {
    let pending = exportedByDocument.get(identifier);
    if (!pending) {
      pending = client.exportDocument(identifier, options.signal);
      exportedByDocument.set(identifier, pending);
    }
    return pending;
  };
  const queryDocument = (identifier: string) => {
    let pending = queriesByDocument.get(identifier);
    if (!pending) {
      pending = client.getDocumentQueries(identifier, options.signal);
      queriesByDocument.set(identifier, pending);
    }
    return pending;
  };
  const inferTopics = (modelId: string) => {
    let pending = topicsByModel.get(modelId);
    if (!pending) {
      pending = inferSingleTopicFromModel(client, modelId, options.signal);
      topicsByModel.set(modelId, pending);
    }
    return pending;
  };

  return mapWithBoundedConcurrency(documents, 2, async (document) => {
    throwIfAborted(options.signal);
    let baseModelId = cleanModelMetadata(document.baseModelId);
    let baseModelName = cleanModelMetadata(document.baseModelName) || (baseModelId ? namesByKey.get(baseModelId) : undefined);
    let topicNames = document.topicNames || [];
    let topicIds = document.topicIds || [];
    if (!baseModelId || !baseModelName || topicNames.length === 0 || topicIds.length === 0) {
      try {
        const exportPayload = await exportDocument(document.identifier);
        const details = extractModelDetails(exportPayload);
        const topics = collectTopicMetadata(exportPayload);
        baseModelId ||= details.baseModelId;
        baseModelName ||= details.baseModelName || (baseModelId ? namesByKey.get(baseModelId) : undefined);
        if (topics.topicNames.length > 0) topicNames = topics.topicNames;
        if (topics.topicIds.length > 0) topicIds = topics.topicIds;
      } catch (error) {
        if (isAbortFailure(error, options.signal)) throw error;
        // Best-effort enrichment; preflight still validates migrations before imports run.
      }
    }
    if (!baseModelId || !baseModelName || topicNames.length === 0 || topicIds.length === 0) {
      try {
        const queryDetails = await queryDocument(document.identifier);
        const details = extractModelDetails(queryDetails);
        const topics = collectTopicMetadata(queryDetails);
        baseModelId ||= details.baseModelId;
        baseModelName ||= details.baseModelName || (baseModelId ? namesByKey.get(baseModelId) : undefined);
        if (topics.topicNames.length > 0) topicNames = topics.topicNames;
        if (topics.topicIds.length > 0) topicIds = topics.topicIds;
      } catch (error) {
        if (isAbortFailure(error, options.signal)) throw error;
        // Query metadata is optional; keep moving with model fallback if available.
      }
    }
    if (!baseModelId && connectionFallbackModel) baseModelId = connectionFallbackModel.id;
    if (!baseModelName && baseModelId) baseModelName = namesByKey.get(baseModelId);
    if (!baseModelName && connectionFallbackModel && baseModelId === connectionFallbackModel.id) {
      baseModelName = modelLabel(connectionFallbackModel);
    }
    if ((topicNames.length === 0 || topicIds.length === 0) && baseModelId) {
      const topics = await inferTopics(baseModelId);
      if (topicNames.length === 0) topicNames = topics.topicNames;
      if (topicIds.length === 0) topicIds = topics.topicIds;
    }
    const documentWithoutModelPlaceholders = { ...document };
    delete documentWithoutModelPlaceholders.baseModelId;
    delete documentWithoutModelPlaceholders.baseModelName;
    delete documentWithoutModelPlaceholders.topicNames;
    delete documentWithoutModelPlaceholders.topicIds;
    return {
      ...documentWithoutModelPlaceholders,
      ...(baseModelId ? { baseModelId } : {}),
      ...(baseModelName ? { baseModelName } : {}),
      ...(topicNames.length > 0 ? { topicNames } : {}),
      ...(topicIds.length > 0 ? { topicIds } : {}),
    };
  }, options.signal);
}

function parseStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
    : [];
}

function parseFilter(value: unknown): InstanceMetricFilter {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  return {
    connectionDatabaseContains: parseStringArray(record.connectionDatabaseContains),
    connectionDatabaseExact: parseStringArray(record.connectionDatabaseExact),
    embedExternalIdContains: parseStringArray(record.embedExternalIdContains),
    embedExternalIdExact: parseStringArray(record.embedExternalIdExact),
  };
}

function parseActions(value: unknown): PostMigrationAction[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((action): action is Record<string, unknown> => Boolean(action) && typeof action === 'object' && !Array.isArray(action))
    .map((action) => ({
      kind: action.kind === 'refresh-schema' ? 'refresh-schema' as const : 'webhook' as const,
      name: cleanString(action.name) || 'Post-migration action',
      method: parseMethod(action.method),
      url: cleanString(action.url) || '',
      headers: action.headers && typeof action.headers === 'object' && !Array.isArray(action.headers)
        ? Object.fromEntries(Object.entries(action.headers).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
        : {},
      body: typeof action.body === 'string' ? action.body : '',
      destinationInstanceId: cleanString(action.destinationInstanceId),
      targetModelId: cleanString(action.targetModelId),
      targetModelName: cleanString(action.targetModelName),
    }))
    .filter((action) => action.kind === 'refresh-schema' ? Boolean(action.targetModelId) : Boolean(action.url));
}

function parseLabelNames(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean))]
    : [];
}

function parseMethod(value: unknown): PostMigrationAction['method'] {
  const method = typeof value === 'string' ? value.toUpperCase() : 'POST';
  if (method === 'GET' || method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') return method;
  return 'POST';
}

function parseRole(value: unknown): InstanceRole {
  return value === 'source' || value === 'destination' || value === 'both' ? value : 'destination';
}

function parseInstance(body: Record<string, unknown>, id?: string): Partial<SavedInstance> & { apiKey?: string } {
  return {
    ...(id ? { id } : {}),
    label: cleanString(body.label),
    role: parseRole(body.role),
    baseUrl: cleanString(body.baseUrl),
    apiKey: typeof body.apiKey === 'string' ? body.apiKey : undefined,
    defaultModelId: cleanString(body.defaultModelId),
    defaultFolderId: cleanString(body.defaultFolderId),
    defaultFolderPath: cleanString(body.defaultFolderPath),
    entityGroupSeparator: typeof body.entityGroupSeparator === 'string' ? body.entityGroupSeparator : undefined,
    organizationApiKeyConfirmed: body.organizationApiKeyConfirmed === true,
    portfolioAppLabel: cleanString(body.portfolioAppLabel),
    metricFilter: parseFilter(body.metricFilter),
    postMigrationActions: parseActions(body.postMigrationActions),
  };
}

function validateInstanceInput(input: Partial<SavedInstance> & { apiKey?: string }, updating = false): void {
  if (input.baseUrl) {
    const urlError = validateBaseUrl(input.baseUrl);
    if (urlError) throw new Error(urlError);
  } else if (!updating) {
    throw new Error('Instance Base URL is required.');
  }
  if (!updating && (!input.apiKey || !input.apiKey.trim())) {
    throw new Error('Instance API key is required.');
  }
  for (const action of input.postMigrationActions || []) {
    const actionError = validatePostMigrationActionTarget(action);
    if (actionError) {
      throw Object.assign(new Error(`Post-migration action "${action.name}" is invalid: ${actionError}`), { statusCode: 400 });
    }
  }
}

function hasReusableConnectionValidation(instance: Pick<SavedInstance, 'lastValidatedAt'>, now = Date.now()): boolean {
  const validatedAt = Date.parse(instance.lastValidatedAt || '');
  if (!Number.isFinite(validatedAt)) return false;
  const ageMs = now - validatedAt;
  return ageMs >= 0 && ageMs < CONNECT_VALIDATION_REUSE_MS;
}

function sameCredentialBoundary(
  left: Pick<SavedInstance, 'baseUrl' | 'apiKey'>,
  right: Pick<SavedInstance, 'baseUrl' | 'apiKey'>,
): boolean {
  return left.baseUrl === right.baseUrl && left.apiKey === right.apiKey;
}

async function testInstance(
  instance: Pick<SavedInstance, 'baseUrl' | 'apiKey' | 'label'>,
  signal?: AbortSignal,
  dependencies: InstanceHandlerDependencies = {},
): Promise<void> {
  const urlError = validateBaseUrl(instance.baseUrl);
  if (urlError) throw new InstanceUrlValidationError();
  const targetUrl = `${instance.baseUrl.replace(/\/+$/, '')}/api/v1/whoami`;
  await runWithInstanceValidationDeadline(
    (boundedSignal) => dependencies.probeFetch
      ? injectedIdentityProbe(targetUrl, instance.apiKey, boundedSignal, dependencies)
      : pinnedIdentityProbe(targetUrl, instance.apiKey, boundedSignal, dependencies),
    { timeoutMs: INTERACTIVE_TEST_TIMEOUT_MS, signal },
  );
}

function nestedSystemErrorCode(error: unknown, depth = 0): string {
  if (!error || typeof error !== 'object' || depth > 3) return '';
  const candidate = error as { code?: unknown; cause?: unknown };
  if (typeof candidate.code === 'string' && candidate.code.trim()) {
    return candidate.code.trim().toUpperCase();
  }
  return nestedSystemErrorCode(candidate.cause, depth + 1);
}

function isTlsSystemError(code: string): boolean {
  return code.startsWith('ERR_TLS_')
    || code.startsWith('CERT_')
    || code === 'DEPTH_ZERO_SELF_SIGNED_CERT'
    || code === 'SELF_SIGNED_CERT_IN_CHAIN'
    || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE';
}

function transportFailureCode(error: unknown): InstanceConnectionErrorCode {
  if (error instanceof InstanceUrlValidationError) return INSTANCE_CONNECTION_ERROR_CODES.urlInvalid;
  const code = nestedSystemErrorCode(error);
  if (code === 'ERR_INVALID_URL') return INSTANCE_CONNECTION_ERROR_CODES.urlInvalid;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return INSTANCE_CONNECTION_ERROR_CODES.dnsResolutionFailed;
  if (code === 'EACCES') return INSTANCE_CONNECTION_ERROR_CODES.networkTargetBlocked;
  if (code === 'ECONNREFUSED') return INSTANCE_CONNECTION_ERROR_CODES.connectionRefused;
  if (code === 'ENETUNREACH' || code === 'EHOSTUNREACH') return INSTANCE_CONNECTION_ERROR_CODES.networkUnreachable;
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') return INSTANCE_CONNECTION_ERROR_CODES.networkTimeout;
  if (code === 'ECONNRESET' || code === 'ECONNABORTED' || code === 'EPIPE') {
    return INSTANCE_CONNECTION_ERROR_CODES.connectionInterrupted;
  }
  if (isTlsSystemError(code)) return INSTANCE_CONNECTION_ERROR_CODES.tlsValidationFailed;
  return INSTANCE_CONNECTION_ERROR_CODES.transportFailed;
}

function diagnosticResponse(code: InstanceConnectionErrorCode, status: number): Response {
  return json({
    error: INSTANCE_CONNECTION_DIAGNOSTICS[code].message,
    code,
  }, status);
}

function upstreamFailureCode(status: number): InstanceConnectionErrorCode {
  if (status >= 300 && status < 400) return INSTANCE_CONNECTION_ERROR_CODES.redirectBlocked;
  if (status === 401) return INSTANCE_CONNECTION_ERROR_CODES.credentialRejected;
  if (status === 403) return INSTANCE_CONNECTION_ERROR_CODES.callerForbidden;
  if (status === 404 || status === 405) return INSTANCE_CONNECTION_ERROR_CODES.identityEndpointUnavailable;
  if (status === 429) return INSTANCE_CONNECTION_ERROR_CODES.rateLimited;
  if (status >= 500) return INSTANCE_CONNECTION_ERROR_CODES.upstreamUnavailable;
  return INSTANCE_CONNECTION_ERROR_CODES.validationHttpFailed;
}

function upstreamFailureStatus(code: InstanceConnectionErrorCode): number {
  if (code === INSTANCE_CONNECTION_ERROR_CODES.credentialRejected) return 401;
  if (code === INSTANCE_CONNECTION_ERROR_CODES.callerForbidden) return 403;
  if (code === INSTANCE_CONNECTION_ERROR_CODES.rateLimited) return 429;
  return 502;
}

function instanceValidationErrorResponse(error: unknown, requestSignal?: AbortSignal): Response {
  if (requestSignal?.aborted || error instanceof InstanceValidationCancelledError) {
    return diagnosticResponse(INSTANCE_CONNECTION_ERROR_CODES.cancelled, 499);
  }
  if (error instanceof InstanceValidationDeadlineError
    || (error instanceof DOMException && error.name === 'AbortError')) {
    return diagnosticResponse(INSTANCE_CONNECTION_ERROR_CODES.timeout, 504);
  }
  if (error instanceof InstanceProbeResponseError) {
    return diagnosticResponse(INSTANCE_CONNECTION_ERROR_CODES.invalidResponse, 502);
  }
  if (error instanceof OmniClientError) {
    const code = upstreamFailureCode(error.status);
    return diagnosticResponse(code, upstreamFailureStatus(code));
  }
  const code = transportFailureCode(error);
  return diagnosticResponse(
    code,
    code === INSTANCE_CONNECTION_ERROR_CODES.urlInvalid
      || code === INSTANCE_CONNECTION_ERROR_CODES.networkTargetBlocked
      ? 400
      : 502,
  );
}

export default async function handler(
  req: Request,
  dependencies: InstanceHandlerDependencies = {},
): Promise<Response> {
  try {
    const locked = requireUnlocked();
    if (locked) return locked;

    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/api\/instances\/?/, '');
    const parts = path.split('/').filter(Boolean);

    if (req.method === 'GET' && parts.length === 0) {
      return json({ instances: listInstances() });
    }

    if (req.method === 'POST' && parts.length === 0) {
      const body = await bodyJson(req);
      const input = parseInstance(body);
      validateInstanceInput(input);
      const saved = upsertInstance(input);
      clearReadThroughCache(`instance:${saved.id}:`);
      return json({ instance: saved });
    }

    if (req.method === 'POST' && parts.length === 1 && parts[0] === 'import-legacy') {
      const body = await bodyJson(req);
      const legacyPath = cleanString(body.path);
      const passphrase = typeof body.passphrase === 'string' ? body.passphrase : '';
      if (!legacyPath) return json({ error: 'Legacy vault path is required.' }, 400);
      if (!passphrase) return json({ error: 'Legacy vault passphrase is required.' }, 400);
      const result = importLegacyVault({
        path: legacyPath,
        passphrase,
        dryRun: body.dryRun === true,
        confirmAbsolutePath: body.confirmAbsolutePath === true,
      });
      if (body.dryRun !== true) clearReadThroughCache('instance:');
      return json(result);
    }

    const id = parts[0];
    if (!id) return json({ error: 'Instance id required.' }, 400);

    if (req.method === 'GET' && parts.length === 1) {
      const instance = listInstances().find((row) => row.id === id);
      if (!instance) return json({ error: 'Instance not found.' }, 404);
      return json({ instance });
    }

    if (req.method === 'PUT' && parts.length === 1) {
      const body = await bodyJson(req);
      const input = parseInstance(body, id);
      validateInstanceInput(input, true);
      const saved = upsertInstance(input);
      clearReadThroughCache(`instance:${id}:`);
      return json({ instance: saved });
    }

    if (req.method === 'DELETE' && parts.length === 1) {
      clearReadThroughCache(`instance:${id}:`);
      deleteInstance(id);
      return json({ ok: true });
    }

    if (req.method === 'POST' && parts[1] === 'test') {
      const secret = getInstance(id);
      if (!secret) return json({ error: 'Instance not found.' }, 404);
      try {
        await testInstance(secret, req.signal, dependencies);
      } catch (error) {
        return instanceValidationErrorResponse(error, req.signal);
      }
      const current = getInstance(id);
      if (!current || !sameCredentialBoundary(secret, current)) {
        return json({
          error: 'The saved instance changed during validation. Test the current credential again.',
          code: 'INSTANCE_CREDENTIAL_CHANGED',
        }, 409);
      }
      return json({ instance: markInstanceValidated(id) });
    }

    if (req.method === 'POST' && parts[1] === 'connect') {
      const secret = getInstance(id);
      if (!secret) return json({ error: 'Instance not found.' }, 404);
      let validationSource: 'recent' | 'live' = 'recent';
      let instance = listInstances().find((row) => row.id === id);
      if (!instance) return json({ error: 'Instance not found.' }, 404);
      if (!hasReusableConnectionValidation(secret)) {
        validationSource = 'live';
        try {
          await testInstance(secret, req.signal, dependencies);
        } catch (error) {
          return instanceValidationErrorResponse(error, req.signal);
        }
        const current = getInstance(id);
        if (!current || !sameCredentialBoundary(secret, current)) {
          return json({
            error: 'The saved instance changed during validation. Connect to the current credential again.',
            code: 'INSTANCE_CREDENTIAL_CHANGED',
          }, 409);
        }
        instance = markInstanceValidated(id);
      }
      return json({
        instance,
        validationSource,
        connection: {
          baseUrl: instance.baseUrl,
          apiKey: `${VAULT_API_KEY_REFERENCE_PREFIX}${id}`,
          status: 'success',
          connectionMode: 'vault',
          instanceId: id,
          instanceLabel: instance.label,
          apiKeyMasked: instance.apiKeyMasked,
        },
      });
    }

    if (req.method === 'GET' && parts[1] === 'documents') {
      const secret = getInstance(id);
      if (!secret) return json({ error: 'Instance not found.' }, 404);
      const timings = createPerformanceTracker();
      const inventoryClient = new OmniClient(secret, {
        requestTimeoutMs: DOCUMENT_INVENTORY_REQUEST_TIMEOUT_MS,
        maxReadRetries: DOCUMENT_INVENTORY_MAX_READ_RETRIES,
        fetchImpl: (input, init) => pinnedOmniFetch(
          input,
          init,
          dependencies,
          DOCUMENT_INVENTORY_TRANSPORT_MAX_RESPONSE_BYTES,
        ),
      });
      const allFolders = url.searchParams.get('allFolders') === 'true';
      const requestedFolderId = cleanString(url.searchParams.get('folderId'));
      const requestedFolderPath = cleanString(url.searchParams.get('folderPath'));
      const folderId = allFolders
        ? undefined
        : requestedFolderId || (requestedFolderPath ? undefined : secret.defaultFolderId);
      const folderPath = allFolders
        ? undefined
        : requestedFolderPath || (requestedFolderId ? undefined : secret.defaultFolderPath);
      const connectionId = cleanString(url.searchParams.get('connectionId'));
      const includeModelDetails = url.searchParams.get('includeModelDetails') === 'true';
      const forceRefresh = url.searchParams.get('forceRefresh') === 'true';
      const requestedDocumentIdList = (url.searchParams.get('documentIds') || '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
      if (requestedDocumentIdList.some((value) => value.length > MAX_DOCUMENT_IDENTIFIER_LENGTH)) {
        return json({
          error: `Document identifiers must be ${MAX_DOCUMENT_IDENTIFIER_LENGTH} characters or fewer.`,
          code: 'DOCUMENT_METADATA_IDENTIFIER_TOO_LONG',
          inventory: { complete: false },
        }, 400);
      }
      if (includeModelDetails && requestedDocumentIdList.length > MAX_DOCUMENT_METADATA_IDS) {
        return json({
          error: `Request model details in chunks of at most ${MAX_DOCUMENT_METADATA_IDS} documents.`,
          code: 'DOCUMENT_METADATA_BATCH_TOO_LARGE',
          inventory: { complete: false },
        }, 413);
      }
      const requestedDocumentIds = new Set(requestedDocumentIdList);
      const inventoryKey = documentInventoryCacheKey(id, secret, folderId);
      const loadInventory = () => readThroughCacheResult(
        inventoryKey,
        async (signal) => buildCachedDashboardInventory(
          await inventoryClient.listDocumentInventory({ includeLabels: true, folderId }, signal),
        ),
        { signal: req.signal, forceRefresh },
      );
      let inventoryResult: Awaited<ReturnType<typeof loadInventory>>;
      try {
        inventoryResult = await timings.time(
          'list-document-inventory',
          loadInventory,
          (result) => ({
            allFolders,
            folderScoped: Boolean(folderId),
            hasFolderPath: Boolean(folderPath),
            connectionScopedLocally: Boolean(connectionId),
            cacheStatus: result?.cache.status,
            sourceRecordCount: result?.value.sourceRecordCount || 0,
            pages: result?.value.pagination.pages || 0,
          }),
        );
      } catch (error) {
        if (req.signal.aborted) {
          return json({
            error: 'The dashboard inventory request was cancelled.',
            code: 'DOCUMENT_INVENTORY_CANCELLED',
            inventory: { complete: false },
          }, 499);
        }
        if (error instanceof OmniDocumentInventoryDeadlineError) {
          return json({
            error: 'The complete Omni dashboard inventory exceeded its size-aware deadline. Narrow the folder scope or retry.',
            code: error.code,
            inventory: { complete: false },
          }, 504);
        }
        if (error instanceof OmniResponseReadDeadlineError || error instanceof OmniRequestDeadlineError) {
          return json({
            error: 'An Omni dashboard inventory page did not finish within the bounded request deadline. Retry the inventory.',
            code: error.code,
            inventory: { complete: false },
          }, 504);
        }
        if (error instanceof OmniPaginationError || error instanceof OmniResponseLimitError) {
          return json({
            error: 'Omni did not return a complete, bounded dashboard inventory. No partial catalog was accepted.',
            code: error.code,
            inventory: { complete: false },
          }, 502);
        }
        throw error;
      }

      const inventory = inventoryResult.value;
      const partitionStartedAt = Date.now();
      let documents = dashboardsForConnection(inventory, connectionId);
      timings.mark('select-connection-partition', Date.now() - partitionStartedAt, {
        connectionScoped: Boolean(connectionId),
        count: documents.length,
      });
      if (!folderId && folderPath) {
        const filterStartedAt = Date.now();
        const requestedPath = normalizeFolderPath(folderPath);
        documents = documents.filter((document) => {
          const actualPath = normalizeFolderPath(document.folderPath);
          return actualPath === requestedPath || actualPath.endsWith(`/${requestedPath}`);
        });
        timings.mark('filter-folder-path', Date.now() - filterStartedAt, { count: documents.length });
      }
      if (requestedDocumentIds.size > 0) {
        const filterStartedAt = Date.now();
        documents = documents.filter((document) => requestedDocumentIds.has(document.identifier) || requestedDocumentIds.has(document.id));
        timings.mark('filter-document-ids', Date.now() - filterStartedAt, { count: documents.length });
      }
      if (includeModelDetails) {
        if (documents.length > MAX_DOCUMENT_METADATA_IDS) {
          return json({
            error: `Request model details in chunks of at most ${MAX_DOCUMENT_METADATA_IDS} documents.`,
            code: 'DOCUMENT_METADATA_BATCH_TOO_LARGE',
            inventory: { complete: false },
          }, 413);
        }
        const client = new OmniClient(secret, {
          requestTimeoutMs: DOCUMENT_INVENTORY_REQUEST_TIMEOUT_MS,
          maxReadRetries: DOCUMENT_INVENTORY_MAX_READ_RETRIES,
          fetchImpl: (input, init) => pinnedOmniFetch(
            input,
            init,
            dependencies,
            DOCUMENT_METADATA_TRANSPORT_MAX_RESPONSE_BYTES,
          ),
        });
        const credentialScope = documentInventoryCredentialScope(secret);
        const enrichedResult = await timings.time(
          'enrich-model-details',
          () => readThroughCacheResult(
            `instance:${id}:documents:metadata:${credentialScope}:${JSON.stringify({ connectionId, ids: documents.map((document) => document.identifier).sort() })}`,
            (signal) => enrichDocumentModelDetails(client, documents, { connectionId, signal }),
            { signal: req.signal, forceRefresh },
          ),
          (result) => ({ count: result?.value.length || 0, cacheStatus: result?.cache.status }),
        );
        documents = enrichedResult.value;
      }
      const connectionOwnedDashboardCount = inventory.dashboards.length - inventory.missingConnectionId;
      const selectedConnectionDashboardCount = connectionId
        ? dashboardsForConnection(inventory, connectionId).length
        : connectionOwnedDashboardCount;
      return json({
        documents,
        inventory: {
          complete: true,
          scope: 'credential',
          folderScoped: Boolean(folderId),
          cache: inventoryResult.cache,
          pagination: inventory.pagination,
          sourceRecordCount: inventory.sourceRecordCount,
          matchedRecordCount: documents.length,
          excluded: {
            missingConnectionId: inventory.missingConnectionId,
            otherConnection: connectionId
              ? Math.max(0, connectionOwnedDashboardCount - selectedConnectionDashboardCount)
              : 0,
            missingDashboardEvidence: inventory.missingDashboardEvidence,
          },
        },
        performance: timings.snapshot(),
      });
    }

    if (req.method === 'GET' && parts[1] === 'models' && parts[3] === 'topics') {
      const secret = getInstance(id);
      if (!secret) return json({ error: 'Instance not found.' }, 404);
      const modelId = decodeURIComponent(parts[2] || '').trim();
      if (!modelId) return json({ error: 'Model id required.' }, 400);
      const client = new OmniClient(secret);
      const topics = await readThroughCache(`instance:${id}:model:${modelId}:topics`, () => client.listModelTopics(modelId));
      return json({ topics });
    }

    if (req.method === 'GET' && parts[1] === 'models' && parts[3] === 'query-views') {
      const secret = getInstance(id);
      if (!secret) return json({ error: 'Instance not found.' }, 404);
      const modelId = decodeURIComponent(parts[2] || '').trim();
      if (!modelId) return json({ error: 'Model id required.' }, 400);
      const includeYaml = url.searchParams.get('includeYaml') === 'true';
      const includeChecksums = url.searchParams.get('includeChecksums') === 'true';
      const client = new OmniClient(secret);
      const queryViews = await readThroughCache(
        `instance:${id}:model:${modelId}:query-views:${JSON.stringify({ includeYaml, includeChecksums })}`,
        () => client.listModelQueryViews(modelId, { includeYaml, includeChecksums }),
      );
      return json({ queryViews });
    }

    if (req.method === 'GET' && parts[1] === 'models') {
      const secret = getInstance(id);
      if (!secret) return json({ error: 'Instance not found.' }, 404);
      const client = new OmniClient(secret);
      const modelKind = cleanString(url.searchParams.get('modelKind')) || 'SHARED';
      const connectionId = cleanString(url.searchParams.get('connectionId'));
      const models = activeConnectionModels(
        await readThroughCache(
          `instance:${id}:models:${JSON.stringify({ modelKind, connectionId })}`,
          () => client.listModels({ modelKind, connectionId }),
        ),
        connectionId,
      );
      return json({ models });
    }

    if (req.method === 'GET' && parts[1] === 'folders') {
      const secret = getInstance(id);
      if (!secret) return json({ error: 'Instance not found.' }, 404);
      const client = new OmniClient(secret);
      const folders = await readThroughCache(`instance:${id}:folders`, () => client.listFolders());
      return json({ folders });
    }

    if (req.method === 'GET' && parts[1] === 'labels') {
      const secret = getInstance(id);
      if (!secret) return json({ error: 'Instance not found.' }, 404);
      const client = new OmniClient(secret);
      const labels = await client.listLabels();
      return json({ labels });
    }

    if (req.method === 'PATCH' && parts[1] === 'documents' && parts[3] === 'metadata') {
      const secret = getInstance(id);
      if (!secret) return json({ error: 'Instance not found.' }, 404);
      const documentId = decodeURIComponent(parts[2] || '').trim();
      if (!documentId) return json({ error: 'Document identifier required.' }, 400);
      const body = await bodyJson(req);
      const client = new OmniClient(secret);
      const description = typeof body.description === 'string' ? body.description : undefined;
      const labels = parseLabelNames(body.labels);
      const createLabels = parseLabelNames(body.createLabels);
      if (description !== undefined) {
        await client.patchDocument(documentId, { description });
      }
      for (const label of createLabels) {
        await client.createLabel({ name: label });
      }
      if (labels.length > 0) await client.setDocumentLabels(documentId, labels);
      clearReadThroughCache(`instance:${id}:documents:`);
      return json({ ok: true });
    }

    return json({ error: `Unknown instances route: ${path}` }, 404);
  } catch (error) {
    if (req.signal.aborted || isAbortFailure(error, req.signal)) {
      return json({
        error: 'The instance request was cancelled.',
        code: 'INSTANCE_REQUEST_CANCELLED',
      }, 499);
    }
    const statusCode = typeof (error as { statusCode?: unknown }).statusCode === 'number'
      ? (error as { statusCode: number }).statusCode
      : 500;
    return json({ error: error instanceof Error ? redactSensitiveText(error.message) : 'Instance operation failed.' }, statusCode);
  }
}
