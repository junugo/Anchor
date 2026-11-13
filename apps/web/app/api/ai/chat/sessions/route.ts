import { NextRequest, NextResponse } from 'next/server'
import { desc, asc, eq, and } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { chatSessions, chatMessages } from '@anchor/db'
import { generateAndSaveOpeningMessage } from '@/lib/ai/sessionManager'
import { randomBytes } from 'crypto'

export async function GET() {
  const db = getDb()

  const sessions = db
    .select({
      id: chatSessions.id,
      session_id: chatSessions.session_id,
      created_at: chatSessions.created_at,
      last_message_at: chatSessions.last_message_at,
      opening_message: chatSessions.opening_message,
      title: chatSessions.title,
    })
    .from(chatSessions)
    .orderBy(desc(chatSessions.created_at))
    .limit(30)
    .all()

  // 为每个会话附加第一条用户消息作为预览
  const withPreviews = sessions.map(s => {
    const firstUser = db
      .select({ content: chatMessages.content })
      .from(chatMessages)
      .where(and(eq(chatMessages.session_id, s.session_id), eq(chatMessages.role, 'user')))
      .orderBy(asc(chatMessages.created_at))
      .get()

    return {
      ...s,
      preview: firstUser?.content.slice(0, 40) ?? null,
    }
  })

  return NextResponse.json(withPreviews)
}

/** 强制新建会话，生成开场白后返回 sessionId 和初始消息 */
export async function POST(_req: NextRequest) {
  const db = getDb()
  const now = Math.floor(Date.now() / 1000)
  const sessionId = `sess_${Date.now()}_${randomBytes(4).toString('hex')}`

  db.insert(chatSessions)
    .values({ session_id: sessionId, created_at: now, last_message_at: now, status: 'active' })
    .run()

  const opening = await generateAndSaveOpeningMessage(db, sessionId)
  return NextResponse.json({
    sessionId,
    isNew: true,
    messages: [{ role: 'assistant', content: opening, created_at: now }],
  })
}
