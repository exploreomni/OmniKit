import { assertSafeOutboundUrl, validateBaseUrl, jsonHeaders } from '../security';

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
}

interface RequestBody {
  base_url: string;
  api_key: string;
  action: "list" | "list_attributes" | "find" | "create" | "update" | "delete" | "list_model_roles" | "assign_model_role";
  count?: number;
  start_index?: number;
  email?: string;
  user_id?: string;
  user_data?: Record<string, unknown>;
  role_name?: UserModelRoleName;
  model_id?: string;
  connection_id?: string;
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
const MODEL_ROLE_TIMEOUT_MS = 15_000;

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
  } else if (!scope.modelId) {
    throw new ModelRoleRequestError("model_id is required for non-admin model roles.");
  }
  return body.role_name;
}

function isSafeModelRoleString(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.trim() !== value || value.length > 160) return false;
  if (/[@<>\u0000-\u001f\u007f]/.test(value)) return false;
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

async function fetchModelRoleUpstream(
  req: Request,
  url: string,
  init: RequestInit,
  dependencies: ManageUsersDependencies,
): Promise<Response> {
  const assertSafeUrl = dependencies.assertSafeUrl
    || ((value: string) => assertSafeOutboundUrl(value, { label: "base_url" }));
  try {
    await assertSafeUrl(url);
  } catch {
    throw new ModelRoleTransportError(400, "MODEL_ROLE_OUTBOUND_REJECTED");
  }

  const controller = new AbortController();
  let timedOut = false;
  const forwardAbort = () => controller.abort(req.signal.reason);
  if (req.signal.aborted) controller.abort(req.signal.reason);
  else req.signal.addEventListener("abort", forwardAbort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException("The model-role request timed out.", "TimeoutError"));
  }, dependencies.timeoutMs ?? MODEL_ROLE_TIMEOUT_MS);

  try {
    return await (dependencies.fetchImpl || fetch)(url, {
      ...init,
      redirect: "manual",
      signal: controller.signal,
    });
  } catch (error) {
    if (timedOut) throw new ModelRoleTransportError(504, "MODEL_ROLE_REQUEST_TIMEOUT");
    if (req.signal.aborted) throw new ModelRoleTransportError(499, "MODEL_ROLE_REQUEST_CANCELLED");
    throw error;
  } finally {
    clearTimeout(timeout);
    req.signal.removeEventListener("abort", forwardAbort);
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
  if (roleName === undefined) failures.push(`roleName=${JSON.stringify(value.roleName)}`);
  if (baseRole === undefined) failures.push(`baseRole=${JSON.stringify(value.baseRole)}`);
  if (modelId === undefined) failures.push(`modelId=${JSON.stringify(value.modelId)}`);
  if (connectionId === undefined) failures.push(`connectionId=${JSON.stringify(value.connectionId)}`);
  if (!Number.isSafeInteger(value.priority)) failures.push(`priority=${JSON.stringify(value.priority)}`);
  else if (Number(value.priority) < 0) failures.push(`priority_negative=${value.priority}`);
  if (resolved === undefined) failures.push(`resolved=${JSON.stringify(value.resolved)}`);
  if (!isRecord(value.from)) failures.push(`from=${JSON.stringify(value.from)}`);
  else if (fromType === undefined) failures.push(`from.type=${JSON.stringify(value.from.type)}`);
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
    throw new ModelRoleResponseError("INVALID_MODEL_ROLE_RESPONSE", failures.join("; "));
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
  const response = await fetchModelRoleUpstream(
    req,
    modelRoleUrl(cleanUrl, scope),
    { method: "GET", headers: authHeaders },
    dependencies,
  );
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    throw new ModelRoleUpstreamHttpError(response.status);
  }
  const payload = await readBoundedJson(response);
  if (!isRecord(payload) || !Array.isArray(payload.results) || payload.results.length > MAX_MODEL_ROLE_RECORDS) {
    throw new ModelRoleResponseError("INVALID_MODEL_ROLE_RESPONSE");
  }
  if (!isOmniId(payload.membershipId) || payload.membershipId !== scope.userId) {
    throw new ModelRoleResponseError("INVALID_MODEL_ROLE_RESPONSE");
  }
  const roles = payload.results.map((role) => parseModelRoleRecord(role, scope));
  return {
    membershipId: payload.membershipId,
    results: roles,
  };
}

export default async function handler(
  req: Request,
  dependencies: ManageUsersDependencies = {},
): Promise<Response> {
  try {
    const body: RequestBody = await req.json();
    const { base_url, api_key, action } = body;

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

    let response: Response;

    switch (action) {
      case "list": {
        const count = body.count || 100;
        const startIndex = body.start_index || 1;
        response = await fetch(
          `${scimBase}?count=${count}&startIndex=${startIndex}`,
          { method: "GET", headers: authHeaders, redirect: "manual", signal: req.signal }
        );
        break;
      }

      case "list_attributes": {
        response = await fetch(`${cleanUrl}/api/v1/user-attributes`, {
          method: "GET",
          headers: authHeaders,
          redirect: "manual",
          signal: req.signal,
        });
        break;
      }

      case "find": {
        if (!isSafeFilterEmail(body.email)) {
          return new Response(
            JSON.stringify({ error: "A valid email is required for find action." }),
            { status: 400, headers: jsonHeaders }
          );
        }
        response = await fetch(
          `${scimBase}?filter=${encodeURIComponent(`userName eq "${body.email}"`)}`,
          { method: "GET", headers: authHeaders, redirect: "manual", signal: req.signal }
        );
        break;
      }

      case "create": {
        if (!body.user_data) {
          return new Response(
            JSON.stringify({ error: "user_data is required for create action." }),
            { status: 400, headers: jsonHeaders }
          );
        }
        response = await fetch(scimBase, {
          method: "POST",
          headers: authHeaders,
          body: JSON.stringify(body.user_data),
          redirect: "manual",
          signal: req.signal,
        });
        break;
      }

      case "update": {
        if (!body.user_id || !body.user_data) {
          return new Response(
            JSON.stringify({ error: "user_id and user_data are required for update action." }),
            { status: 400, headers: jsonHeaders }
          );
        }
        response = await fetch(`${scimBase}/${encodeURIComponent(body.user_id)}`, {
          method: "PUT",
          headers: authHeaders,
          body: JSON.stringify(body.user_data),
          redirect: "manual",
          signal: req.signal,
        });
        break;
      }

      case "delete": {
        if (!body.user_id) {
          return new Response(
            JSON.stringify({ error: "user_id is required for delete action." }),
            { status: 400, headers: jsonHeaders }
          );
        }
        response = await fetch(`${scimBase}/${encodeURIComponent(body.user_id)}`, {
          method: "DELETE",
          headers: authHeaders,
          redirect: "manual",
          signal: req.signal,
        });

        if (response.status === 204) {
          return new Response(
            JSON.stringify({ success: true }),
            { headers: jsonHeaders }
          );
        }
        break;
      }

      case "list_model_roles": {
        const scope = modelRoleScope(body);
        return json(await readModelRoles(req, cleanUrl, authHeaders, scope, dependencies));
      }

      case "assign_model_role": {
        const scope = modelRoleScope(body);
        const roleName = assignmentRole(body, scope);
        const response = await fetchModelRoleUpstream(
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
        );
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          throw new ModelRoleUpstreamHttpError(response.status);
        }
        const assignment = parseModelRoleAssignmentProof(
          await readBoundedJson(response),
          scope,
          roleName,
        );

        const verificationScope = {
          userId: scope.userId,
          ...(assignment.modelId ? { modelId: assignment.modelId } : {}),
          ...(assignment.connectionId ? { connectionId: assignment.connectionId } : {}),
        };
        const verifiedRoles = await readModelRoles(req, cleanUrl, authHeaders, verificationScope, dependencies);
        const role = verifiedRoles.results.find((candidate) => (
          candidate.roleName === roleName
          && candidate.modelId === assignment.modelId
          && candidate.connectionId === assignment.connectionId
          && (candidate.from?.type === "USER" || candidate.from?.type === "User Role")
        ));
        if (!role) throw new ModelRoleResponseError("MODEL_ROLE_ASSIGNMENT_NOT_VERIFIED");
        return json({ ...verifiedRoles, assignment, role, verified: true });
      }

      default:
        return new Response(
          JSON.stringify({ error: "Unknown action." }),
          { status: 400, headers: jsonHeaders }
        );
    }

    if (!response.ok) {
      return new Response(
        JSON.stringify({ error: `Omni user request failed with HTTP ${response.status}.` }),
        { status: response.status, headers: jsonHeaders }
      );
    }
    if (response.status === 204) {
      return new Response(JSON.stringify({ success: true }), { headers: jsonHeaders });
    }
    const data = await response.json();
    return new Response(JSON.stringify(data), {
      status: 200,
      headers: jsonHeaders,
    });
  } catch (error) {
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
    return new Response(JSON.stringify({ error: "The Omni user request could not be completed." }), {
      status: 500,
      headers: jsonHeaders,
    });
  }
}
