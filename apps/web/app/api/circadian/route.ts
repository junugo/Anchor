import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { circadianLogs } from '@anchor/db'
import { desc, gte, eq } from 'drizzle-orm'
import { getUserDateStr } from '@/lib/time/user-time'

export function GET() {
  const db = getDb()

  // Last 7 days
  const cutoffDate = getUserDateStr(Date.now() - 6 * 24 * 60 * 60 * 1000)

  const logs = db
    .select()
    .from(circadianLogs)
    .where(gte(circadianLogs.date, cutoffDate))
    .orderBy(desc(circadianLogs.date))
    .all()

  return NextResponse.json(logs)
}

export async function POST(req: NextRequest) {
  const body = await req.json() as {
    event: 'meal' | 'left_room' | 'sleep_start' | 'sleep_end' | 'wakeup_verified'
    timestamp?: number
  }

  const db = getDb()
  // sleep_end 的实际归属行由 recordSleepEnd 决定（开放行优先），此处仅作 meal/left_room 的默认行
  let today = getUserDateStr(Date.now())
  const now = body.timestamp ?? Math.floor(Date.now() / 1000)

  const existing = db
    .select()
    .from(circadianLogs)
    .where(eq(circadianLogs.date, today))
    .get()

  if (existing) {
    switch (body.event) {
      case 'meal':
        db.update(circadianLogs)
          .set({ meals_count: existing.meals_count + 1 })
          .where(eq(circadianLogs.date, today))
          .run()
        break
      case 'left_room':
        db.update(circadianLogs)
          .set({ left_room_count: existing.left_room_count + 1 })
          .where(eq(circadianLogs.date, today))
          .run()
        break
      case 'sleep_start':
        // recordSleepStart 自带跨午夜日期判断与 sunset compliance
        break
      case 'sleep_end':
        // 归属与防御统一走 recordSleepEnd（开放行优先，start/end 先后校验）
        break
      case 'wakeup_verified':
        // recordWakeup 会自行写 sleep_end，此处不再重复写
        break
    }
  } else {
    const base = { date: today, meals_count: 0, left_room_count: 0 }
    switch (body.event) {
      case 'meal':
        db.insert(circadianLogs).values({ ...base, meals_count: 1 }).run()
        break
      case 'left_room':
        db.insert(circadianLogs).values({ ...base, left_room_count: 1 }).run()
        break
      case 'sleep_start':
        // recordSleepStart 自带跨午夜日期判断，此处不插行
        break
      case 'sleep_end':
        // 归属与防御统一走 recordSleepEnd，此处不插行
        break
      case 'wakeup_verified':
        // recordWakeup 会自行处理
        break
      default:
        db.insert(circadianLogs).values(base).run()
    }
  }

  if (body.event === 'sleep_start') {
    const { recordSleepStart } = await import('@/lib/circadian/wakeup')
    recordSleepStart()
  }

  if (body.event === 'wakeup_verified') {
    const { recordWakeup } = await import('@/lib/circadian/wakeup')
    recordWakeup()
  }

  if (body.event === 'sleep_end') {
    const { recordSleepEnd } = await import('@/lib/circadian/wakeup')
    // recordSleepEnd 内部完成归属（开放行优先）、先后校验与派生指标刷新，
    // 返回实际写入行；后续查询以它为准
    today = recordSleepEnd(db, now)
  }

  const updated = db
    .select()
    .from(circadianLogs)
    .where(eq(circadianLogs.date, today))
    .get()

  return NextResponse.json(updated ?? { date: today })
}
