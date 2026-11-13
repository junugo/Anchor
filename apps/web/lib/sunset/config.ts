import type { Db } from '@anchor/db'
import type { SunsetConfig } from '@anchor/types'
import { sunsetConfig } from '@anchor/db'
import { eq } from 'drizzle-orm'
import { getDb } from '@/lib/db'

// Next.js API 路由（webpack 打包）与自定义 server（tsx 加载）是两套模块实例，
// 配置缓存挂到 globalThis 保证全进程唯一（同 ws/server.ts 的 clients），
// 否则 PATCH 只清路由侧缓存，决策引擎仍用旧配置计算宵禁阶段。
const globalForConfig = globalThis as unknown as {
  __anchorSunsetConfigCache?: SunsetConfig | null
  __anchorSunsetConfigDb?: Db | null
}

export function initSunsetConfig(db: Db) {
  globalForConfig.__anchorSunsetConfigDb = db
  globalForConfig.__anchorSunsetConfigCache = null // 重置缓存
  // 确保有默认记录
  const existing = db.select().from(sunsetConfig).get()
  if (!existing) {
    db.insert(sunsetConfig).values({
      enabled: true,
      target_bedtime_minutes: 90,
      phase_t60_enabled: true,
      phase_t30_enabled: true,
      phase_t15_enabled: true,
      phase_t0_enabled: true,
      // 高刺激网站统一由 site_classifications 表管理（/sites 页），此字段已废弃
      high_stimulus_sites: [],
      high_stimulus_apps: [
        'com.zhiliaoapp.musically',
        'com.kuaishou.nebula',
        'com.tencent.mm',
        'com.sina.weibo',
        'com.bilibili.app.phone',
        'tv.danmaku.bili',
        'com.ss.android.article.news',
        'com.tencent.ig',
      ],
      whitelist_processes: [],
      sleep_buffer_minutes: 10,
      sleep_confirm_minutes: 15,
      sleep_candidate_idle_minutes: 15,
      sleep_confirm_cooldown_minutes: 30,
      sleep_bright_screen_enabled: true,
      anchor_mode: 'config_hard',
      ideal_bedtime_minutes: 1410,
      progressive_step_minutes: 15,
      updated_at: Math.floor(Date.now() / 1000),
    }).run()
  }
}

function ensureInitialized() {
  if (!globalForConfig.__anchorSunsetConfigDb) {
    initSunsetConfig(getDb())
  }
}

export function getSunsetConfig(): SunsetConfig {
  if (globalForConfig.__anchorSunsetConfigCache) return globalForConfig.__anchorSunsetConfigCache
  ensureInitialized()
  const row = globalForConfig.__anchorSunsetConfigDb!.select().from(sunsetConfig).get()
  if (!row) throw new Error('No sunset config found')
  globalForConfig.__anchorSunsetConfigCache = row as SunsetConfig
  return globalForConfig.__anchorSunsetConfigCache
}

export function updateSunsetConfig(patch: Partial<SunsetConfig>): SunsetConfig {
  ensureInitialized()
  globalForConfig.__anchorSunsetConfigDb!.update(sunsetConfig)
    .set({ ...patch, updated_at: Math.floor(Date.now() / 1000) })
    .where(eq(sunsetConfig.id, 1))
    .run()
  globalForConfig.__anchorSunsetConfigCache = null // invalidate cache
  return getSunsetConfig()
}
