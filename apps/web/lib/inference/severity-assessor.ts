import type { Db } from '@anchor/db'
import type { DbSeverityLevel } from '@anchor/types'
import { circadianLogs, userLivingContext, userMemory } from '@anchor/db'
import { desc, eq, gte, inArray } from 'drizzle-orm'
import { getUserDateStr } from '../time/user-time'

/**
 * 三信号融合严重度评估器
 *
 * 读取三路被动信号计算 L0–L3 (DbSeverityLevel)：
 *   1. 被动数据    — circadian_logs（睡眠偏移、娱乐时长、连续解离天数）
 *   2. 主动自填    — userMemory.self_report（1-5 主观评分，最近 24h 内有效）
 *   3. AI 对话提取 — userMemory.emotional_signal（distress/withdrawal/stable）
 *
 * 等级下降需连续 24 小时稳定才生效（防止单次好数据误判恢复）。
 */

// 娱乐时长阈值（毫秒）
const ENTERTAIN_L1_MS = 2 * 60 * 60 * 1000  // 2h/天
const ENTERTAIN_L2_MS = 4 * 60 * 60 * 1000  // 4h/天

// 睡眠偏移阈值（秒）
const SLEEP_OFFSET_L1_S = 30 * 60  // 30 分钟
const SLEEP_OFFSET_L2_S = 90 * 60  // 90 分钟

// 连续解离/失调天数
const CONSECUTIVE_DAYS_L2 = 2
const CONSECUTIVE_DAYS_L3 = 3

// 自填评分映射（1-5 → 严重程度分）
// 评分 1-2 = 严重，3 = 中度，4 = 轻微，5 = 正常
function selfReportScore(score: number): number {
  if (score <= 2) return 3  // 严重
  if (score === 3) return 2  // 中度
  if (score === 4) return 1  // 轻微
  return 0                   // 正常
}

// 情绪信号权重
function emotionalSignalScore(signal: string): number {
  if (signal === 'distress') return 3   // 权重最高（AI 对话是高置信度信号）
  if (signal === 'withdrawal') return 2
  return 0  // stable
}

/**
 * 读取最近 N 天的 circadian_logs
 */
function getRecentCircadianLogs(db: Db, days: number) {
  const dateStr = getUserDateStr(Date.now() - days * 24 * 60 * 60 * 1000)
  return db
    .select()
    .from(circadianLogs)
    .where(gte(circadianLogs.date, dateStr))
    .orderBy(desc(circadianLogs.date))
    .all()
}

/**
 * 读取 userMemory 键值（JSON 解析，失败返回 null）。
 * 接受预加载的行列表（避免多次全表扫描）。
 */
function parseMemoryRow(
  rows: Array<{ key: string; value: string; updated_at: number }>,
  key: string,
): Record<string, unknown> | null {
  const row = rows.find(r => r.key === key)
  if (!row) return null
  try {
    return { ...(JSON.parse(row.value) as Record<string, unknown>), _updated_at: row.updated_at }
  } catch {
    return null
  }
}

/**
 * 将综合得分映射到 DbSeverityLevel
 * 得分 ≥ 6 → L3，≥ 4 → L2，≥ 2 → L1，else → L0
 */
function scoreToDbLevel(score: number): DbSeverityLevel {
  if (score >= 6) return 'L3'
  if (score >= 4) return 'L2'
  if (score >= 2) return 'L1'
  return 'L0'
}

/**
 * 计算当前严重度等级。
 *
 * 24h 下降迟滞规则：
 * - 如果新计算的等级低于当前存储等级，只有当 severity_changed_at
 *   距今超过 24 小时（代表已在当前等级上持续稳定 24h），才允许下降。
 * - 等级上升无延迟，立即生效。
 * - 注意：不能用 user_living_context.updated_at 计时——它每个 full tick 都刷新，
 *   会导致稳定时长恒为 0、等级永不下降。severity_changed_at 为 NULL（历史行）时
 *   视为「已久远」，允许下降（自愈旧库中被卡住的等级）。
 */
export function computeSeverityLevel(db: Db, nowMs: number): DbSeverityLevel {
  const nowS = Math.floor(nowMs / 1000)

  // ── 第一路：被动数据 ──────────────────────────────────────────
  let passiveScore = 0

  const recentLogs = getRecentCircadianLogs(db, 7)
  const todayLogs = recentLogs.slice(0, 3) // 最近 3 天

  // 计算睡眠偏移量（以就寝目标为基准）
  // circadian_logs.sleep_start 是今日实际入睡时间（Unix 秒）
  // 目标就寝时间：取 sunsetConfig.target_bedtime_minutes（午夜后分钟数）
  // 简化：若 sleep_start 存在，计算当日凌晨0点到 sleep_start 的分钟数，看偏移
  const sleepOffsets = todayLogs
    .filter(l => l.sleep_start !== null)
    .map(l => {
      // sleep_start 对应的日期凌晨0点
      const d = new Date(l.date + 'T00:00:00')
      const dayStartS = Math.floor(d.getTime() / 1000)
      // 偏移 = 实际入睡 - 日期开始（秒）
      // 若 sleep_start 超过次日4时则视为极端偏移
      return (l.sleep_start! - dayStartS)
    })

  // 最近 1 天睡眠偏移（秒）
  const recentSleepOffset = sleepOffsets.length > 0 ? sleepOffsets[0] : 0

  // 连续天数偏移统计
  const consecutiveHighOffsetDays = sleepOffsets.filter(o => o > SLEEP_OFFSET_L2_S).length

  if (consecutiveHighOffsetDays >= CONSECUTIVE_DAYS_L3) {
    passiveScore += 4  // 连续 3 天极端偏移 → 接近 critical
  } else if (consecutiveHighOffsetDays >= CONSECUTIVE_DAYS_L2) {
    passiveScore += 3
  } else if (recentSleepOffset > SLEEP_OFFSET_L2_S) {
    passiveScore += 2
  } else if (recentSleepOffset > SLEEP_OFFSET_L1_S) {
    passiveScore += 1
  }

  // 娱乐时长（从 circadian_logs.dissociation_total_ms 近似；若无则检查 deep_work_total_ms=0 + dissociation_count）
  if (todayLogs.length > 0) {
    const todayLog = todayLogs[0]
    const entertainMs = todayLog.dissociation_total_ms ?? 0

    // 连续两天娱乐超时
    const entertainExcessDays = todayLogs.filter(l => (l.dissociation_total_ms ?? 0) > ENTERTAIN_L2_MS).length
    if (entertainExcessDays >= CONSECUTIVE_DAYS_L2) {
      passiveScore += 3
    } else if (entertainMs > ENTERTAIN_L2_MS) {
      passiveScore += 2
    } else if (entertainMs > ENTERTAIN_L1_MS) {
      passiveScore += 1
    }
  }

  // 连续解离天数（dissociation_count > 0 视为当日解离）
  let consecutiveDissociationDays = 0
  for (const l of recentLogs) {
    if ((l.dissociation_count ?? 0) > 0) {
      consecutiveDissociationDays++
    } else {
      break
    }
  }
  if (consecutiveDissociationDays >= CONSECUTIVE_DAYS_L3) {
    passiveScore += 3
  } else if (consecutiveDissociationDays >= CONSECUTIVE_DAYS_L2) {
    passiveScore += 2
  }

  // ── 第二路：主动自填（24h 内有效）────────────────────────────
  // 仅加载评估所需的两个记忆键，避免每 tick 全表扫描
  const memoryRows = db
    .select({ value: userMemory.value, updated_at: userMemory.updated_at, key: userMemory.key })
    .from(userMemory)
    .where(inArray(userMemory.key, ['self_report', 'emotional_signal']))
    .all()

  const selfReport = parseMemoryRow(memoryRows, 'self_report')
  if (selfReport) {
    const reportAge = nowS - (Number(selfReport['_updated_at'] ?? 0))
    if (reportAge < 24 * 3600) {
      const score = Number(selfReport['score'] ?? 5)
      passiveScore += selfReportScore(score)
    }
  }

  // ── 第三路：AI 对话提取（24h 内有效）────────────────────────
  const emotionalSignalData = parseMemoryRow(memoryRows, 'emotional_signal')
  if (emotionalSignalData) {
    const signalAge = nowS - (Number(emotionalSignalData['_updated_at'] ?? 0))
    if (signalAge < 24 * 3600) {
      const signal = String(emotionalSignalData['signal'] ?? 'stable')
      passiveScore += emotionalSignalScore(signal)
    }
  }

  // ── 偏差校正：主观与被动不符时触发追问信号（记录用，暂不阻断评估）──
  // 如未来需要实现追问，可在此处检查 selfReport 与 passiveScore 的差异

  // ── 映射为 DbSeverityLevel ────────────────────────────────────
  const newLevel = scoreToDbLevel(passiveScore)

  // ── 24h 下降迟滞守卫 ──────────────────────────────────────────
  const current = db
    .select({ severity_level: userLivingContext.severity_level, severity_changed_at: userLivingContext.severity_changed_at })
    .from(userLivingContext)
    .where(eq(userLivingContext.user_id, 'default'))
    .get()

  if (current?.severity_level && newLevel !== current.severity_level) {
    const levelOrder: Array<DbSeverityLevel> = ['L0', 'L1', 'L2', 'L3']
    const currentIdx = levelOrder.indexOf(current.severity_level)
    const newIdx = levelOrder.indexOf(newLevel)

    // 仅对下降方向执行迟滞守卫
    if (newIdx < currentIdx) {
      // NULL（历史行）视为已久远，允许下降；否则须在当前等级上稳定满 24h
      const stableForSeconds = current.severity_changed_at == null
        ? Number.MAX_SAFE_INTEGER
        : nowS - current.severity_changed_at
      if (stableForSeconds < 24 * 3600) {
        // 尚未稳定 24 小时，维持当前等级不下降
        return current.severity_level
      }
    }
  }

  return newLevel
}
