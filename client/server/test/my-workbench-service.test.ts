import { describe, expect, it, vi } from "vitest";
import type { ProjectStatsResponse, RequirementDto } from "@suduo/cloud-contracts";
import { MyWorkbenchService } from "../src/application/my-workbench-service.js";
import type { SessionRunStatusEvent } from "../src/application/session-run-status-reducer.js";
import type { ProjectRecord } from "../src/infrastructure/db/repositories/project-repository.js";
import type { RequirementSessionRefRecord } from "../src/infrastructure/db/repositories/requirement-session-ref-repository.js";
import type { SessionRecord } from "../src/infrastructure/db/repositories/session-repository.js";
import type { WorkspaceMappingRecord } from "../src/infrastructure/db/repositories/workspace-mapping-repository.js";
import type { WorkspaceMappingPathVerification } from "../src/application/workspace-mapping-verifier.js";

describe("MyWorkbenchService", () => {
  it("按最旧会话的开工版本判定正文漂移，并按待审批、失败、映射失效排序", async () => {
    const project = projectRecord("local-project", "结算中心", "/workspace/settlement");
    const pending = sessionRecord("pending", project.id, 100);
    const failed = sessionRecord("failed", project.id, 90);
    const oldest = sessionRecord("oldest", project.id, 80);
    const newer = sessionRecord("newer", project.id, 70);
    const drifted = sessionRecord("drifted", project.id, 60);
    const archived = sessionRecord("archived", project.id, 200, "archived");
    const refs = [
      refRecord(pending.id, "remote-project", "pending-requirement", 5),
      refRecord(failed.id, "remote-project", "failed-requirement", 5),
      // 同一需求两次开工：以最旧那次的开工版本（5）比当前版本（5），没有漂移；较新那次是 1 也不影响。
      refRecord(oldest.id, "remote-project", "same-requirement", 1, 5),
      refRecord(newer.id, "remote-project", "same-requirement", 20, 1),
      refRecord(drifted.id, "remote-project", "drifted-requirement", 5, 2),
      refRecord(archived.id, "remote-project", "archived-requirement", 1),
    ];
    const remoteIds = vi.fn(async (ids: readonly string[]) =>
      ids.map((id) => requirement(id, id === "same-requirement" ? "same" : id, 5)),
    );
    const service = serviceFixture({
      projects: [project],
      sessions: [pending, failed, oldest, newer, drifted, archived],
      refs,
      pending: new Map([[pending.id, 2]]),
      events: [{
        sessionId: failed.id,
        seq: 1,
        type: "turn.completed",
        turnRef: null,
        turnStatus: "failed",
      }],
      mappings: [mappingRecord("remote-project", project.id)],
      listRequirementsByIds: remoteIds,
      verifyMapping: async () => unavailableMapping("目录不存在"),
    });

    const result = await service.getWorkbench();

    expect(result.actions).toMatchObject({ status: "ready" });
    expect(result.actions.status === "ready" && result.actions.data.map((item) => item.kind))
      .toEqual(["pending_approval", "failed_turn", "invalid_mapping"]);

    expect(result.requirements).toMatchObject({ status: "ready" });
    if (result.requirements.status !== "ready") throw new Error("requirements unexpectedly unavailable");
    expect(remoteIds).toHaveBeenCalledWith(
      expect.not.arrayContaining(["archived-requirement"]),
      { concurrency: 4 },
    );
    const same = result.requirements.data.find((item) => item.requirementId === "same-requirement");
    expect(same).toMatchObject({
      title: "same",
      drift: false,
      snapshotStatus: "available",
      sessionCount: 2,
    });
    const changed = result.requirements.data.find((item) => item.requirementId === "drifted-requirement");
    expect(changed).toMatchObject({ drift: true, snapshotStatus: "available" });

    expect(result.sessions).toMatchObject({ status: "ready" });
    if (result.sessions.status !== "ready") throw new Error("sessions unexpectedly unavailable");
    expect(result.sessions.data.map((item) => item.sessionId)).not.toContain(archived.id);
  });

  it("远程失败只让“我在做”降级，本机两块仍可返回", async () => {
    const project = projectRecord("local-project", "本机项目", "/workspace/local");
    const active = sessionRecord("active", project.id, 100);
    const service = serviceFixture({
      projects: [project],
      sessions: [active],
      refs: [refRecord(active.id, "remote-project", "remote-requirement", 1)],
      listRequirementsByIds: async () => {
        throw new Error("远程不可达");
      },
    });

    const result = await service.getWorkbench();

    expect(result.requirements).toMatchObject({
      status: "unavailable",
      error: { message: "远程不可达" },
    });
    expect(result.actions).toMatchObject({ status: "ready", data: [] });
    expect(result.sessions).toMatchObject({ status: "ready", data: [expect.anything()] });
  });

  it("待审批会话即使不在 top20 也参与运行态归约，但不扩展展示列表", async () => {
    const project = projectRecord("local-project", "本机项目", "/workspace/local");
    const topSessions = Array.from(
      { length: 20 },
      (_, index) => sessionRecord(`top-${String(index)}`, project.id, 1_000 - index),
    );
    const outside = sessionRecord("pending-outside-top20", project.id, 1);
    const listRunStatusEventsForSessions = vi.fn((ids: readonly string[]) => {
      const events: SessionRunStatusEvent[] = ids.includes(outside.id)
        ? [{
            sessionId: outside.id,
            seq: 1,
            type: "turn.started",
            turnRef: { threadId: "thread", turnId: "turn" },
            turnStatus: null,
          }]
        : [];
      return events;
    });
    const service = serviceFixture({
      projects: [project],
      sessions: [...topSessions, outside],
      pending: new Map([[outside.id, 1]]),
      listRunStatusEventsForSessions,
    });

    const result = await service.getWorkbench();

    expect(listRunStatusEventsForSessions).toHaveBeenCalledWith(
      expect.arrayContaining([outside.id]),
    );
    expect(result.sessions).toMatchObject({ status: "ready" });
    if (result.sessions.status !== "ready") throw new Error("sessions unexpectedly unavailable");
    expect(result.sessions.data).toHaveLength(20);
    expect(result.sessions.data.map((item) => item.sessionId)).not.toContain(outside.id);
    expect(result.actions).toMatchObject({
      status: "ready",
      data: [expect.objectContaining({ kind: "pending_approval", sessionId: outside.id })],
    });
  });
});

function serviceFixture(input: {
  projects?: ProjectRecord[];
  sessions?: SessionRecord[];
  refs?: RequirementSessionRefRecord[];
  pending?: Map<string, number>;
  events?: SessionRunStatusEvent[];
  mappings?: WorkspaceMappingRecord[];
  listRequirementsByIds?: (ids: readonly string[]) => Promise<RequirementDto[]>;
  verifyMapping?: (path: string) => Promise<WorkspaceMappingPathVerification>;
  listRunStatusEventsForSessions?: (ids: readonly string[]) => SessionRunStatusEvent[];
}): MyWorkbenchService {
  const projects = new Map((input.projects ?? []).map((item) => [item.id, item]));
  const sessions = new Map((input.sessions ?? []).map((item) => [item.id, item]));
  const allSessions = [...sessions.values()];
  return new MyWorkbenchService({
    refs: { listAll: () => input.refs ?? [] },
    approvals: { countPendingGroupedBySession: () => input.pending ?? new Map() },
    sessions: {
      getById: (id) => sessions.get(id) ?? null,
      listActiveByLastActivity: (limit) => allSessions
        .filter((session) => session.state === "starting" || session.state === "active" || session.state === "error")
        .sort((left, right) => (right.lastActivityAt ?? 0) - (left.lastActivityAt ?? 0))
        .slice(0, limit),
    },
    events: {
      listRunStatusEventsForSessions: input.listRunStatusEventsForSessions ?? (() => input.events ?? []),
    },
    projects: { getById: (id) => projects.get(id) ?? null },
    mappings: { list: () => input.mappings ?? [] },
    remote: {
      getProjectStats: async (): Promise<ProjectStatsResponse> => emptyStats(),
      listAudit: async () => ({ items: [], nextCursor: null }),
      listRequirementsByIds: input.listRequirementsByIds ?? (async () => []),
    },
    verifyMapping: input.verifyMapping ?? (async () => availableMapping()),
  });
}

function projectRecord(id: string, name: string, rootPath: string): ProjectRecord {
  return {
    id,
    name,
    rootPath,
    rootPathKey: rootPath,
    state: "active",
    createdAt: 1,
    updatedAt: 1,
    lastOpenedAt: null,
    removedAt: null,
    version: 1,
  };
}

function sessionRecord(
  id: string,
  projectId: string,
  lastActivityAt: number,
  state: SessionRecord["state"] = "active",
): SessionRecord {
  return {
    id,
    projectId,
    title: id,
    state,
    purpose: "general",
    approvalMode: "ask",
    kind: "normal",
    model: null,
    reasoningEffort: null,
    createdAt: lastActivityAt,
    updatedAt: lastActivityAt,
    lastOpenedAt: null,
    lastActivityAt,
    archivedAt: state === "archived" ? lastActivityAt : null,
    deletedAt: state === "deleted" ? lastActivityAt : null,
    error: null,
    version: 1,
  };
}

function refRecord(
  sessionId: string,
  remoteProjectId: string,
  remoteRequirementId: string,
  createdAt: number,
  requirementVersion = 5,
): RequirementSessionRefRecord {
  return {
    sessionId,
    remoteProjectId,
    remoteRequirementId,
    requirementVersion,
    materialPath: null,
    manifestSha256: null,
    auditAnchor: { state: "unknown", createdAt: null, id: null },
    requirementNumber: null,
    requirementTitle: remoteRequirementId,
    contextMode: "tools",
    createdAt,
  };
}

function mappingRecord(remoteProjectId: string, localProjectId: string): WorkspaceMappingRecord {
  return {
    remoteProjectId,
    localProjectId,
    createdAt: 1,
    updatedAt: 1,
    lastValidatedAt: 1,
  };
}

function requirement(id: string, title: string, version: number): RequirementDto {
  return {
    id,
    projectId: "remote-project",
    number: 1,
    title,
    summary: `${title} summary`,
    status: "draft",
    assignee: null,
    commentCount: 0,
    attachmentCount: 0,
    createdBy: { id: "user", displayName: "User" },
    updatedBy: { id: "user", displayName: "User" },
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    version,
  };
}

function availableMapping() {
  return {
    exists: true,
    readable: true,
    writable: true,
    executable: true,
    available: true,
    message: "可用",
  };
}

function unavailableMapping(message: string) {
  return {
    exists: false,
    readable: false,
    writable: false,
    executable: false,
    available: false,
    message,
  };
}

function emptyStats(): ProjectStatsResponse {
  return {
    statusCounts: {
      draft: 0,
      in_refinement: 0,
      ready_for_development: 0,
      in_development: 0,
      in_testing: 0,
      completed: 0,
      on_hold: 0,
    },
    staleRequirements: [],
    transitions: [],
  };
}
