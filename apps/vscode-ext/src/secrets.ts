/**
 * 凭据存储：设备 token 与上行数据密钥迁入 VS Code SecretStorage（
 * context.secrets），不再出现在 contributes.configuration 中。
 *
 * 薄封装：传入 SecretStorage 实现，便于 vitest 用 mock 往返测试。
 * 键名与 chrome-ext / desktop-rs 的存储键保持同一命名风格。
 */

export interface PairedCredentials {
  token: string
  dataKey: string
  deviceName: string
  pairedAt: number
}

/** SecretStorage 最小形状（与 vscode.SecretStorage 兼容，便于 mock） */
export interface SecretStorageLike {
  get(key: string): Thenable<string | undefined>
  store(key: string, value: string): Thenable<void>
  delete(key: string): Thenable<void>
}

const KEYS = {
  token: 'anchor.token',
  dataKey: 'anchor.dataKey',
  deviceName: 'anchor.deviceName',
  pairedAt: 'anchor.pairedAt',
} as const

export function createSecretsApi(secrets: SecretStorageLike) {
  return {
    async getToken(): Promise<string | null> {
      return (await secrets.get(KEYS.token)) ?? null
    },

    async getDataKey(): Promise<string | null> {
      return (await secrets.get(KEYS.dataKey)) ?? null
    },

    async getDeviceName(): Promise<string | null> {
      return (await secrets.get(KEYS.deviceName)) ?? null
    },

    /** 写入配对成功的完整凭据（覆盖旧值） */
    async setPaired(cred: PairedCredentials): Promise<void> {
      await secrets.store(KEYS.token, cred.token)
      await secrets.store(KEYS.dataKey, cred.dataKey)
      await secrets.store(KEYS.deviceName, cred.deviceName)
      await secrets.store(KEYS.pairedAt, String(cred.pairedAt))
    },

    /** 清除全部配对凭据（解除配对/重新配对前调用） */
    async clear(): Promise<void> {
      await secrets.delete(KEYS.token)
      await secrets.delete(KEYS.dataKey)
      await secrets.delete(KEYS.deviceName)
      await secrets.delete(KEYS.pairedAt)
    },
  }
}

export type SecretsApi = ReturnType<typeof createSecretsApi>

/** 启动判定：有 token 才允许建立 WS 连接并上报 */
export function shouldConnect(token: string | null | undefined): boolean {
  return !!token
}
