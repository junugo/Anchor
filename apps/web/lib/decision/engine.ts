import type { Db } from '@anchor/db'
import type { UserState } from '@anchor/types'
import { isOnCooldown, markCooldown } from './cooldown'
import { playCapsuleInternal } from './capsule'
import { checkSunsetPhase, handleDissociation } from './sunset'
import { checkLifeRescue } from './life-rescue'
import { triggerAttentionResidueRitual } from './attention-residue'

// 单一真相：pipeline.ts 也 import 此常量，此处不重复定义
export const DEV_TOOLS = ['vscode', 'idea', 'terminal', 'iterm', 'warp', 'vim', 'neovim', 'emacs', 'code']

/**
 * 运行决策引擎：基于当前推断状态触发胶囊、AI 提醒、宵禁检查等。
 * 冷却状态持久化到 SQLite decision_cooldowns 表。
 * prevState 由调用方（pipeline）统一提供——状态真相只有一份，引擎不再自持副本
 */
export async function runDecision(db: Db, state: UserState, prevState: UserState | null): Promise<void> {
  const now = Math.floor(Date.now() / 1000)

  // sleeping / away 分流：夜间判断引擎短路（pipeline 在用户入睡后以哨兵状态 'sleeping' 调用）、
  // 上学日校时段日程短路（'away'）——只调用 checkSunsetPhase 推进睡眠状态机
  // （相位流转/活跃检测/8h 解除/上学日 school_departure 结算），不执行任何干预规划、
  // 动作分发与状态写库；睡眠引擎发现用户活跃会把相位转出 sleeping，由调用方（pipeline）
  // 据此恢复判断引擎。
  if (state === 'sleeping' || state === 'away') {
    await checkSunsetPhase(db, (k, n, c) => isOnCooldown(db, k, n, c), (k, n) => markCooldown(db, k, n))
    return
  }

  // after_break：从 resting 转为 working，播放胶囊为回工作做热身
  if (prevState === 'resting' && state === 'working') {
    if (!isOnCooldown(db, 'after_break', now)) {
      markCooldown(db, 'after_break', now)
      playCapsuleInternal(db, 'after_break').catch(console.error)
    }
  }

  // 回到工作状态：若 2h 内记录过注意力残留，轻量 toast 提示接续
  if (prevState && prevState !== 'working' && state === 'working') {
    void (async () => {
      const { getRecentResidue } = await import('./context-switch')
      const residue = getRecentResidue(db, now)
      if (residue) {
        const { broadcast } = await import('../ws/server')
        broadcast({ type: 'notify:ai', message: `欢迎回来。刚才停在：${residue}` })
      }
    })().catch(console.error)
  }

  // Attention residue clearance ritual: working → entertaining/resting/transitioning
  if (prevState === 'working' && state !== 'working') {
    if (!isOnCooldown(db, 'attention_residue', now)) {
      markCooldown(db, 'attention_residue', now)
      triggerAttentionResidueRitual().catch(console.error)
    }
  }

  // 1. 解离保护：通知 FocusLayer + 推送时间锚
  if (state === 'dissociating') {
    if (!isOnCooldown(db, 'dissociation', now)) {
      markCooldown(db, 'dissociation', now)
      await handleDissociation(db)
    }
  }

  // 2. 工作状态：查询 FocusLayer 确认是否深度心流（决定是否可打断）
  if (state === 'working') {
    if (!isOnCooldown(db, 'focuslayer_query', now, 60)) { // 1 分钟查一次
      markCooldown(db, 'focuslayer_query', now)
      await queryFocusLayerIfEnabled()
    }
  }

  // 3. 娱乐状态：若 FocusLayer 有活跃任务，触发 AI 生成提醒
  if (state === 'entertaining') {
    if (!isOnCooldown(db, 'entertainment_alert', now)) {
      markCooldown(db, 'entertainment_alert', now)
      await handleEntertainment(db)
    }
  }

  // 4. 休息状态：每 6 小时生成对话摘要
  if (state === 'resting' && !isOnCooldown(db, 'conversation_summary', now, 6 * 60 * 60)) {
    markCooldown(db, 'conversation_summary', now)
    const { generateConversationSummary } = await import('../ai/summary')
    generateConversationSummary(db).catch(console.error)
  }

  // 5. 检查宵禁阶段
  await checkSunsetPhase(db, (k, n, c) => isOnCooldown(db, k, n, c), (k, n) => markCooldown(db, k, n))

  // 6. Life rescue check (every 6h)
  await checkLifeRescue(db, (k, n, c) => isOnCooldown(db, k, n, c), (k, n) => markCooldown(db, k, n))

  // 7. Periodic check-in (every 3h, only if not dissociating)
  if (state !== 'dissociating' && !isOnCooldown(db, 'check_in', now, 3 * 60 * 60)) {
    markCooldown(db, 'check_in', now)
    const { triggerAiReminder } = await import('../ai/reminder')
    triggerAiReminder(db, 'check_in').catch(console.error)
  }
}

async function queryFocusLayerIfEnabled(): Promise<void> {
  const { focusLayerClient } = await import('../focuslayer/client')
  if (!focusLayerClient.isEnabled()) return
  await focusLayerClient.queryStatus()
}

async function handleEntertainment(db: Db): Promise<void> {
  const { focusLayerClient } = await import('../focuslayer/client')
  const { triggerAiReminder } = await import('../ai/reminder')

  let activeIssue: { title: string; elapsed_minutes: number } | null = null
  if (focusLayerClient.isEnabled()) {
    const status = await focusLayerClient.queryStatus()
    if (status?.focus_context.active_issue) {
      activeIssue = status.focus_context.active_issue
    }
  }

  await triggerAiReminder(db, 'entertainment', { activeIssue })
}

// Re-export getSunsetPhase for pipeline.ts 等外部消费者
export { getSunsetPhase } from './sunset'
