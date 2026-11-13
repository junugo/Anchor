import assert from 'node:assert/strict'
import test from 'node:test'
import type { LogEntry, ExtractorConfig } from '@anchor/types'
import { extractFeatures } from './feature-extractor'

const CONFIG: ExtractorConfig = {
  highStimulusDomains: ['douyin.com', 'bilibili.com', 'youtube.com'],
  highStimulusApps: ['com.ss.android.ugc.aweme', 'tv.danmaku.bili'],
  devToolProcesses: ['code', 'vscode', 'idea', 'terminal'],
  workDomains: ['github.com', 'stackoverflow.com'],
  workApps: ['com.tencent.wework'],
  workProcesses: ['code.exe', 'idea64.exe'],
}

// 固定基准时间：2026-06-17 12:00:00 UTC = 1781956800 秒
const NOW_S = 1781956800
const NOW_MS = NOW_S * 1000

function log(partial: Partial<LogEntry>): LogEntry {
  return {
    source: 'desktop',
    event_type: 'window_focus',
    payload: {},
    logged_at: NOW_S - 60,
    ...partial,
  } as LogEntry
}

test('extractFeatures counts code_active events in window', () => {
  const logs: LogEntry[] = [
    log({ source: 'vscode', event_type: 'code_active', logged_at: NOW_S - 30 }),
    log({ source: 'vscode', event_type: 'code_active', logged_at: NOW_S - 60 }),
    log({ source: 'vscode', event_type: 'code_active', logged_at: NOW_S - 90 }),
  ]
  const snap = extractFeatures(logs, NOW_MS, { isLightweight: true, config: CONFIG })
  assert.equal(snap.code_active_count, 3)
  assert.equal(snap.is_lightweight, true)
})

test('extractFeatures sets window bounds for lightweight (10min) mode', () => {
  const snap = extractFeatures([], NOW_MS, { isLightweight: true, config: CONFIG })
  assert.equal(snap.window_end, NOW_S)
  assert.equal(snap.window_start, NOW_S - 10 * 60)
})

test('extractFeatures sets window bounds for full (2h) mode', () => {
  const snap = extractFeatures([], NOW_MS, { isLightweight: false, config: CONFIG })
  assert.equal(snap.window_start, NOW_S - 2 * 60 * 60)
})

test('extractFeatures excludes logs outside the window', () => {
  const logs: LogEntry[] = [
    log({ source: 'vscode', event_type: 'code_active', logged_at: NOW_S - 30 }),
    // 20 分钟前，超出轻量 10min 窗口
    log({ source: 'vscode', event_type: 'code_active', logged_at: NOW_S - 20 * 60 }),
  ]
  const snap = extractFeatures(logs, NOW_MS, { isLightweight: true, config: CONFIG })
  assert.equal(snap.code_active_count, 1)
})

test('extractFeatures records active_sources and event_counts', () => {
  const logs: LogEntry[] = [
    log({ source: 'vscode', event_type: 'code_active', logged_at: NOW_S - 30 }),
    // 停留 ≥5s 才计入 url_visit（临时访问过滤）
    log({ source: 'chrome', event_type: 'url_visit', payload: { duration_seconds: 30 }, logged_at: NOW_S - 40 }),
  ]
  const snap = extractFeatures(logs, NOW_MS, { isLightweight: true, config: CONFIG })
  assert.deepEqual(snap.event_counts, { code_active: 1, url_visit: 1 })
  assert.ok(snap.active_sources.includes('vscode'))
  assert.ok(snap.active_sources.includes('chrome'))
})

test('high_stimulus_visit_count counts url_visit with high_stimulus flag', () => {
  const logs: LogEntry[] = [
    log({ source: 'chrome', event_type: 'url_visit', payload: { domain: 'douyin.com', high_stimulus: true }, logged_at: NOW_S - 30 }),
    log({ source: 'chrome', event_type: 'url_visit', payload: { domain: 'github.com', high_stimulus: false }, logged_at: NOW_S - 40 }),
    log({ source: 'chrome', event_type: 'url_visit', payload: { domain: 'bilibili.com', high_stimulus: true }, logged_at: NOW_S - 50 }),
  ]
  const snap = extractFeatures(logs, NOW_MS, { isLightweight: true, config: CONFIG })
  assert.equal(snap.high_stimulus_visit_count, 2)
})

test('entertainment_depth_score rises with video watch time, scroll and tab count', () => {
  const logs: LogEntry[] = [
    log({ source: 'chrome', event_type: 'video_state', payload: { domain: 'youtube.com', state: 'play', duration_watched_sec: 600 }, logged_at: NOW_S - 30 }),
    log({ source: 'chrome', event_type: 'url_visit', payload: { domain: 'youtube.com', high_stimulus: true, scroll_depth_pct: 90, tab_count: 12 }, logged_at: NOW_S - 40 }),
  ]
  const snap = extractFeatures(logs, NOW_MS, { isLightweight: true, config: CONFIG })
  assert.ok(snap.entertainment_depth_score > 0.5, `expected > 0.5, got ${snap.entertainment_depth_score}`)
  assert.ok(snap.entertainment_depth_score <= 1)
})

test('entertainment_depth_score is 0 with no entertainment signals', () => {
  const logs: LogEntry[] = [
    log({ source: 'vscode', event_type: 'code_active', logged_at: NOW_S - 30 }),
  ]
  const snap = extractFeatures(logs, NOW_MS, { isLightweight: true, config: CONFIG })
  assert.equal(snap.entertainment_depth_score, 0)
})

test('attention_fragmentation_score rises with frequent tab/window switching', () => {
  const logs: LogEntry[] = []
  for (let i = 0; i < 10; i++) {
    logs.push(log({ source: 'chrome', event_type: 'tab_switch', payload: { switch_interval_ms: 5000 }, logged_at: NOW_S - i * 30 }))
  }
  const snap = extractFeatures(logs, NOW_MS, { isLightweight: true, config: CONFIG })
  assert.ok(snap.attention_fragmentation_score > 0.5, `got ${snap.attention_fragmentation_score}`)
})

test('tab_explosion true when a tab_explosion event present', () => {
  const logs: LogEntry[] = [
    log({ source: 'chrome', event_type: 'tab_explosion', payload: { tab_count: 20, new_tabs_in_last_5min: 8 }, logged_at: NOW_S - 30 }),
  ]
  const snap = extractFeatures(logs, NOW_MS, { isLightweight: true, config: CONFIG })
  assert.equal(snap.tab_explosion, true)
})

test('android_fun_app_current true when high-stimulus app is the fresh latest foreground', () => {
  const logs: LogEntry[] = [
    log({ source: 'vscode', event_type: 'code_active', logged_at: NOW_S - 60 }),
    log({ source: 'android', event_type: 'app_foreground', payload: { packageName: 'com.ss.android.ugc.aweme', appName: '抖音' }, logged_at: NOW_S - 20 }),
  ]
  const snap = extractFeatures(logs, NOW_MS, { isLightweight: true, config: CONFIG })
  assert.equal(snap.android_fun_app_current, true)
})

test('android_fun_app_current false when latest foreground is a normal app', () => {
  const logs: LogEntry[] = [
    log({ source: 'android', event_type: 'app_foreground', payload: { packageName: 'com.android.settings' }, logged_at: NOW_S - 20 }),
  ]
  const snap = extractFeatures(logs, NOW_MS, { isLightweight: true, config: CONFIG })
  assert.equal(snap.android_fun_app_current, false)
})

test('android_unlock_rate computed per hour from screen_unlock events (full window)', () => {
  const logs: LogEntry[] = []
  // 1 小时内 10 次解锁
  for (let i = 0; i < 10; i++) {
    logs.push(log({ source: 'android', event_type: 'screen_unlock', payload: {}, logged_at: NOW_S - i * 6 * 60 }))
  }
  const snap = extractFeatures(logs, NOW_MS, { isLightweight: false, config: CONFIG })
  // 10 次落在过去 1 小时 → rate >= 10
  assert.ok(snap.android_unlock_rate >= 10, `got ${snap.android_unlock_rate}`)
})

test('android_physical_activity reflects latest physical_activity event', () => {
  const logs: LogEntry[] = [
    log({ source: 'android', event_type: 'physical_activity', payload: { activity_type: 'walking', step_count_delta: 200 }, logged_at: NOW_S - 30 }),
  ]
  const snap = extractFeatures(logs, NOW_MS, { isLightweight: true, config: CONFIG })
  assert.equal(snap.android_physical_activity, 'walking')
})

test('do_not_disturb true when microphone active', () => {
  const logs: LogEntry[] = [
    log({ source: 'desktop', event_type: 'microphone_active', payload: { is_active: true, app_name: 'zoom' }, logged_at: NOW_S - 30 }),
  ]
  const snap = extractFeatures(logs, NOW_MS, { isLightweight: true, config: CONFIG })
  assert.equal(snap.do_not_disturb, true)
})

test('do_not_disturb true when android DND enabled', () => {
  const logs: LogEntry[] = [
    log({ source: 'android', event_type: 'do_not_disturb', payload: { enabled: true }, logged_at: NOW_S - 30 }),
  ]
  const snap = extractFeatures(logs, NOW_MS, { isLightweight: true, config: CONFIG })
  assert.equal(snap.do_not_disturb, true)
})

test('is_idle true when user_idle present and no android activity', () => {
  const logs: LogEntry[] = [
    log({ source: 'desktop', event_type: 'user_idle', payload: { idle_seconds: 400 }, logged_at: NOW_S - 30 }),
  ]
  const snap = extractFeatures(logs, NOW_MS, { isLightweight: true, config: CONFIG })
  assert.equal(snap.is_idle, true)
})

// 轻量模式下 android_unlock_rate 应从 1 小时窗口（allLogs）计算，不受 10 分钟窗口限制
test('android_unlock_rate in lightweight mode uses 1-hour window from allLogs', () => {
  const logs: LogEntry[] = []
  // 5 次解锁落在 10-60 分钟之间（超出轻量 10min 窗口，但在 1 小时内）
  for (let i = 1; i <= 5; i++) {
    logs.push(log({ source: 'android', event_type: 'screen_unlock', payload: {}, logged_at: NOW_S - i * 10 * 60 }))
  }
  const snap = extractFeatures(logs, NOW_MS, { isLightweight: true, config: CONFIG })
  // 5 次在 1 小时内 → rate 应 >= 5（若只看 10min 窗口则为 0）
  assert.ok(snap.android_unlock_rate >= 5, `expected >= 5 (1h window), got ${snap.android_unlock_rate}`)
})

// is_idle 不应因 still（静止）physical_activity 而被抑制
test('is_idle true even when android physical_activity is still', () => {
  const logs: LogEntry[] = [
    log({ source: 'desktop', event_type: 'user_idle', payload: { idle_seconds: 400 }, logged_at: NOW_S - 30 }),
    log({ source: 'android', event_type: 'physical_activity', payload: { activity_type: 'still' }, logged_at: NOW_S - 30 }),
  ]
  const snap = extractFeatures(logs, NOW_MS, { isLightweight: true, config: CONFIG })
  assert.equal(snap.is_idle, true)
})

// is_idle 应被真实 android 交互（如 screen_on）抑制
test('is_idle false when android screen_on present', () => {
  const logs: LogEntry[] = [
    log({ source: 'desktop', event_type: 'user_idle', payload: { idle_seconds: 400 }, logged_at: NOW_S - 30 }),
    log({ source: 'android', event_type: 'screen_on', payload: {}, logged_at: NOW_S - 30 }),
  ]
  const snap = extractFeatures(logs, NOW_MS, { isLightweight: true, config: CONFIG })
  assert.equal(snap.is_idle, false)
})

// screen_off 是息屏/resting 信号，不应抑制 is_idle（语义：用户息屏后系统仍应推断 idle）
test('is_idle true when android screen_off present (screen_off is resting signal, not activity)', () => {
  const logs: LogEntry[] = [
    log({ source: 'desktop', event_type: 'user_idle', payload: { idle_seconds: 400 }, logged_at: NOW_S - 30 }),
    log({ source: 'android', event_type: 'screen_off', payload: {}, logged_at: NOW_S - 30 }),
  ]
  const snap = extractFeatures(logs, NOW_MS, { isLightweight: true, config: CONFIG })
  assert.equal(snap.is_idle, true)
})

test('deep_work_duration_ms spans continuous code_active with no distractions', () => {
  // 连续 code_active，跨度 20 分钟，期间无 url_visit / app_foreground
  const logs: LogEntry[] = [
    log({ source: 'vscode', event_type: 'code_active', logged_at: NOW_S - 20 * 60 }),
    log({ source: 'vscode', event_type: 'code_active', logged_at: NOW_S - 10 * 60 }),
    log({ source: 'vscode', event_type: 'code_active', logged_at: NOW_S - 60 }),
  ]
  const snap = extractFeatures(logs, NOW_MS, { isLightweight: false, config: CONFIG })
  // 首尾跨度约 20 分钟 → > 15 分钟
  assert.ok(snap.deep_work_duration_ms >= 15 * 60 * 1000, `got ${snap.deep_work_duration_ms}`)
})

test('deep_work_duration_ms resets when distraction interrupts', () => {
  const logs: LogEntry[] = [
    // 分心前：20 分钟前开始的深度工作（跨度 5 分钟）
    log({ source: 'vscode', event_type: 'code_active', logged_at: NOW_S - 20 * 60 }),
    log({ source: 'vscode', event_type: 'code_active', logged_at: NOW_S - 15 * 60 }),
    // 分心中断
    log({ source: 'chrome', event_type: 'url_visit', payload: { domain: 'douyin.com', high_stimulus: true }, logged_at: NOW_S - 12 * 60 }),
    // 分心后：恢复工作 5 分钟，新段独立计时（起点 NOW_S-5*60，跨度约 4 分钟）
    log({ source: 'vscode', event_type: 'code_active', logged_at: NOW_S - 5 * 60 }),
    log({ source: 'vscode', event_type: 'code_active', logged_at: NOW_S - 60 }),
  ]
  const snap = extractFeatures(logs, NOW_MS, { isLightweight: false, config: CONFIG })
  // 分心后最新段约 4 分钟（< 15 分钟），验证分心确实重置了计时
  assert.ok(snap.deep_work_duration_ms < 15 * 60 * 1000, `got ${snap.deep_work_duration_ms}`)
  // 同时确认新段有实质时长（> 0），即两个事件的跨度被正确计算
  assert.ok(snap.deep_work_duration_ms > 0, `expected > 0, got ${snap.deep_work_duration_ms}`)
})

test('work_momentum_score rises with git_commit, terminal and keystrokes', () => {
  const logs: LogEntry[] = [
    log({ source: 'vscode', event_type: 'git_commit', payload: { files_changed: 3, insertions: 50, deletions: 10 }, logged_at: NOW_S - 60 }),
    log({ source: 'vscode', event_type: 'terminal_active', payload: { command_category: 'build' }, logged_at: NOW_S - 120 }),
    log({ source: 'vscode', event_type: 'code_active', payload: { event: 'keystroke_summary', count: 200 }, logged_at: NOW_S - 180 }),
  ]
  const snap = extractFeatures(logs, NOW_MS, { isLightweight: true, config: CONFIG })
  assert.ok(snap.work_momentum_score > 0.6, `got ${snap.work_momentum_score}`)
})

test('work_momentum_score is 0 with no work signals', () => {
  const snap = extractFeatures([], NOW_MS, { isLightweight: true, config: CONFIG })
  assert.equal(snap.work_momentum_score, 0)
})

// ── 多源工作信号 ──────────────────────────────────────────────

test('work_app_duration_ms sums window_focus duration for work processes', () => {
  const logs: LogEntry[] = [
    // 命中 workProcesses（code.exe）
    log({ source: 'desktop', event_type: 'window_focus', payload: { process: 'Code.exe', duration_ms: 6 * 60 * 1000, is_idle: false }, logged_at: NOW_S - 300 }),
    // 命中 devToolProcesses 子串（terminal）
    log({ source: 'desktop', event_type: 'window_focus', payload: { process: 'WindowsTerminal.exe', duration_ms: 60 * 1000, is_idle: false }, logged_at: NOW_S - 120 }),
    // 非工作进程不计入
    log({ source: 'desktop', event_type: 'window_focus', payload: { process: 'QQMusic.exe', duration_ms: 999 * 1000, is_idle: false }, logged_at: NOW_S - 60 }),
    // 空闲结算不计入
    log({ source: 'desktop', event_type: 'window_focus', payload: { process: 'Code.exe', duration_ms: 999 * 1000, is_idle: true }, logged_at: NOW_S - 30 }),
  ]
  const snap = extractFeatures(logs, NOW_MS, { isLightweight: true, config: CONFIG })
  assert.equal(snap.work_app_duration_ms, 7 * 60 * 1000)
})

test('work_visit_count counts work domains excluding high-stimulus and matching subdomains', () => {
  const logs: LogEntry[] = [
    log({ source: 'chrome', event_type: 'url_visit', payload: { domain: 'github.com', high_stimulus: false }, logged_at: NOW_S - 60 }),
    // 子域名命中 workDomains 的 github.com
    log({ source: 'chrome', event_type: 'url_visit', payload: { domain: 'gist.github.com', high_stimulus: false }, logged_at: NOW_S - 50 }),
    // 高刺激优先，不计入工作访问
    log({ source: 'chrome', event_type: 'url_visit', payload: { domain: 'bilibili.com', high_stimulus: true }, logged_at: NOW_S - 40 }),
    // 未分类域名不计入
    log({ source: 'chrome', event_type: 'url_visit', payload: { domain: 'random-blog.example', high_stimulus: false }, logged_at: NOW_S - 30 }),
  ]
  const snap = extractFeatures(logs, NOW_MS, { isLightweight: true, config: CONFIG })
  assert.equal(snap.work_visit_count, 2)
})

test('android_in_work_app true when work app in foreground', () => {
  const logs: LogEntry[] = [
    log({ source: 'android', event_type: 'app_foreground', payload: { packageName: 'com.tencent.wework' }, logged_at: NOW_S - 30 }),
  ]
  const snap = extractFeatures(logs, NOW_MS, { isLightweight: true, config: CONFIG })
  assert.equal(snap.android_in_work_app, true)
})

test('latest_work_signal_age_s covers work window_focus without code_active', () => {
  const logs: LogEntry[] = [
    log({ source: 'desktop', event_type: 'window_focus', payload: { process: 'idea64.exe', duration_ms: 60_000, is_idle: false }, logged_at: NOW_S - 20 }),
  ]
  const snap = extractFeatures(logs, NOW_MS, { isLightweight: true, config: CONFIG })
  assert.equal(snap.latest_work_signal_age_s, 20)
})

test('latest_work_signal_age_s covers work window_active (驻留心跳保持信号新鲜)', () => {
  const logs: LogEntry[] = [
    log({ source: 'desktop', event_type: 'window_active', payload: { process: 'Code.exe', window_title: 'main.ts' }, logged_at: NOW_S - 20 }),
  ]
  const snap = extractFeatures(logs, NOW_MS, { isLightweight: true, config: CONFIG })
  assert.equal(snap.latest_work_signal_age_s, 20)
  // window_active 无 duration，不计入工作应用时长
  assert.equal(snap.work_app_duration_ms, 0)
})

test('android_fun_app_current true with work window_active nearby (当下性不依赖工作共现)', () => {
  const snap = extractFeatures(
    [
      log({ source: 'desktop', event_type: 'window_active', payload: { process: 'idea64.exe', window_title: 'repo' }, logged_at: NOW_S - 20 }),
      log({ source: 'android', event_type: 'app_foreground', payload: { packageName: 'tv.danmaku.bili' }, logged_at: NOW_S - 25 }),
    ],
    NOW_MS,
    { isLightweight: true, config: CONFIG },
  )
  assert.equal(snap.android_fun_app_current, true)
})

test('deep_work_duration_ms spans work url_visit without code_active', () => {
  // 读技术文档也算深度工作：工作域名 url_visit 延续工作段
  const logs: LogEntry[] = [
    log({ source: 'chrome', event_type: 'url_visit', payload: { domain: 'stackoverflow.com', high_stimulus: false }, logged_at: NOW_S - 10 * 60 }),
    log({ source: 'chrome', event_type: 'url_visit', payload: { domain: 'github.com', high_stimulus: false }, logged_at: NOW_S - 60 }),
  ]
  const snap = extractFeatures(logs, NOW_MS, { isLightweight: false, config: CONFIG })
  assert.ok(snap.deep_work_duration_ms >= 9 * 60 * 1000, `got ${snap.deep_work_duration_ms}`)
})


test('latest_entertainment_signal_age_s is set when android high-stimulus app is in foreground', () => {
  const snap = extractFeatures(
    [log({ source: 'android', event_type: 'app_foreground', payload: { packageName: 'tv.danmaku.bili' }, logged_at: NOW_S - 30 })],
    NOW_MS,
    { isLightweight: true, config: CONFIG },
  )
  assert.ok(snap.latest_entertainment_signal_age_s !== null, 'latest_entertainment_signal_age_s should not be null')
  assert.ok(snap.latest_entertainment_signal_age_s! >= 0, 'age should be non-negative')
  assert.equal(snap.android_fun_app_current, true)
})

test('android_fun_app_current true alongside code_active heartbeats', () => {
  const snap = extractFeatures(
    [
      log({ source: 'vscode', event_type: 'code_active', payload: {}, logged_at: NOW_S - 20 }),
      log({ source: 'android', event_type: 'app_foreground', payload: { packageName: 'tv.danmaku.bili' }, logged_at: NOW_S - 25 }),
    ],
    NOW_MS,
    { isLightweight: true, config: CONFIG },
  )
  assert.equal(snap.android_fun_app_current, true)
  assert.ok(snap.latest_entertainment_signal_age_s !== null)
})

// ── 娱乐当下性（30s 心跳新鲜度）──────────────────────────────

test('android_fun_app_current false when stim foreground event is stale (>30s)', () => {
  // 孤立事件（秒开/MIUI 抖动）：无心跳续命，30s 后自动失效
  const logs: LogEntry[] = [
    log({ source: 'vscode', event_type: 'code_active', logged_at: NOW_S - 90 }),
    log({ source: 'android', event_type: 'app_foreground', payload: { packageName: 'tv.danmaku.bili' }, logged_at: NOW_S - 45 }),
    log({ source: 'vscode', event_type: 'code_active', logged_at: NOW_S - 10 }),
  ]
  const snap = extractFeatures(logs, NOW_MS, { isLightweight: false, config: CONFIG })
  assert.equal(snap.android_fun_app_current, false)
})

test('android_fun_app_current true when heartbeats keep the session fresh', () => {
  // 真实会话：每 15s 一条心跳，最新一条在新鲜度窗口内
  const logs: LogEntry[] = [
    log({ source: 'vscode', event_type: 'code_active', logged_at: NOW_S - 90 }),
    log({ source: 'android', event_type: 'app_foreground', payload: { packageName: 'tv.danmaku.bili' }, logged_at: NOW_S - 75 }),
    log({ source: 'android', event_type: 'app_foreground', payload: { packageName: 'tv.danmaku.bili' }, logged_at: NOW_S - 45 }),
    log({ source: 'android', event_type: 'app_foreground', payload: { packageName: 'tv.danmaku.bili' }, logged_at: NOW_S - 15 }),
    log({ source: 'vscode', event_type: 'code_active', logged_at: NOW_S - 10 }),
  ]
  const snap = extractFeatures(logs, NOW_MS, { isLightweight: false, config: CONFIG })
  assert.equal(snap.android_fun_app_current, true)
})

test('android_fun_app_current false when user left stim app (newer non-stim foreground)', () => {
  // 按 Home 键离开：launcher 心跳覆盖刺激事件
  const logs: LogEntry[] = [
    log({ source: 'android', event_type: 'app_foreground', payload: { packageName: 'tv.danmaku.bili' }, logged_at: NOW_S - 25 }),
    log({ source: 'android', event_type: 'app_foreground', payload: { packageName: 'com.miui.home' }, logged_at: NOW_S - 10 }),
  ]
  const snap = extractFeatures(logs, NOW_MS, { isLightweight: true, config: CONFIG })
  assert.equal(snap.android_fun_app_current, false)
})

test('android_fun_app_current false when screen_off is newer than stim event', () => {
  // 放下手机（息屏）：当下性立即结束
  const logs: LogEntry[] = [
    log({ source: 'android', event_type: 'app_foreground', payload: { packageName: 'tv.danmaku.bili' }, logged_at: NOW_S - 20 }),
    log({ source: 'android', event_type: 'screen_off', payload: {}, logged_at: NOW_S - 10 }),
  ]
  const snap = extractFeatures(logs, NOW_MS, { isLightweight: true, config: CONFIG })
  assert.equal(snap.android_fun_app_current, false)
})

// ── 分心度窗口归一 ────────────────────────────────────────────

test('attention_fragmentation_score stays low for 20 switches across 2h full window', () => {
  // 2h 内 20 次切换：速率 1.67 次/10min，正常工作节奏，不应判高度碎片化
  const logs: LogEntry[] = []
  for (let i = 0; i < 20; i++) {
    logs.push(log({ event_type: 'window_focus', payload: { process: 'Code.exe' }, logged_at: NOW_S - i * 6 * 60 }))
  }
  const snap = extractFeatures(logs, NOW_MS, { isLightweight: false, config: CONFIG })
  assert.ok(snap.attention_fragmentation_score < 0.3, `got ${snap.attention_fragmentation_score}`)
})

test('attention_fragmentation_score saturates for 12 switches within 10min lightweight window', () => {
  const logs: LogEntry[] = []
  for (let i = 0; i < 12; i++) {
    logs.push(log({ source: 'chrome', event_type: 'tab_switch', logged_at: NOW_S - i * 45 }))
  }
  const snap = extractFeatures(logs, NOW_MS, { isLightweight: true, config: CONFIG })
  assert.equal(snap.attention_fragmentation_score, 1)
})
