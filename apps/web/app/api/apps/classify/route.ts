import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { appClassifications } from '@anchor/db'
import { eq } from 'drizzle-orm'

// POST - 请求 AI 分类 app
export async function POST(req: Request) {
  const { package_name, app_name, version_name, category, process_name, icon_base64 } = await req.json()

  if (!package_name) {
    return NextResponse.json({ error: 'package_name required' }, { status: 400 })
  }

  const db = getDb()
  const now = Math.floor(Date.now() / 1000)

  // 1. 检查是否已有分类（pending 视为未完成，继续走分类流程）
  const existing = db
    .select()
    .from(appClassifications)
    .where(eq(appClassifications.package_name, package_name))
    .get()

  if (existing && existing.classification_source !== 'pending') {
    return NextResponse.json({
      package_name: existing.package_name,
      app_name: existing.app_name,
      high_stimulus: existing.high_stimulus,
      is_work: existing.is_work,
      source: existing.classification_source
    })
  }

  // 2. 先落 pending 行并广播，web 端可实时看到「分类中」
  const { broadcast } = await import('@/lib/ws/server')
  db.insert(appClassifications).values({
    package_name,
    app_name: app_name || package_name,
    high_stimulus: false,
    classification_source: 'pending',
    user_modified: false,
    version_name: version_name || null,
    category: category || null,
    process_name: process_name || null,
    icon_base64: icon_base64 || null,
    created_at: now,
    updated_at: now,
  }).onConflictDoUpdate({
    target: appClassifications.package_name,
    set: {
      classification_source: 'pending',
      app_name: app_name || package_name,
      version_name: version_name || null,
      category: category || null,
      process_name: process_name || null,
      icon_base64: icon_base64 || null,
      updated_at: now,
    }
  }).run()

  broadcast({
    type: 'app:classification_updated',
    package_name,
    app_name: app_name || package_name,
    high_stimulus: false,
    source: 'pending',
  })

  // 开发者自声明的 Android category 直接映射，无需 AI
  // AUDIO / IMAGE / OTHER / 空 语义模糊，仍走 AI
  const categoryPreset: Record<string, { high: boolean; work: boolean }> = {
    GAME: { high: true, work: false },
    VIDEO: { high: true, work: false },
    SOCIAL: { high: true, work: false },
    NEWS: { high: true, work: false },
    PRODUCTIVITY: { high: false, work: true },
    MAPS: { high: false, work: false },
  }

  let highStimulus = false
  let isWork = false
  let source: 'ai' | 'fallback' | 'preset' = 'fallback'
  let content = ''

  if (typeof category === 'string' && category.toUpperCase() in categoryPreset) {
    const preset = categoryPreset[category.toUpperCase()]!
    highStimulus = preset.high
    isWork = preset.work
    source = 'preset'
  } else {
    const { classifyContent } = await import('@/lib/ai/classify-content')
    const result = await classifyContent('android_app', {
      package_name,
      app_name: app_name || package_name,
      version_name: version_name || '',
      category: category || '',
      process_name: process_name || '',
    })
    highStimulus = result.high_stimulus
    isWork = result.is_work
    source = result.source
    content = result.raw
  }

  // 4. 分类完成，更新行并广播
  const doneAt = Math.floor(Date.now() / 1000)
  db.update(appClassifications)
    .set({
      high_stimulus: highStimulus,
      is_work: isWork,
      classification_source: source,
      ai_raw_response: content || null,
      reviewed: false,
      updated_at: doneAt,
    })
    .where(eq(appClassifications.package_name, package_name))
    .run()

  broadcast({
    type: 'app:classification_updated',
    package_name,
    app_name: app_name || package_name,
    high_stimulus: highStimulus,
    is_work: isWork,
    source,
  })

  return NextResponse.json({
    package_name,
    app_name: app_name || package_name,
    high_stimulus: highStimulus,
    is_work: isWork,
    source
  })
}
