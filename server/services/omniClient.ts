import { createHash } from 'node:crypto';

import { assertSafeOutboundUrl, validateBaseUrl } from '../security';
import { aiPromptSecurityError } from './aiPromptSecurity';
import { AI_PROMPT_MAX_CHARACTERS } from '../../src/services/aiPromptSecurityShared';
import {
  VAULT_SESSION_ABORT_SIGNAL,
  type SavedInstance,
  type VaultSessionBoundInstance,
} from './nativeVault';
import {
  buildDocumentV2QueryPresentations,
  DocumentsV2Adapter,
  type DocumentV2Patch,
} from './documentsV2';
import {
  materializeDashboardSafeCopyDocumentContent,
  type DashboardSafeCopyDocumentContent,
} from './dashboardSafeCopyContent';
export type { DocumentV2Patch } from './documentsV2';

const TIMEOUT_MS = 60_000;
const MAX_RETRIES = 5;
const RATE_LIMIT_STATE_TTL_MS = 5 * 60_000;
const RATE_LIMIT_WINDOW_MS = 60_000;
// Omni documents 60 requests per minute per API key. Keep five requests of
// headroom for other interactive work while allowing a healthy catalog crawl
// to use the remaining budget without an unconditional delay between pages.
const RATE_LIMIT_REQUEST_BUDGET = 55;
const MAX_CURSOR_PAGES = 1_000;
const MAX_SCIM_PAGES = 1_000;
const SCIM_USER_PAGE_MAX_BYTES = 2 * 1024 * 1024;
const DOCUMENT_INVENTORY_MAX_PAGE_BYTES = 2 * 1024 * 1024;
const DOCUMENT_INVENTORY_MAX_TOTAL_BYTES = 128 * 1024 * 1024;
const DOCUMENT_INVENTORY_DEADLINE_BASE_MS = 30_000;
const DOCUMENT_INVENTORY_DEADLINE_PER_PAGE_MS = 1_500;
const DOCUMENT_INVENTORY_INITIAL_DEADLINE_MS = 120_000;
const DOCUMENT_INVENTORY_RETRY_RESERVE_PAGES = 3;
const ERROR_RESPONSE_MAX_BYTES = 64 * 1024;
const AI_EVAL_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;

export interface OmniRequestPolicy {
  requestTimeoutMs?: number;
  maxReadRetries?: number;
  fetchImpl?: typeof fetch;
  documentInventoryInitialDeadlineMs?: number;
}

const keyChains = new Map<string, Promise<void>>();
const requestStartsByKey = new Map<string, number[]>();
const rateLimitCleanupTimers = new Map<string, NodeJS.Timeout>();

/** Test-only lifecycle seam; production request paths never call this. */
export function resetOmniClientRateLimitStateForTests(): void {
  keyChains.clear();
  requestStartsByKey.clear();
  for (const timer of rateLimitCleanupTimers.values()) clearTimeout(timer);
  rateLimitCleanupTimers.clear();
}

export interface OmniConnectionRecord {
  id: string;
  name: string;
  dialect: string;
  database: string;
  defaultSchema?: string;
  deletedAt?: string | null;
}

export interface OmniSchemaModelRecord {
  id: string;
  name: string;
  connectionId?: string;
  createdAt?: string;
  updatedAt?: string;
  deletedAt?: string | null;
}

export interface OmniModelRecord {
  id: string;
  name: string;
  identifier?: string;
  connectionId?: string;
  connectionName?: string;
  baseModelId?: string;
  kind?: string;
  gitConfigured?: boolean;
  pullRequestRequired?: boolean;
  gitProtected?: boolean;
  gitFollower?: boolean;
  createdAt?: string;
  updatedAt?: string;
  deletedAt?: string | null;
}

export type OmniCreatableModelKind = 'SCHEMA' | 'SHARED' | 'SHARED_EXTENSION' | 'BRANCH';

export interface OmniCreateModelInput {
  connectionId: string;
  modelName: string;
  modelKind: OmniCreatableModelKind;
  baseModelId?: string;
}

export interface OmniCreateModelResult extends OmniModelRecord {
  raw: unknown;
}

export interface OmniJobStatusResult {
  jobId: string;
  status: string;
  raw: unknown;
}

export interface OmniListModelsOptions {
  modelKind?: string;
  connectionId?: string;
  baseModelId?: string;
  modelId?: string;
  name?: string;
  includeDeleted?: boolean;
  include?: string;
}

export interface OmniFolderRecord {
  id: string;
  name: string;
  identifier?: string;
  path?: string;
  parentId?: string;
  children?: OmniFolderRecord[];
}

export interface OmniDocumentRecord {
  id: string;
  identifier: string;
  name: string;
  connectionId?: string;
  folderId?: string;
  folderPath?: string;
  baseModelId?: string;
  baseModelName?: string;
  topicNames?: string[];
  topicIds?: string[];
  type?: string;
  hasApp?: boolean | null;
  hasDashboard?: boolean | null;
  deleted?: boolean;
  description?: string | null;
  labels?: string[];
  updatedAt?: string;
}

export interface OmniDocumentInventoryPagination {
  complete: true;
  pages: number;
  pageSize: number;
  returnedRecords: number;
  reportedTotalRecords?: number;
  responseBytes?: number;
}

export interface OmniDocumentInventoryResult {
  documents: OmniDocumentRecord[];
  pagination: OmniDocumentInventoryPagination;
}

export interface OmniFolderInventoryResult {
  folders: OmniFolderRecord[];
  pagination: OmniDocumentInventoryPagination;
}

export interface OmniDocumentAccessInventoryResult {
  principals: OmniDocumentAccessPrincipal[];
  pagination: OmniDocumentInventoryPagination;
}

export interface OmniLabelRecord {
  name: string;
  color?: string | null;
  description?: string | null;
}

export interface OmniUserAttributeRecord {
  id?: string;
  name: string;
  label?: string;
  type?: string;
  multipleValues?: boolean;
  defaultValue?: string | number | boolean | null;
  system?: boolean;
}

export type OmniContentRole = 'NO_ACCESS' | 'VIEWER' | 'EDITOR' | 'MANAGER';

export interface OmniDocumentAccessPrincipal {
  id: string;
  name: string;
  email?: string;
  type: 'user' | 'userGroup';
  role: OmniContentRole;
  accessBoost: boolean;
  accessSource: 'direct' | 'folder';
  isOwner: boolean;
  folderInfo?: {
    id?: string;
    name?: string;
    path?: string;
  };
}

export interface OmniIdentityUserRecord {
  id: string;
  displayName?: string;
  userName: string;
  email?: string;
  active: boolean;
  createdAt?: string;
  lastLogin?: string | null;
}

export interface OmniUserGroupRecord {
  id: string;
  displayName: string;
  members?: Array<{
    value: string;
    display?: string;
  }>;
}

export interface OmniModelRoleRecord {
  baseRole?: string;
  roleName: string;
  connectionId?: string;
  modelId?: string;
  priority?: number;
  resolved?: boolean;
  from?: {
    type?: string;
    name?: string;
    miniUuid?: string;
    depth?: number;
  };
}

export interface OmniDocumentPermissionInput {
  role: OmniContentRole;
  accessBoost?: boolean;
  userIds?: string[];
  userGroupIds?: string[];
}

export interface OmniEmbedUserRecord {
  id: string;
  displayName: string;
  userName: string;
  active: boolean;
  embedExternalId: string;
  embedEntity: string;
  groups: Array<{ display: string; value: string }>;
  lastLogin?: string | null;
  createdAt?: string;
}

export interface OmniModelYamlResponse {
  files: Record<string, string>;
  checksums?: Record<string, string>;
  raw: unknown;
}

export interface OmniModelTopicRecord {
  name: string;
  label?: string;
  description?: string;
  fileName?: string;
  yaml?: string;
  checksum?: string;
}

export interface OmniModelQueryViewRecord {
  name: string;
  label?: string;
  description?: string;
  fileName: string;
  yaml?: string;
  checksum?: string;
}

export interface OmniModelBranchResult {
  id: string;
  name: string;
  raw: unknown;
}

export interface OmniValidationIssue {
  message?: string;
  is_warning?: boolean;
  yaml_path?: string;
  [key: string]: unknown;
}

export interface OmniDocumentQueryRecord {
  id: string;
  name: string;
  url?: string;
  query: Record<string, unknown>;
  visConfig?: Record<string, unknown>;
  description?: string;
}

export interface OmniQueryExecutionSummary {
  jobId?: string;
  status: string;
  rowCount?: number;
}

export interface OmniCreateWorkbookInput {
  modelId: string;
  name: string;
  description?: string | null;
  folderId?: string;
  folderPath?: string;
  queryPresentations: Array<{
    name: string;
    description?: string | null;
    query: Record<string, unknown>;
    visConfig?: Record<string, unknown>;
  }>;
}

export interface OmniCreateWorkbookResult {
  id: string;
  identifier: string;
  url?: string;
  raw: unknown;
}

export interface OmniDocumentDraftResult {
  identifier: string;
  draftIdentifier: string;
  raw: unknown;
}

export interface OmniDashboardDownloadTile {
  id: string;
  name: string;
  queryId?: string;
  queryIdentifierMapKey?: string;
  section?: string;
  order: number;
  tileType?: string;
  markdown?: string;
}

export interface OmniDashboardDownloadFilter {
  field: string;
  label?: string;
  kind?: string;
  type?: string;
  values: unknown[];
  isNegative?: boolean;
  topic?: string;
  view?: string;
  source?: 'dashboard-picker' | 'tile';
}

export interface OmniDashboardDownloadDetails {
  id: string;
  name: string;
  filters: OmniDashboardDownloadFilter[];
  tiles: OmniDashboardDownloadTile[];
}

export interface OmniDashboardDownloadStartResult {
  jobId: string;
  raw: unknown;
}

export interface OmniDashboardDownloadStatus {
  status: string;
  error?: string;
  raw: unknown;
}

export interface OmniAiJobResult {
  id: string;
  status?: string;
  result?: unknown;
  raw: unknown;
}

export function normalizeOmniAiJobResult(raw: unknown, fallbackId = ''): OmniAiJobResult {
  const record = raw && typeof raw === 'object' && !Array.isArray(raw)
    ? raw as Record<string, unknown>
    : {};
  return {
    id: firstString(record.id, record.jobId, record.job_id, nested(record, 'job', 'id')) ?? fallbackId,
    status: firstString(
      record.state,
      record.status,
      nested(record, 'job', 'state'),
      nested(record, 'job', 'status'),
    ),
    result: record.result,
    raw,
  };
}

export class OmniClientError extends Error {
  readonly omniMessage: string;

  constructor(
    public status: number,
    public url: string,
    message: string,
    readonly omniCode?: string,
    readonly httpStatus: number = status,
  ) {
    const normalizedMessage = message.trim() || 'Omni request failed.';
    const statusLabel = httpStatus === status
      ? String(status)
      : `${httpStatus} ${url} (Omni status ${status})`;
    super(`${statusLabel}${httpStatus === status ? ` ${url}` : ''}: ${omniCode ? `[${omniCode}] ` : ''}${normalizedMessage}`);
    this.name = 'OmniClientError';
    this.omniMessage = normalizedMessage;
  }
}

export class OmniPaginationError extends Error {
  readonly code = 'OMNI_PAGINATION_INCOMPLETE';

  constructor() {
    super('Omni pagination did not reach a reconciled terminal page.');
    this.name = 'OmniPaginationError';
  }
}

export class OmniDocumentInventoryDeadlineError extends Error {
  readonly code = 'DOCUMENT_INVENTORY_TIMEOUT';
  readonly statusCode = 504;

  constructor(readonly timeoutMs: number) {
    super(`The complete Omni document inventory exceeded its ${timeoutMs}ms size-aware deadline.`);
    this.name = 'OmniDocumentInventoryDeadlineError';
  }
}

export class OmniResponseLimitError extends Error {
  readonly code = 'OMNI_RESPONSE_LIMIT_EXCEEDED';
  readonly statusCode = 502;

  constructor() {
    super('The Omni response exceeded the bounded inventory response limit.');
    this.name = 'OmniResponseLimitError';
  }
}

export class OmniResponseReadDeadlineError extends Error {
  readonly code = 'DOCUMENT_INVENTORY_PAGE_TIMEOUT';
  readonly statusCode = 504;

  constructor(readonly timeoutMs: number) {
    super(`The Omni inventory page body exceeded its ${timeoutMs}ms read deadline.`);
    this.name = 'OmniResponseReadDeadlineError';
  }
}

export class OmniRequestDeadlineError extends Error {
  readonly code = 'OMNI_REQUEST_TIMEOUT';
  readonly statusCode = 504;

  constructor(readonly timeoutMs: number) {
    super(`The Omni request exceeded its ${timeoutMs}ms response-header deadline.`);
    this.name = 'OmniRequestDeadlineError';
  }
}

function abortError(): DOMException {
  return new DOMException('The operation was aborted.', 'AbortError');
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason instanceof Error ? signal.reason : abortError();
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  if (ms <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(signal?.reason instanceof Error ? signal.reason : abortError());
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function raceWithAbortSignal<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  throwIfAborted(signal);
  void operation.catch(() => undefined);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener('abort', onAbort);
      reject(signal.reason instanceof Error ? signal.reason : abortError());
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
      return;
    }
    operation.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function credentialRateKey(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex');
}

function scheduleRateLimitStateCleanup(key: string): void {
  const existing = rateLimitCleanupTimers.get(key);
  if (existing) clearTimeout(existing);
  const timer = setTimeout(() => {
    requestStartsByKey.delete(key);
    rateLimitCleanupTimers.delete(key);
  }, RATE_LIMIT_STATE_TTL_MS);
  timer.unref?.();
  rateLimitCleanupTimers.set(key, timer);
}

async function acquireSlot(apiKey: string, signal?: AbortSignal): Promise<void> {
  throwIfAborted(signal);
  const key = credentialRateKey(apiKey);
  const previous = keyChains.get(key) ?? Promise.resolve();
  const next = previous.then(async () => {
    throwIfAborted(signal);
    let now = Date.now();
    let starts = (requestStartsByKey.get(key) ?? [])
      .filter((startedAt) => startedAt > now - RATE_LIMIT_WINDOW_MS);
    if (starts.length >= RATE_LIMIT_REQUEST_BUDGET) {
      const waitMs = Math.max(0, starts[0] + RATE_LIMIT_WINDOW_MS - now);
      if (waitMs > 0) await sleep(waitMs, signal);
      now = Date.now();
      starts = starts.filter((startedAt) => startedAt > now - RATE_LIMIT_WINDOW_MS);
    }
    throwIfAborted(signal);
    starts.push(Date.now());
    requestStartsByKey.set(key, starts);
  });
  const settled = next.catch(() => undefined);
  keyChains.set(key, settled);
  // Chain cleanup follows the underlying queue entry, not this subscriber's
  // caller-facing wait. A cancelled queued caller can return promptly without
  // letting a later request jump ahead of the predecessor that still owns the
  // rate-limit slot ordering.
  void settled.then(() => {
    if (keyChains.get(key) === settled) {
      keyChains.delete(key);
      scheduleRateLimitStateCleanup(key);
    }
  });
  if (signal) {
    await raceWithAbortSignal(next, signal);
    return;
  }
  await next;
}

function retryAfterMs(header: string | null, attempt: number): number {
  if (header) {
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
    const parsedDate = Date.parse(header);
    if (Number.isFinite(parsedDate)) return Math.max(0, parsedDate - Date.now());
  }
  return Math.min(30_000, 1000 * 2 ** attempt);
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

function normalizeDocumentFolderPath(value: string | undefined): string {
  return (value || '')
    .trim()
    .replace(/^\/+|\/+$/g, '')
    .replace(/\/{2,}/g, '/')
    .toLowerCase();
}

function documentFolderPathAliases(value: string | undefined): Set<string> {
  const normalized = normalizeDocumentFolderPath(value);
  if (!normalized) return new Set();
  const aliases = new Set([normalized]);
  if (normalized.startsWith('my documents/')) aliases.add(normalized.slice('my documents/'.length));
  return aliases;
}

function flattenOmniFolders(folders: OmniFolderRecord[]): OmniFolderRecord[] {
  return folders.flatMap((folder) => [folder, ...flattenOmniFolders(folder.children || [])]);
}

function firstNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string' && value.trim()) {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return undefined;
}

function queryResultRowCount(payload: Record<string, unknown>): number | undefined {
  const summaryCount = firstNumber(
    nested(payload, 'summary', 'total_rows'),
    nested(payload, 'summary', 'totalRows'),
    nested(payload, 'summary', 'row_count'),
    nested(payload, 'summary', 'rowCount'),
  );
  if (summaryCount !== undefined) return summaryCount;
  if (typeof payload.result !== 'string' || !payload.result.trim()) return undefined;
  try {
    const parsed = JSON.parse(payload.result) as unknown;
    if (Array.isArray(parsed)) return parsed.length;
    if (parsed && typeof parsed === 'object') {
      const record = parsed as Record<string, unknown>;
      for (const key of ['rows', 'data', 'records']) {
        if (Array.isArray(record[key])) return record[key].length;
      }
    }
  } catch {
    // Arrow/base64 and other result formats intentionally remain opaque.
  }
  return undefined;
}

function queryTimedOut(payload: Record<string, unknown>): boolean {
  return payload.timed_out === true
    || (typeof payload.timed_out === 'string' && payload.timed_out.toLowerCase() === 'true');
}

function extractTopLevelYamlScalar(yaml: string, key: string): string | undefined {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = yaml.match(new RegExp(`^${escapedKey}:\\s*(.+?)\\s*$`, 'm'));
  if (!match) return undefined;
  const raw = match[1].trim();
  if (!raw || raw === '|' || raw === '>') return undefined;
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return firstString(raw.slice(1, -1));
  }
  return firstString(raw);
}

function queryViewNameFromFilePath(filePath: string): string {
  const leaf = filePath.split('/').pop() || filePath;
  return leaf.replace(/\.query\.view$/, '');
}

function nested(obj: unknown, ...keys: string[]): unknown {
  let current: unknown = obj;
  for (const key of keys) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function extractArray(data: unknown, keys: string[]): unknown[] {
  if (Array.isArray(data)) return data;
  if (data && typeof data === 'object') {
    const record = data as Record<string, unknown>;
    for (const key of keys) {
      if (Array.isArray(record[key])) return record[key] as unknown[];
    }
    const firstArray = Object.values(record).find((value) => Array.isArray(value));
    if (Array.isArray(firstArray)) return firstArray;
  }
  return [];
}

function extractExplicitArray(data: unknown, keys: string[]): unknown[] | undefined {
  if (!isRecord(data)) return undefined;
  for (const key of keys) {
    if (Array.isArray(data[key])) return data[key] as unknown[];
  }
  return undefined;
}

async function readBoundedErrorText(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (bytes < ERROR_RESPONSE_MAX_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = ERROR_RESPONSE_MAX_BYTES - bytes;
      chunks.push(value.byteLength <= remaining ? value : value.slice(0, remaining));
      bytes += Math.min(value.byteLength, remaining);
      if (value.byteLength > remaining || bytes >= ERROR_RESPONSE_MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

async function readBoundedJsonResponse(
  response: Response,
  maxBytes: number,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<{ data: unknown; bytes: number }> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new OmniResponseLimitError();
  }
  if (!response.body) throw new OmniPaginationError();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let interruption: Error | undefined;
  const interrupt = (error: Error) => {
    if (interruption) return;
    interruption = error;
    void reader.cancel(error).catch(() => undefined);
  };
  const onAbort = () => interrupt(
    options.signal?.reason instanceof Error ? options.signal.reason : abortError(),
  );
  options.signal?.addEventListener('abort', onAbort, { once: true });
  if (options.signal?.aborted) onAbort();
  const timeout = options.timeoutMs
    ? setTimeout(() => interrupt(new OmniResponseReadDeadlineError(options.timeoutMs!)), options.timeoutMs)
    : undefined;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (interruption) throw interruption;
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new OmniResponseLimitError();
      }
      chunks.push(value);
    }
  } finally {
    if (timeout) clearTimeout(timeout);
    options.signal?.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }

  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { data: JSON.parse(new TextDecoder().decode(body)) as unknown, bytes };
  } catch {
    throw new OmniPaginationError();
  }
}

interface OmniPageInfo {
  hasNextPage?: boolean;
  nextCursor?: string;
  pageSize?: number;
  totalRecords?: number;
}

function extractPageInfo(data: unknown): OmniPageInfo | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const pageInfo = (data as Record<string, unknown>).pageInfo;
  if (!pageInfo || typeof pageInfo !== 'object' || Array.isArray(pageInfo)) return null;
  const record = pageInfo as Record<string, unknown>;
  return {
    ...(typeof record.hasNextPage === 'boolean' ? { hasNextPage: record.hasNextPage } : {}),
    ...(firstString(record.nextCursor) ? { nextCursor: firstString(record.nextCursor) } : {}),
    ...(firstNumber(record.pageSize) !== undefined ? { pageSize: firstNumber(record.pageSize) } : {}),
    ...(firstNumber(record.totalRecords) !== undefined ? { totalRecords: firstNumber(record.totalRecords) } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function omniErrorDetail(text: string, statusText: string): { code?: string; message: string } {
  const fallback = text.trim() || statusText.trim() || 'Omni request failed.';
  const structuredFallback = statusText.trim() || fallback;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed === 'string' && parsed.trim()) return { message: parsed.trim().slice(0, 500) };
    if (!isRecord(parsed)) return { message: fallback.slice(0, 500) };
    const error = isRecord(parsed.error) ? parsed.error : undefined;
    const code = firstString(
      parsed.code,
      parsed.errorCode,
      parsed.error_code,
      error?.code,
      error?.errorCode,
      error?.error_code,
    )?.trim().slice(0, 120);
    const message = firstString(
      parsed.message,
      parsed.detail,
      parsed.error_description,
      typeof parsed.error === 'string' ? parsed.error : undefined,
      error?.message,
      error?.detail,
      error?.error_description,
    )?.trim();
    return {
      ...(code ? { code } : {}),
      message: (message || structuredFallback).slice(0, 500),
    };
  } catch {
    return { message: fallback.slice(0, 500) };
  }
}

function omniErrorStatus(value: Record<string, unknown>, fallback: number): number {
  const error = isRecord(value.error) ? value.error : undefined;
  const status = firstNumber(
    value.statusCode,
    value.status_code,
    value.status,
    error?.statusCode,
    error?.status_code,
    error?.status,
  );
  return status !== undefined && status >= 400 && status <= 599 ? status : fallback;
}

function omniBodyIndicatesFailure(value: Record<string, unknown>): boolean {
  if (value.success === false || value.ok === false) return true;
  if (typeof value.error === 'string') return Boolean(value.error.trim());
  if (Array.isArray(value.error)) return value.error.length > 0;
  return isRecord(value.error) && Object.keys(value.error).length > 0;
}

function parseUserGroupRecord(value: unknown): OmniUserGroupRecord | null {
  if (!isRecord(value)) return null;
  const id = firstString(value.id);
  const displayName = firstString(value.displayName, value.name);
  if (!id || !displayName) return null;
  const members = Array.isArray(value.members)
    ? value.members
      .map((member): { value: string; display?: string } | null => {
        if (!isRecord(member)) return null;
        const memberId = firstString(member.value, member.id);
        if (!memberId) return null;
        const display = firstString(member.display, member.email, member.userName);
        return {
          value: memberId,
          ...(display ? { display } : {}),
        };
      })
      .filter((member): member is { value: string; display?: string } => Boolean(member))
    : undefined;
  return {
    id,
    displayName,
    ...(members ? { members } : {}),
  };
}

function parseModelRoleRecords(value: unknown): OmniModelRoleRecord[] {
  return extractArray(value, ['results', 'modelRoles', 'model_roles', 'records', 'data', 'items'])
    .map((raw): OmniModelRoleRecord | null => {
      if (!isRecord(raw)) return null;
      const roleName = firstString(raw.roleName, raw.role_name);
      if (!roleName) return null;
      const from = isRecord(raw.from) ? raw.from : undefined;
      return {
        roleName,
        ...(firstString(raw.baseRole, raw.base_role) ? { baseRole: firstString(raw.baseRole, raw.base_role) } : {}),
        ...(firstString(raw.connectionId, raw.connection_id) ? { connectionId: firstString(raw.connectionId, raw.connection_id) } : {}),
        ...(firstString(raw.modelId, raw.model_id) ? { modelId: firstString(raw.modelId, raw.model_id) } : {}),
        ...(typeof raw.priority === 'number' ? { priority: raw.priority } : {}),
        ...(typeof raw.resolved === 'boolean' ? { resolved: raw.resolved } : {}),
        ...(from ? {
          from: {
            ...(firstString(from.type) ? { type: firstString(from.type) } : {}),
            ...(firstString(from.name) ? { name: firstString(from.name) } : {}),
            ...(firstString(from.miniUuid, from.mini_uuid) ? { miniUuid: firstString(from.miniUuid, from.mini_uuid) } : {}),
            ...(typeof from.depth === 'number' ? { depth: from.depth } : {}),
          },
        } : {}),
      };
    })
    .filter((role): role is OmniModelRoleRecord => Boolean(role));
}

function humanizeField(field: string): string {
  return field
    .split('.')
    .pop()
    ?.replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (char) => char.toUpperCase())
    || field;
}

function fieldViewName(field: string): string | undefined {
  if (!field.includes('.')) return undefined;
  return field.split('.')[0];
}

function pickDashboardName(data: unknown, fallbackId: string): string {
  const record = isRecord(data) ? data : {};
  const document = isRecord(record.document) ? record.document : {};
  const dashboard = isRecord(record.dashboard) ? record.dashboard : {};
  return firstString(
    record.name,
    record.title,
    record.displayName,
    record.display_name,
    document.name,
    document.title,
    document.displayName,
    document.display_name,
    dashboard.name,
    dashboard.title,
    dashboard.displayName,
    dashboard.display_name,
  ) || `Dashboard ${fallbackId}`;
}

function readDashboardFilterEntries(data: unknown): OmniDashboardDownloadFilter[] {
  const out: OmniDashboardDownloadFilter[] = [];
  if (!isRecord(data)) return out;

  const filters = data.filters;
  if (isRecord(filters)) {
    for (const [field, raw] of Object.entries(filters)) {
      if (!isRecord(raw)) continue;
      const values = Array.isArray(raw.values)
        ? raw.values.slice()
        : Array.isArray(raw.defaultValues)
          ? raw.defaultValues.slice()
          : Array.isArray(raw.default_values)
            ? raw.default_values.slice()
            : [];
      out.push({
        field,
        label: firstString(raw.label, raw.name) || humanizeField(field),
        kind: firstString(raw.kind),
        type: firstString(raw.type),
        values,
        isNegative: raw.is_negative === true || raw.isNegative === true,
        topic: firstString(raw.topic, raw.topic_name, raw.topicName),
        view: fieldViewName(field),
        source: 'dashboard-picker',
      });
    }
  }

  if (Array.isArray(data.controls)) {
    for (const control of data.controls) {
      if (!isRecord(control)) continue;
      const field = firstString(control.field, control.id);
      if (!field) continue;
      const options = Array.isArray(control.options)
        ? control.options
            .map((option) => (isRecord(option) ? option.value ?? option.label : option))
            .filter((value) => value !== undefined && value !== null)
        : [];
      out.push({
        field,
        label: firstString(control.label, control.name) || humanizeField(field),
        kind: firstString(control.kind),
        type: firstString(control.type),
        values: options,
        isNegative: false,
        view: fieldViewName(field),
        source: 'dashboard-picker',
      });
    }
  }

  return out;
}

function readDocFilterEntries(data: unknown): OmniDashboardDownloadFilter[] {
  const out: OmniDashboardDownloadFilter[] = [];
  const record = isRecord(data) ? data : {};
  const candidates = [
    record.filters,
    isRecord(record.document) ? record.document.filters : undefined,
    isRecord(record.dashboard) ? record.dashboard.filters : undefined,
  ];
  const pushEntry = (field: string | undefined, meta: Record<string, unknown>) => {
    if (!field) return;
    const values = Array.isArray(meta.values)
      ? meta.values.slice()
      : Array.isArray(meta.defaultValues)
        ? meta.defaultValues.slice()
        : Array.isArray(meta.default_values)
          ? meta.default_values.slice()
          : [];
    out.push({
      field,
      label: firstString(meta.label, meta.title, meta.displayName, meta.display_name, meta.name) || humanizeField(field),
      kind: firstString(meta.kind),
      type: firstString(meta.type),
      values,
      isNegative: meta.is_negative === true || meta.isNegative === true,
      topic: firstString(meta.topic, meta.topic_name, meta.topicName),
      view: fieldViewName(field),
      source: 'dashboard-picker',
    });
  };

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      for (const item of candidate) {
        if (!isRecord(item)) continue;
        pushEntry(firstString(item.field, item.fieldRef, item.field_ref, item.id), item);
      }
    } else if (isRecord(candidate)) {
      for (const [field, meta] of Object.entries(candidate)) {
        if (isRecord(meta)) pushEntry(field, meta);
      }
    }
  }
  return out;
}

function readDashboardDownloadTiles(data: unknown): OmniDashboardDownloadTile[] {
  const record = isRecord(data) ? data : {};
  const rawTiles = Array.isArray(record.queries)
    ? record.queries
    : Array.isArray(record.tiles)
      ? record.tiles
      : extractArray(data, ['queries', 'tiles', 'records', 'data', 'items']);

  const tiles = rawTiles
    .filter(isRecord)
    .map((row, index) => {
      const id = firstString(row.id, row.queryId, row.query_id) || `tile-${index}`;
      return {
        id,
        queryId: firstString(row.queryId, row.query_id, row.id),
        queryIdentifierMapKey: firstString(row.queryIdentifierMapKey, row.query_identifier_map_key),
        name: firstString(row.displayTitle, row.display_name, row.title, row.name, row.query_name, row.queryName) || `Tile ${index + 1}`,
        section: firstString(row.section, row.group_name),
        order: typeof row.position === 'number' ? row.position : typeof row.order === 'number' ? row.order : index,
        tileType: firstString(row.type, row.tileType, row.kind),
        markdown: firstString(row.markdown, row.body, row.text),
      };
    });

  return tiles.sort((a, b) => a.order - b.order);
}

function readTileFilters(tiles: OmniDashboardDownloadTile[], data: unknown): OmniDashboardDownloadFilter[] {
  const record = isRecord(data) ? data : {};
  const rawTiles = Array.isArray(record.queries)
    ? record.queries
    : Array.isArray(record.tiles)
      ? record.tiles
      : [];
  const out: OmniDashboardDownloadFilter[] = [];
  for (let index = 0; index < rawTiles.length; index += 1) {
    const raw = rawTiles[index];
    if (!isRecord(raw)) continue;
    const queryBody = isRecord(raw.query) ? raw.query : raw;
    if (!isRecord(queryBody.filters)) continue;
    for (const [field, meta] of Object.entries(queryBody.filters)) {
      if (!isRecord(meta)) continue;
      out.push({
        field,
        label: humanizeField(field),
        kind: firstString(meta.kind),
        type: firstString(meta.type),
        values: Array.isArray(meta.values) ? meta.values.slice() : [],
        isNegative: meta.is_negative === true || meta.isNegative === true,
        topic: firstString(queryBody.topic, queryBody.topicName, queryBody.topic_name),
        view: fieldViewName(field),
        source: 'tile',
      });
    }
  }
  void tiles;
  return out;
}

function mergeDashboardDownloadFilters(...groups: OmniDashboardDownloadFilter[][]): OmniDashboardDownloadFilter[] {
  const seen = new Map<string, OmniDashboardDownloadFilter>();
  for (const filters of groups) {
    for (const filter of filters) {
      const existing = seen.get(filter.field);
      if (existing) {
        seen.set(filter.field, {
          ...existing,
          ...Object.fromEntries(Object.entries(filter).filter(([, value]) => value !== undefined && value !== '')),
          values: existing.values.length > 0 ? existing.values : filter.values,
        });
      } else {
        seen.set(filter.field, filter);
      }
    }
  }
  return Array.from(seen.values()).sort((a, b) => (a.label || a.field).localeCompare(b.label || b.field));
}

function normalizeOmniDocumentRecords(all: unknown[]): OmniDocumentRecord[] {
  return all.map((raw) => {
    const row = raw as Record<string, unknown>;
    const content = isRecord(row.content) ? row.content : {};
    const metadata = isRecord(row.metadata) ? row.metadata : {};
    const id = String(row.identifier ?? row.id ?? row.slug ?? row.documentId ?? row.document_id ?? '');
    return {
      id,
      identifier: id,
      name: String(row.name ?? row.title ?? id),
      connectionId: firstString(row.connectionId, row.connection_id, nested(row, 'connection', 'id')),
      folderId: firstString(row.folderId, row.folder_id, nested(row, 'folder', 'id')),
      folderPath: firstString(row.folderPath, row.folder_path, row.path, nested(row, 'folder', 'path')),
      baseModelId: firstString(
        row.sharedModelId,
        row.shared_model_id,
        row.baseModelId,
        row.base_model_id,
        content.sharedModelId,
        content.shared_model_id,
        content.baseModelId,
        content.base_model_id,
        metadata.sharedModelId,
        metadata.shared_model_id,
        nested(row, 'baseModel', 'id'),
        nested(row, 'model', 'id'),
      ),
      type: firstString(row.type, row.documentType, row.document_type, content.type, metadata.type),
      hasApp: typeof row.hasApp === 'boolean'
        ? row.hasApp
        : typeof row.has_app === 'boolean'
          ? row.has_app
          : typeof content.hasApp === 'boolean'
            ? content.hasApp
            : typeof content.has_app === 'boolean'
              ? content.has_app
              : null,
      hasDashboard: typeof row.hasDashboard === 'boolean'
        ? row.hasDashboard
        : typeof row.has_dashboard === 'boolean'
          ? row.has_dashboard
          : typeof content.hasDashboard === 'boolean'
            ? content.hasDashboard
            : typeof content.has_dashboard === 'boolean'
              ? content.has_dashboard
              : null,
      deleted: row.deleted === true || Boolean(firstString(row.deletedAt, row.deleted_at)),
      description: typeof row.description === 'string' ? row.description : null,
      labels: Array.isArray(row.labels) ? row.labels.filter((label): label is string => typeof label === 'string') : undefined,
      updatedAt: firstString(row.updatedAt, row.updated_at),
    };
  }).filter((document) => document.id);
}

export class OmniClient {
  private readonly requestTimeoutMs: number;
  private readonly maxReadRetries: number;
  private readonly fetchImpl: typeof fetch;
  private readonly documentInventoryInitialDeadlineMs: number;
  private readonly vaultSessionSignal?: AbortSignal;

  constructor(
    private readonly instance: Pick<SavedInstance, 'baseUrl' | 'apiKey' | 'label'> & VaultSessionBoundInstance,
    requestPolicy: OmniRequestPolicy = {},
  ) {
    const urlError = validateBaseUrl(instance.baseUrl);
    if (urlError) throw new Error(urlError);
    this.requestTimeoutMs = Number.isFinite(requestPolicy.requestTimeoutMs)
      ? Math.max(1, Math.floor(requestPolicy.requestTimeoutMs!))
      : TIMEOUT_MS;
    this.maxReadRetries = Number.isFinite(requestPolicy.maxReadRetries)
      ? Math.max(0, Math.floor(requestPolicy.maxReadRetries!))
      : MAX_RETRIES;
    this.fetchImpl = requestPolicy.fetchImpl ?? globalThis.fetch;
    this.vaultSessionSignal = instance[VAULT_SESSION_ABORT_SIGNAL];
    this.documentInventoryInitialDeadlineMs = Number.isFinite(requestPolicy.documentInventoryInitialDeadlineMs)
      ? Math.max(1, Math.floor(requestPolicy.documentInventoryInitialDeadlineMs!))
      : DOCUMENT_INVENTORY_INITIAL_DEADLINE_MS;
  }

  private buildUrl(path: string, query?: Record<string, string | number | boolean | undefined>): string {
    const base = this.instance.baseUrl.replace(/\/+$/, '');
    const url = new URL(`${base}${path}`);
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
    }
    return url.toString();
  }

  private async request(method: string, path: string, options: {
    query?: Record<string, string | number | boolean | undefined>;
    body?: unknown;
    accept?: string;
    allowStatuses?: number[];
    signal?: AbortSignal;
  } = {}): Promise<Response> {
    const url = this.buildUrl(path, options.query);
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.instance.apiKey}`,
      Accept: options.accept || 'application/json',
    };
    if (options.body !== undefined) headers['Content-Type'] = 'application/json';

    const externalSignals = [options.signal, this.vaultSessionSignal]
      .filter((signal): signal is AbortSignal => Boolean(signal));
    const externalSignal = externalSignals.length > 1
      ? AbortSignal.any(externalSignals)
      : externalSignals[0];
    const normalizedMethod = method.toUpperCase();
    const maxRetries = ['GET', 'HEAD', 'OPTIONS'].includes(normalizedMethod) ? this.maxReadRetries : 0;
    let lastError: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      throwIfAborted(externalSignal);
      await acquireSlot(this.instance.apiKey, externalSignal);
      const timeoutController = new AbortController();
      const requestSignal = externalSignal
        ? AbortSignal.any([externalSignal, timeoutController.signal])
        : timeoutController.signal;
      const timeoutError = new OmniRequestDeadlineError(this.requestTimeoutMs);
      const timeout = setTimeout(() => timeoutController.abort(timeoutError), this.requestTimeoutMs);
      try {
        await raceWithAbortSignal(
          assertSafeOutboundUrl(url, { label: 'base_url' }),
          requestSignal,
        );
        const response = await raceWithAbortSignal(
          this.fetchImpl(url, {
            method,
            headers,
            body: options.body === undefined ? undefined : JSON.stringify(options.body),
            redirect: 'manual',
            signal: requestSignal,
          }),
          requestSignal,
        );
        if (response.status === 429 && attempt < maxRetries) {
          await response.body?.cancel().catch(() => undefined);
          // Retry-After is server-controlled. Keep it inside the active request
          // deadline so metadata enrichment cannot be held for minutes or days
          // by an extreme header value.
          await sleep(retryAfterMs(response.headers.get('retry-after'), attempt), requestSignal);
          continue;
        }
        if (!response.ok && !options.allowStatuses?.includes(response.status)) {
          const text = await readBoundedErrorText(response).catch(() => '');
          const detail = omniErrorDetail(text, response.statusText);
          throw new OmniClientError(response.status, url, detail.message, detail.code);
        }
        return response;
      } catch (error) {
        const effectiveError = timeoutController.signal.reason === timeoutError ? timeoutError : error;
        lastError = effectiveError;
        if (externalSignal?.aborted) throw externalSignal.reason instanceof Error ? externalSignal.reason : error;
        if (effectiveError instanceof OmniClientError && effectiveError.status < 500 && effectiveError.status !== 429) {
          throw effectiveError;
        }
        if (attempt >= maxRetries) break;
        await sleep(Math.min(10_000, 500 * 2 ** attempt), externalSignal);
      } finally {
        clearTimeout(timeout);
      }
    }
    throw lastError instanceof Error ? lastError : new Error('Omni request failed.');
  }

  private async listCursorRecordsWithTelemetry(options: {
    path: string;
    query?: Record<string, string | number | boolean | undefined>;
    arrayKeys: string[];
    recordKey: (value: unknown) => string | undefined;
    signal?: AbortSignal;
    pageSize?: number;
    requireExactTotal?: boolean;
    allowRemainingTotal?: boolean;
    initialDeadlineMs?: number;
    deadlineMs?: (input: { reportedTotalRecords?: number; pageSize: number }) => number;
    maxPageBytes?: number;
    maxTotalBytes?: number;
    requireRecordKeys?: boolean;
    requireArrayKey?: boolean;
  }): Promise<{ records: unknown[]; pagination: OmniDocumentInventoryPagination }> {
    const pageSize = options.pageSize ?? 100;
    const records: unknown[] = [];
    const recordKeys = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    let expectedTotal: number | undefined;
    let exactTotalMode: 'stable' | 'remaining' | undefined;
    let responseBytes = 0;
    const deadlineController = new AbortController();
    const forwardAbort = () => deadlineController.abort(options.signal?.reason);
    if (options.signal?.aborted) deadlineController.abort(options.signal.reason);
    else options.signal?.addEventListener('abort', forwardAbort, { once: true });
    let deadlineTimer: NodeJS.Timeout | undefined;
    let deadlineError: OmniDocumentInventoryDeadlineError | undefined;
    const operationStartedAt = Date.now();
    let configuredDeadlineMs = 0;
    const armDeadline = (totalOperationMs: number) => {
      configuredDeadlineMs = Math.max(configuredDeadlineMs, Math.max(1, Math.floor(totalOperationMs)));
      if (deadlineTimer) clearTimeout(deadlineTimer);
      deadlineError = new OmniDocumentInventoryDeadlineError(configuredDeadlineMs);
      const remainingMs = Math.max(1, operationStartedAt + configuredDeadlineMs - Date.now());
      deadlineTimer = setTimeout(() => deadlineController.abort(deadlineError), remainingMs);
    };
    if (options.initialDeadlineMs) armDeadline(options.initialDeadlineMs);

    try {
      for (let page = 0; page < MAX_CURSOR_PAGES; page += 1) {
        throwIfAborted(deadlineController.signal);
        const response = await raceWithAbortSignal(
          this.request('GET', options.path, {
            query: { ...options.query, pageSize, cursor },
            signal: deadlineController.signal,
          }),
          deadlineController.signal,
        );
        let data: unknown;
        if (options.maxPageBytes) {
          const bounded = await readBoundedJsonResponse(response, options.maxPageBytes, {
            signal: deadlineController.signal,
            timeoutMs: this.requestTimeoutMs,
          });
          responseBytes += bounded.bytes;
          if (options.maxTotalBytes && responseBytes > options.maxTotalBytes) {
            throw new OmniResponseLimitError();
          }
          data = bounded.data;
        } else {
          data = await response.json().catch(() => ({})) as unknown;
        }
        const recordsBeforePage = records.length;
        const explicitRecords = options.requireArrayKey
          ? extractExplicitArray(data, options.arrayKeys)
          : undefined;
        if (options.requireArrayKey && !explicitRecords) throw new OmniPaginationError();
        const pageRecords = explicitRecords ?? extractArray(data, options.arrayKeys);
        for (const [index, record] of pageRecords.entries()) {
          const stableKey = options.recordKey(record);
          if (options.requireRecordKeys && !stableKey) throw new OmniPaginationError();
          const key = stableKey || `page:${page}:record:${index}`;
          if (recordKeys.has(key)) continue;
          recordKeys.add(key);
          records.push(record);
        }

        const pageInfo = extractPageInfo(data);
        if (options.requireExactTotal) {
          const reportedTotal = pageInfo?.totalRecords;
          if (!Number.isSafeInteger(reportedTotal) || Number(reportedTotal) < 0) {
            throw new OmniPaginationError();
          }
          if (expectedTotal === undefined) expectedTotal = reportedTotal;
          else {
            const stableTotal = reportedTotal === expectedTotal;
            const remainingTotal = options.allowRemainingTotal === true
              && reportedTotal === expectedTotal - recordsBeforePage;
            if (!exactTotalMode) {
              if (stableTotal) exactTotalMode = 'stable';
              else if (remainingTotal) exactTotalMode = 'remaining';
              else throw new OmniPaginationError();
            } else if (
              (exactTotalMode === 'stable' && !stableTotal)
              || (exactTotalMode === 'remaining' && !remainingTotal)
            ) {
              throw new OmniPaginationError();
            }
          }
        } else if (pageInfo?.totalRecords !== undefined) {
          expectedTotal = Math.max(expectedTotal ?? 0, pageInfo.totalRecords);
        }
        if (page === 0 && options.deadlineMs) {
          const timeoutMs = Math.max(1, Math.floor(options.deadlineMs({
            reportedTotalRecords: expectedTotal,
            pageSize,
          })));
          armDeadline(timeoutMs);
        }

        if (pageInfo?.hasNextPage === true) {
          const nextCursor = pageInfo.nextCursor;
          if (!nextCursor || nextCursor === cursor || cursors.has(nextCursor)) throw new OmniPaginationError();
          cursors.add(nextCursor);
          cursor = nextCursor;
          continue;
        }

        const terminal = pageInfo?.hasNextPage === false || (!pageInfo && pageRecords.length < pageSize);
        if (!terminal) throw new OmniPaginationError();
        if (expectedTotal !== undefined && (
          options.requireExactTotal
            ? records.length !== expectedTotal
            : records.length < expectedTotal
        )) throw new OmniPaginationError();
        return {
          records,
          pagination: {
            complete: true,
            pages: page + 1,
            pageSize,
            returnedRecords: records.length,
            ...(expectedTotal !== undefined ? { reportedTotalRecords: expectedTotal } : {}),
            ...(options.maxPageBytes ? { responseBytes } : {}),
          },
        };
      }

      throw new OmniPaginationError();
    } catch (error) {
      if (deadlineError && deadlineController.signal.reason === deadlineError) throw deadlineError;
      throw error;
    } finally {
      if (deadlineTimer) clearTimeout(deadlineTimer);
      options.signal?.removeEventListener('abort', forwardAbort);
    }
  }

  private async listCursorRecords(options: {
    path: string;
    query?: Record<string, string | number | boolean | undefined>;
    arrayKeys: string[];
    recordKey: (value: unknown) => string | undefined;
    signal?: AbortSignal;
    pageSize?: number;
  }): Promise<unknown[]> {
    return (await this.listCursorRecordsWithTelemetry(options)).records;
  }

  private async listScimResources(path: string, signal?: AbortSignal): Promise<unknown[]> {
    const count = 100;
    const resources: unknown[] = [];
    const resourceKeys = new Set<string>();
    const visitedStartIndexes = new Set<number>();
    let startIndex = 1;
    let expectedTotal: number | undefined;

    for (let page = 0; page < MAX_SCIM_PAGES; page += 1) {
      throwIfAborted(signal);
      if (visitedStartIndexes.has(startIndex)) throw new OmniPaginationError();
      visitedStartIndexes.add(startIndex);

      const response = await this.request('GET', path, {
        query: { count, startIndex },
        signal,
      });
      const data = await response.json().catch(() => ({})) as Record<string, unknown>;
      const pageResources = Array.isArray(data.Resources) ? data.Resources : [];
      const returnedStartIndex = firstNumber(data.startIndex) ?? startIndex;
      if (returnedStartIndex !== startIndex) throw new OmniPaginationError();

      for (const [index, resource] of pageResources.entries()) {
        const row = isRecord(resource) ? resource : {};
        const key = firstString(row.id, row.embedExternalId, row.externalId, row.userName)
          || `page:${page}:record:${index}`;
        if (resourceKeys.has(key)) continue;
        resourceKeys.add(key);
        resources.push(resource);
      }

      const totalResults = firstNumber(data.totalResults);
      if (totalResults !== undefined) expectedTotal = Math.max(expectedTotal ?? 0, totalResults);
      if (expectedTotal !== undefined && resources.length >= expectedTotal) return resources;

      if (pageResources.length === 0) {
        if (expectedTotal === undefined || resources.length >= expectedTotal) return resources;
        throw new OmniPaginationError();
      }

      const itemsPerPage = firstNumber(data.itemsPerPage) ?? pageResources.length;
      const advance = Math.max(itemsPerPage, pageResources.length);
      if (advance <= 0) throw new OmniPaginationError();
      const nextStartIndex = returnedStartIndex + advance;
      if (nextStartIndex <= startIndex) throw new OmniPaginationError();

      if (expectedTotal === undefined && pageResources.length < count) return resources;
      if (expectedTotal !== undefined && nextStartIndex > expectedTotal && resources.length < expectedTotal) {
        throw new OmniPaginationError();
      }
      startIndex = nextStartIndex;
    }

    throw new OmniPaginationError();
  }

  private documentsV2(): DocumentsV2Adapter {
    return new DocumentsV2Adapter((method, path, options) => this.request(method, path, options));
  }

  async test(signal?: AbortSignal): Promise<void> {
    await this.request('GET', '/api/v1/folders', { query: { pageSize: 1 }, signal });
  }

  async listConnections(signal?: AbortSignal): Promise<OmniConnectionRecord[]> {
    const response = await this.request('GET', '/api/v1/connections', { signal });
    const data = await response.json();
    return extractArray(data, ['connections', 'records', 'data']).map((raw) => {
      const row = raw as Record<string, unknown>;
      return {
        id: String(row.id ?? ''),
        name: String(row.name ?? ''),
        dialect: String(row.dialect ?? ''),
        database: String(row.database ?? ''),
        defaultSchema: firstString(row.defaultSchema, row.default_schema, row.default_schema_name, row.schema),
        deletedAt: firstString(row.deletedAt, row.deleted_at) ?? null,
      };
    }).filter((connection) => connection.id);
  }

  async countAiConversations(signal?: AbortSignal): Promise<number> {
    const response = await this.request('GET', '/api/v1/ai/conversations', {
      query: { pageSize: 1 },
      signal,
    });
    const data = await response.json().catch(() => ({})) as unknown;
    const totalRecords = extractPageInfo(data)?.totalRecords;
    if (typeof totalRecords !== 'number' || !Number.isSafeInteger(totalRecords) || totalRecords < 0) {
      throw new OmniPaginationError();
    }
    return totalRecords;
  }

  async listSchemaModels(): Promise<OmniSchemaModelRecord[]> {
    const all: unknown[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const response = await this.request('GET', '/api/v1/models', {
        query: {
          pageSize: 100,
          sortDirection: 'desc',
          sortField: 'updatedAt',
          modelKind: 'SCHEMA',
          cursor,
        },
      });
      const data = await response.json();
      all.push(...extractArray(data, ['models', 'records', 'data', 'items']));
      const pageInfo = extractPageInfo(data);
      cursor = pageInfo?.hasNextPage ? pageInfo.nextCursor : undefined;
      pages += 1;
    } while (cursor && pages < 50);

    return all.map((raw) => {
      const row = raw as Record<string, unknown>;
      return {
        id: String(row.id ?? ''),
        name: String(row.name ?? row.identifier ?? ''),
        connectionId: firstString(row.connectionId, row.connection_id, nested(row, 'connection', 'id')),
        createdAt: firstString(row.createdAt, row.created_at),
        updatedAt: firstString(row.updatedAt, row.updated_at),
        deletedAt: firstString(row.deletedAt, row.deleted_at) ?? null,
      };
    }).filter((model) => model.id);
  }

  async listModelSchemas(modelId: string, branchId?: string, signal?: AbortSignal): Promise<string[]> {
    const response = await this.request('GET', `/api/v1/models/${encodeURIComponent(modelId)}/schemas`, {
      query: branchId ? { branchId } : undefined,
      signal,
    });
    const data = await response.json().catch(() => ({})) as unknown;
    return [...new Set(extractArray(data, ['schemas', 'records', 'data', 'items'])
      .map((raw) => {
        if (typeof raw === 'string') return raw;
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return '';
        const row = raw as Record<string, unknown>;
        return firstString(row.name, row.schema, row.schemaName, row.schema_name, row.id) || '';
      })
      .filter(Boolean))]
      .sort((a, b) => a.localeCompare(b));
  }

  async listModels(
    modelKindOrOptions: string | OmniListModelsOptions = 'SHARED',
    signal?: AbortSignal,
  ): Promise<OmniModelRecord[]> {
    const options: OmniListModelsOptions = typeof modelKindOrOptions === 'string'
      ? { modelKind: modelKindOrOptions }
      : modelKindOrOptions;
    const all = await this.listCursorRecords({
      path: '/api/v1/models',
      query: {
        sortField: 'name',
        sortDirection: 'asc',
        modelKind: options.modelKind || 'SHARED',
        connectionId: options.connectionId,
        baseModelId: options.baseModelId,
        modelId: options.modelId,
        name: options.name,
        includeDeleted: options.includeDeleted === true ? true : undefined,
        include: options.include,
      },
      arrayKeys: ['models', 'records', 'data', 'items'],
      recordKey: (raw) => isRecord(raw) ? firstString(raw.id) : undefined,
      signal,
    });

    return all.map((raw) => {
      const row = raw as Record<string, unknown>;
      return {
        id: String(row.id ?? ''),
        name: firstString(row.name, row.label, row.displayName, row.display_name, row.identifier) ?? String(row.id ?? ''),
        identifier: firstString(row.identifier, row.slug, row.key),
        connectionId: firstString(row.connectionId, row.connection_id, nested(row, 'connection', 'id')),
        connectionName: firstString(row.connectionName, row.connection_name, nested(row, 'connection', 'name')),
        baseModelId: firstString(row.baseModelId, row.base_model_id, nested(row, 'baseModel', 'id')),
        kind: firstString(row.kind, row.modelKind, row.model_kind, row.type),
        gitConfigured: Boolean(row.gitRepository || row.git_repository || row.gitRepo || row.git_repo || nested(row, 'git', 'repository') || nested(row, 'gitConfig', 'repository')),
        pullRequestRequired: Boolean(
          row.pullRequestRequired
          || row.pull_request_required
          || row.prRequired
          || row.pr_required
          || nested(row, 'git', 'pullRequestRequired')
          || nested(row, 'gitConfig', 'pullRequestRequired')
        ),
        gitProtected: Boolean(
          row.gitProtected
          || row.git_protected
          || row.protected
          || nested(row, 'git', 'protected')
          || nested(row, 'gitConfig', 'protected')
        ),
        gitFollower: Boolean(
          row.gitFollower
          || row.git_follower
          || row.isGitFollower
          || row.is_git_follower
          || nested(row, 'git', 'follower')
          || nested(row, 'gitConfig', 'follower')
        ),
        createdAt: firstString(row.createdAt, row.created_at),
        updatedAt: firstString(row.updatedAt, row.updated_at),
        deletedAt: firstString(row.deletedAt, row.deleted_at) ?? null,
      };
    }).filter((model) => model.id);
  }

  async listFolders(): Promise<OmniFolderRecord[]> {
    const all: unknown[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const response = await this.request('GET', '/api/v1/folders', {
        query: {
          pageSize: 100,
          sortField: 'name',
          sortDirection: 'asc',
          include: 'labels',
          cursor,
        },
      });
      const data = await response.json();
      all.push(...extractArray(data, ['folders', 'records', 'data', 'items']));
      const pageInfo = extractPageInfo(data);
      cursor = pageInfo?.hasNextPage ? pageInfo.nextCursor : undefined;
      pages += 1;
    } while (cursor && pages < 50);

    const normalizeFolder = (raw: unknown): OmniFolderRecord | null => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
      const row = raw as Record<string, unknown>;
      const identifier = firstString(row.identifier, row.slug, row.filePath, row.file_path, row.path);
      const id = firstString(row.id, row.uuid, row.folderId, row.folder_id) || identifier;
      const children = Array.isArray(row.children)
        ? row.children.map(normalizeFolder).filter((folder): folder is OmniFolderRecord => Boolean(folder))
        : undefined;
      if (!id) return null;
      return {
        id,
        name: firstString(row.name, row.label, row.title, identifier) || id,
        identifier,
        path: firstString(row.path, row.folderPath, row.folder_path, row.filePath, row.file_path, identifier),
        parentId: firstString(row.parentId, row.parent_id),
        children,
      };
    };

    return all.map(normalizeFolder).filter((folder): folder is OmniFolderRecord => Boolean(folder));
  }

  async listFolderInventory(signal?: AbortSignal): Promise<OmniFolderInventoryResult> {
    const result = await this.listCursorRecordsWithTelemetry({
      path: '/api/v1/folders',
      query: {
        sortField: 'name',
        sortDirection: 'asc',
        include: 'labels',
      },
      arrayKeys: ['folders', 'records'],
      recordKey: (raw) => isRecord(raw)
        ? firstString(raw.id, raw.uuid, raw.folderId, raw.folder_id, raw.identifier, raw.path)
        : undefined,
      signal,
      requireExactTotal: true,
      allowRemainingTotal: true,
      requireRecordKeys: true,
      requireArrayKey: true,
      initialDeadlineMs: DOCUMENT_INVENTORY_INITIAL_DEADLINE_MS,
      maxPageBytes: DOCUMENT_INVENTORY_MAX_PAGE_BYTES,
      maxTotalBytes: DOCUMENT_INVENTORY_MAX_TOTAL_BYTES,
    });
    const normalizeFolder = (raw: unknown): OmniFolderRecord | null => {
      if (!isRecord(raw)) return null;
      const identifier = firstString(raw.identifier, raw.slug, raw.filePath, raw.file_path, raw.path);
      const id = firstString(raw.id, raw.uuid, raw.folderId, raw.folder_id) || identifier;
      if (!id) return null;
      return {
        id,
        name: firstString(raw.name, raw.label, raw.title, identifier) || id,
        identifier,
        path: firstString(raw.path, raw.folderPath, raw.folder_path, raw.filePath, raw.file_path, identifier),
        parentId: firstString(raw.parentId, raw.parent_id),
      };
    };
    const folders = result.records
      .map(normalizeFolder)
      .filter((folder): folder is OmniFolderRecord => Boolean(folder));
    if (folders.length !== result.pagination.returnedRecords) throw new OmniPaginationError();
    return { folders, pagination: result.pagination };
  }

  async resolveDocumentFolderId(folderId?: string, folderPath?: string): Promise<string | undefined> {
    const explicitFolderId = folderId?.trim();
    if (explicitFolderId) return explicitFolderId;

    const requestedAliases = documentFolderPathAliases(folderPath);
    if (requestedAliases.size === 0) return undefined;
    if ([...requestedAliases].some((value) => value === 'default' || value === 'my documents')) return undefined;

    const folders = flattenOmniFolders(await this.listFolders());
    const exactPathMatches = folders.filter((folder) => {
      const candidates = [folder.path, folder.identifier].flatMap((value) => [...documentFolderPathAliases(value)]);
      return candidates.some((candidate) => requestedAliases.has(candidate));
    });
    const requestedPath = normalizeDocumentFolderPath(folderPath);
    const matches = exactPathMatches.length > 0
      ? exactPathMatches
      : requestedPath.includes('/')
        ? []
        : folders.filter((folder) => normalizeDocumentFolderPath(folder.name) === requestedPath);

    if (matches.length === 1) return matches[0].id;
    if (matches.length > 1) {
      throw new Error(`Target folder path "${folderPath}" matched multiple Omni folders. Choose the folder again before migrating.`);
    }
    throw new Error(`Target folder path "${folderPath}" could not be resolved to an Omni folder ID. Refresh folders and choose the destination again.`);
  }

  async listFolderDocuments(
    folderIdOrOptions?: string | {
      folderId?: string;
      includeLabels?: boolean;
      connectionId?: string;
      labels?: string;
    },
    includeLabels = false,
    signal?: AbortSignal,
  ): Promise<OmniDocumentRecord[]> {
    const options: { folderId?: string; includeLabels?: boolean; connectionId?: string; labels?: string } = typeof folderIdOrOptions === 'object' && folderIdOrOptions !== null
      ? folderIdOrOptions
      : { folderId: folderIdOrOptions, includeLabels };
    const folderId = options.folderId;
    const shouldIncludeLabels = options.includeLabels ?? includeLabels;
    const all = await this.listCursorRecords({
      path: '/api/v1/documents',
      query: {
        sortField: 'name',
        sortDirection: 'asc',
        folderId,
        labels: options.labels,
        include: shouldIncludeLabels ? 'labels' : undefined,
      },
      arrayKeys: ['documents', 'dashboards', 'records', 'data', 'items'],
      recordKey: (raw) => isRecord(raw)
        ? firstString(raw.identifier, raw.id, raw.slug, raw.documentId, raw.document_id)
        : undefined,
      signal,
    });
    const documents = normalizeOmniDocumentRecords(all);
    // `connectionId` is not a documented List Documents query parameter. Keep
    // the legacy convenience option, but enforce it locally and fail closed for
    // records whose connection ownership is absent.
    return options.connectionId
      ? documents.filter((document) => document.connectionId === options.connectionId)
      : documents;
  }

  async listDocumentInventory(
    options: { includeLabels?: boolean; folderId?: string } = {},
    signal?: AbortSignal,
  ): Promise<OmniDocumentInventoryResult> {
    const result = await this.listCursorRecordsWithTelemetry({
      path: '/api/v1/documents',
      query: {
        sortField: 'name',
        sortDirection: 'asc',
        folderId: options.folderId,
        include: options.includeLabels === true ? 'labels' : undefined,
      },
      arrayKeys: ['records'],
      recordKey: (raw) => isRecord(raw)
        ? firstString(raw.identifier, raw.id, raw.slug, raw.documentId, raw.document_id)
        : undefined,
      signal,
      requireExactTotal: true,
      // Omni List Documents is observed in two cursor-total variants. Some
      // tenants repeat the collection total on every page; others report the
      // number of records remaining from the current cursor (N, N-pageSize,
      // ...). Accept either variant only after page two identifies the mode,
      // then require that mode to remain coherent through the terminal page.
      allowRemainingTotal: true,
      requireRecordKeys: true,
      requireArrayKey: true,
      initialDeadlineMs: this.documentInventoryInitialDeadlineMs,
      maxPageBytes: DOCUMENT_INVENTORY_MAX_PAGE_BYTES,
      maxTotalBytes: DOCUMENT_INVENTORY_MAX_TOTAL_BYTES,
      deadlineMs: ({ reportedTotalRecords, pageSize }) => {
        // requireExactTotal rejects a missing value before this callback runs.
        const expectedPages = Math.max(1, Math.ceil((reportedTotalRecords ?? 0) / pageSize));
        const rateLimitWaitWindows = Math.max(
          1,
          Math.ceil(expectedPages / RATE_LIMIT_REQUEST_BUDGET),
        );
        const retryReservePages = Math.min(expectedPages, DOCUMENT_INVENTORY_RETRY_RESERVE_PAGES);
        return DOCUMENT_INVENTORY_DEADLINE_BASE_MS
          + expectedPages * DOCUMENT_INVENTORY_DEADLINE_PER_PAGE_MS
          + rateLimitWaitWindows * RATE_LIMIT_WINDOW_MS
          + retryReservePages * (this.requestTimeoutMs + 500);
      },
    });
    const documents = normalizeOmniDocumentRecords(result.records);
    if (documents.length !== result.pagination.returnedRecords) throw new OmniPaginationError();
    return {
      documents,
      pagination: result.pagination,
    };
  }

  async getDashboardDownloadDetails(dashboardId: string): Promise<OmniDashboardDownloadDetails> {
    const queryResponse = await this.request('GET', `/api/v1/documents/${encodeURIComponent(dashboardId)}/queries`);
    const queryData = await queryResponse.json();
    let name = pickDashboardName(queryData, dashboardId);

    if (name === `Dashboard ${dashboardId}`) {
      try {
        const metaData = await this.documentsV2().getState(dashboardId);
        name = pickDashboardName(metaData, dashboardId);
      } catch {
        // Metadata fallback is best-effort; query payload is enough for downloads.
      }
    }

    const tiles = readDashboardDownloadTiles(queryData);
    let apiFilters: OmniDashboardDownloadFilter[] = [];
    try {
      const filterResponse = await this.request('GET', `/api/v1/dashboards/${encodeURIComponent(dashboardId)}/filters`);
      apiFilters = readDashboardFilterEntries(await filterResponse.json());
    } catch {
      apiFilters = [];
    }

    return {
      id: dashboardId,
      name,
      tiles,
      filters: mergeDashboardDownloadFilters(
        readDocFilterEntries(queryData),
        apiFilters,
        readTileFilters(tiles, queryData),
      ),
    };
  }

  async startDashboardDownload(dashboardId: string, body: Record<string, unknown>): Promise<OmniDashboardDownloadStartResult> {
    const response = await this.request('POST', `/api/v1/dashboards/${encodeURIComponent(dashboardId)}/download`, { body });
    const raw = await response.json();
    const record = isRecord(raw) ? raw : {};
    const jobId = firstString(record.job_id, record.jobId, record.id, record.download_job_id);
    if (!jobId) throw new Error('No job ID returned from Omni.');
    return { jobId, raw };
  }

  async getDashboardDownloadStatus(dashboardId: string, jobId: string): Promise<OmniDashboardDownloadStatus> {
    const response = await this.request('GET', `/api/v1/dashboards/${encodeURIComponent(dashboardId)}/download/${encodeURIComponent(jobId)}/status`);
    const raw = await response.json();
    const record = isRecord(raw) ? raw : {};
    return {
      status: firstString(record.status, record.state) || 'processing',
      error: firstString(record.error, record.message, record.detail),
      raw,
    };
  }

  async getDashboardDownloadFile(dashboardId: string, jobId: string): Promise<Response> {
    return this.request('GET', `/api/v1/dashboards/${encodeURIComponent(dashboardId)}/download/${encodeURIComponent(jobId)}`, {
      accept: '*/*',
    });
  }

  async listLabels(signal?: AbortSignal): Promise<OmniLabelRecord[]> {
    const response = await this.request('GET', '/api/v1/labels', { signal });
    const data = await response.json();
    return extractArray(data, ['labels', 'records', 'data']).map((raw) => {
      const row = raw as Record<string, unknown>;
      return {
        name: String(row.name ?? ''),
        color: firstString(row.color) ?? null,
        description: firstString(row.description) ?? null,
      };
    }).filter((label) => label.name);
  }

  async listUserAttributes(): Promise<OmniUserAttributeRecord[]> {
    const response = await this.request('GET', '/api/v1/user-attributes');
    const data = await response.json();
    return extractArray(data, ['userAttributes', 'user_attributes', 'attributes', 'records', 'data', 'items'])
      .map((raw): OmniUserAttributeRecord | null => {
        if (typeof raw === 'string') return raw.trim() ? { name: raw.trim() } : null;
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
        const row = raw as Record<string, unknown>;
        const name = firstString(row.name, row.identifier, row.key, row.attributeName, row.attribute_name);
        if (!name) return null;
        return {
          ...(firstString(row.id) ? { id: firstString(row.id) } : {}),
          name,
          ...(firstString(row.label, row.displayName, row.display_name) ? {
            label: firstString(row.label, row.displayName, row.display_name),
          } : {}),
          ...(firstString(row.type) ? { type: firstString(row.type) } : {}),
          ...(typeof row.multiple_values === 'boolean' ? { multipleValues: row.multiple_values } : {}),
          ...('default_value' in row ? {
            defaultValue: (
              typeof row.default_value === 'string'
              || typeof row.default_value === 'number'
              || typeof row.default_value === 'boolean'
              || row.default_value === null
            ) ? row.default_value : null,
          } : {}),
          ...(typeof row.system === 'boolean' ? { system: row.system } : {}),
        };
      })
      .filter((attribute): attribute is OmniUserAttributeRecord => Boolean(attribute))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async listIdentityUsers(signal?: AbortSignal): Promise<OmniIdentityUserRecord[]> {
    const resources = await this.listScimResources('/api/scim/v2/users', signal);
    const users = resources
      .map((raw): OmniIdentityUserRecord | null => {
        if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
        const row = raw as Record<string, unknown>;
        const id = firstString(row.id);
        const userName = firstString(row.userName, row.username);
        if (!id || !userName) return null;
        const emails = Array.isArray(row.emails) ? row.emails : [];
        const primaryEmail = emails
          .map((email) => (
            email && typeof email === 'object' && !Array.isArray(email)
              ? email as Record<string, unknown>
              : {}
          ))
          .sort((a, b) => Number(b.primary === true) - Number(a.primary === true))
          .map((email) => firstString(email.value))
          .find(Boolean);
        const meta = isRecord(row.meta) ? row.meta : {};
        const extension = isRecord(row['urn:omni:params:scim:schemas:extension:user:2.0'])
          ? row['urn:omni:params:scim:schemas:extension:user:2.0'] as Record<string, unknown>
          : {};
        return {
          id,
          userName,
          ...(firstString(row.displayName, row.name) ? { displayName: firstString(row.displayName, row.name) } : {}),
          ...(primaryEmail || userName ? { email: primaryEmail || userName } : {}),
          active: row.active !== false,
          createdAt: firstString(meta.created, row.createdAt, row.created_at),
          lastLogin: firstString(extension.lastLogin, extension.last_login, row.lastLogin, row.last_login) ?? null,
        };
      })
      .filter((user): user is OmniIdentityUserRecord => Boolean(user));
    return [...new Map(users.map((user) => [user.id, user])).values()]
      .sort((a, b) => (a.email || a.userName).localeCompare(b.email || b.userName));
  }

  async getIdentityUserPage(count: number, startIndex: number, signal?: AbortSignal): Promise<unknown> {
    if (
      !Number.isSafeInteger(count)
      || count < 1
      || count > 100
      || !Number.isSafeInteger(startIndex)
      || startIndex < 1
    ) {
      throw new OmniPaginationError();
    }
    const response = await this.request('GET', '/api/scim/v2/users', {
      query: { count, startIndex },
      signal,
    });
    return (await readBoundedJsonResponse(response, SCIM_USER_PAGE_MAX_BYTES, {
      signal,
      timeoutMs: this.requestTimeoutMs,
    })).data;
  }

  async listUserGroups(): Promise<OmniUserGroupRecord[]> {
    const groups: OmniUserGroupRecord[] = [];
    let startIndex = 1;
    const count = 100;
    for (let page = 0; page < 100; page += 1) {
      const response = await this.request('GET', '/api/scim/v2/groups', {
        query: { count, startIndex },
      });
      const data = await response.json().catch(() => ({})) as Record<string, unknown>;
      const resources = Array.isArray(data.Resources) ? data.Resources : [];
      groups.push(...resources
        .map(parseUserGroupRecord)
        .filter((group): group is OmniUserGroupRecord => Boolean(group)));
      const totalResults = typeof data.totalResults === 'number' ? data.totalResults : groups.length;
      const itemsPerPage = typeof data.itemsPerPage === 'number' ? data.itemsPerPage : resources.length;
      if (resources.length === 0 || startIndex + itemsPerPage > totalResults) break;
      startIndex += itemsPerPage;
    }
    return [...new Map(groups.map((group) => [group.id, group])).values()]
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  async getUserGroup(userGroupId: string): Promise<OmniUserGroupRecord> {
    const response = await this.request('GET', `/api/scim/v2/groups/${encodeURIComponent(userGroupId)}`);
    const group = parseUserGroupRecord(await response.json().catch(() => ({})));
    if (!group) throw new Error(`Omni returned an invalid user group response for ${userGroupId}.`);
    return group;
  }

  async listUserModelRoles(
    userId: string,
    options: { modelId?: string; connectionId?: string } = {},
  ): Promise<OmniModelRoleRecord[]> {
    const response = await this.request('GET', `/api/v1/users/${encodeURIComponent(userId)}/model-roles`, {
      query: {
        modelId: options.modelId,
        connectionId: options.connectionId,
      },
    });
    return parseModelRoleRecords(await response.json().catch(() => ({})));
  }

  async assignUserModelRole(
    userId: string,
    input: { roleName: string; modelId?: string; connectionId?: string },
  ): Promise<Record<string, unknown>> {
    const response = await this.request('POST', `/api/v1/users/${encodeURIComponent(userId)}/model-roles`, {
      body: {
        roleName: input.roleName,
        modelId: input.modelId,
        connectionId: input.connectionId,
      },
    });
    return await response.json().catch(() => ({})) as Record<string, unknown>;
  }

  async listUserGroupModelRoles(
    userGroupId: string,
    options: { modelId?: string; connectionId?: string } = {},
  ): Promise<OmniModelRoleRecord[]> {
    const response = await this.request('GET', `/api/v1/user-groups/${encodeURIComponent(userGroupId)}/model-roles`, {
      query: {
        modelId: options.modelId,
        connectionId: options.connectionId,
      },
    });
    return parseModelRoleRecords(await response.json().catch(() => ({})));
  }

  async assignUserGroupModelRole(
    userGroupId: string,
    input: { roleName: string; modelId?: string; connectionId?: string },
  ): Promise<Record<string, unknown>> {
    const response = await this.request('POST', `/api/v1/user-groups/${encodeURIComponent(userGroupId)}/model-roles`, {
      body: {
        roleName: input.roleName,
        modelId: input.modelId,
        connectionId: input.connectionId,
      },
    });
    return await response.json().catch(() => ({})) as Record<string, unknown>;
  }

  async listDocumentAccess(
    documentId: string,
    options: {
      accessSource?: 'direct' | 'folder';
      type?: 'user' | 'userGroup';
    } = {},
  ): Promise<OmniDocumentAccessPrincipal[]> {
    const principals: OmniDocumentAccessPrincipal[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 100; page += 1) {
      const response = await this.request(
        'GET',
        `/api/v1/documents/${encodeURIComponent(documentId)}/access-list`,
        {
          query: {
            pageSize: 100,
            cursor,
            accessSource: options.accessSource,
            type: options.type,
          },
        },
      );
      const data = await response.json().catch(() => ({})) as Record<string, unknown>;
      const rows = Array.isArray(data.principals) ? data.principals : [];
      principals.push(...rows
        .map((raw): OmniDocumentAccessPrincipal | null => {
          if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
          const row = raw as Record<string, unknown>;
          const id = firstString(row.id);
          const name = firstString(row.name, row.email);
          const type = row.type === 'userGroup' ? 'userGroup' : row.type === 'user' ? 'user' : undefined;
          const role = firstString(row.role) as OmniContentRole | undefined;
          const accessSource = row.accessSource === 'folder' ? 'folder' : row.accessSource === 'direct' ? 'direct' : undefined;
          if (!id || !name || !type || !role || !accessSource) return null;
          const folderInfo = row.folderInfo && typeof row.folderInfo === 'object' && !Array.isArray(row.folderInfo)
            ? row.folderInfo as Record<string, unknown>
            : undefined;
          return {
            id,
            name,
            ...(firstString(row.email) ? { email: firstString(row.email) } : {}),
            type,
            role,
            accessBoost: row.accessBoost === true,
            accessSource,
            isOwner: row.isOwner === true,
            ...(folderInfo ? {
              folderInfo: {
                ...(firstString(folderInfo.id) ? { id: firstString(folderInfo.id) } : {}),
                ...(firstString(folderInfo.name) ? { name: firstString(folderInfo.name) } : {}),
                ...(firstString(folderInfo.path) ? { path: firstString(folderInfo.path) } : {}),
              },
            } : {}),
          };
        })
        .filter((principal): principal is OmniDocumentAccessPrincipal => Boolean(principal)));
      const pageInfo = data.pageInfo && typeof data.pageInfo === 'object' && !Array.isArray(data.pageInfo)
        ? data.pageInfo as Record<string, unknown>
        : {};
      cursor = firstString(pageInfo.nextCursor);
      if (pageInfo.hasNextPage !== true || !cursor) break;
    }
    return principals;
  }

  async listDocumentAccessInventory(
    documentId: string,
    options: {
      accessSource?: 'direct' | 'folder';
      type?: 'user' | 'userGroup';
    } = {},
    signal?: AbortSignal,
  ): Promise<OmniDocumentAccessInventoryResult> {
    const result = await this.listCursorRecordsWithTelemetry({
      path: `/api/v1/documents/${encodeURIComponent(documentId)}/access-list`,
      query: {
        accessSource: options.accessSource,
        type: options.type,
      },
      arrayKeys: ['principals'],
      recordKey: (raw) => isRecord(raw)
        ? [firstString(raw.type), firstString(raw.id), firstString(raw.accessSource)].filter(Boolean).join(':') || undefined
        : undefined,
      signal,
      requireExactTotal: true,
      allowRemainingTotal: true,
      requireRecordKeys: true,
      requireArrayKey: true,
      initialDeadlineMs: DOCUMENT_INVENTORY_INITIAL_DEADLINE_MS,
      maxPageBytes: DOCUMENT_INVENTORY_MAX_PAGE_BYTES,
      maxTotalBytes: DOCUMENT_INVENTORY_MAX_TOTAL_BYTES,
    });
    const principals = result.records.map((raw): OmniDocumentAccessPrincipal | null => {
      if (!isRecord(raw)) return null;
      const id = firstString(raw.id);
      const name = firstString(raw.name, raw.email);
      const type = raw.type === 'userGroup' ? 'userGroup' : raw.type === 'user' ? 'user' : undefined;
      const rawRole = firstString(raw.role);
      const role: OmniContentRole | undefined = rawRole === 'NO_ACCESS'
        || rawRole === 'VIEWER'
        || rawRole === 'EDITOR'
        || rawRole === 'MANAGER'
        ? rawRole
        : undefined;
      const accessSource = raw.accessSource === 'folder' ? 'folder' : raw.accessSource === 'direct' ? 'direct' : undefined;
      if (
        !id
        || !name
        || !type
        || !role
        || !accessSource
        || (options.type && type !== options.type)
        || (options.accessSource && accessSource !== options.accessSource)
      ) return null;
      const folderInfo = isRecord(raw.folderInfo) ? raw.folderInfo : undefined;
      return {
        id,
        name,
        ...(firstString(raw.email) ? { email: firstString(raw.email) } : {}),
        type,
        role,
        accessBoost: raw.accessBoost === true,
        accessSource,
        isOwner: raw.isOwner === true,
        ...(folderInfo ? {
          folderInfo: {
            ...(firstString(folderInfo.id) ? { id: firstString(folderInfo.id) } : {}),
            ...(firstString(folderInfo.name) ? { name: firstString(folderInfo.name) } : {}),
            ...(firstString(folderInfo.path) ? { path: firstString(folderInfo.path) } : {}),
          },
        } : {}),
      };
    }).filter((principal): principal is OmniDocumentAccessPrincipal => Boolean(principal));
    if (principals.length !== result.pagination.returnedRecords) throw new OmniPaginationError();
    return { principals, pagination: result.pagination };
  }

  async grantDocumentPermissions(documentId: string, input: OmniDocumentPermissionInput): Promise<void> {
    await this.request('POST', `/api/v1/documents/${encodeURIComponent(documentId)}/permissions`, {
      body: {
        role: input.role,
        accessBoost: input.accessBoost === true,
        ...(input.userIds?.length ? { userIds: input.userIds } : {}),
        ...(input.userGroupIds?.length ? { userGroupIds: input.userGroupIds } : {}),
      },
    });
  }

  async updateDocumentPermissions(documentId: string, input: OmniDocumentPermissionInput): Promise<void> {
    await this.request('PATCH', `/api/v1/documents/${encodeURIComponent(documentId)}/permissions`, {
      body: {
        role: input.role,
        accessBoost: input.accessBoost === true,
        ...(input.userIds?.length ? { userIds: input.userIds } : {}),
        ...(input.userGroupIds?.length ? { userGroupIds: input.userGroupIds } : {}),
      },
    });
  }

  async getModelYamlFiles(modelId: string, signal?: AbortSignal): Promise<Record<string, string>> {
    const data = await this.getModelYaml(modelId, { fullyResolved: true, signal });
    return data.files;
  }

  async listModelTopics(modelId: string, options: { includeYaml?: boolean; includeChecksums?: boolean } = {}): Promise<OmniModelTopicRecord[]> {
    const yaml = await this.getModelYaml(modelId, { includeChecksums: options.includeChecksums });
    return Object.entries(yaml.files)
      .filter(([filePath]) => filePath.split('/').pop()?.endsWith('.topic'))
      .map(([filePath, content]) => {
        const fileName = filePath.split('/').pop() || filePath;
        const name = fileName.replace(/\.topic$/, '');
        const label = firstString(content.match(/^label:\s*["']?(.+?)["']?\s*$/m)?.[1]);
        const description = firstString(content.match(/^description:\s*["']?(.+?)["']?\s*$/m)?.[1]);
        return {
          name,
          ...(label ? { label } : {}),
          ...(description ? { description } : {}),
          fileName: filePath,
          ...(options.includeYaml ? { yaml: content } : {}),
          ...(yaml.checksums?.[filePath] ? { checksum: yaml.checksums[filePath] } : {}),
        };
      })
      .filter((topic) => topic.name)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async listModelTopicSummaries(modelId: string, signal?: AbortSignal): Promise<OmniModelTopicRecord[]> {
    const response = await this.request('GET', `/api/v1/models/${encodeURIComponent(modelId)}/topic`, { signal });
    const data = await response.json().catch(() => ({})) as unknown;
    return extractArray(data, ['topics', 'records', 'data', 'items'])
      .map((raw): OmniModelTopicRecord | null => {
        if (!isRecord(raw)) return null;
        const name = firstString(raw.name, raw.identifier, raw.slug);
        if (!name) return null;
        const label = firstString(raw.label, raw.displayName, raw.display_name);
        const description = firstString(raw.description);
        const fileName = firstString(raw.ide_file_name, raw.fileName, raw.file_name);
        return {
          name,
          ...(label ? { label } : {}),
          ...(description ? { description } : {}),
          ...(fileName ? { fileName } : {}),
        };
      })
      .filter((topic): topic is OmniModelTopicRecord => Boolean(topic))
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async listModelQueryViews(
    modelId: string,
    options: { branchId?: string; includeYaml?: boolean; includeChecksums?: boolean } = {},
  ): Promise<OmniModelQueryViewRecord[]> {
    const yaml = await this.getModelYaml(modelId, {
      branchId: options.branchId,
      includeChecksums: options.includeChecksums,
    });
    return Object.entries(yaml.files)
      .filter(([filePath]) => filePath.split('/').pop()?.endsWith('.query.view'))
      .map(([filePath, content]) => {
        const label = extractTopLevelYamlScalar(content, 'label');
        const description = extractTopLevelYamlScalar(content, 'description');
        return {
          name: queryViewNameFromFilePath(filePath),
          ...(label ? { label } : {}),
          ...(description ? { description } : {}),
          fileName: filePath,
          ...(options.includeYaml ? { yaml: content } : {}),
          ...(yaml.checksums?.[filePath] ? { checksum: yaml.checksums[filePath] } : {}),
        };
      })
      .filter((queryView) => queryView.name)
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  async getModelYaml(modelId: string, options: {
    branchId?: string;
    fileName?: string;
    mode?: 'combined' | 'extension' | 'staged' | 'merged' | 'history';
    includeChecksums?: boolean;
    fullyResolved?: boolean;
    signal?: AbortSignal;
  } = {}): Promise<OmniModelYamlResponse> {
    const response = await this.request('GET', `/api/v1/models/${encodeURIComponent(modelId)}/yaml`, {
      query: {
        branchId: options.branchId,
        fileName: options.fileName,
        mode: options.mode,
        includeChecksums: options.includeChecksums,
        fullyResolved: options.fullyResolved,
      },
      signal: options.signal,
    });
    const data = await response.json() as Record<string, unknown>;
    const files = data && typeof data === 'object' && !Array.isArray(data)
      ? (data as Record<string, unknown>).files
      : null;
    const normalizedFiles = !files || typeof files !== 'object' || Array.isArray(files)
      ? {}
      : Object.fromEntries(
      Object.entries(files).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    );
    const checksums = data.checksums && typeof data.checksums === 'object' && !Array.isArray(data.checksums)
      ? Object.fromEntries(Object.entries(data.checksums).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
      : undefined;
    return { files: normalizedFiles, checksums, raw: data };
  }

  async createModel(input: OmniCreateModelInput): Promise<OmniCreateModelResult> {
    const path = '/api/v1/models';
    const response = await this.request('POST', '/api/v1/models', {
      body: {
        connectionId: input.connectionId,
        modelName: input.modelName,
        modelKind: input.modelKind,
        baseModelId: input.baseModelId,
      },
    });
    const raw = await response.json().catch(() => ({})) as Record<string, unknown>;
    const responseUrl = response.url || this.buildUrl(path);
    if (omniBodyIndicatesFailure(raw)) {
      const detail = omniErrorDetail(JSON.stringify(raw), 'Omni reported that model creation failed.');
      throw new OmniClientError(
        omniErrorStatus(raw, 502),
        responseUrl,
        detail.message,
        detail.code,
        response.status,
      );
    }
    const id = firstString(
      raw.id,
      raw.modelId,
      raw.model_id,
      raw.branchId,
      raw.branch_id,
      nested(raw, 'model', 'id'),
      nested(raw, 'branch', 'id'),
    ) ?? '';
    if (!id) {
      const detail = omniErrorDetail(JSON.stringify(raw), 'Omni did not return a model id.');
      throw new OmniClientError(
        omniErrorStatus(raw, 502),
        responseUrl,
        detail.message,
        detail.code,
        response.status,
      );
    }
    return {
      id,
      name: firstString(
        raw.name,
        raw.modelName,
        raw.model_name,
        raw.branchName,
        raw.branch_name,
        nested(raw, 'model', 'name'),
        nested(raw, 'branch', 'name'),
      ) ?? input.modelName,
      identifier: firstString(raw.identifier, nested(raw, 'model', 'identifier')),
      connectionId: firstString(
        raw.connectionId,
        raw.connection_id,
        nested(raw, 'connection', 'id'),
        nested(raw, 'model', 'connectionId'),
      ) ?? input.connectionId,
      baseModelId: firstString(
        raw.baseModelId,
        raw.base_model_id,
        nested(raw, 'baseModel', 'id'),
        nested(raw, 'model', 'baseModelId'),
      ) ?? input.baseModelId,
      kind: firstString(raw.kind, raw.modelKind, raw.model_kind, nested(raw, 'model', 'kind')) ?? input.modelKind,
      createdAt: firstString(raw.createdAt, raw.created_at, nested(raw, 'model', 'createdAt')),
      updatedAt: firstString(raw.updatedAt, raw.updated_at, nested(raw, 'model', 'updatedAt')),
      deletedAt: firstString(raw.deletedAt, raw.deleted_at, nested(raw, 'model', 'deletedAt')) ?? null,
      raw,
    };
  }

  async createModelBranch(input: { connectionId: string; baseModelId: string; branchName: string }): Promise<OmniModelBranchResult> {
    const model = await this.createModel({
      connectionId: input.connectionId,
      modelName: input.branchName,
      modelKind: 'BRANCH',
      baseModelId: input.baseModelId,
    });
    return { id: model.id, name: model.name, raw: model.raw };
  }

  async findModelBranch(baseModelId: string, branchName: string): Promise<OmniModelBranchResult | null> {
    const branches = await this.listModels('BRANCH');
    const normalizedBranchName = branchName.trim().toLowerCase();
    const match = branches.find((branch) => (
      branch.baseModelId === baseModelId
      && [branch.name, branch.identifier, branch.id]
        .filter(Boolean)
        .some((value) => value?.trim().toLowerCase() === normalizedBranchName)
    ));
    return match ? { id: match.id, name: match.name || branchName, raw: match } : null;
  }

  async updateModelYamlFile(input: {
    modelId: string;
    fileName: string;
    yaml: string;
    branchId?: string;
    previousChecksum?: string;
    commitMessage?: string;
  }): Promise<unknown> {
    const response = await this.request('POST', `/api/v1/models/${encodeURIComponent(input.modelId)}/yaml`, {
      body: {
        fileName: input.fileName,
        yaml: input.yaml,
        mode: 'combined',
        branchId: input.branchId,
        previousChecksum: input.previousChecksum,
        commitMessage: input.commitMessage,
      },
    });
    return response.json().catch(() => ({}));
  }

  async updateModelYamlFiles(input: {
    modelId: string;
    branchId: string;
    files: Array<{ fileName: string; yaml: string; previousChecksum?: string }>;
    commitMessage?: string;
  }): Promise<unknown> {
    if (input.files.length === 0) return {};
    const results: unknown[] = [];
    for (const file of input.files) {
      results.push(await this.updateModelYamlFile({
        modelId: input.modelId,
        branchId: input.branchId,
        fileName: file.fileName,
        yaml: file.yaml,
        previousChecksum: file.previousChecksum,
        commitMessage: input.commitMessage,
      }));
    }
    return { files: results };
  }

  async deleteModelYamlFile(input: {
    modelId: string;
    fileName: string;
    branchId?: string;
    mode?: 'combined' | 'extension' | 'staged' | 'merged' | 'history';
    commitMessage?: string;
  }): Promise<unknown> {
    const response = await this.request('DELETE', `/api/v1/models/${encodeURIComponent(input.modelId)}/yaml`, {
      query: {
        fileName: input.fileName,
        branchId: input.branchId,
        mode: input.mode,
        commitMessage: input.commitMessage,
      },
    });
    return response.json().catch(() => ({}));
  }

  async deleteView(input: {
    modelId: string;
    viewName: string;
    mode?: 'COMBINED' | 'EXTENSION' | 'MERGED';
    branchId?: string;
  }): Promise<unknown> {
    const response = await this.request('DELETE', `/api/v1/models/${encodeURIComponent(input.modelId)}/view/${encodeURIComponent(input.viewName)}`, {
      query: {
        mode: input.mode,
        branchId: input.branchId,
      },
    });
    return response.json().catch(() => ({}));
  }

  async validateModel(modelId: string, branchId?: string): Promise<OmniValidationIssue[]> {
    const response = await this.request('GET', `/api/v1/models/${encodeURIComponent(modelId)}/validate`, {
      query: branchId ? { branchId } : undefined,
    });
    const data = await response.json().catch(() => []) as unknown;
    return extractArray(data, ['issues', 'errors', 'warnings', 'data']).map((issue) => issue as OmniValidationIssue);
  }

  async validateModelContent(
    modelId: string,
    branchOrOptions?: string | {
      branchId?: string;
      userId?: string;
      includePersonalFolders?: boolean;
      find?: string;
      findType?: 'VIEW' | 'FIELD' | 'TOPIC';
    },
  ): Promise<Record<string, unknown>> {
    const options = typeof branchOrOptions === 'string'
      ? { branchId: branchOrOptions }
      : branchOrOptions;
    const response = await this.request('GET', `/api/v1/models/${encodeURIComponent(modelId)}/content-validator`, {
      query: {
        branch_id: options?.branchId,
        userId: options?.userId,
        include_personal_folders: options?.includePersonalFolders,
        find: options?.find,
        find_type: options?.findType,
      },
    });
    return await response.json().catch(() => ({})) as Record<string, unknown>;
  }

  async planQueryAsUser(
    query: Record<string, unknown>,
    options: { userId?: string; branchId?: string } = {},
  ): Promise<Record<string, unknown>> {
    const response = await this.request('POST', '/api/v1/query/run', {
      query: options.userId ? { userId: options.userId } : undefined,
      body: {
        query,
        ...(options.branchId ? { branchId: options.branchId } : {}),
        planOnly: true,
      },
    });
    return await response.json().catch(() => ({})) as Record<string, unknown>;
  }

  async findAndReplaceModelContent(input: {
    modelId: string;
    find: string;
    replacement: string;
    type: 'VIEW' | 'FIELD' | 'TOPIC';
    branchId?: string;
    includePersonalFolders?: boolean;
  }): Promise<Record<string, unknown>> {
    const response = await this.request('POST', `/api/v1/models/${encodeURIComponent(input.modelId)}/content-validator`, {
      body: {
        find: input.find,
        replacement: input.replacement,
        find_or_replace_type: input.type,
        branch_id: input.branchId,
        include_personal_folders: input.includePersonalFolders === true,
      },
    });
    return await response.json().catch(() => ({})) as Record<string, unknown>;
  }

  async createOrUpdateModelBranchPullRequest(input: {
    modelId: string;
    branchId: string;
    commitMessage: string;
    allowBranchExists?: boolean;
    requireBranchExists?: boolean;
  }): Promise<Record<string, unknown>> {
    const response = await this.request('POST', `/api/v1/models/${encodeURIComponent(input.modelId)}/git/commit`, {
      body: {
        branch_id: input.branchId,
        commit_message: input.commitMessage,
        allow_branch_exists: input.allowBranchExists !== false,
        require_branch_exists: input.requireBranchExists === true,
      },
    });
    return await response.json().catch(() => ({})) as Record<string, unknown>;
  }

  async deleteModelBranch(modelId: string, branchName: string): Promise<Record<string, unknown>> {
    const response = await this.request(
      'DELETE',
      `/api/v1/models/${encodeURIComponent(modelId)}/branch/${encodeURIComponent(branchName)}`,
    );
    return await response.json().catch(() => ({})) as Record<string, unknown>;
  }

  async migrateModel(input: {
    sourceModelId: string;
    gitRef?: string;
    targetModelId: string;
    branchName: string;
    commitMessage: string;
  }): Promise<Record<string, unknown>> {
    const response = await this.request('POST', `/api/v1/models/${encodeURIComponent(input.sourceModelId)}/migrate`, {
      body: {
        gitRef: input.gitRef,
        targetModelId: input.targetModelId,
        branchName: input.branchName,
        commitMessage: input.commitMessage,
      },
    });
    return await response.json().catch(() => ({})) as Record<string, unknown>;
  }

  async mergeModelBranch(modelId: string, branchName: string, options: {
    publishDrafts?: boolean;
    deleteBranch?: boolean;
    forceOverrideGitSettings?: boolean;
  } = {}): Promise<Record<string, unknown>> {
    const response = await this.request('POST', `/api/v1/models/${encodeURIComponent(modelId)}/branch/${encodeURIComponent(branchName)}/merge`, {
      body: {
        publish_drafts: options.publishDrafts === true,
        delete_branch: options.deleteBranch === true,
        force_override_git_settings: options.forceOverrideGitSettings === true,
      },
    });
    return await response.json().catch(() => ({})) as Record<string, unknown>;
  }

  async getDocumentQueries(documentId: string, signal?: AbortSignal): Promise<OmniDocumentQueryRecord[]> {
    const response = await this.request('GET', `/api/v1/documents/${encodeURIComponent(documentId)}/queries`, { signal });
    const data = await response.json().catch(() => []) as unknown;
    return extractArray(data, ['queries', 'queryPresentations', 'records', 'data', 'items']).map((raw) => {
      const row = raw as Record<string, unknown>;
      const query = row.query && typeof row.query === 'object' && !Array.isArray(row.query)
        ? row.query as Record<string, unknown>
        : {};
      const visConfig = row.visConfig && typeof row.visConfig === 'object' && !Array.isArray(row.visConfig)
        ? row.visConfig as Record<string, unknown>
        : row.vis_config && typeof row.vis_config === 'object' && !Array.isArray(row.vis_config)
          ? row.vis_config as Record<string, unknown>
          : undefined;
      return {
        id: String(row.id ?? row.identifier ?? row.name ?? ''),
        name: firstString(row.name, row.title) ?? 'Workbook tab',
        url: firstString(row.url),
        query,
        visConfig,
        description: firstString(row.description),
      };
    }).filter((query) => query.id || Object.keys(query.query).length > 0);
  }

  async runQuery(query: Record<string, unknown>, options: {
    branchId?: string;
    userId?: string;
    cache?: 'Standard' | 'SkipRequery' | 'SkipCache';
    maxWaitAttempts?: number;
    requireExplicitTerminalStatus?: boolean;
  } = {}): Promise<OmniQueryExecutionSummary> {
    const response = await this.request('POST', '/api/v1/query/run', {
      body: {
        query,
        branchId: options.branchId,
        userId: options.userId,
        cache: options.cache || 'SkipCache',
        resultType: 'json',
        formatResults: false,
      },
      allowStatuses: [408],
    });
    let payload = await response.json().catch(() => ({})) as Record<string, unknown>;
    let remainingJobIds = Array.isArray(payload.remaining_job_ids)
      ? payload.remaining_job_ids.filter((value): value is string => typeof value === 'string' && Boolean(value))
      : [];
    if (response.status === 408 && remainingJobIds.length === 0) {
      throw new Error('Query validation timed out without a pollable Omni job ID.');
    }
    const maxWaitAttempts = Math.max(1, Math.min(30, options.maxWaitAttempts || 12));
    let waitAttempt = 0;
    while ((response.status === 408 || queryTimedOut(payload) || remainingJobIds.length > 0) && remainingJobIds.length > 0) {
      if (waitAttempt >= maxWaitAttempts) {
        throw new Error(`Query validation timed out after ${maxWaitAttempts} wait attempts.`);
      }
      waitAttempt += 1;
      const waitResponse = await this.request('GET', '/api/v1/query/wait', {
        query: { job_ids: JSON.stringify(remainingJobIds) },
      });
      payload = await waitResponse.json().catch(() => ({})) as Record<string, unknown>;
      remainingJobIds = Array.isArray(payload.remaining_job_ids)
        ? payload.remaining_job_ids.filter((value): value is string => typeof value === 'string' && Boolean(value))
        : [];
    }

    if (remainingJobIds.length > 0 || queryTimedOut(payload)) {
      throw new Error('Query validation timed out before Omni returned a terminal result.');
    }
    const rawStatus = firstString(payload.status, nested(payload, 'completedJob', 'status'));
    if (options.requireExplicitTerminalStatus === true && !rawStatus) {
      throw new Error('Omni query execution did not return an explicit terminal status.');
    }
    const status = (rawStatus || 'COMPLETE').toUpperCase();
    if (!['COMPLETE', 'COMPLETED', 'SUCCESS', 'SUCCEEDED', 'DONE'].includes(status)) {
      throw new Error(`Omni query execution finished with non-success status ${status}.`);
    }
    return {
      jobId: firstString(payload.job_id, payload.jobId, nested(payload, 'completedJob', 'job_id')),
      status,
      rowCount: queryResultRowCount(payload),
    };
  }

  async createWorkbookDocument(input: OmniCreateWorkbookInput): Promise<OmniCreateWorkbookResult> {
    const folderId = await this.resolveDocumentFolderId(input.folderId, input.folderPath);
    return this.documentsV2().create({
      modelId: input.modelId,
      name: input.name,
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(folderId ? { folderId } : {}),
      summary: 'Created migrated workbook with OmniKit',
      queryPresentations: buildDocumentV2QueryPresentations(input.queryPresentations),
    });
  }

  async createDashboardSafeCopyDocument(input: {
    modelId: string;
    name: string;
    folderId?: string;
    content: DashboardSafeCopyDocumentContent;
  }): Promise<OmniCreateWorkbookResult> {
    const content = materializeDashboardSafeCopyDocumentContent(input.content);
    return this.documentsV2().create({
      modelId: input.modelId,
      name: input.name,
      ...(content.description !== undefined ? { description: content.description } : {}),
      ...(input.folderId ? { folderId: input.folderId } : {}),
      summary: 'Created verified dashboard safe copy with OmniKit',
      queryPresentations: content.queryPresentations,
      ...(content.controls !== undefined ? { controls: content.controls } : {}),
      ...(content.settings !== undefined ? { settings: content.settings } : {}),
      containers: content.containers,
    });
  }

  async createAiJob(input: { modelId: string; prompt: string; branchId?: string }, signal?: AbortSignal): Promise<OmniAiJobResult> {
    if (input.prompt.length > AI_PROMPT_MAX_CHARACTERS) {
      throw new Error(`AI prompt exceeds the ${AI_PROMPT_MAX_CHARACTERS.toLocaleString()} character server limit.`);
    }
    const promptSecurityError = aiPromptSecurityError(input.prompt);
    if (promptSecurityError) throw new Error(promptSecurityError);
    const response = await this.request('POST', '/api/v1/ai/jobs', {
      body: {
        modelId: input.modelId,
        prompt: input.prompt,
        branchId: input.branchId,
      },
      signal,
    });
    const raw = await response.json().catch(() => ({}));
    return normalizeOmniAiJobResult(raw);
  }

  async getAiJob(jobId: string, signal?: AbortSignal): Promise<OmniAiJobResult> {
    const response = await this.request('GET', `/api/v1/ai/jobs/${encodeURIComponent(jobId)}`, { signal });
    const raw = await response.json().catch(() => ({}));
    return normalizeOmniAiJobResult(raw, jobId);
  }

  async getAiJobResult(jobId: string, signal?: AbortSignal): Promise<unknown> {
    const response = await this.request('GET', `/api/v1/ai/jobs/${encodeURIComponent(jobId)}/result`, { signal });
    return response.json().catch(() => ({}));
  }

  async getAiCreditControls(signal?: AbortSignal): Promise<unknown> {
    const response = await this.request('GET', '/api/v1/ai/credit-controls', { signal });
    return response.json().catch(() => ({}));
  }

  async listAiEvalPromptSets(signal?: AbortSignal): Promise<unknown> {
    const response = await this.request('GET', '/api/v1/ai/eval/prompt-sets', { signal });
    return (await readBoundedJsonResponse(response, AI_EVAL_RESPONSE_MAX_BYTES, {
      signal,
      timeoutMs: this.requestTimeoutMs,
    })).data;
  }

  async listAiEvalRuns(promptSetId: string, signal?: AbortSignal): Promise<unknown> {
    const normalizedPromptSetId = promptSetId.trim();
    if (!normalizedPromptSetId) throw new Error('An eval prompt-set id is required.');
    const response = await this.request('GET', '/api/v1/ai/eval/runs', {
      query: { prompt_set_id: normalizedPromptSetId },
      signal,
    });
    return (await readBoundedJsonResponse(response, AI_EVAL_RESPONSE_MAX_BYTES, {
      signal,
      timeoutMs: this.requestTimeoutMs,
    })).data;
  }

  async getAiEvalRun(runId: string, signal?: AbortSignal): Promise<unknown> {
    const normalizedRunId = runId.trim();
    if (!normalizedRunId) throw new Error('An eval run id is required.');
    const response = await this.request('GET', `/api/v1/ai/eval/runs/${encodeURIComponent(normalizedRunId)}`, { signal });
    return (await readBoundedJsonResponse(response, AI_EVAL_RESPONSE_MAX_BYTES, {
      signal,
      timeoutMs: this.requestTimeoutMs,
    })).data;
  }

  async getSchedule(scheduleId: string, signal?: AbortSignal): Promise<unknown> {
    const response = await this.request('GET', `/api/v1/schedules/${encodeURIComponent(scheduleId)}`, { signal });
    return response.json().catch(() => ({}));
  }

  async listScheduleRecipients(scheduleId: string, signal?: AbortSignal): Promise<unknown> {
    const response = await this.request('GET', `/api/v1/schedules/${encodeURIComponent(scheduleId)}/recipients`, { signal });
    return response.json().catch(() => ({}));
  }

  async cancelAiJob(jobId: string): Promise<OmniAiJobResult> {
    const response = await this.request('POST', `/api/v1/ai/jobs/${encodeURIComponent(jobId)}/cancel`);
    const raw = await response.json().catch(() => ({}));
    return normalizeOmniAiJobResult(raw, jobId);
  }

  async createLabel(label: OmniLabelRecord): Promise<void> {
    await this.request('POST', '/api/v1/labels', {
      body: {
        name: label.name,
        ...(label.color ? { color: label.color } : {}),
        ...(label.description ? { description: label.description } : {}),
      },
    });
  }

  async setDocumentLabels(identifier: string, add: string[]): Promise<void> {
    if (add.length === 0) return;
    await this.request('PATCH', `/api/v1/documents/${encodeURIComponent(identifier)}/labels`, {
      body: { add, remove: [] },
    });
  }

  async patchDocument(identifier: string, body: { description?: string | null }): Promise<void> {
    if (body.description === undefined) return;
    await this.documentsV2().updateDescription(identifier, body.description);
  }

  async getDocumentStateV2(documentId: string): Promise<Record<string, unknown>> {
    return this.documentsV2().getState(documentId);
  }

  async createDocumentDraft(documentId: string, patch: DocumentV2Patch): Promise<OmniDocumentDraftResult> {
    return this.documentsV2().createDraft(documentId, patch);
  }

  async patchDocumentDraft(documentId: string, draftId: string, patch: DocumentV2Patch): Promise<void> {
    await this.documentsV2().patchDraft(documentId, draftId, patch);
  }

  async publishDocumentDraft(documentId: string): Promise<void> {
    await this.documentsV2().publishDraft(documentId);
  }

  async requestDeleteDocument(identifier: string): Promise<void> {
    await this.request('DELETE', `/api/v1/documents/${encodeURIComponent(identifier)}`);
  }

  async exportDocument(identifier: string, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const response = await this.request('GET', `/api/unstable/documents/${encodeURIComponent(identifier)}/export`, { signal });
    return await response.json() as Record<string, unknown>;
  }

  async importDocument(input: {
    exportPayload: Record<string, unknown>;
    baseModelId: string;
    folderPath?: string;
    documentName: string;
  }): Promise<{ identifier: string; documentId: string; raw: unknown }> {
    const payload: Record<string, unknown> = {
      ...input.exportPayload,
      baseModelId: input.baseModelId,
      document: {
        ...((input.exportPayload.document && typeof input.exportPayload.document === 'object' && !Array.isArray(input.exportPayload.document))
          ? input.exportPayload.document as Record<string, unknown>
          : {}),
        name: input.documentName,
      },
    };
    if (input.folderPath) payload.folderPath = input.folderPath;
    delete payload.identifier;

    const response = await this.request('POST', '/api/unstable/documents/import', { body: payload });
    const raw = await response.json() as Record<string, unknown>;
    const identifier = firstString(raw.identifier, raw.miniUuid, nested(raw, 'document', 'identifier')) ?? '';
    const documentId = firstString(raw.documentId, raw.id, nested(raw, 'document', 'id')) ?? '';
    return { identifier, documentId, raw };
  }

  async moveDocument(documentId: string, folderPath: string): Promise<void> {
    await this.request('PUT', `/api/v1/documents/${encodeURIComponent(documentId)}/move`, {
      body: { folderPath },
    });
  }

  async refreshModel(modelId: string, branchId?: string): Promise<{ jobId?: string; status?: string; raw: unknown }> {
    const response = await this.request('POST', `/api/v1/models/${encodeURIComponent(modelId)}/refresh`, {
      query: branchId ? { branch_id: branchId } : undefined,
    });
    const raw = await response.json().catch(() => ({})) as Record<string, unknown>;
    return {
      jobId: firstString(raw.jobId, raw.job_id, raw.id, nested(raw, 'job', 'id')),
      status: firstString(raw.status, nested(raw, 'job', 'status')),
      raw,
    };
  }

  async getJobStatus(jobId: string): Promise<OmniJobStatusResult> {
    const response = await this.request('GET', `/api/v1/jobs/${encodeURIComponent(jobId)}/status`);
    const raw = await response.json().catch(() => ({})) as Record<string, unknown>;
    return {
      jobId: firstString(raw.jobId, raw.job_id, raw.id, nested(raw, 'job', 'id')) ?? jobId,
      status: (firstString(
        raw.status,
        raw.state,
        nested(raw, 'job', 'status'),
        nested(raw, 'job', 'state'),
      ) ?? 'UNKNOWN').toUpperCase(),
      raw,
    };
  }

  async listEmbedUsers(signal?: AbortSignal): Promise<OmniEmbedUserRecord[]> {
    const resources = await this.listScimResources('/api/scim/v2/embed/users', signal);
    const users = resources.map((raw) => {
        const row = raw as Record<string, unknown>;
        const meta = row.meta && typeof row.meta === 'object' && !Array.isArray(row.meta)
          ? row.meta as Record<string, unknown>
          : {};
        const extension = row['urn:omni:params:scim:schemas:extension:user:2.0'];
        const extensionRecord = extension && typeof extension === 'object' && !Array.isArray(extension)
          ? extension as Record<string, unknown>
          : {};
        const embedExternalId = firstString(row.embedExternalId, row.externalId) || '';
        const userName = firstString(row.userName, row.embedEmail, embedExternalId) || '';
        return {
          id: firstString(row.id, embedExternalId, userName) || '',
          displayName: String(row.displayName ?? ''),
          userName,
          active: row.active !== false,
          embedExternalId,
          embedEntity: firstString(row.embedEntity, extensionRecord.embedEntity, extensionRecord.embed_entity) || '',
          groups: Array.isArray(row.groups)
            ? row.groups.map((group) => {
              const groupRecord = group as Record<string, unknown>;
              return {
                display: String(groupRecord.display ?? ''),
                value: String(groupRecord.value ?? ''),
              };
            })
            : [],
          lastLogin: firstString(extensionRecord.lastLogin) ?? null,
          createdAt: firstString(meta.created),
        };
      }).filter((user) => user.id);
    return [...new Map(users.map((user) => [user.id, user])).values()];
  }

}
