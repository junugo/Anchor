// scrypt 密码哈希：自描述存储串格式 scrypt$N$r$p$salt_hex$hash_hex，
// 与具体实现库无关、可读、可校验；auth_credentials.scrypt_params 单独存 JSON。
import { randomBytes, scrypt as scryptAsync, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

const scrypt = promisify(scryptAsync) as (
  password: string, salt: Buffer, keylen: number, options: { N: number; r: number; p: number },
) => Promise<Buffer>

export const SCRYPT_N = 16384
export const SCRYPT_R = 8
export const SCRYPT_P = 1
const KEYLEN = 64
const SALT_LEN = 16

export interface PasswordHashResult {
  /** 自描述存储串：scrypt$N$r$p$salt_hex$hash_hex */
  hash: string
  /** JSON 字符串，如 {"n":16384,"r":8,"p":1}（供 auth_credentials.scrypt_params 列使用） */
  params: string
}

export async function hashPassword(password: string): Promise<PasswordHashResult> {
  const salt = randomBytes(SALT_LEN)
  const derived = await scrypt(password, salt, KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P })
  return {
    hash: `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString('hex')}$${derived.toString('hex')}`,
    params: JSON.stringify({ n: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P }),
  }
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  try {
    const parts = stored.split('$')
    if (parts.length !== 6 || parts[0] !== 'scrypt') return false
    const n = Number(parts[1]); const r = Number(parts[2]); const p = Number(parts[3])
    const salt = Buffer.from(parts[4], 'hex')
    const expected = Buffer.from(parts[5], 'hex')
    if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false
    // 防御性上限：DB 被篡改时避免登录路径被巨量 scrypt 计算 DoS
    if (n <= 1 || n > 2 ** 20 || (n & (n - 1)) !== 0) return false // scrypt 要求 N 为 2 的幂
    if (r < 1 || r > 64) return false
    if (p < 1 || p > 16) return false
    if (expected.length < 16 || expected.length > 128) return false
    if (salt.length === 0 || expected.length === 0) return false
    const derived = await scrypt(password, salt, expected.length, { N: n, r, p })
    return timingSafeEqual(derived, expected)
  } catch {
    return false // 格式非法 / 参数越界一律 false，不抛
  }
}
