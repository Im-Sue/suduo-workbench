import type {
  ArtifactVersionDetailDto,
  AttachmentDto,
  AttachmentMutationResponse,
  AuditEntryDto,
  CommentDto,
  CreateCommentRequest,
  ListArtifactVersionsResponse,
  ListAttachmentsResponse,
  ListAuditQuery,
  ListAuditResponse,
  ListCommentsResponse,
  ListRequirementActivityResponse,
  ProjectDto,
  PublishArtifactVersionRequest,
  RequirementActivityEntryDto,
  RequirementDetailDto,
  UserSummaryDto,
} from "@suduo/cloud-contracts";
import type { RequirementToolsRemote } from "../../src/application/session-tools/requirement-tools.js";
import type { SessionContextRemote } from "../../src/application/session-tools/session-context.js";

/**
 * 会话工具测试用的假远程需求服务：数据全在内存里，不连网络。
 * - `fail[方法名]` 设了错误时该方法直接抛出（模拟远程失败）；
 * - `calls` 记录每次调用，便于断言「远程有没有被调用」。
 */
type RemoteMethod = keyof RequirementToolsRemote | keyof SessionContextRemote;

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
  readonly versions = new Map<string, ArtifactVersionDetailDto[]>();
  readonly versionFileContent = new Map<string, Buffer>();
  /** 活动时间线，最新在前（与远程接口一致）。 */
  readonly activity = new Map<string, RequirementActivityEntryDto[]>();
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
  /** 上传附件时收到的 multipart 正文（按调用顺序）。 */
  readonly uploads: Array<{ requirementId: string; contentType: string; body: string }> = [];
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

  async listArtifactVersions(requirementId: string): Promise<ListArtifactVersionsResponse> {
    this.enter("listArtifactVersions", [requirementId]);
    return {
      items: (this.versions.get(requirementId) ?? []).map((version) => {
        const { files, ...summary } = version;
        void files;
        return summary;
      }),
    };
  }

  async getArtifactVersion(versionId: string): Promise<ArtifactVersionDetailDto> {
    this.enter("getArtifactVersion", [versionId]);
    for (const list of this.versions.values()) {
      const found = list.find((version) => version.id === versionId);
      if (found) {
        return found;
      }
    }
    throw new Error("version not found: " + versionId);
  }

  async downloadArtifactVersionFile(versionId: string, fileId: string, signal: AbortSignal): Promise<Response> {
    void signal;
    this.enter("downloadArtifactVersionFile", [versionId, fileId]);
    const content = this.versionFileContent.get(fileId);
    if (!content) {
      throw new Error("version file missing: " + fileId);
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
      body: input.body,
      author: DEV,
      createdAt: "2026-09-30T06:00:00.000Z",
    };
  }

  async uploadAttachment(input: {
    requirementId: string;
    body: AsyncIterable<Uint8Array>;
    contentType: string;
    contentLength?: string;
    attachmentSize?: string;
    idempotencyKey: string;
    signal: AbortSignal;
  }): Promise<AttachmentMutationResponse> {
    this.enter("uploadAttachment", [{ requirementId: input.requirementId, attachmentSize: input.attachmentSize }]);
    const chunks: Buffer[] = [];
    for await (const chunk of input.body) {
      chunks.push(Buffer.from(chunk));
    }
    this.uploads.push({
      requirementId: input.requirementId,
      contentType: input.contentType,
      body: Buffer.concat(chunks).toString("utf8"),
    });
    this.sequence += 1;
    return {
      attachment: attachmentFixture({
        id: "att-uploaded-" + String(this.sequence),
        fileName: "uploaded",
        contentType: "application/octet-stream",
        requirementId: input.requirementId,
      }),
      requirementVersion: 3,
    };
  }

  async publishArtifactVersion(
    requirementId: string,
    input: PublishArtifactVersionRequest,
  ): Promise<ArtifactVersionDetailDto> {
    this.enter("publishArtifactVersion", [requirementId, input]);
    return {
      id: "version-new",
      requirementId,
      versionNumber: 3,
      publishedBy: DEV,
      publishedAt: "2026-09-30T06:00:00.000Z",
      fileCount: input.attachmentIds.length,
      files: [],
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
