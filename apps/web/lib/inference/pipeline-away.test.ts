import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { eq, isNull } from 'drizzle-orm'
import { behaviorLogs, closeDb, createDb, stateSegments, userLivingContext } from '@anchor/db'
import { runPipeline, resetPipelineState } from './pipeline'
import { initSunsetConfig } from '../sunset/config'
import { initSchoolSchedule, updateSchoolSchedule } from '../school/schedule'
import { userZonedTimeToUtc } from '../time/user-time'

function tempDb(name: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `anchor-${name}-`))
  return { dir, db: createDb(path.join(dir, 'anchor.db')) }
}

const MON = '2026-09-07' // 周一
const MON_10AM_S = userZonedTimeToUtc(MON, 600)

/** 初始化两套配置（管线会读日落配置计算宵禁上下文） */
function initConfigs(db: ReturnType<typeof createDb>): void {
  initSunsetConfig(db)
  initSchoolSchedule(db)
}

test('上学日校时段无真实交互 → 管线短路 away，不跑推断不产干预', async () => {
  const { dir, db } = tempDb('pipeline-away')
  resetPipelineState()
  try {
    initConfigs(db)
    const result = await runPipeline(db, { mode: 'full', nowMs: MON_10AM_S * 1000 })
    assert.equal(result.state, 'away')
    assert.equal(result.confidence, 1)
    assert.equal(result.do_not_disturb, true)
    assert.equal(result.needs_ai_arbitration, false)

    // full tick 写 user_living_context
    const ctx = db.select().from(userLivingContext).where(eq(userLivingContext.user_id, 'default')).get()
    assert.equal(ctx?.inferred_state, 'away')

    // 写 away 状态段
    const seg = db.select().from(stateSegments).where(isNull(stateSegments.ended_at)).get()
    assert.equal(seg?.state, 'away')
  } finally {
    resetPipelineState()
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('校时段内有真实交互 → 不短路，走正常推断（病假在家仍被观察）', async () => {
  const { dir, db } = tempDb('pipeline-away-strong')
  resetPipelineState()
  try {
    initConfigs(db)
    db.insert(behaviorLogs).values({
      source: 'chrome', event_type: 'url_visit',
      payload: { domain: 'bilibili.com', high_stimulus: true }, logged_at: MON_10AM_S - 60,
    }).run()
    const result = await runPipeline(db, { mode: 'lightweight', nowMs: MON_10AM_S * 1000 })
    assert.notEqual(result.state, 'away')
  } finally {
    resetPipelineState()
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('app_foreground 心跳不算真实交互 → 仍判 away', async () => {
  const { dir, db } = tempDb('pipeline-away-heartbeat')
  resetPipelineState()
  try {
    initConfigs(db)
    db.insert(behaviorLogs).values({
      source: 'android', event_type: 'app_foreground',
      payload: { package: 'com.android.launcher3' }, logged_at: MON_10AM_S - 60,
    }).run()
    const result = await runPipeline(db, { mode: 'lightweight', nowMs: MON_10AM_S * 1000 })
    assert.equal(result.state, 'away')
  } finally {
    resetPipelineState()
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('上学日但非校时段（晚间）→ 不短路 away', async () => {
  const { dir, db } = tempDb('pipeline-away-evening')
  resetPipelineState()
  try {
    initConfigs(db)
    const eveningS = userZonedTimeToUtc(MON, 1200) // 20:00
    const result = await runPipeline(db, { mode: 'lightweight', nowMs: eveningS * 1000 })
    assert.notEqual(result.state, 'away')
  } finally {
    resetPipelineState()
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('日程配置禁用 → 不短路 away', async () => {
  const { dir, db } = tempDb('pipeline-away-disabled')
  resetPipelineState()
  try {
    initConfigs(db)
    updateSchoolSchedule({ enabled: false })
    const result = await runPipeline(db, { mode: 'lightweight', nowMs: MON_10AM_S * 1000 })
    assert.notEqual(result.state, 'away')
  } finally {
    resetPipelineState()
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
