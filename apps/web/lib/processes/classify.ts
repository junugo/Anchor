import type { Db } from '@anchor/db'
import { processClassifications } from '@anchor/db'
import { eq, sql } from 'drizzle-orm'

// 系统噪音进程：不值得入表分类（桌面采集语义内的锁屏进程也由客户端过滤，这里兜底）
const IGNORED_PROCESSES = new Set([
  'explorer.exe', 'dwm.exe', 'lockapp.exe', 'svchost.exe', 'system', 'system idle process',
  'shellexperiencehost.exe', 'searchhost.exe', 'startmenuexperiencehost.exe', 'textinputhost.exe',
  'runtimebroker.exe', 'applicationframehost.exe', 'taskmgr.exe', 'anchor-desktop.exe',
])

export function isIgnoredProcess(processName: string): boolean {
  return IGNORED_PROCESSES.has(processName.toLowerCase())
}

export interface ProcessClassifyResult {
  process_name: string
  display_name: string
  high_stimulus: boolean
  is_work: boolean
  source: string
}

// 进程分类主流程：已分类直接返回（缺 icon 时顺带回填）；否则落 pending 行 → AI 分类 → 更新并广播
// ingest 钩子和 /api/processes/classify 路由共用
// iconBase64：desktop-rs 上传的进程图标（纯 base64 PNG）；已有 icon 的行不覆盖，首次上传优先
export async function classifyProcess(db: Db, rawName: string, displayName?: string, iconBase64?: string): Promise<ProcessClassifyResult | null> {
  const processName = rawName.toLowerCase()
  if (!processName || isIgnoredProcess(processName)) return null

  const existing = db
    .select()
    .from(processClassifications)
    .where(eq(processClassifications.process_name, processName))
    .get()

  if (existing && existing.classification_source !== 'pending') {
    if (iconBase64 && !existing.icon_base64) {
      db.update(processClassifications)
        .set({ icon_base64: iconBase64, updated_at: Math.floor(Date.now() / 1000) })
        .where(eq(processClassifications.process_name, processName))
        .run()
      const { broadcast } = await import('../ws/server')
      broadcast({
        type: 'process:classification_updated',
        process_name: existing.process_name,
        display_name: existing.display_name,
        high_stimulus: existing.high_stimulus,
        is_work: existing.is_work,
        source: existing.classification_source,
      })
    }
    return {
      process_name: existing.process_name,
      display_name: existing.display_name,
      high_stimulus: existing.high_stimulus,
      is_work: existing.is_work,
      source: existing.classification_source,
    }
  }

  const now = Math.floor(Date.now() / 1000)
  const name = displayName || processName
  const { broadcast } = await import('../ws/server')

  db.insert(processClassifications).values({
    process_name: processName,
    display_name: name,
    high_stimulus: false,
    is_work: false,
    classification_source: 'pending',
    user_modified: false,
    icon_base64: iconBase64 ?? null,
    created_at: now,
    updated_at: now,
  }).onConflictDoUpdate({
    target: processClassifications.process_name,
    set: {
      classification_source: 'pending',
      display_name: name,
      updated_at: now,
      // pending 行已有 icon 时保留（与已分类行同一「首次优先」语义）
      ...(iconBase64
        ? { icon_base64: sql`COALESCE(${processClassifications.icon_base64}, ${iconBase64})` }
        : {}),
    },
  }).run()

  broadcast({
    type: 'process:classification_updated',
    process_name: processName,
    display_name: name,
    high_stimulus: false,
    is_work: false,
    source: 'pending',
  })

  const { classifyContent } = await import('../ai/classify-content')
  const result = await classifyContent('windows_process', {
    process_name: processName,
    display_name: name,
  })

  const doneAt = Math.floor(Date.now() / 1000)
  db.update(processClassifications)
    .set({
      high_stimulus: result.high_stimulus,
      is_work: result.is_work,
      classification_source: result.source,
      ai_raw_response: result.raw || null,
      reviewed: false,
      updated_at: doneAt,
    })
    .where(eq(processClassifications.process_name, processName))
    .run()

  broadcast({
    type: 'process:classification_updated',
    process_name: processName,
    display_name: name,
    high_stimulus: result.high_stimulus,
    is_work: result.is_work,
    source: result.source,
  })

  return {
    process_name: processName,
    display_name: name,
    high_stimulus: result.high_stimulus,
    is_work: result.is_work,
    source: result.source,
  }
}
