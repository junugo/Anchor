export type SunsetPhase = 'T60' | 'T30' | 'T15' | 'T0' | 'off'

export interface BadgeState {
  connected: boolean
  phase: SunsetPhase
  configError?: boolean
}

interface BadgeAction {
  setBadgeText: (opts: { text: string }) => Promise<void> | void
  setBadgeBackgroundColor: (opts: { color: string }) => Promise<void> | void
  setTitle: (opts: { title: string }) => Promise<void> | void
}

const COLOR_DISCONNECTED = '#9e978e'
const COLOR_T0 = '#cf222e'
const COLOR_T30 = '#c0622a'
const COLOR_T60 = '#b08800'
const COLOR_CONFIG_ERROR = '#cf222e'

// 决定 badge 的显示内容：宵禁阶段文字 + 干预等级颜色；状态符合预期（off 且已连接）时沉默
export function resolveBadge(state: BadgeState): { text: string; color: string; title: string } {
  // 配置错误状态：红色感叹号
  if (state.configError) {
    return { text: '!', color: COLOR_CONFIG_ERROR, title: 'Anchor · 配置错误' }
  }
  if (!state.connected) {
    return { text: '!', color: COLOR_DISCONNECTED, title: 'Anchor · 未连接' }
  }
  switch (state.phase) {
    case 'T0':
      return { text: 'T0', color: COLOR_T0, title: 'Anchor · 硬宵禁' }
    case 'T30':
      return { text: 'T30', color: COLOR_T30, title: 'Anchor · 宵禁 T30' }
    case 'T60':
      return { text: 'T60', color: COLOR_T60, title: 'Anchor · 宵禁 T60' }
    case 'T15':
      return { text: 'T15', color: COLOR_T30, title: 'Anchor · 宵禁 T15' }
    default:
      return { text: '', color: '', title: 'Anchor' }
  }
}

export function createBadgeController(action: BadgeAction) {
  let current: BadgeState = { connected: false, phase: 'off' }

  async function render(): Promise<void> {
    const { text, color, title } = resolveBadge(current)
    await action.setBadgeText({ text })
    if (color) await action.setBadgeBackgroundColor({ color })
    await action.setTitle({ title })
  }

  async function update(partial: Partial<BadgeState>): Promise<void> {
    current = { ...current, ...partial }
    await render()
  }

  return { update, render, getState: () => ({ ...current }) }
}
