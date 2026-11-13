import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { behaviorLogs } from '@anchor/db'
import { desc, gte } from 'drizzle-orm'

export async function GET() {
  const db = getDb()
  const nowMs = Date.now()
  const since = Math.floor(nowMs / 1000) - 10 * 60

  const rows = db
    .select({ source: behaviorLogs.source, event_type: behaviorLogs.event_type, payload: behaviorLogs.payload, logged_at: behaviorLogs.logged_at })
    .from(behaviorLogs)
    .where(gte(behaviorLogs.logged_at, since))
    .orderBy(desc(behaviorLogs.logged_at))
    .limit(30)
    .all()

  // 推断逻辑
  const codeActive = rows.find(r => r.event_type === 'code_active')
  const windowFocus = rows.find(r => r.event_type === 'window_focus')
  const urlVisit = rows.find(r => r.event_type === 'url_visit')

  const file = String(codeActive?.payload?.['file'] ?? windowFocus?.payload?.['title'] ?? '')
  const domain = String(urlVisit?.payload?.['domain'] ?? '')

  let content: string
  let payload: Record<string, unknown> = {}

  if (file) {
    content = `之前可能在处理：${file}`
    payload = { inferred_file: file }
  } else if (domain) {
    content = `之前在浏览：${domain}`
    payload = { inferred_domain: domain }
  } else {
    content = '未检测到明确的上一任务，可能刚结束一段工作。'
  }

  return NextResponse.json({ ok: true, data: { content, payload } })
}
