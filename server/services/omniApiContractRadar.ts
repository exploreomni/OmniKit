import { createHash } from 'node:crypto';

import { assertSafeOutboundUrl, validateBaseUrl } from '../security';
import {
  OMNI_API_CONTRACTS,
  type OmniApiContract,
  type OmniApiContractStatus,
  type OmniApiProbeMode,
  type OmniApiProductionPolicy,
} from './omniApiContracts';
import type { SavedInstance } from './nativeVault';

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES_LIMIT = 16 * 1024 * 1024;
const MAX_OPENAPI_PATHS = 5_000;
const MAX_OPENAPI_OPERATIONS = 10_000;
const MAX_CANONICAL_DEPTH = 80;
const MAX_CANONICAL_NODES = 200_000;
const MAX_REFERENCE_SCAN_NODES = 500_000;
const MAX_BASELINES = 200;
const DOCUMENTATION_ONLY_KEYS = new Set(['description', 'summary', 'example', 'examples', 'externalDocs']);
const SCHEMA_DICTIONARY_KEYS = new Set(['properties', 'patternProperties', 'dependentSchemas', '$defs', 'definitions']);
const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS', 'TRACE'] as const;
const HTTP_METHOD_SET = new Set<string>(HTTP_METHODS);

export type TenantOpenApiMethod = typeof HTTP_METHODS[number];

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
}

export interface TenantOpenApiSnapshot {
  schemaVersion: 1;
  instanceId: string;
  tenantOrigin: string;
  checkedAt: string;
  openapiVersion: string;
  specFingerprint: string;
  operationCount: number;
  externalReferenceCount: number;
  unresolvedLocalReferenceCount: number;
  operations: TenantOpenApiOperation[];
}

export type OmniApiContractDriftCategory =
  | 'tenant_only'
  | 'registry_only'
  | 'method_mismatch'
  | 'schema_changed'
  | 'classification_mismatch';

export interface OmniApiContractDriftFinding {
  id: string;
  category: OmniApiContractDriftCategory;
  severity: 'review' | 'warning';
  path: string;
  method?: TenantOpenApiMethod | string;
  registryId?: string;
  message: string;
}

export interface OmniApiContractRadarOperation extends TenantOpenApiOperation {
  registry?: {
    id: string;
    status: OmniApiContractStatus;
    probeMode: OmniApiProbeMode;
    productionPolicy?: OmniApiProductionPolicy;
  };
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
  operations: OmniApiContractRadarOperation[];
  findings: OmniApiContractDriftFinding[];
}

export type OmniApiContractRadarErrorCode =
  | 'INVALID_INSTANCE_ORIGIN'
  | 'OUTBOUND_REJECTED'
  | 'REQUEST_TIMEOUT'
  | 'UNEXPECTED_REDIRECT'
  | 'OPENAPI_ACCESS_DENIED'
  | 'OPENAPI_NOT_FOUND'
  | 'UPSTREAM_REJECTED'
  | 'RESPONSE_TOO_LARGE'
  | 'INVALID_JSON'
  | 'INVALID_OPENAPI';

export class OmniApiContractRadarError extends Error {
  constructor(
    readonly code: OmniApiContractRadarErrorCode,
    readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'OmniApiContractRadarError';
  }
}

export interface OmniApiContractRadarDependencies {
  fetchImpl?: typeof fetch;
  assertSafeUrl?: (url: string) => Promise<void>;
  now?: () => Date;
  timeoutMs?: number;
  maxResponseBytes?: number;
  signal?: AbortSignal;
}

export type TenantOpenApiInstance = Pick<SavedInstance, 'id' | 'baseUrl'>;

type JsonRecord = Record<string, unknown>;

const baselines = new Map<string, TenantOpenApiSnapshot>();

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 31 || code === 127;
  });
}

function radarError(
  code: OmniApiContractRadarErrorCode,
  statusCode: number,
  message: string,
): OmniApiContractRadarError {
  return new OmniApiContractRadarError(code, statusCode, message);
}

function exactTenantOrigin(baseUrl: string): string {
  const normalized = baseUrl.trim();
  const formatError = validateBaseUrl(normalized);
  if (formatError) throw radarError('INVALID_INSTANCE_ORIGIN', 400, 'The saved Omni instance origin is invalid.');
  const parsed = new URL(normalized);
  if (
    parsed.pathname !== '/'
    || parsed.search
    || parsed.hash
    || parsed.username
    || parsed.password
  ) {
    throw radarError('INVALID_INSTANCE_ORIGIN', 400, 'The saved Omni instance must use the exact HTTPS tenant origin.');
  }
  return parsed.origin;
}

function sanitizeTimeout(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_TIMEOUT_MS;
  return Math.min(30_000, Math.max(1, Math.floor(value!)));
}

function sanitizeMaximumBytes(value: number | undefined): number {
  if (!Number.isFinite(value)) return DEFAULT_MAX_RESPONSE_BYTES;
  return Math.min(MAX_RESPONSE_BYTES_LIMIT, Math.max(1, Math.floor(value!)));
}

async function readBoundedJson(response: Response, maximumBytes: number): Promise<unknown> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength !== null) {
    if (!/^\d+$/.test(declaredLength)) {
      throw radarError('INVALID_OPENAPI', 502, 'The tenant OpenAPI response has an invalid content length.');
    }
    const bytes = Number(declaredLength);
    if (!Number.isSafeInteger(bytes) || bytes > maximumBytes) {
      throw radarError('RESPONSE_TOO_LARGE', 502, 'The tenant OpenAPI response exceeds the bounded evidence limit.');
    }
  }
  if (!response.body) throw radarError('INVALID_JSON', 502, 'The tenant OpenAPI response did not contain JSON.');

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let bytesRead = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        throw radarError('RESPONSE_TOO_LARGE', 502, 'The tenant OpenAPI response exceeds the bounded evidence limit.');
      }
      try {
        text += decoder.decode(value, { stream: true });
      } catch {
        throw radarError('INVALID_JSON', 502, 'The tenant OpenAPI response was not valid UTF-8 JSON.');
      }
    }
    try {
      text += decoder.decode();
      return JSON.parse(text) as unknown;
    } catch (error) {
      if (error instanceof OmniApiContractRadarError) throw error;
      throw radarError('INVALID_JSON', 502, 'The tenant OpenAPI response was not valid JSON.');
    }
  } finally {
    reader.releaseLock();
  }
}

function normalizeOpenApiPath(rawPath: string): string {
  if (
    !rawPath.startsWith('/')
    || rawPath.length > 500
    || rawPath.includes('?')
    || rawPath.includes('#')
    || rawPath.includes('\\')
    || hasControlCharacters(rawPath)
  ) throw radarError('INVALID_OPENAPI', 502, 'The tenant OpenAPI document contains an invalid path.');

  const normalized = rawPath.replace(/\{([A-Za-z0-9_.-]{1,100})\}/g, ':param');
  if (normalized.includes('{') || normalized.includes('}') || normalized.includes('//')) {
    throw radarError('INVALID_OPENAPI', 502, 'The tenant OpenAPI document contains an invalid path template.');
  }
  return normalized;
}

function decodeJsonPointerPart(value: string): string | null {
  if (/~(?![01])/u.test(value)) return null;
  return value.replace(/~1/g, '/').replace(/~0/g, '~');
}

function resolveLocalReference(root: unknown, reference: string): unknown {
  if (reference === '#') return root;
  if (!reference.startsWith('#/')) return undefined;
  let current = root;
  for (const rawPart of reference.slice(2).split('/')) {
    const part = decodeJsonPointerPart(rawPart);
    if (part === null || !isRecord(current) || !Object.prototype.hasOwnProperty.call(current, part)) return undefined;
    current = current[part];
  }
  return current;
}

interface CanonicalState {
  nodes: number;
  referenceFingerprints: Map<string, string>;
}

function canonicalContractValue(
  value: unknown,
  root: unknown,
  state: CanonicalState,
  referenceStack: ReadonlySet<string> = new Set(),
  depth = 0,
  preserveDictionaryKeys = false,
): unknown {
  state.nodes += 1;
  if (state.nodes > MAX_CANONICAL_NODES || depth > MAX_CANONICAL_DEPTH) {
    throw radarError('INVALID_OPENAPI', 502, 'The tenant OpenAPI schema exceeds the bounded normalization limit.');
  }
  if (value === null || typeof value === 'boolean' || typeof value === 'number' || typeof value === 'string') return value;
  if (Array.isArray(value)) {
    return value.map((item) => canonicalContractValue(item, root, state, referenceStack, depth + 1));
  }
  if (!isRecord(value)) return null;

  if (typeof value.$ref === 'string') {
    const reference = value.$ref;
    if (!reference.startsWith('#')) return { externalReferenceFingerprint: sha256(reference) };
    if (referenceStack.has(reference)) return { localReferenceFingerprint: sha256(`${reference}:cycle`) };
    const cached = state.referenceFingerprints.get(reference);
    if (cached) return { localReferenceFingerprint: cached };
    const target = resolveLocalReference(root, reference);
    if (target === undefined) return { localReferenceFingerprint: sha256(`${reference}:unresolved`) };
    const nextStack = new Set(referenceStack);
    nextStack.add(reference);
    const normalizedTarget = canonicalContractValue(target, root, state, nextStack, depth + 1);
    const fingerprint = sha256(JSON.stringify(normalizedTarget));
    state.referenceFingerprints.set(reference, fingerprint);
    return { localReferenceFingerprint: fingerprint };
  }

  return Object.fromEntries(
    Object.keys(value)
      .filter((key) => preserveDictionaryKeys || !DOCUMENTATION_ONLY_KEYS.has(key))
      .sort()
      .map((key) => [key, canonicalContractValue(
        value[key],
        root,
        state,
        referenceStack,
        depth + 1,
        preserveDictionaryKeys ? false : SCHEMA_DICTIONARY_KEYS.has(key),
      )]),
  );
}

function contractFingerprint(value: unknown, root: unknown, referenceFingerprints: Map<string, string>): string {
  const state: CanonicalState = { nodes: 0, referenceFingerprints };
  return sha256(JSON.stringify(canonicalContractValue(value, root, state)));
}

function scanReferenceCoverage(value: unknown): {
  externalReferenceCount: number;
  unresolvedLocalReferenceCount: number;
} {
  const stack: unknown[] = [value];
  let nodes = 0;
  let externalReferenceCount = 0;
  let unresolvedLocalReferenceCount = 0;
  while (stack.length > 0) {
    const next = stack.pop();
    nodes += 1;
    if (nodes > MAX_REFERENCE_SCAN_NODES) {
      throw radarError('INVALID_OPENAPI', 502, 'The tenant OpenAPI document exceeds the bounded reference scan limit.');
    }
    if (Array.isArray(next)) {
      stack.push(...next);
      continue;
    }
    if (!isRecord(next)) continue;
    if (typeof next.$ref === 'string') {
      if (next.$ref.startsWith('#')) {
        if (resolveLocalReference(value, next.$ref) === undefined) unresolvedLocalReferenceCount += 1;
      } else {
        externalReferenceCount += 1;
      }
    }
    stack.push(...Object.values(next));
  }
  return { externalReferenceCount, unresolvedLocalReferenceCount };
}

function validateOptionalOperationShape(operation: JsonRecord, pathParameters: unknown): void {
  if (pathParameters !== undefined && !Array.isArray(pathParameters)) {
    throw radarError('INVALID_OPENAPI', 502, 'The tenant OpenAPI path parameters are invalid.');
  }
  if (operation.parameters !== undefined && !Array.isArray(operation.parameters)) {
    throw radarError('INVALID_OPENAPI', 502, 'The tenant OpenAPI operation parameters are invalid.');
  }
  if (operation.requestBody !== undefined && !isRecord(operation.requestBody)) {
    throw radarError('INVALID_OPENAPI', 502, 'The tenant OpenAPI request body contract is invalid.');
  }
  if (operation.callbacks !== undefined && !isRecord(operation.callbacks)) {
    throw radarError('INVALID_OPENAPI', 502, 'The tenant OpenAPI callback contract is invalid.');
  }
  if (operation.security !== undefined && !Array.isArray(operation.security)) {
    throw radarError('INVALID_OPENAPI', 502, 'The tenant OpenAPI security contract is invalid.');
  }
  if (!isRecord(operation.responses) || Object.keys(operation.responses).length === 0) {
    throw radarError('INVALID_OPENAPI', 502, 'The tenant OpenAPI operation responses are invalid.');
  }
  if (operation.deprecated !== undefined && typeof operation.deprecated !== 'boolean') {
    throw radarError('INVALID_OPENAPI', 502, 'The tenant OpenAPI deprecation flag is invalid.');
  }
}

export function normalizeTenantOpenApiDocument(
  instanceId: string,
  tenantOrigin: string,
  checkedAt: string,
  raw: unknown,
): TenantOpenApiSnapshot {
  if (exactTenantOrigin(tenantOrigin) !== tenantOrigin) {
    throw radarError('INVALID_INSTANCE_ORIGIN', 400, 'The saved Omni instance origin is invalid.');
  }
  if (!isRecord(raw) || !isRecord(raw.paths)) {
    throw radarError('INVALID_OPENAPI', 502, 'The tenant did not return a valid OpenAPI document.');
  }
  const openapiVersion = typeof raw.openapi === 'string' ? raw.openapi.trim() : '';
  if (!/^3\.\d+(?:\.\d+)?(?:[-+][A-Za-z0-9.-]+)?$/.test(openapiVersion) || openapiVersion.length > 40) {
    throw radarError('INVALID_OPENAPI', 502, 'The tenant did not return a supported OpenAPI 3 document.');
  }
  const pathEntries = Object.entries(raw.paths);
  if (pathEntries.length > MAX_OPENAPI_PATHS) {
    throw radarError('INVALID_OPENAPI', 502, 'The tenant OpenAPI document exceeds the bounded path limit.');
  }

  const operations: TenantOpenApiOperation[] = [];
  const seen = new Set<string>();
  const referenceFingerprints = new Map<string, string>();
  for (const [rawPath, rawPathItem] of pathEntries) {
    if (!isRecord(rawPathItem)) {
      throw radarError('INVALID_OPENAPI', 502, 'The tenant OpenAPI document contains an invalid path item.');
    }
    const path = normalizeOpenApiPath(rawPath);
    for (const [rawMethod, rawOperation] of Object.entries(rawPathItem)) {
      const method = rawMethod.toUpperCase();
      if (!HTTP_METHOD_SET.has(method)) continue;
      if (!isRecord(rawOperation)) {
        throw radarError('INVALID_OPENAPI', 502, 'The tenant OpenAPI document contains an invalid operation.');
      }
      validateOptionalOperationShape(rawOperation, rawPathItem.parameters);
      const typedMethod = method as TenantOpenApiMethod;
      const key = `${typedMethod} ${path}`;
      if (seen.has(key)) {
        throw radarError('INVALID_OPENAPI', 502, 'The tenant OpenAPI document contains ambiguous normalized operations.');
      }
      seen.add(key);
      const requestContract = {
        parameters: [
          ...(Array.isArray(rawPathItem.parameters) ? rawPathItem.parameters : []),
          ...(Array.isArray(rawOperation.parameters) ? rawOperation.parameters : []),
        ],
        requestBody: rawOperation.requestBody ?? null,
        callbacks: rawOperation.callbacks ?? null,
        security: rawOperation.security ?? null,
      };
      const responseContract = { responses: rawOperation.responses };
      const requestSchemaFingerprint = contractFingerprint(requestContract, raw, referenceFingerprints);
      const responseSchemaFingerprint = contractFingerprint(responseContract, raw, referenceFingerprints);
      const schemaFingerprint = sha256(`${requestSchemaFingerprint}\u0000${responseSchemaFingerprint}`);
      const deprecated = rawOperation.deprecated === true;
      operations.push({
        key,
        path,
        method: typedMethod,
        pathFingerprint: sha256(path),
        methodFingerprint: sha256(typedMethod),
        requestSchemaFingerprint,
        responseSchemaFingerprint,
        schemaFingerprint,
        operationFingerprint: sha256(`${key}\u0000${schemaFingerprint}\u0000${deprecated ? 'deprecated' : 'current'}`),
        deprecated,
      });
      if (operations.length > MAX_OPENAPI_OPERATIONS) {
        throw radarError('INVALID_OPENAPI', 502, 'The tenant OpenAPI document exceeds the bounded operation limit.');
      }
    }
  }
  operations.sort((left, right) => left.key.localeCompare(right.key));
  const specFingerprint = sha256(JSON.stringify({
    openapiVersion,
    operations: operations.map((operation) => [operation.key, operation.operationFingerprint]),
  }));
  const referenceCoverage = scanReferenceCoverage(raw);
  return {
    schemaVersion: 1,
    instanceId,
    tenantOrigin,
    checkedAt,
    openapiVersion,
    specFingerprint,
    operationCount: operations.length,
    ...referenceCoverage,
    operations,
  };
}

export async function fetchTenantOpenApiSnapshot(
  instance: TenantOpenApiInstance,
  dependencies: OmniApiContractRadarDependencies = {},
): Promise<TenantOpenApiSnapshot> {
  const tenantOrigin = exactTenantOrigin(instance.baseUrl);
  const targetUrl = `${tenantOrigin}/openapi.json`;
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort(dependencies.signal?.reason);
  if (dependencies.signal?.aborted) controller.abort(dependencies.signal.reason);
  else dependencies.signal?.addEventListener('abort', abortFromCaller, { once: true });
  const timeout = setTimeout(() => controller.abort(), sanitizeTimeout(dependencies.timeoutMs));
  timeout.unref();
  try {
    try {
      await (dependencies.assertSafeUrl
        || ((url: string) => assertSafeOutboundUrl(url, { label: 'tenant_openapi_url' })))(targetUrl);
    } catch {
      throw radarError('OUTBOUND_REJECTED', 400, 'The tenant OpenAPI URL could not be validated safely.');
    }
    const response = await (dependencies.fetchImpl || fetch)(targetUrl, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
      redirect: 'manual',
      signal: controller.signal,
    });
    if (response.status >= 300 && response.status < 400) {
      throw radarError('UNEXPECTED_REDIRECT', 502, 'The tenant OpenAPI request returned an unexpected redirect.');
    }
    if (response.status === 401 || response.status === 403) {
      throw radarError('OPENAPI_ACCESS_DENIED', response.status, 'The tenant did not expose its public OpenAPI document to this request.');
    }
    if (response.status === 404) {
      throw radarError('OPENAPI_NOT_FOUND', 502, 'The tenant OpenAPI document was not found.');
    }
    if (response.status < 200 || response.status >= 300) {
      throw radarError('UPSTREAM_REJECTED', response.status === 429 ? 429 : 502, 'Omni rejected the tenant OpenAPI request.');
    }
    const checkedAt = (dependencies.now?.() || new Date()).toISOString();
    return normalizeTenantOpenApiDocument(
      instance.id,
      tenantOrigin,
      checkedAt,
      await readBoundedJson(response, sanitizeMaximumBytes(dependencies.maxResponseBytes)),
    );
  } catch (error) {
    if (error instanceof OmniApiContractRadarError) throw error;
    if (controller.signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
      throw radarError('REQUEST_TIMEOUT', 504, 'The tenant OpenAPI request timed out or was cancelled.');
    }
    throw radarError('UPSTREAM_REJECTED', 502, 'The tenant OpenAPI request could not be completed safely.');
  } finally {
    clearTimeout(timeout);
    dependencies.signal?.removeEventListener('abort', abortFromCaller);
  }
}

interface RegistryOperation {
  key: string;
  path: string;
  method: string;
  contract: OmniApiContract;
}

function registryOperations(): RegistryOperation[] {
  return OMNI_API_CONTRACTS.flatMap((contract) => contract.methods.map((method) => ({
    key: `${method} ${contract.path}`,
    path: contract.path,
    method,
    contract,
  }))).sort((left, right) => left.key.localeCompare(right.key));
}

function finding(input: Omit<OmniApiContractDriftFinding, 'id'>): OmniApiContractDriftFinding {
  return {
    ...input,
    id: sha256([
      input.category,
      input.path,
      input.method || '',
      input.registryId || '',
    ].join('\u0000')),
  };
}

function classificationMismatch(contract: OmniApiContract, tenantDeprecated: boolean): boolean {
  const registryDeprecated = contract.status === 'deprecated' || contract.status === 'retired';
  return registryDeprecated !== tenantDeprecated;
}

export function buildOmniApiContractRadarReport(
  snapshot: TenantOpenApiSnapshot,
  baseline?: TenantOpenApiSnapshot,
): OmniApiContractRadarReport {
  const registry = registryOperations();
  const registryByKey = new Map(registry.map((operation) => [operation.key, operation]));
  const registryMethodsByPath = new Map<string, Set<string>>();
  for (const operation of registry) {
    const methods = registryMethodsByPath.get(operation.path) || new Set<string>();
    methods.add(operation.method);
    registryMethodsByPath.set(operation.path, methods);
  }
  const tenantByKey = new Map(snapshot.operations.map((operation) => [operation.key, operation]));
  const tenantMethodsByPath = new Map<string, Set<string>>();
  for (const operation of snapshot.operations) {
    const methods = tenantMethodsByPath.get(operation.path) || new Set<string>();
    methods.add(operation.method);
    tenantMethodsByPath.set(operation.path, methods);
  }

  const findings: OmniApiContractDriftFinding[] = [];
  const operations: OmniApiContractRadarOperation[] = snapshot.operations.map((operation) => {
    const registered = registryByKey.get(operation.key)?.contract;
    if (!registered) {
      const category: OmniApiContractDriftCategory = registryMethodsByPath.has(operation.path)
        ? 'method_mismatch'
        : 'tenant_only';
      findings.push(finding({
        category,
        severity: category === 'method_mismatch' ? 'warning' : 'review',
        path: operation.path,
        method: operation.method,
        message: category === 'method_mismatch'
          ? `Tenant OpenAPI exposes ${operation.method} for this registered path, but that method is absent from OmniKit's registry.`
          : `Tenant OpenAPI exposes ${operation.method} for an operation absent from OmniKit's registry.`,
      }));
      return operation;
    }
    if (classificationMismatch(registered, operation.deprecated)) {
      findings.push(finding({
        category: 'classification_mismatch',
        severity: 'warning',
        path: operation.path,
        method: operation.method,
        registryId: registered.id,
        message: 'Tenant OpenAPI deprecation evidence does not match the registry classification.',
      }));
    }
    return {
      ...operation,
      registry: {
        id: registered.id,
        status: registered.status,
        probeMode: registered.probeMode,
        ...(registered.productionPolicy ? { productionPolicy: registered.productionPolicy } : {}),
      },
    };
  });

  for (const registered of registry) {
    if (tenantByKey.has(registered.key)) continue;
    const category: OmniApiContractDriftCategory = tenantMethodsByPath.has(registered.path)
      ? 'method_mismatch'
      : 'registry_only';
    findings.push(finding({
      category,
      severity: 'warning',
      path: registered.path,
      method: registered.method,
      registryId: registered.contract.id,
      message: category === 'method_mismatch'
        ? `OmniKit registers ${registered.method} for this path, but tenant OpenAPI exposes different methods.`
        : `OmniKit registers ${registered.method}, but tenant OpenAPI does not expose the operation.`,
    }));
  }

  if (baseline) {
    const baselineByKey = new Map(baseline.operations.map((operation) => [operation.key, operation]));
    for (const operation of snapshot.operations) {
      const previous = baselineByKey.get(operation.key);
      if (previous && previous.schemaFingerprint !== operation.schemaFingerprint) {
        findings.push(finding({
          category: 'schema_changed',
          severity: 'warning',
          path: operation.path,
          method: operation.method,
          registryId: registryByKey.get(operation.key)?.contract.id,
          message: 'The normalized request or response schema fingerprint changed since the prior tenant snapshot.',
        }));
      }
    }
  }

  findings.sort((left, right) => (
    left.category.localeCompare(right.category)
    || left.path.localeCompare(right.path)
    || String(left.method || '').localeCompare(String(right.method || ''))
  ));
  const categoryCount = (category: OmniApiContractDriftCategory) => findings.filter((item) => item.category === category).length;
  return {
    schemaVersion: 1,
    instanceId: snapshot.instanceId,
    tenantOrigin: snapshot.tenantOrigin,
    checkedAt: snapshot.checkedAt,
    source: { method: 'GET', path: '/openapi.json' },
    openapiVersion: snapshot.openapiVersion,
    specFingerprint: snapshot.specFingerprint,
    externalReferenceCount: snapshot.externalReferenceCount,
    unresolvedLocalReferenceCount: snapshot.unresolvedLocalReferenceCount,
    complete: snapshot.externalReferenceCount === 0 && snapshot.unresolvedLocalReferenceCount === 0,
    baseline: baseline
      ? { available: true, checkedAt: baseline.checkedAt, specFingerprint: baseline.specFingerprint }
      : { available: false },
    summary: {
      tenantOperations: snapshot.operationCount,
      registryOperations: registry.length,
      matchedOperations: operations.filter((operation) => operation.registry !== undefined).length,
      tenantOnly: categoryCount('tenant_only'),
      registryOnly: categoryCount('registry_only'),
      methodMismatches: categoryCount('method_mismatch'),
      schemaChanges: categoryCount('schema_changed'),
      classificationMismatches: categoryCount('classification_mismatch'),
    },
    operations,
    findings,
  };
}

function baselineKey(instance: TenantOpenApiInstance): string {
  return sha256(`${instance.id}\u0000${exactTenantOrigin(instance.baseUrl)}`);
}

function rememberBaseline(key: string, snapshot: TenantOpenApiSnapshot): void {
  baselines.delete(key);
  baselines.set(key, snapshot);
  while (baselines.size > MAX_BASELINES) {
    const oldest = baselines.keys().next().value;
    if (typeof oldest !== 'string') break;
    baselines.delete(oldest);
  }
}

export async function getOmniApiContractRadarReport(
  instance: TenantOpenApiInstance,
  dependencies: OmniApiContractRadarDependencies = {},
): Promise<OmniApiContractRadarReport> {
  const key = baselineKey(instance);
  const baseline = baselines.get(key);
  const snapshot = await fetchTenantOpenApiSnapshot(instance, dependencies);
  const report = buildOmniApiContractRadarReport(snapshot, baseline);
  rememberBaseline(key, snapshot);
  return report;
}

export function clearOmniApiContractRadarBaselinesForTests(): void {
  baselines.clear();
}
