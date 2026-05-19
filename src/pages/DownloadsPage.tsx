import { useState, useEffect } from 'react';
import { Download, Loader2, FileText, Image, FileSpreadsheet, CheckCircle, AlertCircle } from 'lucide-react';
import { useConnection } from '@/contexts/ConnectionContext';
import { useLogOperation } from '@/contexts/OperationLogContext';
import { listFolders, listDocuments, omniProxy, omniProxyDownload } from '@/services/omniApi';
import { PageHeader } from '@/components/layout/PageHeader';
import { DownloadAnimation } from '@/components/ui/DownloadAnimation';
import { Blobby } from '@/components/ui/Blobby';
import type { OmniFolder, OmniDocument } from '@/types';

const FORMAT_OPTIONS = [
  { value: 'pdf', label: 'PDF', description: 'Single PDF file', icon: FileText, color: 'text-red-600 bg-red-50' },
  { value: 'png', label: 'PNG', description: 'Image snapshot', icon: Image, color: 'text-blue-600 bg-blue-50' },
  { value: 'csv', label: 'CSV (ZIP)', description: 'One CSV per tile', icon: FileSpreadsheet, color: 'text-green-600 bg-green-50' },
  { value: 'xlsx', label: 'XLSX', description: 'Excel workbook', icon: FileSpreadsheet, color: 'text-emerald-600 bg-emerald-50' },
];

const PAPER_FORMATS = [
  { value: 'fit_page', label: 'Fit Page' },
  { value: 'letter', label: 'Letter' },
  { value: 'legal', label: 'Legal' },
  { value: 'tabloid', label: 'Tabloid' },
  { value: 'a3', label: 'A3' },
  { value: 'a4', label: 'A4' },
];

export function DownloadsPage() {
  const { connection } = useConnection();
  const logOp = useLogOperation();
  const [folders, setFolders] = useState<OmniFolder[]>([]);
  const [documents, setDocuments] = useState<OmniDocument[]>([]);
  const [selectedFolder, setSelectedFolder] = useState('');
  const [selectedDoc, setSelectedDoc] = useState('');
  const [selectedDocName, setSelectedDocName] = useState('');
  const [format, setFormat] = useState('pdf');
  const [loadingFolders, setLoadingFolders] = useState(false);
  const [loadingDocs, setLoadingDocs] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [jobStatus, setJobStatus] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const [paperFormat, setPaperFormat] = useState('fit_page');
  const [orientation, setOrientation] = useState('landscape');
  const [hideTitle, setHideTitle] = useState(false);
  const [showFilters, setShowFilters] = useState(false);
  const [expandTables, setExpandTables] = useState(false);
  const [enableFormatting, setEnableFormatting] = useState(true);
  const [hideHiddenFields, setHideHiddenFields] = useState(false);
  const [maxRowLimit, setMaxRowLimit] = useState('');

  useEffect(() => {
    async function load() {
      setLoadingFolders(true);
      try {
        const res = await listFolders(connection.baseUrl, connection.apiKey, { allPages: true, pageSize: 100 });
        setFolders(Array.isArray(res.folders) ? res.folders : []);
      } catch { /* ignore */ }
      finally { setLoadingFolders(false); }
    }
    load();
  }, [connection.baseUrl, connection.apiKey]);

  async function handleFolderChange(folderId: string) {
    setSelectedFolder(folderId);
    setSelectedDoc('');
    setSelectedDocName('');
    if (!folderId) { setDocuments([]); return; }
    setLoadingDocs(true);
    try {
      const res = await listDocuments(connection.baseUrl, connection.apiKey, folderId, { allPages: true, pageSize: 100 });
      setDocuments(Array.isArray(res.documents) ? res.documents : []);
    } catch { setDocuments([]); }
    finally { setLoadingDocs(false); }
  }

  function flattenFolders(folders: OmniFolder[], depth = 0): Array<OmniFolder & { depth: number }> {
    const result: Array<OmniFolder & { depth: number }> = [];
    for (const f of folders) {
      result.push({ ...f, depth });
      if (f.children) result.push(...flattenFolders(f.children, depth + 1));
    }
    return result;
  }

  async function handleDownload() {
    if (!selectedDoc) return;
    setDownloading(true);
    setError('');
    setSuccess('');
    setJobStatus('Starting download...');
    const start = Date.now();

    try {
      const body: Record<string, unknown> = { format };

      if (format === 'pdf') {
        body.paperFormat = paperFormat;
        body.paperOrientation = orientation;
        if (hideTitle) body.hideTitle = true;
        if (showFilters) body.showFilters = true;
        if (expandTables) body.expandTablesToShowAllRows = true;
      }

      if (format === 'png') {
        if (hideTitle) body.hideTitle = true;
        if (showFilters) body.showFilters = true;
        if (expandTables) body.expandTablesToShowAllRows = true;
      }

      if (format === 'csv' || format === 'xlsx') {
        if (enableFormatting) body.enableFormatting = true;
        if (hideHiddenFields) body.hideHiddenFields = true;
        const maxRows = parseInt(maxRowLimit);
        if (!isNaN(maxRows) && maxRows > 0) body.maxRowLimit = maxRows;
      }

      const res = await omniProxy<{ job_id?: string; error?: string }>(
        connection.baseUrl, connection.apiKey, 'POST',
        `/v1/dashboards/${selectedDoc}/download`,
        { body }
      );

      if (res.error) {
        setError(res.error);
        return;
      }

      const jobId = res.job_id;
      if (!jobId) {
        setError('No job ID returned from server. Please try again.');
        return;
      }

      setJobStatus('Processing...');
      let attempts = 0;
      const maxAttempts = 60;
      let jobComplete = false;

      while (attempts < maxAttempts) {
        await new Promise((r) => setTimeout(r, 3000));
        attempts++;

        let status: { status: string; error?: string };
        try {
          status = await omniProxy<{ status: string; error?: string }>(
            connection.baseUrl, connection.apiKey, 'GET',
            `/v1/dashboards/${selectedDoc}/download/${jobId}/status`
          );
        } catch (err) {
          setError(`Status check failed: ${err instanceof Error ? err.message : 'Unknown error'}`);
          break;
        }

        if (status.status === 'complete') {
          jobComplete = true;
          break;
        } else if (status.status === 'error') {
          setError(status.error || 'The download job failed on the server. Please try again.');
          break;
        }
        setJobStatus(`Processing... (${attempts * 3}s)`);
      }

      if (!jobComplete && attempts >= maxAttempts) {
        setError('Download timed out after 3 minutes. Please try again.');
      }

      if (jobComplete) {
        setJobStatus('Fetching file...');
        const blob = await omniProxyDownload(
          connection.baseUrl,
          connection.apiKey,
          `/v1/dashboards/${selectedDoc}/download/${jobId}`
        );
        const ext = format === 'xlsx' ? 'xlsx' : format === 'csv' ? 'zip' : format === 'png' ? 'png' : 'pdf';
        const mimeTypes: Record<string, string> = {
          pdf: 'application/pdf',
          png: 'image/png',
          csv: 'application/zip',
          xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        };
        const typedBlob = new Blob([blob], { type: mimeTypes[format] || 'application/octet-stream' });
        const filename = `${selectedDocName || 'dashboard'}.${ext}`;
        const url = URL.createObjectURL(typedBlob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        const formatLabel = format === 'csv' ? 'CSV (ZIP - one CSV per tile)' : format.toUpperCase();
        setSuccess(`"${selectedDocName}" downloaded as ${formatLabel}`);
        logOp('download', `Downloaded "${selectedDocName}" as ${formatLabel}`, {
          durationMs: Date.now() - start,
        });
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Download failed');
    } finally {
      setDownloading(false);
      setJobStatus(null);
    }
  }

  const isPdfPng = format === 'pdf' || format === 'png';
  const isCsvXlsx = format === 'csv' || format === 'xlsx';
  const flatFolders = flattenFolders(folders);

  return (
    <div className="space-y-5">
      <PageHeader
        title="Dashboard Downloads"
        description="Export dashboards in multiple formats with custom options."
        icon={<Blobby mood="download" size={58} className="animate-float" style={{ animationDuration: '3.5s' }} />}
      />

      <div className="card space-y-5">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-content-secondary mb-1">Folder</label>
            {loadingFolders ? (
              <div className="input-field flex items-center gap-2 text-content-secondary">
                <Loader2 size={14} className="animate-spin" /> Loading...
              </div>
            ) : (
              <select value={selectedFolder} onChange={(e) => handleFolderChange(e.target.value)} className="input-field">
                <option value="">Select folder...</option>
                {flatFolders.map((f) => (
                  <option key={f.id} value={f.id}>
                    {'  '.repeat(f.depth)}{f.name}
                  </option>
                ))}
              </select>
            )}
          </div>
          <div>
            <label className="block text-xs font-medium text-content-secondary mb-1">Dashboard</label>
            {loadingDocs ? (
              <div className="input-field flex items-center gap-2 text-content-secondary">
                <Loader2 size={14} className="animate-spin" /> Loading...
              </div>
            ) : (
              <select
                value={selectedDoc}
                onChange={(e) => {
                  setSelectedDoc(e.target.value);
                  const doc = documents.find((d) => d.id === e.target.value);
                  setSelectedDocName(doc?.name || '');
                }}
                className="input-field"
                disabled={documents.length === 0}
              >
                <option value="">Select dashboard...</option>
                {documents.map((d) => (
                  <option key={d.id} value={d.id}>{d.name}</option>
                ))}
              </select>
            )}
          </div>
        </div>

        <div>
          <label className="block text-xs font-medium text-content-secondary mb-2">Format</label>
          <div className="grid grid-cols-4 gap-2">
            {FORMAT_OPTIONS.map((opt) => {
              const Icon = opt.icon;
              const isSelected = format === opt.value;
              return (
                <button
                  key={opt.value}
                  onClick={() => setFormat(opt.value)}
                  className={`flex flex-col items-center gap-1.5 p-3 rounded-card border-2 transition-all ${
                    isSelected
                      ? 'border-omni-700 bg-surface-secondary'
                      : 'border-border hover:border-omni-500/40'
                  }`}
                >
                  <div className={`p-2 rounded-button ${opt.color}`}>
                    <Icon size={18} />
                  </div>
                  <span className="text-xs font-medium text-content-primary">{opt.label}</span>
                  <span className="text-[10px] text-content-secondary leading-tight text-center">{opt.description}</span>
                </button>
              );
            })}
          </div>
        </div>

        {isPdfPng && (
          <div className="grid grid-cols-2 md:grid-cols-3 gap-4 p-4 bg-surface-secondary rounded-card">
            {format === 'pdf' && (
              <>
                <div>
                  <label className="block text-xs font-medium text-content-secondary mb-1">Paper Format</label>
                  <select value={paperFormat} onChange={(e) => setPaperFormat(e.target.value)} className="input-field">
                    {PAPER_FORMATS.map((p) => <option key={p.value} value={p.value}>{p.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-content-secondary mb-1">Orientation</label>
                  <select value={orientation} onChange={(e) => setOrientation(e.target.value)} className="input-field">
                    <option value="landscape">Landscape</option>
                    <option value="portrait">Portrait</option>
                  </select>
                </div>
              </>
            )}
            <div className="flex flex-col gap-2 justify-center">
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={hideTitle} onChange={(e) => setHideTitle(e.target.checked)} />
                <span className="text-xs text-content-primary">Hide title</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={showFilters} onChange={(e) => setShowFilters(e.target.checked)} />
                <span className="text-xs text-content-primary">Show filters</span>
              </label>
              <label className="flex items-center gap-2 cursor-pointer">
                <input type="checkbox" checked={expandTables} onChange={(e) => setExpandTables(e.target.checked)} />
                <span className="text-xs text-content-primary">Expand tables</span>
              </label>
            </div>
          </div>
        )}

        {isCsvXlsx && (
          <div className="space-y-3 p-4 bg-surface-secondary rounded-card">
            {format === 'csv' && (
              <p className="text-xs text-content-secondary">CSV export produces a ZIP archive containing one CSV file per dashboard tile.</p>
            )}
            {format === 'xlsx' && (
              <p className="text-xs text-content-secondary">XLSX export produces a single Excel workbook with one sheet per dashboard tile.</p>
            )}
            <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
              <div>
                <label className="block text-xs font-medium text-content-secondary mb-1">Max Row Limit</label>
                <input
                  type="number"
                  value={maxRowLimit}
                  onChange={(e) => setMaxRowLimit(e.target.value)}
                  className="input-field"
                  min="1"
                  max="1000000"
                  placeholder="No limit"
                />
              </div>
              <div className="flex flex-col gap-2 justify-center">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={enableFormatting} onChange={(e) => setEnableFormatting(e.target.checked)} />
                  <span className="text-xs text-content-primary">Enable formatting</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input type="checkbox" checked={hideHiddenFields} onChange={(e) => setHideHiddenFields(e.target.checked)} />
                  <span className="text-xs text-content-primary">Hide hidden fields</span>
                </label>
              </div>
            </div>
          </div>
        )}

        {(downloading || success) && (
          <DownloadAnimation status={jobStatus} success={!!success} format={format} />
        )}

        {error && (
          <div className="flex items-center gap-2 bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-card">
            <AlertCircle size={16} />
            {error}
          </div>
        )}

        {success && !downloading && (
          <div className="flex items-center gap-2 bg-green-50 border border-green-200 text-green-700 text-sm px-4 py-3 rounded-card">
            <CheckCircle size={16} />
            {success}
          </div>
        )}

        <button
          onClick={handleDownload}
          disabled={downloading || !selectedDoc}
          className="btn-primary text-sm"
        >
          {downloading ? (
            <>
              <Loader2 size={14} className="animate-spin" />
              Downloading...
            </>
          ) : (
            <>
              <Download size={14} />
              Download Dashboard
            </>
          )}
        </button>
      </div>
    </div>
  );
}
