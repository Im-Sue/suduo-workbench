// @vitest-environment jsdom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAttentionSignals } from "../src/features/sessions/attention.js";
import type { SessionUiStatus } from "../src/ui/session-status.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let hidden = false;

function Probe({ status }: { status: SessionUiStatus }) {
  useAttentionSignals(status, "订单导出");
  return null;
}

async function show(element: ReactElement) {
  root ??= createRoot(document.body.appendChild(document.createElement("div")));
  await act(async () => root?.render(element));
}

beforeEach(() => {
  hidden = false;
  Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
  document.title = "SuDuo";
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  window.localStorage.clear();
  vi.unstubAllGlobals();
});

describe("会话完成提醒", () => {
  it("页面在后台时，运行中 → 已完成：标题加前缀；回到页面后去掉", async () => {
    await show(<Probe status="running" />);
    hidden = true;
    await show(<Probe status="completed" />);
    expect(document.title).toBe("✓ 已完成 · SuDuo");
    hidden = false;
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(document.title).toBe("SuDuo");
  });

  it("页面在前台时不打扰", async () => {
    await show(<Probe status="running" />);
    await show(<Probe status="completed" />);
    expect(document.title).toBe("SuDuo");
  });

  it("开了系统通知且已授权时发通知；等你确认也会提醒", async () => {
    const created: string[] = [];
    vi.stubGlobal(
      "Notification",
      Object.assign(
        class {
          constructor(title: string) {
            created.push(title);
          }
        },
        { permission: "granted" },
      ),
    );
    window.localStorage.setItem("suduo.notify.system", "on");
    await show(<Probe status="running" />);
    hidden = true;
    await show(<Probe status="approval" />);
    expect(document.title).toBe("● 等你确认 · SuDuo");
    expect(created).toEqual(["等你确认 · 订单导出"]);
  });
});
