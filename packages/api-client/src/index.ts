import type { ApiError, Result } from '@anchor/types'

export interface ApiClientOptions {
  headers?: Record<string, string>
  /** 设备令牌：存在时自动注入 Authorization: Bearer <token> */
  token?: string
}

/** 认证错误：HTTP 401（未认证 / 配对失效）。附带响应状态信息，调用方可据此区分配对失效与其他错误 */
export class AuthError extends Error {
  readonly status: number
  readonly statusText: string
  constructor(status: number, statusText: string) {
    super(`认证失败（${status} ${statusText}）：设备令牌无效或配对已失效`)
    this.name = 'AuthError'
    this.status = status
    this.statusText = statusText
  }
}

/**
 * 创建一个轻量 API 客户端。
 * 除 401 会抛 AuthError 外永不抛出——其余错误以 Result 模式返回，调用方通过 result.ok 判断。
 */
export function createApiClient(baseUrl: string, options: ApiClientOptions = {}) {
  async function request<T>(path: string, init?: RequestInit): Promise<Result<T>> {
    try {
      const res = await fetch(`${baseUrl}${path}`, {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
          ...options.headers,
          ...init?.headers,
        },
      })
      if (res.status === 401) {
        throw new AuthError(res.status, res.statusText)
      }
      if (!res.ok) {
        const err: ApiError = { ok: false, code: res.status, message: res.statusText }
        return err
      }
      return { ok: true, data: (await res.json()) as T }
    } catch (e) {
      if (e instanceof AuthError) throw e
      const err: ApiError = {
        ok: false,
        code: 0,
        message: e instanceof Error ? e.message : 'Network error',
      }
      return err
    }
  }

  return {
    get:  <T>(path: string) => request<T>(path),
    post: <T>(path: string, body: unknown) =>
      request<T>(path, { method: 'POST', body: JSON.stringify(body) }),
    put:  <T>(path: string, body: unknown) =>
      request<T>(path, { method: 'PUT',  body: JSON.stringify(body) }),
    del:  <T>(path: string) =>
      request<T>(path, { method: 'DELETE' }),
  }
}

export type { Result, ApiError } from '@anchor/types'

// Anchor 业务 API 客户端（合并自 @anchor/store）
export { createAnchorApiClient } from './anchor-api'
export type { AnchorApiClient } from './anchor-api'
