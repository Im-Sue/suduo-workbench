import { contextBridge, ipcRenderer } from "electron";
import type { DesktopUpdateState, SuDuoDesktopBridge } from "@suduo/client-contracts";
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
    act: (action) => ipcRenderer.send(IPC.startupAction, action),
  };
  contextBridge.exposeInMainWorld("suDuoStartup", startup);
} else if (!window.location.pathname.startsWith("/api/")) {
  // 本机服务的接口响应（例如原样返回的项目 .html 文件）不给桥；主进程同样会拒绝（main/navigation.ts isAppPageUrl）。
  const desktop: SuDuoDesktopBridge = {
    info: () => ipcRenderer.invoke(IPC.info),
    setLocale: (locale) => ipcRenderer.send(IPC.setLocale, locale),
    getPreferences: () => ipcRenderer.invoke(IPC.getPreferences),
    setPreferences: (patch) => ipcRenderer.invoke(IPC.setPreferences, patch),
    openDirectory: (kind) => ipcRenderer.invoke(IPC.openDirectory, kind),
    showWindow: () => ipcRenderer.send(IPC.showWindow),
    getUpdateState: () => ipcRenderer.invoke(IPC.getUpdateState),
    checkForUpdates: () => ipcRenderer.invoke(IPC.checkForUpdates),
    installUpdate: () => ipcRenderer.invoke(IPC.installUpdate),
    onUpdateState: (listener) => {
      const handler = (_event: unknown, state: DesktopUpdateState) => listener(state);
      ipcRenderer.on(IPC.updateState, handler);
      return () => ipcRenderer.removeListener(IPC.updateState, handler);
    },
  };
  contextBridge.exposeInMainWorld("suDuoDesktop", desktop);
}
