import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { getReviewData, userSettings } from '@anchor/db'
import { eq } from 'drizzle-orm'

function daysSince(timestampSeconds: number): number {
  const now = Math.floor(Date.now() / 1000)
  return (now - timestampSeconds) / 86400
}

export async function GET() {
  const db = getDb()
  const data = getReviewData(db)

  // 检查 weekly_insights_generated_at，超过 7 天则异步刷新
  const generatedAtRow = db
    .select()
    .from(userSettings)
    .where(eq(userSettings.key, 'weekly_insights_generated_at'))
    .get()

  const generatedAt = generatedAtRow ? Number(generatedAtRow.value) : null

  if (!generatedAt || daysSince(generatedAt) > 7) {
    import('@/lib/ai/weekly-insights')
      .then(({ generateWeeklyInsights }) => {
        // 从现有 data 构建 metrics
        const trends = data.trends
        const avgDeepWorkMin =
          trends.length > 0
            ? trends.reduce((s, r) => s + r.deepWorkHours * 60, 0) / trends.length
            : 0
        const totalDissociation = trends.reduce((s, r) => s + r.dissociationCount, 0)
        const peakDistractionHour = data.peakHours.distractionPeak
        const dismissRate =
          trends.length > 0
            ? trends.reduce((s, r) => s + r.interventionDismissRate, 0) / trends.length
            : 0
        return generateWeeklyInsights(db, { avgDeepWorkMin, totalDissociation, peakDistractionHour, dismissRate }, Math.floor(Date.now() / 1000))
      })
      .catch((err: unknown) => {
        console.error('[review] weekly insights refresh failed', err)
      })
  }

  return NextResponse.json(data)
}
