'use client'

// 设置 → 安全：修改密码 / 配对新设备 / 已配对设备
import { useEffect, useRef, useState } from 'react'
import { ShieldCheck } from 'lucide-react'
import { formatRelativeTime } from '@/lib/formatRelativeTime'

interface DeviceItem {
  id: number
  name: string
  clientVersion: string | null
  createdAt: number
  lastSeenAt: number | null
  revokedAt: number | null
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '24px' }}>
      <h2 className="section-title">{title}</h2>
      {children}
    </section>
  )
}

export default function SecuritySettingsPage() {
  return (
    <div className="page" style={{ maxWidth: '480px' }}>
      <div className="page-header">
        <h1 className="page-title">安全</h1>
      </div>
      <PasswordSection />
      <PairSection />
      <DevicesSection />
    </div>
  )
}

function PasswordSection() {
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [saving, setSaving] = useState(false)
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (newPassword.length < 8) {
      setFeedback({ ok: false, text: '新密码至少 8 位' })
      return
    }
    if (newPassword !== confirm) {
      setFeedback({ ok: false, text: '两次输入的新密码不一致' })
      return
    }
    setSaving(true)
    setFeedback(null)
    try {
      const res = await fetch('/api/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentPassword, newPassword }),
      })
      if (res.ok) {
        setFeedback({ ok: true, text: '密码已更新。其他设备需重新登录。' })
        setCurrentPassword('')
        setNewPassword('')
        setConfirm('')
      } else {
        const body = await res.json().catch(() => ({}))
        setFeedback({ ok: false, text: body?.error ?? '修改失败，请重试' })
      }
    } catch {
      setFeedback({ ok: false, text: '网络错误，请重试' })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Section title="修改密码">
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <input
          className="input"
          type="password"
          placeholder="旧密码"
          autoComplete="current-password"
          value={currentPassword}
          onChange={e => setCurrentPassword(e.target.value)}
        />
        <input
          className="input"
          type="password"
          placeholder="新密码（至少 8 位）"
          autoComplete="new-password"
          value={newPassword}
          onChange={e => setNewPassword(e.target.value)}
        />
        <input
          className="input"
          type="password"
          placeholder="确认新密码"
          autoComplete="new-password"
          value={confirm}
          onChange={e => setConfirm(e.target.value)}
        />
        <button className="btn btn-primary" type="submit" disabled={saving} style={{ alignSelf: 'flex-start' }}>
          {saving ? '保存中…' : '保存新密码'}
        </button>
        {feedback && (
          <p style={{ fontSize: '12px', color: feedback.ok ? 'var(--color-working, #22863a)' : 'var(--color-curfew, #cf222e)', margin: 0 }}>
            {feedback.text}
          </p>
        )}
      </form>
    </Section>
  )
}

function PairSection() {
  const [code, setCode] = useState<string | null>(null)
  const [expiresAt, setExpiresAt] = useState<number | null>(null)
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  useEffect(() => {
    if (expiresAt === null || now >= expiresAt) return
    timerRef.current = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000)
    return () => { if (timerRef.current) clearInterval(timerRef.current) }
  }, [expiresAt, now])

  async function generate() {
    const res = await fetch('/api/pair/codes', { method: 'POST' })
    if (!res.ok) return
    const body = await res.json() as { code: string; expiresAt: number }
    setCode(body.code)
    setExpiresAt(body.expiresAt)
    setCopied(false)
    setNow(Math.floor(Date.now() / 1000))
  }

  const expired = code !== null && expiresAt !== null && now >= expiresAt
  const remaining = code !== null && expiresAt !== null ? Math.max(0, expiresAt - now) : 0
  const mm = String(Math.floor(remaining / 60)).padStart(2, '0')
  const ss = String(remaining % 60).padStart(2, '0')

  async function copy() {
    if (!code) return
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch {
      // 剪贴板不可用（非安全上下文等）时静默忽略
    }
  }

  return (
    <Section title="配对新设备">
      {code === null ? (
        <p style={{ fontSize: '12px', color: 'var(--text-secondary)', margin: 0 }}>
          生成 8 位配对码，在客户端输入此码完成配对。
        </p>
      ) : expired ? (
        <p style={{ fontSize: '13px', color: 'var(--text-secondary)', margin: 0 }}>已过期，请重新生成</p>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', flexWrap: 'wrap' }}>
          <span
            style={{
              fontSize: '24px',
              fontWeight: 600,
              letterSpacing: '4px',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {code}
          </span>
          <span style={{ fontSize: '12px', color: 'var(--text-secondary)', fontVariantNumeric: 'tabular-nums' }}>
            {mm}:{ss}
          </span>
          <button className="btn btn-secondary" onClick={copy}>
            {copied ? '已复制' : '复制'}
          </button>
        </div>
      )}
      <button className="btn btn-primary" onClick={generate} style={{ alignSelf: 'flex-start' }}>
        生成配对码
      </button>
    </Section>
  )
}

function DevicesSection() {
  const [devices, setDevices] = useState<DeviceItem[] | null>(null)
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))

  async function load() {
    const res = await fetch('/api/devices')
    if (!res.ok) return
    const body = await res.json() as { devices: DeviceItem[] }
    setDevices(body.devices)
    setNow(Math.floor(Date.now() / 1000))
  }

  useEffect(() => { load() }, [])

  async function revoke(id: number, name: string) {
    if (!window.confirm(`撤销设备「${name}」？该设备将立即停止同步。`)) return
    await fetch(`/api/devices/${id}/revoke`, { method: 'POST' })
    await load()
  }

  return (
    <Section title="已配对设备">
      {devices === null ? (
        <p style={{ fontSize: '12px', color: 'var(--text-secondary)', margin: 0 }}>加载中…</p>
      ) : devices.length === 0 ? (
        <p style={{ fontSize: '12px', color: 'var(--text-secondary)', margin: 0 }}>暂无已配对设备</p>
      ) : (
        <div className="list-group">
          {devices.map(d => {
            const revoked = d.revokedAt !== null
            return (
              <div key={d.id} className="list-item" style={{ cursor: 'default' }}>
                <ShieldCheck size={16} style={{ color: revoked ? 'var(--text-disabled)' : 'var(--color-working, #22863a)', flexShrink: 0 }} />
                <span className="item-label" style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: 'block', opacity: revoked ? 0.55 : 1 }}>
                    {d.name}
                    <span style={{ fontSize: '11px', color: 'var(--text-secondary)', marginLeft: '6px' }}>
                      {d.clientVersion ?? '未知版本'}
                    </span>
                  </span>
                  <span style={{ display: 'block', fontSize: '12px', color: 'var(--text-secondary)' }}>
                    {revoked
                      ? `已撤销 · ${formatRelativeTime(d.revokedAt, now)}`
                      : `最后活跃 ${formatRelativeTime(d.lastSeenAt, now)}`}
                  </span>
                </span>
                {revoked
                  ? <span style={{ fontSize: '12px', color: 'var(--text-disabled)' }}>已撤销</span>
                  : <button className="btn btn-ghost" style={{ fontSize: '12px', padding: '3px 8px' }} onClick={() => revoke(d.id, d.name)}>撤销</button>}
              </div>
            )
          })}
        </div>
      )}
    </Section>
  )
}
