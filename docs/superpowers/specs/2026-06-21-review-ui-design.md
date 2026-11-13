# 结构化复盘 UI — 设计规格

> 状态：待实现 | 日期：2026-06-21 | 范围：`apps/web`

---

## 1. 背景与目标

服务端已积累了充分的数据：`circadian_logs`（7天行为聚合）、`weekly_insights`（AI 洞察）、`ai_conversation_summaries`（对话摘要）、`user_memory`（模式识别 KV）。但完全没有 UI 将这些数据呈现给用户。

目标：在 `/review` 新增独立复盘页面，让用户能在一个页面看到本周节律全貌、AI 洞察、和改进建议。

---

## 2. 页面结构：`/review`

### 2.1 路由与导航

- 新建 `apps/web/app/review/page.tsx`
- 左侧图标栏新增"复盘"图标入口（Lucide `BarChart2`），位于现有导航项之后

### 2.2 页面 Layout（从上到下）

```
┌──────────────────────────────────────────────┐
│  本周复盘                    2026/06/15–06/21 │
├──────────────────────────────────────────────┤
│  AI 洞察                                      │  ← weekly_insights（120字，DeepSeek 生成）
│  "本周深度工作时长比上周提升 22%..."           │
├──────────────────────────────────────────────┤
│  节律趋势（7天折线图）                         │
│  深度工作  解离次数  干预忽略率  睡眠偏差       │  ← 4条折线，circadian_logs
├──────────────────────────────────────────────┤
│  今日峰值时段                                  │
│  深度工作峰值：10:00–11:00                    │  ← peak_work_hour / peak_distraction_hour
│  分心峰值：21:00–22:00                        │
├──────────────────────────────────────────────┤
│  解离日记回顾                                  │
│  本周 3 次解离 · 已确认 2 次                   │  ← dissociation_diary 历史
├──────────────────────────────────────────────┤
│  AI 对话摘要                                  │
│  [2026/06/18] "你提到想改善早起..."            │  ← ai_conversation_summaries 最近5条
└──────────────────────────────────────────────┘
```

---

## 3. 数据 API 补全

### 3.1 `GET /api/review` — 新增端点

聚合所有复盘所需数据，单次请求返回：

```ts
// apps/web/app/api/review/route.ts

type ReviewResponse = {
  weekRange: { start: string; end: string }
  weeklyInsight: string | null          // userSettings.weekly_insights
  trends: CircadianTrendRow[]           // 最近7天 circadian_logs（含全部列）
  peakHours: {
    workPeak: number | null             // 最近一天 peak_work_hour
    distractionPeak: number | null      // 最近一天 peak_distraction_hour
  }
  dissociationHistory: {                // 最近7天已确认的 dissociation_diary
    id: number
    startTime: string
    durationMs: number
    userChoice: string
  }[]
  conversationSummaries: {              // 最近5条 ai_conversation_summaries
    id: number
    dateRangeStart: string
    summary: string
  }[]
  userMemory: {                         // user_memory 的4个 KV
    sleepPattern: string | null
    dissociationPattern: string | null
    moodTrend: string | null
    responseToIntervention: string | null
  }
}
```

### 3.2 数据查询实现

```ts
// 在 db 层新增查询函数（packages/db/src/queries/review.ts）
export function getReviewData(db: Db): ReviewResponse { ... }
```

复用现有 `circadian_logs`、`dissociation_diary`、`ai_conversation_summaries`、`userSettings` 表，无需新增 schema。

---

## 4. 图表组件

使用项目已有技术栈（Next.js + React），图表用 **Recharts**（轻量，纯 React，无 canvas 依赖）。

### 4.1 节律趋势折线图

4 条指标，共享 x 轴（日期），各有独立 y 轴刻度：

| 指标 | 字段 | 颜色 |
|------|------|------|
| 深度工作时长 | `deep_work_total_ms`（转小时）| `#22863a`（绿）|
| 解离次数 | `dissociation_count` | `#cf222e`（红）|
| 干预忽略率 | `intervention_dismiss_rate` | `#c0622a`（橙）|
| 睡眠偏差（h）| `sleep_debt_hours` | `#b08800`（黄）|

```tsx
<LineChart data={trends} width={600} height={200}>
  <XAxis dataKey="date" />
  <Tooltip />
  <Legend />
  <Line dataKey="deepWorkHours" stroke="#22863a" dot={false} />
  <Line dataKey="dissociationCount" stroke="#cf222e" dot={false} />
  <Line dataKey="interventionDismissRate" stroke="#c0622a" dot={false} />
  <Line dataKey="sleepDebtHours" stroke="#b08800" dot={false} />
</LineChart>
```

### 4.2 峰值时段可视化

简单的 24 格时段条（每格 1 小时），高亮深度工作峰值（绿）和分心峰值（橙），用纯 CSS `grid` 实现，无额外依赖。

### 4.3 解离历史列表

时间线形式（`<ul>` + CSS border-left），每条显示：时段、持续时长、用户标签（如"注意力碎裂"）。

---

## 5. weekly_insights 触发时机

当前 `weekly-insights.ts` 只在周日触发。补充：用户访问 `/review` 时，如果当前 `weekly_insights` 的生成日期超过 7 天，触发一次异步刷新（fire-and-forget，不阻塞页面加载）。

```ts
// /api/review/route.ts 内
const lastGenerated = await getSettingValue(db, 'weekly_insights_generated_at')
const stale = !lastGenerated || daysSince(lastGenerated) > 7
if (stale) {
  // 异步刷新，不 await
  generateWeeklyInsights(db).catch(console.error)
}
```

---

## 6. 文件变更范围

```
apps/web/
├── app/
│   ├── review/
│   │   └── page.tsx            — 新增：复盘页面（服务端组件 + 客户端图表）
│   └── api/
│       └── review/
│           └── route.ts        — 新增：GET /api/review 聚合端点
├── components/
│   ├── ReviewTrendChart.tsx    — 新增：Recharts 折线图（客户端组件）
│   ├── PeakHoursGrid.tsx       — 新增：24格峰值时段（纯 CSS）
│   └── nav.tsx (或同等)         — 修改：添加复盘导航入口
└── package.json                — 添加 recharts 依赖

packages/db/src/
└── queries/
    └── review.ts               — 新增：getReviewData 查询函数
```

---

## 7. 不在本次范围

- 周报导出（PDF/截图）
- 复盘内容的 AI 对话（用户可在现有 AI 聊天界面发起）
- 多周横向对比

---

## 8. 成功验收标准

- [ ] 访问 `/review` 页面不报错，数据正确加载
- [ ] 折线图展示最近 7 天 4 项指标趋势
- [ ] AI 洞察文字（weekly_insights）正确渲染
- [ ] 峰值时段 24 格高亮正确
- [ ] 解离历史列表展示本周已确认记录
- [ ] AI 对话摘要最近 5 条正确展示
- [ ] weekly_insights 超过 7 天自动触发后台刷新
