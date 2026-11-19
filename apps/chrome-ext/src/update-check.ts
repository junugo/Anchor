/**
 * 扩展更新提示（仅提示，不自动更新）：GitHub latest release 版本比对。
 * Chrome 端无专属发布资产，从 tag 中提取版本号（容忍 desktop-v/mobile-v/v 前缀）与 manifest 比对。
 */

export const LATEST_API = 'https://api.github.com/repos/junugo/Anchor/releases/latest'
export const RELEASES_PAGE = 'https://github.com/junugo/Anchor/releases/latest'
export const USER_AGENT = 'Anchor-Chrome'
/** 检查节流：启动一次 + 每 6 小时最多一次 */
export const CHECK_INTERVAL_MS = 6 * 3600 * 1000
const LAST_CHECK_KEY = 'anchor:update:lastCheckAt'

/** latest 是否比 current 新（x.y.z 语义比较，容忍 v 与端前缀） */
export function isNewerVersion(latest: string, current: string): boolean {
  const l = parseVersion(latest)
  const c = parseVersion(current)
  if (!l || !c) return false
  for (let i = 0; i < 3; i++) {
    if (l[i] !== c[i]) return l[i] > c[i]
  }
  return false
}

/** 解析 tag/版本字符串：去掉端前缀（desktop-/mobile-）与 v 前缀，取 x.y.z；非法返回 null */
export function parseVersion(s: string): [number, number, number] | null {
  const core = s
    .trim()
    .replace(/^(desktop|mobile|chrome|vscode)-/i, '')
    .replace(/^v/i, '')
    .split(/[-+]/)[0]
  const parts = core.split('.')
  if (parts.length === 0 || parts.length > 3) return null
  if (parts.some((p) => !/^\d+$/.test(p))) return null
  return [Number(parts[0] || 0), Number(parts[1] || 0), Number(parts[2] || 0)]
}

/** 从 release JSON 中提取版本号（tag_name 字段） */
export function parseLatestVersion(body: unknown): string | null {
  const tag = (body as { tag_name?: unknown })?.tag_name
  return typeof tag === 'string' && tag.trim() ? tag.trim() : null
}

/** 距离上次检查是否超过 6 小时（供测试与运行时共用） */
export function shouldCheck(nowMs: number, lastCheckMs: number): boolean {
  return nowMs - lastCheckMs >= CHECK_INTERVAL_MS
}

async function lastCheckAt(): Promise<number> {
  try {
    const v = (await chrome.storage.local.get(LAST_CHECK_KEY))[LAST_CHECK_KEY]
    return typeof v === 'number' ? v : 0
  } catch {
    return 0
  }
}

async function markChecked(nowMs: number): Promise<void> {
  try {
    await chrome.storage.local.set({ [LAST_CHECK_KEY]: nowMs })
  } catch {
    /* 存储失败静默 */
  }
}

/**
 * 检查是否有新版本；返回新版本号，无新版/失败返回 null（静默）。
 * 结果缓存在 sessionStorage 供选项页展示（选项页每次打开读缓存，不额外请求）。
 */
export async function checkForUpdate(currentVersion: string): Promise<string | null> {
  const now = Date.now()
  if (!shouldCheck(now, await lastCheckAt())) return readCached()
  await markChecked(now)
  try {
    const resp = await fetch(LATEST_API, { headers: { 'User-Agent': USER_AGENT } })
    if (!resp.ok) return readCached()
    const tag = parseLatestVersion(await resp.json())
    if (!tag) return null
    if (!isNewerVersion(tag, currentVersion)) return null
    try {
      sessionStorage.setItem('anchor:update:latest', tag)
    } catch {
      /* 忽略 */
    }
    return tag
  } catch {
    return readCached()
  }
}

function readCached(): string | null {
  try {
    return sessionStorage.getItem('anchor:update:latest')
  } catch {
    return null
  }
}
