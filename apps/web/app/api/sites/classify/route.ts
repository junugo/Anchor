import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { siteClassifications } from '@anchor/db'
import { eq } from 'drizzle-orm'

// POST - 请求 AI 分类网站（镜像 app 分类机制）
export async function POST(req: Request) {
  const { domain: rawDomain, site_name, url, favicon_base64 } = await req.json()

  if (!rawDomain) {
    return NextResponse.json({ error: 'domain required' }, { status: 400 })
  }

  const domain = String(rawDomain).toLowerCase().replace(/^www\./, '')
  // 图标由客户端抓取并以 base64 上传（客户端与服务器网络环境不同，服务器不主动抓）
  const favicon = typeof favicon_base64 === 'string' && favicon_base64.startsWith('data:image/') && favicon_base64.length <= 140_000
    ? favicon_base64
    : null

  const db = getDb()
  const now = Math.floor(Date.now() / 1000)

  // 1. 检查是否已有分类（pending 视为未完成，继续走分类流程）
  const existing = db
    .select()
    .from(siteClassifications)
    .where(eq(siteClassifications.domain, domain))
    .get()

  if (existing && existing.classification_source !== 'pending') {
    return NextResponse.json({
      domain: existing.domain,
      site_name: existing.site_name,
      high_stimulus: existing.high_stimulus,
      is_work: existing.is_work,
      source: existing.classification_source,
    })
  }

  // 2. 先落 pending 行并广播，管理页可实时看到「分类中」
  const { broadcast } = await import('@/lib/ws/server')
  db.insert(siteClassifications).values({
    domain,
    site_name: site_name || domain,
    high_stimulus: false,
    classification_source: 'pending',
    user_modified: false,
    url: url || null,
    created_at: now,
    updated_at: now,
  }).onConflictDoUpdate({
    target: siteClassifications.domain,
    set: {
      classification_source: 'pending',
      site_name: site_name || domain,
      url: url || null,
      updated_at: now,
    },
  }).run()

  broadcast({
    type: 'site:classification_updated',
    domain,
    site_name: site_name || domain,
    high_stimulus: false,
    source: 'pending',
  })

  // 3. 无预设清单：分类统一由 /apps 管理页维护（site_classifications 表），未知域名交给 AI
  const { classifyContent } = await import('@/lib/ai/classify-content')
  const result = await classifyContent('site', {
    domain,
    site_name: site_name || domain,
    url: url || '',
  })
  const highStimulus = result.high_stimulus
  const isWork = result.is_work
  const source = result.source
  const content = result.raw

  // 4. 分类完成，更新行并广播
  const doneAt = Math.floor(Date.now() / 1000)
  db.update(siteClassifications)
    .set({
      high_stimulus: highStimulus,
      is_work: isWork,
      classification_source: source,
      ai_raw_response: content || null,
      favicon_base64: favicon,
      reviewed: false,
      updated_at: doneAt,
    })
    .where(eq(siteClassifications.domain, domain))
    .run()

  broadcast({
    type: 'site:classification_updated',
    domain,
    site_name: site_name || domain,
    high_stimulus: highStimulus,
    is_work: isWork,
    source,
  })

  return NextResponse.json({
    domain,
    site_name: site_name || domain,
    high_stimulus: highStimulus,
    is_work: isWork,
    source,
  })
}
