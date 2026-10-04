import { createHash } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import {
  type MessageContent,
  type RuntimeInput,
  type RuntimeRegistry as RuntimeRegistryContract,
  type RuntimeToolSpec,
  type SendMessageAccepted,
  type SendMessageRequest,
  type StartThreadResult,
} from "@suduo/client-contracts";
import type { EventLedger } from "./event-ledger.js";
import type { GitService } from "./git-service.js";
import type { ProjectRepository } from "../infrastructure/db/repositories/project-repository.js";
import type { SessionRepository } from "../infrastructure/db/repositories/session-repository.js";
import type {
  SessionThreadRecord,
  SessionThreadRepository,
} from "../infrastructure/db/repositories/session-thread-repository.js";
import { ApiError, IndeterminateOperationError } from "./api-error.js";
import type { RuntimeSupervisor } from "./runtime-supervisor.js";
import { WorkspaceContextResolver } from "./workspace-context.js";
import { sessionSecurityPolicy } from "./approval-mode-cap.js";
import type { SkillRootsProvider } from "./skill-roots.js";

export class MessageService {
  constructor(
    private readonly projects: ProjectRepository,
    private readonly sessions: SessionRepository,
    private readonly threads: SessionThreadRepository,
    private readonly runtimes: RuntimeRegistryContract,
    private readonly supervisor: RuntimeSupervisor,
    private readonly ledger: EventLedger,
    /** resume 失败、重建全新线程时重新生成需求卡与工具（ADR-0008）；不传则重建为普通线程。 */
    private readonly threadSetup: { rebuildSetup(sessionId: string): Promise<{ developerInstructions?: string; dynamicTools?: RuntimeToolSpec[] } | null> } | null,
    private readonly skillRoots: SkillRootsProvider = { roots: () => [] },
    private readonly git: GitService | null = null,
    /** 发消息前把 skills 根目录同步进 runtime 注册表（否则 skill 引用被静默忽略）。 */
    private readonly syncSkillRoots: ((projectRoot: string) => Promise<void>) | null = null,
    private readonly workspaces: WorkspaceContextResolver = new WorkspaceContextResolver(),
    private readonly approvalModeEnvironment: NodeJS.ProcessEnv = process.env,
  ) {}

  async send(
    sessionId: string,
    input: SendMessageRequest,
    idempotencyKey: string,
  ): Promise<SendMessageAccepted> {
    if (!Array.isArray(input.content)) {
      throw new ApiError(400, "VALIDATION_ERROR", (t) => t.session.contentNotArray);
    }
    const session = this.sessions.getById(sessionId);
    if (!session) {
      throw new ApiError(404, "NOT_FOUND", (t) => t.session.notFound);
    }
    if (session.state !== "active") {
      throw new ApiError(
        409,
        "VERSION_CONFLICT",
        (t) => t.session.notActive,
        { state: session.state },
      );
    }
    const project = this.projects.getById(session.projectId);
    if (!project || project.state !== "active") {
      throw new ApiError(409, "VERSION_CONFLICT", (t) => t.session.projectUnavailable);
    }
    // 回合前自动存档（按项目开关；失败不阻塞发消息）。房间任务是只读沙箱，不会改文件，不存档。
    if (session.kind !== "room_task") {
      await this.git?.autoCheckpoint(project.id, project.rootPath);
    }
    let binding = this.route(sessionId, input);
    // resume 失败时自动重建 thread（F3 承诺：会话必须能继续新回合）。
    const workspace = this.workspaces.forSession(project, sessionId);
    const threadSetup = this.threadSetup;
    const rebuilt = await this.supervisor.ensureReadyOrRebuild({
      session,
      workspace,
      binding,
      ...(threadSetup === null
        ? {}
        : { rebuildSetup: () => threadSetup.rebuildSetup(sessionId) }),
    });
    if (rebuilt) {
      binding = this.rebindPrimary(sessionId, binding, rebuilt);
    }
    const runtimeInput = await mapContent(
      input.content,
      project.rootPath,
      this.skillRoots.roots(),
    );
    if (runtimeInput.some((item) => item.type === "skill")) {
      // 失败不阻塞发送：至少让消息发出去，而不是整条消息卡住。
      await this.syncSkillRoots?.(project.rootPath).catch(() => undefined);
    }
    const clientTurnId = stableClientTurnId(sessionId, idempotencyKey);
    const submitted = this.ledger.append({
      sessionId,
      sessionThreadId: binding.id,
      event: {
        source: "suduo:api",
        type: "message.submitted",
        payload: {
          content: input.content,
          clientTurnId,
        },
        threadRef: binding.threadRef,
        turnRef: null,
        ts: Date.now(),
        dedupeKey: "message:" + sessionId + ":" + idempotencyKey,
      },
    });
    let turn;
    try {
      turn = await this.runtimes.get(binding.threadRef.runtimeId).startTurn({
        sessionId,
        threadRef: binding.threadRef,
        clientTurnId,
        input: runtimeInput,
        projectRoot: project.rootPath,
        workspaceRoots: [project.rootPath],
        // 房间任务会话固定为房间 Agent 档（只读 + 联网 + 不审批）；其余按会话审批档。
        security: sessionSecurityPolicy(session, this.approvalModeEnvironment),
        // 审批档每回合都显式下发；模型 / 推理强度只在需要改变时由 runtime 下发
        // （null = 跟随全局默认，粘性覆盖的回退由 runtime 负责）。
        model: session.model,
        reasoningEffort: session.reasoningEffort,
      });
    } catch (error) {
      throw new IndeterminateOperationError((t) => t.session.turnStartIndeterminate, {
        cause: error,
      });
    }
    this.sessions.touchActivity(sessionId, turn.acceptedAt);
    return {
      sessionId,
      messageEventSeq: submitted.seq,
      threadRef: binding.threadRef,
      turnRef: turn.turnRef,
      acceptedAt: turn.acceptedAt,
      // 归属关联键：前端用它在事件流里找 userMessage item，而不是用上面的 turnRef。
      clientTurnId,
    };
  }

  /** resume 失败重建后：老绑定标记 detached，新 thread 挂为 primary 并入账告知前端。 */
  private rebindPrimary(
    sessionId: string,
    oldBinding: SessionThreadRecord,
    started: StartThreadResult,
  ): SessionThreadRecord {
    this.threads.markDetached(oldBinding.id);
    let primaryRecord: SessionThreadRecord | null = null;
    for (const [offset, runtimeThread] of started.threads.entries()) {
      const isPrimary =
        runtimeThread.threadRef.runtimeId ===
          started.primaryThread.threadRef.runtimeId &&
        runtimeThread.threadRef.threadId ===
          started.primaryThread.threadRef.threadId;
      const record = this.threads.attach({
        sessionId,
        threadRef: runtimeThread.threadRef,
        role: runtimeThread.role,
        ordinal: oldBinding.ordinal + offset + 1,
        primary: isPrimary,
        metadata: runtimeThread.metadata,
      });
      if (isPrimary) {
        primaryRecord = record;
      }
    }
    if (!primaryRecord) {
      throw new IndeterminateOperationError((t) => t.session.rebuiltWithoutPrimary);
    }
    const now = Date.now();
    this.ledger.append({
      sessionId,
      sessionThreadId: primaryRecord.id,
      event: {
        source: "suduo:api",
        type: "thread.attached",
        payload: {
          reason: "resume-failed-rebuilt",
          previousThreadId: oldBinding.threadRef.threadId,
        },
        threadRef: primaryRecord.threadRef,
        turnRef: null,
        ts: now,
        dedupeKey: `rebind:${oldBinding.id}:${primaryRecord.threadRef.threadId}`,
      },
    });
    this.ledger.append({
      sessionId,
      sessionThreadId: primaryRecord.id,
      event: {
        source: "suduo:api",
        type: "runtime.warning",
        payload: {
          code: "thread-rebuilt",
          message:
            "该会话的历史执行上下文无法恢复，已自动重建线程继续。此前对话内容 AI 已不记得，但对话记录与文件改动都完整保留。",
        },
        threadRef: primaryRecord.threadRef,
        turnRef: null,
        ts: now,
        dedupeKey: `rebind-warn:${oldBinding.id}`,
      },
    });
    return primaryRecord;
  }

  private route(sessionId: string, input: SendMessageRequest): SessionThreadRecord {
    if (input.targetThreadRef) {
      const binding = this.threads.getBySessionAndThreadRef(
        sessionId,
        input.targetThreadRef,
      );
      if (!binding || binding.state !== "attached") {
        throw new ApiError(404, "NOT_FOUND", (t) => t.session.targetThreadNotBound);
      }
      return binding;
    }
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
        (t) => t.session.primaryThreadAmbiguousRouting,
      );
    }
    return primaries[0] as SessionThreadRecord;
  }
}

async function mapContent(
  content: readonly MessageContent[],
  projectRoot: string,
  skillRoots: readonly string[],
): Promise<RuntimeInput[]> {
  if (content.length === 0 || content.length > 64) {
    throw new ApiError(400, "VALIDATION_ERROR", (t) => t.session.contentCount);
  }
  let totalText = 0;
  const result: RuntimeInput[] = [];
  for (const item of content) {
    if (item === null || typeof item !== "object") {
      throw new ApiError(400, "VALIDATION_ERROR", (t) => t.session.contentItemInvalid);
    }
    if (item.type === "text") {
      if (typeof item.text !== "string") {
        throw new ApiError(400, "VALIDATION_ERROR", (t) => t.session.textNotString);
      }
      totalText += item.text.length;
      if (item.text.length === 0) {
        throw new ApiError(400, "VALIDATION_ERROR", (t) => t.session.textEmpty);
      }
      result.push(item);
      continue;
    }
    if (item.type === "image-url") {
      if (typeof item.url !== "string") {
        throw new ApiError(400, "VALIDATION_ERROR", (t) => t.session.imageUrlNotString);
      }
      let protocol: string;
      try {
        protocol = new URL(item.url).protocol;
      } catch (error) {
        throw new ApiError(400, "VALIDATION_ERROR", (t) => t.session.imageUrlInvalid, undefined, {
          cause: error,
        });
      }
      if (protocol !== "http:" && protocol !== "https:") {
        throw new ApiError(400, "VALIDATION_ERROR", (t) => t.session.imageUrlProtocol);
      }
      result.push(item);
      continue;
    }
    if (item.type === "local-image") {
      if (typeof item.attachmentId !== "string") {
        throw new ApiError(400, "VALIDATION_ERROR", (t) => t.session.attachmentIdNotString);
      }
      if (!/^[A-Za-z0-9._-]{1,200}$/.test(item.attachmentId)) {
        throw new ApiError(400, "VALIDATION_ERROR", (t) => t.session.attachmentIdInvalid);
      }
      const path = await requireContainedFile(
        resolve(projectRoot, ".suduo", "attachments", item.attachmentId),
        projectRoot,
      );
      result.push({
        type: "local-image",
        path,
        ...(item.detail === undefined ? {} : { detail: item.detail }),
      });
      continue;
    }
    if (
      item.type !== "skill" ||
      typeof item.name !== "string" ||
      typeof item.path !== "string"
    ) {
      throw new ApiError(400, "VALIDATION_ERROR", (t) => t.session.contentTypeUnsupported);
    }
    const path = await requireSkillFile(item.path, projectRoot, skillRoots);
    result.push({ type: "skill", name: item.name, path });
  }
  if (totalText > 200_000) {
    throw new ApiError(400, "VALIDATION_ERROR", (t) => t.session.textTooLong);
  }
  return result;
}

async function requireSkillFile(
  path: string,
  projectRoot: string,
  configuredRoots: readonly string[],
): Promise<string> {
  if (!isAbsolute(path) || path.includes("\0")) {
    throw new ApiError(400, "VALIDATION_ERROR", (t) => t.session.skillPathNotAbsolute);
  }
  try {
    const resolvedPath = await realpath(path);
    if (!(await stat(resolvedPath)).isFile() || !resolvedPath.endsWith("SKILL.md")) {
      throw new Error("not a SKILL.md file");
    }
    const roots = [
      resolve(projectRoot, ".codex", "skills"),
      resolve(projectRoot, ".agents", "skills"),
      ...configuredRoots,
    ];
    for (const root of roots) {
      try {
        const resolvedRoot = await realpath(root);
        const rel = relative(resolvedRoot, resolvedPath);
        if (!rel.startsWith("..") && !isAbsolute(rel)) {
          return resolvedPath;
        }
      } catch {
        // Missing optional skill roots are ignored.
      }
    }
    throw new Error("skill outside configured roots");
  } catch (error) {
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      (t) => t.session.skillNotAllowed,
      undefined,
      { cause: error },
    );
  }
}

async function requireContainedFile(path: string, root: string): Promise<string> {
  if (!isAbsolute(path)) {
    throw new ApiError(400, "VALIDATION_ERROR", (t) => t.session.localPathNotAbsolute);
  }
  try {
    const [resolvedPath, resolvedRoot] = await Promise.all([
      realpath(path),
      realpath(root),
    ]);
    const rel = relative(resolvedRoot, resolvedPath);
    if (rel.startsWith("..") || isAbsolute(rel) || !(await stat(resolvedPath)).isFile()) {
      throw new Error("outside project or not a file");
    }
    return resolvedPath;
  } catch (error) {
    throw new ApiError(
      400,
      "VALIDATION_ERROR",
      (t) => t.session.localFileNotFound,
      undefined,
      { cause: error },
    );
  }
}

function stableClientTurnId(sessionId: string, key: string): string {
  return createHash("sha256")
    .update("suduo-turn\0" + sessionId + "\0" + key)
    .digest("hex");
}
