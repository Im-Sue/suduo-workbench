import { spawn } from "node:child_process";
import { mkdirSync, readFileSync } from "node:fs";
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
import { CODEX_VERSION, type SuDuoDesktopInfo } from "@suduo/client-contracts";
import { chooseDesktopLocale, desktopMessages, parseStoredLocale, type DesktopLocale, type DesktopMessages } from "../i18n/index.js";
import { IPC, type StartupView } from "../shared/ipc.js";
import { buildServerEnvironment } from "./environment.js";
import { createLogger } from "./logger.js";
import { applyApplicationMenu, popupContextMenu, type MenuActions } from "./menus.js";
import { isAllowedPermission, isAppUrl, isExternalOpenable, isStartupUrl } from "./navigation.js";
import { resolveDesktopPaths } from "./paths.js";
import { LAST_CANDIDATE_PORT, PREFERRED_PORT, choosePort, inspectPort } from "./ports.js";
import { loadPreferences, savePreferences, type DesktopPreferences, type WindowBounds } from "./preferences.js";
import { ServerProcess, nextRestartDelay, stopOrphan, type StartFailure } from "./server-process.js";
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

type ViewState =
  | { kind: "progress"; step: "starting" | "readingEnvironment" | "stopping" }
  | { kind: "failed"; reason: FailureReason };

type FailureReason =
  | { kind: "portsBusy" }
  | { kind: "orphanNotStopped"; port: number }
  | { kind: "start"; failure: StartFailure }
  | { kind: "crashedRepeatedly" };

type QuitState = "running" | "confirming" | "stopping" | "done";

class DesktopController {
  private readonly log = createLogger(paths.desktopLog, !app.isPackaged);
  private readonly hiddenStart = process.argv.includes("--hidden");
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
  private booting = false;
  private readonly restartHistory: number[] = [];
  private quitState: QuitState = "running";
  private systemShutdown = false;
  private doctor: { running: boolean; output: string } = { running: false, output: "" };
  private boundsTimer: NodeJS.Timeout | null = null;

  private readonly menuActions: MenuActions = {
    showWindow: () => this.showWindow(),
    openInBrowser: () => {
      if (this.baseUrl !== null) void shell.openExternal(this.baseUrl);
    },
    quit: () => app.quit(),
    ready: () => this.baseUrl !== null,
    devTools: !app.isPackaged || process.env["SUDUO_DESKTOP_DEVTOOLS"] === "1",
  };

  start(): void {
    this.log(`SuDuo desktop ${this.version()} starting (packaged=${String(app.isPackaged)}, data=${paths.dataDir})`);
    this.savePrefs();
    this.installSessionPolicy();
    this.installIpc();
    this.installAppEvents();
    this.tray = new SuDuoTray(paths.assetsDir, this.menuActions);
    this.refreshChrome();
    this.window = this.createWindow();
    void this.boot();
  }

  showWindow(): void {
    if (this.window === null || this.window.isDestroyed()) {
      this.window = this.createWindow();
      if (this.baseUrl !== null) void this.window.loadURL(this.baseUrl);
    }
    if (this.window.isMinimized()) this.window.restore();
    this.window.show();
    this.window.focus();
    if (process.platform === "darwin") app.focus({ steal: true });
  }

  // ---------- 启动本机服务 ----------

  private async boot(): Promise<void> {
    if (this.booting || this.quitState !== "running") return;
    this.booting = true;
    try {
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
      this.showStartup({ kind: "progress", step: "starting" });
      const choice = await choosePort({
        remembered: this.prefs.port,
        inspect: (port) => inspectPort(port, this.prefs.instanceId),
      });
      if (choice === null) {
        this.fail({ kind: "portsBusy" });
        return;
      }
      if (choice.orphan) {
        this.log(`stopping a local service left over on port ${String(choice.port)}`);
        if (!(await stopOrphan(choice.port))) {
          this.fail({ kind: "orphanNotStopped", port: choice.port });
          return;
        }
      }
      await this.startServer(choice.port);
    } catch (error) {
      this.log(`boot failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      this.fail({ kind: "start", failure: { kind: "spawn", message: error instanceof Error ? error.message : String(error) } });
    } finally {
      this.booting = false;
    }
  }

  private async startServer(port: number): Promise<void> {
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
    server.onUnexpectedExit((detail) => void this.handleCrash(detail));
    this.server = server;
    const result = await server.start();
    if (!result.ok) {
      this.server = null;
      this.fail({ kind: "start", failure: result.failure });
      return;
    }
    if (this.quitState !== "running") return;
    if (this.prefs.port !== port) {
      this.prefs = { ...this.prefs, port };
      this.savePrefs();
    }
    this.setBaseUrl(server.baseUrl);
    await this.window?.loadURL(server.baseUrl);
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
    if (this.quitState !== "running") return;
    this.log(`local service exited unexpectedly (code ${String(detail.code)}, signal ${String(detail.signal)})`);
    this.server = null;
    this.setBaseUrl(null);
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
  }

  // ---------- 启动页 ----------

  private showStartup(view: ViewState): void {
    this.view = view;
    const window = this.window;
    if (window === null || window.isDestroyed()) return;
    if (isStartupUrl(window.webContents.getURL(), this.startupUrl)) {
      window.webContents.send(IPC.startupView, this.renderView());
    } else {
      // 页面载入后会发 startupReady，届时再发视图。
      void window.loadFile(paths.startupPage);
    }
  }

  private pushView(): void {
    this.showStartup(this.view);
  }

  private renderView(): StartupView {
    const locale = this.locale();
    const t = desktopMessages(locale).startup;
    if (this.view.kind === "progress") {
      const message = { starting: t.starting, readingEnvironment: t.readingEnvironment, stopping: t.stopping }[this.view.step];
      return { locale, kind: "progress", title: t.title, message };
    }
    return {
      locale,
      kind: "failed",
      title: t.failedTitle,
      message: this.failureMessage(this.view.reason, desktopMessages(locale)),
      logHint: t.logHint(paths.serverLog),
      actions: { retry: t.retry, openLogs: t.openLogs, runDoctor: t.runDoctor },
      doctor: { running: this.doctor.running, label: t.doctorRunning, output: this.doctor.output },
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

  private async runDoctor(): Promise<void> {
    if (this.doctor.running) return;
    this.doctor = { running: true, output: "" };
    this.pushView();
    const port = this.prefs.port ?? PREFERRED_PORT;
    const env = { ...this.serverEnvironment(port), SUDUO_LOCALE: this.locale() };
    const output = await new Promise<string>((resolveOutput) => {
      let text = "";
      const append = (chunk: Buffer) => {
        if (text.length < 64 * 1024) text += chunk.toString("utf8");
      };
      try {
        const child = spawn(paths.doctor.command, [...paths.doctor.args, "--port", String(port)], {
          cwd: paths.clientRoot ?? paths.dataDir,
          env,
          windowsHide: true,
        });
        const timer = setTimeout(() => child.kill(), 90_000);
        child.stdout.on("data", append);
        child.stderr.on("data", append);
        child.once("error", (error) => {
          clearTimeout(timer);
          resolveOutput(text + error.message);
        });
        child.once("close", () => {
          clearTimeout(timer);
          resolveOutput(text);
        });
      } catch (error) {
        resolveOutput(error instanceof Error ? error.message : String(error));
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
      this.systemShutdown = true;
      void this.server?.stop();
    });
    const contents = window.webContents;
    contents.setWindowOpenHandler(({ url }) => {
      // 新窗口一律交给系统浏览器（含本机地址：在浏览器里打开也是同一个服务）。
      if (isAppUrl(url, this.baseUrl) || isExternalOpenable(url)) void shell.openExternal(url);
      return { action: "deny" };
    });
    contents.on("will-navigate", (event, url) => {
      if (isAppUrl(url, this.baseUrl) || isStartupUrl(url, this.startupUrl)) return;
      event.preventDefault();
      if (isExternalOpenable(url)) void shell.openExternal(url);
    });
    contents.on("context-menu", (_event, params) => popupContextMenu(window, params, this.t()));
    contents.on("render-process-gone", (_event, details) => {
      this.log(`renderer gone: ${details.reason}`);
      if (details.reason !== "clean-exit" && !window.isDestroyed()) contents.reload();
    });
    void window.loadFile(paths.startupPage);
    return window;
  }

  private hintRunningInBackground(): void {
    if (this.prefs.closeHintShown) return;
    this.prefs = { ...this.prefs, closeHintShown: true };
    this.savePrefs();
    if (!Notification.isSupported()) return;
    const t = this.t().backgroundHint;
    new Notification({
      title: t.title,
      body: t.body(process.platform === "darwin" ? t.whereMac : t.whereWindows),
      silent: true,
    }).show();
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
      this.systemShutdown = true;
      void this.requestQuit();
    });
  }

  private async requestQuit(): Promise<void> {
    if (this.quitState !== "running") return;
    this.quitState = "confirming";
    const running = this.server !== null && !this.systemShutdown ? await this.server.runningSessions() : 0;
    if (running > 0) {
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
      const { response } = window === null || window.isDestroyed()
        ? await dialog.showMessageBox(options)
        : await dialog.showMessageBox(window, options);
      if (response !== 0) {
        this.quitState = "running";
        return;
      }
    }
    this.quitState = "stopping";
    this.saveBounds();
    if (this.window !== null && !this.window.isDestroyed() && this.window.isVisible()) {
      this.showStartup({ kind: "progress", step: "stopping" });
    }
    this.log("quitting: stopping the local service");
    await this.server?.stop();
    this.server = null;
    this.quitState = "done";
    this.tray?.destroy();
    this.tray = null;
    app.quit();
  }

  // ---------- 网页权限与 IPC ----------

  private installSessionPolicy(): void {
    const ses = session.defaultSession;
    ses.setPermissionRequestHandler((_contents, permission, callback, details) => {
      callback(isAllowedPermission(permission) && isAppUrl(details.requestingUrl, this.baseUrl));
    });
    ses.setPermissionCheckHandler((_contents, permission, requestingOrigin) => {
      return isAllowedPermission(permission) && isAppUrl(requestingOrigin, this.baseUrl);
    });
  }

  private installIpc(): void {
    const fromApp = (event: IpcMainEvent | IpcMainInvokeEvent) => isAppUrl(senderUrl(event), this.baseUrl);
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
    ipcMain.on(IPC.startupReady, (event) => {
      if (fromStartup(event)) event.sender.send(IPC.startupView, this.renderView());
    });
    ipcMain.on(IPC.startupRetry, (event) => {
      if (fromStartup(event) && this.view.kind === "failed") {
        this.restartHistory.length = 0;
        void this.boot();
      }
    });
    ipcMain.on(IPC.startupOpenLogs, (event) => {
      if (!fromStartup(event)) return;
      mkdirSync(paths.logDir, { recursive: true });
      void shell.openPath(paths.logDir);
    });
    ipcMain.on(IPC.startupRunDoctor, (event) => {
      if (fromStartup(event)) void this.runDoctor();
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
    this.tray?.update(t);
    if (this.window !== null && !this.window.isDestroyed() && isStartupUrl(this.window.webContents.getURL(), this.startupUrl)) {
      this.pushView();
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

  private savePrefs(): void {
    try {
      savePreferences(paths.preferencesFile, this.prefs);
    } catch (error) {
      this.log(`could not save preferences: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function senderUrl(event: IpcMainEvent | IpcMainInvokeEvent): string {
  return event.senderFrame?.url ?? event.sender.getURL();
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
} else {
  const controller = new DesktopController();
  app.on("second-instance", () => controller.showWindow());
  void app.whenReady().then(() => controller.start());
}
