import type { UserSummaryDto } from "./auth.js";
import type { AuditResourceType, RecordedAuditAction } from "./collaboration.js";
import type {
  RequirementsCursorPage,
  RequirementsCursorQuery,
} from "./pagination.js";
import type { RequirementStatus } from "./status.js";

/**
 * 需求活动时间线收录的审计动作。`attachment.downloaded` 是只读行为，不进时间线；
 * 产物发布自动生成的说明评论并入 `artifact_version.published`，不单独成条。
 */
export const REQUIREMENT_ACTIVITY_ACTIONS = [
  "requirement.created",
  "requirement.updated",
  "requirement.status_changed",
  "requirement.assignee_changed",
  "comment.created",
  "attachment.created",
  "attachment.deleted",
  "artifact_version.published",
] as const satisfies readonly RecordedAuditAction[];

export type RequirementActivityAction =
  (typeof REQUIREMENT_ACTIVITY_ACTIONS)[number];

/** 需求字段的一次前后变化，供时间线直接渲染"把 X 从 A 改成 B"。 */
export type RequirementActivityChangeDto =
  | { field: "title"; from: string; to: string }
  | { field: "summary"; from: string; to: string }
  | { field: "status"; from: RequirementStatus; to: RequirementStatus }
  | {
      field: "assignee";
      from: UserSummaryDto | null;
      to: UserSummaryDto | null;
    };

export interface RequirementActivityCommentDto {
  id: string;
  body: string;
}

export interface RequirementActivityAttachmentDto {
  id: string;
  fileName: string;
}

export interface RequirementActivityArtifactVersionDto {
  id: string;
  versionNumber: number;
  fileCount: number;
  /** 发布说明；发布时未填写说明则为 null。 */
  note: string | null;
}

export interface RequirementActivityEntryDto {
  /** 审计记录 id，可作为时间线条目的稳定 key。 */
  id: string;
  requirementId: string;
  actor: UserSummaryDto;
  action: RequirementActivityAction;
  resourceType: AuditResourceType;
  resourceId: string;
  // 不带审计原始前后值（before / after）：时间线只渲染下面几项，原始值按需走 `/v2/audit`。
  createdAt: string;
  /** `requirement.updated` / `status_changed` / `assignee_changed` 的字段变化；其余为空数组。 */
  changes: RequirementActivityChangeDto[];
  /** `comment.created` 时为评论正文；其余为 null。 */
  comment: RequirementActivityCommentDto | null;
  /** `attachment.created` / `attachment.deleted` 时为附件；其余为 null。 */
  attachment: RequirementActivityAttachmentDto | null;
  /** `artifact_version.published` 时为产物版本；其余为 null。 */
  artifactVersion: RequirementActivityArtifactVersionDto | null;
}

/** 游标分页，最新在前。 */
export type ListRequirementActivityQuery = RequirementsCursorQuery;

export type ListRequirementActivityResponse =
  RequirementsCursorPage<RequirementActivityEntryDto>;
