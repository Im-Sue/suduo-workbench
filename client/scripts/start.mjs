// SuDuo 客户端源码运行入口：在 client/ 下执行 `pnpm start`。
// 检查环境 → 需要时构建 → 已在运行就直接打开浏览器；否则启动本机服务、等它就绪、打开浏览器，Ctrl+C 停止。
// 只用 Node 内置模块；提示语跟随系统语言（中文环境用中文，其他用英文）。
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cloudRoot = resolve(clientRoot, "..", "cloud");
const zh = isChineseLocale();
const t = (zhText, enText) => (zh ? zhText : enText);
const STAMP = join(clientRoot, "server", "dist", ".suduo-start-stamp");
const READY_TIMEOUT_MS = 60_000;

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }
  const clientPackage = readJson(join(clientRoot, "package.json"));
  const codexVersion = readText(join(clientRoot, "codex-protocol", "VERSION"))?.trim() ?? "?";
  print(`SuDuo ${clientPackage.version} · Node ${process.versions.node} · Codex ${codexVersion}`);

  checkNodeVersion(clientPackage.engines?.node ?? ">=24.10.0");
  checkInstalled();
  checkSqlite();
  checkCodexBinary();
  warnIfCodexNotConfigured();

  const baseUrl = `http://127.0.0.1:${options.port}/`;
  const health = await probeHealth(baseUrl);
  if (health === "ok") {
    ok(t("SuDuo 已在运行：", "SuDuo is already running: ") + baseUrl);
    if (options.open) openBrowser(baseUrl);
    return;
  }
  if (health === "foreign") {
    fail(
      t(
        `端口 ${options.port} 被其他程序占用。换一个端口：pnpm start --port 18787`,
        `Port ${options.port} is used by another program. Choose another port: pnpm start --port 18787`,
      ),
    );
  }

  buildIfNeeded(options.rebuild);
  await startServer(options, baseUrl);
}

// ---------- arguments ----------
function parseArgs(args) {
  const options = {
    port: Number(process.env["SUDUO_PORT"] ?? "8787"),
    open: true,
    rebuild: false,
    help: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--port") {
      options.port = Number(args[++index]);
    } else if (arg.startsWith("--port=")) {
      options.port = Number(arg.slice("--port=".length));
    } else if (arg === "--no-open") {
      options.open = false;
    } else if (arg === "--rebuild") {
      options.rebuild = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg !== "--") {
      fail(t(`不认识的参数：${arg}（pnpm start --help 查看用法）`, `Unknown option: ${arg} (see pnpm start --help)`));
    }
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535) {
    fail(t("端口必须是 1–65535 之间的整数。", "The port must be an integer between 1 and 65535."));
  }
  return options;
}

function printHelp() {
  print(
    t(
      [
        "用法：pnpm start [参数]",
        "",
        "  --port <端口>   本机服务端口（默认 8787，也认环境变量 SUDUO_PORT）",
        "  --no-open       不自动打开浏览器",
        "  --rebuild       强制重新构建",
        "",
        "其他环境变量（SUDUO_DATA_DIR、SUDUO_REQUIREMENTS_SERVICE_URL 等）原样传给本机服务，见 server/.env.example。",
      ].join("\n"),
      [
        "Usage: pnpm start [options]",
        "",
        "  --port <port>   port of the local service (default 8787; SUDUO_PORT also works)",
        "  --no-open       do not open the browser",
        "  --rebuild       force a rebuild",
        "",
        "Other environment variables (SUDUO_DATA_DIR, SUDUO_REQUIREMENTS_SERVICE_URL, ...) are passed to the local service; see server/.env.example.",
      ].join("\n"),
    ),
  );
}

// ---------- checks ----------
function checkNodeVersion(range) {
  const required = /(\d+)\.(\d+)\.(\d+)/.exec(range);
  if (required === null) return;
  const want = required.slice(1).map(Number);
  const have = process.versions.node.split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (have[index] > want[index]) return;
    if (have[index] < want[index]) {
      fail(
        t(
          `需要 Node ${want.join(".")} 或更新，当前是 ${process.versions.node}。请从 https://nodejs.org 安装 24.x，或用 mise / nvm / winget 切换版本。`,
          `Node ${want.join(".")} or later is required; this is ${process.versions.node}. Install 24.x from https://nodejs.org, or switch with mise / nvm / winget.`,
        ),
      );
    }
  }
}

function checkInstalled() {
  if (!existsSync(join(clientRoot, "node_modules", ".modules.yaml")) || !existsSync(join(clientRoot, "server", "node_modules"))) {
    fail(t("还没有安装依赖：先在 client/ 下执行 pnpm install。", "Dependencies are not installed yet: run pnpm install in client/ first."));
  }
}

function checkSqlite() {
  try {
    const requireFromServer = createRequire(join(clientRoot, "server", "package.json"));
    const Database = requireFromServer("better-sqlite3");
    new Database(":memory:").close();
  } catch (error) {
    fail(
      t(
        "SQLite 原生模块加载失败。先试 pnpm rebuild better-sqlite3；仍不行时需要编译工具：macOS 执行 xcode-select --install，Windows 安装 Visual Studio Build Tools（勾选「使用 C++ 的桌面开发」）后再 pnpm install。",
        "The SQLite native module failed to load. Try pnpm rebuild better-sqlite3; if that fails you need build tools: on macOS run xcode-select --install, on Windows install Visual Studio Build Tools (\"Desktop development with C++\"), then pnpm install again.",
      ) + `\n  ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function checkCodexBinary() {
  const bin = join(clientRoot, "node_modules", ".bin", process.platform === "win32" ? "codex.cmd" : "codex");
  if (!existsSync(bin)) {
    fail(t("找不到锁定版本的 Codex CLI：在 client/ 下重新执行 pnpm install。", "The pinned Codex CLI is missing: run pnpm install in client/ again."));
  }
}

function warnIfCodexNotConfigured() {
  const codexHome = process.env["SUDUO_CODEX_HOME"] ?? process.env["CODEX_HOME"] ?? join(homedir(), ".codex");
  const config = readText(join(codexHome, "config.toml")) ?? "";
  const loggedIn = existsSync(join(codexHome, "auth.json"));
  const hasProvider = /^\s*model_provider\s*=/m.test(config) || /^\s*\[model_providers\./m.test(config);
  if (!loggedIn && !hasProvider) {
    warn(
      t(
        `Codex 还没有配置模型账号（${codexHome}）。可以在 SuDuo 的「设置 → 模型服务」里配置，或执行 pnpm exec codex login。`,
        `Codex has no model account configured yet (${codexHome}). Configure one in SuDuo under Settings → Model service, or run pnpm exec codex login.`,
      ),
    );
  }
}

// ---------- build ----------
function buildIfNeeded(force) {
  const outputs = [join(clientRoot, "server", "dist", "main.js"), join(clientRoot, "web", "dist", "index.html")];
  const missing = outputs.some((path) => !existsSync(path));
  const stampTime = existsSync(STAMP) ? statSync(STAMP).mtimeMs : 0;
  const inputs = [
    join(clientRoot, "package.json"),
    join(clientRoot, "pnpm-lock.yaml"),
    join(clientRoot, "web"),
    join(clientRoot, "server", "src"),
    join(clientRoot, "server", "migrations"),
    join(clientRoot, "server", "package.json"),
    join(clientRoot, "contracts", "src"),
    join(cloudRoot, "contracts", "src"),
  ];
  const stale = !missing && newestModification(inputs) > stampTime;
  if (!force && !missing && !stale) return;
  print(
    missing
      ? t("首次运行，正在构建（约 1–2 分钟）…", "First run: building (about 1–2 minutes)…")
      : t("源码有更新，正在重新构建…", "Sources changed: rebuilding…"),
  );
  const result = runPnpm(["run", "build"]);
  if (result.status !== 0) {
    fail(t("构建失败，见上方输出。", "The build failed; see the output above."));
  }
  writeFileSync(STAMP, new Date().toISOString() + "\n");
  ok(t("构建完成", "Build complete"));
}

function newestModification(paths) {
  let newest = 0;
  const visit = (path) => {
    let stats;
    try {
      stats = statSync(path);
    } catch {
      return;
    }
    if (stats.isDirectory()) {
      const name = path.split(/[\\/]/).pop();
      if (name === "node_modules" || name === "dist" || name.startsWith(".")) return;
      for (const entry of readdirSync(path)) visit(join(path, entry));
      return;
    }
    if (stats.mtimeMs > newest) newest = stats.mtimeMs;
  };
  for (const path of paths) visit(path);
  return newest;
}

function runPnpm(args) {
  // 经 pnpm start 启动时 npm_execpath 指向 pnpm 本体，直接用当前 node 运行它，Windows 上也不需要 shell。
  const pnpmCli = process.env["npm_execpath"];
  if (pnpmCli && /pnpm/i.test(pnpmCli) && existsSync(pnpmCli)) {
    return spawnSync(process.execPath, [pnpmCli, ...args], { cwd: clientRoot, stdio: "inherit" });
  }
  return spawnSync(process.platform === "win32" ? "pnpm.cmd" : "pnpm", args, {
    cwd: clientRoot,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
}

// ---------- run ----------
async function startServer(options, baseUrl) {
  const dataDir = await resolveDataDir();
  const logsDir = join(dataDir, "logs");
  mkdirSync(logsDir, { recursive: true });
  const logPath = join(logsDir, "suduo.log");
  const log = createWriteStream(logPath, { flags: "a" });
  log.write(`\n--- ${new Date().toISOString()} pnpm start ---\n`);

  const child = spawn(process.execPath, [join("server", "dist", "main.js")], {
    // 本机服务按工作目录找锁定版本的 Codex（node_modules/.bin/codex），所以必须在 client/ 下启动。
    cwd: clientRoot,
    env: { ...process.env, SUDUO_PORT: String(options.port) },
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  // 同一条警告 60 秒内只在控制台出现一次（例如 Codex 反复重启时），完整记录都在日志文件里。
  const lastShown = new Map();
  const forward = (chunk) => {
    log.write(chunk);
    for (const line of chunk.toString("utf8").split(/\r?\n/)) {
      const message = importantLine(line);
      if (message === null) continue;
      const now = Date.now();
      if (now - (lastShown.get(message) ?? 0) < 60_000) continue;
      lastShown.set(message, now);
      warn(message);
    }
  };
  child.stdout.on("data", forward);
  child.stderr.on("data", forward);

  let exited = null;
  child.once("exit", (code, signal) => {
    exited = { code, signal };
  });

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline && exited === null) {
    if ((await probeHealth(baseUrl)) === "ok") break;
    await delay(500);
  }
  if (exited !== null || (await probeHealth(baseUrl)) !== "ok") {
    if (exited === null) child.kill();
    fail(
      t(
        `本机服务没有启动成功。日志：${logPath}\n  排查：pnpm run doctor`,
        `The local service did not start. Log: ${logPath}\n  To diagnose: pnpm run doctor`,
      ),
    );
  }

  ok(t("本机服务已启动：", "Local service started: ") + baseUrl);
  print(t(`  数据目录：${dataDir}`, `  Data directory: ${dataDir}`));
  print(t(`  日志：${logPath}`, `  Log: ${logPath}`));
  if (options.open) {
    openBrowser(baseUrl);
    ok(t("已在浏览器中打开", "Opened in your browser"));
  }
  print(t("按 Ctrl+C 停止。", "Press Ctrl+C to stop."));

  const stop = () => {
    // Windows 上 Ctrl+C 会直接送到同一控制台里的子进程，这里只需等它退出。
    if (process.platform !== "win32") child.kill("SIGINT");
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  const code = await new Promise((resolveExit) => {
    if (exited !== null) resolveExit(exited.code ?? 0);
    else child.once("exit", (exitCode) => resolveExit(exitCode ?? 0));
  });
  log.end();
  print(t("SuDuo 已停止。", "SuDuo stopped."));
  process.exitCode = code;
}

async function resolveDataDir() {
  if (process.env["SUDUO_DATA_DIR"]) return resolve(process.env["SUDUO_DATA_DIR"]);
  const module = await import(pathToFileURL(join(clientRoot, "server", "dist", "infrastructure", "platform", "host-platform.js")).href);
  return module.defaultSuDuoDataDir();
}

/** 服务日志里只把警告和错误打到控制台，其余写进日志文件。 */
function importantLine(line) {
  if (line.trim() === "") return null;
  try {
    const record = JSON.parse(line);
    if (typeof record.level === "number" && record.level >= 40) return String(record.msg ?? line);
    return null;
  } catch {
    return /error|错误|失败|warn/i.test(line) ? line : null;
  }
}

async function probeHealth(baseUrl) {
  try {
    const response = await fetch(baseUrl + "healthz", { signal: AbortSignal.timeout(1_000) });
    if (!response.ok) return "foreign";
    const body = await response.json().catch(() => null);
    return body && body.product === "suduo" && body.status === "ok" ? "ok" : "foreign";
  } catch {
    return "down";
  }
}

function openBrowser(url) {
  try {
    if (process.platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).unref();
    } else if (process.platform === "win32") {
      spawn("cmd.exe", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true }).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).on("error", () => undefined).unref();
    }
  } catch {
    print(t(`请在浏览器中打开 ${url}`, `Open ${url} in your browser`));
  }
}

// ---------- helpers ----------
function isChineseLocale() {
  const fromEnvironment = process.env["LC_ALL"] || process.env["LC_MESSAGES"] || process.env["LANG"];
  if (fromEnvironment) return /^zh/i.test(fromEnvironment);
  try {
    return /^zh/i.test(Intl.DateTimeFormat().resolvedOptions().locale);
  } catch {
    return false;
  }
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readText(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

function print(message) {
  process.stdout.write(message + "\n");
}

function ok(message) {
  print("  ✓ " + message);
}

function warn(message) {
  process.stderr.write("  ⚠ " + message + "\n");
}

function fail(message) {
  process.stderr.write("  ✗ " + message + "\n");
  process.exit(1);
}
