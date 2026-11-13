# Chrome 扩展干预动作补全 — 设计规格

> 状态：待实现 | 日期：2026-06-21 | 范围：`apps/chrome-ext`

---

## 1. 背景与目标

Chrome 扩展目前只处理 `sunset:phase` 消息，实现了 `grayscale` 和轻量 friction banner。服务器下发的 `intervention` 消息被完全忽略。目标是补齐：
- `intervention` 消息的接收与执行
- `chrome:hard_block` — 高刺激网站硬拦截
- `chrome:tab_collapse` — 关闭多余标签页
- T0 阶段的 friction 升级为真实阻断页

---

## 2. 现有能力回顾

| 已实现 | 触发 | 效果 |
|--------|------|------|
| `sunset:grayscale` | T30/T0 | `filter: grayscale(100%)` |
| `sunset:friction` | T0 | 固定 banner 3s 自动消失 |

---

## 3. 新增动作

### 3.1 `intervention` 消息接入

在 `background.ts` 的 WS onMessage 中补充：

```ts
case 'intervention':
  handleIntervention(msg)
  break
```

`handleIntervention` 根据 `msg.action` 字段分发：

| `msg.action` | 执行 |
|---|---|
| `chrome:grayscale` | broadcastToTabs(`sunset:grayscale`) |
| `chrome:friction` | broadcastToTabs(`sunset:friction`, { message: msg.message }) |
| `chrome:tab_collapse` | `collapseExcessTabs()` |
| `chrome:hard_block` | broadcastToTabs(`hard:block`, { message: msg.message }) |

### 3.2 `chrome:tab_collapse` — 关闭多余标签页

保留活动标签页和白名单标签，关闭其余：

```ts
async function collapseExcessTabs() {
  const tabs = await chrome.tabs.query({})
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true })
  const WHITELIST = ['localhost', '127.0.0.1']  // 本地开发不关

  const toClose = tabs
    .filter(t => t.id !== activeTab?.id)
    .filter(t => {
      const host = new URL(t.url || '').hostname
      return !WHITELIST.some(w => host.includes(w))
    })
    .map(t => t.id!)

  if (toClose.length > 0) {
    await chrome.tabs.remove(toClose)
  }
}
```

### 3.3 `chrome:hard_block` — 硬拦截覆盖页

在 `content.ts` 中监听 `hard:block` 消息，注入全屏阻断覆盖层（覆盖整个页面内容）：

```ts
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'hard:block') {
    injectHardBlock(msg.message)
  }
})

function injectHardBlock(message: string) {
  // 已有覆盖则不重复注入
  if (document.getElementById('anchor-hard-block')) return

  const overlay = document.createElement('div')
  overlay.id = 'anchor-hard-block'
  overlay.style.cssText = `
    position: fixed; inset: 0; z-index: 2147483647;
    background: #1c1814;
    display: flex; flex-direction: column;
    align-items: center; justify-content: center;
    font-family: system-ui, sans-serif;
  `
  overlay.innerHTML = `
    <div style="font-size:48px;margin-bottom:16px">🌙</div>
    <div style="color:#f5f0eb;font-size:20px;font-weight:600;margin-bottom:8px">
      ${message || '宵禁时间，该休息了'}
    </div>
    <div style="color:#9e9690;font-size:14px;margin-bottom:32px">
      ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
    </div>
    <button id="anchor-force-unlock" style="
      border: 1px solid #3a3530; background: transparent;
      color: #6a737d; font-size: 12px; padding: 8px 20px;
      border-radius: 6px; cursor: pointer;
    ">强制解锁（记录为破戒）</button>
  `
  document.body.appendChild(overlay)

  document.getElementById('anchor-force-unlock')?.addEventListener('click', () => {
    overlay.remove()
    // 通知 background 记录破戒
    chrome.runtime.sendMessage({ type: 'sunset:breach' })
  })
}
```

`background.ts` 接收 `sunset:breach` 后通过 HTTP POST 上报：
```ts
chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'sunset:breach') {
    fetch(`${ANCHOR_URL}/api/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'sunset:breach', timestamp: Date.now() }),
    })
  }
})
```

### 3.4 T0 friction 升级

当前 T0 的 friction 只是 3 秒 banner。升级：T0 阶段对高刺激域名（`high_stimulus = true` 的标签）自动触发 `hard:block`，而非普通 friction。

`background.ts` 在收到 `sunset:phase T0` 时：
```ts
const tabs = await chrome.tabs.query({})
for (const tab of tabs) {
  const domain = new URL(tab.url || '').hostname
  if (HIGH_STIMULUS_DOMAINS.some(d => domain.includes(d))) {
    chrome.tabs.sendMessage(tab.id!, { type: 'hard:block', message: '宵禁时间' })
  }
}
```

`HIGH_STIMULUS_DOMAINS` 从服务器 `sunset:config` 消息中同步（background.ts 已在 connect 时收到 `sunset:config`，补充存储该列表）。

---

## 4. 文件变更范围

```
apps/chrome-ext/entrypoints/
├── background.ts   — 添加 intervention 消息处理、tab_collapse、T0 高刺激拦截、breach 上报
└── content.ts      — 添加 hard:block 注入、force-unlock 按钮、breach 消息发送
```

---

## 5. 成功验收标准

- [ ] 服务器下发 `intervention { action: 'chrome:tab_collapse' }` → 非白名单标签被关闭
- [ ] 服务器下发 `intervention { action: 'chrome:hard_block' }` → 当前标签出现全屏阻断页
- [ ] T0 阶段打开高刺激网站 → 自动触发 hard_block
- [ ] 强制解锁后 `/api/ingest` 收到 `sunset:breach` 记录
- [ ] 非高刺激网站不受 hard_block 影响
