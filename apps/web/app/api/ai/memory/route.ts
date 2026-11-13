import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { userMemory } from '@anchor/db'

export function GET() {
  const db = getDb()
  const rows = db.select().from(userMemory).all()
  return NextResponse.json(rows)
}
