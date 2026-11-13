import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { timeCapsules } from '@anchor/db'
import { eq } from 'drizzle-orm'

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const db = getDb()
  db.delete(timeCapsules).where(eq(timeCapsules.id, Number(id))).run()
  return NextResponse.json({ ok: true })
}
