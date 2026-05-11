import { useEffect, useRef, useState } from 'react';
import { Check } from 'lucide-react';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import { useConfetti } from '@/hooks/useConfetti';
import { Blobby } from './Blobby';
import { Vehicle } from './Vehicle';

interface DownloadAnimationProps {
  status: string | null;
  success: boolean;
  format?: string;
}

function Cloud({ left, top, size, delay }: { left: number; top: number; size: number; delay: number }) {
  return (
    <div
      className="absolute rounded-full bg-white/85"
      style={{
        left: `${left}%`,
        top: `${top}%`,
        width: size,
        height: size * 0.45,
        animation: `float ${4 + delay}s ${delay}s ease-in-out infinite`,
        filter: 'blur(0.5px)',
      }}
    />
  );
}

export function DownloadAnimation({ status, success, format }: DownloadAnimationProps) {
  const reduced = useReducedMotion();
  const fireConfetti = useConfetti();
  const firedRef = useRef(false);
  const [progress, setProgress] = useState(20);

  useEffect(() => {
    if (!status || success) return;
    if (reduced) {
      setProgress(65);
      return;
    }
    const id = window.setInterval(() => {
      setProgress((p) => (p >= 80 ? 25 : p + 3));
    }, 220);
    return () => window.clearInterval(id);
  }, [status, success, reduced]);

  useEffect(() => {
    if (success && !firedRef.current) {
      firedRef.current = true;
      fireConfetti({ count: 60, originY: 0.5, spread: 60 });
    }
    if (!success) firedRef.current = false;
  }, [success, fireConfetti]);

  if (!status && !success) return null;

  if (success) {
    return (
      <div
        className="rounded-2xl p-5 flex items-center gap-4 animate-fadeIn"
        style={{
          background: 'linear-gradient(135deg, rgba(16,185,129,0.08) 0%, rgba(255,71,148,0.05) 100%)',
          border: '1px solid rgba(16,185,129,0.28)',
        }}
      >
        <div className="relative flex-shrink-0">
          <Blobby mood="celebrating" size={72} className={reduced ? '' : 'animate-wiggle-infinite'} />
          <div
            className="absolute -bottom-1 -right-1 w-7 h-7 rounded-full flex items-center justify-center"
            style={{
              background: 'linear-gradient(135deg, #047857, #10B981)',
              boxShadow: '0 2px 8px rgba(16,185,129,0.4)',
              animation: reduced ? undefined : 'stampIn 500ms cubic-bezier(0.22, 1, 0.36, 1) forwards',
            }}
          >
            <Check size={14} strokeWidth={3} className="text-white" />
          </div>
        </div>
        <div className="min-w-0">
          <div className="text-[16px] font-bold text-content-primary leading-tight">
            {format ? `${format.toUpperCase()} package delivered!` : 'Package delivered!'}
          </div>
          <div className="text-[12px] text-content-secondary mt-1 truncate">
            Blobby stuck the landing — check your downloads folder.
          </div>
        </div>
      </div>
    );
  }

  const descent = Math.min(80, Math.max(5, progress));

  return (
    <div
      className="relative overflow-hidden rounded-2xl p-5 animate-fadeIn"
      style={{
        background: 'linear-gradient(180deg, #DCEEFF 0%, #FFF8FB 85%)',
        border: '1px solid rgba(242,190,214,0.8)',
        boxShadow: '0 1px 4px rgba(200,24,100,0.06), 0 4px 16px rgba(200,24,100,0.04)',
      }}
      aria-live="polite"
    >
      <div className="flex gap-4">
        <div className="relative flex-shrink-0" style={{ width: 120, height: 160 }}>
          <Cloud left={5} top={6} size={38} delay={0} />
          <Cloud left={58} top={16} size={28} delay={0.6} />
          <Cloud left={22} top={28} size={22} delay={1.2} />

          <div
            className="absolute left-1/2 -translate-x-1/2"
            style={{
              top: `${descent}%`,
              transition: reduced ? 'none' : 'top 700ms cubic-bezier(0.22, 1, 0.36, 1)',
            }}
          >
            <div className="relative">
              <Vehicle kind="parachute" width={68} height={84} />
              <Blobby
                mood="download"
                size={30}
                className="absolute left-1/2 -translate-x-1/2"
                style={{ top: 54 }}
              />
              {format && (
                <span
                  className="absolute -right-2 top-16 text-[9px] font-bold uppercase tracking-wider px-1.5 py-0.5 rounded"
                  style={{
                    background: '#FFFFFF',
                    color: '#C8186A',
                    border: '1px solid #F2BED6',
                    boxShadow: '0 1px 3px rgba(200,24,100,0.15)',
                  }}
                >
                  {format}
                </span>
              )}
            </div>
          </div>

          <div className="absolute bottom-0 left-0 right-0 flex justify-center">
            <svg width="80" height="24" viewBox="0 0 80 24">
              <rect x="8" y="4" width="64" height="12" rx="2" fill="#FFFFFF" stroke="#C8186A" strokeWidth="1.2" />
              <rect x="12" y="7" width="56" height="6" rx="1" fill="#FFE8F2" />
              <rect x="2" y="16" width="76" height="3" rx="1.5" fill="#C8186A" opacity="0.85" />
              <circle cx="40" cy="10" r="1.5" fill="#C8186A" />
            </svg>
          </div>
        </div>

        <div className="flex-1 min-w-0 flex flex-col justify-center">
          <div className="text-[11px] font-bold uppercase tracking-widest text-content-tertiary mb-1">
            Inbound delivery
          </div>
          <div className="text-[15px] font-semibold text-content-primary leading-tight">
            {status || 'Blobby is packing your download'}
          </div>
          <div className="text-[12px] text-content-secondary mt-2 flex items-center gap-1.5">
            <span className={`w-1.5 h-1.5 rounded-full bg-omni-500 ${reduced ? '' : 'animate-pulse'}`} />
            <span>Keep this tab open — the parachute is still in the air.</span>
          </div>
        </div>
      </div>
    </div>
  );
}
