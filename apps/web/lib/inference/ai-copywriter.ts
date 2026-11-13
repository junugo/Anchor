import type { UserState, InterventionLevel } from '@anchor/types'
import { nowContext, STATE_ZH, LEVEL_TONE, NOTIFICATION_RULE } from '../ai/promptUtils'

// 各状态的兜底文案（AI 调用失败或禁语过滤时使用）
export const FALLBACK_MESSAGES: Record<UserState, string> = {
  dissociating: '已经有一段时间了，回来一下？',
  entertaining: '玩了一会儿了，时间过得挺快的。',
  resting: '该睡了，明天还有事。',
  working: '专注了很久了，可以休息一会儿。',
  sleeping: '晚安，好好休息。',
  transitioning: '现在在做什么？',
  // away 由日程短路直出（do_not_disturb），不会走到文案生成；仅满足类型完备
  away: '在学校呢，专心上课，回头见。',
}

// 禁止出现的命令式词汇（'必须' 已覆盖 '你必须'，不重复列）
const FORBIDDEN = ['你应该', '必须']

// 构造 AI 文案生成 prompt
export function buildCopyPrompt(state: UserState, level: InterventionLevel): string {
  return [
    '你是温暖、不评判的数字室友。为以下情境生成一句中文提醒。',
    `当前真实时间：${nowContext()}`,
    `用户当前状态：${STATE_ZH[state]}（${state}）`,
    `干预级别：${level} — ${LEVEL_TONE[level]}`,
    '要求：≤80字，体感优先，禁止「你应该」「你必须」，允许关心式提问与时间锚定。',
    NOTIFICATION_RULE,
  ].join('\n')
}

// 清洗 AI 输出：去空白、截断 80 字、命中禁语则回退 fallback
export function sanitizeMessage(raw: string, state: UserState = 'transitioning'): string {
  const trimmed = raw.trim()
  if (trimmed.length === 0) return FALLBACK_MESSAGES[state]
  if (FORBIDDEN.some(f => trimmed.includes(f))) return FALLBACK_MESSAGES[state]
  return trimmed.length > 80 ? trimmed.slice(0, 80) : trimmed
}

// 实际生成：10s 超时，失败回退 fallback
export async function generateCopy(state: UserState, level: InterventionLevel): Promise<string> {
  try {
    const apiKey = process.env['DEEPSEEK_API_KEY']
    if (!apiKey) return FALLBACK_MESSAGES[state]
    const resp = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: buildCopyPrompt(state, level) }],
        max_tokens: 120,   // 文案 ≤80 字，预留余量
        temperature: 0.85, // 文案需多样性，高于仲裁的 0.3
      }),
      signal: AbortSignal.timeout(10_000),
    })
    if (!resp.ok) throw new Error(`DeepSeek API error: ${resp.status}`)
    const data = await resp.json() as { choices?: Array<{ message?: { content?: string } }> }
    const content = data.choices?.[0]?.message?.content ?? ''
    return sanitizeMessage(content, state)
  } catch {
    return FALLBACK_MESSAGES[state]
  }
}
