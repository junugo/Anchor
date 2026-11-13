/**
 * Tailwind config for web (Next.js).
 * Uses CSS custom properties from globals.css (generated from @anchor/ui/tokens).
 * This enables the same Tailwind class names as mobile to produce identical visuals.
 */
const { spacing, radius, typography } = require('../../packages/ui/src/tokens/index')

/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './app/**/*.{ts,tsx}',
    './lib/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    '../../packages/ui/src/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        // Semantic colors via CSS vars (dark mode handled by [data-theme="dark"] in globals.css)
        bg:              'var(--bg)',
        surface:         'var(--surface)',
        'surface-raised':'var(--surface-raised)',
        border:          'var(--border)',
        'border-subtle': 'var(--border-subtle)',
        primary:         'var(--text-primary)',
        secondary:       'var(--text-secondary)',
        disabled:        'var(--text-disabled)',
        accent:          'var(--accent)',
        'accent-hover':  'var(--accent-hover)',
        'accent-muted':  'var(--accent-muted)',
        // Status colors
        passive:         'var(--color-passive)',
        soft:            'var(--color-soft)',
        hard:            'var(--color-hard)',
        curfew:          'var(--color-curfew)',
      },
      spacing: {
        1: `${spacing[1]}px`,
        2: `${spacing[2]}px`,
        3: `${spacing[3]}px`,
        4: `${spacing[4]}px`,
        5: `${spacing[5]}px`,
        6: `${spacing[6]}px`,
        8: `${spacing[8]}px`,
      },
      borderRadius: {
        sm: `${radius.sm}px`,
        DEFAULT: `${radius.md}px`,
        md: `${radius.md}px`,
        lg: `${radius.lg}px`,
        xl: `${radius.xl}px`,
      },
      fontSize: {
        h1:      `${typography.sizes.h1}px`,
        h2:      `${typography.sizes.h2}px`,
        h3:      `${typography.sizes.h3}px`,
        body:    `${typography.sizes.body}px`,
        caption: `${typography.sizes.caption}px`,
        label:   `${typography.sizes.label}px`,
        micro:   `${typography.sizes.micro}px`,
      },
    },
  },
  plugins: [],
}
