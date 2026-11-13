import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { alternativeLibrary } from '@anchor/db'
import { seedDefaultAlternatives, getTopAlternatives, getTimeOfDay, type TimeOfDay } from '@/lib/friction-transfer/alternative-store'
import { getUserHour } from '@/lib/time/user-time'

/**
 * GET /api/alternatives
 *
 * 查询当前最优替代物列表（低刺激路径减摩擦）。
 * 用于宵禁页面和崩溃状态下自动展示的一键直达替代物入口。
 *
 * Query params:
 *   - time_of_day?: 'morning' | 'afternoon' | 'evening' | 'deep_night'
 *     默认根据服务器当前时间自动推断
 *   - top?: number（默认 4，最大 8）
 *
 * Response: { alternatives: AlternativeEntry[] }
 */
export function GET(req: NextRequest) {
  const db = getDb()
  seedDefaultAlternatives(db)

  const { searchParams } = new URL(req.url)
  const topParam = Math.min(8, Math.max(1, Number(searchParams.get('top') ?? '4')))

  const hourOfDay = getUserHour(Date.now())
  const timeOfDayParam = searchParams.get('time_of_day') as TimeOfDay | null
  const timeOfDay: TimeOfDay = timeOfDayParam ?? getTimeOfDay(hourOfDay)

  const alternatives = getTopAlternatives(db, timeOfDay, topParam)

  return NextResponse.json({ alternatives, time_of_day: timeOfDay })
}

/**
 * POST /api/alternatives
 *
 * 添加新替代物到库中（用户手动添加或 AI 建议）
 *
 * Body: { name, category?, launch_url?, preferred_time_slots?, priority_score? }
 */
export async function POST(req: NextRequest) {
  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 })
  }

  const name = body['name']
  if (!name || typeof name !== 'string' || name.trim().length === 0) {
    return NextResponse.json({ error: 'name 必填' }, { status: 400 })
  }

  const db = getDb()
  const nowS = Math.floor(Date.now() / 1000)

  const VALID_CATEGORIES = ['audio', 'reading', 'movement', 'breathing', 'other'] as const
  type Category = typeof VALID_CATEGORIES[number]
  const category: Category = VALID_CATEGORIES.includes(body['category'] as Category)
    ? (body['category'] as Category)
    : 'other'

  const launch_url = typeof body['launch_url'] === 'string' ? body['launch_url'] : null
  const preferred_time_slots = Array.isArray(body['preferred_time_slots'])
    ? (body['preferred_time_slots'] as string[]).filter(
        (s): s is 'morning' | 'afternoon' | 'evening' | 'deep_night' =>
          ['morning', 'afternoon', 'evening', 'deep_night'].includes(s)
      )
    : []
  const priority_score = typeof body['priority_score'] === 'number'
    ? Math.min(100, Math.max(0, body['priority_score']))
    : 50

  const result = db.insert(alternativeLibrary).values({
    name: name.trim(),
    category,
    launch_url,
    preferred_time_slots,
    priority_score,
    effective_count: 0,
    ineffective_count: 0,
    active: true,
    created_at: nowS,
    updated_at: nowS,
  }).run()

  return NextResponse.json({ ok: true, id: Number(result.lastInsertRowid) })
}
