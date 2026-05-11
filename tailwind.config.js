/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        omni: {
          900: '#1E0814',
          800: '#4D1030',
          700: '#C8186A',
          600: '#E02C80',
          500: '#FF4794',
          400: '#FF72AE',
          300: '#FF9EC8',
          200: '#FFCCE0',
          100: '#FFE0EE',
          50:  '#FFF2F8',
        },
        surface: {
          primary: '#FFFFFF',
          secondary: '#FFF2F8',
          tertiary: '#FFE0EE',
        },
        content: {
          primary: '#1A0814',
          secondary: '#6B1840',
          tertiary: '#9E4870',
        },
        border: {
          DEFAULT: '#F2BED6',
          strong: '#E590BA',
        },
        success: {
          DEFAULT: '#16A34A',
          light: '#DCFCE7',
        },
        warning: {
          DEFAULT: '#EAB308',
          light: '#FEF9C3',
        },
        error: {
          DEFAULT: '#DC2626',
          light: '#FEE2E2',
        },
        info: {
          DEFAULT: '#3B82F6',
          light: '#DBEAFE',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'SF Mono', 'monospace'],
      },
      borderRadius: {
        card: '10px',
        button: '7px',
        chip: '999px',
      },
      boxShadow: {
        card: '0 1px 3px rgba(200, 24, 100, 0.06), 0 4px 12px rgba(200, 24, 100, 0.04)',
        'card-hover': '0 4px 16px rgba(200, 24, 100, 0.12), 0 1px 4px rgba(200, 24, 100, 0.06)',
        'card-raised': '0 8px 24px rgba(200, 24, 100, 0.12), 0 2px 6px rgba(200, 24, 100, 0.06)',
        dropdown: '0 8px 24px rgba(200, 24, 100, 0.14), 0 2px 8px rgba(200, 24, 100, 0.08)',
        'focus-ring': '0 0 0 3px rgba(255, 71, 148, 0.22)',
        glow: '0 0 20px rgba(255, 71, 148, 0.3)',
        'glow-sm': '0 0 10px rgba(255, 71, 148, 0.22)',
        'inner-glow': 'inset 0 1px 2px rgba(255, 255, 255, 0.1)',
      },
      backgroundImage: {
        'omni-gradient': 'linear-gradient(135deg, #C8186A 0%, #FF4794 100%)',
        'omni-gradient-dark': 'linear-gradient(135deg, #4D1030 0%, #C8186A 100%)',
        'omni-gradient-soft': 'linear-gradient(135deg, #FFCCE0 0%, #FFF2F8 100%)',
        'sidebar-gradient': 'linear-gradient(180deg, #FF4794 0%, #C8186A 100%)',
        'surface-gradient': 'radial-gradient(ellipse at top, #FFF2F8 0%, #FFF8FB 60%, #FFFCFE 100%)',
        'card-shine': 'linear-gradient(135deg, rgba(255,255,255,0.8) 0%, rgba(255,255,255,0.2) 100%)',
        'dot-pattern': 'radial-gradient(circle, #F2BED6 1px, transparent 1px)',
      },
      backgroundSize: {
        'dot-sm': '16px 16px',
        'dot-md': '24px 24px',
      },
      animation: {
        float: 'float 3s ease-in-out infinite',
        slideIn: 'slideIn 0.3s ease-out',
        wiggle: 'wiggle 0.5s ease-in-out',
        confetti: 'confettiBurst 0.6s ease-out forwards',
        rocketTrail: 'rocketTrail 1s ease-out infinite',
        stepPulse: 'stepPulse 2s ease-in-out infinite',
        fadeIn: 'fadeIn 0.4s ease-out',
        shimmer: 'shimmer 2s linear infinite',
        pulse_slow: 'pulse 3s ease-in-out infinite',
        'slide-up': 'slideUp 0.3s ease-out',
        'scale-in': 'scaleIn 0.2s ease-out',
        glow_pulse: 'glowPulse 2s ease-in-out infinite',
      },
      keyframes: {
        shimmer: {
          '0%': { backgroundPosition: '-200% center' },
          '100%': { backgroundPosition: '200% center' },
        },
        slideUp: {
          from: { opacity: '0', transform: 'translateY(10px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        scaleIn: {
          from: { opacity: '0', transform: 'scale(0.95)' },
          to: { opacity: '1', transform: 'scale(1)' },
        },
        glowPulse: {
          '0%, 100%': { boxShadow: '0 0 8px rgba(255, 71, 148, 0.22)' },
          '50%': { boxShadow: '0 0 20px rgba(255, 71, 148, 0.45)' },
        },
      },
    },
  },
  plugins: [],
};
