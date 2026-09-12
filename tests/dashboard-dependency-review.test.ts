import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { DashboardDependencyFinding, DashboardDeploymentTargetReadiness } from '../shared/dashboardDeploymentPlan';
import { buildDashboardDependencyReview, groupDashboardReadinessCauses } from '../src/services/dashboardDependencyReview';

const SOURCE_REASON = 'This field cannot be traced to an authored source definition.';
const FIELD_DIFFERENCE = 'The required field is missing or has different authored semantics in the destination.';

function finding(patch: Partial<DashboardDependencyFinding> = {}): DashboardDependencyFinding {
  return { id: 'finding', kind: 'field', reference: 'example.value', message: SOURCE_REASON, documentIds: ['example-dashboard'], sourceFileName: 'example.view', targetFileName: 'example.view', ...patch };
}

function readiness(findings: DashboardDependencyFinding[], status: DashboardDeploymentTargetReadiness['status'] = 'unverified'): DashboardDeploymentTargetReadiness {
  return { targetId: 'example-target', status, findings, checkedAt: 1, sourceModelIds: ['example-model'], requiredFiles: ['example.view', 'example.topic', 'relationships'], requiredFilesByModelId: { 'example-model': ['example.view', 'example.topic', 'relationships'] } };
}

test('98 repeated observations become one reason group with deduplicated references and complete original detail', () => {
  const findings = Array.from({ length: 98 }, (_, index) => finding({ id: `finding-${index}`, reference: `example.value_${index % 14}`, documentIds: [`example-dashboard-${index}`] }));
  const original = JSON.stringify(findings);
  const review = buildDashboardDependencyReview(readiness(findings));
  assert.equal(review.totalFindings, 98);
  assert.equal(review.unverified.length, 1);
  assert.equal(review.unverified[0].references.length, 14);
  assert.deepEqual(review.unverified[0].findings, findings);
  assert.equal(review.unverified[0].findings[0], findings[0]);
  assert.equal(review.unverified[0].title, 'Source definitions need verification');
  assert.deepEqual(review.differences, []);
  assert.deepEqual(review.ready, []);
  assert.equal(JSON.stringify(findings), original);
});

test('authoritative root causes compact repeated effects but retain independent scope and security blockers', () => {
  const findings = Array.from({ length: 98 }, (_, index) => finding({ id: `effect-${index}`, rootCauseId: 'missing-view', causeCode: 'DESTINATION_VIEW_UNAVAILABLE', category: 'model_migrator', sourceScope: 'shared', reference: `example.field_${index % 14}`, message: `Observation ${index}`, documentIds: [`dashboard-${index % 3}`] }));
  const groups = groupDashboardReadinessCauses([...findings,
    finding({ kind: 'security', rootCauseId: 'missing-view', category: 'model_migrator', sourceScope: 'shared' }),
    finding({ rootCauseId: 'missing-view', category: 'cannot_verify', sourceScope: 'shared' }),
    finding({ rootCauseId: 'missing-view', category: 'model_migrator', sourceScope: 'workbook' }),
  ]);
  assert.equal(groups.length, 4);
  assert.deepEqual(groups[0].findings, findings);
  assert.equal(groups[0].references.length, 14);
  assert.equal(groups[0].documentIds.length, 3);
});

test('cause grouping without server identity only merges exact kind, scope, category and wording', () => {
  const original = finding();
  const groups = groupDashboardReadinessCauses([original, finding({ id: 'duplicate' }), finding({ message: 'Unknown source reason.' }), finding({ kind: 'topic' }), finding({ sourceScope: 'workbook' })]);
  assert.equal(groups.length, 4);
  assert.equal(groups[0].findings.length, 2);
  assert.equal(groups[0].findings[0], original);
});

test('source-file diagnostics remain source issues when an exact topic definition is unavailable', () => {
  const review = buildDashboardDependencyReview(readiness([finding({ kind: 'topic', causeCode: 'SOURCE_FILE_UNAVAILABLE', message: 'The exact source topic definition is unavailable.' })]));
  assert.equal(review.unverified[0].title, 'Source definitions need verification');
  assert.deepEqual(review.differences, []);
});

test('empty findings never synthesize passes for any target status', () => {
  for (const status of ['unverified', 'needs_recheck', 'ready', 'model_changes_required'] as const) {
    assert.deepEqual(buildDashboardDependencyReview(readiness([], status)), { unverified: [], differences: [], ready: [], totalFindings: 0 });
  }
});

test('unresolved source fields offer workbook-local or outdated-reference review without assuming a replacement', () => {
  for (const message of [SOURCE_REASON, 'The authored source definition could not be located. This does not prove the field is absent; review the source model, workbook-local or inherited semantics.']) {
    const state = readiness([finding({ message })]);
    const original = JSON.stringify(state);
    const review = buildDashboardDependencyReview(state);
    const group = review.unverified[0];
    assert.match(group.description, /does not prove the source dashboard is broken or the destination is missing the field/);
    assert.match(group.nextStep, /exact view-qualified field/);
    assert.match(group.nextStep, /Retain intentional workbook-local definitions in their original scope/);
    assert.match(group.nextStep, /review workbook-copy support and staging evidence in the dashboard plan/);
    assert.match(group.nextStep, /dashboard reference is outdated.*dashboard owner confirms the intended field/);
    assert.match(group.nextStep, /similarly named field in another view is not an equivalent replacement without semantic review/);
    assert.match(group.nextStep, /Recheck readiness after reviewed changes or evidence updates/);
    assert.deepEqual(review.differences, []);
    assert.deepEqual(review.ready, []);
    assert.equal(JSON.stringify(state), original);
  }
});

test('source join evidence does not receive field-reference replacement guidance', () => {
  const review = buildDashboardDependencyReview(readiness([finding({ kind: 'view', message: 'The authored source join definition could not be located. Review inherited or workbook-local semantics before preparing a repair.' })]));
  assert.match(review.unverified[0].nextStep, /Resolve the source evidence/);
  assert.doesNotMatch(review.unverified[0].nextStep, /dashboard reference is outdated|promote it/);
});

test('unknown wording stays unverified even when it appears to claim success', () => {
  const review = buildDashboardDependencyReview(readiness([finding({ message: 'All dependencies passed this new inspection.' })], 'ready'));
  assert.equal(review.unverified[0].title, 'Needs verification');
  assert.deepEqual(review.differences, []);
  assert.deepEqual(review.ready, []);
});

test('only scoped direct comparisons on a changes-required target become differences', () => {
  const review = buildDashboardDependencyReview(readiness([
    finding({ id: 'field', message: FIELD_DIFFERENCE }),
    finding({ id: 'join', kind: 'relationship', reference: 'example → related', message: 'A source join path is missing or differs in the destination.', sourceFileName: 'relationships', targetFileName: 'relationships' }),
    finding({ id: 'topic', kind: 'topic', reference: 'example.topic', message: 'The required file has missing or different semantic settings.', sourceFileName: 'example.topic', targetFileName: 'example.topic' }),
  ], 'model_changes_required'));
  assert.deepEqual(review.differences.map((group) => group.title), ['Destination definitions differ', 'Destination joins differ', 'Destination topics differ']);
  assert.equal(review.totalFindings, 3);
  assert.deepEqual(review.unverified, []);
  assert.deepEqual(review.ready, []);
});

test('legacy unverified or stale status cannot promote a known comparison to confirmed differences', () => {
  for (const status of ['unverified', 'needs_recheck', 'ready'] as const) {
    const review = buildDashboardDependencyReview(readiness([finding({ message: FIELD_DIFFERENCE })], status));
    assert.equal(review.unverified.length, 1);
    assert.deepEqual(review.differences, []);
    assert.deepEqual(review.ready, []);
  }
});

test('mixed uncertainties keep every group unverified even alongside a direct comparison', () => {
  const uncertain = [
    finding(),
    finding({ message: 'Unrecognized comparison result.' }),
    finding({ kind: 'security', message: 'A security-sensitive view setting differs and requires explicit review.' }),
    finding({ message: FIELD_DIFFERENCE, sourceFileName: undefined }),
    finding({ message: FIELD_DIFFERENCE, targetFileName: undefined }),
    finding({ message: FIELD_DIFFERENCE, sourceFileName: 'unscoped.view' }),
  ];
  for (const gap of uncertain) {
    const review = buildDashboardDependencyReview(readiness([finding({ id: 'comparison', message: FIELD_DIFFERENCE }), { ...gap, id: 'gap' }], 'model_changes_required'));
    assert.equal(review.unverified.flatMap((group) => group.findings).length, 2);
    assert.deepEqual(review.differences, []);
    assert.deepEqual(review.ready, []);
  }
});

test('exact reasons and kinds remain distinct while uncertain review groups provide concrete next steps', () => {
  const review = buildDashboardDependencyReview(readiness([
    finding({ id: 'proposed', kind: 'model', message: 'Destructive semantic patches cannot be automated.' }),
    finding({ id: 'join', kind: 'relationship', message: 'Multiple join paths require explicit review; readiness cannot choose one automatically.' }),
    finding({ id: 'topic', kind: 'topic', message: 'Topic evidence is not classified.' }),
    finding({ id: 'access', kind: 'security', message: 'Access evidence is not classified.' }),
    finding({ id: 'scope', kind: 'connection', message: 'Connection evidence is not classified.' }),
    finding({ id: 'same-reference-other-kind', kind: 'view', message: SOURCE_REASON }),
    finding({ id: 'same-reference-original-kind' }),
  ]));
  assert.equal(review.unverified.length, 7);
  assert.equal(new Set(review.unverified.map((group) => group.id)).size, 7);
  for (const group of review.unverified) {
    assert.ok(group.title && group.description && group.nextStep);
    assert.equal(group.findings.length, 1);
    assert.deepEqual(group.references, ['example.value']);
  }
  assert.match(review.unverified[0].nextStep, /Inspect the source and destination model definitions in Omni/);
  assert.match(review.unverified[1].nextStep, /Resolve ambiguous paths/);
  assert.deepEqual(review.differences, []);
});
