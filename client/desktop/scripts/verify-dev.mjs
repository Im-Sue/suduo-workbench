// 开发态桌面外壳的端到端检查：用 Playwright 驱动 `client/desktop`，逐项检查技术设计 §4.1 / §4.2
// （启动、关窗常驻、单实例、崩溃重启、退出确认、上次留下的服务、端口被占、失败页）。
// 在 client/ 下先 `pnpm build`，再运行：node desktop/scripts/verify-dev.mjs
// 会在屏幕上开关几次窗口；数据放在 $TMPDIR/suduo-desktop-verify（每次清空），Codex 配置用其中的空目录，不碰 ~/.codex。
// 要求端口 8790–8799 空闲（不要同时开着桌面版）。
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const clientRoot = process.cwd();
const desktopDir = join(clientRoot, "desktop");
const require = createRequire(join(clientRoot, "package.json"));
const { _electron } = require("playwright");
const electronBin = createRequire(join(desktopDir, "package.json"))("electron");
const Database = createRequire(join(clientRoot, "server", "package.json"))("better-sqlite3");

const scratch = process.env["SUDUO_DESKTOP_VERIFY_DIR"] || join(tmpdir(), "suduo-desktop-verify");
const home = join(scratch, "home");
const codexHome = join(scratch, "codex-home");
rmSync(scratch, { recursive: true, force: true });
mkdirSync(codexHome, { recursive: true });

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? " — " + detail : ""}`);
}

function baseEnv(extra = {}) {
  const env = { ...process.env, SUDUO_DESKTOP_HOME: home, SUDUO_CODEX_HOME: codexHome, SUDUO_DESKTOP_NODE: process.execPath, ...extra };
  delete env.TERM; // 模拟从访达启动：会去读登录 shell 环境
  for (const key of Object.keys(env)) if (key.startsWith("npm_") || key.startsWith("PNPM_") || key === "ELECTRON_RUN_AS_NODE") delete env[key];
  return env;
}

async function launch(extraEnv = {}) {
  const app = await _electron.launch({ executablePath: electronBin, args: [desktopDir], env: baseEnv(extraEnv), timeout: 60_000 });
  const window = await app.firstWindow();
  return { app, window };
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return true;
    } catch {
      // keep polling
    }
    await delay(250);
  }
  console.log(`  (timed out waiting for ${label})`);
  return false;
}

async function health(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1_000) });
    return await response.json();
  } catch {
    return null;
  }
}

let eventCounter = 0;
function insertTurnEvent(type, turnId) {
  eventCounter += 1;
  const db = new Database(join(home, "data", "suduo.sqlite"));
  db.prepare(
    "INSERT INTO events (event_id, session_id, session_thread_id, source, type, payload_json, thread_ref_json, turn_ref, ts, dedupe_key, created_at) VALUES (?, 's-d0', NULL, 'runtime:codex-local', ?, '{}', ?, ?, ?, ?, ?)",
  ).run(`e-x-${eventCounter}`, type, JSON.stringify({ runtimeId: "codex-local", runtimeKind: "codex", threadId: "t-x" }), turnId, 100 + eventCounter, `x-${eventCounter}`, Date.now());
  db.close();
}

async function quitApp(app) {
  await app.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
  }).catch(() => undefined);
  const done = app.waitForEvent("close", { timeout: 30_000 }).catch(() => undefined);
  await app.evaluate(({ app: electronApp }) => electronApp.quit()).catch(() => undefined);
  await done;
}

function prefs() {
  return JSON.parse(readFileSync(join(home, "desktop.json"), "utf8"));
}

function portFree(port) {
  return new Promise((done) => {
    const server = createServer();
    server.once("error", () => done(false));
    server.listen({ host: "127.0.0.1", port, exclusive: true }, () => server.close(() => done(true)));
  });
}

// ---------- 1. 首次启动 ----------
let { app, window } = await launch();
const reachedApp = await waitFor(async () => window.url().startsWith("http://127.0.0.1:"), 90_000, "app url");
check("首次启动后窗口载入本机服务地址", reachedApp, window.url());
const port = Number(new URL(window.url()).port);
check("使用首选端口 8790", port === 8790, String(port));
const h1 = await health(port);
check("/healthz runMode=desktop 且实例标识与 desktop.json 一致", h1?.runMode === "desktop" && h1?.instanceId === prefs().instanceId, JSON.stringify(h1));
check("数据目录在 SUDUO_DESKTOP_HOME/data", existsSync(join(home, "data", "suduo.sqlite")) && existsSync(join(home, "data", "logs", "suduo.log")));
const shellLog = readFileSync(join(home, "data", "logs", "desktop.log"), "utf8");
check("读到了登录 shell 环境", /read login shell environment/.test(shellLog), shellLog.split("\n").find((l) => /shell/.test(l)) ?? "");
await window.waitForLoadState("domcontentloaded");
const bridgeType = await window.evaluate(() => typeof window.suDuoDesktop);
check("页面里有 window.suDuoDesktop", bridgeType === "object", bridgeType);
const info = await window.evaluate(() => window.suDuoDesktop.info());
check("info() 返回版本与地址", info.baseUrl === `http://127.0.0.1:${port}/` && /^\d+\.\d+\.\d+/.test(info.version), JSON.stringify(info));
const nodeIntegration = await window.evaluate(() => typeof require);
check("页面里没有 Node 能力", nodeIntegration === "undefined", nodeIntegration);
const title = await window.title();
check("页面标题含 SuDuo", /SuDuo/.test(title), title);

// 外链不在窗口里打开（导航被拦下）
await app.evaluate(({ shell }) => {
  globalThis.__opened = [];
  shell.openExternal = async (url) => {
    globalThis.__opened.push(url);
  };
});
await window.evaluate(() => window.open("https://suduo.dev/", "_blank"));
await delay(300);
const opened = await app.evaluate(() => globalThis.__opened);
check("window.open 外链交给系统浏览器", opened.includes("https://suduo.dev/"), JSON.stringify(opened));
check("窗口仍停在本机地址", window.url().startsWith(`http://127.0.0.1:${port}/`));

// 菜单：中文（系统 / 存储语言）→ 前端告知 en 后变英文
await window.evaluate(() => window.suDuoDesktop.setLocale("en"));
await delay(300);
const editLabel = await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.items[1]?.label);
check("前端告知 en 后菜单变英文", editLabel === "Edit", String(editLabel));
await window.evaluate(() => window.suDuoDesktop.setLocale("zh-CN"));
await delay(300);
const editLabelZh = await app.evaluate(({ Menu }) => Menu.getApplicationMenu()?.items[1]?.label);
check("告知 zh-CN 后菜单变中文", editLabelZh === "编辑", String(editLabelZh));

// ---------- 2. 关窗只隐藏 ----------
const browserWindow = await app.browserWindow(window);
await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
await delay(800);
const visibleAfterClose = await browserWindow.evaluate((w) => w.isVisible());
check("关窗后窗口隐藏而不是退出", visibleAfterClose === false);
check("关窗后服务仍在", (await health(port))?.status === "ok");
console.log(`  (info) closeHintShown=${String(prefs().closeHintShown)}：通知真正弹出后才记下；测试环境里系统可能不显示通知，留给安装包人工验收`);

// ---------- 3. 单实例 ----------
const second = spawnSync(electronBin, [desktopDir], { env: baseEnv(), timeout: 30_000 });
check("第二个实例自行退出", second.status === 0, `status ${second.status}`);
await delay(800);
check("第二次打开把已有窗口带到前面", await browserWindow.evaluate((w) => w.isVisible()));

// ---------- 4. 源码运行不接管桌面版 ----------
const source = spawnSync(process.execPath, ["scripts/start.mjs", "--port", String(port), "--no-open"], { cwd: clientRoot, encoding: "utf8", timeout: 60_000, env: { ...process.env, SUDUO_LOCALE: "zh-CN" } });
check("pnpm start 说明端口正被桌面版使用、不接管", source.status === 1 && /SuDuo 桌面版/.test(source.stderr), (source.stderr || "").trim().split("\n").pop());

// ---------- 5. 意外退出后自动重启 ----------
const pidBefore = h1.pid;
process.kill(pidBefore, "SIGKILL");
const restarted = await waitFor(async () => {
  const h = await health(port);
  return h?.status === "ok" && h.pid !== pidBefore;
}, 30_000, "restart");
check("本机服务被杀后自动重启到同一端口", restarted);
const backToApp = await waitFor(async () => window.url().startsWith(`http://127.0.0.1:${port}/`), 15_000, "app url after restart");
check("重启后窗口回到本机地址", backToApp, window.url());

// ---------- 6. 退出确认 ----------
const h2 = await health(port);
const db = new Database(join(home, "data", "suduo.sqlite"));
db.prepare("INSERT INTO projects (id, name, root_path, root_path_key, created_at, updated_at) VALUES ('p-d0', 'd0', '/tmp/d0', '/tmp/d0', ?, ?)").run(Date.now(), Date.now());
db.close();
{
  const db2 = new Database(join(home, "data", "suduo.sqlite"));
  const columns = db2.prepare("PRAGMA table_info(sessions)").all().map((c) => c.name);
  const now = Date.now();
  const row = { id: "s-d0", project_id: "p-d0", title: "d0", state: "active", created_at: now, updated_at: now, last_activity_at: now };
  const names = columns.filter((c) => c in row);
  db2.prepare(`INSERT INTO sessions (${names.join(",")}) VALUES (${names.map((n) => "@" + n).join(",")})`).run(row);
  db2.prepare(
    "INSERT INTO events (event_id, session_id, session_thread_id, source, type, payload_json, thread_ref_json, turn_ref, ts, dedupe_key, created_at) VALUES ('e-d0', 's-d0', NULL, 'runtime:codex-local', 'turn.started', '{}', ?, 'u-d0', 1, 'd0', ?)",
  ).run(JSON.stringify({ runtimeId: "codex-local", runtimeKind: "codex", threadId: "t-d0" }), now);
  db2.close();
}
const activity = await (await fetch(`http://127.0.0.1:${port}/api/v1/system/activity`)).json();
check("活动接口看到 1 个进行中的会话", activity.runningSessions === 1, JSON.stringify(activity));

await app.evaluate(({ dialog }) => {
  globalThis.__dialogs = [];
  dialog.showMessageBox = async (...args) => {
    const options = args.length > 1 ? args[1] : args[0];
    globalThis.__dialogs.push(options.message);
    return { response: 1, checkboxChecked: false };
  };
});
await app.evaluate(({ app: electronApp }) => electronApp.quit());
await delay(1_500);
const dialogs = await app.evaluate(() => globalThis.__dialogs);
check("有进行中的会话时退出先确认", dialogs.length === 1 && /1/.test(dialogs[0]), JSON.stringify(dialogs));
check("选「取消」后不退出、服务还在", (await health(port))?.pid === h2.pid);

await app.evaluate(({ dialog }) => {
  dialog.showMessageBox = async (...args) => {
    const options = args.length > 1 ? args[1] : args[0];
    globalThis.__dialogs.push(options.message);
    return { response: 0, checkboxChecked: false };
  };
});
const closed = app.waitForEvent("close", { timeout: 30_000 }).then(() => true).catch(() => false);
await app.evaluate(({ app: electronApp }) => electronApp.quit());
check("选「退出」后应用退出", await closed);
check("退出后服务已停、端口空出", await waitFor(() => portFree(port), 15_000, "port free"));

// ---------- 7. 上次留下的服务（外壳被强杀）----------
async function launchAndOrphan(label, withRunningTurn) {
  let launched = await launch();
  await waitFor(async () => launched.window.url().startsWith("http://127.0.0.1:"), 60_000, `app url (${label})`);
  const before = await health(port);
  if (withRunningTurn) insertTurnEvent("turn.started", `u-${label}`);
  const electronPid = await launched.app.evaluate(() => process.pid);
  process.kill(electronPid, "SIGKILL");
  await delay(1_000);
  return before;
}
function gone(pid) {
  try {
    process.kill(pid, 0);
    return false;
  } catch {
    return true;
  }
}

// 7a 没有进行中的会话：直接停掉，在原端口拉起新服务
let orphan = await launchAndOrphan("plain", false);
check("外壳被强杀后服务还留着（模拟孤儿）", (await health(port))?.pid === orphan.pid, String(orphan?.pid));
({ app, window } = await launch());
await waitFor(async () => window.url().startsWith("http://127.0.0.1:"), 60_000, "app url (after orphan)");
let after = await health(port);
check("孤儿里没有进行中的会话：停掉它、在原端口拉起新服务", after?.pid !== orphan.pid && Number(new URL(window.url()).port) === port, `${orphan?.pid} -> ${after?.pid}`);
check("孤儿进程已退出", await waitFor(async () => gone(orphan.pid), 10_000, "orphan gone"));
await quitApp(app);
await waitFor(() => portFree(port), 15_000, "port free 2");

// 7b 孤儿里有进行中的会话：先问，选「等会话结束再启动」，会话结束后自动启动
orphan = await launchAndOrphan("wait", true);
({ app, window } = await launch());
const asked = await waitFor(async () => (await window.locator(".panel").getAttribute("data-kind")) === "question", 30_000, "question view");
const choices = asked ? await window.locator(".actions button").allTextContents() : [];
check("孤儿里有进行中的会话时先问，不直接停", asked && choices.length === 2, JSON.stringify(choices));
check("问的时候孤儿还在", (await health(port))?.pid === orphan.pid);
await window.locator('button[data-action="waitOrphan"]').click();
const waiting = await waitFor(async () => (await window.locator(".actions button").count()) === 1, 10_000, "waiting view");
check("选等待后只剩「停掉并重新启动」", waiting);
insertTurnEvent("turn.completed", "u-wait");
const resumed = await waitFor(async () => window.url().startsWith("http://127.0.0.1:"), 30_000, "app url after wait");
after = await health(port);
check("会话结束后自动停掉孤儿并启动", resumed && after?.pid !== orphan.pid, `${orphan?.pid} -> ${after?.pid}`);
await quitApp(app);
await waitFor(() => portFree(port), 15_000, "port free 3");

// 7c 再来一次，选「停掉并重新启动」
orphan = await launchAndOrphan("stop", true);
({ app, window } = await launch());
await waitFor(async () => (await window.locator(".panel").getAttribute("data-kind")) === "question", 30_000, "question view 2");
await window.locator('button[data-action="stopOrphan"]').click();
const stopped = await waitFor(async () => window.url().startsWith("http://127.0.0.1:"), 30_000, "app url after stop");
after = await health(port);
check("选停掉后停掉孤儿并在原端口启动", stopped && after?.pid !== orphan.pid && gone(orphan.pid), `${orphan?.pid} -> ${after?.pid}`);
insertTurnEvent("turn.completed", "u-stop");

// 7d 确认退出的对话框开着时服务崩了：取消后补一次重启
const beforeCrash = await health(port);
insertTurnEvent("turn.started", "u-confirm");
await app.evaluate(({ dialog }) => {
  globalThis.__answer = null;
  dialog.showMessageBox = () =>
    new Promise((resolveAnswer) => {
      globalThis.__answer = resolveAnswer;
    });
});
await app.evaluate(({ app: electronApp }) => electronApp.quit());
await waitFor(async () => await app.evaluate(() => globalThis.__answer !== null), 10_000, "dialog open");
process.kill(beforeCrash.pid, "SIGKILL");
await delay(1_000);
await app.evaluate(() => globalThis.__answer({ response: 1, checkboxChecked: false }));
const recovered = await waitFor(async () => {
  const h = await health(port);
  return h?.status === "ok" && h.pid !== beforeCrash.pid;
}, 30_000, "restart after cancel");
check("对话框开着时服务崩了，取消退出后自动重启", recovered);
insertTurnEvent("turn.completed", "u-confirm");
await quitApp(app);
await waitFor(() => portFree(port), 15_000, "port free 4");

// 7e 启动途中就退出：不留下服务
({ app, window } = await launch());
await delay(300);
await quitApp(app);
check("启动途中退出：端口空出、没有留下服务", await waitFor(() => portFree(port), 20_000, "port free 5") && (await health(port)) === null);

// ---------- 8. 首选端口被别的程序占用 ----------
const blocker = createServer((socket) => socket.end("HTTP/1.1 200 OK\r\n\r\nnot suduo"));
await new Promise((done) => blocker.listen({ host: "127.0.0.1", port: 8790 }, done));
rmSync(join(home, "desktop.json"));
({ app, window } = await launch());
await waitFor(async () => window.url().startsWith("http://127.0.0.1:"), 60_000, "app url (blocked)");
const blockedPort = Number(new URL(window.url()).port);
check("8790 被占用时换到 8791，并记住", blockedPort === 8791 && prefs().port === 8791, String(blockedPort));
await quitApp(app);
blocker.close();

// ---------- 9. 启动失败页 ----------
({ app, window } = await launch({ SUDUO_DESKTOP_NODE: "/nonexistent/node" }));
const failed = await waitFor(async () => (await window.locator(".panel").getAttribute("data-kind")) === "failed", 30_000, "failed view");
const failText = failed ? await window.locator("#message").textContent() : "";
check("Node 不存在时显示失败页与原因", failed && /没能启动本机服务|Couldn't start/.test(failText ?? ""), failText ?? "");
const buttons = await window.locator(".actions button").allTextContents();
check("失败页有重试、打开日志、运行自检", buttons.length === 3 && buttons.every((b) => b.trim() !== ""), JSON.stringify(buttons));
await window.locator('button[data-action="runDoctor"]').click();
const doctorShown = await waitFor(async () => ((await window.locator("#doctor").textContent()) ?? "").length > 0, 30_000, "doctor output");
check("运行自检后显示输出", doctorShown, ((await window.locator("#doctor").textContent()) ?? "").slice(0, 80));
await app.close().catch(() => undefined);

const failedCount = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failedCount}/${results.length} passed`);
process.exit(failedCount === 0 ? 0 : 1);
