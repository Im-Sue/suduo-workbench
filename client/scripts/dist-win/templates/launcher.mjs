// SuDuo 启动器：按需拉起本机服务并打开浏览器。
// 快捷方式直接用捆绑的 node.exe 运行本文件，零 shell 包装（杀软红线）。
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const installDir = resolve(scriptDir, "..");
const doctorMode = process.argv.includes("--doctor");

main().catch(async (error) => {
  print("");
  print("SuDuo 启动失败：" + (error instanceof Error ? error.message : String(error)));
  print("排查建议：");
  print("  1. 打开开始菜单的「SuDuo 自检」查看详细诊断；");
  print("  2. 查看日志 " + join(installDir, "data", "logs", "suduo.log"));
  process.exitCode = 1;
  await holdWindowOpen();
});

async function main() {
  const runtime = readRuntimeConfig();
  const baseUrl = "http://127.0.0.1:" + String(runtime.port) + "/";
  print("正在检查 SuDuo 服务…");
  let health = await probeHealth(baseUrl);
  if (health === "foreign") {
    throw new Error(
      "端口 " + String(runtime.port) + " 被其他程序占用，无法启动 SuDuo。",
    );
  }
  if (health !== "ok") {
    print("服务未运行，正在启动…");
    startServer(runtime);
    health = await waitForHealth(baseUrl, 30_000);
    if (health !== "ok") {
      if (doctorMode) {
        runDoctorCli(runtime);
        await holdWindowOpen();
        return;
      }
      throw new Error(
        health === "foreign"
          ? "端口 " + String(runtime.port) + " 被其他程序占用。"
          : "服务在 30 秒内未就绪。",
      );
    }
  }
  if (doctorMode) {
    print("服务就绪，打开自检页面…");
    openBrowser(baseUrl + "doctor");
    return;
  }
  print("服务就绪，打开工作台…");
  openBrowser(baseUrl);
}

function readRuntimeConfig() {
  const configPath = join(installDir, "config", "runtime.json");
  const parsed = JSON.parse(readFileSync(configPath, "utf8"));
  const environment =
    parsed && typeof parsed === "object" && parsed.environment &&
    typeof parsed.environment === "object"
      ? parsed.environment
      : {};
  const port = Number(environment["SUDUO_PORT"] ?? "8787");
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("runtime.json 中的 SUDUO_PORT 无效");
  }
  return {
    configPath,
    port,
    codexHome: resolveInstalled(
      environment["SUDUO_CODEX_HOME"] ?? environment["CODEX_HOME"] ?? "data/codex",
    ),
    codexBin: resolveInstalled(
      environment["SUDUO_CODEX_BIN"] ??
        "runtime/codex/vendor/x86_64-pc-windows-msvc/bin/codex.exe",
    ),
    nodeExe: join(installDir, "runtime", "node.exe"),
    mainModule: join(installDir, "app", "apps", "server", "dist", "main.mjs"),
    doctorModule: join(installDir, "app", "apps", "server", "dist", "doctor.mjs"),
  };
}

function resolveInstalled(value) {
  return isAbsolute(value) ? value : resolve(installDir, value);
}

async function probeHealth(baseUrl) {
  try {
    const response = await fetch(baseUrl + "healthz", {
      signal: AbortSignal.timeout(1_000),
    });
    if (!response.ok) {
      return "foreign";
    }
    const body = await response.json().catch(() => null);
    return body && body.product === "suduo" && body.status === "ok"
      ? "ok"
      : "foreign";
  } catch {
    return "down";
  }
}

async function waitForHealth(baseUrl, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const health = await probeHealth(baseUrl);
    if (health !== "down") {
      return health;
    }
    await delay(500);
  }
  return "down";
}

function startServer(runtime) {
  const logsDir = join(installDir, "data", "logs");
  mkdirSync(logsDir, { recursive: true });
  const logFd = openSync(join(logsDir, "suduo.log"), "a");
  const child = spawn(
    runtime.nodeExe,
    [runtime.mainModule, "--runtime-config", runtime.configPath],
    {
      cwd: installDir,
      detached: true,
      windowsHide: true,
      stdio: ["ignore", logFd, logFd],
    },
  );
  child.unref();
  closeSync(logFd);
}

function openBrowser(url) {
  if (process.platform === "win32") {
    const edge = findEdge();
    if (edge) {
      spawn(edge, ["--app=" + url], { detached: true, stdio: "ignore" }).unref();
      return;
    }
    spawn("explorer.exe", [url], { detached: true, stdio: "ignore" }).unref();
    return;
  }
  spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).unref();
}

function findEdge() {
  const roots = [
    process.env["ProgramFiles"],
    process.env["ProgramFiles(x86)"],
    process.env["LOCALAPPDATA"],
  ];
  for (const root of roots) {
    if (!root) {
      continue;
    }
    const candidate = join(root, "Microsoft", "Edge", "Application", "msedge.exe");
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function runDoctorCli(runtime) {
  print("服务未能启动，改为运行命令行自检…");
  spawnSync(
    runtime.nodeExe,
    [runtime.doctorModule, "--installed", "--port", String(runtime.port)],
    {
      cwd: installDir,
      stdio: "inherit",
      env: {
        ...process.env,
        SUDUO_CODEX_HOME: runtime.codexHome,
        CODEX_HOME: runtime.codexHome,
        SUDUO_CODEX_BIN: runtime.codexBin,
      },
    },
  );
}

async function holdWindowOpen() {
  if (!process.stdin.isTTY) {
    return;
  }
  print("按回车键关闭此窗口…");
  process.stdin.resume();
  await new Promise((resolveWait) => process.stdin.once("data", resolveWait));
  process.stdin.pause();
}

function print(message) {
  process.stdout.write(message + "\r\n");
}
