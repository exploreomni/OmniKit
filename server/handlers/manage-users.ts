import { assertSafeOutboundUrl, validateBaseUrl, jsonHeaders } from '../security';
import {
  buildIdentityAccessEvidence,
  IdentityAccessEvidenceError,
  listIdentityAccessUsers,
  type IdentityAccessContentRole,
  type IdentityAccessEvidenceInput,
  type IdentityAccessEvidenceReader,
  type IdentityAccessEvidenceReport,
  type IdentityAccessModelRole,
} from '../services/identityAccessEvidence';
import { OmniClient } from '../services/omniClient';
import {
  getInstance,
  VAULT_SESSION_ABORT_SIGNAL,
  type SavedInstance,
} from '../services/nativeVault';

export const USER_MODEL_ROLE_NAMES = [
  "VIEWER",
  "QUERY_TOPICS",
  "QUERIER",
  "MODELER",
  "CONNECTION_ADMIN",
  "NO_ACCESS",
] as const;

export type UserModelRoleName = typeof USER_MODEL_ROLE_NAMES[number];

export interface UserModelRoleRecord {
  roleName: string;
  baseRole: string;
  modelId: string | null;
  connectionId: string | null;
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

interface UserModelRoleAssignmentProof {
  userId: string;
  roleName: UserModelRoleName;
  modelId: string | null;
  connectionId: string | null;
}

export interface ManageUsersDependencies {
  fetchImpl?: typeof fetch;
  assertSafeUrl?: (url: string) => Promise<void>;
  timeoutMs?: number;
  verificationDelaysMs?: readonly number[];
  buildAccessEvidence?: (
    input: IdentityAccessEvidenceInput,
    signal: AbortSignal,
    instance: SavedInstance,
  ) => Promise<IdentityAccessEvidenceReport>;
  getSavedInstance?: typeof getInstance;
}

interface RequestBody {
  base_url: string;
  api_key: string;
  action: "list" | "list_attributes" | "find" | "create" | "update" | "delete" | "list_model_roles" | "assign_model_role" | "debug_access";
  count?: number;
  start_index?: number;
  email?: string;
  user_id?: string;
  user_data?: Record<string, unknown>;
  role_name?: UserModelRoleName;
  model_id?: string;
  connection_id?: string;
  instance_id?: unknown;
  principal_type?: unknown;
  principal_identifier?: unknown;
  folder_id?: unknown;
  document_id?: unknown;
  expected_access?: unknown;
}

interface UserModelRoleScope {
  userId: string;
  modelId?: string;
  connectionId?: string;
}

const USER_MODEL_ROLE_NAME_SET = new Set<string>(USER_MODEL_ROLE_NAMES);
const OMNI_ID_PATTERN = /^[\w-]+$/;
const MAX_MODEL_ROLE_RECORDS = 1_000;
const MAX_MODEL_ROLE_RESPONSE_BYTES = 512 * 1024;
const USER_REQUEST_TIMEOUT_MS = 15_000;
const MODEL_ROLE_TIMEOUT_MS = 15_000;
const MODEL_ROLE_VERIFICATION_DELAYS_MS = [0, 250, 750] as const;
const RETRYABLE_MODEL_ROLE_VERIFICATION_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

class ModelRoleRequestError extends Error {}

class ModelRoleResponseError extends Error {
  readonly diagnostic?: string;
  constructor(readonly code: "INVALID_MODEL_ROLE_RESPONSE" | "MODEL_ROLE_ASSIGNMENT_NOT_VERIFIED", diagnostic?: string) {
    super(code);
    this.name = "ModelRoleResponseError";
    this.diagnostic = diagnostic;
  }
}

class ModelRoleTransportError extends Error {
  constructor(
    readonly status: number,
    readonly code: "MODEL_ROLE_OUTBOUND_REJECTED" | "MODEL_ROLE_REQUEST_CANCELLED" | "MODEL_ROLE_REQUEST_TIMEOUT",
  ) {
    super(code);
    this.name = "ModelRoleTransportError";
  }
}

class UserTransportError extends Error {
  constructor(
    readonly status: 499 | 504,
    readonly code: "USER_REQUEST_CANCELLED" | "USER_REQUEST_TIMEOUT",
  ) {
    super(code);
    this.name = "UserTransportError";
  }
}

class ModelRoleUpstreamHttpError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
    this.name = "ModelRoleUpstreamHttpError";
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: jsonHeaders });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function performUserRequest(
  req: Request,
  url: string,
  init: RequestInit,
  dependencies: ManageUsersDependencies,
): Promise<Response> {
  if (req.signal.aborted) {
    throw new UserTransportError(499, "USER_REQUEST_CANCELLED");
  }

  const controller = new AbortController();
  let timedOut = false;
  let rejectBoundary: (reason: UserTransportError) => void = () => undefined;
  const boundary = new Promise<never>((_resolve, reject) => {
    rejectBoundary = reject;
  });
  const cancel = () => {
    controller.abort(req.signal.reason);
    rejectBoundary(new UserTransportError(499, "USER_REQUEST_CANCELLED"));
  };
  req.signal.addEventListener("abort", cancel, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
    rejectBoundary(new UserTransportError(504, "USER_REQUEST_TIMEOUT"));
  }, dependencies.timeoutMs ?? USER_REQUEST_TIMEOUT_MS);

  const operation = (async () => {
    const response = await (dependencies.fetchImpl || fetch)(url, {
      ...init,
      redirect: "manual",
      signal: controller.signal,
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return json({ error: `Omni user request failed with HTTP ${response.status}.` }, response.status);
    }
    if (response.status === 204) return json({ success: true });
    return json(await response.json());
  })();

  try {
    return await Promise.race([operation, boundary]);
  } catch (error) {
    if (error instanceof UserTransportError) throw error;
    if (timedOut) throw new UserTransportError(504, "USER_REQUEST_TIMEOUT");
    if (req.signal.aborted) throw new UserTransportError(499, "USER_REQUEST_CANCELLED");
    throw error;
  } finally {
    clearTimeout(timeout);
    req.signal.removeEventListener("abort", cancel);
  }
}

function isOmniId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && OMNI_ID_PATTERN.test(value);
}

function isSafeFilterEmail(value: unknown): value is string {
  return typeof value === "string"
    && value.length <= 320
    && value.trim() === value
    && /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9.-]+$/.test(value);
}

function isUserModelRoleName(value: unknown): value is UserModelRoleName {
  return typeof value === "string" && USER_MODEL_ROLE_NAME_SET.has(value);
}

function isSafeRoleSourceType(value: unknown): value is string {
  return typeof value === "string"
    && /^[A-Za-z][A-Za-z _-]{0,79}$/.test(value);
}

function stringInput(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function savedInstanceId(value: unknown): string {
  const instanceId = stringInput(value).trim();
  if (!instanceId || instanceId.length > 500 || [...instanceId].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  })) {
    throw new IdentityAccessEvidenceError('INVALID_INPUT', 'A valid saved instance ID is required.', 400);
  }
  return instanceId;
}

function identityAccessInput(body: RequestBody, instance: SavedInstance): IdentityAccessEvidenceInput {
  if (body.expected_access !== undefined && !isRecord(body.expected_access)) {
    throw new IdentityAccessEvidenceError('INVALID_INPUT', 'Expected access must be an object.', 400);
  }
  const expected = isRecord(body.expected_access) ? body.expected_access : undefined;
  return {
    instanceId: instance.id,
    instanceLabel: instance.label,
    principalType: body.principal_type as IdentityAccessEvidenceInput['principalType'],
    principalIdentifier: stringInput(body.principal_identifier),
    ...(body.connection_id !== undefined ? { connectionId: stringInput(body.connection_id) } : {}),
    ...(body.model_id !== undefined ? { modelId: stringInput(body.model_id) } : {}),
    ...(body.folder_id !== undefined ? { folderId: stringInput(body.folder_id) } : {}),
    ...(body.document_id !== undefined ? { documentId: stringInput(body.document_id) } : {}),
    ...(expected ? {
      expectedAccess: {
        ...(Object.prototype.hasOwnProperty.call(expected, 'active') ? { active: expected.active as boolean } : {}),
        ...(Object.prototype.hasOwnProperty.call(expected, 'modelRole') ? { modelRole: expected.modelRole as IdentityAccessModelRole } : {}),
        ...(Object.prototype.hasOwnProperty.call(expected, 'contentRole') ? { contentRole: expected.contentRole as IdentityAccessContentRole } : {}),
      },
    } : {}),
  };
}

function accessEvidenceReader(
  client: OmniClient,
  listIdentityUsers: IdentityAccessEvidenceReader['listIdentityUsers'],
): IdentityAccessEvidenceReader {
  return {
    listIdentityUsers,
    listUserGroups: () => client.listUserGroups(),
    getUserGroup: (groupId) => client.getUserGroup(groupId),
    listUserModelRoles: (userId, options) => client.listUserModelRoles(userId, options),
    listUserGroupModelRoles: (groupId, options) => client.listUserGroupModelRoles(groupId, options),
    listDocumentAccessInventory: (documentId, options, signal) => client.listDocumentAccessInventory(documentId, options, signal),
  };
}

async function collectIdentityAccessEvidence(
  req: Request,
  instance: SavedInstance,
  input: IdentityAccessEvidenceInput,
  dependencies: ManageUsersDependencies,
): Promise<IdentityAccessEvidenceReport> {
  const vaultSignal = instance[VAULT_SESSION_ABORT_SIGNAL];
  const evidenceSignal = vaultSignal ? AbortSignal.any([req.signal, vaultSignal]) : req.signal;
  if (dependencies.buildAccessEvidence) return dependencies.buildAccessEvidence(input, evidenceSignal, instance);
  const cleanUrl = instance.baseUrl.replace(/\/+$/, '');
  const client = new OmniClient(
    instance,
    {
      ...(dependencies.fetchImpl ? { fetchImpl: dependencies.fetchImpl } : {}),
      maxReadRetries: 0,
      requestTimeoutMs: dependencies.timeoutMs ?? MODEL_ROLE_TIMEOUT_MS,
    },
  );
  const authHeaders = {
    Authorization: `Bearer ${instance.apiKey}`,
    'Content-Type': 'application/json',
  };
  const listStrictIdentityUsers: IdentityAccessEvidenceReader['listIdentityUsers'] = (signal) => (
    listIdentityAccessUsers(async (count, startIndex) => {
      const url = new URL(`${cleanUrl}/api/scim/v2/users`);
      url.searchParams.set('count', String(count));
      url.searchParams.set('startIndex', String(startIndex));
      return withModelRoleUpstreamResponse(
        req,
        url.toString(),
        { method: 'GET', headers: authHeaders },
        dependencies,
        async (response) => {
          if (!response.ok) {
            await response.body?.cancel().catch(() => undefined);
            throw new Error('The SCIM user collection could not be read.');
          }
          return readBoundedJson(response);
        },
        evidenceSignal,
      );
    }, signal)
  );
  return buildIdentityAccessEvidence(input, accessEvidenceReader(client, listStrictIdentityUsers), evidenceSignal);
}

function modelRoleScope(body: RequestBody): UserModelRoleScope {
  if (!isOmniId(body.user_id)) {
    throw new ModelRoleRequestError("user_id must be a valid Omni identifier for model-role actions.");
  }
  if (body.model_id !== undefined && !isOmniId(body.model_id)) {
    throw new ModelRoleRequestError("model_id must be a valid Omni identifier when provided.");
  }
  if (body.connection_id !== undefined && !isOmniId(body.connection_id)) {
    throw new ModelRoleRequestError("connection_id must be a valid Omni identifier when provided.");
  }
  if (!body.model_id && !body.connection_id) {
    throw new ModelRoleRequestError("model_id or connection_id is required for a scoped model-role read.");
  }
  return {
    userId: body.user_id,
    ...(body.model_id ? { modelId: body.model_id } : {}),
    ...(body.connection_id ? { connectionId: body.connection_id } : {}),
  };
}

function assignmentRole(body: RequestBody, scope: UserModelRoleScope): UserModelRoleName {
  if (!isUserModelRoleName(body.role_name)) {
    throw new ModelRoleRequestError("role_name must be one of the supported built-in model roles.");
  }
  if (body.role_name === "CONNECTION_ADMIN") {
    if (!scope.connectionId) {
      throw new ModelRoleRequestError("connection_id is required for CONNECTION_ADMIN.");
    }
    if (scope.modelId) {
      throw new ModelRoleRequestError("model_id is not permitted for CONNECTION_ADMIN.");
    }
  } else if (!scope.modelId) {
    throw new ModelRoleRequestError("model_id is required for non-admin model roles.");
  }
  return body.role_name;
}

function isSafeModelRoleString(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.trim() !== value || value.length > 160) return false;
  if (value.includes('@') || value.includes('<') || value.includes('>') || [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  })) return false;
  if (/(?:https?:\/\/|\bbearer\s+|\b(?:api[_ -]?key|authorization|token|secret|password|signature)\b\s*[:=])/i.test(value)) {
    return false;
  }
  return true;
}

function modelRoleUrl(cleanUrl: string, scope: UserModelRoleScope, includeScope = true): string {
  const url = new URL(`${cleanUrl}/api/v1/users/${encodeURIComponent(scope.userId)}/model-roles`);
  if (includeScope && scope.modelId) url.searchParams.set("modelId", scope.modelId);
  if (includeScope && scope.connectionId) url.searchParams.set("connectionId", scope.connectionId);
  return url.toString();
}

async function withModelRoleUpstreamResponse<T>(
  req: Request,
  url: string,
  init: RequestInit,
  dependencies: ManageUsersDependencies,
  consume: (response: Response) => Promise<T>,
  operationSignal: AbortSignal = req.signal,
): Promise<T> {
  const assertSafeUrl = dependencies.assertSafeUrl
    || ((value: string) => assertSafeOutboundUrl(value, { label: "base_url" }));
  try {
    await assertSafeUrl(url);
  } catch {
    throw new ModelRoleTransportError(400, "MODEL_ROLE_OUTBOUND_REJECTED");
  }
  if (operationSignal.aborted) {
    throw new ModelRoleTransportError(499, "MODEL_ROLE_REQUEST_CANCELLED");
  }

  const controller = new AbortController();
  let timedOut = false;
  let upstreamResponse: Response | undefined;
  let rejectBoundary: (reason: ModelRoleTransportError) => void = () => undefined;
  const boundary = new Promise<never>((_resolve, reject) => {
    rejectBoundary = reject;
  });
  const forwardAbort = () => {
    controller.abort(operationSignal.reason);
    void upstreamResponse?.body?.cancel().catch(() => undefined);
    rejectBoundary(new ModelRoleTransportError(499, "MODEL_ROLE_REQUEST_CANCELLED"));
  };
  operationSignal.addEventListener("abort", forwardAbort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException("The model-role request timed out.", "TimeoutError"));
    void upstreamResponse?.body?.cancel().catch(() => undefined);
    rejectBoundary(new ModelRoleTransportError(504, "MODEL_ROLE_REQUEST_TIMEOUT"));
  }, dependencies.timeoutMs ?? MODEL_ROLE_TIMEOUT_MS);

  const operation = (async () => {
    upstreamResponse = await (dependencies.fetchImpl || fetch)(url, {
      ...init,
      redirect: "manual",
      signal: controller.signal,
    });
    return consume(upstreamResponse);
  })();

  try {
    return await Promise.race([operation, boundary]);
  } catch (error) {
    if (error instanceof ModelRoleTransportError) throw error;
    if (timedOut) throw new ModelRoleTransportError(504, "MODEL_ROLE_REQUEST_TIMEOUT");
    if (operationSignal.aborted) throw new ModelRoleTransportError(499, "MODEL_ROLE_REQUEST_CANCELLED");
    throw error;
  } finally {
    clearTimeout(timeout);
    operationSignal.removeEventListener("abort", forwardAbort);
  }
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_MODEL_ROLE_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new ModelRoleResponseError("INVALID_MODEL_ROLE_RESPONSE");
  }
  if (!response.body) throw new ModelRoleResponseError("INVALID_MODEL_ROLE_RESPONSE");

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_MODEL_ROLE_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new ModelRoleResponseError("INVALID_MODEL_ROLE_RESPONSE");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text) as unknown;
  } catch (error) {
    if (error instanceof ModelRoleResponseError) throw error;
    throw new ModelRoleResponseError("INVALID_MODEL_ROLE_RESPONSE");
  }
}

function isOmniIdOrNull(value: unknown): value is string | null {
  return value === null || isOmniId(value);
}

function parseModelRoleRecord(value: unknown, scope: UserModelRoleScope): UserModelRoleRecord {
  if (!isRecord(value)) {
    throw new ModelRoleResponseError("INVALID_MODEL_ROLE_RESPONSE");
  }
  const roleName = isSafeModelRoleString(value.roleName) ? value.roleName : undefined;
  const baseRole = isSafeModelRoleString(value.baseRole) ? value.baseRole : undefined;
  const modelId = isOmniIdOrNull(value.modelId) ? value.modelId : undefined;
  const connectionId = isOmniIdOrNull(value.connectionId) ? value.connectionId : undefined;
  const priority = Number.isSafeInteger(value.priority) && Number(value.priority) >= 0
    ? Number(value.priority)
    : undefined;
  const resolved = typeof value.resolved === "boolean" ? value.resolved : undefined;
  const fromType = isRecord(value.from) && isSafeRoleSourceType(value.from.type)
    ? value.from.type
    : undefined;
  const failures: string[] = [];
  if (roleName === undefined) failures.push('roleName');
  if (baseRole === undefined) failures.push('baseRole');
  if (modelId === undefined) failures.push('modelId');
  if (connectionId === undefined) failures.push('connectionId');
  if (!Number.isSafeInteger(value.priority) || Number(value.priority) < 0) failures.push('priority');
  if (resolved === undefined) failures.push('resolved');
  if (!isRecord(value.from)) failures.push('from');
  else if (fromType === undefined) failures.push('from.type');
  if (
    failures.length > 0
    || roleName === undefined
    || baseRole === undefined
    || modelId === undefined
    || connectionId === undefined
    || priority === undefined
    || resolved === undefined
    || fromType === undefined
  ) {
    throw new ModelRoleResponseError('INVALID_MODEL_ROLE_RESPONSE', `invalid_fields=${failures.join(',')}`);
  }
  if (scope.modelId && modelId !== scope.modelId) {
    throw new ModelRoleResponseError("INVALID_MODEL_ROLE_RESPONSE");
  }
  if (scope.connectionId && connectionId !== scope.connectionId) {
    throw new ModelRoleResponseError("INVALID_MODEL_ROLE_RESPONSE");
  }
  return {
    roleName,
    baseRole,
    modelId,
    connectionId,
    priority,
    resolved,
    from: { type: fromType },
  };
}

function parseModelRoleAssignmentProof(
  value: unknown,
  scope: UserModelRoleScope,
  roleName: UserModelRoleName,
): UserModelRoleAssignmentProof {
  if (
    !isRecord(value)
    || value.userId !== scope.userId
    || value.roleName !== roleName
    || !isOmniIdOrNull(value.modelId)
    || !isOmniIdOrNull(value.connectionId)
    || (scope.modelId !== undefined && value.modelId !== scope.modelId)
    || (scope.connectionId !== undefined && value.connectionId !== scope.connectionId)
  ) {
    throw new ModelRoleResponseError("INVALID_MODEL_ROLE_RESPONSE");
  }
  return {
    userId: value.userId,
    roleName,
    modelId: value.modelId,
    connectionId: value.connectionId,
  };
}

async function readModelRoles(
  req: Request,
  cleanUrl: string,
  authHeaders: Record<string, string>,
  scope: UserModelRoleScope,
  dependencies: ManageUsersDependencies,
): Promise<UserModelRoleListResponse> {
  const payload = await withModelRoleUpstreamResponse(
    req,
    modelRoleUrl(cleanUrl, scope),
    { method: "GET", headers: authHeaders },
    dependencies,
    async (response) => {
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new ModelRoleUpstreamHttpError(response.status);
      }
      return readBoundedJson(response);
    },
  );
  if (!isRecord(payload) || !Array.isArray(payload.results) || payload.results.length > MAX_MODEL_ROLE_RECORDS) {
    throw new ModelRoleResponseError("INVALID_MODEL_ROLE_RESPONSE");
  }
  if (!isOmniId(payload.membershipId)) {
    throw new ModelRoleResponseError("INVALID_MODEL_ROLE_RESPONSE");
  }
  const roles = payload.results.map((role) => parseModelRoleRecord(role, scope));
  return {
    membershipId: payload.membershipId,
    results: roles,
  };
}

function directAssignedModelRole(
  roles: UserModelRoleRecord[],
  assignment: UserModelRoleAssignmentProof,
  roleName: UserModelRoleName,
): UserModelRoleRecord | undefined {
  return roles.find((candidate) => (
    candidate.roleName === roleName
    && candidate.modelId === assignment.modelId
    && candidate.connectionId === assignment.connectionId
    && (candidate.from.type === "USER" || candidate.from.type === "User Role")
  ));
}

async function waitForModelRoleVerification(req: Request, delayMs: number): Promise<void> {
  if (delayMs <= 0) return;
  if (req.signal.aborted) throw new ModelRoleTransportError(499, "MODEL_ROLE_REQUEST_CANCELLED");

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      req.signal.removeEventListener("abort", abort);
      resolve();
    }, delayMs);
    const abort = () => {
      clearTimeout(timeout);
      reject(new ModelRoleTransportError(499, "MODEL_ROLE_REQUEST_CANCELLED"));
    };
    req.signal.addEventListener("abort", abort, { once: true });
  });
}

async function verifyAssignedModelRole(
  req: Request,
  cleanUrl: string,
  authHeaders: Record<string, string>,
  scope: UserModelRoleScope,
  assignment: UserModelRoleAssignmentProof,
  roleName: UserModelRoleName,
  dependencies: ManageUsersDependencies,
): Promise<{ verifiedRoles: UserModelRoleListResponse; role: UserModelRoleRecord }> {
  const requestedDelays = dependencies.verificationDelaysMs;
  const delays = requestedDelays && requestedDelays.length > 0
    ? requestedDelays.slice(0, 5).map((delay) => (
      Number.isFinite(delay) ? Math.min(Math.max(delay, 0), 2_000) : 0
    ))
    : MODEL_ROLE_VERIFICATION_DELAYS_MS;

  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    await waitForModelRoleVerification(req, delays[attempt]);
    try {
      const verifiedRoles = await readModelRoles(req, cleanUrl, authHeaders, scope, dependencies);
      const role = directAssignedModelRole(verifiedRoles.results, assignment, roleName);
      if (role) return { verifiedRoles, role };
    } catch (error) {
      const canRetry = error instanceof ModelRoleUpstreamHttpError
        && RETRYABLE_MODEL_ROLE_VERIFICATION_STATUSES.has(error.status)
        && attempt < delays.length - 1;
      if (canRetry) continue;
      if (error instanceof ModelRoleUpstreamHttpError) {
        throw new ModelRoleResponseError("MODEL_ROLE_ASSIGNMENT_NOT_VERIFIED");
      }
      throw error;
    }
  }

  throw new ModelRoleResponseError("MODEL_ROLE_ASSIGNMENT_NOT_VERIFIED");
}

export default async function handler(
  req: Request,
  dependencies: ManageUsersDependencies = {},
): Promise<Response> {
  try {
    const body: RequestBody = await req.json();
    const { base_url, api_key, action } = body;

    if (action === 'debug_access') {
      const instanceId = savedInstanceId(body.instance_id);
      const instance = (dependencies.getSavedInstance || getInstance)(instanceId);
      if (!instance) return json({ error: 'Saved Omni instance not found.', code: 'SAVED_INSTANCE_NOT_FOUND' }, 404);
      return json(await collectIdentityAccessEvidence(
        req,
        instance,
        identityAccessInput(body, instance),
        dependencies,
      ));
    }

    const urlError = validateBaseUrl(base_url);
    if (urlError) {
      return new Response(JSON.stringify({ error: urlError }), { status: 400, headers: jsonHeaders });
    }

    if (!api_key || !action) {
      return new Response(
        JSON.stringify({ error: "base_url, api_key, and action are required." }),
        { status: 400, headers: jsonHeaders }
      );
    }

    const cleanUrl = base_url.replace(/\/+$/, "");
    const scimBase = `${cleanUrl}/api/scim/v2/users`;
    const authHeaders = {
      Authorization: `Bearer ${api_key}`,
      "Content-Type": "application/json",
    };

    let upstreamUrl = scimBase;
    let upstreamInit: RequestInit;

    switch (action) {
      case "list": {
        const count = body.count || 100;
        const startIndex = body.start_index || 1;
        upstreamUrl = `${scimBase}?count=${count}&startIndex=${startIndex}`;
        upstreamInit = { method: "GET", headers: authHeaders };
        break;
      }

      case "list_attributes": {
        upstreamUrl = `${cleanUrl}/api/v1/user-attributes`;
        upstreamInit = {
          method: "GET",
          headers: authHeaders,
        };
        break;
      }

      case "find": {
        if (!isSafeFilterEmail(body.email)) {
          return new Response(
            JSON.stringify({ error: "A valid email is required for find action." }),
            { status: 400, headers: jsonHeaders }
          );
        }
        upstreamUrl = `${scimBase}?filter=${encodeURIComponent(`userName eq "${body.email}"`)}`;
        upstreamInit = { method: "GET", headers: authHeaders };
        break;
      }

      case "create": {
        if (!body.user_data) {
          return new Response(
            JSON.stringify({ error: "user_data is required for create action." }),
            { status: 400, headers: jsonHeaders }
          );
        }
        upstreamInit = {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify(body.user_data),
        };
        break;
      }

      case "update": {
        if (!body.user_id || !body.user_data) {
          return new Response(
            JSON.stringify({ error: "user_id and user_data are required for update action." }),
            { status: 400, headers: jsonHeaders }
          );
        }
        upstreamUrl = `${scimBase}/${encodeURIComponent(body.user_id)}`;
        upstreamInit = {
          method: "PUT",
          headers: authHeaders,
          body: JSON.stringify(body.user_data),
        };
        break;
      }

      case "delete": {
        if (!body.user_id) {
          return new Response(
            JSON.stringify({ error: "user_id is required for delete action." }),
            { status: 400, headers: jsonHeaders }
          );
        }
        upstreamUrl = `${scimBase}/${encodeURIComponent(body.user_id)}`;
        upstreamInit = {
          method: "DELETE",
          headers: authHeaders,
        };
        break;
      }

      case "list_model_roles": {
        const scope = modelRoleScope(body);
        return json(await readModelRoles(req, cleanUrl, authHeaders, scope, dependencies));
      }

      case "assign_model_role": {
        const scope = modelRoleScope(body);
        const roleName = assignmentRole(body, scope);
        const assignmentPayload = await withModelRoleUpstreamResponse(
          req,
          modelRoleUrl(cleanUrl, scope, false),
          {
            method: "POST",
            headers: authHeaders,
            body: JSON.stringify({
              roleName,
              ...(scope.modelId ? { modelId: scope.modelId } : {}),
              ...(scope.connectionId ? { connectionId: scope.connectionId } : {}),
            }),
          },
          dependencies,
          async (response) => {
            if (!response.ok) {
              await response.body?.cancel().catch(() => undefined);
              throw new ModelRoleUpstreamHttpError(response.status);
            }
            return readBoundedJson(response);
          },
        );
        const assignment = parseModelRoleAssignmentProof(
          assignmentPayload,
          scope,
          roleName,
        );

        const verificationScope = {
          userId: scope.userId,
          ...(assignment.modelId ? { modelId: assignment.modelId } : {}),
          ...(assignment.connectionId ? { connectionId: assignment.connectionId } : {}),
        };
        const { verifiedRoles, role } = await verifyAssignedModelRole(
          req,
          cleanUrl,
          authHeaders,
          verificationScope,
          assignment,
          roleName,
          dependencies,
        );
        return json({ ...verifiedRoles, assignment, role, verified: true });
      }

      default:
        return new Response(
          JSON.stringify({ error: "Unknown action." }),
          { status: 400, headers: jsonHeaders }
        );
    }

    return await performUserRequest(req, upstreamUrl, upstreamInit, dependencies);
  } catch (error) {
    if (error instanceof IdentityAccessEvidenceError) {
      return json({ error: error.message, code: error.code }, error.status);
    }
    if ((error as { statusCode?: unknown }).statusCode === 423) {
      return json({ error: 'Unlock the native vault before collecting identity access evidence.', code: 'VAULT_LOCKED' }, 423);
    }
    if (error instanceof ModelRoleRequestError) return json({ error: error.message }, 400);
    if (error instanceof ModelRoleResponseError) {
      const message = error.code === "MODEL_ROLE_ASSIGNMENT_NOT_VERIFIED"
        ? "Omni did not verify the requested user model-role assignment."
        : `Omni returned an invalid user model-role response.${error.diagnostic ? ` [${error.diagnostic}]` : ''}`;
      return json({ error: message, code: error.code }, 502);
    }
    if (error instanceof ModelRoleTransportError) {
      const message = error.code === "MODEL_ROLE_REQUEST_TIMEOUT"
        ? "The Omni user model-role request timed out."
        : error.code === "MODEL_ROLE_REQUEST_CANCELLED"
          ? "The Omni user model-role request was cancelled."
          : "The Omni user model-role destination was rejected.";
      return json({ error: message, code: error.code }, error.status);
    }
    if (error instanceof ModelRoleUpstreamHttpError) {
      return json({ error: `Omni user model-role request failed with HTTP ${error.status}.` }, error.status);
    }
    if (error instanceof UserTransportError) {
      const message = error.code === "USER_REQUEST_TIMEOUT"
        ? "The Omni user request timed out."
        : "The Omni user request was cancelled.";
      return json({ error: message, code: error.code }, error.status);
    }
    return new Response(JSON.stringify({ error: "The Omni user request could not be completed." }), {
      status: 500,
      headers: jsonHeaders,
    });
  }
}
