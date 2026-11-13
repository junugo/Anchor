import type { Db } from '@anchor/db'
import { chatMessages } from '@anchor/db'
import { desc, eq } from 'drizzle-orm'

export type ChatRole = 'user' | 'assistant'
export type InputChatMessage = { role: ChatRole | 'system'; content: string }

export function saveChatMessage(
  db: Db,
  role: ChatRole,
  content: string,
  createdAt = Math.floor(Date.now() / 1000),
  sessionId = 'legacy',
): void {
  const trimmed = content.trim()
  if (!trimmed) return

  db.insert(chatMessages).values({ session_id: sessionId, role, content: trimmed, created_at: createdAt }).run()
}

/** 按会话 ID 拉取消息（时序正序，供 AI context 使用） */
export function getSessionChatMessages(
  db: Db,
  sessionId: string,
  limit = 50,
): Array<{ role: ChatRole; content: string; created_at: number }> {
  return db
    .select({ role: chatMessages.role, content: chatMessages.content, created_at: chatMessages.created_at })
    .from(chatMessages)
    .where(eq(chatMessages.session_id, sessionId))
    .orderBy(desc(chatMessages.created_at))
    .limit(limit)
    .all()
    .reverse()
}

/** 兼容旧代码：不指定 sessionId 时拉取全局最近消息（摘要/记忆模块使用） */
export function getRecentChatMessages(db: Db, limit = 50): Array<{ role: ChatRole; content: string; created_at: number }> {
  return db
    .select({ role: chatMessages.role, content: chatMessages.content, created_at: chatMessages.created_at })
    .from(chatMessages)
    .orderBy(desc(chatMessages.created_at), desc(chatMessages.id))
    .limit(limit)
    .all()
    .reverse()
}

export function getLastUserMessage(messages: InputChatMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role === 'user' && message.content.trim()) return message.content.trim()
  }
  return null
}

export function extractAssistantDeltaFromSseLine(line: string): string {
  if (!line.startsWith('data: ')) return ''
  const data = line.slice(6).trim()
  if (!data || data === '[DONE]') return ''

  try {
    const chunk = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> }
    return chunk.choices?.[0]?.delta?.content ?? ''
  } catch {
    return ''
  }
}
