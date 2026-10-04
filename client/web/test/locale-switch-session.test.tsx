// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, StrictMode, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EventEnvelope, JsonValue, SessionDto } from "@suduo/client-contracts";

/**
 * 切换语言不丢会话页上的输入（中英双语 S9）：语言切换按新语言重建整棵界面，
 * 输入框草稿、排队的消息（不暂停、不重发）、正在改的排队项、选中的 skill、事件流位置都要带过去；
 * 事件流按新语言重连（地址带 ?locale=）。
 */

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

import { TooltipProvider } from "../src/components/ui/tooltip.js";
import { SessionRuntime } from "../src/app/SessionRuntime.js";
import { captureCarry, finishLocaleRebuild, registerCarrySource, resetCarry, switchWouldLoseWork } from "../src/i18n/carry.js";
import { LOCALE_STORAGE_KEY, applyLocalePreference, currentLocale, deferredLocalePreference } from "../src/i18n/locale.js";
import { messagesFor } from "../src/i18n/messages/index.js";
import { LocaleBoundary } from "../src/i18n/provider.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class MockEventSource {
  static instances: MockEventSource[] = [];
  readonly listeners = new Map<string, Array<(event: MessageEvent<string>) => void>>();
  onerror: (() => void) | null = null;
  closed = false;
  constructor(readonly url: string) {
    MockEventSource.instances.push(this);
  }
  addEventListener(type: string, listener: (event: MessageEvent<string>) => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  close(): void {
    this.closed = true;
  }
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

async function render(element: ReactElement, { strict = false }: { strict?: boolean } = {}): Promise<HTMLDivElement> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const tree = (
    <QueryClientProvider client={new QueryClient()}>
      <LocaleBoundary>
        <TooltipProvider>{element}</TooltipProvider>
      </LocaleBoundary>
    </QueryClientProvider>
  );
  await act(async () => root?.render(strict ? <StrictMode>{tree}</StrictMode> : tree));
  return container;
}

const accepted = (clientTurnId: string) => ({
  sessionId: "s1", messageEventSeq: 6, threadRef: {}, turnRef: { threadId: "t1", turnId: "ghost" }, acceptedAt: 1, clientTurnId,
});

function userItem(seq: number, clientId: string, turnId: string): EventEnvelope<string, JsonValue> {
  return envelope(seq, "item.started", turnId, { item: { id: `item-${clientId}`, type: "userMessage", clientId, content: [] } });
}

/** 排队那一条落进真实回合 turnId 并跑完。 */
async function runQueuedTurn(stream: MockEventSource, seq: number, clientTurnId: string, turnId: string, text: string): Promise<void> {
  await act(async () => stream.emit("message.submitted", envelope(seq, "message.submitted", turnId, { content: [{ type: "text", text }], clientTurnId })));
  await act(async () => stream.emit("turn.started", envelope(seq + 1, "turn.started", turnId)));
  await act(async () => stream.emit("item.started", userItem(seq + 2, clientTurnId, turnId)));
  await act(async () => stream.emit("turn.completed", envelope(seq + 3, "turn.completed", turnId, { turn: { id: turnId, status: "completed" } })));
  await settle();
}

async function settle(rounds = 6): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await Promise.resolve();
    });
  }
}

const q = (node: HTMLElement, testId: string) => node.querySelector<HTMLElement>(`[data-testid='${testId}']`);

async function typeInto(element: HTMLTextAreaElement | null, value: string): Promise<void> {
  if (element === null) throw new Error("textarea not rendered");
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
  await act(async () => {
    setter?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const messageInput = (node: HTMLElement) => node.querySelector<HTMLTextAreaElement>("[data-testid='message-input']");

async function enqueue(node: HTMLElement, text: string): Promise<void> {
  await typeInto(messageInput(node), text);
  await act(async () => q(node, "queue-message")?.click());
}

/** 别的标签页改了语言（设置在设置页，会话页只会被别的标签页的切换波及）。 */
async function otherTabSwitchesTo(value: string): Promise<void> {
  await act(async () => {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, value);
    window.dispatchEvent(new StorageEvent("storage", { key: LOCALE_STORAGE_KEY, newValue: value }));
  });
  await settle();
}

function eventStreams(): MockEventSource[] {
  return MockEventSource.instances.filter((instance) => instance.url.includes("/events?after="));
}

/** 当前开着的会话事件流（StrictMode 下 effect 会先建一条再关掉重建）。 */
function liveStream(): MockEventSource {
  const stream = eventStreams().filter((instance) => !instance.closed).at(-1);
  if (stream === undefined) throw new Error("events stream not opened");
  return stream;
}

beforeEach(() => {
  MockEventSource.instances = [];
  cacheMocks.loadEventCache.mockReturnValue([]);
  cacheMocks.loadEventCacheStart.mockReturnValue(5);
  // 回填：T1 在 seq 3 开始（缓存从 seq 5 起被截断，回填 1..4）。
  apiMocks.backfillSessionEvents.mockImplementation(async (_sessionId: string, range: { after: number; until: number }) =>
    range.after < 3 && range.until >= 3 ? [envelope(3, "turn.started", "T1")] : [],
  );
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
  applyLocalePreference("system");
  window.localStorage.clear();
  window.sessionStorage.clear();
  resetCarry();
});

describe("会话页：切换语言后输入与排队的消息都还在", () => {
  it.each([
    ["普通渲染", false],
    ["StrictMode（开发模式）", true],
  ])("%s：草稿、排队的两条、正在改的排队项带过重建；队列不暂停、不重发，回合结束后照常出队；事件流按新语言接着收", async (_mode, strict) => {
    apiMocks.sendMessage.mockResolvedValue(accepted("c1"));
    const node = await render(<SessionRuntime projectId="p1" sessionId="s1" />, { strict });
    await settle();
    const first = liveStream();
    expect(first.url).toBe("/api/v1/sessions/s1/events?after=0&locale=zh-CN");
    expect(MockEventSource.instances.some((instance) => instance.url === "/api/v1/projects/p1/files/watch?locale=zh-CN")).toBe(true);
    await act(async () => first.emit("stream.live", {}));

    // T1 在跑：排两条，改第二条改到一半，再在输入框里写一段还没发的话。
    await enqueue(node, "第二件事");
    await enqueue(node, "第三件事");
    await act(async () => node.querySelectorAll<HTMLElement>("[data-testid='queue-item-edit']")[1]?.click());
    await typeInto(node.querySelector<HTMLTextAreaElement>("[data-testid='queue-item'] textarea"), "第三件事（改到一半）");
    await typeInto(messageInput(node), "还没发出去的草稿");
    expect(q(node, "queue-panel")?.getAttribute("data-status")).toBe("waiting");
    const before = messageInput(node);

    await otherTabSwitchesTo("en");
    expect(currentLocale()).toBe("en");
    // 没有因为重建而提前出队（T1 还在跑），队列仍在等（没被当成「刷新恢复」暂停）。
    expect(apiMocks.sendMessage).not.toHaveBeenCalled();
    expect(node.querySelectorAll("[data-testid='queue-item']")).toHaveLength(2);
    expect(q(node, "queue-panel")?.getAttribute("data-status")).toBe("waiting");
    expect(q(node, "queue-paused")).toBeNull();
    // 确实重建了（输入框是新的），界面是英文；输入都在。
    expect(messageInput(node)).not.toBe(before);
    expect(q(node, "queue-message")?.textContent).toBe(messagesFor("en").workbench.composer.queue);
    expect(messageInput(node)?.value).toBe("还没发出去的草稿");
    expect(node.querySelector<HTMLTextAreaElement>("[data-testid='queue-item'] textarea")?.value).toBe("第三件事（改到一半）");

    // 旧连接关掉，新连接按英文、从已收到的最后一条往后收。
    expect(first.closed).toBe(true);
    const second = liveStream();
    expect(second).not.toBe(first);
    expect(second.url).toBe("/api/v1/sessions/s1/events?after=3&locale=en");
    expect(MockEventSource.instances.some((instance) => instance.url === "/api/v1/projects/p1/files/watch?locale=en")).toBe(true);

    // T1 结束：队首一条照常发出，且只发一条。
    await act(async () => second.emit("stream.live", {}));
    await act(async () => second.emit("turn.completed", envelope(5, "turn.completed", "T1", { turn: { id: "T1", status: "completed" } })));
    await settle();
    expect(apiMocks.sendMessage).toHaveBeenCalledTimes(1);
    expect(apiMocks.sendMessage.mock.calls[0]?.[1]).toEqual({ content: [{ type: "text", text: "第二件事" }] });
    expect(messageInput(node)?.value).toBe("还没发出去的草稿");
  });

  it("出队那一条的请求在途时别的标签页切语言：先不切；请求回来后（假计时器走到下一次检查）再切，结果落在重建后的队列上，不卡住、不重发", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    try {
      let resolveSend: (value: unknown) => void = () => undefined;
      apiMocks.sendMessage.mockReturnValueOnce(new Promise((resolve) => (resolveSend = resolve))).mockResolvedValue(accepted("c2"));
      const node = await render(<SessionRuntime projectId="p1" sessionId="s1" />);
      await settle();
      const first = liveStream();
      await act(async () => first.emit("stream.live", {}));
      await enqueue(node, "第二件事");
      await enqueue(node, "第三件事");
      await act(async () => first.emit("turn.completed", envelope(5, "turn.completed", "T1", { turn: { id: "T1", status: "completed" } })));
      await settle();
      expect(apiMocks.sendMessage).toHaveBeenCalledTimes(1);
      expect(switchWouldLoseWork()).toBe(true);

      await otherTabSwitchesTo("en");
      expect(currentLocale()).toBe("zh-CN");
      expect(deferredLocalePreference()).toBe("en");
      await act(async () => vi.advanceTimersByTime(3_000));
      expect(currentLocale()).toBe("zh-CN");

      // 请求回来：结果已记进队列（即使还没提交渲染也算），下一次检查时切过去。
      await act(async () => resolveSend(accepted("c1")));
      expect(switchWouldLoseWork()).toBe(false);
      await act(async () => vi.advanceTimersByTime(1_000));
      await settle();
      expect(currentLocale()).toBe("en");
      expect(deferredLocalePreference()).toBeNull();

      // 重建后：已发出的那一条照样等它的回合，没被当成不确定、也没暂停；剩下一条在排队。
      expect(q(node, "queue-paused")).toBeNull();
      expect(node.querySelectorAll("[data-testid='queue-item']")).toHaveLength(1);
      const second = liveStream();
      expect(second).not.toBe(first);
      await act(async () => second.emit("stream.live", {}));
      await runQueuedTurn(second, 6, "c1", "T2", "第二件事");
      expect(apiMocks.sendMessage).toHaveBeenCalledTimes(2);
      expect(apiMocks.sendMessage.mock.calls.map((call) => (call[1] as { content: unknown[] }).content)).toEqual([
        [{ type: "text", text: "第二件事" }],
        [{ type: "text", text: "第三件事" }],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("回合结束与切换在同一轮到达（出队还没跑）：按已提交的事件拍快照，新的一份接着收，只发一次", async () => {
    apiMocks.sendMessage.mockResolvedValue(accepted("c1"));
    const node = await render(<SessionRuntime projectId="p1" sessionId="s1" />);
    await settle();
    const first = liveStream();
    await act(async () => first.emit("stream.live", {}));
    await enqueue(node, "第二件事");

    await act(async () => {
      first.emit("turn.completed", envelope(5, "turn.completed", "T1", { turn: { id: "T1", status: "completed" } }));
      window.localStorage.setItem(LOCALE_STORAGE_KEY, "en");
      window.dispatchEvent(new StorageEvent("storage", { key: LOCALE_STORAGE_KEY, newValue: "en" }));
    });
    await settle();
    expect(currentLocale()).toBe("en");
    // 旧的一份没出队（它的事件更新随重建丢掉），新的一份从 seq 3 往后接着收，回合结束再到时只发一次。
    expect(apiMocks.sendMessage).not.toHaveBeenCalled();
    const second = liveStream();
    expect(second.url).toBe("/api/v1/sessions/s1/events?after=3&locale=en");
    await act(async () => second.emit("stream.live", {}));
    await act(async () => second.emit("turn.completed", envelope(5, "turn.completed", "T1", { turn: { id: "T1", status: "completed" } })));
    await settle();
    expect(apiMocks.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("重建期间旧的一份不出队；语言来回切、最后没真的重建时，重建结束后照常出队（只发一次）", async () => {
    apiMocks.sendMessage.mockResolvedValue(accepted("c1"));
    const node = await render(<SessionRuntime projectId="p1" sessionId="s1" />);
    await settle();
    const stream = liveStream();
    await act(async () => stream.emit("stream.live", {}));
    await enqueue(node, "第二件事");
    // 拍了快照、还没重建（相当于切过去又切回来，界面没换）。
    captureCarry();
    await act(async () => stream.emit("turn.completed", envelope(5, "turn.completed", "T1", { turn: { id: "T1", status: "completed" } })));
    await settle();
    expect(apiMocks.sendMessage).not.toHaveBeenCalled();
    // 这时「可以出队、还没出」：别的标签页再来切语言要等（按最新的队列与已提交的事件判断）。
    expect(switchWouldLoseWork()).toBe(true);
    await act(async () => finishLocaleRebuild());
    await settle();
    expect(apiMocks.sendMessage).toHaveBeenCalledTimes(1);
    expect(switchWouldLoseWork()).toBe(false);
  });

  describe("兜底：快照里的队列拿不准时停下等人，不重发", () => {
    const waiting = { items: [{ id: "q2", text: "第三件事", attachmentIds: [] }], status: "waiting" as const, pausedReason: null, seenSeq: 3 };
    const carry = (queue: Record<string, unknown>, events: EventEnvelope<string, JsonValue>[]) => ({
      session: session(), approvals: [], queue, events, skillPath: "", sideTab: "changes", drawer: null, stopping: null,
      timing: { liveBoundary: false, anchors: new Map() },
    });
    async function renderWith(snapshot: unknown): Promise<HTMLDivElement> {
      registerCarrySource("session-runtime:s1", () => snapshot);
      captureCarry();
      return render(<SessionRuntime projectId="p1" sessionId="s1" />);
    }

    it("那一条已出队、发送结果没等到：放回待核对并暂停（结果不确定）", async () => {
      const inflight = { item: { id: "q1", text: "第二件事", attachmentIds: [] }, clientTurnId: null, awaitingTurnId: null, dequeueSeq: 5, acceptedAt: null };
      const node = await renderWith(carry({ ...waiting, status: "dispatch", inflight }, [envelope(3, "turn.started", "T1"), envelope(5, "turn.completed", "T1", { turn: { id: "T1", status: "completed" } })]));
      await settle();
      expect(q(node, "queue-paused")?.getAttribute("data-reason")).toBe("send_uncertain");
      const items = [...node.querySelectorAll<HTMLElement>("[data-testid='queue-item']")];
      expect(items.map((item) => item.getAttribute("data-unconfirmed"))).toEqual(["true", null]);
      await act(async () => q(node, "queue-resume")?.click());
      await settle();
      // 恢复只发可发项（第三件事），待核对的那一条绝不自动重发。
      expect(apiMocks.sendMessage.mock.calls.map((call) => (call[1] as { content: unknown[] }).content)).toEqual([[{ type: "text", text: "第三件事" }]]);
    });

    it("正要出队还没出：不自动发，暂停等人继续", async () => {
      apiMocks.sendMessage.mockResolvedValue(accepted("c2"));
      const node = await renderWith(carry({ ...waiting, inflight: null }, [envelope(3, "turn.started", "T1"), envelope(5, "turn.completed", "T1", { turn: { id: "T1", status: "completed" } })]));
      await settle();
      expect(apiMocks.sendMessage).not.toHaveBeenCalled();
      expect(q(node, "queue-paused")?.getAttribute("data-reason")).toBe("locale_switched");
      await act(async () => q(node, "queue-resume")?.click());
      await settle();
      expect(apiMocks.sendMessage).toHaveBeenCalledTimes(1);
    });
  });

  it("后台标签页被别的标签页切了语言：状态不经过「空闲」，不重复提醒「等你确认」；回到页面标题前缀照常去掉", async () => {
    const notify = vi.fn();
    vi.stubGlobal("Notification", Object.assign(notify, { permission: "granted" }));
    window.localStorage.setItem("suduo.notify.system", "on");
    apiMocks.listApprovals.mockResolvedValue({
      items: [{
        id: "ap-1", sessionId: "s1", threadRef: { runtimeId: "codex", runtimeKind: "codex", threadId: "t1" }, turnRef: { threadId: "t1", turnId: "T1" },
        kind: "command", status: "pending", decision: null, request: { request: { command: "pnpm test" } }, requestedAt: 1, decidedAt: null, version: 1,
      }],
    });
    const hidden = { value: false };
    Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden.value });
    document.title = "SuDuo";
    try {
      const node = await render(<SessionRuntime projectId="p1" sessionId="s1" />);
      await settle();
      expect(q(node, "session-status")?.getAttribute("data-status")).toBe("approval");

      // 切到别的标签页去改语言：这里在后台重建，审批还是那一条，不再提醒一次。
      hidden.value = true;
      await otherTabSwitchesTo("en");
      expect(q(node, "session-status")?.getAttribute("data-status")).toBe("approval");
      expect(notify).not.toHaveBeenCalled();

      // 审批处理掉、回合失败：真实的后台提醒照常（系统通知 + 标题前缀）。
      const stream = eventStreams().at(-1);
      apiMocks.listApprovals.mockResolvedValue({ items: [] });
      await act(async () => stream?.emit("approval.resolved", envelope(4, "approval.resolved", "T1", { approvalId: "ap-1", decision: "accept" })));
      await settle();
      expect(q(node, "session-status")?.getAttribute("data-status")).toBe("running");
      await act(async () => stream?.emit("turn.completed", envelope(5, "turn.completed", "T1", { turn: { id: "T1", status: "failed" } })));
      await settle();
      expect(notify).toHaveBeenCalledTimes(1);
      expect(document.title).toMatch(/^✕ .+ · SuDuo$/);

      // 再被切回中文：还是那个失败，不再提醒；回到页面时前缀照常去掉（加前缀前的标题带过了重建）。
      await otherTabSwitchesTo("zh-CN");
      expect(notify).toHaveBeenCalledTimes(1);
      hidden.value = false;
      await act(async () => document.dispatchEvent(new Event("visibilitychange")));
      expect(document.title).toBe("SuDuo");
    } finally {
      Reflect.deleteProperty(document, "hidden");
    }
  });

  it("没有快照时照旧：刷新 / 切回会话恢复的队列仍是暂停（restored）", async () => {
    window.sessionStorage.setItem("suduo.session.queue:s1", JSON.stringify({ items: [{ id: "k", text: "上次排的", attachmentIds: [] }], status: "waiting" }));
    const node = await render(<SessionRuntime projectId="p1" sessionId="s1" />);
    await settle();
    expect(q(node, "queue-paused")?.getAttribute("data-reason")).toBe("restored");
  });
});

/**
 * 强制切换：设置里确认后切换、或另一个标签页的提示条上点「现在切换」并确认，不等手头的事做完。
 * 这时出队与发送的结果可能落在被换掉的那一份上，拿不准的一律停下等人，绝不重发。
 */
describe("强制切换（确认后不等）", () => {
  const modes = [
    ["普通渲染", false],
    ["StrictMode（开发模式）", true],
  ] as const;

  it.each(modes)("%s：出队那一条的请求在途：只发了一次，那一条标待核对并暂停，恢复后只发剩下的", async (_mode, strict) => {
    let resolveSend: (value: unknown) => void = () => undefined;
    apiMocks.sendMessage.mockReturnValueOnce(new Promise((resolve) => (resolveSend = resolve))).mockResolvedValue(accepted("c2"));
    const node = await render(<SessionRuntime projectId="p1" sessionId="s1" />, { strict });
    await settle();
    const first = liveStream();
    await act(async () => first.emit("stream.live", {}));
    await enqueue(node, "第二件事");
    await enqueue(node, "第三件事");
    await act(async () => first.emit("turn.completed", envelope(5, "turn.completed", "T1", { turn: { id: "T1", status: "completed" } })));
    await settle();
    expect(apiMocks.sendMessage).toHaveBeenCalledTimes(1);
    expect(switchWouldLoseWork()).toBe(true);

    await act(async () => applyLocalePreference("en"));
    await settle();
    expect(currentLocale()).toBe("en");
    expect(q(node, "queue-paused")?.getAttribute("data-reason")).toBe("send_uncertain");
    expect([...node.querySelectorAll<HTMLElement>("[data-testid='queue-item']")].map((item) => item.getAttribute("data-unconfirmed"))).toEqual([
      "true",
      null,
    ]);

    // 旧的那一份的请求回来了：落空，不会再发。
    await act(async () => resolveSend(accepted("c1")));
    await settle();
    await act(async () => liveStream().emit("stream.live", {}));
    await settle();
    expect(apiMocks.sendMessage).toHaveBeenCalledTimes(1);

    // 恢复：只发可发项（第三件事），待核对的那一条不重发。
    await act(async () => q(node, "queue-resume")?.click());
    await settle();
    expect(apiMocks.sendMessage.mock.calls.map((call) => (call[1] as { content: unknown[] }).content)).toEqual([
      [{ type: "text", text: "第二件事" }],
      [{ type: "text", text: "第三件事" }],
    ]);
  });

  it.each(modes)(
    "%s：真实调度下「可以出队已提交、出队 effect 还没跑」的那一刻切换：旧的一份不发，新的一份暂停等人，恢复后只发一次",
    async (_mode, strict) => {
      apiMocks.sendMessage.mockResolvedValue(accepted("c1"));
      const node = await render(<SessionRuntime projectId="p1" sessionId="s1" />, { strict });
      await settle();
      const first = liveStream();
      await act(async () => first.emit("stream.live", {}));
      await enqueue(node, "第二件事");
      expect(q(node, "session-status")?.getAttribute("data-status")).toBe("running");

      // 不用 act：让 React 按真实调度先提交渲染、再另找时机跑被动 effect，在两者之间切换。
      const environment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
      environment.IS_REACT_ACT_ENVIRONMENT = false;
      let hit = false;
      try {
        first.emit("turn.completed", envelope(5, "turn.completed", "T1", { turn: { id: "T1", status: "completed" } }));
        for (let round = 0; round < 200; round += 1) {
          await new Promise((resolve) => setTimeout(resolve, 0));
          const committed = q(node, "session-status")?.getAttribute("data-status") !== "running";
          if (committed && apiMocks.sendMessage.mock.calls.length === 0) {
            hit = true;
            applyLocalePreference("en");
            break;
          }
          if (apiMocks.sendMessage.mock.calls.length > 0) break;
        }
        for (let round = 0; round < 20; round += 1) await new Promise((resolve) => setTimeout(resolve, 0));
      } finally {
        environment.IS_REACT_ACT_ENVIRONMENT = true;
      }
      await settle();
      expect(hit).toBe(true);
      expect(currentLocale()).toBe("en");
      expect(apiMocks.sendMessage).not.toHaveBeenCalled();
      expect(q(node, "queue-paused")?.getAttribute("data-reason")).toBe("locale_switched");

      await act(async () => q(node, "queue-resume")?.click());
      await settle();
      expect(apiMocks.sendMessage).toHaveBeenCalledTimes(1);
    },
  );

  it.each(modes)("%s：输入框直接发送在途：重建后那段字还在，提示可能已经发出、先核对；不会自己再发", async (_mode, strict) => {
    let resolveSend: (value: unknown) => void = () => undefined;
    apiMocks.sendMessage.mockReturnValueOnce(new Promise((resolve) => (resolveSend = resolve))).mockResolvedValue(accepted("c2"));
    const node = await render(<SessionRuntime projectId="p1" sessionId="s1" />, { strict });
    await settle();
    const first = liveStream();
    await act(async () => first.emit("stream.live", {}));
    await act(async () => first.emit("turn.completed", envelope(5, "turn.completed", "T1", { turn: { id: "T1", status: "completed" } })));
    await settle();
    await typeInto(messageInput(node), "已经点了发送的话");
    await act(async () => q(node, "send-message")?.click());
    expect(apiMocks.sendMessage).toHaveBeenCalledTimes(1);
    expect(switchWouldLoseWork()).toBe(true);
    expect(q(node, "composer-maybe-sent")).toBeNull();

    await act(async () => applyLocalePreference("en"));
    await settle();
    await act(async () => resolveSend(accepted("c1")));
    await settle();
    // 不替人删：发失败时删掉就丢了。提示先核对。
    expect(messageInput(node)?.value).toBe("已经点了发送的话");
    expect(q(node, "composer-maybe-sent")?.textContent).toContain(messagesFor("en").workbench.composer.maybeSent);
    expect(apiMocks.sendMessage).toHaveBeenCalledTimes(1);

    // 「知道了」收起提示；之后正常发送成功也会收起。
    await act(async () => [...(q(node, "composer-maybe-sent")?.querySelectorAll("button") ?? [])][0]?.click());
    expect(q(node, "composer-maybe-sent")).toBeNull();
  });

  it("停止请求在途：重建后不一直显示「停止中」，停止按钮照常可点；队列的「你点了停止」暂停照样带过去", async () => {
    apiMocks.interrupt.mockReturnValue(new Promise(() => undefined));
    const node = await render(<SessionRuntime projectId="p1" sessionId="s1" />);
    await settle();
    await act(async () => liveStream().emit("stream.live", {}));
    await enqueue(node, "等一下再发");
    await act(async () => q(node, "interrupt-turn")?.click());
    expect(q(node, "interrupt-turn")?.hasAttribute("disabled")).toBe(true);
    expect(switchWouldLoseWork()).toBe(true);

    await act(async () => applyLocalePreference("en"));
    await settle();
    expect(q(node, "interrupt-turn")?.hasAttribute("disabled")).toBe(false);
    expect(q(node, "queue-paused")?.getAttribute("data-reason")).toBe("user_stop");
  });
});

describe("重建期间先不动手的事，结束靠兜底计时器", () => {
  it("语言来回切、界面没真的重建：1 秒兜底结束后照常出队，只发一次", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      apiMocks.sendMessage.mockResolvedValue(accepted("c1"));
      const node = await render(<SessionRuntime projectId="p1" sessionId="s1" />);
      await settle();
      const stream = liveStream();
      await act(async () => stream.emit("stream.live", {}));
      await enqueue(node, "第二件事");
      const input = messageInput(node);

      await act(async () => {
        applyLocalePreference("en");
        applyLocalePreference("zh-CN");
      });
      // 最后没变：界面没重建（输入框还是原来那个），也就没有重建结束的那一下。
      expect(messageInput(node)).toBe(input);
      await act(async () => stream.emit("turn.completed", envelope(5, "turn.completed", "T1", { turn: { id: "T1", status: "completed" } })));
      await settle();
      expect(apiMocks.sendMessage).not.toHaveBeenCalled();

      await act(async () => vi.advanceTimersByTime(1_000));
      await settle();
      expect(apiMocks.sendMessage).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
