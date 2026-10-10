import type { DesktopPreferencesDto } from "@suduo/client-contracts";

/** 系统登录项的读写（测试可替换；生产用 Electron 的 app.get/setLoginItemSettings）。 */
export interface LoginItemHost {
  platform: NodeJS.Platform;
  /** 安装版才改系统的登录项：开发态的可执行文件是 node_modules 里的 Electron，登记它没有意义。 */
  packaged: boolean;
  get(options: { args?: string[] }): { openAtLogin: boolean; status?: string; wasOpenedAtLogin?: boolean; executableWillLaunchAtLogin?: boolean };
  set(settings: { openAtLogin: boolean; args?: string[] }): void;
}

/** Windows 开机自启时带上 --hidden：只出通知区域图标、不弹窗口。Mac 用 SMAppService，带不了参数，靠 wasOpenedAtLogin 认。 */
const WINDOWS_ARGS = ["--hidden"];

/**
 * 开机自启（桌面应用 D2，需求讨论 3：设置里开关，默认关）。只在安装版里改系统的登录项。
 */
export function applyLoginItem(host: LoginItemHost, openAtLogin: boolean): void {
  if (!host.packaged) return;
  host.set(host.platform === "win32" ? { openAtLogin, args: WINDOWS_ARGS } : { openAtLogin });
}

/** 系统那边的实际状态（Mac 13 起登录项可能要使用者在系统设置里允许）。 */
export function loginItemStatus(host: LoginItemHost): DesktopPreferencesDto["openAtLoginStatus"] {
  if (!host.packaged) return "unavailable";
  try {
    const settings = host.get(host.platform === "win32" ? { args: WINDOWS_ARGS } : {});
    if (host.platform === "darwin" && settings.status !== undefined) {
      if (settings.status === "enabled") return "enabled";
      if (settings.status === "requires-approval") return "requiresApproval";
      return "disabled";
    }
    // Windows：在任务管理器或「设置 → 启动应用」里停用时 openAtLogin 仍为 true，要再看会不会真的启动。
    if (host.platform === "win32") return settings.openAtLogin && settings.executableWillLaunchAtLogin !== false ? "enabled" : "disabled";
    return settings.openAtLogin ? "enabled" : "disabled";
  } catch {
    return "unknown";
  }
}

/** 这次是不是开机自启拉起来的（拉起来时不弹窗口）。 */
export function openedAtLogin(argv: readonly string[], host: LoginItemHost): boolean {
  if (argv.includes("--hidden")) return true;
  if (host.platform !== "darwin" || !host.packaged) return false;
  try {
    return host.get({}).wasOpenedAtLogin === true;
  } catch {
    return false;
  }
}
