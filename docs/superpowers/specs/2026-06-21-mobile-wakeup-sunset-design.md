# 移动端唤醒流程 + 定日实指 — 设计规格

> 状态：待实现 | 日期：2026-06-21 | 范围：`apps/mobile`

---

## 1. 背景与目标

当前移动端有两个主要缺口：

1. **唤醒流程**：`wakeupAlarm.ts` 与 `WakeupScreen.tsx` 各自独立实现摇一摇，互不协调；进度环用 opacity 伪造，非真实弧；App 被杀时闹钟无法触发导航；`cancelAllNotifications` 会误杀定日通知。
2. **定日实指**：三个阶段（T60/T30/T0）目前只有 T30 有一个半透明 banner，T60 灰屏和 T0 全屏锁定均未实现。

目标：补齐这两块，让移动端真正成为可用的执行端。

---

## 2. 唤醒流程重构

### 2.1 架构清理：唯一摇一摇实现

**决策**：`WakeupScreen.tsx` 是唯一摇一摇实现，`wakeupAlarm.ts` 不再内置摇晃检测。

职责划分：

| 模块 | 职责 |
|------|------|
| `wakeupAlarm.ts` | 仅负责触发/取消 notifee 全屏通知（不做传感器） |
| `WakeupScreen.tsx` | 持有摇一摇逻辑 + SVG 进度环 + 完成后发 `wakeup:verified` |
| `notificationReceiver.ts` | 收到 `wakeup:alarm` WS → 调用导航回调，无变化 |
| `App.tsx` | 注册导航回调，处理 notifee 前台事件 |

### 2.2 通知 Channel 隔离（防冲突）

创建两个独立 channel，所有 `cancelChannel` 调用只针对对应 channel，禁止 `cancelAllNotifications()`：

```
channel: 'anchor-wakeup'   → 唤醒闹钟
channel: 'anchor-sunset'   → 定日三阶段
channel: 'anchor-general'  → AI 推送 / 时间锚
```

`wakeupAlarm.ts` dismiss 时调用 `notifee.cancelChannelNotifications('anchor-wakeup')`。  
`sunsetExecutor.ts` 相位切换时调用 `notifee.cancelChannelNotifications('anchor-sunset')`。

### 2.3 后台 / App 被杀时闹钟触发

**方案**：注册 notifee Headless Task + Android `SCHEDULE_EXACT_ALARM` 权限。

- `wakeupAlarm.ts` 通过 `notifee.createTriggerNotification` 设置 `TimestampTrigger`（精确时间），`android.fullScreenAction` 指向 `WakeupScreen`。
- App 被杀时 notifee 通过 headless task 唤醒进程，全屏通知直接启动 Activity。
- `App.tsx` 在 `onForegroundEvent` 和 `onBackgroundEvent` 中统一处理 `dismiss` pressAction。
- AndroidManifest 需要添加 `USE_EXACT_ALARM` 权限（Android 12+）。

### 2.4 WakeupScreen 进度环

使用 `react-native-svg` 的 SVG dashoffset 方案：

```tsx
// 真实进度弧：stroke-dashoffset 随 shakeCount 变化
const CIRCUMFERENCE = 2 * Math.PI * 50  // r=50
const offset = CIRCUMFERENCE * (1 - shakeCount / REQUIRED_SHAKES)

<Svg width={120} height={120} viewBox="0 0 120 120">
  {/* 背景轨道 */}
  <Circle cx={60} cy={60} r={50} fill="none" stroke="#3a3530" strokeWidth={8} />
  {/* 进度弧 */}
  <Circle
    cx={60} cy={60} r={50}
    fill="none" stroke="#c0622a" strokeWidth={8}
    strokeDasharray={CIRCUMFERENCE}
    strokeDashoffset={offset}
    strokeLinecap="round"
    rotation={-90} origin="60, 60"
  />
</Svg>
```

摇一摇阈值统一为 `SHAKE_THRESHOLD = 25`（m/s²），`REQUIRED_SHAKES = 10`，两处保持一致。

### 2.5 完整唤醒流程

```
服务器 → WS wakeup:alarm
  ↓
notificationReceiver.ts → 调用 setWakeupAlarmCallback 注册的导航函数
  ↓
App.tsx → navigation.navigate('Wakeup')
  ↓
WakeupScreen 展示 SVG 进度环，监听加速度计
  ↓
10次摇晃达成 → 展示"今日第一动作" → 用户确认
  ↓
send({ type: 'wakeup:verified' }) → navigation.goBack()
  ↓
wakeupAlarm.ts cancelChannelNotifications('anchor-wakeup')
```

App 被杀路径：
```
notifee TimestampTrigger 触发全屏通知
  ↓
用户点击通知 → 启动 App → onInitialNotification 检测 → navigate('Wakeup')
```

---

## 3. 定日三阶段实指

### 3.1 阶段定义

| 阶段 | 触发 | 视觉效果 | 交互限制 |
|------|------|----------|----------|
| `T60` | 就寝前 60 分钟 | 全屏灰度遮罩（`grayscale(1)`） + 顶部 banner | 内容可操作 |
| `T30` | 就寝前 30 分钟 | 灰度 + 模糊（`blur`） + 半透明深色遮罩 + 居中提示 | 内容可见不清晰，可操作 |
| `T0` | 就寝时间 | 全屏锁定覆盖（`CurfewOverlay`），无法触达底层内容 | 仅"强制解锁（记录为破戒）"按钮 |
| `off` | 宵禁解除 | 无覆盖 | 正常 |

### 3.2 组件拆分

当前 `SunsetDimOverlay` 只处理 T30。重构为单一 `SunsetOverlay` 组件，根据 `sunsetPhase` 渲染不同层：

```
SunsetOverlay（整合 SunsetDimOverlay + CurfewOverlay 逻辑）
├── phase === 'T60' → GrayscaleLayer（全屏灰度 + banner）
├── phase === 'T30' → BlurLayer（灰度 + 模糊 + 居中提示）
├── phase === 'T0'  → CurfewLayer（全屏锁定，强制解锁按钮）
└── phase === 'off' → null
```

`pointerEvents`：
- T60：`"none"`（遮罩不拦截触摸，banner 浮在最上）
- T30：`"none"`（遮罩不拦截，内容仍可点）
- T0：`"box-only"`（全屏拦截所有触摸，只有解锁按钮可点）

### 3.3 T60 GrayscaleLayer

React Native 原生无 CSS `filter`，用 `expo-blur` 或覆盖层模拟灰度：

方案：在 app 根视图外层包一个 `ColorMatrix`（`@sphericaljellyfish/react-native-color-matrix-image-filters`）或用 `Animated` 覆盖一个 `rgba(128,128,128,α)` 半透明灰色遮罩模拟去饱和效果。

推荐用**灰色半透明遮罩**（无新依赖）：
```tsx
// T60: 灰色半透明遮罩 (pointerEvents="none") + 顶部 banner
<View style={StyleSheet.absoluteFill} pointerEvents="none">
  <View style={{ ...StyleSheet.absoluteFillObject, backgroundColor: 'rgba(100,100,100,0.45)' }} />
  <View style={styles.banner}>
    <Text>🌙 距就寝还有 {countdown} · 开始放松</Text>
  </View>
</View>
```

### 3.4 T30 BlurLayer

使用 `expo-blur` 的 `BlurView`（已在 Expo 生态中）：

```tsx
<BlurView intensity={18} tint="dark" style={StyleSheet.absoluteFill} pointerEvents="none">
  <View style={styles.centeredPrompt}>
    <Text style={styles.moonEmoji}>🌙</Text>
    <Text style={styles.timeLabel}>还有 30 分钟</Text>
    <Text style={styles.subLabel}>准备就寝</Text>
  </View>
</BlurView>
```

### 3.5 T0 CurfewLayer

全屏覆盖，`pointerEvents="box-only"`，整合现有 `CurfewOverlay` 逻辑：

```tsx
<View style={[StyleSheet.absoluteFill, styles.curfew]} pointerEvents="box-only">
  <Text style={styles.moonLarge}>🌙</Text>
  <Text style={styles.title}>就寝时间</Text>
  <Text style={styles.time}>{formattedBedtime}</Text>
  <Text style={styles.sub}>手机已进入夜间保护模式{'\n'}好梦 ✨</Text>
  <TouchableOpacity onPress={handleForceUnlock} style={styles.unlockBtn}>
    <Text style={styles.unlockText}>强制解锁（记录为破戒）</Text>
  </TouchableOpacity>
</View>
```

`handleForceUnlock` 调用：
1. `send({ type: 'sunset:breach' })` → 服务器记录破戒事件
2. `setForceUnlocked(true)` → 本地隐藏覆盖层

### 3.6 sunsetExecutor 同步 context

当前 `sunsetExecutor._currentPhase` 和 `AnchorContext.sunsetPhase` 可能分叉。

修复：`sunsetExecutor` 在相位切换时通过回调通知 context：

```ts
// sunsetExecutor.ts
let _onPhaseChange: ((phase: SunsetPhase) => void) | null = null
export function setSunsetPhaseCallback(cb: (phase: SunsetPhase) => void) {
  _onPhaseChange = cb
}
// 在相位切换处调用 _onPhaseChange?.(newPhase)
```

`App.tsx` 在 init 时注册：`setSunsetPhaseCallback(setCurrentSunsetPhase)`，`AnchorContext` 通过 context value 暴露。

---

## 4. Build 修复（前提条件）

实现前先修复 ESLint 阻断：
- `lib/inference/ai-copywriter.test.ts:35` — 将 `t` 重命名为 `_t`
- `lib/memory/daily-context.test.ts:6` — 将 `DailyContext` 重命名为 `_DailyContext`

另修复低优先级配置问题：
- `apps/web/package.json` 中 `dotenv` 版本改为 `"^16.4.5"`
- `apps/web/package.json` 中 `lucide-react` 版本改为 `"^0.474.0"`
- `apps/vscode-ext/package.json` 的 `activationEvents` 改为 `["onStartupFinished"]`

---

## 5. 新增依赖

| 包 | 用途 | 已有 |
|----|------|------|
| `react-native-svg` | WakeupScreen SVG 进度环 | 需安装 |
| `expo-blur` | T30 BlurView | 需安装（Expo 生态，兼容性好） |
| `@notifee/react-native` | 已在 package.json，需确认 lockfile | 待确认 |

---

## 6. 文件变更范围

```
apps/mobile/
├── lib/
│   ├── wakeupAlarm.ts          — 移除摇晃逻辑，改用 TimestampTrigger，channel 隔离
│   ├── sunsetExecutor.ts       — channel 隔离，添加 setSunsetPhaseCallback
│   ├── notificationReceiver.ts — 添加 dismiss pressAction 处理
│   └── AnchorContext.tsx       — 暴露 setCurrentSunsetPhase 给 App.tsx 注册
├── screens/
│   └── WakeupScreen.tsx        — SVG 进度环，清理双重摇晃实现
├── components/
│   ├── SunsetDimOverlay.tsx    — 重构为 SunsetOverlay（含三阶段）
│   └── CurfewOverlay.tsx       — 逻辑迁入 SunsetOverlay（或保留复用）
├── App.tsx                     — 注册 sunsetPhaseCallback，onBackgroundEvent 补全
└── android/app/src/main/
    └── AndroidManifest.xml     — 添加 USE_EXACT_ALARM 权限

apps/web/
├── package.json                — 修复 dotenv / lucide-react 版本
└── lib/inference/              — 修复两处 ESLint unused var

apps/vscode-ext/package.json    — activationEvents 改为 onStartupFinished
```

---

## 7. 不在本次范围内

- 桌面端（Electron）宵禁 enforcement（独立规格）
- 客户端干预动作 stub 补全（独立规格）
- 麦克风/摄像头检测（平台方案待定）
- 结构化复盘 UI

---

## 8. 成功验收标准

- [ ] `pnpm build`（apps/web）通过，无 ESLint 阻断
- [ ] App 前台收到 `wakeup:alarm` → 正确导航到 WakeupScreen，SVG 进度环随摇晃实时更新
- [ ] App 后台/被杀时，notifee 全屏通知出现，点击后进入 WakeupScreen
- [ ] T60/T30/T0 覆盖层按阶段正确渲染，T0 底层内容不可触达
- [ ] 定日通知和唤醒通知互不干扰（channel 隔离验证）
- [ ] VS Code 扩展随 VS Code 启动自动激活
