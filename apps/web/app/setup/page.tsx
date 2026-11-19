'use client'

/**
 * /setup — 首次运行向导：设置登录密码。
 * 仅在未设置密码时有意义；已设密码（hasPassword=true）立即弹去 /login。
 */
import { useEffect, useState, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { Anchor } from 'lucide-react'
import { resolveAuthRedirect, type MeState } from '@/lib/auth/redirect'

const MIN_PASSWORD_LENGTH = 8

export default function SetupPage() {
  const router = useRouter()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [checking, setChecking] = useState(true)

  // 页面加载即查 /api/me：已设密码 → 跳 /login
  useEffect(() => {
    let cancelled = false
    fetch('/api/me', { cache: 'no-store' })
      .then(r => r.json() as Promise<MeState>)
      .then(me => {
        if (cancelled) return
        if (resolveAuthRedirect(me) !== '/setup') router.replace('/login')
        else setChecking(false)
      })
      .catch(() => { if (!cancelled) setChecking(false) })
    return () => { cancelled = true }
  }, [router])

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (password.length < MIN_PASSWORD_LENGTH) {
      setError('密码至少 8 位')
      return
    }
    if (password !== confirm) {
      setError('两次输入的密码不一致')
      return
    }
    setSubmitting(true)
    try {
      const res = await fetch('/api/setup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      })
      if (res.ok) {
        router.replace('/login?setup=done')
        return
      }
      const body = await res.json().catch(() => ({}))
      setError(typeof body.error === 'string' ? body.error : '设置失败，请重试')
      if (res.status === 409) router.replace('/login') // 已被并发设置
    } catch {
      setError('网络错误，请重试')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-brand">
          <Anchor size={18} />
          <span>Anchor</span>
        </div>
        <p className="auth-subtitle">
          首次运行：设置一个登录密码，之后访问本站点都需要它。
        </p>
        <form onSubmit={handleSubmit} style={{ visibility: checking ? 'hidden' : undefined }}>
          <div className="auth-field">
            <label htmlFor="setup-password">密码</label>
            <input
              id="setup-password"
              className="input"
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              placeholder="至少 8 位"
              autoFocus
              autoComplete="new-password"
            />
          </div>
          <div className="auth-field">
            <label htmlFor="setup-confirm">确认密码</label>
            <input
              id="setup-confirm"
              className="input"
              type="password"
              value={confirm}
              onChange={e => setConfirm(e.target.value)}
              placeholder="再输入一次"
              autoComplete="new-password"
            />
          </div>
          {error && <div className="auth-error" role="alert">{error}</div>}
          <div className="auth-actions">
            <button className="btn btn-primary" type="submit" disabled={submitting}>
              {submitting ? '设置中…' : '设置密码'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
