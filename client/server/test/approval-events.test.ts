import { describe, expect, it } from "vitest";
import type {
  AgentRuntime,
  ApproveInput,
  ApproveResult,
  EventEnvelope,
  JsonValue,
  RuntimeEventDraft,
  StartThreadResult,
  StartTurnResult,
} from "@suduo/client-contracts";
import { ApprovalService } from "../src/application/approval-service.js";
import { EventLedger } from "../src/application/event-ledger.js";
import { RuntimeEventIngestor } from "../src/application/runtime-event-ingestor.js";
import { openBetterSqlite3Database } from "../src/infrastructure/db/better-sqlite3-database.js";
import { runMigrations } from "../src/infrastructure/db/migration-runner.js";
import { ApprovalRepository } from "../src/infrastructure/db/repositories/approval-repository.js";
import { EventRepository } from "../src/infrastructure/db/repositories/event-repository.js";
import { ProjectRepository } from "../src/infrastructure/db/repositories/project-repository.js";
import { SessionRepository } from "../src/infrastructure/db/repositories/session-repository.js";
import { SessionThreadRepository } from "../src/infrastructure/db/repositories/session-thread-repository.js";
import { RuntimeRegistry } from "../src/infrastructure/runtime/runtime-registry.js";

const THREAD_REF = { runtimeId: "codex-local", runtimeKind: "codex", threadId: "thread-1" };

class ApprovingRuntime implements AgentRuntime {
  readonly runtimeId = "codex-local";
  readonly runtimeKind = "codex";
  failApprove = false;
  async startThread(): Promise<StartThreadResult> { throw new Error("unused"); }
  async startTurn(): Promise<StartTurnResult> { throw new Error("unused"); }
  async approve(input: ApproveInput): Promise<ApproveResult> {
    void input;
    if (this.failApprove) throw new Error("runtime connection lost");
    return { acknowledged: true };
  }
  async interrupt(): Promise<void> { return undefined; }
  async *subscribe(): AsyncIterable<RuntimeEventDraft> { yield* []; }
}

function createContext() {
  const database = openBetterSqlite3Database(":memory:");
  runMigrations(database);
  const project = new ProjectRepository(database).create({ name: "p", rootPath: "/tmp/p", rootPathKey: "/tmp/p" });
  const session = new SessionRepository(database).create({ projectId: project.id, title: "s", state: "active" });
  const threads = new SessionThreadRepository(database);
  threads.attach({ sessionId: session.id, threadRef: THREAD_REF });
  const events = new EventRepository(database);
  const approvals = new ApprovalRepository(database);
  const published: EventEnvelope<string, JsonValue>[] = [];
  const ledger = new EventLedger(database, events, approvals, { publish: (event) => published.push(event) });
  const runtime = new ApprovingRuntime();
  const registry = new RuntimeRegistry();
  registry.register(runtime);
  const service = new ApprovalService(approvals, threads, registry, ledger);
  const ingestor = new RuntimeEventIngestor(threads, ledger);
  let ordinal = 0;
  const request = (options: { turnId?: string; connectionId?: string } = {}) => {
    ordinal += 1;
    const connectionId = options.connectionId ?? "connection-1";
    const params: Record<string, JsonValue> = { threadId: "thread-1", itemId: "item-" + String(ordinal) };
    if (options.turnId !== undefined) params["turnId"] = options.turnId;
    const approvalRef = "runtime-ref-" + String(ordinal);
    const result = ingestor.ingest({
      source: "runtime:codex-local",
      type: "approval.requested",
      payload: { kind: "command", connectionId, requestId: String(ordinal), approvalRef, request: params },
      threadRef: THREAD_REF,
      turnRef: options.turnId === undefined ? null : { threadId: "thread-1", turnId: options.turnId },
      ts: Date.now(),
      dedupeKey: connectionId + ":" + String(ordinal),
    }) as { event: EventEnvelope<string, JsonValue>; approval: { id: string } };
    return { approvalId: result.approval.id, approvalRef, requested: result.event };
  };
  return { database, service, runtime, published, request };
}

function payloadOf(event: EventEnvelope<string, JsonValue> | undefined): Record<string, JsonValue> {
  const payload = event?.payload;
  if (payload === null || payload === undefined || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("payload must be an object");
  }
  return payload;
}

describe("审批后续事件带上与 approval.requested 对齐的标识", () => {
  it("approval.resolved 带 approvalId 与 approvalRef，并保留原有字段与回合归属", async () => {
    const context = createContext();
    try {
      const { approvalId, approvalRef, requested } = context.request({ turnId: "turn-9" });
      expect(payloadOf(requested)).toMatchObject({ approvalId, approvalRef });
      await context.service.decide(approvalId, { decision: "accept" });
      const resolved = context.published.find((event) => event.type === "approval.resolved");
      expect(payloadOf(resolved)).toEqual({ decision: "accept", acknowledged: true, approvalId, approvalRef });
      expect(resolved?.turnRef).toEqual({ threadId: "thread-1", turnId: "turn-9" });
    } finally {
      context.database.close();
    }
  });

  it("approval.orphaned 带 approvalId / approvalRef / reason，并按审批请求归属到回合", () => {
    const context = createContext();
    try {
      const withTurn = context.request({ turnId: "turn-3", connectionId: "connection-old" });
      const withoutTurn = context.request({ connectionId: "connection-old" });
      expect(context.service.orphanConnection("connection-old")).toBe(2);
      const orphaned = context.published.filter((event) => event.type === "approval.orphaned");
      expect(orphaned).toHaveLength(2);
      const first = orphaned.find((event) => payloadOf(event)["approvalId"] === withTurn.approvalId);
      expect(payloadOf(first)).toEqual({
        approvalId: withTurn.approvalId,
        approvalRef: withTurn.approvalRef,
        reason: "runtime connection closed",
      });
      expect(first?.threadRef).toEqual(THREAD_REF);
      expect(first?.turnRef).toEqual({ threadId: "thread-1", turnId: "turn-3" });
      const second = orphaned.find((event) => payloadOf(event)["approvalId"] === withoutTurn.approvalId);
      expect(payloadOf(second)["approvalRef"]).toBe(withoutTurn.approvalRef);
      expect(second?.threadRef).toEqual(THREAD_REF);
      expect(second?.turnRef).toBeNull();
    } finally {
      context.database.close();
    }
  });

  it("orphanPersistedPending 同样带标识", () => {
    const context = createContext();
    try {
      const pending = context.request({ turnId: "turn-4" });
      expect(context.service.orphanPersistedPending()).toBe(1);
      const orphaned = context.published.find((event) => event.type === "approval.orphaned");
      expect(payloadOf(orphaned)).toMatchObject({ approvalId: pending.approvalId, approvalRef: pending.approvalRef });
      expect(orphaned?.turnRef).toEqual({ threadId: "thread-1", turnId: "turn-4" });
    } finally {
      context.database.close();
    }
  });

  it("orphanPersistedPending 可按运行时限定：别家 Agent 断开不作废这里的确认卡（ADR-0017）", () => {
    const context = createContext();
    try {
      context.request({ turnId: "turn-5" });
      expect(context.service.orphanPersistedPending("runtime connection closed", { runtimeId: "claude-code" })).toBe(0);
      expect(context.published.some((event) => event.type === "approval.orphaned")).toBe(false);
      expect(context.service.orphanPersistedPending("runtime connection closed", { runtimeId: "codex-local" })).toBe(1);
    } finally {
      context.database.close();
    }
  });

  it("approval.delivery-failed 带 approvalId / approvalRef / error 与回合归属", async () => {
    const context = createContext();
    try {
      const pending = context.request({ turnId: "turn-5" });
      context.runtime.failApprove = true;
      await expect(context.service.decide(pending.approvalId, { decision: "decline" })).rejects.toThrow();
      const failed = context.published.find((event) => event.type === "approval.delivery-failed");
      const payload = payloadOf(failed);
      expect(payload["approvalId"]).toBe(pending.approvalId);
      expect(payload["approvalRef"]).toBe(pending.approvalRef);
      expect(payload["error"]).toBeTruthy();
      expect(failed?.turnRef).toEqual({ threadId: "thread-1", turnId: "turn-5" });
    } finally {
      context.database.close();
    }
  });
});
