import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectDashboardDependencyReadiness } from '../server/services/dashboardDependencyReadiness';
import { getDashboardDeploymentPlan, resolveDashboardRepairScope, deployDashboardDeploymentPlan, updateDashboardDeploymentPlan, mergeDashboardReadinessFindings } from '../server/services/dashboardDeploymentPlans';
import { sanitizeJob } from '../server/services/jobSanitizer';
import type { MigrationJob } from '../server/services/migrationJobs';
import type { DashboardDeploymentPlan } from '../shared/dashboardDeploymentPlan';

const view = 'dimensions:\n  id:\n    sql: ${TABLE}.id\n';
const inspect = (targetFiles: Record<string, string>, sourceFiles: Record<string, string> = { 'orders.view': view }) => inspectDashboardDependencyReadiness({ sourceFiles, targetFiles,
  states: [{ fields: ['orders.id'] }], documentIds: ['dashboard-demo'] });

test('dependency readiness ignores unrelated target fields and files but detects changed required SQL', () => {
  const target = { 'orders.view': `${view}  extra:\n    sql: ${'${TABLE}'}.extra\n`, 'unused.view': 'dimensions: {}' };
  assert.equal(inspect(target).findings.length, 0);
  assert.equal(inspect({ 'orders.view': view.replace('.id', '.different_id') }).findings[0]?.kind, 'field');
});

test('target-only security settings and missing source evidence are never marked verified', () => {
  const result = inspect({ 'orders.view': `always_where_sql: tenant_id = 1\n${view}` });
  assert.equal(result.unverified, true);
  assert(result.findings.some((finding) => finding.kind === 'security'));
  assert.equal(inspect({}, {}).unverified, true);
});

test('IDE folders and presentation metadata do not block readiness, while security differences remain', () => {
  const source = { 'orders.view': `folder: Source folder\nlabel: Source label\n${view}` };
  const target = { 'orders.view': `folder: Destination folder\nlabel: Destination label\n${view}` };
  assert.deepEqual(inspect(target, source).findings, []);
  const secured = inspect({ 'orders.view': `${target['orders.view']}required_access_grants: [tenant_access]\n` }, source);
  assert.equal(secured.unverified, true);
  assert(secured.findings.some((item) => item.kind === 'security'));
});

test('view-level root causes are inspected once, with precise per-field drilldown retained', () => {
  const sourceFiles = { 'orders.view': `${view}  amount:\n    sql: ${'${TABLE}'}.amount\nalways_where_sql: tenant_id = 1\n` };
  const result = inspectDashboardDependencyReadiness({ sourceFiles, targetFiles: {},
    states: [{ fields: ['orders.id', 'orders.amount'] }], documentIds: ['example-dashboard'] });
  assert.equal(result.findings.filter((item) => item.kind === 'security').length, 1);
  const fields = result.findings.filter((item) => item.kind === 'field');
  assert.equal(fields.length, 2);
  assert.equal(new Set(fields.map((item) => item.rootCauseId)).size, 1);
  assert.notEqual(fields[0].rootCauseId, result.findings.find((item) => item.kind === 'security')?.rootCauseId);
});

test('relation-only dependencies are checked as authored views without fabricated fields', () => {
  const sourceFiles = { 'orders.view': view, 'daily_rollup.view': 'sql: SELECT * FROM ${orders}\ndimensions: {}\n' };
  const result = inspectDashboardDependencyReadiness({ sourceFiles, targetFiles: { 'orders.view': view },
    seedFiles: ['daily_rollup.view'], states: [{ fields: ['orders.id'] }], documentIds: ['example-dashboard'] });
  assert(result.findings.some((item) => item.kind === 'view' && item.reference === 'daily_rollup' && item.causeCode === 'DESTINATION_VIEW_MISSING'));
  assert(!result.findings.some((item) => item.kind === 'field' && item.reference.startsWith('daily_rollup.')));
});

test('diagnostic merging uses cause and scope, not wording, and preserves independent blockers', () => {
  const base = { id: 'one', kind: 'field' as const, reference: 'orders.id', message: 'First wording', documentIds: ['one'],
    category: 'model_migrator' as const, sourceScope: 'shared' as const, causeCode: 'DESTINATION_FIELD_DIFFERS' };
  const result = mergeDashboardReadinessFindings([base, { ...base, id: 'two', message: 'Second wording', documentIds: ['two'] },
    { ...base, id: 'three', sourceScope: 'workbook', category: 'included_with_dashboard' },
    { ...base, id: 'four', causeCode: 'SECURITY_REVIEW_REQUIRED', category: 'cannot_verify' }]);
  assert.equal(result.length, 3);
  assert.deepEqual(result[0].documentIds, ['one', 'two']);
});

test('ordinary view relationships are checked without pulling in unrelated joins', () => {
  const sourceFiles = { 'orders.view': view, 'customers.view': view, relationships:
    '- join_from_view: orders\n  join_to_view: customers\n  join_type: left\n  on_sql: ${orders.id} = ${customers.id}\n- join_from_view: unrelated\n  join_to_view: detached\n  join_type: left\n' };
  const result = inspectDashboardDependencyReadiness({ sourceFiles, targetFiles: { 'orders.view': view, 'customers.view': view },
    states: [{ fields: ['orders.id', 'customers.id'] }], documentIds: ['dashboard-demo'] });
  assert.equal(result.findings.filter((finding) => finding.kind === 'relationship').length, 1);
  assert(!result.requiredFiles.includes('unrelated.view'));
});

test('existing renamed view mappings are compared using their actual destination file', () => {
  const result = inspectDashboardDependencyReadiness({ sourceFiles: { 'orders.view': view }, targetFiles: { 'sales.view': view },
    fileMappings: { 'orders.view': 'sales.view' }, states: [{ fields: ['orders.id'] }], documentIds: ['dashboard-demo'] });
  assert.equal(result.findings.length, 0);
});

test('readiness resolves nested authored views, topics and query views without inventing repair filenames', () => {
  const files = { 'schema/orders.view': view, 'queries/summary.query.view': view, 'topics/orders.topic': 'base_view: orders\n', relationships:
    '- join_from_view: orders\n  join_to_view: summary\n  on_sql: ${orders.id} = ${summary.id}\n' };
  const result = inspectDashboardDependencyReadiness({ sourceFiles: files, targetFiles: files,
    seedFiles: ['orders.topic'], states: [{ fields: ['orders.id', 'summary.id'] }], documentIds: ['dashboard-demo'] });
  assert.equal(result.unverified, false);
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.requiredFiles, ['queries/summary.query.view', 'relationships', 'schema/orders.view', 'topics/orders.topic']);
});

test('different file layouts compare exact semantic identities and hold repairs with path differences', () => {
  const sourceFiles = { 'source/orders.view': view };
  const unchanged = inspect({ 'destination/orders.view': view }, sourceFiles);
  assert.equal(unchanged.unverified, false);
  assert.deepEqual(unchanged.findings, []);
  const changed = inspect({ 'destination/orders.view': view.replace('.id', '.different_id') }, sourceFiles);
  assert.equal(changed.unverified, true);
  assert.equal(changed.findings[0]?.sourceFileName, 'source/orders.view');
  assert.equal(changed.findings[0]?.targetFileName, 'destination/orders.view');
});

test('ambiguous or absent authored source views stay unverified without guessing a replacement', () => {
  const ambiguous = inspect({}, { 'first/orders.view': view, 'second/orders.view': view });
  assert.equal(ambiguous.unverified, true);
  assert.match(ambiguous.findings[0]?.message || '', /Multiple authored files/);
  const absent = inspect({}, { 'renamed_orders.view': view });
  assert.equal(absent.unverified, true);
  assert.match(absent.findings[0]?.message || '', /does not prove the field is absent/);
  assert(!absent.requiredFiles.includes('orders.view'));
});

test('name-based query view mappings resolve actual query-view filenames', () => {
  const result = inspectDashboardDependencyReadiness({ sourceFiles: { 'queries/orders.query.view': view },
    targetFiles: { 'queries/sales.query.view': view }, fileMappings: { 'orders.view': 'sales.view' },
    states: [{ fields: ['orders.id'] }], documentIds: ['dashboard-demo'] });
  assert.equal(result.unverified, false);
  assert.deepEqual(result.findings, []);
  assert.deepEqual(result.requiredFiles, ['queries/orders.query.view']);
});

test('a chosen destination topic cannot substitute for missing or ambiguous source topic identity', () => {
  for (const topics of [
    { 'orders_copy.topic': 'base_view: orders\n' },
    { 'one/orders.topic': 'base_view: orders\n', 'two/orders.topic': 'base_view: orders\n' },
  ]) {
    const result = inspectDashboardDependencyReadiness({
      sourceFiles: { 'orders.view': view, ...topics },
      targetFiles: { 'orders.view': view, 'sales.topic': 'base_view: orders\n' },
      seedFiles: ['orders.topic'], fileMappings: { 'orders.topic': 'sales.topic' },
      states: [{ fields: ['orders.id'] }], documentIds: ['dashboard-demo'],
    });
    assert.equal(result.unverified, true);
    assert(result.findings.some((item) => item.category === 'cannot_verify'));
  }
});

test('explicit blank-only documents do not claim missing semantic evidence', () => {
  const result = inspectDashboardDependencyReadiness({ sourceFiles: {}, targetFiles: {}, documentIds: ['dashboard-demo'],
    states: [{ queryPresentations: { data: { context: { type: 'blank' } }, order: ['context'] } }] });
  assert.deepEqual(result, { findings: [], requiredFiles: [], unverified: false });
});

test('workbook-local calculations are informational but their shared dependencies still require repair', () => {
  const sourceFiles = { 'orders.view': view };
  const local = { sourceFileName: 'orders.view', definition: { sql: '${orders.id} * 2' } };
  const inspectLocal = (targetFiles: Record<string, string>) => inspectDashboardDependencyReadiness({ sourceFiles, targetFiles,
    workbookFields: { 'orders.local_total': local }, states: [{ fields: ['orders.local_total'] }], documentIds: ['workbook-one'] });
  const matched = inspectLocal(sourceFiles);
  assert.equal(matched.unverified, false);
  assert.equal(matched.findings.length, 1);
  assert.equal(matched.findings[0].category, 'included_with_dashboard');
  assert.equal(matched.findings[0].sourceScope, 'workbook');
  const missing = inspectLocal({});
  assert(missing.findings.some((item) => item.reference === 'orders.id' && item.category !== 'included_with_dashboard'));
  assert(!missing.findings.some((item) => item.reference === 'orders.local_total' && item.category !== 'included_with_dashboard'));
});

test('workbook overrides stay local and each document retains its own calculation evidence', () => {
  const inspectOverride = (documentId: string, sql: string) => inspectDashboardDependencyReadiness({ sourceFiles: { 'orders.view': view },
    targetFiles: { 'orders.view': view }, workbookFields: { 'orders.id': { sourceFileName: 'orders.view', definition: { sql } } },
    states: [{ fields: ['orders.id'] }], documentIds: [documentId] });
  const first = inspectOverride('workbook-one', '1');
  const second = inspectOverride('workbook-two', '2');
  assert(first.findings.every((item) => item.category === 'included_with_dashboard'));
  assert.notEqual(first.findings[0].id, second.findings[0].id);
  assert.deepEqual(second.findings[0].documentIds, ['workbook-two']);
});

test('durable deployment hashes survive redaction without permitting arbitrary metadata', () => {
  const digest = '1234567890'.repeat(6) + 'abcd';
  const evidence = { version: 2, planId: '11111111-1111-4111-8111-111111111111', sourceHashes: { 'document-demo': digest },
    modelHashes: { 'target-demo': digest }, sourceModelHashes: { 'source-model': digest } };
  const job = { sourceLabel: 'Source', destinationIds: [], postMigrationActions: [], items: [], details: { safeCopyDeployment: evidence } } as unknown as MigrationJob;
  assert.deepEqual(sanitizeJob(job).details?.safeCopyDeployment, evidence);
  assert.equal(sanitizeJob({ ...job, details: { safeCopyDeployment: { ...evidence, sourceHashes: { 'document-demo': 'Bearer private-secret' } } } }).details?.safeCopyDeployment, undefined);
});

test('saved plan recovery, revision checks and held destination guards need no live writes', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'omnikit-deployment-plan-'));
  const oldPath = process.env.OMNIKIT_JOB_HISTORY_PATH;
  process.env.OMNIKIT_JOB_HISTORY_PATH = join(directory, 'jobs.json');
  const plan: DashboardDeploymentPlan = { version: 2, evidenceVersion: 4, id: 'plan-demo', revision: 3, createdAt: 1, updatedAt: 2,
    intent: { profile: 'safe_copy_v1', requestId: '11111111-1111-4111-8111-111111111111',
      source: { instanceId: 'source', connectionId: 'connection-source', documentIds: ['dashboard-demo'] },
      destinations: [{ targetId: 'target-demo', instanceId: 'target', connectionId: 'connection-target', modelId: 'model-target' }] },
    sourceHashes: {}, sourceModelHashes: {}, targets: [{ targetId: 'target-demo', status: 'model_changes_required', findings: [], checkedAt: 2,
      sourceModelIds: ['model-source'], requiredFiles: ['orders.view'], requiredFilesByModelId: { 'model-source': ['orders.view'] } }] };
  try {
    writeFileSync(`${process.env.OMNIKIT_JOB_HISTORY_PATH}.deployment-plans.json`, JSON.stringify([plan]));
    assert.deepEqual(getDashboardDeploymentPlan(plan.id), plan);
    assert.throws(() => resolveDashboardRepairScope({ planId: plan.id, targetId: 'target-demo', revision: 2 }), /stale/);
    assert.equal(resolveDashboardRepairScope({ planId: plan.id, targetId: 'target-demo', revision: 3 }).destination.modelId, 'model-target');
    await assert.rejects(deployDashboardDeploymentPlan(plan.id, { revision: 3, targetIds: ['target-demo'], requestId: '22222222-2222-4222-8222-222222222222' }, null), /Only ready/);
    assert.deepEqual(getDashboardDeploymentPlan(plan.id), plan);
    plan.targets[0].status = 'unverified';
    writeFileSync(`${process.env.OMNIKIT_JOB_HISTORY_PATH}.deployment-plans.json`, JSON.stringify([plan]));
    assert.throws(() => resolveDashboardRepairScope({ planId: plan.id, targetId: 'target-demo', revision: 3 }), /repair is not verified/);
    plan.targets[0].topicChoices = [{ sourceTopicName: 'Original', candidates: [{ name: 'Destination' }], documentIds: ['dashboard-demo'] }];
    writeFileSync(`${process.env.OMNIKIT_JOB_HISTORY_PATH}.deployment-plans.json`, JSON.stringify([plan]));
    await assert.rejects(updateDashboardDeploymentPlan(plan.id, { revision: 2, targetId: 'target-demo', topicMappings: [] }), /plan changed/);
    await assert.rejects(updateDashboardDeploymentPlan(plan.id, { revision: 3, targetId: 'target-demo', topicMappings: [{ sourceTopicName: 'Original', action: 'map_existing', targetTopicName: 'Guessed' }] }), /latest readiness/);
    const changed = await updateDashboardDeploymentPlan(plan.id, { revision: 3, targetId: 'target-demo',
      topicMappings: [{ sourceTopicName: 'Original', action: 'map_existing', targetTopicName: 'Destination' }] });
    assert.equal(changed.revision, 4);
    assert.equal(changed.targets[0].status, 'needs_recheck');
    assert.deepEqual(changed.targets[0].topicChoices, plan.targets[0].topicChoices);
    assert.deepEqual(changed.intent.destinations[0].topicMappings, [{ sourceTopicName: 'Original', action: 'map_existing', targetTopicName: 'Destination' }]);
    const unchanged = await updateDashboardDeploymentPlan(plan.id, { revision: 4, targetId: 'target-demo', topicMappings: changed.intent.destinations[0].topicMappings });
    assert.equal(unchanged.revision, 4);
    changed.intent.destinations[0].topicMappings!.push({ sourceTopicName: 'Retained', action: 'copy_source', targetTopicName: 'Retained' });
    writeFileSync(`${process.env.OMNIKIT_JOB_HISTORY_PATH}.deployment-plans.json`, JSON.stringify([changed]));
    const retained = await updateDashboardDeploymentPlan(plan.id, { revision: 4, targetId: 'target-demo', topicMappings: changed.intent.destinations[0].topicMappings });
    assert.equal(retained.revision, 4);
    await assert.rejects(updateDashboardDeploymentPlan(plan.id, { revision: 4, targetId: 'target-demo',
      topicMappings: [{ sourceTopicName: 'Unreviewed', action: 'copy_source', targetTopicName: 'Unreviewed' }] }), /latest readiness/);
    delete plan.evidenceVersion;
    plan.targets[0].status = 'ready';
    writeFileSync(`${process.env.OMNIKIT_JOB_HISTORY_PATH}.deployment-plans.json`, JSON.stringify([plan]));
    assert.equal(getDashboardDeploymentPlan(plan.id).targets[0].status, 'needs_recheck');
    assert.throws(() => resolveDashboardRepairScope({ planId: plan.id, targetId: 'target-demo', revision: 3 }), /predates workbook-aware/);
  } finally {
    if (oldPath === undefined) delete process.env.OMNIKIT_JOB_HISTORY_PATH; else process.env.OMNIKIT_JOB_HISTORY_PATH = oldPath;
    rmSync(directory, { recursive: true, force: true });
  }
});
