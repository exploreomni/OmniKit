import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { isAlias, isMap, isNode, isScalar, isSeq, parseDocument } from 'yaml';
import type { TopicBranchComparison, TopicBranchFileComparison, TopicMigrationFile } from '../../shared/topicMigration';
import { assertUniqueTopicExportKey, topicYamlWriteFileName } from './modelMigration/topicFileIdentity';

export const TOPIC_BRANCH_COMPARISON_POLICY = 'topic_branch_readback_v1' as const;
const namespace = /^[A-Za-z_][\w$-]*(?:\.[A-Za-z_][\w$-]*){0,2}$/;
const safePath = (name: string) => typeof name === 'string' && name.length > 0 && name.length <= 512
  && !name.includes('\\') && ![...name].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  && name.split('/').every(part => part && part !== '.' && part !== '..');
const snapshotHash = (files: Record<string, string>) => 'sha256:' + createHash('sha256')
  .update(JSON.stringify(Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))))).digest('hex');

/** Compare presentation, not loose JavaScript coercion. SQL/string values and sequence order remain exact. */
function yamlEvidence(text: string) {
  if (typeof text !== 'string' || text.length > 2_000_000) throw new Error('YAML exceeds the verification limit.');
  const document = parseDocument(text, { uniqueKeys: true, strict: true, prettyErrors: false, intAsBigInt: true });
  if (document.errors.length || document.warnings.length || (!isMap(document.contents) && !isSeq(document.contents))) {
    throw new Error('YAML must be an unambiguous mapping or sequence.');
  }
  let count = 0;
  const comments: Array<[string, string, string]> = [];
  const note = (node: { commentBefore?: string | null; comment?: string | null }, path: string[]) => {
    if (node.commentBefore) comments.push([JSON.stringify(path), 'before', node.commentBefore]);
    if (node.comment) comments.push([JSON.stringify(path), 'after', node.comment]);
  };
  note(document, ['document']);
  const walk = (node: unknown, path: string[]): unknown => {
    if (++count > 25_000 || path.length > 64) throw new Error('YAML exceeds the verification complexity limit.');
    if (isAlias(node) || (isNode(node) && 'anchor' in node && node.anchor)) throw new Error('YAML aliases and anchors are not eligible for formatting equivalence.');
    if (isNode(node)) {
      if (node.tag && !/^tag:yaml\.org,2002:(?:map|seq|str|int|float|bool|null)$/.test(node.tag)) throw new Error('Unsupported YAML tag.');
      note(node, path);
    }
    if (isMap(node)) {
      const pairs = node.items.map(pair => {
        if (!isScalar(pair.key) || typeof pair.key.value !== 'string' || ['__proto__', 'prototype', 'constructor', '<<'].includes(pair.key.value)) {
          throw new Error('YAML needs safe, unique string keys.');
        }
        const key = pair.key.value;
        // Validate key tags/anchors and retain their comments too.
        walk(pair.key, [...path, key, 'key']);
        return [key, walk(pair.value, [...path, key, 'value'])] as const;
      }).sort(([a], [b]) => a.localeCompare(b));
      return ['map', pairs];
    }
    if (isSeq(node)) return ['seq', node.items.map((child, index) => walk(child, [...path, String(index)]))];
    if (node === null || node === undefined) return ['null'];
    if (!isScalar(node)) throw new Error('Unsupported YAML node.');
    const value: unknown = node.value;
    if (value === null) return ['null'];
    if (typeof value === 'string' || typeof value === 'boolean') return [typeof value, value];
    if (typeof value === 'bigint') return ['integer', value.toString()];
    // Require exact float spelling: do not equate values rounded by JavaScript.
    if (typeof value === 'number' && Number.isFinite(value)) return ['number', node.source, Object.is(value, -0) ? '-0' : value];
    throw new Error('Unsupported scalar value.');
  };
  const value = walk(document.contents, ['root']);
  comments.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  return { document, value, comments };
}

/** Only an explicit namespace-folder mapping, corroborated by authored destination fields, may change a path. */
export function topicMigrationDestinationPath(file: Pick<TopicMigrationFile, 'sourceFileName' | 'fileName' | 'kind' | 'proposed' | 'destinationFileName'>, schemaMapText: string): string {
  if (!safePath(file.sourceFileName) || !safePath(file.fileName)) throw new Error('Unsafe authored file path.');
  const rules = schemaMapText.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => {
    const parts = line.split(/\s*(?:->|=>|,)\s*/);
    if (parts.length !== 2 || parts.some(part => !namespace.test(part))) throw new Error('Unsupported namespace mapping.');
    return { source: parts[0], target: parts[1] };
  });
  if (new Set(rules.map(rule => rule.source.toLowerCase())).size !== rules.length) throw new Error('Ambiguous namespace mapping.');
  let expected = file.sourceFileName;
  if (file.kind === 'view') {
    const slash = file.sourceFileName.lastIndexOf('/');
    const folder = file.sourceFileName.slice(0, slash);
    const rule = slash >= 0 ? rules.find(candidate => candidate.source === folder) : undefined;
    if (rule && rule.source !== rule.target) {
      const { document } = yamlEvidence(file.proposed);
      if (!isMap(document.contents)) throw new Error('Mapped views require an authored mapping.');
      const catalog = document.get('catalog'), database = document.get('database'), schema = document.get('schema');
      if (catalog !== undefined && database !== undefined && catalog !== database) throw new Error('Mapped catalog and database disagree.');
      const prefix = catalog ?? database;
      const authored = prefix === undefined ? schema : typeof prefix === 'string' && typeof schema === 'string' ? `${prefix}.${schema}` : undefined;
      if (authored !== rule.target) throw new Error('The mapped folder does not match the authored destination namespace.');
      expected = `${rule.target}/${file.sourceFileName.slice(slash + 1)}`;
    }
  }
  if (file.fileName !== file.sourceFileName && file.fileName !== expected) throw new Error('Submitted path is not authorized by the reviewed namespace mapping.');
  if (file.destinationFileName !== undefined && file.destinationFileName !== expected) throw new Error('Expected destination path disagrees with the reviewed namespace mapping.');
  return expected;
}

/** Post-write only. Prewrite baselines and approval hashes must remain exact. No I/O or write capability. */
export function compareTopicMigrationBranch(input: {
  files: TopicMigrationFile[]; schemaMapText: string; baseline: Record<string, string>; actual: Record<string, string>;
}): TopicBranchComparison {
  const findings: TopicBranchComparison['findings'] = [];
  const files: TopicBranchFileComparison[] = [];
  const expected = { ...input.baseline };
  const writes = new Map<string, TopicMigrationFile>();
  const issue = (code: string, message: string, fileName?: string) => findings.push({ code, message, ...(fileName ? { fileName } : {}) });
  if (input.files.length > 5000 || Object.keys(input.actual).length > 5000 || Object.keys(input.baseline).length > 5000) {
    issue('INVENTORY_LIMIT', 'The branch inventory exceeds the bounded verification limit.');
    return { policy: TOPIC_BRANCH_COMPARISON_POLICY, verified: false, expectedHash: snapshotHash(expected), actualHash: null, files, findings };
  }
  for (const file of input.files.filter(file => file.status === 'create' || file.status === 'add')) {
    let destination: string;
    try { destination = topicMigrationDestinationPath(file, input.schemaMapText); }
    catch (error) { issue('PATH_MAPPING_INVALID', error instanceof Error ? error.message : 'Invalid destination mapping.', file.fileName); continue; }
    if (file.kind === 'topic') {
      try {
        assertUniqueTopicExportKey(destination, input.baseline);
        assertUniqueTopicExportKey(destination, input.actual);
        if (file.writeFileName !== undefined && topicYamlWriteFileName(destination, file.proposed) !== file.writeFileName) {
          throw new Error('The reviewed topic write name does not match its exported identity.');
        }
      } catch (error) {
        issue('TOPIC_IDENTITY_CONFLICT', error instanceof Error ? error.message : 'Ambiguous topic identity.', destination);
        continue;
      }
    }
    if ([...writes.keys()].some(name => name.toLowerCase() === destination.toLowerCase())) {
      issue('PATH_COLLISION', 'Multiple approved files resolve to the same destination.', destination); continue;
    }
    const baselineNames = Object.keys(input.baseline);
    if (baselineNames.some(name => name !== destination && name.toLowerCase() === destination.toLowerCase())
      || (file.sourceFileName !== destination && Object.hasOwn(input.baseline, file.sourceFileName))) {
      issue('PATH_COLLISION', 'The mapped destination would rename or conflict with an existing file.', destination); continue;
    }
    if (file.before === null ? Object.hasOwn(input.baseline, destination) : input.baseline[destination] !== file.before) {
      issue('BASELINE_MISMATCH', 'The file does not match its exact reviewed destination baseline.', destination); continue;
    }
    writes.set(destination, file); expected[destination] = file.proposed;
  }
  for (const name of Object.keys(input.actual)) {
    if (!safePath(name) || typeof input.actual[name] !== 'string') issue('INVALID_FILE', 'The returned branch inventory is malformed.', name);
    else if (!Object.hasOwn(expected, name)) issue('UNEXPECTED_FILE', 'An unrelated or incorrectly located file is present.', name);
  }
  for (const [name, yaml] of Object.entries(expected)) {
    const file = writes.get(name);
    const compared: TopicBranchFileComparison | undefined = file ? { sourceFileName: file.sourceFileName,
      submittedFileName: file.writeFileName ?? file.fileName, destinationFileName: name,
      classification: file.sourceFileName === name ? 'exact' : 'mapped_path' } : undefined;
    if (compared) files.push(compared);
    if (!Object.hasOwn(input.actual, name)) {
      issue('MISSING_FILE', 'An expected file is missing from the branch.', name); if (compared) compared.classification = 'mismatch'; continue;
    }
    if (input.actual[name] === yaml) continue;
    if (!file) { issue('UNRELATED_FILE_CHANGED', 'An untouched destination file changed.', name); continue; }
    try {
      const approved = yamlEvidence(yaml), actual = yamlEvidence(input.actual[name]);
      if (!isDeepStrictEqual(approved.value, actual.value)) issue('YAML_VALUE_CHANGED', 'The returned YAML changes an approved value, type, or sequence.', name);
      else if (!isDeepStrictEqual(approved.comments, actual.comments)) issue('YAML_COMMENTS_CHANGED', 'Approved comments were changed, lost, or moved; review is required.', name);
      else { compared!.classification = file.sourceFileName === name ? 'formatting_only' : 'mapped_path_and_formatting'; continue; }
    } catch { issue('YAML_AMBIGUOUS', 'The returned YAML cannot be safely compared for formatting-only changes.', name); }
    compared!.classification = 'mismatch';
  }
  return { policy: TOPIC_BRANCH_COMPARISON_POLICY, verified: findings.length === 0, expectedHash: snapshotHash(expected),
    actualHash: Object.values(input.actual).every(value => typeof value === 'string') ? snapshotHash(input.actual) : null, files, findings };
}
