import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { recordFrictionEvent } from '@/lib/habituation/store'

/**
 * POST /api/friction-events
 *
 * 客户端（Chrome 扩展等）在用户绕过摩擦时调用此接口，上报 bypassed 事件。
 * 供习惯化对抗引擎（isHabituated）使用，实现动态摩擦形式轮换。
 *
 * Body:
 *   formId: string      — 摩擦形式 ID（如 'curfew:slide_unlock'）
 *   eventType: 'bypassed'
 *   context?: Record<string, unknown>  — 可选上下文信息
 */
export async function POST(req: NextRequest) {
  let body: { formId?: unknown; eventType?: unknown; context?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ ok: false, message: 'invalid' }, { status: 400 })
  }

  if (typeof body.formId !== 'string' || body.eventType !== 'bypassed') {
    return NextResponse.json({ ok: false, message: 'invalid' }, { status: 400 })
  }

  const context =
    body.context !== null &&
    typeof body.context === 'object' &&
    !Array.isArray(body.context)
      ? (body.context as Record<string, unknown>)
      : {}

  const db = getDb()
  recordFrictionEvent(db, {
    formId: body.formId,
    eventType: 'bypassed',
    context,
    recordedAt: Math.floor(Date.now() / 1000),
  })

  return NextResponse.json({ ok: true })
}
