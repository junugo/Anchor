export interface User {
  id: string
  name: string
  email: string
}

/** 成功响应 */
export interface ApiOk<T> {
  ok: true
  data: T
}

/** 错误响应（不抛出，以 Result 模式返回） */
export interface ApiError {
  ok: false
  code: number
  message: string
}

/** Result<T> = ApiOk<T> | ApiError */
export type Result<T> = ApiOk<T> | ApiError

/** @deprecated 用 Result<T> / ApiOk<T> 替代 */
export type ApiResponse<T> = ApiOk<T>

/** 高刺激/娱乐使用上下文（/api/friction/usage-context） */
export interface FrictionUsageContext {
  today_entertainment_ms: number
  consecutive_high_entertainment_days: number
  today_entertainment_formatted: string
  timestamp: number
}

/** @deprecated 用 FrictionUsageContext 替代 */
export type UsageContext = FrictionUsageContext
