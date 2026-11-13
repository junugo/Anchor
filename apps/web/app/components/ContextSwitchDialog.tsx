'use client'

import { useEffect, useRef, useState } from 'react'
import { useAnchor } from './AnchorProvider'

interface ActivePrompt {
  promptId: string
  timeoutSeconds: number
  placeholder: string
}

/**
 * ContextSwitchDialog — 状态切换全局弹窗（注意力残留采集）
 * 工作 → 非工作时由服务器广播 context_switch:prompt 触发。
 * 任一端（Chrome/Android/Desktop/Web）响应后服务器广播 dismiss，全端联动关闭。
 * 15s 内未输入则自动跳过；一旦开始输入即取消倒计时，只能手动提交/跳过。
 */
export function ContextSwitchDialog() {
  const { onWsMessage, send } = useAnchor()
  const [prompt, setPrompt] = useState<ActivePrompt | null>(null)
  const [remaining, setRemaining] = useState(0)
  const [text, setText] = useState('')
  const [typing, setTyping] = useState(false)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    return onWsMessage((msg) => {
      if (msg.type === 'context_switch:prompt') {
        setPrompt({ promptId: msg.prompt_id, timeoutSeconds: msg.timeoutSeconds, placeholder: msg.placeholder })
        setRemaining(msg.timeoutSeconds)
        setText('')
        setTyping(false)
      } else if (msg.type === 'context_switch:dismiss') {
        setPrompt(prev => (prev && prev.promptId === msg.prompt_id ? null : prev))
      }
    })
  }, [onWsMessage])

  // 倒计时：仅未输入时生效；输入即取消，之后只能手动操作
  useEffect(() => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
    if (!prompt || typing) return
    timerRef.current = setInterval(() => {
      setRemaining(r => {
        if (r <= 1) {
          if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null }
          respond('auto_skip')
          return 0
        }
        return r - 1
      })
    }, 1000)
    return () => { if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null } }
  }, [prompt?.promptId, typing])

  const respond = (action: 'submit' | 'skip' | 'auto_skip') => {
    if (!prompt) return
    const value = text.trim()
    send({
      type: 'context_switch:response',
      prompt_id: prompt.promptId,
      action: action === 'submit' && !value ? 'skip' : action,
      text: action === 'submit' ? value : undefined,
      source: 'web',
    })
    setPrompt(null)
  }

  if (!prompt) return null

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
        maxWidth: '440px',
        width: '100%',
        boxShadow: '0 8px 40px rgba(0,0,0,0.35)',
      }}>
        <div style={{ fontSize: '16px', fontWeight: 600, color: '#f5f0eb', marginBottom: '10px' }}>
          状态切换
        </div>
        <div style={{ fontSize: '14px', color: '#c8c0b8', lineHeight: 1.5, marginBottom: '16px' }}>
          你似乎从工作切换到了其他状态。方便说一下接下来的打算吗？
        </div>
        <textarea
          autoFocus
          value={text}
          placeholder={prompt.placeholder}
          onChange={(e) => { setText(e.target.value); setTyping(true) }}
          style={{
            width: '100%',
            minHeight: '80px',
            background: '#2a2520',
            border: '1px solid #3a3530',
            color: '#f5f0eb',
            borderRadius: '6px',
            padding: '10px',
            fontSize: '14px',
            resize: 'vertical',
            boxSizing: 'border-box',
            marginBottom: '8px',
            fontFamily: 'inherit',
          }}
        />
        <div style={{ fontSize: '12px', color: '#9e9690', marginBottom: '12px', textAlign: 'right', minHeight: '15px' }}>
          {!typing && remaining > 0 ? `${remaining}s 后自动跳过，输入后取消倒计时` : ''}
        </div>
        <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
          <button
            onClick={() => respond('skip')}
            style={{
              background: 'transparent',
              color: '#9e9690',
              border: '1px solid #3a3530',
              padding: '8px 18px',
              borderRadius: '6px',
              cursor: 'pointer',
              fontSize: '13px',
            }}
          >
            跳过
          </button>
          <button
            onClick={() => respond('submit')}
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
            提交
          </button>
        </div>
      </div>
    </div>
  )
}
