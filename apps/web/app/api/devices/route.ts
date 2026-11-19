// GET /api/devices — 已配对设备列表（需登录；含已撤销，按创建时间倒序）
// 返回 {devices: [{id, name, clientVersion, createdAt, lastSeenAt, revokedAt}]}，时间均为 Unix 秒，可空
import { NextRequest, NextResponse } from 'next/server'
import { desc } from 'drizzle-orm'
import { devices } from '@anchor/db'
import { getDb } from '@/lib/db'
import { requireSession } from '@/lib/auth/request'

export async function GET(req: NextRequest) {
  if (!requireSession(req)) {
    return NextResponse.json({ error: '未登录' }, { status: 401 })
  }

  const rows = getDb().select().from(devices).orderBy(desc(devices.created_at)).all()
  return NextResponse.json({
    devices: rows.map(d => ({
      id: d.id,
      name: d.name,
      clientVersion: d.client_version,
      createdAt: d.created_at,
      lastSeenAt: d.last_seen_at,
      revokedAt: d.revoked_at,
    })),
  })
}
