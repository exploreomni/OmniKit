import { jsonHeaders } from '../security';
import { createModelMigrationJob, mergeModelMigrationJob, type ModelMigrationAcceptedFile, type ModelMigrationContentInput, type ModelMigrationModelInput } from '../services/migrationJobs';
import { getInstance, isVaultUnlocked, type PostMigrationAction } from '../services/nativeVault';
import { OmniClient, type OmniDocumentRecord, type OmniModelRecord } from '../services/omniClient';
import {
  buildFieldUniverseFromYaml,
  buildTranslatedYamlFiles,
  parseSchemaMap,
  preflightWorkbookQueryFields,
  promptForYamlFile,
  rewriteQueryModelReferences,
} from '../services/modelMigration/helpers';
import { runAiDialectPass, shouldRunAiDialectPass } from '../services/modelMigration/aiTranslation';
import { redactSensitiveText } from '../services/jobSanitizer';

export type ModelMigratorDocumentKind = 'dashboard' | 'workbook' | 'unknown';

export interface ModelMigratorInventoryDocument {
  id: string;
  identifier: string;
  name: string;
  folderId?: string;
  folderPath?: string;
  baseModelId?: string;
  type?: string;
  kind: ModelMigratorDocumentKind;
  description?: string | null;
  labels?: string[];
  updatedAt?: string;
}

export interface ModelMigratorInventoryRow {
  modelId: string;
  dashboardCount: number;
  workbookCount: number;
  unknownCount: number;
  documents: ModelMigratorInventoryDocument[];
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

async function bodyJson(req: Request): Promise<Record<string, unknown>> {
  try {
    return await req.json() as Record<string, unknown>;
  } catch {
    return {};
  }
}

function parseCsv(value: string | null): string[] {
  return (value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function isActiveModel(model: OmniModelRecord): boolean {
  return !model.deletedAt;
}

function parseStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).map((item) => item.trim()) : [];
}

function parseAcceptedFiles(value: unknown): ModelMigrationAcceptedFile[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    .map((item) => ({
      fileName: cleanString(item.fileName) || '',
      yaml: typeof item.yaml === 'string' ? item.yaml : '',
      previousChecksum: cleanString(item.previousChecksum),
    }))
    .filter((file) => file.fileName && file.yaml);
}

function parseModelInputs(value: unknown): ModelMigrationModelInput[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    .map((item) => ({
      sourceModelId: cleanString(item.sourceModelId) || '',
      sourceModelName: cleanString(item.sourceModelName),
      targetModelId: cleanString(item.targetModelId) || '',
      targetModelName: cleanString(item.targetModelName),
      targetConnectionId: cleanString(item.targetConnectionId) || '',
      mode: item.mode === 'fast' ? 'fast' as const : 'translate' as const,
      branchName: cleanString(item.branchName) || '',
      gitRef: cleanString(item.gitRef),
      fastPathSchemaConfirmed: item.fastPathSchemaConfirmed === true,
      mergeHandoffRequired: item.mergeHandoffRequired === true,
      acceptedFiles: parseAcceptedFiles(item.acceptedFiles),
    }))
    .filter((item) => item.sourceModelId && item.targetModelId && item.targetConnectionId && item.branchName);
}

function parsePostMigrationActions(value: unknown): PostMigrationAction[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    .map((item) => {
      const method = cleanString(item.method);
      return {
        kind: item.kind === 'refresh-schema' ? 'refresh-schema' as const : 'webhook' as const,
        name: cleanString(item.name) || 'Post-migration action',
        method: method && ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method) ? method as PostMigrationAction['method'] : 'POST',
        url: cleanString(item.url) || '',
        headers: item.headers && typeof item.headers === 'object' && !Array.isArray(item.headers)
          ? Object.fromEntries(Object.entries(item.headers).filter((entry): entry is [string, string] => typeof entry[1] === 'string'))
          : {},
        body: typeof item.body === 'string' ? item.body : '',
        destinationInstanceId: cleanString(item.destinationInstanceId),
        targetModelId: cleanString(item.targetModelId),
        targetModelName: cleanString(item.targetModelName),
      };
    })
    .filter((action) => action.kind === 'refresh-schema' ? Boolean(action.destinationInstanceId && action.targetModelId) : Boolean(action.url));
}

function parseContentInputs(value: unknown): ModelMigrationContentInput[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    .map((item) => ({
      documentId: cleanString(item.documentId) || '',
      documentName: cleanString(item.documentName) || 'Migrated document',
      kind: item.kind === 'dashboard' ? 'dashboard' as const : 'workbook' as const,
      sourceModelId: cleanString(item.sourceModelId) || '',
      targetModelId: cleanString(item.targetModelId) || '',
      targetModelName: cleanString(item.targetModelName),
      targetFolderId: cleanString(item.targetFolderId),
      targetFolderPath: cleanString(item.targetFolderPath),
    }))
    .filter((item) => item.documentId && item.sourceModelId && item.targetModelId);
}

export function classifyModelMigratorDocument(document: Pick<OmniDocumentRecord, 'hasDashboard' | 'type'>): ModelMigratorDocumentKind {
  const type = (document.type || '').toLowerCase();
  if (document.hasDashboard === true) return 'dashboard';
  if (document.hasDashboard === false) return 'workbook';
  if (type.includes('dashboard')) return 'dashboard';
  if (type.includes('workbook') || type.includes('analysis')) return 'workbook';
  return 'unknown';
}

export function buildModelMigratorInventory(
  documents: OmniDocumentRecord[],
  modelIds: string[],
): ModelMigratorInventoryRow[] {
  const selected = new Set(modelIds);
  const grouped = new Map<string, ModelMigratorInventoryDocument[]>();

  for (const document of documents) {
    if (!document.baseModelId || !selected.has(document.baseModelId)) continue;
    const kind = classifyModelMigratorDocument(document);
    const row: ModelMigratorInventoryDocument = {
      id: document.id,
      identifier: document.identifier,
      name: document.name,
      baseModelId: document.baseModelId,
      kind,
      ...(document.folderId ? { folderId: document.folderId } : {}),
      ...(document.folderPath ? { folderPath: document.folderPath } : {}),
      ...(document.type ? { type: document.type } : {}),
      ...(document.description ? { description: document.description } : {}),
      ...(document.labels?.length ? { labels: document.labels } : {}),
      ...(document.updatedAt ? { updatedAt: document.updatedAt } : {}),
    };
    grouped.set(document.baseModelId, [...(grouped.get(document.baseModelId) || []), row]);
  }

  return modelIds.map((modelId) => {
    const rows = grouped.get(modelId) || [];
    return {
      modelId,
      dashboardCount: rows.filter((row) => row.kind === 'dashboard').length,
      workbookCount: rows.filter((row) => row.kind === 'workbook').length,
      unknownCount: rows.filter((row) => row.kind === 'unknown').length,
      documents: rows.sort((a, b) => a.name.localeCompare(b.name)),
    };
  });
}

export default async function handler(req: Request): Promise<Response> {
  try {
    const locked = requireUnlocked();
    if (locked) return locked;

    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/api\/model-migrator\/?/, '');
    const parts = path.split('/').filter(Boolean);

    if (req.method === 'POST' && parts[0] === 'translate') {
      const body = await bodyJson(req);
      const sourceInstanceId = cleanString(body.sourceInstanceId);
      const modelId = cleanString(body.modelId);
      if (!sourceInstanceId || !modelId) return json({ error: 'sourceInstanceId and modelId are required.' }, 400);
      const secret = getInstance(sourceInstanceId);
      if (!secret) return json({ error: 'Source instance not found.' }, 404);
      const schemaMap = parseSchemaMap(typeof body.schemaMapText === 'string' ? body.schemaMapText : '');
      const sourceDialect = cleanString(body.sourceDialect) || 'source';
      const targetDialect = cleanString(body.targetDialect) || 'target';
      const client = new OmniClient(secret);
      const yaml = await client.getModelYaml(modelId, { includeChecksums: true });
      const files = buildTranslatedYamlFiles({
        files: yaml.files,
        schemaMap,
        sourceDialect,
        targetDialect,
      });
      if (body.runAi === true) {
        for (const file of files) {
          if (!shouldRunAiDialectPass(file.fileName, file.translated)) {
            file.warnings.push('No SQL-bearing section detected; AI dialect pass was skipped for this file.');
            continue;
          }
          const prompt = promptForYamlFile({ sourceDialect, targetDialect, fileName: file.fileName, schemaMap, yaml: file.translated });
          try {
            const result = await runAiDialectPass(client, modelId, prompt);
            if (result.yaml) {
              file.aiDraft = result.yaml;
              file.aiJobId = result.jobId;
              file.translated = result.yaml;
              file.changed = file.original !== result.yaml;
              file.reviewRequired = true;
              file.warnings.push(`AI dialect pass applied from Omni AI job ${result.jobId || 'unknown'}. Review before accepting.`);
            }
            if (result.refusal) {
              file.aiJobId = result.jobId;
              file.aiRefusal = redactSensitiveText(result.refusal);
              file.warnings.push(file.aiRefusal);
            }
            if (result.warning) file.warnings.push(redactSensitiveText(result.warning));
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            file.aiRefusal = 'Omni AI dialect pass failed for this file; deterministic translation remains available for review.';
            file.warnings.push(`${file.aiRefusal} ${redactSensitiveText(message)}`);
          }
        }
      }
      return json({
        files,
        checksums: yaml.checksums || {},
        prompts: files.map((file) => ({
          fileName: file.fileName,
          prompt: promptForYamlFile({ sourceDialect, targetDialect, fileName: file.fileName, schemaMap, yaml: file.translated }),
        })),
      });
    }

    if (req.method === 'POST' && parts[0] === 'preflight') {
      const body = await bodyJson(req);
      const sourceInstanceId = cleanString(body.sourceInstanceId);
      const targetInstanceId = cleanString(body.targetInstanceId);
      const sourceModelId = cleanString(body.sourceModelId);
      const targetModelId = cleanString(body.targetModelId);
      const documentIds = parseStringArray(body.documentIds);
      if (!sourceInstanceId || !targetInstanceId || !sourceModelId || !targetModelId) {
        return json({ error: 'sourceInstanceId, targetInstanceId, sourceModelId, and targetModelId are required.' }, 400);
      }
      const source = getInstance(sourceInstanceId);
      const target = getInstance(targetInstanceId);
      if (!source || !target) return json({ error: 'Source or target instance not found.' }, 404);
      const sourceClient = new OmniClient(source);
      const targetClient = new OmniClient(target);
      const targetYaml = await targetClient.getModelYaml(targetModelId, { includeChecksums: true });
      const universe = buildFieldUniverseFromYaml(targetYaml.files);
      const workbooks = [];
      for (const documentId of documentIds) {
        const queries = await sourceClient.getDocumentQueries(documentId);
        const tabs = queries.map((query) => {
          const rewritten = rewriteQueryModelReferences(query.query, sourceModelId, targetModelId);
          const preflight = preflightWorkbookQueryFields(rewritten, universe);
          return {
            id: query.id,
            name: query.name,
            fieldReferences: preflight.fieldReferences,
            blockers: preflight.blockers,
            replacementCount: preflight.replacements,
          };
        });
        workbooks.push({
          documentId,
          tabCount: tabs.length,
          blockerCount: tabs.reduce((sum, tab) => sum + tab.blockers.length, 0),
          tabs,
        });
      }
      return json({ workbooks });
    }

    if (req.method === 'POST' && parts[0] === 'jobs') {
      if (parts[2] === 'merge') {
        const body = await bodyJson(req);
        const job = await mergeModelMigrationJob(parts[1], {
          publishDrafts: body.publishDrafts === true,
          deleteBranch: body.deleteBranch !== false,
        });
        return json({ job });
      }

      const body = await bodyJson(req);
      const sourceId = cleanString(body.sourceId);
      const targetId = cleanString(body.targetId);
      if (!sourceId || !targetId) return json({ error: 'sourceId and targetId are required.' }, 400);
      const models = parseModelInputs(body.models);
      if (models.length === 0) return json({ error: 'At least one model migration target is required.' }, 400);
      if (models.some((model) => model.mode === 'fast' && model.fastPathSchemaConfirmed !== true)) {
        return json({ error: 'Fast path requires explicit schema identity confirmation for every selected model.' }, 400);
      }
      if (models.some((model) => model.mode === 'translate' && (model.acceptedFiles?.length || 0) === 0)) {
        return json({ error: 'Translate pipeline models require at least one accepted YAML file.' }, 400);
      }
      const job = await createModelMigrationJob({
        sourceId,
        targetId,
        targetLabel: cleanString(body.targetLabel),
        models,
        content: parseContentInputs(body.content),
        replaceSameNamed: body.replaceSameNamed !== false,
        mergeAfterValidation: body.mergeAfterValidation === true,
        publishDrafts: body.publishDrafts === true,
        deleteBranch: body.deleteBranch === true,
        postMigrationActions: parsePostMigrationActions(body.postMigrationActions),
      });
      return json({ job });
    }

    const instanceId = parts[0];
    const action = parts[1];
    if (!instanceId) return json({ error: 'Instance id required.' }, 400);

    const secret = getInstance(instanceId);
    if (!secret) return json({ error: 'Instance not found.' }, 404);
    const client = new OmniClient(secret);

    if (req.method === 'GET' && action === 'connections') {
      const connections = (await client.listConnections()).filter((connection) => !connection.deletedAt);
      return json({ connections });
    }

    if (req.method === 'GET' && action === 'models') {
      const connectionId = cleanString(url.searchParams.get('connectionId'));
      const modelKind = cleanString(url.searchParams.get('modelKind')) || 'SHARED';
      const models = (await client.listModels(modelKind))
        .filter(isActiveModel)
        .filter((model) => !connectionId || model.connectionId === connectionId);
      return json({ models });
    }

    if (req.method === 'GET' && action === 'inventory') {
      const modelIds = parseCsv(url.searchParams.get('modelIds'));
      if (modelIds.length === 0) return json({ models: [] });
      const documents = await client.listFolderDocuments(undefined, true);
      return json({ models: buildModelMigratorInventory(documents, modelIds) });
    }

    return json({ error: `Unknown model migrator route: ${path}` }, 404);
  } catch (error) {
    const statusCode = typeof (error as { statusCode?: unknown }).statusCode === 'number'
      ? (error as { statusCode: number }).statusCode
      : 500;
    return json({ error: redactSensitiveText(error instanceof Error ? error.message : 'Model migrator request failed.') }, statusCode);
  }
}
