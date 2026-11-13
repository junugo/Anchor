import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { userMemory } from '@anchor/db'

/**
 * POST /api/ai/self-report
 * 用户主动自填严重度感受（三信号融合评估的第二路信号）
 * Body: { score: 1-5, text?: string }
 */
export async function POST(req: NextRequest) {
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: '请求体解析失败' }, { status: 400 })
  }

  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: '无效请求体' }, { status: 400 })
  }

  const { score, text } = body as { score?: unknown; text?: unknown }

  if (typeof score !== 'number' || !Number.isInteger(score) || score < 1 || score > 5) {
    return NextResponse.json({ error: 'score 必须是 1-5 的整数' }, { status: 400 })
  }

  if (text !== undefined && typeof text !== 'string') {
    return NextResponse.json({ error: 'text 必须是字符串' }, { status: 400 })
  }

  const db = getDb()
  const nowS = Math.floor(Date.now() / 1000)
  const value = JSON.stringify({ score, text: text ?? '', recordedAt: nowS })

  db.insert(userMemory)
    .values({ key: 'self_report', value, updated_at: nowS })
    .onConflictDoUpdate({
      target: userMemory.key,
      set: { value, updated_at: nowS },
    })
    .run()

  return NextResponse.json({ ok: true })
}
