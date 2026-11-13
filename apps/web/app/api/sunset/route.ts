import { NextRequest, NextResponse } from 'next/server'
import { getSunsetConfig, updateSunsetConfig } from '@/lib/sunset/config'
import { broadcastSunsetConfigNow } from '@/lib/ws/server'

export function GET() {
  const config = getSunsetConfig()
  return NextResponse.json(config)
}

export async function PATCH(req: NextRequest) {
  const patch = await req.json()
  const updated = updateSunsetConfig(patch)
  // 缓存已挂 globalThis，决策引擎下一 tick 即生效；此处立即全量下发新配置与重算阶段
  await broadcastSunsetConfigNow()
  return NextResponse.json(updated)
}
