import { describe, expect, it } from "vitest";
import type { SessionDto, SessionRunStatusDto } from "@suduo/client-contracts";
import { sessionRowStatus } from "../src/ui/session-status.js";

function session(id = "s1"): SessionDto {
  return {
    id, projectId: "p1", title: "会话", state: "active", purpose: "general", approvalMode: "ask",
    createdAt: 1, updatedAt: 1, lastActivityAt: null, version: 1, threads: [],
  };
}

function summary(overrides: Partial<SessionRunStatusDto>): SessionRunStatusDto {
  return { sessionId: "s1", running: false, pendingApprovals: 0, lastTurnOutcome: null, lastActivityAt: null, ...overrides };
}

describe("sessionRowStatus · 侧栏选中行只吃实时值（PR4）", () => {
  it("回合结束后：实时「已完成」不被旧轮询摘要的 running:true 盖回「运行中」", () => {
    const stale = summary({ running: true });
    const live = { sessionId: "s1", running: 0, pendingApprovals: 0, lastTurnOutcome: "completed" as const };
    expect(sessionRowStatus(session(), live, stale)).toBe("completed");
    // 实时空闲同理
    expect(sessionRowStatus(session(), { ...live, lastTurnOutcome: null }, stale)).toBe("idle");
  });

  it("实时运行 / 审批 / 异常按实时值判定", () => {
    expect(sessionRowStatus(session(), { sessionId: "s1", running: 1, pendingApprovals: 0, lastTurnOutcome: null }, undefined)).toBe("running");
    expect(sessionRowStatus(session(), { sessionId: "s1", running: 1, pendingApprovals: 1, lastTurnOutcome: null }, undefined)).toBe("approval");
    expect(sessionRowStatus(session(), { sessionId: "s1", running: 0, pendingApprovals: 0, lastTurnOutcome: "failed" }, undefined)).toBe("error");
  });

  it("非选中会话（无实时值）与实时值属别的会话时，仍走轮询摘要", () => {
    expect(sessionRowStatus(session("s2"), undefined, summary({ sessionId: "s2", running: true }))).toBe("running");
    const otherLive = { sessionId: "s1", running: 0, pendingApprovals: 0, lastTurnOutcome: "completed" as const };
    expect(sessionRowStatus(session("s2"), otherLive, summary({ sessionId: "s2", running: true }))).toBe("running");
    expect(sessionRowStatus(session("s2"), otherLive, undefined)).toBe("idle");
  });
});
