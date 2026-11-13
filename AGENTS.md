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
- 密钥：内置开发默认 `anchor-dev-data-key`（仅限本地开发），服务器用环境变量 `ANCHOR_DATA_KEY` 覆盖；各客户端在自身设置界面配置，须与服务器一致（见 `packages/utils/src/crypto.ts` 与「自托管部署 → 客户端接入」）

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
- `away` — **日程哨兵状态（不进打分引擎）**：`school_schedule`（设置 → 学校作息）启用且当前为上学日校时段、近 15min 无真实交互（STRONG 活动，不含 app_foreground 心跳）时，pipeline 短路直出 away——不推断、不干预、不写干预日志（同 sleeping 短路模式）。校时段内有真实交互 → 正常推断（病假在家仍被观察）。睡眠引擎校时段不产生/裁决被动入睡候选；上学日 sleeping 过起床估算点（默认 06:50）且入睡后零活动 → `school_departure` 结算（sleep_end=估算点）
- 工作信号来源：VS Code `code_active` + Windows 工作进程（`process_classifications.is_work` ∪ 内置 DEV_TOOLS）+ 工作网站（`site_classifications.is_work`）+ Android 工作 App（`app_classifications.is_work`），统一在 `/apps` 页管理
- 推断管线（`lib/inference/pipeline.ts`）：feature-extractor → state-inferrer → ai-arbiter → intervention-planner → action-dispatcher；AI 仲裁仅在完整 tick 进行（confidence<0.6 或 top-2 差值<0.12 时介入）
- `sleeping` — 哨兵状态，**不进判断引擎**：日落会话相位为 sleeping 且宵禁启用时，推断管线短路（跳过特征提取/状态推断/AI 仲裁/干预规划/动作分发，见 `lib/inference/pipeline.ts`），仅广播 sleeping + 写哨兵日志 + 推进睡眠状态机；解除路径：睡眠引擎发现活跃（→confirming 弹「你睡着了吗？」）、「还没睡」→回 curfew 解除短路、「真睡」超时停留 sleeping、8h 自动解除、正常起床、宵禁关闭。AI 每日维护/跨日归档在 pipeline 之外不受影响

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
- 位置：`apps/web/anchor.db`（开发环境）；生产由 `.env` 的 `ANCHOR_DB_PATH` 指定
- 迁移：启动时自动执行 `initDb()` + `initSunsetConfig(db)`
- Schema：`packages/db/src/schema.ts`

---

## 自托管部署

### 服务器配置
复制 `apps/web/.env.example` 为 `apps/web/.env`，必填项：
- `DEEPSEEK_API_KEY` — AI 提醒/日记/分类功能依赖
- `ANCHOR_DATA_KEY` — 上行行为数据加密密钥，必须与所有客户端配置一致（生产必须配置，不要使用内置开发密钥）
- `ANCHOR_TZ` — 用户时区（如 `Asia/Shanghai`）。宵禁、睡眠日界、DailyContext、AI 每日维护等所有作息时钟都按此时区计算，而不是服务器本地时区

建议显式声明 `ANCHOR_DB_PATH` 指向持久目录。部署后检查启动日志 `[server] 用户时区: ...`、`[server] DB 路径: ...`、`[ws] 数据密钥指纹: <8位>` 是否符合预期。

### 客户端接入
所有客户端默认连 `http://localhost:4000`，无需改代码重新打包，在各自设置界面配置服务器地址与数据密钥：
- **Desktop**：托盘菜单 → 设置（服务器地址 + 数据密钥）
- **Mobile**：设置页 → 服务器连接（USB 调试可 `adb reverse tcp:4000 tcp:4000` 直连本机服务器）
- **Chrome**：扩展弹窗 → 齿轮图标 → 选项页
- **VS Code**：设置 → 扩展 → Anchor（`anchor.serverUrl` / `anchor.dataKey`）

### 关键坑：DB 路径必须惰性解析
- **`lib/db.ts` 禁止在模块加载时计算 DB 路径**：ESM import 提升使被导入模块先于 `server.ts` 的 `loadEnvFile()` 执行，模块级常量会固定为默认路径（`~/.anchor/anchor.db`），导致 WS ingest 与 API 路由写到两个不同文件 —— 实时信号刷新后「消失」
- 现状：`resolveDbPath()` 在 `initDb()/getDb()` 调用时才求值；`server.ts` 顶部用 `loadEnvFile()` 显式加载 `.env` 并在启动日志打印 `[server] DB 路径: ...`
- 排查单一 DB 是否成立：`ls -l /proc/$(pgrep -f server.ts | tail -1)/fd | grep anchor.db`（worker 进程的所有句柄应指向同一文件）

### SQLite 运维
- 服务器 WAL 模式下，**复制 DB 文件前必须先 checkpoint**：`sqlite3 <db> 'PRAGMA wal_checkpoint(TRUNCATE);'`，否则 `-wal` 中的最新数据会丢失；活动文件直接 `cp` 还可能得到损坏副本（`SQLITE_CORRUPT`）
- 健康检查：`sqlite3 <db> 'PRAGMA integrity_check;'`
- 数据合并：`ATTACH` 源库，`behavior_logs` 按 `(source, event_type, payload, logged_at)` 去重插入（id 重新分配），有唯一键的表按 `updated_at` 较新者胜出

### 数据密钥排查
- 服务器启动日志打印 `[ws] 数据密钥指纹: <8位>`；客户端解密失败时比对本端指纹
- 解密失败的消息会被丢弃且不落库，日志为 `[ws] ingest 解密失败 ...`

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

*最后更新：2026-11-13 | 有疑问先读 PROJECT_CHARTER.md*
