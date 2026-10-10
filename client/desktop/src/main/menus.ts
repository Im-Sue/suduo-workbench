import { Menu, type BrowserWindow, type ContextMenuParams, type MenuItemConstructorOptions } from "electron";
import type { DesktopMessages } from "../i18n/index.js";

export interface MenuActions {
  showWindow(): void;
  openInBrowser(): void;
  /** 帮助：官网、使用说明、报告问题（交给系统浏览器）；打开日志目录。 */
  openHelp(kind: "website" | "guide" | "issues"): void;
  openLogs(): void;
  quit(): void;
  /** 本机服务已就绪（「在浏览器中打开」只在这时可用）。 */
  ready(): boolean;
  devTools: boolean;
}

/**
 * Mac 的应用菜单。没有「编辑」菜单时 ⌘C / ⌘V 在页面里不起作用，所以必须有；「帮助」里放官网、使用说明、
 * 报告问题与日志目录（D2）。Windows 不显示菜单栏（复制粘贴等快捷键由 Chromium 自己处理；日志目录在托盘菜单里）。
 */
export function applyApplicationMenu(t: DesktopMessages, actions: MenuActions): void {
  if (process.platform !== "darwin") {
    Menu.setApplicationMenu(null);
    return;
  }
  const m = t.menu;
  const template: MenuItemConstructorOptions[] = [
    {
      label: "SuDuo",
      submenu: [
        { role: "about", label: m.about },
        { type: "separator" },
        { label: m.openInBrowser, enabled: actions.ready(), click: () => actions.openInBrowser() },
        { type: "separator" },
        { role: "services", label: m.services },
        { type: "separator" },
        { role: "hide", label: m.hide },
        { role: "hideOthers", label: m.hideOthers },
        { role: "unhide", label: m.showAll },
        { type: "separator" },
        { label: m.quit, accelerator: "Command+Q", click: () => actions.quit() },
      ],
    },
    {
      label: m.edit,
      submenu: [
        { role: "undo", label: m.undo },
        { role: "redo", label: m.redo },
        { type: "separator" },
        { role: "cut", label: m.cut },
        { role: "copy", label: m.copy },
        { role: "paste", label: m.paste },
        { role: "pasteAndMatchStyle", label: m.pasteAndMatchStyle },
        { role: "selectAll", label: m.selectAll },
      ],
    },
    {
      label: m.view,
      submenu: [
        { role: "reload", label: m.reload },
        ...(actions.devTools ? [{ role: "toggleDevTools", label: m.toggleDevTools } as const] : []),
        { type: "separator" },
        { role: "resetZoom", label: m.resetZoom },
        { role: "zoomIn", label: m.zoomIn },
        { role: "zoomOut", label: m.zoomOut },
        { type: "separator" },
        { role: "togglefullscreen", label: m.toggleFullScreen },
      ],
    },
    {
      label: m.window,
      role: "windowMenu",
      submenu: [
        { role: "minimize", label: m.minimize },
        { role: "zoom", label: m.zoom },
        { role: "close", label: m.close },
        { type: "separator" },
        { role: "front", label: m.front },
      ],
    },
    {
      label: m.help,
      role: "help",
      submenu: [
        { label: m.website, click: () => actions.openHelp("website") },
        { label: m.guide, click: () => actions.openHelp("guide") },
        { label: m.reportIssue, click: () => actions.openHelp("issues") },
        { type: "separator" },
        { label: m.openLogs, click: () => actions.openLogs() },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/** 页面里的右键菜单：Electron 默认没有，输入框里至少要能剪切、拷贝、粘贴。 */
export function popupContextMenu(window: BrowserWindow, params: ContextMenuParams, t: DesktopMessages): void {
  const m = t.menu;
  const flags = params.editFlags;
  const items: MenuItemConstructorOptions[] = [];
  if (params.isEditable) {
    items.push(
      { role: "undo", label: m.undo, enabled: flags.canUndo },
      { role: "redo", label: m.redo, enabled: flags.canRedo },
      { type: "separator" },
      { role: "cut", label: m.cut, enabled: flags.canCut },
      { role: "copy", label: m.copy, enabled: flags.canCopy },
      { role: "paste", label: m.paste, enabled: flags.canPaste },
      { type: "separator" },
      { role: "selectAll", label: m.selectAll, enabled: flags.canSelectAll },
    );
  } else if (params.selectionText.trim() !== "") {
    items.push({ role: "copy", label: m.copy, enabled: flags.canCopy });
  }
  if (items.length === 0) return;
  Menu.buildFromTemplate(items).popup({ window });
}

