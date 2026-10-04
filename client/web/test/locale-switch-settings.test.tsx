// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 设置 → 外观 → 语言（中英双语 S9）：英文正式开放后语言行出现、设置搜索中英都能搜到这一行；
 * 切换时这一页上带不过去的东西先确认；设置搜索框里的字带过重建；Codex 状态流按新语言重连。
 */

const apiMocks = vi.hoisted(() => ({
  codexModels: vi.fn(),
  codexStatusUrl: vi.fn(),
  getSettings: vi.fn(),
  listMcpServers: vi.fn(),
  listRequirementsMappingsVerified: vi.fn(),
  modelProvider: vi.fn(),
  requirementsSettings: vi.fn(),
}));

vi.mock("../src/api/client.js", () => ({ api: apiMocks }));
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn() }),
  Toaster: () => null,
}));

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useParams,
  type AnyRouter,
} from "@tanstack/react-router";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { SettingsPage } from "../src/features/settings/SettingsPage.js";
import { searchSettings, SETTINGS_SEARCH_INDEX, type SettingsSectionId } from "../src/features/settings/sections.js";
import { registerLossCheck, resetCarry } from "../src/i18n/carry.js";
import { LOCALE_STORAGE_KEY, applyLocalePreference, currentLocale, withLocaleParam } from "../src/i18n/locale.js";
import { messagesFor } from "../src/i18n/messages/index.js";
import { LocaleBoundary } from "../src/i18n/provider.js";
import {
  buttonByText,
  click,
  localSettings,
  MockEventSource,
  modelProviderSettings,
  requirementsSettings,
  setInputValue,
  settle,
} from "./settings-harness.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class TrackingEventSource extends MockEventSource {
  closed = false;
  override close(): void {
    this.closed = true;
  }
}

let root: Root | null = null;
let node: HTMLDivElement | null = null;
let router: AnyRouter | null = null;

function SectionRoute() {
  const { section } = useParams({ strict: false }) as { section: string };
  return <SettingsPage section={section as SettingsSectionId} />;
}

/** 与 settings-harness 的 renderSettings 相同，只是外面套上 LocaleBoundary（切换语言时整棵重建，与真实应用一致）。 */
async function open(path: string): Promise<HTMLDivElement> {
  const rootRoute = createRootRoute({ component: () => <Outlet /> });
  const routeTree = rootRoute.addChildren([
    createRoute({ getParentRoute: () => rootRoute, path: "/settings/$section", component: SectionRoute }),
  ]);
  router = createRouter({ routeTree, history: createMemoryHistory({ initialEntries: [path] }) });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
  const current = router;
  await act(async () =>
    root?.render(
      <QueryClientProvider client={queryClient}>
        <LocaleBoundary>
          <RouterProvider router={current} />
        </LocaleBoundary>
      </QueryClientProvider>,
    ),
  );
  await settle();
  return node;
}

const localeRow = (scope: ParentNode) => scope.querySelector('[data-setting-row="locale"]');
const localeOption = (scope: ParentNode, label: string) =>
  [...(scope.querySelector('[data-testid="settings-locale"]')?.querySelectorAll("button") ?? [])].find(
    (button) => button.textContent === label,
  );

beforeEach(() => {
  localStorage.clear();
  apiMocks.codexModels.mockResolvedValue({ models: [], items: [] });
  apiMocks.codexStatusUrl.mockImplementation(() => withLocaleParam("/api/v1/codex/status"));
  apiMocks.getSettings.mockResolvedValue(localSettings());
  apiMocks.listMcpServers.mockResolvedValue({ items: [], statusAvailable: true });
  apiMocks.listRequirementsMappingsVerified.mockResolvedValue({ items: [] });
  apiMocks.modelProvider.mockResolvedValue(modelProviderSettings());
  apiMocks.requirementsSettings.mockResolvedValue(requirementsSettings());
  MockEventSource.instances = [];
  vi.stubGlobal("EventSource", TrackingEventSource);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  node?.remove();
  root = null;
  node = null;
  router = null;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  document.body.innerHTML = "";
  applyLocalePreference("system");
  localStorage.clear();
  resetCarry();
});

describe("设置搜索里的语言行", () => {
  it("索引里有这一行；中英关键词都能搜到，标题按当前语言、与页面上的行标题一致", () => {
    expect(SETTINGS_SEARCH_INDEX).toContainEqual({ section: "appearance", anchor: "locale", key: "locale" });
    for (const query of ["语言", "界面语言", "英文", "中文", "English", "language", "locale"]) {
      expect(searchSettings(query).map((item) => item.anchor), query).toContain("locale");
    }
    expect(searchSettings("语言").find((item) => item.anchor === "locale")?.title).toBe("语言");
    applyLocalePreference("en");
    expect(searchSettings("语言").find((item) => item.anchor === "locale")?.title).toBe("Language");
    expect(messagesFor("en").settings.search.locale.title).toBe(messagesFor("en").settingsAgent.appearance.locale.title);
    expect(messagesFor("zh-CN").settings.search.locale.title).toBe(messagesFor("zh-CN").settingsAgent.appearance.locale.title);
  });
});

describe("外观 · 语言", () => {
  it("中文界面下出现语言行：跟随系统 / 简体中文 / English，说明「跟随系统」怎么选语言；选 English 立即切换", async () => {
    const page = await open("/settings/appearance");
    expect(localeRow(page)?.textContent).toContain("语言");
    expect(localeRow(page)?.textContent).toContain("选「跟随系统」时，浏览器语言是中文就显示中文，其他语言显示英文。");
    const options = [...(page.querySelector('[data-testid="settings-locale"]')?.querySelectorAll("button") ?? [])];
    expect(options.map((option) => option.textContent)).toEqual(["跟随系统", "简体中文", "English"]);

    await click(localeOption(page, "English"));
    expect(document.querySelector('[data-testid="confirm-dialog"]')).toBeNull();
    expect(currentLocale()).toBe("en");
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("en");
    expect(document.documentElement.lang).toBe("en");
    expect(localeRow(page)?.textContent).toContain("“Follow system” shows Chinese if your browser language is Chinese, and English otherwise.");
    expect([...(page.querySelector('[data-testid="settings-locale"]')?.querySelectorAll("button") ?? [])].map((option) => option.textContent)).toEqual([
      "Follow system",
      "简体中文",
      "English",
    ]);

    await click(localeOption(page, "简体中文"));
    expect(currentLocale()).toBe("zh-CN");
    expect(localeRow(page)?.textContent).toContain("语言");
  });

  it("这一页上有带不过去的东西时先确认：取消就不切；确认后切换", async () => {
    const page = await open("/settings/appearance");
    registerLossCheck(() => true);

    await click(localeOption(page, "English"));
    const dialog = document.querySelector<HTMLElement>('[data-testid="confirm-dialog"]');
    expect(dialog?.textContent).toContain("切换语言？");
    expect(dialog?.textContent).toContain("这一页上打开的对话框和还没保存的编辑会丢失");
    expect(currentLocale()).toBe("zh-CN");

    await click(buttonByText(dialog ?? document, "取消"));
    expect(document.querySelector('[data-testid="confirm-dialog"]')).toBeNull();
    expect(currentLocale()).toBe("zh-CN");
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBeNull();

    await click(localeOption(page, "English"));
    await click(buttonByText(document.querySelector<HTMLElement>('[data-testid="confirm-dialog"]') ?? document, "切换语言"));
    expect(currentLocale()).toBe("en");
    expect(localeRow(page)?.textContent).toContain("Language");
  });

  it("界面语言不变的切换（系统是中文时 跟随系统 → 简体中文）不用确认", async () => {
    const page = await open("/settings/appearance");
    registerLossCheck(() => true);
    await click(localeOption(page, "简体中文"));
    expect(document.querySelector('[data-testid="confirm-dialog"]')).toBeNull();
    expect(localStorage.getItem(LOCALE_STORAGE_KEY)).toBe("zh-CN");
  });

  it("设置搜索框里的字带过重建：搜「语言」找到这一行，切换后搜索结果还在、按英文显示", async () => {
    const page = await open("/settings/appearance");
    const search = () => page.querySelector<HTMLInputElement>('input[type="search"]');
    await act(async () => setInputValue(search(), "语言"));
    await settle(2);
    const result = () => [...page.querySelectorAll<HTMLAnchorElement>("a[data-settings-nav]")].map((link) => link.textContent);
    expect(result().some((text) => text?.startsWith("语言"))).toBe(true);

    const before = search();
    await click(localeOption(page, "English"));
    expect(search()).not.toBe(before);
    expect(search()?.value).toBe("语言");
    expect(result().some((text) => text?.startsWith("Language"))).toBe(true);
  });

  it("切换后焦点回到语言控件当前选中的一项（点选与确认框两条路）", async () => {
    const page = await open("/settings/appearance");
    await click(localeOption(page, "English"));
    const focused = document.activeElement as HTMLElement | null;
    expect(focused?.textContent).toBe("English");
    expect(page.querySelector('[data-testid="settings-locale"]')?.contains(focused)).toBe(true);

    registerLossCheck(() => true);
    await click(localeOption(page, "简体中文"));
    await click(buttonByText(document.querySelector<HTMLElement>('[data-testid="confirm-dialog"]') ?? document, "Switch language"));
    expect(currentLocale()).toBe("zh-CN");
    expect((document.activeElement as HTMLElement | null)?.textContent).toBe("简体中文");
  });

  it("切换后停在原来的滚动位置，不回到顶部", async () => {
    const tops = new WeakMap<Element, number>();
    vi.spyOn(Element.prototype, "scrollTop", "get").mockImplementation(function (this: Element) {
      return tops.get(this) ?? 0;
    });
    vi.spyOn(Element.prototype, "scrollTop", "set").mockImplementation(function (this: Element, value: number) {
      tops.set(this, value);
    });
    const scrollTo = vi.fn(function (this: Element, options: ScrollToOptions) {
      tops.set(this, options.top ?? 0);
    });
    const original = Object.getOwnPropertyDescriptor(Element.prototype, "scrollTo");
    Object.defineProperty(Element.prototype, "scrollTo", { configurable: true, writable: true, value: scrollTo });
    try {
      const page = await open("/settings/appearance");
      const content = () => page.querySelector<HTMLElement>('[data-testid="settings-page"] div.min-h-0.flex-1.overflow-y-auto');
      if (content() === null) throw new Error("content not rendered");
      (content() as HTMLElement).scrollTop = 480;
      const before = content();
      scrollTo.mockClear();

      await click(localeOption(page, "English"));
      expect(content()).not.toBe(before);
      expect(content()?.scrollTop).toBe(480);
      expect(scrollTo).not.toHaveBeenCalled();

      // 之后换分组照常回到顶部。
      await act(async () => {
        await router?.navigate({ to: "/settings/$section", params: { section: "notifications" } });
      });
      await settle(2);
      expect(content()?.scrollTop).toBe(0);
    } finally {
      if (original === undefined) Reflect.deleteProperty(Element.prototype, "scrollTo");
      else Object.defineProperty(Element.prototype, "scrollTo", original);
      vi.restoreAllMocks();
    }
  });

  it("Codex 状态流的地址带语言；切换后旧连接关掉，按新语言重连", async () => {
    const page = await open("/settings/appearance");
    const streams = () => MockEventSource.instances as TrackingEventSource[];
    expect(streams().map((stream) => stream.url)).toEqual(["/api/v1/codex/status?locale=zh-CN"]);
    await click(localeOption(page, "English"));
    expect(streams()[0]?.closed).toBe(true);
    expect(streams().filter((stream) => !stream.closed).map((stream) => stream.url)).toEqual(["/api/v1/codex/status?locale=en"]);
  });
});
