import type { BehaviorSource, BehaviorEventType, UserState, DbSeverityLevel } from './models'

// 推断引擎的统一日志条目（logged_at 单位：秒）
// 复用 BehaviorSource / BehaviorEventType 保持与 BehaviorLog 的类型约束一致
export interface LogEntry {
  source: BehaviorSource
  event_type: BehaviorEventType
  payload: Record<string, unknown>
  logged_at: number // Unix 时间戳（秒）
}

// Stage 1 输出：结构化特征快照
export interface FeatureSnapshot {
  window_start: number // unix 秒
  window_end: number   // unix 秒
  is_lightweight: boolean

  // 活跃信号
  code_active_count: number
  recent_code_active_count?: number
  latest_code_active_at?: number | null
  latest_activity_at?: number | null
  latest_work_signal_age_s?: number | null
  latest_entertainment_signal_age_s?: number | null
  deep_work_duration_ms: number
  work_momentum_score: number // 0-1
  // 工作信号（多源：VS Code code_active + Windows 工作进程 + 工作网站 + Android 工作 App）
  work_app_duration_ms: number      // 窗口内 Windows 工作进程前台总时长
  work_visit_count: number          // 窗口内工作网站访问次数
  android_in_work_app: boolean      // Android 工作 App 是否在前台

  // 分心信号
  high_stimulus_visit_count: number
  entertainment_depth_score: number    // 0-1
  attention_fragmentation_score: number // 0-1
  tab_explosion: boolean

  // 跨端信号
  android_unlock_rate: number // 次/小时
  // 此刻正在娱乐 App 中：最新前台为高刺激包，且事件新鲜（≤30s 心跳）、晚于最近息屏
  // 「打开娱乐软件即娱乐中」的当下性谓词，客户端 15s 心跳维持
  android_fun_app_current: boolean
  latest_android_app_at?: number | null
  android_physical_activity: 'still' | 'walking' | 'running' | 'unknown'

  // 静默信号
  do_not_disturb: boolean
  is_idle: boolean

  // 原始计数
  event_counts: Record<string, number>
  // 使用 BehaviorSource 类型，排除仅用于手动/内部写入的来源
  active_sources: Array<Exclude<BehaviorSource, 'manual' | 'web'>>
}

// Stage 1 配置参数（配置对象惯用 camelCase，与 FeatureSnapshot 的 snake_case 字段名有意区分）
export interface ExtractorConfig {
  highStimulusDomains: string[]
  highStimulusApps: string[]
  devToolProcesses: string[]
  workDomains: string[]    // site_classifications.is_work
  workApps: string[]       // app_classifications.is_work（Android 包名）
  workProcesses: string[]  // process_classifications.is_work（Windows 进程名，小写）
}

// Stage 2 长期记忆注入（计划 3 填充真实值）
// 扁平结构（禁止嵌套分层），字段名采用 camelCase
export interface InferenceMemory {
  highRiskHours: number[]       // 历史高风险时段 0-23
  onboardingDays: number        // 已运行天数，决定加成权重
  // 可选扩展字段——计划 3 的 weekly-analyzer / memory-loader 负责填充
  dissociationRising?: boolean
  highDismissal?: boolean
  avgDismissRate?: number
  typicalSleepMinutes?: number | null
}

// Stage 2 输出
// 单个候选状态的评分结果（供开发者页面展示完整推断过程）
export interface InferenceCandidate {
  state: UserState
  score: number
  confidence: number
  evidence: string[]
}

export interface InferenceResult {
  state: UserState
  confidence: number
  evidence: string[]
  previous_state: UserState
  state_changed: boolean
  do_not_disturb: boolean
  needs_ai_arbitration: boolean // confidence < 0.6 或两状态得分差 < 0.15
  snapshot: FeatureSnapshot
  // 四候选状态评分明细（按得分降序），供开发者页面展示推断过程
  candidates?: InferenceCandidate[]
  // 严重度评估结果（可选，由 severity-assessor 填充）
  severity?: DbSeverityLevel | null
  severity_evidence?: string[]
}

// 'strong' 为习惯化升级链顶端的保留级别（LEVEL_ESCALATION: hard → strong）
export type InterventionLevel = 'notify' | 'soft' | 'hard' | 'strong'

export type InterventionTarget = 'desktop' | 'chrome' | 'android'

// 干预动作 key（规格 3.5 动作库）
export type InterventionAction =
  | 'desktop:toast_notify'
  | 'desktop:topmost_window'
  | 'desktop:force_lock'
  | 'chrome:friction_banner'
  | 'chrome:grayscale'
  | 'chrome:hard_block'
  | 'chrome:tab_collapse'
  | 'android:push_notify'
  | 'android:fullscreen_modal'
  | 'android:fullscreen_block'
  | 'android:app_usage_alert'

export interface InterventionPlan {
  id: string
  type: InterventionLevel
  targets: InterventionTarget[]
  action: InterventionAction
  message?: string
  reason?: string // 规则侧触发理由（中文短语，时间轴事件流水展示）
  expires_at: number // unix 秒
  frictionFormId?: string // 决定客户端使用哪种摩擦形式，由习惯化引擎填充
}

export interface InterventionResultPayload {
  intervention_id: string
  action: InterventionAction
  result: 'executed' | 'dismissed' | 'expired'
  dismissed_by_user: boolean
  dismissed_after_ms?: number
}

// 计划 3 Layer 1：当日内存聚合器（每 tick 累加，重启后从 behavior_logs 重建）
export interface DailyContext {
  date: string
  deep_work_total_ms: number
  work_session_count: number
  longest_deep_work_ms: number
  dissociation_count: number
  dissociation_total_ms: number
  first_dissociation_time?: number
  interventions_triggered: number
  interventions_dismissed: number
  interventions_effective: number
  android_unlock_count: number
  android_screen_on_total_ms: number
  // 小时直方图，用于 peak_work_hour / peak_distraction_hour（24 槽）
  work_by_hour: number[]
  distraction_by_hour: number[]
}
