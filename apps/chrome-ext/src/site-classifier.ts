import { domainMatches } from './utils'

export interface SiteClassificationEntry {
  high_stimulus: boolean
  source: string
  updated_at: number // unix seconds
}

export type SiteClassificationsCache = Record<string, SiteClassificationEntry>

interface ClassificationRow {
  domain: string
  high_stimulus: boolean
  classification_source: string
  updated_at: number
}

export interface SiteClassifierDeps {
  storageGet: (key: string) => Promise<SiteClassificationsCache>
  storageSet: (key: string, value: SiteClassificationsCache) => Promise<void>
  // POST 分类请求；返回 null 表示网络/服务不可用（上层随后重试）
  classifyRequest: (domain: string, siteName: string, url: string, faviconUrl?: string) => Promise<{ high_stimulus: boolean; source: string } | null>
  now?: () => number // unix ms，测试注入
}

export interface SiteClassifier {
  loadCache: () => Promise<void>
  seedFromServer: (serverUrl: string) => Promise<void>
  // 全量拉取服务器列表并替换本地缓存（手动同步），error 为失败原因
  syncFromServer: (serverUrl: string) => Promise<{ ok: boolean; error?: string }>
  status: (domain: string) => 'high' | 'low' | 'unknown'
  isHigh: (host: string) => boolean
  highSet: () => string[]
  ensureClassified: (domain: string, siteName?: string, url?: string, faviconUrl?: string) => void
  applyUpdate: (domain: string, entry: { high_stimulus: boolean; source: string }) => void
  applyDelete: (domain: string) => void
  getCacheSnapshot: () => SiteClassificationsCache
}

const STORAGE_KEY = 'anchor:site_classifications'
// 未知域名分类请求的最小间隔：同一域名 5 分钟内不重复请求
const RECLASSIFY_COOLDOWN_MS = 5 * 60 * 1000

export function createSiteClassifier(deps: SiteClassifierDeps): SiteClassifier {
  let cache: SiteClassificationsCache = {}
  const inFlight = new Set<string>()
  const lastRequestedAt = new Map<string, number>()
  const now = deps.now ?? (() => Date.now())

  async function persist(): Promise<void> {
    try {
      await deps.storageSet(STORAGE_KEY, cache)
    } catch { /* 存储失败不阻断流程 */ }
  }

  async function loadCache(): Promise<void> {
    try {
      cache = (await deps.storageGet(STORAGE_KEY)) ?? {}
    } catch {
      cache = {}
    }
  }

  async function seedFromServer(serverUrl: string): Promise<void> {
    // 直接从分类表全量灌入，避免首次使用期间对已识别域名重复请求
    try {
      const resp = await fetch(`${serverUrl}/api/sites/classifications`)
      if (!resp.ok) return
      const data = await resp.json() as { classifications: ClassificationRow[] }
      let changed = false
      for (const row of data.classifications ?? []) {
        if (row.classification_source === 'pending') continue
        const existing = cache[row.domain]
        // 服务器为权威来源，但保留本地更新的（updated_at 更大）
        if (!existing || (row.updated_at ?? 0) >= existing.updated_at) {
          cache[row.domain] = { high_stimulus: row.high_stimulus, source: row.classification_source, updated_at: row.updated_at }
          changed = true
        }
      }
      if (changed) await persist()
    } catch { /* 服务器不可用时忽略，沿用本地缓存 */ }
  }

  async function syncFromServer(serverUrl: string): Promise<{ ok: boolean; error?: string }> {
    // 全量拉取服务器分类列表，替换本地缓存（pending 行跳过，等下次触发重新分类）
    let resp: Response
    try {
      resp = await fetch(`${serverUrl}/api/sites/classifications`)
    } catch (e) {
      return { ok: false, error: `无法连接服务器: ${e instanceof Error ? e.message : String(e)}` }
    }
    if (!resp.ok) return { ok: false, error: `服务器返回 HTTP ${resp.status}` }
    try {
      const data = await resp.json() as { classifications: ClassificationRow[] }
      const next: SiteClassificationsCache = {}
      for (const row of data.classifications ?? []) {
        if (row.classification_source === 'pending') continue
        next[row.domain] = { high_stimulus: row.high_stimulus, source: row.classification_source, updated_at: row.updated_at }
      }
      cache = next
      await persist()
      return { ok: true }
    } catch {
      return { ok: false, error: '响应解析失败' }
    }
  }

  function status(domain: string): 'high' | 'low' | 'unknown' {
    const entry = cache[domain]
    if (!entry) return 'unknown'
    return entry.high_stimulus ? 'high' : 'low'
  }

  function isHigh(host: string): boolean {
    // 缓存按精确域名存储，host 可能是其子域名，逐条匹配
    for (const [domain, entry] of Object.entries(cache)) {
      if (entry.high_stimulus && domainMatches(host, domain)) return true
    }
    return false
  }

  function highSet(): string[] {
    const set = new Set<string>()
    for (const [domain, entry] of Object.entries(cache)) {
      if (entry.high_stimulus) set.add(domain)
    }
    return [...set]
  }

  function ensureClassified(domain: string, siteName = domain, url = '', faviconUrl?: string): void {
    if (!domain) return
    // 已知（精确缓存、或其父域已在缓存/配置中）则不重复请求
    if (status(domain) !== 'unknown') return
    if (isHigh(domain)) return
    for (const knownDomain of Object.keys(cache)) {
      if (domainMatches(domain, knownDomain)) return
    }
    if (inFlight.has(domain)) return
    const requestedAt = lastRequestedAt.get(domain) ?? 0
    if (now() - requestedAt < RECLASSIFY_COOLDOWN_MS) return
    inFlight.add(domain)
    lastRequestedAt.set(domain, now())
    void deps.classifyRequest(domain, siteName, url, faviconUrl)
      .then((result) => {
        if (result) {
          cache[domain] = { high_stimulus: result.high_stimulus, source: result.source, updated_at: Math.floor(now() / 1000) }
          return persist()
        }
      })
      .catch(() => { /* 分类失败不阻断，cooldown 后可重试 */ })
      .finally(() => inFlight.delete(domain))
  }

  function applyUpdate(domain: string, entry: { high_stimulus: boolean; source: string }): void {
    if (!domain) return
    cache[domain] = { high_stimulus: entry.high_stimulus, source: entry.source, updated_at: Math.floor(now() / 1000) }
    void persist()
  }

  function applyDelete(domain: string): void {
    delete cache[domain]
    lastRequestedAt.delete(domain)
    void persist()
  }

  function getCacheSnapshot(): SiteClassificationsCache {
    return { ...cache }
  }

  return {
    loadCache,
    seedFromServer,
    syncFromServer,
    status,
    isHigh,
    highSet,
    ensureClassified,
    applyUpdate,
    applyDelete,
    getCacheSnapshot,
  }
}
