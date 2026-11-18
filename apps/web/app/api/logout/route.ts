/**
 * POST /api/logout — 销毁当前会话并清除 cookie（幂等：未登录也返回 200）
 */
import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { destroySession } from '@/lib/auth/session'
import { buildClearSessionCookie, getSessionTokenFromReq, isSecureRequest } from '@/lib/auth/request'

export async function POST(req: NextRequest) {
  const token = getSessionTokenFromReq(req)
  if (token) {
    destroySession(getDb(), token)
  }
  const cookie = buildClearSessionCookie(isSecureRequest(req))
  return NextResponse.json({ ok: true }, { headers: { 'Set-Cookie': cookie } })
}
