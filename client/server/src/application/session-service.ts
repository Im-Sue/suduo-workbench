import {
  REASONING_EFFORTS,
  isReasoningEffort,
  type CreateSessionRequest,
  type ListSessionsQuery,
  type Locale,
  type ReasoningEffort,
  type RuntimeToolSpec,
  type SessionDto,
  type SessionPurpose,
  type UpdateSessionRequest,
} from "@suduo/client-contracts";
import type { DatabasePort } from "../infrastructure/db/database-port.js";
import type { ProjectRepository } from "../infrastructure/db/repositories/project-repository.js";
import type {
  SessionKind,
  SessionRecord,
  SessionRepository,
  SessionState,
} from "../infrastructure/db/repositories/session-repository.js";
import type { SessionThreadRepository } from "../infrastructure/db/repositories/session-thread-repository.js";
import type { ProjectSessionRefRepository } from "../infrastructure/db/repositories/project-session-ref-repository.js";
import type {
  RequirementAuditAnchor,
  RequirementSessionRefRepository,
} from "../infrastructure/db/repositories/requirement-session-ref-repository.js";
import {
  ApiError,
  IndeterminateOperationError,
  asJsonError,
  type ErrorText,
} from "./api-error.js";
import { messagesFor } from "../i18n/messages/index.js";
import { sessionDto } from "./dto.js";
import { paginate } from "./pagination.js";
import { effectiveApprovalMode } from "./approval-mode-cap.js";
import type { RuntimeSupervisor } from "./runtime-supervisor.js";
import { WorkspaceContextResolver } from "./workspace-context.js";

/**
 * 会话状态已持久化后的通用通知。观察者不得假定这是某一种业务会话；需求会话
 * 生命周期仅是其中一个消费者。
 */
export interface SessionStateChanged {
  previousState: SessionState;
  session: SessionRecord;
}

export interface SessionStateObserver {
  onStateChanged(change: SessionStateChanged): void;
}

/** 新建线程时的开场内容：需求卡 / 项目卡与 SuDuo 工具（ADR-0008）。 */
export interface SessionThreadSetup {
  developerInstructions?: string;
  dynamicTools?: RuntimeToolSpec[];
}

export class SessionService {
  constructor(
    private readonly database: DatabasePort,
    private readonly projects: ProjectRepository,
    private readonly sessions: SessionRepository,
    private readonly threads: SessionThreadRepository,
    private readonly supervisor: RuntimeSupervisor,
    /** 新会话默认审批模式（接运行时设置）。 */
    private readonly defaultApprovalMode: () => "ask" | "auto" | "full" = () => "ask",
    private readonly workspaces: WorkspaceContextResolver = new WorkspaceContextResolver(),
    private readonly requirementSessionRefs: RequirementSessionRefRepository | null = null,
    private readonly approvalModeEnvironment: NodeJS.ProcessEnv = process.env,
    private readonly stateObserver: SessionStateObserver | null = null,
    /** 项目会话的所属项目（迁移 018）；不传时不能建带 remoteProjectId 的会话。 */
    private readonly projectSessionRefs: ProjectSessionRefRepository | null = null,
  ) {}

  async create(
    projectId: string,
    input: CreateSessionRequest,
    setup: SessionThreadSetup = {},
    /**
     * kind：room_task = 房间共享 Agent 的隐藏任务会话（只读 + 联网 + 不审批，不进普通列表）。
     * locale：没给标题时默认名用的语言（创建请求的语言）。
     * remoteProjectId：项目会话的所属项目，与会话行同一事务写入，之后不随目录关联变化。
     */
    options: { kind?: SessionKind; locale: Locale; remoteProjectId?: string },
  ): Promise<SessionDto> {
    const project = this.projects.getById(projectId);
    if (!project || project.state !== "active") {
      throw new ApiError(404, "NOT_FOUND", (t) => t.session.activeProjectNotFound);
    }
    if (input.title !== undefined && typeof input.title !== "string") {
      throw new ApiError(400, "VALIDATION_ERROR", (t) => t.session.titleNotString);
    }
    if (input.runtimeId !== undefined && typeof input.runtimeId !== "string") {
      throw new ApiError(400, "VALIDATION_ERROR", (t) => t.session.runtimeIdNotString);
    }
    const purpose = validatePurpose(input.purpose ?? "general");
    const runtimeId = input.runtimeId ?? "codex-local";
    if (runtimeId !== "codex-local") {
      throw new ApiError(
        400,
        "VALIDATION_ERROR",
        (t) => t.session.runtimeUnsupported,
      );
    }
    const projectSessionRefs = this.projectSessionRefs;
    const remoteProjectId = options.remoteProjectId;
    if (remoteProjectId !== undefined && projectSessionRefs === null) {
      throw new Error("project session ref store is not configured");
    }
    // 所属项目必须在建线程之前写好：线程一建好，SuDuo 工具就可能按它取上下文。
    const session = this.database.transaction(() => {
      const created = this.sessions.create({
        projectId,
        title: normalizeTitle(input.title ?? messagesFor(options.locale).session.defaultTitle),
        purpose,
        approvalMode: effectiveApprovalMode(
          { approvalMode: this.defaultApprovalMode() },
          this.approvalModeEnvironment,
        ),
        ...(options.kind === undefined ? {} : { kind: options.kind }),
        locale: options.locale,
      });
      if (remoteProjectId !== undefined) {
        projectSessionRefs?.create({ sessionId: created.id, remoteProjectId });
      }
      return created;
    })();
    let started;
    try {
      started = await this.supervisor.createPrimaryThread({
        runtimeId,
        session,
        workspace: this.workspaces.forSession(project, session.id),
        ...setup,
      });
    } catch (error) {
      this.transitionState(session, "error", {
        error: asJsonError(error),
      });
      throw error;
    }
    try {
      this.database.transaction(() => {
        for (const [ordinal, runtimeThread] of started.threads.entries()) {
          this.threads.attach({
            sessionId: session.id,
            threadRef: runtimeThread.threadRef,
            role: runtimeThread.role,
            ordinal,
            primary:
              runtimeThread.threadRef.runtimeId ===
                started.primaryThread.threadRef.runtimeId &&
              runtimeThread.threadRef.threadId ===
                started.primaryThread.threadRef.threadId,
            metadata: runtimeThread.metadata,
          });
        }
        if (!this.sessions.updateState(session.id, session.version, "active")) {
          throw new Error("Session activation CAS failed");
        }
      })();
    } catch (error) {
      this.transitionState(session, "error", {
        error: asJsonError(error),
      });
      throw new IndeterminateOperationError(
        (t) => t.session.threadMappingWriteFailed,
        { cause: error },
      );
    }
    this.supervisor.markReady(started);
    this.notifyStateChanged("starting", session.id);
    return this.get(session.id);
  }

  /** 为远程 V2 需求创建本机会话：线程带需求卡与工具，成功后登记开工版本与水位线。 */
  async createFromRequirement(
    projectId: string,
    input: {
      /** 会话的语言（创建请求的语言）：需求卡与工具说明已按它生成，存下来供工具回包与重建线程用。 */
      locale: Locale;
      title: string;
      remoteProjectId: string;
      remoteRequirementId: string;
      requirementVersion: number;
      auditAnchor?: RequirementAuditAnchor;
      /** 远程需求编号（项目内递增）；与 title 一起快照进本机，供会话列表展示。 */
      requirementNumber?: number | null;
      /** 需求卡与工具。 */
      setup: SessionThreadSetup;
    },
  ): Promise<SessionDto> {
    const project = this.projects.getById(projectId);
    if (!project || project.state !== "active") {
      throw new ApiError(404, "NOT_FOUND", (t) => t.session.activeLocalProjectNotFound);
    }
    const requirementSessionRefs = this.requirementSessionRefs;
    if (!requirementSessionRefs) {
      throw new ApiError(503, "DEPENDENCY_UNAVAILABLE", (t) => t.session.requirementRefStoreUnavailable);
    }
    const session = this.sessions.create({
      projectId,
      title: normalizeTitle(input.title),
      locale: input.locale,
      purpose: "general",
      approvalMode: effectiveApprovalMode(
        { approvalMode: this.defaultApprovalMode() },
        this.approvalModeEnvironment,
      ),
    });
    const reference = {
      sessionId: session.id,
      remoteProjectId: input.remoteProjectId,
      remoteRequirementId: input.remoteRequirementId,
      requirementVersion: input.requirementVersion,
      auditAnchor: input.auditAnchor ?? { state: "unknown" as const, createdAt: null, id: null },
      contextMode: "tools" as const,
    };
    let started;
    try {
      started = await this.supervisor.createPrimaryThread({
        runtimeId: "codex-local",
        session,
        workspace: this.workspaces.forSession(project, session.id),
        ...input.setup,
      });
    } catch (error) {
      this.transitionState(session, "error", {
        error: asJsonError(error),
      });
      throw error;
    }
    try {
      this.database.transaction(() => {
        for (const [ordinal, runtimeThread] of started.threads.entries()) {
          this.threads.attach({
            sessionId: session.id,
            threadRef: runtimeThread.threadRef,
            role: runtimeThread.role,
            ordinal,
            primary:
              runtimeThread.threadRef.runtimeId === started.primaryThread.threadRef.runtimeId &&
              runtimeThread.threadRef.threadId === started.primaryThread.threadRef.threadId,
            metadata: runtimeThread.metadata,
          });
        }
        if (!this.sessions.updateState(session.id, session.version, "active")) {
          throw new Error("Requirement session activation CAS failed");
        }
        requirementSessionRefs.create({
          ...reference,
          // 需求编号与标题快照，跨项目会话列表直接读本机，不逐条请求远程。
          requirementNumber: input.requirementNumber ?? null,
          requirementTitle: input.title,
        });
      })();
    } catch (error) {
      this.transitionState(session, "error", {
        error: asJsonError(error),
      });
      throw new IndeterminateOperationError(
        (t) => t.session.requirementRefWriteFailed,
        { cause: error },
      );
    }
    this.supervisor.markReady(started);
    // ref 与 active 状态在同一事务内提交；只能在事务成功后通知，避免注册表
    // 看到没有需求引用的半成品会话。
    this.notifyStateChanged("starting", session.id);
    return this.get(session.id);
  }

  list(projectId: string, query: ListSessionsQuery) {
    if (!this.projects.getById(projectId)) {
      throw new ApiError(404, "NOT_FOUND", (t) => t.session.projectNotFound);
    }
    const view = query.state ?? "active";
    const sessions = this.sessions
      .listByProject(projectId)
      // 房间任务会话是隐藏的：按项目的会话列表不显示（会话页「房间任务」筛选另走 /api/v1/sessions?kind=room_task）。
      .filter((session) => session.kind !== "room_task" && matchesView(session.state, view))
      .map((session) => sessionDto(session, this.threads.listBySession(session.id)));
    return paginate(sessions, query.cursor, query.limit);
  }

  /**
   * 归属这个远程项目的会话（项目会话 + 需求会话），不限本机目录；房间任务会话不列。
   * 与 list() 同样按视图过滤、分页。
   */
  listForRemoteProject(remoteProjectId: string, query: ListSessionsQuery) {
    const view = query.state ?? "active";
    const sessions = this.sessions
      .listByRemoteProject(remoteProjectId)
      .filter((session) => matchesView(session.state, view))
      .map((session) => sessionDto(session, this.threads.listBySession(session.id)));
    return paginate(sessions, query.cursor, query.limit);
  }

  get(id: string): SessionDto {
    const session = this.requireSession(id);
    return sessionDto(session, this.threads.listBySession(id));
  }

  /**
   * 路由层固定传 null：后写生效，不做版本比对（ADR-0004）。保留参数只为内部调用方显式比对的可能。
   */
  async update(
    id: string,
    expectedVersion: number | null,
    input: UpdateSessionRequest,
  ): Promise<SessionDto> {
    const session = this.requireSession(id);
    if (input.title !== undefined && typeof input.title !== "string") {
      throw new ApiError(400, "VALIDATION_ERROR", (t) => t.session.titleNotString);
    }
    const model =
      input.model === undefined ? undefined : normalizeSessionModel(input.model);
    const reasoningEffort =
      input.reasoningEffort === undefined
        ? undefined
        : normalizeSessionReasoningEffort(input.reasoningEffort);
    if (
      input.state !== undefined &&
      input.state !== "active" &&
      input.state !== "archived"
    ) {
      throw new ApiError(
        400,
        "VALIDATION_ERROR",
        (t) => t.session.stateInvalid,
      );
    }
    if (
      input.approvalMode !== undefined &&
      input.approvalMode !== "ask" &&
      input.approvalMode !== "auto" &&
      input.approvalMode !== "full"
    ) {
      throw new ApiError(
        400,
        "VALIDATION_ERROR",
        (t) => t.session.approvalModeInvalid,
      );
    }
    if (input.purpose !== undefined) {
      validatePurpose(input.purpose);
    }
    if (
      input.approvalMode !== undefined &&
      effectiveApprovalMode(
        { approvalMode: input.approvalMode },
        this.approvalModeEnvironment,
      ) !== input.approvalMode
    ) {
      throw new ApiError(
        409,
        "VERSION_CONFLICT",
        (t) => t.session.approvalModeLocked,
      );
    }
    if (
      input.title === undefined &&
      input.state === undefined &&
      input.approvalMode === undefined &&
      input.purpose === undefined &&
      model === undefined &&
      reasoningEffort === undefined
    ) {
      throw new ApiError(400, "VALIDATION_ERROR", (t) => t.session.patchEmpty);
    }
    if (session.state === "deleted") {
      throw new ApiError(409, "VERSION_CONFLICT", (t) => t.session.deletedNotUpdatable);
    }
    if (input.state === "active" && session.state !== "active") {
      const project = requireRecord(this.projects.getById(session.projectId), (t) => t.session.projectNotFound);
      const binding = this.requirePrimary(id);
      await this.supervisor.ensureReady({
        session,
        workspace: this.workspaces.forSession(project, id),
        binding,
      });
    }
    if (
      !this.sessions.update(id, expectedVersion, {
        ...(input.title === undefined
          ? {}
          : { title: normalizeTitle(input.title) }),
        ...(input.state === undefined ? {} : { state: input.state }),
        ...(input.approvalMode === undefined
          ? {}
          : { approvalMode: input.approvalMode }),
        ...(input.purpose === undefined ? {} : { purpose: input.purpose }),
        ...(model === undefined ? {} : { model }),
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      })
    ) {
      if (expectedVersion === null) {
        // 后写生效路径不比对版本：写不进只可能是会话在这期间被删除（沿用「已删除不能更新」的既有语义）或已不存在。
        if (this.sessions.getById(id)?.state === "deleted") {
          throw new ApiError(409, "VERSION_CONFLICT", (t) => t.session.deletedNotUpdatable);
        }
        throw new ApiError(404, "NOT_FOUND", (t) => t.session.notFound);
      }
      throw new ApiError(409, "VERSION_CONFLICT", (t) => t.session.versionConflict, {
        actualVersion: session.version,
      });
    }
    if (input.state !== undefined) {
      this.notifyStateChanged(session.state, id);
    }
    return this.get(id);
  }

  remove(id: string): void {
    const session = this.requireSession(id);
    if (session.state === "deleted") {
      return;
    }
    if (!this.sessions.updateState(id, session.version, "deleted")) {
      throw new ApiError(409, "VERSION_CONFLICT", (t) => t.session.versionConflict);
    }
    this.notifyStateChanged(session.state, id);
  }

  requireSession(id: string) {
    const session = this.sessions.getById(id);
    if (!session) {
      throw new ApiError(404, "NOT_FOUND", (t) => t.session.notFound);
    }
    return session;
  }

  requirePrimary(sessionId: string) {
    const primaries = this.threads
      .listBySession(sessionId)
      .filter((binding) => binding.primary && binding.state === "attached");
    if (primaries.length === 0) {
      throw new ApiError(
        409,
        "SESSION_HAS_NO_PRIMARY_THREAD",
        (t) => t.session.noPrimaryThread,
      );
    }
    if (primaries.length !== 1) {
      throw new ApiError(
        409,
        "SESSION_PRIMARY_THREAD_AMBIGUOUS",
        (t) => t.session.primaryThreadAmbiguous,
      );
    }
    return primaries[0] as (typeof primaries)[number];
  }

  private transitionState(
    session: SessionRecord,
    state: SessionState,
    options: { error?: ReturnType<typeof asJsonError> } = {},
  ): void {
    if (this.sessions.updateState(session.id, session.version, state, options)) {
      this.notifyStateChanged(session.state, session.id);
    }
  }

  private notifyStateChanged(previousState: SessionState, sessionId: string): void {
    if (this.stateObserver === null) return;
    const session = this.sessions.getById(sessionId);
    if (!session || session.state === previousState) return;
    try {
      this.stateObserver.onStateChanged({ previousState, session });
    } catch (error) {
      console.warn(JSON.stringify({
        event: "session.state_observer_failed",
        sessionId,
        previousState,
        state: session.state,
        message: error instanceof Error ? error.message : String(error),
      }));
    }
  }
}

function validatePurpose(value: unknown): SessionPurpose {
  if (
    value !== "general" &&
    value !== "pm_requirement" &&
    value !== "backend" &&
    value !== "fe_ui" &&
    value !== "fe_connect" &&
    value !== "test"
  ) {
    throw new ApiError(400, "VALIDATION_ERROR", (t) => t.session.purposeInvalid);
  }
  return value;
}

const SESSION_MODEL_PATTERN = /^[A-Za-z0-9._:/-]+$/u;

/** 会话级模型：null = 跟随全局默认；否则为 1–128 位的模型名（与模型设置页同一字符规则）。 */
function normalizeSessionModel(value: unknown): string | null {
  if (value === null) {
    return null;
  }
  if (typeof value !== "string") {
    throw new ApiError(400, "VALIDATION_ERROR", (t) => t.session.modelNotString);
  }
  const model = value.trim();
  if (model.length === 0 || model.length > 128 || !SESSION_MODEL_PATTERN.test(model)) {
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      (t) => t.session.modelInvalid,
    );
  }
  return model;
}

/** 会话级推理强度：null = 跟随全局默认；否则格式合法即可（模型支持哪几档以 model/list 为准）。 */
function normalizeSessionReasoningEffort(value: unknown): ReasoningEffort | null {
  if (value === null) {
    return null;
  }
  if (!isReasoningEffort(value)) {
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      (t) => t.session.reasoningEffortInvalid(REASONING_EFFORTS.slice(2, 5).join(" / ")),
    );
  }
  return value;
}

function normalizeTitle(value: string): string {
  const title = value.trim();
  if (title.length === 0 || title.length > 300) {
    throw new ApiError(400, "VALIDATION_ERROR", (t) => t.session.titleLength);
  }
  return title;
}

function matchesView(
  state: string,
  view: "active" | "archived" | "deleted" | "all",
): boolean {
  if (view === "all") {
    return true;
  }
  if (view === "active") {
    return state === "starting" || state === "active" || state === "error";
  }
  return state === view;
}

function requireRecord<T>(record: T | null, message: ErrorText): T {
  if (!record) {
    throw new ApiError(404, "NOT_FOUND", message);
  }
  return record;
}
