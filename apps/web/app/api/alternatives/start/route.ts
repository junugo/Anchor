import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { recordAlternativeStart, getTimeOfDay } from '@/lib/friction-transfer/alternative-store'
import { getUserHour } from '@/lib/time/user-time'

/**
 * POST /api/alternatives/start
 *
 * 用户点击替代物入口时调用，记录开始使用。
 * 返回 usage_log_id，客户端退出替代物时携带此 ID 调用 /api/alternatives/end。
 *
 * Body: {
 *   alternative_id: number,
 *   trigger_state?: string,   // 触发上下文，如 'curfew' | 'crash' | 'entertaining'
 *   severity_level?: string,  // 可选，当前严重度等级
 *   started_at?: number,      // Unix 秒，默认服务器当前时间
 * }
 */
export async function POST(req: NextRequest) {
  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 })
  }

  const alternative_id = body['alternative_id']
  if (typeof alternative_id !== 'number' || !Number.isInteger(alternative_id) || alternative_id <= 0) {
    return NextResponse.json({ error: 'alternative_id 必须为正整数' }, { status: 400 })
  }

  const nowS = Math.floor(Date.now() / 1000)
  const started_at = typeof body['started_at'] === 'number' && body['started_at'] > 0
    ? Math.floor(body['started_at'])
    : nowS

  const trigger_state = typeof body['trigger_state'] === 'string' ? body['trigger_state'] : 'unknown'
  const severity_level = typeof body['severity_level'] === 'string' ? body['severity_level'] : null

  const timeOfDay = getTimeOfDay(getUserHour(started_at * 1000))

  const db = getDb()
  const usageLogId = recordAlternativeStart(db, {
    alternativeId: alternative_id,
    triggerState: trigger_state,
    severityLevel: severity_level,
    timeOfDay,
    startedAt: started_at,
  })

  return NextResponse.json({ ok: true, usage_log_id: usageLogId })
}
