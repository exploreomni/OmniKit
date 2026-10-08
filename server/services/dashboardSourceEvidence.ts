import { isAlias, isMap, isNode, isScalar, isSeq, parseDocument, visit } from 'yaml';

export type DashboardSourceFieldProvenance =
  | 'shared_authored' | 'workbook_local' | 'workbook_override' | 'inherited_unverified' | 'unverified';

export interface DashboardSourceFieldEvidence {
  reference: string;
  provenance: DashboardSourceFieldProvenance;
  sourceModelId?: string;
  sourceFileName?: string;
  sourceScope?: 'shared' | 'workbook';
  definition?: unknown;
  dependencies: string[];
  sharedWriteAllowed: boolean;
}

export interface DashboardSourceEvidence {
  sharedFiles: Record<string, string>;
  workbookFiles: Record<string, string>;
  fields: DashboardSourceFieldEvidence[];
  requiredSharedFiles: string[];
  requiredWorkbookFiles: string[];
  blockedSharedWriteReferences: string[];
  findings: Array<{ reference: string; message: string; sourceFileName?: string; sourceScope?: 'shared' | 'workbook'; causeCode?: string }>;
  unverified: boolean;
}

export interface DashboardSourceYamlReadOptions {
  fullyResolved: false;
  mode?: 'extension';
}

export interface DashboardSourceReferenceContext {
  kind: 'field' | 'view';
  fieldNames: ReadonlySet<string>;
  relationNames: ReadonlySet<string>;
  onRelation?: (name: string) => void;
  onUnresolved?: (token: string) => void;
}

const FIELD_KEYS = new Set(['field', 'fieldName', 'field_name', 'column_name', 'columnName', 'fields', 'pivots', 'sorts', 'filters', 'filter', 'measures', 'dimensions', 'x', 'y', 'series']);
const FIELD_PATTERN = /\b([A-Za-z_][\w/]*\.[A-Za-z_][\w]*(?:\[[A-Za-z_][\w]*\])?)\b/g;
const MAX_REFERENCES = 5_000;
const MAX_YAML_LENGTH = 5_000_000;

type ParsedSourceYaml = { kind: 'empty' } | { kind: 'mapping'; value: Record<string, unknown> }
  | { kind: 'relationships'; value: Record<string, unknown>[] };

class SourceYamlEvidenceError extends Error {
  constructor(readonly causeCode: string, message: string, readonly sourceFileName: string, readonly sourceScope: 'shared' | 'workbook') {
    super(message);
  }
}

/** Parsing never normalizes or replaces the complete authored strings returned to callers. */
function parseSourceYaml(text: string, file: string, workbook: boolean): ParsedSourceYaml {
  const scope = workbook ? 'workbook' : 'shared';
  const reject = (code: string, message: string): never => { throw new SourceYamlEvidenceError(code, message, file, scope); };
  if (text.length > MAX_YAML_LENGTH) reject('SOURCE_YAML_LIMIT', 'Source YAML exceeds the bounded file-size limit; review this file separately.');
  let document;
  try {
    document = parseDocument(text, { uniqueKeys: true, strict: true, prettyErrors: false });
  } catch {
    return reject('SOURCE_YAML_MALFORMED', 'Source YAML syntax could not be parsed; correct this file before rechecking its definitions.');
  }
  if (document.errors.length) {
    const offset = document.errors[0].pos?.[0];
    const location = typeof offset === 'number' ? ` at line ${text.slice(0, offset).split('\n').length}` : '';
    reject('SOURCE_YAML_MALFORMED', `Source YAML has invalid syntax${location}; correct this file before rechecking its definitions.`);
  }
  if (document.warnings.length) reject('SOURCE_YAML_UNSUPPORTED_FEATURE', 'Source YAML uses a tag or feature requiring explicit interpretation; it is not an empty file.');
  let nodes = 0;
  visit(document, (_key, node, path) => {
    if (++nodes > 100_000 || path.length > 64) reject('SOURCE_YAML_LIMIT', 'Source YAML nesting or node count exceeds the bounded evidence scope.');
    if (isAlias(node) || (isNode(node) && 'anchor' in node && node.anchor)) {
      reject('SOURCE_YAML_UNSUPPORTED_FEATURE', 'Source YAML anchors or aliases require explicit interpretation before definitions can be verified.');
    }
    if (isNode(node) && node.tag && !['tag:yaml.org,2002:map', 'tag:yaml.org,2002:seq', 'tag:yaml.org,2002:str', 'tag:yaml.org,2002:null', 'tag:yaml.org,2002:bool', 'tag:yaml.org,2002:int', 'tag:yaml.org,2002:float'].includes(node.tag)) {
      reject('SOURCE_YAML_UNSUPPORTED_FEATURE', 'Source YAML custom tags require explicit interpretation before definitions can be verified.');
    }
    if (isMap(node)) for (const pair of node.items) {
      if (!isScalar(pair.key) || typeof pair.key.value !== 'string' || ['<<', '__proto__', 'constructor', 'prototype'].includes(pair.key.value)) {
        reject('SOURCE_YAML_UNSUPPORTED_SHAPE', 'Source YAML requires ordinary string mapping keys; merge or structured keys need explicit review.');
      }
    }
  });
  if (!document.contents || (isScalar(document.contents) && document.contents.value === null)) return { kind: 'empty' };
  const value: unknown = document.toJS({ maxAliasCount: 0 });
  const relationshipList = (items: unknown): items is Record<string, unknown>[] => {
    if (!Array.isArray(items)) return false;
    const identities = new Set<string>();
    for (const item of items) {
      if (!record(item) || typeof item.join_from_view !== 'string' || !item.join_from_view.trim()
        || typeof item.join_to_view !== 'string' || !item.join_to_view.trim()) return false;
      const aliases: Array<[string, string]> = [];
      for (const side of ['from', 'to']) {
        const values = ['join_' + side + '_view_as', 'join_' + side + '_view_alias'].filter((key) => Object.hasOwn(item, key)).map((key) => item[key]);
        if (values.some((alias) => typeof alias !== 'string' || !alias.trim() || alias !== alias.trim()) || new Set(values).size > 1) return false;
        if (values.length) aliases.push([side, values[0] as string]);
      }
      const identity = JSON.stringify([item.join_from_view, item.join_to_view, aliases]);
      if (identities.has(identity)) return false;
      identities.add(identity);
    }
    return true;
  };
  if (file === 'relationships') {
    if (isSeq(document.contents) && relationshipList(value)) return { kind: 'relationships', value };
    if (record(value) && !Object.keys(value).length) return { kind: 'empty' };
    if (record(value) && Object.keys(value).length === 1 && relationshipList(value.relationships)) return { kind: 'relationships', value: value.relationships };
    return reject('SOURCE_YAML_UNSUPPORTED_SHAPE', 'The relationships file requires a relationship list with complete, unique view and alias identities; preserve unsupported shapes explicitly.');
  }
  if (!record(value)) return reject('SOURCE_YAML_UNSUPPORTED_SHAPE', `${file.endsWith('.view') ? 'A view' : 'This source'} file requires a YAML mapping, not a scalar or sequence; no definitions were inferred.`);
  return { kind: 'mapping', value };
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function referenceKey(value: string): string {
  return value.trim().replace(/^\$\{(.+)\}$/, '$1').replace(/\[.*$/, '').toLowerCase();
}

/** Source fields only: literal SQL table names are not semantic field evidence. */
export function dashboardSourceFieldReferences(value: unknown, containingView?: string, context?: DashboardSourceReferenceContext): string[] {
  const found = new Set<string>();
  const seen = new Set<object>();
  let visits = 0;
  const visit = (item: unknown, key = '', depth = 0) => {
    if (depth > 30 || ++visits > 50_000) throw new Error('Source dependency traversal limit exceeded.');
    if (typeof item === 'string') {
      if (['label', 'description', 'group_label', 'folder', 'schema_label'].includes(key)) return;
      if (FIELD_KEYS.has(key)) for (const match of item.matchAll(FIELD_PATTERN)) found.add(referenceKey(match[1]));
      for (const match of item.matchAll(/\$\{([A-Za-z_][\w/]*\.[A-Za-z_][\w]*(?:\[[A-Za-z_][\w]*\])?)\}/g)) found.add(referenceKey(match[1]));
      for (const match of item.matchAll(/\$\{([A-Za-z_][\w/]*)\}/g)) {
        if (match[1].toUpperCase() === 'TABLE') continue;
        const token = match[1].toLowerCase();
        const field = context?.fieldNames.has(token);
        const relation = context?.relationNames.has(token);
        const relationPosition = /\b(?:from|join)\s*$/i.test(item.slice(0, match.index));
        if (relation && (relationPosition || (context?.kind === 'view' && ['sql_table_name', 'table_name'].includes(key)))) context?.onRelation?.(token);
        else if (containingView && field && !relationPosition && (!relation || context?.kind === 'field')) found.add(referenceKey(`${containingView}.${token}`));
        else context?.onUnresolved?.(token);
      }
    } else if (item && typeof item === 'object' && !seen.has(item)) {
      seen.add(item);
      if (Array.isArray(item)) item.forEach((child) => visit(child, key, depth + 1));
      else for (const [childKey, child] of Object.entries(item)) {
        if (FIELD_KEYS.has(key)) for (const match of childKey.matchAll(FIELD_PATTERN)) found.add(referenceKey(match[1]));
        visit(child, childKey, depth + 1);
      }
    }
    if (found.size > MAX_REFERENCES) throw new Error('Source dependency limit exceeded.');
  };
  visit(value);
  return [...found].sort();
}

function viewFile(files: Record<string, string>, view: string): string | undefined {
  const matches = Object.keys(files).filter((file) => {
    if (!file.endsWith('.view')) return false;
    const name = file.replace(/\.(query\.view|view)$/, '').toLowerCase();
    return view.includes('/') ? name === view : name.split('/').pop() === view;
  });
  if (matches.length > 1) throw new Error('Ambiguous source view files.');
  return matches[0];
}

function fieldDefinition(view: Record<string, unknown>, field: string): { definition: unknown } | undefined {
  const matches: unknown[] = [];
  for (const sectionName of ['dimensions', 'measures']) {
    const section = view[sectionName];
    if (section !== undefined && !record(section)) throw new Error('Unsupported source field section.');
    for (const [name, definition] of Object.entries(section || {})) {
      if (name.toLowerCase() === field) matches.push(definition);
    }
  }
  if (matches.length > 1) throw new Error('Ambiguous source field definition.');
  if (!matches.length) return undefined;
  if (matches[0] !== null && !record(matches[0])) throw new Error('Unsupported source field definition.');
  return { definition: matches[0] ?? {} };
}

function overlayDefinition(base: unknown, overlay: unknown, depth = 0): unknown {
  if (depth > 30) throw new Error('Source overlay nesting limit exceeded.');
  if (!record(base) || !record(overlay)) return overlay;
  const result = { ...base };
  for (const [key, value] of Object.entries(overlay)) result[key] = overlayDefinition(base[key], value, depth + 1);
  return result;
}

/** Read-only provenance. Workbook definitions are never promoted into sharedFiles. */
export async function readDashboardSourceEvidence(input: {
  sharedModelId: string;
  workbookModelId?: string;
  references?: readonly string[];
  states?: readonly unknown[];
  loadYaml: (modelId: string, options: DashboardSourceYamlReadOptions) => Promise<Record<string, string>>;
}): Promise<DashboardSourceEvidence> {
  const result: DashboardSourceEvidence = {
    sharedFiles: {}, workbookFiles: {}, fields: [], requiredSharedFiles: [], requiredWorkbookFiles: [],
    blockedSharedWriteReferences: [], findings: [], unverified: false,
  };
  let globallyUnverified = false;
  const add = (reference: string, message: string, sourceFileName?: string, unverified = true,
    details?: { sourceScope: 'shared' | 'workbook'; causeCode?: string }) => {
    result.findings.push({ reference, message, ...(sourceFileName ? { sourceFileName } : {}), ...details });
    result.unverified ||= unverified;
  };
  const reportedYaml = new Set<string>();
  const reportYaml = (error: SourceYamlEvidenceError) => {
    const key = `${error.sourceScope}:${error.sourceFileName}`;
    if (reportedYaml.has(key)) return;
    reportedYaml.add(key);
    add(error.sourceScope === 'workbook' ? 'workbook_overlay' : 'source_yaml', error.message, error.sourceFileName, true,
      { sourceScope: error.sourceScope, causeCode: error.causeCode });
  };
  const read = async (modelId: string, workbook: boolean) => {
    try {
      const files = await input.loadYaml(modelId, { fullyResolved: false, ...(workbook ? { mode: 'extension' as const } : {}) });
      if (!record(files) || Object.keys(files).length > MAX_REFERENCES || Object.values(files).some((value) => typeof value !== 'string')) throw new Error('Unsupported source YAML response.');
      return files;
    } catch {
      globallyUnverified = true;
      add(workbook ? 'workbook_model' : 'shared_model', workbook
        ? 'Workbook extension YAML could not be verified; shared-model repair is not authorized.'
        : 'Authored shared-model YAML could not be verified.', undefined, true,
      { sourceScope: workbook ? 'workbook' : 'shared', causeCode: 'SOURCE_YAML_READ_UNAVAILABLE' });
      return {};
    }
  };
  if (!input.sharedModelId.trim() || input.workbookModelId === input.sharedModelId) {
    globallyUnverified = true;
    add('source_binding', 'Distinct shared and workbook source-model bindings are required.');
  } else {
    [result.sharedFiles, result.workbookFiles] = await Promise.all([
      read(input.sharedModelId, false),
      input.workbookModelId ? read(input.workbookModelId, true) : Promise.resolve({}),
    ]);
  }
  const parsed = new Map<string, ParsedSourceYaml>();
  const parseFailures = new Map<string, SourceYamlEvidenceError>();
  const loadFile = (file: string, workbook: boolean): ParsedSourceYaml => {
    const key = `${workbook ? 'workbook' : 'shared'}:${file}`;
    const failure = parseFailures.get(key);
    if (failure) throw failure;
    if (!parsed.has(key)) {
      try {
        parsed.set(key, parseSourceYaml((workbook ? result.workbookFiles : result.sharedFiles)[file], file, workbook));
      } catch (error) {
        if (error instanceof SourceYamlEvidenceError) parseFailures.set(key, error);
        throw error;
      }
    }
    return parsed.get(key)!;
  };
  const load = (file: string | undefined, workbook: boolean): Record<string, unknown> => {
    if (!file) return {};
    const fileEvidence = loadFile(file, workbook);
    if (fileEvidence.kind === 'relationships') throw new SourceYamlEvidenceError('SOURCE_YAML_UNSUPPORTED_SHAPE',
      'Relationship definitions cannot stand in for an authored view mapping.', file, workbook ? 'workbook' : 'shared');
    return fileEvidence.kind === 'mapping' ? fileEvidence.value : {};
  };
  // Only bounded presentation scalars are supported here. Unknown semantics and
  // security remain a file-level prerequisite, not failed evidence for every field.
  const presentation = (key: string, value: unknown) => (
    (['label', 'description', 'group_label', 'folder', 'schema_label'].includes(key) && typeof value === 'string')
    || (key === 'hidden' && typeof value === 'boolean')
    || (key === 'display_order' && typeof value === 'number' && Number.isFinite(value))
  );
  for (const file of Object.keys(result.workbookFiles)) {
    try {
      const fileEvidence = loadFile(file, true);
      if (fileEvidence.kind === 'empty') continue;
      if (fileEvidence.kind === 'relationships') {
        if (fileEvidence.value.length) add('workbook_overlay', 'Workbook-local relationships are valid authored definitions but require explicit preservation in the workbook; they cannot become shared-model proposals.', file, true,
          { sourceScope: 'workbook', causeCode: 'WORKBOOK_OVERLAY_PRESERVATION_REQUIRED' });
        continue;
      }
      const value = fileEvidence.value;
      const unsupported = file.endsWith('.view')
        ? Object.keys(value).filter((key) => !['dimensions', 'measures'].includes(key) && !presentation(key, value[key]))
        : Object.keys(value);
      for (const section of ['dimensions', 'measures']) {
        if (value[section] !== undefined && !record(value[section])) throw new SourceYamlEvidenceError('SOURCE_YAML_UNSUPPORTED_SHAPE',
          `The ${section} section requires a YAML mapping of field names to definitions; review this workbook file before rechecking.`, file, 'workbook');
      }
      if (unsupported.length) add('workbook_overlay', `Workbook-local properties require explicit preservation: ${[...new Set(unsupported)].sort().join(', ')}. Shared-model proposals are withheld.`, file, true,
        { sourceScope: 'workbook', causeCode: 'WORKBOOK_OVERLAY_PRESERVATION_REQUIRED' });
    } catch (error) {
      if (error instanceof SourceYamlEvidenceError) reportYaml(error);
      else add('workbook_overlay', 'Workbook-local YAML cannot be interpreted safely; explicit preservation review is required and shared-model proposals are withheld.', file, true,
        { sourceScope: 'workbook', causeCode: 'SOURCE_YAML_UNSUPPORTED_SHAPE' });
    }
  }
  const pending = new Set<string>();
  try {
    for (const reference of input.references || []) {
      const key = referenceKey(reference);
      if (!/^[A-Za-z_][\w/]*\.[A-Za-z_][\w]*$/.test(key)) throw new Error('Unsupported source field reference.');
      pending.add(key);
    }
    for (const reference of dashboardSourceFieldReferences(input.states || [])) pending.add(reference);
  } catch {
    globallyUnverified = true;
    add('source_references', 'The complete source dependency references could not be verified.');
  }
  const fields = new Map<string, DashboardSourceFieldEvidence>();
  const sharedRequired = new Set<string>();
  const workbookRequired = new Set<string>();
  const relationNames = new Set(Object.keys({ ...result.sharedFiles, ...result.workbookFiles })
    .filter((file) => file.endsWith('.view')).flatMap((file) => {
      const name = file.replace(/\.(query\.view|view)$/, '').toLowerCase();
      return [name, name.split('/').pop()!];
    }));
  const unresolvedMacros = new Set<string>();
  const contextCache = new Map<string, { references: Set<string>; unverified: boolean }>();
  const activeContexts = new Set<string>();
  const sourceField = (value: Record<string, unknown>, field: string, file: string | undefined, workbook: boolean) => {
    try {
      return fieldDefinition(value, field);
    } catch (error) {
      if (!file) throw error;
      const message = error instanceof Error && error.message === 'Ambiguous source field definition.'
        ? 'The requested field has ambiguous authored identities across dimensions or measures; resolve the ambiguity before rechecking.'
        : 'Source field sections must be mappings and each field must have a mapping or null definition; this authored shape needs explicit review.';
      throw new SourceYamlEvidenceError('SOURCE_YAML_UNSUPPORTED_SHAPE', message, file, workbook ? 'workbook' : 'shared');
    }
  };
  const referenceContext = (view: string, sharedView: Record<string, unknown>, workbookView: Record<string, unknown>, file: string | undefined, kind: 'field' | 'view', onRelation: (name: string) => void, onUnverified: () => void): DashboardSourceReferenceContext => ({
    kind,
    fieldNames: new Set([sharedView, workbookView].flatMap((value) => ['dimensions', 'measures'].flatMap((section) => Object.keys(record(value[section]) ? value[section] : {}))).map((name) => name.toLowerCase())),
    relationNames,
    onRelation,
    onUnresolved: (token) => {
      onUnverified();
      const key = `${file || view}:${token}`;
      if (unresolvedMacros.has(key)) return;
      unresolvedMacros.add(key);
      add('source_macro', `Source macro ${token} has no unambiguous authored field or relation identity.`, file);
    },
  });
  const viewContext = (view: string, depth = 0): { references: Set<string>; unverified: boolean } => {
    if (depth > 30) throw new Error('Source relation traversal limit exceeded.');
    const cached = contextCache.get(view);
    if (activeContexts.has(view)) throw new Error('Cyclic source relation macros require explicit review.');
    if (cached) return cached;
    const context = { references: new Set<string>(), unverified: false };
    contextCache.set(view, context);
    activeContexts.add(view);
    try {
      const sharedFile = viewFile(result.sharedFiles, view);
      const workbookFile = viewFile(result.workbookFiles, view);
      const sharedView = load(sharedFile, false);
      const workbookView = load(workbookFile, true);
      if (sharedFile) sharedRequired.add(sharedFile);
      else if (workbookFile) {
        workbookRequired.add(workbookFile);
        context.unverified = true;
        add('workbook_overlay', 'A workbook-local relation requires explicit preservation; shared-model proposals are withheld.', workbookFile);
      }
      const related = (name: string) => {
        const dependency = viewContext(name, depth + 1);
        for (const reference of dependency.references) context.references.add(reference);
        context.unverified ||= dependency.unverified;
      };
      const settings = Object.fromEntries(Object.entries(sharedView).filter(([key, value]) => !['dimensions', 'measures'].includes(key) && !presentation(key, value)));
      for (const reference of dashboardSourceFieldReferences(settings, view, referenceContext(view, sharedView, workbookView, sharedFile, 'view', related, () => { context.unverified = true; }))) context.references.add(reference);
      return context;
    } catch (error) {
      context.unverified = true;
      throw error;
    } finally {
      activeContexts.delete(view);
    }
  };
  for (const reference of pending) {
    if (fields.size >= MAX_REFERENCES) {
      globallyUnverified = true;
      add('source_references', 'The source dependency closure exceeded its safety limit.');
      break;
    }
    const evidence: DashboardSourceFieldEvidence = { reference, provenance: 'unverified', dependencies: [], sharedWriteAllowed: false };
    fields.set(reference, evidence);
    try {
      const dot = reference.lastIndexOf('.');
      const view = reference.slice(0, dot);
      const field = reference.slice(dot + 1);
      const sharedFile = viewFile(result.sharedFiles, view);
      const workbookFile = viewFile(result.workbookFiles, view);
      const sharedView = load(sharedFile, false);
      const workbookView = load(workbookFile, true);
      const shared = sourceField(sharedView, field, sharedFile, false);
      const workbook = sourceField(workbookView, field, workbookFile, true);
      if (workbook && workbookFile) {
        evidence.provenance = shared ? 'workbook_override' : 'workbook_local';
        evidence.sourceModelId = input.workbookModelId;
        evidence.sourceFileName = workbookFile;
        evidence.sourceScope = 'workbook';
        evidence.definition = shared ? overlayDefinition(shared.definition, workbook.definition) : workbook.definition;
        workbookRequired.add(workbookFile);
        add(reference, shared
          ? 'A workbook-local override must be preserved in the workbook; it cannot become a shared-model repair.'
          : 'A workbook-local field must be preserved in the workbook; it cannot become a shared-model repair.', workbookFile, false,
        { sourceScope: 'workbook', causeCode: 'WORKBOOK_FIELD_IDENTIFIED' });
      } else if (shared && sharedFile) {
        evidence.provenance = 'shared_authored';
        evidence.sourceModelId = input.sharedModelId;
        evidence.sourceFileName = sharedFile;
        evidence.sourceScope = 'shared';
        evidence.definition = shared.definition;
        evidence.sharedWriteAllowed = true;
      } else {
        evidence.provenance = globallyUnverified ? 'unverified' : 'inherited_unverified';
        add(reference, 'The field has no verified authored definition; inherited or generated semantics require explicit source evidence.', sharedFile || workbookFile);
      }
      if (shared && sharedFile) sharedRequired.add(sharedFile);
      let unverifiedMacro = false;
      const context = viewContext(view);
      const relationReferences = new Set<string>();
      const fieldContext = referenceContext(view, sharedView, workbookView, workbookFile || sharedFile, 'field', (name) => {
        const related = viewContext(name);
        for (const dependency of related.references) relationReferences.add(dependency);
        unverifiedMacro ||= related.unverified;
      }, () => { unverifiedMacro = true; });
      evidence.dependencies = [...new Set([
        ...dashboardSourceFieldReferences(evidence.definition, view, fieldContext),
        ...context.references,
        ...relationReferences,
      ])].filter((dependency) => dependency !== reference).sort();
      if (context.unverified || unverifiedMacro) evidence.sharedWriteAllowed = false;
      for (const dependency of evidence.dependencies) pending.add(dependency);
    } catch (error) {
      evidence.provenance = 'unverified';
      evidence.sharedWriteAllowed = false;
      if (error instanceof SourceYamlEvidenceError) {
        evidence.sourceFileName ??= error.sourceFileName;
        evidence.sourceScope ??= error.sourceScope;
        reportYaml(error);
      } else add(reference, 'The authored source field is ambiguous or unsupported and cannot authorize a shared-model repair.', evidence.sourceFileName, true,
        evidence.sourceScope ? { sourceScope: evidence.sourceScope, causeCode: 'SOURCE_DEFINITION_UNAVAILABLE' } : undefined);
    }
  }
  if (globallyUnverified) for (const evidence of fields.values()) evidence.sharedWriteAllowed = false;
  // A shared field depending on a local override (or missing evidence) cannot be
  // copied safely on its own. Iterate so transitive dependencies and cycles agree.
  let changed = true;
  while (changed) {
    changed = false;
    for (const evidence of fields.values()) {
      if (evidence.sharedWriteAllowed && evidence.dependencies.some((reference) => !fields.get(reference)?.sharedWriteAllowed)) {
        evidence.sharedWriteAllowed = false;
        changed = true;
      }
    }
  }
  result.fields = [...fields.values()].sort((left, right) => left.reference.localeCompare(right.reference));
  result.requiredSharedFiles = [...sharedRequired].sort();
  result.requiredWorkbookFiles = [...workbookRequired].sort();
  result.blockedSharedWriteReferences = result.fields.filter((field) => !field.sharedWriteAllowed).map((field) => field.reference);
  return result;
}
