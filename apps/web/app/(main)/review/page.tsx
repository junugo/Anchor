import { ReviewTrendChart } from '@/components/ReviewTrendChart'
import { PeakHoursGrid } from '@/components/PeakHoursGrid'
import type { ReviewData } from '@anchor/db'

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000'

async function fetchReviewData(): Promise<ReviewData> {
  const res = await fetch(`${API_URL}/api/review`, { cache: 'no-store' })
  if (!res.ok) throw new Error('Failed to fetch review data')
  return res.json() as Promise<ReviewData>
}

function formatHour(h: number | null): string {
  if (h == null) return '—'
  return `${String(h).padStart(2, '0')}:00–${String((h + 1) % 24).padStart(2, '0')}:00`
}

function fmtUnix(unix: number): string {
  return new Date(unix * 1000).toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export default async function ReviewPage() {
  const data = await fetchReviewData()

  return (
    <main className="review-page">
      <header className="review-header">
        <h1>本周复盘</h1>
        <span className="review-range">
          {data.weekRange.start} – {data.weekRange.end}
        </span>
      </header>

      <section className="review-section">
        <h2>AI 洞察</h2>
        <p className="insight-text">{data.weeklyInsight?.text ?? '暂无本周洞察，将在下次分析时自动生成。'}</p>
      </section>

      <section className="review-section">
        <h2>记忆模式</h2>
        <div className="memory-grid">
          {[
            { label: '睡眠模式', value: data.userMemory?.sleepPattern },
            { label: '解离模式', value: data.userMemory?.dissociationPattern },
            { label: '情绪走势', value: data.userMemory?.moodTrend },
            { label: '干预反应', value: data.userMemory?.responseToIntervention },
          ].map(item => item.value ? (
            <div key={item.label} className="memory-card">
              <div className="memory-label">{item.label}</div>
              <div className="memory-value">{item.value}</div>
            </div>
          ) : null)}
        </div>
      </section>

      <section className="review-section">
        <h2>节律趋势</h2>
        {data.trends.length === 0 ? (
          <p className="empty">本周暂无节律数据</p>
        ) : (
          <ReviewTrendChart data={data.trends} />
        )}
      </section>

      <section className="review-section">
        <h2>峰值时段</h2>
        <div className="peak-list">
          <div className="peak-item">
            <span className="peak-dot work" />
            <span>深度工作峰值：{formatHour(data.peakHours.workPeak)}</span>
          </div>
          <div className="peak-item">
            <span className="peak-dot distraction" />
            <span>分心峰值：{formatHour(data.peakHours.distractionPeak)}</span>
          </div>
        </div>
        <PeakHoursGrid workPeak={data.peakHours.workPeak} distractionPeak={data.peakHours.distractionPeak} />
      </section>

      <section className="review-section">
        <h2>解离日记回顾</h2>
        {data.dissociationHistory.length === 0 ? (
          <p className="empty">本周没有已确认的解离记录</p>
        ) : (
          <ul className="diary-list">
            {data.dissociationHistory.map((item) => (
              <li key={item.id} className="diary-item">
                <time>{fmtUnix(item.startTime)}</time>
                <span>{Math.round(item.durationMs / 1000 / 60)} 分钟 · {item.userChoice}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="review-section">
        <h2>AI 对话摘要</h2>
        {data.conversationSummaries.length === 0 ? (
          <p className="empty">暂无对话摘要</p>
        ) : (
          <ul className="summary-list">
            {data.conversationSummaries.map((item) => (
              <li key={item.id} className="summary-item">
                <time>{item.dateRangeStart}</time>
                <p>{item.summary}</p>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  )
}
