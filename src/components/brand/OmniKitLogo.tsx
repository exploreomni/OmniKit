interface OmniKitLogoProps {
  className?: string;
  variant?: 'dark' | 'light';
  size?: 'sm' | 'md' | 'lg';
  subtitle?: string;
}

const SIZE_CLASSES = {
  sm: {
    logo: 'h-5',
    kit: 'text-[20px]',
    kitOffset: 'ml-0',
    kitLift: '-1.25px',
    subtitle: 'text-[9px]',
  },
  md: {
    logo: 'h-6',
    kit: 'text-[24px]',
    kitOffset: 'ml-0',
    kitLift: '-1.5px',
    subtitle: 'text-[10px]',
  },
  lg: {
    logo: 'h-8',
    kit: 'text-[32px]',
    kitOffset: 'ml-0',
    kitLift: '-2px',
    subtitle: 'text-[11px]',
  },
};

export function OmniKitLogo({ className = '', variant = 'dark', size = 'md', subtitle }: OmniKitLogoProps) {
  const sizing = SIZE_CLASSES[size];
  const light = variant === 'light';

  return (
    <div className={`inline-flex items-center gap-1.5 ${className}`}>
      <div className="flex items-center gap-0">
        <img
          src="/omni-logo.webp"
          alt="Omni"
          className={`${sizing.logo} block w-auto object-contain ${light ? 'brightness-0 invert' : ''}`}
        />
        <span
          className={`${sizing.kit} ${sizing.kitOffset} font-bold leading-none`}
          style={{ color: light ? '#FF8DB4' : '#FF5789', letterSpacing: 0, transform: `translateY(${sizing.kitLift})` }}
        >
          kit
        </span>
      </div>
      {subtitle && (
        <span
          className={`${sizing.subtitle} font-semibold uppercase tracking-[0.16em] leading-none`}
          style={{ color: light ? 'rgba(255,255,255,0.72)' : '#78808C' }}
        >
          {subtitle}
        </span>
      )}
    </div>
  );
}
