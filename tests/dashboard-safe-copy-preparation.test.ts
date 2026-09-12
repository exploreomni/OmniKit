import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  prepareDashboardSafeCopyTargets,
  type DashboardSafeCopyPreparationDependencies,
} from '../server/services/dashboardSafeCopyPreparation';
import type {
  DashboardPatchValidationResult,
  MigrationPlan,
  MigrationTarget,
} from '../server/services/migrationJobs';
import type { DashboardSafeCopyIntent } from '../shared/dashboardSafeCopyContract';

function target(id: string): MigrationTarget {
  return {
    id,
    destinationInstanceId: `instance-${id}`,
    destinationLabel: `Destination ${id}`,
    targetConnectionId: `connection-${id}`,
    targetModelId: `model-${id}`,
    targetFolderPath: 'Shared/Migrated',
  };
}

function intent(targetIds: string[]): DashboardSafeCopyIntent {
  return {
    profile: 'safe_copy_v1',
    requestId: '11111111-1111-4111-8111-111111111111',
    source: {
      instanceId: 'source-instance',
      connectionId: 'source-connection',
      documentIds: ['dashboard-1'],
    },
    destinations: targetIds.map((targetId) => ({
      targetId,
      instanceId: `instance-${targetId}`,
      connectionId: `connection-${targetId}`,
      modelId: `model-${targetId}`,
      folderPath: 'Shared/Migrated',
    })),
  };
}

function planFor(planTarget: MigrationTarget, options: {
  blocked?: boolean;
  error?: string;
  replacement?: boolean;
  kind?: MigrationPlan['steps'][number]['kind'];
} = {}): MigrationPlan {
  const step = (kind: MigrationPlan['steps'][number]['kind']) => ({
    targetId: planTarget.id,
    destinationId: planTarget.destinationInstanceId,
    destinationLabel: planTarget.destinationLabel || planTarget.destinationInstanceId,
    targetConnectionId: planTarget.targetConnectionId,
    targetModelId: planTarget.targetModelId,
    targetFolderPath: planTarget.targetFolderPath,
    kind,
    documentId: 'dashboard-1',
    documentName: 'Dashboard 1',
  });
  return {
    sourceId: 'source-instance',
    sourceLabel: 'Source',
    sourceConnectionId: 'source-connection',
    destinationIds: [planTarget.destinationInstanceId],
    targets: [planTarget],
    documentIds: ['dashboard-1'],
    emptyFirst: false,
    replaceSameNamed: false,
    deleteSourceOnSuccess: false,
    sourceAllFolders: true,
    steps: [
      step('export'),
      step('semantic_validate'),
      step('query_validate'),
      {
        ...step(options.kind || 'import'),
      blocked: options.blocked,
      error: options.error,
      replacement: options.replacement,
      },
      step('metadata'),
      step('document_verify'),
    ],
  };
}

function passedBranchValidation(targetId: string, patchId: string): DashboardPatchValidationResult {
  return {
    status: 'passed',
    results: [{
      targetId,
      destinationId: `instance-${targetId}`,
      targetModelId: `model-${targetId}`,
      mode: 'branch',
      status: 'passed',
      artifacts: [{
        id: patchId,
        artifactType: 'field',
        targetFileName: 'orders.view',
        status: 'passed',
        messages: ['passed'],
      }],
    }],
  };
}

const ordersSnapshot = {
  files: {
    'orders.view': 'dimensions:\n  order_id:\n    sql: ${TABLE}.order_id',
  },
  checksums: { 'orders.view': 'checksum-1' },
};

test('v2 read-only preparation routes semantic changes to repair without scratch validation', async () => {
  const selected = target('b');
  const safeIntent = intent(['b']);
  safeIntent.deployment = {
    version: 2, planId: 'reviewed-plan',
    sourceHashes: { 'dashboard-1': 'a'.repeat(64) }, modelHashes: { b: 'b'.repeat(64) },
  };
  let scratchCalls = 0;
  let snapshotCalls = 0;
  const results = await prepareDashboardSafeCopyTargets(safeIntent, [selected], {
    async buildPlan(input) {
      assert.equal(input.targets![0].exactFolder, true, 'v2 targets must not inherit saved destination folder defaults');
      return planFor(input.targets![0]);
    },
    resolveTarget(_plan, current) {
      return { status: 'resolved', target: { ...current, semanticPatches: [{
        id: 'missing-field', artifactType: 'field', sourceName: 'orders.amount', targetFileName: 'orders.view',
        targetModelId: selected.targetModelId, resolution: 'recommended', safetyCategory: 'safe_update', status: 'ready',
      }] } };
    },
    async validatePatches() { scratchCalls += 1; throw new Error('must not mutate scratch branches'); },
    async loadTargetYamlSnapshot() { snapshotCalls += 1; return ordersSnapshot; },
  });
  assert.equal(results[0].status, 'needs_attention');
  if (results[0].status === 'needs_attention') assert.equal(results[0].exceptions[0].code, 'REPAIR_REQUIRED');
  assert.equal(scratchCalls, 0);
  assert.equal(snapshotCalls, 0);
});

test('automatic preparation converges without exposing dependency decisions for an exact target', async () => {
  const selected = target('b');
  let planCalls = 0;
  const results = await prepareDashboardSafeCopyTargets(intent(['b']), [selected], {
    async buildPlan(input) {
      planCalls += 1;
      return planFor(input.targets![0]);
    },
  });
  assert.equal(planCalls, 1);
  assert.equal(results.length, 1);
  assert.equal(results[0].status, 'ready');
  if (results[0].status !== 'ready') return;
  assert.equal(results[0].patchCount, 0);
  assert.equal(results[0].scratchValidation, 'not_required');
  assert.match(results[0].decisionFingerprint, /^[a-f0-9]{64}$/);
});

test('one destination exception does not block independent ready destinations', async () => {
  const selected = ['b', 'c', 'd'].map(target);
  const dependencies: DashboardSafeCopyPreparationDependencies = {
    async buildPlan(input) {
      return planFor(input.targets![0]);
    },
    resolveTarget(plan, current) {
      if (current.id === 'c') {
        return {
          status: 'exception',
          targetId: current.id,
          exceptions: [{
            targetId: current.id,
            code: 'AMBIGUOUS_MAPPING',
            artifact: 'field',
            reference: 'orders.amount',
            message: 'More than one strong field match is available.',
          }],
        };
      }
      return { status: 'resolved', target: current };
    },
  };
  const results = await prepareDashboardSafeCopyTargets(intent(['b', 'c', 'd']), selected, dependencies);
  assert.deepEqual(results.map((result) => [result.targetId, result.status]), [
    ['b', 'ready'],
    ['c', 'needs_attention'],
    ['d', 'ready'],
  ]);
});

test('write-bearing automatic patches require exact clean branch validation', async () => {
  const selected = target('b');
  const patch = {
    id: 'field:orders.net_sales',
    artifactType: 'field' as const,
    sourceName: 'orders.net_sales',
    sourceFileName: 'orders.view',
    targetFileName: 'orders.view',
    targetModelId: selected.targetModelId,
    currentYaml: 'dimensions:\n  order_id:\n    sql: ${TABLE}.order_id',
    recommendedYaml: 'dimensions:\n  order_id:\n    sql: ${TABLE}.order_id\n  net_sales:\n    sql: ${TABLE}.net_sales',
    acceptedYaml: 'dimensions:\n  order_id:\n    sql: ${TABLE}.order_id\n  net_sales:\n    sql: ${TABLE}.net_sales',
    previousChecksum: 'checksum-1',
    resolution: 'recommended' as const,
    status: 'ready' as const,
    safetyCategory: 'safe_update' as const,
  };
  const resolveTarget: NonNullable<DashboardSafeCopyPreparationDependencies['resolveTarget']> = (_plan, current) => ({
    status: 'resolved',
    target: { ...current, semanticPatches: [patch] },
  });
  const structuralFallback = await prepareDashboardSafeCopyTargets(intent(['b']), [selected], {
    async buildPlan(input) {
      return planFor(input.targets![0]);
    },
    resolveTarget,
    async loadTargetYamlSnapshot() {
      return ordersSnapshot;
    },
    async validatePatches() {
      return {
        ...passedBranchValidation('b', patch.id),
        results: [{
          ...passedBranchValidation('b', patch.id).results[0],
          mode: 'structural',
        }],
      };
    },
  });
  assert.equal(structuralFallback[0].status, 'needs_attention');
  if (structuralFallback[0].status === 'needs_attention') {
    assert.equal(structuralFallback[0].exceptions[0]?.code, 'SCRATCH_VALIDATION_FAILED');
  }

  const wrongArtifact = await prepareDashboardSafeCopyTargets(intent(['b']), [selected], {
    async buildPlan(input) {
      return planFor(input.targets![0]);
    },
    resolveTarget,
    async loadTargetYamlSnapshot() {
      return ordersSnapshot;
    },
    async validatePatches() {
      const result = passedBranchValidation('b', patch.id);
      result.results[0].artifacts[0].targetFileName = 'other.view';
      return result;
    },
  });
  assert.equal(wrongArtifact[0].status, 'needs_attention');
  if (wrongArtifact[0].status === 'needs_attention') {
    assert.equal(wrongArtifact[0].exceptions[0]?.code, 'SCRATCH_VALIDATION_FAILED');
  }

  const passed = await prepareDashboardSafeCopyTargets(intent(['b']), [selected], {
    async buildPlan(input) {
      return planFor(input.targets![0]);
    },
    resolveTarget,
    async loadTargetYamlSnapshot() {
      return ordersSnapshot;
    },
    async validatePatches() {
      return passedBranchValidation('b', patch.id);
    },
  });
  assert.equal(passed[0].status, 'ready');
  if (passed[0].status === 'ready') {
    assert.equal(passed[0].patchCount, 1);
    assert.equal(passed[0].scratchValidation, 'passed');
  }

  const keptPatch = {
    id: 'topic:kept',
    artifactType: 'topic' as const,
    sourceName: 'Kept topic',
    targetFileName: 'kept.topic',
    resolution: 'keep_target' as const,
    status: 'ready' as const,
    safetyCategory: 'safe_ignore' as const,
  };
  const mixedWriteAndKeep = await prepareDashboardSafeCopyTargets(intent(['b']), [selected], {
    async buildPlan(input) {
      return planFor(input.targets![0]);
    },
    resolveTarget(_plan, current) {
      return { status: 'resolved', target: { ...current, semanticPatches: [patch, keptPatch] } };
    },
    async loadTargetYamlSnapshot() {
      return ordersSnapshot;
    },
    async validatePatches() {
      const result = passedBranchValidation('b', patch.id);
      result.results[0].artifacts.push({
        id: keptPatch.id,
        artifactType: keptPatch.artifactType,
        targetFileName: keptPatch.targetFileName,
        status: 'skipped',
        messages: ['No YAML write selected.'],
      });
      return result;
    },
  });
  assert.equal(mixedWriteAndKeep[0].status, 'ready');

  const extraArtifact = await prepareDashboardSafeCopyTargets(intent(['b']), [selected], {
    async buildPlan(input) {
      return planFor(input.targets![0]);
    },
    resolveTarget,
    async loadTargetYamlSnapshot() {
      return ordersSnapshot;
    },
    async validatePatches() {
      const result = passedBranchValidation('b', patch.id);
      result.results[0].artifacts.push({
        id: 'permission:unexpected',
        artifactType: 'permission',
        targetFileName: 'access_grants.yml',
        status: 'passed',
        messages: ['passed'],
      });
      return result;
    },
  });
  assert.equal(extraArtifact[0].status, 'needs_attention');
  if (extraArtifact[0].status === 'needs_attention') {
    assert.equal(extraArtifact[0].exceptions[0]?.code, 'SCRATCH_VALIDATION_FAILED');
  }

  const duplicateTargetResult = await prepareDashboardSafeCopyTargets(intent(['b']), [selected], {
    async buildPlan(input) {
      return planFor(input.targets![0]);
    },
    resolveTarget,
    async loadTargetYamlSnapshot() {
      return ordersSnapshot;
    },
    async validatePatches() {
      const result = passedBranchValidation('b', patch.id);
      result.results.push({ ...result.results[0], artifacts: [...result.results[0].artifacts] });
      return result;
    },
  });
  assert.equal(duplicateTargetResult[0].status, 'needs_attention');

  const wrongScope = await prepareDashboardSafeCopyTargets(intent(['b']), [selected], {
    async buildPlan(input) {
      return planFor(input.targets![0]);
    },
    resolveTarget,
    async loadTargetYamlSnapshot() {
      return ordersSnapshot;
    },
    async validatePatches() {
      const result = passedBranchValidation('b', patch.id);
      result.results[0].destinationId = 'other-instance';
      result.results[0].targetModelId = 'other-model';
      return result;
    },
  });
  assert.equal(wrongScope[0].status, 'needs_attention');
});

test('automatic patch proof uses a fresh destination snapshot instead of planner-carried YAML', async () => {
  const selected = target('b');
  const patch = {
    id: 'field:orders.net_sales',
    artifactType: 'field' as const,
    sourceName: 'orders.net_sales',
    sourceFileName: 'orders.view',
    targetFileName: 'orders.view',
    targetModelId: selected.targetModelId,
    currentYaml: 'dimensions:\n  invented:\n    sql: ${TABLE}.invented',
    acceptedYaml: 'dimensions:\n  invented:\n    sql: ${TABLE}.invented\n  net_sales:\n    sql: ${TABLE}.net_sales',
    previousChecksum: 'planner-checksum',
    latestChecksum: 'planner-checksum',
    resolution: 'recommended' as const,
    status: 'ready' as const,
    safetyCategory: 'safe_update' as const,
  };
  let scratchCalls = 0;
  const results = await prepareDashboardSafeCopyTargets(intent(['b']), [selected], {
    async buildPlan(input) {
      return planFor(input.targets![0]);
    },
    resolveTarget(_plan, current) {
      return { status: 'resolved', target: { ...current, semanticPatches: [patch] } };
    },
    async loadTargetYamlSnapshot() {
      return ordersSnapshot;
    },
    async validatePatches() {
      scratchCalls += 1;
      return passedBranchValidation('b', patch.id);
    },
  });

  assert.equal(results[0].status, 'needs_attention');
  if (results[0].status === 'needs_attention') {
    assert.ok(results[0].exceptions.some((exception) => (
      exception.code === 'SAFE_COPY_PATCH_CHECKSUM_MISMATCH'
    )));
  }
  assert.equal(scratchCalls, 0);
});

test('automatic patch proof fails closed when the fresh destination snapshot is unavailable', async () => {
  const selected = target('b');
  const results = await prepareDashboardSafeCopyTargets(intent(['b']), [selected], {
    async buildPlan(input) {
      return planFor(input.targets![0]);
    },
    resolveTarget(_plan, current) {
      return {
        status: 'resolved',
        target: {
          ...current,
          semanticPatches: [{
            id: 'field:orders.net_sales',
            artifactType: 'field',
            sourceName: 'orders.net_sales',
            sourceFileName: 'orders.view',
            targetFileName: 'orders.view',
            targetModelId: current.targetModelId,
            acceptedYaml: 'dimensions:\n  net_sales:\n    sql: ${TABLE}.net_sales',
            resolution: 'recommended',
            status: 'ready',
            safetyCategory: 'safe_create',
          }],
        },
      };
    },
    async loadTargetYamlSnapshot() {
      throw new Error('secret upstream evidence');
    },
  });

  assert.equal(results[0].status, 'needs_attention');
  if (results[0].status === 'needs_attention') {
    assert.deepEqual(results[0].exceptions.map((exception) => exception.code), ['MISSING_EVIDENCE']);
    assert.doesNotMatch(JSON.stringify(results[0]), /secret upstream evidence/);
  }
});

test('blocked, destructive, and cross-target plan steps fail closed', async () => {
  const selected = target('b');
  for (const unsafe of [
    { blocked: true },
    { error: 'unresolved' },
    { replacement: true },
    { kind: 'update' as const },
    { kind: 'model_merge' as const },
  ]) {
    const results = await prepareDashboardSafeCopyTargets(intent(['b']), [selected], {
      async buildPlan(input) {
        return planFor(input.targets![0], unsafe);
      },
      resolveTarget(_plan, current) {
        return { status: 'resolved', target: current };
      },
    });
    assert.equal(results[0].status, 'needs_attention');
    if (results[0].status === 'needs_attention') {
      assert.equal(results[0].exceptions[0]?.code, 'PLAN_BLOCKED');
    }
  }
});

test('automatic preparation rejects unselected documents and incomplete document plans', async () => {
  const selected = target('b');
  const wrongDocument = await prepareDashboardSafeCopyTargets(intent(['b']), [selected], {
    async buildPlan(input) {
      const plan = planFor(input.targets![0]);
      plan.steps[3].documentId = 'dashboard-not-selected';
      return plan;
    },
    resolveTarget(_plan, current) {
      return { status: 'resolved', target: current };
    },
  });
  assert.equal(wrongDocument[0].status, 'needs_attention');
  if (wrongDocument[0].status === 'needs_attention') {
    assert.equal(wrongDocument[0].exceptions[0]?.code, 'PLAN_BLOCKED');
  }

  const incomplete = await prepareDashboardSafeCopyTargets(intent(['b']), [selected], {
    async buildPlan(input) {
      const plan = planFor(input.targets![0]);
      plan.steps = plan.steps.filter((step) => step.kind !== 'document_verify');
      return plan;
    },
    resolveTarget(_plan, current) {
      return { status: 'resolved', target: current };
    },
  });
  assert.equal(incomplete[0].status, 'needs_attention');
  if (incomplete[0].status === 'needs_attention') {
    assert.equal(incomplete[0].exceptions[0]?.code, 'PLAN_BLOCKED');
  }
});
