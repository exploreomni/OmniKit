import { useLocation, useNavigate, useSearchParams } from 'react-router';
import { Activity, Shield, Upload, Users } from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { Blobby } from '@/components/ui/Blobby';
import { UsersPage } from '@/pages/UsersPage';
import { GroupsPage } from '@/pages/GroupsPage';
import { UserHealthPage } from '@/pages/UserHealthPage';
import { BulkIdentityImportPage } from '@/pages/BulkIdentityImportPage';
import { AdminReadinessPanel } from '@/components/admin/CapabilityStatus';
import { IdentityAccessDebugger } from '@/components/admin/IdentityAccessDebugger';
import { useConnection } from '@/hooks/useConnection';

type UserManagementTab = 'users' | 'groups' | 'import' | 'health';

export function UserManagementPage() {
  const { connection } = useConnection();
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const rawTab = searchParams.get('tab');
  const activeTab: UserManagementTab = rawTab === 'groups' || rawTab === 'import' || rawTab === 'health' ? rawTab : 'users';
  const isIdentityWorkspaceRoute = location.pathname === '/admin/identity/users';

  function setTab(tab: UserManagementTab) {
    const nextSearchParams = new URLSearchParams(searchParams);
    nextSearchParams.delete('tab');
    if (tab !== 'users') nextSearchParams.set('tab', tab);
    const nextSearch = nextSearchParams.toString();
    navigate({
      pathname: location.pathname,
      search: nextSearch ? `?${nextSearch}` : '',
      hash: location.hash,
    });
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="User Management"
        description="Provision users, manage groups, review activity, and apply users and memberships from one validated bulk import."
        icon={<Blobby mood="users" size={58} className="animate-float" style={{ animationDuration: '3.5s' }} />}
      />

      <AdminReadinessPanel
        workspace="identity"
        instanceId={connection.instanceId}
        baseUrl={connection.baseUrl}
      />

      {!isIdentityWorkspaceRoute && (
        <div className="card flex w-full gap-1 overflow-x-auto p-1.5 sm:w-auto" role="tablist" aria-label="User management views">
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'users'}
            onClick={() => setTab('users')}
            className={`px-4 py-2 rounded-button text-sm font-semibold transition-colors inline-flex items-center gap-2 ${
              activeTab === 'users' ? 'bg-omni-700 text-white shadow-sm' : 'text-content-secondary hover:bg-surface-secondary'
            }`}
          >
            <Users size={14} />
            Users
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'groups'}
            onClick={() => setTab('groups')}
            className={`px-4 py-2 rounded-button text-sm font-semibold transition-colors inline-flex items-center gap-2 ${
              activeTab === 'groups' ? 'bg-omni-700 text-white shadow-sm' : 'text-content-secondary hover:bg-surface-secondary'
            }`}
          >
            <Shield size={14} />
            Groups
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'import'}
            onClick={() => setTab('import')}
            className={`px-4 py-2 rounded-button text-sm font-semibold transition-colors inline-flex items-center gap-2 ${
              activeTab === 'import' ? 'bg-omni-700 text-white shadow-sm' : 'text-content-secondary hover:bg-surface-secondary'
            }`}
          >
            <Upload size={14} />
            Bulk Import
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={activeTab === 'health'}
            onClick={() => setTab('health')}
            className={`px-4 py-2 rounded-button text-sm font-semibold transition-colors inline-flex items-center gap-2 ${
              activeTab === 'health' ? 'bg-omni-700 text-white shadow-sm' : 'text-content-secondary hover:bg-surface-secondary'
            }`}
          >
            <Activity size={14} />
            User Health
          </button>
        </div>
      )}

      {activeTab === 'users' && <UsersPage embedded />}
      {activeTab === 'groups' && <GroupsPage embedded />}
      {activeTab === 'import' && <BulkIdentityImportPage />}
      {activeTab === 'health' && (
        <div className="space-y-5">
          <IdentityAccessDebugger connection={connection} />
          <UserHealthPage />
        </div>
      )}
    </div>
  );
}
