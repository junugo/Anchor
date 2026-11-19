import type { IncomingMessage, Server } from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import type { WsServerMessage, WsClientMessage, UserState, SunsetClearReason } from '@anchor/types'
import { unwrapBody, dataKeyFingerprint } from '@anchor/utils'
import { eq } from 'drizzle-orm'
import { devices } from '@anchor/db'
import { handleClientMessage } from './handlers'
import { getUserMinutesSinceMidnight } from '../time/user-time'
import { getDb } from '../db'
import { verifyDeviceToken } from '../auth/device-token'
import { getDataKey } from '../data-key'

// Next.js API 路由（webpack 打包）与自定义 server（tsx 加载）是两套模块实例，
// 模块级状态不共享。clients 挂到 globalThis 保证全进程唯一，
// 否则路由里 broadcast 遍历的是空集合，消息永远发不出去。
const globalForWs = globalThis as unknown as { __anchorWsClients?: Set<WebSocket> }
const clients = (globalForWs.__anchorWsClients ??= new Set<WebSocket>())

/** 已认证连接上挂的设备信息（认证成功后填充，广播/日志可用） */
interface WsWithDevice extends WebSocket {
  deviceId?: number
  deviceName?: string
}

// 认证超时默认 10s；测试可注入更短值
const DEFAULT_AUTH_TIMEOUT_MS = 10_000

export function initWsServer(server: Server, options?: { authTimeoutMs?: number }) {
  const wss = new WebSocketServer({ server, path: '/ws' })
  const authTimeoutMs = options?.authTimeoutMs ?? DEFAULT_AUTH_TIMEOUT_MS

  // 数据密钥指纹在 server.ts 启动流程统一打印（解析一次 + 缓存），此处不再重复

  wss.on('connection', async (ws: WsWithDevice, _req: IncomingMessage) => {
    // 低延迟遥测：禁用 Nagle，避免 Windows loopback 上多帧小消息被粘包延迟
    // （认证后 auth_ok + config/stage/state 连发，Nagle+delayed ACK 可滞留数百 ms 至数秒）
    ;(ws as unknown as { _socket: { setNoDelay(noDelay?: boolean): void } })._socket.setNoDelay(true)

    // 认证门：连接后不立即视为已认证，仅处理 {type:'auth'}；超时未认证关闭（4408，与 4401 认证失败区分）
    let authed = false
    const authTimer = setTimeout(() => {
      if (!authed) {
        console.log('[ws] 认证超时（未在时限内收到 auth）')
        ws.close(4408)
      }
    }, authTimeoutMs)

    ws.on('message', async (raw) => {
      try {
        let msg: WsClientMessage = JSON.parse(raw.toString())

        // 认证消息优先处理（明文控制消息，不走加密信封）
        if ((msg as { type?: string }).type === 'auth') {
          const { token } = msg as unknown as { type: 'auth'; token: string }
          const device = typeof token === 'string' ? verifyDeviceToken(getDb(), token) : null
          if (device) {
            authed = true
            clearTimeout(authTimer)
            ws.deviceId = device.deviceId
            ws.deviceName = device.name
            clients.add(ws)
            // 刷新设备活跃时间
            getDb().update(devices)
              .set({ last_seen_at: Math.floor(Date.now() / 1000) })
              .where(eq(devices.id, device.deviceId))
              .run()
            send(ws, { type: 'auth_ok', deviceId: device.deviceId })
            // 认证成功后再下发配置/阶段/当前状态，客户端断线重连时可恢复本地执行
            send(ws, await buildSunsetConfigMessage())
            send(ws, await buildCurrentSunsetStageMessage())
            sendCurrentState(ws)
          } else {
            // 帧序加固：send 完成回调里再 close，避免 close 帧先于 auth_failed 到达客户端
            ws.send(JSON.stringify({ type: 'auth_failed' } satisfies WsServerMessage), () => ws.close(4401))
          }
          return
        }

        // 认证前其余消息一律忽略（不打日志，防刷）
        if (!authed) return

        // 加密上传：客户端对 ingest 消息加密（enc: true），解密后走正常处理；
        // 解密失败丢弃并告警；明文消息（旧客户端）原样兼容
        if ((msg as { enc?: boolean }).enc === true) {
          const plain = await unwrapBody(msg, getDataKey())
          if (plain === null) {
            const fp = await dataKeyFingerprint(getDataKey())
            console.warn(`[ws] ingest 解密失败（服务器密钥指纹 ${fp}）`)
            send(ws, { type: 'error', code: 'DECRYPT_FAILED', message: '密钥不匹配，请检查配置或下载最新客户端' })
            return
          }
          msg = JSON.parse(plain) as WsClientMessage
        }
        handleClientMessage(msg, ws)
      } catch { /* ignore malformed */ }
    })

    ws.on('close', () => {
      clearTimeout(authTimer)
      clients.delete(ws)
    })
  })

  // Heartbeat: ping all clients every 30s to keep connections alive
  const heartbeat = setInterval(() => {
    broadcast({ type: 'ping' })
  }, 30_000)
  // 不阻塞进程退出（测试进程无 server.listen 的引用时也能自然结束）
  heartbeat.unref()
}

export function broadcast(msg: WsServerMessage) {
  const data = JSON.stringify(msg)
  for (const ws of clients) {
    if (ws.readyState === WebSocket.OPEN) ws.send(data)
  }
}

export function send(ws: WebSocket, msg: WsServerMessage) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg))
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function buildSunsetConfigMessage(): Promise<any> {
  const { getSunsetConfig } = await import('../sunset/config')
  const { computeProgressiveBedtime } = await import('../circadian/sleep')
  const { getDb } = await import('../db')
  const config = getSunsetConfig()
  const progressiveBedtime = computeProgressiveBedtime(getDb())
  // 高刺激域名不下发：客户端统一以 site_classifications 缓存为准（seedFromServer + 广播）
  const { high_stimulus_sites: _deprecated, ...configWithoutSites } = config
  return { type: 'sunset:config', config: { ...configWithoutSites, progressive_bedtime: progressiveBedtime } }
}

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
async function buildCurrentSunsetStageMessage(): Promise<any> {
  const { getSunsetConfig } = await import('../sunset/config')
  const { getSunsetPhase, getSunsetBedtimeAt, computeSunsetExpiresAt } = await import('../decision/sunset')
  const { computeCurrentSunsetStage } = await import('../sleep/engine')
  const { predictSleepWindow, resolveSunsetAnchor } = await import('../sleep/pattern')
  const { getDb } = await import('../db')
  const config = getSunsetConfig()
  const nowMs = Date.now()
  const nowMinutes = getUserMinutesSinceMidnight(nowMs)
  const receivedAt = Math.floor(nowMs / 1000)

  // 与 tick 广播、/api/status 同一真相：会话驱动的统一相位计算
  // T0 锚定自适应预测睡眠带；无历史回退静态 target_bedtime
  let stage: 'T60' | 'T30' | 'T15' | 'T0' | 'off' = 'off'
  let sleepStartedAt: number | undefined
  let clearReason: SunsetClearReason | undefined
  let target = config.target_bedtime_minutes
  try {
    const db = getDb()
    const anchor = resolveSunsetAnchor(db, nowMs, predictSleepWindow(db, nowMs))
    target = anchor.startMinutes
    const bedtimeAt = getSunsetBedtimeAt(nowMs, target)
    const clockPhase = config.enabled ? getSunsetPhase(nowMinutes, target, config, anchor.endMinutes) : null
    const snapshot = computeCurrentSunsetStage(db, clockPhase, receivedAt)
    stage = snapshot.stage
    sleepStartedAt = snapshot.session.sleep_start_at ?? undefined
    clearReason = snapshot.session.clear_reason ?? undefined
    return {
      type: 'sunset:stage',
      stage,
      received_at: receivedAt,
      expires_at: computeSunsetExpiresAt(stage, sleepStartedAt != null ? { sleep_start_at: sleepStartedAt } : null, bedtimeAt, receivedAt),
      target_bedtime_minutes: target,
      bedtime_at: bedtimeAt,
      sleep_started_at: sleepStartedAt,
      clear_reason: clearReason,
    }
  } catch {
    // 会话表不可用时退回纯时钟
    const bedtimeAt = getSunsetBedtimeAt(nowMs, target)
    const clockPhase = config.enabled ? getSunsetPhase(nowMinutes, target, config) : null
    stage = clockPhase ?? 'off'
    return {
      type: 'sunset:stage',
      stage,
      received_at: receivedAt,
      expires_at: computeSunsetExpiresAt(stage, null, bedtimeAt, receivedAt),
      target_bedtime_minutes: target,
      bedtime_at: bedtimeAt,
    }
  }
}

/** 配置变更后立即全量下发：新配置 + 按新配置重算的当前阶段，客户端无需等下一个 tick */
export async function broadcastSunsetConfigNow() {
  broadcast(await buildSunsetConfigMessage())
  broadcast(await buildCurrentSunsetStageMessage())
}

async function sendCurrentState(ws: WebSocket) {
  const { getDb } = await import('../db')
  const { userLivingContext } = await import('@anchor/db')
  const { eq } = await import('drizzle-orm')
  const db = getDb()
  const row = db
    .select()
    .from(userLivingContext)
    .where(eq(userLivingContext.user_id, 'default'))
    .get()
  if (row && row.inferred_state) {
    send(ws, { type: 'state:update', state: row.inferred_state as UserState, confidence: 0.8 })
  }
}
