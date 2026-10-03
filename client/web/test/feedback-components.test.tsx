// @vitest-environment jsdom

import { act, useRef, useState, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const toastMocks = vi.hoisted(() => {
  const toast = vi.fn();
  return { toast, success: vi.fn(), error: vi.fn() };
});

vi.mock("sonner", () => ({
  toast: Object.assign(toastMocks.toast, { success: toastMocks.success, error: toastMocks.error, warning: vi.fn() }),
  Toaster: () => null,
}));

import {
  ConfirmDialog,
  EmptyState,
  InlineError,
  PageFailure,
  RegionError,
} from "../src/feedback/components/index.js";
import { classifyFailure } from "../src/feedback/classify.js";
import {
  clearPageFeedback,
  getPageFeedbackSnapshot,
  registerAuthExpiredHandler,
} from "../src/feedback/page-store.js";
import { reportFailure } from "../src/feedback/report.js";
import { routeFeedback } from "../src/feedback/routes.js";
import { MessageHost, showMessage } from "../src/ui/message.js";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function render(element: ReactElement): Promise<HTMLDivElement> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(element));
  return container;
}

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  clearPageFeedback();
  vi.restoreAllMocks();
  toastMocks.toast.mockClear();
  toastMocks.success.mockClear();
  toastMocks.error.mockClear();
});

describe("反馈出口组件", () => {
  it("四个故障出口使用同一套 kind + 实际 outlet 属性语义", async () => {
    const regionFailure = classifyFailure({ status: 502, code: "DEPENDENCY_UNAVAILABLE" });
    const pageFailure = classifyFailure({ status: 401, code: "AUTH_INVALID" });
    const pageRoute = routeFeedback(pageFailure, { surface: "page" });
    showMessage("版本冲突", "error", { feedbackKind: "version_conflict" });
    const node = await render(
      <>
        <InlineError kind="validation">字段无效</InlineError>
        <EmptyState action={{ label: "新增映射", onClick: () => undefined }} title="还没有任何映射" />
        <RegionError busy kind={regionFailure.kind} message="依赖服务暂时不可用" onRetry={() => undefined} />
        <PageFailure failure={pageFailure} route={pageRoute} onAction={() => undefined} />
      </>,
    );
    const global = toastMocks.error.mock.calls[0]?.[0] as { props: Record<string, unknown> };
    expect(global.props).toMatchObject({
      "data-feedback-kind": "version_conflict",
      "data-feedback-result": "global",
    });
    const inline = node.querySelector('[data-testid="inline-error"]');
    expect(inline?.getAttribute("data-feedback-kind")).toBe("validation");
    expect(inline?.getAttribute("data-feedback-result")).toBe("field");
    expect(node.querySelector('[data-testid="empty-state"]')).not.toBeNull();
    const region = node.querySelector('[data-testid="region-error"]');
    expect(region?.getAttribute("aria-busy")).toBe("true");
    expect(region?.getAttribute("data-feedback-kind")).toBe("upstream_unavailable");
    expect(region?.getAttribute("data-feedback-result")).toBe("region");
    const page = node.querySelector('[data-testid="page-failure"]');
    expect(page?.getAttribute("data-feedback-kind")).toBe("auth_expired");
    expect(page?.getAttribute("data-feedback-result")).toBe("page");
  });

  it("ConfirmDialog 默认焦点在取消，关闭后归还触发元素", async () => {
    function Harness() {
      const triggerRef = useRef<HTMLButtonElement>(null);
      const [open, setOpen] = useState(true);
      return (
        <>
          <button ref={triggerRef} type="button">删除会话</button>
          <ConfirmDialog
            onConfirm={() => undefined}
            onOpenChange={setOpen}
            open={open}
            title="确认删除？"
            triggerRef={triggerRef}
          />
        </>
      );
    }
    await render(<Harness />);
    const cancel = document.querySelector<HTMLButtonElement>("[data-testid='confirm-dialog'] button");
    expect(cancel?.textContent).toBe("取消");
    expect(document.activeElement).toBe(cancel);
    await act(async () => cancel?.click());
    expect(document.activeElement?.textContent).toBe("删除会话");
  });

  it("未注册去登录 handler 时 page host 禁用动作并在开发期告警", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    reportFailure({ status: 409, code: "AUTH_INVALID" }, { surface: "action" });
    expect(warning).toHaveBeenCalledWith("[feedback] auth-expired handler is not registered");
    await render(<MessageHost />);
    const action = document.querySelector<HTMLButtonElement>("[data-testid='page-failure'] button");
    expect(action?.disabled).toBe(true);
  });

  it("注册去登录 handler 后 PageFailure 的动作可调用", async () => {
    const logout = vi.fn();
    const unregister = registerAuthExpiredHandler(logout);
    reportFailure({ status: 401, code: "AUTH_INVALID" }, { surface: "page" });
    await render(<MessageHost />);
    const action = document.querySelector<HTMLButtonElement>("[data-testid='page-failure'] button");
    await act(async () => action?.click());
    expect(action?.disabled).toBe(false);
    expect(logout).toHaveBeenCalledTimes(1);
    unregister();
  });

  it("先失败、后注册 handler 时 host 会更新为可用的去登录动作", async () => {
    reportFailure({ status: 409, code: "AUTH_INVALID" }, { surface: "action" });
    await render(<MessageHost />);
    const action = document.querySelector<HTMLButtonElement>("[data-testid='page-failure'] button");
    expect(action?.disabled).toBe(true);

    const logout = vi.fn();
    let unregister: (() => void) | undefined;
    await act(async () => {
      unregister = registerAuthExpiredHandler(logout);
    });
    expect(action?.disabled).toBe(false);
    await act(async () => action?.click());
    expect(logout).toHaveBeenCalledTimes(1);
    unregister?.();
  });

  it("page store 的 snapshot 在未变化时保持引用稳定", () => {
    const initial = getPageFeedbackSnapshot();
    expect(getPageFeedbackSnapshot()).toBe(initial);
    const unregister = registerAuthExpiredHandler(() => undefined);
    const registered = getPageFeedbackSnapshot();
    expect(registered).not.toBe(initial);
    expect(getPageFeedbackSnapshot()).toBe(registered);
    unregister();
  });
});
