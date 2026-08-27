import { OMNIKIT_BUILD_INFO } from '@/services/buildInfo';
import { instanceConnectionDiagnosticFromState } from '@/services/instanceConnectionDiagnostics';

interface ConnectionFailureDetailsProps {
  message: string;
  code?: string;
  compact?: boolean;
  tone?: 'light' | 'inverse';
}

export function ConnectionFailureDetails({
  message,
  code,
  compact = false,
  tone = 'light',
}: ConnectionFailureDetailsProps) {
  const diagnostic = instanceConnectionDiagnosticFromState(message, code);
  const inverse = tone === 'inverse';
  return (
    <div
      className={inverse
        ? 'rounded-[7px] border border-white/25 bg-black/15 px-3 py-2 text-white'
        : 'border-l-2 border-red-500 bg-red-50 px-2.5 py-2 text-red-800'}
      role="alert"
    >
      <p className={compact ? 'text-[11px] leading-4' : 'text-xs leading-5'}>{diagnostic.message}</p>
      <p className={`mt-1 font-mono ${compact ? 'text-[9px]' : 'text-[10px]'} ${inverse ? 'text-white/70' : 'text-red-700'}`}>
        {diagnostic.code ? `Code ${diagnostic.code} · ` : ''}{OMNIKIT_BUILD_INFO.label}
      </p>
      {diagnostic.guidance && (
        <p className={`mt-1 ${compact ? 'text-[10px] leading-4' : 'text-[11px] leading-5'} ${inverse ? 'text-white/80' : 'text-red-700'}`}>
          {diagnostic.guidance}
        </p>
      )}
    </div>
  );
}
