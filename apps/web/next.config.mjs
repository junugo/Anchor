/** @type {import('next').NextConfig} */
const nextConfig = {
  // standalone output 在开发环境会与自定义 server.ts 冲突导致无限重启
  // 仅在生产构建时手动启用：next build 前临时取消注释下一行
  // output: 'standalone',
  transpilePackages: ['@anchor/ui', '@anchor/trpc', '@anchor/types', '@anchor/utils'],
  serverExternalPackages: ['better-sqlite3', '@anchor/db'],
  webpack(config, { isServer }) {
    // bonjour-service is an optional runtime-only dep; ignore at build time
    config.resolve.alias['bonjour-service'] = false

    if (isServer) {
      config.externals.push('better-sqlite3')
    }

    return config
  },
}
export default nextConfig
