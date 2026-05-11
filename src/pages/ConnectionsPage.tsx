import { useState, useEffect } from 'react';
import { Loader2, Database, RefreshCw, GitBranch, Clock } from 'lucide-react';
import { useConnection } from '@/contexts/ConnectionContext';
import { omniProxy } from '@/services/omniApi';
import { PageHeader } from '@/components/layout/PageHeader';
import { SearchInput } from '@/components/ui/SearchInput';
import type { OmniConnection } from '@/types';

const DIALECT_COLORS: Record<string, string> = {
  bigquery: 'bg-blue-100 text-blue-800',
  snowflake: 'bg-cyan-100 text-cyan-800',
  redshift: 'bg-red-100 text-red-800',
  postgres: 'bg-sky-100 text-sky-800',
  mysql: 'bg-orange-100 text-orange-800',
  databricks: 'bg-rose-100 text-rose-800',
  trino: 'bg-sky-100 text-sky-800',
  clickhouse: 'bg-yellow-100 text-yellow-800',
  duckdb: 'bg-amber-100 text-amber-800',
  motherduck: 'bg-amber-100 text-amber-800',
};

interface ConnectionDetail {
  dbt?: Record<string, unknown> | null;
  schedules?: Array<Record<string, unknown>>;
  loadingDetail?: boolean;
}

export function ConnectionsPage() {
  const { connection } = useConnection();
  const [connections, setConnections] = useState<OmniConnection[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [dialectFilter, setDialectFilter] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'dbt' | 'schedules'>('dbt');
  const [details, setDetails] = useState<Record<string, ConnectionDetail>>({});

  useEffect(() => {
    async function load() {
      setLoading(true);
      setError('');
      try {
        const res = await omniProxy<{ records?: OmniConnection[]; connections?: OmniConnection[] }>(
          connection.baseUrl, connection.apiKey, 'GET', '/v1/connections'
        );
        const data = res.records || res.connections || [];
        setConnections(Array.isArray(data) ? data : []);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load connections');
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [connection.baseUrl, connection.apiKey]);

  async function loadDetail(connId: string) {
    if (details[connId] && !details[connId].loadingDetail) return;
    setDetails((prev) => ({ ...prev, [connId]: { ...prev[connId], loadingDetail: true } }));

    try {
      const [dbtRes, schedRes] = await Promise.allSettled([
        omniProxy<Record<string, unknown>>(connection.baseUrl, connection.apiKey, 'GET', `/v1/connections/${connId}/dbt`),
        omniProxy<{ records?: Array<Record<string, unknown>> }>(connection.baseUrl, connection.apiKey, 'GET', `/v1/connections/${connId}/schedules`),
      ]);

      setDetails((prev) => ({
        ...prev,
        [connId]: {
          dbt: dbtRes.status === 'fulfilled' ? dbtRes.value : null,
          schedules: schedRes.status === 'fulfilled' ? (schedRes.value.records || []) : [],
          loadingDetail: false,
        },
      }));
    } catch {
      setDetails((prev) => ({ ...prev, [connId]: { dbt: null, schedules: [], loadingDetail: false } }));
    }
  }

  function toggleExpand(id: string) {
    if (expandedId === id) {
      setExpandedId(null);
    } else {
      setExpandedId(id);
      loadDetail(id);
    }
  }

  const dialects = [...new Set(connections.map((c) => c.dialect).filter(Boolean))].sort();

  const filtered = connections.filter((c) => {
    const matchSearch = !search || c.name?.toLowerCase().includes(search.toLowerCase()) || c.database?.toLowerCase().includes(search.toLowerCase());
    const matchDialect = !dialectFilter || c.dialect === dialectFilter;
    return matchSearch && matchDialect;
  });

  function cronToHuman(cron: string): string {
    const parts = cron.split(' ');
    if (parts.length < 5) return cron;
    const [min, hour] = parts;
    if (min === '0' && hour !== '*') return `Daily at ${hour}:00 UTC`;
    return cron;
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Connections"
        description={`${connections.length} database connections in your Omni instance.`}
        icon={
          <img
            src="/blobby-connections.webp"
            alt="Blobby with satellite"
            className="w-10 h-10 object-contain animate-float"
            style={{ animationDuration: '3s' }}
          />
        }
      />

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-card">{error}</div>
      )}

      <div className="flex gap-3">
        <div className="flex-1">
          <SearchInput value={search} onChange={setSearch} placeholder="Search connections..." />
        </div>
        <select value={dialectFilter} onChange={(e) => setDialectFilter(e.target.value)} className="input-field w-auto">
          <option value="">All Dialects</option>
          {dialects.map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 size={24} className="text-omni-500 animate-spin" />
        </div>
      ) : (
        <div className="card p-0 overflow-hidden">
          <div className="bg-surface-secondary px-4 py-2.5 border-b border-border grid grid-cols-12 gap-2">
            <div className="col-span-1 text-xs font-medium text-content-secondary uppercase tracking-wider" />
            <div className="col-span-3 text-xs font-medium text-content-secondary uppercase tracking-wider">Name</div>
            <div className="col-span-2 text-xs font-medium text-content-secondary uppercase tracking-wider">Dialect</div>
            <div className="col-span-3 text-xs font-medium text-content-secondary uppercase tracking-wider">Database</div>
            <div className="col-span-3 text-xs font-medium text-content-secondary uppercase tracking-wider">Default Schema</div>
          </div>

          <div className="max-h-[500px] overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 animate-fadeIn">
                <img
                  src="/blobby-no-results.webp"
                  alt="No connections found"
                  className="w-16 h-16 object-contain animate-float mb-3"
                  style={{ animationDuration: '3s' }}
                />
                <p className="text-sm text-content-secondary">No connections found.</p>
              </div>
            ) : (
              filtered.map((conn) => {
                const isExpanded = expandedId === conn.id;
                const detail = details[conn.id];
                const dialectClass = DIALECT_COLORS[conn.dialect?.toLowerCase()] || 'bg-gray-100 text-gray-800';

                return (
                  <div key={conn.id}>
                    <div
                      className="px-4 py-3 border-b border-border/50 grid grid-cols-12 gap-2 items-center hover:bg-surface-secondary transition-colors cursor-pointer"
                      onClick={() => toggleExpand(conn.id)}
                    >
                      <div className="col-span-1">
                        <Database size={16} className="text-content-secondary" />
                      </div>
                      <div className="col-span-3 text-sm text-content-primary font-medium truncate">{conn.name}</div>
                      <div className="col-span-2">
                        <span className={`text-xs font-medium px-2 py-0.5 rounded-chip ${dialectClass}`}>
                          {conn.dialect}
                        </span>
                      </div>
                      <div className="col-span-3 text-sm text-content-secondary truncate">{conn.database || '-'}</div>
                      <div className="col-span-3 text-sm text-content-secondary truncate font-mono text-xs">{conn.defaultSchema || '-'}</div>
                    </div>

                    {isExpanded && (
                      <div className="px-4 py-4 bg-surface-secondary border-b border-border/50 animate-fadeIn">
                        <div className="text-xs text-content-secondary mb-1">
                          <span className="font-medium text-content-primary">ID:</span>{' '}
                          <span className="font-mono">{conn.id}</span>
                        </div>
                        {conn.baseRole && (
                          <div className="text-xs text-content-secondary mb-3">
                            <span className="font-medium text-content-primary">Base Role:</span> {conn.baseRole}
                          </div>
                        )}

                        <div className="flex gap-1 mb-3">
                          <button
                            onClick={(e) => { e.stopPropagation(); setActiveTab('dbt'); }}
                            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-button text-xs font-medium transition-colors ${activeTab === 'dbt' ? 'bg-omni-700 text-white' : 'text-content-secondary hover:bg-white'}`}
                          >
                            <GitBranch size={12} />
                            dbt
                          </button>
                          <button
                            onClick={(e) => { e.stopPropagation(); setActiveTab('schedules'); }}
                            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-button text-xs font-medium transition-colors ${activeTab === 'schedules' ? 'bg-omni-700 text-white' : 'text-content-secondary hover:bg-white'}`}
                          >
                            <Clock size={12} />
                            Schema Refresh
                          </button>
                        </div>

                        {detail?.loadingDetail ? (
                          <div className="flex items-center gap-2 py-4 text-content-secondary text-xs">
                            <Loader2 size={14} className="animate-spin" /> Loading details...
                          </div>
                        ) : activeTab === 'dbt' ? (
                          detail?.dbt ? (
                            <div className="grid grid-cols-2 gap-2 text-xs">
                              {Object.entries(detail.dbt).map(([key, val]) => (
                                <div key={key}>
                                  <span className="font-medium text-content-primary">{key}:</span>{' '}
                                  <span className="text-content-secondary font-mono">{typeof val === 'boolean' ? (val ? 'Yes' : 'No') : String(val ?? '-')}</span>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <p className="text-xs text-content-secondary py-2">dbt not configured for this connection.</p>
                          )
                        ) : (
                          detail?.schedules && detail.schedules.length > 0 ? (
                            <div className="space-y-2">
                              {detail.schedules.map((sched, i) => (
                                <div key={i} className="flex items-center gap-3 bg-white rounded-button px-3 py-2 text-xs">
                                  <RefreshCw size={12} className="text-omni-700 flex-shrink-0" />
                                  <span className="font-medium text-content-primary">{cronToHuman(String(sched.schedule || ''))}</span>
                                  <span className="text-content-secondary">{String(sched.timezone || '')}</span>
                                  <span className={`ml-auto px-2 py-0.5 rounded-chip text-[10px] font-medium ${sched.enabled !== false ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-600'}`}>
                                    {sched.enabled !== false ? 'Active' : 'Paused'}
                                  </span>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <p className="text-xs text-content-secondary py-2">No schema refresh schedules configured.</p>
                          )
                        )}
                      </div>
                    )}
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
