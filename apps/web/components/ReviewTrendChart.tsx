'use client'

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts'

interface TrendRow {
  date: string
  deepWorkHours: number
  dissociationCount: number
  interventionDismissRate: number
  sleepDebtHours: number
}

export function ReviewTrendChart({ data }: { data: TrendRow[] }) {
  return (
    <div className="review-chart">
      <ResponsiveContainer width="100%" height={240}>
        <LineChart data={data} margin={{ left: 0, right: 60 }}>
          <XAxis dataKey="date" tick={{ fontSize: 11 }} />
          <YAxis yAxisId="deepWork" orientation="left" tick={{ fontSize: 11 }} />
          <YAxis yAxisId="dissociation" orientation="right" tick={{ fontSize: 9 }} />
          <YAxis yAxisId="dismissRate" orientation="right" offset={40} tick={{ fontSize: 9 }} />
          <YAxis yAxisId="sleepDebt" orientation="right" offset={80} tick={{ fontSize: 9 }} />
          <Tooltip />
          <Legend wrapperStyle={{ fontSize: 11 }} />
          <Line
            yAxisId="deepWork"
            type="monotone"
            dataKey="deepWorkHours"
            name="深度工作(h)"
            stroke="#22863a"
            strokeWidth={2}
            dot={false}
          />
          <Line
            yAxisId="dissociation"
            type="monotone"
            dataKey="dissociationCount"
            name="解离次数"
            stroke="#cf222e"
            strokeWidth={2}
            dot={false}
          />
          <Line
            yAxisId="dismissRate"
            type="monotone"
            dataKey="interventionDismissRate"
            name="干预忽略率"
            stroke="#c0622a"
            strokeWidth={2}
            dot={false}
          />
          <Line
            yAxisId="sleepDebt"
            type="monotone"
            dataKey="sleepDebtHours"
            name="睡眠偏差(h)"
            stroke="#b08800"
            strokeWidth={2}
            dot={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}
