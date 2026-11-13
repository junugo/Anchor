> ⚠️ **已废弃**：本文档基于 React Native 方案，实际已迁移为 Android 原生 Kotlin + Jetpack Compose。请参阅 pps/mobile/README.md。

# Anchor Android 应用完整设计规格

> 版本：1.0 | 日期：2026-06-15 | 作者：junugo

---

## 1. 项目概述

### 1.1 目标
完整构建 Anchor Android 应用，实现所有核心功能模块，包括：
- 多客户端行为追踪
- 状态推断引擎（客户端数据采集）
- 日总结与规划
- 数字宵禁引擎
- 解离缓冲层
- 节律重建器
- 单人问责系统
- 智能干预引擎

### 1.2 技术栈
- **框架**：React Native + Expo SDK 51
- **导航**：React Navigation 6
- **状态管理**：React Context + 自定义 Hooks
- **样式**：NativeWind (Tailwind CSS)
- **本地存储**：AsyncStorage
- **网络**：WebSocket + REST API
- **传感器**：Expo Sensors（加速度计）
- **通知**：Expo Notifications

---

## 2. 整体架构

### 2.1 分层架构
```
┌─────────────────────────────────────┐
│           UI 层 (Components)        │
│  - 页面组件                         │
│  - 通用组件                         │
│  - 导航组件                         │
├─────────────────────────────────────┤
│        业务逻辑层 (Services)         │
│  - 状态推断服务                     │
│  - 宵禁执行服务                     │
│  - 通知处理服务                     │
│  - 日总结服务                       │
│  - AI 对话服务                      │
│  - 解离日记服务                     │
│  - 设置管理服务                     │
├─────────────────────────────────────┤
│          数据层 (Data)              │
│  - 本地存储 (AsyncStorage)          │
│  - 网络同步 (WebSocket/REST)        │
│  - 数据模型                         │
├─────────────────────────────────────┤
│          基础设施层 (Infrastructure)│
│  - WebSocket 客户端                 │
│  - 传感器管理                       │
│  - 通知管理                         │
│  - 平台工具                         │
└─────────────────────────────────────┘
```

### 2.2 数据流
```
传感器/用户输入 → 数据采集 → 本地存储 → 网络同步 → 服务器
                                                        ↓
服务器推断结果 → WebSocket → 客户端接收 → 业务逻辑处理 → UI 更新/通知
```

---

## 3. 数据层设计

### 3.1 数据模型
```typescript
// 行为日志
interface BehaviorLog {
  id: string
  timestamp: number
  event_type: 'screen_on' | 'screen_off' | 'app_open' | 'app_close' | 'manual_event'
  source: 'android' | 'desktop' | 'chrome' | 'vscode'
  payload: Record<string, unknown>
  synced: boolean
}

// 用户状态
interface UserState {
  state: 'working' | 'entertaining' | 'dissociating' | 'resting' | 'transitioning'
  confidence: number
  last_updated: number
}

// 宵禁配置
interface SunsetConfig {
  enabled: boolean
  bedtime: string // HH:mm format
  wake_time: string // HH:mm format
  phases: {
    T60: boolean
    T30: boolean
    T0: boolean
  }
}

// 解离日记
interface DissociationDiary {
  id: string
  timestamp: number
  trigger: string
  duration: number
  reflection: string
  mood_before: number
  mood_after: number
}

// AI 对话
interface AiConversation {
  id: string
  messages: Array<{
    role: 'user' | 'assistant'
    content: string
    timestamp: number
  }>
  last_message: number
}

// 设置
interface AppSettings {
  theme: 'light' | 'dark' | 'system'
  notifications_enabled: boolean
  screen_tracking_enabled: boolean
  location_tracking_enabled: boolean
  server_url: string
}
```

### 3.2 本地存储策略
- ** AsyncStorage **: 存储用户设置、配置、日记等
- ** 行为日志**: 使用 AsyncStorage 缓存，定期批量同步
- ** 离线支持**: 网络断开时本地记录，恢复后自动同步

### 3.3 网络同步策略
- ** 实时同步**: 重要事件（状态变化、宵禁触发、手动事件）通过 WebSocket 实时同步
- ** 批量同步**: 行为日志每 5 分钟批量同步一次，每次最多 100 条
- ** 重试机制**: 同步失败时指数退避重试（1s, 2s, 4s, 8s, 16s），最多 5 次
- ** 冲突解决**: 以服务器时间戳为准，本地时间戳作为参考
- ** 数据压缩**: 批量同步时使用 gzip 压缩，减少网络开销

---

## 4. 业务逻辑层设计

### 4.1 状态推断服务
**职责**: 根据本地数据推断用户当前状态
**实现**:
```typescript
class StateInferenceService {
  // 基于屏幕状态推断
  inferFromScreenState(screenOn: boolean, lastActivity: number): UserState
  
  // 基于应用使用推断
  inferFromAppUsage(appPackage: string, usageDuration: number): UserState
  
  // 综合推断
 综合推断(): UserState
}
```

**状态规则**:
- `working`: 代码编辑器打开且有键盘活动（5 分钟内有按键事件）
- `entertaining`: 高刺激应用（社交媒体、视频、游戏）使用超过 2 分钟
- `dissociating`: 30 分钟无有意义活动（无键盘输入、无应用切换）
- `resting`: 屏幕关闭或锁屏超过 5 分钟
- `transitioning`: 状态切换期间（1-3 分钟过渡期）

### 4.2 宵禁执行服务
**职责**: 根据服务器指令执行宵禁效果
**实现**:
```typescript
class SunsetExecutorService {
  // T-60: 温和提醒
  handleT60(): void
  
  // T-30: 应用内摩擦（灰屏+遮罩）
  handleT30(): void
  
  // T-0: 硬宵禁（全屏闹钟+摇晃验证）
  handleT0(): void
  
  // 贪睡功能
  snooze(minutes: number): void
}
```

**宵禁效果**:
- **T-60**: 通知栏提醒 + 应用内 Toast（5 秒后自动消失）
- **T-30**: 应用界面变灰（降低饱和度 70%）+ 半透明黑色遮罩（透明度 40%）+ 倒计时（30 分钟）
- **T-0**: 全屏闹钟界面（深色背景 #1c1814）+ 摇晃 10 次验证（加速度 > 2.5g）+ 强制锁屏（30 分钟后自动锁定）

### 4.3 通知处理服务
**职责**: 处理服务器推送的通知和指令
**实现**:
```typescript
class NotificationHandlerService {
  // AI 通知
  handleAiNotification(message: string, actions: Array<{label: string, id: string}>): void
  
  // 时间锚点
  handleTimeAnchor(text: string): void
  
  // 起床闹钟
  handleWakeupAlarm(): void
  
  // 行为建议
  handleBehaviorSuggestion(suggestion: string): void
}
```

### 4.4 日总结服务
**职责**: 生成每日行为总结和预测
**实现**:
```typescript
class DailySummaryService {
  // 获取今日数据
  getTodayData(): Promise<TodayData>
  
  // 生成总结
  generateSummary(data: TodayData): Promise<DailySummary>
  
  // 生成预测
  generatePrediction(summary: DailySummary): Promise<DailyPrediction>
  
  // AI 辅助规划
  aiAssistPlanning(prediction: DailyPrediction): Promise<PlanningSuggestion>
}
```

### 4.5 AI 对话服务
**职责**: 与服务器 AI 进行对话
**实现**:
```typescript
class AiConversationService {
  // 发送消息
  sendMessage(message: string): Promise<AiResponse>
  
  // 获取对话历史
  getConversationHistory(): Promise<Array<Message>>
  
  // 清空对话
  clearConversation(): Promise<void>
}
```

### 4.6 解离日记服务
**职责**: 管理解离日记和反思
**实现**:
```typescript
class DissociationDiaryService {
  // 创建日记条目
  createDiaryEntry(entry: Omit<DiaryEntry, 'id' | 'timestamp'>): Promise<DiaryEntry>
  
  // 获取日记列表
  getDiaryEntries(limit?: number): Promise<Array<DiaryEntry>>
  
  // 获取统计信息
  getStatistics(): Promise<DiaryStatistics>
  
  // AI 辅助反思
  aiAssistReflection(entry: DiaryEntry): Promise<ReflectionSuggestion>
}
```

### 4.7 设置管理服务
**职责**: 管理应用设置
**实现**:
```typescript
class SettingsService {
  // 获取设置
  getSettings(): Promise<AppSettings>
  
  // 更新设置
  updateSettings(settings: Partial<AppSettings>): Promise<void>
  
  // 重置设置
  resetSettings(): Promise<void>
  
  // 导出设置
  exportSettings(): Promise<string>
  
  // 导入设置
  importSettings(data: string): Promise<void>
}
```

---

## 5. UI 层设计

### 5.1 导航结构
```
底部导航栏 (56px)
├── 主页 (Home)
├── 日总结 (DailySummary)
├── 宵禁设置 (SunsetSettings)
├── AI 对话 (AiChat)
├── 解离日记 (Diary)
└── 更多 (More)
    ├── 设置 (Settings)
    ├── 关于 (About)
    └── 退出 (Logout)
```

### 5.2 页面设计

#### 5.2.1 主页 (HomeScreen)
- **当前状态卡片**: 显示推断状态 + 置信度
- **宵禁阶段卡片**: 显示当前宵禁阶段（如有）
- **AI 消息卡片**: 显示最新 AI 建议
- **快速操作**: 用餐、离开房间、入睡、起床验证
- **服务器状态**: 连接状态指示器

#### 5.2.2 日总结 (DailySummaryScreen)
- **时间线**: 24 小时行为时间线
- **状态分布**: 各状态占比饼图
- **应用使用**: 应用使用统计
- **AI 总结**: AI 生成的文字总结
- **预测**: 明日行为预测

#### 5.2.3 宵禁设置 (SunsetSettingsScreen)
- **启用开关**: 宵禁功能开关
- **就寝时间**: 时间选择器
- **起床时间**: 时间选择器
- **阶段配置**: T-60/T-30/T-0 开关
- **预览**: 宵禁效果预览

#### 5.2.4 AI 对话 (AiChatScreen)
- **对话界面**: 消息列表 + 输入框
- **快捷问题**: 预设问题按钮
- **历史记录**: 对话历史查看
- **清空对话**: 清空历史按钮

#### 5.2.5 解离日记 (DiaryScreen)
- **日记列表**: 按日期分组显示
- **新建日记**: 表单界面
- **统计图表**: 解离频率、时长统计
- **AI 反思**: AI 辅助反思建议

#### 5.2.6 设置 (SettingsScreen)
- **主题设置**: 亮色/暗色/跟随系统
- **通知设置**: 通知开关、静音时段
- **追踪设置**: 屏幕追踪、位置追踪开关
- **服务器设置**: 服务器 URL 配置
- **数据管理**: 导出/导入/清除数据
- **关于**: 版本信息、开发者信息

### 5.3 组件设计

#### 5.3.1 通用组件
- **Button**: 按钮组件（主要、次要、禁用状态）
- **Card**: 卡片组件（普通、强调、警告）
- **Input**: 输入框组件（文本、数字、密码）
- **Modal**: 模态框组件（确认、表单、全屏）
- **Toast**: 提示组件（成功、错误、警告、信息）
- **Loading**: 加载组件（ spinner、骨架屏）

#### 5.3.2 业务组件
- **StateCard**: 状态显示卡片
- **SunsetBanner**: 宵禁横幅
- **AiMessage**: AI 消息卡片
- **DiaryEntry**: 日记条目组件
- **TimeLine**: 时间线组件
- **Chart**: 图表组件（饼图、折线图、柱状图）

---

## 6. 技术实现细节

### 6.1 屏幕追踪
**实现**:
```typescript
// 使用 AppState 追踪屏幕状态
AppState.addEventListener('change', (nextState) => {
  if (nextState === 'active') {
    reportScreenOn()
  } else if (nextState === 'background') {
    reportScreenOff()
  }
})
```

### 6.2 宵禁执行
**T-30 灰屏实现**:
```typescript
// 使用 Modal + 半透明遮罩
<Modal visible={showSunsetOverlay} transparent>
  <View style={{ flex: 1, backgroundColor: 'rgba(0,0,0,0.7)' }}>
    {/* 倒计时和提示信息 */}
  </View>
</Modal>
```

**T-0 硬宵禁实现**:
```typescript
// 全屏闹钟 + 摇晃验证
<Modal visible={showBedtimeAlarm} transparent>
  <View style={{ flex: 1, backgroundColor: '#1c1814' }}>
    {/* 闹钟界面 */}
    <AccelerometerListener onShake={dismissAlarm} />
  </View>
</Modal>
```

### 6.3 通知处理
**本地通知**:
```typescript
// Expo Notifications
Notifications.scheduleNotificationAsync({
  content: {
    title: '宵禁提醒',
    body: '距离就寝还有 30 分钟',
    sound: true,
  },
  trigger: { seconds: 1 },
})
```

### 6.4 数据同步
**WebSocket 实时同步**:
```typescript
// 重要事件实时同步
function reportStateChange(newState: UserState) {
  sendWs({
    type: 'ingest',
    source: 'android',
    event_type: 'state_change',
    payload: newState,
  })
}
```

**批量同步**:
```typescript
// 每 5 分钟批量同步行为日志
setInterval(async () => {
  const unsyncedLogs = await getUnsyncedLogs()
  if (unsyncedLogs.length > 0) {
    await syncLogs(unsyncedLogs)
    await markAsSynced(unsyncedLogs)
  }
}, 5 * 60 * 1000)
```

---

## 7. 错误处理

### 7.1 网络错误
- **WebSocket 断开**: 自动重试，最多 20 次，间隔 5 秒
- **REST API 失败**: 本地缓存，稍后重试
- **同步失败**: 保存到待重试队列

### 7.2 传感器错误
- **加速度计不可用**: 降级为手动验证
- **通知权限未授予**: 引导用户开启权限

### 7.3 数据错误
- **本地数据损坏**: 从服务器重新同步
- **服务器数据不一致**: 以服务器数据为准

---

## 8. 测试策略

### 8.1 单元测试
- 业务逻辑服务测试：使用 Jest 测试各个服务的核心逻辑
- 数据模型测试：验证数据模型的正确性和完整性
- 工具函数测试：测试工具函数的各种边界情况

### 8.2 集成测试
- WebSocket 通信测试：模拟服务器响应，测试客户端处理
- 数据同步测试：测试离线缓存和在线同步逻辑
- 传感器集成测试：模拟传感器数据，测试状态推断

### 8.3 UI 测试
- 页面渲染测试：使用 React Native Testing Library 测试组件渲染
- 用户交互测试：模拟用户操作，测试界面响应
- 导航流程测试：测试页面跳转和返回逻辑

### 8.4 E2E 测试
- 完整用户流程测试：使用 Detox 测试端到端流程
- 异常场景测试：网络断开、权限拒绝等异常情况

---

## 9. 构建与部署

### 9.1 开发环境
```bash
# 安装依赖
pnpm install

# 启动开发服务器
cd apps/mobile
pnpm start

# 构建 Android APK
eas build -p android --profile development
```

### 9.2 生产环境
```bash
# 构建生产版本
eas build -p android --profile production

# 提交到 Google Play
eas submit -p android
```

### 9.3 配置文件
- **app.json**: Expo 配置
- **eas.json**: EAS Build 配置
- **android/app/build.gradle**: Android 原生配置

---

## 10. 实施计划

### 阶段 1: 基础框架 (1-2 天)
- [ ] 项目结构搭建
- [ ] 导航系统实现
- [ ] 通用组件开发
- [ ] 数据层基础实现

### 阶段 2: 核心功能 (3-5 天)
- [ ] 屏幕追踪完善
- [ ] 宵禁执行实现
- [ ] 通知处理实现
- [ ] 状态推断服务

### 阶段 3: 扩展功能 (3-5 天)
- [ ] 日总结功能
- [ ] AI 对话功能
- [ ] 解离日记功能
- [ ] 设置管理功能

### 阶段 4: 测试与优化 (2-3 天)
- [ ] 单元测试编写
- [ ] 集成测试编写
- [ ] UI 测试编写
- [ ] 性能优化

### 阶段 5: 构建与部署 (1 天)
- [ ] 开发版 APK 构建
- [ ] 功能验证
- [ ] Bug 修复
- [ ] 最终构建

---

## 11. 风险与应对

| 风险 | 影响 | 应对措施 |
|------|------|----------|
| Expo SDK 兼容性 | 功能受限 | 使用稳定版 SDK 51，避免实验性功能 |
| Android 权限问题 | 功能无法使用 | 详细权限说明，引导用户开启 |
| 性能问题 | 用户体验差 | 性能监控，优化关键路径 |
| 网络不稳定 | 数据丢失 | 离线缓存，自动重试 |
| 传感器不可用 | 功能降级 | 手动验证备选方案 |

---

*本规格文档是 Android 应用开发的完整指导，所有开发工作应基于此文档进行。*