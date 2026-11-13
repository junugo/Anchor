import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { getTimelineDays } from '@/lib/timeline/queries'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams
  const to = q.get('to') ?? new Date().toLocaleDateString('sv')
  const from = q.get('from') ?? to
  if (!DATE_RE.test(from) || !DATE_RE.test(to) || from > to) {
    return NextResponse.json({ error: 'invalid from/to, expect YYYY-MM-DD and from <= to' }, { status: 400 })
  }
  return NextResponse.json({ days: getTimelineDays(getDb(), from, to) })
}
