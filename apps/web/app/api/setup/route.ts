/**
 * POST /api/setup — 首次设置登录密码（仅未设密码时可调，单行语义 user_id='default'）
 * body: { password }（string，最少 8 位）
 * 200 {ok:true} / 400 参数非法 / 409 已设置过密码
 * 本任务不自动登录；登录页随后引导。
 */
import { NextRequest, NextResponse } from 'next/server'
import { eq } from 'drizzle-orm'
import { authCredentials } from '@anchor/db'
import { getDb } from '@/lib/db'
import { hashPassword } from '@/lib/auth/password'

const MIN_PASSWORD_LENGTH = 8

export async function POST(req: NextRequest) {
  let body: { password?: unknown } | null
  try {
    body = await req.json()
  } catch {
    body = null
  }
  const password = body?.password
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
    return NextResponse.json({ error: '密码至少 8 位' }, { status: 400 })
  }

  const db = getDb()
  const existing = db
    .select()
    .from(authCredentials)
    .where(eq(authCredentials.user_id, 'default'))
    .get()
  if (existing) {
    return NextResponse.json({ error: '已设置过密码' }, { status: 409 })
  }

  const { hash, params } = await hashPassword(password)
  const now = Math.floor(Date.now() / 1000)
  // 并发双 setup：插入撞 user_id 唯一约束时不抛 500，静默忽略后复查（第二个请求拿到 409）
  const inserted = db.insert(authCredentials).values({
    user_id: 'default',
    password_hash: hash,
    scrypt_params: JSON.parse(params),
    created_at: now,
    updated_at: now,
  }).onConflictDoNothing().run()
  if (Number(inserted.changes) === 0) {
    return NextResponse.json({ error: '已设置过密码' }, { status: 409 })
  }

  return NextResponse.json({ ok: true })
}
