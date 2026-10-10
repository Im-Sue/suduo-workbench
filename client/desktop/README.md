# SuDuo 桌面外壳（client/desktop）

Electron 外壳：拉起本机服务（与源码运行同一份代码），在自己的窗口里显示它，并负责托盘常驻、退出确认等桌面行为。业务逻辑都在本机服务和前端里，外壳不承载。

- 需求：[客户端桌面应用安装包](../../docs/02_需求设计/客户端桌面应用安装包-需求.md)
- 技术设计：[客户端桌面应用](../../docs/03_开发计划/客户端桌面应用-技术设计.md)
- 决策：[ADR-0013](../../docs/06_决策记录/ADR-0013-客户端桌面外壳采用Electron-本机服务跑在捆绑的官方Node上.md)

安装包（D1）已随 0.9.0 发布；应用内更新（D3）读 GitHub Release 上的 `latest.yml` / `latest-mac.yml`。签名（D4）等证书。

## 开发态运行

在 `client/` 下执行：

```bash
pnpm build          # 本机服务与前端的产物，外壳直接用它们
pnpm desktop:dev    # 首次运行会下载 Electron 二进制（约 130 MB）
```

开发态与安装版的区别：

| | 开发态 | 安装版 |
|---|---|---|
| 本机服务 | `client/server/dist/main.js` | 安装包里的 `resources/suduo/server/dist/main.mjs` |
| Node | 运行 `pnpm desktop:dev` 的那个 | 安装包自带的官方 Node |
| Codex | `client/node_modules` 里锁定版本的二进制 | 安装包自带的锁定版本 |
| 外壳数据 | `…/SuDuo Desktop Dev/`（Mac 在 `~/Library/Application Support/` 下） | `…/SuDuo Desktop/` |

下面几个环境变量可以覆盖默认行为：

- `SUDUO_DESKTOP_HOME`：外壳数据目录。本机服务的数据放在它下面的 `data/`，测试时指向一个临时目录。
- `SUDUO_CODEX_HOME`：Codex 配置目录，默认 `~/.codex`。测试时建议指向临时目录，不要动自己的配置。
- `SUDUO_DESKTOP_DEVTOOLS=1`：安装版的「显示」菜单里也出现开发者工具。
- `SUDUO_DESKTOP_UPDATE_FEED`：测试用的更新源地址（放 `latest.yml` / `latest-mac.yml` 的目录）。设了它，开发态也会检查更新，安装版改从这里检查。

改了外壳之后，可以跑一遍端到端检查（会在屏幕上开关几次窗口，要求 8790–8799 空闲）：

```bash
node desktop/scripts/verify-dev.mjs
```

它覆盖启动、关窗常驻、单实例、崩溃重启、退出确认、上次留下的服务、端口被占和失败页，以及 D2 / D3 的帮助菜单、偏好、唤出窗口、Git 检查、ChatGPT 登录的开始与取消、对本地更新源检查更新。

网络慢时可以设置 `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/`。Electron 默认缓存在 `~/Library/Caches/electron`；要放到别处，设置 `electron_config_cache`。

## 打安装包

在 `client/` 下执行：

```bash
pnpm dist:desktop                        # 本机平台；--target darwin-arm64|darwin-x64|win32-x64 指定目标
pnpm dist:desktop:smoke                  # 对刚打好的包跑冒烟
```

产物在 `client/dist-desktop/`，下载的 Node、Codex、SQLite 模块缓存在 `client/.cache/desktop/`。正式发布用的包由 `.github/workflows/desktop.yml` 在三种构建机上各自构建；打版本标签时，它把安装包、`SHA256SUMS.txt`、更新用的 `latest.yml`、合并后的 `latest-mac.yml`（`scripts/merge-update-info.mjs`）和 `.blockmap` 挂到同名 Release。Release 不要标成「预发布」：标了的话应用内更新会跳过它。

本机要经代理上网时，同时设置 `HTTPS_PROXY` 和 `NODE_USE_ENV_PROXY=1`。暂存步骤会用 Node 自带的 fetch 去 Electron 的发布页取许可文件（Electron 的许可与 Chromium 的第三方许可清单），不设后者它不走代理。

## 发布

1. 版本号改在 `client/package.json`（应用版本取它），CHANGELOG 写好，合并到 `main`。
2. 在 GitHub 上先建好这个版本的 Release 草稿（写好发布说明），再推 `v<版本>` 标签：`desktop.yml` 在三台构建机上构建、冒烟，把安装包、`SHA256SUMS.txt`、`latest.yml`、`latest-mac.yml`、`.blockmap` 挂到草稿上（草稿不存在时自己建一个）。
3. 核对附件齐全（三个安装包、两个 `latest*.yml`），`latest-mac.yml` 里两个 dmg 都在。
4. 发布 Release，**不要**标「预发布」（应用内更新只认最新的正式 Release）。
5. 用上一个版本的安装版点「检查更新」，确认能看到新版本；Windows 按 [Windows 11 实机验收清单](windows-11-验收清单.md) 走「更新」一节。

## 目录

```
src/main/      主进程：入口与流程（index.ts）、路径、偏好、登录 shell 环境、端口、本机服务进程、菜单、托盘、导航判断、
               开机自启（login-item.ts）、帮助链接、应用内更新（updater.ts、update-backend.ts）
src/preload/   preload（sandbox）：启动页拿到 window.suDuoStartup，本机服务页面拿到 window.suDuoDesktop
src/startup/   启动页与失败页（静态页面，文字由主进程按语言填好）
src/shared/    主进程、preload、启动页共用的 IPC 约定
src/i18n/      外壳自己的中英文字（菜单、托盘、提示框、启动页）
scripts/       build.mjs（esbuild）、dev.mjs、icons.mjs（从品牌标志渲染托盘与窗口图标）、verify-dev.mjs（端到端检查）、
               dist.mjs / stage.mjs / smoke.mjs（打包与冒烟）、merge-update-info.mjs（合并两台 Mac 的更新信息）
assets/        图标（icons.mjs 的产物，提交在仓库里）
```

Electron 的 npm 安装脚本在 `client/package.json` 的 `ignoredBuiltDependencies` 里被跳过，所以源码运行的 `pnpm install` 不会下载 Electron。`dev.mjs` 在第一次需要时才下载。
