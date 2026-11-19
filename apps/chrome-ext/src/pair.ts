/**
 * 配对流程：用户在服务器管理界面获取一次性配对码，浏览器扩展凭码换取
 * 设备 token 与上行数据密钥（POST /api/pair）。
 *
 * 成功后写入 chrome.storage.local（token/dataKey 用下发值覆盖、pairedAt=now），
 * 并清除 pairInvalid 标记；background 通过 onServerConfigChange 感知 token 变化自动重连。
 * 失败时透出服务器 {error} 文案（401 配对码无效 / 429 限频 / 400 参数错）。
 */

import { loadServerConfig, PAIR_INVALID_KEY } from './config'

export interface PairSuccess {
  ok: true
  token: string
  dataKey: string
  serverVersion: string
  deviceId: number
}

export interface PairFailure {
  ok: false
  error: string
}

export type PairResult = PairSuccess | PairFailure

const STORAGE_KEYS = {
  serverUrl: 'anchor:serverUrl',
  dataKey: 'anchor:dataKey',
  token: 'anchor:token',
  deviceName: 'anchor:deviceName',
  pairedAt: 'anchor:pairedAt',
} as const

/** 规范化配对码：去空白 + 大写 */
export function normalizePairCode(code: string): string {
  return code.trim().toUpperCase()
}

/**
 * 发起配对请求；成功则写 storage 并返回下发的凭证。
 * @param clientVersion 扩展版本号（manifest version），由调用方取后传入，保持本函数可测
 */
export async function requestPairing(
  serverUrl: string,
  code: string,
  deviceName: string,
  clientVersion: string,
): Promise<PairResult> {
  const base = serverUrl.trim().replace(/\/+$/, '')
  let resp: Response
  try {
    resp = await fetch(`${base}/api/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: normalizePairCode(code),
        deviceName: deviceName.trim(),
        clientVersion,
      }),
    })
  } catch {
    return { ok: false, error: '无法连接服务器，请检查服务器地址' }
  }

  if (!resp.ok) {
    let message = ''
    try {
      const body = await resp.json() as { error?: string }
      message = body.error ?? ''
    } catch { /* ignore */ }
    if (resp.status === 401) return { ok: false, error: message || '配对码无效或已过期' }
    if (resp.status === 429) return { ok: false, error: message || '配对请求过于频繁，请稍后再试' }
    if (resp.status === 400) return { ok: false, error: message || '配对参数错误' }
    return { ok: false, error: message || `配对失败（HTTP ${resp.status}）` }
  }

  let data: { token?: string; dataKey?: string; serverVersion?: string; deviceId?: number }
  try {
    data = await resp.json()
  } catch {
    return { ok: false, error: '服务器响应异常，请稍后重试' }
  }
  if (!data.token || !data.dataKey) {
    return { ok: false, error: '服务器响应缺少凭证，请稍后重试' }
  }

  // 写 storage：token/dataKey 用下发值覆盖；清除配对失效标记
  await chrome.storage.local.set({
    [STORAGE_KEYS.serverUrl]: base,
    [STORAGE_KEYS.token]: data.token,
    [STORAGE_KEYS.dataKey]: data.dataKey,
    [STORAGE_KEYS.deviceName]: deviceName.trim(),
    [STORAGE_KEYS.pairedAt]: Date.now(),
    [PAIR_INVALID_KEY]: false,
  })
  // 刷新 config 缓存，使 onServerConfigChange 重连拿到新值
  await loadServerConfig()

  return {
    ok: true,
    token: data.token,
    dataKey: data.dataKey,
    serverVersion: data.serverVersion ?? '',
    deviceId: data.deviceId ?? 0,
  }
}
