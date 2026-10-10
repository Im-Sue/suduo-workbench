// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ApprovalDto, DelegationDto, EventEnvelope, JsonValue, SchedulerSnapshotDto } from "@suduo/client-contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** 多 Agent 协作 S8 的界面：委派卡片、排队提示、运行面板、@ Agent 委派、停止级联、审批来源。 */

const apiMocks = vi.hoisted(() => ({
  cancelDelegation: vi.fn(),
  cancelAllDelegations: vi.fn(),
  listDelegations: vi.fn(),
  handbackDelegation: vi.fn(),
  cancelSchedulerItem: vi.fn(),
  promoteSchedulerItem: vi.fn(),
  schedulerSnapshot: vi.fn(),
  sendMessage: vi.fn(),
  uploadAttachment: vi.fn(),
  fileIndex: vi.fn(),
  listAllSessions: vi.fn(),
}));
vi.mock("../src/api/client.js", () => ({ api: apiMocks, ApiClientError: class ApiClientError extends Error {} }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ to, params, children, ...rest }: { to: string; params?: Record<string, string>; children?: ReactNode } & Record<string, unknown>) => {
    const href = Object.entries(params ?? {}).reduce((path, [key, value]) => path.replace(`$${key}`, value), to);
    return (
      <a href={href} {...(rest as object)}>
        {children}
      </a>
    );
  },
}));

const { buildTimeline } = await import("../src/event-projection/timeline.js");
const { messagesFor } = await import("../src/i18n/messages/index.js");
const { DelegationCard } = await import("../src/features/sessions/stream/DelegationCard.js");
const { RunPanel } = await import("../src/features/scheduler/RunPanel.js");
const { Composer } = await import("../src/components/Composer.js");
const { CascadeStopDialog } = await import("../src/features/sessions/CascadeStopDialog.js");
const { ApprovalDock } = await import("../src/features/sessions/ApprovalDock.js");
const { TooltipProvider } = await import("@/components/ui/tooltip");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const zh = messagesFor("zh-CN");

function delegation(patch: Partial<DelegationDto> = {}): DelegationDto {
  return {
    id: "d1",
    parentSessionId: "parent",
    childSessionId: "child",
    childTitle: "补集成测试",
    agentId: "claude-code",
    agentName: "Claude Code",
    task: "给导出接口补集成测试",
    origin: "agent",
    status: "running",
    autoHandback: false,
    delivered: false,
    pendingApprovals: 0,
    stalled: null,
    result: null,
    error: null,
    createdAt: 1,
    updatedAt: 1,
    finishedAt: null,
    ...patch,
  };
}

function event(seq: number, type: string, payload: JsonValue, turnId: string | null = null): EventEnvelope<string, JsonValue> {
  return { seq, eventId: "e" + String(seq), sessionId: "parent", source: "test", type, payload, threadRef: null, turnRef: turnId === null ? null : { threadId: "t", turnId }, ts: seq };
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;
async function render(node: ReactNode) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root?.render(<QueryClientProvider client={client}><TooltipProvider>{node}</TooltipProvider></QueryClientProvider>));
  for (let index = 0; index < 4; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
  return container;
}
const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

beforeEach(() => {
  apiMocks.cancelDelegation.mockResolvedValue(delegation({ status: "cancelled" }));
  apiMocks.handbackDelegation.mockResolvedValue(delegation({ status: "completed", delivered: true }));
});
afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.clearAllMocks();
});

describe("时间线：委派与排队", () => {
  it("同一委派只出一张卡片，取最新状态；排队项按 clientTurnId 对上出队记录（开起来、取消、重启、开不起来）", () => {
    const { timeline } = buildTimeline(
      [
        event(1, "delegation.updated", delegation({ status: "queued" }) as unknown as JsonValue),
        event(2, "turn.queued", { clientTurnId: "c1", queueItemId: "q1", position: 2 }),
        event(3, "delegation.updated", delegation({ status: "completed" }) as unknown as JsonValue),
        event(4, "turn.queued", { clientTurnId: "c4", queueItemId: "q4", position: 3 }),
        // 别的回合开始不影响排着的这条。
        event(5, "turn.started", { turn: { id: "t0" } }, "t0"),
        event(6, "turn.dequeued", { clientTurnId: "c1", queueItemId: "q1", reason: "started", turnId: "t1" }),
        event(7, "turn.queued", { clientTurnId: "c2", queueItemId: "q2", position: 1 }),
        event(8, "turn.dequeued", { clientTurnId: "c2", queueItemId: "q2", reason: "cancelled" }),
        event(9, "turn.start-failed", { clientTurnId: "c3", error: { message: "Claude Code 还没登录" } }),
        event(10, "turn.queued", { clientTurnId: "c5", queueItemId: "q5", position: 1 }),
        event(11, "turn.dequeued", { clientTurnId: "c5", queueItemId: "q5", reason: "restart" }),
        event(12, "turn.queued", { clientTurnId: "c6", queueItemId: "q6", position: 1 }),
        event(13, "turn.dequeued", { clientTurnId: "c6", queueItemId: "q6", reason: "requeued" }),
      ],
      [],
      new Map(),
      zh,
    );
    const cards = timeline.filter((entry) => entry.kind === "delegation");
    expect(cards).toHaveLength(1);
    expect(cards[0]!.kind === "delegation" ? cards[0]!.delegation.status : null).toBe("completed");
    const queued = timeline.filter((entry) => entry.kind === "queued");
    expect(queued.map((entry) => (entry.kind === "queued" ? [entry.itemId, entry.state] : null))).toEqual([
      ["q1", "started"],
      ["q4", "waiting"],
      ["q2", "dropped"],
      ["q5", "dropped"],
      ["q6", "dropped"],
    ]);
    const notices = timeline.flatMap((entry) => (entry.kind === "notice" ? [[entry.notice.text, entry.notice.level]] : []));
    // 工作台自己的说明进对话流（info 级只收进会话头）。
    expect(notices).toEqual([
      ["排队中的消息已取消，没有发给 Agent。", "important"],
      ["这一轮没能开始：Claude Code 还没登录", "error"],
      ["本机服务重启了，这条排队的消息没有发出，需要的话请重发。", "important"],
      ["本机服务重启了，这条排队的委派任务已自动重新排队。", "important"],
    ]);
  });
});

describe("委派卡片", () => {
  it("运行中：显示 Agent、任务、等审批，可停止、可打开子会话", async () => {
    await render(<DelegationCard delegation={delegation({ pendingApprovals: 2 })} />);
    expect(q("delegation-card")?.textContent).toContain("委派 · Claude Code");
    expect(q("delegation-waiting")?.textContent).toBe("等你确认 2 个操作");
    expect(q("delegation-open")?.getAttribute("href")).toBe("/sessions/child");
    await act(async () => q("delegation-stop")?.click());
    expect(apiMocks.cancelDelegation).toHaveBeenCalledWith("d1");
    expect(q("delegation-handback")).toBeNull();
  });

  it("卡住提醒（S12）：等确认太久、很久没动静各说一句；做完了不提；老事件没有这个字段也照常显示", async () => {
    await render(<DelegationCard delegation={delegation({ pendingApprovals: 1, stalled: { reason: "approval", since: Date.now() - 12 * 60_000 } })} />);
    expect(q("stall-note")?.textContent).toBe("已等你确认 12 分钟");
    await act(async () => root?.unmount());
    document.body.innerHTML = "";
    await render(<DelegationCard delegation={delegation({ stalled: { reason: "silent", since: Date.now() - 16 * 60_000 } })} />);
    expect(q("stall-note")?.textContent).toContain("16 分钟没有动静");
    await act(async () => root?.unmount());
    document.body.innerHTML = "";
    await render(<DelegationCard delegation={delegation({ status: "completed", stalled: { reason: "silent", since: 0 } })} />);
    expect(q("stall-note")).toBeNull();
    await act(async () => root?.unmount());
    document.body.innerHTML = "";
    const legacy = delegation();
    delete (legacy as Partial<DelegationDto>).stalled;
    await render(<DelegationCard delegation={legacy} />);
    expect(q("delegation-card")).not.toBeNull();
    expect(q("stall-note")).toBeNull();
  });

  it("做完了没交回：显示结果与改动，「让原 Agent 继续」；子会话删了说明一句", async () => {
    await render(
      <DelegationCard
        delegation={delegation({
          status: "completed",
          childSessionId: null,
          result: { finalMessage: "补了 3 个用例", changedFiles: [{ path: "test/a.test.ts", kind: "add" }], additions: 30, deletions: 0 },
        })}
      />,
    );
    expect(q("delegation-result")?.textContent).toContain("补了 3 个用例");
    expect(q("delegation-result")?.textContent).toContain("改了 1 个文件 · +30 −0");
    expect(q("delegation-card")?.textContent).toContain("子会话已删除");
    await act(async () => q("delegation-handback")?.click());
    expect(apiMocks.handbackDelegation).toHaveBeenCalledWith("d1");
  });
});

describe("运行面板", () => {
  const snapshot: SchedulerSnapshotDto = {
    running: [{ id: "r1", sessionId: "s1", sessionTitle: "导出接口", agentId: "claude-code", agentName: "Claude Code", source: "user", label: "导出接口", state: "running", position: null, enqueuedAt: 1, startedAt: 1 }],
    queued: [
      { id: "q1", sessionId: "s2", sessionTitle: "主会话", agentId: "claude-code", agentName: "Claude Code", source: "delegate", label: "补测试", state: "queued", position: 1, enqueuedAt: 2, startedAt: null },
      { id: "q2", sessionId: "s3", sessionTitle: "试做", agentId: "claude-code", agentName: "Claude Code", source: "trial", label: "试做", state: "queued", position: 2, enqueuedAt: 3, startedAt: null },
    ],
    limits: { global: 4, perAgent: { "claude-code": 1, codex: 2 } },
  };

  it("按 Agent 分组，运行中可停止、排队中可先跑与取消", async () => {
    apiMocks.schedulerSnapshot.mockResolvedValue(snapshot);
    apiMocks.promoteSchedulerItem.mockResolvedValue(snapshot);
    apiMocks.cancelSchedulerItem.mockResolvedValue(snapshot);
    await render(<RunPanel onNavigate={() => undefined} />);
    expect(q("run-panel")?.textContent).toContain("运行中 1/4");
    const group = document.querySelector('[data-testid="run-panel-agent"][data-agent-id="claude-code"]');
    expect(group?.textContent).toContain("Claude Code1/1");
    const items = [...document.querySelectorAll<HTMLElement>('[data-testid="run-panel-item"]')];
    expect(items.map((item) => item.getAttribute("data-state"))).toEqual(["running", "queued", "queued"]);
    expect(items[1]!.textContent).toContain("委派 · 主会话");
    await act(async () => items[2]!.querySelector<HTMLButtonElement>('[data-testid="run-panel-promote"]')?.click());
    expect(apiMocks.promoteSchedulerItem).toHaveBeenCalledWith("q2");
    // 停止运行中的：这个会话还有没做完的委派时就地问（R7）。
    apiMocks.listDelegations.mockResolvedValue({ items: [delegation({ status: "running" })] });
    apiMocks.cancelAllDelegations.mockResolvedValue({ items: [] });
    await act(async () => items[0]!.querySelector<HTMLButtonElement>('[data-testid="run-panel-cancel"]')?.click());
    expect(q("run-panel-cascade")?.textContent).toContain("这个会话还有 1 个委派没做完");
    expect(apiMocks.cancelSchedulerItem).not.toHaveBeenCalled();
    await act(async () => q("run-panel-stop-all")?.click());
    expect(apiMocks.cancelAllDelegations).toHaveBeenCalledWith("s1");
    expect(apiMocks.cancelSchedulerItem).toHaveBeenCalledWith("r1");
    // 没有委派就直接停。
    apiMocks.listDelegations.mockResolvedValue({ items: [] });
    apiMocks.cancelSchedulerItem.mockClear();
    await act(async () => items[0]!.querySelector<HTMLButtonElement>('[data-testid="run-panel-cancel"]')?.click());
    expect(q("run-panel-cascade")).toBeNull();
    expect(apiMocks.cancelSchedulerItem).toHaveBeenCalledWith("r1");
  });
});

describe("输入框 @ Agent 委派", () => {
  it("「@」面板列可以委派的 Agent，选中插入句柄；发出时不发给本会话，而是委派给它", async () => {
    apiMocks.fileIndex.mockResolvedValue({ items: [], truncated: false });
    const onDelegate = vi.fn().mockResolvedValue(undefined);
    await render(
      <Composer
        disabled={false}
        projectId="p1"
        projectRoot="/repo"
        sessionId="s1"
        skills={[]}
        skillPath=""
        onSkillPath={() => undefined}
        onError={() => undefined}
        delegateAgents={[{ id: "claude-code", name: "Claude Code" }]}
        onDelegate={onDelegate}
      />,
    );
    const textarea = q("message-input") as HTMLTextAreaElement;
    const type = async (value: string) => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set;
      await act(async () => {
        setter?.call(textarea, value);
        textarea.dispatchEvent(new Event("input", { bubbles: true }));
      });
    };
    await type("@cla");
    const agent = document.querySelector<HTMLElement>("[data-testid='palette-agent']")?.closest<HTMLElement>("[data-testid='palette-item']");
    expect(agent?.textContent).toContain("把这条消息作为任务交给 Claude Code");
    await act(async () => agent?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })));
    expect(textarea.value).toBe("@[Claude Code](suduo://agent/claude-code) ");
    await type(textarea.value + "给导出接口补集成测试");
    await act(async () => q("send-message")?.click());
    expect(onDelegate).toHaveBeenCalledWith("claude-code", "给导出接口补集成测试");
    expect(apiMocks.sendMessage).not.toHaveBeenCalled();
    expect(textarea.value).toBe("");
  });

  it("@ 了几家时说明一次只能委派给一家，不悄悄只发给第一家", async () => {
    const onDelegate = vi.fn().mockResolvedValue(undefined);
    const onError = vi.fn();
    await render(
      <Composer
        disabled={false}
        projectId="p1"
        projectRoot="/repo"
        sessionId="s1"
        skills={[]}
        skillPath=""
        onSkillPath={() => undefined}
        onError={onError}
        delegateAgents={[{ id: "claude-code", name: "Claude Code" }, { id: "codex", name: "Codex" }]}
        onDelegate={onDelegate}
      />,
    );
    const textarea = q("message-input") as HTMLTextAreaElement;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(textarea, "@[Claude Code](suduo://agent/claude-code) @[Codex](suduo://agent/codex) 一起看看");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(async () => q("send-message")?.click());
    expect(onDelegate).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith("一次只能委派给一个 Agent。");
  });
});

describe("停止级联与审批来源", () => {
  it("停止时问是否一并停止子任务", async () => {
    const onStopAll = vi.fn();
    const onStopThis = vi.fn();
    await render(<CascadeStopDialog open count={2} onOpenChange={() => undefined} onStopAll={onStopAll} onStopThis={onStopThis} />);
    expect(q("cascade-stop-dialog")?.textContent).toContain("这个会话还有 2 个委派没做完");
    await act(async () => q("cascade-stop-all")?.click());
    expect(onStopAll).toHaveBeenCalled();
    await act(async () => q("cascade-stop-this")?.click());
    expect(onStopThis).toHaveBeenCalled();
  });

  it("审批坞里来自委派子会话的卡片标明来源", async () => {
    const approval: ApprovalDto = {
      id: "a1",
      sessionId: "child",
      threadRef: { runtimeId: "r", runtimeKind: "claude", threadId: "t" },
      turnRef: null,
      kind: "command",
      status: "pending",
      decision: null,
      request: { command: "pnpm test" },
      requestedAt: 1,
      decidedAt: null,
      version: 1,
      origin: { sessionId: "child", sessionTitle: "补集成测试", agentName: "Claude Code", delegationId: "d1", task: "给导出接口补集成测试" },
    };
    await render(<ApprovalDock approvals={[approval]} onDecide={async () => undefined} />);
    expect(q("approval-origin")?.textContent).toBe("来自委派：Claude Code · 给导出接口补集成测试");
  });
});
