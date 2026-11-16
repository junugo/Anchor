// AI 提供商配置（BYOK）：统一从环境变量解析，支持任意 OpenAI 兼容端点
//
// 三个环境变量（写入 apps/web/.env）：
//   ANCHOR_AI_BASE_URL — 兼容端点前缀，默认 https://api.deepseek.com/v1
//                        （OpenAI: https://api.openai.com/v1
//                         Ollama: http://localhost:11434/v1
//                         OpenRouter: https://openrouter.ai/api/v1）
//   ANCHOR_AI_API_KEY  — 提供商密钥（不配置则所有 AI 功能静默降级）
//   ANCHOR_AI_MODEL    — 模型名，默认 deepseek-chat
//
// 注意：旧版变量 DEEPSEEK_API_KEY 已移除，迁移 = 改名为 ANCHOR_AI_API_KEY。

export interface AiProviderConfig {
  /** 归一化后的端点前缀（无尾斜杠、无 /chat/completions 后缀） */
  baseUrl: string
  apiKey: string
  model: string
}

const DEFAULT_BASE_URL = 'https://api.deepseek.com/v1'
const DEFAULT_MODEL = 'deepseek-chat'

/** 去掉尾斜杠与用户可能误填的 /chat/completions 后缀 */
export function normalizeBaseUrl(raw: string): string {
  let url = raw.trim()
  while (url.endsWith('/')) url = url.slice(0, -1)
  if (url.endsWith('/chat/completions')) url = url.slice(0, -'/chat/completions'.length)
  while (url.endsWith('/')) url = url.slice(0, -1)
  return url
}

/** 解析 AI 配置；未配置 ANCHOR_AI_API_KEY 时返回 null（调用方走静默降级） */
export function resolveAiConfig(): AiProviderConfig | null {
  const apiKey = process.env['ANCHOR_AI_API_KEY']?.trim()
  if (!apiKey) return null
  const baseUrl = normalizeBaseUrl(process.env['ANCHOR_AI_BASE_URL'] ?? DEFAULT_BASE_URL)
  const model = process.env['ANCHOR_AI_MODEL']?.trim() || DEFAULT_MODEL
  return { baseUrl, apiKey, model }
}

export function chatCompletionsUrl(cfg: AiProviderConfig): string {
  return `${cfg.baseUrl}/chat/completions`
}

export type ChatMessage = { role: 'system' | 'user' | 'assistant'; content: string }

export interface ChatCompletionParams {
  messages: ChatMessage[]
  max_tokens?: number
  temperature?: number
  /** 额外透传字段（如 stream / response_format），调用方按需覆盖 */
  extra?: Record<string, unknown>
  signal?: AbortSignal
}

/** 统一发起 chat completions 请求，返回原始 Response（调用方自行解析与降级） */
export async function chatCompletion(
  cfg: AiProviderConfig,
  params: ChatCompletionParams
): Promise<Response> {
  return fetch(chatCompletionsUrl(cfg), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify({
      model: cfg.model,
      messages: params.messages,
      ...(params.max_tokens !== undefined ? { max_tokens: params.max_tokens } : {}),
      ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
      ...params.extra,
    }),
    signal: params.signal,
  })
}

/** 启动日志用：密钥脱敏（前 3 位 + … + 后 4 位），未配置返回 null */
export function maskApiKey(apiKey: string): string {
  if (apiKey.length <= 7) return '…' + apiKey.slice(-2)
  return `${apiKey.slice(0, 3)}…${apiKey.slice(-4)}`
}
