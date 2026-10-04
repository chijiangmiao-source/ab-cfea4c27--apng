#!/bin/sh
# verify 验收服务入口：代码测试 → 页面构建检查 → HTTP 冒烟（页面 + /healthz）
# 全部通过退出 0，任一失败立即以对应非零退出码报告。
set -eu

echo "== [1/3] 代码测试 (node --test) =="
node --test test/

echo "== [2/3] 页面构建检查 =="
node scripts/check-build.mjs

echo "== [3/3] HTTP 冒烟（页面 + /healthz）=="
node scripts/smoke.mjs

echo ""
echo "全部验收步骤通过 ✅"
