/**
 * 共享状态类型和推断逻辑。
 * 与平台无关——Web、Desktop、Mobile 共用同一套推断规则。
 */
import type { UserState, BehaviorLog } from '@anchor/types'

/**
 * 状态中文名（跨端统一文案，单一来源）。
 * 手动同步：apps/desktop-rs/src/tray.rs `state_label`（Rust 无法引用 TS）。
 */
export const STATE_LABELS: Record<UserState, string> = {
  working:       '专注工作',
  entertaining:  '娱乐中',
  dissociating:  '解离中',
  resting:       '休息中',
  sleeping:      '睡眠中',
  transitioning: '过渡中',
  away:          '在校',
}

/**
 * 状态 → 干预语义 token（状态色统一映射，单一来源）。
 * 色值唯一真源：@anchor/ui tokens（passive/soft/hard/curfew/sleep 的 light/dark 两套色值）。
 *
 * 各端将 token 解析为具体颜色：
 * - web：`var(--color-${token})`（globals.css）
 * - chrome popup：`var(--${token})`（entrypoints/popup/index.html）
 * - mobile：AnchorTheme.kt `InterventionColor`（手动同步，勿改）
 * - desktop-rs：tray.rs `state_color`（手动同步，勿改）
 *
 * `transitioning` 为 null —— 无干预语义，各端回退灰色（text-disabled）。
 * `sleeping` 为 'sleep' —— 睡眠中，深蓝（对应 --color-sleep，各端 CSS 变量已接入）。
 * `away` 为 'away' —— 在校/外出（日程决定的预期空白），灰蓝（对应 --color-away）。
 */
export const STATE_COLOR_TOKENS: Record<UserState, 'passive' | 'soft' | 'hard' | 'curfew' | 'sleep' | 'away' | null> = {
  working:       'passive', // 绿：心流办公，被动感知
  resting:       'soft',    // 黄：放松休息，轻干预
  entertaining:  'hard',    // 橙：娱乐中，标准娱乐摩擦
  dissociating:  'curfew',  // 红：病理性失神，强干预
  sleeping:      'sleep',   // 深蓝：睡眠中（--color-sleep）
  transitioning: null,      // 灰：过渡态，无语义色
  away:          'away',    // 灰蓝：在校/外出（--color-away）
}

 /** 待处理的意图采集提示（宵禁 T-30 触发）*/
export interface PendingIntentCapture {
  prompt_id: string
  timeoutSeconds: number
  prompt: string
  is_degraded: boolean
  focuslayer_hint?: string
}

 /** 待确认的昨日意图（起床后展示）*/
export interface PendingIntentConfirm {
  date: string
  content: string
}

export interface AnchorState {
  userState:            UserState | null
  sunsetPhase:          'T60' | 'T30' | 'T15' | 'T0' | 'off'
  lastAiMessage:        string
  connected:            boolean
  /** 待采集意图：非 null 时客户端应弹出意图输入界面 */
  pendingIntentCapture: PendingIntentCapture | null
  /** 待确认意图：非 null 时客户端应在起床界面展示昨日意图 */
  pendingIntentConfirm: PendingIntentConfirm | null
}

export const initialState: AnchorState = {
  userState:            null,
  sunsetPhase:          'off',
  lastAiMessage:        '',
  connected:            false,
  pendingIntentCapture: null,
  pendingIntentConfirm: null,
}

export type AnchorAction =
  | { type: 'SET_STATE';            userState: UserState }
  | { type: 'SET_SUNSET';           phase: 'T60' | 'T30' | 'T15' | 'T0' | 'off' }
  | { type: 'SET_AI_MSG';           message: string }
  | { type: 'SET_CONNECTED';        connected: boolean }
  | { type: 'SET_INTENT_CAPTURE';   payload: PendingIntentCapture | null }
  | { type: 'SET_INTENT_CONFIRM';   payload: PendingIntentConfirm | null }

export function anchorReducer(state: AnchorState, action: AnchorAction): AnchorState {
  switch (action.type) {
    case 'SET_STATE':          return { ...state, userState:            action.userState }
    case 'SET_SUNSET':         return { ...state, sunsetPhase:          action.phase }
    case 'SET_AI_MSG':         return { ...state, lastAiMessage:        action.message }
    case 'SET_CONNECTED':      return { ...state, connected:            action.connected }
    case 'SET_INTENT_CAPTURE': return { ...state, pendingIntentCapture: action.payload }
    case 'SET_INTENT_CONFIRM': return { ...state, pendingIntentConfirm: action.payload }
    default:                   return state
  }
}

 /** 状态推断：根据行为日志数组推断当前用户状态 */
export function inferUserState(logs: BehaviorLog[]): UserState {
  const recent = logs.slice(-30) // 最近 30 条事件
  const now = Math.floor(Date.now() / 1000)

  const codeActive     = recent.filter(l => l.event_type === 'code_active').length
  const urlHighStimuli = recent.filter(l =>
    l.event_type === 'url_visit' && (l.payload.high_stimulus === true)
  ).length
  const screenOff = recent.some(l =>
    l.event_type === 'screen_off' || l.event_type === 'screen_lock'
  )
  const lastActivity   = recent.length > 0 ? recent[recent.length - 1].logged_at : 0
  const idleSeconds    = now - lastActivity

  if (screenOff || idleSeconds > 1800)         return 'resting'
  if (codeActive >= 3)                          return 'working'
  if (urlHighStimuli >= 2)                      return 'entertaining'
  if (idleSeconds > 300 && codeActive === 0)    return 'dissociating'
  return 'transitioning'
}

