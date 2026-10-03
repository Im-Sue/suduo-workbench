# 速舵 SuDuo

需求在团队，代码留在本机。SuDuo 是面向团队的需求协作 + 本机 Codex 开发工作台：团队在自己部署的服务器上共享需求与讨论，每个人在自己电脑上从需求一键拉起本机 Codex 会话，代码和会话不离开本机。

> **源码公开（source-available）**，许可证为 [PolyForm Noncommercial 1.0.0](LICENSE)（[中文参考译文](LICENSE.zh-CN.md)）。个人非商业使用，以及教育、公益与政府机构免费；**企业使用可直接开始，请在开始使用后 30 天内登记**，目前免费，见 [商业使用](COMMERCIAL.zh-CN.md)。参与贡献见 [CONTRIBUTING](CONTRIBUTING.zh-CN.md)，名称与标志见 [商标](TRADEMARKS.zh-CN.md)。

## 架构

```text
浏览器 SPA
    │ REST + SSE(after=seq)
    ▼
SuDuo app-server ── SQLite 事件账本/审批/会话映射
    │ AgentRuntime
    ▼
CodexRuntime ── stdio JSON-RPC ── codex app-server
```

app-server 不做智能编排，只负责会话与 thread 映射、请求转发、通用事件入账和重放。

## 仓库结构

按部署的两端组织，两端各是独立的 pnpm 工作区：安装、构建、测试、运行都进到对应目录执行（[ADR-0010](docs/06_决策记录/ADR-0010-仓库按客户端云端两端拆分-品牌更名SuDuo.md)）。

```text
client/   装在用户电脑上：web（前端）、server（客户端后端）、contracts、codex-protocol、scripts
cloud/    部署在内网服务器：server（云端需求服务，含 Dockerfile / compose）、contracts（云端 API 契约）、scripts
docs/     需求、架构、技术方案、ADR
```

客户端经 `link:` 引用 `cloud/contracts`，构建时顺带编译它；云端不依赖客户端。

## 版本前提

以下版本要求仅适用于源码构建机；Windows 试点用户使用全捆绑 setup.exe，无需预装：

- Node.js `24.10.0`
- pnpm `10.25.0`
- `@openai/codex` / Codex CLI `0.159.2`
- 可用的 `CODEX_HOME/config.toml` 及认证配置

## 快速开始：WSL / Linux

```bash
cd <仓库目录>/client
corepack enable
corepack prepare pnpm@10.25.0 --activate
export CODEX_HOME="$HOME/.codex"
pnpm install:m1 -- --codex-home "$CODEX_HOME"
```

安装脚本会构建工程、生成本地 token、运行 doctor，并注册 `suduo.service` systemd user 服务。安装后访问 `http://127.0.0.1:8787`，token 默认位于 `~/.local/share/suduo/access-token`。

如当前 WSL 未启用 systemd，可先只安装：

```bash
pnpm install:m1 -- --codex-home "$CODEX_HOME" --no-enable
SUDUO_ACCESS_TOKEN_FILE="$HOME/.local/share/suduo/access-token" \
SUDUO_CODEX_HOME="$CODEX_HOME" \
pnpm --filter @suduo/client-server start
```

卸载默认保留 SQLite 数据；显式传参才清除：

```bash
pnpm uninstall:m1
pnpm uninstall:m1 -- --purge-data
```

## 快速开始：Windows 原生

将 `SuDuo-Setup-<version>.exe` 拷贝到 Windows 10/11 x64 机器后双击。安装器内含 Node、Codex、SuDuo 与 better-sqlite3 Windows addon，不读取、不修改用户已有 Node/Codex/PATH。

默认安装到 `%LOCALAPPDATA%\SuDuo`。安装只做三件事：解压文件、创建开始菜单/桌面快捷方式、登记控制面板卸载项——不改 ACL、不注册计划任务、不碰剪贴板。

运行模式是**按需启动**：点「SuDuo」快捷方式 → 启动器检查本机服务，没在跑就拉起，然后带访问令牌打开浏览器应用窗口（自动登录，无需粘贴）。服务在无页面且 30 分钟无活动后自动退出。可变状态（SQLite、令牌、Codex 配置与登录态）全部住 `data\`，升级覆盖安装不受影响；首次启动服务端会自动生成令牌并从 `defaults\` 补齐缺失的 Codex 配置。从旧版（计划任务常驻版）升级时，安装器会先停旧服务、删除计划任务，并把 `config\codex` 迁移到 `data\codex`（自动修复旧版遗留的 ACL 收权问题）。

完整真机验证清单见 [Windows 安装验证手册](docs/windows-verify.md)。

## 需求工作台：全新安装后的配置

先由部署负责人按 [云端部署指南](cloud/DEPLOYMENT.zh-CN.md)（[English](cloud/DEPLOYMENT.md)）在服务器上装好云端，提供可访问的 HTTPS（或受控 HTTP）根地址，并确认其 `/v2/health` 可用。SuDuo 本机端不保存远程服务的管理员密钥。

[`client/server/.env.example`](client/server/.env.example) 列出了本机端可用的环境变量，但服务不会自动读取这个文件：请把值放入实际启动环境。WSL/Linux 安装器版编辑 `~/.config/suduo/suduo.env` 后执行 `systemctl --user restart suduo.service`；源码手动启动时在启动命令所在的 shell 中导出变量。Windows 安装器版可直接在工作台的“V2 设置”页保存地址，无需修改安装包。

```dotenv
# 可作为首次启动的默认远程地址；也可留空后在 V2 设置页填写。
SUDUO_REQUIREMENTS_SERVICE_URL=https://requirements.example.internal

# 可选。未设置时使用 <SUDUO_DATA_DIR>/requirements-v2。
SUDUO_V2_DATA_DIR=/absolute/path/to/suduo-data/requirements-v2
```

`SUDUO_DATA_DIR` 是本机数据根目录，`SUDUO_DB_PATH` 是其中的 SQLite 文件路径。`SUDUO_V2_DATA_DIR` 独立保存远程登录态、已选服务地址和需求材料快照；默认目录为 `<SUDUO_DATA_DIR>/requirements-v2`。它含有本机私有数据，不应复制到共享目录或提交到版本库。

首次使用时打开“V2 设置”：填写远程服务根地址，再在登录页选择“注册账号”创建首个账号，或用已有账号登录。登录后在“项目 → 本机工作目录”中为每个远程项目选择一个本机绝对目录；随后重新同步该项目所需的需求材料，再创建需求会话。

## 发布回退与本机数据（D4）

本说明仅覆盖全新安装。SQLite 不提供跨发布版本的数据迁移或历史会话保全；没有可用的旧工作台入口可绕过此限制。

如果当前版本启动时显示 `检测到旧数据库迁移版本 [x]；按 D4 删除本机数据库后重建。`，请停止服务，确认可以放弃本机数据后，删除 `SUDUO_DB_PATH` 指向的 SQLite 文件及同路径的 `-wal`、`-shm` 文件，并删除 `SUDUO_V2_DATA_DIR`（或默认的 `<SUDUO_DATA_DIR>/requirements-v2`）。重新启动当前版本会创建干净的本机库；不要尝试修改 `schema_migrations` 或复用旧库。

需要回退发布版本时，先停止当前版本，再安装并启动目标旧发布版本；同样要在确认数据可丢弃后清除上述 SQLite 与 V2 数据目录，让目标版本建立自己的全新本机状态。回退不是通过隐藏入口或保留本机库完成的。

无论是重建还是回退，代价都是相同的：本机项目目录映射需要重新配置，需求材料快照需要重新同步，并且需要重新登录远程需求服务。执行前请确认这些影响可接受。

## CODEX_HOME 与 doctor

SuDuo 不复制或修改密钥。`CODEX_HOME` 应指向已配好模型 provider 与认证的 Codex 目录。示例模板位于 `client/scripts/templates/codex-config.template.toml`。

Linux/WSL 手动自检：

```bash
pnpm run doctor -- \
  --codex-home "$CODEX_HOME" \
  --access-token-file "$HOME/.local/share/suduo/access-token"
```

Windows 安装器版从开始菜单打开“SuDuo 自检”，浏览器会访问本机 `/doctor` 页面并支持一键复制诊断信息，不需要 pnpm 或 PowerShell。

doctor 会检查 Node、pnpm、`codex.exe`/Codex、模型配置、token 权限/ACL、better-sqlite3 原生 addon 和监听端口；Linux 上还会真跑一次 Codex 沙箱命令（「命令沙箱」）。

### Linux 沙箱前置条件

Codex 在 Linux 上用 bubblewrap 做沙箱（需要审批或受限执行的命令都跑在里面），按 OpenAI 的[沙箱前置条件](https://developers.openai.com/codex/concepts/sandboxing)准备：

```bash
sudo apt install bubblewrap        # Fedora：sudo dnf install bubblewrap
# Ubuntu 24.04 默认用 AppArmor 限制非特权用户命名空间，还要加载官方的放行配置：
sudo apt install apparmor-profiles apparmor-utils
sudo install -m 0644 /usr/share/apparmor/extra-profiles/bwrap-userns-restrict /etc/apparmor.d/bwrap-userns-restrict
sudo apparmor_parser -r /etc/apparmor.d/bwrap-userns-restrict
```

doctor 的「命令沙箱」一项不通过时会给出具体的处理办法。

### 升级 Codex 版本后（例如 0.143.0 → 0.159.2）

- 重新运行 `pnpm install:m1`：更新服务配置里的 `SUDUO_CODEX_VERSION`，并去掉旧版服务配置里会让 Linux 沙箱失效的 `PrivateTmp`（没重跑时服务照常启动，只在日志里提醒）。
- 如果 `CODEX_HOME/config.toml` 是照旧模板写的，删掉其中的 `preferred_auth_method` 一行：新版 Codex 不认识它，每次启动都会在设置页提醒。

## 开发与 Gate 验证

开发环境版本由各端的 `mise.toml` 锁定（两端都是 Node 24.10.0、pnpm 10.25.0；云端另有 PostgreSQL 17.4），进入 `client/` 或 `cloud/` 后执行 `mise install` 即可。
机器相关的路径写在各端不提交的 `mise.local.toml`，例如：

```toml
# cloud/mise.local.toml
[env]
SUDUO_DEV_PGDATA = "/path/to/suduo/postgres-17"   # 开发用 PostgreSQL 数据目录
TMPDIR = "/path/to/suduo/tmp"                      # macOS 上必须是真实路径（/tmp 是符号链接，附件测试会拒绝）

# client/mise.local.toml
[env]
SUDUO_DEV_DATA = "/path/to/suduo/stack"            # 本机联调栈数据（scripts/dev-local.sh）
TMPDIR = "/path/to/suduo/tmp"
```

云端的测试与本地联调需要 PostgreSQL：在 `cloud/` 下 `sh scripts/dev-postgres.sh start`（127.0.0.1:15432，用户 suduo 本机免密，另建联调库 suduo_dev）。

```bash
# cloud/
pnpm install --frozen-lockfile
pnpm typecheck && pnpm build && pnpm lint && pnpm test

# client/（构建会顺带编译 ../cloud/contracts，不需要先在 cloud/ 安装）
pnpm install --frozen-lockfile
pnpm typecheck && pnpm build && pnpm lint && pnpm test
pnpm protocol:diff

CODEX_HOME=/path/to/codex-home pnpm gate:a
CODEX_HOME=/path/to/codex-home pnpm gate:b
CODEX_HOME=/path/to/codex-home pnpm gate:c
```

Gate A/B/C 会调用真实 Codex，不是 mock。运行前确认 `CODEX_HOME` 有可用模型配置；产物写入 `client/artifacts/gate-a|gate-b|gate-c/`。

Windows/NTFS watcher 或跨盘符目录不稳定时，可在启动环境中设置 `SUDUO_FS_FORCE_POLLING=true`，并用 `SUDUO_FS_POLL_INTERVAL_MS` 调整轮询周期；默认 debounce 为 300ms。

## 构建 Windows 离线安装器

在 `client/` 下执行：

```bash
# 首次联网填充带 SHA256 校验的缓存
pnpm dist:win:fetch

# 默认产出不含内部 key 的模板版
pnpm dist:win

# 缓存齐全后可完全离线重建
pnpm dist:win:offline
```

内部分发版可在构建机上注入受管配置，文件不会写入仓库或公共缓存：

```bash
pnpm dist:win -- \
  --codex-config /secure/config.toml \
  --codex-auth /secure/auth.json
```

产物位于 `client/dist-installer/SuDuo-Setup-<version>.exe`，捆绑资产缓存位于 `client/.cache/dist-win/`。`pnpm dist:win:clean` 只清除 staging 和输出，保留离线缓存。

## 许可

SuDuo 以 [PolyForm Noncommercial License 1.0.0](LICENSE) 源码公开，著作权人 sue。

- 没有商业用途预期的个人学习、研究、业余项目，以及教育、公共研究、公益、政府等机构的使用免费，不用登记。
- 公司和其他营利组织的使用（包括只在内部团队使用）一般属于商业使用：可以直接开始用，在开始使用后 30 天内发邮件到 im.suyejian@gmail.com 登记即可，目前免费。详见 [COMMERCIAL.zh-CN.md](COMMERCIAL.zh-CN.md)。
- 外部贡献需同意 [贡献者许可协议](CLA.md)。
- 第三方依赖的许可清单见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
- Codex 与 OpenAI 是 OpenAI 的商标，SuDuo 与其没有隶属关系，见 [TRADEMARKS.zh-CN.md](TRADEMARKS.zh-CN.md)。
