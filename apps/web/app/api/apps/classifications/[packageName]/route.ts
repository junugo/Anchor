import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { appClassifications } from '@anchor/db'
import { eq } from 'drizzle-orm'

// DELETE - 删除分类
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ packageName: string }> }
) {
  const db = getDb()
  const { packageName } = await params
  
  db.delete(appClassifications)
    .where(eq(appClassifications.package_name, packageName))
    .run()
  
  const { broadcast } = await import('@/lib/ws/server')
  broadcast({
    type: 'app:classification_deleted',
    package_name: packageName,
  })
  
  return NextResponse.json({ success: true })
}
