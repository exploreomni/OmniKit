import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  applySelectedSourceModelFallback,
  buildDashboardTopicMappings,
  buildRouteGroupsBySourceScope,
  buildSchemaRefreshActionsForTargets,
  buildTargetFolderOptions,
  buildTargetModelOptions,
  canContinueFromSourceStep,
  cleanDashboardModelMetadata,
  combineMigrationPlans,
  collectDashboardSourceTopics,
  estimateDurationSeconds,
  dashboardDocumentModelLabel,
  dashboardMigrationReviewImpactSummary,
  dashboardDestinationsEmptyState,
  dashboardGroupSelectionAriaLabel,
  dashboardSelectionAriaLabel,
  dashboardSelectionEmptyState,
  destinationInstanceSelectionAriaLabel,
  mixedRouteGroupSourceScopeMessage,
  getDashboardLoadBlockReason,
  getDashboardMigrationPreflightBlockReason,
  preflightRowsFromPlan,
  preserveSelectedDocumentIds,
  preflightRouteGroupsFromPlan,
  removeTargetFromMigrationPlan,
  routeTopicActionSummariesFromSteps,
  summarizePlanByTarget,
  TARGET_FOLDER_COMBOBOX_CONFIG,
  TARGET_MODEL_COMBOBOX_CONFIG,
} from '../src/components/dashboardMigration/dashboardMigrationUtils';
import {
  createDashboardMigrationTargetDraft,
  routeGroupDraftToMigrationRouteGroup,
  targetDraftToMigrationTarget,
  type DashboardMigrationDraft,
} from '../src/components/dashboardMigration/dashboardMigrationTypes';
import { sanitizeDashboardMigrationDraftForStorage } from '../src/components/dashboardMigration/dashboardMigrationStorage';
import {
  comboBoxEmptyText,
  filterComboBoxOptions,
  resolveComboBoxDisplay,
} from '../src/components/ui/comboBoxUtils';
import type { MigrationPlan, SavedInstancePublic } from '../src/services/opsConsole';
import {
  dashboardMatchesSearch,
  filterFolderTree,
  instanceMatchesSearch,
  sortDocuments,
  sortModels,
} from '../src/utils/catalogSort';

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
    targetConnectionId: 'connection-1',
    targetModelId: 'model-1',
    targetModelName: 'Executive Model',
    targetFolderPath: 'Executive/Migrated',
    targetFolderId: 'folder-1',
  }, [destination]);

  assert.equal(target.destinationLabel, 'Destination One');
  assert.equal(target.targetConnectionId, 'connection-1');
  assert.equal(target.targetModelId, 'model-1');
  assert.equal(target.targetFolderPath, 'Executive/Migrated');
  assert.deepEqual(target.topicMappings, []);
  assert.equal(JSON.stringify(target).includes('omni****1234'), false);
});

test('target drafts convert topic mappings to migration targets with target connection audit fields', () => {
  const target = targetDraftToMigrationTarget({
    id: 'target-1',
    destinationInstanceId: destination.id,
    targetConnectionId: 'connection-1',
    targetModelId: 'model-1',
    targetModelName: 'Executive Model',
    targetFolderPath: 'Executive/Migrated',
    targetFolderId: 'folder-1',
    topicMappings: [
      {
        sourceTopicName: 'orders_topic',
        sourceTopicId: 'orders_topic',
        action: 'copy_source',
        targetTopicName: 'orders_topic',
      },
      {
        sourceTopicName: 'ignored_topic',
        action: 'unresolved',
        targetTopicName: '',
      },
    ],
  }, [destination]);

  assert.equal(target.targetConnectionId, 'connection-1');
  assert.deepEqual(target.topicMappings, [{
    sourceTopicName: 'orders_topic',
    sourceTopicId: 'orders_topic',
    action: 'copy_source',
    targetTopicName: 'orders_topic',
    targetTopicLabel: undefined,
  }]);
});

test('dashboard migration target rows allow repeated instances with different connections', () => {
  const second = targetDraftToMigrationTarget({
    id: 'target-2',
    destinationInstanceId: destination.id,
    targetConnectionId: 'connection-2',
    targetModelId: 'model-2',
    targetModelName: 'Finance Model',
    targetFolderPath: 'Finance/Migrated',
    targetFolderId: 'folder-2',
  }, [destination]);

  assert.equal(second.destinationInstanceId, destination.id);
  assert.equal(second.targetConnectionId, 'connection-2');
  assert.equal(second.id, 'target-2');
});

test('dashboard migration target draft creation supports bulk instance setup and repeated rows', () => {
  const first = createDashboardMigrationTargetDraft('target-1', {
    id: destination.id,
    defaultFolderId: 'folder-default',
    defaultFolderPath: 'Shared/Migrated',
  });
  const repeated = createDashboardMigrationTargetDraft('target-2', {
    id: destination.id,
    defaultFolderId: 'folder-default',
    defaultFolderPath: 'Shared/Migrated',
  });
  const other = createDashboardMigrationTargetDraft('target-3', {
    id: 'dest-2',
    defaultFolderId: '',
    defaultFolderPath: '',
  });

  assert.deepEqual(
    [first, repeated, other].map((target) => target.destinationInstanceId),
    [destination.id, destination.id, 'dest-2'],
  );
  assert.equal(first.targetFolderPath, 'Shared/Migrated');
  assert.equal(repeated.id, 'target-2');
  assert.equal(other.targetFolderPath, '');
});

test('dashboard migration route groups compile dashboard and target membership with scoped topic mappings', () => {
  const targetRows = [
    {
      id: 'target-1',
      destinationInstanceId: destination.id,
      targetConnectionId: 'connection-1',
      targetModelId: 'model-1',
      targetModelName: 'Executive Model',
      targetFolderPath: 'Executive/Migrated',
      targetFolderId: 'folder-1',
    },
    {
      id: 'target-2',
      destinationInstanceId: destination.id,
      targetConnectionId: 'connection-2',
      targetModelId: 'model-2',
      targetModelName: 'Finance Model',
      targetFolderPath: 'Finance/Migrated',
      targetFolderId: 'folder-2',
    },
  ];

  const group = routeGroupDraftToMigrationRouteGroup({
    id: 'route-1',
    name: 'Orders topic',
    documentIds: ['dashboard-1', 'dashboard-1'],
    targetRowIds: ['target-2'],
    topicMappingsByTargetId: {
      'target-2': [{
        sourceTopicName: 'orders_topic',
        sourceTopicId: 'orders_topic',
        action: 'copy_source',
        targetTopicName: 'orders_topic_copy',
      }],
    },
  }, targetRows, [destination]);

  assert.deepEqual(group.documentIds, ['dashboard-1']);
  assert.deepEqual(group.targets.map((target) => target.id), ['target-2']);
  assert.deepEqual(group.targets[0].topicMappings, [{
    sourceTopicName: 'orders_topic',
    sourceTopicId: 'orders_topic',
    action: 'copy_source',
    targetTopicName: 'orders_topic_copy',
    targetTopicLabel: undefined,
  }]);
});

test('dashboard migration route groups do not inherit stale target-level topic mappings', () => {
  const [target] = routeGroupDraftToMigrationRouteGroup({
    id: 'route-1',
    name: 'Orders topic',
    documentIds: ['dashboard-1'],
    targetRowIds: ['target-1'],
  }, [{
    id: 'target-1',
    destinationInstanceId: destination.id,
    targetConnectionId: 'connection-1',
    targetModelId: 'model-1',
    targetModelName: 'Executive Model',
    targetFolderPath: 'Executive/Migrated',
    targetFolderId: 'folder-1',
    topicMappings: [{
      sourceTopicName: 'stale_topic',
      sourceTopicId: 'stale_topic',
      action: 'copy_source',
      targetTopicName: 'stale_topic',
    }],
  }], [destination]).targets;

  assert.deepEqual(target.topicMappings, []);
});

test('dashboard migration route grouping detects source model and topic boundaries', () => {
  const documents = [
    {
      id: 'doc-1',
      identifier: 'doc-1',
      name: 'Orders Dashboard',
      baseModelId: 'model-orders',
      baseModelName: 'Orders Model',
      topicNames: ['orders_topic'],
      topicIds: ['orders_topic'],
    },
    {
      id: 'doc-2',
      identifier: 'doc-2',
      name: 'Finance Dashboard',
      baseModelId: 'model-finance',
      baseModelName: 'Finance Model',
      topicNames: ['finance_topic'],
      topicIds: ['finance_topic'],
    },
  ];

  const groups = buildRouteGroupsBySourceScope(documents, ['doc-1', 'doc-2'], ['target-1']);

  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((group) => group.documentIds), [['doc-1'], ['doc-2']]);
  assert.equal(
    mixedRouteGroupSourceScopeMessage({ name: 'Mixed group', documentIds: ['doc-1', 'doc-2'] }, documents),
    'Split dashboard group Mixed group by source model/topic before review.',
  );
  assert.equal(mixedRouteGroupSourceScopeMessage(groups[0], documents), '');
});

test('schema refresh actions are generated once per target row', () => {
  const targets = [
    targetDraftToMigrationTarget({
      id: 'target-1',
      destinationInstanceId: destination.id,
      targetConnectionId: 'connection-1',
      targetModelId: 'model-1',
      targetModelName: 'Executive Model',
      targetFolderPath: 'Executive/Migrated',
      targetFolderId: 'folder-1',
    }, [destination]),
    targetDraftToMigrationTarget({
      id: 'target-2',
      destinationInstanceId: destination.id,
      targetConnectionId: 'connection-2',
      targetModelId: 'model-2',
      targetModelName: 'Finance Model',
      targetFolderPath: 'Finance/Migrated',
      targetFolderId: 'folder-2',
    }, [destination]),
  ];

  const actions = buildSchemaRefreshActionsForTargets(targets, [destination], true);

  assert.equal(actions.length, 2);
  assert.deepEqual(actions.map((action) => action.targetModelId), ['model-1', 'model-2']);
  assert.deepEqual(actions.map((action) => action.destinationInstanceId), [destination.id, destination.id]);
});

test('dashboard migration document model label prefers enriched metadata and never surfaces unknown placeholders', () => {
  const names = new Map([['model-1', 'Coffee Model']]);

  assert.equal(cleanDashboardModelMetadata('Unknown'), undefined);
  assert.deepEqual(
    dashboardDocumentModelLabel({ baseModelId: 'model-1', baseModelName: 'Unknown' }, names),
    { label: 'Coffee Model', detected: true },
  );
  assert.deepEqual(
    dashboardDocumentModelLabel({ baseModelId: 'Unknown', baseModelName: 'Model not detected' }, names),
    { label: 'Model unavailable from export', detected: false },
  );
});

test('dashboard migration source topic helpers support multiple topics and exact-name auto mapping', () => {
  const sourceTopics = collectDashboardSourceTopics([
    {
      topicNames: ['superstar_lab', 'team_forecast_lab'],
      topicIds: ['superstar_lab', 'team_forecast_lab'],
    },
    {
      topicNames: ['superstar_lab'],
      topicIds: ['superstar_lab'],
    },
  ]);

  assert.deepEqual(sourceTopics, [
    { name: 'superstar_lab', id: 'superstar_lab' },
    { name: 'team_forecast_lab', id: 'team_forecast_lab' },
  ]);

  const mappings = buildDashboardTopicMappings(sourceTopics, [
    { name: 'superstar_lab', label: 'Superstar Lab' },
    { name: 'other_topic', label: 'Other Topic' },
  ]);

  assert.equal(mappings[0].action, 'map_existing');
  assert.equal(mappings[0].targetTopicName, 'superstar_lab');
  assert.equal(mappings[1].action, 'copy_source');
  assert.equal(mappings[1].targetTopicName, 'team_forecast_lab');
  assert.equal(mappings[1].status, 'ready');
});

test('dashboard migration topic helper preserves explicit create-new choices for missing topics', () => {
  const [mapping] = buildDashboardTopicMappings(
    [{ name: 'missing_topic', id: 'missing_topic' }],
    [],
    [{
      sourceTopicName: 'missing_topic',
      sourceTopicId: 'missing_topic',
      action: 'copy_source',
      targetTopicName: 'missing_topic',
    }],
  );

  assert.equal(mapping.action, 'copy_source');
  assert.equal(mapping.targetTopicName, 'missing_topic');
  assert.equal(mapping.status, 'ready');
});

test('dashboard migration topic helper blocks create-new topic name collisions', () => {
  const [mapping] = buildDashboardTopicMappings(
    [{ name: 'orders_topic', id: 'orders_topic' }],
    [{ name: 'orders_topic', label: 'Orders Topic' }],
    [{
      sourceTopicName: 'orders_topic',
      sourceTopicId: 'orders_topic',
      action: 'copy_source',
      targetTopicName: 'orders_topic',
    }],
  );

  assert.equal(mapping.action, 'copy_source');
  assert.equal(mapping.targetTopicName, 'orders_topic');
  assert.equal(mapping.status, 'blocked');
  assert.match(mapping.warnings?.[0] || '', /already exists/);
});

test('dashboard migration topic helper keeps blank create-new names blocked', () => {
  const [mapping] = buildDashboardTopicMappings(
    [{ name: 'orders_topic', id: 'orders_topic' }],
    [],
    [{
      sourceTopicName: 'orders_topic',
      sourceTopicId: 'orders_topic',
      action: 'copy_source',
      targetTopicName: '',
    }],
  );

  assert.equal(mapping.action, 'copy_source');
  assert.equal(mapping.targetTopicName, '');
  assert.equal(mapping.status, 'blocked');
  assert.match(mapping.warnings?.[0] || '', /Enter a target topic name/);
});

test('dashboard migration review summarizes topic actions per route and dashboard', () => {
  const summaries = routeTopicActionSummariesFromSteps([
    {
      routeGroupId: 'route-orders',
      routeGroupName: 'Orders route',
      targetId: 'target-1',
      destinationId: 'dest-1',
      destinationLabel: 'Destination One',
      kind: 'topic_prepare',
      documentId: 'orders-dashboard',
      documentName: 'Orders Dashboard',
      details: {
        topicMappings: [{
          sourceTopicName: 'orders_topic',
          sourceTopicId: 'orders_topic',
          action: 'copy_source',
          targetTopicName: 'orders_topic_copy',
        }],
      },
    },
    {
      routeGroupId: 'route-orders',
      routeGroupName: 'Orders route',
      targetId: 'target-1',
      destinationId: 'dest-1',
      destinationLabel: 'Destination One',
      kind: 'import',
      documentId: 'orders-dashboard',
      documentName: 'Orders Dashboard',
      details: {
        topicMappings: [{
          sourceTopicName: 'orders_topic',
          sourceTopicId: 'orders_topic',
          action: 'copy_source',
          targetTopicName: 'orders_topic_copy',
        }],
      },
    },
    {
      routeGroupId: 'route-finance',
      routeGroupName: 'Finance route',
      targetId: 'target-1',
      destinationId: 'dest-1',
      destinationLabel: 'Destination One',
      kind: 'metadata',
      documentId: 'finance-dashboard',
      documentName: 'Finance Dashboard',
    },
  ]);

  assert.equal(summaries.length, 1);
  assert.equal(summaries[0].routeGroupName, 'Orders route');
  assert.equal(summaries[0].documentName, 'Orders Dashboard');
  assert.deepEqual(summaries[0].topicMappings.map((mapping) => `${mapping.action}:${mapping.sourceTopicName}->${mapping.targetTopicName}`), [
    'copy_source:orders_topic->orders_topic_copy',
  ]);
});

test('dashboard migration source model fallback enriches scoped documents without mislabeling out-of-folder rows', () => {
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
  assert.deepEqual(dashboardDocumentModelLabel(documents[0]), {
    label: 'ATX - Coffee Shop Demo',
    detected: true,
  });
  assert.equal(documents[1].baseModelId, undefined);
  assert.deepEqual(dashboardDocumentModelLabel(documents[1]), {
    label: 'Model unavailable from export',
    detected: false,
  });
});

test('dashboard migration source model fallback preserves export metadata and only applies to unambiguous single rows without folder scope', () => {
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

test('dashboard migration preflight blocker returns actionable reasons and clears when ready', () => {
  const readyInput = {
    sourceId: 'source-1',
    sourceConnectionId: 'source-connection',
    selectedDocumentIds: ['doc-1'],
    targets: [{
      destinationInstanceId: 'dest-1',
      destinationLabel: 'Destination One',
      targetConnectionId: 'target-connection',
      targetModelId: 'model-1',
      targetFolderPath: 'Shared/Migrated',
    }],
    hasLoadingTargets: false,
    hasInvalidTargetModel: false,
    hasUnresolvedFolderTargets: false,
    hasUnresolvedTopicMappings: false,
    preflightLoading: false,
    jobBusy: false,
  };

  assert.equal(getDashboardMigrationPreflightBlockReason({ ...readyInput, sourceId: '' }), 'Choose a source instance before checking readiness.');
  assert.equal(getDashboardMigrationPreflightBlockReason({ ...readyInput, sourceConnectionId: '' }), 'Choose a source connection before checking readiness.');
  assert.equal(getDashboardMigrationPreflightBlockReason({ ...readyInput, selectedDocumentIds: [] }), 'Select at least one source dashboard before checking readiness.');
  assert.equal(getDashboardMigrationPreflightBlockReason({ ...readyInput, targets: [] }), 'Add at least one destination before checking readiness.');
  assert.equal(getDashboardMigrationPreflightBlockReason({ ...readyInput, hasLoadingTargets: true }), 'Wait for destination connection, model, and folder catalogs to finish loading.');
  assert.equal(
    getDashboardMigrationPreflightBlockReason({
      ...readyInput,
      targets: [{ ...readyInput.targets[0], targetConnectionId: '' }],
    }),
    'Choose a destination connection for Destination One.',
  );
  assert.equal(
    getDashboardMigrationPreflightBlockReason({
      ...readyInput,
      targets: [{ ...readyInput.targets[0], targetModelId: '' }],
    }),
    'Choose a destination model for Destination One.',
  );
  assert.equal(
    getDashboardMigrationPreflightBlockReason({ ...readyInput, hasInvalidTargetModel: true }),
    'Choose a destination model from the selected connection catalog.',
  );
  assert.equal(getDashboardMigrationPreflightBlockReason({ ...readyInput, hasUnresolvedFolderTargets: true }), 'Choose a folder path for saved folder IDs before checking readiness.');
  assert.equal(
    getDashboardMigrationPreflightBlockReason({
      ...readyInput,
      hasUnresolvedTopicMappings: true,
      unresolvedTopicMappingMessage: 'Resolve topic mapping for nfl_mvp on Destination One.',
    }),
    'Resolve topic mapping for nfl_mvp on Destination One.',
  );
  assert.equal(getDashboardMigrationPreflightBlockReason(readyInput), '');
});

test('dashboard load blocker requires source instance and connection only', () => {
  const readyInput = {
    sourceId: 'source-1',
    sourceConnectionId: 'source-connection',
    loadingDocuments: false,
    loadingSourceModels: false,
  };

  assert.equal(getDashboardLoadBlockReason({ ...readyInput, sourceId: '' }), 'Choose a source instance before loading dashboards.');
  assert.equal(getDashboardLoadBlockReason({ ...readyInput, sourceConnectionId: '' }), 'Choose a source connection before loading dashboards.');
  assert.equal(getDashboardLoadBlockReason({ ...readyInput, loadingDocuments: true }), 'Dashboards are already loading.');
  assert.equal(getDashboardLoadBlockReason({ ...readyInput, loadingSourceModels: true }), 'Wait for source models to finish loading.');
  assert.equal(getDashboardLoadBlockReason(readyInput), '');
});

test('dashboard migration accessible labels stay concise and descriptive', () => {
  assert.equal(dashboardSelectionAriaLabel({
    name: 'NFL MVP Analytics',
    identifier: 'nfl-superstar-team-motion-lab-v34',
    folderPath: 'just-for-fun',
    baseModelName: 'ATX - NFL Big Data Bowl Demo',
    baseModelId: 'model-1',
  }), 'Select dashboard NFL MVP Analytics from just-for-fun using ATX - NFL Big Data Bowl Demo');
  assert.equal(destinationInstanceSelectionAriaLabel({
    label: 'ATX Demo',
    baseUrl: 'https://atx.playground.exploreomni.dev',
  }, 1), 'Select ATX Demo as a destination on atx.playground.exploreomni.dev, 1 destination already configured');
  assert.equal(dashboardGroupSelectionAriaLabel({
    name: 'Coffee Shop Demo',
    folderPath: '',
  }, 'All selected dashboards'), 'Select dashboard Coffee Shop Demo from My Documents/default for dashboard group All selected dashboards');
});

test('dashboard migration empty-state copy suggests the next action', () => {
  assert.equal(dashboardSelectionEmptyState({
    loading: true,
    hasSourceConnection: true,
    hasLoadedDashboards: false,
    totalCount: 0,
    visibleCount: 0,
  }), 'Finding dashboards for this connection...');
  assert.equal(dashboardSelectionEmptyState({
    loading: false,
    hasSourceConnection: false,
    hasLoadedDashboards: false,
    totalCount: 0,
    visibleCount: 0,
  }), 'Choose a source instance and connection, then load dashboards.');
  assert.equal(dashboardSelectionEmptyState({
    loading: false,
    hasSourceConnection: true,
    hasLoadedDashboards: true,
    totalCount: 0,
    visibleCount: 0,
  }), 'No dashboards found for this connection. Try a different source connection.');
  assert.equal(dashboardSelectionEmptyState({
    loading: false,
    hasSourceConnection: true,
    hasLoadedDashboards: true,
    totalCount: 2,
    visibleCount: 0,
  }), 'No dashboards match the current filters. Clear filters or search for another dashboard.');
  assert.equal(dashboardDestinationsEmptyState(0), 'No destination instances are available. Add or unlock saved instances before continuing.');
  assert.equal(dashboardDestinationsEmptyState(2), 'No destinations selected yet. Choose one or more instances above, or add a blank destination.');
});

test('target ComboBox helpers filter catalogs, preserve unknown values, and keep target-specific free-text rules', () => {
  const modelOptions = buildTargetModelOptions([
    { id: 'model-2', name: '', identifier: 'fallback-model', kind: 'workbook' },
    { id: 'model-1', name: 'Coffee Model', identifier: 'coffee-model', connectionName: 'PROD', kind: 'shared' },
  ]);
  const folderOptions = buildTargetFolderOptions([
    { id: 'folder-2', name: 'Sandbox', identifier: 'sandbox-folder' },
    { id: 'folder-1', name: 'Migrated', path: 'Shared/Migrated' },
  ]);

  assert.equal(TARGET_MODEL_COMBOBOX_CONFIG.allowFreeText, false);
  assert.equal(TARGET_FOLDER_COMBOBOX_CONFIG.allowFreeText, true);
  assert.deepEqual(modelOptions.map((option) => option.label), ['fallback-model', 'PROD - Coffee Model']);
  assert.deepEqual(folderOptions.map((option) => option.value), ['sandbox-folder', 'Shared/Migrated']);
  assert.deepEqual(filterComboBoxOptions(modelOptions, 'coffee').map((option) => option.value), ['model-1']);
  assert.deepEqual(filterComboBoxOptions(modelOptions, 'prod').map((option) => option.value), ['model-1']);
  assert.deepEqual(filterComboBoxOptions(modelOptions, 'workbook').map((option) => option.value), ['model-2']);
  assert.deepEqual(filterComboBoxOptions(modelOptions, 'fallback').map((option) => option.value), ['model-2']);
  assert.deepEqual(filterComboBoxOptions(folderOptions, 'Shared').map((option) => option.value), ['Shared/Migrated']);
  assert.deepEqual(resolveComboBoxDisplay(modelOptions, 'model-not-in-catalog'), {
    selectedLabel: 'model-not-in-catalog',
    showIdBelowLabel: false,
  });
  assert.deepEqual(resolveComboBoxDisplay(modelOptions, 'model-1'), {
    selectedLabel: 'PROD - Coffee Model',
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

test('catalog helpers sort and search large migration catalogs consistently', () => {
  assert.deepEqual(sortModels([
    { id: 'z', name: 'Orders', connectionName: 'UAT' },
    { id: 'a', name: 'Orders', connectionName: 'PROD' },
    { id: 'm', name: 'Coffee' },
  ]).map((model) => model.id), ['m', 'a', 'z']);

  assert.deepEqual(sortDocuments([
    { id: '2', identifier: 'dash-2', name: 'Zebra Dashboard' },
    { id: '1', identifier: 'dash-1', name: 'Alpha Dashboard', baseModelName: 'Coffee Model', labels: ['Certified'] },
  ]).map((document) => document.id), ['1', '2']);

  assert.equal(dashboardMatchesSearch({
    id: 'dash-1',
    name: 'Alpha Dashboard',
    baseModelName: 'Coffee Model',
    folderPath: 'Executive',
    labels: ['Certified'],
  }, 'coffee'), true);
  assert.equal(dashboardMatchesSearch({
    id: 'dash-1',
    name: 'Alpha Dashboard',
    labels: [{ name: 'Certified' }],
  }, 'certified'), true);
  assert.equal(dashboardMatchesSearch({
    id: 'dash-1',
    name: 'Alpha Dashboard',
    topicNames: ['nfl_mvp'],
    topicIds: ['topic-1'],
  }, 'topic-1'), true);
  assert.equal(instanceMatchesSearch({
    id: 'dest-prod',
    label: 'Production',
    baseUrl: 'https://prod.example.omniapp.co',
    defaultModelId: 'prod-model',
  }, 'prod'), true);

  const filteredFolders = filterFolderTree([
    {
      id: 'root-z',
      name: 'Z Root',
      children: [{ id: 'child-prod', name: 'Prod Dashboards', path: 'Z Root/Prod Dashboards' }],
    },
    { id: 'root-a', name: 'A Root' },
  ], 'prod');

  assert.deepEqual(filteredFolders.map((folder) => folder.id), ['root-z']);
  assert.deepEqual(filteredFolders[0].children?.map((folder) => folder.id), ['child-prod']);
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
    deleteSourceOnSuccess: false,
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

test('dashboard migration review summaries group preflight by route then target', () => {
  const plan: MigrationPlan = {
    sourceId: 'source-1',
    sourceLabel: 'Source',
    destinationIds: ['dest-1'],
    documentIds: ['orders-dashboard', 'finance-dashboard'],
    emptyFirst: false,
    replaceSameNamed: true,
    deleteSourceOnSuccess: true,
    targets: [{
      id: 'target-a',
      destinationInstanceId: 'dest-1',
      destinationLabel: 'Destination One',
      targetConnectionId: 'target-connection',
      targetModelId: 'model-a',
      targetModelName: 'Model A',
      targetFolderPath: 'Shared/Migrated',
    }],
    routeGroups: [
      {
        id: 'route-orders',
        name: 'Orders route',
        documentIds: ['orders-dashboard'],
        targets: [{
          id: 'target-a',
          destinationInstanceId: 'dest-1',
          destinationLabel: 'Destination One',
          targetConnectionId: 'target-connection',
          targetModelId: 'model-a',
          targetModelName: 'Model A',
          targetFolderPath: 'Shared/Migrated',
        }],
      },
      {
        id: 'route-finance',
        name: 'Finance route',
        documentIds: ['finance-dashboard'],
        targets: [{
          id: 'target-a',
          destinationInstanceId: 'dest-1',
          destinationLabel: 'Destination One',
          targetConnectionId: 'target-connection',
          targetModelId: 'model-a',
          targetModelName: 'Model A',
          targetFolderPath: 'Shared/Migrated',
        }],
      },
    ],
    steps: [
      {
        routeGroupId: 'route-orders',
        routeGroupName: 'Orders route',
        targetId: 'target-a',
        destinationId: 'dest-1',
        destinationLabel: 'Destination One',
        targetConnectionId: 'target-connection',
        targetModelId: 'model-a',
        targetModelName: 'Model A',
        targetFolderPath: 'Shared/Migrated',
        kind: 'delete',
        documentId: 'existing-orders-dashboard',
        documentName: 'Orders Dashboard',
        replacement: true,
      },
      {
        routeGroupId: 'route-orders',
        routeGroupName: 'Orders route',
        targetId: 'target-a',
        destinationId: 'dest-1',
        destinationLabel: 'Destination One',
        targetConnectionId: 'target-connection',
        targetModelId: 'model-a',
        targetModelName: 'Model A',
        targetFolderPath: 'Shared/Migrated',
        kind: 'topic_prepare',
        documentId: 'orders-dashboard',
        documentName: 'Orders Dashboard',
        details: {
          topicMappings: [{
            sourceTopicName: 'orders_topic',
            sourceTopicId: 'orders_topic',
            action: 'copy_source',
            targetTopicName: 'orders_topic_copy',
          }],
        },
      },
      {
        routeGroupId: 'route-orders',
        routeGroupName: 'Orders route',
        targetId: 'target-a',
        destinationId: 'dest-1',
        destinationLabel: 'Destination One',
        targetConnectionId: 'target-connection',
        targetModelId: 'model-a',
        targetModelName: 'Model A',
        targetFolderPath: 'Shared/Migrated',
        kind: 'import',
        documentId: 'orders-dashboard',
        documentName: 'Orders Dashboard',
        warnings: ['Review calculated field compatibility.'],
      },
      {
        routeGroupId: 'route-finance',
        routeGroupName: 'Finance route',
        targetId: 'target-a',
        destinationId: 'dest-1',
        destinationLabel: 'Destination One',
        targetConnectionId: 'target-connection',
        targetModelId: 'model-a',
        targetModelName: 'Model A',
        targetFolderPath: 'Shared/Migrated',
        kind: 'import',
        documentId: 'finance-dashboard',
        documentName: 'Finance Dashboard',
        blocked: true,
        error: 'Dashboard import is blocked until topic mappings are resolved.',
      },
    ],
  };

  const routes = preflightRouteGroupsFromPlan(plan);

  assert.deepEqual(routes.map((route) => route.name), ['Orders route', 'Finance route']);
  assert.equal(routes[0].dashboardCount, 1);
  assert.equal(routes[0].targetCount, 1);
  assert.equal(routes[0].replaceCount, 1);
  assert.equal(routes[0].topicActionCount, 1);
  assert.equal(routes[0].status, 'warning');
  assert.equal(routes[0].targets[0].target.targetConnectionId, 'target-connection');
  assert.equal(routes[0].targets[0].topicActions[0].topicMappings[0].targetTopicName, 'orders_topic_copy');
  assert.equal(routes[1].status, 'blocked');
  assert.match(routes[1].error || '', /topic mappings/);
});

test('dashboard migration review impact summary explains migration before route details', () => {
  const plan: MigrationPlan = {
    sourceId: 'source-1',
    sourceLabel: 'Source',
    destinationIds: ['dest-1'],
    documentIds: ['orders-dashboard', 'finance-dashboard'],
    emptyFirst: false,
    replaceSameNamed: true,
    deleteSourceOnSuccess: false,
    targets: [{
      id: 'target-a',
      destinationInstanceId: 'dest-1',
      destinationLabel: 'Destination One',
      targetConnectionId: 'target-connection',
      targetModelId: 'model-a',
      targetModelName: 'Model A',
      targetFolderPath: 'Shared/Migrated',
    }],
    routeGroups: [{
      id: 'route-orders',
      name: 'Orders route',
      documentIds: ['orders-dashboard', 'finance-dashboard'],
      targets: [{
        id: 'target-a',
        destinationInstanceId: 'dest-1',
        destinationLabel: 'Destination One',
        targetConnectionId: 'target-connection',
        targetModelId: 'model-a',
        targetModelName: 'Model A',
        targetFolderPath: 'Shared/Migrated',
      }],
    }],
    steps: [
      {
        routeGroupId: 'route-orders',
        routeGroupName: 'Orders route',
        targetId: 'target-a',
        destinationId: 'dest-1',
        destinationLabel: 'Destination One',
        targetConnectionId: 'target-connection',
        targetModelId: 'model-a',
        targetModelName: 'Model A',
        targetFolderPath: 'Shared/Migrated',
        kind: 'delete',
        documentId: 'existing-orders-dashboard',
        documentName: 'Orders Dashboard',
        replacement: true,
      },
      {
        routeGroupId: 'route-orders',
        routeGroupName: 'Orders route',
        targetId: 'target-a',
        destinationId: 'dest-1',
        destinationLabel: 'Destination One',
        targetConnectionId: 'target-connection',
        targetModelId: 'model-a',
        targetModelName: 'Model A',
        targetFolderPath: 'Shared/Migrated',
        kind: 'topic_prepare',
        documentId: 'orders-dashboard',
        documentName: 'Orders Dashboard',
        details: {
          topicMappings: [{
            sourceTopicName: 'orders_topic',
            sourceTopicId: 'orders_topic',
            action: 'copy_source',
            targetTopicName: 'orders_topic_copy',
          }],
        },
      },
      {
        routeGroupId: 'route-orders',
        routeGroupName: 'Orders route',
        targetId: 'target-a',
        destinationId: 'dest-1',
        destinationLabel: 'Destination One',
        targetConnectionId: 'target-connection',
        targetModelId: 'model-a',
        targetModelName: 'Model A',
        targetFolderPath: 'Shared/Migrated',
        kind: 'import',
        documentId: 'orders-dashboard',
        documentName: 'Orders Dashboard',
        warnings: ['Review calculated field compatibility.'],
      },
    ],
  };

  const routes = preflightRouteGroupsFromPlan(plan);
  const summary = dashboardMigrationReviewImpactSummary(plan, {
    routeGroups: routes,
    refreshSchemaOnComplete: true,
    deleteSourceOnSuccess: false,
  });

  assert.equal(summary.dashboardCount, 2);
  assert.equal(summary.destinationCount, 1);
  assert.equal(summary.replacementCount, 1);
  assert.equal(summary.topicActionCount, 1);
  assert.match(summary.impactStatements.join(' '), /copy 2 dashboards to 1 destination/i);
  assert.match(summary.impactStatements.join(' '), /same-name target dashboard will be moved to Trash/i);
  assert.match(summary.impactStatements.join(' '), /Source delete is off/i);
  assert.match(summary.impactStatements.join(' '), /Schema refresh is on/i);
  assert.deepEqual(summary.warningGroups, [{ message: 'Review calculated field compatibility.', count: 1 }]);
});

test('dashboard migration review impact summary groups and clarifies safety notices', () => {
  const plan: MigrationPlan = {
    sourceId: 'source-1',
    sourceLabel: 'Source',
    destinationIds: ['source-1'],
    documentIds: ['doc-1'],
    emptyFirst: false,
    replaceSameNamed: true,
    deleteSourceOnSuccess: true,
    targets: [{
      id: 'target-a',
      destinationInstanceId: 'source-1',
      destinationLabel: 'Source',
      targetConnectionId: 'target-connection',
      targetModelId: 'model-a',
      targetModelName: 'Model A',
    }],
    steps: [
      {
        targetId: 'target-a',
        destinationId: 'source-1',
        destinationLabel: 'Source',
        targetModelId: 'model-a',
        kind: 'import',
        documentId: 'doc-1',
        notices: ['Skipped target cleanup for selected source dashboard Executive Scorecard because source and target are the same Omni instance.'],
      },
      {
        targetId: 'target-a',
        destinationId: 'source-1',
        destinationLabel: 'Source',
        targetModelId: 'model-a',
        kind: 'metadata',
        documentId: 'doc-1',
        notices: ['Skipped target cleanup for selected source dashboard Executive Scorecard because source and target are the same Omni instance.'],
      },
      {
        targetId: 'target-a',
        destinationId: 'source-1',
        destinationLabel: 'Source',
        targetModelId: 'model-a',
        kind: 'import',
        documentId: 'doc-2',
        notices: ['Target cleanup was skipped because the selected target folder is the default My Documents area and OmniKit cannot scope replacement deletes safely.'],
      },
    ],
  };

  const summary = dashboardMigrationReviewImpactSummary(plan, {
    routeGroups: preflightRouteGroupsFromPlan(plan),
    refreshSchemaOnComplete: false,
    deleteSourceOnSuccess: true,
  });

  assert.equal(summary.noticeGroups.length, 2);
  assert.equal(summary.noticeGroups[0].count, 2);
  assert.match(summary.noticeGroups[0].message, /will not move same-name dashboards to Trash/i);
  assert.match(summary.noticeGroups[1].message, /default My Documents area/i);
  assert.match(summary.impactStatements.join(' '), /Source delete is on/i);
});

test('per-target preflight plans merge into one runnable plan', () => {
  const basePlan: MigrationPlan = {
    sourceId: 'source-1',
    sourceLabel: 'Source',
    destinationIds: ['dest-1'],
    documentIds: ['doc-1'],
    emptyFirst: false,
    replaceSameNamed: true,
    deleteSourceOnSuccess: false,
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
    deleteSourceOnSuccess: false,
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
    deleteSourceOnSuccess: false,
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
    deleteSourceOnSuccess: false,
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

test('dashboard migration draft persists options without credential fields', () => {
  const draft: DashboardMigrationDraft = {
    step: 1,
    sourceId: 'source-1',
    sourceConnectionId: 'source-connection',
    selectedDocumentIds: ['doc-1'],
    sourceFolderId: 'source-folder-1',
    sourceFolderPath: 'Shared/Dashboards',
    targets: [{
      id: 'target-1',
      destinationInstanceId: 'dest-1',
      targetConnectionId: 'target-connection',
      targetModelId: 'model-target',
      targetModelName: 'Target Model',
      targetFolderPath: 'Shared/Migrated',
      targetFolderId: 'folder-1',
    }],
    routeGroups: [{
      id: 'route-1',
      name: 'Orders route',
      documentIds: ['doc-1'],
      targetRowIds: ['target-1'],
      topicMappingsByTargetId: {
        'target-1': [{
          sourceTopicName: 'orders_topic',
          sourceTopicId: 'orders_topic',
          action: 'copy_source',
          targetTopicName: 'orders_topic_copy',
          warnings: [''],
        }],
      },
    }],
    replaceSameNamed: true,
    emptyFirst: false,
    refreshSchemaOnComplete: true,
    deleteSourceOnSuccess: true,
  };

  const sanitized = sanitizeDashboardMigrationDraftForStorage(draft);

  assert.equal(sanitized.replaceSameNamed, true);
  assert.equal(sanitized.emptyFirst, false);
  assert.equal(sanitized.refreshSchemaOnComplete, true);
  assert.equal(sanitized.deleteSourceOnSuccess, true);
  assert.equal(sanitized.sourceFolderPath, 'Shared/Dashboards');
  assert.equal(sanitized.targets[0].targetConnectionId, 'target-connection');
  assert.equal(sanitized.routeGroups?.[0].topicMappingsByTargetId?.['target-1']?.[0].targetTopicName, 'orders_topic_copy');
  assert.deepEqual(sanitized.routeGroups?.[0].topicMappingsByTargetId?.['target-1']?.[0].warnings, []);
  assert.equal(JSON.stringify(sanitized).includes('apiKey'), false);
});

test('dashboard migration draft defaults same-name replacement on for legacy saved drafts', () => {
  const sanitized = sanitizeDashboardMigrationDraftForStorage({
    step: 2,
    sourceId: 'source-1',
    sourceConnectionId: 'source-connection',
    selectedDocumentIds: ['doc-1'],
    sourceFolderId: '',
    sourceFolderPath: '',
    targets: [],
    refreshSchemaOnComplete: false,
    deleteSourceOnSuccess: false,
  } as never);

  assert.equal(sanitized.replaceSameNamed, true);
  assert.equal(sanitized.emptyFirst, false);
});
