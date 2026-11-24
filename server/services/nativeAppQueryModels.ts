import { isDeepStrictEqual } from 'node:util';
import { parseDocument, stringify } from 'yaml';
import { z } from 'zod';
import { isEmptyModelExtensionRoot } from './modelExtensionYaml';

type Files = Record<string, string>;
export type QueryFiles = Record<string, Files>;
export type AppRead = (path: string, task: string) => Promise<unknown>;
export type AppWrite = (method: string, path: string, body?: unknown) => Promise<unknown>;
type Fields = Record<string, unknown>;
interface EffectiveView { viewName: string; renamedFrom: string | null; physical: Fields; fields: Record<string, Fields> }
interface QueryFileEvidence { editable: EffectiveView; resolved: EffectiveView }
export type QueryEvidence = Record<string, Record<string, QueryFileEvidence>>;

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class CopyError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

export function requireState(condition: unknown, message: string): asserts condition {
  if (!condition) throw new CopyError(422, message);
}

export function readExtension(read: AppRead, id: string) {
  return read('/api/v1/models/' + id + '/yaml?mode=extension&fullyResolved=false&includeChecksums=true', 'Read extension YAML')
    .then(result => {
      requireState(record(result) && record(result.files)
        && Object.values(result.files).every(yaml => typeof yaml === 'string'), 'Extension YAML is unavailable.');
      return { files: result.files as Files, checksums: record(result.checksums) ? result.checksums : {} };
    });
}

function fieldDefinitions(yaml: string) {
  requireState(Buffer.byteLength(yaml) <= 256 * 1024, 'A query-local file exceeds 256 KiB.');
  const document = parseDocument(yaml);
  requireState(!document.errors.length && !document.warnings.length, 'A query-local YAML file could not be parsed.');
  try {
    return document.toJS({ maxAliasCount: 50 });
  } catch {
    throw new CopyError(422, 'A query-local YAML file contains unsupported aliases.');
  }
}

const policyKeys = new Set(['access_grants', 'required_access_grants', 'access_filters', 'access_boost', 'row_access_policy']);

function containsPolicy(value: unknown, seen = new WeakSet<object>()): boolean {
  if (value === null || typeof value !== 'object' || seen.has(value)) return false;
  seen.add(value);
  return Object.entries(value).some(([key, child]) => policyKeys.has(key) || containsPolicy(child, seen));
}

export function portableFiles(files: Files): Files {
  const result: Files = {};
  for (const [name, yaml] of Object.entries(files)) {
    const value: unknown = fieldDefinitions(yaml);
    if (isEmptyModelExtensionRoot(name, value)) continue;
    requireState(/^[\w-][\w.-]*\.view$/.test(name) && !name.includes('..') && record(value)
      && (record(value.dimensions) || record(value.measures)) && !containsPolicy(value)
      && Object.entries(value).every(([key, fields]) => key === 'ignored_props'
        ? isDeepStrictEqual(fields, { renamed_from: true }) : ['dimensions', 'measures'].includes(key) && record(fields)),
    'Only query-local view files containing dimensions or measures can be copied. Review other definitions before migration.');
    result[name] = yaml;
  }
  return result;
}

export function sameQueryFiles(actual: QueryFiles, expected: QueryFiles) {
  const normalize = (tabs: QueryFiles) => Object.fromEntries(Object.entries(tabs).map(([key, files]) => [
    key, Object.fromEntries(Object.entries(files).map(([name, yaml]) => [name, fieldDefinitions(yaml)])),
  ]));
  return isDeepStrictEqual(normalize(actual), normalize(expected));
}

function namedFields(root: Fields): Array<[string, string, Fields]> {
  const result: Array<[string, string, Fields]> = [];
  for (const group of ['dimensions', 'measures']) {
    const definitions = root[group];
    if (!record(definitions)) continue;
    for (const [name, value] of Object.entries(definitions)) {
      requireState(record(value) && !['__proto__', 'constructor', 'prototype'].includes(name), 'A query field definition is unsupported.');
      result.push([group, name, value]);
    }
  }
  return result;
}

function sourceMarkers(root: Fields) {
  const fields = namedFields(root);
  return fields.some(([, , field]) => field.ignored_props !== undefined) || root.ignored_props !== undefined;
}

function referenceHeader(yaml: string) {
  const headers = [...yaml.matchAll(/^[ \t]*#[ \t]*Reference this view as (\w+)[ \t]*$/gm)];
  requireState(headers.length <= 1, 'A query view has an ambiguous reference header.');
  return headers[0];
}

async function combinedFile(read: AppRead, id: string, name: string, resolved = false) {
  const params = new URLSearchParams({ mode: 'combined', fullyResolved: String(resolved), includeChecksums: String(!resolved),
    fileName: '^' + name.replaceAll('.', '\\.') + '$' });
  const data = await read('/api/v1/models/' + id + '/yaml?' + params, 'Read composed query view and its checksum');
  requireState(record(data) && record(data.files) && Object.keys(data.files).length === 1 && typeof data.files[name] === 'string',
    'The exact composed query view is unavailable.');
  const yaml = data.files[name];
  const header = referenceHeader(yaml);
  const viewName = (record(data.viewNames) ? data.viewNames[name] : undefined) ?? header?.[1];
  requireState(typeof viewName === 'string' && /^\w+$/.test(viewName) && (!header || header[1] === viewName),
    'The composed view reference is missing or differs from the model inventory.');
  const checksum = record(data.checksums) ? data.checksums[name] : undefined;
  requireState(resolved || typeof checksum === 'string' && checksum, 'The editable composed query view has no checksum.');
  const root: unknown = fieldDefinitions(yaml);
  requireState(record(root), 'The composed query view has an unsupported shape.');
  return { root, viewName, header: header?.[0], checksum: typeof checksum === 'string' ? checksum : '' };
}

function renderedRename(root: Fields): string | null {
  if (!Object.hasOwn(root, 'renamed_from')) return null;
  const alias = root.renamed_from;
  requireState(typeof alias === 'string' && alias.trim().length > 0, 'The composed view has an unsupported rename alias.');
  return alias;
}

function queryEvidence(view: Awaited<ReturnType<typeof combinedFile>>, names: Array<[string, string, Fields]>): EffectiveView {
  const fields: Record<string, Fields> = {};
  for (const [group, name] of names) {
    const entries = view.root[group];
    requireState(record(entries) && Object.hasOwn(entries, name) && record(entries[name]), 'An effective query field is unavailable.');
    (fields[group] ??= {})[name] = entries[name];
  }
  const physical = Object.fromEntries(Object.entries(view.root).filter(([key]) =>
    ['table_name', 'sql_table_name', 'schema', 'catalog', 'database', 'sql', 'query'].includes(key)));
  return { viewName: view.viewName, renamedFrom: renderedRename(view.root), fields, physical };
}

export async function readQueryIntentEvidence(read: AppRead, id: string, files: Files) {
  const result: Record<string, QueryFileEvidence> = {};
  for (const [name, yaml] of Object.entries(files)) {
    const authored: Fields = fieldDefinitions(yaml);
    if (!sourceMarkers(authored)) continue;
    const [view, resolved] = await Promise.all([combinedFile(read, id, name), combinedFile(read, id, name, true)]);
    const header = referenceHeader(yaml);
    requireState(view.viewName === resolved.viewName && (!header || header[1] === view.viewName), 'The authored view reference differs from its effective model.');
    const fields = namedFields(authored);
    result[name] = { editable: queryEvidence(view, fields), resolved: queryEvidence(resolved, fields) };
  }
  return result;
}

// Model-only saves trigger a second Omni combined save, which can drop inherited
// property suppressions. Start with the destination composition and copy only
// approved local field properties. The child checksum guards the actual write.
async function prepareCombined(read: AppRead, parentId: string, childId: string | undefined, fileName: string, yaml: string, source: QueryFileEvidence) {
  const parent = await combinedFile(read, parentId, fileName);
  const child = childId ? await combinedFile(read, childId, fileName) : parent;
  requireState(parent.viewName === source.editable.viewName && child.viewName === source.editable.viewName, 'The query view references a different destination view.');
  const authored: Fields = fieldDefinitions(yaml);
  const root = structuredClone(child.root);
  const fields = namedFields(authored);
  if (authored.ignored_props !== undefined) requireState(isDeepStrictEqual(authored.ignored_props, { renamed_from: true }), 'A view suppression is unsupported.');
  const parentRename = renderedRename(parent.root);
  const childRename = renderedRename(child.root);
  requireState(childRename === null || childRename === parentRename, 'The destination query view has a conflicting rename alias.');
  if (authored.ignored_props || parentRename === null) delete root.renamed_from;
  else root.renamed_from = parentRename;
  for (const [group, name, field] of fields) {
    const definitions = root[group] ??= {};
    requireState(record(definitions), 'The destination field collection is unsupported.');
    const current = definitions[name] ?? {};
    requireState(record(current), 'The destination field is unsupported.');
    const merged = { ...current, ...field };
    if (field.ignored_props !== undefined) {
      requireState(group === 'measures' && isDeepStrictEqual(field.ignored_props, { filters: true }) && !Object.hasOwn(field, 'filters'),
        'An authored property suppression cannot be preserved by this copy.');
      delete merged.filters;
      delete merged.ignored_props;
    }
    definitions[name] = merged;
  }
  // Omni needs the parent alias in the payload to preserve inheritance, but a
  // child layer can omit that inherited alias when it renders editable YAML.
  const expectedCombined = { ...root };
  if (parentRename !== null && !authored.ignored_props && source.editable.renamedFrom === null) delete expectedCombined.renamed_from;
  const projected = queryEvidence({ ...child, root: expectedCombined }, fields);
  requireState(isDeepStrictEqual(projected, source.editable), 'The destination model cannot reproduce the approved effective query fields.');
  const payload = structuredClone(root);
  if (authored.ignored_props) payload.ignored_props = authored.ignored_props;
  for (const [group, name, field] of fields) {
    if (field.ignored_props !== undefined) ((payload[group] as Fields)[name] as Fields).ignored_props = field.ignored_props;
  }
  const encoded = (child.header ? child.header + '\n' : '') + stringify(payload);
  requireState(Buffer.byteLength(encoded) <= 256 * 1024, 'The composed query file exceeds the size limit.');
  return { yaml: encoded, checksum: child.checksum, expectedCombined, parentChecksum: parent.checksum };
}

export async function inspectNewQueryDestination(read: AppRead, modelId: string, byKey: QueryFiles, evidenceByKey: QueryEvidence) {
  const checksums: Record<string, Files> = {};
  for (const [key, files] of Object.entries(byKey)) {
    for (const [name, yaml] of Object.entries(files)) {
      if (!sourceMarkers(fieldDefinitions(yaml))) continue;
      const evidence = evidenceByKey[key]?.[name];
      requireState(evidence, 'Source query inheritance evidence is missing.');
      const projected = await prepareCombined(read, modelId, undefined, name, yaml, evidence);
      (checksums[key] ??= {})[name] = projected.parentChecksum;
    }
  }
  return checksums;
}

export async function modelMetadata(read: AppRead, id: string) {
  const response = await read('/api/v1/models?modelId=' + id, 'Read model ownership');
  requireState(record(response) && Array.isArray(response.records) && response.records.length === 1,
    'The saved profile cannot verify model ownership.');
  const model: unknown = response.records[0];
  requireState(record(model) && model.id === id && model.deletedAt === null
    && typeof model.connectionId === 'string' && z.uuid().safeParse(model.connectionId).success,
  'The model has no verified active connection.');
  return model;
}

export function requireQueryOwnership(model: Record<string, unknown>, workbook: string, connection: string) {
  requireState(model.modelKind === 'QUERY' && model.baseModelId === workbook && model.connectionId === connection,
    'The query model does not belong to the expected workbook and connection.');
}

export interface QueryRecoveryState {
  destinationModelId: string;
  draftWorkbookId: string;
  connectionId: string;
  bindings: Record<string, string>;
  queryModelIdsByKey: Record<string, string>;
  filesByKey: QueryFiles;
  checksumsByKey: Record<string, Files>;
  combinedChecksumsByKey: Record<string, Record<string, { child: string; parent: string }>>;
}

// Matching a partially saved orphan is different from declaring its YAML correct.
// Only these two observed changes may identify a file for *correction*. Final
// parity still compares every marker and authored field.
function fileState(actualYaml: string, approvedYaml: string): 'verified' | 'correction' | 'conflict' {
  const actual: unknown = fieldDefinitions(actualYaml);
  const approved: unknown = fieldDefinitions(approvedYaml);
  if (isDeepStrictEqual(actual, approved)) return 'verified';
  if (!record(actual) || !record(approved) || !record(actual.measures) || !record(approved.measures)) return 'conflict';
  if (approved.ignored_props === undefined && isDeepStrictEqual(actual.ignored_props, { renamed_from: true })) delete actual.ignored_props;
  for (const [name, measure] of Object.entries(approved.measures)) {
    const found = actual.measures[name];
    if (!record(measure) || !record(found) || !record(measure.ignored_props) || measure.ignored_props.filters !== true) continue;
    if (found.ignored_props === undefined) found.ignored_props = {};
    if (record(found.ignored_props) && found.ignored_props.filters === undefined) found.ignored_props.filters = true;
  }
  return isDeepStrictEqual(actual, approved) ? 'correction' : 'conflict';
}

function matchesApprovedFiles(actual: Files, approved: Files) {
  return Object.entries(actual).every(([name, yaml]) => Object.hasOwn(approved, name) && fileState(yaml, approved[name]) !== 'conflict');
}

async function activeQueryChildren(read: AppRead, workbook: string, connection: string): Promise<Set<string>> {
  const children = new Set<string>(), cursors = new Set<string>();
  const params = new URLSearchParams({ baseModelId: workbook, connectionId: connection, modelKind: 'QUERY', pageSize: '100' });
  let total: number | undefined;
  for (;;) {
    const page = await read('/api/v1/models?' + params, 'List active draft-owned query models');
    requireState(record(page) && Array.isArray(page.records) && record(page.pageInfo), 'The query model inventory is incomplete.');
    const info = page.pageInfo;
    requireState(typeof info.totalRecords === 'number' && Number.isSafeInteger(info.totalRecords) && info.totalRecords >= 0
      && info.totalRecords <= 48 && (total === undefined || total === info.totalRecords) && typeof info.hasNextPage === 'boolean',
    'The draft query model inventory is ambiguous, changed, or exceeds the workbook limit.');
    total = info.totalRecords;
    for (const item of page.records) {
      requireState(record(item) && typeof item.id === 'string' && z.uuid().safeParse(item.id).success
        && item.deletedAt === null && !children.has(item.id), 'The query model inventory contains an invalid or duplicate model.');
      requireQueryOwnership(item, workbook, connection);
      children.add(item.id);
    }
    if (!info.hasNextPage) {
      requireState(info.nextCursor === null && children.size === total, 'The draft query model inventory was truncated.');
      return children;
    }
    requireState(page.records.length > 0 && children.size < total && typeof info.nextCursor === 'string' && !!info.nextCursor
      && info.nextCursor.length <= 2048 && !cursors.has(info.nextCursor), 'The draft query model cursor is incomplete.');
    cursors.add(info.nextCursor);
    params.set('cursor', info.nextCursor);
  }
}

export async function inspectQueryRecovery(options: {
  read: AppRead; draftWorkbookId: string; destinationModelId: string; connectionId: string;
  bindings: Record<string, string>; byKey: QueryFiles; evidenceByKey?: QueryEvidence; queryModelIdsByKey?: Record<string, string>;
}): Promise<QueryRecoveryState> {
  const { read, draftWorkbookId, destinationModelId, connectionId, bindings, byKey, evidenceByKey = {}, queryModelIdsByKey = {} } = options;
  requireState([draftWorkbookId, destinationModelId, connectionId].every(id => z.uuid().safeParse(id).success)
    && draftWorkbookId !== destinationModelId, 'The recovery workbook or model identity is invalid.');
  const parent = await modelMetadata(read, draftWorkbookId);
  requireState(parent.modelKind === 'WORKBOOK' && parent.baseModelId === destinationModelId && parent.connectionId === connectionId,
    'The recovery draft workbook no longer belongs to the approved destination.');
  const children = await activeQueryChildren(read, draftWorkbookId, connectionId);
  const planned = { ...bindings, ...queryModelIdsByKey };
  for (const [key, id] of Object.entries(queryModelIdsByKey)) {
    requireState(byKey[key] && !bindings[key] && z.uuid().safeParse(id).success, 'A reconciled query model must belong to an unbound, requested tab.');
  }
  const ids = Object.values(planned);
  requireState(Object.keys(planned).every(key => /^[1-9][0-9]*$/.test(key))
    && new Set(ids).size === ids.length && ids.length === children.size && ids.every(id => children.has(id)),
  'The draft contains a missing, unbound, or unexpected query model. Reconcile each model to its exact tab before recovery.');
  const filesByKey: QueryFiles = {}, checksumsByKey: Record<string, Files> = {};
  for (const [key, id] of Object.entries(planned)) {
    const snapshot = await readExtension(read, id);
    const present = portableFiles(snapshot.files);
    const approved = byKey[key] ?? {};
    requireState(matchesApprovedFiles(present, approved), 'A destination query file conflicts with the approved source.');
    if (queryModelIdsByKey[key]) {
      const possible = Object.entries(byKey).filter(([other, files]) => !bindings[other] && matchesApprovedFiles(present, files));
      const identicalCandidates = Object.keys(approved).length === Object.keys(present).length
        && possible.every(([other, files]) => sameQueryFiles({ candidate: files }, { candidate: approved })
          && isDeepStrictEqual(evidenceByKey[other], evidenceByKey[key]));
      requireState(Object.values(present).some(yaml => namedFields(fieldDefinitions(yaml)).length > 0)
        && (possible.length === 1 || identicalCandidates),
        'The reconciled query model cannot be uniquely identified by its authored fields.');
    }
    filesByKey[key] = present;
    checksumsByKey[key] = {};
    for (const name of Object.keys(approved)) {
      if (Object.hasOwn(snapshot.files, name)) {
        const checksum = snapshot.checksums[name];
        requireState(typeof checksum === 'string' && !!checksum, 'A reviewed destination query file has no checksum.');
        checksumsByKey[key][name] = checksum;
      }
    }
  }
  const combinedChecksumsByKey: QueryRecoveryState['combinedChecksumsByKey'] = {};
  for (const [key, files] of Object.entries(byKey)) {
    for (const [name, yaml] of Object.entries(files)) {
      const actual = filesByKey[key]?.[name];
      const evidence = evidenceByKey[key]?.[name];
      requireState(!sourceMarkers(fieldDefinitions(yaml)) || evidence, 'Source query inheritance evidence is missing.');
      requireState(!actual || fileState(actual, yaml) !== 'correction' || evidence, 'The destination suppression needs reviewed source evidence.');
      if (!evidence) continue;
      const plan = await prepareCombined(read, draftWorkbookId, planned[key], name, yaml, evidence);
      (combinedChecksumsByKey[key] ??= {})[name] = { child: plan.checksum, parent: plan.parentChecksum };
    }
  }
  return { destinationModelId, draftWorkbookId, connectionId, bindings: { ...bindings },
    queryModelIdsByKey: { ...queryModelIdsByKey }, filesByKey, checksumsByKey, combinedChecksumsByKey };
}

export function requireQueryCopyRoutes(spec: unknown) {
  requireState(record(spec) && record(spec.paths), 'The destination API contract is unavailable for copying query models.');
  const routes = Object.entries(spec.paths).map(([path, methods]) => [
    path.replace(/^\/api\//, '/').replace(/\{[^/{}]+\}/g, ':id'), methods,
  ] as const);
  for (const [method, path] of [
    ['put', '/v2/documents/:id/draft/:id/queries/:id/query-model'], ['put', '/v2/documents/:id/draft/:id/app'],
    ['post', '/v1/models'], ['post', '/v1/models/:id/yaml'], ['get', '/v1/documents/:id/drafts'],
    ['patch', '/v2/documents/:id/draft'], ['post', '/v2/documents/:id/draft/publish'],
  ]) {
    requireState(routes.some(([actual, operations]) => actual === path && record(operations) && record(operations[method])),
      'The destination has not advertised the draft and query-model APIs needed to copy authored measures.');
  }
}

export async function restoreQueryFiles(options: {
  read: AppRead; write: AppWrite; draftPath: string; draftWorkbookId: string; connectionId: string;
  bindings: Record<string, string>; byKey: QueryFiles; evidenceByKey?: QueryEvidence; reviewedRecovery?: QueryRecoveryState;
  verifyBindings?: (expected: Record<string, string>) => Promise<void>;
}) {
  const { read, write, draftPath, draftWorkbookId, connectionId, bindings, byKey, reviewedRecovery, evidenceByKey = {} } = options;
  if (reviewedRecovery) {
    const inspected = await inspectQueryRecovery({ ...options, destinationModelId: reviewedRecovery.destinationModelId,
      queryModelIdsByKey: reviewedRecovery.queryModelIdsByKey });
    requireState(isDeepStrictEqual(inspected, reviewedRecovery), 'The reviewed query recovery changed. Preview it again.');
  }
  const reconciledIds = reviewedRecovery?.queryModelIdsByKey ?? {};
  const used = new Set([...Object.values(bindings), ...Object.values(reconciledIds)]);
  const expected = { ...bindings };
  for (const [key, approved] of Object.entries(byKey)) {
    let id = bindings[key] ?? reconciledIds[key];
    if (!id) {
      await options.verifyBindings?.(expected);
      if (reviewedRecovery) requireState(isDeepStrictEqual(await activeQueryChildren(read, draftWorkbookId, connectionId), used),
        'The destination draft query inventory changed before creation.');
      const response = await write('POST', '/api/v1/models', {
        modelKind: 'QUERY', baseModelId: draftWorkbookId, connectionId,
      });
      requireState(record(response) && response.success === true && record(response.model)
        && response.model.modelKind === 'QUERY' && typeof response.model.id === 'string'
        && z.uuid().safeParse(response.model.id).success && !used.has(response.model.id),
      'A dedicated destination query model could not be verified.');
      id = response.model.id;
      used.add(id);
    }
    requireState(id !== draftWorkbookId, 'The destination query binding is invalid.');
    requireQueryOwnership(await modelMetadata(read, id), draftWorkbookId, connectionId);
    const baseline = await readExtension(read, id);
    const baselineFiles = portableFiles(baseline.files);
    requireState(isDeepStrictEqual(baselineFiles, reviewedRecovery?.filesByKey[key] ?? {}), 'The destination query model already has unexpected authored definitions.');
    for (const [fileName, yaml] of Object.entries(approved)) {
      const fresh = await readExtension(read, id);
      const actual = portableFiles(fresh.files)[fileName];
      requireState(actual === baselineFiles[fileName], 'The destination query definition changed before the write.');
      if (actual && fileState(actual, yaml) === 'verified') continue;
      const evidence = evidenceByKey[key]?.[fileName];
      requireState(evidence || (!sourceMarkers(fieldDefinitions(yaml)) && !actual), 'A query suppression needs verified source evidence.');
      const combined = evidence && await prepareCombined(read, draftWorkbookId, id, fileName, yaml, evidence);
      const reviewed = reviewedRecovery?.combinedChecksumsByKey[key]?.[fileName];
      requireState(!reviewed || combined && combined.parentChecksum === reviewed.parent
        && (!reviewedRecovery?.filesByKey[key] || combined.checksum === reviewed.child),
      'The reviewed composed destination file has changed.');
      const existing = Object.hasOwn(fresh.files, fileName);
      const checksum = fresh.checksums[fileName];
      requireState(!existing || (typeof checksum === 'string' && checksum.length > 0), 'An existing file is missing its checksum.');
      requireState(!existing || checksum === baseline.checksums[fileName], 'The destination query file checksum changed.');
      requireQueryOwnership(await modelMetadata(read, id), draftWorkbookId, connectionId);
      const saved = await write('POST', '/api/v1/models/' + id + '/yaml', combined
        ? { fileName, yaml: combined.yaml, mode: 'combined', fullyResolved: false, previousChecksum: combined.checksum }
        : { fileName, yaml, mode: 'extension', ...(existing ? { previousChecksum: checksum } : {}) });
      requireState(record(saved) && saved.success === true && saved.fileName === fileName,
        'A destination query-local file write was unverified.');
      if (combined) {
        const readback = await combinedFile(read, id, fileName);
        requireState(readback.viewName === evidence.editable.viewName && isDeepStrictEqual(readback.root, combined.expectedCombined),
          'The composed destination query view differs after its scoped write.');
      }
    }
    const actual = portableFiles((await readExtension(read, id)).files);
    requireState(sameQueryFiles({ [key]: actual }, { [key]: approved }), 'The restored query-local files differ from the source.');
    requireState(isDeepStrictEqual(await readQueryIntentEvidence(read, id, actual), evidenceByKey[key] ?? {}),
      'The restored query fields differ from the source in the composed or fully resolved model.');
    if (!bindings[key]) {
      await options.verifyBindings?.(expected);
      const bound = await write('PUT', draftPath + '/queries/' + key + '/query-model', { queryModelId: id });
      requireState(record(bound) && bound.draftIdentifier === draftPath.split('/').at(-1)
        && bound.identifier === draftPath.split('/')[4], 'The query binding response identified a different draft.');
    }
    expected[key] = id;
  }
  return expected;
}
