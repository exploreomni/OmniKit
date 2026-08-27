import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Download, Loader2, ShieldCheck, X } from 'lucide-react';

import { StatusChip } from '@/components/ui/StatusChip';
import {
  fetchDeliveryOwnershipEvidence,
  type DeliveryOwnershipReportDTO,
} from '@/services/deliveryOwnership';

function exportReport(report: DeliveryOwnershipReportDTO): void {
  const bundle = report.bundle;
  const blob = new Blob([`${JSON.stringify(bundle, null, 2)}\n`], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `omnikit-delivery-ownership-${bundle.evidence.schedule.id}.json`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function ownerStatus(state: DeliveryOwnershipReportDTO['bundle']['evidence']['schedule']['ownerState']): {
  status: 'success' | 'error' | 'warning' | 'pending';
  label: string;
} {
  if (state === 'active') return { status: 'success', label: 'Active owner' };
  if (state === 'inactive') return { status: 'error', label: 'Inactive owner' };
  if (state === 'not_found') return { status: 'warning', label: 'Owner not found' };
  return { status: 'pending', label: 'Owner unverified' };
}

export function DeliveryOwnershipPanel({
  instanceId,
  scheduleId,
  scheduleName,
  onClose,
}: {
  instanceId?: string;
  scheduleId: string;
  scheduleName: string;
  onClose: () => void;
}) {
  const [report, setReport] = useState<DeliveryOwnershipReportDTO | null>(null);
  const [error, setError] = useState('');
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!instanceId) {
      setError('Reconnect this schedule through a saved Omni instance before generating ownership evidence.');
      return undefined;
    }
    const controller = new AbortController();
    setError('');
    setReport(null);
    void fetchDeliveryOwnershipEvidence({ instanceId, scheduleId, signal: controller.signal })
      .then(setReport)
      .catch((loadError) => {
        if (loadError instanceof DOMException && loadError.name === 'AbortError') return;
        setError(loadError instanceof Error ? loadError.message : 'Delivery ownership evidence could not be loaded.');
      });
    return () => controller.abort();
  }, [instanceId, scheduleId]);

  useEffect(() => {
    dialogRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  const ownership = report?.bundle.evidence;
  const owner = ownership ? ownerStatus(ownership.schedule.ownerState) : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="delivery-ownership-title" tabIndex={-1} className="max-h-[90vh] w-full max-w-4xl overflow-y-auto rounded-card border border-border bg-white shadow-xl outline-none">
        <div className="sticky top-0 z-10 flex items-start justify-between gap-4 border-b border-border bg-white px-5 py-4">
          <div>
            <h2 id="delivery-ownership-title" className="flex items-center gap-2 text-base font-semibold text-content-primary"><ShieldCheck size={18} className="text-omni-700" /> Delivery & ownership evidence</h2>
            <p className="mt-1 text-xs text-content-secondary">{scheduleName}</p>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" className="btn-secondary text-xs" disabled={!report} onClick={() => report && exportReport(report)}><Download size={13} /> Export</button>
            <button type="button" className="rounded p-2 text-content-secondary hover:bg-surface-secondary" onClick={onClose} aria-label="Close ownership evidence"><X size={17} /></button>
          </div>
        </div>

        <div className="space-y-4 p-5">
          {!report && !error && <div className="flex items-center justify-center gap-2 py-10 text-sm text-content-secondary"><Loader2 size={17} className="animate-spin" /> Reading schedule, recipient, and lifecycle evidence…</div>}
          {error && <div className="rounded-card border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}

          {ownership && owner && (
            <>
              <div className="grid gap-3 md:grid-cols-3">
                <div className="card p-4">
                  <div className="text-[11px] font-medium uppercase tracking-wider text-content-secondary">Owner</div>
                  <div className="mt-2 truncate text-sm font-semibold text-content-primary">{ownership.schedule.ownerName || ownership.schedule.ownerId || 'Not returned'}</div>
                  <div className="mt-2"><StatusChip status={owner.status} label={owner.label} /></div>
                </div>
                <div className="card p-4">
                  <div className="text-[11px] font-medium uppercase tracking-wider text-content-secondary">Recipients observed</div>
                  <div className="mt-2 text-2xl font-semibold text-content-primary">{ownership.recipients.length}</div>
                  <p className="mt-1 text-xs text-content-secondary">Recipient shape varies by destination.</p>
                </div>
                <div className="card p-4">
                  <div className="text-[11px] font-medium uppercase tracking-wider text-content-secondary">Evidence coverage</div>
                  <div className="mt-2 text-2xl font-semibold text-content-primary">{report.bundle.coverage.included} / {report.bundle.coverage.total ?? '—'}</div>
                  <p className="mt-1 text-xs text-content-secondary">Schedule, recipients, and user lifecycle.</p>
                </div>
              </div>

              <section className="card p-4">
                <h3 className="text-sm font-semibold text-content-primary">Offboarding exposure</h3>
                <div className="mt-3 space-y-2">
                  {ownership.exposure.map((item) => (
                    <div key={item.code} className={`flex items-start gap-2 rounded-card border px-3 py-2 text-xs ${item.severity === 'critical' ? 'border-red-200 bg-red-50 text-red-800' : item.severity === 'warning' ? 'border-yellow-200 bg-yellow-50 text-yellow-800' : 'border-border bg-surface-secondary text-content-secondary'}`}>
                      <AlertTriangle size={14} className="mt-0.5 shrink-0" />
                      <span>{item.message}</span>
                    </div>
                  ))}
                </div>
              </section>

              <section className="card overflow-hidden p-0">
                <div className="border-b border-border px-4 py-3">
                  <h3 className="text-sm font-semibold text-content-primary">Recipient lifecycle evidence</h3>
                </div>
                {ownership.recipients.length === 0 ? (
                  <p className="px-4 py-6 text-sm text-content-secondary">No recipient details were returned in the readable response.</p>
                ) : (
                  <div className="divide-y divide-border">
                    {ownership.recipients.map((recipient, index) => (
                      <div key={`${recipient.id || recipient.label}-${index}`} className="grid gap-2 px-4 py-3 text-xs sm:grid-cols-[1fr_140px_150px]">
                        <div className="truncate font-medium text-content-primary">{recipient.label}</div>
                        <div className="text-content-secondary">{recipient.kind}</div>
                        <div className="text-content-secondary">{recipient.accountState.replace(/_/g, ' ')}</div>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <div className="rounded-card border border-blue-200 bg-blue-50 px-4 py-3 text-xs leading-5 text-blue-900">
                {ownership.historyCoverage.detail}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
