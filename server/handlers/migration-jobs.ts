import { jsonHeaders } from '../security';
import {
  buildMigrationPlan,
  clearJobs,
  createMigrationJob,
  getJob,
  listJobs,
  retryMigrationJob,
  runPostMigrationAction,
  type MigrationTarget,
} from '../services/migrationJobs';
import {
  isVaultUnlocked,
  type PostMigrationAction,
} from '../services/nativeVault';

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

function parseStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
    : [];
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
      name: cleanString(action.name) || 'Post-migration action',
      method: parseMethod(action.method),
      url: cleanString(action.url) || '',
      headers: action.headers && typeof action.headers === 'object' && !Array.isArray(action.headers)
        ? Object.fromEntries(Object.entries(action.headers).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
        : {},
      body: typeof action.body === 'string' ? action.body : '',
    }))
    .filter((action) => action.url);
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
        targetModelId,
        targetModelName: cleanString(target.targetModelName),
        targetFolderId: cleanString(target.targetFolderId),
        targetFolderPath: cleanString(target.targetFolderPath),
      };
    })
    .filter((target) => target.destinationInstanceId);
}

function parseJobInput(body: Record<string, unknown>) {
  const targets = parseTargets(body.targets);
  return {
    sourceId: cleanString(body.sourceId) || '',
    destinationIds: parseStringArray(body.destinationIds),
    targets,
    documentIds: parseStringArray(body.documentIds),
    emptyFirst: body.emptyFirst === true,
    postMigrationActions: parseActions(body.postMigrationActions),
  };
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

    if (req.method === 'GET' && parts.length === 1) {
      const job = getJob(parts[0]);
      if (!job) return json({ error: 'Job not found.' }, 404);
      return json({ job });
    }

    const locked = requireUnlocked();
    if (locked) return locked;

    if (req.method === 'POST' && parts[0] === 'preview') {
      const input = parseJobInput(await bodyJson(req));
      if (!input.sourceId || (input.targets.length === 0 && input.destinationIds.length === 0) || input.documentIds.length === 0) {
        return json({ error: 'Select one source, at least one migration target, and at least one dashboard.' }, 400);
      }
      if (input.targets.some((target) => !target.targetModelId)) {
        return json({ error: 'Choose a target model for every migration target before running preflight.' }, 400);
      }
      const plan = await buildMigrationPlan(input);
      return json({ plan });
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

    if (req.method === 'POST' && parts.length === 0) {
      const input = parseJobInput(await bodyJson(req));
      if (!input.sourceId || (input.targets.length === 0 && input.destinationIds.length === 0) || input.documentIds.length === 0) {
        return json({ error: 'Select one source, at least one migration target, and at least one dashboard.' }, 400);
      }
      if (input.targets.some((target) => !target.targetModelId)) {
        return json({ error: 'Choose a target model for every migration target before starting the import.' }, 400);
      }
      const job = await createMigrationJob(input);
      return json({ job });
    }

    const id = parts[0];
    if (!id) return json({ error: 'Job id required.' }, 400);

    if (req.method === 'POST' && parts[1] === 'retry') {
      const job = await retryMigrationJob(id);
      return json({ job });
    }

    return json({ error: `Unknown migration jobs route: ${path}` }, 404);
  } catch (error) {
    const statusCode = typeof (error as { statusCode?: unknown }).statusCode === 'number'
      ? (error as { statusCode: number }).statusCode
      : 500;
    return json({ error: error instanceof Error ? error.message : 'Migration job operation failed.' }, statusCode);
  }
}
