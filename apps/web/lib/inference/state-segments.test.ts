import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { closeDb, createDb, stateSegments } from '@anchor/db'
import { recordStateSegment } from './state-segments'

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'anchor-seg-'))
  return createDb(path.join(dir, 'anchor.db'))
}

test('首次记录开一个新段（ended_at 为 NULL）', () => {
  const db = tempDb()
  try {
    recordStateSegment(db, 'working', 1000)
    const rows = db.select().from(stateSegments).all()
    assert.equal(rows.length, 1)
    assert.equal(rows[0].state, 'working')
    assert.equal(rows[0].started_at, 1000)
    assert.equal(rows[0].ended_at, null)
    assert.equal(rows[0].source, 'realtime')
  } finally { closeDb(db) }
})

test('同状态重复记录是 no-op', () => {
  const db = tempDb()
  try {
    recordStateSegment(db, 'working', 1000)
    recordStateSegment(db, 'working', 1060)
    const rows = db.select().from(stateSegments).all()
    assert.equal(rows.length, 1)
    assert.equal(rows[0].ended_at, null)
  } finally { closeDb(db) }
})

test('状态切换闭合上一段并开新段', () => {
  const db = tempDb()
  try {
    recordStateSegment(db, 'working', 1000)
    recordStateSegment(db, 'entertaining', 1600)
    const rows = db.select().from(stateSegments).orderBy(stateSegments.started_at).all()
    assert.equal(rows.length, 2)
    assert.equal(rows[0].state, 'working')
    assert.equal(rows[0].ended_at, 1600)
    assert.equal(rows[1].state, 'entertaining')
    assert.equal(rows[1].started_at, 1600)
    assert.equal(rows[1].ended_at, null)
  } finally { closeDb(db) }
})

test('崩溃遗留多个悬空段时全部闭合再开新段（多余段收编为自身起点，零长隐藏）', () => {
  const db = tempDb()
  try {
    db.insert(stateSegments).values({ state: 'resting', started_at: 500, ended_at: null, source: 'realtime' }).run()
    db.insert(stateSegments).values({ state: 'working', started_at: 800, ended_at: null, source: 'realtime' }).run()
    recordStateSegment(db, 'sleeping', 2000)
    const rows = db.select().from(stateSegments).orderBy(stateSegments.started_at).all()
    assert.equal(rows.length, 3)
    // 多余悬空段闭合为自身起点（零长），不再被拉长到 nowS
    assert.equal(rows[0].ended_at, 500)
    assert.equal(rows[1].ended_at, 2000)
    assert.equal(rows[2].state, 'sleeping')
    assert.equal(rows[2].ended_at, null)
  } finally { closeDb(db) }
})

test('心跳：同状态连续调用刷新 last_seen_at，段不分裂', () => {
  const db = tempDb()
  try {
    recordStateSegment(db, 'working', 1000)
    recordStateSegment(db, 'working', 1060)
    recordStateSegment(db, 'working', 1120)
    const rows = db.select().from(stateSegments).all()
    assert.equal(rows.length, 1)
    assert.equal(rows[0].ended_at, null)
    assert.equal(rows[0].last_seen_at, 1120)
  } finally { closeDb(db) }
})

test('僵尸段（同状态）：心跳凝固超阈值 → 闭合到最后心跳，新开同名段，中间留空档', () => {
  const db = tempDb()
  try {
    // 段 400→ 心跳停在 1000（管线此后暂停）；5000 时管线恢复，状态仍是 working
    db.insert(stateSegments).values({ state: 'working', started_at: 400, ended_at: null, source: 'realtime', last_seen_at: 1000 }).run()
    recordStateSegment(db, 'working', 5000)
    const rows = db.select().from(stateSegments).orderBy(stateSegments.started_at).all()
    assert.equal(rows.length, 2)
    assert.equal(rows[0].state, 'working')
    assert.equal(rows[0].ended_at, 1000) // 闭合到最后心跳，而非拉长到 5000
    assert.equal(rows[1].state, 'working')
    assert.equal(rows[1].started_at, 5000) // 新段从恢复时刻起，1000→5000 空档 = 无数据
    assert.equal(rows[1].ended_at, null)
    assert.equal(rows[1].last_seen_at, 5000)
  } finally { closeDb(db) }
})

test('僵尸段（异状态）：心跳凝固超阈值 → 旧段闭合到最后心跳，新状态从 now 起', () => {
  const db = tempDb()
  try {
    db.insert(stateSegments).values({ state: 'working', started_at: 400, ended_at: null, source: 'realtime', last_seen_at: 1000 }).run()
    recordStateSegment(db, 'resting', 5000)
    const rows = db.select().from(stateSegments).orderBy(stateSegments.started_at).all()
    assert.equal(rows.length, 2)
    assert.equal(rows[0].ended_at, 1000)
    assert.equal(rows[1].state, 'resting')
    assert.equal(rows[1].started_at, 5000)
  } finally { closeDb(db) }
})

test('遗留段（last_seen_at NULL）：首次见到只升级填充，不当场判死、不丢数据', () => {
  const db = tempDb()
  try {
    // 列上线前写入的 open 段：即使 started 很久之前，也不能闭合到 started_at 误斩
    db.insert(stateSegments).values({ state: 'working', started_at: 400, ended_at: null, source: 'realtime' }).run()
    recordStateSegment(db, 'working', 5000)
    const rows = db.select().from(stateSegments).all()
    assert.equal(rows.length, 1)
    assert.equal(rows[0].ended_at, null) // 段保留延伸
    assert.equal(rows[0].last_seen_at, 5000) // 心跳升级填充
    // 升级后下一 tick 起才具备判死资格
    recordStateSegment(db, 'working', 5000 + 11 * 60)
    const rows2 = db.select().from(stateSegments).orderBy(stateSegments.started_at).all()
    assert.equal(rows2.length, 2) // 距今 11min > 阈值 → 判死分裂
    assert.equal(rows2[0].ended_at, 5000) // 闭合到首次升级的心跳，而非起点 400 —— 段数据保留
    assert.equal(rows2[1].started_at, 5000 + 11 * 60)
  } finally { closeDb(db) }
})
