/** 主进程、preload 与启动页之间的 IPC 约定。只放常量与类型，三处都能引用。 */
export const IPC = {
  /** 前端（本机服务页面）→ 主进程。 */
  info: "suduo-desktop:info",
  setLocale: "suduo-desktop:set-locale",
  getPreferences: "suduo-desktop:get-preferences",
  setPreferences: "suduo-desktop:set-preferences",
  openDirectory: "suduo-desktop:open-directory",
  showWindow: "suduo-desktop:show-window",
  getUpdateState: "suduo-desktop:get-update-state",
  checkForUpdates: "suduo-desktop:check-for-updates",
  installUpdate: "suduo-desktop:install-update",
  /** 主进程 → 页面：更新状态变了。 */
  updateState: "suduo-desktop:update-state",
  /** 启动页（file://）↔ 主进程。 */
  startupReady: "suduo-startup:ready",
  startupView: "suduo-startup:view",
  startupAction: "suduo-startup:action",
} as const;

/** 启动页上的按钮。 */
export const STARTUP_ACTIONS = ["retry", "openLogs", "runDoctor", "stopOrphan", "waitOrphan"] as const;
export type StartupActionId = (typeof STARTUP_ACTIONS)[number];

/** 启动页显示什么：文字都由主进程按当前语言填好，页面只负责画。 */
export interface StartupView {
  locale: "zh-CN" | "en";
  /** progress：转圈；failed：失败原因与处理按钮；question：需要使用者选一个（例如上次留下的服务里还有会话）。 */
  kind: "progress" | "failed" | "question";
  title: string;
  message: string;
  logHint?: string;
  actions?: Array<{ id: StartupActionId; label: string; primary?: boolean; disabled?: boolean }>;
  doctorOutput?: string;
}

/** preload 在启动页里暴露的 window.suDuoStartup。 */
export interface SuDuoStartupBridge {
  onView(listener: (view: StartupView) => void): void;
  act(action: StartupActionId): void;
}
