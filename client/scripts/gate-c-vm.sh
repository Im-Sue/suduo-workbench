#!/bin/sh
# gate-c 的 Linux 主机（本机虚拟机）：在 macOS 上跑官方 gate-c（client/server/test/gate-c.real.ts；在 client/ 下执行）。
# 官方 gate-c 用 systemctl --user 装 SuDuo 服务（supervisor-recovery 杀 Codex 子进程验自动恢复），
# 设置页的「Codex 配置提醒」也依赖 Linux 上 Codex 的启动提醒；这两项只能在带 systemd 的 Linux 上验。
#
# 前置（写在不提交的 client/mise.local.toml）：
#   [tools] lima = "2.2.0"
#   [env]   LIMA_HOME                  虚拟机与镜像放哪（建议放数据盘；Lima 默认的 ~/.lima 在系统盘）
#           SUDUO_GATE_C_CODEX_HOME   宿主机上给 gate-c 用的 Codex 配置目录（config.toml 里有 model_provider 与提供方表）
#           SUDUO_GATE_C_KEY_COMMAND  （可选）在宿主机上输出模型服务 Key 的命令（例如从钥匙串读取）。
#                                      Key 只经管道写进虚拟机的内存盘（/run/user/<uid>），跑完即删；
#                                      虚拟机里的 Codex 配置改成 `cat` 这个文件取 Key。不设则原样使用配置里的取 Key 方式。
#
# 用法：
#   sh scripts/gate-c-vm.sh create        下载并校验 Ubuntu 24.04 镜像，创建并启动虚拟机（首次约几分钟）
#   sh scripts/gate-c-vm.sh sync          把当前工作区（含未提交改动）同步进虚拟机，装依赖、构建、装 Playwright Chromium
#   sh scripts/gate-c-vm.sh gate-c [步骤] 在虚拟机里跑官方 gate-c；步骤同 GATE_C_STEPS（逗号分隔，缺省全量）；
#                                         产物拷回 client/artifacts/gate-c-vm/
#   sh scripts/gate-c-vm.sh start|stop|shell|status|delete
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
# 虚拟机挂载整个仓库：客户端构建要编译 cloud/contracts（客户端经 link: 引用它）。
REPO=$(cd "$ROOT/.." && pwd)
VM="${SUDUO_GATE_C_VM:-suduo-gate-c}"
SRC=/mnt/suduo-src
: "${LIMA_HOME:?请先设置 LIMA_HOME（例如在 mise.local.toml 的 [env] 中指向数据盘）}"
export LIMA_HOME

# 与 Lima 2.2 自带的 ubuntu-24.04 模板同一个发布版本与校验值。
IMAGE_RELEASE="release-20260705"
case "$(uname -m)" in
  arm64 | aarch64)
    IMAGE_ARCH=aarch64 IMAGE_FILE=ubuntu-24.04-server-cloudimg-arm64.img
    IMAGE_DIGEST=7df0201546f75b8bcc1044594c806c35749421ad3c9bc1be2a3ab806cfae39cc
    ;;
  x86_64)
    IMAGE_ARCH=x86_64 IMAGE_FILE=ubuntu-24.04-server-cloudimg-amd64.img
    IMAGE_DIGEST=ffe6203da54deeb6db5d2a98a83f9ec8e55f149d3f7ba622e1abe5fa966ee3d6
    ;;
  *)
    echo "不支持的宿主机架构：$(uname -m)" >&2
    exit 1
    ;;
esac

# 在虚拟机里执行一段 bash；mise 装在 ~/.local/bin，仓库的 postgres 版本在虚拟机里用不到，跳过。
vm_sh() {
  limactl shell --workdir / "$VM" -- bash -c \
    "export PATH=\"\$HOME/.local/bin:\$PATH\" MISE_DISABLE_TOOLS=postgres MISE_YES=1; $1"
}

exists() {
  limactl list --quiet 2>/dev/null | grep -qx "$VM"
}

# 镜像自己下载到 LIMA_HOME（Lima 的下载缓存固定在系统盘），校验通过才用。
ensure_image() {
  dir="$LIMA_HOME/_images"
  image="$dir/${IMAGE_RELEASE}-${IMAGE_FILE}"
  mkdir -p "$dir"
  if [ ! -f "$image" ]; then
    tries=0
    until curl -fsSL -C - --retry 3 -o "$image.part" \
      "https://cloud-images.ubuntu.com/releases/noble/${IMAGE_RELEASE}/${IMAGE_FILE}"; do
      tries=$((tries + 1))
      if [ "$tries" -ge 10 ]; then
        echo "镜像下载失败（已重试 ${tries} 次），稍后再跑 create 会接着下载" >&2
        exit 1
      fi
      sleep 3
    done
    actual=$(shasum -a 256 "$image.part" | awk '{print $1}')
    if [ "$actual" != "$IMAGE_DIGEST" ]; then
      rm -f "$image.part"
      echo "镜像校验失败（${actual}），已删除，重跑 create 重新下载" >&2
      exit 1
    fi
    mv "$image.part" "$image"
  fi
  printf '%s' "$image"
}

create() {
  if exists; then
    echo "虚拟机 ${VM} 已存在"
    limactl start --tty=false "$VM"
    return
  fi
  image=$(ensure_image)
  limactl create --tty=false --name="$VM" \
    --set ".images = [{\"location\": \"${image}\", \"arch\": \"${IMAGE_ARCH}\", \"digest\": \"sha256:${IMAGE_DIGEST}\"}] | .mounts = [{\"location\": \"${REPO}\", \"mountPoint\": \"${SRC}\", \"writable\": false}]" \
    "$ROOT/scripts/gate-c-vm/lima.yaml"
  limactl start --tty=false "$VM"
  echo "虚拟机 ${VM} 已就绪（数据在 ${LIMA_HOME}/${VM}）；下一步：sh scripts/gate-c-vm.sh sync"
}

sync_workspace() {
  vm_sh "set -eux
    mkdir -p ~/suduo
    # 宿主机的 node_modules / 构建产物是 macOS 的，不带进来；虚拟机里的这些目录 rsync 也不会删。
    rsync -a --delete \
      --exclude=node_modules --exclude=dist --exclude='*.tsbuildinfo' --exclude=.DS_Store \
      --exclude=/client/artifacts --exclude=/client/.cache --exclude=/.git --exclude=/.suduo \
      --exclude=/.gstack --exclude=/scratchpad --exclude=/.claude/worktrees --exclude=mise.local.toml --exclude=.env \
      '${SRC}/' ~/suduo/
    cd ~/suduo/client
    mise trust --quiet mise.toml
    mise install node pnpm
    eval \"\$(mise env -s bash)\"
    pnpm install --frozen-lockfile
    pnpm build
    pnpm --filter @suduo/client-server exec playwright install --with-deps chromium"
  echo "已同步并构建；下一步：sh scripts/gate-c-vm.sh gate-c [步骤]"
}

# 读配置文件顶层（第一个表头之前）的字符串键，单双引号都认。
toml_top_string() {
  awk -v key="$1" '
    /^[[:space:]]*\[/ { exit }
    $0 ~ "^[[:space:]]*" key "[[:space:]]*=" {
      sub(/^[^=]*=[[:space:]]*/, "")
      quote = substr($0, 1, 1)
      if (quote == "\"" || quote == "\047") {
        value = substr($0, 2)
        sub(quote ".*", "", value)
        print value
        exit
      }
    }' "$2"
}

# 写完后在虚拟机里用 Python 解析一遍：配置写坏了 Codex 读不了，会话全部起不来，要跑到一半才看出来。
validate_codex_config() {
  vm_sh "python3 - \"\$HOME/gate-c-codex-home/config.toml\" '${1:-}' <<'PY'
import sys, tomllib
config = tomllib.load(open(sys.argv[1], 'rb'))
provider = sys.argv[2]
if provider:
    entry = config.get('model_providers', {}).get(provider, {})
    assert entry.get('auth', {}).get('command') == 'cat', 'auth'
    clash = {'env_key', 'experimental_bearer_token', 'requires_openai_auth'} & entry.keys()
    assert not clash, ', '.join(sorted(clash))
PY" || {
    echo "虚拟机里的 Codex 配置不对：取 Key 请写成独立的 [model_providers.<id>.auth] 表（不要写成内联表或点号键），" >&2
    echo "且这个提供方不要同时配 env_key / experimental_bearer_token / requires_openai_auth" >&2
    exit 1
  }
}

# 在第一个表头前插一个 Codex 不认识的顶层键：新版 Codex 每次启动都会为它发配置提醒（configWarning），
# settings-codex 步骤靠它确定性地验收「Codex 配置提醒」链路（按官方指引装好 bubblewrap 后就没有别的提醒来源了）。
with_warning_probe() {
  awk 'BEGIN { done = 0 }
    !done && /^[[:space:]]*\[/ {
      print "# gate-c：Codex 不认识这个键，启动时会发配置提醒（settings-codex 步骤验收它）"
      print "suduo_gate_c_probe = true"
      print ""
      done = 1
    }
    { print }
    END { if (!done) print "suduo_gate_c_probe = true" }'
}

# 宿主机的 Codex 配置 → 虚拟机里的 gate-c CODEX_HOME（每次重建，避免上一轮的会话记录影响自检）。
write_codex_home() {
  src="${SUDUO_GATE_C_CODEX_HOME:?请设置 SUDUO_GATE_C_CODEX_HOME（宿主机上给 gate-c 用的 Codex 配置目录）}"
  if [ ! -f "$src/config.toml" ]; then
    echo "${src}/config.toml 不存在" >&2
    exit 1
  fi
  if [ -z "${SUDUO_GATE_C_KEY_COMMAND:-}" ]; then
    with_warning_probe < "$src/config.toml" |
      vm_sh 'set -e; home="$HOME/gate-c-codex-home"; rm -rf "$home"; mkdir -p "$home"; cat > "$home/config.toml"'
    validate_codex_config ""
    copy_model_catalog "$src"
    return
  fi
  provider=$(toml_top_string model_provider "$src/config.toml")
  if [ -z "$provider" ]; then
    echo "${src}/config.toml 里没有 model_provider，无法把取 Key 方式换成虚拟机里的文件" >&2
    exit 1
  fi
  # 去掉宿主机的取 Key 命令表（虚拟机里没有这个命令），换成读内存盘上的 Key 文件。
  {
    awk '/^\[/ { skip = ($0 ~ /^\[model_providers\.[^]]*\.auth\]/) } !skip { print }' "$src/config.toml" | with_warning_probe
    printf '\n[model_providers."%s".auth]\ncommand = "cat"\nargs = ["@KEY_FILE@"]\n' "$provider"
  } | vm_sh 'set -e; home="$HOME/gate-c-codex-home"; rm -rf "$home"; mkdir -p "$home"
    sed "s#@KEY_FILE@#$XDG_RUNTIME_DIR/suduo-gate-c/model-key#" > "$home/config.toml"'
  validate_codex_config "$provider"
  copy_model_catalog "$src"
}

# 配置里用 model_catalog_json 给了模型目录（相对路径按 CODEX_HOME 解析）：目录文件一起带进去，
# 缺了它 Codex 读不了配置，所有会话都起不来。
copy_model_catalog() {
  catalog=$(toml_top_string model_catalog_json "$1/config.toml")
  [ -n "$catalog" ] || return 0
  case "$catalog" in
    /*)
      echo "model_catalog_json 是宿主机上的绝对路径（${catalog}），虚拟机里读不到；请改成相对 CODEX_HOME 的路径" >&2
      exit 1
      ;;
  esac
  vm_sh "set -e; mkdir -p \"\$(dirname \"\$HOME/gate-c-codex-home/${catalog}\")\"; cat > \"\$HOME/gate-c-codex-home/${catalog}\"" < "$1/$catalog"
}

drop_key() {
  vm_sh 'rm -rf "$XDG_RUNTIME_DIR/suduo-gate-c"' >/dev/null 2>&1 || true
}

run_gate_c() {
  steps="${1:-}"
  # 要在 Ubuntu 24.04 的默认限制下验证（与普通用户机器一致），不能是被放开过的状态。
  if [ "$(vm_sh 'cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null')" != "1" ]; then
    echo "虚拟机里 kernel.apparmor_restrict_unprivileged_userns 不是默认的 1；先 sh scripts/gate-c-vm.sh stop && sh scripts/gate-c-vm.sh start 让 provision 恢复" >&2
    exit 1
  fi
  write_codex_home
  if [ -n "${SUDUO_GATE_C_KEY_COMMAND:-}" ]; then
    # 信号处理完要退出：POSIX sh 处理完信号会接着往下跑，Key 已删却继续跑 gate-c 只会白等。
    trap drop_key EXIT
    trap 'exit 129' HUP
    trap 'exit 130' INT
    trap 'exit 143' TERM
    if ! sh -c "$SUDUO_GATE_C_KEY_COMMAND" | vm_sh 'set -e; umask 077; dir="$XDG_RUNTIME_DIR/suduo-gate-c"
      mkdir -p "$dir"; cat > "$dir/model-key"; test -s "$dir/model-key"'; then
      echo "没取到模型服务 Key：SUDUO_GATE_C_KEY_COMMAND 没有输出，或写进虚拟机失败" >&2
      exit 1
    fi
  fi
  status=0
  vm_sh "set -e; cd ~/suduo/client; eval \"\$(mise env -s bash)\"
    export CODEX_HOME=\"\$HOME/gate-c-codex-home\" GATE_C_STEPS='${steps}'
    pnpm gate:c" || status=$?
  home=$(vm_sh 'printf %s "$HOME"') || home=""
  rm -rf "$ROOT/artifacts/gate-c-vm"
  mkdir -p "$ROOT/artifacts"
  if [ -n "$home" ] && limactl copy -r "$VM:$home/suduo/client/artifacts/gate-c" "$ROOT/artifacts/gate-c-vm" 2>/dev/null; then
    echo "产物：${ROOT}/artifacts/gate-c-vm"
  else
    echo "没能把产物拷回来；可以 sh scripts/gate-c-vm.sh shell 进去看 ~/suduo/client/artifacts/gate-c" >&2
  fi
  return "$status"
}

case "${1:-status}" in
  create) create ;;
  sync) sync_workspace ;;
  gate-c) run_gate_c "${2:-}" ;;
  start) limactl start --tty=false "$VM" ;;
  stop) limactl stop "$VM" ;;
  shell) limactl shell --workdir / "$VM" ;;
  status) if exists; then limactl list "$VM"; else echo "虚拟机 ${VM} 还没创建：sh scripts/gate-c-vm.sh create"; fi ;;
  delete) limactl delete --force "$VM" ;;
  *)
    echo "用法：sh scripts/gate-c-vm.sh create|sync|gate-c [步骤]|start|stop|shell|status|delete" >&2
    exit 2
    ;;
esac
