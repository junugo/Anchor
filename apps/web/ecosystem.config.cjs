// Anchor 服务端统一 PM2 配置（自托管可选：pm2 start ecosystem.config.cjs）
// 注意：cwd 须改为你的实际部署路径；环境变量集中在 apps/web/.env 管理
module.exports = {
  apps: [
    {
      name: 'anchor',
      namespace: 'anchor',
      cwd: '/path/to/anchor/apps/web',
      script: './server.ts',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '1024M',
      // server.ts 为 TypeScript，必须使用 tsx 解释器
      interpreter: './node_modules/.bin/tsx',
      env: {
        NODE_ENV: 'production',
      },
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
    },
  ],
}
