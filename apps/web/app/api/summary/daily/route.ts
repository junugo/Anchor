import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { circadianLogs, stateSegments, sunsetConfig } from '@anchor/db'
import { and, desc, gt, gte, isNull, lt, or } from 'drizzle-orm'
import type { TimelineBlock, UserState } from '@anchor/types'
import { getUserDateStr, getUserLocalParts } from '@/lib/time/user-time'

const FALLBACK_BEDTIME_MINUTES = 90 // 01:30

function formatMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = minutes % 60
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
}

function getSuggestedBedtime(db: ReturnType<typeof getDb>): string {
  const config = db.select().from(sunsetConfig).limit(1).get()
  if (config?.target_bedtime_minutes !== undefined && config.target_bedtime_minutes !== null) {
    return formatMinutes(config.target_bedtime_minutes)
  }

  const today = getUserDateStr(Date.now())
  const todayLog = db
    .select({ sleep_start: circadianLogs.sleep_start })
    .from(circadianLogs)
    .where(gte(circadianLogs.date, today))
    .orderBy(desc(circadianLogs.date))
    .limit(1)
    .get()

  if (todayLog?.sleep_start) {
    const { hour, minute } = getUserLocalParts(todayLog.sleep_start * 1000)
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`
  }

  return formatMinutes(FALLBACK_BEDTIME_MINUTES)
}

// V1.8：数据源切换为 state_segments（旧实现统计 behavior_logs.inferred_state，
// 该字段仅睡眠哨兵行有值，导致非睡眠全部回落 resting）
function buildTimeline(db: ReturnType<typeof getDb>): TimelineBlock[] {
  const now = Math.floor(Date.now() / 1000)
  const start = now - 24 * 3600

  const rows = db
    .select()
    .from(stateSegments)
    .where(and(
      lt(stateSegments.started_at, now),
      or(isNull(stateSegments.ended_at), gt(stateSegments.ended_at, start)),
    ))
    .orderBy(stateSegments.started_at)
    .all()

  const blocks: TimelineBlock[] = []
  for (const r of rows) {
    const s = Math.max(r.started_at, start)
    const e = Math.min(r.ended_at ?? now, now)
    if (e <= s) continue
    const last = blocks[blocks.length - 1]
    if (last && last.state === r.state && last.end_time >= s) {
      last.end_time = e
    } else {
      blocks.push({ start_time: s, end_time: e, state: r.state as UserState })
    }
  }
  return blocks
}

function buildAiSummary(timeline: TimelineBlock[]): string {
  const totalSeconds = timeline.reduce((sum, b) => sum + (b.end_time - b.start_time), 0)
  if (totalSeconds === 0) return '过去 24 小时还没有足够的行为数据。'

  const stateSeconds: Record<string, number> = {}
  for (const block of timeline) {
    stateSeconds[block.state] = (stateSeconds[block.state] ?? 0) + (block.end_time - block.start_time)
  }

  const stateHours = Object.fromEntries(
    Object.entries(stateSeconds).map(([k, v]) => [k, (v / 3600).toFixed(1)]),
  )

  const parts: string[] = []
  if (stateHours['working']) parts.push(`工作 ${stateHours['working']}h`)
  if (stateHours['entertaining']) parts.push(`娱乐 ${stateHours['entertaining']}h`)
  if (stateHours['dissociating']) parts.push(`解离 ${stateHours['dissociating']}h`)
  if (stateHours['resting']) parts.push(`休息 ${stateHours['resting']}h`)
  if (stateHours['sleeping']) parts.push(`睡眠 ${stateHours['sleeping']}h`)
  if (stateHours['away']) parts.push(`在校 ${stateHours['away']}h`)

  let summary = `过去 24 小时：${parts.join(' / ')}。`

  if ((stateSeconds['dissociating'] ?? 0) > 3600) {
    summary += ' 解离时间偏长，睡前可以补一段低刺激过渡。'
  } else if ((stateSeconds['working'] ?? 0) > 8 * 3600) {
    summary += ' 工作强度较高，注意在睡前留出缓冲。'
  } else if ((stateSeconds['resting'] ?? 0) > 12 * 3600) {
    summary += ' 休息较多，明天可以尝试一个更具体的小目标。'
  } else {
    summary += ' 节律整体平稳。'
  }

  return summary
}

export function GET() {
  const db = getDb()
  const timeline = buildTimeline(db)
  const ai_summary = buildAiSummary(timeline)
  const suggested_bedtime = getSuggestedBedtime(db)

  return NextResponse.json({
    timeline,
    ai_summary,
    suggested_bedtime,
    generated_at: Math.floor(Date.now() / 1000),
  })
}
