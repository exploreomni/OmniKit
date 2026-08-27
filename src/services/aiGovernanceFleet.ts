import { ApiError } from '@/services/omniApi';
import { emitVaultLocked } from '@/services/vaultEvents';
import type { EvidenceBundle } from '@/services/evidenceBundle';

export type AIGovernanceEvidenceState =
  | 'available'
  | 'partial'
  | 'permission_denied'
  | 'unsupported'
  | 'rate_limited'
  | 'unavailable'
  | 'invalid_response';

export type AIEvalReadState =
  | Exclude<AIGovernanceEvidenceState, 'partial'>
  | 'not_checked'
  | 'not_applicable';

export type AIEvalRunStatus = 'pending' | 'running' | 'complete' | 'failed' | 'cancelled' | 'unknown';

export interface AICreditControlsEvidenceDTO {
  state: AIGovernanceEvidenceState;
  accountCreditLimit: number | null;
  creditsUsed: number | null;
  remainingCredits: number | null;
  utilizationPercent: number | null;
  downgradeCredits: number | null;
  shutoffCredits: number | null;
  userDefaultCredits: number | null;
  entityGroupDefaultCredits: number | null;
  periodStart: string | null;
  periodEnd: string | null;
  reasonCode: string;
  detail: string;
}

export interface AIEvalCoverageEvidenceDTO {
  state: AIGovernanceEvidenceState;
  promptSetCount: number | null;
  configuredPromptCount: number | null;
  runCollectionState: AIEvalReadState;
  latestRunDetailState: AIEvalReadState;
  latestRun: {
    status: AIEvalRunStatus;
    createdAt: string | null;
    completedAt: string | null;
    totalResultCount: number | null;
    terminalResultCount: number | null;
    detailResultCount: number;
    scoredResultCount: number;
    averageScore: number | null;
    errorResultCount: number;
  } | null;
  contractState: 'contract_observed' | 'unverified';
  discoveredReadOperations: number;
  discoveredWriteOperations: number;
  resultEvidenceAvailable: boolean;
  reasonCode: string;
  detail: string;
}

export interface AIGovernanceInstanceEvidenceDTO {
  credits: AICreditControlsEvidenceDTO;
  evals: AIEvalCoverageEvidenceDTO;
}

export interface AIGovernanceInstanceReportDTO {
  instanceId: string;
  instanceLabel: string;
  state: AIGovernanceEvidenceState;
  bundle: EvidenceBundle<AIGovernanceInstanceEvidenceDTO>;
}

export interface AIGovernanceFleetReportDTO {
  schemaVersion: 1;
  generatedAt: string;
  coverage: { included: number; total: number; complete: boolean };
  instances: AIGovernanceInstanceReportDTO[];
  exclusions: string[];
  guardrails: string[];
}

type UnknownRecord = Record<string, unknown>;

const EVIDENCE_STATES = new Set<AIGovernanceEvidenceState>([
  'available', 'partial', 'permission_denied', 'unsupported', 'rate_limited', 'unavailable', 'invalid_response',
]);
const EVAL_READ_STATES = new Set<AIEvalReadState>([
  'available', 'permission_denied', 'unsupported', 'rate_limited', 'unavailable', 'invalid_response',
  'not_checked', 'not_applicable',
]);
const EVAL_RUN_STATUSES = new Set<AIEvalRunStatus>([
  'pending', 'running', 'complete', 'failed', 'cancelled', 'unknown',
]);

function record(value: unknown, label: string): UnknownRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid AI governance response: ${label}.`);
  return value as UnknownRecord;
}

function stringValue(value: unknown, label: string, maxLength = 2_000): string {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) throw new Error(`Invalid AI governance response: ${label}.`);
  return value;
}

function evidenceState(value: unknown, label: string): AIGovernanceEvidenceState {
  if (!EVIDENCE_STATES.has(value as AIGovernanceEvidenceState)) throw new Error(`Invalid AI governance response: ${label}.`);
  return value as AIGovernanceEvidenceState;
}

function evalReadState(value: unknown, label: string): AIEvalReadState {
  if (!EVAL_READ_STATES.has(value as AIEvalReadState)) throw new Error(`Invalid AI governance response: ${label}.`);
  return value as AIEvalReadState;
}

function numberOrNull(value: unknown, label: string): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Invalid AI governance response: ${label}.`);
  return value;
}

function stringOrNull(value: unknown, label: string): string | null {
  if (value === null) return null;
  return stringValue(value, label);
}

function timestampOrNull(value: unknown, label: string): string | null {
  const parsed = stringOrNull(value, label);
  if (parsed !== null && !Number.isFinite(Date.parse(parsed))) throw new Error(`Invalid AI governance response: ${label}.`);
  return parsed;
}

function nonNegativeIntegerOrNull(value: unknown, label: string): number | null {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`Invalid AI governance response: ${label}.`);
  }
  return value;
}

function stringArray(value: unknown, label: string, maxItems = 100): string[] {
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`Invalid AI governance response: ${label}.`);
  return value.map((item, index) => stringValue(item, `${label} ${index}`, 2_000));
}

function parseCredits(value: unknown): AICreditControlsEvidenceDTO {
  const row = record(value, 'credits');
  const state = evidenceState(row.state, 'credit state');
  if (state === 'partial') throw new Error('Invalid AI governance response: credit state.');
  return {
    state,
    accountCreditLimit: numberOrNull(row.accountCreditLimit, 'accountCreditLimit'),
    creditsUsed: numberOrNull(row.creditsUsed, 'creditsUsed'),
    remainingCredits: numberOrNull(row.remainingCredits, 'remainingCredits'),
    utilizationPercent: numberOrNull(row.utilizationPercent, 'utilizationPercent'),
    downgradeCredits: numberOrNull(row.downgradeCredits, 'downgradeCredits'),
    shutoffCredits: numberOrNull(row.shutoffCredits, 'shutoffCredits'),
    userDefaultCredits: numberOrNull(row.userDefaultCredits, 'userDefaultCredits'),
    entityGroupDefaultCredits: numberOrNull(row.entityGroupDefaultCredits, 'entityGroupDefaultCredits'),
    periodStart: timestampOrNull(row.periodStart, 'periodStart'),
    periodEnd: timestampOrNull(row.periodEnd, 'periodEnd'),
    reasonCode: stringValue(row.reasonCode, 'reasonCode', 200),
    detail: stringValue(row.detail, 'detail', 1_000),
  };
}

function parseLatestRun(value: unknown): NonNullable<AIEvalCoverageEvidenceDTO['latestRun']> | null {
  if (value === null) return null;
  const row = record(value, 'latest eval run');
  if (!EVAL_RUN_STATUSES.has(row.status as AIEvalRunStatus)) throw new Error('Invalid AI governance response: latest eval run status.');
  const totalResultCount = nonNegativeIntegerOrNull(row.totalResultCount, 'eval totalResultCount');
  const terminalResultCount = nonNegativeIntegerOrNull(row.terminalResultCount, 'eval terminalResultCount');
  const detailResultCount = nonNegativeIntegerOrNull(row.detailResultCount, 'eval detailResultCount');
  const scoredResultCount = nonNegativeIntegerOrNull(row.scoredResultCount, 'eval scoredResultCount');
  const errorResultCount = nonNegativeIntegerOrNull(row.errorResultCount, 'eval errorResultCount');
  const averageScore = numberOrNull(row.averageScore, 'eval averageScore');
  if (detailResultCount === null || scoredResultCount === null || errorResultCount === null
    || scoredResultCount > detailResultCount || errorResultCount > detailResultCount
    || (totalResultCount !== null && detailResultCount !== totalResultCount)
    || (terminalResultCount !== null && terminalResultCount > detailResultCount)
    || (averageScore === null) !== (scoredResultCount === 0)) {
    throw new Error('Invalid AI governance response: latest eval run counts.');
  }
  return {
    status: row.status as AIEvalRunStatus,
    createdAt: timestampOrNull(row.createdAt, 'eval createdAt'),
    completedAt: timestampOrNull(row.completedAt, 'eval completedAt'),
    totalResultCount,
    terminalResultCount,
    detailResultCount,
    scoredResultCount,
    averageScore,
    errorResultCount,
  };
}

function parseEvals(value: unknown): AIEvalCoverageEvidenceDTO {
  const row = record(value, 'eval coverage');
  const state = evidenceState(row.state, 'eval state');
  const promptSetCount = nonNegativeIntegerOrNull(row.promptSetCount, 'eval promptSetCount');
  const configuredPromptCount = nonNegativeIntegerOrNull(row.configuredPromptCount, 'eval configuredPromptCount');
  const runCollectionState = evalReadState(row.runCollectionState, 'eval runCollectionState');
  const latestRunDetailState = evalReadState(row.latestRunDetailState, 'eval latestRunDetailState');
  const latestRun = parseLatestRun(row.latestRun);
  const contractState = row.contractState;
  if (contractState !== 'contract_observed' && contractState !== 'unverified') {
    throw new Error('Invalid AI governance response: eval contract state.');
  }
  const discoveredReadOperations = nonNegativeIntegerOrNull(row.discoveredReadOperations, 'eval reads');
  const discoveredWriteOperations = nonNegativeIntegerOrNull(row.discoveredWriteOperations, 'eval writes');
  if (discoveredReadOperations === null || discoveredWriteOperations === null || typeof row.resultEvidenceAvailable !== 'boolean') {
    throw new Error('Invalid AI governance response: eval coverage values.');
  }
  if ((row.resultEvidenceAvailable !== true) !== (latestRun === null)
    || (latestRun !== null && latestRunDetailState !== 'available')
    || (latestRun === null && latestRunDetailState === 'available')
    || (promptSetCount === null && (state === 'available' || state === 'partial'))
    || (promptSetCount === null && (configuredPromptCount !== null || runCollectionState !== 'not_checked' || latestRunDetailState !== 'not_checked'))
    || (promptSetCount === 0 && (runCollectionState !== 'not_applicable' || latestRunDetailState !== 'not_applicable'))
    || (promptSetCount === 0 && configuredPromptCount !== 0)
    || (promptSetCount !== null && promptSetCount > 0 && runCollectionState === 'not_applicable')
    || (state === 'available' && !['available', 'not_applicable'].includes(runCollectionState))
    || (state === 'available' && !['available', 'not_applicable'].includes(latestRunDetailState))
    || (state === 'partial' && ['available', 'not_applicable'].includes(runCollectionState) && ['available', 'not_applicable'].includes(latestRunDetailState))) {
    throw new Error('Invalid AI governance response: eval evidence consistency.');
  }
  return {
    state,
    promptSetCount,
    configuredPromptCount,
    runCollectionState,
    latestRunDetailState,
    latestRun,
    contractState,
    discoveredReadOperations,
    discoveredWriteOperations,
    resultEvidenceAvailable: row.resultEvidenceAvailable,
    reasonCode: stringValue(row.reasonCode, 'eval reasonCode', 200),
    detail: stringValue(row.detail, 'eval detail', 1_000),
  };
}

function parseBundle(value: unknown): EvidenceBundle<AIGovernanceInstanceEvidenceDTO> {
  const bundle = record(value, 'bundle');
  if (bundle.schemaVersion !== 1) throw new Error('Invalid AI governance response: bundle schemaVersion.');
  const selectedInstance = record(bundle.selectedInstance, 'selectedInstance');
  const selectedOrigin = stringValue(selectedInstance.origin, 'selectedInstance origin', 1_000);
  let parsedOrigin: URL;
  try {
    parsedOrigin = new URL(selectedOrigin);
  } catch {
    throw new Error('Invalid AI governance response: selectedInstance origin.');
  }
  if (parsedOrigin.protocol !== 'https:' || parsedOrigin.origin !== selectedOrigin) {
    throw new Error('Invalid AI governance response: selectedInstance origin.');
  }
  const scope = record(bundle.scope, 'scope');
  if (scope.capability !== 'ai_governance') throw new Error('Invalid AI governance response: scope.');
  if (!Array.isArray(bundle.sources) || bundle.sources.length > 20) throw new Error('Invalid AI governance response: sources.');
  const sources = bundle.sources.map((value, index) => {
    const source = record(value, `source ${index}`);
    const methods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
    const assertions = new Set(['observed', 'inferred', 'operator_confirmed', 'unverified']);
    if (source.method !== undefined && !methods.has(String(source.method))) throw new Error(`Invalid AI governance response: source method ${index}.`);
    if (!assertions.has(String(source.assertion))) throw new Error(`Invalid AI governance response: source assertion ${index}.`);
    const path = source.path === undefined ? undefined : stringValue(source.path, `source path ${index}`, 1_000);
    const allowedPaths = new Set([
      '/api/v1/ai/credit-controls',
      '/api/v1/ai/eval/prompt-sets',
      '/api/v1/ai/eval/runs?prompt_set_id={selected}',
      '/api/v1/ai/eval/runs/{runId}',
      '/openapi.json',
    ]);
    if (path !== undefined && !allowedPaths.has(path)) throw new Error(`Invalid AI governance response: source path ${index}.`);
    const label = stringValue(source.label, `source label ${index}`, 500);
    const allowedLabels = new Set([
      'AI credit controls',
      'AI eval prompt sets',
      'AI eval runs for bounded prompt-set selection',
      'Latest AI eval run detail',
      'Tenant AI eval contract',
    ]);
    if (!allowedLabels.has(label)) throw new Error(`Invalid AI governance response: source label ${index}.`);
    return {
      label,
      ...(source.method !== undefined ? { method: source.method as 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' } : {}),
      ...(path !== undefined ? { path } : {}),
      assertion: source.assertion as 'observed' | 'inferred' | 'operator_confirmed' | 'unverified',
    };
  });
  const coverage = record(bundle.coverage, 'bundle coverage');
  const coverageIncluded = nonNegativeIntegerOrNull(coverage.included, 'bundle coverage included');
  const coverageTotal = nonNegativeIntegerOrNull(coverage.total, 'bundle coverage total');
  if (coverageIncluded === null
    || (coverageTotal !== null && coverageIncluded > coverageTotal)
    || typeof coverage.complete !== 'boolean'
    || coverage.complete !== (coverageTotal !== null && coverageIncluded === coverageTotal)) {
    throw new Error('Invalid AI governance response: bundle coverage values.');
  }
  const freshness = record(bundle.freshness, 'freshness');
  if (freshness.state !== 'current' && freshness.state !== 'stale' && freshness.state !== 'unknown') {
    throw new Error('Invalid AI governance response: freshness state.');
  }
  const sanitization = record(bundle.sanitization, 'sanitization');
  if (sanitization.secretsExcluded !== true || sanitization.rawHeadersExcluded !== true || sanitization.rawUpstreamResponsesExcluded !== true) {
    throw new Error('Invalid AI governance response: sanitization guarantees.');
  }
  const evidence = record(bundle.evidence, 'bundle evidence');
  return {
    schemaVersion: 1,
    evidenceId: stringValue(bundle.evidenceId, 'evidenceId', 500),
    generatedAt: timestampOrNull(bundle.generatedAt, 'bundle generatedAt') ?? (() => { throw new Error('Invalid AI governance response: bundle generatedAt.'); })(),
    selectedInstance: {
      id: stringValue(selectedInstance.id, 'selectedInstance id', 500),
      label: stringValue(selectedInstance.label, 'selectedInstance label', 500),
      origin: selectedOrigin,
    },
    scope: { capability: 'ai_governance' },
    sources,
    coverage: {
      included: coverageIncluded,
      total: coverageTotal,
      complete: coverage.complete,
      unit: stringValue(coverage.unit, 'bundle coverage unit', 100),
    },
    exclusions: stringArray(bundle.exclusions, 'bundle exclusion'),
    freshness: {
      checkedAt: timestampOrNull(freshness.checkedAt, 'freshness checkedAt') ?? (() => { throw new Error('Invalid AI governance response: freshness checkedAt.'); })(),
      state: freshness.state,
    },
    sanitization: {
      secretsExcluded: true,
      rawHeadersExcluded: true,
      rawUpstreamResponsesExcluded: true,
      redactedFields: stringArray(sanitization.redactedFields, 'redacted field'),
    },
    evidence: {
      credits: parseCredits(evidence.credits),
      evals: parseEvals(evidence.evals),
    },
  };
}

function combinedState(
  credits: AIGovernanceEvidenceState,
  evals: AIGovernanceEvidenceState,
): AIGovernanceEvidenceState {
  if (credits === 'available' && evals === 'available') return 'available';
  if (credits === 'available' || evals === 'available' || credits === 'partial' || evals === 'partial') return 'partial';
  if (credits === evals) return credits;
  if (credits === 'permission_denied' || evals === 'permission_denied') return 'permission_denied';
  if (credits === 'rate_limited' || evals === 'rate_limited') return 'rate_limited';
  if (credits === 'unavailable' || evals === 'unavailable') return 'unavailable';
  if (credits === 'invalid_response' || evals === 'invalid_response') return 'invalid_response';
  return 'unsupported';
}

function parseInstance(value: unknown): AIGovernanceInstanceReportDTO {
  const row = record(value, 'instance');
  const instanceId = stringValue(row.instanceId, 'instanceId', 500);
  const instanceLabel = stringValue(row.instanceLabel, 'instanceLabel', 500);
  const state = evidenceState(row.state, 'instance state');
  const parsedBundle = parseBundle(row.bundle);
  if (parsedBundle.selectedInstance.id !== instanceId
    || parsedBundle.selectedInstance.label !== instanceLabel
    || combinedState(parsedBundle.evidence.credits.state, parsedBundle.evidence.evals.state) !== state) {
    throw new Error('Invalid AI governance response: instance evidence binding.');
  }
  return {
    instanceId,
    instanceLabel,
    state,
    bundle: parsedBundle,
  };
}

export function parseAIGovernanceFleet(value: unknown): AIGovernanceFleetReportDTO {
  const root = record(value, 'root');
  if (root.schemaVersion !== 1 || !Array.isArray(root.instances) || root.instances.length > 500) {
    throw new Error('Invalid AI governance response: envelope.');
  }
  const coverage = record(root.coverage, 'coverage');
  const included = nonNegativeIntegerOrNull(coverage.included, 'coverage included');
  const total = nonNegativeIntegerOrNull(coverage.total, 'coverage total');
  if (included === null || total === null || included < 0 || total < included || typeof coverage.complete !== 'boolean') {
    throw new Error('Invalid AI governance response: coverage values.');
  }
  const instances = root.instances.map(parseInstance);
  if (coverage.complete !== (included === total) || included !== instances.filter(({ state }) => state === 'available').length) {
    throw new Error('Invalid AI governance response: coverage consistency.');
  }
  return {
    schemaVersion: 1,
    generatedAt: timestampOrNull(root.generatedAt, 'generatedAt') ?? (() => { throw new Error('Invalid AI governance response: generatedAt.'); })(),
    coverage: { included, total, complete: coverage.complete },
    instances,
    exclusions: stringArray(root.exclusions, 'exclusion'),
    guardrails: stringArray(root.guardrails, 'guardrail'),
  };
}

export async function fetchAIGovernanceFleet(options: {
  instanceId?: string;
  signal?: AbortSignal;
} = {}): Promise<AIGovernanceFleetReportDTO> {
  const params = new URLSearchParams();
  if (options.instanceId?.trim()) params.set('instanceId', options.instanceId.trim());
  const response = await fetch(`/api/ai-governance${params.size > 0 ? `?${params.toString()}` : ''}`, {
    method: 'GET',
    headers: { Accept: 'application/json' },
    signal: options.signal,
  });
  if (!response.ok) {
    const message = response.status === 423
      ? 'Unlock the local vault before reading AI governance evidence.'
      : response.status === 404
        ? 'The selected Omni instance is no longer saved.'
        : `AI governance evidence could not be read (HTTP ${response.status}).`;
    if (response.status === 423) emitVaultLocked(message);
    throw new ApiError(response.status, message);
  }
  return parseAIGovernanceFleet(await response.json());
}
