import { randomUUID } from "node:crypto";
import type { JsonValue, ThreadRef } from "@suduo/client-contracts";
import type { DatabasePort } from "../database-port.js";
import { parseJson, serializeJson } from "./repository-json.js";

export type SessionThreadState = "attached" | "detached" | "error";

export interface SessionThreadRecord {
  id: string;
  sessionId: string;
  threadRef: ThreadRef;
  role: string;
  ordinal: number;
  primary: boolean;
  state: SessionThreadState;
  metadata: JsonValue;
  attachedAt: number;
  lastSeenAt: number | null;
  detachedAt: number | null;
}

export interface AttachSessionThreadInput {
  id?: string;
  sessionId: string;
  threadRef: ThreadRef;
  role?: string;
  ordinal?: number;
  primary?: boolean;
  metadata?: JsonValue;
  now?: number;
}

interface SessionThreadRow {
  id: string;
  session_id: string;
  runtime_id: string;
  runtime_kind: string;
  thread_id: string;
  role: string;
  ordinal: number;
  is_primary: number;
  state: SessionThreadState;
  metadata_json: string;
  attached_at: number;
  last_seen_at: number | null;
  detached_at: number | null;
}

export class SessionThreadRepository {
  constructor(private readonly database: DatabasePort) {}

  attach(input: AttachSessionThreadInput): SessionThreadRecord {
    const id = input.id ?? randomUUID();
    const now = input.now ?? Date.now();
    this.database
      .prepare(
        [
          "INSERT INTO session_threads",
          "(id, session_id, runtime_id, runtime_kind, thread_id, role, ordinal, is_primary, state, metadata_json, attached_at, last_seen_at)",
          "VALUES (@id, @sessionId, @runtimeId, @runtimeKind, @threadId, @role, @ordinal, @primary, 'attached', @metadataJson, @now, @now)",
        ].join(" "),
      )
      .run({
        id,
        sessionId: input.sessionId,
        runtimeId: input.threadRef.runtimeId,
        runtimeKind: input.threadRef.runtimeKind,
        threadId: input.threadRef.threadId,
        role: input.role ?? "primary",
        ordinal: input.ordinal ?? 0,
        primary: input.primary === false ? 0 : 1,
        metadataJson: serializeJson(input.metadata ?? {}),
        now,
      });
    return requireThread(this.getById(id), id);
  }

  getById(id: string): SessionThreadRecord | null {
    const row = this.database
      .prepare("SELECT * FROM session_threads WHERE id = @id")
      .get<SessionThreadRow>({ id });
    return row ? mapThread(row) : null;
  }

  getByRuntimeThread(
    runtimeId: string,
    threadId: string,
  ): SessionThreadRecord | null {
    const row = this.database
      .prepare(
        "SELECT * FROM session_threads WHERE runtime_id = @runtimeId AND thread_id = @threadId",
      )
      .get<SessionThreadRow>({ runtimeId, threadId });
    return row ? mapThread(row) : null;
  }

  getBySessionAndThreadRef(
    sessionId: string,
    threadRef: ThreadRef,
  ): SessionThreadRecord | null {
    const row = this.database
      .prepare(
        [
          "SELECT * FROM session_threads",
          "WHERE session_id = @sessionId AND runtime_id = @runtimeId",
          "AND runtime_kind = @runtimeKind AND thread_id = @threadId",
        ].join(" "),
      )
      .get<SessionThreadRow>({
        sessionId,
        runtimeId: threadRef.runtimeId,
        runtimeKind: threadRef.runtimeKind,
        threadId: threadRef.threadId,
      });
    return row ? mapThread(row) : null;
  }

  getPrimary(sessionId: string): SessionThreadRecord | null {
    const rows = this.database
      .prepare(
        "SELECT * FROM session_threads WHERE session_id = @sessionId AND is_primary = 1 AND state = 'attached'",
      )
      .all<SessionThreadRow>({ sessionId });
    if (rows.length > 1) {
      throw new Error("session has ambiguous primary thread: " + sessionId);
    }
    return rows[0] ? mapThread(rows[0]) : null;
  }

  listBySession(sessionId: string): SessionThreadRecord[] {
    return this.database
      .prepare(
        "SELECT * FROM session_threads WHERE session_id = @sessionId ORDER BY ordinal",
      )
      .all<SessionThreadRow>({ sessionId })
      .map(mapThread);
  }

  listAttached(): SessionThreadRecord[] {
    return this.database
      .prepare(
        "SELECT * FROM session_threads WHERE state = 'attached' ORDER BY attached_at",
      )
      .all<SessionThreadRow>()
      .map(mapThread);
  }

  markDetached(id: string, now = Date.now()): boolean {
    return (
      this.database
        .prepare(
          "UPDATE session_threads SET state = 'detached', detached_at = @now, last_seen_at = @now WHERE id = @id AND state = 'attached'",
        )
        .run({ id, now }).changes === 1
    );
  }
}

function mapThread(row: SessionThreadRow): SessionThreadRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    threadRef: {
      runtimeId: row.runtime_id,
      runtimeKind: row.runtime_kind,
      threadId: row.thread_id,
    },
    role: row.role,
    ordinal: row.ordinal,
    primary: row.is_primary === 1,
    state: row.state,
    metadata: parseJson(row.metadata_json),
    attachedAt: row.attached_at,
    lastSeenAt: row.last_seen_at,
    detachedAt: row.detached_at,
  };
}

function requireThread(
  thread: SessionThreadRecord | null,
  id: string,
): SessionThreadRecord {
  if (!thread) {
    throw new Error("session thread was not persisted: " + id);
  }
  return thread;
}
