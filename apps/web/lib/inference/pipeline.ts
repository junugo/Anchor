import type { Db } from '@anchor/db'
import type { LogEntry, ExtractorConfig, InferenceResult, UserState, FeatureSnapshot } from '@anchor/types'
import { behaviorLogs, userLivingContext } from '@anchor/db'
import { desc, gte, eq } from 'drizzle-orm'
import { extractFeatures } from './feature-extractor'
import { inferState } from './state-inferrer'
import { planInterventions } from './intervention-planner'
import { filterDispatchable, dispatchPlans } from './action-dispatcher'
import { recordStateSegment } from './state-segments'
// 单一真相：DEV_TOOLS 由 engine.ts 导出，此处不重复定义
import { DEV_TOOLS, getSunsetPhase, runDecision } from '../decision/engine'
import { getRecentStrongUserActivity } from '../sleep/engine'
import { getSchoolContext } from '../school/schedule'
import { getUserHour, getUserLocalParts, getUserMinutesSinceMidnight } from '../time/user-time'

export interface PipelineOptions {
  mode: 'lightweight' | 'full'
  nowMs: number
}

// 上一次推断状态（模块级，跨 tick 保留；null = 未初始化，首次运行从 DB 恢复）
// DB（userLivingContext.inferred_state）是状态唯一真相：重启后不丢、decision 引擎不自持副本
let _prevState: UserState | null = null
// 防止管线重叠
let _running = false
// full 请求与正在运行的管线撞车时置位，当前运行结束后补跑一次（不静默丢弃）
let _pendingFull = false
// 测试专用：记录 runPipeline 实际执行次数（被 _running 守卫拦截的调用不计入）
let _runCount = 0

// 在校短路的真实交互窗口：最近 15 分钟无真实交互才判 away（与睡眠候选空闲阈值同量级，
// 容忍校时段边界前后的正常晨间使用）
const AWAY_REAL_ACTIVITY_WINDOW_S = 15 * 60

/** 测试专用：重置模块级可变状态，防止用例间状态污染 */
export function resetPipelineState(): void {
  _prevState = null
  _running = false
  _pendingFull = false
  _runCount = 0
}

/** 测试专用：返回 runPipeline 自上次 resetPipelineState 以来的实际执行次数 */
export function getPipelineRunCount(): number {
  return _runCount
}

/** 当前状态（供 lightweight 触发的矛盾门控判断）；未初始化时返回 transitioning */
export function getPrevState(): UserState {
  return _prevState ?? 'transitioning'
}

// 获取 sunset 配置，初始化失败时返回安全默认值
async function loadSunsetCfg(): Promise<{
  high_stimulus_apps: string[]
  enabled: boolean
  target_bedtime_minutes: number
  phase_t60_enabled: boolean
  phase_t30_enabled: boolean
  phase_t15_enabled: boolean
  phase_t0_enabled: boolean
}> {
  try {
    const { getSunsetConfig } = await import('../sunset/config')
    const cfg = getSunsetConfig()
    return {
      // SunsetConfig 已声明 high_stimulus_apps: string[]，直接访问，无需强制转型
      high_stimulus_apps: cfg.high_stimulus_apps ?? [],
      enabled: cfg.enabled,
      target_bedtime_minutes: cfg.target_bedtime_minutes,
      phase_t60_enabled: cfg.phase_t60_enabled,
      phase_t30_enabled: cfg.phase_t30_enabled,
      phase_t15_enabled: cfg.phase_t15_enabled,
      phase_t0_enabled: cfg.phase_t0_enabled,
    }
  } catch {
    // 测试环境或配置未初始化时的安全默认值
    return {
      high_stimulus_apps: [],
      enabled: false,
      target_bedtime_minutes: 90,
      phase_t60_enabled: true,
      phase_t30_enabled: true,
      phase_t15_enabled: true,
      phase_t0_enabled: true,
    }
  }
}

export async function runPipeline(db: Db, opts: PipelineOptions): Promise<InferenceResult> {
  _runCount++
  const nowS = Math.floor(opts.nowMs / 1000)
  // 首次运行从 DB 恢复状态真相（重启后迟滞保护不丢）
  if (_prevState === null) {
    const row = db
      .select({ inferred_state: userLivingContext.inferred_state })
      .from(userLivingContext)
      .where(eq(userLivingContext.user_id, 'default'))
      .get()
    _prevState = (row?.inferred_state as UserState | undefined) ?? 'transitioning'
  }
  // 恢复段归一：sleeping 是判断引擎短路期间的哨兵状态（短路径写入），away 是校时段
  // 日程短路状态，都不是判断引擎的输出域。用户醒来/到家后恢复正常推断时，不能以其为
  // 前置状态（迟滞安全：inferState 的 previous_state 迟滞分支会偏袒它们，导致状态被钉住）。
  // 归一为 resting——生理上最接近的中性状态，让判断引擎从干净基线恢复。
  // rawPrevState 先于归一捕获：短路返回时用它判断状态变更（睡眠中保持 sleeping→false）
  const rawPrevState = _prevState
  if (_prevState === 'sleeping' || _prevState === 'away') _prevState = 'resting'
  const prevStateAtStart = _prevState
  const lookbackS = opts.mode === 'lightweight' ? 10 * 60 : 2 * 60 * 60
  const since = nowS - lookbackS

  // ── 判断引擎短路（夜间入睡）──────────────────────────────────────────────
  // 日落会话相位为 sleeping 时，判断引擎完全不跑：跳过特征提取/状态推断/AI 仲裁/
  // 干预规划/动作分发，也跳过完整 tick 的 user_living_context 写入、严重度评估、
  // DailyContext 累加等判断引擎副作用。只做三件事：
  //   1) 广播 sleeping 状态（state:update，客户端状态栏保持「睡着」）
  //   2) 写一条 behavior_logs（inferred_state='sleeping'，每日时间线据此显示睡眠块）
  //   3) 调用 runDecision(db, 'sleeping', null) 推进睡眠状态机（任务 3 分流：
  //      仅 checkSunsetPhase，无干预产出）
  // 睡眠引擎照常工作：相位 sleeping 时发现用户活跃会把相位转出 sleeping（→confirming），
  // 短路随之自然解除（phase 不再是 sleeping），下一 tick 判断引擎恢复推断；
  // 正常起床（confirming→cleared/8h 自动解除）同理。轻量/完整 tick 行为一致：
  // 短路检查在一切判断引擎工作（含 feature 提取）之前，两种模式同样生效。
  // 前置守卫：宵禁关闭（config.enabled=false）时不短路——enabled=false 时睡眠状态机
  // 不流转（checkSunsetPhase 首行直接 return），残留的 sleeping 会话无法自行解除，
  // 否则判断引擎被永久短路，所有 tick 静默返回 sleeping；重开宵禁后陈旧会话由 8h
  // 自动解除兜底清理。取舍：短路径不写 user_living_context，睡眠期间 /api/status 与
  // WS 握手返回睡前陈旧状态，靠每 1 分钟的状态广播纠正。
  const cfg = await loadSunsetCfg()
  const { getActiveSession } = await import('../sleep/engine')
  const activePhase = getActiveSession(db, nowS).phase
  // sleeping 与 wake_observing 都短路：观察窗期间用户可能在床上刷手机（未确认起床），
  // 判断引擎不应把 url_visit 推断成 working/entertaining；相位离开观察窗（确认/回 sleeping）
  // 后短路自然解除，与 sleeping 同机制
  if (cfg.enabled && (activePhase === 'sleeping' || activePhase === 'wake_observing')) {
    // 哨兵状态写入模块级 _prevState：睡眠期间 getPrevState()='sleeping'，
    // 矛盾门控（ingest.ts）对所有事件静默；醒来后由上方恢复段归一为 resting
    _prevState = 'sleeping'
    import('../ws/server')
      .then(m => m.broadcast({ type: 'state:update', state: 'sleeping', confidence: 1 }))
      .catch(console.error)
    // 写一条哨兵日志：source 用 'web'（服务器内部写库惯例，同 recordActionResponse）
    db.insert(behaviorLogs).values({
      source: 'web',
      event_type: 'state_inference',
      payload: { state: 'sleeping', reason: 'sunset_session_sleeping' },
      inferred_state: 'sleeping',
      logged_at: nowS,
    }).run()
    recordStateSegment(db, 'sleeping', nowS)
    // 睡眠状态机推进（活跃→confirming 会解除短路），无干预产出
    await runDecision(db, 'sleeping', null).catch(console.error)
    return {
      state: 'sleeping',
      confidence: 1,
      evidence: ['sleeping: 日落会话相位 sleeping，判断引擎短路'],
      previous_state: prevStateAtStart,
      state_changed: rawPrevState !== 'sleeping',
      do_not_disturb: true,
      needs_ai_arbitration: false,
      snapshot: emptySentinelSnapshot(since, nowS, opts.mode),
    }
  }

  // ── 在校短路（上学日白天空白）──────────────────────────────────────────────
  // 上学日校时段内完全没有真实交互是「预期空白」，语义是在校——不是休息也不是睡。
  // 命中条件：当前落在启用的 school_schedule 校时段内，且最近 15 分钟无真实交互事件
  // （app_foreground 心跳 / 空闲结算 / 服务器哨兵都不算，与睡眠引擎同源的强活动语义）。
  // 只做三件事：
  //   1) 广播 away 状态（客户端状态栏显示「在校」）+ recordStateSegment('away')
  //   2) full tick 写 user_living_context.inferred_state='away'（/api/status 与 WS 握手）
  //   3) runDecision(db, 'away', null) 推进日落状态机（away 分流同 sleeping，无干预产出）
  // 跳过特征提取/推断/仲裁/干预规划/分发/DailyContext 累加——校时段语义由日程决定。
  // 校时段内出现真实交互（请假在家、在校用设备）→ 不短路，判断引擎正常观察。
  // 与 sleeping 短路的关系：sleeping 优先（夜间睡眠由 school_departure 在起床估算时刻
  // 结算后相位离开 sleeping，本短路才接管白天；二者不会同时命中）。
  const schoolCtx = getSchoolContext(db, opts.nowMs)
  if (schoolCtx?.inSchoolHours && getRecentStrongUserActivity(db, nowS - AWAY_REAL_ACTIVITY_WINDOW_S).length === 0) {
    _prevState = 'away'
    import('../ws/server')
      .then(m => m.broadcast({ type: 'state:update', state: 'away', confidence: 1 }))
      .catch(console.error)
    recordStateSegment(db, 'away', nowS)
    if (opts.mode === 'full') {
      const existing = db
        .select({ screen_active: userLivingContext.screen_active })
        .from(userLivingContext)
        .where(eq(userLivingContext.user_id, 'default'))
        .get()
      db.insert(userLivingContext)
        .values({ user_id: 'default', inferred_state: 'away', screen_active: existing?.screen_active ?? false, updated_at: nowS })
        .onConflictDoUpdate({
          target: userLivingContext.user_id,
          set: { inferred_state: 'away', updated_at: nowS },
        })
        .run()
    }
    await runDecision(db, 'away', null).catch(console.error)
    return {
      state: 'away',
      confidence: 1,
      evidence: ['away: 上学日校时段内无真实交互，判断引擎短路'],
      previous_state: prevStateAtStart,
      state_changed: rawPrevState !== 'away',
      do_not_disturb: true,
      needs_ai_arbitration: false,
      snapshot: emptySentinelSnapshot(since, nowS, opts.mode),
    }
  }

  const rows = db
    .select({
      source: behaviorLogs.source,
      event_type: behaviorLogs.event_type,
      payload: behaviorLogs.payload,
      logged_at: behaviorLogs.logged_at,
    })
    .from(behaviorLogs)
    .where(gte(behaviorLogs.logged_at, since))
    .orderBy(desc(behaviorLogs.logged_at))
    .all()

  const logs: LogEntry[] = rows.map(r => ({
    source: r.source,
    event_type: r.event_type as LogEntry['event_type'],
    payload: r.payload as Record<string, unknown>,
    logged_at: r.logged_at,
  }))

  // 高刺激域名的唯一数据源：site_classifications 表（/apps 页管理）
  const { getHighStimulusSites } = await import('../sites/high-stimulus')
  const { getWorkSites, getWorkApps, getWorkProcesses } = await import('../sites/work')
  const config: ExtractorConfig = {
    highStimulusDomains: getHighStimulusSites(db),
    highStimulusApps: cfg.high_stimulus_apps,
    devToolProcesses: DEV_TOOLS,
    workDomains: getWorkSites(db),
    workApps: getWorkApps(db),
    workProcesses: getWorkProcesses(db),
  }

  // 注入长期记忆（冷启动 recording 阶段返回 undefined，不影响推断）
  const { loadMemory } = await import('../memory/memory-loader')
  const memory = loadMemory(db)

  const snapshot = extractFeatures(logs, opts.nowMs, { isLightweight: opts.mode === 'lightweight', config })
  let result = inferState(snapshot, {
    previousState: _prevState,
    memory,
    nowHour: getUserHour(opts.nowMs),
  })
  // 开发者页面：每次 tick 广播规则推断结果（含四候选得分与 evidence）
  import('../ws/server')
    .then(m => m.broadcast({ type: 'dev:inference', mode: opts.mode, result, at: nowS }))
    .catch(console.error)
  // AI 仲裁仅 full tick 参与（lightweight 是快速规则通道，不仲裁），且仲裁结果介入
  // 最终状态——写库 / 广播 / 干预规划统一使用仲裁后状态，避免「规则先斩后奏」：
  // 此前干预按规则结果先行分发，仲裁推翻也无法撤回
  if (opts.mode === 'full' && result.needs_ai_arbitration) {
    const { arbitrate } = await import('./ai-arbiter')
    // 缓存 key 用 latest_activity_at（活动快照），不用 window_end（每秒变化，缓存必 miss）
    const hash = String(snapshot.latest_activity_at ?? 'none') + '-' + result.state + '-' + Math.round(result.confidence * 100)
    result = await arbitrate(result, opts.nowMs, hash)
  }
  _prevState = result.state
  recordStateSegment(db, result.state, nowS)

  // 完整 tick 写 user_living_context
  if (opts.mode === 'full') {
    // 读取当前 screen_active，避免硬编码 true 覆盖客户端上报的真实状态
    const existing = db
      .select({ screen_active: userLivingContext.screen_active })
      .from(userLivingContext)
      .where(eq(userLivingContext.user_id, 'default'))
      .get()
    const screenActive = existing?.screen_active ?? true

    db.insert(userLivingContext)
      .values({ user_id: 'default', inferred_state: result.state, screen_active: screenActive, updated_at: nowS })
      .onConflictDoUpdate({
        target: userLivingContext.user_id,
        set: { inferred_state: result.state, updated_at: nowS },
      })
      .run()

    // V1.1：每个完整 tick 计算并持久化严重度等级（三信号融合评估）
    // 等级变化时同步刷新 severity_changed_at（24h 下降迟滞的计时基准）
    try {
      const { computeSeverityLevel } = await import('./severity-assessor')
      const severityLevel = computeSeverityLevel(db, opts.nowMs)
      const prevSeverity = db
        .select({ severity_level: userLivingContext.severity_level })
        .from(userLivingContext)
        .where(eq(userLivingContext.user_id, 'default'))
        .get()?.severity_level
      db.update(userLivingContext)
        .set(prevSeverity !== severityLevel
          ? { severity_level: severityLevel, severity_changed_at: nowS }
          : { severity_level: severityLevel })
        .where(eq(userLivingContext.user_id, 'default'))
        .run()
    } catch (e) {
      console.error('[pipeline] severity assessor error', e)
    }

    import('../ws/server')
      .then(m => m.broadcast({ type: 'state:update', state: result.state, confidence: result.confidence }))
      .catch(console.error)

    // 累加 Layer 1 DailyContext（仅完整 tick，避免轻量 tick 重复计数）
    const { getDailyContext, accumulate, setDailyContext } = await import('../memory/daily-context')
    const parts = getUserLocalParts(opts.nowMs)
    const date = parts.dateStr
    const hour = parts.hour
    const ctx = accumulate(getDailyContext(date), result, hour, Math.floor(opts.nowMs / 1000))
    setDailyContext(ctx)
    // 完整 tick 额外触发决策引擎（胶囊、宵禁、生命救援、注意力残留等）
    // prevStateAtStart 由 pipeline 统一提供，engine 不再自持 _prevState（消除双轨分歧）
    runDecision(db, result.state, prevStateAtStart).catch(console.error)
  }

  // 干预决策与分发（使用用户时区 + 会话状态，避免服务器时区/强制解锁后回锁问题）
  const { isSunsetWindow, minutesAfterBedtime } = await computeSunsetContext(db, cfg, opts.nowMs)
  const plans = planInterventions(db, result, { nowMs: opts.nowMs, isSunsetWindow, minutesAfterBedtime })
  // 先过滤（冷却/勿扰）再生成文案：被拦掉的计划不浪费 AI 调用
  const dispatchable = filterDispatchable(plans, { doNotDisturb: result.do_not_disturb, nowMs: opts.nowMs, state: result.state }, db)
  // AI 文案并行生成，避免串行 await 网络延迟叠加；hard 立即执行，用已有 fallback 文案
  const { generateCopy } = await import('./ai-copywriter')
  await Promise.all(dispatchable.map(async p => {
    if (p.type === 'hard') return
    p.message = await generateCopy(result.state, p.type)
  }))
  await dispatchPlans(dispatchable, { state: result.state })

  return result
}

// 防重叠包装（供 server.ts tick 调用）
export async function runPipelineGuarded(db: Db, opts: PipelineOptions): Promise<void> {
  if (_running) {
    // full 请求不静默丢弃：标记后由当前运行补跑
    if (opts.mode === 'full') _pendingFull = true
    return
  }
  _running = true
  try {
    await runPipeline(db, opts)
    if (_pendingFull) {
      _pendingFull = false
      await runPipeline(db, { mode: 'full', nowMs: Date.now() })
    }
  } catch (e) {
    console.error('[pipeline]', e)
  } finally {
    _running = false
  }
}

// 短路径哨兵结果的空快照：判断引擎未运行，无真实特征可填；供 InferenceResult.snapshot
// 类型完整性使用（dev:inference 广播等消费方在短路径下不会触发，仅占位）。
// sleeping / away 两条短路共用。
function emptySentinelSnapshot(windowStartS: number, windowEndS: number, mode: 'lightweight' | 'full'): FeatureSnapshot {
  return {
    window_start: windowStartS,
    window_end: windowEndS,
    is_lightweight: mode === 'lightweight',
    code_active_count: 0,
    deep_work_duration_ms: 0,
    work_momentum_score: 0,
    work_app_duration_ms: 0,
    work_visit_count: 0,
    android_in_work_app: false,
    high_stimulus_visit_count: 0,
    entertainment_depth_score: 0,
    attention_fragmentation_score: 0,
    tab_explosion: false,
    android_unlock_rate: 0,
    android_fun_app_current: false,
    android_physical_activity: 'unknown',
    do_not_disturb: true,
    is_idle: true,
    event_counts: {},
    active_sources: [],
  }
}

/**
 * 使用用户时区 + 会话状态计算宵禁上下文，避免服务器时区导致白天被当成宵禁，
 * 同时让 released/cleared 会话继续压制时间触发回锁。
 */
async function computeSunsetContext(
  db: Db,
  cfg: {
    enabled: boolean
    target_bedtime_minutes: number
    phase_t60_enabled: boolean
    phase_t30_enabled: boolean
    phase_t15_enabled: boolean
    phase_t0_enabled: boolean
  },
  nowMs: number,
): Promise<{ isSunsetWindow: boolean; minutesAfterBedtime: number }> {
  if (!cfg.enabled) {
    return { isSunsetWindow: false, minutesAfterBedtime: -1 }
  }
  const nowMinutes = getUserMinutesSinceMidnight(nowMs)
  // T0 锚定倒数锚点（与 tick 广播同一真相，按 anchor_mode 换算）；无历史回退静态 target_bedtime
  const { resolveSunsetAnchor } = await import('../sleep/pattern')
  const predicted = resolveSunsetAnchor(db, nowMs)
  const phase = getSunsetPhase(nowMinutes, predicted.startMinutes, cfg, predicted.endMinutes)
  const nowS = Math.floor(nowMs / 1000)
  const { computeCurrentSunsetStage } = await import('../sleep/engine')
  const { stage, session } = computeCurrentSunsetStage(db, phase, nowS)
  if (stage !== 'T0') {
    return { isSunsetWindow: false, minutesAfterBedtime: -1 }
  }
  // 中周期闸门：仅 curfew/confirming/sleeping 会话的 T0 才算宵禁窗口。
  // winddown/cleared 会话撞上时钟 T0（如午间 phantom 行：auto_8h 后 getTodaySession
  // 新建的 winddown 行被 enterCurfewByClock 拉起）不构成宵禁语义——否则「就寝后 N 分钟
  // 未睡」规则会在白天对着 resting 反复轰炸（2026-09-02 上学日实测 138 条硬干预）。
  if (session.phase !== 'curfew' && session.phase !== 'confirming' && session.phase !== 'sleeping') {
    return { isSunsetWindow: false, minutesAfterBedtime: -1 }
  }
  const minutesAfter = (nowMinutes - predicted.startMinutes + 24 * 60) % (24 * 60)
  return { isSunsetWindow: true, minutesAfterBedtime: minutesAfter }
}
