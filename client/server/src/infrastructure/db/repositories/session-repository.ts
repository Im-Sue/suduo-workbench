import { randomUUID } from "node:crypto";
import { isReasoningEffort, type JsonValue, type Locale, type ReasoningEffort } from "@suduo/client-contracts";
import type { DatabasePort } from "../database-port.js";
import { parseJson, serializeJson } from "./repository-json.js";

export type SessionState =
  | "starting"
  | "active"
  | "error"
  | "archived"
  | "deleted";

export type SessionApprovalMode = "ask" | "auto" | "full";
/** normal = 普通会话；room_task = 房间共享 Agent 的隐藏任务会话（迁移 016）。 */
export type SessionKind = "normal" | "room_task";
export type SessionPurpose =
  | "general"
  | "pm_requirement"
  | "backend"
  | "fe_ui"
  | "fe_connect"
  | "test";

export interface SessionRecord {
  id: string;
  projectId: string;
  title: string;
  state: SessionState;
  purpose: SessionPurpose;
  approvalMode: SessionApprovalMode;
  /** 会话种类；房间任务会话不进普通列表，安全档固定为房间 Agent 档。 */
  kind: SessionKind;
  /** 建会话时定下的语言：交给 Codex 的说明、工具定义与工具回包按它写（迁移 017，存量会话为 zh-CN）。 */
  locale: Locale;
  /** 会话用的 Agent（迁移 019，存量会话为 codex；ADR-0014）。 */
  agentId: string;
  /** 会话级模型；null = 跟随全局默认。 */
  model: string | null;
  /** 会话级推理强度；null = 跟随全局默认。 */
  reasoningEffort: ReasoningEffort | null;
  createdAt: number;
  updatedAt: number;
  lastOpenedAt: number | null;
  lastActivityAt: number | null;
  archivedAt: number | null;
  deletedAt: number | null;
  error: JsonValue | null;
  version: number;
}

export interface CreateSessionInput {
  id?: string;
  projectId: string;
  title: string;
  state?: SessionState;
  approvalMode?: SessionApprovalMode;
  purpose?: SessionPurpose;
  kind?: SessionKind;
  locale?: Locale;
  now?: number;
  /** 会话用的 Agent；不传为 codex。 */
  agentId?: string;
}

export interface SessionRow {
  id: string;
  project_id: string;
  title: string;
  state: SessionState;
  purpose: SessionPurpose;
  approval_mode: SessionApprovalMode;
  /** 迁移 016 之前的库没有这一列。 */
  kind?: SessionKind;
  /** 迁移 017 之前的库没有这一列。 */
  locale?: string;
  /** 迁移 019 之前的库没有这一列。 */
  agent_id?: string;
  model: string | null;
  reasoning_effort: string | null;
  created_at: number;
  updated_at: number;
  last_opened_at: number | null;
  last_activity_at: number | null;
  archived_at: number | null;
  deleted_at: number | null;
  error_json: string | null;
  version: number;
}

export class SessionRepository {
  constructor(private readonly database: DatabasePort) {}

  create(input: CreateSessionInput): SessionRecord {
    const id = input.id ?? randomUUID();
    const now = input.now ?? Date.now();
    const state = input.state ?? "starting";
    // 普通会话不写 kind 列、中文会话不写 locale 列、Codex 会话不写 agent_id 列（走默认值）：
    // 迁移 016 / 017 / 019 之前的库（升级测试）仍能建会话。
    const roomTask = input.kind === "room_task";
    const english = input.locale === "en";
    const agentId = input.agentId !== undefined && input.agentId !== "codex" ? input.agentId : null;
    this.database
      .prepare(
        [
          "INSERT INTO sessions",
          `(id, project_id, title, state, purpose, approval_mode, created_at, updated_at, last_activity_at, version${roomTask ? ", kind" : ""}${english ? ", locale" : ""}${agentId === null ? "" : ", agent_id"})`,
          `VALUES (@id, @projectId, @title, @state, @purpose, @approvalMode, @now, @now, @now, 1${roomTask ? ", 'room_task'" : ""}${english ? ", 'en'" : ""}${agentId === null ? "" : ", @agentId"})`,
        ].join(" "),
      )
      .run({
        id,
        projectId: input.projectId,
        title: input.title,
        state,
        purpose: input.purpose ?? "general",
        approvalMode: input.approvalMode ?? "ask",
        now,
        ...(agentId === null ? {} : { agentId }),
      });
    return requireSession(this.getById(id), id);
  }

  getById(id: string): SessionRecord | null {
    const row = this.database
      .prepare("SELECT * FROM sessions WHERE id = @id")
      .get<SessionRow>({ id });
    return row ? mapSession(row) : null;
  }

  /** 全部会话 ID（含已删除；启动清理旧版现状文件目录用）。 */
  listAllIds(): string[] {
    return this.database
      .prepare("SELECT id FROM sessions")
      .all<{ id: string }>()
      .map((row) => row.id);
  }

  listByProject(projectId: string): SessionRecord[] {
    return this.database
      .prepare(
        "SELECT * FROM sessions WHERE project_id = @projectId ORDER BY last_activity_at DESC, updated_at DESC",
      )
      .all<SessionRow>({ projectId })
      .map(mapSession);
  }

  /**
   * 归属这个远程项目的普通会话：项目会话引用或需求会话引用指向它，且本机项目仍在用。
   * 排序与 listByProject 一致。
   */
  listByRemoteProject(remoteProjectId: string): SessionRecord[] {
    return this.database
      .prepare(
        [
          "SELECT s.* FROM sessions s",
          "JOIN projects p ON p.id = s.project_id AND p.state = 'active'",
          "WHERE s.kind = 'normal' AND (",
          "  s.id IN (SELECT session_id FROM v2_project_session_refs WHERE remote_project_id = @remoteProjectId)",
          "  OR s.id IN (SELECT session_id FROM v2_requirement_session_refs WHERE remote_project_id = @remoteProjectId)",
          ")",
          "ORDER BY s.last_activity_at DESC, s.updated_at DESC",
        ].join(" "),
      )
      .all<SessionRow>({ remoteProjectId })
      .map(mapSession);
  }

  listActiveByLastActivity(limit: number): SessionRecord[] {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new Error("session list limit must be a positive safe integer");
    }
    return this.database
      .prepare(
        [
          "SELECT * FROM sessions",
          // 房间任务会话是隐藏的，不进工作台的「最近会话」。
          "WHERE state IN ('starting', 'active', 'error') AND kind = 'normal'",
          "ORDER BY last_activity_at DESC, updated_at DESC, id ASC",
          "LIMIT @limit",
        ].join(" "),
      )
      .all<SessionRow>({ limit })
      .map(mapSession);
  }

  hasActiveByProject(projectId: string): boolean {
    const row = this.database
      .prepare(
        [
          "SELECT COUNT(*) AS count FROM sessions",
          "WHERE project_id = @projectId",
          "AND state IN ('starting', 'active', 'error')",
        ].join(" "),
      )
      .get<{ count: number }>({ projectId });
    return (row?.count ?? 0) > 0;
  }

  /**
   * expectedVersion 为 null 时后写生效（ADR-0004）；传版本号时沿用旧客户端的比对语义。
   * model / reasoningEffort：undefined = 不改，null = 恢复跟随全局默认。
   */
  update(
    id: string,
    expectedVersion: number | null,
    input: {
      title?: string;
      state?: "active" | "archived";
      approvalMode?: SessionApprovalMode;
      purpose?: SessionPurpose;
      model?: string | null;
      reasoningEffort?: ReasoningEffort | null;
    },
    options: { error?: JsonValue | null; now?: number } = {},
  ): boolean {
    const current = this.getById(id);
    if (!current) {
      return false;
    }
    const now = options.now ?? Date.now();
    const title = input.title ?? current.title;
    const state = input.state ?? current.state;
    const approvalMode = input.approvalMode ?? current.approvalMode;
    const purpose = input.purpose ?? current.purpose;
    const model = input.model === undefined ? current.model : input.model;
    const reasoningEffort =
      input.reasoningEffort === undefined
        ? current.reasoningEffort
        : input.reasoningEffort;
    const archivedAt = archivedAtForState(current, state, now);
    const error = options.error === undefined ? current.error : options.error;
    return (
      this.database
        .prepare(
          [
            "UPDATE sessions SET",
            "title = @title, state = @state, purpose = @purpose, approval_mode = @approvalMode,",
            "model = @model, reasoning_effort = @reasoningEffort, updated_at = @now,",
            "last_activity_at = @now, archived_at = @archivedAt,",
            "deleted_at = NULL, error_json = @errorJson, version = version + 1",
            // 已删除是终态：后写生效路径不比对版本，也不能把并发删除的会话写回活动。
            "WHERE id = @id AND state <> 'deleted' AND (@expectedVersion IS NULL OR version = @expectedVersion)",
          ].join(" "),
        )
        .run({
          id,
          expectedVersion,
          title,
          state,
          approvalMode,
          purpose,
          model,
          reasoningEffort,
          now,
          archivedAt,
          errorJson: error === null ? null : serializeJson(error),
        }).changes === 1
    );
  }

  updateState(
    id: string,
    expectedVersion: number,
    state: SessionState,
    options: {
      error?: JsonValue | null;
      now?: number;
    } = {},
  ): boolean {
    const current = this.getById(id);
    if (!current) {
      return false;
    }
    const now = options.now ?? Date.now();
    const archivedAt = archivedAtForState(current, state, now);
    const deletedAt = state === "deleted" ? now : null;
    const error = options.error === undefined ? null : options.error;
    const result = this.database
      .prepare(
        [
          "UPDATE sessions SET",
          "state = @state, updated_at = @now, last_activity_at = @now,",
          "archived_at = @archivedAt, deleted_at = @deletedAt, error_json = @errorJson,",
          "version = version + 1",
          "WHERE id = @id AND version = @expectedVersion",
        ].join(" "),
      )
      .run({
        id,
        expectedVersion,
        state,
        now,
        archivedAt,
        deletedAt,
        errorJson: error === null ? null : serializeJson(error),
      });
    return result.changes === 1;
  }

  touchActivity(id: string, now = Date.now()): void {
    this.database
      .prepare(
        "UPDATE sessions SET last_activity_at = @now, updated_at = @now WHERE id = @id",
      )
      .run({ id, now });
  }

  /**
   * 入账时维护「最后一句话」预览（派生数据，不动 version / updated_at）。只接受更新的
   * 事件序号；同时把最后活动时间推到这句话的时间，助手回复完成也算会话活动。
   */
  recordLastMessage(
    id: string,
    preview: { role: "user" | "assistant"; text: string; seq: number; ts: number },
  ): void {
    this.database
      .prepare(
        [
          "UPDATE sessions SET",
          "last_message_role = @role, last_message_text = @text, last_message_seq = @seq,",
          "last_activity_at = MAX(COALESCE(last_activity_at, 0), @ts)",
          "WHERE id = @id AND (last_message_seq IS NULL OR last_message_seq < @seq)",
        ].join(" "),
      )
      .run({ id, role: preview.role, text: preview.text, seq: preview.seq, ts: preview.ts });
  }
}

function archivedAtForState(
  current: SessionRecord,
  state: SessionState,
  now: number,
): number | null {
  if (state !== "archived") return null;
  return current.state === "archived" ? current.archivedAt : now;
}

export function mapSession(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    state: row.state,
    purpose: row.purpose,
    approvalMode: row.approval_mode,
    kind: row.kind === "room_task" ? "room_task" : "normal",
    locale: row.locale === "en" ? "en" : "zh-CN",
    agentId: row.agent_id ?? "codex",
    model: row.model,
    reasoningEffort: isReasoningEffort(row.reasoning_effort)
      ? row.reasoning_effort
      : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastOpenedAt: row.last_opened_at,
    lastActivityAt: row.last_activity_at,
    archivedAt: row.archived_at,
    deletedAt: row.deleted_at,
    error: row.error_json ? parseJson(row.error_json) : null,
    version: row.version,
  };
}

function requireSession(
  session: SessionRecord | null,
  id: string,
): SessionRecord {
  if (!session) {
    throw new Error("session was not persisted: " + id);
  }
  return session;
}
