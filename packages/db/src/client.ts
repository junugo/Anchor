import fs from 'fs'
import path from 'path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import * as schema from './schema'

// 默认高刺激 Android 应用列表（三处共享此常量，避免独立维护）
const DEFAULT_HIGH_STIMULUS_APPS_JSON =
  '["com.zhiliaoapp.musically","com.kuaishou.nebula","com.tencent.mm","com.sina.weibo","com.bilibili.app.phone","tv.danmaku.bili","com.ss.android.article.news","com.tencent.ig"]'

export function createDb(dbPath: string) {
  // Ensure parent directory exists
  const dir = path.dirname(dbPath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

  const sqlite = new Database(dbPath)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')

  // Create tables if they don't exist (simple push migration)
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS behavior_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload TEXT NOT NULL,
      inferred_state TEXT,
      confidence REAL,
      logged_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS user_living_context (
      user_id TEXT PRIMARY KEY,
      inferred_state TEXT NOT NULL DEFAULT 'resting',
      location_zone TEXT NOT NULL DEFAULT 'unknown',
      current_app_window TEXT,
      screen_active INTEGER NOT NULL DEFAULT 0,
      device_distance_meters REAL,
      focuslayer_sync_enabled INTEGER NOT NULL DEFAULT 0,
      focuslayer_server_url TEXT,
      last_focuslayer_query_at INTEGER,
      last_focuslayer_response TEXT,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS circadian_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL UNIQUE,
      sleep_start INTEGER,
      sleep_end INTEGER,
      sleep_debt_hours REAL,
      meals_count INTEGER NOT NULL DEFAULT 0,
      left_room_count INTEGER NOT NULL DEFAULT 0,
      sunset_compliance INTEGER,
      dissociation_risk_score REAL,
      anchor_ai_summary TEXT
    );
    CREATE TABLE IF NOT EXISTS sunset_config (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      enabled INTEGER NOT NULL DEFAULT 1,
      target_bedtime_minutes INTEGER NOT NULL DEFAULT 90,
      phase_t60_enabled INTEGER NOT NULL DEFAULT 1,
      phase_t30_enabled INTEGER NOT NULL DEFAULT 1,
      phase_t15_enabled INTEGER NOT NULL DEFAULT 1,
      phase_t0_enabled INTEGER NOT NULL DEFAULT 1,
      high_stimulus_sites TEXT NOT NULL DEFAULT '[]',
      high_stimulus_apps TEXT NOT NULL DEFAULT '${DEFAULT_HIGH_STIMULUS_APPS_JSON}',
      whitelist_processes TEXT NOT NULL DEFAULT '[]',
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS time_capsules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content TEXT NOT NULL,
      trigger TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_played_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS ai_conversation_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date_range_start TEXT NOT NULL,
      date_range_end TEXT NOT NULL,
      summary TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS dissociation_diary (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      period_start INTEGER NOT NULL,
      period_end INTEGER NOT NULL,
      candidate_label TEXT NOT NULL,
      user_choice TEXT,
      confirmed_at INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS user_memory (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key TEXT NOT NULL UNIQUE,
      value TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_behavior_logs_logged_at ON behavior_logs (logged_at);
    CREATE INDEX IF NOT EXISTS idx_circadian_logs_date ON circadian_logs (date);
    CREATE INDEX IF NOT EXISTS idx_chat_messages_created_at ON chat_messages (created_at);
    CREATE INDEX IF NOT EXISTS idx_user_memory_key ON user_memory (key);
  `)

  // Incremental migrations for columns/tables added after initial schema
  const migrations = [
    `CREATE TABLE IF NOT EXISTS user_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    // 新增 high_stimulus_apps 列（已有 DB 需要 ALTER TABLE）
    `ALTER TABLE sunset_config ADD COLUMN high_stimulus_apps TEXT NOT NULL DEFAULT '${DEFAULT_HIGH_STIMULUS_APPS_JSON}'`,
    // T-15 阶段独立开关（已有 DB 需要 ALTER TABLE）
    `ALTER TABLE sunset_config ADD COLUMN phase_t15_enabled INTEGER NOT NULL DEFAULT 1`,
    // 计划 3：circadian_logs 新增 8 个行为分析字段（nullable，历史行自动为 NULL）
    `ALTER TABLE circadian_logs ADD COLUMN deep_work_total_ms INTEGER`,
    `ALTER TABLE circadian_logs ADD COLUMN dissociation_count INTEGER`,
    `ALTER TABLE circadian_logs ADD COLUMN dissociation_total_ms INTEGER`,
    `ALTER TABLE circadian_logs ADD COLUMN intervention_count INTEGER`,
    `ALTER TABLE circadian_logs ADD COLUMN intervention_dismiss_rate REAL`,
    `ALTER TABLE circadian_logs ADD COLUMN android_unlock_count INTEGER`,
    `ALTER TABLE circadian_logs ADD COLUMN peak_work_hour INTEGER`,
    `ALTER TABLE circadian_logs ADD COLUMN peak_distraction_hour INTEGER`,
    // V1.1：user_living_context 新增 severity_level 列（默认 L0）
    `ALTER TABLE user_living_context ADD COLUMN severity_level TEXT NOT NULL DEFAULT 'L0'`,
    // severity 24h 下降迟滞修复：等级变化时间独立记录（updated_at 每 tick 刷新会导致永不下降）
    `ALTER TABLE user_living_context ADD COLUMN severity_changed_at INTEGER`,
    // V1.1：新增 daily_intentions 表
    `CREATE TABLE IF NOT EXISTS daily_intentions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      content TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'bedtime',
      confirmed_at INTEGER,
      created_at INTEGER NOT NULL
    )`,
    // V1.1：新增 context_switch_dumps 表（认知闭合转储）
    `CREATE TABLE IF NOT EXISTS context_switch_dumps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      dumped_at INTEGER NOT NULL,
      source TEXT NOT NULL,
      content TEXT NOT NULL,
      inferred_payload TEXT,
      focuslayer_issue_id TEXT,
      created_at INTEGER NOT NULL
    )`,
    // V1.1：新增 friction_events 表（习惯化对抗引擎）
    `CREATE TABLE IF NOT EXISTS friction_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      form_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      context TEXT NOT NULL DEFAULT '{}',
      recorded_at INTEGER NOT NULL
    )`,
    // V1.1：新增 friction_form_proposals 表（AI 提议摩擦形式，用户审查）
    `CREATE TABLE IF NOT EXISTS friction_form_proposals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      form_id TEXT NOT NULL UNIQUE,
      category TEXT NOT NULL,
      client_action TEXT NOT NULL,
      level TEXT NOT NULL,
      description TEXT NOT NULL,
      ai_rationale TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      proposed_at INTEGER NOT NULL,
      reviewed_at INTEGER
    )`,
    // V1.1 Module 6：替代物库（摩擦转移系统 — 低刺激路径减摩擦）
    `CREATE TABLE IF NOT EXISTS alternative_library (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'other',
      launch_url TEXT,
      preferred_time_slots TEXT NOT NULL DEFAULT '[]',
      effective_count INTEGER NOT NULL DEFAULT 0,
      ineffective_count INTEGER NOT NULL DEFAULT 0,
      priority_score REAL NOT NULL DEFAULT 50.0,
      active INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    // V1.1 Module 6：替代物使用记录（驱动 AI 维护有效性）
    `CREATE TABLE IF NOT EXISTS alternative_usage_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      alternative_id INTEGER NOT NULL,
      trigger_state TEXT NOT NULL,
      severity_level TEXT,
      time_of_day TEXT NOT NULL,
      duration_seconds INTEGER,
      outcome TEXT NOT NULL DEFAULT 'unknown',
      started_at INTEGER NOT NULL
    )`,
    // V1.1 audit-fix：新增 decision_cooldowns 表（冷却持久化）
    `CREATE TABLE IF NOT EXISTS decision_cooldowns (
      key TEXT PRIMARY KEY,
      last_triggered_at INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL DEFAULT 0
    )`,
    // 兼容旧 schema：旧版表使用 decision_key 列名，新版使用 key
   "ALTER TABLE decision_cooldowns RENAME COLUMN decision_key TO key",
   // 兼容旧 schema：旧版表缺少 updated_at 列
   "ALTER TABLE decision_cooldowns ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0",
   // V1.6：notify 指数退避 — 同一插曲内连续触发计数
   "ALTER TABLE decision_cooldowns ADD COLUMN trigger_count INTEGER NOT NULL DEFAULT 0",
    // V1.2：聊天会话（chat_sessions + chat_messages.session_id）
    `CREATE TABLE IF NOT EXISTS chat_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      last_message_at INTEGER NOT NULL,
      opening_message TEXT,
      status TEXT NOT NULL DEFAULT 'active'
    )`,
    `ALTER TABLE chat_messages ADD COLUMN session_id TEXT NOT NULL DEFAULT 'legacy'`,
    `ALTER TABLE chat_sessions ADD COLUMN title TEXT`,
    `CREATE INDEX IF NOT EXISTS idx_chat_messages_session_id ON chat_messages (session_id)`,
    `CREATE INDEX IF NOT EXISTS idx_chat_sessions_last_message_at ON chat_sessions (last_message_at)`,
    // V1.3：新增 app_classifications 表（app 分类管理）
    `CREATE TABLE IF NOT EXISTS app_classifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      package_name TEXT NOT NULL UNIQUE,
      app_name TEXT NOT NULL,
      high_stimulus INTEGER NOT NULL,
      classification_source TEXT NOT NULL,
      ai_raw_response TEXT,
      user_modified INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `ALTER TABLE app_classifications ADD COLUMN version_name TEXT`,
    `ALTER TABLE app_classifications ADD COLUMN category TEXT`,
    `ALTER TABLE app_classifications ADD COLUMN process_name TEXT`,
    `ALTER TABLE app_classifications ADD COLUMN icon_base64 TEXT`,
    // V1.4：新增 site_classifications 表（网站分类管理）
    `CREATE TABLE IF NOT EXISTS site_classifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      domain TEXT NOT NULL UNIQUE,
      site_name TEXT NOT NULL,
      high_stimulus INTEGER NOT NULL,
      classification_source TEXT NOT NULL,
      ai_raw_response TEXT,
      user_modified INTEGER NOT NULL DEFAULT 0,
      url TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `ALTER TABLE site_classifications ADD COLUMN favicon_base64 TEXT`,
    `ALTER TABLE site_classifications DROP COLUMN favicon_url`,
    // V1.5：睡眠状态机可调参数（sunset_config 新增 4 列）
    `ALTER TABLE sunset_config ADD COLUMN sleep_buffer_minutes INTEGER NOT NULL DEFAULT 10`,
    `ALTER TABLE sunset_config ADD COLUMN sleep_confirm_minutes INTEGER NOT NULL DEFAULT 15`,
    `ALTER TABLE sunset_config ADD COLUMN sleep_candidate_idle_minutes INTEGER NOT NULL DEFAULT 15`,
    `ALTER TABLE sunset_config ADD COLUMN sleep_confirm_cooldown_minutes INTEGER NOT NULL DEFAULT 30`,
    `ALTER TABLE sunset_config ADD COLUMN sleep_bright_screen_enabled INTEGER NOT NULL DEFAULT 1`,
    // V1.5：宵禁会话表（追踪宵禁/睡眠状态机）
    `CREATE TABLE IF NOT EXISTS sunset_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL UNIQUE,
      phase TEXT NOT NULL DEFAULT 'winddown',
      sleep_start_reported_at INTEGER,
      sleep_start_at INTEGER,
      last_awake_at INTEGER,
      candidate_started_at INTEGER,
      confirm_requested_at INTEGER,
      cleared_at INTEGER,
      clear_reason TEXT,
      force_release_reason TEXT,
      force_release_count INTEGER NOT NULL DEFAULT 0,
      wake_first_activity_at INTEGER,
      wake_observe_until_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS idx_sunset_sessions_date ON sunset_sessions (date)`,
    // V1.5.1：confirming 来源相位（决定解决后回源 / 广播相位跟随）
    `ALTER TABLE sunset_sessions ADD COLUMN candidate_origin_phase TEXT`,
    // V1.7：分类体系扩展 — site/app 加 is_work（工作向分类），新增 Windows 进程分类表
    `ALTER TABLE site_classifications ADD COLUMN is_work INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE app_classifications ADD COLUMN is_work INTEGER NOT NULL DEFAULT 0`,
    `CREATE TABLE IF NOT EXISTS process_classifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      process_name TEXT NOT NULL UNIQUE,
      display_name TEXT NOT NULL,
      high_stimulus INTEGER NOT NULL,
      is_work INTEGER NOT NULL DEFAULT 0,
      classification_source TEXT NOT NULL,
      ai_raw_response TEXT,
      user_modified INTEGER NOT NULL DEFAULT 0,
      icon_base64 TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )`,
    // 兼容早期已建表的库：补 icon_base64 列（列已存在时由外层 try/catch 吞掉）
    `ALTER TABLE process_classifications ADD COLUMN icon_base64 TEXT`,
    // V1.8：时间轴 — 状态分段持久化
    `CREATE TABLE IF NOT EXISTS state_segments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      state TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      source TEXT NOT NULL DEFAULT 'realtime',
      last_seen_at INTEGER
    )`,
    `CREATE INDEX IF NOT EXISTS idx_state_segments_started_at ON state_segments (started_at)`,
    // V1.9：状态分段存活心跳（僵尸段检测；遗留行 NULL 由 recordStateSegment 首次见到时升级）
    `ALTER TABLE state_segments ADD COLUMN last_seen_at INTEGER`,
    // V1.8：时间轴 — 干预事件日志
    `CREATE TABLE IF NOT EXISTS intervention_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      intervention_id TEXT,
      dispatched_at INTEGER NOT NULL,
      action TEXT NOT NULL,
      level TEXT NOT NULL,
      state TEXT,
      trigger_reason TEXT,
      friction_form_id TEXT,
      result TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_intervention_logs_dispatched_at ON intervention_logs (dispatched_at)`,
    `CREATE INDEX IF NOT EXISTS idx_intervention_logs_intervention_id ON intervention_logs (intervention_id)`,
    // V1.10：分类复核 — 三类分类表加 reviewed（AI 分类完成置 0，人工复核/修改置 1）
    `ALTER TABLE app_classifications ADD COLUMN reviewed INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE site_classifications ADD COLUMN reviewed INTEGER NOT NULL DEFAULT 0`,
    `ALTER TABLE process_classifications ADD COLUMN reviewed INTEGER NOT NULL DEFAULT 0`,
    // V2.0：学校作息配置（单行）—— 上学日白天空白时段的一等语义
    `CREATE TABLE IF NOT EXISTS school_schedule (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      enabled INTEGER NOT NULL DEFAULT 1,
      days_mask INTEGER NOT NULL DEFAULT 31,
      leave_minute INTEGER NOT NULL DEFAULT 420,
      home_minute INTEGER NOT NULL DEFAULT 1050,
      wake_estimate_minute INTEGER NOT NULL DEFAULT 410,
      term_start TEXT,
      term_end TEXT,
      exceptions TEXT NOT NULL DEFAULT '{}',
      updated_at INTEGER NOT NULL
    )`,
    // V1.6：睡眠识别重构 — 起床确认（日期级 wakeup 压制）与离线回溯修正标记
    `ALTER TABLE circadian_logs ADD COLUMN wakeup_confirmed_at INTEGER`,
    `ALTER TABLE circadian_logs ADD COLUMN sleep_reconciled_at INTEGER`,
    // 倒数锚点模式：T-60 等倒数相位的取锚方式（config_hard / adaptive_clamped / adaptive_soft）
    `ALTER TABLE sunset_config ADD COLUMN anchor_mode TEXT NOT NULL DEFAULT 'config_hard'`,
    // 渐进调整（progressive 锚点模式）：理想就寝目标 + 每日步幅
    `ALTER TABLE sunset_config ADD COLUMN ideal_bedtime_minutes INTEGER NOT NULL DEFAULT 1410`,
    `ALTER TABLE sunset_config ADD COLUMN progressive_step_minutes INTEGER NOT NULL DEFAULT 15`,
    // V2.1：起床观察窗相位字段（wake_observing 下首个强活动时刻 + 观察窗到期时刻）
    `ALTER TABLE sunset_sessions ADD COLUMN wake_first_activity_at INTEGER`,
    `ALTER TABLE sunset_sessions ADD COLUMN wake_observe_until_at INTEGER`,
  ]
  for (const sql of migrations) {
    try { sqlite.exec(sql) } catch { /* already exists */ }
  }

  const memoryKeys = ['sleep_pattern', 'dissociation_pattern', 'mood_trend', 'response_to_intervention', 'emotional_signal']
  const insertMemory = sqlite.prepare('INSERT OR IGNORE INTO user_memory (key, value, updated_at) VALUES (?, ?, ?)')
  for (const key of memoryKeys) {
    insertMemory.run(key, '', 0)
  }

  return drizzle(sqlite, { schema })
}

export type Db = ReturnType<typeof createDb>

export function closeDb(db: Db | undefined): void {
  if (!db) return
  // Access the underlying better-sqlite3 instance through drizzle's public-ish API.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(db as any).session?.client?.close()
}
