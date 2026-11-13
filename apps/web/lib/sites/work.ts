import type { Db } from '@anchor/db'
import { siteClassifications, appClassifications, processClassifications } from '@anchor/db'
import { and, eq, ne } from 'drizzle-orm'

// 工作向分类的唯一数据源：三张分类表（由 /apps 统一管理页维护），pending 行不参与推断

export function getWorkSites(db: Db): string[] {
  return db
    .select({ domain: siteClassifications.domain })
    .from(siteClassifications)
    .where(and(eq(siteClassifications.is_work, true), ne(siteClassifications.classification_source, 'pending')))
    .all()
    .map(r => r.domain)
}

export function getWorkApps(db: Db): string[] {
  return db
    .select({ packageName: appClassifications.package_name })
    .from(appClassifications)
    .where(and(eq(appClassifications.is_work, true), ne(appClassifications.classification_source, 'pending')))
    .all()
    .map(r => r.packageName)
}

export function getWorkProcesses(db: Db): string[] {
  return db
    .select({ processName: processClassifications.process_name })
    .from(processClassifications)
    .where(and(eq(processClassifications.is_work, true), ne(processClassifications.classification_source, 'pending')))
    .all()
    .map(r => r.processName)
}
