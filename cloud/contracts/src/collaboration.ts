import type { UserSummaryDto } from "./auth.js";
import type { RoomFileKind } from "./rooms.js";
import type {
  RequirementsCursorPage,
  RequirementsCursorQuery,
} from "./pagination.js";
import type { RequirementStatus } from "./status.js";

/** artifact_published：发布确认版时没写说明，系统代写的那条评论。 */
export interface ArtifactPublishedCommentParams {
  versionNumber: number;
  fileCount: number;
}

/** comment_files：只带文件、没写文字的评论。正文存一句英文兜底（列出文件名），新客户端只显示文件。 */
export interface CommentFilesCommentParams {
  fileCount: number;
}

/**
 * 系统代写评论的类型 + 参数：前端按它用自己的语言渲染，正文 body 只作兜底（中英双语技术设计 §4.3）。
 * 以后加类型就往这个联合里加。
 */
export type CommentSystemContent =
  | { kind: "artifact_published"; params: ArtifactPublishedCommentParams }
  | { kind: "comment_files"; params: CommentFilesCommentParams };

/**
 * 评论里的文件（需求附件评论文件与优先级 4.2）：只属于这条评论，不进附件区、不占附件额度。
 * 先上传（commentId 为 null），发评论时带上编号挂到评论上；之后不能删、不能改挂。
 */
export interface CommentFileDto {
  id: string;
  requirementId: string;
  /** 还没随评论发出时为 null。 */
  commentId: string | null;
  fileName: string;
  contentType: string;
  /** 决定显示成缩略图（image）、视频（video）还是文件卡（file）。 */
  kind: RoomFileKind;
  sizeBytes: number;
  sha256: string;
  uploadedBy: UserSummaryDto;
  createdAt: string;
}

export interface CommentDto {
  id: string;
  requirementId: string;
  artifactVersionId: string | null;
  body: string;
  author: UserSummaryDto;
  createdAt: string;
  /** 系统代写的评论才有，前端按它渲染；用户写的评论没有这个字段。 */
  system?: CommentSystemContent;
  /** 评论带的文件，按发送时的顺序。较早的需求服务不返回（按没有文件处理）。 */
  files?: CommentFileDto[];
}

/** 正文与文件至少有一样；只带文件时正文可省略。 */
export interface CreateCommentRequest {
  body?: string;
  /** 先经 `POST /v2/requirements/:id/comment-files` 上传得到的编号，至多 `REQUIREMENT_COMMENT_MAX_FILES` 个。 */
  fileIds?: string[];
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
  /** 需求共享对象（交接包、评审报告、会话快照）的发布与撤回（多 Agent 协作）。 */
  "shared_item",
  /** 项目 AI 规范的保存：只属于项目。 */
  "ai_rules",
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
 * 需求优先级变更的审计动作，before / after 为 `{ priority: RequirementPriority | null }`。
 * 同 `REQUIREMENT_ASSIGNEE_CHANGED_ACTION`，暂不并入 `AUDIT_ACTIONS`，只出现在需求活动时间线。
 */
export const REQUIREMENT_PRIORITY_CHANGED_ACTION = "requirement.priority_changed";

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

/**
 * 多 Agent 协作的审计动作：共享对象发布 / 撤回、项目 AI 规范保存。同房间动作，暂不并入 `AUDIT_ACTIONS`，
 * `/v2/audit` 过渡期内不返回；界面从共享对象与规范版本列表看到谁何时做了什么。
 */
export const AI_COLLAB_AUDIT_ACTIONS = ["shared_item.published", "shared_item.retracted", "ai_rules.updated"] as const;

export type AiCollabAuditAction = (typeof AI_COLLAB_AUDIT_ACTIONS)[number];

/** 服务端实际写入审计表的全部动作。 */
export const RECORDED_AUDIT_ACTIONS = [
  ...AUDIT_ACTIONS,
  REQUIREMENT_ASSIGNEE_CHANGED_ACTION,
  REQUIREMENT_PRIORITY_CHANGED_ACTION,
  ...ROOM_AUDIT_ACTIONS,
  ...AI_COLLAB_AUDIT_ACTIONS,
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
  /** 需求共享对象发布或撤回（带 requirementId）。 */
  "shared_item.changed",
  /** 需求的协作记录有新增或更新（带 requirementId）。 */
  "ai_activity.changed",
  /** 项目 AI 规范有新版本（只带 projectId）。 */
  "ai_rules.changed",
] as const;

export type RequirementsEventType =
  (typeof REQUIREMENTS_EVENT_TYPES)[number];

export interface RequirementsEventDto {
  id: string;
  type: RequirementsEventType;
  projectId: string;
  requirementId?: string;
  /**
   * 事件发生时需求的正文版本。`requirement.changed` 可能携带未变化的版本（例如只改负责人或优先级，
   * 二者是元数据、不递增正文版本），消费方不得按版本去重。
   */
  requirementVersion?: number;
  occurredAt: string;
}

export interface RequirementStatusChangeSummary {
  from: RequirementStatus;
  to: RequirementStatus;
}
