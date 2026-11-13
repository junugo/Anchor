# 桌面端宵禁 Enforcement — 设计规格

> 状态：待实现 | 日期：2026-06-21 | 范围：`apps/desktop`

---

## 1. 背景与目标

当前 Electron 客户端对所有服务器下发的宵禁指令只发送系统通知，没有任何实际强制执行。目标是补齐三阶段渐进覆盖，并接入现有 `intervention` 指令的执行逻辑。

---

## 2. 宵禁三阶段实现

### 2.1 阶段定义

| 阶段 | WS 消息 | 主窗口效果 | 跨应用效果 |
|------|---------|-----------|-----------|
| `T60` | `sunset:phase { phase: 'T60' }` | 半透明灰色遮罩 + banner | 悬浮 pill（橙色边框）+ 托盘变橙 + 进入时推一次通知 |
| `T30` | `sunset:phase { phase: 'T30' }` | 深灰遮罩 + 模糊 + 居中提示 | 悬浮 pill（红色边框）+ 托盘变红 + 每 10 分钟推一次通知 |
| `T0` | `sunset:phase { phase: 'T0' }` | 全屏置顶覆盖窗口，阻断所有应用 | 悬浮 pill 关闭（已被全屏覆盖） |
| `off` | `sunset:phase { phase: 'off' }` | 关闭所有覆盖 | 悬浮 pill 关闭，托盘恢复默认，停止定时通知 |

### 2.2 T60 / T30 — 主窗口覆盖层

主窗口的 renderer 进程通过 `ipcRenderer` 接收 `sunset:phase` 事件，在 React 层渲染一个 `position: fixed; inset: 0` 的覆盖组件：

```tsx
// apps/desktop/src/renderer/components/SunsetOverlay.tsx
// T60: rgba(80,80,80,0.40) 遮罩 + 顶部 banner
// T30: rgba(20,20,20,0.65) 遮罩 + backdrop-filter: blur(6px) + 居中提示
```

main 进程在 `handleServerMessage` 中收到 `sunset:phase` 后：
```ts
mainWindow?.webContents.send('sunset:phase', msg.phase)
```

renderer 订阅：
```ts
ipcRenderer.on('sunset:phase', (_, phase) => setSunsetPhase(phase))
```

### 2.2b 跨应用三层持续提示

T60 / T30 阶段用户切走 Anchor 主窗口后，通过三层机制保持感知：

**层一：常驻悬浮 pill 窗口**

新建一个小型 `always-on-top` `BrowserWindow`，常驻屏幕右下角，显示实时倒计时：

```ts
// apps/desktop/src/main/pillWindow.ts
let _pillWindow: BrowserWindow | null = null

export function showPillWindow(phase: 'T60' | 'T30', bedtimeMinutes: number) {
  if (!_pillWindow) {
    _pillWindow = new BrowserWindow({
      width: 140, height: 40,
      frame: false, transparent: true,
      alwaysOnTop: true, skipTaskbar: true,
      resizable: false, focusable: false,  // 不抢焦点
      webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true },
    })
    // 右下角定位
    const { width, height } = screen.getPrimaryDisplay().workAreaSize
    _pillWindow.setPosition(width - 160, height - 56)
    _pillWindow.loadURL(`${APP_URL}/pill`)
  }
  _pillWindow.webContents.send('pill:update', { phase, bedtimeMinutes })
}

export function hidePillWindow() {
  _pillWindow?.close()
  _pillWindow = null
}
```

Pill renderer（`/pill` 路由）每分钟更新倒计时，T60 用橙色边框，T30 用红色边框。`focusable: false` 保证 pill 不抢走其他应用焦点。

**层二：托盘图标变色**

使用 Electron `nativeImage` 动态生成彩色图标：

```ts
// apps/desktop/src/main/tray.ts（扩展现有托盘逻辑）

export function updateTrayForPhase(phase: SunsetPhase, remainingMin: number) {
  const color = phase === 'T60' ? '#c0622a' : phase === 'T30' ? '#cf222e' : null

  if (color) {
    tray.setImage(buildTrayIcon(color))  // 生成带色点的 22×22 图标
    tray.setToolTip(`🌙 距就寝还有 ${remainingMin} 分钟`)
    // 更新托盘菜单加入倒计时条目
    tray.setContextMenu(buildTrayMenu({ phase, remainingMin }))
  } else {
    tray.setImage(defaultTrayIcon)
    tray.setToolTip('Anchor')
    tray.setContextMenu(buildTrayMenu({ phase: 'off' }))
  }
}

function buildTrayIcon(accentColor: string): NativeImage {
  // 22×22 SVG 渲染为 NativeImage，带彩色小圆点
  const svg = `<svg ...><circle cx="18" cy="18" r="4" fill="${accentColor}"/></svg>`
  return nativeImage.createFromDataURL(`data:image/svg+xml;base64,${btoa(svg)}`)
}
```

**层三：定时系统通知**

```ts
// apps/desktop/src/main/sunsetNotifier.ts

let _notifyTimer: NodeJS.Timeout | null = null

export function startSunsetNotifier(phase: 'T60' | 'T30', bedtimeMinutes: number) {
  stopSunsetNotifier()

  // 进入阶段时立刻推一次
  fireSunsetNotification(phase, bedtimeMinutes)

  // T60 每 20 分钟，T30 每 10 分钟
  const interval = phase === 'T60' ? 20 * 60_000 : 10 * 60_000
  _notifyTimer = setInterval(() => fireSunsetNotification(phase, bedtimeMinutes), interval)
}

export function stopSunsetNotifier() {
  if (_notifyTimer) { clearInterval(_notifyTimer); _notifyTimer = null }
}

function fireSunsetNotification(phase: string, bedtimeMinutes: number) {
  const remaining = calcRemaining(bedtimeMinutes)
  new Notification({
    title: '🌙 Anchor 宵禁提醒',
    body: `距就寝还有 ${remaining} 分钟，建议开始收尾`,
    silent: phase === 'T60',  // T60 静音，T30 有声
  }).show()
}
```

### 2.3 T0 — 全屏置顶覆盖窗口

T0 不在主窗口内处理，而是创建一个独立的 `BrowserWindow`，覆盖所有应用：

```ts
// apps/desktop/src/main/curfewWindow.ts

let _curfewWindow: BrowserWindow | null = null

export function showCurfewWindow(bedtime: string) {
  if (_curfewWindow) return

  _curfewWindow = new BrowserWindow({
    fullscreen: true,
    alwaysOnTop: true,
    frame: false,
    skipTaskbar: true,
    focusable: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
    },
  })

  // Windows 上需要额外强制置顶
  _curfewWindow.setAlwaysOnTop(true, 'screen-saver')
  _curfewWindow.setVisibleOnAllWorkspaces(true)
  _curfewWindow.setFullScreenable(false)

  // 加载宵禁页面（renderer 内已有 React 路由 /curfew）
  _curfewWindow.loadURL(`${APP_URL}/curfew?bedtime=${bedtime}`)

  _curfewWindow.on('closed', () => { _curfewWindow = null })
}

export function hideCurfewWindow() {
  _curfewWindow?.close()
  _curfewWindow = null
}
```

**强制解锁流程：**
1. 用户点击"强制解锁"按钮
2. renderer 通过 IPC 发送 `curfew:force-unlock`
3. main 进程调用 `hideCurfewWindow()`，同时通过 WS 发送 `sunset:breach` 到服务器记录破戒

**防绕过：**
- `setAlwaysOnTop(true, 'screen-saver')` 是 Windows 上最高的置顶级别，高于普通窗口和"始终在前"应用
- `frame: false` + `skipTaskbar: true` 防止任务栏切换绕过
- 不响应 Alt+F4（在 renderer 层拦截 `beforeunload`）

### 2.4 intervention 指令接入

当前 desktop 忽略 `intervention` 类型消息。补充处理：

```ts
case 'intervention':
  // 根据 level 决定行为
  if (msg.level === 'passive') break  // 静默，不打扰
  if (msg.level === 'light') {
    mainWindow?.webContents.send('intervention', msg)  // renderer 内展示 toast
  }
  if (msg.level === 'strong') {
    new Notification({ title: 'Anchor', body: msg.message }).show()
    mainWindow?.webContents.send('intervention', msg)
  }
  // 'hard_curfew' 由 sunset:phase T0 处理，不在此重复
  break
```

---

## 3. 新增文件与变更范围

```
apps/desktop/src/
├── main/
│   ├── index.ts               — handleServerMessage 补充所有阶段分支，协调三层提示
│   ├── curfewWindow.ts        — 新增：T0 全屏置顶窗口管理
│   ├── pillWindow.ts          — 新增：常驻悬浮 pill 窗口（T60/T30）
│   ├── sunsetNotifier.ts      — 新增：定时系统通知管理
│   └── tray.ts                — 修改：updateTrayForPhase，动态变色 + tooltip + 菜单
├── renderer/
│   ├── components/
│   │   └── SunsetOverlay.tsx  — 新增：T60/T30 主窗口覆盖层组件
│   └── pages/
│       ├── Curfew.tsx         — 新增：T0 宵禁全屏页面
│       └── Pill.tsx           — 新增：悬浮 pill 倒计时页面
└── preload/
    └── index.ts               — 暴露 sunset:phase、pill:update、intervention、curfew:force-unlock IPC
```

---

## 4. 成功验收标准

- [ ] 收到 `sunset:phase T60` → 主窗口灰色遮罩 + banner；右下角悬浮 pill 出现（橙边框）；托盘变橙；进入时推一次静音通知
- [ ] 收到 `sunset:phase T30` → 主窗口深色模糊遮罩；pill 变红边框；托盘变红；每 10 分钟推一次有声通知
- [ ] 切换到其他应用（VS Code、Chrome）时 pill 和托盘依然可见
- [ ] 收到 `sunset:phase T0` → 全屏置顶窗口出现，pill 关闭，无法操作其他应用
- [ ] 强制解锁后服务器收到 `sunset:breach` 记录
- [ ] 收到 `off` → 主窗口覆盖、pill、托盘色彩、定时通知全部清除
- [ ] `intervention` level=light/strong → 主窗口内展示对应提示
