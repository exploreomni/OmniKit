import { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef } from 'react';
import { ChevronDown, ChevronRight, Download, Loader2, Plus, Search, Trash2, CreditCard as Edit3, X } from 'lucide-react';
import {
  SCIM_USER_ATTRIBUTE_LIMITS,
  cloneScimUserAttributes,
  isSafeScimUserAttributeKey,
  listAllUsers,
  createUser,
  updateUser,
  deleteUser,
} from '@/services/omniApi';
import { useConnection } from '@/hooks/useConnection';
import { PageHeader } from '@/components/layout/PageHeader';
import { SearchInput } from '@/components/ui/SearchInput';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Blobby } from '@/components/ui/Blobby';
import { WorkflowStatusScene } from '@/components/ui/WorkflowStatusScene';
import { friendlyApiError } from '@/utils/apiErrors';
import { csvRowsToText, type CsvCellValue } from '@/utils/csvExport';
import { getConnectionCacheKey } from '@/services/connectionGuards';
import {
  prepareIdentityUserExport,
  type IdentityExportProgress,
  type IdentityExportRoleRequestLimit,
} from '@/services/userManagement/userExport';
import { AccessPostureEvidence } from '@/components/admin/CapabilityStatus';
import { fetchAdminReadiness, type AdminAccessPosture } from '@/services/adminReadiness';
import type { OmniUser, OmniUserAttributeValue, OmniUserAttributes } from '@/types';

const USER_ATTRIBUTE_URN = 'urn:omni:params:1.0:UserAttribute';

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

type UserFormData = {
  userName: string;
  displayName: string;
  attributes: OmniUserAttributes;
  attributesDirty: boolean;
};

function emptyMultiCreateRow(): MultiCreateUserRow {
  return {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    email: '',
    displayName: '',
    department: '',
    role: '',
  };
}

function attributeScalarText(value: string | number | boolean): string {
  if (typeof value !== 'string') return String(value);
  return value.length > 0 ? value : '(empty string)';
}

function isReadOnlyUserAttributeValue(value: OmniUserAttributeValue): boolean {
  // Omni custom attributes are strings or numbers. Boolean values are
  // read-only system attributes, null values have no editable form, and
  // multi-value editing is intentionally unsupported so OmniKit can
  // preserve exact ordering and duplicates.
  return value === null || typeof value === 'boolean' || Array.isArray(value);
}

function UserAttributeValueDisplay({
  attributeKey,
  value,
}: {
  attributeKey: string;
  value: OmniUserAttributeValue;
}) {
  if (value === null) {
    return <span className="break-all text-content-tertiary italic">(null)</span>;
  }
  if (!Array.isArray(value)) {
    return <span className="break-all text-content-secondary">{attributeScalarText(value)}</span>;
  }

  return (
    <div className="min-w-0 space-y-1.5">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-content-secondary">
        Multi-value ({value.length})
      </div>
      {value.length === 0 ? (
        <div className="text-content-secondary">No assigned values</div>
      ) : (
        <ul aria-label={`${attributeKey} values`} className="flex flex-wrap gap-1.5">
          {value.map((item, index) => (
            <li key={`${attributeKey}-${index}`} className="max-w-full break-all rounded-chip border border-border bg-white px-2 py-1 text-content-secondary">
              {attributeScalarText(item)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
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
  onSave: (data: UserFormData) => Promise<void>;
}) {
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [attrKey, setAttrKey] = useState('');
  const [attrVal, setAttrVal] = useState('');
  const [attributes, setAttributes] = useState<OmniUserAttributes>({});
  const [attributesDirty, setAttributesDirty] = useState(false);
  const [attributeGuidance, setAttributeGuidance] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (user) {
      setEmail(user.userName);
      setDisplayName(user.displayName);
      setAttributes(cloneScimUserAttributes(user.attributes));
    } else {
      setEmail('');
      setDisplayName('');
      setAttributes({});
    }
    setAttributesDirty(false);
    setAttributeGuidance('');
    setError('');
  }, [user, open]);

  useEffect(() => {
    if (open) {
      previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      window.setTimeout(() => {
        dialogRef.current
          ?.querySelector<HTMLElement>(user ? '#user-form-display-name' : '#user-form-email')
          ?.focus();
      }, 0);
    } else {
      previousFocusRef.current?.focus();
    }
  }, [open, user]);

  useEffect(() => {
    if (!open) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') onClose();
      if (event.key !== 'Tab' || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
      )];
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!dialogRef.current.contains(document.activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose, open]);

  if (!open) return null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email || !displayName) return;
    setSaving(true);
    setError('');
    try {
      await onSave({
        userName: email,
        displayName,
        attributes: cloneScimUserAttributes(attributes),
        attributesDirty,
      });
      onClose();
    } catch (err) {
      setError(friendlyApiError(err, 'Failed to save user'));
    } finally {
      setSaving(false);
    }
  }

  function addAttribute() {
    const key = attrKey;
    if (key && attrVal) {
      if (!isSafeScimUserAttributeKey(key)) {
        setAttributeGuidance(`Attribute keys must be 1-${SCIM_USER_ATTRIBUTE_LIMITS.maxKeyLength} characters, have no leading or trailing whitespace or control characters, and cannot use reserved prototype names.`);
        return;
      }
      if (attrVal.length > SCIM_USER_ATTRIBUTE_LIMITS.maxStringLength) {
        setAttributeGuidance(`Attribute values must be ${SCIM_USER_ATTRIBUTE_LIMITS.maxStringLength.toLocaleString()} characters or fewer.`);
        return;
      }
      const existingValue = attributes[key];
      if (existingValue !== undefined && isReadOnlyUserAttributeValue(existingValue)) {
        setAttributeGuidance(`${key} is read-only in OmniKit. Its current value will be preserved.`);
        return;
      }
      if (!Object.prototype.hasOwnProperty.call(attributes, key) && Object.keys(attributes).length >= SCIM_USER_ATTRIBUTE_LIMITS.maxAttributes) {
        setAttributeGuidance(`A user may have at most ${SCIM_USER_ATTRIBUTE_LIMITS.maxAttributes} attributes in this editor.`);
        return;
      }
      setAttributes((prev) => ({ ...prev, [key]: attrVal }));
      setAttributesDirty(true);
      setAttributeGuidance('');
      setAttrKey('');
      setAttrVal('');
    }
  }

  function removeAttribute(key: string) {
    const value = attributes[key];
    if (value !== undefined && isReadOnlyUserAttributeValue(value)) {
      setAttributeGuidance(`${key} is read-only in OmniKit. Its current value will be preserved.`);
      return;
    }
    setAttributes((prev) => {
      const next = { ...prev };
      delete next[key];
      return next;
    });
    setAttributesDirty(true);
    setAttributeGuidance('');
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="user-form-title"
        className="relative max-h-[calc(100vh-2rem)] w-full max-w-md overflow-y-auto rounded-card bg-white p-6 mx-4 shadow-dropdown"
      >
        <button type="button" aria-label="Close user form" onClick={onClose} className="absolute top-4 right-4 text-content-secondary hover:text-content-primary">
          <X size={18} />
        </button>
        <h3 id="user-form-title" className="text-lg font-semibold text-content-primary mb-4">
          {user ? 'Edit User' : 'Create User'}
        </h3>

        {error && (
          <div role="alert" className="bg-red-50 border border-red-200 text-red-700 text-xs px-3 py-2 rounded mb-4">{error}</div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="user-form-email" className="block text-xs font-medium text-content-secondary mb-1">Email</label>
            <input
              id="user-form-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className="input-field"
              placeholder="user@example.com"
              disabled={!!user}
            />
          </div>
          <div>
            <label htmlFor="user-form-display-name" className="block text-xs font-medium text-content-secondary mb-1">Display Name</label>
            <input
              id="user-form-display-name"
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              className="input-field"
              placeholder="John Doe"
            />
          </div>

          <fieldset>
            <legend className="block text-xs font-medium text-content-secondary mb-2">Custom Attributes</legend>
            {Object.entries(attributes).map(([key, val]) => (
              <div key={key} className="mb-2 rounded-button border border-border bg-surface-secondary px-3 py-2 text-xs">
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="break-all font-mono font-semibold text-content-primary">{key}</div>
                    <UserAttributeValueDisplay attributeKey={key} value={val} />
                    {isReadOnlyUserAttributeValue(val) && (
                      <div className="text-[11px] leading-4 text-content-secondary">
                        Read-only in OmniKit. Saving other changes preserves this value exactly.
                      </div>
                    )}
                  </div>
                  {!isReadOnlyUserAttributeValue(val) && (
                    <button type="button" aria-label={`Remove ${key} attribute`} onClick={() => removeAttribute(key)} className="text-error hover:text-red-700">
                      <X size={12} />
                    </button>
                  )}
                </div>
              </div>
            ))}
            {attributeGuidance && (
              <div role="status" className="mb-2 rounded-button border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
                {attributeGuidance}
              </div>
            )}
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] sm:items-center">
              <input
                type="text"
                aria-label="Attribute key"
                value={attrKey}
                onChange={(e) => setAttrKey(e.target.value)}
                className="input-field text-xs flex-1"
                placeholder="Key"
                maxLength={SCIM_USER_ATTRIBUTE_LIMITS.maxKeyLength}
              />
              <input
                type="text"
                aria-label="Attribute value"
                value={attrVal}
                onChange={(e) => setAttrVal(e.target.value)}
                className="input-field text-xs flex-1"
                placeholder="Value"
                maxLength={SCIM_USER_ATTRIBUTE_LIMITS.maxStringLength}
              />
              <button type="button" aria-label="Add custom attribute" onClick={addAttribute} className="btn-secondary justify-center text-xs px-2 py-2">
                <Plus size={12} />
              </button>
            </div>
          </fieldset>

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

function downloadCsv(fileName: string, rows: CsvCellValue[][]) {
  const csv = csvRowsToText(rows);
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

function formatExportRemainingTime(remainingMs?: number): string {
  if (remainingMs === undefined) return 'Estimating time remaining';
  if (remainingMs <= 0) return 'Finishing export';
  const minutes = Math.ceil(remainingMs / 60_000);
  if (minutes <= 1) return 'About 1 minute remaining';
  if (minutes < 60) return `About ${minutes} minutes remaining`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `About ${hours}h${remainingMinutes > 0 ? ` ${remainingMinutes}m` : ''} remaining`;
}

function mapScimUser(user: Record<string, unknown>): OmniUser {
  const rawAttributes = user[USER_ATTRIBUTE_URN];
  const active = typeof user.active === 'boolean' ? user.active : undefined;
  return {
    id: user.id as string,
    userName: user.userName as string,
    displayName: (user.displayName as string) || '',
    ...(active === undefined ? {} : { active }),
    groups: (user.groups as OmniUser['groups']) || [],
    attributes: rawAttributes && typeof rawAttributes === 'object' && !Array.isArray(rawAttributes)
      ? cloneScimUserAttributes(rawAttributes as OmniUserAttributes)
      : {},
  };
}

export function UsersPage({ embedded = false }: { embedded?: boolean } = {}) {
  const { connection } = useConnection();
  const connectionKey = getConnectionCacheKey(connection);
  const activeConnectionKeyRef = useRef(connectionKey);
  const exportAbortRef = useRef<AbortController | null>(null);
  const exportLockRef = useRef(false);
  const [users, setUsers] = useState<OmniUser[]>([]);
  const [hasLoadedUsers, setHasLoadedUsers] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [totalResults, setTotalResults] = useState(0);
  const [userLoadTruncated, setUserLoadTruncated] = useState(false);
  const [page, setPage] = useState(1);
  const [showForm, setShowForm] = useState(false);
  const [editingUser, setEditingUser] = useState<OmniUser | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<OmniUser | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());
  const [accessPostureByUser, setAccessPostureByUser] = useState<Record<string, AdminAccessPosture>>({});
  const [accessPostureErrors, setAccessPostureErrors] = useState<Record<string, string>>({});
  const [loadingAccessPostureId, setLoadingAccessPostureId] = useState('');
  const [exportNotice, setExportNotice] = useState('');
  const [exportingUsers, setExportingUsers] = useState(false);
  const [userExportProgress, setUserExportProgress] = useState<IdentityExportProgress | null>(null);
  const [roleExportRateByConnection, setRoleExportRateByConnection] = useState<Record<string, IdentityExportRoleRequestLimit>>({});
  const [multiCreateRows, setMultiCreateRows] = useState<MultiCreateUserRow[]>([]);
  const [multiCreateProgress, setMultiCreateProgress] = useState<MultiCreateProgress>(null);
  const [creatingMany, setCreatingMany] = useState(false);
  const pageSize = 50;
  const roleExportRequestsPerMinute = roleExportRateByConnection[connectionKey] || 60;

  useLayoutEffect(() => {
    exportAbortRef.current?.abort();
    exportAbortRef.current = null;
    exportLockRef.current = false;
    activeConnectionKeyRef.current = connectionKey;
    setUsers([]);
    setHasLoadedUsers(false);
    setTotalResults(0);
    setUserLoadTruncated(false);
    setExpandedIds(new Set());
    setEditingUser(null);
    setDeleteTarget(null);
    setShowForm(false);
    setError('');
    setAccessPostureByUser({});
    setAccessPostureErrors({});
    setLoadingAccessPostureId('');
    setExportNotice('');
    setExportingUsers(false);
    setUserExportProgress(null);
    setMultiCreateRows([]);
    setMultiCreateProgress(null);
    setCreatingMany(false);
    return () => {
      exportAbortRef.current?.abort();
    };
  }, [connectionKey]);

  const fetchUsers = useCallback(async () => {
    const requestKey = connectionKey;
    setLoading(true);
    setError('');
    setUsers([]);
    setHasLoadedUsers(false);
    setTotalResults(0);
    setUserLoadTruncated(false);
    setAccessPostureByUser({});
    setAccessPostureErrors({});
    setLoadingAccessPostureId('');
    try {
      const res = await listAllUsers(connection.baseUrl, connection.apiKey, { pageSize: 100, maxPages: 200 });
      if (activeConnectionKeyRef.current !== requestKey) return;
      const nextUsers = (res.Resources || []).map(mapScimUser);
      if (res.error && nextUsers.length === 0) {
        setError('User records could not be loaded.');
        return;
      }
      setUsers(nextUsers);
      setHasLoadedUsers(true);
      setTotalResults(Number(res.totalResults) || nextUsers.length);
      setUserLoadTruncated(Boolean(res.truncated || res.error));
      if (res.error) {
        setError(`User collection is partial: ${nextUsers.length} of ${Number(res.totalResults) || 'an unknown total'} records were loaded.`);
      }
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

  async function handleSaveUser(data: UserFormData) {
    const requestKey = connectionKey;
    const body: Record<string, unknown> = {
      userName: data.userName,
      displayName: data.displayName,
    };

    if (editingUser) {
      if (typeof editingUser.active === 'boolean') body.active = editingUser.active;
      if (data.attributesDirty) body[USER_ATTRIBUTE_URN] = cloneScimUserAttributes(data.attributes);
      await updateUser(connection.baseUrl, connection.apiKey, editingUser.id, body);
    } else {
      if (Object.keys(data.attributes).length > 0) {
        body[USER_ATTRIBUTE_URN] = cloneScimUserAttributes(data.attributes);
      }
      await createUser(connection.baseUrl, connection.apiKey, body);
    }
    if (activeConnectionKeyRef.current !== requestKey) return;
    fetchUsers();
  }

  async function handleDeleteUser() {
    if (!deleteTarget) return;
    const requestKey = connectionKey;
    try {
      await deleteUser(connection.baseUrl, connection.apiKey, deleteTarget.id);
      if (activeConnectionKeyRef.current !== requestKey) return;
      setDeleteTarget(null);
      fetchUsers();
    } catch (err) {
      if (activeConnectionKeyRef.current !== requestKey) return;
      setError(friendlyApiError(err, 'Delete failed'));
      setDeleteTarget(null);
    }
  }

  async function handleDownloadCurrentUsers() {
    if (!hasLoadedUsers || userLoadTruncated || users.length !== totalResults) {
      setError(`User export is blocked because the collection is incomplete: ${users.length} of ${totalResults || 'an unknown total'} records are loaded.`);
      return;
    }
    if (exportLockRef.current) return;

    const requestKey = connectionKey;
    const controller = new AbortController();
    exportAbortRef.current?.abort();
    exportAbortRef.current = controller;
    exportLockRef.current = true;
    setExportingUsers(true);
    setUserExportProgress(null);
    setError('');
    setExportNotice('');

    let host = '';
    try {
      host = new URL(connection.baseUrl).hostname;
    } catch {
      host = '';
    }
    const instanceLabel = connection.instanceLabel?.trim() || host || 'the selected Omni instance';
    try {
      const result = await prepareIdentityUserExport(
        connection.baseUrl,
        connection.apiKey,
        {
          key: requestKey,
          label: instanceLabel,
          signal: controller.signal,
          isActive: () => activeConnectionKeyRef.current === requestKey,
          roleRequestsPerMinute: roleExportRequestsPerMinute,
        },
        (progress) => {
          if (activeConnectionKeyRef.current === requestKey && !controller.signal.aborted) {
            setUserExportProgress(progress);
          }
        },
      );
      if (activeConnectionKeyRef.current !== requestKey || controller.signal.aborted) return;
      downloadCsv('omnikit-current-users.csv', result.rows);
      showExportNotice(
        `User export started with ${result.userCount} users and ${result.directRoleCount} direct role assignment${result.directRoleCount === 1 ? '' : 's'}.${result.unknownAssignmentSourceUserCount > 0 ? ` ${result.unknownAssignmentSourceUserCount} user${result.unknownAssignmentSourceUserCount === 1 ? ' has' : 's have'} role evidence from an unrecognized assignment source; verified direct assignments were exported and unrecognized assignments were omitted.` : ''}${result.noAssignmentUserCount > 0 ? ` ${result.noAssignmentUserCount} of those user${result.noAssignmentUserCount === 1 ? 's was' : 's were'} tagged “No assignment” because no verified direct assignment was available; those markers will not change access when imported.` : ''}`,
      );
    } catch (nextError) {
      if (activeConnectionKeyRef.current !== requestKey) return;
      if (nextError instanceof DOMException && nextError.name === 'AbortError') {
        setExportNotice('User export cancelled. No file was downloaded.');
      } else {
        setError(friendlyApiError(nextError, 'User export could not be prepared'));
      }
    } finally {
      if (exportAbortRef.current === controller) {
        controller.abort();
        exportAbortRef.current = null;
        exportLockRef.current = false;
        if (activeConnectionKeyRef.current === requestKey) {
          setExportingUsers(false);
          setUserExportProgress(null);
        }
      }
    }
  }

  function showExportNotice(message: string) {
    setExportNotice(message);
    window.setTimeout(() => setExportNotice(''), 8000);
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
    const requestKey = connectionKey;
    const rows = multiCreateRows.filter((row) => row.email.trim() && row.displayName.trim());
    if (rows.length === 0) return;

    setCreatingMany(true);
    setError('');
    setMultiCreateProgress({ current: 0, total: rows.length, results: [] });

    for (let i = 0; i < rows.length; i++) {
      if (activeConnectionKeyRef.current !== requestKey) return;
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
        if (activeConnectionKeyRef.current !== requestKey) return;
        message = `Created ${row.email.trim()}`;
      } catch (err) {
        if (activeConnectionKeyRef.current !== requestKey) return;
        message = `Error ${row.email.trim()}: ${friendlyApiError(err, 'Create user failed')}`;
      }

      if (activeConnectionKeyRef.current !== requestKey) return;
      setMultiCreateProgress((prev) => ({
        current: i + 1,
        total: rows.length,
        results: [...(prev?.results || []), message],
      }));
    }

    if (activeConnectionKeyRef.current !== requestKey) return;
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

  async function inspectAccessPosture(userId: string) {
    const requestKey = connectionKey;
    if (!connection.instanceId) {
      setAccessPostureErrors((prev) => ({ ...prev, [userId]: 'Choose an active saved Omni instance before inspecting model-role assignments.' }));
      return;
    }
    setLoadingAccessPostureId(userId);
    setAccessPostureErrors((prev) => {
      const next = { ...prev };
      delete next[userId];
      return next;
    });
    try {
      const report = await fetchAdminReadiness(connection.instanceId, 'identity', {
        principalType: 'user',
        principalId: userId,
      });
      if (activeConnectionKeyRef.current !== requestKey) return;
      if (!report.accessPosture) throw new Error('Omni returned no model-role assignment evidence.');
      setAccessPostureByUser((prev) => ({ ...prev, [userId]: report.accessPosture! }));
    } catch (nextError) {
      if (activeConnectionKeyRef.current !== requestKey) return;
      setAccessPostureByUser((prev) => {
        const next = { ...prev };
        delete next[userId];
        return next;
      });
      setAccessPostureErrors((prev) => ({
        ...prev,
        [userId]: friendlyApiError(nextError, 'Model-role assignments could not be inspected'),
      }));
    } finally {
      if (activeConnectionKeyRef.current === requestKey) setLoadingAccessPostureId('');
    }
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
      ? `${users.length} of ${totalResults} users loaded${userLoadTruncated ? ' (partial collection coverage)' : ''}`
      : `${users.length} users loaded`;
  const userCollectionComplete = hasLoadedUsers
    && !userLoadTruncated
    && users.length === totalResults;
  const headerActions = (
    <div className="flex flex-wrap items-center gap-2">
      <label className="flex items-center gap-2 text-xs text-content-secondary">
        <span>Export pace</span>
        <select
          aria-label="Complete user export API pace"
          value={roleExportRequestsPerMinute}
          disabled={exportingUsers}
          onChange={(event) => {
            const nextRate: IdentityExportRoleRequestLimit = event.target.value === '500' ? 500 : 60;
            setRoleExportRateByConnection((current) => ({ ...current, [connectionKey]: nextRate }));
          }}
          title="Use the accelerated pace only when Omni Support has approved the 500 requests-per-minute limit for this instance."
          className="input-field w-auto py-2 text-xs disabled:opacity-50"
        >
          <option value={60}>Standard (60/min)</option>
          <option value={500}>Approved accelerated (500/min)</option>
        </select>
      </label>
      <button
        onClick={handleDownloadCurrentUsers}
        disabled={users.length === 0 || !userCollectionComplete || exportingUsers}
        title={!userCollectionComplete && users.length > 0 ? 'Export requires complete user collection coverage.' : undefined}
        className="btn-secondary text-sm disabled:opacity-40"
      >
        {exportingUsers ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
        {exportingUsers ? 'Preparing Export' : 'Export Users'}
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
              Create and edit individual users here, or use Bulk Import for users, groups, memberships, and model roles together.
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

      {exportingUsers && userExportProgress && (
        <section className="card space-y-3" aria-live="polite" aria-label="User export progress">
          <div className="flex items-start justify-between gap-3">
            <div className="flex min-w-0 items-start gap-3">
              <Loader2 size={18} className="mt-0.5 shrink-0 animate-spin text-omni-700" />
              <div className="min-w-0">
                <div className="text-sm font-semibold text-content-primary">Preparing complete user export</div>
                <p className="mt-0.5 text-xs text-content-secondary">{userExportProgress.message}</p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => exportAbortRef.current?.abort()}
              className="btn-secondary shrink-0 text-xs"
            >
              Cancel
            </button>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-gray-200">
            <div
              className="h-full rounded-full bg-omni-700 transition-all duration-300"
              style={{ width: `${Math.min(100, (userExportProgress.completed / Math.max(userExportProgress.total, 1)) * 100)}%` }}
            />
          </div>
          <div className="flex items-center justify-between gap-3 text-[11px] text-content-secondary">
            <span>Step {userExportProgress.phase} of {userExportProgress.phaseTotal} · {userExportProgress.stage}</span>
            <span>
              {userExportProgress.stage === 'User access'
                ? `${userExportProgress.stageCompleted.toLocaleString()}/${userExportProgress.stageTotal.toLocaleString()} users · ${formatExportRemainingTime(userExportProgress.estimatedRemainingMs)}`
                : `${userExportProgress.stageCompleted}/${userExportProgress.stageTotal} complete`}
            </span>
          </div>
        </section>
      )}

      <div className="grid md:grid-cols-3 gap-3">
        <div className="card p-4">
          <div className="text-xs font-medium text-content-secondary uppercase tracking-wider">Migration Use Case</div>
          <div className="mt-2 text-sm font-semibold text-content-primary">Bulk user provisioning</div>
          <p className="mt-1 text-xs text-content-secondary leading-5">Upload exported users from a legacy BI tool and upsert them through Omni SCIM.</p>
        </div>
        <div className="card p-4">
          <div className="text-xs font-medium text-content-secondary uppercase tracking-wider">CSV Operations</div>
          <div className="mt-2 text-sm font-semibold text-content-primary">Validated before changes</div>
          <p className="mt-1 text-xs text-content-secondary leading-5">Bulk Import previews create, update, membership, and destructive actions before anything runs.</p>
        </div>
        <div className="card p-4">
          <div className="text-xs font-medium text-content-secondary uppercase tracking-wider">Next Step</div>
          <div className="mt-2 text-sm font-semibold text-content-primary">Use one CSV</div>
          <p className="mt-1 text-xs text-content-secondary leading-5">Open Bulk Import to provision users, ensure groups, assign memberships, and resolve scoped model roles in dependency-safe order.</p>
        </div>
      </div>

      <fieldset disabled={creatingMany} className="card min-w-0 space-y-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <div className="text-sm font-semibold text-content-primary">Create Multiple Users</div>
            <p className="text-xs text-content-secondary mt-0.5">
              Add a few users directly in the UI. Department and role here are custom user attributes, not Omni connection/model permissions. Use CSV import when the batch is large or needs scoped roles.
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
              <div className="col-span-6 md:col-span-2">User attribute: role</div>
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
                  placeholder="Optional attribute"
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
      </fieldset>

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
          ) : !hasLoadedUsers ? (
            <div className="text-center py-12 text-content-secondary text-sm">User records were not loaded. Review the request error and try again.</div>
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
                      <button
                        type="button"
                        onClick={() => toggleExpand(user.id)}
                        aria-label={`${isExpanded ? 'Collapse' : 'Expand'} ${user.userName}`}
                        aria-expanded={isExpanded}
                        className="text-content-secondary hover:text-content-primary"
                      >
                        {isExpanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                      </button>
                    </div>
                    <div className="col-span-4 text-sm text-content-primary truncate font-mono">{user.userName}</div>
                    <div className="col-span-3 text-sm text-content-secondary truncate">{user.displayName}</div>
                    <div className="col-span-2">
                      <span className={`text-xs font-medium px-2 py-0.5 rounded-chip ${user.active === true ? 'bg-green-100 text-green-800' : user.active === false ? 'bg-gray-100 text-gray-600' : 'bg-yellow-100 text-yellow-900'}`}>
                        {user.active === true ? 'Active' : user.active === false ? 'Inactive' : 'Status unknown'}
                      </span>
                    </div>
                    <div className="col-span-2 flex justify-end gap-1">
                      <button
                        type="button"
                        aria-label={`Edit ${user.userName}`}
                        onClick={() => { setEditingUser(user); setShowForm(true); }}
                        className="p-1.5 text-content-secondary hover:text-omni-700 hover:bg-omni-100 rounded transition-colors"
                      >
                        <Edit3 size={14} />
                      </button>
                      <button
                        type="button"
                        aria-label={`Delete ${user.userName}`}
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
                        {user.attributes && Object.keys(user.attributes).length > 0 && (
                          <div className="space-y-2 pt-1">
                            <span className="font-medium text-content-primary">Attributes:</span>
                            <div className="grid gap-2 sm:grid-cols-2">
                              {Object.entries(user.attributes).map(([key, value]) => (
                                <div key={key} className="min-w-0 rounded-button border border-border bg-white px-3 py-2">
                                  <div className="break-all font-mono font-semibold text-content-primary">{key}</div>
                                  <div className="mt-1">
                                    <UserAttributeValueDisplay attributeKey={key} value={value} />
                                  </div>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                      <div className="mt-3">
                        <button
                          type="button"
                          onClick={() => inspectAccessPosture(user.id)}
                          disabled={loadingAccessPostureId === user.id || !connection.instanceId}
                          className="btn-secondary text-xs disabled:opacity-40"
                        >
                          {loadingAccessPostureId === user.id ? <Loader2 size={12} className="animate-spin" /> : null}
                          Inspect model-role assignments
                        </button>
                        {accessPostureErrors[user.id] && <div role="alert" className="mt-2 rounded-card border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">{accessPostureErrors[user.id]}</div>}
                        {accessPostureByUser[user.id] && <AccessPostureEvidence posture={accessPostureByUser[user.id]} />}
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
