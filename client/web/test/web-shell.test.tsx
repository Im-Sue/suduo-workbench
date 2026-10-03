// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppRoot } from "../src/app/AppRoot.js";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(async () => {
  if (root) {
    await act(async () => root?.unmount());
  }
  container?.remove();
  root = null;
  container = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
  localStorage.clear();
});

async function render(view: ReactNode): Promise<HTMLDivElement> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(view));
  return container;
}

describe("Web 壳层 DOM 设施", () => {
  it("直接打开状态筛选 URL 时只显示目标列，清除后同步 URL 与全列", async () => {
    class SilentEventSource {
      onopen: ((event: Event) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent<string>) => void) | null = null;
      close = vi.fn();
    }
    const user = {
      id: "u1",
      loginName: "sue",
      displayName: "Sue",
      createdAt: "2026-08-25T00:00:00.000Z",
    };
    const project = {
      id: "p1",
      name: "项目一",
      isArchived: false,
      createdBy: { id: user.id, displayName: user.displayName },
      updatedBy: { id: user.id, displayName: user.displayName },
      createdAt: "2026-08-25T00:00:00.000Z",
      updatedAt: "2026-08-25T00:00:00.000Z",
      version: 1,
    };
    vi.stubGlobal("EventSource", SilentEventSource);
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      if (input === "/api/v2/requirements/settings") {
        return new Response(JSON.stringify({
          configured: true,
          baseUrl: "http://requirements.test",
          session: { user, expiresAt: "2026-08-26T00:00:00.000Z" },
          mappingCount: 0,
        }));
      }
      if (input === "/api/v2/projects?includeArchived=true") {
        return new Response(JSON.stringify({ items: [project], nextCursor: null }));
      }
      if (input.startsWith("/api/v2/projects/p1/requirements?")) {
        return new Response(JSON.stringify({ items: [], nextCursor: null }));
      }
      throw new Error(`未预期的请求：${input}`);
    }));
    window.history.replaceState({}, "", "/p/p1/requirements?status=in_development");

    const page = await render(<AppRoot />);
    for (let index = 0; index < 10; index += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }

    expect(page.textContent).toContain("状态：开发中");
    expect(page.querySelectorAll("[data-status-column]")).toHaveLength(1);
    expect(page.querySelector('[data-status-column="in_development"]')).not.toBeNull();
    await act(async () => {
      [...page.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "清除筛选")?.click();
    });
    for (let index = 0; index < 10; index += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }
    expect(window.location.pathname).toBe("/p/p1/requirements");
    expect(window.location.search).toBe("");
    expect(page.querySelectorAll("[data-status-column]")).toHaveLength(7);
  });
});
