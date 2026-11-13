import { STATE_COLOR_TOKENS } from '@anchor/utils'
import type { UserState } from '@anchor/types'

/**
 * 状态 → CSS 变量颜色。
 * token 映射单一来源：packages/utils/src/state.ts；
 * 色值真源：@anchor/ui tokens（--color-passive/soft/hard/curfew/sleep，globals.css 注入）。
 */
export function stateColor(state: UserState | null | undefined): string {
  const token = state ? STATE_COLOR_TOKENS[state] : null
  return token ? `var(--color-${token})` : 'var(--text-disabled)'
}
