// POST /api/devices/:id/revoke — 撤销设备（需登录）
// 已撤销重复调用幂等返回 {ok:true}；不存在 404；不实现自保护（当前会话不是 device，YAGNI）
import { NextRequest, NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { devices } from '@anchor/db'
import { getDb } from '@/lib/db'
import { requireSession } from '@/lib/auth/request'

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!requireSession(req)) {
    return NextResponse.json({ error: '未登录' }, { status: 401 })
  }

  const { id } = await params
  const deviceId = Number(id)
  if (!Number.isInteger(deviceId) || deviceId <= 0) {
    return NextResponse.json({ error: '设备不存在' }, { status: 404 })
  }

  const db = getDb()
  const row = db.select().from(devices).where(eq(devices.id, deviceId)).get()
  if (!row) {
    return NextResponse.json({ error: '设备不存在' }, { status: 404 })
  }
  if (row.revoked_at !== null) {
    return NextResponse.json({ ok: true })
  }

  db.update(devices)
    .set({ revoked_at: Math.floor(Date.now() / 1000) })
    .where(eq(devices.id, deviceId))
    .run()

  return NextResponse.json({ ok: true })
}
