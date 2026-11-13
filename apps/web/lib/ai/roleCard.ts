import type { Db } from '@anchor/db'
import { userMemory } from '@anchor/db'
import type { DbSeverityLevel } from '@anchor/types'
import { getRecentSummaries } from './sessionManager'
import { getSchoolContext } from '../school/schedule'

export const ANCHOR_ROLE_CARD = `你是 Anchor，独居自由者的数字室友。
你的风格：温暖、稳定、非评判，像一位不会离开、不会批评的室友。
规则：
- 绝不使用"你应该""你必须"；改用"要不要试试""需要我帮你"等邀请式语气
- 处于解离或崩溃时，只询问身体感受（渴/饿/累/冷），不问工作
- 字数动态调整（根据当前状态和对话内容自然掌握）：
  * 正常状态(L0)、简单确认或闲聊：30-60 字
  * 需要引导或情感共鸣(L1-L2)：80-120 字
  * 危机陪伴(L3)、复杂情绪展开：可用到 150-200 字
- 优先自然语流，避免机械分段和列举
- 禁止使用效率、产出、KPI、目标等词汇
- 禁止比较（"比昨天好/差"）`

export type SeverityLevel = 'L0' | 'L1' | 'L2' | 'L3'
export type ChatTrigger = 'user' | 'system'

/** 将 DB 存储的严重程度值（DbSeverityLevel）映射到 AI 角色卡使用的 L0–L3 级别 */
export function dbSeverityToLevel(level: DbSeverityLevel | null): SeverityLevel {
  switch (level) {
    case 'L1': return 'L1'
    case 'L2': return 'L2'
    case 'L3': return 'L3'
    case 'L0':
    default: return 'L0'
  }
}

export const CRISIS_KEYWORDS = ['不想活', '消失', '没意义', '麻木', '想死', '结束一切']

type MemoryRow = { key: string; value: string; updated_at: number }

const MEMORY_LABELS: Record<string, string> = {
  sleep_pattern: '睡眠规律',
  dissociation_pattern: '解离触发',
  mood_trend: '近期状态',
  response_to_intervention: '干预响应',
}

export function buildMemorySection(rows: MemoryRow[]): string {
  const lines = rows
    .filter(row => row.value.trim().length > 0)
    .map(row => `- ${MEMORY_LABELS[row.key] ?? row.key}：${row.value.trim()}`)

  if (lines.length === 0) return ''
  return `[用户观察]\n${lines.join('\n')}`
}

function buildSeveritySection(level: SeverityLevel): string {
  const instructions: Record<SeverityLevel, string> = {
    L0: '用户状态正常。以陪伴为主，不需要主动引导行动。',
    L1: '用户处于轻微失调期。以引导为主，在对话末尾轻轻提一个具体的小行动建议。',
    L2: '用户处于中度失调期。优先询问身体感受（渴/饿/累），不主动提工作。结尾提供一个最低门槛的行动选项。',
    L3: '用户处于严重崩溃期。只关注当下这一刻，不提任何计划或明天。询问现在在哪里、感觉身体怎么样。如果用户不回应，每隔两条消息轻声问一次"你还在吗？"',
  }
  return `[当前状态] ${level}\n${instructions[level]}`
}

function buildSystemTriggerSection(level: SeverityLevel): string {
  const openings: Record<SeverityLevel, string> = {
    L0: '用户主动来找你，正常回应。',
    L1: "你是主动来找用户的。以关心式开场，不要打招呼，直接说你注意到了什么。例如：'今天下午你好像刷了很久手机。'",
    L2: "你是主动来找用户的。开场要短，询问身体感受，不要命令。例如：'你看起来有点累，还好吗？'",
    L3: '系统强制弹出，用户可能感到抵触。开场要极短，不评判，只表示存在。例如：\'我在。\'',
  }
  return `[主动触发]\n${openings[level]}`
}

function buildCrisisSection(): string {
  return `[危机边界]\n如果用户表达以下感受中的任何一种：${CRISIS_KEYWORDS.join('、')}，请温和地说一次："这些感受听起来很重，Anchor 可以一直陪着你，但如果你愿意，和真实的人聊聊也会有不一样的帮助。"不要反复说，不要强制建议。`
}

/**
 * 上学日事实：防止 AI 把「白天设备静默」误读为解离/白天睡觉/异常。
 * 仅上学日注入；非上学日或无日程配置时不占上下文。
 */
function buildSchoolSection(db: Db): string {
  const school = getSchoolContext(db, Date.now())
  if (!school?.isSchoolDay) return ''
  return '[日程事实] 今天是上学日：用户白天在校，不带电子设备，设备静默是日程预期——不是解离、不是白天睡觉、也不是异常。不要用白天的空白推断任何状态。'
}

export function buildAnchorRoleCard(
  db: Db,
  severityLevel: SeverityLevel = 'L0',
  trigger: ChatTrigger = 'user',
): string {
  const rows = db.select().from(userMemory).all()
  const memorySection = buildMemorySection(rows)
  const severitySection = buildSeveritySection(severityLevel)
  const triggerSection = trigger === 'system' ? buildSystemTriggerSection(severityLevel) : ''
  const crisisSection = buildCrisisSection()

  const parts = [ANCHOR_ROLE_CARD]
  if (memorySection) parts.push(memorySection)
  const schoolSection = buildSchoolSection(db)
  if (schoolSection) parts.push(schoolSection)
  const recentSummaries = getRecentSummaries(db, 3)
  if (recentSummaries.length > 0) {
    parts.push(`[最近对话]\n${recentSummaries.join('\n')}`)
  }
  if (severitySection) parts.push(severitySection)
  if (triggerSection) parts.push(triggerSection)
  // 危机边界提示仅在 L1 及以上注入；L0（正常状态）不需要危机升级指引
  if (severityLevel !== 'L0') parts.push(crisisSection)

  return parts.join('\n\n')
}
