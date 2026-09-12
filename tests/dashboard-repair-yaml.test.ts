import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parse } from 'yaml';
import {
  DashboardRepairYamlConflictError,
  assertDashboardRepairYamlIsAdditive,
  assertDashboardRepairYamlPreservesTarget,
  mergeDashboardRepairYaml,
  previewDashboardRepairYaml,
} from '../server/services/dashboardRepairYaml';

const sourceYaml = `dimensions:
  id:
    label: Existing ID
    sql: target.id
  added:
    sql: source.added
`;
const targetYaml = `# Authored destination model
label: Destination label # Keep this label
dimensions:
  # Authored identifier
  id:
    sql: target.id # Identifier calculation
    label: Existing ID
  target_only:
    sql: target.only
    description: Destination business definition
`;

test('additive draft preserves every destination byte and previews additions and exact matches', () => {
  const preview = previewDashboardRepairYaml(targetYaml, sourceYaml);
  assert.ok(preview.yaml.startsWith(targetYaml));
  const data = parse(preview.yaml);
  assert.equal(data.label, 'Destination label');
  assert.deepEqual(data.dimensions.target_only, { sql: 'target.only', description: 'Destination business definition' });
  assert.deepEqual(data.dimensions.id, { sql: 'target.id', label: 'Existing ID' });
  assert.equal(data.dimensions.added.sql, 'source.added');
  assert.deepEqual(preview.additions, ['$["dimensions"]["added"]']);
  assert.deepEqual(preview.skipped, ['$["dimensions"]["id"]']);
  assert.doesNotThrow(() => assertDashboardRepairYamlIsAdditive({ sourceYaml, targetYaml, acceptedYaml: preview.yaml }));
});

test('semantic no-op returns exact target bytes including quotes, comments, order, and CRLF', () => {
  const target = '# Note\r\nlabel: "Destination"\r\ndimensions: { id: { sql: target.id, label: \'Existing ID\' } } # Keep\r\n';
  const proposed = 'dimensions:\n  id:\n    label: Existing ID\n    sql: target.id\nlabel: Destination\n';
  const preview = previewDashboardRepairYaml(target, proposed);
  assert.equal(preview.yaml, target);
  assert.deepEqual(preview.additions, []);
  assert.deepEqual(preview.skipped, ['$["dimensions"]["id"]']);
  assert.equal(mergeDashboardRepairYaml(target, 'measures: {}\nrelationships: []\n'), target);
});

test('source-overlapping scalar changes and added or removed field properties are conflicts', () => {
  for (const proposed of [
    'dimensions:\n  id: { sql: source.id, label: Existing ID }\n',
    'dimensions:\n  id: { sql: target.id }\n',
    'dimensions:\n  id: { sql: target.id, label: Existing ID, description: Added behavior }\n',
    'dimensions:\n  id: { sql: target.id, label: Different label }\n',
  ]) {
    assert.throws(() => mergeDashboardRepairYaml(targetYaml, proposed), (error) => {
      assert.ok(error instanceof DashboardRepairYamlConflictError);
      assert.equal(error.statusCode, 409);
      assert.equal(error.code, 'DASHBOARD_REPAIR_YAML_CONFLICT');
      return true;
    });
  }
});

test('accepted output cannot change or delete source-overlapping or target-only definitions', () => {
  const merged = mergeDashboardRepairYaml(targetYaml, sourceYaml);
  const changed = [
    sourceYaml,
    merged.replace('target.id', 'source.id'),
    merged.replace('Existing ID', 'Changed label'),
    merged.replace('target.only', 'source.other'),
    merged.replace('    label: Existing ID\n', ''),
    merged.replace('    label: Existing ID\n', '    label: Existing ID\n    hidden: true\n'),
  ];
  for (const acceptedYaml of changed) {
    assert.throws(() => assertDashboardRepairYamlPreservesTarget({ sourceYaml, targetYaml, acceptedYaml }), /destination/);
  }
});

test('accepted output retains authored node, key, and document comments', () => {
  const merged = mergeDashboardRepairYaml(targetYaml, sourceYaml);
  for (const comment of ['# Authored destination model\n', '# Keep this label', '# Authored identifier', '# Identifier calculation']) {
    assert.throws(() => assertDashboardRepairYamlPreservesTarget({ sourceYaml, targetYaml, acceptedYaml: merged.replace(comment, '') }), /comment/);
  }
});

test('ordinary lists and root behavior metadata are immutable, even when source overlaps', () => {
  const target = 'fields:\n  - existing.id # Keep field\n  - common.id\nprimary_key: id\n';
  const proposals = [
    'fields: [existing.id, common.id, added.id]\n',
    'fields: [common.id, existing.id]\n',
    'fields: [common.id]\n',
    'primary_key: other_id\n',
  ];
  for (const proposed of proposals) assert.throws(() => mergeDashboardRepairYaml(target, proposed), /cannot modify/);
  assert.equal(mergeDashboardRepairYaml(target, 'fields: [existing.id, common.id]\n'), target);
  for (const accepted of [target.replace('  - common.id\n', ''), target.replace('primary_key: id', 'primary_key: other_id')]) {
    assert.throws(() => assertDashboardRepairYamlIsAdditive({ sourceYaml: accepted, targetYaml: target, acceptedYaml: accepted }), /destination/);
  }
});

test('new root properties are not mistaken for additive semantic definitions', () => {
  const target = 'dimensions:\n  id: { sql: target.id }\n';
  for (const property of ['primary_key: id', 'label: Changed root', 'hidden: true', 'fields: [added.id]', 'joins: {}', 'access_filters: []']) {
    assert.throws(() => mergeDashboardRepairYaml(target, `${property}\n`), /cannot add destination property/);
    assert.throws(() => assertDashboardRepairYamlIsAdditive({ sourceYaml: `${property}\n`, targetYaml: target, acceptedYaml: `${target}${property}\n` }), /cannot add destination property/);
  }
});

test('field and root additions at the same source offset stay in the correct containers', () => {
  const target = '# Note\ndimensions:\n  id: { sql: target.id }\n';
  const proposed = 'dimensions:\n  added: { sql: source.added }\nmeasures:\n  count: { aggregate_type: count }\n';
  const preview = previewDashboardRepairYaml(target, proposed);
  assert.ok(preview.yaml.startsWith(target));
  assert.deepEqual(parse(preview.yaml), {
    dimensions: { id: { sql: 'target.id' }, added: { sql: 'source.added' } },
    measures: { count: { aggregate_type: 'count' } },
  });
  assert.equal(preview.additions.length, 2);
});

test('additions do not reformat unrelated sibling nodes or normalize CRLF', () => {
  const target = '# Note\r\ndimensions:\r\n    id: { sql: "target.id" } # Keep\r\nlabel: \'Destination\' # Sibling\r\n';
  const accepted = mergeDashboardRepairYaml(target, 'dimensions:\n  added: { sql: source.added }\n');
  assert.ok(accepted.startsWith('# Note\r\ndimensions:\r\n    id: { sql: "target.id" } # Keep\r\n'));
  assert.ok(accepted.endsWith("label: 'Destination' # Sibling\r\n"));
  assert.equal(accepted.replace(/\r\n/g, '').includes('\n'), false);
  assert.equal(parse(accepted).dimensions.added.sql, 'source.added');
});

test('flow collections only reformat the changed collection, preserving surrounding bytes', () => {
  const target = '# Note\ndimensions: { id: { sql: "target.id" } } # Keep dimension note\nlabel: \'Destination\'\n';
  const accepted = mergeDashboardRepairYaml(target, 'dimensions:\n  added: { sql: source.added }\n');
  assert.ok(accepted.startsWith('# Note\ndimensions: '));
  assert.ok(accepted.endsWith(" # Keep dimension note\nlabel: 'Destination'\n"));
  assert.equal(parse(accepted).dimensions.added.sql, 'source.added');
  const nested = mergeDashboardRepairYaml('{ dimensions: { id: { sql: target.id } } }\n', 'dimensions:\n  added: { sql: source.added }\nmeasures:\n  count: { aggregate_type: count }\n');
  assert.equal(parse(nested).dimensions.added.sql, 'source.added');
  assert.equal(parse(nested).measures.count.aggregate_type, 'count');
});

test('an authored empty dimensions map can receive new definitions', () => {
  const target = 'dimensions: {} # Empty authored collection\nlabel: Destination\n';
  const accepted = mergeDashboardRepairYaml(target, 'dimensions:\n  added: { sql: source.added }\n');
  assert.equal(parse(accepted).dimensions.added.sql, 'source.added');
  assert.match(accepted, /# Empty authored collection/);
});

test('new files retain the proposed bytes after YAML validation', () => {
  const proposed = '# New dependency\nlabel: "Source label"\nbase_view: source_view\n';
  assert.deepEqual(previewDashboardRepairYaml(undefined, proposed), { yaml: proposed, additions: ['$'], skipped: [] });
  assert.doesNotThrow(() => assertDashboardRepairYamlIsAdditive({ sourceYaml: proposed, acceptedYaml: proposed }));
});

test('invalid, duplicate-key, alias-bearing, complex-key, and destructive YAML fails closed', () => {
  for (const invalid of ['invalid: [', 'duplicate: 1\nduplicate: 2\n', 'one: &anchor { id: 1 }\ntwo: *anchor\n', '- sequence root\n', '? [one, two]\n: value\n', '!!set {one, two}\n']) {
    assert.throws(() => mergeDashboardRepairYaml(targetYaml, invalid));
    assert.throws(() => assertDashboardRepairYamlIsAdditive({ sourceYaml, targetYaml, acceptedYaml: invalid }));
  }
  for (const proposed of ['dimensions: null\n', 'dimensions: []\n']) assert.throws(() => mergeDashboardRepairYaml(targetYaml, proposed));
  assert.throws(() => mergeDashboardRepairYaml('dimensions: null\n', 'dimensions:\n  added: { sql: source.added }\n'));
});

const relationshipTarget = `# Authored relationships
- join_from_view: source_view
  join_to_view: related_view
  on_sql: source_view.id = related_view.id # Authored join note
  relationship_type: many_to_one
  join_type: left
- join_from_view: source_view
  join_to_view: related_view
  join_to_view_alias: alternate
  on_sql: source_view.alternate_id = alternate.id
`;
const existingRelationship = `- join_from_view: source_view
  join_to_view: related_view
  on_sql: source_view.id = related_view.id
  relationship_type: many_to_one
  join_type: left
`;
const newRelationship = `- join_from_view: related_view
  join_to_view: added_view
  on_sql: related_view.id = added_view.id
  relationship_type: one_to_many
`;

test('relationship additions append new identities and skip exact existing edges without changing their bytes', () => {
  const preview = previewDashboardRepairYaml(relationshipTarget, existingRelationship + newRelationship);
  assert.ok(preview.yaml.startsWith(relationshipTarget));
  assert.equal(parse(preview.yaml).length, 3);
  assert.equal(preview.additions.length, 1);
  assert.equal(preview.skipped.length, 1);
  assert.doesNotThrow(() => assertDashboardRepairYamlIsAdditive({ sourceYaml: existingRelationship + newRelationship, targetYaml: relationshipTarget, acceptedYaml: preview.yaml }));
  assert.equal(mergeDashboardRepairYaml(relationshipTarget, existingRelationship), relationshipTarget);
});

test('existing relationship condition, cardinality, type, and additional properties are atomic', () => {
  for (const proposed of [
    existingRelationship.replace('source_view.id', 'source_view.other_id'),
    existingRelationship.replace('many_to_one', 'one_to_one'),
    existingRelationship.replace('join_type: left', 'join_type: inner'),
    existingRelationship.replace('  join_type: left\n', ''),
    `${existingRelationship}  label: New label\n`,
    `${existingRelationship}  arbitrary_alias: duplicate_escape\n`,
  ]) assert.throws(() => mergeDashboardRepairYaml(relationshipTarget, proposed), /cannot modify/);
});

test('accepted relationship edits, deletions, reordering, and identity changes cannot replace existing edges', () => {
  const accepted = mergeDashboardRepairYaml(relationshipTarget, newRelationship);
  for (const changed of [
    accepted.replace('many_to_one', 'one_to_one'),
    accepted.replace('source_view.id = related_view.id', 'source_view.other_id = related_view.id'),
    accepted.replace('  join_type: left\n', '  join_type: left\n  label: New label\n'),
    accepted.replace('join_to_view_alias: alternate', 'join_to_view_alias: changed'),
    newRelationship,
    newRelationship + relationshipTarget,
  ]) assert.throws(() => assertDashboardRepairYamlIsAdditive({ sourceYaml: changed, targetYaml: relationshipTarget, acceptedYaml: changed }), /destination/);
});

test('documented view aliases distinguish genuinely new relationship edges', () => {
  const proposed = `${existingRelationship}  join_to_view_alias: new_role\n`;
  const accepted = mergeDashboardRepairYaml(relationshipTarget, proposed);
  assert.equal(parse(accepted).length, 3);
  assert.equal(parse(accepted)[2].join_to_view_alias, 'new_role');
  assert.ok(accepted.startsWith(relationshipTarget));
});

test('nested relationship containers allow only complete, unique append-only identities', () => {
  const nested = (edges: string) => `relationships:\n${edges.split('\n').filter(Boolean).map((line) => `  ${line}`).join('\n')}\n`;
  const target = nested(existingRelationship);
  const accepted = mergeDashboardRepairYaml(target, nested(newRelationship));
  assert.equal(parse(accepted).relationships.length, 2);
  assert.ok(accepted.startsWith(target));
  assert.throws(() => mergeDashboardRepairYaml(target, 'relationships:\n  - name: unknown\n    sql_on: left.id = right.id\n'), /complete/);
  assert.throws(() => mergeDashboardRepairYaml(target, nested(`${newRelationship}${newRelationship}`)), /duplicate relationship/);
  assert.throws(() => mergeDashboardRepairYaml(target, nested(`${newRelationship}  join_to_view_alias: null\n`)), /complete/);
});

test('duplicate relationship identities with changed conditions or fake aliases cannot append', () => {
  for (const duplicate of [
    `${existingRelationship}${existingRelationship.replace('source_view.id', 'source_view.other_id')}`,
    `${existingRelationship}${existingRelationship}  arbitrary_alias: escape\n`,
  ]) {
    assert.throws(() => mergeDashboardRepairYaml(relationshipTarget, duplicate), /duplicate relationship/);
    assert.throws(() => assertDashboardRepairYamlIsAdditive({ sourceYaml: existingRelationship, targetYaml: relationshipTarget, acceptedYaml: duplicate }), /duplicate relationship/);
  }
});

test('preservation checks permit reviewed translation of new definitions but never existing ones', () => {
  const accepted = mergeDashboardRepairYaml(targetYaml, sourceYaml).replace('source.added', 'destination.added');
  assert.doesNotThrow(() => assertDashboardRepairYamlIsAdditive({ sourceYaml, targetYaml, acceptedYaml: accepted }));
});
