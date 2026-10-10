// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AgentDto, EventEnvelope, JsonValue, ReviewDto, SessionDto } from "@suduo/client-contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

/** 多 Agent 协作 S9 的界面：评审卡片（意见、勾选交回、退化、停止）、请另一个 Agent 评审的对话框、时间线。 */

const apiMocks = vi.hoisted(() => ({
  applyReview: vi.fn(),
  cancelReview: vi.fn(),
  startReview: vi.fn(),
  listLocalAgents: vi.fn(),
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
const { ReviewCard } = await import("../src/features/sessions/stream/ReviewCard.js");
const { ReviewDialog } = await import("../src/features/sessions/ReviewDialog.js");
const { TooltipProvider } = await import("@/components/ui/tooltip");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const zh = messagesFor("zh-CN");

function review(patch: Partial<ReviewDto> = {}): ReviewDto {
  return {
    id: "r1",
    targetSessionId: "target",
    reviewerSessionId: "reviewer",
    reviewerDeleted: false,
    agentId: "codex",
    agentName: "Codex",
    origin: "user",
    focus: ["correctness", "tests"],
    note: null,
    status: "submitted",
    findings: [
      { id: "f1", severity: "high", file: "src/export.ts", line: 42, title: "没处理空列表", detail: "orders 为空时会抛异常", suggestion: "先判断长度" },
      { id: "f2", severity: "low", file: null, line: null, title: "命名不一致", detail: "exportRows 与 rowsExport 混用", suggestion: null },
    ],
    summary: "有一个要修",
    finalMessage: null,
    appliedFindingIds: [],
    error: null,
    createdAt: 1,
    updatedAt: 1,
    finishedAt: 2,
    ...patch,
  };
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
const all = (id: string) => [...document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  vi.clearAllMocks();
});

describe("时间线：评审卡片", () => {
  it("同一评审只出一张卡片，取最新状态", () => {
    const event = (seq: number, payload: ReviewDto): EventEnvelope<string, JsonValue> => ({
      seq,
      eventId: "e" + String(seq),
      sessionId: "target",
      source: "test",
      type: "review.updated",
      payload: payload as unknown as JsonValue,
      threadRef: null,
      turnRef: null,
      ts: seq,
    });
    const { timeline } = buildTimeline([event(1, review({ status: "running", findings: [] })), event(2, review())], [], new Map(), zh);
    const cards = timeline.filter((entry) => entry.kind === "review");
    expect(cards).toHaveLength(1);
    expect(cards[0]!.kind === "review" ? cards[0]!.review.status : null).toBe("submitted");
  });
});

describe("评审卡片", () => {
  it("逐条列出意见（严重程度、文件与行、建议），默认勾上高、中两级；交回只发勾选的", async () => {
    apiMocks.applyReview.mockResolvedValue(review({ appliedFindingIds: ["f1"] }));
    await render(<ReviewCard review={review()} />);
    expect(q("review-card")?.textContent).toContain("评审 · Codex");
    expect(q("review-summary")?.textContent).toContain("有一个要修");
    const rows = all("review-finding");
    expect(rows.map((row) => row.getAttribute("data-severity"))).toEqual(["high", "low"]);
    expect(rows[0]!.textContent).toContain("src/export.ts:42");
    expect(rows[0]!.textContent).toContain("建议：先判断长度");
    const checks = all("review-finding-check");
    expect(checks.map((check) => check.getAttribute("data-state"))).toEqual(["checked", "unchecked"]);
    expect(q("review-apply")?.textContent).toContain("交给原 Agent 修改（1 条）");
    await act(async () => q("review-apply")?.click());
    expect(apiMocks.applyReview).toHaveBeenCalledWith("r1", ["f1"]);
    expect(q("review-stop")).toBeNull();
  });

  it("没拿到结构化意见：显示评审 Agent 的最终回答与说明；评审中可以停止", async () => {
    apiMocks.cancelReview.mockResolvedValue(review({ status: "cancelled" }));
    await render(<ReviewCard review={review({ status: "unstructured", findings: [], summary: null, finalMessage: "第 42 行没处理空列表。" })} />);
    expect(q("review-unstructured")?.textContent).toContain("没有用工具交回意见");
    expect(q("review-unstructured")?.textContent).toContain("第 42 行没处理空列表。");
    expect(q("review-apply")).toBeNull();
    await act(async () => root?.unmount());
    container?.remove();
    await render(<ReviewCard review={review({ status: "running", findings: [], summary: null, finishedAt: null })} />);
    await act(async () => q("review-stop")?.click());
    expect(apiMocks.cancelReview).toHaveBeenCalledWith("r1");
  });

  it("评审中途意见到了：按新的意见默认勾选", async () => {
    await render(<ReviewCard review={review({ status: "running", findings: [], summary: null, finishedAt: null })} />);
    expect(all("review-finding")).toHaveLength(0);
    await act(async () => root?.render(<ReviewCard review={review({ finishedAt: null })} />));
    expect(all("review-finding-check").map((check) => check.getAttribute("data-state"))).toEqual(["checked", "unchecked"]);
  });

  it("评审会话删了：说明一句，意见照留", async () => {
    await render(<ReviewCard review={review({ reviewerSessionId: null, reviewerDeleted: true })} />);
    expect(q("review-open")).toBeNull();
    expect(q("review-card")?.textContent).toContain("评审会话已删除");
    expect(all("review-finding")).toHaveLength(2);
    // 还没建好（不是删了）：不说「已删除」。
    await act(async () => root?.unmount());
    container?.remove();
    await render(<ReviewCard review={review({ reviewerSessionId: null, reviewerDeleted: false, status: "queued", findings: [], summary: null, finishedAt: null })} />);
    expect(q("review-card")?.textContent).not.toContain("评审会话已删除");
  });
});

describe("请另一个 Agent 评审", () => {
  const agent = (id: string, displayName: string, patch: Partial<AgentDto> = {}) =>
    ({ id, displayName, runtimeAvailable: true, enabled: true, status: "ready", readOnlyCapable: true, ...patch }) as AgentDto;

  it("只列做得到只读、能用的 Agent，默认避开这个会话的那一家；按选的关注点发起", async () => {
    apiMocks.listLocalAgents.mockResolvedValue({
      defaultAgentId: "claude-code",
      agents: [agent("claude-code", "Claude Code"), agent("codex", "Codex"), agent("gemini", "Gemini CLI", { readOnlyCapable: false }), agent("opencode", "OpenCode", { enabled: false })],
    });
    apiMocks.startReview.mockResolvedValue(review({ status: "running" }));
    const onOpenChange = vi.fn();
    await render(<ReviewDialog session={{ id: "s1", title: "导出接口", agentId: "claude-code" } as SessionDto} open onOpenChange={onOpenChange} />);
    const options = all("review-agent");
    expect(options.map((option) => option.getAttribute("data-agent-id"))).toEqual(["claude-code", "codex"]);
    expect(options.find((option) => option.getAttribute("data-state") === "checked")?.getAttribute("data-agent-id")).toBe("codex");
    // 去掉「安全」「是否满足需求」两个关注点。
    for (const focus of ["security", "requirement"]) {
      await act(async () => document.querySelector<HTMLElement>(`[data-testid="review-focus"][data-focus="${focus}"]`)?.click());
    }
    await act(async () => q("review-start")?.click());
    expect(apiMocks.startReview).toHaveBeenCalledWith("s1", { agentId: "codex", focus: ["correctness", "tests"] });
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("没有能只读评审的 Agent：说明一句，不能开始", async () => {
    apiMocks.listLocalAgents.mockResolvedValue({ defaultAgentId: "codex", agents: [agent("gemini", "Gemini CLI", { readOnlyCapable: false })] });
    await render(<ReviewDialog session={{ id: "s1", title: "导出接口", agentId: "codex" } as SessionDto} open onOpenChange={() => undefined} />);
    expect(q("review-no-agents")).not.toBeNull();
    expect(q("review-start")?.hasAttribute("disabled")).toBe(true);
  });
});
