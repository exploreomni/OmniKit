export const IDENTITY_ACCESS_EVIDENCE_SCHEMA_VERSION = 'omnikit.identity-access-evidence.v1' as const;

export const IDENTITY_ACCESS_MODEL_ROLES = [
  'VIEWER',
  'QUERY_TOPICS',
  'QUERIER',
  'MODELER',
  'CONNECTION_ADMIN',
  'NO_ACCESS',
] as const;

export const IDENTITY_ACCESS_CONTENT_ROLES = ['NO_ACCESS', 'VIEWER', 'EDITOR', 'MANAGER'] as const;

export type IdentityAccessPrincipalType = 'user' | 'group';
export type IdentityAccessEvidenceClassification = 'observed' | 'inferred' | 'operator_confirmed' | 'unverified';
export type IdentityAccessCoverageState = 'complete' | 'partial' | 'unavailable' | 'not_requested';
export type IdentityAccessModelRole = typeof IDENTITY_ACCESS_MODEL_ROLES[number];
export type IdentityAccessContentRole = typeof IDENTITY_ACCESS_CONTENT_ROLES[number];

export interface IdentityAccessExpectedAccess {
  active?: boolean;
  modelRole?: IdentityAccessModelRole;
  contentRole?: IdentityAccessContentRole;
}

export interface IdentityAccessEvidenceRequest {
  instanceId: string;
  principalType: IdentityAccessPrincipalType;
  principalIdentifier: string;
  connectionId?: string;
  modelId?: string;
  folderId?: string;
  documentId?: string;
  expectedAccess?: IdentityAccessExpectedAccess;
}

export type IdentityAccessCoverageSource =
  | 'identity'
  | 'group_membership'
  | 'model_roles'
  | 'document_access'
  | 'folder_context'
  | 'expected_access';

export interface IdentityAccessFinding {
  id: string;
  classification: IdentityAccessEvidenceClassification;
  severity: 'info' | 'success' | 'warning';
  label: string;
  message: string;
  coverageSource: IdentityAccessCoverageSource;
  source: {
    kind: 'omni_api' | 'operator_input' | 'correlation';
    method?: 'GET';
    path?: string;
  };
}

export interface IdentityAccessCoverage {
  source: IdentityAccessCoverageSource;
  state: IdentityAccessCoverageState;
  included: number;
  total: number | null;
  reason: string;
  exclusions: string[];
}

export interface IdentityAccessPrincipalEvidence {
  type: IdentityAccessPrincipalType;
  id: string;
  displayName: string;
  email?: string;
  active?: boolean;
  createdAt?: string;
  lastLogin?: string | null;
  classification: 'observed';
}

export interface IdentityAccessGroupEvidence {
  id: string;
  displayName: string;
  relationship: 'selected' | 'member';
  classification: IdentityAccessEvidenceClassification;
}

export interface IdentityAccessModelRoleEvidence {
  principalType: IdentityAccessPrincipalType;
  principalId: string;
  principalName: string;
  roleName: string;
  baseRole?: string;
  connectionId?: string;
  modelId?: string;
  resolved?: boolean;
  provenance?: { type?: string; name?: string; depth?: number };
  classification: 'observed';
}

export interface IdentityAccessDocumentEvidence {
  principalType: IdentityAccessPrincipalType;
  principalId: string;
  principalName: string;
  role: IdentityAccessContentRole;
  accessSource: 'direct' | 'folder';
  accessBoost: boolean;
  isOwner: boolean;
  folder?: { id?: string; name?: string; path?: string };
  relationship: 'direct' | 'group';
  classification: 'observed';
}

export interface IdentityAccessEvidenceReport {
  schemaVersion: typeof IDENTITY_ACCESS_EVIDENCE_SCHEMA_VERSION;
  instance: { id: string; label: string };
  checkedAt: string;
  scope: {
    principalType: IdentityAccessPrincipalType;
    principalIdentifier: string;
    connectionId?: string;
    modelId?: string;
    folderId?: string;
    documentId?: string;
    expectedAccess?: IdentityAccessExpectedAccess;
  };
  principal: IdentityAccessPrincipalEvidence;
  groups: IdentityAccessGroupEvidence[];
  modelRoles: IdentityAccessModelRoleEvidence[];
  documentAccess: IdentityAccessDocumentEvidence[];
  lifecycle: {
    state: 'active' | 'inactive' | 'group' | 'unknown';
    lastLogin?: string | null;
    inactiveGroupMembers?: number;
    unknownLifecycleGroupMembers?: number;
    unresolvedGroupMembers?: number;
    offboardingExposure: string[];
  };
  findings: IdentityAccessFinding[];
  coverage: IdentityAccessCoverage[];
  exclusions: string[];
}

export class IdentityAccessEvidenceRequestError extends Error {
  constructor(readonly status: number, message: string, readonly code?: string) {
    super(message);
    this.name = 'IdentityAccessEvidenceRequestError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function safeString(value: unknown, maxLength = 2_000): string | undefined {
  if (typeof value !== 'string' || !value || value.length > maxLength) return undefined;
  if ([...value].some((character) => {
    const code = character.charCodeAt(0);
    return code === 0 || code === 127;
  })) return undefined;
  return value;
}

function exactString<T extends string>(value: unknown, allowed: readonly T[]): T | undefined {
  return typeof value === 'string' && allowed.includes(value as T) ? value as T : undefined;
}

function optionalString(value: unknown): string | undefined {
  return value === undefined ? undefined : safeString(value, 500);
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > 2_000) return undefined;
  const parsed = value.map((entry) => safeString(entry));
  return parsed.every(Boolean) ? parsed as string[] : undefined;
}

function nonNegativeSafeInteger(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : undefined;
}

function parseExpectedAccess(value: unknown): IdentityAccessExpectedAccess | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error('Expected access is invalid.');
  const active = value.active === undefined ? undefined : typeof value.active === 'boolean' ? value.active : null;
  const modelRole = value.modelRole === undefined ? undefined : exactString(value.modelRole, IDENTITY_ACCESS_MODEL_ROLES);
  const contentRole = value.contentRole === undefined ? undefined : exactString(value.contentRole, IDENTITY_ACCESS_CONTENT_ROLES);
  if (active === null || (value.modelRole !== undefined && !modelRole) || (value.contentRole !== undefined && !contentRole)) {
    throw new Error('Expected access is invalid.');
  }
  return {
    ...(active !== undefined ? { active } : {}),
    ...(modelRole ? { modelRole } : {}),
    ...(contentRole ? { contentRole } : {}),
  };
}

function parseFinding(value: unknown): IdentityAccessFinding {
  if (!isRecord(value)) throw new Error('Finding is invalid.');
  const id = safeString(value.id, 160);
  const classification = exactString(value.classification, ['observed', 'inferred', 'operator_confirmed', 'unverified'] as const);
  const severity = exactString(value.severity, ['info', 'success', 'warning'] as const);
  const label = safeString(value.label, 300);
  const message = safeString(value.message, 2_000);
  const coverageSource = exactString(value.coverageSource, ['identity', 'group_membership', 'model_roles', 'document_access', 'folder_context', 'expected_access'] as const);
  const source = isRecord(value.source) ? value.source : undefined;
  const sourceKind = exactString(source?.kind, ['omni_api', 'operator_input', 'correlation'] as const);
  const method = source?.method === undefined ? undefined : source.method === 'GET' ? 'GET' as const : undefined;
  const path = optionalString(source?.path);
  if (!id || !classification || !severity || !label || !message || !coverageSource || !sourceKind || (source?.method !== undefined && !method)) {
    throw new Error('Finding is invalid.');
  }
  return { id, classification, severity, label, message, coverageSource, source: { kind: sourceKind, ...(method ? { method } : {}), ...(path ? { path } : {}) } };
}

function parseCoverage(value: unknown): IdentityAccessCoverage {
  if (!isRecord(value)) throw new Error('Coverage is invalid.');
  const source = exactString(value.source, ['identity', 'group_membership', 'model_roles', 'document_access', 'folder_context', 'expected_access'] as const);
  const state = exactString(value.state, ['complete', 'partial', 'unavailable', 'not_requested'] as const);
  const included = Number.isSafeInteger(value.included) && Number(value.included) >= 0 ? Number(value.included) : undefined;
  const total = value.total === null ? null : Number.isSafeInteger(value.total) && Number(value.total) >= 0 ? Number(value.total) : undefined;
  const reason = safeString(value.reason, 2_000);
  const exclusions = stringArray(value.exclusions);
  if (!source || !state || included === undefined || total === undefined || !reason || !exclusions) throw new Error('Coverage is invalid.');
  return { source, state, included, total, reason, exclusions };
}

function parsePrincipal(value: unknown): IdentityAccessPrincipalEvidence {
  if (!isRecord(value)) throw new Error('Principal evidence is invalid.');
  const type = exactString(value.type, ['user', 'group'] as const);
  const id = safeString(value.id, 500);
  const displayName = safeString(value.displayName, 500);
  const email = optionalString(value.email);
  const createdAt = optionalString(value.createdAt);
  const lastLogin = value.lastLogin === null ? null : optionalString(value.lastLogin);
  if (!type || !id || !displayName || value.classification !== 'observed') throw new Error('Principal evidence is invalid.');
  if (value.active !== undefined && typeof value.active !== 'boolean') throw new Error('Principal lifecycle evidence is invalid.');
  return {
    type,
    id,
    displayName,
    ...(email ? { email } : {}),
    ...(typeof value.active === 'boolean' ? { active: value.active } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(value.lastLogin === null || lastLogin ? { lastLogin } : {}),
    classification: 'observed',
  };
}

function parseGroups(value: unknown): IdentityAccessGroupEvidence[] {
  if (!Array.isArray(value) || value.length > 2_000) throw new Error('Group evidence is invalid.');
  return value.map((entry) => {
    if (!isRecord(entry)) throw new Error('Group evidence is invalid.');
    const id = safeString(entry.id, 500);
    const displayName = safeString(entry.displayName, 500);
    const relationship = exactString(entry.relationship, ['selected', 'member'] as const);
    const classification = exactString(entry.classification, ['observed', 'inferred', 'operator_confirmed', 'unverified'] as const);
    if (!id || !displayName || !relationship || !classification) throw new Error('Group evidence is invalid.');
    return { id, displayName, relationship, classification };
  });
}

function parseModelRoles(value: unknown): IdentityAccessModelRoleEvidence[] {
  if (!Array.isArray(value) || value.length > 5_000) throw new Error('Model-role evidence is invalid.');
  return value.map((entry) => {
    if (!isRecord(entry)) throw new Error('Model-role evidence is invalid.');
    const principalType = exactString(entry.principalType, ['user', 'group'] as const);
    const principalId = safeString(entry.principalId, 500);
    const principalName = safeString(entry.principalName, 500);
    const roleName = safeString(entry.roleName, 160);
    if (!principalType || !principalId || !principalName || !roleName || entry.classification !== 'observed') throw new Error('Model-role evidence is invalid.');
    const provenance = isRecord(entry.provenance) ? entry.provenance : undefined;
    const baseRole = optionalString(entry.baseRole);
    const connectionId = optionalString(entry.connectionId);
    const modelId = optionalString(entry.modelId);
    const provenanceType = optionalString(provenance?.type);
    const provenanceName = optionalString(provenance?.name);
    return {
      principalType,
      principalId,
      principalName,
      roleName,
      ...(baseRole ? { baseRole } : {}),
      ...(connectionId ? { connectionId } : {}),
      ...(modelId ? { modelId } : {}),
      ...(typeof entry.resolved === 'boolean' ? { resolved: entry.resolved } : {}),
      ...(provenance ? {
        provenance: {
          ...(provenanceType ? { type: provenanceType } : {}),
          ...(provenanceName ? { name: provenanceName } : {}),
          ...(Number.isSafeInteger(provenance.depth) ? { depth: Number(provenance.depth) } : {}),
        },
      } : {}),
      classification: 'observed' as const,
    };
  });
}

function parseDocumentAccess(value: unknown): IdentityAccessDocumentEvidence[] {
  if (!Array.isArray(value) || value.length > 5_000) throw new Error('Document-access evidence is invalid.');
  return value.map((entry) => {
    if (!isRecord(entry)) throw new Error('Document-access evidence is invalid.');
    const principalType = exactString(entry.principalType, ['user', 'group'] as const);
    const principalId = safeString(entry.principalId, 500);
    const principalName = safeString(entry.principalName, 500);
    const role = exactString(entry.role, IDENTITY_ACCESS_CONTENT_ROLES);
    const accessSource = exactString(entry.accessSource, ['direct', 'folder'] as const);
    const relationship = exactString(entry.relationship, ['direct', 'group'] as const);
    if (!principalType || !principalId || !principalName || !role || !accessSource || !relationship || typeof entry.accessBoost !== 'boolean' || typeof entry.isOwner !== 'boolean' || entry.classification !== 'observed') {
      throw new Error('Document-access evidence is invalid.');
    }
    const folder = isRecord(entry.folder) ? entry.folder : undefined;
    const folderId = optionalString(folder?.id);
    const folderName = optionalString(folder?.name);
    const folderPath = optionalString(folder?.path);
    return {
      principalType,
      principalId,
      principalName,
      role,
      accessSource,
      accessBoost: entry.accessBoost,
      isOwner: entry.isOwner,
      ...(folder ? { folder: { ...(folderId ? { id: folderId } : {}), ...(folderName ? { name: folderName } : {}), ...(folderPath ? { path: folderPath } : {}) } } : {}),
      relationship,
      classification: 'observed' as const,
    };
  });
}

export function parseIdentityAccessEvidenceReport(value: unknown): IdentityAccessEvidenceReport {
  if (!isRecord(value) || value.schemaVersion !== IDENTITY_ACCESS_EVIDENCE_SCHEMA_VERSION) {
    throw new Error('OmniKit returned an invalid identity access evidence response.');
  }
  try {
    const instance = isRecord(value.instance) ? value.instance : undefined;
    const instanceId = safeString(instance?.id, 500);
    const instanceLabel = safeString(instance?.label, 500);
    const checkedAt = safeString(value.checkedAt, 100);
    const scope = isRecord(value.scope) ? value.scope : undefined;
    const principalType = exactString(scope?.principalType, ['user', 'group'] as const);
    const principalIdentifier = safeString(scope?.principalIdentifier, 500);
    const lifecycle = isRecord(value.lifecycle) ? value.lifecycle : undefined;
    const lifecycleState = exactString(lifecycle?.state, ['active', 'inactive', 'group', 'unknown'] as const);
    const offboardingExposure = stringArray(lifecycle?.offboardingExposure);
    const exclusions = stringArray(value.exclusions);
    if (!instanceId || !instanceLabel || !checkedAt || !scope || !principalType || !principalIdentifier || !lifecycle || !lifecycleState || !offboardingExposure || !exclusions) {
      throw new Error('Identity access evidence fields are invalid.');
    }
    const connectionId = optionalString(scope.connectionId);
    const modelId = optionalString(scope.modelId);
    const folderId = optionalString(scope.folderId);
    const documentId = optionalString(scope.documentId);
    const parsedExpectedAccess = parseExpectedAccess(scope.expectedAccess);
    if (scope.expectedAccess !== undefined && !parsedExpectedAccess) throw new Error('Expected access is invalid.');
    const lastLogin = lifecycle.lastLogin === null ? null : optionalString(lifecycle.lastLogin);
    const inactiveGroupMembers = lifecycle.inactiveGroupMembers === undefined
      ? undefined
      : nonNegativeSafeInteger(lifecycle.inactiveGroupMembers);
    const unknownLifecycleGroupMembers = lifecycle.unknownLifecycleGroupMembers === undefined
      ? undefined
      : nonNegativeSafeInteger(lifecycle.unknownLifecycleGroupMembers);
    const unresolvedGroupMembers = lifecycle.unresolvedGroupMembers === undefined
      ? undefined
      : nonNegativeSafeInteger(lifecycle.unresolvedGroupMembers);
    if (
      (lifecycle.lastLogin !== undefined && lifecycle.lastLogin !== null && !lastLogin)
      || (lifecycle.inactiveGroupMembers !== undefined && inactiveGroupMembers === undefined)
      || (lifecycle.unknownLifecycleGroupMembers !== undefined && unknownLifecycleGroupMembers === undefined)
      || (lifecycle.unresolvedGroupMembers !== undefined && unresolvedGroupMembers === undefined)
    ) throw new Error('Lifecycle evidence is invalid.');
    return {
      schemaVersion: IDENTITY_ACCESS_EVIDENCE_SCHEMA_VERSION,
      instance: { id: instanceId, label: instanceLabel },
      checkedAt,
      scope: {
        principalType,
        principalIdentifier,
        ...(connectionId ? { connectionId } : {}),
        ...(modelId ? { modelId } : {}),
        ...(folderId ? { folderId } : {}),
        ...(documentId ? { documentId } : {}),
        ...(parsedExpectedAccess ? { expectedAccess: parsedExpectedAccess } : {}),
      },
      principal: parsePrincipal(value.principal),
      groups: parseGroups(value.groups),
      modelRoles: parseModelRoles(value.modelRoles),
      documentAccess: parseDocumentAccess(value.documentAccess),
      lifecycle: {
        state: lifecycleState,
        ...(lifecycle.lastLogin === null || lastLogin ? { lastLogin } : {}),
        ...(inactiveGroupMembers !== undefined ? { inactiveGroupMembers } : {}),
        ...(unknownLifecycleGroupMembers !== undefined ? { unknownLifecycleGroupMembers } : {}),
        ...(unresolvedGroupMembers !== undefined ? { unresolvedGroupMembers } : {}),
        offboardingExposure,
      },
      findings: Array.isArray(value.findings) ? value.findings.map(parseFinding) : (() => { throw new Error('Findings are invalid.'); })(),
      coverage: Array.isArray(value.coverage) ? value.coverage.map(parseCoverage) : (() => { throw new Error('Coverage is invalid.'); })(),
      exclusions,
    };
  } catch {
    throw new Error('OmniKit returned an invalid identity access evidence response.');
  }
}

function requiredInput(value: string, label: string): string {
  const clean = value.trim();
  const hasControlCharacters = [...clean].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
  if (!clean || clean.length > 500 || hasControlCharacters) throw new Error(`${label} is required and must be valid.`);
  return clean;
}

function optionalInput(value: string | undefined, label: string): string | undefined {
  if (!value?.trim()) return undefined;
  return requiredInput(value, label);
}

export async function fetchIdentityAccessEvidence(
  input: IdentityAccessEvidenceRequest,
  options: { signal?: AbortSignal } = {},
): Promise<IdentityAccessEvidenceReport> {
  const instanceId = requiredInput(input.instanceId, 'Selected instance');
  const principalIdentifier = requiredInput(input.principalIdentifier, 'Principal identifier');
  const connectionId = optionalInput(input.connectionId, 'Connection ID');
  const modelId = optionalInput(input.modelId, 'Model ID');
  const folderId = optionalInput(input.folderId, 'Folder ID or path');
  const documentId = optionalInput(input.documentId, 'Document ID');
  const response = await fetch('/api/manage-users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    signal: options.signal,
    body: JSON.stringify({
      action: 'debug_access',
      instance_id: instanceId,
      principal_type: input.principalType,
      principal_identifier: principalIdentifier,
      ...(connectionId ? { connection_id: connectionId } : {}),
      ...(modelId ? { model_id: modelId } : {}),
      ...(folderId ? { folder_id: folderId } : {}),
      ...(documentId ? { document_id: documentId } : {}),
      ...(input.expectedAccess && Object.keys(input.expectedAccess).length > 0 ? { expected_access: input.expectedAccess } : {}),
    }),
  });
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new IdentityAccessEvidenceRequestError(response.status || 502, 'Identity access evidence returned an invalid response.');
  }
  if (!response.ok) {
    const row = isRecord(payload) ? payload : {};
    const message = safeString(row.error, 500) || 'Identity access evidence could not be collected.';
    const code = safeString(row.code, 100);
    throw new IdentityAccessEvidenceRequestError(response.status, message, code);
  }
  return parseIdentityAccessEvidenceReport(payload);
}

const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const TOKEN_PATTERN = /\b(Bearer\s+)[A-Za-z0-9._~+/=-]+\b/gi;
const OMNI_TOKEN_PATTERN = /\bomni_[A-Za-z0-9._~+/=-]{8,}\b/gi;
const SECRET_ASSIGNMENT_PATTERN = /\b(api[_-]?key|authorization|token|secret|password|passphrase)(["'\s:=]+)([^"',\s}]+)/gi;
const SENSITIVE_KEY_PATTERN = /^(api[_-]?key|authorization|token|secret|password|passphrase|headers?|body|cookie|set-cookie|raw|upstream)$/i;

function redactExportText(value: string): string {
  return value
    .replace(TOKEN_PATTERN, '$1[redacted]')
    .replace(OMNI_TOKEN_PATTERN, '[redacted]')
    .replace(SECRET_ASSIGNMENT_PATTERN, '$1$2[redacted]')
    .replace(EMAIL_PATTERN, '[redacted-email]');
}

function sanitizeExportValue(value: unknown): unknown {
  if (typeof value === 'string') return redactExportText(value);
  if (Array.isArray(value)) return value.map(sanitizeExportValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    redactExportText(key),
    SENSITIVE_KEY_PATTERN.test(key) ? '[redacted]' : sanitizeExportValue(item),
  ]));
}

export function sanitizeIdentityAccessEvidenceForExport(report: IdentityAccessEvidenceReport): IdentityAccessEvidenceReport {
  return sanitizeExportValue(report) as IdentityAccessEvidenceReport;
}

export function serializeIdentityAccessEvidence(report: IdentityAccessEvidenceReport): string {
  return JSON.stringify(sanitizeIdentityAccessEvidenceForExport(report), null, 2);
}
