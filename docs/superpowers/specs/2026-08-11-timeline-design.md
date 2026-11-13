# 时间轴页面设计

> 2026-08-11 · 状态：已批准（用户确认 v2 视觉稿）

## 目标

新增 Web 页面「时间轴」：以 24h 水平色带展示一天中的状态分段（working/entertaining/dissociating/resting/sleeping/transitioning），标注当日触发的事件（干预、入睡/起床、宵禁、破戒等），并以「档案卡片架」切换查看历史日期。兼顾复盘反思（默认视图）与调试监控（事件流水 + 信号密度）。

## 核心问题：历史状态带无持久化

当前 pipeline 只把推断结果 upsert 到 `user_living_context` 单行快照，日内状态分布存内存 `DailyContext`，跨日丢弃。`behavior_logs.inferred_state` 仅睡眠哨兵行有值。因此需要新增状态分段持久化 + 一次性历史回填（已与用户确认）。

## 数据层

### 新表 `state_segments`（packages/db/src/schema.ts）

| 字段 | 类型 | 说明 |
|---|---|---|
| id | integer pk | |
| state | text | working / entertaining / dissociating / resting / sleeping / transitioning |
| started_at | integer (unix 秒) | 段开始 |
| ended_at | integer (unix 秒), nullable | NULL = 进行中 |
| source | text | 'realtime' / 'backfill' |

**实时写入**：`lib/inference/pipeline.ts` 完整 tick 中，推断结果相对上一段 state_changed 时闭合上一段（写 ended_at）、开新段。睡眠短路路径（相位 sleeping）继续写哨兵日志，同时维护 sleeping 段。

**一次性回填**：脚本 `apps/web/scripts/backfill-state-segments.ts`（tsx 执行）遍历 `behavior_logs`，按小时窗口重放 `extractFeatures` + `inferState`（均为纯函数，直接复用），产出分段写入 `source='backfill'`。回放结果可能与当时真实推断略有偏差，可接受。

### 新表 `intervention_logs`

| 字段 | 类型 | 说明 |
|---|---|---|
| id | integer pk | |
| dispatched_at | integer (unix 秒) | 分发时间 |
| action | text | notify / soft / hard |
| level | text | 干预级别 |
| state | text | 触发时的推断状态 |
| trigger_reason | text | 触发理由（如「娱乐持续 25 分钟」） |
| friction_form_id | text, nullable | 关联摩擦表单 |
| result | text, nullable | NULL → executed / dismissed / expired（WS 回执回填） |

**写入**：`lib/inference/action-dispatcher.ts` `dispatchPlans()` 分发时插入；`lib/ws/handlers.ts` 收到 `intervention_result` 回执时更新 result（不存 dismissed_after_ms）。

## API

`GET /api/timeline?date=YYYY-MM-DD`（缺省 = 今天），返回：

- `segments`: 当日状态段（跨午夜段裁切到当日边界）
- `interventions`: 当日 intervention_logs
- `markers`: 入睡/起床/破戒/睡眠确认（`sunset_sessions` 字段时间戳）、解离时段（`dissociation_diary`）、宵禁相位与 T0 时间（`sunset_sessions.phase` + updated_at）
- `summary`: 各状态总时长、干预计数（按 action 分组）、睡眠起止

另有 `GET /api/timeline/days?from=YYYY-MM-DD&to=YYYY-MM-DD`：批量返回日期区间内每天的迷你摘要（date + 主导状态分段压缩为迷你色条数据 + 是否有数据），供档案卡片架一次拉取一周。

附带修复：`/api/summary/daily` 的 `buildTimeline()` 切换到 `state_segments` 数据源（修掉目前只能显示 sleeping 块的 bug），不改移动端 UI。

## 页面 `(main)/timeline`（视觉以 v2 原型为准）

原型：`.superpowers/brainstorm/vis-1786459792/content/timeline-full-v2.html`

### 布局

- 注册：`NavSidebar.tsx` `NAV_ITEMS` 加一项（`History` 图标，排在「复盘」旁），`(main)` 路由组下新建 `timeline/page.tsx`，自动获得 shell/主题/WS
- 顶部**档案卡片架**：一排日期卡（日期 + 星期 + 当日 24h 迷你色条预览），选中卡 accent 描边 + 上浮；左右箭头按周翻页；「今天」卡在最后，实时更新。卡数据由 `/api/timeline/days` 按周批量拉取
- 左列（约 2/3 宽）：
  - **状态色带**：24h 水平色带，段颜色用现有 `stateColor()` / `STATE_LABELS`；宵禁时段叠加斜纹区；小时刻度 0/3/6/.../24；下方对齐事件标记排（图标圆点）；hover tooltip 显示段/事件详情；滚轮缩放 + 拖拽平移看细节；今天时经 `onWsMessage` 监听 `state:update` 实时延伸当前段
  - **信号密度格**：24 格，每格透明度 = 该小时 behavior_logs 事件量，底色 = 该小时主导状态色
  - **事件流水**：当日事件按时间列表（时间 / 图标 / 描述 / 结果标签：已执行/已绕过/已划掉/破戒/硬干预）
- 右列（约 1/3 宽）：
  - **当日摘要**：各状态时长 + 干预计数
  - **状态分布**：堆叠条 + 百分比图例（含「无数据」灰色部分）
  - **睡眠会话**：入睡 → 起床 → 清除方式流程，宵禁破戒次数，睡眠确认记录
  - **解离候选**：时段 + 时长 + 「去确认」按钮跳 `/diary`

### 样式

复用 `.review-page` 宽容器模式 + 全局 CSS 变量，新增 `.timeline-*` 类（globals.css）。配色全部走现有 token（--color-passive/soft/hard/curfew/sleep + --accent），深浅色模式自动适配。

## 范围外（YAGNI）

- 不展示客户端原始事件流（url_visit 等）——看 `/dev` 页
- 不做状态段的编辑/手动修正
- 不改移动端 SummaryScreen UI
- 不做周/月视图（复盘页已覆盖周级聚合）

## 实现要点

1. `packages/db/src/schema.ts` 加两表 + 自动迁移（initDb）
2. `pipeline.ts` state_changed 时写 state_segments（含首次启动开段、服务重启后接续 open 段）
3. `action-dispatcher.ts` 落库 + `ws/handlers.ts` 回执回填 result
4. 回填脚本（tsx 一次性执行）
5. `/api/timeline` 路由 + 查询函数（packages/db/src/queries/）
6. `timeline/page.tsx` 客户端组件（archive 卡架 + 色带 + 流水 + 右列面板），NavSidebar 注册
7. `/api/summary/daily` 切数据源

## 测试

- `packages/db` / `apps/web` 遵循现有 `tsx --test` 惯例：为 timeline 查询函数（分段裁切、摘要聚合）写单测；为 pipeline 分段写入逻辑写单测（可参考现有 inference 测试）
- 手动验证：启动服务器看当日实时段延伸；跑回填脚本后翻历史日期
