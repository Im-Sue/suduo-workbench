// @vitest-environment jsdom

import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  gitStatus: vi.fn(),
  gitCheckpoints: vi.fn(),
  gitCheckpoint: vi.fn(),
  gitRestore: vi.fn(),
  gitSetAutoCheckpoint: vi.fn(),
}));

vi.mock("../src/api/client.js", () => ({ api: apiMocks }));

import { EnvPanel } from "../src/components/EnvPanel.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function render(element: ReactElement): Promise<HTMLDivElement> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(element));
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
  return container;
}

beforeEach(() => {
  apiMocks.gitStatus.mockResolvedValue({ available: true, repo: true, branch: "main", dirty: 1, autoCheckpoint: false });
  apiMocks.gitCheckpoints.mockResolvedValue({ items: [{ hash: "abc123", subject: "suduo checkpoint 1", ts: Date.now() }] });
  window.localStorage.setItem("suduo.ui.checkpointsOpen", "true");
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
  window.localStorage.clear();
});

function panel(running: boolean) {
  return (
    <EnvPanel
      projectId="p1"
      projectRoot="/repo"
      additions={1}
      deletions={0}
      changedFiles={1}
      refreshKey="k"
      running={running}
      openTargets={[]}
      onSystemOpen={() => undefined}
      onError={() => undefined}
    />
  );
}

const q = (node: HTMLElement, selector: string) => node.querySelector<HTMLButtonElement>(selector);

describe("EnvPanel 检查点两守卫按 ADR-0004 分裁（PR4）", () => {
  it("运行中：保存检查点可点并显示告知；还原保持禁用且 tooltip 说明原因", async () => {
    const node = await render(panel(true));
    const save = q(node, "[data-testid='save-checkpoint']");
    expect(save?.disabled).toBe(false);
    expect(save?.title).toContain("可能不包含正在写入的改动");
    expect(q(node, "[data-testid='checkpoint-running-note']")?.textContent).toContain("这一轮还在跑");
    const restore = q(node, "[data-testid='restore-checkpoint']");
    expect(restore?.disabled).toBe(true);
    expect(restore?.title).toContain("回合进行中不可还原");
    expect(restore?.title).toContain("可能丢失未提交改动");
    expect(restore?.title).not.toContain("无法撤回");
  });

  it("空闲时：无告知文案，还原可点", async () => {
    const node = await render(panel(false));
    expect(q(node, "[data-testid='checkpoint-running-note']")).toBeNull();
    expect(q(node, "[data-testid='restore-checkpoint']")?.disabled).toBe(false);
    expect(q(node, "[data-testid='restore-checkpoint']")?.title).toBe("还原到此检查点");
  });
});
