import type { Db } from '@anchor/db'
import { aiConversationSummaries, chatMessages, userMemory } from '@anchor/db'
import { and, asc, eq, gte, lte } from 'drizzle-orm'
import { extractEmotionalSignal } from './emotional-signal'
import { getUserDateStr, userZonedTimeToUtc } from '../time/user-time'
import { chatCompletion, resolveAiConfig } from './provider'

export interface SummaryRange {
  start?: number
  end?: number
}

function getTodayRange(): { start: number; end: number } {
  const start = userZonedTimeToUtc(getUserDateStr(Date.now()), 0)
  return { start, end: start + 86400 - 1 }
}

export function getYesterdayRange(): { start: number; end: number } {
  const start = userZonedTimeToUtc(getUserDateStr(Date.now() - 24 * 60 * 60 * 1000), 0)
  return { start, end: start + 86400 - 1 }
}

function rangeKey(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString()
}

export async function generateConversationSummary(db: Db, opts: SummaryRange = {}): Promise<string | null> {
  const fallback = getTodayRange()
  const start = opts.start ?? fallback.start
  const end = opts.end ?? fallback.end
  const dateRangeStart = rangeKey(start)
  const dateRangeEnd = rangeKey(end)

  const existing = db
    .select()
    .from(aiConversationSummaries)
    .where(and(
      eq(aiConversationSummaries.date_range_start, dateRangeStart),
      eq(aiConversationSummaries.date_range_end, dateRangeEnd),
    ))
    .get()
  if (existing) return existing.summary

  const messages = db
    .select({ role: chatMessages.role, content: chatMessages.content })
    .from(chatMessages)
    .where(and(gte(chatMessages.created_at, start), lte(chatMessages.created_at, end)))
    .orderBy(asc(chatMessages.created_at))
    .all()

  if (messages.length < 3) return null

  const cfg = resolveAiConfig()
  if (!cfg) return null

  const transcript = messages.map(m => `${m.role === 'user' ? '用户' : 'Anchor'}：${m.content}`).join('\n')
  const prompt = `请阅读以下 Anchor 对话，生成一段不超过 200 字的中文摘要。重点关注：用户情绪状态、主要话题、是否出现解离/疲惫/饥饿/睡眠相关线索，以及 Anchor 的干预是否有效。不要评价用户，不要提出新建议。\n\n${transcript}`

  const res = await chatCompletion(cfg, {
    messages: [
      { role: 'system', content: '你是 Anchor 的对话摘要器，只输出简洁中文摘要。' },
      { role: 'user', content: prompt },
    ],
    max_tokens: 300,
    temperature: 0.3,
    signal: AbortSignal.timeout(10_000),
  })

  if (!res.ok) return null
  const data = await res.json() as { choices?: Array<{ message?: { content?: string } }> }
  const summary = data.choices?.[0]?.message?.content?.trim() ?? ''
  if (!summary) return null

  db.insert(aiConversationSummaries).values({
    date_range_start: dateRangeStart,
    date_range_end: dateRangeEnd,
    summary,
    created_at: Math.floor(Date.now() / 1000),
  }).run()

  // 对话结束后被动提取情绪信号，写入 userMemory
  const allContent = messages.map(m => m.content).join('\n')
  const emotionalSignal = extractEmotionalSignal(allContent)
  const nowS = Math.floor(Date.now() / 1000)
  db.insert(userMemory)
    .values({
      key: 'emotional_signal',
      value: JSON.stringify({ signal: emotionalSignal.signal, recordedAt: nowS }),
      updated_at: nowS,
    })
    .onConflictDoUpdate({
      target: userMemory.key,
      set: {
        value: JSON.stringify({ signal: emotionalSignal.signal, recordedAt: nowS }),
        updated_at: nowS,
      },
    })
    .run()

  return summary
}
