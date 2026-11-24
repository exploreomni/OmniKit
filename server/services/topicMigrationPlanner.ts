import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { isAlias, isMap, isNode, isScalar, isSeq, parseDocument, visit } from 'yaml';
import type { TopicMigrationAnalysis, TopicMigrationDependency, TopicMigrationIssue, TopicMigrationRequest, TopicMigrationTopic } from '../../shared/topicMigration';
import { previewDashboardRepairYaml } from './dashboardRepairYaml';
import { applySchemaMapToYaml, parseSchemaMap } from './modelMigration/helpers';
import { assertUniqueTopicExportKey, prepareTopicGroupYaml, topicYamlWriteFileName } from './modelMigration/topicFileIdentity';
import { topicMigrationDestinationPath } from './topicMigrationVerification';
import { reconcileTopicTableName, topicMigrationPhysicalTable, type TopicTableNameInventory } from './topicMigrationTableNames';
import { reviewTopicMigrationSqlDialect } from './topicMigrationSqlDialect';
import { canonicalKeepDestinationDefinitions, preserveDestinationView } from './topicMigrationPreservation';

type Obj = Record<string, unknown>;
type Kind = TopicMigrationDependency['kind'];
type Dependency = { kind: Kind; topics: Set<string>; reasons: Set<string>; fields: Set<string> };
type Context = { name: string; file?: string; underlying: string; shared: Obj; local?: Obj; fields: Map<string, { section: string; value: unknown; local: boolean }> };
const NAME = /^[A-Za-z_][A-Za-z0-9_/]*$/;
const SQL = new Set(['sql', 'on_sql', 'where_sql', 'having_sql', 'custom_sql', 'sql_table_name', 'always_where_sql', 'sql_filter', 'sql_distinct_key']);
const SECURITY = /(?:access_grants|access_filters|mask_unless|permissions|row_level|user_attributes|omni_attributes)/i;
const DISPLAY = new Set(['label', 'description', 'group_label', 'view_label', 'hidden', 'format', 'tags', 'ai_context', 'ai_description']);
const FIELD_REFS = new Set(['field', 'fields', 'filters', 'always_filter', 'default_filters', 'drill_fields', 'order_by', 'default_order_by', 'sorts', 'pivots', 'primary_key', 'cancel_grouping_fields']);
const TOPIC_KEYS = new Set(['name', 'label', 'description', 'base_view', 'joins', 'views', 'relationships', 'fields', 'filters', 'always_where_sql', 'always_filter', 'default_filters', 'order_by', 'default_order_by', 'hidden', 'group_label', 'default_topic', 'cache_policy', 'required_access_grants', 'access_filters', 'tags', 'ai_context', 'ai_description', 'symmetric_aggregates', 'drill_fields']);
const VIEW_KEYS = new Set(['name', 'label', 'description', 'catalog', 'database', 'schema', 'table_name', 'sql_table_name', 'sql', 'dimensions', 'measures', 'primary_key', 'default_filters', 'filters', 'hidden', 'group_label', 'view_label', 'tags', 'required_access_grants', 'access_filters', 'drill_fields', 'ai_context', 'ai_description']);
const FIELD_KEYS = new Set(['sql', 'label', 'description', 'group_label', 'hidden', 'format', 'type', 'aggregate_type', 'drill_fields', 'filters', 'primary_key', 'required_access_grants', 'mask_unless_access_grants', 'links', 'tags', 'timeframes', 'synonyms', 'bin_boundaries', 'convert_tz', 'timezone', 'sql_filter', 'sql_distinct_key', 'symmetric_aggregates', 'ai_context', 'ai_description']);
const MODEL_KEYS = new Set(['access_grants', 'default_topic_required_access_grants', 'default_topic_access_filters', 'query_timezone', 'timezone', 'week_start_day', 'fiscal_month_offset', 'locale', 'default_currency']);
const MODEL_METADATA = new Set(['name', 'label', 'description', 'connection', 'connection_id', 'connection_name', 'default_topic', 'ai_context', 'ai_description']);
const object = (value: unknown): value is Obj => !!value && typeof value === 'object' && !Array.isArray(value);
const entries = (value: Obj) => Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
const stem = (file: string) => file.replace(/(?:\.query)?\.(?:view|topic)$/, '');
const semanticName = (file: string) => stem(file).split('/').pop() || '';
const safeAuthoredPath = (file: string) => file.length <= 512 && !file.startsWith('/') && !file.includes('\\')
  && ![...file].some((character) => character.charCodeAt(0) < 32) && !file.split('/').some((part) => !part || part === '.' || part === '..');
const kindOf = (file: string): Kind | undefined => file.endsWith('.topic') ? 'topic' : file.endsWith('.view') ? 'view' : /(?:^|[/.])relationships?$/.test(file) ? 'relationships' : /(?:^|[/.])model$/.test(file) ? 'model' : undefined;
const detail = (error: unknown) => error instanceof Error ? error.message : 'Unrecognized YAML structure.';

function relationshipEndpoint(edge: Obj, side: 'from' | 'to'): string | undefined {
  const base = edge['join_' + side + '_view'];
  if (typeof base !== 'string' || !base || base !== base.trim()) return;
  const aliases = ['join_' + side + '_view_as', 'join_' + side + '_view_alias']
    .filter((key) => Object.hasOwn(edge, key)).map((key) => edge[key]);
  if (aliases.some((alias) => typeof alias !== 'string' || !alias || alias !== alias.trim()) || new Set(aliases).size > 1) return;
  return aliases.length ? aliases[0] as string : base;
}

/** Full authored snapshots, including unrelated files, bind every approval to exact read evidence. */
export function topicMigrationSnapshotHash(files: Record<string, string>): string {
  return 'sha256:' + createHash('sha256').update(JSON.stringify(Object.fromEntries(Object.entries(files).sort(([a], [b]) => a.localeCompare(b))))).digest('hex');
}

function readYaml(text: string): unknown {
  if (typeof text !== 'string' || text.length > 2_000_000) throw new Error('YAML exceeds the bounded topic planning limit.');
  const document = parseDocument(text, { uniqueKeys: true, strict: true, prettyErrors: false });
  if (document.errors.length || document.warnings.length || (!isMap(document.contents) && !isSeq(document.contents))) throw new Error('A valid YAML mapping or relationship list is required.');
  let nodes = 0;
  visit(document, (_key, node, path) => {
    if (++nodes > 25_000 || path.length > 64) throw new Error('YAML nesting exceeds the bounded topic planning limit.');
    if (isAlias(node) || (isNode(node) && 'anchor' in node && node.anchor)) throw new Error('Anchors and aliases need an explicit effective definition.');
    if (isNode(node) && node.tag && !['tag:yaml.org,2002:map', 'tag:yaml.org,2002:seq', 'tag:yaml.org,2002:str', 'tag:yaml.org,2002:int', 'tag:yaml.org,2002:float', 'tag:yaml.org,2002:bool', 'tag:yaml.org,2002:null'].includes(node.tag)) throw new Error('Custom YAML tags are not supported.');
    if (isMap(node)) for (const pair of node.items) {
      if (!isScalar(pair.key) || typeof pair.key.value !== 'string' || ['__proto__', 'prototype', 'constructor', '<<'].includes(pair.key.value)) throw new Error('YAML requires safe, unique string keys.');
    }
  });
  return document.toJS({ maxAliasCount: 0 });
}

export function inventoryMigrationTopics(files: Record<string, string>): TopicMigrationTopic[] {
  return Object.keys(files).filter((file) => file.endsWith('.topic')).sort().map((fileName) => {
    const result: TopicMigrationTopic = { id: fileName, name: stem(fileName), fileName };
    try {
      const value = readYaml(files[fileName]);
      if (!object(value)) throw new Error('Topic must be a mapping.');
      if (typeof value.label === 'string') result.name = value.label;
      if (typeof value.description === 'string') result.description = value.description;
      if (typeof value.base_view === 'string' && NAME.test(value.base_view)) result.baseView = value.base_view;
      else result.unavailableReason = 'An explicit base_view is required.';
    } catch (error) { result.unavailableReason = detail(error); }
    return result;
  });
}

/** No I/O: prepare authored additive branch files, not a claim of warehouse or dialect validity. */
export function buildTopicMigrationAnalysis(input: {
  request: TopicMigrationRequest; sourceFiles: Record<string, string>; targetFiles: Record<string, string>;
  targetChecksums?: Record<string, string>; sourceDialect: string; targetDialect: string;
  targetTableNames?: TopicTableNameInventory[];
  enableSqlDialectReview?: boolean;
}): TopicMigrationAnalysis {
  const { request, sourceFiles, targetFiles } = input;
  const selected = [...new Set(request.topicIds)].sort();
  const issues = new Map<string, TopicMigrationIssue>();
  const deps = new Map<string, Dependency>();
  const parsed = new Map<string, unknown>();
  const addIssue = (kind: TopicMigrationIssue['kind'], code: string, file: string | undefined, topics: Iterable<string>, message: string, nextAction: string, severity: TopicMigrationIssue['severity'] = 'blocker') => {
    const key = [kind, code, file || ''].join('|');
    const existing = issues.get(key);
    const topicIds = [...new Set([...(existing?.topicIds || []), ...topics])].sort();
    issues.set(key, { id: createHash('sha256').update(key).digest('hex').slice(0, 20), kind, severity, title: code, message, nextAction, topicIds, ...(file ? { fileName: file } : {}) });
  };
  const source = (file: string, topics: Iterable<string>): unknown => {
    if (parsed.has(file)) return parsed.get(file);
    try {
      if (!Object.hasOwn(sourceFiles, file)) throw new Error('The exact authored file is absent.');
      const value = readYaml(sourceFiles[file]); parsed.set(file, value); return value;
    } catch (error) {
      addIssue('source', 'Source definition unavailable', file, topics, detail(error), 'Provide the complete authored source definition and prepare again.');
      return undefined;
    }
  };
  const depend = (file: string, kind: Kind, topic: string, reason: string, field?: string) => {
    const dep = deps.get(file) || { kind, topics: new Set<string>(), reasons: new Set<string>(), fields: new Set<string>() };
    dep.topics.add(topic); dep.reasons.add(reason); if (field) dep.fields.add(field); deps.set(file, dep);
  };
  const result = (): TopicMigrationAnalysis => ({
    topics: inventoryMigrationTopics(sourceFiles).filter((topic) => selected.includes(topic.id)),
    dependencies: [...deps].sort(([a], [b]) => a.localeCompare(b)).map(([fileName, dep]) => ({ fileName, kind: dep.kind, topicIds: [...dep.topics].sort(), reasons: [...dep.reasons].sort() })),
    files: [], issues: [...issues.values()].sort((a, b) => a.id.localeCompare(b.id)),
    sourceHash: topicMigrationSnapshotHash(sourceFiles), targetHash: topicMigrationSnapshotHash(targetFiles),
  });
  if (!selected.length || selected.length > 100 || Object.keys(sourceFiles).length > 5000 || Object.keys(targetFiles).length > 5000) {
    addIssue('source', 'Selection exceeds planning bounds', undefined, selected, 'Select between one and 100 topics from a bounded model snapshot.', 'Reduce the selected scope.'); return result();
  }
  let preservationChoices: TopicMigrationRequest['keepDestinationDefinitions'];
  try { preservationChoices = canonicalKeepDestinationDefinitions(request.keepDestinationDefinitions); }
  catch (error) {
    addIssue('conflict', 'Invalid destination-preservation choice', undefined, selected, detail(error), 'Refresh this review and use only an offered per-view preservation choice.'); return result();
  }
  const views = new Map<string, string[]>();
  const viewNames = new Map<string, string[]>();
  for (const file of Object.keys(sourceFiles).filter((name) => kindOf(name) === 'view').sort()) {
    // Folders organize authored files; unqualified semantic names resolve only when unique.
    // Keep exact paths for writes/checksums and never fold case or prefer a nearby folder.
    const name = stem(file); views.set(name, [...(views.get(name) || []), file]);
    const shortName = semanticName(file); viewNames.set(shortName, [...(viewNames.get(shortName) || []), file]);
  }
  for (const key of ['fileMappings', 'reviewedSqlFiles', 'tableMappings']) if (Object.hasOwn(request, key)) {
    addIssue('mapping', 'Unsupported branch-review input: ' + key, undefined, selected,
      'Branch preparation preserves authored identities and SQL. This deprecated correction input is not accepted.',
      'Start a new topic selection without file, table, column, or SQL correction inputs.');
  }
  if (issues.size) return result();
  const schemaRules = parseSchemaMap(request.schemaMapText || '');
  const mappingLines = (request.schemaMapText || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (schemaRules.length !== mappingLines.length || new Set(schemaRules.map((rule) => rule.source.toLowerCase())).size !== schemaRules.length
    || schemaRules.some((rule) => !/^[A-Za-z_][\w$-]*(?:\.[A-Za-z_][\w$-]*){0,2}$/.test(rule.source) || !/^[A-Za-z_][\w$-]*(?:\.[A-Za-z_][\w$-]*){0,2}$/.test(rule.target))) {
    addIssue('mapping', 'Ambiguous data-location mapping', undefined, selected, 'Every mapping must have one explicit source and destination namespace.', 'Correct the mapping rows and prepare again.');
  }
  const relationshipFiles = Object.keys(sourceFiles).filter((file) => kindOf(file) === 'relationships').sort();
  const usedEdges = new Map<string, Set<number>>();
  const globalEdges: Array<{ file: string; index: number; edge: Obj }> = [];
  for (const file of relationshipFiles) {
    const value = source(file, selected);
    const list = Array.isArray(value) ? value : object(value) ? value.relationships : undefined;
    if (!Array.isArray(list) || list.some((edge) => !object(edge) || !relationshipEndpoint(edge, 'from') || !relationshipEndpoint(edge, 'to'))) {
      addIssue('source', 'Unsupported relationship definitions', file, selected, 'Relationships must have explicit from/to view identities.', 'Resolve or provide effective relationship definitions.'); continue;
    }
    list.forEach((edge, index) => globalEdges.push({ file, index, edge: edge as Obj }));
  }

  for (const topicId of selected) {
    if (kindOf(topicId) !== 'topic' || !Object.hasOwn(sourceFiles, topicId)) {
      addIssue('source', 'Selected topic unavailable', topicId, [topicId], 'The selected exact topic file is not in this snapshot.', 'Refresh the inventory and select the topic again.'); continue;
    }
    depend(topicId, 'topic', topicId, 'Complete selected topic behavior');
    const topic = source(topicId, [topicId]);
    if (!object(topic)) continue;
    for (const key of Object.keys(topic)) if (!TOPIC_KEYS.has(key)) addIssue('source', 'Unsupported topic property: ' + key, topicId, [topicId], 'Dependency behavior for this property cannot be proven.', 'Provide an explicit supported effective topic definition; do not discard the property.');
    if (typeof topic.base_view !== 'string' || !NAME.test(topic.base_view)) {
      addIssue('source', 'Explicit base view required', topicId, [topicId], 'The selected topic has no resolvable base_view.', 'Provide the exact base_view.'); continue;
    }
    const localViews = topic.views === undefined ? {} : topic.views;
    if (!object(localViews)) { addIssue('source', 'Unsupported topic view overrides', topicId, [topicId], 'Topic views must be a keyed mapping.', 'Resolve the topic view overrides.'); continue; }
    const contexts = new Map<string, Context>();
    const context = (name: string, underlying = name): Context | undefined => {
      const existing = contexts.get(name);
      if (existing) {
        if ([existing.underlying, existing.file ? stem(existing.file) : ''].includes(underlying)) return existing;
        addIssue('source', 'Conflicting alias context: ' + name, topicId, [topicId], 'One topic alias resolves to different underlying authored views.', 'Disambiguate the source alias before migrating.'); return;
      }
      const local = localViews[name];
      if (local !== undefined && !object(local)) { addIssue('source', 'Unsupported local view: ' + name, topicId, [topicId], 'Local view definitions must be mappings.', 'Resolve this local view.'); return; }
      if (object(local) && local.extends !== undefined) { addIssue('source', 'View inheritance needs effective evidence', topicId, [topicId], 'Topic-local extends cannot be flattened without preserving inheritance semantics.', 'Provide the effective alias/view definition.'); return; }
      const matches = (underlying.includes('/') ? views : viewNames).get(underlying) || [];
      if (matches.length !== 1) { addIssue('source', 'Exact view unresolved: ' + underlying, topicId, [topicId], 'An unqualified view name must match exactly one authored basename; qualified references must match an exact authored path. Case differences and duplicate basenames are not resolved automatically.', 'Provide the missing authored view or disambiguate the exact source reference.'); return; }
      const file = matches[0], base = source(file, [topicId]);
      if (!object(base)) return;
      if (typeof base.name === 'string' && ![semanticName(file), stem(file)].includes(base.name)) addIssue('source', 'Conflicting authored view identity', file, [topicId], 'The file identity and authored name disagree.', 'Resolve the exact semantic view identity.');
      for (const key of Object.keys(base)) if (!VIEW_KEYS.has(key)) addIssue('source', 'Unsupported view property: ' + key, file, [topicId], 'This property may contribute dependencies or behavior.', 'Provide an explicit supported effective view.');
      if (object(local)) for (const key of Object.keys(local)) if (!VIEW_KEYS.has(key)) addIssue('source', 'Unsupported local view property: ' + key, topicId, [topicId], 'This local property has unproven dependency behavior.', 'Resolve the effective local view.');
      const fields: Context['fields'] = new Map();
      for (const section of ['dimensions', 'measures']) {
        const shared = base[section] === undefined ? {} : base[section];
        const override = object(local) && local[section] !== undefined ? local[section] : {};
        if (!object(shared) || !object(override)) { addIssue('source', 'Unsupported field container', file, [topicId], 'Dimensions and measures must be keyed mappings.', 'Resolve the field definitions.'); continue; }
        for (const [field, localField] of entries(override)) if (Object.hasOwn(shared, field) && !isDeepStrictEqual(shared[field], localField)) {
          const sharedField = shared[field];
          if (!object(sharedField) || !object(localField) || Object.keys(sharedField).some((key) => !Object.hasOwn(localField, key))
            || Object.keys(sharedField).some((key) => object(sharedField[key]) && !isDeepStrictEqual(sharedField[key], localField[key]))) {
            addIssue('source', 'Partial local field override needs effective evidence', topicId, [topicId], 'A local override omits or ambiguously merges inherited field behavior.', 'Provide the complete effective local field definition without dropping inherited properties.');
          }
        }
        const merged = { ...shared, ...override };
        for (const [field, value] of entries(merged)) {
          if (!NAME.test(field) || fields.has(field) || (value !== null && !object(value))) { addIssue('source', 'Ambiguous field identity: ' + field, file, [topicId], 'Fields need unique exact names and mapping definitions.', 'Resolve the authored field identity.'); continue; }
          if (object(value)) for (const key of Object.keys(value)) if (!FIELD_KEYS.has(key)) addIssue('source', 'Unsupported field property: ' + key, file, [topicId], 'This field property may add behavior or dependencies.', 'Resolve the complete effective field definition.');
          fields.set(field, { section, value, local: Object.hasOwn(override, field) });
        }
      }
      const ctx: Context = { name, file, underlying: semanticName(file), shared: base, ...(object(local) ? { local } : {}), fields }; contexts.set(name, ctx);
      depend(file, 'view', topicId, 'Exposed topic view: ' + name); return ctx;
    };
    const base = context(topic.base_view);
    if (!base) continue;
    const localEdges = topic.relationships === undefined ? [] : topic.relationships;
    if (!Array.isArray(localEdges) || localEdges.some((edge) => !object(edge) || !relationshipEndpoint(edge, 'from') || !relationshipEndpoint(edge, 'to'))) addIssue('source', 'Unsupported local relationships', topicId, [topicId], 'Topic relationships must have unambiguous explicit view and alias identities.', 'Resolve local relationship definitions.');
    const edgeFrom = (edge: Obj) => relationshipEndpoint(edge, 'from');
    const edgeTo = (edge: Obj) => relationshipEndpoint(edge, 'to');
    const chosenEdges: Obj[] = [];
    const walkJoins = (parent: string, joins: unknown, ancestors: string[]) => {
      if (!object(joins) || ancestors.length > 60) { addIssue('source', 'Unsupported join tree', topicId, [topicId], 'Joins must be a bounded nested mapping ending in empty mappings.', 'Make the effective join tree explicit.'); return; }
      for (const [name, children] of entries(joins)) {
        if (!NAME.test(name) || ancestors.includes(name)) { addIssue('source', 'Join cycle or invalid identity', topicId, [topicId], 'A join repeats an ancestor or has an unsupported identity.', 'Resolve the cycle using explicit supported aliases.'); continue; }
        const match = (edge: Obj) => edgeFrom(edge) === parent && edgeTo(edge) === name || edge.reversible === true && edgeTo(edge) === parent && edgeFrom(edge) === name;
        const local = Array.isArray(localEdges) ? localEdges.filter((edge): edge is Obj => object(edge) && match(edge)) : [];
        const global = globalEdges.filter((row) => match(row.edge));
        const candidates = local.length ? local : global.map((row) => row.edge);
        if (candidates.length !== 1) { addIssue('source', 'Join definition unresolved: ' + parent + ' → ' + name, topicId, [topicId], 'Every exposed join must have one exact, unambiguous relationship.', 'Resolve missing or duplicate relationship definitions.'); continue; }
        const edge = candidates[0];
        const underlying = edgeTo(edge) === name ? edge.join_to_view : edge.join_from_view;
        if (typeof underlying !== 'string') continue;
        if (!context(name, underlying)) continue;
        chosenEdges.push(edge);
        if (!local.length) {
          const row = global[0]; depend(row.file, 'relationships', topicId, 'Required join: ' + parent + ' → ' + name);
          const used = usedEdges.get(row.file) || new Set<number>(); used.add(row.index); usedEdges.set(row.file, used);
        }
        walkJoins(name, children, [...ancestors, name]);
      }
    };
    if (topic.joins === undefined) {
      if (globalEdges.some(({ edge }) => edgeFrom(edge) === topic.base_view || edgeTo(edge) === topic.base_view) || Array.isArray(localEdges) && localEdges.length) {
        addIssue('source', 'Computed joins need effective evidence', topicId, [topicId], 'Omitted joins may expose computed defaults; they cannot be interpreted as no joins.', 'Provide the explicit effective join tree, or joins: {} when truly empty.');
      }
    } else walkJoins(topic.base_view, topic.joins, [topic.base_view]);
    for (const name of Object.keys(localViews)) if (!contexts.has(name)) addIssue('source', 'Unresolved local view: ' + name, topicId, [topicId], 'A local override is outside the proven join tree.', 'Resolve the effective alias and join context.');

    const queue: Array<[string, string]> = [], queued = new Set<string>(), graph = new Map<string, Set<string>>();
    const fieldRef = (ref: string, containing: string, from?: string, sharedDefinition = false) => {
      const parts = ref.split('.');
      let view = parts.length === 1 ? containing : parts.length === 2 ? parts[0] : '';
      const owner = contexts.get(containing);
      // A shared definition's self-reference is evaluated in its own role, not a sibling alias.
      // Topic-local definitions and relationship/topic expressions never receive this inference.
      if (sharedDefinition && owner && parts.length === 2 && [owner.underlying, owner.file ? stem(owner.file) : ''].includes(view)) view = containing;
      const field = parts.length === 1 ? parts[0] : parts[1];
      const ctx = contexts.get(view);
      if (!ctx || !ctx.fields.has(field)) {
        addIssue('source', 'Field dependency unresolved: ' + ref, topicId, [topicId], 'The exact field is not defined in the effective topic view context.', 'Include its explicit view/join and authored field definition.'); return;
      }
      const id = view + '.' + field;
      if (from) { const edges = graph.get(from) || new Set<string>(); edges.add(id); graph.set(from, edges); }
      if (!queued.has(id)) { queued.add(id); queue.push([view, field]); }
    };
    const scan = (value: unknown, containing: string, from?: string, key = '', sharedDefinition = false): void => {
      if (Array.isArray(value)) { value.forEach((entry) => scan(entry, containing, from, key, sharedDefinition)); return; }
      if (object(value)) {
        for (const [childKey, child] of entries(value)) {
          if (DISPLAY.has(childKey)) continue;
          if (FIELD_REFS.has(key) && /^[A-Za-z_][\w/]*\.[A-Za-z_]\w*$/.test(childKey)) fieldRef(childKey, containing, from, sharedDefinition);
          else if (['filters', 'always_filter', 'default_filters'].includes(key) && contexts.get(containing)?.fields.has(childKey)) fieldRef(childKey, containing, from, sharedDefinition);
          scan(child, containing, from, childKey, sharedDefinition);
        }
        return;
      }
      if (typeof value !== 'string') return;
      for (const match of value.matchAll(/\$\{([^}]+)\}/g)) {
        const ref = match[1];
        if (ref === 'TABLE') continue;
        if (contexts.has(ref)) continue;
        fieldRef(ref, containing, from, sharedDefinition);
      }
      if (/\{\{/.test(value)) addIssue(SECURITY.test(key) || SECURITY.test(value) ? 'security' : 'sql', 'Dynamic expression requires native review', topicId, [topicId], 'The authored template or user-attribute expression is retained unchanged; static planning does not execute or validate it.', 'Verify the template and required user attributes in the review branch before merging in Omni.', 'review');
      if (FIELD_REFS.has(key)) {
        const reference = ['sorts', 'order_by', 'default_order_by'].includes(key) ? value.replace(/\s+(?:asc|desc)$/i, '') : value;
        if (/^[A-Za-z_][\w/]*(?:\.[A-Za-z_]\w*)?$/.test(reference)) fieldRef(reference, containing, from, sharedDefinition);
        else if (!/\$\{/.test(reference)) addIssue('source', 'Unsupported field reference shape', topicId, [topicId], 'A field, ordering, or filter reference cannot be resolved exactly.', 'Provide the exact semantic field reference.');
      }
    };
    const allFields = [...contexts.values()].flatMap((ctx) => [...ctx.fields].map(([field, definition]) => ({ ctx, field, definition, id: ctx.name + '.' + field })));
    const exposed = new Set<string>();
    if (topic.fields === undefined) allFields.forEach((row) => exposed.add(row.id));
    else if (!Array.isArray(topic.fields) || topic.fields.some((value) => typeof value !== 'string')) addIssue('source', 'Unsupported topic field selection', topicId, [topicId], 'Fields must be explicit supported selectors.', 'Use exact fields, documented view wildcards, or tags.');
    else {
      const priority = (raw: string) => { const value = raw.replace(/^-/, ''); return value === 'all_views.*' ? 0 : value.endsWith('.*') ? 1 : value.startsWith('tag:') ? 2 : value.includes(':tag:') ? 3 : 4; };
      for (const raw of [...topic.fields as string[]].sort((a, b) => priority(a) - priority(b))) {
        const exclude = raw.startsWith('-'), selector = exclude ? raw.slice(1) : raw;
        const matched = allFields.filter(({ ctx, field, definition, id }) => {
          const tags = object(definition.value) && Array.isArray(definition.value.tags) ? definition.value.tags : [];
          return selector === 'all_views.*' || selector === ctx.name + '.*' || selector === id
            || selector.startsWith('tag:') && tags.includes(selector.slice(4))
            || selector.startsWith(ctx.name + ':tag:') && tags.includes(selector.slice(ctx.name.length + 5))
            || selector === field && ctx.name === topic.base_view;
        });
        if (!matched.length) addIssue('source', 'Unresolved field selector: ' + selector, topicId, [topicId], 'This selector has no provable exact fields.', 'Resolve the selector against authored effective fields.');
        matched.forEach((row) => exclude ? exposed.delete(row.id) : exposed.add(row.id));
      }
    }
    exposed.forEach((ref) => fieldRef(ref, topic.base_view as string));
    // Preserve dependencies in every authored local override, even when hidden from the field picker.
    for (const row of allFields) if (row.definition.local) fieldRef(row.id, row.ctx.name);
    scan(Object.fromEntries(entries(topic).filter(([key]) => !['views', 'joins', 'fields', 'relationships'].includes(key))), topic.base_view);
    chosenEdges.forEach((edge) => scan(edge, topic.base_view as string));
    if (Array.isArray(localEdges)) localEdges.forEach((edge) => scan(edge, topic.base_view as string));
    for (const ctx of contexts.values()) {
      scan(Object.fromEntries(entries(ctx.shared).filter(([key]) => !['dimensions', 'measures'].includes(key))), ctx.name, undefined, '', true);
      if (ctx.local) scan(Object.fromEntries(entries(ctx.local).filter(([key]) => !['dimensions', 'measures'].includes(key))), ctx.name);
    }
    for (let index = 0; index < queue.length; index++) {
      if (index > 20_000) { addIssue('source', 'Dependency closure exceeds bounds', topicId, [topicId], 'The selected topic has too many recursive dependencies.', 'Reduce or simplify the authored topic.'); break; }
      const [view, field] = queue[index], ctx = contexts.get(view)!, definition = ctx.fields.get(field)!;
      if (ctx.file) {
        const shared = source(ctx.file, [topicId]);
        const sharedFields = object(shared) ? shared[definition.section] : undefined;
        if (object(sharedFields) && Object.hasOwn(sharedFields, field)) {
          depend(ctx.file, 'view', topicId, 'Required field: ' + view + '.' + field, definition.section + '.' + field);
          // The shared file still contains its base formula even when this topic overrides it.
          // Close both definitions so a local override cannot leave a dangling shared reference.
          scan(sharedFields[field], view, view + '.' + field, '', true);
        }
      }
      scan(definition.value, view, view + '.' + field, '', !definition.local);
    }
    const completed = new Set<string>(), active = new Set<string>();
    const cycle = (node: string, depth = 0): void => {
      if (active.has(node) || depth > 100) { addIssue('source', 'Recursive field dependency cycle', topicId, [topicId], 'A field formula cycle or excessive recursive depth prevents a complete closure.', 'Resolve the recursive field definitions.'); return; }
      if (completed.has(node)) return;
      active.add(node); for (const child of graph.get(node) || []) cycle(child, depth + 1); active.delete(node); completed.add(node);
    };
    for (const node of graph.keys()) cycle(node);
  }

  const candidates = new Map<string, unknown>();
  for (const [file, dep] of deps) {
    const value = source(file, dep.topics);
    if (dep.kind === 'view' && object(value)) {
      const scoped = { ...value };
      for (const section of ['dimensions', 'measures']) if (object(value[section])) {
        scoped[section] = Object.fromEntries(entries(value[section]).filter(([field]) => dep.fields.has(section + '.' + field)));
      }
      candidates.set(file, scoped);
    } else if (dep.kind === 'relationships') {
      const edges = globalEdges.filter((row) => row.file === file && usedEdges.get(file)?.has(row.index)).map((row) => row.edge);
      candidates.set(file, Array.isArray(value) ? edges : { ...(object(value) ? value : {}), relationships: edges });
    } else candidates.set(file, value);
  }
  const modelFiles = Object.keys(sourceFiles).filter((file) => kindOf(file) === 'model');
  const targetModelFiles = Object.keys(targetFiles).filter((file) => kindOf(file) === 'model');
  if (modelFiles.length > 1 || targetModelFiles.length > 1) addIssue('security', 'Ambiguous model-wide requirements', undefined, selected, 'Multiple model setting files cannot be reconciled automatically.', 'Provide the effective model-wide settings and policies.');
  const modelFile = modelFiles[0];
  const model = modelFile ? source(modelFile, selected) : {};
  let targetModel: unknown = {};
  try { if (targetModelFiles[0]) targetModel = readYaml(targetFiles[targetModelFiles[0]]); }
  catch (error) { addIssue('security', 'Target model policies unavailable', targetModelFiles[0], selected, detail(error), 'Read valid destination model policies before proceeding.'); }
  const grants = new Map<string, Set<string>>();
  for (const [file, candidate] of candidates) {
    const dep = deps.get(file)!;
    const inspect = (value: unknown, key = ''): void => {
      if (['required_access_grants', 'mask_unless_access_grants'].includes(key)) {
        if (!Array.isArray(value) || value.some((grant) => typeof grant !== 'string' || !NAME.test(grant))) {
          addIssue('security', 'Unsupported access-grant reference', file, dep.topics, 'The authored policy has no explicit list of exact access-grant names.', 'Resolve the required grant identities without removing the policy.'); return;
        }
        for (const grant of value as string[]) {
          const topics = grants.get(grant) || new Set<string>(); dep.topics.forEach((topic) => topics.add(topic)); grants.set(grant, topics);
        }
      } else if (Array.isArray(value)) value.forEach((child) => inspect(child, key));
      else if (object(value)) for (const [childKey, child] of entries(value)) inspect(child, childKey);
    };
    inspect(candidate);
  }
  if (!object(model) || !object(targetModel)) addIssue('security', 'Invalid model-wide requirements', modelFile, selected, 'Model settings must be an explicit mapping.', 'Resolve the effective model settings.');
  else {
    for (const key of Object.keys(model)) if (!MODEL_KEYS.has(key) && !MODEL_METADATA.has(key)) addIssue('source', 'Unsupported model behavior: ' + key, modelFile, selected, 'An unclassified source model setting may carry required dependencies or security.', 'Identify its selected-topic dependencies before preparing the branch.');
    for (const key of new Set([...Object.keys(model), ...Object.keys(targetModel)].filter((key) => key !== 'access_grants' && (MODEL_KEYS.has(key) || SECURITY.test(key))))) {
      if (!isDeepStrictEqual(model[key], targetModel[key])) addIssue(SECURITY.test(key) ? 'security' : 'validation', 'Model requirement differs: ' + key, modelFile || targetModelFiles[0], selected,
        'The destination-wide setting will not be changed by this topic package.',
        SECURITY.test(key) ? 'Reconcile the security default separately without weakening existing destination policies.' : 'Review this model-wide behavior in Omni; applying source defaults could affect unrelated destination topics.',
        SECURITY.test(key) ? 'blocker' : 'review');
    }
    if (Array.isArray(model.default_topic_required_access_grants)) for (const grant of model.default_topic_required_access_grants) {
      if (typeof grant === 'string' && NAME.test(grant)) grants.set(grant, new Set(selected));
      else addIssue('security', 'Unsupported default access-grant reference', modelFile, selected, 'Default grants require exact authored names.', 'Resolve the model policy before preparing a branch.');
    }
    for (const [grant, topics] of grants) {
      const sourceGrant = object(model.access_grants) ? model.access_grants[grant] : undefined;
      const targetGrant = object(targetModel.access_grants) ? targetModel.access_grants[grant] : undefined;
      if (!object(sourceGrant)) addIssue('security', 'Required access grant unavailable: ' + grant, modelFile, topics, 'The exact required authored grant definition is missing or unsupported.', 'Provide the required source model grant definition; it will not be invented.');
      else if (!isDeepStrictEqual(sourceGrant, targetGrant)) addIssue('security', 'Required access grant not preserved: ' + grant, modelFile, topics,
        'The destination grant is missing or differs. This additive topic workflow does not modify model policy maps.',
        'Establish this exact required grant through a separate reviewed model change, then prepare the topic branch again.');
    }
    if (grants.size) addIssue('security', 'Authored security requires native review', modelFile, [...new Set([...grants.values()].flatMap((topics) => [...topics]))],
      'Required grant definitions are checked separately. User-attribute assignments and effective access have not been executed or verified.',
      'Verify effective access for the intended users in Omni before manually merging the branch.', 'review');
  }

  const analysis = result();
  for (const [file, choice] of Object.entries(preservationChoices || {})) {
    if (deps.get(file)?.kind !== 'view' || choice.sourceHash !== analysis.sourceHash || choice.targetHash !== analysis.targetHash) {
      addIssue('conflict', 'Stale or unselected destination-preservation choice', file, selected,
        'This view choice does not match the selected dependency closure and exact current authored snapshots.',
        'Clear the choice, refresh the source and destination, and explicitly review the current per-view option.');
    }
  }
  if (input.enableSqlDialectReview) analysis.sqlDialectPolicy = {
    version: 'column_identifiers_v1', sourceDialect: input.sourceDialect, targetDialect: input.targetDialect,
  };
  const destinations = new Map<string, { file: string; topics: Set<string> }>();
  for (const [file, dep] of [...deps].sort(([a], [b]) => a.localeCompare(b))) {
    let destination = file;
    let before: string | null = null;
    let proposed = '';
    let tableNameCorrection: TopicMigrationAnalysis['files'][number]['tableNameCorrection'];
    let sqlDialectReview: TopicMigrationAnalysis['files'][number]['sqlDialectReview'];
    let preservationOption: TopicMigrationAnalysis['files'][number]['preservationOption'];
    let destinationPreservation: TopicMigrationAnalysis['files'][number]['destinationPreservation'];
    const fail = (kind: TopicMigrationIssue['kind'], title: string, message: string, nextAction: string) => addIssue(kind, title, file, dep.topics, message, nextAction);
    try {
      if (!safeAuthoredPath(file)) throw new Error('The required authored file path is unsafe.');
      const candidate = candidates.get(file);
      if (candidate === undefined) throw new Error('The source dependency has no valid definition.');
      proposed = authoredSubset(sourceFiles[file], candidate, dep.kind, dep.fields, usedEdges.get(file));
      if (dep.kind === 'topic') {
        assertUniqueTopicExportKey(file, sourceFiles);
        assertUniqueTopicExportKey(file, targetFiles);
        proposed = prepareTopicGroupYaml(file, proposed);
      }
      const beforeMapping = readYaml(proposed);
      const mapped = applySchemaMapToYaml(proposed, schemaRules);
      proposed = mapped.yaml;
      if (input.targetTableNames && dep.kind === 'view' && !file.endsWith('.query.view')) {
        const reference = topicMigrationPhysicalTable(proposed);
        if (reference) {
          const inventories = input.targetTableNames.filter(inventory => inventory.namespace === reference.namespace);
          const resolved = reconcileTopicTableName(proposed, inventories.length === 1 ? inventories[0] : undefined);
          if (resolved.status === 'corrected') {
            proposed = resolved.yaml;
            tableNameCorrection = { namespace: reference.namespace, from: reference.tableName, to: resolved.targetTableName! };
          } else if (['ambiguous', 'missing', 'unavailable'].includes(resolved.status)) {
            addIssue('mapping', resolved.status === 'ambiguous' ? 'Ambiguous destination table spelling'
              : resolved.status === 'missing' ? 'Destination table name was not matched' : 'Destination table-name metadata unavailable', file, dep.topics,
            resolved.status === 'ambiguous' ? 'Multiple destination names differ only by case. The source table name is unchanged.'
              : resolved.status === 'missing' ? 'No exact or unique case-only match was found in the selected namespace. The source table name is unchanged.'
                : 'A complete bounded destination inventory could not be read. The source table name is unchanged.',
            'Review this view in Omni. No replacement table, schema, SQL, or column name is guessed.', 'review');
          }
        }
      }
      if (input.enableSqlDialectReview && !file.endsWith('.query.view')) {
        const reference = topicMigrationPhysicalTable(proposed);
        const inventories = input.targetTableNames?.filter(item => item.status === 'available' && item.namespace === reference?.namespace) || [];
        const inventory = inventories.length === 1 ? inventories[0] : undefined;
        const matches = inventory?.tableNames.filter(name => name.toLowerCase() === reference?.tableName.toLowerCase()) || [];
        const columns = matches.length === 1 && matches[0] === reference?.tableName
          ? inventory?.columnsByTable?.find(table => table.tableName === reference?.tableName)?.columns : undefined;
        const reviewed = reviewTopicMigrationSqlDialect({ yaml: proposed, kind: dep.kind,
          sourceDialect: input.sourceDialect, targetDialect: input.targetDialect, columns });
        proposed = reviewed.yaml;
        sqlDialectReview = { corrections: reviewed.corrections, findings: reviewed.findings };
      } else if (input.enableSqlDialectReview) {
        sqlDialectReview = { corrections: [], findings: [{ path: '$', reason: 'UNSUPPORTED_VIEW: Query-view SQL stays unchanged and requires native review.' }] };
      }
      const draft = readYaml(proposed);
      if (!isDeepStrictEqual(securityValues(beforeMapping), securityValues(draft))) throw new Error('Explicit namespace substitution would change authored security. Policy values must remain unchanged.');
      destination = topicMigrationDestinationPath({ sourceFileName: file, fileName: file, kind: dep.kind, proposed }, request.schemaMapText || '');
      before = Object.hasOwn(targetFiles, destination) ? targetFiles[destination] : null;
      const collision = destinations.get(destination.toLowerCase());
      if (collision) {
        addIssue('conflict', 'Mapped destination path collision', destination, [...collision.topics, ...dep.topics],
          'Multiple source dependencies resolve to the same destination file.', 'Choose distinct destination namespaces and prepare again.');
      } else destinations.set(destination.toLowerCase(), { file, topics: dep.topics });
      if (Object.keys(targetFiles).some(target => target !== destination && target.toLowerCase() === destination.toLowerCase())) {
        fail('conflict', 'Destination path differs only by case', 'The destination already contains a conflicting authored path.', 'Resolve the exact destination identity in Omni.');
      }
      if (dep.kind === 'view' && Object.keys(targetFiles).some((target) => target !== destination && kindOf(target) === 'view' && semanticName(target) === semanticName(file))) {
        fail('conflict', 'Destination semantic identity exists at another path', 'The destination already defines this exact semantic view name in another authored folder.', 'Resolve the duplicate identity in Omni. A folder move does not create a separate semantic view.');
      }
      if (mapped.replacements) addIssue('mapping', 'Explicit namespace substitutions need review', file, dep.topics,
        mapped.replacements + ' explicit substitution(s) appear in this authored diff. Physical presence and SQL validity have not been verified.',
        'Review every substitution and validate the destination branch in Omni before merging.', 'review');
      const sql = sqlValues(draft);
      if (sql.size) addIssue('sql', 'Authored SQL requires native review', file, dep.topics,
        input.enableSqlDialectReview
          ? `${sqlDialectReview?.corrections.length || 0} supported identifier correction(s) proposed; ${sqlDialectReview?.findings.length || 0} compatibility finding(s) need review. No SQL was executed. Source dialect: ${input.sourceDialect || 'unknown'}; destination dialect: ${input.targetDialect || 'unknown'}.`
          : sql.size + ' authored SQL expression(s) are retained without dialect conversion or execution. Source dialect: ' + (input.sourceDialect || 'unknown') + '; destination dialect: ' + (input.targetDialect || 'unknown') + '.',
        'Review SQL, filters, formulas, and query results in the branch. Fix dialect-specific behavior in Omni before manually merging.', 'review');
      if (dep.kind === 'view') addIssue('validation', file.endsWith('.query.view') || object(draft) && draft.sql !== undefined ? 'Authored query view is unvalidated' : 'Warehouse bindings are unvalidated', file, dep.topics,
        'This package preserves the required authored view; it does not prove destination tables, columns, query results, or physical access.',
        'Validate warehouse bindings and queries in Omni. No query view or replacement table is generated.', 'review');
      if (securityValues(draft).size) addIssue('security', 'Authored policies require effective-access review', file, dep.topics,
        'Authored policy values are retained exactly. Runtime user attributes and effective access still require review.',
        'Verify effective access in Omni before merging; existing destination policies cannot be overwritten by this package.', 'review');
      const choice = preservationChoices?.[file];
      let ordinary: ReturnType<typeof previewDashboardRepairYaml> | undefined;
      try { ordinary = previewDashboardRepairYaml(before === null ? undefined : before, proposed); }
      catch (mergeError) {
        if (dep.kind !== 'view' || before === null || file.endsWith('.query.view')) throw mergeError;
        const preserved = preserveDestinationView(before, proposed);
        preservationOption = { destinationFileName: destination, sourceHash: analysis.sourceHash, targetHash: analysis.targetHash };
        if (!choice) throw mergeError;
        if (!isDeepStrictEqual(choice, preservationOption)) throw new Error('The chosen destination path or authored snapshot changed. Review a fresh preservation option.');
        proposed = preserved.yaml;
        destinationPreservation = { keptPaths: preserved.keptPaths, addedPaths: preserved.addedPaths, omittedSourcePaths: preserved.omittedSourcePaths };
        addIssue('conflict', 'Destination definitions explicitly retained', file, dep.topics,
          'Every existing destination property and complete field definition is retained. Only complete missing source fields are added; retained SQL, filters, and physical bindings may differ from the source.'
            + (preserved.omittedSourcePaths.length ? ' Source-only properties not copied: ' + preserved.omittedSourcePaths.join(', ') + '.' : ''),
          'Review the kept and added paths and final diff. Validate selected-topic behavior and effective access in Omni before deployment.', 'review');
      }
      if (ordinary) {
        if (choice) throw new Error('This view no longer has an eligible preservation conflict. Clear the stale choice and review again.');
        proposed = ordinary.yaml;
      }
      const changed = before !== proposed;
      const writeFileName = dep.kind === 'topic' ? topicYamlWriteFileName(destination, proposed) : destination;
      if (before !== null && changed && !input.targetChecksums?.[destination]) fail('validation', 'Destination checksum unavailable', 'An existing destination file needs its exact checksum before an additive branch write.', 'Refresh destination YAML with checksums.');
      analysis.files.push({ sourceFileName: file, fileName: destination, destinationFileName: destination, kind: dep.kind, topicIds: [...dep.topics].sort(), before, proposed,
        ...(writeFileName !== destination ? { writeFileName } : {}),
        ...(tableNameCorrection ? { tableNameCorrection } : {}),
        ...(sqlDialectReview ? { sqlDialectReview } : {}),
        ...(preservationOption ? { preservationOption } : {}), ...(destinationPreservation ? { destinationPreservation } : {}),
        ...(input.targetChecksums?.[destination] ? { previousChecksum: input.targetChecksums[destination] } : {}),
        status: !changed ? 'reuse' : before === null ? 'create' : 'add' });
    } catch (error) {
      fail('conflict', 'Dependency cannot be merged safely', detail(error), 'Resolve the exact authored conflict or unsupported shape without replacing destination definitions.');
      analysis.files.push({ sourceFileName: file, fileName: destination, destinationFileName: destination, kind: dep.kind, topicIds: [...dep.topics].sort(), before, proposed,
        ...(preservationOption ? { preservationOption } : {}), status: 'blocked' });
    }
  }
  analysis.issues = [...issues.values()].sort((a, b) => a.id.localeCompare(b.id));
  analysis.dependencies = result().dependencies;
  const blocked = new Set(analysis.issues.filter((issue) => issue.severity === 'blocker').flatMap((issue) => issue.topicIds));
  for (const file of analysis.files) if (file.topicIds.some((topic) => blocked.has(topic))) file.status = 'blocked';
  return analysis;
}

function sqlValues(value: unknown, path = '$', secure = false, result = new Map<string, string>()): Map<string, string> {
  if (Array.isArray(value)) value.forEach((entry, index) => sqlValues(entry, path + '[' + index + ']', secure, result));
  else if (object(value)) for (const [key, child] of entries(value)) {
    const protectedPath = secure || SECURITY.test(key);
    if (SQL.has(key) && key !== 'sql_table_name' && !protectedPath) {
      if (typeof child !== 'string') throw new Error('SQL must be an explicit scalar string.');
      result.set(path + '.' + key, child);
    } else sqlValues(child, path + '.' + key, protectedPath, result);
  }
  return result;
}

function securityValues(value: unknown, path = '$', result = new Map<string, unknown>()): Map<string, unknown> {
  if (Array.isArray(value)) value.forEach((entry, index) => securityValues(entry, path + '[' + index + ']', result));
  else if (object(value)) for (const [key, child] of entries(value)) {
    if (SECURITY.test(key) || typeof child === 'string' && SECURITY.test(child)) result.set(path + '.' + key, child);
    else securityValues(child, path + '.' + key, result);
  }
  return result;
}

/** Keep complete authored files byte-for-byte; prune only proven out-of-scope definitions. */
function authoredSubset(text: string, candidate: unknown, kind: Kind, fields: Set<string>, edges?: Set<number>): string {
  if (isDeepStrictEqual(readYaml(text), candidate)) return text;
  const document = parseDocument(text, { uniqueKeys: true, strict: true, prettyErrors: false, keepSourceTokens: true });
  if (kind === 'view' && isMap(document.contents)) {
    for (const section of ['dimensions', 'measures']) {
      const container = document.contents.get(section, true);
      if (isMap(container)) for (const pair of [...container.items]) {
        if (!isScalar(pair.key) || typeof pair.key.value !== 'string') throw new Error('Authored field identity is unsupported.');
        if (!fields.has(section + '.' + pair.key.value)) container.delete(pair.key.value);
      }
    }
  } else if (kind === 'relationships') {
    const list = isSeq(document.contents) ? document.contents : isMap(document.contents) ? document.contents.get('relationships', true) : undefined;
    if (!isSeq(list)) throw new Error('Authored relationships require an explicit list.');
    list.items = list.items.filter((_edge, index) => edges?.has(index));
  } else throw new Error('The authored subset has no safe structural preservation rule.');
  const output = document.toString({ lineWidth: 0 });
  if (!isDeepStrictEqual(readYaml(output), candidate)) throw new Error('The authored subset could not be preserved exactly.');
  return output;
}
