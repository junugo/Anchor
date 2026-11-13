export type EmotionalSignal = 'distress' | 'withdrawal' | 'stable'

export interface ExtractedEmotionalSignal {
  signal: EmotionalSignal
  confidence: number
  evidence: string
}

const DISTRESS_KEYWORDS = [
  '累', '崩溃', '受不了', '难过', '痛苦', '焦虑', '无意义', '绝望', '烦',
  '不想', '撑不住', '心烦', '难受', '压力', '头疼', '头痛',
]

const WITHDRAWAL_PATTERNS = [
  /^嗯[。.，,\s]*$/,
  /^不知道[。.，,\s]*$/,
  /^随便[。.，,\s]*$/,
  /^就这样[吧。.，,\s]*$/,
  /^无所谓[。.，,\s]*$/,
  /^没事[。.，,\s]*$/,
  /^算了[。.，,\s]*$/,
]

/**
 * 从用户输入文本中提取情绪信号。
 * 用于在对话结束后被动采集情绪状态，写入 userMemory.emotional_signal。
 */
export function extractEmotionalSignal(text: string): ExtractedEmotionalSignal {
  const normalized = text.toLowerCase().trim()

  // 检测痛苦关键词
  const distressMatches = DISTRESS_KEYWORDS.filter(k => normalized.includes(k))
  if (distressMatches.length >= 2) {
    return {
      signal: 'distress',
      confidence: Math.min(0.95, 0.6 + distressMatches.length * 0.1),
      evidence: `distress keywords: ${distressMatches.join(', ')}`,
    }
  }

  // 检测退缩/沉默模式
  const sentences = text.split(/[。！？\n]+/).map(s => s.trim()).filter(Boolean)
  const isWithdrawal =
    WITHDRAWAL_PATTERNS.some(p => p.test(text.trim())) ||
    (sentences.every(s => s.length <= 5) && text.length < 30 && sentences.length >= 2)

  if (isWithdrawal) {
    return {
      signal: 'withdrawal',
      confidence: 0.7,
      evidence: 'short/withdrawal response pattern',
    }
  }

  return {
    signal: 'stable',
    confidence: 0.8,
    evidence: 'no distress or withdrawal indicators',
  }
}
