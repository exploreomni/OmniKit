import { jsonHeaders, sseHeaders } from '../security';
import {
  buildMigrationPlan,
  cancelMigrationJob,
  clearJobs,
  createMigrationJob,
  type DashboardMigrationJobInput,
  getJob,
  listJobs,
  retryMigrationJob,
  runPostMigrationAction,
  validateDashboardMigrationPatches,
  type MigrationRouteGroup,
  type MigrationSemanticDependencyNode,
  type MigrationSemanticPatchSafetyCategory,
  type MigrationTarget,
} from '../services/migrationJobs';
import { subscribeMigrationJobEvents } from '../services/jobEvents';
import {
  isVaultUnlocked,
  type PostMigrationAction,
} from '../services/nativeVault';
import { redactSensitiveText } from '../services/jobSanitizer';
import { createPerformanceTracker } from '../services/performanceTimings';

const TERMINAL_JOB_STATUSES = new Set(['succeeded', 'partial', 'failed', 'canceled']);

async function bodyJson(req: Request): Promise<Record<string, unknown>> {
  try {
    return await req.json() as Record<string, unknown>;
  } catch {
    return {};
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: jsonHeaders });
}

function requireUnlocked(): Response | null {
  return isVaultUnlocked() ? null : json({ error: 'vault locked' }, 423);
}

function cleanString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function rawString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function parseStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
    : [];
}

function parseSemanticSafetyCategory(value: unknown): MigrationSemanticPatchSafetyCategory | undefined {
  return value === 'safe_ignore'
    || value === 'safe_map'
    || value === 'safe_create'
    || value === 'safe_update'
    || value === 'destructive_update'
    || value === 'blocked'
    ? value
    : value === 'manual_review'
      ? 'manual_review'
      : undefined;
}

function parseSemanticDependencyPath(value: unknown): MigrationSemanticDependencyNode[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const nodes = value
    .filter((node): node is Record<string, unknown> => Boolean(node) && typeof node === 'object' && !Array.isArray(node))
    .map((node) => {
      const kind = node.kind === 'dashboard'
        || node.kind === 'topic'
        || node.kind === 'query_view'
        || node.kind === 'model_field'
        || node.kind === 'relationship'
        || node.kind === 'model_file'
        ? node.kind
        : undefined;
	      const label = cleanString(node.label);
	      if (!kind || !label) return null;
	      const next: MigrationSemanticDependencyNode = { kind, label };
	      const ref = cleanString(node.ref);
	      const detail = cleanString(node.detail);
	      if (ref) next.ref = ref;
	      if (detail) next.detail = detail;
	      return next;
	    })
    .filter((node): node is MigrationSemanticDependencyNode => Boolean(node));
  return nodes.length > 0 ? nodes : undefined;
}

function parseMethod(value: unknown): PostMigrationAction['method'] {
  const method = typeof value === 'string' ? value.toUpperCase() : 'POST';
  if (method === 'GET' || method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') return method;
  return 'POST';
}

function parseActions(value: unknown): PostMigrationAction[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((action): action is Record<string, unknown> => Boolean(action) && typeof action === 'object' && !Array.isArray(action))
    .map((action) => ({
      kind: action.kind === 'refresh-schema' ? 'refresh-schema' as const : 'webhook' as const,
      name: cleanString(action.name) || 'Post-migration action',
      method: parseMethod(action.method),
      url: cleanString(action.url) || '',
      headers: action.headers && typeof action.headers === 'object' && !Array.isArray(action.headers)
        ? Object.fromEntries(Object.entries(action.headers).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
        : {},
      body: typeof action.body === 'string' ? action.body : '',
      destinationInstanceId: cleanString(action.destinationInstanceId),
      targetModelId: cleanString(action.targetModelId),
      targetModelName: cleanString(action.targetModelName),
    }))
    .filter((action) => action.kind === 'refresh-schema' ? Boolean(action.targetModelId) : Boolean(action.url));
}

function parseTopicMappings(value: unknown): MigrationTarget['topicMappings'] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((mapping): mapping is Record<string, unknown> => Boolean(mapping) && typeof mapping === 'object' && !Array.isArray(mapping))
    .map((mapping) => {
      const action = mapping.action === 'copy_source' ? 'copy_source' as const : 'map_existing' as const;
      return {
        sourceTopicName: cleanString(mapping.sourceTopicName) || '',
        sourceTopicId: cleanString(mapping.sourceTopicId),
        action,
        targetTopicName: cleanString(mapping.targetTopicName) || '',
        targetTopicLabel: cleanString(mapping.targetTopicLabel),
      };
    })
    .filter((mapping) => mapping.sourceTopicName && mapping.targetTopicName);
}

function parseQueryViewMappings(value: unknown): MigrationTarget['queryViewMappings'] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((mapping): mapping is Record<string, unknown> => Boolean(mapping) && typeof mapping === 'object' && !Array.isArray(mapping))
    .map((mapping) => {
      const action = mapping.action === 'copy_source'
        ? 'copy_source' as const
        : mapping.action === 'use_existing_unverified'
          ? 'use_existing_unverified' as const
          : mapping.action === 'update_existing'
            ? 'update_existing' as const
            : 'map_existing' as const;
      return {
        sourceQueryViewName: cleanString(mapping.sourceQueryViewName) || '',
        sourceFileName: cleanString(mapping.sourceFileName),
        action,
        targetQueryViewName: cleanString(mapping.targetQueryViewName) || '',
        targetFileName: cleanString(mapping.targetFileName),
        targetQueryViewLabel: cleanString(mapping.targetQueryViewLabel),
      };
    })
    .filter((mapping) => mapping.sourceQueryViewName && mapping.targetQueryViewName);
}

function parseFieldMappings(value: unknown): MigrationTarget['fieldMappings'] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((mapping): mapping is Record<string, unknown> => Boolean(mapping) && typeof mapping === 'object' && !Array.isArray(mapping))
    .map((mapping) => {
      const action = mapping.action === 'create_from_source'
        ? 'create_from_source' as const
        : mapping.action === 'ignore'
          ? 'ignore' as const
          : 'map_existing' as const;
      return {
        sourceFieldRef: cleanString(mapping.sourceFieldRef) || '',
        action,
        targetFieldRef: cleanString(mapping.targetFieldRef),
        sourceFileName: cleanString(mapping.sourceFileName),
        targetFileName: cleanString(mapping.targetFileName),
      };
    })
    .filter((mapping) => mapping.sourceFieldRef);
}

function parseSemanticPatches(value: unknown): MigrationTarget['semanticPatches'] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((patch): patch is Record<string, unknown> => Boolean(patch) && typeof patch === 'object' && !Array.isArray(patch))
    .map((patch) => {
      const artifactType = patch.artifactType === 'query_view'
        ? 'query_view' as const
        : patch.artifactType === 'topic'
          ? 'topic' as const
          : patch.artifactType === 'relationship'
            ? 'relationship' as const
            : 'field' as const;
      const resolution = patch.resolution === 'custom_edit'
        ? 'custom_edit' as const
        : patch.resolution === 'keep_target'
          ? 'keep_target' as const
          : patch.resolution === 'use_source'
            ? 'use_source' as const
            : 'recommended' as const;
      return {
        id: cleanString(patch.id) || '',
        artifactType,
        sourceName: cleanString(patch.sourceName),
        sourceFileName: cleanString(patch.sourceFileName),
        targetFileName: cleanString(patch.targetFileName) || '',
        targetModelId: cleanString(patch.targetModelId),
        acceptedYaml: rawString(patch.acceptedYaml),
        recommendedYaml: rawString(patch.recommendedYaml),
        previousChecksum: cleanString(patch.previousChecksum),
        resolution,
        destructive: patch.destructive === true,
        confirmedDestructive: patch.confirmedDestructive === true,
        status: patch.status === 'blocked' ? 'blocked' as const : patch.status === 'warning' ? 'warning' as const : patch.status === 'ready' ? 'ready' as const : undefined,
        safetyCategory: parseSemanticSafetyCategory(patch.safetyCategory),
        recommendedAction: cleanString(patch.recommendedAction),
        dependencyPath: parseSemanticDependencyPath(patch.dependencyPath),
        warnings: parseStringArray(patch.warnings),
      };
    })
    .filter((patch) => patch.id && patch.targetFileName && (patch.resolution === 'keep_target' || Boolean(patch.acceptedYaml)));
}

function parseTargets(value: unknown): MigrationTarget[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((target): target is Record<string, unknown> => Boolean(target) && typeof target === 'object' && !Array.isArray(target))
    .map((target, index) => {
      const destinationInstanceId = cleanString(target.destinationInstanceId) || cleanString(target.destinationId) || '';
      const targetModelId = cleanString(target.targetModelId) || '';
      return {
        id: cleanString(target.id) || `${destinationInstanceId}:${targetModelId}:${index}`,
        destinationInstanceId,
        destinationLabel: cleanString(target.destinationLabel),
        targetConnectionId: cleanString(target.targetConnectionId),
        targetModelId,
        targetModelName: cleanString(target.targetModelName),
        targetFolderId: cleanString(target.targetFolderId),
        targetFolderPath: cleanString(target.targetFolderPath),
        topicMappings: parseTopicMappings(target.topicMappings),
        queryViewMappings: parseQueryViewMappings(target.queryViewMappings),
        fieldMappings: parseFieldMappings(target.fieldMappings),
        semanticPatches: parseSemanticPatches(target.semanticPatches),
      };
    })
    .filter((target) => target.destinationInstanceId);
}

function parseRouteGroups(value: unknown): MigrationRouteGroup[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((group): group is Record<string, unknown> => Boolean(group) && typeof group === 'object' && !Array.isArray(group))
    .map((group, index) => ({
      id: cleanString(group.id) || `route-group-${index + 1}`,
      name: cleanString(group.name) || `Route group ${index + 1}`,
      documentIds: parseStringArray(group.documentIds),
      targets: parseTargets(group.targets),
    }))
    .filter((group) => group.documentIds.length > 0 && group.targets.length > 0);
}

function parseSourceDocumentHints(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .filter((document): document is Record<string, unknown> => Boolean(document) && typeof document === 'object' && !Array.isArray(document))
    .map((document) => ({
      id: cleanString(document.id) || '',
      identifier: cleanString(document.identifier) || cleanString(document.id) || '',
      name: cleanString(document.name) || '',
      connectionId: cleanString(document.connectionId),
      folderId: cleanString(document.folderId),
      folderPath: cleanString(document.folderPath),
      baseModelId: cleanString(document.baseModelId),
      baseModelName: cleanString(document.baseModelName),
      topicNames: parseStringArray(document.topicNames),
      topicIds: parseStringArray(document.topicIds),
      description: cleanString(document.description) || null,
      labels: parseStringArray(document.labels),
      updatedAt: cleanString(document.updatedAt),
    }))
    .filter((document) => document.identifier && document.name);
}

function parseJobInput(body: Record<string, unknown>): DashboardMigrationJobInput {
  const targets = parseTargets(body.targets);
  return {
    sourceId: cleanString(body.sourceId) || '',
    sourceConnectionId: cleanString(body.sourceConnectionId),
    destinationIds: parseStringArray(body.destinationIds),
    targets,
    routeGroups: parseRouteGroups(body.routeGroups),
    documentIds: parseStringArray(body.documentIds),
    sourceDocumentHints: parseSourceDocumentHints(body.sourceDocumentHints),
    emptyFirst: body.emptyFirst === true,
    replaceSameNamed: body.replaceSameNamed !== false,
    deleteSourceOnSuccess: body.deleteSourceOnSuccess === true,
    sourceFolderId: cleanString(body.sourceFolderId),
    sourceFolderPath: cleanString(body.sourceFolderPath),
    sourceAllFolders: body.sourceAllFolders === true,
    postMigrationActions: parseActions(body.postMigrationActions),
  };
}

function parseOptionalRetryInput(value: unknown): DashboardMigrationJobInput | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  return parseJobInput(value as Record<string, unknown>);
}

function sseEncode(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function jobEventsResponse(jobId: string, signal: AbortSignal): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      let unsubscribe: () => void = () => undefined;
      const close = () => {
        if (closed) return;
        closed = true;
        clearInterval(keepalive);
        unsubscribe();
        controller.close();
      };
      const send = (event: string, data: unknown) => {
        if (closed) return;
        controller.enqueue(encoder.encode(sseEncode(event, data)));
      };
      const keepalive = setInterval(() => {
        if (!closed) controller.enqueue(encoder.encode(': keepalive\n\n'));
      }, 15_000);

      const snapshot = getJob(jobId);
      if (!snapshot) {
        send('error', { error: 'Job not found.' });
        close();
        return;
      }
      send('snapshot', { job: snapshot });
      if (TERMINAL_JOB_STATUSES.has(snapshot.status)) {
        close();
        return;
      }

      unsubscribe = subscribeMigrationJobEvents(jobId, (event) => {
        send(event.type, event);
        if (event.type === 'job' && TERMINAL_JOB_STATUSES.has(event.status)) {
          setTimeout(close, 250);
        }
      });
      signal.addEventListener('abort', close, { once: true });
    },
  });
  return new Response(stream, { headers: sseHeaders });
}

export default async function handler(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/api\/migration-jobs\/?/, '');
    const parts = path.split('/').filter(Boolean);

    if (req.method === 'GET' && parts.length === 0) {
      return json({ jobs: listJobs() });
    }

    if (req.method === 'DELETE' && parts.length === 0) {
      clearJobs();
      return json({ ok: true });
    }

    if (req.method === 'GET' && parts.length === 2 && parts[1] === 'events') {
      const job = getJob(parts[0]);
      if (!job) return json({ error: 'Job not found.' }, 404);
      return jobEventsResponse(parts[0], req.signal);
    }

    if (req.method === 'GET' && parts.length === 1) {
      const job = getJob(parts[0]);
      if (!job) return json({ error: 'Job not found.' }, 404);
      return json({ job });
    }

    if (req.method === 'POST' && parts.length === 2 && parts[1] === 'cancel') {
      const job = cancelMigrationJob(parts[0]);
      if (!job) return json({ error: 'Job not found.' }, 404);
      return json({ job });
    }

    const locked = requireUnlocked();
    if (locked) return locked;

    if (req.method === 'POST' && parts[0] === 'preview') {
      const input = parseJobInput(await bodyJson(req));
      const requestTargets = [
        ...(input.targets || []),
        ...((input.routeGroups || []).flatMap((group) => group.targets)),
      ];
      if (!input.sourceId || (requestTargets.length === 0 && (input.destinationIds || []).length === 0) || input.documentIds.length === 0) {
        return json({ error: 'Select one source, at least one migration target, and at least one dashboard.' }, 400);
      }
      if (requestTargets.some((target) => !target.targetConnectionId)) {
        return json({ error: 'Choose a target connection for every migration target before running preflight.' }, 400);
      }
      if (requestTargets.some((target) => !target.targetModelId)) {
        return json({ error: 'Choose a target model for every migration target before running preflight.' }, 400);
      }
      const timings = createPerformanceTracker();
      const plan = await timings.time(
        'build-migration-plan',
        () => buildMigrationPlan({ ...input, usePreviewCache: true }),
        (result) => ({
          stepCount: result?.steps.length || 0,
          targetCount: requestTargets.length,
          documentCount: input.documentIds.length,
        }),
      );
      return json({ plan, performance: timings.snapshot() });
    }

    if (req.method === 'POST' && parts[0] === 'actions' && parts[1] === 'run') {
      const body = await bodyJson(req);
      const actions = parseActions(body.actions);
      const results = [];
      for (const action of actions) {
        results.push({ action: action.name, ...(await runPostMigrationAction(action)) });
      }
      return json({ results });
    }

    if (req.method === 'POST' && parts[0] === 'validate-patches') {
      const input = parseJobInput(await bodyJson(req));
      const requestTargets = [
        ...(input.targets || []),
        ...((input.routeGroups || []).flatMap((group) => group.targets)),
      ];
      if (!input.sourceId || input.documentIds.length === 0 || requestTargets.length === 0) {
        return json({ error: 'Select a source, at least one dashboard, and at least one migration target before validating dependency patches.' }, 400);
      }
      const result = await validateDashboardMigrationPatches(input);
      return json({ validation: result });
    }

    if (req.method === 'POST' && parts.length === 0) {
      const input = parseJobInput(await bodyJson(req));
      const requestTargets = [
        ...(input.targets || []),
        ...((input.routeGroups || []).flatMap((group) => group.targets)),
      ];
      if (!input.sourceId || (requestTargets.length === 0 && (input.destinationIds || []).length === 0) || input.documentIds.length === 0) {
        return json({ error: 'Select one source, at least one migration target, and at least one dashboard.' }, 400);
      }
      if (requestTargets.some((target) => !target.targetConnectionId)) {
        return json({ error: 'Choose a target connection for every migration target before starting the import.' }, 400);
      }
      if (requestTargets.some((target) => !target.targetModelId)) {
        return json({ error: 'Choose a target model for every migration target before starting the import.' }, 400);
      }
      const job = await createMigrationJob(input);
      return json({ job });
    }

    const id = parts[0];
    if (!id) return json({ error: 'Job id required.' }, 400);

    if (req.method === 'POST' && parts[1] === 'retry') {
      const body = await bodyJson(req);
      const job = await retryMigrationJob(id, {
        destinationId: cleanString(body.destinationId),
        retryInput: parseOptionalRetryInput(body.retryInput),
      });
      return json({ job });
    }

    return json({ error: `Unknown migration jobs route: ${path}` }, 404);
  } catch (error) {
    const statusCode = typeof (error as { statusCode?: unknown }).statusCode === 'number'
      ? (error as { statusCode: number }).statusCode
      : 500;
    return json({ error: error instanceof Error ? redactSensitiveText(error.message) : 'Migration job operation failed.' }, statusCode);
  }
}
