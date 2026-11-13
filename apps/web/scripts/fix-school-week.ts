/**
 * 开学周数据修复（2026-08-31 ~ 2026-09-05）——一次性脚本。
 *
 * 背景：08-31 起上学日白天无设备信号，旧系统把空白误判成：
 *   1) phantom sleeping——午间 winddown 行撞时钟 T0 → curfew → confirming → sleeping，
 *      白天被记成睡眠（睡眠时长虚增到 15h+）；
 *   2) 干预轰炸——winddown/cleared 行 stage=T0 让「就寝后 N 分钟未睡」在白天反复触发
 *      （9/2 一天 138 条硬干预）；
 *   3) circadian 污染——sleep_start 被 phantom 覆盖、sleep_end 长期 NULL、
 *      sunset_compliance 出现 +416 之类的荒谬值、progressive_bedtime 漂到 05:25。
 *
 * 前置：已部署 away 状态 + 睡眠引擎校时段适配 + replay away 规则。
 * 幂等：可重复执行（删 phantom 与重建 backfill 段都是幂等操作）。
 *
 * 运行：cd apps/web
 *   pnpm tsx scripts/fix-school-week.ts           # dry-run：只打印将做什么
 *   pnpm tsx scripts/fix-school-week.ts --apply   # 实写
 */
import { loadEnvFile } from 'node:process'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
try {
  loadEnvFile(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env'))
} catch { /* .env 不存在时忽略 */ }

import { and, eq, gte, isNull, like, lt, or, sql } from 'drizzle-orm'
import { behaviorLogs, circadianLogs, interventionLogs, schoolSchedule, stateSegments, sunsetSessions, userMemory } from '@anchor/db'
import { getDb, initDb } from '../lib/db'
import { initSunsetConfig } from '../lib/sunset/config'
import { initSchoolSchedule } from '../lib/school/schedule'
import { replayStateSegments } from '../lib/timeline/replay'
import { updateSleepMetrics, updateSunsetCompliance } from '../lib/circadian/sleep'
import { userZonedTimeToUtc } from '../lib/time/user-time'

const APPLY = process.argv.includes('--apply')
const DAY = 86400

/** 上学日（周一~周五） */
const SCHOOL_DATES = ['2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03', '2026-09-04']
/** 周六：只清理 phantom，不写 away */
const SATURDAY = '2026-09-05'

const fmt = (s: number | null | undefined) =>
  s == null ? 'NULL' : new Date(s * 1000).toLocaleString('zh-CN', { timeZone: process.env.ANCHOR_TZ ?? 'Asia/Shanghai', hour12: false })

let steps = 0
function log(title: string): void {
  steps++
  console.log(`\n── 步骤 ${steps}: ${title} ${APPLY ? '(实写)' : '(dry-run)'} ──`)
}

async function main(): Promise<void> {
  initDb()
  const db = getDb()
  initSunsetConfig(db)
  initSchoolSchedule(db)

  // ── 0. 学校日程锚定学期起点：防止未来 replay 把开学前的 weekday 空白也标成 away ──
  log('school_schedule.term_start = 2026-08-31')
  const cfgRow = db.select().from(schoolSchedule).get()
  console.log(`  当前: enabled=${cfgRow?.enabled} term_start=${cfgRow?.term_start ?? 'NULL'} leave=${cfgRow?.leave_minute} home=${cfgRow?.home_minute} wake=${cfgRow?.wake_estimate_minute}`)
  if (APPLY && cfgRow && cfgRow.term_start == null) {
    db.update(schoolSchedule)
      .set({ term_start: '2026-08-31', updated_at: Math.floor(Date.now() / 1000) })
      .where(eq(schoolSchedule.id, cfgRow.id))
      .run()
    console.log('  ✓ 已写入 term_start')
  }
  // 窗口分钟读配置（设置页可调），缺省回退默认值
  const WAKE_MIN = cfgRow?.wake_estimate_minute ?? 410
  const LEAVE_MIN = cfgRow?.leave_minute ?? 420
  const HOME_MIN = cfgRow?.home_minute ?? 1050

  // ── 1. 删除 phantom sleeping 哨兵日志（防 replay 复活 phantom sleeping 段） ──
  log('删除白天 phantom sleeping 哨兵日志（behavior_logs.state_inference/sleeping）')
  const windows: Array<{ date: string; fromS: number; toS: number }> = SCHOOL_DATES.map(d => ({
    date: d,
    fromS: userZonedTimeToUtc(d, WAKE_MIN),
    toS: userZonedTimeToUtc(d, 0) + DAY,
  }))
  // 周六：真实入睡 ~04:11（circadian 9/4 行），8h 自动解除点之后的哨兵才是 phantom
  const satRow = db.select().from(circadianLogs).where(eq(circadianLogs.date, '2026-09-04')).get()
  const satPhantomCut = (satRow?.sleep_start ?? userZonedTimeToUtc(SATURDAY, 4 * 60 + 11)) + 8 * 3600
  windows.push({ date: SATURDAY, fromS: satPhantomCut, toS: userZonedTimeToUtc(SATURDAY, 0) + DAY })

  for (const w of windows) {
    const c = db
      .select({ c: sql<number>`count(*)` })
      .from(behaviorLogs)
      .where(and(
        eq(behaviorLogs.source, 'web'),
        eq(behaviorLogs.event_type, 'state_inference'),
        eq(behaviorLogs.inferred_state, 'sleeping'),
        gte(behaviorLogs.logged_at, w.fromS),
        lt(behaviorLogs.logged_at, w.toS),
      ))
      .get()?.c ?? 0
    console.log(`  ${w.date} [${fmt(w.fromS)} ~ ${fmt(w.toS)}): ${c} 条`)
    if (APPLY && c > 0) {
      db.delete(behaviorLogs)
        .where(and(
          eq(behaviorLogs.source, 'web'),
          eq(behaviorLogs.event_type, 'state_inference'),
          eq(behaviorLogs.inferred_state, 'sleeping'),
          gte(behaviorLogs.logged_at, w.fromS),
          lt(behaviorLogs.logged_at, w.toS),
        ))
        .run()
    }
  }

  // ── 2. 清理 phantom sleeping 段（state_segments） ──
  log('清理 state_segments 中的 phantom sleeping 段')
  for (const w of windows) {
    // a) 起点在窗口内的 sleeping 段 = 纯 phantom（午间 phantom 会话 / 8h 后的复活）
    const pure = db
      .select()
      .from(stateSegments)
      .where(and(
        eq(stateSegments.state, 'sleeping'),
        gte(stateSegments.started_at, w.fromS),
        lt(stateSegments.started_at, w.toS),
      ))
      .all()
    console.log(`  ${w.date} 纯 phantom sleeping 段 ${pure.length} 条: ${pure.map(s => `${fmt(s.started_at)}→${fmt(s.ended_at)}`).join(' | ') || '(无)'}`)
    if (APPLY) {
      for (const s of pure) db.delete(stateSegments).where(eq(stateSegments.id, s.id)).run()
    }
    // b) 起点在窗口前、延伸进窗口的 sleeping 段 = 真实夜间睡眠被拖到白天 → 截断到解除点
    const spanning = db
      .select()
      .from(stateSegments)
      .where(and(
        eq(stateSegments.state, 'sleeping'),
        lt(stateSegments.started_at, w.fromS),
        or(isNull(stateSegments.ended_at), gte(stateSegments.ended_at, w.fromS)),
      ))
      .all()
    for (const s of spanning) {
      console.log(`  ${w.date} 截断 sleeping 段 #${s.id}: ${fmt(s.started_at)}→${fmt(s.ended_at)} ⇒ ended_at=${fmt(w.fromS)}`)
      if (APPLY) {
        db.update(stateSegments).set({ ended_at: w.fromS }).where(eq(stateSegments.id, s.id)).run()
      }
    }
  }

  // ── 3. 上学窗口内非 away 段修剪/切分（如 9/2 的白天 resting 实时段） ──
  log('修剪上学窗口 [07:00, 17:30) 内的非 away 段')
  for (const d of SCHOOL_DATES) {
    const leaveS = userZonedTimeToUtc(d, LEAVE_MIN)
    const homeS = userZonedTimeToUtc(d, HOME_MIN)
    const overlapping = db
      .select()
      .from(stateSegments)
      .where(and(
        lt(stateSegments.started_at, homeS),
        or(isNull(stateSegments.ended_at), gte(stateSegments.ended_at, leaveS)),
      ))
      .all()
      .filter(s => s.state !== 'away')
    for (const s of overlapping) {
      const sEnd = s.ended_at ?? Number.MAX_SAFE_INTEGER
      if (s.started_at >= leaveS && sEnd <= homeS) {
        console.log(`  ${d} 删除窗口内段 #${s.id} ${s.state} ${fmt(s.started_at)}→${fmt(s.ended_at)}`)
        if (APPLY) db.delete(stateSegments).where(eq(stateSegments.id, s.id)).run()
      } else if (s.started_at < leaveS && sEnd > homeS) {
        console.log(`  ${d} 切分跨窗段 #${s.id} ${s.state}: [${fmt(s.started_at)}→${fmt(leaveS)}) + [${fmt(homeS)}→${fmt(s.ended_at)})`)
        if (APPLY) {
          db.update(stateSegments).set({ ended_at: leaveS }).where(eq(stateSegments.id, s.id)).run()
          db.insert(stateSegments).values({ state: s.state, started_at: homeS, ended_at: s.ended_at, source: s.source, last_seen_at: s.last_seen_at }).run()
        }
      } else if (s.started_at < leaveS) {
        console.log(`  ${d} 左截断段 #${s.id} ${s.state}: ended_at=${fmt(leaveS)}`)
        if (APPLY) db.update(stateSegments).set({ ended_at: leaveS }).where(eq(stateSegments.id, s.id)).run()
      } else {
        console.log(`  ${d} 右截断段 #${s.id} ${s.state}: started_at=${fmt(homeS)}`)
        if (APPLY) db.update(stateSegments).set({ started_at: homeS }).where(eq(stateSegments.id, s.id)).run()
      }
    }
  }

  // ── 4. replay 重建 8/31~9/5 空档（校时段零事件小时 → away；有事件小时 → 真实推断） ──
  if (APPLY) {
    log('replayStateSegments 回填 8/31 ~ 9/5')
    for (const d of [...SCHOOL_DATES, SATURDAY]) {
      const dayStart = userZonedTimeToUtc(d, 0)
      const r = replayStateSegments(db, dayStart, Math.min(dayStart + DAY, Math.floor(Date.now() / 1000)))
      console.log(`  ${d}: 扫描 ${r.hours} 小时，写入 ${r.written} 段`)
    }
  } else {
    log('replayStateSegments 回填 8/31 ~ 9/5（dry-run 跳过，实写时执行）')
  }

  // ── 5. 写入精确 away 段 [07:00, 17:30)（替换 replay 的整点 away，对齐到日程分钟） ──
  log('写入精确 away 段 [07:00, 17:30)')
  for (const d of SCHOOL_DATES) {
    const leaveS = userZonedTimeToUtc(d, LEAVE_MIN)
    const homeS = userZonedTimeToUtc(d, HOME_MIN)
    if (APPLY) {
      db.delete(stateSegments)
        .where(and(
          eq(stateSegments.source, 'backfill'),
          lt(stateSegments.started_at, homeS),
          or(isNull(stateSegments.ended_at), gte(stateSegments.ended_at, leaveS)),
        ))
        .run()
      db.insert(stateSegments)
        .values({ state: 'away', started_at: leaveS, ended_at: homeS, source: 'backfill' })
        .run()
    }
    console.log(`  ${d}: away ${fmt(leaveS)} → ${fmt(homeS)}`)
  }

  // ── 6. sunset_sessions 结算 ──
  log('sunset_sessions：上学夜行按起床估算结算 school_departure，清 phantom')
  // 睡眠日 D 的起床 = D+1 早晨 06:50（WAKE_MIN）。
  // 8/30 行的真实入睡（8/31 03:10:49）可从 session 行恢复——circadian 行被 phantom 覆盖但 session 行保留了原值
  const settlements: Array<{ date: string; wakeDate: string }> = [
    { date: '2026-08-30', wakeDate: '2026-08-31' },
    { date: '2026-08-31', wakeDate: '2026-09-01' },
    { date: '2026-09-01', wakeDate: '2026-09-02' },
    { date: '2026-09-02', wakeDate: '2026-09-03' },
    { date: '2026-09-03', wakeDate: '2026-09-04' },
  ]
  for (const s of settlements) {
    const row = db.select().from(sunsetSessions).where(eq(sunsetSessions.date, s.date)).get()
    const wakeS = userZonedTimeToUtc(s.wakeDate, WAKE_MIN)
    // 真实入睡时刻：优先 session 行（circadian 行可能被当日午间 phantom 覆盖，如 8/30 的 11:55），
    // 回退 circadian 行
    const circ = db.select().from(circadianLogs).where(eq(circadianLogs.date, s.date)).get()
    const realSleepStart = row?.sleep_start_at ?? circ?.sleep_start ?? null
    console.log(`  session ${s.date}: phase=${row?.phase} sleep_start=${fmt(row?.sleep_start_at)} cleared=${fmt(row?.cleared_at)} reason=${row?.clear_reason ?? 'NULL'}`)
    console.log(`    ⇒ cleared(school_departure) @ ${fmt(wakeS)}，sleep_start_at=${fmt(realSleepStart)}`)
    if (APPLY && row) {
      db.update(sunsetSessions)
        .set({
          phase: 'cleared',
          sleep_start_at: realSleepStart,
          cleared_at: wakeS,
          clear_reason: 'school_departure',
          candidate_started_at: null,
          candidate_origin_phase: null,
          confirm_requested_at: null,
          updated_at: Math.floor(Date.now() / 1000),
        })
        .where(eq(sunsetSessions.date, s.date))
        .run()
    }
  }
  // 9/4 行（周五夜→周六）：auto_8h 解除符合「睡懒觉」事实，不动
  // 9/5 行：午间 phantom 会话（sleep_start ≈ 12:11）→ 作废入睡登记
  {
    const row = db.select().from(sunsetSessions).where(eq(sunsetSessions.date, SATURDAY)).get()
    const dayStart = userZonedTimeToUtc(SATURDAY, 0)
    if (row && row.sleep_start_at != null && row.sleep_start_at >= dayStart + 6 * 3600 && row.sleep_start_at < dayStart + 18 * 3600) {
      console.log(`  session ${SATURDAY}: phantom sleep_start=${fmt(row.sleep_start_at)} phase=${row.phase} ⇒ 作废（force 解除）`)
      if (APPLY) {
        db.update(sunsetSessions)
          .set({
            phase: 'cleared',
            sleep_start_at: null,
            cleared_at: row.sleep_start_at,
            clear_reason: 'force',
            force_release_reason: 'fix-school-week: 清理午间 phantom 会话',
            candidate_started_at: null,
            candidate_origin_phase: null,
            confirm_requested_at: null,
            updated_at: Math.floor(Date.now() / 1000),
          })
          .where(eq(sunsetSessions.date, SATURDAY))
          .run()
      }
    } else {
      console.log(`  session ${SATURDAY}: ${row ? `phase=${row.phase} sleep_start=${fmt(row.sleep_start_at)}，无需处理` : '行不存在'}`)
    }
  }

  // ── 7. circadian_logs 修复 ──
  log('circadian_logs：sleep_end 按起床估算补齐，phantom 值清空，指标重算')
  // 8/30：circadian 行被 phantom(11:55) 覆盖，但真实入睡（03:10:49）在 session 行上 → 恢复并结算
  {
    const sessionRow = db.select().from(sunsetSessions).where(eq(sunsetSessions.date, '2026-08-30')).get()
    const realSleepStart = sessionRow?.sleep_start_at ?? null
    const wakeS = userZonedTimeToUtc('2026-08-31', WAKE_MIN)
    console.log(`  2026-08-30: sleep_start ⇒ ${fmt(realSleepStart)}（从 session 行恢复），sleep_end ⇒ ${fmt(wakeS)}`)
    if (APPLY) {
      db.update(circadianLogs)
        .set({ sleep_start: realSleepStart, sleep_end: wakeS })
        .where(eq(circadianLogs.date, '2026-08-30'))
        .run()
      if (realSleepStart != null) updateSunsetCompliance(db, '2026-08-30', realSleepStart)
      updateSleepMetrics(db, '2026-08-30')
    }
  }
  // 8/31 ~ 9/3：sleep_start 真实（~04:11），sleep_end = 次日起床估算 → 重算债务与宵禁遵从
  for (const s of settlements.slice(1)) {
    const wakeS = userZonedTimeToUtc(s.wakeDate, WAKE_MIN)
    const circ = db.select().from(circadianLogs).where(eq(circadianLogs.date, s.date)).get()
    console.log(`  ${s.date}: sleep_start=${fmt(circ?.sleep_start)} sleep_end ⇒ ${fmt(wakeS)}（≈${circ?.sleep_start ? ((wakeS - circ.sleep_start) / 3600).toFixed(1) : '?'}h 睡眠）`)
    if (APPLY) {
      db.update(circadianLogs).set({ sleep_end: wakeS }).where(eq(circadianLogs.date, s.date)).run()
      if (circ?.sleep_start != null) updateSunsetCompliance(db, s.date, circ.sleep_start)
      updateSleepMetrics(db, s.date)
    }
  }
  // 9/4：sleep_end 保持 NULL（周六真实起床时刻未知）
  // 9/5：phantom sleep_start(12:11) + compliance(+416) 作废
  {
    console.log('  2026-09-05: sleep_start/sunset_compliance ⇒ NULL（12:11 phantom 作废）')
    if (APPLY) {
      db.update(circadianLogs)
        .set({ sleep_start: null, sunset_compliance: null })
        .where(eq(circadianLogs.date, SATURDAY))
        .run()
    }
  }

  // ── 8. 删除白天干预轰炸日志 ──
  log('删除白天「就寝后未睡 / 宵禁时段娱乐」噪声干预日志')
  for (const w of windows) {
    const c = db
      .select({ c: sql<number>`count(*)` })
      .from(interventionLogs)
      .where(and(
        gte(interventionLogs.dispatched_at, w.fromS),
        lt(interventionLogs.dispatched_at, w.toS),
        or(like(interventionLogs.trigger_reason, '就寝后%'), like(interventionLogs.trigger_reason, '%宵禁时段娱乐%')),
      ))
      .get()?.c ?? 0
    console.log(`  ${w.date}: ${c} 条`)
    if (APPLY && c > 0) {
      db.delete(interventionLogs)
        .where(and(
          gte(interventionLogs.dispatched_at, w.fromS),
          lt(interventionLogs.dispatched_at, w.toS),
          or(like(interventionLogs.trigger_reason, '就寝后%'), like(interventionLogs.trigger_reason, '%宵禁时段娱乐%')),
        ))
        .run()
    }
  }

  // ── 9. user_memory 重提炼（含上学日事实，清掉「白天睡 15h」式错误观察） ──
  log('user_memory 强制重提炼')
  {
    const rows = db.select().from(userMemory).all()
    for (const r of rows) console.log(`  ${r.key}: ${r.value.slice(0, 80)}${r.value.length > 80 ? '…' : ''}`)
    if (APPLY) {
      if (!process.env.DEEPSEEK_API_KEY) {
        console.log('  ⚠ DEEPSEEK_API_KEY 未配置，跳过重提炼（旧 memory 保留，请人工检查）')
      } else {
        try {
          const { updateUserMemory } = await import('../lib/ai/memory')
          const ok = await updateUserMemory(db, { force: true })
          console.log(ok ? '  ✓ memory 已重提炼' : '  ⚠ memory 重提炼未执行（API 失败或无需更新）')
        } catch (e) {
          console.log(`  ⚠ memory 重提炼失败: ${e}`)
        }
      }
    }
  }

  console.log(`\n${APPLY ? '✓ 修复完成' : 'dry-run 结束——确认无误后加 --apply 实写（先 checkpoint + 备份）'}`)
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
