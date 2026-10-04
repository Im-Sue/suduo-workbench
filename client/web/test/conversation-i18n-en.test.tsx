// @vitest-environment jsdom

import type { ApprovalDto, SessionDto, SessionListItemDto } from "@suduo/client-contracts";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "../src/components/ui/tooltip.js";
import type { ConversationMessage } from "../src/event-projection/reducer.js";
import type { TimelineStep, TurnTimeline } from "../src/event-projection/timeline.js";
import { ApprovalDock, approvalQuestion } from "../src/features/sessions/ApprovalDock.js";
import { useAttentionSignals } from "../src/features/sessions/attention.js";
import { SessionHeader } from "../src/features/sessions/SessionHeader.js";
import { SessionList } from "../src/features/sessions/SessionList.js";
import { effortLabel, prettifyModel, SessionModelSwitcher } from "../src/features/sessions/SessionModelSwitcher.js";
import { collapseEmptyThinking, stepGroupSummary, turnSummaryText } from "../src/features/sessions/stream/describe.js";
import { TurnView } from "../src/features/sessions/stream/TurnView.js";
import { UserBubble } from "../src/features/sessions/stream/UserBubble.js";
import { applyLocalePreference } from "../src/i18n/locale.js";
import { stepText } from "../src/session/run-state.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const DAY = 24 * 60 * 60 * 1000;

let root: Root | null = null;

beforeEach(() => {
  applyLocalePreference("en");
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
  document.body.innerHTML = "";
  vi.unstubAllGlobals();
  applyLocalePreference("system");
  localStorage.clear();
});

async function render(element: ReactElement): Promise<HTMLDivElement> {
  const host = document.body.appendChild(document.createElement("div"));
  root = createRoot(host);
  await act(async () => root?.render(<TooltipProvider>{element}</TooltipProvider>));
  return host;
}

const q = (node: ParentNode, testId: string) => node.querySelector<HTMLElement>(`[data-testid="${testId}"]`);

function listItem(id: string, patch: Partial<SessionListItemDto> = {}): SessionListItemDto {
  return {
    id,
    projectId: "local-1",
    title: `Session ${id}`,
    state: "active",
    purpose: "general",
    approvalMode: "ask",
    model: null,
    reasoningEffort: null,
    createdAt: Date.now() - 10 * DAY,
    updatedAt: Date.now() - 10 * DAY,
    lastActivityAt: Date.now(),
    version: 1,
    threads: [],
    project: { id: "local-1", name: "Checkout", rootPath: "/code/checkout", state: "active", remoteProjectId: "p1" },
    requirement: null,
    preview: null,
    runStatus: { running: false, pendingApprovals: 0, lastTurnOutcome: null },
    ...patch,
  } as SessionListItemDto;
}

function sessionList(props: Partial<Parameters<typeof SessionList>[0]> = {}) {
  return (
    <SessionList
      items={[]}
      loading={false}
      error={null}
      hasMore={false}
      loadingMore={false}
      activeSessionId={null}
      live={null}
      filter="all"
      keyword=""
      canCreate
      createDisabledReason=""
      onFilterChange={vi.fn()}
      onKeywordChange={vi.fn()}
      onLoadMore={vi.fn()}
      onOpen={vi.fn()}
      onCreate={vi.fn()}
      onRename={vi.fn()}
      onArchive={vi.fn()}
      onDelete={vi.fn()}
      {...props}
    />
  );
}

function step(id: string, patch: Partial<TimelineStep> = {}): TimelineStep {
  return {
    id,
    kind: "read",
    title: `Read ${id}`,
    detail: "",
    output: "",
    progress: null,
    status: "completed",
    exitCode: null,
    durationMs: 1_000,
    startedTs: 0,
    endedTs: 18_000,
    seq: 1,
    ...patch,
  };
}

function turn(patch: Partial<TurnTimeline> = {}): TurnTimeline {
  return {
    id: "turn:t1",
    turnId: "t1",
    status: "completed",
    seq: 1,
    startedTs: 0,
    endedTs: 134_000,
    truncatedHead: false,
    blocks: [
      { kind: "steps", id: "steps:1", seq: 1, steps: [step("a.ts"), step("b.ts"), step("c", { kind: "command", title: "Run pnpm test" })] },
      {
        kind: "file-change",
        id: "files:1",
        seq: 2,
        status: "completed",
        changes: [{ path: "src/app.ts", kind: "update", movePath: null, additions: 3, deletions: 1, diff: "" }],
      },
    ],
    plan: null,
    error: null,
    currentStep: null,
    awaitingApproval: false,
    summary: { durationMs: 134_000, filesChanged: 1, additions: 3, deletions: 1, commands: 1 },
    ...patch,
  };
}

const approval = (kind: ApprovalDto["kind"], request: Record<string, unknown>, id = "ap-1"): ApprovalDto =>
  ({
    id,
    sessionId: "s1",
    threadRef: { runtimeId: "codex", runtimeKind: "codex", threadId: "t" },
    turnRef: null,
    kind,
    status: "pending",
    decision: null,
    request: { request },
    requestedAt: id === "ap-1" ? 1 : 2,
    decidedAt: null,
    version: 1,
  }) as ApprovalDto;

describe("会话区英文界面", () => {
  it("会话列表：标题、筛选、分组、最后一句与操作", async () => {
    const node = await render(
      sessionList({
        items: [
          listItem("a", { runStatus: { running: true, pendingApprovals: 0, lastTurnOutcome: null }, preview: { role: "user", text: "Add tests" } }),
          listItem("b", { title: "", lastActivityAt: Date.now() - DAY }),
          listItem("c", { lastActivityAt: Date.now() - 5 * DAY }),
        ],
      }),
    );
    expect(node.querySelector("h2")?.textContent).toBe("Sessions");
    expect(q(node, "new-session")?.textContent).toBe("New");
    expect(q(node, "session-search")?.getAttribute("placeholder")).toBe("Search titles, requirement IDs, or content");
    expect(node.querySelector("nav")?.getAttribute("aria-label")).toBe("Session list");
    const filters = node.querySelector('[aria-label="Filter sessions"]')?.textContent;
    expect(filters).toContain("All");
    expect(filters).toContain("Running 1");
    expect(filters).toContain("Needs me");
    expect(filters).toContain("Room tasks");
    expect([...node.querySelectorAll("h3")].map((heading) => heading.textContent)).toEqual(["Today", "Yesterday", "Earlier"]);
    const rows = [...node.querySelectorAll('[data-testid="session-row"]')].map((row) => row.textContent ?? "");
    expect(rows[0]).toContain("You: Add tests");
    expect(rows[1]).toContain("Untitled session");
    expect(node.querySelector('[aria-label="More actions for session “Session c”"]')).not.toBeNull();
  });

  it("会话列表的空状态：没有会话、筛选后为空、搜不到", async () => {
    const empty = await render(sessionList());
    expect(q(empty, "sessions-empty")?.textContent).toContain("No sessions in this project yet");
    await act(async () => root?.unmount());

    const running = await render(sessionList({ items: [listItem("a")], filter: "running" }));
    expect(q(running, "sessions-empty")?.textContent).toContain("No running sessions");
    expect(q(running, "sessions-empty")?.textContent).toContain("Switch to “All” to see every session.");
    await act(async () => root?.unmount());

    const search = await render(sessionList({ items: [listItem("a")], keyword: "invoice " }));
    expect(q(search, "sessions-empty")?.textContent).toContain("No results for “invoice”");
    expect(search.querySelector('[aria-label="Clear search"]')).not.toBeNull();
  });

  it("会话头：重命名、状态、运行提示、检查面板开关", async () => {
    const session = { id: "s1", projectId: "p1", title: "Export orders", state: "active", purpose: "general", approvalMode: "ask", createdAt: 1, updatedAt: 1, lastActivityAt: null, version: 1, threads: [] } as SessionDto;
    const node = await render(
      <SessionHeader
        session={session}
        status="approval"
        requirement={{ title: null }}
        projectRoot="/code/checkout"
        notices={[{ id: "n1", ts: 1, text: "Notice", level: "info" }]}
        inspectorOpen={false}
        onRename={vi.fn()}
        onOpenRequirement={vi.fn()}
        onToggleInspector={vi.fn()}
      />,
    );
    expect(q(node, "rename-session")?.getAttribute("aria-label")).toBe("Rename session");
    expect(q(node, "session-status")?.textContent).toBe("Waiting for you");
    expect(q(node, "side-requirement-entry")?.textContent).toBe("Linked requirement");
    expect(node.querySelector('[aria-label="1 runtime notice"]')).not.toBeNull();
    expect(node.querySelector('[aria-label="Open inspector panel"]')).not.toBeNull();
  });

  it("审批坞：问题、目录、批准 / 拒绝按钮与按键说明、多个时的序号", async () => {
    const node = await render(
      <ApprovalDock
        approvals={[approval("command", { command: "pnpm test", cwd: "/code/checkout" }), approval("other", {}, "ap-2")]}
        onDecide={vi.fn().mockResolvedValue(undefined)}
      />,
    );
    const card = q(node, "approval-card");
    expect(card?.getAttribute("aria-label")).toBe("Waiting for you");
    expect(card?.textContent).toContain("Codex wants to run a command");
    expect(card?.textContent).toContain("In /code/checkout");
    expect(card?.textContent).toContain("⏎ Approve · Esc Decline");
    expect(q(node, "approval-accept")?.textContent).toBe("Approve");
    expect(q(node, "approval-decline")?.textContent).toBe("Decline");
    expect(q(node, "approval-more")?.getAttribute("aria-label")).toBe("More approval options");
    expect(node.querySelector('[aria-label="1 of 2"]')?.textContent).toBe("1/2");
    expect(approvalQuestion("command", { request: { kind: "writeStdin" } })).toBe("Codex wants to send input to a running command");
  });

  it("审批坞：改文件时说几个文件；发评论的确认卡按钮是 Send / Don't send", async () => {
    const files = await render(
      <ApprovalDock
        approvals={[approval("file-change", { itemId: "i1" })]}
        onDecide={vi.fn()}
        changesFor={() => [
          { path: "src/a.ts", kind: "update", movePath: null, additions: 1, deletions: 0, diff: "" },
          { path: "src/b.ts", kind: "add", movePath: null, additions: 2, deletions: 0, diff: "" },
        ]}
        onViewPatch={vi.fn()}
      />,
    );
    expect(q(files, "approval-card")?.textContent).toContain("Codex wants to edit 2 files");
    expect(files.querySelector('[title="View changes to src/a.ts"]')).not.toBeNull();
    await act(async () => root?.unmount());

    const tool = await render(
      <ApprovalDock
        approvals={[
          {
            ...approval("other", {}),
            request: {
              nativeMethod: "item/tool/call",
              suDuoTool: { tool: "comment_submit", requirement: { id: "r1", projectId: "p1", number: 1, title: "Checkout" }, comment: { body: "Looks good" }, duplicateOf: null },
            },
          } as ApprovalDto,
        ]}
        onDecide={vi.fn()}
      />,
    );
    expect(tool.textContent).toContain("Can't be undone once sent");
    expect(q(tool, "approval-decline")?.textContent).toBe("Don't send");
    expect(q(tool, "approval-accept")?.textContent).toBe("Send");
  });

  it("回合视图：过程卡摘要、改动卡、结束摘要与操作", async () => {
    const node = await render(<TurnView turn={turn()} now={0} actions={{ onViewChanges: vi.fn(), onRestoreBefore: vi.fn(), onOpenChange: vi.fn() }} />);
    expect(q(node, "turn-card")?.textContent).toBe("Read 2 files · Ran 1 command · 18s");
    const change = q(node, "change-card");
    expect(change?.querySelector("header")?.textContent).toContain("Edited 1 file");
    expect(change?.textContent).toContain("Edited");
    expect(change?.querySelector('[title="View changes to src/app.ts in the inspector panel"]')).not.toBeNull();
    const summary = q(node, "turn-summary");
    expect(summary?.textContent).toContain("Done · Took 2 min 14s · Edited 1 file · Ran 1 command");
    expect(summary?.textContent).toContain("View changes");
    expect(summary?.textContent).toContain("Restore to before this turn");
  });

  it("回合视图：失败卡、等你确认与计划", async () => {
    const failed = turn({
      status: "failed",
      blocks: [{ kind: "steps", id: "steps:1", seq: 1, steps: [step("x", { kind: "approval", status: "waiting", endedTs: null })] }],
      plan: { explanation: null, steps: [{ text: "Write tests", status: "pending" }] },
      error: { message: "Model service error.", retrying: false },
      summary: { durationMs: null, filesChanged: 0, additions: 0, deletions: 0, commands: 0 },
    });
    const node = await render(<TurnView turn={failed} now={0} actions={{ onRetry: vi.fn() }} />);
    expect(q(node, "turn-error")?.textContent).toContain("This turn didn't finish");
    expect(q(node, "turn-error")?.textContent).toContain("Retry");
    expect(q(node, "plan-checklist")?.getAttribute("aria-label")).toBe("Plan");
    expect(node.querySelector('[aria-label="To do"]')).not.toBeNull();
    expect(q(node, "turn-card")?.textContent).toContain("Waiting for you");
  });

  it("摘要函数：步骤数、连续空思考、回合结局", () => {
    expect(stepGroupSummary([step("a", { kind: "thinking", endedTs: 0 }), step("b", { kind: "other", endedTs: 0 })])).toBe("2 steps");
    expect(stepGroupSummary([step("a", { kind: "web", endedTs: 0 })])).toBe("Searched the web once");
    const thinking = collapseEmptyThinking([step("a", { kind: "thinking" }), step("b", { kind: "thinking" }), step("c", { kind: "thinking" })]);
    expect(thinking.map((entry) => entry.title)).toEqual(["Thinking ×3"]);
    expect(turnSummaryText(turn({ status: "interrupted", summary: { durationMs: null, filesChanged: 0, additions: 0, deletions: 0, commands: 3 } }))).toBe(
      "Stopped · Ran 3 commands",
    );
  });

  it("用户消息：归属与图片附件", async () => {
    const message: ConversationMessage = {
      id: "m1",
      role: "user",
      text: "Also update the docs",
      ts: Date.now(),
      turnId: "t1",
      clientTurnId: "c1",
      attribution: "merged",
      interruptedNote: true,
      attachments: ["att-1"],
      skills: [],
    };
    const node = await render(<UserBubble message={message} />);
    expect(q(node, "message-attribution")?.textContent).toBe("Joined current work (Recorded in the turn that's running)");
    expect(q(node, "message-interrupted-note")?.textContent).toContain("This turn was interrupted");
    expect(q(node, "attachment-chip")?.textContent).toBe("Image attachment");
  });

  it("模型与推理强度切换：触发器文字与说明", async () => {
    const session = { id: "s1", projectId: "p1", title: "x", state: "active", purpose: "general", approvalMode: "ask", model: null, reasoningEffort: "high", createdAt: 1, updatedAt: 1, lastActivityAt: null, version: 1, threads: [] } as SessionDto;
    const node = await render(<SessionModelSwitcher session={session} provider={null} onChanged={vi.fn()} onOpenSettings={vi.fn()} onError={vi.fn()} />);
    const chip = q(node, "model-chip");
    expect(chip?.textContent).toBe("Default modelDeep");
    expect(chip?.getAttribute("title")).toBe("Model and reasoning effort (this session, from the next turn)");
    expect(prettifyModel(null)).toBe("Default model");
    expect(prettifyModel("gpt-5.6-sol")).toBe("5.6 Sol");
    expect(effortLabel(null)).toBe("Default");
  });

  it("状态行", () => {
    expect(stepText({ kind: "command", title: "Run command", detail: "pnpm test" })).toBe("Running pnpm test");
    expect(stepText({ kind: "file", title: "Edit files", detail: "" })).toBe("Updating files");
    expect(stepText({ kind: "tool", title: "Search", detail: "README" })).toBe("Calling Search · README");
  });

  it("后台提醒：标题前缀按英文", async () => {
    let hidden = false;
    Object.defineProperty(document, "hidden", { configurable: true, get: () => hidden });
    document.title = "SuDuo";
    function Probe({ status }: { status: "running" | "approval" }) {
      useAttentionSignals(status, "Export orders");
      return null;
    }
    await render(<Probe status="running" />);
    hidden = true;
    await act(async () => root?.render(<TooltipProvider><Probe status="approval" /></TooltipProvider>));
    expect(document.title).toBe("● Waiting for you · SuDuo");
    hidden = false;
    await act(async () => document.dispatchEvent(new Event("visibilitychange")));
    expect(document.title).toBe("SuDuo");
  });
});
