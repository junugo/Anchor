import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { frictionFormProposals } from '@anchor/db'
import { eq } from 'drizzle-orm'

/**
 * GET /api/friction/proposals
 * 列出所有待审查（pending）的 AI 提议摩擦形式。
 */
export async function GET() {
  const db = getDb()
  const rows = db
    .select()
    .from(frictionFormProposals)
    .where(eq(frictionFormProposals.status, 'pending'))
    .all()
  return NextResponse.json({ proposals: rows })
}
