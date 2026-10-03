/**
 * 快捷键一览（需求 §4.1、技术设计 §6.5）的唯一清单。
 *
 * 各页的按键处理仍在各自组件里（离要做的事最近）；这里登记「有哪些、按什么、做什么」，
 * 「?」打开的一览只读这份清单。新增或改动快捷键时两处一起改，test/shortcuts.test.ts 会核对一览里的
 * 每一条都能在源码里找到对应的处理。
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

export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = [
  {
    title: "全局",
    items: [
      { keys: [["mod", "K"]], description: "搜索或执行命令（输入框里也可用）", sources: ["app/shell/AppShell.tsx"] },
      { keys: [["mod", "\\"]], description: "收起 / 展开侧栏", sources: ["app/shell/AppShell.tsx"] },
      { keys: [["?"]], description: "打开这份快捷键一览", sources: ["app/shell/AppShell.tsx"] },
      { keys: [["Esc"]], description: "关闭对话框、菜单或速览", sources: [REQUIREMENTS] },
    ],
  },
  {
    title: "需求",
    scope: "看板、列表与详情页",
    items: [
      { keys: [["C"]], description: "新建需求（看板 / 列表）", sources: [REQUIREMENTS] },
      { keys: [["/"]], description: "搜索需求（看板 / 列表）", sources: [REQUIREMENTS] },
      { keys: [["J"], ["↓"]], description: "下一条", sources: [REQUIREMENTS] },
      { keys: [["K"], ["↑"]], description: "上一条", sources: [REQUIREMENTS] },
      { keys: [["←"], ["→"]], description: "看板上移到相邻的列", sources: [REQUIREMENTS] },
      { keys: [["1"], ["…"], ["7"]], description: "把当前需求改到对应状态（草稿 … 暂缓）", sources: [REQUIREMENTS, DETAIL] },
      { keys: [["Esc"]], description: "详情页回到列表（有没保存的编辑时不离开）", sources: [DETAIL] },
    ],
  },
  {
    title: "写需求",
    scope: "在描述、评论或新建需求的输入框里",
    items: [
      {
        keys: [["mod", "Enter"]],
        description: "保存描述 / 发送评论 / 提交新建",
        sources: [DETAIL, "features/requirements/components/CreateRequirementDialog.tsx"],
      },
    ],
  },
  {
    title: "会话输入框",
    items: [
      { keys: [["Enter"]], description: "发送（运行中会并入这一轮）", sources: [COMPOSER] },
      { keys: [["Shift", "Enter"]], description: "换行", sources: [COMPOSER] },
      { keys: [["Tab"]], description: "运行中：排到这一轮之后", sources: [COMPOSER] },
      { keys: [["↑"]], description: "输入框为空时取回上一条", sources: [COMPOSER] },
      { keys: [["Esc"]], description: "输入框为空时停止当前这一轮", sources: [COMPOSER] },
    ],
  },
  {
    title: "会话",
    items: [
      { keys: [["mod", "J"]], description: "显示 / 隐藏检查面板（输入框里也可用）", sources: ["app/SessionRuntime.tsx"] },
      { keys: [["mod", "B"]], description: "显示 / 隐藏会话列表", sources: ["features/sessions/SessionsPage.tsx"] },
      {
        keys: [["Enter"], ["Esc"]],
        description: "有待确认的操作时：同意 / 拒绝（焦点在确认卡上，或没停在任何控件上）",
        sources: ["features/sessions/ApprovalDock.tsx"],
      },
    ],
  },
  {
    title: "设置",
    items: [
      { keys: [["/"]], description: "搜索设置", sources: ["features/settings/SettingsPage.tsx"] },
      { keys: [["mod", "S"]], description: "保存当前分组的更改（输入框里也可用）", sources: ["features/settings/components/frame.tsx"] },
    ],
  },
];

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
