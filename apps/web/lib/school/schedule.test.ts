import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { closeDb, createDb, schoolSchedule } from '@anchor/db'
import { eq } from 'drizzle-orm'
import { getSchoolContext, initSchoolSchedule, isSchoolDayFor, updateSchoolSchedule } from './schedule'
import { userZonedTimeToUtc } from '../time/user-time'

function tempDb(name: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `anchor-${name}-`))
  return { dir, db: createDb(path.join(dir, 'anchor.db')) }
}

const MON = '2026-09-07' // 周一
const SUN = '2026-09-06' // 周日
const MON_10AM = userZonedTimeToUtc(MON, 600) * 1000

test('initSchoolSchedule 播种默认单行（启用、周一~周五、07:00–17:30、起床 06:50）', () => {
  const { dir, db } = tempDb('school-seed')
  try {
    initSchoolSchedule(db)
    const row = db.select().from(schoolSchedule).get()
    assert.ok(row)
    assert.equal(row.enabled, true)
    assert.equal(row.days_mask, 31)
    assert.equal(row.leave_minute, 420)
    assert.equal(row.home_minute, 1050)
    assert.equal(row.wake_estimate_minute, 410)
  } finally {
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('getSchoolContext：上学日校时段内 inSchoolHours=true，其余 false', () => {
  const { dir, db } = tempDb('school-hours')
  try {
    initSchoolSchedule(db)
    const inHours = getSchoolContext(db, MON_10AM)
    assert.equal(inHours?.isSchoolDay, true)
    assert.equal(inHours?.inSchoolHours, true)
    assert.equal(inHours?.wakeEstimateAtS, userZonedTimeToUtc(MON, 410))

    // 上学日但未到出门时间
    const early = getSchoolContext(db, userZonedTimeToUtc(MON, 360) * 1000)
    assert.equal(early?.isSchoolDay, true)
    assert.equal(early?.inSchoolHours, false)

    // 上学日但已到家（17:30 边界不含）
    const late = getSchoolContext(db, userZonedTimeToUtc(MON, 1050) * 1000)
    assert.equal(late?.inSchoolHours, false)

    // 周日不是上学日
    const sunday = getSchoolContext(db, userZonedTimeToUtc(SUN, 600) * 1000)
    assert.equal(sunday?.isSchoolDay, false)
    assert.equal(sunday?.inSchoolHours, false)
  } finally {
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('getSchoolContext：配置禁用时返回 null', () => {
  const { dir, db } = tempDb('school-disabled')
  try {
    initSchoolSchedule(db)
    updateSchoolSchedule({ enabled: false })
    assert.equal(getSchoolContext(db, MON_10AM), null)
  } finally {
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('isSchoolDayFor：exceptions 单日覆盖与学期范围', () => {
  const { dir, db } = tempDb('school-exceptions')
  try {
    initSchoolSchedule(db)
    const cfg = db.select().from(schoolSchedule).get()!

    // exceptions：周一调休放假 / 周日补课
    const withEx = { ...cfg, exceptions: { [MON]: 'off' as const, [SUN]: 'school' as const } }
    assert.equal(isSchoolDayFor(withEx, MON, 1), false)
    assert.equal(isSchoolDayFor(withEx, SUN, 0), true)

    // 学期范围之外不算上学日
    const term = { ...cfg, exceptions: {}, term_start: '2026-10-01', term_end: null }
    assert.equal(isSchoolDayFor(term, MON, 1), false)
  } finally {
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('updateSchoolSchedule 更新单行并失效缓存', () => {
  const { dir, db } = tempDb('school-update')
  try {
    initSchoolSchedule(db)
    const updated = updateSchoolSchedule({ leave_minute: 435, term_start: '2026-08-31' })
    assert.equal(updated.leave_minute, 435)
    assert.equal(updated.term_start, '2026-08-31')
    const row = db.select().from(schoolSchedule).where(eq(schoolSchedule.id, 1)).get()
    assert.equal(row?.leave_minute, 435)
  } finally {
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
