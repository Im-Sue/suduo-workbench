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
  sendMessage: vi.fn(),
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


async function typeInto(node: HTMLElement, value: string): Promise<void> {
  const textarea = node.querySelector<HTMLTextAreaElement>("[data-testid='message-input']");
  if (textarea === null) throw new Error("message-input not rendered");
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(textarea, value);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function enqueue(node: HTMLElement, text: string): Promise<void> {
  await typeInto(node, text);
  await act(async () => q(node, "queue-message")?.click());
}

function userItem(seq: number, clientId: string, turnId: string): EventEnvelope<string, JsonValue> {
  return envelope(seq, "item.started", turnId, { item: { id: `item-${clientId}`, type: "userMessage", clientId, content: [] } });
}

describe("SessionRuntime 队列出队节拍（PR5）", () => {
  it("两项入队：第一个真实回合结束只发一条；第二条要等第一条落进的真实回合终态", async () => {
    apiMocks.sendMessage.mockResolvedValue({ sessionId: "s1", messageEventSeq: 6, threadRef: {}, turnRef: { threadId: "t1", turnId: "ghost" }, acceptedAt: 1, clientTurnId: "c1" });
    const node = await render(<SessionRuntime projectId="p1" sessionId="s1" />);
    await settle();
    const stream = MockEventSource.instances.find((instance) => instance.url.includes("/events?after="));
    if (stream === undefined) throw new Error("events stream not opened");
    await act(async () => stream.emit("stream.live", {}));
    // T1 在跑（回填得知）：排两条
    await enqueue(node, "第二件事");
    await enqueue(node, "第三件事");
    expect(node.querySelectorAll("[data-testid='queue-item']")).toHaveLength(2);
    expect(apiMocks.sendMessage).not.toHaveBeenCalled();

    // T1 正常结束 → 自动发出队首一条，且只发一条
    await act(async () => stream.emit("turn.completed", envelope(5, "turn.completed", "T1", { turn: { id: "T1", status: "completed" } })));
    await settle();
    expect(apiMocks.sendMessage).toHaveBeenCalledTimes(1);
    expect(apiMocks.sendMessage.mock.calls[0]?.[1]).toEqual({ content: [{ type: "text", text: "第二件事" }] });
    expect(node.querySelectorAll("[data-testid='queue-item']")).toHaveLength(1);

    // 这一条入账、落进真实回合 T2 并开始跑：不发第二条（还有回合在跑）
    await act(async () => stream.emit("message.submitted", envelope(6, "message.submitted", "T2", { content: [{ type: "text", text: "第二件事" }], clientTurnId: "c1" })));
    await act(async () => stream.emit("turn.started", envelope(7, "turn.started", "T2")));
    await act(async () => stream.emit("item.started", userItem(8, "c1", "T2")));
    await settle();
    expect(apiMocks.sendMessage).toHaveBeenCalledTimes(1);

    // T2 终态 → 才发第二条
    await act(async () => stream.emit("turn.completed", envelope(9, "turn.completed", "T2", { turn: { id: "T2", status: "completed" } })));
    await settle();
    expect(apiMocks.sendMessage).toHaveBeenCalledTimes(2);
    expect(apiMocks.sendMessage.mock.calls[1]?.[1]).toEqual({ content: [{ type: "text", text: "第三件事" }] });
    expect(q(node, "queue-panel")).toBeNull();
  });

  it("点停止的瞬间队列即暂停（不等中断返回，也不等终态）；之后终态到达也不再出队", async () => {
    apiMocks.interrupt.mockReturnValue(new Promise(() => undefined));
    apiMocks.sendMessage.mockResolvedValue({ sessionId: "s1", messageEventSeq: 6, threadRef: {}, turnRef: { threadId: "t1", turnId: "ghost" }, acceptedAt: 1, clientTurnId: "c1" });
    const node = await render(<SessionRuntime projectId="p1" sessionId="s1" />);
    await settle();
    const stream = MockEventSource.instances.find((instance) => instance.url.includes("/events?after="));
    if (stream === undefined) throw new Error("events stream not opened");
    await act(async () => stream.emit("stream.live", {}));
    await enqueue(node, "等一下再发");
    expect(q(node, "queue-panel")?.getAttribute("data-status")).toBe("waiting");

    await act(async () => q(node, "interrupt-turn")?.click());
    expect(apiMocks.interrupt).toHaveBeenCalledWith("s1", { turnId: "T1" });
    expect(q(node, "queue-paused")?.getAttribute("data-reason")).toBe("user_stop");

    await act(async () => stream.emit("turn.interrupted", envelope(5, "turn.interrupted", "T1")));
    await settle();
    expect(apiMocks.sendMessage).not.toHaveBeenCalled();
    expect(q(node, "queue-paused")).not.toBeNull();
    expect(node.querySelectorAll("[data-testid='queue-item']")).toHaveLength(1);
  });

  it("skill-only 项刷新重建后恢复出队：skills 列表为空也带着入队时的 skill 发出，不发空内容", async () => {
    apiMocks.listSkills.mockResolvedValue({ items: [] });
    apiMocks.sendMessage.mockResolvedValue({ sessionId: "s1", messageEventSeq: 6, threadRef: {}, turnRef: { threadId: "t1", turnId: "ghost" }, acceptedAt: 1, clientTurnId: "c1" });
    window.sessionStorage.setItem("suduo.session.queue:s1", JSON.stringify({
      items: [{ id: "k", text: "", skill: { name: "review", path: "/repo/.codex/skills/review" }, attachmentIds: [] }], status: "waiting",
    }));
    // 没有回合在跑：回填不给 turn.started
    apiMocks.backfillSessionEvents.mockReset();
    apiMocks.backfillSessionEvents.mockResolvedValue([]);
    cacheMocks.loadEventCacheStart.mockReturnValue(null);
    const node = await render(<SessionRuntime projectId="p1" sessionId="s1" />);
    await settle();
    expect(q(node, "queue-paused")?.getAttribute("data-reason")).toBe("restored");
    await act(async () => q(node, "queue-resume")?.click());
    await settle();
    expect(apiMocks.sendMessage).toHaveBeenCalledTimes(1);
    expect(apiMocks.sendMessage.mock.calls[0]?.[1]).toEqual({ content: [{ type: "skill", name: "review", path: "/repo/.codex/skills/review" }] });
    window.sessionStorage.clear();
  });

  it("刷新重建：队列从 sessionStorage 恢复为 paused（restored），不清空", async () => {
    window.sessionStorage.setItem("suduo.session.queue:s1", JSON.stringify({ items: [{ id: "k", text: "上次排的", attachmentIds: [] }], status: "waiting" }));
    const node = await render(<SessionRuntime projectId="p1" sessionId="s1" />);
    await settle();
    expect(q(node, "queue-paused")?.getAttribute("data-reason")).toBe("restored");
    expect(node.querySelectorAll("[data-testid='queue-item']")).toHaveLength(1);
    window.sessionStorage.clear();
  });
});
