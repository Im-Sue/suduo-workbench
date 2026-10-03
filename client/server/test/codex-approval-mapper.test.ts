import { describe, expect, it } from "vitest";
import { mapApprovalDecision } from "../src/infrastructure/runtime/codex/codex-approval-mapper.js";

describe("审批回包（按 Codex 协议形状）", () => {
  it("v2 命令 / 文件改动：原样回 decision", () => {
    expect(mapApprovalDecision("item/commandExecution/requestApproval", "accept")).toEqual({ decision: "accept" });
    expect(mapApprovalDecision("item/fileChange/requestApproval", "decline")).toEqual({ decision: "decline" });
  });

  it("旧式审批：四种决定都对上 ReviewDecision（拒绝是 { denied: { rejection } }，不再是字符串 denied）", () => {
    expect(mapApprovalDecision("execCommandApproval", "accept")).toEqual({ decision: "approved" });
    expect(mapApprovalDecision("execCommandApproval", "acceptForSession")).toEqual({ decision: "approved_for_session" });
    expect(mapApprovalDecision("applyPatchApproval", "cancel")).toEqual({ decision: "abort" });
    const declined = mapApprovalDecision("applyPatchApproval", "decline") as { decision: { denied: { rejection: string } } };
    expect(typeof declined.decision.denied.rejection).toBe("string");
  });

  it("权限：批准只授予这一回合，「本会话都允许」授予整个会话，拒绝 / 中断什么都不授予", () => {
    const requested = { fileSystem: { entries: [{ access: "write", path: { type: "path", path: "/work/out" } }] }, network: null };
    expect(mapApprovalDecision("item/permissions/requestApproval", "accept", requested)).toEqual({ permissions: requested, scope: "turn" });
    expect(mapApprovalDecision("item/permissions/requestApproval", "acceptForSession", requested)).toEqual({
      permissions: requested,
      scope: "session",
    });
    for (const decision of ["decline", "cancel"] as const) {
      expect(mapApprovalDecision("item/permissions/requestApproval", decision, requested)).toEqual({ permissions: {}, scope: "turn" });
    }
    // 请求里的权限形状不对时不透传。
    expect(mapApprovalDecision("item/permissions/requestApproval", "accept", "default")).toEqual({ permissions: {}, scope: "turn" });
  });
});
