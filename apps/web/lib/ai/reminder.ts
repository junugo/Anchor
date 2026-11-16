import type { Db } from '@anchor/db'
import { buildAnchorRoleCard } from './roleCard'
import { localDateStr, nowContext, formatBedtime, NOTIFICATION_RULE } from './promptUtils'
import { chatCompletion, resolveAiConfig } from './provider'

export type ReminderScene = 'entertainment' | 'dissociation' | 'bedtime' | 'wakeup' | 'check_in' | 'rescue' | 'mobile_distraction'

export interface ReminderContext {
  activeIssue?: { title: string; elapsed_minutes: number } | null
  [key: string]: unknown
}

// 测试专用：禁用提醒触发（决策引擎/睡眠引擎等的 fire-and-forget 调用会在
// 测试关库后触碰 DB，被 node:test 归因为「测试结束后仍在活动的异步错误」）
let _disabledForTest = false
export function disableAiReminderForTest(): void {
  _disabledForTest = true
}
export function enableAiReminderForTest(): void {
  _disabledForTest = false
}

export async function triggerAiReminder(
  db: Db,
  scene: ReminderScene,
  ctx: ReminderContext = {}
): Promise<string | void> {
  if (_disabledForTest) return
  const summary = await buildBehaviorSummary(db)
  const { sunsetConfig } = await import('@anchor/db')
  const cfg = db
    .select({ target_bedtime_minutes: sunsetConfig.target_bedtime_minutes })
    .from(sunsetConfig)
    .limit(1)
    .get()
  const targetBedtime = formatBedtime(cfg?.target_bedtime_minutes ?? 90)
  const prompt = buildPrompt(scene, summary, { ...ctx, targetBedtime })
  const roleCard = buildAnchorRoleCard(db)

  const aiCfg = resolveAiConfig()
  if (!aiCfg) {
    console.warn('[AI] ANCHOR_AI_API_KEY not set, skipping reminder')
    return
  }

  try {
    const res = await chatCompletion(aiCfg, {
      messages: [
        { role: 'system', content: roleCard },
        { role: 'user', content: prompt },
      ],
      max_tokens: 120,
      temperature: 0.85,
      signal: AbortSignal.timeout(10_000),
    })

    if (!res.ok) return
    const data = await res.json() as {
      choices?: Array<{ message?: { content?: string } }>
    }
    const message: string = data.choices?.[0]?.message?.content ?? ''
    if (!message.trim()) return

    const { broadcast } = await import('../ws/server')
    broadcast({ type: 'notify:ai', message: message.trim() })
    return message.trim()
  } catch {
    // AI 失败静默忽略，不影响主流程
  }
}

async function buildBehaviorSummary(db: Db): Promise<string> {
  const today = localDateStr()
  const { circadianLogs } = await import('@anchor/db')
  const { eq } = await import('drizzle-orm')
  const log = db.select().from(circadianLogs).where(eq(circadianLogs.date, today)).get()

  const parts: string[] = []
  if (log) {
    if (log.sleep_debt_hours != null) parts.push(`睡眠债务 ${log.sleep_debt_hours.toFixed(1)} 小时`)
    if (log.dissociation_risk_score != null) parts.push(`解离风险 ${log.dissociation_risk_score.toFixed(1)}/10`)
    parts.push(`今日吃饭 ${log.meals_count} 次`)
    parts.push(`离开房间 ${log.left_room_count} 次`)
  }
  return parts.length ? parts.join('，') : '暂无今日数据'
}

function buildPrompt(scene: ReminderScene, summary: string, ctx: ReminderContext): string {
  const base = `当前时间：${nowContext()}。当前用户状态摘要：${summary}`
  const body = (() => {
    switch (scene) {
      case 'entertainment':
        return `${base}。用户刚才切换到了娱乐内容${
          ctx.activeIssue
            ? `，FocusLayer 显示有未完成任务「${ctx.activeIssue.title}」已进行 ${ctx.activeIssue.elapsed_minutes} 分钟`
            : ''
        }。请生成一条轻柔的提醒（不超过 80 字）。`
      case 'dissociation':
        return `${base}。用户可能处于解离状态。请只询问用户的身体感受（渴/饿/累/冷/麻木），不超过 30 字。`
      case 'bedtime':
        return `${base}。用户设定的目标就寝时间为 ${String(ctx.targetBedtime ?? '')}。请生成一条睡前提醒，提到今天发生的数据，引导用户把手机放到另一端充电，不超过 80 字。`
      case 'wakeup':
        return `${base}。用户刚完成起床物理验证。请生成一条温暖的起床问候，提醒第一动作（${ctx.firstAction ?? '喝水'}），不超过 50 字。`
      case 'check_in':
        return `${base}。请询问用户现在的身体感觉，提供选项（渴/饿/累/冷/焦虑/麻木），不超过 40 字。`
      case 'rescue':
        return `${base}。用户可能处于生活基础崩溃状态。请只推送3个微动作（喝水→出门5分钟→吃一顿饭），每句不超过10字，不提工作。`
      case 'mobile_distraction': {
        const app = String((ctx as Record<string, unknown>)['detectedApp'] ?? '你的手机')
        return `${base}。用户正在专注工作，但刚打开了「${app}」。请用一句温暖但直接的中文（≤40字）提醒他注意，不要命令式，像室友一样说话。`
      }
      default:
        return base
    }
  })()
  return `${body}\n${NOTIFICATION_RULE}`
}
