import type { ApprovalKind, JsonValue, RuntimeEventDraft } from "@suduo/client-contracts";
import type { EventLedger } from "./event-ledger.js";
import {
  CodexGlobalState,
  isCodexGlobalEvent,
} from "./codex-global-state.js";
import type { SessionThreadRepository } from "../infrastructure/db/repositories/session-thread-repository.js";
import { codexNativeType } from "../infrastructure/runtime/codex/codex-event-normalizer.js";

/**
 * 与任何会话无关、也不进全局状态投影的 Codex 通知：安静丢弃。
 * account/rateLimits/updated 在用 ChatGPT 登录或中转站透传额度时每回合都会来，不能每次都记一条错误。
 */
const IGNORED_THREADLESS_NATIVE_TYPES = new Set(["account/rateLimits/updated"]);

export class RuntimeEventIngestor {
  constructor(
    private readonly threads: SessionThreadRepository,
    private readonly ledger: EventLedger,
    private readonly codexGlobalState = new CodexGlobalState(),
  ) {}

  ingest(event: RuntimeEventDraft) {
    const binding = event.threadRef
      ? this.threads.getByRuntimeThread(
          event.threadRef.runtimeId,
          event.threadRef.threadId,
        )
      : null;
    const sessionId = event.sessionHint ?? binding?.sessionId;
    if (!sessionId) {
      if (isCodexGlobalEvent(event)) {
        return this.codexGlobalState.record(event);
      }
      if (IGNORED_THREADLESS_NATIVE_TYPES.has(codexNativeType(event) ?? "")) {
        return undefined;
      }
      // 关联失败的事件会被 consumer 丢弃，只剩这条错误进日志——必须把事件内容
      // 带全，否则 codex 进程退出码等关键线索跟着一起消失（2026-07-24 双横幅
      // 排查时因此查不到进程死因）。
      throw new Error(
        "runtime event cannot be associated with a suduo session: " +
          event.type +
          " " +
          JSON.stringify(event.payload).slice(0, 500),
      );
    }

    if (event.type === "approval.requested") {
      if (!binding) {
        throw new Error("approval event requires a persisted thread binding");
      }
      const payload = requireObject(event.payload, "approval payload");
      return this.ledger.appendApprovalRequested({
        sessionId,
        sessionThreadId: binding.id,
        kind: requireApprovalKind(payload["kind"]),
        runtimeConnectionId: requireString(
          payload["connectionId"],
          "connectionId",
        ),
        runtimeRequestId: requireString(payload["requestId"], "requestId"),
        runtimeApprovalRef: requireString(
          payload["approvalRef"],
          "approvalRef",
        ),
        event,
      });
    }

    return this.ledger.append({
      sessionId,
      sessionThreadId: binding?.id ?? null,
      event,
    });
  }
}

function requireObject(
  value: JsonValue,
  label: string,
): Record<string, JsonValue> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("invalid " + label);
  }
  return value;
}

function requireString(value: JsonValue | undefined, label: string): string {
  if (typeof value !== "string") {
    throw new Error("invalid approval " + label);
  }
  return value;
}

function requireApprovalKind(value: JsonValue | undefined): ApprovalKind {
  if (
    value === "command" ||
    value === "file-change" ||
    value === "permissions" ||
    value === "other"
  ) {
    return value;
  }
  throw new Error("invalid approval kind");
}
