import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { ChevronDown, ChevronRight, Download, Loader2, Plus, Search, Trash2, CreditCard as Edit3, X, Upload } from 'lucide-react';
import { listAllUsers, createUser, updateUser, deleteUser, findUserByEmail } from '@/services/omniApi';
import { useConnection } from '@/contexts/ConnectionContext';
import { PageHeader } from '@/components/layout/PageHeader';
import { SearchInput } from '@/components/ui/SearchInput';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Blobby } from '@/components/ui/Blobby';
import { WorkflowStatusScene } from '@/components/ui/WorkflowStatusScene';
import { friendlyApiError } from '@/utils/apiErrors';
import type { OmniUser } from '@/types';

type MultiCreateUserRow = {
  id: string;
  email: string;
  displayName: string;
  department: string;
  role: string;
};

type MultiCreateProgress = {
  current: number;
  total: number;
  results: string[];
} | null;

function emptyMultiCreateRow(): MultiCreateUserRow {
  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    email: '',
    displayName: '',
    department: '',
    role: '',
  };
}

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
      setError(friendlyApiError(err, 'Failed to save user'));
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
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
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
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white rounded-card shadow-dropdown p-6 max-w-lg w-full mx-4">
        <button onClick={onClose} className="absolute top-4 right-4 text-content-secondary hover:text-content-primary">
          <X size={18} />
        </button>
        <h3 className="text-lg font-semibold text-content-primary mb-2">Bulk User Migration Import</h3>
        <p className="text-xs text-content-secondary mb-4">
          Paste migrated users from your source system. Required columns: email, display_name, op.
          Use op=upsert to create/update and op=delete to remove users.
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

function mapScimUser(user: Record<string, unknown>): OmniUser {
  return {
    id: user.id as string,
    userName: user.userName as string,
    displayName: (user.displayName as string) || '',
    active: user.active as boolean,
    groups: (user.groups as OmniUser['groups']) || [],
  };
}

export function UsersPage({ embedded = false }: { embedded?: boolean } = {}) {
  const { connection } = useConnection();
  const connectionKey = connection.instanceId || connection.baseUrl;
  const activeConnectionKeyRef = useRef(connectionKey);
  const [users, setUsers] = useState<OmniUser[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [totalResults, setTotalResults] = useState(0);
  const [userLoadTruncated, setUserLoadTruncated] = useState(false);
  const [page, setPage] = useState(1);
  const [showForm, setShowForm] = useState(false);
  const [editingUser, setEditingUser] = useState<OmniUser | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<OmniUser | null>(null);
  const [showCsvImport, setShowCsvImport] = useState(false);
  const [importProgress, setImportProgress] = useState<{ current: number; total: number; results: string[] } | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [exportNotice, setExportNotice] = useState('');
  const [multiCreateRows, setMultiCreateRows] = useState<MultiCreateUserRow[]>([]);
  const [multiCreateProgress, setMultiCreateProgress] = useState<MultiCreateProgress>(null);
  const [creatingMany, setCreatingMany] = useState(false);
  const pageSize = 50;

  useEffect(() => {
    activeConnectionKeyRef.current = connectionKey;
  }, [connectionKey]);

  const fetchUsers = useCallback(async () => {
    const requestKey = connectionKey;
    setLoading(true);
    setError('');
    try {
      const res = await listAllUsers(connection.baseUrl, connection.apiKey, { pageSize: 100, maxPages: 200 });
      if (res.error) {
        if (activeConnectionKeyRef.current !== requestKey) return;
        setError(friendlyApiError(res.error, 'Failed to load users'));
        return;
      }
      if (activeConnectionKeyRef.current !== requestKey) return;
      const nextUsers = (res.Resources || []).map(mapScimUser);
      setUsers(nextUsers);
      setTotalResults(Number(res.totalResults) || nextUsers.length);
      setUserLoadTruncated(Boolean(res.truncated));
      setPage(1);
    } catch (err) {
      if (activeConnectionKeyRef.current !== requestKey) return;
      setError(friendlyApiError(err, 'Failed to load users'));
    } finally {
      if (activeConnectionKeyRef.current === requestKey) setLoading(false);
    }
  }, [connection.baseUrl, connection.apiKey, connectionKey]);

  useEffect(() => {
    fetchUsers();
  }, [fetchUsers]);

  useEffect(() => {
    setPage(1);
  }, [search]);

  function handleSearch() {
    setPage(1);
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
    fetchUsers();
  }

  async function handleDeleteUser() {
    if (!deleteTarget) return;
    try {
      await deleteUser(connection.baseUrl, connection.apiKey, deleteTarget.id);
      setDeleteTarget(null);
      fetchUsers();
    } catch (err) {
      setError(friendlyApiError(err, 'Delete failed'));
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

      setImportProgress((prev) => ({
        current: i + 1,
        total: rows.length,
        results: [...(prev?.results || []), message],
      }));
      await new Promise((r) => setTimeout(r, 500));
    }

    fetchUsers();
  }

  function handleDownloadTemplate() {
    downloadCsv('omnikit-user-import-template.csv', [
      ['email', 'display_name', 'op', 'department', 'role'],
      ['new.user@example.com', 'New User', 'upsert', 'Sales', 'viewer'],
      ['retired.user@example.com', '', 'delete', '', ''],
    ]);
    showExportNotice('User import template download started.');
  }

  function handleDownloadCurrentUsers() {
    downloadCsv('omnikit-current-users.csv', [
      ['email', 'display_name', 'op'],
      ...users.map((user) => [user.userName, user.displayName || '', user.active === false ? 'delete' : 'upsert']),
    ]);
    showExportNotice(`User export started (${users.length} loaded users).`);
  }

  function showExportNotice(message: string) {
    setExportNotice(message);
    window.setTimeout(() => setExportNotice(''), 4000);
  }

  function addMultiCreateRow() {
    setMultiCreateRows((prev) => [...prev, emptyMultiCreateRow()]);
  }

  function updateMultiCreateRow(id: string, patch: Partial<MultiCreateUserRow>) {
    setMultiCreateRows((prev) => prev.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  }

  function removeMultiCreateRow(id: string) {
    setMultiCreateRows((prev) => prev.filter((row) => row.id !== id));
  }

  async function handleCreateMultipleUsers() {
    const rows = multiCreateRows.filter((row) => row.email.trim() && row.displayName.trim());
    if (rows.length === 0) return;

    setCreatingMany(true);
    setError('');
    setMultiCreateProgress({ current: 0, total: rows.length, results: [] });

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      let message: string;
      try {
        const body: Record<string, unknown> = {
          userName: row.email.trim(),
          displayName: row.displayName.trim(),
        };
        const attributes: Record<string, string> = {};
        if (row.department.trim()) attributes.department = row.department.trim();
        if (row.role.trim()) attributes.role = row.role.trim();
        if (Object.keys(attributes).length > 0) {
          body['urn:omni:params:1.0:UserAttribute'] = attributes;
        }

        await createUser(connection.baseUrl, connection.apiKey, body);
        message = `Created ${row.email.trim()}`;
      } catch (err) {
        message = `Error ${row.email.trim()}: ${friendlyApiError(err, 'Create user failed')}`;
      }

      setMultiCreateProgress((prev) => ({
        current: i + 1,
        total: rows.length,
        results: [...(prev?.results || []), message],
      }));
    }

    setCreatingMany(false);
    setMultiCreateRows([]);
    fetchUsers();
  }

  function toggleExpand(id: string) {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const filteredUsers = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return users;
    return users.filter((user) => {
      const haystack = `${user.userName} ${user.displayName || ''}`.toLowerCase();
      return haystack.includes(term);
    });
  }, [search, users]);
  const visibleUsers = filteredUsers.slice((page - 1) * pageSize, page * pageSize);
  const totalPages = Math.ceil(filteredUsers.length / pageSize);
  const loadSummary =
    totalResults > users.length
      ? `${users.length} of ${totalResults} users loaded${userLoadTruncated ? ' (limited by safety cap)' : ''}`
      : `${users.length} users loaded`;
  const headerActions = (
    <div className="flex flex-wrap gap-2">
      <button onClick={handleDownloadTemplate} className="btn-secondary text-sm">
        <Download size={14} />
        CSV Template
      </button>
      <button onClick={handleDownloadCurrentUsers} disabled={users.length === 0} className="btn-secondary text-sm disabled:opacity-40">
        <Download size={14} />
        Export Users
      </button>
      <button onClick={() => setShowCsvImport(true)} className="btn-secondary text-sm">
        <Upload size={14} />
        Bulk User Import
      </button>
      <button onClick={() => { setEditingUser(null); setShowForm(true); }} className="btn-primary text-sm">
        <Plus size={14} />
        Create User
      </button>
    </div>
  );

  return (
    <div className="space-y-5">
      {!embedded ? (
        <PageHeader
          title="User Management"
          description={`Provision, update, archive, and bulk migrate users through SCIM. ${totalResults > 0 ? loadSummary : ''}`}
          icon={<Blobby mood="users" size={58} className="animate-float" style={{ animationDuration: '3.5s' }} />}
          actions={headerActions}
        />
      ) : (
        <div className="card p-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <div className="text-sm font-semibold text-content-primary">Users</div>
            <p className="text-xs text-content-secondary mt-0.5">
              Export all loaded users, edit the CSV, then re-import with upsert or delete actions.
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
          <div className="text-xs font-medium text-content-secondary uppercase tracking-wider">Migration Use Case</div>
          <div className="mt-2 text-sm font-semibold text-content-primary">Bulk user provisioning</div>
          <p className="mt-1 text-xs text-content-secondary leading-5">Upload exported users from a legacy BI tool and upsert them through Omni SCIM.</p>
        </div>
        <div className="card p-4">
          <div className="text-xs font-medium text-content-secondary uppercase tracking-wider">CSV Operations</div>
          <div className="mt-2 text-sm font-semibold text-content-primary">upsert or delete</div>
          <p className="mt-1 text-xs text-content-secondary leading-5">Use one file to create new users, update display names and attributes, or remove retired users.</p>
        </div>
        <div className="card p-4">
          <div className="text-xs font-medium text-content-secondary uppercase tracking-wider">Next Step</div>
          <div className="mt-2 text-sm font-semibold text-content-primary">Assign groups</div>
          <p className="mt-1 text-xs text-content-secondary leading-5">After users exist, use Group Management to bulk apply membership from the same migration mapping.</p>
        </div>
      </div>

      <div className="card space-y-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <div className="text-sm font-semibold text-content-primary">Create Multiple Users</div>
            <p className="text-xs text-content-secondary mt-0.5">
              Add a few users directly in the UI. Use CSV import when the batch is large.
            </p>
          </div>
          <button type="button" onClick={addMultiCreateRow} className="btn-secondary text-sm">
            <Plus size={14} />
            Add User Row
          </button>
        </div>

        {multiCreateRows.length > 0 && (
          <div className="space-y-3">
            <div className="grid grid-cols-12 gap-2 px-2 text-[11px] font-semibold uppercase tracking-wider text-content-secondary">
              <div className="col-span-12 md:col-span-3">Email</div>
              <div className="col-span-12 md:col-span-3">Display Name</div>
              <div className="col-span-6 md:col-span-2">Department</div>
              <div className="col-span-6 md:col-span-2">Role</div>
              <div className="hidden md:block md:col-span-2 text-right">Actions</div>
            </div>
            {multiCreateRows.map((row) => (
              <div key={row.id} className="grid grid-cols-12 gap-2 items-center">
                <input
                  value={row.email}
                  onChange={(event) => updateMultiCreateRow(row.id, { email: event.target.value })}
                  className="input-field col-span-12 md:col-span-3"
                  placeholder="new.user@example.com"
                  type="email"
                />
                <input
                  value={row.displayName}
                  onChange={(event) => updateMultiCreateRow(row.id, { displayName: event.target.value })}
                  className="input-field col-span-12 md:col-span-3"
                  placeholder="New User"
                />
                <input
                  value={row.department}
                  onChange={(event) => updateMultiCreateRow(row.id, { department: event.target.value })}
                  className="input-field col-span-6 md:col-span-2"
                  placeholder="Sales"
                />
                <input
                  value={row.role}
                  onChange={(event) => updateMultiCreateRow(row.id, { role: event.target.value })}
                  className="input-field col-span-6 md:col-span-2"
                  placeholder="viewer"
                />
                <div className="col-span-12 md:col-span-2 flex justify-end">
                  <button
                    type="button"
                    onClick={() => removeMultiCreateRow(row.id)}
                    className="btn-secondary text-xs px-3 py-2"
                  >
                    <X size={13} />
                    Remove
                  </button>
                </div>
              </div>
            ))}
            <button
              type="button"
              onClick={handleCreateMultipleUsers}
              disabled={creatingMany || multiCreateRows.every((row) => !row.email.trim() || !row.displayName.trim())}
              className="btn-primary text-sm disabled:opacity-40"
            >
              {creatingMany ? <Loader2 size={14} className="animate-spin" /> : <Plus size={14} />}
              Create {multiCreateRows.filter((row) => row.email.trim() && row.displayName.trim()).length} User{multiCreateRows.filter((row) => row.email.trim() && row.displayName.trim()).length === 1 ? '' : 's'}
            </button>
          </div>
        )}

        {multiCreateProgress && (
          <div className="rounded-card border border-border bg-surface-secondary p-3 space-y-2">
            <div className="flex items-center justify-between gap-3">
              <div className="text-sm font-medium text-content-primary">
                {multiCreateProgress.current < multiCreateProgress.total ? 'Creating users...' : 'User creation complete'} {multiCreateProgress.current}/{multiCreateProgress.total}
              </div>
              {multiCreateProgress.current >= multiCreateProgress.total && (
                <button onClick={() => setMultiCreateProgress(null)} className="p-1 text-content-secondary hover:text-content-primary rounded-button hover:bg-white">
                  <X size={14} />
                </button>
              )}
            </div>
            <div className="w-full h-2 bg-gray-200 rounded-full overflow-hidden">
              <div
                className="h-full bg-omni-700 rounded-full transition-all duration-300"
                style={{ width: `${(multiCreateProgress.current / multiCreateProgress.total) * 100}%` }}
              />
            </div>
            {multiCreateProgress.results.length > 0 && (
              <div className="max-h-28 overflow-y-auto rounded-card border border-border bg-white divide-y divide-border/50">
                {multiCreateProgress.results.slice(-8).map((message, index) => (
                  <div key={`${message}-${index}`} className="px-3 py-2 text-xs text-content-secondary">
                    {message}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      {importProgress && (
        <div className="card bg-surface-secondary space-y-3">
          <WorkflowStatusScene
            variant="bulk-upload"
            title={importProgress.current < importProgress.total ? 'Importing users' : 'User import complete'}
            detail="Processing each SCIM update sequentially to avoid API bursts."
            statusLabel={importProgress.current < importProgress.total ? 'Importing' : 'Complete'}
            progressLabel={`${importProgress.current}/${importProgress.total} users processed`}
            compact
          />
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-sm font-medium text-content-primary">
                {importProgress.current < importProgress.total ? 'Importing users...' : 'User import complete'} {importProgress.current}/{importProgress.total}
              </div>
              <div className="text-xs text-content-secondary mt-0.5">Processed sequentially to avoid API bursts during migration setup.</div>
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

      <div className="flex gap-3">
        <div className="flex-1">
          <SearchInput value={search} onChange={setSearch} placeholder="Search loaded users by email or name..." />
        </div>
        <button onClick={handleSearch} className="btn-secondary text-sm">
          <Search size={14} />
          Search
        </button>
      </div>
      {users.length > 0 && (
        <div className="text-xs text-content-secondary">
          Showing {visibleUsers.length === 0 ? 0 : (page - 1) * pageSize + 1}-{Math.min(page * pageSize, filteredUsers.length)} of {filteredUsers.length} matching loaded users.
          {totalResults > users.length ? ` Omni reports ${totalResults} total users; ${users.length} are loaded.` : ''}
        </div>
      )}

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
            <div className="p-4">
              <WorkflowStatusScene
                variant="bulk-upload"
                title="Loading users"
                detail="Fetching all SCIM user pages sequentially before migration actions."
                statusLabel="Loading"
                compact
              />
            </div>
          ) : users.length === 0 ? (
            <div className="text-center py-12 text-content-secondary text-sm">No users found.</div>
          ) : filteredUsers.length === 0 ? (
            <div className="text-center py-12 text-content-secondary text-sm">No loaded users match this search.</div>
          ) : (
            visibleUsers.map((user) => {
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
