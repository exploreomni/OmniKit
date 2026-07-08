import { PageHeader } from '@/components/layout/PageHeader';
import { DashboardMigrationWizard } from '@/components/dashboardMigration/DashboardMigrationWizard';
import { Blobby } from '@/components/ui/Blobby';

export function MigratePage() {
  return (
    <div className="space-y-5">
      <PageHeader
        title="Dashboard Migrator"
        description="Copy dashboards from one Omni connection to one or more destinations. Choose the destination instance, connection, model, folder, topic handling, and same-name update strategy, then review optional cleanup before anything runs."
        icon={<Blobby mood="migration" size={58} className="animate-float" style={{ animationDuration: '3.4s' }} />}
      />
      <DashboardMigrationWizard />
    </div>
  );
}
