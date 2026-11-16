<div align="center">
  <img src="icon/icon-rounded.svg" width="96" alt="Anchor logo" />
  <h1>Anchor</h1>
  <p><b>生活节律重建系统</b> —— 多端感知 · 统一推断 · 温和干预</p>

  <a href="https://github.com/junugo/Anchor/releases"><img src="https://img.shields.io/github/v/release/junugo/Anchor?style=flat-square&logo=github" alt="Release" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/junugo/Anchor?style=flat-square" alt="License: MIT" /></a>
  <a href="https://github.com/junugo/Anchor/commits"><img src="https://img.shields.io/github/last-commit/junugo/Anchor?style=flat-square" alt="Last commit" /></a>
  <img src="https://img.shields.io/badge/Windows-0078D6?style=flat-square&logo=windows&logoColor=white" alt="Windows" />
  <img src="https://img.shields.io/badge/Android-3DDC84?style=flat-square&logo=android&logoColor=white" alt="Android" />
  <img src="https://img.shields.io/badge/Chrome-4285F4?style=flat-square&logo=googlechrome&logoColor=white" alt="Chrome" />
  <img src="https://img.shields.io/badge/VS%20Code-007ACC?style=flat-square&logo=visualstudiocode&logoColor=white" alt="VS Code" />
</div>

---

**English intro** — Anchor is a self-hosted rhythm-reconstruction system for independent workers. Multiple lightweight clients (desktop, Android, Chrome, VS Code) sense behavior and upload it encrypted to your own server; the server infers your state (working / entertaining / resting / dissociating / sleeping / away) and gently nudges you back to your intended rhythm — with a sunset curfew, dissociation prevention, and a warm, non-judgmental AI companion. Single-user by design, no telemetry, your data never leaves your devices.

> 📘 **不是开发者？** 直接看 [《Anchor 使用指南》](docs/USER_GUIDE.md) —— 从安装到日常使用，零代码背景也能跟着做完。

---

Anchor 是**生活节律重建系统**：多端行为感知 → 服务器统一推断 → 温和干预，帮助独立工作者实现节律自治、自我管理与解离预防。

- **单用户自托管**：没有账号系统、没有遥测、没有云端，数据只存在你自己的服务器上
- **服务器是决策中心**：各客户端只负责采集与执行，跨端数据统一分析才能准确推断状态
- **隐私优先**：上行行为数据 AES-256-GCM 加密，密钥由你持有（`ANCHOR_DATA_KEY`）
- **干预分级**：状态符合预期时系统沉默；偏差越大干预越强（静默记录 → 柔和提醒 → 标准娱乐摩擦 → 硬宵禁）

## ✨ 功能一览

| 模块 | 说明 |
|------|------|
| 🧠 状态推断引擎 | 打分制 + AI 仲裁（DeepSeek），5 分钟完整 tick + 1 分钟轻量 tick |
| 🌇 日落/宵禁 | T-60 → T0 渐进式就寝引导，T0 全屏灰屏强制执行，睡眠状态机 |
| 🛡️ 日程哨兵 | 上学/工作时段无真实交互 → 自动 away，不推断、不干预、不写日志 |
| 💬 AI 数字室友 | 中文对话（≤80 字，不评判），每日维护、日记分类、每周分析 |
| 🕘 时间轴 | 日/周状态分段、事件流水、历史回放 |
| 📱 多端采集 | Windows 焦点追踪、Android 前台/解锁、Chrome 浏览、VS Code 键入 |

## 🧩 架构

```
┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────┐
│ Desktop    │  │ Mobile     │  │ Chrome     │  │ VS Code    │
│ Rust+Slint │  │ Kotlin     │  │ MV3        │  │ Extension  │
│ 焦点追踪   │  │ 前台/解锁  │  │ URL/灰屏   │  │ 键入活动   │
└──────┬─────┘  └──────┬─────┘  └──────┬─────┘  └──────┬─────┘
       │  AES-256-GCM 加密上传行为数据（密钥自管）          │
       └──────────────────┬───────────────────────────────┘
                          ▼
              ┌───────────────────────┐
              │  Server (Next.js 15)  │  feature-extractor → state-inferrer
              │  SQLite + Drizzle     │  → ai-arbiter → intervention-planner
              │  WebSocket /ws        │  → action-dispatcher
              └───────────┬───────────┘
                          ▼ 推断状态 + 干预决策
       ┌──────────────────┴───────────────────────────────┐
       ▼            ▼            ▼            ▼
   通知/浮窗    宵禁灰屏     浏览器拦截    状态栏着色
```

## 📁 Monorepo 结构

```
apps/
├── web/          # Next.js 15 服务器主脑（port 4000，WebSocket）
├── desktop-rs/   # Rust + Slint 原生守护进程（Windows）
├── chrome-ext/   # Chrome MV3 扩展（WXT）
├── vscode-ext/   # VS Code 扩展
└── mobile/       # Android 原生（Kotlin + Jetpack Compose）
packages/
├── db/           # drizzle-orm + better-sqlite3
├── types/        # 共享 TS 类型
├── api-client/   # 客户端→服务器通信
├── ui/           # 共享组件 / hooks / tokens
└── utils/        # 共享工具（含上行加密）
```

## 🚀 快速开始

### 1. 启动服务器

```bash
pnpm install
cp apps/web/.env.example apps/web/.env
# 编辑 .env：填入 DEEPSEEK_API_KEY，生产环境务必设置 ANCHOR_DATA_KEY 与 ANCHOR_TZ
pnpm web:dev        # http://localhost:4000
```

### 2. 接入客户端

所有客户端**默认连接 `http://localhost:4000`，无需改代码、无需重新打包**，在各自设置界面配置服务器地址与数据密钥即可：

| 客户端 | 构建 | 配置入口 |
|--------|------|----------|
| 💻 Desktop | `cd apps/desktop-rs && cargo run --release` | 托盘菜单 → 设置 |
| 📱 Mobile | `cd apps/mobile/android && ./gradlew.bat :app:assembleDebug`，`adb install app/build/outputs/apk/debug/app-debug.apk` | 设置页 → 服务器连接（USB 调试可 `adb reverse tcp:4000 tcp:4000`） |
| 🌐 Chrome | `pnpm chrome:build` 后加载 `apps/chrome-ext/.output/chrome-mv3` | 扩展弹窗 → 齿轮 → 选项页 |
| 📝 VS Code | `cd apps/vscode-ext && pnpm build`，F5 调试 | 设置 → 扩展 → Anchor（`anchor.serverUrl` / `anchor.dataKey`） |

不想自己编译？ release 页面提供四端现成的安装包，见 [使用指南](docs/USER_GUIDE.md)。

密钥指纹用于核对客户端与服务器密钥是否一致（服务器启动日志打印 `[ws] 数据密钥指纹: <8位>`）。

## ⚙️ 配置

见 [apps/web/.env.example](apps/web/.env.example)。核心项：

- `DEEPSEEK_API_KEY` — AI 提醒/日记/分类（必填）
- `ANCHOR_DATA_KEY` — 上行加密密钥，必须与所有客户端一致（生产必填）
- `ANCHOR_TZ` — 用户时区，所有作息时钟按时区计算（默认 `Asia/Shanghai`）
- `ANCHOR_DB_PATH` — SQLite 路径（默认 `~/.anchor/anchor.db`）

## 🧪 测试

```bash
pnpm test          # web (tsx --test) + 各包 (vitest)
cd apps/desktop-rs && cargo test
cd apps/mobile/android && ./gradlew.bat :app:testDebugUnitTest
```

## 📖 文档

- 📘 [docs/USER_GUIDE.md](docs/USER_GUIDE.md) — **非开发者使用指南**（安装 → 配置 → 日常使用 → FAQ）

## 📄 License

[MIT](LICENSE)
