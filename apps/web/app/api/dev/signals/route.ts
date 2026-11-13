import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { behaviorLogs } from '@anchor/db'
import { desc } from 'drizzle-orm'

export function GET() {
  const db = getDb()
  const rows = db
    .select({
      id: behaviorLogs.id,
      source: behaviorLogs.source,
      event_type: behaviorLogs.event_type,
      payload: behaviorLogs.payload,
      logged_at: behaviorLogs.logged_at,
    })
    .from(behaviorLogs)
    .orderBy(desc(behaviorLogs.logged_at))
    .limit(100)
    .all()
  return NextResponse.json({ signals: rows })
}