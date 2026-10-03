import {
  isLocalePreference,
  resolveLocale,
  type Locale,
  type LocalePreference,
} from "@suduo/client-contracts";

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

/** 当前界面语言。React 之外的代码（请求头、格式化函数）用它；组件里用 provider.tsx 的 useLocale()。 */
export function currentLocale(): Locale {
  return locale;
}

export function currentLocalePreference(): LocalePreference {
  return preference;
}

/** 写入偏好，把解析出的语言落到 <html lang>，并通知订阅者。 */
export function applyLocalePreference(next: LocalePreference): void {
  writeStorage(LOCALE_STORAGE_KEY, next);
  setPreference(next);
}

function setPreference(next: LocalePreference): void {
  preference = next;
  locale = resolveUiLocale(next);
  if (typeof document !== "undefined") document.documentElement.lang = locale;
  for (const listener of listeners) listener();
}

/** 订阅语言变化（React 里用 provider.tsx 的 useLocale）。 */
export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// 别的标签页改了语言：跟着切，免得两个标签页语言不同、轮流改写本机服务记下的语言。
if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== LOCALE_STORAGE_KEY) return;
    const next = isLocalePreference(event.newValue) ? event.newValue : "system";
    if (next !== preference) setPreference(next);
  });
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
