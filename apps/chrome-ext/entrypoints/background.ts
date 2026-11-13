import type { BehaviorEventType, WsClientMessage, WsServerMessage } from '@anchor/types'
import { encryptEnvelope } from '@anchor/utils'
import { createBadgeController, type SunsetPhase } from '../src/badge'
import { getServerConfig, loadServerConfig, onServerConfigChange, wsUrlFor } from '../src/config'
import { enqueueEvent, getAllQueuedEvents, removeQueuedEvent } from '../src/behavior-queue'
import { createInterventionHandler } from '../src/intervention-handler'
import { createSiteClassifier, type SiteClassificationsCache } from '../src/site-classifier'
import { startTabMonitoring, type RuntimeState } from '../src/tab-monitor'
import { getDomain, WHITELIST_HOSTS } from '../src/utils'
import { createWsClient } from '../src/ws-client'

const RUNTIME_STATE_KEY = 'anchor_runtime_state'
const SUNSET_PHASE_KEY = 'sunset:phase'
const SUNSET_EXPIRES_KEY = 'sunset:expires_at'
const SUNSET_ALARM = 'anchor:sunset-expiry'

export default defineBackground(() => {
  const state: RuntimeState = {
    tabActivatedAt: {},
    lastDomain: '',
    lastSwitchAt: Date.now(),
    newTabsWindow: [],
    lastExplosionSentAt: 0,
  }

  function arrayBufferToBase64(buf: ArrayBuffer): string {
    const bytes = new Uint8Array(buf)
    let binary = ''
    for (let i = 0; i < bytes.length; i += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    }
    return btoa(binary)
  }

  async function fetchImageAsBase64(url: string): Promise<{ buf: ArrayBuffer; mime: string } | null> {
    try {
      if (url.startsWith('data:image/')) return null // data URL 走调用方直传
      if (!/^https?:\/\//.test(url)) return null
      const resp = await fetch(url)
      if (!resp.ok) return null
      const mime = (resp.headers.get('content-type') ?? '').split(';')[0].trim()
      if (mime && !mime.startsWith('image/') && mime !== 'application/octet-stream') return null
      const buf = await resp.arrayBuffer()
      if (buf.byteLength === 0) return null
      return { buf, mime }
    } catch {
      return null
    }
  }

  // 大图标（现代站点常见几百 KB 的多尺寸 ico）在 SW 内缩成 32px PNG，避免撑爆存储
  async function resizeToPng32(buf: ArrayBuffer, mime: string): Promise<string | null> {
    try {
      const blob = new Blob([buf], { type: mime.startsWith('image/') ? mime : 'image/x-icon' })
      const bitmap = await createImageBitmap(blob)
      const canvas = new OffscreenCanvas(32, 32)
      const ctx = canvas.getContext('2d')
      if (!ctx) { bitmap.close(); return null }
      ctx.drawImage(bitmap, 0, 0, 32, 32)
      bitmap.close()
      const out = await canvas.convertToBlob({ type: 'image/png' })
      const outBuf = await out.arrayBuffer()
      if (outBuf.byteLength === 0 || outBuf.byteLength > 100 * 1024) return null
      return `data:image/png;base64,${arrayBufferToBase64(outBuf)}`
    } catch {
      return null
    }
  }

  const MAX_ICON_BYTES = 100 * 1024

  async function imageResultToBase64(img: { buf: ArrayBuffer; mime: string }): Promise<string | null> {
    if (img.buf.byteLength <= MAX_ICON_BYTES) {
      // 服务器仅接受 data:image/；octet-stream 等按 ico 处理
      const outMime = img.mime.startsWith('image/') ? img.mime : 'image/x-icon'
      return `data:${outMime};base64,${arrayBufferToBase64(img.buf)}`
    }
    return resizeToPng32(img.buf, img.mime)
  }

  // Chrome 内置 _favicon 服务：读浏览器图标缓存，不走网络
  async function fetchChromeFavicon(pageUrl: string): Promise<string | null> {
    try {
      const u = new URL(chrome.runtime.getURL('/_favicon/'))
      u.searchParams.set('pageUrl', pageUrl)
      u.searchParams.set('size', '32')
      const resp = await fetch(u.toString())
      if (!resp.ok) return null
      const buf = await resp.arrayBuffer()
      if (buf.byteLength === 0 || buf.byteLength > 100 * 1024) return null
      return `data:image/png;base64,${arrayBufferToBase64(buf)}`
    } catch {
      return null
    }
  }

  // 无图标站点 _favicon 返回固定的默认地球图，缓存其内容用于剔除（.invalid 为保留域名，必无图标）
  let defaultFaviconB64: string | null | undefined
  async function isDefaultFavicon(b64: string): Promise<boolean> {
    if (defaultFaviconB64 === undefined) {
      defaultFaviconB64 = await fetchChromeFavicon('http://definitely-not-a-real-site.invalid/')
    }
    return defaultFaviconB64 != null && b64 === defaultFaviconB64
  }

  // 图标由客户端获取转 base64 上传（客户端与服务器网络环境不同，服务器不主动抓）。
  // 候选顺序：tab.favIconUrl → origin/favicon.ico → Chrome _favicon（剔除默认图，延迟重试一次）
  async function fetchFaviconBase64(pageUrl: string, faviconUrl?: string): Promise<string | null> {
    const candidates: string[] = []
    if (faviconUrl) candidates.push(faviconUrl)
    try {
      const origin = new URL(pageUrl).origin
      if (/^https?:\/\//.test(origin)) candidates.push(`${origin}/favicon.ico`)
    } catch { /* ignore */ }
    for (const url of candidates) {
      if (url.startsWith('data:image/')) {
        if (url.length <= 140_000) return url
        continue
      }
      const img = await fetchImageAsBase64(url)
      if (img) {
        const b64 = await imageResultToBase64(img)
        if (b64) return b64
      }
      console.warn('[anchor] 图标候选不可用:', url)
    }
    const first = await fetchChromeFavicon(pageUrl)
    if (first && !(await isDefaultFavicon(first))) return first
    await new Promise(r => setTimeout(r, 2500))
    const retry = await fetchChromeFavicon(pageUrl)
    if (retry && !(await isDefaultFavicon(retry))) return retry
    console.warn('[anchor] 未能获取站点图标:', pageUrl)
    return null
  }

  async function postClassify(body: Record<string, unknown>): Promise<{ high_stimulus: boolean; source: string; has_icon?: boolean } | null> {
    try {
      const resp = await fetch(`${getServerConfig().serverUrl}/api/sites/classify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!resp.ok) return null
      const data = await resp.json() as { high_stimulus: boolean; source: string; has_icon?: boolean }
      return { high_stimulus: data.high_stimulus, source: data.source, has_icon: data.has_icon }
    } catch {
      return null
    }
  }

  const siteClassifier = createSiteClassifier({
    storageGet: async (key) => {
      const res = await chrome.storage.local.get(key)
      return (res[key] as SiteClassificationsCache | undefined) ?? {}
    },
    storageSet: async (key, value) => {
      await chrome.storage.local.set({ [key]: value })
    },
    classifyRequest: async (domain, siteName, url, faviconUrl) => {
      const favicon = url ? await fetchFaviconBase64(url, faviconUrl) : null
      return postClassify({ domain, site_name: siteName, url, favicon_base64: favicon })
    },
  })

  const badge = createBadgeController({
    setBadgeText: (opts) => chrome.action.setBadgeText(opts),
    setBadgeBackgroundColor: (opts) => chrome.action.setBadgeBackgroundColor(opts),
    setTitle: (opts) => chrome.action.setTitle(opts),
  })

  async function loadRuntimeState(): Promise<void> {
    try {
      const stored = await chrome.storage.session.get(RUNTIME_STATE_KEY)
      if (stored[RUNTIME_STATE_KEY]) {
        Object.assign(state, stored[RUNTIME_STATE_KEY] as RuntimeState)
      }
    } catch { /* storage.session 可能不可用 */ }
  }

  async function saveRuntimeState(): Promise<void> {
    try {
      await chrome.storage.session.set({ [RUNTIME_STATE_KEY]: state })
    } catch { /* ignore */ }
  }

  const FLUSH_CHUNK_SIZE = 100

  async function flushQueue(): Promise<void> {
    const events = await getAllQueuedEvents()
    if (events.length === 0) return
    for (let i = 0; i < events.length; i += FLUSH_CHUNK_SIZE) {
      const chunk = events.slice(i, i + FLUSH_CHUNK_SIZE)
      try {
        const body = await encryptEnvelope({
          logs: chunk.map((evt) => ({
            source: evt.source,
            event_type: evt.event_type,
            payload: evt.payload,
            logged_at: evt.logged_at ?? Math.floor((evt.queued_at ?? Date.now()) / 1000),
          })),
        }, getServerConfig().dataKey)
        const resp = await fetch(`${getServerConfig().serverUrl}/api/ingest/batch`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
        for (const evt of chunk) {
          if (evt.id != null) await removeQueuedEvent(evt.id)
        }
      } catch {
        break
      }
    }
  }

  let wsClient: ReturnType<typeof createWsClient> | null = null

  function connectWs() {
    const cfg = getServerConfig()
    wsClient?.close()
    wsClient = createWsClient(wsUrlFor(cfg.serverUrl), {
      onOpen: () => {
        chrome.storage.local.set({ 'anchor:connected': true }).catch(() => {})
        badge.update({ connected: true }).catch(() => {})
        siteClassifier.seedFromServer(cfg.serverUrl).catch(() => {})
        flushQueue().catch(() => {})
      },
      onClose: () => {
        chrome.storage.local.set({ 'anchor:connected': false }).catch(() => {})
        badge.update({ connected: false }).catch(() => {})
      },
      onMessage: (msg) => handleServerMessage(msg),
    })
    wsClient.connect()
  }

  // 选项页保存服务器地址/数据密钥 → 立即按新配置重连，无需重载扩展
  onServerConfigChange(() => connectWs())

  function sendWsClientMessage(message: WsClientMessage) {
    wsClient?.send(message)
  }

  async function sendBehavior(event_type: BehaviorEventType, payload: Record<string, unknown>) {
    const logged_at = Math.floor(Date.now() / 1000)
    // 加密上行：整个 ingest 消息 AES-256-GCM 加密后发送（服务器按 enc 标记解密）
    const envelope = await encryptEnvelope({
      type: 'ingest',
      source: 'chrome',
      event_type,
      payload,
      logged_at,
    } satisfies WsClientMessage, getServerConfig().dataKey)
    const sent = wsClient.send(envelope)
    if (sent) {
      flushQueue().catch(() => {})
      return
    }

    // WS 未连接：入队，重连后由 flushQueue 批量补发
    await enqueueEvent('chrome', event_type, payload, logged_at)
  }

  async function broadcastToTabs(message: Record<string, unknown>): Promise<void> {
    const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] })
    for (const tab of tabs) {
      if (tab.id != null) {
        chrome.tabs.sendMessage(tab.id, message).catch(() => {})
      }
    }
  }

  async function collapseExcessTabs(): Promise<void> {
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true })
    const tabs = await chrome.tabs.query({})

    const toClose: number[] = []
    for (const tab of tabs) {
      if (tab.id == null) continue
      if (tab.id === activeTab?.id) continue
      if (!tab.url) continue

      try {
        const host = new URL(tab.url).hostname
        const isWhitelisted = WHITELIST_HOSTS.some(w => host.includes(w))
        if (!isWhitelisted) toClose.push(tab.id)
      } catch {
        // skip invalid urls
      }
    }

    if (toClose.length > 0) {
      await chrome.tabs.remove(toClose)
    }
  }

  // 对单个 tab 应用宵禁效果：灰屏/摩擦/硬拦截按阶段开关，T15/T0 对高刺激站点硬拦截。
  // 阶段结束（off）时发送 enabled:false，撤掉页面上的旧效果（含 hard block 遮罩）。
  function applyPhaseToTab(tabId: number, phase: string, url?: string): void {
    const grayscale = phase === 'T60' || phase === 'T30' || phase === 'T15' || phase === 'T0'
    const friction = phase === 'T30' || phase === 'T15' || phase === 'T0'
    chrome.tabs.sendMessage(tabId, { type: 'sunset:grayscale', enabled: grayscale }).catch(() => {})
    chrome.tabs.sendMessage(tabId, { type: 'sunset:friction', enabled: friction }).catch(() => {})
    let hardBlocked = false
    if ((phase === 'T15' || phase === 'T0') && url) {
      try {
        const host = new URL(url).hostname
        if (siteClassifier.isHigh(host)) {
          hardBlocked = true
          const message = phase === 'T15' ? '即将就寝' : '宵禁时间'
          chrome.tabs.sendMessage(tabId, { type: 'hard:block', message }).catch(() => {
            // content script 未注入时忽略
          })
        }
      } catch {
        // skip invalid urls
      }
    }
    if (!hardBlocked) {
      chrome.tabs.sendMessage(tabId, { type: 'hard:block', enabled: false }).catch(() => {})
    }
  }

  async function broadcastPhase(phase: string): Promise<void> {
    const tabs = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] })
    for (const tab of tabs) {
      if (tab.id != null) applyPhaseToTab(tab.id, phase, tab.url)
    }
    // 延迟补发：content script 在 document_start 注册监听器需要时间，
    // 首次发送可能因监听器未就绪而丢失
    await new Promise(r => setTimeout(r, 500))
    const tabs2 = await chrome.tabs.query({ url: ['http://*/*', 'https://*/*'] })
    for (const tab of tabs2) {
      if (tab.id != null) applyPhaseToTab(tab.id, phase, tab.url)
    }
  }

  // 页面加载 / SPA 导航时补发当前阶段效果，避免进入时已在宵禁状态却不生效
  async function applyStoredPhaseToTab(tabId: number, url?: string): Promise<void> {
    const phase = await getEffectivePhase()
    applyPhaseToTab(tabId, phase, url)
  }

  // 服务器未下发 expires_at 时的兜底过期（对齐 Android 端语义，单位：Unix 秒）
  function fallbackExpirySec(phase: string, receivedAtSec: number): number {
    if (phase === 'T0') return receivedAtSec + 8 * 60 * 60
    const minutes = phase === 'T60' ? 60 : phase === 'T30' ? 30 : 15
    return receivedAtSec + Math.max(60, minutes * 60)
  }

  // 存储阶段并注册到期 alarm：服务器离线时到期自动解除，不永久卡在宵禁
  async function storeSunsetPhase(phase: string, expiresAtSec?: number): Promise<void> {
    const nowSec = Math.floor(Date.now() / 1000)
    const expires = phase === 'off' ? nowSec : (expiresAtSec ?? fallbackExpirySec(phase, nowSec))
    await chrome.storage.local.set({ [SUNSET_PHASE_KEY]: phase, [SUNSET_EXPIRES_KEY]: expires })
    if (phase === 'off') {
      await chrome.alarms.clear(SUNSET_ALARM)
    } else {
      chrome.alarms.create(SUNSET_ALARM, { when: expires * 1000 })
    }
  }

  // 本地解除宵禁：清存储、撤效果、更新徽标（过期守护与离线破戒共用）
  async function clearSunsetLocal(): Promise<void> {
    await chrome.storage.local.set({ [SUNSET_PHASE_KEY]: 'off', [SUNSET_EXPIRES_KEY]: 0 })
    await chrome.alarms.clear(SUNSET_ALARM)
    badge.update({ phase: 'off' }).catch(() => {})
    broadcastPhase('off').catch(() => {})
  }

  // 读取生效阶段：expires_at 已过则本地解除（断线兜底），否则返回存储阶段
  async function getEffectivePhase(): Promise<string> {
    try {
      const stored = await chrome.storage.local.get([SUNSET_PHASE_KEY, SUNSET_EXPIRES_KEY])
      const phase = (stored[SUNSET_PHASE_KEY] as string | undefined) ?? 'off'
      const expiresAt = (stored[SUNSET_EXPIRES_KEY] as number | undefined) ?? 0
      if (phase !== 'off' && expiresAt > 0 && Date.now() / 1000 > expiresAt) {
        await clearSunsetLocal()
        return 'off'
      }
      return phase
    } catch {
      return 'off'
    }
  }

  const interventionHandler = createInterventionHandler({
    broadcastToTabs,
    collapseExcessTabs,
    wsClient,
  })

  function handleServerMessage(msg: WsServerMessage) {
    switch (msg.type) {
      case 'sunset:phase':
        storeSunsetPhase(msg.phase, msg.expires_at).catch(() => {})
        badge.update({ phase: msg.phase as SunsetPhase }).catch(() => {})
        broadcastPhase(msg.phase).catch(() => {})
        break

      // 连接/重连后下发的阶段快照，含 'off'（服务器不会为 off 推 sunset:phase）
      // 立即把当前阶段应用到所有 tab，进入时已在宵禁状态也能立刻生效
      case 'sunset:stage':
        storeSunsetPhase(msg.stage, msg.expires_at).catch(() => {})
        badge.update({ phase: msg.stage as SunsetPhase }).catch(() => {})
        broadcastPhase(msg.stage).catch(() => {})
        break

      case 'site:classification_updated':
        siteClassifier.applyUpdate(msg.domain, { high_stimulus: msg.high_stimulus, source: msg.source ?? 'ai' })
        break

      case 'site:classification_deleted':
        siteClassifier.applyDelete(msg.domain)
        break

      case 'intervention':
        interventionHandler.handleIntervention(msg)
        break

      case 'state:update':
        chrome.storage.local.set({
          'anchor:state': msg.state,
          'anchor:confidence': msg.confidence,
        }).catch(() => {})
        break

      case 'notify:ai':
        broadcastToTabs({ type: 'anchor:toast', kind: 'ai', message: msg.message, actions: msg.actions }).catch(() => {})
        break

      case 'time:anchor':
        broadcastToTabs({ type: 'anchor:toast', kind: 'time', message: msg.text }).catch(() => {})
        break

      case 'behavior:suggestion':
        broadcastToTabs({ type: 'anchor:toast', kind: 'suggestion', message: msg.suggestion }).catch(() => {})
        break

      case 'ai:response':
        broadcastToTabs({ type: 'anchor:ai_response', response: msg.response }).catch(() => {})
        break

      case 'capsule:play':
        broadcastToTabs({ type: 'anchor:capsule', content: msg.content, trigger: msg.trigger }).catch(() => {})
        break

      case 'wakeup:alarm':
        broadcastToTabs({ type: 'anchor:wakeup' }).catch(() => {})
        break

      case 'sleep:confirm-request':
        broadcastToTabs({ type: 'anchor:sleep_confirm', confirm_until: msg.confirm_until }).catch(() => {})
        break

      case 'sleep:confirm-cancel':
        broadcastToTabs({ type: 'anchor:sleep_confirm_cancel' }).catch(() => {})
        break

      case 'intent:capture':
        broadcastToTabs({ type: 'anchor:intent_capture', prompt_id: msg.prompt_id, timeoutSeconds: msg.timeoutSeconds, prompt: msg.prompt, is_degraded: msg.is_degraded, focuslayer_hint: msg.focuslayer_hint }).catch(() => {})
        break

      case 'intent:dismiss':
        broadcastToTabs({ type: 'anchor:intent_dismiss', prompt_id: msg.prompt_id }).catch(() => {})
        break

      case 'intent:typing':
        broadcastToTabs({ type: 'anchor:intent_typing', prompt_id: msg.prompt_id }).catch(() => {})
        break

      case 'intent:confirm':
        broadcastToTabs({ type: 'anchor:intent_confirm', date: msg.date, content: msg.content }).catch(() => {})
        break

      case 'context_switch:prompt':
        broadcastToTabs({ type: 'anchor:context_switch', prompt_id: msg.prompt_id, timeoutSeconds: msg.timeoutSeconds, placeholder: msg.placeholder }).catch(() => {})
        break

      case 'context_switch:dismiss':
        broadcastToTabs({ type: 'anchor:context_switch_dismiss', prompt_id: msg.prompt_id }).catch(() => {})
        break

      case 'context_switch:typing':
        broadcastToTabs({ type: 'anchor:context_switch_typing', prompt_id: msg.prompt_id }).catch(() => {})
        break

      case 'ping':
        sendWsClientMessage({ type: 'pong' })
        break

      case 'error':
        if (msg.code === 'DECRYPT_FAILED') {
          console.warn('[Anchor] 密钥错误:', msg.message)
          // 存储错误状态
          chrome.storage.local.set({
            'anchor:configError': msg.message,
          }).catch(() => {})
          // 更新 badge
          badge.update({ connected: false, configError: true }).catch(() => {})
          // 广播 banner 到所有标签页
          broadcastToTabs({ type: 'anchor:config_error', message: msg.message }).catch(() => {})
        }
        break

      case 'env:switch':
      default:
        break
    }
  }

  const { reportVisit } = startTabMonitoring({
    state,
    saveRuntimeState,
    sendBehavior,
    isHighStimulusDomain: (domain) => siteClassifier.isHigh(domain),
    ensureClassified: (domain, siteName, url) => siteClassifier.ensureClassified(domain, siteName, url),
  })

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'sunset:breach') {
      const reason = (msg.reason as string | undefined) ?? ''
      // 破戒 = 强制解除宵禁：走 WS release，服务器置 released 并全端广播解除（含灰屏）
      const sent = wsClient.send({ type: 'sunset:release', reason })
      if (sent) {
        sendResponse({ ok: true })
      } else {
        // WS 离线兜底：HTTP 上报留痕，同时本地解除灰屏——不能因服务器离线把用户永久锁住
        clearSunsetLocal().catch(() => {})
        sendBehavior('sunset_breach', { reason, breached_at: Date.now() }).then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }))
      }
      return true
    } else if (msg.type === 'page:ready') {
      // content script 加载完成：补发当前宵禁阶段效果
      const tabId = sender.tab?.id
      if (tabId != null) {
        applyStoredPhaseToTab(tabId, (msg.url as string | undefined) ?? sender.tab?.url)
      }
      sendResponse({ ok: true })
      return false
    } else if (msg.type === 'spa:navigation') {
      const url = msg.url as string
      const title = msg.title as string
      const domain = getDomain(url)
      if (domain) {
        reportVisit(url, domain, title, 0, sender.tab?.favIconUrl)
      }
      // SPA 导航会移除硬拦截覆盖层，需按当前阶段重新应用
      const tabId = sender.tab?.id
      if (tabId != null) {
        applyStoredPhaseToTab(tabId, url)
      }
      sendResponse({ ok: true })
      return false
    } else if (msg.type === 'site:sync') {
      // 弹窗手动同步：全量拉取服务器分类替换本地缓存
      siteClassifier.syncFromServer(getServerConfig().serverUrl)
        .then((result) => sendResponse(result))
        .catch(() => sendResponse({ ok: false, error: '后台同步异常' }))
      return true
    } else if (msg.type === 'behavior:report') {
      const event_type = msg.event_type as BehaviorEventType
      const payload = msg.payload as Record<string, unknown>
      sendBehavior(event_type, payload).then(() => sendResponse({ ok: true })).catch(() => sendResponse({ ok: false }))
      return true
    } else if (msg.type === 'intervention:result') {
      const intervention_id = msg.intervention_id as string
      const action = msg.action as import('@anchor/types').InterventionAction
      const result = msg.result as 'executed' | 'dismissed' | 'expired'
      interventionHandler.removeActiveIntervention(intervention_id)
      interventionHandler.sendInterventionResult(intervention_id, action, result, !!msg.dismissed_by_user, msg.dismissed_after_ms as number | undefined)
      sendResponse({ ok: true })
      return false
    } else if (msg.type === 'action:response') {
      sendWsClientMessage({
        type: 'action:response',
        action_id: msg.action_id as string,
        choice: msg.choice as string,
      })
      sendResponse({ ok: true })
      return false
    } else if (msg.type === 'intent:submit') {
      sendWsClientMessage({
        type: 'intent:submit',
        content: msg.content as string,
        source: (msg.source as 'bedtime' | 'wakeup' | 'focuslayer' | 'system') ?? 'bedtime',
        date: msg.date as string | undefined,
        prompt_id: msg.prompt_id as string | undefined,
      })
      sendResponse({ ok: true })
      return false
    } else if (msg.type === 'intent:capture-response') {
      sendWsClientMessage({
        type: 'intent:capture-response',
        prompt_id: msg.prompt_id as string,
        action: msg.action as 'skip' | 'auto_skip',
      })
      sendResponse({ ok: true })
      return false
    } else if (msg.type === 'intent:confirm') {
      sendWsClientMessage({
        type: 'intent:confirm',
        date: msg.date as string,
      })
      sendResponse({ ok: true })
      return false
    } else if (msg.type === 'wakeup:verified') {
      // 起床验证：转发到服务器，由服务器解除全端宵禁
      sendWsClientMessage({ type: 'wakeup:verified' })
      sendResponse({ ok: true })
      return false
    } else if (msg.type === 'sleep:confirm-response') {
      // 入睡确认框「还没睡」响应
      sendWsClientMessage({ type: 'sleep:confirm-response', confirmed: false })
      sendResponse({ ok: true })
      return false
    } else if (msg.type === 'context_switch:response') {
      // 状态切换弹窗响应：转发服务器，先到先赢，服务器广播 dismiss 关闭全端弹窗
      sendWsClientMessage({
        type: 'context_switch:response',
        prompt_id: msg.prompt_id as string,
        action: msg.action as 'submit' | 'skip' | 'auto_skip',
        text: msg.text as string | undefined,
        source: 'chrome',
      })
      sendResponse({ ok: true })
      return false
    } else if (msg.type === 'intent:input' || msg.type === 'context_switch:input') {
      // 弹窗开始输入（接管）：转发服务器，服务器广播 typing 关闭其他端
      sendWsClientMessage({
        type: msg.type,
        prompt_id: msg.prompt_id as string,
      })
      sendResponse({ ok: true })
      return false
    } else if (msg.type === 'friction:usage-context-request') {
      fetch(`${getServerConfig().serverUrl}/api/friction/usage-context`)
        .then(async (res) => {
          if (!res.ok) return sendResponse({ ok: false })
          const data = await res.json()
          sendResponse({ ok: true, data })
        })
        .catch(() => sendResponse({ ok: false }))
      return true
    }
    sendResponse()
    return false
  })

  // 宵禁到期 alarm：服务器离线时的自动解除兜底
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === SUNSET_ALARM) {
      getEffectivePhase().catch(() => {})
    }
  })

  async function init() {
    await loadServerConfig()
    await loadRuntimeState()
    await siteClassifier.loadCache()
    const phase = await getEffectivePhase()
    await badge.update({ phase: phase as SunsetPhase })
    if (phase !== 'off') {
      // SW/浏览器重启后重建到期 alarm（chrome.alarms 持久，但存储被清时对齐状态）
      const stored = await chrome.storage.local.get(SUNSET_EXPIRES_KEY)
      const expiresAt = (stored[SUNSET_EXPIRES_KEY] as number | undefined) ?? 0
      if (expiresAt > 0) chrome.alarms.create(SUNSET_ALARM, { when: expiresAt * 1000 })
    }
    connectWs()
  }

  chrome.runtime.onInstalled.addListener(() => { init() })
  chrome.runtime.onStartup.addListener(() => { init() })
  init()
})
