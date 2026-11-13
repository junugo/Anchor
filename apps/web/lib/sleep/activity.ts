/**
 * 睡眠状态机事件分类：白名单制。
 * 只有「用户主动行为」才能触发确认框/证明醒着；被动/轮询事件（如 physical_activity）
 * 无论用户是否睡着都会上报，必须忽略，否则会错误回推入睡时间。
 */

// 用户主动活动事件：代表用户必然醒着，触发确认框或证明醒着
// 注意 screen_on 不在其中：通知亮屏也会触发 ACTION_SCREEN_ON，并非用户主动行为；
// 「主动用手机」由 screen_unlock（ACTION_USER_PRESENT）承担
export const USER_ACTIVITY_EVENT_TYPES = new Set([
  'url_visit',
  'code_active',
  'key_activity',
  'window_focus',
  // desktop 进入新窗口/驻留心梗：客户端仅在键鼠活跃时发出，等价于 window_focus 的活跃语义
  'window_active',
  'app_open',
  'app_foreground',
  'screen_unlock',
  'tab_switch',
  'user_active',
  'git_commit',
  'terminal_active',
])

// 入睡候选触发信号：息屏/锁屏是入睡候选信号，但不是活动信号
export const SLEEP_CANDIDATE_EVENT_TYPES = new Set(['screen_off', 'screen_lock'])

/**
 * 「真实交互」事件：手机/电脑前的人真的在操作，绝对不能判睡。
 * 不包含 app_foreground——那只是 Android 前台 App 心跳轮询，屏幕常亮时也会一直上报。
 */
export const STRONG_USER_ACTIVITY_EVENT_TYPES = new Set([
  'url_visit',
  'code_active',
  'key_activity',
  'window_focus',
  'window_active',
  'app_open',
  'screen_unlock',
  'tab_switch',
  'user_active',
  'git_commit',
  'terminal_active',
])

/**
 * 「被动轮询」事件：设备本身在运行，不代表有人在操作。
 * 亮屏但无真实交互时，这些事件仍会继续到达；可作为「亮屏睡眠」的候选信号。
 */
export const PASSIVE_POLLING_EVENT_TYPES = new Set([
  'app_foreground',
  'app_usage_snapshot',
  'physical_activity',
  'battery_charging',
])

export function isUserActivityEvent(eventType: string, payload?: Record<string, unknown> | null): boolean {
  if (!USER_ACTIVITY_EVENT_TYPES.has(eventType)) return false
  // desktop 空闲结算（5min 无键鼠输入后发出的最后一条）：是「用户走开/睡着」的证据，不是活动
  if (eventType === 'window_focus' && payload?.['is_idle'] === true) return false
  return true
}

export function isStrongUserActivityEvent(eventType: string, payload?: Record<string, unknown> | null): boolean {
  if (!STRONG_USER_ACTIVITY_EVENT_TYPES.has(eventType)) return false
  if (eventType === 'window_focus' && payload?.['is_idle'] === true) return false
  return true
}

export function isPassivePollingEvent(eventType: string): boolean {
  return PASSIVE_POLLING_EVENT_TYPES.has(eventType)
}

export function isSleepCandidateEvent(eventType: string): boolean {
  return SLEEP_CANDIDATE_EVENT_TYPES.has(eventType)
}
