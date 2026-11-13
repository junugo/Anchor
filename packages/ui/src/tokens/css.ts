/**
 * CSS custom-properties 瀛楃涓茬敓鎴愬櫒銆? * apps/web/app/globals.css 涓殑 :root 鍜?[data-theme="dark"] 鍧? * 鏄粠杩欓噷娲剧敓鐨勨€斺€斾慨鏀?tokens/src/index.ts 鍚庤繍琛?
 *   packages/ui/src/tokens contains the source values.
 * 鏉ュ悓姝?globals.css锛堟垨鐩存帴鎵嬪姩瀵圭収锛夈€? *
 * 褰撳墠鎻愪緵绾?JS 鏍煎紡渚涚▼搴忔秷璐癸紝鍚屾椂瀵煎嚭 cssString 渚涜剼鏈啓鍏ユ枃浠躲€? */
import { lightColors, darkColors, spacing, radius } from './index'

function colorsToCss(colors: Record<string, string>): string {
  const map: Record<string, string> = {
    bg:            '--bg',
    surface:       '--surface',
    surfaceRaised: '--surface-raised',
    border:        '--border',
    borderSubtle:  '--border-subtle',
    textPrimary:   '--text-primary',
    textSecondary: '--text-secondary',
    textDisabled:  '--text-disabled',
    accent:        '--accent',
    accentHover:   '--accent-hover',
    accentMuted:   '--accent-muted',
    passive:       '--color-passive',
    soft:          '--color-soft',
    hard:          '--color-hard',
    curfew:        '--color-curfew',
    sleep:         '--color-sleep',
    away:          '--color-away',
  }
  return Object.entries(map)
    .map(([key, cssVar]) => `  ${cssVar}: ${colors[key]};`)
    .join('\n')
}

function spacingToCss(): string {
  return Object.entries(spacing)
    .map(([k, v]) => `  --space-${k}: ${v}px;`)
    .join('\n')
}

function radiusToCss(): string {
  return Object.entries(radius)
    .map(([k, v]) => `  --radius-${k}: ${v}px;`)
    .join('\n')
}

export const lightCssBlock = `/* Light Mode */\n:root {\n${colorsToCss(lightColors as unknown as Record<string,string>)}\n${spacingToCss()}\n${radiusToCss()}\n  --nav-width: 48px;\n}`
export const darkCssBlock  = `/* Dark Mode */\n[data-theme="dark"] {\n${colorsToCss(darkColors as unknown as Record<string,string>)}\n}`
export const mediaDarkBlock = `@media (prefers-color-scheme: dark) {\n  :root:not([data-theme="light"]) {\n${colorsToCss(darkColors as unknown as Record<string,string>)}\n  }\n}`
