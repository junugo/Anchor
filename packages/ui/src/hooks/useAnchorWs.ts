/**
 * 共享 WebSocket 状态管理。
 * 平台无关——Web、Mobile、Desktop 渲染进程均可使用。
 * Desktop 主进程使用 Node.js ws 库，不使用本模块。
 */
import { useEffect, useReducer, useCallback, useRef } from 'react'
import type { WsServerMessage, WsClientMessage } from '@anchor/types'
import { anchorReducer, initialState, type AnchorState, type AnchorAction } from '@anchor/utils'

export type WsStatus = 'connecting' | 'open' | 'closed' | 'error'
export type WsMessageListener = (msg: WsServerMessage) => void

interface WsStore {
  state:    AnchorState
  wsStatus: WsStatus
  send:     (msg: WsClientMessage) => void
}

/**
 * useAnchorWs — React hook，管理 WebSocket 连接和全局 Anchor 状态。
 * Web 和 Mobile 都使用此 hook，只在顶层调用一次（App 根组件）。
 *
 * onMessage 通过 ref 持有，不进入 useEffect 依赖数组，
 * 因此更新回调不会导致 WS 断线重连。
 */
export function useAnchorWs(serverUrl: string, onMessage?: WsMessageListener): WsStore {
  const [state, dispatch] = useReducer(anchorReducer, initialState)
  const wsRef   = useRef<WebSocket | null>(null)
  const statusRef = useRef<WsStatus>('closed')
  const [wsStatus, dispatchStatus] = useReducer(
    (_: WsStatus, next: WsStatus) => next,
    'closed' as WsStatus
  )
  // 用 ref 持有最新 onMessage，避免将其纳入 useEffect deps 导致不必要的重连
  const onMessageRef = useRef<WsMessageListener | undefined>(onMessage)
  useEffect(() => { onMessageRef.current = onMessage })

  const setStatus = useCallback((s: WsStatus) => {
    statusRef.current = s
    dispatchStatus(s)
  }, [])

  const send = useCallback((msg: WsClientMessage) => {
    const ws = wsRef.current
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg))
    }
  }, [])

  useEffect(() => {
    const wsUrl = serverUrl.replace(/^http/, 'ws') + '/ws'
    let ws: WebSocket
    let retryTimeout: ReturnType<typeof setTimeout>
    let pingInterval: ReturnType<typeof setInterval>
    let destroyed = false

    function connect() {
      if (destroyed) return
      setStatus('connecting')
      ws = new WebSocket(wsUrl)
      wsRef.current = ws

      ws.onopen = () => {
        setStatus('open')
        dispatch({ type: 'SET_CONNECTED', connected: true })
        // 主动拉取当前状态，不依赖 WS 推送时序
        fetch(serverUrl + '/api/status')
          .then(r => r.json())
          .then(data => {
            if (data.inferred_state) {
              dispatch({ type: 'SET_STATE', userState: data.inferred_state })
            }
          })
          .catch(() => {})
        pingInterval = setInterval(() => ws.send(JSON.stringify({ type: 'pong' })), 25_000)
      }

      ws.onclose = () => {
        clearInterval(pingInterval)
        if (!destroyed) {
          setStatus('closed')
          dispatch({ type: 'SET_CONNECTED', connected: false })
          // Exponential backoff: reconnect after 3s
          retryTimeout = setTimeout(connect, 3_000)
        }
      }

      ws.onerror = () => {
        setStatus('error')
      }

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data as string) as WsServerMessage
          // 通过 ref 调用，始终使用最新回调，不触发 WS 重连
          onMessageRef.current?.(msg)
          handleMessage(msg, dispatch)
        } catch {
          // ignore malformed messages
        }
      }
    }

    connect()

    return () => {
      destroyed = true
      clearInterval(pingInterval)
      clearTimeout(retryTimeout)
      ws?.close()
      wsRef.current = null
    }
  }, [serverUrl, setStatus]) // onMessage 不在依赖中，通过 ref 访问

  return { state, wsStatus, send }
}

function handleMessage(msg: WsServerMessage, dispatch: React.Dispatch<AnchorAction>): void {
  switch (msg.type) {
    case 'state:update':
      dispatch({ type: 'SET_STATE', userState: msg.state })
      break
    case 'sunset:phase':
      dispatch({ type: 'SET_SUNSET', phase: msg.phase })
      break
    case 'sunset:stage':
      // 握手快照与配置变更后的重算阶段只发 sunset:stage，必须一并处理
      dispatch({ type: 'SET_SUNSET', phase: msg.stage })
      break
    case 'notify:ai':
      dispatch({ type: 'SET_AI_MSG', message: msg.message })
      break
    case 'intent:capture':
      dispatch({
        type: 'SET_INTENT_CAPTURE',
        payload: {
          prompt_id:       msg.prompt_id,
          timeoutSeconds:  msg.timeoutSeconds,
          prompt:          msg.prompt,
          is_degraded:     msg.is_degraded,
          focuslayer_hint: msg.focuslayer_hint,
        },
      })
      break
    case 'intent:dismiss':
      // answered/skipped/expired 均关闭采集界面（重开入口由原生端各自处理）
      dispatch({ type: 'SET_INTENT_CAPTURE', payload: null })
      break
    case 'intent:confirm':
      dispatch({
        type: 'SET_INTENT_CONFIRM',
        payload: {
          date:    msg.date,
          content: msg.content,
        },
      })
      break
    case 'ping':
      break
    default:
      break
  }
}