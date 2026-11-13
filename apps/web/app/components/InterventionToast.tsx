'use client'

import { useEffect, useState } from 'react'

interface InterventionMsg {
  level: string
  message: string
}

/**
 * InterventionToast — 干预级别提示
 * light：黄色 toast，8 秒后自动消失
 * strong：红色 toast，8 秒后自动消失
 * 仅在 Electron 环境下监听 IPC 事件。
 */
export function InterventionToast() {
  const [msg, setMsg] = useState<InterventionMsg | null>(null)

  useEffect(() => {
    const api = (window as unknown as { api?: { onIntervention?: (cb: (_: unknown, m: InterventionMsg) => void) => void; offIntervention?: (cb: (_: unknown, m: InterventionMsg) => void) => void } }).api
    if (!api?.onIntervention) return

    let timer: ReturnType<typeof setTimeout> | null = null

    const handler = (_: unknown, m: InterventionMsg) => {
      setMsg(m)
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => setMsg(null), 8000)
    }

    api.onIntervention(handler)
    return () => {
      api.offIntervention?.(handler)
      if (timer) clearTimeout(timer)
    }
  }, [])

  if (!msg) return null

  const bgColor = msg.level === 'strong' ? '#cf222e' : '#b08800'

  return (
    <div style={{
      position: 'fixed',
      top: 16,
      left: '50%',
      transform: 'translateX(-50%)',
      background: bgColor,
      color: '#fff',
      padding: '10px 16px',
      borderRadius: 8,
      zIndex: 10000,
      fontFamily: 'system-ui, sans-serif',
      fontSize: 13,
      fontWeight: 500,
      maxWidth: 360,
      textAlign: 'center',
      boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
    }}>
      {msg.message}
    </div>
  )
}
