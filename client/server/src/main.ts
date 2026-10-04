import {
  CODEX_VERSION,
  M1_RUNTIME_SECURITY_POLICY,
  SUDUO_DEFAULTS,
  cliLocale,
} from "@suduo/client-contracts";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { messagesFor, type ServerMessages } from "./i18n/messages/index.js";
import { seedCodexHome } from "./infrastructure/platform/codex-home.js";
import { resolvePinnedCodexBin, withNodeOnPath } from "./infrastructure/platform/codex-bin.js";
import { defaultSuDuoDataDir } from "./infrastructure/platform/host-platform.js";
import { applyRuntimeConfigFromArgs } from "./infrastructure/platform/runtime-config.js";
import { createSuDuoApplication } from "./server-application.js";

export const SERVER_SHELL = {
  name: "@suduo/client-server",
  codexVersion: CODEX_VERSION,
  runtimeSecurity: M1_RUNTIME_SECURITY_POLICY,
} as const;

export { createSuDuoApplication } from "./server-application.js";
export { buildHttpServer } from "./infrastructure/http/http-server.js";

if (isMainModule()) {
  await startFromEnvironment();
}

async function startFromEnvironment(): Promise<void> {
  applyRuntimeConfigFromArgs(process.argv.slice(2));
  // 本机服务会在多处启动 Codex（app-server、沙箱探测、诊断、MCP / 模型服务检查），都继承本进程的环境；
  // 在入口一次性把自己所用 node 的目录补进 PATH，继承来的其余目录原样保留。
  const withNode = withNodeOnPath(definedEnvironment());
  for (const key of Object.keys(withNode)) {
    if (/^path$/i.test(key)) process.env[key] = withNode[key];
  }
  const host = process.env["SUDUO_HOST"] ?? SUDUO_DEFAULTS.host;
  if (host !== "127.0.0.1") {
    throw new Error(cliText().hostMustBeLoopback);
  }
  const port = parseInteger(
    process.env["SUDUO_PORT"],
    SUDUO_DEFAULTS.port,
    "SUDUO_PORT",
    1,
    65_535,
  );
  if (
    process.env["SUDUO_CODEX_TRANSPORT"] !== undefined &&
    process.env["SUDUO_CODEX_TRANSPORT"] !== "stdio"
  ) {
    throw new Error(cliText().transportStdioOnly);
  }
  // 实际用的 Codex 由 workspace 锁定解析（resolvePinnedCodexBin），这个变量只是安装时写下的版本号。
  // 升级代码后没重跑安装时它会是旧值：只提醒，不让服务起不来（否则 systemd 会一直重启）。
  if (
    process.env["SUDUO_CODEX_VERSION"] !== undefined &&
    process.env["SUDUO_CODEX_VERSION"] !== CODEX_VERSION
  ) {
    process.stderr.write(
      "SuDuo: " + cliText().codexVersionMismatch(process.env["SUDUO_CODEX_VERSION"], CODEX_VERSION) + "\n",
    );
  }
  // 空字符串按未设置处理（与 pnpm start 一致）。
  const dataDir = process.env["SUDUO_DATA_DIR"] || defaultSuDuoDataDir();
  mkdirSync(dataDir, { recursive: true });
  const databasePath =
    process.env["SUDUO_DB_PATH"] ?? resolve(dataDir, "suduo.sqlite");
  const codexHome =
    process.env["SUDUO_CODEX_HOME"] ?? process.env["CODEX_HOME"];
  if (codexHome !== undefined && codexHome !== "" && !existsSync(codexHome)) {
    process.stderr.write("SuDuo: " + cliText().codexHomeMissing(codexHome) + "\n");
  }
  const codexDefaults = process.env["SUDUO_CODEX_DEFAULTS"];
  if (codexHome && codexDefaults && existsSync(codexDefaults)) {
    const seed = seedCodexHome(codexDefaults, codexHome);
    if (seed.seeded.length > 0) {
      process.stdout.write(
        JSON.stringify({ type: "suduo.codex-home-seeded", files: seed.seeded }) +
          "\n",
      );
    }
  }
  const idleExitMs = parseInteger(
    process.env["SUDUO_IDLE_EXIT_MS"],
    0,
    "SUDUO_IDLE_EXIT_MS",
    0,
  );
  let shutdownForExit: (() => Promise<void>) | null = null;
  const requestExit = (reason: string) => {
    process.stdout.write(
      JSON.stringify({ type: "suduo.exit-requested", reason }) + "\n",
    );
    const failSafe = setTimeout(() => process.exit(0), 10_000);
    failSafe.unref();
    void shutdownForExit?.();
  };
  const application = createSuDuoApplication({
    databasePath,
    codexBin: resolvePinnedCodexBin(
      process.env["SUDUO_CODEX_BIN"] === undefined
        ? {}
        : { configuredBin: process.env["SUDUO_CODEX_BIN"] },
    ),
    ...(codexHome === undefined ? {} : { codexHome }),
    globalSkills: process.env["SUDUO_GLOBAL_SKILLS"] !== "0",
    settingsFile: resolve(dataDir, "settings.json"),
    ...(process.env["SUDUO_REQUIREMENTS_SERVICE_URL"] === undefined
      ? {}
      : { requirementsServiceUrl: process.env["SUDUO_REQUIREMENTS_SERVICE_URL"] }),
    v2DataDirectory:
      process.env["SUDUO_V2_DATA_DIR"] ?? resolve(dataDir, "requirements-v2"),
    sseHeartbeatMs: parseInteger(
      process.env["SUDUO_SSE_HEARTBEAT_MS"],
      SUDUO_DEFAULTS.sseHeartbeatMs,
      "SUDUO_SSE_HEARTBEAT_MS",
      5_000,
      60_000,
    ),
    sseReplayPageSize: parseInteger(
      process.env["SUDUO_SSE_REPLAY_PAGE_SIZE"],
      SUDUO_DEFAULTS.sseReplayPageSize,
      "SUDUO_SSE_REPLAY_PAGE_SIZE",
      100,
      2_000,
    ),
    runtimeRestartMaxMs: parseInteger(
      process.env["SUDUO_RUNTIME_RESTART_MAX_MS"],
      SUDUO_DEFAULTS.runtimeRestartMaxMs,
      "SUDUO_RUNTIME_RESTART_MAX_MS",
      1_000,
      120_000,
    ),
    fsWatchDebounceMs: parseInteger(
      process.env["SUDUO_FS_WATCH_DEBOUNCE_MS"],
      300,
      "SUDUO_FS_WATCH_DEBOUNCE_MS",
      50,
      5_000,
    ),
    fsPollIntervalMs: parseInteger(
      process.env["SUDUO_FS_POLL_INTERVAL_MS"],
      2_000,
      "SUDUO_FS_POLL_INTERVAL_MS",
      250,
      60_000,
    ),
    fsForcePolling: process.env["SUDUO_FS_FORCE_POLLING"] === "true",
    logger: process.env["SUDUO_LOG_LEVEL"] !== "silent",
    port,
    installed: process.argv.includes("--runtime-config"),
    idleExitMs,
    onExitRequested: requestExit,
    onBackgroundError: (error) => {
      process.stderr.write(
        "SuDuo background error: " +
          (error instanceof Error ? error.stack ?? error.message : String(error)) +
          "\n",
      );
    },
  });
  await application.server.listen({ host, port });
  const pidFile = process.env["SUDUO_PID_FILE"];
  if (pidFile) {
    mkdirSync(dirname(pidFile), { recursive: true });
    writeFileSync(
      pidFile,
      JSON.stringify({ pid: process.pid, startedAt: Date.now() }) + "\n",
      { mode: 0o600 },
    );
  }
  process.stdout.write(
    JSON.stringify({
      type: "suduo.ready",
      host,
      port,
      databasePath,
      codexHome: codexHome ?? null,
    }) + "\n",
  );

  // 可重入：终端里的 Ctrl+C、启动器调用的关闭接口、systemd 的 SIGTERM 可能先后到达，只关一次；
  // 后续信号不再走默认动作把进程直接杀掉（那样关闭流程走不完）。
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    const failSafe = setTimeout(() => process.exit(0), 10_000);
    failSafe.unref();
    await application.close();
    removePidFile(pidFile);
    process.exitCode = 0;
  };
  shutdownForExit = shutdown;
  process.once("exit", () => removePidFile(pidFile));
  process.on("SIGINT", () => void shutdown());
  if (process.platform === "win32") {
    process.on("SIGBREAK", () => void shutdown());
  } else {
    process.on("SIGTERM", () => void shutdown());
  }
}

function removePidFile(path: string | undefined): void {
  if (!path) {
    return;
  }
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown };
    if (value.pid === process.pid) {
      rmSync(path, { force: true });
    }
  } catch {
    // A forced Windows task stop can leave a stale pid file for the uninstaller.
  }
}

function parseInteger(
  value: string | undefined,
  fallback: number,
  name: string,
  minimum = 1,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (value === undefined || value === "") {
    return fallback;
  }
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    parsed < minimum ||
    parsed > maximum
  ) {
    throw new Error(cliText().integerOutOfRange(name, minimum, maximum));
  }
  return parsed;
}

/**
 * 启动阶段的提示与报错按系统语言（中英双语 S8：SUDUO_LOCALE → LC_ALL → LC_MESSAGES → LANG → 系统区域）。
 * 用到时才取，不在模块加载时固定；runtime config 不能设置语言相关的变量，所以先后取都一样。
 */
function cliText(): ServerMessages["cli"] {
  return messagesFor(cliLocale(process.env)).cli;
}

function isMainModule(): boolean {
  return (
    process.argv[1] !== undefined &&
    resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  );
}

function definedEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}
