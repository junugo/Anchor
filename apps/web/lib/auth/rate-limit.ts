// 内存限频：窗口计数 + 惰性清理。键的拼装交给调用方（如 login:${ip}、pair:${ip}）。
interface Bucket {
  count: number
  resetAt: number
}

export interface RateLimiter {
  /** true=放行，false=超限 */
  limit(key: string, limit: number, windowMs: number): boolean
  /** 清空全部计数（测试用） */
  reset(): void
}

export function createRateLimiter(): RateLimiter {
  const buckets = new Map<string, Bucket>()
  const MAX_KEYS = 1000 // 键滞留兜底：超过即整表清空（公网部署防内存膨胀）

  return {
    limit(key: string, limit: number, windowMs: number): boolean {
      const now = Date.now()
      const bucket = buckets.get(key)
      // 窗口已过期则惰性重建（顺带完成清理，不必另起定时器）
      if (!bucket || bucket.resetAt <= now) {
        if (buckets.size >= MAX_KEYS) buckets.clear()
        buckets.set(key, { count: 1, resetAt: now + windowMs })
        return true
      }
      bucket.count += 1
      return bucket.count <= limit
    },
    reset(): void {
      buckets.clear()
    },
  }
}
