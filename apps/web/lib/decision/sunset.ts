import type { Db } from '@anchor/db'
import { getSunsetConfig } from '../sunset/config'
import { playCapsuleInternal } from './capsule'
import { getDb } from '../db'
import {
  getTodaySession,
  recordWakeupSession,
  tickSleepStateMachine,
  computeCurrentSunsetStage,
  enterCurfeeByClock,
  PASSIVE_SLEEP_WINDOW_MINUTES,
} from '../sleep/engine'
import { predictSleepWindow, resolveSunsetAnchor } from '../sleep/pattern'
import type { SunsetSession } from '@anchor/types'
import { getUserLocalParts, getUserMinutesSinceMidnight, getUserSunsetBedtimeAt, isWithinLocalMinutesBand } from '../time/user-time'

// Next.js API 路由（webpack 打包）与自定义 server（tsx 加载）是两套模块实例，
// FocusLayer 心流延迟窗口挂到 globalThis 保证全进程唯一。
type SunsetPhase = 'T60' | 'T30' | 'T15' | 'T0'
const globalForSunset = globalThis as unknown as {
  __anchorSunsetDelayedUntil?: number   // Unix 秒；0/undefined = 未延迟
  __anchorSunsetLastPhase?: SunsetPhase | 'off' | null // 最近一次广播的阶段，用于转变检测
}

/**
 * 起床验证是否已在今日解除宵禁。
 * 由 sunset_sessions 会话表驱动（phase === 'cleared'），重启自愈。
 */
export function isSunsetClearedToday(): boolean {
  try {
    return getTodaySession(getDb()).phase === 'cleared'
  } catch {
    return false
  }
}

/**
 * 起床验证通过：会话置 cleared(wakeup) 并广播解除。
 * 当日后续时间触发的宵禁被压制（released/cleared 语义），次日新一轮日落周期不受影响。
 */
export async function clearSunsetByWakeup(): Promise<void> {
  recordWakeupSession(getDb())
  globalForSunset.__anchorSunsetDelayedUntil = 0
  await broadcastSunsetOff()
}

async function broadcastSunsetOff(): Promise<void> {
  const { broadcast } = await import('../ws/server')
  const config = getSunsetConfig()
  const nowMs = Date.now()
  const nowUnix = Math.floor(nowMs / 1000)
  // 预测窗优先（与 tick 广播同一真相），读取失败回退静态配置
  let target = config.target_bedtime_minutes
  try {
    target = resolveSunsetAnchor(getDb(), nowMs).startMinutes
  } catch { /* 保持静态回退 */ }
  const bedtimeAt = getSunsetBedtimeAt(nowMs, target)
  globalForSunset.__anchorSunsetLastPhase = 'off'
  broadcast({ type: 'sunset:stage', stage: 'off', received_at: nowUnix, expires_at: nowUnix, target_bedtime_minutes: target, bedtime_at: bedtimeAt, clear_reason: 'wakeup' })
  // 保留旧消息，兼容尚未升级的客户端。
  broadcast({ type: 'sunset:phase', phase: 'off' })
}

/**
 * 计算当前宵禁阶段（纯时钟）。
 * getSunsetPhase 以「距就寝分钟数」工作：T60/T30/T15 是就寝前的倒数相位；
 * T0 是睡眠保护带——默认 [targetBedtime, targetBedtime+8h)，传入 windowEndMinutes
 * 时锚定自适应睡眠带 [start, end)（预测窗，见 pattern.ts），支持跨午夜。
 */
export function getSunsetPhase(
  nowMinutes: number,
  targetBedtimeMinutes: number,
  config: { phase_t60_enabled: boolean; phase_t30_enabled: boolean; phase_t15_enabled: boolean; phase_t0_enabled: boolean },
  windowEndMinutes?: number,
): 'T60' | 'T30' | 'T15' | 'T0' | null {
  const minutesUntil = (targetBedtimeMinutes - nowMinutes + 24 * 60) % (24 * 60)

  if (isWithinLocalMinutesBand(nowMinutes, targetBedtimeMinutes, windowEndMinutes ?? targetBedtimeMinutes + 8 * 60) && config.phase_t0_enabled) return 'T0'
  // T-15 独立开关；禁用时回落 T30，避免 0–15 分钟窗口出现干预空档
  if (minutesUntil <= 15) {
    if (config.phase_t15_enabled) return 'T15'
    if (config.phase_t30_enabled) return 'T30'
    return null
  }
  if (minutesUntil <= 30 && config.phase_t30_enabled) return 'T30'
  if (minutesUntil <= 60 && config.phase_t60_enabled) return 'T60'
  return null
}

/** Return the next user-local bedtime boundary as a Unix timestamp. */
export function getSunsetBedtimeAt(nowMs: number, targetBedtimeMinutes: number): number {
  return getUserSunsetBedtimeAt(nowMs, targetBedtimeMinutes)
}

/**
 * 相位 expires_at 的稳定计算（单一实现，tick 广播 / WS 握手 / /api/status 共用）。
 * winddown 用相位窗口边界 + 10min 宽限（覆盖 5min tick 延迟，边界不抖）；
 * T0 用 sleep_start_at+8h（无则 bedtime+8h 兜底）；off 立即过期。
 */
export function computeSunsetExpiresAt(
  stage: 'T60' | 'T30' | 'T15' | 'T0' | 'off',
  session: Pick<SunsetSession, 'sleep_start_at'> | null,
  bedtimeAt: number,
  nowS: number,
): number {
  const GRACE_S = 10 * 60
  switch (stage) {
    case 'T0':
      return session?.sleep_start_at != null ? session.sleep_start_at + 8 * 60 * 60 : bedtimeAt + 8 * 60 * 60
    case 'T60':
      return bedtimeAt - 30 * 60 + GRACE_S
    case 'T30':
      return bedtimeAt - 15 * 60 + GRACE_S
    case 'T15':
      return bedtimeAt + GRACE_S
    case 'off':
      return nowS
  }
}

/**
 * 检查宵禁阶段并触发相应广播 / 意图采集 / AI 提醒。
 * 与 FocusLayer 集成：深度心流时延迟确认宵禁最多 1 小时。
 *
 * 相位由 computeCurrentSunsetStage 统一计算（与 WS 握手、/api/status 同一真相），
 * 时钟只驱动初始 winddown→curfew；released/cleared 压制时间触发的宵禁。
 */
export async function checkSunsetPhase(db: Db, isOnCooldown: (key: string, now: number, cooldown?: number) => boolean, markCooldown: (key: string, now: number) => void): Promise<void> {
  const config = getSunsetConfig()
  if (!config.enabled) return

  const nowMs = Date.now()
  const nowUnix = Math.floor(nowMs / 1000)
  const nowMinutes = getUserMinutesSinceMidnight(nowMs)

  // 真实节律带（被动入睡探测用）与倒数锚点（按 anchor_mode 换算）分离：
  // 候选窗口门控跟学习带走，T-60 等倒数相位跟模式锚点走（2026-09-10 T-60 提前事故教训）
  const band = predictSleepWindow(db, nowMs)
  const anchor = resolveSunsetAnchor(db, nowMs, band)
  const target = anchor.startMinutes
  const windowEnd = anchor.endMinutes

  // FocusLayer 心流延迟窗口未过期：跳过
  if ((globalForSunset.__anchorSunsetDelayedUntil ?? 0) > nowUnix) return

  // 1. 先推进睡眠状态机（确认框响应/超时、候选检测、8h 自动解除）
  // 被动候选统一闸门（winddown/curfee/released）：预测睡眠带前扩 120min（早睡容忍）
  // ~ 带终点后 60min；覆盖 T0 开关关闭时 winddown 残留的边缘情况；带外（白天）不猜睡
  const minutesUntilBand = (band.startMinutes - nowMinutes + 24 * 60) % (24 * 60)
  const minutesAfterBand = (nowMinutes - band.endMinutes + 24 * 60) % (24 * 60)
  const passiveWindowActive =
    minutesUntilBand <= PASSIVE_SLEEP_WINDOW_MINUTES ||
    minutesAfterBand <= 60 ||
    isWithinLocalMinutesBand(nowMinutes, band.startMinutes, band.endMinutes)
  // clockPhase 提前到状态机推进之前：resolveWakeObserving 需要用它决定回 curfee（T0 带内）还是 cleared
  const clockPhase = getSunsetPhase(nowMinutes, target, config, windowEnd)
  tickSleepStateMachine(db, undefined, undefined, passiveWindowActive, clockPhase)

  // 2. 时钟推进 winddown → curfee（活跃会话感知， released/cleared 不会被拉回；
  //    起床日期级压制：确认起床后到下一次预测入睡点前跳过）
  if (clockPhase === 'T0') {
    enterCurfeeByClock(db)
  }

  // 3. 统一相位计算（含 cleared 复活 / curfew 兜底清除的自愈）
  const { stage, session } = computeCurrentSunsetStage(db, clockPhase, nowUnix)

  // 4. FocusLayer 深度心流：延迟硬宵禁最多 1 小时，仅轻度 T60
  if (stage === 'T0' || stage === 'T30' || stage === 'T15') {
    const { focusLayerClient } = await import('../focuslayer/client')
    if (focusLayerClient.isEnabled()) {
      const status = await focusLayerClient.queryStatus()
      if (status && status.focus_context.mode === 'deep' && (status.focus_context.active_issue?.elapsed_minutes ?? 0) >= 20) {
        globalForSunset.__anchorSunsetDelayedUntil = nowUnix + 60 * 60
        globalForSunset.__anchorSunsetLastPhase = 'T60'
        const { broadcast } = await import('../ws/server')
        broadcast({ type: 'sunset:phase', phase: 'T60' })
        return
      }
    }
  }

  // 5. 广播相位（转变检测；expires_at 稳定，不每 tick 刷新）
  const prevStage = globalForSunset.__anchorSunsetLastPhase
  if (stage !== prevStage) {
    globalForSunset.__anchorSunsetLastPhase = stage
    const fmt = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
    console.log(`[sunset] stage ${stage} anchor=${fmt(target)} mode=${anchor.mode} band=${fmt(anchor.bandStart)}-${fmt(anchor.bandEnd)} fromHistory=${anchor.fromHistory}`)
    const { broadcast } = await import('../ws/server')
    const receivedAt = nowUnix
    const bedtimeAt = getSunsetBedtimeAt(nowMs, target)
    const expiresAt = computeSunsetExpiresAt(stage, session, bedtimeAt, nowUnix)
    broadcast({
      type: 'sunset:stage',
      stage,
      received_at: receivedAt,
      expires_at: expiresAt,
      target_bedtime_minutes: target,
      bedtime_at: bedtimeAt,
      sleep_started_at: session.sleep_start_at ?? undefined,
      clear_reason: session.clear_reason ?? undefined,
    })
    // 保留旧消息，兼容尚未升级的客户端。
    broadcast({ type: 'sunset:phase', phase: stage, expires_at: expiresAt, bedtime_at: bedtimeAt })

    // 6. 转变触发的副作用
    if (stage === 'T30') {
      // 宵禁 T-30：触发意图采集（每日仅一次，由 triggerIntentCapture 内部守卫保证）
      const { triggerIntentCapture } = await import('../intention/anchor')
      triggerIntentCapture(db).catch(console.error)
    }
    if (stage === 'T0') {
      if (!isOnCooldown('bedtime_reminder', nowUnix)) {
        markCooldown('bedtime_reminder', nowUnix)
        const { triggerAiReminder } = await import('../ai/reminder')
        triggerAiReminder(db, 'bedtime').catch(console.error)
      }
    }
  }
}

/**
 * 处理解离状态下的时间锚广播与胶囊播放。
 */
export async function handleDissociation(db: Db): Promise<void> {
  const { hour, minute } = getUserLocalParts(Date.now())
  const period = hour < 12 ? '上午' : hour < 18 ? '下午' : '晚上'
  const timeText = `现在是${period} ${hour}点${String(minute).padStart(2, '0')}分`
  const remaining = 24 * 60 - hour * 60 - minute
  const remainH = Math.floor(remaining / 60)
  const remainM = remaining % 60

  const { broadcast } = await import('../ws/server')
  broadcast({ type: 'time:anchor', text: `${timeText}，今天还剩 ${remainH} 小时 ${remainM} 分钟。` })

  // 播放解离胶囊
  playCapsuleInternal(db, 'dissociation').catch(console.error)

  // 深夜（23:00—5:00）额外播放 deep_night 胶囊
  if (hour >= 23 || hour < 5) {
    playCapsuleInternal(db, 'deep_night').catch(console.error)
  }

  const { focusLayerClient } = await import('../focuslayer/client')
  if (focusLayerClient.isEnabled()) {
    await focusLayerClient.notifyDissociation()
  }
}
