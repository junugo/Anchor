import type { Db } from '@anchor/db'
import { timeCapsules } from '@anchor/db'
import { eq } from 'drizzle-orm'

/**
 * 直接播放胶囊（替代 localhost fetch 自调用）
 * 从 time_capsules 表查询匹配 trigger 的胶囊，随机选取一条并广播。
 */
export async function playCapsuleInternal(db: Db, trigger: string): Promise<void> {
  const candidates = db
    .select()
    .from(timeCapsules)
    .where(eq(timeCapsules.trigger, trigger as 'deep_night' | 'after_break' | 'dissociation' | 'wakeup'))
    .all()

  if (candidates.length === 0) return

  const capsule = candidates[Math.floor(Math.random() * candidates.length)]
  db.update(timeCapsules)
    .set({ last_played_at: Math.floor(Date.now() / 1000) })
    .where(eq(timeCapsules.id, capsule.id))
    .run()

  const { broadcast } = await import('../ws/server')
  broadcast({ type: 'capsule:play', content: capsule.content, trigger })
}
