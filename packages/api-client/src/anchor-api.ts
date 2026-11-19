/**
 * 共享 API 消费层——封装所有 Anchor 服务器路由。
 */
import { createApiClient } from './index'
import type { ApiClientOptions, Result } from './index'
import type {
  BehaviorLog,
  UserLivingContext,
  CircadianLog,
  SunsetConfig,
  ChatMessage,
  TimeCapsule,
} from '@anchor/types'

export function createAnchorApiClient(baseUrl: string, options: ApiClientOptions = {}) {
  const http = createApiClient(baseUrl, options)

  return {
    // ─── 设备配对 / 版本 ───
    /** 设备配对：用配对码换取设备令牌与数据密钥 */
    pair(
      code: string,
      deviceName: string,
      clientVersion?: string,
    ): Promise<Result<{ token: string; dataKey: string; serverVersion: string; deviceId: string }>> {
      return http.post('/api/pair', { code, deviceName, clientVersion })
    },
    /** 获取服务器版本信息（无需认证） */
    getVersion(): Promise<Result<{ version: string }>> {
      return http.get('/api/version')
    },
    // 鈹€鈹€鈹€ 鐘舵€?鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
    getStatus(): Promise<Result<UserLivingContext>> {
      return http.get('/api/status')
    },

    // 鈹€鈹€鈹€ 琛屼负鎽勫叆 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
    ingestBatch(logs: Array<{
      source: string
      event_type: string
      payload: Record<string, unknown>
      logged_at?: number
      location_zone?: string
    }>): Promise<Result<{ ok: boolean; ingested: number }>> {
      return http.post('/api/ingest/batch', { logs })
    },

    // 鈹€鈹€鈹€ 鑺傚緥鏁版嵁 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
    getCircadian(days = 7): Promise<Result<CircadianLog[]>> {
      return http.get(`/api/circadian?days=${days}`)
    },
    postCircadianEvent(event: string): Promise<Result<{ ok: boolean }>> {
      return http.post('/api/circadian', { event })
    },

    // 鈹€鈹€鈹€ 鏃ヨ惤閰嶇疆 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
    getSunsetConfig(): Promise<Result<SunsetConfig>> {
      return http.get('/api/sunset')
    },
    updateSunsetConfig(config: Partial<SunsetConfig>): Promise<Result<SunsetConfig>> {
      return http.post('/api/sunset', config)
    },

    // 鈹€鈹€鈹€ AI 瀵硅瘽 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
    getMessages(): Promise<Result<ChatMessage[]>> {
      return http.get('/api/ai/chat')
    },
    sendMessage(content: string): Promise<Result<ChatMessage>> {
      return http.post('/api/ai/chat', { content })
    },

    // 鈹€鈹€鈹€ 鏃堕棿鑳跺泭 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
    getCapsules(): Promise<Result<TimeCapsule[]>> {
      return http.get('/api/capsules')
    },
    playCapsule(id: number): Promise<Result<{ ok: boolean }>> {
      return http.post(`/api/capsules/${id}/play`, {})
    },

    // 鈹€鈹€鈹€ 鏁版嵁姹囨€?鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€
    getSummary(): Promise<Result<{ summary: string; circadian: CircadianLog[] }>> {
      return http.get('/api/summary')
    },
  }
}

export type AnchorApiClient = ReturnType<typeof createAnchorApiClient>

