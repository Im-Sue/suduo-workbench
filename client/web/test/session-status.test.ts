import { describe, expect, it } from "vitest";
import type { SessionDto, SessionRunStatusDto } from "@suduo/client-contracts";
import { sessionUiStatus } from "../src/ui/session-status.js";

function session(state: SessionDto["state"] = "active"): SessionDto {
  return {
    id: "s-1",
    projectId: "p-1",
    title: "会话",
    state,
    approvalMode: "ask",
    createdAt: 1,
    updatedAt: 1,
    lastActivityAt: null,
    version: 1,
    threads: [],
  };
}

function summary(
  partial: Partial<SessionRunStatusDto>,
): SessionRunStatusDto {
  return {
    sessionId: "s-1",
    running: false,
    pendingApprovals: 0,
    lastTurnOutcome: null,
    lastActivityAt: null,
    ...partial,
  };
}

describe("W2 会话运行态推导（实时值 + 摘要兜底）", () => {
  it("优先级：error 态 > 待审批 > 运行中 > 终态", () => {
    expect(sessionUiStatus(session("error"), 1, 1)).toBe("error");
    expect(sessionUiStatus(session(), 1, 1)).toBe("approval");
    expect(sessionUiStatus(session(), 1, 0)).toBe("running");
    expect(sessionUiStatus(session(), 0, 0)).toBe("idle");
  });

  it("非选中会话由摘要兜底：待审批/运行中/终态", () => {
    expect(
      sessionUiStatus(session(), 0, 0, summary({ pendingApprovals: 2 })),
    ).toBe("approval");
    expect(sessionUiStatus(session(), 0, 0, summary({ running: true }))).toBe(
      "running",
    );
    expect(
      sessionUiStatus(session(), 0, 0, summary({ lastTurnOutcome: "completed" })),
    ).toBe("completed");
    expect(
      sessionUiStatus(session(), 0, 0, summary({ lastTurnOutcome: "failed" })),
    ).toBe("error");
    expect(
      sessionUiStatus(
        session(),
        0,
        0,
        summary({ lastTurnOutcome: "interrupted" }),
      ),
    ).toBe("idle");
  });

  it("实时值与摘要并存时实时值不被摘要降级", () => {
    expect(
      sessionUiStatus(session(), 1, 0, summary({ lastTurnOutcome: "completed" })),
    ).toBe("running");
  });
});
