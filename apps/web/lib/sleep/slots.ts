import type { Db } from '@anchor/db'
import { behaviorLogs } from '@anchor/db'
import { and, asc, gte, lt } from 'drizzle-orm'
import { isStrongUserActivityEvent } from './activity'

/**
 * Slot 特征层：CN117061658B（荣耀《睡眠时间识别方法》）的 Anchor 化实现。
 *
 * 专利核心：把一天切成 30 分钟 slot，对每个 slot 计算「灭屏/操作/静止」三个
 * 时长占比，拼接 ±24 slot 的上下文窗口喂给监督模型，二分类判定该 slot 是否
 * 属于睡眠时间；连续为睡的 slot（间隔 ≤1 个）合并为睡眠段，一天多段时取最长。
 *
 * Anchor 的映射（单用户，规则打分替代 ML）：
 * - 灭屏 → 手机灭屏（screen_off→screen_on 区间）；桌面活跃区间并入为乘性抑制
 *   （手机在口袋但人在电脑前 ≠ 睡，对应专利「口袋灭屏」场景的跨端版本）
 * - 操作 → STRONG 真实交互事件（间隔 <3min 合并为操作时间段，同专利逻辑）；
 *   window_focus 空闲结算（is_idle:true）不计操作，对应专利「看视频睡着仍判睡」
 * - 静止 → physical_activity 的 still 覆盖
 * - ±24 slot 上下文窗口 → 由 pattern.ts 的个人节律先验（48 维直方图）承担长
 *   上下文，本层只做 ±1 slot 分数平滑，容忍睡眠中短暂醒来
 */

export const SLOT_MINUTES = 30
export const SLOT_COUNT = (24 * 60) / SLOT_MINUTES // 48
export const SLOT_SECONDS = SLOT_MINUTES * 60

/** 桌面事件宽限：桌面端 PC 唤醒时每 ~5s 上报窗口事件，单事件覆盖到 +15s */
const DESKTOP_EVENT_GRACE_S = 15
/** 操作时间段合并阈值（专利示例值 3min）：相邻 STRONG 事件间隔小于该值视为持续操作 */
const OPERATION_MERGE_GAP_S = 3 * 60
/** 单个 STRONG 事件视为操作的覆盖时长 */
const OPERATION_EVENT_COVER_S = 3 * 60
/** physical_activity 为快照事件，still 样本覆盖到 +5min（客户端 5min 上报周期） */
const STILL_SAMPLE_COVER_S = 5 * 60

/** 打分权重（v1 常量，M5 用生产历史数据离线验证后调参；和为 1 不是硬性约束） */
export const DEFAULT_SCORE_WEIGHTS = {
  phoneDark: 0.25, // 灭屏
  noInteraction: 0.3, // 无操作
  still: 0.15, // 静止
  prior: 0.3, // 个人节律先验
}

export interface ScoreWeights {
  phoneDark: number
  noInteraction: number
  still: number
  prior: number
}

export interface SlotFeature {
  index: number // 0–47，0 = 本地 00:00–00:30
  startS: number
  endS: number
  /** 手机灭屏时长占比 [0,1]；全天无亮灭屏数据时为 null（打分按中性 0.5 处理） */
  phoneDarkRatio: number | null
  /** 桌面活跃时长占比 [0,1]（PC 唤醒且守护进程在跑 ≈ 1，锁屏/关机 ≈ 0） */
  desktopActiveRatio: number
  /** STRONG 真实交互时长占比 [0,1] */
  interactionRatio: number
  /** 静止时长占比 [0,1]；全天无运动数据时为 null（中性 0.5） */
  stillRatio: number | null
}

export interface DayFeatures {
  dayStartS: number
  slots: SlotFeature[]
  hasPhoneData: boolean
  hasStillData: boolean
}

/** 无数据特征的中性值：既不贡献「睡」也不贡献「醒」，把判断交给其他特征 */
export const NEUTRAL_RATIO = 0.5

interface Interval {
  start: number
  end: number
}

/** 合并重叠或间隔小于 gap 的区间 */
function mergeIntervals(intervals: Interval[], gapS: number): Interval[] {
  const sorted = [...intervals].sort((a, b) => a.start - b.start)
  const merged: Interval[] = []
  for (const iv of sorted) {
    const last = merged[merged.length - 1]
    if (last && iv.start <= last.end + gapS) {
      last.end = Math.max(last.end, iv.end)
    } else {
      merged.push({ start: iv.start, end: iv.end })
    }
  }
  return merged
}

/** 区间集合在 [slotStart, slotEnd) 上的覆盖时长 */
function coverageSeconds(intervals: Interval[], slotStart: number, slotEnd: number): number {
  let total = 0
  for (const iv of intervals) {
    if (iv.end <= slotStart) continue
    if (iv.start >= slotEnd) break // intervals 已按 start 排序
    total += Math.min(iv.end, slotEnd) - Math.max(iv.start, slotStart)
  }
  return total
}

function clampToDay(intervals: Interval[], dayStartS: number, dayEndS: number): Interval[] {
  return intervals
    .map(iv => ({ start: Math.max(iv.start, dayStartS), end: Math.min(iv.end, dayEndS) }))
    .filter(iv => iv.end > iv.start)
    .sort((a, b) => a.start - b.start)
}

/**
 * 计算一个 24h 窗口（[windowStartS, windowStartS+86400)）的 48 个 slot 特征。
 * windowStartS 由调用方决定：睡眠识别用睡眠日窗口（本地 12:00 起，与 sessionDateKey
 * 一致，跨午夜灭屏配对不出窗）；纯分析可用自然日窗口（本地 00:00 起）。
 * slot 下标是窗口相对的：窗口起点 = slot 0。
 */
export function computeDayFeatures(db: Db, windowStartS: number): DayFeatures {
  const dayEndS = windowStartS + 24 * 60 * 60
  const dayStartS = windowStartS
  const rows = db
    .select({ event_type: behaviorLogs.event_type, source: behaviorLogs.source, logged_at: behaviorLogs.logged_at, payload: behaviorLogs.payload })
    .from(behaviorLogs)
    .where(and(gte(behaviorLogs.logged_at, dayStartS), lt(behaviorLogs.logged_at, dayEndS)))
    .orderBy(asc(behaviorLogs.logged_at))
    .all()

  // 手机灭屏区间：screen_off → 下一个 screen_on（尾随灭屏延续到当日窗口末尾）
  const phoneDark: Interval[] = []
  // 桌面活跃：桌面端只在 PC 唤醒时上报（锁屏/关机静默），单事件 +15s 宽限
  const desktopActive: Interval[] = []
  // 操作时间段：STRONG 事件，单事件 +3min，间隔 <3min 合并（专利「操作时间段」）
  const operations: Interval[] = []
  // 静止区间：physical_activity(still) 快照，单样本 +5min
  const stills: Interval[] = []

  let darkSince: number | null = null
  for (const r of rows) {
    if (r.source === 'android' && r.event_type === 'screen_off') {
      if (darkSince == null) darkSince = r.logged_at
    } else if (r.source === 'android' && r.event_type === 'screen_on') {
      if (darkSince != null) {
        phoneDark.push({ start: darkSince, end: r.logged_at })
        darkSince = null
      }
    } else if (r.source === 'desktop') {
      desktopActive.push({ start: r.logged_at, end: r.logged_at + DESKTOP_EVENT_GRACE_S })
    }

    if (isStrongUserActivityEvent(r.event_type, r.payload as Record<string, unknown> | null)) {
      operations.push({ start: r.logged_at, end: r.logged_at + OPERATION_EVENT_COVER_S })
    }

    const payload = r.payload as Record<string, unknown> | null
    if (r.event_type === 'physical_activity' && payload?.['activity_type'] === 'still') {
      stills.push({ start: r.logged_at, end: r.logged_at + STILL_SAMPLE_COVER_S })
    }
  }
  if (darkSince != null) phoneDark.push({ start: darkSince, end: dayEndS })

  const hasPhoneData = rows.some(r => r.source === 'android' && (r.event_type === 'screen_on' || r.event_type === 'screen_off'))
  const hasStillData = stills.length > 0

  const darkIv = mergeIntervals(clampToDay(phoneDark, dayStartS, dayEndS), 0)
  const desktopIv = mergeIntervals(clampToDay(desktopActive, dayStartS, dayEndS), 0)
  const operationIv = mergeIntervals(clampToDay(operations, dayStartS, dayEndS), OPERATION_MERGE_GAP_S)
  const stillIv = mergeIntervals(clampToDay(stills, dayStartS, dayEndS), 0)

  const slots: SlotFeature[] = []
  for (let i = 0; i < SLOT_COUNT; i++) {
    const start = dayStartS + i * SLOT_SECONDS
    const end = start + SLOT_SECONDS
    slots.push({
      index: i,
      startS: start,
      endS: end,
      phoneDarkRatio: hasPhoneData ? coverageSeconds(darkIv, start, end) / SLOT_SECONDS : null,
      desktopActiveRatio: coverageSeconds(desktopIv, start, end) / SLOT_SECONDS,
      interactionRatio: coverageSeconds(operationIv, start, end) / SLOT_SECONDS,
      stillRatio: hasStillData ? coverageSeconds(stillIv, start, end) / SLOT_SECONDS : null,
    })
  }

  return { dayStartS, slots, hasPhoneData, hasStillData }
}

/**
 * slot 打分：score = w₁·灭屏·(1−桌面活跃) + w₂·(1−交互) + w₃·静止 + w₄·先验。
 * 「灭屏 × (1−桌面活跃)」是专利单设备方案的跨端补丁——手机在口袋/桌上灭屏、
 * 人在电脑前时，桌面活跃把灭屏特征压掉，避免「口袋灭屏被判睡」。
 *
 * priorOffsetSlots：窗口与先验的 slot 对齐偏移。先验按自然日（00:00 起）对齐；
 * 睡眠日窗口（12:00 起）传入 SLOT_COUNT/2 = 24。
 */
export function scoreSlots(
  features: DayFeatures,
  prior: number[] | null,
  weights: ScoreWeights = DEFAULT_SCORE_WEIGHTS,
  priorOffsetSlots = 0,
): number[] {
  return features.slots.map((s, i) => {
    const dark = s.phoneDarkRatio ?? NEUTRAL_RATIO
    const still = s.stillRatio ?? NEUTRAL_RATIO
    const priorVal = prior?.[(i + priorOffsetSlots) % SLOT_COUNT] ?? 0
    return (
      weights.phoneDark * dark * (1 - s.desktopActiveRatio) +
      weights.noInteraction * (1 - s.interactionRatio) +
      weights.still * still +
      weights.prior * priorVal
    )
  })
}

/**
 * ±1 slot 分数平滑（0.25/0.5/0.25）：近似专利「前后 p/q 个 slot 上下文窗口」的
 * 廉价实现——深夜短暂醒来（翻个身看手机 2 分钟）不会把睡眠段切成两截。
 */
export function smoothScores(scores: number[]): number[] {
  return scores.map((_, i) => {
    const prev = scores[i - 1] ?? scores[i]
    const next = scores[i + 1] ?? scores[i]
    return 0.25 * prev + 0.5 * scores[i] + 0.25 * next
  })
}

export interface SleepSegment {
  startSlot: number
  endSlot: number // 含
  startS: number
  endS: number
  avgScore: number
  slotCount: number
}

/**
 * 睡眠段组装（专利权利要求 7/8）：score ≥ threshold 的连续 slot 合并为段，
 * 中间间隔 ≤ gapSlots 个低分 slot 也合并（默认 m=1，即允许 30min 以内的清醒凹陷）。
 * 一天多段时由调用方取最长（longest-wins，专利权利要求 8）。
 */
export function assembleSleepSegments(
  dayStartS: number,
  smoothedScores: number[],
  threshold: number,
  gapSlots = 1,
): SleepSegment[] {
  const asleep = smoothedScores.map(s => s >= threshold)
  const segments: SleepSegment[] = []

  let runStart: number | null = null
  let gap = 0
  let scoreSum = 0
  let scoreCount = 0

  const flush = (endSlot: number) => {
    if (runStart == null) return
    segments.push({
      startSlot: runStart,
      endSlot,
      startS: dayStartS + runStart * SLOT_SECONDS,
      endS: dayStartS + (endSlot + 1) * SLOT_SECONDS,
      avgScore: scoreSum / scoreCount,
      slotCount: endSlot - runStart + 1,
    })
    runStart = null
    gap = 0
    scoreSum = 0
    scoreCount = 0
  }

  for (let i = 0; i < asleep.length; i++) {
    if (asleep[i]) {
      if (runStart == null) runStart = i
      gap = 0
      scoreSum += smoothedScores[i]
      scoreCount++
    } else if (runStart != null) {
      gap++
      if (gap > gapSlots) flush(i - gapSlots - 1)
    }
  }
  flush(asleep.length - 1 - gap)
  return segments
}

/** 一天多段时取最长段作为主睡眠（专利权利要求 8；午睡识别本期不做，直接忽略其余段） */
export function mainSegment(segments: SleepSegment[]): SleepSegment | null {
  if (segments.length === 0) return null
  return segments.reduce((a, b) => (b.slotCount > a.slotCount ? b : a))
}
