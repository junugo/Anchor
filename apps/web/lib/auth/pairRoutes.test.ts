// 配对路由集成测试：codes 生成（需登录）+ pair 兑换（公开限频），临时 DB，不碰开发库。
// 每个测试文件独立进程，本文件共享一个库，按顺序执行（node:test 顶层测试默认串行）。
import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { createHash } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { closeDb, devices, pairCodes } from '@anchor/db'
import { cleanupDir, tempDbPath } from '../testUtils'
import { getDb } from '@/lib/db'
import { createSession } from './session'
import { SESSION_COOKIE } from './request'
import pkg from '../../package.json'

const { dir, dbPath } = tempDbPath('pair-routes')
process.env.ANCHOR_DB_PATH = dbPath

// 动态引入路由：handler 内部才调 getDb()，保证此时 env 已就绪
const { POST: codes } = await import('../../app/api/pair/codes/route')
const { POST: pair } = await import('../../app/api/pair/route')
const { GET: version } = await import('../../app/api/version/route')

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

const INVALID = '配对码无效或已过期'
const sessionCookie = () => `${SESSION_COOKIE}=${createSession(getDb())}`

test('codes：未登录 401', async () => {
  const res = await codes(jsonReq('/api/pair/codes', {}))
  assert.equal(res.status, 401)
})

test('codes：登录后生成 8 位 Crockford Base32 码，expiresAt=now+300', async () => {
  const res = await codes(jsonReq('/api/pair/codes', {}, { cookie: sessionCookie() }))
  assert.equal(res.status, 200)
  const body = await res.json() as { code: string; expiresAt: number }
  assert.match(body.code, /^[0-9A-HJKMNP-TV-Z]{8}$/)
  const now = Math.floor(Date.now() / 1000)
  assert.ok(body.expiresAt >= now + 299 && body.expiresAt <= now + 301, 'expiresAt 应≈now+300')
})

test('pair：参数非法 400（缺 deviceName / 空 code）', async () => {
  assert.equal((await pair(jsonReq('/api/pair', { code: 'ABCD2345' }))).status, 400)
  assert.equal((await pair(jsonReq('/api/pair', { code: '', deviceName: 'x' }))).status, 400)
  const longName = 'x'.repeat(65)
  assert.equal((await pair(jsonReq('/api/pair', { code: 'ABCD2345', deviceName: longName }))).status, 400)
})

test('pair：码不存在 → 统一 401 文案', async () => {
  const res = await pair(jsonReq('/api/pair', { code: 'ZZZZ9999', deviceName: '测试机' }))
  assert.equal(res.status, 401)
  assert.deepEqual(await res.json(), { error: INVALID })
})

test('pair：错一次 attempts+1，错 5 次码作废', async () => {
  const db = getDb()
  db.delete(pairCodes).run() // 隔离：清掉前面测试遗留的码，保证种子码即最新未消费码
  const now = Math.floor(Date.now() / 1000)
  const codeHash = createHash('sha256').update('SEEDCODE').digest('hex')
  const inserted = db.insert(pairCodes).values({
    code_hash: codeHash,
    expires_at: now + 300,
    attempts: 0,
    consumed_at: null,
    created_at: now,
  }).run()
  const id = Number(inserted.lastInsertRowid)

  for (let i = 1; i <= 4; i++) {
    const res = await pair(jsonReq('/api/pair', { code: 'WRONG001', deviceName: 'x' }, { 'x-forwarded-for': '10.9.9.1' }))
    assert.equal(res.status, 401)
    assert.equal(db.select().from(pairCodes).where(eq(pairCodes.id, id)).get()!.attempts, i)
  }
  // 第 5 次错误：attempts 达 5 → 作废
  const res5 = await pair(jsonReq('/api/pair', { code: 'WRONG001', deviceName: 'x' }, { 'x-forwarded-for': '10.9.9.1' }))
  assert.equal(res5.status, 401)
  const row = db.select().from(pairCodes).where(eq(pairCodes.id, id)).get()!
  assert.ok(row.consumed_at !== null, '尝试耗尽应作废')
})

test('pair：过期码 → 统一 401', async () => {
  const db = getDb()
  const now = Math.floor(Date.now() / 1000)
  const code = 'EXPIRED1'
  db.insert(pairCodes).values({
    code_hash: createHash('sha256').update(code).digest('hex'),
    expires_at: now - 10,
    attempts: 0,
    consumed_at: null,
    created_at: now - 400,
  }).run()
  const res = await pair(jsonReq('/api/pair', { code, deviceName: 'x' }, { 'x-forwarded-for': '10.9.9.2' }))
  assert.equal(res.status, 401)
  assert.deepEqual(await res.json(), { error: INVALID })
})

test('pair：完整兑换 → token/dataKey/serverVersion/deviceId，device 行 token_hash=sha256', async () => {
  const db = getDb()
  // 生成码
  const resCode = await codes(jsonReq('/api/pair/codes', {}, { cookie: sessionCookie() }))
  const { code } = await resCode.json() as { code: string }

  // 兑换（小写 + 前后空格也应规范化成功）
  const res = await pair(jsonReq('/api/pair', { code: ` ${code.toLowerCase()} `, deviceName: '桌面守护' }, { 'x-forwarded-for': '10.9.9.3' }))
  assert.equal(res.status, 200)
  const body = await res.json() as { token: string; dataKey: string; serverVersion: string; deviceId: number }
  assert.equal(typeof body.token, 'string')
  assert.ok(body.token.length > 20)
  assert.equal(typeof body.dataKey, 'string')
  assert.equal(body.serverVersion, pkg.version)

  const dev = db.select().from(devices).where(eq(devices.id, body.deviceId)).get()
  assert.ok(dev)
  assert.equal(dev.name, '桌面守护')
  assert.equal(dev.token_hash, createHash('sha256').update(body.token).digest('hex'))
  assert.ok(dev.last_seen_at !== null)
})

test('pair：兑换后码不可复用（二次兑换 401）', async () => {
  const resCode = await codes(jsonReq('/api/pair/codes', {}, { cookie: sessionCookie() }))
  const { code } = await resCode.json() as { code: string }
  const ip = { 'x-forwarded-for': '10.9.9.4' }
  const first = await pair(jsonReq('/api/pair', { code, deviceName: '一' }, ip))
  assert.equal(first.status, 200)
  const second = await pair(jsonReq('/api/pair', { code, deviceName: '二' }, ip))
  assert.equal(second.status, 401)
  assert.deepEqual(await second.json(), { error: INVALID })
})

test('pair：限频 10 次/分，第 11 次 429', async () => {
  const ip = '10.9.9.5'
  let last = 0
  for (let i = 0; i < 11; i++) {
    const res = await pair(jsonReq('/api/pair', { code: 'RATE0000', deviceName: 'x' }, { 'x-forwarded-for': ip }))
    last = res.status
  }
  assert.equal(last, 429)
})

test('version：返回 package.json 版本号', async () => {
  const res = await version()
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { version: pkg.version })
})
