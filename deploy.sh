#!/usr/bin/env bash
# 构建 + 以 PM2 拉起单个 Node 进程，同端口托管前端静态文件、/api 与 /mcp（无需跨源配置）。
# 用法: ./deploy.sh （配置见 .env，默认值见 .env.example）
set -euo pipefail
cd "$(dirname "$0")"

# ---- 读取 .env ----
if [ ! -f .env ]; then
  echo "未找到 .env：请先 cp .env.example .env，并配置 APP_SECRET / SETUP_TOKEN / APP_ORIGIN" >&2
  exit 1
fi
set -a; . ./.env; set +a

APP_NAME="${PM2_APP_NAME:-omnimail}"
HOST="${HOST:-127.0.0.1}"
PORT="${PORT:-3000}"

command -v pm2 >/dev/null 2>&1 || { echo "安装 pm2..."; npm install -g pm2; }

echo "安装依赖..."
npm ci --no-audit --no-fund
npm --prefix frontend ci

echo "构建（tsc + vue-tsc + vite build）..."
npm run build

echo "重启 pm2 进程..."
pm2 delete "${APP_NAME}" >/dev/null 2>&1 || true

# NODE_ENV=production 触发服务端的 HTTPS / APP_ORIGIN 校验；HOST / PORT 等由服务端自行读取 .env
NODE_ENV=production pm2 start dist/server/index.js --name "${APP_NAME}" --time

pm2 save
echo
echo "部署完成："
echo "  入口  http://${HOST}:${PORT}  (pm2: ${APP_NAME})"
echo "  反代  HTTPS -> ${HOST}:${PORT}，反代域名需与 APP_ORIGIN 一致"
pm2 list
