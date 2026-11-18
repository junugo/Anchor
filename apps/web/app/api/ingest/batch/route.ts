import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { ingestBehavior } from '@/lib/inference/ingest'
import { unwrapBody, dataKeyFingerprint } from '@anchor/utils'
import { getDataKey } from '@/lib/data-key'

// 单次补发上限：客户端按 100 条分块，500 仅作防御性截断
const MAX_BATCH_SIZE = 500

export async function POST(req: NextRequest) {
  let body: { logs?: unknown }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 })
  }
  const db = getDb()

  // 加密上传：enc:true 时解密出 { logs }；解密失败丢弃并告警
  const plain = await unwrapBody(body, getDataKey())
  if (plain === null) {
    const fp = await dataKeyFingerprint(getDataKey())
    console.warn(`[batch] 解密失败，请求已丢弃（服务器密钥指纹 ${fp}）`)
    return NextResponse.json({ error: '解密失败' }, { status: 400 })
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(plain)
  } catch {
    return NextResponse.json({ error: '请求体不是合法 JSON' }, { status: 400 })
  }
  const unwrapped = parsed as { logs?: unknown }

  const logs = unwrapped.logs as Array<{
    source: string
    event_type: string
    payload: Record<string, unknown>
    logged_at?: number
    location_zone?: string
  }>

  if (!Array.isArray(logs) || logs.length === 0) {
    return NextResponse.json({ ok: true, ingested: 0 })
  }

  const batch = logs.length > MAX_BATCH_SIZE ? logs.slice(0, MAX_BATCH_SIZE) : logs
  if (batch.length < logs.length) {
    console.warn(`[batch] 请求 ${logs.length} 条超出上限，仅处理前 ${MAX_BATCH_SIZE} 条`)
  }

  let ingested = 0
  for (const log of batch) {
    try {
      ingestBehavior(db, {
        source: log.source as any,
        event_type: log.event_type as any,
        payload: log.payload ?? {},
        logged_at: log.logged_at ?? Math.floor(Date.now() / 1000),
        location_zone: log.location_zone as any,
      }, { replay: true })
      ingested++
    } catch (e) {
      console.error('[batch] failed to ingest log:', e)
    }
  }

  // 补发完成后统一触发一次轻量推断，让积压事件参与状态判断
  if (ingested > 0) {
    // 离线补发（事件时间早于 15 分钟前，超出实时 tick 覆盖）→ 异步回放推断，
    // 补齐服务器离线时段的 state_segments（时间轴缺口）。不阻塞响应。
    const nowS = Math.floor(Date.now() / 1000)
    const minLoggedAt = Math.min(...batch.map(l => l.logged_at ?? nowS))
    if (minLoggedAt < nowS - 15 * 60) {
      const fromS = Math.floor(minLoggedAt / 3600) * 3600
      import('@/lib/timeline/replay')
        .then(m => {
          const r = m.replayStateSegments(db, fromS, nowS)
          if (r.written > 0) console.log(`[batch] 离线缺口回放：${r.hours} 小时 → ${r.written} 段`)
        })
        .catch(console.error)
    }
    import('@/lib/inference/pipeline')
      .then(m => m.runPipelineGuarded(db, { mode: 'lightweight', nowMs: Date.now() }))
      .catch(console.error)
  }

  return NextResponse.json({ ok: true, ingested })
}
