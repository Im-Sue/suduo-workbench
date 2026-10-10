import { autoUpdater } from "electron-updater";
import type { UpdateBackend } from "./updater.js";

/**
 * 生产用的更新后端：electron-updater 读 GitHub Release 上的 latest.yml / latest-mac.yml（安装包里的 app-update.yml
 * 指明了仓库）。不自动下载、不在退出时自动安装：何时下、何时装由使用者点「更新」决定。
 * 开发版默认不检查；设了 SUDUO_DESKTOP_UPDATE_FEED（测试用的更新源地址）时改从那里读。
 */
export function createUpdateBackend(input: { packaged: boolean; feedUrl: string | null; log(line: string): void }): UpdateBackend | null {
  if (!input.packaged && input.feedUrl === null) return null;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.logger = {
    info: (message?: unknown) => input.log(`updater: ${String(message)}`),
    warn: (message?: unknown) => input.log(`updater warn: ${String(message)}`),
    error: (message?: unknown) => input.log(`updater error: ${String(message)}`),
    debug: () => undefined,
  };
  if (input.feedUrl !== null) {
    autoUpdater.forceDevUpdateConfig = true;
    autoUpdater.setFeedURL({ provider: "generic", url: input.feedUrl });
  }
  return {
    async check() {
      const result = await autoUpdater.checkForUpdates();
      if (result === null || !result.isUpdateAvailable) return null;
      return { version: result.updateInfo.version };
    },
    async download(onProgress) {
      const listener = (progress: { percent: number }) => onProgress(progress.percent);
      autoUpdater.on("download-progress", listener);
      try {
        await autoUpdater.downloadUpdate();
      } finally {
        autoUpdater.off("download-progress", listener);
      }
    },
    install() {
      // 静默安装（不弹 NSIS 界面），装完再打开 SuDuo。
      autoUpdater.quitAndInstall(true, true);
    },
  };
}
