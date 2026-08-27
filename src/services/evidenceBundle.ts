import { redactAiPromptSecrets } from './aiPromptSecurityShared';

export type EvidenceAssertion = 'observed' | 'inferred' | 'operator_confirmed' | 'unverified';
export type EvidenceFreshnessState = 'current' | 'stale' | 'unknown';

export interface EvidenceInstanceScope {
  id: string;
  label: string;
  origin: string;
}

export interface EvidenceSource {
  label: string;
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path?: string;
  assertion: EvidenceAssertion;
}

export interface EvidenceCoverage {
  included: number;
  total: number | null;
  complete: boolean;
  unit: string;
}

export interface EvidenceFreshness {
  checkedAt: string;
  state: EvidenceFreshnessState;
}

export interface EvidenceSanitization {
  secretsExcluded: true;
  rawHeadersExcluded: true;
  rawUpstreamResponsesExcluded: true;
  redactedFields: string[];
}

export interface EvidenceBundle<T> {
  schemaVersion: 1;
  evidenceId: string;
  generatedAt: string;
  selectedInstance: EvidenceInstanceScope;
  scope: Record<string, string | string[] | number | boolean | null>;
  sources: EvidenceSource[];
  coverage: EvidenceCoverage;
  exclusions: string[];
  freshness: EvidenceFreshness;
  sanitization: EvidenceSanitization;
  evidence: T;
}

const FORBIDDEN_EVIDENCE_KEYS = new Set([
  'apikey',
  'api_key',
  'authorization',
  'cookie',
  'cookies',
  'headers',
  'password',
  'passphrase',
  'raw',
  'rawresponse',
  'raw_response',
  'secret',
  'token',
]);

function normalizedKey(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9_]/g, '');
}

function boundedText(value: string, maxLength: number): string {
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, maxLength);
}

const HTTP_CREDENTIAL_URL = /(https?:\/\/)([^/\s:@]+):([^@\s/]+)@/gi;
const TOKEN_CREDENTIAL = /\b((?:Bearer|token)\s+)[A-Za-z0-9._~+/=-]+\b/gi;

function sanitizedText(
  value: string,
  path: string,
  redactedFields: string[],
): string {
  const bounded = boundedText(value, 20_000);
  const redacted = redactAiPromptSecrets(bounded)
    .replace(HTTP_CREDENTIAL_URL, '$1[redacted]:[redacted]@')
    .replace(TOKEN_CREDENTIAL, '$1[redacted]');
  if (redacted !== bounded) redactedFields.push(path || '$');
  return redacted;
}

function sanitizeUnknown(value: unknown, path: string, redactedFields: string[]): unknown {
  if (Array.isArray(value)) {
    return value.map((item, index) => sanitizeUnknown(item, `${path}[${index}]`, redactedFields));
  }
  if (!value || typeof value !== 'object') {
    return typeof value === 'string' ? sanitizedText(value, path, redactedFields) : value;
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    const itemPath = path ? `${path}.${key}` : key;
    if (FORBIDDEN_EVIDENCE_KEYS.has(normalizedKey(key))) {
      redactedFields.push(itemPath);
      continue;
    }
    sanitized[key] = sanitizeUnknown(item, itemPath, redactedFields);
  }
  return sanitized;
}

export function sanitizeEvidence<T>(value: T): {
  value: T;
  redactedFields: string[];
} {
  const redactedFields: string[] = [];
  return {
    value: sanitizeUnknown(value, '', redactedFields) as T,
    redactedFields: [...new Set(redactedFields)].sort(),
  };
}

function evidenceId(prefix: string, instanceId: string, checkedAt: string): string {
  const seed = `${prefix}:${instanceId}:${checkedAt}`;
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `${boundedText(prefix, 40).replace(/[^a-zA-Z0-9_-]/g, '-').toLowerCase()}-${(hash >>> 0).toString(36)}`;
}

export function createEvidenceBundle<T>(input: {
  kind: string;
  generatedAt?: string;
  selectedInstance: EvidenceInstanceScope;
  scope?: EvidenceBundle<T>['scope'];
  sources: EvidenceSource[];
  coverage: EvidenceCoverage;
  exclusions?: string[];
  freshness?: Partial<EvidenceFreshness>;
  evidence: T;
}): EvidenceBundle<T> {
  const generatedAt = input.generatedAt ?? new Date().toISOString();
  const candidate: EvidenceBundle<T> = {
    schemaVersion: 1,
    evidenceId: evidenceId(input.kind, input.selectedInstance.id, generatedAt),
    generatedAt,
    selectedInstance: {
      id: boundedText(input.selectedInstance.id, 500),
      label: boundedText(input.selectedInstance.label, 500),
      origin: boundedText(input.selectedInstance.origin, 1_000),
    },
    scope: input.scope ?? {},
    sources: input.sources.map((source) => ({
      label: boundedText(source.label, 500),
      ...(source.method ? { method: source.method } : {}),
      ...(source.path ? { path: boundedText(source.path, 1_000) } : {}),
      assertion: source.assertion,
    })),
    coverage: {
      included: Math.max(0, Math.trunc(input.coverage.included)),
      total: input.coverage.total === null ? null : Math.max(0, Math.trunc(input.coverage.total)),
      complete: input.coverage.complete,
      unit: boundedText(input.coverage.unit, 100),
    },
    exclusions: [...new Set((input.exclusions ?? []).map((item) => boundedText(item, 1_000)).filter(Boolean))],
    freshness: {
      checkedAt: input.freshness?.checkedAt ?? generatedAt,
      state: input.freshness?.state ?? 'current',
    },
    sanitization: {
      secretsExcluded: true,
      rawHeadersExcluded: true,
      rawUpstreamResponsesExcluded: true,
      redactedFields: [],
    },
    evidence: input.evidence,
  };
  const sanitized = sanitizeEvidence(candidate);
  sanitized.value.sanitization.redactedFields = sanitized.redactedFields;
  return sanitized.value;
}

export function evidenceBundleJson(bundle: EvidenceBundle<unknown>): string {
  return `${JSON.stringify(bundle, null, 2)}\n`;
}
