import { randomUUID } from "node:crypto";
import type {
  ApprovalDecision,
  ApprovalKind,
  EventEnvelope,
  JsonValue,
  RuntimeEventDraft,
  ThreadRef,
  TurnRef,
} from "@suduo/client-contracts";
import type { DatabasePort } from "../infrastructure/db/database-port.js";
import type {
  ApprovalRecord,
  ApprovalRepository,
} from "../infrastructure/db/repositories/approval-repository.js";
import type {
  EventRecord,
  EventRepository,
} from "../infrastructure/db/repositories/event-repository.js";
import { SessionRepository } from "../infrastructure/db/repositories/session-repository.js";
import { sessionMessagePreview } from "./session-preview.js";

export interface EventPublisher {
  publish(event: EventEnvelope<string, JsonValue>): void;
}

export interface PersistRuntimeEventInput {
  sessionId: string;
  sessionThreadId: string | null;
  event: RuntimeEventDraft;
}

export interface PersistApprovalRequestInput
  extends PersistRuntimeEventInput {
  sessionThreadId: string;
  kind: ApprovalKind;
  runtimeConnectionId: string;
  runtimeRequestId: string;
  runtimeApprovalRef: string;
}

/** 会话列表「最后一句话」预览的写入口（派生数据）。 */
export interface SessionMessagePreviewSink {
  recordLastMessage(
    sessionId: string,
    preview: { role: "user" | "assistant"; text: string; seq: number; ts: number },
  ): void;
}

export class EventLedger {
  constructor(
    private readonly database: DatabasePort,
    private readonly events: EventRepository,
    private readonly approvals: ApprovalRepository,
    private readonly publisher: EventPublisher,
    private readonly previews: SessionMessagePreviewSink = new SessionRepository(database),
  ) {}

  append(input: PersistRuntimeEventInput): EventRecord {
    const result = this.database.transaction(() => {
      const appended = this.events.append(toAppendInput(input));
      if (appended.inserted) {
        this.recordPreview(appended.event);
      }
      return appended;
    })();
    if (result.inserted) {
      this.publisher.publish(result.event);
    }
    return result.event;
  }

  appendApprovalRequested(input: PersistApprovalRequestInput): {
    event: EventRecord;
    approval: ApprovalRecord;
  } {
    const approvalId = randomUUID();
    const result = this.database.transaction(() => {
      const eventResult = this.events.append(
        toAppendInput({
          ...input,
          event: {
            ...input.event,
            payload: withApprovalId(input.event.payload, approvalId),
          },
        }),
      );
      const approval = eventResult.inserted
        ? this.approvals.createPending({
            id: approvalId,
            sessionId: input.sessionId,
            sessionThreadId: input.sessionThreadId,
            source: input.event.source,
            kind: input.kind,
            runtimeConnectionId: input.runtimeConnectionId,
            runtimeRequestId: input.runtimeRequestId,
            runtimeApprovalRef: input.runtimeApprovalRef,
            dedupeKey: requireDedupeKey(input.event.dedupeKey),
            requestPayload: eventResult.event.payload,
            requestEventSeq: eventResult.event.seq,
            requestedAt: input.event.ts,
          })
        : requireApproval(
            this.approvals.getByDedupeKey(
              input.event.source,
              requireDedupeKey(input.event.dedupeKey),
            ),
          );
      return {
        eventResult,
        approval,
      };
    })();

    if (result.eventResult.inserted) {
      this.publisher.publish(result.eventResult.event);
    }
    return {
      event: result.eventResult.event,
      approval: result.approval,
    };
  }

  resolveApproval(input: {
    approval: ApprovalRecord;
    decision: ApprovalDecision;
    decisionPayload: JsonValue;
    decidedBy: string;
    event: RuntimeEventDraft;
  }): EventRecord {
    const event = this.database.transaction(() => {
      const eventResult = this.events.append({
        ...toAppendInput({
          sessionId: input.approval.sessionId,
          sessionThreadId: input.approval.sessionThreadId,
          event: input.event,
        }),
        payload: withApprovalIdentity(input.event.payload, input.approval),
      });
      if (!eventResult.inserted) {
        return eventResult.event;
      }
      const resolved = this.approvals.resolve(
        input.approval.id,
        eventResult.event.seq,
        input.decisionPayload,
        input.decidedBy,
        input.event.ts,
      );
      if (!resolved) {
        throw new Error(
          "approval resolution lost compare-and-set: " + input.approval.id,
        );
      }
      return eventResult.event;
    })();
    this.publisher.publish(event);
    return event;
  }

  orphanApproval(input: {
    approval: ApprovalRecord;
    reason: string;
    ts?: number;
    /** 审批所属线程与回合（由审批请求推出）；推不出时为 null，事件不归属任何回合。 */
    threadRef?: ThreadRef | null;
    turnRef?: TurnRef | null;
  }): EventRecord {
    const ts = input.ts ?? Date.now();
    const event = this.database.transaction(() => {
      const eventResult = this.events.append({
        sessionId: input.approval.sessionId,
        sessionThreadId: input.approval.sessionThreadId,
        source: "suduo:runtime-supervisor",
        type: "approval.orphaned",
        payload: withApprovalIdentity(
          { reason: input.reason },
          input.approval,
        ),
        ...approvalEventRefs(input),
        ts,
        dedupeKey:
          "approval-orphaned:" +
          input.approval.id +
          ":" +
          String(input.approval.version),
      });
      if (
        eventResult.inserted &&
        !this.approvals.markOrphaned(
          input.approval.id,
          input.approval.version,
          ts,
        )
      ) {
        throw new Error("approval orphan CAS failed: " + input.approval.id);
      }
      return eventResult.event;
    })();
    this.publisher.publish(event);
    return event;
  }

  failApprovalDelivery(input: {
    approval: ApprovalRecord;
    error: JsonValue;
    ts?: number;
    /** 同 orphanApproval：审批所属线程与回合，推不出时为 null。 */
    threadRef?: ThreadRef | null;
    turnRef?: TurnRef | null;
  }): EventRecord {
    const ts = input.ts ?? Date.now();
    const event = this.database.transaction(() => {
      const eventResult = this.events.append({
        sessionId: input.approval.sessionId,
        sessionThreadId: input.approval.sessionThreadId,
        source: "suduo:api",
        type: "approval.delivery-failed",
        payload: withApprovalIdentity(
          { error: input.error },
          input.approval,
        ),
        ...approvalEventRefs(input),
        ts,
        dedupeKey:
          "approval-delivery-failed:" +
          input.approval.id +
          ":" +
          String(input.approval.version),
      });
      if (
        eventResult.inserted &&
        !this.approvals.markDeliveryFailed(
          input.approval.id,
          input.approval.version,
          input.error,
          ts,
        )
      ) {
        throw new Error(
          "approval delivery failure CAS failed: " + input.approval.id,
        );
      }
      return eventResult.event;
    })();
    this.publisher.publish(event);
    return event;
  }

  /**
   * 与事件同一事务维护列表预览；预览是可重建的派生数据，写失败只记日志，
   * 绝不因此丢掉事件本身（SQLite 语句级失败不会中止外层事务）。
   */
  private recordPreview(event: EventRecord): void {
    const preview = sessionMessagePreview(event);
    if (preview === null) {
      return;
    }
    try {
      this.previews.recordLastMessage(event.sessionId, {
        ...preview,
        seq: event.seq,
        ts: event.ts,
      });
    } catch (error) {
      console.warn(JSON.stringify({
        event: "session.preview_write_failed",
        sessionId: event.sessionId,
        seq: event.seq,
        message: error instanceof Error ? error.message : String(error),
      }));
    }
  }
}

function toAppendInput(input: PersistRuntimeEventInput) {
  return {
    sessionId: input.sessionId,
    sessionThreadId: input.sessionThreadId,
    source: input.event.source,
    type: input.event.type,
    payload: input.event.payload,
    threadRef: input.event.threadRef,
    turnRef: input.event.turnRef,
    ts: input.event.ts,
    ...(input.event.dedupeKey
      ? { dedupeKey: input.event.dedupeKey }
      : {}),
  };
}

/**
 * 审批后续事件（resolved / orphaned / delivery-failed）与 approval.requested 对齐的标识：
 * approvalId 为本机审批记录 id，approvalRef 为 runtimeApprovalRef（即 requested payload 的 approvalRef）。
 */
function withApprovalIdentity(
  payload: JsonValue,
  approval: Pick<ApprovalRecord, "id" | "runtimeApprovalRef">,
): JsonValue {
  const withId = withApprovalId(payload, approval.id);
  return isJsonObject(withId)
    ? { ...withId, approvalRef: approval.runtimeApprovalRef }
    : withId;
}

/** turnRef 只在有 threadRef 时入账（账本按 thread 还原回合引用）。 */
function approvalEventRefs(input: {
  threadRef?: ThreadRef | null;
  turnRef?: TurnRef | null;
}): { threadRef: ThreadRef | null; turnRef: TurnRef | null } {
  const threadRef = input.threadRef ?? null;
  return {
    threadRef,
    turnRef: threadRef === null ? null : (input.turnRef ?? null),
  };
}

function withApprovalId(payload: JsonValue, approvalId: string): JsonValue {
  if (isJsonObject(payload)) {
    return { ...payload, approvalId };
  }
  return {
    approvalId,
    value: payload,
  };
}

function isJsonObject(
  value: JsonValue,
): value is { [key: string]: JsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requireDedupeKey(value: string | undefined): string {
  if (!value) {
    throw new Error("approval event requires dedupeKey");
  }
  return value;
}

function requireApproval(value: ApprovalRecord | null): ApprovalRecord {
  if (!value) {
    throw new Error("deduplicated approval is missing");
  }
  return value;
}
