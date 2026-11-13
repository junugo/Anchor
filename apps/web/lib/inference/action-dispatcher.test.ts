import assert from 'node:assert/strict'
import test from 'node:test'
import type { InterventionPlan } from '@anchor/types'
import { filterDispatchable, resetCooldowns } from './action-dispatcher'
import { createDb, closeDb } from '@anchor/db'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const NOW_S = 1781956800
const NOW_MS = NOW_S * 1000

function tempDb(name: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `anchor-${name}-`))
  return { dir, db: createDb(path.join(dir, 'anchor.db')) }
}

function plan(partial: Partial<InterventionPlan> & { type: InterventionPlan['type']; action: InterventionPlan['action'] }): InterventionPlan {
  return {
    id: partial.id ?? `iv-${Math.floor(Math.random() * 1e9)}`,
    type: partial.type,
    targets: partial.targets ?? ['android'],
    action: partial.action,
    message: partial.message ?? 'test',
    expires_at: partial.expires_at ?? NOW_S + 300,
  }
}

test('do_not_disturb skips notify and soft but keeps hard', () => {
  const { dir, db } = tempDb('dispatch-dnd')
  try {
    resetCooldowns(db)
    const plans: InterventionPlan[] = [
      plan({ type: 'notify', action: 'android:push_notify' }),
      plan({ type: 'soft', action: 'chrome:grayscale' }),
      plan({ type: 'hard', action: 'android:fullscreen_block' }),
    ]
    const out = filterDispatchable(plans, { doNotDisturb: true, nowMs: NOW_MS }, db)
    assert.equal(out.length, 1)
    assert.equal(out[0].type, 'hard')
  } finally {
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('without do_not_disturb all levels pass', () => {
  const { dir, db } = tempDb('dispatch-all')
  try {
    resetCooldowns(db)
    const plans: InterventionPlan[] = [
      plan({ type: 'notify', action: 'android:push_notify' }),
      plan({ type: 'soft', action: 'chrome:grayscale' }),
    ]
    const out = filterDispatchable(plans, { doNotDisturb: false, nowMs: NOW_MS }, db)
    assert.equal(out.length, 2)
  } finally {
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('same action on cooldown is skipped', () => {
  const { dir, db } = tempDb('dispatch-cooldown')
  try {
    resetCooldowns(db)
    const p1 = plan({ type: 'notify', action: 'android:push_notify' })
    const first = filterDispatchable([p1], { doNotDisturb: false, nowMs: NOW_MS }, db)
    assert.equal(first.length, 1)
    // 2 分钟后同动作仍在退避冷却内（首次触发后需等 15 分钟）
    const p2 = plan({ type: 'notify', action: 'android:push_notify' })
    const second = filterDispatchable([p2], { doNotDisturb: false, nowMs: NOW_MS + 2 * 60 * 1000 }, db)
    assert.equal(second.length, 0)
  } finally {
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('hard intervention uses 15min cooldown', () => {
  const { dir, db } = tempDb('dispatch-hard')
  try {
    resetCooldowns(db)
    const p1 = plan({ type: 'hard', action: 'desktop:force_lock' })
    filterDispatchable([p1], { doNotDisturb: false, nowMs: NOW_MS }, db)
    // 10 分钟后仍在 15 分钟冷却内
    const p2 = plan({ type: 'hard', action: 'desktop:force_lock' })
    const out = filterDispatchable([p2], { doNotDisturb: false, nowMs: NOW_MS + 10 * 60 * 1000 }, db)
    assert.equal(out.length, 0)
  } finally {
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('notify backoff escalates 15/30/60min within one episode', () => {
  const { dir, db } = tempDb('dispatch-backoff')
  const p = () => plan({ type: 'notify', action: 'android:push_notify' })
  const ctx = (t: number, state = 'entertaining' as const) => ({ doNotDisturb: false, nowMs: t, state })
  try {
    resetCooldowns(db)
    const t0 = NOW_MS
    // 首次立即发出
    assert.equal(filterDispatchable([p()], ctx(t0), db).length, 1)
    // 14 分钟后仍在 15 分钟冷却内
    assert.equal(filterDispatchable([p()], ctx(t0 + 14 * 60 * 1000), db).length, 0)
    // 16 分钟后通过（第二跳，进入 30 分钟冷却）
    assert.equal(filterDispatchable([p()], ctx(t0 + 16 * 60 * 1000), db).length, 1)
    // 距第二次触发 29 分钟：仍在 30 分钟冷却内
    assert.equal(filterDispatchable([p()], ctx(t0 + 45 * 60 * 1000), db).length, 0)
    // 距第二次触发 31 分钟：通过（第三跳，进入 60 分钟冷却）
    assert.equal(filterDispatchable([p()], ctx(t0 + 47 * 60 * 1000), db).length, 1)
    // 距第三次触发 59 分钟：仍在 60 分钟冷却内
    assert.equal(filterDispatchable([p()], ctx(t0 + 106 * 60 * 1000), db).length, 0)
    // 距第三次触发 61 分钟：通过（第四跳，仍为 60 分钟冷却）
    assert.equal(filterDispatchable([p()], ctx(t0 + 108 * 60 * 1000), db).length, 1)
  } finally {
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('state switch resets notify backoff', () => {
  const { dir, db } = tempDb('dispatch-state-reset')
  const p = () => plan({ type: 'notify', action: 'android:push_notify' })
  try {
    resetCooldowns(db)
    const t0 = NOW_MS
    // entertaining 下触发两次，退避已升到 30 分钟
    assert.equal(filterDispatchable([p()], { doNotDisturb: false, nowMs: t0, state: 'entertaining' }, db).length, 1)
    assert.equal(filterDispatchable([p()], { doNotDisturb: false, nowMs: t0 + 16 * 60 * 1000, state: 'entertaining' }, db).length, 1)
    // 同动作在 resting 状态是新 key，立即放行
    const out = filterDispatchable([p()], { doNotDisturb: false, nowMs: t0 + 17 * 60 * 1000, state: 'resting' }, db)
    assert.equal(out.length, 1)
  } finally {
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('long gap (>2h) resets notify backoff', () => {
  const { dir, db } = tempDb('dispatch-gap-reset')
  const p = () => plan({ type: 'notify', action: 'android:push_notify' })
  try {
    resetCooldowns(db)
    const t0 = NOW_MS
    assert.equal(filterDispatchable([p()], { doNotDisturb: false, nowMs: t0, state: 'entertaining' }, db).length, 1)
    // 2 小时 10 分钟后：视为新插曲，立即放行
    const out = filterDispatchable([p()], { doNotDisturb: false, nowMs: t0 + 130 * 60 * 1000, state: 'entertaining' }, db)
    assert.equal(out.length, 1)
  } finally {
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('dual-channel notify actions cooldown independently', () => {
  const { dir, db } = tempDb('dispatch-dual')
  try {
    resetCooldowns(db)
    const plans: InterventionPlan[] = [
      plan({ type: 'notify', action: 'chrome:friction_banner' }),
      plan({ type: 'notify', action: 'android:push_notify' }),
    ]
    // 双端各自计数，同一 tick 同时放行
    const out = filterDispatchable(plans, { doNotDisturb: false, nowMs: NOW_MS, state: 'entertaining' }, db)
    assert.equal(out.length, 2)
    // 任一通道冷却不影响另一端
    const onlyChrome = filterDispatchable([plan({ type: 'notify', action: 'chrome:friction_banner' })], { doNotDisturb: false, nowMs: NOW_MS + 2 * 60 * 1000, state: 'entertaining' }, db)
    assert.equal(onlyChrome.length, 0)
  } finally {
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('cooldown expires after backoff window', () => {
  const { dir, db } = tempDb('dispatch-expire')
  try {
    resetCooldowns(db)
    const p1 = plan({ type: 'notify', action: 'android:push_notify' })
    filterDispatchable([p1], { doNotDisturb: false, nowMs: NOW_MS }, db)
    // 16 分钟后 notify 首次退避（15min）已过
    const p2 = plan({ type: 'notify', action: 'android:push_notify' })
    const out = filterDispatchable([p2], { doNotDisturb: false, nowMs: NOW_MS + 16 * 60 * 1000 }, db)
    assert.equal(out.length, 1)
  } finally {
    closeDb(db)
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
