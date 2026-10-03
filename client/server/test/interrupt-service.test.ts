import { describe, expect, it } from "vitest";
import type {
  AgentRuntime,
  ApproveResult,
  RuntimeEventDraft,
  StartThreadResult,
  StartTurnInput,
  StartTurnResult,
} from "@suduo/client-contracts";
import { IndeterminateOperationError } from "../src/application/api-error.js";
import { isTurnGoneError } from "../src/application/interrupt-service.js";
import { createMinimalHttpContext, createProjectAndSession, postJson } from "./helpers/minimal-http-context.js";

/**
 * PR3 InterruptService（技术设计 §三-4）：
 * - 不覆盖已有终态：对已自然完成的回合发中断，账本里不能出现第二个终态；
 * - F5 / F6 两种 -32600 按「目标已非活跃」幂等处理，不抛 IndeterminateOperationError。
 */
describe("InterruptService · 终态守卫与幂等", () => {
  it("已自然完成的回合再被中断：codex 报 no active turn，账本里仍只有一条 completed 终态", async () => {
    const runtime = new ThrowingRuntime(new Error("no active turn to interrupt"));
    const context = createMinimalHttpContext(runtime);
    try {
      const base = await context.listen();
      const { sessionId } = await createProjectAndSession(base, context.projectRoot);
      const threadRef = { runtimeId: runtime.runtimeId, runtimeKind: "codex", threadId: "thread-1" };
      const turnRef = { threadId: "thread-1", turnId: "turn-1" };
      context.ledger.append({ sessionId, sessionThreadId: null, event: { source: "runtime:codex-local", type: "turn.started", payload: {}, threadRef, turnRef, ts: Date.now(), dedupeKey: "s1" } });
      context.ledger.append({ sessionId, sessionThreadId: null, event: { source: "runtime:codex-local", type: "turn.completed", payload: { turn: { id: "turn-1", status: "completed" } }, threadRef, turnRef, ts: Date.now(), dedupeKey: "c1" } });

      const accepted = await context.interrupts.interrupt(sessionId, { turnId: "turn-1" });
      expect(accepted.turnId).toBe("turn-1");
      expect(runtime.interrupts).toHaveLength(1);

      const terminals = context.events
        .listBackfill(sessionId, 0, 1_000_000, 500)
        .filter((event) => event.turnRef?.turnId === "turn-1" && /^turn\.(completed|interrupted|start-failed)$/.test(event.type));
      expect(terminals.map((event) => event.type)).toEqual(["turn.completed"]);
      expect(context.events.hasTurnTerminal(sessionId, "turn-1")).toBe(true);
      expect(context.events.hasTurnTerminal(sessionId, "turn-2")).toBe(false);
    } finally {
      await context.close();
    }
  });

  it("账本尚无终态时 codex 报 turn 已不在：补写 turn.interrupted 收口（既有行为保留）", async () => {
    const runtime = new ThrowingRuntime(new Error("turn not found"));
    const context = createMinimalHttpContext(runtime);
    try {
      const base = await context.listen();
      const { sessionId } = await createProjectAndSession(base, context.projectRoot);
      const threadRef = { runtimeId: runtime.runtimeId, runtimeKind: "codex", threadId: "thread-1" };
      const turnRef = { threadId: "thread-1", turnId: "turn-9" };
      context.ledger.append({ sessionId, sessionThreadId: null, event: { source: "runtime:codex-local", type: "turn.started", payload: {}, threadRef, turnRef, ts: Date.now(), dedupeKey: "s9" } });
      await context.interrupts.interrupt(sessionId, { turnId: "turn-9" });
      const terminals = context.events
        .listBackfill(sessionId, 0, 1_000_000, 500)
        .filter((event) => event.turnRef?.turnId === "turn-9" && event.type.startsWith("turn.") && event.type !== "turn.started");
      expect(terminals.map((event) => event.type)).toEqual(["turn.interrupted"]);
    } finally {
      await context.close();
    }
  });

  it("F5 失配（expected active turn id X but found Y）与 F6（no active turn）经 HTTP 都是 202，不抛不确定错误", async () => {
    for (const message of [
      "expected active turn id 01a00000-aaaa but found 01a070bd-c745",
      "no active turn to interrupt",
    ]) {
      const runtime = new ThrowingRuntime(new Error(message));
      const context = createMinimalHttpContext(runtime);
      try {
        const base = await context.listen();
        const { sessionId } = await createProjectAndSession(base, context.projectRoot);
        const response = await postJson(base, `/api/v1/sessions/${sessionId}/interrupt`, `interrupt-${message.length}`, { turnId: "turn-x" });
        expect(response.status).toBe(202);
      } finally {
        await context.close();
      }
    }
  });

  it("真实故障仍抛 IndeterminateOperationError：超时、以及缺少 but found 段的相近文案", async () => {
    for (const message of ["turn interrupt timed out", "expected active turn id 01a00000 (state unknown)"]) {
      const runtime = new ThrowingRuntime(new Error(message));
      const context = createMinimalHttpContext(runtime);
      try {
        const base = await context.listen();
        const { sessionId } = await createProjectAndSession(base, context.projectRoot);
        await expect(context.interrupts.interrupt(sessionId, { turnId: "turn-x" })).rejects.toBeInstanceOf(IndeterminateOperationError);
      } finally {
        await context.close();
      }
    }
    expect(isTurnGoneError(new Error("expected active turn id a but found b"))).toBe(true);
    expect(isTurnGoneError(new Error("expected active turn id a"))).toBe(false);
  });
});

class ThrowingRuntime implements AgentRuntime {
  readonly runtimeId = "codex-local";
  readonly runtimeKind = "codex";
  readonly interrupts: unknown[] = [];
  constructor(private readonly failure: Error) {}
  async startThread(): Promise<StartThreadResult> {
    const thread = { threadRef: { runtimeId: this.runtimeId, runtimeKind: this.runtimeKind, threadId: "thread-1" }, role: "primary" as const, metadata: {} };
    return { primaryThread: thread, threads: [thread] };
  }
  async startTurn(input: StartTurnInput): Promise<StartTurnResult> {
    return { turnRef: { threadId: input.threadRef.threadId, turnId: "turn-1" }, acceptedAt: Date.now() };
  }
  async approve(): Promise<ApproveResult> {
    return { acknowledged: true };
  }
  async interrupt(input: unknown): Promise<void> {
    this.interrupts.push(input);
    throw this.failure;
  }
  async *subscribe(): AsyncIterable<RuntimeEventDraft> {
    yield* [];
  }
}
