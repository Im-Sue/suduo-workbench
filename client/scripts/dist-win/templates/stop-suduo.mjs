// 升级/卸载前停止正在运行的 SuDuo 服务。
// 自包含（不 import 其他文件）：升级时由新安装器在覆盖任何文件之前，
// 用旧安装的 node.exe 从临时目录运行，避免覆盖被占用的文件失败。
// 所有步骤尽力而为，永远以退出码 0 结束。
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const installDir = resolve(process.argv[2] ?? ".");

await main().catch((error) => {
  print(
    "stop-suduo warning: " +
      (error instanceof Error ? error.message : String(error)),
  );
});
process.exitCode = 0;

async function main() {
  const runtime = readRuntimeConfigSafely();
  const baseUrl = "http://127.0.0.1:" + String(runtime.port) + "/";
  print("停止 SuDuo 服务（端口 " + String(runtime.port) + "）…");

  // 旧版曾注册登录自启计划任务，先禁用避免杀掉后被自动重启。
  runCommand("schtasks.exe", ["/Change", "/TN", "SuDuo", "/Disable"]);

  await requestGracefulShutdown(baseUrl);
  killRecordedProcess();

  runCommand("schtasks.exe", ["/End", "/TN", "SuDuo"]);
  runCommand("schtasks.exe", ["/Delete", "/TN", "SuDuo", "/F"]);

  const freed = await waitForPortFree(baseUrl, 10_000);
  print(freed ? "服务已停止。" : "警告：端口仍被占用，覆盖文件时可能需要重试。");
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
  } catch {
    // 没有或读不了 runtime.json 时用默认值。
  }
  return { port };
}

async function requestGracefulShutdown(baseUrl) {
  try {
    const origin = baseUrl.slice(0, -1);
    const response = await fetch(baseUrl + "api/v1/admin/shutdown", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: origin },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(2_000),
    });
    if (response.status === 202) {
      print("已请求服务优雅退出。");
      await delay(1_500);
    }
  } catch {
    // 服务未运行或为不支持该接口的旧版本；继续用进程号兜底。
  }
}

function killRecordedProcess() {
  if (process.platform !== "win32") {
    return;
  }
  try {
    const value = JSON.parse(
      readFileSync(join(installDir, "data", "suduo.pid"), "utf8"),
    );
    if (Number.isSafeInteger(value.pid) && value.pid > 0) {
      runCommand("taskkill.exe", ["/PID", String(value.pid), "/T", "/F"]);
    }
  } catch {
    // 没有 pid 文件说明服务本来就没在跑。
  }
}

async function waitForPortFree(baseUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      await fetch(baseUrl + "healthz", { signal: AbortSignal.timeout(800) });
    } catch {
      return true;
    }
    await delay(500);
  }
  return false;
}

function runCommand(command, args) {
  if (process.platform !== "win32") {
    return;
  }
  const result = spawnSync(command, args, { windowsHide: true });
  print(
    command + " " + args.join(" ") + " -> status=" + String(result.status),
  );
}

function print(message) {
  process.stdout.write(message + "\r\n");
}
