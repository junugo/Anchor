'use client'

/**
 * Web-side Anchor context provider.
 * Wraps useAnchorWs from @anchor/ui so any page can subscribe to
 * live state without each page owning its own WebSocket.
 */
import { createContext, useContext, useRef, useCallback, type ReactNode } from 'react'
import { useAnchorWs, type WsMessageListener } from '@anchor/ui'
import { createAnchorApiClient } from '@anchor/api-client'
import type { AnchorState } from '@anchor/utils'
import type { WsClientMessage, WsServerMessage } from '@anchor/types'

const WEB_URL = typeof window !== 'undefined'
  ? window.location.origin
  : 'http://localhost:4000'

interface AnchorCtx {
  state: AnchorState
  send:  (msg: WsClientMessage) => void
  api:   ReturnType<typeof createAnchorApiClient>
  /** 注册一个 WS 消息监听器，返回取消注册函数 */
  onWsMessage: (listener: WsMessageListener) => () => void
}

const AnchorContext = createContext<AnchorCtx | null>(null)

const api = createAnchorApiClient(
  typeof window !== 'undefined' ? window.location.origin : 'http://localhost:4000'
)

export function AnchorProvider({ children }: { children: ReactNode }) {
  const listenersRef = useRef(new Set<WsMessageListener>())

  const handleMessage = useCallback((msg: WsServerMessage) => {
    listenersRef.current.forEach(l => l(msg))
  }, [])

  const { state, send } = useAnchorWs(WEB_URL, handleMessage)

  const onWsMessage = useCallback((listener: WsMessageListener) => {
    listenersRef.current.add(listener)
    return () => { listenersRef.current.delete(listener) }
  }, [])

  return (
    <AnchorContext.Provider value={{ state, send, api, onWsMessage }}>
      {children}
    </AnchorContext.Provider>
  )
}

export function useAnchor(): AnchorCtx {
  const ctx = useContext(AnchorContext)
  if (!ctx) throw new Error('useAnchor must be used inside <AnchorProvider>')
  return ctx
}