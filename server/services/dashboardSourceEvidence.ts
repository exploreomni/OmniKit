import { parse } from 'yaml';

export type DashboardSourceFieldProvenance =
  | 'shared_authored' | 'workbook_local' | 'workbook_override' | 'inherited_unverified' | 'unverified';

export interface DashboardSourceFieldEvidence {
  reference: string;
  provenance: DashboardSourceFieldProvenance;
  sourceModelId?: string;
  sourceFileName?: string;
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
  findings: Array<{ reference: string; message: string; sourceFileName?: string }>;
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
  const add = (reference: string, message: string, sourceFileName?: string, unverified = true) => {
    result.findings.push({ reference, message, ...(sourceFileName ? { sourceFileName } : {}) });
    result.unverified ||= unverified;
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
        : 'Authored shared-model YAML could not be verified.');
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
  const parsed = new Map<string, Record<string, unknown>>();
  const load = (file: string | undefined, workbook: boolean): Record<string, unknown> => {
    if (!file) return {};
    const key = `${workbook ? 'workbook' : 'shared'}:${file}`;
    if (!parsed.has(key)) {
      const text = (workbook ? result.workbookFiles : result.sharedFiles)[file];
      const value: unknown = text.trim() ? parse(text, { maxAliasCount: 50 }) : {};
      if (!record(value)) throw new Error('Unsupported source YAML root.');
      parsed.set(key, value);
    }
    return parsed.get(key)!;
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
      const value = load(file, true);
      const unsupported = file.endsWith('.view')
        ? Object.keys(value).filter((key) => !['dimensions', 'measures'].includes(key) && !presentation(key, value[key]))
        : Object.keys(value);
      for (const section of ['dimensions', 'measures']) {
        if (value[section] !== undefined && !record(value[section])) unsupported.push(section);
      }
      if (unsupported.length) add('workbook_overlay', `Workbook-local properties require explicit preservation: ${[...new Set(unsupported)].sort().join(', ')}. Shared-model proposals are withheld.`, file);
    } catch {
      add('workbook_overlay', 'Workbook-local YAML cannot be interpreted safely; explicit preservation review is required and shared-model proposals are withheld.', file);
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
      const shared = fieldDefinition(sharedView, field);
      const workbook = fieldDefinition(workbookView, field);
      if (workbook && workbookFile) {
        evidence.provenance = shared ? 'workbook_override' : 'workbook_local';
        evidence.sourceModelId = input.workbookModelId;
        evidence.sourceFileName = workbookFile;
        evidence.definition = shared ? overlayDefinition(shared.definition, workbook.definition) : workbook.definition;
        workbookRequired.add(workbookFile);
        add(reference, shared
          ? 'A workbook-local override must be preserved in the workbook; it cannot become a shared-model repair.'
          : 'A workbook-local field must be preserved in the workbook; it cannot become a shared-model repair.', workbookFile, false);
      } else if (shared && sharedFile) {
        evidence.provenance = 'shared_authored';
        evidence.sourceModelId = input.sharedModelId;
        evidence.sourceFileName = sharedFile;
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
    } catch {
      evidence.provenance = 'unverified';
      evidence.sharedWriteAllowed = false;
      add(reference, 'The authored source field is ambiguous or unsupported and cannot authorize a shared-model repair.');
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
