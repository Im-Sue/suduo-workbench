// @vitest-environment jsdom

import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import type { ListRoomsResponse, RoomEventDto } from "@suduo/cloud-contracts";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { MessagesData } from "../src/features/rooms/model.js";
import { agent, ME, message, room, run, share, shareRequest, signedInSettings, WANG } from "./fixtures/rooms.js";

const apiMocks = vi.hoisted(() => ({
  listRoomMessages: vi.fn(),
  listProjectRooms: vi.fn(),
  resolveShareRequest: vi.fn(),
  requirementsEventsUrl: () => "/api/v2/events",
}));
const messageMocks = vi.hoisted(() => ({ showMessage: vi.fn() }));

vi.mock("../src/api/client.js", () => ({
  api: apiMocks,
  ApiClientError: class ApiClientError extends Error {},
}));
vi.mock("../src/ui/message.js", () => ({ showMessage: messageMocks.showMessage }));

const { queryKeys } = await import("../src/app/queries.js");
const { roomKeys } = await import("../src/features/rooms/keys.js");
const { applyRoomEvent, attachRoomListeners, parseRoomEvent } = await import("../src/features/rooms/realtime.js");
const { messagesQuery, projectRoomsQuery } = await import("../src/features/rooms/queries.js");
const { setReadingRoom } = await import("../src/features/rooms/cache.js");
const { RequirementsRealtimeProvider } = await import("../src/features/requirements/realtime.js");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let client: QueryClient;
let root: Root | null = null;

const event = (patch: Partial<RoomEventDto> & Pick<RoomEventDto, "type">): RoomEventDto => ({
  id: 1,
  projectId: "p1",
  roomId: "room-1",
  occurredAt: "2026-09-30T09:00:00.000Z",
  ...patch,
});

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  client.setQueryData(queryKeys.settings, signedInSettings);
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  setReadingRoom("room-1", false);
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe("房间事件写缓存", () => {
  it("新消息：追加进主消息流与所在话题，话题根「N 条回复」+1；列表里未读 +1、@ 我记提醒", () => {
    client.setQueryData<MessagesData>(roomKeys.messages("room-1"), { items: [message({ id: "m-1", seq: 1 })], hasMoreBefore: false, lastSeq: 1 });
    client.setQueryData<MessagesData>(roomKeys.thread("room-1", "m-1"), { items: [message({ id: "m-1", seq: 1 })], hasMoreBefore: false, lastSeq: 1 });
    client.setQueryData<ListRoomsResponse>(roomKeys.projectRooms("p1"), { items: [room({ lastSeq: 1, viewer: { joined: true, lastReadSeq: 1, unreadCount: 0, mentionCount: 0 } })] });

    const reply = message({ id: "m-2", seq: 2, threadRootId: "m-1", mentions: [{ kind: "user", id: ME.id, label: ME.displayName }] });
    applyRoomEvent(client, event({ type: "room.message", message: reply }));

    const main = client.getQueryData<MessagesData>(roomKeys.messages("room-1"));
    expect(main?.items.map((item) => item.id)).toEqual(["m-1", "m-2"]);
    expect(main?.items[0]?.thread?.replyCount).toBe(1);
    const thread = client.getQueryData<MessagesData>(roomKeys.thread("room-1", "m-1"));
    expect(thread?.items.map((item) => item.id)).toEqual(["m-1", "m-2"]);
    const list = client.getQueryData<ListRoomsResponse>(roomKeys.projectRooms("p1"));
    expect(list?.items[0]?.viewer).toMatchObject({ unreadCount: 1, mentionCount: 1 });

    // 同一条再推一次（重连补发）：不重复。
    applyRoomEvent(client, event({ type: "room.message", message: reply }));
    expect(client.getQueryData<MessagesData>(roomKeys.messages("room-1"))?.items).toHaveLength(2);
    expect(client.getQueryData<ListRoomsResponse>(roomKeys.projectRooms("p1"))?.items[0]?.viewer.unreadCount).toBe(1);
  });

  it("未读按消息 id 去重：乱序晚到的较早消息照样算，广播里提前推高的最大序号不影响，同一条再来不重复", () => {
    client.setQueryData<ListRoomsResponse>(roomKeys.projectRooms("p1"), {
      items: [room({ lastSeq: 3, viewer: { joined: true, lastReadSeq: 3, unreadCount: 0, mentionCount: 0 } })],
    });
    const unread = () => client.getQueryData<ListRoomsResponse>(roomKeys.projectRooms("p1"))?.items[0]?.viewer.unreadCount;

    applyRoomEvent(client, event({ type: "room.message", message: message({ id: "m-5", seq: 5 }) }));
    applyRoomEvent(client, event({ type: "room.message", message: message({ id: "m-4", seq: 4 }) }));
    expect(unread()).toBe(2);

    // 房间广播（改名等）带的最大序号先到了 7：随后到的 6、7 照样算。
    applyRoomEvent(client, event({ type: "room.changed", room: room({ lastSeq: 7, viewer: { joined: false, lastReadSeq: 0, unreadCount: 0, mentionCount: 0 } }) }));
    applyRoomEvent(client, event({ type: "room.message", message: message({ id: "m-7", seq: 7 }) }));
    applyRoomEvent(client, event({ type: "room.message", message: message({ id: "m-6", seq: 6 }) }));
    expect(unread()).toBe(4);

    // 重连补发：同一条再来一次不重复。
    applyRoomEvent(client, event({ type: "room.message", message: message({ id: "m-6", seq: 6 }) }));
    expect(unread()).toBe(4);
  });

  it("列表从服务端取回后：它已算进未读的消息（序号不超过列表的最大序号）晚到也不重复加，之后的照常加", async () => {
    apiMocks.listProjectRooms.mockResolvedValueOnce({
      items: [room({ lastSeq: 8, viewer: { joined: true, lastReadSeq: 3, unreadCount: 5, mentionCount: 0 } })],
    });
    await client.fetchQuery(projectRoomsQuery("p1"));
    const unread = () => client.getQueryData<ListRoomsResponse>(roomKeys.projectRooms("p1"))?.items[0]?.viewer.unreadCount;
    applyRoomEvent(client, event({ type: "room.message", message: message({ id: "m-8", seq: 8 }) }));
    expect(unread()).toBe(5);
    applyRoomEvent(client, event({ type: "room.message", message: message({ id: "m-9", seq: 9 }) }));
    expect(unread()).toBe(6);
  });

  it("正在看这个房间（前台且在底部）：新消息不算未读", () => {
    client.setQueryData<ListRoomsResponse>(roomKeys.projectRooms("p1"), { items: [room({ lastSeq: 1 })] });
    setReadingRoom("room-1", true);
    applyRoomEvent(client, event({ type: "room.message", message: message({ id: "m-2", seq: 2 }) }));
    expect(client.getQueryData<ListRoomsResponse>(roomKeys.projectRooms("p1"))?.items[0]?.viewer.unreadCount).toBe(0);
  });

  it("任务状态：写回触发消息下的状态行（主消息流与话题），运行详情失效重取", () => {
    client.setQueryData<MessagesData>(roomKeys.messages("room-1"), { items: [message({ id: "m-2", seq: 2, runs: [run()] })], hasMoreBefore: false, lastSeq: 2 });
    client.setQueryData<MessagesData>(roomKeys.thread("room-1", "m-2"), { items: [message({ id: "m-2", seq: 2, runs: [run()] })], hasMoreBefore: false, lastSeq: 2 });
    client.setQueryData(roomKeys.run("run-1"), { ...run(), events: [] });
    applyRoomEvent(client, event({ type: "room.run", run: run({ status: "running", progress: "查看了 6 个文件" }) }));
    expect(client.getQueryData<MessagesData>(roomKeys.messages("room-1"))?.items[0]?.runs[0]).toMatchObject({ status: "running", progress: "查看了 6 个文件" });
    expect(client.getQueryData<MessagesData>(roomKeys.thread("room-1", "m-2"))?.items[0]?.runs[0]?.status).toBe("running");
    expect(client.getQueryState(roomKeys.run("run-1"))?.isInvalidated).toBe(true);
  });

  it("共享、申请、在线：写进对应缓存；申请给所有者发提醒（带「开启共享」）", () => {
    client.setQueryData(roomKeys.shares("room-1"), { items: [share()] });
    client.setQueryData(roomKeys.shareRequests("room-1"), { items: [] });
    client.setQueryData(roomKeys.agents, { items: [agent()] });
    client.setQueryData(roomKeys.members("room-1"), { items: [{ user: WANG, joinedAt: null, online: true }] });

    applyRoomEvent(client, event({ type: "room.shares", share: share({ active: false, closedAt: "2026-09-30T10:00:00.000Z" }) }));
    expect(client.getQueryData<{ items: { active: boolean }[] }>(roomKeys.shares("room-1"))?.items[0]?.active).toBe(false);

    const mine = agent({ id: "agent-me", owner: ME });
    applyRoomEvent(client, event({ type: "room.share_request", shareRequest: shareRequest({ agent: mine, requester: WANG }) }));
    expect(client.getQueryData<{ items: unknown[] }>(roomKeys.shareRequests("room-1"))?.items).toHaveLength(1);
    expect(messageMocks.showMessage).toHaveBeenCalledWith(
      expect.stringContaining("小王 想在"),
      "info",
      expect.objectContaining({ action: expect.objectContaining({ label: "开启共享" }) }),
    );
    // 处理过的申请移出待处理。
    applyRoomEvent(client, event({ type: "room.share_request", shareRequest: shareRequest({ agent: mine, requester: WANG, status: "ignored" }) }));
    expect(client.getQueryData<{ items: unknown[] }>(roomKeys.shareRequests("room-1"))?.items).toHaveLength(0);

    applyRoomEvent(client, event({ type: "agent.presence", agent: agent({ online: false }) }));
    expect(client.getQueryData<{ items: { online: boolean }[] }>(roomKeys.agents)?.items[0]?.online).toBe(false);
    applyRoomEvent(client, event({ type: "user.presence", user: { id: WANG.id, online: false } }));
    expect(client.getQueryData<{ items: { online: boolean }[] }>(roomKeys.members("room-1"))?.items[0]?.online).toBe(false);
  });

  it("房间变了（改名 / 归档）：推送里的 viewer 是中性值，保留本地的未读", () => {
    client.setQueryData<ListRoomsResponse>(roomKeys.projectRooms("p1"), {
      items: [room({ viewer: { joined: true, lastReadSeq: 1, unreadCount: 4, mentionCount: 1 } })],
    });
    applyRoomEvent(client, event({ type: "room.changed", room: room({ name: "订单中心（新）", archivedAt: "2026-09-30T10:00:00.000Z", viewer: { joined: false, lastReadSeq: 0, unreadCount: 0, mentionCount: 0 } }) }));
    const updated = client.getQueryData<ListRoomsResponse>(roomKeys.projectRooms("p1"))?.items[0];
    expect(updated).toMatchObject({ name: "订单中心（新）", archivedAt: "2026-09-30T10:00:00.000Z" });
    expect(updated?.viewer).toEqual({ joined: true, lastReadSeq: 1, unreadCount: 4, mentionCount: 1 });
  });

  it("只认契约里的房间事件类型", () => {
    expect(parseRoomEvent(JSON.stringify(event({ type: "room.message" })))?.type).toBe("room.message");
    expect(parseRoomEvent(JSON.stringify({ ...event({ type: "room.message" }), type: "room.unknown" }))).toBeNull();
    expect(parseRoomEvent("not json")).toBeNull();
  });
});

describe("断线补拉", () => {
  class FakeEventSource {
    static instances: FakeEventSource[] = [];
    onopen: ((event: Event) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;
    onmessage: ((event: MessageEvent<string>) => void) | null = null;
    readonly listeners = new Map<string, ((event: MessageEvent<string>) => void)[]>();
    readonly close = vi.fn();
    constructor(readonly url: string) {
      FakeEventSource.instances.push(this);
    }
    addEventListener(name: string, listener: (event: MessageEvent<string>) => void): void {
      this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
    }
    removeEventListener(): void {}
    emit(name: string, data = ""): void {
      for (const listener of this.listeners.get(name) ?? []) listener(new MessageEvent(name, { data }));
    }
  }

  function OpenRoom() {
    useQuery(messagesQuery(client, "room-1"));
    return null;
  }

  async function mountOpenRoom() {
    apiMocks.listRoomMessages.mockResolvedValueOnce({
      items: [message({ id: "m-1", seq: 1 }), message({ id: "m-2", seq: 2 })],
      hasMoreBefore: false,
      hasMoreAfter: false,
      lastSeq: 2,
    });
    root = createRoot(document.createElement("div"));
    await act(async () =>
      root?.render(
        <QueryClientProvider client={client}>
          <RequirementsRealtimeProvider enabled>
            <OpenRoom />
          </RequirementsRealtimeProvider>
        </QueryClientProvider>,
      ),
    );
    expect(apiMocks.listRoomMessages).toHaveBeenLastCalledWith("room-1", { limit: 50 }, expect.anything());
  }

  it("同一条 /api/v2/events 上收房间命名事件；room-resync 后按 after=<本地最大序号> 补拉并合并", async () => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    await mountOpenRoom();
    expect(FakeEventSource.instances).toHaveLength(1);
    const source = FakeEventSource.instances[0]!;
    expect(source.url).toBe("/api/v2/events");

    await act(async () => source.emit("room", JSON.stringify(event({ type: "room.message", message: message({ id: "m-3", seq: 3 }) }))));
    expect(client.getQueryData<MessagesData>(roomKeys.messages("room-1"))?.items.map((item) => item.seq)).toEqual([1, 2, 3]);

    apiMocks.listRoomMessages
      .mockResolvedValueOnce({ items: [message({ id: "m-4", seq: 4 })], hasMoreBefore: false, hasMoreAfter: true, lastSeq: 5 })
      .mockResolvedValueOnce({ items: [message({ id: "m-5", seq: 5 })], hasMoreBefore: false, hasMoreAfter: false, lastSeq: 5 });
    await act(async () => {
      source.emit("room-resync");
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(apiMocks.listRoomMessages.mock.calls.slice(-2).map((call) => call[1])).toEqual([
      { after: 3, limit: 50 },
      { after: 4, limit: 50 },
    ]);
    expect(client.getQueryData<MessagesData>(roomKeys.messages("room-1"))?.items.map((item) => item.seq)).toEqual([1, 2, 3, 4, 5]);
  });

  it("浏览器自己的连接断线重连成功后同样补拉", async () => {
    FakeEventSource.instances = [];
    vi.useFakeTimers();
    vi.stubGlobal("EventSource", FakeEventSource);
    try {
      await mountOpenRoom();
      const first = FakeEventSource.instances[0]!;
      await act(async () => first.onopen?.(new Event("open")));
      await act(async () => first.onerror?.(new Event("error")));
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1_000);
      });
      const second = FakeEventSource.instances[1]!;
      apiMocks.listRoomMessages.mockResolvedValueOnce({ items: [], hasMoreBefore: false, hasMoreAfter: false, lastSeq: 2 });
      await act(async () => {
        second.onopen?.(new Event("open"));
        await vi.advanceTimersByTimeAsync(0);
      });
      expect(apiMocks.listRoomMessages).toHaveBeenLastCalledWith("room-1", { after: 2, limit: 50 }, expect.anything());
    } finally {
      vi.useRealTimers();
    }
  });

  it("没在看的房间：补拉时丢掉它的消息与话题缓存（不留缺口），重连后的实时消息不写进去，再打开时整页重取", async () => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
    // A 房间（room-9）之前看过，缓存停在 50；现在没人在看。
    const stale: MessagesData = { items: [message({ id: "a-50", roomId: "room-9", seq: 50 })], hasMoreBefore: true, lastSeq: 50 };
    client.setQueryData<MessagesData>(roomKeys.messages("room-9"), stale);
    client.setQueryData<MessagesData>(roomKeys.thread("room-9", "a-50"), stale);
    await mountOpenRoom();
    const source = FakeEventSource.instances[0]!;

    // 断线期间 A 房间来了 51–59；重连（room-resync）：在看的房间增量补拉，A 房间的缓存直接丢掉。
    apiMocks.listRoomMessages.mockResolvedValueOnce({ items: [], hasMoreBefore: false, hasMoreAfter: false, lastSeq: 2 });
    await act(async () => {
      source.emit("room-resync");
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(apiMocks.listRoomMessages).toHaveBeenLastCalledWith("room-1", { after: 2, limit: 50 }, expect.anything());
    expect(client.getQueryData(roomKeys.messages("room-9"))).toBeUndefined();
    expect(client.getQueryData(roomKeys.thread("room-9", "a-50"))).toBeUndefined();
    expect(client.getQueryData<MessagesData>(roomKeys.messages("room-1"))?.items.map((item) => item.seq)).toEqual([1, 2]);

    // 重连后实时来了 60：A 房间没有缓存，不会凭空建出一份只有 60 的。
    await act(async () => source.emit("room", JSON.stringify(event({ type: "room.message", roomId: "room-9", message: message({ id: "a-60", roomId: "room-9", seq: 60 }) }))));
    expect(client.getQueryData(roomKeys.messages("room-9"))).toBeUndefined();

    // 回到 A 房间：取最新一页（不带 after），51–59 都在。
    apiMocks.listRoomMessages.mockResolvedValueOnce({
      items: Array.from({ length: 11 }, (_, index) => message({ id: `a-${50 + index}`, roomId: "room-9", seq: 50 + index })),
      hasMoreBefore: true,
      hasMoreAfter: false,
      lastSeq: 60,
    });
    await act(async () => {
      await client.fetchQuery(messagesQuery(client, "room-9"));
    });
    expect(apiMocks.listRoomMessages).toHaveBeenLastCalledWith("room-9", { limit: 50 }, expect.anything());
    expect(client.getQueryData<MessagesData>(roomKeys.messages("room-9"))?.items.map((item) => item.seq)).toEqual([50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60]);
  });

  it("只听 room 与 room-resync 两个命名事件（ready 帧由本机 hub 自己消费，不会转到浏览器）", () => {
    const source = new FakeEventSource("/api/v2/events");
    attachRoomListeners(source as unknown as EventSource, client, () => true);
    expect([...source.listeners.keys()].toSorted()).toEqual(["room", "room-resync"]);
  });

  it("attachRoomListeners：旧连接（已被替换）上的事件不处理", () => {
    const source = new FakeEventSource("/api/v2/events");
    client.setQueryData<MessagesData>(roomKeys.messages("room-1"), { items: [], hasMoreBefore: false, lastSeq: 0 });
    attachRoomListeners(source as unknown as EventSource, client, () => false);
    source.emit("room", JSON.stringify(event({ type: "room.message", message: message() })));
    expect(client.getQueryData<MessagesData>(roomKeys.messages("room-1"))?.items).toHaveLength(0);
  });
});
