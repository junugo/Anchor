'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { Send, History, X, Clock, Pencil, Trash2, Check } from 'lucide-react'
import { ConfirmDialog } from '@anchor/ui'

interface Message {
  role: 'user' | 'assistant'
  content: string
  created_at?: number
}

interface SessionItem {
  id: number
  session_id: string
  created_at: number
  last_message_at: number
  opening_message: string | null
  title: string | null
  preview: string | null
}

function formatTime(unix: number): string {
  const d = new Date(unix * 1000)
  const now = new Date()
  const diffDays = Math.floor((now.getTime() - d.getTime()) / 86400000)
  if (diffDays === 0) {
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  }
  if (diffDays === 1) return '昨天'
  if (diffDays < 7) return `${diffDays} 天前`
  return d.toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
}

export default function ChatPage() {
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [streaming, setStreaming] = useState(false)
  const [showHistory, setShowHistory] = useState(false)
  const [sessions, setSessions] = useState<SessionItem[]>([])
  const [loadingSession, setLoadingSession] = useState(true)
  const [loadingHistory, setLoadingHistory] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<SessionItem | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  // 初始化：获取当前会话（含开场白）
  useEffect(() => {
    setLoadingSession(true)
    fetch('/api/ai/chat/sessions/current')
      .then(res => res.json())
      .then((data: { sessionId: string; messages: Message[] }) => {
        setCurrentSessionId(data.sessionId)
        setMessages(data.messages ?? [])
      })
      .catch(console.error)
      .finally(() => setLoadingSession(false))
  }, [])

  // 加载历史会话列表
  useEffect(() => {
    if (!showHistory) return
    setLoadingHistory(true)
    fetch('/api/ai/chat/sessions')
      .then(res => res.json())
      .then((data: SessionItem[]) => setSessions(data))
      .catch(console.error)
      .finally(() => setLoadingHistory(false))
  }, [showHistory])

  // 滚动到底部
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  const send = useCallback(async () => {
    const text = input.trim()
    if (!text || streaming || !currentSessionId) return
    setInput('')

    const userMsg: Message = { role: 'user', content: text }
    const nextMessages = [...messages, userMsg]
    setMessages(nextMessages)
    setStreaming(true)
    setMessages(m => [...m, { role: 'assistant', content: '' }])

    try {
      const res = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: currentSessionId,
          messages: nextMessages,
        }),
      })

      if (!res.ok || !res.body) {
        setMessages(m => {
          const copy = [...m]
          copy[copy.length - 1] = { role: 'assistant', content: '连接失败，请重试。' }
          return copy
        })
        return
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const data = line.slice(6).trim()
          if (data === '[DONE]') break
          try {
            const chunk = JSON.parse(data) as {
              choices?: Array<{ delta?: { content?: string } }>
            }
            const token = chunk.choices?.[0]?.delta?.content ?? ''
            if (token) {
              setMessages(m => {
                const copy = [...m]
                copy[copy.length - 1] = {
                  role: 'assistant',
                  content: copy[copy.length - 1].content + token,
                }
                return copy
              })
            }
          } catch {
            // 忽略格式异常的 SSE chunk
          }
        }
      }
    } catch {
      setMessages(m => {
        const copy = [...m]
        copy[copy.length - 1] = { role: 'assistant', content: '网络错误，请重试。' }
        return copy
      })
    } finally {
      setStreaming(false)
      setTimeout(() => inputRef.current?.focus(), 0)
    }
  }, [input, streaming, currentSessionId, messages])

  function loadSession(sessionId: string) {
    fetch(`/api/ai/chat/sessions/${sessionId}`)
      .then(res => res.json())
      .then((data: { sessionId: string; messages: Message[] }) => {
        setCurrentSessionId(data.sessionId)
        setMessages(data.messages ?? [])
        setShowHistory(false)
      })
      .catch(console.error)
  }

  function startNewSession() {
    return fetch('/api/ai/chat/sessions', { method: 'POST' })
      .then(res => res.json())
      .then((data: { sessionId: string; messages: Message[] }) => {
        setCurrentSessionId(data.sessionId)
        setMessages(data.messages ?? [])
      })
      .catch(console.error)
  }

  function submitRename(sessionId: string) {
    const title = renameValue.trim()
    if (!title) {
      setRenamingId(null)
      return
    }
    fetch(`/api/ai/chat/sessions/${sessionId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title }),
    })
      .then(res => {
        if (!res.ok) throw new Error('rename failed')
        setSessions(list => list.map(s => s.session_id === sessionId ? { ...s, title } : s))
      })
      .catch(console.error)
      .finally(() => setRenamingId(null))
  }

  function confirmDelete() {
    const target = deleteTarget
    if (!target) return
    setDeleteTarget(null)
    fetch(`/api/ai/chat/sessions/${target.session_id}`, { method: 'DELETE' })
      .then(res => {
        if (!res.ok) throw new Error('delete failed')
        setSessions(list => list.filter(s => s.session_id !== target.session_id))
        if (target.session_id === currentSessionId) {
          return startNewSession()
        }
      })
      .catch(console.error)
  }

  return (
    <div style={{ display: 'flex', height: '100dvh', overflow: 'hidden', position: 'relative' }}>
      {/* 主聊天区 */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        {/* 顶栏 */}
        <div style={{
          padding: '0 16px',
          height: '48px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          borderBottom: '1px solid var(--border)',
          background: 'var(--surface)',
          flexShrink: 0,
        }}>
          <h1 style={{ fontSize: '15px', fontWeight: 500 }}>与 Anchor 对话</h1>
          <button
            className="btn btn-ghost"
            onClick={() => setShowHistory(v => !v)}
            title="历史会话"
            style={{ padding: '6px', width: '32px', height: '32px', justifyContent: 'center' }}
          >
            <History size={16} />
          </button>
        </div>

        {/* 消息区 */}
        <div style={{
          flex: 1,
          overflowY: 'auto',
          padding: '20px 16px',
          display: 'flex',
          flexDirection: 'column',
          gap: '12px',
        }}>
          {loadingSession && (
            <div style={{ textAlign: 'center', marginTop: '80px', color: 'var(--text-disabled)', fontSize: '13px' }}>
              <span>正在连接…</span>
            </div>
          )}
          {!loadingSession && messages.length === 0 && (
            <div className="empty-state" style={{ marginTop: '80px' }}>
              <p>Anchor 在这里陪你</p>
              <p style={{ fontSize: '13px' }}>问问今天的状态，或者随便聊聊</p>
            </div>
          )}
          {messages.map((m, i) => (
            <div
              key={i}
              style={{
                alignSelf: m.role === 'user' ? 'flex-end' : 'flex-start',
                maxWidth: '78%',
                background: m.role === 'user' ? 'var(--accent-muted)' : 'var(--surface)',
                border: m.role === 'assistant' ? '1px solid var(--border)' : 'none',
                borderRadius: m.role === 'user' ? '14px 14px 4px 14px' : '14px 14px 14px 4px',
                padding: '10px 14px',
                fontSize: '14px',
                lineHeight: '1.65',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                color: m.role === 'user' ? 'var(--accent)' : 'var(--text-primary)',
              }}
            >
              {m.content || (m.role === 'assistant' && streaming && i === messages.length - 1
                ? <span style={{ color: 'var(--text-disabled)', animation: 'pulse 1s infinite' }}>▌</span>
                : null
              )}
            </div>
          ))}
          <div ref={bottomRef} />
        </div>

        {/* 输入区 */}
        <div style={{
          padding: '12px 16px',
          borderTop: '1px solid var(--border)',
          background: 'var(--surface)',
          display: 'flex',
          gap: '8px',
          flexShrink: 0,
        }}>
          <input
            ref={inputRef}
            className="input"
            value={input}
            onChange={e => setInput(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                send()
              }
            }}
            placeholder="跟 Anchor 说说话…"
            disabled={streaming || loadingSession}
            style={{ flex: 1 }}
          />
          <button
            className="btn btn-primary"
            onClick={send}
            disabled={!input.trim() || streaming || loadingSession}
            style={{ width: '36px', padding: 0, justifyContent: 'center', flexShrink: 0 }}
          >
            <Send size={14} />
          </button>
        </div>
      </div>

      {/* 历史会话侧边栏 */}
      {showHistory && (
        <div style={{
          width: '260px',
          borderLeft: '1px solid var(--border)',
          background: 'var(--surface)',
          display: 'flex',
          flexDirection: 'column',
          flexShrink: 0,
        }}>
          <div style={{
            padding: '0 12px',
            height: '48px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            borderBottom: '1px solid var(--border)',
            flexShrink: 0,
          }}>
            <span style={{ fontSize: '13px', fontWeight: 500, color: 'var(--text-secondary)' }}>
              历史会话
            </span>
            <button
              className="btn btn-ghost"
              onClick={() => setShowHistory(false)}
              style={{ padding: '4px', width: '28px', height: '28px', justifyContent: 'center' }}
            >
              <X size={14} />
            </button>
          </div>

          <div style={{ flex: 1, overflowY: 'auto', padding: '8px' }}>
            {loadingHistory && (
              <p style={{ fontSize: '13px', color: 'var(--text-disabled)', textAlign: 'center', marginTop: '24px' }}>
                加载中…
              </p>
            )}
            {!loadingHistory && sessions.length === 0 && (
              <p style={{ fontSize: '13px', color: 'var(--text-disabled)', textAlign: 'center', marginTop: '24px' }}>
                暂无历史会话
              </p>
            )}
            {sessions.map(s => {
              const isActive = s.session_id === currentSessionId
              const isRenaming = renamingId === s.session_id
              const displayName = s.title ?? s.preview ?? s.opening_message ?? '（空会话）'
              return (
                <div
                  key={s.id}
                  onClick={() => { if (!isRenaming) loadSession(s.session_id) }}
                  style={{
                    padding: '10px 12px',
                    borderRadius: '6px',
                    marginBottom: '2px',
                    cursor: isRenaming ? 'default' : 'pointer',
                    background: isActive ? 'var(--accent-muted)' : 'transparent',
                    border: isActive ? '1px solid var(--accent)' : '1px solid transparent',
                    transition: 'background 120ms',
                  }}
                  onMouseEnter={e => {
                    if (!isActive) (e.currentTarget as HTMLDivElement).style.background = 'var(--hover)'
                  }}
                  onMouseLeave={e => {
                    if (!isActive) (e.currentTarget as HTMLDivElement).style.background = 'transparent'
                  }}
                >
                  <div style={{ fontSize: '12px', color: 'var(--text-disabled)', marginBottom: '4px', display: 'flex', alignItems: 'center', gap: '4px' }}>
                    <Clock size={11} />
                    <span style={{ flex: 1 }}>{formatTime(s.created_at)}</span>
                    {!isRenaming && (
                      <>
                        <button
                          className="btn btn-ghost"
                          title="重命名"
                          onClick={e => {
                            e.stopPropagation()
                            setRenamingId(s.session_id)
                            setRenameValue(s.title ?? s.preview ?? '')
                          }}
                          style={{ padding: '2px', width: '20px', height: '20px', justifyContent: 'center', color: 'var(--text-disabled)' }}
                        >
                          <Pencil size={11} />
                        </button>
                        <button
                          className="btn btn-ghost"
                          title="删除"
                          onClick={e => {
                            e.stopPropagation()
                            setDeleteTarget(s)
                          }}
                          style={{ padding: '2px', width: '20px', height: '20px', justifyContent: 'center', color: 'var(--text-disabled)' }}
                        >
                          <Trash2 size={11} />
                        </button>
                      </>
                    )}
                  </div>
                  {isRenaming ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                      <input
                        className="input"
                        autoFocus
                        value={renameValue}
                        onChange={e => setRenameValue(e.target.value)}
                        onClick={e => e.stopPropagation()}
                        onKeyDown={e => {
                          if (e.key === 'Enter') submitRename(s.session_id)
                          if (e.key === 'Escape') setRenamingId(null)
                        }}
                        onBlur={() => submitRename(s.session_id)}
                        maxLength={50}
                        style={{ flex: 1, height: '26px', padding: '0 8px', fontSize: '13px' }}
                      />
                      <button
                        className="btn btn-ghost"
                        title="确认"
                        onMouseDown={e => e.preventDefault()}
                        onClick={e => {
                          e.stopPropagation()
                          submitRename(s.session_id)
                        }}
                        style={{ padding: '2px', width: '22px', height: '22px', justifyContent: 'center', flexShrink: 0 }}
                      >
                        <Check size={12} />
                      </button>
                    </div>
                  ) : (
                    <p style={{
                      fontSize: '13px',
                      color: isActive ? 'var(--accent)' : 'var(--text-primary)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      margin: 0,
                      lineHeight: '1.4',
                    }}>
                      {displayName}
                    </p>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      <ConfirmDialog
        open={deleteTarget !== null}
        title="删除会话"
        description="该会话的全部消息将被删除，不可恢复。"
        confirmLabel="删除"
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  )
}
