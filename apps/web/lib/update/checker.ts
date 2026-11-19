// GitHub Release 更新检查器：查询 junugo/Anchor 最新发布。
// 失败静默（返回 null），进程内缓存 12h，测试可注入缓存/重置。

export interface ReleaseInfo {
  tagName: string
  htmlUrl: string
  publishedAt: string
  body?: string
}

const GITHUB_LATEST_RELEASE_URL =
  'https://api.github.com/repos/junugo/Anchor/releases/latest'
const FETCH_TIMEOUT_MS = 5000
export const RELEASE_CACHE_TTL_MS = 12 * 60 * 60 * 1000 // 12h
/** 检查失败（null）用短 TTL，网络恢复后 1h 内即可重试 */
export const RELEASE_FAILURE_CACHE_TTL_MS = 60 * 60 * 1000 // 1h
const BODY_MAX_LENGTH = 500

interface ReleaseCache {
  result: ReleaseInfo | null
  checkedAt: number
  ttlMs: number
}

let cache: ReleaseCache | null = null

/** 测试用：重置进程内缓存，强制下次真实请求 */
export function resetReleaseCache(): void {
  cache = null
}

/** 测试用：直接注入缓存（配合假时钟验证 TTL 行为） */
export function injectReleaseCache(result: ReleaseInfo | null, checkedAt: number): void {
  cache = { result, checkedAt, ttlMs: RELEASE_CACHE_TTL_MS }
}

/**
 * 查询最新 Release。任何失败（网络/超时/非 200/解析异常）均静默返回 null。
 * now 可注入以便测试缓存过期逻辑。
 */
export async function checkLatestRelease(now: number = Date.now()): Promise<ReleaseInfo | null> {
  if (cache && now - cache.checkedAt < cache.ttlMs) {
    return cache.result
  }

  let result: ReleaseInfo | null = null
  try {
    const res = await fetch(GITHUB_LATEST_RELEASE_URL, {
      // GitHub API 要求 User-Agent，否则 403
      headers: { 'User-Agent': 'Anchor-Server' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    })
    if (res.ok) {
      const data = await res.json()
      if (data && typeof data.tag_name === 'string') {
        result = {
          tagName: data.tag_name,
          htmlUrl: typeof data.html_url === 'string' ? data.html_url : '',
          publishedAt: typeof data.published_at === 'string' ? data.published_at : '',
          body:
            typeof data.body === 'string' ? data.body.slice(0, BODY_MAX_LENGTH) : undefined,
        }
      }
    }
  } catch {
    result = null // 静默：更新检查不可影响主流程
  }

  const ttlMs = result ? RELEASE_CACHE_TTL_MS : RELEASE_FAILURE_CACHE_TTL_MS
  cache = { result, checkedAt: now, ttlMs }
  return result
}

/**
 * 版本比对：latest 是否比 current 新。
 * 剥离 v 前缀，按 semver 数值段比较；含预发布标识时，同版本号下带标识者视为更旧。
 * 非规范格式（不是 x.y.z 数字段）返回 false。
 */
export function isNewerVersion(latest: string, current: string): boolean {
  const parse = (v: string): { nums: number[]; prerelease: boolean } | null => {
    const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/.exec(v.trim())
    if (!m) return null
    return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], prerelease: !!m[4] }
  }
  const a = parse(latest)
  const b = parse(current)
  if (!a || !b) return false
  for (let i = 0; i < 3; i++) {
    if (a.nums[i] !== b.nums[i]) return a.nums[i] > b.nums[i]
  }
  // 版本号相同：预发布 < 正式版
  return b.prerelease && !a.prerelease
}
