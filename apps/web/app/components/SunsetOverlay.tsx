'use client'

import { useEffect, useState } from 'react'

/**
 * SunsetOverlay — 主窗口宵禁覆盖层
 * T60：半透明灰色遮罩 + 顶部 banner
 * T30：深色模糊遮罩 + 居中提示
 * 仅在 Electron 环境（window.api 存在）时监听 IPC 事件。
 */
export function SunsetOverlay() {
  const [phase, setPhase] = useState<'off' | 'T60' | 'T30'>('off')

  useEffect(() => {
    // 仅在 Electron 环境下挂载监听
    const api = (window as unknown as { api?: { onSunsetPhase?: (cb: (_: unknown, phase: string) => void) => void; offSunsetPhase?: (cb: (_: unknown, phase: string) => void) => void } }).api
    if (!api?.onSunsetPhase) return

    const handler = (_: unknown, p: string) => {
      if (p === 'T60' || p === 'T30' || p === 'off') setPhase(p)
    }
    api.onSunsetPhase(handler)
    return () => { api.offSunsetPhase?.(handler) }
  }, [])

  if (phase === 'off') return null

  const isT30 = phase === 'T30'

  return (
    <div style={{
      position: 'fixed',
      inset: 0,
      backgroundColor: isT30 ? 'rgba(20,20,20,0.65)' : 'rgba(80,80,80,0.40)',
      backdropFilter: isT30 ? 'blur(6px)' : undefined,
      WebkitBackdropFilter: isT30 ? 'blur(6px)' : undefined,
      pointerEvents: 'none',
      zIndex: 9999,
      display: 'flex',
      flexDirection: 'column',
    }}>
      {/* 顶部 banner */}
      <div style={{
        backgroundColor: 'rgba(60,55,50,0.90)',
        padding: '8px 12px',
      }}>
        <span style={{ color: '#f5f0eb', fontSize: 13, fontWeight: 500 }}>
          🌙 {isT30 ? '距就寝还有 30 分钟，准备就寝' : '距就寝还有 60 分钟，开始放松'}
        </span>
      </div>

      {/* T30 居中提示 */}
      {isT30 && (
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 28, marginBottom: 8 }}>🌙</div>
            <div style={{ color: '#f5f0eb', fontSize: 14, fontWeight: 600 }}>还有 30 分钟</div>
            <div style={{ color: '#9e9690', fontSize: 12, marginTop: 4 }}>准备就寝</div>
          </div>
        </div>
      )}
    </div>
  )
}
