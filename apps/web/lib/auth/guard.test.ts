// guard 中间件测试：临时 DB（惰性解析 ANCHOR_DB_PATH），用真实 IncomingMessage/ServerResponse。
import assert from 'node:assert/strict'
import test, { after, before } from 'node:test'
import { createHash } from 'node:crypto'
import { IncomingMessage } from 'http'
import { Socket } from 'net'
import { eq } from 'drizzle-orm'
import { authCredentials, closeDb, devices } from '@anchor/db'
import { cleanupDir, tempDbPath } from '../testUtils'
import { getDb } from '@/lib/db'
import { createSession } from './session'
import { SESSION_COOKIE } from './request'
import { authenticateRequest, guardRequest, isPublicPath, hasPassword } from './guard'

const { dir, dbPath } = tempDbPath('auth-guard')
process.env.ANCHOR_DB_PATH = dbPath

after(() => {
  closeDb(getDb())
  cleanupDir(dir)
})

function makeReq(url: string, headers: Record<string, string> = {}): IncomingMessage {
  const req = new IncomingMessage(new Socket())
  req.url = url
  req.headers = {}
  for (const [k, v] of Object.entries(headers)) req.headers[k.toLowerCase()] = v
  return req
}

interface MockRes {
  statusCode: number
  headers: Record<string, unknown>
  body: string
  writeHead(code: number, headers?: Record<string, unknown>): MockRes
  end(body?: string): void
  getHeader(name: string): unknown
}

// 轻量 mock：Node 的 ServerResponse 在无活 socket 时 writeHead 不落到 getHeader，
// 单元测试直接用 capturing mock 更可靠
function makeRes(): MockRes {
  const res: MockRes = {
    statusCode: 200,
    headers: {},
    body: '',
    writeHead(code, headers = {}) { this.statusCode = code; Object.assign(this.headers, headers); return this },
    end(body = '') { this.body = body },
    getHeader(name) { return this.headers[name] },
  }
  return res
}

before(() => {
  getDb() // 建库
})

test('isPublicPath：静态产物与公开页面/API 全部放行', () => {
  for (const p of [
    '/_next/static/chunk-abc.js',
    '/_next/image?url=%2Ficon.png',
    '/favicon.ico',
    '/icon.svg',
    '/icon-192.png',
    '/manifest.webmanifest',
    '/manifest.json',
    '/login',
    '/setup',
    '/api/login',
    '/api/me',
    '/api/pair',
    '/api/version',
  ]) {
    assert.ok(isPublicPath(p), `${p} 应公开`)
  }
  for (const p of ['/api/status', '/api/settings', '/diary', '/', '/api/setup']) {
    assert.ok(!isPublicPath(p), `${p} 不应在静态公开清单内`)
  }
})

test('api/setup：未设密码时公开，设密码后受保护', () => {
  const db = getDb()
  assert.equal(hasPassword(db), false)
  assert.equal(guardRequest(makeReq('/api/setup'), makeRes()), true)

  const now = Math.floor(Date.now() / 1000)
  db.insert(authCredentials).values({
    user_id: 'default',
    password_hash: 'x',
    scrypt_params: { n: 16384, r: 8, p: 1 },
    created_at: now,
    updated_at: now,
  }).run()
  assert.equal(hasPassword(db), true)

  const res = makeRes()
  assert.equal(guardRequest(makeReq('/api/setup'), res), false)
  assert.equal(res.statusCode, 401)
})

test('受保护 API 未认证 → 401 JSON + WWW-Authenticate', () => {
  const res = makeRes()
  const ok = guardRequest(makeReq('/api/status'), res)
  assert.equal(ok, false)
  assert.equal(res.statusCode, 401)
  assert.equal(res.getHeader('www-authenticate'), 'Bearer')
})

test('受保护页面未认证 → 302（已设密码到 /login）', () => {
  const res = makeRes()
  guardRequest(makeReq('/diary'), res)
  assert.equal(res.statusCode, 302)
  assert.equal(res.getHeader('location'), '/login')
})

test('未设密码时受保护页面 302 到 /setup', () => {
  const db = getDb()
  db.delete(authCredentials).where(eq(authCredentials.user_id, 'default')).run()
  const res = makeRes()
  guardRequest(makeReq('/diary'), res)
  assert.equal(res.statusCode, 302)
  assert.equal(res.getHeader('location'), '/setup')
})

test('有效 cookie 放行且挂上认证信息', () => {
  const token = createSession(getDb())
  const req = makeReq('/api/status', { cookie: `${SESSION_COOKIE}=${token}` })
  assert.equal(guardRequest(req, makeRes()), true)
  const auth = (req as unknown as { anchorAuth?: { kind: string; sessionId: number } }).anchorAuth
  assert.ok(auth, '应挂上认证信息')
  assert.equal(auth.kind, 'session')
  assert.equal(typeof auth.sessionId, 'number')
})

test('无效 cookie 不放行', () => {
  const req = makeReq('/api/status', { cookie: `${SESSION_COOKIE}=bogus` })
  assert.equal(guardRequest(req, makeRes()), false)
})

test('Bearer 分支：有效设备 token 放行（kind=device），无效/撤销拒绝且不回落 cookie', () => {
  const db = getDb()
  const now = Math.floor(Date.now() / 1000)
  // 造一条未撤销设备行，token 明文只在此测试内出现
  const token = 'guard-test-device-token'
  const tokenHash = createHash('sha256').update(token).digest('hex')
  const inserted = db.insert(devices).values({
    name: 'guard 测试机',
    token_hash: tokenHash,
    created_at: now,
    last_seen_at: now,
    revoked_at: null,
  }).run()
  const deviceId = Number(inserted.lastInsertRowid)

  const ok = authenticateRequest(makeReq('/api/status', { authorization: `Bearer ${token}` }))
  assert.deepEqual(ok, { kind: 'device', deviceId, deviceName: 'guard 测试机' })

  // 无效 token：显式凭证无效即拒绝，不回落 cookie 校验
  assert.equal(authenticateRequest(makeReq('/api/status', { authorization: 'Bearer bogus' })), null)

  // 撤销后拒绝
  db.update(devices).set({ revoked_at: now }).where(eq(devices.id, deviceId)).run()
  assert.equal(authenticateRequest(makeReq('/api/status', { authorization: `Bearer ${token}` })), null)
})
