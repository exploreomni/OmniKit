import { useState } from 'react';
import { XCircle, ChevronDown, ChevronRight } from 'lucide-react';

interface ErrorBannerProps {
  title?: string;
  message: string;
  detail?: string;
}

export function ErrorBanner({ title = 'Something went wrong', message, detail }: ErrorBannerProps) {
  const [showDetail, setShowDetail] = useState(false);

  return (
    <div className="flex items-start gap-3 px-4 py-3 bg-red-50 border border-red-200 rounded-card">
      <XCircle size={16} className="text-red-600 mt-0.5 flex-shrink-0" />
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium text-red-800">{title}</p>
        <p className="text-xs text-red-700 mt-0.5 leading-relaxed">{message}</p>
        {detail && (
          <>
            <button
              onClick={() => setShowDetail(!showDetail)}
              className="flex items-center gap-1 text-[11px] text-red-500 hover:text-red-700 mt-1.5 transition-colors"
            >
              {showDetail ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              Technical details
            </button>
            {showDetail && (
              <pre className="mt-1.5 text-[11px] text-red-600 font-mono bg-red-100/60 rounded px-2 py-1.5 overflow-auto max-h-32 whitespace-pre-wrap">
                {detail}
              </pre>
            )}
          </>
        )}
      </div>
    </div>
  );
}
