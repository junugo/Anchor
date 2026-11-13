import type { UserState, InterventionLevel } from '@anchor/types'
import { getUserDateStr, getUserLocalParts } from '../time/user-time'

// 本地日期 YYYY-MM-DD（使用用户时区，避免服务器时区/UTC 偏移导致取错"今日"）
export function localDateStr(nowMs = Date.now()): string {
  return getUserDateStr(nowMs)
}

function timeSlot(hour: number): string {
  if (hour < 6) return '深夜'
  if (hour < 12) return '早上'
  if (hour < 18) return '下午'
  return '晚上'
}

// 当前时刻的中文表达，如"晚上 10 点 05 分"
export function nowContext(nowMs = Date.now()): string {
  const { hour, minute } = getUserLocalParts(nowMs)
  const min = String(minute).padStart(2, '0')
  return `${timeSlot(hour)} ${hour}点${min}分`
}

// 午夜起分钟数 → 中文时刻，如 90 → "凌晨 1 点 30 分"
export function formatBedtime(minutes: number): string {
  const h = Math.floor(minutes / 60)
  const m = String(minutes % 60).padStart(2, '0')
  return `${timeSlot(h)} ${h}点${m}分`
}

export const STATE_ZH: Record<UserState, string> = {
  working: '专注工作中',
  entertaining: '娱乐中',
  dissociating: '解离中',
  resting: '休息中',
  sleeping: '睡眠中',
  transitioning: '状态切换中',
  away: '在校',
}

export const LEVEL_TONE: Record<InterventionLevel, string> = {
  notify: '极轻提醒，一句话存在感即可',
  soft: '轻柔提醒，温和邀请式语气',
  hard: '直接但温暖，简短有力',
  strong: '紧急，第一句就抓注意',
}

// 通知场景共用约束：防臆造时间 + 通知形态意识
export const NOTIFICATION_RULE = [
  '这是手机推送通知，用户只会扫一眼，开头就要有体感、能抓住注意力。',
  '如需提及时间，只能用提供的真实时间，禁止自行推测任何时刻。',
  '只返回提醒文本，不要引号或解释。',
].join('\n')
