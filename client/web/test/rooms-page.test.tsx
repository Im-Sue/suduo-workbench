// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agent, member, ME, message, room, run, share, signedInSettings, WANG, ZHANG } from "./fixtures/rooms.js";

const apiMocks = vi.hoisted(() => ({
  addRoomMembers: vi.fn(),
  getAgentRun: vi.fn(),
  getRoom: vi.fn(),
  getSelfAgent: vi.fn(),
  listAgents: vi.fn(),
  listProjectRooms: vi.fn(),
  listRequirementsMappings: vi.fn(),
  listRoomMembers: vi.fn(),
  listRoomMessages: vi.fn(),
  listRoomShares: vi.fn(),
  listShareRequests: vi.fn(),
  listUsers: vi.fn(),
  markRoomRead: vi.fn(),
  requestAgentShare: vi.fn(),
  retryAgentRun: vi.fn(),
  roomFileUrl: (id: string, disposition?: string) => `/files/${id}${disposition === "inline" ? "?inline" : ""}`,
  sendRoomMessage: vi.fn(),
  stopAgentRun: vi.fn(),
  updateRoom: vi.fn(),
  uploadRoomFile: vi.fn(),
}));
const navigateMock = vi.hoisted(() => vi.fn());

vi.mock("../src/api/client.js", () => ({
  api: apiMocks,
  ApiClientError: class ApiClientError extends Error {
    constructor(
      readonly status: number,
      readonly code: string,
      message: string,
    ) {
      super(message);
    }
  },
}));

vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, params, search: _search, children, ...rest }: { to: string; params?: Record<string, string>; search?: unknown; children?: ReactNode } & Record<string, unknown>) => {
    void _search;
    const href = Object.entries(params ?? {}).reduce((path, [key, value]) => path.replace(`$${key}`, value), to);
    return (
      <a href={href} {...rest}>
        {children}
      </a>
    );
  },
  Navigate: (props: Record<string, unknown>) => {
    navigateMock(props);
    return null;
  },
  useNavigate: () => navigateMock,
}));

const { TooltipProvider } = await import("@/components/ui/tooltip");
const { queryKeys } = await import("../src/app/queries.js");
const { RoomsPage } = await import("../src/features/rooms/RoomsPage.js");
const { RoomFiles } = await import("../src/features/rooms/components/RoomFile.js");
const { resetDrafts } = await import("../src/features/rooms/drafts.js");
const { resetPendingMessages } = await import("../src/features/rooms/pending.js");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let client: QueryClient;
let root: Root | null = null;
let container: HTMLDivElement | null = null;

const defaultRoom = room({ lastSeq: 2, viewer: { joined: true, lastReadSeq: 2, unreadCount: 0, mentionCount: 0 } });
const reqRoom = room({
  id: "room-2",
  kind: "requirement",
  name: "REQ-1 讨论",
  requirement: { id: "r1", number: 1, title: "商家端-订单详情优化" },
  viewer: { joined: true, lastReadSeq: 0, unreadCount: 4, mentionCount: 1 },
});
const archivedRoom = room({ id: "room-3", kind: "requirement", name: "REQ-7 联调", archivedAt: "2026-09-29T00:00:00.000Z", requirement: { id: "r7", number: 7, title: "联调" } });
const offlineAgent = agent({ id: "a-off", owner: ZHANG, deviceName: "ThinkPad", label: "小张 的 Codex · ThinkPad", online: false });
const unsharedAgent = agent({ id: "a-chen", owner: { id: "u-chen", displayName: "陈思远" }, deviceName: "iMac", label: "陈思远 的 Codex · iMac" });

function seed() {
  client.setQueryData(queryKeys.settings, signedInSettings);
  apiMocks.listProjectRooms.mockResolvedValue({ items: [reqRoom, defaultRoom, archivedRoom] });
  apiMocks.getRoom.mockImplementation(async (id: string) => [defaultRoom, reqRoom, archivedRoom].find((item) => item.id === id));
  apiMocks.listRoomMessages.mockImplementation(async (_roomId: string, query: { threadRootId?: string }) =>
    query.threadRootId === undefined
      ? {
          items: [
            message({ id: "m-1", seq: 1, body: "订单详情页的收货信息谁在看？", thread: { replyCount: 2, lastReplyAt: "2026-09-30T09:05:00.000Z", lastRepliers: [ZHANG] } }),
            message({
              id: "m-2",
              seq: 2,
              author: ME,
              body: "@小王的Codex 商家后台的订单详情现在能拿到收货信息吗？",
              mentions: [{ kind: "agent", id: "agent-wang", label: "小王 的 Codex · MacBook Pro" }],
              runs: [run({ status: "completed", summary: "后端已有 receiverSnapshot，前端抽屉没展示", startedAt: "2026-09-30T09:00:00.000Z", finishedAt: "2026-09-30T09:02:14.000Z" })],
            }),
          ],
          hasMoreBefore: true,
          hasMoreAfter: false,
          lastSeq: 2,
        }
      : {
          items: [
            message({ id: "m-2", seq: 2, author: ME, body: "@小王的Codex 能拿到吗？", runs: [run({ status: "completed", summary: "后端已有", startedAt: "2026-09-30T09:00:00.000Z", finishedAt: "2026-09-30T09:02:14.000Z" })] }),
            message({ id: "m-3", seq: 3, threadRootId: "m-2", authorKind: "agent", author: WANG, agent: agent(), body: "**结论**：后端已有 receiverSnapshot。" }),
          ],
          hasMoreBefore: false,
          hasMoreAfter: false,
          lastSeq: 3,
        },
  );
  apiMocks.listRoomMembers.mockResolvedValue({ items: [member(ME), member(WANG), member(ZHANG, false)] });
  apiMocks.listAgents.mockResolvedValue({ items: [agent(), offlineAgent, unsharedAgent] });
  apiMocks.listRoomShares.mockResolvedValue({ items: [share(), share({ id: "share-off", agent: offlineAgent })] });
  apiMocks.listShareRequests.mockResolvedValue({ items: [] });
  apiMocks.getSelfAgent.mockResolvedValue({ status: "unregistered", agent: null, message: null, activeRun: null, queuedRuns: 0 });
  apiMocks.listRequirementsMappings.mockResolvedValue({ items: [] });
  apiMocks.markRoomRead.mockResolvedValue(undefined);
}

async function settle(rounds = 6): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function render(element: ReactElement): Promise<HTMLDivElement> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(
      <QueryClientProvider client={client}>
        <TooltipProvider>{element}</TooltipProvider>
      </QueryClientProvider>,
    ),
  );
  await settle();
  return container;
}

const q = (node: ParentNode, id: string) => node.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const all = (node: ParentNode, id: string) => [...node.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];

function input(node: ParentNode): HTMLTextAreaElement {
  const element = node.querySelector<HTMLTextAreaElement>('[data-testid="room-composer-input"]');
  if (element === null) throw new Error("找不到输入框");
  return element;
}

async function type(element: HTMLTextAreaElement, value: string): Promise<void> {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(element, value);
    element.setSelectionRange(value.length, value.length);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function key(element: HTMLElement, name: string, init: KeyboardEventInit = {}): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...init }));
  });
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seed();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  resetDrafts();
  resetPendingMessages();
  vi.clearAllMocks();
});

describe("讨论页", () => {
  it("不带房间时进项目默认房间", async () => {
    await render(<RoomsPage projectId="p1" roomId={null} search={{}} />);
    expect(navigateMock).toHaveBeenCalledWith(expect.objectContaining({ to: "/p/$projectId/rooms/$roomId", params: { projectId: "p1", roomId: "room-1" }, replace: true }));
  });

  it("房间列表：默认房间在最上，需求房间带编号、未读与 @ 标记，归档的折叠在底部", async () => {
    const node = await render(<RoomsPage projectId="p1" roomId="room-1" search={{}} />);
    const items = all(node, "room-list-item");
    expect(items.map((item) => item.getAttribute("data-room-id"))).toEqual(["room-1", "room-2"]);
    expect(items[0]?.getAttribute("aria-current")).toBe("page");
    expect(items[1]?.getAttribute("aria-label")).toBe("REQ-1 讨论，4 条未读，有人 @ 你");
    const toggle = [...node.querySelectorAll("button")].find((button) => button.textContent?.includes("已归档 1"));
    expect(toggle?.getAttribute("aria-expanded")).toBe("false");
    await act(async () => toggle?.click());
    expect(all(node, "room-list-item").map((item) => item.getAttribute("data-room-id"))).toContain("room-3");
  });

  it("查询失败按三态：说「查不到：原因」并给重试，不说成没有", async () => {
    apiMocks.listProjectRooms.mockRejectedValue(Object.assign(new Error("boom"), { status: 503, code: "UPSTREAM_UNAVAILABLE" }));
    const node = await render(<RoomsPage projectId="p1" roomId="room-1" search={{}} />);
    const error = q(q(node, "room-list") ?? node, "region-error");
    expect(error?.textContent).toContain("查不到讨论列表");
    expect(error?.querySelector("button")?.textContent).toContain("重试");
  });

  it("消息流：日期分隔、作者、@ 高亮、Agent 状态行、「N 条回复」；点状态行与回复打开话题", async () => {
    const node = await render(<RoomsPage projectId="p1" roomId="room-1" search={{}} />);
    expect(q(node, "room-header")?.textContent).toContain("# 订单中心");
    const stream = q(node, "room-message-stream");
    expect(stream?.querySelector('[role="separator"]')).not.toBeNull();
    const messages = all(node, "room-message");
    expect(messages).toHaveLength(2);
    expect(messages[1]?.querySelector('[data-mention="true"]')?.textContent).toBe("@小王的Codex");
    const status = q(node, "run-status");
    expect(status?.getAttribute("data-status")).toBe("completed");
    expect(status?.textContent).toContain("小王 的 Codex");
    expect(status?.textContent).toContain("已完成 · 后端已有 receiverSnapshot，前端抽屉没展示");
    expect(q(node, "thread-summary")?.textContent).toContain("2 条回复");
    expect(q(node, "room-load-older")?.textContent).toContain("更早的消息 · 加载更多");

    await act(async () => status?.querySelector("button")?.click());
    expect(navigateMock).toHaveBeenLastCalledWith(expect.objectContaining({ search: { thread: "m-2" } }));
    await act(async () => q(node, "thread-summary")?.click());
    expect(navigateMock).toHaveBeenLastCalledWith(expect.objectContaining({ search: { thread: "m-1" } }));
  });

  it("在底部且页面可见时记已读到最新序号", async () => {
    const roomWithUnread = { ...defaultRoom, viewer: { joined: true, lastReadSeq: 1, unreadCount: 1, mentionCount: 0 } };
    apiMocks.getRoom.mockResolvedValue(roomWithUnread);
    apiMocks.listProjectRooms.mockResolvedValue({ items: [roomWithUnread] });
    apiMocks.markRoomRead.mockResolvedValue({ joined: true, lastReadSeq: 2, unreadCount: 0, mentionCount: 0 });
    await render(<RoomsPage projectId="p1" roomId="room-1" search={{}} />);
    expect(apiMocks.markRoomRead).toHaveBeenCalledWith("room-1", 2);
    // 回执（记完后的「我的视角」）写回列表。
    const list = client.getQueryData<{ items: { viewer: { unreadCount: number; lastReadSeq: number } }[] }>(["rooms", "list", "project", "p1"]);
    expect(list?.items[0]?.viewer).toMatchObject({ unreadCount: 0, lastReadSeq: 2 });
  });
});

describe("发消息", () => {
  it("发送中先本地占位（灰），回执按 clientId 对齐替换；@ Agent 带进 mentions", async () => {
    let resolveSend: (value: unknown) => void = () => undefined;
    apiMocks.sendRoomMessage.mockImplementation(() => new Promise((resolve) => (resolveSend = resolve)));
    const node = await render(<RoomsPage projectId="p1" roomId="room-1" search={{}} />);
    const textarea = input(node);

    await type(textarea, "@小王");
    const options = all(document, "mention-option");
    expect(options.map((option) => option.getAttribute("data-kind"))).toEqual(["user", "agent"]);
    await key(textarea, "ArrowDown");
    await key(textarea, "Enter");
    expect(textarea.value).toBe("@小王的Codex ");
    await type(textarea, "@小王的Codex 历史订单也有吗？");
    await key(textarea, "Enter");

    expect(apiMocks.sendRoomMessage).toHaveBeenCalledTimes(1);
    const [roomId, body] = apiMocks.sendRoomMessage.mock.calls[0] as [string, { clientId: string; body: string; mentions: unknown; threadRootId: string | null }];
    expect(roomId).toBe("room-1");
    expect(body).toMatchObject({ body: "@小王的Codex 历史订单也有吗？", mentions: [{ kind: "agent", id: "agent-wang" }], threadRootId: null });
    expect(textarea.value).toBe("");
    const pending = q(node, "room-message-pending");
    expect(pending?.getAttribute("data-client-id")).toBe(body.clientId);
    expect(pending?.textContent).toContain("发送中");

    await act(async () =>
      resolveSend(message({ id: "m-9", seq: 9, author: ME, clientId: body.clientId, body: body.body, runs: [run({ id: "run-9", triggerMessageId: "m-9", threadRootId: "m-9", queuePosition: 1 })] })),
    );
    await settle(2);
    expect(q(node, "room-message-pending")).toBeNull();
    const sent = node.querySelector('[data-testid="room-message"][data-message-id="m-9"]');
    expect(sent?.querySelector('[data-testid="run-status"]')?.textContent).toContain("排队中（前面还有 1 个）");
  });

  it("失败：占位撤下、内容放回输入框并原地提示；重试沿用同一个 clientId", async () => {
    apiMocks.sendRoomMessage.mockRejectedValueOnce(Object.assign(new Error("网络断了"), { status: 0, code: "NETWORK_ERROR" }));
    const node = await render(<RoomsPage projectId="p1" roomId="room-1" search={{}} />);
    const textarea = input(node);
    await type(textarea, "收到");
    await key(textarea, "Enter");
    await settle(2);
    expect(q(node, "room-message-pending")).toBeNull();
    expect(textarea.value).toBe("收到");
    expect(q(node, "room-send-error")?.textContent).toContain("没能发出");
    const firstId = (apiMocks.sendRoomMessage.mock.calls[0]?.[1] as { clientId: string }).clientId;

    apiMocks.sendRoomMessage.mockResolvedValueOnce(message({ id: "m-10", seq: 10, author: ME, clientId: firstId, body: "收到" }));
    const retry = [...(q(node, "room-send-error")?.querySelectorAll("button") ?? [])].find((button) => button.textContent?.includes("重试"));
    await act(async () => retry?.click());
    await settle(2);
    expect((apiMocks.sendRoomMessage.mock.calls[1]?.[1] as { clientId: string }).clientId).toBe(firstId);
    expect(q(node, "room-send-error")).toBeNull();
    expect(node.querySelector('[data-message-id="m-10"]')).not.toBeNull();
  });

  it("Shift+Enter 换行、拼音选字的回车不发送", async () => {
    const node = await render(<RoomsPage projectId="p1" roomId="room-1" search={{}} />);
    const textarea = input(node);
    await type(textarea, "第一行");
    await key(textarea, "Enter", { shiftKey: true });
    await key(textarea, "Enter", { isComposing: true });
    expect(apiMocks.sendRoomMessage).not.toHaveBeenCalled();
  });

  it("@ 候选：可用的可选；未共享的置灰、回车即申请共享（不插入）", async () => {
    apiMocks.requestAgentShare.mockResolvedValue({});
    const node = await render(<RoomsPage projectId="p1" roomId="room-1" search={{}} />);
    const textarea = input(node);
    await type(textarea, "@");
    const options = all(document, "mention-option");
    const byAgent = (label: string) => options.find((option) => option.textContent?.includes(label));
    expect(byAgent("小王 的 Codex")?.getAttribute("data-availability")).toBe("available");
    expect(byAgent("小王 的 Codex")?.hasAttribute("aria-disabled")).toBe(false);
    const unshared = byAgent("陈思远 的 Codex");
    expect(unshared?.getAttribute("data-availability")).toBe("unshared");
    expect(unshared?.textContent).toContain("未共享 · 回车申请共享");
    expect(options.some((option) => option.getAttribute("data-kind") === "all")).toBe(true);

    await act(async () => unshared?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    await settle(2);
    expect(apiMocks.requestAgentShare).toHaveBeenCalledWith("room-1", "a-chen");
    expect(textarea.value).toBe("@");
    expect(q(document, "mention-picker")).toBeNull();
  });

  it("@ 离线 Agent（已共享到本房间）：置灰标「离线」但可以选，提示不会执行、之后可重试；发出去带上它", async () => {
    apiMocks.sendRoomMessage.mockResolvedValue(message({ id: "m-20", seq: 20, author: ME, body: "@小张的Codex 看下日志" }));
    const node = await render(<RoomsPage projectId="p1" roomId="room-1" search={{}} />);
    const textarea = input(node);
    await type(textarea, "@小张");
    const offline = all(document, "mention-option").find((option) => option.textContent?.includes("小张 的 Codex"));
    expect(offline?.getAttribute("data-availability")).toBe("offline");
    expect(offline?.hasAttribute("aria-disabled")).toBe(false);
    expect(offline?.textContent).toContain("离线");
    expect(offline?.className).toContain("text-subtle-foreground");
    expect(offline?.getAttribute("title")).toBe("离线时 @ 不会执行，之后可在消息上重试");

    // 真人「小张」在前；↓ 到离线 Agent 上，选择框底部出现提示。
    await key(textarea, "ArrowDown");
    expect(q(document, "mention-picker")?.textContent).toContain("离线时 @ 不会执行，之后可在消息上重试");
    await key(textarea, "Enter");
    expect(textarea.value).toBe("@小张的Codex ");
    await type(textarea, "@小张的Codex 看下日志");
    await key(textarea, "Enter");
    await settle(2);
    expect(apiMocks.sendRoomMessage).toHaveBeenCalledWith("room-1", expect.objectContaining({ mentions: [{ kind: "agent", id: "a-off" }] }));
  });

  it("当前候选不能选（自己的 Agent 还没共享）时回车不被吞掉：照常发送", async () => {
    const mine = agent({ id: "a-mine", owner: ME, deviceName: "MacBook Air", label: "李娜 的 Codex · MacBook Air" });
    apiMocks.listAgents.mockResolvedValue({ items: [agent(), mine] });
    apiMocks.sendRoomMessage.mockResolvedValue(message({ id: "m-21", seq: 21, author: ME, body: "问下@李娜" }));
    const node = await render(<RoomsPage projectId="p1" roomId="room-1" search={{}} />);
    const textarea = input(node);
    await type(textarea, "问下@李娜");
    const option = q(document, "mention-option");
    expect(option?.textContent).toContain("未共享 · 在「共享 Agent」里开启");
    expect(option?.getAttribute("aria-disabled")).toBe("true");
    await key(textarea, "Enter");
    await settle(2);
    expect(apiMocks.sendRoomMessage).toHaveBeenCalledWith("room-1", expect.objectContaining({ body: "问下@李娜" }));
    expect(q(document, "mention-picker")).toBeNull();
  });

  it("输入框按组合框标注：role、展开状态、关联的候选列表、当前项", async () => {
    const node = await render(<RoomsPage projectId="p1" roomId="room-1" search={{}} />);
    const textarea = input(node);
    expect(textarea.getAttribute("role")).toBe("combobox");
    expect(textarea.getAttribute("aria-autocomplete")).toBe("list");
    expect(textarea.getAttribute("aria-expanded")).toBe("false");
    await type(textarea, "@");
    expect(textarea.getAttribute("aria-expanded")).toBe("true");
    const listbox = document.querySelector('[role="listbox"]');
    expect(listbox?.id).not.toBe("");
    expect(textarea.getAttribute("aria-controls")).toBe(listbox?.id);
    expect(textarea.getAttribute("aria-activedescendant")).toBe(all(document, "mention-option")[0]?.id);
  });

  it("文件：选好就上传（带进度），传完才能发，发送带 fileIds；可移除", async () => {
    let finish: (value: unknown) => void = () => undefined;
    let progress: (percent: number) => void = () => undefined;
    apiMocks.uploadRoomFile.mockImplementation((_roomId: string, _file: File, onProgress: (percent: number) => void) => {
      progress = onProgress;
      return new Promise((resolve) => (finish = resolve));
    });
    apiMocks.sendRoomMessage.mockResolvedValue(message({ id: "m-12", seq: 12, author: ME, body: "" }));
    const node = await render(<RoomsPage projectId="p1" roomId="room-1" search={{}} />);
    const picker = node.querySelector<HTMLInputElement>('input[type="file"]');
    const file = new File(["png"], "截图.png", { type: "image/png" });
    await act(async () => {
      Object.defineProperty(picker, "files", { value: [file], configurable: true });
      picker?.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(apiMocks.uploadRoomFile).toHaveBeenCalledWith("room-1", file, expect.any(Function), expect.any(AbortSignal));
    await act(async () => progress(40));
    const chip = q(node, "room-draft-file");
    expect(chip?.getAttribute("data-state")).toBe("uploading");
    expect(chip?.querySelector('[role="progressbar"]')?.getAttribute("aria-valuenow")).toBe("40");
    expect(node.querySelector<HTMLButtonElement>('[data-testid="room-send"]')?.disabled).toBe(true);

    await act(async () => finish({ id: "f-1", roomId: "room-1", fileName: "截图.png", contentType: "image/png", kind: "image", sizeBytes: 3, sha256: "x", uploadedBy: ME, createdAt: "2026-09-30T09:00:00.000Z" }));
    await settle(2);
    expect(q(node, "room-draft-file")?.getAttribute("data-state")).toBe("done");
    await act(async () => q(node, "room-send")?.click());
    await settle(2);
    expect(apiMocks.sendRoomMessage).toHaveBeenCalledWith("room-1", expect.objectContaining({ body: "", fileIds: ["f-1"] }));
    expect(q(node, "room-draft-file")).toBeNull();

    // 再选一个、传到一半移除：中止上传，不留在草稿里。
    let aborted = false;
    apiMocks.uploadRoomFile.mockImplementation((_roomId: string, _file: File, _onProgress: unknown, signal: AbortSignal) => {
      signal.addEventListener("abort", () => (aborted = true));
      return new Promise(() => undefined);
    });
    await act(async () => {
      Object.defineProperty(picker, "files", { value: [new File(["mp4"], "演示.mp4", { type: "video/mp4" })], configurable: true });
      picker?.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => node.querySelector<HTMLButtonElement>('button[aria-label="移除 演示.mp4"]')?.click());
    expect(aborted).toBe(true);
    expect(q(node, "room-draft-file")).toBeNull();
  });

  it("归档的房间禁用输入并说明", async () => {
    apiMocks.getRoom.mockResolvedValue(archivedRoom);
    const node = await render(<RoomsPage projectId="p1" roomId="room-3" search={{}} />);
    expect(node.querySelector('[data-testid="room-composer-input"]')).toBeNull();
    expect(q(node, "room-composer-archived")?.textContent).toContain("已归档");
  });
});

describe("话题面板与运行详情", () => {
  it("原消息 → 任务状态卡（状态、用时、查看详情）→ Agent 的完整回答 → 回复话题", async () => {
    const node = await render(<RoomsPage projectId="p1" roomId="room-1" search={{ thread: "m-2" }} />);
    const panel = q(node, "thread-panel");
    expect(panel?.getAttribute("data-root-id")).toBe("m-2");
    const card = q(panel ?? node, "run-card");
    expect(card?.getAttribute("data-status")).toBe("completed");
    expect(card?.textContent).toContain("已完成");
    expect(card?.textContent).toContain("用时 2 分 14 秒");
    const answer = panel?.querySelector('[data-message-id="m-3"]');
    expect(answer?.getAttribute("data-kind")).toBe("agent");
    expect(answer?.textContent).toContain("小王 的 Codex");
    expect(answer?.querySelector("strong")?.textContent).toBe("结论");
    expect(panel?.querySelector('[data-testid="room-composer-input"]')?.getAttribute("placeholder")).toContain("回复话题");

    await act(async () => q(card ?? node, "run-view-detail")?.click());
    expect(navigateMock).toHaveBeenLastCalledWith(expect.objectContaining({ search: { thread: "m-2", run: "run-1" } }));
  });

  it("在话题里回复：发到这个话题（threadRootId）", async () => {
    apiMocks.sendRoomMessage.mockResolvedValue(message({ id: "m-11", seq: 11, author: ME, threadRootId: "m-2", body: "@小王的Codex 历史订单也有吗？" }));
    const node = await render(<RoomsPage projectId="p1" roomId="room-1" search={{ thread: "m-2" }} />);
    const panel = q(node, "thread-panel");
    const textarea = input(panel ?? node);
    await type(textarea, "历史订单也有吗？");
    await key(textarea, "Enter");
    await settle(2);
    expect(apiMocks.sendRoomMessage).toHaveBeenCalledWith("room-1", expect.objectContaining({ threadRootId: "m-2", body: "历史订单也有吗？" }));
    expect(panel?.querySelector('[data-message-id="m-11"]')).not.toBeNull();
  });

  it("运行详情：用会话时间线同一套投影渲染执行过程（只读）", async () => {
    apiMocks.getAgentRun.mockResolvedValue({
      ...run({ status: "completed", startedAt: "2026-09-30T09:00:00.000Z", finishedAt: "2026-09-30T09:02:14.000Z" }),
      events: [
        { schemaVersion: 1, seq: 1, eventId: "e1", sessionId: "s", source: "codex", type: "turn.started", payload: { turn: { id: "T1" } }, threadRef: null, turnRef: { threadId: "t", turnId: "T1" }, ts: 1_000 },
        {
          schemaVersion: 1,
          seq: 2,
          eventId: "e2",
          sessionId: "s",
          source: "codex",
          type: "item.completed",
          payload: { item: { id: "c1", type: "commandExecution", command: "rg receiverSnapshot", status: "completed", durationMs: 40, commandActions: [{ type: "search", command: "rg receiverSnapshot", query: "receiverSnapshot", path: null }] } },
          threadRef: null,
          turnRef: { threadId: "t", turnId: "T1" },
          ts: 2_000,
        },
        { schemaVersion: 1, seq: 3, eventId: "e3", sessionId: "s", source: "codex", type: "item.completed", payload: { item: { id: "m1", type: "agentMessage", text: "后端已有 receiverSnapshot" } }, threadRef: null, turnRef: { threadId: "t", turnId: "T1" }, ts: 3_000 },
        { schemaVersion: 1, seq: 4, eventId: "e4", sessionId: "s", source: "codex", type: "turn.completed", payload: { turn: { id: "T1", status: "completed" } }, threadRef: null, turnRef: { threadId: "t", turnId: "T1" }, ts: 4_000 },
        "坏数据会被跳过",
      ],
    });
    const node = await render(<RoomsPage projectId="p1" roomId="room-1" search={{ thread: "m-2", run: "run-1" }} />);
    const detail = q(node, "run-detail");
    expect(detail?.getAttribute("data-status")).toBe("completed");
    expect(q(detail ?? node, "conversation-stream")?.textContent).toContain("后端已有 receiverSnapshot");
    const back = [...(detail?.querySelectorAll("button") ?? [])].find((button) => button.textContent?.includes("返回话题"));
    await act(async () => back?.click());
    expect(navigateMock).toHaveBeenLastCalledWith(expect.objectContaining({ search: { thread: "m-2" } }));
  });

  it("回复多于一页：根消息单独取回、始终显示在最上面；「加载更早的回复」按最早一条回复的序号往前翻", async () => {
    const root = message({ id: "m-old", seq: 1, body: "很早的话题", thread: { replyCount: 3, lastReplyAt: "2026-09-30T09:05:00.000Z", lastRepliers: [ZHANG] } });
    const reply = (seq: number) => message({ id: `r-${seq}`, seq, threadRootId: "m-old", author: ZHANG, body: `回复 ${seq}` });
    apiMocks.listRoomMessages.mockImplementation(async (_roomId: string, query: { threadRootId?: string; before?: number; after?: number }) => {
      if (query.threadRootId === undefined) return { items: [message({ id: "m-9", seq: 9 })], hasMoreBefore: true, hasMoreAfter: false, lastSeq: 9 };
      if (query.after === 0) return { items: [root], hasMoreBefore: false, hasMoreAfter: true, lastSeq: 9 };
      if (query.before !== undefined) return { items: [root, reply(2)], hasMoreBefore: false, hasMoreAfter: true, lastSeq: 9 };
      return { items: [reply(3), reply(4)], hasMoreBefore: true, hasMoreAfter: false, lastSeq: 9 };
    });
    const node = await render(<RoomsPage projectId="p1" roomId="room-1" search={{ thread: "m-old" }} />);
    const panel = q(node, "thread-panel") ?? node;
    expect(apiMocks.listRoomMessages).toHaveBeenCalledWith("room-1", { threadRootId: "m-old", after: 0, limit: 1 }, expect.anything());
    const ids = () => [...panel.querySelectorAll('[data-testid="room-message"]')].map((item) => item.getAttribute("data-message-id"));
    expect(ids()).toEqual(["m-old", "r-3", "r-4"]);
    expect(panel.textContent).toContain("3 条回复");

    await act(async () => q(panel, "thread-load-older")?.click());
    await settle(2);
    expect(apiMocks.listRoomMessages).toHaveBeenLastCalledWith("room-1", { threadRootId: "m-old", before: 3, limit: 200 });
    expect(ids()).toEqual(["m-old", "r-2", "r-3", "r-4"]);
    expect(q(panel, "thread-load-older")).toBeNull();
  });

  it("运行详情查不到：说原因并给重试", async () => {
    apiMocks.getAgentRun.mockRejectedValue(Object.assign(new Error("没有这个任务"), { status: 404, code: "NOT_FOUND" }));
    const node = await render(<RoomsPage projectId="p1" roomId="room-1" search={{ thread: "m-2", run: "run-x" }} />);
    expect(q(q(node, "run-detail") ?? node, "region-error")?.textContent).toContain("查不到执行过程");
  });
});

describe("消息里的文件", () => {
  const file = (id: string, fileName: string, contentType: string) => ({
    id,
    roomId: "room-1",
    fileName,
    contentType,
    kind: "image" as const,
    sizeBytes: 10,
    sha256: "x",
    uploadedBy: ME,
    createdAt: "2026-09-30T09:00:00.000Z",
  });

  it("只给浏览器能显示、远程会内联的图片出缩略图；svg / heic 按文件卡片；缩略图显示不了退回文件卡片", async () => {
    const node = await render(
      <RoomFiles files={[file("f-png", "截图.png", "image/png"), file("f-svg", "图标.svg", "image/svg+xml"), file("f-heic", "照片.heic", "image/heic")]} />,
    );
    const images = [...node.querySelectorAll("img")];
    expect(images.map((image) => image.getAttribute("src"))).toEqual(["/files/f-png?inline"]);
    expect(all(node, "room-file-card").map((card) => card.textContent)).toEqual([expect.stringContaining("图标.svg"), expect.stringContaining("照片.heic")]);

    await act(async () => images[0]?.dispatchEvent(new Event("error")));
    expect(node.querySelectorAll("img")).toHaveLength(0);
    expect(all(node, "room-file-card")).toHaveLength(3);
  });
});
