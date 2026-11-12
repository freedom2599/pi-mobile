#!/usr/bin/env bash
#
# pi-mobile 服务管理
#
#   ./service.sh start     启动
#   ./service.sh stop      停止
#   ./service.sh restart   重启
#   ./service.sh status    状态
#   ./service.sh logs      跟踪日志
#
# 为什么不用 `pkill -f "node server.js"`：
#   那条命令会匹配到执行它的 shell 自身（命令行里含同样字符串），
#   把 shell 连同刚启动的子进程一起干掉，表现为服务莫名退出（exit 143）。
#
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PIDFILE="$HERE/.server.pid"
LOGFILE="${PI_LOG:-$HERE/logs/server.log}"
PORT="${PORT:-8848}"

mkdir -p "$(dirname "$LOGFILE")"

# 用可执行文件名+脚本名精确匹配，避免误伤
find_pid() {
  local p
  # 优先用 pidfile
  if [ -f "$PIDFILE" ]; then
    p=$(cat "$PIDFILE" 2>/dev/null || true)
    if [ -n "$p" ] && kill -0 "$p" 2>/dev/null; then
      # 校验确实是我们的进程
      if tr '\0' ' ' < "/proc/$p/cmdline" 2>/dev/null | grep -q "server.js"; then
        echo "$p"; return 0
      fi
    fi
    rm -f "$PIDFILE"
  fi
  # 回退：按 /proc 精确匹配，排除 grep 自身与 shell 包装
  for d in /proc/[0-9]*; do
    p=${d#/proc/}
    [ -r "$d/cmdline" ] || continue
    local cmd
    cmd=$(tr '\0' ' ' < "$d/cmdline" 2>/dev/null || true)
    case "$cmd" in
      "node server.js "*|"node server.js "|"node server.js")
        case "$cmd" in
          *pkill*|*grep*) continue ;;
        esac
        # 必须工作目录匹配，避免杀掉别的项目
        local cwd
        cwd=$(readlink "/proc/$p/cwd" 2>/dev/null || true)
        if [ "$cwd" = "$HERE" ]; then echo "$p"; return 0; fi
        ;;
    esac
  done
  return 1
}

is_running() { find_pid >/dev/null 2>&1; }

do_start() {
  if is_running; then
    echo "ℹ️  已在运行 (PID $(find_pid))"
    return 0
  fi
  # 端口占用检查
  if ss -tln 2>/dev/null | grep -q ":$PORT "; then
    echo "❌ 端口 $PORT 已被占用："
    ss -tlnp 2>/dev/null | grep ":$PORT " || true
    return 1
  fi
  echo "▶️  启动中…"
  cd "$HERE"
  # setsid 脱离控制终端；nohup 忽略 SIGHUP；& 后台
  setsid nohup node server.js >> "$LOGFILE" 2>&1 < /dev/null &
  local p=$!
  echo "$p" > "$PIDFILE"
  sleep 2
  if kill -0 "$p" 2>/dev/null; then
    echo "✅ 已启动 (PID $p)  端口 $PORT"
    echo "   日志: $LOGFILE"
  else
    echo "❌ 启动失败，最后 20 行日志："
    tail -20 "$LOGFILE"
    rm -f "$PIDFILE"
    return 1
  fi
}

do_stop() {
  local p
  if ! p=$(find_pid); then
    echo "ℹ️  未在运行"
    return 0
  fi
  echo "⏹  停止 PID $p …"
  kill -TERM "$p" 2>/dev/null || true
  for _ in $(seq 1 20); do
    kill -0 "$p" 2>/dev/null || break
    sleep 0.25
  done
  if kill -0 "$p" 2>/dev/null; then
    echo "   未响应，强制结束"
    kill -KILL "$p" 2>/dev/null || true
  fi
  rm -f "$PIDFILE"
  echo "✅ 已停止"
}

do_status() {
  local p
  if p=$(find_pid); then
    echo "✅ 运行中 (PID $p)"
    tr '\0' ' ' < "/proc/$p/cmdline" 2>/dev/null; echo
    local up
    up=$(ps -o etime= -p "$p" 2>/dev/null | tr -d ' ')
    echo "   已运行: $up"
    if curl -s -m 3 -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORT/health" 2>/dev/null | grep -q 200; then
      echo "   健康检查: OK"
    else
      echo "   健康检查: 无响应"
    fi
  else
    echo "⹀  未在运行"
    return 1
  fi
}

case "${1:-start}" in
  start)   do_start ;;
  stop)    do_stop ;;
  restart) do_stop; sleep 0.5; do_start ;;
  status)  do_status ;;
  logs)    tail -f "$LOGFILE" ;;
  *) echo "用法: $0 {start|stop|restart|status|logs}"; exit 1 ;;
esac
