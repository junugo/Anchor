/**
 * POST /api/login — 密码登录，成功签发 anchor_session cookie（HttpOnly，30 天）
 * body: { password }
 * 限频：按 IP login: 键，5 次/分钟，超限 429
 * 200 {ok:true} + Set-Cookie / 400 参数非法 / 401 密码错误 / 409 尚未设置密码 / 429 请求过于频繁
 */
import { NextRequest, NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { authCredentials } from '@anchor/db'
import { getDb } from '@/lib/db'
import { verifyPassword } from '@/lib/auth/password'
import { createSession } from '@/lib/auth/session'
import { createRateLimiter } from '@/lib/auth/rate-limit'
import { buildSessionCookie, getClientIp, isSecureRequest } from '@/lib/auth/request'

const limiter = createRateLimiter()
const LOGIN_LIMIT = 5
const LOGIN_WINDOW_MS = 60 * 1000

export async function POST(req: NextRequest) {
  const ip = getClientIp(req)
  if (!limiter.limit(`login:${ip}`, LOGIN_LIMIT, LOGIN_WINDOW_MS)) {
    return NextResponse.json({ error: '请求过于频繁，请稍后再试' }, { status: 429 })
  }

  let body: { password?: unknown } | null
  try {
    body = await req.json()
  } catch {
    body = null
  }
  const password = body?.password
  if (typeof password !== 'string' || !password) {
    return NextResponse.json({ error: '参数非法' }, { status: 400 })
  }

  const db = getDb()
  const row = db
    .select()
    .from(authCredentials)
    .where(eq(authCredentials.user_id, 'default'))
    .get()
  if (!row) {
    return NextResponse.json({ error: '尚未设置密码' }, { status: 409 })
  }

  // 模糊措辞：不区分「未设置密码」与「密码错」之外的细节，避免凭据枚举
  const ok = await verifyPassword(password, row.password_hash)
  if (!ok) {
    return NextResponse.json({ error: '密码错误' }, { status: 401 })
  }

  const token = createSession(db)
  const cookie = buildSessionCookie(token, isSecureRequest(req))
  return NextResponse.json({ ok: true }, { headers: { 'Set-Cookie': cookie } })
}
