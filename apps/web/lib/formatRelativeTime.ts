// 相对时间格式化（设置页「已配对设备」使用）：null → 从未活跃；
// <60s 刚刚、<60min N 分钟前、<24h N 小时前、否则 N 天前。手写简易版，不引依赖。
export function formatRelativeTime(unixSec: number | null, nowSec: number): string {
  if (unixSec === null) return '从未活跃'
  const delta = Math.max(0, nowSec - unixSec)
  if (delta < 60) return '刚刚'
  const minutes = Math.floor(delta / 60)
  if (minutes < 60) return `${minutes} 分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} 小时前`
  return `${Math.floor(hours / 24)} 天前`
}
