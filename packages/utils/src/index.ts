export function formatDate(date: Date, locale = 'zh-CN'): string {
  return date.toLocaleDateString(locale)
}

export function isNonEmpty(value: string | null | undefined): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

export function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

/**
 * 计算距离目标就寝时间还剩多少分钟。
 * targetMinutes 为当天 0 点起的分钟数（如 23:00 = 1380）。
 */
export function calcRemainingMinutes(targetMinutes: number): number {
  const now = new Date()
  const nowM = now.getHours() * 60 + now.getMinutes()
  let diff = (targetMinutes - nowM + 24 * 60) % (24 * 60)
  // 鑻ヨ窛绂昏秴杩?12 灏忔椂锛岃涓哄凡杩囷紝杩斿洖 0
  if (diff > 12 * 60) diff = 0
  return diff
}

// Anchor 状态机（合并自 @anchor/store）
export { anchorReducer, inferUserState, initialState, STATE_LABELS, STATE_COLOR_TOKENS } from './state'
export type { AnchorState, AnchorAction, PendingIntentCapture, PendingIntentConfirm } from './state'

// 上行行为数据加密（AES-256-GCM）
export {
  DEFAULT_DATA_KEY,
  resolveDataKey,
  dataKeyFingerprint,
  encryptJson,
  decryptRaw,
  decryptJson,
  encryptEnvelope,
  unwrapBody,
} from './crypto'
export type { EncryptedEnvelope, DataKeyEnv } from './crypto'
