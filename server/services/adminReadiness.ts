import { assertSafeOutboundUrl, validateBaseUrl } from '../security';
import type { SavedInstance } from './nativeVault';

export type AdminReadinessWorkspace = 'fleet' | 'identity' | 'content' | 'developer';

export type AdminEvidenceState =
  | 'not_checked'
  | 'available'
  | 'partial'
  | 'unauthorized'
  | 'unsupported'
  | 'unavailable'
  | 'failed'
  | 'stale';

export type AdminReadinessState = 'ready' | 'action_required' | 'not_configured' | 'unknown';

export type AdminReadinessReasonCode =
  | 'ok'
  | 'partial_coverage'
  | 'authentication_required'
  | 'permission_denied'
  | 'collection_not_found'
  | 'resource_not_found'
  | 'method_not_allowed'
  | 'gone'
  | 'unexpected_redirect'
  | 'rate_limited'
  | 'upstream_failure'
  | 'request_rejected'
  | 'network_unavailable'
  | 'request_timeout'
  | 'invalid_json'
  | 'invalid_response_shape'
  | 'operator_confirmed'
  | 'operator_confirmation_missing'
  | 'no_documented_read_api'
  | 'manual_action_only'
  | 'not_configured'
  | 'cached_refresh_failed';

export interface AdminReadinessReason {
  code: AdminReadinessReasonCode;
  message: string;
}

export interface AdminReadinessSource {
  kind: 'omni_api' | 'operator_confirmation' | 'official_documentation';
  scope: 'collection' | 'resource' | 'saved_setting' | 'manual_action';
  method?: 'GET';
  path?: string;
}

export interface AdminReadinessCoverage {
  included: number;
  total: number | null;
  complete: boolean;
  unit: string;
}

export interface AdminReadinessDocumentation {
  label: string;
  url: string;
}

export interface AdminReadinessAction {
  kind: 'documentation' | 'tenant_deep_link';
  label: string;
  url: string;
}

interface AdminEvidenceEnvelope {
  evidenceState: AdminEvidenceState;
  readinessState: AdminReadinessState;
  reason: AdminReadinessReason;
  source: AdminReadinessSource;
  checkedAt: string;
  coverage: AdminReadinessCoverage;
  exclusions: string[];
  documentation: AdminReadinessDocumentation[];
}

export interface AdminModelRoleEvidence {
  baseRole?: string;
  roleName: string;
  connectionId?: string;
  modelId?: string;
  priority?: number;
  resolved?: boolean;
  provenance?: {
    type?: string;
    name?: string;
    depth?: number;
  };
}

export interface AdminAccessPostureRequestScope {
  principalId: string;
  modelId?: string;
  connectionId?: string;
}

export interface AdminAccessPosture extends AdminEvidenceEnvelope {
  id: 'identity.user_model_roles' | 'identity.group_model_roles';
  principalType: 'user' | 'group';
  requestScope: AdminAccessPostureRequestScope;
  roles: AdminModelRoleEvidence[];
}

export interface AdminReadinessCapability extends AdminEvidenceEnvelope {
  id:
    | 'fleet.folder_read'
    | 'fleet.api_tokens'
    | 'fleet.organization_api_key_confirmation'
    | 'fleet.current_token_introspection'
    | 'identity.scim_users'
    | 'identity.scim_groups'
    | 'identity.user_attributes'
    | 'content.schedules'
    | 'developer.embed_users'
    | 'developer.sso_configuration'
    | 'developer.audit_configuration'
    | 'developer.api_explorer';
  label: string;
  data?: Record<string, unknown> | Array<Record<string, unknown>>;
  actions?: AdminReadinessAction[];
}

export interface AdminReadinessReport {
  schemaVersion: 1;
  instanceId: string;
  workspace: AdminReadinessWorkspace;
  checkedAt: string;
  servedFromCache: boolean;
  capabilities: AdminReadinessCapability[];
  accessPosture?: AdminAccessPosture;
}

export interface AdminAccessPostureRequest extends AdminAccessPostureRequestScope {
  principalType: 'user' | 'group';
}

export interface AdminReadinessInput {
  instance: Pick<SavedInstance, 'id' | 'baseUrl' | 'apiKey' | 'updatedAt' | 'organizationApiKeyConfirmed'>;
  workspace: AdminReadinessWorkspace;
  accessPosture?: AdminAccessPostureRequest;
}

export interface AdminReadinessDependencies {
  fetchImpl?: typeof fetch;
  assertSafeUrl?: (url: string) => Promise<void>;
  now?: () => Date;
  timeoutMs?: number;
  freshCacheMs?: number;
  staleCacheMs?: number;
  maxCollectionPages?: number;
}

type JsonRecord = Record<string, unknown>;

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_FRESH_CACHE_MS = 60_000;
const DEFAULT_STALE_CACHE_MS = 15 * 60_000;
const DEFAULT_MAX_COLLECTION_PAGES = 10;
const MAX_JSON_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_DIRECT_RECORDS = 1_000;
const MAX_CACHE_ENTRIES = 200;

const DOCS = {
  apiExplorer: 'https://docs.omni.co/api/api-explorer',
  apiTokens: 'https://docs.omni.co/api/api-tokens/list-api-tokens',
  authentication: 'https://docs.omni.co/api/authentication',
  whoami: 'https://docs.omni.co/api/who-am-i/get-current-identity-and-permissions',
  folders: 'https://docs.omni.co/api/folders/list-folders',
  schedules: 'https://docs.omni.co/api/schedules/list-schedules',
  users: 'https://docs.omni.co/api/users/list-users',
  groups: 'https://docs.omni.co/api/user-groups/list-user-groups',
  embedUsers: 'https://docs.omni.co/api/users/list-embed-users',
  userAttributes: 'https://docs.omni.co/api/user-attributes/list-user-attributes',
  userRoles: 'https://docs.omni.co/api/user-model-roles/retrieve-user-model-roles',
  groupRoles: 'https://docs.omni.co/api/user-group-model-roles/retrieve-user-group-model-roles',
  embedSso: 'https://docs.omni.co/embed/setup/standard-sso',
  auditLogs: 'https://docs.omni.co/administration/audit-logs',
} as const;

const cache = new Map<string, {
  freshUntil: number;
  staleUntil: number;
  report: AdminReadinessReport;
}>();
const inFlight = new Map<string, Promise<AdminReadinessReport>>();

class AdminReadException extends Error {
  constructor(
    readonly code: AdminReadinessReasonCode,
    readonly status?: number,
  ) {
    super(code);
    this.name = 'AdminReadException';
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown, maxLength = 500): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  return normalized && normalized.length <= maxLength && !hasAsciiControlCharacter(normalized)
    ? normalized
    : undefined;
}

function hasAsciiControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
}

const REQUEST_SCOPE_EMAIL_PATTERN = /[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+/i;
const REQUEST_SCOPE_SECRET_PATTERN = /\bbearer\s+\S+|\b(?:api[_ -]?key|authorization|token|secret|password|signature)\b\s*[:=]\s*\S+|https?:\/\//i;

function invalidAccessPostureRequest(): Error & { statusCode: number } {
  return Object.assign(new Error('Access posture requires bounded opaque resource identifiers.'), { statusCode: 400 });
}

function opaqueRequestIdentifier(value: unknown, required: boolean): string | undefined {
  if (value === undefined && !required) return undefined;
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (
    !normalized
    || normalized.length > 500
    || hasAsciiControlCharacter(normalized)
    || REQUEST_SCOPE_EMAIL_PATTERN.test(normalized)
    || REQUEST_SCOPE_SECRET_PATTERN.test(normalized)
  ) {
    throw invalidAccessPostureRequest();
  }
  return normalized;
}

function normalizeAccessPostureRequest(request: AdminAccessPostureRequest): AdminAccessPostureRequest {
  if (request.principalType !== 'user' && request.principalType !== 'group') {
    throw invalidAccessPostureRequest();
  }
  const principalId = opaqueRequestIdentifier(request.principalId, true)!;
  const modelId = opaqueRequestIdentifier(request.modelId, false);
  const connectionId = opaqueRequestIdentifier(request.connectionId, false);
  return {
    principalType: request.principalType,
    principalId,
    ...(modelId ? { modelId } : {}),
    ...(connectionId ? { connectionId } : {}),
  };
}

function accessPostureRequestScope(request: AdminAccessPostureRequest): AdminAccessPostureRequestScope {
  return {
    principalId: request.principalId,
    ...(request.modelId ? { modelId: request.modelId } : {}),
    ...(request.connectionId ? { connectionId: request.connectionId } : {}),
  };
}

function integerValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

function reason(code: AdminReadinessReasonCode, message: string): AdminReadinessReason {
  return { code, message };
}

function coverage(
  included: number,
  total: number | null,
  complete: boolean,
  unit: string,
): AdminReadinessCoverage {
  return { included, total, complete, unit };
}

function documentation(label: string, url: string): AdminReadinessDocumentation[] {
  return [{ label, url }];
}

function cloneReport(report: AdminReadinessReport, servedFromCache: boolean): AdminReadinessReport {
  return { ...structuredClone(report), servedFromCache };
}

function tenantApiExplorerUrl(baseUrl: string): string {
  const url = new URL(baseUrl);
  url.pathname = '/api-explorer';
  url.search = '';
  url.hash = '';
  return url.toString().replace(/\/$/, '');
}

function cacheKey(input: AdminReadinessInput): string {
  const posture = input.accessPosture;
  return [
    input.instance.id,
    input.instance.updatedAt,
    input.workspace,
    posture?.principalType || '',
    posture?.principalId || '',
    posture?.modelId || '',
    posture?.connectionId || '',
  ].join('\u001f');
}

function sanitizePageLimit(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_MAX_COLLECTION_PAGES;
  return Math.min(25, Math.max(1, Math.floor(value!)));
}

function source(
  path: string,
  scope: 'collection' | 'resource' = 'collection',
): AdminReadinessSource {
  return { kind: 'omni_api', scope, method: 'GET', path };
}

function capability(
  input: Pick<AdminReadinessCapability, 'id' | 'label'> & Omit<AdminEvidenceEnvelope, never> & {
    data?: AdminReadinessCapability['data'];
    actions?: AdminReadinessAction[];
  },
): AdminReadinessCapability {
  return input;
}

function failureEvidence(
  error: unknown,
  scopeKind: 'collection' | 'resource',
): Pick<AdminEvidenceEnvelope, 'evidenceState' | 'readinessState' | 'reason'> {
  if (error instanceof AdminReadException) {
    if (error.code === 'invalid_json') {
      return {
        evidenceState: 'failed',
        readinessState: 'unknown',
        reason: reason('invalid_json', 'Omni returned a successful response that was not valid JSON.'),
      };
    }
    if (error.code === 'invalid_response_shape') {
      return {
        evidenceState: 'failed',
        readinessState: 'unknown',
        reason: reason('invalid_response_shape', 'Omni returned a successful response that did not match the documented response shape.'),
      };
    }
    if (error.code === 'request_timeout') {
      return {
        evidenceState: 'unavailable',
        readinessState: 'unknown',
        reason: reason('request_timeout', 'The read-only Omni request timed out.'),
      };
    }
    const status = error.status;
    if (status === 401) {
      return {
        evidenceState: 'unauthorized',
        readinessState: 'action_required',
        reason: reason('authentication_required', 'The saved credential was not accepted by Omni.'),
      };
    }
    if (status === 403) {
      return {
        evidenceState: 'unauthorized',
        readinessState: 'action_required',
        reason: reason('permission_denied', 'Omni denied permission for this documented read; credential type is not inferred.'),
      };
    }
    if (status === 404) {
      return scopeKind === 'collection'
        ? {
            evidenceState: 'unsupported',
            readinessState: 'unknown',
            reason: reason('collection_not_found', 'The documented collection endpoint was not found on this Omni instance.'),
          }
        : {
            evidenceState: 'unavailable',
            readinessState: 'unknown',
            reason: reason('resource_not_found', 'The requested Omni resource was not found.'),
          };
    }
    if (status === 405) {
      return {
        evidenceState: 'unsupported',
        readinessState: 'unknown',
        reason: reason('method_not_allowed', 'The Omni instance does not accept the documented GET operation.'),
      };
    }
    if (status === 410) {
      return {
        evidenceState: 'unsupported',
        readinessState: 'unknown',
        reason: reason('gone', 'The documented read operation is no longer available on this Omni instance.'),
      };
    }
    if (status !== undefined && status >= 300 && status < 400) {
      return {
        evidenceState: 'failed',
        readinessState: 'unknown',
        reason: reason('unexpected_redirect', 'Omni redirected the read-only API request; redirects are not accepted as capability evidence.'),
      };
    }
    if (status === 408) {
      return {
        evidenceState: 'unavailable',
        readinessState: 'unknown',
        reason: reason('request_timeout', 'Omni reported that the read-only request timed out.'),
      };
    }
    if (status === 429) {
      return {
        evidenceState: 'failed',
        readinessState: 'unknown',
        reason: reason('rate_limited', 'Omni rate-limited the bounded read-only request.'),
      };
    }
    if (status !== undefined && status >= 500) {
      return {
        evidenceState: 'unavailable',
        readinessState: 'unknown',
        reason: reason('upstream_failure', 'Omni could not complete the read-only request.'),
      };
    }
    if (status !== undefined && status >= 400) {
      return {
        evidenceState: 'failed',
        readinessState: 'unknown',
        reason: reason('request_rejected', 'Omni rejected the read-only request.'),
      };
    }
  }
  return {
    evidenceState: 'unavailable',
    readinessState: 'unknown',
    reason: reason('network_unavailable', 'The read-only Omni endpoint could not be reached safely.'),
  };
}

interface RequestContext {
  baseUrl: string;
  apiKey: string;
  fetchImpl: typeof fetch;
  assertSafeUrl: (url: string) => Promise<void>;
  timeoutMs: number;
  maxCollectionPages: number;
}

async function readBoundedJsonResponse(response: Response): Promise<unknown> {
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null) {
    if (!/^\d+$/.test(contentLength)) throw new AdminReadException('invalid_response_shape');
    const declaredBytes = Number(contentLength);
    if (!Number.isSafeInteger(declaredBytes) || declaredBytes > MAX_JSON_RESPONSE_BYTES) {
      throw new AdminReadException('invalid_response_shape');
    }
  }

  if (!response.body) throw new AdminReadException('invalid_json');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytesRead = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > MAX_JSON_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new AdminReadException('invalid_response_shape');
      }
      try {
        text += decoder.decode(value, { stream: true });
      } catch {
        throw new AdminReadException('invalid_json');
      }
    }
    try {
      text += decoder.decode();
      return JSON.parse(text) as unknown;
    } catch (error) {
      if (error instanceof AdminReadException) throw error;
      throw new AdminReadException('invalid_json');
    }
  } finally {
    reader.releaseLock();
  }
}

async function readJson(
  context: RequestContext,
  path: string,
  query: Record<string, string | number | undefined> = {},
): Promise<unknown> {
  const url = new URL(`${context.baseUrl.replace(/\/+$/, '')}${path}`);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), context.timeoutMs);
  try {
    await context.assertSafeUrl(url.toString());
    const response = await context.fetchImpl(url, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${context.apiKey}`,
        Accept: 'application/json',
      },
      redirect: 'manual',
      signal: controller.signal,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new AdminReadException(
        response.status >= 300 && response.status < 400 ? 'unexpected_redirect' : 'request_rejected',
        response.status,
      );
    }
    return await readBoundedJsonResponse(response);
  } catch (error) {
    if (error instanceof AdminReadException) throw error;
    if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
      throw new AdminReadException('request_timeout');
    }
    throw new AdminReadException('network_unavailable');
  } finally {
    clearTimeout(timeout);
  }
}

interface CollectionResult<T> {
  summary: T;
  included: number;
  total: number;
  complete: boolean;
  exclusions: string[];
}

interface CursorPage {
  records: JsonRecord[];
  hasNextPage: boolean;
  nextCursor: string | null;
  totalRecords: number;
}

function parseCursorPage(raw: unknown): CursorPage {
  if (!isRecord(raw) || !Array.isArray(raw.records) || !isRecord(raw.pageInfo)) {
    throw new AdminReadException('invalid_response_shape');
  }
  const records = raw.records.filter(isRecord);
  if (records.length !== raw.records.length) throw new AdminReadException('invalid_response_shape');
  const hasNextPage = raw.pageInfo.hasNextPage;
  const pageSize = integerValue(raw.pageInfo.pageSize);
  const totalRecords = integerValue(raw.pageInfo.totalRecords);
  if (
    typeof hasNextPage !== 'boolean'
    || pageSize === undefined
    || pageSize < 1
    || pageSize > 100
    || totalRecords === undefined
    || records.length > pageSize
    || records.length > totalRecords
    || (records.length === 0 && (hasNextPage || totalRecords > 0))
  ) {
    throw new AdminReadException('invalid_response_shape');
  }
  const nextValue = raw.pageInfo.nextCursor;
  let nextCursor: string | null = null;
  if (hasNextPage) {
    const normalized = typeof nextValue === 'string'
      ? stringValue(nextValue, 500)
      : Number.isSafeInteger(nextValue) && (nextValue as number) >= 0
        ? String(nextValue)
        : undefined;
    if (!normalized) throw new AdminReadException('invalid_response_shape');
    nextCursor = normalized;
  } else if (nextValue !== null && nextValue !== undefined) {
    throw new AdminReadException('invalid_response_shape');
  }
  return { records, hasNextPage, nextCursor, totalRecords };
}

async function collectCursor<T>(options: {
  context: RequestContext;
  path: string;
  initial: T;
  consume: (summary: T, row: JsonRecord) => boolean;
  key: (row: JsonRecord) => string | undefined;
  cursorMode?: 'cursor' | 'page';
}): Promise<CollectionResult<T>> {
  const seen = new Set<string>();
  const seenCursors = new Set<string>();
  const exclusions = new Set<string>();
  let included = 0;
  let expectedTotal: number | undefined;
  let cursor: string | number | undefined;
  let completed = false;

  for (let pageNumber = 1; pageNumber <= options.context.maxCollectionPages; pageNumber += 1) {
    let page: CursorPage;
    try {
      page = parseCursorPage(await readJson(options.context, options.path, {
        pageSize: 100,
        cursor: options.cursorMode === 'page' ? pageNumber : cursor,
      }));
    } catch (error) {
      if (pageNumber === 1) throw error;
      const mapped = failureEvidence(error, 'collection');
      exclusions.add(`subsequent_page_${mapped.reason.code}`);
      break;
    }

    if (expectedTotal === undefined) expectedTotal = page.totalRecords;
    else if (expectedTotal !== page.totalRecords) {
      expectedTotal = Math.max(expectedTotal, page.totalRecords);
      exclusions.add('collection_total_changed_during_read');
    }

    for (const row of page.records) {
      const key = options.key(row);
      if (!key) {
        exclusions.add('invalid_records_excluded');
        continue;
      }
      if (seen.has(key)) {
        exclusions.add('duplicate_records_excluded');
        continue;
      }
      seen.add(key);
      if (options.consume(options.initial, row)) included += 1;
      else exclusions.add('invalid_records_excluded');
    }

    if (!page.hasNextPage) {
      completed = true;
      break;
    }
    if (options.cursorMode !== 'page') {
      if (!page.nextCursor || seenCursors.has(page.nextCursor)) {
        exclusions.add('pagination_cursor_invalid');
        break;
      }
      seenCursors.add(page.nextCursor);
      cursor = page.nextCursor;
    }
    if (pageNumber === options.context.maxCollectionPages) {
      exclusions.add('collection_page_limit_reached');
    }
  }

  const total = expectedTotal ?? included;
  const complete = completed && included === total && exclusions.size === 0;
  if (completed && included !== total) exclusions.add('collection_count_not_reconciled');
  return {
    summary: options.initial,
    included,
    total,
    complete,
    exclusions: [...exclusions],
  };
}

interface ScimPage {
  resources: JsonRecord[];
  itemsPerPage: number;
  startIndex: number;
  totalResults: number;
}

function parseScimPage(raw: unknown): ScimPage {
  if (!isRecord(raw) || !Array.isArray(raw.Resources)) {
    throw new AdminReadException('invalid_response_shape');
  }
  const resources = raw.Resources.filter(isRecord);
  const itemsPerPage = integerValue(raw.itemsPerPage);
  const startIndex = integerValue(raw.startIndex);
  const totalResults = integerValue(raw.totalResults);
  if (
    resources.length !== raw.Resources.length
    || itemsPerPage === undefined
    || itemsPerPage !== resources.length
    || itemsPerPage > 100
    || startIndex === undefined
    || startIndex < 1
    || totalResults === undefined
    || (totalResults === 0 && (startIndex !== 1 || resources.length !== 0))
    || (totalResults > 0 && (
      resources.length === 0
      || startIndex > totalResults
      || startIndex + resources.length - 1 > totalResults
    ))
  ) {
    throw new AdminReadException('invalid_response_shape');
  }
  return { resources, itemsPerPage, startIndex, totalResults };
}

async function collectScim<T>(options: {
  context: RequestContext;
  path: string;
  initial: T;
  consume: (summary: T, row: JsonRecord) => boolean;
  key: (row: JsonRecord) => string | undefined;
}): Promise<CollectionResult<T>> {
  const seen = new Set<string>();
  const exclusions = new Set<string>();
  let included = 0;
  let expectedTotal: number | undefined;
  let startIndex = 1;
  let completed = false;

  for (let pageNumber = 1; pageNumber <= options.context.maxCollectionPages; pageNumber += 1) {
    let page: ScimPage;
    try {
      page = parseScimPage(await readJson(options.context, options.path, { count: 100, startIndex }));
    } catch (error) {
      if (pageNumber === 1) throw error;
      const mapped = failureEvidence(error, 'collection');
      exclusions.add(`subsequent_page_${mapped.reason.code}`);
      break;
    }
    if (page.startIndex !== startIndex) {
      exclusions.add('pagination_start_index_mismatch');
      break;
    }
    if (expectedTotal === undefined) expectedTotal = page.totalResults;
    else if (expectedTotal !== page.totalResults) {
      expectedTotal = Math.max(expectedTotal, page.totalResults);
      exclusions.add('collection_total_changed_during_read');
    }

    for (const row of page.resources) {
      const key = options.key(row);
      if (!key) {
        exclusions.add('invalid_records_excluded');
        continue;
      }
      if (seen.has(key)) {
        exclusions.add('duplicate_records_excluded');
        continue;
      }
      seen.add(key);
      if (options.consume(options.initial, row)) included += 1;
      else exclusions.add('invalid_records_excluded');
    }

    if (included >= page.totalResults) {
      completed = true;
      break;
    }
    if (page.resources.length === 0 || page.itemsPerPage === 0) {
      exclusions.add('pagination_ended_before_total');
      break;
    }
    startIndex += page.itemsPerPage;
    if (pageNumber === options.context.maxCollectionPages) {
      exclusions.add('collection_page_limit_reached');
    }
  }

  const total = expectedTotal ?? included;
  const complete = completed && included === total && exclusions.size === 0;
  if (completed && included !== total) exclusions.add('collection_count_not_reconciled');
  return {
    summary: options.initial,
    included,
    total,
    complete,
    exclusions: [...exclusions],
  };
}

function evidenceForCollection(
  result: Pick<CollectionResult<unknown>, 'complete' | 'included' | 'total' | 'exclusions'>,
): Pick<AdminEvidenceEnvelope, 'evidenceState' | 'reason' | 'coverage' | 'exclusions'> {
  return result.complete
    ? {
        evidenceState: 'available',
        reason: reason(result.total === 0 ? 'not_configured' : 'ok', result.total === 0
          ? 'The documented collection is available and contains no records.'
          : 'The documented collection was read to a reconciled terminal page.'),
        coverage: coverage(result.included, result.total, true, 'records'),
        exclusions: [],
      }
    : {
        evidenceState: 'partial',
        reason: reason('partial_coverage', 'The documented collection was only partially reconciled; displayed counts are bounded observations.'),
        coverage: coverage(result.included, result.total, false, 'records'),
        exclusions: result.exclusions,
      };
}

function failedCapability(options: {
  id: AdminReadinessCapability['id'];
  label: string;
  source: AdminReadinessSource;
  checkedAt: string;
  docsLabel: string;
  docsUrl: string;
  error: unknown;
}): AdminReadinessCapability {
  return capability({
    id: options.id,
    label: options.label,
    ...failureEvidence(options.error, options.source.scope === 'resource' ? 'resource' : 'collection'),
    source: options.source,
    checkedAt: options.checkedAt,
    coverage: coverage(0, null, false, 'records'),
    exclusions: ['upstream_evidence_unavailable'],
    documentation: documentation(options.docsLabel, options.docsUrl),
  });
}

async function folderReadCapability(context: RequestContext, checkedAt: string): Promise<AdminReadinessCapability> {
  const capabilitySource = source('/api/v1/folders');
  try {
    const page = parseCursorPage(await readJson(context, '/api/v1/folders', { pageSize: 1 }));
    return capability({
      id: 'fleet.folder_read',
      label: 'Folder read visibility',
      evidenceState: 'available',
      readinessState: 'ready',
      reason: reason('ok', 'The saved credential can read the documented folders collection; the displayed count is a permission-filtered lower bound.'),
      source: capabilitySource,
      checkedAt,
      coverage: coverage(page.records.length, null, false, 'visible_folders'),
      exclusions: ['lower_bound_probe_only', 'credential_permission_filtered_visibility'],
      documentation: documentation('List folders', DOCS.folders),
      data: { readable: true, visibleFoldersLowerBound: page.records.length },
    });
  } catch (error) {
    return failedCapability({
      id: 'fleet.folder_read',
      label: 'Folder read visibility',
      source: capabilitySource,
      checkedAt,
      docsLabel: 'List folders',
      docsUrl: DOCS.folders,
      error,
    });
  }
}

interface ApiTokenSummary {
  total: number;
  organization: number;
  personal: number;
  mcp: number;
  other: number;
  enabled: number;
  disabled: number;
}

async function apiTokenCapability(context: RequestContext, checkedAt: string): Promise<AdminReadinessCapability> {
  const capabilitySource = source('/api/v1/api-keys');
  try {
    const result = await collectCursor<ApiTokenSummary>({
      context,
      path: '/api/v1/api-keys',
      initial: { total: 0, organization: 0, personal: 0, mcp: 0, other: 0, enabled: 0, disabled: 0 },
      key: (row) => stringValue(row.id),
      consume: (summary, row) => {
        const type = stringValue(row.type)?.toLowerCase();
        if (!type || typeof row.enabled !== 'boolean') return false;
        summary.total += 1;
        if (type === 'organization') summary.organization += 1;
        else if (type === 'personal') summary.personal += 1;
        else if (type === 'mcp') summary.mcp += 1;
        else summary.other += 1;
        if (row.enabled) summary.enabled += 1;
        else summary.disabled += 1;
        return true;
      },
    });
    const evidence = evidenceForCollection(result);
    return capability({
      id: 'fleet.api_tokens',
      label: 'API token inventory',
      ...evidence,
      readinessState: result.complete
        ? result.total === 0 ? 'not_configured' : 'ready'
        : 'unknown',
      source: capabilitySource,
      checkedAt,
      documentation: documentation('List API tokens', DOCS.apiTokens),
      data: { ...result.summary },
    });
  } catch (error) {
    return failedCapability({
      id: 'fleet.api_tokens',
      label: 'API token inventory',
      source: capabilitySource,
      checkedAt,
      docsLabel: 'List API tokens',
      docsUrl: DOCS.apiTokens,
      error,
    });
  }
}

function organizationApiKeyConfirmationCapability(
  confirmed: boolean | undefined,
  checkedAt: string,
): AdminReadinessCapability {
  return capability({
    id: 'fleet.organization_api_key_confirmation',
    label: 'Organization API key confirmation',
    evidenceState: confirmed === true ? 'available' : 'not_checked',
    readinessState: confirmed === true ? 'ready' : 'action_required',
    reason: confirmed === true
      ? reason('operator_confirmed', 'An operator explicitly confirmed that this saved credential is an Organization API key.')
      : reason('operator_confirmation_missing', 'No operator confirmation is stored for the saved credential type.'),
    source: { kind: 'operator_confirmation', scope: 'saved_setting' },
    checkedAt,
    coverage: coverage(confirmed === true ? 1 : 0, 1, confirmed === true, 'operator_confirmations'),
    exclusions: ['operator_attestation_separate_from_live_whoami_scope'],
    documentation: documentation('API authentication', DOCS.authentication),
    data: { confirmed: confirmed === true },
  });
}

interface CurrentCallerSummary {
  keyScope: 'user' | 'organization';
  orgRole: 'MEMBER' | 'ORG_ADMIN';
  returnedModelCount: number;
  returnedPermissionCount: number;
  rolesByModelTruncated: boolean;
}

function parseCurrentCallerSummary(raw: unknown): CurrentCallerSummary {
  if (
    !isRecord(raw)
    || Object.prototype.hasOwnProperty.call(raw, 'error')
    || Object.prototype.hasOwnProperty.call(raw, 'errors')
    || raw.ok === false
    || raw.success === false
    || (raw.keyScope !== 'user' && raw.keyScope !== 'organization')
    || (raw.orgRole !== 'MEMBER' && raw.orgRole !== 'ORG_ADMIN')
    || !isRecord(raw.user)
    || !stringValue(raw.user.id)
    || !stringValue(raw.user.membershipId)
    || !isRecord(raw.rolesByModel)
    || Object.keys(raw.rolesByModel).length > MAX_DIRECT_RECORDS
    || (raw.rolesByModelTruncated !== undefined && typeof raw.rolesByModelTruncated !== 'boolean')
  ) {
    throw new AdminReadException('invalid_response_shape');
  }

  let returnedPermissionCount = 0;
  for (const [modelId, role] of Object.entries(raw.rolesByModel)) {
    if (!stringValue(modelId) || !isRecord(role) || !Array.isArray(role.permissions)) {
      throw new AdminReadException('invalid_response_shape');
    }
    if (role.permissions.length > MAX_DIRECT_RECORDS) {
      throw new AdminReadException('invalid_response_shape');
    }
    for (const permission of role.permissions) {
      if (!stringValue(permission, 200)) throw new AdminReadException('invalid_response_shape');
    }
    returnedPermissionCount += role.permissions.length;
    if (!Number.isSafeInteger(returnedPermissionCount) || returnedPermissionCount > MAX_DIRECT_RECORDS * MAX_DIRECT_RECORDS) {
      throw new AdminReadException('invalid_response_shape');
    }
  }

  return {
    keyScope: raw.keyScope,
    orgRole: raw.orgRole,
    returnedModelCount: Object.keys(raw.rolesByModel).length,
    returnedPermissionCount,
    rolesByModelTruncated: raw.rolesByModelTruncated === true,
  };
}

async function currentTokenIntrospectionCapability(
  context: RequestContext,
  checkedAt: string,
): Promise<AdminReadinessCapability> {
  const capabilitySource = source('/api/v1/whoami', 'resource');
  try {
    const summary = parseCurrentCallerSummary(await readJson(context, '/api/v1/whoami'));
    const complete = !summary.rolesByModelTruncated;
    return capability({
      id: 'fleet.current_token_introspection',
      label: 'Current caller permissions',
      evidenceState: complete ? 'available' : 'partial',
      readinessState: complete ? 'ready' : 'unknown',
      reason: complete
        ? reason('ok', 'Omni returned the documented current-caller scope and a complete model-permission projection.')
        : reason('partial_coverage', 'Omni returned the documented current-caller scope, but its model-permission projection was truncated.'),
      source: capabilitySource,
      checkedAt,
      coverage: coverage(
        summary.returnedModelCount,
        complete ? summary.returnedModelCount : null,
        complete,
        'model_permission_sets',
      ),
      exclusions: [
        'caller_user_id',
        'caller_membership_id',
        'model_ids',
        'role_names',
        'permission_values',
        ...(complete ? [] : ['model_permission_sets_outside_response_limit']),
      ],
      documentation: documentation('Get current identity and permissions', DOCS.whoami),
      data: { ...summary },
    });
  } catch (error) {
    return failedCapability({
      id: 'fleet.current_token_introspection',
      label: 'Current caller permissions',
      source: capabilitySource,
      checkedAt,
      docsLabel: 'Get current identity and permissions',
      docsUrl: DOCS.whoami,
      error,
    });
  }
}

interface UserAggregate {
  total: number;
  active: number;
  inactive: number;
  statusUnknown: number;
}

function consumeUserAggregate(summary: UserAggregate, row: JsonRecord): boolean {
  summary.total += 1;
  if (row.active === true) summary.active += 1;
  else if (row.active === false) summary.inactive += 1;
  else summary.statusUnknown += 1;
  return true;
}

async function scimUserCapability(
  context: RequestContext,
  checkedAt: string,
  options: {
    id: 'identity.scim_users' | 'developer.embed_users';
    label: string;
    path: '/api/scim/v2/users' | '/api/scim/v2/embed/users';
    docsLabel: string;
    docsUrl: string;
    key: (row: JsonRecord) => string | undefined;
  },
): Promise<AdminReadinessCapability> {
  const capabilitySource = source(options.path);
  try {
    const result = await collectScim<UserAggregate>({
      context,
      path: options.path,
      initial: { total: 0, active: 0, inactive: 0, statusUnknown: 0 },
      key: options.key,
      consume: consumeUserAggregate,
    });
    const evidence = evidenceForCollection(result);
    return capability({
      id: options.id,
      label: options.label,
      ...evidence,
      readinessState: result.complete
        ? result.total === 0 ? 'not_configured' : result.summary.statusUnknown > 0 ? 'unknown' : 'ready'
        : 'unknown',
      source: capabilitySource,
      checkedAt,
      documentation: documentation(options.docsLabel, options.docsUrl),
      data: { ...result.summary },
    });
  } catch (error) {
    return failedCapability({
      id: options.id,
      label: options.label,
      source: capabilitySource,
      checkedAt,
      docsLabel: options.docsLabel,
      docsUrl: options.docsUrl,
      error,
    });
  }
}

async function scimGroupCapability(context: RequestContext, checkedAt: string): Promise<AdminReadinessCapability> {
  const capabilitySource = source('/api/scim/v2/groups');
  try {
    const result = await collectScim<{ total: number }>({
      context,
      path: '/api/scim/v2/groups',
      initial: { total: 0 },
      key: (row) => stringValue(row.id),
      consume: (summary) => {
        summary.total += 1;
        return true;
      },
    });
    const evidence = evidenceForCollection(result);
    return capability({
      id: 'identity.scim_groups',
      label: 'SCIM user groups',
      ...evidence,
      readinessState: result.complete
        ? result.total === 0 ? 'not_configured' : 'ready'
        : 'unknown',
      source: capabilitySource,
      checkedAt,
      documentation: documentation('List user groups', DOCS.groups),
      data: { ...result.summary },
    });
  } catch (error) {
    return failedCapability({
      id: 'identity.scim_groups',
      label: 'SCIM user groups',
      source: capabilitySource,
      checkedAt,
      docsLabel: 'List user groups',
      docsUrl: DOCS.groups,
      error,
    });
  }
}

async function userAttributeCapability(context: RequestContext, checkedAt: string): Promise<AdminReadinessCapability> {
  const capabilitySource = source('/api/v1/user-attributes');
  try {
    const raw = await readJson(context, '/api/v1/user-attributes');
    if (!isRecord(raw) || !Array.isArray(raw.records) || raw.records.length > MAX_DIRECT_RECORDS) {
      throw new AdminReadException('invalid_response_shape');
    }
    const safeDefinitions: Array<Record<string, unknown>> = [];
    let invalid = 0;
    for (const item of raw.records) {
      if (!isRecord(item)) {
        invalid += 1;
        continue;
      }
      const name = stringValue(item.name, 200);
      if (!name || typeof item.multiple_values !== 'boolean' || typeof item.system !== 'boolean') {
        invalid += 1;
        continue;
      }
      const definition: Record<string, unknown> = {
        name,
        multiple: item.multiple_values,
        system: item.system,
        hasDefault: 'default_value' in item && item.default_value !== null && item.default_value !== undefined,
        hasDescription: typeof item.description === 'string' && item.description.trim().length > 0,
      };
      const label = stringValue(item.label, 200);
      const type = stringValue(item.type, 120);
      if (label) definition.label = label;
      if (type) definition.type = type;
      safeDefinitions.push(definition);
    }
    safeDefinitions.sort((left, right) => String(left.name).localeCompare(String(right.name)));
    const complete = invalid === 0;
    return capability({
      id: 'identity.user_attributes',
      label: 'User attribute definitions',
      evidenceState: complete ? 'available' : 'partial',
      readinessState: complete
        ? safeDefinitions.length === 0 ? 'not_configured' : 'ready'
        : 'unknown',
      reason: complete
        ? reason(safeDefinitions.length === 0 ? 'not_configured' : 'ok', safeDefinitions.length === 0
          ? 'The documented user-attribute collection is available and contains no definitions.'
          : 'User-attribute definitions were read and reduced to non-sensitive schema metadata.')
        : reason('partial_coverage', 'Some user-attribute definitions did not match the documented response shape and were excluded.'),
      source: capabilitySource,
      checkedAt,
      coverage: coverage(safeDefinitions.length, raw.records.length, complete, 'attribute_definitions'),
      exclusions: [
        'attribute_ids',
        'default_values',
        'description_text',
        ...(complete ? [] : ['invalid_records_excluded']),
      ],
      documentation: documentation('List user attributes', DOCS.userAttributes),
      data: safeDefinitions,
    });
  } catch (error) {
    return failedCapability({
      id: 'identity.user_attributes',
      label: 'User attribute definitions',
      source: capabilitySource,
      checkedAt,
      docsLabel: 'List user attributes',
      docsUrl: DOCS.userAttributes,
      error,
    });
  }
}

const ROLE_EMAIL_PATTERN = /[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+/i;
const ROLE_SECRET_ASSIGNMENT_PATTERN = /\b(?:api[_ -]?key|authorization|token|secret|password|signature)\b\s*[:=]\s*\S+/i;
const ROLE_BEARER_PATTERN = /\bbearer\s+\S+/i;
const ROLE_URL_PATTERN = /(?:https?:\/\/|[?&](?:api[_-]?key|authorization|token|secret|password|signature)=)/i;

function safeRoleString(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim();
  if (
    !normalized
    || normalized.length > maxLength
    || hasAsciiControlCharacter(normalized)
    || ROLE_EMAIL_PATTERN.test(normalized)
    || ROLE_SECRET_ASSIGNMENT_PATTERN.test(normalized)
    || ROLE_BEARER_PATTERN.test(normalized)
    || ROLE_URL_PATTERN.test(normalized)
  ) return undefined;
  return normalized;
}

function parseRoleEvidence(raw: unknown): AdminModelRoleEvidence | null {
  if (!isRecord(raw)) return null;
  const roleName = safeRoleString(raw.roleName, 160);
  if (!roleName) return null;
  const role: AdminModelRoleEvidence = { roleName };
  if (raw.baseRole !== undefined) {
    const baseRole = safeRoleString(raw.baseRole, 160);
    if (!baseRole) return null;
    role.baseRole = baseRole;
  }
  if (raw.connectionId !== undefined) {
    const connectionId = safeRoleString(raw.connectionId, 240);
    if (!connectionId) return null;
    role.connectionId = connectionId;
  }
  if (raw.modelId !== undefined) {
    const modelId = safeRoleString(raw.modelId, 240);
    if (!modelId) return null;
    role.modelId = modelId;
  }
  if (raw.priority !== undefined) {
    if (typeof raw.priority !== 'number' || !Number.isFinite(raw.priority)) return null;
    role.priority = raw.priority;
  }
  if (raw.resolved !== undefined) {
    if (typeof raw.resolved !== 'boolean') return null;
    role.resolved = raw.resolved;
  }
  if (raw.from !== undefined) {
    if (!isRecord(raw.from)) return null;
    const provenance: NonNullable<AdminModelRoleEvidence['provenance']> = {};
    if (raw.from.type !== undefined) {
      const type = safeRoleString(raw.from.type, 120);
      if (!type) return null;
      provenance.type = type;
    }
    if (raw.from.name !== undefined) {
      const name = safeRoleString(raw.from.name, 200);
      if (!name) return null;
      provenance.name = name;
    }
    if (raw.from.depth !== undefined) {
      const depth = integerValue(raw.from.depth);
      if (depth === undefined) return null;
      provenance.depth = depth;
    }
    if (Object.keys(provenance).length > 0) role.provenance = provenance;
  }
  return role;
}

async function accessPosture(
  context: RequestContext,
  checkedAt: string,
  request: AdminAccessPostureRequest,
): Promise<AdminAccessPosture> {
  const isUser = request.principalType === 'user';
  const requestScope = accessPostureRequestScope(request);
  const path = isUser
    ? `/api/v1/users/${encodeURIComponent(request.principalId)}/model-roles`
    : `/api/v1/user-groups/${encodeURIComponent(request.principalId)}/model-roles`;
  const sourcePath = isUser
    ? '/api/v1/users/:userId/model-roles'
    : '/api/v1/user-groups/:userGroupId/model-roles';
  const docsUrl = isUser ? DOCS.userRoles : DOCS.groupRoles;
  const docsLabel = isUser ? 'Retrieve user model roles' : 'Retrieve user group model roles';
  try {
    const raw = await readJson(context, path, {
      modelId: request.modelId,
      connectionId: request.connectionId,
    });
    if (!isRecord(raw) || !Array.isArray(raw.results) || raw.results.length > MAX_DIRECT_RECORDS) {
      throw new AdminReadException('invalid_response_shape');
    }
    const roles = raw.results.map(parseRoleEvidence).filter((role): role is AdminModelRoleEvidence => Boolean(role));
    const complete = roles.length === raw.results.length;
    const rolesWithProvenance = roles.filter((role) => role.provenance !== undefined).length;
    return {
      id: isUser ? 'identity.user_model_roles' : 'identity.group_model_roles',
      principalType: request.principalType,
      requestScope,
      evidenceState: complete ? 'available' : 'partial',
      readinessState: complete
        ? roles.length === 0 ? 'not_configured' : 'ready'
        : 'unknown',
      reason: complete
        ? reason(roles.length === 0 ? 'not_configured' : 'ok', roles.length === 0
          ? 'The principal has no model-role evidence for the requested scope.'
          : rolesWithProvenance === roles.length
            ? 'Model-role assignments and their returned provenance were read from the documented role endpoint.'
            : rolesWithProvenance > 0
              ? 'Model-role assignments were returned by the documented role endpoint; provenance was present for only some assignments.'
              : 'Model-role assignments were returned by the documented role endpoint; assignment provenance was not returned and is not claimed.')
        : reason('partial_coverage', 'Some role entries did not match the documented response shape and were excluded.'),
      source: source(sourcePath, 'resource'),
      checkedAt,
      coverage: coverage(roles.length, raw.results.length, complete, 'model_roles'),
      exclusions: ['membership_id', ...(complete ? [] : ['unsafe_or_invalid_role_entries_excluded'])],
      documentation: documentation(docsLabel, docsUrl),
      roles,
    };
  } catch (error) {
    return {
      id: isUser ? 'identity.user_model_roles' : 'identity.group_model_roles',
      principalType: request.principalType,
      requestScope,
      roles: [],
      ...failureEvidence(error, 'resource'),
      source: source(sourcePath, 'resource'),
      checkedAt,
      coverage: coverage(0, null, false, 'model_roles'),
      exclusions: ['membership_id', 'upstream_evidence_unavailable'],
      documentation: documentation(docsLabel, docsUrl),
    };
  }
}

interface ScheduleSummary {
  total: number;
  active: number;
  paused: number;
  systemDisabled: number;
  lastStatus: {
    success: number;
    error: number;
    canceled: number;
    none: number;
    unknown: number;
  };
  latestObservedAt: string | null;
}

function nullableScheduleTimestamp(value: unknown): { valid: boolean; value: string | null } {
  if (value === undefined || value === null) return { valid: true, value: null };
  if (typeof value !== 'string' || !value.trim() || !Number.isFinite(Date.parse(value))) {
    return { valid: false, value: null };
  }
  return { valid: true, value: new Date(value).toISOString() };
}

function consumeSchedule(summary: ScheduleSummary, row: JsonRecord): boolean {
  const disabledAt = nullableScheduleTimestamp(row.disabledAt);
  const systemDisabledAt = nullableScheduleTimestamp(row.systemDisabledAt);
  const completedAt = nullableScheduleTimestamp(row.lastCompletedAt);
  if (!disabledAt.valid || !systemDisabledAt.valid || !completedAt.valid) return false;

  let status: string | null = null;
  if (row.lastStatus !== undefined && row.lastStatus !== null) {
    if (typeof row.lastStatus !== 'string' || !row.lastStatus.trim()) return false;
    status = row.lastStatus.trim().toLowerCase();
  }

  summary.total += 1;
  const paused = disabledAt.value !== null;
  const systemDisabled = systemDisabledAt.value !== null;
  if (paused) summary.paused += 1;
  if (systemDisabled) summary.systemDisabled += 1;
  if (!paused && !systemDisabled) summary.active += 1;

  if (status === 'success' || status === 'complete' || status === 'completed') summary.lastStatus.success += 1;
  else if (status === 'error' || status === 'failed' || status === 'failure') summary.lastStatus.error += 1;
  else if (status === 'canceled' || status === 'cancelled') summary.lastStatus.canceled += 1;
  else if (!status || status === 'none') summary.lastStatus.none += 1;
  else summary.lastStatus.unknown += 1;

  if (completedAt.value && (!summary.latestObservedAt || completedAt.value > summary.latestObservedAt)) {
    summary.latestObservedAt = completedAt.value;
  }
  return true;
}

async function scheduleCapability(context: RequestContext, checkedAt: string): Promise<AdminReadinessCapability> {
  const capabilitySource = source('/api/v1/schedules');
  try {
    const result = await collectCursor<ScheduleSummary>({
      context,
      path: '/api/v1/schedules',
      cursorMode: 'page',
      initial: {
        total: 0,
        active: 0,
        paused: 0,
        systemDisabled: 0,
        lastStatus: { success: 0, error: 0, canceled: 0, none: 0, unknown: 0 },
        latestObservedAt: null,
      },
      key: (row) => stringValue(row.id),
      consume: consumeSchedule,
    });
    const evidence = evidenceForCollection(result);
    const readinessState: AdminReadinessState = !result.complete
      ? 'unknown'
      : result.total === 0
        ? 'not_configured'
        : result.summary.systemDisabled > 0 || result.summary.lastStatus.error > 0
          ? 'action_required'
          : result.summary.lastStatus.unknown > 0
            ? 'unknown'
            : 'ready';
    return capability({
      id: 'content.schedules',
      label: 'Schedule delivery evidence',
      ...evidence,
      readinessState,
      reason: result.complete && result.total > 0
        ? reason('ok', 'Schedule counts and each schedule\'s latest documented delivery status were collected; this is not a historical reliability rate.')
        : evidence.reason,
      source: capabilitySource,
      checkedAt,
      documentation: documentation('List schedules', DOCS.schedules),
      exclusions: [...evidence.exclusions, 'delivery_history_before_latest_status', 'recipient_details', 'schedule_names_and_ids'],
      data: {
        total: result.summary.total,
        active: result.summary.active,
        paused: result.summary.paused,
        systemDisabled: result.summary.systemDisabled,
        lastStatus: { ...result.summary.lastStatus },
        latestObservedAt: result.summary.latestObservedAt,
      },
    });
  } catch (error) {
    return failedCapability({
      id: 'content.schedules',
      label: 'Schedule delivery evidence',
      source: capabilitySource,
      checkedAt,
      docsLabel: 'List schedules',
      docsUrl: DOCS.schedules,
      error,
    });
  }
}

function unsupportedConfigurationCapability(options: {
  id: 'developer.sso_configuration' | 'developer.audit_configuration';
  label: string;
  checkedAt: string;
  message: string;
  docsLabel: string;
  docsUrl: string;
  actionLabel: string;
}): AdminReadinessCapability {
  return capability({
    id: options.id,
    label: options.label,
    evidenceState: 'unsupported',
    readinessState: 'action_required',
    reason: reason('no_documented_read_api', options.message),
    source: { kind: 'official_documentation', scope: 'manual_action' },
    checkedAt: options.checkedAt,
    coverage: coverage(0, 1, false, 'configuration_checks'),
    exclusions: ['configuration_state_not_available_through_documented_get_api'],
    documentation: documentation(options.docsLabel, options.docsUrl),
    actions: [{ kind: 'documentation', label: options.actionLabel, url: options.docsUrl }],
  });
}

function apiExplorerCapability(baseUrl: string, checkedAt: string): AdminReadinessCapability {
  return capability({
    id: 'developer.api_explorer',
    label: 'API Explorer',
    evidenceState: 'not_checked',
    readinessState: 'unknown',
    reason: reason('manual_action_only', 'The documented tenant API Explorer is offered as a safe manual deep link and is not probed as readiness evidence.'),
    source: { kind: 'official_documentation', scope: 'manual_action' },
    checkedAt,
    coverage: coverage(0, 1, false, 'manual_actions'),
    exclusions: ['api_explorer_availability_not_probed', 'openapi_spec_not_downloaded'],
    documentation: documentation('API Explorer', DOCS.apiExplorer),
    actions: [
      { kind: 'tenant_deep_link', label: 'Open API Explorer', url: tenantApiExplorerUrl(baseUrl) },
      { kind: 'documentation', label: 'Review API Explorer documentation', url: DOCS.apiExplorer },
    ],
  });
}

async function runBounded<T>(tasks: Array<() => Promise<T>>, limit = 2): Promise<T[]> {
  const results = new Array<T>(tasks.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, async () => {
    while (next < tasks.length) {
      const index = next;
      next += 1;
      results[index] = await tasks[index]();
    }
  });
  await Promise.all(workers);
  return results;
}

async function buildReport(
  input: AdminReadinessInput,
  context: RequestContext,
  checkedAt: string,
): Promise<AdminReadinessReport> {
  let capabilities: AdminReadinessCapability[];
  let posture: AdminAccessPosture | undefined;

  if (input.workspace === 'fleet') {
    const live = await runBounded([
      () => folderReadCapability(context, checkedAt),
      () => apiTokenCapability(context, checkedAt),
      () => currentTokenIntrospectionCapability(context, checkedAt),
    ]);
    capabilities = [
      live[0],
      live[1],
      organizationApiKeyConfirmationCapability(input.instance.organizationApiKeyConfirmed, checkedAt),
      live[2],
    ];
  } else if (input.workspace === 'identity') {
    if (input.accessPosture) {
      capabilities = [];
      posture = await accessPosture(context, checkedAt, input.accessPosture);
    } else {
      capabilities = await runBounded([
        () => scimUserCapability(context, checkedAt, {
          id: 'identity.scim_users',
          label: 'SCIM users',
          path: '/api/scim/v2/users',
          docsLabel: 'List users',
          docsUrl: DOCS.users,
          key: (row) => stringValue(row.id),
        }),
        () => scimGroupCapability(context, checkedAt),
        () => userAttributeCapability(context, checkedAt),
      ]);
    }
  } else if (input.workspace === 'content') {
    capabilities = [await scheduleCapability(context, checkedAt)];
  } else {
    const embedUsers = await scimUserCapability(context, checkedAt, {
      id: 'developer.embed_users',
      label: 'Embed users',
      path: '/api/scim/v2/embed/users',
      docsLabel: 'List embed users',
      docsUrl: DOCS.embedUsers,
      key: (row) => stringValue(row.id) || stringValue(row.embedExternalId),
    });
    capabilities = [
      embedUsers,
      unsupportedConfigurationCapability({
        id: 'developer.sso_configuration',
        label: 'Embed SSO configuration',
        checkedAt,
        message: 'Omni documents SSO setup and generation operations, but no documented GET operation exposes the tenant SSO configuration for readiness inspection.',
        docsLabel: 'Standard SSO setup',
        docsUrl: DOCS.embedSso,
        actionLabel: 'Review standard SSO setup',
      }),
      unsupportedConfigurationCapability({
        id: 'developer.audit_configuration',
        label: 'Audit log configuration',
        checkedAt,
        message: 'Omni documents audit-log delivery setup, but no documented GET operation exposes the tenant audit-log configuration for readiness inspection.',
        docsLabel: 'Audit logs',
        docsUrl: DOCS.auditLogs,
        actionLabel: 'Review audit log setup',
      }),
      apiExplorerCapability(input.instance.baseUrl, checkedAt),
    ];
  }

  return {
    schemaVersion: 1,
    instanceId: input.instance.id,
    workspace: input.workspace,
    checkedAt,
    servedFromCache: false,
    capabilities,
    ...(posture ? { accessPosture: posture } : {}),
  };
}

function dynamicEvidenceStates(report: AdminReadinessReport): AdminEvidenceState[] {
  const states = report.capabilities
    .filter((entry) => entry.source.kind === 'omni_api')
    .map((entry) => entry.evidenceState);
  if (report.accessPosture?.source.kind === 'omni_api') states.push(report.accessPosture.evidenceState);
  return states;
}

function shouldUseStale(previous: AdminReadinessReport, refreshed: AdminReadinessReport): boolean {
  const oldStates = dynamicEvidenceStates(previous);
  const newStates = dynamicEvidenceStates(refreshed);
  return oldStates.some((state) => state === 'available' || state === 'partial')
    && newStates.length > 0
    && newStates.every((state) => state === 'failed' || state === 'unavailable');
}

function staleEnvelope<T extends AdminEvidenceEnvelope>(entry: T): T {
  if (entry.source.kind !== 'omni_api' || !['available', 'partial'].includes(entry.evidenceState)) {
    return structuredClone(entry);
  }
  return {
    ...structuredClone(entry),
    evidenceState: 'stale',
    reason: reason('cached_refresh_failed', 'A current read could not be completed; this is the last bounded cached observation.'),
    exclusions: [...new Set([...entry.exclusions, 'current_refresh_failed'])],
  };
}

function staleReport(report: AdminReadinessReport): AdminReadinessReport {
  return {
    ...structuredClone(report),
    servedFromCache: true,
    capabilities: report.capabilities.map(staleEnvelope),
    ...(report.accessPosture ? { accessPosture: staleEnvelope(report.accessPosture) } : {}),
  };
}

function pruneReadinessCache(nowMs: number): void {
  for (const [key, entry] of cache) {
    if (nowMs > entry.staleUntil) cache.delete(key);
  }
}

function cacheReport(
  key: string,
  entry: { freshUntil: number; staleUntil: number; report: AdminReadinessReport },
): void {
  cache.delete(key);
  while (cache.size >= MAX_CACHE_ENTRIES) {
    const oldestKey = cache.keys().next().value as string | undefined;
    if (oldestKey === undefined) break;
    cache.delete(oldestKey);
  }
  cache.set(key, entry);
}

export function clearAdminReadinessCacheForTests(): void {
  cache.clear();
  inFlight.clear();
}

export async function getAdminReadinessReport(
  input: AdminReadinessInput,
  dependencies: AdminReadinessDependencies = {},
): Promise<AdminReadinessReport> {
  const urlError = validateBaseUrl(input.instance.baseUrl);
  if (urlError) throw Object.assign(new Error('Saved Omni instance URL is invalid.'), { statusCode: 400 });
  if (!input.instance.apiKey.trim()) {
    throw Object.assign(new Error('Saved Omni instance credential is missing.'), { statusCode: 400 });
  }
  if (input.workspace !== 'identity' && input.accessPosture) {
    throw Object.assign(new Error('Access posture is available only in the identity workspace.'), { statusCode: 400 });
  }
  const normalizedInput: AdminReadinessInput = input.accessPosture
    ? { ...input, accessPosture: normalizeAccessPostureRequest(input.accessPosture) }
    : input;

  const now = dependencies.now?.() || new Date();
  const nowMs = now.getTime();
  const key = cacheKey(normalizedInput);
  pruneReadinessCache(nowMs);
  const existing = cache.get(key);
  if (existing && nowMs <= existing.freshUntil) return cloneReport(existing.report, true);
  const pending = inFlight.get(key);
  if (pending) {
    const shared = await pending;
    return cloneReport(shared, shared.servedFromCache);
  }

  const context: RequestContext = {
    baseUrl: input.instance.baseUrl,
    apiKey: input.instance.apiKey,
    fetchImpl: dependencies.fetchImpl || fetch,
    assertSafeUrl: dependencies.assertSafeUrl
      || ((url: string) => assertSafeOutboundUrl(url, { label: 'saved instance URL' })),
    timeoutMs: Math.max(1, Math.floor(dependencies.timeoutMs ?? DEFAULT_TIMEOUT_MS)),
    maxCollectionPages: sanitizePageLimit(dependencies.maxCollectionPages),
  };
  const freshCacheMs = Math.max(0, Math.floor(dependencies.freshCacheMs ?? DEFAULT_FRESH_CACHE_MS));
  const staleCacheMs = Math.max(freshCacheMs, Math.floor(dependencies.staleCacheMs ?? DEFAULT_STALE_CACHE_MS));
  const task = (async (): Promise<AdminReadinessReport> => {
    try {
      const refreshed = await buildReport(normalizedInput, context, now.toISOString());
      if (existing && nowMs <= existing.staleUntil && shouldUseStale(existing.report, refreshed)) {
        return staleReport(existing.report);
      }
      cacheReport(key, {
        freshUntil: nowMs + freshCacheMs,
        staleUntil: nowMs + staleCacheMs,
        report: cloneReport(refreshed, false),
      });
      return refreshed;
    } catch (error) {
      if (existing && nowMs <= existing.staleUntil) return staleReport(existing.report);
      throw error;
    }
  })();
  inFlight.set(key, task);
  try {
    const result = await task;
    return cloneReport(result, result.servedFromCache);
  } finally {
    if (inFlight.get(key) === task) inFlight.delete(key);
  }
}
