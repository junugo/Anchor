# Anchor Server API 文档

> **Base URL**: `http://localhost:4000`（默认端口，可通过 `PORT` 环境变量修改）
> **协议**: HTTP REST + WebSocket（`/ws`）
> **认证**: 无（本地局域网服务，无鉴权）
> **Content-Type**: `application/json`

---

## 目录

- [状态与节律](#状态与节律)
- [行为摄入](#行为摄入)
- [AI 对话](#ai-对话)
- [时间胶囊](#时间胶囊)
- [解离日记](#解离日记)
- [宵禁配置](#宵禁配置)
- [设置](#设置)
- [FocusLayer 联动](#focuslayer-联动)
- [数据管理](#数据管理)
- [WebSocket 协议](#websocket-协议)

---

## 状态与节律

### `GET /api/status`

获取当前用户推断状态、宵禁阶段和渐进就寝时间。各客户端连接后应先调用此接口初始化本地状态。

**响应**
```json
{
  "inferred_state": "working",
  "location_zone": "desk",
  "screen_active": true,
  "updated_at": 1718000000,
  "progressive_bedtime": 75,
  "target_bedtime": 90,
  "sunset_phase": "off"
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `inferred_state` | `working \| entertaining \| dissociating \| resting \| transitioning` | 推断引擎输出的用户状态 |
| `location_zone` | `desk \| sofa \| bed \| transition \| unknown` | 当前位置区域 |
| `screen_active` | `boolean` | 屏幕是否活跃 |
| `updated_at` | `number \| null` | 状态最后更新时间（Unix 秒） |
| `progressive_bedtime` | `number` | 今晚建议就寝时间（距午夜分钟数，如 75 = 01:15） |
| `target_bedtime` | `number` | 用户设定的目标就寝时间（距午夜分钟数） |
| `sunset_phase` | `"T60" \| "T30" \| "T0" \| "off"` | 当前宵禁阶段；`off` 表示未进入宵禁 |

---

### `GET /api/circadian`

获取最近 7 天节律日志。

**响应** `CircadianLog[]`

```json
[
  {
    "id": 1,
    "date": "2026-06-13",
    "sleep_start": 1718123400,
    "sleep_end": 1718152200,
    "sleep_debt_hours": 1.5,
    "meals_count": 2,
    "left_room_count": 1,
    "sunset_compliance": 25,
    "dissociation_risk_score": 3.2,
    "anchor_ai_summary": null
  }
]
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `sleep_start` | `number \| null` | 入睡时间（Unix 秒）；跨午夜时归属前一天 |
| `sleep_debt_hours` | `number \| null` | 睡眠债务（目标 8h 减实际睡眠） |
| `sunset_compliance` | `number \| null` | 实际入睡相对目标就寝时间的分钟差（正值=迟于目标） |
| `dissociation_risk_score` | `number \| null` | 解离风险分 0–10 |

---

### `POST /api/circadian`

记录节律事件。客户端通过此接口上报生活行为。

**请求体**
```json
{
  "event": "meal",
  "timestamp": 1718000000
}
```

| `event` 值 | 说明 |
|-----------|------|
| `meal` | 记录一次进餐（`meals_count + 1`） |
| `left_room` | 记录一次离开房间（`left_room_count + 1`） |
| `sleep_start` | 记录入睡时间（跨午夜自动归属前一天） |
| `sleep_end` | 记录起床时间，同步计算睡眠债务和宵禁合规度 |
| `wakeup_verified` | 起床物理验证完成，触发 AI 起床提醒 |

`timestamp` 可选，不传则使用服务器当前时间。

**响应** 返回当天最新 `CircadianLog` 行。

---

## 行为摄入

客户端上报行为事件只有两条通道：

1. **实时**：WebSocket `ingest` 消息（见下文 WS 协议章节）——在线时唯一上报方式
2. **补发**：`POST /api/ingest/batch`——断线积压后重连批量补发，客户端按 100 条分块

四端（desktop / chrome / vscode / android）均内置离线队列（上限 500 条，超出 FIFO 淘汰最旧 10%），断线时仅 `ingest` 事件入队，其他交互消息过期无效直接丢弃。

所有事件必须携带 `logged_at`（事件发生时的 Unix 秒），服务器仅在缺失时使用接收时间。

### `POST /api/ingest/batch`

批量写入 `behavior_logs`（单次上限 500 条，超出截断）。补发属历史数据：服务器只落库，不广播 `dev:signal`、不逐条触发推断，全部写完后统一触发一次轻量推断。

**请求体**
```json
{
  "logs": [
    {
      "source": "chrome",
      "event_type": "url_visit",
      "payload": { "url": "https://bilibili.com/video/xxx", "title": "视频标题" },
      "logged_at": 1751721600
    }
  ]
}
```

**响应** `{ "ok": true, "ingested": 1 }`

### 事件字段约定（WS 与 batch 共用）

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `source` | `BehaviorSource` | ✓ | 数据来源（见下方枚举） |
| `event_type` | `BehaviorEventType` | ✓ | 事件类型（见下方枚举） |
| `payload` | `object` | ✓ | 事件附属数据（不包含内容，只含元数据） |
| `logged_at` | `number` | — | 事件发生时的 Unix 秒，缺失用服务器接收时间 |
| `location_zone` | `LocationZone` | — | 当前位置区域，有变化时才传（仅实时 WS 通道生效） |

**`source` 枚举**

| 值 | 客户端 |
|----|-------|
| `desktop` | Windows 桌面端（Tauri） |
| `chrome` | Chrome Extension |
| `vscode` | VS Code Extension |
| `android` | Android App |
| `web` | Web 前端 |
| `manual` | 用户手动记录 |

**`event_type` 枚举**

| 值 | 说明 | 典型来源 |
|----|------|---------|
| `window_focus` | 前台窗口变化，`payload.process` 为进程名 | `desktop` |
| `url_visit` | 浏览器 URL 变化，`payload.url` 为域名 | `chrome` |
| `code_active` | VS Code 编码活动（光标移动/保存/提交） | `vscode` |
| `app_open` | 移动端 APP 前台，`payload.package` 为包名 | `android` |
| `screen_on` | 手机亮屏 | `android` |
| `screen_off` | 手机息屏 | `android` |
| `screen_lock` | 屏幕锁定 | `desktop` / `android` |
| `screen_unlock` | 屏幕解锁 | `desktop` / `android` |
| `key_activity` | 键鼠活动心跳（每分钟一次） | `desktop` |
| `device_distance` | 蓝牙 RSSI 距离，`payload.distance_meters` | `desktop` / `android` |
| `action_response` | 用户响应 AI 推送的操作选项 | `web` |

---

## AI 对话

### `GET /api/ai/chat`

获取最近 50 条对话历史（最旧→最新排序），并异步触发对话摘要生成。

**响应**
```json
{
  "messages": [
    { "role": "user", "content": "今天有点散", "created_at": 1718000000 },
    { "role": "assistant", "content": "听起来你挺累的，渴吗？", "created_at": 1718000010 }
  ]
}
```

---

### `POST /api/ai/chat`

发送消息并以 SSE 流式接收 AI 回复。服务端自动维护对话历史和记忆摘要。

**请求体**
```json
{
  "messages": [
    { "role": "user", "content": "我现在很焦虑" }
  ]
}
```

`messages` 为完整对话上下文（仅 `user` / `assistant` role），服务端取最后一条 `user` 消息存储并拼接历史后转发 DeepSeek。

**响应** `text/event-stream`（SSE），格式与 OpenAI 兼容：
```
data: {"choices":[{"delta":{"content":"渴"}}]}
data: {"choices":[{"delta":{"content":"吗？"}}]}
data: [DONE]
```

**错误** `503` — `DEEPSEEK_API_KEY` 未配置。

---

### `GET /api/ai/memory`

获取 AI 对用户的长期观察记忆（最近 7 天行为提炼，6h 自动更新）。

**响应**
```json
[
  { "id": 1, "key": "sleep_pattern", "value": "通常凌晨 1 点后入睡。", "updated_at": 1718000000 },
  { "id": 2, "key": "dissociation_pattern", "value": "刷手机时容易触发。", "updated_at": 1718000000 },
  { "id": 3, "key": "mood_trend", "value": "近期偏疲惫。", "updated_at": 1718000000 },
  { "id": 4, "key": "response_to_intervention", "value": "对身体感受问题反应较好。", "updated_at": 1718000000 }
]
```

---

### `GET /api/summary`

获取最近 30 条 AI 对话摘要记录（每日自动生成一次）。

**响应** `AiConversationSummary[]`

---

## 时间胶囊

### `GET /api/capsules`

获取全部时间胶囊。

**响应** `TimeCapsule[]`

---

### `POST /api/capsules`

新建时间胶囊。

**请求体**
```json
{
  "content": "我知道你现在不想动，但去喝口水就好",
  "trigger": "wakeup"
}
```

| `trigger` 值 | 触发场景 |
|-------------|---------|
| `deep_night` | 深夜（23:00–05:00）且处于解离状态 |
| `after_break` | 从休息状态恢复到工作状态时 |
| `dissociation` | 检测到解离状态 |
| `wakeup` | 起床物理验证完成后 |

**响应** `201 { "ok": true }`

---

### `DELETE /api/capsules/:id`

删除时间胶囊。

**响应** `{ "ok": true }`

---

### `POST /api/capsules/play`

触发指定触发类型的胶囊播放（随机选一条）。播放后更新 `last_played_at`，并通过 WebSocket 广播 `capsule:play` 消息给所有连接客户端。

**请求体**
```json
{ "trigger": "wakeup" }
```

**响应**
```json
{ "played": true, "content": "去喝口水就好" }
```
若该触发类型无胶囊，返回 `{ "played": false }`。

---

## 解离日记

### `GET /api/diary`

获取最近 20 条**未确认**的解离日记候选（服务端每小时自动生成）。

**响应** `DissociationDiary[]`（`user_choice` 为 `null` 的记录）

```json
[
  {
    "id": 1,
    "period_start": 1718100000,
    "period_end": 1718103600,
    "candidate_label": "14:00–15:00，检测到 23 次活动切换，无明确目标。",
    "user_choice": null,
    "created_at": 1718103600
  }
]
```

---

### `POST /api/diary`

手动创建日记候选（用于客户端直接上报已知解离时段）。

**请求体**
```json
{
  "period_start": 1718100000,
  "period_end": 1718103600,
  "candidate_label": "自定义描述"
}
```

**响应** `201 { "ok": true }`

---

### `PATCH /api/diary/:id`

用户确认解离日记候选。确认后该条记录不再出现在 `GET /api/diary` 中。

**请求体**
```json
{ "user_choice": "attention_break" }
```

| `user_choice` 值 | 含义 |
|----------------|------|
| `active_rest` | 主动休息 |
| `attention_break` | 注意力断裂 |
| `dissociation` | 解离失控 |
| `ignored` | 忽略 |

**响应** `{ "ok": true }`

---

## 宵禁配置

### `GET /api/sunset`

获取宵禁配置。

**响应**
```json
{
  "enabled": true,
  "target_bedtime_minutes": 90,
  "phase_t60_enabled": true,
  "phase_t30_enabled": true,
  "phase_t0_enabled": true,
  "high_stimulus_sites": ["douyin.com", "bilibili.com"],
  "whitelist_processes": [],
  "updated_at": 1718000000
}
```

`target_bedtime_minutes`: 距午夜的分钟数，如 `90` = 01:30，`1380` = 23:00。

---

### `PATCH /api/sunset`

更新宵禁配置（支持部分更新）。更新后立即通过 WebSocket 广播 `sunset:config`。

**请求体**（任意字段子集）
```json
{
  "enabled": true,
  "target_bedtime_minutes": 120,
  "high_stimulus_sites": ["douyin.com", "bilibili.com", "youtube.com"]
}
```

**响应** 返回完整的最新配置（与 `GET` 格式相同）。

---

## 设置

### `GET /api/settings/first-action`

获取起床物理验证完成后的第一动作提示。

**响应** `{ "first_action": "喝水" }`

---

### `PATCH /api/settings/first-action`

设置第一动作。

**请求体** `{ "first_action": "拉开窗帘" }`

**响应** `{ "ok": true }`

---

### `GET /api/settings/focuslayer`

获取 FocusLayer 联动配置。

**响应**
```json
{
  "enabled": false,
  "server_url": null
}
```

---

### `PATCH /api/settings/focuslayer`

启用/禁用 FocusLayer 联动，或更新服务地址（覆盖 `FOCUSLAYER_SERVER_URL` 环境变量）。

**请求体**（任意字段子集）
```json
{
  "enabled": true,
  "server_url": "http://<focuslayer-host>:3000"
}
```

**响应** `{ "ok": true }`

---

### `GET /api/settings/zones`

获取环境锚点区域校准数据（WiFi 信号指纹 / 蓝牙信标信息）。

**响应** 由客户端写入的任意 JSON 对象，初始为 `{}`。

---

### `PUT /api/settings/zones`

更新区域校准数据。客户端（桌面端）在首次引导时采集各区域特征后通过此接口存储。

**请求体** 任意 JSON 对象，结构由客户端定义，建议格式：
```json
{
  "desk": { "wifi_ssid": "HomeWifi", "wifi_rssi": -40, "bt_beacons": [] },
  "sofa": { "wifi_ssid": "HomeWifi", "wifi_rssi": -65, "bt_beacons": [] },
  "bed":  { "wifi_ssid": "HomeWifi", "wifi_rssi": -80, "bt_beacons": [] }
}
```

**响应** `{ "ok": true }`

---

## FocusLayer 联动

> 所有 `/api/focuslayer/*` 接口在 FocusLayer 未配置时返回 `400`。

### `GET /api/focuslayer/sync-out`

返回 Anchor 当前节律数据，供 FocusLayer 主动拉取（无需 FocusLayer 配置）。

**响应**
```json
{
  "circadian": {
    "sleep_debt_hours": 1.5,
    "rhythm_deviation_hours": 2.0,
    "dissociation_risk": 3.2,
    "last_sleep_start": 1718100000
  },
  "environment": {
    "current_zone": "desk",
    "current_mode": "working"
  }
}
```

---

### `POST /api/focuslayer/sync-out`

主动将 Anchor 节律数据推送给 FocusLayer（需 FocusLayer 已配置）。

**响应** `{ "ok": true }` / `400 { "error": "FocusLayer not enabled" }`

---

## 数据管理

### `GET /api/data/export`

导出全部数据为 JSON 文件（触发浏览器下载）。包含节律日志、行为日志、时间胶囊、AI 摘要、宵禁配置。

**响应** `application/json` 附件，文件名格式 `anchor-export-YYYY-MM-DD.json`。

---

### `POST /api/data/purge`

清除指定天数前的行为日志和节律日志。

**请求体**
```json
{
  "older_than_days": 30,
  "confirm": true
}
```

`confirm` 必须为 `true`，防止误操作。`older_than_days` 必须为正整数。

**响应** `{ "ok": true, "purged_before": "2026-05-14" }`

---

## WebSocket 协议

**连接地址**: `ws://localhost:4000/ws`

连接成功后服务端立即推送当前宵禁配置（`sunset:config`），客户端应持久化此配置。服务端每 30 秒发送 `ping`，客户端应回复 `pong`。

### 服务端 → 客户端消息（`WsServerMessage`）

#### `ping`
```json
{ "type": "ping" }
```
心跳检测，客户端回复 `{ "type": "pong" }`。

---

#### `sunset:config`
```json
{
  "type": "sunset:config",
  "config": {
    "enabled": true,
    "target_bedtime_minutes": 90,
    "phase_t60_enabled": true,
    "phase_t30_enabled": true,
    "phase_t0_enabled": true,
    "high_stimulus_sites": ["douyin.com"],
    "whitelist_processes": [],
    "updated_at": 1718000000,
    "progressive_bedtime": 75
  }
}
```
连接时推送一次；`PATCH /api/sunset` 后再次推送。`progressive_bedtime` 为今晚渐进就寝建议时间（分钟数）。

---

#### `sunset:phase`
```json
{ "type": "sunset:phase", "phase": "T60" }
```

| `phase` | 触发条件 | 客户端行为 |
|---------|---------|-----------|
| `T60` | 距就寝 60 分钟 | 屏幕灰度化、通知静默 |
| `T30` | 距就寝 30 分钟 | 高刺激应用增加摩擦、亮度降低 |
| `T0` | 就寝时间到（含 8h 后补偿） | 硬宵禁、仅保留闹钟和白噪音 |
| `off` | 不在宵禁时段（仅 `GET /api/status` 返回，WS 不推送 off） | 恢复正常 |

> 若 FocusLayer 检测到深度心流（`mode === 'deep'` 且已持续 ≥ 20 分钟），`T0` / `T30` 阶段最多延迟 1 小时，期间仅发送 `T60`。

---

#### `env:switch`
```json
{ "type": "env:switch", "zone": "desk", "screen_color_temp": 5000 }
```
当 `location_zone` 变化时广播。客户端据此切换智能灯光色温。

| `zone` | 色温 | 含义 |
|--------|------|------|
| `desk` | 5000K | 工作模式（冷白） |
| `sofa` / `bed` | 2700K | 休息模式（暖黄） |
| `transition` | 4000K | 缓冲/切换模式（中性） |

---

#### `notify:ai`
```json
{
  "type": "notify:ai",
  "message": "现在快 2 点了，需要我把灯调暗吗？",
  "actions": [
    { "label": "好", "id": "sunset:agree" },
    { "label": "再等一会儿", "id": "sunset:delay" }
  ]
}
```
AI 生成的主动提醒。`actions` 可选；若有，客户端展示选项按钮，用户选择后通过 `action:response` 上报。

---

#### `time:anchor`
```json
{ "type": "time:anchor", "text": "现在是下午 3 点 15 分，今天还剩 8 小时 45 分钟。" }
```
解离检测时注射的时间现实感提示。不中断当前操作，以环境信息形式非侵入展示。

---

#### `state:update`
```json
{ "type": "state:update", "state": "working", "confidence": 0.9 }
```
推断引擎每次运行后广播当前用户状态。客户端可据此更新本地状态显示。

---

#### `capsule:play`
```json
{ "type": "capsule:play", "content": "我知道你现在不想动，但去喝口水就好", "trigger": "wakeup" }
```
时间胶囊被触发播放时广播。客户端应显示/朗读胶囊内容。

---

### 客户端 → 服务端消息（`WsClientMessage`）

#### `ingest`
```json
{
  "type": "ingest",
  "source": "chrome",
  "event_type": "url_visit",
  "payload": { "url": "https://bilibili.com" },
  "location_zone": "sofa",
  "logged_at": 1751721600
}
```
实时上报唯一通道。`logged_at` 为事件发生时的 Unix 秒，缺失时服务器用接收时间。断线积压的事件不走 WS，重连后由客户端通过 `POST /api/ingest/batch` 批量补发。

---

#### `action:response`
```json
{ "type": "action:response", "action_id": "sunset:agree", "choice": "done" }
```
用户响应 `notify:ai` 中的操作选项。记录到 `behavior_logs`（`event_type: action_response`）并触发推断引擎。

---

#### `wakeup:verified`
```json
{ "type": "wakeup:verified" }
```
起床物理验证完成（陀螺仪/二维码/蓝牙按钮）。等价于 `POST /api/circadian { "event": "wakeup_verified" }`。触发：记录 `sleep_end`、计算睡眠债务、发送 AI 起床提醒（含第一动作）。

---

#### `pong`
```json
{ "type": "pong" }
```
回复服务端 `ping`。

---

## 数据模型参考

### `BehaviorSource`
`"desktop" | "chrome" | "vscode" | "android" | "web" | "manual"`

### `LocationZone`
`"desk" | "sofa" | "bed" | "transition" | "unknown"`

### `UserState`
`"working" | "entertaining" | "dissociating" | "resting" | "transitioning"`

---

## 服务端内部机制（供开发参考）

### 推断引擎（每次 ingest 触发 + 每 5 分钟定时）

优先级从高到低：

1. **解离**（`dissociating`）：满足以下任一
   - Chrome：最近 2h 内 3+ 次连续不同域名跳转，每次停留 < 2 分钟
   - Android：最近 1h 内亮屏 ≥ 15 次，平均间隔 < 2 分钟
   - 任意来源：最近 2h 内 > 30 次事件，无 `code_active`，无 > 10 分钟的持续 `window_focus`
2. **工作**（`working`）：`code_active` ≥ 3 次，或开发工具窗口持续 > 5 分钟
3. **娱乐**（`entertaining`）：访问高刺激域名（`douyin.com` 等）
4. **休息**（`resting`）：最近 30 分钟无活动，或检测到 `screen_off` / `screen_lock`
5. **过渡**（`transitioning`）：默认回退

### 决策引擎（每次推断后触发）

| 触发条件 | 动作 | 冷却 |
|---------|------|------|
| `resting` → `working` | 播放 `after_break` 胶囊 | 5 分钟 |
| `working` → 其他 | 注意力残留清除仪式（`env:switch transition` + FocusLayer 通知） | 5 分钟 |
| 解离状态 | 时间锚注射 + 播放 `dissociation` 胶囊 + 深夜播 `deep_night` | 5 分钟 |
| 工作状态 | 查询 FocusLayer 心流状态 | 1 分钟 |
| 娱乐状态 | 触发 AI 提醒（含 FocusLayer 活跃任务上下文） | 5 分钟 |
| 每 3 小时（非解离） | 周期性身体感受 check-in | 3 小时 |
| 宵禁相位变化 | 广播 `sunset:phase`，T0 时触发 AI 睡前提醒 | — |
| 生活基础崩溃（每 6 小时检查） | 触发 AI `rescue` 提醒 + FocusLayer 同步 | 6 小时 |

### 每日维护（每天执行一次）
- 生成昨日对话摘要（`ai_conversation_summaries`）
- 强制更新用户 memory（`user_memory`）

### 解离日记候选生成（每小时）
自动分析过去 1 小时行为日志，若满足解离特征则生成候选日记条目，等待用户确认。
