// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { RequirementListItemDto } from "@suduo/client-contracts";
import type { RoomDto } from "@suduo/cloud-contracts";
import { act, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agent, member, ME, message, room, run, share, signedInSettings, WANG, ZHANG } from "./fixtures/rooms.js";

/**
 * 讨论快捷入口与悬浮窗口（需求 suduo-v2-room-quick-access-001）：
 * 需求预览面板的讨论按钮三态、悬浮入口（排序、角标、键盘、减少动态效果、窄屏）、
 * 悬浮窗口（话题状态不改 URL、在讨论页打开、收起与「正在看」、拖动 / 拉伸与记忆、分隔线、窄屏回退）。
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
const { RequirementRoomButton } = await import("../src/features/rooms/sections/RequirementRoomButton.js");
const { RoomLauncher } = await import("../src/features/rooms/window/RoomLauncher.js");
const { RoomWindow } = await import("../src/features/rooms/window/RoomWindow.js");
const store = await import("../src/features/rooms/window/store.js");
const { applyIncomingMessage, isReadingRoom } = await import("../src/features/rooms/cache.js");
const { resetDrafts } = await import("../src/features/rooms/drafts.js");
const { resetPendingMessages } = await import("../src/features/rooms/pending.js");
const prefs = await import("../src/features/rooms/window/prefs.js");

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

async function wait(ms: number): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
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

async function key(element: Element | null, name: string): Promise<void> {
  if (element === null) throw new Error("找不到元素");
  await act(async () => {
    element.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
  });
}

async function click(element: Element | null | undefined): Promise<void> {
  if (element === null || element === undefined) throw new Error("找不到元素");
  await act(async () => (element as HTMLElement).click());
  await settle(3);
}

async function pointer(element: Element | null, type: string, init: { clientX: number; clientY: number }): Promise<void> {
  if (element === null) throw new Error("找不到元素");
  const Ctor = typeof PointerEvent === "function" ? PointerEvent : MouseEvent;
  await act(async () => {
    element.dispatchEvent(new Ctor(type, { bubbles: true, cancelable: true, button: 0, pointerId: 1, ...init } as PointerEventInit));
  });
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

const requirement = {
  id: "r1",
  projectId: "p1",
  number: 12,
  title: "订单导出",
  assignee: WANG,
  createdBy: ME,
} as unknown as RequirementListItemDto;

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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

// ───────────────────────────── 需求预览面板按钮 ─────────────────────────────

describe("需求预览面板 · 讨论按钮", () => {
  it("没有房间：「创建讨论」→ 新建对话框（缺省「REQ-n 讨论」）→ 建好在悬浮窗口打开，不跳页", async () => {
    apiMocks.listRequirementRooms.mockResolvedValue({ items: [archivedRoom] });
    const created = room({ id: "room-new", kind: "requirement", name: "REQ-12 讨论", requirement: { id: "r1", number: 12, title: "订单导出" } });
    apiMocks.createRequirementRoom.mockResolvedValue(created);
    const node = await render(<RequirementRoomButton requirement={requirement} />);
    const button = q(node, "requirement-peek-room-button");
    // 已归档的不算
    expect(button?.getAttribute("data-mode")).toBe("create");
    expect(button?.textContent).toContain("创建讨论");

    await click(button);
    const dialog = document.querySelector<HTMLElement>('[data-testid="form-dialog"]');
    expect(dialog?.querySelector<HTMLInputElement>("#new-room-name-r1")?.value).toBe("REQ-12 讨论");
    apiMocks.listRequirementRooms.mockResolvedValue({ items: [created, archivedRoom] });
    await click(dialog?.querySelector('[data-testid="create-requirement-room"]'));
    expect(apiMocks.createRequirementRoom).toHaveBeenCalledWith("r1", { name: "REQ-12 讨论" });
    expect(store.getRoomWindowState()).toMatchObject({ projectId: "p1", roomId: "room-new", minimized: false });
    expect(navigateMock).not.toHaveBeenCalled();
    // 再看面板：按钮变成「进入讨论」
    await settle();
    expect(q(node, "requirement-peek-room-button")?.getAttribute("data-mode")).toBe("enter");
  });

  it("一个房间：「进入讨论」带未读数，点开在悬浮窗口打开", async () => {
    apiMocks.listRequirementRooms.mockResolvedValue({ items: [reqRoom, archivedRoom] });
    const node = await render(<RequirementRoomButton requirement={requirement} />);
    const button = q(node, "requirement-peek-room-button");
    expect(button?.getAttribute("data-mode")).toBe("enter");
    expect(button?.textContent).toContain("进入讨论");
    expect(button?.textContent).toContain("3");
    expect(button?.getAttribute("aria-label")).toBe("进入讨论：REQ-12 讨论，需求讨论，3 条未读，有人 @ 你");
    await click(button);
    expect(store.getRoomWindowState()).toMatchObject({ roomId: "room-2", minimized: false });
  });

  it("多个房间：「进入讨论 ▾」下拉列出各房间（@ 我、未读在前）+「新建讨论」", async () => {
    const second = room({ ...quietRoom, requirement: { id: "r1", number: 12, title: "订单导出" } });
    apiMocks.listRequirementRooms.mockResolvedValue({ items: [second, reqRoom, archivedRoom] });
    const node = await render(<RequirementRoomButton requirement={requirement} />);
    const trigger = q(node, "requirement-peek-room-button");
    expect(trigger?.getAttribute("data-mode")).toBe("menu");
    expect(trigger?.getAttribute("aria-label")).toContain("2 个讨论，3 条未读，有人 @ 你");
    await act(async () => {
      trigger?.focus();
      trigger?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await settle(2);
    const items = all(document, "requirement-peek-room-item");
    expect(items.map((item) => item.getAttribute("data-room-id"))).toEqual(["room-2", "room-3"]);
    expect(q(document, "requirement-peek-new-room")?.textContent).toContain("新建讨论");
    await click(items[1]);
    expect(store.getRoomWindowState()).toMatchObject({ roomId: "room-3" });
  });

  it("窄屏：不弹窗口，直接进讨论页", async () => {
    setMedia({ narrow: true });
    apiMocks.listRequirementRooms.mockResolvedValue({ items: [reqRoom] });
    const node = await render(<RequirementRoomButton requirement={requirement} />);
    await click(q(node, "requirement-peek-room-button"));
    expect(store.getRoomWindowState()).toBeNull();
    expect(navigateMock).toHaveBeenCalledWith({ to: "/p/$projectId/rooms/$roomId", params: { projectId: "p1", roomId: "room-2" } });
  });
});

// ───────────────────────────── 悬浮入口 ─────────────────────────────

describe("悬浮入口", () => {
  it("角标：本项目未读合计（不含归档）与「@」；扇形里按 @ 我 > 未读 > 最近消息排，只列未归档，最下面是「全部讨论…」", async () => {
    const node = await render(<RoomLauncher />);
    const button = q(node, "room-launcher");
    expect(button?.getAttribute("data-unread")).toBe("4");
    expect(button?.getAttribute("aria-label")).toBe("讨论快捷入口，4 条未读，有人 @ 你");
    expect(button?.getAttribute("aria-haspopup")).toBe("listbox");
    expect(button?.textContent).toContain("@");

    await click(button);
    const stack = q(document, "room-launcher-stack");
    expect(stack?.getAttribute("role")).toBe("listbox");
    expect(stack?.getAttribute("data-mode")).toBe("fan");
    expect(button?.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(stack);
    // 扇形的 DOM 顺序与屏幕从上到下一致：最远的在前，最重要的紧挨「全部讨论…」。
    const options = [...(stack?.querySelectorAll('[role="option"]') ?? [])];
    expect(options.map((option) => option.getAttribute("data-room-id") ?? option.getAttribute("data-kind"))).toEqual([
      "room-3",
      "room-1",
      "room-2",
      "all",
    ]);
    expect(options.every((option) => option.getAttribute("data-testid") === "room-launcher-item")).toBe(true);
    expect(options[2]?.getAttribute("aria-selected")).toBe("true");
    expect(stack?.getAttribute("aria-activedescendant")).toBe(options[2]?.id);
  });

  it("键盘：↑↓ 沿弧线移动、Enter 在悬浮窗口打开、Esc 收起并回到按钮", async () => {
    const node = await render(<RoomLauncher />);
    const button = q(node, "room-launcher");
    await click(button);
    let stack = q(document, "room-launcher-stack");
    const active = () => document.getElementById(stack?.getAttribute("aria-activedescendant") ?? "");
    expect(active()?.getAttribute("data-room-id")).toBe("room-2");
    await key(stack, "ArrowUp");
    expect(active()?.getAttribute("data-room-id")).toBe("room-1");
    await key(stack, "ArrowDown");
    await key(stack, "ArrowDown");
    expect(active()?.getAttribute("data-kind")).toBe("all");
    await key(stack, "ArrowUp");
    await key(stack, "Enter");
    await settle(2);
    expect(store.getRoomWindowState()).toMatchObject({ projectId: "p1", roomId: "room-2" });
    expect(q(document, "room-launcher-stack")).toBeNull();

    await click(button);
    stack = q(document, "room-launcher-stack");
    await key(stack, "Escape");
    expect(q(document, "room-launcher-stack")).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it("「全部讨论…」进讨论页；点空白处收起", async () => {
    const node = await render(<RoomLauncher />);
    await click(q(node, "room-launcher"));
    await click(document.querySelector('[data-testid="room-launcher-item"][data-kind="all"]'));
    expect(navigateMock).toHaveBeenCalledWith({ to: "/p/$projectId/rooms", params: { projectId: "p1" } });
    expect(q(document, "room-launcher-stack")).toBeNull();

    await click(q(node, "room-launcher"));
    expect(q(document, "room-launcher-stack")).not.toBeNull();
    await pointer(document.body, "pointerdown", { clientX: 10, clientY: 10 });
    expect(q(document, "room-launcher-stack")).toBeNull();
  });

  it("房间多于一屏：滚轮 / ↑ 沿弧线滚动，滚出一屏的项隐去", async () => {
    const many = Array.from({ length: 12 }, (_, index) =>
      room({
        id: `r-${index}`,
        kind: index === 0 ? "project_default" : "requirement",
        name: `讨论 ${index}`,
        viewer: { joined: true, lastReadSeq: 0, unreadCount: 0, mentionCount: 0 },
        lastMessage: at(new Date(Date.UTC(2026, 8, 30, 12 - index)).toISOString()),
      }),
    );
    seed(many);
    const node = await render(<RoomLauncher />);
    await click(q(node, "room-launcher"));
    await wait(40);
    const stack = q(document, "room-launcher-stack");
    const option = (id: string) => stack?.querySelector(`[data-room-id="${id}"]`);
    // 一屏 8 个：第 9 个起隐去
    expect(option("r-7")?.getAttribute("aria-hidden")).toBeNull();
    expect(option("r-8")?.getAttribute("aria-hidden")).toBe("true");

    await act(async () => {
      stack?.dispatchEvent(new WheelEvent("wheel", { deltaY: -46 * 2, bubbles: true, cancelable: true }));
    });
    await wait(200);
    expect(option("r-9")?.getAttribute("aria-hidden")).toBeNull();
    expect(option("r-0")?.getAttribute("aria-hidden")).toBe("true");

    // 键盘走到最远处也会滚进来
    for (let index = 0; index < 12; index += 1) await key(stack, "ArrowUp");
    await wait(10);
    expect(document.getElementById(stack?.getAttribute("aria-activedescendant") ?? "")?.getAttribute("data-room-id")).toBe("r-11");
    expect(option("r-11")?.getAttribute("aria-hidden")).toBeNull();
  });

  it("减少动态效果：改成普通竖排列表（重要的在上，「全部讨论…」在最下）", async () => {
    setMedia({ reducedMotion: true });
    const node = await render(<RoomLauncher />);
    await click(q(node, "room-launcher"));
    const stack = q(document, "room-launcher-stack");
    expect(stack?.getAttribute("data-mode")).toBe("list");
    const options = [...(stack?.querySelectorAll('[role="option"]') ?? [])];
    expect(options.map((option) => option.getAttribute("data-room-id") ?? "all")).toEqual(["room-2", "room-1", "room-3", "all"]);
    await key(stack, "ArrowDown");
    expect(document.getElementById(stack?.getAttribute("aria-activedescendant") ?? "")?.getAttribute("data-room-id")).toBe("room-1");
  });

  it("拖到左半边松手吸附到左边，记在本浏览器；拖完不算点击", async () => {
    const node = await render(<RoomLauncher />);
    const button = q(node, "room-launcher");
    expect(button?.getAttribute("data-side")).toBe("right");
    await pointer(button, "pointerdown", { clientX: 980, clientY: 620 });
    await pointer(button, "pointermove", { clientX: 600, clientY: 600 });
    await pointer(button, "pointermove", { clientX: 100, clientY: 600 });
    // 鼠标松手后浏览器在同一个任务里紧接着派发 click（detail ≥ 1）：不算点击。
    const Ctor = typeof PointerEvent === "function" ? PointerEvent : MouseEvent;
    await act(async () => {
      button?.dispatchEvent(new Ctor("pointerup", { bubbles: true, button: 0, pointerId: 1, clientX: 100, clientY: 600 } as PointerEventInit));
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
    });
    expect(q(document, "room-launcher-stack")).toBeNull();
    expect(button?.getAttribute("data-side")).toBe("left");
    expect(prefs.readLauncherPosition()?.side).toBe("left");
    // 触屏拖完没派发 click：之后键盘按 Enter（click 的 detail 为 0）照常展开，不被吞掉。
    await pointer(button, "pointerdown", { clientX: 100, clientY: 600 });
    await pointer(button, "pointermove", { clientX: 140, clientY: 600 });
    await pointer(button, "pointerup", { clientX: 140, clientY: 600 });
    await act(async () => {
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 0 }));
    });
    expect(q(document, "room-launcher-stack")).not.toBeNull();

    // 重新挂载仍在左边
    await act(async () => root?.unmount());
    const again = await render(<RoomLauncher />);
    expect(q(again, "room-launcher")?.getAttribute("data-side")).toBe("left");
  });

  it("窗口收起时，点入口直接恢复窗口", async () => {
    store.openRoomWindow("p1", "room-2");
    store.setRoomWindowMinimized(true);
    const node = await render(<RoomLauncher />);
    const button = q(node, "room-launcher");
    expect(button?.getAttribute("aria-label")).toContain("恢复讨论窗口：REQ-12 讨论");
    await click(button);
    expect(store.getRoomWindowState()).toMatchObject({ roomId: "room-2", minimized: false });
    expect(q(document, "room-launcher-stack")).toBeNull();
  });

  it("窄屏、没有项目时不显示", async () => {
    setMedia({ narrow: true });
    let node = await render(<RoomLauncher />);
    expect(q(node, "room-launcher")).toBeNull();
    await act(async () => root?.unmount());
    setMedia({});
    projectState.project = null;
    node = await render(<RoomLauncher />);
    expect(q(node, "room-launcher")).toBeNull();
  });
});

// ───────────────────────────── 悬浮窗口 ─────────────────────────────

describe("悬浮窗口", () => {
  async function openWindow(roomId = "room-1"): Promise<HTMLElement> {
    await render(<RoomWindow />);
    await act(async () => store.openRoomWindow("p1", roomId));
    await settle();
    const frame = q(document, "room-window");
    if (frame === null) throw new Error("窗口没打开");
    return frame;
  }

  it("标题栏：房间名、成员、共享 Agent、切换、在讨论页打开、收起、关闭；内容与讨论页同一份", async () => {
    const frame = await openWindow("room-2");
    const header = q(frame, "room-window-header");
    expect(header?.querySelector("h2")?.textContent).toContain("REQ-12 讨论");
    expect(header?.querySelector("h2")?.textContent).toContain("需求讨论");
    expect(q(header ?? frame, "room-members-button")).not.toBeNull();
    expect(q(header ?? frame, "share-agent-button")).not.toBeNull();
    for (const id of ["room-window-switcher", "room-window-open-page", "room-window-minimize", "room-window-close"]) {
      expect(q(header ?? frame, id)).not.toBeNull();
    }
    expect(q(frame, "room-message-stream")).not.toBeNull();
    expect(q(frame, "room-composer")).not.toBeNull();
    expect(frame.getAttribute("aria-labelledby")).toBe(header?.querySelector("h2")?.id);
  });

  it("话题与运行详情放在窗口状态里，不改页面地址；「在讨论页打开」带着话题跳整页并关窗", async () => {
    const frame = await openWindow();
    await click(q(frame, "thread-summary"));
    expect(navigateMock).not.toHaveBeenCalled();
    expect(store.getRoomWindowState()?.panel).toEqual({ thread: "m-1", run: null });
    expect(q(frame, "thread-panel")?.getAttribute("data-root-id")).toBe("m-1");
    expect(q(frame, "room-window-side")?.getAttribute("data-mode")).toBe("split");

    await click(q(frame, "run-status")?.querySelector("button"));
    expect(store.getRoomWindowState()?.panel).toEqual({ thread: "m-2", run: null });
    await click(q(q(frame, "thread-panel") ?? frame, "run-view-detail"));
    expect(navigateMock).not.toHaveBeenCalled();
    expect(store.getRoomWindowState()?.panel).toEqual({ thread: "m-2", run: "run-1" });
    expect(q(frame, "thread-panel")?.textContent).toContain("执行过程");

    await click(q(frame, "room-window-open-page"));
    expect(navigateMock).toHaveBeenCalledWith({
      to: "/p/$projectId/rooms/$roomId",
      params: { projectId: "p1", roomId: "room-1" },
      search: { thread: "m-2", run: "run-1" },
    });
    expect(store.getRoomWindowState()).toBeNull();
    expect(q(document, "room-window")).toBeNull();
  });

  it("窗口太窄时话题盖住整个窗口", async () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ width: 400, height: 600, x: 0, y: 0, top: 0, left: 0, right: 400, bottom: 600, toJSON: () => ({}) } as DOMRect);
    const frame = await openWindow();
    await click(q(frame, "thread-summary"));
    expect(q(frame, "room-window-side")?.getAttribute("data-mode")).toBe("cover");
    expect(q(frame, "room-window-divider")).toBeNull();
  });

  it("分隔线可拖动、可用 ←→ 调整，宽度记在本浏览器", async () => {
    const frame = await openWindow();
    await click(q(frame, "thread-summary"));
    const divider = q(frame, "room-window-divider");
    expect(divider?.getAttribute("role")).toBe("separator");
    expect(q(frame, "room-window-side")?.style.width).toBe("360px");
    await pointer(divider, "pointerdown", { clientX: 500, clientY: 300 });
    await pointer(divider, "pointermove", { clientX: 540, clientY: 300 });
    await pointer(divider, "pointerup", { clientX: 540, clientY: 300 });
    expect(q(frame, "room-window-side")?.style.width).toBe("320px");
    expect(prefs.readSideWidth()).toBe(320);
    await key(divider, "ArrowRight");
    expect(q(frame, "room-window-side")?.style.width).toBe("304px");
    expect(prefs.readSideWidth()).toBe(304);
  });

  it("打开且没收起时算「正在看」：新消息不计未读；收起后照常计未读，恢复后补记已读", async () => {
    await client.prefetchQuery({ queryKey: ["rooms", "list", "project", "p1"], queryFn: () => ({ items: [defaultRoom, reqRoom, quietRoom] }) });
    const frame = await openWindow();
    expect(isReadingRoom("room-1")).toBe(true);
    expect(apiMocks.markRoomRead).toHaveBeenCalledWith("room-1", 2);
    const unread = () =>
      client.getQueryData<{ items: RoomDto[] }>(["rooms", "list", "project", "p1"])?.items.find((item) => item.id === "room-1")?.viewer.unreadCount;
    expect(unread()).toBe(0);

    await act(async () => applyIncomingMessage(client, message({ id: "m-3", seq: 3, author: WANG, body: "在看" })));
    await settle(2);
    expect(unread()).toBe(0);

    await click(q(frame, "room-window-minimize"));
    expect(frame.getAttribute("data-minimized")).toBe("true");
    expect(frame.getAttribute("aria-hidden")).toBe("true");
    expect(isReadingRoom("room-1")).toBe(false);
    await act(async () => applyIncomingMessage(client, message({ id: "m-4", seq: 4, author: WANG, body: "人呢" })));
    await settle(2);
    expect(unread()).toBe(1);

    apiMocks.markRoomRead.mockClear();
    await act(async () => store.setRoomWindowMinimized(false));
    await settle(2);
    expect(isReadingRoom("room-1")).toBe(true);
    expect(apiMocks.markRoomRead).toHaveBeenCalledWith("room-1", 4);
  });

  it("切换房间：替换窗口内容，话题清空", async () => {
    const frame = await openWindow();
    await click(q(frame, "thread-summary"));
    const switcher = q(frame, "room-window-switcher");
    await act(async () => {
      switcher?.focus();
      switcher?.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    });
    await settle(2);
    const items = all(document, "room-window-switcher-item");
    // 在窗口里看过 room-1（已读），它排到最近有消息的 room-3 后面
    expect(items.map((item) => item.getAttribute("data-room-id"))).toEqual(["room-2", "room-3", "room-1"]);
    expect(items[2]?.getAttribute("aria-current")).toBe("true");
    await click(items[0]);
    expect(store.getRoomWindowState()).toMatchObject({ roomId: "room-2", panel: { thread: null, run: null } });
    expect(q(document, "room-window")?.getAttribute("data-room-id")).toBe("room-2");
    expect(all(document, "room-window")).toHaveLength(1);
  });

  it("按住标题栏拖动、拉伸都不出浏览器、不小于 360×420，松手记下；重新打开回到记下的位置", async () => {
    const frame = await openWindow();
    const viewport = { width: window.innerWidth, height: window.innerHeight };
    const transform = () => frame.style.transform;
    const handle = q(frame, "room-window-header")?.parentElement ?? null;
    expect(handle?.className).toContain("cursor-grab");

    // 第一次打开：靠右下、给入口留一列
    const first = { x: viewport.width - 84 - 440, y: viewport.height - 640 - 16 };
    expect(transform()).toBe(`translate3d(${first.x}px, ${first.y}px, 0)`);

    const title = q(frame, "room-window-header")?.querySelector("h2") ?? null;
    await pointer(title, "pointerdown", { clientX: 600, clientY: 130 });
    expect(handle?.className).toContain("cursor-grabbing");
    await pointer(handle, "pointermove", { clientX: 500, clientY: 80 });
    await pointer(handle, "pointerup", { clientX: 500, clientY: 80 });
    expect(transform()).toBe(`translate3d(${first.x - 100}px, ${first.y - 50}px, 0)`);
    expect(prefs.readWindowRect()).toEqual({ x: first.x - 100, y: first.y - 50, width: 440, height: 640 });

    // 拖出左上角：停在 6px
    await pointer(title, "pointerdown", { clientX: 500, clientY: 80 });
    await pointer(handle, "pointermove", { clientX: -4000, clientY: -4000 });
    await pointer(handle, "pointerup", { clientX: -4000, clientY: -4000 });
    expect(transform()).toBe("translate3d(6px, 6px, 0)");

    // 按标题栏上的按钮不拖动
    await pointer(q(frame, "room-window-minimize"), "pointerdown", { clientX: 10, clientY: 10 });
    await pointer(handle, "pointermove", { clientX: 300, clientY: 300 });
    expect(transform()).toBe("translate3d(6px, 6px, 0)");
    await pointer(handle, "pointerup", { clientX: 300, clientY: 300 });

    // 右下角往里推到底：最小 360×420
    const se = frame.querySelector<HTMLElement>('[data-testid="room-window-resize"][data-edge="se"]');
    expect(all(frame, "room-window-resize")).toHaveLength(8);
    await pointer(se, "pointerdown", { clientX: 400, clientY: 600 });
    await pointer(se, "pointermove", { clientX: -2000, clientY: -2000 });
    await pointer(se, "pointerup", { clientX: -2000, clientY: -2000 });
    expect(frame.style.width).toBe("360px");
    expect(frame.style.height).toBe("420px");

    // 往外拉过浏览器：停在离边 6px
    await pointer(se, "pointerdown", { clientX: 0, clientY: 0 });
    await pointer(se, "pointermove", { clientX: 9000, clientY: 9000 });
    await pointer(se, "pointerup", { clientX: 9000, clientY: 9000 });
    expect(frame.style.width).toBe(`${viewport.width - 12}px`);
    expect(frame.style.height).toBe(`${viewport.height - 12}px`);
    expect(prefs.readWindowRect()).toEqual({ x: 6, y: 6, width: viewport.width - 12, height: viewport.height - 12 });

    // 关掉再开：位置大小沿用
    await click(q(frame, "room-window-close"));
    expect(q(document, "room-window")).toBeNull();
    await act(async () => store.openRoomWindow("p1", "room-1"));
    await settle();
    expect(q(document, "room-window")?.style.transform).toBe("translate3d(6px, 6px, 0)");
    expect(q(document, "room-window")?.style.width).toBe(`${viewport.width - 12}px`);
  });

  it("窗口里的单键不传到底下的页面（看板 J/K、Esc 关速览）；带修饰键的照常", async () => {
    const frame = await openWindow();
    const onPageKey = vi.fn();
    window.addEventListener("keydown", onPageKey);
    try {
      await key(q(frame, "room-window-header")?.querySelector("h2") ?? null, "j");
      expect(onPageKey).not.toHaveBeenCalled();
      await act(async () => {
        q(frame, "room-window-header")?.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true, bubbles: true }));
      });
      expect(onPageKey).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("keydown", onPageKey);
    }
  });

  it("同一房间同时开在讨论页和窗口里：任一处在看就算在看，一处关掉不影响另一处", async () => {
    const { setReadingRoom } = await import("../src/features/rooms/cache.js");
    const page = {};
    const floating = {};
    setReadingRoom("room-x", true, page);
    setReadingRoom("room-x", true, floating);
    setReadingRoom("room-x", false, page);
    expect(isReadingRoom("room-x")).toBe(true);
    setReadingRoom("room-x", false, floating);
    expect(isReadingRoom("room-x")).toBe(false);
  });

  it("窄屏不显示窗口", async () => {
    setMedia({ narrow: true });
    await render(<RoomWindow />);
    await act(async () => store.openRoomWindow("p1", "room-1"));
    await settle();
    expect(q(document, "room-window")).toBeNull();
  });
});
