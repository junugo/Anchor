import type { InferenceResult, UserState } from '@anchor/types'
import { nowContext } from '../ai/promptUtils'

const VALID_STATES: UserState[] = ['working', 'entertaining', 'dissociating', 'resting', 'transitioning']

export function buildArbiterPrompt(r: InferenceResult): string {
  const s = r.snapshot
  return [
    '你是行为状态仲裁器。规则引擎对当前状态不确定，请基于以下证据裁定最可能的状态。',
    `当前分析时段：${nowContext(s.window_end * 1000)}`,
    `候选状态：${r.state}（置信度 ${r.confidence}）`,
    `证据：${r.evidence.join('；')}`,
    `特征：code_active=${s.code_active_count}, 深度工作ms=${s.deep_work_duration_ms}, 工作进程ms=${s.work_app_duration_ms}, 工作网站访问=${s.work_visit_count}, 手机工作App=${s.android_in_work_app}, 高刺激访问=${s.high_stimulus_visit_count}, 分心度=${s.attention_fragmentation_score}, 手机娱乐中=${s.android_fun_app_current}`,
    `可选状态：${VALID_STATES.join(' / ')}`,
    '只返回 JSON：{"state":"...","confidence":0-1,"reasoning":"≤50字"}',
  ].join('\n')
}

export interface ArbiterVerdict {
  state: UserState
  confidence: number
  reasoning?: string
}

export function parseArbiterResponse(raw: string): ArbiterVerdict | null {
  let obj: unknown
  try { obj = JSON.parse(raw) } catch { return null }
  if (typeof obj !== 'object' || obj === null) return null
  const o = obj as Record<string, unknown>
  const state = o['state']
  if (typeof state !== 'string' || !VALID_STATES.includes(state as UserState)) return null
  const confidence = typeof o['confidence'] === 'number' ? o['confidence'] : 0.6
  return {
    state: state as UserState,
    confidence,
    reasoning: typeof o['reasoning'] === 'string' ? o['reasoning'] : undefined,
  }
}

export function arbiterFallback(original: InferenceResult): InferenceResult {
  return original
}

// 实际调用 DeepSeek，3s 超时 + 频率/缓存保护
let _lastCallMinute = -1
let _callsThisMinute = 0
const _cache = new Map<string, { verdict: ArbiterVerdict; at: number }>()
// 缓存上限：防止长期运行无限增长（Map 按插入序迭代，淘汰最旧条目）
const CACHE_MAX = 50

export async function arbitrate(r: InferenceResult, nowMs: number, snapshotHash: string): Promise<InferenceResult> {
  // 缓存 2 分钟
  const cached = _cache.get(snapshotHash)
  if (cached && nowMs - cached.at < 2 * 60 * 1000) {
    return { ...r, state: cached.verdict.state, confidence: cached.verdict.confidence }
  }
  // 频率限制：每分钟 3 次
  const minute = Math.floor(nowMs / 60000)
  if (minute !== _lastCallMinute) { _lastCallMinute = minute; _callsThisMinute = 0 }
  if (_callsThisMinute >= 3) return arbiterFallback(r)
  _callsThisMinute += 1

  try {
    const apiKey = process.env['DEEPSEEK_API_KEY']
    if (!apiKey) return arbiterFallback(r)
    const resp = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: buildArbiterPrompt(r) }],
        max_tokens: 120, temperature: 0.3,
      }),
      signal: AbortSignal.timeout(3_000),
    })
    const data = await resp.json() as { choices?: Array<{ message?: { content?: string } }> }
    const content = data.choices?.[0]?.message?.content ?? ''
    const verdict = parseArbiterResponse(content)
    if (!verdict) return arbiterFallback(r)
    if (_cache.size >= CACHE_MAX) {
      const oldest = _cache.keys().next().value
      if (oldest !== undefined) _cache.delete(oldest)
    }
    _cache.set(snapshotHash, { verdict, at: nowMs })
    return { ...r, state: verdict.state, confidence: verdict.confidence }
  } catch {
    return arbiterFallback(r)
  }
}
