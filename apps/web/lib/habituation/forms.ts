import type { Db } from '@anchor/db'
import { frictionFormProposals } from '@anchor/db'
import { eq } from 'drizzle-orm'

export interface FrictionForm {
  id: string
  category: 'entertainment_app_launch' | 'curfew_bypass' | 'attention_drift'
  clientAction: string // e.g. 'android:fullscreen_modal'
  level: 'notify' | 'soft' | 'hard' | 'strong'
}

export const FRICTION_FORMS: FrictionForm[] = [
  { id: 'entertainment:long_press_3s', category: 'entertainment_app_launch', clientAction: 'android:fullscreen_modal', level: 'soft' },
  { id: 'entertainment:confirm_dialog', category: 'entertainment_app_launch', clientAction: 'android:fullscreen_modal', level: 'soft' },
  { id: 'entertainment:show_usage_time', category: 'entertainment_app_launch', clientAction: 'android:fullscreen_modal', level: 'soft' },
  { id: 'entertainment:type_confirm', category: 'entertainment_app_launch', clientAction: 'android:fullscreen_modal', level: 'hard' },

  { id: 'curfew:slide_unlock', category: 'curfew_bypass', clientAction: 'chrome:friction_banner', level: 'soft' },
  { id: 'curfew:countdown_10s', category: 'curfew_bypass', clientAction: 'chrome:friction_banner', level: 'soft' },
  { id: 'curfew:read_intention', category: 'curfew_bypass', clientAction: 'chrome:friction_banner', level: 'soft' },
  { id: 'curfew:ai_confirm', category: 'curfew_bypass', clientAction: 'chrome:friction_banner', level: 'hard' },

  { id: 'drift:visual_badge', category: 'attention_drift', clientAction: 'chrome:friction_banner', level: 'notify' },
  { id: 'drift:audio_chime', category: 'attention_drift', clientAction: 'desktop:toast_notify', level: 'notify' },
  { id: 'drift:haptic', category: 'attention_drift', clientAction: 'android:push_notify', level: 'notify' },
  { id: 'drift:ai_voice', category: 'attention_drift', clientAction: 'desktop:toast_notify', level: 'soft' },
]

/**
 * 从数据库加载用户已接受的 AI 提议摩擦形式，追加到内置形式列表后面。
 * 调用者负责传入 db 实例；若 DB 查询失败则静默降级（返回仅内置形式）。
 */
export function getAllFrictionForms(db: Db): FrictionForm[] {
  try {
    const accepted = db
      .select()
      .from(frictionFormProposals)
      .where(eq(frictionFormProposals.status, 'accepted'))
      .all()

    const custom: FrictionForm[] = accepted.map(row => ({
      id: row.form_id,
      category: row.category as FrictionForm['category'],
      clientAction: row.client_action,
      level: row.level as FrictionForm['level'],
    }))

    return [...FRICTION_FORMS, ...custom]
  } catch {
    return [...FRICTION_FORMS]
  }
}

/**
 * 在给定形式列表中，为指定类别选择第一个尚未习惯化的摩擦形式。
 * 传入 getAllFrictionForms(db) 以包含用户自定义形式，或直接传 FRICTION_FORMS 用于测试。
 */
export function selectFrictionForm(
  category: FrictionForm['category'],
  isHabituatedFn: (formId: string) => boolean,
  forms: FrictionForm[] = FRICTION_FORMS,
): FrictionForm | null {
  const candidates = forms.filter(f => f.category === category)
  for (const form of candidates) {
    if (!isHabituatedFn(form.id)) return form
  }
  return null // 全部习惯化，触发升级
}
