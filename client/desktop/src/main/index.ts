import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import {
  BrowserWindow,
  Notification,
  app,
  dialog,
  ipcMain,
  nativeTheme,
  powerMonitor,
  screen,
  session,
  shell,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type MessageBoxOptions,
} from "electron";
import { CODEX_VERSION, SUDUO_DOCTOR_CHECK_IDS, type DesktopPreferencesDto, type DoctorResultDto, type SuDuoDesktopInfo } from "@suduo/client-contracts";
import { chooseDesktopLocale, desktopMessages, parseStoredLocale, type DesktopLocale, type DesktopMessages } from "../i18n/index.js";
import { IPC, STARTUP_ACTIONS, type StartupActionId, type StartupView } from "../shared/ipc.js";
import { buildServerEnvironment } from "./environment.js";
import { createLogger } from "./logger.js";
import { applyLoginItem, loginItemStatus, openedAtLogin, type LoginItemHost } from "./login-item.js";
import { helpUrl } from "./help.js";
import { applyApplicationMenu, popupContextMenu, type MenuActions } from "./menus.js";
import { isAllowedPermission, isAppPageUrl, isAppUrl, isExternalOpenable, isStartupUrl } from "./navigation.js";
import { resolveDesktopPaths } from "./paths.js";
import { LAST_CANDIDATE_PORT, PREFERRED_PORT, choosePort, fetchHealth, inspectPort, isOwnServer, isProcessAlive } from "./ports.js";
import { loadPreferences, savePreferences, type DesktopPreferences, type WindowBounds } from "./preferences.js";
import { ServerProcess, nextRestartDelay, runningSessionsAt, stopOrphan, type StartFailure } from "./server-process.js";
import { loadShellEnvironment, needsShellEnvironment } from "./shell-env.js";
import { SuDuoTray } from "./tray.js";

/**
 * SuDuo 桌面外壳入口（技术设计 §二、§四）：单实例 → 启动页 → 读登录 shell 环境 → 选端口 → 拉起本机服务 → 窗口载入本机地址；
 * 关窗只隐藏，退出时有进行中的会话先确认，再优雅停止本机服务。
 */
app.setName("SuDuo");
const paths = resolveDesktopPaths({
  isPackaged: app.isPackaged,
  platform: process.platform,
  arch: process.arch,
  env: process.env,
  homeDir: homedir(),
  resourcesPath: process.resourcesPath,
  appPath: app.getAppPath(),
  codexVersion: CODEX_VERSION,
});
// 必须在 ready 和单实例锁之前：Electron 默认的 <应用数据>/SuDuo 在 Mac 上正好是源码运行的数据目录。
app.setPath("userData", paths.shellDataDir);
if (process.platform === "win32") app.setAppUserModelId("dev.suduo.desktop");

/** 上次外壳异常退出留下的服务可能正在跑迁移、一时不回应：记下的 pid 还活着时，最多等它这么久。 */
const ORPHAN_SETTLE_MS = 10_000;
const ORPHAN_POLL_MS = 5_000;
/** 冒烟模式（安装包构建后的自检，scripts/smoke.mjs）：整个过程最长这么久。 */
const SMOKE_TIMEOUT_MS = 180_000;

/** 命令行参数的值（`--name value`）。 */
function argumentValue(name: string): string | null {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value === undefined || value.startsWith("--") ? null : value;
}

interface SmokeReport {
  ok: boolean;
  checks?: Array<{ name: string; ok: boolean; detail: string }>;
  failure?: unknown;
}

type ViewState =
  | { kind: "progress"; step: "starting" | "readingEnvironment" | "stopping" }
  | { kind: "failed"; reason: FailureReason }
  | { kind: "orphanBusy"; port: number; running: number; waiting: boolean };

type FailureReason =
  | { kind: "portsBusy" }
  | { kind: "orphanNotStopped"; port: number }
  | { kind: "start"; failure: Exclude<StartFailure, { kind: "stopped" }> }
  | { kind: "crashedRepeatedly" };

type QuitState = "running" | "confirming" | "stopping" | "done";

class DesktopController {
  private readonly log = createLogger(paths.desktopLog, !app.isPackaged);
  /** 开机自启拉起来的（Windows 带 --hidden，Mac 看 wasOpenedAtLogin）：不弹窗口。start() 里定下。 */
  private hiddenStart = process.argv.includes("--hidden");
  private readonly loginHost: LoginItemHost = {
    platform: process.platform,
    packaged: app.isPackaged,
    get: (options) => app.getLoginItemSettings(options),
    set: (settings) => app.setLoginItemSettings(settings),
  };
  private readonly startupUrl = pathToFileURL(paths.startupPage).href;
  private prefs: DesktopPreferences = loadPreferences(paths.preferencesFile);
  private announcedLocale: string | null = null;
  private window: BrowserWindow | null = null;
  private tray: SuDuoTray | null = null;
  private server: ServerProcess | null = null;
  /** 登录 shell 的环境：undefined 还没读，null 读不到或不需要读。 */
  private shellEnv: Record<string, string> | null | undefined = undefined;
  private baseUrl: string | null = null;
  private view: ViewState = { kind: "progress", step: "starting" };
  private bootPromise: Promise<void> | null = null;
  private readonly restartHistory: number[] = [];
  private quitState: QuitState = "running";
  /** 确认退出的对话框开着时服务崩了：使用者取消退出后补一次重启。 */
  private restartAfterCancel = false;
  /** 系统关机 / 注销、安装器要求退出（--quit）、冒烟结束：退出时不弹确认框。 */
  private skipQuitConfirm = false;
  private exitCode = 0;
  private readonly smokeReport = argumentValue("--smoke-report");
  private smokeFinished = false;
  /** 使用者对「上次留下的服务里还有会话」的选择：stop 停掉它；wait 等会话结束（轮询中）。 */
  private orphanDecision: "stop" | "wait" | null = null;
  private doctor: { running: boolean; output: string } = { running: false, output: "" };
  private boundsTimer: NodeJS.Timeout | null = null;
  /** 启动页正在载入：载入完它会自己要视图（startupReady），这期间不要再发起载入，免得一次次互相打断。 */
  private startupLoading = false;

  private readonly menuActions: MenuActions = {
    showWindow: () => this.showWindow(),
    openInBrowser: () => {
      if (this.baseUrl !== null) void shell.openExternal(this.baseUrl);
    },
    openHelp: (kind) => void shell.openExternal(helpUrl(kind, this.locale())),
    openLogs: () => void shell.openPath(paths.logDir),
    quit: () => app.quit(),
    ready: () => this.baseUrl !== null,
    devTools: !app.isPackaged || process.env["SUDUO_DESKTOP_DEVTOOLS"] === "1",
  };

  start(): void {
    this.log(`SuDuo desktop ${this.version()} starting (packaged=${String(app.isPackaged)}, data=${paths.dataDir})`);
    this.hiddenStart = openedAtLogin(process.argv, this.loginHost);
    // 开机自启以系统的登录项为准（使用者可能在系统设置里关掉了）：不在每次启动时重新登记。
    const loginStatus = loginItemStatus(this.loginHost);
    if (loginStatus === "enabled" || loginStatus === "requiresApproval" || loginStatus === "disabled") {
      this.prefs = { ...this.prefs, openAtLogin: loginStatus !== "disabled" };
    }
    this.savePrefs();
    this.installSessionPolicy();
    this.installIpc();
    this.installAppEvents();
    this.tray = new SuDuoTray(paths.assetsDir, this.menuActions);
    this.refreshChrome();
    this.window = this.createWindow();
    if (this.smokeReport !== null) {
      setTimeout(() => void this.finishSmoke({ ok: false, failure: "timeout" }), SMOKE_TIMEOUT_MS).unref();
    }
    this.boot();
  }

  /** 安装器（覆盖安装、卸载前）请正在运行的 SuDuo 退出：不弹确认框，照常停掉本机服务。 */
  quitWithoutConfirm(): void {
    this.skipQuitConfirm = true;
    void this.requestQuit();
  }

  showWindow(): void {
    if (this.window === null || this.window.isDestroyed()) {
      this.window = this.createWindow();
      if (this.baseUrl !== null) void this.loadApp(this.baseUrl);
    }
    if (this.window.isMinimized()) this.window.restore();
    this.window.show();
    this.window.focus();
    if (process.platform === "darwin") app.focus({ steal: true });
  }

  // ---------- 启动本机服务 ----------

  /** 同一时间只跑一个；退出流程会等它收尾。 */
  private boot(): Promise<void> {
    if (this.bootPromise !== null || this.quitState !== "running") return this.bootPromise ?? Promise.resolve();
    this.bootPromise = this.runBoot().finally(() => {
      this.bootPromise = null;
    });
    return this.bootPromise;
  }

  private async runBoot(): Promise<void> {
    const quitting = () => this.quitState !== "running";
    try {
      // 手里还握着服务（例如页面没载入成功后点了重试）：先按「自己要求的停止」停掉，不会被当成崩溃。
      if (this.server !== null) {
        const previous = this.server;
        this.server = null;
        await previous.stop();
      }
      this.setBaseUrl(null);
      this.doctor = { running: false, output: "" };
      if (this.shellEnv === undefined) {
        if (needsShellEnvironment(process.platform, process.env)) {
          this.showStartup({ kind: "progress", step: "readingEnvironment" });
          const result = await loadShellEnvironment({ env: process.env });
          this.shellEnv = result.ok ? result.env : null;
          this.log(result.ok ? `read login shell environment from ${result.shell}` : `could not read login shell environment from ${result.shell}: ${result.reason}`);
        } else {
          this.shellEnv = null;
        }
      }
      if (quitting()) return;
      this.showStartup({ kind: "progress", step: "starting" });
      await this.settleRememberedServer();
      if (quitting()) return;
      const choice = await choosePort({
        remembered: this.prefs.port,
        inspect: (port) => inspectPort(port, this.prefs.instanceId),
      });
      if (quitting()) return;
      if (choice === null) {
        this.fail({ kind: "portsBusy" });
        return;
      }
      if (choice.orphan) {
        const proceed = await this.handleOrphan(choice.port);
        if (!proceed || quitting()) return;
      }
      await this.startServer(choice.port);
    } catch (error) {
      this.log(`boot failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      if (!quitting()) {
        this.fail({ kind: "start", failure: { kind: "spawn", message: error instanceof Error ? error.message : String(error) } });
      }
    }
  }

  /** 记下的服务 pid 还活着、记住的端口却一时认不出它时，给它一点时间（只判断，不结束它）。 */
  private async settleRememberedServer(): Promise<void> {
    const { serverPid, port } = this.prefs;
    if (serverPid === null || port === null || !isProcessAlive(serverPid)) return;
    const deadline = Date.now() + ORPHAN_SETTLE_MS;
    while (Date.now() < deadline && this.quitState === "running") {
      const state = await inspectPort(port, this.prefs.instanceId);
      if (state !== "busy" || !isProcessAlive(serverPid)) return;
      await delay(500);
    }
  }

  /**
   * 上次外壳异常退出留下的服务：里面没有进行中的会话就直接停掉；有的话先告诉使用者、给选项（ADR-0004：告知并给选项，
   * 不替人决定中断会话）。返回 true 表示已经停掉、可以继续启动。
   */
  private async handleOrphan(port: number): Promise<boolean> {
    if (this.orphanDecision !== "stop") {
      const running = await runningSessionsAt(`http://127.0.0.1:${String(port)}/`);
      if (running > 0) {
        if (this.orphanDecision === "wait") {
          this.showStartup({ kind: "orphanBusy", port, running, waiting: true });
          void this.pollOrphan(port);
        } else {
          this.showStartup({ kind: "orphanBusy", port, running, waiting: false });
        }
        return false;
      }
    }
    this.orphanDecision = null;
    this.log(`stopping a local service left over on port ${String(port)}`);
    if (await stopOrphan(port)) return true;
    this.fail({ kind: "orphanNotStopped", port });
    return false;
  }

  /** 「等会话结束再启动」：隔一会儿看一次，没有进行中的会话了就接着启动；使用者也可以随时改选「停掉」。 */
  private async pollOrphan(port: number): Promise<void> {
    while (this.quitState === "running" && this.orphanDecision === "wait" && this.view.kind === "orphanBusy") {
      await delay(ORPHAN_POLL_MS);
      if (this.orphanDecision !== "wait" || this.view.kind !== "orphanBusy") return;
      const running = await runningSessionsAt(`http://127.0.0.1:${String(port)}/`);
      if (running === 0) {
        this.orphanDecision = "stop";
        void this.boot();
        return;
      }
      this.showStartup({ kind: "orphanBusy", port, running, waiting: true });
    }
  }

  private async startServer(port: number): Promise<void> {
    if (this.quitState !== "running") return;
    mkdirSync(paths.dataDir, { recursive: true });
    const server = new ServerProcess({
      nodeBinary: paths.nodeBinary,
      serverMain: paths.serverMain,
      cwd: paths.serverCwd,
      env: this.serverEnvironment(port),
      port,
      instanceId: this.prefs.instanceId,
      logFile: paths.serverLog,
      log: this.log,
    });
    // 只处理当前这个服务的意外退出：被替换掉的旧服务迟到的退出事件不能把新服务的引用抹掉。
    server.onUnexpectedExit((detail) => {
      if (this.server === server) void this.handleCrash(detail);
    });
    this.server = server;
    const result = await server.start();
    if (!result.ok) {
      if (this.server === server) this.server = null;
      if (result.failure.kind !== "stopped" && this.quitState === "running") {
        this.fail({ kind: "start", failure: result.failure });
      }
      return;
    }
    // 正在退出：服务交给退出流程去停（它会在 boot 收尾后再停一次手里的服务）。
    if (this.quitState !== "running" || this.server !== server) return;
    this.prefs = { ...this.prefs, port, serverPid: server.pid };
    this.savePrefs();
    this.setBaseUrl(server.baseUrl);
    await this.loadApp(server.baseUrl);
    if (this.smokeReport !== null) void this.runSmoke(server.baseUrl);
  }

  /** 冒烟：窗口载入了本机服务页面、健康检查是自己的服务、自检里 Node / SQLite / Codex 三项通过。 */
  private async runSmoke(baseUrl: string): Promise<void> {
    const checks: NonNullable<SmokeReport["checks"]> = [];
    const title = this.window?.webContents.getTitle() ?? "";
    checks.push({ name: "window", ok: /SuDuo/.test(title), detail: title });
    const health = await fetchHealth(baseUrl, 5_000);
    checks.push({
      name: "healthz",
      ok: health.up && isOwnServer(health.body, this.prefs.instanceId),
      detail: health.up ? JSON.stringify(health.body) : "down",
    });
    try {
      const response = await fetch(new URL("api/v1/doctor", baseUrl), { signal: AbortSignal.timeout(120_000) });
      const doctor = (await response.json()) as DoctorResultDto;
      for (const id of [SUDUO_DOCTOR_CHECK_IDS.node, SUDUO_DOCTOR_CHECK_IDS.sqlite, SUDUO_DOCTOR_CHECK_IDS.codexCli]) {
        const check = doctor.checks.find((item) => item.id === id);
        checks.push({ name: id, ok: check?.status === "pass", detail: check?.message ?? "missing" });
      }
    } catch (error) {
      checks.push({ name: "doctor", ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
    await this.finishSmoke({ ok: checks.every((check) => check.ok), checks });
  }

  private async finishSmoke(report: SmokeReport): Promise<void> {
    if (this.smokeReport === null || this.smokeFinished) return;
    this.smokeFinished = true;
    const body = {
      ...report,
      version: this.version(),
      platform: process.platform,
      arch: process.arch,
      packaged: app.isPackaged,
      dataDir: paths.dataDir,
      codexBin: paths.codexBin,
    };
    try {
      writeFileSync(this.smokeReport, JSON.stringify(body, null, 2) + "\n");
    } catch (error) {
      this.log(`could not write the smoke report: ${error instanceof Error ? error.message : String(error)}`);
    }
    this.exitCode = report.ok ? 0 : 1;
    this.quitWithoutConfirm();
  }

  /** 页面载入失败不等于服务没起来：被新的导航打断（ERR_ABORTED）不用管，其余记日志、稍后再试一次。 */
  private async loadApp(url: string): Promise<void> {
    const window = this.window;
    if (window === null || window.isDestroyed()) return;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        this.log(`loading ${url}`);
        await window.loadURL(url);
        this.log(`loaded ${url}`);
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/ERR_ABORTED/.test(message)) return;
        this.log(`loading ${url} failed: ${message}`);
        await delay(1_000);
        if (window.isDestroyed() || this.baseUrl !== url) return;
      }
    }
  }

  private serverEnvironment(port: number): Record<string, string> {
    return buildServerEnvironment({
      base: process.env,
      shell: this.shellEnv ?? null,
      platform: process.platform,
      port,
      dataDir: paths.dataDir,
      pidFile: paths.pidFile,
      instanceId: this.prefs.instanceId,
      codexBin: paths.codexBin,
    });
  }

  private async handleCrash(detail: { code: number | null; signal: string | null }): Promise<void> {
    this.log(`local service exited unexpectedly (code ${String(detail.code)}, signal ${String(detail.signal)})`);
    this.server = null;
    this.setBaseUrl(null);
    if (this.quitState === "confirming") {
      this.restartAfterCancel = true;
      return;
    }
    if (this.quitState !== "running") return;
    const now = Date.now();
    const wait = nextRestartDelay(this.restartHistory, now);
    if (wait === null) {
      this.fail({ kind: "crashedRepeatedly" });
      this.showWindow();
      return;
    }
    this.restartHistory.push(now);
    this.showStartup({ kind: "progress", step: "starting" });
    await delay(wait);
    await this.boot();
  }

  private fail(reason: FailureReason): void {
    this.log(`startup failed: ${JSON.stringify(reason)}`);
    this.showStartup({ kind: "failed", reason });
    if (this.smokeReport !== null) void this.finishSmoke({ ok: false, failure: reason });
  }

  // ---------- 启动页 ----------

  private showStartup(view: ViewState): void {
    this.view = view;
    this.tray?.update(this.t(), view.kind === "failed");
    const window = this.window;
    if (window === null || window.isDestroyed()) return;
    if (this.startupLoading) return;
    if (isStartupUrl(window.webContents.getURL(), this.startupUrl)) {
      window.webContents.send(IPC.startupView, this.renderView());
    } else {
      this.loadStartupPage(window);
    }
  }

  /** 载入启动页；载入完成后页面发 startupReady，届时再发视图。 */
  private loadStartupPage(window: BrowserWindow): void {
    this.startupLoading = true;
    this.log("loading the startup page");
    window
      .loadFile(paths.startupPage)
      .catch((error: unknown) => {
        this.log(`loading the startup page failed: ${error instanceof Error ? error.message : String(error)}`);
      })
      .finally(() => {
        this.startupLoading = false;
      });
  }

  private pushView(): void {
    this.showStartup(this.view);
  }

  private renderView(): StartupView {
    const locale = this.locale();
    const t = desktopMessages(locale).startup;
    const view = this.view;
    if (view.kind === "progress") {
      const message = { starting: t.starting, readingEnvironment: t.readingEnvironment, stopping: t.stopping }[view.step];
      return { locale, kind: "progress", title: t.title, message };
    }
    if (view.kind === "orphanBusy") {
      return {
        locale,
        kind: "question",
        title: t.orphan.title,
        message: view.waiting ? t.orphan.waiting(view.running) : t.orphan.message(view.running),
        actions: view.waiting
          ? [{ id: "stopOrphan", label: t.orphan.stop }]
          : [
              { id: "stopOrphan", label: t.orphan.stop },
              { id: "waitOrphan", label: t.orphan.wait, primary: true },
            ],
      };
    }
    return {
      locale,
      kind: "failed",
      title: t.failedTitle,
      message: this.failureMessage(view.reason, desktopMessages(locale)),
      logHint: t.logHint(paths.serverLog),
      actions: [
        { id: "retry", label: t.retry, primary: true },
        { id: "openLogs", label: t.openLogs },
        { id: "runDoctor", label: this.doctor.running ? t.doctorRunning : t.runDoctor, disabled: this.doctor.running },
      ],
      doctorOutput: this.doctor.output,
    };
  }

  private failureMessage(reason: FailureReason, messages: DesktopMessages): string {
    const t = messages.startup;
    switch (reason.kind) {
      case "portsBusy":
        return t.reasons.portsBusy(PREFERRED_PORT, LAST_CANDIDATE_PORT);
      case "orphanNotStopped":
        return t.reasons.orphanNotStopped(reason.port);
      case "crashedRepeatedly":
        return t.reasons.crashedRepeatedly;
      case "start": {
        const failure = reason.failure;
        if (failure.kind === "spawn") return t.reasons.spawnFailed(failure.message);
        if (failure.kind === "timeout") return t.reasons.timeout(failure.seconds);
        const detail = failure.signal !== null ? t.exitSignal(failure.signal) : t.exitCode(failure.code ?? -1);
        return t.reasons.exited(detail);
      }
    }
  }

  private handleStartupAction(action: StartupActionId): void {
    switch (action) {
      case "retry":
        if (this.view.kind !== "failed") return;
        this.restartHistory.length = 0;
        void this.boot();
        return;
      case "openLogs":
        mkdirSync(paths.logDir, { recursive: true });
        void shell.openPath(paths.logDir);
        return;
      case "runDoctor":
        if (this.view.kind === "failed") void this.runDoctor();
        return;
      case "stopOrphan":
        if (this.view.kind !== "orphanBusy") return;
        this.orphanDecision = "stop";
        this.showStartup({ kind: "progress", step: "starting" });
        void this.boot();
        return;
      case "waitOrphan":
        if (this.view.kind !== "orphanBusy") return;
        this.orphanDecision = "wait";
        this.showStartup({ ...this.view, waiting: true });
        void this.pollOrphan(this.view.port);
        return;
    }
  }

  private async runDoctor(): Promise<void> {
    if (this.doctor.running) return;
    this.doctor = { running: true, output: "" };
    this.pushView();
    const port = this.prefs.port ?? PREFERRED_PORT;
    const env = { ...this.serverEnvironment(port), SUDUO_LOCALE: this.locale() };
    const output = await new Promise<string>((resolveOutput) => {
      let text = "";
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolveOutput(text);
      };
      const append = (chunk: Buffer) => {
        if (text.length < 64 * 1024) text += chunk.toString("utf8");
      };
      try {
        const child = spawn(paths.doctor.command, [...paths.doctor.args, "--port", String(port)], {
          cwd: paths.clientRoot ?? paths.dataDir,
          env,
          windowsHide: true,
        });
        const timer = setTimeout(() => {
          child.kill();
          finish();
        }, 90_000);
        child.stdout.on("data", append);
        child.stderr.on("data", append);
        child.once("error", (error) => {
          clearTimeout(timer);
          text += error.message;
          finish();
        });
        child.once("close", () => {
          clearTimeout(timer);
          finish();
        });
        // 自检拉起的孙进程可能还占着输出管道，'close' 迟迟不来：进程退出后稍等就收尾。
        child.once("exit", () => {
          clearTimeout(timer);
          setTimeout(finish, 300);
        });
      } catch (error) {
        text = error instanceof Error ? error.message : String(error);
        finish();
      }
    });
    this.doctor = { running: false, output: output.trim() };
    this.pushView();
  }

  // ---------- 窗口 ----------

  private createWindow(): BrowserWindow {
    const bounds = visibleBounds(this.prefs.window);
    const window = new BrowserWindow({
      ...(bounds === null ? { width: 1440, height: 900 } : { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }),
      minWidth: 960,
      minHeight: 600,
      show: false,
      title: "SuDuo",
      backgroundColor: nativeTheme.shouldUseDarkColors ? "#111215" : "#ffffff",
      ...(process.platform === "darwin" ? {} : { icon: join(paths.assetsDir, "icon.png"), autoHideMenuBar: true }),
      webPreferences: {
        preload: paths.preload,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        spellcheck: false,
      },
    });
    if (bounds?.maximized) window.maximize();
    window.once("ready-to-show", () => {
      if (!this.hiddenStart) window.show();
    });
    window.on("close", (event) => {
      if (this.quitState === "done") return;
      event.preventDefault();
      this.saveBounds();
      window.hide();
      this.hintRunningInBackground();
    });
    window.on("resize", () => this.scheduleBoundsSave());
    window.on("move", () => this.scheduleBoundsSave());
    window.on("session-end", () => {
      // Windows 注销 / 关机：拦不住，尽量把服务停干净。
      this.skipQuitConfirm = true;
      void this.server?.stop();
    });
    const contents = window.webContents;
    contents.setWindowOpenHandler(({ url }) => {
      // 新窗口一律交给系统浏览器（含本机地址：在浏览器里打开也是同一个服务）。
      if (isAppUrl(url, this.baseUrl) || isExternalOpenable(url)) void shell.openExternal(url);
      return { action: "deny" };
    });
    const guardNavigation = (event: Electron.Event, url: string) => {
      if (isAppUrl(url, this.baseUrl) || isStartupUrl(url, this.startupUrl)) return;
      event.preventDefault();
      if (isExternalOpenable(url)) void shell.openExternal(url);
    };
    contents.on("will-navigate", guardNavigation);
    // 服务端跳转同样不能把窗口带到外部地址。
    contents.on("will-redirect", guardNavigation);
    contents.on("context-menu", (_event, params) => popupContextMenu(window, params, this.t()));
    contents.on("render-process-gone", (_event, details) => {
      this.log(`renderer gone: ${details.reason}`);
      if (details.reason !== "clean-exit" && !window.isDestroyed()) contents.reload();
    });
    this.loadStartupPage(window);
    return window;
  }

  /** 首次关窗时提示一次「仍在后台运行」；通知真弹出来了才记下，没弹出来（例如系统关了通知）下次再试。 */
  private hintRunningInBackground(): void {
    if (this.prefs.closeHintShown || !Notification.isSupported()) return;
    const t = this.t().backgroundHint;
    const notification = new Notification({
      title: t.title,
      body: t.body(process.platform === "darwin" ? t.whereMac : t.whereWindows),
      silent: true,
    });
    notification.once("show", () => {
      this.prefs = { ...this.prefs, closeHintShown: true };
      this.savePrefs();
    });
    notification.show();
  }

  private scheduleBoundsSave(): void {
    if (this.boundsTimer !== null) clearTimeout(this.boundsTimer);
    this.boundsTimer = setTimeout(() => this.saveBounds(), 800);
  }

  private saveBounds(): void {
    const window = this.window;
    if (window === null || window.isDestroyed() || !window.isVisible()) return;
    const normal = window.getNormalBounds();
    this.prefs = { ...this.prefs, window: { ...normal, maximized: window.isMaximized() } };
    this.savePrefs();
  }

  // ---------- 退出 ----------

  private installAppEvents(): void {
    app.on("before-quit", (event) => {
      if (this.quitState === "done") return;
      event.preventDefault();
      void this.requestQuit();
    });
    // 关窗只是隐藏；万一窗口真被销毁了也不退出，SuDuo 留在托盘里。
    app.on("window-all-closed", () => undefined);
    app.on("activate", () => this.showWindow());
    // 类型声明里监听函数不带参数，但文档写明会传事件、可以 preventDefault 请系统稍等。
    powerMonitor.on("shutdown", (event?: Electron.Event) => {
      // Mac 关机 / 重启：请系统稍等，尽快停掉服务后退出，不弹确认框。
      event?.preventDefault();
      this.skipQuitConfirm = true;
      void this.requestQuit();
    });
  }

  private async requestQuit(): Promise<void> {
    if (this.quitState !== "running") return;
    this.quitState = "confirming";
    try {
      const running = this.server !== null && !this.skipQuitConfirm ? await this.server.runningSessions() : 0;
      if (running > 0 && !(await this.confirmQuit(running))) {
        this.quitState = "running";
        if (this.restartAfterCancel) {
          this.restartAfterCancel = false;
          void this.boot();
        }
        return;
      }
      this.quitState = "stopping";
      this.saveBounds();
      if (this.window !== null && !this.window.isDestroyed() && this.window.isVisible()) {
        this.showStartup({ kind: "progress", step: "stopping" });
      }
      this.log("quitting: stopping the local service");
      // 先停手里的服务（启动途中也能停），再等正在进行的启动收尾；启动若在这期间又拉起了服务，再停一次。
      await this.server?.stop();
      await this.bootPromise;
      await this.server?.stop();
      this.server = null;
      this.prefs = { ...this.prefs, serverPid: null };
      this.savePrefs();
    } catch (error) {
      this.log(`quit flow failed, quitting anyway: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    } finally {
      if (this.quitState !== "running") {
        this.quitState = "done";
        this.tray?.destroy();
        this.tray = null;
        if (this.exitCode !== 0) app.exit(this.exitCode);
        else app.quit();
      }
    }
  }

  private async confirmQuit(running: number): Promise<boolean> {
    this.showWindow();
    const t = this.t().quitConfirm;
    const options: MessageBoxOptions = {
      type: "warning",
      buttons: [t.quit, t.cancel],
      defaultId: 1,
      cancelId: 1,
      message: t.message(running),
      detail: t.detail,
    };
    const window = this.window;
    const { response } =
      window === null || window.isDestroyed() ? await dialog.showMessageBox(options) : await dialog.showMessageBox(window, options);
    return response === 0;
  }

  // ---------- 网页权限与 IPC ----------

  private installSessionPolicy(): void {
    const ses = session.defaultSession;
    ses.setPermissionRequestHandler((_contents, permission, callback, details) => {
      callback(isAllowedPermission(permission) && isAppPageUrl(details.requestingUrl, this.baseUrl));
    });
    ses.setPermissionCheckHandler((_contents, permission, requestingOrigin) => {
      return isAllowedPermission(permission) && isAppUrl(requestingOrigin, this.baseUrl);
    });
  }

  private installIpc(): void {
    const fromApp = (event: IpcMainEvent | IpcMainInvokeEvent) => isAppPageUrl(senderUrl(event), this.baseUrl);
    const fromStartup = (event: IpcMainEvent | IpcMainInvokeEvent) => isStartupUrl(senderUrl(event), this.startupUrl);
    ipcMain.handle(IPC.info, (event): SuDuoDesktopInfo => {
      if (!fromApp(event)) throw new Error("untrusted sender");
      return {
        version: this.version(),
        platform: process.platform === "darwin" || process.platform === "win32" ? process.platform : "linux",
        arch: process.arch,
        baseUrl: this.baseUrl ?? "",
        dataDir: paths.dataDir,
        logDir: paths.logDir,
      };
    });
    ipcMain.on(IPC.setLocale, (event, locale: unknown) => {
      if (!fromApp(event) || (locale !== "zh-CN" && locale !== "en")) return;
      if (this.announcedLocale === locale) return;
      this.announcedLocale = locale;
      this.refreshChrome();
    });
    ipcMain.handle(IPC.getPreferences, (event): DesktopPreferencesDto => {
      if (!fromApp(event)) throw new Error("untrusted sender");
      return this.preferencesDto();
    });
    ipcMain.handle(IPC.setPreferences, (event, patch: unknown): DesktopPreferencesDto => {
      if (!fromApp(event)) throw new Error("untrusted sender");
      const openAtLogin = patch !== null && typeof patch === "object" ? (patch as Record<string, unknown>)["openAtLogin"] : undefined;
      if (typeof openAtLogin === "boolean") {
        try {
          applyLoginItem(this.loginHost, openAtLogin);
        } catch (error) {
          this.log(`could not change the login item: ${error instanceof Error ? error.message : String(error)}`);
        }
        this.prefs = { ...this.prefs, openAtLogin };
        this.savePrefs();
      }
      return this.preferencesDto();
    });
    ipcMain.handle(IPC.openDirectory, async (event, kind: unknown): Promise<void> => {
      if (!fromApp(event) || (kind !== "data" && kind !== "logs")) throw new Error("untrusted sender");
      const failure = await shell.openPath(kind === "data" ? paths.dataDir : paths.logDir);
      if (failure !== "") this.log(`could not open ${kind} directory: ${failure}`);
    });
    ipcMain.on(IPC.showWindow, (event) => {
      if (fromApp(event)) this.showWindow();
    });
    ipcMain.on(IPC.startupReady, (event) => {
      if (fromStartup(event)) event.sender.send(IPC.startupView, this.renderView());
    });
    ipcMain.on(IPC.startupAction, (event, action: unknown) => {
      if (!fromStartup(event) || !(STARTUP_ACTIONS as readonly unknown[]).includes(action)) return;
      this.handleStartupAction(action as StartupActionId);
    });
  }

  // ---------- 语言、菜单与杂项 ----------

  private locale(): DesktopLocale {
    return chooseDesktopLocale({
      announced: this.announcedLocale,
      stored: parseStoredLocale(readText(paths.storedLocaleFile)),
      system: app.getPreferredSystemLanguages()[0] ?? app.getLocale(),
    });
  }

  private t(): DesktopMessages {
    return desktopMessages(this.locale());
  }

  private setBaseUrl(baseUrl: string | null): void {
    this.baseUrl = baseUrl;
    this.refreshChrome();
  }

  private refreshChrome(): void {
    const t = this.t();
    applyApplicationMenu(t, this.menuActions);
    this.tray?.update(t, this.view.kind === "failed");
    if (this.window !== null && !this.window.isDestroyed() && isStartupUrl(this.window.webContents.getURL(), this.startupUrl)) {
      this.window.webContents.send(IPC.startupView, this.renderView());
    }
    app.setAboutPanelOptions({ applicationName: "SuDuo", applicationVersion: this.version(), copyright: "PolyForm Noncommercial 1.0.0" });
  }

  private version(): string {
    if (app.isPackaged || paths.clientRoot === null) return app.getVersion();
    try {
      const value = JSON.parse(readFileSync(join(paths.clientRoot, "package.json"), "utf8")) as { version?: unknown };
      return typeof value.version === "string" ? value.version : app.getVersion();
    } catch {
      return app.getVersion();
    }
  }

  private preferencesDto(): DesktopPreferencesDto {
    return { openAtLogin: this.prefs.openAtLogin, openAtLoginStatus: loginItemStatus(this.loginHost) };
  }

  private savePrefs(): void {
    try {
      savePreferences(paths.preferencesFile, this.prefs);
    } catch (error) {
      this.log(`could not save preferences: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

/** 发送方所在框架的地址；拿不到（框架已销毁）时返回空串，不回退到整个页面的地址，交给调用方当成不可信。 */
function senderUrl(event: IpcMainEvent | IpcMainInvokeEvent): string {
  return event.senderFrame?.url ?? "";
}

function readText(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** 上次的窗口位置还在某块屏幕上才用（外接屏拔掉后不要把窗口放到看不见的地方）。 */
function visibleBounds(bounds: WindowBounds | null): WindowBounds | null {
  if (bounds === null) return null;
  const area = screen.getDisplayMatching(bounds).workArea;
  const overlapX = Math.min(bounds.x + bounds.width, area.x + area.width) - Math.max(bounds.x, area.x);
  const overlapY = Math.min(bounds.y + bounds.height, area.y + area.height) - Math.max(bounds.y, area.y);
  return overlapX >= 120 && overlapY >= 80 ? bounds : null;
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else if (process.argv.includes("--quit")) {
  // 安装器请正在运行的 SuDuo 退出（build/installer.nsh），可它并没有在运行：什么也不启动。
  app.quit();
} else {
  const controller = new DesktopController();
  app.on("second-instance", (_event, argv) => {
    if (argv.includes("--quit")) controller.quitWithoutConfirm();
    else controller.showWindow();
  });
  void app.whenReady().then(() => controller.start());
}
