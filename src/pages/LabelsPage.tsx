import { useState, useEffect } from 'react';
import { Loader2, Tag, CheckCircle, AlertCircle, Shield, Home } from 'lucide-react';
import { useConnection } from '@/contexts/ConnectionContext';
import { useLogOperation } from '@/contexts/OperationLogContext';
import { omniProxy, listFolders, listDocuments } from '@/services/omniApi';
import { PageHeader } from '@/components/layout/PageHeader';
import type { OmniLabel, OmniFolder, OmniDocument } from '@/types';

export function LabelsPage() {
  const { connection } = useConnection();
  const logOp = useLogOperation();
  const [labels, setLabels] = useState<OmniLabel[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const [folders, setFolders] = useState<OmniFolder[]>([]);
  const [documents, setDocuments] = useState<OmniDocument[]>([]);
  const [selectedFolder, setSelectedFolder] = useState('');
  const [selectedDoc, setSelectedDoc] = useState('');
  const [loadingDocs, setLoadingDocs] = useState(false);

  const [addLabels, setAddLabels] = useState<string[]>([]);
  const [removeLabels, setRemoveLabels] = useState<string[]>([]);
  const [applying, setApplying] = useState(false);
  const [applyResult, setApplyResult] = useState<{ success: boolean; message: string } | null>(null);

  useEffect(() => {
    async function load() {
      setLoading(true);
      setError('');
      try {
        const [labelsRes, foldersRes] = await Promise.all([
          omniProxy<{ records?: OmniLabel[]; labels?: OmniLabel[] }>(connection.baseUrl, connection.apiKey, 'GET', '/v1/labels'),
          listFolders(connection.baseUrl, connection.apiKey),
        ]);
        setLabels(labelsRes.records || labelsRes.labels || []);
        setFolders(Array.isArray(foldersRes.folders) ? foldersRes.folders : []);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load labels');
      } finally {
        setLoading(false);
      }
    }
    load();
  }, [connection.baseUrl, connection.apiKey]);

  async function handleFolderChange(folderId: string) {
    setSelectedFolder(folderId);
    setSelectedDoc('');
    if (!folderId) { setDocuments([]); return; }
    setLoadingDocs(true);
    try {
      const res = await listDocuments(connection.baseUrl, connection.apiKey, folderId);
      setDocuments(Array.isArray(res.documents) ? res.documents : []);
    } catch { setDocuments([]); }
    finally { setLoadingDocs(false); }
  }

  function toggleLabel(list: string[], setList: (v: string[]) => void, name: string) {
    setList(list.includes(name) ? list.filter((l) => l !== name) : [...list, name]);
  }

  async function handleApply() {
    if (!selectedDoc || (addLabels.length === 0 && removeLabels.length === 0)) return;
    setApplying(true);
    setApplyResult(null);
    const start = Date.now();

    try {
      const body: Record<string, unknown> = {};
      if (addLabels.length > 0) body.add = addLabels;
      if (removeLabels.length > 0) body.remove = removeLabels;

      await omniProxy(
        connection.baseUrl, connection.apiKey, 'PATCH',
        `/v1/documents/${selectedDoc}/labels`,
        { body }
      );

      setApplyResult({ success: true, message: `Labels updated successfully.` });
      logOp('label_change', `Updated labels on document`, {
        durationMs: Date.now() - start,
        itemCount: addLabels.length + removeLabels.length,
      });
      setAddLabels([]);
      setRemoveLabels([]);
    } catch (err) {
      setApplyResult({ success: false, message: err instanceof Error ? err.message : 'Failed to update labels' });
    } finally {
      setApplying(false);
    }
  }

  function flattenFolders(folders: OmniFolder[], depth = 0): Array<OmniFolder & { depth: number }> {
    const result: Array<OmniFolder & { depth: number }> = [];
    for (const f of folders) {
      result.push({ ...f, depth });
      if (f.children) result.push(...flattenFolders(f.children, depth + 1));
    }
    return result;
  }

  const flatFolders = flattenFolders(folders);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Labels"
        description={`${labels.length} labels available in your organization.`}
      />

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-card">{error}</div>
      )}

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 size={24} className="text-omni-500 animate-spin" />
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
            {labels.map((label) => (
              <div key={label.id || label.name} className="card p-4 flex items-start gap-3">
                <div
                  className="w-4 h-4 rounded-full flex-shrink-0 mt-0.5 border border-border"
                  style={{ backgroundColor: label.color || '#94a3b8' }}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm font-medium text-content-primary truncate">{label.name}</span>
                    {label.verified && <Shield size={12} className="text-blue-600 flex-shrink-0" />}
                    {label.homepage && <Home size={12} className="text-green-600 flex-shrink-0" />}
                  </div>
                  {label.description && (
                    <p className="text-[10px] text-content-secondary mt-0.5 line-clamp-2">{label.description}</p>
                  )}
                  {label.usageCount != null && (
                    <span className="text-[10px] text-content-secondary/60">{label.usageCount} uses</span>
                  )}
                </div>
              </div>
            ))}
          </div>

          <div className="card space-y-4">
            <h3 className="text-base font-semibold text-content-primary flex items-center gap-2">
              <Tag size={16} className="text-omni-700" />
              Manage Document Labels
            </h3>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-medium text-content-secondary mb-1">Folder</label>
                <select value={selectedFolder} onChange={(e) => handleFolderChange(e.target.value)} className="input-field">
                  <option value="">Select folder...</option>
                  {flatFolders.map((f) => (
                    <option key={f.id} value={f.id}>{'  '.repeat(f.depth)}{f.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs font-medium text-content-secondary mb-1">Document</label>
                <select
                  value={selectedDoc}
                  onChange={(e) => setSelectedDoc(e.target.value)}
                  className="input-field"
                  disabled={loadingDocs || documents.length === 0}
                >
                  <option value="">Select document...</option>
                  {documents.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
              </div>
            </div>

            {selectedDoc && labels.length > 0 && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-medium text-content-secondary mb-2">Labels to Add</label>
                  <div className="flex flex-wrap gap-1.5">
                    {labels.map((l) => (
                      <button
                        key={`add-${l.name}`}
                        onClick={() => toggleLabel(addLabels, setAddLabels, l.name)}
                        className={`px-2.5 py-1 rounded-chip text-xs font-medium transition-colors border ${
                          addLabels.includes(l.name)
                            ? 'bg-green-100 border-green-300 text-green-800'
                            : 'bg-white border-border text-content-secondary hover:border-green-300'
                        }`}
                      >
                        {l.name}
                      </button>
                    ))}
                  </div>
                </div>
                <div>
                  <label className="block text-xs font-medium text-content-secondary mb-2">Labels to Remove</label>
                  <div className="flex flex-wrap gap-1.5">
                    {labels.map((l) => (
                      <button
                        key={`rm-${l.name}`}
                        onClick={() => toggleLabel(removeLabels, setRemoveLabels, l.name)}
                        className={`px-2.5 py-1 rounded-chip text-xs font-medium transition-colors border ${
                          removeLabels.includes(l.name)
                            ? 'bg-red-100 border-red-300 text-red-800'
                            : 'bg-white border-border text-content-secondary hover:border-red-300'
                        }`}
                      >
                        {l.name}
                      </button>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {applyResult && (
              <div className={`flex items-center gap-2 text-sm px-4 py-3 rounded-card ${applyResult.success ? 'bg-green-50 border border-green-200 text-green-700' : 'bg-red-50 border border-red-200 text-red-700'}`}>
                {applyResult.success ? <CheckCircle size={16} /> : <AlertCircle size={16} />}
                {applyResult.message}
              </div>
            )}

            <button
              onClick={handleApply}
              disabled={applying || !selectedDoc || (addLabels.length === 0 && removeLabels.length === 0)}
              className="btn-primary text-sm"
            >
              {applying ? <Loader2 size={14} className="animate-spin" /> : <Tag size={14} />}
              Apply Label Changes
            </button>
          </div>
        </>
      )}
    </div>
  );
}
