import type React from 'react'
import { NavSidebar } from '../components/NavSidebar'
import { AnchorProvider } from '../components/AnchorProvider'
import { SunsetOverlay } from '../components/SunsetOverlay'
import { InterventionToast } from '../components/InterventionToast'
import { SleepConfirmDialog } from '../components/SleepConfirmDialog'
import { ContextSwitchDialog } from '../components/ContextSwitchDialog'
import { AuthGate } from '../components/AuthGate'
import { UpdateBanner } from '../components/UpdateBanner'

/**
 * (main) 路由组 layout：认证守卫 + 导航栏 + AnchorProvider + 宵禁覆盖层。
 * 未认证/未设密码由 AuthGate 客户端跳转（/login、/setup 在本组之外）。
 */
export default function MainLayout({ children }: { children: React.ReactNode }) {
  return (
    <AuthGate>
      <AnchorProvider>
        <div className="shell">
          <NavSidebar />
          <main className="main-content">
            <UpdateBanner />
            {children}
          </main>
        </div>
        <SunsetOverlay />
        <InterventionToast />
        <SleepConfirmDialog />
        <ContextSwitchDialog />
      </AnchorProvider>
    </AuthGate>
  )
}
