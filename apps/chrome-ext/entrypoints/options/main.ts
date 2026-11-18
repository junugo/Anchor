import { dataKeyFingerprint } from '@anchor/utils'
import { loadServerConfig, saveServerConfig } from '../../src/config'

const serverUrlInput = document.getElementById('server-url') as HTMLInputElement
const dataKeyInput = document.getElementById('data-key') as HTMLInputElement
const saveBtn = document.getElementById('save') as HTMLButtonElement
const savedEl = document.getElementById('saved') as HTMLSpanElement
const fingerprintEl = document.getElementById('fingerprint') as HTMLSpanElement

const STORAGE_KEYS = { serverUrl: 'anchor:serverUrl', dataKey: 'anchor:dataKey' } as const

let savedTimer: ReturnType<typeof setTimeout> | undefined

async function render(): Promise<void> {
  // 输入框回填用户已保存的值；留空表示未配置数据密钥
  const stored = await chrome.storage.local.get([STORAGE_KEYS.serverUrl, STORAGE_KEYS.dataKey])
  serverUrlInput.value = (stored[STORAGE_KEYS.serverUrl] as string | undefined) ?? ''
  dataKeyInput.value = (stored[STORAGE_KEYS.dataKey] as string | undefined) ?? ''
  const cfg = await loadServerConfig()
  fingerprintEl.textContent = cfg.dataKey ? await dataKeyFingerprint(cfg.dataKey) : '未配置数据密钥'
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

saveBtn.addEventListener('click', () => { save().catch(() => {}) })

render().catch(() => {})
