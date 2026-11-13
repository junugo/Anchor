import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { dissociationDiary } from '@anchor/db'
import { desc, isNull } from 'drizzle-orm'

export function GET() {
  const db = getDb()
  const rows = db
    .select()
    .from(dissociationDiary)
    .where(isNull(dissociationDiary.user_choice))
    .orderBy(desc(dissociationDiary.created_at))
    .limit(20)
    .all()
  return NextResponse.json(rows)
}

export async function POST(req: NextRequest) {
  const body = await req.json() as {
    period_start: number
    period_end: number
    candidate_label: string
  }
  const db = getDb()
  const now = Math.floor(Date.now() / 1000)
  db.insert(dissociationDiary).values({
    period_start: body.period_start,
    period_end: body.period_end,
    candidate_label: body.candidate_label,
    created_at: now,
  }).run()
  return NextResponse.json({ ok: true }, { status: 201 })
}
