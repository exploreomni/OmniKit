import { emitVaultLocked } from '@/services/vaultEvents';
import { isSafeOmniDocumentationUrl } from '@/services/omniDeepLinks';

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

export type AdminReadinessCapabilityId =
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

export interface AdminScheduleStatusCounts {
  success: number;
  error: number;
  canceled: number;
  none: number;
  unknown: number;
}

export interface AdminCurrentCallerEvidence {
  keyScope: 'user' | 'organization';
  orgRole: 'MEMBER' | 'ORG_ADMIN';
  returnedModelCount: number;
  returnedPermissionCount: number;
  rolesByModelTruncated: boolean;
}

export type AdminReadinessData =
  | { readable: boolean; visibleFoldersLowerBound: number }
  | { total: number; organization: number; personal: number; mcp: number; other: number; enabled: number; disabled: number }
  | { confirmed: boolean }
  | AdminCurrentCallerEvidence
  | { total: number; active: number; inactive: number; statusUnknown: number }
  | { total: number }
  | Array<{ name: string; label?: string; type?: string; multiple: boolean; system: boolean; hasDefault: boolean; hasDescription: boolean }>
  | { total: number; active: number; paused: number; systemDisabled: number; lastStatus: AdminScheduleStatusCounts; latestObservedAt: string | null };

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
  id: AdminReadinessCapabilityId;
  label: string;
  data?: AdminReadinessData;
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

export interface AdminReadinessRequest {
  principalType?: 'user' | 'group';
  principalId?: string;
  modelId?: string;
  connectionId?: string;
  signal?: AbortSignal;
}

type UnknownRecord = Record<string, unknown>;

const WORKSPACES = new Set<AdminReadinessWorkspace>(['fleet', 'identity', 'content', 'developer']);
const EVIDENCE_STATES = new Set<AdminEvidenceState>(['not_checked', 'available', 'partial', 'unauthorized', 'unsupported', 'unavailable', 'failed', 'stale']);
const READINESS_STATES = new Set<AdminReadinessState>(['ready', 'action_required', 'not_configured', 'unknown']);
const REASON_CODES = new Set<AdminReadinessReasonCode>([
  'ok', 'partial_coverage', 'authentication_required', 'permission_denied', 'collection_not_found',
  'resource_not_found', 'method_not_allowed', 'gone', 'unexpected_redirect', 'rate_limited',
  'upstream_failure', 'request_rejected', 'network_unavailable', 'request_timeout', 'invalid_json',
  'invalid_response_shape', 'operator_confirmed', 'operator_confirmation_missing',
  'no_documented_read_api', 'manual_action_only', 'not_configured', 'cached_refresh_failed',
]);
const CAPABILITY_IDS = new Set<AdminReadinessCapabilityId>([
  'fleet.folder_read', 'fleet.api_tokens', 'fleet.organization_api_key_confirmation',
  'fleet.current_token_introspection', 'identity.scim_users', 'identity.scim_groups',
  'identity.user_attributes', 'content.schedules', 'developer.embed_users',
  'developer.sso_configuration', 'developer.audit_configuration', 'developer.api_explorer',
]);
const ORDINARY_CAPABILITY_IDS: Record<AdminReadinessWorkspace, readonly AdminReadinessCapabilityId[]> = {
  fleet: [
    'fleet.folder_read',
    'fleet.api_tokens',
    'fleet.organization_api_key_confirmation',
    'fleet.current_token_introspection',
  ],
  identity: ['identity.scim_users', 'identity.scim_groups', 'identity.user_attributes'],
  content: ['content.schedules'],
  developer: [
    'developer.embed_users',
    'developer.sso_configuration',
    'developer.audit_configuration',
    'developer.api_explorer',
  ],
};
const SENSITIVE_VALUE = /Bearer\s+[A-Za-z0-9._~+/=-]+|\b(?:api[_-]?key|authorization|token|secret|password)\b\s*[:=]\s*\S+/i;
const OPAQUE_ID_EMAIL = /[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+/i;
const OPAQUE_ID_URL = /https?:\/\//i;

export class AdminReadinessContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AdminReadinessContractError';
  }
}

function fail(label: string): never {
  throw new AdminReadinessContractError(`Invalid admin readiness response: ${label}.`);
}

function record(value: unknown, label: string): UnknownRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(label);
  return value as UnknownRecord;
}

function exactKeys(value: UnknownRecord, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedSet.has(key))) fail(`${label} contains an unknown field`);
}

function stringValue(value: unknown, label: string, maxLength = 1_000): string {
  if (typeof value !== 'string' || !value || value.length > maxLength || SENSITIVE_VALUE.test(value)) fail(label);
  return value;
}

function optionalString(value: unknown, label: string, maxLength = 500): string | undefined {
  if (value === undefined) return undefined;
  return stringValue(value, label, maxLength);
}

function hasAsciiControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
}

function opaqueIdentifier(value: unknown, label: string): string {
  const parsed = stringValue(value, label, 500);
  if (
    parsed !== parsed.trim()
    || hasAsciiControlCharacter(parsed)
    || OPAQUE_ID_EMAIL.test(parsed)
    || OPAQUE_ID_URL.test(parsed)
  ) fail(label);
  return parsed;
}

function optionalOpaqueIdentifier(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return opaqueIdentifier(value, label);
}

function timestamp(value: unknown, label: string): string {
  const parsed = stringValue(value, label, 80);
  if (!Number.isFinite(Date.parse(parsed))) fail(label);
  return parsed;
}

function nonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail(label);
  return value as number;
}

function stringList(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 100) fail(label);
  return value.map((item, index) => stringValue(item, `${label}[${index}]`, 500));
}

function parseReason(value: unknown): AdminReadinessReason {
  const row = record(value, 'reason');
  exactKeys(row, ['code', 'message'], 'reason');
  if (!REASON_CODES.has(row.code as AdminReadinessReasonCode)) fail('reason.code');
  return { code: row.code as AdminReadinessReasonCode, message: stringValue(row.message, 'reason.message') };
}

function parseSource(value: unknown): AdminReadinessSource {
  const row = record(value, 'source');
  exactKeys(row, ['kind', 'scope', 'method', 'path'], 'source');
  if (row.kind !== 'omni_api' && row.kind !== 'operator_confirmation' && row.kind !== 'official_documentation') fail('source.kind');
  if (row.scope !== 'collection' && row.scope !== 'resource' && row.scope !== 'saved_setting' && row.scope !== 'manual_action') fail('source.scope');
  if (row.method !== undefined && row.method !== 'GET') fail('source.method');
  const path = optionalString(row.path, 'source.path', 300);
  if (path && (!path.startsWith('/') || path.includes('?') || path.includes('#') || path.includes('://'))) fail('source.path');
  return {
    kind: row.kind,
    scope: row.scope,
    ...(row.method === 'GET' ? { method: 'GET' as const } : {}),
    ...(path ? { path } : {}),
  };
}

function parseCoverage(value: unknown): AdminReadinessCoverage {
  const row = record(value, 'coverage');
  exactKeys(row, ['included', 'total', 'complete', 'unit'], 'coverage');
  const included = nonNegativeInteger(row.included, 'coverage.included');
  const total = row.total === null ? null : nonNegativeInteger(row.total, 'coverage.total');
  if (total !== null && included > total) fail('coverage.included');
  if (typeof row.complete !== 'boolean') fail('coverage.complete');
  if (row.complete && (total === null || included !== total)) fail('coverage.complete');
  return { included, total, complete: row.complete, unit: stringValue(row.unit, 'coverage.unit', 80) };
}

function parseDocumentation(value: unknown): AdminReadinessDocumentation {
  const row = record(value, 'documentation');
  exactKeys(row, ['label', 'url'], 'documentation');
  const url = stringValue(row.url, 'documentation.url', 500);
  if (!isSafeOmniDocumentationUrl(url)) fail('documentation.url');
  return { label: stringValue(row.label, 'documentation.label', 160), url };
}

function safeTenantActionUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    const exactUrl = parsed.pathname === '/'
      ? `${parsed.origin}/`
      : parsed.pathname === '/api-explorer'
        ? `${parsed.origin}/api-explorer`
        : '';
    return Boolean(exactUrl)
      && value === exactUrl
      && parsed.protocol === 'https:'
      && !parsed.username
      && !parsed.password
      && !parsed.search
      && !parsed.hash
      && parsed.toString() === exactUrl;
  } catch {
    return false;
  }
}

function parseAction(value: unknown): AdminReadinessAction {
  const row = record(value, 'action');
  exactKeys(row, ['kind', 'label', 'url'], 'action');
  if (row.kind !== 'documentation' && row.kind !== 'tenant_deep_link') fail('action.kind');
  const url = stringValue(row.url, 'action.url', 500);
  if (row.kind === 'documentation' ? !isSafeOmniDocumentationUrl(url) : !safeTenantActionUrl(url)) fail('action.url');
  return { kind: row.kind, label: stringValue(row.label, 'action.label', 160), url };
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') fail(label);
  return value;
}

function countFields(row: UnknownRecord, keys: readonly string[], label: string): Record<string, number> {
  return Object.fromEntries(keys.map((key) => [key, nonNegativeInteger(row[key], `${label}.${key}`)]));
}

function parseData(id: AdminReadinessCapabilityId, value: unknown): AdminReadinessData | undefined {
  if (value === undefined) return undefined;
  if (id === 'fleet.folder_read') {
    const row = record(value, 'data');
    exactKeys(row, ['readable', 'visibleFoldersLowerBound'], 'data');
    return {
      readable: booleanValue(row.readable, 'data.readable'),
      visibleFoldersLowerBound: nonNegativeInteger(row.visibleFoldersLowerBound, 'data.visibleFoldersLowerBound'),
    };
  }
  if (id === 'fleet.api_tokens') {
    const keys = ['total', 'organization', 'personal', 'mcp', 'other', 'enabled', 'disabled'] as const;
    const row = record(value, 'data');
    exactKeys(row, keys, 'data');
    const counts = countFields(row, keys, 'data');
    return counts as AdminReadinessData;
  }
  if (id === 'fleet.organization_api_key_confirmation') {
    const row = record(value, 'data');
    exactKeys(row, ['confirmed'], 'data');
    return { confirmed: booleanValue(row.confirmed, 'data.confirmed') };
  }
  if (id === 'fleet.current_token_introspection') {
    const row = record(value, 'data');
    const keys = [
      'keyScope',
      'orgRole',
      'returnedModelCount',
      'returnedPermissionCount',
      'rolesByModelTruncated',
    ] as const;
    exactKeys(row, keys, 'data');
    if (row.keyScope !== 'user' && row.keyScope !== 'organization') fail('data.keyScope');
    if (row.orgRole !== 'MEMBER' && row.orgRole !== 'ORG_ADMIN') fail('data.orgRole');
    return {
      keyScope: row.keyScope,
      orgRole: row.orgRole,
      returnedModelCount: nonNegativeInteger(row.returnedModelCount, 'data.returnedModelCount'),
      returnedPermissionCount: nonNegativeInteger(row.returnedPermissionCount, 'data.returnedPermissionCount'),
      rolesByModelTruncated: booleanValue(row.rolesByModelTruncated, 'data.rolesByModelTruncated'),
    };
  }
  if (id === 'identity.scim_users' || id === 'developer.embed_users') {
    const keys = ['total', 'active', 'inactive', 'statusUnknown'] as const;
    const row = record(value, 'data');
    exactKeys(row, keys, 'data');
    return countFields(row, keys, 'data') as AdminReadinessData;
  }
  if (id === 'identity.scim_groups') {
    const row = record(value, 'data');
    exactKeys(row, ['total'], 'data');
    return { total: nonNegativeInteger(row.total, 'data.total') };
  }
  if (id === 'identity.user_attributes') {
    if (!Array.isArray(value) || value.length > 500) fail('data');
    return value.map((item, index) => {
      const row = record(item, `data[${index}]`);
      exactKeys(row, ['name', 'label', 'type', 'multiple', 'system', 'hasDefault', 'hasDescription'], `data[${index}]`);
      const label = optionalString(row.label, `data[${index}].label`, 200);
      const type = optionalString(row.type, `data[${index}].type`, 120);
      return {
        name: stringValue(row.name, `data[${index}].name`, 200),
        ...(label ? { label } : {}),
        ...(type ? { type } : {}),
        multiple: booleanValue(row.multiple, `data[${index}].multiple`),
        system: booleanValue(row.system, `data[${index}].system`),
        hasDefault: booleanValue(row.hasDefault, `data[${index}].hasDefault`),
        hasDescription: booleanValue(row.hasDescription, `data[${index}].hasDescription`),
      };
    });
  }
  if (id === 'content.schedules') {
    const row = record(value, 'data');
    exactKeys(row, ['total', 'active', 'paused', 'systemDisabled', 'lastStatus', 'latestObservedAt'], 'data');
    const lastStatus = record(row.lastStatus, 'data.lastStatus');
    const statusKeys = ['success', 'error', 'canceled', 'none', 'unknown'] as const;
    exactKeys(lastStatus, statusKeys, 'data.lastStatus');
    const latestObservedAt = row.latestObservedAt === null
      ? null
      : timestamp(row.latestObservedAt, 'data.latestObservedAt');
    return {
      total: nonNegativeInteger(row.total, 'data.total'),
      active: nonNegativeInteger(row.active, 'data.active'),
      paused: nonNegativeInteger(row.paused, 'data.paused'),
      systemDisabled: nonNegativeInteger(row.systemDisabled, 'data.systemDisabled'),
      lastStatus: countFields(lastStatus, statusKeys, 'data.lastStatus') as unknown as AdminScheduleStatusCounts,
      latestObservedAt,
    };
  }
  fail(`data is not allowed for ${id}`);
}

function validateDataCoverage(
  id: AdminReadinessCapabilityId,
  data: AdminReadinessData | undefined,
  coverage: AdminReadinessCoverage,
): void {
  if (data === undefined) return;

  if (id === 'fleet.folder_read') {
    const folder = data as { visibleFoldersLowerBound: number };
    if (folder.visibleFoldersLowerBound !== coverage.included) fail('data and coverage disagree');
    return;
  }

  if (id === 'fleet.api_tokens') {
    const tokens = data as {
      total: number;
      organization: number;
      personal: number;
      mcp: number;
      other: number;
      enabled: number;
      disabled: number;
    };
    if (
      tokens.total !== coverage.included
      || tokens.organization + tokens.personal + tokens.mcp + tokens.other !== tokens.total
      || tokens.enabled + tokens.disabled !== tokens.total
    ) fail('API token aggregate partitions');
    return;
  }

  if (id === 'fleet.current_token_introspection') {
    const caller = data as AdminCurrentCallerEvidence;
    if (
      caller.returnedModelCount !== coverage.included
      || coverage.complete === caller.rolesByModelTruncated
      || (coverage.complete && coverage.total !== caller.returnedModelCount)
      || (!coverage.complete && coverage.total !== null)
    ) fail('current caller aggregate coverage');
    return;
  }

  if (id === 'identity.scim_users' || id === 'developer.embed_users') {
    const users = data as { total: number; active: number; inactive: number; statusUnknown: number };
    if (
      users.total !== coverage.included
      || users.active + users.inactive + users.statusUnknown !== users.total
    ) fail('user aggregate partitions');
    return;
  }

  if (id === 'identity.scim_groups') {
    if ((data as { total: number }).total !== coverage.included) fail('group aggregate coverage');
    return;
  }

  if (id === 'identity.user_attributes') {
    if (!Array.isArray(data) || data.length !== coverage.included) fail('user attribute coverage');
    return;
  }

  if (id === 'content.schedules') {
    const schedules = data as {
      total: number;
      active: number;
      paused: number;
      systemDisabled: number;
      lastStatus: AdminScheduleStatusCounts;
    };
    const statusTotal = Object.values(schedules.lastStatus).reduce((sum, count) => sum + count, 0);
    if (
      schedules.total !== coverage.included
      || statusTotal !== schedules.total
      || schedules.active > schedules.total
      || schedules.paused > schedules.total
      || schedules.systemDisabled > schedules.total
    ) fail('schedule aggregate partitions');
  }
}

function parseEnvelope(row: UnknownRecord): AdminEvidenceEnvelope {
  if (!EVIDENCE_STATES.has(row.evidenceState as AdminEvidenceState)) fail('evidenceState');
  if (!READINESS_STATES.has(row.readinessState as AdminReadinessState)) fail('readinessState');
  return {
    evidenceState: row.evidenceState as AdminEvidenceState,
    readinessState: row.readinessState as AdminReadinessState,
    reason: parseReason(row.reason),
    source: parseSource(row.source),
    checkedAt: timestamp(row.checkedAt, 'checkedAt'),
    coverage: parseCoverage(row.coverage),
    exclusions: stringList(row.exclusions, 'exclusions'),
    documentation: Array.isArray(row.documentation) && row.documentation.length <= 20
      ? row.documentation.map(parseDocumentation)
      : fail('documentation'),
  };
}

function parseCapability(value: unknown): AdminReadinessCapability {
  const row = record(value, 'capability');
  exactKeys(row, [
    'id', 'label', 'data', 'actions', 'evidenceState', 'readinessState', 'reason', 'source',
    'checkedAt', 'coverage', 'exclusions', 'documentation',
  ], 'capability');
  if (!CAPABILITY_IDS.has(row.id as AdminReadinessCapabilityId)) fail('capability.id');
  const actions = row.actions === undefined
    ? undefined
    : Array.isArray(row.actions) && row.actions.length <= 20
      ? row.actions.map(parseAction)
      : fail('capability.actions');
  const id = row.id as AdminReadinessCapabilityId;
  const data = parseData(id, row.data);
  const envelope = parseEnvelope(row);
  if (
    data !== undefined
    && ['unauthorized', 'unsupported', 'unavailable', 'failed'].includes(envelope.evidenceState)
  ) {
    fail('capability.data for unavailable evidence');
  }
  validateDataCoverage(id, data, envelope.coverage);
  return {
    id,
    label: stringValue(row.label, 'capability.label', 160),
    ...envelope,
    ...(data === undefined ? {} : { data }),
    ...(actions === undefined ? {} : { actions }),
  };
}

function parseRole(value: unknown): AdminModelRoleEvidence {
  const row = record(value, 'accessPosture.roles');
  exactKeys(row, ['baseRole', 'roleName', 'connectionId', 'modelId', 'priority', 'resolved', 'provenance'], 'accessPosture.roles');
  let provenance: AdminModelRoleEvidence['provenance'];
  if (row.provenance !== undefined) {
    const source = record(row.provenance, 'accessPosture.roles.provenance');
    exactKeys(source, ['type', 'name', 'depth'], 'accessPosture.roles.provenance');
    provenance = {
      ...(optionalString(source.type, 'accessPosture.roles.provenance.type', 120) ? { type: source.type as string } : {}),
      ...(optionalString(source.name, 'accessPosture.roles.provenance.name', 200) ? { name: source.name as string } : {}),
      ...(source.depth === undefined ? {} : { depth: nonNegativeInteger(source.depth, 'accessPosture.roles.provenance.depth') }),
    };
  }
  if (row.priority !== undefined && !Number.isInteger(row.priority)) fail('accessPosture.roles.priority');
  if (row.resolved !== undefined && typeof row.resolved !== 'boolean') fail('accessPosture.roles.resolved');
  return {
    roleName: stringValue(row.roleName, 'accessPosture.roles.roleName', 160),
    ...(optionalString(row.baseRole, 'accessPosture.roles.baseRole', 160) ? { baseRole: row.baseRole as string } : {}),
    ...(optionalString(row.connectionId, 'accessPosture.roles.connectionId', 240) ? { connectionId: row.connectionId as string } : {}),
    ...(optionalString(row.modelId, 'accessPosture.roles.modelId', 240) ? { modelId: row.modelId as string } : {}),
    ...(row.priority === undefined ? {} : { priority: row.priority as number }),
    ...(row.resolved === undefined ? {} : { resolved: row.resolved as boolean }),
    ...(provenance ? { provenance } : {}),
  };
}

function parseAccessPostureRequestScope(value: unknown): AdminAccessPostureRequestScope {
  const row = record(value, 'accessPosture.requestScope');
  exactKeys(row, ['principalId', 'modelId', 'connectionId'], 'accessPosture.requestScope');
  const modelId = optionalOpaqueIdentifier(row.modelId, 'accessPosture.requestScope.modelId');
  const connectionId = optionalOpaqueIdentifier(row.connectionId, 'accessPosture.requestScope.connectionId');
  return {
    principalId: opaqueIdentifier(row.principalId, 'accessPosture.requestScope.principalId'),
    ...(modelId ? { modelId } : {}),
    ...(connectionId ? { connectionId } : {}),
  };
}

function parseAccessPosture(value: unknown): AdminAccessPosture {
  const row = record(value, 'accessPosture');
  exactKeys(row, [
    'id', 'principalType', 'requestScope', 'roles', 'evidenceState', 'readinessState', 'reason', 'source',
    'checkedAt', 'coverage', 'exclusions', 'documentation',
  ], 'accessPosture');
  if (row.id !== 'identity.user_model_roles' && row.id !== 'identity.group_model_roles') fail('accessPosture.id');
  if (row.principalType !== 'user' && row.principalType !== 'group') fail('accessPosture.principalType');
  if ((row.principalType === 'user') !== (row.id === 'identity.user_model_roles')) fail('accessPosture principal mismatch');
  if (!Array.isArray(row.roles) || row.roles.length > 1_000) fail('accessPosture.roles');
  const roles = row.roles.map(parseRole);
  const envelope = parseEnvelope(row);
  if (
    roles.length > 0
    && ['unauthorized', 'unsupported', 'unavailable', 'failed'].includes(envelope.evidenceState)
  ) {
    fail('accessPosture.roles for unavailable evidence');
  }
  if (roles.length !== envelope.coverage.included) fail('accessPosture role coverage');
  return {
    id: row.id,
    principalType: row.principalType,
    requestScope: parseAccessPostureRequestScope(row.requestScope),
    roles,
    ...envelope,
  };
}

export function parseAdminReadinessReport(value: unknown): AdminReadinessReport {
  const row = record(value, 'report');
  exactKeys(row, ['schemaVersion', 'instanceId', 'workspace', 'checkedAt', 'servedFromCache', 'capabilities', 'accessPosture'], 'report');
  if (row.schemaVersion !== 1) fail('schemaVersion');
  if (!WORKSPACES.has(row.workspace as AdminReadinessWorkspace)) fail('workspace');
  if (typeof row.servedFromCache !== 'boolean') fail('servedFromCache');
  if (!Array.isArray(row.capabilities) || row.capabilities.length > 20) fail('capabilities');
  const capabilities = row.capabilities.map(parseCapability);
  const workspace = row.workspace as AdminReadinessWorkspace;
  if (capabilities.some((capability) => !capability.id.startsWith(`${workspace}.`))) fail('capability workspace mismatch');
  if (new Set(capabilities.map((capability) => capability.id)).size !== capabilities.length) fail('duplicate capability id');
  const accessPosture = row.accessPosture === undefined ? undefined : parseAccessPosture(row.accessPosture);
  if (accessPosture && workspace !== 'identity') fail('accessPosture workspace mismatch');
  return {
    schemaVersion: 1,
    instanceId: stringValue(row.instanceId, 'instanceId', 240),
    workspace,
    checkedAt: timestamp(row.checkedAt, 'checkedAt'),
    servedFromCache: row.servedFromCache,
    capabilities,
    ...(accessPosture ? { accessPosture } : {}),
  };
}

export async function fetchAdminReadiness(
  instanceId: string,
  workspace: AdminReadinessWorkspace,
  request: AdminReadinessRequest = {},
): Promise<AdminReadinessReport> {
  if (!instanceId.trim()) throw new Error('Choose a saved Omni instance before verifying readiness.');
  const postureRequested = request.principalType !== undefined
    || request.principalId !== undefined
    || request.modelId !== undefined
    || request.connectionId !== undefined;
  if (postureRequested && workspace !== 'identity') throw new Error('Access posture is available only in Identity & Access.');
  if (postureRequested && (!request.principalType || !request.principalId?.trim())) {
    throw new Error('Both principal type and principal ID are required for access posture.');
  }
  const requestedScope = postureRequested
    ? {
        principalId: opaqueIdentifier(request.principalId?.trim(), 'request principalId'),
        ...(request.modelId?.trim() ? { modelId: opaqueIdentifier(request.modelId.trim(), 'request modelId') } : {}),
        ...(request.connectionId?.trim() ? { connectionId: opaqueIdentifier(request.connectionId.trim(), 'request connectionId') } : {}),
      }
    : undefined;
  const params = new URLSearchParams({ instanceId: instanceId.trim(), workspace });
  if (request.principalType && requestedScope) {
    params.set('principalType', request.principalType);
    params.set('principalId', requestedScope.principalId);
    if (requestedScope.modelId) params.set('modelId', requestedScope.modelId);
    if (requestedScope.connectionId) params.set('connectionId', requestedScope.connectionId);
  }

  let response: Response;
  try {
    response = await fetch(`/api/admin-readiness?${params.toString()}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: request.signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new Error('Read-only readiness could not reach the local OmniKit server.');
  }
  if (!response.ok) {
    const message = response.status === 423
      ? 'Unlock the local vault before verifying readiness.'
      : response.status === 404
        ? 'The saved Omni instance is no longer available.'
        : `Read-only readiness could not be verified (HTTP ${response.status}).`;
    if (response.status === 423) emitVaultLocked(message);
    throw new Error(message);
  }
  const payload = await response.json().catch(() => fail('JSON'));
  const report = parseAdminReadinessReport(payload);
  if (report.instanceId !== instanceId.trim() || report.workspace !== workspace) fail('request scope mismatch');
  if (postureRequested) {
    if (report.capabilities.length !== 0 || !report.accessPosture || !requestedScope) {
      fail('access posture response shape');
    }
    if (
      report.accessPosture.principalType !== request.principalType
      || report.accessPosture.requestScope.principalId !== requestedScope.principalId
      || report.accessPosture.requestScope.modelId !== requestedScope.modelId
      || report.accessPosture.requestScope.connectionId !== requestedScope.connectionId
    ) {
      fail('access posture request scope mismatch');
    }
  } else {
    if (report.accessPosture) fail('unexpected access posture');
    const expected = ORDINARY_CAPABILITY_IDS[workspace];
    const returned = new Set(report.capabilities.map(({ id }) => id));
    if (report.capabilities.length !== expected.length || expected.some((id) => !returned.has(id))) {
      fail('workspace capability set mismatch');
    }
  }
  return report;
}
