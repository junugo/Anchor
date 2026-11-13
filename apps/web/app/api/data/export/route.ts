import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import {
  behaviorLogs,
  circadianLogs,
  timeCapsules,
  aiConversationSummaries,
  sunsetConfig,
} from '@anchor/db'
import { getUserDateStr } from '@/lib/time/user-time'

export function GET() {
  const db = getDb()
  const payload = {
    exported_at: new Date().toISOString(),
    circadian_logs: db.select().from(circadianLogs).all(),
    behavior_logs: db.select().from(behaviorLogs).all(),
    time_capsules: db.select().from(timeCapsules).all(),
    ai_summaries: db.select().from(aiConversationSummaries).all(),
    sunset_config: db.select().from(sunsetConfig).all(),
  }
  return new NextResponse(JSON.stringify(payload, null, 2), {
    headers: {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="anchor-export-${getUserDateStr(Date.now())}.json"`,
    },
  })
}
