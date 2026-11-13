'use client'

import { useEffect, useRef, useState } from 'react'
import { useAnchor } from './AnchorProvider'

/**
 * SleepConfirmDialog — 入睡确认全局弹窗
 * 服务器怀疑用户已睡着时弹出（sleep:confirm-request）。
 * 只有「还没睡」一个按钮——能点击即证明醒着；
 * 无响应则由服务器超时自动确认睡着（并广播 sleep:confirm-cancel），
 * 本地 confirm_until 定时器兜底销毁。
 */
export function SleepConfirmDialog() {
  const { onWsMessage, send } = useAnchor()
  const [confirmUntil, setConfirmUntil] = useState<number | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return onWsMessage((msg) => {
      if (msg.type === 'sleep:confirm-request') {
        setConfirmUntil(msg.confirm_until)
      } else if (msg.type === 'sleep:confirm-cancel') {
        setConfirmUntil(null)
      }
    })
  }, [onWsMessage])

  // 本地兜底：窗口到期自动销毁
  useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current)
    if (confirmUntil == null) return
    const remainingMs = confirmUntil * 1000 - Date.now()
    if (remainingMs <= 0) {
      setConfirmUntil(null)
      return
    }
    timerRef.current = setTimeout(() => setConfirmUntil(null), remainingMs)
    return () => { if (timerRef.current) clearTimeout(timerRef.current) }
  }, [confirmUntil])

  if (confirmUntil == null) return null

  const handleNotYet = () => {
    send({ type: 'sleep:confirm-response', confirmed: false })
    setConfirmUntil(null)
  }

  return (
    <div style={{
      position: 'fixed',
      inset: 0,
      backgroundColor: 'rgba(28,24,20,0.92)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 10000,
      fontFamily: 'system-ui, -apple-system, sans-serif',
    }}>
      <div style={{
        background: '#1c1814',
        border: '1px solid #3a3228',
        borderRadius: '12px',
        padding: '24px',
        maxWidth: '420px',
        width: '100%',
        boxShadow: '0 8px 40px rgba(0,0,0,0.35)',
      }}>
        <div style={{ fontSize: '16px', fontWeight: 600, color: '#f5f0eb', marginBottom: '10px' }}>
          睡着了吗？
        </div>
        <div style={{ fontSize: '14px', color: '#c8c0b8', lineHeight: 1.5, marginBottom: '16px' }}>
          Anchor 检测到你很久没活动，推测你可能已经入睡。若没有回应，将自动视为已睡着。
        </div>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button
            onClick={handleNotYet}
            style={{
              background: '#c0622a',
              color: '#fff',
              border: '1px solid #c0622a',
              padding: '8px 18px',
              borderRadius: '6px',
              cursor: 'pointer',
              fontSize: '13px',
            }}
          >
            还没睡
          </button>
        </div>
      </div>
    </div>
  )
}
