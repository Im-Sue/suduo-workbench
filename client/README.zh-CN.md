# 运行 SuDuo 客户端

[English](README.md) · [返回主页说明](../README.zh-CN.md)

> 本页为中文版。若与英文版 [README.md](README.md) 有出入，以英文版为准。

SuDuo 客户端运行在每个人自己的电脑上：一个只监听 `127.0.0.1` 的本机服务和它提供的网页界面，加上 Codex CLI。目前还没有安装包，需要从源码运行。本页介绍安装、更新、数据位置和常见问题。

团队还需要一台 SuDuo 服务器，见[部署指南](../cloud/DEPLOYMENT.zh-CN.md)。

## 系统要求

- **macOS 13.5 或更新**（Apple 芯片或 Intel），或 **Windows 10 / 11**（x64）
- **Node.js 24 LTS**（24.x 中的 24.10 或更新）：从 <https://nodejs.org/> 安装，或用 mise、nvm、fnm 等版本管理工具。更高的大版本没有测试过，而且从 Node 25 起不再自带 `corepack`
- **pnpm 10.25**：`corepack enable pnpm`（Windows 上以管理员身份运行；macOS 上 Node 装在系统目录时加 `sudo`），或 `npm install -g pnpm@10.25.0`
- **git**

## 安装并启动

macOS（终端）或 Windows（PowerShell）：

```bash
git clone https://github.com/Im-Sue/suduo-workbench.git
cd suduo-workbench
git checkout "$(git describe --tags --abbrev=0)"   # 最新的发布版本
cd client
pnpm install
pnpm start
```

请使用和团队服务器相同的版本。版本不一致时，**设置 → 关于**里会有提示。

`pnpm start` 会检查环境，首次运行时构建（约 1–2 分钟），在 `http://127.0.0.1:8787` 启动本机服务并打开浏览器；SuDuo 已经在运行时，直接打开浏览器。按 `Ctrl+C` 停止。

| 参数 | |
|---|---|
| `pnpm start --port 18787` | 换一个端口 |
| `pnpm start --no-open` | 不自动打开浏览器 |
| `pnpm start --rebuild` | 启动前重新构建 |

## 配置 Codex

SuDuo 使用 `client/` 里锁定版本的 Codex CLI，以及你自己在 `~/.codex` 里的 Codex 配置（和你自己的 Codex CLI 是同一个目录）。两种方式任选：

- 在 `client/` 目录下登录：`pnpm exec codex login`；
- 或在 SuDuo 的 **设置 → 模型服务** 里配置：SuDuo 把服务地址和 API Key 交给 Codex，由 Codex 存进 `~/.codex`。这会同时改变你自己的 Codex CLI 使用的配置，也可能替换原来的 ChatGPT 登录。

SuDuo 自己不保存密钥副本，也不会把任何东西发给 SuDuo 的作者。

## 连接团队

1. **设置 → 需求服务**：填入团队服务器的地址，注册或登录。
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

用 `SUDUO_DATA_DIR` 指定其他数据目录，用 `SUDUO_CODEX_HOME`（或 `CODEX_HOME`）指定其他 Codex 目录。全部设置见 [`server/.env.example`](server/.env.example)。

## 常见问题

| 问题 | 怎么办 |
|---|---|
| 出了问题但不知道原因 | 在 `client/` 下执行 `pnpm run doctor`，或看 **设置 → 诊断**，或打开 `http://127.0.0.1:8787/doctor` |
| `pnpm install` 卡在 `better-sqlite3` | 它会下载预编译文件，网络不通时改为本地编译，需要编译工具：macOS 执行 `xcode-select --install`；Windows 安装 Visual Studio Build Tools 并勾选「使用 C++ 的桌面开发」。然后重新 `pnpm install` |
| 从 npm 下载很慢或失败（例如在国内） | `pnpm config set registry https://registry.npmmirror.com`，再 `pnpm install` |
| 在公司代理后面 | `pnpm install` 时设置 `HTTPS_PROXY`；Codex 的代理在 **设置 → 网络代理** 里配置 |
| 8787 端口被占用 | `pnpm start --port 18787` |
| Codex 总是提醒 `preferred_auth_method` | 从 `~/.codex/config.toml` 删掉这一行，新版 Codex 不再使用它 |

## 目录里有什么

```text
web/             界面（React）
server/          本机服务（Fastify + SQLite），负责运行 Codex 会话
contracts/       前端与本机服务共用的类型
codex-protocol/  锁定版本的 Codex 协议 schema 与漂移检查
scripts/         pnpm start、doctor 与开发脚本
```

Linux 不是正式支持的客户端平台，但开发和测试时客户端可以在 Linux 上运行，见 [CONTRIBUTING.zh-CN.md](../CONTRIBUTING.zh-CN.md)。
