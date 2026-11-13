export function formatDate(date: Date, locale = 'zh-CN'): string {
  return date.toLocaleDateString(locale)
}
