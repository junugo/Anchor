/**
 * VS Code 扩展更新提示（仅提示，不自动更新）。
 * 激活时检查一次，之后每 6h 检查一次（setInterval deactivate 后失效，重启再补上）；
 * 提示节流：globalState 记 last_notified_date，一天最多弹一次；失败静默。
 */

export const LATEST_API = 'https://api.github.com/repos/junugo/Anchor/releases/latest'
export const RELEASES_PAGE = 'https://github.com/junugo/Anchor/releases/latest'
export const USER_AGENT = 'Anchor-VSCode'
/** 检查间隔：6 小时 */
export const CHECK_INTERVAL_MS = 6 * 3600 * 1000
/** 提示节流键：globalState 存 yyyy-mm-dd 字符串 */
export const LAST_NOTIFIED_KEY = 'anchor.update.lastNotifiedDate'

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

/** 解析 tag/版本字符串：去掉端前缀与 v 前缀，取 x.y.z；非法返回 null */
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

/** 从 release JSON 中提取版本号 */
export function parseLatestVersion(body: unknown): string | null {
  const tag = (body as { tag_name?: unknown })?.tag_name
  return typeof tag === 'string' && tag.trim() ? tag.trim() : null
}

/** 今天是否已提示过（dateStr 为 yyyy-mm-dd） */
export function alreadyNotifiedToday(todayStr: string, lastNotified: unknown): boolean {
  return lastNotified === todayStr
}

export function todayString(now: Date = new Date()): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** 网络检查：返回新版本号；无新版/失败返回 null（静默） */
export async function fetchLatestVersion(): Promise<string | null> {
  try {
    const resp = await fetch(LATEST_API, { headers: { 'User-Agent': USER_AGENT } })
    if (!resp.ok) return null
    return parseLatestVersion(await resp.json())
  } catch {
    return null
  }
}
