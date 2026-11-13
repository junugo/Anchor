/**
 * 历史僵尸 open 段一次性收编（state_segments.last_seen_at 心跳列上线前的遗留）。
 *
 * 背景：服务器离线/崩溃时 open 段无人闭合，读取侧会把它拉长到「现在」，
 * 离线时段被错误标成离线前的最后状态（如 8/12 working 04:49→07:48 横跨真实睡眠）。
 * 心跳列上线后由 recordStateSegment 惰性检测收编新僵尸，本脚本只收编历史遗留。
 *
 * 判定与处理：
 * - 最新 open 段距 now 超 10min（阈值同 STALE_SEGMENT_S）→ 闭合到 started_at + 5min（一个完整 tick 宽限，保守不猜）
 * - 更老的多余悬空段（崩溃遗留，正常不存在）→ 闭合到自身 started_at（零长，查询自动忽略）
 * - 服务器似乎在运行（5min 内有新行为日志）且只有一条 open 段 → 活跃段，跳过
 *
 * 运行：cd apps/web
 *   pnpm close:segments            # dry-run，只打印不写库
 *   pnpm close:segments:apply      # 实际写库（WAL 下可与服务器并存，跑完自然自愈）
 */
import fs from 'fs'
import path from 'path'
import { closeStaleSegments } from '../lib/inference/close-stale-segments'
import { getDb } from '../lib/db'

/**
 * 加载 apps/web/.env 中的基本环境变量（仅当尚未设置时）。
 * 不处理引号转义、注释等复杂场景，够用即可。
 */
function loadLocalEnv(): void {
  const envPath = path.join(process.cwd(), '.env')
  if (!fs.existsSync(envPath)) return
  const content = fs.readFileSync(envPath, 'utf-8')
  for (const raw of content.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const idx = line.indexOf('=')
    if (idx <= 0) continue
    const key = line.slice(0, idx).trim()
    let value = line.slice(idx + 1).trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (process.env[key] === undefined) process.env[key] = value
  }
}

function main(): void {
  loadLocalEnv()
  const apply = process.argv.includes('--apply')
  const result = closeStaleSegments(getDb(), { apply })
  for (const line of result.logs) console.log(line)
}

main()
