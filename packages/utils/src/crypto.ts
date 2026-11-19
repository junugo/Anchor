/**
 * 上行行为数据加密（客户端 → 服务器）。
 *
 * 仅加密行为数据上传通道（WS ingest / REST /api/ingest/batch），控制消息保持明文。
 * 算法：AES-256-GCM，密钥 = SHA-256(passphrase)。
 * 线格式：base64(iv(12B) ‖ ciphertext ‖ tag(16B))，密文长度 = 明文 + 28B。
 * 服务器必须通过环境变量 ANCHOR_DATA_KEY 配置密钥，未配置时显式抛错（见 resolveDataKey）。
 */

export type DataKeyEnv = { ANCHOR_DATA_KEY?: string | undefined }

// 入参放宽到任意字符串索引环境对象（process.env 可直接传入；
// DataKeyEnv 全可选属性属弱类型，直接传 ProcessEnv 触发 TS2559）
export function resolveDataKey(env?: DataKeyEnv | Record<string, string | undefined>): string {
  const key = env?.ANCHOR_DATA_KEY?.trim()
  if (!key || key.length === 0) {
    throw new Error('ANCHOR_DATA_KEY 未配置：请通过环境变量设置数据密钥（生产部署必填）')
  }
  return key
}

/** 生成新的数据密钥：32 字节随机数，hex 编码（64 字符），可直接作为 ANCHOR_DATA_KEY 或客户端数据密钥 */
export function generateDataKey(): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32))
  let hex = ''
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0')
  return hex
}

/** 数据密钥指纹：用于诊断密钥是否一致，不暴露真实密钥 */
export async function dataKeyFingerprint(passphrase: string): Promise<string> {
  const c = globalThis.crypto
  const digest = await c.subtle.digest('SHA-256', new TextEncoder().encode(passphrase))
  return bytesToBase64(new Uint8Array(digest)).slice(0, 8)
}

export interface EncryptedEnvelope {
  enc: true
  v: 1
  data: string
}

function getCrypto(): Crypto {
  return globalThis.crypto
}

async function deriveAesKey(passphrase: string): Promise<CryptoKey> {
  const c = getCrypto()
  const digest = await c.subtle.digest('SHA-256', new TextEncoder().encode(passphrase))
  return c.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
}

/** 加密任意 JSON 值，返回 base64(iv ‖ ct ‖ tag) */
export async function encryptJson(data: unknown, passphrase: string): Promise<string> {
  const c = getCrypto()
  const key = await deriveAesKey(passphrase)
  const iv = c.getRandomValues(new Uint8Array(12))
  const ct = await c.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(JSON.stringify(data)),
  )
  const out = new Uint8Array(iv.length + ct.byteLength)
  out.set(iv, 0)
  out.set(new Uint8Array(ct), iv.length)
  return bytesToBase64(out)
}

/** 解密 encryptJson 产物，返回原始明文字符串；密钥错误 / 格式损坏返回 null */
export async function decryptRaw(payload: string, passphrase: string): Promise<string | null> {
  try {
    const raw = base64ToBytes(payload)
    if (raw.length <= 28) return null
    const c = getCrypto()
    const key = await deriveAesKey(passphrase)
    const pt = await c.subtle.decrypt(
      { name: 'AES-GCM', iv: raw.slice(0, 12) },
      key,
      raw.slice(12),
    )
    return new TextDecoder().decode(pt)
  } catch {
    return null
  }
}

/** 解密并 JSON.parse；密钥错误 / 格式损坏返回 null */
export async function decryptJson<T>(payload: string, passphrase: string): Promise<T | null> {
  const raw = await decryptRaw(payload, passphrase)
  if (raw === null) return null
  try {
    return JSON.parse(raw) as T
  } catch {
    return null
  }
}

/** 生成标准加密信封：{ enc: true, v: 1, data } */
export async function encryptEnvelope(data: unknown, passphrase: string): Promise<EncryptedEnvelope> {
  return { enc: true, v: 1, data: await encryptJson(data, passphrase) }
}

/**
 * 服务器统一解包：明文 body（旧客户端兼容）原样序列化返回；
 * 加密信封解密后返回明文 JSON 字符串；解密失败返回 null（调用方丢弃并告警）。
 */
export async function unwrapBody(body: unknown, passphrase: string): Promise<string | null> {
  if (body !== null && typeof body === 'object' && !Array.isArray(body) && (body as EncryptedEnvelope).enc === true) {
    const data = (body as EncryptedEnvelope).data
    if (typeof data !== 'string') return null
    return decryptRaw(data, passphrase)
  }
  return JSON.stringify(body)
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}
