// @vitest-environment jsdom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  uploadAttachment: vi.fn(),
  fileIndex: vi.fn(),
}));

vi.mock("../src/api/client.js", () => ({ api: apiMocks }));

import { Composer, type ComposerRunState } from "../src/components/Composer.js";

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

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
});

function runState(overrides: Partial<ComposerRunState> = {}): ComposerRunState {
  return {
    status: "running",
    stepText: "正在执行 pnpm test",
    elapsedMs: 12_000,
    pendingApprovals: 0,
    stopping: false,
    onStop: () => undefined,
    onJumpToApproval: () => undefined,
    ...overrides,
  };
}

function composer(state: ComposerRunState | undefined) {
  return (
    <Composer
      disabled={false}
      projectId="p1"
      projectRoot="/repo"
      sessionId="s1"
      skills={[]}
      skillPath=""
      onSkillPath={() => undefined}
      onError={() => undefined}
      {...(state === undefined ? {} : { runState: state })}
    />
  );
}

const q = (node: HTMLElement, testId: string) => node.querySelector<HTMLElement>(`[data-testid='${testId}']`);

describe("Composer 运行态状态行与停止控件（PR3）", () => {
  it("运行中：状态行显示步骤与时长，停止与发送并存且都可点", async () => {
    const onStop = vi.fn();
    const node = await render(composer(runState({ onStop })));
    const line = q(node, "run-status-line");
    expect(line?.getAttribute("data-status")).toBe("running");
    expect(line?.textContent).toContain("Codex 正在工作");
    expect(q(node, "run-status-step")?.textContent).toBe("正在执行 pnpm test");
    expect(q(node, "run-status-elapsed")?.textContent).toBe("12 秒");
    const stop = q(node, "interrupt-turn") as HTMLButtonElement | null;
    expect(stop?.disabled).toBe(false);
    expect((q(node, "send-message") as HTMLButtonElement | null)).not.toBeNull();
    await act(async () => stop?.click());
    expect(onStop).toHaveBeenCalledTimes(1);
  });

  it("没有锚点：只显示「运行中」，不显示时长", async () => {
    const node = await render(composer(runState({ stepText: null, elapsedMs: null })));
    expect(q(node, "run-status-step")?.textContent).toBe("运行中");
    expect(q(node, "run-status-elapsed")).toBeNull();
  });

  it("停止中：控件禁用、文案变「停止中…」，状态行说「正在停止」", async () => {
    const node = await render(composer(runState({ stopping: true })));
    const stop = q(node, "interrupt-turn") as HTMLButtonElement | null;
    expect(stop?.disabled).toBe(true);
    expect(stop?.textContent).toContain("正在停止");
    expect(q(node, "run-status-line")?.textContent).toContain("正在停止");
  });

  it("等审批：整行换成审批提示与跳转，停止控件仍在", async () => {
    const onJumpToApproval = vi.fn();
    const node = await render(composer(runState({ status: "approval", pendingApprovals: 2, onJumpToApproval })));
    const line = q(node, "run-status-line");
    expect(line?.getAttribute("data-status")).toBe("approval");
    expect(line?.textContent).toContain("等你确认 · 2 项");
    await act(async () => q(node, "run-status-approval-link")?.click());
    expect(onJumpToApproval).toHaveBeenCalledTimes(1);
    expect(q(node, "interrupt-turn")).not.toBeNull();
  });

  it("终态 / 空闲 / 异常 / 未传运行态：既无状态行也无停止控件（终态后控件是消失不是禁用）", async () => {
    for (const status of ["completed", "idle", "error"] as const) {
      const node = await render(composer(runState({ status })));
      expect(q(node, "run-status-line")).toBeNull();
      expect(q(node, "interrupt-turn")).toBeNull();
      expect(q(node, "send-message")).not.toBeNull();
      await act(async () => root?.unmount());
      container?.remove();
    }
    const node = await render(composer(undefined));
    expect(q(node, "run-status-line")).toBeNull();
    expect(q(node, "interrupt-turn")).toBeNull();
  });
});
