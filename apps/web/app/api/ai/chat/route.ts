import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { buildAnchorRoleCard, dbSeverityToLevel } from '@/lib/ai/roleCard'
import type { SeverityLevel, ChatTrigger } from '@/lib/ai/roleCard'
import { extractAssistantDeltaFromSseLine, getLastUserMessage, getSessionChatMessages, saveChatMessage, type InputChatMessage } from '@/lib/ai/chatHistory'
import { chatCompletion, resolveAiConfig } from '@/lib/ai/provider'
import { chatSessions, userLivingContext } from '@anchor/db'
import { eq } from 'drizzle-orm'
import { nowContext } from '@/lib/ai/promptUtils'

export async function GET() {
  // 会话查询统一走 /api/ai/chat/sessions/current，此接口保留作向下兼容
  return NextResponse.json([])
}

export async function POST(req: NextRequest) {
  const body = await req.json() as {
    sessionId?: string
    messages?: InputChatMessage[]
    severityLevel?: SeverityLevel
    trigger?: ChatTrigger
  } | null
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'invalid request body' }, { status: 400 })
  }

  if (!body.sessionId) {
    return NextResponse.json({ error: 'sessionId required' }, { status: 400 })
  }
  const sessionId = body.sessionId

  const cfg = resolveAiConfig()
  if (!cfg) {
    return NextResponse.json({ error: 'AI 未配置：请设置 ANCHOR_AI_API_KEY 环境变量' }, { status: 503 })
  }

  const db = getDb()
  const trigger = body.trigger ?? 'user'

  // 若调用方未传 severityLevel，从 user_living_context 读取当前真实等级
  let severityLevel: SeverityLevel = body.severityLevel ?? 'L0'
  if (!body.severityLevel) {
    const ctx = db
      .select({ severity_level: userLivingContext.severity_level })
      .from(userLivingContext)
      .where(eq(userLivingContext.user_id, 'default'))
      .get()
    if (ctx?.severity_level) {
      severityLevel = dbSeverityToLevel(ctx.severity_level)
    }
  }

  const rawMessages = Array.isArray(body.messages) ? body.messages : []
  const filteredMessages = rawMessages.filter(
    m => m.role === 'user' || m.role === 'assistant'
  )
  const lastUserMessage = getLastUserMessage(filteredMessages)
  if (!lastUserMessage) {
    return NextResponse.json({ error: 'user message required' }, { status: 400 })
  }

  const now = Math.floor(Date.now() / 1000)
  saveChatMessage(db, 'user', lastUserMessage, now, sessionId)

  // 更新会话最后活跃时间
  db.update(chatSessions)
    .set({ last_message_at: now })
    .where(eq(chatSessions.session_id, sessionId))
    .run()

  console.log(`[chat] trigger=${trigger} severity=${severityLevel} session=${sessionId}`)

  // 只加载本会话的历史消息作为 AI 上下文
  const history = getSessionChatMessages(db, sessionId, 50)
  const messages = [
    { role: 'system' as const, content: `当前真实时间：${nowContext()}。如需提及时间只能用此时间，禁止自行推测任何时刻。` },
    { role: 'system' as const, content: buildAnchorRoleCard(db, severityLevel, trigger) },
    ...history.map(m => ({ role: m.role, content: m.content })),
  ]

  const upstreamRes = await chatCompletion(cfg, {
    messages,
    temperature: 0.85,
    extra: { stream: true },
  })

  if (!upstreamRes.ok || !upstreamRes.body) {
    return NextResponse.json({ error: 'AI provider error' }, { status: upstreamRes.status })
  }

  let assistantText = ''
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined

  const stream = new ReadableStream({
    async start(controller) {
      reader = upstreamRes.body!.getReader()
      const decoder = new TextDecoder()
      const encoder = new TextEncoder()
      let buffer = ''

      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          const text = decoder.decode(value, { stream: true })
          controller.enqueue(encoder.encode(text))

          buffer += text
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''
          for (const line of lines) {
            assistantText += extractAssistantDeltaFromSseLine(line)
          }
        }

        // flush any remaining partial line
        if (buffer.trim()) {
          assistantText += extractAssistantDeltaFromSseLine(buffer)
        }

        if (assistantText.trim()) {
          saveChatMessage(db, 'assistant', assistantText, Math.floor(Date.now() / 1000), sessionId)
        }

        controller.close()
      } catch (e) {
        controller.error(e)
      }
    },
    cancel() {
      reader?.cancel()
    },
  })

  return new NextResponse(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' },
  })
}
