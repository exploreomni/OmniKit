import { isDeepStrictEqual } from 'node:util';
import { isAlias, isMap, isNode, isScalar, parseDocument, visit } from 'yaml';
import { DashboardRepairYamlConflictError, previewDashboardRepairYaml } from './dashboardRepairYaml';
import { buildTopicMigrationAnalysis } from './topicMigrationPlanner';
import { dashboardPackageBindingKey, isDashboardPackageBindingMapping, type DashboardPackageBindingMapping } from '../../shared/dashboardPackageBindings';

type Obj = Record<string, unknown>;
type Kind = 'view' | 'topic' | 'relationships' | 'model';
export interface DashboardPackageDependencyFile {
  fileName: string; sourceFileName: string; before: string; after: string;
  /** Read-only source requirements for conflict inspection; never executable output. */
  sourceComparison?: string;
  action: 'create' | 'add' | 'reuse' | 'conflict'; reason?: string;
}
export interface DashboardPackageDependencyPlan {
  files: DashboardPackageDependencyFile[];
  issues: Array<{ code: string; reference: string; message: string }>;
  /** Current eligible comparisons only, never implicit approval. */
  bindingMappings?: DashboardPackageBindingMapping[];
}
const object = (value: unknown): value is Obj => !!value && typeof value === 'object' && !Array.isArray(value);
const kind = (name: string): Kind | undefined => name.endsWith('.topic') ? 'topic' : name.endsWith('.view') ? 'view'
  : /(?:^|[/.])relationships?$/.test(name) ? 'relationships' : /(?:^|[/.])model$/.test(name) ? 'model' : undefined;
const stem = (name: string) => name.replace(/(?:\.query)?\.(?:view|topic)$/, '');
const basename = (name: string) => stem(name).split('/').pop()!;
const safePath = (name: string) => !!name && name.length <= 512 && !name.includes('\\')
  && ![...name].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)
  && name.split('/').every(part => part && part !== '.' && part !== '..');
const DISPLAY = new Set(['label', 'description', 'group_label', 'view_label', 'format', 'tags', 'ai_context', 'ai_description']);
const FIELD_REFS = new Set(['field', 'fields', 'filters', 'always_filter', 'default_filters', 'drill_fields', 'order_by', 'default_order_by', 'sorts', 'pivots', 'primary_key', 'cancel_grouping_fields']);
const VIEW_KEYS = new Set(['name', 'label', 'description', 'catalog', 'database', 'schema', 'table_name', 'sql_table_name', 'sql', 'dimensions', 'measures', 'primary_key', 'default_filters', 'filters', 'hidden', 'group_label', 'view_label', 'tags', 'required_access_grants', 'access_filters', 'drill_fields', 'ai_context', 'ai_description']);
const MODEL_DEFAULTS = new Set(['default_topic_required_access_grants', 'default_topic_access_filters', 'query_timezone', 'timezone', 'week_start_day', 'fiscal_month_offset', 'locale', 'default_currency']);
const MODEL_METADATA = new Set(['name', 'label', 'description', 'connection', 'connection_id', 'connection_name', 'default_topic', 'ai_context', 'ai_description']);

class EvidenceError extends Error {
  constructor(readonly code: string, readonly reference: string, message: string) { super(message); }
}

function yaml(text: string, reference: string) {
  if (typeof text !== 'string' || text.length > 2_000_000) throw new EvidenceError('SOURCE_YAML_LIMIT', reference, 'The required YAML exceeds the bounded package scope.');
  const document = parseDocument(text, { uniqueKeys: true, strict: true, prettyErrors: false, keepSourceTokens: true, intAsBigInt: true });
  if (document.errors.length || document.warnings.length) throw new EvidenceError('SOURCE_YAML_UNAVAILABLE', reference, 'The required YAML has invalid syntax or unsupported tags; no definition was inferred.');
  let nodes = 0;
  visit(document, (_key, node, path) => {
    if (++nodes > 25_000 || path.length > 64) throw new EvidenceError('SOURCE_YAML_LIMIT', reference, 'The required YAML exceeds the bounded nesting or node limit.');
    if (isAlias(node) || (isNode(node) && 'anchor' in node && node.anchor)) throw new EvidenceError('SOURCE_YAML_UNSUPPORTED', reference, 'Anchors and aliases need explicit effective source evidence.');
    if (isNode(node) && node.tag && !/^tag:yaml\.org,2002:(?:map|seq|str|int|float|bool|null)$/.test(node.tag)) throw new EvidenceError('SOURCE_YAML_UNSUPPORTED', reference, 'Custom YAML tags need explicit effective source evidence.');
    if (isMap(node)) for (const pair of node.items) {
      if (!isScalar(pair.key) || typeof pair.key.value !== 'string' || ['__proto__', 'constructor', 'prototype', '<<'].includes(pair.key.value)) throw new EvidenceError('SOURCE_YAML_UNSUPPORTED', reference, 'Safe, unique string keys are required.');
    }
  });
  const value: unknown = document.toJS({ maxAliasCount: 0 });
  if (value !== null && !object(value) && !Array.isArray(value)) throw new EvidenceError('SOURCE_YAML_UNSUPPORTED', reference, 'An authored mapping or relationship sequence is required.');
  return { document, value };
}

/** Exact semantic identities only. Folder prefixes are preserved, never removed from output paths. */
function resolve(files: Record<string, string>, reference: string, fileKind: Kind): string | undefined {
  const identity = stem(reference);
  const candidates = Object.keys(files).filter(file => kind(file) === fileKind && (
    fileKind === 'model' || fileKind === 'relationships' ? true
      : file === reference || stem(file) === identity || (!identity.includes('/') && basename(file) === identity)
  ));
  if (candidates.length > 1) throw new EvidenceError('AMBIGUOUS_SOURCE_IDENTITY', reference, 'Multiple authored files match this exact identity; choose an explicit unambiguous source scope.');
  return candidates[0];
}

function fields(value: Obj, reference: string): Map<string, { section: string; value: unknown }> {
  const result = new Map<string, { section: string; value: unknown }>();
  for (const section of ['dimensions', 'measures']) {
    const rows = value[section] ?? {};
    if (!object(rows)) throw new EvidenceError('SOURCE_FIELD_SHAPE_UNSUPPORTED', reference, 'Dimensions and measures must be authored mappings.');
    for (const [name, definition] of Object.entries(rows)) {
      if (!/^[A-Za-z_]\w*$/.test(name) || result.has(name) || (definition !== null && !object(definition))) throw new EvidenceError('SOURCE_FIELD_SHAPE_UNSUPPORTED', reference, 'Fields need unique exact identities and mapping or null definitions.');
      result.set(name, { section, value: definition });
    }
  }
  return result;
}

/** Adjust only requirements metadata; the strict merger still preserves destination bytes. */
function bindingComparison(sourceFileName: string, targetFileName: string, sourceYaml: string, targetYaml: string) {
  const source = yaml(sourceYaml, sourceFileName), destination = yaml(targetYaml, targetFileName);
  if (!object(source.value) || !object(destination.value) || !isMap(source.document.contents)
    || [source.value, destination.value].some(value => ['sql', 'query', 'sql_table_name'].some(key => Object.hasOwn(value, key)))
    || typeof source.value.table_name !== 'string' || !/^[A-Za-z_][A-Za-z0-9_$-]{0,255}$/.test(source.value.table_name)
    || source.value.table_name !== destination.value.table_name) return undefined;
  const keys = ['catalog', 'database', 'schema'] as const;
  const namespace = (value: Obj) => Object.fromEntries(keys.filter(key => Object.hasOwn(value, key)).map(key => [key, value[key]]));
  const mapping = { sourceFileName, targetFileName, source: namespace(source.value), destination: namespace(destination.value) };
  if (!isDashboardPackageBindingMapping(mapping) || isDeepStrictEqual(mapping.source, mapping.destination)) return undefined;
  const expected = { ...source.value };
  for (const key of keys) {
    if (Object.hasOwn(mapping.destination, key)) {
      source.document.set(key, mapping.destination[key]);
      expected[key] = mapping.destination[key];
    } else {
      source.document.contents.delete(key);
      delete expected[key];
    }
  }
  const proposed = source.document.toString({ lineWidth: 0 });
  if (!isDeepStrictEqual(yaml(proposed, sourceFileName).value, expected)) {
    throw new EvidenceError('PHYSICAL_BINDING_UNVERIFIED', sourceFileName, 'The namespace-only comparison could not be verified; no approval was applied.');
  }
  // A namespace choice cannot conceal a different formula, filter, security
  // requirement, table, or any other destination property.
  const merged = previewDashboardRepairYaml(targetYaml, proposed);
  return { mapping, merged };
}

/** Pure planning only: explicit binding choices affect comparisons, never authorize writes. */
export function planDashboardPackageDependencies(input: {
  sourceFiles: Record<string, string>; targetFiles: Record<string, string>;
  topicNames: string[]; fieldRefs?: string[]; localFiles?: Record<string, string>;
  bindingMappings?: DashboardPackageBindingMapping[];
}): DashboardPackageDependencyPlan {
  const result: DashboardPackageDependencyPlan = { files: [], issues: [] };
  const issues = new Set<string>();
  const add = (code: string, reference: string, message: string) => {
    const key = JSON.stringify([code, reference, message]);
    if (!issues.has(key)) { issues.add(key); result.issues.push({ code, reference, message }); }
  };
  const report = (error: unknown, reference: string) => error instanceof EvidenceError
    ? add(error.code, error.reference, error.message)
    : add('DEPENDENCY_UNSUPPORTED', reference, 'The authored dependency cannot be interpreted safely; review its complete source definition.');
  const sourceFiles = input.sourceFiles, targetFiles = input.targetFiles, localFiles = input.localFiles || {};
  if (input.bindingMappings !== undefined && (!Array.isArray(input.bindingMappings) || input.bindingMappings.length > 500
    || input.bindingMappings.some(mapping => !isDashboardPackageBindingMapping(mapping))
    || new Set(input.bindingMappings.map(mapping => mapping.sourceFileName)).size !== input.bindingMappings.length)) {
    add('PHYSICAL_BINDING_MAPPING_INVALID', 'package', 'Physical binding approvals must be bounded exact per-view choices with no duplicate source files or unknown properties.');
    return result;
  }
  const approvedBindings = new Map((input.bindingMappings || []).map(mapping => [mapping.sourceFileName, mapping]));
  if (!Array.isArray(input.topicNames) || input.topicNames.length > 100
    || input.fieldRefs !== undefined && (!Array.isArray(input.fieldRefs) || input.fieldRefs.length > 5_000 || input.fieldRefs.some(ref => typeof ref !== 'string' || ref.length > 1024))
    || [sourceFiles, targetFiles, localFiles].some(files => !object(files) || Object.keys(files).length > 5_000
      || Object.entries(files).some(([name, text]) => !safePath(name) || typeof text !== 'string'))) {
    add('PACKAGE_SCOPE_INVALID', 'package', 'Supply bounded authored file catalogs, at most 100 topics and 5,000 exact field references.'); return result;
  }
  if (!input.topicNames.length && !input.fieldRefs?.length) return result;
  const cache = new Map<string, ReturnType<typeof yaml>>();
  const read = (file: string, scope: 'source' | 'local' | 'target') => {
    const key = scope + ':' + file;
    if (!cache.has(key)) {
      try { cache.set(key, yaml((scope === 'source' ? sourceFiles : scope === 'local' ? localFiles : targetFiles)[file], file)); }
      catch (error) {
        if (scope === 'target' && error instanceof EvidenceError) throw new EvidenceError(error.code.replace(/^SOURCE_/, 'DESTINATION_'), file, error.message);
        throw error;
      }
    }
    return cache.get(key)!;
  };
  const candidates = new Map<string, string>();
  const selectedFields = new Map<string, Set<string>>();
  const aliases = new Map<string, Set<string>>();
  const topicLocal = new Map<string, unknown[]>();
  const topicViews = new Set<string>();
  const topics: string[] = [];
  for (const name of [...new Set(input.topicNames)].sort()) {
    try {
      if (typeof name !== 'string' || !safePath(name)) throw new EvidenceError('SOURCE_TOPIC_UNAVAILABLE', String(name), 'An exact authored topic identity is required.');
      const file = resolve(sourceFiles, name, 'topic');
      if (!file) throw new EvidenceError('SOURCE_TOPIC_UNAVAILABLE', name, 'The authored source topic was not found; a dashboard or label cannot stand in for its definition.');
      topics.push(file);
    } catch (error) { report(error, String(name)); }
  }
  if (topics.length) {
    // Use the proven topic closure algorithm against its own authored model policy baseline.
    // This is source extraction only; all real destination/model comparisons happen below.
    // Empty identifiers are intentionally not execution bindings or synthetic source definitions.
    const modelBaseline = Object.fromEntries(Object.entries(sourceFiles).filter(([file]) => kind(file) === 'model'));
    const analysis = buildTopicMigrationAnalysis({ request: {
      sourceInstanceId: '', sourceConnectionId: '', sourceModelId: '', targetInstanceId: '', targetConnectionId: '', targetModelId: '',
      topicIds: topics, schemaMapText: '',
    }, sourceFiles, targetFiles: modelBaseline, sourceDialect: '', targetDialect: '' });
    for (const issue of analysis.issues.filter(issue => issue.severity === 'blocker')) add(
      issue.kind === 'security' ? 'SECURITY_DEPENDENCY_UNVERIFIED' : 'SOURCE_DEPENDENCY_UNVERIFIED',
      issue.fileName || issue.topicIds[0] || 'package', `${issue.title}. ${issue.message} ${issue.nextAction}`);
    for (const file of analysis.files) if (file.proposed) candidates.set(file.sourceFileName, file.proposed);
    for (const file of topics) {
      try {
        const value = read(file, 'source').value;
        if (object(value) && object(value.views)) for (const [view, definition] of Object.entries(value.views)) {
          if (object(definition)) for (const [name, field] of fields(definition, file)) {
            const reference = view + '.' + name;
            topicLocal.set(reference, [...(topicLocal.get(reference) || []), field.value]);
          }
        }
      } catch (error) { report(error, file); }
    }
    for (const [file, text] of candidates) {
      try {
        const value = yaml(text, file).value;
        if (kind(file) === 'view' && object(value)) {
          topicViews.add(file);
          selectedFields.set(file, new Set([...fields(value, file)].map(([name, definition]) => definition.section + '.' + name)));
        }
        const edges = kind(file) === 'relationships' ? Array.isArray(value) ? value : object(value) ? value.relationships : undefined : object(value) ? value.relationships : undefined;
        if (Array.isArray(edges)) for (const edge of edges) if (object(edge)) for (const side of ['from', 'to']) {
          const underlying = edge['join_' + side + '_view'], alias = edge['join_' + side + '_view_as'] ?? edge['join_' + side + '_view_alias'];
          if (typeof underlying === 'string' && typeof alias === 'string') aliases.set(alias, new Set([...(aliases.get(alias) || []), underlying]));
        }
      } catch (error) { report(error, file); }
    }
  }

  const queued = [...new Set(input.fieldRefs || [])], seen = new Set<string>(), active = new Set<string>();
  const directViews = new Set<string>(), settingsScanned = new Set<string>();
  const localRequirements: unknown[] = [];
  const mapping = (file: string, scope: 'source' | 'local') => {
    const value = read(file, scope).value;
    if (!object(value)) throw new EvidenceError('SOURCE_VIEW_UNAVAILABLE', file, 'The required view has no authored mapping; inherited/generated fields are not shared definitions.');
    return value;
  };
  const enqueue = (reference: string, containing: string) => {
    const ref = reference.includes('.') ? reference : containing + '.' + reference;
    if (!/^[A-Za-z_][\w/]*\.[A-Za-z_]\w*$/.test(ref)) throw new EvidenceError('SOURCE_REFERENCE_UNSUPPORTED', ref, 'An exact view.field reference is required; selectors or inherited references need explicit evidence.');
    return ref;
  };
  const scan = (value: unknown, containing: string, visitField: (reference: string) => void, key = '', depth = 0): void => {
    if (depth > 40) throw new EvidenceError('DEPENDENCY_LIMIT', containing, 'The authored dependency traversal exceeds its nesting limit.');
    if (Array.isArray(value)) { value.forEach(child => scan(child, containing, visitField, key, depth + 1)); return; }
    if (object(value)) {
      for (const [childKey, child] of Object.entries(value)) {
        if (DISPLAY.has(childKey)) continue;
        if (FIELD_REFS.has(key) && /^[A-Za-z_][\w/]*(?:\.[A-Za-z_]\w*)?$/.test(childKey)) visitField(enqueue(childKey, containing));
        scan(child, containing, visitField, childKey, depth + 1);
      }
      return;
    }
    if (typeof value !== 'string') return;
    if (value.includes('{{')) throw new EvidenceError('DYNAMIC_DEPENDENCY_UNVERIFIED', containing, 'Dynamic templates require an explicit effective dependency scope; they are not interpreted or rewritten.');
    for (const match of value.matchAll(/\$\{([^}]+)\}/g)) {
      if (match[1] === 'TABLE') continue;
      if (!match[1].includes('.') && /\b(?:from|join)\s*$/i.test(value.slice(0, match.index))) {
        throw new EvidenceError('RELATION_CONTEXT_REQUIRED', match[1], 'A query relation macro needs an authored topic/relation context; no query view or dependency fields were generated.');
      }
      visitField(enqueue(match[1], containing));
    }
    if (FIELD_REFS.has(key) && !value.includes('${')) {
      const ref = ['sorts', 'order_by', 'default_order_by'].includes(key) ? value.replace(/\s+(?:asc|desc)$/i, '') : value;
      visitField(enqueue(ref, containing));
    }
  };
  const visitField = (reference: string, depth = 0): void => {
    if (active.has(reference)) throw new EvidenceError('FIELD_DEPENDENCY_CYCLE', reference, 'A recursive field dependency needs explicit source review.');
    if (seen.has(reference)) return;
    if (seen.size >= 5_000 || depth > 100) throw new EvidenceError('DEPENDENCY_LIMIT', reference, 'The authored field closure exceeds its bounded scope.');
    active.add(reference);
    try {
      const ref = enqueue(reference, '');
      const dot = ref.lastIndexOf('.'), view = ref.slice(0, dot), name = ref.slice(dot + 1);
      const possible = aliases.get(view);
      if (possible && possible.size !== 1) throw new EvidenceError('ALIAS_CONTEXT_AMBIGUOUS', ref, 'The selected topics resolve this alias to different views; separate the package scopes.');
      const underlying = possible ? [...possible][0] : view;
      const sourceFile = resolve(sourceFiles, underlying, 'view'), localFile = resolve(localFiles, underlying, 'view');
      const original = sourceFile ? mapping(sourceFile, 'source') : undefined, local = localFile ? mapping(localFile, 'local') : undefined;
      const sharedField = original ? fields(original, sourceFile!).get(name) : undefined;
      const workbookField = local ? fields(local, localFile!).get(name) : undefined;
      const topicFields = topicLocal.get(ref);
      if (topicFields?.some(value => !isDeepStrictEqual(value, topicFields[0]))) throw new EvidenceError('LOCAL_FIELD_CONTEXT_AMBIGUOUS', ref, 'The selected topics author different local definitions for this field; preserve their separate contexts.');
      if (!sharedField && !workbookField && !topicFields?.length) throw new EvidenceError(localFile ? 'LOCAL_FIELD_UNVERIFIED' : 'SOURCE_FIELD_UNAVAILABLE', ref,
        localFile ? 'This workbook/query-local field has no explicit authored definition; it must not be synthesized as a missing shared field.' : 'No exact authored shared field was found; inherited or generated semantics need explicit source evidence.');
      const child = (dependency: string) => visitField(dependency, depth + 1);
      // Never merge workbook definitions into the shared catalog, including partial overrides.
      if (workbookField) { localRequirements.push(workbookField.value); scan(workbookField.value, underlying, child); }
      else if (topicFields?.length) scan(topicFields[0], view, child);
      if (sharedField && sourceFile && original) {
        directViews.add(sourceFile);
        const selected = selectedFields.get(sourceFile) || new Set<string>(); selected.add(sharedField.section + '.' + name); selectedFields.set(sourceFile, selected);
        scan(sharedField.value, underlying, child);
        if (!settingsScanned.has(sourceFile)) {
          settingsScanned.add(sourceFile);
          for (const key of Object.keys(original)) if (!VIEW_KEYS.has(key)) throw new EvidenceError('SOURCE_VIEW_BEHAVIOR_UNSUPPORTED', sourceFile, 'An unclassified view property may carry dependencies or security; provide explicit effective evidence.');
          scan(Object.fromEntries(Object.entries(original).filter(([key]) => !['dimensions', 'measures'].includes(key))), underlying,
            dependency => { if (!active.has(dependency)) child(dependency); });
        }
      }
      if (local && localFile && !settingsScanned.has('local:' + localFile)) {
        settingsScanned.add('local:' + localFile);
        for (const key of Object.keys(local)) if (!VIEW_KEYS.has(key) && !['folder', 'display_order', 'schema_label'].includes(key)) {
          throw new EvidenceError('LOCAL_VIEW_BEHAVIOR_UNSUPPORTED', localFile, 'An unclassified workbook property may carry dependencies or security; provide explicit effective local evidence.');
        }
        const settings = Object.fromEntries(Object.entries(local).filter(([key]) => !['dimensions', 'measures'].includes(key)));
        localRequirements.push(settings);
        scan(settings, underlying, dependency => { if (!active.has(dependency)) child(dependency); });
      }
      seen.add(reference);
    } finally { active.delete(reference); }
  };
  for (const reference of queued) {
    try { visitField(reference); } catch (error) { report(error, reference); }
  }
  try {
    const file = resolve(sourceFiles, 'model', 'model');
    const model = file ? read(file, 'source').value : undefined;
    if (object(model)) for (const [key, value] of Object.entries(model)) if (MODEL_DEFAULTS.has(key)) scan(value, '', visitField, key);
  } catch (error) { report(error, 'model'); }
  if (!topics.length && directViews.size > 1) add('TOPIC_CONTEXT_REQUIRED', 'package', 'Multiple shared views require an exact authored topic/join context; the package will not guess a join path.');
  if (topics.length) for (const file of directViews) if (!topicViews.has(file)) add('TOPIC_CONTEXT_REQUIRED', file,
    'An additional field depends on a view outside the selected topics’ proven join context; select its exact authored topic instead of guessing a join.');
  for (const [file, selected] of selectedFields) {
    try {
      const { document } = yaml(sourceFiles[file], file);
      if (!isMap(document.contents)) throw new EvidenceError('SOURCE_VIEW_UNAVAILABLE', file, 'An authored view mapping is required.');
      let changed = false;
      for (const section of ['dimensions', 'measures']) {
        const container = document.contents.get(section, true);
        if (isMap(container)) for (const pair of [...container.items]) {
          const name = String((pair.key as { value: string }).value);
          if (!selected.has(section + '.' + name)) { container.delete(name); changed = true; }
        }
      }
      candidates.set(file, changed ? document.toString({ lineWidth: 0 }) : sourceFiles[file]);
    } catch (error) { report(error, file); }
  }

  // Model defaults affect every selected definition. Policy additions are deliberately not
  // authorized by the field/relationship additive writer: exact existing requirements reuse.
  try {
    const sourceModelFile = resolve(sourceFiles, 'model', 'model'), targetModelFile = resolve(targetFiles, 'model', 'model');
    const model = sourceModelFile ? read(sourceModelFile, 'source').value : {}, target = targetModelFile ? read(targetModelFile, 'target').value : {};
    if (!object(model) || !object(target)) throw new EvidenceError('MODEL_POLICY_UNAVAILABLE', sourceModelFile || targetModelFile || 'model', 'Effective model policies require authored mapping evidence.');
    const grants = new Set<string>();
    const inspect = (value: unknown, key = ''): void => {
      if (['required_access_grants', 'mask_unless_access_grants', 'default_topic_required_access_grants'].includes(key)) {
        if (!Array.isArray(value) || value.some(grant => typeof grant !== 'string')) throw new EvidenceError('SECURITY_REFERENCE_UNSUPPORTED', sourceModelFile || 'model', 'Security dependencies require an explicit list of authored grant identities.');
        value.forEach(grant => grants.add(grant as string));
      } else if (Array.isArray(value)) value.forEach(child => inspect(child, key));
      else if (object(value)) Object.entries(value).forEach(([childKey, child]) => inspect(child, childKey));
    };
    for (const [file, text] of candidates) inspect(yaml(text, file).value);
    localRequirements.forEach(value => inspect(value));
    for (const [key, value] of Object.entries(model)) {
      if (key !== 'access_grants' && !MODEL_DEFAULTS.has(key) && !MODEL_METADATA.has(key)) throw new EvidenceError('MODEL_BEHAVIOR_UNSUPPORTED', sourceModelFile || 'model', 'An unclassified model setting requires explicit dependency/security review.');
      if (MODEL_DEFAULTS.has(key)) inspect(value, key);
    }
    const required: Obj = {};
    let conflict = false;
    for (const key of new Set([...Object.keys(model), ...Object.keys(target)].filter(key => MODEL_DEFAULTS.has(key) || /access|permission|row_level|user_attribute/i.test(key) && key !== 'access_grants'))) {
      if (Object.hasOwn(model, key)) required[key] = model[key];
      if (!isDeepStrictEqual(model[key], target[key])) { conflict = true; add('MODEL_REQUIREMENT_CONFLICT', key, 'A model-wide behavior or security default differs; this package cannot change settings for unrelated destination content.'); }
    }
    for (const grant of grants) {
      const definition = object(model.access_grants) ? model.access_grants[grant] : undefined;
      if (!object(definition)) { conflict = true; add('SECURITY_DEFINITION_UNAVAILABLE', grant, 'The exact required source access grant is absent or unsupported; no policy was invented.'); continue; }
      required.access_grants ||= {} as Obj;
      (required.access_grants as Obj)[grant] = definition;
      if (!object(target.access_grants) || !isDeepStrictEqual(target.access_grants[grant], definition)) {
        conflict = true; add('SECURITY_REQUIREMENT_CONFLICT', grant, 'The required destination grant is missing or differs; establish it in a separate reviewed security change.');
      }
    }
    if (sourceModelFile && (Object.keys(required).length || conflict)) {
      const { document } = yaml(sourceFiles[sourceModelFile], sourceModelFile);
      if (isMap(document.contents)) {
        for (const key of [...document.contents.items].map(pair => String((pair.key as { value: string }).value))) if (!Object.hasOwn(required, key)) document.contents.delete(key);
        const grantMap = document.contents.get('access_grants', true);
        if (isMap(grantMap)) for (const pair of [...grantMap.items]) if (!grants.has(String((pair.key as { value: string }).value))) grantMap.delete((pair.key as { value: string }).value);
      }
      result.files.push({ sourceFileName: sourceModelFile, fileName: targetModelFile || sourceModelFile, before: targetModelFile ? targetFiles[targetModelFile] : '',
        after: targetModelFile ? targetFiles[targetModelFile] : document.toString({ lineWidth: 0 }), action: conflict ? 'conflict' : 'reuse',
        ...(conflict ? { reason: 'Required model behavior or security needs separate reviewed reconciliation.', sourceComparison: document.toString({ lineWidth: 0 }) } : {}) });
    }
  } catch (error) { report(error, 'model'); }

  const destinations = new Set<string>();
  for (const [sourceFileName, proposed] of [...candidates].sort(([a], [b]) => a.localeCompare(b))) {
    let fileName = sourceFileName, before = '';
    try {
      const fileKind = kind(sourceFileName)!;
      const exact = Object.hasOwn(targetFiles, sourceFileName) ? sourceFileName : undefined;
      const matches = Object.keys(targetFiles).filter(file => kind(file) === fileKind && (['model', 'relationships'].includes(fileKind) || basename(file) === basename(sourceFileName)));
      if (matches.length > 1) throw new EvidenceError('DESTINATION_IDENTITY_AMBIGUOUS', sourceFileName, 'Multiple destination files share this semantic identity; no file was chosen.');
      fileName = exact || matches[0] || sourceFileName;
      before = targetFiles[fileName] ?? '';
      if (Object.keys(targetFiles).some(file => file !== fileName && (file.toLowerCase() === fileName.toLowerCase()
        || kind(file) === fileKind && basename(file).toLowerCase() === basename(sourceFileName).toLowerCase()))) throw new EvidenceError('DESTINATION_IDENTITY_COLLISION', fileName, 'A case-only or duplicate semantic destination identity requires explicit resolution.');
      if (destinations.has(fileName.toLowerCase())) throw new EvidenceError('DESTINATION_IDENTITY_COLLISION', fileName, 'Multiple source dependencies would write the same destination file.');
      destinations.add(fileName.toLowerCase());
      yaml(proposed, sourceFileName);
      if (Object.hasOwn(targetFiles, fileName)) read(fileName, 'target');
      const approval = approvedBindings.get(sourceFileName);
      let binding: ReturnType<typeof bindingComparison> = undefined;
      if (fileKind === 'view' && Object.hasOwn(targetFiles, fileName)) {
        binding = bindingComparison(sourceFileName, fileName, proposed, before);
        if (binding) (result.bindingMappings ||= []).push(binding.mapping);
      }
      if (approval && (!binding || dashboardPackageBindingKey(approval) !== dashboardPackageBindingKey(binding.mapping))) {
        throw new EvidenceError('PHYSICAL_BINDING_MAPPING_STALE', sourceFileName, 'This view’s physical binding approval no longer matches its exact current source and destination definitions. Review a fresh comparison.');
      }
      const merged = approval && binding ? binding.merged
        : previewDashboardRepairYaml(Object.hasOwn(targetFiles, fileName) ? before : undefined, proposed);
      result.files.push({ fileName, sourceFileName, before, after: merged.yaml,
        action: Object.hasOwn(targetFiles, fileName) ? merged.yaml === before ? 'reuse' : 'add' : 'create' });
    } catch (error) {
      const message = error instanceof EvidenceError || error instanceof DashboardRepairYamlConflictError ? error.message : 'An existing destination definition has incompatible meaning or cannot be safely extended; no overwrite is proposed.';
      add(error instanceof EvidenceError ? error.code : 'DESTINATION_DEFINITION_CONFLICT', fileName, message);
      result.files.push({ fileName, sourceFileName, before, after: before, sourceComparison: proposed, action: 'conflict', reason: message });
    }
  }
  // A package is atomic: incomplete closure/security evidence cannot authorize a partial write.
  if (result.issues.length) for (const file of result.files) if (file.action === 'create' || file.action === 'add') {
    file.action = 'conflict'; file.reason ||= 'Resolve the package dependency/security issues before preparing shared changes.';
  }
  result.files.sort((a, b) => a.fileName.localeCompare(b.fileName));
  result.issues.sort((a, b) => a.reference.localeCompare(b.reference) || a.code.localeCompare(b.code));
  result.bindingMappings?.sort((a, b) => dashboardPackageBindingKey(a).localeCompare(dashboardPackageBindingKey(b)));
  return result;
}
