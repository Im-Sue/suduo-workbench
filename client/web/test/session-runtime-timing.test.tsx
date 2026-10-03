// @vitest-environment jsdom

import { TooltipProvider } from "../src/components/ui/tooltip.js";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventEnvelope, JsonValue, SessionDto } from "@suduo/client-contracts";

const apiMocks = vi.hoisted(() => ({
  backfillSessionEvents: vi.fn(),
  getSession: vi.fn(),
  getSettings: vi.fn(),
  listApprovals: vi.fn(),
  listChanges: vi.fn(),
  listFiles: vi.fn(),
  getSessionContext: vi.fn(),
  listProjects: vi.fn(),
  listSkills: vi.fn(),
  modelProvider: vi.fn(),
  openTargets: vi.fn(),
  interrupt: vi.fn(),
  gitStatus: vi.fn(),
  gitCheckpoints: vi.fn(),
}));

const cacheMocks = vi.hoisted(() => ({
  loadEventCache: vi.fn(),
  loadEventCacheStart: vi.fn(),
  saveEventCache: vi.fn(),
}));

vi.mock("../src/api/client.js", () => ({
  api: apiMocks,
  getInflightCount: () => 0,
  subscribeInflight: () => () => undefined,
}));
vi.mock("../src/event-projection/cache.js", () => cacheMocks);
vi.mock("sonner", () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), warning: vi.fn() }),
  Toaster: () => null,
}));

import { SessionRuntime } from "../src/app/SessionRuntime.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** 可控的 EventSource：按 URL 记录实例，测试按类型派发帧。 */
class MockEventSource {
  static instances: MockEventSource[] = [];
  readonly listeners = new Map<string, Array<(event: MessageEvent<string>) => void>>();
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {
    MockEventSource.instances.push(this);
  }
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  close(): void {}
  emit(type: string, data: unknown): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: JSON.stringify(data) } as MessageEvent<string>);
    }
  }
}

function envelope(seq: number, type: string, turnId: string, payload: JsonValue = {}): EventEnvelope<string, JsonValue> {
  return {
    schemaVersion: 1, seq, eventId: `evt-${String(seq)}`, sessionId: "s1", source: "runtime:codex-local",
    type, payload, threadRef: { runtimeId: "codex-local", runtimeKind: "codex", threadId: "t1" },
    turnRef: { threadId: "t1", turnId }, ts: 1_700_000_000_000 + seq,
  };
}

function session(): SessionDto {
  return {
    id: "s1", projectId: "p1", title: "会话一", state: "active", purpose: "general", approvalMode: "ask",
    createdAt: 1, updatedAt: 1, lastActivityAt: null, version: 1, threads: [],
  };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

async function render(element: ReactElement): Promise<HTMLDivElement> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root?.render(<TooltipProvider>{element}</TooltipProvider>));
  return container;
}

async function settle(rounds = 6): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

beforeEach(() => {
  MockEventSource.instances = [];
  cacheMocks.loadEventCache.mockReturnValue([]);
  // 缓存从 seq 5 起被截断：SessionRuntime 会先经 HTTP 回填 1..4。
  cacheMocks.loadEventCacheStart.mockReturnValue(5);
  apiMocks.backfillSessionEvents
    .mockResolvedValueOnce([envelope(3, "turn.started", "T1")])
    .mockResolvedValue([]);
  apiMocks.getSession.mockResolvedValue(session());
  apiMocks.getSettings.mockResolvedValue({ approvalModeLocked: false });
  apiMocks.listApprovals.mockResolvedValue({ items: [] });
  apiMocks.listChanges.mockResolvedValue({ items: [], additions: 0, deletions: 0 });
  apiMocks.listFiles.mockResolvedValue({ entries: [] });
  apiMocks.getSessionContext.mockResolvedValue({ sessionId: "s1", kind: "none", contextMode: null, remoteProjectId: null, requirement: null });
  apiMocks.listProjects.mockResolvedValue({ items: [] });
  apiMocks.listSkills.mockResolvedValue({ items: [] });
  apiMocks.gitStatus.mockResolvedValue({ available: false, repo: false, branch: null, dirty: 0, autoCheckpoint: false });
  apiMocks.gitCheckpoints.mockResolvedValue({ items: [] });
  apiMocks.modelProvider.mockResolvedValue(null);
  apiMocks.openTargets.mockResolvedValue({ targets: ["open"] });
  vi.stubGlobal("EventSource", MockEventSource);
  vi.stubGlobal("matchMedia", () => ({ matches: false, addEventListener: () => undefined, removeEventListener: () => undefined }));
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const q = (node: HTMLElement, testId: string) => node.querySelector<HTMLElement>(`[data-testid='${testId}']`);

describe("SessionRuntime 计时锚点接线（PR4 验证 PR3 规则：只认 stream.live 之后实时到达的 turn.started）", () => {
  it("HTTP 回填与 SSE 回放阶段得知的运行中回合只显示「运行中」无时长；控制帧后实时开始的回合才显示时长", async () => {
    const node = await render(<SessionRuntime projectId="p1" sessionId="s1" />);
    await settle();
    // 回填拿到了 T1 的 turn.started（历史）：状态行说运行中，但没有时长。
    expect(apiMocks.backfillSessionEvents).toHaveBeenCalled();
    expect(q(node, "run-status-line")?.getAttribute("data-status")).toBe("running");
    expect(q(node, "run-status-elapsed")).toBeNull();

    const stream = MockEventSource.instances.find((instance) => instance.url.includes("/events?after="));
    expect(stream).toBeDefined();
    if (stream === undefined) throw new Error("events stream not opened");

    // SSE 回放阶段（边界前）再送一遍 T1 的 start：仍不建锚点。
    await act(async () => stream.emit("turn.started", envelope(3, "turn.started", "T1")));
    await settle(2);
    expect(q(node, "run-status-elapsed")).toBeNull();

    // 回放边界：之后到的才算实时；边界本身不改变 T1 的无锚点状态。
    await act(async () => stream.emit("stream.live", {}));
    await settle(2);
    expect(q(node, "run-status-line")?.getAttribute("data-status")).toBe("running");
    expect(q(node, "run-status-elapsed")).toBeNull();

    // 实时开始的 T2：有锚点，时长出现。
    await act(async () => stream.emit("turn.started", envelope(10, "turn.started", "T2")));
    await settle(2);
    expect(q(node, "run-status-elapsed")).not.toBeNull();
    // 停止控件与发送并存，指向的是当前运行回合。
    expect(q(node, "interrupt-turn")).not.toBeNull();
    expect(q(node, "send-message")).not.toBeNull();
  });

  it("连接出错（将自动重连）后边界作废：重连回放里新的运行中回合不计时，直到再收到 stream.live", async () => {
    const node = await render(<SessionRuntime projectId="p1" sessionId="s1" />);
    await settle();
    const stream = MockEventSource.instances.find((instance) => instance.url.includes("/events?after="));
    if (stream === undefined) throw new Error("events stream not opened");
    await act(async () => stream.emit("stream.live", {}));
    await act(async () => stream.emit("turn.completed", envelope(4, "turn.completed", "T1", { turn: { id: "T1", status: "completed" } })));
    await settle(2);
    expect(q(node, "run-status-line")).toBeNull();
    expect(q(node, "session-status")?.textContent).toContain("已完成");

    // 断线：浏览器随后自动重连并从头回放，回放里 T3 已在跑——不计时。
    await act(async () => stream.onerror?.());
    await act(async () => stream.emit("turn.started", envelope(12, "turn.started", "T3")));
    await settle(2);
    expect(q(node, "run-status-line")?.getAttribute("data-status")).toBe("running");
    expect(q(node, "run-status-elapsed")).toBeNull();

    // 新的回放边界之后实时开始的 T4 才计时。
    await act(async () => stream.emit("stream.live", {}));
    await act(async () => stream.emit("turn.started", envelope(13, "turn.started", "T4")));
    await settle(2);
    expect(q(node, "run-status-elapsed")).not.toBeNull();
  });
});
