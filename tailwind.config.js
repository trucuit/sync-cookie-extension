/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Inter', 'system-ui', '-apple-system', 'sans-serif'],
      },
      colors: {
        surface: {
          DEFAULT: '#0B0F1A',
          card: 'rgba(255, 255, 255, 0.04)',
          'card-hover': 'rgba(255, 255, 255, 0.06)',
          input: 'rgba(255, 255, 255, 0.06)',
          secondary: '#111827',
        },
        border: {
          DEFAULT: 'rgba(255, 255, 255, 0.08)',
          focus: 'rgba(99, 102, 241, 0.5)',
          input: 'rgba(255, 255, 255, 0.1)',
        },
        accent: {
          indigo: '#6366F1',
          'indigo-hover': '#818CF8',
          violet: '#8B5CF6',
          cyan: '#22D3EE',
          green: '#34D399',
          orange: '#F97316',
          red: '#EF4444',
        },
        text: {
          primary: '#F1F5F9',
          secondary: '#94A3B8',
          muted: '#64748B',
        },
      },
      animation: {
        'pulse-dot': 'pulse-dot 1.5s ease-in-out infinite',
        'spin-fast': 'spin 0.6s linear infinite',
      },
      keyframes: {
        'pulse-dot': {
          '0%, 100%': { opacity: '1', transform: 'scale(1)' },
          '50%': { opacity: '0.5', transform: 'scale(1.3)' },
        },
      },
    },
  },
  plugins: [],
}
