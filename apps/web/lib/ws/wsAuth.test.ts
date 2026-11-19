// WS 认证门集成测试：真实 http server + ws 客户端连接 /ws。
// 测试直接种 devices 行验证门逻辑（任务 7 的 /api/pair 才负责签发）。
import assert from 'node:assert/strict'
import test, { after, before } from 'node:test'
import { createServer, type Server } from 'http'
import { createHash, randomBytes } from 'node:crypto'
import { AddressInfo } from 'net'
import WebSocket from 'ws'
import { devices, closeDb } from '@anchor/db'
import { cleanupDir, tempDbPath } from '../testUtils'
import { getDb, initDb } from '@/lib/db'
import { initSunsetConfig } from '@/lib/sunset/config'
import { initWsServer } from './server'

const { dir, dbPath } = tempDbPath('ws-auth-gate')
process.env.ANCHOR_DB_PATH = dbPath

let server: Server
let port = 0

/** 测试用短认证窗口，避免等 10s */
const AUTH_TIMEOUT_MS = 300

/**
 * 环境病理说明（Windows 同进程 loopback 特异性）：
 * 认证成功后服务器连发 auth_ok + config/stage/state 多帧，同进程 loopback 下
 * 「首帧后 await 再发帧」会使帧成批滞留（秒级）；生产为 Linux VPS 跨进程/跨机，无此现象。
 * 故本文件认证用例的 waitFor 超时放宽到 10s，并统一 terminate 客户端连接。
 */
const DELIVERY_TIMEOUT_MS = 10_000

/** 本文件创建的所有客户端连接，after() 里统一 terminate */
const testClients = new Set<WebSocket>()

before(async () => {
  const db = initDb()
  initSunsetConfig(db)
  server = createServer()
  initWsServer(server, { authTimeoutMs: AUTH_TIMEOUT_MS })
  await new Promise<void>(resolve => server.listen(0, () => resolve()))
  port = (server.address() as AddressInfo).port
})

after(async () => {
  // 先 terminate 所有客户端连接（升级后的 WS 连接不归 closeAllConnections 管，
  // 不 terminate 的话 server.close 会等连接自然结束，after() 挂起 ~110s）
  for (const ws of testClients) {
    try { ws.terminate() } catch { /* 已断开 */ }
  }
  testClients.clear()
  // 关掉 HTTP 层的 keep-alive 连接（node 18.2+；类型上可能不存在，防御式调用）
  ;(server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.()
  await new Promise<void>(resolve => server.close(() => resolve()))
  closeDb(getDb())
  cleanupDir(dir)
})

function connect(): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`)
    testClients.add(ws)
    ws.on('open', () => resolve(ws))
    ws.on('error', reject)
  })
}

/** 收集消息直到谓词满足或超时 */
function waitFor<T = { type: string }>(ws: WebSocket, pred: (m: T) => boolean, timeoutMs = 2000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('waitFor 超时')), timeoutMs)
    const onMsg = (raw: WebSocket.RawData) => {
      let m: T
      try { m = JSON.parse(raw.toString()) } catch { return }
      if (pred(m)) {
        clearTimeout(timer)
        ws.off('message', onMsg)
        resolve(m)
      }
    }
    ws.on('message', onMsg)
  })
}

function waitClose(ws: WebSocket, timeoutMs = 3000): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('waitClose 超时')), timeoutMs)
    ws.on('close', (code) => { clearTimeout(timer); resolve(code) })
  })
}

/** 种一行未撤销设备，返回明文 token */
function seedDevice(name: string): string {
  const token = randomBytes(24).toString('base64url')
  getDb().insert(devices).values({
    name,
    token_hash: createHash('sha256').update(token).digest('hex'),
    created_at: Math.floor(Date.now() / 1000),
    last_seen_at: null,
  }).run()
  return token
}

test('认证超时：不发 auth → 4408 关闭', async () => {
  const ws = await connect()
  const code = await waitClose(ws)
  assert.equal(code, 4408)
})

test('错误 token → auth_failed + 4401', async () => {
  const ws = await connect()
  const failedP = waitFor(ws, (m: { type: string }) => m.type === 'auth_failed')
  ws.send(JSON.stringify({ type: 'auth', token: 'not-a-real-token' }))
  await failedP
  const code = await waitClose(ws)
  assert.equal(code, 4401)
})

test('认证前发其他消息被忽略（连接不被关，直到超时）', async () => {
  const ws = await connect()
  ws.send(JSON.stringify({ type: 'pong' }))
  ws.send(JSON.stringify({ type: 'ingest', source: 'test', event_type: 'x', payload: {} }))
  // 稍等片刻确认连接仍开（无 close 事件），再等超时关闭
  await new Promise(resolve => setTimeout(resolve, 50))
  assert.equal(ws.readyState, WebSocket.OPEN)
  const code = await waitClose(ws)
  assert.equal(code, 4408)
})

test('正确 token → auth_ok + 后续消息可达 + last_seen_at 刷新', async () => {
  const token = seedDevice('测试设备')
  const ws = await connect()
  // 超时放宽到 10s：Windows 同进程 loopback 帧成批滞留的环境病理，生产无此问题（见文件头注释）
  const okP = waitFor<{ type: string; deviceId?: number }>(ws, m => m.type === 'auth_ok', DELIVERY_TIMEOUT_MS)
  ws.send(JSON.stringify({ type: 'auth', token }))
  const ok = await okP
  assert.equal(ok.deviceId, 1)

  // last_seen_at 已刷新
  const row = getDb().select().from(devices).all()[0]
  assert.ok(row.last_seen_at, 'last_seen_at 应被刷新')
  assert.ok(row.last_seen_at! > 0)

  // 认证后进 clients：广播 ping 能到达
  const pingP = waitFor(ws, m => m.type === 'ping', DELIVERY_TIMEOUT_MS)
  const { broadcast } = await import('./server')
  broadcast({ type: 'ping' })
  await pingP

  ws.close()
})

test('devices 表为空时（任务 7 前）任何 token 都失败——预期行为', async () => {
  getDb().delete(devices).run()
  const ws = await connect()
  const failedP = waitFor(ws, (m: { type: string }) => m.type === 'auth_failed')
  ws.send(JSON.stringify({ type: 'auth', token: 'whatever' }))
  await failedP
  assert.equal(await waitClose(ws), 4401)
})
