import { NextRequest, NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { getDb } from '@/lib/db'
import { chatSessions, chatMessages } from '@anchor/db'
import { getSessionMessages } from '@/lib/ai/sessionManager'

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params
  if (!sessionId) {
    return NextResponse.json({ error: 'sessionId required' }, { status: 400 })
  }

  const db = getDb()
  const messages = getSessionMessages(db, sessionId)

  return NextResponse.json({ sessionId, messages })
}

/** 重命名会话 */
export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params
  if (!sessionId) {
    return NextResponse.json({ error: 'sessionId required' }, { status: 400 })
  }

  const body = await req.json().catch(() => null) as { title?: string } | null
  const title = body?.title?.trim()
  if (!title) {
    return NextResponse.json({ error: 'title required' }, { status: 400 })
  }

  const db = getDb()
  db.update(chatSessions)
    .set({ title: title.slice(0, 50) })
    .where(eq(chatSessions.session_id, sessionId))
    .run()

  return NextResponse.json({ success: true })
}

/** 硬删除会话及其全部消息 */
export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ sessionId: string }> },
) {
  const { sessionId } = await params
  if (!sessionId) {
    return NextResponse.json({ error: 'sessionId required' }, { status: 400 })
  }

  const db = getDb()
  db.delete(chatMessages).where(eq(chatMessages.session_id, sessionId)).run()
  db.delete(chatSessions).where(eq(chatSessions.session_id, sessionId)).run()

  return NextResponse.json({ success: true })
}
