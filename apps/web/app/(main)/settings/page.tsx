import Link from 'next/link'
import { ChevronRight, Sunset, Clock, Download, GraduationCap } from 'lucide-react'

const ITEMS = [
  { href: '/settings/sunset', icon: Sunset,   label: '数字宵禁',   desc: '入睡前逐步降低屏幕刺激' },
  { href: '/settings/school', icon: GraduationCap, label: '学校作息', desc: '在校时段无信号记为「在校」，不干预' },
  { href: '/capsules',        icon: Clock,     label: '时间胶囊',   desc: '给未来的自己留言' },
  { href: '/api/data/export', icon: Download,  label: '导出全部数据', desc: 'JSON 格式备份' },
]

export default function SettingsPage() {
  return (
    <div className="page" style={{ maxWidth: '480px' }}>
      <div className="page-header">
        <h1 className="page-title">设置</h1>
      </div>

      <div className="list-group">
        {ITEMS.map(({ href, icon: Icon, label, desc }) => (
          <Link key={href} href={href} className="list-item">
            <Icon size={16} style={{ color: 'var(--text-secondary)', flexShrink: 0 }} />
            <span className="item-label">
              <span style={{ display: 'block' }}>{label}</span>
              <span style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>{desc}</span>
            </span>
            <ChevronRight size={14} className="item-chevron" />
          </Link>
        ))}
      </div>
    </div>
  )
}
