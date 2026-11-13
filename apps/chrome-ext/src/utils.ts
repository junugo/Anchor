export const WHITELIST_HOSTS = ['localhost', '127.0.0.1']

export function getDomain(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

// 域名匹配：精确命中或子域名命中（用于高刺激判定与硬拦截）
export function domainMatches(host: string, domain: string): boolean {
  return host === domain || host.endsWith('.' + domain)
}
