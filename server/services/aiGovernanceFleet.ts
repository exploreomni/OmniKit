import {
  createEvidenceBundle,
  type EvidenceBundle,
} from '../../src/services/evidenceBundle';
import {
  OmniClient,
  OmniClientError,
  OmniPaginationError,
  OmniRequestDeadlineError,
  OmniResponseLimitError,
  OmniResponseReadDeadlineError,
} from './omniClient';
import { getInstance, listInstances, type SavedInstance } from './nativeVault';

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

export type AIEvalRunStatus =
  | 'pending'
  | 'running'
  | 'complete'
  | 'failed'
  | 'cancelled'
  | 'unknown';

export interface AICreditControlsEvidence {
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

export interface AIEvalCoverageEvidence {
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

export interface AIGovernanceInstanceEvidence {
  credits: AICreditControlsEvidence;
  evals: AIEvalCoverageEvidence;
}

export interface AIGovernanceInstanceReport {
  instanceId: string;
  instanceLabel: string;
  state: AIGovernanceEvidenceState;
  bundle: EvidenceBundle<AIGovernanceInstanceEvidence>;
}

export interface AIGovernanceFleetReport {
  schemaVersion: 1;
  generatedAt: string;
  coverage: {
    included: number;
    total: number;
    complete: boolean;
  };
  instances: AIGovernanceInstanceReport[];
  exclusions: string[];
  guardrails: string[];
}

export interface AITenantContractOperation {
  method: string;
  path: string;
}

export type AITenantContractDiscovery = (
  instance: SavedInstance,
  signal?: AbortSignal,
) => Promise<AITenantContractOperation[]>;

export interface AIGovernanceOmniReader {
  getAiCreditControls(signal?: AbortSignal): Promise<unknown>;
  listAiEvalPromptSets(signal?: AbortSignal): Promise<unknown>;
  listAiEvalRuns(promptSetId: string, signal?: AbortSignal): Promise<unknown>;
  getAiEvalRun(runId: string, signal?: AbortSignal): Promise<unknown>;
}

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as UnknownRecord : null;
}

function finiteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function optionalTimestamp(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  return Number.isFinite(Date.parse(value)) ? value : null;
}

function controlsRecord(value: unknown): UnknownRecord | null {
  const root = asRecord(value);
  if (!root) return null;
  return asRecord(root.creditControls)
    ?? asRecord(root.credit_controls)
    ?? asRecord(root.data)
    ?? root;
}

export function parseAICreditControls(value: unknown): AICreditControlsEvidence {
  const row = controlsRecord(value);
  if (!row) {
    return unavailableCredits('invalid_response', 'invalid_response', 'Omni returned an invalid AI credit-control response.');
  }

  const accountCreditLimit = finiteNumber(row.accountCreditLimit ?? row.account_credit_limit);
  const creditsUsed = finiteNumber(row.creditsUsed ?? row.credits_used);
  const downgradeCredits = finiteNumber(row.downgradeCredits ?? row.downgrade_credits);
  const shutoffCredits = finiteNumber(row.shutoffCredits ?? row.shutoff_credits);
  const userDefaultCredits = finiteNumber(row.userDefaultCredits ?? row.user_default_credits);
  const entityGroupDefaultCredits = finiteNumber(row.entityGroupDefaultCredits ?? row.entity_group_default_credits);
  const periodStart = optionalTimestamp(row.periodStart ?? row.period_start);
  const periodEnd = optionalTimestamp(row.periodEnd ?? row.period_end);

  if (accountCreditLimit === null && creditsUsed === null) {
    return unavailableCredits('invalid_response', 'invalid_response', 'Omni did not return an account limit or used-credit value.');
  }

  const remainingCredits = accountCreditLimit === null || creditsUsed === null
    ? null
    : Math.max(0, accountCreditLimit - creditsUsed);
  const utilizationPercent = accountCreditLimit === null || creditsUsed === null || accountCreditLimit <= 0
    ? null
    : Math.max(0, (creditsUsed / accountCreditLimit) * 100);

  return {
    state: 'available',
    accountCreditLimit,
    creditsUsed,
    remainingCredits,
    utilizationPercent,
    downgradeCredits,
    shutoffCredits,
    userDefaultCredits,
    entityGroupDefaultCredits,
    periodStart,
    periodEnd,
    reasonCode: 'ok',
    detail: 'Account-level AI credit controls were returned by Omni.',
  };
}

function unavailableCredits(
  state: Exclude<AIGovernanceEvidenceState, 'available'>,
  reasonCode: string,
  detail: string,
): AICreditControlsEvidence {
  return {
    state,
    accountCreditLimit: null,
    creditsUsed: null,
    remainingCredits: null,
    utilizationPercent: null,
    downgradeCredits: null,
    shutoffCredits: null,
    userDefaultCredits: null,
    entityGroupDefaultCredits: null,
    periodStart: null,
    periodEnd: null,
    reasonCode,
    detail,
  };
}

function classifyCreditFailure(error: unknown): AICreditControlsEvidence {
  if (error instanceof OmniClientError) {
    if (error.status === 401 || error.status === 403) {
      return unavailableCredits('permission_denied', 'permission_denied', 'The current caller cannot read AI credit controls on this instance.');
    }
    if (error.status === 404 || error.status === 405 || error.status === 410) {
      return unavailableCredits('unsupported', 'endpoint_unavailable', 'This tenant did not expose the documented AI credit-control read.');
    }
    if (error.status === 429) {
      return unavailableCredits('rate_limited', 'rate_limited', 'Omni rate-limited the AI credit-control read.');
    }
  }
  if (error instanceof OmniRequestDeadlineError) {
    return unavailableCredits('unavailable', 'request_timeout', 'The AI credit-control read exceeded its bounded deadline.');
  }
  return unavailableCredits('unavailable', 'upstream_unavailable', 'AI credit-control evidence could not be read from this instance.');
}

function normalizedEvalOperations(operations: AITenantContractOperation[]): AITenantContractOperation[] {
  return operations.filter((operation) => {
    const path = operation.path.toLowerCase();
    return path.includes('/ai/') && (path.includes('eval') || path.includes('prompt-set'));
  });
}

interface EvalContractCoverage {
  contractState: 'contract_observed' | 'unverified';
  discoveredReadOperations: number;
  discoveredWriteOperations: number;
}

interface EvalPromptSetSummary {
  id: string;
  promptCount: number | null;
  latestRunAtMs: number | null;
  sourceOrder: number;
}

interface EvalRunCollectionSummary {
  runCount: number;
  latestRun: {
    id: string;
    status: AIEvalRunStatus;
    createdAt: string | null;
    completedAt: string | null;
    totalResultCount: number | null;
    terminalResultCount: number | null;
  } | null;
}

interface EvalReadFailure {
  state: Exclude<AIGovernanceEvidenceState, 'available' | 'partial'>;
  reasonCode: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function validUuid(value: unknown): string | null {
  return typeof value === 'string' && UUID_PATTERN.test(value.trim()) ? value.trim() : null;
}

function nonNegativeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function safeOptionalTimestamp(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return optionalTimestamp(value);
}

function normalizeEvalRunStatus(value: unknown): AIEvalRunStatus {
  if (typeof value !== 'string') return 'unknown';
  switch (value.trim().toUpperCase()) {
    case 'QUEUED':
    case 'PENDING':
    case 'CREATED':
      return 'pending';
    case 'RUNNING':
    case 'IN_PROGRESS':
      return 'running';
    case 'COMPLETE':
    case 'COMPLETED':
    case 'SUCCESS':
    case 'SUCCEEDED':
      return 'complete';
    case 'FAILED':
    case 'ERROR':
      return 'failed';
    case 'CANCELLED':
    case 'CANCELED':
      return 'cancelled';
    default:
      return 'unknown';
  }
}

function parseEvalPromptSets(value: unknown): EvalPromptSetSummary[] | null {
  const root = asRecord(value);
  if (!root || !Array.isArray(root.prompt_sets)) return null;
  const parsed: EvalPromptSetSummary[] = [];
  for (const [sourceOrder, value] of root.prompt_sets.entries()) {
    const row = asRecord(value);
    const id = validUuid(row?.id);
    if (!row || !id) return null;
    const promptCount = row.prompt_count === null || row.prompt_count === undefined
      ? null
      : nonNegativeInteger(row.prompt_count);
    if (row.prompt_count !== null && row.prompt_count !== undefined && (promptCount === null || promptCount > 25)) return null;
    const latestRunAt = safeOptionalTimestamp(row.latest_run_at);
    if (row.latest_run_at !== null && row.latest_run_at !== undefined && latestRunAt === null) return null;
    parsed.push({
      id,
      promptCount,
      latestRunAtMs: latestRunAt ? Date.parse(latestRunAt) : null,
      sourceOrder,
    });
  }
  return parsed;
}

function selectedEvalPromptSet(promptSets: EvalPromptSetSummary[]): EvalPromptSetSummary | null {
  if (promptSets.length === 0) return null;
  return [...promptSets].sort((left, right) => {
    const leftRunAt = left.latestRunAtMs ?? Number.NEGATIVE_INFINITY;
    const rightRunAt = right.latestRunAtMs ?? Number.NEGATIVE_INFINITY;
    return rightRunAt - leftRunAt || left.sourceOrder - right.sourceOrder;
  })[0] ?? null;
}

function parseEvalRunCollection(value: unknown, promptSetId: string): EvalRunCollectionSummary | null {
  const root = asRecord(value);
  if (!root || !Array.isArray(root.runs)) return null;
  if (root.runs.length === 0) return { runCount: 0, latestRun: null };
  const row = asRecord(root.runs[0]);
  const id = validUuid(row?.id);
  const returnedPromptSetId = validUuid(row?.prompt_set_id);
  if (!row || !id || returnedPromptSetId !== promptSetId) return null;
  const stats = row.stats === null || row.stats === undefined ? null : asRecord(row.stats);
  if (row.stats !== null && row.stats !== undefined && !stats) return null;
  const totalResultCount = stats?.total === null || stats?.total === undefined
    ? null
    : nonNegativeInteger(stats.total);
  const terminalResultCount = stats?.terminal === null || stats?.terminal === undefined
    ? null
    : nonNegativeInteger(stats.terminal);
  if ((stats?.total !== null && stats?.total !== undefined && totalResultCount === null)
    || (stats?.terminal !== null && stats?.terminal !== undefined && terminalResultCount === null)
    || (totalResultCount !== null && terminalResultCount !== null && terminalResultCount > totalResultCount)) {
    return null;
  }
  return {
    runCount: root.runs.length,
    latestRun: {
      id,
      status: normalizeEvalRunStatus(row.status),
      createdAt: safeOptionalTimestamp(row.created_at),
      completedAt: safeOptionalTimestamp(row.completed_at),
      totalResultCount,
      terminalResultCount,
    },
  };
}

function parseEvalRunDetail(
  value: unknown,
  expected: { runId: string; promptSetId: string; collection: NonNullable<EvalRunCollectionSummary['latestRun']> },
): NonNullable<AIEvalCoverageEvidence['latestRun']> | null {
  const root = asRecord(value);
  const run = asRecord(root?.run);
  if (!run
    || validUuid(run.id) !== expected.runId
    || validUuid(run.prompt_set_id) !== expected.promptSetId
    || !Array.isArray(run.results)
    || run.results.length > 25
    || (expected.collection.totalResultCount !== null && run.results.length !== expected.collection.totalResultCount)
    || (expected.collection.terminalResultCount !== null && expected.collection.terminalResultCount > run.results.length)) {
    return null;
  }
  const scores: number[] = [];
  let errorResultCount = 0;
  let derivedTerminalCount = 0;
  for (const value of run.results) {
    const result = asRecord(value);
    if (!result) return null;
    if (typeof result.score === 'number' && Number.isFinite(result.score)) scores.push(result.score);
    const jobState = normalizeEvalRunStatus(asRecord(result.agentic_job)?.state);
    if (jobState === 'complete' || jobState === 'failed' || jobState === 'cancelled') derivedTerminalCount += 1;
    if ((typeof result.error_reason === 'string' && Boolean(result.error_reason.trim())) || jobState === 'failed') {
      errorResultCount += 1;
    }
  }
  const averageScore = scores.length > 0
    ? Math.round((scores.reduce((sum, score) => sum + score, 0) / scores.length) * 10_000) / 10_000
    : null;
  return {
    status: normalizeEvalRunStatus(run.status ?? expected.collection.status),
    createdAt: safeOptionalTimestamp(run.created_at) ?? expected.collection.createdAt,
    completedAt: safeOptionalTimestamp(run.completed_at) ?? expected.collection.completedAt,
    totalResultCount: expected.collection.totalResultCount ?? run.results.length,
    terminalResultCount: expected.collection.terminalResultCount ?? derivedTerminalCount,
    detailResultCount: run.results.length,
    scoredResultCount: scores.length,
    averageScore,
    errorResultCount,
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error ? signal.reason : new DOMException('The operation was aborted.', 'AbortError');
}

function classifyEvalFailure(error: unknown): EvalReadFailure {
  if (error instanceof OmniClientError) {
    if (error.status === 401 || error.status === 403) return { state: 'permission_denied', reasonCode: 'permission_denied' };
    if (error.status === 404 || error.status === 405 || error.status === 410) return { state: 'unsupported', reasonCode: 'endpoint_unavailable' };
    if (error.status === 429) return { state: 'rate_limited', reasonCode: 'rate_limited' };
    if (error.status === 400 || error.status === 422) return { state: 'invalid_response', reasonCode: 'request_contract_mismatch' };
  }
  if (error instanceof OmniPaginationError) return { state: 'invalid_response', reasonCode: 'invalid_response' };
  if (error instanceof OmniResponseLimitError) return { state: 'unavailable', reasonCode: 'response_limit' };
  if (error instanceof OmniRequestDeadlineError || error instanceof OmniResponseReadDeadlineError) {
    return { state: 'unavailable', reasonCode: 'request_timeout' };
  }
  return { state: 'unavailable', reasonCode: 'upstream_unavailable' };
}

async function loadEvalContractCoverage(
  instance: SavedInstance,
  discovery: AITenantContractDiscovery | undefined,
  signal?: AbortSignal,
): Promise<EvalContractCoverage> {
  if (!discovery) {
    return {
      contractState: 'unverified',
      discoveredReadOperations: 0,
      discoveredWriteOperations: 0,
    };
  }
  try {
    const operations = normalizedEvalOperations(await discovery(instance, signal));
    const readOperations = operations.filter(({ method }) => ['GET', 'HEAD'].includes(method.toUpperCase()));
    const writeOperations = operations.filter(({ method }) => !['GET', 'HEAD'].includes(method.toUpperCase()));
    return {
      contractState: 'contract_observed',
      discoveredReadOperations: readOperations.length,
      discoveredWriteOperations: writeOperations.length,
    };
  } catch {
    throwIfAborted(signal);
    return {
      contractState: 'unverified',
      discoveredReadOperations: 0,
      discoveredWriteOperations: 0,
    };
  }
}

function unavailableEvalEvidence(failure: EvalReadFailure): AIEvalCoverageEvidence {
  const detailByState: Record<EvalReadFailure['state'], string> = {
    permission_denied: 'The current caller cannot read AI eval prompt-set evidence on this instance.',
    unsupported: 'This tenant did not expose the documented AI eval prompt-set read.',
    rate_limited: 'Omni rate-limited the AI eval prompt-set read.',
    unavailable: 'AI eval prompt-set evidence could not be read within the bounded request policy.',
    invalid_response: 'Omni returned an invalid AI eval prompt-set response.',
  };
  return {
    state: failure.state,
    promptSetCount: null,
    configuredPromptCount: null,
    runCollectionState: 'not_checked',
    latestRunDetailState: 'not_checked',
    latestRun: null,
    contractState: 'unverified',
    discoveredReadOperations: 0,
    discoveredWriteOperations: 0,
    resultEvidenceAvailable: false,
    reasonCode: failure.reasonCode,
    detail: detailByState[failure.state],
  };
}

export async function loadAIEvalEvidence(
  reader: Pick<AIGovernanceOmniReader, 'listAiEvalPromptSets' | 'listAiEvalRuns' | 'getAiEvalRun'>,
  instance: SavedInstance,
  discovery?: AITenantContractDiscovery,
  signal?: AbortSignal,
): Promise<AIEvalCoverageEvidence> {
  const contractPromise = loadEvalContractCoverage(instance, discovery, signal);
  let promptSets: EvalPromptSetSummary[];
  try {
    const parsed = parseEvalPromptSets(await reader.listAiEvalPromptSets(signal));
    if (!parsed) return { ...unavailableEvalEvidence({ state: 'invalid_response', reasonCode: 'invalid_response' }), ...await contractPromise };
    promptSets = parsed;
  } catch (error) {
    throwIfAborted(signal);
    return { ...unavailableEvalEvidence(classifyEvalFailure(error)), ...await contractPromise };
  }

  const contract = await contractPromise;
  const configuredPromptCountCandidate = promptSets.every(({ promptCount }) => promptCount !== null)
    ? promptSets.reduce((total, { promptCount }) => total + (promptCount ?? 0), 0)
    : null;
  const configuredPromptCount = configuredPromptCountCandidate !== null
    && Number.isSafeInteger(configuredPromptCountCandidate)
    ? configuredPromptCountCandidate
    : null;
  const selectedPromptSet = selectedEvalPromptSet(promptSets);
  if (!selectedPromptSet) {
    return {
      state: 'available',
      promptSetCount: 0,
      configuredPromptCount: 0,
      runCollectionState: 'not_applicable',
      latestRunDetailState: 'not_applicable',
      latestRun: null,
      ...contract,
      resultEvidenceAvailable: false,
      reasonCode: 'no_prompt_sets',
      detail: 'No active AI eval prompt sets were visible to the current caller.',
    };
  }

  let runCollection: EvalRunCollectionSummary;
  try {
    const parsed = parseEvalRunCollection(
      await reader.listAiEvalRuns(selectedPromptSet.id, signal),
      selectedPromptSet.id,
    );
    if (!parsed) {
      return {
        state: 'partial',
        promptSetCount: promptSets.length,
        configuredPromptCount,
        runCollectionState: 'invalid_response',
        latestRunDetailState: 'not_checked',
        latestRun: null,
        ...contract,
        resultEvidenceAvailable: false,
        reasonCode: 'invalid_run_collection',
        detail: 'Prompt-set coverage was read, but Omni returned an invalid run collection for the bounded prompt-set selection.',
      };
    }
    runCollection = parsed;
  } catch (error) {
    throwIfAborted(signal);
    const failure = classifyEvalFailure(error);
    return {
      state: 'partial',
      promptSetCount: promptSets.length,
      configuredPromptCount,
      runCollectionState: failure.state,
      latestRunDetailState: 'not_checked',
      latestRun: null,
      ...contract,
      resultEvidenceAvailable: false,
      reasonCode: `run_collection_${failure.reasonCode}`,
      detail: 'Prompt-set coverage was read, but the latest-run collection could not be verified for the bounded prompt-set selection.',
    };
  }

  if (!runCollection.latestRun) {
    return {
      state: 'available',
      promptSetCount: promptSets.length,
      configuredPromptCount,
      runCollectionState: 'available',
      latestRunDetailState: 'not_applicable',
      latestRun: null,
      ...contract,
      resultEvidenceAvailable: false,
      reasonCode: 'no_runs',
      detail: 'Prompt-set coverage was read; the bounded prompt-set selection has no active eval runs.',
    };
  }

  try {
    const latestRun = parseEvalRunDetail(
      await reader.getAiEvalRun(runCollection.latestRun.id, signal),
      {
        runId: runCollection.latestRun.id,
        promptSetId: selectedPromptSet.id,
        collection: runCollection.latestRun,
      },
    );
    if (!latestRun) {
      return {
        state: 'partial',
        promptSetCount: promptSets.length,
        configuredPromptCount,
        runCollectionState: 'available',
        latestRunDetailState: 'invalid_response',
        latestRun: null,
        ...contract,
        resultEvidenceAvailable: false,
        reasonCode: 'invalid_run_detail',
        detail: 'Prompt-set and latest-run coverage were read, but Omni returned an invalid or mismatched run-detail response.',
      };
    }
    return {
      state: 'available',
      promptSetCount: promptSets.length,
      configuredPromptCount,
      runCollectionState: 'available',
      latestRunDetailState: 'available',
      latestRun,
      ...contract,
      resultEvidenceAvailable: true,
      reasonCode: 'ok',
      detail: 'Prompt-set coverage and one latest run detail were read once and reduced to aggregate result evidence.',
    };
  } catch (error) {
    throwIfAborted(signal);
    const failure = classifyEvalFailure(error);
    return {
      state: 'partial',
      promptSetCount: promptSets.length,
      configuredPromptCount,
      runCollectionState: 'available',
      latestRunDetailState: failure.state,
      latestRun: null,
      ...contract,
      resultEvidenceAvailable: false,
      reasonCode: `run_detail_${failure.reasonCode}`,
      detail: 'Prompt-set and latest-run coverage were read, but the single bounded run-detail read could not be verified.',
    };
  }
}

async function loadInstance(
  instance: SavedInstance,
  discovery: AITenantContractDiscovery | undefined,
  signal?: AbortSignal,
): Promise<AIGovernanceInstanceReport> {
  const generatedAt = new Date().toISOString();
  const client = new OmniClient(instance, { requestTimeoutMs: 15_000, maxReadRetries: 1 });
  const [credits, evals] = await Promise.all([
    client.getAiCreditControls(signal).then(parseAICreditControls).catch((error) => {
      throwIfAborted(signal);
      return classifyCreditFailure(error);
    }),
    loadAIEvalEvidence(client, instance, discovery, signal),
  ]);
  const included = Number(credits.state === 'available') + Number(evals.state === 'available');
  const exclusions = [
    'Per-query AI credit evidence is not exposed by the documented aggregate endpoints.',
    'No AI limit change, eval execution, cancellation, archive, restore, or other write was performed.',
    'Prompt text, expectations, prompt-set ids, run ids, model ids, and raw eval responses are excluded.',
    ...(evals.state !== 'available' ? ['AI eval read evidence was incomplete for this tenant.'] : []),
  ];
  const bundle = createEvidenceBundle({
    kind: 'ai-governance',
    generatedAt,
    selectedInstance: {
      id: instance.id,
      label: instance.label,
      origin: new URL(instance.baseUrl).origin,
    },
    scope: { capability: 'ai_governance' },
    sources: [
      {
        label: 'AI credit controls',
        method: 'GET',
        path: '/api/v1/ai/credit-controls',
        assertion: credits.state === 'available' ? 'observed' : 'unverified',
      },
      {
        label: 'AI eval prompt sets',
        method: 'GET',
        path: '/api/v1/ai/eval/prompt-sets',
        assertion: evals.promptSetCount !== null ? 'observed' : 'unverified',
      },
      {
        label: 'AI eval runs for bounded prompt-set selection',
        method: 'GET',
        path: '/api/v1/ai/eval/runs?prompt_set_id={selected}',
        assertion: evals.runCollectionState === 'available' || evals.runCollectionState === 'not_applicable'
          ? 'observed'
          : 'unverified',
      },
      {
        label: 'Latest AI eval run detail',
        method: 'GET',
        path: '/api/v1/ai/eval/runs/{runId}',
        assertion: evals.latestRunDetailState === 'available' || evals.latestRunDetailState === 'not_applicable'
          ? 'observed'
          : 'unverified',
      },
      {
        label: 'Tenant AI eval contract',
        method: 'GET',
        path: '/openapi.json',
        assertion: evals.contractState === 'contract_observed' ? 'observed' : 'unverified',
      },
    ],
    coverage: { included, total: 2, complete: included === 2, unit: 'evidence areas' },
    exclusions,
    evidence: { credits, evals },
  });
  return {
    instanceId: instance.id,
    instanceLabel: instance.label,
    state: combinedInstanceState(credits.state, evals.state),
    bundle,
  };
}

function combinedInstanceState(
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

async function mapLimit<T, R>(
  values: T[],
  limit: number,
  worker: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let nextIndex = 0;
  async function run(): Promise<void> {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(values[index]!);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, () => run()));
  return results;
}

export async function getAIGovernanceFleet(options: {
  instanceId?: string;
  signal?: AbortSignal;
  discoverTenantContract?: AITenantContractDiscovery;
} = {}): Promise<AIGovernanceFleetReport> {
  const publicInstances = listInstances();
  const selected = options.instanceId
    ? publicInstances.filter(({ id }) => id === options.instanceId)
    : publicInstances;
  if (options.instanceId && selected.length === 0) {
    throw Object.assign(new Error('Saved Omni instance not found.'), { statusCode: 404 });
  }
  const instances = selected
    .map(({ id }) => getInstance(id))
    .filter((instance): instance is SavedInstance => Boolean(instance));
  const reports = await mapLimit(instances, 2, (instance) => loadInstance(
    instance,
    options.discoverTenantContract,
    options.signal,
  ));
  const included = reports.filter(({ state }) => state === 'available').length;
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    coverage: {
      included,
      total: selected.length,
      complete: included === selected.length,
    },
    instances: reports,
    exclusions: [
      'Per-query AI credit consumption is outside the documented aggregate API contract.',
      'AI eval writes and result polling are not performed by this read-only fleet view.',
    ],
    guardrails: [
      'Read-only evidence collection only.',
      'Changes to limits, eval runs, or cancellations require a separate confirmed workflow.',
      'Omni AI Hub remains the system of record for AI governance actions.',
    ],
  };
}
