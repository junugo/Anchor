import { NextRequest, NextResponse } from 'next/server'
import { getSchoolSchedule, updateSchoolSchedule } from '@/lib/school/schedule'

export function GET() {
  return NextResponse.json(getSchoolSchedule())
}

// 配置缓存挂 globalThis，管线/睡眠引擎下一 tick 即生效，无需广播
export async function PATCH(req: NextRequest) {
  const patch = await req.json() as Record<string, unknown>
  // 只放行白名单字段，避免写入 id/垃圾键
  const allowed = [
    'enabled', 'days_mask', 'leave_minute', 'home_minute',
    'wake_estimate_minute', 'term_start', 'term_end', 'exceptions',
  ] as const
  const clean: Record<string, unknown> = {}
  for (const k of allowed) {
    if (k in patch) clean[k] = patch[k]
  }
  const updated = updateSchoolSchedule(clean)
  return NextResponse.json(updated)
}
