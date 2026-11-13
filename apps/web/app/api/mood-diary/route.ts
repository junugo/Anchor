import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { moodDiary } from '@anchor/db'
import { desc } from 'drizzle-orm'

export function GET() {
  const db = getDb()
  const rows = db
    .select()
    .from(moodDiary)
    .orderBy(desc(moodDiary.created_at))
    .limit(50)
    .all()
  return NextResponse.json(rows)
}

export async function POST(req: NextRequest) {
  const body = await req.json() as {
    triggers?: string[]
    mood_before: number
    mood_after: number
    note?: string
  }

  if (typeof body.mood_before !== 'number' || typeof body.mood_after !== 'number') {
    return NextResponse.json({ error: 'mood_before and mood_after are required' }, { status: 400 })
  }

  const db = getDb()
  const now = Math.floor(Date.now() / 1000)

  const inserted = db
    .insert(moodDiary)
    .values({
      triggers: body.triggers ?? [],
      mood_before: body.mood_before,
      mood_after: body.mood_after,
      note: body.note ?? null,
      created_at: now,
    })
    .returning()
    .get()

  return NextResponse.json(inserted, { status: 201 })
}
