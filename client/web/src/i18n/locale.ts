import {
  isLocalePreference,
  resolveLocale,
  type Locale,
  type LocalePreference,
} from "@suduo/client-contracts";
import { useSyncExternalStore } from "react";

/** 与 public/assets/theme-init.js 的首屏脚本共用同一个键，改名需两处同步。 */
export const LOCALE_STORAGE_KEY = "suduo.locale";

/**
 * 界面已经能用的语言。英文界面按功能区分批迁移，做完之前只放中文：
 * 「跟随系统」只会落在这里面，所以英文系统的使用者在迁移期仍看到完整的中文界面。
 */
export const UI_LOCALES: readonly Locale[] = ["zh-CN"];

export function loadLocalePreference(): LocalePreference {
  const raw = readStorage(LOCALE_STORAGE_KEY);
  return isLocalePreference(raw) ? raw : "system";
}

/** 偏好 → 界面实际用的语言；跟随系统时看浏览器语言。 */
export function resolveUiLocale(preference: LocalePreference): Locale {
  const tag = typeof navigator === "undefined" ? null : navigator.language;
  return resolveLocale(preference, tag, UI_LOCALES);
}

let preference: LocalePreference = loadLocalePreference();
let locale: Locale = resolveUiLocale(preference);
const listeners = new Set<() => void>();

/** 当前界面语言。React 之外的代码（请求头、格式化函数）用它；组件里用 useLocale()。 */
export function currentLocale(): Locale {
  return locale;
}

export function currentLocalePreference(): LocalePreference {
  return preference;
}

/** 写入偏好，把解析出的语言落到 <html lang>，并通知订阅者。 */
export function applyLocalePreference(next: LocalePreference): void {
  writeStorage(LOCALE_STORAGE_KEY, next);
  preference = next;
  locale = resolveUiLocale(next);
  if (typeof document !== "undefined") document.documentElement.lang = locale;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useLocale(): Locale {
  return useSyncExternalStore(subscribe, currentLocale, currentLocale);
}

export function useLocalePreference(): LocalePreference {
  return useSyncExternalStore(subscribe, currentLocalePreference, currentLocalePreference);
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
    // 隐私模式等存不了时只在本次会话里生效。
  }
}
