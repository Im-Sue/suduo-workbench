import { describe, expect, it } from "vitest";
import { AUDIT_ACTIONS, type AuditAction, type AuditEntryDto } from "@suduo/cloud-contracts";
import { groupOverviewAudit, presentAudit } from "../src/features/overview/timeline.js";

const actor = { id: "u1", displayName: "张三" };

function entry(
  id: string,
  action: AuditAction,
  createdAt: string,
  actorId = actor.id,
): AuditEntryDto {
  return {
    id,
    actor: { id: actorId, displayName: actorId === actor.id ? actor.displayName : "李四" },
    resourceType: action.startsWith("project") ? "project" : action.startsWith("requirement")
      ? "requirement" : action.startsWith("comment") ? "comment" : action.startsWith("attachment")
        ? "attachment" : "artifact_version",
    resourceId: `r-${id}`,
    action,
    before: action === "requirement.status_changed" ? { status: "draft" } : null,
    after: action === "requirement.status_changed" ? { status: "in_development" } : null,
    createdAt,
  };
}

describe("概览时间线归约", () => {
  it("同人同 action 相邻 14 分钟合并，组时间取最早记录", () => {
    const grouped = groupOverviewAudit([
      entry("new", "requirement.updated", "2026-08-25T10:14:00.000Z"),
      entry("old", "requirement.updated", "2026-08-25T10:00:00.000Z"),
    ]);

    expect(grouped).toHaveLength(1);
    expect(grouped[0]).toMatchObject({ createdAt: "2026-08-25T10:00:00.000Z" });
    expect(grouped[0]?.entries.map((item) => item.id)).toEqual(["new", "old"]);
  });

  it("相邻 16 分钟断开，且合并后条目数守恒", () => {
    const source = [
      entry("new", "requirement.updated", "2026-08-25T10:16:00.000Z"),
      entry("old", "requirement.updated", "2026-08-25T10:00:00.000Z"),
      entry("comment", "comment.created", "2026-08-25T09:59:00.000Z"),
    ];
    const grouped = groupOverviewAudit(source);

    expect(grouped).toHaveLength(3);
    expect(grouped.flatMap((group) => group.entries)).toEqual(source);
  });

  it("状态变更永不合并，即使同一人同一 action 且只相隔一分钟", () => {
    const grouped = groupOverviewAudit([
      entry("new", "requirement.status_changed", "2026-08-25T10:01:00.000Z"),
      entry("old", "requirement.status_changed", "2026-08-25T10:00:00.000Z"),
    ]);

    expect(grouped).toHaveLength(2);
    expect(grouped.flatMap((group) => group.entries)).toHaveLength(2);
  });

  it("契约内 12 种 action 均有非空呈现文案", () => {
    for (const action of AUDIT_ACTIONS) {
      expect(presentAudit(entry(action, action, "2026-08-25T10:00:00.000Z")).text).not.toBe("");
    }
  });
});
