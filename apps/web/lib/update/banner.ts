// 更新横幅显隐判定（纯函数，供 UpdateBanner 组件与单测共用）

/** 仅当有新版且用户本次会话未关闭时才显示 */
export function shouldShowUpdateBanner(updateAvailable: boolean, dismissed: boolean): boolean {
  return updateAvailable && !dismissed
}
