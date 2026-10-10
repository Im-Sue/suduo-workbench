import type {
  ListSharedItemsResponse,
  ProjectAiRulesDto,
  ProjectAiRulesVersionDetailDto,
  PublishSharedItemRequest,
  SharedItemDetailDto,
} from "@suduo/cloud-contracts";
import type {
  AttachmentDto,
  AuditEntryDto,
  CommentDto,
  CommentFileDto,
  CreateCommentRequest,
  ListAttachmentsResponse,
  ListAuditQuery,
  ListAuditResponse,
  ListCommentsResponse,
  ListRequirementActivityResponse,
  ProjectDto,
  RequirementActivityEntryDto,
  RequirementDetailDto,
  UserSummaryDto,
} from "@suduo/cloud-contracts";
import { ApiError } from "../../src/application/api-error.js";
import type { RequirementToolsRemote } from "../../src/application/session-tools/requirement-tools.js";
import type { SessionContextRemote } from "../../src/application/session-tools/session-context.js";

/**
 * 会话工具测试用的假远程需求服务：数据全在内存里，不连网络。
 * - `fail[方法名]` 设了错误时该方法直接抛出（模拟远程失败）；
 * - `calls` 记录每次调用，便于断言「远程有没有被调用」。
 */
type RemoteMethod = keyof RequirementToolsRemote | keyof SessionContextRemote | "getSharedItem" | "publishSharedItem" | "getProjectAiRulesVersion";

export const PM: UserSummaryDto = { id: "user-pm", displayName: "李娜" };
export const DEV: UserSummaryDto = { id: "user-dev", displayName: "陈思远" };

export function requirementFixture(overrides: Partial<RequirementDetailDto> = {}): RequirementDetailDto {
  return {
    id: "req-1",
    projectId: "proj-1",
    number: 1,
    title: "商家端-订单详情优化",
    summary: "订单详情弹窗增加客户收货信息。",
    status: "draft",
    assignee: DEV,
    commentCount: 1,
    attachmentCount: 1,
    createdBy: PM,
    updatedBy: PM,
    createdAt: "2026-09-20T02:00:00.000Z",
    updatedAt: "2026-09-29T02:00:00.000Z",
    version: 3,
    project: { id: "proj-1", name: "商家端", isArchived: false, version: 1 },
    ...overrides,
  };
}

export function attachmentFixture(overrides: Partial<AttachmentDto> & Pick<AttachmentDto, "id" | "fileName" | "contentType">): AttachmentDto {
  return {
    requirementId: "req-1",
    sizeBytes: 100,
    sha256: "0".repeat(64),
    uploadedBy: PM,
    createdAt: "2026-09-21T02:00:00.000Z",
    ...overrides,
  };
}

export function commentFixture(index: number, overrides: Partial<CommentDto> = {}): CommentDto {
  return {
    id: "comment-" + String(index),
    requirementId: "req-1",
    artifactVersionId: null,
    body: "第 " + String(index) + " 条评论",
    author: PM,
    createdAt: new Date(Date.UTC(2026, 8, 21, 2, index)).toISOString(),
    ...overrides,
  };
}

export function activityFixture(
  id: string,
  createdAt: string,
  overrides: Partial<RequirementActivityEntryDto> = {},
): RequirementActivityEntryDto {
  return {
    id,
    requirementId: "req-1",
    actor: PM,
    action: "requirement.status_changed",
    resourceType: "requirement",
    resourceId: "req-1",
    createdAt,
    changes: [{ field: "status", from: "draft", to: "in_refinement" }],
    comment: null,
    attachment: null,
    artifactVersion: null,
    ...overrides,
  };
}

export class FakeRequirementsRemote implements RequirementToolsRemote, SessionContextRemote {
  readonly requirements = new Map<string, RequirementDetailDto>();
  readonly comments = new Map<string, CommentDto[]>();
  readonly attachments = new Map<string, AttachmentDto[]>();
  readonly attachmentContent = new Map<string, Buffer>();
  /** 评论文件（按编号）与内容。 */
  readonly commentFiles = new Map<string, CommentFileDto>();
  readonly commentFileContent = new Map<string, Buffer>();
  /** 活动时间线，最新在前（与远程接口一致）。 */
  readonly activity = new Map<string, RequirementActivityEntryDto[]>();
  /** 需求共享对象（多 Agent 协作 S11），新的在前。 */
  readonly sharedItems: SharedItemDetailDto[] = [];
  /** 项目 AI 规范（S11）；null = 从没写过。 */
  aiRules: { version: number; content: string } | null = null;
  /** 历史版本的内容（按版本取）；没有的取 aiRules 里同版本的。 */
  readonly aiRuleVersions = new Map<number, string>();
  audit: AuditEntryDto[] = [];
  project: ProjectDto = {
    id: "proj-1",
    name: "商家端",
    isArchived: false,
    createdBy: PM,
    updatedBy: PM,
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    version: 1,
  };
  readonly fail: Partial<Record<RemoteMethod, unknown>> = {};
  readonly calls: Array<{ method: RemoteMethod; args: unknown[] }> = [];
  private sequence = 0;

  constructor(requirement: RequirementDetailDto = requirementFixture()) {
    this.requirements.set(requirement.id, requirement);
  }

  callsOf(method: RemoteMethod): unknown[][] {
    return this.calls.filter((call) => call.method === method).map((call) => call.args);
  }

  private enter(method: RemoteMethod, args: unknown[]): void {
    this.calls.push({ method, args });
    if (method in this.fail) {
      throw this.fail[method];
    }
  }

  async getRequirement(requirementId: string): Promise<RequirementDetailDto> {
    this.enter("getRequirement", [requirementId]);
    const requirement = this.requirements.get(requirementId);
    if (!requirement) {
      throw new Error("requirement not found: " + requirementId);
    }
    return requirement;
  }

  async getRequirementByNumber(projectId: string, number: number): Promise<RequirementDetailDto> {
    this.enter("getRequirementByNumber", [projectId, number]);
    const requirement = [...this.requirements.values()].find(
      (item) => item.projectId === projectId && item.number === number,
    );
    if (!requirement) {
      throw new Error("requirement not found: " + String(number));
    }
    return requirement;
  }

  async getProject(projectId: string): Promise<ProjectDto> {
    this.enter("getProject", [projectId]);
    return this.project;
  }

  async listComments(
    requirementId: string,
    query: Record<string, string | undefined>,
  ): Promise<ListCommentsResponse> {
    this.enter("listComments", [requirementId, query]);
    return paginate(this.comments.get(requirementId) ?? [], query);
  }

  async getProjectAiRules(projectId: string): Promise<ProjectAiRulesDto> {
    this.enter("getProjectAiRules", [projectId]);
    return this.aiRules === null
      ? { projectId, version: 0, content: "", updatedBy: null, updatedAt: null }
      : { projectId, version: this.aiRules.version, content: this.aiRules.content, updatedBy: PM, updatedAt: "2026-10-09T01:00:00.000Z" };
  }

  async getProjectAiRulesVersion(projectId: string, version: number): Promise<ProjectAiRulesVersionDetailDto> {
    this.enter("getProjectAiRulesVersion", [projectId, version]);
    const content = this.aiRuleVersions.get(version) ?? (this.aiRules?.version === version ? this.aiRules.content : undefined);
    if (content === undefined) throw new ApiError(404, "NOT_FOUND", (t) => t.sharedDraft.rulesUnavailable);
    return { version, sizeBytes: Buffer.byteLength(content), updatedBy: PM, updatedAt: "2026-10-09T01:00:00.000Z", content };
  }

  async listSharedItems(requirementId: string): Promise<ListSharedItemsResponse> {
    this.enter("listSharedItems", [requirementId]);
    // 列表不带内容（同云端）。
    return {
      items: this.sharedItems
        .filter((item) => item.requirementId === requirementId)
        .map((item) => Object.fromEntries(Object.entries(item).filter(([key]) => key !== "content")) as Omit<SharedItemDetailDto, "content">),
    };
  }

  async getSharedItem(itemId: string): Promise<SharedItemDetailDto> {
    this.enter("getSharedItem", [itemId]);
    const item = this.sharedItems.find((entry) => entry.id === itemId);
    if (item === undefined) throw new ApiError(404, "NOT_FOUND", "Shared item not found");
    return item;
  }

  async publishSharedItem(requirementId: string, input: PublishSharedItemRequest): Promise<SharedItemDetailDto> {
    this.enter("publishSharedItem", [requirementId, input]);
    const item: SharedItemDetailDto = {
      id: `item-${String(this.sharedItems.length + 1)}`,
      requirementId,
      kind: input.kind,
      title: input.title,
      source: { agentId: input.agentId ?? null, sessionRef: input.sessionRef ?? null },
      publishedBy: DEV,
      publishedAt: "2026-10-09T02:00:00.000Z",
      sizeBytes: JSON.stringify(input.content).length,
      retractedAt: null,
      retractedBy: null,
      readCount: 0,
      content: input.content,
    };
    this.sharedItems.unshift(item);
    return item;
  }

  async listAttachments(requirementId: string): Promise<ListAttachmentsResponse> {
    this.enter("listAttachments", [requirementId]);
    return { items: this.attachments.get(requirementId) ?? [], requirementVersion: 3 };
  }

  async downloadAttachment(attachmentId: string, signal: AbortSignal): Promise<Response> {
    void signal;
    this.enter("downloadAttachment", [attachmentId]);
    const content = this.attachmentContent.get(attachmentId);
    if (!content) {
      throw new Error("attachment content missing: " + attachmentId);
    }
    return new Response(new Uint8Array(content));
  }

  async getCommentFile(fileId: string): Promise<CommentFileDto> {
    this.enter("getCommentFile", [fileId]);
    const file = this.commentFiles.get(fileId);
    if (!file) {
      throw new ApiError(404, "NOT_FOUND", "comment file not found");
    }
    return file;
  }

  async downloadCommentFile(
    fileId: string,
    options: { disposition?: "inline" | "attachment"; signal: AbortSignal },
  ): Promise<Response> {
    this.enter("downloadCommentFile", [fileId, options.disposition ?? null]);
    const content = this.commentFileContent.get(fileId);
    if (!content) {
      throw new Error("comment file content missing: " + fileId);
    }
    return new Response(new Uint8Array(content));
  }

  async listRequirementActivity(
    requirementId: string,
    query: Record<string, string | undefined>,
  ): Promise<ListRequirementActivityResponse> {
    this.enter("listRequirementActivity", [requirementId, query]);
    return paginate(this.activity.get(requirementId) ?? [], query);
  }

  async listAudit(query: ListAuditQuery): Promise<ListAuditResponse> {
    this.enter("listAudit", [query]);
    return { items: this.audit.slice(0, query.limit ?? 50), nextCursor: null };
  }

  async createComment(requirementId: string, input: CreateCommentRequest): Promise<CommentDto> {
    this.enter("createComment", [requirementId, input]);
    this.sequence += 1;
    return {
      id: "comment-new-" + String(this.sequence),
      requirementId,
      artifactVersionId: null,
      body: input.body ?? "",
      author: DEV,
      createdAt: "2026-09-30T06:00:00.000Z",
    };
  }

}

/** 远程分页的最小实现：cursor 是起始下标，limit 默认 50。 */
function paginate<T>(items: T[], query: Record<string, string | undefined>): { items: T[]; nextCursor: string | null } {
  const start = query["cursor"] === undefined ? 0 : Number(query["cursor"]);
  const limit = query["limit"] === undefined ? 50 : Number(query["limit"]);
  const page = items.slice(start, start + limit);
  const next = start + limit;
  return { items: page, nextCursor: next < items.length ? String(next) : null };
}
