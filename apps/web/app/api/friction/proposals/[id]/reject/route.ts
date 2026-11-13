import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { frictionFormProposals } from '@anchor/db'
import { eq } from 'drizzle-orm'

/**
 * POST /api/friction/proposals/[id]/reject
 * 用户拒绝 AI 提议的摩擦形式，将其状态改为 rejected。
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  const proposalId = parseInt(id, 10)
  if (isNaN(proposalId)) {
    return NextResponse.json({ error: '无效的提议 ID' }, { status: 400 })
  }

  const db = getDb()
  const existing = db
    .select()
    .from(frictionFormProposals)
    .where(eq(frictionFormProposals.id, proposalId))
    .get()

  if (!existing) {
    return NextResponse.json({ error: '提议不存在' }, { status: 404 })
  }
  if (existing.status !== 'pending') {
    return NextResponse.json({ error: `提议已被${existing.status === 'accepted' ? '接受' : '拒绝'}` }, { status: 409 })
  }

  db.update(frictionFormProposals)
    .set({ status: 'rejected', reviewed_at: Math.floor(Date.now() / 1000) })
    .where(eq(frictionFormProposals.id, proposalId))
    .run()

  return NextResponse.json({ ok: true })
}
