import { describe, expect, it } from "vitest";
import { AUDIT_ACTIONS, type AuditAction, type AuditEntryDto } from "@suduo/cloud-contracts";
import { presentAudit, statusTransitionOf } from "../src/features/overview/timeline.js";

/**
 * fixture 只接受**契约里真实存在的 `AuditAction`**。
 *
 * 上一版这里是 `action: string` + `as` 断言，喂的是 `"create"`、`"status_change"`
 * 这类契约上不存在的值——测试全绿，线上却 100% 落进未知回落分支，审计区把
 * `requirement.created` 原样显示给了用户。把参数类型收紧到 `AuditAction`
 * 是这条 bug 的真正防线：**再写错就编译不过**。
 */
function audit(
  action: AuditAction,
  resourceType: AuditEntryDto["resourceType"] = "requirement",
): AuditEntryDto {
  return {
    id: "a1",
    actor: { id: "u1", loginName: "sue", displayName: "Sue" },
    resourceType,
    resourceId: "r1",
    action,
    before: null,
    after: null,
    createdAt: "2026-08-17T00:00:00.000Z",
  };
}

describe("审计语义化", () => {
  it("按 action 归色调", () => {
    expect(presentAudit(audit("requirement.created")).tone).toBe("created");
    expect(presentAudit(audit("attachment.deleted", "attachment")).tone).toBe("deleted");
    expect(presentAudit(audit("requirement.updated")).tone).toBe("updated");
    expect(presentAudit(audit("requirement.status_changed")).tone).toBe("updated");
    expect(presentAudit(audit("project.archived", "project")).tone).toBe("updated");
    expect(presentAudit(audit("project.restored", "project")).tone).toBe("created");
  });

  it("契约里每个 action 都有整句文案，不得回落", () => {
    for (const action of AUDIT_ACTIONS) {
      const resourceType = action.split(".")[0] as AuditEntryDto["resourceType"];
      const presented = presentAudit(audit(action, resourceType));
      expect(presented.text).not.toContain(action);
      expect(presented.text).not.toContain(".");
    }
  });

  it("给出可直接接在人名后的整句", () => {
    expect(presentAudit(audit("requirement.created")).text).toBe("创建了需求");
    expect(presentAudit(audit("requirement.status_changed")).text).toBe("变更了需求状态");
    expect(presentAudit(audit("attachment.downloaded", "attachment")).text).toBe("下载了附件");
    expect(presentAudit(audit("artifact_version.published", "artifact_version")).text)
      .toBe("发布了产物版本");
  });

  it("未知取值回落原文而不是丢弃——审计不能因前端不认识就少显示", () => {
    const unknown = {
      ...audit("requirement.created"),
      resourceType: "widget" as AuditEntryDto["resourceType"],
      action: "widget.frobnicated" as AuditAction,
    };
    const presented = presentAudit(unknown);
    expect(presented.tone).toBe("neutral");
    expect(presented.text).toContain("widget.frobnicated");
  });
});

describe("状态流转文案", () => {
  it("写明前后状态，取不到时兜底，非状态变更不给", () => {
    expect(statusTransitionOf({ ...audit("requirement.status_changed"), before: { status: "draft" }, after: { status: "in_development" } }))
      .toBe("草稿 → 开发中");
    expect(statusTransitionOf({ ...audit("requirement.status_changed"), before: null, after: { status: "bogus" } })).toBe("状态已变更");
    expect(statusTransitionOf(audit("requirement.updated"))).toBeNull();
  });
});
