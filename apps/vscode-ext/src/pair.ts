/**
 * 配对流程：用户在 dashboard 设置页生成一次性配对码，扩展凭码换取
 * 设备 token 与上行数据密钥（POST /api/pair）。
 *
 * 纯函数设计：只负责请求与结果规整，凭据写入由调用方（extension.ts）
 * 经 secrets 模块完成，保持本模块可无 VS Code 环境单测。
 * 失败时透出服务器 {error} 文案（401 配对码无效 / 429 限频 / 400 参数错）。
 */

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

/** 规范化配对码：去空白 + 大写 */
export function normalizePairCode(code: string): string {
  return code.trim().toUpperCase()
}

/**
 * 发起配对请求。
 * @param clientVersion 扩展版本号（package.json version），由调用方取后传入，保持本函数可测
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
    data = (await resp.json()) as { token?: string; dataKey?: string; serverVersion?: string; deviceId?: number }
  } catch {
    return { ok: false, error: '服务器响应异常，请稍后重试' }
  }
  if (!data.token || !data.dataKey) {
    return { ok: false, error: '服务器响应缺少凭证，请稍后重试' }
  }

  return {
    ok: true,
    token: data.token,
    dataKey: data.dataKey,
    serverVersion: data.serverVersion ?? '',
    deviceId: data.deviceId ?? 0,
  }
}
