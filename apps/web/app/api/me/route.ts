/**
 * GET /api/me — 公开状态查询
 * 返回 { hasPassword, authenticated }
 */
import { NextRequest, NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { authCredentials } from '@anchor/db'
import { getDb } from '@/lib/db'
import { requireSession } from '@/lib/auth/request'

export function GET(req: NextRequest) {
  const db = getDb()
  const row = db
    .select({ id: authCredentials.id })
    .from(authCredentials)
    .where(eq(authCredentials.user_id, 'default'))
    .get()
  return NextResponse.json({
    hasPassword: !!row,
    authenticated: requireSession(req) !== null,
  })
}
