import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';

import { jsonHeaders } from '../security';
import { dashboardWorkbookHasAuthoredDefinitions } from '../services/dashboardWorkbookCopy';
import { getInstance, VAULT_SESSION_ABORT_SIGNAL, type SavedInstance } from '../services/nativeVault';
import { requestOmniJson } from '../services/omniJsonTransport';
import {
  CopyError, modelMetadata, portableFiles, readExtension, record, requireQueryCopyRoutes,
  requireState, restoreQueryFiles, sameQueryFiles, type QueryFiles,
} from '../services/nativeAppQueryModels';

const documentIdentifier = z.string().regex(/^[a-z0-9_-]{2,48}$/i);
const copyInput = z.object({
  action: z.enum(['preview', 'apply']),
  sourceInstanceId: z.string().min(1).max(255),
  destinationInstanceId: z.string().min(1).max(255),
  sourceIdentifier: documentIdentifier,
  destinationIdentifier: documentIdentifier,
  destinationModelId: z.uuid(),
  destinationFolderId: z.uuid().optional(),
  previewDigest: z.string().regex(/^[0-9a-f]{64}$/).optional(),
}).strict();

const MAX_APP_HTML_BYTES = 2 * 1024 * 1024;
const MAX_READ_BYTES = 16 * 1024 * 1024;

function digest(value: unknown): string {
  // Sort object keys for comparisons between independent API reads. Array order carries meaning.
  const canonical = JSON.stringify(value, (_key, item: unknown) =>
    record(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
  return createHash('sha256').update(canonical).digest('hex');
}

function appContent(doc: unknown, app: unknown, identifier: string, path: string, draft: boolean) {
  requireState(record(doc) && (!doc.draftOf || (draft && record(doc.draftOf) && doc.draftOf.identifier === identifier))
    && record(doc.app) && doc.app.url === path + '/app',
    'Select a published native App using its current identifier.');
  requireState(!('containers' in doc) && typeof doc.name === 'string' && doc.name.trim()
    && (typeof doc.description === 'string' || doc.description == null),
  'The source document metadata is incomplete or includes a dashboard.');
  requireState(typeof doc.modelId === 'string' && typeof doc.workbookModelId === 'string'
    && z.uuid().safeParse(doc.modelId).success && z.uuid().safeParse(doc.workbookModelId).success
    && doc.modelId !== doc.workbookModelId, 'The published workbook model binding could not be verified.');
  requireState(record(app) && typeof app.html === 'string' && app.html.trim()
    && Buffer.byteLength(app.html) <= MAX_APP_HTML_BYTES && record(app.settings),
  'The App must have published HTML within the 2 MiB create limit and readable sandbox settings.');

  if (doc.controls !== undefined) {
    const controls = doc.controls;
    requireState(record(controls) && record(controls.data) && Object.keys(controls.data).length === 0
      && Array.isArray(controls.order) && controls.order.length === 0,
    'This App has document controls that cannot be transferred with a single App create.');
  }
  const presentations = doc.queryPresentations;
  requireState(record(presentations) && record(presentations.data) && Array.isArray(presentations.order),
    'The published workbook does not expose a complete tab collection.');
  const data = presentations.data;
  const order: unknown[] = presentations.order;
  requireState(order.length > 0 && order.length <= 48 && Object.keys(data).length === order.length
    && new Set(order).size === order.length && order.every(key => typeof key === 'string'
      && /^[1-9][0-9]*$/.test(key) && Object.hasOwn(data, key)),
  'Workbook tab keys or order are incomplete, or exceed the 48-tab create limit.');

  const bindings: Record<string, string> = {};
  const tabs = Object.fromEntries(Object.entries(data).map(([key, value]) => {
    requireState(record(value) && ['blank', 'query', 'sql', 'linked'].includes(String(value.type))
      && !value.fileUploadId && !value.foreignModelId && !value.miniUuid,
    'A tab needs a separate upload, model, or unsupported workbook resource.');
    requireState(value.name == null || typeof value.name === 'string', 'A workbook tab has an invalid name.');
    if (value.type === 'linked' || value.sourceQueryPresentationKey != null) {
      requireState(typeof value.sourceQueryPresentationKey === 'string' && Object.hasOwn(data, value.sourceQueryPresentationKey),
        'A linked tab references a query outside this workbook.');
    }
    const tab = { ...value };
    const query = record(tab.query) ? { ...tab.query } : undefined;
    for (const target of [tab, ...(query ? [query] : [])]) {
      requireState(target.modelId == null || target.modelId === doc.modelId || target.modelId === doc.workbookModelId,
        'A tab uses a separate execution model. Map that dependency before copying the App.');
      const extension = target.model_extension_id;
      if (extension != null && extension !== doc.modelId && extension !== doc.workbookModelId) {
        requireState(typeof extension === 'string' && z.uuid().safeParse(extension).success
          && value.type !== 'linked' && value.sourceQueryPresentationKey == null,
        'The document contains an unrecognized query model binding.');
        requireState(!bindings[key] || bindings[key] === extension, 'A query has conflicting model bindings.');
        bindings[key] = extension;
      }
      delete target.modelId;
      delete target.model_extension_id;
    }
    if (query) tab.query = query;
    return [key, tab];
  }));
  requireState(new Set(Object.values(bindings)).size === Object.keys(bindings).length,
    'Two independent queries share a query model. Resolve the ambiguous binding before migration.');
  return {
    sourceModelId: doc.modelId,
    workbookModelId: doc.workbookModelId,
    bindings,
    name: doc.name,
    description: doc.description ?? null,
    app: { html: app.html, settings: app.settings },
    queryPresentations: { data: tabs, order },
  };
}

export async function handleNativeAppCopy(req: Request, dependencies: {
  profile?: typeof getInstance;
  request?: typeof requestOmniJson;
} = {}): Promise<Response> {
  const json = (data: unknown, status = 200) => Response.json(data, { status, headers: jsonHeaders });
  if (req.method !== 'POST') return json({ error: 'Use POST.' }, 405);
  if (new URL(req.url).pathname !== '/api/native-app-copy') return json({ error: 'Unknown App copy route.' }, 404);
  const parsed = copyInput.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return json({ error: 'Provide valid saved profile IDs, document identifiers, and a destination model UUID.' }, 400);
  const { action, previewDigest, ...scope } = parsed.data;
  if (action === 'apply' && !previewDigest) return json({ error: 'Preview the App copy before applying it.' }, 400);

  let dispatched = false;
  let recoveryDraft: string | undefined;
  let stage = 'creating the destination';
  try {
    const profile = dependencies.profile ?? getInstance;
    const source = profile(scope.sourceInstanceId);
    const destination = profile(scope.destinationInstanceId);
    if (!source || !destination) throw new CopyError(404, 'One of the saved profiles could not be found.');
    if (source.role === 'destination' || destination.role === 'source') {
      throw new CopyError(403, 'The saved profile roles must allow source reads and destination writes.');
    }
    const sourcePath = '/api/v2/documents/' + encodeURIComponent(scope.sourceIdentifier);
    const targetPath = '/api/v2/documents/' + encodeURIComponent(scope.destinationIdentifier);
    const signals = [req.signal, AbortSignal.timeout(action === 'apply' ? 240_000 : 90_000)];
    for (const instance of [source, destination]) {
      const session = instance[VAULT_SESSION_ABORT_SIGNAL];
      if (session) signals.push(session);
    }
    const signal = AbortSignal.any(signals);
    const request = dependencies.request ?? requestOmniJson;
    async function call(instance: SavedInstance, path: string, method = 'GET', body?: unknown) {
      signal.throwIfAborted();
      if (method !== 'GET') {
        for (const before of [source!, destination!]) {
          const current = profile(before.id);
          if (!current || current.baseUrl !== before.baseUrl || current.apiKey !== before.apiKey
            || current.updatedAt !== before.updatedAt || current.role !== before.role) {
            throw new CopyError(409, 'A saved profile changed. Preview again.');
          }
        }
        dispatched = true;
      }
      return request({
        method,
        url: new URL(path, instance.baseUrl).href,
        headers: { Authorization: 'Bearer ' + instance.apiKey, Accept: 'application/json', 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        maximumResponseBytes: MAX_READ_BYTES,
        signal,
      });
    }
    async function read(instance: SavedInstance, path: string, task: string) {
      const response = await call(instance, path);
      if (response.status !== 200) throw new CopyError(422, task + ' failed (HTTP ' + response.status + ').');
      return response.data;
    }
    async function readApp(instance: SavedInstance, path: string, identifier: string, draft = false) {
      const [doc, app] = await Promise.all([
        read(instance, path, 'Read published workbook'), read(instance, path + '/app', 'Read published native App'),
      ]);
      const copy = appContent(doc, app, identifier, path, draft);
      const get = (route: string, task: string) => read(instance, route, task);
      const workbook = await readExtension(get, copy.workbookModelId);
      requireState(!dashboardWorkbookHasAuthoredDefinitions(workbook.files),
        'Resolve workbook-local definitions before copying this App.');
      const byKey: QueryFiles = {};
      const entries = Object.entries(copy.bindings);
      let size = 0, count = 0;
      for (let start = 0; start < entries.length; start += 4) {
        await Promise.all(entries.slice(start, start + 4).map(async ([key, modelId]) => {
          const files = portableFiles((await readExtension(get, modelId)).files);
          if (!Object.keys(files).length) return;
          count += Object.keys(files).length;
          size += Object.values(files).reduce((n, yaml) => n + Buffer.byteLength(yaml), 0);
          requireState(count <= 48 && size <= 2 * 1024 * 1024, 'Query-local YAML exceeds the 48-file or 2 MiB copy limit.');
          const metadata = await modelMetadata(get, modelId);
          requireState(metadata.modelKind === 'QUERY' && metadata.baseModelId === copy.workbookModelId,
            'The authored query model is not owned by this workbook.');
          byKey[key] = files;
        }));
      }
      return { ...copy, byKey };
    }

    const copy = await readApp(source, sourcePath, scope.sourceIdentifier);
    const target = await call(destination, targetPath);
    if (target.status === 200) throw new CopyError(409, 'The destination identifier already exists. Inspect it before choosing a new identifier.');
    if (target.status !== 404) throw new CopyError(422, 'Could not check the destination identifier (HTTP ' + target.status + ').');

    const { sourceModelId, workbookModelId, bindings, byKey, ...content } = copy;
    const authored = Object.keys(byKey).length > 0;
    const targetRead = (path: string, task: string) => read(destination!, path, task);
    let connectionId = '';
    if (authored) {
      const spec = await request({ method: 'GET', url: new URL('/openapi.json', destination.baseUrl).href,
        headers: { Accept: 'application/json' }, maximumResponseBytes: MAX_READ_BYTES, signal });
      requireState(spec.status === 200, 'The destination API contract is unavailable for copying query models.');
      requireQueryCopyRoutes(spec.data);
      const model = await modelMetadata(targetRead, scope.destinationModelId);
      requireState(['SHARED', 'SHARED_EXTENSION'].includes(String(model.modelKind)), 'Select a destination shared workbook base.');
      connectionId = model.connectionId as string;
    }
    const body = {
      ...content,
      modelId: scope.destinationModelId,
      identifier: scope.destinationIdentifier,
      ...(scope.destinationFolderId ? { folderId: scope.destinationFolderId } : {}),
    };
    for (const instance of [source, destination]) {
      if (instance.apiKey && JSON.stringify([body, byKey]).includes(JSON.stringify(instance.apiKey).slice(1, -1))) {
        throw new CopyError(422, 'App content contains saved credential material and cannot be transferred.');
      }
    }
    const fingerprint = digest({ scope, sourceOrigin: source.baseUrl, destinationOrigin: destination.baseUrl,
      sourceProfileVersion: source.updatedAt, destinationProfileVersion: destination.updatedAt,
      sourceModelId, workbookModelId, bindings, byKey, connectionId, body });
    const details = {
      sourceIdentifier: scope.sourceIdentifier, destinationIdentifier: scope.destinationIdentifier,
      destinationModelId: scope.destinationModelId, destinationFolderId: scope.destinationFolderId ?? null,
      queryNames: copy.queryPresentations.order.map(key => copy.queryPresentations.data[String(key)].name),
      htmlBytes: Buffer.byteLength(copy.app.html), settings: copy.app.settings,
      queryModelCount: Object.keys(byKey).length,
      queryModelFileCount: Object.values(byKey).reduce((count, files) => count + Object.keys(files).length, 0),
    };
    if (action === 'preview') return json({ status: 'preview', previewDigest: fingerprint, ...details });
    if (previewDigest !== fingerprint) throw new CopyError(409, 'The App, profile, or destination changed. Preview again.');
    // The server-side unique identifier makes a repeated or concurrent POST create-only.
    // Never automatically resend an authenticated create after an ambiguous result.
    signal.throwIfAborted();
    const { app, ...workbookBody } = body;
    const created = await call(destination, '/api/v2/documents', 'POST', authored ? { ...workbookBody, containers: null } : body);
    if (created.status >= 400 && created.status < 500 && created.status !== 408) {
      dispatched = false;
      throw new CopyError(created.status, 'Omni declined the App creation (HTTP ' + created.status + '). Check destination permissions, identifiers, and model.');
    }
    requireState(created.status === 201 && record(created.data) && created.data.identifier === scope.destinationIdentifier,
      'The create response could not be verified.');
    const checkContent = (result: typeof copy) => requireState(result.sourceModelId === scope.destinationModelId
      && result.name === copy.name && result.description === copy.description && isDeepStrictEqual(result.app, copy.app)
      && isDeepStrictEqual(result.queryPresentations, copy.queryPresentations), 'App content differs from the approved source.');
    let warningCount = Array.isArray(created.data.warnings) ? created.data.warnings.length : 0;
    if (authored) {
      stage = 'preparing the new workbook draft';
      const write = async (method: string, path: string, payload?: unknown) => {
        const response = await call(destination!, path, method, payload);
        requireState(response.status === 200, 'The destination draft write was unverified.');
        return response.data;
      };
      const scaffold = await targetRead(targetPath, 'Read new destination workbook');
      requireState(record(scaffold) && !scaffold.app && !scaffold.containers && !scaffold.draftOf
        && scaffold.name === copy.name && scaffold.modelId === scope.destinationModelId && z.uuid().safeParse(scaffold.workbookModelId).success,
      'The new destination workbook could not be verified.');
      const draft = await write('PATCH', targetPath + '/draft', { summary: 'Copy reviewed App query models' });
      requireState(record(draft) && draft.identifier === scope.destinationIdentifier && typeof draft.draftIdentifier === 'string'
        && documentIdentifier.safeParse(draft.draftIdentifier).success && draft.draftIdentifier !== scope.destinationIdentifier,
      'The new destination draft could not be verified.');
      recoveryDraft = draft.draftIdentifier;
      const draftPath = targetPath + '/draft/' + recoveryDraft;
      const initial = await targetRead(draftPath, 'Read new destination draft');
      requireState(record(initial) && !initial.app && !initial.containers && initial.modelId === scope.destinationModelId
        && initial.name === copy.name && typeof initial.workbookModelId === 'string' && z.uuid().safeParse(initial.workbookModelId).success
        && initial.workbookModelId !== scaffold.workbookModelId && initial.workbookModelId !== scope.destinationModelId,
      'The named draft is not a new destination workbook.');
      const parent = await modelMetadata(targetRead, initial.workbookModelId);
      requireState(parent.modelKind === 'WORKBOOK' && parent.baseModelId === scope.destinationModelId && parent.connectionId === connectionId,
        'The draft workbook ownership could not be verified.');
      const attached = await write('PUT', draftPath + '/app', app);
      requireState(record(attached) && attached.identifier === scope.destinationIdentifier && attached.draftIdentifier === recoveryDraft,
        'The App attachment identified a different draft.');
      warningCount += Array.isArray(attached.warnings) ? attached.warnings.length : 0;
      const before = await readApp(destination, draftPath, scope.destinationIdentifier, true);
      checkContent(before);
      requireState(before.workbookModelId === initial.workbookModelId && !Object.keys(before.byKey).length,
        'The destination draft has unexpected authored content.');
      stage = 'restoring the draft query models';
      const expectedBindings = await restoreQueryFiles({
        read: targetRead, write, draftPath, draftWorkbookId: initial.workbookModelId, connectionId,
        bindings: before.bindings, byKey,
      });
      const reviewed = await readApp(destination, draftPath, scope.destinationIdentifier, true);
      checkContent(reviewed);
      requireState(reviewed.workbookModelId === initial.workbookModelId && isDeepStrictEqual(reviewed.bindings, expectedBindings)
        && sameQueryFiles(reviewed.byKey, byKey), 'Destination draft query model parity is unverified.');
      stage = 'verifying and publishing the main draft';
      const drafts = await targetRead('/api/v1/documents/' + scope.destinationIdentifier + '/drafts', 'Check main draft before publishing');
      const main = Array.isArray(drafts) ? drafts.filter(d => record(d) && d.branch === null && d.status === 'active') : [];
      requireState(main.length === 1 && main[0].identifier === recoveryDraft && main[0].publishedIdentifier === scope.destinationIdentifier
        && main[0].workbookModelId === initial.workbookModelId && main[0].draftOutOfDate === false,
      'The active main draft changed before publication.');
      const published = await write('POST', targetPath + '/draft/publish');
      requireState(record(published) && published.identifier === scope.destinationIdentifier, 'Publication was unverified.');
    }
    stage = 'verifying the published App';
    const published = await readApp(destination, targetPath, scope.destinationIdentifier);
    checkContent(published);
    requireState(sameQueryFiles(published.byKey, byKey), 'Published query model parity is unverified.');
    return json({ status: 'verified', ...details, warningCount, verification: 'published_app_and_query_definitions',
      warning: warningCount ? 'Omni returned App policy warnings. Review sandbox settings in the destination.' : undefined });
  } catch (error) {
    if (dispatched) return json({ error: 'Published parity is unverified. Inspect the destination and its draft before retrying.',
      stage, destinationIdentifier: scope.destinationIdentifier, draftIdentifier: recoveryDraft }, 502);
    if (error instanceof CopyError) return json({ error: error.message }, error.status);
    if ((error as { statusCode?: number })?.statusCode === 423) return json({ error: 'Unlock the native vault before copying an App.' }, 423);
    return json({ error: 'App copy could not complete its checks. Verify the saved profiles, API access, and connection.' }, 502);
  }
}

export default handleNativeAppCopy;
