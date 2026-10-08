import type { MigrationJob } from '@/services/opsConsole';
import { dashboardPackageHistorySummary } from './dashboardPackagePresentation';

export function DashboardPackageHistoryCounts({ job }: { job: MigrationJob }) {
  const summary = dashboardPackageHistorySummary(job);
  if (!summary) return <p className="mt-3 text-xs text-content-secondary">Details not loaded. Open Details to inspect the saved dashboard and step evidence.</p>;
  return <div className="mt-3 grid gap-2 text-xs sm:grid-cols-4" aria-label="Dashboard package progress">
    {[[summary.createdCount, 'Dashboards created'], [summary.verifiedCount, 'Verified'],
      [summary.pendingVerificationCount, 'Verification pending'], [summary.stepCount, 'Recorded steps']].map(([count, label]) =>
      <div key={label} className="rounded-card bg-surface-secondary p-2"><span className="font-semibold">{count}</span><br />{label}</div>)}
  </div>;
}
