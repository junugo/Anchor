import { randomBytes } from 'crypto'
import { asc, desc, eq, gte } from 'drizzle-orm'
import {
  aiConversationSummaries,
  chatMessages,
  chatSessions,
  userLivingContext,
  userMemory,
  type Db,
} from '@anchor/db'
import { dbSeverityToLevel } from './roleCard'
import { nowContext } from './promptUtils'

/** 10 分钟无消息则视为新会话 */
export const SESSION_TIMEOUT_S = 10 * 60

export interface SessionResult {
  sessionId: string
  isNew: boolean
  messages: Array<{ role: 'user' | 'assistant'; content: string; created_at: number }>
}

/**
 * 返回当前活跃会话，或在超时/无会话时创建新会话。
 * 注意：开场白异步生成，调用者需自行处理 isNew 场景（前端 SSE 订阅
 * `/api/ai/chat/sessions/current` 时会拿到 opening_message 字段）。
 */
export function getCurrentOrCreateSession(db: Db): SessionResult {
  const now = Math.floor(Date.now() / 1000)

  // 查最近一条活跃会话
  const active = db
    .select()
    .from(chatSessions)
    .where(eq(chatSessions.status, 'active'))
    .orderBy(desc(chatSessions.last_message_at))
    .get()

  if (active && now - active.last_message_at < SESSION_TIMEOUT_S) {
    const messages = db
      .select({
        role: chatMessages.role,
        content: chatMessages.content,
        created_at: chatMessages.created_at,
      })
      .from(chatMessages)
      .where(eq(chatMessages.session_id, active.session_id))
      .orderBy(asc(chatMessages.created_at))
      .all()

    return { sessionId: active.session_id, isNew: false, messages }
  }

  // 创建新会话（开场白稍后异步写入，前端拿到 sessionId 后再 SSE 等待）
  const sessionId = `sess_${Date.now()}_${randomBytes(4).toString('hex')}`
  db.insert(chatSessions)
    .values({ session_id: sessionId, created_at: now, last_message_at: now, status: 'active' })
    .run()

  return { sessionId, isNew: true, messages: [] }
}

/**
 * 获取指定会话的消息列表（供历史查看路由使用）
 */
export function getSessionMessages(
  db: Db,
  sessionId: string,
): Array<{ role: 'user' | 'assistant'; content: string; created_at: number }> {
  return db
    .select({
      role: chatMessages.role,
      content: chatMessages.content,
      created_at: chatMessages.created_at,
    })
    .from(chatMessages)
    .where(eq(chatMessages.session_id, sessionId))
    .orderBy(asc(chatMessages.created_at))
    .all()
}

/** 获取最近 N 天的对话摘要，格式化为字符串列表 */
export function getRecentSummaries(db: Db, days: number): string[] {
  const cutoff = Math.floor(Date.now() / 1000) - days * 24 * 60 * 60
  return db
    .select({
      summary: aiConversationSummaries.summary,
      date: aiConversationSummaries.date_range_start,
    })
    .from(aiConversationSummaries)
    .where(gte(aiConversationSummaries.created_at, cutoff))
    .orderBy(desc(aiConversationSummaries.created_at))
    .limit(5)
    .all()
    .map(s => `${s.date.slice(0, 10)}: ${s.summary}`)
}

/**
 * 异步生成 AI 开场白并写入 DB（会话消息 + opening_message 字段）。
 * 对调用方透明——失败时静默降级为"我在这里。"。
 */
export async function generateAndSaveOpeningMessage(
  db: Db,
  sessionId: string,
): Promise<string> {
  const apiKey = process.env['DEEPSEEK_API_KEY']
  const fallback = '我在这里。'
  if (!apiKey) return _writeOpening(db, sessionId, fallback)

  try {
    const ctx = db
      .select({ severity_level: userLivingContext.severity_level })
      .from(userLivingContext)
      .where(eq(userLivingContext.user_id, 'default'))
      .get()
    const severityLevel = dbSeverityToLevel(ctx?.severity_level ?? null)
    const memory = db.select({ key: userMemory.key, value: userMemory.value }).from(userMemory).all()
    const summaries = getRecentSummaries(db, 3)

    const memStr = memory
      .filter(m => m.value.trim())
      .map(m => `${m.key}: ${m.value}`)
      .join('; ')

    const prompt = `你是 Anchor，现在是${nowContext()}，用户刚刚打开了对话框。
[状态] ${severityLevel}
${memStr ? `[记忆] ${memStr}` : ''}
${summaries.length > 0 ? `[最近对话]\n${summaries.join('\n')}` : ''}

请生成一句自然的开场问候（直接输出问候语，不要加引号或标签）：
- L0：轻松、自然，可提及时段或最近状态的轻盈观察
- L1：轻微关心，询问现在感觉怎样
- L2：关注身体感受（渴/饿/累/冷），不提工作
- L3：极简陪伴，只表示存在，例如"我在。"

20-50 字，语气像室友，不像机器人。`

    const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 100,
        temperature: 0.95,
      }),
      signal: AbortSignal.timeout(8000),
    })

    if (!res.ok) return _writeOpening(db, sessionId, fallback)
    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>
    }
    const text = data.choices?.[0]?.message?.content?.trim() || fallback
    return _writeOpening(db, sessionId, text)
  } catch {
    return _writeOpening(db, sessionId, fallback)
  }
}

function _writeOpening(db: Db, sessionId: string, text: string): string {
  const now = Math.floor(Date.now() / 1000)
  // 写入消息表
  db.insert(chatMessages)
    .values({ session_id: sessionId, role: 'assistant', content: text, created_at: now })
    .run()
  // 更新 opening_message 字段
  db.update(chatSessions)
    .set({ opening_message: text, last_message_at: now })
    .where(eq(chatSessions.session_id, sessionId))
    .run()
  return text
}
