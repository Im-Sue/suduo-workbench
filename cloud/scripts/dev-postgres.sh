#!/bin/sh
# 本机开发用 PostgreSQL（在 cloud/ 下执行；与测试约定一致：127.0.0.1:15432，用户 suduo，本机免密）。
#
# 前置：mise 已按 cloud/mise.toml 安装 PostgreSQL；数据目录由环境变量 SUDUO_DEV_PGDATA 指定
#       （建议写在 cloud/mise.local.toml 的 [env] 里，放到你希望的磁盘上）。
# 用法：sh scripts/dev-postgres.sh start|stop|status|psql
#   start 首次运行会初始化数据目录并创建联调库 suduo_dev。
set -eu

PORT="${SUDUO_DEV_PGPORT:-15432}"
PGDATA="${SUDUO_DEV_PGDATA:?请先设置 SUDUO_DEV_PGDATA（例如在 mise.local.toml 的 [env] 中）}"
LOG="$PGDATA/../postgres-17.log"

if ! command -v pg_ctl >/dev/null 2>&1; then
  echo "找不到 pg_ctl：请在 cloud/ 下执行 mise install（见 cloud/mise.toml）" >&2
  exit 1
fi

case "${1:-status}" in
  start)
    if [ ! -f "$PGDATA/PG_VERSION" ]; then
      mkdir -p "${PGDATA}"
      initdb --pgdata="${PGDATA}" --username=suduo --auth=trust --encoding=UTF8 --locale=C >/dev/null
      echo "已初始化数据目录：${PGDATA}"
    fi
    if pg_ctl status -D "${PGDATA}" >/dev/null 2>&1; then
      echo "PostgreSQL 已在运行（端口 ${PORT}）"
    else
      pg_ctl start -D "${PGDATA}" -l "$LOG" -w -o "-p $PORT -h 127.0.0.1 -k ''" >/dev/null
      echo "PostgreSQL 已启动：127.0.0.1:${PORT}（日志 ${LOG}）"
    fi
    if ! psql -h 127.0.0.1 -p "$PORT" -U suduo -d postgres -tAc "SELECT 1 FROM pg_database WHERE datname = 'suduo_dev'" | grep -q 1; then
      createdb -h 127.0.0.1 -p "$PORT" -U suduo suduo_dev
      echo "已创建联调库 suduo_dev"
    fi
    ;;
  stop)
    pg_ctl stop -D "${PGDATA}" -m fast
    ;;
  status)
    pg_ctl status -D "${PGDATA}" || true
    ;;
  psql)
    shift
    exec psql -h 127.0.0.1 -p "$PORT" -U suduo -d "${1:-suduo_dev}"
    ;;
  *)
    echo "用法：sh scripts/dev-postgres.sh start|stop|status|psql [数据库]" >&2
    exit 2
    ;;
esac
