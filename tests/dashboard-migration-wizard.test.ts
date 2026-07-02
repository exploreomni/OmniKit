import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  applySelectedSourceModelFallback,
  buildDashboardTopicMappings,
  buildDashboardQueryViewMappings,
  buildDashboardMigrationJobInput,
  buildRouteGroupsBySourceScope,
  buildSchemaRefreshActionsForTargets,
  buildTargetFolderOptions,
  buildTargetModelOptions,
  canContinueFromSourceStep,
  cleanDashboardModelMetadata,
  combineMigrationPlans,
  collectDashboardSourceTopics,
  createDashboardRouteGroupsFromSelection,
  estimateDurationSeconds,
  dashboardDocumentModelLabel,
  dashboardMigrationRoutePathLabel,
  dashboardMigrationReviewImpactSummary,
  dashboardDestinationsEmptyState,
  dashboardGroupSelectionAriaLabel,
  dashboardSelectionAriaLabel,
  dashboardSelectionEmptyState,
  destinationInstanceSelectionAriaLabel,
  mixedRouteGroupSourceScopeMessage,
  getDashboardLoadBlockReason,
  getDashboardMigrationPreflightBlockReason,
  normalizeDashboardRouteGroups,
  preflightRowsFromPlan,
  preserveSelectedDocumentIds,
  preflightRouteGroupsFromPlan,
  queryViewRequirementsByRouteTargetFromPlan,
  removeTargetFromMigrationPlan,
  routeTopicActionSummariesFromSteps,
  shouldAutoRunDashboardReadiness,
  summarizePlanByTarget,
  TARGET_FOLDER_COMBOBOX_CONFIG,
  TARGET_MODEL_COMBOBOX_CONFIG,
  unresolvedQueryViewMappingRouteMessage,
  unresolvedTopicMappingRouteMessage,
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
import { collapseUnchangedDiffRuns, lineDiff } from '../src/utils/lineDiff';

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

test('line diff handles identical, added, removed, and interleaved lines', () => {
  assert.deepEqual(lineDiff('a\nb', 'a\nb').map((part) => part.type), ['same', 'same']);
  assert.deepEqual(lineDiff('a', 'a\nb').map((part) => `${part.type}:${part.text}`), ['same:a', 'add:b']);
  assert.deepEqual(lineDiff('a\nb', 'a').map((part) => `${part.type}:${part.text}`), ['same:a', 'remove:b']);
  assert.deepEqual(lineDiff('a\nold\nc', 'a\nnew\nc').map((part) => `${part.type}:${part.text}`), ['same:a', 'add:new', 'remove:old', 'same:c']);
});

test('line diff collapses long unchanged runs around changed hunks', () => {
  const before = ['one', 'two', 'three', 'four', 'five', 'six', 'old', 'eight', 'nine'].join('\n');
  const after = ['one', 'two', 'three', 'four', 'five', 'six', 'new', 'eight', 'nine'].join('\n');
  const collapsed = collapseUnchangedDiffRuns(lineDiff(before, after), 1);
  assert.ok(collapsed.some((part) => part.text.includes('unchanged lines')));
  assert.ok(collapsed.some((part) => part.type === 'add' && part.text === 'new'));
  assert.ok(collapsed.some((part) => part.type === 'remove' && part.text === 'old'));
});

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

test('target drafts convert query view mappings to migration targets', () => {
  const target = targetDraftToMigrationTarget({
    id: 'target-1',
    destinationInstanceId: destination.id,
    targetConnectionId: 'connection-1',
    targetModelId: 'model-1',
    targetModelName: 'Executive Model',
    targetFolderPath: 'Executive/Migrated',
    targetFolderId: 'folder-1',
    queryViewMappings: [
      {
        sourceQueryViewName: 'whataburger_metrics',
        sourceFileName: 'whataburger_metrics.query.view',
        action: 'copy_source',
        targetQueryViewName: 'whataburger_metrics',
        targetFileName: 'whataburger_metrics.query.view',
        targetQueryViewLabel: 'Whataburger Metrics',
      },
      {
        sourceQueryViewName: 'ignored_metric',
        action: 'unresolved',
        targetQueryViewName: '',
      },
    ],
  }, [destination]);

  assert.deepEqual(target.queryViewMappings, [{
    sourceQueryViewName: 'whataburger_metrics',
    sourceFileName: 'whataburger_metrics.query.view',
    action: 'copy_source',
    targetQueryViewName: 'whataburger_metrics',
    targetFileName: 'whataburger_metrics.query.view',
    targetQueryViewLabel: 'Whataburger Metrics',
  }]);
});

test('target drafts convert field mappings to migration targets', () => {
  const target = targetDraftToMigrationTarget({
    id: 'target-1',
    destinationInstanceId: destination.id,
    targetConnectionId: 'connection-1',
    targetModelId: 'model-1',
    targetModelName: 'Executive Model',
    targetFolderPath: 'Executive/Migrated',
    targetFolderId: 'folder-1',
    fieldMappings: [
      {
        sourceFieldRef: 'orders.semantic_total_sales',
        action: 'map_existing',
        targetFieldRef: 'orders.total_sales',
      },
      {
        sourceFieldRef: 'orders.ignored',
        action: 'unresolved',
      },
    ],
  }, [destination]);

  assert.deepEqual(target.fieldMappings, [{
    sourceFieldRef: 'orders.semantic_total_sales',
    action: 'map_existing',
    targetFieldRef: 'orders.total_sales',
    sourceFileName: undefined,
    targetFileName: undefined,
  }]);
});

test('target drafts convert accepted semantic patches to migration targets', () => {
  const target = targetDraftToMigrationTarget({
    id: 'target-1',
    destinationInstanceId: destination.id,
    targetConnectionId: 'connection-1',
    targetModelId: 'model-1',
    targetModelName: 'Executive Model',
    targetFolderPath: 'Executive/Migrated',
    targetFolderId: 'folder-1',
    semanticPatches: [
      {
        id: 'field:orders.semantic_total_sales:orders.view',
        artifactType: 'field',
        sourceName: 'orders.semantic_total_sales',
        targetFileName: 'orders.view',
        currentYaml: 'dimensions:\n  total_sales:\n    sql: ${TABLE}.total_sales\n',
        sourceYaml: '  semantic_total_sales:\n    sql: ${orders.total_sales}\n',
        recommendedYaml: 'dimensions:\n  semantic_total_sales:\n    sql: ${orders.total_sales}\n',
        acceptedYaml: 'dimensions:\n  semantic_total_sales:\n    sql: ${orders.total_sales}\n',
        previousChecksum: 'checksum-1',
        resolution: 'custom_edit',
        status: 'ready',
        safetyCategory: 'safe_update',
        recommendedAction: 'Create semantic_total_sales from source model YAML.',
        dependencyPath: [
          { kind: 'model_field', label: 'orders.semantic_total_sales', ref: 'orders.semantic_total_sales' },
          { kind: 'model_file', label: 'orders.view', ref: 'orders.view' },
        ],
      },
      {
        id: 'topic:orders:orders.topic',
        artifactType: 'topic',
        sourceName: 'orders',
        targetFileName: 'orders.topic',
        recommendedYaml: 'views: {}\n',
        resolution: 'keep_target',
      },
    ],
  }, [destination]);

  assert.deepEqual(target.semanticPatches, [{
    id: 'field:orders.semantic_total_sales:orders.view',
    artifactType: 'field',
    sourceName: 'orders.semantic_total_sales',
    sourceFileName: undefined,
    targetFileName: 'orders.view',
    targetModelId: 'model-1',
    acceptedYaml: 'dimensions:\n  semantic_total_sales:\n    sql: ${orders.total_sales}\n',
    recommendedYaml: 'dimensions:\n  semantic_total_sales:\n    sql: ${orders.total_sales}\n',
    previousChecksum: 'checksum-1',
    resolution: 'custom_edit',
    destructive: false,
    confirmedDestructive: false,
    status: 'ready',
    safetyCategory: 'safe_update',
    recommendedAction: 'Create semantic_total_sales from source model YAML.',
    dependencyPath: [
      { kind: 'model_field', label: 'orders.semantic_total_sales', ref: 'orders.semantic_total_sales' },
      { kind: 'model_file', label: 'orders.view', ref: 'orders.view' },
    ],
    warnings: undefined,
  }]);
});

test('target drafts preserve explicit query view override and update actions', () => {
  const target = targetDraftToMigrationTarget({
    id: 'target-1',
    destinationInstanceId: destination.id,
    targetConnectionId: 'connection-1',
    targetModelId: 'model-1',
    targetModelName: 'Executive Model',
    queryViewMappings: [
      {
        sourceQueryViewName: 'whataburger_locations',
        sourceFileName: 'whataburger_locations.query.view',
        action: 'use_existing_unverified',
        targetQueryViewName: 'whataburger_locations',
        targetFileName: 'whataburger_locations.query.view',
      },
      {
        sourceQueryViewName: 'whataburger_menu_item_pnl',
        sourceFileName: 'whataburger_menu_item_pnl.query.view',
        action: 'update_existing',
        targetQueryViewName: 'whataburger_menu_item_pnl',
        targetFileName: 'whataburger_menu_item_pnl.query.view',
      },
    ],
  }, [destination]);

  assert.deepEqual(target.queryViewMappings?.map((mapping) => mapping.action), [
    'use_existing_unverified',
    'update_existing',
  ]);
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

test('dashboard migration creates a default route group after dashboard selection', () => {
  const groups = normalizeDashboardRouteGroups({
    groups: [],
    selectedDocumentIds: ['dashboard-1', 'dashboard-2'],
    targetRowIds: [],
    defaultGroupId: 'default-route',
  });

  assert.deepEqual(groups, [{
    id: 'default-route',
    name: 'All selected dashboards',
    documentIds: ['dashboard-1', 'dashboard-2'],
    targetRowIds: [],
    topicMappingsByTargetId: {},
    queryViewMappingsByTargetId: {},
  }]);
});

test('dashboard migration creates a custom group from selected dashboards and leaves the rest grouped', () => {
  const groups = createDashboardRouteGroupsFromSelection({
    currentGroups: [{
      id: 'default-route',
      name: 'All selected dashboards',
      documentIds: ['dashboard-1', 'dashboard-2', 'dashboard-3'],
      targetRowIds: ['target-1', 'target-2'],
      topicMappingsByTargetId: {},
    }],
    activeGroupId: 'default-route',
    selectedDocumentIds: ['dashboard-1', 'dashboard-2', 'dashboard-3'],
    routeSelectionIds: ['dashboard-1', 'dashboard-3'],
    targetRowIds: ['target-1', 'target-2'],
    defaultGroupId: 'default-route',
    nextGroupId: 'route-custom',
    remainingGroupId: 'route-remaining',
    nextGroupName: 'Executive dashboards',
  });

  assert.deepEqual(groups, [
    {
      id: 'route-custom',
      name: 'Executive dashboards',
      documentIds: ['dashboard-1', 'dashboard-3'],
      targetRowIds: ['target-1', 'target-2'],
      topicMappingsByTargetId: {},
      queryViewMappingsByTargetId: {},
    },
    {
      id: 'route-remaining',
      name: 'Remaining dashboards',
      documentIds: ['dashboard-2'],
      targetRowIds: ['target-1', 'target-2'],
      topicMappingsByTargetId: {},
      queryViewMappingsByTargetId: {},
    },
  ]);
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
    queryViewMappingsByTargetId: {
      'target-2': [{
        sourceQueryViewName: 'orders_metric',
        sourceFileName: 'orders_metric.query.view',
        action: 'map_existing',
        targetQueryViewName: 'orders_metric',
        targetFileName: 'orders_metric.query.view',
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
  assert.deepEqual(group.targets[0].queryViewMappings, [{
    sourceQueryViewName: 'orders_metric',
    sourceFileName: 'orders_metric.query.view',
    action: 'map_existing',
    targetQueryViewName: 'orders_metric',
    targetFileName: 'orders_metric.query.view',
    targetQueryViewLabel: undefined,
  }]);
});

test('dashboard migration job input includes compiled route groups and route targets', () => {
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
  const routeGroups = [
    routeGroupDraftToMigrationRouteGroup({
      id: 'route-orders',
      name: 'Orders dashboards',
      documentIds: ['dashboard-1'],
      targetRowIds: ['target-1'],
      topicMappingsByTargetId: {
        'target-1': [{
          sourceTopicName: 'orders_topic',
          sourceTopicId: 'orders_topic',
          action: 'map_existing',
          targetTopicName: 'orders_topic',
        }],
      },
    }, targetRows, [destination]),
    routeGroupDraftToMigrationRouteGroup({
      id: 'route-finance',
      name: 'Finance dashboards',
      documentIds: ['dashboard-2'],
      targetRowIds: ['target-2'],
      topicMappingsByTargetId: {},
    }, targetRows, [destination]),
  ];
  const migrationTargets = [...new Map(routeGroups.flatMap((group) => group.targets).map((target) => [target.id, target])).values()];

  const input = buildDashboardMigrationJobInput({
    sourceId: 'source-1',
    sourceConnectionId: 'source-connection',
    targets: migrationTargets,
    routeGroups,
    documentIds: ['dashboard-1', 'dashboard-2'],
    emptyFirst: false,
    replaceSameNamed: true,
    deleteSourceOnSuccess: false,
    postMigrationActions: [],
  });

  assert.equal(input.sourceAllFolders, true);
  assert.deepEqual(input.documentIds, ['dashboard-1', 'dashboard-2']);
  assert.deepEqual(input.targets.map((target) => target.id), ['target-1', 'target-2']);
  assert.deepEqual(input.routeGroups?.map((group) => group.id), ['route-orders', 'route-finance']);
  assert.deepEqual(input.routeGroups?.[0].targets.map((target) => target.id), ['target-1']);
  assert.equal(input.routeGroups?.[0].targets[0].topicMappings?.[0].targetTopicName, 'orders_topic');
});

test('dashboard migration extracts required query views by route target from readiness plans', () => {
  const plan: MigrationPlan = {
    sourceId: 'source-1',
    sourceLabel: 'Source',
    sourceConnectionId: 'source-connection',
    destinationIds: ['dest-1'],
    targets: [{
      id: 'target-1',
      destinationInstanceId: 'dest-1',
      targetConnectionId: 'target-connection',
      targetModelId: 'target-model',
    }],
    routeGroups: [{
      id: 'route-orders',
      name: 'Orders',
      documentIds: ['doc-1'],
      targets: [{
        id: 'target-1',
        destinationInstanceId: 'dest-1',
        targetConnectionId: 'target-connection',
        targetModelId: 'target-model',
      }],
    }],
    documentIds: ['doc-1'],
    emptyFirst: false,
    replaceSameNamed: true,
    deleteSourceOnSuccess: false,
    steps: [{
      routeGroupId: 'route-orders',
      routeGroupName: 'Orders',
      targetId: 'target-1',
      destinationId: 'dest-1',
      destinationLabel: 'Destination',
      targetConnectionId: 'target-connection',
      targetModelId: 'target-model',
      kind: 'import',
      documentId: 'doc-1',
      documentName: 'Orders Dashboard',
      details: {
        requiredQueryViews: [{
          name: 'orders_metric',
          sourceFileName: 'orders_metric.query.view',
          status: 'missing_copyable',
          sources: ['dashboard'],
          referencedBy: ['Orders Dashboard'],
        }],
      },
    }],
  };

  const requirements = queryViewRequirementsByRouteTargetFromPlan(plan);
  assert.equal(requirements['route-orders']['target-1'][0].name, 'orders_metric');
  assert.equal(requirements['route-orders']['target-1'][0].status, 'missing_copyable');
  assert.deepEqual(requirements['route-orders']['target-1'][0].referencedBy, ['Orders Dashboard']);
});

test('dashboard migration query view mappings require a choice for stale exact matches', () => {
  const mappings = buildDashboardQueryViewMappings([{
    name: 'whataburger_locations',
    sourceFileName: 'whataburger_locations.query.view',
    targetFileName: 'whataburger_locations.query.view',
    status: 'exact_target_match',
    compatibility: {
      status: 'missing_required_fields',
      missingRequiredFields: ['whataburger__whataburger_locations.texas_city'],
    },
  }], [{
    name: 'whataburger_locations',
    fileName: 'whataburger_locations.query.view',
    label: 'Whataburger Locations',
  }]);

  assert.equal(mappings[0].action, 'unresolved');
  assert.equal(mappings[0].status, 'blocked');
  assert.match(mappings[0].warnings?.[0] || '', /missing required fields/);
});

test('dashboard migration query view mappings preserve explicit stale-view resolutions', () => {
  const requiredQueryViews = [{
    name: 'whataburger_locations',
    sourceFileName: 'whataburger_locations.query.view',
    targetFileName: 'whataburger_locations.query.view',
    status: 'exact_target_match' as const,
    compatibility: {
      status: 'missing_required_fields' as const,
      missingRequiredFields: ['whataburger__whataburger_locations.texas_city'],
    },
  }];
  const targetQueryViews = [{
    name: 'whataburger_locations',
    fileName: 'whataburger_locations.query.view',
    label: 'Whataburger Locations',
  }];

  const useAsIsMappings = buildDashboardQueryViewMappings(requiredQueryViews, targetQueryViews, [{
    sourceQueryViewName: 'whataburger_locations',
    sourceFileName: 'whataburger_locations.query.view',
    action: 'use_existing_unverified',
    targetQueryViewName: 'whataburger_locations',
  }]);
  const updateMappings = buildDashboardQueryViewMappings(requiredQueryViews, targetQueryViews, [{
    sourceQueryViewName: 'whataburger_locations',
    sourceFileName: 'whataburger_locations.query.view',
    action: 'update_existing',
    targetQueryViewName: 'whataburger_locations',
  }]);

  assert.equal(useAsIsMappings[0].action, 'use_existing_unverified');
  assert.equal(useAsIsMappings[0].status, 'warning');
  assert.match(useAsIsMappings[0].warnings?.[0] || '', /as-is/);
  assert.equal(updateMappings[0].action, 'update_existing');
  assert.equal(updateMappings[0].status, 'ready');
});

test('dashboard migration query view helper blocks renamed copy-source mappings until references can be rewritten', () => {
  const mappings = buildDashboardQueryViewMappings([{
    name: 'whataburger_locations',
    sourceFileName: 'whataburger_locations.query.view',
    status: 'missing_copyable',
  }], [], [{
    sourceQueryViewName: 'whataburger_locations',
    sourceFileName: 'whataburger_locations.query.view',
    action: 'copy_source',
    targetQueryViewName: 'whataburger_locations_copy',
    targetFileName: 'whataburger_locations_copy.query.view',
  }]);

  assert.equal(mappings[0].action, 'copy_source');
  assert.equal(mappings[0].status, 'blocked');
  assert.match(mappings[0].warnings?.[0] || '', /keep the source query-view name/);
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

test('dashboard migration route group normalization prevents orphaned dashboards', () => {
  const groups = normalizeDashboardRouteGroups({
    groups: [{
      id: 'route-orders',
      name: 'Orders',
      documentIds: ['doc-1'],
      targetRowIds: ['target-old'],
      topicMappingsByTargetId: {
        'target-old': [{
          sourceTopicName: 'orders_topic',
          action: 'copy_source',
          targetTopicName: 'orders_topic_copy',
        }],
      },
    }],
    selectedDocumentIds: ['doc-1', 'doc-2'],
    targetRowIds: ['target-1', 'target-2'],
    defaultGroupId: 'default-route',
  });

  assert.deepEqual(groups.map((group) => group.documentIds), [['doc-1'], ['doc-2']]);
  assert.equal(groups[1].name, 'Remaining dashboards');
  assert.deepEqual(groups.map((group) => group.targetRowIds), [['target-1', 'target-2'], ['target-1', 'target-2']]);
  assert.deepEqual(groups[0].topicMappingsByTargetId, {});
});

test('dashboard migration route group normalization applies future destinations to every group', () => {
  const groups = normalizeDashboardRouteGroups({
    groups: [
      { id: 'route-orders', name: 'Orders', documentIds: ['doc-1'], targetRowIds: [] },
      { id: 'route-finance', name: 'Finance', documentIds: ['doc-2'], targetRowIds: ['target-1'] },
    ],
    selectedDocumentIds: ['doc-1', 'doc-2'],
    targetRowIds: ['target-1', 'target-2'],
    defaultGroupId: 'default-route',
  });

  assert.deepEqual(groups.map((group) => group.targetRowIds), [
    ['target-1', 'target-2'],
    ['target-1', 'target-2'],
  ]);
});

test('dashboard migration route group normalization preserves customized route assignments', () => {
  const groups = normalizeDashboardRouteGroups({
    groups: [
      {
        id: 'route-orders',
        name: 'Orders',
        documentIds: ['doc-1'],
        targetRowIds: ['target-1'],
        topicMappingsByTargetId: {
          'target-1': [{
            sourceTopicName: 'orders_topic',
            action: 'copy_source',
            targetTopicName: 'orders_topic_copy',
          }],
          'target-2': [{
            sourceTopicName: 'orders_topic',
            action: 'copy_source',
            targetTopicName: 'stale_topic_copy',
          }],
        },
      },
      {
        id: 'route-finance',
        name: 'Finance',
        documentIds: ['doc-2'],
        targetRowIds: ['target-2'],
      },
    ],
    selectedDocumentIds: ['doc-1', 'doc-2'],
    targetRowIds: ['target-1', 'target-2', 'target-3'],
    defaultGroupId: 'default-route',
    preserveTargetAssignments: true,
  });

  assert.deepEqual(groups.map((group) => group.targetRowIds), [
    ['target-1'],
    ['target-2'],
  ]);
  assert.deepEqual(Object.keys(groups[0].topicMappingsByTargetId || {}), ['target-1']);
});

test('dashboard migration route group normalization can preserve customized default group routes', () => {
  const groups = normalizeDashboardRouteGroups({
    groups: [{
      id: 'default-route',
      name: 'All selected dashboards',
      documentIds: ['doc-1'],
      targetRowIds: ['target-2'],
    }],
    selectedDocumentIds: ['doc-1'],
    targetRowIds: ['target-1', 'target-2'],
    defaultGroupId: 'default-route',
    preserveTargetAssignments: true,
  });

  assert.deepEqual(groups, [{
    id: 'default-route',
    name: 'All selected dashboards',
    documentIds: ['doc-1'],
    targetRowIds: ['target-2'],
    topicMappingsByTargetId: {},
    queryViewMappingsByTargetId: {},
  }]);
});

test('dashboard migration route group normalization preserves targetless Step 2 groups', () => {
  const groups = normalizeDashboardRouteGroups({
    groups: [{ id: 'route-orders', name: 'Orders', documentIds: ['doc-1'], targetRowIds: [] }],
    selectedDocumentIds: ['doc-1'],
    targetRowIds: [],
    defaultGroupId: 'default-route',
  });

  assert.deepEqual(groups, [{
    id: 'route-orders',
    name: 'Orders',
    documentIds: ['doc-1'],
    targetRowIds: [],
    topicMappingsByTargetId: {},
    queryViewMappingsByTargetId: {},
  }]);
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

test('dashboard migration topic helper preserves pending use-existing choices', () => {
  const [mapping] = buildDashboardTopicMappings(
    [{ name: 'stale_topic', id: 'stale_topic' }],
    [{ name: 'orders_topic', label: 'Orders Topic' }],
    [{
      sourceTopicName: 'stale_topic',
      sourceTopicId: 'stale_topic',
      action: 'map_existing',
      targetTopicName: '',
      warnings: ['Choose an existing target topic.'],
    }],
  );

  assert.equal(mapping.action, 'map_existing');
  assert.equal(mapping.targetTopicName, '');
  assert.equal(mapping.status, 'blocked');
  assert.match(mapping.warnings?.[0] || '', /Choose an existing target topic/);
});

test('dashboard migration query-view helper auto maps exact targets and creates missing query views', () => {
  const mappings = buildDashboardQueryViewMappings([
    {
      name: 'orders_metric',
      sourceFileName: 'orders_metric.query.view',
      targetFileName: 'orders_metric.query.view',
      label: 'Orders Metric',
      status: 'exact_target_match',
      sources: ['dashboard'],
      referencedBy: ['Orders Dashboard'],
    },
    {
      name: 'burger_metric',
      sourceFileName: 'burger_metric.query.view',
      status: 'missing_copyable',
      sources: ['topic'],
      referencedBy: ['food_service_topic'],
    },
  ], [
    { name: 'orders_metric', label: 'Orders Metric', fileName: 'orders_metric.query.view' },
  ]);

  assert.equal(mappings[0].action, 'map_existing');
  assert.equal(mappings[0].targetQueryViewName, 'orders_metric');
  assert.equal(mappings[0].status, 'ready');
  assert.equal(mappings[1].action, 'copy_source');
  assert.equal(mappings[1].targetQueryViewName, 'burger_metric');
  assert.equal(mappings[1].targetFileName, 'burger_metric.query.view');
  assert.equal(mappings[1].status, 'ready');
});

test('dashboard migration query-view helper blocks create-new collisions and missing source yaml', () => {
  const collision = buildDashboardQueryViewMappings([
    {
      name: 'orders_metric',
      sourceFileName: 'orders_metric.query.view',
      status: 'missing_copyable',
      sources: ['dashboard'],
      referencedBy: ['Orders Dashboard'],
    },
  ], [
    { name: 'orders_metric', fileName: 'orders_metric.query.view' },
  ], [{
    sourceQueryViewName: 'orders_metric',
    sourceFileName: 'orders_metric.query.view',
    action: 'copy_source',
    targetQueryViewName: 'orders_metric',
  }]);

  assert.equal(collision[0].action, 'copy_source');
  assert.equal(collision[0].status, 'blocked');
  assert.match(collision[0].warnings?.[0] || '', /already exists/);

  const missingYaml = buildDashboardQueryViewMappings([
    {
      name: 'missing_metric',
      status: 'missing_source_yaml',
      sources: ['dashboard'],
      referencedBy: ['Missing YAML Dashboard'],
      reason: 'Source query-view YAML was not found for missing_metric.',
    },
  ], []);

  assert.equal(missingYaml[0].action, 'unresolved');
  assert.equal(missingYaml[0].status, 'blocked');
  assert.equal(missingYaml[0].targetQueryViewName, '');
  assert.match(missingYaml[0].warnings?.[0] || '', /Source query-view YAML was not found/);
});

test('dashboard migration topic blockers identify the affected route path', () => {
  const routePath = dashboardMigrationRoutePathLabel({
    groupName: 'NFL dashboards',
    destinationLabel: 'ATX Demo',
    connectionLabel: 'ATX - NFL Big Data Bowl',
    modelLabel: 'NFL Model',
    folderLabel: 'Just for fun',
  });

  assert.equal(
    routePath,
    'NFL dashboards -> ATX Demo (ATX - NFL Big Data Bowl / NFL Model / Just for fun)',
  );
  assert.equal(
    unresolvedTopicMappingRouteMessage({
      sourceTopicName: 'superstar_lab',
      groupName: 'NFL dashboards',
      destinationLabel: 'ATX Demo',
      connectionLabel: 'ATX - NFL Big Data Bowl',
      modelLabel: 'NFL Model',
      folderLabel: 'Just for fun',
    }),
    'Resolve topic mapping for superstar_lab on route NFL dashboards -> ATX Demo (ATX - NFL Big Data Bowl / NFL Model / Just for fun).',
  );
  assert.equal(
    unresolvedQueryViewMappingRouteMessage({
      sourceQueryViewName: 'superstar_lab_metric',
      groupName: 'NFL dashboards',
      destinationLabel: 'ATX Demo',
      connectionLabel: 'ATX - NFL Big Data Bowl',
      modelLabel: 'NFL Model',
      folderLabel: 'Just for fun',
    }),
    'Resolve query-view mapping for superstar_lab_metric on route NFL dashboards -> ATX Demo (ATX - NFL Big Data Bowl / NFL Model / Just for fun).',
  );
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
    hasUnresolvedQueryViewMappings: false,
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
      hasUnresolvedQueryViewMappings: true,
      unresolvedQueryViewMappingMessage: 'Resolve query-view mapping for orders_metric on Destination One.',
      hasUnresolvedFieldMappings: true,
      unresolvedFieldMappingMessage: 'Resolve field orders.semantic_total_sales on Destination One.',
      hasUnresolvedTopicMappings: true,
      unresolvedTopicMappingMessage: 'Resolve topic mapping for nfl_mvp on Destination One.',
    }),
    'Resolve query-view mapping for orders_metric on Destination One.',
  );
  assert.equal(
    getDashboardMigrationPreflightBlockReason({
      ...readyInput,
      hasUnresolvedFieldMappings: true,
      unresolvedFieldMappingMessage: 'Resolve field orders.semantic_total_sales on Destination One.',
      hasUnresolvedTopicMappings: true,
      unresolvedTopicMappingMessage: 'Resolve topic mapping for nfl_mvp on Destination One.',
    }),
    'Resolve field orders.semantic_total_sales on Destination One.',
  );
  assert.equal(
    getDashboardMigrationPreflightBlockReason({
      ...readyInput,
      hasUnresolvedTopicMappings: true,
      unresolvedTopicMappingMessage: 'Resolve topic mapping for nfl_mvp on Destination One.',
    }),
    'Resolve topic mapping for nfl_mvp on Destination One.',
  );
  assert.equal(
    getDashboardMigrationPreflightBlockReason({
      ...readyInput,
      semanticPatchBlockReason: 'Review the field or measure code patch for Destination One; the YAML to apply is empty.',
    }),
    'Review the field or measure code patch for Destination One; the YAML to apply is empty.',
  );
  assert.equal(getDashboardMigrationPreflightBlockReason(readyInput), '');
});

test('dashboard migration readiness auto-trigger fires once per route input change', () => {
  const readyInput = {
    step: 3,
    planRowCount: 0,
    preflightLoading: false,
    preflightBlockReason: '',
    sourceId: 'source-1',
    sourceConnectionId: 'source-connection',
    selectedDocumentCount: 1,
    migrationTargetCount: 1,
    routeConfigurationSignature: 'route:v1',
    autoPreflightSignature: '',
    lastReadinessSignature: '',
  };

  assert.equal(shouldAutoRunDashboardReadiness(readyInput), true);
  assert.equal(shouldAutoRunDashboardReadiness({
    ...readyInput,
    autoPreflightSignature: 'route:v1',
  }), false);
  assert.equal(shouldAutoRunDashboardReadiness({
    ...readyInput,
    planRowCount: 3,
    autoPreflightSignature: 'route:v1',
    lastReadinessSignature: 'route:v1',
  }), false);
  assert.equal(shouldAutoRunDashboardReadiness({
    ...readyInput,
    planRowCount: 3,
    routeConfigurationSignature: 'route:v2',
    autoPreflightSignature: 'route:v1',
    lastReadinessSignature: 'route:v1',
  }), true);
  assert.equal(shouldAutoRunDashboardReadiness({
    ...readyInput,
    preflightLoading: true,
  }), false);
  assert.equal(shouldAutoRunDashboardReadiness({
    ...readyInput,
    preflightBlockReason: 'Resolve mappings first.',
  }), false);
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
    showIdBelowLabel: false,
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
        kind: 'query_view_prepare',
        documentId: 'orders-dashboard',
        documentName: 'Orders Dashboard',
        details: {
          queryViewMappings: [{
            sourceQueryViewName: 'orders_metrics',
            sourceFileName: 'orders_metrics.query.view',
            action: 'copy_source',
            targetQueryViewName: 'orders_metrics_copy',
            targetFileName: 'orders_metrics_copy.query.view',
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
        kind: 'relationship_prepare',
        documentId: 'orders-dashboard',
        documentName: 'Orders Dashboard',
        details: {
          relationshipEdges: [{
            joinFromView: 'orders_metrics',
            joinToView: 'orders_discount_metrics',
            relationshipType: 'many_to_one',
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
  assert.equal(routes[0].queryViewActionCount, 1);
  assert.equal(routes[0].relationshipActionCount, 1);
  assert.equal(routes[0].topicActionCount, 1);
  assert.equal(routes[0].status, 'warning');
  assert.equal(routes[0].targets[0].dashboardCount, 1);
  assert.equal(routes[0].targets[0].target.destinationLabel, 'Destination One');
  assert.equal(routes[0].targets[0].target.targetConnectionId, 'target-connection');
  assert.equal(routes[0].targets[0].target.targetModelName, 'Model A');
  assert.equal(routes[0].targets[0].target.targetFolderPath, 'Shared/Migrated');
  assert.equal(routes[0].targets[0].replaceCount, 1);
  assert.deepEqual(routes[0].targets[0].warnings, ['Review calculated field compatibility.']);
  assert.equal(routes[0].targets[0].queryViewActions[0].queryViewMappings[0].targetQueryViewName, 'orders_metrics_copy');
  assert.equal(routes[0].targets[0].relationshipActions[0].relationshipEdges[0].joinToView, 'orders_discount_metrics');
  assert.equal(routes[0].targets[0].topicActions[0].topicMappings[0].targetTopicName, 'orders_topic_copy');
  assert.equal(routes[1].status, 'blocked');
  assert.equal(routes[1].targets[0].status, 'blocked');
  assert.match(routes[1].error || '', /topic mappings/);
  assert.match(routes[1].targets[0].error || '', /topic mappings/);
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
  assert.equal(summary.queryViewActionCount, 0);
  assert.equal(summary.relationshipActionCount, 0);
  assert.equal(summary.topicActionCount, 1);
  assert.match(summary.impactStatements.join(' '), /copy 2 dashboards to 1 destination/i);
  assert.match(summary.impactStatements.join(' '), /same-name target dashboard will be moved to Trash/i);
  assert.match(summary.impactStatements.join(' '), /Source delete is off/i);
  assert.match(summary.impactStatements.join(' '), /Schema refresh is on/i);
  assert.deepEqual(summary.warningGroups, [{ message: 'Review calculated field compatibility.', count: 1 }]);
});

test('dashboard migration review impact summary surfaces relationship preparation', () => {
  const target = {
    id: 'target-a',
    destinationInstanceId: 'dest-1',
    destinationLabel: 'Destination One',
    targetConnectionId: 'target-connection',
    targetModelId: 'model-a',
    targetModelName: 'Model A',
    targetFolderPath: 'Shared/Migrated',
  };
  const plan: MigrationPlan = {
    sourceId: 'source-1',
    sourceLabel: 'Source',
    destinationIds: ['dest-1'],
    documentIds: ['orders-dashboard'],
    emptyFirst: false,
    replaceSameNamed: false,
    deleteSourceOnSuccess: false,
    targets: [target],
    routeGroups: [{
      id: 'route-orders',
      name: 'Orders route',
      documentIds: ['orders-dashboard'],
      targets: [target],
    }],
    steps: [{
      routeGroupId: 'route-orders',
      routeGroupName: 'Orders route',
      targetId: 'target-a',
      destinationId: 'dest-1',
      destinationLabel: 'Destination One',
      targetConnectionId: 'target-connection',
      targetModelId: 'model-a',
      targetModelName: 'Model A',
      targetFolderPath: 'Shared/Migrated',
      kind: 'relationship_prepare',
      documentId: 'orders-dashboard',
      documentName: 'Orders Dashboard',
      details: {
        relationshipEdges: [{
          joinFromView: 'orders_metrics',
          joinToView: 'orders_discount_metrics',
          relationshipType: 'many_to_one',
        }],
      },
    }],
  };

  const routes = preflightRouteGroupsFromPlan(plan);
  const summary = dashboardMigrationReviewImpactSummary(plan, {
    routeGroups: routes,
    refreshSchemaOnComplete: false,
    deleteSourceOnSuccess: false,
  });

  assert.equal(routes[0].relationshipActionCount, 1);
  assert.equal(routes[0].targets[0].relationshipActions[0].relationshipEdges[0].joinFromView, 'orders_metrics');
  assert.equal(summary.relationshipActionCount, 1);
  assert.match(summary.impactStatements.join(' '), /relationship edge/i);
});

test('dashboard migration review impact summary shows query-view blockers before topic blockers', () => {
  const plan: MigrationPlan = {
    sourceId: 'source-1',
    sourceLabel: 'Source',
    destinationIds: ['dest-1'],
    documentIds: ['orders-dashboard'],
    emptyFirst: false,
    replaceSameNamed: false,
    deleteSourceOnSuccess: false,
    targets: [{
      id: 'target-a',
      destinationInstanceId: 'dest-1',
      destinationLabel: 'Destination One',
      targetConnectionId: 'target-connection',
      targetModelId: 'model-a',
      targetModelName: 'Model A',
    }],
    steps: [
      {
        targetId: 'target-a',
        destinationId: 'dest-1',
        destinationLabel: 'Destination One',
        targetModelId: 'model-a',
        kind: 'query_view_prepare',
        documentId: 'orders-dashboard',
        documentName: 'Orders Dashboard',
        blocked: true,
        error: 'Resolve query-view mapping before topic prep.',
      },
      {
        targetId: 'target-a',
        destinationId: 'dest-1',
        destinationLabel: 'Destination One',
        targetModelId: 'model-a',
        kind: 'topic_prepare',
        documentId: 'orders-dashboard',
        documentName: 'Orders Dashboard',
        blocked: true,
        error: 'Resolve topic mapping before import.',
      },
    ],
  };

  const summary = dashboardMigrationReviewImpactSummary(plan, {
    routeGroups: preflightRouteGroupsFromPlan(plan),
    refreshSchemaOnComplete: false,
    deleteSourceOnSuccess: false,
  });

  assert.deepEqual(summary.blockerGroups.map((group) => group.message), [
    'Resolve query-view mapping before topic prep.',
    'Resolve topic mapping before import.',
  ]);
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
      queryViewMappingsByTargetId: {
        'target-1': [{
          sourceQueryViewName: 'orders_metric',
          sourceFileName: 'orders_metric.query.view',
          action: 'copy_source',
          targetQueryViewName: 'orders_metric_copy',
          warnings: [''],
        }],
      },
      fieldMappingsByTargetId: {
        'target-1': [{
          sourceFieldRef: 'orders.semantic_total_sales',
          action: 'map_existing',
          targetFieldRef: 'orders.total_sales',
          warnings: [''],
        }],
      },
    }],
    routeAssignmentsCustomized: true,
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
  assert.equal(sanitized.routeAssignmentsCustomized, true);
  assert.equal(sanitized.sourceFolderPath, 'Shared/Dashboards');
  assert.equal(sanitized.targets[0].targetConnectionId, 'target-connection');
  assert.equal(sanitized.routeGroups?.[0].topicMappingsByTargetId?.['target-1']?.[0].targetTopicName, 'orders_topic_copy');
  assert.deepEqual(sanitized.routeGroups?.[0].topicMappingsByTargetId?.['target-1']?.[0].warnings, []);
  assert.equal(sanitized.routeGroups?.[0].queryViewMappingsByTargetId?.['target-1']?.[0].targetQueryViewName, 'orders_metric_copy');
  assert.deepEqual(sanitized.routeGroups?.[0].queryViewMappingsByTargetId?.['target-1']?.[0].warnings, []);
  assert.equal(sanitized.routeGroups?.[0].fieldMappingsByTargetId?.['target-1']?.[0].targetFieldRef, 'orders.total_sales');
  assert.deepEqual(sanitized.routeGroups?.[0].fieldMappingsByTargetId?.['target-1']?.[0].warnings, []);
  assert.equal(JSON.stringify(sanitized).includes('apiKey'), false);
});

test('dashboard migration draft strips custom YAML bodies and blocks resumed custom edits', () => {
  const sanitized = sanitizeDashboardMigrationDraftForStorage({
    step: 3,
    sourceId: 'source-1',
    sourceConnectionId: 'source-connection',
    selectedDocumentIds: ['doc-1'],
    targets: [{
      id: 'target-1',
      destinationInstanceId: 'dest-1',
      targetConnectionId: 'target-connection',
      targetModelId: 'model-target',
      semanticPatches: [{
        id: 'field:orders.semantic_total_sales:orders.view',
        artifactType: 'field',
        sourceName: 'orders.semantic_total_sales',
        targetFileName: 'orders.view',
        acceptedYaml: 'measures:\n  semantic_total_sales:\n    sql: ${orders.total_sales}\n',
        recommendedYaml: 'measures:\n  semantic_total_sales:\n    sql: ${orders.total_sales}\n',
        sourceYaml: 'measures:\n  semantic_total_sales:\n    sql: ${orders.total_sales}\n',
        resolution: 'custom_edit',
        status: 'ready',
        confirmedDestructive: true,
        warnings: ['Review custom YAML.'],
      }],
    }],
    routeGroups: [{
      id: 'route-1',
      name: 'Orders route',
      documentIds: ['doc-1'],
      targetRowIds: ['target-1'],
      semanticPatchesByTargetId: {
        'target-1': [{
          id: 'topic:orders:orders.topic',
          artifactType: 'topic',
          sourceName: 'orders',
          targetFileName: 'orders.topic',
          acceptedYaml: 'base_view: orders\n',
          resolution: 'custom_edit',
          status: 'ready',
        }],
      },
    }],
    replaceSameNamed: true,
    emptyFirst: false,
    refreshSchemaOnComplete: false,
    deleteSourceOnSuccess: false,
  });
  const serialized = JSON.stringify(sanitized);
  const targetPatch = sanitized.targets[0].semanticPatches?.[0];
  const routePatch = sanitized.routeGroups?.[0].semanticPatchesByTargetId?.['target-1']?.[0];

  assert.equal(serialized.includes('acceptedYaml'), false);
  assert.equal(serialized.includes('recommendedYaml'), false);
  assert.equal(serialized.includes('sourceYaml'), false);
  assert.equal(targetPatch?.status, 'blocked');
  assert.equal(targetPatch?.confirmedDestructive, false);
  assert.equal(targetPatch?.warnings?.some((warning) => /Custom YAML is not stored/i.test(warning)), true);
  assert.equal(routePatch?.status, 'blocked');
  assert.equal(routePatch?.warnings?.some((warning) => /Custom YAML is not stored/i.test(warning)), true);
});

test('dashboard migration draft preserves Step 2 groups before destinations exist', () => {
  const sanitized = sanitizeDashboardMigrationDraftForStorage({
    step: 1,
    sourceId: 'source-1',
    sourceConnectionId: 'source-connection',
    selectedDocumentIds: ['doc-1'],
    sourceFolderId: '',
    sourceFolderPath: '',
    targets: [],
    routeGroups: [{
      id: 'route-orders',
      name: 'Orders',
      documentIds: ['doc-1'],
      targetRowIds: [],
      topicMappingsByTargetId: {},
    }],
    replaceSameNamed: true,
    emptyFirst: false,
    refreshSchemaOnComplete: false,
    deleteSourceOnSuccess: false,
  });

  assert.deepEqual(sanitized.routeGroups, [{
    id: 'route-orders',
    name: 'Orders',
    documentIds: ['doc-1'],
    targetRowIds: [],
    topicMappingsByTargetId: {},
    queryViewMappingsByTargetId: {},
    fieldMappingsByTargetId: {},
  }]);
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
  assert.equal(sanitized.routeAssignmentsCustomized, false);
});
