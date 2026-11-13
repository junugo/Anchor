/**
 * 意图锚点层 — 核心逻辑
 *
 * 三个触发点：
 * 1. 宵禁 T-30：广播 intent:capture，提示用户记录明日意图
 * 2. 起床物理验证完成：广播 intent:confirm，展示昨晚意图
 * 3. 上午首个时间块（查询）：返回今日意图，供绑定使用
 *
 * 跨端协调（镜像 context_switch）：
 * - 单用户模型：任一时刻最多一个活跃捕获，任一端 submit/skip 后
 *   广播 intent:dismiss 关闭所有客户端弹窗
 * - auto_skip（客户端本地超时）：只关自己，不参与协调；统一关闭由服务器 timeout 广播 expired
 * - 任意端开始输入（intent:input）：接管捕获，广播 typing 关闭其他端，
 *   接管后不再过期，提交/跳过永远有效
 * - dismiss reason=answered 时全端清除重开入口；skipped/expired 仅关弹窗，
 *   客户端保留重开入口（安卓通知 / Windows 托盘），重开后走普通 intent:submit
 *
 * L3 降级：严重崩溃时 prompt 改为"第一个动作是什么？"
 * FocusLayer 接入时：补充任务级上下文到 focuslayer_hint
 */

import type { Db } from '@anchor/db'
import { dailyIntentions, userLivingContext } from '@anchor/db'
import { desc, eq } from 'drizzle-orm'
import type { DbSeverityLevel } from '@anchor/types'
import { createPromptCoordinator } from '../ws/prompt-coordinator'
import { getUserDateStr } from '../time/user-time'

// 意图弹窗倒计时（秒）：比 context_switch 的 15s 宽松，睡前场景允许想一下
export const INTENT_CAPTURE_TIMEOUT_SECONDS = 60

// 迟滞守卫：T-30 意图采集每次宵禁只触发一次
let _lastIntentCaptureDate: string | null = null

// 通用协调器：先到先赢 + dismiss 广播；意图特有的每日守卫/载荷存储在下方装配
const coordinator = createPromptCoordinator<{
  prompt: string
  isDegraded: boolean
  focuslayerHint?: string
}>({
  idPrefix: 'intent',
  timeoutSeconds: INTENT_CAPTURE_TIMEOUT_SECONDS,
  makeOpenMessage: (promptId, timeoutSeconds, { prompt, isDegraded, focuslayerHint }) => ({
    type: 'intent:capture',
    prompt_id: promptId,
    timeoutSeconds,
    prompt,
    is_degraded: isDegraded,
    ...(focuslayerHint ? { focuslayer_hint: focuslayerHint } : {}),
  }),
  makeDismissMessage: (promptId, reason) => ({
    type: 'intent:dismiss',
    prompt_id: promptId,
    reason,
  }),
  makeTypingMessage: (promptId) => ({
    type: 'intent:typing',
    prompt_id: promptId,
  }),
})

function todayString(): string {
  return getUserDateStr(Date.now())
}

function yesterdayString(): string {
  return getUserDateStr(Date.now() - 24 * 60 * 60 * 1000)
}

/** 读取当前严重度等级 */
function getCurrentSeverityLevel(db: Db): DbSeverityLevel | null {
  const row = db
    .select({ severity_level: userLivingContext.severity_level })
    .from(userLivingContext)
    .where(eq(userLivingContext.user_id, 'default'))
    .get()
  return row?.severity_level ?? null
}

/**
 * 宵禁 T-30 触发：广播意图采集 intent:capture。
 *
 * 每天只广播一次（基于日期迟滞守卫）。
 * L3 状态下降级为"今天第一个动作是什么？"
 * FocusLayer 在线时补充任务级上下文。
 */
export async function triggerIntentCapture(db: Db): Promise<void> {
  const today = todayString()

  // 每次宵禁周期只触发一次
  if (_lastIntentCaptureDate === today) return
  _lastIntentCaptureDate = today

  const severityLevel = getCurrentSeverityLevel(db)
  // DbSeverityLevel 'L2' | 'L3' → 映射到严重崩溃降级
  const isL3 = severityLevel === 'L2' || severityLevel === 'L3'

  const prompt = isL3
    ? '今天第一个动作是什么？（具体、物理、5 分钟内可完成）'
    : '明天最重要的一件事是什么？'

  // 尝试从 FocusLayer 拉取上下文
  let focuslayerHint: string | undefined
  try {
    const { focusLayerClient } = await import('../focuslayer/client')
    if (focusLayerClient.isEnabled()) {
      const status = await focusLayerClient.queryStatus()
      if (status?.focus_context.active_issue) {
        const { title } = status.focus_context.active_issue
        focuslayerHint = `FocusLayer 当前任务：${title}`
      }
    }
  } catch {
    // FocusLayer 不可用，静默降级
  }

  coordinator.open({ prompt, isDegraded: isL3, focuslayerHint })
}

/**
 * 测试专用：重置捕获协调器与日期守卫（模块级状态跨用例共享）
 */
export function _resetIntentCaptureForTest(): void {
  _lastIntentCaptureDate = null
  coordinator._resetForTest()
}

/**
 * 客户端 capture-response（skip / auto_skip）。
 * - skip：先到先赢，广播 dismiss 关闭全端弹窗
 * - auto_skip（客户端本地超时）：只关自己，不参与协调；统一关闭由服务器 timeout 广播 expired
 */
export function handleIntentCaptureResponse(msg: { prompt_id: string; action: 'skip' | 'auto_skip' }): void {
  if (msg.action === 'auto_skip') return
  coordinator.handleResponse(msg.prompt_id, 'skipped')
}

/** 客户端开始输入：接管捕获（清除服务器过期定时器，广播 typing 关闭其他端） */
export function handleIntentInput(promptId: string): void {
  coordinator.handleInput(promptId)
}

/**
 * 意图提交成功后的协调（由 handleIntentSubmit 调用）：
 * - prompt_id 匹配活跃捕获 → 正常 resolve，广播 dismiss answered
 * - 无匹配（重开入口提交 / 无活跃捕获）→ 广播 dismiss answered（无 prompt_id），
 *   让其他端可能开着的重开弹窗一并关闭、取消重开入口
 */
export function notifyIntentSubmitted(promptId?: string): void {
  if (promptId && coordinator.isActive(promptId)) {
    coordinator.resolve('answered')
    return
  }
  void import('../ws/server').then(m => m.broadcast({
    type: 'intent:dismiss',
    reason: 'answered',
  })).catch(console.error)
}

/**
 * 起床物理验证完成后调用。
 * 查询昨日意图，广播 intent:confirm 给客户端展示。
 * 若昨日无意图则静默不广播。
 */
export async function triggerIntentConfirmOnWakeup(db: Db): Promise<void> {
  // 先查今天，再查昨天（跨午夜兼容）
  const today = todayString()
  const yesterday = yesterdayString()

  let row = db
    .select()
    .from(dailyIntentions)
    .where(eq(dailyIntentions.date, today))
    .get()

  // 起床时今天可能还没有意图，查昨天
  if (!row) {
    row = db
      .select()
      .from(dailyIntentions)
      .where(eq(dailyIntentions.date, yesterday))
      .get()
  }

  if (!row) return // 无意图，静默

  const { broadcast } = await import('../ws/server')
  broadcast({
    type: 'intent:confirm',
    date: row.date,
    content: row.content,
  })
}

/**
 * 获取今日意图（供时间块绑定使用）。
 * 若今日无意图，返回 null。
 */
export function getTodayIntention(db: Db): {
  date: string
  content: string
} | null {
  const today = todayString()
  const row = db
    .select()
    .from(dailyIntentions)
    .where(eq(dailyIntentions.date, today))
    .get()

  if (!row) return null
  return {
    date: row.date,
    content: row.content,
  }
}

/**
 * 获取最近 N 天的意图记录（用于 morning 首个时间块绑定摘要）。
 */
export function getRecentIntentions(db: Db, days = 7): Array<{
  date: string
  content: string
}> {
  const cutoffStr = getUserDateStr(Date.now() - days * 24 * 60 * 60 * 1000)

  return db
    .select()
    .from(dailyIntentions)
    .orderBy(desc(dailyIntentions.date))
    .all()
    .filter(r => r.date >= cutoffStr)
    .map(r => ({
      date: r.date,
      content: r.content,
    }))
}
