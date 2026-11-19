// 服务器数据密钥自动解析：env → settings 表 → 生成并持久化。
// 启动时（server.ts）同步解析一次并缓存，之后 getDataKey() 零开销复用；
// 替换此前「每请求读 env、未配置即抛错」的 resolveDataKey 调用方式。
import { eq } from 'drizzle-orm'
import { settings, type Db } from '@anchor/db'
import { generateDataKey } from '@anchor/utils'
import { getDb } from './db'

export type DataKeySource = 'env' | 'stored' | 'generated'

export interface ResolvedDataKey {
  key: string
  source: DataKeySource
}

/**
 * 一次性解析数据密钥（幂等）：
 * 1. process.env.ANCHOR_DATA_KEY（非空白）→ env
 * 2. settings 表 key='data_key' → stored
 * 3. generateDataKey() 生成并写入 settings → generated
 */
export function resolveDataKeyOnce(db: Db): ResolvedDataKey {
  const envKey = process.env.ANCHOR_DATA_KEY?.trim()
  if (envKey) return { key: envKey, source: 'env' }

  const row = db.select().from(settings).where(eq(settings.key, 'data_key')).get()
  if (row) return { key: row.value, source: 'stored' }

  const key = generateDataKey()
  db.insert(settings).values({ key: 'data_key', value: key }).run()
  return { key, source: 'generated' }
}

// 进程内缓存：模块级变量 + 已解析标志，重复调用零开销
let cachedKey: string | null = null
let cachedSource: DataKeySource | null = null

/** 取数据密钥（首次调用时惰性解析并缓存）。生产路径请保证 server.ts 启动时已解析过一次 */
export function getDataKey(): string {
  if (cachedKey === null) {
    const resolved = resolveDataKeyOnce(getDb())
    cachedKey = resolved.key
    cachedSource = resolved.source
  }
  return cachedKey
}

/** 已解析密钥的来源（未解析过则 null；诊断/测试用） */
export function getDataKeySource(): DataKeySource | null {
  return cachedSource
}

/** 清空进程内缓存（测试用：模拟二次启动） */
export function resetDataKeyCacheForTest(): void {
  cachedKey = null
  cachedSource = null
}
