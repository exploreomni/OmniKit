import { ArrowRight } from 'lucide-react';
import { useConnection } from '@/contexts/ConnectionContext';
import { useNavigate } from 'react-router-dom';

export function RequireConnection({ children }: { children: React.ReactNode }) {
  const { isConnected } = useConnection();
  const navigate = useNavigate();

  if (!isConnected) {
    return (
      <div
        className="relative flex flex-col items-center justify-center animate-fadeIn"
        style={{ minHeight: 'calc(100vh - 3rem)' }}
      >
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            backgroundImage: `radial-gradient(circle, rgba(255,71,148,0.07) 1px, transparent 1px)`,
            backgroundSize: '28px 28px',
          }}
        />

        <div
          className="absolute top-0 left-0 right-0 h-1 pointer-events-none"
          style={{
            background: 'linear-gradient(90deg, #FF4794 0%, #E02C80 50%, #FF4794 100%)',
            opacity: 0.6,
          }}
        />

        <div
          className="relative z-10 flex flex-col items-center text-center px-8 py-10 rounded-2xl max-w-sm w-full mx-auto"
          style={{
            background: 'rgba(255,255,255,0.92)',
            border: '1px solid rgba(255,71,148,0.18)',
            boxShadow: '0 4px 24px rgba(200,24,106,0.08), 0 1px 4px rgba(200,24,106,0.06)',
            backdropFilter: 'blur(8px)',
          }}
        >
          <div className="empty-state-mascot mb-2">
            <img
              src="/blobby-getting-started.webp"
              alt="Blobby ready to help"
              className="w-24 h-24 object-contain animate-float"
              style={{ animationDuration: '3s' }}
            />
          </div>

          <h2 className="text-lg font-bold text-content-primary mb-2 tracking-tight">
            Let's get connected first
          </h2>
          <p className="text-sm text-content-secondary mb-1.5 leading-relaxed">
            You need to connect to your Omni instance before using this tool.
          </p>
          <p className="text-xs mb-7 leading-relaxed" style={{ color: 'rgba(155,48,101,0.55)' }}>
            Select a tool from the sidebar to get started once connected.
          </p>

          <button
            onClick={() => navigate('/connect')}
            className="btn-primary"
          >
            Go to Connect
            <ArrowRight size={14} />
          </button>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
