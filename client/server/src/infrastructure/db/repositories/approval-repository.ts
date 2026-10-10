import type {
  ApprovalDecision,
  ApprovalKind,
  ApprovalStatus,
  JsonValue,
} from "@suduo/client-contracts";
import type { DatabasePort } from "../database-port.js";
import { parseJson, serializeJson } from "./repository-json.js";

export interface ApprovalRecord {
  id: string;
  sessionId: string;
  sessionThreadId: string;
  source: string;
  kind: ApprovalKind;
  status: ApprovalStatus;
  decision: ApprovalDecision | null;
  runtimeConnectionId: string;
  runtimeRequestId: string;
  runtimeApprovalRef: string;
  dedupeKey: string;
  requestPayload: JsonValue;
  decisionPayload: JsonValue | null;
  requestEventSeq: number;
  decisionEventSeq: number | null;
  requestedAt: number;
  decidedAt: number | null;
  decidedBy: string | null;
  error: JsonValue | null;
  version: number;
}

export interface CreatePendingApprovalInput {
  id: string;
  sessionId: string;
  sessionThreadId: string;
  source: string;
  kind: ApprovalKind;
  runtimeConnectionId: string;
  runtimeRequestId: string;
  runtimeApprovalRef: string;
  dedupeKey: string;
  requestPayload: JsonValue;
  requestEventSeq: number;
  requestedAt: number;
}

interface ApprovalRow {
  id: string;
  session_id: string;
  session_thread_id: string;
  source: string;
  kind: ApprovalKind;
  status: ApprovalStatus;
  decision: ApprovalDecision | null;
  runtime_connection_id: string;
  runtime_request_id: string;
  runtime_approval_ref: string;
  dedupe_key: string;
  request_payload_json: string;
  decision_payload_json: string | null;
  request_event_seq: number;
  decision_event_seq: number | null;
  requested_at: number;
  decided_at: number | null;
  decided_by: string | null;
  error_json: string | null;
  version: number;
}

export class ApprovalRepository {
  constructor(private readonly database: DatabasePort) {}

  createPending(input: CreatePendingApprovalInput): ApprovalRecord {
    try {
      this.database
        .prepare(
          [
            "INSERT INTO approvals",
            "(id, session_id, session_thread_id, source, kind, status, runtime_connection_id, runtime_request_id, runtime_approval_ref, dedupe_key, request_payload_json, request_event_seq, requested_at, version)",
            "VALUES (@id, @sessionId, @sessionThreadId, @source, @kind, 'pending', @runtimeConnectionId, @runtimeRequestId, @runtimeApprovalRef, @dedupeKey, @requestPayloadJson, @requestEventSeq, @requestedAt, 1)",
          ].join(" "),
        )
        .run({
          id: input.id,
          sessionId: input.sessionId,
          sessionThreadId: input.sessionThreadId,
          source: input.source,
          kind: input.kind,
          runtimeConnectionId: input.runtimeConnectionId,
          runtimeRequestId: input.runtimeRequestId,
          runtimeApprovalRef: input.runtimeApprovalRef,
          dedupeKey: input.dedupeKey,
          requestPayloadJson: serializeJson(input.requestPayload),
          requestEventSeq: input.requestEventSeq,
          requestedAt: input.requestedAt,
        });
    } catch (error) {
      const existing = this.getByDedupeKey(input.source, input.dedupeKey);
      if (existing) {
        return existing;
      }
      throw error;
    }
    return requireApproval(this.getById(input.id), input.id);
  }

  getById(id: string): ApprovalRecord | null {
    const row = this.database
      .prepare("SELECT * FROM approvals WHERE id = @id")
      .get<ApprovalRow>({ id });
    return row ? mapApproval(row) : null;
  }

  getByDedupeKey(source: string, dedupeKey: string): ApprovalRecord | null {
    const row = this.database
      .prepare(
        "SELECT * FROM approvals WHERE source = @source AND dedupe_key = @dedupeKey",
      )
      .get<ApprovalRow>({ source, dedupeKey });
    return row ? mapApproval(row) : null;
  }

  listBySession(sessionId: string): ApprovalRecord[] {
    return this.database
      .prepare(
        "SELECT * FROM approvals WHERE session_id = @sessionId ORDER BY requested_at DESC",
      )
      .all<ApprovalRow>({ sessionId })
      .map(mapApproval);
  }

  listPendingOrDeciding(): ApprovalRecord[] {
    return this.database
      .prepare(
        "SELECT * FROM approvals WHERE status IN ('pending', 'deciding') ORDER BY requested_at",
      )
      .all<ApprovalRow>()
      .map(mapApproval);
  }

  markDeciding(
    id: string,
    expectedVersion: number,
    decision: ApprovalDecision,
  ): boolean {
    return (
      this.database
        .prepare(
          [
            "UPDATE approvals",
            "SET status = 'deciding', decision = @decision, version = version + 1",
            "WHERE id = @id AND status = 'pending' AND version = @expectedVersion",
          ].join(" "),
        )
        .run({ id, expectedVersion, decision }).changes === 1
    );
  }

  resolve(
    id: string,
    decisionEventSeq: number,
    decisionPayload: JsonValue,
    decidedBy: string,
    now = Date.now(),
  ): boolean {
    return (
      this.database
        .prepare(
          [
            "UPDATE approvals SET",
            "status = 'resolved', decision_event_seq = @decisionEventSeq,",
            "decision_payload_json = @decisionPayloadJson, decided_at = @now,",
            "decided_by = @decidedBy, version = version + 1",
            "WHERE id = @id AND status = 'deciding' AND decision IS NOT NULL",
          ].join(" "),
        )
        .run({
          id,
          decisionEventSeq,
          decisionPayloadJson: serializeJson(decisionPayload),
          now,
          decidedBy,
        }).changes === 1
    );
  }

  /** 会话里最早一个还在等确认的操作的时间（卡住提醒，S12）；没有为 null。 */
  oldestPendingAt(sessionId: string): number | null {
    const row = this.database
      .prepare("SELECT MIN(requested_at) AS at FROM approvals WHERE session_id = @sessionId AND status IN ('pending', 'deciding')")
      .get<{ at: number | null }>({ sessionId });
    return row?.at ?? null;
  }

  countPendingBySession(sessionId: string): number {
    const row = this.database
      .prepare(
        [
          "SELECT COUNT(*) AS count FROM approvals",
          "WHERE session_id = @sessionId AND status IN ('pending', 'deciding')",
        ].join(" "),
      )
      .get<{ count: number }>({ sessionId });
    return row?.count ?? 0;
  }

  countPendingGroupedBySession(): Map<string, number> {
    const rows = this.database
      .prepare(
        [
          "SELECT session_id, COUNT(*) AS count FROM approvals",
          "WHERE status IN ('pending', 'deciding')",
          "GROUP BY session_id",
        ].join(" "),
      )
      .all<{ session_id: string; count: number }>();
    return new Map(rows.map((row) => [row.session_id, row.count]));
  }

  markOrphanedByConnection(
    runtimeConnectionId: string,
    now = Date.now(),
  ): number {
    return this.database
      .prepare(
        [
          "UPDATE approvals SET",
          "status = 'orphaned', decided_at = @now, version = version + 1",
          "WHERE runtime_connection_id = @runtimeConnectionId",
          "AND status IN ('pending', 'deciding')",
        ].join(" "),
      )
      .run({ runtimeConnectionId, now }).changes;
  }

  markOrphaned(id: string, expectedVersion: number, now = Date.now()): boolean {
    return (
      this.database
        .prepare(
          [
            "UPDATE approvals SET",
            "status = 'orphaned', decided_at = @now, version = version + 1",
            "WHERE id = @id AND version = @expectedVersion",
            "AND status IN ('pending', 'deciding')",
          ].join(" "),
        )
        .run({ id, expectedVersion, now }).changes === 1
    );
  }

  markDeliveryFailed(
    id: string,
    expectedVersion: number,
    error: JsonValue,
    now = Date.now(),
  ): boolean {
    return (
      this.database
        .prepare(
          [
            "UPDATE approvals SET",
            "status = 'delivery_failed', error_json = @errorJson,",
            "decided_at = @now, version = version + 1",
            "WHERE id = @id AND version = @expectedVersion AND status = 'deciding'",
          ].join(" "),
        )
        .run({ id, expectedVersion, errorJson: serializeJson(error), now })
        .changes === 1
    );
  }
}

function mapApproval(row: ApprovalRow): ApprovalRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    sessionThreadId: row.session_thread_id,
    source: row.source,
    kind: row.kind,
    status: row.status,
    decision: row.decision,
    runtimeConnectionId: row.runtime_connection_id,
    runtimeRequestId: row.runtime_request_id,
    runtimeApprovalRef: row.runtime_approval_ref,
    dedupeKey: row.dedupe_key,
    requestPayload: parseJson(row.request_payload_json),
    decisionPayload: row.decision_payload_json
      ? parseJson(row.decision_payload_json)
      : null,
    requestEventSeq: row.request_event_seq,
    decisionEventSeq: row.decision_event_seq,
    requestedAt: row.requested_at,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
    error: row.error_json ? parseJson(row.error_json) : null,
    version: row.version,
  };
}

function requireApproval(
  approval: ApprovalRecord | null,
  id: string,
): ApprovalRecord {
  if (!approval) {
    throw new Error("approval was not persisted: " + id);
  }
  return approval;
}
