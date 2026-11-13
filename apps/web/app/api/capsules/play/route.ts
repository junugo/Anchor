import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { timeCapsules } from '@anchor/db'
import { eq } from 'drizzle-orm'

export async function POST(req: NextRequest) {
  const body = await req.json() as { trigger: string }
  const db = getDb()
  const candidates = db
    .select()
    .from(timeCapsules)
    .where(eq(timeCapsules.trigger, body.trigger as 'deep_night' | 'after_break' | 'dissociation' | 'wakeup'))
    .all()

  if (candidates.length === 0) return NextResponse.json({ played: false })

  const capsule = candidates[Math.floor(Math.random() * candidates.length)]
  db.update(timeCapsules)
    .set({ last_played_at: Math.floor(Date.now() / 1000) })
    .where(eq(timeCapsules.id, capsule.id))
    .run()

  const { broadcast } = await import('@/lib/ws/server')
  broadcast({ type: 'capsule:play', content: capsule.content, trigger: body.trigger })

  return NextResponse.json({ played: true, content: capsule.content })
}
