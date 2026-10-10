// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { EventEnvelope, JsonValue, ReviewDto, SharedDraftDto, SharedDraftSummaryDto } from "@suduo/client-contracts";
import type { SharedItemDto } from "@suduo/cloud-contracts";
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

/** 多 Agent 协作 S11 的界面：共享对象草稿卡与发布对话框（疑似密钥、编辑、再发布）、评审卡发布、需求的 AI 协作区、项目 AI 规范。 */

const apiMocks = vi.hoisted(() => ({
  getSharedDraft: vi.fn(),
  updateSharedDraft: vi.fn(),
  publishSharedDraft: vi.fn(),
  discardSharedDraft: vi.fn(),
  createReviewDraft: vi.fn(),
  listSharedItems: vi.fn(),
  listAiActivity: vi.fn(),
  getSharedItem: vi.fn(),
  retractSharedItem: vi.fn(),
  getProjectAiRules: vi.fn(),
  listProjectAiRulesVersions: vi.fn(),
  getProjectAiRulesVersion: vi.fn(),
  saveProjectAiRules: vi.fn(),
  applyReview: vi.fn(),
  cancelReview: vi.fn(),
  listLocalAgents: vi.fn(),
}));
const ApiClientError = vi.hoisted(
  () =>
    class ApiClientError extends Error {
      constructor(
        readonly status: number,
        readonly code: string,
        message: string,
      ) {
        super(message);
      }
    },
);
vi.mock("../src/api/client.js", () => ({ api: apiMocks, ApiClientError }));
vi.mock("../src/features/requirements/cloud-features.js", () => ({ useCloudFeature: () => true }));
vi.mock("@tanstack/react-router", () => ({
  Link: ({ children, ...rest }: { children?: ReactNode } & Record<string, unknown>) => <a {...(rest as object)}>{children}</a>,
}));

const { buildTimeline } = await import("../src/event-projection/timeline.js");
const { ShareContext } = await import("../src/features/collab/share-context.js");
const { SharedDraftCard } = await import("../src/features/sessions/stream/SharedDraftCard.js");
const { SharedDraftDialog } = await import("../src/features/collab/SharedDraftDialog.js");
const { ReviewCard } = await import("../src/features/sessions/stream/ReviewCard.js");
const { AiCollabSection } = await import("../src/features/requirements/sections/AiCollab.js");
const { ProjectAiRulesSetting } = await import("../src/features/collab/ProjectAiRules.js");
const { RulesNotice } = await import("../src/features/collab/RulesNotice.js");
const { TooltipProvider } = await import("@/components/ui/tooltip");

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | null = null;
let container: HTMLDivElement | null = null;
async function render(node: ReactNode) {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => root?.render(<QueryClientProvider client={client}><TooltipProvider>{node}</TooltipProvider></QueryClientProvider>));
  await settle();
}
async function settle() {
  for (let index = 0; index < 6; index += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}
const q = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const all = (id: string) => [...document.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`)];
const type = async (element: HTMLElement, value: string) => {
  const proto = element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
};

afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  root = null;
  document.body.innerHTML = "";
  vi.clearAllMocks();
});

function draft(patch: Partial<SharedDraftDto> = {}): SharedDraftDto {
  return {
    id: "d1",
    kind: "handoff",
    sessionId: "s1",
    reviewId: null,
    remoteRequirementId: "req-1",
    agentId: "claude-code",
    title: "交接：订单导出",
    content: { summary: "导出做完一半", decisions: ["按月分页"], todo: [], risks: [], branch: null, files: [] },
    status: "draft",
    publishedItemId: null,
    secretHits: [],
    createdAt: 1,
    updatedAt: 1,
    ...patch,
  };
}

function summary(patch: Partial<SharedDraftSummaryDto> = {}): SharedDraftSummaryDto {
  return { id: "d1", kind: "handoff", sessionId: "s1", title: "交接：订单导出", status: "draft", publishedItemId: null, secretHitCount: 0, updatedAt: 1, ...patch };
}

function envelope(seq: number, type: string, payload: JsonValue): EventEnvelope {
  return { eventId: `e${String(seq)}`, sessionId: "s1", seq, type, ts: seq, source: "suduo:shared-draft", payload } as unknown as EventEnvelope;
}

describe("共享对象草稿", () => {
  it("时间线：同一份草稿只出一张卡片，取最新状态", () => {
    const { timeline } = buildTimeline(
      [
        envelope(1, "shared_draft.updated", summary() as unknown as JsonValue),
        envelope(2, "shared_draft.updated", summary({ status: "published", publishedItemId: "item-1" }) as unknown as JsonValue),
      ],
      [],
      new Map(),
    );
    const cards = timeline.filter((entry) => entry.kind === "sharedDraft");
    expect(cards).toHaveLength(1);
    expect(cards[0]).toMatchObject({ draft: { status: "published" } });
  });

  it("草稿卡：需求会话里给「预览并发布」（打开对话框）；疑似密钥标出处数；发布后可以再发布；不能发布的会话不给按钮", async () => {
    const openDraft = vi.fn();
    await render(
      <ShareContext.Provider value={{ canPublish: true, openDraft }}>
        <SharedDraftCard draft={summary({ secretHitCount: 1 })} />
        <SharedDraftCard draft={summary({ id: "d2", status: "published" })} />
      </ShareContext.Provider>,
    );
    const [first, second] = all("shared-draft-card");
    expect(first!.textContent).toContain("疑似密钥 1 处");
    await act(async () => first!.querySelector<HTMLElement>('[data-testid="shared-draft-open"]')?.click());
    expect(openDraft).toHaveBeenCalledWith("d1");
    expect(second!.textContent).toContain("已发布到需求");
    expect(second!.textContent).toContain("再发布…");
    await act(async () => root?.unmount());
    document.body.innerHTML = "";
    await render(<SharedDraftCard draft={summary()} />);
    expect(q("shared-draft-open")).toBeNull();
  });

  it("发布对话框：改了交接包先保存（带打开时的版本）再发（带预览时的版本）；疑似密钥列出字段与片段，按钮写「仍然发布」；列表框逐字输入不吃空格回车", async () => {
    const hit = { field: "risks[0]", kind: "github-token", excerpt: "ghp_…6789" };
    apiMocks.getSharedDraft.mockResolvedValue(draft({ secretHits: [hit], updatedAt: 5 }));
    apiMocks.updateSharedDraft.mockImplementation(async (_id: string, body: { title: string; content: unknown }) => draft({ title: body.title, content: body.content as never, secretHits: [hit], updatedAt: 6 }));
    apiMocks.publishSharedDraft.mockResolvedValue(draft({ status: "published" }));
    const onClose = vi.fn();
    await render(<SharedDraftDialog draftId="d1" onClose={onClose} />);
    expect(q("shared-draft-secrets")?.textContent).toContain("risks[0] · github-token · ghp_…6789");
    expect(q("shared-draft-publish")?.textContent).toContain("仍然发布");
    await type(q("shared-draft-summary")!, "导出做完了");
    // 逐字输入：行尾空格与回车留在框里，保存时再拆行。
    for (const value of ["补", "补测试 ", "补测试 \n", "补测试 \n\n 加分页 "]) await type(q("shared-draft-todo")!, value);
    expect((q("shared-draft-todo") as HTMLTextAreaElement).value).toBe("补测试 \n\n 加分页 ");
    await act(async () => q("shared-draft-publish")?.click());
    await settle();
    expect(apiMocks.updateSharedDraft).toHaveBeenCalledWith("d1", {
      title: "交接：订单导出",
      content: { summary: "导出做完了", decisions: ["按月分页"], todo: ["补测试", "加分页"], risks: [], branch: null, files: [] },
      expectedUpdatedAt: 5,
    });
    expect(apiMocks.publishSharedDraft).toHaveBeenCalledWith("d1", 6);
    expect(onClose).toHaveBeenCalled();
  });

  it("保存后出现没看过的疑似密钥（哪怕总数没变）：停下给人看，不直接发", async () => {
    apiMocks.getSharedDraft.mockResolvedValue(draft({ secretHits: [{ field: "risks[0]", kind: "github-token", excerpt: "ghp_…6789" }] }));
    apiMocks.updateSharedDraft.mockResolvedValue(draft({ secretHits: [{ field: "summary", kind: "openai-key", excerpt: "sk-p…3456" }], updatedAt: 2 }));
    await render(<SharedDraftDialog draftId="d1" onClose={() => undefined} />);
    await type(q("shared-draft-summary")!, "换了一段 sk-proj-xxxxxxxxxxxxxxxxxxxx3456");
    await act(async () => q("shared-draft-publish")?.click());
    await settle();
    expect(apiMocks.publishSharedDraft).not.toHaveBeenCalled();
    expect(q("shared-draft-secrets")?.textContent).toContain("summary · openai-key");
  });

  it("预览之后草稿变了（409）：没发出去，载入最新的请人再看", async () => {
    apiMocks.getSharedDraft.mockResolvedValueOnce(draft({ updatedAt: 1 })).mockResolvedValueOnce(draft({ updatedAt: 2, content: { summary: "Agent 新交的一版", decisions: [], todo: [], risks: [], branch: null, files: [] } }));
    apiMocks.publishSharedDraft.mockRejectedValue(new ApiClientError(409, "VERSION_CONFLICT", "changed"));
    const onClose = vi.fn();
    await render(<SharedDraftDialog draftId="d1" onClose={onClose} />);
    await act(async () => q("shared-draft-publish")?.click());
    await settle();
    expect(apiMocks.publishSharedDraft).toHaveBeenCalledWith("d1", 1);
    expect(onClose).not.toHaveBeenCalled();
    expect((q("shared-draft-summary") as HTMLTextAreaElement).value).toBe("Agent 新交的一版");
  });

  it("快照预览即所发：命令也显示", async () => {
    apiMocks.getSharedDraft.mockResolvedValue(
      draft({ kind: "snapshot", content: { rounds: [{ userText: "做导出", answer: "好了", files: ["src/a.ts"], commands: [{ command: "pnpm test --filter x", exitCode: 0 }], startedAt: 1 }] } }),
    );
    await render(<SharedDraftDialog draftId="d1" onClose={() => undefined} />);
    expect(q("shared-draft-preview")?.textContent).toContain("$ pnpm test --filter x (0)");
  });

  it("已发布的再打开：说明会新增一份，按钮「再发布一份」，不给丢弃", async () => {
    apiMocks.getSharedDraft.mockResolvedValue(draft({ status: "published", publishedItemId: "item-1" }));
    await render(<SharedDraftDialog draftId="d1" onClose={() => undefined} />);
    expect(q("shared-draft-dialog")?.textContent).toContain("再发布会在需求上新增一份");
    expect(q("shared-draft-publish")?.textContent).toContain("再发布一份");
    expect(q("shared-draft-discard")).toBeNull();
  });

  it("评审卡：提交了意见的评审在需求会话里可以「发布到需求」（生成评审报告草稿并打开）", async () => {
    apiMocks.createReviewDraft.mockResolvedValue(draft({ id: "d9", kind: "review" }));
    const openDraft = vi.fn();
    const review = {
      id: "r1",
      targetSessionId: "s1",
      reviewerSessionId: "s2",
      reviewerDeleted: false,
      agentId: "codex",
      agentName: "Codex",
      origin: "user",
      focus: ["correctness"],
      note: null,
      status: "submitted",
      findings: [],
      summary: "没问题",
      finalMessage: null,
      appliedFindingIds: [],
      error: null,
      createdAt: 1,
      updatedAt: 1,
      finishedAt: 2,
    } as unknown as ReviewDto;
    await render(
      <ShareContext.Provider value={{ canPublish: true, openDraft }}>
        <ReviewCard review={review} />
      </ShareContext.Provider>,
    );
    await act(async () => q("review-publish")?.click());
    await settle();
    expect(apiMocks.createReviewDraft).toHaveBeenCalledWith("r1");
    expect(openDraft).toHaveBeenCalledWith("d9");
  });
});

describe("需求的 AI 协作区", () => {
  const item = (patch: Partial<SharedItemDto>): SharedItemDto => ({
    id: "i1",
    requirementId: "req-1",
    kind: "handoff",
    title: "交接：导出",
    source: { agentId: "codex", sessionRef: null },
    publishedBy: { id: "u1", displayName: "李娜" },
    publishedAt: "2026-10-09T01:00:00.000Z",
    sizeBytes: 100,
    retractedAt: null,
    retractedBy: null,
    readCount: 2,
    ...patch,
  });

  it("列出共享对象（来源成员与 Agent、读过人数、谁撤回的）与协作记录；撤回前说明已读过的收不回", async () => {
    apiMocks.listLocalAgents.mockResolvedValue({ defaultAgentId: "codex", agents: [{ id: "codex", displayName: "Codex" }, { id: "claude-code", displayName: "Claude Code" }] });
    apiMocks.listSharedItems.mockResolvedValue({
      items: [item({}), item({ id: "i2", kind: "review", title: "评审报告", retractedAt: "2026-10-09T02:00:00.000Z", retractedBy: { id: "u2", displayName: "陈思远" }, readCount: 0 })],
    });
    apiMocks.listAiActivity.mockResolvedValue({
      items: [{ id: "a1", requirementId: "req-1", member: { id: "u1", displayName: "李娜" }, agentId: "claude-code", kind: "trial", status: "adopted", branch: "suduo/REQ-1-codex", occurredAt: "2026-10-09T01:00:00.000Z", createdAt: "x", updatedAt: "x" }],
    });
    apiMocks.retractSharedItem.mockResolvedValue({ readCount: 3 });
    await render(<AiCollabSection requirementId="req-1" />);
    const rows = all("shared-item");
    expect(rows[0]!.textContent).toContain("李娜 发布 · Codex");
    expect(rows[0]!.textContent).toContain("2 人读过");
    expect(rows[1]!.textContent).toContain("已由 陈思远 撤回");
    expect(rows[1]!.querySelector('[data-testid="shared-item-retract"]')).toBeNull();
    expect(q("ai-activity")?.textContent).toContain("李娜 · Claude Code · 并行试做 · 已采用 · suduo/REQ-1-codex");
    await act(async () => rows[0]!.querySelector<HTMLElement>('[data-testid="shared-item-retract"]')?.click());
    expect(document.body.textContent).toContain("已有 2 人读过，读过的内容收不回");
    const confirm = [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "撤回");
    await act(async () => confirm?.click());
    await settle();
    expect(apiMocks.retractSharedItem).toHaveBeenCalledWith("i1");
  });
});

describe("项目 AI 规范", () => {
  it("带着开始编辑时的版本保存（只检测）；这期间有人存过时说明是哪几版", async () => {
    apiMocks.getProjectAiRules.mockResolvedValue({ projectId: "p1", version: 1, content: "- 先写测试", updatedBy: { id: "u1", displayName: "李娜" }, updatedAt: "2026-10-09T01:00:00.000Z" });
    apiMocks.listProjectAiRulesVersions.mockResolvedValue({ items: [] });
    apiMocks.saveProjectAiRules.mockResolvedValue({
      projectId: "p1",
      version: 3,
      content: "- 先写测试\n- 不改接口",
      updatedBy: { id: "u2", displayName: "我" },
      updatedAt: "2026-10-09T02:00:00.000Z",
      skippedVersions: [{ version: 2, updatedBy: { id: "u3", displayName: "陈思远" }, updatedAt: "x", sizeBytes: 1 }],
    });
    await render(<ProjectAiRulesSetting projectId="p1" />);
    expect(q("project-ai-rules-version")?.textContent).toContain("v1 · 李娜");
    expect((q("project-ai-rules-content") as HTMLTextAreaElement).value).toBe("- 先写测试");
    expect(q("project-ai-rules-save")?.hasAttribute("disabled")).toBe(true);
    await type(q("project-ai-rules-content")!, "- 先写测试\n- 不改接口");
    await act(async () => q("project-ai-rules-save")?.click());
    await settle();
    expect(apiMocks.saveProjectAiRules).toHaveBeenCalledWith("p1", "- 先写测试\n- 不改接口", 1);
  });
});

describe("项目 AI 规范的新版本提示", () => {
  it("会话用的版本比项目当前的旧、或开工时还没有：提示；先看内容再发（发的是看过的那一版）；一样新或没有规范：不提示", async () => {
    const onApply = vi.fn(async () => undefined);
    await render(<RulesNotice status={{ used: 2, current: { version: 3, content: "- 先写测试", updatedBy: "李娜", updatedAt: null } }} onApply={onApply} />);
    expect(q("rules-notice")?.textContent).toContain("项目 AI 规范有新版本 v3（这个会话用的是 v2）");
    expect(q("rules-apply")).toBeNull();
    await act(async () => q("rules-view")?.click());
    expect(q("rules-content")?.textContent).toBe("- 先写测试");
    expect(q("rules-dialog")?.textContent).toContain("李娜 保存");
    expect(onApply).not.toHaveBeenCalled();
    await act(async () => q("rules-apply")?.click());
    expect(onApply).toHaveBeenCalledWith(3);
    await act(async () => root?.unmount());
    document.body.innerHTML = "";
    await render(<RulesNotice status={{ used: null, current: { version: 1, content: "x", updatedBy: null, updatedAt: null } }} onApply={onApply} />);
    expect(q("rules-notice")?.textContent).toContain("这个会话开工时还没有");
    await act(async () => root?.unmount());
    document.body.innerHTML = "";
    await render(
      <>
        <RulesNotice status={{ used: 3, current: { version: 3, content: "x", updatedBy: null, updatedAt: null } }} onApply={onApply} />
        <RulesNotice status={{ used: null, current: null }} onApply={onApply} />
      </>,
    );
    expect(q("rules-notice")).toBeNull();
  });
});
