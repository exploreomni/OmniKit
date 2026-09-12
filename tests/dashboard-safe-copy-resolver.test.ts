import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  resolveDashboardSafeCopyTarget,
  dashboardSafeCopyDependencyPatchCandidates,
  type DashboardSafeCopyResolverResult,
} from '../server/services/dashboardSafeCopyResolver';
import type {
  MigrationFieldDependency,
  MigrationPermissionDependency,
  MigrationPlan,
  MigrationSemanticPatch,
  MigrationTarget,
} from '../server/services/migrationJobs';

function migrationTarget(): MigrationTarget {
  return {
    id: 'target-1',
    destinationInstanceId: 'destination-instance',
    destinationLabel: 'Destination',
    targetConnectionId: 'destination-connection',
    targetModelId: 'destination-model',
    targetModelName: 'Destination model',
    targetFolderPath: 'Shared/Migrated',
  };
}

function migrationPlan(details: Record<string, unknown>, target = migrationTarget()): MigrationPlan {
  return {
    sourceId: 'source-instance',
    sourceLabel: 'Source',
    sourceConnectionId: 'source-connection',
    destinationIds: [target.destinationInstanceId],
    targets: [target],
    documentIds: ['dashboard-1'],
    emptyFirst: false,
    replaceSameNamed: false,
    deleteSourceOnSuccess: false,
    steps: [{
      targetId: target.id,
      destinationId: target.destinationInstanceId,
      destinationLabel: target.destinationLabel || 'Destination',
      targetConnectionId: target.targetConnectionId,
      targetModelId: target.targetModelId,
      targetModelName: target.targetModelName,
      targetFolderPath: target.targetFolderPath,
      kind: 'semantic_validate',
      documentId: 'dashboard-1',
      documentName: 'Dashboard',
      details,
    }],
  };
}

function fieldDependency(input: Partial<MigrationFieldDependency> = {}): MigrationFieldDependency {
  return {
    sourceFieldRef: 'orders.net_sales',
    sourceViewName: 'orders',
    sourceFieldName: 'net_sales',
    sourceFileName: 'orders.view',
    fieldKind: 'measure',
    sourceYaml: '  net_sales:\n    sql: ${TABLE}.net_sales\n',
    targetCandidates: [],
    status: 'unresolved',
    ...input,
  };
}

function permissionDependency(
  input: Partial<MigrationPermissionDependency> = {},
): MigrationPermissionDependency {
  return {
    id: 'permission:orders:required_grants',
    kind: 'field_required_grants',
    sourceRef: 'orders.required_grants',
    sourceFileName: 'orders.view',
    targetFileName: 'orders.view',
    sourceValue: ['sales_team'],
    targetCandidates: [],
    status: 'unresolved',
    risk: 'medium',
    recommendedAction: 'create_from_source',
    ...input,
  };
}

function assertException(result: DashboardSafeCopyResolverResult) {
  assert.equal(result.status, 'exception');
  if (result.status !== 'exception') throw new Error('Expected a target exception.');
  return result.exceptions;
}

test('field exceptions preserve exact per-document provenance and reasons', () => {
  const target = migrationTarget();
  const plan = migrationPlan({ fieldDependencies: [
    fieldDependency({ sourceDocumentId: 'workbook-document', sourceProvenance: 'workbook_local', status: 'blocked', reason: 'Preserve this workbook-local definition.' }),
    fieldDependency({ sourceDocumentId: 'shared-document', sourceProvenance: 'inherited_unverified', status: 'blocked', reason: 'Authored shared evidence is missing.' }),
  ] }, target);
  const issues = assertException(resolveDashboardSafeCopyTarget(plan, target));
  assert.equal(issues.length, 2);
  assert.deepEqual(issues.map((issue) => [issue.sourceProvenance, issue.sourceDocumentIds, issue.message]).sort(), [
    ['inherited_unverified', ['shared-document'], 'Authored shared evidence is missing.'],
    ['workbook_local', ['workbook-document'], 'Preserve this workbook-local definition.'],
  ]);
});

test('readiness omits only explicitly withheld executable coverage and never resolves a withheld plan', () => {
  const target = migrationTarget();
  const plan = migrationPlan({ requiredQueryViews: [
    { name: 'withheld_view', sourceFileName: 'withheld_view.query.view', status: 'missing_copyable' },
    { name: 'independent_view', sourceFileName: 'independent_view.query.view', status: 'missing_copyable' },
  ], relationshipEdges: [{ joinFromView: 'withheld_view', joinToView: 'independent_view' }], dependencyProposalsWithheld: [
    { artifact: 'query_view', reference: 'withheld_view', reason: 'Source prerequisite requires review.', sourceDocumentId: 'dashboard-1' },
    { artifact: 'relationship', reference: 'relationship', reason: 'Source prerequisite requires review.', sourceDocumentId: 'dashboard-1' },
  ] }, target);
  const readiness = assertException(resolveDashboardSafeCopyTarget(plan, target, { mode: 'readiness' }));
  assert.equal(readiness.filter((issue) => issue.message.includes('lacks an exact')).length, 1);
  assert.ok(readiness.some((issue) => issue.reference === 'independent_view'));
  assert.ok(readiness.some((issue) => issue.reference === 'source_evidence' && issue.sourceDocumentIds?.[0] === 'dashboard-1'));
  const execution = assertException(resolveDashboardSafeCopyTarget(plan, target));
  assert.equal(execution.filter((issue) => issue.message.includes('lacks an exact')).length, 3);
  const noWithheldProof = migrationPlan({ requiredQueryViews: [{ name: 'withheld_view', sourceFileName: 'withheld_view.query.view', status: 'missing_copyable' }] }, target);
  assert.ok(assertException(resolveDashboardSafeCopyTarget(noWithheldProof, target, { mode: 'readiness' })).some((issue) => issue.message.includes('lacks an exact')));
});

test('per-document provenance never permits conflicting shared field mappings', () => {
  const target = migrationTarget();
  const plan = migrationPlan({ fieldDependencies: [
    fieldDependency({ sourceDocumentId: 'first-document', targetCandidates: [{ fieldRef: 'orders.net_sales', matchType: 'exact' }] }),
    fieldDependency({ sourceDocumentId: 'second-document' }),
  ] }, target);
  const issues = assertException(resolveDashboardSafeCopyTarget(plan, target));
  const conflict = issues.find((issue) => issue.code === 'AMBIGUOUS_MAPPING');
  assert.deepEqual(conflict?.sourceDocumentIds, ['first-document', 'second-document']);
});

test('readiness patch candidates preserve exact names and reject unknown or ambiguous evidence', () => {
  const candidates = dashboardSafeCopyDependencyPatchCandidates({
    fieldDependencies: [fieldDependency(), fieldDependency({ sourceFieldRef: 'other.net_sales', sourceViewName: 'other', sourceYaml: undefined, sourceFileName: undefined })],
    queryViews: [{ name: 'summary', sourceFileName: 'reports/summary.query.view', status: 'missing_copyable' }],
  });
  assert.deepEqual(candidates.fieldMappings.map((mapping) => mapping.sourceFieldRef), ['orders.net_sales']);
  assert.equal(candidates.queryViewMappings[0].targetFileName, 'reports/summary.query.view');
  assert.equal(candidates.queryViewMappings[0].targetQueryViewName, 'summary');
  const conflict = dashboardSafeCopyDependencyPatchCandidates({
    fieldDependencies: [fieldDependency(), fieldDependency({ sourceYaml: '  net_sales:\n    sql: ${TABLE}.different\n' })],
    queryViews: [{ name: 'summary', sourceFileName: 'reports/summary.query.view', status: 'missing_copyable' }],
    configuredQueryViewMappings: [{ sourceQueryViewName: 'summary', action: 'copy_source', targetQueryViewName: 'different_summary' }],
  });
  assert.deepEqual(conflict, { fieldMappings: [], queryViewMappings: [] });
});

test('topic mappings require authored source identity even when the destination is explicitly selected', () => {
  const mapping = { sourceTopicName: 'ExampleSource', sourceTopicId: 'example-topic-id', action: 'map_existing' as const, targetTopicName: 'ExampleSource' };
  const target = { ...migrationTarget(), topicMappings: [mapping] };
  const result = resolveDashboardSafeCopyTarget(migrationPlan({
    sourceTopics: [{ name: 'ExampleSource', id: 'example-topic-id' }],
    topicMappings: [mapping],
  }, target), target);
  assert.ok(assertException(result).some((issue) => issue.artifact === 'topic' && issue.code === 'MISSING_EVIDENCE'));
});

test('topic mappings reject ambiguous authored files and conflicting cross-name file identity', () => {
  for (const topics of [
    [
      { name: 'ExampleSource', id: 'example-topic-id', fileName: 'first/ExampleSource.topic' },
      { name: 'ExampleSource', id: 'example-topic-id', fileName: 'second/ExampleSource.topic' },
    ],
    [
      { name: 'ExampleSource', id: 'example-topic-id', fileName: 'ExampleSource.topic' },
      { name: 'RenamedSource', id: 'example-topic-id', fileName: 'RenamedSource.topic' },
    ],
  ]) {
    const mapping = { sourceTopicName: 'ExampleSource', sourceTopicId: 'example-topic-id', action: 'map_existing' as const, targetTopicName: 'ExampleSource' };
    const target = { ...migrationTarget(), topicMappings: [mapping] };
    const result = resolveDashboardSafeCopyTarget(migrationPlan({ sourceTopics: topics, topicMappings: [mapping] }, target), target);
    assert.ok(assertException(result).some((issue) => issue.artifact === 'topic' && issue.code === 'AMBIGUOUS_MAPPING'));
  }
});

test('an explicit differently named destination is permitted only with exact original source evidence', () => {
  const mapping = { sourceTopicName: 'ExampleSource', sourceTopicId: 'example-topic-id', action: 'map_existing' as const, targetTopicName: 'ExampleDestination' };
  const target = { ...migrationTarget(), topicMappings: [mapping] };
  const result = resolveDashboardSafeCopyTarget(migrationPlan({
    sourceTopics: [{ name: 'ExampleSource', id: 'example-topic-id', fileName: 'nested/ExampleSource.topic' }],
    topicMappings: [mapping],
  }, target), target);
  assert.equal(result.status, 'resolved');
  if (result.status !== 'resolved') return;
  assert.deepEqual(result.target.topicMappings, [mapping]);
});

test('a label-only or stale renamed source filename cannot prove source identity', () => {
  for (const fileName of ['unrelated.topic', 'ExampleDestination.topic']) {
    const mapping = { sourceTopicName: 'ExampleSource', sourceTopicId: 'example-topic-id', action: 'map_existing' as const, targetTopicName: 'ExampleDestination' };
    const target = { ...migrationTarget(), topicMappings: [mapping] };
    const result = resolveDashboardSafeCopyTarget(migrationPlan({
      sourceTopics: [{ name: 'ExampleSource', id: 'example-topic-id', fileName }],
      topicMappings: [mapping],
    }, target), target);
    assert.ok(assertException(result).some((issue) => issue.artifact === 'topic' && issue.code === 'MISSING_EVIDENCE'));
  }
});

test('an automatically inferred differently named topic remains blocked without an explicit choice', () => {
  const target = migrationTarget();
  const result = resolveDashboardSafeCopyTarget(migrationPlan({
    sourceTopics: [{ name: 'ExampleSource', id: 'example-topic-id', fileName: 'ExampleSource.topic' }],
    topicMappings: [{ sourceTopicName: 'ExampleSource', sourceTopicId: 'example-topic-id', action: 'map_existing', targetTopicName: 'ExampleDestination' }],
  }, target), target);
  assert.ok(assertException(result).some((issue) => issue.artifact === 'topic' && issue.code === 'AMBIGUOUS_MAPPING'));
});

test('an explicit topic choice cannot replace a conflicting source identifier', () => {
  const mapping = { sourceTopicName: 'ExampleSource', sourceTopicId: 'different-topic-id', action: 'map_existing' as const, targetTopicName: 'ExampleDestination' };
  const target = { ...migrationTarget(), topicMappings: [mapping] };
  const result = resolveDashboardSafeCopyTarget(migrationPlan({
    sourceTopics: [{ name: 'ExampleSource', id: 'example-topic-id', fileName: 'ExampleSource.topic' }],
    topicMappings: [mapping],
  }, target), target);
  assert.ok(assertException(result).some((issue) => issue.artifact === 'topic' && issue.code === 'AMBIGUOUS_MAPPING'));
});

test('safe-copy resolver builds one deterministic target from exact, strong, and source-copy evidence', () => {
  const target = migrationTarget();
  const result = resolveDashboardSafeCopyTarget(migrationPlan({
    fieldDependencies: [
      fieldDependency({
        targetCandidates: [{
          fieldRef: 'orders.net_sales',
          fieldKind: 'measure',
          matchType: 'exact',
        }],
      }),
      fieldDependency({
        sourceFieldRef: 'orders.order_margin',
        sourceFieldName: 'order_margin',
        sourceYaml: '  order_margin:\n    sql: ${TABLE}.order_margin\n',
      }),
    ],
    requiredQueryViews: [
      {
        name: 'orders_summary',
        sourceFileName: 'orders_summary.query.view',
        targetFileName: 'orders_summary.query.view',
        status: 'exact_target_match',
        compatibility: { status: 'compatible' },
      },
      {
        name: 'daily_orders',
        sourceFileName: 'daily_orders.query.view',
        status: 'missing_copyable',
      },
    ],
    queryViewMappings: [{
      sourceQueryViewName: 'orders_summary',
      sourceFileName: 'orders_summary.query.view',
      action: 'map_existing',
      targetQueryViewName: 'orders_summary',
      targetFileName: 'orders_summary.query.view',
    }],
    sourceTopics: [
      { name: 'Orders', id: 'topic-orders', fileName: 'Orders.topic' },
      { name: 'Daily Operations', id: 'topic-daily', fileName: 'Daily Operations.topic' },
    ],
    topicMappings: [{
      sourceTopicName: 'Orders',
      sourceTopicId: 'topic-orders',
      action: 'map_existing',
      targetTopicName: 'Orders',
    }],
    permissionDependencies: [permissionDependency({
      recommendedAction: 'map_existing',
      targetCandidates: [{ targetRef: 'grant:sales_team', compatibility: 'equivalent' }],
    })],
    semanticPatches: [{
      id: 'field:orders.order_margin:orders.view',
      artifactType: 'field',
      sourceName: 'orders.order_margin',
      sourceFileName: 'orders.view',
      targetFileName: 'orders.view',
      recommendedYaml: 'dimensions:\n  order_margin:\n    sql: ${TABLE}.order_margin',
      resolution: 'recommended',
      status: 'ready',
      safetyCategory: 'safe_create',
    }, {
      id: 'query_view:daily_orders:daily_orders.query.view',
      artifactType: 'query_view',
      sourceName: 'daily_orders',
      sourceFileName: 'daily_orders.query.view',
      targetFileName: 'daily_orders.query.view',
      recommendedYaml: 'base_view: orders',
      resolution: 'recommended',
      status: 'ready',
      safetyCategory: 'safe_create',
    }, {
      id: 'topic:Daily Operations:Daily Operations.topic',
      artifactType: 'topic',
      sourceName: 'Daily Operations',
      sourceFileName: 'Daily Operations.topic',
      targetFileName: 'Daily Operations.topic',
      recommendedYaml: 'label: Daily Operations',
      resolution: 'recommended',
      status: 'ready',
      safetyCategory: 'safe_create',
    }],
  }, target), target);

  assert.equal(result.status, 'resolved');
  if (result.status !== 'resolved') return;
  assert.deepEqual(result.target.fieldMappings, [
    {
      sourceFieldRef: 'orders.net_sales',
      sourceFileName: 'orders.view',
      action: 'map_existing',
      targetFieldRef: 'orders.net_sales',
    },
    {
      sourceFieldRef: 'orders.order_margin',
      sourceFileName: 'orders.view',
      targetFileName: 'orders.view',
      action: 'create_from_source',
    },
  ]);
  assert.deepEqual(result.target.queryViewMappings?.map((mapping) => (
    [mapping.sourceQueryViewName, mapping.action, mapping.targetQueryViewName]
  )), [
    ['daily_orders', 'copy_source', 'daily_orders'],
    ['orders_summary', 'map_existing', 'orders_summary'],
  ]);
  assert.deepEqual(result.target.topicMappings?.map((mapping) => (
    [mapping.sourceTopicName, mapping.action, mapping.targetTopicName]
  )), [
    ['Daily Operations', 'copy_source', 'Daily Operations'],
    ['Orders', 'map_existing', 'Orders'],
  ]);
  assert.deepEqual(result.target.permissionDecisions, [{
    dependencyId: 'permission:orders:required_grants',
    action: 'map_existing',
    targetRef: 'grant:sales_team',
  }]);
  assert.equal(result.target.semanticPatches?.length, 3);
  assert.ok(result.target.semanticPatches?.every((patch) => patch.resolution === 'recommended'));
  assert.ok(result.target.semanticPatches?.every((patch) => Boolean(patch.acceptedYaml)));
  assert.ok(result.target.semanticPatches?.every((patch) => patch.currentYaml === undefined));
  assert.deepEqual(result.target.queryValidationWaivers, []);
});

test('safe-copy resolver returns a typed exception for ambiguous strong field matches', () => {
  const target = migrationTarget();
  const result = resolveDashboardSafeCopyTarget(migrationPlan({
    fieldDependencies: [fieldDependency({
      sourceYaml: undefined,
      targetCandidates: [
        { fieldRef: 'orders.netSales', fieldKind: 'measure', matchType: 'normalized' },
        { fieldRef: 'orders.net-sales', fieldKind: 'measure', matchType: 'normalized' },
      ],
    })],
  }, target), target);

  const exceptions = assertException(result);
  assert.deepEqual(exceptions.map((item) => item.code), ['AMBIGUOUS_MAPPING']);
  assert.equal(exceptions[0].artifact, 'field');
});

test('safe-copy resolver fails closed for direct access, AccessBoost, and identity evidence', () => {
  const target = migrationTarget();
  const result = resolveDashboardSafeCopyTarget(migrationPlan({
    permissionDependencies: [
      permissionDependency({
        id: 'permission:document_access:principal-secret',
        kind: 'document_access',
        sourceRef: 'person@example.com',
        sourceValue: {
          principalEmail: 'person@example.com',
          access_boostable: true,
          role: 'EDITOR',
        },
        sourceFileName: undefined,
        targetFileName: undefined,
        risk: 'high',
        recommendedAction: 'map_existing',
        targetCandidates: [{ targetRef: 'user:target-secret', compatibility: 'equivalent' }],
      }),
      permissionDependency({
        id: 'permission:user_group:group-secret',
        kind: 'user_group',
        sourceRef: 'Sensitive group',
        sourceValue: { name: 'Sensitive group' },
        sourceFileName: undefined,
        targetFileName: undefined,
        risk: 'high',
        recommendedAction: 'manual_prerequisite',
      }),
      permissionDependency({
        id: 'permission:missing_target:create-secret',
        sourceValue: { requiredGrant: 'create-secret' },
        recommendedAction: 'create_from_source',
        risk: 'low',
      }),
    ],
    semanticPatches: [{
      id: 'permission:orders:orders.view',
      artifactType: 'permission',
      sourceName: 'must-not-return',
      targetFileName: 'orders.view',
      recommendedYaml: 'permission_secret_yaml: must-not-return',
      resolution: 'recommended',
      status: 'ready',
      safetyCategory: 'safe_create',
    }],
  }, target), target);

  const exceptions = assertException(result);
  assert.equal(exceptions.length, 4);
  assert.ok(exceptions.every((item) => item.code === 'SECURITY_REVIEW_REQUIRED'));
  const serialized = JSON.stringify(exceptions);
  assert.doesNotMatch(serialized, /person@example|principal-secret|target-secret|Sensitive group|accessBoost|create-secret|must-not-return|permission_secret_yaml/i);
});

test('safe-copy resolver accepts a fresh bounded additive non-security patch', () => {
  const target = migrationTarget();
  const recommendedYaml = 'fields:\n  order_id:\n    description: Governed order key\n';
  const patch: MigrationSemanticPatch = {
    id: 'field:orders.order_id:orders.view',
    artifactType: 'field',
    sourceName: 'orders.order_id',
    sourceFileName: 'orders.view',
    targetFileName: 'orders.view',
    targetModelId: target.targetModelId,
    currentYaml: 'fields:\n  order_id: {}\n',
    recommendedYaml,
    previousChecksum: 'fresh-checksum',
    resolution: 'recommended',
    destructive: false,
    status: 'ready',
    safetyCategory: 'safe_update',
    dependencyPath: [{ kind: 'model_field', label: 'orders.order_id' }],
  };
  const result = resolveDashboardSafeCopyTarget(migrationPlan({
    fieldDependencies: [fieldDependency({
      sourceFieldRef: 'orders.order_id',
      sourceFieldName: 'order_id',
      sourceYaml: '  order_id:\n    sql: ${TABLE}.order_id\n',
    })],
    semanticPatches: [patch],
  }, target), target);

  assert.equal(result.status, 'resolved');
  if (result.status !== 'resolved') return;
  assert.deepEqual(result.target.permissionDecisions, []);
  assert.equal(result.target.semanticPatches?.length, 1);
  assert.equal(result.target.semanticPatches?.[0].acceptedYaml, recommendedYaml);
  assert.equal(result.target.semanticPatches?.[0].previousChecksum, 'fresh-checksum');
  assert.equal(result.target.semanticPatches?.[0].currentYaml, undefined);
  assert.equal(result.target.semanticPatches?.[0].recommendedYaml, undefined);
  assert.equal(result.target.semanticPatches?.[0].sourceYaml, undefined);
});

test('safe-copy resolver rejects an orphan write-bearing semantic patch', () => {
  const target = migrationTarget();
  const result = resolveDashboardSafeCopyTarget(migrationPlan({
    semanticPatches: [{
      id: 'field:orphan:orders.view',
      artifactType: 'field',
      sourceName: 'orders.orphan',
      targetFileName: 'orders.view',
      recommendedYaml: 'dimensions:\n  orphan:\n    sql: ${TABLE}.orphan',
      resolution: 'recommended',
      status: 'ready',
      safetyCategory: 'safe_create',
    }],
  }, target), target);

  const exceptions = assertException(result);
  assert.deepEqual(exceptions.map((exception) => [exception.artifact, exception.code]), [
    ['semantic_patch', 'MISSING_EVIDENCE'],
  ]);
});

test('safe-copy resolver binds topic and relationship writes to their exact files', () => {
  const target = migrationTarget();
  const wrongTopic = resolveDashboardSafeCopyTarget(migrationPlan({
    sourceTopics: [{ name: 'Daily Operations', id: 'topic-daily', fileName: 'Daily Operations.topic' }],
    semanticPatches: [{
      id: 'topic:Daily Operations:unrelated.topic',
      artifactType: 'topic',
      sourceName: 'Daily Operations',
      sourceFileName: 'unrelated.topic',
      targetFileName: 'unrelated.topic',
      recommendedYaml: 'label: Daily Operations',
      resolution: 'recommended',
      status: 'ready',
      safetyCategory: 'safe_create',
    }],
  }, target), target);
  const topicExceptions = assertException(wrongTopic);
  assert.ok(topicExceptions.some((exception) => (
    exception.artifact === 'topic' && exception.code === 'MISSING_EVIDENCE'
  )));

  const wrongRelationship = resolveDashboardSafeCopyTarget(migrationPlan({
    relationshipEdges: [{ joinFromView: 'orders', joinToView: 'customers' }],
    semanticPatches: [{
      id: 'relationship:relationships:unrelated.view',
      artifactType: 'relationship',
      sourceName: 'relationships',
      sourceFileName: 'relationships',
      targetFileName: 'unrelated.view',
      recommendedYaml: '- join_from_view: orders\n  join_to_view: customers',
      resolution: 'recommended',
      status: 'ready',
      safetyCategory: 'safe_create',
    }],
  }, target), target);
  const relationshipExceptions = assertException(wrongRelationship);
  assert.ok(relationshipExceptions.some((exception) => (
    exception.artifact === 'relationship' && exception.code === 'MISSING_EVIDENCE'
  )));

  const wrongRelationshipSource = resolveDashboardSafeCopyTarget(migrationPlan({
    relationshipEdges: [{ joinFromView: 'orders', joinToView: 'customers' }],
    semanticPatches: [{
      id: 'relationship:relationships:relationships',
      artifactType: 'relationship',
      sourceName: 'relationships',
      sourceFileName: 'unrelated.view',
      targetFileName: 'relationships',
      recommendedYaml: '- join_from_view: orders\n  join_to_view: customers',
      resolution: 'recommended',
      status: 'ready',
      safetyCategory: 'safe_create',
    }],
  }, target), target);
  const relationshipSourceExceptions = assertException(wrongRelationshipSource);
  assert.ok(relationshipSourceExceptions.some((exception) => (
    exception.artifact === 'relationship' && exception.code === 'MISSING_EVIDENCE'
  )));
});

test('safe-copy resolver rejects destructive patches without returning raw YAML', () => {
  const target = migrationTarget();
  const result = resolveDashboardSafeCopyTarget(migrationPlan({
    semanticPatches: [{
      id: 'field:orders:orders.view',
      artifactType: 'field',
      sourceName: 'orders.net_sales',
      targetFileName: 'orders.view',
      currentYaml: 'secret_current_yaml: must-not-return',
      recommendedYaml: 'secret_replacement_yaml: must-not-return',
      previousChecksum: 'checksum',
      resolution: 'recommended',
      destructive: true,
      status: 'ready',
      safetyCategory: 'destructive_update',
    }],
  }, target), target);

  const exceptions = assertException(result);
  assert.deepEqual(exceptions.map((item) => item.code), ['DESTRUCTIVE_CHANGE']);
  assert.doesNotMatch(JSON.stringify(exceptions), /must-not-return|secret_current_yaml|secret_replacement_yaml/);
});

test('safe-copy resolver requires every generated semantic write to have an exact patch', () => {
  const target = migrationTarget();
  const result = resolveDashboardSafeCopyTarget(migrationPlan({
    fieldDependencies: [fieldDependency()],
    requiredQueryViews: [{
      name: 'daily_orders',
      sourceFileName: 'daily_orders.query.view',
      status: 'missing_copyable',
    }],
    sourceTopics: [{ name: 'Daily Operations', id: 'topic-daily' }],
  }, target), target);

  const exceptions = assertException(result);
  assert.deepEqual(exceptions.map((exception) => [exception.artifact, exception.code]), [
    ['field', 'MISSING_EVIDENCE'],
    ['query_view', 'MISSING_EVIDENCE'],
    ['topic', 'MISSING_EVIDENCE'],
  ]);
});

test('safe-copy resolver rejects same-id plan evidence from a different destination scope', () => {
  const target = migrationTarget();
  const plan = migrationPlan({
    fieldDependencies: [fieldDependency({
      targetCandidates: [{ fieldRef: 'orders.net_sales', fieldKind: 'measure', matchType: 'exact' }],
    })],
  }, target);
  plan.steps[0] = {
    ...plan.steps[0],
    destinationId: 'other-destination',
    targetConnectionId: 'other-connection',
    targetModelId: 'other-model',
  };

  const exceptions = assertException(resolveDashboardSafeCopyTarget(plan, target));
  assert.ok(exceptions.some((exception) => exception.code === 'TARGET_SCOPE_MISMATCH'));
  assert.ok(!exceptions.some((exception) => exception.artifact === 'field'));
});
