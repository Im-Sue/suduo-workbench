// SuDuo 客户端源码运行入口：在 client/ 下执行 `pnpm start`。
// 检查环境 → 需要时构建 → 已在运行就直接打开浏览器；否则启动本机服务、等它就绪、打开浏览器，Ctrl+C 停止。
// 只用 Node 内置模块；提示语跟随系统语言（中文环境用中文，其他用英文）。
import { spawn, spawnSync } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { delimiter, dirname, join, resolve, sep } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cloudRoot = resolve(clientRoot, "..", "cloud");
const zh = isChineseLocale();
const t = (zhText, enText) => (zh ? zhText : enText);
const STAMP = join(clientRoot, "server", "dist", ".suduo-start-stamp");
const READY_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 15_000;
const LOG_ROTATE_BYTES = 20 * 1024 * 1024;

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
        `端口 ${options.port} 被其他程序占用。换一个端口：pnpm start --port <端口>`,
        `Port ${options.port} is used by another program. Choose another port: pnpm start --port <port>`,
      ),
    );
  }

  buildIfNeeded(options.rebuild);
  await startServer(options, baseUrl);
}

// ---------- arguments ----------
function parseArgs(args) {
  const options = {
    // 空字符串按未设置处理（与本机服务一致）。
    port: Number(process.env["SUDUO_PORT"] || "8787"),
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
          `需要 Node ${want.join(".")} 或更新，当前是 ${process.versions.node}。请从 https://nodejs.org 安装 24.x（LTS），或用 mise / nvm / winget 切换版本。`,
          `Node ${want.join(".")} or later is required; this is ${process.versions.node}. Install 24.x (LTS) from https://nodejs.org, or switch with mise / nvm / winget.`,
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
  const codexHome = process.env["SUDUO_CODEX_HOME"] || process.env["CODEX_HOME"] || join(homedir(), ".codex");
  const config = readText(join(codexHome, "config.toml")) ?? "";
  const loggedIn = existsSync(join(codexHome, "auth.json"));
  const hasProvider = /^\s*model_provider\s*=/m.test(config) || /^\s*\[model_providers\./m.test(config);
  if (!loggedIn && !hasProvider) {
    warn(
      t(
        `Codex 还没有配置模型账号（${codexHome}）。可以在 SuDuo 的「设置 → 模型服务」里配置，或在 client/ 下执行 pnpm exec codex login。`,
        `Codex has no model account configured yet (${codexHome}). Configure one in SuDuo under Settings → Model service (模型服务), or run pnpm exec codex login in client/.`,
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
    join(clientRoot, "tsconfig.base.json"),
    join(clientRoot, "web"),
    join(clientRoot, "server", "src"),
    join(clientRoot, "server", "scripts"),
    join(clientRoot, "server", "package.json"),
    join(clientRoot, "server", "tsconfig.json"),
    join(clientRoot, "contracts"),
    join(cloudRoot, "contracts"),
  ];
  const stale = !missing && newestModification(inputs) > stampTime;
  if (!force && !missing && !stale) return;
  print(
    missing
      ? t("首次运行，正在构建（约 1–2 分钟）…", "First run: building (about 1–2 minutes)…")
      : t("源码有更新，正在重新构建…", "Sources changed: rebuilding…"),
  );
  const result = runPnpm(["run", "build"]);
  if (result.error !== undefined || result.status !== 0) {
    fail(
      t("构建失败，见上方输出。", "The build failed; see the output above.") +
        (result.error === undefined ? "" : `\n  ${result.error.message}`),
    );
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
  const pnpmCli = process.env["npm_execpath"];
  // 经 pnpm start 启动时 npm_execpath 指向 pnpm 本体：
  // npm 包版本是 .js / .cjs / .mjs，用当前 node 运行；独立二进制版（mise、winget、get.pnpm.io、@pnpm/exe）直接运行。
  if (pnpmCli && /pnpm/i.test(pnpmCli) && existsSync(pnpmCli)) {
    if (/\.(c|m)?js$/i.test(pnpmCli)) {
      return spawnSync(process.execPath, [pnpmCli, ...args], { cwd: clientRoot, stdio: "inherit" });
    }
    if (!/\.(cmd|bat)$/i.test(pnpmCli)) {
      return spawnSync(pnpmCli, args, { cwd: clientRoot, stdio: "inherit" });
    }
  }
  // 兜底：从 PATH 找 pnpm。Windows 上可能是 pnpm.cmd 或 pnpm.exe，交给 shell 解析；参数是固定的，没有注入风险。
  if (process.platform === "win32") {
    return spawnSync(`pnpm ${args.join(" ")}`, { cwd: clientRoot, stdio: "inherit", shell: true });
  }
  return spawnSync("pnpm", args, { cwd: clientRoot, stdio: "inherit" });
}

// ---------- run ----------
async function startServer(options, baseUrl) {
  const dataDir = await resolveDataDir();
  hintLegacyDataDir(dataDir);
  const logsDir = join(dataDir, "logs");
  mkdirSync(logsDir, { recursive: true });
  const logPath = join(logsDir, "suduo.log");
  rotateLog(logPath);
  const log = createWriteStream(logPath, { flags: "a" });
  log.write(`\n--- ${new Date().toISOString()} pnpm start ---\n`);

  const child = spawn(process.execPath, [join("server", "dist", "main.js")], {
    // 本机服务按工作目录找锁定版本的 Codex（node_modules/.bin/codex），所以必须在 client/ 下启动。
    cwd: clientRoot,
    env: serverEnvironment(options.port),
    stdio: ["ignore", "pipe", "pipe"],
    // macOS / Linux：放进独立进程组，终端的 Ctrl+C 只到启动器，由它请求一次优雅停止，不会让服务收到两次信号。
    // Windows：与启动器共用控制台（不隐藏窗口），Ctrl+C 也能直接送到服务。
    detached: process.platform !== "win32",
  });
  const relay = consoleRelay(log);
  child.stdout.on("data", relay);
  child.stderr.on("data", relay);

  let exited = null;
  const closed = new Promise((resolveClosed) => {
    child.once("close", (code, signal) => {
      exited = { code, signal };
      resolveClosed(exited);
    });
  });

  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline && exited === null) {
    if ((await probeHealth(baseUrl)) === "ok") break;
    await delay(500);
  }
  if (exited !== null || (await probeHealth(baseUrl)) !== "ok") {
    if (exited === null) {
      child.kill();
      await closed;
    }
    await endLog(log);
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

  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    print(t("正在停止…", "Stopping…"));
    void requestShutdown(baseUrl, options.port);
    const force = setTimeout(() => {
      if (exited === null) child.kill();
    }, STOP_TIMEOUT_MS);
    force.unref();
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  if (process.platform !== "win32") process.on("SIGHUP", stop);

  const result = await closed;
  await endLog(log);
  if (stopping) {
    print(t("SuDuo 已停止。", "SuDuo stopped."));
    return;
  }
  // 不是用户要求停止的：说明退出原因和日志位置。
  warn(
    t(
      `本机服务意外退出（${result.signal ?? `退出码 ${result.code}`}）。日志：${logPath}`,
      `The local service exited unexpectedly (${result.signal ?? `exit code ${result.code}`}). Log: ${logPath}`,
    ),
  );
  process.exitCode = typeof result.code === "number" && result.code !== 0 ? result.code : 1;
}

/** 给本机服务的环境：去掉 pnpm 注入的东西，免得它们一路传给 Codex 会话（例如在用户项目里调到 SuDuo 自带的 tsc / eslint）。 */
function serverEnvironment(port) {
  const env = {};
  const ownBin = join(clientRoot, "node_modules") + sep;
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (/^(npm_|pnpm_)/i.test(key) || key === "INIT_CWD") continue;
    if (/^path$/i.test(key)) {
      env[key] = value
        .split(delimiter)
        .filter(
          (entry) =>
            entry !== "" &&
            !resolve(entry).startsWith(ownBin) &&
            !resolve(entry).startsWith(join(clientRoot, "server", "node_modules") + sep) &&
            !/node-gyp-bin$/.test(entry),
        )
        .join(delimiter);
      continue;
    }
    env[key] = value;
  }
  env["SUDUO_PORT"] = String(port);
  return env;
}

async function requestShutdown(baseUrl, port) {
  try {
    await fetch(baseUrl + "api/v1/admin/shutdown", {
      method: "POST",
      headers: { Origin: `http://127.0.0.1:${port}` },
      signal: AbortSignal.timeout(3_000),
    });
  } catch {
    // 服务可能已经在退出（例如 Windows 上它自己也收到了 Ctrl+C）；超时后由兜底的 kill 处理。
  }
}

/** 控制台只显示警告和错误（同一条 60 秒内只出现一次），完整记录都写进日志文件。 */
function consoleRelay(log) {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  const lastShown = new Map();
  return (chunk) => {
    log.write(chunk);
    pending += decoder.write(chunk);
    const lines = pending.split(/\r?\n/);
    pending = lines.pop() ?? "";
    for (const line of lines) {
      const message = importantLine(line);
      if (message === null) continue;
      const now = Date.now();
      if (now - (lastShown.get(message) ?? 0) < 60_000) continue;
      if (lastShown.size > 200) lastShown.clear();
      lastShown.set(message, now);
      warn(message);
    }
  };
}

function rotateLog(logPath) {
  try {
    if (statSync(logPath).size > LOG_ROTATE_BYTES) renameSync(logPath, logPath + ".1");
  } catch {
    // 还没有日志文件。
  }
}

function endLog(log) {
  return new Promise((resolveEnd) => log.end(resolveEnd));
}

async function resolveDataDir() {
  if (process.env["SUDUO_DATA_DIR"]) return resolve(process.env["SUDUO_DATA_DIR"]);
  const module = await import(pathToFileURL(join(clientRoot, "server", "dist", "infrastructure", "platform", "host-platform.js")).href);
  return module.defaultSuDuoDataDir();
}

/** macOS 的默认数据目录在 0.7 起改到 ~/Library/Application Support/SuDuo；旧位置还有数据时提示一下（只提示，不搬）。 */
function hintLegacyDataDir(dataDir) {
  if (process.platform !== "darwin" || process.env["SUDUO_DATA_DIR"]) return;
  const legacy = join(process.env["XDG_DATA_HOME"] || join(homedir(), ".local", "share"), "suduo");
  if (existsSync(join(dataDir, "suduo.sqlite")) || !existsSync(join(legacy, "suduo.sqlite"))) return;
  warn(
    t(
      `在旧位置 ${legacy} 发现了以前的本机数据，现在的默认位置是 ${dataDir}。要继续用以前的数据：先按 Ctrl+C 停止，把旧目录移动过来，或用 SUDUO_DATA_DIR="${legacy}" pnpm start。`,
      `Found earlier local data in ${legacy}; the default location is now ${dataDir}. To keep using it: press Ctrl+C, move the old directory here, or run SUDUO_DATA_DIR="${legacy}" pnpm start.`,
    ),
  );
}

/** 服务日志里只把警告和错误打到控制台，其余写进日志文件。 */
function importantLine(line) {
  if (line.trim() === "") return null;
  try {
    const record = JSON.parse(line);
    if (typeof record.level === "number" && record.level >= 40) return String(record.msg ?? line);
    return null;
  } catch {
    return /error|错误|失败|warn|不存在/i.test(line) ? line : null;
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
  const ignore = () => undefined;
  try {
    if (process.platform === "darwin") {
      spawn("open", [url], { detached: true, stdio: "ignore" }).on("error", ignore).unref();
    } else if (process.platform === "win32") {
      // url 只由校验过的整数端口拼成，不含 & 等 cmd 元字符。
      spawn("cmd.exe", ["/c", "start", "", url], { detached: true, stdio: "ignore", windowsHide: true }).on("error", ignore).unref();
    } else {
      spawn("xdg-open", [url], { detached: true, stdio: "ignore" }).on("error", ignore).unref();
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
