import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DashboardDeploymentPlan } from '../shared/dashboardDeploymentPlan';
import { createDashboardSafeCopyDraft, dashboardSafeCopyDraftReducer, dashboardSafeCopyIntentFromDraft, readDashboardSafeCopyDraft, writeDashboardSafeCopyDraft } from '../src/components/dashboardMigration/dashboardSafeCopyFlowState';

const requestId = '11111111-1111-4111-8111-111111111111';
const nextRequestId = '22222222-2222-4222-8222-222222222222';
const planId = '33333333-3333-4333-8333-333333333333';
const targetId = '44444444-4444-4444-8444-444444444444';
const otherTargetId = '55555555-5555-4555-8555-555555555555';

function plan(): DashboardDeploymentPlan {
  return {
    version: 2, id: planId, revision: 1, createdAt: 1, updatedAt: 1,
    sourceHashes: {}, sourceModelHashes: {},
    intent: {
      profile: 'safe_copy_v1', requestId,
      source: { instanceId: 'source', connectionId: 'source-connection', documentIds: ['dashboard'] },
      destinations: [targetId, otherTargetId].map((id, index) => ({ targetId: id, instanceId: 'destination', connectionId: 'connection', modelId: 'model', folderPath: `/Folder ${index + 1}` })),
    },
    targets: [targetId, otherTargetId].map((id) => ({ targetId: id, status: 'ready', findings: [], sourceModelIds: [], requiredFiles: [], requiredFilesByModelId: {}, checkedAt: 1 })),
  };
}

test('repeatable rows keep independent target identity on one instance, model and different folder', () => {
  let state = createDashboardSafeCopyDraft();
  for (const destination of plan().intent.destinations) {
    state = dashboardSafeCopyDraftReducer(state, { type: 'add_destination', destination, limit: 100, requestId });
  }
  assert.equal(state.destinations.length, 2);
  state = dashboardSafeCopyDraftReducer(state, { type: 'update_destination', targetId, patch: { modelId: 'alternate', folderPath: '/Changed' }, requestId: nextRequestId });
  assert.equal(state.destinations[0].modelId, 'alternate');
  assert.equal(state.destinations[1].modelId, 'model');
  assert.equal(state.destinations[1].folderPath, '/Folder 2');
  state = dashboardSafeCopyDraftReducer(state, { type: 'remove_destination', targetId, requestId });
  assert.deepEqual(state.destinations.map((row) => row.targetId), [otherTargetId]);
});

test('edited and empty folders override saved defaults in the intent', () => {
  const state = dashboardSafeCopyDraftReducer(createDashboardSafeCopyDraft(), { type: 'restore_plan', plan: plan() });
  const cleared = dashboardSafeCopyDraftReducer(state, { type: 'update_destination', targetId, patch: { folderId: '', folderPath: '' }, requestId: nextRequestId });
  const intent = dashboardSafeCopyIntentFromDraft(cleared, [{ id: 'destination', defaultFolderId: 'saved-folder', defaultFolderPath: '/Saved default' }]);
  assert.equal(intent.destinations[0].folderId, undefined);
  assert.equal(intent.destinations[0].folderPath, undefined);
  assert.equal(intent.destinations[1].folderPath, '/Folder 2');
});

test('every scope edit invalidates readiness and deployment request identity', () => {
  const restored = dashboardSafeCopyDraftReducer(createDashboardSafeCopyDraft(), { type: 'restore_plan', plan: plan() });
  const selected = dashboardSafeCopyDraftReducer(restored, { type: 'select_targets', targetIds: [targetId], deploymentRequestId: nextRequestId });
  const edited = dashboardSafeCopyDraftReducer(selected, { type: 'update_destination', targetId, patch: { connectionId: 'other' }, requestId: nextRequestId });
  assert.equal(edited.planId, undefined);
  assert.equal(edited.selectedTargetIds, undefined);
  assert.equal(edited.deploymentRequestId, undefined);
});

test('mixed readiness requires an explicit subset selection and recheck prunes newly held targets', () => {
  const mixed = plan();
  mixed.targets[1].status = 'unverified';
  let state = dashboardSafeCopyDraftReducer(createDashboardSafeCopyDraft(), { type: 'restore_plan', plan: mixed });
  assert.deepEqual(state.selectedTargetIds, []);
  state = dashboardSafeCopyDraftReducer(state, { type: 'select_targets', targetIds: [targetId], deploymentRequestId: nextRequestId });
  mixed.targets[0].status = 'needs_recheck';
  state = dashboardSafeCopyDraftReducer(state, { type: 'restore_plan', plan: mixed });
  assert.deepEqual(state.selectedTargetIds, []);
});

test('reload persists only plan and execution identities, restoring all scope from the server plan', () => {
  let value = '';
  const storage = { setItem: (_key: string, data: string) => { value = data; }, getItem: () => value };
  let state = dashboardSafeCopyDraftReducer(createDashboardSafeCopyDraft(), { type: 'restore_plan', plan: plan() });
  state = dashboardSafeCopyDraftReducer(state, { type: 'select_targets', targetIds: [otherTargetId], deploymentRequestId: nextRequestId });
  writeDashboardSafeCopyDraft(state, storage);
  const identity = JSON.parse(value);
  assert.equal(identity.planId, planId);
  assert.equal(identity.deploymentRequestId, nextRequestId);
  assert.equal(identity.sourceId, undefined);
  assert.equal(identity.destinations, undefined);
  const restored = readDashboardSafeCopyDraft(storage);
  assert.deepEqual(restored.destinations, []);
  const hydrated = dashboardSafeCopyDraftReducer(restored, { type: 'restore_plan', plan: plan() });
  assert.equal(hydrated.destinations[1].folderPath, '/Folder 2');
  assert.deepEqual(hydrated.selectedTargetIds, [otherTargetId]);
});
