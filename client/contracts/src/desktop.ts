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

/** preload 暴露给前端的 window.suDuoDesktop；只在桌面应用里存在。后续分片按技术设计 §7.2 扩充。 */
export interface SuDuoDesktopBridge {
  info(): Promise<SuDuoDesktopInfo>;
  /** 界面语言变化时告知外壳，菜单、托盘与提示框跟着换。 */
  setLocale(locale: "zh-CN" | "en"): void;
}

export interface SuDuoDesktopInfo {
  version: string;
  platform: "darwin" | "win32" | "linux";
  arch: string;
  /** 本机服务地址，例如 http://127.0.0.1:8790/，在浏览器里打开也能用。 */
  baseUrl: string;
  dataDir: string;
  logDir: string;
}
