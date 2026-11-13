import { STATE_LABELS, STATE_COLOR_TOKENS } from '@anchor/utils'
import type { UserState } from '@anchor/types'

interface StorageState {
  'sunset:phase'?: string
  'sunset:expires_at'?: number
  'anchor:connected'?: boolean
  'anchor:state'?: string
  'anchor:configError'?: string
}

const PHASE_LABELS: Record<string, string> = {
  T60: 'T-60 分钟',
  T30: 'T-30 分钟',
  T15: 'T-15 分钟',
  T0: '已进入宵禁',
  off: '未激活',
}

const KEYS = ['sunset:phase', 'sunset:expires_at', 'anchor:connected', 'anchor:state', 'anchor:configError'] as const

// 状态 → CSS 变量（token 映射单一来源 packages/utils/src/state.ts，色值见 index.html）
function stateColorVar(state: string | undefined): string {
  if (!state) return 'var(--text-disabled)'
  const token = STATE_COLOR_TOKENS[state as UserState]
  return token ? `var(--${token})` : 'var(--text-disabled)'
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)
}

function row(label: string, value: string, color: string): string {
  return `<div class="row"><span class="label">${esc(label)}</span><span class="value" style="color:${color}">${esc(value)}</span></div>`
}

function render(state: StorageState) {
  const root = document.getElementById('root')
  if (!root) return

  const connected = state['anchor:connected'] ?? false
  const rawPhase = state['sunset:phase']
  const expiresAt = state['sunset:expires_at'] ?? 0
  // 与后台一致的过期兜底：expires_at 已过视为已解除，不展示过期宵禁
  const phase = rawPhase && rawPhase !== 'off' && expiresAt > 0 && Date.now() / 1000 > expiresAt
    ? 'off'
    : rawPhase
  const userState = state['anchor:state']
  const configError = state['anchor:configError']

  const stateLabel = (userState && STATE_LABELS[userState as UserState]) || '等待服务器推断'
  const stateColor = stateColorVar(userState)
  const phaseLabel = (phase && PHASE_LABELS[phase]) || '未激活'
  const phaseColor = phase === 'T0' ? 'var(--curfew)' : 'var(--text-primary)'

  // 配置错误状态：显示红色错误提示
  if (configError) {
    root.innerHTML = `<div class="card">${
      row('配置错误', configError, 'var(--curfew)') +
      row('连接状态', '未连接', 'var(--text-disabled)')
    }</div>`
    return
  }

  root.innerHTML = `<div class="card">${
    row('连接状态', connected ? '已连接' : '未连接', connected ? 'var(--passive)' : 'var(--text-disabled)') +
    row('宵禁阶段', phaseLabel, phaseColor) +
    row('推断状态', stateLabel, stateColor)
  }</div>`
}

// 同步按钮在 #root 之外，状态不受 storage 变化重渲染影响
let syncing = false
let syncTimer: ReturnType<typeof setTimeout> | undefined

function setupSyncButton() {
  const btn = document.getElementById('sync-btn')
  const status = document.getElementById('sync-status')
  if (!btn || !status) return
  btn.addEventListener('click', () => {
    if (syncing) return
    syncing = true
    btn.classList.add('spinning')
    status.textContent = ''
    chrome.runtime.sendMessage({ type: 'site:sync' }, (resp: { ok?: boolean; error?: string } | undefined) => {
      syncing = false
      btn.classList.remove('spinning')
      if (chrome.runtime.lastError || !resp) {
        status.textContent = '同步失败：后台无响应，请在 chrome://extensions 重载扩展'
      } else {
        status.textContent = resp.ok ? '同步完成' : `同步失败：${resp.error ?? '未知错误'}`
      }
      clearTimeout(syncTimer)
      syncTimer = setTimeout(() => { status.textContent = '' }, 4000)
    })
  })
}

setupSyncButton()

// 设置按钮：打开扩展选项页（服务器地址/数据密钥）
document.getElementById('settings-btn')?.addEventListener('click', () => {
  chrome.runtime.openOptionsPage()
})

function load() {
  chrome.storage.local.get([...KEYS], (result) => {
    render(result as StorageState)
  })
}

load()

// 弹窗打开期间如有存储变化则刷新
chrome.storage.onChanged.addListener((_changes, area) => {
  if (area !== 'local') return
  load()
})
