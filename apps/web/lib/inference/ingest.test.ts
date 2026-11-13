import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { eq } from 'drizzle-orm'
import { behaviorLogs, closeDb, createDb, processClassifications, userLivingContext } from '@anchor/db'
import { applyIngestContext, ingestBehavior } from './ingest'
import { recordActionResponse, recordInterventionResult } from '../ws/handlers'

// 管线已由 ../test-setup.ts（--import 全局前置）禁用，此处无需重复处理

function tempDbPath(name: string): { dir: string; dbPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `anchor-${name}-`))
  return { dir, dbPath: path.join(dir, 'anchor.db') }
}

test('applyIngestContext updates location_zone without changing inferred state', () => {
  const { dir, dbPath } = tempDbPath('ingest-context')
  const db = createDb(dbPath)
  try {
    db.insert(userLivingContext).values({
      user_id: 'default',
      inferred_state: 'working',
      location_zone: 'desk',
      screen_active: true,
      updated_at: 10,
    }).run()

    applyIngestContext(db, { location_zone: 'bed', logged_at: 20 })

    const row = db.select().from(userLivingContext).where(eq(userLivingContext.user_id, 'default')).get()
    assert.equal(row?.location_zone, 'bed')
    assert.equal(row?.screen_active, true)
    assert.equal(row?.inferred_state, 'working')
    assert.equal(row?.updated_at, 20)
  } finally {
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('recordActionResponse logs a web action_response behavior event', () => {
  const { dir, dbPath } = tempDbPath('action-response')
  const db = createDb(dbPath)
  try {
    recordActionResponse(db, { action_id: 'drink-water', choice: 'done' }, 30)

    const row = db.select().from(behaviorLogs).where(eq(behaviorLogs.event_type, 'action_response')).get()
    assert.equal(row?.source, 'web')
    assert.deepEqual(row?.payload, { action_id: 'drink-water', choice: 'done' })
    assert.equal(row?.logged_at, 30)
  } finally {
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('recordInterventionResult logs an intervention_result event', () => {
  const { dir, dbPath } = tempDbPath('iv-result')
  const db = createDb(dbPath)
  try {
    recordInterventionResult(db, {
      intervention_id: 'iv-1', action: 'android:fullscreen_block',
      result: 'dismissed', dismissed_by_user: true, dismissed_after_ms: 3000,
    }, 50)
    const row = db.select().from(behaviorLogs).where(eq(behaviorLogs.event_type, 'intervention_result')).get()
    assert.equal(row?.source, 'android')
    assert.equal((row?.payload as Record<string, unknown>)['result'], 'dismissed')
    assert.equal(row?.logged_at, 50)
  } finally {
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('recordInterventionResult uses provided source instead of default', () => {
  const { dir, dbPath } = tempDbPath('iv-result-desktop')
  const db = createDb(dbPath)
  try {
    recordInterventionResult(db, {
      intervention_id: 'iv-2', action: 'desktop:topmost_window',
      result: 'executed', dismissed_by_user: false,
    }, 100, 'desktop')
    const row = db.select().from(behaviorLogs).where(eq(behaviorLogs.event_type, 'intervention_result')).get()
    assert.equal(row?.source, 'desktop')
    assert.equal((row?.payload as Record<string, unknown>)['result'], 'executed')
    assert.equal((row?.payload as Record<string, unknown>)['intervention_id'], 'iv-2')
    assert.equal(row?.logged_at, 100)
  } finally {
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// 分类是异步 fire-and-forget（动态 import 分类模块 + 无 API key 时立即 fallback）；
// CI 上冷导入可能超过固定 sleep，轮询直至结算（行出现且 source 不再是 pending）。
// 宽限 500ms：ingest 并行的 dev:signal 广播 / maybeImmediatePipeline 冷导入尾巴
// 会在结算前后落地，不能让测试在它们碰 DB 前关闭连接
async function waitClassificationSettled(
  db: ReturnType<typeof createDb>,
  name: string,
  timeoutMs = 10000,
): Promise<{ classification_source: string } | undefined> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const row = db.select().from(processClassifications)
      .where(eq(processClassifications.process_name, name)).get()
    // 注意：行尚未插入（undefined）不算结算——插入前链路还要冷导入 ws/server
    if (row && row.classification_source !== 'pending') {
      await new Promise(r => setTimeout(r, 500))
      return row
    }
    if (Date.now() > deadline) {
      return db.select().from(processClassifications)
        .where(eq(processClassifications.process_name, name)).get()
    }
    await new Promise(r => setTimeout(r, 50))
  }
}

test('ingestBehavior auto-registers desktop window_focus process into process_classifications', async () => {
  const { dir, dbPath } = tempDbPath('ingest-proc-register')
  const db = createDb(dbPath)
  try {
    ingestBehavior(db, {
      source: 'desktop',
      event_type: 'window_focus',
      payload: { process: 'Code.exe', window_title: 'main.ts', duration_ms: 5000, is_idle: false },
      logged_at: 100,
    })

    const row = await waitClassificationSettled(db, 'code.exe')
    assert.ok(row, 'expected code.exe to be registered')
    assert.equal(row.classification_source, 'fallback')
  } finally {
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('ingestBehavior auto-registers desktop window_active process into process_classifications', async () => {
  const { dir, dbPath } = tempDbPath('ingest-proc-register-active')
  const db = createDb(dbPath)
  try {
    ingestBehavior(db, {
      source: 'desktop',
      event_type: 'window_active',
      payload: { process: 'Code.exe', window_title: 'main.ts' },
      logged_at: 100,
    })

    const row = await waitClassificationSettled(db, 'code.exe')
    assert.ok(row, 'expected code.exe to be registered')
    assert.equal(row.classification_source, 'fallback')
  } finally {
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('ingestBehavior skips process registration for idle settlements and replay', async () => {
  const { dir, dbPath } = tempDbPath('ingest-proc-skip')
  const db = createDb(dbPath)
  try {
    ingestBehavior(db, {
      source: 'desktop',
      event_type: 'window_focus',
      payload: { process: 'Code.exe', duration_ms: 5000, is_idle: true },
      logged_at: 100,
    })
    ingestBehavior(db, {
      source: 'desktop',
      event_type: 'window_focus',
      payload: { process: 'Code.exe', duration_ms: 5000, is_idle: false },
      logged_at: 90,
    }, { replay: true })
    await new Promise(r => setTimeout(r, 200))

    const rows = db.select().from(processClassifications).all()
    assert.equal(rows.length, 0)
  } finally {
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('recordInterventionResult with chrome source persists correctly', () => {
  const { dir, dbPath } = tempDbPath('iv-result-chrome')
  const db = createDb(dbPath)
  try {
    recordInterventionResult(db, {
      intervention_id: 'iv-3', action: 'chrome:hard_block',
      result: 'expired', dismissed_by_user: false, dismissed_after_ms: 60000,
    }, 200, 'chrome')
    const row = db.select().from(behaviorLogs).where(eq(behaviorLogs.event_type, 'intervention_result')).get()
    assert.equal(row?.source, 'chrome')
    assert.equal((row?.payload as Record<string, unknown>)['result'], 'expired')
    assert.equal((row?.payload as Record<string, unknown>)['dismissed_after_ms'], 60000)
    assert.equal(row?.logged_at, 200)
  } finally {
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
