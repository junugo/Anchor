// 设备管理路由集成测试：列表字段/排序、撤销幂等、404；生成配对码时惰性清理过期历史码。
// 临时 DB，不碰开发库；按顺序执行（node:test 顶层测试默认串行）。
import assert from 'node:assert/strict'
import test, { after } from 'node:test'
import { eq } from 'drizzle-orm'
import { closeDb, devices, pairCodes } from '@anchor/db'
import { cleanupDir, tempDbPath } from '../testUtils'
import { getDb } from '@/lib/db'
import { createSession } from './session'
import { SESSION_COOKIE } from './request'

const { dir, dbPath } = tempDbPath('devices-routes')
process.env.ANCHOR_DB_PATH = dbPath

// 动态引入路由：handler 内部才调 getDb()，保证此时 env 已就绪
const { GET: listDevices } = await import('../../app/api/devices/route')
const { POST: revokeDevice } = await import('../../app/api/devices/[id]/revoke/route')
const { POST: codes } = await import('../../app/api/pair/codes/route')

after(() => {
  closeDb(getDb())
  cleanupDir(dir)
})

const sessionCookie = () => `${SESSION_COOKIE}=${createSession(getDb())}`
const NOW = Math.floor(Date.now() / 1000)

function req(path: string, method = 'GET') {
  return new Request(`http://localhost${path}`, { method })
}

function seedDevice(name: string, createdAt: number, overrides: Partial<{ last_seen_at: number | null; revoked_at: number | null; client_version: string }> = {}) {
  const db = getDb()
  const inserted = db.insert(devices).values({
    name,
    token_hash: `${name}-${createdAt}-hash`,
    client_version: overrides.client_version ?? '1.0.0',
    created_at: createdAt,
    last_seen_at: overrides.last_seen_at ?? null,
    revoked_at: overrides.revoked_at ?? null,
  }).run()
  return Number(inserted.lastInsertRowid)
}

test('list：未登录 401', async () => {
  const res = await listDevices(req('/api/devices'))
  assert.equal(res.status, 401)
})

test('list：字段、空值与 created_at 倒序', async () => {
  const db = getDb()
  db.delete(devices).run()
  const idOld = seedDevice('旧设备', NOW - 2000, { client_version: '0.9.0', last_seen_at: NOW - 60 })
  const idNew = seedDevice('新设备', NOW - 1000, { last_seen_at: NOW - 10 })

  const res = await listDevices(new Request('http://localhost/api/devices', { headers: { cookie: sessionCookie() } }))
  assert.equal(res.status, 200)
  const body = await res.json() as { devices: {
    id: number; name: string; clientVersion: string | null
    createdAt: number; lastSeenAt: number | null; revokedAt: number | null
  }[] }
  assert.equal(body.devices.length, 2)
  assert.equal(body.devices[0].id, idNew, '最新创建的在最前')
  assert.equal(body.devices[1].id, idOld)
  assert.equal(body.devices[0].name, '新设备')
  assert.equal(body.devices[0].clientVersion, '1.0.0')
  assert.equal(body.devices[0].createdAt, NOW - 1000)
  assert.equal(body.devices[0].lastSeenAt, NOW - 10)
  assert.equal(body.devices[0].revokedAt, null)
})

test('list：含已撤销设备', async () => {
  const id = seedDevice('已撤设备', NOW - 500, { revoked_at: NOW - 100 })
  const res = await listDevices(new Request('http://localhost/api/devices', { headers: { cookie: sessionCookie() } }))
  const body = await res.json() as { devices: { id: number; revokedAt: number | null }[] }
  const row = body.devices.find(d => d.id === id)
  assert.ok(row)
  assert.equal(row.revokedAt, NOW - 100)
})

test('revoke：不存在 404（含非法 id）', async () => {
  const r1 = await revokeDevice(new Request('http://localhost/api/devices/999/revoke', {
    method: 'POST', headers: { cookie: sessionCookie() },
  }), { params: Promise.resolve({ id: '999' }) })
  assert.equal(r1.status, 404)
  const r2 = await revokeDevice(new Request('http://localhost/api/devices/abc/revoke', {
    method: 'POST', headers: { cookie: sessionCookie() },
  }), { params: Promise.resolve({ id: 'abc' }) })
  assert.equal(r2.status, 404)
})

test('revoke：未登录 401', async () => {
  const id = seedDevice('未登录撤销', NOW - 400)
  const res = await revokeDevice(req(`/api/devices/${id}/revoke`, 'POST'), { params: Promise.resolve({ id: String(id) }) })
  assert.equal(res.status, 401)
})

test('revoke：写入 revoked_at 并幂等', async () => {
  const db = getDb()
  const id = seedDevice('待撤销', NOW - 300)
  const doRevoke = () => revokeDevice(
    new Request(`http://localhost/api/devices/${id}/revoke`, { method: 'POST', headers: { cookie: sessionCookie() } }),
    { params: Promise.resolve({ id: String(id) }) },
  )
  const r1 = await doRevoke()
  assert.equal(r1.status, 200)
  assert.deepEqual(await r1.json(), { ok: true })
  const row = db.select().from(devices).where(eq(devices.id, id)).get()
  assert.ok(row && row.revoked_at !== null && Math.abs(row.revoked_at - NOW) <= 60)

  const r2 = await doRevoke()
  assert.equal(r2.status, 200)
  assert.deepEqual(await r2.json(), { ok: true }, '已撤销重复调用幂等')
  const row2 = db.select().from(devices).where(eq(devices.id, id)).get()
  assert.equal(row2?.revoked_at, row?.revoked_at, '幂等且不覆盖原撤销时间')
})

test('codes：生成时物理删除过期超过一天的历史码，保留其他码', async () => {
  const db = getDb()
  db.delete(pairCodes).run()
  const oldNow = NOW
  db.insert(pairCodes).values({
    code_hash: 'old-stale',
    expires_at: oldNow - 90000, // 过期 > 1 天，应被清理
    attempts: 0,
    consumed_at: null,
    created_at: oldNow - 100000,
  }).run()
  db.insert(pairCodes).values({
    code_hash: 'keep-recent-expired',
    expires_at: oldNow - 3600, // 仅过期 1 小时，保留
    attempts: 0,
    consumed_at: null,
    created_at: oldNow - 7200,
  }).run()

  const res = await codes(new Request('http://localhost/api/pair/codes', {
    method: 'POST',
    headers: { cookie: sessionCookie() },
  }))
  assert.equal(res.status, 200)

  const rows = db.select().from(pairCodes).all()
  assert.ok(!rows.some(r => r.code_hash === 'old-stale'), '过期超一天的行已被物理删除')
  assert.ok(rows.some(r => r.code_hash === 'keep-recent-expired'), '仅过期 1 小时的行保留')
  assert.equal(rows.length, 2, '保留行 + 新码')
  const now = Math.floor(Date.now() / 1000)
  assert.ok(rows.every(r => r.expires_at >= now - 3601))
})
