import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, test } from 'node:test';

import {
  loadAIEvalEvidence,
  parseAICreditControls,
  type AIGovernanceOmniReader,
} from '../server/services/aiGovernanceFleet';
import {
  OmniClient,
  OmniClientError,
  OmniResponseLimitError,
  resetOmniClientRateLimitStateForTests,
} from '../server/services/omniClient';
import type { SavedInstance } from '../server/services/nativeVault';
import { createEvidenceBundle } from '../src/services/evidenceBundle';
import { parseAIGovernanceFleet } from '../src/services/aiGovernanceFleet';

const pageSource = readFileSync(new URL('../src/pages/AIGovernancePage.tsx', import.meta.url), 'utf8');
const PROMPT_SET_OLDER = '550e8400-e29b-41d4-a716-446655440000';
const PROMPT_SET_LATEST = '550e8400-e29b-41d4-a716-446655440001';
const LATEST_RUN = '660e8400-e29b-41d4-a716-446655440001';

const instance = {
  id: 'instance-1',
  label: 'Fictional AI governance workspace',
  baseUrl: 'https://93.184.216.34',
  apiKey: 'fictional-ai-governance-key',
} as SavedInstance;

afterEach(() => {
  resetOmniClientRateLimitStateForTests();
});

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

test('AI credit controls normalize the documented aggregate fields without inventing per-query usage', () => {
  const result = parseAICreditControls({
    accountCreditLimit: 1_000,
    creditsUsed: 250,
    downgradeCredits: 800,
    shutoffCredits: 950,
    userDefaultCredits: 50,
    entityGroupDefaultCredits: 100,
    periodStart: '2026-08-01T00:00:00.000Z',
    periodEnd: '2026-09-01T00:00:00.000Z',
  });

  assert.equal(result.state, 'available');
  assert.equal(result.remainingCredits, 750);
  assert.equal(result.utilizationPercent, 25);
  assert.equal('perQueryCredits' in result, false);
});

test('AI credit controls fail closed when aggregate evidence is absent', () => {
  const result = parseAICreditControls({ periodStart: '2026-08-01T00:00:00.000Z' });
  assert.equal(result.state, 'invalid_response');
  assert.equal(result.creditsUsed, null);
  assert.equal(result.accountCreditLimit, null);
});

test('Omni eval reads use only the documented GET paths and required prompt_set_id query', async () => {
  const requests: Array<{ method: string; url: URL }> = [];
  const client = new OmniClient(instance, {
    maxReadRetries: 0,
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      requests.push({ method: String(init?.method || 'GET'), url });
      if (url.pathname === '/api/v1/ai/eval/prompt-sets') return jsonResponse({ prompt_sets: [] });
      if (url.pathname === '/api/v1/ai/eval/runs' && url.searchParams.has('prompt_set_id')) return jsonResponse({ runs: [] });
      if (url.pathname === `/api/v1/ai/eval/runs/${LATEST_RUN}`) return jsonResponse({ run: { id: LATEST_RUN } });
      return new Response('{}', { status: 404 });
    }) as typeof fetch,
  });

  await client.listAiEvalPromptSets();
  await client.listAiEvalRuns(PROMPT_SET_LATEST);
  await client.getAiEvalRun(LATEST_RUN);

  assert.deepEqual(requests.map(({ method, url }) => ({
    method,
    path: url.pathname,
    promptSetId: url.searchParams.get('prompt_set_id'),
  })), [
    { method: 'GET', path: '/api/v1/ai/eval/prompt-sets', promptSetId: null },
    { method: 'GET', path: '/api/v1/ai/eval/runs', promptSetId: PROMPT_SET_LATEST },
    { method: 'GET', path: `/api/v1/ai/eval/runs/${LATEST_RUN}`, promptSetId: null },
  ]);
});

test('Omni eval reads reject oversized response bodies before parsing', async () => {
  const body = JSON.stringify({ prompt_sets: [], padding: 'x'.repeat(2 * 1024 * 1024) });
  const client = new OmniClient(instance, {
    maxReadRetries: 0,
    fetchImpl: (async () => new Response(body, {
      status: 200,
      headers: { 'content-type': 'application/json', 'content-length': String(body.length) },
    })) as typeof fetch,
  });

  await assert.rejects(() => client.listAiEvalPromptSets(), OmniResponseLimitError);
});

test('bounded eval evidence selects one latest prompt set and emits aggregate result evidence only', async () => {
  const privateMarker = 'private-prompt-and-expectation-marker';
  const calls: string[] = [];
  const reader: AIGovernanceOmniReader = {
    async getAiCreditControls() { return {}; },
    async listAiEvalPromptSets() {
      calls.push('prompt-sets');
      return {
        prompt_sets: [
          {
            id: PROMPT_SET_OLDER,
            model_id: '880e8400-e29b-41d4-a716-446655440003',
            name: privateMarker,
            latest_run_at: '2026-08-25T10:00:00.000Z',
            prompt_count: 2,
          },
          {
            id: PROMPT_SET_LATEST,
            model_id: '880e8400-e29b-41d4-a716-446655440004',
            description: privateMarker,
            latest_run_at: '2026-08-26T10:00:00.000Z',
            prompt_count: 3,
          },
        ],
      };
    },
    async listAiEvalRuns(promptSetId) {
      calls.push(`runs:${promptSetId}`);
      assert.equal(promptSetId, PROMPT_SET_LATEST);
      return {
        runs: [{
          id: LATEST_RUN,
          prompt_set_id: PROMPT_SET_LATEST,
          model_id: '880e8400-e29b-41d4-a716-446655440004',
          status: 'RUNNING',
          created_at: '2026-08-26T10:05:00.000Z',
          completed_at: null,
          stats: { terminal: 2, total: 3 },
        }],
      };
    },
    async getAiEvalRun(runId) {
      calls.push(`detail:${runId}`);
      assert.equal(runId, LATEST_RUN);
      return {
        run: {
          id: LATEST_RUN,
          prompt_set_id: PROMPT_SET_LATEST,
          model_id: '880e8400-e29b-41d4-a716-446655440004',
          status: 'RUNNING',
          created_at: '2026-08-26T10:05:00.000Z',
          results: [
            { prompt: privateMarker, expectation: privateMarker, score: 0.8, error_reason: null, agentic_job: { id: privateMarker, state: 'COMPLETE' } },
            { prompt: privateMarker, expectation: privateMarker, score: 0.6, error_reason: privateMarker, agentic_job: { state: 'FAILED' } },
            { prompt: privateMarker, expectation: privateMarker, score: null, error_reason: null, agentic_job: { state: 'RUNNING' } },
          ],
        },
      };
    },
  };

  const result = await loadAIEvalEvidence(reader, instance);

  assert.deepEqual(calls, [
    'prompt-sets',
    `runs:${PROMPT_SET_LATEST}`,
    `detail:${LATEST_RUN}`,
  ]);
  assert.equal(result.state, 'available');
  assert.equal(result.promptSetCount, 2);
  assert.equal(result.configuredPromptCount, 5);
  assert.equal(result.latestRun?.status, 'running');
  assert.equal(result.latestRun?.detailResultCount, 3);
  assert.equal(result.latestRun?.scoredResultCount, 2);
  assert.equal(result.latestRun?.averageScore, 0.7);
  assert.equal(result.latestRun?.errorResultCount, 1);
  const serialized = JSON.stringify(result);
  assert.doesNotMatch(serialized, new RegExp(privateMarker));
  assert.doesNotMatch(serialized, /550e8400|660e8400|880e8400/);
  assert.doesNotMatch(serialized, /prompt_set_id|model_id|expectation|raw/i);
});

test('eval evidence stops after prompt-set coverage and reports a fixed partial state when run reads are forbidden', async () => {
  const privateMarker = 'private-upstream-forbidden-marker';
  let detailCalls = 0;
  const reader: AIGovernanceOmniReader = {
    async getAiCreditControls() { return {}; },
    async listAiEvalPromptSets() {
      return { prompt_sets: [{ id: PROMPT_SET_LATEST, prompt_count: 1, latest_run_at: '2026-08-26T10:00:00.000Z' }] };
    },
    async listAiEvalRuns() {
      throw new OmniClientError(403, 'https://fictional.omniapp.co/api/v1/ai/eval/runs', privateMarker);
    },
    async getAiEvalRun() {
      detailCalls += 1;
      return {};
    },
  };

  const result = await loadAIEvalEvidence(reader, instance);

  assert.equal(result.state, 'partial');
  assert.equal(result.promptSetCount, 1);
  assert.equal(result.runCollectionState, 'permission_denied');
  assert.equal(result.latestRunDetailState, 'not_checked');
  assert.equal(detailCalls, 0);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(privateMarker));
});

test('eval evidence rejects run detail outside the selected prompt-set scope', async () => {
  const reader: AIGovernanceOmniReader = {
    async getAiCreditControls() { return {}; },
    async listAiEvalPromptSets() {
      return { prompt_sets: [{ id: PROMPT_SET_LATEST, prompt_count: 1, latest_run_at: '2026-08-26T10:00:00.000Z' }] };
    },
    async listAiEvalRuns() {
      return {
        runs: [{
          id: LATEST_RUN,
          prompt_set_id: PROMPT_SET_LATEST,
          status: 'COMPLETE',
          stats: { terminal: 1, total: 1 },
        }],
      };
    },
    async getAiEvalRun() {
      return {
        run: {
          id: LATEST_RUN,
          prompt_set_id: PROMPT_SET_OLDER,
          status: 'COMPLETE',
          results: [{ score: 1, error_reason: null, agentic_job: { state: 'COMPLETE' } }],
        },
      };
    },
  };

  const result = await loadAIEvalEvidence(reader, instance);

  assert.equal(result.state, 'partial');
  assert.equal(result.reasonCode, 'invalid_run_detail');
  assert.equal(result.latestRun, null);
  assert.equal(result.latestRunDetailState, 'invalid_response');
});

test('eval evidence with no visible prompt sets performs no run reads', async () => {
  let runCalls = 0;
  const reader: AIGovernanceOmniReader = {
    async getAiCreditControls() { return {}; },
    async listAiEvalPromptSets() { return { prompt_sets: [] }; },
    async listAiEvalRuns() { runCalls += 1; return { runs: [] }; },
    async getAiEvalRun() { runCalls += 1; return {}; },
  };

  const result = await loadAIEvalEvidence(reader, instance);

  assert.equal(result.state, 'available');
  assert.equal(result.reasonCode, 'no_prompt_sets');
  assert.equal(result.runCollectionState, 'not_applicable');
  assert.equal(runCalls, 0);
});

test('AI governance frontend contract binds instance evidence and exclusions', () => {
  const generatedAt = '2026-08-26T12:00:00.000Z';
  const bundle = createEvidenceBundle({
    kind: 'ai-governance',
    generatedAt,
    selectedInstance: { id: 'instance-1', label: 'Example organization', origin: 'https://example.omniapp.co' },
    scope: { capability: 'ai_governance' },
    sources: [{ label: 'AI credit controls', method: 'GET', path: '/api/v1/ai/credit-controls', assertion: 'observed' }],
    coverage: { included: 2, total: 2, complete: true, unit: 'evidence areas' },
    evidence: {
      credits: parseAICreditControls({ accountCreditLimit: 100, creditsUsed: 40 }),
      evals: {
        state: 'available' as const,
        promptSetCount: 0,
        configuredPromptCount: 0,
        runCollectionState: 'not_applicable' as const,
        latestRunDetailState: 'not_applicable' as const,
        latestRun: null,
        contractState: 'unverified' as const,
        discoveredReadOperations: 0,
        discoveredWriteOperations: 0,
        resultEvidenceAvailable: false,
        reasonCode: 'no_prompt_sets',
        detail: 'No active AI eval prompt sets were visible to the current caller.',
        privatePrompt: 'private-frontend-marker',
      },
    },
  });

  const parsed = parseAIGovernanceFleet({
    schemaVersion: 1,
    generatedAt,
    coverage: { included: 1, total: 1, complete: true },
    instances: [{ instanceId: 'instance-1', instanceLabel: 'Example organization', state: 'available', bundle }],
    exclusions: ['Per-query credit evidence is unavailable.'],
    guardrails: ['Read only.'],
  });

  assert.equal(parsed.instances[0]?.bundle.selectedInstance.id, 'instance-1');
  assert.equal(parsed.instances[0]?.bundle.evidence.credits.utilizationPercent, 40);
  assert.equal(parsed.instances[0]?.bundle.evidence.evals.promptSetCount, 0);
  assert.doesNotMatch(JSON.stringify(parsed), /private-frontend-marker/);
  assert.deepEqual(parsed.exclusions, ['Per-query credit evidence is unavailable.']);
});

test('AI governance selected mode fails closed and invalidates on the full connection key', () => {
  const missingSelectionGuard = pageSource.indexOf("scopeMode === 'selected' && !selectedInstanceId");
  const fleetRead = pageSource.indexOf('await fetchAIGovernanceFleet');
  assert.ok(missingSelectionGuard >= 0 && missingSelectionGuard < fleetRead);
  assert.match(pageSource, /getConnectionCacheKey\(connection\)/);
  assert.match(pageSource, /requestScopeKey = scopeMode === 'selected' \? `selected:\$\{connectionKey\}` : 'fleet'/);
  assert.match(pageSource, /activeRequestScopeKeyRef\.current = requestScopeKey/);
  assert.match(pageSource, /activeRequestScopeKeyRef\.current !== activeScope/);
  assert.match(pageSource, /next\.instances\.length !== 1/);
  assert.match(pageSource, /next\.instances\[0\]\?\.instanceId !== selectedInstanceId/);
  assert.match(pageSource, /next\.instances\[0\]\?\.bundle\.selectedInstance\.origin !== selectedInstanceOrigin/);
});
