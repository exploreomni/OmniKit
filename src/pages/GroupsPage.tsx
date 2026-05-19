import { useState, useEffect, useCallback, useMemo } from 'react';
import { ChevronDown, ChevronRight, Download, Loader2, UserPlus, UserMinus, Upload, X } from 'lucide-react';
import { listGroups, getGroup, updateGroup, findUserByEmail, listAllUsers } from '@/services/omniApi';
import { useConnection } from '@/contexts/ConnectionContext';
import { PageHeader } from '@/components/layout/PageHeader';
import { SearchInput } from '@/components/ui/SearchInput';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Blobby } from '@/components/ui/Blobby';
import { WorkflowStatusScene } from '@/components/ui/WorkflowStatusScene';
import { friendlyApiError } from '@/utils/apiErrors';
import type { OmniGroup, OmniUser } from '@/types';

function AddMemberModal({
  open,
  groupName,
  onClose,
  onAdd,
}: {
  open: boolean;
  groupName: string;
  onClose: () => void;
  onAdd: (email: string) => Promise<void>;
}) {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  if (!open) return null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email) return;
    setLoading(true);
    setError('');
    try {
      await onAdd(email);
      setEmail('');
      onClose();
    } catch (err) {
      setError(friendlyApiError(err, 'Failed to add member'));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white rounded-card shadow-dropdown p-6 max-w-sm w-full mx-4">
        <button onClick={onClose} className="absolute top-4 right-4 text-content-secondary hover:text-content-primary">
          <X size={18} />
        </button>
        <h3 className="text-lg font-semibold text-content-primary mb-1">Add Member</h3>
        <p className="text-xs text-content-secondary mb-4">Add a user to "{groupName}" by email.</p>
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 text-xs px-3 py-2 rounded mb-3">{error}</div>
        )}
        <form onSubmit={handleSubmit} className="space-y-4">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="input-field"
            placeholder="user@example.com"
          />
          <div className="flex justify-end gap-3">
            <button type="button" onClick={onClose} className="btn-secondary text-sm">Cancel</button>
            <button type="submit" disabled={loading || !email} className="btn-primary text-sm">
              {loading ? <Loader2 size={14} className="animate-spin" /> : <UserPlus size={14} />}
              Add Member
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function CsvGroupImportModal({
  open,
  onClose,
  onImport,
}: {
  open: boolean;
  onClose: () => void;
  onImport: (rows: Array<{ email: string; group_name: string; op: string }>) => void;
}) {
  const [csvText, setCsvText] = useState('');
  const [error, setError] = useState('');

  if (!open) return null;

  function handleParse() {
    setError('');
    const lines = csvText.trim().split('\n');
    if (lines.length < 2) {
      setError('CSV must have a header row and at least one data row');
      return;
    }
    const headers = lines[0].split(',').map((h) => h.trim());
    if (!headers.includes('email') || !headers.includes('group_name') || !headers.includes('op')) {
      setError('CSV must have columns: email, group_name, op');
      return;
    }
    const rows = lines.slice(1).map((line) => {
      const values = line.split(',').map((v) => v.trim());
      const row: Record<string, string> = {};
      headers.forEach((h, i) => { row[h] = values[i] || ''; });
      return row as { email: string; group_name: string; op: string };
    });
    onImport(rows);
    onClose();
    setCsvText('');
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white rounded-card shadow-dropdown p-6 max-w-lg w-full mx-4">
        <button onClick={onClose} className="absolute top-4 right-4 text-content-secondary hover:text-content-primary">
          <X size={18} />
        </button>
        <h3 className="text-lg font-semibold text-content-primary mb-2">Bulk Group Migration Assignment</h3>
        <p className="text-xs text-content-secondary mb-4">
          Paste migrated membership mappings after users are provisioned. Required columns:
          email, group_name, op. Use op=add or op=remove.
        </p>
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 text-xs px-3 py-2 rounded mb-3">{error}</div>
        )}
        <textarea
          value={csvText}
          onChange={(e) => setCsvText(e.target.value)}
          className="input-field font-mono text-xs h-40 resize-none"
          placeholder="email,group_name,op&#10;user@example.com,Admins,add&#10;old@example.com,Viewers,remove"
        />
        <div className="flex justify-end gap-3 mt-4">
          <button onClick={onClose} className="btn-secondary text-sm">Cancel</button>
          <button onClick={handleParse} disabled={!csvText.trim()} className="btn-primary text-sm">
            <Upload size={14} />
            Import
          </button>
        </div>
      </div>
    </div>
  );
}

function csvEscape(value: string | number | boolean | undefined | null): string {
  const text = value == null ? '' : String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function downloadCsv(fileName: string, rows: string[][]) {
  const csv = rows.map((row) => row.map(csvEscape).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function GroupsPage({ embedded = false }: { embedded?: boolean } = {}) {
  const { connection } = useConnection();
  const [groups, setGroups] = useState<OmniGroup[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [detailedGroups, setDetailedGroups] = useState<Record<string, OmniGroup>>({});
  const [loadingDetail, setLoadingDetail] = useState<string | null>(null);
  const [addMemberGroup, setAddMemberGroup] = useState<OmniGroup | null>(null);
  const [removeMember, setRemoveMember] = useState<{ group: OmniGroup; memberId: string; memberName: string } | null>(null);
  const [showCsvImport, setShowCsvImport] = useState(false);
  const [importProgress, setImportProgress] = useState<{ current: number; total: number; results: string[] } | null>(null);
  const [searchFilter, setSearchFilter] = useState('');
  const [exportingMemberships, setExportingMemberships] = useState(false);
  const [exportNotice, setExportNotice] = useState('');
  const [assignUsers, setAssignUsers] = useState<OmniUser[]>([]);
  const [loadingAssignUsers, setLoadingAssignUsers] = useState(false);
  const [assignUserSearch, setAssignUserSearch] = useState('');
  const [selectedAssignUserIds, setSelectedAssignUserIds] = useState<Set<string>>(new Set());
  const [bulkAssignGroupId, setBulkAssignGroupId] = useState('');
  const [assigningUsers, setAssigningUsers] = useState(false);
  const [assignResults, setAssignResults] = useState<string[]>([]);

  const fetchGroups = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const allGroups: OmniGroup[] = [];
      let startIndex = 1;
      const count = 100;
      while (true) {
        const res = await listGroups(connection.baseUrl, connection.apiKey, count, startIndex);
        if (res.error) {
          setError(friendlyApiError(res.error, 'Failed to load groups'));
          break;
        }
        const resources = (res.Resources || []).map((g: Record<string, unknown>) => ({
          id: g.id as string,
          displayName: g.displayName as string,
          members: (g.members as OmniGroup['members']) || [],
        }));
        allGroups.push(...resources);
        if ((res.totalResults || 0) <= startIndex + count - 1) break;
        startIndex += count;
      }
      setGroups(allGroups);
    } catch (err) {
      setError(friendlyApiError(err, 'Failed to load groups'));
    } finally {
      setLoading(false);
    }
  }, [connection.baseUrl, connection.apiKey]);

  useEffect(() => {
    fetchGroups();
  }, [fetchGroups]);

  async function toggleExpand(groupId: string) {
    const next = new Set(expandedIds);
    if (next.has(groupId)) {
      next.delete(groupId);
    } else {
      next.add(groupId);
      setBulkAssignGroupId(groupId);
      if (!detailedGroups[groupId]) {
        setLoadingDetail(groupId);
        try {
          const detail = await getGroup(connection.baseUrl, connection.apiKey, groupId);
          setDetailedGroups((prev) => ({
            ...prev,
            [groupId]: {
              id: detail.id,
              displayName: detail.displayName,
              members: detail.members || [],
            },
          }));
        } catch {
          // use basic data
        } finally {
          setLoadingDetail(null);
        }
      }
    }
    setExpandedIds(next);
  }

  async function handleAddMember(email: string) {
    if (!addMemberGroup) return;
    const userRes = await findUserByEmail(connection.baseUrl, connection.apiKey, email);
    const users = userRes.Resources || [];
    if (users.length !== 1) throw new Error(users.length === 0 ? 'User not found' : 'Multiple users found');

    const userId = users[0].id as string;
    const detail = detailedGroups[addMemberGroup.id] || addMemberGroup;
    const updatedMembers = [...detail.members, { display: email, value: userId }];
    await updateGroup(connection.baseUrl, connection.apiKey, addMemberGroup.id, {
      ...detail,
      members: updatedMembers,
    });

    setDetailedGroups((prev) => ({
      ...prev,
      [addMemberGroup.id]: { ...detail, members: updatedMembers },
    }));
    fetchGroups();
  }

  async function handleRemoveMember() {
    if (!removeMember) return;
    const { group, memberId } = removeMember;
    const detail = detailedGroups[group.id] || group;
    const updatedMembers = detail.members.filter((m) => m.value !== memberId);

    try {
      await updateGroup(connection.baseUrl, connection.apiKey, group.id, {
        ...detail,
        members: updatedMembers,
      });
      setDetailedGroups((prev) => ({
        ...prev,
        [group.id]: { ...detail, members: updatedMembers },
      }));
      fetchGroups();
    } catch (err) {
      setError(friendlyApiError(err, 'Failed to remove member'));
    }
    setRemoveMember(null);
  }

  async function handleCsvImport(rows: Array<{ email: string; group_name: string; op: string }>) {
    setImportProgress({ current: 0, total: rows.length, results: [] });

    for (let i = 0; i < rows.length; i++) {
      const { email, group_name, op } = rows[i];
      let message = '';
      try {
        const targetGroup = groups.find((g) => g.displayName.toLowerCase() === group_name.toLowerCase());
        if (!targetGroup) {
          message = `Skipped ${email}: group "${group_name}" not found`;
          continue;
        }

        const userRes = await findUserByEmail(connection.baseUrl, connection.apiKey, email);
        const users = userRes.Resources || [];
        if (users.length !== 1) {
          message = `Skipped ${email}: ${users.length === 0 ? 'user not found' : 'multiple users found'}`;
          continue;
        }

        const userId = users[0].id as string;
        const detail = detailedGroups[targetGroup.id] || await getGroup(connection.baseUrl, connection.apiKey, targetGroup.id);

        if (op === 'add') {
          if ((detail.members || []).some((member: { value: string }) => member.value === userId)) {
            message = `Skipped ${email}: already in ${targetGroup.displayName}`;
            continue;
          }
          const updatedMembers = [...(detail.members || []), { display: email, value: userId }];
          await updateGroup(connection.baseUrl, connection.apiKey, targetGroup.id, { ...detail, members: updatedMembers });
          message = `Added ${email} to ${targetGroup.displayName}`;
        } else if (op === 'remove') {
          const updatedMembers = (detail.members || []).filter((m: { value: string }) => m.value !== userId);
          await updateGroup(connection.baseUrl, connection.apiKey, targetGroup.id, { ...detail, members: updatedMembers });
          message = `Removed ${email} from ${targetGroup.displayName}`;
        } else {
          message = `Skipped ${email}: op must be add or remove`;
        }
      } catch (err) {
        message = `Error ${email}: ${err instanceof Error ? err.message : 'unknown error'}`;
      } finally {
        setImportProgress((prev) => ({
          current: i + 1,
          total: rows.length,
          results: [...(prev?.results || []), message || `Processed ${email}`],
        }));
      }
      await new Promise((r) => setTimeout(r, 500));
    }

    fetchGroups();
  }

  function handleDownloadTemplate() {
    downloadCsv('omnikit-group-assignment-template.csv', [
      ['email', 'group_name', 'op'],
      ['user@example.com', 'Admins', 'add'],
      ['former.user@example.com', 'Viewers', 'remove'],
    ]);
    showExportNotice('Group assignment template download started.');
  }

  async function handleDownloadGroupAssignments() {
    setExportingMemberships(true);
    setError('');
    const rows: string[][] = [['email', 'group_name', 'op']];

    try {
      const nextDetailedGroups: Record<string, OmniGroup> = {};
      for (const group of groups) {
        let detail = detailedGroups[group.id] || group;
        if (!detailedGroups[group.id]) {
          const fetched = await getGroup(connection.baseUrl, connection.apiKey, group.id);
          detail = {
            id: fetched.id,
            displayName: fetched.displayName,
            members: fetched.members || [],
          };
          nextDetailedGroups[group.id] = detail;
        }

        const members = detail.members || [];
        if (members.length === 0) {
          rows.push(['', group.displayName, 'add']);
        } else {
          for (const member of members) {
            rows.push([member.display || member.value, group.displayName, 'add']);
          }
        }
      }

      if (Object.keys(nextDetailedGroups).length > 0) {
        setDetailedGroups((prev) => ({ ...prev, ...nextDetailedGroups }));
      }
      downloadCsv('omnikit-current-group-memberships.csv', rows);
      showExportNotice(`Group membership export started (${groups.length} groups).`);
    } catch (err) {
      setError(friendlyApiError(err, 'Failed to export group memberships'));
    } finally {
      setExportingMemberships(false);
    }
  }

  function showExportNotice(message: string) {
    setExportNotice(message);
    window.setTimeout(() => setExportNotice(''), 4000);
  }

  async function loadUsersForAssignment() {
    setLoadingAssignUsers(true);
    setError('');
    try {
      const res = await listAllUsers(connection.baseUrl, connection.apiKey, { pageSize: 100, maxPages: 200 });
      if (res.error) throw new Error(friendlyApiError(res.error, 'Failed to load users'));
      const allUsers = (res.Resources || []).map((user: Record<string, unknown>) => ({
        id: user.id as string,
        userName: user.userName as string,
        displayName: (user.displayName as string) || '',
        active: user.active as boolean,
        groups: (user.groups as OmniUser['groups']) || [],
      }));
      setAssignUsers(allUsers);
    } catch (err) {
      setError(friendlyApiError(err, 'Failed to load users for assignment'));
    } finally {
      setLoadingAssignUsers(false);
    }
  }

  function toggleAssignmentUser(userId: string) {
    setAssignResults([]);
    setSelectedAssignUserIds((prev) => {
      const next = new Set(prev);
      if (next.has(userId)) next.delete(userId);
      else next.add(userId);
      return next;
    });
  }

  function toggleVisibleAssignmentUsers() {
    setAssignResults([]);
    const visibleIds = filteredAssignUsers.map((user) => user.id);
    const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => selectedAssignUserIds.has(id));
    setSelectedAssignUserIds((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        visibleIds.forEach((id) => next.delete(id));
      } else {
        visibleIds.forEach((id) => next.add(id));
      }
      return next;
    });
  }

  async function handleAssignSelectedUsersToGroup() {
    const targetGroup = groups.find((group) => group.id === bulkAssignGroupId);
    const selectedUsers = assignUsers.filter((user) => selectedAssignUserIds.has(user.id));
    if (!targetGroup || selectedUsers.length === 0) return;

    setAssigningUsers(true);
    setAssignResults([]);
    setError('');

    try {
      const currentDetail = detailedGroups[targetGroup.id] || await getGroup(connection.baseUrl, connection.apiKey, targetGroup.id);
      const detail: OmniGroup = {
        id: currentDetail.id,
        displayName: currentDetail.displayName,
        members: currentDetail.members || [],
      };
      const existingMemberIds = new Set((detail.members || []).map((member) => member.value));
      const additions = selectedUsers
        .filter((user) => !existingMemberIds.has(user.id))
        .map((user) => ({ value: user.id, display: user.userName || user.displayName }));

      if (additions.length === 0) {
        setAssignResults([`Skipped: all ${selectedUsers.length} selected users are already in ${targetGroup.displayName}.`]);
        return;
      }

      const updatedGroup = { ...detail, members: [...(detail.members || []), ...additions] };
      await updateGroup(connection.baseUrl, connection.apiKey, targetGroup.id, updatedGroup);
      setDetailedGroups((prev) => ({ ...prev, [targetGroup.id]: updatedGroup }));
      setAssignResults([
        `Added ${additions.length} user${additions.length === 1 ? '' : 's'} to ${targetGroup.displayName}.`,
        selectedUsers.length - additions.length > 0
          ? `Skipped ${selectedUsers.length - additions.length} already-existing membership${selectedUsers.length - additions.length === 1 ? '' : 's'}.`
          : '',
      ].filter(Boolean));
      setSelectedAssignUserIds(new Set());
      fetchGroups();
    } catch (err) {
      setError(friendlyApiError(err, 'Failed to assign users to group'));
    } finally {
      setAssigningUsers(false);
    }
  }

  const filteredAssignUsers = useMemo(() => {
    const term = assignUserSearch.trim().toLowerCase();
    if (!term) return assignUsers;
    return assignUsers.filter((user) =>
      user.userName.toLowerCase().includes(term) ||
      (user.displayName || '').toLowerCase().includes(term),
    );
  }, [assignUsers, assignUserSearch]);

  const selectedAssignUsers = useMemo(
    () => assignUsers.filter((user) => selectedAssignUserIds.has(user.id)),
    [assignUsers, selectedAssignUserIds],
  );

  const filteredGroups = searchFilter
    ? groups.filter((g) => g.displayName.toLowerCase().includes(searchFilter.toLowerCase()))
    : groups;
  const selectedBulkGroup = groups.find((group) => group.id === bulkAssignGroupId);
  const headerActions = (
    <div className="flex flex-wrap gap-2">
      <button onClick={handleDownloadTemplate} className="btn-secondary text-sm">
        <Download size={14} />
        CSV Template
      </button>
      <button onClick={handleDownloadGroupAssignments} disabled={groups.length === 0 || exportingMemberships} className="btn-secondary text-sm disabled:opacity-40">
        {exportingMemberships ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
        {exportingMemberships ? 'Preparing...' : 'Export Memberships'}
      </button>
      <button onClick={() => setShowCsvImport(true)} className="btn-secondary text-sm">
        <Upload size={14} />
        Import CSV
      </button>
    </div>
  );

  return (
    <div className="space-y-5">
      {!embedded ? (
        <PageHeader
          title="Group Management"
          description={`Bulk assign migrated users to Omni groups through SCIM. ${groups.length} groups found.`}
          icon={<Blobby mood="groups" size={58} className="animate-float" style={{ animationDuration: '3.6s' }} />}
          actions={headerActions}
        />
      ) : (
        <div className="card p-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <div className="text-sm font-semibold text-content-primary">Groups</div>
            <p className="text-xs text-content-secondary mt-0.5">
              Find a group, review current members, then add users directly or use CSV for migration batches.
            </p>
          </div>
          {headerActions}
        </div>
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-card">{error}</div>
      )}

      {exportNotice && (
        <div className="bg-green-50 border border-green-200 text-green-700 text-sm px-4 py-3 rounded-card">
          {exportNotice} If you are using the in-app preview, the file may appear in the host browser downloads instead of inside the preview pane.
        </div>
      )}

      <div className="grid md:grid-cols-3 gap-3">
        <div className="card p-4">
          <div className="text-xs font-medium text-content-secondary uppercase tracking-wider">Step 1</div>
          <div className="mt-2 text-sm font-semibold text-content-primary">Choose a group</div>
          <p className="mt-1 text-xs text-content-secondary leading-5">Search and open the group first so membership changes have a clear target.</p>
        </div>
        <div className="card p-4">
          <div className="text-xs font-medium text-content-secondary uppercase tracking-wider">Step 2</div>
          <div className="mt-2 text-sm font-semibold text-content-primary">Review members</div>
          <p className="mt-1 text-xs text-content-secondary leading-5">Expand the group to confirm who already belongs before adding or removing users.</p>
        </div>
        <div className="card p-4">
          <div className="text-xs font-medium text-content-secondary uppercase tracking-wider">Step 3</div>
          <div className="mt-2 text-sm font-semibold text-content-primary">Apply updates</div>
          <p className="mt-1 text-xs text-content-secondary leading-5">Add selected users to that group, or use CSV when a migration batch needs add/remove actions.</p>
        </div>
      </div>

      {importProgress && (
        <div className="card bg-surface-secondary space-y-3">
          <WorkflowStatusScene
            variant="bulk-upload"
            title={importProgress.current < importProgress.total ? 'Applying group assignments' : 'Group assignment import complete'}
            detail="Resolving users and updating group membership one row at a time."
            statusLabel={importProgress.current < importProgress.total ? 'Assigning' : 'Complete'}
            progressLabel={`${importProgress.current}/${importProgress.total} assignments processed`}
            compact
          />
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-sm font-medium text-content-primary">
                {importProgress.current < importProgress.total ? 'Processing group assignments...' : 'Group assignment import complete'} {importProgress.current}/{importProgress.total}
              </div>
              <div className="text-xs text-content-secondary mt-0.5">Processed sequentially to keep SCIM updates controlled during migration setup.</div>
            </div>
            {importProgress.current >= importProgress.total && (
              <button onClick={() => setImportProgress(null)} className="p-1 text-content-secondary hover:text-content-primary rounded-button hover:bg-white">
                <X size={14} />
              </button>
            )}
          </div>
          <div className="w-full h-2 bg-gray-200 rounded-full overflow-hidden">
            <div
              className="h-full bg-omni-700 rounded-full transition-all duration-300"
              style={{ width: `${(importProgress.current / importProgress.total) * 100}%` }}
            />
          </div>
          {importProgress.results.length > 0 && (
            <div className="max-h-32 overflow-y-auto rounded-card border border-border bg-white divide-y divide-border/50">
              {importProgress.results.slice(-12).map((message, index) => (
                <div key={`${message}-${index}`} className="px-3 py-2 text-xs text-content-secondary">
                  {message}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="card space-y-3">
        <div className="flex flex-col gap-2 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="text-sm font-semibold text-content-primary">Choose and review a group</div>
            <p className="text-xs text-content-secondary mt-0.5">
              Select a target group for bulk assignment, or open a group below to review current members.
            </p>
          </div>
          {selectedBulkGroup && (
            <div className="rounded-chip border border-omni-200 bg-omni-50 px-3 py-1 text-xs font-medium text-omni-800">
              Selected: {selectedBulkGroup.displayName}
            </div>
          )}
        </div>
        <div>
          <SearchInput value={searchFilter} onChange={setSearchFilter} placeholder="Filter groups..." />
        </div>
      </div>

      <div className="card space-y-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <div className="text-sm font-semibold text-content-primary">Add multiple users to a group</div>
            <p className="text-xs text-content-secondary mt-0.5">
              {selectedBulkGroup
                ? `Bulk add users to ${selectedBulkGroup.displayName}. Use CSV for larger migration files or remove actions.`
                : 'Choose a target group, then load users and add selected people to that group.'}
            </p>
          </div>
          <button
            type="button"
            onClick={loadUsersForAssignment}
            disabled={loadingAssignUsers || !selectedBulkGroup}
            className="btn-secondary text-sm disabled:opacity-40"
          >
            {loadingAssignUsers ? <Loader2 size={14} className="animate-spin" /> : <UserPlus size={14} />}
            {assignUsers.length > 0 ? 'Refresh Users' : 'Load Users'}
          </button>
        </div>

        <div className="grid gap-3 lg:grid-cols-[minmax(220px,320px)_minmax(0,1fr)_auto] lg:items-center">
          <div className="rounded-button border border-border bg-surface-secondary px-3 py-2">
            <div className="text-[10px] font-medium uppercase tracking-wider text-content-secondary">Target group</div>
            <select
              value={bulkAssignGroupId}
              onChange={(event) => {
                setBulkAssignGroupId(event.target.value);
                setAssignResults([]);
              }}
              className="mt-1 w-full bg-transparent text-sm font-semibold text-content-primary outline-none"
            >
              <option value="">Select a group...</option>
              {groups.map((group) => (
                <option key={group.id} value={group.id}>{group.displayName}</option>
              ))}
            </select>
          </div>
          <SearchInput value={assignUserSearch} onChange={setAssignUserSearch} placeholder="Filter users by email or name..." />
          <button
            type="button"
            onClick={toggleVisibleAssignmentUsers}
            disabled={filteredAssignUsers.length === 0 || !selectedBulkGroup}
            className="btn-secondary text-sm whitespace-nowrap disabled:opacity-40"
          >
            {filteredAssignUsers.length > 0 && filteredAssignUsers.every((user) => selectedAssignUserIds.has(user.id))
              ? 'Clear Visible'
              : `Select Visible (${filteredAssignUsers.length})`}
          </button>
        </div>

        {!selectedBulkGroup ? (
          <div className="rounded-card border border-border bg-surface-secondary p-4 text-sm text-content-secondary">
            Select a target group before assigning users.
          </div>
        ) : assignUsers.length === 0 ? (
          <div className="rounded-card border border-border bg-surface-secondary p-4 text-sm text-content-secondary">
            Load users to assign group membership from the UI.
          </div>
        ) : (
          <div className="rounded-card border border-border overflow-hidden">
            <div className="max-h-52 overflow-y-auto divide-y divide-border/50 bg-white">
              {filteredAssignUsers.length === 0 ? (
                <div className="px-4 py-8 text-center text-sm text-content-secondary">No users match this filter.</div>
              ) : (
                filteredAssignUsers.map((user) => (
                  <label key={user.id} className="flex items-center gap-3 px-4 py-2.5 hover:bg-surface-secondary cursor-pointer">
                    <input
                      type="checkbox"
                      checked={selectedAssignUserIds.has(user.id)}
                      onChange={() => toggleAssignmentUser(user.id)}
                      className="accent-omni-700"
                    />
                    <div className="min-w-0">
                      <div className="text-sm font-medium text-content-primary truncate">{user.userName}</div>
                      <div className="text-xs text-content-secondary truncate">{user.displayName || 'No display name'}</div>
                    </div>
                  </label>
                ))
              )}
            </div>
          </div>
        )}

        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="text-xs text-content-secondary">
            {selectedAssignUsers.length} selected user{selectedAssignUsers.length === 1 ? '' : 's'}.
          </div>
          <button
            type="button"
            onClick={handleAssignSelectedUsersToGroup}
            disabled={!bulkAssignGroupId || selectedAssignUsers.length === 0 || assigningUsers}
            className="btn-primary text-sm disabled:opacity-40"
          >
            {assigningUsers ? <Loader2 size={14} className="animate-spin" /> : <UserPlus size={14} />}
            {selectedBulkGroup ? `Add Selected to ${selectedBulkGroup.displayName}` : 'Add Selected to Group'}
          </button>
        </div>

        {assignResults.length > 0 && (
          <div className="rounded-card border border-green-200 bg-green-50 divide-y divide-green-100">
            {assignResults.map((message, index) => (
              <div key={`${message}-${index}`} className="px-3 py-2 text-xs text-green-800">
                {message}
              </div>
            ))}
          </div>
        )}
      </div>

      {loading ? (
        <WorkflowStatusScene
          variant="bulk-upload"
          title="Loading groups"
          detail="Fetching groups and membership counts before bulk assignment."
          statusLabel="Loading"
          compact
        />
      ) : (
        <div className="space-y-3">
          {filteredGroups.length === 0 ? (
            <div className="card p-8 text-center">
              <div className="text-sm font-semibold text-content-primary">No groups found</div>
              <p className="text-xs text-content-secondary mt-1">
                Groups must exist before bulk assignments can run. Create groups in Omni, then return here to map migrated users.
              </p>
            </div>
          ) : filteredGroups.map((group) => {
            const isExpanded = expandedIds.has(group.id);
            const detail = detailedGroups[group.id];
            const members = detail?.members || group.members || [];

            return (
              <div key={group.id} className={`card p-0 overflow-hidden transition-colors ${bulkAssignGroupId === group.id ? 'border-omni-300 bg-surface-secondary' : ''}`}>
                <button
                  onClick={() => toggleExpand(group.id)}
                  className="w-full flex items-center justify-between px-4 py-3 hover:bg-surface-secondary transition-colors"
                >
                  <div className="flex items-center gap-3">
                    {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                    <span className="text-sm font-medium text-content-primary">{group.displayName}</span>
                    <span className="text-xs text-content-secondary bg-surface-secondary px-2 py-0.5 rounded-chip">
                      {group.members?.length || 0} members
                    </span>
                    {bulkAssignGroupId === group.id && (
                      <span className="text-xs text-omni-800 bg-omni-100 px-2 py-0.5 rounded-chip">
                        selected
                      </span>
                    )}
                  </div>
                </button>

                {isExpanded && (
                  <div className="border-t border-border">
                    {loadingDetail === group.id ? (
                      <div className="flex items-center justify-center py-6">
                        <Loader2 size={16} className="text-omni-500 animate-spin" />
                      </div>
                    ) : (
                      <>
                        <div className="px-4 py-2 bg-surface-secondary flex items-center justify-between">
                          <span className="text-xs font-medium text-content-secondary uppercase tracking-wider">Members</span>
                          <button
                            onClick={() => setAddMemberGroup(group)}
                            className="text-xs text-omni-700 hover:text-omni-500 font-medium flex items-center gap-1"
                          >
                            <UserPlus size={12} />
                            Add Member
                          </button>
                        </div>
                        {members.length === 0 ? (
                          <div className="px-4 py-4 text-sm text-content-secondary">No members in this group.</div>
                        ) : (
                          members.map((member) => (
                            <div
                              key={member.value}
                              className="px-4 py-2 border-t border-border/50 flex items-center justify-between hover:bg-surface-secondary transition-colors"
                            >
                              <div className="text-sm">
                                <span className="text-content-primary">{member.display || member.value}</span>
                                {member.display && (
                                  <span className="text-xs text-content-secondary font-mono ml-2">{member.value}</span>
                                )}
                              </div>
                              <button
                                onClick={() =>
                                  setRemoveMember({
                                    group,
                                    memberId: member.value,
                                    memberName: member.display || member.value,
                                  })
                                }
                                className="p-1 text-content-secondary hover:text-error hover:bg-red-50 rounded transition-colors"
                              >
                                <UserMinus size={14} />
                              </button>
                            </div>
                          ))
                        )}
                      </>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      <AddMemberModal
        open={!!addMemberGroup}
        groupName={addMemberGroup?.displayName || ''}
        onClose={() => setAddMemberGroup(null)}
        onAdd={handleAddMember}
      />

      <CsvGroupImportModal
        open={showCsvImport}
        onClose={() => setShowCsvImport(false)}
        onImport={handleCsvImport}
      />

      <ConfirmDialog
        open={!!removeMember}
        title="Remove Member"
        message={`Remove "${removeMember?.memberName}" from "${removeMember?.group.displayName}"?`}
        confirmLabel="Remove"
        variant="danger"
        onConfirm={handleRemoveMember}
        onCancel={() => setRemoveMember(null)}
      />
    </div>
  );
}
