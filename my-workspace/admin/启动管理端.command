#!/bin/bash
# Pi Admin 启动脚本（普通终端运行，避免沙箱拦截 Pi 的锁文件）
cd "$(dirname "$0")" || exit 1

echo "==> 检查 8787 端口占用..."
OLD_PID=$(lsof -tiTCP:8787 -sTCP:LISTEN 2>/dev/null)
if [ -n "$OLD_PID" ]; then
  echo "==> 停止旧服务 (PID $OLD_PID)..."
  echo "$OLD_PID" | xargs kill 2>/dev/null
  # 旧进程可能挂着 SSE 长连接，轮询等待端口真正释放，避免新进程 EADDRINUSE
  for i in $(seq 1 30); do
    if ! lsof -tiTCP:8787 -sTCP:LISTEN >/dev/null 2>&1; then break; fi
    sleep 0.3
  done
  LEFT=$(lsof -tiTCP:8787 -sTCP:LISTEN 2>/dev/null)
  if [ -n "$LEFT" ]; then
    echo "==> 旧服务未退出，强制停止 (PID $LEFT)..."
    echo "$LEFT" | xargs kill -9 2>/dev/null
    sleep 0.5
  fi
fi

echo "==> 启动 Pi Admin（http://127.0.0.1:8787）"
echo "==> 在浏览器打开 http://127.0.0.1:8787/#sessions"
echo "==> 关闭此窗口即停止服务"
echo ""
exec node server.mjs --port 8787
