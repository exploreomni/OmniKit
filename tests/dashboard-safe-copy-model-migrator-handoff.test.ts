import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  dashboardDeploymentModelMigratorHandoffFromSearch,
  dashboardSafeCopyModelMigratorHandoffMatchesJob,
  createDashboardSafeCopyModelMigratorHandoff,
  parseDashboardSafeCopyModelMigratorHandoff,
  parseDashboardDeploymentModelMigratorHandoff,
  resolveDashboardDeploymentModelMigratorHandoff,
  resolveDashboardSafeCopyModelMigratorHandoff,
  scopeDashboardModelRepairTranslation,
} from '../src/services/modelMigratorHandoff';
import type { MigrationJob } from '../src/services/opsConsole';
import type { DashboardDeploymentPlan } from '../shared/dashboardDeploymentPlan';

const JOB_ID = '22222222-2222-4222-8222-222222222222';

function handoff() {
  return createDashboardSafeCopyModelMigratorHandoff({
    jobId: JOB_ID,
    targetId: 'target-c',
    sourceInstanceId: 'source-a',
    sourceConnectionId: 'source-connection',
    targetInstanceId: 'destination-c',
    targetConnectionId: 'target-connection',
    targetModelId: 'target-model',
  });
}

function instance(id: string, role: 'source' | 'destination' | 'both') {
  return { id, role };
}

function sourceJob(): MigrationJob {
  return {
    id: JOB_ID,
    workflow: 'dashboard',
    sourceId: 'source-a',
    sourceLabel: 'Source A',
    sourceConnectionId: 'source-connection',
    destinationIds: ['destination-c'],
    targets: [{
      id: 'target-c',
      destinationInstanceId: 'destination-c',
      destinationLabel: 'Destination C',
      targetConnectionId: 'target-connection',
      targetModelId: 'target-model',
    }],
    documentIds: ['dashboard-1'],
    emptyFirst: false,
    replaceSameNamed: false,
    deleteSourceOnSuccess: false,
    postMigrationActions: [],
    status: 'partial',
    createdAt: 1,
    details: {
      safeCopyProfile: 'safe_copy_v1',
      operationMode: 'safe_copy',
    },
    items: [{
      id: 'target-result-c',
      jobId: JOB_ID,
      targetId: 'target-c',
      destinationId: 'destination-c',
      destinationLabel: 'Destination C',
      kind: 'semantic_validate',
      status: 'failed',
      details: {
        safeCopyTargetExecutionSummary: true,
        safeCopyTargetStatus: 'needs_attention',
        safeCopyRecommendedActions: ['open_model_migrator'],
      },
    }],
  };
}

test('safe-copy creates and parses one exact Model Migrator repair scope', () => {
  const value = handoff();
  assert.deepEqual(value, {
    version: 1,
    source: 'dashboard_safe_copy_v1',
    jobId: JOB_ID,
    targetId: 'target-c',
    sourceInstanceId: 'source-a',
    sourceConnectionId: 'source-connection',
    targetInstanceId: 'destination-c',
    targetConnectionId: 'target-connection',
    targetModelId: 'target-model',
  });
  assert.deepEqual(parseDashboardSafeCopyModelMigratorHandoff(value), value);
});

test('malformed, expanded, or whitespace-altered repair route state fails closed', () => {
  const value = handoff();
  for (const invalid of [
    null,
    [],
    { ...value, version: 2 },
    { ...value, source: 'legacy_dashboard_migrator' },
    { ...value, jobId: 'not-a-canonical-job-id' },
    { ...value, targetId: ' target-c' },
    { ...value, targetModelId: '' },
    { ...value, unexpected: 'must-not-be-accepted' },
  ]) {
    assert.equal(parseDashboardSafeCopyModelMigratorHandoff(invalid), null);
  }
});

test('repair route state resolves for eligible roles including same-instance different connections', () => {
  const value = handoff();
  assert.deepEqual(resolveDashboardSafeCopyModelMigratorHandoff(value, [
    instance('source-a', 'source'),
    instance('destination-c', 'destination'),
  ]), { status: 'ready', handoff: value });

  for (const instances of [
    [instance('source-a', 'source')],
    [instance('source-a', 'destination'), instance('destination-c', 'destination')],
    [instance('source-a', 'source'), instance('destination-c', 'source')],
  ]) {
    const resolution = resolveDashboardSafeCopyModelMigratorHandoff(value, instances);
    assert.equal(resolution.status, 'invalid');
    assert.equal(resolution.handoff, undefined);
  }

  const sameInstance = { ...value, targetInstanceId: value.sourceInstanceId };
  const sameInstanceResolution = resolveDashboardSafeCopyModelMigratorHandoff(sameInstance, [
    instance('source-a', 'both'),
  ]);
  assert.equal(sameInstanceResolution.status, 'ready');
  assert.deepEqual(sameInstanceResolution.handoff, sameInstance);
});

function deploymentPlan(): DashboardDeploymentPlan {
  return {
    version: 2, id: JOB_ID, revision: 1, createdAt: 1, updatedAt: 1,
    intent: {
      profile: 'safe_copy_v1', requestId: JOB_ID,
      source: { instanceId: 'source-a', connectionId: 'source-connection', documentIds: ['dashboard-1'] },
      destinations: [{ targetId: 'target-c', instanceId: 'destination-c', connectionId: 'target-connection', modelId: 'target-model' }],
    },
    sourceHashes: {}, sourceModelHashes: {},
    targets: [{
      targetId: 'target-c', status: 'model_changes_required', checkedAt: 1,
      findings: [{ id: 'finding-1', kind: 'view', reference: 'required', message: 'A required view is missing.', documentIds: ['dashboard-1'], sourceFileName: 'required.view' }],
      sourceModelIds: ['source-model'], requiredFiles: ['required.view'],
      requiredFilesByModelId: { 'source-model': ['required.view'] },
    }],
  };
}

const deploymentHandoff = { version: 2, source: 'dashboard_deployment_plan', planId: JOB_ID, targetId: 'target-c' } as const;
const repairInstances = [instance('source-a', 'source'), instance('destination-c', 'destination')];

test('deployment handoff carries identifiers only and reload query recovers the same exact plan target', () => {
  assert.deepEqual(parseDashboardDeploymentModelMigratorHandoff(deploymentHandoff), deploymentHandoff);
  assert.deepEqual(dashboardDeploymentModelMigratorHandoffFromSearch(`?planId=${JOB_ID}&targetId=target-c`), deploymentHandoff);
  assert.equal(parseDashboardDeploymentModelMigratorHandoff({ ...deploymentHandoff, targetModelId: 'spoofed-model' }), null);
  assert.equal(dashboardDeploymentModelMigratorHandoffFromSearch(`?planId=${JOB_ID}&targetId=target-c&targetId=other`), null);
  assert.equal(parseDashboardDeploymentModelMigratorHandoff({ ...deploymentHandoff, planId: 'not-a-plan-id' }), null);
});

test('deployment repair gets all model and connection identities from the reread plan', () => {
  const plan = deploymentPlan();
  const scope = resolveDashboardDeploymentModelMigratorHandoff(deploymentHandoff, plan, repairInstances);
  assert.deepEqual(scope.sourceModelIds, ['source-model']);
  assert.equal(scope.targetModelId, 'target-model');
  assert.equal(scope.sourceConnectionId, 'source-connection');
  assert.equal(scope.targetConnectionId, 'target-connection');
  assert.equal(scope.scopeReviewRequired, undefined);
  assert.throws(() => resolveDashboardDeploymentModelMigratorHandoff(deploymentHandoff, { ...plan, id: 'other-plan' }, repairInstances));
  assert.throws(() => resolveDashboardDeploymentModelMigratorHandoff(deploymentHandoff, plan, [instance('source-a', 'destination'), instance('destination-c', 'destination')]));
  plan.intent.destinations[0].instanceId = 'source-a';
  assert.equal(resolveDashboardDeploymentModelMigratorHandoff(deploymentHandoff, plan, [instance('source-a', 'both')]).scopeReviewRequired, undefined);
});

test('empty, unowned, conflicting, or unverified dependency scope never defaults to whole-model repair', () => {
  for (const change of [
    { requiredFiles: [], requiredFilesByModelId: {} },
    { sourceModelIds: [] },
    { requiredFilesByModelId: {} },
    { requiredFiles: ['required.view', 'unowned.view'] },
    { sourceModelIds: ['source-model', 'other-model'], requiredFilesByModelId: { 'source-model': ['required.view'], 'other-model': ['required.view'] } },
    { status: 'unverified' as const },
    { status: 'needs_recheck' as const },
  ]) {
    const plan = deploymentPlan();
    Object.assign(plan.targets[0], change);
    const scope = resolveDashboardDeploymentModelMigratorHandoff(deploymentHandoff, plan, repairInstances);
    assert.ok(scope.scopeReviewRequired);
  }
});

test('repair translation includes only required files and their source-backed decisions', () => {
  const scope = resolveDashboardDeploymentModelMigratorHandoff(deploymentHandoff, deploymentPlan(), repairInstances);
  const translation = {
    files: [{ fileName: 'required.view' }, { fileName: 'unrelated.view' }],
    checksums: { 'required.view': 'required-checksum', 'unrelated.view': 'other-checksum' },
    semanticDecisions: [
      { sourceFileName: 'required.view', targetFileName: 'required.view' },
      { sourceFileName: 'unrelated.view', targetFileName: 'unrelated.view' },
      { targetFileName: 'target-only.view' },
      { sourceFileName: 'required.view', targetFileName: 'target-only.view' },
    ],
    prompts: [{ fileName: 'required.view', prompt: 'Required review' }, { fileName: 'unrelated.view', prompt: 'Other review' }],
  };
  const filtered = scopeDashboardModelRepairTranslation(translation, scope, 'source-model');
  assert.deepEqual(filtered.files, [{ fileName: 'required.view' }]);
  assert.deepEqual(filtered.checksums, { 'required.view': 'required-checksum' });
  assert.deepEqual(filtered.semanticDecisions, [{ sourceFileName: 'required.view', targetFileName: 'required.view' }]);
  assert.equal(filtered.prompts.length, 1);
  assert.throws(() => scopeDashboardModelRepairTranslation({ ...translation, files: [] }, scope, 'source-model'), /Dependency scope needs review/);
  assert.throws(() => scopeDashboardModelRepairTranslation(translation, scope, 'other-model'), /Dependency scope needs review/);
});

test('repair scope must still match the exact safe-copy job and one actionable target', () => {
  const value = handoff();
  const job = sourceJob();
  assert.equal(dashboardSafeCopyModelMigratorHandoffMatchesJob(value, job), true);

  for (const invalidJob of [
    { ...job, id: '33333333-3333-4333-8333-333333333333' },
    { ...job, workflow: 'model' as const },
    { ...job, sourceId: 'source-b' },
    { ...job, sourceConnectionId: 'other-source-connection' },
    { ...job, targets: [{ ...job.targets![0], id: 'other-target' }] },
    { ...job, targets: [{ ...job.targets![0], destinationInstanceId: 'destination-d' }] },
    { ...job, targets: [{ ...job.targets![0], targetConnectionId: 'other-target-connection' }] },
    { ...job, targets: [{ ...job.targets![0], targetModelId: 'other-target-model' }] },
    { ...job, items: [{
      ...job.items[0],
      details: { ...job.items[0].details, safeCopyRecommendedActions: [] },
    }] },
    { ...job, items: [...job.items, {
      ...job.items[0],
      id: 'uncertain-attempt-c',
      kind: 'import' as const,
      status: 'warning' as const,
      details: { safeCopyAttempt: true, safeCopyAttemptState: 'uncertain' },
    }] },
  ]) {
    assert.equal(dashboardSafeCopyModelMigratorHandoffMatchesJob(value, invalidJob), false);
  }
});
