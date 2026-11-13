import { randomUUID } from 'node:crypto'
import type { Db } from '@anchor/db'
import type { InferenceResult, InterventionLevel, InterventionPlan, UserState } from '@anchor/types'
import { selectFrictionForm, getAllFrictionForms } from '../habituation/forms'
import { isHabituated } from '../habituation/store'

export interface PlanContext {
  nowMs: number
  isSunsetWindow: boolean       // 当前是否在宵禁时段
  minutesAfterBedtime: number   // 距就寝时间分钟数，负为未到
}

// 干预存活时长（秒）：覆盖全部 InterventionLevel 防止运行时 lookup 返回 undefined
const EXPIRY_S: Record<InterventionLevel, number> = { notify: 300, soft: 600, hard: 900, strong: 900 }

// fallback 文案（计划 4 用 AI 替换）；仅生成干预的状态（sleeping/away 无干预文案）
const FALLBACK: Record<Exclude<UserState, 'transitioning' | 'sleeping' | 'away'>, string> = {
  dissociating: '已经有一段时间了，回来一下？',
  entertaining: '玩了一会儿了，时间过得挺快的。',
  resting: '该睡了，明天还有事。',
  working: '专注了很久了，可以休息一会儿。',
}

// 干预等级升级：全部摩擦形式习惯化时提升一级
const LEVEL_ESCALATION: Record<InterventionLevel, InterventionLevel> = {
  notify: 'soft',
  soft: 'hard',
  hard: 'strong',
  strong: 'strong',
}

function makePlan(
  ctx: PlanContext,
  state: Exclude<UserState, 'transitioning' | 'sleeping' | 'away'>,
  type: InterventionLevel,
  action: InterventionPlan['action'],
  targets: InterventionPlan['targets'],
  reason: string,
  frictionFormId?: string,
): InterventionPlan {
  const nowS = Math.floor(ctx.nowMs / 1000)
  return {
    id: randomUUID(),
    type,
    targets,
    action,
    message: FALLBACK[state],
    reason,
    expires_at: nowS + EXPIRY_S[type],
    frictionFormId,
  }
}

export function planInterventions(db: Db, r: InferenceResult, ctx: PlanContext): InterventionPlan[] {
  const s = r.snapshot
  const plans: InterventionPlan[] = []
  // 包含内置形式 + 用户已接受的 AI 提议形式
  const allForms = getAllFrictionForms(db)
  const habCheck = (id: string) => isHabituated(db, id)

  if (r.state === 'dissociating') {
    if (s.attention_fragmentation_score > 0.8) {
      // 浏览器碎片化：注意力漂移摩擦形式（可习惯化轮换，含用户自定义形式）
      const driftForm = selectFrictionForm('attention_drift', habCheck, allForms)
      const driftFormId = driftForm?.id
      const driftHabituated = driftForm === null
      const driftLevel: InterventionLevel = driftHabituated ? LEVEL_ESCALATION['soft'] : 'soft'
      // 固定动作（灰屏+收合 tab）+ 摩擦形式 ID 供习惯化追踪
      plans.push(makePlan(ctx, 'dissociating', driftLevel, 'chrome:grayscale', ['chrome'], '注意力碎片化（浏览器）', driftFormId ?? undefined))
      plans.push(makePlan(ctx, 'dissociating', driftLevel, 'chrome:tab_collapse', ['chrome'], '注意力碎片化（浏览器）', driftFormId ?? undefined))
    } else if (s.android_unlock_rate >= 15) {
      // 高频解锁：注意力漂移提醒（可习惯化轮换）
      const driftForm = selectFrictionForm('attention_drift', habCheck, allForms)
      const driftFormId = driftForm?.id
      const driftHabituated = driftForm === null
      const driftLevel: InterventionLevel = driftHabituated ? LEVEL_ESCALATION['soft'] : 'soft'
      plans.push(makePlan(ctx, 'dissociating', driftLevel, 'android:fullscreen_modal', ['android'], '高频解锁（≥15次/h）', driftFormId ?? undefined))
    }
  }

  if (r.state === 'entertaining') {
    // 查询习惯化状态，选择尚未适应的摩擦形式（含用户自定义形式）
    const form = selectFrictionForm('entertainment_app_launch', habCheck, allForms)
    const frictionFormId = form?.id

    // 全部形式已习惯化时 form 为 null，需升级干预等级
    const habituationEscalate = form === null

    if (ctx.isSunsetWindow) {
      // 宵禁时段娱乐：强制拦截（宵禁不受习惯化升级影响，本已是 hard）
      plans.push(makePlan(ctx, 'entertaining', 'hard', 'chrome:hard_block', ['chrome'], '宵禁时段娱乐', frictionFormId ?? undefined))
      plans.push(makePlan(ctx, 'entertaining', 'hard', 'android:fullscreen_block', ['android'], '宵禁时段娱乐', frictionFormId ?? undefined))
    } else if (s.entertainment_depth_score > 0.8) {
      // 深度娱乐（>0.8 depth）：软干预灰屏，习惯化时升级
      const level: InterventionLevel = habituationEscalate ? LEVEL_ESCALATION['soft'] : 'soft'
      plans.push(makePlan(ctx, 'entertaining', level, 'chrome:grayscale', ['chrome'], '深度娱乐', frictionFormId ?? undefined))
      plans.push(makePlan(ctx, 'entertaining', level, 'android:fullscreen_modal', ['android'], '深度娱乐', frictionFormId ?? undefined))
    } else {
      // 轻度娱乐：通知提醒，习惯化时升级
      const level: InterventionLevel = habituationEscalate ? LEVEL_ESCALATION['notify'] : 'notify'
      plans.push(makePlan(ctx, 'entertaining', level, 'chrome:friction_banner', ['chrome'], '轻度娱乐', frictionFormId ?? undefined))
      plans.push(makePlan(ctx, 'entertaining', level, 'android:push_notify', ['android'], '轻度娱乐', frictionFormId ?? undefined))
    }
  }

  if (r.state === 'working' && s.deep_work_duration_ms > 90 * 60 * 1000) {
    // 专注超 90 分钟：提醒休息
    plans.push(makePlan(ctx, 'working', 'notify', 'desktop:toast_notify', ['desktop'], '专注超 90 分钟'))
  }

  if (r.state === 'resting' && ctx.minutesAfterBedtime >= 0) {
    // 宵禁绕过摩擦形式（可习惯化轮换，含用户自定义形式）
    const curfewForm = selectFrictionForm('curfew_bypass', habCheck, allForms)
    const curfewFormId = curfewForm?.id
    const curfewHabituated = curfewForm === null

    if (ctx.minutesAfterBedtime >= 60) {
      // 就寝后 60 分钟仍未睡：强制锁屏（已是 hard，习惯化时维持 hard → strong）
      const level: InterventionLevel = curfewHabituated ? LEVEL_ESCALATION['hard'] : 'hard'
      plans.push(makePlan(ctx, 'resting', level, 'desktop:force_lock', ['desktop'], '就寝后 60 分钟未睡', curfewFormId ?? undefined))
      plans.push(makePlan(ctx, 'resting', level, 'chrome:hard_block', ['chrome'], '就寝后 60 分钟未睡', curfewFormId ?? undefined))
      plans.push(makePlan(ctx, 'resting', level, 'android:fullscreen_block', ['android'], '就寝后 60 分钟未睡', curfewFormId ?? undefined))
    } else if (ctx.minutesAfterBedtime >= 30) {
      // 就寝后 30 分钟：软拦截，习惯化时升级
      const level: InterventionLevel = curfewHabituated ? LEVEL_ESCALATION['soft'] : 'soft'
      plans.push(makePlan(ctx, 'resting', level, 'chrome:hard_block', ['chrome'], '就寝后 30 分钟未睡', curfewFormId ?? undefined))
      plans.push(makePlan(ctx, 'resting', level, 'android:fullscreen_modal', ['android'], '就寝后 30 分钟未睡', curfewFormId ?? undefined))
    } else if (ctx.minutesAfterBedtime >= 15) {
      // 就寝后 15 分钟：温和提醒，习惯化时升级
      const level: InterventionLevel = curfewHabituated ? LEVEL_ESCALATION['notify'] : 'notify'
      plans.push(makePlan(ctx, 'resting', level, 'desktop:toast_notify', ['desktop'], '就寝后 15 分钟未睡', curfewFormId ?? undefined))
      plans.push(makePlan(ctx, 'resting', level, 'android:push_notify', ['android'], '就寝后 15 分钟未睡', curfewFormId ?? undefined))
    }
  }

  return plans
}
