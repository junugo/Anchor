// Web 会话：明文 token 只出现一次（返回值），库存 sha256 hex。
// 滑动续期：剩余有效期不足一半时延长为「创建时 TTL」后的时刻。
import { createHash, randomBytes } from 'node:crypto'
import { eq, lt } from 'drizzle-orm'
import { sessions, type Db } from '@anchor/db'

const DEFAULT_TTL_SECONDS = 30 * 24 * 3600 // 30 天

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

/** 创建会话，返回明文 token（仅此一次，之后只存哈希） */
export function createSession(db: Db, ttlSeconds: number = DEFAULT_TTL_SECONDS): string {
  const token = randomBytes(32).toString('base64url')
  const now = Math.floor(Date.now() / 1000)
  db.insert(sessions).values({
    token_hash: hashToken(token),
    created_at: now,
    expires_at: now + ttlSeconds,
  }).run()
  return token
}

export interface VerifiedSession {
  id: number
  expiresAt: number
}

/** 校验会话（未过期）；命中即按需滑动续期 */
export function verifySession(db: Db, token: string): VerifiedSession | null {
  const row = db.select().from(sessions).where(eq(sessions.token_hash, hashToken(token))).get()
  if (!row) return null
  const now = Math.floor(Date.now() / 1000)
  if (row.expires_at <= now) return null

  // 原始 TTL = expires_at - created_at；剩余不足一半时滑动续期
  const ttl = row.expires_at - row.created_at
  if (row.expires_at - now < ttl / 2) {
    const newExpiresAt = now + ttl
    db.update(sessions).set({ expires_at: newExpiresAt }).where(eq(sessions.id, row.id)).run()
    return { id: row.id, expiresAt: newExpiresAt }
  }
  return { id: row.id, expiresAt: row.expires_at }
}

export function destroySession(db: Db, token: string): void {
  db.delete(sessions).where(eq(sessions.token_hash, hashToken(token))).run()
}

/** 物理删除过期会话，返回清理数量（后续挂到 hourly tick） */
export function cleanupExpiredSessions(db: Db): number {
  const now = Math.floor(Date.now() / 1000)
  const result = db.delete(sessions).where(lt(sessions.expires_at, now)).run()
  return Number(result.changes)
}
