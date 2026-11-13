import { redirect } from 'next/navigation'

// 网站管理已并入 /apps 统一管理页，保留此路由仅为兼容旧链接
export default function SitesRedirect() {
  redirect('/apps')
}
