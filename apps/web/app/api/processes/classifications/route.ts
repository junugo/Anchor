import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { processClassifications } from '@anchor/db'
import { desc } from 'drizzle-orm'

// GET - 获取所有 Windows 进程分类
export async function GET() {
  const db = getDb()
  const all = db
    .select()
    .from(processClassifications)
    .orderBy(desc(processClassifications.updated_at))
    .all()

  return NextResponse.json({ classifications: all })
}

// POST - 手动添加/更新进程分类（is_work 与 high_stimulus 互斥）
export async function POST(req: Request) {
  const { process_name: rawName, display_name, high_stimulus, is_work } = await req.json()

  if (!rawName || (typeof high_stimulus !== 'boolean' && typeof is_work !== 'boolean')) {
    return NextResponse.json({ error: 'Invalid params' }, { status: 400 })
  }

  const processName = String(rawName).toLowerCase()
  const work = is_work === true
  const high = work ? false : high_stimulus === true

  const db = getDb()
  const now = Math.floor(Date.now() / 1000)

  db.insert(processClassifications)
    .values({
      process_name: processName,
      display_name: display_name || processName,
      high_stimulus: high,
      is_work: work,
      classification_source: 'user_manual',
      user_modified: true,
      reviewed: true,
      created_at: now,
      updated_at: now,
    })
    .onConflictDoUpdate({
      target: processClassifications.process_name,
      set: {
        high_stimulus: high,
        is_work: work,
        display_name: display_name || processName,
        user_modified: true,
        reviewed: true,
        updated_at: now,
      }
    })
    .run()

  const { broadcast } = await import('@/lib/ws/server')
  broadcast({
    type: 'process:classification_updated',
    process_name: processName,
    display_name: display_name || processName,
    high_stimulus: high,
    is_work: work,
  })

  return NextResponse.json({ success: true })
}
