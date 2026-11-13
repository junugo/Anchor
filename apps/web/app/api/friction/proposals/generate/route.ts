import { NextResponse } from 'next/server'
import { getDb } from '@/lib/db'
import { frictionEvents, frictionFormProposals } from '@anchor/db'
import { sql } from 'drizzle-orm'
import { FRICTION_FORMS, type FrictionForm } from '@/lib/habituation/forms'

const VALID_CATEGORIES = ['entertainment_app_launch', 'curfew_bypass', 'attention_drift'] as const
const VALID_CLIENT_ACTIONS = [
  'android:fullscreen_modal', 'android:fullscreen_block', 'android:push_notify',
  'chrome:friction_banner', 'chrome:grayscale', 'chrome:hard_block',
  'desktop:toast_notify', 'desktop:topmost_window', 'desktop:force_lock',
] as const

interface AiProposedForm {
  form_id: string
  category: typeof VALID_CATEGORIES[number]
  client_action: typeof VALID_CLIENT_ACTIONS[number]
  level: 'notify' | 'soft' | 'hard' | 'strong'
  description: string
  ai_rationale: string
}

/**
 * POST /api/friction/proposals/generate
 * 分析习惯化数据，由 AI 提议一个新的摩擦形式。
 *
 * - 收集各摩擦形式的绕过统计，识别哪些类别的所有形式都被习惯化了
 * - 调用 DeepSeek 生成一个针对该类别的新形式提议
 * - 将提议以 pending 状态写入 DB，等待用户审查
 */
export async function POST() {
  const apiKey = process.env['DEEPSEEK_API_KEY']
  if (!apiKey) {
    return NextResponse.json({ error: 'DEEPSEEK_API_KEY 未配置' }, { status: 503 })
  }

  const db = getDb()

  // 收集各形式的绕过次数统计（过去 30 天）
  const cutoff = Math.floor(Date.now() / 1000) - 30 * 86400
  const bypassCounts = db
    .select({
      form_id: frictionEvents.form_id,
      bypass_count: sql<number>`count(*)`,
    })
    .from(frictionEvents)
    .where(
      sql`${frictionEvents.event_type} = 'bypassed' AND ${frictionEvents.recorded_at} >= ${cutoff}`
    )
    .groupBy(frictionEvents.form_id)
    .all()

  const bypassMap = new Map(bypassCounts.map(r => [r.form_id, r.bypass_count]))

  // 统计各类别的习惯化情况（绕过次数 >= 5 次视为"被习惯化"）
  const categoryStats = VALID_CATEGORIES.map(cat => {
    const forms = FRICTION_FORMS.filter(f => f.category === cat)
    const habituatedCount = forms.filter(f => (bypassMap.get(f.id) ?? 0) >= 5).length
    return { category: cat, total: forms.length, habituated: habituatedCount }
  })

  // 优先建议"所有内置形式都被高度绕过"的类别
  const targetCat = categoryStats.sort((a, b) => (b.habituated / b.total) - (a.habituated / a.total))[0]!

  // 查询该类别的现有形式（内置 + 已接受提议）用于告知 AI 避免重复
  const existingForms = FRICTION_FORMS.filter(f => f.category === targetCat.category)
  const existingIds = existingForms.map(f => f.id)

  const systemPrompt = `你是 Anchor 系统的习惯化对抗引擎。
你的任务是根据用户的行为数据，为摩擦形式库提议一个新的、用户尚未习惯的摩擦形式。

摩擦形式用于在用户使用高刺激内容时增加认知阻力，使其更有意识地做出选择。

**类别说明：**
- entertainment_app_launch：娱乐应用启动时触发（Android）
- curfew_bypass：宵禁时段绕过时触发（Chrome）
- attention_drift：注意力漂移/碎片化时触发（Chrome/Desktop/Android）

**当前分析：**
目标类别：${targetCat.category}
该类别共 ${targetCat.total} 个内置形式，其中 ${targetCat.habituated} 个已被用户习惯化（近 30 天绕过 5+ 次）。

**现有形式列表（请勿重复）：**
${existingIds.join('\n')}

**可用客户端动作：**
${VALID_CLIENT_ACTIONS.join(', ')}

**任务：**
提议一个新的、心理学上不同于现有形式的摩擦方式。
要求：
1. 基于认知摩擦原理（如反射式提问、行为中断、情绪锚定）
2. 使用与现有形式不同的认知机制
3. 适合指定类别的场景

请以 JSON 格式返回（不要有任何其他内容）：
{
  "form_id": "custom:xxx_yyy",
  "category": "${targetCat.category}",
  "client_action": "一个可用客户端动作",
  "level": "notify | soft | hard | strong",
  "description": "简短描述这个摩擦形式的表现（≤50字）",
  "ai_rationale": "基于当前习惯化数据推荐此形式的理由（≤100字）"
}`

  let proposedForm: AiProposedForm
  try {
    const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: systemPrompt }],
        temperature: 0.7,
        response_format: { type: 'json_object' },
      }),
    })

    if (!res.ok) {
      const err = await res.text()
      console.error('[friction/generate] DeepSeek error:', err)
      return NextResponse.json({ error: 'AI 调用失败' }, { status: 502 })
    }

    const data = await res.json() as { choices: Array<{ message: { content: string } }> }
    const raw = data.choices[0]?.message.content ?? '{}'
    const parsed = JSON.parse(raw) as Partial<AiProposedForm>

    // 基本验证
    if (
      !parsed.form_id || typeof parsed.form_id !== 'string' ||
      !parsed.category || !VALID_CATEGORIES.includes(parsed.category as typeof VALID_CATEGORIES[number]) ||
      !parsed.client_action || !VALID_CLIENT_ACTIONS.includes(parsed.client_action as typeof VALID_CLIENT_ACTIONS[number]) ||
      !parsed.level || !['notify', 'soft', 'hard', 'strong'].includes(parsed.level) ||
      !parsed.description || !parsed.ai_rationale
    ) {
      console.error('[friction/generate] invalid AI response:', parsed)
      return NextResponse.json({ error: 'AI 返回格式无效' }, { status: 502 })
    }

    // 确保 form_id 以 custom: 开头，防止 AI 覆盖内置形式
    const formId = parsed.form_id.startsWith('custom:') ? parsed.form_id : `custom:${parsed.form_id}`

    proposedForm = {
      form_id: formId,
      category: parsed.category as typeof VALID_CATEGORIES[number],
      client_action: parsed.client_action as typeof VALID_CLIENT_ACTIONS[number],
      level: parsed.level as FrictionForm['level'],
      description: parsed.description,
      ai_rationale: parsed.ai_rationale,
    }
  } catch (e) {
    console.error('[friction/generate] parse error:', e)
    return NextResponse.json({ error: 'AI 响应解析失败' }, { status: 502 })
  }

  // 写入 DB（如已有同 form_id 的提议则跳过，避免重复）
  try {
    db.insert(frictionFormProposals).values({
      form_id: proposedForm.form_id,
      category: proposedForm.category,
      client_action: proposedForm.client_action,
      level: proposedForm.level,
      description: proposedForm.description,
      ai_rationale: proposedForm.ai_rationale,
      status: 'pending',
      proposed_at: Math.floor(Date.now() / 1000),
    }).run()
  } catch (e: unknown) {
    // form_id UNIQUE 冲突：说明同一提议已存在
    if (e instanceof Error && e.message.includes('UNIQUE')) {
      return NextResponse.json({ error: '该摩擦形式已有待审查提议', formId: proposedForm.form_id }, { status: 409 })
    }
    throw e
  }

  return NextResponse.json({ ok: true, proposal: proposedForm })
}
