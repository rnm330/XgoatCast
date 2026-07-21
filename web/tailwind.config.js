/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: '#FF8C42',
          light: '#FFA559',
          dark: '#FF6B35',
        },
        surface: {
          DEFAULT: '#16172B',
          light: '#1A1B2E',
          dark: '#0F1020',
        },
        muted: '#A0A3B8',
        dim: '#6B7280',
      },
      fontFamily: {
        sans: ['Poppins', 'system-ui', 'sans-serif'],
      },
      backdropBlur: {
        xs: '2px',
      },
      animation: {
        'fade-in': 'fadeIn 0.4s ease-out',
        'slide-up': 'slideUp 0.4s ease-out',
        'pulse-glow': 'pulseGlow 2s ease-in-out infinite',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%': { opacity: '0', transform: 'translateY(12px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        pulseGlow: {
          '0%, 100%': { boxShadow: '0 0 20px rgba(255,140,66,0.4)' },
          '50%': { boxShadow: '0 0 40px rgba(255,140,66,0.7)' },
        },
      },
    },
  },
  plugins: [require('tailwindcss-animate')],
};
