# Anchor — 代码库协作指南

> **快速参考** | 详细愿景与架构见 [PROJECT_CHARTER.md](docs/PROJECT_CHARTER.md)

---

## 项目定位

Anchor 是**生活节律重建系统**，帮助独立工作者实现节律自治、自我管理与解离预防。

- **用户**：开发者本人（永不多用户）
- **架构**：服务器为可信端，多客户端数据加密上传，统一分析推断
- **定位**：个人工具，不开源，不分发

---

## Monorepo 结构

```
F:\Project\Anchor
├── apps/
│   ├── web/          # Next.js 15 + WebSocket，服务器主脑，port 4000
│   ├── desktop-rs/   # Rust + Slint 原生守护进程，窗口焦点追踪
│   ├── chrome-ext/   # Chrome MV3，URL/宵禁灰屏
│   ├── vscode-ext/   # VS Code，键盘活动上报
│   └── mobile/       # Android 原生（Kotlin + Jetpack Compose），屏幕开关
├── packages/
│   ├── db/           # drizzle-orm + better-sqlite3
│   ├── types/        # 共享 TS 类型
│   ├── api-client/   # 客户端→服务器通信
│   ├── ui/           # 共享组件
│   └── utils/        # 共享工具
└── docs/
    ├── PROJECT_CHARTER.md   # 项目章程（北极星文档）
    └── superpowers/         # 技能文档
```

---

## 技术栈速查

| 层 | 技术 | 说明 |
|----|------|------|
| 服务器 | Next.js 15 App Router + 自定义 `server.ts` | tsx 执行，WebSocket `/ws` |
| Desktop | Rust + Slint 原生守护进程 | 单文件 exe，**非 Electron，非 Tauri** |
| Mobile | Android 原生 Kotlin + Jetpack Compose | **非 Flutter，非 React Native** |
| 浏览器 | Chrome Extension MV3 | |
| 编辑器 | VS Code Extension | |
| DB | SQLite (`better-sqlite3` + `drizzle-orm`) | 自动迁移 |
| AI | DeepSeek API (`deepseek-chat`) | 中文优化 |
| 构建 | pnpm workspaces + Turborepo | `onlyBuiltDependencies[]` in `.npmrc` |

---

## 关键架构原则

### 数据流
- **客户端** → AES-256-GCM 加密上传行为数据 → **服务器**（明文信封 `{enc,v,data}`，仅上行行为数据加密，交互/控制消息明文）
- **服务器** → 推断状态 + 生成决策 → **客户端执行**
- 各客户端数据互通，服务器是决策中心
- 密钥：内置开发默认 `anchor-dev-data-key`（仅限本地开发），服务器用环境变量 `ANCHOR_DATA_KEY` 覆盖；各客户端在自身设置界面配置，须与服务器一致（见 `packages/utils/src/crypto.ts`）

### FocusLayer 集成
- **独立产品**：Anchor 核心功能不依赖 FocusLayer
- **可选增强**：功能启用时 REST 调用，3s timeout
- **优雅降级**：FocusLayer 离线时 Null Object pattern
- 局域网内 mDNS 自动发现服务器（bonjour-service），`FOCUSLAYER_SERVER_URL` 可显式覆盖

### 推断规则（打分制，阈值 0.45，详见 `state-inferrer.ts`）
- `working` — workScore 最高且 ≥0.45：code_active ≥3 / 60s 内工作信号 / 深度工作段 / Windows 工作进程 ≥5min / 工作网站访问 / Android 工作 App 前台
- `entertaining` — **当下正在娱乐即娱乐中（决定性）**：60s 内娱乐信号（高刺激 url_visit / 视频播放 / Android 高刺激 App 前台，Android 前台 App 每 15s 上报确认当下性）。工作中打开娱乐软件 = 简单分心或开始娱乐，语义是娱乐而非解离
- `dissociating` — 病理性失神：Android 解锁 ≥15/h 且无工作信号、分心度 >0.8（跨端分裂不再是解离信号）
- `resting` — idle / 窗口内无事件
- 工作信号来源：VS Code `code_active` + Windows 工作进程（`process_classifications.is_work` ∪ 内置 DEV_TOOLS）+ 工作网站（`site_classifications.is_work`）+ Android 工作 App（`app_classifications.is_work`），统一在 `/apps` 页管理
- 推断管线（`lib/inference/pipeline.ts`）：feature-extractor → state-inferrer → ai-arbiter → intervention-planner → action-dispatcher；AI 仲裁仅在完整 tick 进行（confidence<0.6 或 top-2 差值<0.12 时介入）

### 运行时约束
- 决策引擎冷却：同类型决策间隔 **5 分钟**；动作分发冷却 soft/hard 10–15 分钟，notify 同状态插曲内按 **15→30→60 分钟指数退避**（状态切换或 2h 间隙归零，`action-dispatcher.ts`）
- 周期 tick（`server.ts`）：**5 分钟完整 tick**（pipeline full 推断 + AI 每日维护 + 跨日归档/日记分类 + 周日每周分析）+ **1 分钟轻量 tick**（pipeline lightweight，不写日 living context）+ **每小时**解离日记候选生成；WS 服务器 30s ping
- 单用户：`user_id = 'default'`，无 auth
- `behavior_logs` 永久保留

---

## 开发工作流

### 安装依赖
```bash
pnpm install
```

### 启动服务器（主脑）
```bash
cd apps/web
pnpm dev  # port 4000
```

### 启动客户端
```bash
# Desktop
cd apps/desktop-rs && cargo run --release

# Mobile
cd apps/mobile/android && .\gradlew.bat :app:assembleDebug
# 安装：adb install app/build/outputs/apk/debug/app-debug.apk

# Chrome Extension: pnpm build 后加载 .output/chrome-mv3 到 chrome://extensions
# VS Code Extension: F5 启动调试
```

### 数据库
- 位置：`apps/web/anchor.db`（开发环境）
- 迁移：启动时自动执行 `initDb()` + `initSunsetConfig(db)`
- Schema：`packages/db/src/schema.ts`

---

## 与 AI 协作的最佳实践

### 核心原则
1. **先读代码再动手** — 匹配现有风格、约定、库，不引入新依赖
2. **优先核心模块** — 见 PROJECT_CHARTER.md 第 3 节功能范围
3. **服务器为决策中心** — 客户端只负责采集与执行
4. **中文优先** — 代码注释、文档、UI 文案均用中文

### 已锁定决策（禁止修改）
- Desktop 用 Rust + Slint（`apps/desktop-rs`，Electron 版已删除）
- Mobile 用 Android 原生 Kotlin + Jetpack Compose（不是 Flutter，不是 React Native）
- 单用户模型（不做多租户）
- FocusLayer 是可选集成（不是强依赖）

### 修改文件时
- `apps/web/app/` — Next.js 页面（不是 `src/app/`）
- `@/*` alias → `apps/web/`（不是 `apps/web/src/`）
- 修改 DB schema 后需重启服务器

### 测试与验证
- 修改后先运行构建 / 编译
- 如有测试框架则运行测试：web/utils 用 `tsx --test`，chrome-ext/vscode-ext/ui 用 `vitest run`，desktop-rs 用 `cargo test`，mobile 用 `.\gradlew.bat :app:testDebugUnitTest`
- 验证后再提交结果

---

## UX 基准

> 完整设计语言规范见 [docs/superpowers/specs/2026-06-13-design-language.md](docs/superpowers/specs/2026-06-13-design-language.md)

### 视觉风格
- **工具感优先，兼具温暖**：暖灰底色（`#f5f0eb`），不是日记本也不是控制台
- 字体：`system-ui`，无艺术字体，工具感
- 信息密度：紧凑，类 Linear / Raycast，不做大留白
- 强调色：橙褐（`#c0622a`），深色模式底色 `#1c1814`（同强调色）
- 图标：Lucide Icons，随处使用
- 动效：功能性，100–200ms，不做装饰性动画
- **导航**：Web/Desktop 用左侧图标栏（48px）；Mobile 用底部 Dock（56px）

### 智能干预策略
| 用户状态 | 预期状态 | 干预级别 | 颜色 |
|----------|----------|----------|------|
| 心流办公 | 办公 | **被动感知**（静默记录）| 绿 `#22863a` |
| 放松休息 | 该睡觉 | **轻干预**（柔和提醒）| 黄 `#b08800` |
| 工作中拿手机 | 娱乐中 | **标准娱乐摩擦**（通知/软干预，宵禁升级；工作进度由注意力残留仪式记录）| 橙 `#c0622a` |
| 深夜高刺激浏览 | 宵禁时间 | **硬宵禁**（强制执行）| 红 `#cf222e` |

**原则**：偏差越大 → 干预越强；状态符合预期时系统沉默。

### AI 对话基调
- 角色：温暖、不评判的数字室友
- 中文，≤80 字，体感优先
- 禁止「你应该」「你必须」
- 允许关心式提问、时间锚定

---

## 常见问题

### FocusLayer 离线怎么办？
Anchor 核心功能完全可用，FocusLayer 只是增强。Null Object pattern 自动降级。

### 为什么服务器是可信端？
因为是个人工具，只有一个用户。服务器统一分析多端数据才能准确推断状态。

### 数据存在哪？
本地 SQLite，各客户端加密上传至服务器，不出个人设备生态。

### 能不能改成多用户？
不能，这违反了项目的核心定位（见 PROJECT_CHARTER.md）。

---

## 项目文档索引

- [PROJECT_CHARTER.md](docs/PROJECT_CHARTER.md) — 项目章程，北极星文档
- [docs/api.md](docs/api.md) — HTTP / WebSocket API 参考
- [docs/superpowers/specs/](docs/superpowers/specs/) — 设计规范与各模块设计文档

---

*最后更新：2026-08-07 | 有疑问先读 PROJECT_CHARTER.md*
