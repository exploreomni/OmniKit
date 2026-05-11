export type VehicleKind =
  | 'jet'
  | 'truck'
  | 'copier'
  | 'crane'
  | 'parachute'
  | 'f1'
  | 'sailboat';

interface VehicleProps {
  kind: VehicleKind;
  width?: number;
  height?: number;
  className?: string;
  style?: React.CSSProperties;
}

export function Vehicle({ kind, width = 72, height = 48, className = '', style }: VehicleProps) {
  switch (kind) {
    case 'jet':
      return (
        <svg viewBox="0 0 120 60" width={width} height={height} className={className} style={style}>
          <defs>
            <linearGradient id="jetBody" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#FFFFFF" />
              <stop offset="100%" stopColor="#F2BED6" />
            </linearGradient>
            <linearGradient id="jetAccent" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#C8186A" />
              <stop offset="100%" stopColor="#FF4794" />
            </linearGradient>
          </defs>
          <path d="M8 32 Q30 24 72 26 L102 28 Q112 30 108 34 L72 36 Q30 36 10 36 Z" fill="url(#jetBody)" stroke="#C8186A" strokeWidth="1.5" />
          <path d="M30 28 L22 14 L40 26 Z" fill="url(#jetAccent)" />
          <path d="M36 36 L28 48 L48 38 Z" fill="url(#jetAccent)" opacity="0.85" />
          <circle cx="86" cy="30" r="2.2" fill="#FF4794" />
          <circle cx="78" cy="30" r="2.2" fill="#FF4794" />
          <circle cx="70" cy="30" r="2.2" fill="#FF4794" />
          <path d="M100 32 L110 24 L108 34 Z" fill="url(#jetAccent)" />
        </svg>
      );
    case 'truck':
      return (
        <svg viewBox="0 0 120 60" width={width} height={height} className={className} style={style}>
          <defs>
            <linearGradient id="truckBox" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#FFE8F2" />
              <stop offset="100%" stopColor="#F9CCE0" />
            </linearGradient>
          </defs>
          <rect x="8" y="16" width="58" height="28" rx="3" fill="url(#truckBox)" stroke="#C8186A" strokeWidth="1.5" />
          <path d="M12 22 L62 22 M12 28 L62 28 M12 34 L62 34" stroke="#E590BA" strokeWidth="1" opacity="0.6" />
          <path d="M66 22 L88 22 L100 32 L100 44 L66 44 Z" fill="#FFFFFF" stroke="#C8186A" strokeWidth="1.5" />
          <rect x="70" y="25" width="14" height="10" rx="1.5" fill="#BDE7FF" stroke="#4FA3D1" strokeWidth="1" />
          <circle cx="26" cy="48" r="6" fill="#2D2D2D" />
          <circle cx="26" cy="48" r="2.5" fill="#8A8A8A" />
          <circle cx="82" cy="48" r="6" fill="#2D2D2D" />
          <circle cx="82" cy="48" r="2.5" fill="#8A8A8A" />
        </svg>
      );
    case 'copier':
      return (
        <svg viewBox="0 0 120 80" width={width} height={height} className={className} style={style}>
          <rect x="14" y="20" width="82" height="38" rx="4" fill="#FFE8F2" stroke="#C8186A" strokeWidth="1.5" />
          <rect x="22" y="28" width="42" height="4" rx="1" fill="#FF4794" />
          <circle cx="82" cy="38" r="3" fill="#10B981" />
          <circle cx="82" cy="48" r="3" fill="#F59E0B" />
          <rect x="30" y="44" width="50" height="10" rx="1.5" fill="#FFFFFF" stroke="#C8186A" strokeWidth="1" />
          <rect x="38" y="8" width="30" height="12" rx="1.5" fill="#FFFFFF" stroke="#C8186A" strokeWidth="1.5" />
          <rect x="42" y="58" width="24" height="6" rx="1" fill="#FFFFFF" stroke="#C8186A" strokeWidth="1" />
          <rect x="46" y="64" width="24" height="6" rx="1" fill="#FFFFFF" stroke="#C8186A" strokeWidth="1" />
        </svg>
      );
    case 'crane':
      return (
        <svg viewBox="0 0 120 80" width={width} height={height} className={className} style={style}>
          <rect x="14" y="50" width="46" height="18" rx="2" fill="#FFD27A" stroke="#B45309" strokeWidth="1.5" />
          <rect x="20" y="54" width="14" height="10" rx="1" fill="#BDE7FF" stroke="#4FA3D1" strokeWidth="1" />
          <circle cx="24" cy="72" r="5" fill="#2D2D2D" />
          <circle cx="50" cy="72" r="5" fill="#2D2D2D" />
          <path d="M60 50 L96 14" stroke="#B45309" strokeWidth="3" strokeLinecap="round" />
          <line x1="88" y1="22" x2="88" y2="40" stroke="#6B7280" strokeWidth="1.5" />
          <path d="M82 40 L94 40 L92 48 L84 48 Z" fill="#C8186A" stroke="#8A0E4A" strokeWidth="1" />
        </svg>
      );
    case 'parachute':
      return (
        <svg viewBox="0 0 100 120" width={width} height={height} className={className} style={style}>
          <defs>
            <linearGradient id="chute" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#FF4794" />
              <stop offset="100%" stopColor="#C8186A" />
            </linearGradient>
          </defs>
          <path d="M10 40 Q50 0 90 40 Z" fill="url(#chute)" stroke="#8A0E4A" strokeWidth="1.5" />
          <path d="M30 40 Q50 20 30 40 M50 38 L50 20 M70 40 Q50 20 70 40" stroke="#8A0E4A" strokeWidth="1" fill="none" />
          <line x1="14" y1="42" x2="42" y2="72" stroke="#8A0E4A" strokeWidth="1" />
          <line x1="36" y1="40" x2="46" y2="72" stroke="#8A0E4A" strokeWidth="1" />
          <line x1="64" y1="40" x2="54" y2="72" stroke="#8A0E4A" strokeWidth="1" />
          <line x1="86" y1="42" x2="58" y2="72" stroke="#8A0E4A" strokeWidth="1" />
        </svg>
      );
    case 'f1':
      return (
        <svg viewBox="0 0 140 60" width={width} height={height} className={className} style={style}>
          <defs>
            <linearGradient id="f1Body" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="#C8186A" />
              <stop offset="100%" stopColor="#FF4794" />
            </linearGradient>
          </defs>
          <rect x="10" y="30" width="120" height="10" rx="3" fill="url(#f1Body)" />
          <path d="M40 30 Q60 14 92 14 L108 14 Q118 20 116 30 Z" fill="url(#f1Body)" stroke="#8A0E4A" strokeWidth="1" />
          <rect x="70" y="18" width="22" height="10" rx="2" fill="#1F2937" />
          <rect x="4" y="28" width="14" height="3" fill="#1F2937" />
          <rect x="118" y="22" width="14" height="4" fill="#1F2937" />
          <circle cx="32" cy="44" r="9" fill="#1F2937" />
          <circle cx="32" cy="44" r="3" fill="#9CA3AF" />
          <circle cx="108" cy="44" r="9" fill="#1F2937" />
          <circle cx="108" cy="44" r="3" fill="#9CA3AF" />
        </svg>
      );
    case 'sailboat':
      return (
        <svg viewBox="0 0 120 100" width={width} height={height} className={className} style={style}>
          <line x1="60" y1="8" x2="60" y2="70" stroke="#8A5A2B" strokeWidth="2.5" />
          <path d="M60 10 L60 64 L22 64 Z" fill="#FFFFFF" stroke="#C8186A" strokeWidth="1.5" />
          <path d="M62 14 L62 60 L96 60 Z" fill="#FFE8F2" stroke="#C8186A" strokeWidth="1.5" />
          <path d="M16 70 L104 70 L92 86 L28 86 Z" fill="#C8186A" stroke="#8A0E4A" strokeWidth="1.5" />
          <path d="M10 90 Q30 85 50 90 T90 90 T120 88" stroke="#4FA3D1" strokeWidth="1.5" fill="none" />
        </svg>
      );
  }
}
