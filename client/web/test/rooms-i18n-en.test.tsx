// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { LocalAgentStateDto, RequirementListItemDto } from "@suduo/client-contracts";
import type { AgentRunStatus, UserSummaryDto } from "@suduo/cloud-contracts";
import { act, type ReactElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agent, member, message, room, run, share, shareRequest, signedInSettings } from "./fixtures/rooms.js";

/**
 * 讨论房间与共享 Agent 的英文冒烟（中英双语 S4）：房间列表与页头、消息与话题、输入框与 @ 候选、
 * 共享 Agent 面板、任务状态行与运行详情、需求下的讨论、悬浮窗口与入口。
 * 用户内容（房间名、人名、消息）这里用英文写，好检查界面文字里没有漏翻的中文。
 */

const apiMocks = vi.hoisted(() => ({
  addRoomMembers: vi.fn(),
  closeAgentShare: vi.fn(),
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
  openAgentShare: vi.fn(),
  requestAgentShare: vi.fn(),
  resolveShareRequest: vi.fn(),
  retryAgentRun: vi.fn(),
  roomFileUrl: (id: string) => `/files/${id}`,
  sendRoomMessage: vi.fn(),
  stopAgentRun: vi.fn(),
  updateRoom: vi.fn(),
  uploadRoomFile: vi.fn(),
}));
const navigateMock = vi.hoisted(() => vi.fn());
const projectState = vi.hoisted(() => ({ project: { id: "p1", name: "Checkout" } as { id: string; name: string } | null }));

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
const { applyLocalePreference } = await import("../src/i18n/locale.js");
const { messagesFor } = await import("../src/i18n/messages/index.js");
const { RoomsPage } = await import("../src/features/rooms/RoomsPage.js");
const { ShareAgentPanel } = await import("../src/features/rooms/components/ShareAgentPanel.js");
const { RunStatusLine } = await import("../src/features/rooms/components/RunStatusLine.js");
const { RequirementRooms } = await import("../src/features/rooms/sections/RequirementRooms.js");
const { RequirementRoomButton } = await import("../src/features/rooms/sections/RequirementRoomButton.js");
const { RoomLauncher } = await import("../src/features/rooms/window/RoomLauncher.js");
const { RoomWindow } = await import("../src/features/rooms/window/RoomWindow.js");
const store = await import("../src/features/rooms/window/store.js");
const { resetDrafts } = await import("../src/features/rooms/drafts.js");
const { resetPendingMessages } = await import("../src/features/rooms/pending.js");
const model = await import("../src/features/rooms/model.js");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const range = (from: number, to: number) => `${String.fromCharCode(from)}-${String.fromCharCode(to)}`;
const CJK = new RegExp(`[${range(0x3000, 0x303f)}${range(0x3400, 0x9fff)}${range(0xf900, 0xfaff)}${range(0xff00, 0xffef)}]`);

const ME: UserSummaryDto = { id: "u-me", displayName: "Alex" };
const SAM: UserSummaryDto = { id: "u-sam", displayName: "Sam" };
const JO: UserSummaryDto = { id: "u-jo", displayName: "Jo" };
const settings = { ...signedInSettings, session: { ...signedInSettings.session, user: { ...signedInSettings.session.user, displayName: "Alex" } } };

const samAgent = agent({ id: "agent-sam", owner: SAM, label: "Sam's Codex · MacBook Pro" });
const joAgent = agent({ id: "agent-jo", owner: JO, deviceName: "ThinkPad", label: "Jo's Codex · ThinkPad", online: false });
const chrisAgent = agent({ id: "agent-chris", owner: { id: "u-chris", displayName: "Chris" }, deviceName: "iMac", label: "Chris's Codex · iMac" });
const myAgent = agent({ id: "agent-me", owner: ME, deviceName: "MacBook Air", label: "Alex's Codex · MacBook Air" });

const defaultRoom = room({ name: "Checkout", lastSeq: 2, viewer: { joined: true, lastReadSeq: 2, unreadCount: 0, mentionCount: 0 } });
const reqRoom = room({
  id: "room-2",
  kind: "requirement",
  name: "REQ-12 room",
  requirement: { id: "r1", number: 12, title: "Order export" },
  viewer: { joined: true, lastReadSeq: 0, unreadCount: 3, mentionCount: 1 },
  lastMessage: { seq: 4, authorName: "Sam", preview: "Raise the export limit to 10k", createdAt: "2026-09-30T09:00:00.000Z" },
});
const archivedRoom = room({
  id: "room-3",
  kind: "requirement",
  name: "REQ-7 integration",
  archivedAt: "2026-09-29T00:00:00.000Z",
  requirement: { id: "r7", number: 7, title: "Integration" },
});

const requirement = { id: "r1", projectId: "p1", number: 12, title: "Order export", assignee: SAM, createdBy: ME } as unknown as RequirementListItemDto;

const ready = (patch: Partial<LocalAgentStateDto> = {}): LocalAgentStateDto => ({
  status: "ready",
  agent: myAgent,
  message: null,
  activeRun: null,
  queuedRuns: 0,
  ...patch,
});

function seed() {
  client.setQueryData(queryKeys.settings, settings);
  const rooms = [defaultRoom, reqRoom, archivedRoom];
  apiMocks.listProjectRooms.mockResolvedValue({ items: rooms });
  apiMocks.getRoom.mockImplementation(async (id: string) => rooms.find((item) => item.id === id));
  const completed = run({
    agent: samAgent,
    triggeredBy: ME,
    status: "completed",
    summary: "Backend already has receiverSnapshot",
    startedAt: "2026-09-30T09:00:00.000Z",
    finishedAt: "2026-09-30T09:02:14.000Z",
  });
  apiMocks.listRoomMessages.mockImplementation(async (_roomId: string, query: { threadRootId?: string }) =>
    query.threadRootId === undefined
      ? {
          items: [
            message({ id: "m-1", seq: 1, author: SAM, body: "Who is looking at the shipping info?", thread: { replyCount: 2, lastReplyAt: "2026-09-30T09:05:00.000Z", lastRepliers: [JO] } }),
            message({ id: "m-2", seq: 2, author: ME, body: "Can the order page get the shipping info?", runs: [completed] }),
          ],
          hasMoreBefore: true,
          hasMoreAfter: false,
          lastSeq: 2,
        }
      : {
          items: [
            message({ id: "m-2", seq: 2, author: ME, body: "Can the order page get the shipping info?", runs: [completed] }),
            message({ id: "m-3", seq: 3, threadRootId: "m-2", authorKind: "agent", author: SAM, agent: samAgent, body: "**Answer**: the backend already has it." }),
          ],
          hasMoreBefore: false,
          hasMoreAfter: false,
          lastSeq: 3,
        },
  );
  apiMocks.listRoomMembers.mockResolvedValue({ items: [member(ME), member(SAM), member(JO, false)] });
  apiMocks.listAgents.mockResolvedValue({ items: [samAgent, joAgent, chrisAgent] });
  apiMocks.listRoomShares.mockResolvedValue({ items: [share({ agent: samAgent }), share({ id: "share-jo", agent: joAgent })] });
  apiMocks.listShareRequests.mockResolvedValue({ items: [] });
  apiMocks.getSelfAgent.mockResolvedValue({ status: "unregistered", agent: null, message: null, activeRun: null, queuedRuns: 0 });
  apiMocks.getAgentRun.mockResolvedValue({ ...run({ agent: samAgent, status: "offline" }), events: [] });
  apiMocks.listRequirementsMappings.mockResolvedValue({ items: [] });
  apiMocks.listRequirementRooms.mockResolvedValue({ items: [reqRoom] });
  apiMocks.listUsers.mockResolvedValue({ items: [ME, SAM, JO] });
  apiMocks.markRoomRead.mockResolvedValue(undefined);
}

let client: QueryClient;
let root: Root | null = null;
let container: HTMLDivElement | null = null;

const q = (node: ParentNode, id: string) => node.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const all = (node: ParentNode, id: string) => [...node.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
const button = (node: ParentNode, text: string) => [...node.querySelectorAll("button")].find((item) => item.textContent?.trim() === text);

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

async function click(element: Element | null | undefined): Promise<void> {
  if (element === null || element === undefined) throw new Error("找不到元素");
  await act(async () => (element as HTMLElement).click());
  await settle(3);
}

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

async function key(element: HTMLElement, name: string): Promise<void> {
  await act(async () => {
    element.dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
  });
}

beforeEach(() => {
  localStorage.clear();
  applyLocalePreference("en");
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined }));
  projectState.project = { id: "p1", name: "Checkout" };
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
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
  vi.clearAllMocks();
  applyLocalePreference("system");
  localStorage.clear();
});

describe("讨论页：英文界面", () => {
  it("房间列表与页头", async () => {
    const node = await render(<RoomsPage projectId="p1" roomId="room-1" search={{}} />);
    const list = q(node, "room-list");
    expect(list?.getAttribute("aria-label")).toBe("Room list");
    expect(list?.querySelector("h2")?.textContent).toBe("Rooms");
    const items = all(node, "room-list-item");
    expect(items[1]?.getAttribute("aria-label")).toBe("REQ-12 room, 3 unread, you were mentioned");
    expect(list?.textContent).toContain("Archived · 1");
    expect(list?.textContent).toContain("Create requirement rooms from a requirement's details.");
    expect(list?.textContent).not.toMatch(CJK);

    const header = q(node, "room-header");
    expect(header?.textContent).toContain("# Checkout");
    expect(header?.textContent).toContain("Project room · Everyone's here");
    expect(header?.querySelector('button[aria-label="More room actions"]')).not.toBeNull();
    expect(q(header ?? node, "room-members-button")?.getAttribute("aria-label")).toBe("3 members, 2 online");
    expect(q(header ?? node, "share-agent-button")?.getAttribute("aria-label")).toBe("Shared agents, 2 shared");
    expect(q(header ?? node, "share-agent-button")?.textContent).toContain("Shared agents");
    expect(header?.textContent).not.toMatch(CJK);
  });

  it("消息流、「N replies」与话题面板（任务卡、回复框）", async () => {
    const node = await render(<RoomsPage projectId="p1" roomId="room-1" search={{ thread: "m-2" }} />);
    const stream = q(node, "room-message-stream");
    expect(stream?.getAttribute("aria-label")).toBe("Messages");
    expect(q(node, "room-load-older")?.textContent).toBe("Earlier messages · Load more");
    const status = q(node, "run-status");
    expect(status?.textContent).toContain("Sam's Codex");
    expect(status?.textContent).toContain("Done · Backend already has receiverSnapshot");
    expect(status?.querySelector("button")?.getAttribute("aria-label")).toBe("Sam's Codex: Done · Backend already has receiverSnapshot. Open thread");
    expect(q(node, "thread-summary")?.textContent).toContain("2 replies");
    expect(q(node, "thread-summary")?.textContent).toContain("Last reply");
    const first = node.querySelector('[data-testid="room-message"][data-message-id="m-1"]');
    expect(first?.getAttribute("aria-label")).toMatch(/^Sam, \d{2}:\d{2}$/);
    expect(first?.querySelector('button[aria-label="Reply to Sam"]')?.textContent).toBe("Reply");
    expect(stream?.textContent).not.toMatch(CJK);

    const panel = q(node, "thread-panel");
    expect(panel?.getAttribute("aria-label")).toBe("Thread");
    expect(panel?.querySelector("h2")?.textContent).toBe("Thread");
    expect(panel?.querySelector('button[aria-label="Close thread"]')).not.toBeNull();
    const card = q(panel ?? node, "run-card");
    expect(card?.textContent).toContain("Done");
    expect(card?.textContent).toContain("2 min 14s elapsed");
    expect(q(card ?? node, "run-view-detail")?.textContent).toBe("View details");
    expect(panel?.textContent).toContain("1 reply");
    expect(input(panel ?? node).getAttribute("placeholder")).toBe("Reply in thread. @ an agent to ask a follow-up");
    expect(panel?.textContent).not.toMatch(CJK);
  });

  it("输入框与 @ 候选；插进正文的 @ 文字仍是提及协议（S6 再按 kind 渲染）", async () => {
    const node = await render(<RoomsPage projectId="p1" roomId="room-1" search={{}} />);
    const composer = q(node, "room-composer");
    const textarea = input(node);
    expect(textarea.getAttribute("placeholder")).toBe("Message “Checkout”. @ a teammate or a shared agent");
    expect(composer?.textContent).toContain("Enter to send · Shift+Enter for a new line");
    expect(q(node, "room-attach")?.textContent).toBe("Attach");
    expect(q(node, "room-send")?.getAttribute("aria-label")).toBe("Send");

    await type(textarea, "@");
    const picker = q(document, "mention-picker");
    expect(picker?.querySelector('[role="listbox"]')?.getAttribute("aria-label")).toBe("Choose a person or agent to @");
    expect(picker?.querySelector('[role="group"][aria-label="People"]')).not.toBeNull();
    expect(picker?.querySelector('[role="group"][aria-label="Agents"]')).not.toBeNull();
    const options = all(document, "mention-option");
    const everyone = options.find((option) => option.getAttribute("data-kind") === "all");
    expect(everyone?.textContent).toContain("everyone");
    expect(everyone?.textContent).toContain("Notifies everyone; doesn't call agents");
    const byAgent = (label: string) => options.find((option) => option.textContent?.includes(label));
    expect(byAgent("Sam's Codex")?.textContent).toContain("Available");
    expect(byAgent("Chris's Codex")?.textContent).toContain("Not shared · Press Enter to request");
    expect(byAgent("Jo's Codex")?.getAttribute("title")).toBe("Offline agents won't run when you @ them. You can retry from the message later.");
    expect(picker?.textContent).not.toMatch(CJK);

    await type(textarea, "@every");
    await key(textarea, "Enter");
    expect(textarea.value).toBe(`@${model.MENTION_ALL_TEXT} `);
  });

  it("运行详情：返回话题、状态名、没执行时的说明", async () => {
    const node = await render(<RoomsPage projectId="p1" roomId="room-1" search={{ thread: "m-2", run: "run-1" }} />);
    const detail = q(node, "run-detail");
    expect(detail?.getAttribute("data-status")).toBe("offline");
    expect(button(detail ?? node, "Back to thread")).not.toBeUndefined();
    expect(detail?.textContent).toContain("Offline, didn't run");
    expect(detail?.textContent).toContain("Didn't run");
    expect(detail?.textContent).toContain("The owner was offline or not sharing, so this didn't run.");
    expect(q(node, "thread-panel")?.querySelector("h2")?.textContent).toBe("Run details");
    expect(detail?.textContent).not.toMatch(CJK);
  });
});

describe("任务状态：英文", () => {
  const en = messagesFor("en");

  it("状态名不再取云端契约的中文常量", () => {
    const statuses: AgentRunStatus[] = ["queued", "running", "completed", "failed", "stopped", "offline"];
    expect(statuses.map((status) => model.runStatusLabel(status, en))).toEqual(["Queued", "Running", "Done", "Failed", "Stopped", "Offline, didn't run"]);
  });

  it("状态行文字：排队位置、停止中；进度与原因是所有者本机写的文字，原样拼在后面", () => {
    expect(model.runStatusText(run({ status: "queued", queuePosition: 3 }), en)).toBe("Queued (3 ahead)");
    expect(model.runStatusText(run({ status: "running", stopRequested: true }), en)).toBe("Stopping…");
    expect(model.runStatusText(run({ status: "failed", reason: "所有者本机下线" }), en)).toBe("Failed · 所有者本机下线");
  });

  it("停止 / 重试按钮与到期说明", async () => {
    const node = await render(<RunStatusLine run={run({ agent: samAgent, triggeredBy: ME, status: "running" })} meId={ME.id} onOpen={vi.fn()} />);
    const stop = q(node, "run-stop");
    expect(stop?.textContent).toBe("Stop");
    expect(stop?.getAttribute("aria-label")).toBe("Stop the task for Sam's Codex");
    expect(model.expiresLabel(null, new Date(), en)).toBe("until turned off");
    const now = new Date(2026, 8, 30, 10, 0, 0);
    expect(model.expiresLabel(model.endOfLocalDay(now), now, en)).toBe("until 23:59");
  });
});

describe("共享 Agent 面板：英文", () => {
  it("时长选项、已共享、申请与待处理", async () => {
    apiMocks.getSelfAgent.mockResolvedValue(ready());
    apiMocks.listRoomShares.mockResolvedValue({ items: [share({ agent: samAgent })] });
    apiMocks.listAgents.mockResolvedValue({ items: [samAgent, joAgent, myAgent] });
    apiMocks.listShareRequests.mockResolvedValue({ items: [shareRequest({ id: "req-9", agent: myAgent, requester: SAM })] });
    apiMocks.listRequirementsMappings.mockResolvedValue({ items: [{ remoteProjectId: "p1", localProjectId: "l1", rootPath: "/code/p1", localProjectName: "p1", lastValidatedAt: 0 }] });
    const node = await render(<ShareAgentPanel room={defaultRoom} meId={ME.id} />);

    const mine = q(node, "my-agent-section");
    expect(mine?.querySelector("h3")?.textContent).toBe("My agent");
    expect(q(node, "my-agent-switch")?.getAttribute("aria-label")).toBe("Share Alex's Codex · MacBook Air in this room");
    const durations = q(node, "share-duration");
    expect(durations?.getAttribute("aria-label")).toBe("How long to share");
    expect([...(durations?.querySelectorAll("button") ?? [])].map((item) => item.textContent?.trim())).toEqual(["Until I turn it off", "2 hours", "Today"]);
    expect(q(node, "my-agent-share-state")?.textContent).toContain("Not shared in this room. Turn it on to share it with the “Today” option.");

    expect(q(node, "shared-agent-row")?.textContent).toContain("Available · until turned off");
    const incoming = q(node, "incoming-share-request");
    expect(incoming?.textContent).toContain("Sam wants to use Alex's Codex");
    expect(button(incoming ?? node, "Share")).not.toBeUndefined();
    expect(button(incoming ?? node, "Ignore")).not.toBeUndefined();
    const requestable = q(node, "requestable-agent-row")?.querySelector("button");
    expect(requestable?.textContent).toBe("Request");
    expect(requestable?.getAttribute("aria-label")).toBe("Request Jo's Codex · ThinkPad");
    expect(node.textContent).not.toMatch(CJK);
  });

  it("本机 Agent 没登记：默认说明是英文", async () => {
    const node = await render(<ShareAgentPanel room={defaultRoom} meId={ME.id} />);
    expect(q(node, "my-agent-unavailable")?.textContent).toBe(
      "Your local Codex isn't registered as an agent yet. It registers automatically once you sign in and open SuDuo on this computer.",
    );
  });
});

describe("需求下的讨论：英文", () => {
  it("需求详情的「讨论」区块与新建对话框（缺省名按创建者语言）", async () => {
    const node = await render(<RequirementRooms requirement={requirement} me={ME} />);
    const section = q(node, "requirement-rooms");
    expect(section?.querySelector("h2")?.textContent).toBe("Rooms");
    const link = q(node, "requirement-room-link");
    expect(link?.getAttribute("aria-label")).toBe("REQ-12 room, 3 unread");
    expect(link?.textContent).toContain("Sam: Raise the export limit to 10k");
    expect(section?.textContent).not.toMatch(CJK);

    await click(q(node, "new-requirement-room"));
    const dialog = document.querySelector<HTMLElement>('[data-testid="form-dialog"]');
    expect(dialog?.textContent).toContain("New room");
    expect(dialog?.textContent).toContain("Under REQ-12. Everyone can see and join the room.");
    expect(dialog?.querySelector<HTMLInputElement>("#new-room-name-r1")?.value).toBe("REQ-12 room");
    expect(dialog?.textContent).toContain("Add people (optional)");
    expect(q(dialog ?? document, "create-requirement-room")?.textContent).toBe("Create room");
    expect(dialog?.textContent).not.toMatch(CJK);
  });

  it("需求预览面板的讨论按钮", async () => {
    const node = await render(<RequirementRoomButton requirement={requirement} />);
    const trigger = q(node, "requirement-peek-room-button");
    expect(trigger?.textContent).toContain("Open room");
    expect(trigger?.getAttribute("aria-label")).toBe("Open room: REQ-12 room, Requirement room, 3 unread, you were mentioned");
  });
});

describe("悬浮窗口与入口：英文", () => {
  it("悬浮入口的读屏标签、提示与叠放", async () => {
    const node = await render(<RoomLauncher />);
    const launcher = q(node, "room-launcher");
    expect(launcher?.getAttribute("aria-label")).toBe("Rooms quick access, 3 unread, you were mentioned");
    expect(launcher?.getAttribute("title")).toBe("Rooms (you can drag this to the left)");
    await click(launcher);
    const stack = q(document, "room-launcher-stack");
    expect(stack?.getAttribute("aria-label")).toBe("Rooms in this project");
    const allRooms = stack?.querySelector('[role="option"][data-kind="all"]');
    expect(allRooms?.getAttribute("aria-label")).toBe("All rooms…, open the Rooms page");
    expect(allRooms?.textContent).toContain("All rooms…");
    expect(stack?.textContent).not.toMatch(CJK);
  });

  it("窗口标题栏与内容", async () => {
    await render(<RoomWindow />);
    await act(async () => store.openRoomWindow("p1", "room-2"));
    await settle();
    const frame = q(document, "room-window");
    const header = q(frame ?? document, "room-window-header");
    expect(header?.querySelector("h2")?.textContent).toBe("REQ-12 room (Requirement room)");
    expect(q(header ?? document, "room-window-switcher")?.getAttribute("aria-label")).toBe("Switch room");
    expect(q(header ?? document, "room-window-open-page")?.getAttribute("aria-label")).toBe("Open in Rooms");
    expect(q(header ?? document, "room-window-minimize")?.getAttribute("aria-label")).toBe("Minimize");
    expect(q(header ?? document, "room-window-close")?.getAttribute("aria-label")).toBe("Close");
    expect(header?.textContent).not.toMatch(CJK);
    expect(input(frame ?? document).getAttribute("placeholder")).toBe("Message “REQ-12 room”. @ a teammate or a shared agent");
  });
});
