/**
 * 服务器连接配置（服务器地址 + 上行数据密钥）。
 *
 * 取值优先级：chrome.storage.local 用户配置 > 构建期 VITE_* 环境变量。
 * dataKey 为 null 表示未配置：background 在加密上报处显式拒绝（提示需配置数据密钥，
 * 等待后续配对流程改造），绝不回落任何内置密钥。
 * 用户在扩展选项页保存后即时生效：background 订阅 onServerConfigChange 自动重连，
 * 无需重新加载扩展或重新打包。
 */

export interface ServerConfig {
  serverUrl: string
  /** 上行数据密钥；null = 未配置（须在选项页填写或等待配对改造） */
  dataKey: string | null
}

const STORAGE_KEYS = {
  serverUrl: 'anchor:serverUrl',
  dataKey: 'anchor:dataKey',
} as const

const ENV_DEFAULTS: ServerConfig = {
  serverUrl: (import.meta.env.VITE_ANCHOR_SERVER as string | undefined)?.trim() || 'http://localhost:4000',
  dataKey: (import.meta.env.VITE_ANCHOR_DATA_KEY as string | undefined)?.trim() || null,
}

let cached: ServerConfig = { ...ENV_DEFAULTS }

/** 从 chrome.storage.local 加载用户配置并刷新缓存；background 启动时调用一次 */
export async function loadServerConfig(): Promise<ServerConfig> {
  const stored = await chrome.storage.local.get([STORAGE_KEYS.serverUrl, STORAGE_KEYS.dataKey])
  cached = {
    serverUrl: (stored[STORAGE_KEYS.serverUrl] as string | undefined)?.trim() || ENV_DEFAULTS.serverUrl,
    dataKey: (stored[STORAGE_KEYS.dataKey] as string | undefined)?.trim() || ENV_DEFAULTS.dataKey,
  }
  return cached
}

/** 当前生效配置（同步读取缓存；loadServerConfig 完成前为构建期/内置默认） */
export function getServerConfig(): ServerConfig {
  return cached
}

/** 保存用户配置到 chrome.storage.local 并刷新缓存；空白值视为清除（dataKey 归 null） */
export async function saveServerConfig(patch: Partial<ServerConfig>): Promise<void> {
  const next: ServerConfig = {
    serverUrl: patch.serverUrl?.trim() || ENV_DEFAULTS.serverUrl,
    dataKey: patch.dataKey?.trim() || ENV_DEFAULTS.dataKey,
  }
  const entries: Record<string, string> = {}
  if (patch.serverUrl !== undefined) entries[STORAGE_KEYS.serverUrl] = patch.serverUrl
  if (patch.dataKey !== undefined) entries[STORAGE_KEYS.dataKey] = patch.dataKey ?? ''
  await chrome.storage.local.set(entries)
  cached = next
}

/** 用户配置变更订阅（选项页保存后 background 重连用） */
export function onServerConfigChange(handler: (cfg: ServerConfig) => void): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return
    if (!changes[STORAGE_KEYS.serverUrl] && !changes[STORAGE_KEYS.dataKey]) return
    void loadServerConfig().then(handler)
  })
}

/** http(s) 服务器地址 → ws(s) WebSocket 地址 */
export function wsUrlFor(serverUrl: string): string {
  return serverUrl.trim().replace(/^http/, 'ws').replace(/\/+$/, '') + '/ws'
}
