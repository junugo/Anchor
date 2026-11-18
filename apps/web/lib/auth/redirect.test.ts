// resolveAuthRedirect 单元测试：覆盖 /api/me 三态与守卫分支
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { resolveAuthRedirect } from './redirect'

test('未设置密码 → /setup（无论认证态）', () => {
  assert.equal(resolveAuthRedirect({ hasPassword: false, authenticated: false }), '/setup')
  assert.equal(resolveAuthRedirect({ hasPassword: false, authenticated: true }), '/setup')
})

test('已设密码未认证 → /login', () => {
  assert.equal(resolveAuthRedirect({ hasPassword: true, authenticated: false }), '/login')
})

test('已设密码已认证 → null（不跳转）', () => {
  assert.equal(resolveAuthRedirect({ hasPassword: true, authenticated: true }), null)
})
