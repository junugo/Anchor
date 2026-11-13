import type { ApiError, Result } from '@anchor/types'

export interface ApiClientOptions {
  headers?: Record<string, string>
}

/**
 * 创建一个轻量 API 客户端。
 * 永不抛出——所有错误以 Result 模式返回，调用方通过 result.ok 判断。
 */
export function createApiClient(baseUrl: string, options: ApiClientOptions = {}) {
  async function request<T>(path: string, init?: RequestInit): Promise<Result<T>> {
    try {
      const res = await fetch(`${baseUrl}${path}`, {
        ...init,
        headers: { 'Content-Type': 'application/json', ...options.headers, ...init?.headers },
      })
      if (!res.ok) {
        const err: ApiError = { ok: false, code: res.status, message: res.statusText }
        return err
      }
      return { ok: true, data: (await res.json()) as T }
    } catch (e) {
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
