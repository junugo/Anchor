// GET /api/update — 服务器更新检查（需 session）
// 返回 { current, latest, htmlUrl, publishedAt, updateAvailable }；
// latest 为 null（检查失败）时 updateAvailable=false，前端静默不显示横幅。
import { NextRequest, NextResponse } from 'next/server'
import { SERVER_VERSION } from '@/lib/server-version'
import { requireSession } from '@/lib/auth/request'
import { checkLatestRelease, isNewerVersion } from '@/lib/update/checker'

export async function GET(req: NextRequest) {
  const session = requireSession(req)
  if (!session) {
    return NextResponse.json({ error: '未认证' }, { status: 401 })
  }

  const release = await checkLatestRelease()
  return NextResponse.json({
    current: SERVER_VERSION,
    latest: release?.tagName ?? null,
    htmlUrl: release?.htmlUrl ?? null,
    publishedAt: release?.publishedAt ?? null,
    updateAvailable: release ? isNewerVersion(release.tagName, SERVER_VERSION) : false,
  })
}
