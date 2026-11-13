import { desc, gte, and, lte, ne } from 'drizzle-orm'
import {
  aiConversationSummaries,
  circadianLogs,
  dissociationDiary,
  userMemory,
  userSettings,
} from '../schema'
import type { Db } from '../client'

export interface ReviewData {
  weekRange: { start: string; end: string }
  weeklyInsight: { text: string; generatedAt: number | null } | null
  trends: Array<{
    date: string
    deepWorkHours: number
    dissociationCount: number
    interventionDismissRate: number
    sleepDebtHours: number
  }>
  peakHours: {
    workPeak: number | null
    distractionPeak: number | null
  }
  dissociationHistory: Array<{
    id: number
    startTime: number
    durationMs: number
    userChoice: string
  }>
  conversationSummaries: Array<{
    id: number
    dateRangeStart: string
    summary: string
  }>
  userMemory: {
    sleepPattern: string | null
    dissociationPattern: string | null
    moodTrend: string | null
    responseToIntervention: string | null
  }
}

function getWeekRange(now = new Date()): { start: Date; end: Date } {
  const end = new Date(now)
  const start = new Date(now)
  start.setDate(start.getDate() - 6)
  start.setHours(0, 0, 0, 0)
  end.setHours(23, 59, 59, 999)
  return { start, end }
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

export function getReviewData(db: Db): ReviewData {
  const { start, end } = getWeekRange()
  const startStr = formatDate(start)
  const endStr = formatDate(end)

  // 过去 7 天的 circadian_logs
  const rows = db
    .select()
    .from(circadianLogs)
    .where(and(gte(circadianLogs.date, startStr), lte(circadianLogs.date, endStr)))
    .orderBy(circadianLogs.date)
    .all()

  const trends = rows.map((r) => ({
    date: r.date,
    deepWorkHours: Math.round((r.deep_work_total_ms ?? 0) / 1000 / 60 / 60 * 10) / 10,
    dissociationCount: r.dissociation_count ?? 0,
    interventionDismissRate: r.intervention_dismiss_rate ?? 0,
    sleepDebtHours: r.sleep_debt_hours ?? 0,
  }))

  const latest = rows[rows.length - 1]
  const peakHours = {
    workPeak: latest?.peak_work_hour ?? null,
    distractionPeak: latest?.peak_distraction_hour ?? null,
  }

  // 解离日记——过去 7 天已确认（user_choice != 'ignored'）
  const startUnix = Math.floor(start.getTime() / 1000)
  const diary = db
    .select({
      id: dissociationDiary.id,
      startTime: dissociationDiary.period_start,
      endTime: dissociationDiary.period_end,
      userChoice: dissociationDiary.user_choice,
    })
    .from(dissociationDiary)
    .where(
      and(
        gte(dissociationDiary.confirmed_at, startUnix),
        ne(dissociationDiary.user_choice, 'ignored'),
      ),
    )
    .orderBy(desc(dissociationDiary.confirmed_at))
    .all()

  // 最近 5 条对话摘要
  const summaries = db
    .select({
      id: aiConversationSummaries.id,
      dateRangeStart: aiConversationSummaries.date_range_start,
      summary: aiConversationSummaries.summary,
    })
    .from(aiConversationSummaries)
    .orderBy(desc(aiConversationSummaries.date_range_start))
    .limit(5)
    .all()

  // 用户记忆
  const memoryRows = db.select().from(userMemory).all()
  const userMemoryMap: Record<string, string> = {}
  for (const row of memoryRows) {
    userMemoryMap[row.key] = row.value ?? ''
  }

  // weekly_insights
  const insightRow = db
    .select()
    .from(userSettings)
    .where(and(gte(userSettings.key, 'weekly_insights'), lte(userSettings.key, 'weekly_insights')))
    .get()

  let weeklyInsight: ReviewData['weeklyInsight'] = null
  if (insightRow?.value) {
    try {
      const parsed = JSON.parse(insightRow.value as string) as { text?: unknown; generated_at?: unknown }
      weeklyInsight = {
        text: String(parsed.text ?? ''),
        generatedAt: typeof parsed.generated_at === 'number' ? parsed.generated_at : null,
      }
    } catch {
      weeklyInsight = { text: String(insightRow.value), generatedAt: null }
    }
  }

  return {
    weekRange: { start: startStr, end: endStr },
    weeklyInsight,
    trends,
    peakHours,
    dissociationHistory: diary.map((d) => ({
      id: d.id,
      startTime: d.startTime,
      durationMs: (d.endTime - d.startTime) * 1000,
      userChoice: d.userChoice ?? '',
    })),
    conversationSummaries: summaries,
    userMemory: {
      sleepPattern: userMemoryMap['sleep_pattern'] || null,
      dissociationPattern: userMemoryMap['dissociation_pattern'] || null,
      moodTrend: userMemoryMap['mood_trend'] || null,
      responseToIntervention: userMemoryMap['response_to_intervention'] || null,
    },
  }
}
