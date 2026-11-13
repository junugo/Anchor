import type { IncomingMessage, Server } from 'http'
import { WebSocketServer, WebSocket } from 'ws'
import type { WsServerMessage, WsClientMessage, UserState, SunsetClearReason } from '@anchor/types'
import { unwrapBody, resolveDataKey, dataKeyFingerprint } from '@anchor/utils'
import { handleClientMessage } from './handlers'
import { getUserMinutesSinceMidnight } from '../time/user-time'

// Next.js API 路由（webpack 打包）与自定义 server（tsx 加载）是两套模块实例，
// 模块级状态不共享。clients 挂到 globalThis 保证全进程唯一，
// 否则路由里 broadcast 遍历的是空集合，消息永远发不出去。
const globalForWs = globalThis as unknown as { __anchorWsClients?: Set<WebSocket> }
const clients = (globalForWs.__anchorWsClients ??= new Set<WebSocket>())

export function initWsServer(server: Server) {
  const wss = new WebSocketServer({ server, path: '/ws' })

  // 记录服务器数据密钥指纹，便于排查客户端密钥不一致
  dataKeyFingerprint(resolveDataKey(process.env)).then(fp => {
    console.log('[ws] 数据密钥指纹:', fp)
  }).catch(() => { /* ignore */ })

  wss.on('connection', async (ws: WebSocket, _req: IncomingMessage) => {
    clients.add(ws)

    ws.on('message', async (raw) => {
      try {
        let msg: WsClientMessage = JSON.parse(raw.toString())
        // 加密上传：客户端对 ingest 消息加密（enc: true），解密后走正常处理；
        // 解密失败丢弃并告警；明文消息（旧客户端）原样兼容
        if ((msg as { enc?: boolean }).enc === true) {
          const plain = await unwrapBody(msg, resolveDataKey(process.env))
          if (plain === null) {
            const fp = await dataKeyFingerprint(resolveDataKey(process.env))
            console.warn(`[ws] ingest 解密失败（服务器密钥指纹 ${fp}）`)
            send(ws, { type: 'error', code: 'DECRYPT_FAILED', message: '密钥不匹配，请检查配置或下载最新客户端' })
            return
          }
          msg = JSON.parse(plain) as WsClientMessage
        }
        handleClientMessage(msg, ws)
      } catch { /* ignore malformed */ }
    })

    ws.on('close', () => clients.delete(ws))

    // 连接后下发配置和当前阶段，客户端断线重连时可恢复本地执行。
    send(ws, await buildSunsetConfigMessage())
    send(ws, await buildCurrentSunsetStageMessage())
    sendCurrentState(ws)
  })

  // Heartbeat: ping all clients every 30s to keep connections alive
  setInterval(() => {
    broadcast({ type: 'ping' })
  }, 30_000)
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
