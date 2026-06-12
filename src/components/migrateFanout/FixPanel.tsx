import { useEffect, useMemo, useState } from 'react';
import { CheckCircle2, Loader2, Tag, X } from 'lucide-react';
import {
  listInstanceLabels,
  updateInstanceDocumentMetadata,
  type InstanceDocument,
  type InstanceLabel,
} from '@/services/opsConsole';
import { ProgressBar } from '@/components/ui/ProgressBar';

interface FixPanelProps {
  open: boolean;
  instanceId: string;
  documents: InstanceDocument[];
  onClose: () => void;
  onApplied: () => Promise<void> | void;
}

function labelsFor(document: InstanceDocument): string[] {
  return document.labels || [];
}

function needsMetadata(document: InstanceDocument): boolean {
  return !document.description?.trim() || labelsFor(document).length === 0;
}

export function FixPanel({ open, instanceId, documents, onClose, onApplied }: FixPanelProps) {
  const [labels, setLabels] = useState<InstanceLabel[]>([]);
  const [loadingLabels, setLoadingLabels] = useState(false);
  const [descriptions, setDescriptions] = useState<Record<string, string>>({});
  const [labelText, setLabelText] = useState<Record<string, string>>({});
  const [clearDrafts, setClearDrafts] = useState(true);
  const [applying, setApplying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState('');
  const rows = useMemo(() => documents.filter(needsMetadata), [documents]);

  useEffect(() => {
    if (!open || !instanceId) return;
    setDescriptions(Object.fromEntries(rows.map((document) => [document.identifier, document.description || ''])));
    setLabelText(Object.fromEntries(rows.map((document) => [document.identifier, labelsFor(document).join(', ')])));
  }, [open, instanceId, rows]);

  useEffect(() => {
    if (!open || !instanceId) return;
    setLoadingLabels(true);
    listInstanceLabels(instanceId)
      .then((res) => setLabels(res.labels))
      .catch(() => setLabels([]))
      .finally(() => setLoadingLabels(false));
  }, [open, instanceId]);

  if (!open) return null;

  async function applyFixes() {
    setApplying(true);
    setError('');
    setProgress(0);
    try {
      for (let index = 0; index < rows.length; index += 1) {
        const document = rows[index];
        const nextLabels = (labelText[document.identifier] || '')
          .split(',')
          .map((label) => label.trim())
          .filter(Boolean);
        const existingNames = new Set(labels.map((label) => label.name));
        const createLabels = nextLabels.filter((label) => !existingNames.has(label));
        await updateInstanceDocumentMetadata(instanceId, document.identifier, {
          description: descriptions[document.identifier] || '',
          labels: nextLabels,
          createLabels,
          clearExistingDraft: clearDrafts,
        });
        setProgress(index + 1);
      }
      await onApplied();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not apply metadata fixes.');
    } finally {
      setApplying(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/20">
      <div className="h-full w-full max-w-3xl overflow-y-auto bg-white shadow-xl">
        <div className="sticky top-0 z-10 border-b border-border bg-white px-5 py-4">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold text-content-primary">Fix dashboard metadata</h2>
              <p className="mt-1 text-sm text-content-secondary">
                Add missing descriptions and labels before migration so destination dashboards carry useful context.
              </p>
            </div>
            <button type="button" onClick={onClose} className="rounded-full p-2 text-content-secondary hover:bg-surface-secondary" aria-label="Close metadata fixes">
              <X size={18} />
            </button>
          </div>
        </div>

        <div className="space-y-4 p-5">
          {error && <div className="rounded-card border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
          {rows.length === 0 ? (
            <div className="rounded-card border border-green-200 bg-green-50 p-4 text-sm text-green-800">
              <CheckCircle2 size={17} className="mr-2 inline-block" />
              Selected dashboards already have descriptions and labels.
            </div>
          ) : (
            <>
              <div className="rounded-card border border-border-subtle bg-surface-secondary px-3 py-2 text-xs text-content-secondary">
                {loadingLabels ? 'Loading existing labels...' : `${labels.length} existing labels available. Enter comma-separated labels; new labels are created as needed.`}
              </div>
              {applying && <ProgressBar current={progress} total={rows.length} label="Applying metadata fixes" tone="brand" />}
              <label className="flex items-start gap-2 rounded-card border border-border-subtle p-3 text-sm">
                <input
                  type="checkbox"
                  checked={clearDrafts}
                  onChange={(event) => setClearDrafts(event.target.checked)}
                  className="mt-1 accent-omni-600"
                />
                <span>
                  <span className="font-semibold text-content-primary">Clear existing drafts while patching descriptions</span>
                  <span className="mt-1 block text-xs text-content-secondary">Recommended when metadata edits should apply to the latest saved dashboard document.</span>
                </span>
              </label>
              <div className="space-y-3">
                {rows.map((document) => (
                  <div key={document.identifier} className="rounded-card border border-border-subtle p-4">
                    <div className="mb-3 flex flex-col gap-1 sm:flex-row sm:items-start sm:justify-between">
                      <div>
                        <div className="text-sm font-semibold text-content-primary">{document.name}</div>
                        <div className="font-mono text-xs text-content-secondary">{document.identifier}</div>
                      </div>
                      <div className="inline-flex items-center gap-1 rounded-chip bg-yellow-100 px-2 py-0.5 text-xs font-semibold text-yellow-800">
                        <Tag size={12} />
                        Metadata needed
                      </div>
                    </div>
                    <label className="block text-xs font-semibold text-content-primary">Description</label>
                    <textarea
                      value={descriptions[document.identifier] || ''}
                      onChange={(event) => setDescriptions((prev) => ({ ...prev, [document.identifier]: event.target.value }))}
                      className="input-field mt-1 min-h-[92px]"
                      placeholder="Add a short dashboard description"
                    />
                    <label className="mt-3 block text-xs font-semibold text-content-primary">Labels</label>
                    <input
                      value={labelText[document.identifier] || ''}
                      onChange={(event) => setLabelText((prev) => ({ ...prev, [document.identifier]: event.target.value }))}
                      className="input-field mt-1"
                      placeholder="Executive, Revenue Ops, Migrated"
                    />
                  </div>
                ))}
              </div>
            </>
          )}
        </div>

        <div className="sticky bottom-0 flex justify-end gap-3 border-t border-border bg-white px-5 py-4">
          <button type="button" onClick={onClose} className="btn-secondary" disabled={applying}>Cancel</button>
          <button type="button" onClick={applyFixes} className="btn-primary inline-flex items-center gap-2" disabled={applying || rows.length === 0}>
            {applying ? <Loader2 size={15} className="animate-spin" /> : <CheckCircle2 size={15} />}
            Apply fixes
          </button>
        </div>
      </div>
    </div>
  );
}
