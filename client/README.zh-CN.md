# 运行 SuDuo 客户端

[English](README.md) · [返回主页说明](../README.zh-CN.md)

> 本页为中文版。若与英文版 [README.md](README.md) 有出入，以英文版为准。

SuDuo 客户端运行在每个人自己的电脑上：一个只监听 `127.0.0.1` 的本机服务和它提供的网页界面，加上 Codex CLI。可以安装[桌面应用](#桌面应用试用版)（0.9.0 起，试用版），也可以[从源码运行](#系统要求)。本页介绍这两种方式，以及更新、数据位置和常见问题。

团队还需要一台 SuDuo 服务器，见[部署指南](../cloud/DEPLOYMENT.zh-CN.md)。

## 桌面应用（试用版）

桌面应用自带客户端需要的一切，不用装 Node.js 和 pnpm（git 只在检查点和分支状态里用到）。它是试用版：还没有签名。

1. 从[最新版本](https://github.com/Im-Sue/suduo-workbench/releases/latest)下载适合你电脑的安装包。同一页的 `SHA256SUMS.txt` 列出了校验值。

   | 电脑 | 文件 |
   |---|---|
   | macOS 13.5 及以上，Apple 芯片 | `SuDuo-<版本>-mac-arm64.dmg` |
   | macOS 13.5 及以上，Intel | `SuDuo-<版本>-mac-x64.dmg` |
   | Windows 10 / 11（x64） | `SuDuo-Setup-<版本>-x64.exe` |

2. 安装。
   - **macOS**：打开 `.dmg`，把 SuDuo 拖进「应用程序」。第一次打开时，macOS 会提示无法验证开发者：点「完成」，打开「系统设置 → 隐私与安全性」，在 SuDuo 旁点「仍要打开」，输入密码后点「打开」。每个新版本都要这样放行一次。
   - **Windows**：运行安装程序。SmartScreen 提示「Windows 已保护你的电脑」时，点「更多信息」，再点「仍要运行」。只为你自己安装，不需要管理员权限，会在开始菜单和桌面创建快捷方式。
3. SuDuo 会打开自己的窗口，带你连接团队的服务器、配置 Codex、关联项目目录。

需要知道的几点：

- **关掉窗口不等于退出。** SuDuo 会留在菜单栏（macOS）或任务栏通知区域（Windows）继续运行，进行中的会话不会中断，房间里共享的 Agent 也会继续响应。从这个图标退出，或在 macOS 上按 ⌘Q。有进行中的会话时，SuDuo 会先问你。
- **Codex。** 应用自带 SuDuo 测试过的 Codex CLI 版本，使用你的 `~/.codex`，已经登录过的 Codex 或配置好的模型服务可以直接用。否则在「设置 → 模型服务」里填 API Key，或在那里点「用 ChatGPT 账号登录」：在浏览器里完成授权，登录由 Codex 自己保存。
- **开机自启**和数据、日志目录在「设置 → 桌面应用」里。开机自启默认关；打开后开机时在后台运行、不弹窗口。macOS 上可能还要在「系统设置 → 通用 → 登录项」里允许 SuDuo。
- **数据位置**：macOS 在 `~/Library/Application Support/SuDuo Desktop`，Windows 在 `%LOCALAPPDATA%\SuDuo Desktop`。它和源码运行的数据分开；应用监听 8790 端口（源码运行是 8787），两者可以同时用。需求和房间都在团队的服务器上；源码运行里的会话仍留在源码运行那边。
- **更新**：SuDuo 在启动时和每天检查一次有没有新版本（可以在「设置 → 桌面应用」里关掉或立即检查），有新版本时在窗口顶部提示，不会自己更新。Windows 上点「更新」：下载新版本，有进行中的会话时先问，然后退出、安装并重新打开。macOS（未签名的试用版不能替换自己）点「去下载」打开发布页：先从菜单栏退出 SuDuo，再替换「应用程序」里的 SuDuo。数据会保留。
- **卸载**：macOS 上退出 SuDuo，把它从「应用程序」移到废纸篓；上面的数据目录会留着，需要时自己删除。Windows 上在「设置 → 应用 → SuDuo → 卸载」，卸载时会问是否同时删除本机数据（默认保留）。
- SuDuo 起不来时，窗口里会说明原因和日志位置（数据目录下的 `logs`），并提供「运行自检」按钮。

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

## 语言

**界面**：默认跟随系统语言（以浏览器的语言设置为准）。要固定用简体中文或英文，在 **设置 → 外观 → 语言** 里切换，选择保存在当前浏览器里。

**终端输出**：`pnpm start`、`pnpm run doctor` 和本机服务的启动报错跟随系统语言：系统是中文时显示中文，其他情况显示英文。SuDuo 依次看 `LC_ALL`、`LC_MESSAGES`、`LANG`，以第一个设了值的为准；Windows 上通常没有这些变量，这时看 Windows 的区域设置。要指定语言，把 `SUDUO_LOCALE` 设为 `zh-CN` 或 `en`：

```bash
SUDUO_LOCALE=zh-CN pnpm start                # macOS
```

```powershell
$env:SUDUO_LOCALE = "zh-CN"; pnpm start      # Windows PowerShell（对当前窗口生效）
```

`SUDUO_LOCALE` 只影响终端输出，界面语言以设置为准。`http://127.0.0.1:8787/doctor` 自检页用你最近在界面里用的语言，可以在地址后加 `?lang=zh-CN` 或 `?lang=en` 指定。

## 更新

先停掉 SuDuo（在运行 `pnpm start` 的窗口按 `Ctrl+C`；Windows 上 SuDuo 还占用着文件时 `pnpm install` 会失败），然后在 `client/` 目录下：

```bash
git fetch --tags
git checkout v0.11.0    # 团队使用的版本
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
