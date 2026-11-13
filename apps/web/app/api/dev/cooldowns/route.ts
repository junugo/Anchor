import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { decisionCooldowns } from '@anchor/db'

export function GET() {
  const db = getDb()
  const rows = db
    .select({
      key: decisionCooldowns.key,
      last_triggered_at: decisionCooldowns.last_triggered_at,
    })
    .from(decisionCooldowns)
    .all()
  return NextResponse.json({
    cooldowns: rows,
    now: Math.floor(Date.now() / 1000),
  })
}