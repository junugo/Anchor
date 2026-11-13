/**
 * /api/intentions — 每日意图 CRUD
 *
 * GET  /api/intentions?date=YYYY-MM-DD  查询指定日期意图
 *      date 支持相对值 today/yesterday/tomorrow，省略时取今日（均按用户时区解析）
 * POST /api/intentions                  创建或更新今日意图
 */
import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { dailyIntentions } from '@anchor/db'
import { eq } from 'drizzle-orm'
import { getUserDateStr } from '@/lib/time/user-time'

const DAY_MS = 24 * 60 * 60 * 1000

/** 解析意图日期：null/相对值按用户时区换算为 YYYY-MM-DD，显式日期原样返回。 */
function resolveDate(param: string | null): string {
  if (!param || param === 'today') return getUserDateStr(Date.now())
  if (param === 'yesterday') return getUserDateStr(Date.now() - DAY_MS)
  if (param === 'tomorrow') return getUserDateStr(Date.now() + DAY_MS)
  return param
}

export async function GET(req: NextRequest) {
  const { searchParams } = new URL(req.url)
  const date = resolveDate(searchParams.get('date'))

  const db = getDb()
  const row = db
    .select()
    .from(dailyIntentions)
    .where(eq(dailyIntentions.date, date))
    .get()

  if (!row) {
    return NextResponse.json(null)
  }
  return NextResponse.json(row)
}

export async function POST(req: NextRequest) {
  const body = await req.json() as {
    content?: string
    source?: 'bedtime' | 'wakeup' | 'focuslayer' | 'system'
    date?: string
    confirmed?: boolean
  } | null

  if (!body || typeof body !== 'object') {
    return NextResponse.json({ error: 'invalid request body' }, { status: 400 })
  }

  const date = resolveDate(body.date ?? null)
  const now = Math.floor(Date.now() / 1000)
  const db = getDb()

  if (body.confirmed) {
    // 起床确认：标记 confirmed_at 为现在
    const existing = db
      .select()
      .from(dailyIntentions)
      .where(eq(dailyIntentions.date, date))
      .get()

    if (!existing) {
      return NextResponse.json({ error: 'no intention found for this date' }, { status: 404 })
    }

    db.update(dailyIntentions)
      .set({ confirmed_at: now })
      .where(eq(dailyIntentions.date, date))
      .run()

    return NextResponse.json({ ok: true, confirmed_at: now })
  }

  const content = body.content
  if (!content || typeof content !== 'string' || !content.trim()) {
    return NextResponse.json({ error: 'content is required' }, { status: 400 })
  }

  const source = body.source ?? 'bedtime'

  const existing = db
    .select()
    .from(dailyIntentions)
    .where(eq(dailyIntentions.date, date))
    .get()

  if (existing) {
    db.update(dailyIntentions)
      .set({ content: content.trim(), source })
      .where(eq(dailyIntentions.date, date))
      .run()
  } else {
    db.insert(dailyIntentions)
      .values({ date, content: content.trim(), source, created_at: now })
      .run()
  }

  const row = db
    .select()
    .from(dailyIntentions)
    .where(eq(dailyIntentions.date, date))
    .get()

  // 跨端协调：API 提交同样关闭所有客户端的意图弹窗
  const { notifyIntentSubmitted } = await import('@/lib/intention/anchor')
  notifyIntentSubmitted()

  return NextResponse.json(row, { status: existing ? 200 : 201 })
}
