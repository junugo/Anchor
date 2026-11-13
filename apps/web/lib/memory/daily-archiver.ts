import type { Db } from '@anchor/db'
import type { DailyContext } from '@anchor/types'
import { circadianLogs } from '@anchor/db'

/** 找出数组中最大值所在的索引；若全为 0 则返回 null */
function argmaxOrNull(arr: number[]): number | null {
  let best = -1
  let bestIdx = -1
  for (let i = 0; i < arr.length; i++) {
    if (arr[i] > best) {
      best = arr[i]
      bestIdx = i
    }
  }
  return best > 0 ? bestIdx : null
}

/** 从 24 槽直方图推算工作/分心峰值小时 */
export function derivePeakHours(
  workByHour: number[],
  distractionByHour: number[],
): { peakWork: number | null; peakDistraction: number | null } {
  return {
    peakWork: argmaxOrNull(workByHour),
    peakDistraction: argmaxOrNull(distractionByHour),
  }
}

/** 把 DailyContext 落盘到 circadian_logs（按 date 唯一约束做 upsert） */
export function archiveDailyContext(db: Db, c: DailyContext): void {
  const dismissRate =
    c.interventions_triggered > 0
      ? c.interventions_dismissed / c.interventions_triggered
      : 0
  const { peakWork, peakDistraction } = derivePeakHours(c.work_by_hour, c.distraction_by_hour)

  // 抽出公共字段对象，避免 values() 与 onConflictDoUpdate.set 各写一遍
  const fields = {
    deep_work_total_ms: c.deep_work_total_ms,
    dissociation_count: c.dissociation_count,
    dissociation_total_ms: c.dissociation_total_ms,
    intervention_count: c.interventions_triggered,
    intervention_dismiss_rate: dismissRate,
    android_unlock_count: c.android_unlock_count,
    peak_work_hour: peakWork,
    peak_distraction_hour: peakDistraction,
  }

  db.insert(circadianLogs)
    .values({ date: c.date, ...fields })
    .onConflictDoUpdate({
      // circadianLogs.date 有 .unique() 约束，可作为 onConflict target
      target: circadianLogs.date,
      set: fields,
    })
    .run()
}
