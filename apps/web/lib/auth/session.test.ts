import assert from 'node:assert/strict'
import test from 'node:test'
import { eq } from 'drizzle-orm'
import { closeDb, createDb, sessions, type Db } from '@anchor/db'
import { cleanupDir, tempDbPath } from '../testUtils'
import { cleanupExpiredSessions, createSession, destroySession, verifySession } from './session'

function withDb(name: string, fn: (db: Db) => void) {
  const { dir, dbPath } = tempDbPath(name)
  const db = createDb(dbPath)
  try {
    fn(db)
  } finally {
    closeDb(db)
    cleanupDir(dir)
  }
}

test('session：创建→校验往返', () => {
  withDb('auth-session-roundtrip', (db) => {
    const token = createSession(db, 3600)
    assert.ok(token.length > 0)
    // 库存的是 sha256 hex，不是明文
    const row = db.select().from(sessions).get()
    assert.equal(row?.token_hash.length, 64)
    assert.notEqual(row?.token_hash, token)

    const verified = verifySession(db, token)
    assert.ok(verified)
    assert.equal(verified.id, row?.id)
    assert.ok(verified.expiresAt > Math.floor(Date.now() / 1000))
  })
})

test('session：未知 token / 过期 token 返回 null', () => {
  withDb('auth-session-expired', (db) => {
    assert.equal(verifySession(db, 'nonexistent'), null)

    const token = createSession(db, 3600)
    // 手动把 expires_at 拨到过去
    db.update(sessions).set({ expires_at: Math.floor(Date.now() / 1000) - 10 }).run()
    assert.equal(verifySession(db, token), null)
  })
})

test('session：剩余不足一半时滑动续期', () => {
  withDb('auth-session-rolling', (db) => {
    const ttl = 3600
    const token = createSession(db, ttl)
    const now = Math.floor(Date.now() / 1000)
    // 制造「剩余不足一半」：ttl 保持 3600，expires_at 拨到 now+1000
    db.update(sessions).set({ created_at: now + 1000 - ttl, expires_at: now + 1000 }).run()

    const verified = verifySession(db, token)
    assert.ok(verified)
    // 已续期到 now+ttl 附近
    assert.ok(verified.expiresAt >= now + ttl - 5, `续期后 expiresAt=${verified.expiresAt} 应接近 now+ttl`)
    const row = db.select().from(sessions).where(eq(sessions.id, verified.id)).get()
    assert.equal(row?.expires_at, verified.expiresAt)
  })
})

test('session：剩余超过一半时不续期', () => {
  withDb('auth-session-no-rolling', (db) => {
    const token = createSession(db, 3600)
    const before = db.select().from(sessions).get()
    const verified = verifySession(db, token)
    assert.equal(verified?.expiresAt, before?.expires_at)
  })
})

test('session：destroy 后校验为 null', () => {
  withDb('auth-session-destroy', (db) => {
    const token = createSession(db, 3600)
    destroySession(db, token)
    assert.equal(verifySession(db, token), null)
    assert.equal(db.select().from(sessions).all().length, 0)
  })
})

test('session：cleanup 只删过期会话', () => {
  withDb('auth-session-cleanup', (db) => {
    createSession(db, 3600)
    createSession(db, 3600)
    const alive = createSession(db, 3600)
    const now = Math.floor(Date.now() / 1000)
    // 直接把前两条拨到过去
    const rows = db.select().from(sessions).all()
    db.update(sessions).set({ expires_at: now - 10 }).where(eq(sessions.id, rows[0].id)).run()
    db.update(sessions).set({ expires_at: now - 10 }).where(eq(sessions.id, rows[1].id)).run()

    const removed = cleanupExpiredSessions(db)
    assert.equal(removed, 2)
    assert.equal(db.select().from(sessions).all().length, 1)
    assert.ok(verifySession(db, alive))
    assert.equal(cleanupExpiredSessions(db), 0)
  })
})
