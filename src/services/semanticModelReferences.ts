import { parseDocument } from 'yaml';
import type { OmniModelYamlResponse } from '@/services/omniApi';
import { sha256Text } from './contentHash';

export interface SemanticReferenceFile {
  fileName: string;
  yaml: string;
}

function unique(values: string[]) {
  return Array.from(new Set(values.map((value) => value.trim()).filter(Boolean)));
}

function parsedYamlValue(yaml: string): unknown {
  try {
    const document = parseDocument(yaml, {
      prettyErrors: false,
      strict: false,
      uniqueKeys: true,
    });
    if (document.errors.length > 0) return undefined;
    return document.toJS({ maxAliasCount: 20 });
  } catch {
    return undefined;
  }
}

function stringRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

const TOPIC_JOIN_CONFIG_KEYS = new Set([
  'fields',
  'join_from_view',
  'join_to_view',
  'join_type',
  'on',
  'on_sql',
  'relationship_type',
  'type',
]);

function collectTopicJoinViews(value: unknown, result: string[]) {
  if (Array.isArray(value)) {
    value.forEach((entry) => collectTopicJoinViews(entry, result));
    return;
  }
  const record = stringRecord(value);
  if (!record) {
    if (typeof value === 'string' && value.trim()) result.push(value.trim());
    return;
  }

  ['join_from_view', 'join_to_view'].forEach((key) => {
    const viewName = record[key];
    if (typeof viewName === 'string' && viewName.trim()) result.push(viewName.trim());
  });
  Object.entries(record).forEach(([key, child]) => {
    if (TOPIC_JOIN_CONFIG_KEYS.has(key.toLowerCase())) return;
    result.push(key);
    collectTopicJoinViews(child, result);
  });
}

function collectTopicIncludedViews(value: unknown, result: string[]) {
  if (Array.isArray(value)) {
    value.forEach((entry) => {
      if (typeof entry === 'string' && entry.trim()) {
        result.push(entry.trim());
        return;
      }
      const record = stringRecord(entry);
      const viewName = record?.name ?? record?.view ?? record?.view_name;
      if (typeof viewName === 'string' && viewName.trim()) result.push(viewName.trim());
    });
    return;
  }
  const record = stringRecord(value);
  if (record) result.push(...Object.keys(record));
}

export function semanticTopicReachableViewNames(yaml: string) {
  const parsed = parsedYamlValue(yaml);
  const topic = stringRecord(parsed);
  if (!topic) return [];
  const viewNames: string[] = [];
  const baseView = topic.base_view ?? topic.baseView ?? topic.base_view_name;
  if (typeof baseView === 'string' && baseView.trim()) viewNames.push(baseView.trim());
  collectTopicJoinViews(topic.joins, viewNames);
  collectTopicIncludedViews(topic.views, viewNames);
  return unique(viewNames).sort();
}

const TOPIC_VIEW_VALUE_KEYS = new Set([
  'base_view',
  'baseview',
  'base_view_name',
  'join_from_view',
  'join_to_view',
  'view',
  'view_name',
]);

const TOPIC_SELECTOR_CONTAINER_KEYS = new Set([
  'access_filters',
  'ai_fields',
  'always_where_filters',
  'default_filters',
  'field_override',
  'field_overrides',
  'fields',
  'filter',
  'filters',
  'pivots',
  'sort',
  'sorts',
]);

const TOPIC_SELECTOR_VALUE_KEYS = new Set([
  'column',
  'column_name',
  'field',
  'field_name',
  'selector',
  'sort',
]);

const DIRECT_FIELD_SELECTOR_PATTERN = /^([A-Za-z_][\w-]*)\.[A-Za-z_][\w-]*(?:\[[^\]\r\n]+\])?(?:\s+(?:asc|desc))?$/i;
const TEMPLATE_FIELD_SELECTOR_PATTERN = /\$\{\s*([A-Za-z_][\w-]*)\.[A-Za-z_][\w-]*(?:\[[^\]\r\n]+\])?\s*\}/g;

function directFieldSelectorViewName(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value.trim().match(DIRECT_FIELD_SELECTOR_PATTERN)?.[1] || '';
}

function collectTemplateFieldSelectorViews(value: string, result: string[]) {
  for (const match of value.matchAll(TEMPLATE_FIELD_SELECTOR_PATTERN)) {
    if (match[1]) result.push(match[1]);
  }
}

function collectSelectorViews(value: unknown, result: string[]) {
  if (typeof value === 'string') {
    const viewName = directFieldSelectorViewName(value);
    if (viewName) result.push(viewName);
    collectTemplateFieldSelectorViews(value, result);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry) => collectSelectorViews(entry, result));
    return;
  }
  const record = stringRecord(value);
  if (!record) return;
  Object.entries(record).forEach(([key, child]) => {
    const keyViewName = directFieldSelectorViewName(key);
    if (keyViewName) result.push(keyViewName);
    if (TOPIC_SELECTOR_VALUE_KEYS.has(key.toLowerCase())) {
      const childViewName = directFieldSelectorViewName(child);
      if (childViewName) result.push(childViewName);
    }
    collectSelectorViews(child, result);
  });
}

function collectSampleQueryViews(value: unknown, result: string[]) {
  if (Array.isArray(value)) {
    value.forEach((entry) => collectSampleQueryViews(entry, result));
    return;
  }
  const record = stringRecord(value);
  if (!record) return;
  Object.entries(record).forEach(([key, child]) => {
    if (key.toLowerCase() === 'query') {
      const query = stringRecord(child);
      collectSelectorViews(query?.pivots, result);
    }
    collectSampleQueryViews(child, result);
  });
}

function collectSampleQueryTopics(value: unknown, result: string[]) {
  if (Array.isArray(value)) {
    value.forEach((entry) => collectSampleQueryTopics(entry, result));
    return;
  }
  const record = stringRecord(value);
  if (!record) return;
  Object.entries(record).forEach(([key, child]) => {
    if (key.toLowerCase() === 'query') {
      const topicName = stringRecord(child)?.topic;
      if (typeof topicName === 'string' && topicName.trim()) result.push(topicName.trim());
    }
    collectSampleQueryTopics(child, result);
  });
}

function collectTopicReferencedViews(value: unknown, result: string[], visited: WeakSet<object>) {
  if (typeof value === 'string') {
    collectTemplateFieldSelectorViews(value, result);
    return;
  }
  if (!value || typeof value !== 'object' || visited.has(value)) return;
  visited.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry) => collectTopicReferencedViews(entry, result, visited));
    return;
  }

  Object.entries(value as Record<string, unknown>).forEach(([key, child]) => {
    const normalizedKey = key.toLowerCase();
    if (TOPIC_VIEW_VALUE_KEYS.has(normalizedKey) && typeof child === 'string' && child.trim()) {
      result.push(child.trim());
    }
    if (normalizedKey === 'joins') collectTopicJoinViews(child, result);
    if (normalizedKey === 'views') collectTopicIncludedViews(child, result);
    if (normalizedKey === 'sample_queries') collectSampleQueryViews(child, result);
    if (TOPIC_SELECTOR_CONTAINER_KEYS.has(normalizedKey)) collectSelectorViews(child, result);
    if (TOPIC_SELECTOR_VALUE_KEYS.has(normalizedKey)) {
      const viewName = directFieldSelectorViewName(child);
      if (viewName) result.push(viewName);
    }
    collectTopicReferencedViews(child, result, visited);
  });
}

/**
 * Inventories every model view named by a topic, including semantic selectors
 * that do not make the view reachable through base_view, joins, or views.
 */
export function semanticTopicReferencedViewNames(yaml: string) {
  const parsed = parsedYamlValue(yaml);
  const topic = stringRecord(parsed);
  if (!topic) return [];
  const viewNames = semanticTopicReachableViewNames(yaml);
  collectTopicReferencedViews(topic, viewNames, new WeakSet<object>());
  return unique(viewNames).sort();
}

export function semanticTopicReferencedTopicNames(yaml: string) {
  const parsed = parsedYamlValue(yaml);
  const topic = stringRecord(parsed);
  if (!topic) return [];
  const topicNames: string[] = [];
  collectSampleQueryTopics(topic.sample_queries, topicNames);
  return unique(topicNames).sort();
}

function topicAccessFilterFields(value: unknown) {
  const entries = Array.isArray(value) ? value : value == null ? [] : [value];
  return entries.flatMap((entry) => {
    const record = stringRecord(entry);
    return typeof record?.field === 'string' && record.field.trim()
      ? [record.field.trim()]
      : [];
  });
}

function viewNameFromFileName(fileName: string) {
  const normalized = fileName.trim().replace(/^\/+|\/+$/g, '');
  if (!normalized.endsWith('.view')) return '';
  const parts = normalized.split('/');
  const leaf = (parts.pop() || '')
    .replace(/\.query\.view$/i, '')
    .replace(/\.view$/i, '');
  if (!leaf) return '';
  if (leaf.includes('__') || parts.length === 0) return leaf;
  const folder = parts[parts.length - 1] || '';
  return folder && folder.toLowerCase() !== 'views' ? `${folder}__${leaf}` : leaf;
}

function declaredViewNames(file: SemanticReferenceFile) {
  if (!file.fileName.endsWith('.view')) return [];
  const parsed = parsedYamlValue(file.yaml);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  const record = parsed as Record<string, unknown>;
  return [record.name, record.view, record.view_name]
    .filter((value): value is string => typeof value === 'string' && Boolean(value.trim()));
}

export type SemanticViewSourceKind = 'table' | 'query' | 'unresolved';

export interface SemanticViewIdentityContract {
  readonly fileName: string;
  readonly viewName: string;
  readonly sourceKind: SemanticViewSourceKind;
  readonly schemaName?: string;
  readonly tableName?: string;
  readonly querySourceDigest?: string;
}

function semanticQuerySourceDigest(record: Record<string, unknown>): string {
  return `query-sha256:${sha256Text(JSON.stringify(stableSemanticValue({
    query: record.query ?? null,
    sql: record.sql ?? null,
  })))}`;
}

/**
 * Captures the immutable identity of one approved view artifact. An indexed
 * name may supply the internal name when authored YAML relies on Omni's file
 * mapping, but an explicit staged name always remains observable and exact.
 */
export function semanticViewIdentityContract(
  file: SemanticReferenceFile,
  indexedViewName?: string,
): SemanticViewIdentityContract | null {
  if (!/\.view$/i.test(file.fileName)) return null;
  const record = stringRecord(parsedYamlValue(file.yaml));
  if (!record) return null;
  const declaredName = [record.name, record.view, record.view_name]
    .find((value): value is string => typeof value === 'string' && Boolean(value.trim()))
    ?.trim() || '';
  const viewName = declaredName || indexedViewName?.trim() || viewNameFromFileName(file.fileName);
  if (!viewName) return null;

  const hasQuerySource = /\.query\.view$/i.test(file.fileName)
    || Object.prototype.hasOwnProperty.call(record, 'query')
    || Object.prototype.hasOwnProperty.call(record, 'sql');
  if (hasQuerySource) {
    return Object.freeze({
      fileName: file.fileName,
      viewName,
      sourceKind: 'query' as const,
      querySourceDigest: semanticQuerySourceDigest(record),
    });
  }

  const schemaName = typeof (record.schema ?? record.schema_name) === 'string'
    ? String(record.schema ?? record.schema_name).trim()
    : '';
  const tableName = typeof (record.table_name ?? record.sql_table_name) === 'string'
    ? String(record.table_name ?? record.sql_table_name).trim()
    : '';
  if (schemaName || tableName) {
    return Object.freeze({
      fileName: file.fileName,
      viewName,
      sourceKind: 'table' as const,
      schemaName: schemaName || undefined,
      tableName: tableName || undefined,
    });
  }

  return Object.freeze({
    fileName: file.fileName,
    viewName,
    sourceKind: 'unresolved' as const,
  });
}

export function semanticModelViewNames(
  modelYaml: Pick<OmniModelYamlResponse, 'files' | 'viewNames'> | null | undefined,
  stagedFiles: readonly SemanticReferenceFile[] = [],
) {
  const indexedNames = Object.values(modelYaml?.viewNames || {})
    .filter((value): value is string => typeof value === 'string');
  const modelFiles = Object.entries(modelYaml?.files || {})
    .map(([fileName, yaml]) => ({ fileName, yaml }));
  const inferredNames = [...modelFiles, ...stagedFiles].flatMap((file) => [
    viewNameFromFileName(file.fileName),
    ...declaredViewNames(file),
  ]);
  return unique([...indexedNames, ...inferredNames]).sort();
}

export type SemanticRelationshipType =
  | 'one_to_one'
  | 'many_to_one'
  | 'one_to_many'
  | 'many_to_many'
  | 'assumed_many_to_one';

export interface SemanticRelationshipContract {
  readonly join_from_view: string;
  readonly join_to_view: string;
  readonly join_type: 'always_left';
  readonly on_sql: string;
  readonly relationship_type: SemanticRelationshipType;
  readonly reversible: boolean;
}

type RelationshipScopeEntry = {
  from: string;
  to: string;
  joinType: string;
  onSql: string;
  relationshipType: string;
  reversible: unknown;
  fingerprint: string;
  rowNumber: number;
};

type RelationshipParseResult = {
  entries: RelationshipScopeEntry[];
  issues: string[];
};

const SEMANTIC_RELATIONSHIP_TYPES = new Set<SemanticRelationshipType>([
  'one_to_one',
  'many_to_one',
  'one_to_many',
  'many_to_many',
  'assumed_many_to_one',
]);

function stableSemanticValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableSemanticValue);
  const record = stringRecord(value);
  if (!record) return value;
  return Object.fromEntries(
    Object.entries(record)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableSemanticValue(child)]),
  );
}

function parseRelationshipScopeEntries(yaml: string, label: string): RelationshipParseResult {
  if (!yaml.trim()) return { entries: [], issues: [] };
  let parsed: unknown;
  try {
    const document = parseDocument(yaml, {
      prettyErrors: false,
      strict: false,
      uniqueKeys: true,
    });
    if (document.errors.length > 0) {
      return {
        entries: [],
        issues: document.errors.map((error) => `${label} contains invalid YAML syntax: ${error.message}`),
      };
    }
    parsed = document.toJS({ maxAliasCount: 20 });
  } catch (error) {
    return {
      entries: [],
      issues: [`${label} could not be parsed as relationship YAML: ${error instanceof Error ? error.message : 'unknown parser error'}`],
    };
  }
  if (!Array.isArray(parsed)) {
    return { entries: [], issues: [`${label} must be a top-level YAML list of relationship objects.`] };
  }

  const entries: RelationshipScopeEntry[] = [];
  const issues: string[] = [];
  parsed.forEach((candidate, index) => {
    const record = stringRecord(candidate);
    if (!record) {
      issues.push(`${label} row ${index + 1} must be a relationship object.`);
      return;
    }
    const from = typeof record.join_from_view === 'string' ? record.join_from_view.trim() : '';
    const to = typeof record.join_to_view === 'string' ? record.join_to_view.trim() : '';
    if (!from || !to) {
      issues.push(`${label} row ${index + 1} must include non-empty join_from_view and join_to_view endpoints.`);
      return;
    }
    const canonicalRecord = record.reversible === undefined
      ? { ...record, reversible: false }
      : record;
    entries.push({
      from,
      to,
      joinType: typeof record.join_type === 'string' ? record.join_type.trim() : '',
      onSql: typeof record.on_sql === 'string' ? record.on_sql.trim() : '',
      relationshipType: typeof record.relationship_type === 'string' ? record.relationship_type.trim() : '',
      reversible: record.reversible,
      fingerprint: JSON.stringify(stableSemanticValue(canonicalRecord)),
      rowNumber: index + 1,
    });
  });
  return { entries, issues };
}

function relationshipContractEntries(
  contracts: readonly SemanticRelationshipContract[],
): RelationshipParseResult {
  const entries: RelationshipScopeEntry[] = [];
  const issues: string[] = [];
  contracts.forEach((candidate, index) => {
    const label = `Approved relationship contract ${index + 1}`;
    const contract = stringRecord(candidate);
    if (!contract) {
      issues.push(`${label} must be an exact relationship object.`);
      return;
    }
    const from = typeof contract.join_from_view === 'string' ? contract.join_from_view.trim() : '';
    const to = typeof contract.join_to_view === 'string' ? contract.join_to_view.trim() : '';
    const joinType = typeof contract.join_type === 'string' ? contract.join_type.trim() : '';
    const onSql = typeof contract.on_sql === 'string' ? contract.on_sql.trim() : '';
    const relationshipType = typeof contract.relationship_type === 'string'
      ? contract.relationship_type.trim() as SemanticRelationshipType
      : '';
    const reversible = contract.reversible;
    if (!from || !to) issues.push(`${label} must include non-empty join_from_view and join_to_view endpoints.`);
    if (joinType !== 'always_left') issues.push(`${label} join_type must be exactly always_left.`);
    if (!onSql) issues.push(`${label} must include non-empty on_sql.`);
    if (!SEMANTIC_RELATIONSHIP_TYPES.has(relationshipType as SemanticRelationshipType)) {
      issues.push(`${label} has unsupported relationship_type "${String(contract.relationship_type || '')}".`);
    }
    if (typeof reversible !== 'boolean') issues.push(`${label} reversible must be true or false.`);
    if (issues.some((issue) => issue.startsWith(label))) return;
    const record: SemanticRelationshipContract = {
      join_from_view: from,
      join_to_view: to,
      join_type: 'always_left',
      on_sql: onSql,
      relationship_type: relationshipType as SemanticRelationshipType,
      reversible: reversible as boolean,
    };
    entries.push({
      from,
      to,
      joinType: record.join_type,
      onSql: record.on_sql,
      relationshipType: record.relationship_type,
      reversible: record.reversible,
      fingerprint: JSON.stringify(stableSemanticValue(record)),
      rowNumber: index + 1,
    });
  });
  return { entries, issues };
}

function relationshipEntryCounts(entries: readonly RelationshipScopeEntry[]) {
  const counts = new Map<string, number>();
  entries.forEach((entry) => counts.set(entry.fingerprint, (counts.get(entry.fingerprint) || 0) + 1));
  return counts;
}

function relationshipMultisetExtras(
  entries: readonly RelationshipScopeEntry[],
  baseline: readonly RelationshipScopeEntry[],
) {
  const remainingBaseline = relationshipEntryCounts(baseline);
  return entries.filter((entry) => {
    const remaining = remainingBaseline.get(entry.fingerprint) || 0;
    if (remaining === 0) return true;
    remainingBaseline.set(entry.fingerprint, remaining - 1);
    return false;
  });
}

function proposedRelationshipIssues(entry: RelationshipScopeEntry): string[] {
  const label = `Proposed relationship row ${entry.rowNumber} (${entry.from} -> ${entry.to})`;
  const issues: string[] = [];
  if (entry.joinType !== 'always_left') {
    issues.push(`${label} join_type must be exactly always_left.`);
  }
  if (!entry.onSql) {
    issues.push(`${label} must include non-empty on_sql.`);
  } else {
    [entry.from, entry.to].forEach((endpoint) => {
      if (!entry.onSql.includes(`\${${endpoint}.`)) {
        issues.push(`${label} on_sql must reference a field from "${endpoint}" using \${${endpoint}.field_name}.`);
      }
    });
  }
  if (!SEMANTIC_RELATIONSHIP_TYPES.has(entry.relationshipType as SemanticRelationshipType)) {
    issues.push(`${label} has unsupported relationship_type "${entry.relationshipType}".`);
  }
  if (entry.reversible !== undefined && typeof entry.reversible !== 'boolean') {
    issues.push(`${label} reversible must be true or false when provided.`);
  }
  return issues;
}

function relationshipReachableViews(
  primaryView: string,
  entries: readonly RelationshipScopeEntry[],
) {
  const adjacency = new Map<string, Set<string>>();
  const addEdge = (from: string, to: string) => {
    const neighbors = adjacency.get(from) || new Set<string>();
    neighbors.add(to);
    adjacency.set(from, neighbors);
  };
  entries.forEach((entry) => {
    const from = entry.from.toLowerCase();
    const to = entry.to.toLowerCase();
    addEdge(from, to);
    if (entry.reversible === true) addEdge(to, from);
  });
  const reachable = new Set<string>();
  const queue = [primaryView.toLowerCase()];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || reachable.has(current)) continue;
    reachable.add(current);
    adjacency.get(current)?.forEach((neighbor) => {
      if (!reachable.has(neighbor)) queue.push(neighbor);
    });
  }
  return reachable;
}

function stagedViewIdentityIssues(
  file: SemanticReferenceFile,
  approved: SemanticViewIdentityContract,
): string[] {
  const issues: string[] = [];
  if (file.fileName !== approved.fileName) {
    issues.push(
      `${file.fileName} does not exactly match approved staged view filename "${approved.fileName}".`,
    );
  }
  const actual = semanticViewIdentityContract(file, approved.viewName);
  if (!actual) {
    issues.push(`${file.fileName} must contain valid object YAML with a verifiable staged view identity.`);
    return issues;
  }
  if (actual.viewName !== approved.viewName) {
    issues.push(
      `${file.fileName} changes the approved internal view name from "${approved.viewName}" to "${actual.viewName}". Return to Scope before changing view identity.`,
    );
  }
  if (actual.sourceKind !== approved.sourceKind) {
    issues.push(
      `${file.fileName} changes the approved source contract from ${approved.sourceKind} to ${actual.sourceKind}. Return to Scope before changing view identity.`,
    );
    return issues;
  }
  if (approved.sourceKind === 'table') {
    if (actual.schemaName !== approved.schemaName || actual.tableName !== approved.tableName) {
      issues.push(
        `${file.fileName} changes the approved table source contract. Expected schema/table "${approved.schemaName || ''}.${approved.tableName || ''}" exactly.`,
      );
    }
  } else if (approved.sourceKind === 'query') {
    if (!approved.querySourceDigest || actual.querySourceDigest !== approved.querySourceDigest) {
      issues.push(
        `${file.fileName} changes the approved query source digest. Return to Scope before changing query SQL or source configuration.`,
      );
    }
  }
  return issues;
}

/**
 * Keeps a new topic solution inside the exact model views approved by the user.
 * Identity-bound staged views may join that scope; unrelated relationship rows
 * may remain unchanged, but a new or edited edge cannot silently widen it.
 */
export function semanticApprovedTopicViewScopeIssues(input: {
  files: readonly SemanticReferenceFile[];
  approvedExistingViewNames: readonly string[];
  approvedStagedViewFileNames?: readonly string[];
  approvedStagedViewIdentities?: readonly SemanticViewIdentityContract[];
  primaryExistingViewName?: string;
  baselineRelationshipsYaml?: string;
  relationshipDecisions?: Readonly<Record<string, 'use_existing' | 'propose_reusable' | 'create_reusable' | 'needs_review'>>;
  relationshipContracts?: readonly SemanticRelationshipContract[];
  approvedTargetTopicFileName?: string;
  allowPartialPackage?: boolean;
}) {
  const hasStagedViewIdentityReview = input.approvedStagedViewIdentities !== undefined;
  const approvedStagedViewIdentities = input.approvedStagedViewIdentities || [];
  const requestedStagedViewFileNames = input.approvedStagedViewFileNames || [];
  const approvedIdentityByFileName = new Map<string, SemanticViewIdentityContract>();
  const issues: string[] = [];
  if (!hasStagedViewIdentityReview && requestedStagedViewFileNames.length > 0) {
    issues.push(
      'Approved staged views are missing immutable view identity contracts. Return to Scope and reload the authored view options before generating them.',
    );
  }
  approvedStagedViewIdentities.forEach((identity) => {
    const normalizedFileName = identity.fileName.trim().toLowerCase();
    if (!normalizedFileName || !identity.viewName.trim()) {
      issues.push('Every approved staged view identity must include a non-empty fileName and viewName.');
      return;
    }
    if (approvedIdentityByFileName.has(normalizedFileName)) {
      issues.push(`Approved staged view filename "${identity.fileName}" has more than one immutable identity contract.`);
      return;
    }
    approvedIdentityByFileName.set(normalizedFileName, identity);
  });
  if (hasStagedViewIdentityReview) {
    requestedStagedViewFileNames.forEach((fileName) => {
      if (approvedIdentityByFileName.has(fileName.trim().toLowerCase())) return;
      issues.push(
        `Approved staged view "${fileName}" has no immutable approved view identity. Return to Scope and reload the authored view option before generating it.`,
      );
    });
  }
  const approvedStagedFiles = new Set(
    (hasStagedViewIdentityReview ? approvedStagedViewIdentities.map((identity) => identity.fileName) : [])
      .map((fileName) => fileName.trim().toLowerCase()),
  );
  const stagedViewFiles = input.files.filter((file) => /\.view$/i.test(file.fileName));
  const stagedViewNames = hasStagedViewIdentityReview
    ? approvedStagedViewIdentities.map((identity) => identity.viewName)
    : semanticModelViewNames(
        { files: {}, viewNames: {} },
        stagedViewFiles.filter((file) => approvedStagedFiles.has(file.fileName.trim().toLowerCase())),
      );
  const allowed = new Set(
    unique([...input.approvedExistingViewNames, ...stagedViewNames])
      .map((viewName) => viewName.toLowerCase()),
  );
  const approvedLabel = unique([...input.approvedExistingViewNames]).join(', ') || 'none';

  stagedViewFiles.forEach((file) => {
    const normalizedFileName = file.fileName.trim().toLowerCase();
    if (!approvedStagedFiles.has(normalizedFileName)) {
      issues.push(
        `${file.fileName} is a staged view outside the reviewed semantic blueprint. Return to Scope and explicitly add this artifact before generating or repairing it.`,
      );
      return;
    }
    if (!hasStagedViewIdentityReview) return;
    const approvedIdentity = approvedIdentityByFileName.get(normalizedFileName);
    if (!approvedIdentity) return;
    issues.push(...stagedViewIdentityIssues(file, approvedIdentity));
  });

  input.files.filter((file) => file.fileName.endsWith('.topic')).forEach((file) => {
    const topic = stringRecord(parsedYamlValue(file.yaml));
    const baseView = typeof topic?.base_view === 'string' ? topic.base_view.trim() : '';
    const primaryView = input.primaryExistingViewName?.trim() || '';
    if (primaryView && baseView && baseView.toLowerCase() !== primaryView.toLowerCase()) {
      issues.push(
        `${file.fileName} uses base_view "${baseView}", but the reviewed primary data view is "${primaryView}". Supporting views may be joined or included, but cannot silently replace the approved base view.`,
      );
    }
    semanticTopicReferencedViewNames(file.yaml).forEach((viewName) => {
      if (allowed.has(viewName.toLowerCase())) return;
      issues.push(
        `${file.fileName} references view "${viewName}" outside the reviewed topic data scope. Approved existing views: ${approvedLabel}. Return to Scope to approve a different primary or supporting view.`,
      );
    });
    const approvedTopicName = (input.approvedTargetTopicFileName || '')
      .split('/')
      .at(-1)
      ?.replace(/\.topic$/i, '')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '') || '';
    if (approvedTopicName) {
      semanticTopicReferencedTopicNames(file.yaml).forEach((topicName) => {
        const normalizedTopicName = topicName.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
        if (normalizedTopicName === approvedTopicName) return;
        issues.push(
          `${file.fileName} sample query references topic "${topicName}" instead of the approved target topic "${approvedTopicName}".`,
        );
      });
    }
  });

  const baselineRelationshipResult = parseRelationshipScopeEntries(
    input.baselineRelationshipsYaml || '',
    'Baseline relationships YAML',
  );
  issues.push(...baselineRelationshipResult.issues);
  const baselineRelationshipEntries = baselineRelationshipResult.entries;
  const primaryView = input.primaryExistingViewName?.trim().toLowerCase() || '';
  const relationshipDecisions = Object.fromEntries(
    Object.entries(input.relationshipDecisions || {}).map(([viewName, decision]) => [viewName.toLowerCase(), decision]),
  );
  const hasExactRelationshipContractReview = input.relationshipContracts !== undefined;
  const relationshipContractResult = relationshipContractEntries(input.relationshipContracts || []);
  issues.push(...relationshipContractResult.issues);
  const contractEntries = relationshipContractResult.entries;
  const contractDecisionView = (entry: RelationshipScopeEntry) => {
    const from = entry.from.toLowerCase();
    const to = entry.to.toLowerCase();
    if (!primaryView || from === to) return '';
    if (from === primaryView && relationshipDecisions[to]) return to;
    if (to === primaryView && relationshipDecisions[from]) return from;
    return '';
  };
  const createContractEntries = contractEntries.filter((entry) => (
    relationshipDecisions[contractDecisionView(entry)] === 'create_reusable'
  ));
  const existingContractEntries = contractEntries.filter((entry) => (
    relationshipDecisions[contractDecisionView(entry)] === 'use_existing'
  ));

  if (hasExactRelationshipContractReview) {
    contractEntries.forEach((entry) => {
      if (contractDecisionView(entry)) return;
      issues.push(
        `Approved relationship contract ${entry.rowNumber} (${entry.from} -> ${entry.to}) does not connect the reviewed primary view to one supporting view with a relationship decision.`,
      );
    });
  }

  Object.entries(relationshipDecisions).forEach(([viewName, decision]) => {
    if (decision !== 'use_existing' || !primaryView) return;
    const approvedEntries = existingContractEntries.filter((entry) => {
      const endpoints = [entry.from.toLowerCase(), entry.to.toLowerCase()];
      return endpoints.includes(primaryView) && endpoints.includes(viewName);
    });
    if (approvedEntries.length === 0) {
      issues.push(
        `The blueprint says to reuse the authored relationship between "${input.primaryExistingViewName}" and "${viewName}", but no exact use_existing relationship contract was approved.`,
      );
      return;
    }
    const approvedCounts = relationshipEntryCounts(approvedEntries);
    const baselineCounts = relationshipEntryCounts(baselineRelationshipEntries);
    const reportedFingerprints = new Set<string>();
    approvedEntries.forEach((entry) => {
      if (reportedFingerprints.has(entry.fingerprint)) return;
      reportedFingerprints.add(entry.fingerprint);
      const approvedCount = approvedCounts.get(entry.fingerprint) || 0;
      const authoredCount = baselineCounts.get(entry.fingerprint) || 0;
      if (authoredCount >= approvedCount) return;
      issues.push(
        `The authored baseline is missing ${approvedCount - authoredCount} of ${approvedCount} exact approved use_existing rows for ${entry.from} -> ${entry.to}. Direction, join type, SQL, relationship type, reversible, and row shape must equal the approved authored contract.`,
      );
    });
  });
  const stagedRelationshipFiles = input.files.filter((file) => file.fileName === 'relationships');
  const stagedRelationshipEntries: RelationshipScopeEntry[] = [];
  stagedRelationshipFiles.forEach((file) => {
    const parsed = parseRelationshipScopeEntries(file.yaml, file.fileName);
    issues.push(...parsed.issues);
    stagedRelationshipEntries.push(...parsed.entries);
  });
  // A partial solution may legitimately omit the topic or later artifacts, but
  // once the relationships artifact is present it must already contain the
  // complete reviewed graph. Otherwise an incomplete row set can be cached as
  // a resumable artifact and every package retry will replay the same failure.
  const requireCompleteRelationshipReview = !input.allowPartialPackage
    || stagedRelationshipFiles.length > 0;
  if (stagedRelationshipFiles.length > 0) {
    const baselineCounts = relationshipEntryCounts(baselineRelationshipEntries);
    const stagedCounts = relationshipEntryCounts(stagedRelationshipEntries);
    const reportedFingerprints = new Set<string>();
    baselineRelationshipEntries.forEach((entry) => {
      if (reportedFingerprints.has(entry.fingerprint)) return;
      reportedFingerprints.add(entry.fingerprint);
      const authoredCount = baselineCounts.get(entry.fingerprint) || 0;
      const stagedCount = stagedCounts.get(entry.fingerprint) || 0;
      if (stagedCount >= authoredCount) return;
      issues.push(
        `relationships removes or rewrites the authored ${entry.from} -> ${entry.to} relationship row (missing ${authoredCount - stagedCount} of ${authoredCount} identical authored rows). Preserve every existing relationship row exactly unless it is separately reviewed.`,
      );
    });
  }
  const changedRelationshipEntries = relationshipMultisetExtras(
    stagedRelationshipEntries,
    baselineRelationshipEntries,
  );
  const contractCounts = relationshipEntryCounts(createContractEntries);
  const changedCounts = relationshipEntryCounts(changedRelationshipEntries);
  const reportedDuplicateProposals = new Set<string>();
  changedRelationshipEntries.forEach((entry) => {
    const count = changedCounts.get(entry.fingerprint) || 0;
    if (count < 2 || reportedDuplicateProposals.has(entry.fingerprint)) return;
    reportedDuplicateProposals.add(entry.fingerprint);
    issues.push(
      `Blobby returned the same proposed relationship row ${count} times for ${entry.from} -> ${entry.to}; each relationship edge must appear once.`,
    );
  });

  if (primaryView) {
    const reachableViews = relationshipReachableViews(
      primaryView,
      stagedRelationshipEntries.length > 0 ? stagedRelationshipEntries : baselineRelationshipEntries,
    );
    Object.entries(relationshipDecisions).forEach(([viewName, decision]) => {
      if (decision !== 'propose_reusable') return;
      const proposedEntries = changedRelationshipEntries.filter((entry) => {
        const endpoints = [entry.from.toLowerCase(), entry.to.toLowerCase()];
        return endpoints.includes(viewName);
      });
      if (requireCompleteRelationshipReview && proposedEntries.length === 0) {
        issues.push(
          `Blobby did not return a proposed reusable relationship edge for "${viewName}". Review the supplied view fields or defer this join to a semantic owner.`,
        );
      }
      if (requireCompleteRelationshipReview && !reachableViews.has(viewName)) {
        issues.push(
          `The proposed relationship graph does not make "${viewName}" reachable from "${input.primaryExistingViewName}". Blobby must return a complete, evidence-backed path using only approved views.`,
        );
      }
    });
    changedRelationshipEntries
      .filter((entry) => [entry.from, entry.to].some((viewName) => (
        relationshipDecisions[viewName.toLowerCase()] === 'propose_reusable'
      )))
      .forEach((entry) => issues.push(...proposedRelationshipIssues(entry)));
  }

  if (requireCompleteRelationshipReview) {
    const reportedContractFingerprints = new Set<string>();
    createContractEntries.forEach((entry) => {
      if (reportedContractFingerprints.has(entry.fingerprint)) return;
      reportedContractFingerprints.add(entry.fingerprint);
      const approvedCount = contractCounts.get(entry.fingerprint) || 0;
      const stagedCount = changedCounts.get(entry.fingerprint) || 0;
      if (stagedCount >= approvedCount) return;
      issues.push(
        `The staged relationships file is missing ${approvedCount - stagedCount} of ${approvedCount} exact approved create_reusable rows for ${entry.from} -> ${entry.to}. join_from_view, join_to_view, join_type, on_sql, relationship_type, and reversible must match the approved contract exactly.`,
      );
    });
  }

  if (hasExactRelationshipContractReview && primaryView) {
    Object.entries(relationshipDecisions).forEach(([viewName, decision]) => {
      if (decision !== 'create_reusable') return;
      const hasContract = createContractEntries.some((entry) => {
        const endpoints = [entry.from.toLowerCase(), entry.to.toLowerCase()];
        return endpoints.includes(primaryView) && endpoints.includes(viewName);
      });
      if (!hasContract) {
        issues.push(
          `The blueprint requires a reusable relationship between "${input.primaryExistingViewName}" and "${viewName}", but no exact create_reusable relationship contract was approved.`,
        );
      }
    });
  } else if (requireCompleteRelationshipReview && primaryView) {
    Object.entries(relationshipDecisions).forEach(([viewName, decision]) => {
      if (decision !== 'create_reusable') return;
      const generated = changedRelationshipEntries.some((entry) => {
        const endpoints = [entry.from.toLowerCase(), entry.to.toLowerCase()];
        return endpoints.includes(primaryView) && endpoints.includes(viewName);
      });
      if (!generated) {
        issues.push(
          `The blueprint requires a reusable relationship between "${input.primaryExistingViewName}" and "${viewName}", but the staged package does not contain that reviewed relationship change.`,
        );
      }
    });
  }
  const remainingContractCounts = new Map(contractCounts);
  changedRelationshipEntries.forEach((entry) => {
    const outsideScope = [entry.from, entry.to].filter((viewName) => !allowed.has(viewName.toLowerCase()));
    if (outsideScope.length > 0) {
      issues.push(
        `relationships adds or changes ${entry.from} -> ${entry.to} outside the reviewed topic data scope. Unapproved views: ${unique(outsideScope).join(', ')}. Approved existing views: ${approvedLabel}.`,
      );
    }
    if (hasExactRelationshipContractReview) {
      const decision = relationshipDecisions[contractDecisionView(entry)];
      if (decision === 'propose_reusable') return;
      const endpointDecisions = [entry.from, entry.to]
        .map((viewName) => relationshipDecisions[viewName.toLowerCase()]);
      if (endpointDecisions.includes('propose_reusable')) return;
      const remaining = remainingContractCounts.get(entry.fingerprint) || 0;
      if (remaining > 0) {
        remainingContractCounts.set(entry.fingerprint, remaining - 1);
        return;
      }
      issues.push(
        `relationships adds or changes ${entry.from} -> ${entry.to}, but the complete row does not exactly match an approved create_reusable relationship contract.`,
      );
      return;
    }
    const nonPrimaryEndpoints = [entry.from, entry.to]
      .filter((viewName) => viewName.toLowerCase() !== primaryView);
    const disallowedDecisions = nonPrimaryEndpoints.filter((viewName) => (
      !['create_reusable', 'propose_reusable'].includes(relationshipDecisions[viewName.toLowerCase()] || '')
    ));
    if (disallowedDecisions.length > 0) {
      issues.push(
        `relationships adds or changes ${entry.from} -> ${entry.to}, but the blueprint does not approve a reusable relationship change for: ${unique(disallowedDecisions).join(', ')}.`,
      );
    }
  });

  return unique(issues);
}

function availableViewMessage(viewNames: readonly string[]) {
  if (viewNames.length === 0) return 'No model views were returned by Omni.';
  const preview = viewNames.slice(0, 12).join(', ');
  return `Available internal view names include: ${preview}${viewNames.length > 12 ? ', ...' : ''}.`;
}

export function semanticModelReferenceIssues(
  files: readonly SemanticReferenceFile[],
  modelYaml: Pick<OmniModelYamlResponse, 'files' | 'viewNames'> | null | undefined,
) {
  const issues: string[] = [];
  const viewNames = semanticModelViewNames(modelYaml, files);
  const normalizedViewNames = new Set(viewNames.map((viewName) => viewName.toLowerCase()));

  files.forEach((file) => {
    const parsed = parsedYamlValue(file.yaml);
    if (file.fileName.endsWith('.topic')) {
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
      const topic = parsed as Record<string, unknown>;
      const baseView = topic.base_view;
      if (typeof baseView === 'string' && baseView.trim() && !normalizedViewNames.has(baseView.trim().toLowerCase())) {
        issues.push(
          `${file.fileName} references base_view "${baseView.trim()}", but no existing or staged view has that internal name. ${availableViewMessage(viewNames)} Map the topic to an existing view, or add the missing .view artifact before the topic.`,
        );
      }
      const accessFilterFields = topicAccessFilterFields(topic.access_filters);
      const accessFilterViewNames = new Set(
        accessFilterFields.map((fieldReference) => fieldReference.split('.')[0]?.toLowerCase()).filter(Boolean),
      );
      semanticTopicReferencedViewNames(file.yaml).forEach((viewName) => {
        const normalizedViewName = viewName.toLowerCase();
        if (normalizedViewNames.has(normalizedViewName)) return;
        if (typeof baseView === 'string' && baseView.trim().toLowerCase() === normalizedViewName) return;
        if (accessFilterViewNames.has(normalizedViewName)) return;
        issues.push(
          `${file.fileName} references view "${viewName}", but no existing or staged view has that internal name. ${availableViewMessage(viewNames)} Map the selector to an existing view, or add the missing .view artifact before the topic.`,
        );
      });
      const reachableViews = semanticTopicReachableViewNames(file.yaml);
      const normalizedReachableViews = new Set(reachableViews.map((viewName) => viewName.toLowerCase()));
      accessFilterFields.forEach((fieldReference) => {
        const [viewName, fieldName, ...extra] = fieldReference.split('.');
        if (!viewName || !fieldName || extra.length > 0) {
          issues.push(`${file.fileName} access_filters field "${fieldReference}" must use exact view_name.field_name syntax.`);
          return;
        }
        if (!normalizedViewNames.has(viewName.toLowerCase())) {
          issues.push(
            `${file.fileName} access_filters references "${fieldReference}", but no existing or staged view has internal name "${viewName}". ${availableViewMessage(viewNames)}`,
          );
          return;
        }
        if (!normalizedReachableViews.has(viewName.toLowerCase())) {
          const reachableMessage = reachableViews.length > 0
            ? `Reachable topic views: ${reachableViews.join(', ')}.`
            : 'The topic does not yet have a verified base or included view.';
          issues.push(
            `${file.fileName} access_filters references "${fieldReference}", but view "${viewName}" is not reachable from this topic. ${reachableMessage} Choose a field from the base view or an explicitly joined/included view.`,
          );
        }
      });
      return;
    }

    if (file.fileName !== 'relationships') return;
    const relationshipResult = parseRelationshipScopeEntries(file.yaml, file.fileName);
    issues.push(...relationshipResult.issues);
    relationshipResult.entries.forEach((entry) => {
      ([['join_from_view', entry.from], ['join_to_view', entry.to]] as const).forEach(([key, viewName]) => {
        if (!normalizedViewNames.has(viewName.toLowerCase())) {
          issues.push(
            `${file.fileName} relationship ${entry.rowNumber} references ${key} "${viewName}", but no existing or staged view has that internal name. ${availableViewMessage(viewNames)} Map the relationship endpoint or add its .view artifact first.`,
          );
        }
      });
    });
  });

  return Object.freeze(unique(issues));
}
