import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { aiConversationSummaries } from '@anchor/db'
import { desc } from 'drizzle-orm'

export function GET() {
  const db = getDb()
  const rows = db
    .select()
    .from(aiConversationSummaries)
    .orderBy(desc(aiConversationSummaries.created_at))
    .limit(30)
    .all()
  return NextResponse.json(rows)
}
