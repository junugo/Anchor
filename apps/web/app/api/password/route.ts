/**
 * POST /api/password — 修改登录密码（需登录；任务 5 中间件接管前由 requireSession 自查）
 * body: { currentPassword, newPassword }（newPassword 最少 8 位）
 * 200 {ok:true} / 400 参数非法 / 401 未登录或旧密码错误
 */
import { NextRequest, NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { authCredentials } from '@anchor/db'
import { getDb } from '@/lib/db'
import { hashPassword, verifyPassword } from '@/lib/auth/password'
import { requireSession } from '@/lib/auth/request'

const MIN_PASSWORD_LENGTH = 8

export async function POST(req: NextRequest) {
  if (!requireSession(req)) {
    return NextResponse.json({ error: '未登录' }, { status: 401 })
  }

  let body: { currentPassword?: unknown; newPassword?: unknown } | null
  try {
    body = await req.json()
  } catch {
    body = null
  }
  const { currentPassword, newPassword } = body ?? {}
  if (
    typeof currentPassword !== 'string' || !currentPassword ||
    typeof newPassword !== 'string' || newPassword.length < MIN_PASSWORD_LENGTH
  ) {
    return NextResponse.json({ error: '参数非法' }, { status: 400 })
  }

  const db = getDb()
  const row = db
    .select()
    .from(authCredentials)
    .where(eq(authCredentials.user_id, 'default'))
    .get()
  if (!row || !(await verifyPassword(currentPassword, row.password_hash))) {
    return NextResponse.json({ error: '密码错误' }, { status: 401 })
  }

  const { hash, params } = await hashPassword(newPassword)
  db.update(authCredentials)
    .set({
      password_hash: hash,
      scrypt_params: JSON.parse(params),
      updated_at: Math.floor(Date.now() / 1000),
    })
    .where(eq(authCredentials.user_id, 'default'))
    .run()

  return NextResponse.json({ ok: true })
}
