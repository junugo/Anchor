import { defineConfig } from 'wxt'

export default defineConfig({
  manifest: {
    name: 'Anchor',
    version: '2.0.1',
    description: 'Anchor 网页行为感知与宵禁拦截',
    permissions: ['tabs', 'activeTab', 'storage', 'alarms', 'favicon'],
    host_permissions: ['<all_urls>'],
    icons: {
      16: 'icon/16.png',
      32: 'icon/32.png',
      48: 'icon/48.png',
      128: 'icon/128.png',
    },
  },
})
