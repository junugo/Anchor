// 根据终端名称推断命令类别（简单启发式）
export function inferTerminalCategory(name: string): string {
  const lower = name.toLowerCase()
  if (lower.includes('git')) return 'git'
  if (lower.includes('node') || lower.includes('npm') || lower.includes('pnpm')) return 'node'
  if (lower.includes('python') || lower.includes('py')) return 'python'
  return 'other'
}
