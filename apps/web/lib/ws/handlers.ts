import type { WebSocket } from 'ws'
import type { WsClientMessage, BehaviorSource, BehaviorEventType, InterventionAction } from '@anchor/types'
import type { Db } from '@anchor/db'
import { behaviorLogs, interventionLogs } from '@anchor/db'
import { and, eq, isNull } from 'drizzle-orm'
import { ingestBehavior } from '../inference/ingest'
import { getDb } from '../db'

function triggerImmediatePipeline(db: Db): void {
  import('../inference/pipeline')
    .then(m => m.runPipelineGuarded(db, { mode: 'lightweight', nowMs: Date.now() }))
    .catch(console.error)
}

export function recordActionResponse(
  db: Db,
  msg: { action_id: string; choice: string },
  loggedAt = Math.floor(Date.now() / 1000)
): void {
  db.insert(behaviorLogs).values({
    source: 'web',
    event_type: 'action_response',
    payload: { action_id: msg.action_id, choice: msg.choice },
    logged_at: loggedAt,
  }).run()

  triggerImmediatePipeline(db)
}

export function recordInterventionResult(
  db: Db,
  payload: {
    intervention_id: string
    action: InterventionAction
    result: 'executed' | 'dismissed' | 'expired'
    dismissed_by_user: boolean
    dismissed_after_ms?: number
  },
  loggedAt = Math.floor(Date.now() / 1000),
  source: BehaviorSource = 'android',
): void {
  db.insert(behaviorLogs).values({
    source,
    event_type: 'intervention_result',
    payload: { ...payload },
    logged_at: loggedAt,
  }).run()

  // 回填 intervention_logs.result（仅首个回执生效；未知 id 影响 0 行，容忍老计划）
  db.update(interventionLogs)
    .set({ result: payload.result })
    .where(and(eq(interventionLogs.intervention_id, payload.intervention_id), isNull(interventionLogs.result)))
    .run()
}

export function handleClientMessage(msg: WsClientMessage, ws: WebSocket) {
  switch (msg.type) {
    case 'ingest': {
      try {
        const db = getDb()
        // 手动点「睡了」走 WS ingest：与 REST 路径对齐，写 circadian_logs + 驱动睡眠状态机
        if (msg.event_type === 'sleep_start') {
          import('../circadian/wakeup').then(m => m.recordSleepStart()).catch(console.error)
          break
        }
        ingestBehavior(db, {
          source: msg.source as BehaviorSource,
          event_type: msg.event_type as BehaviorEventType,
          payload: msg.payload,
          logged_at: msg.logged_at ?? Math.floor(Date.now() / 1000),
          location_zone: msg.location_zone,
        })
      } catch (e) {
        console.error(`[ws] 处理 ingest 消息异常 source=${(msg as { source?: string }).source} event=${msg.event_type}:`, e)
      }
      break
    }
    case 'action:response': {
      const db = getDb()
      recordActionResponse(db, { action_id: msg.action_id, choice: msg.choice })
      break
    }
    case 'wakeup:verified': {
      handleWakeupVerified()
      break
    }
    case 'intervention:response': {
      const db = getDb()
      db.insert(behaviorLogs).values({
        source: 'android',
        event_type: 'intervention_response',
        payload: {
          level: (msg as Record<string,unknown>)['level'],
          choice: (msg as Record<string,unknown>)['choice'],
          detected_app: (msg as Record<string,unknown>)['detected_app'] ?? null,
        },
        logged_at: Math.floor(Date.now() / 1000),
      }).run()
      break
    }
    case 'intervention_result': {
      const db = getDb()
      recordInterventionResult(db, {
        intervention_id: msg.intervention_id,
        action: msg.action,
        result: msg.result,
        dismissed_by_user: msg.dismissed_by_user,
        dismissed_after_ms: msg.dismissed_after_ms,
      }, Math.floor(Date.now() / 1000), msg.source)
      break
    }
    case 'intent:submit': {
      handleIntentSubmit(msg as { type: 'intent:submit'; content: string; source?: 'bedtime' | 'wakeup' | 'focuslayer' | 'system'; date?: string; prompt_id?: string })
      break
    }
    case 'intent:capture-response': {
      import('../intention/anchor')
        .then(m => m.handleIntentCaptureResponse({
          prompt_id: msg.prompt_id,
          action: msg.action,
        }))
        .catch(console.error)
      break
    }
    case 'intent:input': {
      import('../intention/anchor')
        .then(m => m.handleIntentInput(msg.prompt_id))
        .catch(console.error)
      break
    }
    case 'intent:confirm': {
      handleIntentConfirm((msg as { type: 'intent:confirm'; date: string }).date)
      break
    }
    case 'sunset:breach': {
      const db = getDb()
      db.insert(behaviorLogs).values({
        source: 'android',
        event_type: 'curfew_breach',
        payload: { reason: (msg as Record<string, unknown>)['reason'] ?? null },
        logged_at: Math.floor(Date.now() / 1000),
      }).run()
      triggerImmediatePipeline(db)
      break
    }
    case 'sunset:release': {
      void handleSunsetRelease((msg as { type: 'sunset:release'; reason: string }).reason)
      break
    }
    case 'sleep:confirm-response': {
      handleSleepConfirmResponse()
      break
    }
    case 'wakeup:confirm-response': {
      handleWakeConfirmResponse(msg.confirmed === true)
      break
    }
    case 'context_switch:response': {
      const db = getDb()
      import('../decision/context-switch')
        .then(m => m.handleContextSwitchResponse(db, {
          prompt_id: msg.prompt_id,
          action: msg.action,
          text: msg.text,
          source: msg.source,
        }))
        .catch(console.error)
      break
    }
    case 'context_switch:input': {
      import('../decision/context-switch')
        .then(m => m.handleContextSwitchInput(msg.prompt_id))
        .catch(console.error)
      break
    }
    case 'app:update_classification': {
      void handleAppUpdateClassification(msg as any, ws)
      break
    }
    case 'app:delete_classification': {
      void handleAppDeleteClassification(msg as any, ws)
      break
    }
    case 'site:update_classification': {
      void handleSiteUpdateClassification(msg as any, ws)
      break
    }
    case 'site:delete_classification': {
      void handleSiteDeleteClassification(msg as any, ws)
      break
    }
    case 'process:update_classification': {
      void handleProcessUpdateClassification(msg as any, ws)
      break
    }
    case 'process:delete_classification': {
      void handleProcessDeleteClassification(msg as any, ws)
      break
    }
    case 'pong':
      break
    default:
      break
  }
}

async function handleWakeupVerified() {
  const { recordWakeup } = await import('../circadian/wakeup')
  recordWakeup()
}

async function handleSunsetRelease(reason: string) {
  const { releaseSunsetForce } = await import('../sleep/engine')
  const { broadcastSunsetConfigNow } = await import('./server')
  const db = getDb()
  await releaseSunsetForce(db, reason ?? '')
  // 释放后立即全量下发：全端同步解除
  await broadcastSunsetConfigNow()
}

function handleSleepConfirmResponse() {
  const db = getDb()
  import('../sleep/engine')
    .then(async m => {
      m.respondSleepConfirm(db)
      // 响应后 sleep_start_at 可能已修正，全量下发同步各端
      const { broadcastSunsetConfigNow } = await import('./server')
      await broadcastSunsetConfigNow()
    })
    .catch(console.error)
}

function handleWakeConfirmResponse(confirmed: boolean) {
  const db = getDb()
  import('../sleep/engine')
    .then(async m => {
      // 时钟相位：用当前分钟数与 sunset config 计算（与 checkSunsetPhase 同源），
      // 让 resolveWakeObserving 决定回 curfee（T0 带内）还是 cleared（带外）
      const { getSunsetConfig } = await import('../sunset/config')
      const { getSunsetPhase } = await import('../decision/sunset')
      const { getUserMinutesSinceMidnight } = await import('../time/user-time')
      const { predictSleepWindow, resolveSunsetAnchor } = await import('../sleep/pattern')
      const cfg = getSunsetConfig()
      const nowMs = Date.now()
      const nowS = Math.floor(nowMs / 1000)
      let clockPhase: 'T60' | 'T30' | 'T15' | 'T0' | null = null
      try {
        if (cfg.enabled) {
          const band = predictSleepWindow(db, nowMs)
          const anchor = resolveSunsetAnchor(db, nowMs, band)
          clockPhase = getSunsetPhase(getUserMinutesSinceMidnight(nowMs), anchor.startMinutes, cfg, anchor.endMinutes)
        }
      } catch { /* 保持 null（保守按 T0 带内处理） */ }
      m.respondWakeConfirm(db, nowS, confirmed, clockPhase)
      const { broadcastSunsetConfigNow } = await import('./server')
      await broadcastSunsetConfigNow()
    })
    .catch(console.error)
}

async function handleIntentSubmit(msg: { content: string; source?: 'bedtime' | 'wakeup' | 'focuslayer' | 'system'; date?: string; prompt_id?: string }) {
  const content = msg.content.trim()
  // 空内容直接忽略，不写库（防止客户端误提交占位/提示文本）
  if (!content) return

  const { dailyIntentions } = await import('@anchor/db')
  const db = getDb()
  const pad = (n: number) => String(n).padStart(2, '0')
  const d = new Date()
  const today = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  const date = msg.date ?? today
  const now = Math.floor(Date.now() / 1000)
  const source = msg.source ?? 'bedtime'

  const { eq } = await import('drizzle-orm')
  const existing = db
    .select()
    .from(dailyIntentions)
    .where(eq(dailyIntentions.date, date))
    .get()

  if (existing) {
    db.update(dailyIntentions)
      .set({ content })
      .where(eq(dailyIntentions.date, date))
      .run()
  } else {
    db.insert(dailyIntentions)
      .values({ date, content, source, created_at: now })
      .run()
  }

  // 跨端协调：关闭所有客户端的意图弹窗并清除重开入口
  const { notifyIntentSubmitted } = await import('../intention/anchor')
  notifyIntentSubmitted(msg.prompt_id)
}

async function handleIntentConfirm(date: string) {
  const { dailyIntentions } = await import('@anchor/db')
  const { eq } = await import('drizzle-orm')
  const db = getDb()
  const now = Math.floor(Date.now() / 1000)
  db.update(dailyIntentions)
    .set({ confirmed_at: now })
    .where(eq(dailyIntentions.date, date))
    .run()
}

// is_work 与 high_stimulus 互斥：is_work=true 时强制 high_stimulus=false
function normalizeClassification(msg: { high_stimulus?: boolean; is_work?: boolean }): { high: boolean; work: boolean } {
  const work = msg.is_work === true
  return { high: work ? false : msg.high_stimulus === true, work }
}

async function handleAppUpdateClassification(msg: { package_name: string; high_stimulus?: boolean; is_work?: boolean }, _ws: WebSocket): Promise<void> {
  const db = getDb()
  const { appClassifications } = await import('@anchor/db')
  const now = Math.floor(Date.now() / 1000)
  const { high, work } = normalizeClassification(msg)

  // upsert：与 REST /api/apps/classifications 的 onConflictDoUpdate 对齐，
  // WS 路径可能收到数据库中尚不存在的包名（如本地缓存来源的行被清理后），纯 UPDATE 会静默丢行
  db.insert(appClassifications)
    .values({
      package_name: msg.package_name,
      app_name: msg.package_name,
      high_stimulus: high,
      is_work: work,
      classification_source: 'user_manual',
      user_modified: true,
      reviewed: true,
      created_at: now,
      updated_at: now,
    })
    .onConflictDoUpdate({
      target: appClassifications.package_name,
      set: {
        high_stimulus: high,
        is_work: work,
        user_modified: true,
        reviewed: true,
        updated_at: now,
      },
    })
    .run()

  import('./server').then(m => m.broadcast({
    type: 'app:classification_updated',
    package_name: msg.package_name,
    high_stimulus: high,
    is_work: work,
  })).catch(console.error)
}

async function handleAppDeleteClassification(msg: { package_name: string }, _ws: WebSocket): Promise<void> {
  const db = getDb()
  const { appClassifications } = await import('@anchor/db')
  const { eq } = await import('drizzle-orm')

  db.delete(appClassifications)
    .where(eq(appClassifications.package_name, msg.package_name))
    .run()

  import('./server').then(m => m.broadcast({
    type: 'app:classification_deleted',
    package_name: msg.package_name,
  })).catch(console.error)
}

async function handleSiteUpdateClassification(msg: { domain: string; high_stimulus?: boolean; is_work?: boolean }, _ws: WebSocket): Promise<void> {
  const db = getDb()
  const { siteClassifications } = await import('@anchor/db')
  const { eq } = await import('drizzle-orm')
  const now = Math.floor(Date.now() / 1000)
  const { high, work } = normalizeClassification(msg)

  db.update(siteClassifications)
    .set({ high_stimulus: high, is_work: work, user_modified: true, updated_at: now })
    .where(eq(siteClassifications.domain, msg.domain))
    .run()

  import('./server').then(m => m.broadcast({
    type: 'site:classification_updated',
    domain: msg.domain,
    high_stimulus: high,
    is_work: work,
  })).catch(console.error)
}

async function handleSiteDeleteClassification(msg: { domain: string }, _ws: WebSocket): Promise<void> {
  const db = getDb()
  const { siteClassifications } = await import('@anchor/db')
  const { eq } = await import('drizzle-orm')

  db.delete(siteClassifications)
    .where(eq(siteClassifications.domain, msg.domain))
    .run()

  import('./server').then(m => m.broadcast({
    type: 'site:classification_deleted',
    domain: msg.domain,
  })).catch(console.error)
}

async function handleProcessUpdateClassification(msg: { process_name: string; high_stimulus?: boolean; is_work?: boolean }, _ws: WebSocket): Promise<void> {
  const db = getDb()
  const { processClassifications } = await import('@anchor/db')
  const { eq } = await import('drizzle-orm')
  const now = Math.floor(Date.now() / 1000)
  const { high, work } = normalizeClassification(msg)

  db.update(processClassifications)
    .set({ high_stimulus: high, is_work: work, user_modified: true, updated_at: now })
    .where(eq(processClassifications.process_name, msg.process_name.toLowerCase()))
    .run()

  import('./server').then(m => m.broadcast({
    type: 'process:classification_updated',
    process_name: msg.process_name.toLowerCase(),
    high_stimulus: high,
    is_work: work,
  })).catch(console.error)
}

async function handleProcessDeleteClassification(msg: { process_name: string }, _ws: WebSocket): Promise<void> {
  const db = getDb()
  const { processClassifications } = await import('@anchor/db')
  const { eq } = await import('drizzle-orm')

  db.delete(processClassifications)
    .where(eq(processClassifications.process_name, msg.process_name.toLowerCase()))
    .run()

  import('./server').then(m => m.broadcast({
    type: 'process:classification_deleted',
    process_name: msg.process_name.toLowerCase(),
  })).catch(console.error)
}
