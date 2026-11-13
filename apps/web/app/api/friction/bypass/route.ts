import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { recordFrictionEvent } from '@/lib/habituation/store'

/**
 * POST /api/friction/bypass
 *
 * 客户端（Chrome 扩展、Android 等）在用户绕过摩擦时调用此接口，
 * 上报 bypassed 事件，供习惯化对抗引擎（isHabituated）使用。
 *
 * Body: { formId: string, bypassedAt?: number }
 *   - formId: 被绕过的摩擦形式 ID（如 'curfew:slide_unlock'）
 *   - bypassedAt: Unix 秒（可选，默认为服务器当前时间）
 */
export async function POST(req: NextRequest) {
  let body: { formId?: unknown; bypassedAt?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 })
  }

  const { formId, bypassedAt } = body

  if (!formId || typeof formId !== 'string' || formId.trim().length === 0) {
    return NextResponse.json({ error: 'formId 必填且必须为非空字符串' }, { status: 400 })
  }

  const recordedAt =
    typeof bypassedAt === 'number' && Number.isFinite(bypassedAt) && bypassedAt > 0
      ? Math.floor(bypassedAt)
      : Math.floor(Date.now() / 1000)

  const db = getDb()
  recordFrictionEvent(db, {
    formId: formId.trim(),
    eventType: 'bypassed',
    recordedAt,
    context: { source: 'client_report' },
  })

  return NextResponse.json({ ok: true })
}
