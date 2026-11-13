import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { classifyProcess } from '@/lib/processes/classify'

// POST - 请求 AI 分类 Windows 进程（镜像 sites/apps 分类机制）
// icon_base64 可选：desktop-rs 首次见到进程时上传的 32px PNG（纯 base64，无 data: 前缀）
export async function POST(req: Request) {
  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'invalid JSON body' }, { status: 400 })
  }

  const { process_name, display_name, icon_base64 } = body as {
    process_name?: string
    display_name?: string
    icon_base64?: string
  }

  if (!process_name) {
    return NextResponse.json({ error: 'process_name required' }, { status: 400 })
  }

  const icon = typeof icon_base64 === 'string'
    && icon_base64.length > 0
    && icon_base64.length <= 140 * 1024
    && /^[A-Za-z0-9+/=]+$/.test(icon_base64)
    ? icon_base64
    : undefined

  const db = getDb()
  const result = await classifyProcess(db, String(process_name), display_name ? String(display_name) : undefined, icon)

  if (!result) {
    return NextResponse.json({ error: 'process ignored' }, { status: 400 })
  }
  return NextResponse.json(result)
}
