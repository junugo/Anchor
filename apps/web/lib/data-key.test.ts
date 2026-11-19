// data-key 自动解析测试：env → stored → generated 优先级、生成持久化、二次启动、getDataKey 缓存、指纹格式。
// 单进程单库（getDb 单例），通过操纵 env 与缓存模拟多次启动。
import assert from 'node:assert/strict'
import test, { after, before } from 'node:test'
import { eq } from 'drizzle-orm'
import { closeDb, settings } from '@anchor/db'
import { dataKeyFingerprint } from '@anchor/utils'
import { cleanupDir, tempDbPath } from './testUtils'
import { getDb } from './db'
import { resolveDataKeyOnce, getDataKey, getDataKeySource, resetDataKeyCacheForTest } from './data-key'

const { dir, dbPath } = tempDbPath('data-key')
process.env.ANCHOR_DB_PATH = dbPath

// 保存原始 env 值，测试结束后还原（避免污染同进程其他测试文件——node:test 每文件独立进程，这里仅为保险）
const origEnvKey = process.env.ANCHOR_DATA_KEY
delete process.env.ANCHOR_DATA_KEY

before(() => {
  getDb() // 建库
})

after(() => {
  if (origEnvKey === undefined) delete process.env.ANCHOR_DATA_KEY
  else process.env.ANCHOR_DATA_KEY = origEnvKey
  closeDb(getDb())
  cleanupDir(dir)
})

test('env 优先：设置 ANCHOR_DATA_KEY 时直接用 env，不写 settings', () => {
  process.env.ANCHOR_DATA_KEY = '  env-key-123  ' // 含空白，应被 trim
  const db = getDb()
  const r = resolveDataKeyOnce(db)
  assert.equal(r.key, 'env-key-123')
  assert.equal(r.source, 'env')
  const row = db.select().from(settings).where(eq(settings.key, 'data_key')).get()
  assert.equal(row, undefined, 'env 优先时不应写 settings')
  delete process.env.ANCHOR_DATA_KEY
})

test('两者皆无：生成立即入库，source=generated', () => {
  const db = getDb()
  const r = resolveDataKeyOnce(db)
  assert.equal(r.source, 'generated')
  assert.match(r.key, /^[0-9a-f]{64}$/, '生成的密钥为 32B hex')
  const row = db.select().from(settings).where(eq(settings.key, 'data_key')).get()
  assert.equal(row?.value, r.key, '生成的密钥应持久化到 settings')
})

test('二次启动：settings 已有值时 source=stored 且密钥相同', () => {
  const db = getDb()
  const first = resolveDataKeyOnce(db)
  assert.equal(first.source, 'stored')
  const second = resolveDataKeyOnce(db)
  assert.equal(second.source, 'stored')
  assert.equal(second.key, first.key)
})

test('getDataKey：进程内缓存（多次调用同引用），清除缓存后重新解析', () => {
  resetDataKeyCacheForTest()
  const k1 = getDataKey()
  const k2 = getDataKey()
  assert.equal(k1, k2)
  assert.equal(getDataKeySource(), 'stored')
  const db = getDb()
  const row = db.select().from(settings).where(eq(settings.key, 'data_key')).get()
  assert.equal(k1, row?.value)
})

test('指纹格式：8 位 base64 字符', async () => {
  const fp = await dataKeyFingerprint(getDataKey())
  assert.match(fp, /^[A-Za-z0-9+/=_-]{8}$/)
})
