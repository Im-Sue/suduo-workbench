import type {
  AgentDto,
  AgentHeartbeatRequest,
  AgentRunDetailDto,
  AgentRunProgressRequest,
  AgentRunSummaryDto,
  AgentShareDto,
  AgentShareRequestDto,
  ArtifactVersionDetailDto,
  AuthSessionDto,
  CompleteAgentRunRequest,
  CreateAgentShareRequestRequest,
  CreateRequirementRoomRequest,
  FinishAgentRunRequest,
  ListAgentRunsQuery,
  ListAgentRunsResponse,
  ListAgentShareRequestsResponse,
  ListAgentSharesResponse,
  ListAgentsResponse,
  ListRoomMembersResponse,
  ListRoomMessagesQuery,
  ListRoomMessagesResponse,
  ListRoomsResponse,
  AddRoomMembersRequest,
  MarkRoomReadRequest,
  OpenAgentShareRequest,
  RegisterAgentRequest,
  ResolveAgentShareRequestRequest,
  RoomDto,
  RoomMessageDto,
  SearchRoomMessagesQuery,
  SearchRoomMessagesResponse,
  SendRoomMessageRequest,
  StartAgentRunResponse,
  UpdateRoomRequest,
  AttachmentMutationResponse,
  CommentDto,
  CreateCommentRequest,
  CreateProjectRequest,
  CreateRequirementRequest,
  CurrentUserDto,
  ListAuditQuery,
  ListAuditResponse,
  ListAttachmentsResponse,
  ListArtifactVersionsResponse,
  ListCommentsResponse,
  ListProjectsResponse,
  ListRequirementActivityResponse,
  ListRequirementsByIdsResponse,
  ListRequirementsResponse,
  ListUsersResponse,
  LoginRequest,
  ProjectDto,
  ProjectStatsQuery,
  ProjectStatsResponse,
  PublishArtifactVersionRequest,
  RegisterRequest,
  RequirementDetailDto,
  RequirementDto,
  RequirementsHealthDto,
  UpdateProjectRequest,
  UpdateRequirementRequest,
} from "@suduo/cloud-contracts";
import { REQUIREMENTS_V2_ERROR_CODES, type RequirementsV2ErrorCode } from "@suduo/cloud-contracts";
import type { Locale } from "@suduo/client-contracts";
import { ApiError, type ErrorText } from "../../application/api-error.js";
import { messagesFor } from "../../i18n/messages/index.js";
import type { RequirementsCredentialStore } from "./credential-store.js";
import type { RequirementsSettingsStore } from "./settings-store.js";

const REQUEST_TIMEOUT_MS = 15_000;
const FILE_TIMEOUT_MS = 30 * 60_000;
const ERROR_CODES = new Set<string>(REQUIREMENTS_V2_ERROR_CODES);

export class RequirementsRemoteClient {
  constructor(
    private readonly settings: RequirementsSettingsStore,
    private readonly credentials: RequirementsCredentialStore,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {}

  async register(
    input: RegisterRequest,
    expectedBaseUrl?: string,
  ): Promise<AuthSessionDto> {
    return this.request<AuthSessionDto>("/v2/auth/register", {
      method: "POST",
      body: input,
      ...(expectedBaseUrl === undefined ? {} : { expectedBaseUrl }),
    });
  }

  async login(input: LoginRequest, expectedBaseUrl?: string): Promise<AuthSessionDto> {
    return this.request<AuthSessionDto>("/v2/auth/login", {
      method: "POST",
      body: input,
      ...(expectedBaseUrl === undefined ? {} : { expectedBaseUrl }),
    });
  }

  me(): Promise<CurrentUserDto> {
    return this.request<CurrentUserDto>("/v2/auth/me", { authenticated: true });
  }

  /**
   * 只探测调用方给出的地址，绝不读取或写入当前保存的地址、登录态。
   * 健康检查是 requirements-service 的公开端点，因此也不需要凭证。
   * `locale` 是发起试连的请求的语言，成功时的说明按它生成。
   */
  async testConnection(baseUrl: string, locale: Locale): Promise<{
    baseUrl: string;
    reachable: true;
    message: string;
    /** 云端的产品版本；较早的云端不报告版本时为 null。 */
    version: string | null;
  }> {
    let response: Response;
    try {
      response = await this.fetchImplementation(baseUrl + "/v2/health", {
        method: "GET",
        headers: { Accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (cause) {
      throw new ApiError(
        503,
        "DEPENDENCY_UNAVAILABLE",
        (t) => t.remote.test.unreachable,
        undefined,
        { cause },
      );
    }

    const payload = await response.json().catch(() => null) as unknown;
    if (!response.ok) {
      const status = response.status;
      throw new ApiError(
        503,
        "DEPENDENCY_UNAVAILABLE",
        (t) => t.remote.test.healthFailed(status),
      );
    }
    if (!isRequirementsHealth(payload)) {
      throw new ApiError(
        503,
        "DEPENDENCY_UNAVAILABLE",
        (t) => t.remote.test.healthInvalid,
      );
    }
    return {
      baseUrl,
      reachable: true,
      message: messagesFor(locale).remote.test.ok,
      version: typeof payload.version === "string" && payload.version !== "" ? payload.version : null,
    };
  }

  listProjects(query: Record<string, string | undefined>): Promise<ListProjectsResponse> {
    return this.request<ListProjectsResponse>(withQuery("/v2/projects", query), {
      authenticated: true,
    });
  }

  createProject(input: CreateProjectRequest): Promise<ProjectDto> {
    return this.request<ProjectDto>("/v2/projects", {
      method: "POST",
      body: input,
      authenticated: true,
    });
  }

  getProject(projectId: string): Promise<ProjectDto> {
    return this.request<ProjectDto>(`/v2/projects/${encodeURIComponent(projectId)}`, {
      authenticated: true,
    });
  }

  getProjectStats(
    projectId: string,
    query: ProjectStatsQuery,
  ): Promise<ProjectStatsResponse> {
    return this.request<ProjectStatsResponse>(
      withQuery(`/v2/projects/${encodeURIComponent(projectId)}/stats`, {
        window: query.window,
        tz: query.tz,
      }),
      { authenticated: true },
    );
  }

  updateProject(projectId: string, input: UpdateProjectRequest): Promise<ProjectDto> {
    return this.request<ProjectDto>(`/v2/projects/${encodeURIComponent(projectId)}`, {
      method: "PATCH",
      body: input,
      authenticated: true,
    });
  }

  listRequirements(
    projectId: string,
    query: Record<string, string | undefined>,
  ): Promise<ListRequirementsResponse> {
    return this.request<ListRequirementsResponse>(
      withQuery(`/v2/projects/${encodeURIComponent(projectId)}/requirements`, query),
      { authenticated: true },
    );
  }

  /**
   * 远程单请求上限为 100；此处只负责分批及合并，默认串行，调用方可显式
   * 提升并发。任何一个批次失败都会拒绝整个调用，绝不返回静默的半份结果。
   */
  async listRequirementsByIds(
    ids: readonly string[],
    options: { concurrency?: number } = {},
  ): Promise<RequirementDto[]> {
    const batches = requirementIdBatches(ids);
    if (batches.length === 0) return [];
    const concurrency = options.concurrency ?? 1;
    if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
      throw new Error("requirements batch concurrency must be a positive safe integer");
    }
    const results = await mapBatches(
      batches,
      concurrency,
      async (batch) => {
        const response = await this.request<ListRequirementsByIdsResponse>(
          withQuery("/v2/requirements", { ids: batch.join(",") }),
          { authenticated: true },
        );
        return response.items;
      },
    );
    return results.flat();
  }

  createRequirement(
    projectId: string,
    input: CreateRequirementRequest,
  ): Promise<RequirementDto> {
    return this.request<RequirementDto>(
      `/v2/projects/${encodeURIComponent(projectId)}/requirements`,
      { method: "POST", body: input, authenticated: true },
    );
  }

  getRequirement(requirementId: string): Promise<RequirementDetailDto> {
    return this.request<RequirementDetailDto>(
      `/v2/requirements/${encodeURIComponent(requirementId)}`,
      { authenticated: true },
    );
  }

  getRequirementByNumber(projectId: string, number: number): Promise<RequirementDetailDto> {
    return this.request<RequirementDetailDto>(
      `/v2/projects/${encodeURIComponent(projectId)}/requirements/by-number/${String(number)}`,
      { authenticated: true },
    );
  }

  updateRequirement(
    requirementId: string,
    input: UpdateRequirementRequest,
  ): Promise<RequirementDto> {
    return this.request<RequirementDto>(
      `/v2/requirements/${encodeURIComponent(requirementId)}`,
      { method: "PATCH", body: input, authenticated: true },
    );
  }

  /** 已读位置（个人状态）：打开需求详情时调用。 */
  async markRequirementRead(requirementId: string, input: { upTo?: string } = {}): Promise<void> {
    await this.request<null>(`/v2/requirements/${encodeURIComponent(requirementId)}/read`, {
      method: "PUT",
      body: input.upTo === undefined ? {} : { upTo: input.upTo },
      authenticated: true,
    });
  }

  listRequirementActivity(
    requirementId: string,
    query: Record<string, string | undefined>,
  ): Promise<ListRequirementActivityResponse> {
    return this.request<ListRequirementActivityResponse>(
      withQuery(`/v2/requirements/${encodeURIComponent(requirementId)}/activity`, query),
      { authenticated: true },
    );
  }

  listUsers(): Promise<ListUsersResponse> {
    return this.request<ListUsersResponse>("/v2/users", { authenticated: true });
  }

  listComments(
    requirementId: string,
    query: Record<string, string | undefined>,
  ): Promise<ListCommentsResponse> {
    return this.request<ListCommentsResponse>(
      withQuery(`/v2/requirements/${encodeURIComponent(requirementId)}/comments`, query),
      { authenticated: true },
    );
  }

  createComment(requirementId: string, input: CreateCommentRequest): Promise<CommentDto> {
    return this.request<CommentDto>(
      `/v2/requirements/${encodeURIComponent(requirementId)}/comments`,
      { method: "POST", body: input, authenticated: true },
    );
  }

  listAudit(query: ListAuditQuery): Promise<ListAuditResponse> {
    return this.request<ListAuditResponse>(
      withQuery("/v2/audit", queryToRecord(query)),
      { authenticated: true },
    );
  }

  listAttachments(requirementId: string): Promise<ListAttachmentsResponse> {
    return this.request<ListAttachmentsResponse>(
      `/v2/requirements/${encodeURIComponent(requirementId)}/attachments`,
      { authenticated: true },
    );
  }

  listArtifactVersions(requirementId: string): Promise<ListArtifactVersionsResponse> {
    return this.request<ListArtifactVersionsResponse>(
      `/v2/requirements/${encodeURIComponent(requirementId)}/artifact-versions`,
      { authenticated: true },
    );
  }

  publishArtifactVersion(
    requirementId: string,
    input: PublishArtifactVersionRequest,
  ): Promise<ArtifactVersionDetailDto> {
    return this.request<ArtifactVersionDetailDto>(
      `/v2/requirements/${encodeURIComponent(requirementId)}/artifact-versions`,
      { method: "POST", body: input, authenticated: true },
    );
  }

  getArtifactVersion(versionId: string): Promise<ArtifactVersionDetailDto> {
    return this.request<ArtifactVersionDetailDto>(
      `/v2/artifact-versions/${encodeURIComponent(versionId)}`,
      { authenticated: true },
    );
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
    const response = await this.authenticatedFetch(
      `/v2/requirements/${encodeURIComponent(input.requirementId)}/attachments`,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": input.contentType,
          ...(input.contentLength === undefined
            ? {}
            : { "Content-Length": input.contentLength }),
          ...(input.attachmentSize === undefined
            ? {}
            : { "X-Attachment-Size": input.attachmentSize }),
          "Idempotency-Key": input.idempotencyKey,
        },
        body: input.body,
        signal: input.signal,
        timeoutMs: FILE_TIMEOUT_MS,
      },
    );
    return await response.json() as AttachmentMutationResponse;
  }

  downloadAttachment(attachmentId: string, signal: AbortSignal): Promise<Response> {
    return this.authenticatedFetch(
      `/v2/attachments/${encodeURIComponent(attachmentId)}/content`,
      {
        method: "GET",
        headers: { Accept: "application/octet-stream" },
        signal,
        timeoutMs: FILE_TIMEOUT_MS,
      },
    );
  }

  downloadArtifactVersionFile(
    versionId: string,
    fileId: string,
    signal: AbortSignal,
  ): Promise<Response> {
    return this.authenticatedFetch(
      `/v2/artifact-versions/${encodeURIComponent(versionId)}/files/${encodeURIComponent(fileId)}/content`,
      {
        method: "GET",
        headers: { Accept: "application/octet-stream" },
        signal,
        timeoutMs: FILE_TIMEOUT_MS,
      },
    );
  }

  async deleteAttachment(input: { attachmentId: string }): Promise<AttachmentMutationResponse> {
    const response = await this.authenticatedFetch(
      `/v2/attachments/${encodeURIComponent(input.attachmentId)}/content`,
      {
        method: "DELETE",
        headers: {
          Accept: "application/json",
        },
      },
    );
    return await response.json() as AttachmentMutationResponse;
  }

  /**
   * 远程推送流。`lastEventId` 与 `epoch` 用于断线重连：同一 epoch 下远程按 Last-Event-ID
   * 补发环形缓冲里更新的事件（技术设计 4.3）。
   */
  openEvents(
    signal: AbortSignal,
    options: { lastEventId?: string; epoch?: string } = {},
  ): Promise<Response> {
    return this.authenticatedFetch(
      withQuery("/v2/events", { epoch: options.epoch }),
      {
        method: "GET",
        headers: {
          Accept: "text/event-stream",
          ...(options.lastEventId === undefined ? {} : { "Last-Event-ID": options.lastEventId }),
        },
        signal,
        timeoutMs: null,
      },
    );
  }

  // ───────────────────────────── 登录续期 ─────────────────────────────

  /** 用仍有效的令牌换新令牌（技术设计第七节 `POST /v2/auth/refresh`）。 */
  refreshAuth(): Promise<AuthSessionDto> {
    // 没有请求体：不带 Content-Type（远程 Fastify 对「JSON + 空体」回 400）。
    return this.request<AuthSessionDto>("/v2/auth/refresh", {
      method: "POST",
      authenticated: true,
    });
  }

  // ───────────────────────────── 房间 ─────────────────────────────

  listProjectRooms(projectId: string): Promise<ListRoomsResponse> {
    return this.request<ListRoomsResponse>(`/v2/projects/${encodeURIComponent(projectId)}/rooms`, {
      authenticated: true,
    });
  }

  listRequirementRooms(requirementId: string): Promise<ListRoomsResponse> {
    return this.request<ListRoomsResponse>(
      `/v2/requirements/${encodeURIComponent(requirementId)}/rooms`,
      { authenticated: true },
    );
  }

  createRequirementRoom(requirementId: string, input: CreateRequirementRoomRequest): Promise<RoomDto> {
    return this.request<RoomDto>(`/v2/requirements/${encodeURIComponent(requirementId)}/rooms`, {
      method: "POST",
      body: input,
      authenticated: true,
    });
  }

  getRoom(roomId: string): Promise<RoomDto> {
    return this.request<RoomDto>(`/v2/rooms/${encodeURIComponent(roomId)}`, { authenticated: true });
  }

  updateRoom(roomId: string, input: UpdateRoomRequest): Promise<RoomDto> {
    return this.request<RoomDto>(`/v2/rooms/${encodeURIComponent(roomId)}`, {
      method: "PATCH",
      body: input,
      authenticated: true,
    });
  }

  listRoomMembers(roomId: string): Promise<ListRoomMembersResponse> {
    return this.request<ListRoomMembersResponse>(`/v2/rooms/${encodeURIComponent(roomId)}/members`, {
      authenticated: true,
    });
  }

  addRoomMembers(roomId: string, input: AddRoomMembersRequest): Promise<ListRoomMembersResponse> {
    return this.request<ListRoomMembersResponse>(`/v2/rooms/${encodeURIComponent(roomId)}/members`, {
      method: "POST",
      body: input,
      authenticated: true,
    });
  }

  markRoomRead(roomId: string, input: MarkRoomReadRequest): Promise<unknown> {
    return this.request<unknown>(`/v2/rooms/${encodeURIComponent(roomId)}/read`, {
      method: "POST",
      body: input,
      authenticated: true,
    });
  }

  listRoomMessages(roomId: string, query: ListRoomMessagesQuery = {}): Promise<ListRoomMessagesResponse> {
    return this.request<ListRoomMessagesResponse>(
      withQuery(`/v2/rooms/${encodeURIComponent(roomId)}/messages`, {
        after: numberParam(query.after),
        before: numberParam(query.before),
        threadRootId: query.threadRootId,
        limit: numberParam(query.limit),
      }),
      { authenticated: true },
    );
  }

  searchRoomMessages(roomId: string, query: SearchRoomMessagesQuery): Promise<SearchRoomMessagesResponse> {
    return this.request<SearchRoomMessagesResponse>(
      withQuery(`/v2/rooms/${encodeURIComponent(roomId)}/messages/search`, {
        q: query.q,
        limit: numberParam(query.limit),
        before: numberParam(query.before),
      }),
      { authenticated: true },
    );
  }

  sendRoomMessage(roomId: string, input: SendRoomMessageRequest): Promise<RoomMessageDto> {
    return this.request<RoomMessageDto>(`/v2/rooms/${encodeURIComponent(roomId)}/messages`, {
      method: "POST",
      body: input,
      authenticated: true,
    });
  }

  /** 房间文件上传（multipart 单文件 `file`）：流式转发，不落本机。 */
  async uploadRoomFile(input: {
    roomId: string;
    body: AsyncIterable<Uint8Array>;
    contentType: string;
    /** 原样转发的附加请求头（Content-Length、X-Attachment-Size、Idempotency-Key 等）。 */
    headers?: Record<string, string>;
    signal: AbortSignal;
  }): Promise<{ status: number; body: unknown }> {
    const response = await this.authenticatedFetch(
      `/v2/rooms/${encodeURIComponent(input.roomId)}/files`,
      {
        method: "POST",
        headers: {
          ...(input.headers ?? {}),
          Accept: "application/json",
          "Content-Type": input.contentType,
        },
        body: input.body,
        signal: input.signal,
        timeoutMs: FILE_TIMEOUT_MS,
      },
    );
    return { status: response.status, body: await response.json().catch(() => null) as unknown };
  }

  /**
   * 房间文件内容：`Range` / `If-Range` / `If-None-Match` 原样透传，206 / 304 / 416 也原样交回调用方
   * （视频要能在浏览器里拖动播放）。
   */
  downloadRoomFile(
    fileId: string,
    options: {
      range?: string;
      ifRange?: string;
      ifNoneMatch?: string;
      disposition?: "inline" | "attachment";
      signal: AbortSignal;
    },
  ): Promise<Response> {
    return this.authenticatedFetch(
      withQuery(`/v2/room-files/${encodeURIComponent(fileId)}/content`, {
        disposition: options.disposition,
      }),
      {
        method: "GET",
        headers: {
          Accept: "*/*",
          ...(options.range === undefined ? {} : { Range: options.range }),
          ...(options.ifRange === undefined ? {} : { "If-Range": options.ifRange }),
          ...(options.ifNoneMatch === undefined ? {} : { "If-None-Match": options.ifNoneMatch }),
        },
        signal: options.signal,
        timeoutMs: FILE_TIMEOUT_MS,
        // 304（ETag 命中）与 416（Range 越界）也原样交回。
        passStatuses: [304, 416],
      },
    );
  }

  // ───────────────────────────── Agent 与共享 ─────────────────────────────

  listAgents(): Promise<ListAgentsResponse> {
    return this.request<ListAgentsResponse>("/v2/agents", { authenticated: true });
  }

  /** 登记本机 Agent；同一所有者 + 设备重复登记返回同一个（合并，ADR-0004）。 */
  registerAgent(input: RegisterAgentRequest): Promise<AgentDto> {
    return this.request<AgentDto>("/v2/agents", { method: "POST", body: input, authenticated: true });
  }

  heartbeatAgent(agentId: string, input: AgentHeartbeatRequest): Promise<AgentDto> {
    return this.request<AgentDto>(`/v2/agents/${encodeURIComponent(agentId)}/heartbeat`, {
      method: "POST",
      body: input,
      authenticated: true,
    });
  }

  listRoomShares(roomId: string): Promise<ListAgentSharesResponse> {
    return this.request<ListAgentSharesResponse>(`/v2/rooms/${encodeURIComponent(roomId)}/shares`, {
      authenticated: true,
    });
  }

  openRoomShare(roomId: string, input: OpenAgentShareRequest): Promise<AgentShareDto> {
    return this.request<AgentShareDto>(`/v2/rooms/${encodeURIComponent(roomId)}/shares`, {
      method: "POST",
      body: input,
      authenticated: true,
    });
  }

  closeAgentShare(shareId: string): Promise<AgentShareDto> {
    return this.request<AgentShareDto>(`/v2/agent-shares/${encodeURIComponent(shareId)}/close`, {
      method: "POST",
      authenticated: true,
    });
  }

  listShareRequests(roomId: string): Promise<ListAgentShareRequestsResponse> {
    return this.request<ListAgentShareRequestsResponse>(
      `/v2/rooms/${encodeURIComponent(roomId)}/share-requests`,
      { authenticated: true },
    );
  }

  createShareRequest(roomId: string, input: CreateAgentShareRequestRequest): Promise<AgentShareRequestDto> {
    return this.request<AgentShareRequestDto>(`/v2/rooms/${encodeURIComponent(roomId)}/share-requests`, {
      method: "POST",
      body: input,
      authenticated: true,
    });
  }

  resolveShareRequest(requestId: string, input: ResolveAgentShareRequestRequest): Promise<AgentShareRequestDto> {
    return this.request<AgentShareRequestDto>(
      `/v2/share-requests/${encodeURIComponent(requestId)}/resolve`,
      { method: "POST", body: input, authenticated: true },
    );
  }

  // ───────────────────────────── Agent 任务 ─────────────────────────────

  listAgentRuns(query: ListAgentRunsQuery): Promise<ListAgentRunsResponse> {
    return this.request<ListAgentRunsResponse>(
      withQuery("/v2/agent-runs", { agentId: query.agentId, status: query.status }),
      { authenticated: true },
    );
  }

  getAgentRun(runId: string): Promise<AgentRunDetailDto> {
    return this.request<AgentRunDetailDto>(`/v2/agent-runs/${encodeURIComponent(runId)}`, {
      authenticated: true,
    });
  }

  /** 只把排队中改成执行中；已不是排队中时返回当前状态与 started=false（调用方跳过）。 */
  startAgentRun(runId: string): Promise<StartAgentRunResponse> {
    return this.request<StartAgentRunResponse>(`/v2/agent-runs/${encodeURIComponent(runId)}/start`, {
      method: "POST",
      authenticated: true,
    });
  }

  progressAgentRun(runId: string, input: AgentRunProgressRequest): Promise<AgentRunSummaryDto> {
    return this.request<AgentRunSummaryDto>(`/v2/agent-runs/${encodeURIComponent(runId)}/progress`, {
      method: "POST",
      body: input,
      authenticated: true,
    });
  }

  completeAgentRun(runId: string, input: CompleteAgentRunRequest): Promise<AgentRunSummaryDto> {
    return this.request<AgentRunSummaryDto>(`/v2/agent-runs/${encodeURIComponent(runId)}/complete`, {
      method: "POST",
      body: input,
      authenticated: true,
    });
  }

  finishAgentRun(runId: string, input: FinishAgentRunRequest): Promise<AgentRunSummaryDto> {
    return this.request<AgentRunSummaryDto>(`/v2/agent-runs/${encodeURIComponent(runId)}/finish`, {
      method: "POST",
      body: input,
      authenticated: true,
    });
  }

  stopAgentRun(runId: string): Promise<AgentRunSummaryDto> {
    return this.request<AgentRunSummaryDto>(`/v2/agent-runs/${encodeURIComponent(runId)}/stop`, {
      method: "POST",
      authenticated: true,
    });
  }

  retryAgentRun(runId: string): Promise<AgentRunSummaryDto> {
    return this.request<AgentRunSummaryDto>(`/v2/agent-runs/${encodeURIComponent(runId)}/retry`, {
      method: "POST",
      authenticated: true,
    });
  }

  /**
   * 浏览器经本机 `/api/v2/*` 一比一转发的 JSON 端点：方法、路径、查询串、请求体原样转发，
   * 远程的成功状态码（200 / 201 / 204）原样交回；错误码走与其他端点相同的映射。
   */
  async forward(input: {
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
    path: string;
    query?: Record<string, string | undefined>;
    body?: unknown;
  }): Promise<{ status: number; body: unknown }> {
    const result = await this.requestWithStatus<unknown>(withQuery(input.path, input.query ?? {}), {
      method: input.method,
      ...(input.body === undefined ? {} : { body: input.body }),
      authenticated: true,
    });
    return { status: result.status, body: result.payload };
  }

  private async request<T>(
    path: string,
    options: {
      method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
      body?: unknown;
      authenticated?: boolean;
      expectedBaseUrl?: string;
    },
  ): Promise<T> {
    return (await this.requestWithStatus<T>(path, options)).payload;
  }

  private async requestWithStatus<T>(
    path: string,
    options: {
      method?: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
      body?: unknown;
      authenticated?: boolean;
      expectedBaseUrl?: string;
    },
  ): Promise<{ status: number; payload: T }> {
    const baseUrl = options.expectedBaseUrl ?? this.settings.getBaseUrl();
    if (!baseUrl) {
      throw new ApiError(
        409,
        "REMOTE_SERVICE_NOT_CONFIGURED",
        (t) => t.remote.notConfigured,
      );
    }
    if (
      options.expectedBaseUrl !== undefined &&
      this.settings.getBaseUrl() !== baseUrl
    ) {
      throw new ApiError(409, "AUTH_INVALID", (t) => t.remote.baseUrlChanged);
    }
    const session = options.authenticated
      ? this.credentials.getForBaseUrl(baseUrl)
      : null;
    if (options.authenticated && !session) {
      throw new ApiError(401, "AUTH_INVALID", (t) => t.remote.signInRequired);
    }
    let response: Response;
    try {
      response = await this.fetchImplementation(baseUrl + path, {
        method: options.method ?? "GET",
        headers: {
          Accept: "application/json",
          ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(session === null
            ? {}
            : { Authorization: `Bearer ${session.accessToken}` }),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        redirect: "error",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch {
      throw new ApiError(
        503,
        "DEPENDENCY_UNAVAILABLE",
        (t) => t.remote.unavailable,
      );
    }
    const payload = await response.json().catch(() => null) as unknown;
    if (response.ok) {
      return { status: response.status, payload: payload as T };
    }
    const remoteError = errorBody(payload);
    if (remoteError?.code === "LOGIN_CREDENTIALS_INVALID") {
      throw new ApiError(
        safeRemoteStatus(response.status),
        "LOGIN_CREDENTIALS_INVALID",
        safeRemoteMessage("LOGIN_CREDENTIALS_INVALID"),
      );
    }
    if (
      response.status === 401 ||
      remoteError?.code === "AUTH_REQUIRED" ||
      remoteError?.code === "AUTH_INVALID"
    ) {
      this.credentials.clear();
      throw new ApiError(401, "AUTH_INVALID", (t) => t.remote.credentialsExpired);
    }
    if (remoteError && ERROR_CODES.has(remoteError.code)) {
      const code = remoteError.code as RequirementsV2ErrorCode;
      throw new ApiError(
        safeRemoteStatus(response.status),
        code,
        safeRemoteMessage(code),
      );
    }
    throw new ApiError(
      503,
      "DEPENDENCY_UNAVAILABLE",
      (t) => t.remote.unrecognizedResponse,
    );
  }

  private async authenticatedFetch(
    path: string,
    options: {
      method: "GET" | "POST" | "DELETE";
      headers: Record<string, string>;
      body?: AsyncIterable<Uint8Array>;
      signal?: AbortSignal;
      timeoutMs?: number | null;
      /** 这些非 2xx 状态也原样交回（如 Range 越界的 416），不当作错误。 */
      passStatuses?: readonly number[];
    },
  ): Promise<Response> {
    const baseUrl = this.settings.getBaseUrl();
    if (!baseUrl) {
      throw new ApiError(409, "REMOTE_SERVICE_NOT_CONFIGURED", (t) => t.remote.notConfigured);
    }
    const session = this.credentials.getForBaseUrl(baseUrl);
    if (!session) {
      throw new ApiError(401, "AUTH_INVALID", (t) => t.remote.signInRequired);
    }
    const signals = [
      ...(options.signal === undefined ? [] : [options.signal]),
      ...(options.timeoutMs === null
        ? []
        : [AbortSignal.timeout(options.timeoutMs ?? REQUEST_TIMEOUT_MS)]),
    ];
    const init: RequestInit & { duplex?: "half" } = {
      method: options.method,
      headers: {
        ...options.headers,
        Authorization: `Bearer ${session.accessToken}`,
      },
      ...(options.body === undefined
        ? {}
        : {
            body: options.body as unknown as NonNullable<RequestInit["body"]>,
            duplex: "half",
          }),
      redirect: "error",
      ...(signals.length === 0
        ? {}
        : { signal: signals.length === 1 ? signals[0] : AbortSignal.any(signals) }),
    };
    let response: Response;
    try {
      response = await this.fetchImplementation(baseUrl + path, init);
    } catch (error) {
      throw new ApiError(503, "DEPENDENCY_UNAVAILABLE", (t) => t.remote.streamUnavailable, undefined, {
        cause: error,
      });
    }
    if (response.ok || options.passStatuses?.includes(response.status) === true) return response;
    const payload = await response.json().catch(() => null) as unknown;
    this.throwRemoteError(response.status, payload);
  }

  private throwRemoteError(status: number, payload: unknown): never {
    const remoteError = errorBody(payload);
    if (remoteError?.code === "LOGIN_CREDENTIALS_INVALID") {
      throw new ApiError(
        safeRemoteStatus(status),
        "LOGIN_CREDENTIALS_INVALID",
        safeRemoteMessage("LOGIN_CREDENTIALS_INVALID"),
      );
    }
    if (
      status === 401 ||
      remoteError?.code === "AUTH_REQUIRED" ||
      remoteError?.code === "AUTH_INVALID"
    ) {
      this.credentials.clear();
      throw new ApiError(401, "AUTH_INVALID", (t) => t.remote.credentialsExpired);
    }
    if (remoteError && ERROR_CODES.has(remoteError.code)) {
      const code = remoteError.code as RequirementsV2ErrorCode;
      throw new ApiError(safeRemoteStatus(status), code, safeRemoteMessage(code));
    }
    throw new ApiError(503, "DEPENDENCY_UNAVAILABLE", (t) => t.remote.unrecognizedResponse);
  }
}

function withQuery(path: string, query: Record<string, string | undefined>): string {
  const parameters = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      parameters.set(key, value);
    }
  }
  const rendered = parameters.toString();
  return rendered ? `${path}?${rendered}` : path;
}

function numberParam(value: number | undefined): string | undefined {
  return value === undefined ? undefined : String(value);
}

function queryToRecord(query: ListAuditQuery): Record<string, string | undefined> {
  return {
    ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
    ...(query.limit === undefined ? {} : { limit: String(query.limit) }),
    ...(query.resourceType === undefined ? {} : { resourceType: query.resourceType }),
    ...(query.resourceId === undefined ? {} : { resourceId: query.resourceId }),
    ...(query.projectId === undefined ? {} : { projectId: query.projectId }),
  };
}

function requirementIdBatches(ids: readonly string[]): string[][] {
  const batches: string[][] = [];
  for (let start = 0; start < ids.length; start += 100) {
    batches.push(ids.slice(start, start + 100));
  }
  return batches;
}

async function mapBatches<TInput, TResult>(
  batches: readonly TInput[],
  concurrency: number,
  operation: (batch: TInput) => Promise<TResult>,
): Promise<TResult[]> {
  const results = new Array<TResult>(batches.length);
  let nextIndex = 0;
  const worker = async () => {
    while (nextIndex < batches.length) {
      const index = nextIndex;
      nextIndex += 1;
      const batch = batches[index];
      if (batch === undefined) continue;
      results[index] = await operation(batch);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, batches.length) }, worker));
  return results;
}

function errorBody(value: unknown): { code: string } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const error = (value as Record<string, unknown>)["error"];
  if (!error || typeof error !== "object" || Array.isArray(error)) return null;
  const code = (error as Record<string, unknown>)["code"];
  return typeof code === "string" ? { code } : null;
}

function safeRemoteStatus(status: number): number {
  return status >= 400 && status <= 599 ? status : 502;
}

/** 远程错误码的本机说明（按请求语言）；远程返回的原文不透传。 */
function safeRemoteMessage(code: RequirementsV2ErrorCode): ErrorText {
  return (t) => {
    const messages: Record<RequirementsV2ErrorCode, string> = t.remote.errorCodes;
    return messages[code] ?? t.remote.errorCodes.INTERNAL_ERROR;
  };
}

function isRequirementsHealth(value: unknown): value is RequirementsHealthDto {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const health = value as Record<string, unknown>;
  return (
    health["service"] === "suduo-requirements-service" &&
    health["status"] === "ok" &&
    health["database"] !== null &&
    typeof health["database"] === "object" &&
    typeof health["uptimeMs"] === "number"
  );
}
