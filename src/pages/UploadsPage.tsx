import { useState, useEffect, useCallback } from 'react';
import { Loader2, FileUp, User } from 'lucide-react';
import { useConnection } from '@/contexts/ConnectionContext';
import { omniProxy } from '@/services/omniApi';
import { PageHeader } from '@/components/layout/PageHeader';
import { SearchInput } from '@/components/ui/SearchInput';
import type { OmniUpload, PageInfo } from '@/types';

function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return '-';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(dateStr: string | undefined): string {
  if (!dateStr) return '-';
  try {
    return new Date(dateStr).toLocaleDateString('en-US', {
      month: 'short', day: 'numeric', year: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  } catch { return dateStr; }
}

export function UploadsPage() {
  const { connection } = useConnection();
  const [uploads, setUploads] = useState<OmniUpload[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState('csv');
  const [page, setPage] = useState(1);
  const [pageInfo, setPageInfo] = useState<PageInfo | null>(null);
  const [cursors, setCursors] = useState<Record<number, string>>({});

  const fetchUploads = useCallback(async (pageNum: number) => {
    setLoading(true);
    setError('');
    try {
      const params: Record<string, string> = { type: typeFilter, pageSize: '25' };
      if (search) params.searchTerm = search;
      if (pageNum > 1 && cursors[pageNum]) params.cursor = cursors[pageNum];

      const res = await omniProxy<{ records?: OmniUpload[]; pageInfo?: PageInfo }>(
        connection.baseUrl, connection.apiKey, 'GET', '/v1/uploads',
        { queryParams: params }
      );
      setUploads(res.records || []);
      setPageInfo(res.pageInfo || null);
      if (res.pageInfo?.nextCursor) {
        setCursors((prev) => ({ ...prev, [pageNum + 1]: res.pageInfo!.nextCursor! }));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load uploads');
    } finally {
      setLoading(false);
    }
  }, [connection.baseUrl, connection.apiKey, search, typeFilter, cursors]);

  useEffect(() => {
    fetchUploads(page);
  }, [fetchUploads, page]);

  const totalPages = pageInfo ? Math.ceil(pageInfo.totalRecords / pageInfo.pageSize) : 1;

  return (
    <div className="space-y-5">
      <PageHeader
        title="Uploads"
        description={`${pageInfo?.totalRecords ?? uploads.length} uploaded files in your organization.`}
        icon={
          <img
            src="/blobby-upload.webp"
            alt="Blobby postal worker"
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
          <SearchInput value={search} onChange={setSearch} placeholder="Search by file name..." />
        </div>
        <select value={typeFilter} onChange={(e) => { setTypeFilter(e.target.value); setPage(1); setCursors({}); }} className="input-field w-auto">
          <option value="csv">CSV</option>
          <option value="spreadsheet">Spreadsheet</option>
        </select>
        <button onClick={() => { setPage(1); setCursors({}); fetchUploads(1); }} className="btn-secondary text-sm">Search</button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 size={24} className="text-omni-500 animate-spin" />
        </div>
      ) : (
        <div className="card p-0 overflow-hidden">
          <div className="bg-surface-secondary px-4 py-2.5 border-b border-border grid grid-cols-12 gap-2 text-xs font-medium text-content-secondary uppercase tracking-wider">
            <div className="col-span-1" />
            <div className="col-span-3">File Name</div>
            <div className="col-span-2">View Name</div>
            <div className="col-span-1">Size</div>
            <div className="col-span-2">Uploaded By</div>
            <div className="col-span-3">Updated</div>
          </div>

          <div className="max-h-[500px] overflow-y-auto">
            {uploads.length === 0 ? (
              <div className="flex flex-col items-center justify-center py-12 animate-fadeIn">
                <img
                  src="/blobby-no-results.webp"
                  alt="Blobby searching"
                  className="w-16 h-16 object-contain animate-float mb-3"
                  style={{ animationDuration: '3s' }}
                />
                <p className="text-sm text-content-secondary">No uploads found.</p>
              </div>
            ) : (
              uploads.map((upload) => (
                <div key={upload.id} className="px-4 py-2.5 border-b border-border/50 grid grid-cols-12 gap-2 items-center hover:bg-surface-secondary transition-colors">
                  <div className="col-span-1">
                    <FileUp size={16} className="text-content-secondary" />
                  </div>
                  <div className="col-span-3 text-sm text-content-primary font-medium truncate" title={upload.file_name}>
                    {upload.file_name}
                  </div>
                  <div className="col-span-2 text-xs text-content-secondary truncate font-mono">{upload.view_name || '-'}</div>
                  <div className="col-span-1 text-xs text-content-secondary">{formatBytes(upload.size_bytes)}</div>
                  <div className="col-span-2 text-xs text-content-secondary truncate flex items-center gap-1">
                    {upload.uploaded_by_user ? (
                      <>
                        <User size={10} className="flex-shrink-0" />
                        {upload.uploaded_by_user.name}
                      </>
                    ) : '-'}
                  </div>
                  <div className="col-span-3 text-xs text-content-secondary">{formatDate(upload.updated_at)}</div>
                </div>
              ))
            )}
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-2 px-4 py-2.5 border-t border-border bg-surface-secondary">
              <button onClick={() => setPage(Math.max(1, page - 1))} disabled={page <= 1} className="btn-secondary text-xs px-3 py-1.5">Previous</button>
              <span className="text-xs text-content-secondary">Page {page} of {totalPages}</span>
              <button onClick={() => setPage(page + 1)} disabled={!pageInfo?.hasNextPage} className="btn-secondary text-xs px-3 py-1.5">Next</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
