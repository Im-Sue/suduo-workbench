// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../src/api/client.js";
import { AppRoot } from "../src/app/AppRoot.js";
import { keyLabel, shortcutGroups } from "../src/app/shortcuts.js";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  window.history.replaceState({}, "", "/");
  localStorage.clear();
});

/** 一览里的键名 → 源码里按键判断的写法（在该条登记的源文件里命中即可；不扫清单本身）。 */
const HANDLER_PATTERNS: Record<string, RegExp> = {
  K: /(key|toLowerCase\(\)) (===|!==) "k"/,
  J: /(key|toLowerCase\(\)) (===|!==) "j"/,
  B: /toLowerCase\(\) (===|!==) "b"/,
  S: /toLowerCase\(\) === "s"/,
  C: /key === "c"/,
  "\\": /key === "\\\\"/,
  "/": /key (===|!==) "\/"/,
  "?": /key === "\?"/,
  "↓": /"ArrowDown"/,
  "↑": /"ArrowUp"/,
  "←": /"ArrowLeft"/,
  "→": /"ArrowRight"/,
  Esc: /"Escape"/,
  Enter: /"Enter"/,
  Tab: /"Tab"/,
  "1": /\[1-7\]/,
  "7": /\[1-7\]/,
};

describe("快捷键一览", () => {
  it("一览里的每个键都能在它登记的源文件里找到对应的按键处理", () => {
    const missing: string[] = [];
    for (const group of shortcutGroups()) {
      for (const item of group.items) {
        expect(item.sources.length, item.description).toBeGreaterThan(0);
        const code = item.sources.map((file) => readFileSync(join(__dirname, "../src", file), "utf8")).join("\n");
        for (const combo of item.keys) {
          for (const key of combo) {
            if (key === "mod" || key === "Shift" || key === "…") continue;
            const pattern = HANDLER_PATTERNS[key];
            if (pattern === undefined || !pattern.test(code)) missing.push(`${group.title} · ${item.description} · ${key}`);
          }
        }
      }
    }
    expect(missing).toEqual([]);
  });

  it("按平台显示修饰键", () => {
    expect(keyLabel("mod", true)).toBe("⌘");
    expect(keyLabel("mod", false)).toBe("Ctrl");
    expect(keyLabel("Enter", true)).toBe("⏎");
  });

  it("「?」打开一览；在输入框里按不会打开", async () => {
    vi.stubGlobal(
      "EventSource",
      class {
        onopen = null;
        onerror = null;
        onmessage = null;
        close = vi.fn();
      },
    );
    const user = { id: "u1", loginName: "sue", displayName: "Sue", createdAt: "2026-08-25T00:00:00.000Z" };
    vi.stubGlobal("fetch", vi.fn(async (input: string) => {
      if (input === "/api/v2/requirements/settings") {
        return new Response(JSON.stringify({ configured: true, baseUrl: "http://r.test", session: { user, expiresAt: "2099-01-01T00:00:00.000Z" }, mappingCount: 1 }));
      }
      if (input === "/api/v2/projects?includeArchived=true") return new Response(JSON.stringify({ items: [], nextCursor: null }));
      return new Response(JSON.stringify({ code: "NOT_FOUND", message: "x" }), { status: 404 });
    }));
    vi.spyOn(api, "getMyWorkbench").mockResolvedValue({
      actions: { status: "ready", data: [] },
      requirements: { status: "ready", data: [] },
      sessions: { status: "ready", data: [] },
    });
    vi.spyOn(api, "listAllSessions").mockResolvedValue({ items: [], nextCursor: null });
    window.history.replaceState({}, "", "/my");
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    await act(async () => root?.render(<AppRoot />));
    for (let index = 0; index < 10; index += 1) {
      await act(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
      });
    }

    const input = document.createElement("input");
    document.body.append(input);
    input.focus();
    await act(async () => input.dispatchEvent(new KeyboardEvent("keydown", { key: "?", bubbles: true })));
    expect(document.querySelector('[data-testid="shortcuts-dialog"]')).toBeNull();
    input.remove();

    await act(async () => document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "?", bubbles: true })));
    const dialog = document.querySelector('[data-testid="shortcuts-dialog"]');
    expect(dialog?.textContent).toContain("快捷键");
    for (const group of shortcutGroups()) expect(dialog?.textContent).toContain(group.title);
  });
});
