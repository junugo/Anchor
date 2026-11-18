import { dataKeyFingerprint } from '@anchor/utils'
import { defaultDeviceName, isPaired, loadServerConfig, saveServerConfig } from '../../src/config'
import { requestPairing } from '../../src/pair'

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T

const pageTitle = el('page-title')
const pageSubtitle = el('page-subtitle')
const pairedBar = el('paired-bar')
const pairedText = el('paired-text')
const pairCard = el('pair-card')
const pairServerUrlInput = el<HTMLInputElement>('pair-server-url')
const pairCodeInput = el<HTMLInputElement>('pair-code')
const pairDeviceNameInput = el<HTMLInputElement>('pair-device-name')
const pairBtn = el<HTMLButtonElement>('pair-btn')
const pairStatus = el('pair-status')
const settingsCard = el('settings-card')
const serverUrlInput = el<HTMLInputElement>('server-url')
const dataKeyInput = el<HTMLInputElement>('data-key')
const saveBtn = el<HTMLButtonElement>('save')
const savedEl = el('saved')
const fingerprintEl = el('fingerprint')
const rePairBtn = el<HTMLButtonElement>('re-pair')

let savedTimer: ReturnType<typeof setTimeout> | undefined

/** 配对结果反馈文案（纯 DOM 分支，逻辑已下沉到 pair.ts 便于测试） */
function setPairStatus(text: string, kind: 'ok' | 'err' | ''): void {
  pairStatus.textContent = text
  pairStatus.className = kind
}

async function render(): Promise<void> {
  const cfg = await loadServerConfig()
  const paired = isPaired(cfg)

  // 服务器地址预填：已保存值 > 默认
  pairServerUrlInput.value = (await chrome.storage.local.get('anchor:serverUrl'))['anchor:serverUrl']
    ?? cfg.serverUrl
    ?? 'http://localhost:4000'
  pairDeviceNameInput.value = defaultDeviceName()

  if (paired) {
    pageTitle.textContent = 'Anchor 设置'
    pageSubtitle.textContent = '服务器地址与上行数据密钥，保存后立即生效（自动重连，无需重载扩展）'
    pairedText.textContent = `已配对 · ${cfg.deviceName ?? '本设备'} · ${cfg.serverUrl}`
    pairedBar.hidden = false
    settingsCard.hidden = false
    pairCard.hidden = true // 「重新配对」展开
    serverUrlInput.value = (await chrome.storage.local.get('anchor:serverUrl'))['anchor:serverUrl'] ?? ''
    dataKeyInput.value = (await chrome.storage.local.get('anchor:dataKey'))['anchor:dataKey'] ?? ''
    fingerprintEl.textContent = cfg.dataKey ? await dataKeyFingerprint(cfg.dataKey) : '未配置数据密钥'
  } else {
    pageTitle.textContent = '配对你的浏览器'
    pageSubtitle.textContent = '在 Anchor 服务器管理界面获取配对码，完成配对后自动连接'
    pairedBar.hidden = true
    settingsCard.hidden = true
    pairCard.hidden = false
  }
}

async function pair(): Promise<void> {
  const serverUrl = pairServerUrlInput.value.trim()
  const code = pairCodeInput.value.trim()
  const deviceName = pairDeviceNameInput.value.trim()
  if (!serverUrl) { setPairStatus('请填写服务器地址', 'err'); return }
  if (!code) { setPairStatus('请填写配对码', 'err'); return }

  pairBtn.disabled = true
  setPairStatus('配对中…', '')
  try {
    // manifest 版本号在调用处取，保持 requestPairing 纯 fetch 可测
    const clientVersion = chrome.runtime.getManifest().version
    const result = await requestPairing(serverUrl, code, deviceName, clientVersion)
    if (result.ok) {
      setPairStatus(`配对成功 · 服务器版本 ${result.serverVersion || '未知'}`, 'ok')
      await render()
    } else {
      setPairStatus(result.error, 'err')
    }
  } catch {
    setPairStatus('配对异常，请稍后重试', 'err')
  } finally {
    pairBtn.disabled = false
  }
}

async function save(): Promise<void> {
  saveBtn.disabled = true
  try {
    // 留空字段写空串：加载层视为未配置（dataKey 归 null），等效于「清除配置」
    await saveServerConfig({
      serverUrl: serverUrlInput.value.trim(),
      dataKey: dataKeyInput.value.trim(),
    })
    const cfg = await loadServerConfig()
    fingerprintEl.textContent = cfg.dataKey ? await dataKeyFingerprint(cfg.dataKey) : '未配置数据密钥'
    savedEl.style.visibility = 'visible'
    clearTimeout(savedTimer)
    savedTimer = setTimeout(() => { savedEl.style.visibility = 'hidden' }, 2000)
  } finally {
    saveBtn.disabled = false
  }
}

pairBtn.addEventListener('click', () => { pair().catch(() => {}) })
saveBtn.addEventListener('click', () => { save().catch(() => {}) })
rePairBtn.addEventListener('click', () => {
  // 展开配对表单（覆盖现有 token）；配对成功会写入新 token 并触发 background 重连
  pairCard.hidden = false
  pairCodeInput.value = ''
  pairCodeInput.focus()
})

render().catch(() => {})
