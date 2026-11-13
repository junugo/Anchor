import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { userSettings } from '@anchor/db'
import { eq } from 'drizzle-orm'

const KEY = 'location_zones'

// Zone calibration: store WiFi/BT fingerprints per named zone
export function GET() {
  const db = getDb()
  const row = db.select().from(userSettings).where(eq(userSettings.key, KEY)).get()
  const zones = row ? JSON.parse(row.value) : {}
  return NextResponse.json(zones)
}

export async function PUT(req: NextRequest) {
  const body = await req.json() as Record<string, unknown>
  const db = getDb()
  const now = Math.floor(Date.now() / 1000)
  db.insert(userSettings)
    .values({ key: KEY, value: JSON.stringify(body), updated_at: now })
    .onConflictDoUpdate({ target: userSettings.key, set: { value: JSON.stringify(body), updated_at: now } })
    .run()
  return NextResponse.json({ ok: true })
}
