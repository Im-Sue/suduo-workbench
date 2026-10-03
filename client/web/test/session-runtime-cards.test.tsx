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
  listRequirementAttachments: vi.fn(),
  readFile: vi.fn(),
  decideApproval: vi.fn(),
  requirementAttachmentDownloadUrl: (id: string) => `/api/v2/attachments/${id}/content`,
  listProjects: vi.fn(),
  listSkills: vi.fn(),
  modelProvider: vi.fn(),
  openTargets: vi.fn(),
  interrupt: vi.fn(),
  sendMessage: vi.fn(),
  getRequirement: vi.fn(),
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
// Monaco 在 jsdom 里起不来：换成记录参数的占位，用来断言「定位到第几行」。
vi.mock("../src/components/MonacoView.js", async () => {
  const { createElement } = await import("react");
  return {
    MonacoView: (props: { path: string; revealLine?: number | null }) =>
      createElement("div", { "data-testid": "monaco-mock", "data-path": props.path, "data-reveal-line": props.revealLine ?? "" }),
  };
});
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

const REQUIREMENT_CONTEXT = {
  sessionId: "s1",
  kind: "requirement",
  contextMode: "tools",
  remoteProjectId: "proj-1",
  requirement: { remoteRequirementId: "r1", number: 3, title: "关联的需求", startVersion: 1, startedAt: 1 },
};

beforeEach(() => {
  window.localStorage.clear();
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
  apiMocks.getSessionContext.mockResolvedValue(REQUIREMENT_CONTEXT);
  apiMocks.getRequirement.mockResolvedValue({ id: "r1", number: 3, title: "关联的需求", status: "draft", version: 1 });
  apiMocks.listRequirementAttachments.mockResolvedValue({ items: [], requirementVersion: 1 });
  apiMocks.decideApproval.mockResolvedValue({});
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


describe("SessionRuntime 右栏「需求」标签", () => {
  it("右栏折叠时：头部「关联需求」入口可达，点击后打开需求概要", async () => {
    window.localStorage.setItem("suduo.session.sideOpen", "false");
    apiMocks.backfillSessionEvents.mockReset();
    apiMocks.backfillSessionEvents.mockResolvedValue([]);
    cacheMocks.loadEventCacheStart.mockReturnValue(null);
    const node = await render(<SessionRuntime projectId="p1" sessionId="s1" linkedRequirement={{ id: "r1", number: 3, title: "关联的需求" }} />);
    await settle();
    expect(q(node, "requirement-materials")).toBeNull();
    const entry = q(node, "side-requirement-entry");
    expect(entry).not.toBeNull();
    await act(async () => entry?.click());
    await settle();
    expect(apiMocks.getSessionContext).toHaveBeenCalledWith("s1");
    expect(q(node, "requirement-materials")?.getAttribute("data-linked")).toBe("true");
    expect(q(node, "requirement-material-title")?.textContent).toBe("关联的需求");
    expect(q(node, "requirement-material-open")?.getAttribute("href")).toBe("/p/proj-1/requirements/3");
    // 新版会话不显示旧版提示。
    expect(q(node, "legacy-session-banner")).toBeNull();
  });

  it("右栏被 Drawer 占用时：头部入口可达，点击后关闭 Drawer 并打开材料区", async () => {
    window.localStorage.setItem("suduo.session.sideOpen", "true");
    apiMocks.backfillSessionEvents.mockReset();
    apiMocks.backfillSessionEvents.mockResolvedValue([]);
    cacheMocks.loadEventCacheStart.mockReturnValue(null);
    apiMocks.listFiles.mockResolvedValue({ entries: [{ name: "a.ts", path: "a.ts", kind: "file" }] });
    apiMocks.readFile.mockResolvedValue({ path: "a.ts", text: "const x = 1;", truncated: false, size: 12, mediaType: "text/plain", type: "text" });
    const node = await render(<SessionRuntime projectId="p1" sessionId="s1" linkedRequirement={{ id: "r1", number: 3, title: "关联的需求" }} />);
    await settle();
    // 打开 Drawer：走文件树预览
    // Radix 标签页在 mousedown 时切换（真实点击会先有 mousedown）。
    await act(async () => q(node, "side-tab-files")?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0 })));
    const fileRow = [...node.querySelectorAll<HTMLElement>("button, [role='button']")].find((el) => el.textContent?.includes("a.ts")) ?? null;
    expect(fileRow).not.toBeNull();
    await act(async () => fileRow?.click());
    await settle();
    expect(q(node, "file-preview")).not.toBeNull();
    expect(q(node, "requirement-materials")).toBeNull();
    const entry = q(node, "side-requirement-entry");
    expect(entry).not.toBeNull();
    await act(async () => entry?.click());
    await settle();
    expect(q(node, "file-preview")).toBeNull();
    expect(q(node, "requirement-materials")?.getAttribute("data-linked")).toBe("true");
    expect(q(node, "requirement-material-title")?.textContent).toBe("关联的需求");
  });

  it("旧版需求会话：输入框上方一行提示，「回到需求」站内跳到需求页；头部入口由会话上下文兜底", async () => {
    apiMocks.getSessionContext.mockResolvedValue({ ...REQUIREMENT_CONTEXT, contextMode: "legacy" });
    apiMocks.backfillSessionEvents.mockReset();
    apiMocks.backfillSessionEvents.mockResolvedValue([]);
    cacheMocks.loadEventCacheStart.mockReturnValue(null);
    const node = await render(<SessionRuntime projectId="p1" sessionId="s1" />);
    await settle();
    const banner = q(node, "legacy-session-banner");
    expect(banner?.textContent).toContain("这是旧版需求会话：需求信息不会再自动更新。新建会话即可用工具直接查看需求、评论和附件。");
    expect(q(node, "side-requirement-entry")?.textContent).toContain("关联的需求");
    const back = q(node, "legacy-session-back");
    expect(back?.getAttribute("href")).toBe("/p/proj-1/requirements/3");
    const popstate = vi.fn();
    window.addEventListener("popstate", popstate);
    await act(async () => back?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })));
    window.removeEventListener("popstate", popstate);
    expect(window.location.pathname).toBe("/p/proj-1/requirements/3");
    expect(popstate).toHaveBeenCalledTimes(1);
    window.history.replaceState({}, "", "/");
  });
});

describe("SessionRuntime 房间任务会话", () => {
  it("输入区换成只读说明（不在服务端拒绝）；知道房间话题时「在讨论里查看」站内跳到房间并展开话题", async () => {
    apiMocks.getSession.mockResolvedValue({ ...session(), kind: "room_task" });
    apiMocks.backfillSessionEvents.mockReset();
    apiMocks.backfillSessionEvents.mockResolvedValue([]);
    cacheMocks.loadEventCacheStart.mockReturnValue(null);
    const node = await render(
      <SessionRuntime
        projectId="p1"
        sessionId="s1"
        roomTask={{ remoteProjectId: "proj-1", roomId: "room-1", roomName: "订单中心", threadRootId: "m-2", lastRunId: "run-1" }}
      />,
    );
    await settle();
    expect(q(node, "message-input")).toBeNull();
    const notice = q(node, "room-task-readonly");
    expect(notice?.textContent).toContain("这是房间任务会话：由房间里的 @ 触发，回答会发回房间。这里只读；要私下追问请新开会话。");
    const link = notice?.querySelector("a");
    expect(link?.textContent).toBe("在讨论里查看");
    expect(link?.getAttribute("href")).toBe("/p/proj-1/rooms/room-1?thread=m-2");
    const popstate = vi.fn();
    window.addEventListener("popstate", popstate);
    await act(async () => link?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })));
    window.removeEventListener("popstate", popstate);
    expect(`${window.location.pathname}${window.location.search}`).toBe("/p/proj-1/rooms/room-1?thread=m-2");
    expect(popstate).toHaveBeenCalledTimes(1);
    window.history.replaceState({}, "", "/");
  });

  it("拿不到房间话题时只有说明、没有链接；普通会话照常有输入框", async () => {
    apiMocks.getSession.mockResolvedValueOnce({ ...session(), kind: "room_task" });
    apiMocks.backfillSessionEvents.mockReset();
    apiMocks.backfillSessionEvents.mockResolvedValue([]);
    cacheMocks.loadEventCacheStart.mockReturnValue(null);
    const node = await render(<SessionRuntime projectId="p1" sessionId="s1" />);
    await settle();
    expect(q(node, "room-task-readonly")?.querySelector("a")).toBeNull();
    expect(q(node, "message-input")).toBeNull();

    await act(async () => root?.unmount());
    container?.remove();
    apiMocks.getSession.mockResolvedValue({ ...session(), kind: "normal" });
    const normal = await render(<SessionRuntime projectId="p1" sessionId="s1" />);
    await settle();
    expect(q(normal, "room-task-readonly")).toBeNull();
    expect(q(normal, "message-input")).not.toBeNull();
  });
});

describe("SessionRuntime 回答里的文件链接", () => {
  it("项目内相对 / 绝对路径点开在文件面板并定位到行；项目外路径只显示文字；网页链接新标签打开", async () => {
    apiMocks.backfillSessionEvents.mockReset();
    apiMocks.backfillSessionEvents.mockResolvedValue([]);
    cacheMocks.loadEventCacheStart.mockReturnValue(null);
    apiMocks.listProjects.mockResolvedValue({ items: [{ id: "p1", rootPath: "/code/order" }] });
    apiMocks.readFile.mockImplementation(async (_projectId: string, path: string) => ({
      path,
      type: "text",
      text: "a\nb\nc\n",
      truncated: false,
      size: 6,
      mediaType: "text/plain",
    }));
    const node = await render(<SessionRuntime projectId="p1" sessionId="s1" />);
    await settle();
    const stream = MockEventSource.instances.find((instance) => instance.url.includes("/events?after="));
    if (stream === undefined) throw new Error("events stream not opened");
    await act(async () => stream.emit("stream.live", {}));
    const text = [
      "入口在 [MerchantOrder.vue](src/views/MerchantOrder.vue:88)，",
      "服务端看 [Resp.java](/code/order/server/Resp.java#L12)，",
      "系统文件 [hosts](/etc/hosts)，",
      "文档 [官网](https://example.com)。",
      "<!-- suduo-action {\"type\":\"fetch_attachment\"} -->",
    ].join("\n");
    await act(async () => stream.emit("turn.started", envelope(201, "turn.started", "T1")));
    await act(async () => stream.emit("item.completed", envelope(202, "item.completed", "T1", { item: { id: "m1", type: "agentMessage", text } })));
    await act(async () => stream.emit("turn.completed", envelope(203, "turn.completed", "T1", { turn: { id: "T1", status: "completed" } })));
    await settle();

    const turn = node.querySelector<HTMLElement>("[data-turn-id='T1']");
    expect(turn?.textContent).not.toContain("suduo-action");
    const relative = [...(turn?.querySelectorAll("button") ?? [])].find((button) => button.textContent === "MerchantOrder.vue");
    const absolute = [...(turn?.querySelectorAll("button") ?? [])].find((button) => button.textContent === "Resp.java");
    expect(relative).toBeDefined();
    expect(absolute).toBeDefined();
    // 项目外路径：没有 <a>、没有按钮，只有文字。
    const anchors = [...(turn?.querySelectorAll("a") ?? [])];
    expect(anchors.map((anchor) => anchor.textContent)).toEqual(["官网"]);
    expect(anchors[0]?.getAttribute("target")).toBe("_blank");
    expect(turn?.textContent).toContain("hosts");

    await act(async () => relative?.click());
    await settle();
    expect(apiMocks.readFile).toHaveBeenLastCalledWith("p1", "src/views/MerchantOrder.vue");
    expect(q(node, "file-preview")).not.toBeNull();
    expect(q(node, "monaco-mock")?.getAttribute("data-reveal-line")).toBe("88");

    await act(async () => absolute?.click());
    await settle();
    expect(apiMocks.readFile).toHaveBeenLastCalledWith("p1", "server/Resp.java");
    expect(q(node, "monaco-mock")?.getAttribute("data-reveal-line")).toBe("12");
  });
});

describe("SessionRuntime 工具确认卡", () => {
  it("发评论的确认卡在审批坞里；点「发出」按现有审批接口回 accept", async () => {
    apiMocks.backfillSessionEvents.mockReset();
    apiMocks.backfillSessionEvents.mockResolvedValue([]);
    cacheMocks.loadEventCacheStart.mockReturnValue(null);
    apiMocks.listApprovals.mockResolvedValue({
      items: [
        {
          id: "ap-tool",
          sessionId: "s1",
          threadRef: { runtimeId: "codex-local", runtimeKind: "codex", threadId: "t1" },
          turnRef: { threadId: "t1", turnId: "T1" },
          kind: "other",
          status: "pending",
          decision: null,
          request: {
            nativeMethod: "item/tool/call",
            suDuoTool: {
              tool: "comment_submit",
              requirement: { id: "r1", projectId: "proj-1", number: 3, title: "关联的需求" },
              comment: { body: "待确认：\n1. 收货地址是否脱敏" },
              duplicateOf: null,
            },
          },
          requestedAt: 1,
          decidedAt: null,
          version: 1,
        },
      ],
    });
    const node = await render(<SessionRuntime projectId="p1" sessionId="s1" />);
    await settle();
    const card = q(node, "approval-card");
    expect(card?.getAttribute("data-variant")).toBe("suduo-tool");
    expect(card?.textContent).toContain("发评论到 REQ-3「关联的需求」");
    apiMocks.listApprovals.mockResolvedValue({ items: [] });
    // 工具确认卡出现 400ms 后按钮才可点（防连击误触），等它就绪再点。
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 450));
    });
    await act(async () => q(node, "approval-accept")?.click());
    await settle();
    expect(apiMocks.decideApproval).toHaveBeenCalledWith("ap-tool", "accept");
    expect(q(node, "approval-card")).toBeNull();
  });
});
