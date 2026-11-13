import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { behaviorLogs, circadianLogs } from '@anchor/db'
import { desc, gte, and } from 'drizzle-orm'
import { getUserDateStr, userZonedTimeToUtc } from '@/lib/time/user-time'

/**
 * GET /api/friction/usage-context
 *
 * 返回高刺激路径加摩擦所需的上下文数据：
 * - today_entertainment_ms: 今日娱乐时长（毫秒，来自 behavior_logs url_visit 和 app_foreground）
 * - consecutive_high_entertainment_days: 连续高娱乐时长天数（>2h/天视为高娱乐）
 *
 * Chrome Extension 和 Android 在触发娱乐 app 启动摩擦时调用此接口，
 * 将数据注入摩擦 UI（"今日已用 Xh Xm" / "连续 X 天高娱乐时长"）。
 */
export function GET() {
  const db = getDb()
  const nowS = Math.floor(Date.now() / 1000)

  // ── 计算今日娱乐时长 ──────────────────────────────────────────
  // 取今日 0 时（用户时区本地）到现在的 url_visit 和 app_foreground 中高刺激事件
  const today = getUserDateStr(Date.now())
  const todayStartS = userZonedTimeToUtc(today, 0)

  const todayLogs = db
    .select()
    .from(behaviorLogs)
    .where(
      and(
        gte(behaviorLogs.logged_at, todayStartS),
      )
    )
    .orderBy(desc(behaviorLogs.logged_at))
    .all()

  // 高刺激 URL 访问时长（url_visit 事件中 high_stimulus=true 且有 duration_ms）
  const urlEntertainmentMs = todayLogs
    .filter(l => l.event_type === 'url_visit' && l.payload['high_stimulus'] === true)
    .reduce((sum, l) => sum + Number(l.payload['duration_ms'] ?? 0), 0)

  // 高刺激 App 前台时长（app_foreground 事件中有 duration_ms，或从 app_foreground/app_background 对计算）
  const appEntertainmentMs = todayLogs
    .filter(l => l.event_type === 'app_foreground')
    .reduce((sum, l) => {
      // 如果客户端上报了 duration_ms 直接用
      const dm = Number(l.payload['duration_ms'] ?? 0)
      return sum + dm
    }, 0)

  const today_entertainment_ms = urlEntertainmentMs + appEntertainmentMs

  // ── 计算连续高娱乐天数（来自 circadian_logs.dissociation_total_ms）──
  const cutoffDate = getUserDateStr(Date.now() - 6 * 24 * 60 * 60 * 1000)

  const recentCircadian = db
    .select()
    .from(circadianLogs)
    .where(gte(circadianLogs.date, cutoffDate))
    .orderBy(desc(circadianLogs.date))
    .all()

  // 连续高娱乐：从最近一天往前数，每天 dissociation_total_ms > 2h 即计入
  const HIGH_ENTERTAINMENT_THRESHOLD_MS = 2 * 60 * 60 * 1000
  let consecutive_high_entertainment_days = 0
  for (const row of recentCircadian) {
    if ((row.dissociation_total_ms ?? 0) > HIGH_ENTERTAINMENT_THRESHOLD_MS) {
      consecutive_high_entertainment_days++
    } else {
      break
    }
  }

  return NextResponse.json({
    today_entertainment_ms,
    consecutive_high_entertainment_days,
    // 格式化字符串，便于客户端直接展示
    today_entertainment_formatted: formatDuration(today_entertainment_ms),
    timestamp: nowS,
  })
}

function formatDuration(ms: number): string {
  const totalMin = Math.floor(ms / 60000)
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  if (h > 0) return `${h}h ${m}m`
  return `${m}m`
}
