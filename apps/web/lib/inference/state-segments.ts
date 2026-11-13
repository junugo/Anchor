import type { Db } from '@anchor/db'
import { stateSegments } from '@anchor/db'
import { desc, eq, isNull } from 'drizzle-orm'
import type { UserState } from '@anchor/types'

/**
 * 僵尸判定阈值：open 段心跳凝固超此时长 = 管线暂停/进程死亡。
 * 10min ≈ 两个完整 tick 周期（lightweight tick 每 1min 刷新一次心跳，错过 ~10 次才判死，足够宽容）
 */
export const STALE_SEGMENT_S = 10 * 60

/**
 * 状态分段记录：状态变化时闭合当前 open 段并开新段；同状态 no-op（段延伸 + 心跳刷新）。
 *
 * 僵尸段惰性闭合（启动时与运行时统一一套机制）：
 * 每次调用刷新当前 open 段的 last_seen_at 心跳；调用时发现心跳凝固超阈值，
 * 说明管线曾暂停（崩溃/离线/运行时挂起），open 段的「延伸到 now」不可信——
 * 闭合到最后心跳时刻，新段从 now 起，中间空档显示为「无数据」，
 * 空档暴露后客户端补发数据时 replay 可回填。心跳列持久在 DB，
 * 进程重启后第一个 tick 自然完成同样判断，无需 server.ts 专门钩子。
 *
 * 遗留段（last_seen_at NULL，列上线前写入）：首次见到只升级填充为 now，
 * 不当场判死——否则部署时正在进行的正常段会被误斩丢数据；历史僵尸由一次性脚本收编。
 */
export function recordStateSegment(db: Db, state: UserState, nowS: number): void {
  const openRows = db
    .select()
    .from(stateSegments)
    .where(isNull(stateSegments.ended_at))
    .orderBy(desc(stateSegments.started_at))
    .all()

  const current = openRows[0]

  // 遗留段升级（见头注释）
  let lastSeenAt = current?.last_seen_at ?? null
  if (current && lastSeenAt == null) {
    db.update(stateSegments).set({ last_seen_at: nowS }).where(eq(stateSegments.id, current.id)).run()
    lastSeenAt = nowS
  }

  const stale = current != null && lastSeenAt != null && nowS - lastSeenAt > STALE_SEGMENT_S

  if (current && current.state === state && !stale) {
    // 同状态且管线存活：段延伸 + 心跳刷新
    db.update(stateSegments).set({ last_seen_at: nowS }).where(eq(stateSegments.id, current.id)).run()
    closeExtras(db, openRows.slice(1))
    return
  }

  // 状态切换，或僵尸收编：多余悬空段闭合为自身起点（零长，查询自动忽略）；
  // 当前段闭合到最后心跳时刻（僵尸）或 nowS（正常切换），新段从 nowS 起
  closeExtras(db, openRows.slice(1))
  if (current) {
    const closeAt = stale && lastSeenAt != null ? lastSeenAt : nowS
    db.update(stateSegments).set({ ended_at: closeAt }).where(eq(stateSegments.id, current.id)).run()
  }
  db.insert(stateSegments).values({ state, started_at: nowS, ended_at: null, source: 'realtime', last_seen_at: nowS }).run()
}

/** 多余悬空段（崩溃遗留，正常不会出现）闭合为自身起点：零长段被查询层 e<=s 跳过，等效隐藏 */
function closeExtras(db: Db, extras: Array<{ id: number; started_at: number }>): void {
  for (const extra of extras) {
    db.update(stateSegments).set({ ended_at: extra.started_at }).where(eq(stateSegments.id, extra.id)).run()
  }
}
