import { ArrowRight, LockKeyhole, Plug, ShieldCheck, Sparkles } from 'lucide-react';
import { useConnection } from '@/contexts/ConnectionContext';
import { useLocation, useNavigate } from 'react-router-dom';
import { hasActiveSavedVaultConnection } from '@/services/connectionGuards';

const protectedToolNames: Record<string, string> = {
  '/dashboards/ai-studio': 'AI Dashboard Studio',
  '/dashboards/migrate': 'Dashboard Migrator',
  '/dashboards/operations': 'Dashboard Operations',
  '/dashboards/downloads': 'Dashboard Downloads',
  '/deck-builder': 'Deck Builder',
  '/connections': 'Connection Health',
  '/uploads': 'Upload Governance',
  '/users': 'User Management',
  '/groups': 'User Management',
  '/models/migrate': 'Model Migrator',
  '/models': 'Model & Topic Health',
  '/topics': 'AI Semantic Studio',
  '/labels': 'Labels',
  '/content-health': 'Content Health',
  '/schedules': 'Schedules',
  '/embeds': 'Embed URLs',
};

const assuranceItems = [
  { icon: ShieldCheck, label: 'Plaintext keys stay in the local vault' },
  { icon: Sparkles, label: 'One saved instance unlocks every workflow' },
  { icon: LockKeyhole, label: 'API calls run only when you start an action' },
];

interface SavedInstanceRequiredEmptyStateProps {
  toolName?: string;
  description?: string;
  ctaLabel?: string;
  onCta?: () => void;
}

export function SavedInstanceRequiredEmptyState({
  toolName = 'this OmniKit workflow',
  description = 'Unlock your local vault on Home, then choose the saved Omni instance this workflow should use.',
  ctaLabel = 'Go to Home',
  onCta,
}: SavedInstanceRequiredEmptyStateProps) {
  const navigate = useNavigate();

  return (
    <div
      className="relative flex flex-col items-center justify-center animate-fadeIn px-4"
      style={{ minHeight: 'calc(100vh - 3rem)' }}
    >
      <div
        className="absolute inset-0 pointer-events-none"
        style={{
          backgroundImage: 'none',
          backgroundSize: '28px 28px',
        }}
      />

      <div
        className="absolute top-0 left-1/2 h-1 w-full max-w-4xl -translate-x-1/2 rounded-full pointer-events-none"
        style={{
          background: '#DDE2EB',
          opacity: 1,
        }}
      />

      <div
        className="relative z-10 flex flex-col items-center text-center px-8 py-9 rounded-2xl max-w-md w-full mx-auto"
        style={{
          background: '#FFFFFF',
          border: '1px solid rgba(217,222,232,0.95)',
          boxShadow: 'none',
        }}
      >
        <div className="empty-state-mascot mb-1">
          <img
            src="/blobby-getting-started.png"
            alt="Blobby ready to help"
            className="w-24 h-24 object-contain animate-float"
            style={{ animationDuration: '3s' }}
          />
        </div>

        <div className="inline-flex items-center gap-1.5 rounded-chip bg-omni-50 px-2.5 py-1 text-[11px] font-semibold text-omni-700 border border-omni-200 mb-3">
          <Plug size={12} />
          Saved instance required
        </div>

        <h2 className="text-xl font-bold text-content-primary mb-2 tracking-tight">
          Choose an instance to unlock {toolName}
        </h2>
        <p className="text-sm text-content-secondary mb-5 leading-relaxed max-w-sm">
          {description}
        </p>

        <div className="grid w-full gap-2 mb-6 text-left">
          {assuranceItems.map(({ icon: Icon, label }) => (
            <div
              key={label}
              className="flex items-center gap-2 rounded-button border border-border bg-white px-3 py-2 text-xs text-content-secondary"
            >
              <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-button bg-omni-50 text-omni-700">
                <Icon size={13} />
              </span>
              <span>{label}</span>
            </div>
          ))}
        </div>

        <button
          onClick={onCta || (() => navigate('/'))}
          className="btn-primary w-full justify-center"
        >
          {ctaLabel}
          <ArrowRight size={14} />
        </button>
      </div>
    </div>
  );
}

export function RequireConnection({ children }: { children: React.ReactNode }) {
  const { connection } = useConnection();
  const location = useLocation();
  const toolName = protectedToolNames[location.pathname] || 'this OmniKit workflow';

  if (!hasActiveSavedVaultConnection(connection)) {
    return (
      <SavedInstanceRequiredEmptyState
        toolName={toolName}
        description="Unlock your local vault on Home, then choose and test the saved Omni instance this workflow should use."
      />
    );
  }

  return <>{children}</>;
}
