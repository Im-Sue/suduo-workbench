# Windows 全捆绑安装器（暂未发布）

> 安装包、签名与自动更新整体暂缓（见 `docs/02_需求设计/客户端源码运行-需求.md`）。这里的代码保留可用，但不对外分发；使用者请按仓库根目录 README 从源码运行。

## 形态

`SuDuo-Setup-<version>.exe` 内含 Node、Codex、SuDuo 与 better-sqlite3 Windows addon，不读取、不修改用户已有的 Node / Codex / PATH。

- **安装**：默认装到 `%LOCALAPPDATA%\SuDuo`，只做三件事：解压文件、创建开始菜单 / 桌面快捷方式、登记控制面板卸载项。不改 ACL、不注册计划任务、不碰剪贴板。
- **运行**：按需启动。点「SuDuo」快捷方式 → 启动器（`templates/launcher.mjs`）检查本机服务，没在跑就拉起，然后打开浏览器应用窗口。服务在无页面且 30 分钟无活动后自动退出。
- **数据**：可变状态（SQLite、Codex 配置与登录态）都在 `data\`，覆盖安装不受影响；首次启动从 `defaults\` 补齐缺失的 Codex 配置。从源码运行时默认把数据放在 `%LOCALAPPDATA%\SuDuo` 根目录、Codex 配置用 `~/.codex`，与安装器版互不共用；卸载安装器时只删除它自己的子目录（选择不保留数据时会删 `data\`），不会碰到源码运行的数据。

真机验证清单见 [docs/windows-verify.md](../../../docs/windows-verify.md)。

## 构建

在 `client/` 下执行（构建机为 Linux / WSL）：

```bash
# 首次联网填充带 SHA256 校验的缓存
pnpm dist:win:fetch

# 默认产出不含任何密钥的模板版
pnpm dist:win

# 缓存齐全后可完全离线重建
pnpm dist:win:offline
```

团队内部分发版可在构建机上注入受管配置，文件不会写入仓库或公共缓存：

```bash
pnpm dist:win -- \
  --codex-config /secure/config.toml \
  --codex-auth /secure/auth.json
```

**不要把含有密钥的安装包对外分发。** 产物位于 `client/dist-installer/SuDuo-Setup-<version>.exe`，捆绑资产缓存位于 `client/.cache/dist-win/`。`pnpm dist:win:clean` 只清除 staging 和输出，保留离线缓存。分发安装包时须随附 Node.js、Codex CLI 与 better-sqlite3 的许可声明。
