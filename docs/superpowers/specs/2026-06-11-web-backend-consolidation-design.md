# Anchor Web 后端巩固设计

**日期**: 2026-06-11  
**范围**: `apps/web` 后端 + `packages/db`  
**策略**: 就地修补 — 不引入新目录层，每个缺口在其所属文件直接补全

---

## 目标

1. 修复所有已有路径中的缺口和 bug，让每条逻辑端到端跑通
2. 补全规划中但未实现的半成品功能
3. 引入对话历史存储和用户 memory 系统，支撑 AI 的长期状态追踪

不改动 UI，不引入新的架构层，不添加超出上述范围的功能。

---

## 一、缺口修复（Bug Fixes）

### 1.1 `action:response` WebSocket 消息静默丢弃

**文件**: `apps/web/lib/ws/handlers.ts`

当前行为：`switch` 的 `default: break` 静默丢弃所有未知消息类型。

修复：添加 `action:response` case，将用户响应写入 `behavior_logs`：
```
source: 'web'
event_type: 'action_response'
payload: { action, response }
```
写入后异步触发 `runInference()`，让决策引擎感知用户的主动反馈。

---

### 1.2 `location_zone` 永远写 `unknown`

**文件**: `apps/web/lib/inference/engine.ts`  
**文件**: `apps/web/app/api/ingest/route.ts`

当前行为：`runInference` 无论如何都把 `location_zone: 'unknown'` 写入 `user_living_context`。

修复：
- `ingest` endpoint 的请求 body 增加可选字段 `location_zone?: string`
- 有值时更新 `user_living_context.location_zone`，无值时保留现有值（不覆写）
- `runInference` 不再强制覆写该字段

---

### 1.3 `sunset_compliance` 从不写回

**文件**: `apps/web/lib/circadian/sleep.ts`

当前行为：`circadian_logs.sunset_compliance` 列定义了但从不被写入。

修复：在 `recordSleepStart()` 中，入睡时计算合规度：
- 读取 `sunset_config.target_bedtime_minutes`（分钟数，如 1380 = 23:00）
- 与实际 `sleep_start` 时间比较，得出偏差分钟数（负数=提前，正数=延迟）
- 写入当天 `circadian_logs.sunset_compliance`，格式为整数分钟偏差

---

### 1.4 `bedtime` AI reminder 从不触发

**文件**: `apps/web/lib/decision/engine.ts`

当前行为：`checkSunsetPhase` 在 T-0 阶段广播 `sunset:phase` 后，没有调用 `triggerAiReminder('bedtime')`。

修复：T-0 阶段广播后，立即调用 `triggerAiReminder('bedtime')`。保持现有 5min 冷却逻辑，避免重复触发。

---

### 1.5 `/diary` 页面无导航入口

**文件**: `apps/web/app/page.tsx`、`apps/web/app/settings/page.tsx`

修复：Dashboard 的导航链接区域加入 `/diary` 入口；settings index 同样加入链接。

---

## 二、半成品功能补全

### 2.1 AI 对话摘要生成

**新文件**: `apps/web/lib/ai/summary.ts`

导出函数 `generateConversationSummary(opts?: { start?: number, end?: number })`：

1. 从 `chat_messages` 表取指定时间范围内的消息（默认当天）
2. 若消息数 < 3，跳过（无意义摘要）
3. 调用 DeepSeek，生成一段不超过 200 字的中文摘要，聚焦用户情绪状态、主要话题、AI 干预效果
4. 写入 `ai_conversation_summaries`（`date_range_start`, `date_range_end`, `summary`）

三个调用方：
- **定时任务**：`server.ts` 的每日首次 tick（检测当天是否已有摘要，没有则生成昨天的）
- **事件触发**：`decision/engine.ts` 推断到 `resting` 时，距上次摘要 > 6h 则触发
- **打开对话**：`/api/ai/chat` GET 端点返回历史时，异步触发当天摘要更新

---

## 三、对话历史与用户 Memory 系统

这是本次最重要的新增功能，支撑 AI 的短期上下文连续性和长期用户状态追踪。

### 3.1 新增 DB 表

**文件**: `packages/db/src/schema.ts`

#### `chat_messages` 表

| 列 | 类型 | 说明 |
|----|------|------|
| `id` | INTEGER PK | 自增 |
| `role` | TEXT | `'user'` \| `'assistant'` |
| `content` | TEXT | 消息内容 |
| `created_at` | INTEGER | Unix timestamp |

#### `user_memory` 表

| 列 | 类型 | 说明 |
|----|------|------|
| `id` | INTEGER PK | 自增 |
| `key` | TEXT UNIQUE | memory 维度名 |
| `value` | TEXT | AI 提炼的观察内容（中文自然语言） |
| `updated_at` | INTEGER | 最后更新时间 |

初始 key 集合（`INSERT OR IGNORE` 在启动时预置）：
- `sleep_pattern` — 睡眠规律观察
- `dissociation_pattern` — 解离触发规律  
- `mood_trend` — 近期情绪/状态趋势
- `response_to_intervention` — 用户对 AI 干预的响应倾向

---

### 3.2 对话历史存储

**文件**: `apps/web/app/api/ai/chat/route.ts`

修改现有 POST handler：
1. 请求进入时，将用户消息写入 `chat_messages`（`role: 'user'`）
2. DeepSeek 流式响应完成后，将完整 AI 回复写入 `chat_messages`（`role: 'assistant'`）

新增 GET handler：
- 返回最近 50 条 `chat_messages`，按 `created_at` 升序
- 异步触发 `generateConversationSummary()`（fire and forget）

---

### 3.3 用户 Memory 提炼

**新文件**: `apps/web/lib/ai/memory.ts`

导出函数 `updateUserMemory()`：

1. 读取最近 7 天 `behavior_logs`（聚合：状态分布、解离频次、睡眠时间）
2. 读取最近 20 条 `chat_messages`
3. 读取当前 `user_memory` 所有 key-value（作为"上次观察"传给 AI）
4. 调用 DeepSeek，要求对每个维度输出一句话观察（结构化 JSON 响应）
5. 用 `INSERT OR REPLACE` 更新 `user_memory` 表

触发时机：
- **定时**：`server.ts` 每日首次 tick
- **推断后**：`runInference()` 每次写入 `user_living_context` 后异步触发（有 6h 冷却）

---

### 3.4 Memory 注入 Role Card

**文件**: `apps/web/app/api/ai/chat/route.ts`  
**文件**: `apps/web/lib/ai/roleCard.ts`（新建或修改现有 role card 逻辑）

每次 chat 请求时：
1. 读取 `user_memory` 所有记录
2. 拼接为 `[用户观察]` 段落，附加到系统 role card 末尾
3. 加载最近 50 条 `chat_messages` 作为 messages 历史
4. 发给 DeepSeek

Role card 格式示意：
```
你是 Anchor，用户的数字室友...（现有内容）

[用户观察]
- 睡眠规律：通常凌晨1-2点入睡，近期有所提前
- 解离触发：长时间工作后容易切换到手机
- 干预响应：对轻柔提醒反应较好，强干预会产生抵触
```

---

## 四、`server.ts` 定时任务更新

**文件**: `apps/web/server.ts`

现有 5min tick 基础上，新增每日任务逻辑：

```
每次 tick 时检查：
- 是否是当天首次 tick（对比上次执行日期）
- 是：触发 generateConversationSummary()（昨日）
      触发 updateUserMemory()
- 否：跳过
```

Memory 更新的 6h 冷却通过 `user_memory` 表的 `updated_at` 字段判断，不需要额外状态。

---

## 五、变更文件汇总

| 文件 | 变更类型 |
|------|---------|
| `packages/db/src/schema.ts` | 新增 `chat_messages`、`user_memory` 表 |
| `apps/web/lib/ws/handlers.ts` | 新增 `action:response` case |
| `apps/web/lib/inference/engine.ts` | 修复 `location_zone` 覆写 |
| `apps/web/app/api/ingest/route.ts` | 接受 `location_zone` 字段 |
| `apps/web/lib/circadian/sleep.ts` | 新增 `sunset_compliance` 写回逻辑 |
| `apps/web/lib/decision/engine.ts` | T-0 触发 bedtime reminder；resting 触发摘要+memory更新 |
| `apps/web/app/api/ai/chat/route.ts` | 存储消息；GET 端点；注入 memory 和历史 |
| `apps/web/lib/ai/summary.ts` | 新建：对话摘要生成函数 |
| `apps/web/lib/ai/memory.ts` | 新建：用户 memory 提炼函数 |
| `apps/web/lib/ai/roleCard.ts` | 新建或修改：role card 拼接（含 memory 注入） |
| `apps/web/server.ts` | 每日定时任务：摘要 + memory 更新 |
| `apps/web/app/page.tsx` | 加 `/diary` 导航入口 |
| `apps/web/app/settings/page.tsx` | 加 `/diary` 导航入口 |

---

## 六、不在本次范围内

- 任何 UI 改动（除导航链接）
- WebSocket 前端消费者
- 认证 / 限流
- `packages/types` 中的死类型清理
- `@anchor/ui` / `@anchor/utils` 包内容
- Electron IPC 类型
