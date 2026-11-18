import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { eq } from 'drizzle-orm'
import {
  authCredentials, closeDb, createDb, devices, pairCodes, sessions, settings,
} from '@anchor/db'
import { tempDbPath } from './testUtils'

// 期望的列定义：name → { type, notnull, dflt_value }
const EXPECTED_AUTH_TABLES: Record<string, Record<string, { type: string; notnull: number; dflt?: string | null }>> = {
  settings: {
    key: { type: 'TEXT', notnull: 0 },
    value: { type: 'TEXT', notnull: 1 },
  },
  auth_credentials: {
    id: { type: 'INTEGER', notnull: 0 },
    user_id: { type: 'TEXT', notnull: 1 },
    password_hash: { type: 'TEXT', notnull: 1 },
    scrypt_params: { type: 'TEXT', notnull: 1 },
    created_at: { type: 'INTEGER', notnull: 1 },
    updated_at: { type: 'INTEGER', notnull: 1 },
  },
  sessions: {
    id: { type: 'INTEGER', notnull: 0 },
    token_hash: { type: 'TEXT', notnull: 1 },
    created_at: { type: 'INTEGER', notnull: 1 },
    expires_at: { type: 'INTEGER', notnull: 1 },
  },
  devices: {
    id: { type: 'INTEGER', notnull: 0 },
    name: { type: 'TEXT', notnull: 1 },
    token_hash: { type: 'TEXT', notnull: 1 },
    client_version: { type: 'TEXT', notnull: 0 },
    created_at: { type: 'INTEGER', notnull: 1 },
    last_seen_at: { type: 'INTEGER', notnull: 0 },
    revoked_at: { type: 'INTEGER', notnull: 0 },
  },
  pair_codes: {
    id: { type: 'INTEGER', notnull: 0 },
    code_hash: { type: 'TEXT', notnull: 1 },
    expires_at: { type: 'INTEGER', notnull: 1 },
    attempts: { type: 'INTEGER', notnull: 1, dflt: '0' },
    consumed_at: { type: 'INTEGER', notnull: 0 },
    created_at: { type: 'INTEGER', notnull: 1 },
  },
}

function cleanupDir(dir: string) {
  for (let i = 0; i < 20; i++) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return } catch { /* Windows 文件句柄释放有延迟，重试 */ }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
  }
  fs.rmSync(dir, { recursive: true, force: true })
}

type RawSqlite = { prepare: (sql: string) => { all: () => Array<{ name: string; type: string; notnull: number; dflt_value: string | null; pk: number }>; get: () => unknown; run: (...args: unknown[]) => void }; exec: (sql: string) => void }

function rawSqlite(db: unknown): RawSqlite {
  return (db as any).session.client as RawSqlite
}

function tableColumns(sqlite: RawSqlite, table: string) {
  return sqlite.prepare(`PRAGMA table_info(${table})`).all()
}

test('V2.0 阶段 1a：新库初始化后 5 张认证表存在且字段正确', () => {
  const { dir, dbPath } = tempDbPath('auth-schema')
  let db: ReturnType<typeof createDb> | undefined
  try {
    db = createDb(dbPath)
    const sqlite = rawSqlite(db)

    for (const [table, expectedCols] of Object.entries(EXPECTED_AUTH_TABLES)) {
      const cols = tableColumns(sqlite, table)
      assert.ok(cols.length > 0, `表 ${table} 应存在`)
      const actual = Object.fromEntries(cols.map(c => [c.name, c]))
      for (const [name, exp] of Object.entries(expectedCols)) {
        const col = actual[name]
        assert.ok(col, `表 ${table} 缺少列 ${name}`)
        assert.equal(col.type, exp.type, `${table}.${name} 类型`)
        assert.equal(col.notnull, exp.notnull, `${table}.${name} notnull`)
        if (exp.dflt !== undefined) assert.equal(col.dflt_value, exp.dflt, `${table}.${name} 默认值`)
      }
    }

    // 唯一索引存在（内联 UNIQUE 约束产生 sqlite_autoindex_* 自动索引）
    const sessionIdx = sqlite.prepare(`PRAGMA index_list(sessions)`).all() as unknown as Array<{ name: string; unique: number }>
    assert.ok(sessionIdx.some(i => i.unique === 1), 'sessions 应有唯一索引')
    const deviceIdx = sqlite.prepare(`PRAGMA index_list(devices)`).all() as unknown as Array<{ name: string; unique: number }>
    assert.ok(deviceIdx.some(i => i.unique === 1), 'devices 应有唯一索引')
  } finally {
    closeDb(db)
    cleanupDir(dir)
  }
})

test('V2.0 阶段 1a：迁移幂等，重复打开同一库不炸', () => {
  const { dir, dbPath } = tempDbPath('auth-schema-idempotent')
  let db: ReturnType<typeof createDb> | undefined
  let db2: ReturnType<typeof createDb> | undefined
  try {
    db = createDb(dbPath)
    closeDb(db); db = undefined
    db2 = createDb(dbPath) // 迁移在已有库上重放
    const sqlite = rawSqlite(db2)
    for (const table of Object.keys(EXPECTED_AUTH_TABLES)) {
      assert.ok(tableColumns(sqlite, table).length > 0, `重复迁移后表 ${table} 应仍存在`)
    }
  } finally {
    closeDb(db)
    closeDb(db2)
    cleanupDir(dir)
  }
})

test('V2.0 阶段 1a：老库（缺认证表）升级后 5 张表补齐且旧数据保留', () => {
  const { dir, dbPath } = tempDbPath('auth-schema-upgrade')
  let db: ReturnType<typeof createDb> | undefined
  try {
    // 模拟老库：先初始化一次，删掉 5 张认证表并写入一行旧数据，再重放迁移
    const legacy = createDb(dbPath)
    const legacySqlite = rawSqlite(legacy)
    legacySqlite.exec(`DROP TABLE IF EXISTS settings`)
    legacySqlite.exec(`DROP TABLE IF EXISTS auth_credentials`)
    legacySqlite.exec(`DROP TABLE IF EXISTS sessions`)
    legacySqlite.exec(`DROP TABLE IF EXISTS devices`)
    legacySqlite.exec(`DROP TABLE IF EXISTS pair_codes`)
    legacySqlite.prepare(`INSERT INTO behavior_logs (source, event_type, payload, logged_at) VALUES ('desktop', 'window_focus', '{}', 12345)`).run()
    closeDb(legacy)

    db = createDb(dbPath)
    const sqlite = rawSqlite(db)
    for (const table of Object.keys(EXPECTED_AUTH_TABLES)) {
      assert.ok(tableColumns(sqlite, table).length > 0, `老库升级后表 ${table} 应补齐`)
    }
    const legacyRow = sqlite.prepare(`SELECT * FROM behavior_logs WHERE logged_at = 12345`).get()
    assert.ok(legacyRow, '旧数据应保留')
  } finally {
    closeDb(db)
    cleanupDir(dir)
  }
})

test('认证相关表可正常读写（含 JSON 与默认值）', () => {
  const { dir, dbPath } = tempDbPath('auth-schema-crud')
  let db: ReturnType<typeof createDb> | undefined
  try {
    db = createDb(dbPath)
    const now = Math.floor(Date.now() / 1000)

    db.insert(settings).values({ key: 'data_key', value: 'anchor-dev-data-key' }).run()
    assert.equal(db.select().from(settings).get()?.value, 'anchor-dev-data-key')

    db.insert(authCredentials).values({
      user_id: 'default',
      password_hash: 'abc',
      scrypt_params: { n: 16384, r: 8, p: 1 },
      created_at: now,
      updated_at: now,
    }).run()
    const cred = db.select().from(authCredentials).where(eq(authCredentials.user_id, 'default')).get()
    assert.deepEqual(cred?.scrypt_params, { n: 16384, r: 8, p: 1 })

    db.insert(sessions).values({ token_hash: 's1', created_at: now, expires_at: now + 3600 }).run()
    assert.equal(db.select().from(sessions).get()?.token_hash, 's1')

    db.insert(devices).values({ name: 'desktop-rs', token_hash: 'd1', created_at: now }).run()
    const device = db.select().from(devices).get()
    assert.equal(device?.client_version, null)
    assert.equal(device?.revoked_at, null)

    db.insert(pairCodes).values({ code_hash: 'c1', expires_at: now + 300, created_at: now }).run()
    assert.equal(db.select().from(pairCodes).get()?.attempts, 0)
  } finally {
    closeDb(db)
    cleanupDir(dir)
  }
})
