import { useState, useEffect, useCallback } from 'react';
import { Loader2, ChevronDown, ChevronRight, UserPlus, UserMinus, Upload, X } from 'lucide-react';
import { listGroups, getGroup, updateGroup, findUserByEmail } from '@/services/omniApi';
import { useConnection } from '@/contexts/ConnectionContext';
import { PageHeader } from '@/components/layout/PageHeader';
import { SearchInput } from '@/components/ui/SearchInput';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import type { OmniGroup } from '@/types';

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
      setError(err instanceof Error ? err.message : 'Failed to add member');
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
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
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-white rounded-card shadow-dropdown p-6 max-w-lg w-full mx-4">
        <button onClick={onClose} className="absolute top-4 right-4 text-content-secondary hover:text-content-primary">
          <X size={18} />
        </button>
        <h3 className="text-lg font-semibold text-content-primary mb-2">Bulk Group Assignment</h3>
        <p className="text-xs text-content-secondary mb-4">
          CSV with columns: email, group_name, op (add or remove)
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

export function GroupsPage() {
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
  const [importProgress, setImportProgress] = useState<{ current: number; total: number } | null>(null);
  const [searchFilter, setSearchFilter] = useState('');

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
          setError(res.error);
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
      setError(err instanceof Error ? err.message : 'Failed to load groups');
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
      setError(err instanceof Error ? err.message : 'Failed to remove member');
    }
    setRemoveMember(null);
  }

  async function handleCsvImport(rows: Array<{ email: string; group_name: string; op: string }>) {
    setImportProgress({ current: 0, total: rows.length });

    for (let i = 0; i < rows.length; i++) {
      const { email, group_name, op } = rows[i];
      try {
        const targetGroup = groups.find((g) => g.displayName === group_name);
        if (!targetGroup) {
          continue;
        }

        const userRes = await findUserByEmail(connection.baseUrl, connection.apiKey, email);
        const users = userRes.Resources || [];
        if (users.length !== 1) continue;

        const userId = users[0].id as string;
        const detail = detailedGroups[targetGroup.id] || await getGroup(connection.baseUrl, connection.apiKey, targetGroup.id);

        if (op === 'add') {
          const updatedMembers = [...(detail.members || []), { display: email, value: userId }];
          await updateGroup(connection.baseUrl, connection.apiKey, targetGroup.id, { ...detail, members: updatedMembers });
        } else if (op === 'remove') {
          const updatedMembers = (detail.members || []).filter((m: { value: string }) => m.value !== userId);
          await updateGroup(connection.baseUrl, connection.apiKey, targetGroup.id, { ...detail, members: updatedMembers });
        }
      } catch {
        // continue on error
      }

      setImportProgress({ current: i + 1, total: rows.length });
      await new Promise((r) => setTimeout(r, 500));
    }

    setImportProgress(null);
    fetchGroups();
  }

  const filteredGroups = searchFilter
    ? groups.filter((g) => g.displayName.toLowerCase().includes(searchFilter.toLowerCase()))
    : groups;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Group Management"
        description={`Manage groups and membership via SCIM API. ${groups.length} groups found.`}
        actions={
          <button onClick={() => setShowCsvImport(true)} className="btn-secondary text-sm">
            <Upload size={14} />
            Bulk Assignment
          </button>
        }
      />

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-card">{error}</div>
      )}

      {importProgress && (
        <div className="card bg-surface-secondary">
          <div className="text-sm font-medium mb-2">Processing... {importProgress.current}/{importProgress.total}</div>
          <div className="w-full h-2 bg-gray-200 rounded-full overflow-hidden">
            <div
              className="h-full bg-omni-700 rounded-full transition-all duration-300"
              style={{ width: `${(importProgress.current / importProgress.total) * 100}%` }}
            />
          </div>
        </div>
      )}

      <div className="flex gap-3">
        <div className="flex-1">
          <SearchInput value={searchFilter} onChange={setSearchFilter} placeholder="Filter groups..." />
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-12">
          <Loader2 size={24} className="text-omni-500 animate-spin" />
        </div>
      ) : (
        <div className="space-y-3">
          {filteredGroups.map((group) => {
            const isExpanded = expandedIds.has(group.id);
            const detail = detailedGroups[group.id];
            const members = detail?.members || group.members || [];

            return (
              <div key={group.id} className="card p-0 overflow-hidden">
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
