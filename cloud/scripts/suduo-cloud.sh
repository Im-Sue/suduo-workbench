#!/usr/bin/env bash
# SuDuo cloud: install and operate the requirements service with Docker Compose.
# Usage: ./scripts/suduo-cloud.sh <install|upgrade|backup|restore|status|logs|start|stop|uninstall|help> [options]
# Run it from a git checkout of a release tag. It never installs software or changes host configuration.
set -euo pipefail
# 备份里有整库数据与全部附件，脚本创建的文件只给当前用户（通常是 root）读写。
umask 077
unset CDPATH

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
CLOUD_DIR="$(cd -- "$SCRIPT_DIR/.." && pwd)"
SERVER_DIR="$CLOUD_DIR/server"
ENV_FILE="$SERVER_DIR/.env"
ENV_EXAMPLE="$SERVER_DIR/.env.example"
COMPOSE_FILE="$SERVER_DIR/compose.yaml"
OVERRIDE_FILE="$SERVER_DIR/compose.override.yaml"
SERVICE="requirements-service"
DEFAULT_BACKUP_ROOT="/var/backups/suduo"
HEALTH_TIMEOUT_SECONDS=180
CN_IMAGE_REGISTRY="docker.m.daocloud.io/library"
CN_NPM_REGISTRY="https://registry.npmmirror.com"

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

# 本机定制（例如只对本机开放端口）写在 server/compose.override.yaml，存在时自动带上；该文件不进 git。
compose() {
  if [ -f "$OVERRIDE_FILE" ]; then
    docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" -f "$OVERRIDE_FILE" "$@"
  else
    docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"
  fi
}

# ---------- exit handling: never leave the service stopped by accident ----------
STOPPED_SERVICE=0    # 1：本脚本停掉了原本在运行的服务，退出前要把它启动回来
STARTED_POSTGRES=0   # 1：本脚本为了导出而启动了原本停着的数据库，结束后停回去
RESTORE_STAGE=""     # 恢复进行到哪一步；中途退出时据此说明当前状态
CURRENT_PARTIAL=""   # 正在写的备份目录（.partial）；中途退出时删掉，不留残缺备份
PRE_RESTORE_BACKUP=""

on_exit() {
  local code=$?
  if [ -n "$CURRENT_PARTIAL" ]; then
    rm -rf -- "$CURRENT_PARTIAL"
    CURRENT_PARTIAL=""
  fi
  if [ "$STOPPED_SERVICE" = 1 ]; then
    compose start "$SERVICE" >/dev/null 2>&1 || true
    STOPPED_SERVICE=0
  fi
  if [ "$STARTED_POSTGRES" = 1 ]; then
    compose stop postgres >/dev/null 2>&1 || true
    STARTED_POSTGRES=0
  fi
  if [ -n "$RESTORE_STAGE" ]; then
    report_restore_interrupted
  fi
  exit "$code"
}
trap on_exit EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
trap 'exit 129' HUP

report_restore_interrupted() {
  case "$RESTORE_STAGE" in
    database)
      warn "恢复在导入数据库时中断。导入在单个事务里进行，数据库现在是空的；附件与房间文件还没有改动。服务保持停止。" \
           "The restore stopped while importing the database. The import runs in one transaction, so the database is now empty; attachments and room files are untouched. The service stays stopped."
      ;;
    files)
      warn "数据库已经恢复，但附件与房间文件没有恢复完整。服务保持停止。" \
           "The database was restored, but attachments and room files were not fully restored. The service stays stopped."
      ;;
    starting)
      warn "数据已经恢复，但服务没有按当前检出的版本启动成功。如果备份来自更新的版本，先 git checkout 到那个版本，再执行 start。" \
           "The data was restored, but the service did not start with the checked-out version. If the backup comes from a newer version, git checkout that version first, then run start."
      ;;
  esac
  case "$RESTORE_STAGE" in
    database | files)
      say "  可以用同一份备份再执行一次 restore。" "  You can run restore again with the same backup."
      ;;
  esac
  if [ -n "$PRE_RESTORE_BACKUP" ]; then
    say "  恢复前的数据在：$PRE_RESTORE_BACKUP（需要时用 restore 恢复回去）" \
        "  The data from before the restore is in $PRE_RESTORE_BACKUP (restore it if you need it back)"
  fi
}

# ---------- small helpers ----------
product_version() {
  sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "$CLOUD_DIR/package.json" | head -n 1
}

env_value() { # env_value KEY → value from .env (empty when absent); tolerates export, quotes and CRLF
  [ -f "$ENV_FILE" ] || return 0
  sed -n "s/^[[:space:]]*\(export[[:space:]]\{1,\}\)\{0,1\}$1=//p" "$ENV_FILE" | tail -n 1 | tr -d '\r' |
    sed -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
}

set_env_value() { # set_env_value KEY VALUE → replace or append in .env, keeping its permissions
  local key="$1" value="$2" tmp
  tmp="$(mktemp)"
  if grep -q "^$key=" "$ENV_FILE"; then
    awk -v k="$key" -v v="$value" 'BEGIN{FS=OFS="="} $1==k {print k "=" v; next} {print}' "$ENV_FILE" > "$tmp"
  else
    cat "$ENV_FILE" > "$tmp"
    # 原文件最后一行没有换行时先补上，免得新键接到上一行末尾。
    [ -z "$(tail -c 1 "$ENV_FILE")" ] || printf '\n' >> "$tmp"
    printf '%s=%s\n' "$key" "$value" >> "$tmp"
  fi
  cat "$tmp" > "$ENV_FILE"
  rm -f "$tmp"
}

random_secret() { # random_secret LENGTH → [A-Za-z0-9] only (safe inside a database URL)
  local length="$1"
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -base64 $((length * 2)) | tr -dc 'A-Za-z0-9' | cut -c "1-$length"
  else
    head -c $((length * 2)) /dev/urandom | od -An -tx1 | tr -dc 'a-f0-9' | cut -c "1-$length"
  fi
}

port() { local value; value="$(env_value REQUIREMENTS_PORT)"; printf '%s' "${value:-4100}"; }

is_service_running() { compose ps --status running --services 2>/dev/null | grep -qx "$1"; }

host_address() {
  local address=""
  if command -v hostname >/dev/null 2>&1; then address="$(hostname -I 2>/dev/null | awk '{print $1}')"; fi
  printf '%s' "${address:-127.0.0.1}"
}

json_field() { sed -n "s/.*\"$1\":\"\([^\"]*\)\".*/\1/p"; }

# 健康检查绕开代理（服务器上常配 http_proxy）；端口只绑在其他地址时改为在容器里检查。
health_json() {
  local url
  url="http://127.0.0.1:$(port)/v2/health"
  if command -v curl >/dev/null 2>&1 && curl -fsS --noproxy '*' --max-time 5 "$url" 2>/dev/null; then return 0; fi
  if command -v wget >/dev/null 2>&1 && wget -qO- --no-proxy --timeout=5 "$url" 2>/dev/null; then return 0; fi
  is_service_running "$SERVICE" || return 1
  compose exec -T "$SERVICE" node -e \
    "fetch('http://127.0.0.1:'+(process.env.REQUIREMENTS_PORT||'4100')+'/v2/health').then(async r=>{if(!r.ok)process.exit(1);process.stdout.write(await r.text())}).catch(()=>process.exit(1))" \
    2>/dev/null
}

wait_for_health() {
  local deadline=$((SECONDS + HEALTH_TIMEOUT_SECONDS))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if health_json >/dev/null; then return 0; fi
    sleep 3
  done
  return 1
}

# 正在运行的服务的版本；服务没在跑时读镜像里的版本文件。
running_version() {
  local version
  version="$(health_json 2>/dev/null | json_field version || true)"
  if [ -z "$version" ]; then
    version="$(compose run --rm --no-deps -T --entrypoint cat "$SERVICE" /app/SUDUO_VERSION 2>/dev/null | tr -d '\r\n' || true)"
  fi
  printf '%s' "$version"
}

schema_version() { # 当前数据库的 schema 版本（数据库需在运行）
  # shellcheck disable=SC2016 # 变量在 postgres 容器里展开
  compose exec -T postgres sh -c 'psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tAc "SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1"' 2>/dev/null |
    tr -d '\r\n' || true
}

sha256_of() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'; else shasum -a 256 "$1" | awk '{print $1}'; fi; }

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

require_env() { [ -f "$ENV_FILE" ] || die "还没有安装（找不到 server/.env）。先运行 install。" "Not installed yet (server/.env not found). Run install first."; }

port_in_use() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

confirm() { # confirm WORD → asks the user to type WORD; SUDUO_ASSUME_YES=1 skips it for automation
  local answer=""
  if [ "${SUDUO_ASSUME_YES:-}" = "1" ]; then return 0; fi
  if [ -t 0 ]; then
    if [ "$UI_LANG" = zh ]; then printf '  请输入 %s 确认：' "$1"; else printf '  Type %s to confirm: ' "$1"; fi
    read -r answer
  fi
  [ "$answer" = "$1" ]
}

# ---------- install ----------
apply_mirror() { # apply_mirror cn
  case "$1" in
    cn)
      # 只记仓库前缀与 npm 源；镜像的版本标签留在 compose.yaml 里，升级时随代码更新。
      set_env_value SUDUO_IMAGE_REGISTRY "$CN_IMAGE_REGISTRY"
      set_env_value SUDUO_NPM_REGISTRY "$CN_NPM_REGISTRY"
      ok "已切换到国内镜像源（写入 server/.env，可随时修改）" "Using mirrors in mainland China (saved in server/.env; edit any time)"
      ;;
    *) die "不认识的镜像源：$1（可选 cn）" "Unknown mirror: $1 (supported: cn)" ;;
  esac
}

need_value() { # need_value "$@" → 选项后面必须跟一个值
  if [ $# -lt 2 ] || [ -z "$2" ]; then
    die "$1 后面需要一个值。" "$1 needs a value."
  fi
}

valid_port() { [[ "$1" =~ ^[0-9]+$ ]] && [ "$1" -ge 1 ] && [ "$1" -le 65535 ]; }

cmd_install() {
  local wanted_port="" mirror=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --port) need_value "$@"; wanted_port="$2"; shift 2 ;;
      --mirror) need_value "$@"; mirror="$2"; shift 2 ;;
      *) die "不认识的参数：$1" "Unknown option: $1" ;;
    esac
  done
  if [ -n "$wanted_port" ] && ! valid_port "$wanted_port"; then
    die "端口必须是 1–65535 之间的整数。" "The port must be an integer between 1 and 65535."
  fi
  say "SuDuo 云端 $(product_version) · 安装" "SuDuo cloud $(product_version) · install"
  check_platform
  check_docker

  if [ -f "$ENV_FILE" ]; then
    ok "检测到已有配置 server/.env，沿用其中的密钥（不会覆盖）" "Found server/.env; keeping its secrets (it is never overwritten)"
    [ -z "$wanted_port" ] || set_env_value REQUIREMENTS_PORT "$wanted_port"
    check_placeholder_secrets
    local running checkout
    running="$(health_json 2>/dev/null | json_field version || true)"
    checkout="$(product_version)"
    if [ -n "$running" ] && [ "$running" != "$checkout" ]; then
      warn "正在运行的是 $running，当前检出的是 $checkout。install 会直接重建、不先备份；升级请改用 upgrade（会先备份）。" \
           "Version $running is running and $checkout is checked out. install rebuilds without a backup; use upgrade to back up first."
    fi
  else
    [ -f "$ENV_EXAMPLE" ] || die "缺少 server/.env.example，请确认在完整的仓库里运行。" "server/.env.example is missing; run this from a full checkout."
    local db_password auth_secret
    db_password="$(random_secret 32)"
    auth_secret="$(random_secret 64)"
    cp "$ENV_EXAMPLE" "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    set_env_value POSTGRES_PASSWORD "$db_password"
    set_env_value REQUIREMENTS_AUTH_SECRET "$auth_secret"
    set_env_value REQUIREMENTS_DATABASE_URL "postgresql://suduo:$db_password@postgres:5432/suduo_requirements"
    set_env_value REQUIREMENTS_PORT "${wanted_port:-4100}"
    ok "已生成 server/.env（数据库密码与签名密钥为随机值，请妥善保管此文件）" \
       "Created server/.env with a random database password and signing secret. Keep this file safe."
  fi
  [ -z "$mirror" ] || apply_mirror "$mirror"

  if ! is_service_running "$SERVICE" && port_in_use "$(port)"; then
    warn "端口 $(port) 似乎已被其他程序占用，启动可能失败。可以用 --port <端口> 换一个。" \
         "Port $(port) seems to be in use by another program, so starting may fail. Choose another one with --port <port>."
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

check_placeholder_secrets() {
  if env_value REQUIREMENTS_AUTH_SECRET | grep -q "replace-this"; then
    # 签名密钥换掉的代价只是所有人重新登录；沿用公开的占位值等于任何人都能伪造登录凭证。
    set_env_value REQUIREMENTS_AUTH_SECRET "$(random_secret 64)"
    warn "server/.env 里的签名密钥还是示例占位值，已换成随机值；所有人需要重新登录。" \
         "The signing secret in server/.env was still the example placeholder; it was replaced with a random value. Everyone needs to sign in again."
  fi
  if env_value POSTGRES_PASSWORD | grep -q "replace-this"; then
    warn "server/.env 里的数据库密码还是示例占位值。数据库没有对外开放端口，但仍建议在初始化前改掉。" \
         "The database password in server/.env is still the example placeholder. The database has no published port, but change it before first use if you can."
  fi
}

# ---------- backup ----------
backup_root() { printf '%s' "${1:-$DEFAULT_BACKUP_ROOT}"; }

new_backup_dir() { # new_backup_dir ROOT [SUFFIX] → a path that does not exist yet
  local base dir n=1
  base="$1/$(date -u +%Y-%m-%dT%H-%M-%SZ)${2:-}"
  dir="$base"
  while [ -e "$dir" ] || [ -e "$dir.partial" ]; do
    n=$((n + 1))
    dir="$base-$n"
  done
  printf '%s' "$dir"
}

# do_backup TARGET → 写到 TARGET.partial，完成后改名为 TARGET。期间短暂停服；失败或中断时服务回到原状态。
do_backup() {
  local target="$1" partial root version schema
  root="$(dirname -- "$target")"
  mkdir -p "$root" || return 1
  chmod 700 "$root" 2>/dev/null || true
  # docker -v 只认绝对路径：相对路径会被当成具名卷。
  root="$(cd -- "$root" && pwd)" || return 1
  target="$root/$(basename -- "$target")"
  partial="$target.partial"
  mkdir "$partial" || return 1
  CURRENT_PARTIAL="$partial"

  if ! is_service_running postgres; then
    compose up -d --wait postgres >/dev/null || { rm -rf -- "$partial"; return 1; }
    STARTED_POSTGRES=1
  fi
  version="$(running_version)"
  schema="$(schema_version)"
  if is_service_running "$SERVICE"; then
    say "  … 暂停服务以取得一致的备份（时长随数据量增加）" "  … pausing the service for a consistent backup (longer with more data)"
    compose stop "$SERVICE" >/dev/null || { rm -rf -- "$partial"; return 1; }
    STOPPED_SERVICE=1
  fi

  local failed=0
  # shellcheck disable=SC2016 # 变量在 postgres 容器里展开
  compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom' > "$partial/database.pgdump" || failed=1
  if [ "$failed" -eq 0 ]; then
    compose run --rm --no-deps -T --user 0 --entrypoint tar -v "$partial:/backup" "$SERVICE" \
      -C /var/lib/suduo -czf /backup/files.tar.gz attachments room-files || failed=1
  fi

  if [ "$STOPPED_SERVICE" = 1 ]; then
    compose start "$SERVICE" >/dev/null || true
    STOPPED_SERVICE=0
  fi
  if [ "$STARTED_POSTGRES" = 1 ]; then
    compose stop postgres >/dev/null || true
    STARTED_POSTGRES=0
  fi
  # 归档在容器里生成，不受本脚本的 umask 约束，这里统一收紧。
  chmod 600 "$partial"/* 2>/dev/null || true
  if [ "$failed" -ne 0 ]; then
    rm -rf -- "$partial"
    return 1
  fi

  if ! cat > "$partial/manifest.txt" <<MANIFEST
created=$(date -u +%Y-%m-%dT%H:%M:%SZ)
version=${version:-unknown}
schema=${schema:-unknown}
database.pgdump=$(sha256_of "$partial/database.pgdump")
files.tar.gz=$(sha256_of "$partial/files.tar.gz")
MANIFEST
  then
    rm -rf -- "$partial"
    return 1
  fi
  mv -- "$partial" "$target" || return 1
  CURRENT_PARTIAL=""
  BACKUP_RESULT="$target"
  return 0
}

cmd_backup() {
  local root=""
  while [ $# -gt 0 ]; do
    case "$1" in
      --to) need_value "$@"; root="$2"; shift 2 ;;
      *) die "不认识的参数：$1" "Unknown option: $1" ;;
    esac
  done
  require_env; check_docker
  BACKUP_RESULT=""
  do_backup "$(new_backup_dir "$(backup_root "$root")")" ||
    die "备份失败，没有留下不完整的备份；服务已回到原来的状态。" "The backup failed. No partial backup was kept, and the service is back in its previous state."
  if is_service_running "$SERVICE"; then
    wait_for_health || warn "服务重启后尚未就绪，请检查日志。" "The service is not ready after restarting; check the logs."
  fi
  ok "已备份到 $BACKUP_RESULT（数据库 + 附件 + 房间文件）" "Backed up to $BACKUP_RESULT (database, attachments and room files)"
}

# ---------- restore ----------
cmd_restore() {
  local source="" pre_backup=1
  while [ $# -gt 0 ]; do
    case "$1" in
      --no-pre-backup) pre_backup=0; shift ;;
      -*) die "不认识的参数：$1" "Unknown option: $1" ;;
      *) source="$1"; shift ;;
    esac
  done
  [ -n "$source" ] || die "用法：restore <备份目录> [--no-pre-backup]" "Usage: restore <backup directory> [--no-pre-backup]"
  if [ ! -f "$source/database.pgdump" ] || [ ! -f "$source/files.tar.gz" ]; then
    die "$source 不是完整的备份（需要 database.pgdump 与 files.tar.gz）。" "$source is not a complete backup (expected database.pgdump and files.tar.gz)."
  fi
  # docker -v 只认绝对路径：相对路径会被当成具名卷。
  source="$(cd -- "$source" && pwd)"
  require_env; check_docker

  local backup_version="" checkout
  checkout="$(product_version)"
  if [ -f "$source/manifest.txt" ]; then
    local expected actual file
    for file in database.pgdump files.tar.gz; do
      expected="$(sed -n "s/^$file=//p" "$source/manifest.txt")"
      actual="$(sha256_of "$source/$file")"
      if [ -n "$expected" ] && [ "$expected" != "$actual" ]; then
        die "$file 的校验值与清单不符，备份已损坏，不能用来恢复。" "$file does not match the manifest checksum. The backup is damaged and cannot be restored."
      fi
    done
    backup_version="$(sed -n 's/^version=//p' "$source/manifest.txt")"
    ok "备份校验通过（版本 ${backup_version:-?}，schema $(sed -n 's/^schema=//p' "$source/manifest.txt")）" \
       "Backup verified (version ${backup_version:-?}, schema $(sed -n 's/^schema=//p' "$source/manifest.txt"))"
  else
    warn "这份备份没有 manifest.txt，无法核对是否完整。" "This backup has no manifest.txt, so its integrity cannot be checked."
  fi

  # 动数据之前先确认备份读得出来。
  if ! is_service_running postgres; then
    compose up -d --wait postgres >/dev/null || die "数据库启动失败，查看：./scripts/suduo-cloud.sh logs --db" "The database did not start; see ./scripts/suduo-cloud.sh logs --db"
  fi
  compose exec -T postgres pg_restore --list < "$source/database.pgdump" > /dev/null 2>&1 ||
    die "database.pgdump 无法读取，备份可能已损坏。" "database.pgdump cannot be read; the backup may be damaged."
  tar -tzf "$source/files.tar.gz" > /dev/null 2>&1 ||
    die "files.tar.gz 无法读取，备份可能已损坏。" "files.tar.gz cannot be read; the backup may be damaged."

  if [ -n "$backup_version" ] && [ "$backup_version" != "unknown" ] && [ "$backup_version" != "$checkout" ]; then
    warn "备份来自 $backup_version，当前检出的是 $checkout。恢复后会按当前检出的版本启动：如果当前版本更新，数据库会自动迁移到新版本；要回到 $backup_version，请先 git checkout 那个版本再恢复。" \
         "The backup comes from $backup_version and $checkout is checked out. After the restore, the checked-out version starts: if it is newer, the database is migrated forward. To go back to $backup_version, git checkout that version first, then restore."
  fi
  warn "恢复会用备份替换当前全部数据（数据库、附件、房间文件）。" \
       "Restoring replaces all current data (database, attachments and room files)."
  if [ "$pre_backup" = 1 ]; then
    say "  恢复前会先自动备份当前数据，需要时可以恢复回去。" "  The current data is backed up first, so you can go back if needed."
  else
    warn "已指定 --no-pre-backup：当前数据无法找回。" "--no-pre-backup is set: the current data cannot be recovered."
  fi
  confirm restore || die "已取消。" "Cancelled."

  if [ "$pre_backup" = 1 ]; then
    BACKUP_RESULT=""
    if do_backup "$(new_backup_dir "$(backup_root "")" "-pre-restore")"; then
      PRE_RESTORE_BACKUP="$BACKUP_RESULT"
      ok "当前数据已备份到 $PRE_RESTORE_BACKUP" "Current data backed up to $PRE_RESTORE_BACKUP"
    else
      warn "恢复前的自动备份失败（当前数据库可能已损坏），继续恢复；当前数据将无法找回。" \
           "The automatic backup before the restore failed (the current database may be damaged). Continuing; the current data cannot be recovered."
    fi
  fi

  say "  … 停止服务并恢复" "  … stopping the service and restoring"
  compose stop "$SERVICE" >/dev/null
  if ! is_service_running postgres; then compose up -d --wait postgres >/dev/null; fi

  # 整库删掉重建再导入：新版本建过的表也一并清掉，单个事务导入，失败时数据库为空而不是半截。
  RESTORE_STAGE="database"
  # shellcheck disable=SC2016 # 变量在 postgres 容器里展开
  compose exec -T postgres sh -c 'psql -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d postgres -c "DROP DATABASE IF EXISTS \"$POSTGRES_DB\" WITH (FORCE)" -c "CREATE DATABASE \"$POSTGRES_DB\" OWNER \"$POSTGRES_USER\""' > /dev/null
  # shellcheck disable=SC2016 # 变量在 postgres 容器里展开
  compose exec -T postgres sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --single-transaction --exit-on-error --no-owner' < "$source/database.pgdump"

  RESTORE_STAGE="files"
  compose run --rm --no-deps -T --user 0 --entrypoint sh -v "$source:/backup:ro" "$SERVICE" -c \
    'find /var/lib/suduo/attachments /var/lib/suduo/room-files -mindepth 1 -delete && tar -C /var/lib/suduo -xzf /backup/files.tar.gz && chown -R 10001:10001 /var/lib/suduo/attachments /var/lib/suduo/room-files'

  # 按当前检出的代码重建并启动：回滚时检出旧版本再恢复，起来的就是旧版本。
  RESTORE_STAGE="starting"
  compose up -d --build
  wait_for_health || exit 1
  RESTORE_STAGE=""
  local health
  health="$(health_json)"
  ok "恢复完成：版本 $(printf '%s' "$health" | json_field version)，schema $(printf '%s' "$health" | json_field schemaVersion)。请抽查几个附件能否下载。" \
     "Restore complete: version $(printf '%s' "$health" | json_field version), schema $(printf '%s' "$health" | json_field schemaVersion). Spot-check that a few attachments download."
  if [ -n "$PRE_RESTORE_BACKUP" ]; then
    say "  恢复前的数据：$PRE_RESTORE_BACKUP" "  Data from before the restore: $PRE_RESTORE_BACKUP"
  fi
}

# ---------- upgrade ----------
cmd_upgrade() {
  local root="" skip_backup=0
  while [ $# -gt 0 ]; do
    case "$1" in
      --backup-to) need_value "$@"; root="$2"; shift 2 ;;
      --no-backup) skip_backup=1; shift ;;
      *) die "不认识的参数：$1" "Unknown option: $1" ;;
    esac
  done
  require_env; check_docker
  local before_version before_schema backup=""
  before_version="$(running_version)"
  if is_service_running postgres; then before_schema="$(schema_version)"; else before_schema="?"; fi
  say "SuDuo 云端 · 升级 ${before_version:-?} → $(product_version)" "SuDuo cloud · upgrade ${before_version:-?} → $(product_version)"
  if [ "$skip_backup" = 1 ]; then
    warn "已指定 --no-backup：不做升级前备份。数据库迁移只能向前，出问题时没有本脚本的回滚路径。" \
         "--no-backup is set: no backup before the upgrade. Migrations only go forward; if something goes wrong, this script has no way back."
  else
    BACKUP_RESULT=""
    do_backup "$(new_backup_dir "$(backup_root "$root")" "-pre-upgrade")" || die \
      "升级前备份失败，没有继续升级（数据库迁移只能向前，没有备份就没有回滚路径）。可以修好后重试、用 --backup-to 换个目录，或自行承担风险加 --no-backup。" \
      "The pre-upgrade backup failed, so the upgrade did not start (migrations only go forward; without a backup there is no way back). Fix it and retry, choose another directory with --backup-to, or add --no-backup at your own risk."
    backup="$BACKUP_RESULT"
    ok "已备份到 $backup" "Backed up to $backup"
  fi
  say "  … 重新构建并启动" "  … rebuilding and starting"
  compose up -d --build
  if ! wait_for_health; then
    if [ -n "$backup" ]; then
      warn "新版本没有就绪。回滚：git checkout <旧版本标签>，然后 sudo ./scripts/suduo-cloud.sh restore $backup" \
           "The new version is not ready. To roll back: git checkout <previous tag>, then sudo ./scripts/suduo-cloud.sh restore $backup"
    else
      warn "新版本没有就绪，查看日志：./scripts/suduo-cloud.sh logs" "The new version is not ready; see ./scripts/suduo-cloud.sh logs"
    fi
    exit 1
  fi
  local after
  after="$(health_json)"
  ok "升级完成：${before_version:-?} → $(printf '%s' "$after" | json_field version)（schema ${before_schema:-?} → $(printf '%s' "$after" | json_field schemaVersion)）" \
     "Upgraded: ${before_version:-?} → $(printf '%s' "$after" | json_field version) (schema ${before_schema:-?} → $(printf '%s' "$after" | json_field schemaVersion))"
  [ -z "$backup" ] || say "  备份位置：$backup" "  Backup: $backup"
}

# ---------- status / logs / start / stop / uninstall ----------
latest_backup() { # 只认完整的备份（有 manifest.txt）
  local root="$DEFAULT_BACKUP_ROOT"
  [ -d "$root" ] || return 0
  find "$root" -mindepth 2 -maxdepth 2 -name manifest.txt -printf '%h\n' 2>/dev/null | grep -v '\.partial$' | sort | tail -n 1
}

cmd_status() {
  require_env; check_docker
  compose ps
  local health
  health="$(health_json || true)"
  if [ -n "$health" ]; then
    ok "健康：版本 $(printf '%s' "$health" | json_field version)，schema $(printf '%s' "$health" | json_field schemaVersion)，地址 http://$(host_address):$(port)" \
       "Healthy: version $(printf '%s' "$health" | json_field version), schema $(printf '%s' "$health" | json_field schemaVersion), address http://$(host_address):$(port)"
  else
    warn "健康检查没有通过，查看日志：./scripts/suduo-cloud.sh logs" "Health check failed; see ./scripts/suduo-cloud.sh logs"
  fi
  if is_service_running "$SERVICE"; then
    compose exec -T "$SERVICE" du -sh /var/lib/suduo/attachments /var/lib/suduo/room-files 2>/dev/null || true
  fi
  local latest
  latest="$(latest_backup)"
  if [ -n "$latest" ]; then say "  最近一次备份：$latest" "  Latest backup: $latest"
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
  upgrade [--backup-to 目录] [--no-backup]
                                         先备份，再按当前检出的版本重建并启动
  backup [--to 目录]                     短暂停服，备份数据库、附件与房间文件（默认 /var/backups/suduo）
  restore <备份目录> [--no-pre-backup]   先自动备份当前数据，再用备份替换全部数据，并按当前检出的版本启动
                                         （需要输入 restore 确认）
  status                                 容器状态、版本、数据占用、最近一次备份
  logs [--db]                            跟随服务日志（--db 看数据库日志）
  start | stop                           启动 / 停止，不动数据
  uninstall [--purge]                    删除容器与镜像；--purge 连数据一起删除（需要输入 purge 确认）

无终端的自动化场景用 SUDUO_ASSUME_YES=1 跳过输入确认。
USAGE
  else
    cat <<'USAGE'
Usage: ./scripts/suduo-cloud.sh <command> [options]

  install [--port PORT] [--mirror cn]   create the configuration, build and start (an existing server/.env is kept)
  upgrade [--backup-to DIR] [--no-backup]
                                         back up first, then rebuild and start the checked-out version
  backup [--to DIR]                      briefly pause the service and back up the database, attachments and room files
                                         (default /var/backups/suduo)
  restore <backup dir> [--no-pre-backup] back up the current data first, replace all data with the backup,
                                         then start the checked-out version (type "restore" to confirm)
  status                                 containers, version, data size, latest backup
  logs [--db]                            follow the service logs (--db for the database)
  start | stop                           start / stop without touching data
  uninstall [--purge]                    remove containers and the image; --purge also deletes all data (type "purge" to confirm)

For automation without a terminal, SUDUO_ASSUME_YES=1 skips the typed confirmations.
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
