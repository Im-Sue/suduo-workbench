#!/bin/sh
# 本机联调栈（在 client/ 下执行）：云端需求服务 + 本机服务（同源托管前端构建产物），数据长期保存在 SUDUO_DEV_DATA 下。
#
# 前置：
#   1. cd ../cloud && sh scripts/dev-postgres.sh start   （需求服务用的 PostgreSQL，127.0.0.1:15432 / suduo_dev）
#   2. client/ 与 cloud/ 各执行一次 pnpm build    （跑的是构建产物；改了代码重新 build 再 restart）
#   3. 环境变量 SUDUO_DEV_DATA 指向数据目录（建议写在 client/mise.local.toml 的 [env] 里，放到你希望的磁盘上）
#
# 数据目录布局（首次 start 自动创建）：
#   app/            本机服务数据（会话、审批、事件、目录关联；SUDUO_DATA_DIR）
#   codex-home/     本机服务给 Codex 用的 CODEX_HOME（模型服务配置写在这里的 config.toml；可用 SUDUO_DEV_CODEX_HOME 改位置）
#   attachments/    需求服务的附件目录
#   secrets/        需求服务的签名密钥（首次生成，0600）
#   logs/ run/      日志与进程号
#
# 用法：sh scripts/dev-local.sh start|stop|restart|status
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
DATA="${SUDUO_DEV_DATA:?请先设置 SUDUO_DEV_DATA（例如在 mise.local.toml 的 [env] 中）}"
CODEX_HOME_DIR="${SUDUO_DEV_CODEX_HOME:-$DATA/codex-home}"
REQ_PORT="${SUDUO_DEV_REQ_PORT:-19090}"
APP_PORT="${SUDUO_DEV_APP_PORT:-18787}"
PG_PORT="${SUDUO_DEV_PGPORT:-15432}"
RUN="$DATA/run"
LOGS="$DATA/logs"

# 进程号文件里的进程还活着，且确实是本脚本起的那个服务（防止进程号被别的程序复用后误判 / 误杀）。
running() {
  [ -f "$RUN/$1.pid" ] || return 1
  pid=$(cat "$RUN/$1.pid")
  kill -0 "$pid" 2>/dev/null || return 1
  case "$(ps -p "$pid" -o command= 2>/dev/null)" in
    # 带上 node 前缀比对：server/dist/main.js 也是 ../cloud/server/dist/main.js 的一部分。
    *"node $(entry "$1")"*) return 0 ;;
    *) return 1 ;;
  esac
}

entry() {
  case "$1" in
    requirements) echo "../cloud/server/dist/main.js" ;;
    app) echo "server/dist/main.js" ;;
  esac
}

# 起完等服务真正能响应（最多约 15 秒）；进程中途退出就把日志尾巴打出来。
# 探测绕开代理（设了 http_proxy 时 curl 连 127.0.0.1 也会走代理），且要求 2xx；
# 响应了还要再确认进程仍是我们起的那个（端口被别的程序占着时，我们的进程会随后退出）。
wait_ready() {
  name=$1 label=$2 url=$3 log=$4
  pid=$(cat "$RUN/$name.pid")
  deadline=$(($(date +%s) + 15))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "${label}没能起来，最近的日志（${log}）：" >&2
      tail -n 20 "$log" >&2
      rm -f "$RUN/$name.pid"
      exit 1
    fi
    if curl -fsS -o /dev/null --noproxy '*' --max-time 1 "$url" 2>/dev/null; then
      sleep 0.5
      if running "$name"; then return 0; fi
    fi
    sleep 0.5
  done
  echo "${label}进程在运行，但 15 秒内 ${url} 没有正常响应；看看日志 ${log}" >&2
  exit 1
}

prepare() {
  mkdir -p "$DATA/app" "$CODEX_HOME_DIR" "$DATA/attachments" "$DATA/secrets" "$LOGS" "$RUN"
  chmod 700 "$DATA/secrets"
  if [ ! -s "$DATA/secrets/requirements-auth-secret" ]; then
    (umask 077 && node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))' > "$DATA/secrets/requirements-auth-secret")
    echo "已生成需求服务签名密钥：${DATA}/secrets/requirements-auth-secret"
  fi
  # 密钥文件被拷贝 / 解压过权限可能变宽，每次启动都收回到只有自己可读写。
  chmod 600 "$DATA/secrets/requirements-auth-secret"
  for artifact in ../cloud/server/dist/main.js server/dist/main.js web/dist/index.html; do
    if [ ! -f "$ROOT/$artifact" ]; then
      echo "缺少构建产物 $artifact：先在 client/ 和 cloud/ 各执行 pnpm build" >&2
      exit 1
    fi
  done
}

start_requirements() {
  if running requirements; then
    echo "需求服务已在运行（127.0.0.1:${REQ_PORT}）"
    return
  fi
  (
    cd "$ROOT"
    REQUIREMENTS_DATABASE_URL="postgres://suduo@127.0.0.1:${PG_PORT}/suduo_dev" \
    REQUIREMENTS_AUTH_SECRET="$(cat "$DATA/secrets/requirements-auth-secret")" \
    REQUIREMENTS_ATTACHMENT_ROOT="$DATA/attachments" \
    REQUIREMENTS_HOST=127.0.0.1 REQUIREMENTS_PORT="$REQ_PORT" REQUIREMENTS_RUN_MIGRATIONS=true \
      nohup node ../cloud/server/dist/main.js >>"$LOGS/requirements-service.log" 2>&1 &
    echo $! > "${RUN}/requirements.pid"
  )
  wait_ready requirements "需求服务" "http://127.0.0.1:${REQ_PORT}/v2/health" "$LOGS/requirements-service.log"
  echo "需求服务已启动：http://127.0.0.1:${REQ_PORT}（日志 ${LOGS}/requirements-service.log）"
}

start_app() {
  if running app; then
    echo "本机服务已在运行（http://127.0.0.1:${APP_PORT}）"
    return
  fi
  (
    cd "$ROOT"
    SUDUO_DATA_DIR="$DATA/app" SUDUO_CODEX_HOME="$CODEX_HOME_DIR" \
    SUDUO_HOST=127.0.0.1 SUDUO_PORT="$APP_PORT" SUDUO_CODEX_BIN="$ROOT/node_modules/.bin/codex" \
      nohup node server/dist/main.js >>"$LOGS/app-server.log" 2>&1 &
    echo $! > "${RUN}/app.pid"
  )
  wait_ready app "本机服务" "http://127.0.0.1:${APP_PORT}/healthz" "$LOGS/app-server.log"
  echo "本机服务已启动：http://127.0.0.1:${APP_PORT}（日志 ${LOGS}/app-server.log，CODEX_HOME ${CODEX_HOME_DIR}）"
}

# 发 TERM 后等进程真正退出（最多 15 秒），免得 restart 时新进程撞上还没释放的端口。
stop_one() {
  if running "$1"; then
    pid=$(cat "$RUN/$1.pid")
    kill "$pid"
    tries=0
    while kill -0 "$pid" 2>/dev/null; do
      if [ "$tries" -ge 30 ]; then
        echo "$2（进程 ${pid}）15 秒内没有退出；确认无误后可手动 kill -9 ${pid}" >&2
        exit 1
      fi
      tries=$((tries + 1))
      sleep 0.5
    done
    echo "已停止 $2"
  fi
  rm -f "$RUN/$1.pid"
}

case "${1:-status}" in
  start)
    prepare
    start_requirements
    start_app
    echo "浏览器打开 http://127.0.0.1:${APP_PORT}；需求服务地址填 http://127.0.0.1:${REQ_PORT}"
    ;;
  stop)
    stop_one app "本机服务"
    stop_one requirements "需求服务"
    ;;
  restart)
    sh "$0" stop
    sh "$0" start
    ;;
  status)
    if running requirements; then echo "需求服务：运行中（127.0.0.1:${REQ_PORT}）"; else echo "需求服务：未运行"; fi
    if running app; then echo "本机服务：运行中（http://127.0.0.1:${APP_PORT}）"; else echo "本机服务：未运行"; fi
    echo "数据目录：${DATA}；CODEX_HOME：${CODEX_HOME_DIR}"
    ;;
  *)
    echo "用法：sh scripts/dev-local.sh start|stop|restart|status" >&2
    exit 2
    ;;
esac
