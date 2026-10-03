#!/usr/bin/env bash
# SuDuo cloud: install and operate the requirements service with Docker Compose.
# Usage: ./scripts/suduo-cloud.sh <install|upgrade|backup|restore|status|logs|start|stop|uninstall|help> [options]
# Run it from a git checkout of a release tag. It never installs software or changes host configuration.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLOUD_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SERVER_DIR="$CLOUD_DIR/server"
ENV_FILE="$SERVER_DIR/.env"
ENV_EXAMPLE="$SERVER_DIR/.env.example"
COMPOSE_FILE="$SERVER_DIR/compose.yaml"
SERVICE="requirements-service"
DEFAULT_BACKUP_ROOT="/var/backups/suduo"
HEALTH_TIMEOUT_SECONDS=180

# ---------- language: Chinese when the system locale is Chinese, English otherwise ----------
case "${LC_ALL:-${LC_MESSAGES:-${LANG:-}}}" in
  zh*) UI_LANG=zh ;;
  *) UI_LANG=en ;;
esac
# say "中文" "English"
say() { if [ "$UI_LANG" = zh ]; then printf '%s\n' "$1"; else printf '%s\n' "$2"; fi; }
ok() { if [ "$UI_LANG" = zh ]; then printf '  ✓ %s\n' "$1"; else printf '  ✓ %s\n' "$2"; fi; }
warn() { if [ "$UI_LANG" = zh ]; then printf '  ⚠ %s\n' "$1" >&2; else printf '  ⚠ %s\n' "$2" >&2; fi; }
die() { if [ "$UI_LANG" = zh ]; then printf '  ✗ %s\n' "$1" >&2; else printf '  ✗ %s\n' "$2" >&2; fi; exit 1; }

OVERRIDE_FILE="$SERVER_DIR/compose.override.yaml"
# 本机定制（例如只对本机开放端口）写在 server/compose.override.yaml，存在时自动带上；该文件不进 git。
compose() {
  if [ -f "$OVERRIDE_FILE" ]; then
    docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" -f "$OVERRIDE_FILE" "$@"
  else
    docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
  fi
}

product_version() {
  sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "$CLOUD_DIR/package.json" | head -n 1
}

env_value() { # env_value KEY → value from .env (empty when absent)
  [ -f "$ENV_FILE" ] || return 0
  sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1
}

set_env_value() { # set_env_value KEY VALUE → replace or append in .env
  local key="$1" value="$2" tmp
  tmp="$(mktemp)"
  if grep -q "^$key=" "$ENV_FILE"; then
    awk -v k="$key" -v v="$value" 'BEGIN{FS=OFS="="} $1==k {print k "=" v; next} {print}' "$ENV_FILE" > "$tmp"
  else
    cat "$ENV_FILE" > "$tmp"
    printf '%s=%s\n' "$key" "$value" >> "$tmp"
  fi
  cat "$tmp" > "$ENV_FILE"
  rm -f "$tmp"
}

random_secret() { # random_secret LENGTH → [A-Za-z0-9] only (safe inside a database URL)
  local length="$1"
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 $((length * 2)) | tr -dc 'A-Za-z0-9' | head -c "$length"
  else
    LC_ALL=C tr -dc 'A-Za-z0-9' < /dev/urandom | head -c "$length"
  fi
}

port() { local value; value="$(env_value REQUIREMENTS_PORT)"; printf '%s' "${value:-4100}"; }

http_get() { # http_get URL → body on success
  if command -v curl >/dev/null 2>&1; then curl -fsS --max-time 5 "$1"
  elif command -v wget >/dev/null 2>&1; then wget -qO- --timeout=5 "$1"
  else compose exec -T "$SERVICE" node -e "fetch(process.argv[1]).then(async r=>{if(!r.ok)process.exit(1);process.stdout.write(await r.text())}).catch(()=>process.exit(1))" "$1"
  fi
}

health_json() { http_get "http://127.0.0.1:$(port)/v2/health" 2>/dev/null; }
json_field() { sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p"; }

wait_for_health() {
  local waited=0
  while [ "$waited" -lt "$HEALTH_TIMEOUT_SECONDS" ]; do
    if health_json >/dev/null; then return 0; fi
    sleep 3
    waited=$((waited + 3))
  done
  return 1
}

host_address() {
  local address=""
  if command -v hostname >/dev/null 2>&1; then address="$(hostname -I 2>/dev/null | awk '{print $1}')"; fi
  printf '%s' "${address:-127.0.0.1}"
}

# ---------- checks ----------
check_platform() {
  if [ "$(uname -s)" != "Linux" ]; then
    warn "当前系统不是 Linux。正式支持 Ubuntu 22.04 / 24.04，其他环境尽力而为。" \
         "This is not Linux. Ubuntu 22.04 / 24.04 are supported; other systems are best effort."
  fi
}

check_docker() {
  command -v docker >/dev/null 2>&1 || die \
    "没有找到 Docker。请先按官方文档安装 Docker Engine 与 Compose 插件：https://docs.docker.com/engine/install/ （国内服务器可用阿里云、清华等镜像站的安装源）。" \
    "Docker is not installed. Install Docker Engine and the Compose plugin first: https://docs.docker.com/engine/install/"
  local server_version
  if ! server_version="$(docker version --format '{{.Server.Version}}' 2>/dev/null)"; then
    die "无法连接 Docker。请用 sudo 运行本脚本，或把当前用户加入 docker 组后重新登录。" \
        "Cannot talk to Docker. Run this script with sudo, or add your user to the docker group and log in again."
  fi
  docker compose version >/dev/null 2>&1 || die \
    "没有找到 Docker Compose 插件（docker compose）。请安装 docker-compose-plugin。" \
    "The Docker Compose plugin (docker compose) is missing. Install docker-compose-plugin."
  ok "Docker $server_version / Compose $(docker compose version --short 2>/dev/null)" \
     "Docker $server_version / Compose $(docker compose version --short 2>/dev/null)"
}

port_in_use() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

# ---------- install ----------
apply_mirror() { # apply_mirror cn|default
  case "$1" in
    cn)
      set_env_value SUDUO_NODE_IMAGE "docker.m.daocloud.io/library/node:24.10.0-bookworm-slim"
      set_env_value SUDUO_POSTGRES_IMAGE "docker.m.daocloud.io/library/postgres:17.4-bookworm"
      set_env_value SUDUO_NPM_REGISTRY "https://registry.npmmirror.com"
      ok "已切换到国内镜像源（写入 server/.env，可随时修改）" "Using mirrors in mainland China (saved in server/.env; edit any time)"
      ;;
    default) ;;
    *) die "不认识的镜像源：$1（可选 cn）" "Unknown mirror: $1 (supported: cn)" ;;
  esac
}

cmd_install() {
  local wanted_port="" mirror=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --port) wanted_port="${2:?}"; shift 2 ;;
      --mirror) mirror="${2:?}"; shift 2 ;;
      *) die "不认识的参数：$1" "Unknown option: $1" ;;
    esac
  done
  say "SuDuo 云端 $(product_version) · 安装" "SuDuo cloud $(product_version) · install"
  check_platform
  check_docker

  if [ -f "$ENV_FILE" ]; then
    ok "检测到已有配置 server/.env，沿用其中的密钥（不会覆盖）" "Found server/.env; keeping its secrets (it is never overwritten)"
    [ -z "$wanted_port" ] || set_env_value REQUIREMENTS_PORT "$wanted_port"
  else
    [ -f "$ENV_EXAMPLE" ] || die "缺少 server/.env.example，请确认在完整的仓库里运行。" "server/.env.example is missing; run this from a full checkout."
    local db_password auth_secret
    db_password="$(random_secret 32)"
    auth_secret="$(random_secret 64)"
    umask 077
    cp "$ENV_EXAMPLE" "$ENV_FILE"
    set_env_value POSTGRES_PASSWORD "$db_password"
    set_env_value REQUIREMENTS_AUTH_SECRET "$auth_secret"
    set_env_value REQUIREMENTS_DATABASE_URL "postgresql://suduo:$db_password@postgres:5432/suduo_requirements"
    set_env_value REQUIREMENTS_PORT "${wanted_port:-4100}"
    chmod 600 "$ENV_FILE"
    ok "已生成 server/.env（数据库密码与签名密钥为随机值，请妥善保管此文件）" \
       "Created server/.env with a random database password and signing secret. Keep this file safe."
  fi
  [ -z "$mirror" ] || apply_mirror "$mirror"

  if ! health_json >/dev/null && port_in_use "$(port)"; then
    die "端口 $(port) 已被其他程序占用。换一个端口：--port <端口>。" "Port $(port) is already in use. Choose another one with --port <port>."
  fi

  say "  … 构建镜像并启动（首次约 3–8 分钟）" "  … building the image and starting (first time: about 3–8 minutes)"
  compose up -d --build
  if ! wait_for_health; then
    die "服务在 ${HEALTH_TIMEOUT_SECONDS} 秒内没有就绪。查看日志：./scripts/suduo-cloud.sh logs" \
        "The service was not ready within ${HEALTH_TIMEOUT_SECONDS}s. See the logs: ./scripts/suduo-cloud.sh logs"
  fi
  local health version schema
  health="$(health_json)"
  version="$(printf '%s' "$health" | json_field version)"
  schema="$(printf '%s' "$health" | json_field schemaVersion)"
  ok "SuDuo 云端已就绪（版本 ${version:-?}，数据库 schema ${schema:-?}）" "SuDuo cloud is ready (version ${version:-?}, database schema ${schema:-?})"
  echo
  say "  访问地址：http://$(host_address):$(port)" "  Address: http://$(host_address):$(port)"
  say "  下一步：在 SuDuo 客户端的设置里填上这个地址，第一个注册的人即可开始使用。" \
      "  Next: enter this address in the SuDuo client settings. Anyone can then register and start."
  echo
  warn "现在任何能访问这个地址的人都能注册账号。请只在内网或 VPN 内开放，或放到带访问控制的反向代理后面（见部署文档）。" \
       "Anyone who can reach this address can register an account. Keep it on a private network or VPN, or behind a reverse proxy with access control (see the deployment guide)."
  warn "企业使用 SuDuo 一般属于商业使用：可以直接用，请在开始使用后 30 天内登记，目前免费。见 COMMERCIAL.md。" \
       "Use by a company is generally commercial use: you can start right away and register within 30 days of first use. It is currently free. See COMMERCIAL.md."
}

# ---------- backup / restore ----------
require_env() { [ -f "$ENV_FILE" ] || die "还没有安装（找不到 server/.env）。先运行 install。" "Not installed yet (server/.env not found). Run install first."; }

sha256_of() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'; else shasum -a 256 "$1" | awk '{print $1}'; fi; }

do_backup() { # do_backup TARGET_DIR → creates the backup there; the service is stopped during the backup
  local target="$1" version schema
  local health; health="$(health_json || true)"
  version="$(printf '%s' "$health" | json_field version)"
  schema="$(printf '%s' "$health" | json_field schemaVersion)"
  mkdir -p "$target" || die "无法创建备份目录 $target（需要 sudo，或用 --to 指定其他目录）。" "Cannot create $target (use sudo, or choose another directory with --to)."
  # docker -v 只认绝对路径：相对路径会被当成具名卷。
  target="$(cd "$target" && pwd)"
  say "  … 停止服务以取得一致的备份" "  … stopping the service for a consistent backup"
  compose stop "$SERVICE" >/dev/null
  local failed=0
  # shellcheck disable=SC2016 # 变量在 postgres 容器里展开
  compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' > "$target/database.pgdump" || failed=1
  if [ "$failed" -eq 0 ]; then
    compose run --rm --no-deps -T --user 0 --entrypoint tar -v "$target:/backup" "$SERVICE" \
      -C /var/lib/suduo -czf /backup/files.tar.gz attachments room-files || failed=1
  fi
  compose start "$SERVICE" >/dev/null
  [ "$failed" -eq 0 ] || return 1
  cat > "$target/manifest.txt" <<MANIFEST
created=$(date -u +%Y-%m-%dT%H:%M:%SZ)
version=${version:-unknown}
schema=${schema:-unknown}
database.pgdump=$(sha256_of "$target/database.pgdump")
files.tar.gz=$(sha256_of "$target/files.tar.gz")
MANIFEST
  wait_for_health || warn "服务重启后尚未就绪，请检查日志。" "The service is not ready after restarting; check the logs."
  return 0
}

backup_dir_for() { printf '%s/%s' "${1:-$DEFAULT_BACKUP_ROOT}" "$(date -u +%Y-%m-%dT%H-%M-%SZ)"; }

cmd_backup() {
  local root=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --to) root="${2:?}"; shift 2 ;;
      *) die "不认识的参数：$1" "Unknown option: $1" ;;
    esac
  done
  require_env; check_docker
  local target; target="$(backup_dir_for "$root")"
  do_backup "$target" || die "备份失败，服务已恢复运行。" "Backup failed; the service is running again."
  ok "已备份到 $target（数据库 + 附件 + 房间文件）" "Backed up to $target (database, attachments and room files)"
}

confirm() { # confirm WORD → asks the user to type WORD
  local answer=""
  if [ "${SUDUO_ASSUME_YES:-}" = "1" ]; then return 0; fi
  if [ -t 0 ]; then
    if [ "$UI_LANG" = zh ]; then printf '  请输入 %s 确认：' "$1"; else printf '  Type %s to confirm: ' "$1"; fi
    read -r answer
  fi
  [ "$answer" = "$1" ]
}

cmd_restore() {
  local source="${1:-}"
  [ -n "$source" ] || die "用法：restore <备份目录>" "Usage: restore <backup directory>"
  if [ ! -f "$source/database.pgdump" ] || [ ! -f "$source/files.tar.gz" ]; then
    die "$source 不是完整的备份（需要 database.pgdump 与 files.tar.gz）。" "$source is not a complete backup (expected database.pgdump and files.tar.gz)."
  fi
  # docker -v 只认绝对路径：相对路径会被当成具名卷。
  source="$(cd "$source" && pwd)"
  require_env; check_docker
  if [ -f "$source/manifest.txt" ]; then
    local expected actual
    for file in database.pgdump files.tar.gz; do
      expected="$(sed -n "s/^$file=//p" "$source/manifest.txt")"
      actual="$(sha256_of "$source/$file")"
      [ -z "$expected" ] || [ "$expected" = "$actual" ] || die "$file 的校验值与清单不符，备份可能已损坏。" "$file does not match the manifest checksum; the backup may be damaged."
    done
    ok "备份校验通过（$(sed -n 's/^version=//p' "$source/manifest.txt")，schema $(sed -n 's/^schema=//p' "$source/manifest.txt")）" \
       "Backup verified (version $(sed -n 's/^version=//p' "$source/manifest.txt"), schema $(sed -n 's/^schema=//p' "$source/manifest.txt"))"
  fi
  warn "恢复会用备份替换当前全部数据（数据库、附件、房间文件），当前数据无法找回。需要的话先运行 backup。" \
       "Restoring replaces all current data (database, attachments and room files). Current data cannot be recovered. Run backup first if you need it."
  confirm restore || die "已取消。" "Cancelled."
  say "  … 停止服务并恢复" "  … stopping the service and restoring"
  compose stop "$SERVICE" >/dev/null
  # shellcheck disable=SC2016 # 变量在 postgres 容器里展开
  compose exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner' < "$source/database.pgdump"
  compose run --rm --no-deps -T --user 0 --entrypoint sh -v "$source:/backup:ro" "$SERVICE" -c \
    'find /var/lib/suduo/attachments /var/lib/suduo/room-files -mindepth 1 -delete && tar -C /var/lib/suduo -xzf /backup/files.tar.gz && chown -R 10001:10001 /var/lib/suduo/attachments /var/lib/suduo/room-files'
  compose start "$SERVICE" >/dev/null
  wait_for_health || die "恢复后服务没有就绪，请查看日志。" "The service is not ready after restoring; check the logs."
  ok "恢复完成。请抽查几个附件能否下载。" "Restore complete. Spot-check that a few attachments download."
}

# ---------- upgrade ----------
cmd_upgrade() {
  local root=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --backup-to) root="${2:?}"; shift 2 ;;
      *) die "不认识的参数：$1" "Unknown option: $1" ;;
    esac
  done
  require_env; check_docker
  local before_health before_version before_schema target
  before_health="$(health_json || true)"
  before_version="$(printf '%s' "$before_health" | json_field version)"
  before_schema="$(printf '%s' "$before_health" | json_field schemaVersion)"
  say "SuDuo 云端 · 升级 ${before_version:-?} → $(product_version)" "SuDuo cloud · upgrade ${before_version:-?} → $(product_version)"
  target="$(backup_dir_for "$root")"
  do_backup "$target" || die \
    "升级前备份失败，没有继续升级（数据库迁移只能向前，没有备份就没有回滚路径）。修好后重试，或用 --backup-to 指定其他目录。" \
    "The pre-upgrade backup failed, so the upgrade did not start (migrations only go forward; without a backup there is no way back). Fix it and retry, or choose another directory with --backup-to."
  ok "已备份到 $target" "Backed up to $target"
  say "  … 重新构建并启动" "  … rebuilding and starting"
  compose up -d --build
  if ! wait_for_health; then
    warn "新版本没有就绪。回滚：git checkout <旧版本标签>，然后 ./scripts/suduo-cloud.sh restore $target" \
         "The new version is not ready. To roll back: git checkout <previous tag>, then ./scripts/suduo-cloud.sh restore $target"
    exit 1
  fi
  local after; after="$(health_json)"
  ok "升级完成：${before_version:-?} → $(printf '%s' "$after" | json_field version)（schema ${before_schema:-?} → $(printf '%s' "$after" | json_field schemaVersion)）" \
     "Upgraded: ${before_version:-?} → $(printf '%s' "$after" | json_field version) (schema ${before_schema:-?} → $(printf '%s' "$after" | json_field schemaVersion))"
  say "  备份位置：$target" "  Backup: $target"
}

# ---------- status / logs / start / stop / uninstall ----------
cmd_status() {
  require_env; check_docker
  compose ps
  local health; health="$(health_json || true)"
  if [ -n "$health" ]; then
    ok "健康：版本 $(printf '%s' "$health" | json_field version)，schema $(printf '%s' "$health" | json_field schemaVersion)，地址 http://$(host_address):$(port)" \
       "Healthy: version $(printf '%s' "$health" | json_field version), schema $(printf '%s' "$health" | json_field schemaVersion), address http://$(host_address):$(port)"
  else
    warn "健康检查没有通过，查看日志：./scripts/suduo-cloud.sh logs" "Health check failed; see ./scripts/suduo-cloud.sh logs"
  fi
  compose run --rm --no-deps -T --entrypoint du "$SERVICE" -sh /var/lib/suduo/attachments /var/lib/suduo/room-files 2>/dev/null || true
  local latest=""
  if [ -d "$DEFAULT_BACKUP_ROOT" ]; then
    latest="$(find "$DEFAULT_BACKUP_ROOT" -mindepth 1 -maxdepth 1 -type d -printf '%f\n' 2>/dev/null | sort | tail -n 1)"
  fi
  if [ -n "$latest" ]; then say "  最近一次备份：$DEFAULT_BACKUP_ROOT/$latest" "  Latest backup: $DEFAULT_BACKUP_ROOT/$latest"
  else say "  $DEFAULT_BACKUP_ROOT 下还没有备份" "  No backups in $DEFAULT_BACKUP_ROOT yet"; fi
}

cmd_logs() {
  require_env
  if [ "${1:-}" = "--db" ]; then compose logs -f --tail 200 postgres; else compose logs -f --tail 200 "$SERVICE"; fi
}

cmd_uninstall() {
  require_env; check_docker
  if [ "${1:-}" = "--purge" ]; then
    warn "将删除容器、镜像以及全部数据（数据库、附件、房间文件），无法恢复。" \
         "This removes the containers, the image and ALL data (database, attachments, room files). It cannot be undone."
    confirm purge || die "已取消。" "Cancelled."
    compose down -v --rmi local
    ok "已删除服务与全部数据。server/.env 仍保留，可手动删除。" "Removed the service and all data. server/.env is kept; delete it yourself if you want."
  else
    compose down --rmi local
    ok "已删除容器与镜像，数据与 server/.env 保留。重新运行 install 即可恢复服务。" \
       "Removed the containers and the image. Data and server/.env are kept; run install again to bring the service back."
  fi
}

usage() {
  if [ "$UI_LANG" = zh ]; then
    cat <<'USAGE'
用法：./scripts/suduo-cloud.sh <命令> [参数]

  install [--port 端口] [--mirror cn]   生成配置、构建并启动（已有 server/.env 时沿用其中的密钥）
  upgrade [--backup-to 目录]             先备份，再按当前检出的版本重建并启动
  backup [--to 目录]                     停服备份数据库、附件与房间文件（默认 /var/backups/suduo）
  restore <备份目录>                     用备份替换当前全部数据（需要输入 restore 确认）
  status                                 容器状态、版本、数据占用、最近一次备份
  logs [--db]                            跟随服务日志（--db 看数据库日志）
  start | stop                           启动 / 停止，不动数据
  uninstall [--purge]                    删除容器与镜像；--purge 连数据一起删除（需要输入 purge 确认）
USAGE
  else
    cat <<'USAGE'
Usage: ./scripts/suduo-cloud.sh <command> [options]

  install [--port PORT] [--mirror cn]   create the configuration, build and start (an existing server/.env is kept)
  upgrade [--backup-to DIR]              back up first, then rebuild and start the checked-out version
  backup [--to DIR]                      stop the service and back up the database, attachments and room files (default /var/backups/suduo)
  restore <backup dir>                   replace all current data with a backup (type "restore" to confirm)
  status                                 containers, version, data size, latest backup
  logs [--db]                            follow the service logs (--db for the database)
  start | stop                           start / stop without touching data
  uninstall [--purge]                    remove containers and the image; --purge also deletes all data (type "purge" to confirm)
USAGE
  fi
}

main() {
  local command="${1:-help}"
  [ $# -eq 0 ] || shift
  case "$command" in
    install) cmd_install "$@" ;;
    upgrade) cmd_upgrade "$@" ;;
    backup) cmd_backup "$@" ;;
    restore) cmd_restore "$@" ;;
    status) cmd_status ;;
    logs) cmd_logs "$@" ;;
    start) require_env; compose up -d ;;
    stop) require_env; compose stop ;;
    uninstall) cmd_uninstall "$@" ;;
    help | -h | --help) usage ;;
    *) usage; exit 1 ;;
  esac
}

main "$@"
