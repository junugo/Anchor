import type { UserState, FeatureSnapshot, InferenceResult, InferenceMemory } from '@anchor/types'

export interface InferOptions {
  previousState: UserState
  memory?: InferenceMemory
  nowHour?: number
}

type Scored = { state: UserState; score: number; evidence: string[]; confidence: number }

const RECENT_S = 60
const NORMAL_SWITCH_MARGIN = 0.12

export function inferState(snap: FeatureSnapshot, opts: InferOptions): InferenceResult {
  const recentWork = snap.latest_work_signal_age_s !== undefined && snap.latest_work_signal_age_s !== null && snap.latest_work_signal_age_s <= RECENT_S
  const recentEntertainment = snap.latest_entertainment_signal_age_s !== undefined && snap.latest_entertainment_signal_age_s !== null && snap.latest_entertainment_signal_age_s <= RECENT_S
  const workScore = Math.min(1,
    (recentWork ? 0.45 : 0) +
    (((snap.recent_code_active_count ?? 0) > 0 || snap.code_active_count > 0) ? 0.25 : 0) +
    (snap.deep_work_duration_ms > 0 ? 0.15 : 0) + (snap.code_active_count >= 3 ? 0.35 : 0) +
    (snap.work_momentum_score * 0.15) +
    // 多源工作信号：Windows 工作进程 ≥5min / 工作网站访问 / Android 工作 App 前台
    (snap.work_app_duration_ms >= 5 * 60 * 1000 ? 0.35 : 0) +
    (snap.work_visit_count > 0 ? 0.2 : 0) +
    (snap.android_in_work_app ? 0.3 : 0)
  )
  const entertainmentScore = Math.min(1,
    (recentEntertainment ? 0.45 : 0) +
    Math.min(0.3, snap.entertainment_depth_score * 0.3) +
    (snap.android_fun_app_current ? 0.35 : 0)
  )
  // 窗口级工作信号：有工作痕迹时碎片化/高频解锁不指向解离
  // （「工作中拿手机」语义是娱乐摩擦而非解离，见 AGENTS.md；60s 的 recentWork 太短——
  //  读文档/看代码不持续产生工作事件，用它会错误失去压制，导致浏览工作资料被判解离）
  const workInWindow = recentWork ||
    (snap.recent_code_active_count ?? 0) > 0 ||
    snap.code_active_count > 0 ||
    snap.work_visit_count > 0 ||
    snap.work_app_duration_ms >= 60 * 1000 ||
    snap.android_in_work_app ||
    snap.deep_work_duration_ms > 0
  const riskScore = Math.min(1,
    (snap.android_unlock_rate >= 15 && !workInWindow ? 0.55 : 0) +
    (snap.attention_fragmentation_score > 0.8 && !workInWindow ? 0.35 : 0)
  )
  const restingScore = Math.min(1,
    (snap.is_idle ? 0.55 : 0) +
    (Object.keys(snap.event_counts).length === 0 ? 0.45 : 0)
  )

  const candidates: Scored[] = [
    { state: 'dissociating', score: riskScore, confidence: Math.min(0.98, 0.45 + riskScore * 0.5), evidence: [`risk_score=${riskScore.toFixed(2)}`] },
    { state: 'working', score: workScore, confidence: Math.min(0.95, 0.4 + workScore * 0.5), evidence: [`work_score=${workScore.toFixed(2)}`, `recent_code=${snap.recent_code_active_count ?? 0}`, `work_app_ms=${snap.work_app_duration_ms}`, `work_visits=${snap.work_visit_count}`] },
    { state: 'entertaining', score: entertainmentScore, confidence: Math.min(0.95, 0.4 + entertainmentScore * 0.5), evidence: [`entertainment_score=${entertainmentScore.toFixed(2)}`] },
    { state: 'resting', score: restingScore, confidence: Math.min(0.9, 0.4 + restingScore * 0.5), evidence: [`resting_score=${restingScore.toFixed(2)}`] },
  ]
  candidates.sort((a, b) => b.score - a.score)
  const top = candidates[0]
  const second = candidates[1]
  let chosen: Scored
  // 当下娱乐是决定性信号：打开娱乐软件即娱乐中（工作中打开 = 简单分心或工作完成开始娱乐，
  // 语义是娱乐而非解离）。绕过分数竞争——否则强工作证据会让娱乐恒输、状态切换滞后
  const funNow = recentEntertainment
  if (funNow) {
    chosen = candidates.find(c => c.state === 'entertaining')!
  } else if (top.score >= 0.45) {
    chosen = top
  } else {
    chosen = { state: opts.previousState, score: 0.4, confidence: 0.55, evidence: ['insufficient recent evidence'] }
  }

  // 迟滞：决定性娱乐（新鲜信号）绕过；其余切换需明显优势才换状态
  if (!funNow && chosen.state !== opts.previousState && top.score < second.score + NORMAL_SWITCH_MARGIN && opts.previousState !== 'transitioning') {
    chosen = { state: opts.previousState, score: second.score, confidence: Math.max(0.55, second.confidence), evidence: [...second.evidence, 'previous_state_hysteresis'] }
  }

  if (chosen.state === 'dissociating' && opts.memory && opts.nowHour !== undefined && opts.memory.highRiskHours.includes(opts.nowHour)) {
    const boost = opts.memory.onboardingDays >= 14 ? 0.1 : opts.memory.onboardingDays >= 4 ? 0.05 : 0
    chosen.confidence = Math.min(1, chosen.confidence + boost)
    if (boost > 0) chosen.evidence.push('high_risk_hour')
  }

  const needs_ai_arbitration = chosen.confidence < 0.6 || (top.score - second.score < 0.12 && !funNow)
  return {
    state: chosen.state,
    confidence: chosen.confidence,
    evidence: chosen.evidence,
    previous_state: opts.previousState,
    state_changed: chosen.state !== opts.previousState,
    do_not_disturb: snap.do_not_disturb,
    needs_ai_arbitration,
    candidates,
    snapshot: snap,
  }
}
