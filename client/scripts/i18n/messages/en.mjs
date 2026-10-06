// 构建之前就要跑的脚本的英文消息表：与 zh-CN.mjs 同键、同参数个数，不得混入中文（server/test/script-i18n.test.ts 守着）。
// 写法按中英双语技术设计 §十二：简短祈使句，不用 Please；命令、路径、环境变量名原样。

export const en = {
  start: {
    alreadyRunning: (url) => `SuDuo is already running: ${url}`,
    portInUse: (port) => `Port ${port} is used by another program. Choose another port: pnpm start --port <port>`,
    portUsedByDesktop: (port) =>
      `Port ${port} is used by the SuDuo desktop app (it has its own data folder, so it is left alone). Choose another port: pnpm start --port <port>`,
    unknownOption: (arg) => `Unknown option: ${arg} (see pnpm start --help)`,
    invalidPort: "The port must be an integer between 1 and 65535.",
    help: [
      "Usage: pnpm start [options]",
      "",
      "  --port <port>   port of the local service (default 8787; SUDUO_PORT also works)",
      "  --no-open       do not open the browser",
      "  --rebuild       force a rebuild",
      "",
      "Other environment variables (SUDUO_DATA_DIR, SUDUO_REQUIREMENTS_SERVICE_URL, ...) are passed to the local service; see server/.env.example.",
    ].join("\n"),
    nodeTooOld: (want, have) =>
      `Node ${want} or later is required; this is ${have}. Install 24.x (LTS) from https://nodejs.org, or switch with mise / nvm / winget.`,
    notInstalled: "Dependencies are not installed yet: run pnpm install in client/ first.",
    sqliteFailed:
      'The SQLite native module failed to load. Try pnpm rebuild better-sqlite3; if that fails you need build tools: on macOS run xcode-select --install, on Windows install Visual Studio Build Tools ("Desktop development with C++"), then pnpm install again.',
    codexMissing: "The pinned Codex CLI is missing: run pnpm install in client/ again.",
    codexNotConfigured: (codexHome) =>
      `Codex has no model account configured yet (${codexHome}). Configure one in SuDuo under Settings → Model service, or run pnpm exec codex login in client/.`,
    firstBuild: "First run: building (about 1–2 minutes)…",
    rebuilding: "Sources changed: rebuilding…",
    buildFailed: "The build failed; see the output above.",
    buildComplete: "Build complete",
    startFailed: (logPath) => `The local service did not start. Log: ${logPath}\n  To diagnose: pnpm run doctor`,
    started: (url) => `Local service started: ${url}`,
    dataDir: (path) => `Data directory: ${path}`,
    log: (path) => `Log: ${path}`,
    opened: "Opened in your browser",
    stopHint: "Press Ctrl+C to stop.",
    stopping: "Stopping…",
    stopped: "SuDuo stopped.",
    exitCode: (code) => `exit code ${code}`,
    exitedUnexpectedly: (reason, logPath) => `The local service exited unexpectedly (${reason}). Log: ${logPath}`,
    legacyDataDir: (legacy, dataDir) =>
      `Found earlier local data in ${legacy}; the default location is now ${dataDir}. To keep using it: press Ctrl+C, move the old directory here, or run SUDUO_DATA_DIR="${legacy}" pnpm start.`,
    openManually: (url) => `Open ${url} in your browser`,
  },
  installer: {
    invalidServiceName: "Invalid --service-name",
  },
};
