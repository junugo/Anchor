import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { siteClassifications } from '@anchor/db'
import { eq } from 'drizzle-orm'

// DELETE - 删除分类
export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ domain: string }> }
) {
  const db = getDb()
  const { domain: rawDomain } = await params
  const domain = String(rawDomain).toLowerCase().replace(/^www\./, '')

  db.delete(siteClassifications)
    .where(eq(siteClassifications.domain, domain))
    .run()

  const { broadcast } = await import('@/lib/ws/server')
  broadcast({
    type: 'site:classification_deleted',
    domain,
  })

  return NextResponse.json({ success: true })
}
