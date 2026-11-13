import { and, desc, eq, isNull } from 'drizzle-orm'
import { behaviorLogs, stateSegments } from '@anchor/db'
import type { Db } from '@anchor/db'
import { STALE_SEGMENT_S } from './state-segments'

/** 闭合宽限：段至少存活了一个完整 tick */
const CLOSE_GRACE_S = 5 * 60
/** 行为日志距 now 小于此值视为服务器在运行 */
const SERVER_ALIVE_S = 5 * 60

function fmt(t: number): string {
  return new Date(t * 1000).toLocaleString('sv-SE')
}

export interface CloseStaleSegmentsOptions {
  /** 实际写库；false 则只打印（dry-run） */
  apply?: boolean
  /** 强制指定 now，用于测试 */
  nowS?: number
}

export interface CloseStaleSegmentsResult {
  /** 已识别为僵尸并被闭合（或待闭合）的段数 */
  closed: number
  /** 跳过的活跃/近期段数 */
  skipped: number
  /** 日志信息 */
  logs: string[]
}

/**
 * 历史僵尸 open 段一次性收编。
 *
 * - 最新 open 段距 now 超 10min（阈值同 STALE_SEGMENT_S）→ 闭合到 started_at + 5min
 * - 更老的多余悬空段 → 闭合到自身 started_at（零长，查询自动忽略）
 * - 服务器似乎在运行且只有一条 open 段 → 视为活跃段，跳过
 */
export function closeStaleSegments(
  db: Db,
  opts: CloseStaleSegmentsOptions = {}
): CloseStaleSegmentsResult {
  const apply = opts.apply ?? false
  const nowS = opts.nowS ?? Math.floor(Date.now() / 1000)
  const logs: string[] = []

  const rows = db
    .select()
    .from(stateSegments)
    .where(isNull(stateSegments.ended_at))
    .orderBy(desc(stateSegments.started_at))
    .all()
  if (rows.length === 0) {
    logs.push('[close-stale] 无 open 段')
    return { closed: 0, skipped: 0, logs }
  }

  const maxLog = db
    .select({ v: behaviorLogs.logged_at })
    .from(behaviorLogs)
    .orderBy(desc(behaviorLogs.logged_at))
    .limit(1)
    .get()?.v
  const serverAlive = maxLog != null && nowS - maxLog <= SERVER_ALIVE_S

  let closed = 0
  let skipped = 0
  rows.forEach((r, i) => {
    const isLatest = i === 0
    const ageS = nowS - r.started_at
    if (isLatest && serverAlive && rows.length === 1) {
      logs.push(`[close-stale] 跳过活跃段 #${r.id} ${r.state} ${fmt(r.started_at)}（服务器运行中，段由管线维护）`)
      skipped++
      return
    }
    if (isLatest && ageS <= STALE_SEGMENT_S) {
      logs.push(`[close-stale] 跳过近期段 #${r.id} ${r.state} ${fmt(r.started_at)}（${Math.round(ageS / 60)}min 前开始，未超阈值）`)
      skipped++
      return
    }
    // 多余悬空段零长收编；最新僵尸段留一个 tick 宽限
    const closeAt = isLatest ? r.started_at + CLOSE_GRACE_S : r.started_at
    const stretchH = ((ageS - (closeAt - r.started_at)) / 3600).toFixed(1)
    logs.push(`[close-stale] ${apply ? '闭合' : '将闭合'} #${r.id} ${r.state} ${fmt(r.started_at)} → ${fmt(closeAt)}（砍掉僵尸延伸 ${stretchH}h）`)
    if (apply) {
      db.update(stateSegments).set({ ended_at: closeAt }).where(and(eq(stateSegments.id, r.id), isNull(stateSegments.ended_at))).run()
    }
    closed++
  })

  if (closed === 0) logs.push('[close-stale] 无需收编')
  else logs.push(apply ? `[close-stale] 完成，共闭合 ${closed} 段` : `[close-stale] dry-run，共 ${closed} 段待闭合；实际写库用 apply=true`)

  return { closed, skipped, logs }
}
