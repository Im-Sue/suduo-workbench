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

## 界面文字与双语

SuDuo 提供简体中文和英文两种语言，SuDuo 自己给使用者看的每一句话都有中英两版。

- **文字进字典，不写在代码里。** 所有给人看的文字（包括 `aria-label`、占位提示、空状态和报错）都放进字典：
  - 前端界面：`client/web/src/i18n/messages/zh-CN/<分区>.ts` 和 `client/web/src/i18n/messages/en/<分区>.ts`
  - 本机服务（报错、自检、交给 Codex 的文字、终端输出）：`client/server/src/i18n/messages/zh-CN/` 和 `client/server/src/i18n/messages/en/`
  - 构建之前就要跑的脚本（`pnpm start`、`install:m1`、`uninstall:m1`）：`client/scripts/i18n/messages/zh-CN.mjs` 和 `client/scripts/i18n/messages/en.mjs`
- **中文字典是样板。** 英文字典必须和它条目相同、参数一致（`satisfies` 约束），缺一条、多一条或参数对不上，`pnpm typecheck` 就会失败；脚本的消息表由测试做同样的检查。`pnpm lint` 会拒绝直接写在源码里的中文。
- **云端只写英文。** 云端的报错是英文并带错误码，客户端按错误码显示自己的说明。会留存或会被别人看到的系统文字（例如发布确认版时没写说明、由 SuDuo 代写的评论，共享 Agent 的任务状态）存成「类型 + 参数」，每个人按自己的语言显示。
- **人写的内容不翻译。** 需求、评论、房间消息、文件名、人名和 Codex 的回答一律原样显示，只有 SuDuo 自己生成的文字随界面语言变。
- **交给 Codex 的文字跟着会话走。** 说明、工具描述和工具回包按会话创建时的语言写，不跟当前界面语言。
- **英文写法。** 按[中英双语技术设计](docs/03_开发计划/产品中英双语-技术设计.md) §十二 的术语表与英文写法：句首大写（sentence case）、简短直接、计数用 `plural()`。表里没有的词，先补进术语表再用。
- **测试**默认按中文跑（`client/web/test/setup-dom.ts`）。英文用例要显式切换语言，例如 `applyLocalePreference("en")`。
- **不在双语范围内**：只进日志的消息（直接写英文，不进字典）、开发者自用脚本（`dev-local.sh`、`dev-postgres.sh`、`gate-c-vm.sh`）和尚未发布的 Windows 安装器。

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

`pnpm run doctor` 会检查沙箱，不通过时给出处理办法。终端输出跟随系统语言；很多 Linux 系统和 CI 默认是 `C.UTF-8`，这时是英文，可以用 `SUDUO_LOCALE=zh-CN` 或 `SUDUO_LOCALE=en` 指定。Windows 安装器暂未发布，见 [client/scripts/dist-win/README.md](client/scripts/dist-win/README.md)。

## 设计原则

- **仲裁者是人，不是系统**（[ADR-0004](docs/06_决策记录/ADR-0004-人机协作系统的一致性边界.md)）。默认不加锁、版本校验等拒绝用户操作的守卫：检测到冲突就告诉人谁在何时改了什么。拒绝只留给不可逆的数据损失和不可逆的对外副作用。
- **共享的是需求，私有的是代码。** 需求和房间讨论在团队服务器上；代码仓库和 Codex 会话只在每个人自己的电脑上。

## 拉取请求

- 一个拉取请求只做一件事，写清改了什么、为什么改。
- 行为有变化时补充或更新测试。
- 确认上面的质量门都通过。
- 在拉取请求模板里勾选 CLA。
