// 认证路由的请求级辅助：客户端 IP / cookie 解析 / 会话自查。
// 约定与现有 route.ts 一致（NextRequest 上取 header；socket 地址仅自定义 server 场景可用）。
import { getDb } from '@/lib/db'
import { verifySession } from './session'

export const SESSION_COOKIE = 'anchor_session'
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 3600 // 与 createSession 默认 TTL 一致：30 天

/** 判断请求是否为 https：URL 协议或 BT 反代透传的 x-forwarded-proto（BT 反代场景以该头为准） */
export function isSecureRequest(req: Request): boolean {
  if (req.headers.get('x-forwarded-proto') === 'https') return true
  try {
    return new URL(req.url).protocol === 'https:'
  } catch {
    return false
  }
}

/** 从 cookie 头解析 anchor_session 明文 token；无则 null。手写解析，不引新依赖。 */
export function getSessionTokenFromReq(req: Request): string | null {
  const cookieHeader = req.headers.get('cookie')
  if (!cookieHeader) return null
  for (const part of cookieHeader.split(';')) {
    const eq = part.indexOf('=')
    if (eq === -1) continue
    const name = part.slice(0, eq).trim()
    const value = part.slice(eq + 1).trim()
    if (name === SESSION_COOKIE && value) {
      try {
        return decodeURIComponent(value)
      } catch {
        return value
      }
    }
  }
  return null
}

/**
 * 取客户端 IP：x-forwarded-for 首段 → socket.remoteAddress。
 * 信任前提：自托管单用户场景，Anchor 恒在 BT 反代之后，反代会覆盖/追加
 * x-forwarded-for，直连时该头为空、回退 socket 地址。公网多租户部署不可照搬此信任模型。
 */
export function getClientIp(req: Request): string {
  const xff = req.headers.get('x-forwarded-for')
  if (xff) {
    const first = xff.split(',')[0]?.trim()
    if (first) return first
  }
  const socket = (req as unknown as { socket?: { remoteAddress?: string } }).socket
  return socket?.remoteAddress ?? ''
}

/**
 * 会话自查：cookie 中的会话有效则返回 { sessionId }，否则 null。
 * 任务 5 的中间件会统一接管保护逻辑，本辅助仅供需登录路由在过渡期内自用。
 */
export function requireSession(req: Request): { sessionId: number } | null {
  const token = getSessionTokenFromReq(req)
  if (!token) return null
  const session = verifySession(getDb(), token)
  return session ? { sessionId: session.id } : null
}

/** 序列化登录 Set-Cookie；Secure 仅在 https 请求时附加（BT 反代走 x-forwarded-proto 判断） */
export function buildSessionCookie(token: string, secure: boolean): string {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    `Max-Age=${SESSION_MAX_AGE_SECONDS}`,
  ]
  if (secure) parts.push('Secure')
  return parts.join('; ')
}

/** 序列化清除 Set-Cookie（Max-Age=0） */
export function buildClearSessionCookie(secure: boolean): string {
  const parts = [
    `${SESSION_COOKIE}=`,
    'HttpOnly',
    'Path=/',
    'SameSite=Lax',
    'Max-Age=0',
  ]
  if (secure) parts.push('Secure')
  return parts.join('; ')
}
