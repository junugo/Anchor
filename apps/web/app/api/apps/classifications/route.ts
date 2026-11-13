import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { appClassifications } from '@anchor/db'
import { desc } from 'drizzle-orm'

// GET - 获取所有分类
export async function GET() {
  const db = getDb()
  const all = db
    .select()
    .from(appClassifications)
    .orderBy(desc(appClassifications.updated_at))
    .all()
  
  return NextResponse.json({ classifications: all })
}

// POST - 手动添加/更新分类（is_work 与 high_stimulus 互斥）
export async function POST(req: Request) {
  const { package_name, app_name, high_stimulus, is_work } = await req.json()

  if (!package_name || (typeof high_stimulus !== 'boolean' && typeof is_work !== 'boolean')) {
    return NextResponse.json({ error: 'Invalid params' }, { status: 400 })
  }

  const work = is_work === true
  const high = work ? false : high_stimulus === true

  const db = getDb()
  const now = Math.floor(Date.now() / 1000)

  db.insert(appClassifications)
    .values({
      package_name,
      app_name: app_name || package_name,
      high_stimulus: high,
      is_work: work,
      classification_source: 'user_manual',
      user_modified: true,
      reviewed: true,
      created_at: now,
      updated_at: now,
    })
    .onConflictDoUpdate({
      target: appClassifications.package_name,
      set: {
        high_stimulus: high,
        is_work: work,
        app_name: app_name || package_name,
        user_modified: true,
        reviewed: true,
        updated_at: now,
      }
    })
    .run()

  // 广播更新
  const { broadcast } = await import('@/lib/ws/server')
  broadcast({
    type: 'app:classification_updated',
    package_name,
    app_name: app_name || package_name,
    high_stimulus: high,
    is_work: work,
  })

  return NextResponse.json({ success: true })
}
