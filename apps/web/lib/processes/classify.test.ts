import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { eq } from 'drizzle-orm'
import { closeDb, createDb, processClassifications } from '@anchor/db'
import { classifyProcess, isIgnoredProcess } from './classify'

function tempDb(name: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `anchor-${name}-`))
  return { dir, db: createDb(path.join(dir, 'anchor.db')) }
}

test('isIgnoredProcess filters system noise processes', () => {
  assert.equal(isIgnoredProcess('explorer.exe'), true)
  assert.equal(isIgnoredProcess('LockApp.exe'), true)
  assert.equal(isIgnoredProcess('Code.exe'), false)
})

test('classifyProcess inserts new process and falls back without API key', async () => {
  const { dir, db } = tempDb('proc-classify')
  try {
    // 测试环境无 DEEPSEEK_API_KEY：走 fallback（Windows 进程宁缺毋滥，两者均 false）
    const result = await classifyProcess(db, 'Code.EXE')
    assert.ok(result)
    assert.equal(result.process_name, 'code.exe') // 小写归一
    assert.equal(result.source, 'fallback')
    assert.equal(result.high_stimulus, false)
    assert.equal(result.is_work, false)

    const row = db.select().from(processClassifications)
      .where(eq(processClassifications.process_name, 'code.exe')).get()
    assert.ok(row)
    assert.equal(row.classification_source, 'fallback')
  } finally {
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('classifyProcess returns existing classification without reclassifying', async () => {
  const { dir, db } = tempDb('proc-existing')
  try {
    const now = Math.floor(Date.now() / 1000)
    db.insert(processClassifications).values({
      process_name: 'idea64.exe',
      display_name: 'idea64.exe',
      high_stimulus: false,
      is_work: true,
      classification_source: 'user_manual',
      user_modified: true,
      created_at: now,
      updated_at: now,
    }).run()

    const result = await classifyProcess(db, 'IDEA64.exe')
    assert.ok(result)
    assert.equal(result.is_work, true)
    assert.equal(result.source, 'user_manual')
  } finally {
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('classifyProcess ignores system noise processes', async () => {
  const { dir, db } = tempDb('proc-ignored')
  try {
    const result = await classifyProcess(db, 'explorer.exe')
    assert.equal(result, null)
    const rows = db.select().from(processClassifications).all()
    assert.equal(rows.length, 0)
  } finally {
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
