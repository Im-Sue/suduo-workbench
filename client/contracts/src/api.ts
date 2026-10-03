import type {
  EventEnvelope,
  JsonValue,
  ThreadRef,
  TurnRef,
} from "./events.js";
import type { ApprovalMode, ReasoningEffort } from "./config.js";
import type { CheckpointKind, Locale } from "./i18n.js";

export type ErrorCode =
  | "VALIDATION_ERROR"
  | "NOT_FOUND"
  | "ORIGIN_REJECTED"
  | "IDEMPOTENCY_CONFLICT"
  | "IDEMPOTENCY_INDETERMINATE"
  | "VERSION_CONFLICT"
  | "PROJECT_HAS_ACTIVE_SESSIONS"
  | "SESSION_NOT_ACTIVE"
  | "SESSION_PROJECT_MISMATCH"
  | "SESSION_HAS_NO_PRIMARY_THREAD"
  | "SESSION_PRIMARY_THREAD_AMBIGUOUS"
  | "APPROVAL_NOT_PENDING"
  | "APPROVAL_ALREADY_DECIDED"
  | "RUNTIME_UNAVAILABLE"
  | "RUNTIME_REQUEST_FAILED"
  | "SHUTDOWN_UNAVAILABLE";

export interface ErrorResponse {
  error: {
    code: ErrorCode;
    message: string;
    requestId: string;
    details?: Record<string, unknown>;
  };
}

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
}

export interface CursorQuery {
  cursor?: string;
  limit?: number;
}

export interface CreateProjectRequest {
  rootPath: string;
  name?: string;
}

export interface ProjectDto {
  id: string;
  name: string;
  rootPath: string;
  state: "active" | "removed";
  createdAt: number;
  updatedAt: number;
  lastOpenedAt: number | null;
  version: number;
}

export interface ListProjectsQuery extends CursorQuery {
  state?: "active" | "removed" | "all";
}

export type ListProjectsResponse = CursorPage<ProjectDto>;

export interface UpdateProjectRequest {
  name?: string;
  state?: "active";
}

export interface ThreadBindingDto {
  bindingId: string;
  threadRef: ThreadRef;
  role: string;
  ordinal: number;
  primary: boolean;
  state: "attached" | "detached" | "error";
}

export interface SessionDto {
  id: string;
  projectId: string;
  title: string;
  state: "starting" | "active" | "error" | "archived" | "deleted";
  /** 会话用途只用于展示和快捷入口，不形成业务任务或独立状态。 */
  purpose: SessionPurpose;
  /** 会话级审批模式，切换后下个回合生效。 */
  approvalMode: ApprovalMode;
  /**
   * 会话级模型，切换后下个回合生效；null = 跟随全局默认
   * （Codex config.toml 的 model，未配置时为 model/list 的默认模型）。
   */
  model: string | null;
  /**
   * 会话级推理强度，切换后下个回合生效；null = 跟随全局默认
   * （config.toml 的 model_reasoning_effort，未配置时为模型自身默认）。
   */
  reasoningEffort: ReasoningEffort | null;
  /**
   * normal = 普通会话；room_task = 共享 Agent 在所有者本机执行房间 @ 任务的隐藏会话（ADR-0009），
   * 由房间触发、回答发回房间，会话页只读。
   */
  kind: SessionKind;
  createdAt: number;
  updatedAt: number;
  lastActivityAt: number | null;
  version: number;
  threads: ThreadBindingDto[];
}

export type SessionPurpose =
  | "general"
  | "pm_requirement"
  | "backend"
  | "fe_ui"
  | "fe_connect"
  | "test";

export interface CreateSessionRequest {
  title?: string;
  runtimeId?: string;
  purpose?: SessionPurpose;
}

export interface ListSessionsQuery extends CursorQuery {
  state?: "active" | "archived" | "deleted" | "all";
}

export type ListSessionsResponse = CursorPage<SessionDto>;

/**
 * PATCH /api/v1/sessions/:sessionId。后写生效（ADR-0004）：If-Match 即使带了也不比对。
 */
export interface UpdateSessionRequest {
  title?: string;
  state?: "active" | "archived";
  approvalMode?: ApprovalMode;
  purpose?: SessionPurpose;
  /** 显式模型（1–128 位，字母数字与 . _ : / -）；null = 恢复跟随全局默认。 */
  model?: string | null;
  /** 显式推理强度（REASONING_EFFORTS 之一）；null = 恢复跟随全局默认。 */
  reasoningEffort?: ReasoningEffort | null;
}

/**
 * 会话运行态摘要：供左栏全列表徽标准确显示，服务端由账本与审批表推导，
 * 避免为每个会话单开 SSE。与 SessionDto.state（生命周期）是两个维度。
 */
export interface SessionRunStatusDto {
  sessionId: string;
  /** 有进行中的回合。 */
  running: boolean;
  pendingApprovals: number;
  /** 最近一个回合的结局；从未跑过回合为 null。 */
  lastTurnOutcome: "completed" | "failed" | "interrupted" | null;
  lastActivityAt: number | null;
}

export interface SessionRunStatusResponse {
  items: SessionRunStatusDto[];
}

/** GET /api/v1/sessions 的查询参数（默认跨本机所有项目，可按远程项目过滤）。 */
export interface ListAllSessionsQuery extends CursorQuery {
  /** active = 启动中 / 活动 / 出错；archived = 已归档；all = 二者合并（不含已删除）。默认 active。 */
  state?: "active" | "archived" | "all";
  /**
   * normal = 普通会话（默认）；room_task = 房间共享 Agent 在本机执行任务的隐藏会话
   * （需求「项目聊天房间与共享 Agent」4.5 所有者视角）。
   */
  kind?: SessionKind;
  /**
   * 只列这个远程项目的会话：需求会话按需求所属项目、房间任务按房间所属项目、其余按代码目录映射；
   * 不属于任何远程项目的会话不出现。缺省不按项目过滤。
   */
  remoteProjectId?: string;
}

/** 会话种类：普通会话 / 房间任务会话。 */
export type SessionKind = "normal" | "room_task";

/** 房间任务会话对应的房间话题（kind=room_task 时给出）。 */
export interface SessionRoomTaskDto {
  remoteProjectId: string;
  roomId: string;
  roomName: string;
  threadRootId: string;
  /** 最近一次被 @ 的任务。 */
  lastRunId: string | null;
}

/** 会话所属本机项目；remoteProjectId 取需求会话引用，否则取项目映射，无关联为 null。 */
export interface SessionListProjectDto {
  id: string;
  name: string;
  rootPath: string;
  state: "active" | "removed";
  remoteProjectId: string | null;
}

/** 会话关联的远程需求（创建需求会话时的快照）；旧数据没有快照时 number / title 为 null。 */
export interface SessionListRequirementDto {
  remoteRequirementId: string;
  number: number | null;
  title: string | null;
}

/** 最后一句话：空白已折叠，最长约 120 字（超出以 … 结尾）。 */
export interface SessionMessagePreviewDto {
  role: "user" | "assistant";
  text: string;
}

/** 跨项目会话列表项：在 SessionDto 之上加项目、需求、预览与运行态。 */
export interface SessionListItemDto extends SessionDto {
  project: SessionListProjectDto;
  /** 非需求会话为 null。 */
  requirement: SessionListRequirementDto | null;
  kind: SessionKind;
  /** 非房间任务会话为 null。 */
  roomTask: SessionRoomTaskDto | null;
  /** 还没有任何文字消息时为 null。 */
  preview: SessionMessagePreviewDto | null;
  /** 语义同 SessionRunStatusDto；另带在跑时的开始时间与当前步骤（会话卡片用）。 */
  runStatus: Pick<SessionRunStatusDto, "running" | "pendingApprovals" | "lastTurnOutcome"> & {
    /** 这一轮什么时候开始的（毫秒）；没在跑为 null。 */
    runningSince?: number | null;
    /** 这一轮最近的一步，说成一句话（如「运行命令：npm test」「修改 cart.js」）；没在跑或取不到为 null。 */
    activity?: string | null;
  };
}

/**
 * 按最后活动时间倒序（无活动按创建时间），同刻按 id 升序；nextCursor 为键集游标
 * （排序键 + id）。翻页期间有会话变活跃不会造成重复，但它会移到最前面、本轮后续页不再出现，
 * 需要重新拉第一页才能看到（前端收到会话事件后重取第一页即可）。
 */
export type ListAllSessionsResponse = CursorPage<SessionListItemDto>;

export type MessageContent =
  | { type: "text"; text: string }
  | {
      type: "local-image";
      attachmentId: string;
      detail?: "low" | "high";
    }
  | { type: "image-url"; url: string; detail?: "low" | "high" }
  | { type: "skill"; name: string; path: string };

export interface SendMessageRequest {
  content: MessageContent[];
  targetThreadRef?: ThreadRef;
}

export interface SendMessageAccepted {
  sessionId: string;
  messageEventSeq: number;
  threadRef: ThreadRef;
  /** 运行中发送时这里可能是一个永不出现在事件流里的幽灵 id，仅供诊断，不参与任何归属判定。 */
  turnRef: TurnRef;
  acceptedAt: number;
  /**
   * 发送时生成的关联键（与 message.submitted.payload.clientTurnId 相同）。
   * Codex 会在 userMessage item 里把它连同真正收下这条消息的回合一起报回来，
   * 前端据此解析归属。可选：加法式字段。
   */
  clientTurnId?: string;
}

export type ApprovalKind =
  | "command"
  | "file-change"
  | "permissions"
  | "other";

export type ApprovalStatus =
  | "pending"
  | "deciding"
  | "resolved"
  | "orphaned"
  | "delivery_failed";

export type ApprovalRecordDecision =
  | "accept"
  | "acceptForSession"
  | "decline"
  | "cancel";

export interface ApprovalDto {
  id: string;
  sessionId: string;
  threadRef: ThreadRef;
  turnRef: TurnRef | null;
  kind: ApprovalKind;
  status: ApprovalStatus;
  decision: ApprovalRecordDecision | null;
  request: JsonValue;
  requestedAt: number;
  decidedAt: number | null;
  version: number;
}

export interface ListApprovalsQuery extends CursorQuery {
  status?: "pending" | "history" | "all";
}

export type ListApprovalsResponse = CursorPage<ApprovalDto>;

export interface DecideApprovalRequest {
  decision: "accept" | "acceptForSession" | "decline" | "cancel";
}

export interface InterruptRequest {
  threadRef?: ThreadRef;
  turnId?: string;
}

export interface InterruptAccepted {
  sessionId: string;
  threadRef: ThreadRef;
  turnId: string;
  acceptedAt: number;
}

export interface EventStreamQuery {
  after?: number;
}

export interface SseEventFrame<
  TEvent extends EventEnvelope<string, JsonValue> = EventEnvelope<
    string,
    JsonValue
  >,
> {
  retry?: number;
  id: string;
  event: TEvent["type"];
  data: TEvent;
}

export interface SseHeartbeatFrame {
  comment: string;
}

export type SseFrame<TEvent extends EventEnvelope<string, JsonValue>> =
  | SseEventFrame<TEvent>
  | SseHeartbeatFrame;

export interface ListFilesQuery {
  path?: string;
}

export interface FileEntryDto {
  name: string;
  path: string;
  type: "file" | "directory";
  size: number | null;
  modifiedAt: number | null;
}

export interface ListFilesResponse {
  path: string;
  entries: FileEntryDto[];
}

export interface ReadFileContentQuery {
  path: string;
}

export type FileContentDto =
  | {
      type: "text";
      path: string;
      mediaType: string;
      text: string;
      size: number;
      /** 超大文件仅返回头部预览时为 true。 */
      truncated?: boolean;
    }
  | {
      type: "image";
      path: string;
      mediaType: string;
      url: string;
      size: number;
    }
  | {
      /** 二进制/不可预览文件：不回传内容，前端引导用系统应用打开。 */
      type: "binary";
      path: string;
      mediaType: string;
      size: number;
    };

/** 项目内文件递归索引（供 @ 引用面板），忽略 .git/.suduo/node_modules 等目录。 */
export interface FileIndexResponse {
  items: string[];
  truncated: boolean;
}

/** 「打开位置」目标：系统默认应用 / 文件管理器 / VS Code / 终端。 */
export type SystemOpenTarget = "open" | "reveal" | "vscode" | "terminal";

export interface OpenFileRequest {
  path: string;
  mode: SystemOpenTarget;
  /** 只对 vscode 生效：打开后跳到这一行（从 1 开始）。 */
  line?: number;
}

/** 批量确认项目内文件是否存在（会话回答里的路径要不要变成链接）。最多 200 条。 */
export interface ExistingFilesRequest {
  /** 项目内相对路径。 */
  paths: string[];
}

export interface ExistingFilesResponse {
  /** 请求里确实存在、且是项目目录内普通文件的那些路径（原样返回）。 */
  files: string[];
}

/** 本机可用的打开目标（探测结果）。 */
export interface OpenTargetsResponse {
  targets: SystemOpenTarget[];
}

/** 项目版本管理（git）状态。 */
export interface GitStatusDto {
  /** 本机检测到可用的 git。 */
  available: boolean;
  /** 项目根目录本身是 git 仓库（顶层一致）。 */
  repo: boolean;
  branch: string | null;
  /** 未提交改动的文件数（含未跟踪）。 */
  dirty: number;
  /** 由 SuDuo 一键初始化托管。 */
  managed: boolean;
  /** 回合开始前自动存档开关。 */
  autoCheckpoint: boolean;
  hasRemote: boolean;
  /** 最近一次自动存档失败原因（无则 null）。 */
  lastError: string | null;
}

export interface GitCheckpointDto {
  hash: string;
  subject: string;
  ts: number;
  auto: boolean;
  /** SuDuo 写下的检查点类型（看提交里的标记行，旧提交看标题前缀）；不是 SuDuo 的提交为 null。 */
  kind: CheckpointKind | null;
  /** 手动检查点的说明（标题去掉前缀后的部分）；自动存档与非 SuDuo 提交为 null。 */
  note: string | null;
}

export interface ListGitCheckpointsResponse {
  items: GitCheckpointDto[];
}

export interface GitCheckpointRequest {
  message?: string;
}

export interface GitRestoreRequest {
  hash: string;
}

export interface GitSettingsRequest {
  autoCheckpoint: boolean;
}

export interface AttachmentDto {
  id: string;
  projectId: string;
  relativePath: string;
  mediaType: string;
  size: number;
}

export interface SkillDto {
  name: string;
  path: string;
  description?: string;
  /** SKILL.md frontmatter 的 version 字段（团队约定的版本源）。 */
  version?: string;
}

export interface ListSkillsResponse {
  items: SkillDto[];
}

/** 工作台运行时设置（data/settings.json；同名环境变量优先）。 */
export interface SettingsDto {
  /** 加载全局 skills 目录（用户目录 .codex/skills 与自带 CODEX_HOME/skills）。 */
  globalSkills: boolean;
  /** 一键初始化版本管理时，「回合前自动存档」的默认值。 */
  gitAutoCheckpointDefault: boolean;
  /** globalSkills 被环境变量强制锁定时为 true（界面应禁用开关）。 */
  globalSkillsLocked: boolean;
  /** 新会话的默认审批模式。 */
  defaultApprovalMode: ApprovalMode;
  /** 部署侧审批上限；未配置时不返回。 */
  maxApprovalMode?: ApprovalMode;
  /** 审批模式被部署环境变量限制时为 true（界面应禁用超限选项）。 */
  approvalModeLocked: boolean;
  /** HTTP 出网代理；空字符串表示不覆盖服务进程的继承环境。 */
  httpProxy: string;
  /** HTTPS 出网代理；空字符串表示不覆盖服务进程的继承环境。 */
  httpsProxy: string;
  /** 其它协议的出网代理；空字符串表示不覆盖服务进程的继承环境。 */
  allProxy: string;
  /** 不走代理的主机规则（NO_PROXY 格式）；空字符串表示不覆盖继承环境。 */
  noProxy: string;
  /**
   * 前端最近一次使用的界面语言（本机服务从请求头 X-SuDuo-Locale 记下，只读）；
   * 后台任务（如共享 Agent）按它出文字。还没收到过带语言的请求时为 null。
   */
  locale: Locale | null;
}

/** 连不上模型服务时的原因：界面按它用自己的语言说明，不解析服务端写的文字。 */
export type ProxyConnectivityFailure =
  | { reason: "invalid-base-url" }
  | { reason: "invalid-proxy" }
  | { reason: "unreachable"; networkCode: string | null };

/** 用当前或草稿代理试连模型服务（不保存设置、不发模型回合）。 */
export interface ProxyConnectivityDto {
  reachable: boolean;
  targetOrigin: string;
  statusCode?: number;
  usingProxy: boolean;
  /** 本机服务写的说明，供日志与旧界面；界面按 failure 渲染。 */
  message: string;
  /** reachable 为 false 时给出。 */
  failure?: ProxyConnectivityFailure;
}

export interface UpdateSettingsRequest {
  globalSkills?: boolean;
  gitAutoCheckpointDefault?: boolean;
  defaultApprovalMode?: ApprovalMode;
  httpProxy?: string;
  httpsProxy?: string;
  allProxy?: string;
  noProxy?: string;
}

export type InstallSkillRequest =
  | {
      source: "zip";
      fileName: string;
      dataBase64: string;
      overwrite?: boolean;
    }
  | {
      source: "folder";
      path: string;
      overwrite?: boolean;
    };

export interface RemoveSkillRequest {
  path: string;
}

/** Codex 注册表里对该项目可见的全部 skills（含各作用域与启用态）。 */
export interface SkillCatalogEntry {
  name: string;
  description: string;
  path: string;
  /** user=个人目录 / repo=项目内 / system=内置 / admin=管控 */
  scope: string;
  enabled: boolean;
}

export interface SkillCatalogResponse {
  items: SkillCatalogEntry[];
}

export interface SetSkillEnabledRequest {
  name: string;
  enabled: boolean;
}

/** 模型服务配置（CODEX_HOME/config.toml + auth.json 的产品化投影）。 */
export interface ModelProviderConfigOrigin {
  /** Codex 返回的配置层来源（user / project / system / enterpriseManaged 等）。 */
  name: JsonValue;
  version: string;
}

export interface ModelProviderConfigOrigins {
  providerId: ModelProviderConfigOrigin | null;
  baseUrl: ModelProviderConfigOrigin | null;
  model: ModelProviderConfigOrigin | null;
  reasoningEffort: ModelProviderConfigOrigin | null;
  contextWindow: ModelProviderConfigOrigin | null;
}

export interface ModelProviderSettingsDto {
  /**
   * Codex 里是否已有模型服务（config 里有 model_provider）。
   * 为 false 时 providerId / providerName / baseUrl 为空串；第一次保存（必须带 baseUrl）会建立 SuDuo 的模型服务。
   */
  configured: boolean;
  providerId: string;
  providerName: string;
  baseUrl: string;
  /** 密钥来源的说明（不含密钥本身，如「由 Codex 管理」「由本机命令提供（security）」）；未配置为 null。 */
  apiKeyMasked: string | null;
  /**
   * 密钥从哪里来：command = 提供方配置的取 Key 命令（如读 macOS 钥匙串）；env = 提供方配置的环境变量；
   * codex-login = Codex 自己的登录（codex login）。前两种在设置页里「更换 Key」不会生效，需要改命令 / 环境变量。
   */
  apiKeySource?: "command" | "env" | "codex-login" | null;
  /** 顶层 model；null = 跟随 Codex 内置默认。 */
  model: string | null;
  /** 顶层 model_reasoning_effort；null = 跟随默认。 */
  reasoningEffort: string | null;
  /**
   * 顶层 model_context_window（tokens）；null = 未声明（按模型元数据的上限）。
   * Codex 实际取 min(本值, 模型元数据的 max_context_window)，只能往小调。模型不在 Codex 内置清单里时
   * 走兜底元数据（上限 272000），填这个值消不掉「模型元数据未找到」的提示（见 ADR-0007）。
   */
  contextWindow: number | null;
  /** 保留 config/read(includeLayers:true) 的来源信息，供设置页标示覆盖层。 */
  origins: ModelProviderConfigOrigins;
}

export interface UpdateModelProviderRequest {
  baseUrl?: string;
  /** 传新 key 即替换；不传保持不变。 */
  apiKey?: string;
  /** 具体模型 id；空字符串 = 清除设置回 Codex 默认。 */
  model?: string;
  /** 模型声明的推理强度（如 low / medium / high / xhigh / max）；服务端只校验格式。 */
  reasoningEffort?: string;
  /** 上下文窗口 tokens；null = 清除声明。 */
  contextWindow?: number | null;
}

/** PUT 模型配置的结果；okOverridden 表示写入 user 层但未改变当前有效值。 */
export interface UpdateModelProviderResult {
  settings: ModelProviderSettingsDto;
  status: "ok" | "okOverridden";
  message: string;
}

/** 基于 Codex app-server model/list 的官方模型清单。 */
export interface CodexModelsResponse {
  models: string[];
  /** 每个模型的展示名、是否默认与支持的推理强度（会话级参数选择器用）；旧服务端不返回。 */
  items?: CodexModelOptionDto[];
}

/** Codex model/list 单项的产品化投影。 */
export interface CodexModelOptionDto {
  /** model/list 的 id（与 models 数组同源）。 */
  id: string;
  /** 下发给 turn/start 的模型名（通常与 id 相同）。 */
  model: string;
  displayName: string;
  /** Codex 目录里的默认模型（config.toml 未指定 model 时生效）。 */
  isDefault: boolean;
  /** 该模型声明支持的推理强度。 */
  supportedReasoningEfforts: string[];
  /** 该模型自身的默认推理强度。 */
  defaultReasoningEffort: string | null;
}

/** Codex MCP 服务器的非敏感配置投影；密钥值永远不经此 DTO 返回。 */
export interface McpServerDto {
  name: string;
  transport: "stdio" | "http";
  enabled: boolean;
  /** stdio 服务器的启动命令；HTTP 服务器为 null。 */
  command: string | null;
  /** stdio 启动参数；不得用于传递敏感值。 */
  args: string[];
  /** HTTP 服务器地址；stdio 服务器为 null。 */
  url: string | null;
  /** 仅保存环境变量名，绝不保存或返回变量值。 */
  envVars: string[];
  /** HTTP bearer token 的环境变量名；绝不保存或返回 token。 */
  bearerTokenEnvVar: string | null;
  startupTimeoutSeconds: number | null;
  toolTimeoutSeconds: number | null;
  status: McpServerStatusDto;
}

/** Codex app-server 返回的 MCP 运行态投影。 */
export interface McpServerStatusDto {
  name: string;
  startupState: "unknown" | "starting" | "ready" | "failed" | "cancelled";
  /** 官方原文（Codex 状态列表的 toolsError）；Codex 没给时为 null，绝不由 SuDuo 编造。 */
  startupFailureReason: string | null;
  authenticationStatus:
    | "unsupported"
    | "notLoggedIn"
    | "bearerToken"
    | "oAuth"
    | "unknown";
  toolCount: number;
}
