import { useCallback } from 'react';

const COLORS = ['#C8186A', '#FF4794', '#FBBF24', '#10B981', '#60A5FA', '#F472B6'];

interface ConfettiOptions {
  count?: number;
  spread?: number;
  originY?: number;
  durationMs?: number;
}

export function useConfetti() {
  return useCallback((opts: ConfettiOptions = {}) => {
    if (typeof window === 'undefined') return;
    const prefersReduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (prefersReduced) return;

    const count = opts.count ?? 80;
    const duration = opts.durationMs ?? 1800;
    const spread = opts.spread ?? 70;
    const originY = opts.originY ?? 0.35;

    const canvas = document.createElement('canvas');
    canvas.style.position = 'fixed';
    canvas.style.inset = '0';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.pointerEvents = 'none';
    canvas.style.zIndex = '9999';
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    document.body.appendChild(canvas);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      canvas.remove();
      return;
    }

    type Piece = {
      x: number; y: number; vx: number; vy: number;
      rot: number; vr: number; size: number; color: string; shape: 'rect' | 'circle';
    };
    const pieces: Piece[] = Array.from({ length: count }, () => {
      const angle = ((Math.random() - 0.5) * spread * Math.PI) / 180 - Math.PI / 2;
      const speed = 6 + Math.random() * 6;
      return {
        x: canvas.width / 2,
        y: canvas.height * originY,
        vx: Math.cos(angle) * speed + (Math.random() - 0.5) * 2,
        vy: Math.sin(angle) * speed,
        rot: Math.random() * Math.PI * 2,
        vr: (Math.random() - 0.5) * 0.3,
        size: 4 + Math.random() * 6,
        color: COLORS[Math.floor(Math.random() * COLORS.length)],
        shape: Math.random() > 0.5 ? 'rect' : 'circle',
      };
    });

    const start = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const t = now - start;
      if (t > duration) {
        canvas.remove();
        cancelAnimationFrame(raf);
        return;
      }
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      for (const p of pieces) {
        p.vy += 0.18;
        p.vx *= 0.995;
        p.x += p.vx;
        p.y += p.vy;
        p.rot += p.vr;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot);
        ctx.globalAlpha = Math.max(0, 1 - t / duration);
        ctx.fillStyle = p.color;
        if (p.shape === 'rect') {
          ctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
        } else {
          ctx.beginPath();
          ctx.arc(0, 0, p.size / 2, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  }, []);
}
