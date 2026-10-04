import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, normalize, win32 } from "node:path";
import type {
  ListRequirementItemsResponse,
  RequirementDetailItemDto,
  RequirementListItemDto,
  RequirementLocalFields,
} from "@suduo/client-contracts";
import type {
  ArtifactVersionDetailDto,
  AuthSessionDto,
  CreateCommentRequest,
  CreateProjectRequest,
  CreateRequirementRequest,
  ListAuditQuery,
  ListRequirementActivityResponse,
  ListUsersResponse,
  PublishArtifactVersionRequest,
  LoginRequest,
  RegisterRequest,
  RequirementDto,
  UpdateProjectRequest,
  UpdateRequirementRequest,
} from "@suduo/cloud-contracts";
import type { Locale } from "@suduo/client-contracts";
import { ApiError } from "./api-error.js";
import { messagesFor, type ServerMessages } from "../i18n/messages/index.js";
import type { SessionService } from "./session-service.js";
import type { DatabasePort } from "../infrastructure/db/database-port.js";
import type { ProjectRepository } from "../infrastructure/db/repositories/project-repository.js";
import type { RequirementSessionRefRepository } from "../infrastructure/db/repositories/requirement-session-ref-repository.js";
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
      mappingCount: this.mappings.list().length,
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
    if (
      input.title === undefined &&
      input.summary === undefined &&
      input.status === undefined &&
      input.assigneeId === undefined
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

  createComment(requirementId: string, input: CreateCommentRequest) {
    validateNonBlank(input.body, (t) => t.remote.validation.fields.commentBody, 4_000);
    return this.remote.createComment(requirementId, input);
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

  publishArtifactVersion(
    requirementId: string,
    input: PublishArtifactVersionRequest,
  ): Promise<ArtifactVersionDetailDto> {
    if (
      typeof input.operationKey !== "string" ||
      input.operationKey.length < 1 ||
      input.operationKey.length > 200 ||
      !Array.isArray(input.attachmentIds) ||
      input.attachmentIds.length < 1
    ) {
      throw new ApiError(400, "VALIDATION_ERROR", (t) => t.remote.validation.publishInvalid);
    }
    return this.remote.publishArtifactVersion(requirementId, input);
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
  async listMappings(options: { verify?: boolean; locale?: Locale } = {}) {
    // 可用性灯只检查已保存的本机目录；不触网也不清理过期凭证，确保 verify=1
    // 严格是零副作用的本机只读操作。
    if (!options.verify) {
      await this.remote.me();
    }
    const items = this.mappings.list().flatMap((mapping) => {
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
    const t = messagesFor(options.locale ?? "zh-CN");
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
    const remoteProject = await this.remote.getProject(remoteProjectId);
    const rootPath = await validateWorkspacePath(input.rootPath);
    const rootPathKey = pathKey(rootPath);
    const saved = await this.withMappingOperation(remoteProjectId, () => {
      try {
        return this.database.transaction(() => {
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
          const byLocal = this.mappings.getByLocalProjectId(localProject.id);
          if (byLocal && byLocal.remoteProjectId !== remoteProjectId) {
            throw new ApiError(
              409,
              "WORKSPACE_MAPPING_CONFLICT",
              (t) => t.workspace.mapping.linkedElsewhere,
            );
          }
          return {
            record: this.mappings.save({
              remoteProjectId,
              localProjectId: localProject.id,
            }),
            rootPath: localProject.rootPath,
            name: localProject.name,
          };
        })();
      } catch (error) {
        if (isUniqueConstraint(error)) {
          throw new ApiError(
            409,
            "WORKSPACE_MAPPING_CONFLICT",
            (t) => t.workspace.mapping.linkedElsewhere,
            undefined,
            { cause: error },
          );
        }
        throw error;
      }
    });
    return mappingView(saved.record, saved.rootPath, saved.name);
  }

  async removeMapping(remoteProjectId: string): Promise<void> {
    await this.remote.getProject(remoteProjectId);
    await this.withMappingOperation(remoteProjectId, () => {
      this.mappings.remove(remoteProjectId);
    });
  }

  async createRequirementSession(requirementId: string) {
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
      const setup = await sessionContext.requirementSetup({
        projectRoot: localProject.rootPath,
        requirement,
      });
      const session = await this.sessions.createFromRequirement(localProject.id, {
        title: requirement.title,
        remoteProjectId: requirement.projectId,
        remoteRequirementId: requirement.id,
        requirementVersion: requirement.version,
        auditAnchor,
        requirementNumber: requirementNumberOf(requirement),
        setup,
      });
      this.onSessionCreated?.(session.id);
      return session;
    });
  }

  async createProjectSession(remoteProjectId: string) {
    await this.remote.getProject(remoteProjectId);
    return this.withMappingOperation(remoteProjectId, async () => {
      const localProject = await this.requireValidatedLocalProject(remoteProjectId);
      const setup =
        (await this.sessionContext?.projectSetup({
          projectRoot: localProject.rootPath,
          remoteProjectId,
        })) ?? {};
      const session = await this.sessions.create(localProject.id, { purpose: "general" }, setup);
      this.onSessionCreated?.(session.id);
      return session;
    });
  }

  async listProjectSessions(remoteProjectId: string) {
    await this.remote.getProject(remoteProjectId);
    return this.withMappingOperation(remoteProjectId, async () => {
      const localProject = await this.requireValidatedLocalProject(remoteProjectId);
      const references = new Map(
        this.sessionRefs
          .listByRemoteProjectId(remoteProjectId)
          .map((reference) => [reference.sessionId, reference]),
      );
      return this.sessions
        .list(localProject.id, { state: "active", limit: 100 })
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

function pathKey(path: string): string {
  const key = normalize(path);
  return process.platform === "win32" ? key.toLocaleLowerCase("en-US") : key;
}

function normalizedLocalProjectName(remoteName: string, rootPath: string): string {
  return remoteName.trim().slice(0, 200) || basename(rootPath).slice(0, 200);
}

function isUniqueConstraint(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "SQLITE_CONSTRAINT_UNIQUE"
  );
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
