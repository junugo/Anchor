import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { userLivingContext } from '@anchor/db'
import { eq } from 'drizzle-orm'

export function GET() {
  const db = getDb()
  const ctx = db.select({
    focuslayer_sync_enabled: userLivingContext.focuslayer_sync_enabled,
    focuslayer_server_url: userLivingContext.focuslayer_server_url,
  }).from(userLivingContext).where(eq(userLivingContext.user_id, 'default')).get()

  return NextResponse.json({
    enabled: ctx?.focuslayer_sync_enabled ?? false,
    server_url: ctx?.focuslayer_server_url ?? null,
  })
}

export async function PATCH(req: NextRequest) {
  const body = await req.json() as { enabled?: boolean; server_url?: string | null }
  const db = getDb()
  const now = Math.floor(Date.now() / 1000)

  const patch: Record<string, unknown> = { updated_at: now }
  if (typeof body.enabled === 'boolean') patch.focuslayer_sync_enabled = body.enabled
  if ('server_url' in body) patch.focuslayer_server_url = body.server_url ?? null

  const existing = db.select().from(userLivingContext).where(eq(userLivingContext.user_id, 'default')).get()
  if (existing) {
    db.update(userLivingContext).set(patch).where(eq(userLivingContext.user_id, 'default')).run()
  } else {
    db.insert(userLivingContext).values({
      user_id: 'default',
      inferred_state: 'resting',
      location_zone: 'unknown',
      screen_active: false,
      updated_at: now,
      focuslayer_sync_enabled: body.enabled ?? false,
      focuslayer_server_url: body.server_url ?? null,
    }).run()
  }

  return NextResponse.json({ ok: true })
}
