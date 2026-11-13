import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { contextSwitchDumps } from '@anchor/db'
import { desc } from 'drizzle-orm'

export async function GET() {
  const db = getDb()
  const rows = db.select().from(contextSwitchDumps).orderBy(desc(contextSwitchDumps.dumped_at)).limit(20).all()
  return NextResponse.json({ ok: true, data: rows })
}
