import { useSyncExternalStore } from "react";

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

/** 与 index.html 首屏脚本共用同一个键，改名需两处同步。 */
export const THEME_STORAGE_KEY = "suduo.theme";

const DARK_QUERY = "(prefers-color-scheme: dark)";

/**
 * 旧版每次启动都把默认值 "dark" 写回存储，老用户存的 "dark" 多半不是主动选择。
 * v5 起默认跟随系统：没有迁移标记时，把存量 "dark" 视为未选择。标记与 theme-init.js 共用。
 */
export const THEME_MIGRATION_KEY = "suduo.theme.v5";

export function loadThemePreference(): ThemePreference {
  const raw = readStorage(THEME_STORAGE_KEY);
  if (readStorage(THEME_MIGRATION_KEY) === null && raw === "dark") return "system";
  return raw === "system" || raw === "light" || raw === "dark" ? raw : "system";
}

export function resolveTheme(preference: ThemePreference): ResolvedTheme {
  if (preference !== "system") return preference;
  return typeof window.matchMedia === "function" && window.matchMedia(DARK_QUERY).matches
    ? "dark"
    : "light";
}

let stopFollowingSystem: (() => void) | null = null;

/**
 * 写入偏好并把解析后的主题落到根元素 data-theme。
 * 「跟随系统」时持续监听系统深浅色变化；切到固定主题时停止监听。
 */
export function applyThemePreference(preference: ThemePreference): void {
  writeStorage(THEME_STORAGE_KEY, preference);
  currentPreference = preference;
  writeStorage(THEME_MIGRATION_KEY, "1");
  stopFollowingSystem?.();
  stopFollowingSystem = null;
  setRootTheme(resolveTheme(preference));
  if (preference === "system" && typeof window.matchMedia === "function") {
    const query = window.matchMedia(DARK_QUERY);
    const onChange = () => setRootTheme(query.matches ? "dark" : "light");
    query.addEventListener("change", onChange);
    stopFollowingSystem = () => query.removeEventListener("change", onChange);
  }
  for (const listener of preferenceListeners) listener();
}

let currentPreference: ThemePreference | null = null;
const preferenceListeners = new Set<() => void>();

/** 主题偏好（侧栏账号菜单与设置页共用）：任一处切换，另一处同步显示。 */
export function useThemePreference(): ThemePreference {
  return useSyncExternalStore(
    (listener) => {
      preferenceListeners.add(listener);
      return () => preferenceListeners.delete(listener);
    },
    () => (currentPreference ??= loadThemePreference()),
    () => "system",
  );
}

export function currentResolvedTheme(): ResolvedTheme {
  return document.documentElement.dataset["theme"] === "dark" ? "dark" : "light";
}

function setRootTheme(theme: ResolvedTheme): void {
  const root = document.documentElement;
  root.dataset["theme"] = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  meta?.setAttribute("content", theme === "dark" ? "#0d0f13" : "#f5f6f8");
}

function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 隐私模式等场景下存储不可用：本次会话内仍按偏好生效。
  }
}
