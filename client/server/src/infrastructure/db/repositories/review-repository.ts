import { randomUUID } from "node:crypto";
import type { ReviewFindingDto, ReviewFocus, ReviewStatus } from "@suduo/client-contracts";
import type { DatabasePort } from "../database-port.js";
import { parseJson, serializeJson } from "./repository-json.js";

/** 交叉评审报告（迁移 024 `review_reports`，多 Agent 协作 S9）。 */
export interface ReviewRecord {
  id: string;
  targetSessionId: string;
  reviewerSessionId: string | null;
  agentId: string;
  origin: "agent" | "user";
  focus: ReviewFocus[];
  note: string | null;
  status: ReviewStatus;
  /** 还没提交结构化意见为 null。 */
  findings: ReviewFindingDto[] | null;
  summary: string | null;
  finalMessage: string | null;
  appliedFindingIds: string[];
  error: string | null;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
}

interface ReviewRow {
  id: string;
  target_session_id: string;
  reviewer_session_id: string | null;
  agent_id: string;
  origin: "agent" | "user";
  focus_json: string;
  note: string | null;
  status: ReviewStatus;
  findings_json: string | null;
  summary: string | null;
  final_message: string | null;
  applied_json: string;
  error: string | null;
  created_at: number;
  updated_at: number;
  finished_at: number | null;
}

type ReviewPatch = Partial<
  Pick<ReviewRecord, "reviewerSessionId" | "status" | "findings" | "summary" | "finalMessage" | "appliedFindingIds" | "error" | "finishedAt">
>;

export class ReviewRepository {
  constructor(private readonly database: DatabasePort) {}

  create(input: { targetSessionId: string; agentId: string; origin: "agent" | "user"; focus: ReviewFocus[]; note: string | null; now?: number }): ReviewRecord {
    const id = randomUUID();
    const now = input.now ?? Date.now();
    this.database
      .prepare(
        [
          "INSERT INTO review_reports (id, target_session_id, agent_id, origin, focus_json, note, status, created_at, updated_at)",
          "VALUES (@id, @targetSessionId, @agentId, @origin, @focus, @note, 'queued', @now, @now)",
        ].join(" "),
      )
      .run({ id, targetSessionId: input.targetSessionId, agentId: input.agentId, origin: input.origin, focus: serializeJson(input.focus as never), note: input.note, now });
    return this.require(id);
  }

  getById(id: string): ReviewRecord | null {
    const row = this.database.prepare("SELECT * FROM review_reports WHERE id = @id").get<ReviewRow>({ id });
    return row ? mapRow(row) : null;
  }

  /** 评审会话对应的报告（评审工具按会话找）。 */
  getByReviewer(reviewerSessionId: string): ReviewRecord | null {
    const row = this.database
      .prepare("SELECT * FROM review_reports WHERE reviewer_session_id = @reviewerSessionId ORDER BY created_at DESC LIMIT 1")
      .get<ReviewRow>({ reviewerSessionId });
    return row ? mapRow(row) : null;
  }

  listByTarget(targetSessionId: string): ReviewRecord[] {
    return this.database
      .prepare("SELECT * FROM review_reports WHERE target_session_id = @targetSessionId ORDER BY created_at ASC")
      .all<ReviewRow>({ targetSessionId })
      .map(mapRow);
  }

  /** 交回了结构化意见、还一条都没交回原 Agent 修改的（「我的工作 · 待处理的评审意见」，S12）。 */
  listAwaitingHandback(since: number): ReviewRecord[] {
    return this.database
      .prepare(
        "SELECT * FROM review_reports WHERE status = 'submitted' AND finished_at >= @since " +
          "AND findings_json IS NOT NULL AND json_array_length(findings_json) > 0 AND json_array_length(applied_json) = 0 " +
          "ORDER BY finished_at DESC LIMIT 50",
      )
      .all<ReviewRow>({ since })
      .map(mapRow);
  }

  /** 还没结束的（排队中、评审中，以及回合中途已提交的）：本机服务启动时收尾。 */
  listUnfinished(): ReviewRecord[] {
    return this.database
      .prepare("SELECT * FROM review_reports WHERE finished_at IS NULL ORDER BY created_at ASC")
      .all<ReviewRow>()
      .map(mapRow);
  }

  update(id: string, patch: ReviewPatch, now = Date.now()): ReviewRecord {
    const next = { ...this.require(id), ...patch };
    this.database
      .prepare(
        [
          "UPDATE review_reports SET reviewer_session_id = @reviewerSessionId, status = @status, findings_json = @findings, summary = @summary,",
          "final_message = @finalMessage, applied_json = @applied, error = @error, finished_at = @finishedAt, updated_at = @now WHERE id = @id",
        ].join(" "),
      )
      .run({
        id,
        reviewerSessionId: next.reviewerSessionId,
        status: next.status,
        findings: next.findings === null ? null : serializeJson(next.findings as never),
        summary: next.summary,
        finalMessage: next.finalMessage,
        applied: serializeJson(next.appliedFindingIds as never),
        error: next.error,
        finishedAt: next.finishedAt,
        now,
      });
    return this.require(id);
  }

  private require(id: string): ReviewRecord {
    const record = this.getById(id);
    if (record === null) throw new Error("review was not persisted: " + id);
    return record;
  }
}

function mapRow(row: ReviewRow): ReviewRecord {
  return {
    id: row.id,
    targetSessionId: row.target_session_id,
    reviewerSessionId: row.reviewer_session_id,
    agentId: row.agent_id,
    origin: row.origin,
    focus: parseJson(row.focus_json) as unknown as ReviewFocus[],
    note: row.note,
    status: row.status,
    findings: row.findings_json === null ? null : (parseJson(row.findings_json) as unknown as ReviewFindingDto[]),
    summary: row.summary,
    finalMessage: row.final_message,
    appliedFindingIds: parseJson(row.applied_json) as unknown as string[],
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  };
}
