import type { DesktopUpdateState } from "@suduo/client-contracts";

/** 实际去查、下、装的那一层（生产用 electron-updater，见 update-backend.ts；测试换成假的）。 */
export interface UpdateBackend {
  /** 有新版本时给出版本号，没有为 null。 */
  check(): Promise<{ version: string } | null>;
  download(onProgress: (percent: number) => void): Promise<void>;
  /** 退出并静默安装（Windows）。调用前本机服务已经停了。 */
  install(): void;
}

export interface DesktopUpdaterDeps {
  /** null：这个运行方式不检查更新（开发版，且没指定测试用的更新源）。 */
  backend: UpdateBackend | null;
  /** Windows 能在应用里下载安装；Mac 未签名时只能打开发布页（Squirrel.Mac 要求已签名）。 */
  canInstall: boolean;
  releasePage(version: string): string;
  openExternal(url: string): void;
  emit(state: DesktopUpdateState): void;
  /** 下好之后、装之前：有进行中的会话先确认（取消就先不装，下好的文件留着，再点「更新」不用重下）。 */
  confirmInstall(): Promise<boolean>;
  /** 走退出流程停掉本机服务，然后调用 install。正在退出（例如退出确认框开着）时返回 false，这次不装。 */
  quitAndInstall(install: () => void): boolean;
  log(line: string): void;
  /** 按当前外壳语言取（语言可能在运行中换）。 */
  text(): { devBuild: string; failed(reason: string): string };
  schedule?: (run: () => void, ms: number) => { cancel(): void };
}

/** 启动后多久第一次自动检查、之后隔多久再查（技术设计 §4.3）。 */
export const FIRST_CHECK_MS = 30_000;
export const CHECK_INTERVAL_MS = 24 * 60 * 60_000;

/**
 * 应用内更新（桌面应用 D3）：只提示、不强制（R5）。自动检查出错只记日志；手动检查与下载出错如实告诉使用者。
 * 有新版本时 Windows 下载（显示进度）→ 走退出流程停掉本机服务 → 静默安装并重启；Mac 打开这个版本的发布页。
 */
export class DesktopUpdater {
  private state: DesktopUpdateState = { kind: "idle" };
  private timers: Array<{ cancel(): void }> = [];
  /** 正在下载或等确认：横幅、托盘、设置里再点「更新」不再起第二次。 */
  private installing = false;

  constructor(private readonly deps: DesktopUpdaterDeps) {}

  current(): DesktopUpdateState {
    return this.state;
  }

  /** 定时自动检查；enabled 每次到点时再看（设置里随时可以关）。 */
  startAuto(enabled: () => boolean): void {
    if (this.deps.backend === null) return;
    const schedule = this.deps.schedule ?? defaultSchedule;
    const tick = () => {
      if (enabled()) void this.check(false);
      this.timers.push(schedule(tick, CHECK_INTERVAL_MS));
    };
    this.timers.push(schedule(tick, FIRST_CHECK_MS));
  }

  stop(): void {
    for (const timer of this.timers.splice(0)) timer.cancel();
  }

  async check(manual: boolean): Promise<DesktopUpdateState> {
    if (this.state.kind === "checking" || this.state.kind === "downloading") return this.state;
    const backend = this.deps.backend;
    if (backend === null) {
      if (manual) this.set({ kind: "failed", message: this.deps.text().devBuild });
      return this.state;
    }
    const before = this.state;
    if (manual) this.set({ kind: "checking" });
    try {
      const found = await backend.check();
      // 检查期间使用者点了「更新」、已经在下载：不拿检查结果盖掉它。
      if (this.installing) return this.state;
      if (found === null) this.set(manual || before.kind === "available" ? { kind: "upToDate" } : before);
      else this.set({ kind: "available", version: found.version, notesUrl: this.deps.releasePage(found.version), canInstall: this.deps.canInstall });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      this.deps.log(`update check failed: ${reason}`);
      if (this.installing) return this.state;
      // 自动检查出错（内网、GitHub 不通）不打扰：回到检查前的样子。
      this.set(manual ? { kind: "failed", message: this.deps.text().failed(reason) } : before);
    }
    return this.state;
  }

  /**
   * 使用者点了「更新」：下载（显示进度）→ 下好后有进行中的会话先确认（下载要几分钟，确认放在下好之后才是退出那一刻的
   * 实情）→ 走退出流程安装。取消或正在退出时回到「有新版本」，下好的文件留着，再点不用重下。
   */
  async install(): Promise<void> {
    const state = this.state;
    if (state.kind !== "available" || this.installing) return;
    if (!this.deps.canInstall || this.deps.backend === null) {
      this.deps.openExternal(state.notesUrl);
      return;
    }
    const backend = this.deps.backend;
    this.installing = true;
    try {
      this.set({ kind: "downloading", version: state.version, percent: 0 });
      try {
        await backend.download((percent) => this.set({ kind: "downloading", version: state.version, percent: Math.max(0, Math.min(100, Math.round(percent))) }));
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.deps.log(`update download failed: ${reason}`);
        this.set({ kind: "failed", message: this.deps.text().failed(reason) });
        return;
      }
      if (!(await this.deps.confirmInstall()) || !this.deps.quitAndInstall(() => backend.install())) {
        this.set(state);
      }
    } finally {
      this.installing = false;
    }
  }

  private set(state: DesktopUpdateState): void {
    // 下载进度事件很密：百分比没变就不再推（托盘菜单、页面都不用跟着重画）。
    const previous = this.state;
    if (previous.kind === "downloading" && state.kind === "downloading" && previous.percent === state.percent && previous.version === state.version) return;
    this.state = state;
    this.deps.emit(state);
  }
}

function defaultSchedule(run: () => void, ms: number): { cancel(): void } {
  const timer = setTimeout(run, ms);
  timer.unref();
  return { cancel: () => clearTimeout(timer) };
}
