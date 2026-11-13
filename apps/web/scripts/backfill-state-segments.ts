/**
 * 历史状态分段一次性回填（scripts 薄壳；核心逻辑在 lib/timeline/replay.ts）。
 * 范围 = [最早行为日志, 最早 realtime 段起点)，无 realtime 段则到当前时刻。
 * 幂等：空档内旧 backfill 段先删后重建。
 *
 * 运行：cd apps/web; pnpm backfill:segments
 */
import { eq, min } from 'drizzle-orm'
import { behaviorLogs, stateSegments } from '@anchor/db'
import { getDb } from '../lib/db'
import { replayStateSegments } from '../lib/timeline/replay'

function main(): void {
  const db = getDb()
  const nowS = Math.floor(Date.now() / 1000)

  const rt = db
    .select({ v: min(stateSegments.started_at) })
    .from(stateSegments)
    .where(eq(stateSegments.source, 'realtime'))
    .get()
  const upperS = rt?.v ?? nowS

  const lo = db.select({ v: min(behaviorLogs.logged_at) }).from(behaviorLogs).get()?.v
  if (!lo || lo >= upperS) {
    console.log('[backfill] 无需要回填的历史数据')
    return
  }

  const r = replayStateSegments(db, lo, upperS)
  console.log(`[backfill] 完成：扫描 ${r.hours} 小时，写入 ${r.written} 段（上界 ${new Date(upperS * 1000).toISOString()}）`)
}

main()
