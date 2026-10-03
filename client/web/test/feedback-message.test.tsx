// @vitest-environment jsdom

import { vi, describe, expect, it, beforeEach } from "vitest";

const mocks = vi.hoisted(() => {
  const toast = vi.fn();
  return { toast, success: vi.fn(), error: vi.fn(), warning: vi.fn() };
});

vi.mock("sonner", () => ({
  toast: Object.assign(mocks.toast, { success: mocks.success, error: mocks.error, warning: mocks.warning }),
  Toaster: () => null,
}));

import { reportFailure } from "../src/feedback/report.js";
import { GLOBAL_ERROR_TOAST_DURATION_MS } from "../src/feedback/routes.js";
import { showMessage } from "../src/ui/message.js";

describe("showMessage", () => {
  beforeEach(() => {
    mocks.toast.mockClear();
    mocks.success.mockClear();
    mocks.error.mockClear();
    mocks.warning.mockClear();
  });

  it("任意消息档位都输出稳定语义属性，且复现 3a 成功路径", () => {
    showMessage("信息", "info");
    showMessage("已保存", "success", { id: "save" });
    showMessage("注意", "warning");
    const successContent = mocks.success.mock.calls[0]?.[0] as { props: Record<string, unknown> };
    expect(successContent.props["data-testid"]).toBe("global-message");
    expect(successContent.props).toMatchObject({
      "data-feedback-kind": "success",
      "data-feedback-result": "global",
    });
    expect(mocks.success.mock.calls[0]?.[1]).toMatchObject({ id: "save", duration: 5_000 });
    expect(successContent.props["role"]).toBeUndefined();

    showMessage(<button type="button">重试</button>, "error");
    const errorContent = mocks.error.mock.calls[0]?.[0] as { props: { children: unknown; role?: string } };
    expect(errorContent.props.children).toBeTruthy();
    // 错误提示在 sonner 的 polite 区域内以 role=alert 打断读屏
    expect(errorContent.props.role).toBe("alert");
    expect(mocks.error.mock.calls[0]?.[1]).toMatchObject({ duration: GLOBAL_ERROR_TOAST_DURATION_MS });
    const contents = [
      ["info", mocks.toast.mock.calls[0]?.[0]],
      ["success", successContent],
      ["warning", mocks.warning.mock.calls[0]?.[0]],
      ["error", errorContent],
    ] as const;
    for (const [kind, content] of contents) {
      expect((content as { props: Record<string, unknown> }).props).toMatchObject({
        "data-feedback-kind": kind,
        "data-feedback-result": "global",
      });
    }
  });

  it("409 VERSION_CONFLICT 可按 pr8 所需的语义属性定位", () => {
    reportFailure({ status: 409, code: "VERSION_CONFLICT" }, { surface: "action" });
    const content = mocks.error.mock.calls[0]?.[0] as { props: Record<string, unknown> };
    expect(content.props).toMatchObject({
      "data-feedback-kind": "version_conflict",
      "data-feedback-result": "global",
    });
  });
});
