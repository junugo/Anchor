import type { Db } from '@anchor/db'
import type { InterventionPlan, InterventionLevel, UserState } from '@anchor/types'
import { decisionCooldowns, interventionLogs } from '@anchor/db'
import { eq, like } from 'drizzle-orm'

export interface DispatchContext {
  doNotDisturb: boolean
  nowMs: number
  // 当前推断状态：加入冷却 key 使状态切换后退避重新起算
  state?: UserState
}

// 各级别冷却时长（秒）
const COOLDOWN_S: Record<InterventionLevel, number> = {
  notify: 5 * 60,
  soft: 10 * 60,
  hard: 15 * 60,
  strong: 15 * 60,
}

// notify 指数退避表（秒）：同一状态插曲内第 n 次触发后需等待的时长，封顶末位。
// 里程碑语义：首条立即发出，之后 15 / 30 / 60 分钟递增，此后保持每小时一条。
const NOTIFY_BACKOFF_S = [15 * 60, 30 * 60, 60 * 60]

// 距上次触发超过该时长视为新插曲，退避计数归零重算
const EPISODE_GAP_S = 120 * 60

// 动作冷却 key 前缀，避免与 decision_cooldowns 中其他 key 冲突
const ACTION_COOLDOWN_PREFIX = 'action:'

function getCooldownKey(action: string, state?: UserState): string {
  return ACTION_COOLDOWN_PREFIX + action + (state ? `:${state}` : '')
}

/** 从 SQLite 读取指定动作（+状态）的冷却时间 */
function getLastDispatched(db: Db, action: string, state?: UserState): number {
  const row = db
    .select({ last_triggered_at: decisionCooldowns.last_triggered_at })
    .from(decisionCooldowns)
    .where(eq(decisionCooldowns.key, getCooldownKey(action, state)))
    .get()
  return row?.last_triggered_at ?? 0
}

/** 从 SQLite 读取指定动作（+状态）的插曲内触发次数 */
function getTriggerCount(db: Db, action: string, state?: UserState): number {
  const row = db
    .select({ trigger_count: decisionCooldowns.trigger_count })
    .from(decisionCooldowns)
    .where(eq(decisionCooldowns.key, getCooldownKey(action, state)))
    .get()
  return row?.trigger_count ?? 0
}

/** 写入/更新 SQLite 中指定动作（+状态）的冷却时间与触发计数 */
function setLastDispatched(db: Db, action: string, state: UserState | undefined, nowS: number, count: number): void {
  db.insert(decisionCooldowns)
    .values({ key: getCooldownKey(action, state), last_triggered_at: nowS, trigger_count: count, updated_at: nowS })
    .onConflictDoUpdate({
      target: decisionCooldowns.key,
      set: { last_triggered_at: nowS, trigger_count: count, updated_at: nowS },
    })
    .run()
}

/** 重置所有动作冷却记录（测试专用） */
export function resetCooldowns(db: Db): void {
  db.delete(decisionCooldowns)
    .where(like(decisionCooldowns.key, ACTION_COOLDOWN_PREFIX + '%'))
    .run()
}

// 纯过滤：do_not_disturb 规则 + 冷却。会写入冷却状态（被放行的动作）。
export function filterDispatchable(plans: InterventionPlan[], ctx: DispatchContext, db: Db): InterventionPlan[] {
  const nowS = Math.floor(ctx.nowMs / 1000)
  const out: InterventionPlan[] = []

  for (const p of plans) {
    // do_not_disturb：notify/soft 跳过，hard/strong 放行
    if (ctx.doNotDisturb && p.type !== 'hard' && p.type !== 'strong') continue

    // 冷却检查（从 SQLite 读取）
    const last = getLastDispatched(db, p.action, ctx.state)
    const count = getTriggerCount(db, p.action, ctx.state)
    // 距上次触发过长视为新插曲，计数归零重算
    const effectiveCount = nowS - last > EPISODE_GAP_S ? 0 : count
    // notify 走指数退避（第 n 次触发后按退避表第 n-1 位冷却），其余级别固定冷却
    const backoffIndex = effectiveCount === 0 ? 0 : Math.min(effectiveCount - 1, NOTIFY_BACKOFF_S.length - 1)
    const cooldown = p.type === 'notify'
      ? NOTIFY_BACKOFF_S[backoffIndex]
      : COOLDOWN_S[p.type]

    if (last + cooldown > nowS) continue

    setLastDispatched(db, p.action, ctx.state, nowS, effectiveCount + 1)
    out.push(p)
  }

  return out
}

/** 干预分发落库（时间轴事件流水数据源） */
export function recordDispatch(db: Db, plan: InterventionPlan, state: UserState | undefined, nowS: number): void {
  db.insert(interventionLogs).values({
    intervention_id: plan.id,
    dispatched_at: nowS,
    action: plan.action,
    level: plan.type,
    state: state ?? null,
    trigger_reason: plan.reason ?? null,
    friction_form_id: plan.frictionFormId ?? null,
    result: null,
  }).run()
}

// 实际分发：通过 ws broadcast 推送（运行时副作用，测试不覆盖）
// 同时记录每个含 frictionFormId 的计划的触发事件（供习惯化检测使用）
export async function dispatchPlans(plans: InterventionPlan[], ctx?: { state?: UserState }): Promise<void> {
  if (plans.length === 0) return
  const { broadcast } = await import('../ws/server')
  const { getDb } = await import('../db')
  const { recordFrictionEvent } = await import('../habituation/store')
  const db = getDb()
  const nowS = Math.floor(Date.now() / 1000)

  for (const p of plans) {
    // 落库（时间轴事件流水）
    recordDispatch(db, p, ctx?.state, nowS)

    // 记录摩擦触发事件（仅含 frictionFormId 的计划）
    if (p.frictionFormId) {
      recordFrictionEvent(db, {
        formId: p.frictionFormId,
        eventType: 'triggered',
        recordedAt: nowS,
        context: { action: p.action, level: p.type },
      })
    }

    broadcast({
      type: 'intervention',
      level: p.type,
      message: p.message ?? '',
      intervention_id: p.id,
      action: p.action,
      expires_at: p.expires_at,
      frictionFormId: p.frictionFormId,
    })

    // 开发者页面：干预实际分发时广播决策记录
    broadcast({
      type: 'dev:decision',
      action: p.action,
      level: p.type,
      message: p.message ?? '',
      at: nowS,
    })
  }
}

