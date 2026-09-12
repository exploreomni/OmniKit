import { parse } from 'yaml';
import { createHash } from 'node:crypto';
import type { DashboardDependencyFinding } from '../../shared/dashboardDeploymentPlan';
import { collectFieldReferences } from './modelMigration/helpers';

const PRESENTATION_KEYS = new Set(['label', 'description', 'group_label', 'hidden', 'format', 'value_format', 'tags', 'ai_context', 'folder', 'display_order', 'schema_label']);
const SECURITY_KEY = /access|user_attribute|always_where|default_filters|required_filter|filter_only|grant/;
function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
function semantic(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(semantic);
  if (!record(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().filter((key) => !PRESENTATION_KEYS.has(key)).map((key) => [key, semantic(value[key])]));
}
function equal(left: unknown, right: unknown) { return JSON.stringify(semantic(left)) === JSON.stringify(semantic(right)); }
function yamlRecord(text: string | undefined): Record<string, unknown> {
  const value: unknown = text ? parse(text, { maxAliasCount: 50 }) : {};
  if (!record(value)) throw new Error('Unsupported YAML document shape.');
  return value;
}
function formulaReferences(value: unknown): Set<string> {
  const refs = collectFieldReferences(value);
  const visit = (item: unknown) => {
    if (typeof item === 'string') for (const match of item.matchAll(/\$\{([A-Za-z_][\w/]*\.[A-Za-z_][\w]*)\}/g)) refs.add(match[1]);
    else if (Array.isArray(item)) item.forEach(visit);
    else if (record(item)) Object.values(item).forEach(visit);
  };
  visit(value);
  return refs;
}
function semanticFileName(file: string): string {
  return file.replace(/\.(query\.view|view|topic)$/, '');
}
class AmbiguousDependencyFile extends Error {
  constructor(readonly reference: string) { super('Multiple authored files match this dependency. Choose an explicit model mapping before deployment.'); }
}
/** Preserve authored paths; a basename is usable only when it identifies one file. */
function dependencyFile(files: Record<string, string>, reference: string, viewReference = false): string | undefined {
  if (!viewReference && Object.hasOwn(files, reference)) return reference;
  const name = viewReference ? reference : semanticFileName(reference);
  const suffix = viewReference || reference.endsWith('.view') ? '.view' : reference.endsWith('.topic') ? '.topic' : undefined;
  if (!suffix) return undefined;
  const candidates = Object.keys(files).filter((file) => {
    if (!file.endsWith(suffix)) return false;
    if (reference.endsWith('.query.view') && !file.endsWith('.query.view')) return false;
    const candidate = semanticFileName(file);
    return candidate === name || (!name.includes('/') && candidate.split('/').pop() === name);
  });
  if (candidates.length > 1) throw new AmbiguousDependencyFile(reference);
  return candidates[0];
}
export interface DashboardDependencyReadiness {
  findings: DashboardDependencyFinding[];
  requiredFiles: string[];
  unverified: boolean;
}

/** Supplemental closure over authored semantics, including ordinary-view joins.
 * Target-only fields/files and physical table locations are not equality requirements.
 * Unknown source shapes fail closed instead of claiming production equivalence. */
export function inspectDashboardDependencyReadiness(input: {
  sourceFiles: Record<string, string>;
  targetFiles: Record<string, string>;
  states: unknown[];
  documentIds: string[];
  seedFiles?: string[];
  fileMappings?: Record<string, string>;
  /** Verified document-local definitions. Never compare or repair these in the shared destination. */
  workbookFields?: Record<string, { sourceFileName: string; definition: unknown }>;
  /** References already classified against the authored source inventories. */
  fieldDependencies?: Record<string, string[]>;
}): DashboardDependencyReadiness {
  const findings: DashboardDependencyFinding[] = [];
  const required = new Set<string>();
  const fileMappings: Record<string, string> = {};
  const targetNames = new Map<string, string | undefined>();
  let unverified = false;
  const add = (kind: DashboardDependencyFinding['kind'], reference: string, message: string, file?: string,
    category: DashboardDependencyFinding['category'] = kind === 'security' || kind === 'document' ? 'cannot_verify' : 'model_migrator',
    causeCode?: string, rootCauseId?: string) => {
    findings.push({ id: createHash('sha256').update(`${kind}:${reference}:${message}`).digest('hex').slice(0, 20), kind, reference, message,
      documentIds: input.documentIds, sourceFileName: file, targetFileName: file ? targetNames.get(file) || fileMappings[file] || file : undefined,
      category, sourceScope: 'shared', causeCode, rootCauseId });
  };
  const source = new Map<string, Record<string, unknown>>();
  const target = new Map<string, Record<string, unknown>>();
  const normalizeTarget = (value: unknown): unknown => {
    if (typeof value === 'string') {
      let text = value;
      for (const [fromFile, toFile] of Object.entries(input.fileMappings || {})) {
        const from = semanticFileName(fromFile);
        const to = semanticFileName(toFile);
        text = text === to ? from : text.replaceAll(`${to}.`, `${from}.`);
      }
      return text;
    }
    if (Array.isArray(value)) return value.map(normalizeTarget);
    if (record(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalizeTarget(item)]));
    return value;
  };
  const targetFile = (file: string) => {
    if (!targetNames.has(file)) {
      const mapped = fileMappings[file];
      targetNames.set(file, dependencyFile(input.targetFiles, mapped || file)
        || (!mapped && file.endsWith('.view') ? dependencyFile(input.targetFiles, semanticFileName(file).split('/').pop()!, true) : undefined));
    }
    return targetNames.get(file);
  };
  const load = (file: string, side: 'source' | 'target') => {
    const cache = side === 'source' ? source : target;
    if (!cache.has(file)) {
      const destinationFile = side === 'target' ? targetFile(file) : undefined;
      const value = yamlRecord(side === 'source' ? input.sourceFiles[file] : destinationFile ? input.targetFiles[destinationFile] : undefined);
      cache.set(file, side === 'source' ? value : normalizeTarget(value) as Record<string, unknown>);
    }
    return cache.get(file)!;
  };
  const pending = [...new Set(input.states.flatMap((state) => [...formulaReferences(state)]))];
  const seen = new Set<string>();
  const views = new Set<string>();
  const checkedViewSettings = new Set<string>();
  const explicitlyBlank = input.states.length > 0 && input.states.every((state) => {
    if (!record(state) || !record(state.queryPresentations)) return false;
    const { data, order } = state.queryPresentations;
    return record(data) && Array.isArray(order) && order.length === Object.keys(data).length
      && new Set(order).size === order.length
      && order.every((key) => typeof key === 'string' && record(data[key]) && data[key].type === 'blank' && !data[key].query);
  });
  if (explicitlyBlank && !pending.length && !input.seedFiles?.length) return { findings: [], requiredFiles: [], unverified: false };
  try {
    for (const [from, to] of Object.entries(input.fileMappings || {})) {
      fileMappings[dependencyFile(input.sourceFiles, from) || from] = to;
    }
    for (const file of input.seedFiles || []) required.add(dependencyFile(input.sourceFiles, file) || file);
    const inspectViewSettings = (view: string, file: string, original: Record<string, unknown>, destination: Record<string, unknown>) => {
      if (checkedViewSettings.has(file)) return;
      checkedViewSettings.add(file);
      const viewKeys = new Set([...Object.keys(original), ...Object.keys(destination).filter((key) => SECURITY_KEY.test(key))]);
      for (const key of [...viewKeys].filter((key) => !['dimensions', 'measures', 'sql_table_name', 'schema', 'database', 'catalog'].includes(key) && !PRESENTATION_KEYS.has(key))) {
        if (!equal(original[key], destination[key])) {
          const security = SECURITY_KEY.test(key);
          unverified ||= security;
          add(security ? 'security' : 'view', `${view}.${key}`, security
            ? 'A security-sensitive view setting differs and requires explicit review.'
            : 'A required view setting differs from the source.', file, security ? 'cannot_verify' : 'model_migrator',
          security ? 'SECURITY_SETTING_DIFFERS' : 'VIEW_SETTING_DIFFERS',
          security || targetFile(file) ? `view_setting:${file}:${key}` : `destination_view_missing:${file}`);
        }
        for (const ref of formulaReferences(original[key])) if (!seen.has(ref)) pending.push(ref);
      }
    };
    const visitFields = () => { while (pending.length) {
      const reference = pending.shift()!;
      if (seen.has(reference)) continue;
      if (seen.size >= 5_000) throw new Error('Dependency limit exceeded.');
      seen.add(reference);
      const dot = reference.lastIndexOf('.');
      const view = reference.slice(0, dot);
      const field = reference.slice(dot + 1).replace(/\[.*$/, '');
      const local = input.workbookFields?.[reference.toLowerCase()];
      const file = dependencyFile(input.sourceFiles, view, true);
      views.add(view);
      if (local) {
        findings.push({ id: createHash('sha256').update(`workbook:${reference}:${input.documentIds.join(',')}`).digest('hex').slice(0, 20),
          kind: 'field', reference, message: 'This calculation is authored in the dashboard’s workbook, not its shared model. It needs a verified workbook-copy path; this finding does not confirm it has been copied.',
          documentIds: input.documentIds, sourceFileName: local.sourceFileName,
          category: 'included_with_dashboard', sourceScope: 'workbook', causeCode: 'WORKBOOK_FIELD_IDENTIFIED', rootCauseId: `workbook_definitions:${input.documentIds.join(',')}` });
        for (const ref of input.fieldDependencies?.[reference.toLowerCase()] || formulaReferences(local.definition)) if (!seen.has(ref)) pending.push(ref);
      }
      if (!file) {
        if (local) continue;
        unverified = true;
        add('field', reference, 'The authored source definition could not be located. This does not prove the field is absent; review the source model, workbook-local or inherited semantics.', undefined, 'cannot_verify', 'SOURCE_DEFINITION_UNAVAILABLE', `source_view_unavailable:${view}`);
        continue;
      }
      required.add(file);
      const original = load(file, 'source');
      const destination = load(file, 'target');
      const sourceSection = ['dimensions', 'measures'].find((key) => record(original[key]) && field in original[key]);
      if (!sourceSection && !local) {
        unverified = true;
        add('field', reference, 'This field cannot be traced to an authored source definition.', file, 'cannot_verify', 'SOURCE_DEFINITION_UNAVAILABLE', `source_field_unavailable:${reference}`);
        continue;
      }
      const definition = local ? local.definition : (original[sourceSection!] as Record<string, unknown>)[field];
      const destinationDefinition = sourceSection && record(destination[sourceSection]) ? destination[sourceSection][field] : undefined;
      if (!local && !equal(definition, destinationDefinition)) add('field', reference, 'The required field is missing or has different authored semantics in the destination.', file,
        'model_migrator', 'DESTINATION_FIELD_DIFFERS', targetFile(file) ? `destination_field:${reference}` : `destination_view_missing:${file}`);
      for (const ref of input.fieldDependencies?.[reference.toLowerCase()] || formulaReferences(definition)) if (!seen.has(ref)) pending.push(ref);
      inspectViewSettings(view, file, original, destination);
    } };
    visitFields();
    // Relation macros identify a view, not a made-up field. Check those seeded
    // authored files even when the dashboard selects no individual field in it.
    for (const file of [...required].filter((name) => name.endsWith('.view'))) {
      if (!Object.hasOwn(input.sourceFiles, file)) {
        unverified = true;
        add('view', file, 'A required source relation could not be verified from authored YAML.', file,
          'cannot_verify', 'SOURCE_FILE_UNAVAILABLE', `source_file_unavailable:${file}`);
        continue;
      }
      const view = semanticFileName(file).split('/').pop()!;
      if (![...views].some((known) => dependencyFile(input.sourceFiles, known, true) === file)) views.add(view);
      if (!targetFile(file)) add('view', view, 'A required authored view is missing in the destination. Review this shared dependency in Model Migrator.', file,
        'model_migrator', 'DESTINATION_VIEW_MISSING', `destination_view_missing:${file}`);
      inspectViewSettings(view, file, load(file, 'source'), load(file, 'target'));
    }
    visitFields();
    // Topics selected by the authoritative planner seed this closure. Inspect
    // semantic properties, not unrelated files elsewhere in the model.
    for (const file of [...required].filter((name) => !name.endsWith('.view') && name !== 'relationships' && name !== 'model')) {
      if (!(file in input.sourceFiles)) {
        unverified = true;
        add(file.endsWith('.topic') ? 'topic' : 'model', file,
          file.endsWith('.topic') ? 'The dashboard’s exact source topic could not be found in the authored model. Resolve its source binding in Omni; choosing a destination topic cannot repair that source identity.' : 'A required source file could not be read.',
          file, 'cannot_verify', 'SOURCE_FILE_UNAVAILABLE', `source_file_unavailable:${file}`);
      } else if (!equal(load(file, 'source'), load(file, 'target'))) {
        add(file.endsWith('.topic') ? 'topic' : 'model', file, 'The required file has missing or different semantic settings.', file);
      }
    }
    if (views.size > 1 && input.sourceFiles.relationships) {
      const original: unknown = parse(input.sourceFiles.relationships, { maxAliasCount: 50 });
      const destination: unknown = input.targetFiles.relationships ? normalizeTarget(parse(input.targetFiles.relationships, { maxAliasCount: 50 })) : [];
      if (!Array.isArray(original) || !Array.isArray(destination)) throw new Error('Unsupported relationships shape.');
      // Follow paths between referenced views, including intermediate joins,
      // without demanding equality of unrelated model relationships.
      const edges = original.map((edge) => {
        if (!record(edge) || typeof edge.join_from_view !== 'string' || typeof edge.join_to_view !== 'string') throw new Error('Unsupported relationship edge.');
        return edge;
      });
      const needed = new Set<number>();
      const terminals = [...views];
      for (const terminal of terminals.slice(1)) {
        const paths = new Map<string, number[]>([[terminals[0], []]]);
        const ways = new Map<string, number>([[terminals[0], 1]]);
        const queue = [terminals[0]];
        while (queue.length) {
          const from = queue.shift()!;
          edges.forEach((edge, index) => {
            const to = edge.join_from_view === from ? edge.join_to_view : edge.join_to_view === from ? edge.join_from_view : undefined;
            if (typeof to !== 'string') return;
            const nextPath = [...paths.get(from)!, index];
            if (!paths.has(to)) { paths.set(to, nextPath); ways.set(to, ways.get(from) || 1); queue.push(to); }
            else if (paths.get(to)!.length === nextPath.length) ways.set(to, (ways.get(to) || 1) + (ways.get(from) || 1));
          });
        }
        if ((ways.get(terminal) || 0) > 1) {
          unverified = true;
          add('relationship', terminal, 'Multiple join paths require explicit review; readiness cannot choose one automatically.', 'relationships', 'cannot_verify');
        }
        for (const index of paths.get(terminal) || []) needed.add(index);
      }
      if (needed.size) required.add('relationships');
      for (const edge of [...needed].map((index) => edges[index])) {
        const match = destination.find((item) => record(item) && item.join_from_view === edge.join_from_view && item.join_to_view === edge.join_to_view && item.join_from_field === edge.join_from_field && item.join_to_field === edge.join_to_field);
        if (!equal(edge, match)) add('relationship', `${edge.join_from_view} → ${edge.join_to_view}`, 'A source join path is missing or differs in the destination.', 'relationships');
        for (const ref of formulaReferences(edge)) if (!seen.has(ref)) pending.push(ref);
        for (const [viewKey, fieldKey] of [['join_from_view', 'join_from_field'], ['join_to_view', 'join_to_field']]) {
          const view = String(edge[viewKey]);
          const file = dependencyFile(input.sourceFiles, view, true);
          if (file) required.add(file);
          else {
            unverified = true;
            add('view', view, 'The authored source join definition could not be located. Review inherited or workbook-local semantics before preparing a repair.', undefined, 'cannot_verify');
          }
          if (typeof edge[fieldKey] === 'string') pending.push(`${view}.${edge[fieldKey]}`);
          if (file && !targetFile(file)) add('view', view, 'The authored definition for a required join view could not be located in the destination.', file,
            'model_migrator', 'DESTINATION_VIEW_MISSING', `destination_view_missing:${file}`);
        }
      }
      visitFields();
    }
    if (input.sourceFiles.model || input.targetFiles.model) {
      const original = load('model', 'source');
      const destination = load('model', 'target');
      const keys = new Set([...Object.keys(original), ...Object.keys(destination)].filter((key) => /timezone|fiscal|week_start|week_start_day|access|user_attribute|always_where|required_filter|grant/.test(key)));
      if (keys.size) required.add('model');
      for (const key of keys) if (!equal(original[key], destination[key])) {
        const security = SECURITY_KEY.test(key);
        unverified ||= security;
        add(security ? 'security' : 'model', key, 'A model-level calculation or security setting differs and must be reviewed.', 'model');
      }
    }
    if (!seen.size && !required.size) {
      unverified = true;
      add('document', 'dependency_coverage', 'No authoritative semantic dependency coverage could be established for this dashboard.');
    }
    if (findings.some((item) => item.category !== 'included_with_dashboard') && [...required].some((file) => targetFile(file) && targetFile(file) !== file)) {
      unverified = true;
      add('model', 'mapped_repair_scope', 'Required files use different authored paths. Review their mapping in Model Migrator before preparing a repair.');
    }
  } catch (error) {
    unverified = true;
    add('model', error instanceof AmbiguousDependencyFile ? error.reference : 'dependency_coverage', error instanceof AmbiguousDependencyFile
      ? error.message : 'Dependency inspection encountered unsupported or incomplete YAML. Resolve this before deployment.', undefined, 'cannot_verify');
  }
  return { findings: [...new Map(findings.map((finding) => [finding.id, finding])).values()], requiredFiles: [...required].sort(), unverified };
}
