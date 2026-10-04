import { LOCALE_HEADER } from "@suduo/client-contracts";
import { currentLocale, withLocaleParam } from "../i18n/locale.js";
import { messagesFor } from "../i18n/messages/index.js";
import { markRequestNetworkFailure, markRequestReachedServer } from "./connectivity.js";
import type {
  McpServerDto,
  ApprovalDto,
  AttachmentDto,
  CreateSessionRequest,
  EventEnvelope,
  FileContentDto,
  FileIndexResponse,
  GitCheckpointDto,
  GitStatusDto,
  InstallSkillRequest,
  InterruptAccepted,
  InterruptRequest,
  ListApprovalsResponse,
  ListGitCheckpointsResponse,
  ExistingFilesResponse,
  OpenTargetsResponse,
  SettingsDto,
  CodexModelsResponse,
  ModelProviderSettingsDto,
  UpdateModelProviderRequest,
  UpdateModelProviderResult,
  SkillCatalogResponse,
  SkillDto,
  SystemOpenTarget,
  UpdateSettingsRequest,
  ListFilesResponse,
  ListProjectsResponse,
  ListSessionsResponse,
  ListAllSessionsResponse,
  ListSkillsResponse,
  SessionRunStatusResponse,
  ProjectDto,
  SendMessageAccepted,
  SendMessageRequest,
  SessionContextDto,
  SessionDto,
  SessionKind,
  JsonValue,
  UpdateSessionRequest,
  ListRequirementItemsResponse,
  LocalDirectoryListingDto,
  LocalPathInspectionDto,
  MyWorkbenchResponse,
  RequirementDetailItemDto,
  RequirementListItemDto,
  LocalAgentStateDto,
  ProxyConnectivityDto,
  DoctorResultDto,
} from "@suduo/client-contracts";
import type {
  ArtifactVersionDetailDto,
  ArtifactVersionDto,
  AttachmentDto as RequirementsAttachmentDto,
  AttachmentMutationResponse,
  AuditEntryDto as RequirementsAuditEntryDto,
  AuditResourceType,
  CommentDto as RequirementsCommentDto,
  CreateCommentRequest,
  CreateProjectRequest as RequirementsCreateProjectRequest,
  CreateRequirementRequest,
  CurrentUserDto,
  ListAuditResponse,
  ListAttachmentsResponse,
  ListCommentsResponse,
  ListProjectsResponse as RequirementsListProjectsResponse,
  ListRequirementActivityResponse,
  ListUsersResponse,
  LoginRequest,
  ListArtifactVersionsResponse,
  PublishArtifactVersionRequest,
  ProjectStatsQuery,
  ProjectStatsResponse,
  ProjectDto as RequirementsProjectDto,
  RegisterRequest,
  RequirementAssigneeFilter,
  RequirementDetailDto,
  RequirementDto,
  RequirementStatus,
  RequirementsEventDto,
  UpdateProjectRequest as RequirementsUpdateProjectRequest,
  UpdateRequirementRequest,
  AddRoomMembersRequest,
  AgentRunDetailDto,
  AgentRunSummaryDto,
  AgentShareDto,
  AgentShareRequestDto,
  CreateRequirementRoomRequest,
  ListAgentShareRequestsResponse,
  ListAgentSharesResponse,
  ListAgentsResponse,
  ListRoomMembersResponse,
  ListRoomMessagesQuery,
  ListRoomMessagesResponse,
  ListRoomsResponse,
  OpenAgentShareRequest,
  ResolveAgentShareRequestRequest,
  RoomDto,
  RoomFileDto,
  RoomMessageDto,
  RoomViewerStateDto,
  SendRoomMessageRequest,
  UpdateRoomRequest,
} from "@suduo/cloud-contracts";
import { ROOM_FILE_MAX_BYTES } from "@suduo/cloud-contracts";

export type { ListAgentShareRequestsResponse };

export interface RequirementsSettingsDto {
  configured: boolean;
  baseUrl: string | null;
  session: { user: CurrentUserDto; expiresAt: string } | null;
  mappingCount: number;
}

/** 本机目录浏览（BFF /api/v2/local/dirs，仅 loopback 可用），供「选择代码目录」使用。 */
export type {
  LocalDirectoryListingDto as LocalDirListingDto,
  LocalPathInspectionDto as LocalDirInspectionDto,
};

export interface RequirementsWorkspaceMappingDto {
  remoteProjectId: string;
  localProjectId: string;
  rootPath: string;
  localProjectName: string;
  lastValidatedAt: number;
}

/** pr5 的映射可用性灯返回形态；`available=false` 时 `message` 是可读原因。 */
export interface WorkspaceMappingVerification {
  exists: boolean;
  readable: boolean;
  writable: boolean;
  executable: boolean;
  available: boolean;
  message: string;
}

export interface RequirementsSessionReferenceDto {
  session: SessionDto;
  requirement: {
    remoteRequirementId: string;
    requirementVersion: number;
    createdAt: number;
    /** tools = 新版（会话挂 suduo_* 工具）；legacy = 旧版需求会话。旧数据可能没有这个字段。 */
    contextMode?: "tools" | "legacy";
  } | null;
}

export type {
  ArtifactVersionDetailDto,
  ArtifactVersionDto,
  RequirementsAuditEntryDto,
  RequirementsCommentDto,
  RequirementsProjectDto,
  RequirementDetailDto,
  RequirementDetailItemDto,
  RequirementDto,
  RequirementListItemDto,
  RequirementsAttachmentDto,
  RequirementsEventDto,
};

/** 在途请求计数：全局顶部细进度条的数据源（SSE 长连接不计入）。 */
let inflightCount = 0;
const inflightListeners = new Set<() => void>();

export function getInflightCount(): number {
  return inflightCount;
}

export function subscribeInflight(listener: () => void): () => void {
  inflightListeners.add(listener);
  return () => inflightListeners.delete(listener);
}

function trackInflight(delta: number): void {
  inflightCount += delta;
  for (const listener of inflightListeners) {
    listener();
  }
}

export class ApiClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

export interface WorkspaceChange {
  path: string;
  kind: "created" | "modified" | "deleted";
  size: number | null;
  additions: number;
  deletions: number;
}

export interface WorkspaceChanges {
  items: WorkspaceChange[];
  additions: number;
  deletions: number;
}

export interface WorkspaceDiff {
  path: string;
  kind: WorkspaceChange["kind"];
  before: string;
  after: string;
  truncated: boolean;
}

export const api = {
  requirementsSettings: () =>
    request<RequirementsSettingsDto>("/api/v2/requirements/settings"),

  updateRequirementsSettings: (baseUrl: string) =>
    request<RequirementsSettingsDto>("/api/v2/requirements/settings", {
      method: "PUT",
      body: { baseUrl },
    }),

  registerRequirements: (body: RegisterRequest) =>
    request<{ user: CurrentUserDto; expiresAt: string }>("/api/v2/auth/register", {
      method: "POST",
      body,
    }),

  loginRequirements: (body: LoginRequest) =>
    request<{ user: CurrentUserDto; expiresAt: string }>("/api/v2/auth/login", {
      method: "POST",
      body,
    }),

  logoutRequirements: () =>
    request("/api/v2/auth/logout", { method: "POST", expectedStatus: 204 }),

  requirementsMe: () => request<CurrentUserDto>("/api/v2/auth/me"),

  listRequirementsProjects: (
    query: { includeArchived?: boolean; cursor?: string; limit?: number } = {},
  ) =>
    request<RequirementsListProjectsResponse>(
      `/api/v2/projects${queryString(query)}`,
    ),

  createRequirementsProject: (body: RequirementsCreateProjectRequest) =>
    request<RequirementsProjectDto>("/api/v2/projects", { method: "POST", body }),

  getRequirementsProject: (projectId: string) =>
    request<RequirementsProjectDto>(
      `/api/v2/projects/${encodeURIComponent(projectId)}`,
    ),

  updateRequirementsProject: (
    projectId: string,
    body: RequirementsUpdateProjectRequest,
  ) =>
    request<RequirementsProjectDto>(
      `/api/v2/projects/${encodeURIComponent(projectId)}`,
      { method: "PATCH", body },
    ),

  listRequirements: (
    projectId: string,
    query: {
      status?: RequirementStatus;
      search?: string;
      assignee?: RequirementAssigneeFilter;
      /** 创建人：用户 id 或 "me"。 */
      creator?: string;
      cursor?: string;
      limit?: number;
    } = {},
    options: { signal?: AbortSignal } = {},
  ) =>
    request<ListRequirementItemsResponse>(
      `/api/v2/projects/${encodeURIComponent(projectId)}/requirements${queryString(query)}`,
      options.signal === undefined ? {} : { signal: options.signal },
    ),

  createRequirement: (projectId: string, body: CreateRequirementRequest) =>
    request<RequirementListItemDto>(
      `/api/v2/projects/${encodeURIComponent(projectId)}/requirements`,
      { method: "POST", body },
    ),

  getRequirement: (requirementId: string, options: { signal?: AbortSignal } = {}) =>
    request<RequirementDetailItemDto>(
      `/api/v2/requirements/${encodeURIComponent(requirementId)}`,
      options.signal === undefined ? {} : { signal: options.signal },
    ),

  getRequirementByNumber: (projectId: string, number: number) =>
    request<RequirementDetailItemDto>(
      `/api/v2/projects/${encodeURIComponent(projectId)}/requirements/by-number/${String(number)}`,
    ),

  listRequirementActivity: (
    requirementId: string,
    query: { cursor?: string; limit?: number } = {},
    options: { signal?: AbortSignal } = {},
  ) =>
    request<ListRequirementActivityResponse>(
      `/api/v2/requirements/${encodeURIComponent(requirementId)}/activity${queryString(query)}`,
      options.signal === undefined ? {} : { signal: options.signal },
    ),

  listUsers: () => request<ListUsersResponse>("/api/v2/users"),

  /** 记下「读到这儿了」（个人状态，打开需求详情时调用）。 */
  markRequirementRead: (requirementId: string, body: { upTo?: string } = {}) =>
    request<void>(`/api/v2/requirements/${encodeURIComponent(requirementId)}/read`, {
      method: "PUT",
      body,
      expectedStatus: 204,
    }),

  updateRequirement: (requirementId: string, body: UpdateRequirementRequest) =>
    request<RequirementListItemDto>(
      `/api/v2/requirements/${encodeURIComponent(requirementId)}`,
      { method: "PATCH", body },
    ),

  listRequirementComments: (
    requirementId: string,
    query: { cursor?: string; limit?: number } = {},
  ) =>
    request<ListCommentsResponse>(
      `/api/v2/requirements/${encodeURIComponent(requirementId)}/comments${queryString(query)}`,
    ),

  createRequirementComment: (requirementId: string, body: CreateCommentRequest) =>
    request<RequirementsCommentDto>(
      `/api/v2/requirements/${encodeURIComponent(requirementId)}/comments`,
      { method: "POST", body },
    ),

  listRequirementsAudit: (
    query: {
      resourceId?: string;
      resourceType?: AuditResourceType;
      projectId?: string;
      cursor?: string;
      limit?: number;
    } = {},
  ) =>
    request<ListAuditResponse>(`/api/v2/audit${queryString(query)}`),

  getProjectStats: (projectId: string, query: ProjectStatsQuery) =>
    request<ProjectStatsResponse>(
      `/api/v2/projects/${encodeURIComponent(projectId)}/stats${queryString({
        window: query.window,
        tz: query.tz,
      })}`,
    ),

  getMyWorkbench: () => request<MyWorkbenchResponse>("/api/v2/my/workbench"),

  listRequirementAttachments: (requirementId: string) =>
    request<ListAttachmentsResponse>(
      `/api/v2/requirements/${encodeURIComponent(requirementId)}/attachments`,
    ),

  listArtifactVersions: (requirementId: string) =>
    request<ListArtifactVersionsResponse>(
      `/api/v2/requirements/${encodeURIComponent(requirementId)}/artifact-versions`,
    ),

  publishArtifactVersion: (requirementId: string, body: PublishArtifactVersionRequest) =>
    request<ArtifactVersionDetailDto>(
      `/api/v2/requirements/${encodeURIComponent(requirementId)}/artifact-versions`,
      { method: "POST", body },
    ),

  getArtifactVersion: (versionId: string) =>
    request<ArtifactVersionDetailDto>(
      `/api/v2/artifact-versions/${encodeURIComponent(versionId)}`,
    ),

  artifactVersionFileDownloadUrl: (versionId: string, fileId: string) =>
    `/api/v2/artifact-versions/${encodeURIComponent(versionId)}/files/${encodeURIComponent(fileId)}/content`,

  uploadRequirementAttachment: (
    requirementId: string,
    file: File,
    idempotencyKey: string,
    onProgress: (percent: number) => void,
    signal?: AbortSignal,
  ) => uploadRequirementAttachment(
    requirementId,
    file,
    idempotencyKey,
    onProgress,
    signal,
  ),

  requirementAttachmentDownloadUrl: (attachmentId: string) =>
    `/api/v2/attachments/${encodeURIComponent(attachmentId)}/content`,

  deleteRequirementAttachment: (attachmentId: string) =>
    request<AttachmentMutationResponse>(
      `/api/v2/attachments/${encodeURIComponent(attachmentId)}/content`,
      { method: "DELETE" },
    ),

  /** 需求与房间的推送流（EventSource 带不了请求头，界面语言放在地址上；每次重连都按当时的语言重新拼）。 */
  requirementsEventsUrl: () => withLocaleParam("/api/v2/events"),

  listRequirementsMappings: () =>
    request<{ items: RequirementsWorkspaceMappingDto[] }>("/api/v2/project-mappings"),

  saveRequirementsMapping: (projectId: string, rootPath: string) =>
    request<RequirementsWorkspaceMappingDto>(
      `/api/v2/projects/${encodeURIComponent(projectId)}/workspace-mapping`,
      { method: "PUT", body: { rootPath } },
    ),

  listLocalDirs: (path?: string, options: { hidden?: boolean; signal?: AbortSignal } = {}) =>
    request<LocalDirectoryListingDto>(
      `/api/v2/local/dirs${queryString({
        ...(path === undefined ? {} : { path }),
        ...(options.hidden === true ? { hidden: "1" } : {}),
      })}`,
      options.signal === undefined ? {} : { signal: options.signal },
    ),

  inspectLocalDir: (path: string, options: { signal?: AbortSignal } = {}) =>
    request<LocalPathInspectionDto>(
      `/api/v2/local/dirs/inspect${queryString({ path })}`,
      options.signal === undefined ? {} : { signal: options.signal },
    ),

  /** pr5：试一个**尚未保存**的需求服务地址，不写入任何配置。 */
  testRequirementsSettings: (baseUrl: string) =>
    request<{ baseUrl: string; reachable: boolean; message: string; version: string | null }>(
      "/api/v2/requirements/settings/test",
      { method: "POST", body: { baseUrl } },
    ),

  /** pr5：`verify=1` 只读复验各映射目录的存在性与 R/W/X，无副作用。 */
  listRequirementsMappingsVerified: () =>
    request<{
      items: (RequirementsWorkspaceMappingDto & {
        verification: WorkspaceMappingVerification;
      })[];
    }>("/api/v2/project-mappings?verify=1"),

  /** pr5：用系统编辑器打开 `CODEX_HOME/config.toml`；目标由服务端固定，不接受任意路径。 */
  openCodexConfigFile: () =>
    request<{ opened: boolean; path: string }>("/api/v1/codex/config-file/open", {
      method: "POST",
      body: {},
    }),

  /** pr14：用当前或草稿代理试连模型网关；401 表示网关可达仅缺凭据。 */
  testProxySettings: (draft: {
    httpProxy?: string;
    httpsProxy?: string;
    allProxy?: string;
    noProxy?: string;
  }) =>
    request<ProxyConnectivityDto>("/api/v1/settings/proxy/test", { method: "POST", body: draft }),

  removeRequirementsMapping: (projectId: string) =>
    request(
      `/api/v2/projects/${encodeURIComponent(projectId)}/workspace-mapping`,
      { method: "DELETE", expectedStatus: 204 },
    ),

  createRequirementsSession: (requirementId: string) =>
    request<SessionDto>(
      `/api/v2/requirements/${encodeURIComponent(requirementId)}/sessions`,
      { method: "POST", body: {} },
    ),

  createRequirementsProjectSession: (projectId: string) =>
    request<SessionDto>(
      `/api/v2/projects/${encodeURIComponent(projectId)}/sessions`,
      { method: "POST", body: {} },
    ),

  listRequirementsSessions: (projectId: string) =>
    request<{ items: RequirementsSessionReferenceDto[] }>(
      `/api/v2/projects/${encodeURIComponent(projectId)}/sessions`,
    ),

  listProjects: () => request<ListProjectsResponse>("/api/v1/projects"),

  createProject: (rootPath: string, name?: string) =>
    request<ProjectDto>("/api/v1/projects", {
      method: "POST",
      body: { rootPath, ...(name ? { name } : {}) },
    }),

  listSessions: (projectId: string) =>
    request<ListSessionsResponse>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/sessions?state=all`,
    ),

  createSession: (
    projectId: string,
    title: string,
    options: { purpose?: CreateSessionRequest["purpose"] } = {},
  ) =>
    request<SessionDto>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/sessions`,
      {
        method: "POST",
        body: {
          title,
          ...(options.purpose ? { purpose: options.purpose } : {}),
        },
      },
    ),

  /**
   * 本机会话列表（P3b）：按最后活动时间倒序，带项目、关联需求、最后一句与运行态。
   * 带 remoteProjectId 只列这个项目的会话，不带则跨本机所有项目。
   */
  listAllSessions: (
    query: {
      state?: "active" | "archived" | "all";
      kind?: SessionKind;
      remoteProjectId?: string;
      cursor?: string;
      limit?: number;
    } = {},
    options: { signal?: AbortSignal } = {},
  ) =>
    request<ListAllSessionsResponse>(
      `/api/v1/sessions${queryString({
        ...(query.state === undefined ? {} : { state: query.state }),
        // 不带 kind = 普通会话；room_task = 房间共享 Agent 在本机执行任务的会话（所有者视角）。
        ...(query.kind === undefined ? {} : { kind: query.kind }),
        ...(query.remoteProjectId === undefined ? {} : { remoteProjectId: query.remoteProjectId }),
        ...(query.cursor === undefined ? {} : { cursor: query.cursor }),
        ...(query.limit === undefined ? {} : { limit: String(query.limit) }),
      })}`,
      options.signal === undefined ? {} : { signal: options.signal },
    ),

  listRunStatus: (projectId: string) =>
    request<SessionRunStatusResponse>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/sessions/run-status`,
    ),

  getSession: (sessionId: string) =>
    request<SessionDto>(`/api/v1/sessions/${encodeURIComponent(sessionId)}`),

  backfillSessionEvents: (
    sessionId: string,
    input: { after: number; until: number; limit: number },
  ) =>
    request<EventEnvelope<string, JsonValue>[]>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/events/backfill${queryString({
        after: String(input.after),
        until: String(input.until),
        limit: String(input.limit),
      })}`,
    ),

  /** 后写生效（ADR-0004）：不带 If-Match。 */
  updateSession: (sessionId: string, body: UpdateSessionRequest) =>
    request<SessionDto>(`/api/v1/sessions/${encodeURIComponent(sessionId)}`, {
      method: "PATCH",
      body,
    }),

  deleteSession: (sessionId: string) =>
    request<void>(`/api/v1/sessions/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
      expectedStatus: 204,
    }),

  sendMessage: (sessionId: string, body: SendMessageRequest) =>
    request<SendMessageAccepted>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/messages`,
      { method: "POST", body },
    ),

  /** 会话关联的 SuDuo 上下文（需求 / 项目 / 无，新版或旧版需求会话）。 */
  getSessionContext: (sessionId: string) =>
    request<SessionContextDto>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/context`,
    ),

  /** PR3：传前端投影认定的运行回合，不再让服务端从账本猜唯一运行回合。 */
  interrupt: (sessionId: string, body: InterruptRequest = {}) =>
    request<InterruptAccepted>(`/api/v1/sessions/${encodeURIComponent(sessionId)}/interrupt`, {
      method: "POST",
      body,
    }),

  listApprovals: (sessionId: string, status = "pending") =>
    request<ListApprovalsResponse>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/approvals?status=${status}`,
    ),

  decideApproval: (
    approvalId: string,
    decision: "accept" | "acceptForSession" | "decline" | "cancel",
  ) =>
    request<ApprovalDto>(
      `/api/v1/approvals/${encodeURIComponent(approvalId)}/decision`,
      { method: "POST", body: { decision } },
    ),

  listFiles: (projectId: string, path = "") =>
    request<ListFilesResponse>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/files?path=${encodeURIComponent(path)}`,
    ),

  fileIndex: (projectId: string) =>
    request<FileIndexResponse>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/files/index`,
    ),

  /** line 只对 vscode 生效：打开后跳到这一行。 */
  openFile: (projectId: string, path: string, mode: SystemOpenTarget, line?: number | null) =>
    request(`/api/v1/projects/${encodeURIComponent(projectId)}/files/open`, {
      method: "POST",
      body: { path, mode, ...(line === undefined || line === null ? {} : { line }) },
      expectedStatus: 204,
    }),

  /** 批量确认项目内文件是否存在（会话回答里的路径要不要变成链接）；一次最多 200 条。 */
  existingFiles: (projectId: string, paths: readonly string[]) =>
    request<ExistingFilesResponse>(`/api/v1/projects/${encodeURIComponent(projectId)}/files/exists`, {
      method: "POST",
      body: { paths },
      // 只读查询：不带幂等键。
      idempotent: false,
    }),

  openTargets: () =>
    request<OpenTargetsResponse>("/api/v1/system/open-targets"),

  fileRawUrl: (projectId: string, path: string) =>
    `/api/v1/projects/${encodeURIComponent(projectId)}/files/raw?path=${encodeURIComponent(path)}`,

  gitStatus: (projectId: string) =>
    request<GitStatusDto>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/git/status`,
    ),

  gitInit: (projectId: string) =>
    request<GitStatusDto>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/git/init`,
      { method: "POST", body: {} },
    ),

  gitCheckpoint: (projectId: string, message?: string) =>
    request<{ checkpoint: GitCheckpointDto | null }>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/git/checkpoint`,
      { method: "POST", body: message === undefined ? {} : { message } },
    ),

  gitCheckpoints: (projectId: string) =>
    request<ListGitCheckpointsResponse>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/git/checkpoints`,
    ),

  gitRestore: (projectId: string, hash: string) =>
    request<GitStatusDto>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/git/restore`,
      { method: "POST", body: { hash } },
    ),

  gitSettings: (projectId: string, autoCheckpoint: boolean) =>
    request<GitStatusDto>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/git/settings`,
      { method: "POST", body: { autoCheckpoint } },
    ),

  getSettings: () => request<SettingsDto>("/api/v1/settings"),

  modelProvider: () =>
    request<ModelProviderSettingsDto>("/api/v1/settings/model-provider"),

  updateModelProvider: (body: UpdateModelProviderRequest) =>
    request<UpdateModelProviderResult>("/api/v1/settings/model-provider", {
      method: "PUT",
      body,
    }),

  codexModels: () => request<CodexModelsResponse>("/api/v1/codex/models"),

  /** pr3 建的全局状态投影 SSE；pr10 的顶部状态条订阅它。EventSource 带不了请求头，界面语言放在地址上。 */
  codexStatusUrl: () => withLocaleParam("/api/v1/codex/status"),

  // ── pr11 的 MCP 后端；pr12 界面只消费这些，不在前端自建替代实现（R3）。
  listMcpServers: () =>
    request<{ items: McpServerDto[]; statusAvailable: boolean }>("/api/v1/mcp/servers"),

  createMcpServer: (body: {
    name: string;
    transport:
      | { type: "stdio"; command: string; args?: string[]; envVars?: string[] }
      | { type: "http"; url: string; bearerTokenEnvVar?: string | null };
    enabled?: boolean;
  }) =>
    request<{ server: McpServerDto; atomic: boolean; message: string }>(
      "/api/v1/mcp/servers",
      { method: "POST", body },
    ),

  updateMcpServer: (
    name: string,
    body: {
      transport?:
        | { type: "stdio"; command: string; args?: string[]; envVars?: string[] }
        | { type: "http"; url: string; bearerTokenEnvVar?: string | null };
      enabled?: boolean;
      envVars?: string[];
    },
  ) =>
    request<{ server: McpServerDto; atomic: boolean; message: string }>(
      `/api/v1/mcp/servers/${encodeURIComponent(name)}`,
      { method: "PATCH", body },
    ),

  removeMcpServer: (name: string) =>
    request<{ removed: true }>(`/api/v1/mcp/servers/${encodeURIComponent(name)}`, {
      method: "DELETE",
    }),

  /** 返回授权 URL 交前端打开——内网无浏览器的机器上用户可自行复制。 */
  loginMcpServer: (name: string) =>
    request<{ authorizationUrl: string }>(
      `/api/v1/mcp/servers/${encodeURIComponent(name)}/login`,
      { method: "POST", body: {} },
    ),

  logoutMcpServer: (name: string) =>
    request(`/api/v1/mcp/servers/${encodeURIComponent(name)}/logout`, {
      method: "POST",
      body: {},
    }),

  /** 测试全部连通性 = reload + 复检。 */
  refreshMcpServers: () =>
    request<{ items: McpServerDto[]; statusAvailable: boolean }>("/api/v1/mcp/refresh", {
      method: "POST",
      body: {},
    }),

  /** pr9：设置页内嵌自检卡片用的 JSON 读取（HTML /doctor 页仍保留）。 */
  runDoctor: () => request<DoctorResultDto>("/api/v1/doctor"),

  updateSettings: (body: UpdateSettingsRequest) =>
    request<SettingsDto>("/api/v1/settings", { method: "PATCH", body }),

  globalSkills: () =>
    request<{ items: SkillDto[]; root: string }>("/api/v1/skills/global"),

  installSkill: (body: InstallSkillRequest) =>
    request<{ skill: SkillDto }>("/api/v1/skills/install", {
      method: "POST",
      body,
    }),

  removeSkill: (path: string) =>
    request("/api/v1/skills/remove", {
      method: "POST",
      body: { path },
      expectedStatus: 204,
    }),

  skillCatalog: (projectId: string) =>
    request<SkillCatalogResponse>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/skills/catalog`,
    ),

  setSkillEnabled: (name: string, enabled: boolean) =>
    request("/api/v1/skills/enabled", {
      method: "POST",
      body: { name, enabled },
      expectedStatus: 204,
    }),

  readFile: (projectId: string, path: string) =>
    request<FileContentDto>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/files/content?path=${encodeURIComponent(path)}`,
    ),

  uploadAttachment: (
    projectId: string,
    mediaType: string,
    dataBase64: string,
  ) =>
    request<AttachmentDto>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/attachments`,
      { method: "POST", body: { mediaType, dataBase64 } },
    ),

  listSkills: (projectId: string) =>
    request<ListSkillsResponse>(
      `/api/v1/projects/${encodeURIComponent(projectId)}/skills`,
    ),

  listChanges: (sessionId: string) =>
    request<WorkspaceChanges>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/changes`,
    ),

  diff: (sessionId: string, path: string) =>
    request<WorkspaceDiff>(
      `/api/v1/sessions/${encodeURIComponent(sessionId)}/diff?path=${encodeURIComponent(path)}`,
    ),

  // ── 项目聊天房间与共享 Agent（需求 suduo-v2-rooms-shared-agent-001）。
  // 浏览器只访问本机 /api/v2/*，本机服务一比一转发远程同名 /v2/* 端点；/agents/self 是本机专有。

  listProjectRooms: (projectId: string, options: { signal?: AbortSignal } = {}) =>
    request<ListRoomsResponse>(
      `/api/v2/projects/${encodeURIComponent(projectId)}/rooms`,
      options.signal === undefined ? {} : { signal: options.signal },
    ),

  listRequirementRooms: (requirementId: string, options: { signal?: AbortSignal } = {}) =>
    request<ListRoomsResponse>(
      `/api/v2/requirements/${encodeURIComponent(requirementId)}/rooms`,
      options.signal === undefined ? {} : { signal: options.signal },
    ),

  createRequirementRoom: (requirementId: string, body: CreateRequirementRoomRequest) =>
    request<RoomDto>(`/api/v2/requirements/${encodeURIComponent(requirementId)}/rooms`, {
      method: "POST",
      body,
    }),

  getRoom: (roomId: string, options: { signal?: AbortSignal } = {}) =>
    request<RoomDto>(
      `/api/v2/rooms/${encodeURIComponent(roomId)}`,
      options.signal === undefined ? {} : { signal: options.signal },
    ),

  /** 改名、归档 / 取消归档（默认房间不能改名）。 */
  updateRoom: (roomId: string, body: UpdateRoomRequest) =>
    request<RoomDto>(`/api/v2/rooms/${encodeURIComponent(roomId)}`, { method: "PATCH", body }),

  listRoomMembers: (roomId: string, options: { signal?: AbortSignal } = {}) =>
    request<ListRoomMembersResponse>(
      `/api/v2/rooms/${encodeURIComponent(roomId)}/members`,
      options.signal === undefined ? {} : { signal: options.signal },
    ),

  /** 加入（不带 userIds）或拉人。 */
  addRoomMembers: (roomId: string, body: AddRoomMembersRequest = {}) =>
    request<unknown>(`/api/v2/rooms/${encodeURIComponent(roomId)}/members`, { method: "POST", body }),

  /** 记已读：只会前进，回退按「位置不变」处理；返回记完后的「我的视角」（未读、@ 未读）。 */
  markRoomRead: (roomId: string, upToSeq: number) =>
    request<RoomViewerStateDto | undefined>(`/api/v2/rooms/${encodeURIComponent(roomId)}/read`, {
      method: "POST",
      body: { upToSeq },
    }),

  listRoomMessages: (
    roomId: string,
    query: ListRoomMessagesQuery = {},
    options: { signal?: AbortSignal } = {},
  ) =>
    request<ListRoomMessagesResponse>(
      `/api/v2/rooms/${encodeURIComponent(roomId)}/messages${queryString({
        after: query.after,
        before: query.before,
        threadRootId: query.threadRootId,
        limit: query.limit,
      })}`,
      options.signal === undefined ? {} : { signal: options.signal },
    ),

  /**
   * 发消息（新消息 201，按 clientId 合并的重试 200，都返回那条消息）：
   * 重试一律带同一个 clientId，服务端按 (room, clientId) 合并返回已有那条（ADR-0004 合并）。
   * Idempotency-Key 每次随机：本机服务会把失败也记在幂等键下，沿用会让重试永远拿到旧的失败。
   */
  sendRoomMessage: (roomId: string, body: SendRoomMessageRequest) =>
    request<RoomMessageDto>(`/api/v2/rooms/${encodeURIComponent(roomId)}/messages`, {
      method: "POST",
      body,
    }),

  uploadRoomFile: (
    roomId: string,
    file: File,
    onProgress: (percent: number) => void,
    signal?: AbortSignal,
  ) => uploadRoomFile(roomId, file, onProgress, signal),

  /** 房间文件地址：inline = 浏览器里直接看（图片、视频），否则下载。视频播放靠 Range 分段。 */
  roomFileUrl: (fileId: string, disposition: "inline" | "attachment" = "attachment") =>
    `/api/v2/room-files/${encodeURIComponent(fileId)}/content${disposition === "inline" ? "?disposition=inline" : ""}`,

  listAgents: (options: { signal?: AbortSignal } = {}) =>
    request<ListAgentsResponse>(
      "/api/v2/agents",
      options.signal === undefined ? {} : { signal: options.signal },
    ),

  /** 本机 Agent 的登记状态（本机服务专有，不经远程转发）。 */
  getSelfAgent: (options: { signal?: AbortSignal } = {}) =>
    request<LocalAgentStateDto>(
      "/api/v2/agents/self",
      options.signal === undefined ? {} : { signal: options.signal },
    ),

  listRoomShares: (roomId: string, options: { signal?: AbortSignal } = {}) =>
    request<ListAgentSharesResponse>(
      `/api/v2/rooms/${encodeURIComponent(roomId)}/shares`,
      options.signal === undefined ? {} : { signal: options.signal },
    ),

  /** 开启共享；已开着时按新时长改（合并，不报错）。 */
  openAgentShare: (roomId: string, body: OpenAgentShareRequest) =>
    request<AgentShareDto>(`/api/v2/rooms/${encodeURIComponent(roomId)}/shares`, {
      method: "POST",
      body,
    }),

  closeAgentShare: (shareId: string) =>
    request<unknown>(`/api/v2/agent-shares/${encodeURIComponent(shareId)}/close`, {
      method: "POST",
      body: {},
    }),

  listShareRequests: (roomId: string, options: { signal?: AbortSignal } = {}) =>
    request<ListAgentShareRequestsResponse>(
      `/api/v2/rooms/${encodeURIComponent(roomId)}/share-requests`,
      options.signal === undefined ? {} : { signal: options.signal },
    ),

  /** 申请共享（重复申请合并成同一条）。 */
  requestAgentShare: (roomId: string, agentId: string) =>
    request<AgentShareRequestDto>(`/api/v2/rooms/${encodeURIComponent(roomId)}/share-requests`, {
      method: "POST",
      body: { agentId },
    }),

  resolveShareRequest: (requestId: string, body: ResolveAgentShareRequestRequest) =>
    request<unknown>(`/api/v2/share-requests/${encodeURIComponent(requestId)}/resolve`, {
      method: "POST",
      body,
    }),

  getAgentRun: (runId: string, options: { signal?: AbortSignal } = {}) =>
    request<AgentRunDetailDto>(
      `/api/v2/agent-runs/${encodeURIComponent(runId)}`,
      options.signal === undefined ? {} : { signal: options.signal },
    ),

  /** 停止：触发人或 Agent 所有者。 */
  stopAgentRun: (runId: string) =>
    request<AgentRunSummaryDto>(`/api/v2/agent-runs/${encodeURIComponent(runId)}/stop`, {
      method: "POST",
      body: {},
    }),

  /** 重试：触发人；复用同一个任务行。 */
  retryAgentRun: (runId: string) =>
    request<AgentRunSummaryDto>(`/api/v2/agent-runs/${encodeURIComponent(runId)}/retry`, {
      method: "POST",
      body: {},
    }),
};

/** 房间文件上传（multipart 单文件 `file`），XHR 拿上传进度；取消抛 AbortError。 */
function uploadRoomFile(
  roomId: string,
  file: File,
  onProgress: (percent: number) => void,
  signal?: AbortSignal,
): Promise<RoomFileDto> {
  if (file.size > ROOM_FILE_MAX_BYTES) {
    return Promise.reject(new ApiClientError(413, "ROOM_FILE_TOO_LARGE", uploadText().tooLarge));
  }
  if (signal?.aborted === true) return Promise.reject(uploadAbortError());
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open("POST", `/api/v2/rooms/${encodeURIComponent(roomId)}/files`);
    request.setRequestHeader("Accept", "application/json");
    request.setRequestHeader(LOCALE_HEADER, currentLocale());
    request.setRequestHeader("X-Attachment-Size", String(file.size));
    request.setRequestHeader("Idempotency-Key", crypto.randomUUID());
    request.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(Math.min(99, Math.round((event.loaded / event.total) * 100)));
      }
    };
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      trackInflight(-1);
    };
    request.onload = () => {
      finish();
      const payload = parseJsonRecord(request.responseText);
      if (request.status >= 200 && request.status < 300) {
        onProgress(100);
        resolve(payload as unknown as RoomFileDto);
        return;
      }
      const error = payload?.["error"];
      const details = error && typeof error === "object" && !Array.isArray(error)
        ? error as Record<string, unknown>
        : null;
      reject(
        new ApiClientError(
          request.status,
          typeof details?.["code"] === "string" ? details["code"] : "HTTP_ERROR",
          typeof details?.["message"] === "string" ? details["message"] : `HTTP ${String(request.status)}`,
        ),
      );
    };
    request.onerror = () => {
      finish();
      reject(new ApiClientError(0, "NETWORK_ERROR", uploadText().fileInterrupted));
    };
    request.onabort = () => {
      finish();
      reject(signal?.aborted === true ? uploadAbortError() : new ApiClientError(0, "NETWORK_ERROR", uploadText().fileCancelled));
    };
    signal?.addEventListener("abort", () => request.abort(), { once: true });
    const form = new FormData();
    form.append("file", file, file.name);
    trackInflight(1);
    request.send(form);
  });
}

function queryString(
  query: Record<string, string | number | boolean | undefined>,
): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      search.set(key, String(value));
    }
  }
  const rendered = search.toString();
  return rendered === "" ? "" : `?${rendered}`;
}

function uploadRequirementAttachment(
  requirementId: string,
  file: File,
  idempotencyKey: string,
  onProgress: (percent: number) => void,
  signal?: AbortSignal,
): Promise<AttachmentMutationResponse> {
  if (file.size > REQUIREMENT_ATTACHMENT_MAX_BYTES) {
    return Promise.reject(
      new ApiClientError(413, "ATTACHMENT_TOO_LARGE", uploadText().tooLarge),
    );
  }
  if (signal?.aborted === true) return Promise.reject(uploadAbortError());
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open(
      "POST",
      `/api/v2/requirements/${encodeURIComponent(requirementId)}/attachments`,
    );
    request.setRequestHeader("Accept", "application/json");
    request.setRequestHeader(LOCALE_HEADER, currentLocale());
    request.setRequestHeader("X-Attachment-Size", String(file.size));
    request.setRequestHeader("Idempotency-Key", idempotencyKey);
    request.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(Math.min(99, Math.round((event.loaded / event.total) * 100)));
      }
    };
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      trackInflight(-1);
    };
    request.onload = () => {
      finish();
      const payload = parseJsonRecord(request.responseText);
      if (request.status >= 200 && request.status < 300) {
        onProgress(100);
        resolve(payload as unknown as AttachmentMutationResponse);
        return;
      }
      const error = payload?.["error"];
      const details = error && typeof error === "object" && !Array.isArray(error)
        ? error as Record<string, unknown>
        : null;
      reject(
        new ApiClientError(
          request.status,
          typeof details?.["code"] === "string" ? details["code"] : "HTTP_ERROR",
          typeof details?.["message"] === "string"
            ? details["message"]
            : `HTTP ${String(request.status)}`,
        ),
      );
    };
    request.onerror = () => {
      finish();
      reject(new ApiClientError(0, "NETWORK_ERROR", uploadText().attachmentInterrupted));
    };
    request.onabort = () => {
      finish();
      reject(
        signal?.aborted === true
          ? uploadAbortError()
          : new ApiClientError(0, "NETWORK_ERROR", uploadText().attachmentCancelled),
      );
    };
    signal?.addEventListener("abort", () => request.abort(), { once: true });
    const form = new FormData();
    form.append("file", file, file.name);
    trackInflight(1);
    request.send(form);
  });
}

/** 单个附件的上限（与需求服务一致）。 */
export const REQUIREMENT_ATTACHMENT_MAX_BYTES = 314_572_800;

/** 用户主动取消上传：与 fetch 被中止一致，抛 AbortError，调用方据此区分「取消」和「失败」。 */
function uploadAbortError(): DOMException {
  return new DOMException(uploadText().cancelled, "AbortError");
}

/** 上传在本地就失败时的说明：按出错那一刻的界面语言取。 */
function uploadText() {
  return messagesFor(currentLocale()).workbench.upload;
}

function parseJsonRecord(value: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

interface RequestOptions {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  body?: unknown;
  idempotent?: boolean;
  expectedStatus?: number;
  headers?: Record<string, string>;
  /** 取消在途请求；pr7 切项目时用它掐掉各列的并发拉取。纯追加，不影响既有调用方。 */
  signal?: AbortSignal;
}

async function request<T = unknown>(
  path: string,
  options: RequestOptions = {},
): Promise<T> {
  const method = options.method ?? "GET";
  const headers: Record<string, string> = {
    Accept: "application/json",
    // 本机服务按它生成错误与提示，并记下当前界面语言供后台任务使用（中英双语技术设计 §4.1）。
    [LOCALE_HEADER]: currentLocale(),
    ...options.headers,
  };
  if (options.body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  // 调用方传入稳定 key（如不可逆评论）时必须原样保留，不能每次重试换 key。
  if (
    method !== "GET" && options.idempotent !== false &&
    !Object.keys(headers).some((name) => name.toLowerCase() === "idempotency-key")
  ) {
    headers["Idempotency-Key"] = crypto.randomUUID();
  }
  trackInflight(1);
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      headers,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.body === undefined
        ? {}
        : { body: JSON.stringify(options.body) }),
    });
    markRequestReachedServer();
  } catch (cause) {
    markRequestNetworkFailure(cause);
    throw cause;
  } finally {
    trackInflight(-1);
  }
  const expected = options.expectedStatus;
  if (!response.ok && response.status !== expected) {
    const payload = await response.json().catch(() => null) as {
      error?: { code?: string; message?: string };
    } | null;
    throw new ApiClientError(
      response.status,
      payload?.error?.code ?? "HTTP_ERROR",
      payload?.error?.message ?? `HTTP ${String(response.status)}`,
    );
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return response.json() as Promise<T>;
}
