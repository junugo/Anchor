import type { BehaviorSource, SunsetConfig, UserState, LocationZone, SunsetClearReason } from './models'
import type { InferenceResult, InterventionAction, InterventionLevel } from './inference'

// 服务器→客户端推送的指令
export type WsServerMessage =
  | { type: 'sunset:phase'; phase: 'T60' | 'T30' | 'T15' | 'T0' | 'off'; expires_at?: number; bedtime_at?: number }
  | { type: 'sunset:stage'; stage: 'T60' | 'T30' | 'T15' | 'T0' | 'off'; received_at: number; expires_at: number; target_bedtime_minutes: number; bedtime_at: number; sleep_started_at?: number; clear_reason?: SunsetClearReason }
  | { type: 'sunset:config'; config: SunsetConfig }
  // 睡眠状态机：入睡确认框（服务器怀疑用户已睡着，仅「还没睡」选项；无响应=睡着）
  | { type: 'sleep:confirm-request'; since: number; confirm_until: number }
  | { type: 'sleep:confirm-cancel'; reason: string }
  // 起床观察窗：首个强活动触发，广播可选「我醒了」快捷确认；观察窗内第二个强活动自动裁决
  | { type: 'wakeup:confirm-request'; since: number; observe_until: number }
  | { type: 'wakeup:confirm-cancel'; reason: string }
  | { type: 'app:classification'; package_name: string; app_name: string; high_stimulus: boolean; source: 'server_ai' | 'fallback' }
  | { type: 'app:classification_updated'; package_name: string; app_name?: string; high_stimulus: boolean; is_work?: boolean; source?: string }
  | { type: 'app:classification_deleted'; package_name: string }
  | { type: 'app:classification_reviewed'; package_names: string[] }
  // 高刺激网站分类（镜像 app 分类机制）
  | { type: 'site:classification_updated'; domain: string; site_name?: string; high_stimulus: boolean; is_work?: boolean; source?: string }
  | { type: 'site:classification_deleted'; domain: string }
  | { type: 'site:classification_reviewed'; domains: string[] }
  // Windows 进程分类（桌面端程序，与 Android 包分表管理）
  | { type: 'process:classification_updated'; process_name: string; display_name?: string; high_stimulus: boolean; is_work?: boolean; source?: string }
  | { type: 'process:classification_deleted'; process_name: string }
  | { type: 'process:classification_reviewed'; process_names: string[] }
  | { type: 'env:switch'; zone: LocationZone; screen_color_temp: number }
  | { type: 'notify:ai'; message: string; actions?: Array<{ label: string; id: string }> }
  | { type: 'time:anchor'; text: string } // 时间锚注入
  | { type: 'state:update'; state: UserState; confidence: number }
  | { type: 'dev:signal'; source: string; event_type: string; payload: Record<string, unknown>; logged_at: number }
  // 开发者页面：每次 pipeline tick 后广播完整推断结果（含四候选得分）
  | { type: 'dev:inference'; mode: 'full' | 'lightweight'; result: InferenceResult; at: number }
  // 开发者页面：干预计划实际分发时广播
  | { type: 'dev:decision'; action: string; level: InterventionLevel; message: string; at: number }
  | { type: 'ping' }
  | { type: 'error'; code: 'DECRYPT_FAILED'; message: string }
  | { type: 'capsule:play'; content: string; trigger: string }
  | { type: 'wakeup:alarm' }
  | { type: 'behavior:suggestion'; suggestion: string }
  | { type: 'ai:response'; response: string }
  | { type: 'intervention'; level: InterventionLevel; message: string; intervention_id?: string; action?: InterventionAction; expires_at?: number; context?: { detected_app?: string; server_state?: string }; frictionFormId?: string }
  // V1.1 意图锚点层：宵禁 T-30 触发意图采集（先到先赢，镜像 context_switch）
  | { type: 'intent:capture'; prompt_id: string; timeoutSeconds: number; prompt: string; is_degraded: boolean; focuslayer_hint?: string }
  // V1.1 意图锚点层：起床确认展示昨日意图
  | { type: 'intent:confirm'; date: string; content: string }
  // 任一端提交/跳过/超时或服务器兜底到期后，广播关闭所有客户端的意图弹窗
  // reason=answered 时全端清除重开入口（当夜已完成）；skipped/expired 仅关弹窗，保留重开入口
  | { type: 'intent:dismiss'; prompt_id?: string; reason: 'answered' | 'skipped' | 'expired' }
  // V1.1 认知闭合层：工作→非工作状态转换时触发用户输入提示
  | { type: 'context_switch:prompt'; prompt_id: string; timeoutSeconds: number; placeholder: string }
  // 任一端响应（提交/跳过/超时）或服务器兜底到期后，广播关闭所有客户端的弹窗
  | { type: 'context_switch:dismiss'; prompt_id: string; reason: 'answered' | 'skipped' | 'expired' }
  // 已有客户端开始输入（接管）：其他端收到后关闭弹窗；接管后 prompt 不再过期，提交/跳过永远有效
  | { type: 'intent:typing'; prompt_id: string }
  | { type: 'context_switch:typing'; prompt_id: string }
  // WS 认证门：设备 token 校验结果（认证失败随后 close 4401；超时未认证 close 4408）
  | { type: 'auth_ok'; deviceId: number }
  | { type: 'auth_failed' }

// 客户端→服务器上报
export type WsClientMessage =
  | { type: 'ingest'; source: string; event_type: string; payload: Record<string, unknown>; location_zone?: LocationZone; logged_at?: number }
  | { type: 'action:response'; action_id: string; choice: string }
  | { type: 'wakeup:verified' } // 起床物理验证完成
  | { type: 'pong' }
  | { type: 'ai:message'; content: string; conversation_id: string }
  // @legacy — 旧客户端回报路径：level 仅覆盖 soft/strong，不同于 notify/hard；新客户端应改用 intervention_result
  | { type: 'intervention:response'; level: 'soft' | 'strong'; choice: 'accepted' | 'rejected'; detected_app?: string }
  | { type: 'intervention_result'; source: BehaviorSource; intervention_id: string; action: InterventionAction; result: 'executed' | 'dismissed' | 'expired'; dismissed_by_user: boolean; dismissed_after_ms?: number }
  // V1.1 意图锚点层：客户端提交确认意图（prompt_id 用于匹配活跃捕获，先到先赢）
  | { type: 'intent:submit'; content: string; source?: 'bedtime' | 'wakeup' | 'focuslayer' | 'system'; date?: string; prompt_id?: string }
  | { type: 'intent:confirm'; date: string }
  // 意图采集弹窗响应：跳过/超时，先到先赢，服务器广播 dismiss 关闭其余客户端弹窗
  | { type: 'intent:capture-response'; prompt_id: string; action: 'skip' | 'auto_skip' }
  // 客户端触发宵禁破戒事件
  | { type: 'sunset:breach'; reason?: string }
  // 客户端强制解除宵禁（临时放行，需原因）
  | { type: 'sunset:release'; reason: string }
  // 入睡确认框响应（仅有「还没睡」选项，confirmed 恒为 false）
  | { type: 'sleep:confirm-response'; confirmed: boolean }
  // 起床观察窗响应：confirmed=true 立即解除（等价手动验证）；false 仅关闭弹窗，不影响自动裁决
  | { type: 'wakeup:confirm-response'; confirmed: boolean }
  // 状态切换弹窗响应：先到先赢，服务器广播 dismiss 关闭其余客户端弹窗
  | { type: 'context_switch:response'; prompt_id: string; action: 'submit' | 'skip' | 'auto_skip'; text?: string; source?: BehaviorSource }
  // 弹窗开始输入（接管）：客户端首次输入时上报一次；服务器清除过期定时器并广播 typing
  | { type: 'intent:input'; prompt_id: string }
  | { type: 'context_switch:input'; prompt_id: string }
  | { type: 'app:classify'; package_name: string; app_name?: string }
  | { type: 'app:update_classification'; package_name: string; high_stimulus?: boolean; is_work?: boolean }
  | { type: 'app:delete_classification'; package_name: string }
  // 高刺激网站分类（镜像 app 分类机制）
  | { type: 'site:update_classification'; domain: string; high_stimulus?: boolean; is_work?: boolean }
  | { type: 'site:delete_classification'; domain: string }
  // Windows 进程分类
  | { type: 'process:update_classification'; process_name: string; high_stimulus?: boolean; is_work?: boolean }
  | { type: 'process:delete_classification'; process_name: string }

  // WS 认证门：连接后首个必须消息（明文，控制消息不走加密信封）
  | { type: 'auth'; token: string }

