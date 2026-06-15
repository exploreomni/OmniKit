import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Cloud,
  Edit3,
  HardDrive,
  LayoutDashboard,
  Loader2,
  Mail,
  MessageSquare,
  PauseCircle,
  PlayCircle,
  Plus,
  Send,
  Trash2,
  Webhook,
  X,
} from 'lucide-react';
import { useConnection } from '@/contexts/ConnectionContext';
import { useConnectionRequestGuard } from '@/hooks/useConnectionRequestGuard';
import { listDocuments, omniProxy } from '@/services/omniApi';
import { PageHeader } from '@/components/layout/PageHeader';
import { SearchInput } from '@/components/ui/SearchInput';
import { StatusChip } from '@/components/ui/StatusChip';
import { Blobby } from '@/components/ui/Blobby';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { WorkflowStatusScene } from '@/components/ui/WorkflowStatusScene';
import { selectedBadgeClass, selectedRowClass, unselectedRowClass } from '@/components/ui/selectionStyles';
import { friendlyApiError } from '@/utils/apiErrors';
import type { OmniDocument, OmniSchedule, PageInfo } from '@/types';

const DESTINATION_ICONS: Record<string, typeof Mail> = {
  email: Mail,
  webhook: Webhook,
  sftp: HardDrive,
  slack: MessageSquare,
  s3: Cloud,
};

const SCHEDULE_TABLE_COLUMNS = {
  gridTemplateColumns: 'minmax(240px, 1.5fr) minmax(180px, 1fr) minmax(190px, 1fr) minmax(76px, 0.4fr) minmax(78px, 0.45fr) minmax(170px, 0.9fr) minmax(150px, 0.9fr) minmax(132px, 0.7fr)',
};

const ACTION_GUIDE = [
  { label: 'Edit', description: 'Change schedule settings.', icon: Edit3 },
  { label: 'Send now', description: 'Trigger one delivery.', icon: Send },
  { label: 'Pause / resume', description: 'Stop or restart future runs.', icon: PauseCircle },
  { label: 'Delete', description: 'Remove the schedule.', icon: Trash2 },
];

interface ScheduleFormValues {
  id?: string;
  name: string;
  identifier: string;
  schedule: string;
  timezone: string;
  format: string;
  destinationType: string;
  recipients: string;
  subject: string;
  url: string;
  testNow: boolean;
}

type ScheduleDashboardOption = OmniDocument & {
  displayName: string;
  documentKind: string;
  scheduleIdentifier: string;
};

const EMPTY_SCHEDULE: ScheduleFormValues = {
  name: '',
  identifier: '',
  schedule: '0 9 ? * MON *',
  timezone: 'UTC',
  format: 'pdf',
  destinationType: 'email',
  recipients: '',
  subject: '',
  url: '',
  testNow: false,
};

function cronToReadable(cron: string): string {
  const parts = cron.trim().split(/\s+/);
  const normalizedParts = parts.length === 6 ? parts.slice(1) : parts;
  if (normalizedParts.length < 5) return cron;
  const [min, hour, dayOfMonth, month, dayOfWeek] = normalizedParts;
  if (dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    if (hour === '*') return `Every hour at :${min.padStart(2, '0')}`;
    return `Daily at ${hour}:${min.padStart(2, '0')}`;
  }
  if (dayOfWeek !== '*' && dayOfMonth === '*') return `Weekly (${dayOfWeek}) at ${hour}:${min.padStart(2, '0')}`;
  return cron;
}

function extractScheduleDocuments(payload: unknown): OmniDocument[] {
  const candidates = [
    (payload as { documents?: unknown })?.documents,
    (payload as { records?: unknown })?.records,
    (payload as { data?: { documents?: unknown; records?: unknown } })?.data?.documents,
    (payload as { data?: { documents?: unknown; records?: unknown } })?.data?.records,
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate as OmniDocument[];
  }

  return [];
}

function normalizeDashboardOption(doc: OmniDocument): ScheduleDashboardOption | null {
  const raw = doc as OmniDocument & { title?: string; displayTitle?: string; documentKind?: string; document?: { id?: string; name?: string; title?: string; displayTitle?: string; identifier?: string; type?: string; documentKind?: string } };
  const nested = raw.document;
  const scheduleIdentifier = doc.id || nested?.id || doc.identifier || nested?.identifier || '';
  if (!scheduleIdentifier) return null;

  return {
    ...doc,
    id: doc.id || nested?.id || scheduleIdentifier,
    displayName: doc.name || raw.title || raw.displayTitle || nested?.name || nested?.title || nested?.displayTitle || 'Untitled dashboard',
    documentKind: doc.type || raw.documentKind || nested?.type || nested?.documentKind || 'dashboard',
    scheduleIdentifier,
  };
}

function bodyFromValues(values: ScheduleFormValues, editing: boolean): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: values.name,
    schedule: values.schedule,
    timezone: values.timezone,
    format: values.format,
    destinationType: values.destinationType,
  };

  if (!editing || values.identifier) body.identifier = values.identifier;
  if (values.testNow) body.testNow = true;

  if (values.destinationType === 'email') {
    const recipients = values.recipients.split(',').map((recipient) => recipient.trim()).filter(Boolean);
    if (recipients.length > 0) body.recipients = recipients;
    if (values.subject.trim()) body.subject = values.subject.trim();
  }

  if (values.destinationType === 'webhook' && values.url.trim()) {
    body.url = values.url.trim();
  }

  return body;
}

function ScheduleActionButton({
  label,
  description,
  onClick,
  tone = 'default',
  children,
}: {
  label: string;
  description: string;
  onClick: () => void;
  tone?: 'default' | 'danger';
  children: ReactNode;
}) {
  const toneClasses = tone === 'danger'
    ? 'hover:text-error hover:bg-red-50'
    : 'hover:text-omni-700 hover:bg-omni-100';

  return (
    <button
      type="button"
      onClick={onClick}
      className={`group relative rounded p-1 text-content-secondary transition-colors ${toneClasses}`}
      title={`${label}: ${description}`}
      aria-label={`${label}: ${description}`}
    >
      {children}
      <span className="pointer-events-none absolute bottom-full right-0 z-20 mb-2 hidden w-44 rounded-card border border-border bg-white px-2.5 py-2 text-left text-[11px] leading-4 text-content-secondary shadow-dropdown group-hover:block group-focus:block">
        <span className="block font-semibold text-content-primary">{label}</span>
        <span>{description}</span>
      </span>
    </button>
  );
}

function ScheduleFormModal({
  open,
  schedule,
  onClose,
  onSave,
}: {
  open: boolean;
  schedule: OmniSchedule | null;
  onClose: () => void;
  onSave: (values: ScheduleFormValues) => Promise<void>;
}) {
  const { connection } = useConnection();
  const { connectionKey, isActiveConnectionRequest } = useConnectionRequestGuard(connection);
  const [values, setValues] = useState<ScheduleFormValues>(EMPTY_SCHEDULE);
  const [dashboards, setDashboards] = useState<ScheduleDashboardOption[]>([]);
  const [dashboardsLoaded, setDashboardsLoaded] = useState(false);
  const [dashboardSearch, setDashboardSearch] = useState('');
  const [loadingDashboards, setLoadingDashboards] = useState(false);
  const [dashboardError, setDashboardError] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const editing = !!schedule;
  const selectedDashboard = dashboards.find((dashboard) => dashboard.scheduleIdentifier === values.identifier);

  useEffect(() => {
    if (!open) return;
    if (schedule) {
      setValues({
        ...EMPTY_SCHEDULE,
        id: schedule.id,
        name: schedule.name || '',
        identifier: schedule.identifier || '',
        schedule: schedule.schedule || EMPTY_SCHEDULE.schedule,
        timezone: schedule.timezone || EMPTY_SCHEDULE.timezone,
        format: schedule.format || EMPTY_SCHEDULE.format,
        destinationType: schedule.destinationType || 'email',
        subject: schedule.name || '',
      });
    } else {
      setValues(EMPTY_SCHEDULE);
    }
    setError('');
    setDashboardSearch(schedule?.dashboardName || '');
  }, [open, schedule]);

  useEffect(() => {
    setDashboards([]);
    setDashboardsLoaded(false);
    setDashboardError('');
  }, [connectionKey]);

  useEffect(() => {
    if (!open || dashboardsLoaded) return;
    let cancelled = false;
    const requestKey = connectionKey;

    async function loadDashboards() {
      setLoadingDashboards(true);
      setDashboardError('');
      try {
        const res = await listDocuments(connection.baseUrl, connection.apiKey, undefined, { allPages: true, pageSize: 250 });
        if (cancelled || !isActiveConnectionRequest(requestKey)) return;
        const nextDashboards = extractScheduleDocuments(res)
          .map(normalizeDashboardOption)
          .filter((doc): doc is ScheduleDashboardOption => Boolean(doc))
          .sort((a, b) => a.displayName.localeCompare(b.displayName));
        setDashboards(nextDashboards);
        setDashboardsLoaded(true);
      } catch (err) {
        if (!cancelled && isActiveConnectionRequest(requestKey)) {
          setDashboards([]);
          setDashboardsLoaded(false);
          setDashboardError(friendlyApiError(err, 'Failed to load dashboards'));
        }
      } finally {
        if (!cancelled && isActiveConnectionRequest(requestKey)) setLoadingDashboards(false);
      }
    }

    loadDashboards();
    return () => {
      cancelled = true;
    };
  }, [connection.apiKey, connection.baseUrl, connectionKey, dashboardsLoaded, isActiveConnectionRequest, open]);

  const filteredDashboards = useMemo(() => {
    const term = dashboardSearch.trim().toLowerCase();
    if (!term) return dashboards;
    return dashboards
      .filter((dashboard) => (
        dashboard.displayName.toLowerCase().includes(term) ||
        dashboard.scheduleIdentifier.toLowerCase().includes(term) ||
        dashboard.documentKind.toLowerCase().includes(term) ||
        (dashboard.folderPath || '').toLowerCase().includes(term) ||
        (dashboard.baseModelName || '').toLowerCase().includes(term)
      ));
  }, [dashboardSearch, dashboards]);

  if (!open) return null;

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setError('');
    if (!values.name.trim() || !values.schedule.trim() || !values.timezone.trim()) return;
    if (!editing && !values.identifier.trim()) {
      setError('Select a dashboard or report for this schedule.');
      return;
    }
    if (!editing && !['email', 'webhook'].includes(values.destinationType)) {
      setError('Create email or webhook schedules here. Manage advanced Slack, SFTP, and S3 destination credentials in Omni.');
      return;
    }
    if (values.destinationType === 'email' && !editing && !values.recipients.trim()) {
      setError('Email recipients are required for new email schedules.');
      return;
    }
    if (values.destinationType === 'webhook' && !editing && !values.url.trim()) {
      setError('Webhook URL is required for new webhook schedules.');
      return;
    }

    setSaving(true);
    try {
      await onSave(values);
      onClose();
    } catch (err) {
      setError(friendlyApiError(err, editing ? 'Failed to update schedule' : 'Failed to create schedule'));
    } finally {
      setSaving(false);
    }
  }

  function updateValue<K extends keyof ScheduleFormValues>(key: K, value: ScheduleFormValues[K]) {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  function selectDashboard(dashboard: ScheduleDashboardOption) {
    setValues((prev) => ({
      ...prev,
      identifier: dashboard.scheduleIdentifier,
      name: prev.name.trim() ? prev.name : dashboard.displayName,
      subject: prev.subject.trim() ? prev.subject : dashboard.displayName,
    }));
    setDashboardSearch(dashboard.displayName);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-card bg-white p-6 shadow-dropdown mx-4">
        <button onClick={onClose} className="absolute top-4 right-4 text-content-secondary hover:text-content-primary">
          <X size={18} />
        </button>
        <h3 className="text-lg font-semibold text-content-primary mb-1">
          {editing ? 'Manage Schedule' : 'Create Schedule'}
        </h3>
        <p className="text-xs text-content-secondary mb-4">
          Configure the schedule body Omni expects, then save it through the schedule API.
        </p>

        {error && (
          <div className="bg-red-50 border border-red-200 text-red-700 text-xs px-3 py-2 rounded mb-3">{error}</div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid md:grid-cols-2 gap-4">
            <div className="md:col-span-2">
              <label className="block text-xs font-medium text-content-secondary mb-1">Schedule Name</label>
              <input value={values.name} onChange={(event) => updateValue('name', event.target.value)} className="input-field" placeholder="Weekly Sales Report" />
            </div>
            <div className="md:col-span-2 rounded-card border border-border bg-white p-3">
              <div className="mb-2 flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <label className="block text-xs font-medium text-content-secondary mb-1">Dashboard or report</label>
                  <p className="text-xs text-content-secondary">Search the cached Omni content list, then select the item this schedule should deliver.</p>
                </div>
                <div className="flex items-center gap-2 text-xs text-content-secondary">
                  {dashboardsLoaded && <span>{filteredDashboards.length} of {dashboards.length}</span>}
                  {loadingDashboards && (
                    <span className="inline-flex items-center gap-1">
                      <Loader2 size={12} className="animate-spin" />
                      Loading content
                    </span>
                  )}
                </div>
              </div>
              <div className={`rounded-button border bg-white transition-colors ${values.identifier ? 'border-omni-200 shadow-sm' : 'border-border'}`}>
                <div className="flex items-center gap-2 px-3 py-2">
                  <LayoutDashboard size={15} className={values.identifier ? 'text-omni-700 flex-shrink-0' : 'text-content-secondary flex-shrink-0'} />
                  <input
                    value={dashboardSearch}
                    onChange={(event) => setDashboardSearch(event.target.value)}
                    className="min-w-0 flex-1 border-0 bg-transparent text-sm text-content-primary outline-none placeholder:text-content-tertiary"
                    placeholder="Search dashboards or reports by name, folder, model, or ID..."
                  />
                  {values.identifier && (
                    <span className="hidden max-w-[180px] truncate rounded-chip bg-omni-50 px-2 py-1 font-mono text-[10px] text-omni-800 sm:inline">
                      {selectedDashboard?.documentKind || 'document'} · {values.identifier}
                    </span>
                  )}
                </div>
                {values.identifier && (
                  <div className="border-t border-border/60 px-3 py-1.5 text-[10px] text-content-secondary sm:hidden">
                    Selected {selectedDashboard?.documentKind || 'document'} ID: <span className="font-mono">{values.identifier}</span>
                  </div>
                )}
              </div>
              {values.identifier && selectedDashboard && (
                <div className="mt-2 text-[11px] text-content-secondary">
                  Selected: <span className="font-semibold text-content-primary">{selectedDashboard.displayName}</span>
                  {selectedDashboard.folderPath && <span> · {selectedDashboard.folderPath}</span>}
                </div>
              )}
              {dashboardError && (
                <div className="mt-2 rounded-button border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                  {dashboardError}
                </div>
              )}
              <div className="mt-2 max-h-56 overflow-y-auto rounded-button border border-border divide-y divide-border/50">
                {loadingDashboards ? (
                  <div className="px-3 py-4 text-sm text-content-secondary">Loading dashboards and reports...</div>
                ) : filteredDashboards.length === 0 ? (
                  <div className="px-3 py-4 text-sm text-content-secondary">
                    {dashboards.length === 0 ? 'No dashboards or reports were returned from Omni.' : 'No dashboards or reports match that search.'}
                  </div>
                ) : (
                  filteredDashboards.map((dashboard) => {
                    const isSelected = dashboard.scheduleIdentifier === values.identifier;
                    return (
                      <button
                        key={dashboard.scheduleIdentifier}
                        type="button"
                        onClick={() => selectDashboard(dashboard)}
                        aria-pressed={isSelected}
                        className={`block w-full px-3 py-2 text-left transition-all ${
                          isSelected ? selectedRowClass : unselectedRowClass
                        }`}
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          <LayoutDashboard size={14} className={isSelected ? 'text-omni-700 flex-shrink-0' : 'text-content-secondary flex-shrink-0'} />
                          <span className="truncate text-sm font-medium text-content-primary">{dashboard.displayName}</span>
                          {isSelected && (
                            <span className={selectedBadgeClass}>
                              <CheckCircle2 size={12} />
                              Selected
                            </span>
                          )}
                        </div>
                        <div className="mt-0.5 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-content-secondary">
                          <span className="capitalize">{dashboard.documentKind}</span>
                          {dashboard.folderPath && <span className="truncate">Folder: {dashboard.folderPath}</span>}
                          {dashboard.baseModelName && <span className="truncate">Model: {dashboard.baseModelName}</span>}
                          <span className="font-mono">{dashboard.scheduleIdentifier}</span>
                        </div>
                      </button>
                    );
                  })
                )}
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-content-secondary mb-1">Cron Schedule</label>
              <input value={values.schedule} onChange={(event) => updateValue('schedule', event.target.value)} className="input-field font-mono text-xs" placeholder="0 9 ? * MON *" />
            </div>
            <div>
              <label className="block text-xs font-medium text-content-secondary mb-1">Timezone</label>
              <input value={values.timezone} onChange={(event) => updateValue('timezone', event.target.value)} className="input-field" placeholder="America/New_York" />
            </div>
            <div>
              <label className="block text-xs font-medium text-content-secondary mb-1">Format</label>
              <select value={values.format} onChange={(event) => updateValue('format', event.target.value)} className="input-field">
                <option value="pdf">PDF</option>
                <option value="png">PNG</option>
                <option value="xlsx">XLSX</option>
                <option value="csv">CSV</option>
                <option value="json">JSON</option>
                <option value="link_only">Link only</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-content-secondary mb-1">Destination</label>
              <select value={values.destinationType} onChange={(event) => updateValue('destinationType', event.target.value)} className="input-field">
                <option value="email">Email</option>
                <option value="webhook">Webhook</option>
                <option value="slack">Slack</option>
                <option value="sftp">SFTP</option>
                <option value="s3">S3</option>
              </select>
            </div>
          </div>

          {values.destinationType === 'email' ? (
            <div className="grid md:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-content-secondary mb-1">Recipients</label>
                <input value={values.recipients} onChange={(event) => updateValue('recipients', event.target.value)} className="input-field" placeholder="person@example.com, team@example.com" />
              </div>
              <div>
                <label className="block text-xs font-medium text-content-secondary mb-1">Subject</label>
                <input value={values.subject} onChange={(event) => updateValue('subject', event.target.value)} className="input-field" placeholder="Weekly Sales Dashboard" />
              </div>
            </div>
          ) : (
            values.destinationType === 'webhook' ? (
            <div>
              <label className="block text-xs font-medium text-content-secondary mb-1">Webhook URL</label>
              <input value={values.url} onChange={(event) => updateValue('url', event.target.value)} className="input-field" placeholder="https://example.com/webhook" />
            </div>
            ) : (
              <div className="rounded-card border border-yellow-200 bg-yellow-50 px-3 py-2 text-xs text-yellow-800">
                Advanced destinations such as Slack, SFTP, and S3 can be paused, resumed, triggered, deleted, or edited for core schedule fields here. Destination-specific credentials should be managed in Omni.
              </div>
            )
          )}

          {!editing && (
            <label className="flex items-center gap-2 text-xs text-content-secondary">
              <input
                type="checkbox"
                checked={values.testNow}
                onChange={(event) => updateValue('testNow', event.target.checked)}
                className="accent-omni-700"
              />
              Trigger a test delivery after creating the schedule.
            </label>
          )}

          <div className="flex justify-end gap-3 pt-2">
            <button type="button" onClick={onClose} className="btn-secondary text-sm">Cancel</button>
            <button type="submit" disabled={saving} className="btn-primary text-sm">
              {saving ? <Loader2 size={14} className="animate-spin" /> : <Send size={14} />}
              {editing ? 'Save Schedule' : 'Create Schedule'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export function SchedulesPage() {
  const { connection } = useConnection();
  const { connectionKey, isActiveConnectionRequest } = useConnectionRequestGuard(connection);
  const [schedules, setSchedules] = useState<OmniSchedule[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [destFilter, setDestFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [page, setPage] = useState(1);
  const [pageInfo, setPageInfo] = useState<PageInfo | null>(null);
  const [formSchedule, setFormSchedule] = useState<OmniSchedule | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<OmniSchedule | null>(null);
  const [actionLoadingId, setActionLoadingId] = useState<string | null>(null);

  const fetchSchedules = useCallback(async (pageNum: number) => {
    const requestKey = connectionKey;
    setLoading(true);
    setError('');
    try {
      const params: Record<string, string> = { cursor: String(pageNum), pageSize: '25' };
      if (search) params.q = search;
      if (statusFilter) params.status = statusFilter;
      if (destFilter) params.destination = destFilter;
      if (typeFilter) params.scheduleType = typeFilter;

      const res = await omniProxy<{ records?: OmniSchedule[]; pageInfo?: PageInfo }>(
        connection.baseUrl,
        connection.apiKey,
        'GET',
        '/v1/schedules',
        { queryParams: params },
      );
      if (!isActiveConnectionRequest(requestKey)) return;
      setSchedules(res.records || []);
      setPageInfo(res.pageInfo || null);
    } catch (err) {
      if (!isActiveConnectionRequest(requestKey)) return;
      setError(friendlyApiError(err, 'Failed to load schedules'));
    } finally {
      if (isActiveConnectionRequest(requestKey)) setLoading(false);
    }
  }, [connection.baseUrl, connection.apiKey, connectionKey, destFilter, isActiveConnectionRequest, search, statusFilter, typeFilter]);

  useEffect(() => {
    setSchedules([]);
    setPageInfo(null);
    setPage(1);
  }, [connectionKey]);

  useEffect(() => {
    fetchSchedules(page);
  }, [fetchSchedules, page]);

  async function handleSaveSchedule(values: ScheduleFormValues) {
    const editing = Boolean(values.id);
    const body = bodyFromValues(values, editing);
    if (editing) {
      await omniProxy(connection.baseUrl, connection.apiKey, 'PUT', `/v1/schedules/${values.id}`, { body });
    } else {
      await omniProxy(connection.baseUrl, connection.apiKey, 'POST', '/v1/schedules', { body });
    }
    await fetchSchedules(page);
  }

  async function runScheduleAction(schedule: OmniSchedule, action: 'pause' | 'resume' | 'trigger' | 'delete') {
    setActionLoadingId(`${schedule.id}-${action}`);
    setError('');
    try {
      if (action === 'pause') {
        await omniProxy(connection.baseUrl, connection.apiKey, 'PUT', `/v1/schedules/${schedule.id}/pause`);
      } else if (action === 'resume') {
        await omniProxy(connection.baseUrl, connection.apiKey, 'PUT', `/v1/schedules/${schedule.id}/resume`);
      } else if (action === 'trigger') {
        await omniProxy(connection.baseUrl, connection.apiKey, 'POST', `/v1/schedules/${schedule.id}/trigger`);
      } else {
        await omniProxy(connection.baseUrl, connection.apiKey, 'DELETE', `/v1/schedules/${schedule.id}`);
      }
      await fetchSchedules(page);
    } catch (err) {
      setError(friendlyApiError(err, `Failed to ${action} schedule`));
    } finally {
      setActionLoadingId(null);
      if (action === 'delete') setDeleteTarget(null);
    }
  }

  function handleSearchSubmit() {
    setPage(1);
    fetchSchedules(1);
  }

  const totalPages = pageInfo ? Math.ceil(pageInfo.totalRecords / pageInfo.pageSize) : 1;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Schedule Management"
        description={`Configure, test, pause, resume, and manage recurring Omni deliveries. ${pageInfo?.totalRecords ?? schedules.length} scheduled deliveries found.`}
        icon={<Blobby mood="schedule" size={58} className="animate-float" style={{ animationDuration: '3.6s' }} />}
        actions={
          <button
            onClick={() => {
              setFormSchedule(null);
              setFormOpen(true);
            }}
            className="btn-primary text-sm"
          >
            <Plus size={14} />
            Create Schedule
          </button>
        }
      />

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-card">{error}</div>
      )}

      <div className="grid md:grid-cols-3 gap-3">
        <div className="card p-4">
          <div className="text-xs font-medium text-content-secondary uppercase tracking-wider">Configure</div>
          <div className="mt-2 text-sm font-semibold text-content-primary">Create and update deliveries</div>
          <p className="mt-1 text-xs text-content-secondary leading-5">Search for a dashboard or report, then set cron, timezone, format, and email or webhook destinations.</p>
        </div>
        <div className="card p-4">
          <div className="text-xs font-medium text-content-secondary uppercase tracking-wider">Operate</div>
          <div className="mt-2 text-sm font-semibold text-content-primary">Pause, resume, trigger</div>
          <p className="mt-1 text-xs text-content-secondary leading-5">Control schedule runtime without leaving the governance workflow.</p>
        </div>
        <div className="card p-4">
          <div className="text-xs font-medium text-content-secondary uppercase tracking-wider">Audit</div>
          <div className="mt-2 text-sm font-semibold text-content-primary">Owner and delivery health</div>
          <p className="mt-1 text-xs text-content-secondary leading-5">Filter by status, destination, and alert type to find operational risk quickly.</p>
        </div>
      </div>

      <div className="flex flex-wrap gap-3">
        <div className="flex-1 min-w-[200px]">
          <SearchInput value={search} onChange={setSearch} placeholder="Search schedules..." />
        </div>
        <select value={statusFilter} onChange={(event) => { setStatusFilter(event.target.value); setPage(1); }} className="input-field w-auto">
          <option value="">All Statuses</option>
          <option value="success">Success</option>
          <option value="error">Error</option>
          <option value="canceled">Canceled</option>
          <option value="none">None</option>
        </select>
        <select value={destFilter} onChange={(event) => { setDestFilter(event.target.value); setPage(1); }} className="input-field w-auto">
          <option value="">All Destinations</option>
          <option value="email">Email</option>
          <option value="slack">Slack</option>
          <option value="webhook">Webhook</option>
          <option value="sftp">SFTP</option>
          <option value="s3">S3</option>
        </select>
        <select value={typeFilter} onChange={(event) => { setTypeFilter(event.target.value); setPage(1); }} className="input-field w-auto">
          <option value="">All Types</option>
          <option value="schedule">Schedule</option>
          <option value="alert">Alert</option>
        </select>
        <button onClick={handleSearchSubmit} className="btn-secondary text-sm px-4">Search</button>
      </div>

      {loading ? (
        <WorkflowStatusScene
          variant="bulk-upload"
          title="Loading schedules"
          detail="Pulling schedule definitions, owner signals, and delivery status."
          statusLabel="Loading"
          compact
        />
      ) : (
        <div className="card p-0 overflow-hidden">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-white px-4 py-3">
            <div>
              <div className="text-sm font-semibold text-content-primary">Schedule controls</div>
              <p className="text-xs text-content-secondary">Hover any action icon for details, or use this guide while reviewing deliveries.</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {ACTION_GUIDE.map(({ label, description, icon: Icon }) => (
                <div
                  key={label}
                  className="inline-flex items-center gap-1.5 rounded-chip border border-border bg-surface-secondary px-2.5 py-1 text-[11px] text-content-secondary"
                  title={`${label}: ${description}`}
                >
                  <Icon size={13} className="text-content-secondary" />
                  <span className="font-semibold text-content-primary">{label}</span>
                  <span className="hidden xl:inline">{description}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="overflow-x-auto">
            <div className="min-w-[1216px]">
              <div className="bg-surface-secondary px-4 py-2.5 border-b border-border grid gap-3 text-xs font-medium text-content-secondary uppercase tracking-wider" style={SCHEDULE_TABLE_COLUMNS}>
                <div>Schedule</div>
                <div>Dashboard</div>
                <div>Frequency</div>
                <div>Dest</div>
                <div>Format</div>
                <div>Status</div>
                <div>Owner</div>
                <div className="text-right">Actions</div>
              </div>

              <div className="max-h-[500px] overflow-y-auto">
                {schedules.length === 0 ? (
                  <div className="flex flex-col items-center justify-center py-12 animate-fadeIn">
                    <img
                      src="/blobby-no-results.png"
                      alt="No schedules found"
                      className="w-16 h-16 object-contain animate-float mb-3"
                      style={{ animationDuration: '3s' }}
                    />
                    <p className="text-sm text-content-secondary">No schedules found.</p>
                  </div>
                ) : (
                  schedules.map((schedule) => {
                    const DestIcon = DESTINATION_ICONS[schedule.destinationType] || Mail;
                    const isPaused = !!schedule.disabledAt;
                    const isSystemDisabled = !!schedule.systemDisabledAt;
                    const rowActionLoading = Boolean(actionLoadingId?.startsWith(schedule.id));
                    const statusLabel = schedule.lastStatus || 'none';

                    return (
                      <div
                        key={schedule.id}
                        className={`px-4 py-2.5 border-b border-border/50 grid gap-3 items-center transition-colors hover:bg-surface-secondary ${isPaused || isSystemDisabled ? 'opacity-70' : ''}`}
                        style={SCHEDULE_TABLE_COLUMNS}
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          {isPaused && <PauseCircle size={14} className="text-yellow-600 flex-shrink-0" />}
                          {isSystemDisabled && <AlertTriangle size={14} className="text-red-500 flex-shrink-0" />}
                          <span className="truncate text-sm font-medium text-content-primary">{schedule.name}</span>
                        </div>
                        <div className="truncate text-xs text-content-secondary">{schedule.dashboardName}</div>
                        <div className="min-w-0 text-xs text-content-secondary" title={schedule.schedule}>
                          <div className="truncate">{cronToReadable(schedule.schedule)}</div>
                          <div className="truncate text-[10px] text-content-secondary/60">{schedule.timezone}</div>
                        </div>
                        <div>
                          <div className="flex items-center gap-1" title={schedule.destinationType}>
                            <DestIcon size={14} className="text-content-secondary" />
                            <span className="text-[10px] text-content-secondary">{schedule.recipientCount >= 0 ? schedule.recipientCount : ''}</span>
                          </div>
                        </div>
                        <div className="truncate text-xs text-content-secondary">{schedule.format}</div>
                        <div className="min-w-0">
                          <StatusChip
                            status={schedule.lastStatus || 'pending'}
                            label={statusLabel}
                            title={`Last delivery status: ${statusLabel}`}
                            className="max-w-full"
                          />
                        </div>
                        <div className="truncate text-xs text-content-secondary" title={schedule.ownerName}>{schedule.ownerName}</div>
                        <div className="flex justify-end gap-1">
                          {rowActionLoading ? (
                            <Loader2 size={14} className="animate-spin text-omni-700" />
                          ) : (
                            <>
                              <ScheduleActionButton
                                label="Edit"
                                description="Change schedule settings."
                                onClick={() => {
                                  setFormSchedule(schedule);
                                  setFormOpen(true);
                                }}
                              >
                                <Edit3 size={13} />
                              </ScheduleActionButton>
                              <ScheduleActionButton
                                label="Send now"
                                description="Trigger one delivery."
                                onClick={() => runScheduleAction(schedule, 'trigger')}
                              >
                                <Send size={13} />
                              </ScheduleActionButton>
                              <ScheduleActionButton
                                label={isPaused ? 'Resume' : 'Pause'}
                                description={isPaused ? 'Restart future runs.' : 'Stop future runs.'}
                                onClick={() => runScheduleAction(schedule, isPaused ? 'resume' : 'pause')}
                              >
                                {isPaused ? <PlayCircle size={13} /> : <PauseCircle size={13} />}
                              </ScheduleActionButton>
                              <ScheduleActionButton
                                label="Delete"
                                description="Remove the schedule."
                                onClick={() => setDeleteTarget(schedule)}
                                tone="danger"
                              >
                                <Trash2 size={13} />
                              </ScheduleActionButton>
                            </>
                          )}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-2 px-4 py-2.5 border-t border-border bg-surface-secondary">
              <button onClick={() => setPage(Math.max(1, page - 1))} disabled={page <= 1} className="btn-secondary text-xs px-3 py-1.5">Previous</button>
              <span className="text-xs text-content-secondary">Page {page} of {totalPages}</span>
              <button onClick={() => setPage(Math.min(totalPages, page + 1))} disabled={page >= totalPages} className="btn-secondary text-xs px-3 py-1.5">Next</button>
            </div>
          )}
        </div>
      )}

      <ScheduleFormModal
        open={formOpen}
        schedule={formSchedule}
        onClose={() => {
          setFormOpen(false);
          setFormSchedule(null);
        }}
        onSave={handleSaveSchedule}
      />

      <ConfirmDialog
        open={!!deleteTarget}
        title="Delete Schedule"
        message={`Delete "${deleteTarget?.name}"? Future deliveries for this schedule will stop.`}
        confirmLabel="Delete Schedule"
        variant="danger"
        onConfirm={() => deleteTarget && runScheduleAction(deleteTarget, 'delete')}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
