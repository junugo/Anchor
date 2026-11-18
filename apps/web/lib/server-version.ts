// 服务器版本号：来自 apps/web/package.json，模块加载时读入一次，不每请求读文件。
// 供 /api/pair（配对响应 serverVersion）与 /api/version（客户端更新检查，任务 13 消费）使用。
import pkg from '../package.json'

export const SERVER_VERSION: string = pkg.version
