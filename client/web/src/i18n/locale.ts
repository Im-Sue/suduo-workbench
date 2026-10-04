import {
  isLocalePreference,
  resolveLocale,
  type Locale,
  type LocalePreference,
} from "@suduo/client-contracts";
import { captureCarry, switchWouldLoseWork } from "./carry.js";

/** 与 public/assets/theme-init.js 的首屏脚本共用同一个键，改名需两处同步。 */
export const LOCALE_STORAGE_KEY = "suduo.locale";

/**
 * 界面已经能用的语言：「跟随系统」只会落在这里面，设置里的语言选项也只列这些。
 * 中英两种都已做完（S9 起英文正式开放）：浏览器语言不是中文的人，没手动选过时看到英文界面。
 * 以后加第三种语言，做完之前不要放进来。
 */
export const UI_LOCALES: readonly Locale[] = ["zh-CN", "en"];

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

/**
 * 写入偏好，把解析出的语言落到 <html lang>，并通知订阅者。
 * 界面语言真的变了时，界面会按新语言重建：先由 carry.ts 拍下要带过去的状态（草稿、排队的消息）。
 * 会丢东西时要不要先问，由调用方（设置里的语言选项）决定。
 */
export function applyLocalePreference(next: LocalePreference): void {
  // 这里自己选了语言：别的标签页那一次不用再等（setPreference 会通知订阅者）。
  dropDeferred();
  writeStorage(LOCALE_STORAGE_KEY, next);
  setPreference(next);
}

function setPreference(next: LocalePreference): void {
  const nextLocale = resolveUiLocale(next);
  if (nextLocale !== locale) captureCarry();
  preference = next;
  locale = nextLocale;
  if (typeof document !== "undefined") document.documentElement.lang = locale;
  notify();
}

function notify(): void {
  for (const listener of listeners) listener();
}

/**
 * 带不了请求头的地址（EventSource）在末尾加上 `locale=<当前界面语言>`，本机服务在请求头之后认它。
 * 参数名与本机服务 server/src/i18n/locale.ts 的 LOCALE_QUERY_PARAM 一致。
 * 地址在建连接时定下：语言切换后整棵界面重建，各条事件流随之按新语言重连。
 */
export function withLocaleParam(url: string): string {
  return `${url}${url.includes("?") ? "&" : "?"}locale=${encodeURIComponent(locale)}`;
}

/** 订阅语言变化与「别的标签页改了、这里还没跟」的变化（React 里用 provider.tsx 的 useLocale）。 */
export function subscribeLocale(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * 别的标签页改了语言：跟着切，免得两个标签页语言不同、轮流改写本机服务记下的语言。
 * 但这个标签页可能正开着对话框、改着没保存的表单——重建会把它们清掉，而这里没人点过切换。
 * 这时先记下，每秒看一次，处理完（对话框关了、表单存了或放弃了）再切；草稿与排队的消息本来就会带过去，不用等。
 * 等的这段时间这个标签页仍按原来的语言发请求，并显示一条不打断的提示（DeferredLocaleNotice），可以确认后马上切。
 */
const DEFERRED_CHECK_MS = 1_000;
let deferred: LocalePreference | null = null;
let deferredTimer: ReturnType<typeof setInterval> | null = null;

/** 不再等别的标签页的那次切换；返回之前是否在等（调用方据此决定要不要通知订阅者）。 */
function dropDeferred(): boolean {
  const had = deferred !== null;
  deferred = null;
  if (deferredTimer !== null) clearInterval(deferredTimer);
  deferredTimer = null;
  return had;
}

/** 切过去（setPreference 会通知订阅者）；偏好没变时只通知「不等了」。 */
function settle(next: LocalePreference, hadDeferred: boolean): void {
  if (next !== preference) setPreference(next);
  else if (hadDeferred) notify();
}

function followOtherTab(next: LocalePreference): void {
  const hadDeferred = dropDeferred();
  if (next === preference || resolveUiLocale(next) === locale || !switchWouldLoseWork()) {
    settle(next, hadDeferred);
    return;
  }
  deferred = next;
  notify();
  deferredTimer = setInterval(() => {
    if (deferred === null || switchWouldLoseWork()) return;
    const pending = deferred;
    settle(pending, dropDeferred());
  }, DEFERRED_CHECK_MS);
}

/** 别的标签页改了、这里还没跟上的语言偏好（等对话框或表单处理完）；没有时为 null。 */
export function deferredLocalePreference(): LocalePreference | null {
  return deferred;
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key !== LOCALE_STORAGE_KEY) return;
    followOtherTab(isLocalePreference(event.newValue) ? event.newValue : "system");
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
