/**
 * @anchor/tokens — единственный источник истины для дизайн-токенов.
 * Anchor Design Language v1.0
 *
 * Используется двумя путями:
 *   1. './css' — генерирует строку CSS custom-properties (injected в globals.css)
 *   2. '.'    — импортирует все сырые значения токенов
 */

// ─── Цвета: светлая тема ──────────────────────────────────────────────────────
export const lightColors = {
  bg:            '#f5f0eb',
  surface:       '#ffffff',
  surfaceRaised: '#faf7f4',
  border:        '#e0d9d0',
  borderSubtle:  '#ede8e2',
  textPrimary:   '#1a1410',
  textSecondary: '#6b6560',
  textDisabled:  '#b0a89e',
  accent:        '#c0622a',
  accentHover:   '#a8531f',
  accentMuted:   '#f0e4da',

  // Статусные цвета (одинаковы в обоих темах по умолчанию — светлый вариант)
  passive: '#22863a',
  soft:    '#b08800',
  hard:    '#c0622a',
  curfew:  '#cf222e',
  sleep:   '#1e3a8a',
  away:    '#6e7681',
} as const

// ─── Цвета: тёмная тема ───────────────────────────────────────────────────────
export const darkColors = {
  bg:            '#1c1814',
  surface:       '#252018',
  surfaceRaised: '#2e2820',
  border:        '#3a3228',
  borderSubtle:  '#302820',
  textPrimary:   '#f0ebe4',
  textSecondary: '#9e978e',
  textDisabled:  '#5a5550',
  accent:        '#c0622a',
  accentHover:   '#d4703a',
  accentMuted:   '#3a2218',

  passive: '#3fb950',
  soft:    '#e3b341',
  hard:    '#d4703a',
  curfew:  '#ff7b72',
  sleep:   '#60a5fa',
  away:    '#8b949e',
} as const

// ─── Отступы (spacing, base 4px) ─────────────────────────────────────────────
export const spacing = {
  1:  4,
  2:  8,
  3:  12,
  4:  16,
  5:  20,
  6:  24,
  8:  32,
} as const

// ─── Скругления ───────────────────────────────────────────────────────────────
export const radius = {
  sm: 4,
  md: 6,
  lg: 8,
  xl: 12,
} as const

// ─── Типографика ──────────────────────────────────────────────────────────────
export const typography = {
  fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
  sizes: {
    h1:       18,
    h2:       15,
    h3:       13,
    body:     14,
    caption:  13,
    label:    12,
    micro:    11,
  },
  weights: {
    regular: '400' as const,
    medium:  '500' as const,
    semibold:'600' as const,
    bold:    '700' as const,
  },
  lineHeights: {
    tight:   1.3,
    normal:  1.5,
    single:  1.0,
  },
} as const

// ─── Навигация ────────────────────────────────────────────────────────────────
export const navWidthPx = 48
export const mobileNavHeightPx = 56

// ─── Анимации ─────────────────────────────────────────────────────────────────
export const animation = {
  /** hover / state transitions */
  fast:    100,
  /** panel expand/collapse */
  medium:  150,
  /** page transition */
  slow:    200,
  /** curfew appear */
  curfew:  800,
} as const

export type LightColors = typeof lightColors
export type DarkColors  = typeof darkColors
