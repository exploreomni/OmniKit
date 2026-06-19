import { useSearchParams } from 'react-router-dom';
import { Activity, Shield, Users } from 'lucide-react';
import { PageHeader } from '@/components/layout/PageHeader';
import { Blobby } from '@/components/ui/Blobby';
import { UsersPage } from '@/pages/UsersPage';
import { GroupsPage } from '@/pages/GroupsPage';
import { UserHealthPage } from '@/pages/UserHealthPage';

type UserManagementTab = 'users' | 'groups' | 'health';

export function UserManagementPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const rawTab = searchParams.get('tab');
  const activeTab: UserManagementTab = rawTab === 'groups' || rawTab === 'health' ? rawTab : 'users';

  function setTab(tab: UserManagementTab) {
    setSearchParams(tab === 'users' ? {} : { tab });
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="User Management"
        description="Provision users, archive stale accounts, and bulk manage group membership from one migration-friendly workflow."
        icon={<Blobby mood="users" size={58} className="animate-float" style={{ animationDuration: '3.5s' }} />}
      />

      <div className="card p-1.5 inline-flex gap-1">
        <button
          type="button"
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
          onClick={() => setTab('health')}
          className={`px-4 py-2 rounded-button text-sm font-semibold transition-colors inline-flex items-center gap-2 ${
            activeTab === 'health' ? 'bg-omni-700 text-white shadow-sm' : 'text-content-secondary hover:bg-surface-secondary'
          }`}
        >
          <Activity size={14} />
          User Health
        </button>
      </div>

      {activeTab === 'users' && <UsersPage embedded />}
      {activeTab === 'groups' && <GroupsPage embedded />}
      {activeTab === 'health' && <UserHealthPage />}
    </div>
  );
}
