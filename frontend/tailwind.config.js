export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        'ink-deep': '#0d0b09',
        'ink-mid': '#1c1a17',
        'ink-surface': '#232018',
        gold: '#c9a84c',
        cream: '#f0ead8',
      },
      fontFamily: {
        display: ['"Playfair Display"', 'serif'],
        body: ['"Cormorant Garamond"', 'serif'],
        mono: ['"DM Mono"', 'monospace'],
      },
    },
  },
  plugins: [],
};
