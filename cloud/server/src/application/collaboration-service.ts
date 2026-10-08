import type {
  MarkRequirementReadRequest,
  AuditResourceType,
  CreateCommentRequest,
  CreateProjectRequest,
  CreateRequirementRequest,
  ListAuditQuery,
  ListProjectsQuery,
  ListRequirementsByIdsQuery,
  ListRequirementsQuery,
  ProjectStatsQuery,
  RequirementsCursorQuery,
  UpdateProjectRequest,
  UpdateRequirementRequest,
} from "@suduo/cloud-contracts";
import {
  REQUIREMENT_ASSIGNEE_FILTER_ME,
  REQUIREMENT_ASSIGNEE_FILTER_NONE,
  REQUIREMENT_COMMENT_MAX_FILES,
  parseRequirementPriorityFilter,
} from "@suduo/cloud-contracts";
import type {
  CollaborationRepository,
  RequirementAssigneeCondition,
} from "../infrastructure/collaboration-repository.js";
import { pageLimit } from "./cursor.js";
import { ApplicationError } from "./errors.js";


/** 已读位置只收带时区的 ISO 时间（Date.parse 太宽松：「1」「Sep 29 2026」也能过，超大年份会让数据库报错）。 */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/u;
export class CollaborationService {
  constructor(private readonly repository: CollaborationRepository) {}

  createProject(actorId: string, request: CreateProjectRequest) {
    return this.repository.createProject(actorId, nonBlank(request.name, "Project name"));
  }

  listProjects(query: ListProjectsQuery) {
    return this.repository.listProjects({
      includeArchived: query.includeArchived ?? false,
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      limit: pageLimit(query.limit),
    });
  }

  getProject(projectId: string) {
    return this.repository.getProject(projectId);
  }

  updateProject(actorId: string, projectId: string, request: UpdateProjectRequest) {
    return this.repository.updateProject({
      actorId,
      projectId,
      ...(request.name === undefined
        ? {}
        : { name: nonBlank(request.name, "Project name") }),
      ...(request.isArchived === undefined
        ? {}
        : { isArchived: request.isArchived }),
    });
  }

  createRequirement(
    actorId: string,
    projectId: string,
    request: CreateRequirementRequest,
  ) {
    return this.repository.createRequirement({
      actorId,
      projectId,
      title: nonBlank(request.title, "Requirement title"),
      summary: request.summary?.trim() ?? "",
      status: request.status ?? "draft",
      assigneeId: request.assigneeId ?? null,
      priority: request.priority ?? null,
    });
  }

  listRequirements(actorId: string, projectId: string, query: ListRequirementsQuery) {
    return this.repository.listRequirements({
      projectId,
      ...(query.status === undefined ? {} : { status: query.status }),
      ...(query.search === undefined
        ? {}
        : { search: nonBlank(query.search, "Search term") }),
      ...(query.assignee === undefined
        ? {}
        : { assignee: assigneeCondition(actorId, query.assignee) }),
      ...(query.creator === undefined
        ? {}
        : { creatorId: query.creator === REQUIREMENT_ASSIGNEE_FILTER_ME ? actorId : query.creator }),
      ...(query.priority === undefined ? {} : { priorities: priorityFilter(query.priority) }),
      ...(query.sort === undefined ? {} : { sort: query.sort }),
      readerId: actorId,
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      limit: pageLimit(query.limit),
    });
  }

  markRequirementRead(actorId: string, requirementId: string, request: MarkRequirementReadRequest | null | undefined) {
    const upTo = request?.upTo;
    if (upTo !== undefined && (typeof upTo !== "string" || !ISO_INSTANT.test(upTo) || Number.isNaN(Date.parse(upTo)))) {
      throw new ApplicationError(400, "VALIDATION_ERROR", "upTo must be an ISO timestamp");
    }
    return this.repository.markRequirementRead({
      userId: actorId,
      requirementId,
      ...(upTo === undefined ? {} : { upTo: new Date(upTo).toISOString() }),
    });
  }

  getRequirementByNumber(projectId: string, number: number) {
    return this.repository.getRequirementByNumber(projectId, number);
  }

  async listUsers() {
    return { items: await this.repository.listUsers() };
  }

  listRequirementActivity(requirementId: string, query: RequirementsCursorQuery) {
    return this.repository.listRequirementActivity({
      requirementId,
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      limit: pageLimit(query.limit),
    });
  }

  async listRequirementsByIds(query: ListRequirementsByIdsQuery) {
    return { items: await this.repository.listRequirementsByIds(requirementIds(query.ids)) };
  }

  getProjectStats(projectId: string, query: ProjectStatsQuery) {
    return this.repository.getProjectStats({
      projectId,
      window: query.window,
      timeZone: ianaTimeZone(query.tz),
    });
  }

  getRequirement(requirementId: string) {
    return this.repository.getRequirementDetail(requirementId);
  }

  updateRequirement(
    actorId: string,
    requirementId: string,
    request: UpdateRequirementRequest,
  ) {
    return this.repository.updateRequirement({
      actorId,
      requirementId,
      ...(request.title === undefined
        ? {}
        : { title: nonBlank(request.title, "Requirement title") }),
      ...(request.summary === undefined
        ? {}
        : { summary: request.summary.trim() }),
      ...(request.status === undefined ? {} : { status: request.status }),
      ...(request.assigneeId === undefined ? {} : { assigneeId: request.assigneeId }),
      ...(request.priority === undefined ? {} : { priority: request.priority }),
    });
  }

  createComment(
    actorId: string,
    requirementId: string,
    request: CreateCommentRequest,
  ) {
    // 正文与文件至少有一样；只带文件时正文可以为空（需求附件评论文件与优先级 R6）。
    const body = (request.body ?? "").trim();
    const fileIds = [...new Set(request.fileIds ?? [])];
    if (body === "" && fileIds.length === 0) {
      throw new ApplicationError(400, "VALIDATION_ERROR", "Comment must not be empty");
    }
    if (fileIds.length > REQUIREMENT_COMMENT_MAX_FILES) {
      throw new ApplicationError(400, "VALIDATION_ERROR", `A comment can include at most ${String(REQUIREMENT_COMMENT_MAX_FILES)} files`);
    }
    return this.repository.createComment({ actorId, requirementId, body, fileIds });
  }

  listComments(requirementId: string, query: RequirementsCursorQuery) {
    return this.repository.listComments({
      requirementId,
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      limit: pageLimit(query.limit),
    });
  }

  listAudit(query: ListAuditQuery) {
    return this.repository.listAudit({
      ...optionalResource(query.resourceType, query.resourceId),
      ...(query.projectId === undefined ? {} : { projectId: query.projectId }),
      ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
      limit: pageLimit(query.limit),
    });
  }
}

function nonBlank(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new ApplicationError(400, "VALIDATION_ERROR", `${label} must not be empty`);
  }
  return normalized;
}

function assigneeCondition(
  actorId: string,
  assignee: string,
): RequirementAssigneeCondition {
  if (assignee === REQUIREMENT_ASSIGNEE_FILTER_NONE) return { kind: "none" };
  if (assignee === REQUIREMENT_ASSIGNEE_FILTER_ME) return { kind: "user", userId: actorId };
  if (!UUID.test(assignee)) {
    throw new ApplicationError(400, "VALIDATION_ERROR", "assignee must be a user ID, me, or none");
  }
  return { kind: "user", userId: assignee };
}

function priorityFilter(value: string) {
  const priorities = parseRequirementPriorityFilter(value);
  if (priorities === null) {
    throw new ApplicationError(400, "VALIDATION_ERROR", "priority must be comma-separated values of urgent, high, medium, low, or none");
  }
  return priorities;
}

function optionalResource(
  resourceType: AuditResourceType | undefined,
  resourceId: string | undefined,
): { resourceType?: AuditResourceType; resourceId?: string } {
  return {
    ...(resourceType === undefined ? {} : { resourceType }),
    ...(resourceId === undefined ? {} : { resourceId }),
  };
}

function requirementIds(value: string): string[] {
  const ids = value.split(",");
  if (ids.length > 100) {
    throw new ApplicationError(400, "VALIDATION_ERROR", "ids can include at most 100 requirement IDs");
  }
  if (ids.some((id) => !UUID.test(id))) {
    throw new ApplicationError(400, "VALIDATION_ERROR", "ids must be comma-separated UUIDs");
  }
  return [...new Set(ids)];
}

function ianaTimeZone(value: string): string {
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: value })
      .resolvedOptions().timeZone;
  } catch {
    throw new ApplicationError(400, "VALIDATION_ERROR", "tz must be a valid IANA time zone name");
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
