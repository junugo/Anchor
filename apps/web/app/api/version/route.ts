// GET /api/version — 服务器版本（公开，客户端更新检查用）
import { NextResponse } from 'next/server'
import { SERVER_VERSION } from '@/lib/server-version'

export function GET() {
  return NextResponse.json({ version: SERVER_VERSION })
}
