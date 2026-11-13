import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { timeCapsules } from '@anchor/db'

export function GET() {
  const db = getDb()
  const rows = db.select().from(timeCapsules).all()
  return NextResponse.json(rows)
}

export async function POST(req: NextRequest) {
  const body = await req.json() as {
    content: string
    trigger: 'deep_night' | 'after_break' | 'dissociation' | 'wakeup'
  }
  if (!body.content?.trim()) {
    return NextResponse.json({ error: 'content required' }, { status: 400 })
  }
  const db = getDb()
  db.insert(timeCapsules).values({
    content: body.content.trim(),
    trigger: body.trigger,
    created_at: Math.floor(Date.now() / 1000),
  }).run()
  return NextResponse.json({ ok: true }, { status: 201 })
}
