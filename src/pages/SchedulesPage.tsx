import { useState, useEffect, useCallback } from 'react';
import { Loader2, Mail, Webhook, HardDrive, MessageSquare, Cloud, PauseCircle, AlertTriangle } from 'lucide-react';
import { useConnection } from '@/contexts/ConnectionContext';
import { omniProxy } from '@/services/omniApi';
import { PageHeader } from '@/components/layout/PageHeader';
import { SearchInput } from '@/components/ui/SearchInput';
import { StatusChip } from '@/components/ui/StatusChip';
import type { OmniSchedule, PageInfo } from '@/types';

const DESTINATION_ICONS: Record<string, typeof Mail> = {
  email: Mail,
  webhook: Webhook,
  sftp: HardDrive,
  slack: MessageSquare,
  s3: Cloud,
};


function cronToReadable(cron: string): string {
  const parts = cron.split(' ');
  if (parts.length < 5) return cron;
  const [min, hour, dayOfMonth, month, dayOfWeek] = parts;
  if (dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    if (hour === '*') return `Every hour at :${min.padStart(2, '0')}`;
    return `Daily at ${hour}:${min.padStart(2, '0')}`;
  }
  if (dayOfWeek !== '*' && dayOfMonth === '*') return `Weekly (${dayOfWeek}) at ${hour}:${min.padStart(2, '0')}`;
  return cron;
}

export function SchedulesPage() {
  const { connection } = useConnection();
  const [schedules, setSchedules] = useState<OmniSchedule[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [destFilter, setDestFilter] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [page, setPage] = useState(1);
  const [pageInfo, setPageInfo] = useState<PageInfo | null>(null);

  const fetchSchedules = useCallback(async (pageNum: number) => {
    setLoading(true);
    setError('');
    try {
      const params: Record<string, string> = { cursor: String(pageNum), pageSize: '25' };
      if (search) params.q = search;
      if (statusFilter) params.status = statusFilter;
      if (destFilter) params.destination = destFilter;
      if (typeFilter) params.scheduleType = typeFilter;

      const res = await omniProxy<{ records?: OmniSchedule[]; pageInfo?: PageInfo }>(
        connection.baseUrl, connection.apiKey, 'GET', '/v1/schedules',
        { queryParams: params }
      );
      setSchedules(res.records || []);
      setPageInfo(res.pageInfo || null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load schedules');
    } finally {
      setLoading(false);
    }
  }, [connection.baseUrl, connection.apiKey, search, statusFilter, destFilter, typeFilter]);

  useEffect(() => {
    fetchSchedules(page);
  }, [fetchSchedules, page]);

  function handleSearchSubmit() {
    setPage(1);
    fetchSchedules(1);
  }

  const totalPages = pageInfo ? Math.ceil(pageInfo.totalRecords / pageInfo.pageSize) : 1;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Schedules"
        description={`${pageInfo?.totalRecords ?? schedules.length} scheduled deliveries in your organization.`}
        icon={
          <img
            src="/blobby-schedule.webp"
            alt="Blobby with clock"
            className="w-10 h-10 object-contain animate-float"
            style={{ animationDuration: '3.5s' }}
          />
        }
      />

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-card">{error}</div>
      )}

      <div className="flex flex-wrap gap-3">
        <div className="flex-1 min-w-[200px]">
          <SearchInput
            value={search}
            onChange={setSearch}
            placeholder="Search schedules..."
          />
        </div>
        <select value={statusFilter} onChange={(e) => { setStatusFilter(e.target.value); setPage(1); }} className="input-field w-auto">
          <option value="">All Statuses</option>
          <option value="success">Success</option>
          <option value="error">Error</option>
          <option value="canceled">Canceled</option>
          <option value="none">None</option>
        </select>
        <select value={destFilter} onChange={(e) => { setDestFilter(e.target.value); setPage(1); }} className="input-field w-auto">
          <option value="">All Destinations</option>
          <option value="email">Email</option>
          <option value="slack">Slack</option>
          <option value="webhook">Webhook</option>
          <option value="sftp">SFTP</option>
          <option value="s3">S3</option>
        </select>
        <select value={typeFilter} onChange={(e) => { setTypeFilter(e.target.value); setPage(1); }} className="input-field w-auto">
          <option value="">All Types</option>
          <option value="schedule">Schedule</option>
          <option value="alert">Alert</option>
        </select>
        <button onClick={handleSearchSubmit} className="btn-secondary text-sm px-4">Search</button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 size={24} className="text-omni-500 animate-spin" />
        </div>
      ) : (
        <div className="card p-0 overflow-hidden">
          <div className="bg-surface-secondary px-4 py-2.5 border-b border-border grid grid-cols-12 gap-2 text-xs font-medium text-content-secondary uppercase tracking-wider">
            <div className="col-span-3">Schedule</div>
            <div className="col-span-2">Dashboard</div>
            <div className="col-span-2">Frequency</div>
            <div className="col-span-1">Dest</div>
            <div className="col-span-1">Format</div>
            <div className="col-span-1">Status</div>
            <div className="col-span-2">Owner</div>
          </div>

          <div className="max-h-[500px] overflow-y-auto">
            {schedules.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 animate-fadeIn">
                <img
                  src="/blobby-no-results.webp"
                  alt="No schedules found"
                  className="w-16 h-16 object-contain animate-float mb-3"
                  style={{ animationDuration: '3s' }}
                />
                <p className="text-sm text-content-secondary">No schedules found.</p>
              </div>
            ) : (
              schedules.map((sched) => {
                const DestIcon = DESTINATION_ICONS[sched.destinationType] || Mail;
                const isPaused = !!sched.disabledAt;
                const isSystemDisabled = !!sched.systemDisabledAt;


                return (
                  <div
                    key={sched.id}
                    className={`px-4 py-2.5 border-b border-border/50 grid grid-cols-12 gap-2 items-center transition-colors hover:bg-surface-secondary ${isPaused || isSystemDisabled ? 'opacity-60' : ''}`}
                  >
                    <div className="col-span-3 flex items-center gap-2 min-w-0">
                      {isPaused && <PauseCircle size={14} className="text-yellow-600 flex-shrink-0" />}
                      {isSystemDisabled && <AlertTriangle size={14} className="text-red-500 flex-shrink-0" />}
                      <span className="text-sm text-content-primary truncate font-medium">{sched.name}</span>
                    </div>
                    <div className="col-span-2 text-xs text-content-secondary truncate">{sched.dashboardName}</div>
                    <div className="col-span-2 text-xs text-content-secondary" title={sched.schedule}>
                      <div className="truncate">{cronToReadable(sched.schedule)}</div>
                      <div className="text-[10px] text-content-secondary/60">{sched.timezone}</div>
                    </div>
                    <div className="col-span-1">
                      <div className="flex items-center gap-1" title={sched.destinationType}>
                        <DestIcon size={14} className="text-content-secondary" />
                        <span className="text-[10px] text-content-secondary">{sched.recipientCount >= 0 ? sched.recipientCount : ''}</span>
                      </div>
                    </div>
                    <div className="col-span-1 text-xs text-content-secondary">{sched.format}</div>
                    <div className="col-span-1">
                      <StatusChip status={sched.lastStatus || 'pending'} label={sched.lastStatus || 'none'} />
                    </div>
                    <div className="col-span-2 text-xs text-content-secondary truncate">{sched.ownerName}</div>
                  </div>
                );
              })
            )}
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
    </div>
  );
}
