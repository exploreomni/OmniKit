import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';
import { isAlias, isMap, isNode, isScalar, isSeq, parseDocument, stringify } from 'yaml';
import type { DashboardTopicRepairDraft, DashboardTopicRepairDraftInput, DashboardTopicRepairDraftFile } from '../../shared/dashboardTopicRepair';
import { dashboardSourceFieldReferences } from './dashboardSourceEvidence';
import { mergeDashboardRepairYaml } from './dashboardRepairYaml';
import { dashboardTopicViewMatches } from './dashboardTopicRelationInventory';

const MAX_FILES = 5_000;
const MAX_VISITS = 50_000;
const MAX_YAML = 250_000;
const MAX_JOIN_PATHS = 12;
const MAX_JOIN_CHOICES = 100;
const SECURITY = /access|grant|permission|user_attribute|always_where|default_filter|required_filter|filter_only|policy|security/i;
const PRESENTATION = new Set(['label', 'description', 'folder', 'group_label', 'schema_label', 'display_order', 'hidden', 'ai_context', 'synonyms', 'tags']);
const RELATIONSHIP_KEYS = new Set(['join_from_view', 'join_to_view', 'join_type', 'on_sql', 'relationship_type', 'join_to_view_as', 'reversible', 'where_sql', 'documentation', 'description', 'label']);
const CARDINALITIES = new Set(['many_to_one', 'one_to_many', 'one_to_one', 'many_to_many']);
const JOIN_TYPES = new Set(['always_left', 'inner', 'full_outer', 'cross', 'right_left', 'left_right']);

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function identity(value: string): string { return value.normalize('NFKC').trim().toLowerCase(); }
function validName(value: string): boolean { return /^[A-Za-z_][\w/-]*$/.test(value) && value.split('/').every((part) => Boolean(part) && !['.', '..', '__proto__', 'constructor', 'prototype'].includes(part)); }
function stem(file: string): string { return file.replace(/\.(query\.view|view|topic)$/, ''); }

function readYaml(text: string, file: string): unknown {
  if (text.length > MAX_YAML) throw new Error(`${file}: authored YAML exceeds the reconstruction review limit.`);
  const document = parseDocument(text || '{}', { uniqueKeys: true, strict: true, prettyErrors: false });
  if (document.errors.length || document.warnings.length) throw new Error(`${file}: authored YAML is invalid or ambiguous.`);
  const nodes: Array<{ node: unknown; depth: number }> = [{ node: document.contents, depth: 0 }];
  let visits = 0;
  for (const { node, depth } of nodes) {
    if (depth > 30 || ++visits > MAX_VISITS) throw new Error(`${file}: YAML nesting exceeds the reconstruction limit.`);
    if (isAlias(node) || (isNode(node) && 'anchor' in node && node.anchor)) throw new Error(`${file}: YAML anchors or aliases require explicit review.`);
    if (isMap(node)) for (const pair of node.items) {
      if (!isScalar(pair.key) || typeof pair.key.value !== 'string') throw new Error(`${file}: YAML mapping keys must be strings.`);
      nodes.push({ node: pair.value, depth: depth + 1 });
    }
    if (isSeq(node)) for (const item of node.items) nodes.push({ node: item, depth: depth + 1 });
  }
  return document.toJS({ maxAliasCount: 0 });
}

function topicNames(value: Record<string, unknown>): string[] {
  const names = ['topicName', 'topic_name', 'topicId', 'topic_id', 'topicIdentifier', 'topic_identifier', 'topicKey', 'topic_key']
    .map((key) => value[key]).filter((name): name is string => typeof name === 'string');
  if (typeof value.topic === 'string') names.push(value.topic);
  else if (record(value.topic)) for (const key of ['name', 'id', 'identifier']) if (typeof value.topic[key] === 'string') names.push(value.topic[key]);
  return names.map(identity);
}

function selectedQueries(states: Record<string, unknown>[], source: string, block: (message: string) => void): Record<string, unknown>[] {
  const queries: Record<string, unknown>[] = [];
  const seen = new Set<object>();
  let visits = 0;
  const walk = (value: unknown, inherited: string[] = [], depth = 0) => {
    if (depth > 30 || ++visits > MAX_VISITS) throw new Error('Dashboard query traversal exceeds the bounded reconstruction limit.');
    if (!value || typeof value !== 'object' || seen.has(value)) return;
    seen.add(value);
    if (Array.isArray(value)) { value.forEach((child) => walk(child, inherited, depth + 1)); return; }
    if (!record(value)) return;
    const own = topicNames(value);
    const context = own.length ? own : inherited;
    if (Object.hasOwn(value, 'query')) {
      const query = value.query;
      const queryNames = record(query) ? topicNames(query) : [];
      if ((queryNames.length ? queryNames : context).includes(source)) {
        if (!record(query) || value.isSql === true || typeof query.sql === 'string') block('A selected raw-SQL or unsupported query requires explicit semantic reconstruction.');
        else queries.push(query);
      }
    } else if (context.includes(source) && ['fields', 'measures', 'dimensions'].some((key) => Object.hasOwn(value, key))) queries.push(value);
    for (const [key, child] of Object.entries(value)) if (key !== 'query' && key !== 'workbookModel' && key !== 'workbook_model') walk(child, context, depth + 1);
  };
  states.forEach((state) => walk(state));
  return [...new Set(queries)];
}

interface View { name: string; fileName: string; yaml: string; value: Record<string, unknown> }
interface Edge { from: string; to: string; value: Record<string, unknown>; valid: boolean }

/** Pure draft generation. No reads, writes, approvals, inferred joins, or workbook promotion. */
export function buildDashboardTopicRepairDraft(input: DashboardTopicRepairDraftInput): DashboardTopicRepairDraft {
  const result: DashboardTopicRepairDraft = { sourceTopicName: input.sourceTopicName.trim(), targetTopicName: input.targetTopicName.trim(), baseViewCandidates: [], files: [], blockers: [], requiredViews: [] };
  const blockers = new Set<string>();
  const block = (message: string) => { blockers.add(message); };
  const submittedPaths = input.selectedJoinPaths;
  const validSelections = submittedPaths === undefined || (record(submittedPaths) && Object.keys(submittedPaths).length <= MAX_JOIN_CHOICES
    && Object.entries(submittedPaths).every(([name, id]) => validName(name) && typeof id === 'string' && /^sha256:[a-f0-9]{64}$/.test(id)));
  const selections: Record<string, string> = validSelections && submittedPaths ? { ...submittedPaths } : {};
  if (!validSelections) block('Join-path selections must be bounded exact view names and path IDs from the current preview.');
  result.selectedJoinPaths = selections;
  result.joinPathChoices = [];
  const reusedRelations = new Set<string>();
  const requiredNames = new Set<string>();
  const targetViewBindings = new Map<string, string>();
  let parseCount = 0;
  let parsedBytes = 0;
  const parsed = (text: string, file: string) => {
    parsedBytes += text.length;
    if (++parseCount > 1_000 || parsedBytes > 10_000_000) throw new Error('Authored YAML parsing exceeds the bounded reconstruction review limit.');
    return readYaml(text, file);
  };
  const finish = () => { result.blockers = [...blockers].sort(); result.files.sort((left, right) => left.fileName.localeCompare(right.fileName)); result.requiredViews.sort(); result.requiredInventoryNames = [...requiredNames].sort(); result.targetViewBindings = Object.fromEntries(targetViewBindings); if (reusedRelations.size) result.reusedRelations = [...reusedRelations].sort(); return result; };
  if (!validName(result.sourceTopicName) || !validName(result.targetTopicName)) {
    block('Source and destination topic names must be exact semantic identifiers, not labels or paths with traversal.');
    return finish();
  }
  if (Object.keys(input.sourceFiles).length > MAX_FILES || Object.keys(input.targetFiles).length > MAX_FILES || input.states.length > 100 || (input.sourceRelationNames?.length || 0) > MAX_FILES || (input.targetRelationNames?.length || 0) > MAX_FILES) {
    block('The authored file inventory exceeds the bounded reconstruction limit.'); return finish();
  }
  const fileMatches = (files: Record<string, string>, name: string, suffix: '.view' | '.topic') => Object.keys(files).filter((file) => file.endsWith(suffix)
    && (identity(stem(file)) === identity(name) || (!name.includes('/') && identity(stem(file).split('/').pop()!) === identity(name))));
  const viewMatches = (files: Record<string, string>, name: string, index?: Record<string, string[]>) => {
    const found = dashboardTopicViewMatches(files, index || {}, name);
    if (found.conflict) { block(`View ${name} has conflicting file-to-name inventory bindings. Filename inference cannot override the model index.`); return []; }
    return found.matches;
  };
  const sourceTopics = fileMatches(input.sourceFiles, result.sourceTopicName, '.topic');
  if (sourceTopics.length) {
    block(sourceTopics.length === 1 ? 'An authored source topic already exists. Use the ordinary topic-copy workflow.' : 'The source topic identity matches multiple authored files. Resolve that ambiguity before copying.');
    return finish();
  }

  const viewCache = new Map<string, View | undefined>();
  const resolveView = (name: string): View | undefined => {
    const key = identity(name);
    requiredNames.add(key);
    if (viewCache.has(key)) return viewCache.get(key);
    viewCache.set(key, undefined);
    if (input.sourceObservedRelationNames?.includes(key) && !input.sourceRelationNames?.includes(key)) {
      block(`Source view ${name} exists but its inventory mapping or definition is unverified. Resolve it before reuse.`); return undefined;
    }
    const matches = viewMatches(input.sourceFiles, name, input.sourceViewFileNames);
    if (matches.length !== 1) { block(matches.length ? `View ${name} has ambiguous authored files.` : `View ${name} has no exact authored shared-model definition; workbook-local content cannot be promoted.`); return undefined; }
    const fileName = matches[0];
    const indexed = input.sourceViewFileNames && Object.hasOwn(input.sourceViewFileNames, key);
    const authoredName = indexed ? name : stem(fileName);
    if (!validName(authoredName)) { block(`View file ${fileName} has an unsupported semantic identity.`); return undefined; }
    try {
      const value = parsed(input.sourceFiles[fileName], fileName);
      if (!record(value)) throw new Error(`${fileName}: a view must be an authored YAML mapping.`);
      if (value.name !== undefined && (typeof value.name !== 'string' || ![identity(authoredName), identity(authoredName.split('/').pop()!)].includes(identity(value.name)))) throw new Error(`${fileName}: authored name conflicts with its file identity.`);
      for (const section of ['dimensions', 'measures']) if (value[section] !== undefined && (!record(value[section]) || Object.values(value[section]).some((definition) => definition !== null && !record(definition)))) throw new Error(`${fileName}: authored field definitions have an unsupported shape.`);
      const view = { name: indexed || name.includes('/') ? authoredName : authoredName.split('/').pop()!, fileName, yaml: input.sourceFiles[fileName], value };
      viewCache.set(key, view);
      return view;
    } catch (error) { block((error as Error).message); return undefined; }
  };
  const files = new Map<string, DashboardTopicRepairDraftFile>();
  const workbookSnapshots: Record<string, string>[] = [];
  const checkedWorkbookViews = new Set<string>();
  const checkWorkbookView = (view: Pick<View, 'name' | 'fileName'>) => {
    if (checkedWorkbookViews.has(view.fileName)) return;
    checkedWorkbookViews.add(view.fileName);
    for (const workbookFiles of workbookSnapshots) for (const file of [...new Set([
      ...fileMatches(workbookFiles, view.name, '.view'), ...(Object.hasOwn(workbookFiles, view.fileName) ? [view.fileName] : []),
      ...(input.sourceViewFileNames?.[identity(view.name)] || []).filter((path) => Object.hasOwn(workbookFiles, path)),
    ])]) {
      try {
        const value = parsed(workbookFiles[file], `workbook ${file}`);
        if (!record(value) || Object.entries(value).some(([key, setting]) => !PRESENTATION.has(key)
          && (!['dimensions', 'measures'].includes(key) || !record(setting) || Object.keys(setting).length > 0))) {
          block(`Workbook-local definitions or settings overlap required view ${view.name}; reconstruction cannot promote them into the shared model.`);
        }
      } catch { block(`Workbook-local evidence for ${view.name} cannot be verified.`); }
    }
  };
  const includeView = (view: View) => {
    if (files.has(view.fileName)) return;
    checkWorkbookView(view);
    const targets = viewMatches(input.targetFiles, view.name, input.targetViewFileNames);
    if (targets.length > 1) { block(`Destination view ${view.name} has ambiguous authored files.`); return; }
    const targetFile = targets[0] || view.fileName;
    targetViewBindings.set(identity(view.name), targetFile);
    const original = targets.length ? input.targetFiles[targetFile] : null;
    const queryView = view.fileName.endsWith('.query.view');
    const viewKind = queryView ? 'query view' : 'view';
    if (input.targetObservedRelationNames?.includes(identity(view.name)) && !input.targetRelationNames?.includes(identity(view.name))) {
      files.set(view.fileName, { fileName: targetFile, original, proposed: original ?? view.yaml, kind: 'view', status: 'conflict',
        message: 'The existing destination view has an unverified or ambiguous inventory entry. No replacement or duplicate is authorized.' });
      block(`Destination view ${view.name} has unverified inventory evidence. Resolve it before adding or reusing definitions.`);
      return;
    }
    if (targets.length && queryView !== targetFile.endsWith('.query.view')) {
      files.set(view.fileName, { fileName: targetFile, original, proposed: original!, kind: 'view', status: 'conflict',
        message: `The source and destination use different view types for ${view.name}. No conversion, replacement, or duplicate view is proposed. Reconcile the definitions explicitly in Model Migrator.` });
      block(`View ${view.name} has a regular/query view type mismatch. Existing view types cannot be converted by this repair.`);
      return;
    }
    // An inventory entry without readable authored YAML is not an absent view.
    // Never shadow an inherited definition just because its file was not returned.
    if (!targets.length && (input.targetObservedRelationNames || input.targetRelationNames)?.some((name) => identity(name) === identity(view.name))) {
      files.set(view.fileName, { fileName: targetFile, original: null, proposed: view.yaml, kind: 'view', status: 'conflict',
        message: `View ${view.name} already appears in the destination inventory, but its authored definition is unavailable. Read that definition before proposing additions; no new or duplicate view is authorized.` });
      block(`Destination view ${view.name} exists without a readable authored definition. It cannot be treated as missing.`);
      return;
    }
    try {
      const originalValue = original === null ? undefined : parsed(original, targetFile);
      const proposed = mergeDashboardRepairYaml(original ?? undefined, view.yaml);
      const unchanged = original !== null && isDeepStrictEqual(originalValue, parsed(proposed, targetFile));
      files.set(view.fileName, { fileName: targetFile, original, proposed: unchanged ? original! : proposed, kind: 'view', status: original === null ? 'new' : unchanged ? 'unchanged' : 'additive',
        message: original === null ? `Create the missing ${viewKind} using its authored source definition; its source type is preserved.`
          : unchanged ? `Reuse the existing ${viewKind} unchanged. No view write is required.`
          : `Add only missing dimensions and measures to the existing ${viewKind}. Existing definitions, view type, and unrelated destination fields are preserved.` });
    } catch {
      files.set(view.fileName, { fileName: targetFile, original, proposed: view.yaml, kind: 'view', status: 'conflict', message: 'Authored destination definitions conflict with the source. Resolve the diff; existing target content will not be overwritten.' });
      block(`Destination view ${view.name} conflicts with authored source semantics.`);
    }
  };

  // A missing model document is a coverage gap, not evidence of absent security.
  try {
    if (!Object.hasOwn(input.sourceFiles, 'model') || !Object.hasOwn(input.targetFiles, 'model')) throw new Error('Explicit authored source and destination model security snapshots are required.');
    const sourceModel = parsed(input.sourceFiles.model, 'source model');
    const targetModel = parsed(input.targetFiles.model, 'destination model');
    if (!record(sourceModel) || !record(targetModel)) throw new Error('Model security snapshots must be authored YAML mappings.');
    const semanticModel = (value: Record<string, unknown>) => Object.fromEntries(Object.entries(value).filter(([key]) => !PRESENTATION.has(key)));
    if (!isDeepStrictEqual(semanticModel(sourceModel), semanticModel(targetModel))) block('Source and destination model settings/security differ. Explicit reconciliation is required; reconstruction does not write model settings.');
  } catch (error) { block((error as Error).message); }

  const queryViews = new Set<string>();
  const pending = new Set<string>();
  const controlReferences = new Set<string>();
  try {
    const queries = input.states.flatMap((state) => {
      const selected = selectedQueries([state], identity(result.sourceTopicName), block);
      if (selected.length && Object.hasOwn(state, '__topicRepairWorkbookFiles')) {
        const workbook = state.__topicRepairWorkbookFiles;
        if (!record(workbook) || Object.keys(workbook).length > MAX_FILES || Object.values(workbook).some((value) => typeof value !== 'string')) block('The selected workbook extension evidence is incomplete or invalid.');
        else {
          const snapshot = workbook as Record<string, string>;
          workbookSnapshots.push(snapshot);
          if (fileMatches(snapshot, result.sourceTopicName, '.topic').length) block('The source topic exists in a workbook extension. Preserve its local scope; it cannot be reconstructed as a shared-model topic.');
          for (const file of ['model']) if (Object.hasOwn(snapshot, file)) {
            try {
              const value = parsed(snapshot[file], `workbook ${file}`);
              if (!record(value) || Object.keys(value).some((key) => !PRESENTATION.has(key))) block(`Workbook-local ${file} settings require explicit preservation before topic reconstruction.`);
            } catch { block(`Workbook-local ${file} evidence cannot be verified.`); }
          }
        }
      }
      if (selected.length) for (const key of ['controls', 'filters', 'filterConfig', 'filter_config']) {
        dashboardSourceFieldReferences({ [key]: state[key] }).forEach((reference) => controlReferences.add(reference));
      }
      return selected;
    });
    if (!queries.length) block('No selected dashboard query is tied to the exact missing source topic identity.');
    for (const query of queries) {
      const references = dashboardSourceFieldReferences(query);
      if (!references.length) block('A selected query has no verified semantic field references.');
      for (const reference of references) { pending.add(reference); queryViews.add(reference.slice(0, reference.lastIndexOf('.'))); }
      if (Object.keys(query).some((key) => SECURITY.test(key) && !['filters', 'filter'].includes(key))) block('A selected query contains additional filter/security behavior that requires explicit review.');
    }
    for (const reference of controlReferences) if (!pending.has(reference)) block(`Dashboard control/filter field ${reference} is outside the proven topic-query scope; confirm its binding before reconstruction.`);
  } catch (error) { block((error as Error).message); }
  const joinFieldReferences = new Set(pending);
  const joinViews = new Set(queryViews);
  result.baseViewCandidates = [...queryViews].filter((name) => Boolean(resolveView(name))).sort();

  const required = new Map<string, View>();
  const scanned = new Set<string>();
  const sourceRelationNames = new Map((input.sourceRelationNames || []).filter(validName).map((name) => [identity(name), name]));
  const targetRelationNames = new Set((input.targetRelationNames || []).filter(validName).map(identity));
  const relationNames = new Set([...Object.keys(input.sourceFiles).filter((file) => file.endsWith('.view')).flatMap((file) => [identity(stem(file)), identity(stem(file).split('/').pop()!)]), ...sourceRelationNames.keys(), ...(input.sourceObservedRelationNames || [])]);
  const includeRelation = (name: string, depth = 0) => {
    requiredNames.add(identity(name));
    if (input.sourceObservedRelationNames?.includes(identity(name)) && !sourceRelationNames.has(identity(name))) {
      block(`Source relation ${name} exists but its inventory evidence is unverified. It cannot be reused or copied.`);
    } else if (viewMatches(input.sourceFiles, name, input.sourceViewFileNames).length) {
      const dependency = resolveView(name);
      if (dependency && !scanned.has(dependency.fileName)) includeDependencies(dependency, depth);
    } else if (sourceRelationNames.has(identity(name))) {
      checkWorkbookView({ name, fileName: `inherited:${identity(name)}` });
      if (targetRelationNames.has(identity(name))) reusedRelations.add(sourceRelationNames.get(identity(name))!);
      else if (input.targetObservedRelationNames?.includes(identity(name))) block(`Destination relation ${name} exists but its inventory evidence is unverified. Resolve that definition before reuse.`);
      else block(`Inherited relation ${name} exists in the verified source inventory but not the destination inventory. No YAML or SQL definition can be fabricated.`);
    } else block(`Relation ${name} has no exact authored definition or verified source inventory identity.`);
  };
  const includeDependencies = (view: View, depth = 0) => {
    if (depth > 30 || scanned.size > MAX_FILES) { block('View dependency closure exceeds the bounded reconstruction limit.'); return; }
    required.set(identity(view.name), view);
    includeView(view);
    if (scanned.has(view.fileName)) return;
    scanned.add(view.fileName);
    const fields = new Set(['dimensions', 'measures'].flatMap((section) => Object.keys(record(view.value[section]) ? view.value[section] : {})).map(identity));
    try {
      const scan = (value: unknown, kind: 'field' | 'view') => dashboardSourceFieldReferences(value, view.name, {
        kind, fieldNames: fields, relationNames,
        onRelation: (name) => includeRelation(name, depth + 1),
        onUnresolved: (token) => block(`View ${view.name} contains unresolved macro ${token}; no semantic identity was invented.`),
      }).forEach((reference) => pending.add(reference));
      scan(Object.fromEntries(Object.entries(view.value).filter(([key]) => !['dimensions', 'measures'].includes(key))), 'view');
      for (const section of ['dimensions', 'measures']) for (const definition of Object.values(record(view.value[section]) ? view.value[section] : {})) scan(definition, 'field');
    } catch { block(`View ${view.name} has unsupported or excessive dependency references.`); }
  };
  const checkedReferences = new Set<string>();
  const verifyFields = () => { for (const reference of pending) {
    if (checkedReferences.has(reference)) continue;
    checkedReferences.add(reference);
    if (pending.size > MAX_FILES) { block('Field dependency closure exceeds the bounded reconstruction limit.'); break; }
    const dot = reference.lastIndexOf('.');
    const view = resolveView(reference.slice(0, dot));
    if (!view) continue;
    const field = identity(reference.slice(dot + 1).replace(/\[.*$/, ''));
    const matches = ['dimensions', 'measures'].flatMap((section) => Object.keys(record(view.value[section]) ? view.value[section] : {}).filter((name) => identity(name) === field));
    if (matches.length !== 1) block(`Field ${reference} has no single authored shared definition; generated or workbook-local semantics require separate evidence.`);
    includeDependencies(view);
  } };
  verifyFields();

  // Cross-view formulas of selected fields require topic joins; view SQL's
  // underlying relation macros only require files, not extra topic joins.
  for (const reference of joinFieldReferences) {
    if (joinFieldReferences.size > MAX_FILES) { block('Selected field dependencies exceed the bounded reconstruction limit.'); break; }
    const dot = reference.lastIndexOf('.');
    const view = resolveView(reference.slice(0, dot));
    if (!view) continue;
    const fieldName = identity(reference.slice(dot + 1));
    const definitions = ['dimensions', 'measures'].flatMap((section) => Object.entries(record(view.value[section]) ? view.value[section] : {}).filter(([name]) => identity(name) === fieldName).map(([, definition]) => definition));
    if (definitions.length !== 1) continue;
    try {
      const fieldNames = new Set(['dimensions', 'measures'].flatMap((section) => Object.keys(record(view.value[section]) ? view.value[section] : {})).map(identity));
      for (const dependency of dashboardSourceFieldReferences(definitions[0], view.name, {
        kind: 'field', fieldNames, relationNames,
        onRelation: (name) => includeRelation(name),
        onUnresolved: (token) => block(`Field ${reference} contains unresolved macro ${token}.`),
      })) {
        joinFieldReferences.add(dependency);
        pending.add(dependency);
        joinViews.add(dependency.slice(0, dependency.lastIndexOf('.')));
      }
    } catch { block(`Field ${reference} has unsupported dependency references.`); }
  }
  verifyFields();

  const relationshipRows = (text: string, label: string, workbook = false): Record<string, unknown>[] => {
    if (!text.trim()) return [];
    const value = parsed(text, label);
    if (value === null || value === undefined || (workbook && record(value) && Object.keys(value).length === 0)) return [];
    if (!Array.isArray(value) || value.length > MAX_FILES) throw new Error(`${label}: authored relationships must be a bounded relationship list.`);
    if (value.some((row) => !record(row) || typeof row.join_from_view !== 'string' || typeof row.join_to_view !== 'string'
      || !validName(row.join_from_view) || !validName(row.join_to_view))) throw new Error(`${label}: authored relationship identities are incomplete.`);
    return value as Record<string, unknown>[];
  };
  const edgeIdentity = (row: Record<string, unknown>) => `${identity(row.join_from_view as string)}\u0000${identity(row.join_to_view as string)}`;
  const edges: Edge[] = [];
  const canonicalEdge = (value: Record<string, unknown>) => JSON.stringify(Object.fromEntries(Object.entries(value).sort(([left], [right]) => left.localeCompare(right))));
  const edgeValues = new Set<string>();
  if (Object.hasOwn(input.sourceFiles, 'relationships') || joinViews.size > 1) {
    try {
      if (!Object.hasOwn(input.sourceFiles, 'relationships')) throw new Error('Authored relationship evidence is required to connect the selected views.');
      for (const value of relationshipRows(input.sourceFiles.relationships, 'relationships')) {
        const valid = Object.keys(value).every((key) => RELATIONSHIP_KEYS.has(key))
          && typeof value.on_sql === 'string' && Boolean(value.on_sql.trim())
          && typeof value.join_type === 'string' && JOIN_TYPES.has(value.join_type)
          && typeof value.relationship_type === 'string' && CARDINALITIES.has(value.relationship_type)
          && value.join_to_view_as === undefined
          && (value.reversible === undefined || typeof value.reversible === 'boolean')
          && ['where_sql', 'documentation', 'description', 'label'].every((key) => value[key] === undefined || typeof value[key] === 'string');
        // Repeated identical authored rows do not invent a second semantic path.
        const key = canonicalEdge(value);
        if (!edgeValues.has(key)) { edges.push({ from: identity(value.join_from_view as string), to: identity(value.join_to_view as string), value, valid }); edgeValues.add(key); }
      }
    } catch (error) { block((error as Error).message); }
  }
  let graphVisits = 0;
  let graphExhausted = false;
  const pathCache = new Map<string, Edge[][]>();
  const pathsBetween = (from: string, to: string): Edge[][] => {
    const key = `${identity(from)}\u0000${identity(to)}`;
    const cached = pathCache.get(key);
    if (cached) return cached;
    const paths: Edge[][] = [];
    const search = (node: string, path: Edge[], seen: Set<string>) => {
      if (++graphVisits > MAX_VISITS || path.length > 30) { graphExhausted = true; throw new Error('Relationship traversal exceeds the bounded reconstruction limit.'); }
      if (paths.length > MAX_JOIN_PATHS) return;
      if (node === identity(to)) { paths.push(path); return; }
      for (const edge of edges) if (edge.from === node && !seen.has(edge.to)) search(edge.to, [...path, edge], new Set([...seen, edge.to]));
    };
    if (!graphExhausted) try { search(identity(from), [], new Set([identity(from)])); } catch (error) { block((error as Error).message); }
    pathCache.set(key, paths);
    return paths;
  };
  const explicitBase = input.baseView?.trim();
  if (explicitBase) {
    if (!result.baseViewCandidates.some((candidate) => identity(candidate) === identity(explicitBase))) block('The selected base view is outside the verified selected-query candidates. Choose one of the offered base views.');
    else { result.baseView = resolveView(explicitBase)!.name; result.baseViewReason = 'Explicitly selected from the verified query-view candidates.'; }
  } else {
    const viable: string[] = [];
    for (const candidate of result.baseViewCandidates) {
      if (graphExhausted) break;
      if ([...joinViews].every((name) => {
        const paths = pathsBetween(candidate, name);
        return paths.length === 1 && paths[0].every((edge) => edge.valid);
      })) viable.push(candidate);
    }
    if (viable.length === 1 && !graphExhausted) {
      result.baseView = resolveView(viable[0])!.name;
      result.baseViewReason = 'The only verified candidate with one unambiguous directed authored path to every selected query dependency.';
    } else block(viable.length > 1
      ? 'Multiple base-view candidates have verified directed coverage. Select an explicit base view.'
      : 'No unique base-view candidate has verified directed coverage. Select an explicit base view and resolve missing or ambiguous joins.');
  }
  if (result.baseView) includeDependencies(resolveView(result.baseView)!);
  const chosen = new Set<Edge>();
  let joinsResolved = Boolean(result.baseView);
  const consumedSelections = new Set<string>();
  if (joinViews.size > MAX_JOIN_CHOICES) { block('The required join views exceed the bounded path-review limit.'); joinsResolved = false; }
  if (result.baseView) for (const requiredView of [...joinViews].sort().slice(0, MAX_JOIN_CHOICES)) {
    if (graphExhausted) break;
    if (identity(requiredView) === identity(result.baseView)) continue;
    const paths = pathsBetween(result.baseView, requiredView);
    const complete = !graphExhausted && paths.length <= MAX_JOIN_PATHS;
    const offered = paths.slice(0, MAX_JOIN_PATHS).filter((path) => path.every((edge) => edge.valid)).map((path) => ({
      path,
      id: `sha256:${createHash('sha256').update(JSON.stringify(['dashboard-topic-join-path-v1', identity(result.baseView!), identity(requiredView), path.map((edge) => canonicalEdge(edge.value))])).digest('hex')}`,
    }));
    const selectedId = Object.hasOwn(selections, requiredView) ? selections[requiredView] : undefined;
    if (selectedId) consumedSelections.add(requiredView);
    const selected = selectedId ? offered.find((candidate) => candidate.id === selectedId) : paths.length === 1 ? offered[0] : undefined;
    result.joinPathChoices.push({ requiredView, complete, paths: offered.map(({ id, path }) => ({
      id, views: [path[0].value.join_from_view as string, ...path.map((edge) => edge.value.join_to_view as string)],
      edges: path.map((edge) => ({ fromView: edge.value.join_from_view as string, toView: edge.value.join_to_view as string, authoredYaml: stringify(edge.value, { lineWidth: 0 }) })),
    })), ...(selected && complete ? { selectedPathId: selected.id } : {}) });
    if (!complete) block(`Authored join paths from ${result.baseView} to ${requiredView} exceed the bounded review limit; no path selection can authorize this incomplete inventory.`);
    else if (selectedId && !selected) block(`The selected join path for ${requiredView} is invalid or stale for this base and authored evidence. Choose an offered path and preview again.`);
    else if (!selected) {
      if (paths.length > 1) block(`Multiple authored join paths connect ${result.baseView} to ${requiredView}; choose semantics explicitly.`);
      else if (!paths.length) block(`No authored directed join path connects ${result.baseView} to ${requiredView}.`);
      else for (const edge of paths[0]) if (!edge.valid) block(`Relationship ${edge.from} → ${edge.to} has incomplete, assumed, aliased, or unsupported semantics.`);
    }
    if (selected && complete) for (const edge of selected.path) chosen.add(edge);
    else joinsResolved = false;
  }
  for (const name of Object.keys(selections)) if (!consumedSelections.has(name)) {
    block(`Join-path selection ${name} is outside this base view's required join scope. Clear it and preview again.`); joinsResolved = false;
  }
  if (graphExhausted) joinsResolved = false;
  // A topic can reference a view once. Never silently discard an alternate
  // parent from independently selected paths or substitute a different route.
  const incoming = new Map<string, Edge>();
  for (const edge of chosen) {
    const prior = incoming.get(edge.to);
    if (identity(result.baseView || '') === edge.to || (prior && prior !== edge)) {
      block(`Selected join paths have incompatible incoming relationships for ${edge.to}. Choose paths that form one consistent directed tree.`); joinsResolved = false;
    }
    incoming.set(edge.to, edge);
  }
  const joins: Record<string, unknown> = {};
  const included = new Set<string>(result.baseView ? [identity(result.baseView)] : []);
  const joinNodes = new Map<string, Record<string, unknown>>(result.baseView ? [[identity(result.baseView), joins]] : []);
  for (let pass = 0; pass <= chosen.size; pass += 1) for (const edge of chosen) {
    if (!included.has(edge.from) || included.has(edge.to)) continue;
    const from = resolveView(edge.value.join_from_view as string);
    const to = resolveView(edge.value.join_to_view as string);
    if (!from || !to) continue;
    includeDependencies(from); includeDependencies(to);
    const node: Record<string, unknown> = {};
    joinNodes.get(edge.from)![to.name] = node;
    joinNodes.set(edge.to, node); included.add(edge.to);
  }
  // Edges can introduce bridge-view definitions and field references too.
  for (const edge of chosen) for (const reference of dashboardSourceFieldReferences({ on_sql: edge.value.on_sql, where_sql: edge.value.where_sql })) {
    pending.add(reference);
    if (!included.has(identity(reference.slice(0, reference.lastIndexOf('.'))))) block(`Relationship ${edge.from} → ${edge.to} references ${reference} outside the verified topic join path. Its additional join semantics require explicit review.`);
  }
  verifyFields();

  // Workbook edges are evidence of local behavior only, never candidates for
  // global writes. Compare only rows that can affect the selected join scope.
  const scopeViews = new Set([...joinViews].map(identity));
  for (const edge of chosen) { scopeViews.add(edge.from); scopeViews.add(edge.to); }
  for (const snapshot of workbookSnapshots) if (Object.hasOwn(snapshot, 'relationships')) {
    try {
      const localRows = relationshipRows(snapshot.relationships, 'workbook relationships', true);
      const graph = [...edges, ...localRows.map((value) => ({ from: identity(value.join_from_view as string), to: identity(value.join_to_view as string) }))];
      const reachable = (from: string, to: string): boolean => {
        const pendingNodes = [identity(from)];
        const seen = new Set<string>();
        for (const node of pendingNodes) {
          if (++graphVisits > MAX_VISITS) throw new Error('Workbook relationship traversal exceeds the bounded reconstruction limit.');
          if (node === identity(to)) return true;
          if (seen.has(node)) continue;
          seen.add(node);
          for (const edge of graph) if (edge.from === node && !seen.has(edge.to)) pendingNodes.push(edge.to);
        }
        return false;
      };
      const origins = result.baseView ? [result.baseView] : result.baseViewCandidates;
      for (const local of localRows) {
        const from = identity(local.join_from_view as string);
        const to = identity(local.join_to_view as string);
        const relevant = (scopeViews.has(from) && scopeViews.has(to)) || origins.some((origin) => [...joinViews].some((name) => identity(name) !== identity(origin)
          && reachable(origin, from) && reachable(to, name)));
        if (!relevant) continue;
        const shared = edges.filter((edge) => edgeIdentity(edge.value) === edgeIdentity(local));
        if (shared.length !== 1 || !isDeepStrictEqual(shared[0].value, local)) block(`Workbook-local relationship ${from} → ${to} differs from or has no exact shared edge. Preserve its local scope; it cannot be promoted.`);
      }
    } catch (error) { block((error as Error).message); }
  }

  result.requiredViews = [...required.values()].map((view) => view.name);
  result.files = [...files.values()];
  if (chosen.size) {
    const sourceRows = [...chosen].map((edge) => edge.value);
    const sourceYaml = stringify(sourceRows, { lineWidth: 0 });
    const original = Object.hasOwn(input.targetFiles, 'relationships') ? input.targetFiles.relationships : null;
    let proposed = sourceYaml;
    try {
      const destinationRows = original === null ? undefined : relationshipRows(original, 'destination relationships');
      proposed = mergeDashboardRepairYaml(original === null ? undefined : original.trim() ? original : '[]\n', sourceYaml);
      const unchanged = original !== null && isDeepStrictEqual(destinationRows, relationshipRows(proposed, 'proposed relationships'));
      result.files.push({ fileName: 'relationships', original, proposed: unchanged ? original! : proposed, kind: 'relationship', status: original === null ? 'new' : unchanged ? 'unchanged' : 'additive', message: 'Only selected verified shared edges are included; unrelated destination relationships are preserved.' });
    } catch {
      block('Selected shared relationships conflict with authored destination relationships. Existing destination edges cannot be overwritten.');
      // The rejected proposal is display-only. Retain unrelated destination nodes
      // and comments so the review does not imply deleting the rest of the graph.
      try {
        if (original !== null) {
          relationshipRows(original, 'destination relationships');
          const document = parseDocument(original, { uniqueKeys: true, strict: true, prettyErrors: false });
          if (isSeq(document.contents)) {
            for (const row of sourceRows) {
              const index = document.contents.items.findIndex((node) => isMap(node) && edgeIdentity(node.toJSON() as Record<string, unknown>) === edgeIdentity(row));
              if (index < 0) document.addIn([], row);
              else {
                const current = document.contents.items[index];
                const next = document.createNode({ ...(isMap(current) ? current.toJSON() : {}), ...row });
                if (isNode(current)) { next.comment = current.comment; next.commentBefore = current.commentBefore; }
                document.setIn([index], next);
              }
            }
            proposed = document.toString({ lineWidth: 0 });
          }
        }
      } catch { /* The exact original is still retained alongside the blocked source proposal. */ }
      result.files.push({ fileName: 'relationships', original, proposed, kind: 'relationship', status: 'conflict', message: 'Conflicting selected edges are shown for review only. No existing relationship may be changed by this repair.' });
    }
  }
  if (result.baseView && joinsResolved) {
    const topic: Record<string, unknown> = { base_view: result.baseView };
    if (Object.keys(joins).length) topic.joins = joins;
    const proposed = stringify(topic, { lineWidth: 0 });
    if (proposed.length > MAX_YAML) block('The generated topic exceeds the bounded YAML review limit.');
    const matches = fileMatches(input.targetFiles, result.targetTopicName, '.topic');
    const fileName = matches[0] || `${result.targetTopicName}.topic`;
    const original = matches.length ? input.targetFiles[fileName] : null;
    let same = false;
    try { same = original !== null && isDeepStrictEqual(parsed(original, fileName), topic); } catch { /* collision stays blocked */ }
    if (matches.length > 1 || (original !== null && !same)) block('The destination topic name already exists with different or ambiguous semantics. Choose another name or use the ordinary mapping workflow.');
    result.files.push({ fileName, original, proposed: same ? original! : proposed, kind: 'topic', status: original === null ? 'new' : same ? 'unchanged' : 'conflict', message: 'Reconstructed from selected query evidence. Query-specific filters remain on the dashboard and are not promoted into topic-wide defaults.' });
  }
  return finish();
}
