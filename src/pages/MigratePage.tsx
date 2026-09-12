import { lazy, Suspense } from 'react';

import { PageHeader } from '@/components/layout/PageHeader';
import { DashboardSafeCopyFlow } from '@/components/dashboardMigration/DashboardSafeCopyFlow';
import { Blobby } from '@/components/ui/Blobby';

const LegacyDashboardMigrationWizard = lazy(() => (
  import('@/components/dashboardMigration/DashboardMigrationWizard')
    .then((module) => ({ default: module.DashboardMigrationWizard }))
));

export function MigratePage() {
  const safeCopyEnabled = import.meta.env.VITE_OMNIKIT_SAFE_COPY_V1_INTERNAL !== 'false';
  const legacyRollbackEnabled = import.meta.env.VITE_OMNIKIT_LEGACY_DASHBOARD_MIGRATOR_INTERNAL === 'true';

  return (
    <div className="space-y-5">
      <PageHeader
        title="Dashboard Migrator"
        description={legacyRollbackEnabled
          ? 'Internal rollback mode for the legacy dashboard migration workflow.'
          : !safeCopyEnabled
            ? 'Dashboard migration is temporarily unavailable while the safe-copy workflow is disabled.'
          : 'Choose dashboards, check each destination, and deploy with visible progress and verification.'}
        icon={<Blobby mood="migration" size={58} className="motion-safe:animate-float" style={{ animationDuration: '3.4s' }} />}
      />
      {legacyRollbackEnabled ? (
        <Suspense fallback={<div className="card p-6 text-sm text-content-secondary" role="status">Loading internal rollback workflow...</div>}>
          <LegacyDashboardMigrationWizard />
        </Suspense>
      ) : safeCopyEnabled ? <DashboardSafeCopyFlow /> : (
        <div className="card p-6" role="status">
          <h2 className="font-display text-xl font-semibold text-content">Dashboard migration is temporarily unavailable</h2>
          <p className="mt-2 text-sm text-content-secondary">
            Safe-copy has been disabled by the local operator. Existing migration history remains available from activity views.
          </p>
        </div>
      )}
    </div>
  );
}
