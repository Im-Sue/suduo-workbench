// @vitest-environment jsdom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfirmDialog, PageFailure } from "../src/feedback/components/index.js";
import { classifyFailure } from "../src/feedback/classify.js";
import { routeFeedback } from "../src/feedback/routes.js";
import { applyLocalePreference } from "../src/i18n/locale.js";
import { Markdown } from "../src/ui/markdown.js";
import { sessionStatusLabel } from "../src/ui/session-status.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function render(element: ReactElement): Promise<HTMLDivElement> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(element));
  return container;
}

beforeEach(() => {
  applyLocalePreference("en");
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  applyLocalePreference("system");
  window.localStorage.clear();
});

describe("英文界面：反馈与通用组件", () => {
  it("连不上本机服务时的兜底提示", () => {
    const failure = classifyFailure(new TypeError("Failed to fetch"));
    expect(failure.kind).toBe("transport_unknown");
    expect(failure.message).toBe("Can't reach SuDuo right now. Try again later.");
  });

  it("登录过期的失败页", async () => {
    const failure = classifyFailure({ status: 401, error: { code: "AUTH_REQUIRED", message: "x" } });
    const node = await render(
      <PageFailure failure={failure} route={routeFeedback(failure, { surface: "page" })} onAction={() => undefined} />,
    );
    expect(node.textContent).toContain("Sign-in expired");
    expect(node.querySelector("button")?.textContent).toBe("Sign in");
  });

  it("确认对话框的默认按钮", async () => {
    await render(
      <ConfirmDialog open onOpenChange={() => undefined} title="Delete session?" onConfirm={() => undefined} />,
    );
    const buttons = [...document.querySelectorAll("[data-testid='confirm-dialog'] button")].map((button) => button.textContent);
    expect(buttons).toEqual(["Cancel", "Confirm"]);
  });

  it("会话状态名与代码块按钮", async () => {
    expect(sessionStatusLabel("approval")).toBe("Waiting for you");
    const node = await render(<Markdown text={"```ts\nconst a = 1;\n```"} />);
    expect(node.querySelector(".md-code-bar")?.textContent).toBe("CodeCopy");
  });
});
