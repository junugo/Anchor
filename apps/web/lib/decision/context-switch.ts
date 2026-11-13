import type { Db } from '@anchor/db'
import { behaviorLogs } from '@anchor/db'
import type { BehaviorSource } from '@anchor/types'
import { desc, eq } from 'drizzle-orm'
import { createPromptCoordinator } from '../ws/prompt-coordinator'

/**
 * 状态切换弹窗（注意力残留）— 通用协调器装配层。
 * 单用户模型：任一时刻最多一个活跃 prompt。
 * 协调语义：
 * - submit / skip：先到先赢，响应后广播 dismiss 关闭所有客户端（含 Chrome 全部 tab）的弹窗
 * - auto_skip（客户端本地超时）：只关自己，不参与协调；统一关闭由服务器 timeout 广播 expired
 * - 任意端开始输入（context_switch:input）：接管 prompt，广播 typing 关闭其他端，
 *   接管后不再过期，提交/跳过永远有效
 */

const CONTEXT_SWITCH_TIMEOUT_SECONDS = 15

const coordinator = createPromptCoordinator<{ placeholder: string }>({
  idPrefix: 'cs',
  timeoutSeconds: CONTEXT_SWITCH_TIMEOUT_SECONDS,
  makeOpenMessage: (promptId, timeoutSeconds, { placeholder }) => ({
    type: 'context_switch:prompt',
    prompt_id: promptId,
    timeoutSeconds,
    placeholder,
  }),
  makeDismissMessage: (promptId, reason) => ({
    type: 'context_switch:dismiss',
    prompt_id: promptId,
    reason,
  }),
  makeTypingMessage: (promptId) => ({
    type: 'context_switch:typing',
    prompt_id: promptId,
  }),
})

export function openContextSwitchPrompt(placeholder: string): void {
  coordinator.open({ placeholder })
}

export function handleContextSwitchResponse(
  db: Db,
  msg: { prompt_id: string; action: 'submit' | 'skip' | 'auto_skip'; text?: string; source?: BehaviorSource },
): void {
  // 先到先赢：id 不匹配或已解决的响应直接忽略（行为日志仍记录，便于分析迟到响应）
  const text = msg.text?.trim() ?? ''
  db.insert(behaviorLogs).values({
    source: msg.source ?? 'web',
    event_type: 'context_switch_response',
    payload: { prompt_id: msg.prompt_id, action: msg.action, text },
    logged_at: Math.floor(Date.now() / 1000),
  }).run()

  // auto_skip（客户端本地超时）只关自己，不参与跨端协调；统一关闭由服务器 timeout 广播 expired
  if (msg.action === 'auto_skip') return

  coordinator.handleResponse(msg.prompt_id, msg.action === 'submit' && text ? 'answered' : 'skipped')
}

/** 客户端开始输入：接管 prompt（清除服务器过期定时器，广播 typing 关闭其他端） */
export function handleContextSwitchInput(promptId: string): void {
  coordinator.handleInput(promptId)
}

/** 测试专用：重置协调器状态 */
export function _resetContextSwitchForTest(): void {
  coordinator._resetForTest()
}

/**
 * 返回工作状态时取出最近的注意力残留（2h 内的提交文本），用于 toast 提示接续。
 */
export function getRecentResidue(db: Db, nowSec: number, withinSec = 2 * 60 * 60): string | null {
  const row = db
    .select()
    .from(behaviorLogs)
    .where(eq(behaviorLogs.event_type, 'context_switch_response'))
    .orderBy(desc(behaviorLogs.logged_at))
    .limit(1)
    .get()
  if (!row) return null
  if (nowSec - row.logged_at > withinSec) return null
  const text = (row.payload as { text?: string })?.text?.trim()
  return text || null
}
