import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Download, FileSearch, Radar, RefreshCw, ShieldCheck } from 'lucide-react';

import { PageHeader } from '@/components/layout/PageHeader';
import { StatusChip } from '@/components/ui/StatusChip';
import { useConnection } from '@/hooks/useConnection';
import { getConnectionCacheKey } from '@/services/connectionGuards';
import {
  fetchOmniApiContractRadar,
  type OmniApiContractRadarReport,
} from '@/services/omniApiContractRadar';

function downloadReport(report: OmniApiContractRadarReport): void {
  const blob = new Blob([`${JSON.stringify(report, null, 2)}\n`], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `omnikit-api-contract-${report.instanceId}-${report.checkedAt.slice(0, 10)}.json`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function categoryLabel(value: string): string {
  return value.replace(/_/g, ' ').replace(/\b\w/g, (character) => character.toUpperCase());
}

export function ApiContractRadarPage() {
  const { connection } = useConnection();
  const connectionKey = getConnectionCacheKey(connection);
  const [report, setReport] = useState<OmniApiContractRadarReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [operationFilter, setOperationFilter] = useState('');
  const requestRef = useRef(0);
  const activeConnectionKeyRef = useRef(connectionKey);

  useLayoutEffect(() => {
    activeConnectionKeyRef.current = connectionKey;
    requestRef.current += 1;
    setReport(null);
    setError('');
    setOperationFilter('');
    setLoading(false);
  }, [connectionKey]);

  async function runContractCheck(): Promise<void> {
    if (!connection.instanceId) {
      setError('Select a saved Omni instance before checking its tenant contract.');
      return;
    }
    let expectedTenantOrigin: string;
    try {
      expectedTenantOrigin = new URL(connection.baseUrl.trim()).origin;
    } catch {
      setError('The selected saved Omni instance does not have a valid tenant origin.');
      return;
    }
    const requestConnectionKey = connectionKey;
    const request = ++requestRef.current;
    setLoading(true);
    setError('');
    try {
      const next = await fetchOmniApiContractRadar(connection.instanceId);
      if (request !== requestRef.current || activeConnectionKeyRef.current !== requestConnectionKey) return;
      if (next.tenantOrigin !== expectedTenantOrigin) {
        throw new Error('Contract Radar returned evidence for a different tenant origin.');
      }
      setReport(next);
    } catch (checkError) {
      if (request !== requestRef.current || activeConnectionKeyRef.current !== requestConnectionKey) return;
      setReport(null);
      setError(checkError instanceof Error ? checkError.message : 'The tenant API contract could not be checked.');
    } finally {
      if (request === requestRef.current && activeConnectionKeyRef.current === requestConnectionKey) setLoading(false);
    }
  }

  const filteredOperations = useMemo(() => {
    if (!report) return [];
    const query = operationFilter.trim().toLowerCase();
    const operations = query
      ? report.operations.filter((operation) => `${operation.method} ${operation.path} ${operation.registry?.id || ''}`.toLowerCase().includes(query))
      : report.operations;
    return operations.slice(0, 150);
  }, [operationFilter, report]);

  return (
    <div className="space-y-5">
      <PageHeader
        title="API Contract Radar"
        description="Compare OmniKit’s registry with the selected tenant’s public OpenAPI contract. Discovery is read-only: OmniKit fingerprints operations and schemas but never executes an operation from the specification."
        icon={<Radar size={46} className="text-omni-700" />}
        actions={(
          <>
            <button type="button" className="btn-primary text-sm" onClick={() => void runContractCheck()} disabled={loading || !connection.instanceId}>
              <RefreshCw size={14} className={loading ? 'animate-spin' : ''} />
              {report ? 'Check again' : 'Check tenant contract'}
            </button>
            <button type="button" className="btn-secondary text-sm" onClick={() => report && downloadReport(report)} disabled={!report}>
              <Download size={14} /> Export evidence
            </button>
          </>
        )}
      />

      <div className="grid gap-3 md:grid-cols-3">
        <div className="card p-4">
          <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-content-secondary"><ShieldCheck size={14} /> Discovery posture</div>
          <div className="mt-2 text-sm font-semibold text-content-primary">Public contract, read only</div>
          <p className="mt-1 text-xs leading-5 text-content-secondary">No API key is sent to <code>/openapi.json</code>; redirects and external references are not followed.</p>
        </div>
        <div className="card p-4">
          <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-content-secondary"><FileSearch size={14} /> Selected tenant</div>
          <div className="mt-2 truncate text-sm font-semibold text-content-primary">{connection.instanceLabel || connection.instanceId || 'No saved instance selected'}</div>
          <p className="mt-1 truncate text-xs text-content-secondary">{report?.tenantOrigin || 'Changing any selected connection detail clears the prior report.'}</p>
        </div>
        <div className="card p-4">
          <div className="text-xs font-medium uppercase tracking-wider text-content-secondary">Baseline</div>
          <div className="mt-2 text-sm font-semibold text-content-primary">{report ? report.baseline.available ? 'Compared with prior check' : 'Baseline captured' : 'Not checked'}</div>
          <p className="mt-1 text-xs text-content-secondary">Baselines are memory-only and credential-independent.</p>
        </div>
      </div>

      {error && <div className="rounded-card border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

      {loading && !report && <div className="card p-8 text-center text-sm text-content-secondary">Reading and fingerprinting the bounded tenant OpenAPI document…</div>}

      {report && (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {[
              ['Tenant operations', report.summary.tenantOperations],
              ['Matched', report.summary.matchedOperations],
              ['Tenant only', report.summary.tenantOnly],
              ['Registry only', report.summary.registryOnly],
              ['Method mismatches', report.summary.methodMismatches],
              ['Schema changes', report.summary.schemaChanges],
              ['Classification review', report.summary.classificationMismatches],
              ['External refs excluded', report.externalReferenceCount],
              ['Unresolved local refs', report.unresolvedLocalReferenceCount],
            ].map(([label, value]) => (
              <div key={String(label)} className="card p-4">
                <div className="text-[11px] font-medium uppercase tracking-wider text-content-secondary">{label}</div>
                <div className="mt-2 text-xl font-semibold text-content-primary">{value}</div>
              </div>
            ))}
          </div>

          <section className="card overflow-hidden p-0">
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
              <div>
                <h2 className="text-sm font-semibold text-content-primary">Drift findings</h2>
                <p className="mt-0.5 text-xs text-content-secondary">Review signals only; no operation is executed automatically.</p>
              </div>
              <StatusChip status={report.findings.length === 0 ? 'success' : 'warning'} label={report.findings.length === 0 ? 'No drift found' : `${report.findings.length} to review`} />
            </div>
            {report.findings.length === 0 ? (
              <p className="px-4 py-6 text-sm text-content-secondary">The tenant contract and OmniKit registry did not produce a drift finding.</p>
            ) : (
              <div className="divide-y divide-border">
                {report.findings.slice(0, 200).map((finding) => (
                  <div key={finding.id} className="grid gap-2 px-4 py-3 text-xs lg:grid-cols-[180px_240px_1fr]">
                    <div className="font-semibold text-content-primary">{categoryLabel(finding.category)}</div>
                    <div className="truncate font-mono text-content-secondary">{finding.method ? `${finding.method} ` : ''}{finding.path}</div>
                    <div className="text-content-secondary">{finding.message}</div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="card p-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-semibold text-content-primary">Normalized operations</h2>
                <p className="mt-0.5 text-xs text-content-secondary">Showing up to 150 operations. The evidence export contains the complete bounded report.</p>
              </div>
              <input value={operationFilter} onChange={(event) => setOperationFilter(event.target.value)} className="input-field w-full sm:w-72" placeholder="Filter path, method, registry ID" aria-label="Filter normalized operations" />
            </div>
            <div className="mt-3 max-h-[420px] overflow-auto rounded-card border border-border">
              <div className="divide-y divide-border">
                {filteredOperations.map((operation) => (
                  <div key={operation.key} className="grid gap-2 px-3 py-2 text-xs sm:grid-cols-[72px_1fr_180px]">
                    <div className="font-semibold text-omni-800">{operation.method}</div>
                    <div className="truncate font-mono text-content-primary">{operation.path}</div>
                    <div className="truncate text-content-secondary">{operation.registry?.id || 'Tenant only'}</div>
                  </div>
                ))}
              </div>
            </div>
          </section>

          <div className="rounded-card border border-blue-200 bg-blue-50 px-4 py-3 text-xs leading-5 text-blue-900">
            Checked {new Date(report.checkedAt).toLocaleString()} · OpenAPI {report.openapiVersion} · {report.complete
              ? 'Complete reference fingerprint coverage'
              : `${report.externalReferenceCount} external reference${report.externalReferenceCount === 1 ? '' : 's'} excluded · ${report.unresolvedLocalReferenceCount} local reference${report.unresolvedLocalReferenceCount === 1 ? '' : 's'} unresolved`}
          </div>
        </>
      )}
    </div>
  );
}
