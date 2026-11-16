import type { Db } from '@anchor/db'
import { chatCompletion, resolveAiConfig } from './provider'

interface WeeklyMetrics {
  avgDeepWorkMin: number
  totalDissociation: number
  peakDistractionHour: number | null
  dismissRate: number
}

export function buildInsightsPrompt(m: WeeklyMetrics): string {
  return [
    '你是温暖的数字室友。基于用户过去一周的数据，给出一段自然语言洞察（≤120字，中文，不评判）。',
    `日均深度工作：${m.avgDeepWorkMin} 分钟`,
    `本周解离次数：${m.totalDissociation}`,
    `高峰分心时段：${m.peakDistractionHour ?? '无明显'} 点`,
    `干预忽略率：${Math.round(m.dismissRate * 100)}%`,
    '请输出一段总结与一条温和建议。',
  ].join('\n')
}

// 生成 weekly_insights 并写入 user_settings；10s 超时，失败静默跳过
export async function generateWeeklyInsights(db: Db, m: WeeklyMetrics, updatedAt: number): Promise<void> {
  try {
    const cfg = resolveAiConfig()
    if (!cfg) return
    const resp = await chatCompletion(cfg, {
      messages: [{ role: 'user', content: buildInsightsPrompt(m) }],
      max_tokens: 300,
      temperature: 0.8,
      signal: AbortSignal.timeout(10_000),
    })
    const data = await resp.json() as { choices?: Array<{ message?: { content?: string } }> }
    const text = (data.choices?.[0]?.message?.content ?? '').trim()
    if (!text) return
    const { userSettings } = await import('@anchor/db')
    db.insert(userSettings)
      .values({ key: 'weekly_insights', value: JSON.stringify({ text, generated_at: updatedAt }), updated_at: updatedAt })
      .onConflictDoUpdate({ target: userSettings.key, set: { value: JSON.stringify({ text, generated_at: updatedAt }), updated_at: updatedAt } })
      .run()
    // 同时写入生成时间戳，便于 /api/review 判断是否需要刷新
    db.insert(userSettings)
      .values({ key: 'weekly_insights_generated_at', value: String(updatedAt), updated_at: updatedAt })
      .onConflictDoUpdate({ target: userSettings.key, set: { value: String(updatedAt), updated_at: updatedAt } })
      .run()
  } catch { /* 静默 */ }
}
