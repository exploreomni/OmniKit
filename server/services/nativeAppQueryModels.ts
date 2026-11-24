import { isDeepStrictEqual } from 'node:util';
import { parseDocument } from 'yaml';
import { z } from 'zod';

type Files = Record<string, string>;
export type QueryFiles = Record<string, Files>;
export type AppRead = (path: string, task: string) => Promise<unknown>;
export type AppWrite = (method: string, path: string, body?: unknown) => Promise<unknown>;

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
    if (value == null || (record(value) && !Object.keys(value).length)) continue;
    requireState(/^[\w-][\w.-]*\.view$/.test(name) && !name.includes('..') && record(value) && !containsPolicy(value)
      && Object.entries(value).every(([key, fields]) => ['dimensions', 'measures'].includes(key) && record(fields)),
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
  bindings: Record<string, string>; byKey: QueryFiles;
}) {
  const { read, write, draftPath, draftWorkbookId, connectionId, bindings, byKey } = options;
  const used = new Set(Object.values(bindings));
  const expected = { ...bindings };
  for (const [key, approved] of Object.entries(byKey)) {
    let id = bindings[key];
    if (!id) {
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
    requireState(!Object.keys(portableFiles(baseline.files)).length, 'The destination query model already has authored definitions.');
    for (const [fileName, yaml] of Object.entries(approved)) {
      const existing = Object.hasOwn(baseline.files, fileName);
      const checksum = baseline.checksums[fileName];
      requireState(!existing || (typeof checksum === 'string' && checksum.length > 0), 'An existing file is missing its checksum.');
      const saved = await write('POST', '/api/v1/models/' + id + '/yaml', {
        fileName, yaml, mode: 'extension', ...(existing ? { previousChecksum: checksum } : {}),
      });
      requireState(record(saved) && saved.success === true && saved.fileName === fileName,
        'A destination query-local file write was unverified.');
    }
    const actual = portableFiles((await readExtension(read, id)).files);
    requireState(sameQueryFiles({ [key]: actual }, { [key]: approved }), 'The restored query-local files differ from the source.');
    if (!bindings[key]) {
      const bound = await write('PUT', draftPath + '/queries/' + key + '/query-model', { queryModelId: id });
      requireState(record(bound) && bound.draftIdentifier === draftPath.split('/').at(-1)
        && bound.identifier === draftPath.split('/')[4], 'The query binding response identified a different draft.');
    }
    expected[key] = id;
  }
  return expected;
}
