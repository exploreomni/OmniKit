import { randomUUID } from 'node:crypto';
import type { DashboardDeploymentPlan } from '../../shared/dashboardDeploymentPlan';
import {
  DASHBOARD_READINESS_STAGES,
  type DashboardReadinessCounters,
  type DashboardReadinessErrorCode,
  type DashboardReadinessEvent,
  type DashboardReadinessProgressEvent,
  type DashboardReadinessStage,
} from '../../shared/dashboardReadiness';

export const DASHBOARD_READINESS_DEFAULT_DEADLINE_MS = 120_000;
export const DASHBOARD_READINESS_MAX_DEADLINE_MS = 300_000;
const ERROR_MESSAGES: Record<DashboardReadinessErrorCode, string> = {
  DASHBOARD_READINESS_CANCELED: 'Compatibility checking was canceled. No incomplete result was accepted.',
  DASHBOARD_READINESS_DEADLINE_EXCEEDED: 'Compatibility checking exceeded its time limit. No incomplete result was accepted. Try a smaller selection or recheck later.',
  DASHBOARD_READINESS_FAILED: 'Compatibility checking could not finish. No incomplete result was accepted. Recheck the selected source and destinations.',
};

export class DashboardReadinessError extends Error {
  readonly statusCode: number;
  constructor(readonly code: DashboardReadinessErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'DashboardReadinessError';
    this.statusCode = code === 'DASHBOARD_READINESS_CANCELED' ? 499
      : code === 'DASHBOARD_READINESS_DEADLINE_EXCEEDED' ? 504 : 500;
  }
}

export interface DashboardReadinessRunOptions {
  signal?: AbortSignal;
  runId?: string;
  deadlineMs?: number;
  onProgress?: (event: DashboardReadinessProgressEvent) => void;
}
export interface DashboardReadinessRunContext {
  readonly runId: string;
  readonly signal: AbortSignal;
  readonly stage: DashboardReadinessStage;
  elapsedMs(): number;
  report(stage: DashboardReadinessStage, counters?: DashboardReadinessCounters): void;
  throwIfAborted(): void;
  dispose(): void;
}

function safeIdentifier(value: unknown): string | undefined {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value)
    && !/^(?:omni_|bearer|token|secret|password)/i.test(value) ? value : undefined;
}

/** One overall deadline; nested reads inherit this signal instead of resetting the clock. */
export function createDashboardReadinessContext(options: DashboardReadinessRunOptions = {}): DashboardReadinessRunContext {
  const controller = new AbortController();
  const startedAt = performance.now();
  const runId = safeIdentifier(options.runId) || randomUUID();
  const deadlineMs = Number.isFinite(options.deadlineMs)
    ? Math.max(1, Math.min(DASHBOARD_READINESS_MAX_DEADLINE_MS, Math.floor(options.deadlineMs!)))
    : DASHBOARD_READINESS_DEFAULT_DEADLINE_MS;
  let stage: DashboardReadinessStage = 'source_dashboard';
  let disposed = false;
  const elapsedMs = () => Math.max(0, Math.floor(performance.now() - startedAt));
  const cancel = () => controller.abort(new DashboardReadinessError('DASHBOARD_READINESS_CANCELED'));
  const timeout = setTimeout(() => controller.abort(new DashboardReadinessError('DASHBOARD_READINESS_DEADLINE_EXCEEDED')), deadlineMs);
  options.signal?.addEventListener('abort', cancel, { once: true });
  if (options.signal?.aborted) cancel();
  const throwIfAborted = () => {
    if (!controller.signal.aborted && elapsedMs() >= deadlineMs) {
      controller.abort(new DashboardReadinessError('DASHBOARD_READINESS_DEADLINE_EXCEEDED'));
    }
    if (controller.signal.aborted) throw controller.signal.reason;
  };
  return {
    runId,
    signal: controller.signal,
    get stage() { return stage; },
    elapsedMs,
    throwIfAborted,
    report(nextStage, counters = {}) {
      if (disposed || controller.signal.aborted || !DASHBOARD_READINESS_STAGES.includes(nextStage)) return;
      throwIfAborted();
      stage = nextStage;
      const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 1_000_000 ? value : undefined;
      const completed = count(counters.completed);
      const total = count(counters.total);
      const targetId = safeIdentifier(counters.targetId);
      const event: DashboardReadinessProgressEvent = { type: 'progress', runId, stage, elapsedMs: elapsedMs(),
        ...(completed !== undefined ? { completed } : {}), ...(total !== undefined ? { total } : {}), ...(targetId ? { targetId } : {}) };
      try { options.onProgress?.(event); } catch { /* Progress cannot turn a successful read into a retry. */ }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(timeout);
      options.signal?.removeEventListener('abort', cancel);
      controller.abort(new DashboardReadinessError('DASHBOARD_READINESS_CANCELED'));
    },
  };
}

/** The callback must check context.throwIfAborted immediately before saving its plan. */
export function dashboardReadinessStream(
  requestSignal: AbortSignal,
  inspectAndSave: (context: DashboardReadinessRunContext) => Promise<DashboardDeploymentPlan>,
  options: Omit<DashboardReadinessRunOptions, 'signal'> = {},
): Response {
  const cancellation = new AbortController();
  let context: DashboardReadinessRunContext | undefined;
  let closed = false;
  let removeAbortListener: () => void = () => undefined;
  const cleanup = () => { removeAbortListener(); context?.dispose(); };
  const stream = new ReadableStream<Uint8Array>({
    start(output) {
      const encoder = new TextEncoder();
      const send = (event: DashboardReadinessEvent) => {
        if (!closed) output.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
      };
      context = createDashboardReadinessContext({ ...options,
        signal: AbortSignal.any([requestSignal, cancellation.signal]),
        onProgress(event) {
          if (!closed) { send(event); options.onProgress?.(event); }
        },
      });
      const run = context;
      const close = () => {
        if (closed) return;
        closed = true;
        cleanup();
        output.close();
      };
      const fail = (error: unknown) => {
        if (closed) return;
        const actual = run.signal.aborted ? run.signal.reason : error;
        const code = actual instanceof DashboardReadinessError && Object.hasOwn(ERROR_MESSAGES, actual.code)
          ? actual.code : 'DASHBOARD_READINESS_FAILED';
        send({ type: 'error', runId: run.runId, code, error: ERROR_MESSAGES[code], stage: run.stage, elapsedMs: run.elapsedMs() });
        close();
      };
      const onAbort = () => fail(run.signal.reason);
      run.signal.addEventListener('abort', onAbort, { once: true });
      removeAbortListener = () => run.signal.removeEventListener('abort', onAbort);
      if (run.signal.aborted) { onAbort(); return; }
      run.report('source_dashboard', { completed: 0 });
      // The abort listener closes independently even if a buggy dependency never settles.
      void Promise.resolve().then(() => {
        run.throwIfAborted();
        return inspectAndSave(run);
      }).then((plan) => {
        if (closed) return;
        run.throwIfAborted();
        run.report('complete');
        send({ type: 'complete', runId: run.runId, plan });
        close();
      }).catch(fail);
    },
    cancel() {
      closed = true;
      cancellation.abort();
      cleanup();
    },
  });
  return new Response(stream, { headers: {
    'Content-Type': 'application/x-ndjson', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff', 'X-Accel-Buffering': 'no',
  } });
}
