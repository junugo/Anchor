import type { Db } from '@anchor/db'
import { circadianLogs } from '@anchor/db'
import { gte } from 'drizzle-orm'
import type { SunsetAnchorMode } from '@anchor/types'
import { getSunsetConfig } from '../sunset/config'
import { getUserDateStr, getUserSunsetBedtimeAt, userZonedTimeToUtc } from '../time/user-time'
import { SLOT_COUNT, SLOT_MINUTES } from './slots'

/**
 * 个人节律先验层：专利里「±24 slot 上下文窗口 + 监督模型跨用户泛化」的单用户版本。
 *
 * 从 circadian_logs 的历史确认睡眠（手动点睡 / 确认框 auto-confirm / wakeup 结算，
 * 都是人工确认过的真值）学习 48 维 slot 直方图：prior[slot] = 该 slot 落在历史
 * 睡眠内的加权天数占比。指数衰减（半衰期 10 天）让最近的节律权重更高。
 *
 * 防污染：每天只取最长睡眠段（longest-wins，专利权利要求 8）——上学日的 phantom
 * 午睡不会压过真实夜睡（2026-09 开学周事故的教训）；彻底清洗由 reconcile.ts 负责。
 */

const PRIOR_HALF_LIFE_DAYS = 10
const PRIOR_LOOKBACK_DAYS = 30
/** 先验主段判定阈值：prior 连续 ≥ 该值的 slot 视为「通常睡眠带」 */
const BAND_THRESHOLD = 0.5
/** 单次睡眠超过 16h 视为脏数据，不参与先验（正常睡眠 ≤ 12h，留余量） */
const MAX_SLEEP_DURATION_MINUTES = 16 * 60

export type SleepPrior = number[] // 48 维，0–1

/**
 * 构造 48 维睡眠先验。无历史数据时返回 null（调用方回退静态 target_bedtime）。
 * excludeDate：跳过该睡眠日的记录（reconcile 校验某天时不让当日的 phantom 记录污染先验）。
 */
export function buildSleepPrior(db: Db, nowMs = Date.now(), excludeDate?: string): SleepPrior | null {
  const cutoff = getUserDateStr(nowMs - PRIOR_LOOKBACK_DAYS * 24 * 60 * 60 * 1000)
  const rows = db
    .select({ date: circadianLogs.date, sleep_start: circadianLogs.sleep_start, sleep_end: circadianLogs.sleep_end })
    .from(circadianLogs)
    .where(gte(circadianLogs.date, cutoff))
    .all()
    .filter(r => r.sleep_start != null && r.sleep_end != null && r.sleep_end > r.sleep_start && r.date !== excludeDate)

  if (rows.length === 0) return null

  // 入睡/起床归一化到「睡眠日起点的相对分钟」：睡眠日常跨午夜，end 会 > 1440，
  // slot 取模 48 后自然环绕
  const weightedCover = new Array<number>(SLOT_COUNT).fill(0)
  let totalWeight = 0

  for (const row of rows) {
    const dayStartS = userZonedTimeToUtc(row.date, 0)
    const startMin = (row.sleep_start! - dayStartS) / 60
    const endMin = (row.sleep_end! - dayStartS) / 60
    const durationMin = endMin - startMin
    if (durationMin <= 0 || durationMin > MAX_SLEEP_DURATION_MINUTES) continue

    const ageDays = (nowMs - new Date(`${row.date}T12:00:00`).getTime()) / (24 * 60 * 60 * 1000)
    const weight = Math.pow(0.5, Math.max(0, ageDays) / PRIOR_HALF_LIFE_DAYS)

    const startSlot = Math.floor(startMin / SLOT_MINUTES)
    const endSlot = Math.floor((endMin - 1) / SLOT_MINUTES)
    for (let s = startSlot; s <= endSlot; s++) {
      weightedCover[((s % SLOT_COUNT) + SLOT_COUNT) % SLOT_COUNT] += weight
    }
    totalWeight += weight
  }

  if (totalWeight === 0) return null

  const prior = weightedCover.map(c => Math.min(1, c / totalWeight))
  return smoothPrior(prior)
}

/** 先验 ±1 slot 平滑（0.25/0.5/0.25），抹平历史入睡点的抖动 */
function smoothPrior(prior: SleepPrior): SleepPrior {
  return prior.map((_, i) => {
    const prev = prior[(i - 1 + SLOT_COUNT) % SLOT_COUNT]
    const next = prior[(i + 1) % SLOT_COUNT]
    return 0.25 * prev + 0.5 * prior[i] + 0.25 * next
  })
}

export interface PredictedSleepWindow {
  /** 预测入睡带起点（用户本地分钟数，slot 对齐） */
  startMinutes: number
  /** 预测起床带终点（用户本地分钟数） */
  endMinutes: number
  /** 睡眠带中心的圆加权均值（用户本地分钟数）：供 M3/M4 精细锚定使用 */
  centerMinutes: number
  /** 习惯睡眠带的圆加权标准差（分钟）：反映带宽而非入睡点抖动，M4 用作窗口外扩余量 */
  stdMinutes: number
  /** 主段平均先验强度 [0,1]，置信度 */
  confidence: number
  /** true = 有历史数据；false = 回退静态 target_bedtime */
  fromHistory: boolean
}

interface Band {
  startSlot: number
  endSlot: number
}

/**
 * 预测今晚睡眠窗：先验主段（prior ≥ 0.5 的最长连续带，允许跨午夜环绕）的
 * 圆加权均值作为预测入睡/起床点。无历史时回退 sunset_config.target_bedtime_minutes
 * ± 60min（保持旧静态行为）。
 *
 * priorOverride：调用方已构建好的先验直接传入（避免每个 tick 重复扫描 30 天记录）；
 * 传 null 表示「明确无历史」，与未传入（内部现算）区分对待但不影响结果。
 */
export function predictSleepWindow(db: Db, nowMs = Date.now(), priorOverride?: SleepPrior | null): PredictedSleepWindow {
  const prior = priorOverride !== undefined ? priorOverride : buildSleepPrior(db, nowMs)
  const config = getSunsetConfig()
  const fallback: PredictedSleepWindow = {
    startMinutes: config.target_bedtime_minutes,
    endMinutes: (config.target_bedtime_minutes + 8 * 60) % (24 * 60),
    centerMinutes: config.target_bedtime_minutes,
    stdMinutes: 60,
    confidence: 0,
    fromHistory: false,
  }

  if (!prior) return fallback
  const band = mainBand(prior)
  if (!band) return fallback

  const slotsInBand = bandSlots(band)
  const weightSum = slotsInBand.reduce((a, s) => a + prior[s], 0)
  if (weightSum === 0) return fallback

  // 圆加权均值：睡眠带跨午夜，线性均值会被 23:xx 和 0:xx 拉崩
  let sinSum = 0
  let cosSum = 0
  for (const s of slotsInBand) {
    const angle = ((s * SLOT_MINUTES + SLOT_MINUTES / 2) / (24 * 60)) * 2 * Math.PI
    sinSum += prior[s] * Math.sin(angle)
    cosSum += prior[s] * Math.cos(angle)
  }
  const meanAngle = Math.atan2(sinSum / weightSum, cosSum / weightSum)
  const centerMinutes = ((meanAngle / (2 * Math.PI)) * 24 * 60 + 24 * 60) % (24 * 60)

  // 圆加权标准差（合成向量长度的离散度）
  const R = Math.sqrt(sinSum * sinSum + cosSum * cosSum) / weightSum
  const stdMinutes = Math.sqrt(Math.max(0, -2 * Math.log(Math.max(R, 1e-6)))) * (24 * 60) / (2 * Math.PI)

  return {
    startMinutes: band.startSlot * SLOT_MINUTES,
    endMinutes: ((band.endSlot + 1) * SLOT_MINUTES) % (24 * 60),
    centerMinutes,
    stdMinutes: Math.min(stdMinutes, 240),
    confidence: weightSum / slotsInBand.length,
    fromHistory: true,
  }
}

/**
 * 倒数相位锚点：按 sunset_config.anchor_mode 把「配置时间」与「学习带起点」合成
 * T-60/T30/T15/T0 的倒数锚。tick 广播 / WS 握手 / /api/status / 宵禁窗口判定共用此处，
 * 保证同一真相；睡眠引擎的被动探测仍直接用 predictSleepWindow（真实节律，不吃钳制）。
 */
export interface SunsetAnchor {
  /** 倒数锚点（用户本地分钟数）：T-60 = 锚点前 60 分钟 */
  startMinutes: number
  /** T0 保护带终点（用户本地分钟数，支持跨午夜环绕） */
  endMinutes: number
  mode: SunsetAnchorMode
  /** 学习带起点（无历史时 = 配置兜底值），供日志/调试 */
  bandStart: number
  bandEnd: number
  fromHistory: boolean
}

export function resolveSunsetAnchor(db: Db, nowMs = Date.now(), bandOverride?: PredictedSleepWindow): SunsetAnchor {
  const config = getSunsetConfig()
  const band = bandOverride ?? predictSleepWindow(db, nowMs)
  const mode: SunsetAnchorMode = config.anchor_mode ?? 'config_hard'

  let startMinutes: number
  if (mode === 'progressive') {
    // 渐进托管：target_bedtime_minutes 由渐进引擎每日写回（lib/sunset/progressive.ts），
    // 倒数等价 config_hard 读托管值；学习带仍只服务被动入睡探测，不吃钳制
    startMinutes = config.target_bedtime_minutes
  } else if (band.fromHistory && mode === 'adaptive_soft') {
    // 完全学习：配置时间不参与倒数
    startMinutes = band.startMinutes
  } else if (band.fromHistory && mode === 'adaptive_clamped') {
    // 取更晚者用「下一次出现时刻」比较（环形语义，跨午夜不能靠数值大小）：
    // 学习可推迟锚点，配置保证倒数不早于配置时间
    const bandAt = getUserSunsetBedtimeAt(nowMs, band.startMinutes)
    const configAt = getUserSunsetBedtimeAt(nowMs, config.target_bedtime_minutes)
    startMinutes = configAt > bandAt ? config.target_bedtime_minutes : band.startMinutes
  } else {
    // config_hard（或无历史兜底）：锚定配置时间
    startMinutes = config.target_bedtime_minutes
  }

  // T0 保护带终点仍取学习值（若有）；钳制被推迟的锚不得让带退化（end 须晚于 start 至少 1h）
  let endMinutes = band.fromHistory ? band.endMinutes : (startMinutes + 8 * 60) % (24 * 60)
  const forwardSpan = (endMinutes - startMinutes + 24 * 60) % (24 * 60)
  if (forwardSpan < 60) endMinutes = (startMinutes + 8 * 60) % (24 * 60)

  return { startMinutes, endMinutes, mode, bandStart: band.startMinutes, bandEnd: band.endMinutes, fromHistory: band.fromHistory }
}

/** 先验主段：prior ≥ BAND_THRESHOLD 的最长连续 slot 带，允许跨午夜环绕 */
function mainBand(prior: SleepPrior): Band | null {  const inBand = prior.map(p => p >= BAND_THRESHOLD)
  const count = inBand.filter(Boolean).length
  if (count === 0) return null
  if (count === SLOT_COUNT) return { startSlot: 0, endSlot: SLOT_COUNT - 1 }

  // 环绕展开：把数组复制两份，找最长 true 连续带
  const doubled = [...inBand, ...inBand]
  let bestStart = 0
  let bestLen = 0
  let curStart = -1
  for (let i = 0; i < doubled.length; i++) {
    if (doubled[i]) {
      if (curStart === -1) curStart = i
      const len = i - curStart + 1
      if (len > bestLen) {
        bestLen = len
        bestStart = curStart
      }
    } else {
      curStart = -1
    }
  }
  if (bestLen === 0 || bestLen > SLOT_COUNT) return null
  return { startSlot: bestStart % SLOT_COUNT, endSlot: (bestStart + bestLen - 1) % SLOT_COUNT }
}

/** 主段覆盖的全部 slot（环绕时按展开顺序返回） */
function bandSlots(band: Band): number[] {
  const slots: number[] = []
  let s = band.startSlot
  while (true) {
    slots.push(s)
    if (s === band.endSlot) break
    s = (s + 1) % SLOT_COUNT
  }
  return slots
}
