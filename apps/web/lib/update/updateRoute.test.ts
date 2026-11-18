// /api/update 路由三态测试：有新版 / 无新版 / 检查失败。
// 使用临时 DB 走完 setup→login 拿到会话；checker 的外部依赖（GitHub fetch）以全局 fetch mock 替代。
import assert from 'node:assert/strict'
import test, { after, before } from 'node:test'
import { closeDb } from '@anchor/db'
import { cleanupDir, tempDbPath } from '@/lib/testUtils'
import { getDb } from '@/lib/db'
import { SESSION_COOKIE } from '@/lib/auth/request'
import { resetReleaseCache } from '@/lib/update/checker'
import { SERVER_VERSION } from '@/lib/server-version'

const { dir, dbPath } = tempDbPath('update-route')
process.env.ANCHOR_DB_PATH = dbPath

const { POST: setup } = await import('../../app/api/setup/route')
const { POST: login } = await import('../../app/api/login/route')
const { GET: update } = await import('../../app/api/update/route')

let token = ''

function mockGitHubRelease(tagName: string | null) {
  ;(globalThis as { fetch: unknown }).fetch = async () => {
    if (tagName === null) throw new DOMException('network down', 'AbortError')
    return new Response(
      JSON.stringify({
        tag_name: tagName,
        html_url: `https://github.com/junugo/Anchor/releases/tag/${tagName}`,
        published_at: '2026-11-01T00:00:00Z',
        body: 'release notes',
      }),
      { status: 200 },
    )
  }
}

async function authedGet() {
  const res = await update(
    new Request('http://localhost/api/update', {
      headers: { cookie: `${SESSION_COOKIE}=${encodeURIComponent(token)}` },
    }) as never,
  )
  return res
}

before(async () => {
  await setup(
    new Request('http://localhost/api/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'test-password-123' }),
    }),
  )
  const res = await login(
    new Request('http://localhost/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'test-password-123' }),
    }),
  )
  const h = res.headers as Headers & { getSetCookie?: () => string[] }
  const cookie = (typeof h.getSetCookie === 'function' ? h.getSetCookie() : [res.headers.get('set-cookie')!])
    .find((c) => c!.startsWith(`${SESSION_COOKIE}=`))!
  token = decodeURIComponent(cookie.split(';')[0].split('=')[1])
})

after(() => {
  closeDb(getDb())
  cleanupDir(dir)
})

test('未认证 → 401', async () => {
  resetReleaseCache()
  const res = await update(new Request('http://localhost/api/update') as never)
  assert.equal(res.status, 401)
})

test('有新版：updateAvailable=true 且返回 latest/htmlUrl/publishedAt', async () => {
  resetReleaseCache()
  mockGitHubRelease('v9.9.9')
  const res = await authedGet()
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.current, SERVER_VERSION)
  assert.equal(body.latest, 'v9.9.9')
  assert.equal(body.htmlUrl, 'https://github.com/junugo/Anchor/releases/tag/v9.9.9')
  assert.equal(body.publishedAt, '2026-11-01T00:00:00Z')
  assert.equal(body.updateAvailable, true)
})

test('无新版：latest 有值但 updateAvailable=false', async () => {
  resetReleaseCache()
  mockGitHubRelease('v0.0.1') // 与 SERVER_VERSION 相等
  const res = await authedGet()
  const body = await res.json()
  assert.equal(body.latest, 'v0.0.1')
  assert.equal(body.updateAvailable, false)
})

test('检查失败：latest=null 且 updateAvailable=false（静默）', async () => {
  resetReleaseCache()
  mockGitHubRelease(null)
  const res = await authedGet()
  const body = await res.json()
  assert.equal(body.latest, null)
  assert.equal(body.htmlUrl, null)
  assert.equal(body.publishedAt, null)
  assert.equal(body.updateAvailable, false)
})
