import { currentLocale } from "../i18n/locale.js";
import { messagesFor, type Messages } from "../i18n/messages/index.js";

/**
 * 快捷键一览（需求 §4.1、技术设计 §6.5）的唯一清单。
 *
 * 各页的按键处理仍在各自组件里（离要做的事最近）；这里登记「有哪些、按什么、做什么」，
 * 「?」打开的一览只读这份清单。新增或改动快捷键时两处一起改，test/shortcuts.test.ts 会核对一览里的
 * 每一条都能在源码里找到对应的处理。说明文字在字典 shell.shortcuts 里，按调用时的语言取。
 *
 * keys：每个元素是一种按法（「或」），按法里是依次同时按下的键；「mod」按平台显示成 ⌘ 或 Ctrl。
 */
export interface ShortcutEntry {
  keys: readonly (readonly string[])[];
  description: string;
  /** 处理这个按键的源文件（相对 src/）；测试据此核对一览与实现同源。 */
  sources: readonly string[];
}

export interface ShortcutGroup {
  title: string;
  /** 什么时候生效，写在组标题旁。 */
  scope?: string;
  items: readonly ShortcutEntry[];
}

const REQUIREMENTS = "features/requirements/RequirementsPage.tsx";
const DETAIL = "features/requirements/RequirementDetailPage.tsx";
const COMPOSER = "components/Composer.tsx";

/** 快捷键清单；文字用传入的字典，默认取当前界面语言。 */
export function shortcutGroups(t: Messages = messagesFor(currentLocale())): readonly ShortcutGroup[] {
  const { global, requirements, writing, composer, sessions, settings } = t.shell.shortcuts.groups;
  return [
    {
      title: global.title,
      items: [
        { keys: [["mod", "K"]], description: global.commandPalette, sources: ["app/shell/AppShell.tsx"] },
        { keys: [["mod", "\\"]], description: global.toggleSidebar, sources: ["app/shell/AppShell.tsx"] },
        { keys: [["?"]], description: global.showShortcuts, sources: ["app/shell/AppShell.tsx"] },
        { keys: [["Esc"]], description: global.close, sources: [REQUIREMENTS] },
      ],
    },
    {
      title: requirements.title,
      scope: requirements.scope,
      items: [
        { keys: [["C"]], description: requirements.create, sources: [REQUIREMENTS] },
        { keys: [["/"]], description: requirements.search, sources: [REQUIREMENTS] },
        { keys: [["J"], ["↓"]], description: requirements.next, sources: [REQUIREMENTS] },
        { keys: [["K"], ["↑"]], description: requirements.previous, sources: [REQUIREMENTS] },
        { keys: [["←"], ["→"]], description: requirements.adjacentColumn, sources: [REQUIREMENTS] },
        { keys: [["1"], ["…"], ["7"]], description: requirements.setStatus, sources: [REQUIREMENTS, DETAIL] },
        { keys: [["Esc"]], description: requirements.backToList, sources: [DETAIL] },
      ],
    },
    {
      title: writing.title,
      scope: writing.scope,
      items: [
        {
          keys: [["mod", "Enter"]],
          description: writing.submit,
          sources: [DETAIL, "features/requirements/components/CreateRequirementDialog.tsx"],
        },
      ],
    },
    {
      title: composer.title,
      items: [
        { keys: [["Enter"]], description: composer.send, sources: [COMPOSER] },
        { keys: [["Shift", "Enter"]], description: composer.newLine, sources: [COMPOSER] },
        { keys: [["Tab"]], description: composer.queue, sources: [COMPOSER] },
        { keys: [["↑"]], description: composer.recall, sources: [COMPOSER] },
        { keys: [["Esc"]], description: composer.stop, sources: [COMPOSER] },
      ],
    },
    {
      title: sessions.title,
      items: [
        { keys: [["mod", "J"]], description: sessions.toggleInspector, sources: ["app/SessionRuntime.tsx"] },
        { keys: [["mod", "B"]], description: sessions.toggleSessionList, sources: ["features/sessions/SessionsPage.tsx"] },
        {
          keys: [["Enter"], ["Esc"]],
          description: sessions.approval,
          sources: ["features/sessions/ApprovalDock.tsx"],
        },
      ],
    },
    {
      title: settings.title,
      items: [
        { keys: [["/"]], description: settings.search, sources: ["features/settings/SettingsPage.tsx"] },
        { keys: [["mod", "S"]], description: settings.save, sources: ["features/settings/components/frame.tsx"] },
      ],
    },
  ];
}

export function isMac(): boolean {
  if (typeof navigator === "undefined") return true;
  const platform = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ?? navigator.platform;
  return /mac|iphone|ipad/i.test(platform);
}

/** 键名 → 显示文字（⌘ / Ctrl、⇧、⏎）。 */
export function keyLabel(key: string, mac = isMac()): string {
  if (key === "mod") return mac ? "⌘" : "Ctrl";
  if (key === "Shift") return mac ? "⇧" : "Shift";
  if (key === "Enter") return "⏎";
  return key;
}
