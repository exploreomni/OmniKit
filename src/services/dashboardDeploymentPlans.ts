import { apiFetch } from './opsConsole';
import type { DashboardSafeCopyIntent, DashboardSafeCopyTopicMapping } from '../../shared/dashboardSafeCopyContract';
import type { DashboardDeploymentPlan } from '../../shared/dashboardDeploymentPlan';
import type { MigrationJob } from './opsConsole';
import type { DashboardTopicRepairPreview } from '../../shared/dashboardTopicRepair';
import { ApiError } from './omniApi';
import { emitVaultLocked } from './vaultEvents';
import { DASHBOARD_READINESS_STAGES, type DashboardReadinessProgressEvent } from '../../shared/dashboardReadiness';

export type { DashboardDeploymentPlan, DashboardDeploymentHandoff, DashboardDeploymentTargetReadiness } from '../../shared/dashboardDeploymentPlan';
export type { DashboardReadinessProgressEvent } from '../../shared/dashboardReadiness';

const base = '/api/migration-jobs/deployment-plans';
export function previewDashboardTopicRepair(planId: string, input: { revision: number; targetId: string; sourceTopicName: string; targetTopicName: string; baseView?: string; selectedJoinPaths?: Record<string, string> }, signal?: AbortSignal) {
  return apiFetch<DashboardTopicRepairPreview>(`${base}/${encodeURIComponent(planId)}/topic-repair/preview`, { method: 'POST', body: JSON.stringify(input), signal });
}
export function approveDashboardTopicRepair(planId: string, input: { revision: number; targetId: string; reviewId: string; reviewHash: string; confirmAdditiveOnly: true; confirmNewTopicSemantics: true }) {
  return apiFetch<{ plan: DashboardDeploymentPlan; job: { id: string } }>(`${base}/${encodeURIComponent(planId)}/topic-repair/approve`, { method: 'POST', body: JSON.stringify(input) });
}
type ProgressCallback = (progress: DashboardReadinessProgressEvent) => void;

function readinessError(value: unknown, status: number): ApiError {
  const row = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const message = typeof row.error === 'string' ? row.error : typeof row.message === 'string' ? row.message : 'Readiness could not finish. Recheck before deploying.';
  if (status === 423) emitVaultLocked(message);
  return new ApiError(status, message, undefined, typeof row.code === 'string' ? row.code : undefined);
}

function completedPlan(value: unknown): { plan: DashboardDeploymentPlan } {
  const row = value && typeof value === 'object' ? value as { plan?: DashboardDeploymentPlan } : {};
  const plan = row.plan;
  if (!plan || plan.version !== 2 || typeof plan.id !== 'string' || !plan.id
    || !Number.isSafeInteger(plan.revision) || plan.revision < 1
    || !plan.intent?.requestId || !Array.isArray(plan.intent.destinations) || !Array.isArray(plan.targets)
    || plan.targets.some((target) => !target.targetId || !['ready', 'model_changes_required', 'unverified', 'needs_recheck'].includes(target.status) || !Array.isArray(target.findings))
    || (plan.readinessRun && plan.readinessRun.status !== 'complete')) {
    throw new Error('The readiness response was incomplete. Recheck before deploying.');
  }
  return { plan };
}

/** Only a complete terminal response can provide a plan. Progress never authorizes deployment. */
export async function readDashboardReadinessStream(response: Response, signal?: AbortSignal, onProgress?: ProgressCallback): Promise<{ plan: DashboardDeploymentPlan }> {
  const checkAbort = () => { if (signal?.aborted) throw new DOMException('Readiness check canceled.', 'AbortError'); };
  checkAbort();
  if (!response.ok || !response.headers.get('content-type')?.includes('ndjson')) {
    const value: unknown = await response.json().catch(() => null);
    checkAbort();
    if (!response.ok || (value && typeof value === 'object' && 'error' in value)) throw readinessError(value, response.status);
    return completedPlan(value);
  }
  if (!response.body) throw new Error('The readiness progress stream was unavailable. Recheck before deploying.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  let receivedBytes = 0;
  let runId = '';
  let terminal: { plan: DashboardDeploymentPlan } | undefined;
  const cancelReader = () => { void reader.cancel().catch(() => undefined); };
  signal?.addEventListener('abort', cancelReader, { once: true });
  const invalid = () => new Error('Readiness returned an invalid progress response. Recheck before deploying.');
  const consume = (line: string) => {
    if (!line.trim()) return;
    if (terminal) throw invalid();
    let event: Record<string, unknown>;
    try { event = JSON.parse(line) as Record<string, unknown>; } catch { throw invalid(); }
    if (!event || typeof event !== 'object' || typeof event.runId !== 'string' || !event.runId || (runId && runId !== event.runId)) throw invalid();
    runId = event.runId;
    if (event.type === 'error') throw readinessError(event, 502);
    if (event.type === 'complete') {
      terminal = completedPlan(event);
      return;
    }
    if (event.type !== 'progress' || !DASHBOARD_READINESS_STAGES.includes(event.stage as DashboardReadinessProgressEvent['stage'])
      || typeof event.elapsedMs !== 'number' || !Number.isFinite(event.elapsedMs) || event.elapsedMs < 0
      || (event.completed !== undefined && (!Number.isSafeInteger(event.completed) || Number(event.completed) < 0))
      || (event.total !== undefined && (!Number.isSafeInteger(event.total) || Number(event.total) < 0))
      || (event.total !== undefined && event.completed !== undefined && Number(event.completed) > Number(event.total))
      || (event.targetId !== undefined && (typeof event.targetId !== 'string' || !event.targetId))) throw invalid();
    checkAbort();
    onProgress?.(event as unknown as DashboardReadinessProgressEvent);
  };
  try {
    while (true) {
      checkAbort();
      const { done, value } = await reader.read();
      checkAbort();
      receivedBytes += value?.byteLength || 0;
      if (receivedBytes > 10 * 1024 * 1024) throw new Error('The readiness response exceeded the supported size. No result was applied.');
      pending += decoder.decode(value, { stream: !done });
      let newline = pending.indexOf('\n');
      while (newline >= 0) {
        consume(pending.slice(0, newline));
        pending = pending.slice(newline + 1);
        newline = pending.indexOf('\n');
      }
      if (done) {
        consume(pending);
        if (!terminal) throw new Error('Readiness ended before completion. Previous findings cannot authorize deployment. Recheck to continue.');
        return terminal;
      }
    }
  } finally {
    signal?.removeEventListener('abort', cancelReader);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

async function requestReadiness(path: string, body: DashboardSafeCopyIntent | undefined, signal?: AbortSignal, onProgress?: ProgressCallback) {
  const response = await fetch(`${path}?stream=1`, {
    method: 'POST', signal,
    headers: { Accept: 'application/x-ndjson', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return readDashboardReadinessStream(response, signal, onProgress);
}

export async function createDashboardDeploymentPlan(intent: DashboardSafeCopyIntent, signal?: AbortSignal, onProgress?: ProgressCallback) {
  const response = await requestReadiness(base, intent, signal, onProgress);
  if (response.plan.intent.requestId !== intent.requestId) throw new Error('Readiness returned a different dashboard request. No result was applied.');
  return response;
}
export function getDashboardDeploymentPlan(id: string, signal?: AbortSignal) {
  return apiFetch<{ plan: DashboardDeploymentPlan }>(`${base}/${encodeURIComponent(id)}`, { signal });
}
export async function recheckDashboardDeploymentPlan(id: string, signal?: AbortSignal, onProgress?: ProgressCallback) {
  const response = await requestReadiness(`${base}/${encodeURIComponent(id)}/recheck`, undefined, signal, onProgress);
  if (response.plan.id !== id) throw new Error('Readiness returned a different deployment plan. No result was applied.');
  return response;
}
export interface DashboardDeploymentTargetUpdate {
  revision: number;
  targetId: string;
  topicMappings?: DashboardSafeCopyTopicMapping[];
  workbookCopy?: { stagingFolderId: string } | null;
}
export function updateDashboardDeploymentPlan(id: string, update: DashboardDeploymentTargetUpdate, signal?: AbortSignal) {
  return apiFetch<{ plan: DashboardDeploymentPlan }>(`${base}/${encodeURIComponent(id)}`, {
    method: 'PATCH', body: JSON.stringify(update), signal,
  });
}
export function deployDashboardDeploymentPlan(id: string, revision: number, targetIds: string[], requestId: string) {
  return apiFetch<{ job: MigrationJob; plan: DashboardDeploymentPlan }>(`${base}/${encodeURIComponent(id)}/deploy`, {
    method: 'POST', body: JSON.stringify({ revision, targetIds, requestId }),
  });
}
export function linkDashboardModelRepair(id: string, targetId: string, jobId: string) {
  return apiFetch<{ plan: DashboardDeploymentPlan }>(`${base}/${encodeURIComponent(id)}/repair`, {
    method: 'POST', body: JSON.stringify({ targetId, jobId }),
  });
}
