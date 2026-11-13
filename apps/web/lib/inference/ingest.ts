import type { Db } from '@anchor/db'
import type { BehaviorSource, BehaviorEventType, LocationZone } from '@anchor/types'
import { behaviorLogs, userLivingContext } from '@anchor/db'
import { eq } from 'drizzle-orm'

export interface IngestPayload {
  source: BehaviorSource
  event_type: BehaviorEventType
  payload: Record<string, unknown>
  logged_at: number
  location_zone?: LocationZone
}

export function applyIngestContext(
  db: Db,
  data: { location_zone?: LocationZone; logged_at: number }
): void {
  if (!data.location_zone) return

  // Read current zone before updating to detect changes
  const prev = db.select({ location_zone: userLivingContext.location_zone })
    .from(userLivingContext).where(eq(userLivingContext.user_id, 'default')).get()

  db.insert(userLivingContext)
    .values({
      user_id: 'default',
      location_zone: data.location_zone,
      screen_active: true,
      updated_at: data.logged_at,
    })
    .onConflictDoUpdate({
      target: userLivingContext.user_id,
      set: {
        location_zone: data.location_zone,
        updated_at: data.logged_at,
      },
    })
    .run()

  // Broadcast env:switch when zone changes
  if (!prev || prev.location_zone !== data.location_zone) {
    const COLOR_TEMP: Record<string, number> = {
      desk: 5000, sofa: 2700, bed: 2700, transition: 4000, unknown: 4000,
    }
    import('../ws/server').then(m => m.broadcast({
      type: 'env:switch',
      zone: data.location_zone!,
      screen_color_temp: COLOR_TEMP[data.location_zone!] ?? 4000,
    })).catch(console.error)
  }
}

export interface IngestOptions {
  // 离线补发的历史事件：只落库，不更新实时上下文、不广播、不触发 pipeline
  replay?: boolean
}

export function ingestBehavior(db: Db, data: IngestPayload, opts: IngestOptions = {}): void {
  if (opts.replay) {
    try {
      db.insert(behaviorLogs).values({
        source: data.source,
        event_type: data.event_type,
        payload: data.payload,
        logged_at: data.logged_at,
      }).run()
    } catch (e) {
      console.error(`[ingest] replay 写入失败 source=${data.source} event=${data.event_type} logged_at=${data.logged_at}:`, e)
    }
    return
  }

  try {
    applyIngestContext(db, data)
  } catch (e) {
    // 上下文更新失败不应阻塞行为日志写入
    console.error(`[ingest] applyIngestContext 失败 source=${data.source} event=${data.event_type} logged_at=${data.logged_at}:`, e)
  }

  let insertedId: number | null = null
  try {
    const result = db.insert(behaviorLogs).values({
      source: data.source,
      event_type: data.event_type,
      payload: data.payload,
      logged_at: data.logged_at,
    }).run() as { lastInsertRowid: number }
    insertedId = Number(result.lastInsertRowid)
    console.log(`[ingest] 写入成功 id=${insertedId} source=${data.source} event=${data.event_type} logged_at=${data.logged_at}`)

    // 立即回查验证：排除 WAL/事务未提交或写入到其他连接的幻觉
    const verify = db.select({ id: behaviorLogs.id })
      .from(behaviorLogs)
      .where(eq(behaviorLogs.id, insertedId))
      .get()
    if (!verify) {
      console.error(`[ingest] 写入后回查失败 id=${insertedId} source=${data.source} event=${data.event_type}`)
    } else {
      console.log(`[ingest] 回查确认 id=${insertedId}`)
    }
  } catch (e) {
    console.error(`[ingest] behavior_logs 写入失败 source=${data.source} event=${data.event_type} logged_at=${data.logged_at}:`, e)
  }

  // 广播 dev:signal 供开发者监控页实时展示；只有真正落库才广播
  if (insertedId !== null) {
    import('../ws/server').then(m => m.broadcast({
      type: 'dev:signal',
      source: data.source,
      event_type: data.event_type,
      payload: data.payload,
      logged_at: data.logged_at,
    })).catch(console.error)
  }

  // Windows 进程自动注册：desktop window_focus / window_active 见到的进程自动入 process_classifications（AI 分类）
  // window_active 在进入新窗口时即到达（window_focus 要等切走才结算），优先保证新进程分类的及时性
  if (data.source === 'desktop' && (data.event_type === 'window_focus' || data.event_type === 'window_active')) {
    const process = data.payload['process']
    if (typeof process === 'string' && process && data.payload['is_idle'] !== true) {
      import('../processes/classify')
        .then(m => m.classifyProcess(db, process))
        .catch(console.error)
    }
  }

  // 立即触发：高优先级事件绕过 tick 直接走轻量 pipeline
  void maybeImmediatePipeline(db, data)
}

async function maybeImmediatePipeline(db: Db, data: IngestPayload): Promise<void> {
  const { shouldTriggerImmediate, debounceImmediateTrigger } = await import('./triggers')
  const { getSunsetConfig } = await import('../sunset/config')
  let apps: string[] = []
  try {
    const cfg = getSunsetConfig()
    apps = cfg.high_stimulus_apps ?? []
  } catch { /* 配置未初始化时忽略，使用空列表 */ }
  // 矛盾门控上下文：当前状态 + 工作进程谓词（is_work ∪ 内置 DEV_TOOLS，小写子串匹配）
  const { getWorkProcesses } = await import('../sites/work')
  const { DEV_TOOLS } = await import('../decision/engine')
  const { getPrevState } = await import('./pipeline')
  const workTokens = [...getWorkProcesses(db), ...DEV_TOOLS].map(p => p.toLowerCase())
  const isWorkProcess = (name: string) => {
    const n = name.toLowerCase()
    return workTokens.some(t => n === t || n.includes(t))
  }
  if (!shouldTriggerImmediate(data.event_type, data.payload, apps, { prevState: getPrevState(), isWorkProcess })) return
  const now = Date.now()
  if (!debounceImmediateTrigger(now)) return
  const { runPipelineGuarded } = await import('./pipeline')
  await runPipelineGuarded(db, { mode: 'lightweight', nowMs: now })
}