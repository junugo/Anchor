// 设备 token 校验：客户端 WS 接入时出示的明文 token，库中只存 sha256 哈希。
// 任务 7 的 /api/pair 负责签发 devices 行；本模块即刻可用（表为空时全部失败属预期）。
import { createHash } from 'node:crypto'
import { and, eq, isNull } from 'drizzle-orm'
import { devices, type Db } from '@anchor/db'

function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

export interface VerifiedDevice {
  deviceId: number
  name: string
}

/** 校验设备 token：命中未撤销的 devices 行即返回设备信息，否则 null */
export function verifyDeviceToken(db: Db, token: string): VerifiedDevice | null {
  const row = db
    .select({ id: devices.id, name: devices.name })
    .from(devices)
    .where(and(eq(devices.token_hash, hashToken(token)), isNull(devices.revoked_at)))
    .get()
  if (!row) return null
  return { deviceId: row.id, name: row.name }
}
