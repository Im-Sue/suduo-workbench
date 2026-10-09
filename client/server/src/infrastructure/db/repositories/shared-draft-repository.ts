import { randomUUID } from "node:crypto";
import type { SharedDraftStatus } from "@suduo/client-contracts";
import type { SharedItemContent, SharedItemKind } from "@suduo/cloud-contracts";
import type { DatabasePort } from "../database-port.js";
import { parseJson, serializeJson } from "./repository-json.js";

/** 共享对象草稿（迁移 026，多 Agent 协作 S11）。 */
export interface SharedDraftRecord {
  id: string;
  kind: SharedItemKind;
  sessionId: string | null;
  reviewId: string | null;
  remoteRequirementId: string;
  agentId: string | null;
  title: string;
  content: SharedItemContent;
  status: SharedDraftStatus;
  publishedItemId: string | null;
  /** 用户在发布对话框里改过。 */
  userEdited: boolean;
  createdAt: number;
  updatedAt: number;
}

interface Row {
  id: string;
  kind: SharedItemKind;
  session_id: string | null;
  review_id: string | null;
  remote_requirement_id: string;
  agent_id: string | null;
  title: string;
  content_json: string;
  status: SharedDraftStatus;
  published_item_id: string | null;
  user_edited: number;
  created_at: number;
  updated_at: number;
}

export class SharedDraftRepository {
  constructor(private readonly database: DatabasePort) {}

  create(input: {
    kind: SharedItemKind;
    sessionId: string | null;
    reviewId?: string | null;
    remoteRequirementId: string;
    agentId: string | null;
    title: string;
    content: SharedItemContent;
    userEdited?: boolean;
    now?: number;
  }): SharedDraftRecord {
    const id = randomUUID();
    const now = input.now ?? Date.now();
    this.database
      .prepare(
        [
          "INSERT INTO shared_drafts (id, kind, session_id, review_id, remote_requirement_id, agent_id, title, content_json, status, user_edited, created_at, updated_at)",
          "VALUES (@id, @kind, @sessionId, @reviewId, @remoteRequirementId, @agentId, @title, @content, 'draft', @userEdited, @now, @now)",
        ].join(" "),
      )
      .run({
        id,
        kind: input.kind,
        sessionId: input.sessionId,
        reviewId: input.reviewId ?? null,
        remoteRequirementId: input.remoteRequirementId,
        agentId: input.agentId,
        title: input.title,
        content: serializeJson(input.content as never),
        userEdited: input.userEdited === true ? 1 : 0,
        now,
      });
    return this.require(id);
  }

  getById(id: string): SharedDraftRecord | null {
    const row = this.database.prepare("SELECT * FROM shared_drafts WHERE id = @id").get<Row>({ id });
    return row ? map(row) : null;
  }

  listBySession(sessionId: string): SharedDraftRecord[] {
    return this.database.prepare("SELECT * FROM shared_drafts WHERE session_id = @sessionId ORDER BY created_at ASC").all<Row>({ sessionId }).map(map);
  }

  /** 从这次评审生成的草稿（最近的在前）：评审卡据此显示「已发布」。 */
  listByReview(reviewId: string): SharedDraftRecord[] {
    return this.database.prepare("SELECT * FROM shared_drafts WHERE review_id = @reviewId ORDER BY created_at DESC").all<Row>({ reviewId }).map(map);
  }

  update(id: string, patch: Partial<Pick<SharedDraftRecord, "title" | "content" | "status" | "publishedItemId" | "userEdited">>, now = Date.now()): SharedDraftRecord {
    const current = this.require(id);
    const next = { ...current, ...patch };
    this.database
      .prepare(
        "UPDATE shared_drafts SET title = @title, content_json = @content, status = @status, published_item_id = @publishedItemId, user_edited = @userEdited, updated_at = @now WHERE id = @id",
      )
      // 同一毫秒里连改两次时也让 updated_at 变（发布对话框按它判断预览之后内容有没有变）。
      .run({ id, title: next.title, content: serializeJson(next.content as never), status: next.status, publishedItemId: next.publishedItemId, userEdited: next.userEdited ? 1 : 0, now: Math.max(now, current.updatedAt + 1) });
    return this.require(id);
  }

  private require(id: string): SharedDraftRecord {
    const record = this.getById(id);
    if (record === null) throw new Error("shared draft was not persisted: " + id);
    return record;
  }
}

function map(row: Row): SharedDraftRecord {
  return {
    id: row.id,
    kind: row.kind,
    sessionId: row.session_id,
    reviewId: row.review_id,
    remoteRequirementId: row.remote_requirement_id,
    agentId: row.agent_id,
    title: row.title,
    content: parseJson(row.content_json) as unknown as SharedItemContent,
    status: row.status,
    publishedItemId: row.published_item_id,
    userEdited: row.user_edited === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
