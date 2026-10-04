// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, useEffect, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api/client.js";
import { RequirementsRealtimeProvider } from "../src/features/requirements/realtime.js";
import { DeferredLocaleNotice } from "../src/i18n/DeferredLocaleNotice.js";
import {
  captureCarry,
  isLocaleRebuilding,
  peekCarried,
  registerCarrySource,
  registerLossCheck,
  resetCarry,
  switchWouldLoseWork,
} from "../src/i18n/carry.js";
import {
  LOCALE_STORAGE_KEY,
  UI_LOCALES,
  applyLocalePreference,
  currentLocale,
  deferredLocalePreference,
  loadLocalePreference,
  resolveUiLocale,
  withLocaleParam,
} from "../src/i18n/locale.js";
import { LocaleBoundary, useCarried, useCarrySource, useLossCheck, useT } from "../src/i18n/provider.js";
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
  vi.useRealTimers();
  Object.defineProperty(navigator, "language", { value: "zh-CN", configurable: true });
  applyLocalePreference("system");
  window.localStorage.clear();
  resetCarry();
  document.body.innerHTML = "";
});

/** 别的标签页改了语言：浏览器只在别的标签页派发 storage 事件，这里手动派发。 */
function otherTabSets(value: string): void {
  window.localStorage.setItem(LOCALE_STORAGE_KEY, value);
  window.dispatchEvent(new StorageEvent("storage", { key: LOCALE_STORAGE_KEY, newValue: value }));
}

describe("界面语言偏好", () => {
  it("中英两种界面都已开放；跟随系统时浏览器语言以 zh 开头用中文，其他用英文；固定语言照用", () => {
    expect(UI_LOCALES).toEqual(["zh-CN", "en"]);
    Object.defineProperty(navigator, "language", { value: "en-US", configurable: true });
    expect(resolveUiLocale("system")).toBe("en");
    expect(resolveUiLocale("en")).toBe("en");
    expect(resolveUiLocale("zh-CN")).toBe("zh-CN");
    Object.defineProperty(navigator, "language", { value: "fr-FR", configurable: true });
    expect(resolveUiLocale("system")).toBe("en");
    Object.defineProperty(navigator, "language", { value: "zh-TW", configurable: true });
    expect(resolveUiLocale("system")).toBe("zh-CN");
    Object.defineProperty(navigator, "language", { value: "", configurable: true });
    expect(resolveUiLocale("system")).toBe("zh-CN");
  });

  it("没手动选过语言、浏览器是英文：启动后就是英文界面，<html lang> 为 en", () => {
    Object.defineProperty(navigator, "language", { value: "en-GB", configurable: true });
    applyLocalePreference(loadLocalePreference());
    expect(currentLocale()).toBe("en");
    expect(document.documentElement.lang).toBe("en");
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

describe("渲染前的 theme-init.js 写 <html lang>", () => {
  const source = readFileSync(resolve(import.meta.dirname, "../public/assets/theme-init.js"), "utf8");
  const run = (stored: string | null, browser: string): string | null => {
    window.localStorage.clear();
    if (stored !== null) window.localStorage.setItem(LOCALE_STORAGE_KEY, stored);
    Object.defineProperty(navigator, "language", { value: browser, configurable: true });
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    document.documentElement.removeAttribute("lang");
    new Function(source)();
    return document.documentElement.getAttribute("lang");
  };

  it("与 resolveUiLocale 一致：固定了就用，跟随系统（或没选过、坏值）看浏览器语言", () => {
    const cases: [string | null, string][] = [
      ["zh-CN", "en-US"],
      ["en", "zh-CN"],
      ["system", "en-US"],
      ["system", "zh-CN"],
      [null, "en-US"],
      [null, "zh-TW"],
      [null, "zh"],
      ["fr", "de-DE"],
      [null, ""],
    ];
    for (const [stored, browser] of cases) {
      const lang = run(stored, browser);
      Object.defineProperty(navigator, "language", { value: browser, configurable: true });
      expect([stored, browser, lang]).toEqual([stored, browser, resolveUiLocale(loadLocalePreference())]);
    }
    expect(run(null, "en-US")).toBe("en");
    expect(run(null, "zh-HK")).toBe("zh-CN");
  });

  it("读不到存储（隐私模式等）时主题回到默认，语言照样按浏览器语言写", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    try {
      expect(run(null, "en-US")).toBe("en");
      expect(document.documentElement.getAttribute("data-theme")).toBe("light");
      expect(run(null, "zh-CN")).toBe("zh-CN");
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe("事件流地址带上界面语言", () => {
  it("withLocaleParam 按当前语言拼参数，已有查询参数时接在后面", () => {
    expect(withLocaleParam("/api/v2/events")).toBe("/api/v2/events?locale=zh-CN");
    applyLocalePreference("en");
    expect(withLocaleParam("/api/v1/sessions/s1/events?after=12")).toBe("/api/v1/sessions/s1/events?after=12&locale=en");
  });

  it("需求推送流与 Codex 状态流的地址按调用时的语言生成", () => {
    expect(api.requirementsEventsUrl()).toBe("/api/v2/events?locale=zh-CN");
    expect(api.codexStatusUrl()).toBe("/api/v1/codex/status?locale=zh-CN");
    applyLocalePreference("en");
    expect(api.requirementsEventsUrl()).toBe("/api/v2/events?locale=en");
    expect(api.codexStatusUrl()).toBe("/api/v1/codex/status?locale=en");
  });

  it("需求推送流：语言变了就按新语言重连（不靠外壳重建）", async () => {
    const urls: string[] = [];
    const closed: string[] = [];
    class FakeEventSource {
      onopen: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onmessage: ((event: MessageEvent<string>) => void) | null = null;
      constructor(readonly url: string) {
        urls.push(url);
      }
      addEventListener(): void {}
      close(): void {
        closed.push(this.url);
      }
    }
    vi.stubGlobal("EventSource", FakeEventSource);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root?.render(
        <QueryClientProvider client={new QueryClient()}>
          <RequirementsRealtimeProvider enabled>
            <span />
          </RequirementsRealtimeProvider>
        </QueryClientProvider>,
      ),
    );
    expect(urls).toEqual(["/api/v2/events?locale=zh-CN"]);
    await act(async () => applyLocalePreference("en"));
    expect(closed).toEqual(["/api/v2/events?locale=zh-CN"]);
    expect(urls).toEqual(["/api/v2/events?locale=zh-CN", "/api/v2/events?locale=en"]);
  });
});

describe("切换语言带过重建的状态（i18n/carry.ts）", () => {
  it("界面语言真的变了才拍快照；拍下的按 key 读回，读回后删掉", () => {
    let value = "草稿 1";
    const unregister = registerCarrySource("k", () => value);
    applyLocalePreference("zh-CN");
    expect(peekCarried("k")).toBeUndefined();
    applyLocalePreference("en");
    value = "草稿 2";
    expect(peekCarried("k")).toBe("草稿 1");
    unregister();
    captureCarry();
    expect(peekCarried("k")).toBeUndefined();
  });

  it("组件用 useCarrySource 登记、重建后 useCarried 读回：输入的字不丢", async () => {
    function Draft() {
      const carried = useCarried<string>("draft");
      const [text, setText] = useState(carried ?? "");
      useCarrySource("draft", () => text);
      const t = useT();
      return (
        <label>
          {t.common.localeOption.system}
          <input data-testid="draft" value={text} onChange={(event) => setText(event.target.value)} />
        </label>
      );
    }
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root?.render(
        <QueryClientProvider client={new QueryClient()}>
          <LocaleBoundary>
            <Draft />
          </LocaleBoundary>
        </QueryClientProvider>,
      ),
    );
    const input = () => container?.querySelector<HTMLInputElement>("[data-testid='draft']") ?? null;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    await act(async () => {
      setter?.call(input(), "还没发出去的字");
      input()?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const before = input();
    await act(async () => applyLocalePreference("en"));
    expect(container.textContent).toBe("Follow system");
    expect(input()).not.toBe(before);
    expect(input()?.value).toBe("还没发出去的字");
    // 读回后就删掉：以后正常挂载不会冒出旧草稿。
    expect(peekCarried("draft")).toBeUndefined();
  });

  it("重建结束时没被读走的快照一并丢掉，以后正常挂载不会冒出旧状态", async () => {
    registerCarrySource("nobody-reads-this", () => "旧的");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root?.render(
        <QueryClientProvider client={new QueryClient()}>
          <LocaleBoundary>
            <span />
          </LocaleBoundary>
        </QueryClientProvider>,
      ),
    );
    await act(async () => applyLocalePreference("en"));
    expect(peekCarried("nobody-reads-this")).toBeUndefined();
  });

  it("「正在重建」只在挂着 LocaleBoundary 时成立，新界面挂好后清掉", async () => {
    applyLocalePreference("en");
    expect(isLocaleRebuilding()).toBe(false);
    applyLocalePreference("system");

    let seenDuringUnmount: boolean | null = null;
    function Watcher() {
      useEffect(() => () => {
        seenDuringUnmount = isLocaleRebuilding();
      }, []);
      return null;
    }
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () =>
      root?.render(
        <QueryClientProvider client={new QueryClient()}>
          <LocaleBoundary>
            <Watcher />
          </LocaleBoundary>
        </QueryClientProvider>,
      ),
    );
    await act(async () => applyLocalePreference("en"));
    expect(seenDuringUnmount).toBe(true);
    expect(isLocaleRebuilding()).toBe(false);
  });

  it("保不住的：登记的检查与打开的对话框都算", async () => {
    expect(switchWouldLoseWork()).toBe(false);
    let dirty = true;
    const unregister = registerLossCheck(() => dirty);
    expect(switchWouldLoseWork()).toBe(true);
    dirty = false;
    expect(switchWouldLoseWork()).toBe(false);
    unregister();

    const dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("data-state", "open");
    document.body.append(dialog);
    expect(switchWouldLoseWork()).toBe(true);
    dialog.setAttribute("data-state", "closed");
    expect(switchWouldLoseWork()).toBe(false);

    function Editing({ active }: { active: boolean }) {
      useLossCheck(active);
      return null;
    }
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(<Editing active />));
    expect(switchWouldLoseWork()).toBe(true);
    await act(async () => root?.render(<Editing active={false} />));
    expect(switchWouldLoseWork()).toBe(false);
    await act(async () => root?.render(<Editing active />));
    await act(async () => root?.render(<span />));
    expect(switchWouldLoseWork()).toBe(false);
  });
});

describe("别的标签页切换语言", () => {
  it("这里没有带不过去的东西：立即跟着切", () => {
    otherTabSets("en");
    expect(currentLocale()).toBe("en");
    expect(deferredLocalePreference()).toBeNull();
  });

  it("这里开着对话框或有没保存的表单：先不切，处理完再切", () => {
    vi.useFakeTimers();
    let dirty = true;
    registerLossCheck(() => dirty);
    otherTabSets("en");
    expect(currentLocale()).toBe("zh-CN");
    expect(document.documentElement.lang).toBe("zh-CN");
    expect(deferredLocalePreference()).toBe("en");

    vi.advanceTimersByTime(3_000);
    expect(currentLocale()).toBe("zh-CN");

    dirty = false;
    vi.advanceTimersByTime(1_000);
    expect(currentLocale()).toBe("en");
    expect(document.documentElement.lang).toBe("en");
    expect(deferredLocalePreference()).toBeNull();
  });

  it("等待期间又改回原来的语言，或在这里自己选了语言：不再按旧的那次切", () => {
    vi.useFakeTimers();
    let dirty = true;
    registerLossCheck(() => dirty);
    otherTabSets("en");
    expect(deferredLocalePreference()).toBe("en");
    otherTabSets("system");
    expect(deferredLocalePreference()).toBeNull();
    expect(currentLocale()).toBe("zh-CN");

    otherTabSets("en");
    applyLocalePreference("zh-CN");
    dirty = false;
    vi.advanceTimersByTime(2_000);
    expect(currentLocale()).toBe("zh-CN");
    expect(deferredLocalePreference()).toBeNull();
  });

  it("界面语言不变的偏好变化（跟随系统 ↔ 简体中文，系统是中文）不用等", () => {
    registerLossCheck(() => true);
    otherTabSets("zh-CN");
    expect(deferredLocalePreference()).toBeNull();
    expect(currentLocale()).toBe("zh-CN");
  });
});

describe("别的标签页切换、这里先不跟时的提示", () => {
  async function renderNotice(): Promise<HTMLDivElement> {
    const node = document.createElement("div");
    document.body.append(node);
    container = node;
    root = createRoot(node);
    await act(async () =>
      root?.render(
        <QueryClientProvider client={new QueryClient()}>
          <LocaleBoundary>
            <DeferredLocaleNotice />
          </LocaleBoundary>
        </QueryClientProvider>,
      ),
    );
    return node;
  }
  const notice = () => document.querySelector<HTMLElement>("[data-testid='locale-deferred-notice']");

  it("先不跟时显示不打断的提示；处理完自动切过去，提示消失", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    await renderNotice();
    expect(notice()).toBeNull();
    let dirty = true;
    registerLossCheck(() => dirty);
    await act(async () => otherTabSets("en"));
    expect(notice()?.getAttribute("role")).toBe("status");
    expect(notice()?.textContent).toContain(
      "另一个标签页把语言改成了 English。这里还有打开的对话框、没保存的编辑或正在发送的内容，处理完后会自动切换。",
    );
    expect(notice()?.textContent).toContain("现在切换");

    dirty = false;
    await act(async () => vi.advanceTimersByTime(1_000));
    expect(currentLocale()).toBe("en");
    expect(notice()).toBeNull();
  });

  it("「现在切换」先确认：取消仍在等，确认后马上切", async () => {
    await renderNotice();
    registerLossCheck(() => true);
    await act(async () => otherTabSets("en"));
    await act(async () => document.querySelector<HTMLElement>("[data-testid='locale-deferred-switch']")?.click());
    const dialog = () => document.querySelector<HTMLElement>("[data-testid='confirm-dialog']");
    expect(dialog()?.textContent).toContain("切换语言？");
    const button = (label: string) => [...(dialog()?.querySelectorAll("button") ?? [])].find((item) => item.textContent === label);

    await act(async () => button("取消")?.click());
    expect(dialog()).toBeNull();
    expect(currentLocale()).toBe("zh-CN");
    expect(deferredLocalePreference()).toBe("en");

    await act(async () => document.querySelector<HTMLElement>("[data-testid='locale-deferred-switch']")?.click());
    await act(async () => button("切换语言")?.click());
    expect(currentLocale()).toBe("en");
    expect(deferredLocalePreference()).toBeNull();
    expect(notice()).toBeNull();
  });

  it("等待期间别的标签页又改回原来的语言：提示消失，不切", async () => {
    await renderNotice();
    registerLossCheck(() => true);
    await act(async () => otherTabSets("en"));
    expect(notice()).not.toBeNull();
    await act(async () => otherTabSets("system"));
    expect(notice()).toBeNull();
    expect(currentLocale()).toBe("zh-CN");
  });
});
