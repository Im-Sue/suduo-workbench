/** 主进程、preload 与启动页之间的 IPC 约定。只放常量与类型，三处都能引用。 */
export const IPC = {
  /** 前端（本机服务页面）→ 主进程。 */
  info: "suduo-desktop:info",
  setLocale: "suduo-desktop:set-locale",
  /** 启动页（file://）↔ 主进程。 */
  startupReady: "suduo-startup:ready",
  startupView: "suduo-startup:view",
  startupRetry: "suduo-startup:retry",
  startupOpenLogs: "suduo-startup:open-logs",
  startupRunDoctor: "suduo-startup:run-doctor",
} as const;

/** 启动页显示什么：文字都由主进程按当前语言填好，页面只负责画。 */
export interface StartupView {
  locale: "zh-CN" | "en";
  kind: "progress" | "failed";
  title: string;
  message: string;
  logHint?: string;
  actions?: { retry: string; openLogs: string; runDoctor: string };
  doctor?: { running: boolean; label: string; output: string };
}

/** preload 在启动页里暴露的 window.suDuoStartup。 */
export interface SuDuoStartupBridge {
  onView(listener: (view: StartupView) => void): void;
  retry(): void;
  openLogs(): void;
  runDoctor(): void;
}
