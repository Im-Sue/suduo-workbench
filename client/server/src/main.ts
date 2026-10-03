import {
  CODEX_VERSION,
  M1_RUNTIME_SECURITY_POLICY,
  SUDUO_DEFAULTS,
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
    throw new Error("SUDUO_HOST 必须严格为 127.0.0.1");
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
    throw new Error("M1 的 SUDUO_CODEX_TRANSPORT 仅允许 stdio");
  }
  // 实际用的 Codex 由 workspace 锁定解析（resolvePinnedCodexBin），这个变量只是安装时写下的版本号。
  // 升级代码后没重跑安装时它会是旧值：只提醒，不让服务起不来（否则 systemd 会一直重启）。
  if (
    process.env["SUDUO_CODEX_VERSION"] !== undefined &&
    process.env["SUDUO_CODEX_VERSION"] !== CODEX_VERSION
  ) {
    process.stderr.write(
      `SuDuo: 安装配置里的 SUDUO_CODEX_VERSION=${process.env["SUDUO_CODEX_VERSION"]} 与锁定的 Codex ${CODEX_VERSION} 不一致；` +
        "重新运行安装（pnpm install:m1）即可更新。\n",
    );
  }
  const dataDir = process.env["SUDUO_DATA_DIR"] ?? defaultSuDuoDataDir();
  mkdirSync(dataDir, { recursive: true });
  const databasePath =
    process.env["SUDUO_DB_PATH"] ?? resolve(dataDir, "suduo.sqlite");
  const codexHome =
    process.env["SUDUO_CODEX_HOME"] ?? process.env["CODEX_HOME"];
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

  const shutdown = async () => {
    await application.close();
    removePidFile(pidFile);
    process.exitCode = 0;
  };
  shutdownForExit = shutdown;
  process.once("exit", () => removePidFile(pidFile));
  process.once("SIGINT", () => void shutdown());
  if (process.platform === "win32") {
    process.once("SIGBREAK", () => void shutdown());
  } else {
    process.once("SIGTERM", () => void shutdown());
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
    throw new Error(
      name +
        " 必须是 " +
        String(minimum) +
        " 到 " +
        String(maximum) +
        " 的整数",
    );
  }
  return parsed;
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
