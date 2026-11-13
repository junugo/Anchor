'use client'

import { useEffect, useRef } from 'react'

type WsEvent = { type: string; [key: string]: unknown }

export function useWsEvents(onEvent: (msg: WsEvent) => void) {
  const handlerRef = useRef(onEvent)
  handlerRef.current = onEvent

  useEffect(() => {
    let ws: WebSocket | null = null
    let closed = false
    let retryTimer: ReturnType<typeof setTimeout> | null = null

    const connect = () => {
      if (closed) return
      const proto = location.protocol === 'https:' ? 'wss' : 'ws'
      ws = new WebSocket(`${proto}://${location.host}/ws`)
      ws.onmessage = (e) => {
        try {
          handlerRef.current(JSON.parse(e.data as string))
        } catch { /* ignore malformed */ }
      }
      ws.onclose = () => {
        if (!closed) retryTimer = setTimeout(connect, 5000)
      }
    }

    connect()
    return () => {
      closed = true
      if (retryTimer) clearTimeout(retryTimer)
      ws?.close()
    }
  }, [])
}
