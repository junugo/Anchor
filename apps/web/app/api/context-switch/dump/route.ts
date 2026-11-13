import { NextRequest, NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { contextSwitchDumps } from '@anchor/db'

export async function POST(req: NextRequest) {
  const body = await req.json() as {
    content?: string
    source?: 'user_text' | 'user_voice' | 'system_inferred'
    inferredPayload?: Record<string, unknown>
    focuslayerIssueId?: string
  }

  if (typeof body.content !== 'string' || body.content.trim().length === 0) {
    return NextResponse.json({ ok: false, message: 'content required' }, { status: 400 })
  }

  const db = getDb()
  const nowS = Math.floor(Date.now() / 1000)

  const inserted = db
    .insert(contextSwitchDumps)
    .values({
      dumped_at: nowS,
      source: body.source ?? 'user_text',
      content: body.content.trim(),
      inferred_payload: body.inferredPayload ?? {},
      focuslayer_issue_id: body.focuslayerIssueId,
      created_at: nowS,
    })
    .returning()
    .get()

  return NextResponse.json({ ok: true, data: inserted })
}
