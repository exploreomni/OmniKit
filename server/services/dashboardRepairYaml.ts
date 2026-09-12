import { isDeepStrictEqual } from 'node:util';
import { Document, isAlias, isMap, isNode, isScalar, isSeq, parseDocument, visit, type YAMLMap, type YAMLSeq } from 'yaml';

export class DashboardRepairYamlConflictError extends Error {
  readonly statusCode = 409;
  readonly code = 'DASHBOARD_REPAIR_YAML_CONFLICT';
}

function reject(message: string): never {
  throw new DashboardRepairYamlConflictError(message);
}

function keyOf(value: unknown): string {
  if (!isScalar(value) || typeof value.value !== 'string') reject('Dependency repair requires string YAML mapping keys.');
  return value.value;
}

function valueOf(value: unknown): unknown {
  return isNode(value) ? value.toJSON() : value;
}

function pathFor(path: string, key: string): string {
  return `${path}[${JSON.stringify(key)}]`;
}

/** Conditions, cardinality, and arbitrary alias-like properties are NOT edge identity. */
function relationshipIdentity(value: unknown): string | undefined {
  if (!isMap(value)) return undefined;
  const from = value.get('join_from_view');
  const to = value.get('join_to_view');
  if (typeof from !== 'string' || !from.trim() || typeof to !== 'string' || !to.trim()) return undefined;
  const aliases: Array<[string, string]> = [];
  for (const key of ['join_from_view_alias', 'join_to_view_alias']) {
    if (!value.has(key)) continue;
    const alias = value.get(key);
    if (typeof alias !== 'string' || !alias.trim()) return undefined;
    aliases.push([key, alias]);
  }
  return JSON.stringify([from, to, aliases]);
}

function assertRelationships(value: unknown, label: string): asserts value is YAMLSeq {
  if (!isSeq(value)) reject(`${label} must be a relationship list with complete identities.`);
  const identities = value.items.map(relationshipIdentity);
  if (identities.some((identity) => !identity)) reject(`${label} has a relationship without complete view and alias identities.`);
  if (new Set(identities).size !== identities.length) reject(`${label} contains conflicting duplicate relationship identities.`);
}

function readYaml(text: string, label: string) {
  if (typeof text !== 'string' || text.length > 5_000_000) reject(`${label} exceeds the bounded repair scope.`);
  let document;
  try {
    document = parseDocument(text, { uniqueKeys: true, strict: true, prettyErrors: false, keepSourceTokens: true });
  } catch {
    return reject(`${label} must contain valid, bounded YAML before dependency repair can continue.`);
  }
  if (document.errors.length || document.warnings.length || (!isMap(document.contents) && !isSeq(document.contents))) {
    reject(`${label} must contain valid mapping or relationship-list YAML before dependency repair can continue.`);
  }
  let nodes = 0;
  visit(document, (_key, node, path) => {
    if (++nodes > 100_000 || path.length > 64) reject('Dependency YAML nesting exceeds the bounded repair scope.');
    if (isAlias(node) || (isNode(node) && 'anchor' in node && node.anchor)) {
      reject(`${label} contains anchors or aliases that require manual review before dependency repair.`);
    }
    if (isMap(node)) {
      if (node.tag && node.tag !== 'tag:yaml.org,2002:map') reject(`${label} uses a mapping tag requiring manual review.`);
      for (const pair of node.items) keyOf(pair.key);
    }
    if (isSeq(node) && node.tag && node.tag !== 'tag:yaml.org,2002:seq') reject(`${label} uses a list tag requiring manual review.`);
  });
  if (isSeq(document.contents)) assertRelationships(document.contents, label);
  else if (isMap(document.contents) && document.contents.has('relationships')) {
    assertRelationships(document.contents.get('relationships', true), `${label} relationships`);
  }
  return document;
}

function assertComments(target: unknown, accepted: unknown, path: string) {
  if (!isNode(target)) return;
  for (const key of ['commentBefore', 'comment'] as const) {
    if (target[key] && (!isNode(accepted) || !accepted[key]?.includes(target[key]))) {
      reject(`Accepted YAML removed an authored destination comment at ${path}. Prepare differences again and retain its comments.`);
    }
  }
}

function assertAllComments(target: unknown, accepted: unknown, path: string) {
  assertComments(target, accepted, path);
  if (isMap(target) && isMap(accepted)) {
    for (const pair of target.items) {
      const key = keyOf(pair.key);
      const other = accepted.items.find((item) => keyOf(item.key) === key);
      assertComments(pair.key, other?.key, pathFor(path, key));
      assertAllComments(pair.value, other?.value, pathFor(path, key));
    }
  } else if (isSeq(target) && isSeq(accepted)) {
    target.items.forEach((item, index) => assertAllComments(item, accepted.items[index], `${path}[${index}]`));
  }
}

function assertSameDefinition(target: unknown, proposed: unknown, path: string) {
  if (!isDeepStrictEqual(valueOf(target), valueOf(proposed))) {
    reject(`Dependency repair cannot modify an existing destination definition or property at ${path}. Only new definitions may be added.`);
  }
}

function assertAtomic(target: unknown, accepted: unknown, path: string) {
  assertSameDefinition(target, accepted, path);
  assertAllComments(target, accepted, path);
}

const fieldContainers = new Set(['dimensions', 'measures']);

/** A missing root key is not automatically a new definition: policy and behavior stay immutable. */
function assertNewContainer(key: string, value: unknown, path: string) {
  if (fieldContainers.has(key) && isMap(value) && value.items.length) return;
  if (key === 'relationships') {
    assertRelationships(value, path);
    if (value.items.length) return;
  }
  reject(`Dependency repair cannot add destination property ${path}. Only new dimensions, measures, and relationship edges are allowed in an existing file.`);
}

function assertFieldDefinitions(target: YAMLMap, accepted: YAMLMap, path: string) {
  assertComments(target, accepted, path);
  for (const pair of target.items) {
    const key = keyOf(pair.key);
    const other = accepted.items.find((item) => keyOf(item.key) === key);
    if (!other) reject(`Accepted YAML removed destination definition ${pathFor(path, key)}.`);
    assertComments(pair.key, other.key, pathFor(path, key));
    assertAtomic(pair.value, other.value, pathFor(path, key));
  }
}

function assertRelationshipAdditions(target: YAMLSeq, accepted: YAMLSeq, path: string) {
  assertRelationships(accepted, path);
  assertComments(target, accepted, path);
  if (accepted.items.length < target.items.length) reject(`Accepted YAML removed a destination relationship at ${path}.`);
  // Existing order and edge definitions are immutable; new identities may only be appended.
  target.items.forEach((item, index) => assertAtomic(item, accepted.items[index], `${path}[${index}]`));
}

/** Validate reviewed bytes, including source-overlapping definitions, without rewriting them. */
export function assertDashboardRepairYamlPreservesTarget(input: { sourceYaml: string; targetYaml?: string; acceptedYaml: string }): void {
  readYaml(input.sourceYaml, 'Source YAML');
  const accepted = readYaml(input.acceptedYaml, 'Accepted YAML');
  if (input.targetYaml === undefined) return;
  const target = readYaml(input.targetYaml, 'Destination YAML');
  for (const key of ['commentBefore', 'comment'] as const) {
    if (target[key] && !accepted[key]?.includes(target[key])) reject('Accepted YAML removed an authored destination document comment.');
  }
  if (isSeq(target.contents) && isSeq(accepted.contents)) {
    assertRelationshipAdditions(target.contents, accepted.contents, '$');
    return;
  }
  if (!isMap(target.contents) || !isMap(accepted.contents)) reject('Changing the destination YAML root structure requires manual dependency review.');
  assertComments(target.contents, accepted.contents, '$');
  for (const pair of target.contents.items) {
    const key = keyOf(pair.key);
    const path = pathFor('$', key);
    const other = accepted.contents.items.find((item) => keyOf(item.key) === key);
    if (!other) reject(`Accepted YAML removed destination property ${path}.`);
    assertComments(pair.key, other.key, path);
    if (fieldContainers.has(key) && isMap(pair.value) && isMap(other.value)) assertFieldDefinitions(pair.value, other.value, path);
    else if (key === 'relationships' && isSeq(pair.value) && isSeq(other.value)) assertRelationshipAdditions(pair.value, other.value, path);
    else assertAtomic(pair.value, other.value, path);
  }
  for (const pair of accepted.contents.items) {
    const key = keyOf(pair.key);
    if (!target.contents.has(key)) assertNewContainer(key, pair.value, pathFor('$', key));
  }
}

/** Strict additive-only checker; the older public name remains backward compatible. */
export const assertDashboardRepairYamlIsAdditive = assertDashboardRepairYamlPreservesTarget;

export interface DashboardRepairYamlPreview {
  yaml: string;
  /** JSON-style paths of new definitions ("$" means a wholly new file). */
  additions: string[];
  /** Existing, semantically identical definitions that were left untouched. */
  skipped: string[];
}

interface Append {
  node: YAMLMap | YAMLSeq;
  entries: unknown[];
}

function mergeDefinitions(target: YAMLMap, proposed: YAMLMap, path: string, preview: DashboardRepairYamlPreview, appends: Append[]) {
  const entries = [];
  for (const pair of proposed.items) {
    const key = keyOf(pair.key);
    const definitionPath = pathFor(path, key);
    const existing = target.items.find((item) => keyOf(item.key) === key);
    if (existing) {
      assertSameDefinition(existing.value, pair.value, definitionPath);
      preview.skipped.push(definitionPath);
    } else {
      entries.push(pair.clone(target.schema));
      preview.additions.push(definitionPath);
    }
  }
  if (entries.length) {
    appends.push({ node: target, entries });
    target.items.push(...entries);
  }
}

function mergeRelationships(target: YAMLSeq, proposed: YAMLSeq, path: string, preview: DashboardRepairYamlPreview, appends: Append[]) {
  const entries = [];
  for (const item of proposed.items) {
    const identity = relationshipIdentity(item)!;
    const definitionPath = `${path}[${identity}]`;
    const existing = target.items.find((candidate) => relationshipIdentity(candidate) === identity);
    if (existing !== undefined) {
      assertSameDefinition(existing, item, definitionPath);
      preview.skipped.push(definitionPath);
    } else {
      entries.push(isNode(item) ? item.clone() : item);
      preview.additions.push(definitionPath);
    }
  }
  if (entries.length) {
    appends.push({ node: target, entries });
    target.items.push(...entries);
  }
}

function mergeMaps(target: YAMLMap, proposed: YAMLMap, preview: DashboardRepairYamlPreview, appends: Append[]) {
  const entries = [];
  for (const pair of proposed.items) {
    const key = keyOf(pair.key);
    const path = pathFor('$', key);
    const existing = target.items.find((item) => keyOf(item.key) === key);
    if (!existing) {
      // Empty containers carry no new definitions and need no formatting-only edit.
      if ((fieldContainers.has(key) && isMap(pair.value) || key === 'relationships' && isSeq(pair.value)) && !pair.value.items.length) continue;
      assertNewContainer(key, pair.value, path);
      entries.push(pair.clone(target.schema));
      if (isMap(pair.value)) for (const field of pair.value.items) preview.additions.push(pathFor(path, keyOf(field.key)));
      else if (isSeq(pair.value)) for (const edge of pair.value.items) preview.additions.push(`${path}[${relationshipIdentity(edge)}]`);
    } else if (fieldContainers.has(key) && isMap(existing.value) && isMap(pair.value)) {
      mergeDefinitions(existing.value, pair.value, path, preview, appends);
    } else if (key === 'relationships' && isSeq(existing.value) && isSeq(pair.value)) {
      mergeRelationships(existing.value, pair.value, path, preview, appends);
    } else assertSameDefinition(existing.value, pair.value, path);
  }
  if (entries.length) {
    appends.push({ node: target, entries });
    target.items.push(...entries);
  }
}

/** Insert into block collections without reserializing unrelated authored bytes. */
function renderAppends(text: string, appends: Append[]): string {
  const newline = text.includes('\r\n') ? '\r\n' : '\n';
  const edits = appends.map(({ node, entries }) => {
    if (!node.range) return reject('Destination YAML has no reliable edit range. Review this dependency file manually.');
    const [start, end] = node.range;
    const indent = start - text.lastIndexOf('\n', start - 1) - 1;
    const fragment = node.clone() as YAMLMap | YAMLSeq;
    fragment.commentBefore = undefined;
    fragment.comment = undefined;
    if (!node.flow) {
      // Pairs/nodes are already cloned from the proposed document.
      fragment.items = entries as typeof fragment.items;
    }
    const document = new Document();
    document.contents = fragment;
    let replacement = document.toString({ lineWidth: 0 }).replace(/\n$/, '');
    if (node.flow) {
      replacement = replacement.split('\n').map((line, index) => index ? `${' '.repeat(indent)}${line}` : line).join(newline);
      return { start, end, indent, replacement };
    }
    replacement = replacement.split('\n').map((line) => line ? `${' '.repeat(indent)}${line}` : line).join(newline) + newline;
    if (end && text[end - 1] !== '\n') replacement = newline + replacement;
    return { start: end, end, indent, replacement };
  });
  // A rewritten flow parent already contains all mutations in its child collections.
  const independent = edits.filter((edit) => !edits.some((parent) => parent !== edit && parent.start < parent.end
    && parent.start <= edit.start && parent.end >= edit.end));
  // At the same offset, inserting the parent first leaves nested additions before it.
  independent.sort((left, right) => right.start - left.start || left.indent - right.indent);
  for (const edit of independent) text = text.slice(0, edit.start) + edit.replacement + text.slice(edit.end);
  return text;
}

/** Build an additive review draft; conflicts never become silent replacements. */
export function previewDashboardRepairYaml(targetYaml: string | undefined, proposedYaml: string): DashboardRepairYamlPreview {
  const proposed = readYaml(proposedYaml, 'Proposed YAML');
  if (targetYaml === undefined) return { yaml: proposedYaml, additions: ['$'], skipped: [] };
  const target = readYaml(targetYaml, 'Destination YAML');
  const preview: DashboardRepairYamlPreview = { yaml: targetYaml, additions: [], skipped: [] };
  const appends: Append[] = [];
  if (isMap(target.contents) && isMap(proposed.contents)) mergeMaps(target.contents, proposed.contents, preview, appends);
  else if (isSeq(target.contents) && isSeq(proposed.contents)) mergeRelationships(target.contents, proposed.contents, '$', preview, appends);
  else reject('Changing the destination YAML root structure requires manual dependency review.');
  if (!appends.length) return preview;
  preview.yaml = renderAppends(targetYaml, appends);
  // Reparse the exact output: ambiguous ranges or comment attachment must fail closed.
  assertDashboardRepairYamlPreservesTarget({ sourceYaml: proposedYaml, targetYaml, acceptedYaml: preview.yaml });
  return preview;
}

export function mergeDashboardRepairYaml(targetYaml: string | undefined, proposedYaml: string): string {
  return previewDashboardRepairYaml(targetYaml, proposedYaml).yaml;
}
