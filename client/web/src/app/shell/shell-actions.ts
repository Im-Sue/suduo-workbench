import { useSyncExternalStore } from "react";

/**
 * 外壳发给页面的一次性动作（例：侧栏「新建项目」→ 需求页打开项目对话框）。
 * 页面处理后调用 clearProjectAction()；动作不进 URL，刷新即消失。
 */
export type ProjectAction = "create" | "manage";

let pendingProjectAction: ProjectAction | null = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function requestProjectAction(action: ProjectAction): void {
  pendingProjectAction = action;
  emit();
}

export function clearProjectAction(): void {
  if (pendingProjectAction === null) return;
  pendingProjectAction = null;
  emit();
}

export function usePendingProjectAction(): ProjectAction | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => pendingProjectAction,
    () => pendingProjectAction,
  );
}

/** 侧栏展开 / 收起与命令面板开关：跨组件共享的轻量 UI 状态。 */
let commandPaletteOpen = false;
const paletteListeners = new Set<() => void>();

export function setCommandPaletteOpen(open: boolean): void {
  if (commandPaletteOpen === open) return;
  commandPaletteOpen = open;
  for (const listener of paletteListeners) listener();
}

export function useCommandPaletteOpen(): boolean {
  return useSyncExternalStore(
    (listener) => {
      paletteListeners.add(listener);
      return () => paletteListeners.delete(listener);
    },
    () => commandPaletteOpen,
    () => commandPaletteOpen,
  );
}

/** 「?」快捷键一览的开关。 */
let shortcutsOpen = false;
const shortcutsListeners = new Set<() => void>();

export function setShortcutsOpen(open: boolean): void {
  if (shortcutsOpen === open) return;
  shortcutsOpen = open;
  for (const listener of shortcutsListeners) listener();
}

export function useShortcutsOpen(): boolean {
  return useSyncExternalStore(
    (listener) => {
      shortcutsListeners.add(listener);
      return () => shortcutsListeners.delete(listener);
    },
    () => shortcutsOpen,
    () => false,
  );
}
