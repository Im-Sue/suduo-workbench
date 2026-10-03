import { useSyncExternalStore } from "react";

/**
 * 系统通知偏好（本机）：会话在后台完成 / 失败 / 等你确认时发系统通知。
 * 会话页按同一个键读取（features/sessions/attention.ts）。
 *
 * 偏好与浏览器授权是两件事：开关只代表「我想要系统通知」，授权由浏览器决定。
 * 偏好开着而浏览器阻止时，界面照实说明并允许关掉偏好（不会卡在关不掉的状态）。
 * 设置导航的提示点和通知分组共用这一份状态：任一处改了，另一处立即同步。
 */
export const NOTIFY_STORAGE_KEY = "suduo.notify.system";

export type NotifyPermission = "granted" | "denied" | "default" | "unsupported";

export interface NotifyState {
  enabled: boolean;
  permission: NotifyPermission;
}

export function readNotifyPreference(): boolean {
  try {
    return window.localStorage.getItem(NOTIFY_STORAGE_KEY) === "on";
  } catch {
    return false;
  }
}

export function readNotifyPermission(): NotifyPermission {
  if (typeof window === "undefined" || typeof window.Notification === "undefined") return "unsupported";
  const permission = window.Notification.permission;
  return permission === "granted" || permission === "denied" ? permission : "default";
}

let snapshot: NotifyState | null = null;
const listeners = new Set<() => void>();

function read(): NotifyState {
  const next = { enabled: readNotifyPreference(), permission: readNotifyPermission() };
  // 值没变时沿用同一个对象，useSyncExternalStore 才不会反复重渲染。
  if (snapshot !== null && snapshot.enabled === next.enabled && snapshot.permission === next.permission) return snapshot;
  snapshot = next;
  return snapshot;
}

function publish(): void {
  read();
  for (const listener of listeners) listener();
}

/** 回到页面时重读一次：用户可能刚在浏览器里改了授权，或在另一个标签页改了偏好。 */
function onReturn(): void {
  publish();
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) {
    window.addEventListener("focus", onReturn);
    window.addEventListener("storage", onReturn);
    document.addEventListener("visibilitychange", onReturn);
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      window.removeEventListener("focus", onReturn);
      window.removeEventListener("storage", onReturn);
      document.removeEventListener("visibilitychange", onReturn);
    }
  };
}

export function writeNotifyPreference(on: boolean): void {
  try {
    window.localStorage.setItem(NOTIFY_STORAGE_KEY, on ? "on" : "off");
  } catch {
    // 存储不可用：本次无法记住，界面会在下次打开时如实显示。
  }
  publish();
}

/** 授权结果回来后（或浏览器授权可能变了）通知所有使用者重读。 */
export function refreshNotifyState(): void {
  publish();
}

const SERVER_SNAPSHOT: NotifyState = { enabled: false, permission: "unsupported" };

export function useNotifyState(): NotifyState {
  return useSyncExternalStore(subscribe, read, () => SERVER_SNAPSHOT);
}
