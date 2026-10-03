import type {
  SessionListItemDto,
  RequirementListItemDto,
  WorkbenchActionDto,
  WorkbenchRequirementDto,
} from "@suduo/client-contracts";
import { describe, expect, it } from "vitest";
import { attentionItems, groupByStatus, mergeMyRequirements, recentChanges, sessionsToShow } from "../src/features/my-work/model.js";

const working = (id: string, patch: Partial<WorkbenchRequirementDto> = {}): WorkbenchRequirementDto => ({
  requirementId: id,
  remoteProjectId: "p1",
  title: `需求 ${id}`,
  projectName: "订单中心",
  status: "in_development",
  availability: "available",
  sessionIds: ["s1"],
  sessionCount: 1,
  running: false,
  pendingApprovals: 0,
  lastActivityAt: 1_000,
  drift: false,
  snapshotStatus: "available",
  ...patch,
});

const assigned = (id: string, patch: Partial<RequirementListItemDto> = {}) =>
  ({
    id,
    projectId: "p1",
    number: 7,
    title: `指派 ${id}`,
    summary: "",
    status: "ready_for_development",
    assignee: { id: "me", displayName: "我" },
    commentCount: 0,
    attachmentCount: 0,
    localSessionCount: 0,
    createdBy: { id: "me", displayName: "我" },
    updatedBy: { id: "lin", displayName: "林雨" },
    createdAt: "2026-09-28T00:00:00.000Z",
    updatedAt: "2026-09-29T08:00:00.000Z",
    version: 1,
    projectName: "订单中心",
    ...patch,
  }) as RequirementListItemDto & { projectName: string | null };

describe("我的工作 · 需要你处理", () => {
  it("按紧急程度：等你确认 > 上一轮失败 > 开工后需求有变化 > 代码目录失效", () => {
    const actions: WorkbenchActionDto[] = [
      { kind: "invalid_mapping", remoteProjectId: "p2", localProjectId: null, projectName: "支付", message: "目录不存在" },
      { kind: "failed_turn", sessionId: "s2", sessionTitle: "失败的", localProjectId: "l1", projectName: "订单", lastActivityAt: 5 },
      { kind: "pending_approval", sessionId: "s1", sessionTitle: "等确认", localProjectId: "l1", projectName: "订单", pendingApprovals: 2, lastActivityAt: 1 },
    ];
    const items = attentionItems(actions, [working("r1", { drift: true }), working("r2")]);
    expect(items.map((item) => item.kind)).toEqual(["pending_approval", "failed_turn", "drift", "invalid_mapping"]);
  });

  it("我负责的需求有新评论、按节奏停滞较久也要处理；顺序：确认 > 失败 > 新评论 > 需求变化 > 停滞 > 目录失效", () => {
    const now = Date.parse("2026-09-29T08:00:00.000Z");
    const mine = mergeMyRequirements(
      [
        assigned("r-comments", { unreadCommentCount: 2 }),
        assigned("r-stale", { status: "in_development", updatedAt: "2026-09-20T08:00:00.000Z" }),
        assigned("r-fresh", { status: "in_development", updatedAt: "2026-09-28T08:00:00.000Z" }),
      ],
      [],
    );
    const actions: WorkbenchActionDto[] = [
      { kind: "invalid_mapping", remoteProjectId: "p2", localProjectId: null, projectName: "支付", message: "目录不存在" },
      { kind: "pending_approval", sessionId: "s1", sessionTitle: "等确认", localProjectId: "l1", projectName: "订单", pendingApprovals: 1, lastActivityAt: 1 },
    ];
    const items = attentionItems(actions, [working("r1", { drift: true })], mine, now);
    expect(items.map((item) => item.kind)).toEqual(["pending_approval", "new_comments", "drift", "stale", "invalid_mapping"]);
    const stale = items.find((item) => item.kind === "stale");
    expect(stale?.kind === "stale" ? [stale.requirement.id, stale.days] : null).toEqual(["r-stale", 9]);
  });

  it("区块不可用时不报错，按空处理", () => {
    expect(attentionItems(null, null)).toEqual([]);
  });
});

describe("我的工作 · 我的需求", () => {
  it("我提的、还没人负责的也列进来：已完成的不算，和我负责的重复只算一次", () => {
    const merged = mergeMyRequirements(
      [assigned("r1")],
      [],
      [assigned("r1", { assignee: null }), assigned("r2", { assignee: null }), assigned("r3", { assignee: null, status: "completed" })],
    );
    expect(merged.map((item) => [item.id, item.assignedToMe, item.createdUnassigned])).toEqual([
      ["r1", true, false],
      ["r2", false, true],
    ]);
  });

  it("我负责的与我在做的合并去重，并按流程顺序分组", () => {
    const merged = mergeMyRequirements([assigned("r1"), assigned("r3", { status: "completed" })], [working("r1"), working("r2")]);
    expect(merged.map((item) => [item.id, item.assignedToMe, item.working !== null])).toEqual([
      ["r1", true, true],
      ["r3", true, false],
      ["r2", false, true],
    ]);
    expect(groupByStatus(merged).map((group) => group.status)).toEqual(["ready_for_development", "in_development", "completed"]);
  });

  it("最近动态只列别人改的，最新在前", () => {
    const merged = mergeMyRequirements(
      [assigned("r1"), assigned("r2", { updatedBy: { id: "me", displayName: "我" } }), assigned("r3", { updatedAt: "2026-09-29T09:00:00.000Z" })],
      [],
    );
    expect(recentChanges(merged, "me").map((item) => item.id)).toEqual(["r3", "r1"]);
  });
});

describe("我的工作 · 会话", () => {
  const session = (id: string, patch: Partial<SessionListItemDto>): SessionListItemDto =>
    ({
      id,
      projectId: "l1",
      title: id,
      state: "active",
      purpose: "general",
      createdAt: 0,
      updatedAt: 0,
      lastActivityAt: 0,
      project: { id: "l1", name: "订单", rootPath: "/code/order", state: "active", remoteProjectId: null },
      requirement: null,
      preview: null,
      runStatus: { running: false, pendingApprovals: 0, lastTurnOutcome: null },
      ...patch,
    }) as SessionListItemDto;

  it("运行中 / 等你确认 / 上一轮失败的在前，其余按最近活动补齐", () => {
    const shown = sessionsToShow(
      [
        session("idle-new", { lastActivityAt: 9 }),
        session("running", { runStatus: { running: true, pendingApprovals: 0, lastTurnOutcome: null }, lastActivityAt: 1 }),
        session("failed", { runStatus: { running: false, pendingApprovals: 0, lastTurnOutcome: "failed" }, lastActivityAt: 3 }),
        session("idle-old", { lastActivityAt: 2 }),
      ],
      3,
    );
    expect(shown.map((row) => [row.session.id, row.status])).toEqual([
      ["failed", "error"],
      ["running", "running"],
      ["idle-new", "idle"],
    ]);
  });

  it("进行中的超过上限时不截断", () => {
    const busy = Array.from({ length: 4 }, (_, index) =>
      session(`busy-${index}`, { runStatus: { running: true, pendingApprovals: 0, lastTurnOutcome: null }, lastActivityAt: index }),
    );
    expect(sessionsToShow([...busy, session("idle", { lastActivityAt: 99 })], 2)).toHaveLength(4);
  });
});
