import type * as vscode from 'vscode'
import type { BehaviorSource, BehaviorEventType } from '@anchor/types'
import { encryptEnvelope } from '@anchor/utils'

const QUEUE_KEY = 'anchor.offlineQueue'
const MAX_QUEUE_SIZE = 500
const FLUSH_CHUNK_SIZE = 100

export interface QueuedEvent {
  source: BehaviorSource
  event_type: BehaviorEventType
  payload: Record<string, unknown>
  logged_at: number
}

/**
 * 离线队列：WS 断开时积压 ingest 事件，重连后分块 POST /api/ingest/batch 补发。
 * 存 ExtensionContext.globalState；上限 500 条，超出 FIFO 淘汰最旧 10%。
 */
export function createOfflineQueue(context: vscode.ExtensionContext, serverUrl: string, dataKey?: string | null) {
  const key = dataKey?.trim() || null
  const read = (): QueuedEvent[] => context.globalState.get<QueuedEvent[]>(QUEUE_KEY, [])
  const write = (events: QueuedEvent[]) => context.globalState.update(QUEUE_KEY, events)

  return {
    async enqueue(evt: QueuedEvent): Promise<void> {
      const events = read()
      if (events.length >= MAX_QUEUE_SIZE) {
        events.splice(0, Math.floor(MAX_QUEUE_SIZE * 0.1))
      }
      events.push(evt)
      await write(events)
    },

    /** 成功一块删一块，失败保留剩余等待下次 */
    async flush(): Promise<void> {
      // 未配置数据密钥：显式拒绝补发（须在设置中配置或等待配对改造），保留队列
      if (key === null) {
        console.warn('[Anchor] 未配置数据密钥，暂停离线队列补发；请在设置中配置或等待配对流程改造')
        return
      }
      let events = read()
      while (events.length > 0) {
        const chunk = events.slice(0, FLUSH_CHUNK_SIZE)
        try {
          const body = await encryptEnvelope({ logs: chunk }, key)
          const resp = await fetch(`${serverUrl}/api/ingest/batch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          })
          if (!resp.ok) break
        } catch {
          break
        }
        events = events.slice(chunk.length)
        await write(events)
      }
    },
  }
}

export type OfflineQueue = ReturnType<typeof createOfflineQueue>
