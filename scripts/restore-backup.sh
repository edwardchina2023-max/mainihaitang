#!/usr/bin/env bash
# 麦尼海塘 · 一键恢复到备份版本
#
# 做法：新建一个提交，让网站内容与备份分支完全一致（多出来的文件会被删除），然后推送到 main。
# 不改写历史：恢复本身也能再被撤销（git revert 这一提交即可回到优化版）。
#
# 用法：bash scripts/restore-backup.sh [备份分支名]
# 默认备份分支：backup/2026-10-18-before-optimization
set -euo pipefail

BACKUP="${1:-backup/2026-10-18-before-optimization}"

if [ -n "$(git status --porcelain)" ]; then
  echo "当前目录有未提交的修改，请先提交或清理后再恢复。" >&2
  exit 1
fi

git fetch origin "$BACKUP" main
git checkout main
git merge --ff-only origin/main

# 让暂存区与工作区完全等同于备份分支的文件树
git read-tree -u --reset "origin/$BACKUP"

if git diff --cached --quiet; then
  echo "当前 main 已经与备份 $BACKUP 一致，无需恢复。"
  exit 0
fi

git commit -m "restore: 恢复到备份 $BACKUP"
git push origin main
echo "已恢复到 $BACKUP 并推送，GitHub Pages 通常 1–3 分钟后生效。"
