import { useEffect, useState } from 'react';
import type { DashboardReadinessProgressEvent } from '@/services/dashboardDeploymentPlans';
import { DASHBOARD_READINESS_STAGE_LABELS } from './dashboardReadinessPresentation';

export function DashboardReadinessProgress({ progress, startedAt, targetLabel }: {
  progress?: DashboardReadinessProgressEvent | null;
  startedAt: number;
  targetLabel?: string;
}) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    // A local elapsed-time display, not a server poll or a simulated completion estimate.
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [startedAt]);
  const seconds = Math.floor(Math.max(progress?.elapsedMs || 0, now - startedAt, 0) / 1_000);
  const stage = progress ? DASHBOARD_READINESS_STAGE_LABELS[progress.stage] : 'Waiting for the readiness check to start';
  return <div className="mt-2 space-y-1 text-xs leading-5 text-content-secondary">
    <p role="status" aria-live="polite">{stage}{targetLabel ? ` · ${targetLabel}` : ''}</p>
    <p><span aria-live="off">{seconds}s elapsed</span>{progress?.completed !== undefined && <span> · {progress.completed}{progress.total !== undefined ? ` of ${progress.total}` : ''} items in this stage</span>}</p>
    <p>No dashboards or models are changed by this check. No completion percentage is estimated.</p>
  </div>;
}
