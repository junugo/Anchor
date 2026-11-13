import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { getCurrentOrCreateSession, generateAndSaveOpeningMessage } from '@/lib/ai/sessionManager'

export async function GET() {
  const db = getDb()
  const result = getCurrentOrCreateSession(db)

  if (result.isNew) {
    // 异步生成开场白，不阻塞响应——前端拿到 sessionId 后轮询或用 SSE 等待
    // 这里直接 await，开场白生成通常 <3s，可接受
    const opening = await generateAndSaveOpeningMessage(db, result.sessionId)
    result.messages = [{ role: 'assistant', content: opening, created_at: Math.floor(Date.now() / 1000) }]
  }

  return NextResponse.json({
    sessionId: result.sessionId,
    isNew: result.isNew,
    messages: result.messages,
  })
}
