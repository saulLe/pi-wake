#!/bin/bash
# Pi Admin 启动脚本
PORT="${1:-8787}"
DIR="$(cd "$(dirname "$0")" && pwd)"
echo "启动 Pi Admin: http://127.0.0.1:${PORT}"
exec node "$DIR/server.mjs" --port "$PORT"
