import { createApiClient } from '@anchor/api-client'
import type { BehaviorEventType, FrictionUsageContext, Result } from '@anchor/types'

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_start',

  main() {
    const ANCHOR_SERVER = (import.meta.env.VITE_ANCHOR_SERVER as string) || 'http://localhost:4000'
    const api = createApiClient(ANCHOR_SERVER)

    function sendBehavior(event_type: BehaviorEventType, payload: Record<string, unknown>) {
      chrome.runtime.sendMessage({
        type: 'behavior:report',
        event_type,
        payload,
      }).catch(() => {})
    }

    // video_state：监听页面内所有 <video> 元素的播放/暂停事件
    function attachVideoListeners(video: HTMLVideoElement) {
      video.addEventListener('play', () => {
        sendBehavior('video_state', { domain: location.hostname, state: 'play', duration_watched_sec: Math.floor(video.currentTime) })
      })
      video.addEventListener('pause', () => {
        sendBehavior('video_state', { domain: location.hostname, state: 'pause', duration_watched_sec: Math.floor(video.currentTime) })
      })
    }

    document.querySelectorAll('video').forEach(v => attachVideoListeners(v as HTMLVideoElement))

    // 动态插入的 video 元素也需监听
    const observer = new MutationObserver(mutations => {
      for (const m of mutations) {
        m.addedNodes.forEach(node => {
          if (node instanceof HTMLVideoElement) attachVideoListeners(node)
          if (node instanceof Element) node.querySelectorAll('video').forEach(v => attachVideoListeners(v as HTMLVideoElement))
        })
      }
    })
    observer.observe(document.documentElement, { childList: true, subtree: true })

    function applyGrayscale(enabled: boolean) {
      if (enabled) {
        document.documentElement.style.filter = 'grayscale(100%)'
      } else {
        document.documentElement.style.filter = ''
      }
    }

    let _cachedUsageCtx: FrictionUsageContext | null = null
    let _usageCtxFetchedAt = 0

    async function fetchUsageContext(): Promise<FrictionUsageContext | null> {
      const now = Date.now()
      // 缓存 5 分钟，避免每次弹摩擦都发请求
      if (_cachedUsageCtx && now - _usageCtxFetchedAt < 5 * 60 * 1000) {
        return _cachedUsageCtx
      }
      try {
        const resp = await chrome.runtime.sendMessage({ type: 'friction:usage-context-request' })
        if (resp?.ok && resp.data) {
          _cachedUsageCtx = resp.data as FrictionUsageContext
          _usageCtxFetchedAt = now
          return _cachedUsageCtx
        }
      } catch { /* 降级：不显示使用时长 */ }
      return null
    }

    // Module 6：显示带使用时长的摩擦横幅（高刺激路径加摩擦）
    async function showFrictionBanner(
      message = '宵禁时间，该休息了',
      showUsageStats = false,
      intervention_id?: string,
      action?: string,
    ) {
      const existing = document.getElementById('anchor-friction-banner')
      if (existing) existing.remove()

      const banner = document.createElement('div')
      banner.id = 'anchor-friction-banner'
      Object.assign(banner.style, {
        position: 'fixed',
        top: '0',
        left: '0',
        width: '100%',
        background: '#1c1814',
        color: '#f5f0eb',
        padding: '10px 16px',
        fontSize: '14px',
        textAlign: 'center',
        zIndex: '999999',
        boxSizing: 'border-box',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        lineHeight: '1.5',
      })

      let bannerContent = `<span>${message}</span>`

      // Module 6 高刺激路径加摩擦：注入今日已用时长和连续天数
      if (showUsageStats) {
        const ctx = await fetchUsageContext()
        if (ctx) {
          const parts: string[] = []
          if (ctx.today_entertainment_formatted && ctx.today_entertainment_formatted !== '0m') {
            parts.push(`今日已用 <strong>${ctx.today_entertainment_formatted}</strong>`)
          }
          if (ctx.consecutive_high_entertainment_days >= 2) {
            parts.push(`连续 <strong>${ctx.consecutive_high_entertainment_days}</strong> 天高娱乐时长`)
          }
          if (parts.length > 0) {
            bannerContent += `<span style="margin-left:12px;color:#c0622a;font-size:13px">${parts.join(' · ')}</span>`
          }
        }
      }

      banner.innerHTML = bannerContent

      document.documentElement.appendChild(banner)

      setTimeout(() => {
        banner.remove()
        reportInterventionResult(intervention_id, action, 'expired', false)
      }, 4000)
    }

    function injectHardBlock(message?: string, intervention_id?: string, action?: string) {
      if (document.getElementById('anchor-hard-block')) return

      const overlay = document.createElement('div')
      overlay.id = 'anchor-hard-block'
      overlay.style.cssText = `
        position: fixed; inset: 0; z-index: 2147483647;
        background: #1c1814;
        display: flex; flex-direction: column;
        align-items: center; justify-content: center;
        font-family: system-ui, -apple-system, sans-serif;
      `

      const nowText = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })

      overlay.innerHTML = `
        <div style="font-size:48px;margin-bottom:16px">🌙</div>
        <div style="color:#f5f0eb;font-size:20px;font-weight:600;margin-bottom:8px">
          ${message || '宵禁时间，该休息了'}
        </div>
        <div style="color:#9e978e;font-size:14px;margin-bottom:32px">${nowText}</div>
        <button id="anchor-force-unlock" style="
          border: 1px solid #3a3228; background: transparent;
          color: #6b6560; font-size: 12px; padding: 8px 20px;
          border-radius: 6px; cursor: pointer;
        ">强制解锁（需填写原因）</button>
      `

      document.documentElement.appendChild(overlay)

      const btn = document.getElementById('anchor-force-unlock')
      btn?.addEventListener('click', () => {
        showModal({
          title: '强制解锁宵禁',
          content: '解锁会被记录为破戒。请简单说明原因，帮助自己复盘。',
          input: { placeholder: '例如：需要查资料、还没准备好', rows: 2 },
          buttons: [
            { id: 'cancel', label: '取消' },
            { id: 'confirm', label: '确认解锁', primary: true },
          ],
          onAction: (id, value) => {
            const reason = value?.trim() ?? ''
            if (id !== 'confirm' || reason === '') return
            overlay.remove()
            reportInterventionResult(intervention_id, action, 'dismissed', true)
            chrome.runtime.sendMessage({ type: 'sunset:breach', reason })
          },
        })
      })
    }

    const interventionShownAt = new Map<string, number>()

    function reportInterventionResult(
      intervention_id: string | undefined,
      action: string | undefined,
      result: 'executed' | 'dismissed' | 'expired',
      dismissed_by_user: boolean,
    ) {
      if (!intervention_id || !action) return
      const shownAt = interventionShownAt.get(intervention_id) ?? Date.now()
      interventionShownAt.delete(intervention_id)
      chrome.runtime.sendMessage({
        type: 'intervention:result',
        intervention_id,
        action,
        result,
        dismissed_by_user,
        dismissed_after_ms: Date.now() - shownAt,
      }).catch(() => {})
    }

    function showToast(message: string, kind: 'ai' | 'time' | 'suggestion' = 'ai', actions?: Array<{ label: string; id: string }>) {
      const id = `anchor-toast-${kind}-${Date.now()}`
      const existing = document.getElementById(id)
      if (existing) existing.remove()

      const colors: Record<typeof kind, string> = {
        ai: '#c0622a',
        time: '#22863a',
        suggestion: '#b08800',
      }

      const wrapper = document.createElement('div')
      wrapper.id = id
      Object.assign(wrapper.style, {
        position: 'fixed',
        top: '16px',
        right: '16px',
        maxWidth: '360px',
        background: '#1c1814',
        color: '#f5f0eb',
        padding: '12px 16px',
        borderRadius: '8px',
        fontSize: '14px',
        zIndex: '2147483646',
        boxShadow: '0 4px 24px rgba(0,0,0,0.25)',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        lineHeight: '1.5',
        borderLeft: `4px solid ${colors[kind]}`,
      })

      let html = `<div>${message}</div>`
      if (actions && actions.length > 0) {
        html += `<div style="margin-top:10px;display:flex;gap:8px;justify-content:flex-end">`
        for (const a of actions) {
          html += `<button data-action="${a.id}" style="background:${colors[kind]};color:#fff;border:none;padding:6px 12px;border-radius:4px;font-size:13px;cursor:pointer">${a.label}</button>`
        }
        html += `</div>`
      }
      wrapper.innerHTML = html

      wrapper.querySelectorAll('button[data-action]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const actionId = btn.getAttribute('data-action') ?? ''
          chrome.runtime.sendMessage({ type: 'action:response', action_id: actionId, choice: 'accepted' }).catch(() => {})
          wrapper.remove()
        })
      })

      document.documentElement.appendChild(wrapper)
      setTimeout(() => wrapper.remove(), 8000)
    }

    function showConfigErrorBanner(message: string) {
      const id = 'anchor-config-error-banner'
      const existing = document.getElementById(id)
      if (existing) existing.remove()

      const wrapper = document.createElement('div')
      wrapper.id = id
      wrapper.setAttribute('data-anchor-config-error', 'true')
      Object.assign(wrapper.style, {
        position: 'fixed',
        top: '0',
        left: '0',
        width: '100%',
        padding: '12px 16px',
        background: '#1c1814',
        color: '#f5f0eb',
        borderBottom: '3px solid #cf222e',
        zIndex: '2147483647',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        fontSize: '14px',
        boxSizing: 'border-box',
      })

      wrapper.innerHTML = `
        <div style="display: flex; align-items: center; gap: 8px;">
          <span style="color: #cf222e; font-size: 16px;">⚠</span>
          <span><b>配置错误:</b> ${message}</span>
        </div>
        <button id="anchor-dismiss-banner" style="
          background: none;
          border: none;
          color: #9e978e;
          cursor: pointer;
          font-size: 18px;
          padding: 0 4px;
        ">×</button>
      `

      document.documentElement.prepend(wrapper)

      // 关闭按钮
      wrapper.querySelector('#anchor-dismiss-banner')?.addEventListener('click', () => {
        removeConfigErrorBanner()
      })

      // 10秒后自动隐藏
      setTimeout(removeConfigErrorBanner, 10000)
    }

    function removeConfigErrorBanner() {
      document.querySelector('[data-anchor-config-error]')?.remove()
    }

    function showCapsule(content: string, trigger?: string) {
      const id = 'anchor-capsule'
      const existing = document.getElementById(id)
      if (existing) existing.remove()

      const wrapper = document.createElement('div')
      wrapper.id = id
      Object.assign(wrapper.style, {
        position: 'fixed',
        inset: '0',
        background: 'rgba(28,24,20,0.96)',
        color: '#f5f0eb',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: '2147483647',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        padding: '32px',
      })

      wrapper.innerHTML = `
        <div style="font-size:14px;color:#9e9690;margin-bottom:12px">时间胶囊 · ${trigger ?? 'Anchor'}</div>
        <div style="font-size:22px;max-width:560px;text-align:center;line-height:1.6">${content}</div>
        <button id="anchor-capsule-close" style="margin-top:32px;background:transparent;border:1px solid #3a3530;color:#9e9690;padding:8px 24px;border-radius:6px;cursor:pointer">关闭</button>
      `

      document.body.appendChild(wrapper)
      document.getElementById('anchor-capsule-close')?.addEventListener('click', () => wrapper.remove())
    }

    function showWakeupAlarm() {
      showModal({
        title: '起床时间',
        content: 'Anchor 检测到该起床了。确认已醒来？',
        buttons: [
          { id: 'verify', label: '我已醒来', primary: true },
          { id: 'snooze', label: '稍后', primary: false },
        ],
        onAction: (id) => {
          if (id === 'verify') {
            chrome.runtime.sendMessage({ type: 'wakeup:verified' }).catch(() => {})
          }
        },
      })
    }

    // 入睡确认框：服务器怀疑已睡着。只有「还没睡」选项——能点击即证明醒着；
    // 无响应则服务器在窗口超时后自动确认睡着（并广播 cancel 销毁本框）。
    let sleepConfirmTimer: ReturnType<typeof setTimeout> | null = null
    function showSleepConfirm(confirmUntil: number) {
      document.getElementById('anchor-sleep-confirm')?.remove()
      if (sleepConfirmTimer) clearTimeout(sleepConfirmTimer)

      const wrapper = document.createElement('div')
      wrapper.id = 'anchor-sleep-confirm'
      Object.assign(wrapper.style, {
        position: 'fixed',
        inset: '0',
        background: 'rgba(28,24,20,0.92)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: '2147483647',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        padding: '24px',
      })
      wrapper.innerHTML = `
        <div style="background:#1c1814;border-radius:12px;padding:24px;max-width:440px;width:100%;box-shadow:0 8px 40px rgba(0,0,0,0.35)">
          <div style="font-size:16px;font-weight:600;color:#f5f0eb;margin-bottom:10px">睡着了吗？</div>
          <div style="font-size:14px;color:#c8c0b8;line-height:1.5;margin-bottom:16px">Anchor 检测到你很久没活动，推测你可能已经入睡。若没有回应，将自动视为已睡着。</div>
          <div style="display:flex;gap:10px;justify-content:flex-end">
            <button id="anchor-sleep-notyet" style="background:#c0622a;color:#fff;border:1px solid #c0622a;padding:8px 18px;border-radius:6px;cursor:pointer;font-size:13px">还没睡</button>
          </div>
        </div>
      `
      document.body.appendChild(wrapper)
      document.getElementById('anchor-sleep-notyet')?.addEventListener('click', () => {
        chrome.runtime.sendMessage({ type: 'sleep:confirm-response', confirmed: false }).catch(() => {})
        removeSleepConfirm()
      })

      // 本地兜底：窗口到期自动移除（服务器 timeout 也会广播 cancel）
      const remainingMs = confirmUntil * 1000 - Date.now()
      if (remainingMs > 0) {
        sleepConfirmTimer = setTimeout(removeSleepConfirm, remainingMs)
      }
    }

    function removeSleepConfirm() {
      document.getElementById('anchor-sleep-confirm')?.remove()
      if (sleepConfirmTimer) { clearTimeout(sleepConfirmTimer); sleepConfirmTimer = null }
    }

    function showAiResponse(response: string) {
      showToast(response, 'ai')
    }

    interface ModalOptions {
      title: string
      content: string
      input?: { placeholder?: string; rows?: number }
      buttons: Array<{ id: string; label: string; primary?: boolean }>
      onAction: (id: string, value?: string) => void
    }

    function showModal(opts: ModalOptions): string {
      // 硬拦截遮罩等弹层也挂在 documentElement 上，弹层必须同挂一处才能稳定置顶；
      // 同时清掉旧弹层，避免连点叠出多个同名 form 字段
      document.querySelectorAll('.anchor-modal').forEach(el => el.remove())

      const id = `anchor-modal-${Date.now()}`
      const wrapper = document.createElement('div')
      wrapper.id = id
      wrapper.classList.add('anchor-modal')
      Object.assign(wrapper.style, {
        position: 'fixed',
        inset: '0',
        background: 'rgba(28,24,20,0.92)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: '2147483647',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        padding: '24px',
      })

      const inputHtml = opts.input
        ? `<textarea style="width:100%;min-height:${opts.input.rows ? opts.input.rows * 24 : 80}px;background:#2a2520;border:1px solid #3a3530;color:#f5f0eb;border-radius:6px;padding:10px;font-size:14px;resize:vertical;box-sizing:border-box" placeholder="${opts.input.placeholder ?? ''}"></textarea>`
        : ''

      const buttonsHtml = opts.buttons.map((b) =>
        `<button data-id="${b.id}" style="background:${b.primary ? '#c0622a' : 'transparent'};color:${b.primary ? '#fff' : '#9e9690'};border:1px solid ${b.primary ? '#c0622a' : '#3a3530'};padding:8px 18px;border-radius:6px;cursor:pointer;font-size:13px">${b.label}</button>`
      ).join('')

      wrapper.innerHTML = `
        <div style="background:#1c1814;border-radius:12px;padding:24px;max-width:440px;width:100%;box-shadow:0 8px 40px rgba(0,0,0,0.35)">
          <div style="font-size:16px;font-weight:600;color:#f5f0eb;margin-bottom:10px">${opts.title}</div>
          <div style="font-size:14px;color:#c8c0b8;line-height:1.5;margin-bottom:16px">${opts.content}</div>
          ${inputHtml ? `<div style="margin-bottom:16px">${inputHtml}</div>` : ''}
          <div style="display:flex;gap:10px;justify-content:flex-end">${buttonsHtml}</div>
        </div>
      `

      document.documentElement.appendChild(wrapper)

      wrapper.querySelectorAll('button[data-id]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const btnId = btn.getAttribute('data-id') ?? ''
          const inputEl = wrapper.querySelector('textarea') as HTMLTextAreaElement | null
          const value = inputEl?.value
          wrapper.remove()
          opts.onAction(btnId, value)
        })
      })

      return id
    }

    // 睡前意图弹窗：先到先赢，任一端响应后服务器广播 dismiss 全端关闭（通用 TimedPrompt 装配）
    function showIntentCapture(promptId: string, timeoutSeconds: number, prompt: string, _isDegraded: boolean, focuslayerHint?: string) {
      const hint = focuslayerHint ? `\n\nFocusLayer 提示：${focuslayerHint}` : ''
      showTimedPrompt({
        elementId: 'anchor-intent-capture',
        title: '睡前意图',
        body: prompt + hint,
        placeholder: '例如：明天优先完成 API 文档和 review PR',
        promptId,
        timeoutSeconds,
        countdownText: (r) => `${r}s 后自动关闭，可在手机通知或桌面托盘重开`,
        submitLabel: '保存意图',
        skipLabel: '稍后',
        inputMessageType: 'intent:input',
        onRespond: (action, text) => {
          if (action === 'submit' && text) {
            chrome.runtime.sendMessage({ type: 'intent:submit', content: text, source: 'bedtime', prompt_id: promptId }).catch(() => {})
          } else {
            // 稍后/空提交/超时：skip 类响应上报，先到先赢，重开入口保留在手机/桌面
            chrome.runtime.sendMessage({ type: 'intent:capture-response', prompt_id: promptId, action: action === 'submit' ? 'skip' : action }).catch(() => {})
          }
        },
      })
    }

    function removeIntentCapture(promptId?: string) {
      removeTimedPrompt('anchor-intent-capture', promptId)
    }


    function showIntentConfirm(date: string, content: string) {
      showModal({
        title: '昨日意图',
        content: `你在 ${date} 记录的意图：\n${content}`,
        buttons: [
          { id: 'confirm', label: '确认', primary: true },
          { id: 'skip', label: '跳过', primary: false },
        ],
        onAction: (id) => {
          if (id === 'confirm') {
            chrome.runtime.sendMessage({ type: 'intent:confirm', date }).catch(() => {})
          }
        },
      })
    }

    // ─── 通用计时提示弹窗（状态切换 / 睡前意图共用模板）─────────────
    // 语义：timeoutSeconds 内未输入自动 auto_skip；一旦输入倒计时停止，只能手动提交/跳过；
    // 任一端响应后服务器广播 dismiss，由 removeTimedPrompt 按 prompt_id 关闭。

    interface TimedPromptOptions {
      elementId: string
      title: string
      body: string
      placeholder: string
      promptId: string
      timeoutSeconds: number
      countdownText: (remaining: number) => string
      submitLabel: string
      skipLabel: string
      /** 首次输入时上报的接管消息类型（context_switch:input / intent:input） */
      inputMessageType?: 'context_switch:input' | 'intent:input'
      onRespond: (action: 'submit' | 'skip' | 'auto_skip', text?: string) => void
    }

    const timedPromptTimers = new Map<string, ReturnType<typeof setInterval>>()

    function removeTimedPrompt(elementId: string, promptId?: string, force = false) {
      const el = document.getElementById(elementId)
      if (!el) return
      // 用户已开始输入：不自动关闭（dismiss/接管广播无效），等待手动提交/跳过；
      // force 用于用户主动操作或新弹窗顶替
      if (!force && el.dataset.typed === '1') return
      // promptId 为空（answered 广播）时无条件关闭；否则仅关闭匹配的弹窗
      if (promptId && el.dataset.promptId !== promptId) return
      const timer = timedPromptTimers.get(elementId)
      if (timer) { clearInterval(timer); timedPromptTimers.delete(elementId) }
      el.remove()
    }

    function showTimedPrompt(opts: TimedPromptOptions) {
      removeTimedPrompt(opts.elementId, undefined, true)

      const wrapper = document.createElement('div')
      wrapper.id = opts.elementId
      wrapper.dataset.promptId = opts.promptId
      Object.assign(wrapper.style, {
        position: 'fixed',
        inset: '0',
        background: 'rgba(28,24,20,0.92)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: '2147483647',
        fontFamily: 'system-ui, -apple-system, sans-serif',
        padding: '24px',
      })

      wrapper.innerHTML = `
        <div style="background:#1c1814;border-radius:12px;padding:24px;max-width:440px;width:100%;box-shadow:0 8px 40px rgba(0,0,0,0.35)">
          <div style="font-size:16px;font-weight:600;color:#f5f0eb;margin-bottom:10px">${opts.title}</div>
          <div style="font-size:14px;color:#c8c0b8;line-height:1.5;margin-bottom:16px;white-space:pre-line">${opts.body}</div>
          <div style="margin-bottom:8px"><textarea class="anchor-tp-input" style="width:100%;min-height:80px;background:#2a2520;border:1px solid #3a3530;color:#f5f0eb;border-radius:6px;padding:10px;font-size:14px;resize:vertical;box-sizing:border-box" placeholder="${opts.placeholder}"></textarea></div>
          <div class="anchor-tp-countdown" style="font-size:12px;color:#9e9690;margin-bottom:12px;text-align:right">${opts.countdownText(opts.timeoutSeconds)}</div>
          <div style="display:flex;gap:10px;justify-content:flex-end">
            <button data-id="skip" style="background:transparent;color:#9e9690;border:1px solid #3a3530;padding:8px 18px;border-radius:6px;cursor:pointer;font-size:13px">${opts.skipLabel}</button>
            <button data-id="submit" style="background:#c0622a;color:#fff;border:1px solid #c0622a;padding:8px 18px;border-radius:6px;cursor:pointer;font-size:13px">${opts.submitLabel}</button>
          </div>
        </div>
      `

      document.body.appendChild(wrapper)

      const respond = (action: 'submit' | 'skip' | 'auto_skip', text?: string) => {
        removeTimedPrompt(opts.elementId, undefined, true)
        opts.onRespond(action, text)
      }

      // 倒计时：仅当用户完全未输入时生效；一旦开始输入即取消，之后只能手动操作
      let remaining = opts.timeoutSeconds
      const countdownEl = wrapper.querySelector('.anchor-tp-countdown') as HTMLDivElement | null
      timedPromptTimers.set(opts.elementId, setInterval(() => {
        remaining -= 1
        if (remaining <= 0) {
          respond('auto_skip')
          return
        }
        if (countdownEl) countdownEl.textContent = opts.countdownText(remaining)
      }, 1000))

      const inputEl = wrapper.querySelector('.anchor-tp-input') as HTMLTextAreaElement | null
      let inputSent = false
      inputEl?.addEventListener('input', () => {
        const timer = timedPromptTimers.get(opts.elementId)
        if (timer) { clearInterval(timer); timedPromptTimers.delete(opts.elementId) }
        if (countdownEl) countdownEl.textContent = ''
        wrapper.dataset.typed = '1'
        // 首次输入：上报接管信号（仅一次），服务器广播 typing 关闭其他端
        if (!inputSent && opts.inputMessageType) {
          inputSent = true
          chrome.runtime.sendMessage({ type: opts.inputMessageType, prompt_id: opts.promptId }).catch(() => {})
        }
      })
      inputEl?.focus()

      wrapper.querySelectorAll('button[data-id]').forEach((btn) => {
        btn.addEventListener('click', () => {
          const btnId = btn.getAttribute('data-id') ?? ''
          const value = inputEl?.value.trim()
          if (btnId === 'submit' && value) {
            respond('submit', value)
          } else {
            respond('skip')
          }
        })
      })
    }

    function showContextSwitchPrompt(promptId: string, timeoutSeconds: number, placeholder: string) {
      showTimedPrompt({
        elementId: 'anchor-context-switch',
        title: '状态切换',
        body: '你似乎从工作切换到了其他状态。方便说一下接下来的打算吗？',
        placeholder,
        promptId,
        timeoutSeconds,
        countdownText: (r) => `${r}s 后自动跳过，输入后取消倒计时`,
        submitLabel: '提交',
        skipLabel: '跳过',
        inputMessageType: 'context_switch:input',
        onRespond: (action, text) => {
          chrome.runtime.sendMessage({ type: 'context_switch:response', prompt_id: promptId, action, text }).catch(() => {})
        },
      })
    }

    function removeContextSwitchPrompt(promptId?: string) {
      removeTimedPrompt('anchor-context-switch', promptId)
    }

    chrome.runtime.onMessage.addListener((message) => {
      const { intervention_id, action } = message as { intervention_id?: string; action?: string }
      if (intervention_id && action) {
        interventionShownAt.set(intervention_id, Date.now())
      }
      if (message?.type === 'sunset:grayscale') {
        applyGrayscale(!!message.enabled)
      } else if (message?.type === 'sunset:friction') {
        if (message.enabled === false) {
          document.getElementById('anchor-friction-banner')?.remove()
        } else {
          showFrictionBanner(message.message as string | undefined, true, intervention_id, action)
        }
      } else if (message?.type === 'hard:block') {
        if (message.enabled === false) {
          document.getElementById('anchor-hard-block')?.remove()
        } else {
          injectHardBlock(message.message as string | undefined, intervention_id, action)
        }
      } else if (message?.type === 'anchor:toast') {
        showToast(message.message as string, message.kind as 'ai' | 'time' | 'suggestion', message.actions as Array<{ label: string; id: string }> | undefined)
      } else if (message?.type === 'anchor:capsule') {
        showCapsule(message.content as string, message.trigger as string | undefined)
      } else if (message?.type === 'anchor:wakeup') {
        showWakeupAlarm()
      } else if (message?.type === 'anchor:sleep_confirm') {
        showSleepConfirm(message.confirm_until as number)
      } else if (message?.type === 'anchor:sleep_confirm_cancel') {
        removeSleepConfirm()
      } else if (message?.type === 'anchor:ai_response') {
        showAiResponse(message.response as string)
      } else if (message?.type === 'anchor:intent_capture') {
        showIntentCapture(message.prompt_id as string, (message.timeoutSeconds as number) ?? 60, message.prompt as string, !!message.is_degraded, message.focuslayer_hint as string | undefined)
      } else if (message?.type === 'anchor:intent_dismiss') {
        removeIntentCapture(message.prompt_id as string | undefined)
      } else if (message?.type === 'anchor:intent_typing') {
        removeIntentCapture(message.prompt_id as string | undefined)
      } else if (message?.type === 'anchor:intent_confirm') {
        showIntentConfirm(message.date as string, message.content as string)
      } else if (message?.type === 'anchor:context_switch') {
        showContextSwitchPrompt(message.prompt_id as string, message.timeoutSeconds as number, message.placeholder as string)
      } else if (message?.type === 'anchor:context_switch_dismiss') {
        removeContextSwitchPrompt(message.prompt_id as string | undefined)
      } else if (message?.type === 'anchor:context_switch_typing') {
        removeContextSwitchPrompt(message.prompt_id as string | undefined)
      } else if (message?.type === 'anchor:config_error') {
        showConfigErrorBanner(message.message as string)
      }
    })

    // 页面加载完成即上报，让 background 补发当前宵禁阶段效果
    // （进入时已在宵禁状态，无需等服务器下一次广播）
    chrome.runtime.sendMessage({ type: 'page:ready', url: location.href }).catch(() => {})

    // SPA 导航监听：当 URL 变化时移除 hard block 覆盖层并上报
    // YouTube / Bilibili / Twitter/X 等 SPA 站点使用 pushState 导航，不触发 document unload
    let _lastHref = location.href

    function handleSpaNavigation() {
      if (location.href === _lastHref) return
      _lastHref = location.href
      const overlay = document.getElementById('anchor-hard-block')
      if (overlay) overlay.remove()
      chrome.runtime.sendMessage({
        type: 'spa:navigation',
        url: location.href,
        title: document.title,
      }).catch(() => {})
    }

    window.addEventListener('popstate', handleSpaNavigation)
    window.addEventListener('hashchange', handleSpaNavigation)

    const originalPushState = history.pushState
    history.pushState = function (...args: Parameters<typeof history.pushState>) {
      originalPushState.apply(this, args)
      handleSpaNavigation()
    }
    const originalReplaceState = history.replaceState
    history.replaceState = function (...args: Parameters<typeof history.replaceState>) {
      originalReplaceState.apply(this, args)
      handleSpaNavigation()
    }
  },
})
