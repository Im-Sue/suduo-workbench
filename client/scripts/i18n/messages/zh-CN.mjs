// 构建之前就要跑的脚本（pnpm start、install:m1、uninstall:m1）的中文消息表，也是英文表必须对齐的样板：
// en.mjs 与这里同键、同参数个数（server/test/script-i18n.test.ts 守着）。
// 命令、路径、环境变量名、URL 原样写在句子里，不翻译。

export const zhCN = {
  /** scripts/start.mjs（pnpm start）。 */
  start: {
    alreadyRunning: (url) => `SuDuo 已在运行：${url}`,
    portInUse: (port) => `端口 ${port} 被其他程序占用。换一个端口：pnpm start --port <端口>`,
    unknownOption: (arg) => `不认识的参数：${arg}（pnpm start --help 查看用法）`,
    invalidPort: "端口必须是 1–65535 之间的整数。",
    help: [
      "用法：pnpm start [参数]",
      "",
      "  --port <端口>   本机服务端口（默认 8787，也认环境变量 SUDUO_PORT）",
      "  --no-open       不自动打开浏览器",
      "  --rebuild       强制重新构建",
      "",
      "其他环境变量（SUDUO_DATA_DIR、SUDUO_REQUIREMENTS_SERVICE_URL 等）原样传给本机服务，见 server/.env.example。",
    ].join("\n"),
    /** want：package.json 要求的最低版本；have：当前 Node 版本。 */
    nodeTooOld: (want, have) =>
      `需要 Node ${want} 或更新，当前是 ${have}。请从 https://nodejs.org 安装 24.x（LTS），或用 mise / nvm / winget 切换版本。`,
    notInstalled: "还没有安装依赖：先在 client/ 下执行 pnpm install。",
    sqliteFailed:
      "SQLite 原生模块加载失败。先试 pnpm rebuild better-sqlite3；仍不行时需要编译工具：macOS 执行 xcode-select --install，Windows 安装 Visual Studio Build Tools（勾选「使用 C++ 的桌面开发」）后再 pnpm install。",
    codexMissing: "找不到锁定版本的 Codex CLI：在 client/ 下重新执行 pnpm install。",
    codexNotConfigured: (codexHome) =>
      `Codex 还没有配置模型账号（${codexHome}）。可以在 SuDuo 的「设置 → 模型服务」里配置，或在 client/ 下执行 pnpm exec codex login。`,
    firstBuild: "首次运行，正在构建（约 1–2 分钟）…",
    rebuilding: "源码有更新，正在重新构建…",
    buildFailed: "构建失败，见上方输出。",
    buildComplete: "构建完成",
    startFailed: (logPath) => `本机服务没有启动成功。日志：${logPath}\n  排查：pnpm run doctor`,
    started: (url) => `本机服务已启动：${url}`,
    dataDir: (path) => `数据目录：${path}`,
    log: (path) => `日志：${path}`,
    opened: "已在浏览器中打开",
    stopHint: "按 Ctrl+C 停止。",
    stopping: "正在停止…",
    stopped: "SuDuo 已停止。",
    /** 本机服务退出时没有信号名，用退出码说明原因（code 可能是 null）。 */
    exitCode: (code) => `退出码 ${code}`,
    /** reason：信号名或 exitCode 的结果。 */
    exitedUnexpectedly: (reason, logPath) => `本机服务意外退出（${reason}）。日志：${logPath}`,
    legacyDataDir: (legacy, dataDir) =>
      `在旧位置 ${legacy} 发现了以前的本机数据，现在的默认位置是 ${dataDir}。要继续用以前的数据：先按 Ctrl+C 停止，把旧目录移动过来，或用 SUDUO_DATA_DIR="${legacy}" pnpm start。`,
    openManually: (url) => `请在浏览器中打开 ${url}`,
  },
  /** scripts/install.mjs 与 scripts/uninstall.mjs（Linux systemd 用户服务）。 */
  installer: {
    invalidServiceName: "--service-name 无效",
  },
};
