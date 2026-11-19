// 客户端认证守卫的纯判定逻辑：根据 /api/me 三态决定跳转目标。
// 组件（(main)/layout 的 AuthGate、login/setup 页）只做 fetch + 调用，这里单测。

export interface MeState {
  hasPassword: boolean
  authenticated: boolean
}

/**
 * 返回应跳转的路径，无需跳转返回 null：
 * - 未设置密码 → /setup（登录页也会被弹过去）
 * - 已设密码未认证 → /login
 * - 已认证 → null（留在当前页）
 */
export function resolveAuthRedirect(me: MeState): string | null {
  if (!me.hasPassword) return '/setup'
  if (!me.authenticated) return '/login'
  return null
}
