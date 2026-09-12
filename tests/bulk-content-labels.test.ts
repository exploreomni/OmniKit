import assert from 'node:assert/strict';
import test from 'node:test';

import {
  BULK_CONTENT_LABEL_HEADERS,
  BULK_CONTENT_LABEL_LIMITS,
  BULK_CONTENT_LABELS_CELL_FORMAT,
  BULK_CONTENT_LABEL_TEMPLATE_CSV,
  normalizeBulkContentLabelTarget,
  parseBulkContentLabelsCsv,
} from '../src/services/bulkContentLabels';

const HEADER = 'action,target_type,target_id_or_url,labels';

function issueCodes(csv: string) {
  return parseBulkContentLabelsCsv(csv).issues.map((issue) => issue.code);
}

test('template exports the exact contract and produces a usable plan', () => {
  const plan = parseBulkContentLabelsCsv(BULK_CONTENT_LABEL_TEMPLATE_CSV);

  assert.deepEqual(BULK_CONTENT_LABEL_HEADERS, [
    'action',
    'target_type',
    'target_id_or_url',
    'labels',
  ]);
  assert.equal(plan.blocked, false);
  assert.deepEqual(plan.operations[0].labels, ['Certified, Reviewed', 'Executive']);
  assert.deepEqual(plan.summary, {
    sourceRows: 2,
    acceptedRows: 2,
    mergedRows: 0,
    uniqueTargets: 2,
    operations: 2,
    labelsToAdd: 2,
    labelsToRemove: 1,
    conflicts: 0,
  });
});

test('uses the identity-import escape convention for literal commas and backslashes', () => {
  const plan = parseBulkContentLabelsCsv([
    HEADER,
    String.raw`add,document,Reference-001,"Finance\, North, Path\\Team, finance\, north"`,
  ].join('\n'));

  assert.match(BULK_CONTENT_LABELS_CELL_FORMAT, /literal comma/);
  assert.match(BULK_CONTENT_LABELS_CELL_FORMAT, /literal backslash/);
  assert.equal(plan.blocked, false);
  assert.deepEqual(plan.operations[0].labels, ['Finance, North', 'Path\\Team']);
});

test('reports unsupported and incomplete label escapes on their physical rows', () => {
  const invalidEscape = parseBulkContentLabelsCsv([
    HEADER,
    String.raw`add,document,reference-1,"Finance\q"`,
  ].join('\n'));
  const incompleteEscape = parseBulkContentLabelsCsv([
    HEADER,
    String.raw`add,document,reference-2,"Finance\"`,
  ].join('\n'));

  assert.deepEqual(invalidEscape.issues.map((issue) => [issue.code, issue.rowNumber]), [
    ['LABEL_ESCAPE_INVALID', 2],
  ]);
  assert.deepEqual(incompleteEscape.issues.map((issue) => [issue.code, issue.rowNumber]), [
    ['LABEL_ESCAPE_INCOMPLETE', 2],
  ]);
});

test('parses BOM, CRLF, case-insensitive enums, quoted label lists, and escaped quotes', () => {
  const plan = parseBulkContentLabelsCsv([
    `\uFEFF${HEADER}`,
    'ADD,DoCuMeNt,01234567-89AB-4DEF-8ABC-0123456789AB," Executive , executive, Finance "',
    'remove,FOLDER,https://EXAMPLE.invalid/folders/Example,"Legacy, ""Needs review"""',
  ].join('\r\n'));

  assert.equal(plan.blocked, false);
  assert.deepEqual(plan.rows, [
    {
      rowNumber: 2,
      action: 'add',
      targetType: 'document',
      targetIdOrUrl: '01234567-89AB-4DEF-8ABC-0123456789AB',
      normalizedTarget: '01234567-89ab-4def-8abc-0123456789ab',
      labels: ['Executive', 'Finance'],
    },
    {
      rowNumber: 3,
      action: 'remove',
      targetType: 'folder',
      targetIdOrUrl: 'https://EXAMPLE.invalid/folders/Example',
      normalizedTarget: 'https://example.invalid/folders/Example',
      labels: ['Legacy', '"Needs review"'],
    },
  ]);
});

test('accepts opaque reference strings and normalizes only their comparison value', () => {
  const plan = parseBulkContentLabelsCsv([
    HEADER,
    'add,document,Reference-001,Certified',
  ].join('\n'));

  assert.equal(plan.blocked, false);
  assert.equal(plan.rows[0].targetIdOrUrl, 'Reference-001');
  assert.equal(plan.rows[0].normalizedTarget, 'reference-001');
  assert.equal(normalizeBulkContentLabelTarget(' Reference-001 '), 'reference-001');
});

test('merges compatible duplicate rows and preserves all source row numbers', () => {
  const plan = parseBulkContentLabelsCsv([
    HEADER,
    'add,document,Reference-001,"Certified, Finance"',
    'ADD,DOCUMENT,reference-001,"finance, Executive"',
    'add,document,REFERENCE-001,Certified',
  ].join('\n'));

  assert.equal(plan.blocked, false);
  assert.equal(plan.operations.length, 1);
  assert.deepEqual(plan.operations[0], {
    action: 'add',
    targetType: 'document',
    targetIdOrUrl: 'Reference-001',
    normalizedTarget: 'reference-001',
    labels: ['Certified', 'Finance', 'Executive'],
    rowNumbers: [2, 3, 4],
  });
  assert.equal(plan.summary.mergedRows, 2);
});

test('blocks add/remove conflicts using normalized targets and labels with exact provenance', () => {
  const plan = parseBulkContentLabelsCsv([
    HEADER,
    'add,document,REFERENCE-1,"Caf\u00e9, Other"',
    'add,document,reference-1,Another',
    'remove,DOCUMENT,reference-1,Cafe\u0301',
    'remove,document,REFERENCE-1,Different',
  ].join('\n'));

  assert.equal(plan.blocked, true);
  assert.equal(plan.summary.conflicts, 1);
  const conflict = plan.issues.find((issue) => issue.code === 'CONFLICTING_ACTIONS');
  assert.ok(conflict);
  assert.deepEqual(conflict.labels, ['Caf\u00e9']);
  assert.deepEqual(conflict.rowNumbers, [2, 4]);
  assert.equal(conflict.targetType, 'document');
  assert.equal(conflict.targetIdOrUrl, 'REFERENCE-1');
});

test('requires the exact headers, including order and casing', () => {
  for (const header of [
    'action,target_type,target_id_or_url',
    'action,target_type,target_id_or_url,labels,notes',
    'target_type,action,target_id_or_url,labels',
    'Action,target_type,target_id_or_url,labels',
    'action,target_type,target_id_or_url,target_id_or_url',
  ]) {
    assert.throws(
      () => parseBulkContentLabelsCsv(`${header}\nadd,document,reference-1,Certified`),
      /CSV headers must be exactly/,
      header,
    );
  }
});

test('rejects malformed CSV quoting before planning rows', () => {
  for (const csv of [
    `${HEADER}\nadd,document,reference-1,"Certified`,
    `${HEADER}\nadd,docu"ment,reference-1,Certified`,
    `${HEADER}\nadd,document,reference-1,"Certified"unexpected`,
  ]) {
    assert.throws(() => parseBulkContentLabelsCsv(csv), /CSV contains/);
  }
});

test('rejects blank physical lines with the exact line number', () => {
  const csv = [
    HEADER,
    'add,document,reference-1,Certified',
    '',
    'remove,folder,reference-2,Legacy',
  ].join('\r\n');

  assert.throws(
    () => parseBulkContentLabelsCsv(csv),
    /blank line at physical line 3/,
  );
});

test('uses physical start lines for later operations after a multiline quoted row', () => {
  const plan = parseBulkContentLabelsCsv([
    HEADER,
    'add,document,reference-1,"Certified',
    'Review"',
    'remove,folder,reference-2,Legacy',
  ].join('\n'));

  assert.equal(plan.blocked, true);
  assert.deepEqual(plan.issues.map((issue) => [issue.code, issue.rowNumber]), [
    ['LABEL_CONTROL_CHARACTER', 2],
  ]);
  assert.deepEqual(plan.operations[0].rowNumbers, [4]);
});

test('reports missing, invalid, empty, and unquoted row values as blocking issues', () => {
  const csv = [
    HEADER,
    ',document,reference-1,Certified',
    'update,document,reference-2,Certified',
    'add,,reference-3,Certified',
    'add,dashboard,reference-4,Certified',
    'add,document,,Certified',
    'add,document,reference-6,',
    'add,document,reference-7,"Certified,,Finance"',
    'add,document,reference-8,Certified,Finance',
  ].join('\n');
  const plan = parseBulkContentLabelsCsv(csv);

  assert.equal(plan.blocked, true);
  assert.equal(plan.rows.length, 0);
  assert.deepEqual(issueCodes(csv), [
    'ACTION_REQUIRED',
    'ACTION_INVALID',
    'TARGET_TYPE_REQUIRED',
    'TARGET_TYPE_INVALID',
    'TARGET_REQUIRED',
    'LABELS_REQUIRED',
    'LABEL_EMPTY',
    'ROW_FIELD_COUNT_INVALID',
  ]);
});

test('rejects target and label values outside their safety bounds', () => {
  const tooLongTarget = 't'.repeat(BULK_CONTENT_LABEL_LIMITS.maxTargetLength + 1);
  const tooShortLabel = 'x'.repeat(BULK_CONTENT_LABEL_LIMITS.minLabelLength - 1);
  const tooLongLabel = 'l'.repeat(BULK_CONTENT_LABEL_LIMITS.maxLabelLength + 1);
  const tooManyLabels = Array.from(
    { length: BULK_CONTENT_LABEL_LIMITS.maxLabelsPerRow + 1 },
    (_, index) => `Label ${index + 1}`,
  ).join(',');
  const plan = parseBulkContentLabelsCsv([
    HEADER,
    `add,document,${tooLongTarget},Certified`,
    `add,document,reference-1,${tooShortLabel}`,
    `add,document,reference-2,${tooLongLabel}`,
    `add,document,reference-3,"${tooManyLabels}"`,
    'add,document,"reference\n4",Certified',
    'add,document,reference-5,"Certified\nReview"',
  ].join('\n'));

  assert.equal(plan.blocked, true);
  assert.deepEqual(plan.issues.map((issue) => issue.code), [
    'TARGET_TOO_LONG',
    'LABEL_TOO_SHORT',
    'LABEL_TOO_LONG',
    'LABELS_PER_ROW_LIMIT',
    'TARGET_CONTROL_CHARACTER',
    'LABEL_CONTROL_CHARACTER',
  ]);
});

test('accepts label names at the documented two- and twenty-five-character boundaries', () => {
  const minimumLabel = 'x'.repeat(BULK_CONTENT_LABEL_LIMITS.minLabelLength);
  const maximumLabel = 'x'.repeat(BULK_CONTENT_LABEL_LIMITS.maxLabelLength);
  const plan = parseBulkContentLabelsCsv([
    HEADER,
    `add,folder,reference-1,"${minimumLabel},${maximumLabel}"`,
  ].join('\n'));

  assert.equal(plan.blocked, false);
  assert.deepEqual(plan.operations[0].labels, [minimumLabel, maximumLabel]);
});

test('enforces source-row and accepted-label-intent limits', () => {
  const tooManyRows = [
    HEADER,
    ...Array.from(
      { length: BULK_CONTENT_LABEL_LIMITS.maxRows + 1 },
      (_, index) => `add,document,reference-${index + 1},Certified`,
    ),
  ].join('\n');
  assert.throws(
    () => parseBulkContentLabelsCsv(tooManyRows),
    new RegExp(`${BULK_CONTENT_LABEL_LIMITS.maxRows.toLocaleString()} data rows`),
  );

  const fiftyLabels = Array.from(
    { length: BULK_CONTENT_LABEL_LIMITS.maxLabelsPerRow },
    (_, index) => `Label ${index + 1}`,
  ).join(',');
  const tooManyIntents = [
    HEADER,
    ...Array.from(
      { length: BULK_CONTENT_LABEL_LIMITS.maxTotalLabelIntents / BULK_CONTENT_LABEL_LIMITS.maxLabelsPerRow },
      (_, index) => `add,document,reference-${index + 1},"${fiftyLabels}"`,
    ),
    'add,document,reference-over-limit,One more',
  ].join('\n');
  const plan = parseBulkContentLabelsCsv(tooManyIntents);

  assert.equal(plan.blocked, true);
  assert.ok(plan.issues.some((issue) => issue.code === 'TOTAL_LABEL_INTENT_LIMIT'));
});

test('rejects pasted CSV content above the byte limit before parsing records', () => {
  const oversized = `${HEADER}\nadd,document,reference-1,${'x'.repeat(BULK_CONTENT_LABEL_LIMITS.maxBytes)}`;
  assert.throws(
    () => parseBulkContentLabelsCsv(oversized),
    /CSV imports are limited to 5 MB/,
  );
});

test('rejects an empty file and a header-only file', () => {
  assert.throws(() => parseBulkContentLabelsCsv(''), /header and at least one data row/);
  assert.throws(() => parseBulkContentLabelsCsv(HEADER), /at least one data row/);
});
