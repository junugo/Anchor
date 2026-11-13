import type { BehaviorEventType } from '@anchor/types'
import { getDomain } from './utils'

export interface RuntimeState {
  tabActivatedAt: Record<number, number>
  lastDomain: string
  lastSwitchAt: number
  newTabsWindow: number[]
  lastExplosionSentAt: number
}

export interface TabMonitorDeps {
  state: RuntimeState
  saveRuntimeState: () => Promise<void>
  sendBehavior: (event_type: BehaviorEventType, payload: Record<string, unknown>) => void
  // 动态高刺激判定（来自服务器同步 + 自动识别的分类缓存）
  isHighStimulusDomain: (domain: string) => boolean
  // 未知域名触发后台自动分类（fire-and-forget）
  ensureClassified: (domain: string, siteName: string, url: string, faviconUrl?: string) => void
}

export function startTabMonitoring(deps: TabMonitorDeps) {
  function reportVisit(url: string, domain: string, title: string, durationSeconds: number, faviconUrl?: string) {
    const payload: Record<string, unknown> = {
      url,
      domain,
      duration_seconds: durationSeconds,
      title,
      high_stimulus: deps.isHighStimulusDomain(domain),
    }
    deps.sendBehavior('url_visit', payload)
    deps.ensureClassified(domain, title || domain, url, faviconUrl)
  }

  chrome.tabs.onActivated.addListener(async ({ tabId }) => {
    const now = Date.now()
    deps.state.tabActivatedAt[tabId] = now
    await deps.saveRuntimeState()
    try {
      const tab = await chrome.tabs.get(tabId)
      const toDomain = tab.url ? getDomain(tab.url) : ''
      deps.sendBehavior('tab_switch', {
        from_domain: deps.state.lastDomain,
        to_domain: toDomain,
        switch_interval_ms: now - deps.state.lastSwitchAt,
      })
      deps.state.lastDomain = toDomain
      deps.state.lastSwitchAt = now
      await deps.saveRuntimeState()
      // 激活已加载完成的标签不会触发 url_visit，需在此补分类；
      // 加载中的标签跳过，等 onUpdated complete 时才有标题与图标
      if (toDomain && tab.url && tab.status === 'complete') {
        deps.ensureClassified(toDomain, tab.title || toDomain, tab.url, tab.favIconUrl)
      }
    } catch { /* tab 可能已关闭 */ }
  })

  chrome.tabs.onCreated.addListener(async () => {
    const now = Date.now()
    deps.state.newTabsWindow.push(now)
    deps.state.newTabsWindow = deps.state.newTabsWindow.filter(t => now - t < 5 * 60 * 1000)
    await deps.saveRuntimeState()
    if (deps.state.newTabsWindow.length >= 6 && now - deps.state.lastExplosionSentAt > 5 * 60 * 1000) {
      deps.state.lastExplosionSentAt = now
      await deps.saveRuntimeState()
      try {
        const allTabs = await chrome.tabs.query({})
        deps.sendBehavior('tab_explosion', {
          tab_count: allTabs.length,
          new_tabs_in_last_5min: deps.state.newTabsWindow.length,
        })
      } catch { /* ignore */ }
    }
  })

  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status !== 'complete' || !tab.url) return
    const domain = getDomain(tab.url)
    if (!domain) return
    const activatedAt = deps.state.tabActivatedAt[tabId] ?? Date.now()
    const durationSeconds = Math.round((Date.now() - activatedAt) / 1000)
    deps.state.tabActivatedAt[tabId] = Date.now()
    deps.saveRuntimeState()
    // 过滤临时访问：只上报停留 ≥5 秒的网站，避免搜索结果页/快速关闭标签污染数据
    if (durationSeconds >= 5) {
      reportVisit(tab.url ?? '', domain, tab.title ?? '', durationSeconds, tab.favIconUrl)
    }
  })

  return { reportVisit }
}
