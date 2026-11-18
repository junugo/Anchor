'use client'

/**
 * /login — 密码登录页。
 * hasPassword=false → 跳 /setup；成功登录 → 整页跳 /，让 layout 守卫重新取状态。
 */
import { useEffect, useState, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { Anchor } from 'lucide-react'
import { resolveAuthRedirect, type MeState } from '@/lib/auth/redirect'

export default function LoginPage() {
  const router = useRouter()
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  // 已登录 → 回首页；未设密码 → /setup。?setup=done 显示设置成功提示。
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get('setup') === 'done') {
      setNotice('密码已设置，请登录')
    }
    let cancelled = false
    fetch('/api/me', { cache: 'no-store' })
      .then(r => r.json() as Promise<MeState>)
      .then(me => {
        if (cancelled) return
        const redirect = resolveAuthRedirect(me)
        if (redirect === '/setup') router.replace('/setup')
        else if (redirect === null) window.location.href = '/'
      })
      .catch(() => { /* 查询失败不阻塞登录表单，提交时由服务端兜底 */ })
    return () => { cancelled = true }
  }, [router])

  async function handleSubmit(e: FormEvent) {
    e.preventDefault()
    setError(null)
    if (!password) {
      setError('请输入密码')
      return
    }
    setSubmitting(true)
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      })
      if (res.ok) {
        window.location.href = '/'
        return
      }
      const body = await res.json().catch(() => ({}))
      setError(typeof body.error === 'string' ? body.error : '登录失败，请重试')
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
        <form onSubmit={handleSubmit}>
          <div className="auth-field">
            <label htmlFor="login-password">密码</label>
            <input
              id="login-password"
              className="input"
              type="password"
              value={password}
              onChange={e => setPassword(e.target.value)}
              autoFocus
              autoComplete="current-password"
            />
          </div>
          {notice && <div className="auth-notice">{notice}</div>}
          {error && <div className="auth-error" role="alert">{error}</div>}
          <div className="auth-actions">
            <button className="btn btn-primary" type="submit" disabled={submitting}>
              {submitting ? '登录中…' : '登录'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}
