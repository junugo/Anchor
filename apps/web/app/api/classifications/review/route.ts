import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { appClassifications, siteClassifications, processClassifications } from '@anchor/db'
import { and, eq, ne, inArray, getTableColumns } from 'drizzle-orm'
import type { AnySQLiteTable } from 'drizzle-orm/sqlite-core'

// POST - 标记分类已复核（单条 / 批量 / 全部）
// body: { all?: boolean } 或 { kind: 'app'|'site'|'process', keys: string[] }
// 只处理「未复核且非 pending」的行；pending 行等 AI 结果落库时会自然重置 reviewed=false
export async function POST(req: Request) {
  const body = await req.json()
  const { all, kind, keys } = body as { all?: boolean; kind?: string; keys?: string[] }

  if (!all && (!kind || !Array.isArray(keys) || keys.length === 0)) {
    return NextResponse.json({ error: 'Invalid params' }, { status: 400 })
  }
  if (kind && !['app', 'site', 'process'].includes(kind)) {
    return NextResponse.json({ error: 'Invalid kind' }, { status: 400 })
  }

  const db = getDb()
  const now = Math.floor(Date.now() / 1000)
  const { broadcast } = await import('@/lib/ws/server')
  const counts: Record<string, number> = {}

  const mark = (
    table: AnySQLiteTable,
    keyColName: string,
    wsKey: string,
    wsType: 'app:classification_reviewed' | 'site:classification_reviewed' | 'process:classification_reviewed',
    filterKeys?: string[],
  ) => {
    const cols = getTableColumns(table)
    const keyCol = cols[keyColName]
    const conds = [eq(cols.reviewed, false), ne(cols.classification_source, 'pending')]
    if (filterKeys) {
      if (filterKeys.length === 0) { counts[wsKey] = 0; return }
      conds.push(inArray(keyCol, filterKeys))
    }
    const targets = db.select({ key: keyCol }).from(table).where(and(...conds)).all()
    if (targets.length === 0) { counts[wsKey] = 0; return }
    db.update(table)
      .set({ reviewed: true, updated_at: now })
      .where(inArray(keyCol, targets.map(t => t.key)))
      .run()
    counts[wsKey] = targets.length
    broadcast({ type: wsType, [wsKey]: targets.map(t => t.key) } as never)
  }

  if (all) {
    mark(appClassifications, 'package_name', 'package_names', 'app:classification_reviewed')
    mark(siteClassifications, 'domain', 'domains', 'site:classification_reviewed')
    mark(processClassifications, 'process_name', 'process_names', 'process:classification_reviewed')
  } else if (kind === 'app') {
    mark(appClassifications, 'package_name', 'package_names', 'app:classification_reviewed', keys)
  } else if (kind === 'site') {
    mark(siteClassifications, 'domain', 'domains', 'site:classification_reviewed', keys)
  } else {
    mark(processClassifications, 'process_name', 'process_names', 'process:classification_reviewed', keys)
  }

  return NextResponse.json({ success: true, reviewed: counts })
}
