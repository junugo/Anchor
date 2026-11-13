'use client'

const HOURS = Array.from({ length: 24 }, (_, i) => i)

function formatHour(h: number): string {
  return `${String(h).padStart(2, '0')}:00`
}

export function PeakHoursGrid({
  workPeak,
  distractionPeak,
}: {
  workPeak: number | null
  distractionPeak: number | null
}) {
  return (
    <div className="peak-grid">
      <div className="peak-row">
        {HOURS.map((h) => {
          const isWork = workPeak != null && h === workPeak
          const isDistraction = distractionPeak != null && h === distractionPeak
          const cls = ['peak-cell', isWork && 'work', isDistraction && 'distraction']
            .filter(Boolean)
            .join(' ')
          return (
            <div
              key={h}
              className={cls}
              title={formatHour(h)}
            />
          )
        })}
      </div>
      <div className="peak-labels">
        <span>00:00</span>
        <span>12:00</span>
        <span>23:00</span>
      </div>
    </div>
  )
}
