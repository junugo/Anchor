// 自定义服务器不自动加载 .env，Next.js 仅在 API 路由中加载；这里显式加载确保 WS/DB 与 API 使用同一配置
import { loadEnvFile } from 'node:process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
try {
  loadEnvFile(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '.env'))
} catch { /* .env 不存在时忽略，使用默认路径 */ }

import { createServer } from 'http'
import { parse } from 'url'
import os from 'node:os'
import next from 'next'
import { initWsServer } from './lib/ws/server'
import { guardRequest } from './lib/auth/guard'
import { initDb } from './lib/db'
import { initSunsetConfig } from './lib/sunset/config'
import { getUserDateStr, getUserLocalParts, getUserSleepDateStr, getUserTimeZone, getUserWeekday, userZonedTimeToUtc } from './lib/time/user-time'
import type { Db } from '@anchor/db'

const dev = process.env.NODE_ENV !== 'production'

// -- 每日 AI 维护：生成对话摘要 + 更新用户记忆 ---------------------------------
async function runDailyAiMaintenance(db: Db, todayStr: string): Promise<void> {
  const { generateConversationSummary, getYesterdayRange } = await import('./lib/ai/summary')
  generateConversationSummary(db, getYesterdayRange()).catch(console.error)
  const { updateUserMemory } = await import('./lib/ai/memory')
  updateUserMemory(db, { force: true }).catch(console.error)
}

// -- 跨日归档：归档昨日 DailyContext 并重置单例 --------------------------------
async function runDailyArchive(
  db: Db,
  prevDate: string,
): Promise<void> {
  const dc = await import('./lib/memory/daily-context')
  const ctx = dc.getDailyContext(prevDate)
  const { archiveDailyContext } = await import('./lib/memory/daily-archiver')
  try {
    archiveDailyContext(db, ctx)
  } finally {
    dc.resetDailyContext()
  }
}

// -- 日记分类：批量处理未确认 dissociation_diary 条目 ---------------------------
async function runDiaryClassification(db: Db): Promise<void> {
  const dc = await import('./lib/ai/diary-classifier')
  const { dissociationDiary, behaviorLogs } = await import('@anchor/db')
  const { isNull, eq, and, gte, lte } = await import('drizzle-orm')

  const MAX_DIARY_ENTRIES_PER_DAY = 10
  const MAX_LOGS_PER_ENTRY = 20

  const entries = db.select().from(dissociationDiary)
    .where(isNull(dissociationDiary.user_choice))
    .limit(MAX_DIARY_ENTRIES_PER_DAY)
    .all()

  const nowS = Math.floor(Date.now() / 1000)

  // 限并发 3：避免同时发起过多 AI API 调用
  const CONCURRENCY = 3
  type DiaryLabel = Awaited<ReturnType<typeof dc.classifyDiaryEntry>>
  const results: Array<{ entryId: number; label: DiaryLabel }> = []

  for (let i = 0; i < entries.length; i += CONCURRENCY) {
    const batch = entries.slice(i, i + CONCURRENCY)
    const batchResults = await Promise.all(
      batch.map(async (entry) => {
        const logs = db.select().from(behaviorLogs)
          .where(and(
            gte(behaviorLogs.logged_at, entry.period_start),
            lte(behaviorLogs.logged_at, entry.period_end),
          ))
          .limit(MAX_LOGS_PER_ENTRY)
          .all()
        const mappedLogs = logs.map(l => ({
          event_type: l.event_type,
          domain: (l.payload as Record<string, unknown>)['domain'] as string | undefined,
          at: new Date(l.logged_at * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }),
        }))
        const periodStartAt = new Date(entry.period_start * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
        const events = dc.buildEventsOrFallback(mappedLogs, entry.candidate_label, periodStartAt)
        const label = await dc.classifyDiaryEntry(events)
        return { entryId: entry.id, label }
      }),
    )
    results.push(...batchResults)
  }

  for (const { entryId, label } of results) {
    // AI 分类失败返回 null：跳过写入，条目保持待确认，由用户在 /diary 页手动标记
    if (label === null) continue
    db.update(dissociationDiary)
      .set({ user_choice: label, confirmed_at: nowS })
      .where(eq(dissociationDiary.id, entryId))
      .run()
  }
}

// -- 每周分析：周日分析过去 7 天 circadian_logs --------------------------------
async function runWeeklyAnalysis(db: Db): Promise<void> {
  const wa = await import('./lib/memory/weekly-analyzer')
  const { circadianLogs } = await import('@anchor/db')
  const { gte } = await import('drizzle-orm')

  const cutoffStr = getUserDateStr(Date.now() - 7 * 24 * 60 * 60 * 1000)
  const rows = db
    .select()
    .from(circadianLogs)
    .where(gte(circadianLogs.date, cutoffStr))
    .all()

  const nowS = Math.floor(Date.now() / 1000)
  const mem = wa.analyzeWeek(rows)
  wa.persistMemory(db, mem, nowS)

  // AI 每周洞察
  const days = rows.length || 1
  const hourCounts = new Map<number, number>()
  for (const r of rows) {
    if (r.peak_distraction_hour !== null) {
      hourCounts.set(r.peak_distraction_hour, (hourCounts.get(r.peak_distraction_hour) ?? 0) + 1)
    }
  }
  let peakDistractionHour: number | null = null
  let maxCount = 0
  for (const [hour, count] of hourCounts) {
    if (count > maxCount) { maxCount = count; peakDistractionHour = hour }
  }
  const m = {
    avgDeepWorkMin: Math.round(rows.reduce((a, r) => a + (r.deep_work_total_ms ?? 0), 0) / days / 60000),
    totalDissociation: rows.reduce((a, r) => a + (r.dissociation_count ?? 0), 0),
    peakDistractionHour,
    dismissRate: rows.reduce((a, r) => a + (r.intervention_dismiss_rate ?? 0), 0) / days,
  }
  const { generateWeeklyInsights } = await import('./lib/ai/weekly-insights')
  generateWeeklyInsights(db, m, nowS).catch(console.error)
}

// -- 完整 tick -- 5 分钟：pipeline 为唯一推断路径 -----------------------------
async function runFullTick(
  db: Db,
  todayStr: string,
  lastDailyAiMaintenanceDate: { current: string | null },
  lastArchivedDate: { current: string | null },
): Promise<void> {
  // 唯一推断路径：pipeline 负责状态推断 + 干预分发 + 决策触发
  import('./lib/inference/pipeline')
    .then(m => m.runPipelineGuarded(db, { mode: 'full', nowMs: Date.now() }))
    .catch(console.error)

  // 每日 AI 维护（首次进入新日期时触发）
  if (lastDailyAiMaintenanceDate.current !== todayStr) {
    lastDailyAiMaintenanceDate.current = todayStr
    runDailyAiMaintenance(db, todayStr).catch(console.error)
  }

  // 跨日归档与日记分类
  if (lastArchivedDate.current !== null && lastArchivedDate.current !== todayStr) {
    const prevDate = lastArchivedDate.current
    runDailyArchive(db, prevDate).catch(console.error)
    runDiaryClassification(db).catch(console.error)

    // 睡眠识别对账（专利启发识别 vs 状态机记录）：处理「上一个已完整结束的睡眠日」
    // （当前睡眠日的窗口要到今日中午才结束，当天不处理）。默认 dry-run 只打报告，
    // ANCHOR_SLEEP_RECONCILE=apply 才写库——先观察报告质量再开。
    import('./lib/sleep/reconcile')
      .then(m => {
        const sleepDate = getUserSleepDateStr(Date.now() - 24 * 60 * 60 * 1000)
        const result = m.reconcileSleepDay(db, sleepDate, Date.now(), process.env.ANCHOR_SLEEP_RECONCILE === 'apply')
        for (const line of result.logs) console.log(line)
      })
      .catch(console.error)

    // 渐进式宵禁锚点：每日一次朝理想就寝跟随（须在 reconcile 之后，吃清洗后数据；
    // 内部自行判断 anchor_mode === 'progressive'，其他模式空转）
    import('./lib/sunset/progressive')
      .then(m => m.applyDailyProgressiveAdjustment(db))
      .catch(console.error)

    // 周日额外触发每周分析
    if (getUserWeekday(Date.now()) === 0) {
      runWeeklyAnalysis(db).catch(console.error)
    }
  }
}

async function main() {
  const app = next({ dev })
  const handle = app.getRequestHandler()

  await app.prepare()
  const db = initDb()
  console.log(`[server] DB 路径: ${process.env.ANCHOR_DB_PATH ?? path.join(os.homedir(), '.anchor', 'anchor.db')}`)
  const userTz = getUserTimeZone()
  const { hour, minute } = getUserLocalParts(Date.now())
  console.log(`[server] 用户时区: ${userTz} | 当前用户本地时间: ${hour}:${String(minute).padStart(2, '0')}`)
  // AI 提供商（BYOK）：打印端点/模型与脱敏密钥，缺失时 AI 功能静默降级
  {
    const { resolveAiConfig, maskApiKey } = await import('./lib/ai/provider')
    const aiCfg = resolveAiConfig()
    console.log(aiCfg
      ? `[ai] 提供商: ${aiCfg.baseUrl} | 模型: ${aiCfg.model} | 密钥: ${maskApiKey(aiCfg.apiKey)}`
      : '[ai] 未配置 ANCHOR_AI_API_KEY，AI 功能停用（提醒/对话/摘要/仲裁等）')
  }
  initSunsetConfig(db)
  const { initSchoolSchedule } = await import('./lib/school/schedule')
  initSchoolSchedule(db)

  // 启动时先收编历史僵尸 open 段，避免离线时段被拉长覆盖
  import('./lib/inference/close-stale-segments')
    .then(m => {
      const result = m.closeStaleSegments(db, { apply: true })
      for (const line of result.logs) console.log(line)
    })
    .catch(console.error)

  const server = createServer((req, res) => {
    // 认证中间件：公开路径直接放行；未认证 API 401 / 页面 302；认证信息挂 req.anchorAuth
    if (!guardRequest(req, res)) return
    const parsedUrl = parse(req.url!, true)
    handle(req, res, parsedUrl)
  })

  initWsServer(server)

  const { TICK_INTERVAL_MS: FULL_TICK_MS } = await import('./lib/memory/daily-context')
  const lastDailyAiMaintenanceDate: { current: string | null } = { current: null }
  const lastArchivedDate: { current: string | null } = { current: null }

  // 启动时从当日 behavior_logs 重建 DailyContext，并初始化归档日期游标
  {
    const today = getUserDateStr(Date.now())
    const dayStart = userZonedTimeToUtc(today, 0)
    import('./lib/memory/daily-context')
      .then(m => m.rebuildFromLogs(db, today, dayStart))
      .catch(console.error)
    lastArchivedDate.current = today
  }

  setInterval(() => {
    const todayStr = getUserDateStr(Date.now())
    runFullTick(db, todayStr, lastDailyAiMaintenanceDate, lastArchivedDate)
      .catch(console.error)
    lastArchivedDate.current = todayStr
  }, FULL_TICK_MS)

  // 轻量 tick -- 1 分钟：快速状态感知，不写 user_living_context
  const LIGHTWEIGHT_TICK_MS = 60 * 1000
  setInterval(() => {
    import('./lib/inference/pipeline')
      .then(m => m.runPipelineGuarded(db, { mode: 'lightweight', nowMs: Date.now() }))
      .catch(console.error)
  }, LIGHTWEIGHT_TICK_MS)

  // Hourly dissociation diary candidate generation
  setInterval(() => {
    import('./lib/diary/generateCandidates')
      .then(m => m.generateDiaryCandidates(db))
      .catch(console.error)
  }, 60 * 60 * 1000)

  // Hourly 会话清理：物理删除过期会话（N=0 时不打日志）
  setInterval(() => {
    import('./lib/auth/session')
      .then(m => {
        const n = m.cleanupExpiredSessions(db)
        if (n > 0) console.log(`[auth] 清理过期会话 ${n} 个`)
      })
      .catch(console.error)
  }, 60 * 60 * 1000)

  const port = process.env.PORT ?? 4000
  server.listen(port, () => {
    console.log(`Anchor Server running on http://localhost:${port}`)
  })
}

main().catch(console.error)
