import type { LogEntry, FeatureSnapshot, ExtractorConfig } from '@anchor/types'

export interface ExtractOptions {
  isLightweight: boolean
  config: ExtractorConfig
}

const LIGHTWEIGHT_WINDOW_S = 10 * 60
const FULL_WINDOW_S = 2 * 60 * 60
const RECENT_WINDOW_S = 60
const WORK_ACTIVITY_GAP_S = 120

// 「当下在娱乐 App 中」的新鲜度约束：最新前台事件须距今 ≤30s（2 个心跳周期）
// 客户端每 15s 心跳上报当前前台：真实会话被心跳持续续命；
// 孤立事件（秒开/MIUI lastTimeUsed 抖动）30s 后自动失效，不等任何窗口过期
const FUN_APP_FRESH_S = 30

// 判定深度工作段的分心事件类型集合
// 模块级常量：避免每次调用 extractFeatures 时重新分配 Set
const DISTRACTION_TYPES = new Set(['url_visit', 'app_foreground', 'video_state', 'tab_explosion'])

// 判定 is_idle 时，这些 android 事件视为真实交互（抑制 idle）
// screen_off（息屏）是 resting 信号，不算真实交互，不应抑制 idle 判定
// physical_activity 的 activity_type='still' 同理不在此列
const ANDROID_INTERACTION_EVENTS = new Set(['screen_on', 'screen_unlock', 'app_foreground'])

export function extractFeatures(
  allLogs: LogEntry[],
  nowMs: number,
  opts: ExtractOptions
): FeatureSnapshot {
  const nowS = Math.floor(nowMs / 1000)
  const windowS = opts.isLightweight ? LIGHTWEIGHT_WINDOW_S : FULL_WINDOW_S
  const windowStart = nowS - windowS

  const logs = allLogs.filter(l => l.logged_at >= windowStart && l.logged_at <= nowS)

  // 过滤临时网站访问：只保留停留 ≥5 秒的 url_visit，避免搜索结果页/快速关闭标签污染推断
  // 防御性过滤：客户端已有过滤，此处应对历史数据
  const MIN_VISIT_DURATION_S = 5
  const filteredLogs = logs.filter(l => {
    if (l.event_type === 'url_visit') {
      const duration = Number(l.payload['duration_seconds'] ?? 0)
      return duration >= MIN_VISIT_DURATION_S
    }
    return true
  })

  const event_counts: Record<string, number> = {}
  const sources = new Set<string>()
  for (const l of filteredLogs) {
    event_counts[l.event_type] = (event_counts[l.event_type] ?? 0) + 1
    sources.add(l.source)
  }

  const code_active_count = event_counts['code_active'] ?? 0
  const recent_code_active_count = logs.filter(l => l.event_type === 'code_active' && l.logged_at >= nowS - RECENT_WINDOW_S).length
  const latestCodeLog = logs.filter(l => l.event_type === 'code_active').sort((a, b) => b.logged_at - a.logged_at)[0]
  const latest_code_active_at = latestCodeLog?.logged_at ?? null

  // ── 多源工作信号 ─────────────────────────────────────────────
  // Windows 工作进程：process_classifications.is_work ∪ 内置 devToolProcesses（小写子串匹配）
  const workProcessTokens = [...opts.config.workProcesses, ...opts.config.devToolProcesses]
    .map(p => p.toLowerCase())
  const isWorkProcess = (name: string) => {
    const n = name.toLowerCase()
    return workProcessTokens.some(t => n === t || n.includes(t))
  }
  const workFocusLogs = logs.filter(
    l => l.event_type === 'window_focus' &&
         l.payload['is_idle'] !== true &&
         isWorkProcess(String(l.payload['process'] ?? ''))
  )
  const work_app_duration_ms = workFocusLogs
    .reduce((sum, l) => sum + Number(l.payload['duration_ms'] ?? 0), 0)

  // 工作网站：域名命中 workDomains 且非高刺激（高刺激优先，互斥兜底）
  const workDomainSet = new Set(opts.config.workDomains.map(d => d.toLowerCase()))
  const isWorkDomain = (raw: string) => {
    const d = raw.toLowerCase().replace(/^www\./, '')
    if (workDomainSet.has(d)) return true
    // 子域名兜底：mail.github.com 命中 github.com
    for (const w of workDomainSet) { if (d.endsWith('.' + w)) return true }
    return false
  }
  const workVisitLogs = logs.filter(
    l => l.event_type === 'url_visit' &&
         l.payload['high_stimulus'] !== true &&
         isWorkDomain(String(l.payload['domain'] ?? ''))
  )
  const work_visit_count = workVisitLogs.length

  // Android 工作 App 前台
  const android_in_work_app = logs.some(
    l => l.source === 'android' &&
         l.event_type === 'app_foreground' &&
         opts.config.workApps.includes(String(l.payload['packageName'] ?? ''))
  )

  // 统一工作信号判定：deep_work 片段延续 + latest_work_signal 并集共用
  const isWorkSignal = (l: LogEntry): boolean =>
    l.event_type === 'code_active' ||
    (l.event_type === 'window_focus' && l.payload['is_idle'] !== true && isWorkProcess(String(l.payload['process'] ?? ''))) ||
    (l.event_type === 'window_active' && isWorkProcess(String(l.payload['process'] ?? ''))) ||
    (l.event_type === 'url_visit' && l.payload['high_stimulus'] !== true && isWorkDomain(String(l.payload['domain'] ?? ''))) ||
    (l.source === 'android' && l.event_type === 'app_foreground' && opts.config.workApps.includes(String(l.payload['packageName'] ?? '')))

  // 高刺激访问计数
  const high_stimulus_visit_count = logs.filter(
    l => l.event_type === 'url_visit' && l.payload['high_stimulus'] === true
  ).length

  // 娱乐深度：视频观看时长 + 滚动深度 + tab 数归一加权
  const videoSec = logs
    .filter(l => l.event_type === 'video_state')
    .reduce((sum, l) => sum + Number(l.payload['duration_watched_sec'] ?? 0), 0)
  const maxScroll = logs
    .filter(l => l.event_type === 'url_visit')
    .reduce((m, l) => Math.max(m, Number(l.payload['scroll_depth_pct'] ?? 0)), 0)
  const maxTabs = logs
    .filter(l => l.event_type === 'url_visit')
    .reduce((m, l) => Math.max(m, Number(l.payload['tab_count'] ?? 0)), 0)
  const hasEntertainmentSignal = videoSec > 0 || high_stimulus_visit_count > 0
  const entertainment_depth_score = hasEntertainmentSignal
    ? Math.min(1,
        Math.min(1, videoSec / 600) * 0.5 +     // 10 分钟视频封顶
        (maxScroll / 100) * 0.3 +                // 滚动深度
        Math.min(1, maxTabs / 15) * 0.2          // 15 个 tab 封顶
      )
    : 0

  // 注意力碎片化：tab_switch + window_focus 切换速率（每 10 分钟 >= 12 次切换视为高度碎片化，~72 次/h）
  // 速率制：按窗口时长归一，10min 窗口与 2h 窗口共用同一校准阈值
  // 旧阈值 8 次/10min（48/h）会把活跃多任务（查资料/对照文档）误判为注意力漂移
  const switchCount = logs.filter(
    l => l.event_type === 'tab_switch' || l.event_type === 'window_focus'
  ).length
  const attention_fragmentation_score = Math.min(1, (switchCount / (windowS / 600)) / 12)

  // tab 爆炸
  const tab_explosion = logs.some(l => l.event_type === 'tab_explosion')

  // 此刻正在娱乐 App 中：最新前台事件是高刺激包，且新鲜（≤30s 心跳）、晚于最近息屏
  // 最新前台不是高刺激包（已回到桌面/其他 App）或事件超龄（孤立抖动）→ false
  const androidFgLogs = logs.filter(l => l.source === 'android' && l.event_type === 'app_foreground')
  const latestFgLog = [...androidFgLogs].sort((a, b) => b.logged_at - a.logged_at)[0]
  const latestScreenOffAt = logs
    .filter(l => l.source === 'android' && l.event_type === 'screen_off')
    .reduce((m, l) => Math.max(m, l.logged_at), 0)
  const android_fun_app_current = latestFgLog !== undefined &&
    opts.config.highStimulusApps.includes(String(latestFgLog.payload['packageName'] ?? '')) &&
    nowS - latestFgLog.logged_at <= FUN_APP_FRESH_S &&
    latestFgLog.logged_at > latestScreenOffAt

  // Android 解锁频率（次/小时）：始终从 allLogs 取最近 1 小时的截面计算
  // 与窗口无关：轻量/全量模式都正确，且单位始终为「次/小时」
  const oneHourAgo = nowS - 3600
  const unlockCount = allLogs.filter(
    l => l.source === 'android' && l.event_type === 'screen_unlock' && l.logged_at >= oneHourAgo && l.logged_at <= nowS
  ).length
  const android_unlock_rate = unlockCount // 次/小时（已固定为 1h 窗口）

  // 最近一次身体活动
  const latestActivity = logs
    .filter(l => l.source === 'android' && l.event_type === 'physical_activity')
    .sort((a, b) => b.logged_at - a.logged_at)[0]
  const rawActivity = String(latestActivity?.payload['activity_type'] ?? 'unknown')
  const android_physical_activity =
    (['still', 'walking', 'running'].includes(rawActivity) ? rawActivity : 'unknown') as
      FeatureSnapshot['android_physical_activity']

  // 信号合成：麦克风 / 摄像头 / android DND
  const do_not_disturb = logs.some(l => {
    if (l.event_type === 'microphone_active' || l.event_type === 'camera_active') {
      return l.payload['is_active'] === true
    }
    if (l.event_type === 'do_not_disturb') {
      return l.payload['enabled'] === true
    }
    return false
  })

  // 空闲：存在 user_idle 且期间无 android 真实交互
  // 注意：physical_activity 中的 'still' 不用于此处，不应抑制 idle 判定
  const hasAndroidActivity = logs.some(
    l => l.source === 'android' && ANDROID_INTERACTION_EVENTS.has(l.event_type)
  )
  const is_idle = logs.some(l => l.event_type === 'user_idle') && !hasAndroidActivity

  // 深度工作时长：以最后一个工作信号事件为「当前段」的时长（定义：当前正在延续的工作段）
  // 分心事件（url_visit / app_foreground 等）会中断当前段并重置计时
  // 算法：按时间取「最新段」而非「历史最长段」，以反映用户当下的专注状态
  const sortedByTime = [...logs].sort((a, b) => a.logged_at - b.logged_at)
  let segmentStart: number | null = null
  let currentSegmentMs = 0 // 当前段（正在延续，可能为 0：尚未形成实质时长）
  for (const l of sortedByTime) {
    if (isWorkSignal(l)) {
      if (segmentStart === null) segmentStart = l.logged_at
      currentSegmentMs = (l.logged_at - segmentStart) * 1000
    } else if (DISTRACTION_TYPES.has(l.event_type)) {
      segmentStart = null
      currentSegmentMs = 0
    }
  }
  // 最近工作信号（多源并集）超时后清零当前段
  const latestWorkLog = logs.filter(isWorkSignal).sort((a, b) => b.logged_at - a.logged_at)[0]
  if (latestWorkLog && nowS - latestWorkLog.logged_at > WORK_ACTIVITY_GAP_S) currentSegmentMs = 0
  const deep_work_duration_ms = currentSegmentMs

  // 工作势头：git_commit + terminal_active + keystroke 综合（0-1）
  const hasCommit = logs.some(l => l.event_type === 'git_commit')
  const hasTerminal = logs.some(l => l.event_type === 'terminal_active')
  const keystrokeTotal = logs
    .filter(l => l.event_type === 'code_active' && l.payload['event'] === 'keystroke_summary')
    .reduce((sum, l) => sum + Number(l.payload['count'] ?? 0), 0)
  const work_momentum_score = Math.min(1,
    (hasCommit ? 0.4 : 0) +
    (hasTerminal ? 0.3 : 0) +
    Math.min(0.3, keystrokeTotal / 200 * 0.3)
  )

  const latestActivityLog = [...logs].sort((a, b) => b.logged_at - a.logged_at)[0]
  const latest_activity_at = latestActivityLog?.logged_at ?? null
  const latestEntertainmentLog = logs.filter(l =>
    (l.event_type === 'url_visit' && l.payload['high_stimulus'] === true) ||
    (l.event_type === 'video_state' && l.payload['state'] === 'play') ||
    // Android 高刺激 App 前台即视为娱乐信号
    (l.source === 'android' &&
     l.event_type === 'app_foreground' &&
     opts.config.highStimulusApps.includes(String(l.payload['packageName'] ?? '')))
  ).sort((a, b) => b.logged_at - a.logged_at)[0]
  const latest_entertainment_signal_age_s = latestEntertainmentLog ? Math.max(0, nowS - latestEntertainmentLog.logged_at) : null
  const latest_work_signal_age_s = latestWorkLog ? Math.max(0, nowS - latestWorkLog.logged_at) : null

  const activeSources = (['desktop', 'chrome', 'vscode', 'android'] as const)
    .filter(s => sources.has(s))

  return {
    window_start: windowStart,
    window_end: nowS,
    is_lightweight: opts.isLightweight,
    code_active_count,
    recent_code_active_count,
    latest_code_active_at,
    latest_activity_at,
    latest_work_signal_age_s,
    latest_entertainment_signal_age_s,
    deep_work_duration_ms,
    work_momentum_score,
    work_app_duration_ms,
    work_visit_count,
    android_in_work_app,
    high_stimulus_visit_count,
    entertainment_depth_score,
    attention_fragmentation_score,
    tab_explosion,
    android_unlock_rate,
    android_fun_app_current,
    android_physical_activity,
    do_not_disturb,
    is_idle,
    event_counts,
    active_sources: activeSources,
  }
}
