'use client'

/**
 * (main) 路由组客户端认证守卫。
 * 挂载时查询公开端点 /api/me，按 resolveAuthRedirect 三态跳转；
 * 服务器层已有 302 兜底（lib/auth/guard.ts），这里是体验层（避免整页刷新）。
 */
import { useEffect, useState, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { resolveAuthRedirect, type MeState } from '@/lib/auth/redirect'

export function AuthGate({ children }: { children: ReactNode }) {
  const router = useRouter()
  const [ready, setReady] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetch('/api/me', { cache: 'no-store' })
      .then(r => r.json() as Promise<MeState>)
      .then(me => {
        if (cancelled) return
        const redirect = resolveAuthRedirect(me)
        if (redirect) router.replace(redirect)
        else setReady(true)
      })
      .catch(() => {
        // 查询失败（服务不可达等）：弹去 /login，由服务器 guard 再兜底
        if (!cancelled) router.replace('/login')
      })
    return () => { cancelled = true }
  }, [router])

  // 就绪前渲染与底色一致的占位，避免白屏闪烁
  if (!ready) {
    return <div style={{ minHeight: '100dvh', background: 'var(--bg)' }} aria-busy="true" />
  }
  return <>{children}</>
}
