#!/usr/bin/env bash
# Anchor 服务器一键更新：拉取公开库最新 tag → install → build → 重启
# 用法：bash scripts/update.sh
#
# 自包含说明：
# - 本脚本不做数据库操作；生产库为 SQLite 单文件，建议更新前先备份
#   （如 cp "$ANCHOR_DB_PATH" 到备份目录，注意 WAL 模式下先 checkpoint）。
# - 任意步骤失败会打印恢复指引：此时检出可能已切换到新版本，但服务仍在
#   运行旧版本；修复问题后重跑本脚本，或手工执行：
#     pnpm install && pnpm build && pm2 restart anchor
set -euo pipefail

cd "$(dirname "$0")/.."

# 标记文件：检出 tag 且 build+restart 全部成功后才写入。
# 用于区分「检出已是最新 tag」与「上次更新在该 tag 上中途中断」，避免重跑被短路。
MARKER_FILE=".anchor-update-build-ok"

# 失败时打印明确提示（trap ERR 在 set -e 中止前触发）
fail_hint() {
  echo "" >&2
  echo "⚠ 更新中断：检出可能已切换到新版本，但构建/重启未完成，服务仍在运行旧版本。" >&2
  echo "  修复问题后重跑本脚本即可继续；或手工执行：pnpm install && pnpm build && pm2 restart anchor" >&2
  echo "  如需回退到旧版本：git checkout <原 tag>" >&2
}
trap fail_hint ERR

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
  if [ -f "$MARKER_FILE" ]; then
    echo "已是最新版本（$LATEST_TAG），无需更新。"
    exit 0
  fi
  echo "检出已是最新 tag（$LATEST_TAG），但上次更新未完成（缺 $MARKER_FILE），继续执行构建与重启。"
else
  echo "当前版本：${CURRENT_TAG:-未知（非 tag 检出）}"
fi

echo "[4/6] 检出 $LATEST_TAG…"
git checkout "$LATEST_TAG"
# 检出后先移除标记：只有本次 build+restart 全部成功才重新写入
rm -f "$MARKER_FILE"

echo "[5/6] 安装依赖并构建…"
pnpm install
pnpm build

echo "[6/6] 重启服务（pm2，进程名 anchor；若你的进程名不同请修改本行）…"
pm2 restart anchor

touch "$MARKER_FILE"

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

echo "更新完成：${CURRENT_TAG:-旧版本} → $LATEST_TAG"
