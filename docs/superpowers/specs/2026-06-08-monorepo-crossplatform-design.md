# Monorepo 跨平台开发环境设计

**日期：** 2026-06-08  
**状态：** 已审阅  
**目标：** 从零构建 Turborepo + pnpm workspace 管理的五端 Monorepo，实现分层代码复用，探索跨平台最佳实践。

---

## 1. 仓库结构

```
anchor/
├── apps/
│   ├── web/           # Next.js 15 主应用（App Router）
│   ├── desktop/       # Electron（主进程 + 渲染壳）
│   ├── mobile/        # Expo + React Native
│   ├── chrome-ext/    # Chrome 扩展
│   └── vscode-ext/    # VS Code 扩展
│
├── packages/
│   ├── ui/            # @anchor/ui — 原子组件（react-native-web）
│   ├── api-client/    # @anchor/api-client — API 客户端
│   ├── types/         # @anchor/types — 共享类型定义
│   └── utils/         # @anchor/utils — 纯函数工具
│
├── pnpm-workspace.yaml
├── turbo.json
└── package.json
```

### 依赖方向规则

- `apps/*` 可依赖任意 `packages/*`
- `packages` 内部：`ui` 和 `api-client` 只依赖 `types`；`utils` 和 `types` 零依赖
- `apps` 之间禁止互相依赖
- `packages` 之间禁止循环依赖

---

## 2. 各端技术栈

### apps/web — Next.js 主应用
- Next.js 15，App Router
- 依赖 `@anchor/ui`（react-native-web 渲染路径）
- 构建产物供 Electron 渲染进程使用（`next.config.js` 设置 `output: 'export'` 静态导出）

### apps/desktop — Electron
- **主进程**：Node.js，处理文件系统读写、系统托盘/通知、本地 IPC；仅依赖 `@anchor/types`
- **渲染进程**：加载 `apps/web` 的静态导出，不重复实现 UI
- 构建工具：electron-builder
- 主进程与渲染进程通过 `contextBridge` + `ipcRenderer` 通信

### apps/mobile — Expo
- Expo SDK + React Native
- 依赖 `@anchor/ui`（原生 RN 渲染路径）
- Metro bundler，需额外配置 pnpm 符号链接解析（见 §4）

### apps/chrome-ext & apps/vscode-ext
- 各自独立构建（Vite / esbuild）
- 仅依赖 `@anchor/api-client`、`@anchor/types`、`@anchor/utils`
- 不引入 react-native-web；UI 完全自主实现

---

## 3. 共享包设计

### @anchor/types
- 纯 TypeScript，零运行时代码
- 定义所有跨端共享数据结构（`User`、`ApiResponse`、`Config` 等）
- 定义 Electron IPC channel 类型契约（见下方）
- 所有其他包的类型来源；禁止依赖其他 `@anchor/*` 包

### @anchor/utils
- 纯函数，无副作用，零外部依赖
- 覆盖：日期格式化、字符串处理、数据校验、类型守卫
- 可在所有端（含 Electron 主进程 Node.js 环境）运行

### @anchor/api-client
- 基于原生 `fetch`，无框架绑定，全端可用
- 导出：`createApiClient(baseUrl, options)` 工厂函数
- 内置：请求拦截、错误统一处理、类型安全响应解包
- 不绑定任何状态管理库（React Query / SWR 由各端自行集成）

### @anchor/ui
- 用 `react-native-web` 编写，Web 端自动映射为 DOM 元素
- 原子组件：`Button`、`Input`、`Text`、`View`、`Card`、`Spinner`
- 不包含页面级布局、导航、路由逻辑
- 双入口通过 `package.json` `exports` 字段区分：
  ```json
  {
    "exports": {
      "./native": "./src/native/index.ts",
      "./web":    "./src/web/index.ts"
    }
  }
  ```

### packages 的 package.json 约定
开发期直接指向 `src/`，由各端 bundler 编译，无需预构建：
```json
{
  "name": "@anchor/xxx",
  "main": "./src/index.ts",
  "exports": { ".": "./src/index.ts" },
  "types": "./src/index.ts"
}
```

---

## 4. 工程配置

### pnpm-workspace.yaml
```yaml
packages:
  - "apps/*"
  - "packages/*"
```

### turbo.json
```json
{
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": [".next/**", "dist/**"]
    },
    "dev": {
      "persistent": true,
      "cache": false
    },
    "lint": { "dependsOn": ["^build"] },
    "test": { "dependsOn": ["^build"] }
  }
}
```

`^build` 保证拓扑排序：`types` → `utils` → `api-client` / `ui` → `apps/*`

### Electron IPC 类型契约
IPC channel 名称与 payload 类型统一定义在 `@anchor/types`：

```ts
// packages/types/src/ipc.ts
export interface IpcChannels {
  "fs:read":     { req: { path: string };                    res: string }
  "fs:write":    { req: { path: string; content: string };   res: void   }
  "tray:notify": { req: { title: string; body: string };     res: void   }
}
```

主进程和渲染进程通过泛型辅助函数约束 channel 类型，避免字符串拼写错误。

### Metro（Expo）pnpm 兼容配置
在 `apps/mobile/metro.config.js` 中：
- `watchFolders`：指向仓库根目录 + `packages/` 各子目录
- `resolver.nodeModulesPaths`：指向根 `node_modules`

---

## 5. 错误处理

| 层级 | 策略 |
|------|------|
| 类型层 | `@anchor/types` 定义统一 `ApiError` 结构，全端共用 |
| API 层 | `@anchor/api-client` 捕获网络错误，抛出类型化异常 |
| Web / Desktop 渲染层 | React Error Boundary 兜底 |
| Electron 主进程 | `process.on('uncaughtException')` + 日志写本地文件 |
| Mobile | Expo `ErrorRecovery` + React Error Boundary |

---

## 6. 测试策略

| 类型 | 工具 | 覆盖范围 |
|------|------|---------|
| 单元测试 | Vitest | `@anchor/utils`、`@anchor/api-client`、`@anchor/types` |
| 组件测试 | React Testing Library | `@anchor/ui` 原子组件（jsdom，Web 路径） |
| 集成测试 | 各端自行维护 | 按需 |
| E2E | 暂不引入 | 探索阶段 YAGNI |

---

## 7. 复用边界总结

| 共享层 | Web | Desktop 渲染 | Mobile | Chrome Ext | VS Code Ext |
|--------|-----|-------------|--------|-----------|------------|
| `@anchor/types` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `@anchor/utils` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `@anchor/api-client` | ✓ | ✓ | ✓ | ✓ | ✓ |
| `@anchor/ui` (web) | ✓ | ✓（via Next.js） | — | — | — |
| `@anchor/ui` (native) | — | — | ✓ | — | — |
| 页面级 UI | 独立 | 复用 web | 独立 | 独立 | 独立 |
