import { useState, useMemo } from 'react';
import { ChevronDown, ChevronUp, ChevronsUpDown, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight, Loader2 } from 'lucide-react';

export interface Column<T> {
  key: string;
  label: string;
  sortable?: boolean;
  className?: string;
  numeric?: boolean;
  render?: (row: T) => React.ReactNode;
}

interface DataTableProps<T> {
  columns: Column<T>[];
  data: T[];
  loading?: boolean;
  emptyMessage?: string;
  emptyIcon?: React.ReactNode;
  keyField?: string;
  pageSize?: number;
  maxHeight?: string;
  onRowClick?: (row: T) => void;
  expandedContent?: (row: T) => React.ReactNode;
  serverPagination?: {
    page: number;
    totalPages: number;
    totalRecords: number;
    onPageChange: (page: number) => void;
  };
}

export function DataTable<T extends Record<string, unknown>>({
  columns,
  data,
  loading,
  emptyMessage = 'No data found.',
  emptyIcon,
  keyField = 'id',
  pageSize = 25,
  maxHeight,
  onRowClick,
  expandedContent,
  serverPagination,
}: DataTableProps<T>) {
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');
  const [clientPage, setClientPage] = useState(1);
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set());

  const resolvedMaxHeight = maxHeight || 'calc(100vh - 320px)';

  const sortedData = useMemo(() => {
    if (!sortKey || serverPagination) return data;
    return [...data].sort((a, b) => {
      const aVal = a[sortKey];
      const bVal = b[sortKey];
      if (aVal == null && bVal == null) return 0;
      if (aVal == null) return 1;
      if (bVal == null) return -1;
      const cmp = String(aVal).localeCompare(String(bVal), undefined, { numeric: true });
      return sortDir === 'asc' ? cmp : -cmp;
    });
  }, [data, sortKey, sortDir, serverPagination]);

  const paginatedData = useMemo(() => {
    if (serverPagination) return sortedData;
    const start = (clientPage - 1) * pageSize;
    return sortedData.slice(start, start + pageSize);
  }, [sortedData, clientPage, pageSize, serverPagination]);

  const totalPages = serverPagination?.totalPages ?? Math.max(1, Math.ceil(data.length / pageSize));
  const currentPage = serverPagination?.page ?? clientPage;

  function handleSort(key: string) {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  }

  function handlePageChange(page: number) {
    if (serverPagination) {
      serverPagination.onPageChange(page);
    } else {
      setClientPage(page);
    }
  }

  function toggleRow(key: string) {
    setExpandedRows((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  function SortIcon({ colKey }: { colKey: string }) {
    if (sortKey !== colKey) {
      return <ChevronsUpDown size={12} className="text-content-secondary/30" />;
    }
    return sortDir === 'asc'
      ? <ChevronUp size={12} className="text-omni-700" />
      : <ChevronDown size={12} className="text-omni-700" />;
  }

  return (
    <div className="card p-0 overflow-hidden">
      <div
        className="px-4 py-3 border-b border-border flex gap-2"
        style={{ background: '#F8F9FD' }}
      >
        {columns.map((col) => (
          <div
            key={col.key}
            className={`text-[10px] font-bold text-content-secondary uppercase tracking-wider flex items-center gap-1 flex-1 min-w-0 ${col.numeric ? 'justify-end' : ''} ${col.className || ''} ${col.sortable ? 'cursor-pointer select-none hover:text-omni-700 transition-colors' : ''}`}
            onClick={col.sortable ? () => handleSort(col.key) : undefined}
          >
            <span className="truncate">{col.label}</span>
            {col.sortable && <SortIcon colKey={col.key} />}
          </div>
        ))}
      </div>

      <div className="overflow-y-auto" style={{ maxHeight: resolvedMaxHeight }}>
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 size={24} className="text-omni-500 animate-spin" />
          </div>
        ) : paginatedData.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-content-secondary text-sm gap-2">
            {emptyIcon}
            <span>{emptyMessage}</span>
          </div>
        ) : (
          paginatedData.map((row) => {
            const rowKey = String(row[keyField] ?? '');
            const isExpanded = expandedRows.has(rowKey);
            return (
              <div key={rowKey}>
                <div
                  className={`px-4 py-3 border-b border-border/50 flex gap-2 items-center transition-colors ${onRowClick || expandedContent ? 'cursor-pointer hover:bg-surface-secondary' : 'hover:bg-surface-secondary'}`}
                  onClick={() => {
                    if (expandedContent) toggleRow(rowKey);
                    else if (onRowClick) onRowClick(row);
                  }}
                >
                  {columns.map((col) => (
                    <div key={col.key} className={`flex-1 min-w-0 text-sm ${col.numeric ? 'text-right tabular-nums' : ''} ${col.className || ''}`}>
                      {col.render ? col.render(row) : (
                        <span className="truncate block text-content-primary">
                          {row[col.key] != null ? String(row[col.key]) : '-'}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
                {expandedContent && isExpanded && (
                  <div className="px-4 py-3 bg-surface-secondary border-b border-border/50 animate-fadeIn">
                    {expandedContent(row)}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {(totalPages > 1 || data.length > 0) && (
        <div className="flex items-center justify-between px-4 py-3 border-t border-border bg-white">
          <span className="text-xs text-content-secondary tabular-nums">
            {serverPagination
              ? `${serverPagination.totalRecords.toLocaleString()} total records`
              : `${data.length.toLocaleString()} total records`}
          </span>
          {totalPages > 1 && (
            <div className="flex items-center gap-1">
              <button
                onClick={() => handlePageChange(1)}
                disabled={currentPage <= 1}
                className="p-1 text-content-secondary hover:text-content-primary disabled:opacity-30 transition-colors"
                aria-label="First page"
              >
                <ChevronsLeft size={14} />
              </button>
              <button
                onClick={() => handlePageChange(currentPage - 1)}
                disabled={currentPage <= 1}
                className="p-1 text-content-secondary hover:text-content-primary disabled:opacity-30 transition-colors"
                aria-label="Previous page"
              >
                <ChevronLeft size={14} />
              </button>
              <span className="text-xs text-content-secondary px-2 tabular-nums">
                {currentPage} / {totalPages}
              </span>
              <button
                onClick={() => handlePageChange(currentPage + 1)}
                disabled={currentPage >= totalPages}
                className="p-1 text-content-secondary hover:text-content-primary disabled:opacity-30 transition-colors"
                aria-label="Next page"
              >
                <ChevronRight size={14} />
              </button>
              <button
                onClick={() => handlePageChange(totalPages)}
                disabled={currentPage >= totalPages}
                className="p-1 text-content-secondary hover:text-content-primary disabled:opacity-30 transition-colors"
                aria-label="Last page"
              >
                <ChevronsRight size={14} />
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
