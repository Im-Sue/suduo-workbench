import { describe, expect, it } from "vitest";
import type {
  AgentRuntime,
  ApproveResult,
  RuntimeEventDraft,
  RuntimeSubscribeOptions,
  StartThreadResult,
  StartTurnResult,
} from "@suduo/client-contracts";
import type { ApprovalService } from "../src/application/approval-service.js";
import { consumeRuntimeUntilAborted } from "../src/application/runtime-consumer.js";
import type { RuntimeEventIngestor } from "../src/application/runtime-event-ingestor.js";
import type { RuntimeSupervisor } from "../src/application/runtime-supervisor.js";

describe("T10 runtime supervisor", () => {
  it("连接崩溃后自动 orphan、重连并调用 resume 恢复", async () => {
    const abort = new AbortController();
    const runtime = new RecoveringRuntime();
    let orphaned = 0;
    let unavailable = 0;
    let recovered = 0;
    const scopes: unknown[] = [];
    const operation = consumeRuntimeUntilAborted({
      runtime,
      ingestor: { ingest: () => undefined } as unknown as RuntimeEventIngestor,
      approvals: {
        orphanPersistedPending: (_reason: string, options: unknown) => {
          orphaned += 1;
          scopes.push(options);
          return 0;
        },
      } as unknown as ApprovalService,
      supervisor: {
        markUnavailable: () => {
          unavailable += 1;
        },
      } as unknown as RuntimeSupervisor,
      signal: abort.signal,
      recover: async (runtimeId) => {
        recovered += 1;
        scopes.push(runtimeId);
        abort.abort();
      },
      restartMaxMs: 1_000,
    });
    await operation;
    expect(runtime.subscriptions).toBe(1);
    expect(orphaned).toBe(1);
    expect(unavailable).toBe(1);
    expect(recovered).toBe(1);
    // 作废与恢复都只针对断开的这个运行时（多 Agent 故障隔离）。
    expect(scopes).toEqual([{ inProcess: true, runtimeId: "codex-local" }, "codex-local"]);
  });
});

class RecoveringRuntime implements AgentRuntime {
  readonly runtimeId = "codex-local";
  readonly runtimeKind = "codex";
  subscriptions = 0;

  async startThread(): Promise<StartThreadResult> {
    throw new Error("not used");
  }

  async startTurn(): Promise<StartTurnResult> {
    throw new Error("not used");
  }

  async approve(): Promise<ApproveResult> {
    throw new Error("not used");
  }

  async interrupt(): Promise<void> {
    throw new Error("not used");
  }

  async *subscribe(
    _options: RuntimeSubscribeOptions,
  ): AsyncIterable<RuntimeEventDraft> {
    void _options;
    this.subscriptions += 1;
    yield* [];
    throw new Error("simulated app-server crash");
  }
}
