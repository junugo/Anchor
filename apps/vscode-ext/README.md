# Anchor for VS Code

Anchor 节律守护的编辑器端：上报键入活动（`code_active` / `editor_idle`）、按服务器推断状态着色状态栏、日落/宵禁阶段展示。

## 使用

1. 自托管 [Anchor 服务器](https://github.com/junugo/Anchor)（默认 `http://localhost:4000`）
2. 安装本扩展（`.vsix`：扩展面板 → `...` → Install from VSIX）
3. 设置 → 扩展 → Anchor：按需修改 `anchor.serverUrl` / `anchor.dataKey`（须与服务器 `ANCHOR_DATA_KEY` 一致）

## License

MIT
