import type { Db } from '@anchor/db'
import { siteClassifications } from '@anchor/db'
import { and, eq, ne } from 'drizzle-orm'

// 高刺激网站的唯一数据源：site_classifications 表（由 /sites 页统一管理）
export function getHighStimulusSites(db: Db): string[] {
  return db
    .select({ domain: siteClassifications.domain })
    .from(siteClassifications)
    .where(and(eq(siteClassifications.high_stimulus, true), ne(siteClassifications.classification_source, 'pending')))
    .all()
    .map(r => r.domain)
}
