// 更新检查器单测：mock 全局 fetch（等价于 mock checker 的外部依赖），
// 通过 resetReleaseCache / injectReleaseCache 控制缓存与假时钟。
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  RELEASE_CACHE_TTL_MS,
  RELEASE_FAILURE_CACHE_TTL_MS,
  checkLatestRelease,
  injectReleaseCache,
  isNewerVersion,
  resetReleaseCache,
} from './checker'

const NOW = 1_800_000_000_000
const FAKE_RELEASE = {
  tag_name: 'v1.2.3',
  html_url: 'https://github.com/junugo/Anchor/releases/tag/v1.2.3',
  published_at: '2026-11-01T00:00:00Z',
  body: 'x'.repeat(600),
}

function mockFetch(impl: (url: string, init: RequestInit) => Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = []
  ;(globalThis as { fetch: unknown }).fetch = (url: string, init: RequestInit) => {
    calls.push({ url, init })
    return impl(url, init)
  }
  return calls
}

const realFetch = globalThis.fetch

test('成功解析 ReleaseInfo（body 截断 500 字符）', async () => {
  resetReleaseCache()
  mockFetch(async () => new Response(JSON.stringify(FAKE_RELEASE), { status: 200 }))
  const info = await checkLatestRelease(NOW)
  assert.equal(info?.tagName, 'v1.2.3')
  assert.equal(info?.htmlUrl, FAKE_RELEASE.html_url)
  assert.equal(info?.publishedAt, FAKE_RELEASE.published_at)
  assert.equal(info?.body?.length, 500)
})

test('请求带 User-Agent: Anchor-Server 头', async () => {
  resetReleaseCache()
  const calls = mockFetch(async () => new Response(JSON.stringify(FAKE_RELEASE), { status: 200 }))
  await checkLatestRelease(NOW)
  assert.equal((calls[0].init.headers as Record<string, string>)['User-Agent'], 'Anchor-Server')
  assert.equal(calls[0].url, 'https://api.github.com/repos/junugo/Anchor/releases/latest')
})

test('非 200 → null 且缓存为 null', async () => {
  resetReleaseCache()
  mockFetch(async () => new Response('not found', { status: 404 }))
  assert.equal(await checkLatestRelease(NOW), null)
})

test('网络异常/超时 → null（静默，不抛出）', async () => {
  resetReleaseCache()
  mockFetch(async () => {
    throw new DOMException('timeout', 'TimeoutError')
  })
  assert.equal(await checkLatestRelease(NOW), null)
})

test('响应缺 tag_name → null', async () => {
  resetReleaseCache()
  mockFetch(async () => new Response(JSON.stringify({ html_url: 'x' }), { status: 200 }))
  assert.equal(await checkLatestRelease(NOW), null)
})

test('缓存：TTL 内不重复请求，过期后重新请求', async () => {
  resetReleaseCache()
  let count = 0
  mockFetch(async () => {
    count++
    return new Response(JSON.stringify(FAKE_RELEASE), { status: 200 })
  })
  await checkLatestRelease(NOW)
  await checkLatestRelease(NOW + 1000)
  assert.equal(count, 1, '12h 内应命中缓存')
  const again = await checkLatestRelease(NOW + RELEASE_CACHE_TTL_MS + 1)
  assert.equal(count, 2, 'TTL 过期后应重新请求')
  assert.equal(again?.tagName, 'v1.2.3')
})

test('失败结果用 1h 短 TTL：期间不重复请求，过期后重试', async () => {
  resetReleaseCache()
  let count = 0
  mockFetch(async () => {
    count++
    throw new DOMException('down', 'AbortError')
  })
  assert.equal(await checkLatestRelease(NOW), null)
  // 短 TTL 内不重复请求（换成成功响应也不应被请求）
  globalThis.fetch = async () => {
    count++
    return new Response(JSON.stringify(FAKE_RELEASE), { status: 200 })
  }
  assert.equal(await checkLatestRelease(NOW + 1000), null)
  assert.equal(count, 1)
  assert.equal(await checkLatestRelease(NOW + RELEASE_FAILURE_CACHE_TTL_MS + 1) !== null, true)
  assert.equal(count, 2)
})

test('注入缓存可直接命中（假时钟场景）', async () => {
  resetReleaseCache()
  injectReleaseCache(null, NOW)
  let count = 0
  mockFetch(async () => {
    count++
    return new Response(JSON.stringify(FAKE_RELEASE), { status: 200 })
  })
  assert.equal(await checkLatestRelease(NOW + 1000), null)
  assert.equal(count, 0)
})

// isNewerVersion
test('isNewerVersion：v 前缀剥离', () => {
  assert.equal(isNewerVersion('v1.2.3', '1.2.0'), true)
  assert.equal(isNewerVersion('v1.2.0', 'v1.2.3'), false)
})

test('isNewerVersion：相等为 false', () => {
  assert.equal(isNewerVersion('1.2.3', '1.2.3'), false)
  assert.equal(isNewerVersion('v1.2.3', '1.2.3'), false)
})

test('isNewerVersion：多段数值比较', () => {
  assert.equal(isNewerVersion('2.0.0', '1.9.9'), true)
  assert.equal(isNewerVersion('1.10.0', '1.9.0'), true)
  assert.equal(isNewerVersion('0.0.2', '0.0.10'), false)
})

test('isNewerVersion：预发布标识同版本视为更旧', () => {
  assert.equal(isNewerVersion('1.2.3-beta', '1.2.3'), false)
  assert.equal(isNewerVersion('1.2.3', '1.2.3-beta'), true)
  assert.equal(isNewerVersion('1.2.4-beta', '1.2.3'), true)
})

test('isNewerVersion：非规范格式返回 false', () => {
  assert.equal(isNewerVersion('latest', '1.2.3'), false)
  assert.equal(isNewerVersion('1.2', '1.2.3'), false)
  assert.equal(isNewerVersion('1.2.3', 'abc'), false)
  assert.equal(isNewerVersion('', ''), false)
})

test.after(() => {
  ;(globalThis as { fetch: unknown }).fetch = realFetch
})
