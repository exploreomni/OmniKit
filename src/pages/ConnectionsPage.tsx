import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { ArrowRight, AlertTriangle, CheckCircle2, Database, RefreshCw, GitBranch, Clock, Loader2 } from 'lucide-react';
import { useConnection } from '@/contexts/ConnectionContext';
import { listModels, omniProxy } from '@/services/omniApi';
import { PageHeader } from '@/components/layout/PageHeader';
import { SearchInput } from '@/components/ui/SearchInput';
import { Blobby } from '@/components/ui/Blobby';
import { getConnectionCacheKey } from '@/services/connectionGuards';
import type { OmniConnection, OmniModel } from '@/types';

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
  const navigate = useNavigate();
  const connectionKey = getConnectionCacheKey(connection);
  const activeConnectionKeyRef = useRef(connectionKey);
  const [connections, setConnections] = useState<OmniConnection[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [dialectFilter, setDialectFilter] = useState('');
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<'dbt' | 'schedules'>('dbt');
  const [details, setDetails] = useState<Record<string, ConnectionDetail>>({});
  const [schemaModels, setSchemaModels] = useState<OmniModel[]>([]);
  const [schemaModelError, setSchemaModelError] = useState('');

  useEffect(() => {
    activeConnectionKeyRef.current = connectionKey;
  }, [connectionKey]);

  useEffect(() => {
    async function load() {
      const requestKey = connectionKey;
      setLoading(true);
      setError('');
      setSchemaModelError('');
      try {
        const [connectionRes, schemaRes] = await Promise.allSettled([
          omniProxy<{ records?: OmniConnection[]; connections?: OmniConnection[] }>(
            connection.baseUrl, connection.apiKey, 'GET', '/v1/connections'
          ),
          listModels(connection.baseUrl, connection.apiKey, {
            modelKind: 'SCHEMA',
            allPages: true,
            pageSize: 100,
            sortField: 'updatedAt',
            sortDirection: 'desc',
          }),
        ]);

        if (connectionRes.status === 'rejected') {
          throw connectionRes.reason;
        }
        if (activeConnectionKeyRef.current !== requestKey) return;

        const data = connectionRes.value.records || connectionRes.value.connections || [];
        setConnections(Array.isArray(data) ? data : []);

        if (schemaRes.status === 'fulfilled' && !schemaRes.value.error) {
          setSchemaModels(Array.isArray(schemaRes.value.models) ? schemaRes.value.models : []);
        } else {
          const message = schemaRes.status === 'rejected'
            ? schemaRes.reason instanceof Error ? schemaRes.reason.message : 'Failed to load schema models'
            : schemaRes.value.error || 'Failed to load schema models';
          setSchemaModels([]);
          setSchemaModelError(message);
        }
      } catch (err) {
        if (activeConnectionKeyRef.current !== requestKey) return;
        setError(err instanceof Error ? err.message : 'Failed to load connections');
      } finally {
        if (activeConnectionKeyRef.current === requestKey) setLoading(false);
      }
    }
    load();
  }, [connection.baseUrl, connection.apiKey, connectionKey]);

  async function loadDetail(connId: string) {
    if (details[connId] && !details[connId].loadingDetail) return;
    const requestKey = connectionKey;
    setDetails((prev) => ({ ...prev, [connId]: { ...prev[connId], loadingDetail: true } }));

    try {
      const [dbtRes, schedRes] = await Promise.allSettled([
        omniProxy<Record<string, unknown>>(connection.baseUrl, connection.apiKey, 'GET', `/v1/connections/${connId}/dbt`),
        omniProxy<{ records?: Array<Record<string, unknown>> }>(connection.baseUrl, connection.apiKey, 'GET', `/v1/connections/${connId}/schedules`),
      ]);

      if (activeConnectionKeyRef.current !== requestKey) return;
      setDetails((prev) => ({
        ...prev,
        [connId]: {
          dbt: dbtRes.status === 'fulfilled' ? dbtRes.value : null,
          schedules: schedRes.status === 'fulfilled' ? (schedRes.value.records || []) : [],
          loadingDetail: false,
        },
      }));
    } catch {
      if (activeConnectionKeyRef.current !== requestKey) return;
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
  const activeConnections = connections.filter((c) => !c.deletedAt);
  const schemaModelByConnectionId = new Map(
    schemaModels
      .filter((model) => !model.deletedAt && model.connectionId)
      .map((model) => [model.connectionId!, model])
  );
  const schemaModelCoverageCount = activeConnections.filter((c) => schemaModelByConnectionId.has(c.id)).length;
  const latestSchemaModelUpdate = schemaModels
    .filter((model) => !model.deletedAt && model.updatedAt)
    .map((model) => Date.parse(model.updatedAt!))
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => b - a)[0];
  const dbtConfigured = Object.values(details).filter((detail) => detail.dbt && Object.keys(detail.dbt).length > 0).length;
  const scheduleConfigured = Object.values(details).filter((detail) => (detail.schedules || []).length > 0).length;
  const inspectedConnections = Object.values(details).filter((detail) => !detail.loadingDetail).length;
  const missingSchemaCount = schemaModelError ? 0 : activeConnections.length - schemaModelCoverageCount;
  const detailReviewCount = Object.values(details).filter((detail) => {
    if (detail.loadingDetail) return false;
    const missingDbt = !detail.dbt || Object.keys(detail.dbt).length === 0;
    const missingSchedule = (detail.schedules || []).length === 0;
    return missingDbt || missingSchedule;
  }).length;
  const reviewQueueCount = missingSchemaCount + detailReviewCount;

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

  function connectionValue(conn: OmniConnection, ...keys: string[]): string {
    const record = conn as unknown as Record<string, unknown>;
    for (const key of keys) {
      const value = record[key];
      if (typeof value === 'string' && value.trim()) return value;
    }
    return '';
  }

  function healthForConnection(conn: OmniConnection, detail?: ConnectionDetail, schemaModel?: OmniModel) {
    if (conn.deletedAt) {
      return { label: 'Inactive', className: 'bg-gray-100 text-gray-600', detail: 'Deleted or inactive' };
    }
    if (schemaModelError) {
      return { label: 'Schema check unavailable', className: 'bg-surface-secondary text-content-secondary', detail: 'Could not load schema models' };
    }
    if (!schemaModel) {
      return { label: 'Needs schema model', className: 'bg-yellow-100 text-yellow-800', detail: 'No schema model found for this connection' };
    }
    if (!detail) {
      return { label: 'Not inspected', className: 'bg-surface-secondary text-content-secondary', detail: 'Expand for dbt and refresh' };
    }
    if (detail.loadingDetail) {
      return { label: 'Inspecting', className: 'bg-omni-50 text-omni-700', detail: 'Loading details' };
    }

    const missingDbt = !detail.dbt || Object.keys(detail.dbt).length === 0;
    const missingSchedule = (detail.schedules || []).length === 0;
    if (missingDbt && missingSchedule) {
      return { label: 'Review', className: 'bg-yellow-100 text-yellow-800', detail: 'No dbt config or refresh schedule' };
    }
    if (missingSchedule) {
      return { label: 'No refresh', className: 'bg-yellow-100 text-yellow-800', detail: 'No schema refresh schedule' };
    }
    if (missingDbt) {
      return { label: 'No dbt', className: 'bg-blue-100 text-blue-800', detail: 'Optional, not configured' };
    }
    return { label: 'Ready', className: 'bg-green-100 text-green-800', detail: 'dbt and refresh metadata found' };
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Connection Health"
        description="Review connection inventory, warehouse dialects, dbt configuration, schema model coverage, refresh schedules, and environment readiness."
        icon={<Blobby mood="connections" size={58} className="animate-float" style={{ animationDuration: '3.6s' }} />}
      />

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-card">{error}</div>
      )}

      <div className="grid grid-cols-2 xl:grid-cols-6 gap-3">
        <div className="card p-4">
          <div className="text-xs font-medium text-content-secondary uppercase tracking-wider">Active Connections</div>
          <div className="mt-2 text-2xl font-semibold text-content-primary">{activeConnections.length}</div>
          <div className="mt-1 text-xs text-content-secondary">{connections.length - activeConnections.length} deleted or inactive</div>
        </div>
        <div className="card p-4">
          <div className="text-xs font-medium text-content-secondary uppercase tracking-wider">Dialects</div>
          <div className="mt-2 text-2xl font-semibold text-content-primary">{dialects.length}</div>
          <div className="mt-1 text-xs text-content-secondary">Warehouse platforms represented</div>
        </div>
        <div className="card p-4">
          <div className="text-xs font-medium text-content-secondary uppercase tracking-wider">Schema Models</div>
          <div className="mt-2 text-2xl font-semibold text-content-primary">
            {schemaModelError ? '-' : `${schemaModelCoverageCount}/${activeConnections.length}`}
          </div>
          <div className="mt-1 text-xs text-content-secondary">
            {schemaModelError
              ? 'Coverage check unavailable'
              : latestSchemaModelUpdate
                ? `Latest update ${new Date(latestSchemaModelUpdate).toLocaleDateString()}`
                : 'Connection coverage'}
          </div>
        </div>
        <div className="card p-4">
          <div className="text-xs font-medium text-content-secondary uppercase tracking-wider">dbt Checked</div>
          <div className="mt-2 text-2xl font-semibold text-content-primary">{dbtConfigured}</div>
          <div className="mt-1 text-xs text-content-secondary">{inspectedConnections} inspected</div>
        </div>
        <div className="card p-4">
          <div className="text-xs font-medium text-content-secondary uppercase tracking-wider">Refresh Schedules</div>
          <div className="mt-2 text-2xl font-semibold text-content-primary">{scheduleConfigured}</div>
          <div className="mt-1 text-xs text-content-secondary">Expand rows to inspect cadence</div>
        </div>
        <div className="card p-4">
          <div className="text-xs font-medium text-content-secondary uppercase tracking-wider">Review Queue</div>
          <div className="mt-2 text-2xl font-semibold text-content-primary">{reviewQueueCount}</div>
          <div className="mt-1 text-xs text-content-secondary">Schema model, dbt, or refresh signals</div>
        </div>
      </div>

      <div className="card p-4">
        <div className="grid gap-4 lg:grid-cols-[1fr_auto] lg:items-center">
          <div>
            <div className="flex items-center gap-2 text-sm font-semibold text-content-primary">
              {reviewQueueCount > 0 ? <AlertTriangle size={16} className="text-yellow-600" /> : <CheckCircle2 size={16} className="text-green-600" />}
              Connection governance pre-flight
            </div>
            <div className="mt-1 text-sm text-content-secondary">
              Confirm source readiness here first, then scan model settings, relationships, views, and topics for the semantic impact of that connection.
            </div>
          </div>
          <button onClick={() => navigate('/models')} className="btn-secondary text-sm inline-flex items-center gap-2 justify-center">
            Open Model & Topic Health
            <ArrowRight size={14} />
          </button>
        </div>
      </div>

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
          <div className="px-4 py-3 border-b border-border bg-white">
            <div className="text-sm font-semibold text-content-primary">Connection readiness inventory</div>
            <div className="text-xs text-content-secondary mt-0.5">Use this as a pre-flight check before model, topic, upload, and content workflows.</div>
          </div>
          <div className="bg-surface-secondary px-4 py-2.5 border-b border-border grid grid-cols-12 gap-2">
            <div className="col-span-1 text-xs font-medium text-content-secondary uppercase tracking-wider" />
            <div className="col-span-3 text-xs font-medium text-content-secondary uppercase tracking-wider">Name</div>
            <div className="col-span-2 text-xs font-medium text-content-secondary uppercase tracking-wider">Dialect</div>
            <div className="col-span-2 text-xs font-medium text-content-secondary uppercase tracking-wider">Database</div>
            <div className="col-span-2 text-xs font-medium text-content-secondary uppercase tracking-wider">Default Schema</div>
            <div className="col-span-2 text-xs font-medium text-content-secondary uppercase tracking-wider">Health</div>
          </div>

          <div className="max-h-[500px] overflow-y-auto">
            {filtered.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 animate-fadeIn">
                <img
                  src="/blobby-no-results.png"
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
                const schemaModel = schemaModelByConnectionId.get(conn.id);
                const defaultSchema = connectionValue(conn, 'defaultSchema', 'default_schema', 'default_schema_name', 'schema');
                const health = healthForConnection(conn, detail, schemaModel);

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
                      <div className="col-span-2 text-sm text-content-secondary truncate">{conn.database || '-'}</div>
                      <div className="col-span-2 text-sm text-content-secondary truncate font-mono text-xs">{defaultSchema || '-'}</div>
                      <div className="col-span-2 min-w-0">
                        <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-chip ${health.className}`}>{health.label}</span>
                        <div className="mt-1 text-[10px] text-content-tertiary truncate">{health.detail}</div>
                      </div>
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
                        <div className="text-xs text-content-secondary mb-3">
                          <span className="font-medium text-content-primary">Schema model:</span>{' '}
                          {schemaModel ? (
                            <>
                              <span className="font-mono">{schemaModel.id}</span>
                              {schemaModel.updatedAt && <span> · updated {new Date(schemaModel.updatedAt).toLocaleString()}</span>}
                            </>
                          ) : schemaModelError ? (
                            <span title={schemaModelError}>Check unavailable</span>
                          ) : (
                            <span className="text-yellow-700">None found for this connection</span>
                          )}
                        </div>

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
