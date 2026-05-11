import { useState, useEffect, useCallback } from 'react';
import { Loader2, Plus, Search, Trash2, CreditCard as Edit3, X, Upload, ChevronDown, ChevronRight } from 'lucide-react';
import { listUsers, createUser, updateUser, deleteUser, findUserByEmail } from '@/services/omniApi';
import { useConnection } from '@/contexts/ConnectionContext';
import { PageHeader } from '@/components/layout/PageHeader';
import { SearchInput } from '@/components/ui/SearchInput';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import type { OmniUser } from '@/types';

function UserFormModal({
  open,
  user,
  onClose,
  onSave,
}: {
  open: boolean;
  user: OmniUser | null;
  onClose: () => void;
  onSave: (data: { userName: string; displayName: string; attributes: Record<string, string> }) => Promise<void>;
}) {
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [attrKey, setAttrKey] = useState('');
  const [attrVal, setAttrVal] = useState('');
  const [attributes, setAttributes] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (user) {
      setEmail(user.userName);
      setDisplayName(user.displayName);
      setAttributes(user.attributes || {});
    } else {
      setEmail('');
      setDisplayName('');
      setAttributes({});
    }
    setError('');
  }, [user, open]);

  if (!open) return null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email || !displayName) return;
    setSaving(true);
    setError('');
    try {
      await onSave({ userName: email, displayName, attributes });
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save user');
    } finally {
      setSaving(false);
    }
  }

  function addAttribute() {
    if (attrKey && attrVal) {
      setAttributes((prev) => ({ ...prev, [attrKey]: attrVal }));
      setAttrKey('');
      setAttrVal('');
    }
  }

  function removeAttribute(key: string) {
    setAttributes((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="relative bg-white rounded-card shadow-dropdown p-6 max-w-md w-full mx-4">
        <button onClick={onClose} className="absolute top-4 right-4 text-content-secondary hover:text-content-primary">
          <X size={18} />
        </button>
        <h3 className="text-lg font-semibold text-content-primary mb-4">
          {user ? 'Edit User' : 'Create User'}
        </h3>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 text-xs px-3 py-2 rounded mb-4">{error}</div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-medium text-content-secondary mb-1">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="input-field"
              placeholder="user@example.com"
              disabled={!!user}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-content-secondary mb-1">Display Name</label>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className="input-field"
              placeholder="John Doe"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-content-secondary mb-2">Custom Attributes</label>
            {Object.entries(attributes).map(([key, val]) => (
              <div key={key} className="flex items-center gap-2 mb-1.5 text-xs">
                <span className="font-mono bg-surface-secondary px-2 py-1 rounded flex-1 truncate">{key}: {val}</span>
                <button type="button" onClick={() => removeAttribute(key)} className="text-error hover:text-red-700">
                  <X size={12} />
                </button>
              </div>
            ))}
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={attrKey}
                onChange={(e) => setAttrKey(e.target.value)}
                className="input-field text-xs flex-1"
                placeholder="Key"
              />
              <input
                type="text"
                value={attrVal}
                onChange={(e) => setAttrVal(e.target.value)}
                className="input-field text-xs flex-1"
                placeholder="Value"
              />
              <button type="button" onClick={addAttribute} className="btn-secondary text-xs px-2 py-2">
                <Plus size={12} />
              </button>
            </div>
          </div>

          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="btn-secondary text-sm">Cancel</button>
            <button type="submit" disabled={saving || !email || !displayName} className="btn-primary text-sm">
              {saving ? <Loader2 size={14} className="animate-spin" /> : null}
              {user ? 'Save Changes' : 'Create User'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function CsvImportModal({
  open,
  onClose,
  onImport,
}: {
  open: boolean;
  onClose: () => void;
  onImport: (rows: Array<{ email: string; display_name: string; op: string; [key: string]: string }>) => void;
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
    if (!headers.includes('email') || !headers.includes('display_name') || !headers.includes('op')) {
      setError('CSV must have columns: email, display_name, op');
      return;
    }
    const rows = lines.slice(1).map((line) => {
      const values = line.split(',').map((v) => v.trim());
      const row: Record<string, string> = {};
      headers.forEach((h, i) => {
        row[h] = values[i] || '';
      });
      return row as { email: string; display_name: string; op: string; [key: string]: string };
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
        <h3 className="text-lg font-semibold text-content-primary mb-2">Import Users from CSV</h3>
        <p className="text-xs text-content-secondary mb-4">
          Paste CSV with columns: email, display_name, op (upsert or delete), plus any custom attribute columns.
        </p>
        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 text-xs px-3 py-2 rounded mb-3">{error}</div>
        )}
        <textarea
          value={csvText}
          onChange={(e) => setCsvText(e.target.value)}
          className="input-field font-mono text-xs h-40 resize-none"
          placeholder="email,display_name,op&#10;user@example.com,John Doe,upsert&#10;old@example.com,,delete"
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

export function UsersPage() {
  const { connection } = useConnection();
  const [users, setUsers] = useState<OmniUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [totalResults, setTotalResults] = useState(0);
  const [page, setPage] = useState(1);
  const [showForm, setShowForm] = useState(false);
  const [editingUser, setEditingUser] = useState<OmniUser | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<OmniUser | null>(null);
  const [showCsvImport, setShowCsvImport] = useState(false);
  const [importProgress, setImportProgress] = useState<{ current: number; total: number; results: string[] } | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const pageSize = 50;

  const fetchUsers = useCallback(async (pageNum: number) => {
    setLoading(true);
    setError('');
    try {
      const res = await listUsers(connection.baseUrl, connection.apiKey, pageSize, (pageNum - 1) * pageSize + 1);
      if (res.error) {
        setError(res.error);
        return;
      }
      setUsers(
        (res.Resources || []).map((u: Record<string, unknown>) => ({
          id: u.id as string,
          userName: u.userName as string,
          displayName: (u.displayName as string) || '',
          active: u.active as boolean,
          groups: (u.groups as OmniUser['groups']) || [],
        }))
      );
      setTotalResults(res.totalResults || 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load users');
    } finally {
      setLoading(false);
    }
  }, [connection.baseUrl, connection.apiKey]);

  useEffect(() => {
    fetchUsers(page);
  }, [fetchUsers, page]);

  async function handleSearch() {
    if (!search.trim()) {
      fetchUsers(1);
      return;
    }
    setLoading(true);
    setError('');
    try {
      const res = await findUserByEmail(connection.baseUrl, connection.apiKey, search.trim());
      if (res.error) {
        setError(res.error);
        return;
      }
      setUsers(
        (res.Resources || []).map((u: Record<string, unknown>) => ({
          id: u.id as string,
          userName: u.userName as string,
          displayName: (u.displayName as string) || '',
          active: u.active as boolean,
          groups: (u.groups as OmniUser['groups']) || [],
        }))
      );
      setTotalResults(res.totalResults || 0);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Search failed');
    } finally {
      setLoading(false);
    }
  }

  async function handleSaveUser(data: { userName: string; displayName: string; attributes: Record<string, string> }) {
    const body: Record<string, unknown> = {
      userName: data.userName,
      displayName: data.displayName,
    };
    if (Object.keys(data.attributes).length > 0) {
      body['urn:omni:params:1.0:UserAttribute'] = data.attributes;
    }

    if (editingUser) {
      await updateUser(connection.baseUrl, connection.apiKey, editingUser.id, body);
    } else {
      await createUser(connection.baseUrl, connection.apiKey, body);
    }
    fetchUsers(page);
  }

  async function handleDeleteUser() {
    if (!deleteTarget) return;
    try {
      await deleteUser(connection.baseUrl, connection.apiKey, deleteTarget.id);
      setDeleteTarget(null);
      fetchUsers(page);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
      setDeleteTarget(null);
    }
  }

  async function handleCsvImport(rows: Array<{ email: string; display_name: string; op: string; [key: string]: string }>) {
    setImportProgress({ current: 0, total: rows.length, results: [] });

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const { email, display_name, op, ...attrs } = row;
      let message: string;

      try {
        if (op === 'delete') {
          const found = await findUserByEmail(connection.baseUrl, connection.apiKey, email);
          const foundUsers = found.Resources || [];
          if (foundUsers.length === 1) {
            await deleteUser(connection.baseUrl, connection.apiKey, foundUsers[0].id as string);
            message = `Deleted ${email}`;
          } else {
            message = `Skipped ${email}: ${foundUsers.length === 0 ? 'not found' : 'multiple matches'}`;
          }
        } else {
          const body: Record<string, unknown> = { userName: email, displayName: display_name };
          if (Object.keys(attrs).length > 0) {
            body['urn:omni:params:1.0:UserAttribute'] = attrs;
          }
          const found = await findUserByEmail(connection.baseUrl, connection.apiKey, email);
          const foundUsers = found.Resources || [];
          if (foundUsers.length === 1) {
            await updateUser(connection.baseUrl, connection.apiKey, foundUsers[0].id as string, body);
            message = `Updated ${email}`;
          } else if (foundUsers.length === 0) {
            await createUser(connection.baseUrl, connection.apiKey, body);
            message = `Created ${email}`;
          } else {
            message = `Skipped ${email}: multiple matches`;
          }
        }
      } catch (err) {
        message = `Error ${email}: ${err instanceof Error ? err.message : 'unknown'}`;
      }

      setImportProgress({ current: i + 1, total: rows.length, results: [...(importProgress?.results || []), message] });
      await new Promise((r) => setTimeout(r, 500));
    }

    fetchUsers(page);
  }

  function toggleExpand(id: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const totalPages = Math.ceil(totalResults / pageSize);

  return (
    <div className="space-y-5">
      <PageHeader
        title="User Management"
        description={`Manage users via SCIM API. ${totalResults > 0 ? `${totalResults} total users.` : ''}`}
        actions={
          <div className="flex gap-2">
            <button onClick={() => setShowCsvImport(true)} className="btn-secondary text-sm">
              <Upload size={14} />
              CSV Import
            </button>
            <button onClick={() => { setEditingUser(null); setShowForm(true); }} className="btn-primary text-sm">
              <Plus size={14} />
              Create User
            </button>
          </div>
        }
      />

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-card">{error}</div>
      )}

      {importProgress && importProgress.current < importProgress.total && (
        <div className="card bg-surface-secondary">
          <div className="text-sm font-medium mb-2">Importing users... {importProgress.current}/{importProgress.total}</div>
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
          <SearchInput value={search} onChange={setSearch} placeholder="Search by email..." />
        </div>
        <button onClick={handleSearch} className="btn-secondary text-sm">
          <Search size={14} />
          Search
        </button>
      </div>

      <div className="card p-0 overflow-hidden">
        <div className="bg-surface-secondary px-4 py-2.5 border-b border-border grid grid-cols-12 gap-2">
          <div className="col-span-1" />
          <div className="col-span-4 text-xs font-medium text-content-secondary uppercase tracking-wider">Email</div>
          <div className="col-span-3 text-xs font-medium text-content-secondary uppercase tracking-wider">Display Name</div>
          <div className="col-span-2 text-xs font-medium text-content-secondary uppercase tracking-wider">Status</div>
          <div className="col-span-2 text-xs font-medium text-content-secondary uppercase tracking-wider text-right">Actions</div>
        </div>

        <div className="max-h-[450px] overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 size={24} className="text-omni-500 animate-spin" />
            </div>
          ) : users.length === 0 ? (
            <div className="text-center py-12 text-content-secondary text-sm">No users found.</div>
          ) : (
            users.map((user) => {
              const isExpanded = expandedIds.has(user.id);
              return (
                <div key={user.id}>
                  <div className="px-4 py-2.5 border-b border-border/50 grid grid-cols-12 gap-2 items-center hover:bg-surface-secondary transition-colors">
                    <div className="col-span-1">
                      <button onClick={() => toggleExpand(user.id)} className="text-content-secondary hover:text-content-primary">
                        {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      </button>
                    </div>
                    <div className="col-span-4 text-sm text-content-primary truncate font-mono">{user.userName}</div>
                    <div className="col-span-3 text-sm text-content-secondary truncate">{user.displayName}</div>
                    <div className="col-span-2">
                      <span className={`text-xs font-medium px-2 py-0.5 rounded-chip ${user.active !== false ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-600'}`}>
                        {user.active !== false ? 'Active' : 'Inactive'}
                      </span>
                    </div>
                    <div className="col-span-2 flex justify-end gap-1">
                      <button
                        onClick={() => { setEditingUser(user); setShowForm(true); }}
                        className="p-1.5 text-content-secondary hover:text-omni-700 hover:bg-omni-100 rounded transition-colors"
                      >
                        <Edit3 size={14} />
                      </button>
                      <button
                        onClick={() => setDeleteTarget(user)}
                        className="p-1.5 text-content-secondary hover:text-error hover:bg-red-50 rounded transition-colors"
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </div>
                  {isExpanded && (
                    <div className="px-4 py-3 bg-surface-secondary border-b border-border/50">
                      <div className="text-xs space-y-1">
                        <div><span className="font-medium text-content-primary">ID:</span> <span className="font-mono text-content-secondary">{user.id}</span></div>
                        {user.groups && user.groups.length > 0 && (
                          <div>
                            <span className="font-medium text-content-primary">Groups:</span>{' '}
                            <span className="text-content-secondary">{user.groups.map((g) => g.display).join(', ')}</span>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-center gap-2">
          <button onClick={() => setPage(Math.max(1, page - 1))} disabled={page <= 1} className="btn-secondary text-xs px-3 py-1.5">
            Previous
          </button>
          <span className="text-xs text-content-secondary">Page {page} of {totalPages}</span>
          <button onClick={() => setPage(Math.min(totalPages, page + 1))} disabled={page >= totalPages} className="btn-secondary text-xs px-3 py-1.5">
            Next
          </button>
        </div>
      )}

      <UserFormModal
        open={showForm}
        user={editingUser}
        onClose={() => { setShowForm(false); setEditingUser(null); }}
        onSave={handleSaveUser}
      />

      <CsvImportModal
        open={showCsvImport}
        onClose={() => setShowCsvImport(false)}
        onImport={handleCsvImport}
      />

      <ConfirmDialog
        open={!!deleteTarget}
        title="Delete User"
        message={`Are you sure you want to delete ${deleteTarget?.userName}? This action cannot be undone.`}
        confirmLabel="Delete User"
        variant="danger"
        onConfirm={handleDeleteUser}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
