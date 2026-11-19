import { sqliteTable, text, integer, real } from 'drizzle-orm/sqlite-core'

export const behaviorLogs = sqliteTable('behavior_logs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  source: text('source', { enum: ['desktop', 'chrome', 'vscode', 'android', 'manual', 'web'] }).notNull(),
  event_type: text('event_type').notNull(),
  payload: text('payload', { mode: 'json' }).notNull().$type<Record<string, unknown>>(),
  inferred_state: text('inferred_state', {
    enum: ['working', 'entertaining', 'dissociating', 'resting', 'sleeping', 'transitioning', 'away'],
  }),
  confidence: real('confidence'),
  logged_at: integer('logged_at').notNull(), // Unix seconds
})

export const userLivingContext = sqliteTable('user_living_context', {
  user_id: text('user_id').primaryKey(),
  inferred_state: text('inferred_state').notNull().default('resting'),
  location_zone: text('location_zone').notNull().default('unknown'),
  current_app_window: text('current_app_window'),
  screen_active: integer('screen_active', { mode: 'boolean' }).notNull().default(false),
  device_distance_meters: real('device_distance_meters'),
  focuslayer_sync_enabled: integer('focuslayer_sync_enabled', { mode: 'boolean' }).notNull().default(false),
  focuslayer_server_url: text('focuslayer_server_url'),
  last_focuslayer_query_at: integer('last_focuslayer_query_at'),
  last_focuslayer_response: text('last_focuslayer_response', { mode: 'json' }),
  updated_at: integer('updated_at').notNull(),
  // V1.1 新增：严重度评级（用于严重度评估器）
  severity_level: text('severity_level', {
    enum: ['L0', 'L1', 'L2', 'L3'],
  }).notNull().default('L0'),
  // 严重度最近一次变化时间（24h 下降迟滞的计时基准；updated_at 每 tick 刷新，不能承担此职责）
  severity_changed_at: integer('severity_changed_at'),
})

export const circadianLogs = sqliteTable('circadian_logs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  date: text('date').notNull().unique(), // YYYY-MM-DD
  sleep_start: integer('sleep_start'),
  sleep_end: integer('sleep_end'),
  sleep_debt_hours: real('sleep_debt_hours'),
  meals_count: integer('meals_count').notNull().default(0),
  left_room_count: integer('left_room_count').notNull().default(0),
  sunset_compliance: integer('sunset_compliance'),
  dissociation_risk_score: real('dissociation_risk_score'),
  anchor_ai_summary: text('anchor_ai_summary'),
  // 计划 3 新增：行为分析引擎每日聚合字段（nullable，兼容历史数据）
  deep_work_total_ms: integer('deep_work_total_ms'),
  dissociation_count: integer('dissociation_count'),
  dissociation_total_ms: integer('dissociation_total_ms'),
  intervention_count: integer('intervention_count'),
  intervention_dismiss_rate: real('intervention_dismiss_rate'),
  android_unlock_count: integer('android_unlock_count'),
  peak_work_hour: integer('peak_work_hour'),
  peak_distraction_hour: integer('peak_distraction_hour'),
  // V1.6 睡眠识别重构：日期级 wakeup 确认（enterCurfewByClock 压制依据）与 reconcile 幂等标记
  wakeup_confirmed_at: integer('wakeup_confirmed_at'),
  sleep_reconciled_at: integer('sleep_reconciled_at'),
})

export const sunsetConfig = sqliteTable('sunset_config', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  target_bedtime_minutes: integer('target_bedtime_minutes').notNull().default(90), // 01:30
  phase_t60_enabled: integer('phase_t60_enabled', { mode: 'boolean' }).notNull().default(true),
  phase_t30_enabled: integer('phase_t30_enabled', { mode: 'boolean' }).notNull().default(true),
  phase_t15_enabled: integer('phase_t15_enabled', { mode: 'boolean' }).notNull().default(true),
  phase_t0_enabled: integer('phase_t0_enabled', { mode: 'boolean' }).notNull().default(true),
  // 已废弃：高刺激域名统一由 site_classifications 表管理（/sites 页），列保留仅为兼容旧库
  high_stimulus_sites: text('high_stimulus_sites', { mode: 'json' }).$type<string[]>().notNull().default([]),
  high_stimulus_apps: text('high_stimulus_apps', { mode: 'json' }).$type<string[]>().notNull().default([
    'com.zhiliaoapp.musically', 'com.kuaishou.nebula', 'com.tencent.mm',
    'com.sina.weibo', 'com.bilibili.app.phone', 'tv.danmaku.bili', 'com.ss.android.article.news',
    'com.tencent.ig',
  ]),
  whitelist_processes: text('whitelist_processes', { mode: 'json' }).$type<string[]>().notNull().default([]),
  // 睡眠状态机可调参数
  sleep_buffer_minutes: integer('sleep_buffer_minutes').notNull().default(10), // 最后活动→实际入睡的固定缓冲
  sleep_confirm_minutes: integer('sleep_confirm_minutes').notNull().default(15), // CONFIRM 询问框窗口
  sleep_candidate_idle_minutes: integer('sleep_candidate_idle_minutes').notNull().default(15), // 无白名单活动触发候选的阈值
  sleep_confirm_cooldown_minutes: integer('sleep_confirm_cooldown_minutes').notNull().default(30), // 候选作废/误判后防抖
  // 亮屏睡眠检测：屏幕常亮但无真实交互时，仍触发入睡候选
  sleep_bright_screen_enabled: integer('sleep_bright_screen_enabled', { mode: 'boolean' }).notNull().default(true),
  // 倒数相位锚点模式：config_hard=配置时间硬锚 / adaptive_clamped=学习带与配置取更晚 / adaptive_soft=完全学习 / progressive=渐进托管
  anchor_mode: text('anchor_mode', { enum: ['config_hard', 'adaptive_clamped', 'adaptive_soft', 'progressive'] }).notNull().default('config_hard'),
  // 渐进调整（progressive 模式）：理想就寝 = 最终目标，渐进引擎每日把 target_bedtime 朝它跟随一步
  ideal_bedtime_minutes: integer('ideal_bedtime_minutes').notNull().default(1410), // 23:30
  // 渐进调整步幅（分钟/天），候选点 = 近 7 晚入睡中位数朝 ideal 侧偏移 step
  progressive_step_minutes: integer('progressive_step_minutes').notNull().default(15),
  updated_at: integer('updated_at').notNull(),
})

// 宵禁会话表：每晚一行，追踪宵禁/睡眠状态机（替代易失内存态，重启自愈）
export const sunsetSessions = sqliteTable('sunset_sessions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  date: text('date').notNull().unique(), // YYYY-MM-DD（跨午夜归前一晚）
  phase: text('phase', {
    enum: ['winddown', 'curfew', 'confirming', 'sleeping', 'wake_observing', 'released', 'cleared'],
  }).notNull().default('winddown'),
  sleep_start_reported_at: integer('sleep_start_reported_at'), // 手动点「睡了」的时间
  sleep_start_at: integer('sleep_start_at'), // 服务器结算的实际入睡时间（确认框响应可修正）
  last_awake_at: integer('last_awake_at'), // 用户必然醒着的最后时刻（仅「还没睡」响应推进）
  candidate_started_at: integer('candidate_started_at'), // 当前 CONFIRM 候选起点
  candidate_origin_phase: text('candidate_origin_phase', {
    enum: ['winddown', 'curfee', 'curfew', 'released', 'sleeping'],
  }), // 进入 confirming 前的来源相位（决定确认框解决后回哪里 / 广播相位）
  confirm_requested_at: integer('confirm_requested_at'), // 最近询问框广播时间（冷却）
  cleared_at: integer('cleared_at'), // 解除时间
  clear_reason: text('clear_reason', { enum: ['wakeup', 'wakeup_auto', 'wakeup_cap', 'auto_8h', 'force', 'school_departure'] }),
  // V2.1 起床观察窗：wake_observing 相位下首个强活动时刻（= sleep_end 候选）与观察窗到期
  wake_first_activity_at: integer('wake_first_activity_at'),
  wake_observe_until_at: integer('wake_observe_until_at'),
  force_release_reason: text('force_release_reason'), // 最近一次强制解锁原因
  force_release_count: integer('force_release_count').notNull().default(0),
  created_at: integer('created_at').notNull(),
  updated_at: integer('updated_at').notNull(),
})

export const timeCapsules = sqliteTable('time_capsules', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  content: text('content').notNull(),
  trigger: text('trigger', {
    enum: ['deep_night', 'after_break', 'dissociation', 'wakeup'],
  }).notNull(),
  created_at: integer('created_at').notNull(),
  last_played_at: integer('last_played_at'),
})

export const aiConversationSummaries = sqliteTable('ai_conversation_summaries', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  date_range_start: text('date_range_start').notNull(),
  date_range_end: text('date_range_end').notNull(),
  summary: text('summary').notNull(),
  created_at: integer('created_at').notNull(),
})

export const chatSessions = sqliteTable('chat_sessions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  session_id: text('session_id').notNull().unique(),
  created_at: integer('created_at').notNull(),
  last_message_at: integer('last_message_at').notNull(),
  opening_message: text('opening_message'),
  title: text('title'),
  status: text('status', { enum: ['active', 'archived'] }).notNull().default('active'),
})

export const chatMessages = sqliteTable('chat_messages', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  session_id: text('session_id').notNull().default('legacy'),
  role: text('role', { enum: ['user', 'assistant'] }).notNull(),
  content: text('content').notNull(),
  created_at: integer('created_at').notNull(),
})

export const userMemory = sqliteTable('user_memory', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  key: text('key', {
    enum: ['sleep_pattern', 'dissociation_pattern', 'mood_trend', 'response_to_intervention', 'emotional_signal', 'self_report'],
  }).notNull().unique(),
  value: text('value').notNull().default(''),
  updated_at: integer('updated_at').notNull().default(0),
})

// V1.1 鏂板锛氭瘡鏃ユ剰鍥捐褰曡〃
export const dailyIntentions = sqliteTable('daily_intentions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  date: text('date').notNull(),
  content: text('content').notNull(),
  source: text('source', { enum: ['bedtime', 'wakeup', 'focuslayer', 'system'] }).notNull().default('bedtime'),
  confirmed_at: integer('confirmed_at'),
  created_at: integer('created_at').notNull(),
})

  // V1.1 新增：情绪日记表（移动端 DiaryScreen 使用）
export const moodDiary = sqliteTable('mood_diary', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  triggers: text('triggers', { mode: 'json' }).$type<string[]>().notNull().default([]),
  mood_before: integer('mood_before').notNull(),
  mood_after: integer('mood_after').notNull(),
  note: text('note'),
  created_at: integer('created_at').notNull(),
})

// V1.1 鏂板锛氳鐭ラ棴鍚堣浆鍌ㄨ褰曡〃
export const contextSwitchDumps = sqliteTable('context_switch_dumps', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  dumped_at: integer('dumped_at').notNull(), // Unix seconds
  source: text('source', { enum: ['user_text', 'user_voice', 'system_inferred'] }).notNull(),
  content: text('content').notNull(),
  inferred_payload: text('inferred_payload', { mode: 'json' }).$type<Record<string, unknown>>(),
  focuslayer_issue_id: text('focuslayer_issue_id'),
  created_at: integer('created_at').notNull(),
})

export const dissociationDiary = sqliteTable('dissociation_diary', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  period_start: integer('period_start').notNull(), // Unix seconds
  period_end: integer('period_end').notNull(),
  candidate_label: text('candidate_label').notNull(), // AI-generated description
  user_choice: text('user_choice', {
    enum: ['active_rest', 'attention_break', 'dissociation', 'ignored'],
  }),
  confirmed_at: integer('confirmed_at'),
  created_at: integer('created_at').notNull(),
})

// Generic key-value settings store (first_action, etc.)
export const userSettings = sqliteTable('user_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updated_at: integer('updated_at').notNull(),
})

  // V1.1 新增：摩擦事件记录表（习惯化对抗引擎）
export const frictionEvents = sqliteTable('friction_events', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  form_id: text('form_id').notNull(), // e.g. 'chrome:long_press_3s'
  event_type: text('event_type', { enum: ['triggered', 'bypassed'] }).notNull(),
  context: text('context', { mode: 'json' }).$type<Record<string, unknown>>().notNull().default({}),
  recorded_at: integer('recorded_at').notNull(), // Unix seconds
})

  // V1.1 Module 6：替代物库（摩擦转移系统 — 低刺激路径）
// AI 鍔ㄦ€佺淮鎶わ細璁板綍姣忔鏇夸唬鐗╀娇鐢ㄥ強鏈夋晥鎬э紝椹卞姩浼樺厛绾ф帓搴?
export const alternativeLibrary = sqliteTable('alternative_library', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  // 鏇夸唬鐗╂爣璇嗕笌鍏冩暟鎹?
    name: text('name').notNull(),              // 用户可见名称，如"白噪音"
  category: text('category', {
    enum: ['audio', 'reading', 'movement', 'breathing', 'other'],
  }).notNull().default('other'),
  // 一键直达 URL 或 deep-link（可为空表示无法自动打开）
  launch_url: text('launch_url'),
  // 适用时间段（可为空表示全时段均适用）
  preferred_time_slots: text('preferred_time_slots', { mode: 'json' })
    .$type<Array<'morning' | 'afternoon' | 'evening' | 'deep_night'>>()
    .notNull()
    .default([]),
  // 鏈夋晥鎬х粺璁★紙AI 鎹鏇存柊浼樺厛绾э級
  effective_count: integer('effective_count').notNull().default(0),   // 閫夋嫨鍚庢寔缁?>10min
  ineffective_count: integer('ineffective_count').notNull().default(0), // 閫夋嫨鍚?<2min 閫€鍑?
  // 优先级分（0-100，AI 写入，越高越靠前展示）
  priority_score: real('priority_score').notNull().default(50.0),
  // 杞垹闄?
  active: integer('active', { mode: 'boolean' }).notNull().default(true),
  created_at: integer('created_at').notNull(),
  updated_at: integer('updated_at').notNull(),
})

  // V1.2：聊天会话（chat_sessions + chat_messages.session_id）
export const alternativeUsageLogs = sqliteTable('alternative_usage_logs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  alternative_id: integer('alternative_id').notNull(), // references alternative_library.id
  // 瑙﹀彂涓婁笅鏂?
  trigger_state: text('trigger_state').notNull(), // 'curfew' | 'crash' | 'entertaining' | other
  severity_level: text('severity_level'),          // L0鈥揕3 绛夌骇锛屾潵鑷?user_living_context
  time_of_day: text('time_of_day').notNull(),      // 'morning' | 'afternoon' | 'evening' | 'deep_night'
  // 浣跨敤鏃堕暱锛堢锛夛紝鐢卞鎴风鍦ㄩ€€鍑烘浛浠ｇ墿鏃朵笂鎶?
  duration_seconds: integer('duration_seconds'),
  // 有效性判断（服务器写入，依据 duration_seconds）
  outcome: text('outcome', { enum: ['effective', 'ineffective', 'unknown'] }).notNull().default('unknown'),
  started_at: integer('started_at').notNull(),     // Unix 绉?
})

  // V1.1 新增：决策冷却持久化表（替代内存 lastDecisionAt / lastDispatchedAt）
export const decisionCooldowns = sqliteTable('decision_cooldowns', {
  key: text('key').primaryKey(), // e.g. 'after_break', 'attention_residue', 'dissociation', 'action:xxx'
  last_triggered_at: integer('last_triggered_at').notNull().default(0), // Unix seconds
  updated_at: integer('updated_at').notNull().default(0),
  // 同一插曲内连续触发次数，用于 notify 指数退避（插曲结束或长间隙后归零）
  trigger_count: integer('trigger_count').notNull().default(0),
})

// V1.1 鏂板锛欰I 鎻愯鐨勬懇鎿﹀舰寮忥紙寰呯敤鎴峰鏌ワ級
export const frictionFormProposals = sqliteTable('friction_form_proposals', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  // 鎻愯鐨勬懇鎿﹀舰寮忓厓鏁版嵁
  form_id: text('form_id').notNull().unique(),  // e.g. 'custom:ai_reflect_30s'
  category: text('category', {
    enum: ['entertainment_app_launch', 'curfew_bypass', 'attention_drift'],
  }).notNull(),
  client_action: text('client_action').notNull(), // e.g. 'android:fullscreen_modal'
  level: text('level', { enum: ['notify', 'soft', 'hard', 'strong'] }).notNull(),
  description: text('description').notNull(),     // AI 璇存槑璇ュ舰寮忕殑璁捐鎰忓浘
  ai_rationale: text('ai_rationale').notNull(),   // AI 鍩轰簬鍘嗗彶鏁版嵁缁欏嚭鐨勬帹鑽愮悊鐢?
  // 瀹℃煡鐘舵€?
  status: text('status', { enum: ['pending', 'accepted', 'rejected'] }).notNull().default('pending'),
  proposed_at: integer('proposed_at').notNull(),  // Unix seconds
    reviewed_at: integer('reviewed_at'),            // 用户审查时间
})

// App 分类表（Android app 分类管理）
export const appClassifications = sqliteTable('app_classifications', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  package_name: text('package_name').notNull().unique(),
  app_name: text('app_name').notNull(),
  high_stimulus: integer('high_stimulus', { mode: 'boolean' }).notNull(),
  is_work: integer('is_work', { mode: 'boolean' }).notNull().default(false),
  classification_source: text('classification_source', {
    enum: ['ai', 'user_manual', 'fallback', 'preset', 'pending'],
  }).notNull(),
  ai_raw_response: text('ai_raw_response'),
  user_modified: integer('user_modified', { mode: 'boolean' }).notNull().default(false),
  reviewed: integer('reviewed', { mode: 'boolean' }).notNull().default(false),
  version_name: text('version_name'),
  category: text('category'),
  process_name: text('process_name'),
  icon_base64: text('icon_base64'),
  created_at: integer('created_at').notNull(),
  updated_at: integer('updated_at').notNull(),
})

// 网站分类表（网站分类管理）
export const siteClassifications = sqliteTable('site_classifications', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  domain: text('domain').notNull().unique(),
  site_name: text('site_name').notNull(),
  high_stimulus: integer('high_stimulus', { mode: 'boolean' }).notNull(),
  is_work: integer('is_work', { mode: 'boolean' }).notNull().default(false),
  classification_source: text('classification_source', {
    enum: ['ai', 'user_manual', 'fallback', 'preset', 'pending'],
  }).notNull(),
  ai_raw_response: text('ai_raw_response'),
  user_modified: integer('user_modified', { mode: 'boolean' }).notNull().default(false),
  reviewed: integer('reviewed', { mode: 'boolean' }).notNull().default(false),
  url: text('url'),
  favicon_base64: text('favicon_base64'),
  created_at: integer('created_at').notNull(),
  updated_at: integer('updated_at').notNull(),
})

// Windows 进程分类表（桌面端程序分类管理，与 Android 包属性差异大，独立建表）
export const processClassifications = sqliteTable('process_classifications', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  process_name: text('process_name').notNull().unique(), // 小写归一后的进程名，如 code.exe
  display_name: text('display_name').notNull(),
  high_stimulus: integer('high_stimulus', { mode: 'boolean' }).notNull(),
  is_work: integer('is_work', { mode: 'boolean' }).notNull().default(false),
  classification_source: text('classification_source', {
    enum: ['ai', 'user_manual', 'fallback', 'preset', 'pending'],
  }).notNull(),
  ai_raw_response: text('ai_raw_response'),
  user_modified: integer('user_modified', { mode: 'boolean' }).notNull().default(false),
  reviewed: integer('reviewed', { mode: 'boolean' }).notNull().default(false),
  icon_base64: text('icon_base64'),
  created_at: integer('created_at').notNull(),
  updated_at: integer('updated_at').notNull(),
})

// V2.0：学校作息配置（单行）—— 上学日白天空白时段的一等语义。
// 校时段内完全无设备信号 = 预期空白（away/在校），不是休息也不是睡眠。
export const schoolSchedule = sqliteTable('school_schedule', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  days_mask: integer('days_mask').notNull().default(31), // bit0=周一 … bit6=周日，默认周一~周五
  leave_minute: integer('leave_minute').notNull().default(420), // 07:00 出门（用户时区当天分钟数）
  home_minute: integer('home_minute').notNull().default(1050), // 17:30 到家
  wake_estimate_minute: integer('wake_estimate_minute').notNull().default(410), // 06:50 起床估算（school_departure 结算 sleep_end 用）
  term_start: text('term_start'), // YYYY-MM-DD 学期起，NULL = 不限
  term_end: text('term_end'), // YYYY-MM-DD 学期止，NULL = 不限
  // 单日覆盖：{"2026-10-01":"off"} 请假/节假日，{"2026-09-13":"school"} 调休上学
  exceptions: text('exceptions', { mode: 'json' }).$type<Record<string, 'off' | 'school'>>().notNull().default({}),
  updated_at: integer('updated_at').notNull(),
})

// V1.8：时间轴 — 状态分段持久化（pipeline 实时写 + 回填脚本补历史）
export const stateSegments = sqliteTable('state_segments', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  state: text('state', {
    enum: ['working', 'entertaining', 'dissociating', 'resting', 'sleeping', 'transitioning', 'away'],
  }).notNull(),
  started_at: integer('started_at').notNull(), // Unix seconds
  ended_at: integer('ended_at'), // NULL = 进行中
  source: text('source', { enum: ['realtime', 'backfill'] }).notNull().default('realtime'),
  // 管线存活心跳：recordStateSegment 每次调用刷新（含同状态 no-op）。
  // 心跳凝固超阈值 = 管线暂停/进程死亡，open 段判定僵尸，闭合到最后心跳时刻而非拉长。
  // NULL = 该列上线前的遗留段（首次见到时升级填充，不当场判死，防误斩正常段丢数据）
  last_seen_at: integer('last_seen_at'),
})

// V2.0 阶段 1a：认证与设备配对相关表
// 通用键值存储（本轮用于存 data_key；后续任务写入，本任务只建表）
export const settings = sqliteTable('settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
})
export type Setting = typeof settings.$inferSelect
export type NewSetting = typeof settings.$inferInsert

// 登录凭据（单用户约定：user_id 固定 'default'，单行语义）
export const authCredentials = sqliteTable('auth_credentials', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  user_id: text('user_id').notNull().unique(),
  password_hash: text('password_hash').notNull(),
  // scrypt 参数 JSON，如 {"n":16384,"r":8,"p":1}
  scrypt_params: text('scrypt_params', { mode: 'json' }).notNull().$type<{ n: number; r: number; p: number }>(),
  created_at: integer('created_at').notNull(),
  updated_at: integer('updated_at').notNull(),
})
export type AuthCredential = typeof authCredentials.$inferSelect
export type NewAuthCredential = typeof authCredentials.$inferInsert

// Web 会话（token 以哈希形式存储）
export const sessions = sqliteTable('sessions', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  token_hash: text('token_hash').notNull().unique(),
  created_at: integer('created_at').notNull(),
  expires_at: integer('expires_at').notNull(),
})
export type Session = typeof sessions.$inferSelect
export type NewSession = typeof sessions.$inferInsert

// 已配对设备（客户端 token 以哈希形式存储）
export const devices = sqliteTable('devices', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  token_hash: text('token_hash').notNull().unique(),
  client_version: text('client_version'),
  created_at: integer('created_at').notNull(),
  last_seen_at: integer('last_seen_at'),
  revoked_at: integer('revoked_at'),
})
export type Device = typeof devices.$inferSelect
export type NewDevice = typeof devices.$inferInsert

// 设备配对码（短码明文不落库，只存哈希；attempts 防爆破）
export const pairCodes = sqliteTable('pair_codes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  code_hash: text('code_hash').notNull(),
  expires_at: integer('expires_at').notNull(),
  attempts: integer('attempts').notNull().default(0),
  consumed_at: integer('consumed_at'),
  created_at: integer('created_at').notNull(),
})
export type PairCode = typeof pairCodes.$inferSelect
export type NewPairCode = typeof pairCodes.$inferInsert

// V1.8：时间轴 — 干预事件日志（dispatch 落库，WS 回执回填 result）
export const interventionLogs = sqliteTable('intervention_logs', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  intervention_id: text('intervention_id'), // InterventionPlan.id，回执关联键
  dispatched_at: integer('dispatched_at').notNull(), // Unix seconds
  action: text('action').notNull(),
  level: text('level', { enum: ['notify', 'soft', 'hard', 'strong'] }).notNull(),
  state: text('state'), // 触发时的推断状态
  trigger_reason: text('trigger_reason'), // 规则侧中文理由（非 AI 文案）
  friction_form_id: text('friction_form_id'),
  result: text('result', { enum: ['executed', 'dismissed', 'expired'] }),
})
