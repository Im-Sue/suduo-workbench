import { setTimeout as delay } from "node:timers/promises";
import type { AgentRuntime, RuntimeEventDraft } from "@suduo/client-contracts";
import type { ApprovalService } from "./approval-service.js";
import type { RuntimeEventIngestor } from "./runtime-event-ingestor.js";
import type { RuntimeSupervisor } from "./runtime-supervisor.js";

export async function consumeRuntimeUntilAborted(input: {
  runtime: AgentRuntime;
  ingestor: RuntimeEventIngestor;
  approvals: ApprovalService;
  supervisor: RuntimeSupervisor;
  /**
   * 客户端自定义工具调用（ADR-0008）：`tool.call-*` 事件不进账本（Codex 自己的
   * dynamicToolCall item 已经在账本里），交给工具服务异步执行。
   */
  toolCalls?: { handle(event: RuntimeEventDraft): void };
  signal: AbortSignal;
  onError?(error: unknown): void;
  onActivity?(): void;
  recover?(): Promise<void>;
  restartMaxMs?: number;
}): Promise<void> {
  let restartDelayMs = 250;
  while (!input.signal.aborted) {
    let receivedEvent = false;
    try {
      for await (const event of input.runtime.subscribe({
        signal: input.signal,
      })) {
        receivedEvent = true;
        input.onActivity?.();
        if (event.type === "tool.call-requested" || event.type === "tool.call-cancelled") {
          try {
            if (input.toolCalls) {
              input.toolCalls.handle(event);
            } else if (event.type === "tool.call-requested") {
              // 没有工具服务时也必须回包，否则 Codex 的回合会一直等。
              void declineToolCall(input.runtime, event);
            }
          } catch (error) {
            input.onError?.(error);
          }
          continue;
        }
        try {
          input.ingestor.ingest(event);
        } catch (error) {
          input.onError?.(error);
        }
      }
    } catch (error) {
      if (!input.signal.aborted) {
        input.onError?.(error);
      }
    }
    if (input.signal.aborted) {
      return;
    }
    try {
      input.approvals.orphanPersistedPending("runtime connection closed", { inProcess: true });
    } catch (error) {
      input.onError?.(error);
    }
    input.supervisor.markUnavailable(input.runtime.runtimeId);
    await delay(restartDelayMs, undefined, { signal: input.signal }).catch(
      () => undefined,
    );
    if (input.signal.aborted) {
      return;
    }
    try {
      await input.recover?.();
      restartDelayMs = 250;
    } catch (error) {
      input.onError?.(error);
      restartDelayMs = Math.min(
        restartDelayMs * 2,
        input.restartMaxMs ?? 30_000,
      );
    }
    if (receivedEvent) {
      restartDelayMs = 250;
    }
  }
}

async function declineToolCall(runtime: AgentRuntime, event: RuntimeEventDraft): Promise<void> {
  const payload = event.payload;
  const callRef =
    payload !== null && typeof payload === "object" && !Array.isArray(payload)
      ? payload["callRef"]
      : undefined;
  if (typeof callRef !== "string") {
    return;
  }
  await runtime
    .respondToolCall?.({
      callRef,
      success: false,
      contentItems: [{ type: "inputText", text: "SuDuo 工具服务不可用，这次调用没有执行。" }],
    })
    .catch(() => undefined);
}
