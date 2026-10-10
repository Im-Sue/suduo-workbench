import { randomUUID } from "node:crypto";
import {
  BACKFILL_LATEST_ONLY_EVENT_TYPES,
  BACKFILL_OMITTED_EVENT_TYPES,
  type EventEnvelope,
  type JsonValue,
  type ThreadRef,
  type TurnRef,
} from "@suduo/client-contracts";
import type { SessionRunStatusEvent } from "../../../application/session-run-status-reducer.js";
import type { DatabasePort } from "../database-port.js";
import { parseJson, serializeJson } from "./repository-json.js";

export interface EventRecord
  extends EventEnvelope<string, JsonValue> {
  sessionThreadId: string | null;
  dedupeKey: string | null;
  createdAt: number;
}

export interface AppendEventInput {
  eventId?: string;
  sessionId: string;
  sessionThreadId?: string | null;
  source: string;
  type: string;
  payload: JsonValue;
  threadRef: ThreadRef | null;
  turnRef: TurnRef | null;
  ts: number;
  dedupeKey?: string;
  createdAt?: number;
}

export interface AppendEventResult {
  event: EventRecord;
  inserted: boolean;
}

interface EventRow {
  seq: number;
  event_id: string;
  session_id: string;
  session_thread_id: string | null;
  source: string;
  type: string;
  payload_json: string;
  thread_ref_json: string | null;
  turn_ref: string | null;
  ts: number;
  dedupe_key: string | null;
  created_at: number;
}

export class EventRepository {
  constructor(private readonly database: DatabasePort) {}

  append(input: AppendEventInput): AppendEventResult {
    const eventId = input.eventId ?? randomUUID();
    const createdAt = input.createdAt ?? Date.now();

    try {
      const result = this.database
        .prepare(
          [
            "INSERT INTO events",
            "(event_id, session_id, session_thread_id, source, type, payload_json, thread_ref_json, turn_ref, ts, dedupe_key, created_at)",
            "VALUES (@eventId, @sessionId, @sessionThreadId, @source, @type, @payloadJson, @threadRefJson, @turnRef, @ts, @dedupeKey, @createdAt)",
          ].join(" "),
        )
        .run({
          eventId,
          sessionId: input.sessionId,
          sessionThreadId: input.sessionThreadId ?? null,
          source: input.source,
          type: input.type,
          payloadJson: serializeJson(input.payload),
          threadRefJson:
            input.threadRef === null
              ? null
              : serializeJson(input.threadRef as unknown as JsonValue),
          turnRef: input.turnRef?.turnId ?? null,
          ts: input.ts,
          dedupeKey: input.dedupeKey ?? null,
          createdAt,
        });
      const event = this.getBySeq(Number(result.lastInsertRowid));
      return {
        event: requireEvent(event, Number(result.lastInsertRowid)),
        inserted: true,
      };
    } catch (error) {
      if (input.dedupeKey) {
        const existing = this.getByDedupeKey(input.source, input.dedupeKey);
        if (existing) {
          return { event: existing, inserted: false };
        }
      }
      throw error;
    }
  }

  getBySeq(seq: number): EventRecord | null {
    const row = this.database
      .prepare("SELECT * FROM events WHERE seq = @seq")
      .get<EventRow>({ seq });
    return row ? mapEvent(row) : null;
  }

  getByDedupeKey(source: string, dedupeKey: string): EventRecord | null {
    const row = this.database
      .prepare(
        "SELECT * FROM events WHERE source = @source AND dedupe_key = @dedupeKey",
      )
      .get<EventRow>({ source, dedupeKey });
    return row ? mapEvent(row) : null;
  }

  listAfter(sessionId: string, afterSeq = 0, limit = 500): EventRecord[] {
    return this.database
      .prepare(
        [
          "SELECT * FROM events",
          "WHERE session_id = @sessionId AND seq > @afterSeq",
          "ORDER BY seq ASC LIMIT @limit",
        ].join(" "),
      )
      .all<EventRow>({ sessionId, afterSeq, limit })
      .map(mapEvent);
  }

  listRange(
    sessionId: string,
    afterSeq: number,
    throughSeq: number,
    limit = 500,
  ): EventRecord[] {
    return this.database
      .prepare(
        [
          "SELECT * FROM events",
          "WHERE session_id = @sessionId AND seq > @afterSeq AND seq <= @throughSeq",
          "ORDER BY seq ASC LIMIT @limit",
        ].join(" "),
      )
      .all<EventRow>({ sessionId, afterSeq, throughSeq, limit })
      .map(mapEvent);
  }

  /**
   * 仅供历史回放使用的紧凑事件页。流式增量由 item.completed 中的完整内容
   * 替代，故在 SQL 层过滤，避免先 LIMIT 再过滤导致页面有效事件不足。
   * 快照类（usage.updated）只保留区间内最后一条：分页推进时区间上界不变，
   * 该条恰好出现在覆盖它的那一页，历史回放仍能得到最终值。
   */
  listBackfill(
    sessionId: string,
    afterSeq: number,
    throughSeq: number,
    limit = 500,
  ): EventRecord[] {
    return this.database
      .prepare(
        [
          "SELECT * FROM events",
          "WHERE session_id = @sessionId AND seq > @afterSeq AND seq <= @throughSeq",
          `AND type NOT IN (${sqlStringList(BACKFILL_OMITTED_EVENT_TYPES)})`,
          `AND (type NOT IN (${sqlStringList(BACKFILL_LATEST_ONLY_EVENT_TYPES)}) OR seq = (`,
          "SELECT MAX(latest.seq) FROM events latest",
          "WHERE latest.session_id = @sessionId AND latest.type = events.type",
          "AND latest.seq > @afterSeq AND latest.seq <= @throughSeq))",
          "ORDER BY seq ASC LIMIT @limit",
        ].join(" "),
      )
      .all<EventRow>({ sessionId, afterSeq, throughSeq, limit })
      .map(mapEvent);
  }

  listRunningTurnRefs(sessionId: string): TurnRef[] {
    const rows = this.database
      .prepare(
        [
          "SELECT turn_ref, thread_ref_json, type, seq FROM events",
          "WHERE session_id = @sessionId AND turn_ref IS NOT NULL",
          "AND type IN ('turn.started', 'turn.completed', 'turn.interrupted', 'turn.start-failed')",
          "ORDER BY seq ASC",
        ].join(" "),
      )
      .all<Pick<EventRow, "turn_ref" | "thread_ref_json" | "type" | "seq">>({
        sessionId,
      });
    const turns = new Map<string, { ref: TurnRef; running: boolean }>();
    for (const row of rows) {
      if (!row.turn_ref || !row.thread_ref_json) {
        continue;
      }
      const threadRef = parseJson(row.thread_ref_json) as unknown as ThreadRef;
      turns.set(threadRef.threadId + "\0" + row.turn_ref, {
        ref: { threadId: threadRef.threadId, turnId: row.turn_ref },
        running: row.type === "turn.started",
      });
    }
    return [...turns.values()]
      .filter((turn) => turn.running)
      .map((turn) => turn.ref);
  }

  /**
   * 本机队列相关事件（多 Agent 协作 S8）：排队、出队与开不起来，按先后。本机服务启动时据此给重启前还在排队的消息收尾。
   */
  listQueueEvents(): EventRecord[] {
    return this.database
      .prepare("SELECT * FROM events WHERE type IN ('turn.queued', 'turn.dequeued', 'turn.start-failed') ORDER BY seq ASC")
      .all<EventRow>({})
      .map(mapEvent);
  }

  /** 会话第一个回合开始到最后一个回合结束（并行试做的耗时）；还没有回合为 null。 */
  turnSpan(sessionId: string): { startedAt: number; endedAt: number | null } | null {
    const row = this.database
      .prepare(
        [
          "SELECT MIN(CASE WHEN type = 'turn.started' THEN ts END) AS started,",
          "MAX(CASE WHEN type IN ('turn.completed', 'turn.interrupted') THEN ts END) AS ended",
          "FROM events WHERE session_id = @sessionId AND type IN ('turn.started', 'turn.completed', 'turn.interrupted')",
        ].join(" "),
      )
      .get<{ started: number | null; ended: number | null }>({ sessionId });
    if (!row || row.started === null) return null;
    return { startedAt: row.started, endedAt: row.ended !== null && row.ended >= row.started ? row.ended : null };
  }

  /** 会话里某条已提交消息（按 clientTurnId）的内容；没有为 null（重启后委派重新排队时取回）。 */
  submittedContent(sessionId: string, clientTurnId: string): JsonValue | null {
    const row = this.database
      .prepare(
        [
          "SELECT payload_json FROM events WHERE session_id = @sessionId AND type = 'message.submitted'",
          "AND json_extract(payload_json, '$.clientTurnId') = @clientTurnId ORDER BY seq DESC LIMIT 1",
        ].join(" "),
      )
      .get<{ payload_json: string }>({ sessionId, clientTurnId });
    if (!row) return null;
    const payload = parseJson(row.payload_json);
    return payload !== null && typeof payload === "object" && !Array.isArray(payload) ? (payload["content"] ?? null) : null;
  }

  /** 当前最大的事件序号（没有事件时为 0）。本机服务启动时记下，之后据此只看本次启动以来的事件。 */
  lastSeq(): number {
    const row = this.database.prepare("SELECT COALESCE(MAX(seq), 0) AS seq FROM events").get<{ seq: number }>();
    return row?.seq ?? 0;
  }

  /**
   * 序号大于 afterSeq（本次启动以来）的事件里，开始了、至今还没结束的回合分布在几个会话里（含房间任务会话）。
   * 上次异常退出时没写完的回合会一直停在 turn.started，不能算成「正在进行」。按序号而不是时间：走主键范围扫描，也不受系统时间回拨影响。
   */
  countRunningSessionsAfter(afterSeq: number): number {
    const row = this.database
      .prepare(
        [
          "SELECT COUNT(DISTINCT session_id) AS count FROM (",
          "SELECT session_id, type, ROW_NUMBER() OVER (",
          "PARTITION BY session_id, json_extract(thread_ref_json, '$.threadId'), turn_ref ORDER BY seq DESC",
          ") AS rn FROM events",
          "WHERE seq > @afterSeq AND turn_ref IS NOT NULL AND thread_ref_json IS NOT NULL",
          "AND type IN ('turn.started', 'turn.completed', 'turn.interrupted', 'turn.start-failed')",
          ") WHERE rn = 1 AND type = 'turn.started'",
        ].join(" "),
      )
      .get<{ count: number }>({ afterSeq });
    return row?.count ?? 0;
  }

  listRunStatusEventsForSessions(
    sessionIds: readonly string[],
  ): SessionRunStatusEvent[] {
    if (sessionIds.length === 0) return [];
    const parameters: Record<string, string> = {};
    const placeholders = sessionIds.map((sessionId, index) => {
      const name = `sessionId${String(index)}`;
      parameters[name] = sessionId;
      return `@${name}`;
    });
    const rows = this.database
      .prepare(
        [
          "SELECT session_id, seq, type, turn_ref, thread_ref_json, ts,",
          "json_extract(payload_json, '$.turn.status') AS turn_status",
          "FROM events",
          `WHERE session_id IN (${placeholders.join(", ")})`,
          "AND type IN ('turn.started', 'turn.completed', 'turn.interrupted', 'turn.start-failed')",
          "ORDER BY session_id ASC, seq ASC",
        ].join(" "),
      )
      .all<{
        session_id: string;
        seq: number;
        type: SessionRunStatusEvent["type"];
        turn_ref: string | null;
        thread_ref_json: string | null;
        turn_status: string | null;
        ts: number;
      }>(parameters);
    return rows.map((row) => {
      const threadRef = row.thread_ref_json
        ? (parseJson(row.thread_ref_json) as unknown as ThreadRef)
        : null;
      return {
        sessionId: row.session_id,
        seq: row.seq,
        type: row.type,
        turnRef:
          row.turn_ref && threadRef
            ? { threadId: threadRef.threadId, turnId: row.turn_ref }
            : null,
        turnStatus: row.turn_status,
        ts: row.ts,
      };
    });
  }

  /**
   * 某会话在某序号之后最近开始的一个步骤（item.started 的 item），以及它之后是否已经完成（有同 id 的 item.completed）。
   * 没有为 null。只读。
   */
  latestStep(sessionId: string, afterSeq: number): { item: JsonValue; completed: boolean } | null {
    const row = this.database
      .prepare(
        "SELECT seq, payload_json FROM events WHERE session_id = @sessionId AND type = 'item.started' AND seq > @afterSeq ORDER BY seq DESC LIMIT 1",
      )
      .get<{ seq: number; payload_json: string }>({ sessionId, afterSeq });
    if (row === undefined) return null;
    const payload = parseJson(row.payload_json) as unknown;
    const item = payload !== null && typeof payload === "object" && "item" in payload ? ((payload as { item: JsonValue }).item ?? null) : null;
    if (item === null) return null;
    const itemId = typeof item === "object" && !Array.isArray(item) && typeof item["id"] === "string" ? item["id"] : null;
    const completed =
      itemId !== null &&
      this.database
        .prepare(
          "SELECT 1 AS found FROM events WHERE session_id = @sessionId AND type = 'item.completed' AND seq > @seq AND json_extract(payload_json, '$.item.id') = @itemId LIMIT 1",
        )
        .get<{ found: number }>({ sessionId, seq: row.seq, itemId }) !== undefined;
    return { item, completed };
  }

  /**
   * 某回合在账本里是否已有终态事件（PR3 中断守卫）：已自然完成的回合不能再被
   * 一次迟到的中断补写成 interrupted。只读查询，不加锁——查询与追加之间的竞态不在这里处理。
   */
  hasTurnTerminal(sessionId: string, turnId: string): boolean {
    const row = this.database
      .prepare(
        [
          "SELECT 1 AS found FROM events",
          "WHERE session_id = @sessionId AND turn_ref = @turnId",
          "AND type IN ('turn.completed', 'turn.interrupted', 'turn.start-failed')",
          "LIMIT 1",
        ].join(" "),
      )
      .get<{ found: number }>({ sessionId, turnId });
    return row !== undefined && row !== null;
  }

  /** 最近一个回合的终态；会话从未有终态事件时为 null。 */
  lastTurnOutcome(
    sessionId: string,
  ): "completed" | "failed" | "interrupted" | null {
    // Codex 的失败回合也走 turn/completed 通知（payload.turn.status = "failed"），
    // 只看事件类型会把失败当成功，左栏徽标就再也不报「异常」。
    const row = this.database
      .prepare(
        [
          "SELECT type,",
          "json_extract(payload_json, '$.turn.status') AS turnStatus",
          "FROM events",
          "WHERE session_id = @sessionId",
          "AND type IN ('turn.completed', 'turn.interrupted', 'turn.start-failed')",
          "ORDER BY seq DESC LIMIT 1",
        ].join(" "),
      )
      .get<{ type: string; turnStatus: string | null }>({ sessionId });
    if (!row) {
      return null;
    }
    if (row.type === "turn.completed") {
      return row.turnStatus === "failed" ? "failed" : "completed";
    }
    return row.type === "turn.interrupted" ? "interrupted" : "failed";
  }

  maxSeq(sessionId: string): number {
    const row = this.database
      .prepare(
        "SELECT COALESCE(MAX(seq), 0) AS seq FROM events WHERE session_id = @sessionId",
      )
      .get<{ seq: number }>({ sessionId });
    return row?.seq ?? 0;
  }
}

/** 契约里的事件类型常量拼成 SQL 字面量列表；类型名只含小写字母、点与连字符。 */
function sqlStringList(values: readonly string[]): string {
  return values
    .map((value) => {
      if (!/^[a-z][a-z.-]*$/u.test(value)) {
        throw new Error("unexpected event type literal: " + value);
      }
      return "'" + value + "'";
    })
    .join(", ");
}

function mapEvent(row: EventRow): EventRecord {
  const threadRef = row.thread_ref_json
    ? (parseJson(row.thread_ref_json) as unknown as ThreadRef)
    : null;
  return {
    schemaVersion: 1,
    seq: row.seq,
    eventId: row.event_id,
    sessionId: row.session_id,
    source: row.source,
    type: row.type,
    payload: parseJson(row.payload_json),
    threadRef,
    turnRef:
      row.turn_ref && threadRef
        ? { threadId: threadRef.threadId, turnId: row.turn_ref }
        : null,
    ts: row.ts,
    sessionThreadId: row.session_thread_id,
    dedupeKey: row.dedupe_key,
    createdAt: row.created_at,
  };
}

function requireEvent(
  event: EventRecord | null,
  seq: number,
): EventRecord {
  if (!event) {
    throw new Error("event was not persisted: " + String(seq));
  }
  return event;
}
