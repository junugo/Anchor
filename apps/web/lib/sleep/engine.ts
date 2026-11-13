import { sunsetSessions, behaviorLogs, circadianLogs } from '@anchor/db'
import type { Db } from '@anchor/db'
import type { SunsetSession, SunsetSessionPhase, SunsetCandidateOrigin } from '@anchor/types'
import { eq, gte, desc, inArray, isNotNull, and } from 'drizzle-orm'
import { getSunsetConfig } from '../sunset/config'
import {
  getUserSleepDateStr,
  getUserDateStr,
  getUserLocalParts,
  getUserMinutesSinceMidnight,
  getUserTimeZone,
  userZonedTimeToUtc,
  isWithinLocalMinutesBand,
} from '../time/user-time'
import { isUserActivityEvent, isSleepCandidateEvent, isStrongUserActivityEvent, isPassivePollingEvent } from './activity'
import { clearRecordedSleepStart, recordSleepStartAt, recordSleepEndAt } from '../circadian/wakeup'
import { getSchoolContext } from '../school/schedule'
import { buildSleepPrior, predictSleepWindow, type SleepPrior } from './pattern'
import { computeDayFeatures, scoreSlots, smoothScores, DEFAULT_SCORE_WEIGHTS, SLOT_COUNT, SLOT_SECONDS } from './slots'

/**
 * 睡眠状态机引擎（服务器唯一权威，会话持久化到 sunset_sessions 表）。
 *
 * 相位计算的单一真相是 computeCurrentSunsetStage：tick 广播 / WS 握手 / /api/status
 * 三处共用，会话驱动，杜绝「两源打架」导致的客户端横跳。
 *
 * 状态流转：
 *   winddown ──时钟 T0──► curfew
 *   curfew ──点「睡了」──► sleeping
 *   winddown(检测窗口内)/curfew/released ──被动候选──► confirming ──超时──► sleeping
 *   confirming ──「还没睡」/候选内活动──► 回来源相位（winddown/curfew/released）
 *   sleeping ──白名单活动(矛盾)──► confirming（场景 B：确认框裁决）
 *   confirming(origin=sleeping) ──超时(真睡)──► 停留 sleeping，入睡时间不变，last_awake_at 推进到超时时刻（防旧活动重复触发确认）
 *   confirming(origin=sleeping) ──「还没睡」(假警报)──► curfew：入睡登记作废（sleep_start 清空 + circadian 同步），确认冷却 30min，判断引擎短路解除
 *   sleeping ──sleep_start_at+8h──► cleared(auto_8h)
 *   sleeping ──上学日过起床估算点且入睡后零活动──► cleared(school_departure)（sleep_end=估算点）
 *   上学日校时段：不产生新被动候选；进行中的非 sleeping 候选直接作废（不猜睡）
 *   curfew/released ──时钟窗口已过且无 sleep_start──► cleared(auto_8h)（兜底）
 *   任何 ──sunset:release──► released（时间触发压制，直到起床/睡眠周期完成）
 *   任何 ──wakeup:verified──► cleared(wakeup)（清真正持有睡眠的行）
 *   cleared ──时钟进入 winddown──► winddown（新周期复活）
 */

export interface SleepParams {
  sleep_buffer_minutes: number
  sleep_confirm_minutes: number
  sleep_candidate_idle_minutes: number
  sleep_confirm_cooldown_minutes: number
  /** 亮屏静止入睡检测：无真实交互、有轮询心跳时按睡眠候选处理 */
  sleep_bright_screen_enabled: boolean
}

export type SunsetStage = 'T60' | 'T30' | 'T15' | 'T0' | 'off'
export type ClockPhase = 'T60' | 'T30' | 'T15' | 'T0' | null

/** 观察窗长度：入睡 <3h 内的强活动按夜醒处理，窗长 30min；≥3h 按晨间起床处理，窗长 10min */
const WAKE_OBSERVE_SHORT_S = 30 * 60
const WAKE_OBSERVE_LONG_S = 10 * 60
/** 入睡后 N 秒内视为「夜醒」档（观察窗 30min），超过则视为「晨间」档（观察窗 10min） */
const WAKE_OBSERVE_SHORT_LIMIT_S = 3 * 60 * 60
/** 自适应睡眠上限：clamp(近 60 次实际睡眠时长最大值 + 1h, 8h, 14h) */
const CAP_MAX_HISTORY = 60
const CAP_BUFFER_S = 60 * 60
const CAP_MIN_S = 8 * 60 * 60
const CAP_MAX_S = 14 * 60 * 60
/** 确认框广播后忽略活动的宽限窗口（确认框自己唤醒屏幕产生的 screen_on/unlock 不计入「醒了」证据） */
const CONFIRM_WAKE_GRACE_S = 10
/** 周期进行中的相位（活跃会话查找范围） */
const MID_CYCLE_PHASES: SunsetSessionPhase[] = ['curfew', 'confirming', 'sleeping', 'wake_observing', 'released']
/** winddown 相位跑被动入睡候选的窗口：就寝前 N 分钟起（由 sunset.ts 计算传入）；白天 AFK 不检测，防止误判入睡拉宵禁 */
export const PASSIVE_SLEEP_WINDOW_MINUTES = 120
/**
 * 识别驱动的被动候选触发阈值（专利启发打分制）：当前 slot 平滑分 ≥ 0.8 且落在
 * 预测睡眠带内才进入候选。误报代价是白天弹确认框+可能灰屏，阈值取高分位。
 * 0.8 由生产数据离线验证标定（2026-09-09）：真实睡眠段峰值 0.82-0.87（睡眠中
 * 静止占比仅 ~0.17 拉低天花板），非睡眠 slot 最高 0.754，0.8 可干净分离。
 */
const CANDIDATE_SCORE_THRESHOLD = 0.8

/** 会话归属日：跨午夜归前一晚（与 recordSleepStart 一致）。以用户时区 12:00 为界。 */
export function sessionDateKey(nowMs = Date.now()): string {
  return getUserSleepDateStr(nowMs)
}

function defaultNowS(): number {
  return Math.floor(Date.now() / 1000)
}

function defaultParams(): SleepParams {
  const c = getSunsetConfig()
  return {
    sleep_buffer_minutes: c.sleep_buffer_minutes,
    sleep_confirm_minutes: c.sleep_confirm_minutes,
    sleep_candidate_idle_minutes: c.sleep_candidate_idle_minutes,
    sleep_confirm_cooldown_minutes: c.sleep_confirm_cooldown_minutes,
    // 亮屏静止检测默认开启；旧库无该列时回退 true
    sleep_bright_screen_enabled: c.sleep_bright_screen_enabled ?? true,
  }
}

// ─── 会话读写 ─────────────────────────────────────────────────────────────────

export function getSessionByDate(db: Db, date: string): SunsetSession | null {
  const row = db.select().from(sunsetSessions).where(eq(sunsetSessions.date, date)).get()
  return (row as SunsetSession) ?? null
}

/** 读取（或创建）当晚会话行 */
export function getTodaySession(db: Db, nowS = defaultNowS()): SunsetSession {
  const date = sessionDateKey(nowS * 1000)
  const existing = getSessionByDate(db, date)
  if (existing) return existing
  db.insert(sunsetSessions).values({ date, phase: 'winddown', created_at: nowS, updated_at: nowS }).run()
  return getSessionByDate(db, date)!
}

/**
 * 活跃会话：最近一条周期进行中的行（curfew/confirming/sleeping/released，最新日期优先），
 * 无则当日行。跨中午后昨日 sleeping/released 行不被孤儿化——8h 解除、起床解除、候选都打在活跃行上。
 */
export function getActiveSession(db: Db, nowS = defaultNowS()): SunsetSession {
  const midCycle = db
    .select()
    .from(sunsetSessions)
    .where(inArray(sunsetSessions.phase, MID_CYCLE_PHASES))
    .orderBy(desc(sunsetSessions.date))
    .limit(1)
    .get()
  if (midCycle) return midCycle as SunsetSession
  return getTodaySession(db, nowS)
}

function updateSession(db: Db, date: string, patch: Partial<SunsetSession>, nowS: number): SunsetSession {
  db.update(sunsetSessions).set({ ...patch, updated_at: nowS }).where(eq(sunsetSessions.date, date)).run()
  return getSessionByDate(db, date)!
}

// ─── 统一相位计算（单一真相） ──────────────────────────────────────────────────

export interface SunsetStageSnapshot {
  stage: SunsetStage
  session: SunsetSession
}

/**
 * 统一相位计算：tick 广播 / WS 握手 / /api/status 三处共用的唯一权威。
 * 附带两个自愈写入：cleared 在 winddown 时钟下复活为新周期；curfew/released 无 sleep_start 且窗口已过兜底清除。
 */
export function computeCurrentSunsetStage(db: Db, clockPhase: ClockPhase, nowS = defaultNowS()): SunsetStageSnapshot {
  let session = getActiveSession(db, nowS)

  // 复活：新宵禁周期开始（winddown 时钟），旧的 cleared 行归位 winddown
  if (session.phase === 'cleared' && (clockPhase === 'T60' || clockPhase === 'T30' || clockPhase === 'T15')) {
    session = updateSession(db, session.date, {
      phase: 'winddown',
      cleared_at: null,
      clear_reason: null,
      force_release_reason: null,
      force_release_count: 0,
      sleep_start_reported_at: null,
      sleep_start_at: null,
      last_awake_at: null,
      candidate_started_at: null,
      candidate_origin_phase: null,
      confirm_requested_at: null,
      wake_first_activity_at: null,
      wake_observe_until_at: null,
    }, nowS)
  }

  // 兜底：curfew/released（或来源为二者的 confirming）无 sleep_start_at 且时钟窗口已过 → 自动解除。
  // released 也必须兜底：否则破戒会话永不清理，劫持 getActiveSession 压制后续所有时间触发宵禁。
  // origin=winddown 的 confirming 不纳入：它出现在就寝前（clockPhase 非 null），不到此分支。
  const fallbackTargetsTimeWindow =
    session.phase === 'curfew' || session.phase === 'released' ||
    (session.phase === 'confirming' &&
      (session.candidate_origin_phase === 'curfee' || session.candidate_origin_phase === 'released'))
  if (fallbackTargetsTimeWindow && session.sleep_start_at == null && clockPhase == null) {
    session = updateSession(db, session.date, {
      phase: 'cleared',
      cleared_at: nowS,
      clear_reason: 'auto_8h',
      candidate_started_at: null,
      candidate_origin_phase: null,
      confirm_requested_at: null,
    }, nowS)
  }

  return { stage: stageForSession(session, clockPhase), session }
}

function stageForSession(session: SunsetSession, clockPhase: ClockPhase): SunsetStage {
  switch (session.phase) {
    case 'winddown':
      return clockPhase ?? 'off'
    case 'curfew':
    case 'sleeping':
      return 'T0'
    case 'wake_observing':
      // 观察窗相位跟随当前时钟：T0 带内仍显示宵禁（与 sleeping 一致，客户端保持灰屏）；
      // 带外（白天活动确认起床）显示 off，与「还没睡」回 curfee 但时钟已过 → cleared 兜底一致
      return clockPhase ?? 'off'
    case 'confirming':
      // 确认框相位跟随来源：released 只弹框不拉宵禁；winddown 维持当前时钟相位；curfee/sleeping 维持 T0
      if (session.candidate_origin_phase === 'released') return 'off'
      if (session.candidate_origin_phase === 'winddown') return clockPhase ?? 'off'
      return 'T0'
    case 'released':
    case 'cleared':
      return 'off'
  }
}

/** 会话是否压制时间触发的宵禁（released/cleared 后不再因时钟回 T0） */
export function sessionBlocksTimeCurfew(phase: SunsetSessionPhase): boolean {
  return phase === 'released' || phase === 'cleared'
}

// ─── 查询辅助 ────────────────────────────────────────────────────────────────

/** 最近 sinceS 以来的白名单活动事件（新→旧）；window_focus 空闲结算（is_idle:true）不算活动 */
export function getRecentUserActivity(db: Db, sinceS: number): Array<{ event_type: string; logged_at: number }> {
  const rows = db
    .select({ event_type: behaviorLogs.event_type, logged_at: behaviorLogs.logged_at, payload: behaviorLogs.payload })
    .from(behaviorLogs)
    .where(gte(behaviorLogs.logged_at, sinceS))
    .orderBy(desc(behaviorLogs.logged_at))
    .all()
  return rows.filter(r => isUserActivityEvent(r.event_type, r.payload))
}

/** 最近 sinceS 以来的真实交互事件（新→旧）；window_focus 空闲结算不算真实交互 */
export function getRecentStrongUserActivity(db: Db, sinceS: number): Array<{ event_type: string; logged_at: number }> {
  const rows = db
    .select({ event_type: behaviorLogs.event_type, logged_at: behaviorLogs.logged_at, payload: behaviorLogs.payload })
    .from(behaviorLogs)
    .where(gte(behaviorLogs.logged_at, sinceS))
    .orderBy(desc(behaviorLogs.logged_at))
    .all()
  return rows
    .filter(r => isStrongUserActivityEvent(r.event_type, r.payload))
    .map(r => ({ event_type: r.event_type, logged_at: r.logged_at }))
}

/** 最近 sinceS 以来是否有被动轮询事件（app_foreground / physical_activity / app_usage_snapshot 等） */
export function getRecentPassivePolling(db: Db, sinceS: number): boolean {
  const rows = db
    .select({ event_type: behaviorLogs.event_type })
    .from(behaviorLogs)
    .where(gte(behaviorLogs.logged_at, sinceS))
    .all()
  return rows.some(r => isPassivePollingEvent(r.event_type))
}

/** 最近 sinceS 以来最新的入睡候选信号（screen_off / screen_lock）时间 */
export function getRecentCandidateSignal(db: Db, sinceS: number): number | null {
  const rows = db
    .select({ event_type: behaviorLogs.event_type, logged_at: behaviorLogs.logged_at })
    .from(behaviorLogs)
    .where(gte(behaviorLogs.logged_at, sinceS))
    .orderBy(desc(behaviorLogs.logged_at))
    .all()
  const candidate = rows.find(r => isSleepCandidateEvent(r.event_type))
  return candidate ? candidate.logged_at : null
}

// ─── 确认框协议 ──────────────────────────────────────────────────────────────

function broadcastConfirmRequest(candidateSinceS: number, params: SleepParams): void {
  import('../ws/server')
    .then(m => m.broadcast({
      type: 'sleep:confirm-request',
      since: candidateSinceS,
      confirm_until: candidateSinceS + params.sleep_confirm_minutes * 60,
    }))
    .catch(console.error)
}

function broadcastConfirmCancel(reason: string): void {
  import('../ws/server')
    .then(m => m.broadcast({ type: 'sleep:confirm-cancel', reason }))
    .catch(console.error)
}

function broadcastWakeConfirmRequest(firstActivityAt: number, observeUntil: number): void {
  import('../ws/server')
    .then(m => m.broadcast({ type: 'wakeup:confirm-request', since: firstActivityAt, observe_until: observeUntil }))
    .catch(console.error)
}

function broadcastWakeConfirmCancel(reason: string): void {
  import('../ws/server')
    .then(m => m.broadcast({ type: 'wakeup:confirm-cancel', reason }))
    .catch(console.error)
}

// ─── 主动作（由客户端事件 / API 触发） ─────────────────────────────────────────

/** 手动点「睡了」：直接进入 sleeping，sleep_start=点击时间（打在活跃会话上） */
export function reportSleepStart(db: Db, nowS = defaultNowS()): SunsetSession {
  const session = getActiveSession(db, nowS)
  if (session.phase === 'sleeping' || session.phase === 'cleared') return session
  return updateSession(db, session.date, {
    phase: 'sleeping',
    sleep_start_reported_at: nowS,
    sleep_start_at: nowS,
    last_awake_at: nowS,
    candidate_started_at: null,
    candidate_origin_phase: null,
    confirm_requested_at: null,
    wake_first_activity_at: null,
    wake_observe_until_at: null,
  }, nowS)
}

/**
 * 起床验证：清除**真正持有睡眠的行**（最近周期进行中的会话），无则当日行。
 * 修复中午后起床清错行、昨晚 sleeping 行孤儿化的问题。
 *
 * 同时在 circadian_logs 当前睡眠日行落 wakeup_confirmed_at 标记：进入日期级
 * 起床压制区间，时钟在「下一次预测入睡点」之前不得把 winddown 拉回 curfew
 * （2026-09-08 事故根治：11:09 起床后 12:00 新建会话行又被 T0 时钟拉回宵禁）。
 */
export function recordWakeupSession(db: Db, nowS = defaultNowS()): SunsetSession {
  const midCycle = db
    .select()
    .from(sunsetSessions)
    .where(inArray(sunsetSessions.phase, MID_CYCLE_PHASES))
    .orderBy(desc(sunsetSessions.date))
    .limit(1)
    .get() as SunsetSession | undefined
  const target = midCycle ?? getTodaySession(db, nowS)

  // 起床标记：写入当前睡眠日行（存在则更新，不存在则建行只带标记）
  const sleepDate = getUserSleepDateStr(nowS * 1000)
  const existingLog = db.select().from(circadianLogs).where(eq(circadianLogs.date, sleepDate)).get()
  if (existingLog) {
    db.update(circadianLogs).set({ wakeup_confirmed_at: nowS }).where(eq(circadianLogs.date, sleepDate)).run()
  } else {
    db.insert(circadianLogs).values({ date: sleepDate, wakeup_confirmed_at: nowS }).run()
  }

  return updateSession(db, target.date, {
    phase: 'cleared',
    cleared_at: nowS,
    clear_reason: 'wakeup',
    candidate_started_at: null,
    candidate_origin_phase: null,
    confirm_requested_at: null,
    wake_first_activity_at: null,
    wake_observe_until_at: null,
  }, nowS)
}

/** 强制解锁：临时放行 released（时间触发压制，直到起床/睡眠周期完成）；记录破戒 + AI 跟进 */
export async function releaseSunsetForce(db: Db, reason: string, nowS = defaultNowS()): Promise<SunsetSession> {
  const session = getActiveSession(db, nowS)
  if (session.phase === 'cleared') return session

  db.insert(behaviorLogs).values({
    source: 'web',
    event_type: 'curfew_breach',
    payload: { reason: reason || null, from_phase: session.phase },
    logged_at: nowS,
  }).run()

  const updated = updateSession(db, session.date, {
    phase: 'released',
    cleared_at: nowS,
    clear_reason: 'force',
    force_release_reason: reason || null,
    force_release_count: session.force_release_count + 1,
    // 睡眠尝试作废：候选/确认从头再来（released 下照跑被动候选）
    sleep_start_reported_at: null,
    sleep_start_at: null,
    candidate_started_at: null,
    candidate_origin_phase: null,
    // 刚解锁 30min 内不触发候选（用户刚明说「我醒着」）
    confirm_requested_at: nowS,
    wake_first_activity_at: null,
    wake_observe_until_at: null,
  }, nowS)

  const { triggerAiReminder } = await import('../ai/reminder')
  triggerAiReminder(db, 'bedtime', { curfewReleased: true, reason }).catch(console.error)

  return updated
}

/** 客户端响应「还没睡」：确认框的唯一响应（点到即回答 = 醒着）。场景 B 对 origin==='sleeping' 回 curfew 并作废入睡登记；其余 origin 回来源相位 */
export function respondSleepConfirm(db: Db, nowS = defaultNowS(), _params = defaultParams()): SunsetSession {
  const session = getActiveSession(db, nowS)
  if (session.phase !== 'confirming') return session
  broadcastConfirmCancel('responded')
  const origin: SunsetCandidateOrigin = session.candidate_origin_phase ?? 'curfee'

  if (origin === 'sleeping') {
    // 场景 B：点了「睡了」但醒着（假警报）→ 回 curfew（宵禁窗口，干预照常），
    // 本次入睡登记作废：sleep_start 清空 + circadian_logs 同步置 NULL；
    // confirm_requested_at = nowS 触发 30min 冷却，不再重复弹「你睡着了吗？」。
    // 相位离开 sleeping → pipeline 短路立即解除，判断引擎从下一 tick 恢复。
    const voidedSleepStart = session.sleep_start_at ?? nowS
    const updated = updateSession(db, session.date, {
      phase: 'curfew',
      last_awake_at: nowS,
      sleep_start_reported_at: null,
      sleep_start_at: null,
      candidate_started_at: null,
      candidate_origin_phase: null,
      confirm_requested_at: nowS,
    }, nowS)
    clearRecordedSleepStart(db, voidedSleepStart)
    return updated
  }
  // 被动候选 → 回来源相位（curfew/released），候选作废，进冷却
  return updateSession(db, session.date, {
    phase: origin === 'curfee' ? 'curfew' : origin,
    last_awake_at: nowS,
    candidate_started_at: null,
    candidate_origin_phase: null,
    confirm_requested_at: nowS,
  }, nowS)
}

// ─── 5min tick 状态推进 ───────────────────────────────────────────────────────

/**
 * curfew/released 是否应进入 confirming（被动候选，冷却外）。
 *
 * 识别驱动路径（有个人节律先验时，CN117061658B 启发）：当前 30min slot 的
 * 平滑评分 ≥ 0.9 且落在预测睡眠带（前扩 PASSIVE_SLEEP_WINDOW_MINUTES 容忍早睡）
 * 内才进入候选；candidateSince 取评分突降点近似（最近息屏/锁屏信号 → 最近真实
 * 交互 → idle 阈值兜底）。识别只决定「何时问」，确认框仍是「何时定」的裁决。
 *
 * 冷启动路径（无历史先验）：沿用固定窗口 + 信号分层逻辑：
 * 1. 息屏/锁屏信号（screen_off/screen_lock），或完全无活动。
 * 2. 亮屏静止：没有真实交互事件，但有设备轮询心跳（app_foreground 等）——
 *    人睡了、屏幕亮着、App 在前台跑心跳的场景。开关关闭时此路径不生效。
 * 真实交互 = STRONG_USER_ACTIVITY_EVENT_TYPES，不含 app_foreground 心跳。
 */
function shouldEnterConfirming(db: Db, session: SunsetSession, params: SleepParams, nowS: number): { enter: boolean; candidateSince: number | null } {
  const cooldownUntil = (session.confirm_requested_at ?? 0) + params.sleep_confirm_cooldown_minutes * 60
  if (nowS < cooldownUntil) return { enter: false, candidateSince: null }

  // 上学日校时段：人在校、设备静默是日程预期，不是入睡信号——不进入被动候选。
  // 校时段内的真实交互不会走到这里（pipeline away 短路以 STRONG 活动放行正常推断），
  // 此时猜睡只会制造 phantom sleeping（2026-09 开学周实测：白天被记成 15h 睡眠）。
  if (getSchoolContext(db, nowS * 1000)?.inSchoolHours) return { enter: false, candidateSince: null }

  const idleThreshold = nowS - params.sleep_candidate_idle_minutes * 60

  // ── 识别驱动路径：有个人先验时用 slot 评分 + 预测睡眠带双闸门 ──
  const prior = buildSleepPrior(db, nowS * 1000)
  if (prior) {
    const gate = currentSlotGate(db, nowS, prior)
    if (!gate.inWindow || gate.score < CANDIDATE_SCORE_THRESHOLD) {
      return { enter: false, candidateSince: null }
    }
    const candidateSince =
      getRecentCandidateSignal(db, idleThreshold) ??
      getRecentStrongUserActivity(db, idleThreshold)[0]?.logged_at ??
      idleThreshold
    return { enter: true, candidateSince }
  }

  // ── 冷启动路径（无历史）：固定窗口 + 信号分层 ──

  // 第一层：任何白名单活动（含 app_foreground）→ 用户醒着，不进入候选
  // 例外：亮屏静止开启时，仅由「轮询心跳」组成的活动不作为阻挡
  const anyActivity = getRecentUserActivity(db, idleThreshold)
  if (anyActivity.length > 0) {
    if (params.sleep_bright_screen_enabled) {
      // 过滤掉纯轮询事件后仍有活动 → 真实交互存在，不进入
      const hasStrong = anyActivity.some(a => !isPassivePollingEvent(a.event_type))
      if (hasStrong) return { enter: false, candidateSince: null }
    } else {
      return { enter: false, candidateSince: null }
    }
  }

  // 第二层：息屏/锁屏信号
  const candidateSignalAt = getRecentCandidateSignal(db, idleThreshold)
  if (candidateSignalAt != null) {
    return { enter: true, candidateSince: candidateSignalAt }
  }

  // 第三层：亮屏静止——无真实交互、无息屏信号，但有轮询心跳 → 设备亮着但无人操作
  if (params.sleep_bright_screen_enabled && getRecentPassivePolling(db, idleThreshold)) {
    return { enter: true, candidateSince: idleThreshold }
  }

  // 第四层：完全无事件（用户走开且设备静默），或屏幕亮但开关关闭
  // 原逻辑下这两类都直接进入候选；开关关闭只是不新增「轮询心跳」路径，不影响兜底
  return { enter: true, candidateSince: idleThreshold }
}

/**
 * 当前时刻的 slot 评分闸门：在当前睡眠日窗口（本地 12:00 起，与 sessionDateKey 一致）
 * 上重算 48 slot 特征与平滑分，取当前 slot 得分；并用预测睡眠带（前扩 120min 早睡
 * 容忍）判定是否在窗内。prior 由调用方传入避免重复构建。
 */
function currentSlotGate(db: Db, nowS: number, prior: SleepPrior): { score: number; inWindow: boolean } {
  const nowMs = nowS * 1000
  const zone = getUserTimeZone()
  const windowStartS = userZonedTimeToUtc(getUserSleepDateStr(nowMs, zone), 12 * 60, zone, nowMs)
  const features = computeDayFeatures(db, windowStartS)
  const scores = smoothScores(scoreSlots(features, prior, DEFAULT_SCORE_WEIGHTS, SLOT_COUNT / 2))
  const slotIdx = Math.max(0, Math.min(SLOT_COUNT - 1, Math.floor((nowS - windowStartS) / SLOT_SECONDS)))
  const predicted = predictSleepWindow(db, nowMs, prior)
  const nowMinutes = getUserMinutesSinceMidnight(nowMs, zone)
  const inWindow = isWithinLocalMinutesBand(
    nowMinutes,
    predicted.startMinutes - PASSIVE_SLEEP_WINDOW_MINUTES,
    predicted.endMinutes,
  )
  return { score: scores[slotIdx], inWindow }
}

function tickConfirming(db: Db, session: SunsetSession, params: SleepParams, nowS: number): void {
  const candidateSince = session.candidate_started_at ?? nowS
  // 确认窗口从询问框广播时刻起算（candidate_started_at 可能是 15min 前的息屏点，
  // 若从它起算，询问框刚弹出就到期，用户没有响应机会）
  const confirmUntil = (session.confirm_requested_at ?? candidateSince) + params.sleep_confirm_minutes * 60
  const bufferS = params.sleep_buffer_minutes * 60
  const origin: SunsetCandidateOrigin = session.candidate_origin_phase ?? 'curfee'

  // 候选内出现白名单活动：
  // - 被动候选（origin=curfew/released）：用户确实醒了 → 回来源相位
  // - 点击后矛盾（origin=sleeping）：不据此自动裁决，信任点击，等询问框响应/超时
  if (origin !== 'sleeping') {
    // 竞态宽限：忽略确认框广播后 CONFIRM_WAKE_GRACE_S 秒内的活动
    // （确认框自己唤醒屏幕产生的 screen_on/unlock 不是「醒了」证据）
    const activityWindowStart = (session.confirm_requested_at ?? candidateSince) + CONFIRM_WAKE_GRACE_S
    const activityDuringCandidate = getRecentUserActivity(db, Math.max(candidateSince, activityWindowStart))
    if (activityDuringCandidate.length > 0) {
      const latest = activityDuringCandidate[0].logged_at
      broadcastConfirmCancel('activity')
      updateSession(db, session.date, {
        phase: origin === 'curfee' ? 'curfew' : origin,
        last_awake_at: latest,
        candidate_started_at: null,
        candidate_origin_phase: null,
        confirm_requested_at: nowS,
      }, nowS)
      return
    }
  }

  // 上学日校时段：候选大概率是「上学无信号」假象——超时裁决成 sleeping 会把整个白天记成睡眠。
  // 作废候选、回来源相位（不写 sleep_start），等放学后的真实活动重新校准。
  if (origin !== 'sleeping' && getSchoolContext(db, nowS * 1000)?.inSchoolHours) {
    broadcastConfirmCancel('school_hours')
    updateSession(db, session.date, {
      phase: origin === 'curfee' ? 'curfew' : origin,
      candidate_started_at: null,
      candidate_origin_phase: null,
      confirm_requested_at: nowS,
    }, nowS)
    return
  }

  // 窗口超时：无响应 → auto-confirm
  if (nowS >= confirmUntil) {
    broadcastConfirmCancel('timeout')
    if (origin === 'sleeping') {
      // 场景 B：点了「睡了」→ 信号误判，保持点击时间，停留 sleeping。
      // 关键：last_awake_at 推进到超时时刻——确认窗口已裁决「真睡」，窗口前的旧活动
      // 就此结清；否则 tickSleeping 每次都用同一个 last_awake_at 反复翻出同批旧事件，
      // sleeping/confirming 以 ~20min 为周期抖动，pipeline 短路反复失效（实测一夜抖 5 次，
      // 睡眠期色带被判断引擎的 working/resting 段覆盖，干预也在「睡眠中」误分发）。
      updateSession(db, session.date, {
        phase: 'sleeping',
        last_awake_at: nowS,
        candidate_started_at: null,
        candidate_origin_phase: null,
        confirm_requested_at: null,
      }, nowS)
    } else {
      // 被动候选 → sleeping，sleep_start = 候选起点 + BUFFER
      const sleepStartAt = candidateSince + bufferS
      updateSession(db, session.date, {
        phase: 'sleeping',
        sleep_start_at: sleepStartAt,
        last_awake_at: candidateSince,
        candidate_started_at: null,
        candidate_origin_phase: null,
        confirm_requested_at: null,
      }, nowS)
      // 同步写入 circadian_logs（与手动点「睡了」一致）
      recordSleepStartAt(db, sleepStartAt)
    }
  }
}

function tickSleeping(db: Db, session: SunsetSession, params: SleepParams, nowS: number): void {
  const sleepStart = session.sleep_start_at
  if (sleepStart == null) return // 兜底由 computeCurrentSunsetStage 时钟逻辑处理

  // 上学日晨间结算：学生出门不带设备，等 8h 解除会把睡眠虚增到中午（实测 15h+）。
  // 条件全满足才结算：sleep_start 在起床估算点之前、当前已过估算点、入睡后零活动
  // （有晨间活动说明人在家用设备，交给正常的「活动→wake_observing」唤醒路径）。
  const school = getSchoolContext(db, nowS * 1000)
  if (school?.isSchoolDay && sleepStart < school.wakeEstimateAtS && nowS >= school.wakeEstimateAtS
      && getRecentUserActivity(db, session.last_awake_at ?? sleepStart).length === 0) {
    updateSession(db, session.date, {
      phase: 'cleared',
      cleared_at: nowS,
      clear_reason: 'school_departure',
      candidate_started_at: null,
      candidate_origin_phase: null,
      confirm_requested_at: null,
      wake_first_activity_at: null,
      wake_observe_until_at: null,
    }, nowS)
    // sleep_end 写入 sleep_start 的睡眠日所在行并重算债务（school_departure 是估算值，
    // 不触发 recordWakeup 的意图确认/晨间时间锚——人已经到校了）
    recordSleepEndAt(db, sleepStart, school.wakeEstimateAtS)
    return
  }

  // 自适应睡眠上限：clamp(近 60 次实际睡眠时长最大值 + 1h, 8h, 14h)。
  // 取代固定 8h 硬解除，解决「睡超过 8h 被提前切掉」的问题；触发时落 sleep_end 兜底
  // 「设备全关/零信号」场景，正常起床由观察窗裁决。
  const capS = computeSleepCapSeconds(db)
  if (sleepStart + capS <= nowS) {
    const endAt = sleepStart + capS
    updateSession(db, session.date, {
      phase: 'cleared',
      cleared_at: nowS,
      clear_reason: 'wakeup_cap',
      candidate_started_at: null,
      candidate_origin_phase: null,
      confirm_requested_at: null,
      wake_first_activity_at: null,
      wake_observe_until_at: null,
    }, nowS)
    recordSleepEndAt(db, sleepStart, endAt)
    return
  }

  // 首个强活动（冷却外）→ 进入 wake_observing 观察窗：
  // 不立即解除（避免半夜刷 5 分钟手机被误判起床），窗内第二个强活动才确认起床。
  // 观察窗同时广播 wakeup:confirm-request 作为可选快捷确认（点「我醒了」立即解除）。
  const cooldownUntil = (session.confirm_requested_at ?? 0) + params.sleep_confirm_cooldown_minutes * 60
  if (nowS >= cooldownUntil) {
    const sinceActivity = session.last_awake_at ?? sleepStart
    const strong = getRecentStrongUserActivity(db, sinceActivity)
    if (strong.length > 0) {
      const firstActivityAt = strong[strong.length - 1].logged_at // 最早的事件（新→旧，取最后一个）
      const elapsed = firstActivityAt - sleepStart
      const observeWindowS = elapsed < WAKE_OBSERVE_SHORT_LIMIT_S ? WAKE_OBSERVE_SHORT_S : WAKE_OBSERVE_LONG_S
      const observeUntil = firstActivityAt + observeWindowS
      updateSession(db, session.date, {
        phase: 'wake_observing',
        wake_first_activity_at: firstActivityAt,
        wake_observe_until_at: observeUntil,
        candidate_started_at: null,
        candidate_origin_phase: null,
        confirm_requested_at: null,
      }, nowS)
      broadcastWakeConfirmRequest(firstActivityAt, observeUntil)
    }
  }
}

/**
 * 计算自适应睡眠上限（秒）：近 60 次实际睡眠时长最大值 + 1h，夹在 [8h, 14h]。
 * 用 max 而非均值/P90：用户「偶尔睡超 8h」的日子不多，均值类口径会被稀释涨不上去；
 * 上限只兜底「设备全关/零信号」场景，不影哩日常精度，取 max 更鲁棒。
 */
function computeSleepCapSeconds(db: Db): number {
  const rows = db
    .select({ start: circadianLogs.sleep_start, end: circadianLogs.sleep_end })
    .from(circadianLogs)
    .where(and(isNotNull(circadianLogs.sleep_start), isNotNull(circadianLogs.sleep_end)))
    .orderBy(desc(circadianLogs.date))
    .limit(CAP_MAX_HISTORY)
    .all()
  let maxDuration = 0
  for (const r of rows) {
    if (r.start != null && r.end != null && r.end > r.start) {
      const dur = r.end - r.start
      if (dur > maxDuration) maxDuration = dur
    }
  }
  const raw = maxDuration + CAP_BUFFER_S
  return Math.max(CAP_MIN_S, Math.min(CAP_MAX_S, raw))
}

function tickWakeObserving(db: Db, session: SunsetSession, params: SleepParams, nowS: number, clockPhase: ClockPhase = null): void {
  const firstActivityAt = session.wake_first_activity_at
  const observeUntil = session.wake_observe_until_at
  if (firstActivityAt == null || observeUntil == null) {
    // 字段缺失（异常状态）→ 回 sleeping 让下次 tick 重新检测
    updateSession(db, session.date, { phase: 'sleeping' }, nowS)
    return
  }

  // 观察窗内出现第二个强活动（竞态宽限外）→ 确认起床
  const activityWindowStart = firstActivityAt + CONFIRM_WAKE_GRACE_S
  const strong = getRecentStrongUserActivity(db, Math.max(activityWindowStart, session.last_awake_at ?? 0))
  if (strong.length > 0) {
    resolveWakeObserving(db, session, nowS, 'activity', clockPhase)
    return
  }

  // 观察窗超时无第二个强活动 → 回 sleeping（夜醒），推进 last_awake_at 防旧活动重复触发
  if (nowS >= observeUntil) {
    broadcastWakeConfirmCancel('timeout')
    updateSession(db, session.date, {
      phase: 'sleeping',
      last_awake_at: nowS,
      confirm_requested_at: nowS, // 30min 冷却：避免超时瞬间同一活动再次触发观察窗
      wake_first_activity_at: null,
      wake_observe_until_at: null,
    }, nowS)
  }
}

/**
 * wake_observing 确认起床的统一出口（观察窗第二个强活动 / 用户点「我醒了」/ wakeup:verified）。
 * - 写 sleep_end = 首个强活动时刻（wakeup_confirmed_at 同步写，压制时钟宵禁至下次预测入睡）
 * - 相位去向按时钟：仍在 T0 带 [bedtime, bedtime+8h) 内 → 回 curfee（宵禁/灰屏继续，
 *   与「还没睡」语义一致）；已出 T0 带 → cleared（白天活动，宵禁不再拉起）
 *
 * 时钟相位由调用方传入（tick 内部直接调用时由 sunset.ts 计算；WS 路由由 /api/status 上下文提供）。
 * 传 null 时保守按「在 T0 带内」处理（回 curfee），避免深夜误判 cleared 后又被 T0 拉回。
 */
export function resolveWakeObserving(
  db: Db,
  session: SunsetSession,
  nowS: number,
  reason: 'activity' | 'user_confirm',
  clockPhase: ClockPhase = null,
): SunsetSession {
  const sleepStart = session.sleep_start_at
  const firstActivityAt = session.wake_first_activity_at ?? nowS
  broadcastWakeConfirmCancel('resolved')

  // 落 sleep_end + wakeup_confirmed_at（isWakeupSuppressed 取全表 max 压制时钟宵禁，
  // 否则重演 9/8 中午被 T0 拉回宵禁的事故）
  if (sleepStart != null) {
    recordSleepEndAt(db, sleepStart, firstActivityAt)
    const sleepDate = getUserSleepDateStr(sleepStart * 1000)
    const existingLog = db.select().from(circadianLogs).where(eq(circadianLogs.date, sleepDate)).get()
    if (existingLog) {
      db.update(circadianLogs).set({ wakeup_confirmed_at: nowS }).where(eq(circadianLogs.date, sleepDate)).run()
    } else {
      db.insert(circadianLogs).values({ date: sleepDate, wakeup_confirmed_at: nowS }).run()
    }
  }

  // 相位去向：按时钟相位判定（T0 带内 → curfee；带外 → cleared）
  if (clockPhase === 'T0') {
    return updateSession(db, session.date, {
      phase: 'curfew',
      cleared_at: null,
      clear_reason: null,
      sleep_start_reported_at: null,
      sleep_start_at: null, // 本轮睡眠已结束（sleep_end 已落库），清字段让时钟兜底可生效
      last_awake_at: nowS,
      candidate_started_at: null,
      candidate_origin_phase: null,
      confirm_requested_at: null,
      wake_first_activity_at: null,
      wake_observe_until_at: null,
    }, nowS)
  }
  return updateSession(db, session.date, {
    phase: 'cleared',
    cleared_at: nowS,
    clear_reason: reason === 'user_confirm' ? 'wakeup' : 'wakeup_auto',
    last_awake_at: nowS,
    candidate_started_at: null,
    candidate_origin_phase: null,
    confirm_requested_at: null,
    wake_first_activity_at: null,
    wake_observe_until_at: null,
  }, nowS)
}

/** 客户端响应 wakeup:confirm-request：confirmed=true 立即解除（等价手动验证）；false 仅关闭弹窗 */
export function respondWakeConfirm(
  db: Db,
  nowS = defaultNowS(),
  confirmed: boolean,
  clockPhase: ClockPhase = null,
): SunsetSession {
  const session = getActiveSession(db, nowS)
  if (session.phase !== 'wake_observing') return session
  if (!confirmed) {
    broadcastWakeConfirmCancel('dismissed')
    return session
  }
  return resolveWakeObserving(db, session, nowS, 'user_confirm', clockPhase)
}

/**
 * 睡眠状态机 tick 入口。在 sunset.ts checkSunsetPhase 起始处调用，
 * 先推进活跃会话状态，再由统一相位计算广播最新相位。
 * passiveWindowActive：当前时刻是否在被动检测窗口内（就寝前 PASSIVE_SLEEP_WINDOW_MINUTES 起 ~ 就寝后 8h），
 * winddown/curfew/released 三个相位的被动候选统一受此闸门约束——窗口外（白天）不猜睡，
 * 防止通宵后的 released 会话在上午误判 sleeping 拉起宵禁。
 */
export function tickSleepStateMachine(db: Db, nowS = defaultNowS(), params = defaultParams(), passiveWindowActive = false, clockPhase: ClockPhase = null): void {
  const session = getActiveSession(db, nowS)

  switch (session.phase) {
    case 'winddown':
    case 'curfew':
    case 'released': {
      if (!passiveWindowActive) break
      const { enter, candidateSince } = shouldEnterConfirming(db, session, params, nowS)
      if (enter && candidateSince != null) {
        // session.phase 在此处收窄为 'winddown' | 'curfew' | 'released'；'curfew' 对应 SunsetCandidateOrigin 的 'curfee'（项目历史拼写）
        const originPhase: SunsetCandidateOrigin = session.phase === 'curfew' ? 'curfee' : session.phase
        updateSession(db, session.date, {
          phase: 'confirming',
          candidate_started_at: candidateSince,
          candidate_origin_phase: originPhase,
          confirm_requested_at: nowS,
        }, nowS)
        broadcastConfirmRequest(candidateSince, params)
      }
      break
    }
    case 'confirming':
      tickConfirming(db, session, params, nowS)
      break
    case 'sleeping':
      tickSleeping(db, session, params, nowS)
      break
    case 'wake_observing':
      tickWakeObserving(db, session, params, nowS, clockPhase)
      break
    case 'cleared':
      break
  }
}

/**
 * 由 sunset.ts 时钟逻辑调用：winddown → curfew（打在活跃会话上）。
 *
 * 起床日期级压制（2026-09-08 事故根治）：已确认起床的用户，在下一次预测入睡点
 * 到来之前，时钟不得拉回宵禁——无论跨午新建多少 winddown 行。11:09 起床 →
 * 压制到次日预测入睡点（如 04:00）；到点压制自然过期，当晚宵禁照常拉起。
 */
export function enterCurfeeByClock(db: Db, nowS = defaultNowS()): SunsetSession {
  const session = getActiveSession(db, nowS)
  if (session.phase !== 'winddown') return session
  if (isWakeupSuppressed(db, nowS)) return session
  return updateSession(db, session.date, { phase: 'curfew' }, nowS)
}

/** 最近一次确认起床时间（全局最新）；无标记返回 null */
function latestWakeupConfirmedAt(db: Db): number | null {
  const rows = db
    .select({ v: circadianLogs.wakeup_confirmed_at })
    .from(circadianLogs)
    .where(isNotNull(circadianLogs.wakeup_confirmed_at))
    .all()
  let max: number | null = null
  for (const r of rows) {
    if (r.v != null && (max == null || r.v > max)) max = r.v
  }
  return max
}

/**
 * 本地分钟数在 anchorS 之后的下一次出现时刻（Unix 秒，严格大于）。
 * anchor 当天该时刻已过（或恰在那一刻）则取次日——「恰在那一刻」不视为
 * 「已过」，保证预测入睡点整点压制按时解除。
 */
function nextOccurrenceOfLocalMinutes(localMinutes: number, anchorS: number): number {
  const anchorMs = anchorS * 1000
  const zone = getUserTimeZone()
  const anchorLocal = getUserLocalParts(anchorMs, zone)
  let candidate = userZonedTimeToUtc(anchorLocal.dateStr, localMinutes, zone, anchorMs)
  if (candidate < anchorS) {
    const tomorrowStr = getUserDateStr(anchorMs + 24 * 60 * 60 * 1000, zone)
    candidate = userZonedTimeToUtc(tomorrowStr, localMinutes, zone, anchorMs)
  }
  return candidate
}

function isWakeupSuppressed(db: Db, nowS: number): boolean {
  const lastWakeup = latestWakeupConfirmedAt(db)
  if (lastWakeup == null) return false
  const predicted = predictSleepWindow(db, nowS * 1000)
  const nextStartS = nextOccurrenceOfLocalMinutes(predicted.startMinutes, Math.max(lastWakeup, nowS))
  return nowS < nextStartS
}
