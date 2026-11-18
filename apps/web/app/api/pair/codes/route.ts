// POST /api/pair/codes — 生成 8 位 Crockford Base32 配对码（需登录，设置页调用）
// 明文码只在响应中出现一次，库存 sha256；有效期 300s；同机允许同时存在多张未消费码（YAGNI，各自独立过期）
import { randomInt, createHash } from 'node:crypto'
import { NextRequest, NextResponse } from 'next/server'
import { pairCodes } from '@anchor/db'
import { getDb } from '@/lib/db'
import { requireSession } from '@/lib/auth/request'

// Crockford Base32：大写字母数字，排除 I/L/O/U 去歧义
const CROCKFORD_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
const CODE_LENGTH = 8
const CODE_TTL_SECONDS = 300

function generatePairCode(): string {
  let code = ''
  for (let i = 0; i < CODE_LENGTH; i++) {
    code += CROCKFORD_ALPHABET[randomInt(CROCKFORD_ALPHABET.length)]
  }
  return code
}

export async function POST(req: NextRequest) {
  if (!requireSession(req)) {
    return NextResponse.json({ error: '未登录' }, { status: 401 })
  }

  const code = generatePairCode()
  const codeHash = createHash('sha256').update(code).digest('hex')
  const now = Math.floor(Date.now() / 1000)
  const expiresAt = now + CODE_TTL_SECONDS

  getDb().insert(pairCodes).values({
    code_hash: codeHash,
    expires_at: expiresAt,
    attempts: 0,
    consumed_at: null,
    created_at: now,
  }).run()

  return NextResponse.json({ code, expiresAt })
}
