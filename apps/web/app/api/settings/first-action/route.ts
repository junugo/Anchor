import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { userSettings } from '@anchor/db'
import { eq } from 'drizzle-orm'

const KEY = 'first_action'

export function GET() {
  const db = getDb()
  const row = db.select().from(userSettings).where(eq(userSettings.key, KEY)).get()
  return NextResponse.json({ first_action: row?.value ?? '喝水' })
}

export async function PATCH(req: NextRequest) {
  const body = await req.json() as { first_action: string }
  if (!body.first_action?.trim()) {
    return NextResponse.json({ error: 'first_action required' }, { status: 400 })
  }
  const db = getDb()
  db.insert(userSettings)
    .values({ key: KEY, value: body.first_action.trim(), updated_at: Math.floor(Date.now() / 1000) })
    .onConflictDoUpdate({ target: userSettings.key, set: { value: body.first_action.trim(), updated_at: Math.floor(Date.now() / 1000) } })
    .run()
  return NextResponse.json({ ok: true })
}
