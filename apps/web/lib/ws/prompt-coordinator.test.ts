/**
 * 通用弹窗协调器测试
 *
 * 验证 createPromptCoordinator 的核心语义：
 * 1. open 广播打开消息（携带 prompt_id / timeoutSeconds）
 * 2. 先到先赢：首个响应广播 dismiss，后续响应忽略
 * 3. 错误 prompt_id 的响应被忽略
 * 4. 新弹窗顶掉未解决的旧弹窗（旧按 expired 关闭）
 * 5. 兜底到期：timeout+grace 后广播 expired
 * 6. resolve/isActive 行为
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { createPromptCoordinator } from './prompt-coordinator'
import type { WsServerMessage } from '@anchor/types'

interface FakeWs {
  readyState: number
  sent: Array<Record<string, unknown>>
}

function installFakeClient(): { client: FakeWs; uninstall: () => void } {
  const sent: Array<Record<string, unknown>> = []
  const g = globalThis as unknown as { __anchorWsClients?: Set<unknown> }
  g.__anchorWsClients ??= new Set()
  const wsLike = {
    readyState: 1, // WebSocket.OPEN
    send: (data: string) => { sent.push(JSON.parse(data) as Record<string, unknown>) },
  }
  g.__anchorWsClients.add(wsLike)
  return {
    client: { readyState: 1, sent },
    uninstall: () => { g.__anchorWsClients?.delete(wsLike) },
  }
}

// 测试用协调器选项：短超时（1s）便于验证兜底到期
function testCoordinatorOptions(timeoutSeconds: number) {
  return {
    idPrefix: 'test',
    timeoutSeconds,
    makeOpenMessage: (promptId, timeoutSeconds, { text }): WsServerMessage => ({
      type: 'context_switch:prompt',
      prompt_id: promptId,
      timeoutSeconds,
      placeholder: text,
    }),
    makeDismissMessage: (promptId, reason): WsServerMessage => ({
      type: 'context_switch:dismiss',
      prompt_id: promptId,
      reason,
    }),
    makeTypingMessage: (promptId): WsServerMessage => ({
      type: 'context_switch:typing',
      prompt_id: promptId,
    }),
  }
}
function makeTestCoordinator() {
  return createPromptCoordinator<{ text: string }>(testCoordinatorOptions(1))
}

const tick = () => new Promise(r => setTimeout(r, 0))

// broadcast 经动态 import('./server')，CI 冷导入可能远超一拍；轮询直至送达
async function untilSent(client: FakeWs, count: number, timeoutMs = 10000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (client.sent.length < count && Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 25))
  }
}

test('open broadcasts open message with prompt_id and timeoutSeconds', async () => {
  const { client, uninstall } = installFakeClient()
  // 长超时：open 触发的 './server' 冷导入可能阻塞事件循环数秒，超过 1s 会导致
  // 兜底 expired 抢先结算（isActive=false、open 与 dismiss 同队），与广播语义无关
  const coord = createPromptCoordinator<{ text: string }>(testCoordinatorOptions(60))
  try {
    const promptId = coord.open({ text: '占位' })
    await untilSent(client, 1)
    assert.equal(client.sent.length, 1)
    const msg = client.sent[0]!
    assert.equal(msg['type'], 'context_switch:prompt')
    assert.equal(msg['prompt_id'], promptId)
    assert.equal(msg['timeoutSeconds'], 60)
    assert.equal(msg['placeholder'], '占位')
    assert.ok(promptId.startsWith('test-'))
    assert.ok(coord.isActive(promptId))
  } finally {
    coord._resetForTest()
    uninstall()
  }
})

test('first response wins, subsequent responses ignored', async () => {
  const { client, uninstall } = installFakeClient()
  const coord = makeTestCoordinator()
  try {
    const promptId = coord.open({ text: 'x' })
    await untilSent(client, 1)
    assert.equal(coord.handleResponse(promptId, 'answered'), true)
    await untilSent(client, 2) // open + dismiss
    const dismisses = client.sent.filter(m => m['type'] === 'context_switch:dismiss')
    assert.equal(dismisses.length, 1)
    assert.equal(dismisses[0]!['prompt_id'], promptId)
    assert.equal(dismisses[0]!['reason'], 'answered')
    assert.equal(coord.isActive(), false)

    assert.equal(coord.handleResponse(promptId, 'skipped'), false)
    await tick()
    assert.equal(client.sent.filter(m => m['type'] === 'context_switch:dismiss').length, 1)
  } finally {
    coord._resetForTest()
    uninstall()
  }
})

test('response with wrong prompt_id is ignored', async () => {
  const { client, uninstall } = installFakeClient()
  const coord = makeTestCoordinator()
  try {
    coord.open({ text: 'x' })
    await tick()
    assert.equal(coord.handleResponse('test-nonexistent', 'skipped'), false)
    await tick()
    assert.equal(client.sent.filter(m => m['type'] === 'context_switch:dismiss').length, 0)
    assert.ok(coord.isActive())
  } finally {
    coord._resetForTest()
    uninstall()
  }
})

test('new open replaces unresolved prompt with expired dismiss', async () => {
  const { client, uninstall } = installFakeClient()
  const coord = makeTestCoordinator()
  try {
    const first = coord.open({ text: 'first' })
    await untilSent(client, 1)
    const second = coord.open({ text: 'second' })
    await untilSent(client, 2) // 第二个 open + 第一个的 expired dismiss
    const dismisses = client.sent.filter(m => m['type'] === 'context_switch:dismiss')
    assert.equal(dismisses.length, 1)
    assert.equal(dismisses[0]!['prompt_id'], first)
    assert.equal(dismisses[0]!['reason'], 'expired')
    assert.ok(coord.isActive(second))
    // 旧 prompt 的响应不再被接受
    assert.equal(coord.handleResponse(first, 'answered'), false)
  } finally {
    coord._resetForTest()
    uninstall()
  }
})

test('server-side expiry broadcasts expired dismiss after timeout+grace', async () => {
  const { client, uninstall } = installFakeClient()
  const coord = makeTestCoordinator()
  try {
    const promptId = coord.open({ text: 'x' })
    await new Promise(r => setTimeout(r, 1100 + 5000 + 100)) // 1s timeout + 5s grace + 余量
    await untilSent(client, 2) // open + expired dismiss；CI 冷导入可能晚于上面的固定等待
    const dismisses = client.sent.filter(m => m['type'] === 'context_switch:dismiss')
    assert.equal(dismisses.length, 1)
    assert.equal(dismisses[0]!['prompt_id'], promptId)
    assert.equal(dismisses[0]!['reason'], 'expired')
    assert.equal(coord.isActive(), false)
  } finally {
    coord._resetForTest()
    uninstall()
  }
})

test('resolve is silent when nothing active', async () => {
  const { client, uninstall } = installFakeClient()
  const coord = makeTestCoordinator()
  try {
    coord.resolve('answered')
    await tick()
    assert.equal(client.sent.length, 0)
  } finally {
    coord._resetForTest()
    uninstall()
  }
})

test('input take-over broadcasts typing and stops server expiry', async () => {
  const { client, uninstall } = installFakeClient()
  const coord = makeTestCoordinator()
  try {
    const promptId = coord.open({ text: 'x' })
    await tick()
    assert.equal(coord.handleInput(promptId), true)
    await tick()
    const typings = client.sent.filter(m => m['type'] === 'context_switch:typing')
    assert.equal(typings.length, 1)
    assert.equal(typings[0]!['prompt_id'], promptId)

    // 接管后服务器不再过期：超过 timeout+grace 仍活跃
    await new Promise(r => setTimeout(r, 1100 + 5000 + 100))
    assert.ok(coord.isActive(promptId))

    // 接管后迟到提交仍然有效（15s 后提交不失效）
    assert.equal(coord.handleResponse(promptId, 'answered'), true)
    await tick()
    const dismisses = client.sent.filter(m => m['type'] === 'context_switch:dismiss')
    assert.equal(dismisses.length, 1)
    assert.equal(dismisses[0]!['reason'], 'answered')
  } finally {
    coord._resetForTest()
    uninstall()
  }
})

test('duplicate input is idempotent (single typing broadcast)', async () => {
  const { client, uninstall } = installFakeClient()
  const coord = makeTestCoordinator()
  try {
    const promptId = coord.open({ text: 'x' })
    await tick()
    assert.equal(coord.handleInput(promptId), true)
    assert.equal(coord.handleInput(promptId), true)
    await tick()
    assert.equal(client.sent.filter(m => m['type'] === 'context_switch:typing').length, 1)
  } finally {
    coord._resetForTest()
    uninstall()
  }
})

test('input with wrong prompt_id is ignored', async () => {
  const { client, uninstall } = installFakeClient()
  const coord = makeTestCoordinator()
  try {
    coord.open({ text: 'x' })
    await tick()
    assert.equal(coord.handleInput('test-nonexistent'), false)
    await tick()
    assert.equal(client.sent.filter(m => m['type'] === 'context_switch:typing').length, 0)
    assert.ok(coord.isActive())
  } finally {
    coord._resetForTest()
    uninstall()
  }
})
