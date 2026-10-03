# 参与贡献

[English](CONTRIBUTING.md)

感谢你关注 SuDuo（速舵）。议题和拉取请求用中文或英文都可以。

## 开始之前

- **缺陷**：开一个议题，写清复现步骤、预期结果和实际结果，附上版本（SuDuo、Node、Codex CLI、操作系统）。
- **新功能与较大的改动**：请先开议题，商量好做法再写代码。需求和设计决策记在 [`docs/`](docs/) 里：需求在 `docs/02_需求设计/`，技术设计在 `docs/03_开发计划/`，决策记录（ADR）在 `docs/06_决策记录/`。
- **安全问题**：不要公开提议题，请发邮件到 im.suyejian@gmail.com。

## 贡献者许可协议

SuDuo 以 [PolyForm 非商业许可证](LICENSE) 源码公开，同时提供商用授权。每个拉取请求都需要你同意[贡献者许可协议](CLA.md)（[中文参考译文](CLA.zh-CN.md)）：在拉取请求描述里勾选 CLA 选项即可，拉取请求上的检查会确认这一项。你的贡献的著作权仍归你所有。

## 仓库结构

仓库按运行位置分成两端，各是独立的 pnpm 工作区，所有命令都要进到 `client/` 或 `cloud/` 里执行。

```text
client/   装在用户电脑上：web（前端）、server（本机后端）、contracts、codex-protocol、scripts
cloud/    部署在团队服务器上：server（需求服务，含 Dockerfile / compose）、contracts（云端 API 契约）、scripts
docs/     需求、架构、技术设计、ADR
```

`client/` 通过 `link:` 依赖使用 `cloud/contracts`，并在自己的构建中顺带编译它；`cloud/` 从不依赖 `client/`。

## 开发环境

工具版本由各端的 `mise.toml` 锁定：两端都是 Node 24.10.0、pnpm 10.25.0；`cloud/` 另有 PostgreSQL 17.4。进入 `client/` 或 `cloud/` 后执行 `mise install`。机器相关的路径写在不提交的 `mise.local.toml` 里：

```toml
# cloud/mise.local.toml
[env]
SUDUO_DEV_PGDATA = "/path/to/suduo/postgres-17"   # 开发用 PostgreSQL 数据目录
TMPDIR = "/path/to/suduo/tmp"                      # macOS 上必须是真实路径（/tmp 是符号链接）

# client/mise.local.toml
[env]
SUDUO_DEV_DATA = "/path/to/suduo/stack"            # 本机联调栈数据（scripts/dev-local.sh）
TMPDIR = "/path/to/suduo/tmp"
```

云端测试需要 PostgreSQL：在 `cloud/` 下执行 `sh scripts/dev-postgres.sh start`（监听 127.0.0.1:15432）。

## 质量门

在改动所在的端执行；改了 `cloud/contracts` 两端都要跑。

```bash
pnpm install --frozen-lockfile
pnpm typecheck && pnpm build && pnpm lint && pnpm test
```

在 `client/` 改动 Codex 集成时，还要跑 `pnpm protocol:diff`。端到端检查（`pnpm gate:a`、`gate:b`、`gate:c`）会调用真实的 Codex CLI，需要一个配好模型的 `CODEX_HOME`；`gate:c` 需要带 systemd 的 Linux，在 macOS 上用 `sh scripts/gate-c-vm.sh` 在 Lima 虚拟机里跑。

## 在 Linux 上运行客户端（开发用）

Linux 不是面向使用者的正式客户端平台，但开发和 gate-c 端到端检查都在 Linux 上跑。`pnpm start` 和在 macOS 上一样可用。把客户端装成 systemd 用户服务（gate-c 就是这样用的）：

```bash
cd client
pnpm install:m1 -- --codex-home "$HOME/.codex"     # 构建、运行自检、注册 suduo.service
pnpm uninstall:m1                                   # 保留本机数据；加 -- --purge-data 一并删除
```

Codex 在 Linux 上用 bubblewrap 给命令做沙箱，按 OpenAI 的[沙箱前置条件](https://developers.openai.com/codex/concepts/sandboxing)准备：

```bash
sudo apt install bubblewrap
# Ubuntu 24.04 默认用 AppArmor 限制非特权用户命名空间，还要加载官方的放行配置：
sudo apt install apparmor-profiles apparmor-utils
sudo install -m 0644 /usr/share/apparmor/extra-profiles/bwrap-userns-restrict /etc/apparmor.d/bwrap-userns-restrict
sudo apparmor_parser -r /etc/apparmor.d/bwrap-userns-restrict
```

`pnpm run doctor` 会检查沙箱，不通过时给出处理办法。Windows 安装器暂未发布，见 [client/scripts/dist-win/README.md](client/scripts/dist-win/README.md)。

## 设计原则

- **仲裁者是人，不是系统**（[ADR-0004](docs/06_决策记录/ADR-0004-人机协作系统的一致性边界.md)）。默认不加锁、版本校验等拒绝用户操作的守卫：检测到冲突就告诉人谁在何时改了什么。拒绝只留给不可逆的数据损失和不可逆的对外副作用。
- **共享的是需求，私有的是代码。** 需求和房间讨论在团队服务器上；代码仓库和 Codex 会话只在每个人自己的电脑上。

## 拉取请求

- 一个拉取请求只做一件事，写清改了什么、为什么改。
- 行为有变化时补充或更新测试。
- 确认上面的质量门都通过。
- 在拉取请求模板里勾选 CLA。
