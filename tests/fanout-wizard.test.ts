import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  applySelectedSourceModelFallback,
  buildTargetFolderOptions,
  buildTargetModelOptions,
  canContinueFromSourceStep,
  cleanFanoutModelMetadata,
  combineMigrationPlans,
  estimateDurationSeconds,
  fanoutDocumentModelLabel,
  getFanoutPreflightBlockReason,
  preflightRowsFromPlan,
  preserveSelectedDocumentIds,
  removeTargetFromMigrationPlan,
  summarizePlanByTarget,
  TARGET_FOLDER_COMBOBOX_CONFIG,
  TARGET_MODEL_COMBOBOX_CONFIG,
} from '../src/components/migrateFanout/fanoutUtils';
import { targetDraftToMigrationTarget, type FanoutDraft } from '../src/components/migrateFanout/fanoutTypes';
import { sanitizeFanoutDraftForStorage } from '../src/components/migrateFanout/fanoutStorage';
import { canApplyModelRemapAfterPreflight } from '../src/components/steps/reviewPreflight';
import {
  comboBoxEmptyText,
  filterComboBoxOptions,
  resolveComboBoxDisplay,
} from '../src/components/ui/comboBoxUtils';
import { initialWizardState, wizardReducer } from '../src/hooks/useWizard';
import type { MigrationPlan, SavedInstancePublic } from '../src/services/opsConsole';

const destination: SavedInstancePublic = {
  id: 'dest-1',
  label: 'Destination One',
  role: 'destination',
  baseUrl: 'https://dest.example.omniapp.co',
  apiKeyMasked: 'omni****1234',
  metricFilter: {
    connectionDatabaseContains: [],
    connectionDatabaseExact: [],
    embedExternalIdContains: [],
    embedExternalIdExact: [],
  },
  postMigrationActions: [],
  createdAt: '2026-06-10T00:00:00.000Z',
  updatedAt: '2026-06-10T00:00:00.000Z',
};

test('target drafts convert to migration targets without secrets', () => {
  const target = targetDraftToMigrationTarget({
    id: 'target-1',
    destinationInstanceId: destination.id,
    targetModelId: 'model-1',
    targetModelName: 'Executive Model',
    targetFolderPath: 'Executive/Migrated',
    targetFolderId: 'folder-1',
    selectedActionIndexes: [0],
  }, [destination]);

  assert.equal(target.destinationLabel, 'Destination One');
  assert.equal(target.targetModelId, 'model-1');
  assert.equal(target.targetFolderPath, 'Executive/Migrated');
  assert.equal(JSON.stringify(target).includes('omni****1234'), false);
});

test('same-instance model remap apply requires ready or warning preflight for every selected dashboard', () => {
  const selected = [{ id: 'dash-1' }, { id: 'dash-2' }];

  assert.equal(canApplyModelRemapAfterPreflight(selected, null), false);
  assert.equal(canApplyModelRemapAfterPreflight(selected, [{ id: 'dash-1', name: 'One', status: 'ready' }]), false);
  assert.equal(canApplyModelRemapAfterPreflight(selected, [
    { id: 'dash-1', name: 'One', status: 'ready' },
    { id: 'dash-2', name: 'Two', status: 'warning' },
  ]), true);
  assert.equal(canApplyModelRemapAfterPreflight(selected, [
    { id: 'dash-1', name: 'One', status: 'ready' },
    { id: 'dash-2', name: 'Two', status: 'failed' },
  ]), false);
});

test('same-instance model remap preflight resets when mappings or dashboard selections change', () => {
  const stalePreflightState = {
    ...initialWizardState,
    selectedDashboards: [{ id: 'dash-1', name: 'Coffee Shop Demo' }],
    modelMappings: { source_model: 'old_target_model' },
    dryRunCompleted: true,
    migrationResults: [{ id: 'dash-1', name: 'Coffee Shop Demo', status: 'ready' as const }],
    migrationSummary: { succeeded: 1, failed: 0, skipped: 0, total: 1 },
  };

  const afterMappingChange = wizardReducer(stalePreflightState, {
    type: 'SET_MODEL_MAPPING',
    sourceId: 'source_model',
    targetId: 'new_target_model',
  });

  assert.equal(afterMappingChange.dryRunCompleted, false);
  assert.deepEqual(afterMappingChange.migrationResults, []);
  assert.equal(afterMappingChange.migrationSummary, null);

  const afterSelectionChange = wizardReducer(stalePreflightState, {
    type: 'SET_SELECTED_DASHBOARDS',
    dashboards: [{ id: 'dash-2', name: 'NFL MVP Analytics' }],
  });

  assert.equal(afterSelectionChange.dryRunCompleted, false);
  assert.deepEqual(afterSelectionChange.migrationResults, []);
  assert.equal(afterSelectionChange.migrationSummary, null);
});

test('fan-out document model label prefers enriched metadata and never surfaces unknown placeholders', () => {
  const names = new Map([['model-1', 'Coffee Model']]);

  assert.equal(cleanFanoutModelMetadata('Unknown'), undefined);
  assert.deepEqual(
    fanoutDocumentModelLabel({ baseModelId: 'model-1', baseModelName: 'Unknown' }, names),
    { label: 'Coffee Model', detected: true },
  );
  assert.deepEqual(
    fanoutDocumentModelLabel({ baseModelId: 'Unknown', baseModelName: 'Model not detected' }, names),
    { label: 'Model unavailable from export', detected: false },
  );
});

test('fan-out source model fallback enriches scoped documents without mislabeling out-of-folder rows', () => {
  const documents = applySelectedSourceModelFallback([
    {
      id: 'coffee-shop-demo',
      identifier: 'coffee-shop-demo',
      name: 'Coffee Shop Demo',
      folderPath: 'omni-training',
    },
    {
      id: 'nfl-superstar-team-motion-lab-v34',
      identifier: 'nfl-superstar-team-motion-lab-v34',
      name: 'NFL MVP Analytics',
      folderPath: 'just-for-fun',
    },
  ], {
    sourceModelId: 'coffee-model',
    sourceFolderPath: 'omni-training',
    sourceModels: [{
      id: 'coffee-model',
      name: 'ATX - Coffee Shop Demo',
      identifier: 'atx_coffee_shop_demo',
    }],
  });

  assert.equal(documents[0].baseModelId, 'coffee-model');
  assert.equal(documents[0].baseModelName, 'ATX - Coffee Shop Demo');
  assert.deepEqual(fanoutDocumentModelLabel(documents[0]), {
    label: 'ATX - Coffee Shop Demo',
    detected: true,
  });
  assert.equal(documents[1].baseModelId, undefined);
  assert.deepEqual(fanoutDocumentModelLabel(documents[1]), {
    label: 'Model unavailable from export',
    detected: false,
  });
});

test('fan-out source model fallback preserves export metadata and only applies to unambiguous single rows without folder scope', () => {
  const [existing] = applySelectedSourceModelFallback([
    {
      id: 'existing-doc',
      identifier: 'existing-doc',
      name: 'Existing Metadata',
      baseModelId: 'existing-model',
      baseModelName: 'Existing Model',
    },
  ], {
    sourceModelId: 'coffee-model',
    sourceModels: [{ id: 'coffee-model', name: 'ATX - Coffee Shop Demo' }],
  });

  assert.equal(existing.baseModelId, 'existing-model');
  assert.equal(existing.baseModelName, 'Existing Model');

  const [single] = applySelectedSourceModelFallback([
    {
      id: 'single-doc',
      identifier: 'single-doc',
      name: 'Single Dashboard',
    },
  ], {
    sourceModelId: 'coffee-model',
    sourceModels: [{ id: 'coffee-model', name: 'ATX - Coffee Shop Demo' }],
  });

  assert.equal(single.baseModelId, 'coffee-model');
  assert.equal(single.baseModelName, 'ATX - Coffee Shop Demo');
});

test('fan-out preflight blocker returns actionable reasons and clears when ready', () => {
  const readyInput = {
    sourceId: 'source-1',
    selectedDocumentIds: ['doc-1'],
    targets: [{
      destinationInstanceId: 'dest-1',
      destinationLabel: 'Destination One',
      targetModelId: 'model-1',
      targetFolderPath: 'Shared/Migrated',
    }],
    hasLoadingTargets: false,
    hasUnresolvedFolderTargets: false,
    preflightLoading: false,
    jobBusy: false,
  };

  assert.equal(getFanoutPreflightBlockReason({ ...readyInput, sourceId: '' }), 'Choose a source instance before running preflight.');
  assert.equal(getFanoutPreflightBlockReason({ ...readyInput, selectedDocumentIds: [] }), 'Select at least one source dashboard before running preflight.');
  assert.equal(getFanoutPreflightBlockReason({ ...readyInput, targets: [] }), 'Select at least one destination instance before running preflight.');
  assert.equal(getFanoutPreflightBlockReason({ ...readyInput, hasLoadingTargets: true }), 'Wait for destination model and folder catalogs to finish loading.');
  assert.equal(
    getFanoutPreflightBlockReason({
      ...readyInput,
      targets: [{ ...readyInput.targets[0], targetModelId: '' }],
    }),
    'Choose a target model for Destination One.',
  );
  assert.equal(getFanoutPreflightBlockReason({ ...readyInput, hasUnresolvedFolderTargets: true }), 'Choose a folder path for saved folder IDs before running preflight.');
  assert.equal(getFanoutPreflightBlockReason(readyInput), '');
});

test('target ComboBox helpers filter catalogs, preserve unknown values, and keep target-specific free-text rules', () => {
  const modelOptions = buildTargetModelOptions([
    { id: 'model-1', name: 'Coffee Model', identifier: 'coffee-model', kind: 'shared' },
    { id: 'model-2', name: '', identifier: 'fallback-model', kind: 'workbook' },
  ]);
  const folderOptions = buildTargetFolderOptions([
    { id: 'folder-1', name: 'Migrated', path: 'Shared/Migrated' },
    { id: 'folder-2', name: 'Sandbox', identifier: 'sandbox-folder' },
  ]);

  assert.equal(TARGET_MODEL_COMBOBOX_CONFIG.allowFreeText, false);
  assert.equal(TARGET_FOLDER_COMBOBOX_CONFIG.allowFreeText, true);
  assert.deepEqual(filterComboBoxOptions(modelOptions, 'coffee').map((option) => option.value), ['model-1']);
  assert.deepEqual(filterComboBoxOptions(modelOptions, 'fallback').map((option) => option.value), ['model-2']);
  assert.deepEqual(filterComboBoxOptions(folderOptions, 'Shared').map((option) => option.value), ['Shared/Migrated']);
  assert.deepEqual(resolveComboBoxDisplay(modelOptions, 'model-not-in-catalog'), {
    selectedLabel: 'model-not-in-catalog',
    showIdBelowLabel: false,
  });
  assert.deepEqual(resolveComboBoxDisplay(modelOptions, 'model-1'), {
    selectedLabel: 'Coffee Model',
    showIdBelowLabel: true,
  });
  assert.equal(
    comboBoxEmptyText({ allowFreeText: TARGET_FOLDER_COMBOBOX_CONFIG.allowFreeText, search: 'New/Folder', emptyLabel: TARGET_FOLDER_COMBOBOX_CONFIG.emptyLabel }),
    'Use "New/Folder" as custom value',
  );
  assert.equal(
    comboBoxEmptyText({ allowFreeText: TARGET_MODEL_COMBOBOX_CONFIG.allowFreeText, search: 'missing model', emptyLabel: TARGET_MODEL_COMBOBOX_CONFIG.emptyLabel }),
    'No models found',
  );
});

test('metadata fix flow gates source continuation and preserves selected dashboards after reload', () => {
  assert.equal(canContinueFromSourceStep([], false), false);
  assert.equal(canContinueFromSourceStep(['dash-1'], true), false);
  assert.equal(canContinueFromSourceStep(['dash-1'], false), true);
  assert.deepEqual(
    preserveSelectedDocumentIds(['dash-1', 'dash-3'], [
      { identifier: 'dash-2' },
      { identifier: 'dash-3' },
    ]),
    ['dash-3'],
  );
});

test('preflight summaries stay target-scoped when one destination has multiple targets', () => {
  const plan: MigrationPlan = {
    sourceId: 'source-1',
    sourceLabel: 'Source',
    destinationIds: ['dest-1'],
    documentIds: ['doc-1'],
    emptyFirst: false,
    replaceSameNamed: true,
    targets: [
      {
        id: 'target-a',
        destinationInstanceId: 'dest-1',
        destinationLabel: 'Destination One',
        targetModelId: 'model-a',
        targetModelName: 'Model A',
      },
      {
        id: 'target-b',
        destinationInstanceId: 'dest-1',
        destinationLabel: 'Destination One',
        targetModelId: 'model-b',
        targetModelName: 'Model B',
      },
    ],
    steps: [
      {
        targetId: 'target-a',
        destinationId: 'dest-1',
        destinationLabel: 'Destination One',
        targetModelId: 'model-a',
        kind: 'import',
        documentId: 'doc-1',
        warnings: ['Model A warning'],
      },
      {
        targetId: 'target-b',
        destinationId: 'dest-1',
        destinationLabel: 'Destination One',
        targetModelId: 'model-b',
        kind: 'import',
        documentId: 'doc-1',
      },
    ],
  };

  const summaries = summarizePlanByTarget(plan);

  assert.equal(summaries.length, 2);
  assert.equal(summaries[0].steps.length, 1);
  assert.equal(summaries[0].warningCount, 1);
  assert.equal(summaries[1].steps.length, 1);
  assert.equal(summaries[1].warningCount, 0);
});

test('per-target preflight plans merge into one runnable plan', () => {
  const basePlan: MigrationPlan = {
    sourceId: 'source-1',
    sourceLabel: 'Source',
    destinationIds: ['dest-1'],
    documentIds: ['doc-1'],
    emptyFirst: false,
    replaceSameNamed: true,
    targets: [{
      id: 'target-a',
      destinationInstanceId: 'dest-1',
      destinationLabel: 'Destination One',
      targetModelId: 'model-a',
      targetModelName: 'Model A',
    }],
    steps: [{
      targetId: 'target-a',
      destinationId: 'dest-1',
      destinationLabel: 'Destination One',
      targetModelId: 'model-a',
      kind: 'import',
      documentId: 'doc-1',
    }],
  };
  const secondPlan: MigrationPlan = {
    ...basePlan,
    destinationIds: ['dest-2'],
    targets: [{
      id: 'target-b',
      destinationInstanceId: 'dest-2',
      destinationLabel: 'Destination Two',
      targetModelId: 'model-b',
      targetModelName: 'Model B',
    }],
    steps: [{
      targetId: 'target-b',
      destinationId: 'dest-2',
      destinationLabel: 'Destination Two',
      targetModelId: 'model-b',
      kind: 'import',
      documentId: 'doc-1',
      warnings: ['Missing optional field'],
    }],
  };

  const merged = combineMigrationPlans([basePlan, secondPlan]);

  assert.ok(merged);
  assert.deepEqual(merged.destinationIds, ['dest-1', 'dest-2']);
  assert.equal(merged.targets.length, 2);
  assert.equal(merged.steps.length, 2);
  assert.deepEqual(preflightRowsFromPlan(merged).map((row) => row.status), ['ready', 'warning']);
});

test('removing a blocked target preserves the successful preflight plan', () => {
  const plan: MigrationPlan = {
    sourceId: 'source-1',
    sourceLabel: 'Source',
    destinationIds: ['dest-1', 'dest-2'],
    documentIds: ['doc-1'],
    emptyFirst: true,
    replaceSameNamed: true,
    targets: [
      {
        id: 'target-a',
        destinationInstanceId: 'dest-1',
        destinationLabel: 'Destination One',
        targetModelId: 'model-a',
      },
      {
        id: 'target-b',
        destinationInstanceId: 'dest-2',
        destinationLabel: 'Destination Two',
        targetModelId: 'model-b',
      },
    ],
    steps: [
      {
        targetId: 'target-a',
        destinationId: 'dest-1',
        destinationLabel: 'Destination One',
        targetModelId: 'model-a',
        kind: 'delete',
        documentId: 'old-doc',
      },
      {
        targetId: 'target-b',
        destinationId: 'dest-2',
        destinationLabel: 'Destination Two',
        targetModelId: 'model-b',
        kind: 'import',
        documentId: 'doc-1',
      },
    ],
  };

  const filtered = removeTargetFromMigrationPlan(plan, 'target-b');

  assert.ok(filtered);
  assert.deepEqual(filtered.destinationIds, ['dest-1']);
  assert.deepEqual(filtered.targets.map((target) => target.id), ['target-a']);
  assert.deepEqual(filtered.steps.map((step) => step.targetId), ['target-a']);
});

test('duration estimator uses one source export lane plus the slowest destination lane', () => {
  const plan: MigrationPlan = {
    sourceId: 'source-1',
    sourceLabel: 'Source',
    destinationIds: ['dest-1', 'dest-2'],
    documentIds: ['doc-1', 'doc-2'],
    emptyFirst: false,
    replaceSameNamed: true,
    targets: [],
    steps: [
      { destinationId: 'dest-1', destinationLabel: 'D1', kind: 'export', documentId: 'doc-1' },
      { destinationId: 'dest-2', destinationLabel: 'D2', kind: 'export', documentId: 'doc-1' },
      { destinationId: 'dest-1', destinationLabel: 'D1', kind: 'export', documentId: 'doc-2' },
      { destinationId: 'dest-1', destinationLabel: 'D1', kind: 'import', documentId: 'doc-1' },
      { destinationId: 'dest-1', destinationLabel: 'D1', kind: 'metadata', documentId: 'doc-1' },
      { destinationId: 'dest-2', destinationLabel: 'D2', kind: 'import', documentId: 'doc-1' },
    ],
  };

  assert.equal(estimateDurationSeconds(plan), 5);
});

test('preflight summaries count same-name replacements separately from deletes', () => {
  const plan: MigrationPlan = {
    sourceId: 'source-1',
    sourceLabel: 'Source',
    destinationIds: ['dest-1'],
    documentIds: ['doc-1'],
    emptyFirst: false,
    replaceSameNamed: true,
    targets: [{
      id: 'target-a',
      destinationInstanceId: 'dest-1',
      destinationLabel: 'Destination One',
      targetModelId: 'model-a',
      targetModelName: 'Model A',
    }],
    steps: [
      {
        targetId: 'target-a',
        destinationId: 'dest-1',
        destinationLabel: 'Destination One',
        targetModelId: 'model-a',
        kind: 'delete',
        documentId: 'doc-existing',
        documentName: 'Executive Scorecard',
        replacement: true,
      },
      {
        targetId: 'target-a',
        destinationId: 'dest-1',
        destinationLabel: 'Destination One',
        targetModelId: 'model-a',
        kind: 'import',
        documentId: 'doc-1',
        documentName: 'Executive Scorecard',
      },
    ],
  };

  const [summary] = summarizePlanByTarget(plan);

  assert.equal(summary.deleteCount, 1);
  assert.equal(summary.replaceCount, 1);
});

test('fan-out draft persists schema refresh option without credential fields', () => {
  const draft: FanoutDraft = {
    step: 1,
    sourceId: 'source-1',
    sourceModelId: 'model-source',
    selectedDocumentIds: ['doc-1'],
    sourceFolderId: 'source-folder-1',
    sourceFolderPath: 'Shared/Dashboards',
    targets: [{
      id: 'target-1',
      destinationInstanceId: 'dest-1',
      targetModelId: 'model-target',
      targetModelName: 'Target Model',
      targetFolderPath: 'Shared/Migrated',
      targetFolderId: 'folder-1',
      selectedActionIndexes: [0],
    }],
    emptyFirst: false,
    replaceSameNamed: true,
    metadataOnly: false,
    refreshSchemaAfterImport: true,
  };

  const sanitized = sanitizeFanoutDraftForStorage(draft);

  assert.equal(sanitized.refreshSchemaAfterImport, true);
  assert.equal(sanitized.replaceSameNamed, true);
  assert.equal(sanitized.sourceFolderPath, 'Shared/Dashboards');
  assert.equal(JSON.stringify(sanitized).includes('apiKey'), false);
});
