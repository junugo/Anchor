import type React from 'react'
import { NavSidebar } from '../components/NavSidebar'
import { AnchorProvider } from '../components/AnchorProvider'
import { SunsetOverlay } from '../components/SunsetOverlay'
import { InterventionToast } from '../components/InterventionToast'
import { SleepConfirmDialog } from '../components/SleepConfirmDialog'
import { ContextSwitchDialog } from '../components/ContextSwitchDialog'

/**
 * (main) 路由组 layout：包含导航栏、AnchorProvider、宵禁覆盖层。
 */
export default function MainLayout({ children }: { children: React.ReactNode }) {
  return (
    <AnchorProvider>
      <div className="shell">
        <NavSidebar />
        <main className="main-content">{children}</main>
      </div>
      <SunsetOverlay />
      <InterventionToast />
      <SleepConfirmDialog />
      <ContextSwitchDialog />
    </AnchorProvider>
  )
}
