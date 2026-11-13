import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { behaviorLogs, circadianLogs, closeDb, createDb } from '@anchor/db'
import type { Db } from '@anchor/db'
import { initSunsetConfig, getSunsetConfig, updateSunsetConfig } from './config'
import {
  applyDailyProgressiveAdjustment,
  chaseCandidateMinutes,
  decideProgressiveAnchor,
  loadLastSleepStart,
  loadNightMedianSleepStart,
  retreatMinutesLast7d,
  signedDelta,
  PROGRESSIVE_ADJUST_EVENT,
  GRACE_MINUTES,
} from './progressive'
import { getUserDateStr, userZonedTimeToUtc } from '../time/user-time'

const IDEAL = 23 * 60 + 30 // 23:30
const STEP = 15

function tempDb(name: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `anchor-prog-${name}-`))
  const db = createDb(path.join(dir, 'anchor.db'))
  initSunsetConfig(db)
  return { dir, db }
}

function daysAgo(n: number): string {
  return getUserDateStr(Date.now() - n * 24 * 60 * 60 * 1000)
}

/** 在睡眠日 dateStr 插入一条本地 startMin 入睡记录（sleep_end 给足时长） */
function seedSleepStart(db: Db, dateStr: string, startMin: number) {
  db.insert(circadianLogs).values({
    date: dateStr,
    sleep_start: userZonedTimeToUtc(dateStr, startMin),
    sleep_end: userZonedTimeToUtc(dateStr, startMin) + 7 * 3600,
    meals_count: 0,
    left_room_count: 0,
  }).run()
}

// ─── signedDelta / chase 环形语义 ─────────────────────────────

test('signedDelta：跨午夜环绕的带符号最短差', () => {
  assert.equal(signedDelta(23 * 60, IDEAL), 30)
  assert.equal(signedDelta(90, IDEAL), -120)
  assert.equal(signedDelta(IDEAL, 90), 120)
  assert.equal(signedDelta(105, 90), -15)
})

test('chaseCandidateMinutes：向 ideal 方向走一步，不越过', () => {
  assert.equal(chaseCandidateMinutes(2 * 60, IDEAL, STEP), 105) // 02:00 → 01:45
  assert.equal(chaseCandidateMinutes(23 * 60, IDEAL, STEP), 23 * 60 + 15) // 23:00 → 23:15
  assert.equal(chaseCandidateMinutes(IDEAL, IDEAL, STEP), IDEAL) // 已到 ideal 不动
})

// ─── decideProgressiveAnchor v2 领走式 ────────────────────────

test('decide：无入睡数据 → 原地不动', () => {
  const d = decideProgressiveAnchor({ anchorMinutes: 317, idealMinutes: IDEAL, stepMinutes: STEP, lastSleepMinutes: null, medianMinutes: 392, retreatUsedMinutes: 0 })
  assert.equal(d.action, 'hold')
  assert.equal(d.reason, 'insufficient_data')
})

test('decide：合规（入睡 ≤ 锚点+30）→ 锚点向 ideal 领走一步', () => {
  // 05:17 锚点，昨晚 05:30 入睡（+13）→ 前进到 05:02
  const d = decideProgressiveAnchor({ anchorMinutes: 317, idealMinutes: IDEAL, stepMinutes: STEP, lastSleepMinutes: 330, medianMinutes: 392, retreatUsedMinutes: 0 })
  assert.equal(d.action, 'advance')
  assert.equal(d.newAnchorMinutes, 302)
  assert.equal(d.movedMinutes, -15)
})

test('decide：提前入睡同样合规 → 领走', () => {
  const d = decideProgressiveAnchor({ anchorMinutes: 317, idealMinutes: IDEAL, stepMinutes: STEP, lastSleepMinutes: 300, medianMinutes: 392, retreatUsedMinutes: 0 })
  assert.equal(d.action, 'advance')
})

test('decide：距 ideal 不足一步时一步到达，已到 ideal 停住', () => {
  // 锚点 23:05、ideal 23:00：合规 → 最后一步直接到 ideal
  const near = decideProgressiveAnchor({ anchorMinutes: 1385, idealMinutes: 1380, stepMinutes: STEP, lastSleepMinutes: 1385, medianMinutes: 1385, retreatUsedMinutes: 0 })
  assert.equal(near.action, 'advance')
  assert.equal(near.newAnchorMinutes, 1380)
  // 已在 ideal：候选 == 锚点 → arrived
  const at = decideProgressiveAnchor({ anchorMinutes: 1380, idealMinutes: 1380, stepMinutes: STEP, lastSleepMinutes: 1380, medianMinutes: 1380, retreatUsedMinutes: 0 })
  assert.equal(at.action, 'hold')
  assert.equal(at.reason, 'arrived')
})

test('decide：领走上限——前进后领先中位数 >90min 则原地等用户', () => {
  // 合规，但中位数 07:00，前进后领先 118min → 钳住
  const d = decideProgressiveAnchor({ anchorMinutes: 317, idealMinutes: IDEAL, stepMinutes: STEP, lastSleepMinutes: 330, medianMinutes: 420, retreatUsedMinutes: 0 })
  assert.equal(d.action, 'hold')
  assert.match(d.reason, /lead_cap/)
})

test('decide：中位数数据不足时不施加上限', () => {
  const d = decideProgressiveAnchor({ anchorMinutes: 317, idealMinutes: IDEAL, stepMinutes: STEP, lastSleepMinutes: 330, medianMinutes: null, retreatUsedMinutes: 0 })
  assert.equal(d.action, 'advance')
})

test('decide：睡晚但在 90 内 → 原地施压（hold）', () => {
  const d = decideProgressiveAnchor({ anchorMinutes: 317, idealMinutes: IDEAL, stepMinutes: STEP, lastSleepMinutes: 380, medianMinutes: 392, retreatUsedMinutes: 0 })
  assert.equal(d.action, 'hold')
  assert.match(d.reason, /pressure/)
})

test('decide：宽限边界——恰 30min 合规，恰 90min 施压，91min 进入 retreat', () => {
  const at30 = decideProgressiveAnchor({ anchorMinutes: 317, idealMinutes: IDEAL, stepMinutes: STEP, lastSleepMinutes: 347, medianMinutes: 392, retreatUsedMinutes: 0 })
  assert.equal(at30.action, 'advance')
  const at90 = decideProgressiveAnchor({ anchorMinutes: 317, idealMinutes: IDEAL, stepMinutes: STEP, lastSleepMinutes: 407, medianMinutes: 407, retreatUsedMinutes: 0 })
  assert.equal(at90.action, 'hold')
  assert.match(at90.reason, /pressure/)
  const at91 = decideProgressiveAnchor({ anchorMinutes: 317, idealMinutes: IDEAL, stepMinutes: STEP, lastSleepMinutes: 408, medianMinutes: 408, retreatUsedMinutes: 0 })
  assert.equal(at91.action, 'retreat')
})

test('decide：崩盘 retreat 阀门 = min(gap−90, 预算剩余, 步幅)', () => {
  // gap 123：min(33, 30, 15) = 15
  const d = decideProgressiveAnchor({ anchorMinutes: 317, idealMinutes: IDEAL, stepMinutes: STEP, lastSleepMinutes: 440, medianMinutes: 440, retreatUsedMinutes: 0 })
  assert.equal(d.action, 'retreat')
  assert.equal(d.newAnchorMinutes, 332)
  assert.equal(d.movedMinutes, 15)
})

test('decide：retreat 受周预算钳制', () => {
  // 已用 25 → 预算剩 5 → 只退 5
  const d = decideProgressiveAnchor({ anchorMinutes: 317, idealMinutes: IDEAL, stepMinutes: STEP, lastSleepMinutes: 440, medianMinutes: 440, retreatUsedMinutes: 25 })
  assert.equal(d.action, 'retreat')
  assert.equal(d.newAnchorMinutes, 322)
  assert.equal(d.movedMinutes, 5)
})

test('decide：周预算耗尽 → 拒绝倒退原地不动', () => {
  const d = decideProgressiveAnchor({ anchorMinutes: 317, idealMinutes: IDEAL, stepMinutes: STEP, lastSleepMinutes: 440, medianMinutes: 440, retreatUsedMinutes: 30 })
  assert.equal(d.action, 'hold')
  assert.match(d.reason, /retreat_blocked/)
})

test('decide：中位数持续脱节 >180 → resync 回跟随点（不烧预算）', () => {
  // 中位数 09:20（560），锚点 05:17：gap 243 → 重锚到 09:05（中位数朝 ideal 一步）
  const d = decideProgressiveAnchor({ anchorMinutes: 317, idealMinutes: IDEAL, stepMinutes: STEP, lastSleepMinutes: 560, medianMinutes: 560, retreatUsedMinutes: 30 })
  assert.equal(d.action, 'resync')
  assert.equal(d.newAnchorMinutes, 545)
})

test('decide：单晚极端入睡不触发 resync（中位数兜底），走 retreat', () => {
  // 昨晚通宵到 13:20（800），但中位数仅 +13 → 不 resync；retreat 15
  const d = decideProgressiveAnchor({ anchorMinutes: 317, idealMinutes: IDEAL, stepMinutes: STEP, lastSleepMinutes: 800, medianMinutes: 330, retreatUsedMinutes: 0 })
  assert.equal(d.action, 'retreat')
  assert.equal(d.newAnchorMinutes, 332)
})

// ─── loadLastSleepStart 采信带 ────────────────────────────────

test('loadLastSleepStart：06:32 真实熬夜采信，11:55 phantom 跳过', () => {
  const { dir, db } = tempDb('last-valid')
  try {
    seedSleepStart(db, daysAgo(1), 11 * 60 + 55) // 最新但 phantom，跳过
    seedSleepStart(db, daysAgo(2), 6 * 60 + 32) // 392 采信
    assert.equal(loadLastSleepStart(db), 6 * 60 + 32)
  } finally {
    closeDb(db); fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('loadLastSleepStart：只有午间行时返回 null', () => {
  const { dir, db } = tempDb('last-null')
  try {
    seedSleepStart(db, daysAgo(1), 12 * 60 + 30)
    seedSleepStart(db, daysAgo(2), 15 * 60)
    assert.equal(loadLastSleepStart(db), null)
  } finally {
    closeDb(db); fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ─── loadNightMedianSleepStart 窗口与滞后 ─────────────────────

test('loadNightMedianSleepStart：不足 3 晚返回 null', () => {
  const { dir, db } = tempDb('median-few')
  try {
    seedSleepStart(db, daysAgo(1), 23 * 60 + 30)
    seedSleepStart(db, daysAgo(2), 23 * 60 + 30)
    assert.equal(loadNightMedianSleepStart(db), null)
  } finally {
    closeDb(db); fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('loadNightMedianSleepStart：06:37 真实入睡计入；11:55 phantom 排除；跨午夜环形中位', () => {
  const { dir, db } = tempDb('median-wrap')
  try {
    seedSleepStart(db, daysAgo(1), 6 * 60 + 37) // 397，v2 窗口 [18:00,10:00) 计入
    seedSleepStart(db, daysAgo(2), 23 * 60 + 30) // 1410
    seedSleepStart(db, daysAgo(3), 6 * 60 + 37)
    seedSleepStart(db, daysAgo(4), 11 * 60 + 55) // phantom 排除
    // 环形中位（旋转到 [18:00,10:00) 线性空间）：[757, 330, 757] → 757 → 转回 397
    assert.equal(loadNightMedianSleepStart(db), 6 * 60 + 37)
  } finally {
    closeDb(db); fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('loadNightMedianSleepStart：排除今天的行', () => {
  const { dir, db } = tempDb('median-today')
  try {
    seedSleepStart(db, daysAgo(0), 4 * 60)
    seedSleepStart(db, daysAgo(1), 23 * 60 + 30)
    seedSleepStart(db, daysAgo(2), 23 * 60 + 30)
    assert.equal(loadNightMedianSleepStart(db), null)
  } finally {
    closeDb(db); fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ─── retreatMinutesLast7d 预算回算 ────────────────────────────

test('retreatMinutesLast7d：只累计 7 天内的 retreat 移动', () => {
  const { dir, db } = tempDb('budget')
  try {
    const nowS = Math.floor(Date.now() / 1000)
    const log = (direction: string, moved: number, ageDays: number) =>
      db.insert(behaviorLogs).values({
        source: 'web',
        event_type: PROGRESSIVE_ADJUST_EVENT,
        payload: { direction, moved_minutes: moved },
        logged_at: nowS - ageDays * 24 * 3600,
      }).run()

    log('retreat', 15, 3)
    log('advance', -15, 2) // 前进不计
    log('resync', 120, 1) // 重锚不计
    log('retreat', 20, 1)
    log('retreat', 10, 10) // 超窗不计

    assert.equal(retreatMinutesLast7d(db), 35)
  } finally {
    closeDb(db); fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ─── applyDailyProgressiveAdjustment 集成 ─────────────────────

test('apply：非 progressive 模式空转', async () => {
  const { dir, db } = tempDb('apply-noop')
  try {
    seedSleepStart(db, daysAgo(1), 2 * 60)
    await applyDailyProgressiveAdjustment(db, Date.now(), { broadcast: false })
    assert.equal(getSunsetConfig().target_bedtime_minutes, 90)
    assert.equal(db.select().from(behaviorLogs).all().length, 0)
  } finally {
    closeDb(db); fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('apply：合规夜晚 → 锚点领走并记 advance 日志', async () => {
  const { dir, db } = tempDb('apply-advance')
  try {
    updateSunsetConfig({ anchor_mode: 'progressive', target_bedtime_minutes: 120, ideal_bedtime_minutes: IDEAL })
    // 昨晚 02:10 入睡（锚点 02:00，gap +10 ≤ 30 合规）；近 3 晚中位 02:10 不触上限
    seedSleepStart(db, daysAgo(1), 2 * 60 + 10)
    seedSleepStart(db, daysAgo(2), 2 * 60 + 10)
    seedSleepStart(db, daysAgo(3), 2 * 60 + 10)

    await applyDailyProgressiveAdjustment(db, Date.now(), { broadcast: false })

    assert.equal(getSunsetConfig().target_bedtime_minutes, 105) // 01:45
    const logs = db.select().from(behaviorLogs).all().filter(l => l.event_type === PROGRESSIVE_ADJUST_EVENT)
    assert.equal(logs.length, 1)
    const p = logs[0].payload as Record<string, unknown>
    assert.equal(p.direction, 'advance')
    assert.equal(p.sleep_minutes, 130)
    assert.equal(p.gap_minutes, 10)
    assert.equal(p.grace_minutes, GRACE_MINUTES)
  } finally {
    closeDb(db); fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('apply：睡晚（宽限带内）→ 锚点原地不动且不刷日志', async () => {
  const { dir, db } = tempDb('apply-pressure')
  try {
    updateSunsetConfig({ anchor_mode: 'progressive', target_bedtime_minutes: 120, ideal_bedtime_minutes: IDEAL })
    seedSleepStart(db, daysAgo(1), 3 * 60) // gap +60 → 施压 hold
    seedSleepStart(db, daysAgo(2), 3 * 60)
    seedSleepStart(db, daysAgo(3), 3 * 60)

    await applyDailyProgressiveAdjustment(db, Date.now(), { broadcast: false })

    assert.equal(getSunsetConfig().target_bedtime_minutes, 120)
    assert.equal(db.select().from(behaviorLogs).all().length, 0)
  } finally {
    closeDb(db); fs.rmSync(dir, { recursive: true, force: true })
  }
})
