import type { Db } from '@anchor/db'
import { behaviorLogs, circadianLogs } from '@anchor/db'
import { and, desc, eq, gte, isNotNull, lt } from 'drizzle-orm'
import { getSunsetConfig, updateSunsetConfig } from './config'
import { getUserDateStr, getUserMinutesSinceMidnight } from '../time/user-time'

/**
 * 渐进式宵禁锚点（progressive 锚点模式）——领走式（v2，2026-10-01 重构）。
 *
 * v1 跟随式（candidate = 中位数 − 15）在生产中证明结构性失效：advance 需要
 * 「中位数睡到锚点之前」，但用户每晚都睡在锚点之后（12 晚 0 次 advance，
 * 锚点 11 天净推迟 137 分钟）——跟随器没有牵引力，只剩「认证真实入睡点」。
 *
 * v2 语义：锚点是领队，不是跟随者——
 * - 合规（昨晚入睡 ≤ 锚点 + GRACE）→ 锚点每天向 ideal 主动领走一步（受领走上限钳制）
 * - 睡晚（> GRACE 但 ≤ LEAD_MAX）→ 原地不动持续施压（今晚 T60/T30/T15/T0
 *   全部在锚点时刻触发，等用户追上来）
 * - 崩盘（单晚 > LEAD_MAX）→ retreat 阀门：min(step, 周预算剩余, gap − LEAD_MAX)
 * - 持续脱节（中位数 > 锚点 + RESYNC_GAP，如假期模式）→ resync 回跟随点（不烧预算）
 *
 * 引擎只托管 sunset_config.target_bedtime_minutes 这一个数——下游
 * resolveSunsetAnchor / T60/T30/T15/T0 倒数链路零改动；predictSleepWindow
 * 学习带仍只服务被动入睡探测，不吃钳制（T-60 事故教训）。
 * 所有时间比较均为环形语义（signedDelta ∈ [-720, 720)），禁止裸数值比大小。
 */

const DAY_MINUTES = 24 * 60
const LOOKBACK_DAYS = 7
/** 至少几个夜晚的入睡数据才参与中位数（防 1-2 晚异常拉偏）；领走上限/resync 判定用 */
const MIN_NIGHTS = 3
/** 中位数夜间窗口（本地分钟）：[18:00, 10:00)。白天 sleep_start 是 phantom 产物，
 *  但窗口右缘必须低于 11:55（开学周事故的 phantom 午睡时刻）*/
const NIGHT_WINDOW_START = 18 * 60
const NIGHT_WINDOW_END = 10 * 60
/** 最近一晚入睡点的采信带（本地分钟）：[17:00, 11:00)。挡午间 phantom，
 *  保留 06:30 的真实熬夜入睡；11:55 phantom 被排除 */
const LAST_SLEEP_VALID_START = 17 * 60
const LAST_SLEEP_VALID_END = 11 * 60
/** 合规宽限：入睡晚于锚点 ≤30min 仍算合规，锚点领走提前一步 */
export const GRACE_MINUTES = 30
/** 领走上限：锚点领先中位入睡最多 90min，超过则原地等用户；同时是 retreat 触发线 */
export const LEAD_MAX_MINUTES = 90
/** 持续脱节重锚线：中位数落后锚点 >180min（如假期模式）→ resync 回跟随点 */
export const RESYNC_GAP_MINUTES = 180
/** 倒退周预算：最近 7 天累计倒退不超过该值（保长期趋势，从调整日志回算） */
export const RETREAT_WEEKLY_BUDGET_MINUTES = 30

export const PROGRESSIVE_ADJUST_EVENT = 'sunset_anchor_adjusted'

/** 环形带符号差：from → to 最短方向分钟数，正 = to 在 from 之后 */
export function signedDelta(from: number, to: number): number {
  return (((to - from + 720) % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES - 720
}

const norm = (m: number) => ((m % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES

/**
 * 从 from 朝 ideal 方向走一步 step（环形，不越过 ideal）。
 * advance 领走与 resync 回跟随点共用此计算；computeProgressiveBedtime
 * 的「今晚建议」亦由它得出，保证建议值与引擎语义一致。
 */
export function chaseCandidateMinutes(fromMinutes: number, idealMinutes: number, stepMinutes: number): number {
  const p = signedDelta(fromMinutes, idealMinutes)
  const pTarget = p > 0 ? Math.max(p - stepMinutes, 0) : Math.min(p + stepMinutes, 0)
  return norm(idealMinutes - pTarget)
}

export interface ProgressiveInput {
  /** 当前托管锚点（sunset_config.target_bedtime_minutes） */
  anchorMinutes: number
  /** 理想就寝（最终目标，永不越过） */
  idealMinutes: number
  /** 步幅（分钟/天） */
  stepMinutes: number
  /** 最近一个已完成夜晚的检测入睡点（本地分钟）；null = 无采信数据 → 原地不动 */
  lastSleepMinutes: number | null
  /** 近 7 晚入睡中位数（夜间窗口过滤后）；null = 数据不足 → 不施加领走上限/resync */
  medianMinutes: number | null
  /** 最近 7 天已累计的倒退分钟数（从调整日志回算） */
  retreatUsedMinutes: number
}

export type ProgressiveAction = 'advance' | 'retreat' | 'resync' | 'hold'

export interface ProgressiveDecision {
  action: ProgressiveAction
  newAnchorMinutes: number
  /** 带符号移动量：负 = 提前（前进），正 = 推迟（倒退/重锚）。hold 为 0 */
  movedMinutes: number
  /** 机器可读原因（日志 payload 用） */
  reason: string
}

function hold(anchorMinutes: number, reason: string): ProgressiveDecision {
  return { action: 'hold', newAnchorMinutes: norm(anchorMinutes), movedMinutes: 0, reason }
}

/**
 * 纯函数决策（v2 领走式）：无副作用、不读时钟，便于单测覆盖各分支。
 * 优先级：无数据 → 脱节 resync → 合规领走（带上限）→ 宽限带内施压 → 崩盘 retreat。
 */
export function decideProgressiveAnchor(input: ProgressiveInput): ProgressiveDecision {
  const { anchorMinutes, idealMinutes, stepMinutes, lastSleepMinutes, medianMinutes, retreatUsedMinutes } = input
  const anchor = norm(anchorMinutes)
  const ideal = norm(idealMinutes)

  if (lastSleepMinutes == null) return hold(anchor, 'insufficient_data')
  const sleep = norm(lastSleepMinutes)
  const sleepGap = signedDelta(anchor, sleep) // >0 = 昨晚睡晚于锚点

  // 持续脱节（中位数判定，防单晚极端值）：resync 回跟随点，不烧周预算
  if (medianMinutes != null) {
    const medianGap = signedDelta(anchor, norm(medianMinutes))
    if (medianGap > RESYNC_GAP_MINUTES) {
      const newAnchor = chaseCandidateMinutes(medianMinutes, ideal, stepMinutes)
      return { action: 'resync', newAnchorMinutes: newAnchor, movedMinutes: signedDelta(anchor, newAnchor), reason: `median_gap_${medianGap}min_exceeds_${RESYNC_GAP_MINUTES}` }
    }
  }

  // 合规：昨晚入睡不晚于 锚点+宽限 → 锚点向 ideal 领走一步
  if (sleepGap <= GRACE_MINUTES) {
    const candidate = chaseCandidateMinutes(anchor, ideal, stepMinutes)
    if (candidate === anchor) return hold(anchor, 'arrived')
    // 领走上限：前进后领先中位数 >LEAD_MAX → 原地等用户追上来
    if (medianMinutes != null) {
      const leadAfter = signedDelta(candidate, norm(medianMinutes))
      if (leadAfter > LEAD_MAX_MINUTES) {
        return hold(anchor, `lead_cap_${leadAfter}min_exceeds_${LEAD_MAX_MINUTES}`)
      }
    }
    return { action: 'advance', newAnchorMinutes: candidate, movedMinutes: signedDelta(anchor, candidate), reason: 'compliant_advance' }
  }

  // 睡晚但在领走范围内 → 原地施压（今晚各阶段照常在锚点时刻触发）
  if (sleepGap <= LEAD_MAX_MINUTES) {
    return hold(anchor, `pressure_gap_${sleepGap}`)
  }

  // 崩盘：retreat 阀门 = min(需退量, 周预算剩余, 步幅)；allow ≤ 0 则原地不动
  const budgetLeft = RETREAT_WEEKLY_BUDGET_MINUTES - retreatUsedMinutes
  const allow = Math.min(sleepGap - LEAD_MAX_MINUTES, budgetLeft, stepMinutes)
  if (allow <= 0) {
    return hold(anchor, `retreat_blocked_budget_${budgetLeft}`)
  }
  return {
    action: 'retreat',
    newAnchorMinutes: norm(anchor + allow),
    movedMinutes: allow,
    reason: `retreat_clamped_to_${allow}`,
  }
}

/** 最近一个已完成夜晚的入睡点（本地分钟）；采信带 [17:00, 11:00)，午间 phantom 跳过 */
export function loadLastSleepStart(db: Db): number | null {
  const rows = db
    .select({ sleep_start: circadianLogs.sleep_start })
    .from(circadianLogs)
    .where(isNotNull(circadianLogs.sleep_start))
    .orderBy(desc(circadianLogs.date))
    .limit(5)
    .all()

  for (const row of rows) {
    const m = getUserMinutesSinceMidnight(row.sleep_start! * 1000)
    if (m >= LAST_SLEEP_VALID_START || m < LAST_SLEEP_VALID_END) return m
  }
  return null
}

/** 近 7 个已结束睡眠日的夜间入睡中位数（本地分钟）；不足 MIN_NIGHTS 晚返回 null */
export function loadNightMedianSleepStart(db: Db, nowMs = Date.now()): number | null {
  const todayStr = getUserDateStr(nowMs)
  const cutoff = getUserDateStr(nowMs - LOOKBACK_DAYS * 24 * 60 * 60 * 1000)

  const rows = db
    .select({ sleep_start: circadianLogs.sleep_start })
    .from(circadianLogs)
    .where(and(lt(circadianLogs.date, todayStr), gte(circadianLogs.date, cutoff)))
    .all()

  const starts = rows
    .filter(r => r.sleep_start != null)
    .map(r => getUserMinutesSinceMidnight(r.sleep_start! * 1000))
    .filter(m => m >= NIGHT_WINDOW_START || m < NIGHT_WINDOW_END)

  if (starts.length < MIN_NIGHTS) return null

  // 旋转到线性空间取中位数再转回：夜间窗口 [18:00, 10:00) 映射为 [0, 960)，
  // 避免 23:xx 与 0:xx 数值序错乱（跨午夜环绕）
  const rotated = starts.map(m => norm(m - NIGHT_WINDOW_START)).sort((a, b) => a - b)
  const mid = Math.floor(rotated.length / 2)
  const rotatedMedian =
    rotated.length % 2 === 1 ? rotated[mid] : Math.round((rotated[mid - 1] + rotated[mid]) / 2)
  return norm(rotatedMedian + NIGHT_WINDOW_START)
}

/** 最近 7 天已累计的倒退分钟数（从 sunset_anchor_adjusted 日志回算） */
export function retreatMinutesLast7d(db: Db, nowMs = Date.now()): number {
  const cutoffS = Math.floor(nowMs / 1000) - LOOKBACK_DAYS * 24 * 60 * 60
  const rows = db
    .select({ payload: behaviorLogs.payload })
    .from(behaviorLogs)
    .where(and(gte(behaviorLogs.logged_at, cutoffS), eq(behaviorLogs.event_type, PROGRESSIVE_ADJUST_EVENT)))
    .all()

  let total = 0
  for (const row of rows) {
    if (row.payload?.direction === 'retreat') {
      total += Math.abs(Number(row.payload.moved_minutes) || 0)
    }
  }
  return total
}

/**
 * 每日一次渐进调整入口（跨日归档时调用，须在 reconcile 之后）：
 * 仅在 anchor_mode === 'progressive' 时生效；有变动则写回托管锚点、
 * 记行为日志（含合规/倒退审计字段）、全量下发 sunset:config。
 * opts.broadcast 默认 true；单测传 false 跳过 WS 广播（避免拉起 ws/server 依赖）。
 */
export async function applyDailyProgressiveAdjustment(
  db: Db,
  nowMs = Date.now(),
  opts?: { broadcast?: boolean },
): Promise<void> {
  const config = getSunsetConfig()
  if (config.anchor_mode !== 'progressive') return

  const lastSleep = loadLastSleepStart(db)
  if (lastSleep == null) return // 无采信入睡数据，原地不动（不刷日志，避免噪声）

  const median = loadNightMedianSleepStart(db, nowMs)
  const retreatUsed = retreatMinutesLast7d(db, nowMs)
  const decision = decideProgressiveAnchor({
    anchorMinutes: config.target_bedtime_minutes,
    idealMinutes: config.ideal_bedtime_minutes,
    stepMinutes: config.progressive_step_minutes,
    lastSleepMinutes: lastSleep,
    medianMinutes: median,
    retreatUsedMinutes: retreatUsed,
  })

  if (decision.action === 'hold') return

  updateSunsetConfig({ target_bedtime_minutes: decision.newAnchorMinutes })

  const nowS = Math.floor(nowMs / 1000)
  db.insert(behaviorLogs)
    .values({
      source: 'web',
      event_type: PROGRESSIVE_ADJUST_EVENT,
      payload: {
        direction: decision.action,
        from: config.target_bedtime_minutes,
        to: decision.newAnchorMinutes,
        moved_minutes: decision.movedMinutes,
        sleep_minutes: lastSleep,
        gap_minutes: signedDelta(config.target_bedtime_minutes, lastSleep),
        median_minutes: median,
        ideal_minutes: config.ideal_bedtime_minutes,
        step_minutes: config.progressive_step_minutes,
        grace_minutes: GRACE_MINUTES,
        lead_max_minutes: LEAD_MAX_MINUTES,
        retreat_used_minutes: retreatUsed,
        reason: decision.reason,
      },
      logged_at: nowS,
    })
    .run()

  console.log(
    `[sunset] 渐进锚点 ${decision.action}: ${formatMinutes(config.target_bedtime_minutes)} → ` +
      `${formatMinutes(decision.newAnchorMinutes)}（昨晚入睡 ${formatMinutes(lastSleep)}，ideal ${formatMinutes(config.ideal_bedtime_minutes)}，${decision.reason}）`,
  )

  // 动态 import 防循环依赖（ws/server 亦反向依赖 sunset/config）
  if (opts?.broadcast === false) return
  const { broadcastSunsetConfigNow } = await import('../ws/server')
  await broadcastSunsetConfigNow()
}

function formatMinutes(minutes: number): string {
  const m = norm(minutes)
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}
