// ─── 行为数据源 ───────────────────────────────────────────────
export type BehaviorSource = 'desktop' | 'chrome' | 'vscode' | 'android' | 'manual' | 'web'

export type BehaviorEventType =
  | 'window_focus'
  // desktop 进入新窗口即报 + 驻留 45s 心跳（客户端保证非空闲才发）
  | 'window_active'
  | 'url_visit'
  | 'code_active'
  | 'app_open'
  | 'screen_on'
  | 'screen_off'
  | 'device_distance'
  | 'key_activity'
  | 'screen_lock'
  | 'screen_unlock'
  | 'action_response'
  | 'app_foreground'
  | 'app_usage_snapshot'
  | 'intervention_response'
  | 'intervention_result'
  // 推断引擎扩展事件类型
  | 'video_state'
  | 'tab_switch'
  | 'tab_explosion'
  | 'microphone_active'
  | 'camera_active'
  | 'physical_activity'
  | 'do_not_disturb'
  | 'git_commit'
  | 'terminal_active'
  | 'user_idle'
  | 'user_active'
  | 'editor_idle'
  | 'app_category_snapshot'
  | 'battery_charging'
  // V1.1 新增：移动端主动触发宵禁破戒
  | 'curfew_breach'
  // 状态切换弹窗响应（注意力残留：提交/跳过/自动跳过的文本与来源）
  | 'context_switch_response'

export interface BehaviorLog {
  id: number
  source: BehaviorSource
  event_type: BehaviorEventType
  payload: Record<string, unknown>
  inferred_state: UserState | null
  confidence: number | null
  logged_at: number // Unix timestamp (seconds)
}

// ─── 严重程度评级（DB 存储层）──────────────────────────────────
// 注意：AI 角色卡使用的 L0–L3 级别定义在 apps/web/lib/ai/roleCard.ts
// 两者通过 dbSeverityToLevel() 映射函数关联
export type DbSeverityLevel = 'L0' | 'L1' | 'L2' | 'L3'

// ─── 用户推断状态 ──────────────────────────────────────────────
export type UserState = 'working' | 'entertaining' | 'dissociating' | 'resting' | 'sleeping' | 'transitioning' | 'away'
export type LocationZone = 'desk' | 'sofa' | 'bed' | 'transition' | 'unknown'

export interface UserLivingContext {
  inferred_state: UserState
  location_zone: LocationZone
  current_app_window: string | null // 脱敏后的进程名/域名
  screen_active: boolean
  device_distance_meters: number | null
  focuslayer_sync_enabled: boolean
  focuslayer_server_url: string | null
  last_focuslayer_query_at: number | null
  last_focuslayer_response: FocusLayerStatusResponse | null
  updated_at: number
  severity_level: DbSeverityLevel // V1.1 新增：严重程度评级
}

// ─── 生活节律 ─────────────────────────────────────────────────
export interface CircadianLog {
  id: number
  date: string // YYYY-MM-DD
  sleep_start: number | null
  sleep_end: number | null
  sleep_debt_hours: number | null
  meals_count: number
  left_room_count: number
  sunset_compliance: number | null
  dissociation_risk_score: number | null // 0–10
  anchor_ai_summary: string | null
  // 计划 3 行为分析引擎每日聚合字段（nullable，兼容历史行）
  deep_work_total_ms: number | null
  dissociation_count: number | null
  dissociation_total_ms: number | null
  intervention_count: number | null
  intervention_dismiss_rate: number | null
  android_unlock_count: number | null
  peak_work_hour: number | null
  peak_distraction_hour: number | null
}

// ─── 每日总结时间线（移动端 SummaryScreen 使用）──────────────────────
export interface TimelineBlock {
  start_time: number // Unix seconds
  end_time: number
  state: UserState
}

export interface DailySummary {
  timeline: TimelineBlock[]
  ai_summary: string
  suggested_bedtime: string | null
  generated_at: number
}

// ─── 宵禁配置 ─────────────────────────────────────────────────
/**
 * 倒数相位锚点模式：
 * - config_hard：T-60/T30/T15/T0 一律从配置时间倒数，学习带不影响倒数相位
 * - adaptive_clamped：锚 = 学习带起点与配置时间取更晚（环形比较），学习可推迟、配置保证不提前
 * - adaptive_soft：完全以学习带起点为锚，配置时间不参与倒数计算
 * - progressive：渐进托管——target_bedtime_minutes 由渐进引擎每日朝 ideal_bedtime_minutes 跟随一步
 *   （倒数时等价 config_hard 读当前托管锚点；学习带仍只服务被动入睡探测，不吃钳制）
 */
export type SunsetAnchorMode = 'config_hard' | 'adaptive_clamped' | 'adaptive_soft' | 'progressive'

export interface SunsetConfig {
  enabled: boolean
  target_bedtime_minutes: number // 从午夜起的分钟数，如 90 = 01:30；progressive 模式下为托管锚点
  anchor_mode: SunsetAnchorMode // 倒数相位锚点模式（默认 config_hard）
  /** 渐进调整目标（分钟）：progressive 模式下锚点每日朝它跟随一步，永不超过它 */
  ideal_bedtime_minutes: number // 默认 1410 = 23:30
  /** 渐进步幅（分钟/天）：候选锚点 = 近 7 晚入睡中位数朝 ideal 侧偏移 step */
  progressive_step_minutes: number // 默认 15
  phase_t60_enabled: boolean // T-60: 灰度 + 静默通知
  phase_t30_enabled: boolean // T-30: 应用摩擦
  phase_t15_enabled: boolean // T-15: 高刺激应用/网站硬拦截
  phase_t0_enabled: boolean  // T-0: 硬宵禁
  /** @deprecated 高刺激域名统一由 site_classifications 表管理（/sites 页），此字段不再使用 */
  high_stimulus_sites?: string[]
  whitelist_processes: string[]  // 白名单进程
  high_stimulus_apps: string[]
  // 睡眠状态机可调参数
  sleep_buffer_minutes: number // 最后活动→实际入睡的固定缓冲
  sleep_confirm_minutes: number // CONFIRM 询问框窗口
  sleep_candidate_idle_minutes: number // 无白名单活动触发候选的阈值
  sleep_confirm_cooldown_minutes: number // 候选作废/误判后防抖
  /** 亮屏睡眠检测：屏幕常亮但无真实交互时，仍触发入睡候选 */
  sleep_bright_screen_enabled: boolean
  updated_at: number
}

// ─── 学校作息配置 ─────────────────────────────────────────────
// 上学日白天空白时段的一等语义：校时段内无设备信号 = away（在校）
export interface SchoolScheduleConfig {
  enabled: boolean
  /** bit0=周一 … bit6=周日（默认 31 = 周一~周五） */
  days_mask: number
  /** 出门时刻（用户时区当天分钟数，默认 420 = 07:00） */
  leave_minute: number
  /** 到家时刻（默认 1050 = 17:30） */
  home_minute: number
  /** 起床估算时刻（默认 410 = 06:50；school_departure 结算 sleep_end 用） */
  wake_estimate_minute: number
  /** 学期起止（YYYY-MM-DD，null = 不限） */
  term_start: string | null
  term_end: string | null
  /** 单日覆盖：{"2026-10-01":"off"} 请假，{"2026-09-13":"school"} 调休上学 */
  exceptions: Record<string, 'off' | 'school'>
  updated_at: number
}

// ─── 宵禁会话（睡眠状态机） ─────────────────────────────────────
export type SunsetSessionPhase = 'winddown' | 'curfew' | 'confirming' | 'sleeping' | 'wake_observing' | 'released' | 'cleared'
export type SunsetClearReason = 'wakeup' | 'wakeup_auto' | 'wakeup_cap' | 'auto_8h' | 'force' | 'school_departure'
export type SunsetCandidateOrigin = 'winddown' | 'curfee' | 'curfew' | 'released' | 'sleeping'
export interface SunsetSession {
  id: number
  date: string
  phase: SunsetSessionPhase
  sleep_start_reported_at: number | null
  sleep_start_at: number | null
  last_awake_at: number | null
  candidate_started_at: number | null
  candidate_origin_phase: SunsetCandidateOrigin | null
  confirm_requested_at: number | null
  cleared_at: number | null
  clear_reason: SunsetClearReason | null
  force_release_reason: string | null
  force_release_count: number
  /** wake_observing 相位：首个强活动时刻（= sleep_end 候选） */
  wake_first_activity_at: number | null
  /** wake_observing 相位：观察窗到期时刻（窗内第二个强活动 → 判定起床） */
  wake_observe_until_at: number | null
  created_at: number
  updated_at: number
}

// ─── 时间胶囊 ─────────────────────────────────────────────────
export type TimeCapsuleTrigger = 'deep_night' | 'after_break' | 'dissociation' | 'wakeup'

export interface TimeCapsule {
  id: number
  content: string
  trigger: TimeCapsuleTrigger
  created_at: number
  last_played_at: number | null
}

// ─── AI 对话摘要 ──────────────────────────────────────────────
export interface AiConversationSummary {
  id: number
  date_range_start: string
  date_range_end: string
  summary: string
  created_at: number
}

export interface ChatMessage {
  id: number
  role: 'user' | 'assistant'
  content: string
  created_at: number
}

export interface ChatSession {
  id: number
  session_id: string
  created_at: number
  last_message_at: number
  opening_message: string | null
  title: string | null
  preview?: string | null
}

export type UserMemoryKey = 'sleep_pattern' | 'dissociation_pattern' | 'mood_trend' | 'response_to_intervention' | 'emotional_signal' | 'self_report'

export interface UserMemory {
  id: number
  key: UserMemoryKey
  value: string
  updated_at: number
}

// ─── V1.1 每日意图 ─────────────────────────────────────────────
export interface DailyIntention {
  id: number
  date: string
  content: string
  source: 'bedtime' | 'wakeup' | 'focuslayer' | 'system'
  confirmed_at?: number
  created_at: number
}

// ─── FocusLayer 联动类型 ───────────────────────────────────────
export type FocusMode = 'idle' | 'shallow' | 'deep' | 'interrupted'
export type PreferredContact = 'silent' | 'toast' | 'none'

export interface FocusLayerStatusResponse {
  user_id: string
  timestamp: number
  focus_context: {
    mode: FocusMode
    active_issue: {
      id: number
      title: string
      project_id: number
      project_title: string
      tech_stack: string
      elapsed_minutes: number
    } | null
    wip_status: {
      global_current: number
      global_limit: number
    }
    attention_debt_today: number
    can_interrupt: boolean
    preferred_contact: PreferredContact
  }
  anchor_sync_enabled: boolean
}

export interface FocusLayerConfirmRequest {
  user_id: string
  anchor_detected: {
    source: BehaviorSource
    activity: string
    project_hint: string | null
    duration_minutes: number
    confidence: number
  }
  suggested_issue_id: number | null
}

export interface FocusLayerConfirmResponse {
  confirmed: boolean
  suggested_actions: Array<{
    type: 'create_issue' | 'link_to_project'
    message: string
    project_id?: number
  }>
  focuslayer_url: string | null
}

export interface AnchorSyncOutPayload {
  circadian: {
    sleep_debt_hours: number
    rhythm_deviation_hours: number
    dissociation_risk: number
    last_sleep_start: number | null
  }
  environment: {
    current_zone: LocationZone
    current_mode: UserState
  }
}
