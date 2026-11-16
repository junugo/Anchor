import { chatCompletion, resolveAiConfig } from './provider'

export const DIARY_LABELS = ['active_rest', 'attention_break', 'dissociation'] as const
export type DiaryLabel = typeof DIARY_LABELS[number]

export interface DiaryEvent { event_type: string; domain?: string; at: string }

export function buildClassifyPrompt(events: DiaryEvent[]): string {
  const lines = events.map(e => `- ${e.at} ${e.event_type}${e.domain ? ' ' + e.domain : ''}`).join('\n')
  return [
    '请将以下一段用户行为归类为三种之一：',
    'active_rest（主动休息，有益）/ attention_break（短暂走神）/ dissociation（解离，需关注）',
    '事件序列：',
    lines,
    '只返回一个标签词。',
  ].join('\n')
}

export function parseClassification(raw: string): DiaryLabel | null {
  const t = raw.trim() as DiaryLabel
  return (DIARY_LABELS as readonly string[]).includes(t) ? t : null
}

/**
 * 将日志事件列表合并为分类信号。
 * 若 logs 为空则回退到用 candidateLabel 构造一个占位事件，
 * 确保 classifyDiaryEntry 始终有输入。
 */
export function buildEventsOrFallback(
  logs: Array<{ event_type: string; domain?: string | undefined; at: string }>,
  candidateLabel: string,
  periodStartAt: string,
): DiaryEvent[] {
  if (logs.length > 0) return logs
  return [{ event_type: candidateLabel, domain: undefined, at: periodStartAt }]
}

// 批量分类当日解离事件，≤10 条/日；每条 10s 超时，失败返回 null（保持待确认，等用户手动标记）
export async function classifyDiaryEntry(events: DiaryEvent[]): Promise<DiaryLabel | null> {
  try {
    const cfg = resolveAiConfig()
    if (!cfg) return null
    const resp = await chatCompletion(cfg, {
      messages: [{ role: 'user', content: buildClassifyPrompt(events) }],
      max_tokens: 20,
      temperature: 0.3,
      signal: AbortSignal.timeout(10_000),
    })
    const data = await resp.json() as { choices?: Array<{ message?: { content?: string } }> }
    return parseClassification(data.choices?.[0]?.message?.content ?? '')
  } catch {
    return null
  }
}
