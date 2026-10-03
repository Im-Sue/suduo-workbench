import type { UserSummaryDto } from "./auth.js";
import type {
  RequirementsCursorPage,
  RequirementsCursorQuery,
} from "./pagination.js";
import type { RequirementStatus } from "./status.js";

export interface CommentDto {
  id: string;
  requirementId: string;
  artifactVersionId: string | null;
  body: string;
  author: UserSummaryDto;
  createdAt: string;
}

export interface CreateCommentRequest {
  body: string;
}

export type ListCommentsQuery = RequirementsCursorQuery;
export type ListCommentsResponse = RequirementsCursorPage<CommentDto>;

export const AUDIT_RESOURCE_TYPES = [
  "project",
  "requirement",
  "comment",
  "attachment",
  "artifact_version",
  /** 聊天房间（项目聊天房间与共享 Agent）：只属于项目，需求房间另记所属需求。 */
  "room",
  /** Agent 共享到房间的开关记录。 */
  "agent_share",
] as const;

export type AuditResourceType = (typeof AUDIT_RESOURCE_TYPES)[number];

export const AUDIT_ACTIONS = [
  "project.created",
  "project.updated",
  "project.archived",
  "project.restored",
  "requirement.created",
  "requirement.updated",
  "requirement.status_changed",
  "comment.created",
  "attachment.created",
  "attachment.downloaded",
  "attachment.deleted",
  "artifact_version.published",
] as const;

export type AuditAction = (typeof AUDIT_ACTIONS)[number];

/**
 * 需求负责人变更的审计动作，before / after 为 `{ assignee: UserSummaryDto | null }`。
 *
 * 暂不并入 `AUDIT_ACTIONS`：现有界面用 `Record<AuditAction, string>` 做穷举文案表，
 * 并入会让旧界面编译失败。过渡期内 `/v2/audit` 只返回 `AUDIT_ACTIONS` 中的动作，
 * 负责人变更只出现在需求活动时间线（`/v2/requirements/:id/activity`）。
 * 前端补齐文案后，把它并入 `AUDIT_ACTIONS` 并去掉 `/v2/audit` 的动作过滤即可。
 */
export const REQUIREMENT_ASSIGNEE_CHANGED_ACTION = "requirement.assignee_changed";

/**
 * 房间与共享的审计动作（需求 suduo-v2-rooms-shared-agent-001）。
 *
 * 同 `REQUIREMENT_ASSIGNEE_CHANGED_ACTION`，暂不并入 `AUDIT_ACTIONS`（前端穷举文案表），
 * `/v2/audit` 过渡期内不返回它们。`agent_share.opened` 也用于「再开 = 改时长」（before 为改前的到期时间）；
 * 到期由服务端自动关闭，记在共享行的 closed_reason=expired，不写审计（没有操作人）。
 */
export const ROOM_AUDIT_ACTIONS = [
  "room.created",
  "room.renamed",
  "room.archived",
  "room.restored",
  "agent_share.opened",
  "agent_share.closed",
] as const;

export type RoomAuditAction = (typeof ROOM_AUDIT_ACTIONS)[number];

/** 服务端实际写入审计表的全部动作。 */
export const RECORDED_AUDIT_ACTIONS = [
  ...AUDIT_ACTIONS,
  REQUIREMENT_ASSIGNEE_CHANGED_ACTION,
  ...ROOM_AUDIT_ACTIONS,
] as const;

export type RecordedAuditAction = (typeof RECORDED_AUDIT_ACTIONS)[number];

export interface AuditEntryDto {
  id: string;
  actor: UserSummaryDto;
  resourceType: AuditResourceType;
  resourceId: string;
  action: AuditAction;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  createdAt: string;
}

export interface ListAuditQuery extends RequirementsCursorQuery {
  resourceType?: AuditResourceType;
  resourceId?: string;
  projectId?: string;
}

export type ListAuditResponse = RequirementsCursorPage<AuditEntryDto>;

export interface AttachmentDto {
  id: string;
  requirementId: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  sha256: string;
  uploadedBy: UserSummaryDto;
  createdAt: string;
}

export interface ListAttachmentsResponse {
  items: AttachmentDto[];
  requirementVersion: number;
}

/** 附件增删完成后，返回附件及操作完成时的当前正文版本。 */
export interface AttachmentMutationResponse {
  attachment: AttachmentDto;
  requirementVersion: number;
}

export interface CreateAttachmentMetadata {
  fileName: string;
  contentType: string;
  sizeBytes: number;
}

export const REQUIREMENTS_EVENT_TYPES = [
  "project.changed",
  "requirement.changed",
  "comment.created",
  "attachment.changed",
  "artifact.published",
] as const;

export type RequirementsEventType =
  (typeof REQUIREMENTS_EVENT_TYPES)[number];

export interface RequirementsEventDto {
  id: string;
  type: RequirementsEventType;
  projectId: string;
  requirementId?: string;
  /**
   * 事件发生时需求的正文版本。`requirement.changed` 可能携带未变化的版本（例如只改负责人，
   * 负责人是元数据、不递增正文版本），消费方不得按版本去重。
   */
  requirementVersion?: number;
  occurredAt: string;
}

export interface RequirementStatusChangeSummary {
  from: RequirementStatus;
  to: RequirementStatus;
}
