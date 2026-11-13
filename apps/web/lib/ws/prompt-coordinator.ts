/**
 * 计时提示弹窗的跨端协调器（先到先赢）— 通用模板
 *
 * 适用场景：服务器广播一个带倒计时的弹窗（状态切换、睡前意图……），
 * 任一端响应后广播 dismiss 关闭所有客户端弹窗。
 *
 * 语义（与 context_switch / intent 一致）：
 * - 单用户模型：任一时刻最多一个活跃弹窗，新弹窗顶掉未解决的旧弹窗（按 expired 关闭）
 * - 先到先赢：id 不匹配或已解决的响应直接忽略
 * - 服务器兜底到期：客户端本地计时器可能失效（tab 休眠等），timeout+grace 后广播 expired
 * - 各弹窗的差异（消息类型、载荷存储、额外守卫）由调用方在装配层处理
 */

import type { WsServerMessage } from '@anchor/types'

export type PromptResolveReason = 'answered' | 'skipped' | 'expired'

interface ActivePrompt {
  promptId: string
  openedAt: number
  resolved: boolean
  expireTimer: NodeJS.Timeout | null
  /** 已有客户端开始输入（接管）：清除过期定时器，提交/跳过不受倒计时限制 */
  inputting: boolean
}

// 服务器兜底到期宽限：等客户端本地计时器先触发
const EXPIRE_GRACE_MS = 5000

export interface PromptCoordinatorOptions<TOpen> {
  /** prompt_id 前缀（如 cs / intent） */
  idPrefix: string
  /** 弹窗倒计时秒数（客户端计时与服务器兜底到期的共同基准） */
  timeoutSeconds: number
  /** 构造打开广播消息（必须携带 prompt_id 与 timeoutSeconds） */
  makeOpenMessage: (promptId: string, timeoutSeconds: number, extra: TOpen) => WsServerMessage
  /** 构造关闭广播消息 */
  makeDismissMessage: (promptId: string, reason: PromptResolveReason) => WsServerMessage
  /** 构造「已有客户端开始输入接管」广播消息（其他端收到后关闭弹窗） */
  makeTypingMessage: (promptId: string) => WsServerMessage
}

export interface PromptCoordinator<TOpen> {
  /** 打开新弹窗并广播；新弹窗顶掉未解决的旧弹窗。返回 promptId */
  open(extra: TOpen): string
  /** 客户端响应：先到先赢，接受返回 true（id 不匹配或已解决返回 false） */
  handleResponse(promptId: string, reason: 'answered' | 'skipped'): boolean
  /** 客户端开始输入：接管 prompt（清除过期定时器 + 广播 typing 关闭其他端）。
   *  接管后该 prompt 不再过期，提交/跳过永远有效。返回是否接管成功 */
  handleInput(promptId: string): boolean
  /** 主动关闭当前活跃弹窗（无活跃或已解决时静默） */
  resolve(reason: PromptResolveReason): void
  /** 是否存在未解决的活跃弹窗（可指定 promptId 匹配） */
  isActive(promptId?: string): boolean
  /** 测试专用：清理内部状态（模块级单例跨用例共享） */
  _resetForTest(): void
}

export function createPromptCoordinator<TOpen>(opts: PromptCoordinatorOptions<TOpen>): PromptCoordinator<TOpen> {
  let active: ActivePrompt | null = null

  function broadcast(msg: WsServerMessage): void {
    void import('./server').then(m => m.broadcast(msg)).catch(console.error)
  }

  function resolveActive(reason: PromptResolveReason): void {
    if (!active) return
    active.resolved = true
    if (active.expireTimer) {
      clearTimeout(active.expireTimer)
      active.expireTimer = null
    }
    broadcast(opts.makeDismissMessage(active.promptId, reason))
  }

  return {
    open(extra: TOpen): string {
      if (active && !active.resolved) {
        resolveActive('expired')
      }
      const promptId = `${opts.idPrefix}-${Date.now()}`
      const timer = setTimeout(() => {
        if (active && active.promptId === promptId && !active.resolved) {
          resolveActive('expired')
        }
      }, opts.timeoutSeconds * 1000 + EXPIRE_GRACE_MS)

      active = { promptId, openedAt: Date.now(), resolved: false, expireTimer: timer, inputting: false }
      broadcast(opts.makeOpenMessage(promptId, opts.timeoutSeconds, extra))
      return promptId
    },

    handleResponse(promptId: string, reason: 'answered' | 'skipped'): boolean {
      if (!active || active.resolved || active.promptId !== promptId) return false
      resolveActive(reason)
      return true
    },

    handleInput(promptId: string): boolean {
      if (!active || active.resolved || active.promptId !== promptId) return false
      if (active.inputting) return true
      active.inputting = true
      if (active.expireTimer) {
        clearTimeout(active.expireTimer)
        active.expireTimer = null
      }
      broadcast(opts.makeTypingMessage(promptId))
      return true
    },

    resolve(reason: PromptResolveReason): void {
      if (!active || active.resolved) return
      resolveActive(reason)
    },

    isActive(promptId?: string): boolean {
      if (!active || active.resolved) return false
      return promptId === undefined || active.promptId === promptId
    },

    _resetForTest(): void {
      if (active?.expireTimer) clearTimeout(active.expireTimer)
      active = null
    },
  }
}
