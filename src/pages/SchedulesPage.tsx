import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
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
  ShieldCheck,
  Trash2,
  Webhook,
  X,
} from 'lucide-react';
import { useConnection } from '@/hooks/useConnection';
import { useConnectionRequestGuard } from '@/hooks/useConnectionRequestGuard';
import { listDocuments, omniProxy } from '@/services/omniApi';
import { PageHeader } from '@/components/layout/PageHeader';
import { SearchInput } from '@/components/ui/SearchInput';
import { StatusChip } from '@/components/ui/StatusChip';
import { Blobby } from '@/components/ui/Blobby';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { DeliveryOwnershipPanel } from '@/components/admin/DeliveryOwnershipPanel';
import { WorkflowStatusScene } from '@/components/ui/WorkflowStatusScene';
import { selectedBadgeClass, selectedRowClass, unselectedRowClass } from '@/components/ui/selectionStyles';
import { friendlyApiError } from '@/utils/apiErrors';
import {
  classifyCollectionReadFailure,
  CollectionContractError,
  planScheduleMutationRefresh,
  parseScheduleDocumentsCollection,
  parseSchedulesCollection,
} from '@/services/collectionContracts';
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
  { label: 'Evidence', description: 'Review owner, recipients, and offboarding exposure.', icon: ShieldCheck },
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

function formatEvidenceTime(value?: string | null): string {
  if (!value) return 'Time not reported';
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString() : value;
}

function latestDeliveryEvidence(schedule: OmniSchedule): {
  status: 'success' | 'error' | 'warning' | 'pending' | 'info';
  label: string;
  detail: string;
} {
  if (schedule.systemDisabledAt) {
    return {
      status: 'error',
      label: 'System disabled',
      detail: schedule.systemDisabledReason
        ? `${formatEvidenceTime(schedule.systemDisabledAt)} · ${schedule.systemDisabledReason}`
        : formatEvidenceTime(schedule.systemDisabledAt),
    };
  }
  if (schedule.disabledAt) {
    return {
      status: 'warning',
      label: 'Paused',
      detail: `Paused ${formatEvidenceTime(schedule.disabledAt)}`,
    };
  }

  const lastStatus = schedule.lastStatus?.trim();
  const normalized = lastStatus?.toLowerCase() || '';
  if (['error', 'failed', 'failure'].includes(normalized)) {
    return {
      status: 'error',
      label: 'Delivery error',
      detail: `Latest completion ${formatEvidenceTime(schedule.lastCompletedAt)}`,
    };
  }
  if (!schedule.lastCompletedAt && (!normalized || normalized === 'none' || normalized === 'pending')) {
    return {
      status: 'pending',
      label: 'Never observed',
      detail: 'No completed delivery was returned by Omni',
    };
  }
  return {
    status: normalized === 'success' ? 'success' : normalized === 'canceled' ? 'warning' : 'info',
    label: lastStatus || 'Observed',
    detail: `Latest completion ${formatEvidenceTime(schedule.lastCompletedAt)}`,
  };
}

function normalizeDashboardOption(doc: OmniDocument): ScheduleDashboardOption | null {
  const scheduleIdentifier = doc.identifier?.trim() || doc.id.trim();
  if (!scheduleIdentifier) return null;

  return {
    ...doc,
    id: doc.id.trim(),
    displayName: doc.name.trim(),
    documentKind: doc.type?.trim() || 'dashboard',
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
  const dialogRef = useRef<HTMLDivElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);
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
    if (!open) {
      previousFocusRef.current?.focus();
      previousFocusRef.current = null;
      return undefined;
    }

    previousFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const focusTimer = window.setTimeout(() => {
      dialogRef.current?.querySelector<HTMLElement>('#schedule-form-name')?.focus();
    }, 0);
    return () => window.clearTimeout(focusTimer);
  }, [open]);

  useEffect(() => {
    if (!open) return undefined;

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !dialogRef.current) return;

      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>(
        'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
      )];
      if (focusable.length === 0) {
        event.preventDefault();
        dialogRef.current.focus();
        return;
      }

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
        const verified = parseScheduleDocumentsCollection(res);
        const nextDashboards = verified.documents
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
      <div className="absolute inset-0 bg-black/40" aria-hidden="true" onClick={onClose} />
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="schedule-form-title"
        aria-describedby="schedule-form-description"
        className="relative max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-card bg-white p-6 shadow-dropdown mx-4 outline-none"
      >
        <button type="button" onClick={onClose} aria-label="Close schedule editor" className="absolute top-4 right-4 text-content-secondary hover:text-content-primary">
          <X size={18} />
        </button>
        <h3 id="schedule-form-title" className="text-lg font-semibold text-content-primary mb-1">
          {editing ? 'Manage Schedule' : 'Create Schedule'}
        </h3>
        <p id="schedule-form-description" className="text-xs text-content-secondary mb-4">
          Configure the schedule body Omni expects, then save it through the schedule API.
        </p>

        {error && (
          <div role="alert" className="bg-red-50 border border-red-200 text-red-700 text-xs px-3 py-2 rounded mb-3">{error}</div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid md:grid-cols-2 gap-4">
            <div className="md:col-span-2">
              <label htmlFor="schedule-form-name" className="block text-xs font-medium text-content-secondary mb-1">Schedule Name</label>
              <input id="schedule-form-name" value={values.name} onChange={(event) => updateValue('name', event.target.value)} className="input-field" placeholder="Weekly Sales Report" />
            </div>
            <div className="md:col-span-2 rounded-card border border-border bg-white p-3">
              <div className="mb-2 flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
                <div>
                  <label htmlFor="schedule-form-dashboard-search" className="block text-xs font-medium text-content-secondary mb-1">Dashboard or report</label>
                  <p id="schedule-form-dashboard-help" className="text-xs text-content-secondary">Search the cached Omni content list, then select the item this schedule should deliver.</p>
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
                    id="schedule-form-dashboard-search"
                    value={dashboardSearch}
                    onChange={(event) => setDashboardSearch(event.target.value)}
                    aria-describedby="schedule-form-dashboard-help"
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
                <div role="alert" className="mt-2 rounded-button border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                  {dashboardError}
                </div>
              )}
              <div className="mt-2 max-h-56 overflow-y-auto rounded-button border border-border divide-y divide-border/50">
                {loadingDashboards ? (
                  <div className="px-3 py-4 text-sm text-content-secondary">Loading dashboards and reports...</div>
                ) : filteredDashboards.length === 0 ? (
                  <div className="px-3 py-4 text-sm text-content-secondary">
                    {dashboardError
                      ? 'Dashboard inventory is unavailable.'
                      : dashboardsLoaded && dashboards.length === 0
                        ? 'No dashboards or reports were returned from Omni.'
                        : 'No dashboards or reports match that search.'}
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
              <label htmlFor="schedule-form-cron" className="block text-xs font-medium text-content-secondary mb-1">Cron Schedule</label>
              <input id="schedule-form-cron" value={values.schedule} onChange={(event) => updateValue('schedule', event.target.value)} className="input-field font-mono text-xs" placeholder="0 9 ? * MON *" />
            </div>
            <div>
              <label htmlFor="schedule-form-timezone" className="block text-xs font-medium text-content-secondary mb-1">Timezone</label>
              <input id="schedule-form-timezone" value={values.timezone} onChange={(event) => updateValue('timezone', event.target.value)} className="input-field" placeholder="America/New_York" />
            </div>
            <div>
              <label htmlFor="schedule-form-format" className="block text-xs font-medium text-content-secondary mb-1">Format</label>
              <select id="schedule-form-format" value={values.format} onChange={(event) => updateValue('format', event.target.value)} className="input-field">
                <option value="pdf">PDF</option>
                <option value="png">PNG</option>
                <option value="xlsx">XLSX</option>
                <option value="csv">CSV</option>
                <option value="json">JSON</option>
                <option value="link_only">Link only</option>
              </select>
            </div>
            <div>
              <label htmlFor="schedule-form-destination" className="block text-xs font-medium text-content-secondary mb-1">Destination</label>
              <select id="schedule-form-destination" value={values.destinationType} onChange={(event) => updateValue('destinationType', event.target.value)} className="input-field">
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
                <label htmlFor="schedule-form-recipients" className="block text-xs font-medium text-content-secondary mb-1">Recipients</label>
                <input id="schedule-form-recipients" value={values.recipients} onChange={(event) => updateValue('recipients', event.target.value)} className="input-field" placeholder="person@example.com, team@example.com" />
              </div>
              <div>
                <label htmlFor="schedule-form-subject" className="block text-xs font-medium text-content-secondary mb-1">Subject</label>
                <input id="schedule-form-subject" value={values.subject} onChange={(event) => updateValue('subject', event.target.value)} className="input-field" placeholder="Weekly Sales Dashboard" />
              </div>
            </div>
          ) : (
            values.destinationType === 'webhook' ? (
            <div>
              <label htmlFor="schedule-form-webhook-url" className="block text-xs font-medium text-content-secondary mb-1">Webhook URL</label>
              <input id="schedule-form-webhook-url" value={values.url} onChange={(event) => updateValue('url', event.target.value)} className="input-field" placeholder="https://example.com/webhook" />
            </div>
            ) : (
              <div className="rounded-card border border-yellow-200 bg-yellow-50 px-3 py-2 text-xs text-yellow-800">
                Advanced destinations such as Slack, SFTP, and S3 can be paused, resumed, triggered, deleted, or edited for core schedule fields here. Destination-specific credentials should be managed in Omni.
              </div>
            )
          )}

          {!editing && (
            <label htmlFor="schedule-form-test-now" className="flex items-center gap-2 text-xs text-content-secondary">
              <input
                id="schedule-form-test-now"
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
  const { connectionKey } = useConnectionRequestGuard(connection);
  const activeConnectionKeyRef = useRef(connectionKey);
  const [schedules, setSchedules] = useState<OmniSchedule[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [searchDraft, setSearchDraft] = useState('');
  const [appliedSearch, setAppliedSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [destFilter, setDestFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [page, setPage] = useState(1);
  const [pageInfo, setPageInfo] = useState<PageInfo | null>(null);
  const [schedulesLoaded, setSchedulesLoaded] = useState(false);
  const [formSchedule, setFormSchedule] = useState<OmniSchedule | null>(null);
  const [formOpen, setFormOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<OmniSchedule | null>(null);
  const [ownershipTarget, setOwnershipTarget] = useState<OmniSchedule | null>(null);
  const [actionLoadingId, setActionLoadingId] = useState<string | null>(null);
  const requestGenerationRef = useRef(0);
  const paginationEvidenceRef = useRef<{ pageSize: number; totalRecords: number } | null>(null);

  const fetchSchedules = useCallback(async (pageNum: number) => {
    const requestKey = connectionKey;
    const requestGeneration = ++requestGenerationRef.current;
    setLoading(true);
    setSchedulesLoaded(false);
    setError('');
    try {
      if (pageNum === 1) paginationEvidenceRef.current = null;
      const priorPagination = pageNum > 1 ? paginationEvidenceRef.current : null;
      if (pageNum > 1 && !priorPagination) throw new CollectionContractError('Schedule evidence');
      const params: Record<string, string> = { cursor: String(pageNum), pageSize: '25' };
      if (appliedSearch) params.q = appliedSearch;
      if (statusFilter) params.status = statusFilter;
      if (destFilter) params.destination = destFilter;
      if (typeFilter) params.scheduleType = typeFilter;

      const res = await omniProxy<unknown>(
        connection.baseUrl,
        connection.apiKey,
        'GET',
        '/v1/schedules',
        { queryParams: params },
      );
      if (activeConnectionKeyRef.current !== requestKey || requestGenerationRef.current !== requestGeneration) return;
      const verified = parseSchedulesCollection(res, {
        pageNumber: pageNum,
        expectedPageSize: 25,
        expectedTotalRecords: priorPagination?.totalRecords,
      });
      setSchedules(verified.records);
      setPageInfo(verified.pageInfo);
      setSchedulesLoaded(true);
      paginationEvidenceRef.current = {
        pageSize: verified.pageInfo.pageSize,
        totalRecords: verified.pageInfo.totalRecords,
      };
    } catch (err) {
      if (activeConnectionKeyRef.current !== requestKey || requestGenerationRef.current !== requestGeneration) return;
      const failure = classifyCollectionReadFailure(err, 'Schedule evidence');
      setSchedules([]);
      setPageInfo(null);
      setSchedulesLoaded(false);
      paginationEvidenceRef.current = null;
      setError(failure.message);
    } finally {
      if (activeConnectionKeyRef.current === requestKey && requestGenerationRef.current === requestGeneration) setLoading(false);
    }
  }, [appliedSearch, connection.baseUrl, connection.apiKey, connectionKey, destFilter, statusFilter, typeFilter]);

  useLayoutEffect(() => {
    requestGenerationRef.current += 1;
    activeConnectionKeyRef.current = connectionKey;
    setSchedules([]);
    setPageInfo(null);
    setSchedulesLoaded(false);
    setPage(1);
    setFormSchedule(null);
    setFormOpen(false);
    setDeleteTarget(null);
    setOwnershipTarget(null);
    setActionLoadingId(null);
    setError('');
    setLoading(false);
    paginationEvidenceRef.current = null;
  }, [connectionKey]);

  useEffect(() => {
    fetchSchedules(page);
  }, [fetchSchedules, page]);

  async function refreshScheduleInventoryAfterMutation() {
    const refreshPlan = planScheduleMutationRefresh(page);
    requestGenerationRef.current += 1;
    if (refreshPlan.clearPaginationEvidence) paginationEvidenceRef.current = null;
    setSchedules([]);
    setPageInfo(null);
    setSchedulesLoaded(false);
    setError('');
    if (page === refreshPlan.pageNumber) {
      await fetchSchedules(refreshPlan.pageNumber);
    } else {
      setPage(refreshPlan.pageNumber);
    }
  }

  async function handleSaveSchedule(values: ScheduleFormValues) {
    const editing = Boolean(values.id);
    const body = bodyFromValues(values, editing);
    if (editing) {
      await omniProxy(connection.baseUrl, connection.apiKey, 'PUT', `/v1/schedules/${values.id}`, { body });
    } else {
      await omniProxy(connection.baseUrl, connection.apiKey, 'POST', '/v1/schedules', { body });
    }
    await refreshScheduleInventoryAfterMutation();
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
      await refreshScheduleInventoryAfterMutation();
    } catch (err) {
      setError(friendlyApiError(err, `Failed to ${action} schedule`));
    } finally {
      setActionLoadingId(null);
      if (action === 'delete') setDeleteTarget(null);
    }
  }

  function handleSearchSubmit() {
    const nextSearch = searchDraft.trim();
    requestGenerationRef.current += 1;
    paginationEvidenceRef.current = null;
    setSchedules([]);
    setPageInfo(null);
    setSchedulesLoaded(false);
    if (nextSearch === appliedSearch && page === 1) {
      void fetchSchedules(1);
      return;
    }
    setAppliedSearch(nextSearch);
    setPage(1);
  }

  function resetScheduleFilters() {
    requestGenerationRef.current += 1;
    paginationEvidenceRef.current = null;
    setSchedules([]);
    setPageInfo(null);
    setSchedulesLoaded(false);
    setPage(1);
  }

  function changeSchedulePage(nextPage: number) {
    requestGenerationRef.current += 1;
    setSchedules([]);
    setPageInfo(null);
    setSchedulesLoaded(false);
    setError('');
    setLoading(true);
    setPage(nextPage);
  }

  const totalPages = pageInfo ? Math.ceil(pageInfo.totalRecords / pageInfo.pageSize) : 1;
  const scheduleTotal = pageInfo?.totalRecords ?? schedules.length;
  const scheduleTotalLabel = `${scheduleTotal} scheduled ${scheduleTotal === 1 ? 'delivery' : 'deliveries'} found.`;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Schedule Management"
        description={`Configure and manage recurring Omni deliveries, then review the latest delivery evidence returned by Omni.${schedulesLoaded ? ` ${scheduleTotalLabel}` : ''}`}
        icon={<Blobby mood="schedule" size={58} className="animate-float" style={{ animationDuration: '3.6s' }} />}
        actions={
          <button
            type="button"
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
          <div className="text-xs font-medium text-content-secondary uppercase tracking-wider">Delivery evidence</div>
          <div className="mt-2 text-sm font-semibold text-content-primary">Latest observed result</div>
          <p className="mt-1 text-xs text-content-secondary leading-5">Review the latest status and completion time returned by Omni. This does not establish historical reliability.</p>
        </div>
      </div>

      <div className="flex flex-wrap gap-3">
        <div className="flex-1 min-w-[200px]">
          <SearchInput value={searchDraft} onChange={setSearchDraft} placeholder="Search schedules..." />
        </div>
        <select aria-label="Schedule status" value={statusFilter} onChange={(event) => { resetScheduleFilters(); setStatusFilter(event.target.value); }} className="input-field w-auto">
          <option value="">All Statuses</option>
          <option value="success">Success</option>
          <option value="error">Error</option>
          <option value="canceled">Canceled</option>
          <option value="none">None</option>
        </select>
        <select aria-label="Schedule destination" value={destFilter} onChange={(event) => { resetScheduleFilters(); setDestFilter(event.target.value); }} className="input-field w-auto">
          <option value="">All Destinations</option>
          <option value="email">Email</option>
          <option value="slack">Slack</option>
          <option value="webhook">Webhook</option>
          <option value="sftp">SFTP</option>
          <option value="s3">S3</option>
        </select>
        <select aria-label="Schedule type" value={typeFilter} onChange={(event) => { resetScheduleFilters(); setTypeFilter(event.target.value); }} className="input-field w-auto">
          <option value="">All Types</option>
          <option value="schedule">Schedule</option>
          <option value="alert">Alert</option>
        </select>
        <button type="button" onClick={handleSearchSubmit} className="btn-secondary text-sm px-4">Search</button>
      </div>

      {loading ? (
        <WorkflowStatusScene
          variant="bulk-upload"
          title="Loading schedules"
          detail="Pulling schedule definitions, ownership, and latest delivery evidence."
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
                <div>Latest evidence</div>
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
                    <p className="text-sm text-content-secondary">{error ? 'Schedule evidence is unavailable.' : 'No schedules found.'}</p>
                  </div>
                ) : (
                  schedules.map((schedule) => {
                    const DestIcon = DESTINATION_ICONS[schedule.destinationType] || Mail;
                    const isPaused = !!schedule.disabledAt;
                    const isSystemDisabled = !!schedule.systemDisabledAt;
                    const rowActionLoading = Boolean(actionLoadingId?.startsWith(schedule.id));
                    const deliveryEvidence = latestDeliveryEvidence(schedule);

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
                            status={deliveryEvidence.status}
                            label={deliveryEvidence.label}
                            title={`${deliveryEvidence.label}: ${deliveryEvidence.detail}`}
                            className="max-w-full"
                          />
                          <div className="mt-1 truncate text-[10px] text-content-secondary" title={deliveryEvidence.detail}>
                            {deliveryEvidence.detail}
                          </div>
                        </div>
                        <div className="truncate text-xs text-content-secondary" title={schedule.ownerName}>{schedule.ownerName}</div>
                        <div className="flex justify-end gap-1">
                          {rowActionLoading ? (
                            <Loader2 size={14} className="animate-spin text-omni-700" />
                          ) : (
                            <>
                              <ScheduleActionButton
                                label="Evidence"
                                description="Review owner, recipients, and offboarding exposure."
                                onClick={() => setOwnershipTarget(schedule)}
                              >
                                <ShieldCheck size={13} />
                              </ScheduleActionButton>
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
              <button type="button" onClick={() => changeSchedulePage(Math.max(1, page - 1))} disabled={page <= 1} className="btn-secondary text-xs px-3 py-1.5">Previous</button>
              <span className="text-xs text-content-secondary">Page {page} of {totalPages}</span>
              <button type="button" onClick={() => changeSchedulePage(Math.min(totalPages, page + 1))} disabled={page >= totalPages} className="btn-secondary text-xs px-3 py-1.5">Next</button>
            </div>
          )}
          {!schedulesLoaded && Boolean(error) && page > 1 && (
            <div className="flex items-center justify-center px-4 py-2.5 border-t border-border bg-surface-secondary">
              <button type="button" onClick={resetScheduleFilters} className="btn-secondary text-xs px-3 py-1.5">
                Return to first page
              </button>
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

      {ownershipTarget && (
        <DeliveryOwnershipPanel
          instanceId={connection.instanceId}
          scheduleId={ownershipTarget.id}
          scheduleName={ownershipTarget.name}
          onClose={() => setOwnershipTarget(null)}
        />
      )}
    </div>
  );
}
