# 渐进式宵禁锚点（progressive anchor_mode）设计

> 2026-09-18 v1 跟随式（已证伪）→ **2026-10-01 v2 领走式（当前实现，392 测试全过）**

## v2 重构：跟随式 → 领走式（2026-10-01）

### 生产诊断（v1 失效证据）

v1 上线 11 天（anchor_mode=progressive，ideal 23:00，step 15）：引擎每日运行，决策 = 1 次 resync + 5 次 retreat + 6 次 hold，**advance 0 次**，锚点 03:00 → 05:17（净推迟 137 分钟，方向与目标相反）。用户反馈「入睡维持在宵禁时，没有提前」。

根因（鸡生蛋）：v1 candidate = 中位数 − 15 是跟随器，advance 触发条件「中位数睡到锚点之前」12 晚中 0 晚满足；resync（gap>60）启用首日把锚点从 03:00 拽回 04:22，此后锚点只剩「认证真实入睡点」功能。次要失真：00:02 运行时数据滞后 2 晚；夜间窗口 [18:00,06:00] 把 06:05–06:37 真实入睡当 phantom 丢弃。

### v2 决策算法（lib/sunset/progressive.ts）

参数：GRACE=30min（合规宽限）、LEAD_MAX=90min（领走上限）、RESYNC_GAP=180min、RETREAT 周预算 30min、STEP 15min（可配置）。

每日 00:02 基于**最近一个已完成夜晚**的检测入睡点判定（滞后 1 晚，单晚噪声天然平滑）：

1. 无入睡数据 → hold（静默）
2. `signedDelta(anchor, median) > 180`（中位数持续脱节，防单晚极端）→ **resync** 回 `chaseCandidateMinutes(median, ideal, step)`，不烧预算
3. 昨晚入睡 `≤ anchor + 30`（合规）→ **advance**：`chaseCandidateMinutes(anchor, ideal, step)` 向 ideal 领走一步；前进后 `signedDelta(candidate, median) > 90` → 原地等用户（hold）
4. 昨晚入睡 `> anchor + 30` 且 `≤ anchor + 90` → **hold**（原地施压：今晚 T60/T30/T15/T0 全部在锚点时刻触发）
5. 昨晚入睡 `> anchor + 90` → **retreat** 阀门：`allow = min(gap − 90, 预算剩余, step)`；`allow ≤ 0` → hold

环形语义沿用 signedDelta；日志沿用 `sunset_anchor_adjusted`（payload 增 sleep_minutes/gap_minutes/grace_minutes/lead_max_minutes），retreat 才计周预算。

### v2 数据管道修复

- 新增 `loadLastSleepStart(db)`：最近一个有 sleep_start 的睡眠日行，本地分钟 ∈ [17:00, 11:00) 才采信（挡 11:55 phantom 午睡，保留 06:32 真实熬夜）
- `loadNightMedianSleepStart` 夜间窗口 [18:00, 06:00) → [18:00, 10:00)：06:05–06:37 真实入睡计入中位数
- `computeProgressiveBedtime`（今晚建议）镜像引擎：progressive 模式下昨晚合规/数据不足 → 锚点再前一步；睡晚 → 显示当前锚点

### 落地后推演（生产数据）

锚点 05:17：睡 05:47 前 → 次日 05:02；睡 06:32 → 原地 05:17 施压。到 23:00 需 25 个合规夜晚，锚点全程 ≤90min 领先、不脱离现实。

### 已知边界（下一根杠杆，本次不动）

数据显示用户会睡过 T0 锚点 +60min 而不改变行为——领走后若仍被无视，需评估 T0/T15 干预强度（当前 T0 是确认禁令提醒，非强制入睡）。

---

## v1 原始设计（跟随式，已被 v2 取代，留档）

## 背景与目标

原宵禁系统每天按固定时间（`target_bedtime_minutes`）硬切倒数，用户希望宵禁能**帮助作息逐步回正**，而不是每天同一时刻强制执行。项目章程「节律重建器：15 分钟/天睡眠校正」的落地。

## 已确认决策（头脑风暴四问）

| 问题 | 决策 |
|------|------|
| 推进机制 | **跟随式**：锚点 = min(近 7 晚入睡中位数朝 ideal 侧偏移 step, 理想就寝)。实际入睡提前锚点才提前，不达标自然停住 |
| 倒退策略 | **限速倒退**：每周最多退 30min（滚动 7 天预算）；锚点与中位数的环形距离永不超 60min；已脱节时 resync 直接重锚（修复行为，不烧预算） |
| 步幅 | 15min/天（可配置，5–60） |
| 目标字段 | **独立理想就寝** `ideal_bedtime_minutes`（默认 23:30 = 1410），`target_bedtime_minutes` 在 progressive 模式下作为「托管锚点」载体 |

## 核心架构：锚点托管模型

渐进引擎**不触碰任何倒数/相位/睡眠探测逻辑**，每日一次计算新锚点并写回 `sunset_config.target_bedtime_minutes`。下游 `resolveSunsetAnchor → T60/T30/T15/T0 → enterCurfeeByClock` 零改动：

- `resolveSunsetAnchor`（lib/sleep/pattern.ts）`mode === 'progressive'` 分支：返回 `config.target_bedtime_minutes`（等价 config_hard 读托管值）
- **隔离红线**：`predictSleepWindow` 学习带（被动入睡探测）完全不吃钳制——progressive 只碰倒数锚点（2026-09-10 T-60 事故教训）
- 副作用红利：`sunset_compliance` 自然变为「对当前渐进锚点的每日合规度」；`broadcastSunsetConfigNow()` 让客户端倒数立即刷新；`sunset:config` 已全量下发新字段，客户端零改动

## 渐进引擎（lib/sunset/progressive.ts）

### 数据

近 7 个**已结束**睡眠日（排除今天）`circadian_logs.sleep_start`，18:00–06:00 夜间过滤（phantom 防护），旋转到线性空间取**中位数**再转回（跨午夜环绕正确），**≥3 晚**才算，不足不动。

### 决策（纯函数 `decideProgressiveAnchor`，无时钟无副作用）

环形语义：`signedDelta(a,b) ∈ [-720,720)`，禁止裸数值比大小。

1. 候选 `candidate = chaseCandidateMinutes(median, ideal, step)`：median 朝 ideal 侧偏移 step，不越过 ideal（环形）
2. `candidate == anchor` → **hold**（中位数未提前，自然停住）
3. 候选更早、或更晚但 |p| 不增（超前侧放松回 ideal）→ **advance**，不设限
4. 候选更晚且离 ideal 更远 → 倒退路径：
   - `gap = signedDelta(anchor, median) > 60` → **resync**：直接重锚到候选（启用初期/中位数单日大跳；不烧预算）
   - 否则 `allow = min(需退量, 预算剩余(30−已用), 可行性(60−gap))`；`allow ≤ 0` → **hold**；否则 **retreat** 移动 `allow`

### 应用（`applyDailyProgressiveAdjustment`）

挂载于 `server.ts` 跨日归档块（reconcile 之后，吃清洗后数据）。仅 `anchor_mode === 'progressive'` 生效。有变动则：`updateSunsetConfig`（globalThis 缓存失效内置）→ 写 `behavior_logs`（`sunset_anchor_adjusted`，payload 含 from/to/median/ideal/direction/moved_minutes/retreat_used_minutes，retreat 预算从该日志滚动回算）→ `broadcastSunsetConfigNow()`。

### `computeProgressiveBedtime` 语义升级

lib/circadian/sleep.ts 中原 `avg−15`、午夜地板逻辑废弃，改为与引擎共用 `chaseCandidateMinutes`——progressive 模式下「今晚建议」（/api/status、WS `sunset:config` 的 `progressive_bedtime`）与实际触发锚点天然一致；数据不足回退当前配置锚点（旧硬编码 90）。

## Schema

`sunset_config` 新增两列（client.ts migrations 数组，ALTER TABLE 模式）：

- `ideal_bedtime_minutes` INTEGER NOT NULL DEFAULT 1410（23:30，对应 06:50 校起床约 7h20m 睡眠）
- `progressive_step_minutes` INTEGER NOT NULL DEFAULT 15

`SunsetAnchorMode` 枚举加 `'progressive'`（packages/types）。

## UI（settings/sunset）

- 锚点模式第 4 个 radio：「渐进调整 — 锚点每天朝理想就寝跟随一步，由系统托管」
- progressive 选中时：目标就寝卡片变只读（「当前锚点 · 自动管理」）；新增「理想就寝」卡片（步进器 + 预设）与「每日步幅」步进（5–60min）；宵禁阶段时间轴注明时刻随托管锚点每日微调
- 旧快照缺渐进字段时前端补默认值，避免假 dirty

## 边界与明确不做

- 冷启动（<3 晚）：锚点不动；启用 progressive 首日若锚点超前现实 >60min → resync 到「中位数前方 step」起步，无跳变焦虑
- 到达 ideal：停住，行为等价 config_hard@ideal（不自动切模式）
- 不做工作日/周末双目标、打卡判定、客户端改动（YAGNI）
- 默认行为不变：`anchor_mode` 默认仍 `config_hard`，progressive 需设置页主动开启

## 风险对照（已有事故教训）

| 事故 | 对策 |
|------|------|
| T-60 提前（学习带污染倒数） | progressive 与学习带互斥路径，学习带只服务被动探测 |
| phantom 拉偏（05:25 事故） | 中位数 + 夜间过滤 + ≥3 晚 + reconcile 后计算 + 排除今天 |
| 双模块实例配置缓存 | 复用 updateSunsetConfig 既有 globalThis 方案 |
| 9/8 宵禁复活 | 渐进只动 target_bedtime，wakeup 压制逻辑不动 |

## 测试

`lib/sunset/progressive.test.ts`（23 例）：signedDelta 环形、chase 各方向、decide 全分支（hold/advance/arrive/resync/retreat 限速/预算耗尽/可行性钳制）、中位数加载（跨午夜/phantom/排除今天）、预算回算、apply 集成（模式空转 + 写回与日志）。`sleep.test.ts` 两例更新为新语义。全量 387 过，构建与 lint 干净。
