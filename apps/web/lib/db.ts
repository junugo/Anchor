import path from 'path'
import os from 'os'
import { createDb, type Db } from '@anchor/db'

// 不能模块级缓存 DB_PATH：ESM import 提升会先执行本模块，早于 server.ts 的 loadEnvFile，
// 导致 process.env.ANCHOR_DB_PATH 还没被读取就已定型。延迟到 initDb/getDb 调用时计算。
function resolveDbPath(): string {
  return process.env.ANCHOR_DB_PATH
    ?? path.join(os.homedir(), '.anchor', 'anchor.db')
}

let _db: Db | null = null

export function initDb(): Db {
  if (_db) return _db
  _db = createDb(resolveDbPath())
  return _db
}

export function getDb(): Db {
  if (!_db) {
    _db = initDb()
  }
  return _db
}
