import { useEffect } from 'react';

export type BlobbyMood =
  | 'rocket'
  | 'migration'
  | 'celebrating'
  | 'success'
  | 'in-progress'
  | 'thinking'
  | 'error'
  | 'sad'
  | 'warning'
  | 'waving'
  | 'download'
  | 'upload'
  | 'ready'
  | 'skipped'
  | 'pending';

const MOOD_TO_SRC: Record<BlobbyMood, string> = {
  rocket: '/blobby-rocket.webp',
  migration: '/blobby-migration.webp',
  celebrating: '/blobby-celebrating.webp',
  success: '/blobby-success.webp',
  'in-progress': '/blobby-in-progress.webp',
  thinking: '/blobby-thinking.webp',
  error: '/blobby-error.webp',
  sad: '/blobby-sad.webp',
  warning: '/blobby-warning.webp',
  waving: '/blobby-waving.webp',
  download: '/blobby-download.webp',
  upload: '/blobby-upload.webp',
  ready: '/blobby-ready.webp',
  skipped: '/blobby-skipped.webp',
  pending: '/blobby-pending.webp',
};

interface BlobbyProps {
  mood: BlobbyMood;
  size?: number;
  className?: string;
  style?: React.CSSProperties;
  alt?: string;
}

export function Blobby({ mood, size = 48, className = '', style, alt }: BlobbyProps) {
  return (
    <img
      src={MOOD_TO_SRC[mood]}
      alt={alt ?? `Blobby ${mood}`}
      width={size}
      height={size}
      className={`select-none pointer-events-none object-contain ${className}`}
      style={{ width: size, height: size, ...style }}
      draggable={false}
    />
  );
}

let preloaded = false;
export function usePreloadBlobby() {
  useEffect(() => {
    if (preloaded || typeof window === 'undefined') return;
    preloaded = true;
    for (const src of Object.values(MOOD_TO_SRC)) {
      const img = new Image();
      img.src = src;
    }
  }, []);
}
