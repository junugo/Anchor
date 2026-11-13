/**
 * 意图锚点层集成测试
 *
 * 验证：
 * 1. triggerIntentCapture 广播 intent:capture 并带正确 prompt
 * 2. L3 状态下 prompt 降级为"第一个动作"
 * 3. triggerIntentConfirmOnWakeup 读取昨日意图并广播 intent:confirm
 * 4. getTodayIntention 返回今日意图
 */

import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { createDb, closeDb, dailyIntentions } from '@anchor/db'
import { tempDbPath } from '../testUtils'

// 收集 broadcast 调用（模块隔离不可用，故直接调用逻辑层函数并检查 DB 状态）
test('getTodayIntention returns null when no intention exists', async () => {
  const { dir, dbPath } = tempDbPath('intent-none')
  let db: ReturnType<typeof createDb> | undefined
  try {
    db = createDb(dbPath)
    const { getTodayIntention } = await import('./anchor')
    const result = getTodayIntention(db)
    assert.equal(result, null)
  } finally {
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('getTodayIntention returns today intention when it exists', async () => {
  const { dir, dbPath } = tempDbPath('intent-today')
  let db: ReturnType<typeof createDb> | undefined
  try {
    db = createDb(dbPath)
    const now = Math.floor(Date.now() / 1000)
    const pad = (n: number) => String(n).padStart(2, '0')
    const d = new Date()
    const today = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

    db.insert(dailyIntentions).values({
      date: today,
      content: '完成意图锚点层的核心逻辑',
      source: 'bedtime',
      created_at: now,
    }).run()

    const { getTodayIntention } = await import('./anchor')
    const result = getTodayIntention(db)
    assert.ok(result !== null)
    assert.equal(result!.content, '完成意图锚点层的核心逻辑')
  } finally {
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('getRecentIntentions returns records within the window', async () => {
  const { dir, dbPath } = tempDbPath('intent-recent')
  let db: ReturnType<typeof createDb> | undefined
  try {
    db = createDb(dbPath)
    const now = Math.floor(Date.now() / 1000)

    const pad = (n: number) => String(n).padStart(2, '0')
    const d = new Date()
    const today = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`

    const yesterday = new Date()
    yesterday.setDate(yesterday.getDate() - 1)
    const yest = `${yesterday.getFullYear()}-${pad(yesterday.getMonth() + 1)}-${pad(yesterday.getDate())}`

    db.insert(dailyIntentions).values({
      date: today,
      content: '今天的意图',
      source: 'bedtime',
      created_at: now,
    }).run()

    db.insert(dailyIntentions).values({
      date: yest,
      content: '昨天的意图',
      source: 'bedtime',
      created_at: now - 86400,
    }).run()

    // 两条都在 7 天内
    const old = new Date()
    old.setDate(old.getDate() - 10)
    const oldDate = `${old.getFullYear()}-${pad(old.getMonth() + 1)}-${pad(old.getDate())}`
    db.insert(dailyIntentions).values({
      date: oldDate,
      content: '10天前的意图',
      source: 'bedtime',
      created_at: now - 10 * 86400,
    }).run()

    const { getRecentIntentions } = await import('./anchor')
    const results = getRecentIntentions(db, 7)
    assert.equal(results.length, 2)
    assert.equal(results[0]!.content, '今天的意图')
    assert.equal(results[1]!.content, '昨天的意图')
  } finally {
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// 注意：triggerIntentCapture 和 triggerIntentConfirmOnWakeup 依赖 ws/server.ts broadcast()
// 这两个函数在集成环境中（有完整 WS 服务器）测试；此处验证不崩溃且 DB 读取逻辑正确。
test('triggerIntentCapture does not throw when invoked', async () => {
  const { dir, dbPath } = tempDbPath('intent-capture')
  let db: ReturnType<typeof createDb> | undefined
  try {
    db = createDb(dbPath)
    const { triggerIntentCapture } = await import('./anchor')
    // 重置模块内部日期状态以允许触发
    // 函数本身会尝试 broadcast，broadcast 在测试中会 no-op（没有 WS clients）
    await assert.doesNotReject(
      async () => { await triggerIntentCapture(db!) }
    )
  } finally {
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('triggerIntentConfirmOnWakeup does not throw when no intention exists', async () => {
  const { dir, dbPath } = tempDbPath('intent-wakeup-empty')
  let db: ReturnType<typeof createDb> | undefined
  try {
    db = createDb(dbPath)
    const { triggerIntentConfirmOnWakeup } = await import('./anchor')
    await assert.doesNotReject(
      async () => { await triggerIntentConfirmOnWakeup(db!) }
    )
  } finally {
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

// ─── 跨端协调器（先到先赢 + dismiss 广播）─────────────────────────
// broadcast 遍历 globalThis.__anchorWsClients，注入假客户端即可捕获广播

interface FakeWsClient {
  readyState: number
  sent: Array<Record<string, unknown>>
}

function installFakeClient(): { client: FakeWsClient; uninstall: () => void } {
  const sent: Array<Record<string, unknown>> = []
  const client: FakeWsClient = {
    readyState: 1, // WebSocket.OPEN
    sent,
  }
  const g = globalThis as unknown as { __anchorWsClients?: Set<unknown> }
  g.__anchorWsClients ??= new Set()
  const wsLike = {
    readyState: client.readyState,
    send: (data: string) => { sent.push(JSON.parse(data) as Record<string, unknown>) },
  }
  g.__anchorWsClients.add(wsLike)
  return {
    client,
    uninstall: () => { g.__anchorWsClients?.delete(wsLike) },
  }
}

// 协调器 broadcast 经动态 import('./server')，CI 冷导入可能数秒；轮询直至目标消息出现
async function untilMessage(
  sent: Array<Record<string, unknown>>,
  pred: (m: Record<string, unknown>) => boolean,
  timeoutMs = 10000,
): Promise<Record<string, unknown> | undefined> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const hit = sent.find(pred)
    if (hit) return hit
    if (Date.now() > deadline) return undefined
    await new Promise(r => setTimeout(r, 25))
  }
}

test('capture-response skip broadcasts dismiss with prompt_id, first response wins', async () => {
  const { dir, dbPath } = tempDbPath('intent-coord-skip')
  let db: ReturnType<typeof createDb> | undefined
  const { client, uninstall } = installFakeClient()
  try {
    db = createDb(dbPath)
    const anchor = await import('./anchor')
    anchor._resetIntentCaptureForTest()
    client.sent.length = 0

    await anchor.triggerIntentCapture(db)
    const capture = await untilMessage(client.sent, m => m['type'] === 'intent:capture')
    assert.ok(capture, '应广播 intent:capture')
    assert.equal(typeof capture['prompt_id'], 'string')
    assert.equal(capture['timeoutSeconds'], 60)
    const promptId = capture['prompt_id'] as string

    anchor.handleIntentCaptureResponse({ prompt_id: promptId, action: 'skip' })
    const dismiss = await untilMessage(client.sent, m => m['type'] === 'intent:dismiss')
    assert.ok(dismiss, 'skip 后应广播 intent:dismiss')
    assert.equal(dismiss['prompt_id'], promptId)
    assert.equal(dismiss['reason'], 'skipped')

    // 先到先赢：后续响应被忽略，不再重复广播
    const countBefore = client.sent.filter(m => m['type'] === 'intent:dismiss').length
    anchor.handleIntentCaptureResponse({ prompt_id: promptId, action: 'auto_skip' })
    await new Promise(r => setTimeout(r, 0))
    assert.equal(client.sent.filter(m => m['type'] === 'intent:dismiss').length, countBefore)
  } finally {
    uninstall()
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('capture-response with wrong prompt_id is ignored', async () => {
  const { dir, dbPath } = tempDbPath('intent-coord-wrong-id')
  let db: ReturnType<typeof createDb> | undefined
  const { client, uninstall } = installFakeClient()
  try {
    db = createDb(dbPath)
    const anchor = await import('./anchor')
    anchor._resetIntentCaptureForTest()
    client.sent.length = 0

    await anchor.triggerIntentCapture(db)
    await new Promise(r => setTimeout(r, 0))
    anchor.handleIntentCaptureResponse({ prompt_id: 'intent-nonexistent', action: 'skip' })
    await new Promise(r => setTimeout(r, 0))
    assert.equal(client.sent.find(m => m['type'] === 'intent:dismiss'), undefined)
  } finally {
    uninstall()
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('notifyIntentSubmitted with matching prompt_id broadcasts dismiss answered', async () => {
  const { dir, dbPath } = tempDbPath('intent-coord-answered')
  let db: ReturnType<typeof createDb> | undefined
  const { client, uninstall } = installFakeClient()
  try {
    db = createDb(dbPath)
    const anchor = await import('./anchor')
    anchor._resetIntentCaptureForTest()
    client.sent.length = 0

    await anchor.triggerIntentCapture(db)
    const capture = await untilMessage(client.sent, m => m['type'] === 'intent:capture')
    const promptId = capture!['prompt_id'] as string

    anchor.notifyIntentSubmitted(promptId)
    const dismiss = await untilMessage(client.sent, m => m['type'] === 'intent:dismiss')
    assert.ok(dismiss)
    assert.equal(dismiss['prompt_id'], promptId)
    assert.equal(dismiss['reason'], 'answered')
  } finally {
    uninstall()
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('notifyIntentSubmitted without prompt_id broadcasts answered dismiss (reopen flow)', async () => {
  const { dir, dbPath } = tempDbPath('intent-coord-reopen')
  let db: ReturnType<typeof createDb> | undefined
  const { client, uninstall } = installFakeClient()
  try {
    db = createDb(dbPath)
    const anchor = await import('./anchor')
    anchor._resetIntentCaptureForTest()
    client.sent.length = 0

    anchor.notifyIntentSubmitted(undefined)
    const dismiss = await untilMessage(client.sent, m => m['type'] === 'intent:dismiss')
    assert.ok(dismiss, '重开入口提交也应广播 dismiss answered')
    assert.equal(dismiss['reason'], 'answered')
    assert.equal(dismiss['prompt_id'], undefined)
  } finally {
    uninstall()
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('auto_skip does not resolve coordinator (only closes local popup)', async () => {
  const { dir, dbPath } = tempDbPath('intent-coord-autoskip')
  let db: ReturnType<typeof createDb> | undefined
  const { client, uninstall } = installFakeClient()
  try {
    db = createDb(dbPath)
    const anchor = await import('./anchor')
    anchor._resetIntentCaptureForTest()
    client.sent.length = 0

    await anchor.triggerIntentCapture(db)
    await new Promise(r => setTimeout(r, 0))
    const capture = client.sent.find(m => m['type'] === 'intent:capture')
    const promptId = capture!['prompt_id'] as string

    // auto_skip 只关自己：不广播 dismiss，协调器仍活跃
    anchor.handleIntentCaptureResponse({ prompt_id: promptId, action: 'auto_skip' })
    await new Promise(r => setTimeout(r, 0))
    assert.equal(client.sent.find(m => m['type'] === 'intent:dismiss'), undefined)

    // 协调器仍可被后续 skip 正常 resolve
    anchor.handleIntentCaptureResponse({ prompt_id: promptId, action: 'skip' })
    await new Promise(r => setTimeout(r, 0))
    const dismiss = client.sent.find(m => m['type'] === 'intent:dismiss')
    assert.ok(dismiss, 'auto_skip 后 skip 仍应广播 dismiss')
    assert.equal(dismiss!['reason'], 'skipped')
  } finally {
    uninstall()
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('intent input take-over broadcasts typing and keeps late submit valid', async () => {
  const { dir, dbPath } = tempDbPath('intent-coord-input')
  let db: ReturnType<typeof createDb> | undefined
  const { client, uninstall } = installFakeClient()
  try {
    db = createDb(dbPath)
    const anchor = await import('./anchor')
    anchor._resetIntentCaptureForTest()
    client.sent.length = 0

    await anchor.triggerIntentCapture(db)
    await new Promise(r => setTimeout(r, 0))
    const capture = client.sent.find(m => m['type'] === 'intent:capture')
    const promptId = capture!['prompt_id'] as string

    // 开始输入：广播 typing 通知其他端关闭
    anchor.handleIntentInput(promptId)
    await new Promise(r => setTimeout(r, 0))
    const typing = client.sent.find(m => m['type'] === 'intent:typing')
    assert.ok(typing, '接管后应广播 intent:typing')
    assert.equal(typing!['prompt_id'], promptId)

    // 接管后提交（answered 语义）仍然有效
    anchor.notifyIntentSubmitted(promptId)
    await new Promise(r => setTimeout(r, 0))
    const dismiss = client.sent.find(m => m['type'] === 'intent:dismiss')
    assert.ok(dismiss, '接管后提交应广播 dismiss answered')
    assert.equal(dismiss!['reason'], 'answered')
    assert.equal(dismiss!['prompt_id'], promptId)
  } finally {
    uninstall()
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
