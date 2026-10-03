// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api/client.js";
import {
  LOCALE_STORAGE_KEY,
  applyLocalePreference,
  currentLocale,
  loadLocalePreference,
  resolveUiLocale,
} from "../src/i18n/locale.js";
import { LocaleBoundary, useT } from "../src/i18n/provider.js";
import {
  formatDateTime,
  formatDayLabel,
  formatDuration,
  formatRelativeTime,
} from "../src/ui/format.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  // 先恢复浏览器语言再重置偏好：顺序反了，「跟随系统」会按上一个用例的语言解析。
  vi.unstubAllGlobals();
  Object.defineProperty(navigator, "language", { value: "zh-CN", configurable: true });
  applyLocalePreference("system");
  window.localStorage.clear();
});

describe("界面语言偏好", () => {
  it("迁移期跟随系统只会落到已做完的中文界面；固定语言照用", () => {
    Object.defineProperty(navigator, "language", { value: "en-US", configurable: true });
    expect(resolveUiLocale("system")).toBe("zh-CN");
    expect(resolveUiLocale("en")).toBe("en");
    expect(resolveUiLocale("zh-CN")).toBe("zh-CN");
  });

  it("切换后写入存储、更新 <html lang> 与当前语言", () => {
    applyLocalePreference("en");
    expect(window.localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("en");
    expect(loadLocalePreference()).toBe("en");
    expect(document.documentElement.lang).toBe("en");
    expect(currentLocale()).toBe("en");
    applyLocalePreference("system");
    expect(document.documentElement.lang).toBe("zh-CN");
  });

  it("别的标签页改了语言，这里跟着切", () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, "en");
    window.dispatchEvent(new StorageEvent("storage", { key: LOCALE_STORAGE_KEY, newValue: "en" }));
    expect(currentLocale()).toBe("en");
    expect(document.documentElement.lang).toBe("en");
    window.dispatchEvent(new StorageEvent("storage", { key: "other", newValue: "zh-CN" }));
    expect(currentLocale()).toBe("en");
  });

  it("存储里的坏值当作跟随系统", () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, "fr");
    expect(loadLocalePreference()).toBe("system");
  });
});

describe("语言边界", () => {
  it("切换语言时按新语言重建界面，并让查询重取", async () => {
    const queryClient = new QueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    let mounts = 0;
    function Probe() {
      const t = useT();
      useEffect(() => {
        mounts += 1;
      }, []);
      return <span data-testid="probe">{t.sessions.checkpoints.turnStart}</span>;
    }
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root?.render(
        <QueryClientProvider client={queryClient}>
          <LocaleBoundary>
            <Probe />
          </LocaleBoundary>
        </QueryClientProvider>,
      ),
    );
    expect(container.textContent).toBe("回合前自动存档");
    expect(invalidate).not.toHaveBeenCalled();

    await act(async () => applyLocalePreference("en"));
    expect(container.textContent).toBe("Auto-saved before turn");
    expect(mounts).toBe(2);
    expect(invalidate).toHaveBeenCalledTimes(1);
  });
});

describe("请求带上界面语言", () => {
  it("每个请求都有 X-SuDuo-Locale", async () => {
    const fetch = vi.fn().mockImplementation(async () => new Response(JSON.stringify({}), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    await api.getSettings();
    applyLocalePreference("en");
    await api.getSettings();
    const sent = fetch.mock.calls.map(([, init]) => (init as RequestInit).headers as Record<string, string>);
    expect(sent.map((headers) => headers["X-SuDuo-Locale"])).toEqual(["zh-CN", "en"]);
  });
});

describe("按语言格式化日期与时长", () => {
  const now = new Date(2026, 8, 30, 12, 0, 0);

  it("中文与之前的格式一致", () => {
    expect(formatRelativeTime(new Date(2026, 8, 30, 11, 59, 40), now, "zh-CN")).toBe("刚刚");
    expect(formatRelativeTime(new Date(2026, 8, 30, 11, 55), now, "zh-CN")).toBe("5 分钟前");
    expect(formatRelativeTime(new Date(2026, 8, 30, 8, 5), now, "zh-CN")).toBe("08:05");
    expect(formatRelativeTime(new Date(2026, 8, 29, 14, 32), now, "zh-CN")).toBe("昨天 14:32");
    expect(formatRelativeTime(new Date(2026, 8, 2, 8), now, "zh-CN")).toBe("9月2日");
    expect(formatRelativeTime(new Date(2025, 8, 2, 8), now, "zh-CN")).toBe("2025年9月2日");
    expect(formatDateTime(new Date(2025, 8, 27, 14, 32, 5), "zh-CN")).toBe("2025年9月27日 14:32:05");
    expect(formatDuration(65_000, "zh-CN")).toBe("1 分 5 秒");
  });

  it("英文", () => {
    expect(formatRelativeTime(new Date(2026, 8, 30, 11, 59, 40), now, "en")).toBe("just now");
    expect(formatRelativeTime(new Date(2026, 8, 30, 11, 55), now, "en")).toBe("5 min ago");
    expect(formatRelativeTime(new Date(2026, 8, 29, 14, 32), now, "en")).toBe("Yesterday 14:32");
    expect(formatRelativeTime(new Date(2026, 8, 2, 8), now, "en")).toBe("Sep 2");
    expect(formatRelativeTime(new Date(2025, 8, 2, 8), now, "en")).toBe("Sep 2, 2025");
    expect(formatDayLabel(new Date(2026, 8, 30, 8), now, "en")).toBe("Today");
    expect(formatDuration(120_000, "en")).toBe("2 min");
  });
});
