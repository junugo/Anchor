// HTTP 认证中间件：在自定义 server.ts 的 createServer 回调里先过 guardRequest，
// 未认证按路径类型响应（API 401 JSON / 页面 302），认证则放行给 Next handler。
// 与 API 路由内的 requireSession 自查形成纵深防御。
import { eq } from 'drizzle-orm'
import type { IncomingMessage } from 'http'
import { authCredentials, type Db } from '@anchor/db'
import { getDb } from '@/lib/db'
import { verifySession } from './session'
import { verifyDeviceToken } from './device-token'
import { SESSION_COOKIE } from './request'

/** 单用户场景 hasPassword 只需点查单行（user_id='default' 唯一约束） */
export function hasPassword(db: Db): boolean {
  const row = db
    .select({ id: authCredentials.id })
    .from(authCredentials)
    .where(eq(authCredentials.user_id, 'default'))
    .get()
  return !!row
}

// 公开页面（按精确路径）
const PUBLIC_PAGE_PATHS = new Set(['/login', '/setup'])

/** 公开路径清单：静态产物前缀 + 公开页面 + 公开 API 前缀 */
export function isPublicPath(pathname: string): boolean {
  // Next 静态产物（构建哈希资源，不含敏感数据）
  if (pathname.startsWith('/_next/')) return true
  if (pathname === '/favicon.ico') return true
  if (pathname.startsWith('/icon')) return true // /icon.svg /icon-192.png 等 PWA 图标
  if (pathname.startsWith('/manifest')) return true // manifest.webmanifest / manifest.json
  // 公开页面（登录 / 首次设置，任务 6 建页面，提前公开无害）
  if (PUBLIC_PAGE_PATHS.has(pathname)) return true
  // 公开 API（by 设计）
  if (pathname === '/api/login') return true
  if (pathname === '/api/me') return true
  if (pathname === '/api/pair') return true // 配对兑换公开（限频在路由内）；/api/pair/codes 需登录
  if (pathname === '/api/version') return true // 客户端更新检查（任务 13 消费）
  // /api/setup 仅在尚未设置密码时公开（见 guardRequest 内 hasPassword 判定）
  return false
}

export type AuthenticatedPrincipal =
  | { kind: 'session'; sessionId: number }
  // 设备 bearer（/api/pair 签发的 token 校验通过）
  | { kind: 'device'; deviceId: number; deviceName: string }

/** 供 http 请求对象挂认证结果，下游（含 Next handler）可取用 */
export interface AuthedRequest extends IncomingMessage {
  anchorAuth?: AuthenticatedPrincipal
}

/**
 * 解析请求身份：Authorization: Bearer 设备 token → verifyDeviceToken；
 * 否则 anchor_session cookie → verifySession。
 * 语义决策：Bearer 显式凭证无效即拒绝，不回落 cookie 校验——
 * 客户端若主动出示了设备 token，凭证错就该失败，而不是静默降级成匿名/会话身份。
 */
export function authenticateRequest(req: IncomingMessage): AuthenticatedPrincipal | null {
  // --- Bearer：设备 token（/api/pair 签发的 32B base64url）---
  const authHeader = req.headers['authorization']
  if (typeof authHeader === 'string' && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice('Bearer '.length).trim()
    if (!token) return null
    const device = verifyDeviceToken(getDb(), token)
    return device ? { kind: 'device', deviceId: device.deviceId, deviceName: device.name } : null
  }

  // http.IncomingMessage 的 headers 是普通对象，这里手写 cookie 解析（与 request.ts 同逻辑）
  const cookieHeader = req.headers['cookie']
  if (typeof cookieHeader === 'string') {
    for (const part of cookieHeader.split(';')) {
      const eq = part.indexOf('=')
      if (eq === -1) continue
      const name = part.slice(0, eq).trim()
      const value = part.slice(eq + 1).trim()
      if (name !== SESSION_COOKIE || !value) continue
      const token = decodeURIComponent(value)
      const session = verifySession(getDb(), token)
      return session ? { kind: 'session', sessionId: session.id } : null
    }
  }
  return null
}

/** 守卫所需的最小响应面（ServerResponse 结构兼容；测试可用轻量 mock） */
export interface GuardResponse {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  writeHead(...args: any[]): unknown
  end(body?: string): void
}

/**
 * 同步守卫（better-sqlite3 同步，可在 createServer 回调直接 await-free 调用）。
 * 返回 true 表示已放行（认证信息挂到 req.anchorAuth）；false 表示已写出响应，调用方直接 return。
 */
export function guardRequest(req: IncomingMessage, res: GuardResponse): boolean {
  const pathname = (req.url ?? '/').split('?')[0] || '/'

  // /api/setup：仅尚未设置密码时公开（每请求一次轻量点查）
  if (pathname === '/api/setup') {
    if (!hasPassword(getDb())) return true
  } else if (isPublicPath(pathname)) {
    return true
  }

  const principal = authenticateRequest(req)
  if (principal) {
    (req as AuthedRequest).anchorAuth = principal
    return true
  }

  // API 未认证：401 JSON + WWW-Authenticate
  if (pathname.startsWith('/api/')) {
    res.writeHead(401, {
      'content-type': 'application/json; charset=utf-8',
      'www-authenticate': 'Bearer',
    })
    res.end(JSON.stringify({ error: '未认证' }))
    return false
  }

  // 页面未认证：302 到登录页（未设密码时引导到首次设置页）
  const location = hasPassword(getDb()) ? '/login' : '/setup'
  res.writeHead(302, { location })
  res.end()
  return false
}
