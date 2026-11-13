import type { BehaviorEventType, BehaviorSource } from '@anchor/types'

const DB_NAME = 'anchor-chrome-queue'
const DB_VERSION = 1
const STORE_NAME = 'events'
const MAX_QUEUE_SIZE = 500

export interface QueuedEvent {
  id?: number
  source: BehaviorSource
  event_type: BehaviorEventType
  payload: Record<string, unknown>
  // 事件发生时的 Unix 秒；旧版本队列数据可能没有，fallback 用 queued_at
  logged_at?: number
  queued_at: number
}

async function openQueueDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export async function enqueueEvent(
  source: BehaviorSource,
  event_type: BehaviorEventType,
  payload: Record<string, unknown>,
  logged_at: number,
): Promise<void> {
  const db = await openQueueDB()
  const tx = db.transaction(STORE_NAME, 'readwrite')
  const store = tx.objectStore(STORE_NAME)
  const countReq = store.count()
  await new Promise<void>((resolve, reject) => {
    countReq.onsuccess = () => {
      if (countReq.result >= MAX_QUEUE_SIZE) {
        const cursorReq = store.openCursor()
        let deleted = 0
        const target = Math.floor(MAX_QUEUE_SIZE * 0.1)
        cursorReq.onsuccess = () => {
          const cursor = cursorReq.result
          if (cursor && deleted < target) {
            cursor.delete()
            deleted++
            cursor.continue()
          }
        }
      }
      store.add({ source, event_type, payload, logged_at, queued_at: Date.now() })
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    }
    countReq.onerror = () => reject(countReq.error)
  })
}

export async function getAllQueuedEvents(): Promise<QueuedEvent[]> {
  const db = await openQueueDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly')
    const store = tx.objectStore(STORE_NAME)
    const req = store.getAll()
    req.onsuccess = () => resolve(req.result as QueuedEvent[])
    req.onerror = () => reject(req.error)
  })
}

export async function removeQueuedEvent(id: number): Promise<void> {
  const db = await openQueueDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    store.delete(id)
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}

export async function clearQueuedEvents(): Promise<void> {
  const db = await openQueueDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite')
    const store = tx.objectStore(STORE_NAME)
    store.clear()
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
  })
}
