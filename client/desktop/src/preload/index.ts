import { contextBridge, ipcRenderer } from "electron";
import type { SuDuoDesktopBridge } from "@suduo/client-contracts";
import { IPC, type StartupView, type SuDuoStartupBridge } from "../shared/ipc.js";

/**
 * 窗口的 preload（sandbox 下运行，只能用 contextBridge 与 ipcRenderer）。
 * 启动页（file://）拿到 window.suDuoStartup；本机服务页面拿到 window.suDuoDesktop。两边都不暴露 Node 能力，
 * 主进程还会按发送方地址再校验一次（main/navigation.ts）。
 */
if (window.location.protocol === "file:") {
  const startup: SuDuoStartupBridge = {
    onView(listener) {
      ipcRenderer.on(IPC.startupView, (_event, view: StartupView) => listener(view));
      ipcRenderer.send(IPC.startupReady);
    },
    retry: () => ipcRenderer.send(IPC.startupRetry),
    openLogs: () => ipcRenderer.send(IPC.startupOpenLogs),
    runDoctor: () => ipcRenderer.send(IPC.startupRunDoctor),
  };
  contextBridge.exposeInMainWorld("suDuoStartup", startup);
} else {
  const desktop: SuDuoDesktopBridge = {
    info: () => ipcRenderer.invoke(IPC.info),
    setLocale: (locale) => ipcRenderer.send(IPC.setLocale, locale),
  };
  contextBridge.exposeInMainWorld("suDuoDesktop", desktop);
}
