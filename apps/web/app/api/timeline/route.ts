import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { getTimelineDay } from '@/lib/timeline/queries'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function GET(req: NextRequest) {
  const date = req.nextUrl.searchParams.get('date') ?? new Date().toLocaleDateString('sv')
  if (!DATE_RE.test(date)) {
    return NextResponse.json({ error: 'invalid date, expect YYYY-MM-DD' }, { status: 400 })
  }
  return NextResponse.json(getTimelineDay(getDb(), date))
}
