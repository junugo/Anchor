import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { behaviorLogs, circadianLogs } from '@anchor/db'
import { lt, lte } from 'drizzle-orm'
import { getUserDateStr } from '@/lib/time/user-time'

export async function POST(req: NextRequest) {
  const body = await req.json() as { older_than_days: number; confirm: boolean }

  if (!body.confirm) {
    return NextResponse.json({ error: 'confirm must be true' }, { status: 400 })
  }
  if (!Number.isInteger(body.older_than_days) || body.older_than_days < 1) {
    return NextResponse.json({ error: 'older_than_days must be a positive integer' }, { status: 400 })
  }

  const db = getDb()
  const cutoffUnix = Math.floor(Date.now() / 1000) - body.older_than_days * 86400
  const cutoffDate = getUserDateStr(cutoffUnix * 1000)

  db.delete(behaviorLogs).where(lt(behaviorLogs.logged_at, cutoffUnix)).run()
  db.delete(circadianLogs).where(lte(circadianLogs.date, cutoffDate)).run()

  return NextResponse.json({ ok: true, purged_before: cutoffDate })
}
