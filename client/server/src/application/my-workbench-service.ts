import {
  type MyWorkbenchResponse,
  type WorkbenchActionDto,
  type WorkbenchRequirementDto,
  type WorkbenchSection,
  type WorkbenchSessionDto,
} from "@suduo/client-contracts";
import {
  type ListAuditQuery,
  type ProjectStatsQuery,
  type ProjectStatsResponse,
  type RequirementDto,
} from "@suduo/cloud-contracts";
import { reduceSessionRunStatuses, type SessionRunStatusSummary } from "./session-run-status-reducer.js";
import {
  verifyWorkspaceMappingPath,
  type WorkspaceMappingPathVerification,
} from "./workspace-mapping-verifier.js";
import { ApiError } from "./api-error.js";
import type { ApprovalRepository } from "../infrastructure/db/repositories/approval-repository.js";
import type { EventRepository } from "../infrastructure/db/repositories/event-repository.js";
import type { ProjectRecord, ProjectRepository } from "../infrastructure/db/repositories/project-repository.js";
import type {
  RequirementSessionRefRecord,
  RequirementSessionRefRepository,
} from "../infrastructure/db/repositories/requirement-session-ref-repository.js";
import type {
  SessionRecord,
  SessionRepository,
} from "../infrastructure/db/repositories/session-repository.js";
import type {
  WorkspaceMappingRecord,
  WorkspaceMappingRepository,
} from "../infrastructure/db/repositories/workspace-mapping-repository.js";
import type { RequirementsRemoteClient } from "../infrastructure/requirements-v2/remote-client.js";

const WORKBENCH_SESSION_LIMIT = 20;
const WORKBENCH_REQUIREMENT_LIMIT = 50;
const REMOTE_REQUIREMENT_CONCURRENCY = 4;

/**
 * 开工登记（本机 ref）：开工时的版本与标题快照。旧版读需求快照目录里的 requirement.json
 * 比内容；新版会话不再生成快照，需求版本只随标题 / 描述 / 状态的实际变化递增，比版本即可。
 */
interface RequirementSnapshot {
  title: string | null;
  version: number;
}

type SnapshotResult = { status: "available"; snapshot: RequirementSnapshot };

interface RequirementGroup {
  remoteProjectId: string;
  requirementId: string;
  refs: RequirementSessionRefRecord[];
  oldestRef: RequirementSessionRefRecord;
  lastActivityAt: number | null;
}

interface LocalWorkbenchModel {
  topSessions: SessionRecord[];
  sessionsById: Map<string, SessionRecord>;
  refsBySessionId: Map<string, RequirementSessionRefRecord>;
  requirementGroups: RequirementGroup[];
  pendingBySessionId: Map<string, number>;
  runStatuses: Map<string, SessionRunStatusSummary>;
  mappings: WorkspaceMappingRecord[];
  projectFor(localProjectId: string): ProjectRecord | null;
  snapshotFor(ref: RequirementSessionRefRecord): Promise<SnapshotResult>;
}

export interface MyWorkbenchServiceDependencies {
  refs: Pick<RequirementSessionRefRepository, "listAll">;
  approvals: Pick<ApprovalRepository, "countPendingGroupedBySession">;
  sessions: Pick<SessionRepository, "getById" | "listActiveByLastActivity">;
  events: Pick<EventRepository, "listRunStatusEventsForSessions">;
  projects: Pick<ProjectRepository, "getById">;
  mappings: Pick<WorkspaceMappingRepository, "list">;
  remote: Pick<
    RequirementsRemoteClient,
    "getProjectStats" | "listAudit" | "listRequirementsByIds"
  >;
  verifyMapping?(rootPath: string): Promise<WorkspaceMappingPathVerification>;
}

/**
 * 只读地把本机会话投影、会话材料和远程需求对齐。三块 envelope 独立降级，
 * 不写 SQLite、不触碰运行时或事件广播。
 */
export class MyWorkbenchService {
  constructor(private readonly dependencies: MyWorkbenchServiceDependencies) {}

  async getWorkbench(): Promise<MyWorkbenchResponse> {
    let local: LocalWorkbenchModel;
    try {
      local = this.readLocalModel();
    } catch (error) {
      const unavailable = unavailableSection(error, "本机工作台数据不可用");
      return {
        actions: unavailable,
        requirements: unavailable,
        sessions: unavailable,
      };
    }

    const [actions, requirements, sessions] = await Promise.all([
      section(() => this.buildActions(local), "待处理数据暂不可用"),
      section(() => this.buildRequirements(local), "需求服务暂不可用"),
      section(() => this.buildSessions(local), "会话数据暂不可用"),
    ]);
    return { actions, requirements, sessions };
  }

  getProjectStats(projectId: string, query: ProjectStatsQuery): Promise<ProjectStatsResponse> {
    return this.dependencies.remote.getProjectStats(projectId, query);
  }

  listAudit(query: ListAuditQuery) {
    return this.dependencies.remote.listAudit(query);
  }

  private readLocalModel(): LocalWorkbenchModel {
    const sessionsById = new Map<string, SessionRecord>();
    const getSession = (sessionId: string): SessionRecord | null => {
      const cached = sessionsById.get(sessionId);
      if (cached) return cached;
      const session = this.dependencies.sessions.getById(sessionId);
      if (session) sessionsById.set(session.id, session);
      return session;
    };

    const refsBySessionId = new Map<string, RequirementSessionRefRecord>();
    const activeRefs = this.dependencies.refs.listAll().filter((ref) => {
      const session = getSession(ref.sessionId);
      if (!session || session.state === "archived" || session.state === "deleted") {
        return false;
      }
      refsBySessionId.set(ref.sessionId, ref);
      return true;
    });

    const topSessions = this.dependencies.sessions.listActiveByLastActivity(
      WORKBENCH_SESSION_LIMIT,
    );
    for (const session of topSessions) sessionsById.set(session.id, session);

    const pendingBySessionId = this.dependencies.approvals.countPendingGroupedBySession();
    for (const sessionId of pendingBySessionId.keys()) getSession(sessionId);

    const runStatusSessionIds = [...new Set([
      ...topSessions.map((session) => session.id),
      ...pendingBySessionId.keys(),
    ])];
    const runStatuses = reduceSessionRunStatuses(
      runStatusSessionIds,
      this.dependencies.events.listRunStatusEventsForSessions(runStatusSessionIds),
    );

    const grouped = new Map<string, RequirementGroup>();
    for (const ref of activeRefs) {
      const key = requirementKey(ref.remoteProjectId, ref.remoteRequirementId);
      const session = sessionsById.get(ref.sessionId);
      if (!session) continue;
      const existing = grouped.get(key);
      if (!existing) {
        grouped.set(key, {
          remoteProjectId: ref.remoteProjectId,
          requirementId: ref.remoteRequirementId,
          refs: [ref],
          oldestRef: ref,
          lastActivityAt: session.lastActivityAt,
        });
        continue;
      }
      existing.refs.push(ref);
      if (isOlderRef(ref, existing.oldestRef)) existing.oldestRef = ref;
      if ((session.lastActivityAt ?? 0) > (existing.lastActivityAt ?? 0)) {
        existing.lastActivityAt = session.lastActivityAt;
      }
    }
    const requirementGroups = [...grouped.values()]
      .sort((left, right) =>
        (right.lastActivityAt ?? 0) - (left.lastActivityAt ?? 0) ||
        left.requirementId.localeCompare(right.requirementId),
      )
      .slice(0, WORKBENCH_REQUIREMENT_LIMIT);

    const projectsById = new Map<string, ProjectRecord | null>();
    const projectFor = (localProjectId: string): ProjectRecord | null => {
      if (projectsById.has(localProjectId)) return projectsById.get(localProjectId) ?? null;
      const project = this.dependencies.projects.getById(localProjectId);
      projectsById.set(localProjectId, project);
      return project;
    };

    const snapshotFor = (ref: RequirementSessionRefRecord): Promise<SnapshotResult> =>
      Promise.resolve({
        status: "available",
        snapshot: { title: ref.requirementTitle, version: ref.requirementVersion },
      });

    return {
      topSessions,
      sessionsById,
      refsBySessionId,
      requirementGroups,
      pendingBySessionId,
      runStatuses,
      mappings: this.dependencies.mappings.list(),
      projectFor,
      snapshotFor,
    };
  }

  private async buildActions(local: LocalWorkbenchModel): Promise<WorkbenchActionDto[]> {
    const actions: WorkbenchActionDto[] = [];
    for (const [sessionId, pendingApprovals] of local.pendingBySessionId) {
      const session = local.sessionsById.get(sessionId);
      if (!session) continue;
      const project = local.projectFor(session.projectId);
      actions.push({
        kind: "pending_approval",
        sessionId,
        sessionTitle: session.title,
        localProjectId: session.projectId,
        projectName: project?.name ?? null,
        pendingApprovals,
        lastActivityAt: session.lastActivityAt,
      });
    }

    for (const session of local.topSessions) {
      if (local.pendingBySessionId.has(session.id)) continue;
      if (local.runStatuses.get(session.id)?.lastTurnOutcome !== "failed") continue;
      const project = local.projectFor(session.projectId);
      actions.push({
        kind: "failed_turn",
        sessionId: session.id,
        sessionTitle: session.title,
        localProjectId: session.projectId,
        projectName: project?.name ?? null,
        lastActivityAt: session.lastActivityAt,
      });
    }

    const verifyMapping = this.dependencies.verifyMapping ?? verifyWorkspaceMappingPath;
    const mappingActions: Extract<WorkbenchActionDto, { kind: "invalid_mapping" }>[] = [];
    for (const mapping of local.mappings) {
      const project = local.projectFor(mapping.localProjectId);
      if (!project) {
        mappingActions.push({
          kind: "invalid_mapping" as const,
          remoteProjectId: mapping.remoteProjectId,
          localProjectId: mapping.localProjectId,
          projectName: null,
          message: "本机项目记录不存在",
        });
        continue;
      }
      const verification = await verifyMapping(project.rootPath);
      if (verification.available) continue;
      mappingActions.push({
        kind: "invalid_mapping" as const,
        remoteProjectId: mapping.remoteProjectId,
        localProjectId: mapping.localProjectId,
        projectName: project.name,
        message: verification.message,
      });
    }
    actions.push(...mappingActions);

    return actions.sort((left, right) =>
      actionPriority(left) - actionPriority(right) ||
      actionLastActivity(right) - actionLastActivity(left) ||
      actionKey(left).localeCompare(actionKey(right)),
    );
  }

  private async buildRequirements(
    local: LocalWorkbenchModel,
  ): Promise<WorkbenchRequirementDto[]> {
    const currentRequirements = await this.dependencies.remote.listRequirementsByIds(
      local.requirementGroups.map((group) => group.requirementId),
      { concurrency: REMOTE_REQUIREMENT_CONCURRENCY },
    );
    const currentById = new Map(currentRequirements.map((item) => [item.id, item]));

    return await Promise.all(local.requirementGroups.map(async (group) => {
      const current = currentById.get(group.requirementId);
      const snapshot = await local.snapshotFor(group.oldestRef);
      const sessions = group.refs
        .map((ref) => local.sessionsById.get(ref.sessionId))
        .filter((session): session is SessionRecord => session !== undefined);
      const project = sessions.length > 0 ? local.projectFor(sessions[0]!.projectId) : null;
      const runSummaries = sessions.map((session) => local.runStatuses.get(session.id));
      const pendingApprovals = sessions.reduce(
        (total, session) => total + (local.pendingBySessionId.get(session.id) ?? 0),
        0,
      );
      const base = {
        requirementId: group.requirementId,
        remoteProjectId: group.remoteProjectId,
        projectName: project?.name ?? null,
        sessionIds: sessions.map((session) => session.id).sort(),
        sessionCount: sessions.length,
        running: runSummaries.some((summary) => summary?.running === true),
        pendingApprovals,
        lastActivityAt: group.lastActivityAt,
        snapshotStatus: snapshot.status,
      };
      if (!current) {
        return {
          ...base,
          title: null,
          status: null,
          availability: "unavailable" as const,
          unavailableMessage: "需求不可用",
          drift: false,
        };
      }
      return {
        ...base,
        title: current.title,
        status: current.status,
        availability: "available" as const,
        drift: hasContentDrift(snapshot.snapshot, current),
      };
    }));
  }

  private async buildSessions(local: LocalWorkbenchModel): Promise<WorkbenchSessionDto[]> {
    return await Promise.all(local.topSessions.map(async (session) => {
      const ref = local.refsBySessionId.get(session.id);
      const snapshot = ref ? await local.snapshotFor(ref) : null;
      const summary = local.runStatuses.get(session.id) ?? {
        running: false,
        lastTurnOutcome: null,
      };
      const project = local.projectFor(session.projectId);
      return {
        sessionId: session.id,
        title: session.title,
        purpose: session.purpose,
        state: activeSessionState(session),
        running: summary.running,
        pendingApprovals: local.pendingBySessionId.get(session.id) ?? 0,
        lastTurnOutcome: summary.lastTurnOutcome,
        lastActivityAt: session.lastActivityAt,
        project: { id: session.projectId, name: project?.name ?? null },
        requirement: ref === undefined
          ? null
          : {
              remoteProjectId: ref.remoteProjectId,
              requirementId: ref.remoteRequirementId,
              title: snapshot?.snapshot.title ?? null,
              snapshotStatus: snapshot?.status ?? "unreadable",
            },
      };
    }));
  }
}

function section<T>(
  operation: () => Promise<T>,
  fallbackMessage: string,
): Promise<WorkbenchSection<T>> {
  return operation()
    .then((data) => ({ status: "ready", data }) as WorkbenchSection<T>)
    .catch((error: unknown) => unavailableSection(error, fallbackMessage));
}

function unavailableSection(error: unknown, fallbackMessage: string): WorkbenchSection<never> {
  return {
    status: "unavailable",
    error: {
      code: error instanceof ApiError ? error.code : "DEPENDENCY_UNAVAILABLE",
      message: errorMessage(error, fallbackMessage),
    },
  };
}

function errorMessage(error: unknown, fallbackMessage: string): string {
  return error instanceof Error && error.message ? error.message : fallbackMessage;
}

function requirementKey(remoteProjectId: string, requirementId: string): string {
  return remoteProjectId + "\0" + requirementId;
}

function isOlderRef(
  candidate: RequirementSessionRefRecord,
  current: RequirementSessionRefRecord,
): boolean {
  return candidate.createdAt < current.createdAt ||
    (candidate.createdAt === current.createdAt && candidate.sessionId < current.sessionId);
}

/** 开工以后标题、描述或状态改过（需求版本只随这三项的实际变化递增）。 */
function hasContentDrift(snapshot: RequirementSnapshot, current: RequirementDto): boolean {
  return current.version > snapshot.version;
}

function activeSessionState(
  session: SessionRecord,
): WorkbenchSessionDto["state"] {
  if (session.state === "starting" || session.state === "active" || session.state === "error") {
    return session.state;
  }
  throw new Error("工作台展示列表包含非活跃会话");
}

function actionPriority(action: WorkbenchActionDto): number {
  if (action.kind === "pending_approval") return 0;
  if (action.kind === "failed_turn") return 1;
  return 2;
}

function actionLastActivity(action: WorkbenchActionDto): number {
  return "lastActivityAt" in action ? action.lastActivityAt ?? 0 : 0;
}

function actionKey(action: WorkbenchActionDto): string {
  return "sessionId" in action ? action.sessionId : action.remoteProjectId;
}
