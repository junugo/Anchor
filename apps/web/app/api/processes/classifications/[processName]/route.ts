import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { processClassifications } from '@anchor/db'
import { eq } from 'drizzle-orm'

// DELETE - 删除进程分类
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ processName: string }> }
) {
  const db = getDb()
  const { processName } = await params
  const name = decodeURIComponent(processName).toLowerCase()

  db.delete(processClassifications)
    .where(eq(processClassifications.process_name, name))
    .run()

  const { broadcast } = await import('@/lib/ws/server')
  broadcast({
    type: 'process:classification_deleted',
    process_name: name,
  })

  return NextResponse.json({ success: true })
}
