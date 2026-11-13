import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { eq } from 'drizzle-orm'
import { behaviorLogs, closeDb, createDb, userLivingContext } from '@anchor/db'
import { runPipeline, runPipelineGuarded, resetPipelineState, getPipelineRunCount, getPrevState } from './pipeline'
import { reportSleepStart, recordWakeupSession, getTodaySession } from '../sleep/engine'
import { initSunsetConfig, updateSunsetConfig } from '../sunset/config'
import { getDailyContext, resetDailyContext } from '../memory/daily-context'

function tempDb(name: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `anchor-${name}-`))
  return { dir, db: createDb(path.join(dir, 'anchor.db')) }
}

const NOW_MS = 1781956800 * 1000
const NOW_S = 1781956800

test('runPipeline writes inferred working state to user_living_context', async () => {
  const { dir, db } = tempDb('pipeline-working')
  try {
    for (let i = 0; i < 4; i++) {
      db.insert(behaviorLogs).values({
        source: 'vscode', event_type: 'code_active',
        payload: { event: 'keystroke_summary', count: 100 }, logged_at: NOW_S - i * 30,
      }).run()
    }
    await runPipeline(db, { mode: 'full', nowMs: NOW_MS })
    const row = db.select().from(userLivingContext).where(eq(userLivingContext.user_id, 'default')).get()
    assert.equal(row?.inferred_state, 'working')
  } finally {
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('runPipeline returns inference result with state and confidence', async () => {
  const { dir, db } = tempDb('pipeline-return')
  try {
    db.insert(behaviorLogs).values({
      source: 'chrome', event_type: 'url_visit',
      payload: { domain: 'douyin.com', high_stimulus: true }, logged_at: NOW_S - 30,
    }).run()
    db.insert(behaviorLogs).values({
      source: 'chrome', event_type: 'url_visit',
      payload: { domain: 'bilibili.com', high_stimulus: true }, logged_at: NOW_S - 60,
    }).run()
    const result = await runPipeline(db, { mode: 'lightweight', nowMs: NOW_MS })
    assert.equal(result.state, 'entertaining')
    assert.ok(result.confidence > 0)
  } finally {
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('runPipelineGuarded blocks concurrent executions, coalesces pending full', async () => {
  const { dir, db } = tempDb('pipeline-guard')
  resetPipelineState()
  try {
    // 同时发起两个 guarded 调用：第一个立即执行；第二个被重叠防护拦截，
    // 但 full 请求不静默丢弃——置 pending 标志，第一个运行结束后补跑一次
    const [r1, r2] = await Promise.all([
      runPipelineGuarded(db, { mode: 'full', nowMs: NOW_MS }),
      runPipelineGuarded(db, { mode: 'full', nowMs: NOW_MS }),
    ])
    // 两次调用都 void 返回，不抛出
    assert.equal(r1, undefined)
    assert.equal(r2, undefined)
    // runPipeline 共执行 2 次：首次 + 合并补跑的一次 pending full
    assert.equal(getPipelineRunCount(), 2)
    // DB 中 user_living_context 应恰好有一行
    const row = db.select().from(userLivingContext).where(eq(userLivingContext.user_id, 'default')).get()
    assert.ok(row !== undefined)
  } finally {
    resetPipelineState()
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('opening fun app while working flips state to entertaining (not dissociating)', async () => {
  const { dir, db } = tempDb('pipeline-fun-flip')
  resetPipelineState()
  try {
    // 强工作证据 + 高刺激 App 前台心跳（最新前台新鲜）
    db.insert(behaviorLogs).values({
      source: 'vscode', event_type: 'code_active', payload: {}, logged_at: NOW_S - 60,
    }).run()
    db.insert(behaviorLogs).values({
      source: 'android', event_type: 'app_foreground',
      payload: { packageName: 'tv.danmaku.bili', appName: 'bilibili' }, logged_at: NOW_S - 15,
    }).run()
    db.insert(behaviorLogs).values({
      source: 'vscode', event_type: 'code_active', payload: {}, logged_at: NOW_S - 10,
    }).run()

    const result = await runPipeline(db, { mode: 'full', nowMs: NOW_MS })
    // 工作中打开娱乐软件 = 娱乐中（简单分心），不是解离
    assert.equal(result.state, 'entertaining')
    const row = db.select().from(userLivingContext).where(eq(userLivingContext.user_id, 'default')).get()
    assert.equal(row?.inferred_state, 'entertaining')
  } finally {
    resetPipelineState()
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('runPipeline(full) 累加 DailyContext 单例（setDailyContext 接线验证）', async () => {
  const { dir, db } = tempDb('pipeline-daily-ctx')
  const dateStr = new Date(NOW_MS).toISOString().slice(0, 10)
  // 确保单例为空（防止用例间污染）
  resetDailyContext()
  try {
    // 插入 4 个 code_active 事件，触发 working 状态
    for (let i = 0; i < 4; i++) {
      db.insert(behaviorLogs).values({
        source: 'vscode', event_type: 'code_active',
        payload: { event: 'keystroke_summary', count: 100 }, logged_at: NOW_S - i * 30,
      }).run()
    }
    await runPipeline(db, { mode: 'full', nowMs: NOW_MS })
    // 完整 tick 应已调用 setDailyContext，单例不为空且日期匹配
    const ctx = getDailyContext(dateStr)
    assert.equal(ctx.date, dateStr)
    // working 状态下 work_by_hour 总计 >= 1（至少被计入一次）
    const totalWorkTicks = ctx.work_by_hour.reduce((s, n) => s + n, 0)
    assert.ok(totalWorkTicks >= 1, `期望 work_by_hour 总计 >= 1，实际为 ${totalWorkTicks}`)
  } finally {
    resetDailyContext()
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('sleeping 相位短路判断引擎：广播哨兵状态、写哨兵日志、不写 user_living_context、状态机照常推进', async () => {
  const { dir, db } = tempDb('pipeline-sleeping-short')
  resetPipelineState()
  try {
    // 配置隔离：getSunsetConfig 读测试库，避免落到真实 ~/.anchor/anchor.db（runDecision→checkSunsetPhase 读配置）
    initSunsetConfig(db)
    // 预置最近相位为 T0：sleeping/confirming 恒为 T0，跳过广播/睡前提醒副作用，聚焦短路本身
    ;(globalThis as unknown as { __anchorSunsetLastPhase?: string | null }).__anchorSunsetLastPhase = 'T0'
    // 相对真实时钟播种：短路内 runDecision→checkSunsetPhase 的状态机 tick 用真实 now，
    // 固定 NOW_S 会因超过 8h 自动解除被清成 cleared，相位流转断言必然失败
    const realNowS = Math.floor(Date.now() / 1000)
    // 1 小时前点「睡了」→ sleeping 会话（未满 8h，走活跃检测路径）
    reportSleepStart(db, realNowS - 3600)
    // 即使有强工作信号（4 个 code_active，均为白名单活动事件），判断引擎也应被短路
    for (let i = 0; i < 4; i++) {
      db.insert(behaviorLogs).values({
        source: 'vscode', event_type: 'code_active',
        payload: { event: 'keystroke_summary', count: 100 }, logged_at: realNowS - i * 30,
      }).run()
    }
    const result = await runPipeline(db, { mode: 'full', nowMs: NOW_MS })
    // 结果固定为 sleeping，不经过 inferState 的分数竞争
    assert.equal(result.state, 'sleeping')
    assert.equal(result.confidence, 1)
    assert.equal(result.do_not_disturb, true)
    assert.equal(result.needs_ai_arbitration, false)
    // 哨兵状态写入模块级 _prevState（矛盾门控静默 + 恢复段归一前提）
    assert.equal(getPrevState(), 'sleeping')
    // 写一条哨兵日志：时间线消费 inferred_state='sleeping'
    const sentinel = db.select().from(behaviorLogs)
      .where(eq(behaviorLogs.event_type, 'state_inference')).all()
    assert.equal(sentinel.length, 1)
    assert.equal(sentinel[0].inferred_state, 'sleeping')
    assert.equal(sentinel[0].source, 'web')
    // 短路径不写 user_living_context（建库时无行，短路后也不产生行）
    const row = db.select().from(userLivingContext).where(eq(userLivingContext.user_id, 'default')).get()
    assert.equal(row, undefined)
    // 相位流转：短路只断判断引擎，睡眠状态机照常推进——sleeping + 强活动 → wake_observing
    // （2026-10 观察窗机制取代矛盾确认框：首个强活动不解除，窗内第二个才确认起床）
    // 与种子同用 realNowS - 3600（而非真实 now）：避免会话日归属跨日时读错行
    const s = getTodaySession(db, realNowS - 3600)
    assert.equal(s.phase, 'wake_observing')
    assert.equal(s.wake_first_activity_at != null, true)
    assert.equal(s.wake_observe_until_at != null, true)
  } finally {
    resetPipelineState()
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('config.enabled=false 时不短路：残留 sleeping 会话下判断引擎照常运行', async () => {
  const { dir, db } = tempDb('pipeline-disabled-no-short')
  resetPipelineState()
  try {
    initSunsetConfig(db)
    // 关掉宵禁：睡眠状态机不流转（checkSunsetPhase 首行 return），sleeping 会话无法自行解除
    updateSunsetConfig({ enabled: false })
    // 相对真实时钟播种：无状态机推进，固定时钟与真实时钟均不触发 8h 解除，均可安全使用
    const realNowS = Math.floor(Date.now() / 1000)
    // 1 小时前点「睡了」→ sleeping 会话残留
    reportSleepStart(db, realNowS - 3600)
    // 强工作信号（4 个 code_active）：若短路错误生效，判断引擎不会看到这些事件
    for (let i = 0; i < 4; i++) {
      db.insert(behaviorLogs).values({
        source: 'vscode', event_type: 'code_active',
        payload: { event: 'keystroke_summary', count: 100 }, logged_at: realNowS - i * 30,
      }).run()
    }
    const result = await runPipeline(db, { mode: 'full', nowMs: realNowS * 1000 })
    // 不短路：判断引擎正常推断出 working，而不是哨兵 sleeping
    assert.equal(result.state, 'working')
    assert.equal(result.confidence < 1, true)
    // 未写哨兵日志（短路径专属的 state_inference sentinel 不应出现）
    const sentinel = db.select().from(behaviorLogs)
      .where(eq(behaviorLogs.event_type, 'state_inference')).all()
    assert.equal(sentinel.length, 0)
    // 完整 tick 正常写 user_living_context（短路径不做的事，主路径做）
    const row = db.select().from(userLivingContext).where(eq(userLivingContext.user_id, 'default')).get()
    assert.equal(row?.inferred_state, 'working')
  } finally {
    resetPipelineState()
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('醒来（wakeup 解除）后判断引擎恢复：sleeping 归一为 resting 前置状态', async () => {
  const { dir, db } = tempDb('pipeline-wakeup-resume')
  resetPipelineState()
  try {
    // 配置隔离：短路内 runDecision 读配置，必须指向测试库而非真实用户库
    initSunsetConfig(db)
    reportSleepStart(db, NOW_S)
    // 第一次 tick：短路，_prevState 被置为 sleeping
    const sleeping = await runPipeline(db, { mode: 'lightweight', nowMs: NOW_MS })
    assert.equal(sleeping.state, 'sleeping')
    assert.equal(getPrevState(), 'sleeping')
    // 起床验证 → cleared，短路解除
    recordWakeupSession(db, NOW_S + 300)
    // 第二次 tick：恢复正常推断；工作信号应推出 working，
    // 且前置状态是归一后的 resting（而非 sleeping，避免迟滞钉住）
    for (let i = 0; i < 4; i++) {
      db.insert(behaviorLogs).values({
        source: 'vscode', event_type: 'code_active',
        payload: { event: 'keystroke_summary', count: 100 }, logged_at: NOW_S + 300 - i * 30,
      }).run()
    }
    const resumed = await runPipeline(db, { mode: 'full', nowMs: (NOW_S + 300) * 1000 })
    assert.equal(resumed.state, 'working')
    assert.equal(resumed.previous_state, 'resting')
    assert.equal(getPrevState(), 'working')
  } finally {
    resetPipelineState()
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
