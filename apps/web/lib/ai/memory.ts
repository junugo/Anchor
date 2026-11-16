import type { Db } from '@anchor/db'
import { behaviorLogs, circadianLogs, schoolSchedule, userMemory } from '@anchor/db'
import { desc, gte } from 'drizzle-orm'
import { getUserDateStr } from '../time/user-time'
import { getRecentChatMessages } from './chatHistory'
import { chatCompletion, resolveAiConfig } from './provider'

function fmtMinutes(m: number): string {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

export const MEMORY_KEYS = ['sleep_pattern', 'dissociation_pattern', 'mood_trend', 'response_to_intervention'] as const
export type MemoryKey = typeof MEMORY_KEYS[number]
export type MemoryUpdate = Record<MemoryKey, string>

export interface UpdateUserMemoryOptions {
  force?: boolean
  now?: number
}

export function shouldUpdateUserMemory(rows: Array<{ updated_at: number }>, now: number): boolean {
  if (rows.length < MEMORY_KEYS.length) return true
  const newest = Math.max(...rows.map(row => row.updated_at))
  return newest + 6 * 60 * 60 <= now
}

export function parseMemoryResponse(content: string): MemoryUpdate {
  const cleaned = content
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim()
  const parsed = JSON.parse(cleaned) as Partial<Record<MemoryKey, unknown>>

  return {
    sleep_pattern: String(parsed.sleep_pattern ?? '').trim(),
    dissociation_pattern: String(parsed.dissociation_pattern ?? '').trim(),
    mood_trend: String(parsed.mood_trend ?? '').trim(),
    response_to_intervention: String(parsed.response_to_intervention ?? '').trim(),
  }
}

function sevenDayCutoffs(now: number): { unix: number; date: string } {
  const start = now - 7 * 24 * 60 * 60
  return { unix: start, date: getUserDateStr(start * 1000) }
}

export async function updateUserMemory(db: Db, opts: UpdateUserMemoryOptions = {}): Promise<boolean> {
  const now = opts.now ?? Math.floor(Date.now() / 1000)
  const currentMemory = db.select().from(userMemory).all()

  if (!opts.force && !shouldUpdateUserMemory(currentMemory, now)) return false

  const cfg = resolveAiConfig()
  if (!cfg) return false

  const cutoffs = sevenDayCutoffs(now)
  const behavior = db
    .select({ source: behaviorLogs.source, event_type: behaviorLogs.event_type, logged_at: behaviorLogs.logged_at })
    .from(behaviorLogs)
    .where(gte(behaviorLogs.logged_at, cutoffs.unix))
    .orderBy(desc(behaviorLogs.logged_at))
    .all()
  const circadian = db
    .select({
      date: circadianLogs.date,
      sleep_start: circadianLogs.sleep_start,
      sleep_end: circadianLogs.sleep_end,
      sleep_debt_hours: circadianLogs.sleep_debt_hours,
      dissociation_risk_score: circadianLogs.dissociation_risk_score,
    })
    .from(circadianLogs)
    .where(gte(circadianLogs.date, cutoffs.date))
    .all()
  const chat = getRecentChatMessages(db, 20)

  // 上学日程事实：防止把上学日白天空白误读为「白天睡觉/解离」写进长期观察
  const school = db.select().from(schoolSchedule).get()
  const schoolFact = school?.enabled
    ? `用户是学生：上学日 ${fmtMinutes(school.leave_minute)}–${fmtMinutes(school.home_minute)} 在校且不带电子设备（次日按 ${fmtMinutes(school.wake_estimate_minute)} 估算起床），白天设备静默是日程预期，不是白天睡觉也不是解离。`
    : '无学校日程配置。'

  const eventCounts = behavior.reduce<Record<string, number>>((acc, row) => {
    const key = `${row.source}:${row.event_type}`
    acc[key] = (acc[key] ?? 0) + 1
    return acc
  }, {})

  const prompt = `请基于 Anchor 最近 7 天行为数据、睡眠数据、最近对话和旧 memory，更新用户状态观察。只输出 JSON，不要 Markdown。JSON 必须包含四个字符串字段：sleep_pattern、dissociation_pattern、mood_trend、response_to_intervention。每个字段用一句中文自然语言，不评价用户，不使用命令式语气。\n\n日程事实：${schoolFact}\n\n行为事件计数：${JSON.stringify(eventCounts)}\n\n节律数据：${JSON.stringify(circadian)}\n\n最近对话：${JSON.stringify(chat)}\n\n旧 memory：${JSON.stringify(currentMemory)}`

  const res = await chatCompletion(cfg, {
    messages: [
      { role: 'system', content: '你是 Anchor 的用户状态 memory 提炼器，只输出 JSON。' },
      { role: 'user', content: prompt },
    ],
    max_tokens: 500,
    temperature: 0.2,
    signal: AbortSignal.timeout(10_000),
  })

  if (!res.ok) return false
  const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> }
  const content = data.choices?.[0]?.message?.content ?? ''

  let parsed: MemoryUpdate
  try {
    parsed = parseMemoryResponse(content)
  } catch {
    return false
  }

  for (const key of MEMORY_KEYS) {
    db.insert(userMemory)
      .values({ key, value: parsed[key], updated_at: now })
      .onConflictDoUpdate({
        target: userMemory.key,
        set: { value: parsed[key], updated_at: now },
      })
      .run()
  }

  return true
}
