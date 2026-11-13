import type { Db } from '@anchor/db'
import { circadianLogs } from '@anchor/db'
import { eq } from 'drizzle-orm'
import { userZonedTimeToUtc } from '../time/user-time'
import { computeDayFeatures, scoreSlots, smoothScores, assembleSleepSegments, mainSegment, SLOT_COUNT } from './slots'
import { buildSleepPrior } from './pattern'
import { updateSleepMetrics } from '../circadian/sleep'

/**
 * 离线回溯修正（reconcile）：每日归档时对上一个睡眠日跑 slot 识别，与状态机记录对账。
 *
 * 状态机是实时系统，只能依据「当下可见的信号 + 预测窗口」工作，必然有两大类误差：
 * - phantom：无信号时段被猜睡（上学日白天、设备静默），记下了不存在的睡眠；
 * - 漏记：入睡发生在窗口外或信号太弱，状态机没来得及确认，真实睡眠没进记录。
 *
 * reconcile 用全量 slot 特征（事后视角，前后文完整）重识别，以识别结果为准修正
 * circadian_logs。状态机历史行（sunset_sessions）是瞬态，不回溯修改。
 *
 * 幂等：circadian_logs.sleep_reconciled_at 标记已处理日期；重复运行只产生报告不产生写。
 * 合并窗口：识别段与记录段重叠 > 50%（按较短段计）视为一致。
 */

/** 候选线：与 M3 实时候选阈值一致（0.8 经生产数据标定，见 engine.ts） */
const RECOG_THRESHOLD = 0.8
/** 记录与识别的入睡点偏差在 90min 内也视为一致（slot 粒度 30min 的固有误差） */
const START_TOLERANCE_S = 90 * 60
/** 漏记回填的最短睡眠：少于 2 个 slot（1h）的段不下结论（可能是静置） */
const MIN_BACKFILL_SLOTS = 2

export interface ReconcileResult {
  logs: string[]
  /** 是否需要写（dry-run 时为 false 也照常输出报告） */
  changed: boolean
}

function fmt(ts: number): string {
  const d = new Date(ts * 1000)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * 对指定睡眠日（12:00 为界的 date 串）执行对账。
 * apply=false 时只输出报告（dry-run），不写库。
 */
export function reconcileSleepDay(db: Db, sleepDate: string, nowMs = Date.now(), apply = false): ReconcileResult {
  const logs: string[] = []
  const windowStartS = userZonedTimeToUtc(sleepDate, 12 * 60)
  if (windowStartS + 24 * 60 * 60 > nowMs / 1000) {
    return { logs: [`[reconcile] ${sleepDate} 窗口未结束，跳过`], changed: false }
  }

  const existing = db.select().from(circadianLogs).where(eq(circadianLogs.date, sleepDate)).get()
  if (existing?.sleep_reconciled_at) {
    return { logs: [`[reconcile] ${sleepDate} 已处理过，跳过`], changed: false }
  }

  const features = computeDayFeatures(db, windowStartS)
  const prior = buildSleepPrior(db, nowMs, sleepDate)
  const scores = smoothScores(scoreSlots(features, prior, undefined, SLOT_COUNT / 2))
  const segments = assembleSleepSegments(windowStartS, scores, RECOG_THRESHOLD, 1)
  const recognized = mainSegment(segments)

  const recStart = existing?.sleep_start ?? null
  const recEnd = existing?.sleep_end ?? null
  const hasRecord = recStart != null && recEnd != null && recEnd > recStart

  let changed = false

  if (!recognized && !hasRecord) {
    logs.push(`[reconcile] ${sleepDate} 无识别段、无记录，一致（空日）`)
  } else if (recognized && !hasRecord) {
    // ── 漏记回填 ──
    if (recognized.slotCount < MIN_BACKFILL_SLOTS) {
      logs.push(`[reconcile] ${sleepDate} 识别到 ${recognized.slotCount} slot 短段（<${MIN_BACKFILL_SLOTS}），不足以回填：${fmt(recognized.startS)}–${fmt(recognized.endS)}`)
    } else {
      logs.push(`[reconcile] ${sleepDate} 漏记睡眠，回填：${fmt(recognized.startS)}–${fmt(recognized.endS)}（${recognized.slotCount} slot，均分 ${recognized.avgScore.toFixed(2)}）`)
      changed = true
      if (apply) {
        backfillSleep(db, sleepDate, recognized.startS, recognized.endS, nowMs)
      }
    }
  } else if (!recognized && hasRecord) {
    // ── phantom：有记录但全窗口识别不到睡眠段 ──
    logs.push(`[reconcile] ${sleepDate} phantom 睡眠：记录 ${fmt(recStart!)}–${fmt(recEnd!)}，但全窗口识别无睡眠段，作废记录`)
    changed = true
    if (apply) {
      db.update(circadianLogs)
        .set({ sleep_start: null, sleep_end: null, sleep_debt_hours: null, sunset_compliance: null, sleep_reconciled_at: Math.floor(nowMs / 1000) })
        .where(eq(circadianLogs.date, sleepDate))
        .run()
    }
  } else {
    // ── 双方都有：一致性判定 ──
    const overlap = Math.min(recEnd!, recognized!.endS) - Math.max(recStart!, recognized!.startS)
    const shortSide = Math.min(recEnd! - recStart!, recognized!.endS - recognized!.startS)
    const startDelta = Math.abs(recStart! - recognized!.startS)
    if (overlap > 0 && (overlap >= shortSide * 0.5 || startDelta <= START_TOLERANCE_S)) {
      logs.push(`[reconcile] ${sleepDate} 一致：记录 ${fmt(recStart!)}–${fmt(recEnd!)}，识别 ${fmt(recognized!.startS)}–${fmt(recognized!.endS)}（偏差 ${Math.round(startDelta / 60)}min）`)
    } else {
      logs.push(`[reconcile] ${sleepDate} 冲突：记录 ${fmt(recStart!)}–${fmt(recEnd!)}，识别 ${fmt(recognized!.startS)}–${fmt(recognized!.endS)}（零重叠），以识别为准修正`)
      changed = true
      if (apply) {
        backfillSleep(db, sleepDate, recognized!.startS, recognized!.endS, nowMs)
      }
    }
  }

  // 一致/空日也打标记，避免每天都重算一遍
  if (apply && !existing?.sleep_reconciled_at) {
    db.update(circadianLogs)
      .set({ sleep_reconciled_at: Math.floor(nowMs / 1000) })
      .where(eq(circadianLogs.date, sleepDate))
      .run()
  }

  return { logs, changed }
}

/** 回填/修正：upsert circadian_logs 睡眠字段并重算债务 */
function backfillSleep(db: Db, sleepDate: string, startS: number, endS: number, nowMs: number): void {
  const existing = db.select().from(circadianLogs).where(eq(circadianLogs.date, sleepDate)).get()
  const nowS = Math.floor(nowMs / 1000)
  if (existing) {
    db.update(circadianLogs)
      .set({ sleep_start: startS, sleep_end: endS, sleep_reconciled_at: nowS })
      .where(eq(circadianLogs.date, sleepDate))
      .run()
  } else {
    db.insert(circadianLogs).values({ date: sleepDate, sleep_start: startS, sleep_end: endS, sleep_reconciled_at: nowS }).run()
  }
  updateSleepMetrics(db, sleepDate)
}
