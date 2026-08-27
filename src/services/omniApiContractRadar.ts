import { emitVaultLocked } from '@/services/vaultEvents';

export type TenantOpenApiMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'HEAD' | 'OPTIONS' | 'TRACE';
export type OmniApiContractStatus =
  | 'documented_current'
  | 'tenant_confirmed'
  | 'beta'
  | 'deprecated'
  | 'retired'
  | 'unverified';
export type OmniApiProbeMode = 'read_only' | 'controlled_write' | 'manual_only';
export type OmniApiProductionPolicy = 'allowed' | 'prohibited';
export type OmniApiContractDriftCategory =
  | 'tenant_only'
  | 'registry_only'
  | 'method_mismatch'
  | 'schema_changed'
  | 'classification_mismatch';

export interface TenantOpenApiOperation {
  key: string;
  path: string;
  method: TenantOpenApiMethod;
  pathFingerprint: string;
  methodFingerprint: string;
  requestSchemaFingerprint: string;
  responseSchemaFingerprint: string;
  schemaFingerprint: string;
  operationFingerprint: string;
  deprecated: boolean;
  registry?: {
    id: string;
    status: OmniApiContractStatus;
    probeMode: OmniApiProbeMode;
    productionPolicy?: OmniApiProductionPolicy;
  };
}

export interface OmniApiContractDriftFinding {
  id: string;
  category: OmniApiContractDriftCategory;
  severity: 'review' | 'warning';
  path: string;
  method?: TenantOpenApiMethod;
  registryId?: string;
  message: string;
}

export interface OmniApiContractRadarReport {
  schemaVersion: 1;
  instanceId: string;
  tenantOrigin: string;
  checkedAt: string;
  source: { method: 'GET'; path: '/openapi.json' };
  openapiVersion: string;
  specFingerprint: string;
  externalReferenceCount: number;
  unresolvedLocalReferenceCount: number;
  complete: boolean;
  baseline: {
    available: boolean;
    checkedAt?: string;
    specFingerprint?: string;
  };
  summary: {
    tenantOperations: number;
    registryOperations: number;
    matchedOperations: number;
    tenantOnly: number;
    registryOnly: number;
    methodMismatches: number;
    schemaChanges: number;
    classificationMismatches: number;
  };
  operations: TenantOpenApiOperation[];
  findings: OmniApiContractDriftFinding[];
}

type UnknownRecord = Record<string, unknown>;

const METHODS = new Set<TenantOpenApiMethod>(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE']);
const STATUSES = new Set<OmniApiContractStatus>([
  'documented_current',
  'tenant_confirmed',
  'beta',
  'deprecated',
  'retired',
  'unverified',
]);
const PROBE_MODES = new Set<OmniApiProbeMode>(['read_only', 'controlled_write', 'manual_only']);
const PRODUCTION_POLICIES = new Set<OmniApiProductionPolicy>(['allowed', 'prohibited']);
const DRIFT_CATEGORIES = new Set<OmniApiContractDriftCategory>([
  'tenant_only',
  'registry_only',
  'method_mismatch',
  'schema_changed',
  'classification_mismatch',
]);
const HASH = /^[a-f0-9]{64}$/;
const OPENAPI_VERSION = /^3\.\d+(?:\.\d+)?(?:[-+][A-Za-z0-9.-]+)?$/;
const SAFE_PATH = /^\/(?:[A-Za-z0-9._~:-]+(?:\/[A-Za-z0-9._~:-]+)*)?$/;
const MAX_OPERATIONS = 10_000;
const MAX_FINDINGS = 30_000;

export class OmniApiContractRadarContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'OmniApiContractRadarContractError';
  }
}

function fail(label: string): never {
  throw new OmniApiContractRadarContractError(`Invalid Contract Radar response: ${label}.`);
}

function record(value: unknown, label: string): UnknownRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(label);
  return value as UnknownRecord;
}

function exactKeys(value: UnknownRecord, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedSet.has(key))) fail(`${label} contains an unknown field`);
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
}

function boundedString(value: unknown, label: string, maximum = 1_000): string {
  if (
    typeof value !== 'string'
    || !value
    || value !== value.trim()
    || value.length > maximum
    || hasControlCharacters(value)
  ) fail(label);
  return value;
}

function timestamp(value: unknown, label: string): string {
  const parsed = boundedString(value, label, 80);
  if (!Number.isFinite(Date.parse(parsed))) fail(label);
  return parsed;
}

function tenantOrigin(value: unknown, label: string): string {
  const parsed = boundedString(value, label, 2_000);
  try {
    const url = new URL(parsed);
    if (url.protocol !== 'https:' || url.origin !== parsed) fail(label);
  } catch (error) {
    if (error instanceof OmniApiContractRadarContractError) throw error;
    fail(label);
  }
  return parsed;
}

function hash(value: unknown, label: string): string {
  const parsed = boundedString(value, label, 64);
  if (!HASH.test(parsed)) fail(label);
  return parsed;
}

function count(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) fail(label);
  return value;
}

function booleanValue(value: unknown, label: string): boolean {
  if (typeof value !== 'boolean') fail(label);
  return value;
}

function method(value: unknown, label: string): TenantOpenApiMethod {
  if (!METHODS.has(value as TenantOpenApiMethod)) fail(label);
  return value as TenantOpenApiMethod;
}

function path(value: unknown, label: string): string {
  const parsed = boundedString(value, label, 500);
  if (!SAFE_PATH.test(parsed) || parsed.includes('//')) fail(label);
  return parsed;
}

function parseRegistry(value: unknown): NonNullable<TenantOpenApiOperation['registry']> {
  const row = record(value, 'operation.registry');
  exactKeys(row, ['id', 'status', 'probeMode', 'productionPolicy'], 'operation.registry');
  if (!STATUSES.has(row.status as OmniApiContractStatus)) fail('operation.registry.status');
  if (!PROBE_MODES.has(row.probeMode as OmniApiProbeMode)) fail('operation.registry.probeMode');
  if (row.productionPolicy !== undefined && !PRODUCTION_POLICIES.has(row.productionPolicy as OmniApiProductionPolicy)) {
    fail('operation.registry.productionPolicy');
  }
  return {
    id: boundedString(row.id, 'operation.registry.id', 200),
    status: row.status as OmniApiContractStatus,
    probeMode: row.probeMode as OmniApiProbeMode,
    ...(row.productionPolicy === undefined ? {} : { productionPolicy: row.productionPolicy as OmniApiProductionPolicy }),
  };
}

function parseOperation(value: unknown): TenantOpenApiOperation {
  const row = record(value, 'operation');
  exactKeys(row, [
    'key',
    'path',
    'method',
    'pathFingerprint',
    'methodFingerprint',
    'requestSchemaFingerprint',
    'responseSchemaFingerprint',
    'schemaFingerprint',
    'operationFingerprint',
    'deprecated',
    'registry',
  ], 'operation');
  const parsedPath = path(row.path, 'operation.path');
  const parsedMethod = method(row.method, 'operation.method');
  if (row.key !== `${parsedMethod} ${parsedPath}`) fail('operation.key');
  return {
    key: row.key,
    path: parsedPath,
    method: parsedMethod,
    pathFingerprint: hash(row.pathFingerprint, 'operation.pathFingerprint'),
    methodFingerprint: hash(row.methodFingerprint, 'operation.methodFingerprint'),
    requestSchemaFingerprint: hash(row.requestSchemaFingerprint, 'operation.requestSchemaFingerprint'),
    responseSchemaFingerprint: hash(row.responseSchemaFingerprint, 'operation.responseSchemaFingerprint'),
    schemaFingerprint: hash(row.schemaFingerprint, 'operation.schemaFingerprint'),
    operationFingerprint: hash(row.operationFingerprint, 'operation.operationFingerprint'),
    deprecated: booleanValue(row.deprecated, 'operation.deprecated'),
    ...(row.registry === undefined ? {} : { registry: parseRegistry(row.registry) }),
  };
}

function parseFinding(value: unknown): OmniApiContractDriftFinding {
  const row = record(value, 'finding');
  exactKeys(row, ['id', 'category', 'severity', 'path', 'method', 'registryId', 'message'], 'finding');
  if (!DRIFT_CATEGORIES.has(row.category as OmniApiContractDriftCategory)) fail('finding.category');
  if (row.severity !== 'review' && row.severity !== 'warning') fail('finding.severity');
  return {
    id: hash(row.id, 'finding.id'),
    category: row.category as OmniApiContractDriftCategory,
    severity: row.severity,
    path: path(row.path, 'finding.path'),
    ...(row.method === undefined ? {} : { method: method(row.method, 'finding.method') }),
    ...(row.registryId === undefined ? {} : { registryId: boundedString(row.registryId, 'finding.registryId', 200) }),
    message: boundedString(row.message, 'finding.message', 500),
  };
}

export function parseOmniApiContractRadarReport(value: unknown): OmniApiContractRadarReport {
  const row = record(value, 'report');
  exactKeys(row, [
    'schemaVersion',
    'instanceId',
    'tenantOrigin',
    'checkedAt',
    'source',
    'openapiVersion',
    'specFingerprint',
    'externalReferenceCount',
    'unresolvedLocalReferenceCount',
    'complete',
    'baseline',
    'summary',
    'operations',
    'findings',
  ], 'report');
  if (row.schemaVersion !== 1) fail('schemaVersion');
  const source = record(row.source, 'source');
  exactKeys(source, ['method', 'path'], 'source');
  if (source.method !== 'GET' || source.path !== '/openapi.json') fail('source');
  const openapiVersion = boundedString(row.openapiVersion, 'openapiVersion', 40);
  if (!OPENAPI_VERSION.test(openapiVersion)) fail('openapiVersion');

  const baselineRow = record(row.baseline, 'baseline');
  exactKeys(baselineRow, ['available', 'checkedAt', 'specFingerprint'], 'baseline');
  const baselineAvailable = booleanValue(baselineRow.available, 'baseline.available');
  if (
    baselineAvailable
      ? baselineRow.checkedAt === undefined || baselineRow.specFingerprint === undefined
      : baselineRow.checkedAt !== undefined || baselineRow.specFingerprint !== undefined
  ) {
    fail('baseline availability');
  }
  const baseline = baselineAvailable
    ? {
        available: true,
        checkedAt: timestamp(baselineRow.checkedAt, 'baseline.checkedAt'),
        specFingerprint: hash(baselineRow.specFingerprint, 'baseline.specFingerprint'),
      }
    : { available: false };

  if (!Array.isArray(row.operations) || row.operations.length > MAX_OPERATIONS) fail('operations');
  if (!Array.isArray(row.findings) || row.findings.length > MAX_FINDINGS) fail('findings');
  const operations = row.operations.map(parseOperation);
  const findings = row.findings.map(parseFinding);
  const operationKeys = new Set(operations.map((operation) => operation.key));
  const findingIds = new Set(findings.map((finding) => finding.id));
  if (operationKeys.size !== operations.length) fail('duplicate operations');
  if (findingIds.size !== findings.length) fail('duplicate findings');

  const summaryRow = record(row.summary, 'summary');
  const summaryKeys = [
    'tenantOperations',
    'registryOperations',
    'matchedOperations',
    'tenantOnly',
    'registryOnly',
    'methodMismatches',
    'schemaChanges',
    'classificationMismatches',
  ] as const;
  exactKeys(summaryRow, summaryKeys, 'summary');
  const summary = Object.fromEntries(summaryKeys.map((key) => [key, count(summaryRow[key], `summary.${key}`)])) as unknown as OmniApiContractRadarReport['summary'];
  const categoryCount = (category: OmniApiContractDriftCategory) => findings.filter((finding) => finding.category === category).length;
  if (
    summary.tenantOperations !== operations.length
    || summary.matchedOperations !== operations.filter((operation) => operation.registry !== undefined).length
    || summary.matchedOperations > summary.registryOperations
    || summary.tenantOnly !== categoryCount('tenant_only')
    || summary.registryOnly !== categoryCount('registry_only')
    || summary.methodMismatches !== categoryCount('method_mismatch')
    || summary.schemaChanges !== categoryCount('schema_changed')
    || summary.classificationMismatches !== categoryCount('classification_mismatch')
  ) fail('summary reconciliation');

  const externalReferenceCount = count(row.externalReferenceCount, 'externalReferenceCount');
  const unresolvedLocalReferenceCount = count(row.unresolvedLocalReferenceCount, 'unresolvedLocalReferenceCount');
  const complete = booleanValue(row.complete, 'complete');
  if (complete !== (externalReferenceCount === 0 && unresolvedLocalReferenceCount === 0)) {
    fail('reference completeness');
  }
  return {
    schemaVersion: 1,
    instanceId: boundedString(row.instanceId, 'instanceId', 500),
    tenantOrigin: tenantOrigin(row.tenantOrigin, 'tenantOrigin'),
    checkedAt: timestamp(row.checkedAt, 'checkedAt'),
    source: { method: 'GET', path: '/openapi.json' },
    openapiVersion,
    specFingerprint: hash(row.specFingerprint, 'specFingerprint'),
    externalReferenceCount,
    unresolvedLocalReferenceCount,
    complete,
    baseline,
    summary,
    operations,
    findings,
  };
}

export async function fetchOmniApiContractRadar(
  instanceId: string,
  signal?: AbortSignal,
): Promise<OmniApiContractRadarReport> {
  const normalizedInstanceId = instanceId.trim();
  if (!normalizedInstanceId || normalizedInstanceId.length > 500) {
    throw new Error('Select a saved Omni instance before checking its API contract.');
  }
  let response: Response;
  try {
    response = await fetch(`/api/omni-api-contract-radar?instanceId=${encodeURIComponent(normalizedInstanceId)}`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new Error('Contract Radar could not reach the local OmniKit server.');
  }
  if (!response.ok) {
    const message = response.status === 423
      ? 'Unlock the local vault before checking the tenant API contract.'
      : response.status === 404
        ? 'The saved Omni instance is no longer available.'
        : `The tenant API contract could not be checked (HTTP ${response.status}).`;
    if (response.status === 423) emitVaultLocked(message);
    throw new Error(message);
  }
  const payload = await response.json().catch(() => fail('JSON'));
  const report = parseOmniApiContractRadarReport(payload);
  if (report.instanceId !== normalizedInstanceId) fail('request scope mismatch');
  return report;
}
