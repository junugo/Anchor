import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { recordAlternativeEnd } from '@/lib/friction-transfer/alternative-store'

/**
 * POST /api/alternatives/end
 *
 * 用户退出替代物时调用，上报使用时长。
 * 服务端据此更新替代物库的有效性统计（effective / ineffective），
 * 并调整 priority_score，驱动替代物库动态维护。
 *
 * Body: {
 *   usage_log_id: number,     // /api/alternatives/start 返回的 ID
 *   duration_seconds: number, // 使用时长（秒）
 * }
 *
 * 有效性规则（Module 6 规格）：
 * - 持续 >600s（10分钟）→ effective，priority_score +5
 * - <120s（2分钟）退出  → ineffective，priority_score -3
 * - 其余                → unknown，不调整
 */
export async function POST(req: NextRequest) {
  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 })
  }

  const usage_log_id = body['usage_log_id']
  if (typeof usage_log_id !== 'number' || !Number.isInteger(usage_log_id) || usage_log_id <= 0) {
    return NextResponse.json({ error: 'usage_log_id 必须为正整数' }, { status: 400 })
  }

  const duration_seconds = body['duration_seconds']
  if (typeof duration_seconds !== 'number' || duration_seconds < 0) {
    return NextResponse.json({ error: 'duration_seconds 必须为非负数' }, { status: 400 })
  }

  const db = getDb()
  recordAlternativeEnd(db, {
    usageLogId: usage_log_id,
    durationSeconds: Math.floor(duration_seconds),
  })

  return NextResponse.json({ ok: true })
}
