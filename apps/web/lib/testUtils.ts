import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** 在系统临时目录下创建一个隔离的测试用数据库路径，测试结束后通过 rmSync 清理 dir */
export function tempDbPath(name: string): { dir: string; dbPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `anchor-${name}-`))
  return { dir, dbPath: path.join(dir, 'anchor.db') }
}

/** 递归删除临时目录；Windows 文件句柄释放有延迟，带重试 */
export function cleanupDir(dir: string) {
  for (let i = 0; i < 20; i++) {
    try { fs.rmSync(dir, { recursive: true, force: true }); return } catch { /* Windows 句柄释放有延迟，重试 */ }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
  }
  fs.rmSync(dir, { recursive: true, force: true })
}
