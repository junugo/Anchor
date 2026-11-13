import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { eq } from 'drizzle-orm'
import { closeDb, createDb, userMemory } from '@anchor/db'
import { analyzeWeek, persistMemory } from './weekly-analyzer'
import type { WeekRow } from './weekly-analyzer'

function row(p: Partial<WeekRow> & { date: string }): WeekRow {
  return {
    date: p.date,
    peak_distraction_hour: p.peak_distraction_hour ?? null,
    peak_work_hour: p.peak_work_hour ?? null,
    intervention_dismiss_rate: p.intervention_dismiss_rate ?? null,
    dissociation_count: p.dissociation_count ?? null,
    deep_work_total_ms: p.deep_work_total_ms ?? null,
  }
}

test('analyzeWeek 找出高风险分心时段', () => {
  const rows: WeekRow[] = [
    row({ date: '2026-06-10', peak_distraction_hour: 22 }),
    row({ date: '2026-06-11', peak_distraction_hour: 22 }),
    row({ date: '2026-06-12', peak_distraction_hour: 23 }),
    row({ date: '2026-06-13', peak_distraction_hour: 22 }),
  ]
  const mem = analyzeWeek(rows)
  assert.ok(mem.highRiskHours.includes(22))
})

test('analyzeWeek 标记高忽略率干预', () => {
  const rows: WeekRow[] = [
    row({ date: '2026-06-10', intervention_dismiss_rate: 0.8 }),
    row({ date: '2026-06-11', intervention_dismiss_rate: 0.75 }),
  ]
  const mem = analyzeWeek(rows)
  assert.equal(mem.highDismissal, true)
})

test('analyzeWeek 检测最近 3 天解离上升趋势', () => {
  const rows: WeekRow[] = [
    row({ date: '2026-06-11', dissociation_count: 2 }),
    row({ date: '2026-06-12', dissociation_count: 4 }),
    row({ date: '2026-06-13', dissociation_count: 7 }),
  ]
  const mem = analyzeWeek(rows)
  assert.equal(mem.dissociationRising, true)
})

test('analyzeWeek 空数据返回安全默认值', () => {
  const mem = analyzeWeek([])
  assert.deepEqual(mem.highRiskHours, [])
  assert.equal(mem.highDismissal, false)
  assert.equal(mem.dissociationRising, false)
  // onboardingDays 占位值为 0，由 memory-loader 覆盖为真实天数
  assert.equal(mem.onboardingDays, 0)
})

test('persistMemory 把 InferenceMemory 写入 user_memory KV 表', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-weekly-'))
  const db = createDb(path.join(dir, 'anchor.db'))
  try {
    const mem = analyzeWeek([
      row({ date: '2026-06-10', peak_distraction_hour: 22, intervention_dismiss_rate: 0.8 }),
      row({ date: '2026-06-11', peak_distraction_hour: 22, intervention_dismiss_rate: 0.75 }),
    ])
    persistMemory(db, mem, 1781956800)

    // 验证 dissociation_pattern 写入正确
    const patternRow = db
      .select()
      .from(userMemory)
      .where(eq(userMemory.key, 'dissociation_pattern'))
      .get()
    assert.ok(patternRow, '应存在 dissociation_pattern 行')
    const pattern = JSON.parse(patternRow!.value) as { high_risk_hours: number[] }
    assert.ok(pattern.high_risk_hours.includes(22))

    // 验证 response_to_intervention 写入正确
    const interventionRow = db
      .select()
      .from(userMemory)
      .where(eq(userMemory.key, 'response_to_intervention'))
      .get()
    assert.ok(interventionRow, '应存在 response_to_intervention 行')
    const intervention = JSON.parse(interventionRow!.value) as {
      high_dismissal: boolean
      avg_dismiss_rate: number
    }
    assert.equal(intervention.high_dismissal, true, 'avgDismissRate=0.775 应判定为 high_dismissal')
    assert.ok(intervention.avg_dismiss_rate > 0.7)
  } finally {
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
