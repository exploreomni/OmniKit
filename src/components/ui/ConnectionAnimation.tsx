import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useReducedMotion } from '@/hooks/useReducedMotion';
import { Blobby } from './Blobby';

interface ConnectionAnimationProps {
  status: 'untested' | 'testing' | 'success' | 'error';
}

const confettiConfig = [
  { color: '#C83B70', shape: 'circle' },
  { color: '#FF7CA4', shape: 'rect' },
  { color: '#FBBF24', shape: 'circle' },
  { color: '#34D399', shape: 'rect' },
  { color: '#60A5FA', shape: 'circle' },
  { color: '#F472B6', shape: 'rect' },
  { color: '#FB923C', shape: 'circle' },
  { color: '#4ADE80', shape: 'rect' },
  { color: '#38BDF8', shape: 'circle' },
  { color: '#FDE68A', shape: 'rect' },
  { color: '#C084FC', shape: 'circle' },
  { color: '#6EE7B7', shape: 'rect' },
];

function RippleRing({ delay, scale }: { delay: number; scale: number }) {
  return (
    <span
      className="absolute rounded-full border-2 border-omni-400/50"
      style={{
        inset: `${scale}px`,
        animation: `ripple 2.2s ${delay}s ease-out infinite`,
        transformOrigin: 'center',
      }}
    />
  );
}

function ConfettiPiece({ x, y, delay, color, shape, size }: {
  x: number; y: number; delay: number; color: string; shape: string; size: number;
}) {
  return (
    <span
      className="absolute pointer-events-none"
      style={{
        left: `${x}%`,
        top: `${y}%`,
        width: size,
        height: shape === 'rect' ? size * 0.5 : size,
        borderRadius: shape === 'circle' ? '50%' : 2,
        background: color,
        animation: `sparkle ${1.3 + delay * 0.3}s ${delay * 0.1}s ease-in-out infinite`,
      }}
    />
  );
}

function OrbitSignal({ angle, delay }: { angle: number; delay: number }) {
  const rad = (angle * Math.PI) / 180;
  const r = 52;
  const x = Math.cos(rad) * r;
  const y = Math.sin(rad) * r;
  return (
    <span
      className="absolute rounded-full"
      style={{
        width: 6,
        height: 6,
        left: `calc(50% + ${x}px - 3px)`,
        top: `calc(50% + ${y}px - 3px)`,
        background: '#C83B70',
        boxShadow: 'none',
        animation: `float ${1.4 + delay}s ${delay * 0.4}s ease-in-out infinite`,
      }}
    />
  );
}

function ConnectionSceneShell({
  status,
  children,
  showBurst,
}: {
  status: ConnectionAnimationProps['status'];
  children: ReactNode;
  showBurst?: boolean;
}) {
  return (
    <div className={`connection-scene connection-scene-${status}`}>
      <div className="connection-node connection-node-kit">Kit</div>
      <div className="connection-node connection-node-omni">Omni</div>
      <div className="connection-line" aria-hidden>
        <span className="connection-pulse-request" />
        <span className="connection-pulse-response" />
      </div>
      {status === 'testing' && (
        <div className="connection-data-stream" aria-hidden>
          {[0, 1, 2].map((i) => (
            <span key={i} className="connection-data-packet" style={{ animationDelay: `${i * 420}ms` }} />
          ))}
        </div>
      )}
      {status === 'success' && <span className="connection-success-check" aria-hidden>✓</span>}
      {showBurst && <span className="connection-burst" aria-hidden />}
      {children}
    </div>
  );
}

export function ConnectionAnimation({ status }: ConnectionAnimationProps) {
  const [showBurst, setShowBurst] = useState(false);
  const reduced = useReducedMotion();

  useEffect(() => {
    if (status === 'success') {
      setShowBurst(true);
      const t = setTimeout(() => setShowBurst(false), 1000);
      return () => clearTimeout(t);
    }
  }, [status]);

  if (status === 'untested') {
    return (
      <div className="flex flex-col items-center py-10 animate-fadeIn">
        <ConnectionSceneShell status="untested">
          <Blobby mood="connections" size={82} className={reduced ? '' : 'animate-float'} style={{ animationDuration: '3.4s' }} />
        </ConnectionSceneShell>
        <p className="text-base font-semibold text-content-primary mt-3">Ready to test</p>
        <p className="text-sm text-content-secondary mt-1">Connect OmniKit to your Omni instance</p>
      </div>
    );
  }

  if (status === 'testing') {
    return (
      <div className="flex flex-col items-center py-10 animate-fadeIn">
        <ConnectionSceneShell status="testing">
          {[0, 1, 2, 3].map((i) => (
            <RippleRing key={i} delay={i * 0.55} scale={1 + i * 0.5} />
          ))}

          {[0, 60, 120, 180, 240, 300].map((angle, i) => (
            <OrbitSignal key={i} angle={angle} delay={i * 0.2} />
          ))}

          <div
            className="absolute inset-0 rounded-full"
            style={{
	              background: 'transparent',
            }}
          />

          <Blobby mood="in-progress" size={96} className={reduced ? 'z-10' : 'z-10 animate-float'} style={{ animationDuration: '2s' }} />
        </ConnectionSceneShell>
        <p className="text-base font-semibold text-content-primary mt-3">Testing connection...</p>
        <p className="text-sm text-content-secondary mt-1">Checking credentials and reachability</p>
      </div>
    );
  }

  if (status === 'success') {
    return (
      <div className="flex flex-col items-center py-10 animate-fadeIn">
        <ConnectionSceneShell status="success" showBurst={showBurst}>
          <span
            className="absolute rounded-full border-2 border-green-400/30"
            style={{
              width: 130,
              height: 130,
              animation: 'ripple 2.5s 0s ease-out infinite',
            }}
          />
          <span
            className="absolute rounded-full border-2 border-green-400/20"
            style={{
              width: 130,
              height: 130,
              animation: 'ripple 2.5s 1.25s ease-out infinite',
            }}
          />

          <div
            className="absolute inset-0 rounded-full"
            style={{
	              background: 'transparent',
            }}
          />

          {confettiConfig.map((c, i) => (
            <ConfettiPiece
              key={i}
              color={c.color}
              shape={c.shape}
              x={10 + (i % 6) * 16}
              y={5 + Math.sin(i * 1.1) * 50}
              delay={i * 0.1}
              size={5 + (i % 3) * 2}
            />
          ))}

          <Blobby mood="success" size={112} className={reduced ? 'z-10' : 'z-10 animate-wiggle-infinite'} />
        </ConnectionSceneShell>
        <p className="text-base font-bold text-green-600 mt-3">Connection successful!</p>
        <p className="text-sm text-content-secondary mt-1">Your instance is ready to use</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-center py-10 animate-fadeIn">
      <ConnectionSceneShell status="error">
        <span
          className="absolute rounded-full border-2 border-red-400/30"
          style={{
            width: 130,
            height: 130,
            animation: 'ripple 2s ease-out infinite',
          }}
        />
        <div
          className="absolute inset-0 rounded-full"
          style={{
	            background: 'transparent',
          }}
        />
        <div className="animate-shake z-10">
          <Blobby mood="error" size={112} />
        </div>
      </ConnectionSceneShell>
      <p className="text-base font-bold text-red-600 mt-3">Connection failed</p>
      <p className="text-sm text-content-secondary mt-1">Check your URL and credentials</p>
    </div>
  );
}
