// POST /api/pair — 设备配对兑换（公开，限频 pair:${ip} 10 次/分，超限 429）
// body: { code, deviceName, clientVersion? }
// 安全语义：码不存在 / 过期 / 尝试耗尽 / 已消费 → 统一 401「配对码无效或已过期」，不区分原因
// 成功：标记消费 + 创建 devices 行（token 只存 sha256）→ { token, dataKey, serverVersion, deviceId }
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { isNull, desc, eq } from 'drizzle-orm'
import { pairCodes, devices } from '@anchor/db'
import { getDb } from '@/lib/db'
import { getDataKey } from '@/lib/data-key'
import { SERVER_VERSION } from '@/lib/server-version'
import { createRateLimiter } from '@/lib/auth/rate-limit'
import { getClientIp } from '@/lib/auth/request'

const limiter = createRateLimiter()
const PAIR_LIMIT = 10
const PAIR_WINDOW_MS = 60 * 1000
const MAX_ATTEMPTS = 5
const DEVICE_NAME_MAX = 64

/** 统一失败文案：不区分不存在 / 过期 / 已用完尝试 / 已消费，防枚举 */
const INVALID_CODE_ERROR = '配对码无效或已过期'

function hashCode(code: string): string {
  return createHash('sha256').update(code).digest('hex')
}

/** 恒定时间比较两个 sha256 hex（等长 64B，天然满足 timingSafeEqual 前置条件） */
function hashEquals(a: string, b: string): boolean {
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'))
}

export async function POST(req: NextRequest) {
  const ip = getClientIp(req)
  if (!limiter.limit(`pair:${ip}`, PAIR_LIMIT, PAIR_WINDOW_MS)) {
    return NextResponse.json({ error: '请求过于频繁，请稍后再试' }, { status: 429 })
  }

  let body: { code?: unknown; deviceName?: unknown; clientVersion?: unknown } | null
  try {
    body = await req.json()
  } catch {
    body = null
  }

  // code 规范化：trim + 大写
  const rawCode = body?.code
  const code = typeof rawCode === 'string' ? rawCode.trim().toUpperCase() : ''
  // deviceName：trim 后 1~64 字符
  const rawName = body?.deviceName
  const deviceName = typeof rawName === 'string' ? rawName.trim() : ''
  const clientVersion = typeof body?.clientVersion === 'string' ? body.clientVersion : null

  if (!code || deviceName.length === 0 || deviceName.length > DEVICE_NAME_MAX) {
    return NextResponse.json({ error: '参数非法' }, { status: 400 })
  }

  const db = getDb()
  const computedHash = hashCode(code)

  // 候选：全部未消费码（最新在前）。逐个 timingSafeEqual 找匹配行；
  // 匹配不上也计入最新码的 attempts——错误配对码同样消耗尝试次数，防爆破
  const candidates = db.select().from(pairCodes)
    .where(isNull(pairCodes.consumed_at))
    .orderBy(desc(pairCodes.created_at))
    .all()

  const invalid = () => NextResponse.json({ error: INVALID_CODE_ERROR }, { status: 401 })

  if (candidates.length === 0) return invalid()

  const now = Math.floor(Date.now() / 1000)
  const match = candidates.find((c) => hashEquals(c.code_hash, computedHash))

  if (!match) {
    // 错一次 attempts+1（并发下多几次无妨，单用户场景）；耗尽即作废最新码
    const latest = candidates[0]
    const attempts = latest.attempts + 1
    if (attempts >= MAX_ATTEMPTS) {
      db.update(pairCodes).set({ consumed_at: now }).where(eq(pairCodes.id, latest.id)).run()
    } else {
      db.update(pairCodes).set({ attempts }).where(eq(pairCodes.id, latest.id)).run()
    }
    return invalid()
  }

  // 尝试耗尽：作废该码 + 统一错误
  if (match.attempts >= MAX_ATTEMPTS) {
    db.update(pairCodes).set({ consumed_at: now }).where(eq(pairCodes.id, match.id)).run()
    return invalid()
  }

  // 过期：统一错误
  if (match.expires_at < now) return invalid()

  // 全部通过：标记消费 → 创建设备行
  db.update(pairCodes).set({ consumed_at: now }).where(eq(pairCodes.id, match.id)).run()

  const token = randomBytes(32).toString('base64url')
  const inserted = db.insert(devices).values({
    name: deviceName,
    token_hash: hashCode(token), // token 明文仅返回一次，库中只存 sha256
    client_version: clientVersion,
    created_at: now,
    last_seen_at: now,
    revoked_at: null,
  }).run()

  return NextResponse.json({
    token,
    dataKey: getDataKey(),
    serverVersion: SERVER_VERSION,
    deviceId: Number(inserted.lastInsertRowid),
  })
}
