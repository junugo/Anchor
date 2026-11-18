#!/usr/bin/env bash
# Anchor 服务器一键更新：拉取公开库最新 tag → install → build → 重启
# 用法：bash scripts/update.sh
# 注意：本脚本不做数据库操作，执行前请先备份 SQLite（见 README）。
set -euo pipefail

cd "$(dirname "$0")/.."

echo "[1/6] 拉取远端 tag…"
git fetch --tags

echo "[2/6] 解析最新 tag…"
LATEST_TAG="$(git describe --tags "$(git rev-list --tags --max-count=1)")"
if [ -z "$LATEST_TAG" ]; then
  echo "未发现任何 tag，退出。" >&2
  exit 1
fi
echo "最新 tag：$LATEST_TAG"

echo "[3/6] 检查当前版本…"
CURRENT_TAG="$(git describe --tags --exact-match 2>/dev/null || echo "")"
if [ "$CURRENT_TAG" = "$LATEST_TAG" ]; then
  echo "已是最新版本（$LATEST_TAG），无需更新。"
  exit 0
fi
echo "当前版本：${CURRENT_TAG:-未知（非 tag 检出）}"

echo "[4/6] 检出 $LATEST_TAG…"
git checkout "$LATEST_TAG"

echo "[5/6] 安装依赖并构建…"
pnpm install
pnpm build

echo "[6/6] 重启服务（pm2，进程名 anchor；若你的进程名不同请修改本行）…"
pm2 restart anchor

# 结尾 diff 提示：比对 .env 与 .env.example 的 ANCHOR_* 键，缺键给出黄色提示
if [ -f .env ] && [ -f .env.example ]; then
  MISSING_KEYS="$(comm -23 \
    <(grep -oE '^ANCHOR_[A-Z_]+' .env.example | sort -u) \
    <(grep -oE '^ANCHOR_[A-Z_]+' .env | sort -u) || true)"
  if [ -n "$MISSING_KEYS" ]; then
    YELLOW='\033[33m'; RESET='\033[0m'
    echo -e "${YELLOW}提示：.env 缺少新键：${MISSING_KEYS//$'\n'/、}（参考 .env.example）${RESET}"
  fi
fi

echo "更新完成：$CURRENT_TAG → $LATEST_TAG"
