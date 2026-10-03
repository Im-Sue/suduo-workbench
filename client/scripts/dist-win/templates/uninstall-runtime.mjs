// 卸载前停止服务：先请求优雅退出（保证 SQLite 干净落盘），
// 再按 pid 兜底强杀，并清理旧版遗留的自启计划任务。
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createInstallLogger, runNativeCommand } from "./runtime-support.mjs";

const rawInstallDir = process.argv[2];
if (!rawInstallDir) {
  throw new Error("uninstall-runtime.mjs requires InstallDir");
}
const installDir = resolve(rawInstallDir);
const dataDir = join(installDir, "data");
const pidPath = join(dataDir, "suduo.pid");
const logPath = join(dataDir, "install.log");
mkdirSync(dataDir, { recursive: true });
const log = createInstallLogger(logPath);

try {
  log(`UNINSTALL START installDir=${installDir}`);
  const runtime = readRuntimeConfigSafely();
  await requestGracefulShutdown(runtime);
  terminateRecordedProcess();
  removeLegacyAutostartTask();
  log("UNINSTALL RUNTIME SUCCESS");
} catch (error) {
  log(
    `UNINSTALL RUNTIME FAILED error=${error instanceof Error ? error.stack ?? error.message : String(error)}`,
  );
  process.exitCode = 1;
}

function readRuntimeConfigSafely() {
  let port = 8787;
  try {
    const parsed = JSON.parse(
      readFileSync(join(installDir, "config", "runtime.json"), "utf8"),
    );
    const environment = parsed?.environment ?? {};
    const configuredPort = Number(environment["SUDUO_PORT"]);
    if (Number.isInteger(configuredPort) && configuredPort > 0) {
      port = configuredPort;
    }
  } catch (error) {
    log(
      `RUNTIME CONFIG unavailable, using defaults reason=${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return { port };
}

async function requestGracefulShutdown(runtime) {
  const baseUrl = "http://127.0.0.1:" + String(runtime.port) + "/";
  try {
    const response = await fetch(baseUrl + "api/v1/admin/shutdown", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Origin: baseUrl.slice(0, -1),
      },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(2_000),
    });
    log(`GRACEFUL SHUTDOWN status=${String(response.status)}`);
    if (response.status === 202) {
      await delay(1_500);
    }
  } catch (error) {
    log(
      `GRACEFUL SHUTDOWN unavailable reason=${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function terminateRecordedProcess() {
  try {
    const value = JSON.parse(readFileSync(pidPath, "utf8"));
    if (Number.isSafeInteger(value.pid) && value.pid > 0) {
      runOptional("taskkill recorded service", "taskkill.exe", [
        "/PID",
        String(value.pid),
        "/T",
        "/F",
      ]);
    } else {
      log(`PID cleanup skipped invalid pid file=${pidPath}`);
    }
  } catch (error) {
    log(
      `PID cleanup skipped file=${pidPath} reason=${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function removeLegacyAutostartTask() {
  if (process.platform !== "win32") {
    return;
  }
  runOptional("schtasks /Change /Disable", "schtasks.exe", [
    "/Change",
    "/TN",
    "SuDuo",
    "/Disable",
  ]);
  runOptional("schtasks /End", "schtasks.exe", ["/End", "/TN", "SuDuo"]);
  runOptional("schtasks /Delete", "schtasks.exe", [
    "/Delete",
    "/TN",
    "SuDuo",
    "/F",
  ]);
}

function runOptional(label, command, args) {
  return runNativeCommand(command, args, {
    label,
    required: false,
    log,
  });
}
