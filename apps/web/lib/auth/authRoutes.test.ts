// 认证路由集成测试：用临时 DB（ANCHOR_DB_PATH 惰性解析，首个请求时才建连），不碰开发库。
// 每个测试文件独立进程，本文件共享一个库，按顺序执行（node:test 顶层测试默认串行）。
import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { closeDb } from '@anchor/db'
import { cleanupDir, tempDbPath } from '../testUtils'
import { getDb } from '@/lib/db'
import { SESSION_COOKIE } from './request'

const { dir, dbPath } = tempDbPath('auth-routes')
process.env.ANCHOR_DB_PATH = dbPath

// 动态引入路由：handler 内部才调 getDb()，保证此时 env 已就绪
const { POST: setup } = await import('../../app/api/setup/route')
const { POST: login } = await import('../../app/api/login/route')
const { POST: logout } = await import('../../app/api/logout/route')
const { GET: me } = await import('../../app/api/me/route')
const { POST: password } = await import('../../app/api/password/route')

after(() => {
  closeDb(getDb())
  cleanupDir(dir)
})

function jsonReq(path: string, body: unknown, headers: Record<string, string> = {}) {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
}

/** 取 Set-Cookie（Node 18.14+ 的 getSetCookie 不可用则回退解析字符串） */
function getSetCookie(res: Response): string[] {
  const h = res.headers as Headers & { getSetCookie?: () => string[] }
  if (typeof h.getSetCookie === 'function') return h.getSetCookie()
  const single = res.headers.get('set-cookie')
  return single ? [single] : []
}

/** 从 Set-Cookie 中提取 anchor_session token */
function extractToken(res: Response): string {
  const cookie = getSetCookie(res).find((c) => c.startsWith(`${SESSION_COOKIE}=`))
  assert.ok(cookie, '响应应带 anchor_session Set-Cookie')
  const pair = cookie.split(';')[0]
  const token = pair.slice(pair.indexOf('=') + 1)
  assert.ok(token)
  return token
}

let token = '' // 登录成功签发的会话 token，后续路由复用

test('me：无密码时 hasPassword=false authenticated=false', async () => {
  const res = await me(new Request('http://localhost/api/me'))
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { hasPassword: false, authenticated: false })
})

test('login：未设置密码时 409', async () => {
  const res = await login(jsonReq('/api/login', { password: 'whatever123' }, { 'x-forwarded-for': '10.0.0.1' }))
  assert.equal(res.status, 409)
  assert.deepEqual(await res.json(), { error: '尚未设置密码' })
})

test('setup：短密码 400', async () => {
  const res = await setup(jsonReq('/api/setup', { password: 'short' }))
  assert.equal(res.status, 400)
})

test('setup：成功设置密码 → me.hasPassword=true', async () => {
  const res = await setup(jsonReq('/api/setup', { password: 'correct-horse' }))
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { ok: true })

  const meRes = await me(new Request('http://localhost/api/me'))
  assert.deepEqual(await meRes.json(), { hasPassword: true, authenticated: false })
})

test('setup：重复设置 409', async () => {
  const res = await setup(jsonReq('/api/setup', { password: 'another-pass' }))
  assert.equal(res.status, 409)
  assert.deepEqual(await res.json(), { error: '已设置过密码' })
})

test('login：错误密码 401', async () => {
  const res = await login(jsonReq('/api/login', { password: 'wrong-password' }, { 'x-forwarded-for': '10.0.0.2' }))
  assert.equal(res.status, 401)
  assert.deepEqual(await res.json(), { error: '密码错误' })
})

test('login：http 成功 → cookie 无 Secure', async () => {
  const res = await login(jsonReq('/api/login', { password: 'correct-horse' }, { 'x-forwarded-for': '10.0.0.3' }))
  assert.equal(res.status, 200)
  const [cookie] = getSetCookie(res)
  assert.ok(cookie.startsWith(`${SESSION_COOKIE}=`))
  assert.match(cookie, /HttpOnly/)
  assert.match(cookie, /Path=\//)
  assert.match(cookie, /SameSite=Lax/)
  assert.match(cookie, /Max-Age=2592000/)
  assert.doesNotMatch(cookie, /Secure/)
  token = extractToken(res)
})

test('login：https（x-forwarded-proto）成功 → cookie 带 Secure', async () => {
  const res = await login(jsonReq('/api/login', { password: 'correct-horse' }, {
    'x-forwarded-for': '10.0.0.4',
    'x-forwarded-proto': 'https',
  }))
  assert.equal(res.status, 200)
  const [cookie] = getSetCookie(res)
  assert.match(cookie, /Secure/)
})

test('login：同一 IP 1 分钟内第 6 次 429', async () => {
  const ip = '10.0.0.5'
  for (let i = 0; i < 5; i++) {
    const res = await login(jsonReq('/api/login', { password: 'wrong-password' }, { 'x-forwarded-for': ip }))
    assert.equal(res.status, 401, `第 ${i + 1} 次应 401`)
  }
  const res = await login(jsonReq('/api/login', { password: 'wrong-password' }, { 'x-forwarded-for': ip }))
  assert.equal(res.status, 429)
})

test('me：已登录时 authenticated=true', async () => {
  const res = await me(new Request('http://localhost/api/me', {
    headers: { cookie: `${SESSION_COOKIE}=${token}` },
  }))
  assert.deepEqual(await res.json(), { hasPassword: true, authenticated: true })
})

test('logout：清除 cookie 且会话失效', async () => {
  const res = await logout(new Request('http://localhost/api/logout', {
    method: 'POST',
    headers: { cookie: `${SESSION_COOKIE}=${token}` },
  }))
  assert.equal(res.status, 200)
  const [cookie] = getSetCookie(res)
  assert.match(cookie, /Max-Age=0/)

  const meRes = await me(new Request('http://localhost/api/me', {
    headers: { cookie: `${SESSION_COOKIE}=${token}` },
  }))
  assert.deepEqual(await meRes.json(), { hasPassword: true, authenticated: false })
})

test('logout：未登录也 200（幂等）', async () => {
  const res = await logout(new Request('http://localhost/api/logout', { method: 'POST' }))
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { ok: true })
})

test('password：未登录 401', async () => {
  const res = await password(jsonReq('/api/password', { currentPassword: 'correct-horse', newPassword: 'new-pass-123' }))
  assert.equal(res.status, 401)
})

test('password：旧密码错误 401', async () => {
  const res = await login(jsonReq('/api/login', { password: 'correct-horse' }, { 'x-forwarded-for': '10.0.0.6' }))
  assert.equal(res.status, 200)
  const t = extractToken(res)

  const failRes = await password(jsonReq('/api/password', { currentPassword: 'not-the-old-one', newPassword: 'new-pass-123' }, {
    cookie: `${SESSION_COOKIE}=${t}`,
  }))
  assert.equal(failRes.status, 401)
})

test('password：改密后旧密码登录失败、新密码成功', async () => {
  const res = await login(jsonReq('/api/login', { password: 'correct-horse' }, { 'x-forwarded-for': '10.0.0.7' }))
  assert.equal(res.status, 200)
  const t = extractToken(res)

  const okRes = await password(jsonReq('/api/password', { currentPassword: 'correct-horse', newPassword: 'brand-new-pass' }, {
    cookie: `${SESSION_COOKIE}=${t}`,
  }))
  assert.equal(okRes.status, 200)
  assert.deepEqual(await okRes.json(), { ok: true })

  const oldLogin = await login(jsonReq('/api/login', { password: 'correct-horse' }, { 'x-forwarded-for': '10.0.0.8' }))
  assert.equal(oldLogin.status, 401)

  const newLogin = await login(jsonReq('/api/login', { password: 'brand-new-pass' }, { 'x-forwarded-for': '10.0.0.9' }))
  assert.equal(newLogin.status, 200)
  assert.ok(getSetCookie(newLogin).length > 0)
})
