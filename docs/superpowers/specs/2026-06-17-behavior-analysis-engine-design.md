# 用户行为分析引擎设计规格

**版本**：1.0  
**日期**：2026-06-17  
**状态**：已批准，待实现

---

## 1. 概述

本规格定义 Anchor 跨端用户行为分析引擎的完整设计。引擎从 Desktop、Chrome、VSCode、Android 四端采集行为信号，经由四阶段管线推断用户状态，结合长期建模与 AI 深度集成，向各端分发精准干预指令。

### 设计目标

- 秒级响应关键分心信号（不等待 tick）
- 推断、决策、记忆三层完全解耦
- 干预随时间学习用户个人模式
- AI 辅助模糊判断与个性化文案

### 不在范围内

- FocusLayer 集成（后续迭代）
- iOS 支持（Android only）
- 多用户（单用户 `user_id = 'default'`）

---

## 2. 标准化事件 Schema

### 2.1 标准事件信封

所有端上报统一格式：

```typescript
interface BehaviorEvent {
  source: 'desktop' | 'chrome' | 'vscode' | 'android' | 'web'
  event_type: EventType
  session_id: string       // 客户端本次启动的 uuid
  client_ts: number        // 客户端时间戳（unix ms），用于检测时钟漂移
  payload: EventPayload
}
```

### 2.2 Desktop 事件

| event_type | payload | 说明 |
|---|---|---|
| `window_focus` | `{ process_name, window_title, duration_ms, is_idle }` | 补充 title 和前一窗口停留时长 |
| `user_idle` | `{ idle_seconds }` | 鼠标键盘无操作超 5 分钟触发 |
| `user_active` | `{ idle_was_seconds }` | 从 idle 恢复时触发 |
| `microphone_active` | `{ is_active, app_name }` | 麦克风状态变化 |
| `camera_active` | `{ is_active, app_name }` | 摄像头状态变化 |

### 2.3 Chrome 事件

| event_type | payload | 说明 |
|---|---|---|
| `url_visit` | `{ url, domain, title, duration_ms, high_stimulus, tab_count, scroll_depth_pct, video_playing }` | 修复：补充 `url` 字段（原 bug：payload 只有 domain，导致 isEntertaining() 规则失效） |
| `tab_switch` | `{ from_domain, to_domain, switch_interval_ms }` | 新增：快速跳 tab 专用信号 |
| `tab_explosion` | `{ tab_count, new_tabs_in_last_5min }` | 新增：短时间大量开 tab |
| `video_state` | `{ domain, state: 'play'｜'pause'｜'ended', duration_watched_sec }` | 新增：精确判断娱乐深度 |

### 2.4 VSCode 事件

| event_type | payload | 说明 |
|---|---|---|
| `code_active` | `{ event: 'file_save'｜'keystroke_summary'｜'debug_start'｜'debug_end', count?, language?, workspace_name, files_open_count, lines_added? }` | 扩展 payload |
| `editor_idle` | `{ idle_seconds }` | 新增：文件打开但无按键超 10 分钟 |
| `terminal_active` | `{ command_category: 'build'｜'git'｜'run'｜'other' }` | 新增 |
| `git_commit` | `{ files_changed, insertions, deletions }` | 新增：工作节点信号 |

### 2.5 Android 事件

| event_type | payload | 说明 |
|---|---|---|
| `screen_on` | `{ timestamp, unlock_count_today }` | 补充 unlock_count_today |
| `screen_off` | `{ timestamp }` | 不变 |
| `screen_unlock` | `{ timestamp, unlock_count_today }` | 补全实现（类型已定义） |
| `app_foreground` | `{ packageName, appName }` | 不变 |
| `app_usage_snapshot` | `{ apps: [...], window_start, window_end }` | 不变 |
| `app_category_snapshot` | `{ categories: { social, video, work, game }, total_screen_min }` | 新增：按类别统计 |
| `battery_charging` | `{ is_charging, level_pct }` | 新增：充电+亮屏=长时间固定使用 |
| `physical_activity` | `{ step_count_delta, activity_type: 'still'｜'walking'｜'running' }` | 新增：走动=休息中 |
| `do_not_disturb` | `{ enabled }` | 新增：用户主动开勿扰 |

### 2.6 服务端合成特征

特征提取阶段生成，不由客户端上报：

| 特征 | 计算方式 |
|---|---|
| `context_split_score` | desktop 工作进程活跃 + android 同时高刺激 App 活跃，0-1 |
| `attention_fragmentation_score` | tab_switch + window_focus 切换频率，0-1 |
| `deep_work_duration_ms` | 连续 code_active 且无 url_visit/app_foreground 的时长 |
| `do_not_disturb_composite` | `microphone_active ｜ camera_active ｜ android.do_not_disturb` |
| `entertainment_depth_score` | video_state 时长 + scroll_depth + tab_count 综合，0-1 |
| `work_momentum_score` | git_commit + terminal_active + keystroke_summary 综合，0-1 |

---

## 3. 四阶段管线

### 3.1 整体架构

```
原始事件入库 (behavior_logs)
        │
        ▼
┌─────────────────────┐
│  Stage 1            │
│  FeatureExtractor   │  原始事件 → FeatureSnapshot
└──────────┬──────────┘
           ▼
┌─────────────────────┐
│  Stage 2            │
│  StateInferrer      │  特征 + 长期记忆 → InferenceResult
└──────────┬──────────┘
           ▼
┌─────────────────────┐
│  Stage 3            │
│  InterventionPlanner│  状态 + 冷却 + 规则 → InterventionPlan[]
└──────────┬──────────┘
           ▼
┌─────────────────────┐
│  Stage 4            │
│  ActionDispatcher   │  指令 → 各端 WebSocket，记录结果
└─────────────────────┘
```

### 3.2 Stage 1 — FeatureExtractor

**职责**：把过去 N 分钟 `behavior_logs` 压缩为结构化 `FeatureSnapshot`，后续阶段只读此快照。

**两种提取窗口**：
- 轻量窗口（1 分钟 tick）：过去 10 分钟
- 完整窗口（5 分钟 tick）：过去 2 小时

```typescript
interface FeatureSnapshot {
  window_start: number
  window_end: number
  is_lightweight: boolean

  code_active_count: number
  deep_work_duration_ms: number
  work_momentum_score: number

  high_stimulus_visit_count: number
  entertainment_depth_score: number
  attention_fragmentation_score: number
  tab_explosion: boolean

  context_split_score: number
  android_unlock_rate: number          // 次/小时
  android_in_high_stimulus_app: boolean
  android_physical_activity: 'still' | 'walking' | 'running' | 'unknown'

  do_not_disturb: boolean
  is_idle: boolean

  event_counts: Record<string, number>
  active_sources: Set<'desktop' | 'chrome' | 'vscode' | 'android'>
}
```

### 3.3 Stage 2 — StateInferrer

**职责**：FeatureSnapshot + 长期记忆 → 状态 + 置信度 + 证据链。

**状态优先级**（高到低）：`dissociating > working > entertaining > resting > transitioning`

| 状态 | 触发条件 | 基础置信度 |
|---|---|---|
| `dissociating` | `context_split_score > 0.7` 或 `android_unlock_rate >= 15` 或 `attention_fragmentation_score > 0.8` 且 `code_active_count == 0` | 0.85–0.95 |
| `working` | `code_active_count >= 3` 或 `deep_work_duration_ms > 300_000` 或 `work_momentum_score > 0.6` | 0.90 |
| `entertaining` | `entertainment_depth_score > 0.5` 或（`high_stimulus_visit_count >= 2` 且 `code_active_count == 0`） | 0.90 |
| `resting` | `is_idle` 且 `physical_activity != 'still'`，或过去 30 分钟无任何事件 | 0.85 |
| `transitioning` | 兜底 | 0.50 |

**长期记忆注入**：
- 当前时段匹配 `dissociation_pattern.high_risk_hours` → 置信度 +0.1
- `confidence < 0.6` 或两状态得分差 < 0.15 → 触发 AI 仲裁器

```typescript
interface InferenceResult {
  state: UserState
  confidence: number
  evidence: string[]
  previous_state: UserState
  state_changed: boolean
  do_not_disturb: boolean
  snapshot: FeatureSnapshot
}
```

### 3.4 Stage 3 — InterventionPlanner

**职责**：InferenceResult → 零个或多个 InterventionPlan，干预逻辑与推断完全分离。

**干预级别**：

| 级别 | 用户可关闭 | 冷却时间 | do_not_disturb 时 |
|---|---|---|---|
| `notify` | 是，立即 | 5 分钟 | 静默跳过 |
| `soft` | 是，需确认 | 10 分钟 | 静默跳过 |
| `hard` | 60s 后可关 | 15 分钟 | **照常执行** |

**干预规则表**：

| 触发状态 | 具体条件 | 动作组合 | 级别 |
|---|---|---|---|
| `dissociating` | `context_split_score > 0.7` | `android:fullscreen_block` + `desktop:topmost_window` | hard |
| `dissociating` | `attention_fragmentation > 0.8` | `chrome:grayscale` + `chrome:tab_collapse` | soft |
| `dissociating` | `android_unlock_rate >= 15/hr` | `android:fullscreen_modal` | soft |
| `entertaining` | 在宵禁时段内 | `chrome:hard_block` + `android:fullscreen_block` | hard |
| `entertaining` | 非宵禁，持续 > 30 分钟 | `chrome:friction_banner` + `android:push_notify` | notify |
| `entertaining` | `entertainment_depth_score > 0.8` | `chrome:grayscale` + `android:fullscreen_modal` | soft |
| `working` | `deep_work_duration_ms > 90min` | `desktop:toast_notify` | notify |
| `resting` | 超过 target_bedtime 15 分钟 | `desktop:toast_notify` + `android:push_notify` | notify |
| `resting` | 超过 target_bedtime 30 分钟 | `chrome:hard_block` + `android:fullscreen_modal` | soft |
| `resting` | 超过 target_bedtime 60 分钟（T0） | `desktop:force_lock` + `chrome:hard_block` + `android:fullscreen_block` | hard |

```typescript
interface InterventionPlan {
  id: string
  type: 'notify' | 'soft' | 'hard'
  targets: Array<'desktop' | 'chrome' | 'android'>
  action: string
  message?: string       // AI 生成，≤80 字中文
  expires_at: number
}
```

### 3.5 Stage 4 — ActionDispatcher

**职责**：分发 InterventionPlan 到各端，记录执行结果，触发效果评估。

**执行流程**：
1. 检查 `do_not_disturb`：notify/soft 跳过，hard 不跳过
2. 检查同类干预冷却，冷却中跳过
3. 向各端 WebSocket 推送消息
4. 写入 `intervention_cooldowns`（内存）
5. 5 分钟后评估干预效果，结果写入长期记忆

**干预动作库**：

*Desktop：*
| action key | 级别 | 实现 |
|---|---|---|
| `desktop:toast_notify` | notify | Electron Notification API |
| `desktop:topmost_window` | soft | 置顶半透明悬浮窗 + AI 文案 + 倒计时 |
| `desktop:force_lock` | hard | child_process 执行系统锁屏 |

*Chrome：*
| action key | 级别 | 实现 |
|---|---|---|
| `chrome:friction_banner` | notify | content.ts 注入顶部横幅，可一键关闭 |
| `chrome:grayscale` | soft | content.ts 全页灰度滤镜 |
| `chrome:hard_block` | hard | background.ts 拦截请求，跳转本地提醒页 |
| `chrome:tab_collapse` | soft | background.ts 关闭所有高刺激 tab |

*Android：*
| action key | 级别 | 实现 |
|---|---|---|
| `android:push_notify` | notify | Expo Notifications |
| `android:fullscreen_modal` | soft | RN Modal 全屏，「我回来了」按钮 |
| `android:fullscreen_block` | hard | 全屏 Modal，60s 倒计时后可关 |
| `android:app_usage_alert` | notify | 推送通知带使用时长数据 |

---

## 4. 触发时序与 Tick 机制

### 4.1 三层触发模型

```
事件入库时
    ├─ 更新 do_not_disturb_composite 内存状态
    └─ 命中「立即触发事件表」→ 防抖触发轻量 pipeline

每 1 分钟
    └─ 轻量 tick：10 分钟窗口，检查强/硬干预条件

每 5 分钟
    └─ 完整 tick：2 小时窗口，完整推断 + 全规则 + 写 user_living_context
```

### 4.2 立即触发事件表

| 事件 | 来源 | 触发条件 |
|---|---|---|
| `screen_on` | Android | 无条件 |
| `screen_unlock` | Android | 无条件 |
| `app_foreground` | Android | payload.packageName 在 HIGH_STIMULUS_APPS 列表中 |
| `url_visit` | Chrome | `payload.high_stimulus === true` |
| `tab_explosion` | Chrome | 无条件 |
| `video_state` | Chrome | `payload.state === 'play'` |
| `microphone_active` | Desktop | 无条件（同时更新 DND 状态） |
| `camera_active` | Desktop | 无条件（同时更新 DND 状态） |

### 4.3 防抖与保护

```typescript
const EVENT_DEBOUNCE_MS = 500        // 同触发源 500ms 内只触发一次
const LIGHTWEIGHT_COOLDOWN_MS = 5_000 // 轻量 pipeline 5s 内不重复执行
```

---

## 5. 长期建模与记忆系统

### 5.1 三层记忆模型

```
Layer 1: 当日上下文（内存）    实时更新，重启后从 behavior_logs 重建
Layer 2: 每日归档（circadian_logs）  00:00 落盘
Layer 3: 个人模式（user_memory）     每周日 00:00 分析更新
```

### 5.2 Layer 1 — DailyContext（内存）

```typescript
interface DailyContext {
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
}
```

### 5.3 Layer 2 — circadian_logs 新增字段

```
deep_work_total_ms, dissociation_count, dissociation_total_ms,
intervention_count, intervention_dismiss_rate,
android_unlock_count, peak_work_hour, peak_distraction_hour
```

### 5.4 Layer 3 — user_memory 更新逻辑

每周日 00:00 分析过去 7 天 circadian_logs：

| key | 分析内容 | 影响推断 |
|---|---|---|
| `dissociation_pattern` | peak_distraction_hour 分布，找高风险时段 | 该时段置信度 +0.1 |
| `response_to_intervention` | 各干预类型 dismiss_rate | dismiss_rate > 0.7 → 降级或换策略 |
| `sleep_pattern` | screen_off 集中时段推断入睡规律 | 动态调整宵禁触发时间 |
| `mood_trend` | dissociation_count + deep_work 趋势 | 连续 3 日解离上升 → 提高干预灵敏度 |

### 5.5 冷启动策略

| 阶段 | 条件 | 行为 |
|---|---|---|
| 纯记录期 | 前 3 天 | 只采集，不做记忆注入，置信度用基础值 |
| 过渡期 | 第 4–13 天 | 注入开启，置信度加成减半 |
| 完整期 | 第 14 天起 | 完整注入 |

状态存 `user_memory.onboarding_days`。

---

## 6. AI 集成层

### 6.1 四个切入点

| 切入点 | 触发时机 | 作用 |
|---|---|---|
| 模糊状态仲裁 | Stage 2 confidence < 0.6 或两状态得分差 < 0.15 | LLM 最终裁定状态 |
| 干预文案生成 | Stage 4 确认 notify/soft 干预时 | 个性化中文提醒，≤80 字 |
| 解离日记分类 | 每日 00:00 归档时，批量处理当日解离事件 | 自动标注 active_rest / attention_break / dissociation |
| 每周模式解读 | 每周日 00:00 | 自然语言洞察报告，存 user_memory.weekly_insights |

### 6.2 模糊状态仲裁

- 超时保护：3 秒未返回 → 使用规则引擎原始结果
- 频率限制：每分钟最多 3 次
- 缓存：相同 FeatureSnapshot hash 结果缓存 2 分钟
- 输出 Schema：`{ state, confidence, reasoning: string（≤50字）}`

### 6.3 干预文案 Fallback

LLM 超时或失败时使用预设模板，不阻塞干预执行：

```typescript
const FALLBACK_MESSAGES: Record<UserState, string> = {
  dissociating: '已经有一段时间了，回来一下？',
  entertaining: '玩了一会儿了，时间过得挺快的。',
  resting: '该睡了，明天还有事。',
  working: '专注了很久了，可以休息一会儿。',
  transitioning: '现在在做什么？',
}
```

### 6.4 AI 调用预算

| 调用类型 | 频率上限 | 预估 token/次 |
|---|---|---|
| 模糊状态仲裁 | 3 次/分钟 | ~500 |
| 干预文案生成 | ≤12 次/小时 | ~300 |
| 解离日记分类 | ≤10 条/日 | ~400/条 |
| 每周模式解读 | 1 次/周 | ~2000 |

---

## 7. WebSocket 消息格式

统一各端消息结构：

```typescript
// 服务端 → 客户端
interface ServerMessage {
  type: 'intervention'
  payload: {
    intervention_id: string
    action: string
    level: 'notify' | 'soft' | 'hard'
    message: string
    expires_at: number
  }
}

// 客户端 → 服务端（执行结果回报）
// event_type: 'intervention_result'
// payload:
interface InterventionResultPayload {
  intervention_id: string
  action: string
  result: 'executed' | 'dismissed' | 'expired'
  dismissed_by_user: boolean
  dismissed_after_ms?: number
}
```

---

## 8. 文件结构（预期）

```
apps/web/lib/
├── inference/
│   ├── feature-extractor.ts    # Stage 1
│   ├── state-inferrer.ts       # Stage 2
│   ├── intervention-planner.ts # Stage 3
│   ├── action-dispatcher.ts    # Stage 4
│   ├── ai-arbiter.ts           # AI 仲裁
│   ├── ai-copywriter.ts        # AI 文案
│   └── pipeline.ts             # 管线入口，协调四阶段
├── memory/
│   ├── daily-context.ts        # Layer 1 内存管理
│   ├── daily-archiver.ts       # Layer 2 每日归档
│   └── weekly-analyzer.ts      # Layer 3 每周建模
packages/db/src/
└── schema.ts                   # circadian_logs 新增字段
```

---

## 9. 已知 Bug 修复清单

| Bug | 位置 | 修复方式 |
|---|---|---|
| `isEntertaining()` 对 Chrome 来源永远失效 | `engine.ts` | Chrome `url_visit` payload 补充 `url` 字段 |
| desktop `window_focus` 无停留时长 | `desktop/src/main/index.ts` | 上报前计算 `duration_ms` |
| Android `screen_unlock` 未实现 | `appTracker.ts` | 补全 tracker 实现 |
| `location_zone` 字段有 schema 无采集 | 各端 | 本期不实现，保留字段 |
