// @vitest-environment jsdom

import { TooltipProvider } from "../src/components/ui/tooltip.js";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionDto } from "@suduo/client-contracts";

const apiMocks = vi.hoisted(() => ({
  backfillSessionEvents: vi.fn(),
  deleteSession: vi.fn(),
  getSession: vi.fn(),
  getSettings: vi.fn(),
  listApprovals: vi.fn(),
  listChanges: vi.fn(),
  listFiles: vi.fn(),
  getSessionContext: vi.fn(),
  listProjects: vi.fn(),
  listRequirementsMappings: vi.fn(),
  listRequirementsSessions: vi.fn(),
  listRunStatus: vi.fn(),
  listSkills: vi.fn(),
  modelProvider: vi.fn(),
  openTargets: vi.fn(),
  updateSession: vi.fn(),
}));

const toastMocks = vi.hoisted(() => {
  const toast = vi.fn();
  return { toast, success: vi.fn(), error: vi.fn() };
});

vi.mock("../src/api/client.js", () => ({
  api: apiMocks,
  getInflightCount: () => 0,
  subscribeInflight: () => () => undefined,
}));

vi.mock("sonner", () => ({
  toast: Object.assign(toastMocks.toast, { success: toastMocks.success, error: toastMocks.error, warning: vi.fn() }),
  Toaster: () => null,
}));

import { SessionRuntime } from "../src/app/SessionRuntime.js";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function render(element: ReactElement): Promise<HTMLDivElement> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(<TooltipProvider>{element}</TooltipProvider>));
  return container;
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

function session(): SessionDto {
  return {
    id: "s1",
    projectId: "p1",
    title: "会话一",
    state: "active",
    purpose: "general",
    approvalMode: "ask",
    createdAt: 1,
    updatedAt: 1,
    lastActivityAt: null,
    version: 1,
    threads: [],
  };
}

class MockEventSource {
  addEventListener() {}
  close() {}
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  apiMocks.backfillSessionEvents.mockResolvedValue([]);
  apiMocks.deleteSession.mockResolvedValue(undefined);
  apiMocks.getSession.mockResolvedValue(session());
  apiMocks.getSettings.mockResolvedValue({ approvalModeLocked: false });
  apiMocks.listApprovals.mockResolvedValue({ items: [] });
  apiMocks.listChanges.mockResolvedValue({ items: [], additions: 0, deletions: 0 });
  apiMocks.listFiles.mockResolvedValue({ entries: [] });
  apiMocks.getSessionContext.mockResolvedValue({ sessionId: "s1", kind: "none", contextMode: null, remoteProjectId: null, requirement: null });
  apiMocks.listProjects.mockResolvedValue({ items: [] });
  apiMocks.listRequirementsMappings.mockResolvedValue({ items: [] });
  apiMocks.listRequirementsSessions.mockResolvedValue({ items: [{ session: session(), requirement: null }] });
  apiMocks.listRunStatus.mockResolvedValue({ items: [] });
  apiMocks.listSkills.mockResolvedValue({ items: [] });
  apiMocks.modelProvider.mockResolvedValue(null);
  apiMocks.openTargets.mockResolvedValue({ targets: ["open"] });
  apiMocks.updateSession.mockResolvedValue(session());
  vi.stubGlobal("EventSource", MockEventSource);
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("会话模块反馈收口", () => {
  it("终态错误以持久 RegionError 留在会话上下文", async () => {
    vi.useFakeTimers();
    apiMocks.getSession.mockRejectedValue({ status: 502, code: "DEPENDENCY_UNAVAILABLE" });
    const node = await render(<SessionRuntime projectId="p1" sessionId="s1" />);
    await settle();

    const error = node.querySelector('[data-testid="region-error"]');
    expect(error?.getAttribute("data-feedback-kind")).toBe("upstream_unavailable");
    expect(error?.getAttribute("data-feedback-result")).toBe("region");
    await act(async () => vi.advanceTimersByTime(60_000));
    expect(node.querySelector('[data-testid="region-error"]')).not.toBeNull();
    expect(toastMocks.error).not.toHaveBeenCalled();
  });

  it("AbortError 归类为 cancelled 后不产生任何反馈", async () => {
    apiMocks.getSession.mockRejectedValue(new DOMException("已取消", "AbortError"));
    const node = await render(<SessionRuntime projectId="p1" sessionId="s1" />);
    await settle();

    expect(node.querySelector('[data-testid="region-error"]')).toBeNull();
    expect(node.querySelector('[data-testid="page-failure"]')).toBeNull();
    expect(toastMocks.error).not.toHaveBeenCalled();
  });
});
