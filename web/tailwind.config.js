/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: {
          50: '#eef7f4',
          100: '#d3ebe4',
          200: '#a7d7c9',
          300: '#72bda8',
          400: '#449e86',
          500: '#2b8069',
          600: '#1f6653',
          700: '#1b5144',
          800: '#184137',
          900: '#14362e',
        },
      },
      fontFamily: {
        sans: ['Inter', 'Segoe UI', 'system-ui', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
    },
  },
  plugins: [],
};
