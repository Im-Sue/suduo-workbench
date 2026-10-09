import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, win32 } from "node:path";
import type {
  ListRequirementItemsResponse,
  RequirementDetailItemDto,
  RequirementListItemDto,
  RequirementLocalFields,
  SessionStartOptions,
} from "@suduo/client-contracts";
import type {
  AuthSessionDto,
  CreateCommentRequest,
  CreateProjectRequest,
  CreateRequirementRequest,
  ListAuditQuery,
  ListRequirementActivityResponse,
  ListUsersResponse,
  LoginRequest,
  RegisterRequest,
  RequirementDto,
  RequirementPriority,
  UpdateProjectRequest,
  UpdateRequirementRequest,
} from "@suduo/cloud-contracts";
import { REQUIREMENT_COMMENT_MAX_FILES, REQUIREMENT_PRIORITIES } from "@suduo/cloud-contracts";
import type { Locale, RuntimeToolSpec } from "@suduo/client-contracts";
import { ApiError } from "./api-error.js";
import { pathKey } from "./project-service.js";
import { messagesFor, type ServerMessages } from "../i18n/messages/index.js";
import type { SessionService, SessionThreadSetup } from "./session-service.js";
import type { DatabasePort } from "../infrastructure/db/database-port.js";
import type { ProjectRepository } from "../infrastructure/db/repositories/project-repository.js";
import type { RequirementSessionRefRepository } from "../infrastructure/db/repositories/requirement-session-ref-repository.js";
import type { SessionGraphInput, SessionRecord } from "../infrastructure/db/repositories/session-repository.js";
import type { WorkspaceMappingRecord, WorkspaceMappingRepository } from "../infrastructure/db/repositories/workspace-mapping-repository.js";
import type { RequirementsCredentialStore } from "../infrastructure/requirements-v2/credential-store.js";
import type { RequirementsRemoteClient } from "../infrastructure/requirements-v2/remote-client.js";
import type { SessionContextService } from "./session-tools/session-context.js";
import {
  normalizeRequirementsServiceUrl,
  type RequirementsSettingsStore,
} from "../infrastructure/requirements-v2/settings-store.js";
import { verifyWorkspaceMappingPath } from "./workspace-mapping-verifier.js";

export interface RequirementsSettingsView {
  configured: boolean;
  baseUrl: string | null;
  session: { user: AuthSessionDto["user"]; expiresAt: string } | null;
  mappingCount: number;
}




export class RequirementsV2Service {
  /**
   * 同一远程项目的映射写入和会话创建必须线性化：会话一旦开始使用某个
   * 本机目录，就不能在快照或 runtime 创建期间被解除或切换到另一个目录。
   */
  private readonly mappingOperations = new Map<string, Promise<void>>();

  constructor(
    private readonly settings: RequirementsSettingsStore,
    private readonly credentials: RequirementsCredentialStore,
    private readonly remote: RequirementsRemoteClient,
    private readonly mappings: WorkspaceMappingRepository,
    private readonly projects: ProjectRepository,
    private readonly sessions: SessionService,
    private readonly sessionRefs: RequirementSessionRefRepository,
    private readonly database: DatabasePort,
    /** 需求卡、工具清单与开工水位线（ADR-0008）。不传时需求会话不能创建。 */
    private readonly sessionContext: SessionContextService | null = null,
    /** 登录 / 改服务地址后通知（远程连接相关的后台任务据此重连）。 */
    private readonly onRemoteConnectionChanged?: () => void,
    /** 新会话建好后异步拍「改动」面板基线。 */
    private readonly onSessionCreated?: (sessionId: string) => void,
  ) {}

  settingsView(): RequirementsSettingsView {
    const baseUrl = this.settings.getBaseUrl();
    const session = baseUrl ? this.credentials.getForBaseUrl(baseUrl) : null;
    return {
      configured: baseUrl !== null,
      baseUrl,
      session:
        session === null
          ? null
          : { user: session.user, expiresAt: session.expiresAt },
      mappingCount: this.mappings.list(baseUrl).length,
    };
  }

  updateSettings(input: { baseUrl?: unknown }): RequirementsSettingsView {
    if (!input || typeof input.baseUrl !== "string") {
      throw new ApiError(400, "VALIDATION_ERROR", (t) => t.remote.validation.baseUrlNotString);
    }
    let normalized: string;
    try {
      normalized = normalizeRequirementsServiceUrl(input.baseUrl);
    } catch {
      throw new ApiError(400, "VALIDATION_ERROR", (t) => t.remote.validation.baseUrlInvalid);
    }
    const previous = this.settings.getBaseUrl();
    if (previous !== normalized) {
      this.credentials.clear();
    }
    this.settings.setBaseUrl(normalized);
    // 启动时没配地址的话，升级前的存量关联还没认领服务器：记为这次配上的服务器（启动时也做一次）。
    this.mappings.adoptUnscoped(normalized);
    this.onRemoteConnectionChanged?.();
    return this.settingsView();
  }

  /** `locale` 是发起试连的请求的语言（成功时的说明按它生成）。 */
  async testSettings(input: { baseUrl?: unknown }, locale: Locale) {
    if (!input || typeof input.baseUrl !== "string") {
      throw new ApiError(400, "VALIDATION_ERROR", (t) => t.remote.validation.baseUrlNotString);
    }
    let baseUrl: string;
    try {
      baseUrl = normalizeRequirementsServiceUrl(input.baseUrl);
    } catch {
      throw new ApiError(400, "VALIDATION_ERROR", (t) => t.remote.validation.baseUrlInvalid);
    }
    return this.remote.testConnection(baseUrl, locale);
  }

  async register(input: RegisterRequest) {
    validateRegister(input);
    const baseUrl = this.requireConfiguredBaseUrl();
    return this.saveRemoteSession(
      await this.remote.register(input, baseUrl),
      baseUrl,
    );
  }

  async login(input: LoginRequest) {
    validateLogin(input);
    const baseUrl = this.requireConfiguredBaseUrl();
    return this.saveRemoteSession(await this.remote.login(input, baseUrl), baseUrl);
  }

  logout(): void {
    this.credentials.clear();
    // 退出后上游推送、续期、本机 Agent 心跳都要停下（房间与共享 Agent）。
    this.onRemoteConnectionChanged?.();
  }

  me() {
    return this.remote.me();
  }

  listProjects(query: Record<string, string | undefined>) {
    return this.remote.listProjects(query);
  }

  createProject(input: CreateProjectRequest) {
    validateNonBlank(input.name, (t) => t.remote.validation.fields.projectName, 120);
    return this.remote.createProject(input);
  }

  getProject(projectId: string) {
    return this.remote.getProject(projectId);
  }

  updateProject(projectId: string, input: UpdateProjectRequest) {
    if (input.name !== undefined) validateNonBlank(input.name, (t) => t.remote.validation.fields.projectName, 120);
    if (input.name === undefined && input.isArchived === undefined) {
      throw new ApiError(400, "VALIDATION_ERROR", (t) => t.remote.validation.patchEmpty);
    }
    return this.remote.updateProject(projectId, input);
  }

  async listRequirements(
    projectId: string,
    query: Record<string, string | undefined>,
  ): Promise<ListRequirementItemsResponse> {
    const page = await this.remote.listRequirements(projectId, query);
    return { ...page, items: this.withLocalSessionCounts(page.items) };
  }

  async createRequirement(
    projectId: string,
    input: CreateRequirementRequest,
  ): Promise<RequirementListItemDto> {
    validateNonBlank(input.title, (t) => t.remote.validation.fields.requirementTitle, 200);
    if (input.summary !== undefined) validateSummary(input.summary);
    if (input.assigneeId !== undefined) validateAssigneeId(input.assigneeId);
    if (input.priority !== undefined) validatePriority(input.priority);
    return this.withLocalSessionCount(await this.remote.createRequirement(projectId, input));
  }

  async getRequirement(requirementId: string): Promise<RequirementDetailItemDto> {
    return this.withLocalSessionCount(await this.remote.getRequirement(requirementId));
  }

  async getRequirementByNumber(
    projectId: string,
    number: number,
  ): Promise<RequirementDetailItemDto> {
    return this.withLocalSessionCount(
      await this.remote.getRequirementByNumber(projectId, number),
    );
  }

  async updateRequirement(
    requirementId: string,
    input: UpdateRequirementRequest,
  ): Promise<RequirementListItemDto> {
    if (input.title !== undefined) validateNonBlank(input.title, (t) => t.remote.validation.fields.requirementTitle, 200);
    if (input.summary !== undefined) validateSummary(input.summary);
    if (input.assigneeId !== undefined) validateAssigneeId(input.assigneeId);
    if (input.priority !== undefined) validatePriority(input.priority);
    if (
      input.title === undefined &&
      input.summary === undefined &&
      input.status === undefined &&
      input.assigneeId === undefined &&
      input.priority === undefined
    ) {
      throw new ApiError(400, "VALIDATION_ERROR", (t) => t.remote.validation.patchEmpty);
    }
    return this.withLocalSessionCount(
      await this.remote.updateRequirement(requirementId, input),
    );
  }

  markRequirementRead(requirementId: string, input: { upTo?: string } = {}): Promise<void> {
    return this.remote.markRequirementRead(requirementId, input);
  }

  listRequirementActivity(
    requirementId: string,
    query: Record<string, string | undefined>,
  ): Promise<ListRequirementActivityResponse> {
    return this.remote.listRequirementActivity(requirementId, query);
  }

  listUsers(): Promise<ListUsersResponse> {
    return this.remote.listUsers();
  }

  listComments(requirementId: string, query: Record<string, string | undefined>) {
    return this.remote.listComments(requirementId, query);
  }

  /** 正文与文件至少有一样（只带文件时正文可省略或为空）；文件至多 REQUIREMENT_COMMENT_MAX_FILES 个。 */
  createComment(requirementId: string, input: CreateCommentRequest) {
    const fileIds: unknown = input.fileIds;
    if (
      fileIds !== undefined &&
      (!Array.isArray(fileIds) ||
        fileIds.length > REQUIREMENT_COMMENT_MAX_FILES ||
        fileIds.some((id) => typeof id !== "string" || id.trim() === ""))
    ) {
      throw new ApiError(400, "VALIDATION_ERROR", (t) => t.remote.validation.commentFilesInvalid);
    }
    const files = (fileIds ?? []) as string[];
    if (files.length === 0) {
      validateNonBlank(input.body, (t) => t.remote.validation.fields.commentBody, 4_000);
    } else if (input.body !== undefined && (typeof input.body !== "string" || input.body.length > 4_000)) {
      throw new ApiError(400, "VALIDATION_ERROR", (t) => t.remote.validation.commentFilesInvalid);
    }
    return this.remote.createComment(requirementId, {
      ...(input.body === undefined ? {} : { body: input.body }),
      ...(files.length === 0 ? {} : { fileIds: files }),
    });
  }

  uploadCommentFile(input: Parameters<RequirementsRemoteClient["uploadCommentFile"]>[0]) {
    return this.remote.uploadCommentFile(input);
  }

  downloadCommentFile(fileId: string, options: Parameters<RequirementsRemoteClient["downloadCommentFile"]>[1]) {
    return this.remote.downloadCommentFile(fileId, options);
  }

  getCommentFile(fileId: string) {
    return this.remote.getCommentFile(fileId);
  }

  saveCommentFileAsAttachment(fileId: string) {
    return this.remote.saveCommentFileAsAttachment(fileId);
  }



  listAudit(query: ListAuditQuery) {
    return this.remote.listAudit(query);
  }

  listAttachments(requirementId: string) {
    return this.remote.listAttachments(requirementId);
  }

  listArtifactVersions(requirementId: string) {
    return this.remote.listArtifactVersions(requirementId);
  }

  getArtifactVersion(versionId: string) {
    return this.remote.getArtifactVersion(versionId);
  }

  uploadAttachment(input: {
    requirementId: string;
    body: AsyncIterable<Uint8Array>;
    contentType: string;
    contentLength?: string;
    attachmentSize?: string;
    idempotencyKey: string;
    signal: AbortSignal;
  }) {
    return this.remote.uploadAttachment(input);
  }

  downloadAttachment(attachmentId: string, signal: AbortSignal) {
    return this.remote.downloadAttachment(attachmentId, signal);
  }



  downloadArtifactVersionFile(
    versionId: string,
    fileId: string,
    signal: AbortSignal,
  ) {
    return this.remote.downloadArtifactVersionFile(versionId, fileId, signal);
  }


  deleteAttachment(input: { attachmentId: string }) {
    return this.remote.deleteAttachment(input);
  }

  openEvents(signal: AbortSignal) {
    return this.remote.openEvents(signal);
  }

  /** `locale` 是请求的语言，复验结论（verification.message）按它生成；不传时用中文。 */
  /** `locale`：复验结论（`verify`）用的语言。 */
  async listMappings(options: { verify?: boolean; locale: Locale }) {
    // 可用性灯只检查已保存的本机目录；不触网也不清理过期凭证，确保 verify=1
    // 严格是零副作用的本机只读操作。
    if (!options.verify) {
      await this.remote.me();
    }
    // 只列当前服务器的关联：换过服务器时，别的服务器的关联留着，换回去原样生效。
    const items = this.mappings.list(this.settings.getBaseUrl()).flatMap((mapping) => {
      const project = this.projects.getById(mapping.localProjectId);
      return project
        ? [
            {
              remoteProjectId: mapping.remoteProjectId,
              localProjectId: mapping.localProjectId,
              rootPath: project.rootPath,
              localProjectName: project.name,
              lastValidatedAt: mapping.lastValidatedAt,
            },
          ]
        : [];
    });
    if (!options.verify) {
      return items;
    }
    const t = messagesFor(options.locale);
    return await Promise.all(
      items.map(async (item) => ({
        ...item,
        verification: await verifyWorkspaceMappingPath(item.rootPath, t),
      })),
    );
  }

  async saveMapping(remoteProjectId: string, input: { rootPath?: unknown }) {
    if (!input || typeof input.rootPath !== "string") {
      throw new ApiError(400, "VALIDATION_ERROR", (t) => t.workspace.mapping.rootPathNotString);
    }
    // 先定下服务器再查项目：中途换了地址的话，查项目会落到新服务器上而查不到，不会把旧服务器的项目记到新服务器名下。
    const serverOrigin = this.requireConfiguredBaseUrl();
    const remoteProject = await this.remote.getProject(remoteProjectId);
    const rootPath = await validateWorkspacePath(input.rootPath);
    const rootPathKey = pathKey(rootPath);
    // 一个目录可以关联多个项目（选目录时告知，不拒绝，ADR-0004）：会话的所属项目建时就记下，不靠目录反查。
    const saved = await this.withMappingOperation(remoteProjectId, () =>
      this.database.transaction(() => {
        const existingProject = this.projects.getByRootPathKey(rootPathKey);
        if (existingProject?.state === "removed") {
          throw new ApiError(
            409,
            "WORKSPACE_MAPPING_CONFLICT",
            (t) => t.workspace.mapping.projectRemoved,
          );
        }
        const localProject =
          existingProject ??
          this.projects.create({
            name: normalizedLocalProjectName(remoteProject.name, rootPath),
            rootPath,
            rootPathKey,
          });
        return {
          record: this.mappings.save({
            remoteProjectId,
            localProjectId: localProject.id,
            serverOrigin,
          }),
          rootPath: localProject.rootPath,
          name: localProject.name,
        };
      })(),
    );
    return mappingView(saved.record, saved.rootPath, saved.name);
  }

  /** 纯本机操作：不向服务器查项目，项目已删除、没有权限或离线时也能解除。 */
  async removeMapping(remoteProjectId: string): Promise<void> {
    await this.withMappingOperation(remoteProjectId, () => {
      this.mappings.remove(remoteProjectId);
    });
  }

  /** `locale`：会话的语言（创建请求的语言），需求卡、规则与工具说明按它写。 */
  async createRequirementSession(
    requirementId: string,
    locale: Locale,
    start: SessionStartOptions = {},
    /** 与另一个会话的关系（接着做，多 Agent 协作 S7）。 */
    graph?: SessionGraphInput,
    /** 改写开场说明与工具（委派的子会话附角色说明、去掉委派工具，多 Agent 协作 S8）。 */
    adjustSetup?: (setup: SessionThreadSetup) => SessionThreadSetup,
    /** 会话标题（委派的子任务、评审会话另起名字）；不给时用需求标题。 */
    title?: string,
  ) {
    this.sessions.checkStartOptions(start);
    const sessionContext = this.sessionContext;
    if (!sessionContext) {
      throw new ApiError(503, "DEPENDENCY_UNAVAILABLE", (t) => t.remote.requirementSessionUnavailable);
    }
    const located = await this.remote.getRequirement(requirementId);
    return this.withMappingOperation(located.projectId, async () => {
      const localProject = await this.requireValidatedLocalProject(located.projectId);
      // 先打水位线再读需求：开工以后的变化以水位线为分界，不会漏掉两次请求之间的改动。
      const auditAnchor = await sessionContext.captureAnchor(located.projectId, located.id);
      const requirement = await this.remote.getRequirement(requirementId);
      const baseSetup = await sessionContext.requirementSetup({
        locale,
        projectRoot: localProject.rootPath,
        requirement,
      });
      const setup = adjustSetup === undefined ? baseSetup : adjustSetup(baseSetup);
      const session = await this.sessions.createFromRequirement(localProject.id, {
        locale,
        title: title ?? requirement.title,
        remoteProjectId: requirement.projectId,
        remoteRequirementId: requirement.id,
        requirementVersion: requirement.version,
        auditAnchor,
        requirementNumber: requirementNumberOf(requirement),
        setup,
        start,
        ...(graph === undefined ? {} : { graph }),
      });
      this.onSessionCreated?.(session.id);
      return session;
    });
  }

  /** `locale`：会话的语言（创建请求的语言）：没给标题时的默认名、项目卡与工具说明按它写。 */
  async createProjectSession(
    remoteProjectId: string,
    locale: Locale,
    start: SessionStartOptions = {},
    /** 接着做 / 委派（多 Agent 协作 S7 / S8）：沿用原会话的标题、记下关系、改写开场说明与工具。 */
    extra: { title?: string; graph?: SessionGraphInput; adjustSetup?: (setup: SessionThreadSetup) => SessionThreadSetup } = {},
  ) {
    this.sessions.checkStartOptions(start);
    await this.remote.getProject(remoteProjectId);
    return this.withMappingOperation(remoteProjectId, async () => {
      const localProject = await this.requireValidatedLocalProject(remoteProjectId);
      const baseSetup =
        (await this.sessionContext?.projectSetup({
          locale,
          projectRoot: localProject.rootPath,
          remoteProjectId,
        })) ?? {};
      const setup = extra.adjustSetup === undefined ? baseSetup : extra.adjustSetup(baseSetup);
      const session = await this.sessions.create(
        localProject.id,
        { purpose: "general", ...(extra.title === undefined ? {} : { title: extra.title }), ...start },
        setup,
        { locale, remoteProjectId, ...(extra.graph === undefined ? {} : { graph: extra.graph }) },
      );
      this.onSessionCreated?.(session.id);
      return session;
    });
  }

  /**
   * 交给另一个 Agent 接着做（多 Agent 协作 S7，需求 4.2）：在原会话的需求 / 项目 / 本机项目下开一个新会话，
   * 记下「接续自」关系（根会话沿用原会话的根）。新会话的首条消息由界面预填「接着 @原会话 继续：」，用户确认后发出。
   */
  async continueSession(sourceId: string, locale: Locale, start: SessionStartOptions = {}) {
    const source = this.sessions.record(sourceId);
    if (source.state === "deleted") {
      throw new ApiError(404, "NOT_FOUND", (t) => t.session.notFound);
    }
    if (source.kind !== "normal") {
      throw new ApiError(400, "VALIDATION_ERROR", (t) => t.session.roomTaskNotContinuable);
    }
    return this.createRelatedSession(source, locale, start, "continue");
  }

  /**
   * 在原会话的需求 / 项目 / 本机项目下开一个有关系的新会话（接着做、委派，多 Agent 协作 S7 / S8）：
   * 根会话沿用原会话的根；委派的子会话在开场说明后附角色说明、不挂委派工具（深度 1，R2）。
   */
  async createRelatedSession(
    source: SessionRecord,
    locale: Locale,
    start: SessionStartOptions,
    relation: "continue" | "delegate" | "review",
    options: { title?: string; role?: string; dropTools?: (name: string) => boolean; addTools?: RuntimeToolSpec[] } = {},
  ) {
    const graph: SessionGraphInput = { parentSessionId: source.id, rootSessionId: source.rootSessionId ?? source.id, relation };
    const adjustSetup = (setup: SessionThreadSetup): SessionThreadSetup => adjustThreadSetup(setup, options);
    const title = options.title ?? source.title;
    const context = this.sessionContext?.toolContext(source.id) ?? null;
    if (context?.requirement) {
      return this.createRequirementSession(context.requirement.remoteRequirementId, locale, start, graph, adjustSetup, options.title);
    }
    if (context !== null) {
      return this.createProjectSession(context.remoteProjectId, locale, start, { title, graph, adjustSetup });
    }
    // 没关联 SuDuo 项目的本机会话：同一本机项目下开（没有 SuDuo 工具，只带角色说明）。
    this.sessions.checkStartOptions(start);
    const session = await this.sessions.create(
      source.projectId,
      { title, purpose: source.purpose, ...start },
      adjustSetup({}),
      { locale, graph },
    );
    this.onSessionCreated?.(session.id);
    return session;
  }

  async listProjectSessions(remoteProjectId: string) {
    await this.remote.getProject(remoteProjectId);
    return this.withMappingOperation(remoteProjectId, async () => {
      await this.requireValidatedLocalProject(remoteProjectId);
      const references = new Map(
        this.sessionRefs
          .listByRemoteProjectId(remoteProjectId)
          .map((reference) => [reference.sessionId, reference]),
      );
      // 按会话记下的所属项目列，不按当前关联的目录：项目换过目录时，以前目录里的会话也在。
      return this.sessions
        .listForRemoteProject(remoteProjectId, { state: "active", limit: 100 })
        .items.map((session) => {
          const reference = references.get(session.id);
          return {
            session,
            requirement:
              reference === undefined
                ? null
                : {
                    remoteRequirementId: reference.remoteRequirementId,
                    requirementVersion: reference.requirementVersion,
                    contextMode: reference.contextMode,
                    createdAt: reference.createdAt,
                  },
          };
        });
    });
  }

  /** 远程 DTO 原样保留，只追加本机会话数；远程服务本身不知道本机会话。 */
  private withLocalSessionCounts<T extends RequirementDto>(
    items: readonly T[],
  ): Array<T & RequirementLocalFields> {
    const counts = this.sessionRefs.countLiveSessionsByRequirementIds(
      items.map((item) => item.id),
    );
    return items.map((item) => ({
      ...item,
      localSessionCount: counts.get(item.id) ?? 0,
    }));
  }

  private withLocalSessionCount<T extends RequirementDto>(
    item: T,
  ): T & RequirementLocalFields {
    const [withCount] = this.withLocalSessionCounts([item]);
    return withCount ?? { ...item, localSessionCount: 0 };
  }

  private requireConfiguredBaseUrl(): string {
    const baseUrl = this.settings.getBaseUrl();
    if (!baseUrl) {
      throw new ApiError(409, "REMOTE_SERVICE_NOT_CONFIGURED", (t) => t.remote.notConfiguredShort);
    }
    return baseUrl;
  }

  private saveRemoteSession(session: AuthSessionDto, requestBaseUrl: string) {
    const baseUrl = this.requireConfiguredBaseUrl();
    if (baseUrl !== requestBaseUrl) {
      throw new ApiError(
        409,
        "AUTH_INVALID",
        (t) => t.remote.baseUrlChangedSignInAgain,
      );
    }
    this.credentials.save({
      baseUrl,
      accessToken: session.accessToken,
      expiresAt: session.expiresAt,
      user: session.user,
    });
    this.onRemoteConnectionChanged?.();
    return { user: session.user, expiresAt: session.expiresAt };
  }

  private async requireValidatedLocalProject(remoteProjectId: string) {
    const mapping = this.mappings.getByRemoteProjectId(remoteProjectId);
    if (!mapping) {
      throw new ApiError(
        409,
        "WORKSPACE_MAPPING_REQUIRED",
        (t) => t.workspace.mapping.missing,
        { remoteProjectId },
      );
    }
    const localProject = this.projects.getById(mapping.localProjectId);
    if (!localProject || localProject.state !== "active") {
      throw new ApiError(
        409,
        "WORKSPACE_MAPPING_REQUIRED",
        (t) => t.workspace.mapping.invalid,
        { remoteProjectId },
      );
    }
    const validatedRootPath = await validateWorkspacePath(localProject.rootPath);
    if (pathKey(validatedRootPath) !== localProject.rootPathKey) {
      throw new ApiError(
        409,
        "WORKSPACE_MAPPING_REQUIRED",
        (t) => t.workspace.mapping.changed,
        { remoteProjectId },
      );
    }
    this.mappings.touchValidated(remoteProjectId);
    return localProject;
  }

  private async withMappingOperation<T>(
    remoteProjectId: string,
    operation: () => T | Promise<T>,
  ): Promise<T> {
    const previous = this.mappingOperations.get(remoteProjectId) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.catch(() => undefined).then(() => current);
    this.mappingOperations.set(remoteProjectId, queued);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release();
      if (this.mappingOperations.get(remoteProjectId) === queued) {
        this.mappingOperations.delete(remoteProjectId);
      }
    }
  }
}

async function validateWorkspacePath(input: string): Promise<string> {
  if (!input.trim() || input.includes("\0") || (!isAbsolute(input) && !win32.isAbsolute(input))) {
    throw new ApiError(400, "VALIDATION_ERROR", (t) => t.workspace.mapping.rootPathNotAbsolute);
  }
  let resolved: string;
  try {
    resolved = await realpath(input);
    const information = await stat(resolved);
    if (!information.isDirectory()) throw new Error("not a directory");
    await access(resolved, constants.R_OK | constants.W_OK | constants.X_OK);
  } catch (error) {
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      (t) => t.workspace.mapping.rootPathNotAccessible,
      undefined,
      { cause: error },
    );
  }
  return resolved;
}

function validateRegister(input: RegisterRequest): void {
  validateLogin(input);
  validateNonBlank(input.displayName, (t) => t.remote.validation.fields.displayName, 80);
}

function validateLogin(input: LoginRequest): void {
  validateNonBlank(input.loginName, (t) => t.remote.validation.fields.loginName, 64);
  if (input.loginName.length < 3 || !/^[A-Za-z0-9._-]+$/u.test(input.loginName)) {
    throw new ApiError(400, "VALIDATION_ERROR", (t) => t.remote.validation.loginNameInvalid);
  }
  if (typeof input.password !== "string" || input.password.length < 1 || input.password.length > 128) {
    throw new ApiError(400, "VALIDATION_ERROR", (t) => t.remote.validation.passwordLengthInvalid);
  }
}

/** label 是字段名（按请求语言取）。 */
function validateNonBlank(
  value: unknown,
  label: (t: ServerMessages) => string,
  maximum: number,
): asserts value is string {
  if (typeof value !== "string" || value.trim() === "" || value.length > maximum) {
    throw new ApiError(400, "VALIDATION_ERROR", (t) => t.remote.validation.lengthOutOfRange(label(t), maximum));
  }
}

/** 描述允许为空字符串（Markdown，可空）。 */
function validateSummary(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length > 4_000) {
    throw new ApiError(400, "VALIDATION_ERROR", (t) => t.remote.validation.summaryTooLong);
  }
}

/** 负责人：用户 id 或 null（清空）；用户是否存在由远程服务判定。 */
function validateAssigneeId(value: unknown): asserts value is string | null {
  if (value !== null && (typeof value !== "string" || value.trim() === "" || value.length > 64)) {
    throw new ApiError(400, "VALIDATION_ERROR", (t) => t.remote.validation.assigneeInvalid);
  }
}

/** 优先级：四档之一或 null（清空）。 */
function validatePriority(value: unknown): asserts value is RequirementPriority | null {
  if (value !== null && !(REQUIREMENT_PRIORITIES as readonly unknown[]).includes(value)) {
    throw new ApiError(400, "VALIDATION_ERROR", (t) => t.remote.validation.priorityInvalid);
  }
}

function normalizedLocalProjectName(remoteName: string, rootPath: string): string {
  return remoteName.trim().slice(0, 200) || basename(rootPath).slice(0, 200);
}

function mappingView(mapping: WorkspaceMappingRecord, rootPath: string, localProjectName: string) {
  return {
    remoteProjectId: mapping.remoteProjectId,
    localProjectId: mapping.localProjectId,
    rootPath,
    localProjectName,
    lastValidatedAt: mapping.lastValidatedAt,
  };
}

/**
 * 需求编号（项目内递增）。旧版需求服务的 DTO 没有该字段时为 null；用结构读取，
 * 同一份代码在有无 number 字段的契约版本下都成立。
 */
function requirementNumberOf(requirement: object): number | null {
  const value = (requirement as { number?: unknown }).number;
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}

/**
 * 有关系的会话的开场：在开场说明后附角色说明，去掉不给它的工具、加上只给它的工具（委派的子会话 S8、评审会话 S9；
 * 线程重建时同样套用）。没有 SuDuo 工具的会话（没关联项目）不加工具。
 */
export function adjustThreadSetup(
  setup: SessionThreadSetup,
  options: { role?: string; dropTools?: (name: string) => boolean; addTools?: RuntimeToolSpec[] },
): SessionThreadSetup {
  const kept = setup.dynamicTools === undefined || options.dropTools === undefined ? setup.dynamicTools : setup.dynamicTools.filter((tool) => !options.dropTools!(tool.name));
  const tools = kept === undefined || options.addTools === undefined ? kept : [...kept, ...options.addTools.filter((tool) => !kept.some((existing) => existing.name === tool.name))];
  return {
    ...setup,
    ...(options.role === undefined
      ? {}
      : { developerInstructions: [setup.developerInstructions ?? "", options.role].filter((text) => text !== "").join("\n\n") }),
    ...(tools === undefined ? {} : { dynamicTools: tools }),
  };
}
