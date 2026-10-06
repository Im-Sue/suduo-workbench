import { join } from "node:path";
import { Menu, Tray, nativeImage } from "electron";
import type { DesktopMessages } from "../i18n/index.js";
import type { MenuActions } from "./menus.js";

/**
 * 菜单栏（Mac）/ 通知区域（Windows）图标。关窗后 SuDuo 留在这里继续运行（需求讨论 3）。
 * Mac 用模板图（黑色加透明，系统按深浅色自动反色），Windows 用彩色图。
 */
export class SuDuoTray {
  private readonly tray: Tray;

  constructor(assetsDir: string, private readonly actions: MenuActions) {
    const image =
      process.platform === "darwin"
        ? nativeImage.createFromPath(join(assetsDir, "trayTemplate.png"))
        : nativeImage.createFromPath(join(assetsDir, "tray.png"));
    if (process.platform === "darwin") image.setTemplateImage(true);
    this.tray = new Tray(image);
    // Windows 习惯单击图标打开窗口；Mac 单击弹菜单（系统默认行为）。
    if (process.platform !== "darwin") {
      this.tray.on("click", () => this.actions.showWindow());
    }
  }

  update(t: DesktopMessages): void {
    this.tray.setToolTip(t.tray.tooltip);
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: t.tray.open, click: () => this.actions.showWindow() },
        { label: t.tray.openInBrowser, enabled: this.actions.ready(), click: () => this.actions.openInBrowser() },
        { type: "separator" },
        { label: t.tray.quit, click: () => this.actions.quit() },
      ]),
    );
  }

  destroy(): void {
    this.tray.destroy();
  }
}
