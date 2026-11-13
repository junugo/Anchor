import type { UserState } from '@anchor/types'

type Condition = (payload: Record<string, unknown>, highStimulusApps: string[]) => boolean

// 分心侧触发器：当前处于工作/过渡状态时，只有「矛盾的分心事件」值得跑轻量管线
// （工作中打开高刺激 App / 高刺激网站 / 视频播放 / tab 爆炸 → 秒级拉回）
const DISTRACTION_TRIGGERS: Record<string, Condition | true> = {
  app_foreground: (p, apps) => apps.includes(String(p['packageName'] ?? '')),
  url_visit: (p) => p['high_stimulus'] === true,
  video_state: (p) => p['state'] === 'play',
  tab_explosion: true,
}

// 工作侧事件：当前处于娱乐/解离时用于快速纠错（及时停止错误干预、恢复静默）
// window_focus / window_active 额外要求命中工作进程（调用方注入谓词）
const WORK_EVENT_TYPES = new Set(['code_active', 'window_focus', 'window_active'])

export interface TriggerContext {
  // 当前推断状态（pipeline.getPrevState()）
  prevState: UserState
  // 工作进程判定（process_classifications.is_work ∪ DEV_TOOLS，小写子串匹配）
  isWorkProcess: (processName: string) => boolean
}

/**
 * 矛盾门控：仅当事件与当前状态矛盾时才触发轻量管线——
 * 状态符合预期时系统沉默（UX 基准），常规状态演进交给 5 分钟 full tick。
 * resting 不触发：宵禁/睡眠链路由 full tick + sunset 状态机管理。
 */
export function shouldTriggerImmediate(
  eventType: string,
  payload: Record<string, unknown>,
  highStimulusApps: string[],
  ctx: TriggerContext,
): boolean {
  if (ctx.prevState === 'working' || ctx.prevState === 'transitioning') {
    const rule = DISTRACTION_TRIGGERS[eventType]
    if (rule === undefined) return false
    if (rule === true) return true
    return rule(payload, highStimulusApps)
  }

  if (ctx.prevState === 'entertaining' || ctx.prevState === 'dissociating') {
    if (!WORK_EVENT_TYPES.has(eventType)) return false
    if (eventType === 'code_active') return true
    // window_focus / window_active：仅工作进程构成「回到工作」的纠错信号
    return payload['is_idle'] !== true && ctx.isWorkProcess(String(payload['process'] ?? ''))
  }

  return false
}

// 防抖：同触发源 500ms 内只触发一次；轻量 pipeline 5s 内不重复
const EVENT_DEBOUNCE_MS = 500
const LIGHTWEIGHT_COOLDOWN_MS = 5_000
let _lastTriggerAt = 0
let _lastPipelineAt = 0

// 返回 true 表示应当真正执行一次轻量 pipeline（已通过防抖）
export function debounceImmediateTrigger(nowMs: number): boolean {
  if (nowMs - _lastTriggerAt < EVENT_DEBOUNCE_MS) return false
  _lastTriggerAt = nowMs
  if (nowMs - _lastPipelineAt < LIGHTWEIGHT_COOLDOWN_MS) return false
  _lastPipelineAt = nowMs
  return true
}

export function resetTriggerDebounce(): void {
  _lastTriggerAt = 0
  _lastPipelineAt = 0
}
