import { useState, useEffect, useRef } from 'react';
import { X, Copy, Check, Loader2, AlertTriangle, Search, ChevronDown, ChevronRight } from 'lucide-react';
import { inspectExport } from '@/services/omniApi';
import type { InspectExportResult } from '@/services/omniApi';

interface InspectExportModalProps {
  open: boolean;
  onClose: () => void;
  baseUrl: string;
  apiKey: string;
  documentId: string;
  documentName: string;
}

function DiagnosticRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3 py-1.5">
      <span className="text-xs text-content-secondary w-40 flex-shrink-0 pt-0.5">{label}</span>
      <div className="text-xs text-content-primary flex-1 min-w-0">{children}</div>
    </div>
  );
}

export function InspectExportModal({
  open,
  onClose,
  baseUrl,
  apiKey,
  documentId,
  documentName,
}: InspectExportModalProps) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<InspectExportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const backdropRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) {
      setResult(null);
      setError(null);
      setCopied(false);
      setShowRaw(false);
      return;
    }

    let cancelled = false;
    async function run() {
      setLoading(true);
      setError(null);
      try {
        const data = await inspectExport(baseUrl, apiKey, documentId);
        if (cancelled) return;
        if (data.error) {
          setError(data.error);
        } else {
          setResult(data);
        }
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to inspect export.');
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    run();

    return () => { cancelled = true; };
  }, [open, baseUrl, apiKey, documentId]);

  useEffect(() => {
    if (!open) return;
    function handleEscape(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [open, onClose]);

  async function handleCopy() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(JSON.stringify(result.rawPayload, null, 2));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard may not be available
    }
  }

  if (!open) return null;

  const diag = result?.diagnostics;

  return (
    <div
      ref={backdropRef}
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 animate-fadeIn"
      onClick={(e) => { if (e.target === backdropRef.current) onClose(); }}
    >
      <div className="bg-surface-primary rounded-card shadow-2xl border border-border w-full max-w-2xl max-h-[85vh] flex flex-col mx-4 animate-slideUp">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-content-primary truncate">
              Export Inspector
            </h3>
            <p className="text-xs text-content-secondary mt-0.5 truncate">
              {documentName}
              <span className="ml-2 font-mono opacity-60">{documentId}</span>
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 rounded-button hover:bg-surface-secondary transition-colors text-content-secondary"
          >
            <X size={16} />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {loading && (
            <div className="flex items-center justify-center py-12">
              <Loader2 size={24} className="text-omni-500 animate-spin" />
              <span className="ml-3 text-sm text-content-secondary">Fetching export payload...</span>
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 px-4 py-3 bg-red-50 border border-red-200 rounded-card">
              <AlertTriangle size={14} className="text-red-600 mt-0.5 flex-shrink-0" />
              <p className="text-xs text-red-700">{error}</p>
            </div>
          )}

          {diag && (
            <>
              <div className="space-y-1">
                <h4 className="text-xs font-semibold text-content-primary uppercase tracking-wider mb-2">
                  Diagnostics
                </h4>

                <DiagnosticRow label="Top-level keys">
                  <span className="font-mono text-[11px] break-all">
                    {diag.topLevelKeys.join(', ') || '(none)'}
                  </span>
                </DiagnosticRow>

                <DiagnosticRow label="Payload size">
                  {(diag.payloadSizeBytes / 1024).toFixed(1)} KB
                </DiagnosticRow>

                <DiagnosticRow label="Envelope pattern">
                  {diag.envelopePattern ? (
                    <span className="font-mono text-[11px]">
                      {diag.envelopePattern.pattern}
                      <span className="text-content-secondary ml-2">
                        inner: [{diag.envelopePattern.innerKeys.slice(0, 8).join(', ')}
                        {diag.envelopePattern.innerKeys.length > 8 ? '...' : ''}]
                      </span>
                    </span>
                  ) : (
                    <span className="text-content-secondary italic">No wrapper detected</span>
                  )}
                </DiagnosticRow>

                <DiagnosticRow label="Model ID fields">
                  <span className={diag.modelIdCount > 0 ? 'text-green-700' : 'text-amber-600'}>
                    {diag.modelIdCount} found
                  </span>
                  {diag.hasTopLevelModelId && (
                    <span className="ml-2 text-green-600 text-[10px] font-medium uppercase">
                      top-level
                    </span>
                  )}
                </DiagnosticRow>
              </div>

              {diag.modelIdLocations.length > 0 && (
                <div className="space-y-1">
                  <h4 className="text-xs font-semibold text-content-primary uppercase tracking-wider mb-2">
                    Model ID Locations
                  </h4>
                  <div className="bg-surface-secondary rounded-card border border-border overflow-hidden">
                    {diag.modelIdLocations.map((loc, i) => (
                      <div
                        key={i}
                        className="flex items-center gap-3 px-3 py-2 border-b border-border/50 last:border-b-0"
                      >
                        <Search size={12} className="text-content-secondary flex-shrink-0" />
                        <span className="font-mono text-[11px] text-content-primary truncate flex-1">
                          {loc.path}
                        </span>
                        <span className="font-mono text-[11px] text-omni-600 flex-shrink-0 max-w-[200px] truncate">
                          {loc.value}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {diag.nullOrUndefinedFields.length > 0 && (
                <div className="space-y-1">
                  <h4 className="text-xs font-semibold text-content-primary uppercase tracking-wider mb-2">
                    Null / Undefined Fields (top 3 levels)
                  </h4>
                  <div className="font-mono text-[11px] text-content-secondary space-y-0.5">
                    {diag.nullOrUndefinedFields.map((f, i) => (
                      <div key={i}>{f}</div>
                    ))}
                  </div>
                </div>
              )}

              <div className="space-y-2">
                <button
                  onClick={() => setShowRaw(!showRaw)}
                  className="flex items-center gap-1.5 text-xs font-medium text-content-secondary hover:text-content-primary transition-colors"
                >
                  {showRaw ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                  Raw JSON Payload
                </button>

                {showRaw && (
                  <div className="relative">
                    <button
                      onClick={handleCopy}
                      className="absolute top-2 right-2 flex items-center gap-1 px-2 py-1 text-[10px] font-medium bg-surface-primary/90 border border-border rounded-button hover:bg-surface-secondary transition-colors"
                    >
                      {copied ? <Check size={10} className="text-green-600" /> : <Copy size={10} />}
                      {copied ? 'Copied' : 'Copy'}
                    </button>
                    <pre className="bg-slate-900 text-slate-100 text-[11px] leading-relaxed p-4 rounded-card overflow-auto max-h-[300px] font-mono">
                      {JSON.stringify(result.rawPayload, null, 2)}
                    </pre>
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        <div className="flex items-center justify-end px-5 py-3 border-t border-border">
          <button onClick={onClose} className="btn-secondary text-sm">
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
