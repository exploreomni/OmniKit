/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        omni: {
          900: '#331B46',
          800: '#404754',
          700: '#C83B70',
          600: '#E4477C',
          500: '#FF5789',
          400: '#FF7CA4',
          300: '#FFA1BD',
          200: '#FFC7D8',
          100: '#FFE5ED',
          50:  '#FFF6F9',
        },
        surface: {
          primary: '#FFFFFF',
          secondary: '#F8F9FD',
          tertiary: '#F1F4F8',
        },
        content: {
          primary: '#404754',
          secondary: '#5F6672',
          tertiary: '#78808C',
        },
        border: {
          DEFAULT: '#DDE2EB',
          strong: '#C7CEDB',
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
        sans: ['system-ui', '-apple-system', 'BlinkMacSystemFont', '"Segoe UI"', 'sans-serif'],
        mono: ['"SF Mono"', 'Menlo', 'Monaco', 'Consolas', 'monospace'],
      },
      borderRadius: {
        card: '10px',
        button: '7px',
        chip: '999px',
      },
      boxShadow: {
        card: '0 1px 3px rgba(64, 71, 84, 0.08)',
        'card-hover': '0 6px 18px rgba(64, 71, 84, 0.12)',
        'card-raised': '0 10px 28px rgba(64, 71, 84, 0.14)',
        dropdown: '0 10px 28px rgba(64, 71, 84, 0.16)',
        'focus-ring': '0 0 0 3px rgba(255, 87, 137, 0.22)',
        glow: 'none',
        'glow-sm': 'none',
        'inner-glow': 'inset 0 1px 2px rgba(255, 255, 255, 0.1)',
      },
      backgroundImage: {
        'omni-gradient': 'linear-gradient(135deg, #E4477C 0%, #FF5789 100%)',
        'omni-gradient-dark': 'linear-gradient(135deg, #331B46 0%, #C83B70 100%)',
        'omni-gradient-soft': 'linear-gradient(135deg, #F8F9FD 0%, #FFFFFF 100%)',
        'sidebar-gradient': 'linear-gradient(180deg, #FFFFFF 0%, #FFFFFF 100%)',
        'surface-gradient': 'linear-gradient(180deg, #F8F9FD 0%, #FFFFFF 60%)',
        'card-shine': 'linear-gradient(135deg, #FFFFFF 0%, #FFFFFF 100%)',
        'dot-pattern': 'linear-gradient(#F8F9FD, #F8F9FD)',
      },
      backgroundSize: {
        'dot-sm': '16px 16px',
        'dot-md': '24px 24px',
      },
      animation: {
        float: 'float 3.8s cubic-bezier(0.37, 0, 0.63, 1) infinite',
        slideIn: 'slideIn 0.3s ease-out',
        wiggle: 'wiggle 0.5s ease-in-out',
        confetti: 'confettiBurst 0.6s ease-out forwards',
        rocketTrail: 'rocketTrail 1s cubic-bezier(0.22, 1, 0.36, 1) infinite',
        stepPulse: 'stepPulse 2s ease-in-out infinite',
        fadeIn: 'fadeIn 0.4s ease-out',
        shimmer: 'shimmer 2s linear infinite',
        pulse_slow: 'pulse 3s ease-in-out infinite',
        'slide-up': 'slideUp 0.3s ease-out',
        'scale-in': 'scaleIn 0.2s ease-out',
        glow_pulse: 'none',
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
