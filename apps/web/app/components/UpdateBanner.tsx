'use client'

import { useEffect, useState } from 'react'
import { shouldShowUpdateBanner } from '@/lib/update/banner'

interface UpdateInfo {
  current: string
  latest: string | null
  htmlUrl: string | null
  publishedAt: string | null
  updateAvailable: boolean
}

const DISMISS_KEY = 'anchor-update-banner-dismissed'

/**
 * UpdateBanner — dashboard 顶部更新横幅。
 * 挂载时检查 /api/update；有新版显示紧凑琥珀色横幅；
 * 关闭按钮写入 sessionStorage，本次会话不再显示。
 */
export function UpdateBanner() {
  const [info, setInfo] = useState<UpdateInfo | null>(null)
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    // 会话内已关闭过则不再请求 /api/update
    let wasDismissed = false
    try {
      wasDismissed = sessionStorage.getItem(DISMISS_KEY) === '1'
    } catch {
      wasDismissed = false
    }
    if (wasDismissed) {
      setDismissed(true)
      return
    }
    let cancelled = false
    fetch('/api/update', { cache: 'no-store' })
      .then((res) => (res.ok ? res.json() : null))
      .then((data: UpdateInfo | null) => {
        if (!cancelled && data) setInfo(data)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  if (!info || !shouldShowUpdateBanner(info.updateAvailable, dismissed)) return null

  return (
    <div
      role="alert"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '6px 12px',
        fontSize: 13,
        background: 'color-mix(in srgb, #b08800 12%, transparent)',
        color: '#b08800',
        borderBottom: '1px solid color-mix(in srgb, #b08800 30%, transparent)',
      }}
    >
      <span style={{ flex: 1 }}>
        发现新版本 {info.latest}（当前 {info.current}）
        {info.htmlUrl && (
          <>
            {' '}
            →{' '}
            <a
              href={info.htmlUrl}
              target="_blank"
              rel="noreferrer"
              style={{ color: 'inherit', textDecoration: 'underline' }}
            >
              查看发布页
            </a>
          </>
        )}
      </span>
      <button
        type="button"
        aria-label="关闭更新提示"
        onClick={() => {
          try {
            sessionStorage.setItem(DISMISS_KEY, '1')
          } catch {
            // sessionStorage 不可用时仅本次组件内隐藏
          }
          setDismissed(true)
        }}
        style={{
          background: 'none',
          border: 'none',
          color: 'inherit',
          cursor: 'pointer',
          fontSize: 14,
          lineHeight: 1,
          padding: '2px 4px',
        }}
      >
        ×
      </button>
    </div>
  )
}
