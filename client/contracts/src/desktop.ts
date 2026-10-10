/**
 * 桌面应用（client/desktop，Electron 外壳）与本机服务、前端之间的约定。
 * 技术设计：docs/03_开发计划/客户端桌面应用-技术设计.md。
 */

/** 本机服务的运行形态：外壳拉起的是 desktop，其余（pnpm start、联调栈、install:m1）都是 source。 */
export const SUDUO_RUN_MODES = ["source", "desktop"] as const;
export type SuDuoRunMode = (typeof SUDUO_RUN_MODES)[number];

/** SUDUO_RUN_MODE 只认 desktop；没设、空串或别的值都按 source 处理（不因为写错就起不来）。 */
export function parseRunMode(value: string | undefined): SuDuoRunMode {
  return value === "desktop" ? "desktop" : "source";
}

/** GET /healthz。启动器、pnpm start 与桌面外壳都靠它判断端口上跑的是不是自己要的那个服务。 */
export interface HealthzResponse {
  product: "suduo";
  status: "ok";
  pid: number;
  uptimeMs: number;
  runMode: SuDuoRunMode;
  /** 桌面外壳给自己拉起的服务分配的实例标识（SUDUO_INSTANCE_ID）；其他形态没有。 */
  instanceId?: string;
}

/** GET /api/v1/system/activity：本次启动以来仍在进行中的会话数（含房间任务会话），退出前确认用。 */
export interface SystemActivityResponse {
  runningSessions: number;
}

/** preload 暴露给前端的 window.suDuoDesktop；只在桌面应用里存在（技术设计 §7.2）。 */
export interface SuDuoDesktopBridge {
  info(): Promise<SuDuoDesktopInfo>;
  /** 界面语言变化时告知外壳，菜单、托盘与提示框跟着换。 */
  setLocale(locale: "zh-CN" | "en"): void;
  /** 「设置 → 桌面应用」的偏好（D2）。 */
  getPreferences(): Promise<DesktopPreferencesDto>;
  setPreferences(patch: Partial<Pick<DesktopPreferencesDto, "openAtLogin" | "autoCheckUpdates">>): Promise<DesktopPreferencesDto>;
  /** 应用内更新（D3）：现在的状态、手动检查、更新（Windows 下载并安装；Mac 未签名时打开下载页）、订阅状态变化。 */
  getUpdateState(): Promise<DesktopUpdateState>;
  checkForUpdates(): Promise<DesktopUpdateState>;
  installUpdate(): Promise<void>;
  onUpdateState(listener: (state: DesktopUpdateState) => void): () => void;
  /** 用系统的文件管理器打开数据目录或日志目录。 */
  openDirectory(kind: "data" | "logs"): Promise<void>;
  /** 把窗口带到前面（点系统通知时：窗口可能关到了菜单栏 / 通知区域）。 */
  showWindow(): void;
}

/** 桌面应用的偏好（存在外壳的 desktop.json）。 */
export interface DesktopPreferencesDto {
  /** 开机自启（默认关；开机时不弹窗口，只出菜单栏 / 通知区域图标）。 */
  openAtLogin: boolean;
  /**
   * 系统那边的实际状态：enabled 已生效；requiresApproval 要在「系统设置 → 通用 → 登录项」里允许（Mac）；
   * unavailable 这个运行方式设不了（开发态不改系统的登录项）；unknown 读不到。
   */
  openAtLoginStatus: "enabled" | "disabled" | "requiresApproval" | "unavailable" | "unknown";
  /** 自动检查更新（默认开：启动 30 秒后一次，之后每 24 小时一次）。 */
  autoCheckUpdates: boolean;
}

/**
 * 应用内更新的状态（技术设计 §4.3，需求 R5：只提示、不强制）。
 * - available：有新版本（notesUrl 是这个版本的发布页）；Windows 点「更新」下载并安装，Mac 打开发布页下载；
 * - downloading：Windows 在下载；
 * - failed：手动检查或下载出错（自动检查出错只记日志，不打扰）。
 */
export type DesktopUpdateState =
  | { kind: "idle" | "checking" | "upToDate" }
  | { kind: "available"; version: string; notesUrl: string; canInstall: boolean }
  | { kind: "downloading"; version: string; percent: number }
  | { kind: "failed"; message: string };

export interface SuDuoDesktopInfo {
  version: string;
  platform: "darwin" | "win32" | "linux";
  arch: string;
  /** 本机服务地址，例如 http://127.0.0.1:8790/，在浏览器里打开也能用。 */
  baseUrl: string;
  dataDir: string;
  logDir: string;
}
