// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { RoomDto } from "@suduo/cloud-contracts";
import { act, StrictMode, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agent, member, ME, message, room, run, share, signedInSettings, WANG, ZHANG } from "./fixtures/rooms.js";

/**
 * 切换语言不丢房间输入框的草稿（中英双语 S9）：悬浮的房间窗口在设置页也可能开着，
 * 在设置里切换语言时整棵界面按新语言重建，窗口、话题面板、草稿（含 @ 与文件）都要还在。
 * mock 与种子数据照抄 room-quick-access.test.tsx。
 */

const apiMocks = vi.hoisted(() => ({
  addRoomMembers: vi.fn(),
  createRequirementRoom: vi.fn(),
  getAgentRun: vi.fn(),
  getRoom: vi.fn(),
  getSelfAgent: vi.fn(),
  listAgents: vi.fn(),
  listProjectRooms: vi.fn(),
  listRequirementRooms: vi.fn(),
  listRequirementsMappings: vi.fn(),
  listRoomMembers: vi.fn(),
  listRoomMessages: vi.fn(),
  listRoomShares: vi.fn(),
  listShareRequests: vi.fn(),
  listUsers: vi.fn(),
  markRoomRead: vi.fn(),
  requestAgentShare: vi.fn(),
  retryAgentRun: vi.fn(),
  roomFileUrl: (id: string) => `/files/${id}`,
  sendRoomMessage: vi.fn(),
  stopAgentRun: vi.fn(),
  updateRoom: vi.fn(),
  uploadRoomFile: vi.fn(),
}));
const navigateMock = vi.hoisted(() => vi.fn());
const projectState = vi.hoisted(() => ({ project: { id: "p1", name: "订单中心" } as { id: string; name: string } | null }));

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
  Link: ({ to, params, search: _search, state: _state, children, ...rest }: { to: string; params?: Record<string, string>; search?: unknown; state?: unknown; children?: ReactNode } & Record<string, unknown>) => {
    void _search;
    void _state;
    const href = Object.entries(params ?? {}).reduce((path, [key, value]) => path.replace(`$${key}`, value), to);
    return (
      <a href={href} {...rest}>
        {children}
      </a>
    );
  },
  Navigate: () => null,
  useNavigate: () => navigateMock,
}));

vi.mock("../src/app/project-context.js", () => ({
  useCurrentProject: () => ({ project: projectState.project, projects: [], isLoading: false }),
}));

const { TooltipProvider } = await import("@/components/ui/tooltip");
const { queryKeys } = await import("../src/app/queries.js");
const { RoomWindow } = await import("../src/features/rooms/window/RoomWindow.js");
const store = await import("../src/features/rooms/window/store.js");
const { resetDrafts } = await import("../src/features/rooms/drafts.js");
const { resetPendingMessages } = await import("../src/features/rooms/pending.js");
const { LocaleBoundary } = await import("../src/i18n/provider.js");
const { applyLocalePreference, currentLocale } = await import("../src/i18n/locale.js");
const { resetCarry } = await import("../src/i18n/carry.js");
const { messagesFor } = await import("../src/i18n/messages/index.js");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let client: QueryClient;
let root: Root | null = null;
let container: HTMLDivElement | null = null;

const q = (node: ParentNode, id: string) => node.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const all = (node: ParentNode, id: string) => [...node.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];

async function settle(rounds = 6): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

async function render(element: ReactElement, { strict = false }: { strict?: boolean } = {}): Promise<HTMLDivElement> {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const tree = (
    <QueryClientProvider client={client}>
      <LocaleBoundary>
        <TooltipProvider>{element}</TooltipProvider>
      </LocaleBoundary>
    </QueryClientProvider>
  );
  await act(async () => root?.render(strict ? <StrictMode>{tree}</StrictMode> : tree));
  await settle();
  return container;
}

async function click(element: Element | null | undefined): Promise<void> {
  if (element === null || element === undefined) throw new Error("找不到元素");
  await act(async () => (element as HTMLElement).click());
  await settle(3);
}

/** 媒体查询：窄屏、减少动态效果。 */
function setMedia({ narrow = false, reducedMotion = false }: { narrow?: boolean; reducedMotion?: boolean }) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: (query.includes("max-width: 639px") && narrow) || (query.includes("prefers-reduced-motion") && reducedMotion),
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
}

const at = (iso: string) => ({ seq: 1, authorName: "小王", preview: "…", createdAt: iso });

const defaultRoom = room({ id: "room-1", lastSeq: 2, viewer: { joined: true, lastReadSeq: 1, unreadCount: 1, mentionCount: 0 }, lastMessage: at("2026-09-30T09:00:00.000Z") });
const reqRoom = room({
  id: "room-2",
  kind: "requirement",
  name: "REQ-12 讨论",
  requirement: { id: "r1", number: 12, title: "订单导出" },
  viewer: { joined: true, lastReadSeq: 0, unreadCount: 3, mentionCount: 1 },
  lastMessage: at("2026-09-29T09:00:00.000Z"),
});
const quietRoom = room({
  id: "room-3",
  kind: "requirement",
  name: "REQ-7 联调",
  requirement: { id: "r7", number: 7, title: "联调" },
  viewer: { joined: true, lastReadSeq: 5, unreadCount: 0, mentionCount: 0 },
  lastMessage: at("2026-09-30T12:00:00.000Z"),
});
const archivedRoom = room({
  id: "room-4",
  kind: "requirement",
  name: "REQ-12 旧讨论",
  archivedAt: "2026-09-29T00:00:00.000Z",
  requirement: { id: "r1", number: 12, title: "订单导出" },
  viewer: { joined: true, lastReadSeq: 0, unreadCount: 9, mentionCount: 0 },
});

function seed(projectRooms: RoomDto[] = [defaultRoom, reqRoom, quietRoom, archivedRoom]) {
  client.setQueryData(queryKeys.settings, signedInSettings);
  apiMocks.listProjectRooms.mockResolvedValue({ items: projectRooms });
  apiMocks.getRoom.mockImplementation(async (id: string) => projectRooms.find((item) => item.id === id));
  const main = [
    message({ id: "m-1", seq: 1, body: "收货信息谁在看？", thread: { replyCount: 1, lastReplyAt: "2026-09-30T09:05:00.000Z", lastRepliers: [ZHANG] } }),
    message({
      id: "m-2",
      seq: 2,
      author: ME,
      body: "@小王的Codex 能拿到收货信息吗？",
      runs: [run({ status: "completed", summary: "后端已有", startedAt: "2026-09-30T09:00:00.000Z", finishedAt: "2026-09-30T09:02:14.000Z" })],
    }),
  ];
  apiMocks.listRoomMessages.mockImplementation(async (_roomId: string, query: { threadRootId?: string }) =>
    query.threadRootId === undefined
      ? { items: main, hasMoreBefore: false, hasMoreAfter: false, lastSeq: 2 }
      : { items: main.filter((item) => item.id === query.threadRootId), hasMoreBefore: false, hasMoreAfter: false, lastSeq: 2 },
  );
  apiMocks.listRoomMembers.mockResolvedValue({ items: [member(ME), member(WANG), member(ZHANG, false)] });
  apiMocks.listAgents.mockResolvedValue({ items: [agent()] });
  apiMocks.listRoomShares.mockResolvedValue({ items: [share()] });
  apiMocks.listShareRequests.mockResolvedValue({ items: [] });
  apiMocks.getSelfAgent.mockResolvedValue({ status: "unregistered", agent: null, message: null, activeRun: null, queuedRuns: 0 });
  apiMocks.getAgentRun.mockResolvedValue({ ...run({ status: "completed" }), events: [] });
  apiMocks.listRequirementsMappings.mockResolvedValue({ items: [] });
  apiMocks.markRoomRead.mockResolvedValue(undefined);
  apiMocks.listUsers.mockResolvedValue({ items: [ME, WANG, ZHANG] });
}

beforeEach(() => {
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  projectState.project = { id: "p1", name: "订单中心" };
  localStorage.clear();
  setMedia({});
  seed();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  await act(async () => store.closeRoomWindow());
  resetDrafts();
  resetPendingMessages();
  applyLocalePreference("system");
  resetCarry();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe("悬浮的房间窗口：切换语言后草稿还在", () => {
  it.each([
    ["普通渲染", false],
    ["StrictMode（开发模式）", true],
  ])("%s：窗口、话题面板、主输入框与话题输入框的草稿都带过重建；界面换成英文", async (_mode, strict) => {
    await render(<RoomWindow />, { strict });
    await act(async () => store.openRoomWindow("p1", "room-1"));
    await settle();
    const frame = () => q(document, "room-window");
    if (frame() === null) throw new Error("窗口没打开");
    await click(q(frame() ?? document, "thread-summary"));
    expect(store.getRoomWindowState()?.panel).toEqual({ thread: "m-1", run: null });

    const inputs = () => all(frame() ?? document, "room-composer-input") as HTMLTextAreaElement[];
    expect(inputs()).toHaveLength(2);
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
    for (const [index, value] of [[0, "主线上没发出去的话"], [1, "话题里没发出去的话"]] as const) {
      await act(async () => {
        const input = inputs()[index];
        setter?.call(input, value);
        input?.dispatchEvent(new Event("input", { bubbles: true }));
      });
    }
    const before = inputs()[0];

    await act(async () => applyLocalePreference("en"));
    await settle();
    expect(currentLocale()).toBe("en");
    expect(inputs()[0]).not.toBe(before);
    expect(inputs().map((input) => input.value)).toEqual(["主线上没发出去的话", "话题里没发出去的话"]);
    expect(store.getRoomWindowState()?.panel).toEqual({ thread: "m-1", run: null });
    expect(q(frame() ?? document, "room-window-minimize")?.getAttribute("aria-label")).toBe(messagesFor("en").rooms.window.minimize);
    expect(apiMocks.sendRoomMessage).not.toHaveBeenCalled();

    // 真的离开（退出登录等，外壳卸载）时照旧关掉窗口。
    await act(async () => root?.unmount());
    root = null;
    expect(store.getRoomWindowState()).toBeNull();
  });
});
