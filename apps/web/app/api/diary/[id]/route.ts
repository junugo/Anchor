import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { dissociationDiary } from '@anchor/db'
import { eq } from 'drizzle-orm'

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const body = await req.json() as {
    user_choice: 'active_rest' | 'attention_break' | 'dissociation' | 'ignored'
  }
  const db = getDb()
  db.update(dissociationDiary)
    .set({ user_choice: body.user_choice, confirmed_at: Math.floor(Date.now() / 1000) })
    .where(eq(dissociationDiary.id, Number(id)))
    .run()
  return NextResponse.json({ ok: true })
}
