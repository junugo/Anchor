import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 在系统临时目录下创建一个隔离的测试用数据库路径，测试结束后通过 rmSync 清理 dir */
export function tempDbPath(name: string): { dir: string; dbPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `anchor-${name}-`))
  return { dir, dbPath: path.join(dir, 'anchor.db') }
}
