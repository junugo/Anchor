import type { Db } from '@anchor/db'
import { behaviorLogs, dissociationDiary } from '@anchor/db'
import { gte, and } from 'drizzle-orm'
import { DEV_TOOLS } from '../decision/engine'
import { getWorkProcesses, getWorkSites } from '../sites/work'

// 工作进程窗口焦点累计 ≥5min 视为有目的工作（与 feature-extractor 口径一致）
const WORK_PROCESS_MIN_MS = 5 * 60 * 1000

export function generateDiaryCandidates(db: Db): void {
  const now = Math.floor(Date.now() / 1000)
  const oneHourAgo = now - 60 * 60

  // 去重：该时段已有候选则跳过
  const exists = db
    .select({ id: dissociationDiary.id })
    .from(dissociationDiary)
    .where(and(
      gte(dissociationDiary.period_start, oneHourAgo - 5 * 60), // 5 分钟容差
      gte(dissociationDiary.period_end, oneHourAgo),
    ))
    .get()
  if (exists) return

  const logs = db
    .select()
    .from(behaviorLogs)
    .where(gte(behaviorLogs.logged_at, oneHourAgo))
    .all()

  if (logs.length < 3) return

  // ── 多源工作信号：窗口内有任何工作痕迹 → 有目的活动，不生成候选 ──
  // 浏览器查文档/GitHub 是正常工作，只看 code_active 会把研究工作误判为解离候选
  const workDomainSet = new Set(getWorkSites(db).map(d => d.toLowerCase()))
  const isWorkDomain = (raw: string): boolean => {
    const d = raw.toLowerCase().replace(/^www\./, '')
    if (workDomainSet.has(d)) return true
    // 子域名兜底：mail.github.com 命中 github.com
    for (const w of workDomainSet) { if (d.endsWith('.' + w)) return true }
    return false
  }
  const workProcessTokens = [...getWorkProcesses(db), ...DEV_TOOLS].map(p => p.toLowerCase())
  const isWorkProcess = (name: string): boolean => {
    const n = name.toLowerCase()
    return workProcessTokens.some(t => n === t || n.includes(t))
  }

  const hasCode = logs.some(l => l.event_type === 'code_active')
  const hasWorkVisit = logs.some(
    l => l.event_type === 'url_visit' && isWorkDomain(String(l.payload['domain'] ?? '')),
  )
  const workProcessMs = logs
    .filter(
      l => l.event_type === 'window_focus' &&
           l.payload['is_idle'] !== true &&
           isWorkProcess(String(l.payload['process'] ?? '')),
    )
    .reduce((sum, l) => sum + Number(l.payload['duration_ms'] ?? 0), 0)

  if (hasCode || hasWorkVisit || workProcessMs >= WORK_PROCESS_MIN_MS) return

  const screenOns = logs.filter(l => l.source === 'android' && l.event_type === 'screen_on').length
  // 工作域名不计入漂移域名数（上方工作访问已整体排除，此处为兜底）
  const domainChanges = new Set(
    logs
      .filter(l => l.source === 'chrome' && l.event_type === 'url_visit')
      .map(l => String(l.payload['domain'] ?? ''))
      .filter(Boolean)
      .filter(d => !isWorkDomain(d))
  ).size
  // 「无目标切换」只统计真实的切换类事件，不再用全部日志条数（普通使用 1 小时轻松超 20 条）
  const switchCount = logs.filter(l => l.event_type === 'tab_switch' || l.event_type === 'window_focus').length

  let label: string | null = null
  if (screenOns >= 10) {
    label = `${new Date(oneHourAgo * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}–${new Date(now * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}，手机亮屏 ${screenOns} 次，平均每次约 ${Math.round(60 / screenOns)} 分钟。`
  } else if (domainChanges >= 5) {
    label = `${new Date(oneHourAgo * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}–${new Date(now * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}，浏览器访问了 ${domainChanges} 个不同网站，停留时间都较短。`
  } else if (switchCount >= 60) {
    label = `${new Date(oneHourAgo * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}–${new Date(now * 1000).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}，检测到 ${switchCount} 次活动切换，无明确目标。`
  }

  if (!label) return

  db.insert(dissociationDiary).values({
    period_start: oneHourAgo,
    period_end: now,
    candidate_label: label,
    created_at: now,
  }).run()
}
