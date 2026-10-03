// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api/client.js";
import { AppRoot } from "../src/app/AppRoot.js";
import { shortcutGroups } from "../src/app/shortcuts.js";
import { setCommandPaletteOpen } from "../src/app/shell/shell-actions.js";
import { applyLocalePreference } from "../src/i18n/locale.js";
import { messagesFor } from "../src/i18n/messages/index.js";

vi.mock("../src/features/my-work/MyWorkPage.js", () => ({
  MyWorkPage: () => <h1>My work page</h1>,
  validateMyWorkSearch: () => ({}),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CJK = /[\u3000-\u303f\u3400-\u9fff\uf900-\ufaff\uff00-\uffef]/;
const user = { id: "u1", loginName: "sue", displayName: "Sue", createdAt: "2026-08-25T00:00:00.000Z" };
const project = {
  id: "p1",
  name: "Checkout",
  isArchived: false,
  createdBy: { id: "u1", displayName: "Sue" },
  updatedBy: { id: "u1", displayName: "Sue" },
  createdAt: "2026-08-25T00:00:00.000Z",
  updatedAt: "2026-08-25T00:00:00.000Z",
  version: 1,
};

let root: Root | null = null;
let container: HTMLDivElement | null = null;
const proto = Element.prototype as { scrollIntoView?: () => void };

beforeEach(() => {
  applyLocalePreference("en");
  // 命令面板（cmdk）把选中项滚进视野；jsdom 没有这个方法。
  proto.scrollIntoView = () => undefined;
  vi.stubGlobal(
    "EventSource",
    class {
      onopen = null;
      onerror = null;
      onmessage = null;
      close = vi.fn();
    },
  );
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      if (input === "/api/v2/requirements/settings") {
        return new Response(
          JSON.stringify({
            configured: true,
            baseUrl: "http://r.test",
            session: { user, expiresAt: "2099-01-01T00:00:00.000Z" },
            mappingCount: 1,
          }),
        );
      }
      if (input === "/api/v2/projects?includeArchived=true") return new Response(JSON.stringify({ items: [project], nextCursor: null }));
      return new Response(JSON.stringify({ code: "NOT_FOUND", message: "x" }), { status: 404 });
    }),
  );
  vi.spyOn(api, "getMyWorkbench").mockResolvedValue({
    actions: { status: "ready", data: [] },
    requirements: { status: "ready", data: [] },
    sessions: { status: "ready", data: [] },
  });
  vi.spyOn(api, "listAllSessions").mockResolvedValue({ items: [], nextCursor: null });
  vi.spyOn(api, "listProjectRooms").mockResolvedValue({ items: [] });
  vi.spyOn(api, "listRequirements").mockResolvedValue({ items: [], nextCursor: null });
  localStorage.setItem("suduo.sidebar.collapsed", "false");
});

afterEach(async () => {
  setCommandPaletteOpen(false);
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  delete proto.scrollIntoView;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
  applyLocalePreference("system");
  localStorage.clear();
});

async function settle(rounds = 10): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function renderApp(path: string): Promise<HTMLDivElement> {
  window.history.replaceState({}, "", path);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(<AppRoot />));
  await settle();
  return container;
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

describe("应用外壳：英文界面", () => {
  it("侧栏导航用英文", async () => {
    const node = await renderApp("/my");
    const nav = node.querySelector('[data-testid="app-nav"]');
    expect(nav?.getAttribute("aria-label")).toBe("Main navigation");
    expect([...(nav?.querySelectorAll("a") ?? [])].map((link) => link.textContent)).toEqual([
      "My work",
      "Requirements",
      "Rooms",
      "Sessions",
      "Overview",
      "Settings",
    ]);
    expect(nav?.textContent).toContain("Search…");
    expect(nav?.querySelector('[data-testid="project-switcher"]')?.getAttribute("aria-label")).toBe("Switch project: Checkout");
    expect(nav?.querySelector('button[aria-label="Collapse sidebar"]')).not.toBeNull();
    expect(nav?.textContent).not.toMatch(CJK);
  });

  it("「?」打开的快捷键一览用英文", async () => {
    await renderApp("/my");
    await act(async () => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "?", bubbles: true })));
    const dialog = document.querySelector('[data-testid="shortcuts-dialog"]');
    expect(dialog?.textContent).toContain("Keyboard shortcuts");
    const groups = shortcutGroups(messagesFor("en"));
    expect(groups.map((group) => group.title)).toEqual([
      "General",
      "Requirements",
      "Writing requirements",
      "Session composer",
      "Sessions",
      "Settings",
    ]);
    for (const group of groups) {
      expect(dialog?.querySelector(`section[aria-label="${group.title}"]`), group.title).not.toBeNull();
      for (const item of group.items) expect(dialog?.textContent).toContain(item.description);
    }
    expect(dialog?.textContent).not.toMatch(CJK);
  });

  it("命令面板用英文显示，中文、英文关键词都能搜到同一条命令", async () => {
    await renderApp("/my");
    await act(async () => setCommandPaletteOpen(true));
    await settle(2);
    const input = document.querySelector<HTMLInputElement>("[cmdk-input]");
    expect(input?.placeholder).toBe("Search requirements (title or number), pages, and commands");

    const visible = () => [...document.querySelectorAll<HTMLElement>("[cmdk-item]")].map((item) => item.textContent ?? "");
    expect(visible()).toContain("Settings");
    expect(visible().join("")).not.toMatch(CJK);

    for (const query of ["settings", "设置"]) {
      await act(async () => setInputValue(input!, query));
      await settle(2);
      expect(visible(), query).toContain("Settings");
      expect(visible(), query).not.toContain("My work");
    }

    for (const query of ["dark theme", "深色主题"]) {
      await act(async () => setInputValue(input!, query));
      await settle(2);
      expect(visible(), query).toContain("Switch to dark theme");
      expect(visible(), query).not.toContain("Settings");
    }
  });
});
