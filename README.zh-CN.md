# 速舵 SuDuo

**需求在团队，代码留在本机。**

[English](README.md) · 源码公开 · [商业使用](COMMERCIAL.zh-CN.md) · [更新日志](CHANGELOG.zh-CN.md) · [参与贡献](CONTRIBUTING.zh-CN.md)

速舵 SuDuo 把团队共享的需求与讨论，接到每个人电脑上的 Codex CLI。需求、附件和讨论房间放在团队自己部署的服务器上；每个人从一条需求直接拉起本机的 Codex 会话，代码、仓库和会话都不离开自己的电脑。

> 本页为中文版。若与英文版 [README.md](README.md) 有出入，以英文版为准。

## 工作方式

```text
 团队服务器（cloud/，自己部署）                 每个人的电脑（client/）
┌──────────────────────────────────┐        ┌──────────────────────────────────────┐
│ 项目 · 需求                       │        │ 浏览器里的 SuDuo                      │
│ 评论 · 附件 · 讨论房间            │ ◀────▶ │ 本机服务（只监听 127.0.0.1）          │
│ PostgreSQL + 文件卷               │  HTTP  │ 你的代码仓库 · Codex 会话             │
└──────────────────────────────────┘        │ 用你自己模型账号的 Codex CLI          │
                                            └──────────────────────────────────────┘
```

- **共享需求与讨论**：需求看板、带评论和附件的需求详情、项目与需求讨论房间、活动记录。
- **从需求开工**：在需求上直接拉起本机 Codex 会话，Codex 通过 SuDuo 提供的工具读取需求、记录结论。
- **共享 Agent**：把自己的 Codex 共享进房间，队友可以向它提问；它在你的电脑上只读执行，回答发在房间里。
- **自己部署**：服务器跑在你们自己的环境里。SuDuo 没有中心化服务，也接触不到你们的代码。

## 快速开始

### 1. 部署云端（每个团队一次）

按[部署指南](cloud/DEPLOYMENT.zh-CN.md)操作。在装有 Docker 的 Ubuntu 服务器上，进入代码的 `cloud/` 目录执行一条命令：

```bash
cd suduo-workbench/cloud
sudo ./scripts/suduo-cloud.sh install
```

### 2. 运行客户端（每个人）

系统要求：

- **macOS 13.5 或更新**（Apple 芯片或 Intel），或 **Windows 10 / 11**（x64）
- **Node.js 24 LTS**（24.x 中的 24.10 或更新）：从 <https://nodejs.org/> 安装，或用 mise、nvm、fnm 等版本管理工具。更高的大版本没有测试过，而且从 Node 25 起不再自带 `corepack`
- **pnpm 10.25**：`corepack enable pnpm`（Windows 上以管理员身份运行；macOS 上 Node 装在系统目录时加 `sudo`），或 `npm install -g pnpm@10.25.0`
- **git**

macOS（终端）：

```bash
git clone https://github.com/Im-Sue/suduo-workbench.git
cd suduo-workbench
git checkout "$(git describe --tags --abbrev=0)"   # 最新的发布版本
cd client
pnpm install
pnpm start
```

Windows（PowerShell）：

```powershell
git clone https://github.com/Im-Sue/suduo-workbench.git
cd suduo-workbench
git checkout (git describe --tags --abbrev=0)      # 最新的发布版本
cd client
pnpm install
pnpm start
```

`pnpm start` 会检查环境，首次运行时构建（约 1–2 分钟），在 `http://127.0.0.1:8787` 启动本机服务并打开浏览器；SuDuo 已经在运行时，直接打开浏览器。按 `Ctrl+C` 停止。参数：`pnpm start --port 18787`、`--no-open`、`--rebuild`。

仓库还没有发布标签时，留在 `main` 即可。

请使用和团队云端相同的版本。版本不一致时，**设置 → 关于**里会有提示。

### 3. 配置 Codex

SuDuo 使用 `client/` 里锁定版本的 Codex CLI，以及你自己在 `~/.codex` 里的 Codex 配置（和你自己的 Codex CLI 是同一个目录）。两种方式任选：

- 在 SuDuo 的 **设置 → 模型服务** 里配置：SuDuo 把服务地址和 API Key 交给 Codex，由 Codex 存进 `~/.codex`。这会同时改变你自己的 Codex CLI 使用的配置，也可能替换原来的 ChatGPT 登录；
- 或在 `client/` 目录下登录：`pnpm exec codex login`

SuDuo 自己不保存密钥副本，也不会把任何东西发给 SuDuo 的作者。

### 4. 连接并开始

1. **设置 → 需求服务**：填入团队云端的地址，注册或登录。
2. 为每个项目选择它的代码在你电脑上的目录。
3. 打开一条需求，开始会话。

## 更新

先停掉 SuDuo（在运行 `pnpm start` 的窗口按 `Ctrl+C`；Windows 上 SuDuo 还占用着文件时 `pnpm install` 会失败），然后在 `client/` 目录下：

```bash
git fetch --tags
git checkout v0.8.0     # 团队使用的版本
pnpm install
pnpm start              # 会自动重新构建
```

本机数据会在启动时自动迁移。本机数据库不支持退回旧版本：如果可能需要退回，先备份数据目录。

## 文件在哪

| | macOS | Windows |
|---|---|---|
| 本机数据（会话、设置） | `~/Library/Application Support/SuDuo`（0.7 之前是 `~/.local/share/suduo`） | `%LOCALAPPDATA%\SuDuo` |
| 日志 | `<数据目录>/logs/suduo.log` | `<数据目录>\logs\suduo.log` |
| Codex 配置 | `~/.codex` | `%USERPROFILE%\.codex` |

用 `SUDUO_DATA_DIR` 指定其他数据目录，用 `SUDUO_CODEX_HOME`（或 `CODEX_HOME`）指定其他 Codex 目录。全部设置见 [`client/server/.env.example`](client/server/.env.example)。

## 常见问题

| 问题 | 怎么办 |
|---|---|
| 出了问题但不知道原因 | 在 `client/` 下执行 `pnpm run doctor`，或看 **设置 → 诊断**，或打开 `http://127.0.0.1:8787/doctor` |
| `pnpm install` 卡在 `better-sqlite3` | 它会下载预编译文件，网络不通时改为本地编译，需要编译工具：macOS 执行 `xcode-select --install`；Windows 安装 Visual Studio Build Tools 并勾选「使用 C++ 的桌面开发」。然后重新 `pnpm install` |
| 从 npm 下载很慢或失败（例如在国内） | `pnpm config set registry https://registry.npmmirror.com`，再 `pnpm install` |
| 在公司代理后面 | `pnpm install` 时设置 `HTTPS_PROXY`；Codex 的代理在 **设置 → 网络代理** 里配置 |
| 8787 端口被占用 | `pnpm start --port 18787` |
| Codex 总是提醒 `preferred_auth_method` | 从 `~/.codex/config.toml` 删掉这一行，新版 Codex 不再使用它 |

## 仓库结构

```text
client/   装在每个人电脑上：web（前端）、server（本机服务）、contracts、codex-protocol、scripts
cloud/    部署在团队服务器上：server（需求服务，Docker）、contracts、scripts
docs/     需求、架构、技术设计与决策记录
```

Linux 不是正式支持的客户端平台，但开发和测试时客户端可以在 Linux 上运行，见 [CONTRIBUTING.zh-CN.md](CONTRIBUTING.zh-CN.md)。

## 许可

速舵 SuDuo 以 [PolyForm Noncommercial License 1.0.0](LICENSE)（[中文参考译文](LICENSE.zh-CN.md)）源码公开，著作权人 sue。

- 没有商业用途预期的个人学习、研究、业余项目，以及教育、公共研究、公益、政府等机构的使用免费，不用登记。
- 公司和其他营利组织的使用（包括只在内部团队使用）一般属于商业使用：**可以直接开始用，在开始使用后 30 天内**发邮件到 im.suyejian@gmail.com 登记即可，目前免费。详见 [COMMERCIAL.zh-CN.md](COMMERCIAL.zh-CN.md)。
- 外部贡献需同意[贡献者许可协议](CLA.md)。
- 第三方依赖的许可清单见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
- Codex 与 OpenAI 是 OpenAI 的商标，SuDuo 与其没有隶属关系，见 [TRADEMARKS.zh-CN.md](TRADEMARKS.zh-CN.md)。
